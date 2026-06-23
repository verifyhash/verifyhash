"use strict";

// cli/receipt.js — a versioned, strictly-validated JSON receipt for the verifyhash CLI.
//
// WHY THIS EXISTS
//   Two flows need a durable, portable on-disk artifact:
//
//   1. CLAIM RECEIPTS (kind "verifyhash.claim-receipt").
//      The commit-reveal attribution flow (`vh claim`) is two transactions separated by a maturation
//      window of MIN_REVEAL_DELAY blocks. On a live testnet that window is minutes. If a single-process
//      `runClaim` (commit + reveal in one go) crashes/Ctrl-C's between the two legs, the secret salt —
//      held only in memory — is lost forever. The contentHash is then committed-but-unrevealable by
//      ANYONE (reveal needs that exact salt), so the attribution is permanently burned. The claim
//      receipt makes the claim DURABLE and RESUMABLE: at commit time the orchestrator persists the
//      salt/commitment (and everything `reveal()` needs) to a JSON receipt on disk; a later, separate
//      `vh reveal --receipt <path>` process loads it and finishes the claim.
//
//   2. ANCHOR RECEIPTS (kind "verifyhash.anchor-receipt").
//      A one-shot `vh anchor` records only a contentHash on-chain. For a DIRECTORY that hash is a
//      Merkle root over per-file path-bound leaves, so `vh verify <dir>` can only ever say "the whole
//      tree's root matches / does not match" — it cannot say WHICH file diverged. `vh hash <dir>`
//      already computes every per-file `{ path, contentHash, leaf }` and then throws them away. An
//      anchor receipt records that sorted MANIFEST so a later `vh verify <dir> --receipt <p>` can
//      localize the change to specific files (ADDED / REMOVED / CHANGED).
//
//   Both kinds, at schemaVersion >= 2, may additionally carry a `manifest` for a directory target.
//   The claim/commit receipts for a directory record it too (so a resumed reveal — and any later
//   verify — has the per-file breakdown).
//
// TRUST POSTURE
//   The receipt is an UNTRUSTED local convenience, consistent with docs/TRUST-BOUNDARIES.md: the
//   authoritative result still comes from the on-chain record (and, for verify, from re-deriving the
//   root and comparing it to that record). A receipt's `manifest` only LOCALIZES which file diverged;
//   it can never, by itself, make content "verified". But a receipt that is *corrupt* must never be
//   silently half-accepted — a partial claim receipt could make a user re-derive a wrong commitment
//   or reveal with the wrong salt and waste a transaction (or worse, leak the salt while producing
//   nothing). So `readReceipt` validates strictly and throws on ANY deviation rather than filling
//   defaults.

const fs = require("fs");

// Current on-disk schema version written by this build. Bumped 1 -> 2 to add the optional `manifest`
// field (additive). `readReceipt` still ACCEPTS version 1 receipts (which simply have no manifest), so
// older artifacts keep working; it only WRITES version SCHEMA_VERSION. Any version outside the
// supported set is rejected so a future/foreign file is never misread as a current one.
const SCHEMA_VERSION = 2;
const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2]);

// Receipts carry one of these discriminators so a random JSON file (or a different vh artifact) is
// never mistaken for a verifyhash receipt. A CLAIM receipt is the resumable commit-reveal artifact
// (carries salt/commitment); an ANCHOR receipt is the one-shot anchor artifact (no secret material).
const RECEIPT_KIND = "verifyhash.claim-receipt"; // back-compat alias: the claim-receipt kind
const CLAIM_RECEIPT_KIND = "verifyhash.claim-receipt";
const ANCHOR_RECEIPT_KIND = "verifyhash.anchor-receipt";
const RECEIPT_KINDS = Object.freeze([CLAIM_RECEIPT_KIND, ANCHOR_RECEIPT_KIND]);

// Fields that must be present and be 0x-prefixed 32-byte (64 hex char) values, by kind.
// Claim receipts bind a salt + commitment; anchor receipts only ever attest a contentHash.
const HEX32_FIELDS_CLAIM = ["contentHash", "salt", "commitment"];
const HEX32_FIELDS_ANCHOR = ["contentHash"];
// Address fields that must be present, by kind. Anchor receipts have no committer (no signer needed
// to anchor a hash they already know — and verify needs no signer at all).
const ADDR_FIELDS_CLAIM = ["committer", "contractAddress"];
const ADDR_FIELDS_ANCHOR = ["contractAddress"];

const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Build a normalized, fully-populated CLAIM-receipt object from raw parts. Throws if any required
 * field is missing or malformed, so we never *write* a partial receipt either.
 *
 * @param {object} parts
 * @param {string}  parts.contentHash     0x 32-byte digest being claimed
 * @param {string}  parts.committer       0x 20-byte address that committed and will reveal
 * @param {string}  parts.salt            0x 32-byte secret salt
 * @param {string}  parts.commitment      0x 32-byte commitment hash
 * @param {string}  parts.contractAddress 0x 20-byte ContributionRegistry address
 * @param {number|string|bigint} parts.chainId chain the commit was sent to
 * @param {string} [parts.uri]            optional untrusted off-chain pointer hint
 * @param {string} [parts.kind]           "file" | "dir" (informational target kind)
 * @param {string} [parts.path]           the source path claimed (informational)
 * @param {string} [parts.commitTxHash]   the commit() transaction hash (0x 32-byte)
 * @param {number|string|bigint} [parts.commitBlockNumber] block.number the commit mined in
 * @param {number|string|bigint} [parts.minRevealDelay]    MIN_REVEAL_DELAY read from the contract
 * @param {Array<{path:string,contentHash:string,leaf:string}>} [parts.manifest]
 *        sorted per-file manifest for a directory target (exactly what `vh hash <dir>` produces)
 * @returns {object} a validated receipt object
 */
function buildReceipt(parts) {
  if (!parts || typeof parts !== "object") {
    throw new Error("buildReceipt requires an object of parts");
  }
  const receipt = {
    kind: CLAIM_RECEIPT_KIND,
    schemaVersion: SCHEMA_VERSION,
    contentHash: parts.contentHash,
    committer: parts.committer,
    salt: parts.salt,
    commitment: parts.commitment,
    contractAddress: parts.contractAddress,
    chainId: _normChainId(parts.chainId),
    uri: parts.uri == null ? "" : String(parts.uri),
  };
  _attachOptional(receipt, parts);
  _validate(receipt);
  return receipt;
}

/**
 * Build a normalized ANCHOR-receipt object: the durable companion to a one-shot `vh anchor`. It has
 * no salt/commitment/committer (anchoring needs none); its reason to exist is the optional directory
 * `manifest` that lets a later `vh verify --receipt` localize which file diverged.
 *
 * @param {object} parts
 * @param {string}  parts.contentHash     0x 32-byte digest anchored (file digest or dir Merkle root)
 * @param {string}  parts.contractAddress 0x 20-byte ContributionRegistry address
 * @param {number|string|bigint} parts.chainId chain the anchor was/would be sent to
 * @param {string} [parts.uri]            optional untrusted off-chain pointer hint
 * @param {string} [parts.kind]           "file" | "dir" (informational target kind)
 * @param {string} [parts.path]           the source path anchored (informational)
 * @param {string} [parts.anchorTxHash]   the anchor() transaction hash (0x 32-byte), when sent
 * @param {number|string|bigint} [parts.anchorBlockNumber] block.number the anchor mined in
 * @param {Array<{path:string,contentHash:string,leaf:string}>} [parts.manifest]
 *        sorted per-file manifest for a directory target (exactly what `vh hash <dir>` produces)
 * @returns {object} a validated anchor-receipt object
 */
function buildAnchorReceipt(parts) {
  if (!parts || typeof parts !== "object") {
    throw new Error("buildAnchorReceipt requires an object of parts");
  }
  const receipt = {
    kind: ANCHOR_RECEIPT_KIND,
    schemaVersion: SCHEMA_VERSION,
    contentHash: parts.contentHash,
    contractAddress: parts.contractAddress,
    chainId: _normChainId(parts.chainId),
    uri: parts.uri == null ? "" : String(parts.uri),
  };
  if (parts.path != null) receipt.path = String(parts.path);
  if (parts.kind != null) receipt.targetKind = String(parts.kind);
  if (parts.anchorTxHash != null) receipt.anchorTxHash = parts.anchorTxHash;
  if (parts.anchorBlockNumber != null) {
    receipt.anchorBlockNumber = _normIntField("anchorBlockNumber", parts.anchorBlockNumber);
  }
  if (parts.manifest != null) receipt.manifest = _normManifest(parts.manifest);
  _validate(receipt);
  return receipt;
}

/** Attach the optional/operational claim-receipt fields (validated for shape) when provided. */
function _attachOptional(receipt, parts) {
  if (parts.path != null) receipt.path = String(parts.path);
  if (parts.kind != null) receipt.targetKind = String(parts.kind);
  if (parts.commitTxHash != null) receipt.commitTxHash = parts.commitTxHash;
  if (parts.commitBlockNumber != null) {
    receipt.commitBlockNumber = _normIntField("commitBlockNumber", parts.commitBlockNumber);
  }
  if (parts.minRevealDelay != null) {
    receipt.minRevealDelay = _normIntField("minRevealDelay", parts.minRevealDelay);
  }
  if (parts.manifest != null) receipt.manifest = _normManifest(parts.manifest);
}

/** Normalize a chainId (number|string|bigint) to a non-negative integer Number. */
function _normChainId(v) {
  if (v == null) return v; // let _validate produce the missing-field error
  let n;
  try {
    n = Number(BigInt(v));
  } catch (_) {
    throw new Error(`receipt chainId must be an integer, got: ${String(v)}`);
  }
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`receipt chainId must be a non-negative integer, got: ${String(v)}`);
  }
  return n;
}

/** Normalize an optional integer field (block numbers, delays) to a Number. */
function _normIntField(name, v) {
  let n;
  try {
    n = Number(BigInt(v));
  } catch (_) {
    throw new Error(`receipt ${name} must be an integer, got: ${String(v)}`);
  }
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`receipt ${name} must be a non-negative integer, got: ${String(v)}`);
  }
  return n;
}

/**
 * Normalize a per-file manifest into the canonical on-disk shape: an array of
 * { path, contentHash, leaf } entries, sorted ascending by `leaf` (the same total order `hashDir`
 * uses to build the tree, so a written manifest is deterministic regardless of input order).
 * Throws on any malformed entry — a manifest either is well-formed or is rejected.
 * @param {any} manifest
 * @returns {Array<{path:string,contentHash:string,leaf:string}>}
 */
function _normManifest(manifest) {
  if (!Array.isArray(manifest)) {
    throw new Error("receipt manifest must be an array");
  }
  const out = manifest.map((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`receipt manifest entry ${i} must be an object`);
    }
    if (typeof entry.path !== "string" || entry.path.length === 0) {
      throw new Error(`receipt manifest entry ${i} must have a non-empty string path`);
    }
    if (typeof entry.contentHash !== "string" || !HEX32_RE.test(entry.contentHash)) {
      throw new Error(
        `receipt manifest entry ${i} (${entry.path}) contentHash must be a 0x 32-byte hex string`
      );
    }
    if (typeof entry.leaf !== "string" || !HEX32_RE.test(entry.leaf)) {
      throw new Error(
        `receipt manifest entry ${i} (${entry.path}) leaf must be a 0x 32-byte hex string`
      );
    }
    return { path: entry.path, contentHash: entry.contentHash, leaf: entry.leaf };
  });
  // Deterministic order: sort by leaf value (matches hashDir's leaf-sorted tree).
  out.sort((a, b) => {
    const x = BigInt(a.leaf);
    const y = BigInt(b.leaf);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return out;
}

/**
 * Strictly validate a parsed receipt object. Throws an Error describing the FIRST problem found.
 * Never mutates the object and never fills defaults — a receipt either is complete and well-formed
 * or it is rejected outright. Accepts both schemaVersion 1 (no manifest) and 2 (optional manifest),
 * and both claim- and anchor-kind receipts.
 * @param {any} obj
 * @returns {object} the same object, if valid
 */
function _validate(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("receipt must be a JSON object");
  }
  if (!RECEIPT_KINDS.includes(obj.kind)) {
    throw new Error(
      `not a verifyhash receipt (kind: ${JSON.stringify(obj.kind)}; expected one of ${JSON.stringify(
        RECEIPT_KINDS
      )})`
    );
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new Error(
      `unsupported receipt schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(SUPPORTED_SCHEMA_VERSIONS)})`
    );
  }

  const isAnchor = obj.kind === ANCHOR_RECEIPT_KIND;
  const hex32Fields = isAnchor ? HEX32_FIELDS_ANCHOR : HEX32_FIELDS_CLAIM;
  const addrFields = isAnchor ? ADDR_FIELDS_ANCHOR : ADDR_FIELDS_CLAIM;

  for (const f of hex32Fields) {
    const v = obj[f];
    if (v === undefined || v === null) throw new Error(`receipt missing required field: ${f}`);
    if (typeof v !== "string" || !HEX32_RE.test(v)) {
      throw new Error(`receipt field ${f} must be a 0x-prefixed 32-byte hex string, got: ${String(v)}`);
    }
  }
  for (const f of addrFields) {
    const v = obj[f];
    if (v === undefined || v === null) throw new Error(`receipt missing required field: ${f}`);
    if (typeof v !== "string" || !ADDR_RE.test(v)) {
      throw new Error(`receipt field ${f} must be a 0x-prefixed 20-byte address, got: ${String(v)}`);
    }
  }

  if (obj.chainId === undefined || obj.chainId === null) {
    throw new Error("receipt missing required field: chainId");
  }
  if (!Number.isSafeInteger(obj.chainId) || obj.chainId < 0) {
    throw new Error(`receipt field chainId must be a non-negative integer, got: ${String(obj.chainId)}`);
  }

  if (obj.uri !== undefined && obj.uri !== null && typeof obj.uri !== "string") {
    throw new Error(`receipt field uri must be a string when present, got: ${typeof obj.uri}`);
  }

  // Optional operational fields (claim + anchor): validate shape only when present.
  for (const f of ["commitTxHash", "anchorTxHash"]) {
    if (obj[f] !== undefined && obj[f] !== null) {
      if (typeof obj[f] !== "string" || !HEX32_RE.test(obj[f])) {
        throw new Error(
          `receipt field ${f} must be a 0x-prefixed 32-byte hex string when present, got: ${String(obj[f])}`
        );
      }
    }
  }
  for (const f of ["commitBlockNumber", "minRevealDelay", "anchorBlockNumber"]) {
    if (obj[f] !== undefined && obj[f] !== null) {
      if (!Number.isSafeInteger(obj[f]) || obj[f] < 0) {
        throw new Error(`receipt field ${f} must be a non-negative integer when present, got: ${String(obj[f])}`);
      }
    }
  }

  // Optional manifest: only meaningful at schemaVersion >= 2. A v1 receipt that somehow carries a
  // manifest is rejected (the version contract is that v1 has none), so the version is never a lie.
  if (obj.manifest !== undefined && obj.manifest !== null) {
    if (obj.schemaVersion < 2) {
      throw new Error("receipt manifest requires schemaVersion >= 2");
    }
    _validateManifestShape(obj.manifest);
  }

  return obj;
}

/** Validate a parsed manifest's shape (without re-sorting). Throws on the first malformed entry. */
function _validateManifestShape(manifest) {
  if (!Array.isArray(manifest)) {
    throw new Error("receipt manifest must be an array");
  }
  manifest.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`receipt manifest entry ${i} must be an object`);
    }
    if (typeof entry.path !== "string" || entry.path.length === 0) {
      throw new Error(`receipt manifest entry ${i} must have a non-empty string path`);
    }
    if (typeof entry.contentHash !== "string" || !HEX32_RE.test(entry.contentHash)) {
      throw new Error(`receipt manifest entry ${i} (${entry.path}) contentHash must be a 0x 32-byte hex string`);
    }
    if (typeof entry.leaf !== "string" || !HEX32_RE.test(entry.leaf)) {
      throw new Error(`receipt manifest entry ${i} (${entry.path}) leaf must be a 0x 32-byte hex string`);
    }
  });
}

/**
 * Validate and write a receipt object to `path` as pretty JSON. Pure-ish: the only side effect is
 * the file write. Throws (before writing) if the object is not a valid receipt, so a corrupt object
 * never lands on disk.
 * @param {object} obj   a receipt (typically from buildReceipt / buildAnchorReceipt)
 * @param {string} path  destination file path
 * @returns {object} the validated object that was written
 */
function writeReceipt(obj, path) {
  if (!path || typeof path !== "string") {
    throw new Error("writeReceipt requires a destination path");
  }
  const valid = _validate(obj);
  // Trailing newline so the file is POSIX-clean and diff-friendly.
  fs.writeFileSync(path, JSON.stringify(valid, null, 2) + "\n");
  return valid;
}

/**
 * Read, JSON-parse, and strictly validate a receipt from `path`. Throws a clear error if the file is
 * missing, not JSON, or fails validation — it NEVER returns a partial/corrupt receipt. Accepts both
 * claim and anchor receipts at schemaVersion 1 or 2.
 * @param {string} path
 * @returns {object} the validated receipt
 */
function readReceipt(path) {
  if (!path || typeof path !== "string") {
    throw new Error("readReceipt requires a path");
  }
  let raw;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read receipt at ${path}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`receipt at ${path} is not valid JSON: ${e.message}`);
  }
  try {
    return _validate(parsed);
  } catch (e) {
    throw new Error(`receipt at ${path} is invalid: ${e.message}`);
  }
}

/**
 * Compute a precise file-level diff between a receipt's recorded manifest and a freshly-recomputed
 * set of per-file leaves for the SAME directory. This LOCALIZES which file diverged — it does NOT,
 * on its own, decide MATCH/MISMATCH (the authoritative verdict is re-deriving the root and comparing
 * it to the on-chain record; see runVerify). The receipt manifest is an UNTRUSTED hint.
 *
 * @param {Array<{path:string,contentHash:string,leaf:string}>} recordedManifest the receipt's manifest
 * @param {Array<{path:string,contentHash:string,leaf:string}>} currentLeaves    `hashDir().leaves` now
 * @returns {{
 *   added:   Array<{path:string,contentHash:string}>,                       // present now, not in receipt
 *   removed: Array<{path:string,contentHash:string}>,                       // in receipt, gone now
 *   changed: Array<{path:string,oldContentHash:string,newContentHash:string}>, // same path, different content
 *   unchanged: Array<{path:string,contentHash:string}>,
 *   identical: boolean                                                      // no add/remove/change at all
 * }}
 */
function diffManifest(recordedManifest, currentLeaves) {
  const recorded = new Map();
  for (const e of recordedManifest || []) recorded.set(e.path, e);
  const current = new Map();
  for (const e of currentLeaves || []) current.set(e.path, e);

  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  for (const [p, cur] of current) {
    const rec = recorded.get(p);
    if (!rec) {
      added.push({ path: p, contentHash: cur.contentHash });
    } else if (rec.leaf.toLowerCase() !== cur.leaf.toLowerCase()) {
      // Path bound into the leaf is identical (same key), so a leaf difference is a content change.
      changed.push({ path: p, oldContentHash: rec.contentHash, newContentHash: cur.contentHash });
    } else {
      unchanged.push({ path: p, contentHash: cur.contentHash });
    }
  }
  for (const [p, rec] of recorded) {
    if (!current.has(p)) removed.push({ path: p, contentHash: rec.contentHash });
  }

  const sortByPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  added.sort(sortByPath);
  removed.sort(sortByPath);
  changed.sort(sortByPath);
  unchanged.sort(sortByPath);

  return {
    added,
    removed,
    changed,
    unchanged,
    identical: added.length === 0 && removed.length === 0 && changed.length === 0,
  };
}

/**
 * Default receipt path for a contentHash: `./<first 16 hex chars>.vhclaim.json` in the cwd. Short
 * enough to be tidy, long enough to be collision-resistant for a human's working set.
 * @param {string} contentHash 0x 32-byte digest
 * @returns {string}
 */
function defaultReceiptPath(contentHash) {
  if (typeof contentHash !== "string" || !HEX32_RE.test(contentHash)) {
    throw new Error(`defaultReceiptPath needs a 0x 32-byte contentHash, got: ${String(contentHash)}`);
  }
  const prefix = contentHash.slice(2, 2 + 16); // 16 hex chars = 8 bytes
  return `./${prefix}.vhclaim.json`;
}

module.exports = {
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  RECEIPT_KIND,
  CLAIM_RECEIPT_KIND,
  ANCHOR_RECEIPT_KIND,
  buildReceipt,
  buildAnchorReceipt,
  writeReceipt,
  readReceipt,
  diffManifest,
  defaultReceiptPath,
  // Exported for unit tests that exercise validation/manifest normalization directly.
  _validate,
  _normManifest,
};

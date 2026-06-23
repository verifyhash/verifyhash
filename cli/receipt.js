"use strict";

// cli/receipt.js — a versioned, strictly-validated JSON claim receipt.
//
// WHY THIS EXISTS
//   The commit-reveal attribution flow (`vh claim`) is two transactions separated by a maturation
//   window of MIN_REVEAL_DELAY blocks. On a live testnet that window is minutes. If a single-process
//   `runClaim` (commit + reveal in one go) crashes/Ctrl-C's between the two legs, the secret salt —
//   held only in memory — is lost forever. The contentHash is then committed-but-unrevealable by
//   ANYONE (reveal needs that exact salt), so the attribution is permanently burned.
//
//   This module makes the claim DURABLE and RESUMABLE: at commit time the orchestrator persists the
//   salt/commitment (and everything `reveal()` needs) to a JSON receipt on disk. A later, separate
//   `vh reveal --receipt <path>` process loads it and finishes the claim.
//
// TRUST POSTURE
//   The receipt is an UNTRUSTED local convenience, consistent with docs/TRUST-BOUNDARIES.md: the
//   authoritative attribution still comes from the on-chain record. But a receipt that is *corrupt*
//   must never be silently half-accepted — a partial receipt could make a user re-derive a wrong
//   commitment or reveal with the wrong salt and waste a transaction (or worse, leak the salt while
//   producing nothing). So `readReceipt` validates strictly and throws on ANY deviation rather than
//   filling defaults.

const fs = require("fs");

// Bump this when the on-disk shape changes incompatibly. `readReceipt` rejects any other version so
// an old/foreign file never gets misread as a current one.
const SCHEMA_VERSION = 1;

// Receipts written by this module carry this discriminator so a random JSON file (or a different
// vh artifact) is never mistaken for a claim receipt.
const RECEIPT_KIND = "verifyhash.claim-receipt";

// Fields that must be present and be 0x-prefixed 32-byte (64 hex char) values.
const HEX32_FIELDS = ["contentHash", "salt", "commitment"];
// Fields that must be present and be a 0x-prefixed 20-byte (40 hex char) address.
const ADDR_FIELDS = ["committer", "contractAddress"];

const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Build a normalized, fully-populated claim-receipt object from raw parts. Throws if any required
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
 * @param {string} [parts.kind]           "file" | "dir" (informational)
 * @param {string} [parts.path]           the source path claimed (informational)
 * @param {string} [parts.commitTxHash]   the commit() transaction hash (0x 32-byte)
 * @param {number|string|bigint} [parts.commitBlockNumber] block.number the commit mined in
 * @param {number|string|bigint} [parts.minRevealDelay]    MIN_REVEAL_DELAY read from the contract
 * @returns {object} a frozen, validated receipt object
 */
function buildReceipt(parts) {
  if (!parts || typeof parts !== "object") {
    throw new Error("buildReceipt requires an object of parts");
  }
  const receipt = {
    kind: RECEIPT_KIND,
    schemaVersion: SCHEMA_VERSION,
    contentHash: parts.contentHash,
    committer: parts.committer,
    salt: parts.salt,
    commitment: parts.commitment,
    contractAddress: parts.contractAddress,
    chainId: _normChainId(parts.chainId),
    uri: parts.uri == null ? "" : String(parts.uri),
  };
  // Optional, informational/operational fields — only included when provided, but still validated
  // for shape when present so a corrupt value can't slip through.
  if (parts.path != null) receipt.path = String(parts.path);
  if (parts.kind != null) receipt.targetKind = String(parts.kind);
  if (parts.commitTxHash != null) receipt.commitTxHash = parts.commitTxHash;
  if (parts.commitBlockNumber != null) {
    receipt.commitBlockNumber = _normIntField("commitBlockNumber", parts.commitBlockNumber);
  }
  if (parts.minRevealDelay != null) {
    receipt.minRevealDelay = _normIntField("minRevealDelay", parts.minRevealDelay);
  }

  // Validate the canonical (required) shape before returning.
  _validate(receipt);
  return receipt;
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
 * Strictly validate a parsed receipt object. Throws an Error describing the FIRST problem found.
 * Never mutates the object and never fills defaults — a receipt either is complete and well-formed
 * or it is rejected outright.
 * @param {any} obj
 * @returns {object} the same object, if valid
 */
function _validate(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("receipt must be a JSON object");
  }
  if (obj.kind !== RECEIPT_KIND) {
    throw new Error(
      `not a verifyhash claim receipt (kind: ${JSON.stringify(obj.kind)}; expected ${JSON.stringify(
        RECEIPT_KIND
      )})`
    );
  }
  if (obj.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `unsupported receipt schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${SCHEMA_VERSION})`
    );
  }

  for (const f of HEX32_FIELDS) {
    const v = obj[f];
    if (v === undefined || v === null) throw new Error(`receipt missing required field: ${f}`);
    if (typeof v !== "string" || !HEX32_RE.test(v)) {
      throw new Error(`receipt field ${f} must be a 0x-prefixed 32-byte hex string, got: ${String(v)}`);
    }
  }
  for (const f of ADDR_FIELDS) {
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

  // Optional operational fields: validate shape only when present.
  if (obj.commitTxHash !== undefined && obj.commitTxHash !== null) {
    if (typeof obj.commitTxHash !== "string" || !HEX32_RE.test(obj.commitTxHash)) {
      throw new Error(
        `receipt field commitTxHash must be a 0x-prefixed 32-byte hex string when present, got: ${String(
          obj.commitTxHash
        )}`
      );
    }
  }
  for (const f of ["commitBlockNumber", "minRevealDelay"]) {
    if (obj[f] !== undefined && obj[f] !== null) {
      if (!Number.isSafeInteger(obj[f]) || obj[f] < 0) {
        throw new Error(`receipt field ${f} must be a non-negative integer when present, got: ${String(obj[f])}`);
      }
    }
  }

  return obj;
}

/**
 * Validate and write a receipt object to `path` as pretty JSON. Pure-ish: the only side effect is
 * the file write. Throws (before writing) if the object is not a valid receipt, so a corrupt object
 * never lands on disk.
 * @param {object} obj   a receipt (typically from buildReceipt)
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
 * missing, not JSON, or fails validation — it NEVER returns a partial/corrupt receipt.
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
  RECEIPT_KIND,
  buildReceipt,
  writeReceipt,
  readReceipt,
  defaultReceiptPath,
  // Exported for unit tests that exercise validation directly.
  _validate,
};

"use strict";

// cli/parcel.js — a tamper-evident, versioned DELIVERY receipt for verifyhash (ProofParcel, T-18.2).
//
// WHY THIS EXISTS
//   B2B data exchange has an expensive failure mode: a delivery dispute ("you never sent file X" / "the
//   file you sent was altered"). ProofParcel issues a portable, independently-verifiable PROOF-OF-DELIVERY
//   receipt that pins EXACTLY which files (names AND bytes) were delivered for a parcel — so either party
//   can later re-derive the same root from the files on disk and detect any edit/rename/add/remove.
//
//   This is a THIN adapter over the SHARED provenance engine (cli/core/manifest.js): a parcel manifest is
//   the SAME Merkle ROOT + the SAME sorted per-file { relPath, contentHash, leaf } list a DataLedger
//   dataset manifest carries — built by the IDENTICAL core builder/validator with the IDENTICAL path-bound,
//   domain-separated Merkle convention from cli/hash.js (so a parcel root is the SAME value `vh hash <dir>`
//   and the contract's verifyLeaf produce for the same tree). The ONLY product-specific differences are
//   (a) the on-disk `kind` discriminator ("verifyhash.parcel-manifest") so the two products' manifests
//   never cross-validate, (b) the human "parcel manifest" label in error messages, and (c) an OPTIONAL,
//   clearly-UNTRUSTED `parcel` block.
//
// THE UNTRUSTED `parcel` BLOCK
//   A caller may attach OPTIONAL delivery metadata — { parcelId?, sender?, recipient? } — describing which
//   parcel this is and between which parties. Like the per-file source/license hints, these are
//   SELF-ASSERTED and UNTRUSTED: they are NOT bound into the Merkle root, editing them does not change the
//   root, and they prove NOTHING on their own. The manifest's `note` field says so in-band (mirroring the
//   hint caveats) so a downstream reader can never mistake a self-asserted sender/recipient — or any
//   delivery TIME — for a verified fact. "Delivered ON date T" needs the human-owned signing/timestamp
//   trust-root (STRATEGY.md P-3), which ProofParcel inherits VERBATIM and does NOT short-circuit here.
//
// STRICTNESS
//   A corrupt/edited parcel manifest must never be silently half-accepted: `readParcelManifest` validates
//   strictly (the shared structural checks via the core, PLUS the parcel-block shape) and throws on the
//   FIRST deviation rather than filling defaults — mirroring cli/dataset.js / cli/receipt.js / cli/proof.js.
//   It deliberately does NOT re-verify the leaves against content (it has no content); re-deriving the root
//   from the actual tree is the authoritative check (`vh parcel verify`).

const fs = require("fs");
const path = require("path");
const { keccak256, toUtf8Bytes } = require("ethers");
const { hashDirStream } = require("./hash");
const { diffManifest } = require("./receipt");
// The GENERIC, product-agnostic provenance engine. ProofParcel is a THIN adapter over it: the manifest
// builder/validator + the TRUST caveats live ONCE in cli/core/ and are shared with DataLedger so the
// Merkle/manifest math and — critically — the TRUST_NOTE can NEVER drift between products. The dependency
// points parcel → core (never the reverse).
const coreManifest = require("./core/manifest");
// The GENERIC signed-attestation ENVELOPE engine (the wrap-don't-edit invariant, the supported `scheme`
// list, signer recovery, the OFFLINE verifier). ProofParcel's attest/verify-attest are THIN adapters over
// it — the SAME core `vh dataset attest`/`verify-attest` use — so the envelope machinery can never drift
// between products. parcel → core only (no back-edge).
const coreAttestation = require("./core/attestation");

// On-disk schema discriminator. A parcel manifest carries its OWN kind + version, DISTINCT from the
// dataset manifest kind (cli/dataset.js), the receipt kinds (cli/receipt.js), and the proof-artifact kind
// (cli/proof.js) — so a dataset manifest, a random JSON file, a receipt, or a proof artifact is never
// misread as a parcel manifest, and (critically) the two product kinds NEVER cross-validate.
const PARCEL_MANIFEST_KIND = "verifyhash.parcel-manifest";
const PARCEL_MANIFEST_SCHEMA_VERSION = 1;
const SUPPORTED_PARCEL_MANIFEST_SCHEMA_VERSIONS = Object.freeze([1]);

// Same hex shape the whole product family validates against (sourced from the shared core so it can never
// drift).
const HEX32_RE = coreManifest.HEX32_RE;

// The SHARED trust caveat (verbatim from core — ONE copy across the family, can never drift).
const TRUST_NOTE = coreManifest.TRUST_NOTE;

// ProofParcel-specific caveat, appended to the shared TRUST_NOTE wherever a human-output run LEADS with
// trust posture. It states the parcel-specific boundary: the receipt binds the delivered file SET to a
// root (tamper-evidence), but the `parcel` block (parcelId/sender/recipient) and any delivery TIME are
// UNTRUSTED self-asserted metadata and are NOT a trusted timestamp — "delivered ON date T" needs the
// human-owned signing/timestamp trust-root P-3 (cross-link), which this offline receipt does NOT provide.
const PARCEL_TRUST_NOTE =
  "PARCEL CAVEAT: this receipt binds the delivered file SET to a Merkle root and proves tamper-evidence " +
  "(any edit/rename/add/remove changes the root). The `parcel` block (parcelId/sender/recipient) and any " +
  "delivery TIME are UNTRUSTED, self-asserted metadata NOT bound into the root — this is NOT a trusted " +
  "timestamp. 'Delivered ON date T' needs the human-owned signing/timestamp trust-root (STRATEGY.md P-3).";

// The recognized fields of the OPTIONAL `parcel` block. Each is an OPTIONAL self-asserted string; an
// unknown field is rejected so junk never lands in the manifest masquerading as structured metadata.
const PARCEL_BLOCK_FIELDS = Object.freeze(["parcelId", "sender", "recipient"]);

// ProofParcel's manifest framing, passed to the GENERIC core builder/validator. The core does the shared
// Merkle/manifest math + structural validation; this object supplies ONLY the ProofParcel-specific framing.
const MANIFEST_CFG = Object.freeze({
  kind: PARCEL_MANIFEST_KIND,
  schemaVersion: PARCEL_MANIFEST_SCHEMA_VERSION,
  supportedSchemaVersions: SUPPORTED_PARCEL_MANIFEST_SCHEMA_VERSIONS,
  note: TRUST_NOTE,
  label: "parcel manifest",
});

/**
 * Normalize a raw parcel-metadata block into a plain { parcelId?, sender?, recipient? } object of strings.
 * Rejects a non-object, an unknown field, or a non-string value, so junk never lands in the manifest.
 * Returns undefined when the block is absent OR carries no labeled field (so an empty `parcel` block never
 * litters the manifest with `{}`). PURE — no side effects.
 *
 * @param {object|null|undefined} raw
 * @returns {{parcelId?:string,sender?:string,recipient?:string}|undefined}
 */
function normalizeParcelBlock(raw) {
  if (raw == null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("parcel metadata must be an object with parcelId/sender/recipient");
  }
  for (const k of Object.keys(raw)) {
    if (!PARCEL_BLOCK_FIELDS.includes(k)) {
      throw new Error(
        `unknown parcel metadata field: ${JSON.stringify(k)} ` +
          `(allowed: ${PARCEL_BLOCK_FIELDS.join(", ")})`
      );
    }
  }
  const out = {};
  for (const k of PARCEL_BLOCK_FIELDS) {
    if (raw[k] === undefined || raw[k] === null) continue;
    if (typeof raw[k] !== "string") {
      throw new Error(`parcel metadata ${k} must be a string`);
    }
    out[k] = raw[k];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate the OPTIONAL `parcel` block on a parsed manifest (when present). Throws on a non-object, an
 * unknown field, or a non-string value. Shared by both the build path (defensive re-check) and the read
 * path. Does NOT mutate.
 * @param {any} block
 */
function validateParcelBlock(block) {
  if (block === undefined || block === null) return;
  if (typeof block !== "object" || Array.isArray(block)) {
    throw new Error("parcel manifest `parcel` block must be an object when present");
  }
  for (const k of Object.keys(block)) {
    if (!PARCEL_BLOCK_FIELDS.includes(k)) {
      throw new Error(
        `parcel manifest \`parcel\` block has an unknown field: ${JSON.stringify(k)} ` +
          `(allowed: ${PARCEL_BLOCK_FIELDS.join(", ")})`
      );
    }
    if (typeof block[k] !== "string") {
      throw new Error(`parcel manifest \`parcel\`.${k} must be a string when present`);
    }
  }
}

/**
 * Build a normalized, fully-validated PARCEL-manifest object from a streamed directory result plus optional
 * per-file hints and an optional UNTRUSTED parcel block. THIN wrapper over the generic core builder: the
 * core does the shared hint-normalization, the Merkle/manifest assembly, and the strict structural
 * validation (kind/schema/hex root/per-file leaf == pathLeaf(relPath,contentHash)); ProofParcel supplies
 * ONLY its framing (MANIFEST_CFG) and attaches the untrusted `parcel` block AFTER the root is fixed (so the
 * block can never be bound into the root). Throws if the result is malformed, so a corrupt manifest is
 * never produced.
 *
 * @param {{ root: string, leaves: {path:string,contentHash:string,leaf:string}[] }} built
 *        the object cli/hash.js › hashDirStream returns
 * @param {object} [opts]
 * @param {Object<string,{source?:string,license?:string}>} [opts.hints] OPTIONAL untrusted per-file hints
 * @param {{parcelId?:string,sender?:string,recipient?:string}} [opts.parcel] OPTIONAL untrusted delivery metadata
 * @returns {object} a validated parcel-manifest object
 */
function buildParcelManifest(built, opts = {}) {
  // 1. Core builds the shared manifest (root + per-file leaves + optional hints) — identical math to a
  //    dataset manifest. The root is computed from (relPath, content) pairs ONLY.
  const manifest = coreManifest.buildItemManifest(built, MANIFEST_CFG, { hints: opts.hints });

  // 2. Attach the OPTIONAL, UNTRUSTED parcel block AFTER the root is fixed. Recorded under an explicitly
  //    self-asserted `parcel` key; it does NOT participate in any leaf or the root.
  const parcel = normalizeParcelBlock(opts.parcel);
  if (parcel) manifest.parcel = parcel;

  // 3. Re-validate via the full parcel validator so the build path and the read path share ONE strict
  //    definition of a valid parcel manifest (core structural checks PLUS the parcel-block shape).
  return validateParcelManifest(manifest);
}

/**
 * Strictly validate a parsed parcel-manifest object. Runs the GENERIC core validator with ProofParcel's
 * framing (MANIFEST_CFG) — which enforces the shared structural rules and, via the distinct `kind`, REJECTS
 * a dataset manifest (and vice-versa, the dataset validator rejects this) so the two product kinds never
 * cross-validate — then ADDITIONALLY validates the optional `parcel` block. Throws on the FIRST problem;
 * never mutates and never fills defaults.
 * @param {any} obj
 * @returns {object} the same object, if valid
 */
function validateParcelManifest(obj) {
  coreManifest.validateItemManifest(obj, MANIFEST_CFG);
  validateParcelBlock(obj.parcel);
  return obj;
}

/**
 * Read, parse, and STRICTLY validate the parcel manifest at `manifestPath`. Throws on a missing file,
 * invalid JSON, or ANY schema deviation (so a malformed/edited/foreign manifest — including a DATASET
 * manifest — is rejected, never half-accepted).
 * @param {string} manifestPath
 * @returns {object} the validated parcel-manifest object
 */
function readParcelManifest(manifestPath) {
  if (!manifestPath || typeof manifestPath !== "string") {
    throw new Error("readParcelManifest requires a manifest file path");
  }
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch (e) {
    throw new Error(`cannot read parcel manifest at ${manifestPath}: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`parcel manifest at ${manifestPath} is not valid JSON: ${e.message}`);
  }
  return validateParcelManifest(obj);
}

/**
 * Validate and write a parcel manifest to `outPath` as pretty JSON + a trailing newline. The ONLY side
 * effect is the file write at the caller-chosen path (never silently the cwd), and it throws (before
 * writing) if the object is not a valid parcel manifest, so a corrupt manifest never lands on disk.
 * @param {object} obj     a parcel manifest (typically from buildParcelManifest)
 * @param {string} outPath destination file path (caller-chosen)
 * @returns {object} the validated object that was written
 */
function writeParcelManifest(obj, outPath) {
  if (!outPath || typeof outPath !== "string") {
    throw new Error("writeParcelManifest requires an --out path");
  }
  validateParcelManifest(obj);
  fs.writeFileSync(outPath, JSON.stringify(obj, null, 2) + "\n");
  return obj;
}

/**
 * Orchestrate `vh parcel build <dir> --out <p>`: stream-hash the delivered tree, build the parcel manifest
 * (with optional untrusted hints + parcel metadata), write it to the caller's --out path, and return a
 * small summary. Writes ONLY to `outPath` — no cwd litter. Every human-output run LEADS with the shared
 * TRUST_NOTE (verbatim) + the parcel-specific caveat. OFFLINE: no provider, no key, no network.
 *
 * @param {object} opts
 * @param {string} opts.dir       delivered directory to manifest (walked recursively)
 * @param {string} opts.out       where to write the manifest (REQUIRED — never defaulted to cwd)
 * @param {Object<string,{source?:string,license?:string}>} [opts.hints] optional untrusted per-file hints
 * @param {{parcelId?:string,sender?:string,recipient?:string}} [opts.parcel] optional untrusted delivery metadata
 * @param {boolean} [opts.json]   emit machine-readable JSON instead of the human summary
 * @param {(s:string)=>void} [opts.stdout] sink for stdout (default process.stdout.write); injectable for tests
 * @returns {{ root: string, fileCount: number, out: string, parcel: object|undefined }}
 */
function runParcelBuild(opts) {
  if (!opts || typeof opts !== "object") throw new Error("runParcelBuild requires options");
  const { dir, out, hints, parcel } = opts;
  const write = opts.stdout || ((s) => process.stdout.write(s));
  if (!dir) throw new Error("runParcelBuild requires a parcel <dir>");
  if (!out) throw new Error("runParcelBuild requires an --out <manifest> path");

  // Resolve to an absolute path so the manifest is written EXACTLY where the caller asked, regardless of
  // cwd. statSync errors clearly (ENOENT / not a dir) before we walk anything.
  const dirAbs = path.resolve(dir);
  const stat = fs.statSync(dirAbs);
  if (!stat.isDirectory()) {
    throw new Error(`parcel target is not a directory: ${dir}`);
  }
  const outAbs = path.resolve(out);

  const built = hashDirStream(dirAbs); // streams each file; never loads all content at once
  const manifest = buildParcelManifest(built, { hints, parcel });
  writeParcelManifest(manifest, outAbs);

  if (opts.json) {
    write(
      JSON.stringify({
        root: manifest.root,
        fileCount: manifest.fileCount,
        out: outAbs,
        parcel: manifest.parcel,
      }) + "\n"
    );
  } else {
    write(`  TRUST: ${TRUST_NOTE}\n`);
    write(`  ${PARCEL_TRUST_NOTE}\n`);
    write(`parcel manifest written: ${outAbs}\n`);
    write(`  root:  ${manifest.root}\n`);
    write(`  files: ${manifest.fileCount}\n`);
    if (manifest.parcel) {
      write(
        "  parcel (UNTRUSTED self-asserted metadata; NOT bound into the root): " +
          JSON.stringify(manifest.parcel) +
          "\n"
      );
    } else {
      write("  parcel: (none provided)\n");
    }
  }
  return {
    root: manifest.root,
    fileCount: manifest.fileCount,
    out: outAbs,
    parcel: manifest.parcel,
  };
}

// Possible outcomes of a `vh parcel verify` run. The AUTHORITATIVE verdict is recomputed-root vs
// manifest-root — never the per-file diff (which only LOCALIZES which file moved). Mirrors
// cli/dataset.js › VERIFY_STATUS so all verify gates share ONE vocabulary AND ONE exit contract.
const VERIFY_STATUS = Object.freeze({
  MATCH: "MATCH", // root re-derived from the FRESH tree equals the manifest's recorded root
  MISMATCH: "MISMATCH", // it does NOT — a file was added/removed/changed/renamed since the manifest
});

/**
 * Re-derive the parcel root from a FRESH copy of the delivered files at `dir` and compare it to the
 * (UNTRUSTED) manifest's recorded root, then localize any divergence to specific files.
 *
 * TRUST POSTURE. The manifest is an UNTRUSTED hint: the AUTHORITATIVE MATCH/MISMATCH is
 * `recomputed-root === manifest-root`, recomputed here from the actual bytes on disk via the SAME
 * path-bound Merkle convention `vh hash <dir>` and the on-chain verifyLeaf use. The per-file
 * ADDED/REMOVED/CHANGED diff is a CONVENIENCE that says WHICH file diverged; it never decides the verdict
 * (so even a manifest with a hand-edited `root` cannot fake a MATCH — the root is recomputed, not read
 * from the manifest). The untrusted `parcel` block plays NO part in the verdict. Fully OFFLINE: no
 * provider, no key, no network.
 *
 * The diff REUSES the SAME receipt-manifest diff core (`cli/receipt.js › diffManifest`, the function
 * `cli/verify.js` and `vh dataset verify` use): a `CHANGED` entry carries old→new contentHash; a rename
 * surfaces as one REMOVED (old path) + one ADDED (new path), because the path is bound into the leaf.
 *
 * @param {object} opts
 * @param {string} opts.dir       delivered directory to re-derive the root from (the FRESH copy)
 * @param {string} opts.manifest  path to a manifest written by `vh parcel build` (UNTRUSTED hint)
 * @param {boolean}[opts.json]    emit a machine-readable JSON object instead of the human block
 * @param {(s:string)=>void}[opts.stdout] sink for stdout (default process.stdout.write); injectable for tests
 * @returns {{
 *   status: "MATCH"|"MISMATCH",
 *   recomputedRoot: string,
 *   manifestRoot: string,
 *   fileCount: number,
 *   parcel: object|undefined,
 *   diff: { added: any[], removed: any[], changed: any[], unchanged: any[], identical: boolean }
 * }}
 */
function runParcelVerify(opts) {
  if (!opts || typeof opts !== "object") throw new Error("runParcelVerify requires options");
  const { dir, manifest: manifestPath } = opts;
  const write = opts.stdout || ((s) => process.stdout.write(s));
  if (!dir) throw new Error("runParcelVerify requires a parcel <dir>");
  if (!manifestPath) throw new Error("runParcelVerify requires a --manifest <p> path");

  // Resolve so we read EXACTLY where the caller asked regardless of cwd. statSync errors clearly
  // (ENOENT / not a dir) before we walk anything — and BEFORE we trust the manifest at all.
  const dirAbs = path.resolve(dir);
  const stat = fs.statSync(dirAbs);
  if (!stat.isDirectory()) {
    throw new Error(`parcel target is not a directory: ${dir}`);
  }

  // The manifest is an untrusted hint, but it must be STRUCTURALLY sound or we cannot diff against it
  // (readParcelManifest rejects a corrupt/edited/foreign manifest — including a DATASET manifest — rather
  // than half-accepting it).
  const manifest = readParcelManifest(manifestPath);

  // Re-derive the root + per-file leaves from the FRESH tree (streamed; never loads all content).
  const built = hashDirStream(dirAbs);
  const recomputedRoot = built.root;
  const manifestRoot = manifest.root;

  // AUTHORITATIVE verdict: recomputed root vs manifest root. Case-insensitive hex compare.
  const status =
    recomputedRoot.toLowerCase() === manifestRoot.toLowerCase()
      ? VERIFY_STATUS.MATCH
      : VERIFY_STATUS.MISMATCH;

  // Localize WHICH file diverged using the SAME diff core cli/verify.js / vh dataset verify use. The
  // manifest entries are keyed by `relPath`; diffManifest expects `path`, so map across.
  const recordedManifest = manifest.files.map((f) => ({
    path: f.relPath,
    contentHash: f.contentHash,
    leaf: f.leaf,
  }));
  const diff = diffManifest(recordedManifest, built.leaves);

  if (opts.json) {
    write(
      JSON.stringify({
        status,
        recomputedRoot,
        manifestRoot,
        fileCount: built.leaves.length,
        parcel: manifest.parcel,
        diff,
      }) + "\n"
    );
  } else {
    for (const line of formatParcelVerify({
      status,
      recomputedRoot,
      manifestRoot,
      parcel: manifest.parcel,
      diff,
    })) {
      write(line + "\n");
    }
  }
  return {
    status,
    recomputedRoot,
    manifestRoot,
    fileCount: built.leaves.length,
    parcel: manifest.parcel,
    diff,
  };
}

/**
 * Render a parcel-verify result as the human-readable block the CLI prints. LEADS with the shared
 * TRUST_NOTE (verbatim) + the parcel-specific caveat, then the authoritative root comparison, then the
 * per-file diff (labeled as localization, never the verdict), then the untrusted parcel block.
 * @param {{status:string,recomputedRoot:string,manifestRoot:string,parcel:object|undefined,diff:object}} r
 * @returns {string[]} lines
 */
function formatParcelVerify(r) {
  const lines = [
    `  TRUST: ${TRUST_NOTE}`,
    `  ${PARCEL_TRUST_NOTE}`,
    "",
    `  parcel verify: ${r.status}`,
    `  recomputed root: ${r.recomputedRoot}  (re-derived from the files on disk — AUTHORITATIVE)`,
    `  manifest root:   ${r.manifestRoot}  (untrusted hint)`,
  ];
  if (r.status === VERIFY_STATUS.MATCH) {
    lines.push(
      "  The delivered files are byte-for-byte (and name-for-name) what the parcel manifest committed to."
    );
  } else {
    lines.push(
      "  The delivered files do NOT match the manifest: a file was added, removed, changed, or renamed",
      "  since the manifest was built (the root commits to file NAMES and bytes)."
    );
  }
  const d = r.diff;
  lines.push("", "  --- per-file diff (localization; the root comparison above is the verdict) ---");
  if (d.identical) {
    lines.push("  files: IDENTICAL — every file matches the manifest (no ADDED/REMOVED/CHANGED).");
  } else {
    lines.push(
      `  files: ${d.changed.length} CHANGED, ${d.added.length} ADDED, ${d.removed.length} REMOVED` +
        ` (${d.unchanged.length} unchanged)`
    );
    for (const c of d.changed) {
      lines.push(`    CHANGED  ${c.path}`);
      lines.push(`               old: ${c.oldContentHash}`);
      lines.push(`               new: ${c.newContentHash}`);
    }
    for (const a of d.added) {
      lines.push(`    ADDED    ${a.path}  (${a.contentHash})   present now, not in the manifest`);
    }
    for (const rm of d.removed) {
      lines.push(`    REMOVED  ${rm.path}  (${rm.contentHash})   in the manifest, gone now`);
    }
  }
  // The untrusted parcel block, ALWAYS flagged as self-asserted and never part of the verdict.
  lines.push("");
  if (r.parcel) {
    lines.push(
      "  parcel (UNTRUSTED self-asserted metadata; NOT bound into the root, plays NO part in the verdict): " +
        JSON.stringify(r.parcel)
    );
  } else {
    lines.push("  parcel: (none recorded in the manifest)");
  }
  return lines;
}

// =================================================================================================
// `vh parcel attest <manifest> [--json] [--out <p>]` — the deterministic, canonical UNSIGNED attestation
// payload a human signing/timestamp trust-root (P-3) will sign over a DELIVERED parcel.
//
// WHY THIS EXISTS
//   A ProofParcel manifest binds the delivered file SET to a Merkle root. But "you accepted delivery of
//   THIS exact parcel on date T" needs a SIGNATURE over a canonical IDENTITY — and standing up a real
//   signing key / timestamp anchor is a HUMAN-owned trust-root (P-3, needs-human). The deterministic,
//   canonical BYTES that human/service would sign are fully buildable NOW, purely offline. Producing them
//   turns the future human signing step into "sign THIS exact file" — a one-liner.
//
//   `vh parcel attest <manifest>` reads the manifest via the SAME strict `readParcelManifest` (a corrupt/
//   foreign manifest — INCLUDING a dataset manifest — is rejected, never half-accepted) and emits a
//   versioned, strictly-validated attestation ENVELOPE that commits to the parcel IDENTITY a signer signs
//   over: the Merkle `root`, the `fileCount`, and a canonical `manifestDigest` over the COMMITTED file set.
//   PURELY OFFLINE: no tree, no provider, no key, no network.
//
//   It uses the SAME canonicalization as `vh dataset attest` (keccak256 over the committed
//   {relPath,contentHash,leaf} entries, ordered by relPath, no insignificant whitespace) — the UNTRUSTED
//   `parcel` block (parcelId/sender/recipient) and the per-file hints are DELIBERATELY EXCLUDED: they are
//   not bound into the root, so a signer must not commit to them. So a parcel and a dataset built over the
//   SAME files yield the SAME manifestDigest; the products are distinguished by the SIGNED-CONTAINER kind
//   (below), not the unsigned identity.
//
// UNSIGNED MARKER (never imply a signature/timestamp exists)
//   The envelope carries `signed: false` / `signature: null` and an in-band `note` pointing at the
//   human-owned trust-root (P-3). Until a signature is attached it proves only the same set-membership /
//   identity the manifest already does — NOT "delivered/unaltered since a date T".

const PARCEL_ATTESTATION_KIND = "verifyhash.parcel-attestation";
const PARCEL_ATTESTATION_SCHEMA_VERSION = 1;
const SUPPORTED_PARCEL_ATTESTATION_SCHEMA_VERSIONS = Object.freeze([1]);

// The standing trust caveat carried IN-BAND in every UNSIGNED parcel-attestation envelope. Load-bearing:
// a reader (or the future human signer) must never mistake this UNSIGNED payload for a time-anchored
// delivery proof. It states plainly that signing is the human-owned trust-root (P-3, needs-human).
const PARCEL_ATTESTATION_TRUST_NOTE =
  "This is the UNSIGNED parcel attestation payload. It commits to the parcel IDENTITY (Merkle root, " +
  "fileCount, and a canonical manifestDigest over the delivered file set). It is NOT signed and NOT " +
  "timestamped: `signed` is false and `signature` is null until a human/timestamp trust-root fills them " +
  "in. Standing up a real signing key / timestamp anchor is the human-owned trust-root (needs-human, " +
  "P-3). Until a signature is attached, this proves only the same set-membership / identity the manifest " +
  "already does — NOT that the parcel was DELIVERED, or is unaltered, since a date T.";

/**
 * Canonically serialize the parcel manifest's COMMITTED file set to the exact UTF-8 bytes the
 * `manifestDigest` is taken over. IDENTICAL canonicalization to `vh dataset attest`: only the
 * root-committed fields { relPath, contentHash, leaf } are included (the untrusted per-file hints AND the
 * untrusted `parcel` block are excluded), each entry's keys emitted in the FIXED order
 * [relPath, contentHash, leaf], entries ordered by relPath ascending, the array JSON-serialized with NO
 * insignificant whitespace. Pure (no mutation).
 * @param {object} manifest a validated parcel-manifest object (from readParcelManifest/validateParcelManifest)
 * @returns {string} the canonical JSON string of the committed file set
 */
function canonicalParcelFiles(manifest) {
  const entries = manifest.files.map((f) => ({
    relPath: f.relPath,
    contentHash: f.contentHash,
    leaf: f.leaf,
  }));
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * Compute the canonical `manifestDigest`: keccak256 over the canonical serialization of the parcel
 * manifest's committed file set (see canonicalParcelFiles). Deterministic; any edit/rename/add/remove to
 * the committed set changes it. Pure.
 * @param {object} manifest a validated parcel-manifest object
 * @returns {string} a 0x-prefixed 32-byte hex digest
 */
function parcelManifestDigest(manifest) {
  return keccak256(toUtf8Bytes(canonicalParcelFiles(manifest)));
}

/**
 * Build a normalized, fully-validated UNSIGNED parcel-attestation envelope from a validated parcel-manifest
 * object. Commits to the parcel identity (root, fileCount, manifestDigest) plus the standing trust caveat,
 * with explicit `signed:false`/`signature:null` markers. PURE: no I/O, no key, no network. The UNTRUSTED
 * `parcel` block is DELIBERATELY excluded — a signer commits to the file SET identity, never the
 * self-asserted metadata. Throws (via validateParcelAttestation) if the result is malformed.
 * @param {object} manifest a validated parcel-manifest object (from readParcelManifest)
 * @returns {object} a validated parcel-attestation envelope
 */
function buildParcelAttestation(manifest) {
  validateParcelManifest(manifest);
  const env = {
    kind: PARCEL_ATTESTATION_KIND,
    schemaVersion: PARCEL_ATTESTATION_SCHEMA_VERSION,
    note: PARCEL_ATTESTATION_TRUST_NOTE,
    root: manifest.root,
    fileCount: manifest.files.length,
    manifestDigest: parcelManifestDigest(manifest),
    signed: false,
    signature: null,
  };
  validateParcelAttestation(env);
  return env;
}

/**
 * Strictly validate a parsed UNSIGNED parcel-attestation envelope. Throws an Error describing the FIRST
 * problem; never mutates and never fills defaults. REJECTS a wrong kind/schemaVersion (so a DATASET
 * attestation never cross-validates), a missing/!hex root or manifestDigest, a bad fileCount, or any
 * envelope that claims to be signed (this UNSIGNED payload must never imply a signature).
 * @param {any} obj
 * @returns {object} the same object, if valid
 */
function validateParcelAttestation(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("parcel attestation must be a JSON object");
  }
  if (obj.kind !== PARCEL_ATTESTATION_KIND) {
    throw new Error(
      `not a verifyhash parcel attestation (kind: ${JSON.stringify(obj.kind)}; expected ` +
        `${JSON.stringify(PARCEL_ATTESTATION_KIND)})`
    );
  }
  if (!SUPPORTED_PARCEL_ATTESTATION_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new Error(
      `unsupported parcel attestation schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(SUPPORTED_PARCEL_ATTESTATION_SCHEMA_VERSIONS)})`
    );
  }
  for (const f of ["root", "manifestDigest"]) {
    if (typeof obj[f] !== "string" || !HEX32_RE.test(obj[f])) {
      throw new Error(
        `parcel attestation ${f} must be a 0x-prefixed 32-byte hex string, got: ${String(obj[f])}`
      );
    }
  }
  if (!Number.isInteger(obj.fileCount) || obj.fileCount < 1) {
    throw new Error(
      `parcel attestation fileCount must be a positive integer, got: ${String(obj.fileCount)}`
    );
  }
  // The UNSIGNED payload must NEVER imply a signature/timestamp. `signed` exactly false, `signature`
  // exactly null — attaching a real signature is the human-owned trust-root (P-3).
  if (obj.signed !== false) {
    throw new Error(
      `parcel attestation signed must be false (this build emits/reads only the UNSIGNED payload; ` +
        `attaching a real signature is the human-owned trust-root, P-3), got: ${String(obj.signed)}`
    );
  }
  if (obj.signature !== null) {
    throw new Error(
      `parcel attestation signature must be null in the UNSIGNED payload, got: ${String(obj.signature)}`
    );
  }
  return obj;
}

/**
 * Serialize an UNSIGNED parcel-attestation envelope to its canonical, byte-deterministic bytes: a FIXED
 * top-level key order, NO insignificant whitespace, a single trailing newline. Two runs over the same
 * manifest produce an identical string — the property that makes signing the bytes well-defined.
 * @param {object} env a validated parcel-attestation envelope
 * @returns {string} the canonical serialization (newline-terminated)
 */
function serializeParcelAttestation(env) {
  validateParcelAttestation(env);
  const canonical = {
    kind: env.kind,
    schemaVersion: env.schemaVersion,
    note: env.note,
    root: env.root,
    fileCount: env.fileCount,
    manifestDigest: env.manifestDigest,
    signed: env.signed,
    signature: env.signature,
  };
  return JSON.stringify(canonical) + "\n";
}

/**
 * Read, parse, and STRICTLY validate the UNSIGNED parcel-attestation envelope at `attestationPath`. The
 * strict reader round-trips with serializeParcelAttestation; a malformed/edited/foreign (e.g. a DATASET)
 * envelope is rejected, never half-accepted. Throws on a missing file or invalid JSON too.
 * @param {string} attestationPath
 * @returns {object} the validated envelope
 */
function readParcelAttestation(attestationPath) {
  if (!attestationPath || typeof attestationPath !== "string") {
    throw new Error("readParcelAttestation requires an attestation file path");
  }
  let raw;
  try {
    raw = fs.readFileSync(attestationPath, "utf8");
  } catch (e) {
    throw new Error(`cannot read parcel attestation at ${attestationPath}: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`parcel attestation at ${attestationPath} is not valid JSON: ${e.message}`);
  }
  return validateParcelAttestation(obj);
}

// =================================================================================================
// SIGNED parcel-attestation container — a detached signature WRAPPED AROUND the canonical UNSIGNED parcel
// attestation, over the SAME generic core `vh dataset` uses. ProofParcel's OWN container `kind` means a
// DATASET signed-container does NOT cross-verify as a parcel one (and vice-versa) even though the UNSIGNED
// identity bytes can coincide for the same files.

const SIGNED_PARCEL_ATTESTATION_KIND = "verifyhash.parcel-attestation-signed";
const SIGNED_PARCEL_ATTESTATION_SCHEMA_VERSION = 1;
const SUPPORTED_SIGNED_PARCEL_ATTESTATION_SCHEMA_VERSIONS = Object.freeze([1]);

// The detached signature schemes, sourced from cli/core so the supported set is the IDENTICAL one shared
// across the product family. `eip191-personal-sign` = EIP-191 personal_sign over the canonical UNSIGNED
// parcel-attestation bytes (a 65-byte r||s||v secp256k1 signature).
const SIGNED_PARCEL_ATTESTATION_SCHEMES = coreAttestation.SIGNED_ATTESTATION_SCHEMES;

// The standing trust caveat carried IN-BAND in every SIGNED parcel container. REUSES the shared TRUST_NOTE
// VERBATIM (so the family caveats never drift), adds the parcel-specific caveat (PARCEL_TRUST_NOTE,
// verbatim), and the signed-container-specific assertion: it asserts the holder of `signer`'s key vouched
// for THIS parcel identity at signing time; it does NOT prove a delivery TIMESTAMP (still P-3).
const SIGNED_PARCEL_ATTESTATION_TRUST_NOTE =
  "This is a SIGNED parcel attestation container: it wraps (never edits) the EXACT canonical UNSIGNED " +
  "parcel-attestation bytes in `attestation` and attaches a detached signature. It asserts that the " +
  "holder of the `signer` key vouched for THIS parcel identity (the embedded root, fileCount, " +
  "manifestDigest) at signing time. It does NOT by itself prove a trustworthy delivery TIMESTAMP: " +
  '"delivered/unaltered since a date T" still needs the human-owned signing/timestamp trust-root ' +
  "(needs-human, P-3). Every caveat of the embedded UNSIGNED payload still applies. " +
  PARCEL_TRUST_NOTE +
  " " +
  TRUST_NOTE;

// ProofParcel's signed-container framing, passed to the GENERIC core. The core owns the envelope machinery
// (the wrap-don't-edit invariant, the scheme list, signer recovery); this object supplies ONLY ProofParcel's
// kind/schema/note + the "signed parcel attestation" label and the UNSIGNED-payload codec the core
// re-validates the embedded payload with (so the core stays product-agnostic — no back-edge).
const SIGNED_PARCEL_ATTESTATION_CFG = Object.freeze({
  kind: SIGNED_PARCEL_ATTESTATION_KIND,
  schemaVersion: SIGNED_PARCEL_ATTESTATION_SCHEMA_VERSION,
  supportedSchemaVersions: SUPPORTED_SIGNED_PARCEL_ATTESTATION_SCHEMA_VERSIONS,
  note: SIGNED_PARCEL_ATTESTATION_TRUST_NOTE,
  label: "signed parcel attestation",
  validateUnsigned: validateParcelAttestation,
  serializeUnsigned: serializeParcelAttestation,
});

/**
 * Strictly validate a parsed SIGNED parcel-attestation container. THIN wrapper over the generic core
 * validator with ProofParcel's framing: the core enforces the shared wrap-don't-edit invariant (re-validate
 * + canonical-byte equality of the embedded UNSIGNED payload via ProofParcel's own
 * validate/serializeParcelAttestation), the scheme list, and the signer/signature shape. A DATASET
 * signed-container (different kind) is REJECTED here. Never half-accepts.
 * @param {any} obj
 * @returns {object} the same object, if valid
 */
function validateSignedParcelAttestation(obj) {
  return coreAttestation.validateSignedAttestation(obj, SIGNED_PARCEL_ATTESTATION_CFG);
}

/**
 * Assemble + validate a SIGNED parcel-attestation container from a validated UNSIGNED envelope and a
 * detached signature triple. PURE: NO signing, NO key handling — the loop never holds a key. Embeds the
 * EXACT canonical unsigned bytes (serializeParcelAttestation) as a string so the signed-over bytes are
 * unambiguous, attaches { scheme, signer, signature }, and strictly validates.
 * @param {object} params
 * @param {object} params.attestation a validated UNSIGNED parcel-attestation envelope
 * @param {string} params.scheme one of SIGNED_PARCEL_ATTESTATION_SCHEMES (e.g. "eip191-personal-sign")
 * @param {string} params.signer the claimed 0x-address of the signer
 * @param {string} params.signature the 0x-hex detached signature over serializeParcelAttestation(attestation)
 * @returns {object} a validated signed parcel-attestation container
 */
function buildSignedParcelAttestation(params) {
  return coreAttestation.buildSignedAttestation(params, SIGNED_PARCEL_ATTESTATION_CFG);
}

/**
 * Serialize a SIGNED parcel-attestation container to its canonical, byte-deterministic bytes (fixed
 * top-level + signature-block key order, no insignificant whitespace, a single trailing newline).
 * @param {object} container a validated signed parcel-attestation container
 * @returns {string} the canonical serialization (newline-terminated)
 */
function serializeSignedParcelAttestation(container) {
  return coreAttestation.serializeSignedAttestation(container, SIGNED_PARCEL_ATTESTATION_CFG);
}

/**
 * Read, parse, and STRICTLY validate the SIGNED parcel-attestation container at `signedPath`. Round-trips
 * with serializeSignedParcelAttestation; a malformed/edited/foreign (e.g. a DATASET signed) container is
 * rejected, never half-accepted. Throws on a missing file or invalid JSON too.
 * @param {string} signedPath
 * @returns {object} the validated container
 */
function readSignedParcelAttestation(signedPath) {
  return coreAttestation.readSignedAttestation(signedPath, SIGNED_PARCEL_ATTESTATION_CFG);
}

/**
 * Recover the signing address from a signed parcel-attestation container's embedded canonical bytes +
 * signature per the declared scheme. THIN wrapper over the core. Returns the recovered address lowercase.
 * @param {object} container a validated signed parcel-attestation container
 * @returns {string} the recovered signer address, 0x-prefixed lowercase
 */
function recoverSignedParcelAttestationSigner(container) {
  return coreAttestation.recoverSigner(container);
}

/**
 * Orchestrate `vh parcel attest <manifest> [--json] [--out <p>]`. Reads the parcel manifest via the strict
 * `readParcelManifest`, builds the UNSIGNED parcel-attestation envelope, and emits its canonical bytes.
 * With `--out` it writes those exact bytes to the caller's EXPLICIT path (never cwd) and names the file;
 * without `--out` it prints them to stdout. `--json` is the machine form AND is itself the canonical bytes
 * (so a caller can pipe it straight into a signer). PURELY OFFLINE: no tree, no provider, no key, no network.
 *
 * @param {object} opts
 * @param {string} opts.manifest  path to a manifest written by `vh parcel build`
 * @param {boolean}[opts.json]    emit the canonical machine form (which is the same canonical bytes)
 * @param {string} [opts.out]     write the canonical payload to this explicit path (caller-chosen; never cwd)
 * @param {(s:string)=>void}[opts.stdout] sink for stdout (default process.stdout.write); injectable for tests
 * @returns {{ envelope: object, canonical: string, out: string|null }}
 */
function runParcelAttest(opts) {
  if (!opts || typeof opts !== "object") throw new Error("runParcelAttest requires options");
  const { manifest: manifestPath } = opts;
  const write = opts.stdout || ((s) => process.stdout.write(s));
  if (!manifestPath) throw new Error("runParcelAttest requires a <manifest> path");

  // Strict read: a corrupt/edited/foreign manifest (INCLUDING a dataset manifest) is rejected here, never
  // half-accepted, BEFORE any payload is built. The file SET it commits to is the TRUSTED basis.
  const manifest = readParcelManifest(manifestPath);

  const envelope = buildParcelAttestation(manifest);
  const canonical = serializeParcelAttestation(envelope);

  let outAbs = null;
  if (opts.out) {
    outAbs = path.resolve(opts.out);
    fs.writeFileSync(outAbs, canonical); // the ONLY side effect — at the caller's explicit path, never cwd
    if (!opts.json) write(`parcel attestation written: ${outAbs}\n`);
  }

  if (opts.json) {
    // The machine form IS the canonical bytes (so a caller can pipe `--json` straight into a signer).
    write(canonical);
  } else if (!outAbs) {
    write(canonical);
  }

  return { envelope, canonical, out: outAbs };
}

// =================================================================================================
// `vh parcel sign <manifest> --key-env <VAR> | --key-file <path> [--out <p>] [--json]` — read a
// HUMAN-supplied key, sign the UNSIGNED parcel attestation, write the SIGNED container (T-19.2).
//
// THIN parallel to `vh dataset sign`: it builds the UNSIGNED parcel-attestation payload via the EXISTING
// `vh parcel attest` code path (buildParcelAttestation — NO re-implementation), resolves a HUMAN-supplied
// key into an in-process Wallet via the SHARED `loadSigningWallet`, and signs over the canonical bytes via
// the SAME T-19.1 `signAttestation` core with ProofParcel's signed-container framing. The loop never
// generates or holds a key. The container ROUND-TRIPS by construction: `vh parcel verify-attest` recovers
// exactly this signer over exactly these bytes, and a DATASET signed-container does NOT cross-verify
// (distinct kind).
//
// KEY HYGIENE (load-bearing): EXACTLY ONE of `--key-env`/`--key-file`; neither/both, a missing env var, an
// unreadable file, or a malformed/zero key HARD-ERRORS BEFORE any signing, with a message that NEVER
// includes the key. Success/`--json` output prints ONLY the signer ADDRESS, the output path, and the
// scheme — never the key.

// The signing-specific caveat the human-output sign path LEADS with (P-3, verbatim). This signs the parcel
// IDENTITY with the caller's OWN key; "the signer says so" is NOT a trusted delivery TIMESTAMP.
const SIGN_TRUST_NOTE =
  "This signs the parcel IDENTITY (root, fileCount, manifestDigest) with the key YOU supplied. A " +
  "self-managed key attests \"the signer says so\" — it is NOT an independent, trusted TIMESTAMP: " +
  '"delivered/unaltered since a date T" still needs the human-owned signing/timestamp trust-root ' +
  "(needs-human, P-3). The key must be one YOU provisioned OUTSIDE this tool.";

/**
 * Orchestrate `vh parcel sign <manifest> --key-env <VAR> | --key-file <path> [--out <p>] [--json]`. Reads
 * the parcel manifest via the strict `readParcelManifest`, builds the UNSIGNED attestation via the EXISTING
 * `buildParcelAttestation` path (NO re-implementation), resolves a HUMAN-supplied key into an in-process
 * Wallet via the shared `loadSigningWallet`, signs over the canonical bytes via the T-19.1 `signAttestation`
 * core, and writes the SIGNED container's canonical bytes to `--out` (or stdout). PURELY OFFLINE.
 *
 * KEY HYGIENE: the key is read, used, and discarded; NEVER returned, persisted, or logged. The
 * success/`--json` output prints ONLY the signer address, the output path, and the scheme — never the key.
 *
 * @param {object} opts
 * @param {string} opts.manifest  path to a manifest written by `vh parcel build`
 * @param {string} [opts.keyEnv]  env var holding the signing key (EXACTLY ONE of keyEnv/keyFile)
 * @param {string} [opts.keyFile] path to a key file the human created (EXACTLY ONE of keyEnv/keyFile)
 * @param {boolean}[opts.json]    emit a machine-readable { signer, out, scheme, container, ... } object;
 *                                with NO --out the `container` field carries the canonical signed bytes so
 *                                `--json` never silently drops the artifact (parity with `attest --json`)
 * @param {string} [opts.out]     write the signed container to this explicit path (caller-chosen; never cwd)
 * @param {(s:string)=>void}[opts.stdout] sink for stdout (default process.stdout.write); injectable for tests
 * @returns {Promise<{ container: object, canonical: string, signer: string, scheme: string, out: string|null }>}
 */
async function runParcelSign(opts) {
  if (!opts || typeof opts !== "object") throw new Error("runParcelSign requires options");
  const { manifest: manifestPath, keyEnv, keyFile } = opts;
  const write = opts.stdout || ((s) => process.stdout.write(s));
  if (!manifestPath) throw new Error("runParcelSign requires a <manifest> path");

  // Resolve the HUMAN-supplied key into an in-process Wallet FIRST (BEFORE any signing). Neither/both
  // sources, a missing env var, an unreadable file, or a malformed/zero key hard-errors here with a
  // key-free message.
  const { wallet } = coreAttestation.loadSigningWallet({ keyEnv, keyFile });

  // Strict read: a corrupt/edited/foreign manifest (INCLUDING a dataset manifest) is rejected here, never
  // half-accepted. The file SET it commits to is the TRUSTED basis of the attestation identity.
  const manifest = readParcelManifest(manifestPath);

  // Build the UNSIGNED payload via the EXISTING `vh parcel attest` path (NO re-implementation), then route
  // the Wallet + payload through the SAME T-19.1 core with ProofParcel's signed-container framing.
  const unsigned = buildParcelAttestation(manifest);
  const container = await coreAttestation.signAttestation(
    { attestation: unsigned, signer: wallet },
    SIGNED_PARCEL_ATTESTATION_CFG
  );
  const canonical = serializeSignedParcelAttestation(container);
  const signer = container.signature.signer; // lowercase 0x-address (PUBLIC) — never the key
  const scheme = container.signature.scheme;

  let outAbs = null;
  if (opts.out) {
    // Write the EXACT canonical signed bytes to the caller-chosen path (resolved absolute) — never cwd.
    // The ONLY side effect. NOTHING about the key is written.
    outAbs = path.resolve(opts.out);
    fs.writeFileSync(outAbs, canonical);
  }

  if (opts.json) {
    // Machine form: ONLY public fields — signer ADDRESS, output path, scheme. NEVER the key.
    //
    // ARTIFACT PARITY with `attest --json` (which emits the canonical bytes on stdout so a caller can
    // pipe straight on). When there is NO --out, the signed container has nowhere else to live, so we
    // carry the EXACT canonical signed bytes in a `container` field — `--json` without --out NEVER drops
    // the artifact. With --out the bytes are on disk at `out`, so `container` is null (no redundant copy).
    write(
      JSON.stringify({
        signed: true,
        signer,
        scheme,
        out: outAbs,
        kind: container.kind,
        // The canonical signed bytes when there is no file to point at; null when --out holds them.
        container: outAbs ? null : canonical,
        note: SIGN_TRUST_NOTE,
      }) + "\n"
    );
  } else {
    write(`  TRUST: ${SIGN_TRUST_NOTE}\n`);
    // The success line names WHICH key signed (by its PUBLIC address) so the human can confirm.
    write(`signed by ${signer}\n`);
    write(`  scheme: ${scheme}\n`);
    if (outAbs) {
      write(`  signed parcel attestation written: ${outAbs}\n`);
    } else {
      write(canonical);
    }
  }

  return { container, canonical, signer, scheme, out: outAbs };
}

// =================================================================================================
// `vh parcel verify-attest <signed> [--manifest <m>] [--signer <addr>] [--json]` — the OFFLINE verifier
// for a SIGNED parcel-attestation container, over the SAME generic core `vh dataset verify-attest` uses.
//
// WHY THIS EXISTS
//   A recipient handed a "signed by the sender" parcel attestation needs ONE command that answers, with no
//   key and no network: (1) is the embedded signature genuine — does it recover to the address the container
//   CLAIMS as `signer`? (2) Optionally: is the recovered signer the SPECIFIC sender I expected (`--signer`)?
//   (3) Optionally: does the signature bind the parcel I actually hold (`--manifest`)? — by recomputing the
//   canonical UNSIGNED bytes from MY parcel manifest via the EXISTING build path and requiring them
//   byte-identical to the embedded payload.
//
//   PURELY OFFLINE: no tree walk, no provider, no key, no network. EXIT CODES mirror the family's 0/3
//   data-divergence convention: 0 ACCEPTED, 3 REJECTED (so a recipient's CI can gate "genuinely signed by
//   our sender and binds this parcel"), 2 usage error, 1 runtime error.
//
// TRUST POSTURE (verbatim into output). A valid signature proves the HOLDER OF `signer`'s KEY vouched for
//   THIS parcel identity. It does NOT by itself prove a trustworthy delivery TIMESTAMP ("delivered on date
//   T" still rides the human-owned trust-root, P-3), and the `parcel` block (parcelId/sender/recipient) is
//   UNTRUSTED self-asserted metadata. Never overclaims past P-3.

const VERIFY_ATTEST_VERDICT = Object.freeze({ ACCEPTED: "ACCEPTED", REJECTED: "REJECTED" });

// The standing trust caveat the verify-attest output LEADS with. REUSES the shared TRUST_NOTE verbatim
// (so the family caveats never drift) + the parcel-specific caveat + the signing-specific caveat: a valid
// signature proves the key-holder vouched for this parcel IDENTITY; it does NOT prove a delivery timestamp
// (P-3, needs-human). Never overclaims.
const PARCEL_VERIFY_ATTEST_TRUST_NOTE =
  "A valid signature proves the HOLDER OF `signer`'s key vouched for THIS parcel identity (the embedded " +
  "root, fileCount, manifestDigest). It does NOT by itself prove a trustworthy delivery TIMESTAMP: " +
  '"delivered/unaltered since a date T" still needs the human-owned signing/timestamp trust-root ' +
  "(needs-human, P-3). " +
  PARCEL_TRUST_NOTE +
  " " +
  TRUST_NOTE;

/**
 * Verify (purely, OFFLINE) a signed parcel-attestation container: recover the signer and confirm it equals
 * the container's CLAIMED `signer`; OPTIONALLY pin it to an EXPECTED sender (`expectedSigner`); OPTIONALLY
 * confirm the signature binds a recipient's own parcel (`manifest`) by recomputing the canonical UNSIGNED
 * bytes via the EXISTING build path and requiring them byte-identical to the embedded payload. The verdict
 * is ACCEPTED only when EVERY requested check passes. No I/O, no provider, no key, no network. The ONLY
 * ProofParcel-specific step is recomputing the canonical bytes from the recipient's own parcel manifest;
 * the recovery / claimed-signer / expected-signer / binding logic is the GENERIC core.
 * @param {object} params
 * @param {object} params.container       a validated signed parcel-attestation container
 * @param {string} [params.expectedSigner] OPTIONAL expected sender 0x-address (--signer); checked when present
 * @param {object} [params.manifest]       OPTIONAL validated parcel-manifest object; binding check when present
 * @returns {object} the object the core verifySignedAttestation returns (shape parity with dataset verify-attest)
 */
function verifySignedParcelAttestation(params) {
  if (!params || typeof params !== "object") {
    throw new Error("verifySignedParcelAttestation requires { container, [expectedSigner], [manifest] }");
  }
  const { container, expectedSigner, manifest } = params;
  let expectedCanonical;
  if (manifest !== undefined && manifest !== null) {
    expectedCanonical = serializeParcelAttestation(buildParcelAttestation(manifest));
  }
  return coreAttestation.verifySignedAttestation({ container, expectedSigner, expectedCanonical });
}

/**
 * Render a parcel verify-attest result as the human-readable block the CLI prints. LEADS with the standing
 * trust caveat (reuses TRUST_NOTE + PARCEL_TRUST_NOTE + the signing caveat — never overclaims past P-3),
 * then the verdict, the recovered/claimed/expected signer, and each requested check with PASS/FAIL.
 * @param {object} r the object verifySignedParcelAttestation returns
 * @returns {string[]} lines
 */
function formatParcelVerifyAttest(r) {
  const lines = [
    "  TRUST: " + PARCEL_VERIFY_ATTEST_TRUST_NOTE,
    "",
    `  verify-attest: ${r.verdict}`,
    `  scheme:           ${r.scheme}`,
    `  recovered signer: ${r.recoveredSigner}  (from the embedded canonical bytes + signature)`,
    `  claimed signer:   ${r.claimedSigner}  (the container's \`signer\` field)`,
  ];
  lines.push(
    `  [${r.checks.signatureMatchesSigner ? "PASS" : "FAIL"}] signature recovers to the claimed signer`
  );
  if (r.checks.signerMatchesExpected === null) {
    lines.push("  [skip] expected-signer pin: not requested (pass --signer <addr> to pin the sender)");
  } else {
    lines.push(
      `  [${r.checks.signerMatchesExpected ? "PASS" : "FAIL"}] recovered signer matches the expected ` +
        `sender (${r.expectedSigner})`
    );
  }
  if (r.checks.manifestBindsAttestation === null) {
    lines.push(
      "  [skip] parcel binding: not requested (pass --manifest <m> to bind the signature to YOUR parcel)"
    );
  } else {
    lines.push(
      `  [${r.checks.manifestBindsAttestation ? "PASS" : "FAIL"}] the signature binds YOUR parcel ` +
        "(its canonical bytes are byte-identical to the signed payload)"
    );
  }
  if (r.accepted) {
    lines.push("  ACCEPTED: every requested check passed.");
  } else {
    lines.push(`  REJECTED: failed check(s): ${r.failedChecks.join(", ")}.`);
    if (r.failedChecks.includes("manifestBindsAttestation")) {
      lines.push(
        "    binding-mismatch: the signed payload does NOT match YOUR parcel — the signature vouches for a"
      );
      lines.push("    DIFFERENT parcel identity than the one you hold.");
    }
  }
  return lines;
}

/**
 * Orchestrate `vh parcel verify-attest <signed> [--manifest <m>] [--signer <addr>] [--json]`. Reads the
 * signed container via the strict `readSignedParcelAttestation` (a malformed/edited/foreign — e.g. a DATASET
 * signed — container is rejected, never half-accepted) and, when given, the recipient's manifest via the
 * strict `readParcelManifest`, then runs the PURE `verifySignedParcelAttestation`. Emits the verdict as a
 * human block (LEADS with the trust caveat) or a `--json` machine-readable object. PURELY OFFLINE.
 *
 * @param {object} opts
 * @param {string} opts.signed     path to a signed parcel-attestation container
 * @param {string} [opts.manifest] OPTIONAL path to the recipient's parcel manifest (binds the signature to it)
 * @param {string} [opts.signer]   OPTIONAL expected sender 0x-address to pin
 * @param {boolean}[opts.json]     emit the machine-readable verdict instead of the human block
 * @param {(s:string)=>void}[opts.stdout] sink for stdout (default process.stdout.write); injectable for tests
 * @returns {object} the object verifySignedParcelAttestation returns
 */
function runParcelVerifyAttest(opts) {
  if (!opts || typeof opts !== "object") throw new Error("runParcelVerifyAttest requires options");
  const { signed: signedPath, manifest: manifestPath, signer: expectedSigner } = opts;
  const write = opts.stdout || ((s) => process.stdout.write(s));
  if (!signedPath) throw new Error("runParcelVerifyAttest requires a <signed> path");

  // Strict read: a malformed/edited/foreign signed container is rejected here, never half-accepted, BEFORE
  // any recovery is attempted. (Also re-validates the embedded UNSIGNED payload, scheme, signer, sig shape.)
  const container = readSignedParcelAttestation(signedPath);

  // OPTIONAL: read the recipient's parcel manifest strictly so the binding check recomputes canonical bytes
  // from a sound manifest (a corrupt/foreign manifest is rejected).
  let manifest;
  if (manifestPath !== undefined && manifestPath !== null) {
    manifest = readParcelManifest(manifestPath);
  }

  const result = verifySignedParcelAttestation({ container, expectedSigner, manifest });

  if (opts.json) {
    write(JSON.stringify(result) + "\n");
  } else {
    for (const line of formatParcelVerifyAttest(result)) write(line + "\n");
  }
  return result;
}

module.exports = {
  PARCEL_MANIFEST_KIND,
  PARCEL_MANIFEST_SCHEMA_VERSION,
  SUPPORTED_PARCEL_MANIFEST_SCHEMA_VERSIONS,
  PARCEL_BLOCK_FIELDS,
  TRUST_NOTE,
  PARCEL_TRUST_NOTE,
  VERIFY_STATUS,
  normalizeParcelBlock,
  validateParcelBlock,
  buildParcelManifest,
  validateParcelManifest,
  readParcelManifest,
  writeParcelManifest,
  runParcelBuild,
  formatParcelVerify,
  runParcelVerify,
  // attest / verify-attest (T-18.3) — over the SAME signed-attestation core as `vh dataset`.
  PARCEL_ATTESTATION_KIND,
  PARCEL_ATTESTATION_SCHEMA_VERSION,
  SUPPORTED_PARCEL_ATTESTATION_SCHEMA_VERSIONS,
  PARCEL_ATTESTATION_TRUST_NOTE,
  SIGNED_PARCEL_ATTESTATION_KIND,
  SIGNED_PARCEL_ATTESTATION_SCHEMES,
  SIGNED_PARCEL_ATTESTATION_TRUST_NOTE,
  PARCEL_VERIFY_ATTEST_TRUST_NOTE,
  VERIFY_ATTEST_VERDICT,
  canonicalParcelFiles,
  parcelManifestDigest,
  buildParcelAttestation,
  validateParcelAttestation,
  serializeParcelAttestation,
  readParcelAttestation,
  validateSignedParcelAttestation,
  buildSignedParcelAttestation,
  serializeSignedParcelAttestation,
  readSignedParcelAttestation,
  recoverSignedParcelAttestationSigner,
  verifySignedParcelAttestation,
  formatParcelVerifyAttest,
  runParcelAttest,
  SIGN_TRUST_NOTE,
  runParcelSign,
  runParcelVerifyAttest,
};

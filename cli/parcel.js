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
const { hashDirStream } = require("./hash");
const { diffManifest } = require("./receipt");
// The GENERIC, product-agnostic provenance engine. ProofParcel is a THIN adapter over it: the manifest
// builder/validator + the TRUST caveats live ONCE in cli/core/ and are shared with DataLedger so the
// Merkle/manifest math and — critically — the TRUST_NOTE can NEVER drift between products. The dependency
// points parcel → core (never the reverse).
const coreManifest = require("./core/manifest");

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
};

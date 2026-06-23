"use strict";

// cli/dataset.js — a tamper-evident, versioned DATASET MANIFEST for verifyhash (DataLedger).
//
// WHY THIS EXISTS
//   AI/ML training-data provenance needs one portable, verifiable artifact that pins EXACTLY what a
//   dataset directory contained — byte-for-byte, including file names/paths — at the moment it was
//   manifested. `vh dataset build <dir> --out <manifest>` walks the dataset tree and writes a strict,
//   versioned JSON manifest: the Merkle ROOT plus a sorted per-file list of { relPath, contentHash,
//   leaf }, so a later reader can (a) re-derive the same root from the same tree, (b) prove any single
//   file is a member of the anchored root (the leaf is exactly what the on-chain verifyLeaf consumes),
//   and (c) detect ANY edit/rename/add/remove as a root change.
//
//   It reuses the EXISTING path-bound, domain-separated Merkle convention from cli/hash.js verbatim
//   (pathLeaf / leafHash / nodeHash, the same DIR_LEAF_DOMAIN/LEAF_TAG/NODE_TAG the contract uses) —
//   NO new hashing convention, so a dataset root is the SAME value `vh hash <dir>` and the contract's
//   verifyLeaf produce for the same tree. The only difference from `hashDir` is that the tree is built
//   by STREAMING each file (cli/hash.js › hashDirStream) so a multi-gigabyte dataset is hashed without
//   ever holding all file content in memory at once — at most one ~1 MiB chunk plus the array of
//   32-byte per-file hashes.
//
// UNTRUSTED PROVENANCE HINTS
//   A caller may attach OPTIONAL per-file { source, license } strings (where a file came from, under
//   what license). These are recorded under an explicitly-labeled `hints` object and are UNTRUSTED
//   self-asserted metadata — consistent with docs/TRUST-BOUNDARIES.md. They are NOT bound into the
//   Merkle root and prove NOTHING; editing them does not change the root. The manifest's `note` field
//   says so in-band so a downstream reader can never mistake a license hint for a verified fact.
//
// STRICTNESS
//   A corrupt/edited manifest must never be silently half-accepted: `readManifest` validates strictly
//   and throws on the FIRST deviation (wrong kind/schemaVersion, missing/!hex root, a file entry whose
//   contentHash/leaf is missing or not 0x 32-byte hex, an empty relPath, a non-array files list)
//   rather than filling defaults — mirroring cli/receipt.js and cli/proof.js. It deliberately does NOT
//   re-verify the leaves against the content (it has no content); it guarantees only that the manifest
//   is structurally sound. Re-deriving the root from the actual tree is the authoritative check.

const fs = require("fs");
const path = require("path");
const { hashDirStream, pathLeaf } = require("./hash");
const { diffManifest } = require("./receipt");

// On-disk schema discriminators. A dataset manifest carries its OWN kind + version (distinct from the
// receipt kinds in cli/receipt.js and the proof-artifact kind in cli/proof.js) so a random JSON file,
// a receipt, a proof artifact, or a future/foreign manifest is never misread as a current manifest.
const MANIFEST_KIND = "verifyhash.dataset-manifest";
const MANIFEST_SCHEMA_VERSION = 1;
const SUPPORTED_MANIFEST_SCHEMA_VERSIONS = Object.freeze([1]);

// Same hex shape cli/receipt.js / cli/proof.js validate against, so the modules never drift.
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;

// In-band note so a reader of the raw JSON cannot mistake an untrusted license hint for a fact, nor
// the root for proof of anything more than set-membership of (relPath, content) pairs.
const TRUST_NOTE =
  "The Merkle root commits to the full set of (relPath, content) pairs (names AND bytes): any edit, " +
  "rename, add, or remove changes the root. Per-file `hints` (source/license) are UNTRUSTED, " +
  "self-asserted metadata — they are NOT bound into the root and prove nothing.";

/**
 * Build a normalized, fully-validated dataset-manifest object from a streamed directory result plus
 * optional per-file hints. Throws if the result is malformed, so a corrupt manifest is never written.
 *
 * @param {{ root: string, leaves: {path:string,contentHash:string,leaf:string}[] }} built
 *        the object cli/hash.js › hashDirStream returns
 * @param {object} [opts]
 * @param {Object<string,{source?:string,license?:string}>} [opts.hints]
 *        OPTIONAL untrusted per-file hints keyed by relPath. Only `source`/`license` string fields are
 *        recorded; a hint for a relPath not present in the tree is rejected (so a typo'd path is caught
 *        rather than silently kept as dangling metadata).
 * @returns {object} a validated manifest object
 */
function buildManifest(built, opts = {}) {
  if (!built || typeof built !== "object" || !Array.isArray(built.leaves)) {
    throw new Error("buildManifest requires the object hashDirStream() returns");
  }
  const knownPaths = new Set(built.leaves.map((l) => l.path));
  const hints = _normalizeHints(opts.hints, knownPaths);

  const manifest = {
    kind: MANIFEST_KIND,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    note: TRUST_NOTE,
    root: built.root,
    fileCount: built.leaves.length,
    files: built.leaves.map((l) => {
      const entry = { relPath: l.path, contentHash: l.contentHash, leaf: l.leaf };
      // Attach the untrusted hint INLINE on the file entry (only when present) so a consumer reads
      // path/content/leaf/hint together. The hint never participates in the leaf or the root.
      const h = hints[l.path];
      if (h) entry.hints = h;
      return entry;
    }),
  };
  validateManifest(manifest);
  return manifest;
}

/**
 * Normalize raw per-file hints into a { relPath -> {source?,license?} } map of plain strings. Rejects
 * a hint whose relPath is not in the tree, and a non-string source/license, so junk never lands in the
 * manifest. Returns {} for absent hints.
 */
function _normalizeHints(rawHints, knownPaths) {
  if (rawHints == null) return {};
  if (typeof rawHints !== "object" || Array.isArray(rawHints)) {
    throw new Error("hints must be an object keyed by relPath");
  }
  const out = {};
  for (const [rel, h] of Object.entries(rawHints)) {
    if (!knownPaths.has(rel)) {
      throw new Error(`hint for unknown path (not in the dataset): ${JSON.stringify(rel)}`);
    }
    if (h == null || typeof h !== "object" || Array.isArray(h)) {
      throw new Error(`hint for ${JSON.stringify(rel)} must be an object with source/license`);
    }
    const entry = {};
    for (const k of ["source", "license"]) {
      if (h[k] === undefined || h[k] === null) continue;
      if (typeof h[k] !== "string") {
        throw new Error(`hint ${k} for ${JSON.stringify(rel)} must be a string`);
      }
      entry[k] = h[k];
    }
    // Only record a hint that actually carries at least one labeled field.
    if (Object.keys(entry).length > 0) out[rel] = entry;
  }
  return out;
}

/**
 * Strictly validate a parsed dataset-manifest object. Throws an Error describing the FIRST problem.
 * Never mutates and never fills defaults — a manifest either is complete and well-formed or it is
 * rejected outright (mirroring cli/proof.js › _validate). A wrong kind/schemaVersion, a missing/!hex
 * root, or any file entry with a missing/!hex contentHash/leaf or empty relPath hard-errors here.
 * @param {any} obj
 * @returns {object} the same object, if valid
 */
function validateManifest(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("dataset manifest must be a JSON object");
  }
  if (obj.kind !== MANIFEST_KIND) {
    throw new Error(
      `not a verifyhash dataset manifest (kind: ${JSON.stringify(obj.kind)}; expected ${JSON.stringify(
        MANIFEST_KIND
      )})`
    );
  }
  if (!SUPPORTED_MANIFEST_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new Error(
      `unsupported dataset manifest schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(SUPPORTED_MANIFEST_SCHEMA_VERSIONS)})`
    );
  }
  if (typeof obj.root !== "string" || !HEX32_RE.test(obj.root)) {
    throw new Error(
      `dataset manifest root must be a 0x-prefixed 32-byte hex string, got: ${String(obj.root)}`
    );
  }
  if (!Array.isArray(obj.files)) {
    throw new Error("dataset manifest field files must be an array");
  }
  if (obj.files.length === 0) {
    throw new Error("dataset manifest files must be non-empty (a manifest over zero files is invalid)");
  }
  // fileCount, when present, must agree with the files array (catch a hand-edited count).
  if (obj.fileCount !== undefined && obj.fileCount !== obj.files.length) {
    throw new Error(
      `dataset manifest fileCount (${String(obj.fileCount)}) does not match files length (${obj.files.length})`
    );
  }

  const seen = new Set();
  obj.files.forEach((entry, i) => {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`dataset manifest files[${i}] must be an object`);
    }
    if (typeof entry.relPath !== "string" || entry.relPath.length === 0) {
      throw new Error(
        `dataset manifest files[${i}].relPath must be a non-empty string, got: ${String(entry.relPath)}`
      );
    }
    if (seen.has(entry.relPath)) {
      throw new Error(`dataset manifest has a duplicate relPath: ${JSON.stringify(entry.relPath)}`);
    }
    seen.add(entry.relPath);
    for (const f of ["contentHash", "leaf"]) {
      if (typeof entry[f] !== "string" || !HEX32_RE.test(entry[f])) {
        throw new Error(
          `dataset manifest files[${i}].${f} must be a 0x-prefixed 32-byte hex string, got: ${String(
            entry[f]
          )}`
        );
      }
    }
    // The leaf MUST be the path-bound digest of (relPath, contentHash) — re-derive it and reject a
    // manifest whose leaf was tampered with independently of its relPath/contentHash. This is a
    // structural self-consistency check (no content needed): it binds the three fields together so an
    // edited leaf (or relPath, or contentHash) is caught here rather than producing a false proof.
    const expectedLeaf = pathLeaf(entry.relPath, entry.contentHash);
    if (entry.leaf.toLowerCase() !== expectedLeaf.toLowerCase()) {
      throw new Error(
        `dataset manifest files[${i}].leaf is inconsistent with its relPath+contentHash ` +
          `(expected ${expectedLeaf}, got ${entry.leaf})`
      );
    }
    // Optional hint shape, when present.
    if (entry.hints !== undefined && entry.hints !== null) {
      if (typeof entry.hints !== "object" || Array.isArray(entry.hints)) {
        throw new Error(`dataset manifest files[${i}].hints must be an object when present`);
      }
      for (const k of ["source", "license"]) {
        if (entry.hints[k] !== undefined && typeof entry.hints[k] !== "string") {
          throw new Error(`dataset manifest files[${i}].hints.${k} must be a string when present`);
        }
      }
    }
  });

  return obj;
}

/**
 * Read, parse, and STRICTLY validate the manifest at `manifestPath`. Throws on a missing file, invalid
 * JSON, or ANY schema deviation (so a malformed/edited manifest is rejected, never half-accepted).
 * @param {string} manifestPath
 * @returns {object} the validated manifest object
 */
function readManifest(manifestPath) {
  if (!manifestPath || typeof manifestPath !== "string") {
    throw new Error("readManifest requires a manifest file path");
  }
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch (e) {
    throw new Error(`cannot read dataset manifest at ${manifestPath}: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`dataset manifest at ${manifestPath} is not valid JSON: ${e.message}`);
  }
  return validateManifest(obj);
}

/**
 * Validate and write a dataset manifest to `outPath` as pretty JSON + a trailing newline. The ONLY
 * side effect is the file write at the caller-chosen path (never silently the cwd), and it throws
 * (before writing) if the object is not a valid manifest, so a corrupt manifest never lands on disk.
 * @param {object} obj     a manifest (typically from buildManifest)
 * @param {string} outPath destination file path (caller-chosen)
 * @returns {object} the validated object that was written
 */
function writeManifest(obj, outPath) {
  if (!outPath || typeof outPath !== "string") {
    throw new Error("writeManifest requires an --out path");
  }
  validateManifest(obj);
  fs.writeFileSync(outPath, JSON.stringify(obj, null, 2) + "\n");
  return obj;
}

/**
 * Orchestrate `vh dataset build <dir> --out <manifest>`: stream-hash the dataset tree, build the
 * manifest (with optional untrusted hints), write it to the caller's --out path, and return a small
 * summary. Writes ONLY to `outPath` — no cwd litter.
 *
 * @param {object} opts
 * @param {string} opts.dir     dataset directory to manifest
 * @param {string} opts.out     where to write the manifest (REQUIRED — never defaulted to cwd)
 * @param {Object<string,{source?:string,license?:string}>} [opts.hints] optional untrusted hints
 * @param {boolean} [opts.json] emit machine-readable JSON instead of the human summary
 * @param {(s:string)=>void} [opts.stdout] sink for stdout (default process.stdout.write); injectable for tests
 * @returns {{ root: string, fileCount: number, out: string }}
 */
function runDatasetBuild(opts) {
  if (!opts || typeof opts !== "object") throw new Error("runDatasetBuild requires options");
  const { dir, out, hints } = opts;
  const write = opts.stdout || ((s) => process.stdout.write(s));
  if (!dir) throw new Error("runDatasetBuild requires a dataset <dir>");
  if (!out) throw new Error("runDatasetBuild requires an --out <manifest> path");

  // Resolve to an absolute path so the manifest is written EXACTLY where the caller asked, regardless
  // of cwd. statSync errors clearly (ENOENT / not a dir) before we walk anything.
  const dirAbs = path.resolve(dir);
  const stat = fs.statSync(dirAbs);
  if (!stat.isDirectory()) {
    throw new Error(`dataset target is not a directory: ${dir}`);
  }
  const outAbs = path.resolve(out);

  const built = hashDirStream(dirAbs); // streams each file; never loads all content at once
  const manifest = buildManifest(built, { hints });
  writeManifest(manifest, outAbs);

  if (opts.json) {
    write(
      JSON.stringify({ root: manifest.root, fileCount: manifest.fileCount, out: outAbs }) + "\n"
    );
  } else {
    write(`dataset manifest written: ${outAbs}\n`);
    write(`  root:  ${manifest.root}\n`);
    write(`  files: ${manifest.fileCount}\n`);
    write(
      "  NOTE: the root commits to file names AND bytes; per-file source/license hints are UNTRUSTED.\n"
    );
  }
  return { root: manifest.root, fileCount: manifest.fileCount, out: outAbs };
}

// Possible outcomes of a `vh dataset verify` run. The AUTHORITATIVE verdict is recomputed-root vs
// manifest-root — never the per-file diff (which only LOCALIZES which file moved).
const VERIFY_STATUS = Object.freeze({
  MATCH: "MATCH", // root re-derived from the FRESH tree equals the manifest's recorded root
  MISMATCH: "MISMATCH", // it does NOT — a file was added/removed/changed/renamed since the manifest
});

/**
 * Re-derive the dataset root from a FRESH copy of the dataset at `dir` and compare it to the
 * (UNTRUSTED) manifest's recorded root, then localize any divergence to specific files.
 *
 * TRUST POSTURE (docs/TRUST-BOUNDARIES.md). The manifest is an UNTRUSTED hint: the AUTHORITATIVE
 * MATCH/MISMATCH is `recomputed-root === manifest-root`, recomputed here from the actual bytes on
 * disk via the SAME path-bound Merkle convention `vh hash <dir>` and the on-chain verifyLeaf use.
 * The per-file ADDED/REMOVED/CHANGED diff is a CONVENIENCE that says WHICH file diverged; it never
 * decides the verdict (so even a manifest with a hand-edited `root` cannot fake a MATCH — the root
 * is recomputed, not read from the manifest). This is fully OFFLINE: no provider, no key, no network.
 *
 * The diff reuses the SAME receipt-manifest diff core (`cli/receipt.js › diffManifest`, the function
 * `cli/verify.js` uses for its `--receipt` directory diff): a `CHANGED` entry carries old→new
 * `contentHash`, exactly like the verify path. A rename surfaces as one REMOVED (old path) + one
 * ADDED (new path), because the path is bound into the leaf — the root commits to file NAMES too.
 *
 * @param {object} opts
 * @param {string} opts.dir       dataset directory to re-derive the root from (the FRESH copy)
 * @param {string} opts.manifest  path to a manifest written by `vh dataset build` (UNTRUSTED hint)
 * @param {boolean}[opts.json]    emit a machine-readable JSON object instead of the human block
 * @param {(s:string)=>void}[opts.stdout] sink for stdout (default process.stdout.write); injectable for tests
 * @returns {{
 *   status: "MATCH"|"MISMATCH",
 *   recomputedRoot: string,
 *   manifestRoot: string,
 *   fileCount: number,
 *   diff: { added: any[], removed: any[], changed: any[], unchanged: any[], identical: boolean }
 * }}
 */
function runDatasetVerify(opts) {
  if (!opts || typeof opts !== "object") throw new Error("runDatasetVerify requires options");
  const { dir, manifest: manifestPath } = opts;
  const write = opts.stdout || ((s) => process.stdout.write(s));
  if (!dir) throw new Error("runDatasetVerify requires a dataset <dir>");
  if (!manifestPath) throw new Error("runDatasetVerify requires a --manifest <p> path");

  // Resolve so we read EXACTLY where the caller asked regardless of cwd. statSync errors clearly
  // (ENOENT / not a dir) before we walk anything — and BEFORE we trust the manifest at all.
  const dirAbs = path.resolve(dir);
  const stat = fs.statSync(dirAbs);
  if (!stat.isDirectory()) {
    throw new Error(`dataset target is not a directory: ${dir}`);
  }

  // The manifest is an untrusted hint, but it must be STRUCTURALLY sound or we cannot diff against it
  // (readManifest rejects a corrupt/edited manifest rather than half-accepting it).
  const manifest = readManifest(manifestPath);

  // Re-derive the root + per-file leaves from the FRESH tree (streamed; never loads all content).
  const built = hashDirStream(dirAbs);
  const recomputedRoot = built.root;
  const manifestRoot = manifest.root;

  // AUTHORITATIVE verdict: recomputed root vs manifest root. Case-insensitive hex compare (both are
  // 0x-prefixed lowercase here, but never let a case difference flip the verdict).
  const status =
    recomputedRoot.toLowerCase() === manifestRoot.toLowerCase()
      ? VERIFY_STATUS.MATCH
      : VERIFY_STATUS.MISMATCH;

  // Localize WHICH file diverged using the SAME diff core cli/verify.js uses for its --receipt diff.
  // The manifest entries are keyed by `relPath`; diffManifest expects `path`, so map across (the leaf
  // is what diffManifest compares, so a swapped file shows as CHANGED and a rename as REMOVED+ADDED).
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
        diff,
      }) + "\n"
    );
  } else {
    for (const line of formatDatasetVerify({ status, recomputedRoot, manifestRoot, diff })) {
      write(line + "\n");
    }
  }
  return { status, recomputedRoot, manifestRoot, fileCount: built.leaves.length, diff };
}

/**
 * Render a dataset-verify result as the human-readable block the CLI prints. Leads with the
 * authoritative root comparison, then the per-file diff (labeled as localization, never the verdict).
 * @param {{status:string,recomputedRoot:string,manifestRoot:string,diff:object}} r
 * @returns {string[]} lines
 */
function formatDatasetVerify(r) {
  const lines = [
    `  dataset verify: ${r.status}`,
    `  recomputed root: ${r.recomputedRoot}  (re-derived from the files on disk — AUTHORITATIVE)`,
    `  manifest root:   ${r.manifestRoot}  (untrusted hint)`,
  ];
  if (r.status === VERIFY_STATUS.MATCH) {
    lines.push(
      "  The dataset is byte-for-byte (and name-for-name) what the manifest committed to."
    );
  } else {
    lines.push(
      "  The dataset does NOT match the manifest: a file was added, removed, changed, or renamed",
      "  since the manifest was built (the root commits to file NAMES and bytes)."
    );
  }
  const d = r.diff;
  lines.push("", "  --- per-file diff (localization; the root comparison above is the verdict) ---");
  if (d.identical) {
    lines.push("  files: IDENTICAL — every file matches the manifest (no ADDED/REMOVED/CHANGED).");
    return lines;
  }
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
  return lines;
}

module.exports = {
  MANIFEST_KIND,
  MANIFEST_SCHEMA_VERSION,
  SUPPORTED_MANIFEST_SCHEMA_VERSIONS,
  TRUST_NOTE,
  VERIFY_STATUS,
  buildManifest,
  validateManifest,
  readManifest,
  writeManifest,
  runDatasetBuild,
  runDatasetVerify,
  formatDatasetVerify,
};

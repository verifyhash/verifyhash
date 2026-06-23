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
const { hashDirStream, hashFileStream, pathLeaf, buildTree, proofForIndex } = require("./hash");
const { diffManifest } = require("./receipt");
const {
  buildProofArtifact,
  writeProofArtifact,
  readProofArtifact,
  recomputeFold,
} = require("./proof");

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

// =================================================================================================
// `vh dataset diff <manifestA> <manifestB>` — OFFLINE manifest-to-manifest change report.
//
// WHY THIS EXISTS
//   `vh dataset verify` answers "does this manifest still match the live tree on disk?". But a CI
//   pipeline (or a data scientist comparing two dataset SNAPSHOTS) often holds TWO manifests and no
//   tree at all, and wants to answer "what changed between version A and version B of the training
//   set?" — purely from the two portable artifacts, with NO dataset copy, NO provider, NO key, NO
//   network. `vh dataset diff A B` reads both via the SAME strict `readManifest` (a corrupt/edited
//   manifest is rejected, never half-accepted) and computes the change set by REUSING the EXACT diff
//   core `vh dataset verify` uses — `cli/receipt.js › diffManifest` — verbatim. NO new diff logic.
//
//   The diff compares what each manifest CLAIMS; it does NOT re-derive content (there is no tree to
//   read). To actually re-derive a root from bytes, run `vh dataset verify` against the live tree.
//
// EXIT CODES (mirror the dataset family): 0 when the two manifests are IDENTICAL, 3 when they DIFFER
//   (so a pipeline can `fail if the training set changed unexpectedly`), 2 usage, 1 runtime.

/**
 * Compute (purely, OFFLINE) the change set between two dataset manifests A and B. Reads both via the
 * strict `readManifest` (so a corrupt/foreign manifest is rejected) and diffs them by REUSING
 * `cli/receipt.js › diffManifest` verbatim — the SAME core `vh dataset verify` uses. The diff is
 * directional: ADDED = present in B not A, REMOVED = present in A not B, CHANGED = same relPath with a
 * different leaf (carrying old→new contentHash). A rename surfaces as REMOVED(old path) + ADDED(new
 * path) because the relPath is bound into the leaf — never as a single edit.
 *
 * @param {object} opts
 * @param {string} opts.manifestA  path to the BASELINE manifest (the "from")
 * @param {string} opts.manifestB  path to the COMPARISON manifest (the "to")
 * @param {boolean}[opts.json]     emit a machine-readable object instead of the human block
 * @param {(s:string)=>void}[opts.stdout] sink for stdout (default process.stdout.write); injectable for tests
 * @returns {{
 *   rootA: string, rootB: string, rootsIdentical: boolean, identical: boolean,
 *   added: any[], removed: any[], changed: any[], unchanged: any[],
 *   counts: { added: number, removed: number, changed: number, unchanged: number }
 * }}
 */
function runDatasetDiff(opts) {
  if (!opts || typeof opts !== "object") throw new Error("runDatasetDiff requires options");
  const { manifestA, manifestB } = opts;
  const write = opts.stdout || ((s) => process.stdout.write(s));
  if (!manifestA) throw new Error("runDatasetDiff requires a <manifestA> path");
  if (!manifestB) throw new Error("runDatasetDiff requires a <manifestB> path");

  // Strict reads: a corrupt/edited/foreign manifest is rejected here, never half-accepted, BEFORE any
  // diff is attempted. Both must be structurally sound (every leaf == pathLeaf(relPath, contentHash)).
  const a = readManifest(manifestA);
  const b = readManifest(manifestB);

  const rootA = a.root;
  const rootB = b.root;
  // The two roots, recorded in the manifests, are DISPLAYED metadata only. readManifest validates that
  // every leaf == pathLeaf(relPath, contentHash) and the fileCount, but it does NOT re-derive
  // root == merkleRoot(leaves) (that only happens in `dataset verify` against a live tree). So a
  // hand-edited `root` could disagree with the leaves it claims to summarize. We therefore do NOT let
  // root-string equality decide the verdict — see `identical` below.
  const rootsIdentical = rootA.toLowerCase() === rootB.toLowerCase();

  // Map each manifest's `files` (relPath→path) into the shape diffManifest expects, then REUSE the
  // SAME diff core verbatim. A is the baseline ("recorded"), B is the comparison ("current"): so
  // diffManifest's ADDED = in B not A, REMOVED = in A not B, CHANGED = same relPath, different leaf.
  const aManifest = a.files.map((f) => ({
    path: f.relPath,
    contentHash: f.contentHash,
    leaf: f.leaf,
  }));
  const bManifest = b.files.map((f) => ({
    path: f.relPath,
    contentHash: f.contentHash,
    leaf: f.leaf,
  }));
  const diff = diffManifest(aManifest, bManifest);

  // AUTHORITATIVE verdict (and thus exit code + IDENTICAL/DIFFERENT headline) is the CHANGE SET, not
  // root-string equality. diffManifest already returns `identical` (true iff there is no ADDED /
  // REMOVED / CHANGED) from the per-file LEAVES — the same data the printed/JSON changeset is built
  // from. Deriving the verdict from the changeset guarantees the exit code, the headline, and the body
  // can never disagree: a manifest with a hand-edited `root` (whose leaves are unchanged) still reports
  // IDENTICAL with exit 0 and an empty changeset, instead of a DIFFERENT verdict that contradicts a
  // "+0 / -0 / ~0" body. rootA/rootB/rootsIdentical remain DISPLAYED metadata.
  const identical = diff.identical;

  const counts = {
    added: diff.added.length,
    removed: diff.removed.length,
    changed: diff.changed.length,
    unchanged: diff.unchanged.length,
  };

  if (opts.json) {
    write(
      JSON.stringify({
        rootA,
        rootB,
        rootsIdentical,
        identical,
        added: diff.added,
        removed: diff.removed,
        changed: diff.changed,
        unchanged: diff.unchanged,
        counts,
      }) + "\n"
    );
  } else {
    for (const line of formatDatasetDiff({ rootA, rootB, rootsIdentical, identical, diff, counts })) {
      write(line + "\n");
    }
  }

  return {
    rootA,
    rootB,
    rootsIdentical,
    identical,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
    unchanged: diff.unchanged,
    counts,
  };
}

/**
 * Render a dataset-diff result as the human-readable block the CLI prints. Leads with the one-line
 * TRUST note (reusing the dataset TRUST_NOTE wording), states whether the roots are IDENTICAL or
 * DIFFERENT, prints the precise per-file ADDED/REMOVED/CHANGED set with a count line, and states that
 * a rename surfaces as REMOVED+ADDED (so it is not mistaken for two unrelated edits).
 * The headline (IDENTICAL vs DIFFERENT) is driven by `identical` — the CHANGE SET, not root-string
 * equality — so it can never contradict the per-file body or the exit code. rootA/rootB and whether the
 * raw root STRINGS matched are printed as metadata; if they disagree with the change set (a hand-edited
 * `root` whose leaves are unchanged) the discrepancy is called out explicitly rather than letting it
 * silently flip the verdict.
 * @param {{rootA:string,rootB:string,rootsIdentical:boolean,identical:boolean,diff:object,counts:object}} r
 * @returns {string[]} lines
 */
function formatDatasetDiff(r) {
  const lines = [
    // TRUST note FIRST: a diff compares what each manifest CLAIMS; it does not re-derive content.
    "  TRUST: this compares what each manifest CLAIMS — it does NOT re-derive content. " + TRUST_NOTE,
    "         (run `vh dataset verify` against the live tree to re-derive a root from bytes).",
    "",
    `  manifest A root: ${r.rootA}`,
    `  manifest B root: ${r.rootB}`,
  ];
  if (r.identical) {
    lines.push(
      "  files: IDENTICAL — the two manifests commit to the SAME set of (relPath, content) pairs;",
      "         the file sets are identical (no ADDED / REMOVED / CHANGED).",
      `  +0 / -0 / ~0 / ${r.counts.unchanged} unchanged`
    );
    // The verdict is the change set, not the raw root strings. If those root strings DISAGREE while the
    // file sets are identical, a `root` field was hand-edited (readManifest does not re-derive
    // root-over-leaves); flag it so a reader is not surprised by mismatched root lines above.
    if (!r.rootsIdentical) {
      lines.push(
        "  NOTE: the two manifests' recorded `root` fields DIFFER even though their file sets are",
        "        identical — a `root` was hand-edited (a manifest's root is not re-derived from its",
        "        leaves on read). Run `vh dataset verify` against the live tree to re-derive a root.",
        "        The IDENTICAL verdict above is the file-set change set, which is authoritative here."
      );
    }
    return lines;
  }
  lines.push(
    "  files: DIFFERENT — the manifests commit to different (relPath, content) sets. Per-file changes",
    "         (A→B). A rename surfaces as REMOVED(old path) + ADDED(new path) — the path is bound into",
    "         the leaf — NOT as two unrelated edits.",
    `  +${r.counts.added} / -${r.counts.removed} / ~${r.counts.changed} / ${r.counts.unchanged} unchanged`
  );
  for (const c of r.diff.changed) {
    lines.push(`    CHANGED  ${c.path}`);
    lines.push(`               old: ${c.oldContentHash}`);
    lines.push(`               new: ${c.newContentHash}`);
  }
  for (const a of r.diff.added) {
    lines.push(`    ADDED    ${a.path}  (${a.contentHash})   in B, not in A`);
  }
  for (const rm of r.diff.removed) {
    lines.push(`    REMOVED  ${rm.path}  (${rm.contentHash})   in A, not in B`);
  }
  return lines;
}

// =================================================================================================
// `vh dataset summary <manifest> [--json]` — provenance/license roll-up the due-diligence reviewer reads.
//
// WHY THIS EXISTS
//   A compliance/due-diligence reviewer holding a manifest wants a one-glance aggregate: how many files,
//   what root, and a histogram of the self-asserted {source, license} hints — "what does this dataset
//   CLAIM about where its files came from and under what license?". This is PURELY OFFLINE: it reads the
//   manifest via the SAME strict `readManifest` (a corrupt/foreign manifest is rejected) and counts what
//   the manifest records. NO dataset tree, NO provider, NO key, NO network.
//
// TRUST POSTURE (carried verbatim into output). The file SET (relPath + content) is bound into the root
//   and is trustworthy; the {source, license} hints are UNTRUSTED, self-asserted metadata NOT bound into
//   the root. The summary counts what the dataset CLAIMS — it does NOT verify any license/source is
//   correct. A file with NO license hint lands in the explicit "(no license hint)" bucket: that means the
//   manifest ASSERTS NOTHING, not that the file is unlicensed.

// Explicit bucket labels for files that carry no hint, so the histogram never silently drops them and a
// reader can never mistake "no claim" for a real license/source value.
const NO_LICENSE_BUCKET = "(no license hint)";
const NO_SOURCE_BUCKET = "(no source hint)";

/**
 * Compute (purely, OFFLINE) the provenance/license roll-up over a manifest's TRUSTED file set. Reads the
 * manifest via the strict `readManifest` (so a corrupt/foreign manifest is rejected, never half-accepted)
 * and aggregates the per-file {source, license} hints into histograms. Files with no license hint are
 * counted under NO_LICENSE_BUCKET, files with no source hint under NO_SOURCE_BUCKET — never dropped.
 *
 * The hints are UNTRUSTED self-asserted metadata (NOT bound into the root); this counts CLAIMS, it does
 * not verify them. NO dataset tree, NO provider, NO key, NO network.
 *
 * @param {object} opts
 * @param {string} opts.manifest  path to a manifest written by `vh dataset build`
 * @param {boolean}[opts.json]    emit a machine-readable object instead of the human block
 * @param {(s:string)=>void}[opts.stdout] sink for stdout (default process.stdout.write); injectable for tests
 * @returns {{
 *   root: string,
 *   fileCount: number,
 *   licenses: Object<string,number>,
 *   sources: Object<string,number>,
 *   filesWithLicenseHint: number,
 *   filesWithSourceHint: number,
 * }}
 */
/**
 * PURE aggregation core shared by `vh dataset summary` AND `vh dataset report`: given a validated
 * manifest object, roll up the (UNTRUSTED) per-file {source, license} hints into histograms + counts.
 * This is the SINGLE source of truth for the roll-up math, so `vh dataset report`'s histogram can never
 * diverge from `vh dataset summary`'s (same buckets, same counts). It takes an already-validated
 * manifest object (no I/O) and never mutates it.
 *
 * @param {object} manifest a manifest object that has passed validateManifest/readManifest
 * @returns {{
 *   root: string, fileCount: number,
 *   licenses: Object<string,number>, sources: Object<string,number>,
 *   filesWithLicenseHint: number, filesWithSourceHint: number,
 * }}
 */
function aggregateManifest(manifest) {
  // Aggregate the UNTRUSTED hints. A file with no `hints.license` (or no hints at all) is counted under
  // the explicit no-hint bucket; ditto for source. We never silently omit a file from either histogram,
  // so the per-histogram counts always sum to fileCount.
  const licenses = {};
  const sources = {};
  let filesWithLicenseHint = 0;
  let filesWithSourceHint = 0;
  for (const f of manifest.files) {
    const license =
      f.hints && typeof f.hints.license === "string" ? f.hints.license : null;
    const source = f.hints && typeof f.hints.source === "string" ? f.hints.source : null;
    const licenseKey = license === null ? NO_LICENSE_BUCKET : license;
    const sourceKey = source === null ? NO_SOURCE_BUCKET : source;
    licenses[licenseKey] = (licenses[licenseKey] || 0) + 1;
    sources[sourceKey] = (sources[sourceKey] || 0) + 1;
    if (license !== null) filesWithLicenseHint++;
    if (source !== null) filesWithSourceHint++;
  }

  return {
    root: manifest.root,
    // Derive fileCount from the TRUSTED files array (not the OPTIONAL manifest.fileCount passthrough): a
    // valid third-party manifest may omit fileCount, and this keeps the field always present and always
    // self-consistent with the histograms (which sum to manifest.files.length). Mirrors runDatasetVerify.
    fileCount: manifest.files.length,
    licenses,
    sources,
    filesWithLicenseHint,
    filesWithSourceHint,
  };
}

function runDatasetSummary(opts) {
  if (!opts || typeof opts !== "object") throw new Error("runDatasetSummary requires options");
  const { manifest: manifestPath } = opts;
  const write = opts.stdout || ((s) => process.stdout.write(s));
  if (!manifestPath) throw new Error("runDatasetSummary requires a <manifest> path");

  // Strict read: a corrupt/edited/foreign manifest is rejected here, never half-accepted, BEFORE any
  // aggregation. The file SET it commits to is the TRUSTED basis of the roll-up.
  const manifest = readManifest(manifestPath);

  // The roll-up math lives in the SHARED pure aggregator so summary and report can never diverge.
  const result = aggregateManifest(manifest);

  if (opts.json) {
    write(JSON.stringify(result) + "\n");
  } else {
    for (const line of formatDatasetSummary(result)) {
      write(line + "\n");
    }
  }
  return result;
}

/**
 * Render a dataset-summary result as the human-readable block the CLI prints. LEADS with the trust caveat
 * (reusing the dataset TRUST_NOTE wording): the file SET is bound into the root and trustworthy; the
 * {source, license} hints are UNTRUSTED — the summary counts what the dataset CLAIMS, it does not verify
 * any license/source is correct. States plainly that "(no license hint)" means the manifest asserts
 * nothing, not that the file is unlicensed.
 * @param {{root:string,fileCount:number,licenses:object,sources:object,filesWithLicenseHint:number,filesWithSourceHint:number}} r
 * @returns {string[]} lines
 */
function formatDatasetSummary(r) {
  const lines = [
    // TRUST caveat FIRST: this counts CLAIMS, not verified facts.
    "  TRUST: the file SET (relPath + content) is bound into the root and is trustworthy. " + TRUST_NOTE,
    "         This summary counts what the dataset CLAIMS — it does NOT verify any license/source is",
    "         correct. \"(no license hint)\" means the manifest ASSERTS NOTHING for that file, NOT that",
    "         the file is unlicensed; likewise \"(no source hint)\".",
    "",
    `  root:  ${r.root}`,
    `  files: ${r.fileCount}`,
    "",
    `  licenses (CLAIMED; ${r.filesWithLicenseHint}/${r.fileCount} files carry a license hint):`,
  ];
  for (const line of _histogramLines(r.licenses)) lines.push(line);
  lines.push(
    "",
    `  sources (CLAIMED; ${r.filesWithSourceHint}/${r.fileCount} files carry a source hint):`
  );
  for (const line of _histogramLines(r.sources)) lines.push(line);
  return lines;
}

/**
 * Render a histogram { value -> count } as sorted, aligned lines. Real values are listed first (sorted by
 * descending count, then by value for a stable order); a no-hint bucket, if present, is listed LAST so a
 * reader sees the asserted values before the "no claim" tally.
 */
function _histogramLines(hist) {
  const entries = Object.entries(hist);
  const isNoHint = (k) => k === NO_LICENSE_BUCKET || k === NO_SOURCE_BUCKET;
  entries.sort((a, b) => {
    const an = isNoHint(a[0]);
    const bn = isNoHint(b[0]);
    if (an !== bn) return an ? 1 : -1; // no-hint bucket always last
    if (b[1] !== a[1]) return b[1] - a[1]; // higher count first
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; // then stable by value
  });
  if (entries.length === 0) return ["    (no files)"];
  return entries.map(([value, count]) => `    ${String(count).padStart(6)}  ${value}`);
}

// =================================================================================================
// `vh dataset report <manifest> [--verify <dir>] [--json] [--out <p>]` — ONE self-contained,
// deterministic evidence document a compliance/due-diligence reviewer files.
//
// WHY THIS EXISTS
//   A reviewer (or an automated compliance pipeline) needs ONE portable artifact that consolidates
//   everything a manifest already proves: the dataset IDENTITY (root + fileCount), the provenance/
//   license roll-up, the standing trust caveats, and — optionally — a live-tree verification verdict.
//   Today that takes several commands (`vh dataset summary`, `vh dataset verify`); `vh dataset report`
//   produces the single document to attach to a filing.
//
//   IT INVENTS NO NEW MATH. The dataset identity comes from the strict `readManifest`; the
//   provenance/license roll-up REUSES the SAME pure `aggregateManifest` core `vh dataset summary` uses
//   (the histogram orders identically via `_histogramLines`); the optional verification REUSES
//   `runDatasetVerify` VERBATIM. So the report can never drift from the commands it consolidates.
//
//   PURELY OFFLINE for the manifest-only path: no dataset tree, no provider, no key, no network. With
//   `--verify <dir>` it re-derives the root from the live tree (still offline — no network) and embeds
//   the MATCH/MISMATCH verdict + per-file ADDED/REMOVED/CHANGED localization.
//
// DETERMINISM
//   The default human output is a Markdown document with a STABLE section order and a histogram ordered
//   by the SAME `_histogramLines` rule, so two runs over the same manifest produce byte-identical
//   Markdown — suitable to attach to a filing and to diff in CI.

/**
 * Build (purely) the consolidated report MODEL from a validated manifest object + an OPTIONAL verify
 * result. No I/O, no aggregation math of its own — it composes `aggregateManifest`'s roll-up with the
 * (already-run) `runDatasetVerify` result. This is the SAME object the `--json` mode emits.
 *
 * @param {object} manifest a validated manifest object (from readManifest)
 * @param {object|null} [verifyResult] the object runDatasetVerify returns, or null when no --verify
 * @returns {{
 *   root: string, fileCount: number,
 *   licenses: Object<string,number>, sources: Object<string,number>,
 *   filesWithLicenseHint: number, filesWithSourceHint: number,
 *   verify?: { status: string, added: any[], removed: any[], changed: any[] }
 * }}
 */
function buildDatasetReport(manifest, verifyResult) {
  const agg = aggregateManifest(manifest); // SAME roll-up as `vh dataset summary` — never re-derived
  const model = {
    root: agg.root,
    fileCount: agg.fileCount,
    licenses: agg.licenses,
    sources: agg.sources,
    filesWithLicenseHint: agg.filesWithLicenseHint,
    filesWithSourceHint: agg.filesWithSourceHint,
  };
  if (verifyResult) {
    // Carry ONLY the localization arrays the report documents; the verdict is verifyResult.status,
    // which (per runDatasetVerify) is the AUTHORITATIVE recomputed-root-vs-manifest-root comparison.
    model.verify = {
      status: verifyResult.status,
      added: verifyResult.diff.added,
      removed: verifyResult.diff.removed,
      changed: verifyResult.diff.changed,
    };
  }
  return model;
}

/**
 * Render the consolidated report MODEL as a DETERMINISTIC Markdown document. Stable section order; the
 * histogram reuses `_histogramLines` so the ordering matches `vh dataset summary` exactly and two runs
 * over the same manifest produce byte-identical Markdown. LEADS with the trust posture (reusing
 * TRUST_NOTE verbatim) so the caveats can never drift, and NEVER implies a live-tree verify happened
 * when it did not.
 * @param {object} model the object buildDatasetReport returns
 * @returns {string} the full Markdown document (newline-terminated)
 */
function formatDatasetReportMarkdown(model) {
  const lines = [];
  lines.push("# verifyhash dataset report");
  lines.push("");

  // --- 1. Trust posture FIRST (reuse TRUST_NOTE verbatim; do NOT overclaim). -----------------------
  lines.push("## Trust posture");
  lines.push("");
  lines.push("The file SET (relPath + content) is bound into the Merkle root and is trustworthy.");
  lines.push(TRUST_NOTE);
  lines.push("");
  lines.push(
    "This report is NOT a timestamp: it does NOT prove the dataset is \"unaltered since date T\", nor " +
      "authorship/licensing. That time-anchored claim needs the human-owned signing/timestamp " +
      "trust-root (needs-human, P-3)."
  );
  lines.push("");

  // --- 2. Dataset identity (root + fileCount), from the strict readManifest. -----------------------
  lines.push("## Dataset identity");
  lines.push("");
  lines.push(`- root: \`${model.root}\``);
  lines.push(`- fileCount: ${model.fileCount}`);
  lines.push("");

  // --- 3. Verification status. Either the embedded --verify verdict, or a PLAIN statement that NO ---
  //         live-tree verification was performed (so the report never implies a verify that didn't run).
  lines.push("## Verification status");
  lines.push("");
  if (!model.verify) {
    lines.push(
      "NO live-tree verification was performed. The root above is the manifest's CLAIM until it is " +
        "re-derived from the live tree (run `vh dataset report <manifest> --verify <dir>`, or " +
        "`vh dataset verify <dir> --manifest <manifest>`)."
    );
  } else {
    const v = model.verify;
    lines.push(`- verdict: **${v.status}** (re-derived from the live tree — AUTHORITATIVE)`);
    if (v.status === VERIFY_STATUS.MATCH) {
      lines.push(
        "- The live tree is byte-for-byte (and name-for-name) what the manifest committed to " +
          "(no ADDED / REMOVED / CHANGED)."
      );
    } else {
      lines.push(
        `- changes: ${v.changed.length} CHANGED, ${v.added.length} ADDED, ${v.removed.length} REMOVED ` +
          "(a rename surfaces as REMOVED + ADDED — the root commits to file NAMES)."
      );
      for (const c of v.changed) {
        lines.push(`  - CHANGED \`${c.path}\``);
        lines.push(`    - old: \`${c.oldContentHash}\``);
        lines.push(`    - new: \`${c.newContentHash}\``);
      }
      for (const a of v.added) {
        lines.push(`  - ADDED \`${a.path}\` (\`${a.contentHash}\`) — present now, not in the manifest`);
      }
      for (const rm of v.removed) {
        lines.push(`  - REMOVED \`${rm.path}\` (\`${rm.contentHash}\`) — in the manifest, gone now`);
      }
    }
  }
  lines.push("");

  // --- 4. Provenance / license roll-up. SAME aggregation + SAME histogram ordering as summary. ------
  lines.push("## Provenance / license roll-up (CLAIMED — untrusted hints)");
  lines.push("");
  lines.push(
    "The {source, license} hints below are UNTRUSTED, self-asserted metadata NOT bound into the root. " +
      "This counts what the dataset CLAIMS; it does NOT verify any license/source is correct. " +
      "\"(no license hint)\" means the manifest ASSERTS NOTHING for that file, NOT that it is unlicensed."
  );
  lines.push("");
  lines.push(
    `### Licenses (${model.filesWithLicenseHint}/${model.fileCount} files carry a license hint)`
  );
  lines.push("");
  lines.push("```");
  for (const line of _histogramLines(model.licenses)) lines.push(line);
  lines.push("```");
  lines.push("");
  lines.push(
    `### Sources (${model.filesWithSourceHint}/${model.fileCount} files carry a source hint)`
  );
  lines.push("");
  lines.push("```");
  for (const line of _histogramLines(model.sources)) lines.push(line);
  lines.push("```");
  lines.push("");

  // Trailing newline so the document ends cleanly; join with \n for byte-stable output.
  return lines.join("\n") + "\n";
}

/**
 * Orchestrate `vh dataset report <manifest> [--verify <dir>] [--json] [--out <p>]`. Reads the manifest
 * via the strict `readManifest`, OPTIONALLY runs `runDatasetVerify` against a live tree (REUSED
 * verbatim), composes the consolidated report MODEL (reusing `aggregateManifest`), and emits it as
 * deterministic Markdown (default) or a machine-readable JSON object (`--json`). With `--out <p>` it
 * writes the report to the caller's EXPLICIT path (never cwd) and names the file; without `--out` it
 * prints to stdout.
 *
 * @param {object} opts
 * @param {string} opts.manifest  path to a manifest written by `vh dataset build`
 * @param {string} [opts.verifyDir] when given, re-derive the root from this live tree (reuses runDatasetVerify)
 * @param {boolean}[opts.json]    emit a machine-readable object instead of the Markdown document
 * @param {string} [opts.out]     write the report to this explicit path (caller-chosen; never cwd)
 * @param {(s:string)=>void}[opts.stdout] sink for stdout (default process.stdout.write); injectable for tests
 * @returns {{
 *   model: object,
 *   verifyStatus: string|null,
 *   out: string|null,
 * }}
 */
function runDatasetReport(opts) {
  if (!opts || typeof opts !== "object") throw new Error("runDatasetReport requires options");
  const { manifest: manifestPath, verifyDir } = opts;
  const write = opts.stdout || ((s) => process.stdout.write(s));
  if (!manifestPath) throw new Error("runDatasetReport requires a <manifest> path");

  // Strict read: a corrupt/edited/foreign manifest is rejected here, never half-accepted, BEFORE the
  // report is composed. The file SET it commits to is the TRUSTED basis of the document.
  const manifest = readManifest(manifestPath);

  // OPTIONAL live-tree verification: REUSE runDatasetVerify verbatim (no re-implementation). We pass a
  // no-op stdout so the verify's own block is not printed — the report embeds the verdict itself. The
  // verify recomputes the root from the bytes on disk, so a hand-edited manifest root cannot fake MATCH.
  let verifyResult = null;
  if (verifyDir) {
    verifyResult = runDatasetVerify({ dir: verifyDir, manifest: manifestPath, stdout: () => {} });
  }

  const model = buildDatasetReport(manifest, verifyResult);

  // Render the document: deterministic Markdown by default, machine-readable JSON with --json.
  const document = opts.json ? JSON.stringify(model) + "\n" : formatDatasetReportMarkdown(model);

  let outAbs = null;
  if (opts.out) {
    // Write to the EXACT caller-chosen path (resolved to absolute so the success line names precisely
    // the file written) — never silently the cwd. The ONLY side effect.
    outAbs = path.resolve(opts.out);
    fs.writeFileSync(outAbs, document);
    write(`dataset report written: ${outAbs}\n`);
  } else {
    write(document);
  }

  return {
    model,
    verifyStatus: verifyResult ? verifyResult.status : null,
    out: outAbs,
  };
}

// =================================================================================================
// `vh dataset prove --file <p> --manifest <m>`  +  `vh dataset verify-proof <proof>`
// Offline set-membership of ONE file in a manifested dataset.
//
// WHY THIS EXISTS
//   `vh dataset build` commits a whole dataset to one Merkle root + a per-file leaf list. `vh dataset
//   verify` re-derives that root from a FULL fresh copy of the dataset. But a recipient often holds
//   only ONE file (a single training image, one document) and the manifest — NOT the whole multi-GB
//   dataset — and wants to answer "was THIS exact file a member of that dataset?" without re-walking
//   the entire tree, without a network, and without any key.
//
//   `vh dataset prove` answers that by emitting a SELF-CONTAINED proof artifact: it recomputes the
//   one file's contentHash + path-bound leaf, finds that leaf in the manifest's committed leaf set,
//   and builds the Merkle proof (the sibling path) that folds the leaf back up to the manifest root —
//   reusing the EXACT buildTree/proofForIndex from cli/hash.js (the same construction `vh prove` uses)
//   and emitting the SAME `verifyhash.merkle-proof` artifact cli/proof.js reads. NO new crypto.
//
//   `vh dataset verify-proof <proof>` then folds that artifact PURELY OFFLINE via cli/proof.js's
//   recomputeFold — NO dataset copy, NO manifest, NO key, NO network — and confirms the leaf folds to
//   the recorded root. A fabricated or altered file's proof does NOT fold to the root and is REJECTED.
//
// TRUST BOUNDARY (carried verbatim into output/docs — do NOT overclaim).
//   This proves SET-MEMBERSHIP: that the named file (its relPath + bytes) was a leaf of the manifest's
//   Merkle root. It does NOT prove "unaltered since date T", authorship, or licensing — that stronger,
//   time-anchored claim needs the human-owned signing/timestamp trust-root (a needs-human step). The
//   proof binds a file to a ROOT; whether that root is itself trustworthy/anchored is a separate layer.
const MEMBERSHIP_TRUST_NOTE = [
  "NOTE: this proves SET-MEMBERSHIP only — that the named file (its relPath + bytes) is a leaf of the",
  "dataset manifest's Merkle root. It does NOT prove the file is UNALTERED SINCE a date, nor authorship",
  "or licensing: that time-anchored claim needs a signing/timestamp trust-root (a separate, human step).",
].join("\n");

/**
 * Build (purely, OFFLINE) a portable set-membership proof that `filePath` was a member of the dataset
 * the manifest at `manifestPath` commits to. Reuses cli/hash.js's buildTree/proofForIndex (the SAME
 * fold/recompute construction `vh prove` uses) and emits the SAME `verifyhash.merkle-proof` artifact
 * cli/proof.js validates — no new crypto.
 *
 * Membership is decided by CONTENT, not by the caller's file name: the file's contentHash is streamed
 * from disk and the manifest entry is matched by contentHash. The proof binds the manifest's RECORDED
 * relPath for that entry (so the artifact's leaf re-derives to the manifest's committed leaf). If the
 * file's bytes are not present in the manifest at all, it is a clear NON-member (a fabricated/altered
 * file fails here, before any artifact is built).
 *
 * @param {object} opts
 * @param {string} opts.file      path to the single file to prove membership of
 * @param {string} opts.manifest  path to a manifest written by `vh dataset build`
 * @returns {{
 *   member: boolean,
 *   contentHash: string,        // streamed keccak256 of the file's bytes
 *   relPath: string|null,       // the manifest's recorded relPath for the matched entry (null if none)
 *   leaf: string|null,          // the path-bound leaf (what folds to the root) (null if non-member)
 *   root: string,               // the manifest's committed Merkle root
 *   proof: string[]|null,       // sibling path folding leaf -> root (null if non-member)
 *   artifact: object|null,      // a validated verifyhash.merkle-proof artifact (null if non-member)
 * }}
 */
function buildDatasetProof(opts) {
  if (!opts || typeof opts !== "object") throw new Error("buildDatasetProof requires options");
  const { file, manifest: manifestPath } = opts;
  if (!file) throw new Error("buildDatasetProof requires a --file <p>");
  if (!manifestPath) throw new Error("buildDatasetProof requires a --manifest <m> path");

  // Resolve + stat the file first so a missing/non-regular file errors clearly before we trust the
  // manifest (statSync throws ENOENT; a directory is not provable as a single member).
  const fileAbs = path.resolve(file);
  const stat = fs.statSync(fileAbs);
  if (!stat.isFile()) {
    throw new Error(`--file must be a regular file (the single member to prove), got: ${file}`);
  }

  // The manifest is the (structurally-validated) commitment we prove against. readManifest rejects a
  // corrupt/edited manifest rather than half-accepting it (it also re-checks every leaf == pathLeaf).
  const manifest = readManifest(manifestPath);

  // Stream the file's content digest (never loads the whole file at once — a large member stays cheap).
  const contentHash = hashFileStream(fileAbs);

  // Membership is by CONTENT: find the manifest entry whose recorded contentHash equals this file's.
  // Matching by content (not by the caller's chosen path) means renaming the file on disk does not
  // change the answer, and a single file whose bytes appear in the dataset is provable regardless of
  // where the caller stored it. (The manifest entry carries the canonical relPath that binds the leaf.)
  const entry = manifest.files.find(
    (f) => f.contentHash.toLowerCase() === contentHash.toLowerCase()
  );

  if (!entry) {
    // Clear NEGATIVE: the file's bytes are not committed by this manifest. No artifact is built.
    return {
      member: false,
      contentHash,
      relPath: null,
      leaf: null,
      root: manifest.root,
      proof: null,
      artifact: null,
    };
  }

  // Rebuild the SAME sorted-leaf tree the manifest committed to (its `leaf` list IS that committed set),
  // then generate the proof for this entry's leaf. buildTree sorts the leaves ascending exactly as
  // `vh dataset build` did, so the index we locate matches the canonical tree position.
  const leaves = manifest.files.map((f) => f.leaf);
  const { root, layers, sortedLeaves } = buildTree(leaves);

  // Defense in depth: the tree we rebuilt from the manifest's leaves MUST reproduce the manifest's
  // recorded root, or the manifest is internally inconsistent (and any proof off it is meaningless).
  if (root.toLowerCase() !== manifest.root.toLowerCase()) {
    throw new Error(
      `manifest is internally inconsistent: its leaf set folds to ${root}, not its recorded root ` +
        `${manifest.root}. Refusing to build a proof against a self-contradictory manifest.`
    );
  }

  const index = sortedLeaves.findIndex((l) => BigInt(l) === BigInt(entry.leaf));
  if (index < 0) {
    // Should be unreachable (entry.leaf came from manifest.files), but never build a bogus proof.
    throw new Error(`internal: manifest leaf ${entry.leaf} not found in its own tree`);
  }
  const proof = proofForIndex(layers, index);

  // Emit the SAME portable artifact cli/proof.js reads, so `vh dataset verify-proof` (and even
  // `vh verify-proof`, given an on-chain anchored root) fold it with the identical recompute path.
  const artifact = buildProofArtifact({
    root: manifest.root,
    leaf: entry.leaf,
    contentHash: entry.contentHash,
    proof,
    file: entry.relPath,
  });

  return {
    member: true,
    contentHash,
    relPath: entry.relPath,
    leaf: entry.leaf,
    root: manifest.root,
    proof,
    artifact,
  };
}

/**
 * Orchestrate `vh dataset prove --file <p> --manifest <m> [--out <p>] [--json]`. Builds the membership
 * proof OFFLINE and, on a MEMBER, optionally writes the self-contained artifact to the caller's --out
 * path (never silently the cwd). On a NON-member it writes NO artifact and reports a clear negative.
 *
 * @param {object} opts
 * @param {string} opts.file
 * @param {string} opts.manifest
 * @param {string} [opts.out]     where to write the proof artifact (caller-chosen; required to persist one)
 * @param {boolean}[opts.json]
 * @param {(s:string)=>void}[opts.stdout]
 * @returns {{ member: boolean, contentHash: string, relPath: string|null, root: string, out: string|null }}
 */
function runDatasetProve(opts) {
  if (!opts || typeof opts !== "object") throw new Error("runDatasetProve requires options");
  const write = opts.stdout || ((s) => process.stdout.write(s));
  const built = buildDatasetProof({ file: opts.file, manifest: opts.manifest });

  let outAbs = null;
  if (built.member && opts.out) {
    // Validate + write the artifact at the EXACT path the caller chose (resolved to absolute so the
    // success line names precisely the file written). writeProofArtifact re-validates before writing.
    outAbs = path.resolve(opts.out);
    writeProofArtifact(built.artifact, outAbs);
  }

  if (opts.json) {
    write(
      JSON.stringify({
        member: built.member,
        contentHash: built.contentHash,
        relPath: built.relPath,
        root: built.root,
        proofLength: built.proof ? built.proof.length : null,
        out: outAbs,
      }) + "\n"
    );
  } else if (built.member) {
    write(`dataset membership: MEMBER\n`);
    write(`  relPath:     ${built.relPath}  (the manifest's committed path for this content)\n`);
    write(`  contentHash: ${built.contentHash}\n`);
    write(`  leaf:        ${built.leaf}\n`);
    write(`  root:        ${built.root}\n`);
    write(`  proof:       ${built.proof.length} sibling${built.proof.length === 1 ? "" : "s"}\n`);
    if (outAbs) {
      write(`  proof artifact written: ${outAbs}  (verify with \`vh dataset verify-proof <p>\`)\n`);
    } else {
      write(`  (pass --out <p> to write a portable proof artifact for offline verification)\n`);
    }
    write(MEMBERSHIP_TRUST_NOTE + "\n");
  } else {
    write(`dataset membership: NOT A MEMBER\n`);
    write(`  contentHash: ${built.contentHash}\n`);
    write(`  root:        ${built.root}\n`);
    write(
      `  The file's bytes are NOT committed by this manifest (it was never in the dataset, or it was\n` +
        `  altered/fabricated). No proof artifact is written for a non-member.\n`
    );
    write(MEMBERSHIP_TRUST_NOTE + "\n");
  }

  return {
    member: built.member,
    contentHash: built.contentHash,
    relPath: built.relPath,
    root: built.root,
    out: outAbs,
  };
}

// Outcomes of `vh dataset verify-proof`. Distinct from cli/proof.js's on-chain STATUS: this command is
// PURELY OFFLINE (no anchored-root check), so the only verdicts are CONFIRMED (folds to the root) or
// REJECTED (does not). Confirming the root is itself anchored on-chain is `vh verify-proof`'s job.
const MEMBERSHIP_STATUS = Object.freeze({
  CONFIRMED: "CONFIRMED", // the proof folds OFFLINE to its recorded root (set-membership holds)
  REJECTED: "REJECTED", // it does NOT (a fabricated/altered file, or a tampered proof/leaf/root)
});

/**
 * Run `vh dataset verify-proof <proof>` — fold a portable proof artifact PURELY OFFLINE, with NO
 * dataset copy, NO manifest, NO key, and NO network, confirming the file's leaf folds to the recorded
 * root. Reuses cli/proof.js's readProofArtifact (strict validation) + recomputeFold (the SAME fold the
 * on-chain verifyLeaf does), so the fold path is byte-identical to `vh verify-proof`'s offline leg.
 *
 * CONFIRMED requires BOTH: (1) the artifact's leaf re-derives from its contentHash+relPath, and (2) the
 * leaf folds through the proof to the recorded root. Either failing -> REJECTED.
 *
 * @param {object} opts
 * @param {string} opts.artifact  path to a proof artifact (from `vh dataset prove --out` / `vh prove --out`)
 * @param {boolean}[opts.json]
 * @param {(s:string)=>void}[opts.stdout]
 * @returns {{
 *   status: "CONFIRMED"|"REJECTED",
 *   leafMatches: boolean, foldsToRoot: boolean,
 *   relPath: string, contentHash: string, leaf: string, root: string,
 *   computedRoot: string, proofLength: number,
 * }}
 */
function runDatasetVerifyProof(opts) {
  if (!opts || typeof opts !== "object") throw new Error("runDatasetVerifyProof requires options");
  const write = opts.stdout || ((s) => process.stdout.write(s));
  if (!opts.artifact) throw new Error("runDatasetVerifyProof requires a <proof> artifact path");

  // Strict read (rejects a corrupt/forged artifact) then the OFFLINE fold — the entire verification.
  const artifact = readProofArtifact(opts.artifact);
  const fold = recomputeFold(artifact);
  const status = fold.offlineOk ? MEMBERSHIP_STATUS.CONFIRMED : MEMBERSHIP_STATUS.REJECTED;

  const result = {
    status,
    leafMatches: fold.leafMatches,
    foldsToRoot: fold.foldsToRoot,
    relPath: artifact.relPath,
    contentHash: artifact.contentHash,
    leaf: artifact.leaf,
    root: artifact.root,
    computedRoot: fold.computedRoot,
    proofLength: artifact.proof.length,
  };

  if (opts.json) {
    write(JSON.stringify(result) + "\n");
  } else {
    write(MEMBERSHIP_TRUST_NOTE + "\n\n");
    write(`  proof artifact: ${opts.artifact}\n`);
    write(`  relPath:        ${result.relPath}\n`);
    write(`  contentHash:    ${result.contentHash}\n`);
    write(`  leaf:           ${result.leaf}\n`);
    write(`  root:           ${result.root}\n`);
    write(`  proof siblings: ${result.proofLength}\n\n`);
    write("  offline recompute (no dataset, no network, no key):\n");
    write(`    leaf re-derived from contentHash+relPath: ${result.leafMatches ? "yes" : "NO"}\n`);
    write(`    proof folds to the recorded root:         ${result.foldsToRoot ? "yes" : "NO"}\n\n`);
    write(`  result:         ${result.status}\n`);
    if (status === MEMBERSHIP_STATUS.CONFIRMED) {
      write(
        "  CONFIRMED: the file is a leaf of the dataset manifest's Merkle root (set-membership proven\n" +
          "  OFFLINE). This binds the file's relPath + bytes to that root; it does NOT prove the file is\n" +
          "  unaltered since a date, nor authorship/licensing.\n"
      );
    } else if (!result.leafMatches) {
      write(
        "  REJECTED: the artifact's leaf does NOT equal pathLeaf(relPath, contentHash) — the leaf,\n" +
          "  contentHash, or relPath was altered. A fabricated/tampered member is caught here offline.\n"
      );
    } else {
      write(
        "  REJECTED: the proof does NOT fold to the recorded root — a proof sibling (or the root) was\n" +
          "  altered. The file is NOT a member of that root. Caught here offline, no dataset needed.\n"
      );
    }
  }

  return result;
}

module.exports = {
  MANIFEST_KIND,
  MANIFEST_SCHEMA_VERSION,
  SUPPORTED_MANIFEST_SCHEMA_VERSIONS,
  TRUST_NOTE,
  MEMBERSHIP_TRUST_NOTE,
  NO_LICENSE_BUCKET,
  NO_SOURCE_BUCKET,
  VERIFY_STATUS,
  MEMBERSHIP_STATUS,
  buildManifest,
  validateManifest,
  readManifest,
  writeManifest,
  runDatasetBuild,
  runDatasetVerify,
  formatDatasetVerify,
  runDatasetDiff,
  formatDatasetDiff,
  runDatasetSummary,
  formatDatasetSummary,
  aggregateManifest,
  buildDatasetReport,
  formatDatasetReportMarkdown,
  runDatasetReport,
  buildDatasetProof,
  runDatasetProve,
  runDatasetVerifyProof,
};

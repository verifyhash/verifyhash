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
const { keccak256, toUtf8Bytes } = require("ethers");
const { hashDirStream, hashFileStream, pathLeaf, buildTree, proofForIndex } = require("./hash");
const { diffManifest } = require("./receipt");
const {
  buildProofArtifact,
  writeProofArtifact,
  readProofArtifact,
  recomputeFold,
} = require("./proof");
// The GENERIC, product-agnostic provenance engine. DataLedger is a THIN adapter over it: the manifest
// builder/validator + the signed-attestation envelope live ONCE in cli/core/ and are shared with
// ProofParcel (and AttestKit later) so the Merkle/manifest/attest math and — critically — the TRUST
// caveats can NEVER drift between products. The dependency points dataset → core (never the reverse).
const coreManifest = require("./core/manifest");
const coreAttestation = require("./core/attestation");
const coreTimestamp = require("./core/timestamp");

// On-disk schema discriminators. A dataset manifest carries its OWN kind + version (distinct from the
// receipt kinds in cli/receipt.js and the proof-artifact kind in cli/proof.js) so a random JSON file,
// a receipt, a proof artifact, or a future/foreign manifest is never misread as a current manifest.
const MANIFEST_KIND = "verifyhash.dataset-manifest";
const MANIFEST_SCHEMA_VERSION = 1;
const SUPPORTED_MANIFEST_SCHEMA_VERSIONS = Object.freeze([1]);

// Same hex shape cli/receipt.js / cli/proof.js validate against, so the modules never drift. Sourced
// from cli/core so the per-file hex check is the IDENTICAL regex the whole product family shares.
const HEX32_RE = coreManifest.HEX32_RE;

// In-band note so a reader of the raw JSON cannot mistake an untrusted license hint for a fact, nor
// the root for proof of anything more than set-membership of (relPath, content) pairs. The text lives
// in EXACTLY ONE place — cli/core/manifest.js — and is imported here (and by ProofParcel) so the
// caveats can NEVER drift between products.
const TRUST_NOTE = coreManifest.TRUST_NOTE;

// DataLedger's manifest framing, passed to the GENERIC core builder/validator. The core does the
// shared math + structural validation; this object supplies ONLY the DataLedger-specific framing
// (kind, schema, note, and the human "dataset manifest" label so the error strings are byte-identical
// to the pre-extraction code). ProofParcel passes its OWN config to the same core.
const MANIFEST_CFG = Object.freeze({
  kind: MANIFEST_KIND,
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  supportedSchemaVersions: SUPPORTED_MANIFEST_SCHEMA_VERSIONS,
  note: TRUST_NOTE,
  label: "dataset manifest",
});

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
  // THIN wrapper over the generic core: the core does the shared hint-normalization, the Merkle/manifest
  // assembly, and the strict validation; DataLedger supplies ONLY its framing (MANIFEST_CFG). Behaviour
  // is byte-for-byte identical to the pre-extraction code (same kind, note, fields, error strings).
  return coreManifest.buildItemManifest(built, MANIFEST_CFG, opts);
}

/**
 * Strictly validate a parsed dataset-manifest object. THIN wrapper over the generic core validator with
 * DataLedger's framing (MANIFEST_CFG) — the core enforces the shared structural rules (kind/
 * schemaVersion, hex root, per-file leaf == pathLeaf(relPath, contentHash), hint shape) and the
 * "dataset manifest" label keeps every error string byte-identical. Throws on the FIRST problem; never
 * mutates and never fills defaults.
 * @param {any} obj
 * @returns {object} the same object, if valid
 */
function validateManifest(obj) {
  return coreManifest.validateItemManifest(obj, MANIFEST_CFG);
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
 * result + an OPTIONAL policy result. No I/O, no aggregation/verdict math of its own — it composes
 * `aggregateManifest`'s roll-up with the (already-run) `runDatasetVerify` result and the (already-run)
 * `evaluatePolicy` verdict. This is the SAME object the `--json` mode emits.
 *
 * The policy block is the EXACT object `evaluatePolicy` returns (the same pure evaluator `vh dataset
 * check` uses, never re-implemented), trimmed to the fields the report documents — so the report's
 * policy verdict can never diverge from `vh dataset check`'s.
 *
 * @param {object} manifest a validated manifest object (from readManifest)
 * @param {object|null} [verifyResult] the object runDatasetVerify returns, or null when no --verify
 * @param {object|null} [policyResult] the object evaluatePolicy returns, or null when no --policy
 * @returns {{
 *   root: string, fileCount: number,
 *   licenses: Object<string,number>, sources: Object<string,number>,
 *   filesWithLicenseHint: number, filesWithSourceHint: number,
 *   verify?: { status: string, added: any[], removed: any[], changed: any[] },
 *   policy?: { verdict: string, rulesEvaluated: number, violations: {relPath:string,rule:string,value:string}[] }
 * }}
 */
function buildDatasetReport(manifest, verifyResult, policyResult) {
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
  if (policyResult) {
    // Carry the verdict, the rule count, and the exact violating files. These are taken VERBATIM from
    // the same pure `evaluatePolicy` the `vh dataset check` command uses — no re-implementation — so the
    // report's PASS/FAIL can never disagree with `vh dataset check`'s for the same manifest + policy.
    model.policy = {
      verdict: policyResult.verdict,
      rulesEvaluated: policyResult.rulesEvaluated,
      violations: policyResult.violations,
    };
  }
  return model;
}

/**
 * Render the consolidated report MODEL as a DETERMINISTIC Markdown document. Stable section order
 * (Trust posture, Dataset identity, Verification status, Policy compliance [only with --policy],
 * Provenance roll-up); the histogram reuses `_histogramLines` and policy violations are pre-sorted by
 * `evaluatePolicy`, so two runs over the same manifest + policy produce byte-identical Markdown. LEADS
 * with the trust posture (reusing TRUST_NOTE verbatim) so the caveats can never drift; the Policy
 * compliance section repeats the SAME UNTRUSTED-hints caveat as `vh dataset check`; and the document
 * NEVER implies a live-tree verify (or a real license check) happened when it did not.
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

  // --- 4. Policy compliance. ONLY when --policy was given; the verdict is the SAME pure `evaluatePolicy`
  //         the `vh dataset check` command uses (no re-implementation), so PASS/FAIL can never diverge.
  //         LEADS with the SAME UNTRUSTED-hints caveat as `vh dataset check` so the report never implies
  //         the licenses were verified to be genuinely correct. Violations are already sorted (relPath,
  //         then rule) by evaluatePolicy, so this section is byte-identical across runs.
  if (model.policy) {
    const p = model.policy;
    lines.push("## Policy compliance");
    lines.push("");
    lines.push(
      "The {source, license} hints evaluated below are UNTRUSTED, self-asserted metadata NOT bound into " +
        "the root. A PASS means the dataset's SELF-ASSERTED hints satisfy this policy — NOT that the " +
        "licenses are genuinely correct. \"(no license hint)\" asserts NOTHING (requireLicense flags it). " +
        "This does NOT verify any license/source is real."
    );
    lines.push("");
    lines.push(`- verdict: **${p.verdict}**`);
    lines.push(`- rules evaluated: ${p.rulesEvaluated}`);
    if (p.rulesEvaluated === 0) {
      lines.push(
        "- This policy declares NO rules, so it trivially PASSes — every dataset satisfies a policy with " +
          "no constraints."
      );
    } else if (p.verdict === POLICY_VERDICT.PASS) {
      lines.push("- No file's self-asserted hints violate any rule in this policy.");
    } else {
      lines.push(
        `- violations: ${p.violations.length} ` +
          "(each line: the file, the rule it broke, and the offending hint value)"
      );
      for (const v of p.violations) {
        lines.push(`  - \`${v.relPath}\` [${v.rule}] value: ${v.value}`);
      }
    }
    lines.push("");
  }

  // --- 5. Provenance / license roll-up. SAME aggregation + SAME histogram ordering as summary. ------
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
 * Orchestrate `vh dataset report <manifest> [--verify <dir>] [--policy <p>] [--json] [--out <p>]`. Reads
 * the manifest via the strict `readManifest`, OPTIONALLY runs `runDatasetVerify` against a live tree
 * (REUSED verbatim) and OPTIONALLY reads `--policy` (strict `readPolicy`) and evaluates it via the SAME
 * pure `evaluatePolicy` `vh dataset check` uses (REUSED verbatim — the report verdict can never diverge
 * from `vh dataset check`'s), composes the consolidated report MODEL (reusing `aggregateManifest`), and
 * emits it as deterministic Markdown (default) or a machine-readable JSON object (`--json`). With
 * `--out <p>` it writes the report to the caller's EXPLICIT path (never cwd) and names the file; without
 * `--out` it prints to stdout.
 *
 * EXIT-CODE PRECEDENCE (the caller in cli/vh.js maps these). The report is a COMBINED CI gate: it is
 * non-zero whenever ANY embedded gate fails, and 0 only when ALL pass.
 *   - with `--verify`: the embedded verification returns its MATCH/MISMATCH verdict (MISMATCH => fail).
 *   - with `--policy`: the embedded policy returns its PASS/FAIL verdict (FAIL => fail).
 *   - with BOTH: fail (exit 3) if EITHER the verify is MISMATCH OR the policy is FAIL; 0 only when the
 *     verify is MATCH AND the policy is PASS. So a single invocation gates data integrity AND policy.
 * This function returns `verifyStatus` and `policyVerdict`; the CLI derives exit 3 from either failing.
 *
 * @param {object} opts
 * @param {string} opts.manifest  path to a manifest written by `vh dataset build`
 * @param {string} [opts.verifyDir] when given, re-derive the root from this live tree (reuses runDatasetVerify)
 * @param {string} [opts.policy]  when given, evaluate the manifest against this policy (reuses evaluatePolicy)
 * @param {boolean}[opts.json]    emit a machine-readable object instead of the Markdown document
 * @param {string} [opts.out]     write the report to this explicit path (caller-chosen; never cwd)
 * @param {(s:string)=>void}[opts.stdout] sink for stdout (default process.stdout.write); injectable for tests
 * @returns {{
 *   model: object,
 *   verifyStatus: string|null,
 *   policyVerdict: string|null,
 *   out: string|null,
 * }}
 */
function runDatasetReport(opts) {
  if (!opts || typeof opts !== "object") throw new Error("runDatasetReport requires options");
  const { manifest: manifestPath, verifyDir, policy: policyPath } = opts;
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

  // OPTIONAL policy evaluation: read the policy strictly (a corrupt/foreign policy is rejected, never
  // half-accepted) and REUSE the SAME pure `evaluatePolicy` `vh dataset check` runs (no re-implementation)
  // so the report's PASS/FAIL can never diverge from `vh dataset check`'s for the same manifest + policy.
  let policyResult = null;
  if (policyPath) {
    const policy = readPolicy(policyPath);
    policyResult = evaluatePolicy(manifest, policy);
  }

  const model = buildDatasetReport(manifest, verifyResult, policyResult);

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
    policyVerdict: policyResult ? policyResult.verdict : null,
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

// =================================================================================================
// `vh dataset attest <manifest> [--json] [--out <p>]` — the deterministic, canonical UNSIGNED
// attestation payload the human signing/timestamp trust-root (P-3) will sign.
//
// WHY THIS EXISTS
//   DataLedger's most-repeated limit is that a manifest is NOT a timestamp: until someone with a real
//   signing key / timestamp anchor signs it, a manifest proves only set-membership/identity — the same
//   thing it already proves — NOT "unaltered since date T". Standing up that key/timestamp anchor is a
//   HUMAN-owned trust-root (P-3, needs-human). But the deterministic, canonical BYTES that human/service
//   would sign are fully buildable NOW, purely offline. Producing them turns the future human signing
//   step from "design AND sign a payload" into "sign THIS exact file" — a one-liner.
//
//   `vh dataset attest <manifest>` reads the manifest via the SAME strict `readManifest` (a corrupt/
//   foreign manifest is rejected, never half-accepted) and emits a versioned, strictly-validated
//   attestation ENVELOPE that commits to the dataset IDENTITY a signer signs over:
//     - `root`          : the manifest's Merkle root (commits to file NAMES and bytes)
//     - `fileCount`     : the number of committed files
//     - `manifestDigest`: keccak256 over a CANONICAL serialization of the manifest's `files` array
//                         (see canonicalization below) — so the same committed file set always yields
//                         the same digest, and ANY edit to the committed set changes it.
//     - `note`          : the standing trust caveat (NOT a timestamp; signing is human-owned, P-3).
//   PURELY OFFLINE: no tree, no provider, no key, no network.
//
// CANONICALIZATION (documented exactly so signing the bytes is well-defined)
//   The `manifestDigest` is keccak256(utf8(canonicalFiles)), where canonicalFiles is the manifest's
//   `files` entries projected to ONLY the root-committed fields { relPath, contentHash, leaf } (the
//   UNTRUSTED `hints` are deliberately EXCLUDED — they are not bound into the root, so they must not
//   change the identity a signer commits to), each entry serialized with its keys in the FIXED order
//   [relPath, contentHash, leaf], the entries ORDERED by relPath ascending (a total, deterministic
//   order), and the whole array JSON-serialized with NO insignificant whitespace. So two runs over the
//   same committed file set produce byte-identical canonical bytes regardless of the on-disk manifest's
//   key order or whitespace — which is the property that makes signing the bytes well-defined.
//
//   The ENVELOPE itself is then serialized canonically the same way (fixed top-level key order, no
//   insignificant whitespace, trailing newline) so `--json` / `--out` emit byte-deterministic bytes.
//
// UNSIGNED MARKER (never imply a signature/timestamp exists)
//   The envelope carries an explicit `signed: false` and a `signature: null` slot the human/timestamp
//   step fills in. Until a signature is attached, the artifact proves only the same set-membership/
//   identity the manifest already does — NOT "unaltered since date T". This is stated in-band in `note`.

const ATTESTATION_KIND = "verifyhash.dataset-attestation";
const ATTESTATION_SCHEMA_VERSION = 1;
const SUPPORTED_ATTESTATION_SCHEMA_VERSIONS = Object.freeze([1]);

// The standing trust caveat carried IN-BAND in every attestation envelope. Load-bearing, not
// decorative: a reader (or the future human signer) must never mistake this UNSIGNED payload for a
// time-anchored proof. It states plainly that signing is the human-owned trust-root (P-3, needs-human).
const ATTESTATION_TRUST_NOTE =
  "This is the UNSIGNED attestation payload. It commits to the dataset IDENTITY (Merkle root, " +
  "fileCount, and a canonical manifestDigest over the committed file set). It is NOT signed and NOT " +
  "timestamped: `signed` is false and `signature` is null until a human/timestamp trust-root fills " +
  "them in. Standing up a real signing key / timestamp anchor is the human-owned trust-root " +
  "(needs-human, P-3). Until a signature is attached, this proves only the same set-membership / " +
  "identity the manifest already does — NOT that the dataset is unaltered since a date T.";

/**
 * Canonically serialize the manifest's COMMITTED file set to the exact UTF-8 bytes the `manifestDigest`
 * is taken over. Deterministic by construction (see CANONICALIZATION above): only the root-committed
 * fields { relPath, contentHash, leaf } are included (the untrusted `hints` are excluded), each entry's
 * keys are emitted in the FIXED order [relPath, contentHash, leaf], the entries are ordered by relPath
 * ascending, and the array is JSON-serialized with NO insignificant whitespace. Pure (no mutation).
 *
 * @param {object} manifest a validated manifest object (from readManifest/validateManifest)
 * @returns {string} the canonical JSON string of the committed file set
 */
function canonicalManifestFiles(manifest) {
  const entries = manifest.files.map((f) => ({
    relPath: f.relPath,
    contentHash: f.contentHash,
    leaf: f.leaf,
  }));
  // Total, deterministic order by relPath. readManifest already rejects duplicate relPaths, so this is
  // a strict total order (no ties) and the result is independent of the manifest's on-disk entry order.
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  // JSON.stringify with the explicit per-entry key list pins key ORDER and emits NO insignificant
  // whitespace; the fixed [relPath, contentHash, leaf] order is guaranteed by the object literal above
  // (V8 preserves insertion order for string keys), so the bytes are stable across runs/manifests.
  return JSON.stringify(entries);
}

/**
 * Compute the canonical `manifestDigest`: keccak256 over the canonical serialization of the manifest's
 * committed file set (see canonicalManifestFiles). Deterministic: the same committed set always yields
 * the same digest; any edit/rename/add/remove to the committed set changes it. Pure.
 * @param {object} manifest a validated manifest object
 * @returns {string} a 0x-prefixed 32-byte hex digest
 */
function manifestDigest(manifest) {
  return keccak256(toUtf8Bytes(canonicalManifestFiles(manifest)));
}

/**
 * Build a normalized, fully-validated UNSIGNED attestation envelope from a validated manifest object.
 * The envelope commits to the dataset identity (root, fileCount, manifestDigest) plus the standing trust
 * caveat, and carries the explicit `signed: false` / `signature: null` unsigned markers. PURE: no I/O,
 * no key, no network. Throws (via validateAttestation) if the result is malformed, so a corrupt envelope
 * is never produced.
 *
 * @param {object} manifest a validated manifest object (from readManifest)
 * @returns {object} a validated attestation envelope
 */
function buildAttestation(manifest) {
  // The manifest must itself be sound before we attest its identity (readManifest already did this for
  // the CLI path; revalidate here so a programmatic caller that hand-built a manifest is also checked).
  validateManifest(manifest);
  const env = {
    kind: ATTESTATION_KIND,
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    note: ATTESTATION_TRUST_NOTE,
    // Dataset identity the signer commits to.
    root: manifest.root,
    fileCount: manifest.files.length,
    manifestDigest: manifestDigest(manifest),
    // Explicit UNSIGNED markers — the human/timestamp trust-root (P-3) fills these in. The artifact
    // NEVER implies it has been signed or timestamped.
    signed: false,
    signature: null,
  };
  validateAttestation(env);
  return env;
}

/**
 * Strictly validate a parsed attestation envelope. Throws an Error describing the FIRST problem; never
 * mutates and never fills defaults (mirroring validateManifest / cli/proof.js's posture). A wrong kind/
 * schemaVersion, a missing/!hex root or manifestDigest, a bad fileCount, or an envelope that claims to be
 * signed (this UNSIGNED payload must never imply a signature) hard-errors here so a tampered/edited
 * payload is caught on read.
 * @param {any} obj
 * @returns {object} the same object, if valid
 */
function validateAttestation(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("dataset attestation must be a JSON object");
  }
  if (obj.kind !== ATTESTATION_KIND) {
    throw new Error(
      `not a verifyhash dataset attestation (kind: ${JSON.stringify(obj.kind)}; expected ${JSON.stringify(
        ATTESTATION_KIND
      )})`
    );
  }
  if (!SUPPORTED_ATTESTATION_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new Error(
      `unsupported dataset attestation schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(SUPPORTED_ATTESTATION_SCHEMA_VERSIONS)})`
    );
  }
  for (const f of ["root", "manifestDigest"]) {
    if (typeof obj[f] !== "string" || !HEX32_RE.test(obj[f])) {
      throw new Error(
        `dataset attestation ${f} must be a 0x-prefixed 32-byte hex string, got: ${String(obj[f])}`
      );
    }
  }
  if (!Number.isInteger(obj.fileCount) || obj.fileCount < 1) {
    throw new Error(
      `dataset attestation fileCount must be a positive integer, got: ${String(obj.fileCount)}`
    );
  }
  // The UNSIGNED payload must NEVER imply a signature/timestamp. `signed` must be exactly false and
  // `signature` exactly null — a payload that claims otherwise (e.g. a hand-edited `signed:true` with no
  // real signature scheme this build understands) is rejected rather than silently believed.
  if (obj.signed !== false) {
    throw new Error(
      `dataset attestation signed must be false (this build emits/reads only the UNSIGNED payload; ` +
        `attaching a real signature is the human-owned trust-root, P-3), got: ${String(obj.signed)}`
    );
  }
  if (obj.signature !== null) {
    throw new Error(
      `dataset attestation signature must be null in the UNSIGNED payload, got: ${String(obj.signature)}`
    );
  }
  return obj;
}

/**
 * Serialize an attestation envelope to its canonical, byte-deterministic bytes: a fixed top-level key
 * order, NO insignificant whitespace, a single trailing newline. Two runs over the same manifest produce
 * an identical string — this is the property that makes signing the bytes well-defined. The string IS
 * the canonical bytes the `--json` form emits and the `--out` file holds.
 * @param {object} env a validated attestation envelope
 * @returns {string} the canonical serialization (newline-terminated)
 */
function serializeAttestation(env) {
  validateAttestation(env);
  // Fixed top-level key order via the explicit object literal (V8 preserves string-key insertion order),
  // JSON.stringify with no spacing -> no insignificant whitespace.
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
 * Read, parse, and STRICTLY validate the attestation envelope at `attestationPath`. The strict reader
 * round-trips with serializeAttestation: a malformed/edited envelope (wrong kind/schemaVersion, missing
 * or !hex root/manifestDigest, a signed-looking payload) is rejected, never half-accepted. Throws on a
 * missing file or invalid JSON too.
 * @param {string} attestationPath
 * @returns {object} the validated envelope
 */
function readAttestation(attestationPath) {
  if (!attestationPath || typeof attestationPath !== "string") {
    throw new Error("readAttestation requires an attestation file path");
  }
  let raw;
  try {
    raw = fs.readFileSync(attestationPath, "utf8");
  } catch (e) {
    throw new Error(`cannot read dataset attestation at ${attestationPath}: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`dataset attestation at ${attestationPath} is not valid JSON: ${e.message}`);
  }
  return validateAttestation(obj);
}

// =================================================================================================
// SIGNED-attestation envelope (T-17.1) — a detached signature WRAPPED AROUND the canonical UNSIGNED
// payload, never an edit of it.
//
// WHY A SEPARATE KIND
//   The UNSIGNED attestation (above) deliberately hard-asserts `signed:false`/`signature:null`: that
//   guarantee must NEVER be loosened, because a reader who trusts `serializeAttestation`'s bytes is
//   trusting that they carry NO signature claim. So instead of mutating that payload to add a
//   signature, we WRAP it: a new, separately-versioned container kind that embeds the EXACT canonical
//   unsigned bytes (byte-for-byte the string `serializeAttestation` emits) as a string, alongside a
//   detached `signature` block. The embedded unsigned bytes are re-parsed and re-validated by the SAME
//   `validateAttestation`, so the wrapped payload is still provably `signed:false`/`signature:null` —
//   wrapping adds a vouch, it never edits the thing vouched for.
//
// THE SCHEME (detached, NOT EIP-712)
//   `eip191-personal-sign` means: the signer ran `personal_sign` (EIP-191) over the EXACT canonical
//   unsigned bytes (the UTF-8 of the embedded `attestation` string, including its single trailing
//   newline). We use a detached signature — not EIP-712 typed data — precisely so the signed message
//   IS the canonical payload bytes verbatim, with no separate domain/struct encoding to drift from
//   them. This container does NOT itself verify the signature (the loop holds no key and does no
//   crypto recovery — see T-17.2); it asserts the STRUCTURE is well-formed and the embedded payload is
//   a valid UNSIGNED attestation.
//
// WHAT IT PROVES / DOES NOT PROVE
//   A valid signed container asserts: the holder of `signer`'s key vouched for THIS dataset identity
//   (the embedded root/fileCount/manifestDigest) at signing time. It does NOT prove a timestamp — there
//   is no "unaltered since date T" unless `scheme` is a timestamp authority (still P-3, needs-human) —
//   and EVERY caveat of the embedded UNSIGNED payload (the {source,license} hints are untrusted, the
//   digest commits to the CLAIMED file set, not re-derived content) still applies verbatim.

const SIGNED_ATTESTATION_KIND = "verifyhash.dataset-attestation-signed";
const SIGNED_ATTESTATION_SCHEMA_VERSION = 1;
const SUPPORTED_SIGNED_ATTESTATION_SCHEMA_VERSIONS = Object.freeze([1]);

// The detached signature schemes this build understands, sourced from cli/core so the supported-scheme
// set is the IDENTICAL one shared across the product family. `eip191-personal-sign` = EIP-191
// personal_sign over the canonical UNSIGNED attestation bytes (a 65-byte r||s||v secp256k1 signature).
const SIGNED_ATTESTATION_SCHEMES = coreAttestation.SIGNED_ATTESTATION_SCHEMES;

// The standing trust caveat carried IN-BAND in every signed container. It REUSES the dataset TRUST_NOTE
// VERBATIM (so the dataset caveats never drift) and adds only the signed-container-specific assertion:
// the container asserts the holder of `signer`'s key vouched for THIS dataset identity at signing time;
// it does NOT prove a timestamp (no "unaltered since date T" unless `scheme` is a timestamp authority —
// still P-3), and EVERY caveat of the embedded UNSIGNED payload still applies.
const SIGNED_ATTESTATION_TRUST_NOTE =
  "This is a SIGNED attestation container: it wraps (never edits) the EXACT canonical UNSIGNED " +
  "attestation bytes in `attestation` and attaches a detached signature. It asserts that the holder of " +
  "the `signer` key vouched for THIS dataset identity (the embedded root, fileCount, manifestDigest) at " +
  "signing time. It does NOT prove a timestamp: there is no \"unaltered since a date T\" unless the " +
  "scheme is a timestamp authority (still needs-human, P-3). Every caveat of the embedded UNSIGNED " +
  "payload still applies. " +
  TRUST_NOTE;

// DataLedger's signed-container framing, passed to the GENERIC core. The core owns the envelope
// machinery (the wrap-don't-edit invariant, the scheme list, signer recovery); this object supplies
// ONLY DataLedger's kind/schema/note + the "signed dataset attestation" label (so error strings stay
// byte-identical) and the DataLedger UNSIGNED-payload codec (validate/serialize) the core re-validates
// the embedded payload with — so the core never needs to know anything dataset-specific (no back-edge).
const SIGNED_ATTESTATION_CFG = Object.freeze({
  kind: SIGNED_ATTESTATION_KIND,
  schemaVersion: SIGNED_ATTESTATION_SCHEMA_VERSION,
  supportedSchemaVersions: SUPPORTED_SIGNED_ATTESTATION_SCHEMA_VERSIONS,
  note: SIGNED_ATTESTATION_TRUST_NOTE,
  label: "signed dataset attestation",
  validateUnsigned: validateAttestation,
  serializeUnsigned: serializeAttestation,
});

/**
 * Strictly validate a parsed SIGNED-attestation container. Throws an Error describing the FIRST problem;
 * never mutates and never fills defaults (same discipline as validateAttestation). REJECTS: a wrong
 * kind/schemaVersion, a non-string embedded `attestation`, a missing/non-object `signature` block, an
 * unknown `scheme`, a malformed `signer` address, a missing/!hex `signature` value, or an embedded
 * `attestation` that does not re-validate as a sound UNSIGNED attestation (i.e. it must STILL be
 * `signed:false`/`signature:null` — wrapping never edits). It NEVER half-accepts.
 *
 * @param {any} obj
 * @returns {object} the same object, if valid
 */
function validateSignedAttestation(obj) {
  // THIN wrapper over the generic core validator with DataLedger's framing. The core enforces the shared
  // wrap-don't-edit invariant (re-validate + canonical-byte equality of the embedded UNSIGNED payload via
  // DataLedger's own validateAttestation/serializeAttestation), the scheme list, and the signer/signature
  // shape; the "signed dataset attestation" label keeps every error string byte-identical.
  return coreAttestation.validateSignedAttestation(obj, SIGNED_ATTESTATION_CFG);
}

/**
 * Assemble + validate a SIGNED-attestation container from a validated UNSIGNED attestation envelope and
 * a detached signature triple. PURE: it performs NO signing and NO key handling — the loop never holds a
 * key (T-17.2). It embeds the EXACT canonical unsigned bytes (serializeAttestation(attestation)) as a
 * string so the signed-over bytes are unambiguous, then attaches { scheme, signer, signature } and
 * strictly validates the whole container (throws if anything is malformed, so a corrupt container is
 * never produced).
 *
 * The resulting container ASSERTS that the holder of `signer`'s key vouched for THIS dataset identity at
 * signing time. It does NOT prove a timestamp (no "unaltered since date T" unless `scheme` is a timestamp
 * authority — still P-3, needs-human), and EVERY caveat of the embedded UNSIGNED payload applies verbatim
 * (the {source,license} hints are untrusted; the digest commits to the CLAIMED file set, not re-derived
 * content). Signing WRAPS the unsigned payload, it never edits it.
 *
 * @param {object} params
 * @param {object} params.attestation a validated UNSIGNED attestation envelope (from buildAttestation/readAttestation)
 * @param {string} params.scheme one of SIGNED_ATTESTATION_SCHEMES (e.g. "eip191-personal-sign")
 * @param {string} params.signer the claimed 0x-address of the signer
 * @param {string} params.signature the 0x-hex detached signature over serializeAttestation(attestation)
 * @returns {object} a validated signed-attestation container
 */
function buildSignedAttestation(params) {
  // THIN wrapper: the core embeds the EXACT canonical UNSIGNED bytes (via DataLedger's serializeAttestation
  // in SIGNED_ATTESTATION_CFG), attaches { scheme, signer, signature }, and strictly validates the whole
  // container. NO signing, NO key handling — the loop never holds a key.
  return coreAttestation.buildSignedAttestation(params, SIGNED_ATTESTATION_CFG);
}

/**
 * Serialize a signed-attestation container to its canonical, byte-deterministic bytes: a FIXED top-level
 * (and signature-block) key order, NO insignificant whitespace, a single trailing newline — the same
 * discipline as serializeAttestation. Two runs over the same inputs produce an identical string.
 * @param {object} container a validated signed-attestation container
 * @returns {string} the canonical serialization (newline-terminated)
 */
function serializeSignedAttestation(container) {
  // THIN wrapper: the core serializes with the fixed top-level + signature-block key order, no
  // insignificant whitespace, and a single trailing newline — byte-deterministic across runs.
  return coreAttestation.serializeSignedAttestation(container, SIGNED_ATTESTATION_CFG);
}

/**
 * Read, parse, and STRICTLY validate the signed-attestation container at `signedPath`. Round-trips with
 * serializeSignedAttestation: a malformed/edited container (wrong kind/schemaVersion, unknown scheme,
 * malformed signer, missing/!hex signature, a non-canonical or itself-"signed" embedded payload) is
 * rejected, never half-accepted. Throws on a missing file or invalid JSON too.
 * @param {string} signedPath
 * @returns {object} the validated container
 */
function readSignedAttestation(signedPath) {
  // THIN wrapper over the generic core reader with DataLedger's framing (label keeps the I/O error
  // strings byte-identical). Reads, parses, and strictly validates — a malformed/edited/foreign
  // container is rejected, never half-accepted.
  return coreAttestation.readSignedAttestation(signedPath, SIGNED_ATTESTATION_CFG);
}

/**
 * Orchestrate `vh dataset attest <manifest> [--json] [--out <p>]`. Reads the manifest via the strict
 * `readManifest`, builds the UNSIGNED attestation envelope, and emits its canonical bytes. With `--out`
 * it writes those exact bytes to the caller's EXPLICIT path (never cwd) and names the file; without
 * `--out` it prints them to stdout. `--json` is the machine form AND is itself the canonical bytes.
 * PURELY OFFLINE: no tree, no provider, no key, no network.
 *
 * @param {object} opts
 * @param {string} opts.manifest  path to a manifest written by `vh dataset build`
 * @param {boolean}[opts.json]    emit the canonical machine form (which is the same canonical bytes)
 * @param {string} [opts.out]     write the canonical payload to this explicit path (caller-chosen; never cwd)
 * @param {(s:string)=>void}[opts.stdout] sink for stdout (default process.stdout.write); injectable for tests
 * @returns {{ envelope: object, canonical: string, out: string|null }}
 */
function runDatasetAttest(opts) {
  if (!opts || typeof opts !== "object") throw new Error("runDatasetAttest requires options");
  const { manifest: manifestPath } = opts;
  const write = opts.stdout || ((s) => process.stdout.write(s));
  if (!manifestPath) throw new Error("runDatasetAttest requires a <manifest> path");

  // Strict read: a corrupt/edited/foreign manifest is rejected here, never half-accepted, BEFORE any
  // payload is built. The file SET it commits to is the TRUSTED basis of the attestation identity.
  const manifest = readManifest(manifestPath);

  const envelope = buildAttestation(manifest);
  // The canonical bytes are the SAME whether printed, written, or `--json`-emitted — signing is then a
  // one-liner over exactly these bytes.
  const canonical = serializeAttestation(envelope);

  let outAbs = null;
  if (opts.out) {
    // Write the EXACT canonical bytes to the caller-chosen path (resolved to absolute so the success
    // line names precisely the file written) — never silently the cwd. The ONLY side effect.
    outAbs = path.resolve(opts.out);
    fs.writeFileSync(outAbs, canonical);
    // The success line goes to stdout for the human path; --json stays pure canonical bytes (no extra
    // lines) so its stdout IS the signable payload.
    if (!opts.json) write(`dataset attestation written: ${outAbs}\n`);
  }

  if (opts.json) {
    // The machine form IS the canonical bytes (so a caller can pipe `--json` straight into a signer).
    write(canonical);
  } else if (!outAbs) {
    // No --out: print the canonical payload to stdout. (When --out was given, the success line above is
    // the human feedback and the bytes live in the file.)
    write(canonical);
  }

  return { envelope, canonical, out: outAbs };
}

// =================================================================================================
// `vh dataset sign <manifest> --key-env <VAR> | --key-file <path> [--out <p>] [--json]` — read a
// HUMAN-supplied key, sign the UNSIGNED dataset attestation, write the SIGNED container (T-19.2).
//
// WHY THIS EXISTS
//   `vh dataset attest` emits the canonical UNSIGNED identity bytes a signer signs; T-19.1 added the pure
//   `signAttestation` core that turns a payload + a signer OBJECT into a wrapped, signed container. This
//   command is the CLI glue that lets a HUMAN actually sign: it reads a key the human provisioned OUTSIDE
//   this tool (an env var or a key file), constructs an in-process ethers Wallet from it, and routes it
//   through the SAME `signAttestation` core. The loop itself never generates or holds a key — the key is
//   100% caller-supplied.
//
// KEY HYGIENE (load-bearing). The key source is EXACTLY ONE of `--key-env`/`--key-file`; neither, both, a
//   missing env var, an unreadable file, or a malformed/zero key HARD-ERRORS BEFORE any signing, with a
//   message that NEVER includes the key material. The key is read, used to build the Wallet, used to sign,
//   and discarded; success/`--json` output prints ONLY the signer ADDRESS (public), the output path, and
//   the scheme — never the key.
//
// TRUST POSTURE (P-3, verbatim). This signs the dataset IDENTITY with the key YOU supplied. A self-managed
//   key attests "the signer says so" — it is NOT an independent, trusted TIMESTAMP ("existed/unaltered
//   since date T" still needs the human-owned signing/timestamp trust-root, P-3). The in-band container
//   note (SIGNED_ATTESTATION_TRUST_NOTE) and the human output both say so plainly.

// The signing-specific caveat the human-output sign path LEADS with. States the P-3 posture verbatim: this
// signs the dataset identity with the caller's OWN key; "the signer says so" is NOT a trusted timestamp.
const SIGN_TRUST_NOTE =
  "This signs the dataset IDENTITY (root, fileCount, manifestDigest) with the key YOU supplied. A " +
  "self-managed key attests \"the signer says so\" — it is NOT an independent, trusted TIMESTAMP: " +
  '"existed/unaltered since a date T" still needs the human-owned signing/timestamp trust-root ' +
  "(needs-human, P-3). The key must be one YOU provisioned OUTSIDE this tool.";

/**
 * Orchestrate `vh dataset sign <manifest> --key-env <VAR> | --key-file <path> [--out <p>] [--json]`. Reads
 * the manifest via the strict `readManifest`, builds the UNSIGNED attestation payload via the EXISTING
 * `buildAttestation` path (NO re-implementation), resolves a HUMAN-supplied key into an in-process Wallet
 * via the shared `loadSigningWallet`, signs over the canonical bytes via the T-19.1 `signAttestation` core,
 * and writes the SIGNED container's canonical bytes to `--out` (or stdout). PURELY OFFLINE: the Wallet has
 * no provider, signing is EIP-191 personal_sign, no network is touched.
 *
 * KEY HYGIENE: the key is read, used, and discarded; it is NEVER returned, persisted, or logged. The
 * success/`--json` output prints ONLY the signer address, the output path, and the scheme — never the key.
 *
 * @param {object} opts
 * @param {string} opts.manifest  path to a manifest written by `vh dataset build`
 * @param {string} [opts.keyEnv]  env var holding the signing key (EXACTLY ONE of keyEnv/keyFile)
 * @param {string} [opts.keyFile] path to a key file the human created (EXACTLY ONE of keyEnv/keyFile)
 * @param {boolean}[opts.json]    emit a machine-readable { signer, out, scheme, container, ... } object;
 *                                with NO --out the `container` field carries the canonical signed bytes so
 *                                `--json` never silently drops the artifact (parity with `attest --json`)
 * @param {string} [opts.out]     write the signed container to this explicit path (caller-chosen; never cwd)
 * @param {(s:string)=>void}[opts.stdout] sink for stdout (default process.stdout.write); injectable for tests
 * @returns {Promise<{ container: object, canonical: string, signer: string, scheme: string, out: string|null }>}
 */
async function runDatasetSign(opts) {
  if (!opts || typeof opts !== "object") throw new Error("runDatasetSign requires options");
  const { manifest: manifestPath, keyEnv, keyFile } = opts;
  const write = opts.stdout || ((s) => process.stdout.write(s));
  if (!manifestPath) throw new Error("runDatasetSign requires a <manifest> path");

  // Resolve the HUMAN-supplied key into an in-process Wallet FIRST (BEFORE any signing). Neither/both
  // sources, a missing env var, an unreadable file, or a malformed/zero key hard-errors here with a
  // key-free message — so we never read the manifest only to fail on a bad key, and never sign with junk.
  const { wallet } = coreAttestation.loadSigningWallet({ keyEnv, keyFile });

  // Strict read: a corrupt/edited/foreign manifest is rejected here, never half-accepted. The file SET it
  // commits to is the TRUSTED basis of the attestation identity.
  const manifest = readManifest(manifestPath);

  // Build the UNSIGNED payload via the EXISTING `vh dataset attest` code path (NO re-implementation), then
  // route the Wallet + payload through the SAME T-19.1 core `signAttestation`. The container ROUND-TRIPS by
  // construction: `vh dataset verify-attest` recovers exactly this signer over exactly these bytes.
  const unsigned = buildAttestation(manifest);
  const container = await coreAttestation.signAttestation(
    { attestation: unsigned, signer: wallet },
    SIGNED_ATTESTATION_CFG
  );
  const canonical = serializeSignedAttestation(container);
  const signer = container.signature.signer; // lowercase 0x-address (PUBLIC) — never the key
  const scheme = container.signature.scheme;

  let outAbs = null;
  if (opts.out) {
    // Write the EXACT canonical signed bytes to the caller-chosen path (resolved absolute) — never cwd.
    // The ONLY side effect. NOTHING about the key is written: a signed container holds only the public
    // signer address + the signature.
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
      write(`  signed dataset attestation written: ${outAbs}\n`);
    } else {
      // No --out: emit the canonical signed bytes to stdout after the human header.
      write(canonical);
    }
  }

  return { container, canonical, signer, scheme, out: outAbs };
}

// =================================================================================================
// `vh dataset verify-attest <signed> [--manifest <m>] [--signer <addr>] [--json]` — an OFFLINE verifier
// that confirms a SIGNED attestation container (T-17.1) is genuinely signed and (optionally) binds the
// buyer's own dataset.
//
// WHY THIS EXISTS
//   A buyer handed a "signed by the publisher" attestation needs ONE command that answers, with no key
//   and no network: (1) is the embedded signature genuine — i.e. does it recover to the address the
//   container CLAIMS as `signer`? Without this check a `signer` field is just a self-asserted label.
//   (2) Optionally: is the recovered signer the SPECIFIC publisher I expected (`--signer <addr>`)? — so a
//   buyer pins WHO must have signed, not merely that SOMEONE did. (3) Optionally: does the signature bind
//   the dataset I actually hold (`--manifest <m>`)? — by recomputing the canonical UNSIGNED bytes from MY
//   manifest via the EXISTING build path and confirming they are byte-identical to the embedded payload.
//
//   PURELY OFFLINE: no tree walk, no provider, no key, no network. The signature recovery is ethers'
//   `verifyMessage` over the EXACT embedded canonical bytes (the wire is `eip191-personal-sign` = EIP-191
//   personal_sign over those bytes), so the message recovered-over IS the signed-over payload verbatim.
//
// TRUST POSTURE (carried verbatim into output). A valid signature proves the HOLDER OF `signer`'s KEY
//   vouched for THIS dataset identity. It does NOT by itself prove a trustworthy TIMESTAMP ("unaltered
//   since date T" still needs the human-owned trust-root, P-3), and it does NOT validate that the
//   dataset's license/source HINTS are genuinely correct (that is the `check` policy gate's untrusted-hint
//   caveat). The verdict never overclaims past P-3.
//
// EXIT CODES (mirror the dataset family's data-divergence convention): 0 on ACCEPTED, 3 on REJECTED (so a
//   buyer's CI can gate "attestation is genuinely signed by our publisher and binds this dataset"), 2 on a
//   usage error, 1 on a runtime error (missing/corrupt container/manifest). The CLI derives 3 from the
//   returned `accepted` boolean.

// Possible verdicts. ACCEPTED = every REQUESTED check passed; REJECTED = at least one failed.
const VERIFY_ATTEST_VERDICT = Object.freeze({ ACCEPTED: "ACCEPTED", REJECTED: "REJECTED" });

// The standing trust caveat the verify-attest output LEADS with. REUSES the dataset TRUST_NOTE verbatim
// (so the dataset caveats never drift) and adds the signing-specific caveat: a valid signature proves the
// key-holder vouched for this dataset IDENTITY; it does NOT prove a timestamp (P-3, needs-human) and does
// NOT validate the license/source hints (the `check` policy gate's untrusted-hint caveat). Never overclaims.
const VERIFY_ATTEST_TRUST_NOTE =
  "A valid signature proves the HOLDER OF `signer`'s key vouched for THIS dataset identity (the embedded " +
  "root, fileCount, manifestDigest). It does NOT by itself prove a trustworthy TIMESTAMP: \"unaltered " +
  "since a date T\" still needs the human-owned signing/timestamp trust-root (needs-human, P-3). It does " +
  "NOT validate that the dataset's license/source HINTS are genuinely correct (that is the `vh dataset " +
  "check` policy gate's untrusted-hint caveat). " +
  TRUST_NOTE;

/**
 * Recover the signing address from a signed-attestation container's embedded canonical bytes + signature
 * per the declared `scheme`. PURE: no I/O, no key, no network. For `eip191-personal-sign` this is ethers'
 * `verifyMessage(<embedded canonical bytes>, signature)` — EIP-191 personal_sign recovery over the EXACT
 * bytes that were signed. Returns the recovered address as a LOWERCASE 0x-hex string (so it compares
 * directly to the container's lowercase `signer` and a lowercased `--signer`). Throws on an unknown scheme
 * (defense-in-depth: validateSignedAttestation already rejects one) or an unrecoverable signature.
 *
 * @param {object} container a validated signed-attestation container (from readSignedAttestation)
 * @returns {string} the recovered signer address, 0x-prefixed lowercase
 */
function recoverSignedAttestationSigner(container) {
  // THIN wrapper: the core recovers the signer from the embedded canonical bytes + signature per the
  // declared scheme (eip191-personal-sign = EIP-191 personal_sign recovery over the embedded bytes).
  return coreAttestation.recoverSigner(container);
}

/**
 * Verify (purely, OFFLINE) a signed-attestation container: recover the signer from the embedded canonical
 * bytes + signature and confirm it equals the container's CLAIMED `signer`; OPTIONALLY pin it to an
 * EXPECTED publisher (`expectedSigner`); OPTIONALLY confirm the signature binds a buyer's own manifest
 * (`manifest`) by recomputing the canonical UNSIGNED bytes via the EXISTING build path and requiring them
 * byte-identical to the embedded payload. The verdict is ACCEPTED only when EVERY requested check passes.
 *
 * No I/O, no provider, no key, no network. Throws only on an unrecoverable signature; a recovered address
 * that simply doesn't match is a clean REJECTED (a normal verdict, not an error).
 *
 * @param {object} params
 * @param {object} params.container       a validated signed-attestation container (from readSignedAttestation)
 * @param {string} [params.expectedSigner] OPTIONAL expected publisher 0x-address (--signer); checked when present
 * @param {object} [params.manifest]       OPTIONAL validated manifest object (from readManifest); binding check when present
 * @returns {{
 *   verdict: "ACCEPTED"|"REJECTED",
 *   accepted: boolean,
 *   recoveredSigner: string,
 *   claimedSigner: string,
 *   scheme: string,
 *   checks: {
 *     signatureMatchesSigner: boolean,
 *     signerMatchesExpected: boolean|null,
 *     manifestBindsAttestation: boolean|null,
 *   },
 *   expectedSigner: string|null,
 *   manifestChecked: boolean,
 *   failedChecks: string[],
 * }}
 */
function verifySignedAttestation(params) {
  if (!params || typeof params !== "object") {
    throw new Error("verifySignedAttestation requires { container, [expectedSigner], [manifest] }");
  }
  const { container, expectedSigner, manifest } = params;

  // The ONLY DataLedger-specific step: the OPTIONAL dataset-binding check recomputes the canonical
  // UNSIGNED bytes from the buyer's OWN manifest via the EXISTING build path, then hands those bytes to
  // the GENERIC core as `expectedCanonical`. The core does the signer recovery, the claimed-signer
  // check, the OPTIONAL expected-signer pin, and the byte-identity binding comparison — all product-
  // agnostic. The returned shape (incl. the `manifestBindsAttestation`/`manifestChecked` field names) is
  // byte-for-byte what the pre-extraction function returned.
  let expectedCanonical;
  if (manifest !== undefined && manifest !== null) {
    expectedCanonical = serializeAttestation(buildAttestation(manifest));
  }
  return coreAttestation.verifySignedAttestation({ container, expectedSigner, expectedCanonical });
}

/**
 * Render a verify-attest result as the human-readable block the CLI prints. LEADS with the standing
 * trust caveat (VERIFY_ATTEST_TRUST_NOTE: reuses TRUST_NOTE verbatim + the signing caveat — never
 * overclaims past P-3), then the verdict, the recovered/claimed/expected signer, and each requested
 * check with PASS/FAIL. A REJECTED verdict NAMES which check(s) failed.
 * @param {object} r the object verifySignedAttestation returns
 * @returns {string[]} lines
 */
function formatVerifyAttest(r) {
  const lines = [
    // TRUST caveat FIRST: a valid signature proves identity-vouching, NOT a timestamp, NOT correct hints.
    "  TRUST: " + VERIFY_ATTEST_TRUST_NOTE,
    "",
    `  verify-attest: ${r.verdict}`,
    `  scheme:           ${r.scheme}`,
    `  recovered signer: ${r.recoveredSigner}  (from the embedded canonical bytes + signature)`,
    `  claimed signer:   ${r.claimedSigner}  (the container's \`signer\` field)`,
  ];
  // Check 1 (always performed): the signature recovers to the claimed signer.
  lines.push(
    `  [${r.checks.signatureMatchesSigner ? "PASS" : "FAIL"}] signature recovers to the claimed signer`
  );
  // Check 2 (only when --signer pinned): the recovered signer equals the expected publisher.
  if (r.checks.signerMatchesExpected === null) {
    lines.push("  [skip] expected-signer pin: not requested (pass --signer <addr> to pin the publisher)");
  } else {
    lines.push(
      `  [${r.checks.signerMatchesExpected ? "PASS" : "FAIL"}] recovered signer matches the expected ` +
        `publisher (${r.expectedSigner})`
    );
  }
  // Check 3 (only when --manifest given): the signature binds the buyer's own dataset.
  if (r.checks.manifestBindsAttestation === null) {
    lines.push(
      "  [skip] dataset binding: not requested (pass --manifest <m> to bind the signature to YOUR dataset)"
    );
  } else {
    lines.push(
      `  [${r.checks.manifestBindsAttestation ? "PASS" : "FAIL"}] the signature binds YOUR manifest ` +
        "(its canonical bytes are byte-identical to the signed payload)"
    );
  }
  if (r.accepted) {
    lines.push("  ACCEPTED: every requested check passed.");
  } else {
    lines.push(`  REJECTED: failed check(s): ${r.failedChecks.join(", ")}.`);
    if (r.failedChecks.includes("manifestBindsAttestation")) {
      lines.push(
        "    binding-mismatch: the signed payload does NOT match YOUR manifest — the signature vouches for a"
      );
      lines.push("    DIFFERENT dataset identity than the one you hold.");
    }
  }
  return lines;
}

/**
 * Orchestrate `vh dataset verify-attest <signed> [--manifest <m>] [--signer <addr>] [--json]`. Reads the
 * signed container via the strict `readSignedAttestation` (a malformed/edited/foreign container is
 * rejected, never half-accepted) and, when given, the buyer's manifest via the strict `readManifest`,
 * then runs the PURE `verifySignedAttestation`. Emits the verdict as a human block (LEADS with the trust
 * caveat) or a `--json` machine-readable object carrying the recovered signer, expected signer (if any),
 * the manifest-binding result (if checked), and per-check booleans. PURELY OFFLINE: no tree, no provider,
 * no key, no network.
 *
 * @param {object} opts
 * @param {string} opts.signed     path to a signed-attestation container (from T-17.1)
 * @param {string} [opts.manifest] OPTIONAL path to the buyer's manifest (binds the signature to it)
 * @param {string} [opts.signer]   OPTIONAL expected publisher 0x-address to pin
 * @param {boolean}[opts.json]     emit the machine-readable verdict instead of the human block
 * @param {(s:string)=>void}[opts.stdout] sink for stdout (default process.stdout.write); injectable for tests
 * @returns {object} the object verifySignedAttestation returns
 */
function runDatasetVerifyAttest(opts) {
  if (!opts || typeof opts !== "object") throw new Error("runDatasetVerifyAttest requires options");
  const { signed: signedPath, manifest: manifestPath, signer: expectedSigner } = opts;
  const write = opts.stdout || ((s) => process.stdout.write(s));
  if (!signedPath) throw new Error("runDatasetVerifyAttest requires a <signed> path");

  // Strict read: a malformed/edited/foreign signed container is rejected here, never half-accepted, BEFORE
  // any recovery is attempted. (This also re-validates the embedded UNSIGNED payload, scheme, signer, and
  // signature shape.)
  const container = readSignedAttestation(signedPath);

  // OPTIONAL: read the buyer's manifest strictly (a corrupt/foreign manifest is rejected) so the binding
  // check recomputes canonical bytes from a sound manifest.
  let manifest;
  if (manifestPath !== undefined && manifestPath !== null) {
    manifest = readManifest(manifestPath);
  }

  const result = verifySignedAttestation({ container, expectedSigner, manifest });

  if (opts.json) {
    write(JSON.stringify(result) + "\n");
  } else {
    for (const line of formatVerifyAttest(result)) write(line + "\n");
  }
  return result;
}

// =================================================================================================
// DETACHED TIMESTAMP container (T-20.2, EPIC-20) — an INDEPENDENT RFC-3161 TSA timestamp WRAPPED AROUND
// the canonical UNSIGNED dataset attestation, over the SAME generic timestamp core ProofParcel uses.
//
// WHY A SEPARATE KIND (the EPIC-17 move applied to the TIMESTAMP dimension)
//   The signed container proves "the publisher SAYS this dataset identity existed". The honestly-stronger
//   claim a due-diligence / EU-AI-Act reviewer wants is "an INDEPENDENT TSA saw this exact digest by time
//   T". This container delivers the FORMAT for that: it wraps (never edits) the EXACT canonical UNSIGNED
//   attestation bytes and attaches an RFC-3161 TimeStampToken bound to the SHA-256 digest OF those bytes.
//
// THE DIGEST IS SHA-256 — NOT the keccak256 manifestDigest. RFC-3161 TSAs stamp a messageImprint over a
//   STANDARD hash; SHA-256 is universal, keccak256 non-standard (most TSAs reject it). So the timestamp
//   digest is a FRESH sha256(utf8(canonical attestation string)) — the digest the buyer re-derives and the
//   human submits to their TSA — NOT the keccak `manifestDigest` that lives inside the payload.

const TIMESTAMPED_ATTESTATION_KIND = "verifyhash.dataset-attestation-timestamped";
const TIMESTAMPED_ATTESTATION_SCHEMA_VERSION = 1;
const SUPPORTED_TIMESTAMPED_ATTESTATION_SCHEMA_VERSIONS = Object.freeze([1]);

// The standing trust caveat carried IN-BAND in every timestamped container. REUSES the dataset TRUST_NOTE
// VERBATIM (so caveats never drift) and adds ONLY the timestamp-specific caveat: a timestamp token attests
// an INDEPENDENT TSA saw this digest by genTime — to the strength of the TSA you TRUST; this loop does NOT
// validate the TSA cert chain / CMS signature (that is the human out-of-band trust anchor).
const TIMESTAMPED_ATTESTATION_TRUST_NOTE =
  "This is a TIMESTAMPED attestation container: it wraps (never edits) the EXACT canonical UNSIGNED " +
  "attestation bytes in `attestation` and attaches an RFC-3161 timestamp token over the SHA-256 digest of " +
  "those exact bytes. It asserts that an INDEPENDENT Time-Stamping Authority (TSA) saw THIS digest by the " +
  "token's genTime — to the strength of the TSA you TRUST. It does NOT validate the TSA's certificate " +
  "chain or the token's CMS signature (verify those out-of-band, e.g. `openssl ts -verify`, exactly as " +
  "you pin a signer address). The digest is a STANDARD sha256(canonical attestation bytes) — NOT the " +
  "project's internal keccak256 manifestDigest. Every caveat of the embedded UNSIGNED payload still " +
  "applies. " +
  TRUST_NOTE;

// DataLedger's timestamp-container framing, passed to the GENERIC timestamp core. The core owns the
// machinery (the wrap-don't-edit invariant, the SHA-256 digest, the RFC-3161 parse + bindsDigest check);
// this object supplies ONLY DataLedger's kind/schema/note + the "timestamped dataset attestation" label
// and the DataLedger UNSIGNED-payload codec the core re-validates the embedded payload with.
const TIMESTAMPED_ATTESTATION_CFG = Object.freeze({
  kind: TIMESTAMPED_ATTESTATION_KIND,
  schemaVersion: TIMESTAMPED_ATTESTATION_SCHEMA_VERSION,
  supportedSchemaVersions: SUPPORTED_TIMESTAMPED_ATTESTATION_SCHEMA_VERSIONS,
  note: TIMESTAMPED_ATTESTATION_TRUST_NOTE,
  label: "timestamped dataset attestation",
  validateUnsigned: validateAttestation,
  serializeUnsigned: serializeAttestation,
});

/**
 * Strictly validate a parsed TIMESTAMPED-attestation container. THIN wrapper over the generic timestamp
 * core validator with DataLedger's framing (label keeps error strings byte-identical). Rejects a
 * wrong-kind/edited/foreign container, never half-accepts.
 * @param {any} obj
 * @returns {object} the same object, if valid
 */
function validateTimestampedAttestation(obj) {
  return coreTimestamp.validateTimestampContainer(obj, TIMESTAMPED_ATTESTATION_CFG);
}

/**
 * Assemble + validate a TIMESTAMPED-attestation container from a validated UNSIGNED envelope and an
 * RFC-3161 token. THIN wrapper over the generic core: NO network, NO key. A token that does not bind the
 * re-derived SHA-256 digest hard-errors here.
 * @param {object} params { attestation, token }
 * @returns {object} a validated timestamped-attestation container
 */
function buildTimestampedAttestation(params) {
  return coreTimestamp.buildTimestampContainer(params, TIMESTAMPED_ATTESTATION_CFG);
}

/**
 * Serialize a timestamped-attestation container to its canonical, byte-deterministic bytes. THIN wrapper.
 * @param {object} container a validated timestamped-attestation container
 * @returns {string} the canonical serialization (newline-terminated)
 */
function serializeTimestampedAttestation(container) {
  return coreTimestamp.serializeTimestampContainer(container, TIMESTAMPED_ATTESTATION_CFG);
}

/**
 * Read, parse, and STRICTLY validate the timestamped-attestation container at `containerPath`. THIN
 * wrapper over the generic core reader with DataLedger's framing. Rejects a malformed/edited/foreign one.
 * @param {string} containerPath
 * @returns {object} the validated container
 */
function readTimestampedAttestation(containerPath) {
  return coreTimestamp.readTimestampContainer(containerPath, TIMESTAMPED_ATTESTATION_CFG);
}

// The timestamp-request human note: how to turn the emitted digest into a token. States the trust caveat
// and a concrete `openssl ts -query` recipe (the digest is the messageImprint a TSA stamps).
const TIMESTAMP_REQUEST_TRUST_NOTE =
  "This emits the SHA-256 digest of the canonical UNSIGNED attestation bytes — the EXACT digest you submit " +
  "to your RFC-3161 Time-Stamping Authority (TSA). A timestamp token will attest an INDEPENDENT TSA saw " +
  "THIS digest by its genTime — to the strength of the TSA you TRUST; this tool does NOT obtain the token " +
  "(that is a human/network step) and does NOT validate the TSA cert chain. The digest is a STANDARD " +
  "SHA-256 (universal across TSAs) — NOT the project's internal keccak256 manifestDigest.";

/**
 * Build the human "how to produce the token" recipe for a given SHA-256 digest. Concrete, copy-pasteable:
 * an `openssl ts -query` over the digest, then submit to the TSA, then `vh dataset timestamp-wrap`.
 * @param {string} digestHex the lowercase SHA-256 digest (no 0x)
 * @returns {string[]} recipe lines (no trailing newlines)
 */
function timestampRequestRecipe(digestHex) {
  return [
    "  To obtain an RFC-3161 timestamp token over this digest (a HUMAN/network step):",
    `    openssl ts -query -digest ${digestHex} -sha256 -cert -out request.tsq`,
    "    # send request.tsq to your TSA (e.g. `curl` to its HTTP endpoint) -> response.tsr",
    "    openssl ts -reply -in response.tsr -token_out -out token.der",
    "  Then wrap it back into a verifiable container (no key, no network):",
    "    vh dataset timestamp-wrap <manifest> --token token.der --out attestation.timestamped.json",
  ];
}

/**
 * Orchestrate `vh dataset timestamp-request <manifest> [--out <p>] [--json]`. Builds the UNSIGNED payload
 * EXACTLY as `vh dataset attest` does (REUSES buildAttestation — no re-impl), computes the canonical bytes,
 * and emits the SHA-256 digest (hex) the human submits to their TSA, plus a ready-to-use recipe for
 * producing the token. With `--out` it writes a small machine-readable request descriptor to the caller's
 * EXPLICIT path (never cwd). PURELY OFFLINE: NO key, NO network. This is the "here's exactly what to stamp"
 * half of the human handoff.
 *
 * @param {object} opts
 * @param {string} opts.manifest  path to a manifest written by `vh dataset build`
 * @param {boolean}[opts.json]    emit a machine-readable { digest, hashAlgorithm, canonical, ... } object
 * @param {string} [opts.out]     write the request descriptor to this explicit path (caller-chosen; never cwd)
 * @param {(s:string)=>void}[opts.stdout] sink for stdout (default process.stdout.write); injectable for tests
 * @returns {{ digest: string, hashAlgorithm: string, canonical: string, out: string|null }}
 */
function runDatasetTimestampRequest(opts) {
  if (!opts || typeof opts !== "object") throw new Error("runDatasetTimestampRequest requires options");
  const { manifest: manifestPath } = opts;
  const write = opts.stdout || ((s) => process.stdout.write(s));
  if (!manifestPath) throw new Error("runDatasetTimestampRequest requires a <manifest> path");

  // Strict read + the EXISTING attest build path (NO re-impl) so the canonical bytes are byte-for-byte the
  // SAME bytes `vh dataset attest` emits — the bytes the buyer re-derives and the SHA-256 is taken over.
  const manifest = readManifest(manifestPath);
  const canonical = serializeAttestation(buildAttestation(manifest));
  const digest = coreTimestamp.sha256Hex(canonical);

  let outAbs = null;
  if (opts.out) {
    // Write a small request descriptor (the digest + the bytes it is over) to the caller-chosen path —
    // never cwd. The ONLY side effect.
    outAbs = path.resolve(opts.out);
    fs.writeFileSync(
      outAbs,
      JSON.stringify(
        {
          kind: "verifyhash.timestamp-request",
          hashAlgorithm: "sha256",
          digest,
          attestation: canonical,
          note: TIMESTAMP_REQUEST_TRUST_NOTE,
        },
        null,
        2
      ) + "\n"
    );
  }

  if (opts.json) {
    write(
      JSON.stringify({
        hashAlgorithm: "sha256",
        digest,
        canonical,
        out: outAbs,
        note: TIMESTAMP_REQUEST_TRUST_NOTE,
      }) + "\n"
    );
  } else {
    write(`  TRUST: ${TIMESTAMP_REQUEST_TRUST_NOTE}\n`);
    write("\n");
    write(`  sha256 digest (the messageImprint to stamp): ${digest}\n`);
    write("\n");
    for (const line of timestampRequestRecipe(digest)) write(line + "\n");
    if (outAbs) write(`  timestamp request written: ${outAbs}\n`);
  }
  return { digest, hashAlgorithm: "sha256", canonical, out: outAbs };
}

// The timestamp-wrap human note: leads with the inherited container TRUST_NOTE plus the timestamp caveat.
const TIMESTAMP_WRAP_TRUST_NOTE = TIMESTAMPED_ATTESTATION_TRUST_NOTE;

/**
 * Resolve the `--token` argument into raw RFC-3161 DER bytes. ACCEPTS either a PATH to a token file
 * (read as bytes) OR an inline base64 string. We try the filesystem FIRST (the common case — a `token.der`
 * the human produced), falling back to treating the argument as inline base64/hex only when it is not a
 * readable file. Throws a clear error if neither yields parseable token bytes.
 * @param {string} tokenArg a path to a DER token file OR an inline base64/hex token string
 * @returns {Buffer} the raw DER bytes
 */
function resolveTimestampToken(tokenArg) {
  if (typeof tokenArg !== "string" || tokenArg.length === 0) {
    throw new Error("--token requires a path to an RFC-3161 token file OR an inline base64 token");
  }
  // Prefer a file path (the natural artifact `openssl ts -reply -token_out` writes).
  if (fs.existsSync(tokenArg)) {
    return fs.readFileSync(tokenArg); // raw DER bytes
  }
  // Fall back to inline base64/hex; coreTimestamp.buildTimestampContainer's toBuf will reject non-token.
  return tokenArg;
}

/**
 * Orchestrate `vh dataset timestamp-wrap <manifest> --token <path|base64> [--out <p>] [--json]`. Reads the
 * manifest strictly, builds the UNSIGNED payload via the EXISTING attest path (NO re-impl), reads the
 * human-obtained RFC-3161 token, and builds the validated TIMESTAMPED container via the generic engine —
 * binding it to the re-derived canonical SHA-256 digest. ERRORS CLEARLY if the token does not bind the
 * digest. With `--out` it writes the container to the caller's EXPLICIT path (never cwd). PURELY OFFLINE:
 * NO key, NO network.
 *
 * @param {object} opts
 * @param {string} opts.manifest  path to a manifest written by `vh dataset build`
 * @param {string} opts.token     path to an RFC-3161 token file OR an inline base64 token (REQUIRED)
 * @param {boolean}[opts.json]    emit a machine-readable { kind, digest, genTime, ..., container } object
 * @param {string} [opts.out]     write the timestamped container to this explicit path (caller-chosen; never cwd)
 * @param {(s:string)=>void}[opts.stdout] sink for stdout (default process.stdout.write); injectable for tests
 * @returns {{ container: object, canonical: string, digest: string, genTime: string, out: string|null }}
 */
function runDatasetTimestampWrap(opts) {
  if (!opts || typeof opts !== "object") throw new Error("runDatasetTimestampWrap requires options");
  const { manifest: manifestPath, token: tokenArg } = opts;
  const write = opts.stdout || ((s) => process.stdout.write(s));
  if (!manifestPath) throw new Error("runDatasetTimestampWrap requires a <manifest> path");
  if (!tokenArg) throw new Error("runDatasetTimestampWrap requires a --token <path|base64>");

  // Strict read + the EXISTING attest build path (NO re-impl) so the timestamped-over bytes are byte-for-
  // byte the SAME bytes `vh dataset attest`/`timestamp-request` emit.
  const manifest = readManifest(manifestPath);
  const unsigned = buildAttestation(manifest);
  const token = resolveTimestampToken(tokenArg);

  // The engine re-derives the canonical SHA-256 digest, parses the token, and confirms bindsDigest — a
  // token that stamps a DIFFERENT digest (or hash algorithm) hard-errors HERE, never lands a bad container.
  const container = buildTimestampedAttestation({ attestation: unsigned, token });
  const canonical = serializeTimestampedAttestation(container);
  const facts = coreTimestamp.readTimestampFacts(container);

  let outAbs = null;
  if (opts.out) {
    outAbs = path.resolve(opts.out);
    fs.writeFileSync(outAbs, canonical); // the ONLY side effect — at the caller's explicit path, never cwd
  }

  if (opts.json) {
    write(
      JSON.stringify({
        kind: container.kind,
        scheme: container.timestamp.scheme,
        hashAlgorithm: container.timestamp.hashAlgorithm,
        digest: facts.digest,
        genTime: facts.genTime,
        serialNumber: facts.serialNumber,
        policyOID: facts.policyOID,
        out: outAbs,
        // ARTIFACT PARITY with `attest --json`: when there is no --out, carry the canonical bytes so --json
        // never drops the artifact; with --out the bytes are on disk so `container` is null.
        container: outAbs ? null : canonical,
        note: TIMESTAMP_WRAP_TRUST_NOTE,
      }) + "\n"
    );
  } else {
    write(`  TRUST: ${TIMESTAMP_WRAP_TRUST_NOTE}\n`);
    write("\n");
    write(`  timestamped: an INDEPENDENT TSA stamped this digest by genTime\n`);
    write(`  digest (sha256 of the canonical attestation bytes): ${facts.digest}\n`);
    write(`  genTime (asserted by the TSA):                       ${facts.genTime}\n`);
    write(`  TSA serial:                                          ${facts.serialNumber.hex}\n`);
    write(`  policy OID:                                          ${facts.policyOID}\n`);
    if (outAbs) {
      write(`  timestamped dataset attestation written: ${outAbs}\n`);
    } else {
      write(canonical);
    }
  }
  return { container, canonical, digest: facts.digest, genTime: facts.genTime, out: outAbs };
}

// =================================================================================================
// `vh dataset check <manifest> --policy <p> [--json]` — deterministic, OFFLINE license/source policy gate.
//
// WHY THIS EXISTS
//   `vh dataset summary` rolls up what a dataset CLAIMS about its files' {source, license}. But a CI
//   pipeline (or a compliance reviewer) wants the next step: a PASS/FAIL GATE — "does this dataset's
//   self-asserted provenance satisfy MY policy?" (e.g. "no GPL in my proprietary product", "only files
//   from this allowed corpus", "every file MUST carry a license"). `vh dataset check` reads the manifest
//   via the SAME strict `readManifest` (a corrupt/foreign manifest is rejected, never half-accepted) and a
//   new strict, versioned POLICY file, then evaluates the manifest's TRUSTED file set against the policy
//   in a PURE, deterministic function (no I/O, no provider, no key, no network) and returns a verdict.
//
// TRUST POSTURE (carried verbatim — reuses TRUST_NOTE so caveats never drift)
//   The {source, license} hints are UNTRUSTED, self-asserted metadata NOT bound into the root. A PASS
//   means "the dataset's self-asserted hints satisfy this policy" — NOT "the licenses are genuinely
//   correct". A `(no license hint)` file ASSERTS NOTHING (which `requireLicense` is the rule that flags).
//   This NEVER implies it verified a license is real.
//
// MATCH SEMANTICS (documented so a verdict is reproducible)
//   A file's "license hint value" is its `hints.license` string, or the absence of one (no `hints` at
//   all, or `hints` with no `license`). Likewise for `hints.source`. All comparisons against the policy's
//   lists are CASE-SENSITIVE EXACT STRING MATCHES on the hint value ("GPL-3.0" matches only "GPL-3.0",
//   never "gpl-3.0" or "GPL-3.0-or-later"). The rules:
//     - allowLicenses : any file whose license hint is NOT in the allowlist VIOLATES (a file with no
//                       license hint also violates — it is not in any allowlist).
//     - denyLicenses  : any file whose license hint IS in the denylist VIOLATES (a file with no license
//                       hint does NOT violate — there is no value on the denylist to match).
//     - allowSources / denySources : the same, on the source hint.
//     - requireLicense: true : every file MUST carry a license hint; a `(no license hint)` file VIOLATES.
//   A policy with NO rules is valid and trivially PASSes (with a clear "no rules" note).

const POLICY_KIND = "verifyhash.dataset-policy";
const POLICY_SCHEMA_VERSION = 1;
const SUPPORTED_POLICY_SCHEMA_VERSIONS = Object.freeze([1]);

// The (stable, documented) rule identifiers a violation reports in its `rule` field. A consumer can gate
// on these exact strings.
const POLICY_RULE = Object.freeze({
  ALLOW_LICENSES: "allowLicenses",
  DENY_LICENSES: "denyLicenses",
  ALLOW_SOURCES: "allowSources",
  DENY_SOURCES: "denySources",
  REQUIRE_LICENSE: "requireLicense",
});

// The sentinel value a violation carries for a file that asserts NO license/source hint. It is NOT a real
// hint value — it is the explicit "(no license hint)" / "(no source hint)" label (reusing the summary's
// buckets), so a reader can never mistake "no claim" for a literal hint string named "(no license hint)".
const NO_HINT_VALUE = Object.freeze({
  license: NO_LICENSE_BUCKET,
  source: NO_SOURCE_BUCKET,
});

// Possible verdicts. PASS = no file violates any rule; FAIL = at least one file violates at least one rule.
const POLICY_VERDICT = Object.freeze({ PASS: "PASS", FAIL: "FAIL" });

/**
 * Strictly validate a parsed policy object. Throws an Error describing the FIRST problem; never mutates
 * and never fills defaults (mirroring validateManifest / validateAttestation). A wrong kind/schemaVersion,
 * or any malformed field (a non-array allow/deny list, a non-string list entry, a non-boolean
 * requireLicense) hard-errors here so a corrupt/foreign policy is rejected, never half-accepted. Every
 * rule field is OPTIONAL and combinable; a policy with NO rules is valid (and trivially PASSes).
 * @param {any} obj
 * @returns {object} the same object, if valid
 */
function validatePolicy(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("dataset policy must be a JSON object");
  }
  if (obj.kind !== POLICY_KIND) {
    throw new Error(
      `not a verifyhash dataset policy (kind: ${JSON.stringify(obj.kind)}; expected ${JSON.stringify(
        POLICY_KIND
      )})`
    );
  }
  if (!SUPPORTED_POLICY_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new Error(
      `unsupported dataset policy schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(SUPPORTED_POLICY_SCHEMA_VERSIONS)})`
    );
  }
  // The four list rules: each, WHEN PRESENT, must be an array of non-empty strings. We reject a non-array,
  // an empty-string entry, or a non-string entry rather than silently coercing — a malformed list must
  // never half-evaluate into a surprise verdict.
  for (const f of [
    POLICY_RULE.ALLOW_LICENSES,
    POLICY_RULE.DENY_LICENSES,
    POLICY_RULE.ALLOW_SOURCES,
    POLICY_RULE.DENY_SOURCES,
  ]) {
    if (obj[f] === undefined) continue;
    if (!Array.isArray(obj[f])) {
      throw new Error(`dataset policy ${f} must be an array of strings when present, got: ${String(obj[f])}`);
    }
    obj[f].forEach((v, i) => {
      if (typeof v !== "string" || v.length === 0) {
        throw new Error(`dataset policy ${f}[${i}] must be a non-empty string, got: ${String(v)}`);
      }
    });
  }
  // requireLicense, WHEN PRESENT, must be a strict boolean (reject a truthy string/number that would
  // silently enable the rule).
  if (obj.requireLicense !== undefined && typeof obj.requireLicense !== "boolean") {
    throw new Error(
      `dataset policy requireLicense must be a boolean when present, got: ${String(obj.requireLicense)}`
    );
  }
  return obj;
}

/**
 * Read, parse, and STRICTLY validate the policy at `policyPath`. Throws on a missing file, invalid JSON,
 * or ANY schema deviation (so a malformed/foreign policy is rejected, never half-accepted) — mirroring
 * readManifest / readAttestation.
 * @param {string} policyPath
 * @returns {object} the validated policy object
 */
function readPolicy(policyPath) {
  if (!policyPath || typeof policyPath !== "string") {
    throw new Error("readPolicy requires a policy file path");
  }
  let raw;
  try {
    raw = fs.readFileSync(policyPath, "utf8");
  } catch (e) {
    throw new Error(`cannot read dataset policy at ${policyPath}: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`dataset policy at ${policyPath} is not valid JSON: ${e.message}`);
  }
  return validatePolicy(obj);
}

/**
 * Count the rules a (validated) policy actually carries — so the verdict can report `rulesEvaluated` and
 * a no-rules policy is announced clearly. A list rule counts only when present AND non-empty (an empty
 * `allowLicenses: []` carries no constraint). `requireLicense` counts only when exactly `true`.
 * @param {object} policy a validated policy object
 * @returns {number}
 */
function _countPolicyRules(policy) {
  let n = 0;
  for (const f of [
    POLICY_RULE.ALLOW_LICENSES,
    POLICY_RULE.DENY_LICENSES,
    POLICY_RULE.ALLOW_SOURCES,
    POLICY_RULE.DENY_SOURCES,
  ]) {
    if (Array.isArray(policy[f]) && policy[f].length > 0) n++;
  }
  if (policy.requireLicense === true) n++;
  return n;
}

/**
 * Evaluate a manifest's TRUSTED file set against a policy in a PURE, deterministic function (no I/O, no
 * provider, no key, no network). Returns a verdict: PASS (no file violates any rule) or FAIL with, per
 * violating file, the relPath + which rule it broke + the offending hint value. A single file can violate
 * more than one rule (each is its own violation entry). Violations are sorted by relPath then rule, so two
 * runs over the same inputs produce a byte-identical verdict.
 *
 * Match semantics (see header): CASE-SENSITIVE EXACT STRING match on the hint value. A file with no
 * license hint has the NO_HINT_VALUE.license sentinel as its "value"; ditto source.
 *
 * @param {object} manifest a validated manifest object (from readManifest)
 * @param {object} policy   a validated policy object (from readPolicy)
 * @returns {{
 *   verdict: "PASS"|"FAIL",
 *   fileCount: number,
 *   rulesEvaluated: number,
 *   violations: { relPath: string, rule: string, value: string }[],
 * }}
 */
function evaluatePolicy(manifest, policy) {
  const allowLicenses =
    Array.isArray(policy.allowLicenses) && policy.allowLicenses.length > 0
      ? new Set(policy.allowLicenses)
      : null;
  const denyLicenses =
    Array.isArray(policy.denyLicenses) && policy.denyLicenses.length > 0
      ? new Set(policy.denyLicenses)
      : null;
  const allowSources =
    Array.isArray(policy.allowSources) && policy.allowSources.length > 0
      ? new Set(policy.allowSources)
      : null;
  const denySources =
    Array.isArray(policy.denySources) && policy.denySources.length > 0
      ? new Set(policy.denySources)
      : null;
  const requireLicense = policy.requireLicense === true;

  const violations = [];
  for (const f of manifest.files) {
    const license =
      f.hints && typeof f.hints.license === "string" ? f.hints.license : null;
    const source = f.hints && typeof f.hints.source === "string" ? f.hints.source : null;

    // requireLicense: a file with NO license hint asserts nothing — it violates. (This is the ONE rule
    // that flags a missing hint; allow/deny lists below handle PRESENT vs absent per their own semantics.)
    if (requireLicense && license === null) {
      violations.push({
        relPath: f.relPath,
        rule: POLICY_RULE.REQUIRE_LICENSE,
        value: NO_HINT_VALUE.license,
      });
    }
    // allowLicenses: a license hint NOT in the allowlist violates. A file with no license hint is not in
    // any allowlist, so it also violates (reported with the explicit no-hint sentinel value).
    if (allowLicenses && (license === null || !allowLicenses.has(license))) {
      violations.push({
        relPath: f.relPath,
        rule: POLICY_RULE.ALLOW_LICENSES,
        value: license === null ? NO_HINT_VALUE.license : license,
      });
    }
    // denyLicenses: a license hint IN the denylist violates. A file with no license hint has no value to
    // match on the denylist, so it does NOT violate this rule.
    if (denyLicenses && license !== null && denyLicenses.has(license)) {
      violations.push({ relPath: f.relPath, rule: POLICY_RULE.DENY_LICENSES, value: license });
    }
    // allowSources: a source hint NOT in the allowlist violates (a missing source hint is not in it).
    if (allowSources && (source === null || !allowSources.has(source))) {
      violations.push({
        relPath: f.relPath,
        rule: POLICY_RULE.ALLOW_SOURCES,
        value: source === null ? NO_HINT_VALUE.source : source,
      });
    }
    // denySources: a source hint IN the denylist violates (a missing source hint does not).
    if (denySources && source !== null && denySources.has(source)) {
      violations.push({ relPath: f.relPath, rule: POLICY_RULE.DENY_SOURCES, value: source });
    }
  }

  // Deterministic order: by relPath, then by rule (a stable total order, so two runs are byte-identical).
  violations.sort((a, b) => {
    if (a.relPath !== b.relPath) return a.relPath < b.relPath ? -1 : 1;
    return a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0;
  });

  return {
    verdict: violations.length === 0 ? POLICY_VERDICT.PASS : POLICY_VERDICT.FAIL,
    fileCount: manifest.files.length,
    rulesEvaluated: _countPolicyRules(policy),
    violations,
  };
}

/**
 * Render a policy-check result as the human-readable block the CLI prints. LEADS with the trust caveat
 * (reusing TRUST_NOTE verbatim so caveats never drift): the {source, license} hints are UNTRUSTED — a
 * PASS means the dataset's self-asserted hints satisfy this policy, NOT that the licenses are genuinely
 * correct. NEVER implies a license was verified to be real.
 * @param {object} r the object evaluatePolicy returns
 * @returns {string[]} lines
 */
function formatDatasetCheck(r) {
  const lines = [
    // TRUST caveat FIRST: a PASS is about self-asserted hints, not verified licenses.
    "  TRUST: the {source, license} hints checked here are UNTRUSTED, self-asserted metadata. " +
      TRUST_NOTE,
    "         A PASS means the dataset's SELF-ASSERTED hints satisfy this policy — NOT that the licenses",
    "         are genuinely correct. \"(no license hint)\" asserts NOTHING (requireLicense flags it). This",
    "         does NOT verify any license/source is real.",
    "",
    `  policy check: ${r.verdict}`,
    `  files:           ${r.fileCount}`,
    `  rules evaluated: ${r.rulesEvaluated}`,
  ];
  if (r.rulesEvaluated === 0) {
    lines.push(
      "  NOTE: this policy declares NO rules, so it trivially PASSes — every dataset satisfies a policy",
      "        with no constraints. Add allowLicenses/denyLicenses/allowSources/denySources/requireLicense."
    );
    return lines;
  }
  if (r.verdict === POLICY_VERDICT.PASS) {
    lines.push("  PASS: no file's self-asserted hints violate any rule in this policy.");
    return lines;
  }
  lines.push(
    `  FAIL: ${r.violations.length} violation${r.violations.length === 1 ? "" : "s"} ` +
      "(each line: the file, the rule it broke, and the offending hint value):"
  );
  for (const v of r.violations) {
    lines.push(`    ${v.relPath}  [${v.rule}]  value: ${v.value}`);
  }
  return lines;
}

/**
 * Orchestrate `vh dataset check <manifest> --policy <p> [--json]`. Reads the manifest via the strict
 * `readManifest` (a corrupt/foreign manifest is rejected) and the policy via the strict `readPolicy`,
 * then evaluates the manifest's TRUSTED file set against the policy in the PURE `evaluatePolicy`. Emits
 * the deterministic verdict as a human block (LEADS with the trust caveat) or `--json` machine form.
 * PURELY OFFLINE: no tree, no provider, no key, no network.
 *
 * @param {object} opts
 * @param {string} opts.manifest  path to a manifest written by `vh dataset build`
 * @param {string} opts.policy    path to a policy file (the new strict, versioned schema)
 * @param {boolean}[opts.json]    emit the machine-readable object instead of the human block
 * @param {(s:string)=>void}[opts.stdout] sink for stdout (default process.stdout.write); injectable for tests
 * @returns {{ verdict: "PASS"|"FAIL", fileCount: number, rulesEvaluated: number, violations: object[] }}
 */
function runDatasetCheck(opts) {
  if (!opts || typeof opts !== "object") throw new Error("runDatasetCheck requires options");
  const { manifest: manifestPath, policy: policyPath } = opts;
  const write = opts.stdout || ((s) => process.stdout.write(s));
  if (!manifestPath) throw new Error("runDatasetCheck requires a <manifest> path");
  if (!policyPath) throw new Error("runDatasetCheck requires a --policy <p> path");

  // Strict reads: a corrupt/edited/foreign manifest OR policy is rejected here, never half-accepted,
  // BEFORE any evaluation. The manifest's file SET is the TRUSTED basis of the check.
  const manifest = readManifest(manifestPath);
  const policy = readPolicy(policyPath);

  // The verdict math lives in the PURE evaluator (no I/O) so it is deterministic and unit-testable.
  const result = evaluatePolicy(manifest, policy);

  if (opts.json) {
    write(JSON.stringify(result) + "\n");
  } else {
    for (const line of formatDatasetCheck(result)) write(line + "\n");
  }
  return result;
}

module.exports = {
  MANIFEST_KIND,
  MANIFEST_SCHEMA_VERSION,
  SUPPORTED_MANIFEST_SCHEMA_VERSIONS,
  POLICY_KIND,
  POLICY_SCHEMA_VERSION,
  SUPPORTED_POLICY_SCHEMA_VERSIONS,
  POLICY_RULE,
  POLICY_VERDICT,
  NO_HINT_VALUE,
  validatePolicy,
  readPolicy,
  evaluatePolicy,
  formatDatasetCheck,
  runDatasetCheck,
  ATTESTATION_KIND,
  ATTESTATION_SCHEMA_VERSION,
  SUPPORTED_ATTESTATION_SCHEMA_VERSIONS,
  ATTESTATION_TRUST_NOTE,
  canonicalManifestFiles,
  manifestDigest,
  buildAttestation,
  validateAttestation,
  serializeAttestation,
  readAttestation,
  SIGNED_ATTESTATION_KIND,
  SIGNED_ATTESTATION_SCHEMA_VERSION,
  SUPPORTED_SIGNED_ATTESTATION_SCHEMA_VERSIONS,
  SIGNED_ATTESTATION_SCHEMES,
  SIGNED_ATTESTATION_TRUST_NOTE,
  buildSignedAttestation,
  validateSignedAttestation,
  serializeSignedAttestation,
  readSignedAttestation,
  runDatasetAttest,
  SIGN_TRUST_NOTE,
  runDatasetSign,
  VERIFY_ATTEST_VERDICT,
  VERIFY_ATTEST_TRUST_NOTE,
  recoverSignedAttestationSigner,
  verifySignedAttestation,
  formatVerifyAttest,
  runDatasetVerifyAttest,
  // timestamp (T-20.2) — detached RFC-3161 container over the SAME generic timestamp core.
  TIMESTAMPED_ATTESTATION_KIND,
  TIMESTAMPED_ATTESTATION_SCHEMA_VERSION,
  SUPPORTED_TIMESTAMPED_ATTESTATION_SCHEMA_VERSIONS,
  TIMESTAMPED_ATTESTATION_TRUST_NOTE,
  TIMESTAMP_REQUEST_TRUST_NOTE,
  validateTimestampedAttestation,
  buildTimestampedAttestation,
  serializeTimestampedAttestation,
  readTimestampedAttestation,
  runDatasetTimestampRequest,
  runDatasetTimestampWrap,
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

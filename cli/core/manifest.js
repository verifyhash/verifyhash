"use strict";

// cli/core/manifest.js — the GENERIC, product-agnostic provenance MANIFEST engine.
//
// WHY THIS EXISTS
//   verifyhash is growing into a FAMILY of provenance products (DataLedger — AI training-data
//   provenance; ProofParcel — B2B data-delivery receipts; AttestKit later) that all pin EXACTLY what a
//   directory contained — byte-for-byte, including file names/paths — at the moment it was manifested.
//   The Merkle/manifest math is IDENTICAL across all of them; only the product FRAMING differs (its
//   on-disk `kind` discriminator and the human label in its messages). This module is the SINGLE,
//   tested implementation of that shared math + validation; each product is a THIN adapter that calls
//   it with its OWN `kind`/label/note (see cli/dataset.js for DataLedger).
//
//   It reuses the EXISTING path-bound, domain-separated Merkle convention from cli/hash.js verbatim
//   (pathLeaf, the same DIR_LEAF_DOMAIN/LEAF_TAG/NODE_TAG the contract uses) — NO new hashing
//   convention, so a manifest root is the SAME value `vh hash <dir>` and the contract's verifyLeaf
//   produce for the same tree. NO product-specific knowledge lives here: a product passes its `kind`,
//   its `supportedSchemaVersions`, a `note` string, and a `label` (the noun used in error messages),
//   and gets back a builder + a strict validator with byte-identical behaviour to the per-product code
//   it replaces.
//
// IMPORTANT: this module NEVER requires a product module (no `require("../dataset")`), so the
//   dependency points product → core, never the reverse — no back-edge.

const { pathLeaf } = require("../hash");

// Same hex shape cli/receipt.js / cli/proof.js validate against, so the modules never drift. Exported
// so a product can reuse the EXACT regex rather than redefining (and risking drifting from) it.
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;

// The SHARED trust caveat carried IN-BAND in every manifest/attestation/report across the product
// family. It lives in EXACTLY ONE place (here) and is imported by every product, so the caveats can
// NEVER drift between DataLedger, ProofParcel, and any future adapter. It states the load-bearing
// invariant of the whole engine: the root commits to (relPath, content) pairs — names AND bytes — and
// the per-file `hints` (source/license) are UNTRUSTED, self-asserted metadata bound into nothing.
const TRUST_NOTE =
  "The Merkle root commits to the full set of (relPath, content) pairs (names AND bytes): any edit, " +
  "rename, add, or remove changes the root. Per-file `hints` (source/license) are UNTRUSTED, " +
  "self-asserted metadata — they are NOT bound into the root and prove nothing.";

/**
 * Normalize raw per-file hints into a { relPath -> {source?,license?} } map of plain strings. Rejects
 * a hint whose relPath is not in the tree, and a non-string source/license, so junk never lands in the
 * manifest. Returns {} for absent hints. Product-agnostic — DataLedger and ProofParcel share it.
 *
 * @param {object|null|undefined} rawHints  raw per-file hints keyed by relPath
 * @param {Set<string>} knownPaths          the set of relPaths actually present in the tree
 * @returns {Object<string,{source?:string,license?:string}>}
 */
function normalizeHints(rawHints, knownPaths) {
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
 * Build a normalized, fully-validated manifest object from a streamed directory result plus optional
 * per-file hints, PARAMETERIZED by the product's `kind`/`note`/`label`/schema. Throws if the result is
 * malformed, so a corrupt manifest is never produced. This is the GENERIC core every product wraps.
 *
 * @param {{ root: string, leaves: {path:string,contentHash:string,leaf:string}[] }} built
 *        the object cli/hash.js › hashDirStream returns
 * @param {object} cfg                          the product's manifest framing
 * @param {string} cfg.kind                     the on-disk `kind` discriminator (e.g. "verifyhash.dataset-manifest")
 * @param {number} cfg.schemaVersion            the schemaVersion to stamp
 * @param {number[]} cfg.supportedSchemaVersions versions the validator accepts
 * @param {string} cfg.note                     the in-band trust caveat (typically TRUST_NOTE)
 * @param {string} [cfg.label]                  the noun used in error messages (default "dataset manifest")
 * @param {object} [opts]
 * @param {Object<string,{source?:string,license?:string}>} [opts.hints] OPTIONAL untrusted per-file hints
 * @returns {object} a validated manifest object
 */
function buildItemManifest(built, cfg, opts = {}) {
  _requireCfg(cfg);
  if (!built || typeof built !== "object" || !Array.isArray(built.leaves)) {
    throw new Error("buildItemManifest requires the object hashDirStream() returns");
  }
  const knownPaths = new Set(built.leaves.map((l) => l.path));
  const hints = normalizeHints(opts.hints, knownPaths);

  const manifest = {
    kind: cfg.kind,
    schemaVersion: cfg.schemaVersion,
    note: cfg.note,
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
  validateItemManifest(manifest, cfg);
  return manifest;
}

/**
 * Strictly validate a parsed manifest object against a product's framing. Throws an Error describing the
 * FIRST problem; never mutates and never fills defaults — a manifest either is complete and well-formed
 * or it is rejected outright (mirroring cli/proof.js › _validate). The `label` parameterizes ONLY the
 * human noun in error messages (default "dataset manifest", so DataLedger's strings are byte-identical);
 * the STRUCTURAL checks (kind, schemaVersion, hex root, per-file leaf == pathLeaf(relPath, contentHash))
 * are shared verbatim across the product family.
 *
 * @param {any} obj
 * @param {object} cfg                          the product's manifest framing (see buildItemManifest)
 * @returns {object} the same object, if valid
 */
function validateItemManifest(obj, cfg) {
  _requireCfg(cfg);
  const label = cfg.label || "dataset manifest";
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(`${label} must be a JSON object`);
  }
  if (obj.kind !== cfg.kind) {
    throw new Error(
      `not a verifyhash ${label} (kind: ${JSON.stringify(obj.kind)}; expected ${JSON.stringify(
        cfg.kind
      )})`
    );
  }
  if (!cfg.supportedSchemaVersions.includes(obj.schemaVersion)) {
    throw new Error(
      `unsupported ${label} schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(cfg.supportedSchemaVersions)})`
    );
  }
  if (typeof obj.root !== "string" || !HEX32_RE.test(obj.root)) {
    throw new Error(
      `${label} root must be a 0x-prefixed 32-byte hex string, got: ${String(obj.root)}`
    );
  }
  if (!Array.isArray(obj.files)) {
    throw new Error(`${label} field files must be an array`);
  }
  if (obj.files.length === 0) {
    throw new Error(`${label} files must be non-empty (a manifest over zero files is invalid)`);
  }
  // fileCount, when present, must agree with the files array (catch a hand-edited count).
  if (obj.fileCount !== undefined && obj.fileCount !== obj.files.length) {
    throw new Error(
      `${label} fileCount (${String(obj.fileCount)}) does not match files length (${obj.files.length})`
    );
  }

  const seen = new Set();
  obj.files.forEach((entry, i) => {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label} files[${i}] must be an object`);
    }
    if (typeof entry.relPath !== "string" || entry.relPath.length === 0) {
      throw new Error(
        `${label} files[${i}].relPath must be a non-empty string, got: ${String(entry.relPath)}`
      );
    }
    if (seen.has(entry.relPath)) {
      throw new Error(`${label} has a duplicate relPath: ${JSON.stringify(entry.relPath)}`);
    }
    seen.add(entry.relPath);
    for (const f of ["contentHash", "leaf"]) {
      if (typeof entry[f] !== "string" || !HEX32_RE.test(entry[f])) {
        throw new Error(
          `${label} files[${i}].${f} must be a 0x-prefixed 32-byte hex string, got: ${String(
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
        `${label} files[${i}].leaf is inconsistent with its relPath+contentHash ` +
          `(expected ${expectedLeaf}, got ${entry.leaf})`
      );
    }
    // Optional hint shape, when present.
    if (entry.hints !== undefined && entry.hints !== null) {
      if (typeof entry.hints !== "object" || Array.isArray(entry.hints)) {
        throw new Error(`${label} files[${i}].hints must be an object when present`);
      }
      for (const k of ["source", "license"]) {
        if (entry.hints[k] !== undefined && typeof entry.hints[k] !== "string") {
          throw new Error(`${label} files[${i}].hints.${k} must be a string when present`);
        }
      }
    }
  });

  return obj;
}

/**
 * Internal: assert a product passed a structurally complete manifest config. Defends the core against a
 * product adapter that forgot a required field (so the failure is a clear programmer error here, not a
 * confusing downstream symptom).
 */
function _requireCfg(cfg) {
  if (!cfg || typeof cfg !== "object") {
    throw new Error("manifest core requires a { kind, schemaVersion, supportedSchemaVersions, note } config");
  }
  if (typeof cfg.kind !== "string" || cfg.kind.length === 0) {
    throw new Error("manifest core config requires a non-empty string `kind`");
  }
  if (!Array.isArray(cfg.supportedSchemaVersions) || cfg.supportedSchemaVersions.length === 0) {
    throw new Error("manifest core config requires a non-empty `supportedSchemaVersions` array");
  }
}

module.exports = {
  HEX32_RE,
  TRUST_NOTE,
  normalizeHints,
  buildItemManifest,
  validateItemManifest,
};

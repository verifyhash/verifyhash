"use strict";

// cli/core/packetseal.js — the GENERIC, product-agnostic TAMPER-EVIDENT PACKET SEAL core.
//
// WHY THIS EXISTS
//   A "packet seal" is a content-addressed wrapper that binds a SET of already-loaded files
//   ({ relPath, bytes }) — PLUS an OPTIONAL, opaque, caller-supplied HEADER ({ relPath, content }) —
//   into ONE Merkle root, then LOCALIZES any later tamper to the exact file (MATCH / CHANGED / MISSING /
//   UNEXPECTED) or to the header. TrustLedger's reconciliation seal was the first such product, but the
//   machinery is entirely product-agnostic: the only product-specific things are (a) the seal's `kind`
//   discriminator and (b) WHAT the product chooses to bind into the header. This module is the SINGLE,
//   tested implementation of that machinery; each product is a THIN adapter (see trustledger/seal.js).
//
//   It reuses cli/core/manifest.js's hashing / path-leaf convention VERBATIM — pathLeaf / buildTree /
//   hashEntries, the SAME path-bound, domain-separated convention `vh hash <dir>` and the on-chain
//   verifyLeaf use — so a seal root re-derives with NO new crypto, NO contract change, NO network, NO
//   key. NO reconcile/verdict/period vocabulary lives here: that is purely the CALLER's header content.
//
// THE OPTIONAL HEADER (the product's binding seam)
//   A product MAY bind product-specific facts (e.g. TrustLedger's pass/reportDate/period verdict + each
//   input's logical role) into the SAME committed root as the files by supplying a HEADER: an opaque
//   { relPath, content } pair, where `content` is the product's deterministic canonical bytes (a Buffer).
//   The header is folded in as ONE MORE (relPath, content) leaf via the EXACT same pathLeaf convention —
//   no second hashing scheme. The header's content is NOT stored in the seal: on validate/verify the
//   CALLER re-derives it (from the seal's own recorded fields) via a `headerFor(seal)` hook, so an edit to
//   any bound field changes the header leaf → the root → the seal stops re-deriving. The header `relPath`
//   is RESERVED: a real file may not occupy it.
//
// PURE + I/O-FREE
//   Every function here is pure: the CALLER reads the files and hands in already-loaded { relPath, bytes }
//   entries (and, for header products, the header content). Nothing here touches the filesystem, the
//   clock, the network, or a key — same inputs → byte-identical results.
//
// HONEST POSTURE
//   The seal is TAMPER-EVIDENT, not a trusted timestamp and not a legal/semantic opinion. It is an
//   UNTRUSTED transport container: verifySeal is AUTHORITATIVE by RE-COMPUTING the root from the supplied
//   bytes; the seal's stored hashes are merely the EXPECTATION it checks against.

const coreManifest = require("../core/manifest");
const { hashEntries, pathLeaf, hashBytes, buildTree } = require("../hash");

// Same 0x + 64-hex shape the manifest core validates against — imported so the two can never drift.
const HEX32_RE = coreManifest.HEX32_RE;

// ---------------------------------------------------------------------------
// Errors — STRICT. A malformed/ambiguous seal raises a NAMED error rather than
// being silently dropped, coerced, or partially accepted.
// ---------------------------------------------------------------------------

class PacketSealError extends Error {
  constructor(message) {
    super(message);
    this.name = "PacketSealError";
  }
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// _requireCfg(cfg) — assert a product passed a structurally complete seal config.
// `cfg` parameterizes ONLY the product framing:
//   * kind                       (required string)  — the seal's `kind` discriminator
//   * schemaVersion              (required number)  — version stamped on a built seal
//   * supportedSchemaVersions    (required array)   — versions validate accepts
//   * note                       (required string)  — the in-band trust caveat
//   * label                      (optional string)  — the human noun in error messages
//   * headerRelPath              (optional string)  — RESERVED relPath of the header leaf
//                                                     (required iff the product uses a header)
//   * headerContentFor(seal)     (optional fn)      — returns the header's canonical content
//                                                     bytes (Buffer) re-derived from a seal object,
//                                                     for validate's root re-derivation
// A product WITHOUT a header omits headerRelPath/headerContentFor entirely.
// ---------------------------------------------------------------------------

function _requireCfg(cfg) {
  if (!isPlainObject(cfg)) {
    throw new PacketSealError(
      "packet-seal core requires a { kind, schemaVersion, supportedSchemaVersions, note } config"
    );
  }
  if (typeof cfg.kind !== "string" || cfg.kind.length === 0) {
    throw new PacketSealError("packet-seal config requires a non-empty string `kind`");
  }
  if (typeof cfg.schemaVersion !== "number") {
    throw new PacketSealError("packet-seal config requires a numeric `schemaVersion`");
  }
  if (!Array.isArray(cfg.supportedSchemaVersions) || cfg.supportedSchemaVersions.length === 0) {
    throw new PacketSealError("packet-seal config requires a non-empty `supportedSchemaVersions` array");
  }
  if (typeof cfg.note !== "string" || cfg.note.length === 0) {
    throw new PacketSealError("packet-seal config requires a non-empty string `note`");
  }
  // The header is OPTIONAL, but if a product uses one it must supply BOTH the reserved relPath and the
  // re-derivation hook (so validate can recompute the header leaf from a seal's own recorded fields).
  const hasRel = cfg.headerRelPath !== undefined && cfg.headerRelPath !== null;
  const hasFn = cfg.headerContentFor !== undefined && cfg.headerContentFor !== null;
  if (hasRel !== hasFn) {
    throw new PacketSealError(
      "packet-seal config header is all-or-nothing: supply BOTH `headerRelPath` and `headerContentFor`, or NEITHER"
    );
  }
  if (hasRel) {
    if (typeof cfg.headerRelPath !== "string" || cfg.headerRelPath.length === 0) {
      throw new PacketSealError("packet-seal config `headerRelPath` must be a non-empty string when present");
    }
    if (typeof cfg.headerContentFor !== "function") {
      throw new PacketSealError("packet-seal config `headerContentFor` must be a function when present");
    }
  }
}

function _usesHeader(cfg) {
  return cfg.headerRelPath !== undefined && cfg.headerRelPath !== null;
}

function _asBuffer(bytes, where, label) {
  if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) {
    throw new PacketSealError(
      `${label} ${where} bytes must be a Buffer/Uint8Array ` +
        "(the core is I/O-free; the caller reads the file and hands in its bytes)"
    );
  }
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// _normalizeEntries(files, cfg, { strictNonEmpty }) — normalize + strictly
// validate a caller-supplied flat file set into the ordered entry list.
//
// `files` is { entries: [{ relPath, bytes }] }. Each relPath must be a non-empty
// string, unique across the set, and (when the product uses a header) NOT the
// reserved header relPath. Each `bytes` must be a Buffer/Uint8Array.
//
// `strictNonEmpty` is true for BUILD (a seal over zero files is meaningless) and
// false for VERIFY (which must tolerate a PARTIAL supplied set so it can localize
// MISSING). Per-entry strictness is identical either way.
// ---------------------------------------------------------------------------

function _normalizeEntries(files, cfg, opts) {
  const label = cfg.label || "packet seal";
  if (!isPlainObject(files)) {
    throw new PacketSealError(`${label} requires a { entries } file set object`);
  }
  const raw = Array.isArray(files.entries) ? files.entries : null;
  if (raw === null) {
    throw new PacketSealError(`${label} \`entries\` must be an array of { relPath, bytes }`);
  }
  if (opts.strictNonEmpty && raw.length === 0) {
    throw new PacketSealError(`${label} \`entries\` must be a non-empty array of { relPath, bytes }`);
  }

  const seenRelPath = new Set();
  const entries = raw.map((e) => {
    if (!isPlainObject(e)) {
      throw new PacketSealError(`${label} entry must be an object with relPath + bytes`);
    }
    if (typeof e.relPath !== "string" || e.relPath.length === 0) {
      throw new PacketSealError(`${label} entry relPath must be a non-empty string`);
    }
    if (_usesHeader(cfg) && e.relPath === cfg.headerRelPath) {
      throw new PacketSealError(
        `${label} entry relPath ${JSON.stringify(e.relPath)} is reserved for the seal header ` +
          "(a real file may not occupy the bound header slot)"
      );
    }
    if (seenRelPath.has(e.relPath)) {
      throw new PacketSealError(
        `${label} has a duplicate relPath across the file set: ${JSON.stringify(e.relPath)} ` +
          "(every entry must occupy a distinct path)"
      );
    }
    seenRelPath.add(e.relPath);
    return { relPath: e.relPath, bytes: _asBuffer(e.bytes, `entry ${JSON.stringify(e.relPath)}`, label) };
  });

  return { entries };
}

// ---------------------------------------------------------------------------
// _validateHeaderArg(header, cfg) — normalize a caller-supplied build HEADER. A
// header is an opaque { relPath, content } pair: relPath must equal the config's
// reserved headerRelPath (so the product can't bind into an arbitrary slot), and
// content must be a Buffer/Uint8Array (the product's deterministic canonical bytes).
// Returns the content as a Buffer. Throws if the product supplied a header without
// declaring headerRelPath/headerContentFor (or vice versa).
// ---------------------------------------------------------------------------

function _validateHeaderArg(header, cfg) {
  const label = cfg.label || "packet seal";
  if (header === undefined || header === null) {
    if (_usesHeader(cfg)) {
      throw new PacketSealError(
        `${label} config declares a header (headerRelPath) but buildSeal got no \`header\` { relPath, content }`
      );
    }
    return null;
  }
  if (!_usesHeader(cfg)) {
    throw new PacketSealError(
      `${label} got a \`header\` but its config declares none (set headerRelPath/headerContentFor to use one)`
    );
  }
  if (!isPlainObject(header)) {
    throw new PacketSealError(`${label} \`header\` must be a { relPath, content } object`);
  }
  if (header.relPath !== cfg.headerRelPath) {
    throw new PacketSealError(
      `${label} header relPath must be the reserved ${JSON.stringify(cfg.headerRelPath)}, got: ` +
        `${JSON.stringify(header.relPath)}`
    );
  }
  return _asBuffer(header.content, "header", label);
}

// The manifest framing the GENERIC manifest core uses for a seal's file hashing. Derived from the seal
// cfg so each product's manifest `kind` is disjoint. The manifest core does the shared Merkle/manifest
// math + structural validation; this supplies only the framing.
function _manifestCfg(cfg) {
  return {
    kind: `${cfg.kind}-manifest`,
    schemaVersion: 1,
    supportedSchemaVersions: [1],
    note: coreManifest.TRUST_NOTE,
    label: `${cfg.label || "packet seal"} manifest`,
  };
}

// _committedEntries(fileEntries, headerContent, cfg) — the FULL ordered list the root commits to: every
// real file PLUS (when the product uses a header) the synthetic HEADER entry. Every caller of the hasher
// routes through here so build/validate/verify commit to the SAME structure. The header is one more
// { relPath, content } pair fed to the SAME hashEntries convention; no second hashing scheme.
function _committedEntries(fileEntries, headerContent, cfg) {
  if (!_usesHeader(cfg) || headerContent == null) return [...fileEntries];
  return [...fileEntries, { relPath: cfg.headerRelPath, bytes: headerContent }];
}

// _manifestOver(entries, cfg) — compute the per-file manifest (contentHash + leaf) over a flat
// { relPath, bytes } list by REUSING the existing core VERBATIM: cli/hash.js hashEntries for the
// path-bound Merkle leaves, then cli/core/manifest.js buildItemManifest for the strict manifest. NO
// hashing/leaf construction is re-implemented here.
function _manifestOver(entries, cfg) {
  const built = hashEntries(entries.map((e) => ({ path: e.relPath, content: e.bytes })));
  const manifest = coreManifest.buildItemManifest(built, _manifestCfg(cfg));
  const byRelPath = new Map();
  for (const f of manifest.files) {
    byRelPath.set(f.relPath, { relPath: f.relPath, contentHash: f.contentHash, leaf: f.leaf });
  }
  return { manifest, byRelPath };
}

// Internal: re-derive the top-level root from a flat list of { relPath, contentHash } using the SAME
// convention as build — pathLeaf for each, then buildTree — via the shared hash module. We reuse buildTree
// (the exact builder hashEntries uses) so this stays a re-derivation of the same math, never a parallel one.
function _rootFromLeafEntries(flat) {
  const leaves = flat.map((e) => pathLeaf(e.relPath, e.contentHash));
  return buildTree(leaves).root;
}

// ---------------------------------------------------------------------------
// buildSeal({ files, header? }, cfg) — assemble + strictly validate a seal.
//
// `files` is { entries: [{ relPath, bytes }] } (the caller read these). `header`,
// when the product uses one, is the opaque { relPath: <reserved>, content: Buffer }
// pair to bind into the SAME root. The product fills the seal's OWN recorded fields
// (verdict, roles, …) AFTER this returns, then re-validates — but the root + file
// leaves + header binding are produced here.
//
// PURE + deterministic: same files + header → byte-identical root. The `files` array
// in the returned seal is emitted sorted by relPath so the seal bytes are deterministic
// regardless of the caller's array order.
//
// Returns a BARE seal object: { kind, schemaVersion, note, root, fileCount, files, [header:{relPath}] }.
// The header's CONTENT is not stored (it is re-derivable by the caller via headerContentFor); only its
// reserved relPath is recorded so a reader knows a header was bound.
// ---------------------------------------------------------------------------

function buildSeal(params, cfg) {
  _requireCfg(cfg);
  if (!isPlainObject(params)) {
    throw new PacketSealError("buildSeal requires { files, [header] }");
  }
  const { entries } = _normalizeEntries(params.files, cfg, { strictNonEmpty: true });
  const headerContent = _validateHeaderArg(params.header, cfg);

  // Re-derive the manifest/root over the WHOLE committed set — every real file PLUS (when used) the
  // synthetic HEADER entry — via the shared core (no re-implementation).
  const committed = _committedEntries(entries, headerContent, cfg);
  const { manifest, byRelPath } = _manifestOver(committed, cfg);

  // Emit the per-file leaves sorted by relPath so the seal bytes are deterministic regardless of caller
  // order. The header leaf is NOT listed (it is re-derived on validate/verify).
  const files = entries
    .map((e) => {
      const leaf = byRelPath.get(e.relPath);
      return { relPath: leaf.relPath, contentHash: leaf.contentHash, leaf: leaf.leaf };
    })
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const seal = {
    kind: cfg.kind,
    schemaVersion: cfg.schemaVersion,
    note: cfg.note,
    root: manifest.root,
    fileCount: entries.length,
    files,
  };
  if (_usesHeader(cfg)) {
    seal.header = { relPath: cfg.headerRelPath };
  }
  return seal;
}

// ---------------------------------------------------------------------------
// _checkCommonSeal(obj, cfg) — STRICT structural validation of the GENERIC parts of
// a seal: kind, schemaVersion, note, hex root, the files array, per-file leaf
// self-consistency (leaf === pathLeaf(relPath, contentHash)), relPath-uniqueness,
// and fileCount agreement. Returns the flat [{ relPath, contentHash }] file list so
// the caller can re-derive the root (folding in the header). Throws on the FIRST
// problem; never half-accepts. Does NOT touch the header (that is validateSeal's job,
// driven by the product's headerContentFor).
// ---------------------------------------------------------------------------

function _checkCommonSeal(obj, cfg) {
  const label = cfg.label || "packet seal";
  if (!isPlainObject(obj)) {
    throw new PacketSealError(`${label} must be a JSON object`);
  }
  if (obj.kind !== cfg.kind) {
    throw new PacketSealError(
      `not a ${label} (kind: ${JSON.stringify(obj.kind)}; expected ${JSON.stringify(cfg.kind)})`
    );
  }
  if (!cfg.supportedSchemaVersions.includes(obj.schemaVersion)) {
    throw new PacketSealError(
      `unsupported ${label} schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(cfg.supportedSchemaVersions)})`
    );
  }
  if (obj.note !== cfg.note) {
    throw new PacketSealError(`${label} \`note\` must be the standing trust note (caveat must not drift)`);
  }
  if (typeof obj.root !== "string" || !HEX32_RE.test(obj.root)) {
    throw new PacketSealError(
      `${label} root must be a 0x-prefixed 32-byte hex string, got: ${String(obj.root)}`
    );
  }
  if (!Array.isArray(obj.files) || obj.files.length === 0) {
    throw new PacketSealError(`${label} \`files\` must be a non-empty array`);
  }

  const seenRelPath = new Set();
  const flat = []; // { relPath, contentHash }
  obj.files.forEach((entry, i) => {
    if (!isPlainObject(entry)) {
      throw new PacketSealError(`${label} files[${i}] must be an object`);
    }
    if (typeof entry.relPath !== "string" || entry.relPath.length === 0) {
      throw new PacketSealError(`${label} files[${i}].relPath must be a non-empty string`);
    }
    if (_usesHeader(cfg) && entry.relPath === cfg.headerRelPath) {
      throw new PacketSealError(
        `${label} files[${i}].relPath ${JSON.stringify(entry.relPath)} is reserved for the seal header`
      );
    }
    if (seenRelPath.has(entry.relPath)) {
      throw new PacketSealError(
        `${label} has a duplicate relPath across the file set: ${JSON.stringify(entry.relPath)}`
      );
    }
    seenRelPath.add(entry.relPath);
    for (const f of ["contentHash", "leaf"]) {
      if (typeof entry[f] !== "string" || !HEX32_RE.test(entry[f])) {
        throw new PacketSealError(
          `${label} files[${i}].${f} must be a 0x-prefixed 32-byte hex string, got: ${String(entry[f])}`
        );
      }
    }
    const expectedLeaf = pathLeaf(entry.relPath, entry.contentHash);
    if (entry.leaf.toLowerCase() !== expectedLeaf.toLowerCase()) {
      throw new PacketSealError(
        `${label} files[${i}].leaf is inconsistent with its relPath+contentHash ` +
          `(expected ${expectedLeaf}, got ${entry.leaf})`
      );
    }
    flat.push({ relPath: entry.relPath, contentHash: entry.contentHash });
  });

  if (obj.fileCount !== undefined && obj.fileCount !== obj.files.length) {
    throw new PacketSealError(
      `${label} fileCount (${String(obj.fileCount)}) does not match the files length (${obj.files.length})`
    );
  }

  return flat;
}

// ---------------------------------------------------------------------------
// validateSeal(obj, cfg) — STRICT structural + self-consistency validation. Throws
// a named PacketSealError on the FIRST problem; returns the object unchanged on success.
//
// On top of the generic structural checks (_checkCommonSeal), the LOAD-BEARING check:
// the top-level `root` must RE-DERIVE from the listed file (relPath, contentHash) leaves
// PLUS (when the product uses a header) the synthetic HEADER leaf — whose content is
// re-derived from the seal's OWN recorded fields via cfg.headerContentFor(obj). A seal
// whose root was edited to mask a changed file is caught here, AND so is one whose bound
// header fields were edited: that changes the header content → its leaf → the root.
// ---------------------------------------------------------------------------

function validateSeal(obj, cfg) {
  _requireCfg(cfg);
  const label = cfg.label || "packet seal";
  const flat = _checkCommonSeal(obj, cfg);

  let committedFlat = flat;
  if (_usesHeader(cfg)) {
    // The product re-derives the header content from the seal's own recorded fields, so an edit to any
    // bound field changes the header content here and the root stops re-deriving below.
    const headerContent = cfg.headerContentFor(obj);
    const headerBuf = _asBuffer(headerContent, "header content", label);
    // Sanity: the seal must carry the header marker (so a reader knows a header was bound).
    if (!isPlainObject(obj.header) || obj.header.relPath !== cfg.headerRelPath) {
      throw new PacketSealError(
        `${label} must carry a header marker { relPath: ${JSON.stringify(cfg.headerRelPath)} }`
      );
    }
    committedFlat = [
      ...flat,
      { relPath: cfg.headerRelPath, contentHash: hashBytes(headerBuf) },
    ];
  } else if (obj.header !== undefined) {
    throw new PacketSealError(`${label} carries a header but its config declares none`);
  }

  const rederived = _rootFromLeafEntries(committedFlat);
  if (rederived.toLowerCase() !== obj.root.toLowerCase()) {
    const headerNote = _usesHeader(cfg) ? " + header" : "";
    throw new PacketSealError(
      `${label} root does not re-derive from its listed entries${headerNote} ` +
        `(expected ${rederived}, got ${obj.root}) — the seal is internally inconsistent ` +
        "(a file" +
        (_usesHeader(cfg) ? " or a bound header field" : "") +
        " was edited without updating the root)"
    );
  }

  return obj;
}

// ---------------------------------------------------------------------------
// committedLeaves(seal, cfg) — the FULL ordered { relPath, contentHash } list the
// seal's `root` commits to: every listed file PLUS (when used) the synthetic header
// leaf (re-derived from the seal's own fields via cfg.headerContentFor). Validates
// the seal first. buildTree(map(pathLeaf)) over it re-derives `seal.root` byte-for-byte
// via the SAME shared convention. PURE.
// ---------------------------------------------------------------------------

function committedLeaves(seal, cfg) {
  validateSeal(seal, cfg);
  const flat = [];
  for (const e of seal.files) flat.push({ relPath: e.relPath, contentHash: e.contentHash });
  if (_usesHeader(cfg)) {
    const headerBuf = _asBuffer(cfg.headerContentFor(seal), "header content", cfg.label || "packet seal");
    flat.push({ relPath: cfg.headerRelPath, contentHash: hashBytes(headerBuf) });
  }
  return flat;
}

// ---------------------------------------------------------------------------
// verifySeal(seal, files, cfg, { headerContent? }) — the AUTHORITATIVE, PURE verify.
//
// Recompute the per-file content hashes + the root from the SUPPLIED { relPath, bytes }
// set and compare them, per file, against the seal's stored EXPECTATION. The authoritative
// check is the RECOMPUTE: the seal is an untrusted container, so a verdict is decided by the
// bytes the caller holds, never by the seal's own hashes.
//
// `files` is { entries: [{ relPath, bytes }] } (the SAME shape buildSeal took). For a header
// product the caller passes the header CONTENT it re-derived from the SUPPLIED facts as
// `opts.headerContent` (a Buffer) — so a header edit on the supplied side changes the recomputed
// root and rootMatches goes false. (Validate already guarantees the seal's OWN header re-derives.)
//
// Returns a structured result naming EXACTLY which files MATCH / CHANGED / MISSING / UNEXPECTED,
// plus the recomputed/sealed roots and rootMatches. The overall verdict is ACCEPTED only when every
// sealed file MATCHes, none is MISSING/UNEXPECTED, AND the recomputed root equals the sealed root.
//
// PURE: no I/O, no key, no network, no clock.
// ---------------------------------------------------------------------------

function verifySeal(seal, files, cfg, opts = {}) {
  validateSeal(seal, cfg);
  const { entries } = _normalizeEntries(files, cfg, { strictNonEmpty: false });

  // The supplied header content (when the product uses a header). Folded into the recomputed root so a
  // header edit on the supplied side flips rootMatches.
  let headerContent = null;
  if (_usesHeader(cfg)) {
    if (opts.headerContent === undefined || opts.headerContent === null) {
      throw new PacketSealError(
        `${cfg.label || "packet seal"} verifySeal requires \`headerContent\` (a header product binds it into the root)`
      );
    }
    headerContent = _asBuffer(opts.headerContent, "header content", cfg.label || "packet seal");
  } else if (opts.headerContent !== undefined && opts.headerContent !== null) {
    throw new PacketSealError(
      `${cfg.label || "packet seal"} verifySeal got headerContent but the config declares no header`
    );
  }

  // Per-file recomputed contentHash from the SUPPLIED bytes via the SHARED hasher — the authoritative
  // re-derivation, done per file so a PARTIAL set still yields honest per-file findings.
  const suppliedByRel = new Map();
  for (const e of entries) suppliedByRel.set(e.relPath, hashBytes(e.bytes));

  // The recomputed ROOT folds in the supplied header (when used). A tree needs ≥1 leaf and a partial set
  // can never re-derive the sealed root anyway, so we compute it only when at least one committed leaf
  // exists; otherwise it is null and rootMatches is false.
  const committed = _committedEntries(entries, headerContent, cfg);
  const recomputedRoot = committed.length > 0 ? _rootFromSupplied(committed) : null;

  // Sealed expectation: relPath -> contentHash.
  const sealedByRel = new Map();
  for (const e of seal.files) sealedByRel.set(e.relPath, e.contentHash);

  const matched = [];
  const changed = [];
  const missing = [];
  const unexpected = [];

  for (const [relPath, expHash] of sealedByRel) {
    const got = suppliedByRel.get(relPath);
    if (got === undefined) {
      missing.push({ relPath });
      continue;
    }
    if (got.toLowerCase() === expHash.toLowerCase()) {
      matched.push({ relPath, contentHash: got });
    } else {
      changed.push({ relPath, expectedContentHash: expHash, actualContentHash: got });
    }
  }
  for (const [relPath, got] of suppliedByRel) {
    if (!sealedByRel.has(relPath)) unexpected.push({ relPath, contentHash: got });
  }

  const byRel = (a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);
  matched.sort(byRel);
  changed.sort(byRel);
  missing.sort(byRel);
  unexpected.sort(byRel);

  const rootMatches = recomputedRoot != null && recomputedRoot.toLowerCase() === seal.root.toLowerCase();
  const accepted =
    changed.length === 0 && missing.length === 0 && unexpected.length === 0 && rootMatches;

  return {
    verdict: accepted ? "ACCEPTED" : "REJECTED",
    accepted,
    sealedRoot: seal.root,
    recomputedRoot,
    rootMatches,
    counts: {
      matched: matched.length,
      changed: changed.length,
      missing: missing.length,
      unexpected: unexpected.length,
    },
    matched,
    changed,
    missing,
    unexpected,
  };
}

// Internal: recompute the top-level root from the SUPPLIED { relPath, bytes } entries via the SAME
// convention buildSeal used (hashEntries). Kept separate so verifySeal's root is always the authoritative
// re-derivation from bytes, never copied from the seal.
function _rootFromSupplied(entries) {
  const built = hashEntries(entries.map((e) => ({ path: e.relPath, content: e.bytes })));
  return built.root;
}

module.exports = {
  HEX32_RE,
  PacketSealError,
  // pure seal core (parameterized by the product cfg)
  buildSeal,
  validateSeal,
  verifySeal,
  committedLeaves,
};

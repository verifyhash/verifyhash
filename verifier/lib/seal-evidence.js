"use strict";

// verifier/lib/seal-evidence.js — the FREE-TIER, ZERO-INSTALL evidence SEAL core (T-36.1).
//
// WHY THIS EXISTS
//   `verifier/` already lets a stranger VERIFY a `vh.evidence-seal` with NO clone + NO `npm install`
//   (verify-vh.js + ./merkle re-derive the root with no producer stack). The symmetric gap was the
//   PRODUCE side: minting a seal still ran through cli/evidence.js -> cli/core/packetseal.js -> cli/hash.js,
//   and cli/hash.js pulls keccak256/concat/toUtf8Bytes from `ethers`. So a prospect could verify a seal
//   handed to them, but could not produce one of their OWN to hand to a counterparty without the heavy
//   stack. This module closes that loop: a PURE, dependency-free `buildEvidenceSeal({ entries })` that emits
//   an object whose canonical JSON is BYTE-IDENTICAL to what the paid cli/evidence.js seal path produces for
//   the SAME { relPath, bytes } set — reusing the ALREADY-VENDORED, cross-checked ./merkle re-derivation of
//   the family's pathLeaf / leafHash / nodeHash / root convention. No ethers, no js-sha3 (transitively via
//   ./merkle -> ./keccak only), no parent-directory traversal, no bare third-party name. NO signing path
//   lives here — signing is a PAID entitlement that stays in the producer stack; the free tier mints only
//   the UNSIGNED baseline seal.
//
// HONEST POSTURE (must not drift from cli/evidence.js#EVIDENCE_TRUST_NOTE — pinned byte-for-byte below)
//   The seal is TAMPER-EVIDENT + OFFLINE-RECOMPUTABLE, NOT a trusted timestamp and NOT a legal opinion. It
//   is an UNTRUSTED transport container: verify (verify-vh.js / cli `vh evidence verify`) RE-DERIVES the root
//   from the bytes the holder has, never from the seal's own stored hashes.
//
// PURE + I/O-FREE
//   The CALLER reads the files and hands in already-loaded { relPath, bytes } entries. Nothing here touches
//   the filesystem, the clock, the network, or a key — same inputs -> byte-identical bytes out.
//
// RELPATH CONTRACT (fail-closed, so the byte-identical promise can never SILENTLY break)
//   Every relPath MUST already be in canonical POSIX form: forward-slash separators and NO leading "./"
//   (i.e. relPath === toPosixRel(relPath)). This is exactly what a directory walk emits on a POSIX host
//   (cli/evidence.js#loadDirEntries does `path.relative(...).split(path.sep).join("/")`), so the normal
//   producer flow already satisfies it. A relPath that is NOT canonical (a Windows-style backslash, a
//   leading "./") is REJECTED with a named FreeSealError rather than re-normalized — because the free core
//   and the paid producer use DIFFERENT normalizations for those forms (the producer keeps a literal
//   backslash as a content byte on POSIX; "./x" makes the producer throw), so silently accepting them
//   would mint a seal that does NOT byte-match the paid path. Fail-closed means: for any input the free
//   core ACCEPTS, its seal is byte-identical to the paid seal; for inputs it cannot guarantee that, it
//   refuses (a symmetric, named rejection) instead of producing a surprising, non-reproducible artifact.

const merkle = require("./merkle");

// ---------------------------------------------------------------------------
// Product framing — byte-identical to cli/evidence.js. These are the discriminators + the in-band trust
// caveat the paid serializeSeal stamps into every seal; reproducing them here (NOT importing cli/) keeps
// the free seal byte-identical without depending on the producer stack. A drift guard in the parity test
// asserts these equal the producer's exported constants, so they can never silently diverge.
// ---------------------------------------------------------------------------

const SEAL_KIND = "vh.evidence-seal";
const SEAL_SCHEMA_VERSION = 1;

// The free SAMPLE size: how many files an UNLICENSED packet may seal. The free seal core refuses to mint a
// packet over this cap — sealing more is the paid `evidence_unlimited` entitlement, which stays in the
// producer stack. Kept byte-identical to cli/evidence.js#SAMPLE_LIMIT (drift-guarded in the parity test).
const SAMPLE_LIMIT = 25;

// The TRUST-BOUNDARIES one-liner, byte-for-byte identical to cli/evidence.js#EVIDENCE_TRUST_NOTE. It is the
// load-bearing honesty of the artifact and is committed into the seal bytes, so it MUST match exactly.
const EVIDENCE_TRUST_NOTE =
  "This evidence seal is TAMPER-EVIDENT + OFFLINE-RECOMPUTABLE, NOT a trusted timestamp. Its Merkle " +
  "`root` commits to the full set of (relPath, content) pairs in the directory: any edit, rename, add, " +
  "or remove changes the root, and verify RE-DERIVES the root from the bytes you hold and LOCALIZES the " +
  "change to the exact file (MATCH / CHANGED / MISSING / UNEXPECTED). It does NOT prove WHEN the sealing " +
  'happened ("sealed at T" rides the human-owned signing/timestamp trust-root, STRATEGY.md P-3) and it ' +
  "is NOT a legal opinion. The packet is an UNTRUSTED transport container: verify never trusts the " +
  "packet's own stored hashes.";

// ---------------------------------------------------------------------------
// A NAMED error so a caller/test catches ONE free-seal error rather than a bare Error or a TypeError leaking
// from the hasher. A malformed entry set raises this rather than being silently coerced or partly accepted.
// ---------------------------------------------------------------------------

class FreeSealError extends Error {
  constructor(message) {
    super(message);
    this.name = "FreeSealError";
  }
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// _normalizeEntries(params) — STRICT validation + normalization of the caller-supplied flat file set into
// the ordered { relPath, bytes } list the hasher consumes. Same per-entry strictness the producer's
// packetseal._normalizeEntries enforces (non-empty relPath, unique across the set, Buffer/Uint8Array bytes),
// and the free-tier-only constraints: a non-empty set capped at SAMPLE_LIMIT files. Throws FreeSealError on
// the FIRST problem; never half-accepts.
// ---------------------------------------------------------------------------

function _normalizeEntries(params) {
  if (!isPlainObject(params)) {
    throw new FreeSealError("buildEvidenceSeal requires a { entries } object");
  }
  const raw = Array.isArray(params.entries) ? params.entries : null;
  if (raw === null) {
    throw new FreeSealError("evidence seal `entries` must be an array of { relPath, bytes }");
  }
  if (raw.length === 0) {
    throw new FreeSealError("evidence seal `entries` must be a non-empty array of { relPath, bytes }");
  }
  if (raw.length > SAMPLE_LIMIT) {
    throw new FreeSealError(
      `the free evidence seal is limited to ${SAMPLE_LIMIT} files (got ${raw.length}); sealing more ` +
        "is the paid `evidence_unlimited` entitlement in the full verifyhash CLI (`vh evidence seal`)."
    );
  }

  const seen = new Set();
  const entries = raw.map((e) => {
    if (!isPlainObject(e)) {
      throw new FreeSealError("evidence seal entry must be an object with relPath + bytes");
    }
    if (typeof e.relPath !== "string" || e.relPath.length === 0) {
      throw new FreeSealError("evidence seal entry relPath must be a non-empty string");
    }
    // FAIL-CLOSED on non-canonical relPaths (see RELPATH CONTRACT above). A relPath that toPosixRel would
    // change (a backslash separator, a leading "./") does NOT byte-match the paid producer's normalization,
    // so we refuse it BEFORE the dedup/hash rather than silently mint a non-parity seal. Checked against the
    // SAME merkle.toPosixRel the leaf/root math uses, so the guard and the hashing can never disagree.
    if (e.relPath !== merkle.toPosixRel(e.relPath)) {
      throw new FreeSealError(
        `evidence seal entry relPath must be canonical POSIX form (forward slashes, no leading "./"): ` +
          `got ${JSON.stringify(e.relPath)}, expected ${JSON.stringify(merkle.toPosixRel(e.relPath))}. ` +
          "Normalize relPaths before sealing (a POSIX directory walk already does this); the free core " +
          "refuses non-canonical paths so its seal stays byte-identical to the paid CLI."
      );
    }
    if (seen.has(e.relPath)) {
      throw new FreeSealError(
        `evidence seal has a duplicate relPath across the file set: ${JSON.stringify(e.relPath)} ` +
          "(every entry must occupy a distinct path)"
      );
    }
    seen.add(e.relPath);
    if (!(e.bytes instanceof Uint8Array) && !Buffer.isBuffer(e.bytes)) {
      throw new FreeSealError(
        `evidence seal entry ${JSON.stringify(e.relPath)} bytes must be a Buffer/Uint8Array ` +
          "(the core is I/O-free; the caller reads the file and hands in its bytes)"
      );
    }
    const bytes = Buffer.isBuffer(e.bytes) ? e.bytes : Buffer.from(e.bytes);
    return { relPath: e.relPath, bytes };
  });
  return entries;
}

// Stable string comparator matching cli/core/packetseal.js#buildSeal's file sort (and serializeSeal's
// emitted order): relPath ascending by JS string comparison. Kept in ONE place so build + serialize agree.
function _byRelPath(a, b) {
  return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;
}

// ---------------------------------------------------------------------------
// buildEvidenceSeal({ entries }) — mint a BARE, UNSIGNED evidence seal object from a flat { relPath, bytes }
// entry list. PURE + deterministic: same { relPath, bytes } set -> byte-identical seal, regardless of the
// caller's array order (the files array is emitted sorted by relPath).
//
// Each file's per-record fields are re-derived via the ALREADY-VENDORED ./merkle convention (the SAME math
// cli/hash.js computes with ethers, cross-checked byte-for-byte in test/verifier.cli.test.js):
//   contentHash = keccak256(bytes)                         (merkle.hashBytes)
//   leaf        = keccak256(DIR_LEAF_DOMAIN ++ relPath ++ 0x00 ++ contentHash)   (merkle.pathLeaf)
//   root        = sorted-leaf, domain-separated Merkle root over the path-bound leaves (merkle.rootFromFlat)
//
// Returns: { kind, schemaVersion, note, root, fileCount, files: [{ relPath, contentHash, leaf }] }
// — the EXACT shape + key order cli/evidence.js#serializeSeal emits, so serializeEvidenceSeal(...) below is
// byte-identical to the paid path.
// ---------------------------------------------------------------------------

function buildEvidenceSeal(params) {
  const entries = _normalizeEntries(params);

  // Per-file (contentHash, leaf), sorted by relPath so the seal bytes are deterministic regardless of the
  // caller's input order — exactly as the producer's buildSeal sorts its emitted `files`.
  const files = entries
    .map((e) => {
      const contentHash = merkle.hashBytes(e.bytes);
      const leaf = merkle.pathLeaf(e.relPath, contentHash);
      return { relPath: e.relPath, contentHash, leaf };
    })
    .sort(_byRelPath);

  // The root is re-derived from the SAME (relPath, contentHash) leaves the producer commits to. Order does
  // not affect the root (rootFromLeaves sorts the leaves), but we feed the already-sorted list for clarity.
  const root = merkle.rootFromFlat(files.map((f) => ({ relPath: f.relPath, contentHash: f.contentHash })));

  return {
    kind: SEAL_KIND,
    schemaVersion: SEAL_SCHEMA_VERSION,
    note: EVIDENCE_TRUST_NOTE,
    root,
    fileCount: files.length,
    files,
  };
}

// ---------------------------------------------------------------------------
// serializeEvidenceSeal(seal) — the canonical, byte-deterministic serialization (newline-terminated),
// byte-identical to cli/evidence.js#serializeSeal. Emits an EXPLICIT ordered object literal (top-level key
// order kind, schemaVersion, note, root, fileCount, files; per-file relPath, contentHash, leaf), no
// insignificant whitespace, a single trailing "\n". Accepts the object buildEvidenceSeal returned (or any
// structurally equivalent seal); does NOT re-validate (the producer's serializeSeal validates first, but the
// free path always serializes a seal it just built, so the structure is known-good).
// ---------------------------------------------------------------------------

function serializeEvidenceSeal(seal) {
  if (!isPlainObject(seal)) {
    throw new FreeSealError("serializeEvidenceSeal requires a seal object");
  }
  if (!Array.isArray(seal.files)) {
    throw new FreeSealError("serializeEvidenceSeal requires a seal with a `files` array");
  }
  const canonical = {
    kind: seal.kind,
    schemaVersion: seal.schemaVersion,
    note: seal.note,
    root: seal.root,
    fileCount: seal.fileCount,
    files: seal.files.map((e) => ({
      relPath: e.relPath,
      contentHash: e.contentHash,
      leaf: e.leaf,
    })),
  };
  return JSON.stringify(canonical) + "\n";
}

module.exports = {
  SEAL_KIND,
  SEAL_SCHEMA_VERSION,
  SAMPLE_LIMIT,
  EVIDENCE_TRUST_NOTE,
  FreeSealError,
  buildEvidenceSeal,
  serializeEvidenceSeal,
};

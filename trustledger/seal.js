"use strict";

// TrustLedger — seal.js  (EPIC-26, T-26.1)
//
// THE RECONCILIATION SEAL — a tamper-evident, content-addressed wrapper around a
// reconciliation packet, built on the project's ORIGINAL provenance core.
//
// THE PROBLEM THIS SOLVES.
//   `vh trust reconcile --out <dir>` writes the audit-ready HTML+CSV packet a broker
//   hands a state real-estate examiner months later. That packet is a PRINTOUT: nothing
//   lets the examiner (or the broker defending themselves) prove "this is the EXACT packet
//   TrustLedger produced from these EXACT source files, byte-for-byte unaltered." A text
//   editor can silently rewrite a dollar figure and nothing detects it. `close.js`'s
//   `inputsDigest` is a SHA-256 over the close SUMMARY only — by its own NatSpec "NOT a
//   cryptographic proof of the underlying source files." So the lead product's headline
//   deliverable ships UNSEALED.
//
// THE MOVE — reuse the proven manifest/attestation core VERBATIM.
//   This module REQUIRES `cli/core/manifest.js` and does NOT re-implement hashing or leaf
//   construction. It binds {the SOURCE inputs (bank / book / rentroll), partitioned by their
//   logical ROLE} + {every packet file the reconcile EMITTED} into ONE content-addressed
//   seal: a versioned, strictly-validated object recording, per file, its role/relPath +
//   content hash, plus a single top-level Merkle root over the WHOLE set computed by the SAME
//   path-bound, domain-separated convention `vh hash <dir>` and the on-chain `verifyLeaf` use
//   (so the root re-derives, NO new crypto, NO contract change, NO network, NO key). The seal
//   also carries the reconcile's PASS/FAIL verdict + report date as RECORDED FACTS, so the
//   seal NAMES what it sealed.
//
// PURE + I/O-FREE.
//   Every helper here is pure: the CALLER (the CLI) does the file READING and hands in
//   already-loaded `{ relPath, bytes }` entries. `buildSeal` / `validateSeal` / `verifySeal`
//   never touch the filesystem, the clock, the network, or a key — given the same inputs they
//   return byte-identical results.
//
// HONEST POSTURE — what the seal DOES and DOES NOT prove.
//   * TAMPER-EVIDENCE (what it DOES prove): the inputs + packet are byte-for-byte what was
//     sealed, AND the recorded reconcile VERDICT (pass/reportDate/period) and each input's logical
//     ROLE are bound into the SAME root. Any edit/rename/add/remove to any sealed file — OR any
//     edit to the verdict/date/period, OR any swap of an input's role — changes the root, and
//     `verifySeal` LOCALIZES a file change to the exact file (MATCH / CHANGED / MISSING /
//     UNEXPECTED) and a verdict/role change to the seal HEADER. The verdict+roles ride the SAME
//     committed structure as the files (a synthetic, reserved HEADER leaf), so the seal's headline
//     PASS/FAIL is tamper-EVIDENT, not a free-floating annotation.
//   * TIMESTAMP (what it does NOT prove): the reportDate is bound into the root so it cannot be
//     edited UNDETECTED, but a bound date is still only a self-asserted RECORDED FACT — the root
//     proves "this date is the one that was sealed", NOT that the sealing actually HAPPENED then. A
//     trusted "sealed at time T" still rides the human-owned trust-root (P-3's signing / timestamp
//     leg). The seal SAYS so and references — never executes — the human-gated sign/timestamp steps.
//   * LEGAL MEANING (what it does NOT prove): the seal does NOT validate whether the
//     reconciliation is CORRECT or COMPLIANT. The CPA review still governs.
//   * UNTRUSTED TRANSPORT CONTAINER: consistent with docs/TRUST-BOUNDARIES.md, the seal is an
//     UNTRUSTED hint. `verifySeal` is AUTHORITATIVE by RE-COMPUTING the manifest/root from the
//     supplied bytes; the seal's stored hashes are merely the EXPECTATION it checks against.
//
//   The seal MAY be WRAPPED by the existing `cli/core/attestation.js` signed-attestation
//   envelope (the seal's canonical bytes become the attestation payload) so a human can vouch
//   for it via the SAME shared signing path — no new scheme. That signature proves WHO vouched,
//   still not a trusted timestamp.

const coreManifest = require("../cli/core/manifest");
const { hashEntries, pathLeaf, hashBytes, buildTree } = require("../cli/hash");

// ---------------------------------------------------------------------------
// Identity. The seal has its OWN `kind`/`schemaVersion`, disjoint from the
// dataset/parcel manifests so a seal can never be confused for one of them.
// `validateSeal` REJECTS any unsupported version rather than guessing.
// ---------------------------------------------------------------------------

const SEAL_KIND = "trustledger.reconcile-seal";
const SEAL_SCHEMA_VERSION = 1;
const SUPPORTED_SEAL_SCHEMA_VERSIONS = Object.freeze([1]);

// Same 0x + 64-hex shape the manifest core validates against — imported from the core so the
// two can never drift.
const HEX32_RE = coreManifest.HEX32_RE;

// A strict "YYYY-MM-DD" report date, identical to the shape close.js / report.js use.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The fixed, ordered set of logical INPUT roles a three-way trust reconciliation consumes. A
// seal's `inputs` must name each role at most once (no duplicate role) and each role must be one
// of these (no unknown role) — so the partition is well-defined and an examiner reads the same
// three sources every time. `book` is the broker's ledger; `rentroll` is the property sub-ledger.
const INPUT_ROLES = Object.freeze(["bank", "book", "rentroll"]);

// The in-band trust caveat carried in EVERY seal, stated in ONE place so it can never drift from
// the NatSpec above. It is the load-bearing honesty of the artifact.
const SEAL_TRUST_NOTE =
  "This reconciliation seal is TAMPER-EVIDENT, not a trusted timestamp and not a legal opinion. Its " +
  "Merkle `root` commits to the full set of (relPath, content) pairs across the source inputs AND " +
  "every emitted packet file, PLUS a reserved HEADER leaf binding the recorded verdict " +
  "(pass/reportDate/period) and each input's logical role: any edit, rename, add, or remove of a " +
  "file — or any edit of the verdict/date/period or swap of an input role — changes the root, and " +
  "verifySeal localizes a file change to the exact file and a verdict/role change to the header. It " +
  "does NOT prove WHEN the sealing actually happened (the bound reportDate cannot be edited " +
  "undetected, but a self-asserted date still rides the human trust-root P-3 — standing up a real " +
  "signing key or timestamp anchor is needs-human) and it does NOT validate the legal MEANING of " +
  "the reconciliation (the CPA review still governs). The seal is an UNTRUSTED transport container: " +
  "verifySeal RE-DERIVES the root from the bytes you supply — it never trusts the seal's own hashes.";

// The reserved relPath of the synthetic HEADER entry that binds the verdict + input roles into the
// SAME committed root as the files. It uses a sentinel that can never collide with a real packet
// file (no real reconcile path begins with this prefix); _normalizeFileSet rejects any caller file
// occupying it, so the header is unforgeable from the file side. The header's "content" is the
// canonical bytes of { verdict, roles } (see _headerBytes), hashed + path-bound by the SAME pathLeaf
// convention every other entry uses — so binding the verdict/roles re-uses the core verbatim, with
// no second hashing scheme.
const SEAL_HEADER_RELPATH = "__trustledger.seal-header__v1";

// ---------------------------------------------------------------------------
// Errors — STRICT. A malformed/ambiguous seal raises a NAMED error rather than
// being silently dropped, coerced, or partially accepted (mirrors close.js).
// ---------------------------------------------------------------------------

class SealError extends Error {
  constructor(message) {
    super(message);
    this.name = "SealError";
  }
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// _headerBytes(verdict, inputs) — the canonical "content" of the synthetic
// HEADER entry that binds the recorded VERDICT + each input's logical ROLE into
// the SAME committed root as the files.
//
// WHY A HEADER ENTRY (not a separate digest). Folding the verdict/roles into a
// reserved leaf means the EXISTING pathLeaf/buildTree convention — used verbatim
// for every real file — also commits to them. There is NO second hashing scheme:
// the header is just one more (relPath, content) pair, so editing verdict.pass,
// reportDate, period, OR swapping an input's role changes the header's content,
// hence its leaf, hence the root. The bare-seal root therefore makes the
// headline PASS/FAIL verdict (and the role partition) tamper-EVIDENT.
//
// The bytes are a deterministic JSON serialization with a FIXED key order: the
// verdict triple, then the role→relPath bindings sorted by role. Deterministic so
// build/validate/verify all recompute byte-identical header content.
// ---------------------------------------------------------------------------

function _headerBytes(verdict, inputs) {
  const canonical = {
    v: 1, // header layout version (lets the bound structure evolve without ambiguity)
    verdict: {
      pass: verdict.pass,
      reportDate: verdict.reportDate,
      period: verdict.period == null ? null : String(verdict.period),
    },
    // The role→relPath bindings, sorted by role so the bytes are order-independent. Binding the
    // relPath here (not just the role) means a role can never be re-pointed at a different sealed
    // file without changing the header content (and thus the root).
    roles: inputs
      .map((i) => ({ role: i.role, relPath: i.relPath }))
      .sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0)),
  };
  return Buffer.from(JSON.stringify(canonical), "utf8");
}

// ---------------------------------------------------------------------------
// Internal: normalize + strictly validate a caller-supplied file set into the
// ordered entry list the seal/manifest are built from.
//
// Each `inputs` entry is { role, relPath, bytes }; each `outputs` entry is
// { relPath, bytes }. relPaths must be unique ACROSS the whole set (an input and
// an output sharing a relPath would make the partition ambiguous and the root
// double-count a name), every `bytes` must be a Buffer/Uint8Array, every input
// role must be a known role used at most once.
//
// Returns { entries, inputs, outputs } where `entries` is the flat
// { role, relPath, bytes } list (role === null for outputs) used to feed the
// shared hasher, ordered inputs-then-outputs for readability (the root itself is
// order-independent — hashEntries sorts internally).
// ---------------------------------------------------------------------------

function _normalizeFileSet(files) {
  if (!isPlainObject(files)) {
    throw new SealError("buildSeal requires a { inputs, outputs } file set object");
  }
  if (!Array.isArray(files.inputs) || files.inputs.length === 0) {
    throw new SealError("seal `inputs` must be a non-empty array of { role, relPath, bytes }");
  }
  if (!Array.isArray(files.outputs) || files.outputs.length === 0) {
    throw new SealError("seal `outputs` must be a non-empty array of { relPath, bytes }");
  }

  const seenRelPath = new Set();
  const seenRole = new Set();

  function takeBytes(e, where) {
    if (!isPlainObject(e)) {
      throw new SealError(`seal ${where} entry must be an object with relPath + bytes`);
    }
    if (typeof e.relPath !== "string" || e.relPath.length === 0) {
      throw new SealError(`seal ${where} entry relPath must be a non-empty string`);
    }
    if (e.relPath === SEAL_HEADER_RELPATH) {
      throw new SealError(
        `seal ${where} entry relPath ${JSON.stringify(e.relPath)} is reserved for the seal header ` +
          "(a real file may not occupy the bound verdict/role header slot)"
      );
    }
    if (seenRelPath.has(e.relPath)) {
      throw new SealError(
        `seal has a duplicate relPath across the file set: ${JSON.stringify(e.relPath)} ` +
          "(every input and output must occupy a distinct path)"
      );
    }
    seenRelPath.add(e.relPath);
    if (!(e.bytes instanceof Uint8Array) && !Buffer.isBuffer(e.bytes)) {
      throw new SealError(
        `seal ${where} entry ${JSON.stringify(e.relPath)} bytes must be a Buffer/Uint8Array ` +
          "(seal.js is I/O-free; the caller reads the file and hands in its bytes)"
      );
    }
    return Buffer.isBuffer(e.bytes) ? e.bytes : Buffer.from(e.bytes);
  }

  const inputs = files.inputs.map((e) => {
    const bytes = takeBytes(e, "inputs");
    if (!INPUT_ROLES.includes(e.role)) {
      throw new SealError(
        `seal input role must be one of ${JSON.stringify(INPUT_ROLES)}, got: ${JSON.stringify(e.role)}`
      );
    }
    if (seenRole.has(e.role)) {
      throw new SealError(`seal has a duplicate input role: ${JSON.stringify(e.role)}`);
    }
    seenRole.add(e.role);
    return { role: e.role, relPath: e.relPath, bytes };
  });

  const outputs = files.outputs.map((e) => {
    const bytes = takeBytes(e, "outputs");
    return { role: null, relPath: e.relPath, bytes };
  });

  return { inputs, outputs, entries: [...inputs, ...outputs] };
}

// ---------------------------------------------------------------------------
// Internal: compute the manifest (root + per-file leaf/contentHash) over the
// whole file set by REUSING the existing core VERBATIM — `cli/hash.js`
// `hashEntries` for the path-bound Merkle root, then `cli/core/manifest.js`
// `buildItemManifest` for the strict, content-addressed manifest object. NO
// hashing or leaf construction is re-implemented here.
//
// Returns { manifest, byRelPath } where byRelPath maps relPath ->
// { relPath, contentHash, leaf } so the seal can attach the per-file role.
// ---------------------------------------------------------------------------

function _manifestOver(entries) {
  // hashEntries takes { path, content } and returns { root, leaves:[{path,contentHash,leaf}] }
  // computed with pathLeaf/buildTree/leafHash/nodeHash — the EXACT convention the contract's
  // verifyLeaf accepts. We then hand that shape to the manifest core's strict builder.
  const built = hashEntries(entries.map((e) => ({ path: e.relPath, content: e.bytes })));
  const manifest = coreManifest.buildItemManifest(built, MANIFEST_CFG);
  const byRelPath = new Map();
  for (const f of manifest.files) {
    byRelPath.set(f.relPath, { relPath: f.relPath, contentHash: f.contentHash, leaf: f.leaf });
  }
  return { manifest, byRelPath };
}

// _committedEntries(fileEntries, verdict, inputs) — the FULL ordered list the root commits to: every
// real file PLUS the synthetic HEADER entry binding (verdict, role→relPath). Every caller of the
// hasher routes through here so build/validate/verify commit to the SAME structure — the verdict and
// roles are part of the committed set, not a free-floating annotation. The header is one more
// { relPath, content } pair fed to the SAME hashEntries convention; no second hashing scheme.
function _committedEntries(fileEntries, verdict, inputs) {
  return [
    ...fileEntries,
    { role: null, relPath: SEAL_HEADER_RELPATH, bytes: _headerBytes(verdict, inputs) },
  ];
}

// The seal's manifest framing, passed to the GENERIC core builder/validator. The core does the
// shared Merkle/manifest math + structural validation; this supplies ONLY the seal-specific
// framing (kind/schema/note/label). This is the SAME pattern DataLedger/ProofParcel use.
const MANIFEST_CFG = Object.freeze({
  kind: "trustledger.reconcile-seal-manifest",
  schemaVersion: 1,
  supportedSchemaVersions: [1],
  note: coreManifest.TRUST_NOTE,
  label: "reconciliation seal manifest",
});

// ---------------------------------------------------------------------------
// buildSeal({ files, verdict }) — assemble + strictly validate a seal.
//
// `files` is { inputs:[{role,relPath,bytes}], outputs:[{relPath,bytes}] } (the
// caller read these). `verdict` is the recorded reconcile facts:
//   { pass: boolean, reportDate: "YYYY-MM-DD", period?: string|null }
//
// PURE + deterministic: same files + verdict -> byte-identical seal (the root is
// order-independent; the per-file lists are emitted role-then-relPath sorted).
// ---------------------------------------------------------------------------

function buildSeal(params) {
  if (!isPlainObject(params)) {
    throw new SealError("buildSeal requires { files, verdict }");
  }
  const { inputs, outputs, entries } = _normalizeFileSet(params.files);

  const verdict = params.verdict;
  if (!isPlainObject(verdict)) {
    throw new SealError("buildSeal requires a `verdict` { pass, reportDate } object");
  }
  if (typeof verdict.pass !== "boolean") {
    throw new SealError("seal verdict.pass must be a boolean (the reconcile PASS/FAIL fact)");
  }
  if (!DATE_RE.test(String(verdict.reportDate || ""))) {
    throw new SealError('seal verdict.reportDate must be a "YYYY-MM-DD" string');
  }
  if (
    verdict.period !== undefined &&
    verdict.period !== null &&
    typeof verdict.period !== "string"
  ) {
    throw new SealError("seal verdict.period, when present, must be a string or null");
  }

  // Re-derive the manifest/root over the WHOLE committed set — every real file PLUS the synthetic
  // HEADER entry binding the verdict + role→relPath — via the shared core (no re-implementation). The
  // header makes the verdict/roles part of the same committed root as the files.
  const committed = _committedEntries(entries, verdict, inputs);
  const { manifest, byRelPath } = _manifestOver(committed);

  // Attach the per-file role to each manifest leaf, partitioned back into inputs/outputs. Emit
  // inputs in the FIXED INPUT_ROLES order and outputs sorted by relPath, so the seal bytes are
  // deterministic regardless of the caller's array order.
  const sealInputs = INPUT_ROLES.filter((r) => inputs.some((i) => i.role === r)).map((r) => {
    const src = inputs.find((i) => i.role === r);
    const leaf = byRelPath.get(src.relPath);
    return { role: r, relPath: leaf.relPath, contentHash: leaf.contentHash, leaf: leaf.leaf };
  });
  const sealOutputs = outputs
    .map((o) => {
      const leaf = byRelPath.get(o.relPath);
      return { relPath: leaf.relPath, contentHash: leaf.contentHash, leaf: leaf.leaf };
    })
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const seal = {
    kind: SEAL_KIND,
    schemaVersion: SEAL_SCHEMA_VERSION,
    note: SEAL_TRUST_NOTE,
    // The single top-level content-addressed root over the WHOLE committed set: inputs + outputs +
    // the synthetic header (verdict + role bindings). The header is NOT listed below — it is
    // re-derived deterministically from verdict/roles on validate/verify — so `fileCount` counts only
    // the real files (inputs + outputs).
    root: manifest.root,
    fileCount: entries.length,
    // The recorded reconcile facts — what this seal NAMES that it sealed. These are FACTS the
    // seal carries, NOT proofs (see SEAL_TRUST_NOTE / the NatSpec timestamp caveat).
    verdict: {
      pass: verdict.pass,
      reportDate: verdict.reportDate,
      period: verdict.period == null ? null : String(verdict.period),
    },
    inputs: sealInputs,
    outputs: sealOutputs,
  };

  // Self-check: the artifact we just built must itself validate, so build/validate stay in
  // lock-step and a build can never emit something read back as corrupt.
  validateSeal(seal);
  return seal;
}

// ---------------------------------------------------------------------------
// validateSeal(obj) — STRICT structural + self-consistency validation. Throws a
// named SealError on the FIRST problem; returns the object unchanged on success.
//
// REJECTS: a wrong kind / schemaVersion; a missing/garbled verdict; a missing or
// duplicate input role; an unknown role; a malformed hex contentHash/leaf/root; a
// per-file leaf inconsistent with its (relPath, contentHash); a top-level `root`
// that does NOT re-derive from the listed entries via the SAME manifest
// convention. It NEVER silently accepts a partial/corrupt seal.
// ---------------------------------------------------------------------------

function validateSeal(obj) {
  if (!isPlainObject(obj)) {
    throw new SealError("seal must be a JSON object");
  }
  if (obj.kind !== SEAL_KIND) {
    throw new SealError(
      `not a trustledger reconciliation seal (kind: ${JSON.stringify(obj.kind)}; expected ` +
        `${JSON.stringify(SEAL_KIND)})`
    );
  }
  if (!SUPPORTED_SEAL_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new SealError(
      `unsupported seal schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(SUPPORTED_SEAL_SCHEMA_VERSIONS)})`
    );
  }
  if (obj.note !== SEAL_TRUST_NOTE) {
    throw new SealError("seal `note` must be the standing SEAL_TRUST_NOTE (caveat must not drift)");
  }
  if (typeof obj.root !== "string" || !HEX32_RE.test(obj.root)) {
    throw new SealError(
      `seal root must be a 0x-prefixed 32-byte hex string, got: ${String(obj.root)}`
    );
  }

  // verdict — recorded reconcile facts.
  if (!isPlainObject(obj.verdict)) {
    throw new SealError("seal is missing `verdict` { pass, reportDate }");
  }
  if (typeof obj.verdict.pass !== "boolean") {
    throw new SealError("seal verdict.pass must be a boolean");
  }
  if (!DATE_RE.test(String(obj.verdict.reportDate || ""))) {
    throw new SealError('seal verdict.reportDate must be a "YYYY-MM-DD" string');
  }
  if (!("period" in obj.verdict)) {
    throw new SealError("seal verdict is missing `period` (may be null)");
  }
  if (obj.verdict.period !== null && typeof obj.verdict.period !== "string") {
    throw new SealError("seal verdict.period must be a string or null");
  }

  if (!Array.isArray(obj.inputs) || obj.inputs.length === 0) {
    throw new SealError("seal `inputs` must be a non-empty array");
  }
  if (!Array.isArray(obj.outputs) || obj.outputs.length === 0) {
    throw new SealError("seal `outputs` must be a non-empty array");
  }

  // Per-file structural + leaf self-consistency, plus relPath-uniqueness ACROSS the whole set and
  // role-uniqueness within inputs. We collect the flat (relPath, contentHash) list so the root can
  // be re-derived below from the SAME convention.
  const seenRelPath = new Set();
  const seenRole = new Set();
  const flat = []; // { relPath, contentHash }

  function checkLeafEntry(entry, where, i) {
    if (!isPlainObject(entry)) {
      throw new SealError(`seal ${where}[${i}] must be an object`);
    }
    if (typeof entry.relPath !== "string" || entry.relPath.length === 0) {
      throw new SealError(`seal ${where}[${i}].relPath must be a non-empty string`);
    }
    if (seenRelPath.has(entry.relPath)) {
      throw new SealError(
        `seal has a duplicate relPath across the file set: ${JSON.stringify(entry.relPath)}`
      );
    }
    seenRelPath.add(entry.relPath);
    for (const f of ["contentHash", "leaf"]) {
      if (typeof entry[f] !== "string" || !HEX32_RE.test(entry[f])) {
        throw new SealError(
          `seal ${where}[${i}].${f} must be a 0x-prefixed 32-byte hex string, got: ${String(entry[f])}`
        );
      }
    }
    // Re-derive the path-bound leaf from (relPath, contentHash) via the SHARED pathLeaf, and reject
    // a leaf tampered with independently of its relPath/contentHash — the same structural check the
    // manifest core makes.
    const expectedLeaf = pathLeaf(entry.relPath, entry.contentHash);
    if (entry.leaf.toLowerCase() !== expectedLeaf.toLowerCase()) {
      throw new SealError(
        `seal ${where}[${i}].leaf is inconsistent with its relPath+contentHash ` +
          `(expected ${expectedLeaf}, got ${entry.leaf})`
      );
    }
    flat.push({ relPath: entry.relPath, contentHash: entry.contentHash });
  }

  // The input role→relPath bindings, collected so the header (which commits to them) can be
  // re-derived for the root check below.
  const inputBindings = []; // { role, relPath }
  obj.inputs.forEach((entry, i) => {
    checkLeafEntry(entry, "inputs", i);
    if (!INPUT_ROLES.includes(entry.role)) {
      throw new SealError(
        `seal inputs[${i}].role must be one of ${JSON.stringify(INPUT_ROLES)}, got: ` +
          `${JSON.stringify(entry.role)}`
      );
    }
    if (seenRole.has(entry.role)) {
      throw new SealError(`seal has a duplicate input role: ${JSON.stringify(entry.role)}`);
    }
    seenRole.add(entry.role);
    inputBindings.push({ role: entry.role, relPath: entry.relPath });
  });
  obj.outputs.forEach((entry, i) => {
    checkLeafEntry(entry, "outputs", i);
    if (entry.role !== undefined && entry.role !== null) {
      throw new SealError(
        `seal outputs[${i}] must not carry a role (roles partition INPUTS only), got: ` +
          `${JSON.stringify(entry.role)}`
      );
    }
  });

  // fileCount, when present, must agree with the actual entry total.
  const total = obj.inputs.length + obj.outputs.length;
  if (obj.fileCount !== undefined && obj.fileCount !== total) {
    throw new SealError(
      `seal fileCount (${String(obj.fileCount)}) does not match the entry total (${total})`
    );
  }

  // THE LOAD-BEARING CHECK: the top-level `root` must RE-DERIVE from the listed (relPath,
  // contentHash) file entries PLUS the synthetic HEADER entry that binds the verdict + role
  // bindings — via the SAME path-bound Merkle convention the manifest core uses (pathLeaf/buildTree).
  // We append the header's (relPath, contentHash) — recomputed from the seal's OWN verdict + input
  // role bindings — to the leaf set and require the recomputed root byte-identical to obj.root. A
  // seal whose root was edited to mask a changed file is caught here, AND so is one whose verdict
  // (pass/reportDate/period) or input role was edited: that changes the header content → its leaf →
  // the root, which no longer re-derives. The verdict/roles are thus tamper-EVIDENT in the BARE seal.
  const headerContentHash = hashBytes(_headerBytes(obj.verdict, inputBindings));
  const committedFlat = [
    ...flat,
    { relPath: SEAL_HEADER_RELPATH, contentHash: headerContentHash },
  ];
  const rederived = _rootFromLeafEntries(committedFlat);
  if (rederived.toLowerCase() !== obj.root.toLowerCase()) {
    throw new SealError(
      `seal root does not re-derive from its listed entries + verdict/role header ` +
        `(expected ${rederived}, got ${obj.root}) — the seal is internally inconsistent ` +
        "(a file, the verdict, or an input role was edited without updating the root)"
    );
  }

  return obj;
}

// Internal: re-derive the top-level root from a flat list of { relPath, contentHash } using the
// SAME convention as buildSeal — pathLeaf for each, then buildTree — via the shared hash module.
// We reuse `buildTree` (the exact builder hashEntries uses) so this stays a re-derivation of the
// same math, never a parallel implementation.
function _rootFromLeafEntries(flat) {
  const leaves = flat.map((e) => pathLeaf(e.relPath, e.contentHash));
  return buildTree(leaves).root;
}

/**
 * committedLeaves(seal) — the FULL ordered { relPath, contentHash } list the seal's `root` commits
 * to: every listed file (inputs + outputs) PLUS the synthetic verdict/role HEADER entry (recomputed
 * from the seal's own verdict + input role bindings). Validates the seal first. This is the seal's
 * AUTHORITATIVE committed set: `buildTree(map(pathLeaf))` over it re-derives `seal.root` byte-for-byte
 * via the SAME shared convention — so a caller (or a test) can prove the root commits to the verdict
 * and roles, not just the files. PURE.
 *
 * @param {object} seal a seal (validated here)
 * @returns {{ relPath: string, contentHash: string }[]}
 */
function committedLeaves(seal) {
  validateSeal(seal);
  const flat = [];
  for (const e of seal.inputs) flat.push({ relPath: e.relPath, contentHash: e.contentHash });
  for (const e of seal.outputs) flat.push({ relPath: e.relPath, contentHash: e.contentHash });
  const inputBindings = seal.inputs.map((e) => ({ role: e.role, relPath: e.relPath }));
  flat.push({
    relPath: SEAL_HEADER_RELPATH,
    contentHash: hashBytes(_headerBytes(seal.verdict, inputBindings)),
  });
  return flat;
}

// ---------------------------------------------------------------------------
// readSeal(text|obj) — parse + validate a seal (JSON string or object). STRICT:
// a parse error is a SealError (never a raw SyntaxError); a partial/corrupt seal
// is rejected by validateSeal, never half-accepted.
// ---------------------------------------------------------------------------

function readSeal(input) {
  let obj;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch (e) {
      throw new SealError(`seal is not valid JSON: ${e.message}`);
    }
  } else if (isPlainObject(input)) {
    obj = input;
  } else {
    throw new SealError("readSeal requires a JSON string or a seal object");
  }
  validateSeal(obj);
  return obj;
}

// ---------------------------------------------------------------------------
// serializeSeal(seal) — canonical, byte-deterministic serialization: a FIXED
// top-level + per-entry key order, NO insignificant whitespace, a single
// trailing newline. Two runs over the same seal produce an identical string —
// this is the property that makes the seal's bytes well-defined as a signing
// payload (see signSealWith / the attestation codec below).
// ---------------------------------------------------------------------------

function serializeSeal(seal) {
  validateSeal(seal);
  const canonical = {
    kind: seal.kind,
    schemaVersion: seal.schemaVersion,
    note: seal.note,
    root: seal.root,
    fileCount: seal.fileCount,
    verdict: {
      pass: seal.verdict.pass,
      reportDate: seal.verdict.reportDate,
      period: seal.verdict.period,
    },
    inputs: seal.inputs.map((e) => ({
      role: e.role,
      relPath: e.relPath,
      contentHash: e.contentHash,
      leaf: e.leaf,
    })),
    outputs: seal.outputs.map((e) => ({
      relPath: e.relPath,
      contentHash: e.contentHash,
      leaf: e.leaf,
    })),
  };
  return JSON.stringify(canonical) + "\n";
}

// ---------------------------------------------------------------------------
// verifySeal(seal, files) — the AUTHORITATIVE, PURE verify.
//
// Recompute the per-file content hashes + the manifest root from the SUPPLIED
// `{ relPath, bytes }` set (`files` is the SAME { inputs, outputs } shape buildSeal
// took) and compare them, per file, against the seal's stored EXPECTATION. The
// authoritative check is the RECOMPUTE: the seal is an untrusted container, so a
// verdict is decided by the bytes the caller holds, never by the seal's own hashes.
//
// Returns a structured result naming EXACTLY which files:
//   * MATCH      — present in both, recomputed contentHash equals the sealed one
//   * CHANGED    — present in both, recomputed contentHash DIFFERS (tamper localized)
//   * MISSING    — sealed, but absent from the supplied set
//   * UNEXPECTED — supplied, but not named in the seal
// plus, because the role bindings are committed into the root too, any file present in BOTH whose
// SUPPLIED role differs from its SEALED role is surfaced as a `roleMismatch` (a bank↔book swap is
// caught and localized, not silently accepted). The overall verdict is ACCEPTED only when every
// sealed file MATCHes, none is MISSING/UNEXPECTED, no role mismatched, AND the recomputed root —
// computed over the supplied files PLUS the verdict/role header — equals the sealed root; otherwise
// REJECTED. The recomputed header uses the seal's recorded verdict + the SUPPLIED role bindings, so a
// role swap changes the recomputed root and `rootMatches` goes false. rootMatches is reported
// separately for transparency.
//
// PURE: no I/O, no key, no network, no clock.
// ---------------------------------------------------------------------------

function verifySeal(seal, files) {
  // The seal must itself be structurally sound before we trust its EXPECTATIONS as a comparison
  // basis (a corrupt seal is rejected loudly, not silently treated as "everything changed").
  validateSeal(seal);

  const { inputs, outputs, entries } = _normalizeFileSet(files);

  // Recompute the manifest/root over the supplied bytes via the SAME shared core — this is the
  // authoritative computation. The recomputed ROOT also folds in the synthetic header built from the
  // seal's recorded verdict + the SUPPLIED input role bindings, so a swapped role (or a supplied set
  // whose roles disagree with the sealed roles) yields a different recomputed root → rootMatches:false.
  const { byRelPath: suppliedByRel } = _manifestOver(entries);
  const recomputedRoot = _rootFromSupplied(_committedEntries(entries, seal.verdict, inputs));

  // Map the supplied set's relPath -> { role, recomputedContentHash }. Role is the input role (for
  // inputs) so the result can name "the bank input changed", not just a path.
  const suppliedRole = new Map();
  for (const e of [...inputs, ...outputs]) suppliedRole.set(e.relPath, e.role);

  // Sealed expectation: relPath -> { role, contentHash }.
  const sealedByRel = new Map();
  for (const e of seal.inputs) sealedByRel.set(e.relPath, { role: e.role, contentHash: e.contentHash });
  for (const e of seal.outputs) sealedByRel.set(e.relPath, { role: null, contentHash: e.contentHash });

  const matched = [];
  const changed = [];
  const missing = [];
  const unexpected = [];
  const roleMismatches = []; // { relPath, sealedRole, suppliedRole }

  // Walk the SEALED set: each sealed file is MATCH / CHANGED / MISSING.
  for (const [relPath, exp] of sealedByRel) {
    const supplied = suppliedByRel.get(relPath);
    if (!supplied) {
      missing.push({ relPath, role: exp.role });
      continue;
    }
    // A file present in both: surface a ROLE swap (sealed role vs supplied role) for this path. The
    // header binding already forces rootMatches:false on any swap; this LOCALIZES which path's role
    // changed so the caller can name "bank↔book swapped", not just "root drifted".
    const suppliedR = suppliedRole.get(relPath) == null ? null : suppliedRole.get(relPath);
    if (suppliedR !== exp.role) {
      roleMismatches.push({ relPath, sealedRole: exp.role, suppliedRole: suppliedR });
    }
    if (supplied.contentHash.toLowerCase() === exp.contentHash.toLowerCase()) {
      matched.push({ relPath, role: exp.role, contentHash: supplied.contentHash });
    } else {
      changed.push({
        relPath,
        role: exp.role,
        expectedContentHash: exp.contentHash,
        actualContentHash: supplied.contentHash,
      });
    }
  }

  // Any supplied file NOT named in the seal is UNEXPECTED.
  for (const [relPath, recomputed] of suppliedByRel) {
    if (!sealedByRel.has(relPath)) {
      unexpected.push({ relPath, role: suppliedRole.get(relPath), contentHash: recomputed.contentHash });
    }
  }

  // Sort each list by relPath so the result is deterministic regardless of input order.
  const byRel = (a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);
  matched.sort(byRel);
  changed.sort(byRel);
  missing.sort(byRel);
  unexpected.sort(byRel);
  roleMismatches.sort(byRel);

  const rootMatches = recomputedRoot.toLowerCase() === seal.root.toLowerCase();
  const accepted =
    changed.length === 0 &&
    missing.length === 0 &&
    unexpected.length === 0 &&
    roleMismatches.length === 0 &&
    rootMatches;

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
      roleMismatched: roleMismatches.length,
    },
    matched,
    changed,
    missing,
    unexpected,
    roleMismatches,
  };
}

// Internal: recompute the top-level root from the SUPPLIED { role, relPath, bytes } entries via the
// SAME convention buildSeal used (hashEntries). Kept separate so verifySeal's root is always the
// authoritative re-derivation from bytes, never copied from the seal.
function _rootFromSupplied(entries) {
  const built = hashEntries(entries.map((e) => ({ path: e.relPath, content: e.bytes })));
  return built.root;
}

// ---------------------------------------------------------------------------
// SIGNED-attestation WRAP (optional). The seal MAY be wrapped by the EXISTING
// `cli/core/attestation.js` envelope so a human can vouch for it via the SAME
// shared signing path — NO new scheme. The seal's CANONICAL bytes (serializeSeal)
// become the attestation payload. We expose the product's framing + thin wrappers
// over the core, exactly as DataLedger does, and a `signSealWith(seal, signer)`
// convenience that round-trips through recoverSigner / verifySignedAttestation.
//
// The signature proves WHO vouched for the seal — still NOT a trusted timestamp
// (P-3) and still NOT a legal opinion (the CPA review governs).
// ---------------------------------------------------------------------------

const coreAttestation = require("../cli/core/attestation");

const SIGNED_SEAL_KIND = "trustledger.reconcile-seal-signed";
const SIGNED_SEAL_SCHEMA_VERSION = 1;
const SUPPORTED_SIGNED_SEAL_SCHEMA_VERSIONS = Object.freeze([1]);

const SIGNED_SEAL_TRUST_NOTE =
  "This is a SIGNED reconciliation-seal container: it WRAPS (never edits) the EXACT canonical seal " +
  "bytes in `attestation` and attaches a detached EIP-191 signature. It asserts the holder of the " +
  "`signer` key vouched for THIS sealed packet (the embedded root + verdict) at signing time. It does " +
  "NOT prove a timestamp (no \"sealed since date T\" — still the human trust-root P-3) and does NOT " +
  "validate the legal MEANING of the reconciliation (the CPA review governs). Every caveat of the " +
  "embedded seal applies. " +
  SEAL_TRUST_NOTE;

// The attestation core re-validates and re-serializes the EMBEDDED payload through these, enforcing
// the wrap-don't-edit invariant. `validateUnsigned` must reject anything that is not a sound seal;
// `serializeUnsigned` must emit the EXACT canonical bytes that were signed.
const SIGNED_SEAL_CFG = Object.freeze({
  kind: SIGNED_SEAL_KIND,
  schemaVersion: SIGNED_SEAL_SCHEMA_VERSION,
  supportedSchemaVersions: SUPPORTED_SIGNED_SEAL_SCHEMA_VERSIONS,
  note: SIGNED_SEAL_TRUST_NOTE,
  label: "signed reconciliation seal",
  validateUnsigned: validateSeal,
  serializeUnsigned: serializeSeal,
});

/** Strictly validate a parsed SIGNED-seal container — thin wrapper over the shared core. */
function validateSignedSeal(obj) {
  return coreAttestation.validateSignedAttestation(obj, SIGNED_SEAL_CFG);
}

/** Serialize a SIGNED-seal container to its canonical bytes — thin wrapper over the shared core. */
function serializeSignedSeal(container) {
  return coreAttestation.serializeSignedAttestation(container, SIGNED_SEAL_CFG);
}

/** Recover the signing address from a SIGNED-seal container — the shared, PURE core recovery. */
function recoverSigner(container) {
  return coreAttestation.recoverSigner(container);
}

/**
 * Verify a SIGNED-seal container OFFLINE — thin wrapper over the shared core verifier. Optionally pins
 * the expected signer and/or binds the embedded payload to a caller-recomputed canonical seal string.
 * @param {object} params { container, [expectedSigner], [expectedCanonical] }
 */
function verifySignedSeal(params) {
  return coreAttestation.verifySignedAttestation(params);
}

/**
 * Sign a validated seal with a caller-supplied ethers signer-like object and WRAP it into a validated
 * SIGNED-seal container — the SAME shared signing path the rest of the family uses (no key handling
 * here; the key lives only inside the signer). The container ROUND-TRIPS by construction:
 * verifySignedSeal recovers exactly this signer over exactly serializeSeal(seal).
 * @param {object} seal   a validated seal (from buildSeal/readSeal)
 * @param {object} signer an ethers signer-like object: async getAddress() + signMessage()
 * @returns {Promise<object>} the validated signed-seal container
 */
async function signSealWith(seal, signer) {
  return coreAttestation.signAttestation({ attestation: seal, signer }, SIGNED_SEAL_CFG);
}

module.exports = {
  SEAL_KIND,
  SEAL_SCHEMA_VERSION,
  SUPPORTED_SEAL_SCHEMA_VERSIONS,
  SEAL_TRUST_NOTE,
  SEAL_HEADER_RELPATH,
  INPUT_ROLES,
  SealError,
  buildSeal,
  validateSeal,
  readSeal,
  serializeSeal,
  verifySeal,
  committedLeaves,
  // optional signed-attestation wrap (shared core)
  SIGNED_SEAL_CFG,
  SIGNED_SEAL_TRUST_NOTE,
  validateSignedSeal,
  serializeSignedSeal,
  recoverSigner,
  verifySignedSeal,
  signSealWith,
};

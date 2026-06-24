"use strict";

// TrustLedger — seal.js  (EPIC-26, T-26.1; T-30.2 refactor)
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
//   This module is now a THIN ADAPTER over the GENERIC, product-agnostic packet-seal core
//   `cli/core/packetseal.js` (T-30.2). It does NOT re-implement hashing, leaf construction,
//   the root re-derivation, the per-file MATCH/CHANGED/MISSING/UNEXPECTED localization, or the
//   signed-attestation wrap. It supplies ONLY the TrustLedger framing: the seal `kind`
//   (`SEAL_KIND`), and a verdict/role HEADER — the opaque, canonicalizable { relPath, content }
//   pair binding the reconcile's PASS/FAIL verdict + report date + each input's logical ROLE into
//   the SAME committed root as the files. It then projects the core's flat `files` view back into
//   the TrustLedger inputs/outputs(+role)/verdict shape its callers already consume — byte-for-byte
//   identical to before, with the same `__trustledger.seal-header__v1` sentinel and the same
//   localized verdict/role change detection.
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
const packetseal = require("../cli/core/packetseal");
const { pathLeaf } = require("../cli/hash");

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
// file (no real reconcile path begins with this prefix); the core rejects any caller file occupying
// it, so the header is unforgeable from the file side. The header's "content" is the canonical bytes
// of { verdict, roles } (see _headerBytes), hashed + path-bound by the SAME pathLeaf convention every
// other entry uses — so binding the verdict/roles re-uses the core verbatim, with no second hashing
// scheme.
const SEAL_HEADER_RELPATH = "__trustledger.seal-header__v1";

// ---------------------------------------------------------------------------
// Errors. The adapter keeps its OWN named SealError (the TrustLedger-facing error
// surface its callers + tests assert on). Where the shared core raises a
// PacketSealError carrying a (deliberately product-agnostic) message, the adapter
// re-frames it into a SealError with the TrustLedger wording its callers expect.
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
// The PACKET-SEAL CORE config (the TrustLedger framing). This is the entire
// product-specific surface handed to cli/core/packetseal.js:
//   * kind/schemaVersion/note   — the seal identity + standing trust note;
//   * headerRelPath             — the reserved verdict/role HEADER slot;
//   * headerContentFor(seal)    — re-derive the header's canonical bytes from a
//                                 seal's OWN recorded verdict + input role bindings,
//                                 so the core can recompute the header leaf on
//                                 validate (and thus catch a verdict/role edit).
// The core does ALL the shared math; this just NAMES what TrustLedger binds.
// ---------------------------------------------------------------------------

const SEAL_CFG = Object.freeze({
  kind: SEAL_KIND,
  schemaVersion: SEAL_SCHEMA_VERSION,
  supportedSchemaVersions: SUPPORTED_SEAL_SCHEMA_VERSIONS,
  note: SEAL_TRUST_NOTE,
  label: "trustledger reconciliation seal",
  headerRelPath: SEAL_HEADER_RELPATH,
  headerContentFor: (seal) => {
    const inputBindings = (seal.inputs || []).map((e) => ({ role: e.role, relPath: e.relPath }));
    return _headerBytes(seal.verdict, inputBindings);
  },
});

// ---------------------------------------------------------------------------
// _normalizeFileSet(files) — normalize + strictly validate the TrustLedger file
// set ({ inputs:[{role,relPath,bytes}], outputs:[{relPath,bytes}] }) for BUILD.
// BUILD requires all three roles' partition rules and a non-empty packet. Returns
// { inputs, outputs } of normalized entries; relPath uniqueness across the whole
// set + the reserved-header-slot rejection are enforced by the core when the flat
// entries flow through it, but we ALSO enforce the role rules + the inputs/outputs
// cardinality here (the core knows nothing of roles).
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

  const seenRole = new Set();
  const inputs = files.inputs.map((e) => {
    _checkEntryShape(e, "inputs");
    if (!INPUT_ROLES.includes(e.role)) {
      throw new SealError(
        `seal input role must be one of ${JSON.stringify(INPUT_ROLES)}, got: ${JSON.stringify(e.role)}`
      );
    }
    if (seenRole.has(e.role)) {
      throw new SealError(`seal has a duplicate input role: ${JSON.stringify(e.role)}`);
    }
    seenRole.add(e.role);
    return { role: e.role, relPath: e.relPath, bytes: _bytesOf(e) };
  });
  const outputs = files.outputs.map((e) => {
    _checkEntryShape(e, "outputs");
    return { role: null, relPath: e.relPath, bytes: _bytesOf(e) };
  });
  // Cross-set relPath uniqueness + reserved-header-slot rejection happen in the core via the flat
  // entries; surface a TrustLedger-worded duplicate/reserved error here so callers see the same message.
  _assertDistinctPaths([...inputs, ...outputs]);
  return { inputs, outputs };
}

// _normalizeSuppliedForVerify(files) — the LENIENT sibling for verifySeal: either list may be EMPTY
// (a partial supplied set, so verifySeal can localize MISSING), but per-entry strictness is identical.
function _normalizeSuppliedForVerify(files) {
  if (!isPlainObject(files)) {
    throw new SealError("verifySeal requires a { inputs, outputs } file set object");
  }
  const rawInputs = Array.isArray(files.inputs) ? files.inputs : [];
  const rawOutputs = Array.isArray(files.outputs) ? files.outputs : [];

  const seenRole = new Set();
  const inputs = rawInputs.map((e) => {
    _checkEntryShape(e, "inputs");
    if (!INPUT_ROLES.includes(e.role)) {
      throw new SealError(
        `seal input role must be one of ${JSON.stringify(INPUT_ROLES)}, got: ${JSON.stringify(e.role)}`
      );
    }
    if (seenRole.has(e.role)) {
      throw new SealError(`seal has a duplicate input role: ${JSON.stringify(e.role)}`);
    }
    seenRole.add(e.role);
    return { role: e.role, relPath: e.relPath, bytes: _bytesOf(e) };
  });
  const outputs = rawOutputs.map((e) => {
    _checkEntryShape(e, "outputs");
    return { role: null, relPath: e.relPath, bytes: _bytesOf(e) };
  });
  _assertDistinctPaths([...inputs, ...outputs]);
  return { inputs, outputs };
}

function _checkEntryShape(e, where) {
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
  if (!(e.bytes instanceof Uint8Array) && !Buffer.isBuffer(e.bytes)) {
    throw new SealError(
      `seal ${where} entry ${JSON.stringify(e.relPath)} bytes must be a Buffer/Uint8Array ` +
        "(seal.js is I/O-free; the caller reads the file and hands in its bytes)"
    );
  }
}

function _bytesOf(e) {
  return Buffer.isBuffer(e.bytes) ? e.bytes : Buffer.from(e.bytes);
}

function _assertDistinctPaths(entries) {
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.relPath)) {
      throw new SealError(
        `seal has a duplicate relPath across the file set: ${JSON.stringify(e.relPath)} ` +
          "(every input and output must occupy a distinct path)"
      );
    }
    seen.add(e.relPath);
  }
}

// _validateVerdictArg(verdict) — strict shape check on the recorded reconcile facts (BUILD).
function _validateVerdictArg(verdict) {
  if (!isPlainObject(verdict)) {
    throw new SealError("buildSeal requires a `verdict` { pass, reportDate } object");
  }
  if (typeof verdict.pass !== "boolean") {
    throw new SealError("seal verdict.pass must be a boolean (the reconcile PASS/FAIL fact)");
  }
  if (!DATE_RE.test(String(verdict.reportDate || ""))) {
    throw new SealError('seal verdict.reportDate must be a "YYYY-MM-DD" string');
  }
  if (verdict.period !== undefined && verdict.period !== null && typeof verdict.period !== "string") {
    throw new SealError("seal verdict.period, when present, must be a string or null");
  }
}

// _headerArgFor(inputs, verdict) — the opaque { relPath, content } HEADER handed to the core, binding
// the verdict + role→relPath partition into the SAME committed root as the files.
function _headerArgFor(inputs, verdict) {
  return { relPath: SEAL_HEADER_RELPATH, content: _headerBytes(verdict, inputs) };
}

// ---------------------------------------------------------------------------
// buildSeal({ files, verdict }) — assemble + strictly validate a seal.
//
// Delegates ALL hashing/root/header binding to cli/core/packetseal.js, then PROJECTS the core's
// flat `files` view into the TrustLedger inputs/outputs(+role)/verdict shape its callers consume.
// Byte-identical to the pre-refactor output.
// ---------------------------------------------------------------------------

function buildSeal(params) {
  if (!isPlainObject(params)) {
    throw new SealError("buildSeal requires { files, verdict }");
  }
  const { inputs, outputs } = _normalizeFileSet(params.files);
  const verdict = params.verdict;
  _validateVerdictArg(verdict);

  // Hand the GENERIC core the flat file entries + the opaque verdict/role HEADER. The core re-derives
  // the manifest/root over the WHOLE committed set (files + header) via the shared convention.
  const flatEntries = [...inputs, ...outputs].map((e) => ({ relPath: e.relPath, bytes: e.bytes }));
  let coreSeal;
  try {
    coreSeal = packetseal.buildSeal(
      { files: { entries: flatEntries }, header: _headerArgFor(inputs, verdict) },
      SEAL_CFG
    );
  } catch (e) {
    throw _asSealError(e);
  }

  // Map the core's flat per-file leaves back to a relPath -> { contentHash, leaf } lookup so we can
  // re-attach the per-input role + emit inputs/outputs in the TrustLedger order.
  const byRelPath = new Map(coreSeal.files.map((f) => [f.relPath, f]));

  // Inputs in the FIXED INPUT_ROLES order; outputs sorted by relPath. Deterministic regardless of the
  // caller's array order — byte-identical to the pre-refactor emission.
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
    root: coreSeal.root,
    fileCount: coreSeal.fileCount,
    verdict: {
      pass: verdict.pass,
      reportDate: verdict.reportDate,
      period: verdict.period == null ? null : String(verdict.period),
    },
    inputs: sealInputs,
    outputs: sealOutputs,
  };

  // Self-check: the artifact we just built must itself validate, so build/validate stay in lock-step.
  validateSeal(seal);
  return seal;
}

// ---------------------------------------------------------------------------
// validateSeal(obj) — STRICT structural + self-consistency validation of the
// TrustLedger seal shape, with the verdict/role/inputs/outputs checks the core
// cannot know, then DELEGATING the load-bearing root re-derivation (files + the
// verdict/role header) to cli/core/packetseal.js via a flat core-shaped view.
// Throws a named SealError on the FIRST problem; returns the object unchanged on success.
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
  // role-uniqueness within inputs. We collect the flat (relPath, contentHash, leaf) list to build the
  // core-shaped view the core re-derives the root from.
  const seenRelPath = new Set();
  const seenRole = new Set();
  const flatFiles = []; // { relPath, contentHash, leaf }

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
    const expectedLeaf = pathLeaf(entry.relPath, entry.contentHash);
    if (entry.leaf.toLowerCase() !== expectedLeaf.toLowerCase()) {
      throw new SealError(
        `seal ${where}[${i}].leaf is inconsistent with its relPath+contentHash ` +
          `(expected ${expectedLeaf}, got ${entry.leaf})`
      );
    }
    flatFiles.push({ relPath: entry.relPath, contentHash: entry.contentHash, leaf: entry.leaf });
  }

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

  // THE LOAD-BEARING CHECK — delegated to the shared core. Build a core-shaped seal view (flat `files` +
  // the header marker) carrying the SAME root, and let the core re-derive the root from the listed file
  // entries PLUS the synthetic HEADER entry (its content recomputed from THIS seal's verdict + input role
  // bindings via SEAL_CFG.headerContentFor). A seal whose root was edited to mask a changed file is caught
  // there, AND so is one whose verdict (pass/reportDate/period) or input role was edited.
  const coreView = {
    kind: SEAL_KIND,
    schemaVersion: obj.schemaVersion,
    note: SEAL_TRUST_NOTE,
    root: obj.root,
    fileCount: flatFiles.length,
    files: flatFiles,
    header: { relPath: SEAL_HEADER_RELPATH },
    // carry the verdict + inputs so SEAL_CFG.headerContentFor can re-derive the header content
    verdict: obj.verdict,
    inputs: obj.inputs,
  };
  try {
    packetseal.validateSeal(coreView, SEAL_CFG);
  } catch (e) {
    throw _asSealError(e, { rootMessage: true });
  }

  return obj;
}

// _asSealError(e, opts) — re-frame a core PacketSealError into a SealError with the TrustLedger wording
// its callers/tests assert on. The core's root-mismatch message is product-agnostic; the TrustLedger
// surface promises the specific "root does not re-derive from its listed entries + verdict/role header"
// phrasing, so we substitute it. All other core messages pass through verbatim under SealError.
function _asSealError(e, opts = {}) {
  if (!(e instanceof packetseal.PacketSealError)) return e;
  if (opts.rootMessage && /root does not re-derive/.test(e.message)) {
    return new SealError(
      "seal root does not re-derive from its listed entries + verdict/role header " +
        "(the seal is internally inconsistent: a file, the verdict, or an input role was edited " +
        "without updating the root)"
    );
  }
  return new SealError(e.message);
}

/**
 * committedLeaves(seal) — the FULL ordered { relPath, contentHash } list the seal's `root` commits
 * to: every listed file (inputs + outputs) PLUS the synthetic verdict/role HEADER entry (recomputed
 * from the seal's own verdict + input role bindings). Validates the seal first. Delegated to the
 * shared core's committedLeaves over a flat core-shaped view. PURE.
 *
 * @param {object} seal a seal (validated here)
 * @returns {{ relPath: string, contentHash: string }[]}
 */
function committedLeaves(seal) {
  validateSeal(seal);
  const flatFiles = [];
  for (const e of seal.inputs) flatFiles.push({ relPath: e.relPath, contentHash: e.contentHash, leaf: e.leaf });
  for (const e of seal.outputs) flatFiles.push({ relPath: e.relPath, contentHash: e.contentHash, leaf: e.leaf });
  const coreView = {
    kind: SEAL_KIND,
    schemaVersion: seal.schemaVersion,
    note: SEAL_TRUST_NOTE,
    root: seal.root,
    fileCount: flatFiles.length,
    files: flatFiles,
    header: { relPath: SEAL_HEADER_RELPATH },
    verdict: seal.verdict,
    inputs: seal.inputs,
  };
  return packetseal.committedLeaves(coreView, SEAL_CFG);
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
// trailing newline. Two runs over the same seal produce an identical string.
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
// Delegates the per-file MATCH/CHANGED/MISSING/UNEXPECTED localization + the root
// re-derivation (over the supplied files + the verdict/role header) to the shared
// core, then ADDS the TrustLedger-specific role projection: each finding is tagged
// with its sealed role, and any path present in BOTH whose SUPPLIED role differs from
// its SEALED role is surfaced as a `roleMismatch`. The recomputed header binds the
// SUPPLIED role bindings, so a role swap changes the recomputed root and rootMatches
// goes false; the roleMismatches list LOCALIZES which paths' roles changed.
//
// PURE: no I/O, no key, no network, no clock.
// ---------------------------------------------------------------------------

function verifySeal(seal, files) {
  validateSeal(seal);
  const { inputs, outputs } = _normalizeSuppliedForVerify(files);

  // The recomputed header uses the seal's recorded verdict + the SUPPLIED role bindings (so a role swap
  // changes the recomputed root). Hand the core the flat supplied entries + that header content.
  const suppliedFlat = [...inputs, ...outputs].map((e) => ({ relPath: e.relPath, bytes: e.bytes }));
  const headerContent = _headerBytes(seal.verdict, inputs);

  // Build the flat core-shaped seal view so the core can verify per-file + root against it.
  const coreSeal = {
    kind: SEAL_KIND,
    schemaVersion: seal.schemaVersion,
    note: SEAL_TRUST_NOTE,
    root: seal.root,
    fileCount: seal.inputs.length + seal.outputs.length,
    files: [...seal.inputs, ...seal.outputs].map((e) => ({
      relPath: e.relPath,
      contentHash: e.contentHash,
      leaf: e.leaf,
    })),
    header: { relPath: SEAL_HEADER_RELPATH },
    verdict: seal.verdict,
    inputs: seal.inputs,
  };

  let core;
  try {
    core = packetseal.verifySeal(coreSeal, { entries: suppliedFlat }, SEAL_CFG, { headerContent });
  } catch (e) {
    throw _asSealError(e, { rootMessage: true });
  }

  // ----- TrustLedger role projection over the core's flat findings. -----
  // sealed relPath -> role; supplied relPath -> role.
  const sealedRole = new Map();
  for (const e of seal.inputs) sealedRole.set(e.relPath, e.role);
  for (const e of seal.outputs) sealedRole.set(e.relPath, null);
  const suppliedRole = new Map();
  for (const e of [...inputs, ...outputs]) suppliedRole.set(e.relPath, e.role);

  const matched = core.matched.map((m) => ({
    relPath: m.relPath,
    role: sealedRole.get(m.relPath) == null ? null : sealedRole.get(m.relPath),
    contentHash: m.contentHash,
  }));
  const changed = core.changed.map((c) => ({
    relPath: c.relPath,
    role: sealedRole.get(c.relPath) == null ? null : sealedRole.get(c.relPath),
    expectedContentHash: c.expectedContentHash,
    actualContentHash: c.actualContentHash,
  }));
  const missing = core.missing.map((m) => ({
    relPath: m.relPath,
    role: sealedRole.get(m.relPath) == null ? null : sealedRole.get(m.relPath),
  }));
  const unexpected = core.unexpected.map((u) => ({
    relPath: u.relPath,
    role: suppliedRole.get(u.relPath) == null ? null : suppliedRole.get(u.relPath),
    contentHash: u.contentHash,
  }));

  // Role mismatch: a path present in BOTH whose SUPPLIED role differs from its SEALED role.
  const roleMismatches = [];
  for (const [relPath, sRole] of sealedRole) {
    if (!suppliedRole.has(relPath)) continue;
    const supR = suppliedRole.get(relPath) == null ? null : suppliedRole.get(relPath);
    if (supR !== sRole) {
      roleMismatches.push({ relPath, sealedRole: sRole, suppliedRole: supR });
    }
  }
  const byRel = (a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);
  roleMismatches.sort(byRel);

  const accepted = core.accepted && roleMismatches.length === 0;

  return {
    verdict: accepted ? "ACCEPTED" : "REJECTED",
    accepted,
    sealedRoot: seal.root,
    recomputedRoot: core.recomputedRoot,
    rootMatches: core.rootMatches,
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

// ---------------------------------------------------------------------------
// SIGNED-attestation WRAP (optional). The seal MAY be wrapped by the EXISTING
// `cli/core/attestation.js` envelope so a human can vouch for it via the SAME
// shared signing path — NO new scheme. The seal's CANONICAL bytes (serializeSeal)
// become the attestation payload. Unchanged by T-30.2.
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

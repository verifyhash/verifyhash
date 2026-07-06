#!/usr/bin/env node
"use strict";

// verifier/verify-vh.js — the STANDALONE, read-only, OFFLINE verifier (T-31.2).
//
// WHY THIS EXISTS
//   The whole verifyhash family sells one promise: "you do NOT have to trust the producer — verify it
//   OFFLINE, independently." `verify-vh` is the artifact that makes that promise real for the party who
//   matters most for a sale: the COUNTERPARTY (an auditor, opposing counsel, a buyer's security team, a
//   design partner). They drop one `*.vhevidence.json` / `*.vhseal` / dataset attestation / proof bundle
//   in front of this command and get a deterministic verdict — WITHOUT installing the producer's heavy
//   ethers/hardhat stack. This tree depends on ONLY `js-sha3` (+ a tiny vendored secp256k1 routine), so a
//   third party can `npm install` it alone and audit it in an afternoon.
//
// WHAT IT DOES
//   * AUTO-DETECTS the artifact `kind` (evidence seal, reconciliation/trust seal, dataset attestation,
//     proof bundle — bare or signed).
//   * RE-DERIVES the keccak Merkle root from the bytes REFERENCED by the artifact (resolving sibling
//     files relative to the artifact's own directory, with a `--dir <d>` override), NEVER trusting the
//     artifact's own stored hashes.
//   * RECOVERS the signer of a signed artifact via the independent EIP-191 secp256k1 recovery (T-31.1),
//     PINS it to a caller-supplied `--vendor <0xaddr>` (or REPORTS the recovered signer when no pin is
//     given).
//   * Prints a deterministic verdict: OK / which file CHANGED / MISSING / UNEXPECTED / `bad_signature`
//     / `wrong_issuer`.
//
// POSTURE — READ-ONLY. It holds NO key, opens nothing for write, and NEVER writes the cwd (or anywhere).
//   It reads ONLY the artifact and the sibling files it references. Same exit-code contract as
//   `vh verify-seal` / `vh evidence verify`: 0 ok / 3 rejected / 2 usage / 1 IO.
//
// FILE-SOURCE SEAM (T-66.1). The verify cores are written against ONE tiny abstraction — a `readEntry`
//   function `(relPath) -> { status: "ok", bytes } | { status: "missing" } | { status: "escaped" }` — so
//   the SAME engine verifies from the DISK (the CLI path below, byte-identical to before) or from an
//   IN-MEMORY `{ relPath: Uint8Array }` map (`verifyArtifactFromBytes`, the seam a browser page / vm
//   sandbox drives with ZERO fs/os/path/process on its code path). The whole pure engine sits between the
//   BEGIN/END markers below; test/verifier.browser-core.test.js proves (statically AND dynamically) that
//   no impure builtin use is reachable from the bytes entry, and that disk/bytes verdicts are DEEP-EQUAL.

const fs = require("fs");
const os = require("os");
const path = require("path");
// Node CORE sha256 (no npm dependency — the same zero-install class as fs/path; the bundle already
// allows `crypto` for its embedded --self-attest). Used ONLY by the T-70.4 anchored-receipt section
// below (the dataset/parcel attestation digest legs), which lives OUTSIDE the pure engine block.
const nodeCrypto = require("crypto");

const merkle = require("./lib/merkle");
const canonical = require("./lib/canonical");
const { recoverPersonalSignAddress } = require("./lib/secp256k1-recover");
const revocation = require("./lib/revocation");

// ============================ BEGIN VERIFY-VH PURE ENGINE (T-66.1) ============================
// EVERYTHING between this marker and the matching END marker is the PURE verify engine: it performs NO
// I/O of its own and never touches fs / os / path / process / child_process — every byte it verifies
// arrives through the injected `readEntry` seam (or as an argument). Its only outside references are the
// four module bindings above, all of which resolve to PURE modules for the functions used here:
// `merkle`, `canonical`, `recoverPersonalSignAddress`, and the PURE decision half of `revocation`
// (./lib/revocation-core.js re-exports — never the fs-backed readRevocationsFromPath/loadAndApply).
// test/verifier.browser-core.test.js enforces all of this mechanically; the markers also make the block
// mechanically extractable (vm / browser bundling, EPIC-66).

// CI-gateable exit contract, mirroring the producer family (vh verify-seal / vh evidence verify):
//   0 ok / 3 rejected / 2 usage / 1 IO / 4 UNPINNED (T-75.2: --strict only — the bytes verified but
//   NO trusted --vendor pin backed the accept, so a fail-closed gate refuses to call it provenance).
// Stable; a future CI/indexer keys on these. 0 therefore means ACCEPT — and, under --strict,
// ACCEPT-AND-PINNED; 3 stays REJECT; 4 is the distinct unpinned-under-strict code.
const EXIT = Object.freeze({ OK: 0, IO: 1, USAGE: 2, REJECTED: 3, UNPINNED: 4 });

// A usage error the CLI maps to exit 2 (vs an IO error -> 1, vs a clean REJECTED verdict -> 3).
class UsageError extends Error {}
class IOError extends Error {}

// The on-disk `kind` discriminators of every artifact family this verifier understands. Bare and signed
// variants are listed so auto-detect routes correctly. Disjoint, versioned strings — a foreign/random
// JSON file falls through to a clear "unrecognized artifact" usage error rather than a misread.
const KINDS = Object.freeze({
  EVIDENCE_SEAL: "vh.evidence-seal",
  EVIDENCE_SEAL_SIGNED: "vh.evidence-seal-signed",
  TRUST_SEAL: "trustledger.reconcile-seal",
  TRUST_SEAL_SIGNED: "trustledger.reconcile-seal-signed",
  DATASET_ATTESTATION: "verifyhash.dataset-attestation",
  DATASET_ATTESTATION_SIGNED: "verifyhash.dataset-attestation-signed",
  DATASET_ATTESTATION_TIMESTAMPED: "verifyhash.dataset-attestation-timestamped",
  PROOF: "verifyhash.merkle-proof",
  AGENT_PACKET: "vh.agent-session-packet",
});

const TRUST_NOTE =
  "verify-vh is an INDEPENDENT, read-only, OFFLINE verifier. It RE-DERIVES the keccak root from the " +
  "bytes you hold and recovers the signer with no producer stack. It proves TAMPER-EVIDENCE + WHO " +
  "vouched — NOT a trusted timestamp and NOT a legal opinion.";

// ---------------------------------------------------------------------------
// Address normalization + recovery helpers. The verifier compares addresses as LOWERCASE 0x-hex (the
// canonical byte-deterministic form the producer records); a caller may paste an EIP-55-checksummed
// --vendor and we lowercase it (a checksum mismatch is not our concern — we compare 20 raw bytes).
// ---------------------------------------------------------------------------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function normalizeAddress(addr, label) {
  if (typeof addr !== "string" || !ADDRESS_RE.test(addr)) {
    throw new UsageError(`${label} must be a 0x-prefixed 20-byte hex address, got: ${String(addr)}`);
  }
  return addr.toLowerCase();
}

// Recover the EIP-191 signer over the embedded canonical bytes. A tampered/corrupt signature can be
// UNRECOVERABLE (no valid curve point) — that throws, which the caller turns into a `bad_signature`
// REJECTED verdict, never a crash. Returns lowercase 0x-hex, or null if recovery failed.
function tryRecover(message, signature) {
  try {
    return recoverPersonalSignAddress(message, signature);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Signed-container decoding. A signed artifact carries the embedded UNSIGNED payload as the EXACT
// canonical bytes (a STRING) in `attestation`, plus a { scheme, signer, signature } block. The signed
// MESSAGE is that embedded string verbatim, so signer recovery runs over `container.attestation`.
// ---------------------------------------------------------------------------

function decodeSigned(container) {
  const sig = container && container.signature;
  if (sig == null || typeof sig !== "object" || Array.isArray(sig)) {
    throw new IOError("signed artifact is missing a { scheme, signer, signature } signature block");
  }
  if (sig.scheme !== "eip191-personal-sign") {
    throw new IOError(
      `unsupported signature scheme: ${JSON.stringify(sig.scheme)} ` +
        "(this verifier understands eip191-personal-sign)"
    );
  }
  if (typeof container.attestation !== "string") {
    throw new IOError("signed artifact must embed the canonical UNSIGNED bytes as a string `attestation`");
  }
  if (typeof sig.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig.signature)) {
    throw new IOError("signed artifact signature must be a 65-byte (r||s||v) 0x-hex string");
  }
  if (typeof sig.signer !== "string" || !ADDRESS_RE.test(sig.signer)) {
    throw new IOError("signed artifact signer must be a 0x-prefixed 20-byte hex address");
  }
  let embedded;
  try {
    embedded = JSON.parse(container.attestation);
  } catch (e) {
    throw new IOError(`embedded attestation is not valid JSON: ${e.message}`);
  }
  return { embedded, message: container.attestation, claimedSigner: sig.signer.toLowerCase(), signature: sig.signature };
}

// ---------------------------------------------------------------------------
// Per-file re-derivation, shared by every seal kind AND by both file sources. Given the sealed
// { relPath, contentHash } entries and a `readEntry` source, fetch each referenced file's bytes through
// the source, recompute its contentHash, and localize the outcome to MATCH / CHANGED / MISSING /
// ESCAPED; a file present under a sealed relPath that is NOT in the seal cannot occur here (we only read
// sealed relPaths) — UNEXPECTED is reported only for seals where the producer enumerates a directory
// (evidence seal verify re-walks the dir). For artifact verification we follow the producer's read
// model: read exactly the relPaths the artifact names from the source.
//
// SECURITY — CONFINEMENT LIVES IN THE SOURCE. `relPath` values come straight from the attacker-controlled
// artifact JSON (the threat model is attacker-controls-the-input, victim-runs-on-their-own-machine: a
// malicious producer hands a counterparty a "verify me" artifact, hoping its relPaths probe the
// counterparty's filesystem). Each source therefore CONFINES every read BEFORE touching its backing
// store and answers `{ status: "escaped" }` for a hostile relPath (absolute, a `..` traversal component,
// or — for the disk source — a resolved/realpath escape of baseDir). An escaped entry is recorded ONLY by
// relPath (the attacker's string) — we NEVER hash it and NEVER emit an actualContentHash for it, so the
// verdict can never become a content-confirmation / hash-disclosure oracle over a file outside the
// source. A `path_escape` entry is a hard REJECTED verdict.
// ---------------------------------------------------------------------------

function classifyFilesWith(sealedEntries, readEntry) {
  const changed = [];
  const missing = [];
  const matched = [];
  const escaped = []; // { relPath } only — NEVER a hash; a confinement reject, read nothing
  const flat = []; // { relPath, contentHash } actually-present, for the root re-derivation

  for (const e of sealedEntries) {
    const relPath = e.relPath;
    const r = readEntry(relPath);
    if (r.status === "escaped") {
      escaped.push({ relPath: String(relPath) });
      continue;
    }
    if (r.status === "missing") {
      missing.push({ relPath });
      continue;
    }
    const actual = merkle.hashBytes(r.bytes);
    flat.push({ relPath, contentHash: actual });
    if (actual.toLowerCase() === String(e.contentHash).toLowerCase()) {
      matched.push({ relPath, contentHash: actual });
    } else {
      changed.push({ relPath, expectedContentHash: e.contentHash, actualContentHash: actual });
    }
  }
  return { matched, changed, missing, escaped, flat };
}

// ---------------------------------------------------------------------------
// Verify an EVIDENCE seal (bare or the embedded seal of a signed container). The seal lists `files`
// [{ relPath, contentHash, leaf }] + `root`. We re-derive the root from the bytes the source holds and
// localize any tamper. NO header (evidence seals bind only the file set). UNEXPECTED files (present
// under a sealed-sibling tree but not named) are NOT scanned here — the artifact names exactly what it
// commits to; the producer's `vh evidence verify` re-walks the dir, but the standalone verifier verifies
// what the artifact REFERENCES (read-only, no directory walk). NOTE an "extra" file is still caught
// structurally: the sealed root commits to the FULL file set, so a seal doctored to omit an entry can
// never keep its root (root_mismatch), and a signed seal edited that way breaks its signature.
// ---------------------------------------------------------------------------

function verifyEvidenceSealWith(seal, readEntry) {
  if (!Array.isArray(seal.files) || seal.files.length === 0) {
    throw new IOError("evidence seal `files` must be a non-empty array");
  }
  if (typeof seal.root !== "string" || !merkle.HEX32_RE.test(seal.root)) {
    throw new IOError("evidence seal `root` must be a 0x-prefixed 32-byte hex string");
  }
  const { matched, changed, missing, escaped, flat } = classifyFilesWith(seal.files, readEntry);

  // The AUTHORITATIVE root is re-derived from the bytes actually held — never the seal's stored root.
  // A partial/changed set yields a different root; rootMatches goes false.
  let recomputedRoot = null;
  if (flat.length > 0) {
    try {
      recomputedRoot = merkle.rootFromFlat(flat);
    } catch (_) {
      recomputedRoot = null;
    }
  }
  const rootMatches =
    missing.length === 0 &&
    changed.length === 0 &&
    escaped.length === 0 &&
    recomputedRoot != null &&
    recomputedRoot.toLowerCase() === seal.root.toLowerCase();

  return {
    matched,
    changed,
    missing,
    escaped,
    unexpected: [],
    sealedRoot: seal.root,
    recomputedRoot,
    rootMatches,
    filesOk: changed.length === 0 && missing.length === 0 && escaped.length === 0 && rootMatches,
  };
}

// ---------------------------------------------------------------------------
// Verify a TRUST (reconciliation) seal (bare or embedded). The seal lists `inputs` (role+relPath+
// contentHash+leaf) and `outputs` (relPath+contentHash+leaf), plus a `verdict` + `root`. The root commits
// to all inputs + outputs PLUS a synthetic verdict/role HEADER leaf. We re-derive the root from the held
// bytes AND the header content recomputed from the seal's OWN verdict + input role bindings — so a
// verdict/role edit (which lives in the seal, not a file) still changes the recomputed root. Inputs are
// sealed by basename and resolve through the source (the portable handoff ships sources next to the seal).
// ---------------------------------------------------------------------------

function verifyTrustSealWith(seal, readEntry) {
  if (!Array.isArray(seal.inputs) || seal.inputs.length === 0) {
    throw new IOError("trust seal `inputs` must be a non-empty array");
  }
  if (!Array.isArray(seal.outputs) || seal.outputs.length === 0) {
    throw new IOError("trust seal `outputs` must be a non-empty array");
  }
  if (typeof seal.root !== "string" || !merkle.HEX32_RE.test(seal.root)) {
    throw new IOError("trust seal `root` must be a 0x-prefixed 32-byte hex string");
  }
  if (seal.verdict == null || typeof seal.verdict !== "object") {
    throw new IOError("trust seal is missing its `verdict` block");
  }

  const sealedEntries = [
    ...seal.inputs.map((e) => ({ relPath: e.relPath, contentHash: e.contentHash, role: e.role })),
    ...seal.outputs.map((e) => ({ relPath: e.relPath, contentHash: e.contentHash, role: null })),
  ];
  const { matched, changed, missing, escaped, flat } = classifyFilesWith(sealedEntries, readEntry);

  // Re-derive the root: the held file leaves PLUS the verdict/role HEADER leaf (content recomputed
  // from the seal's own verdict + input role bindings). The header is folded in as one more (relPath,
  // content) pair under the reserved header relPath — exactly the producer's binding.
  let recomputedRoot = null;
  // Only attempt the root re-derivation when no file is MISSING or ESCAPED (a partial set can never
  // re-derive the sealed root anyway, and the header binds the FULL committed structure).
  if (missing.length === 0 && escaped.length === 0 && flat.length === seal.inputs.length + seal.outputs.length) {
    try {
      const headerBytes = canonical.trustSealHeaderBytes(
        seal.verdict,
        seal.inputs.map((e) => ({ role: e.role, relPath: e.relPath }))
      );
      const committed = [
        ...flat,
        { relPath: canonical.TRUST_SEAL_HEADER_RELPATH, contentHash: merkle.hashBytes(headerBytes) },
      ];
      recomputedRoot = merkle.rootFromFlat(committed);
    } catch (_) {
      recomputedRoot = null;
    }
  }
  const rootMatches =
    escaped.length === 0 &&
    recomputedRoot != null &&
    recomputedRoot.toLowerCase() === seal.root.toLowerCase();

  return {
    matched,
    changed,
    missing,
    escaped,
    unexpected: [],
    sealedRoot: seal.root,
    recomputedRoot,
    rootMatches,
    filesOk: changed.length === 0 && missing.length === 0 && escaped.length === 0 && rootMatches,
  };
}

// ---------------------------------------------------------------------------
// Verify a DATASET attestation (bare/signed/timestamped). A dataset attestation commits to the dataset
// IDENTITY (root, fileCount, manifestDigest) — it does NOT carry the per-file list, so there are no
// sibling bytes to re-derive a Merkle root from without the original manifest. The independent verifier
// therefore confirms the embedded identity is well-formed + (for signed) recovers/pins the signer; the
// `root` is the dataset's, carried as-is. (`vh dataset verify <dir> --manifest` is the path that
// re-derives a root from a live tree; the attestation alone has no tree to re-walk.)
// ---------------------------------------------------------------------------

function verifyDatasetAttestation(att) {
  for (const f of ["root", "manifestDigest"]) {
    if (typeof att[f] !== "string" || !merkle.HEX32_RE.test(att[f])) {
      throw new IOError(`dataset attestation ${f} must be a 0x-prefixed 32-byte hex string`);
    }
  }
  if (!Number.isInteger(att.fileCount) || att.fileCount < 1) {
    throw new IOError("dataset attestation fileCount must be a positive integer");
  }
  return {
    matched: [],
    changed: [],
    missing: [],
    escaped: [],
    unexpected: [],
    sealedRoot: att.root,
    recomputedRoot: null,
    rootMatches: null, // no sibling bytes to re-derive a root from (identity-only artifact)
    filesOk: true, // structural identity is sound; the binding is via the signature for signed variants
    identityOnly: true,
  };
}

// ---------------------------------------------------------------------------
// Verify a PROOF bundle. A proof artifact carries { root, leaf, contentHash, relPath, proof[] }. We
// RE-DERIVE the leaf from relPath + contentHash, then fold leafHash(leaf) up through the proof siblings
// with nodeHash and confirm it reproduces `root` — byte-identically to the on-chain verifyLeaf, but
// fully OFFLINE. (The on-chain "is this root anchored" check is out of scope for the offline verifier.)
// ---------------------------------------------------------------------------

function verifyProofBundle(art) {
  for (const f of ["root", "leaf", "contentHash"]) {
    if (typeof art[f] !== "string" || !merkle.HEX32_RE.test(art[f])) {
      throw new IOError(`proof artifact ${f} must be a 0x-prefixed 32-byte hex string`);
    }
  }
  if (typeof art.relPath !== "string" || art.relPath.length === 0) {
    throw new IOError("proof artifact relPath must be a non-empty string");
  }
  if (!Array.isArray(art.proof)) {
    throw new IOError("proof artifact `proof` must be an array of 0x 32-byte hex siblings");
  }
  const derivedLeaf = merkle.pathLeaf(art.relPath, art.contentHash);
  const leafMatches = derivedLeaf.toLowerCase() === art.leaf.toLowerCase();
  let computed = merkle.leafHash(art.leaf);
  for (const sib of art.proof) {
    computed = merkle.nodeHash(computed, sib);
  }
  const foldsToRoot = computed.toLowerCase() === art.root.toLowerCase();
  return {
    matched: leafMatches && foldsToRoot ? [{ relPath: art.relPath, contentHash: art.contentHash }] : [],
    changed:
      leafMatches && foldsToRoot ? [] : [{ relPath: art.relPath, expectedContentHash: art.root, actualContentHash: computed }],
    missing: [],
    escaped: [],
    unexpected: [],
    sealedRoot: art.root,
    recomputedRoot: computed,
    rootMatches: leafMatches && foldsToRoot,
    filesOk: leafMatches && foldsToRoot,
    proof: { derivedLeaf, leafMatches, foldsToRoot },
  };
}

// ---------------------------------------------------------------------------
// Verify an AGENT-SESSION packet (T-68.3 — the AgentTrace funnel leg, FREE surface only).
//
// A `*.vhagent.json` packet is SELF-CONTAINED: it carries its ordered event list (full and/or
// REDACTED), a per-event leaf expectation list, and an RFC-6962-style ordered Merkle head
// { size, root } — there are NO sibling files to read, so `readEntry` is never consulted. This block
// RE-DERIVES every event leaf and the root from the events the packet holds, exactly as the producer's
// `vh agent verify` does, but from an INDEPENDENT implementation surface: everything below is written
// against the verifier's OWN dependency-free keccak (merkle.hashBytes) — it imports NOTHING from cli/.
//
// THE CONVENTION (must match cli/core/agent-session.js + cli/journal-log.js VERBATIM):
//   * payloadHash  = keccak256(utf8(payload))                                (the payload COMMITMENT)
//   * event leaf   = keccak256(utf8(JSON.stringify([
//                      LEAF_DOMAIN, seq, ts, actor, type, payloadHash, canonicalMetaJson|null ])))
//     — the payload participates ONLY via its commitment, so a FULL event and its REDACTED twin
//     (payload dropped, commitment carried, `redacted: true`) derive the IDENTICAL leaf: redaction
//     changes neither the leaves nor the root (it can WITHHOLD, never silently ALTER).
//   * the ordered tree (RFC 6962, position-bound, NO sorting — the OPPOSITE of the evidence tree):
//       leaf node = keccak256(0x00 || leaf)      interior = keccak256(0x01 || left || right)
//       MTH(D[0:n]) = interior(MTH(D[0:k]), MTH(D[k:n])), k = largest power of two < n
//       empty log root = keccak256(utf8("vh.journal-log/v1:empty-root"))
//   * a SIGNED packet carries `headAttestation`: a detached EIP-191 personal-sign over the EXACT
//     canonical head-payload bytes (the embedded `attestation` string). The signature wraps the HEAD,
//     so ONE signature stays valid for every redacted copy of the same sealed session.
//
// VERDICTS: event-level tamper (a payload that no longer matches its carried commitment — including a
// REDACTED event whose commitment was forged — or a leaf that no longer matches its expectation) is a
// REJECT NAMING THE SEQ; a tampered head is `root_mismatch`; a forged signature is `bad_signature`; a
// sound signature by the wrong signer under a --vendor pin is `wrong_issuer`; a --vendor pin on an
// UNSIGNED packet is `unsigned_cannot_pin_vendor` (a stripped signature never passes a pinned verify).
// The recompute is AUTHORITATIVE: the packet is an untrusted container and its stored hashes are only
// EXPECTATIONS checked against.
// ---------------------------------------------------------------------------

// The producer's in-band trust note, REQUIRED verbatim (the packetseal discipline: the caveat may not
// drift; a packet whose note was edited is structurally invalid, exactly as `vh agent verify` treats it).
const AGENT_TRUST_NOTE =
  "This agent-session packet is TAMPER-EVIDENT + OFFLINE-RECOMPUTABLE, NOT a trusted timestamp and " +
  "NOT a claim the agent behaved well. Its ordered Merkle `head` {size, root} (RFC-6962-style, " +
  "position-bound) commits to every event: verify RE-DERIVES each event leaf — recomputing the " +
  "payload hash commitment for a FULL event, checking the carried commitment for a REDACTED one — " +
  "and the root from the events you hold, and a REJECT names the first offending event seq. " +
  "Redaction WITHHOLDS a payload behind its hash commitment without changing any leaf or the root: " +
  "it can hide, never silently alter. Event `ts` fields are SELF-ASSERTED metadata (recorded, never " +
  'verified against any clock); "sealed at time T" rides the human-owned signing/timestamp ' +
  "trust-root (STRATEGY.md P-3). Garbage-in is out of scope: the head proves the LOG is intact and " +
  "append-only, not that the log faithfully records what the agent actually did. The packet is an " +
  "UNTRUSTED transport container: verify never trusts the packet's own stored hashes.";

const AGENT_SIGNED_HEAD_TRUST_NOTE =
  "This is a SIGNED agent-session HEAD attestation: it WRAPS (never edits) the EXACT canonical head " +
  "bytes in `attestation` and attaches a detached EIP-191 signature. It asserts the holder of the " +
  "`signer` key vouched for THIS session head {size, root} at signing time. Because event leaves " +
  "are redaction-safe, the SAME signature stays valid for every redacted copy of the sealed session " +
  "(redaction changes neither leaves nor root). It does NOT prove a timestamp (no \"sealed since " +
  "T\" — still the human trust-root P-3) and is NOT a legal opinion. Every caveat of the packet " +
  "applies. " +
  AGENT_TRUST_NOTE;

const AGENT_HEAD_KIND = "vh.agent-head";
const AGENT_SIGNED_HEAD_KIND = "vh.agent-head-signed";
const AGENT_PACKET_SCHEMA_VERSIONS = Object.freeze([1]);
const AGENT_EVENT_TYPES = Object.freeze(["prompt", "completion", "tool_call", "tool_result", "note"]);
const AGENT_EVENT_FIELDS = Object.freeze([
  "seq",
  "ts",
  "actor",
  "type",
  "payload",
  "payloadHash",
  "redacted",
  "meta",
]);
const AGENT_LEAF_DOMAIN = "vh.agent-session/v1:event-leaf";
const AGENT_EMPTY_ROOT_DOMAIN = "vh.journal-log/v1:empty-root";
const AGENT_META_MAX_DEPTH = 32;
const AGENT_META_MAX_NODES = 100000;

// Canonical-case wire shapes (the producer emits lowercase-only hex; mixed case is a foreign artifact).
const AGENT_HEX32_LC_RE = /^0x[0-9a-f]{64}$/;
const AGENT_ADDRESS_LC_RE = /^0x[0-9a-f]{40}$/;
const AGENT_SIG_LC_RE = /^0x[0-9a-f]{130}$/;

// STRICT UTF-8 encoder that MIRRORS the producer's ethers `toUtf8Bytes` byte-for-byte (verified over
// the whole 0x0000..0xFFFF code-unit space + surrogate edge cases). ethers' default error mode THROWS
// only on a lone HIGH surrogate (an unfinished pair, no code point) — so this returns null there — but
// it ENCODES a lone LOW surrogate as its literal 3-byte sequence (U+DC00 -> ed b0 80), NOT an error;
// so a lone low surrogate falls straight through to the c<0x10000 branch below (matching the producer,
// whose commitment over such a payload is well-defined). Pure JS; no TextEncoder (which would silently
// substitute U+FFFD and DIVERGE from the producer). null => the event's commitment is undefined here
// exactly as it is for the producer, so both sides reject in lockstep (fail-closed, never a mismatch).
function agentUtf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const lo = i + 1 < str.length ? str.charCodeAt(i + 1) : -1;
      if (lo < 0xdc00 || lo > 0xdfff) return null; // lone HIGH surrogate (ethers THROWS; no code point)
      c = (c - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
      i++;
    }
    // A lone LOW surrogate (0xdc00..0xdfff) is NOT special-cased: ethers encodes it as its 3-byte form
    // via the c<0x10000 branch, so we do too — deleting the old lone-low `return null` that FALSELY
    // rejected genuine packets carrying truncated-UTF-16 / arbitrary-tool-result bytes.
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

// 0x-hex -> bytes, and a tiny concat — the only byte plumbing the ordered tree needs.
function agentHexToBytes(hex) {
  const s = hex.slice(2);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function agentConcatBytes(list) {
  let total = 0;
  for (const b of list) total += b.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of list) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

// RFC-6962 domain-separated hashing over the verifier's OWN keccak (merkle.hashBytes — the same
// independent primitive every other artifact family here is re-derived with). Children fold in TREE
// ORDER (never sorted): position IS meaning in an ordered session log.
function agentLeafNodeHash(leafHex) {
  return merkle.hashBytes(agentConcatBytes([Uint8Array.of(0x00), agentHexToBytes(leafHex)]));
}
function agentInteriorHash(leftHex, rightHex) {
  return merkle.hashBytes(
    agentConcatBytes([Uint8Array.of(0x01), agentHexToBytes(leftHex), agentHexToBytes(rightHex)])
  );
}

// MTH (RFC 6962 §2.1) over the ORDERED leaf values; the empty log has a domain-separated constant root.
function agentTreeRoot(leaves) {
  if (leaves.length === 0) return merkle.hashBytes(agentUtf8Bytes(AGENT_EMPTY_ROOT_DOMAIN));
  function mth(lo, hi) {
    const n = hi - lo;
    if (n === 1) return agentLeafNodeHash(leaves[lo]);
    let k = 1;
    while (k * 2 < n) k *= 2;
    return agentInteriorHash(mth(lo, lo + k), mth(lo + k, hi));
  }
  return mth(0, leaves.length);
}

// A "plain" JSON-shaped object (prototype Object.prototype or null) — the same strictness the producer
// applies, so what is hashed is exactly what could be written to disk and read back.
function agentIsPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// Canonical JSON for `meta`: keys SORTED, only JSON-representable values, depth capped, and a TOTAL
// work budget so a shared-reference DAG can never hang the verifier. Returns the canonical text or
// null (reject) — byte-identical to the producer's canonicalization for every accepted value.
function agentCanonicalJson(value, depth, budget) {
  if (depth > AGENT_META_MAX_DEPTH) return null;
  if (++budget.n > AGENT_META_MAX_NODES) return null;
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) {
      const p = agentCanonicalJson(item, depth + 1, budget);
      if (p === null) return null;
      parts.push(p);
    }
    return "[" + parts.join(",") + "]";
  }
  if (agentIsPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      const p = agentCanonicalJson(value[k], depth + 1, budget);
      if (p === null) return null;
      parts.push(JSON.stringify(k) + ":" + p);
    }
    return "{" + parts.join(",") + "}";
  }
  return null;
}

// The payload COMMITMENT: keccak256 over the payload's UTF-8 bytes. null on a non-string or a string
// with no UTF-8 encoding (a lone HIGH surrogate — where ethers throws) — TOTAL, mirrors the producer
// exactly (a lone LOW surrogate IS encodable, so it commits rather than rejecting).
function agentPayloadHash(payload) {
  if (typeof payload !== "string") return null;
  const bytes = agentUtf8Bytes(payload);
  return bytes === null ? null : merkle.hashBytes(bytes);
}

// STRICT validation of one canonical event — an INDEPENDENT re-implementation of the producer's rules
// (closed field set; exactly the FULL or REDACTED shape; a carried commitment on a full event must
// equal the recomputed one). Never throws; every failure is a named { ok:false, reason, field? } (the
// commitment-mismatch reject also carries carried/recomputed so the caller can localize the change).
function agentValidateEvent(event) {
  try {
    if (!agentIsPlainObject(event)) return { ok: false, reason: "EVENT_NOT_OBJECT" };
    for (const k of Object.keys(event)) {
      if (!AGENT_EVENT_FIELDS.includes(k)) return { ok: false, reason: "EVENT_UNKNOWN_FIELD", field: k };
    }
    if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
      return { ok: false, reason: "EVENT_BAD_SEQ", field: "seq" };
    }
    if (typeof event.ts !== "string") return { ok: false, reason: "EVENT_BAD_TS", field: "ts" };
    if (typeof event.actor !== "string" || event.actor.length === 0) {
      return { ok: false, reason: "EVENT_BAD_ACTOR", field: "actor" };
    }
    if (!AGENT_EVENT_TYPES.includes(event.type)) return { ok: false, reason: "EVENT_BAD_TYPE", field: "type" };
    const hasPayload = "payload" in event;
    const hasHash = "payloadHash" in event;
    if (hasPayload && typeof event.payload !== "string") {
      return { ok: false, reason: "EVENT_BAD_PAYLOAD", field: "payload" };
    }
    if (hasHash && !(typeof event.payloadHash === "string" && merkle.HEX32_RE.test(event.payloadHash))) {
      return { ok: false, reason: "EVENT_BAD_PAYLOAD_HASH", field: "payloadHash" };
    }
    if ("redacted" in event && typeof event.redacted !== "boolean") {
      return { ok: false, reason: "EVENT_BAD_REDACTED_FLAG", field: "redacted" };
    }
    if (!hasPayload && !hasHash) return { ok: false, reason: "EVENT_MISSING_PAYLOAD", field: "payload" };
    if (event.redacted === true && hasPayload) {
      return { ok: false, reason: "EVENT_REDACTED_WITH_PAYLOAD", field: "redacted" };
    }
    if (event.redacted === true && !hasHash) {
      return { ok: false, reason: "EVENT_BAD_PAYLOAD_HASH", field: "payloadHash" };
    }
    if (!hasPayload && event.redacted !== true) {
      return { ok: false, reason: "EVENT_UNFLAGGED_REDACTION", field: "redacted" };
    }
    let commitment;
    if (hasPayload) {
      commitment = agentPayloadHash(event.payload);
      if (commitment === null) return { ok: false, reason: "EVENT_BAD_PAYLOAD", field: "payload" };
      if (hasHash && commitment !== event.payloadHash.toLowerCase()) {
        return {
          ok: false,
          reason: "EVENT_PAYLOAD_HASH_MISMATCH",
          field: "payloadHash",
          carried: event.payloadHash.toLowerCase(),
          recomputed: commitment,
        };
      }
    } else {
      commitment = event.payloadHash.toLowerCase();
    }
    let metaJson = null;
    if ("meta" in event) {
      metaJson = agentCanonicalJson(event.meta, 0, { n: 0 });
      if (metaJson === null) return { ok: false, reason: "EVENT_BAD_META", field: "meta" };
    }
    return { ok: true, redacted: !hasPayload, payloadHash: commitment, metaJson };
  } catch (_) {
    return { ok: false, reason: "HOSTILE_INPUT" };
  }
}

// The redaction-safe LEAF VALUE of one validated event: the fixed-position JSON array preimage with
// the payload represented ONLY by its commitment (so a full event and its redacted twin derive the
// identical leaf). Returns null only for an encoding fault (kept total).
function agentEventLeaf(event, validated) {
  const encoded = JSON.stringify([
    AGENT_LEAF_DOMAIN,
    event.seq,
    event.ts,
    event.actor,
    event.type,
    validated.payloadHash,
    validated.metaJson,
  ]);
  const bytes = agentUtf8Bytes(encoded);
  return bytes === null ? null : merkle.hashBytes(bytes);
}

// The shared { size, root } head shape. Throws IOError (a malformed/foreign artifact, exit 1 — the same
// class `vh agent verify` gives a structurally invalid packet).
function validateAgentHeadShape(head, label) {
  if (head == null || typeof head !== "object" || Array.isArray(head)) {
    throw new IOError(`${label} \`head\` must be a { size, root } object`);
  }
  for (const k of Object.keys(head)) {
    if (k !== "size" && k !== "root") {
      throw new IOError(`${label} head has unknown field: ${JSON.stringify(k)}`);
    }
  }
  if (!Number.isSafeInteger(head.size) || head.size < 0) {
    throw new IOError(`${label} head.size must be a non-negative integer, got: ${String(head.size)}`);
  }
  if (typeof head.root !== "string" || !AGENT_HEX32_LC_RE.test(head.root)) {
    throw new IOError(
      `${label} head.root must be a LOWERCASE 0x-bytes32 hex string, got: ${String(head.root)}`
    );
  }
}

// STRICT structural validation of the OPTIONAL signed-head container: the exact canonical embedded
// bytes, a known scheme, lowercase signer/signature, and an embedded head payload in canonical form.
// Returns { embeddedHead } for the binding check. Throws IOError on any structural defect.
function validateAgentSignedHead(container) {
  const label = "agent-session packet headAttestation";
  if (container == null || typeof container !== "object" || Array.isArray(container)) {
    throw new IOError(`${label} must be a JSON object`);
  }
  const KNOWN = ["kind", "schemaVersion", "note", "attestation", "signature"];
  for (const k of Object.keys(container)) {
    if (!KNOWN.includes(k)) throw new IOError(`${label} has unknown field: ${JSON.stringify(k)}`);
  }
  if (container.kind !== AGENT_SIGNED_HEAD_KIND) {
    throw new IOError(
      `${label} kind must be ${JSON.stringify(AGENT_SIGNED_HEAD_KIND)}, got: ${JSON.stringify(container.kind)}`
    );
  }
  if (container.schemaVersion !== 1) {
    throw new IOError(`${label} has unsupported schemaVersion: ${JSON.stringify(container.schemaVersion)}`);
  }
  if (container.note !== AGENT_SIGNED_HEAD_TRUST_NOTE) {
    throw new IOError(`${label} note must be the standing signed-head trust note (caveat must not drift)`);
  }
  if (typeof container.attestation !== "string") {
    throw new IOError(`${label} must embed the canonical UNSIGNED head bytes as a string \`attestation\``);
  }
  let embedded;
  try {
    embedded = JSON.parse(container.attestation);
  } catch (e) {
    throw new IOError(`${label} embedded attestation is not valid JSON: ${e.message}`);
  }
  if (
    embedded == null ||
    typeof embedded !== "object" ||
    Array.isArray(embedded) ||
    embedded.kind !== AGENT_HEAD_KIND ||
    embedded.schemaVersion !== 1 ||
    embedded.note !== AGENT_TRUST_NOTE
  ) {
    throw new IOError(`${label} embedded payload is not a canonical ${JSON.stringify(AGENT_HEAD_KIND)} payload`);
  }
  validateAgentHeadShape(embedded.head, `${label} embedded payload`);
  // The embedded string must be the EXACT canonical serialization (the byte-unambiguous signed message);
  // an insignificant-whitespace/reordered variant is a foreign artifact.
  const canonicalText =
    JSON.stringify({
      kind: embedded.kind,
      schemaVersion: embedded.schemaVersion,
      note: embedded.note,
      head: { size: embedded.head.size, root: embedded.head.root },
    }) + "\n";
  if (container.attestation !== canonicalText) {
    throw new IOError(`${label} embedded attestation is not in canonical form (the signed-over bytes are ambiguous)`);
  }
  const sig = container.signature;
  if (sig == null || typeof sig !== "object" || Array.isArray(sig)) {
    throw new IOError(`${label} signature must be a { scheme, signer, signature } object`);
  }
  if (sig.scheme !== "eip191-personal-sign") {
    throw new IOError(
      `${label} has unsupported signature scheme: ${JSON.stringify(sig.scheme)} (this verifier understands eip191-personal-sign)`
    );
  }
  if (typeof sig.signer !== "string" || !AGENT_ADDRESS_LC_RE.test(sig.signer)) {
    throw new IOError(`${label} signer must be a LOWERCASE 0x-prefixed 20-byte hex address`);
  }
  if (typeof sig.signature !== "string" || !AGENT_SIG_LC_RE.test(sig.signature)) {
    throw new IOError(`${label} signature must be a 65-byte (r||s||v) LOWERCASE 0x-hex string`);
  }
  return { embeddedHead: { size: embedded.head.size, root: embedded.head.root } };
}

// STRICT structural validation of a parsed packet (SHAPE only — the per-event/leaf/root RECOMPUTE is
// verifyAgentSeal's job, so event-level tamper stays a NAMED verdict naming the seq, never a throw).
// Mirrors the producer's validatePacketShape defect-for-defect. Throws IOError.
function validateAgentPacketStructure(obj) {
  const label = "agent-session packet";
  const KNOWN = ["kind", "schemaVersion", "note", "head", "counts", "events", "leaves", "headAttestation"];
  for (const k of Object.keys(obj)) {
    if (!KNOWN.includes(k)) throw new IOError(`${label} has unknown field: ${JSON.stringify(k)}`);
  }
  if (!AGENT_PACKET_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new IOError(
      `unsupported ${label} schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this verifier understands ${JSON.stringify(AGENT_PACKET_SCHEMA_VERSIONS)})`
    );
  }
  if (obj.note !== AGENT_TRUST_NOTE) {
    throw new IOError(`${label} \`note\` must be the standing trust note (caveat must not drift)`);
  }
  validateAgentHeadShape(obj.head, label);
  if (obj.counts == null || typeof obj.counts !== "object" || Array.isArray(obj.counts)) {
    throw new IOError(`${label} \`counts\` must be a { events, full, redacted } object`);
  }
  for (const k of Object.keys(obj.counts)) {
    if (!["events", "full", "redacted"].includes(k)) {
      throw new IOError(`${label} counts has unknown field: ${JSON.stringify(k)}`);
    }
  }
  for (const k of ["events", "full", "redacted"]) {
    if (!Number.isSafeInteger(obj.counts[k]) || obj.counts[k] < 0) {
      throw new IOError(`${label} counts.${k} must be a non-negative integer, got: ${String(obj.counts[k])}`);
    }
  }
  if (!Array.isArray(obj.events)) throw new IOError(`${label} \`events\` must be an array`);
  if (!Array.isArray(obj.leaves) || obj.leaves.length !== obj.events.length) {
    throw new IOError(`${label} \`leaves\` must be an array with EXACTLY one leaf expectation per event`);
  }
  obj.leaves.forEach((l, i) => {
    if (typeof l !== "string" || !AGENT_HEX32_LC_RE.test(l)) {
      throw new IOError(`${label} leaves[${i}] must be a LOWERCASE 0x-bytes32 hex string, got: ${String(l)}`);
    }
  });
  if (obj.head.size !== obj.events.length) {
    throw new IOError(
      `${label} head.size (${obj.head.size}) does not match the events length (${obj.events.length})`
    );
  }
  if (obj.counts.events !== obj.events.length || obj.counts.full + obj.counts.redacted !== obj.counts.events) {
    throw new IOError(
      `${label} \`counts\` is internally inconsistent (events must equal the events length; full + redacted must equal events)`
    );
  }
  let signedHead = null;
  if (obj.headAttestation !== undefined) signedHead = validateAgentSignedHead(obj.headAttestation);
  return { packet: obj, signedHead };
}

// The AUTHORITATIVE per-event/leaf/root/counts RECOMPUTE over a shape-validated packet. Returns the
// engine's standard fileResult shape (matched/changed/... + roots) PLUS an `agent` sub-verdict block
// and a `reasonKind` in the verifier's reason vocabulary. Event faults are localized to the FIRST
// offending seq, exactly as the producer's verify names it. Never throws.
function verifyAgentSeal(packet) {
  const matched = [];
  const changed = [];
  const withheld = [];
  const agent = {
    head: { size: packet.head.size, root: packet.head.root },
    recomputedHead: null,
    counts: null,
    withheld: null,
    seq: null,
    reason: null,
  };
  const base = {
    matched,
    changed,
    missing: [],
    escaped: [],
    unexpected: [],
    sealedRoot: packet.head.root,
    recomputedRoot: null,
    rootMatches: null,
    filesOk: false,
    reasonKind: null,
    agent,
  };
  const events = packet.events;
  const leaves = [];
  for (let i = 0; i < events.length; i++) {
    const v = agentValidateEvent(events[i]);
    if (!v.ok) {
      agent.seq = i;
      agent.reason = v.reason;
      if (v.field !== undefined) agent.field = v.field;
      if (v.reason === "EVENT_PAYLOAD_HASH_MISMATCH") {
        // The payload no longer matches its carried commitment: a CONTENT change localized to its seq
        // (this is also how a REDACTED event's FORGED commitment surfaces once its leaf is checked).
        changed.push({ relPath: `events[${i}]`, expectedContentHash: v.carried, actualContentHash: v.recomputed });
        base.reasonKind = "CHANGED";
      } else {
        base.reasonKind = "event_invalid";
      }
      return base;
    }
    if (events[i].seq !== i) {
      agent.seq = i;
      agent.reason = "SESSION_SEQ_NOT_CONTIGUOUS";
      base.reasonKind = "event_invalid";
      return base;
    }
    const leaf = agentEventLeaf(events[i], v);
    if (leaf === null || leaf !== packet.leaves[i]) {
      // A bound-field edit (ts/actor/type/meta) or a forged redacted commitment: the re-derived leaf no
      // longer matches the packet's own expectation — named by seq, recompute authoritative.
      agent.seq = i;
      agent.reason = "EVENT_LEAF_MISMATCH";
      changed.push({ relPath: `events[${i}]`, expectedContentHash: packet.leaves[i], actualContentHash: leaf });
      base.reasonKind = "CHANGED";
      return base;
    }
    leaves.push(leaf);
    matched.push({ relPath: `events[${i}]`, contentHash: leaf });
    if (v.redacted) withheld.push(i);
  }
  const recomputedRoot = agentTreeRoot(leaves);
  base.recomputedRoot = recomputedRoot;
  agent.recomputedHead = { size: leaves.length, root: recomputedRoot };
  base.rootMatches = leaves.length === packet.head.size && recomputedRoot === packet.head.root;
  if (!base.rootMatches) {
    agent.reason = "HEAD_MISMATCH";
    base.reasonKind = "root_mismatch";
    return base;
  }
  const full = events.length - withheld.length;
  agent.counts = { events: events.length, full, redacted: withheld.length };
  agent.withheld = withheld;
  if (packet.counts.full !== full || packet.counts.redacted !== withheld.length) {
    agent.reason = "COUNTS_MISMATCH";
    base.reasonKind = "counts_mismatch";
    return base;
  }
  base.filesOk = true;
  return base;
}

// The artifact-level orchestrator for KINDS.AGENT_PACKET — both entrypoints (disk + bytes) route here
// through verifyParsedArtifact, so the two paths' verdicts are one code path (deep-equal by
// construction). Precedence mirrors the producer's `vh agent verify`: event/leaf/head/counts faults
// (naming the seq) dominate; then head binding, signature genuineness, and the vendor pin.
function verifyAgentPacketArtifact({ artifact, obj, pinned }) {
  const { signedHead } = validateAgentPacketStructure(obj); // throws IOError on a malformed/foreign packet
  const fileResult = verifyAgentSeal(obj);
  const agent = fileResult.agent;

  const signed = obj.headAttestation !== undefined;
  let recoveredSigner = null;
  let claimedSigner = null;
  let signatureOk = null;
  let signerMatchesVendor = null;
  let headBound = null;
  if (signed) {
    claimedSigner = obj.headAttestation.signature.signer; // lowercase, structurally enforced
    recoveredSigner = tryRecover(obj.headAttestation.attestation, obj.headAttestation.signature.signature);
    signatureOk = recoveredSigner != null && recoveredSigner === claimedSigner;
    if (agent.recomputedHead != null) {
      // The signature must vouch for THIS session's RECOMPUTED head — a signature pasted from a
      // different session recovers fine but binds a different { size, root }.
      headBound =
        signedHead.embeddedHead.size === agent.recomputedHead.size &&
        signedHead.embeddedHead.root === agent.recomputedHead.root;
    }
    if (signatureOk && pinned != null) signerMatchesVendor = recoveredSigner === pinned;
  }

  let accepted = true;
  let reason = "OK";
  if (!fileResult.filesOk) {
    accepted = false;
    reason = fileResult.reasonKind;
  } else if (signed && headBound === false) {
    accepted = false;
    reason = "head_not_bound";
    agent.reason = "HEAD_NOT_BOUND";
  } else if (signed && !signatureOk) {
    accepted = false;
    reason = "bad_signature";
    agent.reason = "SIGNATURE_FORGED";
  } else if (signed && pinned != null && signerMatchesVendor !== true) {
    accepted = false;
    reason = "wrong_issuer";
    agent.reason = "WRONG_VENDOR";
  } else if (!signed && pinned != null) {
    // Fail-closed pin: a stripped signature can never pass a pinned verify.
    accepted = false;
    reason = "unsigned_cannot_pin_vendor";
    agent.reason = "NOT_SIGNED";
  }

  const result = {
    artifact,
    kind: KINDS.AGENT_PACKET,
    payloadKind: KINDS.AGENT_PACKET,
    signed,
    verdict: accepted ? "OK" : "REJECTED",
    reason,
    accepted,
    recoveredSigner,
    claimedSigner,
    pinnedVendor: pinned,
    signatureOk,
    signerMatchesVendor,
    sealedRoot: fileResult.sealedRoot,
    recomputedRoot: fileResult.recomputedRoot,
    rootMatches: fileResult.rootMatches,
    counts: {
      matched: fileResult.matched.length,
      changed: fileResult.changed.length,
      missing: 0,
      escaped: 0,
      unexpected: 0,
    },
    matched: fileResult.matched,
    changed: fileResult.changed,
    missing: [],
    escaped: [],
    unexpected: [],
    agent,
    note: TRUST_NOTE,
  };
  return { result, code: accepted ? EXIT.OK : EXIT.REJECTED };
}

// ---------------------------------------------------------------------------
// PINNING TRANSPARENCY (T-75.2). Every verdict carries an explicit `pinning` field so an UNPINNED
// signer can never present as marketed "real provenance":
//   * "pinned"     — a --vendor pin was supplied AND the recovered signer equals it (the strong accept);
//   * "pin_failed" — a pin was supplied but could not be satisfied (wrong issuer, forged signature, or
//                    an unsigned artifact under a pin) — always a REJECTED verdict already;
//   * "unpinned"   — NO pin was supplied. For a SIGNED artifact the signature then only proves that
//                    SOME key signed these bytes — an attacker who re-signs a tampered release with
//                    their OWN key passes exactly the same check — and for an unsigned artifact nobody
//                    vouched at all.
// An ACCEPTED-but-unpinned verdict additionally carries `unpinnedNote` (the same statement the human
// renderer prints), and the CLI's --strict mode (below, outside the pure engine) turns it into the
// distinct fail-closed EXIT.UNPINNED. PURE: reads only fields already on the result.
// ---------------------------------------------------------------------------

function attachPinning(result) {
  if (result.pinnedVendor != null) {
    result.pinning = result.signerMatchesVendor === true ? "pinned" : "pin_failed";
  } else {
    result.pinning = "unpinned";
    if (result.accepted) {
      result.unpinnedNote = result.signed
        ? `UNPINNED: signed by ${result.recoveredSigner} — NOT pinned to a trusted vendor; anyone's ` +
          "key passes. Pin the producer you trust with --vendor <0xaddr> (obtained out-of-band); " +
          "--strict makes an unpinned accept a distinct non-zero exit."
        : "UNPINNED: this artifact is UNSIGNED and no vendor was pinned — the verdict proves " +
          "tamper-evidence of the bytes only, never WHO vouched for them; --strict makes an " +
          "unpinned accept a distinct non-zero exit.";
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// The core verify orchestration over an ALREADY-PARSED artifact object + an injected file source. This
// is the ONE engine BOTH entrypoints drive — `verifyArtifact` (disk: the CLI contract, byte-identical to
// before this seam existed) and `verifyArtifactFromBytes` (in-memory map). It auto-detects the artifact
// kind, decodes a signed container (recovering + pinning the signer), re-derives the root from
// referenced bytes, and assembles a deterministic verdict. PURE: every read goes through `readEntry`.
// Returns { result, code } — code is the EXIT-contract integer.
// ---------------------------------------------------------------------------

function verifyParsedArtifact({ artifact, obj, vendor, readEntry }) {
  const kind = obj.kind;
  const pinned = vendor != null ? normalizeAddress(vendor, "--vendor") : null;

  // AGENT-SESSION packet (T-68.3): SELF-CONTAINED — no sibling bytes, its own leaf/root convention and
  // its own in-packet signed head. Routed to the dedicated orchestrator above (`readEntry` unused).
  if (kind === KINDS.AGENT_PACKET) {
    const out = verifyAgentPacketArtifact({ artifact, obj, pinned });
    attachPinning(out.result); // T-75.2 — pinning transparency rides on EVERY verdict
    return out;
  }

  // Detect signed vs bare and the underlying payload kind. A signed container wraps the embedded payload.
  let signed = false;
  let recoveredSigner = null;
  let claimedSigner = null;
  let signatureOk = null; // null = no signature on this artifact
  let payload = obj; // the (possibly embedded) thing whose root we re-derive
  let payloadKind = kind;

  if (
    kind === KINDS.EVIDENCE_SEAL_SIGNED ||
    kind === KINDS.TRUST_SEAL_SIGNED ||
    kind === KINDS.DATASET_ATTESTATION_SIGNED ||
    kind === KINDS.DATASET_ATTESTATION_TIMESTAMPED
  ) {
    signed = true;
    const dec = decodeSigned(obj);
    payload = dec.embedded;
    payloadKind = dec.embedded.kind;
    claimedSigner = dec.claimedSigner;
    recoveredSigner = tryRecover(dec.message, dec.signature);
    // signatureOk: the signature recovers AND matches the CLAIMED signer recorded in the container.
    signatureOk = recoveredSigner != null && recoveredSigner === claimedSigner;
  } else if (!Object.values(KINDS).includes(kind)) {
    throw new UsageError(
      `unrecognized artifact kind: ${JSON.stringify(kind)} ` +
        "(verify-vh understands evidence seals, reconciliation seals, dataset attestations, and proof bundles)"
    );
  }

  // Re-derive the root from the referenced bytes per the (underlying) kind.
  let fileResult;
  if (payloadKind === KINDS.EVIDENCE_SEAL) {
    fileResult = verifyEvidenceSealWith(payload, readEntry);
  } else if (payloadKind === KINDS.TRUST_SEAL) {
    fileResult = verifyTrustSealWith(payload, readEntry);
  } else if (payloadKind === KINDS.DATASET_ATTESTATION) {
    fileResult = verifyDatasetAttestation(payload);
  } else if (payloadKind === KINDS.PROOF) {
    fileResult = verifyProofBundle(payload);
  } else {
    throw new UsageError(
      `unrecognized embedded artifact kind: ${JSON.stringify(payloadKind)}`
    );
  }

  // --- Decide the verdict + the deterministic reason. ---
  // Precedence: a structural file tamper (CHANGED/MISSING/root mismatch) is a clean REJECTED. For a
  // SIGNED artifact, a broken signature is `bad_signature`; a recovered signer that does not equal the
  // pinned --vendor is `wrong_issuer`. Both are clean REJECTED verdicts (exit 3), never a crash.
  let reason = "OK";
  let accepted = true;

  const escaped = fileResult.escaped || [];
  if (!fileResult.filesOk) {
    accepted = false;
    // path_escape DOMINATES: an artifact that tries to read outside its source is malicious by
    // construction (the threat model is a hostile producer probing the counterparty's filesystem), so it
    // is reported FIRST — never as a benign CHANGED/MISSING, and never with a leaked out-of-tree content
    // hash.
    if (escaped.length > 0) reason = "path_escape";
    else if (fileResult.changed.length > 0) reason = "CHANGED";
    else if (fileResult.missing.length > 0) reason = "MISSING";
    else if (fileResult.unexpected.length > 0) reason = "UNEXPECTED";
    else reason = "root_mismatch";
  }

  // Signature checks (only for signed artifacts). A bad signature dominates the "issuer" check (you
  // cannot trust an issuer you cannot recover).
  let signerMatchesVendor = null;
  if (signed) {
    if (!signatureOk) {
      accepted = false;
      // bad_signature is the dominant reason ONLY if files were otherwise OK; if a file also changed we
      // still surface bad_signature because the signature is the trust root of a signed artifact.
      reason = "bad_signature";
    } else if (pinned != null) {
      signerMatchesVendor = recoveredSigner === pinned;
      if (!signerMatchesVendor) {
        accepted = false;
        // wrong_issuer only when the signature itself is sound but the signer is not the pinned vendor.
        if (fileResult.filesOk) reason = "wrong_issuer";
        else if (reason === "OK") reason = "wrong_issuer";
      }
    }
  } else if (pinned != null) {
    // A --vendor pin on an UNSIGNED artifact cannot be satisfied (there is no signer to recover); this is
    // a clean REJECTED wrong_issuer-style verdict so a CI gate expecting a signed-by-vendor artifact fails.
    accepted = false;
    reason = "unsigned_cannot_pin_vendor";
  }

  const verdict = accepted ? "OK" : "REJECTED";
  const code = accepted ? EXIT.OK : EXIT.REJECTED;

  const result = {
    artifact,
    kind,
    payloadKind,
    signed,
    verdict,
    reason,
    accepted,
    recoveredSigner,
    claimedSigner,
    pinnedVendor: pinned,
    signatureOk,
    signerMatchesVendor,
    sealedRoot: fileResult.sealedRoot,
    recomputedRoot: fileResult.recomputedRoot,
    rootMatches: fileResult.rootMatches,
    counts: {
      matched: fileResult.matched.length,
      changed: fileResult.changed.length,
      missing: fileResult.missing.length,
      escaped: escaped.length,
      unexpected: fileResult.unexpected.length,
    },
    matched: fileResult.matched,
    changed: fileResult.changed,
    missing: fileResult.missing,
    escaped,
    unexpected: fileResult.unexpected,
    note: TRUST_NOTE,
  };
  if (fileResult.identityOnly) result.identityOnly = true;
  if (fileResult.proof) result.proof = fileResult.proof;
  attachPinning(result); // T-75.2 — pinning transparency rides on EVERY verdict

  return { result, code };
}

// ---------------------------------------------------------------------------
// The PURE revocation fold for the bytes path. Semantically identical to revocation.loadAndApply (the
// disk integration) once the entries are in hand: resolve the as-of instant (defaulting to nowISO),
// normalize the caller-supplied revocations input (a JSON string, a container object, or an array of
// either), fold the decision onto the result, and recompute the exit code. Uses ONLY the pure decision
// functions (./lib/revocation-core.js via the revocation re-exports) — never the fs-backed reader.
// ---------------------------------------------------------------------------

function applyRevocationsDecision(result, revocationsInput, asOf, nowISO) {
  const resolved = revocation.resolveAsOf(asOf, nowISO);
  const entries = revocation.normalizeRevocationsInput(revocationsInput);
  const downgraded = revocation.applyToVerifyResult({ result, revocations: entries, asOf: resolved.asOf });
  downgraded.trustAsOfDefaulted = resolved.defaulted;
  return { result: downgraded, code: downgraded.accepted ? EXIT.OK : EXIT.REJECTED };
}

// ---------------------------------------------------------------------------
// THE IN-MEMORY FILE SOURCE + BYTES ENTRYPOINT (T-66.1).
//
// `verifyArtifactFromBytes({ artifactText, files, vendor, revocationsText, asOf, nowISO, artifactName })`
// drives the EXACT engine above over caller-supplied bytes:
//   * `artifactText` — the artifact JSON as a STRING (what a browser read out of a dropped file);
//   * `files`        — a plain `{ relPath: Uint8Array|Buffer }` map of the packet's referenced bytes;
//   * `vendor`       — optional 0x-address pin (same semantics as `--vendor`);
//   * `revocationsText` — optional revocations input (JSON text / container / array; same semantics as
//     the CONTENT of a `--revocations` file), with optional `asOf` (canonical ISO instant) + `nowISO`;
//   * `artifactName` — optional label used verbatim as `result.artifact` (defaults below).
//
// CONTRACT — NEVER THROWS. Hostile input (non-JSON artifact text, an oversized / absolute / `..` map
// key, a non-bytes map value, a malformed vendor or asOf) is NAMED-rejected: the return value is
//   { ok, code, result, error }
// where a computed verdict carries `result` (the SAME structured shape `verifyArtifact` returns — the
// two are DEEP-EQUAL on identical inputs) + `error: null`, and an input problem carries `result: null` +
// `error: { name: "UsageError"|"IOError", code, message }` with the exact defect named. The verdict
// classes (missing / extra / content-mismatch / wrong-vendor / tampered-signature / path_escape /
// revoked) derive from the MAP exactly as the disk path derives them from the directory.
// ---------------------------------------------------------------------------

// The largest relPath key the in-memory map accepts. Sealed relPaths are short; a multi-kilobyte "key"
// is hostile input (an attempted resource-exhaustion / log-flooding vector), rejected by NAME up front.
const MAX_RELPATH_CHARS = 4096;

// PURE string-level confinement for an in-memory relPath — the map-source mirror of the disk source's
// string checks (absolute anywhere, or any `..` traversal component, is hostile). Windows-style drive
// and UNC prefixes are treated as absolute here too: an in-memory map NEVER has a legitimate absolute
// key, whatever platform authored the artifact.
function isTraversalOrAbsoluteRelPath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) return true;
  if (relPath.charAt(0) === "/" || relPath.charAt(0) === "\\") return true;
  if (/^[A-Za-z]:[\\/]/.test(relPath)) return true;
  if (relPath.split(/[\\/]/).includes("..")) return true;
  return false;
}

// Validate the caller's `{ relPath: bytes }` map SHAPE up front so a hostile map is NAMED-rejected
// before any verification work (and before any key is dereferenced). Throws UsageError; the entrypoint
// converts that into the structured `{ error }` return — never an uncaught throw.
function validateFilesMap(files) {
  if (files == null || typeof files !== "object" || Array.isArray(files)) {
    throw new UsageError(
      "verifyArtifactFromBytes requires `files` as a plain { relPath: Uint8Array|Buffer } object map"
    );
  }
  for (const key of Object.keys(files)) {
    if (key.length === 0) {
      throw new UsageError("files map contains an empty relPath key");
    }
    if (key.length > MAX_RELPATH_CHARS) {
      throw new UsageError(
        `files map key exceeds ${MAX_RELPATH_CHARS} characters (oversized relPath, starts: ` +
          `${JSON.stringify(key.slice(0, 64))})`
      );
    }
    if (isTraversalOrAbsoluteRelPath(key)) {
      throw new UsageError(
        `files map key is not a confined relative path: ${JSON.stringify(key.slice(0, 256))}`
      );
    }
    const v = files[key];
    if (!(v instanceof Uint8Array)) {
      throw new UsageError(
        `files map value for ${JSON.stringify(key.slice(0, 256))} must be a Uint8Array/Buffer of the file's bytes`
      );
    }
  }
}

// The in-memory `readEntry` source over an (already-validated) map: a hostile relPath from the ARTIFACT
// is `escaped` (the same string-level rules as the disk source — so absolute/`..` seal entries produce
// the identical path_escape verdict), an absent key is `missing`, and a present key answers its bytes.
// Lookups use an own-property check so `__proto__`/`constructor` style keys can never smuggle
// prototype-chain values in as file bytes.
function makeMapReadEntry(files) {
  return function readEntry(relPath) {
    if (isTraversalOrAbsoluteRelPath(relPath)) return { status: "escaped" };
    if (!Object.prototype.hasOwnProperty.call(files, relPath)) return { status: "missing" };
    return { status: "ok", bytes: files[relPath] };
  };
}

function verifyArtifactFromBytes(params) {
  try {
    if (params == null || typeof params !== "object" || Array.isArray(params)) {
      throw new UsageError(
        "verifyArtifactFromBytes requires a params object: " +
          "{ artifactText, files, vendor?, revocationsText?, asOf?, nowISO?, artifactName? }"
      );
    }
    const { artifactText, files, vendor, revocationsText, asOf, nowISO, artifactName } = params;
    if (typeof artifactText !== "string") {
      throw new UsageError("verifyArtifactFromBytes requires `artifactText` (the artifact JSON as a string)");
    }
    validateFilesMap(files);

    // Mirror the CLI's flag-shape gate (parseArgs): asOf only means something alongside revocations, and
    // must be a canonical ISO-8601 UTC instant — a malformed one is a NAMED usage rejection up front,
    // never a mid-verify throw.
    if (asOf !== undefined && asOf !== null && (revocationsText === undefined || revocationsText === null)) {
      throw new UsageError(
        "asOf requires revocationsText (it pins the instant the revocation decision is made AS OF)"
      );
    }
    if (asOf !== undefined && asOf !== null) {
      const ms = Date.parse(asOf);
      if (
        typeof asOf !== "string" ||
        !revocation.ISO_INSTANT_RE.test(asOf) ||
        Number.isNaN(ms) ||
        new Date(ms).toISOString() !== asOf
      ) {
        throw new UsageError(
          `invalid asOf: ${String(asOf)} (expected a canonical ISO-8601 UTC instant, e.g. 2026-06-01T00:00:00.000Z)`
        );
      }
    }

    const label = artifactName != null ? String(artifactName) : "(in-memory artifact)";
    let obj;
    try {
      obj = JSON.parse(artifactText);
    } catch (e) {
      throw new IOError(`artifact ${label} is not valid JSON: ${e.message}`);
    }
    if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
      throw new IOError(`artifact ${label} must be a JSON object`);
    }

    const { result, code } = verifyParsedArtifact({
      artifact: label,
      obj,
      vendor,
      readEntry: makeMapReadEntry(files),
    });

    // OPTIONAL recipient-side TRUST-DECISION-AS-OF, from caller-supplied revocations INPUT (never a
    // filesystem read). Same downgrade math as the disk path's revocation.loadAndApply, so the two
    // paths' results stay deep-equal on identical inputs.
    if (revocationsText !== undefined && revocationsText !== null) {
      let applied;
      try {
        applied = applyRevocationsDecision(result, revocationsText, asOf, nowISO || new Date().toISOString());
      } catch (e) {
        // A non-JSON / wrong-shape revocations input is the bytes-path analogue of an unreadable
        // --revocations file: a NAMED IO-class rejection, never a silently-skipped downgrade.
        throw new IOError(`cannot evaluate revocations: ${e.message}`);
      }
      return { ok: applied.result.accepted, code: applied.code, result: applied.result, error: null };
    }

    return { ok: result.accepted, code, result, error: null };
  } catch (e) {
    const isUsage = e instanceof UsageError;
    const code = isUsage ? EXIT.USAGE : EXIT.IO;
    return {
      ok: false,
      code,
      result: null,
      error: {
        name: isUsage ? "UsageError" : "IOError",
        code,
        message: String(e && e.message ? e.message : e),
      },
    };
  }
}

// ============================= END VERIFY-VH PURE ENGINE (T-66.1) =============================

// ===================================================================================================
// ANCHORED-RECEIPT OFFLINE BINDING VERIFY (T-70.4) — `verify-vh <receipt> --anchored-artifact <seal>`.
//
// WHY THIS EXISTS
//   `vh anchor-artifact` (EPIC-70) emits a canonical `vh-anchored-receipt@1` container binding ONE
//   sealed artifact's digest to an on-chain registry record. Its OFFLINE binding leg is pure hashing —
//   but until T-70.4 it ran ONLY through the producer `cli/` stack (which loads `ethers` at module
//   load), so the family's zero-install "verify without the producer's stack" promise did not reach
//   the receipt. This section closes that gap: it is an INDEPENDENT, dependency-free port of the
//   producer core `cli/core/anchor-binding.js` — the receipt container validation, the CLOSED
//   six-kind digest table, and the binding verdict — written entirely against the verifier's OWN
//   primitives (lib/merkle keccak, lib/canonical, Node-core sha256). NO `ethers`, NO `cli/` import.
//
// WHAT IT CHECKS (and what it does NOT)
//   OFFLINE binding leg ONLY: the receipt is validated STRICTLY (unknown/missing fields, a drifted
//   trust note, malformed chain facts — each a named `bad-receipt`), the artifact's ONE canonical
//   digest is RECOMPUTED through the SAME closed kind table the producer uses (each leg re-validating
//   the artifact through a strict port of its shipped validator first), and the full
//   { kind, digest, how } triple must match — `kind-mismatch` / `digest-mismatch` / `how-mismatch`
//   are the specific named rejects, exactly the producer's verdict vocabulary. The receipt's `chain`
//   facts remain the ANCHORER'S CLAIM: re-checking them against the chain needs a chain endpoint by
//   definition and stays with the producer cli (`vh verify-anchored --rpc --contract`).
//
// PARITY DISCIPLINE (pinned by test/verifier.standalone.test.js)
//   Every wire-format constant here (the receipt kind, the verbatim ANCHOR_TRUST_NOTE, the reason
//   codes, the closed kind list, the per-kind derivation-rule `how` strings) MUST equal the producer
//   core's byte-for-byte, and the verdicts on identical inputs MUST match the producer's — the test
//   asserts both mechanically, so neither side can drift alone. TOTAL: hostile input yields a named
//   { ok:false, reason, field?, detail? }, never a throw.
// ===================================================================================================

// The container kind + the standing trust note, VERBATIM the producer's (cli/core/anchor-binding.js).
const ANCHORED_RECEIPT_KIND = "vh-anchored-receipt@1";

const ANCHOR_TRUST_NOTE =
  "This anchored receipt binds the artifact digest above to an on-chain registry record. A receipt " +
  "from a LOCAL dev chain proves MECHANISM only and is worth NOTHING publicly until a human deploys " +
  "the registry (STRATEGY.md P-2). On a public chain it proves ONLY that an on-chain record binds " +
  "this exact digest at a block whose timestamp BOUNDS existence — as trustworthy as the chain + " +
  "YOUR pinned contract address — NOT the artifact's truth, NOT faithful recording, NOT attribution " +
  "beyond the anchoring key. The `chain` facts in this receipt are the anchorer's claim until " +
  "re-checked against the chain (`vh verify-anchored --rpc`).";

// The stable, named reason codes — the producer's verdict contract, byte-for-byte.
const ANCHOR_REASONS = Object.freeze({
  NOT_AN_OBJECT: "not-an-object",
  UNKNOWN_KIND: "unknown-kind",
  EVIDENCE_SEAL_INVALID: "evidence-seal-invalid",
  AGENT_PACKET_INVALID: "agent-packet-invalid",
  JOURNAL_TREE_HEAD_INVALID: "journal-tree-head-invalid",
  TRUSTLEDGER_SEAL_INVALID: "trustledger-seal-invalid",
  DATASET_ATTESTATION_INVALID: "dataset-attestation-invalid",
  PARCEL_ATTESTATION_INVALID: "parcel-attestation-invalid",
  BAD_ARGS: "bad-args",
  BAD_DIGEST: "bad-digest",
  BAD_HOW: "bad-how",
  BAD_LABEL: "bad-label",
  BAD_CHAIN: "bad-chain",
  BAD_RECEIPT: "bad-receipt",
  DIGEST_MISMATCH: "digest-mismatch",
  KIND_MISMATCH: "kind-mismatch",
  HOW_MISMATCH: "how-mismatch",
});

// The two closed-table kinds this verifier did not already name (the other four reuse KINDS above).
const ANCHOR_JOURNAL_TREE_HEAD_KIND = "vh.journal-tree-head";
const ANCHOR_PARCEL_ATTESTATION_KIND = "verifyhash.parcel-attestation";

// The CLOSED, frozen kind table — same six kinds, same order as the producer core.
const ANCHOR_ARTIFACT_KINDS = Object.freeze([
  KINDS.EVIDENCE_SEAL, // "vh.evidence-seal"
  KINDS.AGENT_PACKET, // "vh.agent-session-packet"
  ANCHOR_JOURNAL_TREE_HEAD_KIND, // "vh.journal-tree-head"
  KINDS.TRUST_SEAL, // "trustledger.reconcile-seal"
  KINDS.DATASET_ATTESTATION, // "verifyhash.dataset-attestation"
  ANCHOR_PARCEL_ATTESTATION_KIND, // "verifyhash.parcel-attestation"
]);

// Canonical-case wire shapes (the receipt is canonical LOWERCASE; artifacts may carry mixed-case hex
// exactly where the producer validators accept it).
const ANCHOR_HEX32_LC_RE = /^0x[0-9a-f]{64}$/;
const ANCHOR_ADDRESS_LC_RE = /^0x[0-9a-f]{40}$/;
const ANCHOR_CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const ANCHOR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function anchorIsPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// The per-kind derivation rules (`how`) — VERBATIM the producer's HOW_FIXED table. These are WIRE
// FORMAT (bound into every receipt), so they name the producer's files even though THIS verifier
// re-derives the digest with its own independent code: the rule describes the derivation, and the
// parity test pins these strings against the producer core byte-for-byte.
const ANCHOR_HOW_FIXED = Object.freeze({
  [KINDS.EVIDENCE_SEAL]:
    "digest = the evidence packet's `root` (sorted-pair Merkle root over its path-bound file leaves), " +
    "re-derived by cli/evidence.js readSeal before extraction",
  [KINDS.AGENT_PACKET]:
    "digest = the agent-session packet's verified head `root` (RFC-6962 ordered Merkle root over the " +
    "event leaves), re-derived by cli/agent.js verifyPacket before extraction",
  [KINDS.TRUST_SEAL]:
    "digest = the TrustLedger sealfile's `root` (Merkle root over its committed input/output leaves + " +
    "verdict header), re-derived by trustledger/seal.js readSeal before extraction",
  [KINDS.DATASET_ATTESTATION]:
    "digest = 0x + sha256 over the canonical UNSIGNED dataset-attestation bytes, exactly as " +
    "`vh dataset timestamp-request` computes it (cli/core/timestamp.js sha256Hex)",
  [ANCHOR_PARCEL_ATTESTATION_KIND]:
    "digest = 0x + sha256 over the canonical UNSIGNED parcel-attestation bytes, exactly as " +
    "`vh parcel timestamp-request` computes it (cli/core/timestamp.js sha256Hex)",
});

function anchorJournalHow(size) {
  return (
    `digest = the journal tree head \`root\` (RFC-6962 ordered Merkle root, cli/journal-log.js ` +
    `treeHead) over ${size} entries; the head size is bound into this derivation rule`
  );
}

const ANCHOR_JOURNAL_HOW_RE =
  /^digest = the journal tree head `root` \(RFC-6962 ordered Merkle root, cli\/journal-log\.js treeHead\) over (0|[1-9][0-9]*) entries; the head size is bound into this derivation rule$/;

function anchorHowValidFor(kind, how) {
  if (typeof how !== "string") return false;
  if (kind === ANCHOR_JOURNAL_TREE_HEAD_KIND) {
    const m = ANCHOR_JOURNAL_HOW_RE.exec(how);
    return m !== null && Number.isSafeInteger(Number(m[1]));
  }
  return how === ANCHOR_HOW_FIXED[kind];
}

function anchorOk(digest, kind, how) {
  return { ok: true, digest, kind, how };
}
function anchorNo(reason, detail) {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

// ---------------------------------------------------------------------------------------------------
// The per-kind STRICT validators + digest extraction — independent ports of the artifacts' shipped
// validators (the messages mirror the producers' so the named verdict a counterparty reads is the
// same either way). Each leg is TOTAL: a defect is a named reject, never a throw out of this section.
// ---------------------------------------------------------------------------------------------------

// vh.evidence-seal — a strict port of cli/core/packetseal.js validateSeal under the evidence config
// (kind/schemaVersion/note pinned, per-entry leaf self-consistency, NO header, and the LOAD-BEARING
// root re-derivation from the seal's OWN (relPath, contentHash) leaves via the verifier's merkle lib).
const ANCHOR_EVIDENCE_TRUST_NOTE =
  "This evidence seal is TAMPER-EVIDENT + OFFLINE-RECOMPUTABLE, NOT a trusted timestamp. Its Merkle " +
  "`root` commits to the full set of (relPath, content) pairs in the directory: any edit, rename, add, " +
  "or remove changes the root, and verify RE-DERIVES the root from the bytes you hold and LOCALIZES the " +
  "change to the exact file (MATCH / CHANGED / MISSING / UNEXPECTED). It does NOT prove WHEN the sealing " +
  'happened ("sealed at T" rides the human-owned signing/timestamp trust-root, STRATEGY.md P-3) and it ' +
  "is NOT a legal opinion. The packet is an UNTRUSTED transport container: verify never trusts the " +
  "packet's own stored hashes.";
const ANCHOR_EVIDENCE_SCHEMA_VERSIONS = Object.freeze([1]);

// Shared strict per-entry + root checks for the two packetseal-family legs. `label` carries the
// product wording; `headerLeaf` (when non-null) is folded into the root as the reserved header entry.
function anchorCheckSealEntries(entries, label, where, seenRelPath, flat, headerRelPath) {
  entries.forEach((entry, i) => {
    if (!anchorIsPlainObject(entry)) {
      throw new Error(`${label} ${where}[${i}] must be an object`);
    }
    if (typeof entry.relPath !== "string" || entry.relPath.length === 0) {
      throw new Error(`${label} ${where}[${i}].relPath must be a non-empty string`);
    }
    if (headerRelPath !== null && entry.relPath === headerRelPath) {
      throw new Error(
        `${label} ${where}[${i}].relPath ${JSON.stringify(entry.relPath)} is reserved for the seal header`
      );
    }
    if (seenRelPath.has(entry.relPath)) {
      throw new Error(`${label} has a duplicate relPath across the file set: ${JSON.stringify(entry.relPath)}`);
    }
    seenRelPath.add(entry.relPath);
    for (const f of ["contentHash", "leaf"]) {
      if (typeof entry[f] !== "string" || !merkle.HEX32_RE.test(entry[f])) {
        throw new Error(
          `${label} ${where}[${i}].${f} must be a 0x-prefixed 32-byte hex string, got: ${String(entry[f])}`
        );
      }
    }
    const expectedLeaf = merkle.pathLeaf(entry.relPath, entry.contentHash);
    if (entry.leaf.toLowerCase() !== expectedLeaf.toLowerCase()) {
      throw new Error(
        `${label} ${where}[${i}].leaf is inconsistent with its relPath+contentHash ` +
          `(expected ${expectedLeaf}, got ${entry.leaf})`
      );
    }
    flat.push({ relPath: entry.relPath, contentHash: entry.contentHash });
  });
}

function anchorValidateEvidenceSeal(obj) {
  const label = "evidence seal";
  if (!anchorIsPlainObject(obj)) throw new Error(`${label} must be a JSON object`);
  if (obj.kind !== KINDS.EVIDENCE_SEAL) {
    throw new Error(`not a ${label} (kind: ${JSON.stringify(obj.kind)}; expected ${JSON.stringify(KINDS.EVIDENCE_SEAL)})`);
  }
  if (!ANCHOR_EVIDENCE_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new Error(
      `unsupported ${label} schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(ANCHOR_EVIDENCE_SCHEMA_VERSIONS)})`
    );
  }
  if (obj.note !== ANCHOR_EVIDENCE_TRUST_NOTE) {
    throw new Error(`${label} \`note\` must be the standing trust note (caveat must not drift)`);
  }
  if (typeof obj.root !== "string" || !merkle.HEX32_RE.test(obj.root)) {
    throw new Error(`${label} root must be a 0x-prefixed 32-byte hex string, got: ${String(obj.root)}`);
  }
  if (!Array.isArray(obj.files) || obj.files.length === 0) {
    throw new Error(`${label} \`files\` must be a non-empty array`);
  }
  const flat = [];
  anchorCheckSealEntries(obj.files, label, "files", new Set(), flat, null);
  if (obj.fileCount !== undefined && obj.fileCount !== obj.files.length) {
    throw new Error(`${label} fileCount (${String(obj.fileCount)}) does not match the files length (${obj.files.length})`);
  }
  if (obj.header !== undefined) {
    throw new Error(`${label} carries a header but its config declares none`);
  }
  const rederived = merkle.rootFromFlat(flat);
  if (rederived.toLowerCase() !== obj.root.toLowerCase()) {
    throw new Error(
      `${label} root does not re-derive from its listed entries ` +
        `(expected ${rederived}, got ${obj.root}) — the seal is internally inconsistent ` +
        "(a file was edited without updating the root)"
    );
  }
  return obj;
}

function anchorEvidenceDigest(artifact) {
  try {
    anchorValidateEvidenceSeal(artifact);
  } catch (e) {
    return anchorNo(ANCHOR_REASONS.EVIDENCE_SEAL_INVALID, e && e.message ? e.message : String(e));
  }
  return anchorOk(artifact.root.toLowerCase(), KINDS.EVIDENCE_SEAL, ANCHOR_HOW_FIXED[KINDS.EVIDENCE_SEAL]);
}

// vh.agent-session-packet — REUSES this verifier's OWN independent agent engine verbatim: the strict
// packet-structure validation + the authoritative per-event/leaf/root/counts recompute, PLUS (when a
// headAttestation is present) the head-binding and signature-genuineness checks — the exact facts the
// producer's `agent.verifyPacket` gates the digest on (a vendor pin is not part of digest extraction).
function anchorAgentDigest(artifact) {
  let structure;
  try {
    structure = validateAgentPacketStructure(artifact);
  } catch (e) {
    return anchorNo(ANCHOR_REASONS.AGENT_PACKET_INVALID, e && e.message ? e.message : String(e));
  }
  const fileResult = verifyAgentSeal(artifact);
  const agent = fileResult.agent;
  const seqOf = () => (agent.seq !== null && agent.seq !== undefined ? ` at seq ${agent.seq}` : "");
  if (!fileResult.filesOk) {
    const reason = agent.reason || fileResult.reasonKind || "REJECTED";
    return anchorNo(ANCHOR_REASONS.AGENT_PACKET_INVALID, `packet verify REJECTED: ${reason}${seqOf()}`);
  }
  if (artifact.headAttestation !== undefined) {
    const embedded = structure.signedHead.embeddedHead;
    const bound =
      embedded.size === agent.recomputedHead.size && embedded.root === agent.recomputedHead.root;
    if (!bound) {
      return anchorNo(ANCHOR_REASONS.AGENT_PACKET_INVALID, "packet verify REJECTED: HEAD_NOT_BOUND");
    }
    const claimed = artifact.headAttestation.signature.signer; // lowercase, structurally enforced
    const recovered = tryRecover(artifact.headAttestation.attestation, artifact.headAttestation.signature.signature);
    if (recovered == null || recovered !== claimed) {
      return anchorNo(ANCHOR_REASONS.AGENT_PACKET_INVALID, "packet verify REJECTED: SIGNATURE_FORGED");
    }
  }
  return anchorOk(fileResult.recomputedRoot, KINDS.AGENT_PACKET, ANCHOR_HOW_FIXED[KINDS.AGENT_PACKET]);
}

// vh.journal-tree-head — the bare { size, root } commitment or its kind-tagged twin. The empty-root
// constant is re-derived HERE from the family's domain string with the verifier's own keccak (equal
// to cli/journal-log.js EMPTY_ROOT — pinned by the parity test).
const ANCHOR_JOURNAL_EMPTY_ROOT = merkle.hashBytes(Buffer.from(AGENT_EMPTY_ROOT_DOMAIN, "utf8"));

function anchorJournalHeadDigest(artifact, tagged) {
  const allowed = tagged ? ["kind", "size", "root"] : ["size", "root"];
  for (const k of Object.keys(artifact)) {
    if (!allowed.includes(k)) {
      return anchorNo(
        ANCHOR_REASONS.JOURNAL_TREE_HEAD_INVALID,
        `journal tree head has unknown field: ${JSON.stringify(k)}`
      );
    }
  }
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) {
    return anchorNo(
      ANCHOR_REASONS.JOURNAL_TREE_HEAD_INVALID,
      `journal tree head size must be a non-negative integer, got: ${String(artifact.size)}`
    );
  }
  if (typeof artifact.root !== "string" || !ANCHOR_HEX32_LC_RE.test(artifact.root)) {
    return anchorNo(
      ANCHOR_REASONS.JOURNAL_TREE_HEAD_INVALID,
      `journal tree head root must be a LOWERCASE 0x-bytes32 hex string, got: ${String(artifact.root)}`
    );
  }
  if (artifact.size === 0 && artifact.root !== ANCHOR_JOURNAL_EMPTY_ROOT) {
    return anchorNo(
      ANCHOR_REASONS.JOURNAL_TREE_HEAD_INVALID,
      `an EMPTY journal tree head (size 0) must carry the documented empty root ${ANCHOR_JOURNAL_EMPTY_ROOT}`
    );
  }
  if (artifact.size > 0 && artifact.root === ANCHOR_JOURNAL_EMPTY_ROOT) {
    return anchorNo(
      ANCHOR_REASONS.JOURNAL_TREE_HEAD_INVALID,
      "a non-empty journal tree head cannot carry the domain-separated EMPTY root"
    );
  }
  return anchorOk(artifact.root, ANCHOR_JOURNAL_TREE_HEAD_KIND, anchorJournalHow(artifact.size));
}

// trustledger.reconcile-seal — a strict port of trustledger/seal.js validateSeal: the verdict/role/
// inputs/outputs checks, per-entry leaf self-consistency, and the LOAD-BEARING root re-derivation from
// the seal's OWN leaves PLUS the synthetic verdict/role HEADER leaf (content re-derived from the
// seal's recorded verdict + input role bindings via the verifier's own lib/canonical port).
const ANCHOR_TRUST_SEAL_NOTE =
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
const ANCHOR_TRUST_SEAL_SCHEMA_VERSIONS = Object.freeze([1]);
const ANCHOR_TRUST_SEAL_INPUT_ROLES = Object.freeze(["bank", "book", "rentroll"]);
const ANCHOR_TRUST_SEAL_CORE_LABEL = "trustledger reconciliation seal";

function anchorValidateTrustSeal(obj) {
  if (!anchorIsPlainObject(obj)) throw new Error("seal must be a JSON object");
  if (obj.kind !== KINDS.TRUST_SEAL) {
    throw new Error(
      `not a trustledger reconciliation seal (kind: ${JSON.stringify(obj.kind)}; expected ` +
        `${JSON.stringify(KINDS.TRUST_SEAL)})`
    );
  }
  if (!ANCHOR_TRUST_SEAL_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new Error(
      `unsupported seal schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(ANCHOR_TRUST_SEAL_SCHEMA_VERSIONS)})`
    );
  }
  if (obj.note !== ANCHOR_TRUST_SEAL_NOTE) {
    throw new Error("seal `note` must be the standing SEAL_TRUST_NOTE (caveat must not drift)");
  }
  if (typeof obj.root !== "string" || !merkle.HEX32_RE.test(obj.root)) {
    throw new Error(`seal root must be a 0x-prefixed 32-byte hex string, got: ${String(obj.root)}`);
  }
  if (!anchorIsPlainObject(obj.verdict)) {
    throw new Error("seal is missing `verdict` { pass, reportDate }");
  }
  if (typeof obj.verdict.pass !== "boolean") {
    throw new Error("seal verdict.pass must be a boolean");
  }
  if (!ANCHOR_DATE_RE.test(String(obj.verdict.reportDate || ""))) {
    throw new Error('seal verdict.reportDate must be a "YYYY-MM-DD" string');
  }
  if (!("period" in obj.verdict)) {
    throw new Error("seal verdict is missing `period` (may be null)");
  }
  if (obj.verdict.period !== null && typeof obj.verdict.period !== "string") {
    throw new Error("seal verdict.period must be a string or null");
  }
  if (!Array.isArray(obj.inputs) || obj.inputs.length === 0) {
    throw new Error("seal `inputs` must be a non-empty array");
  }
  if (!Array.isArray(obj.outputs) || obj.outputs.length === 0) {
    throw new Error("seal `outputs` must be a non-empty array");
  }

  const seenRelPath = new Set();
  const seenRole = new Set();
  const flat = [];
  // Per-entry checks use the trustledger wording (`seal inputs[0]...`); the reserved-header check uses
  // the core-config label, exactly as the producer's core-delegated view reports it.
  const checkEntries = (entries, where) => {
    entries.forEach((entry, i) => {
      if (!anchorIsPlainObject(entry)) throw new Error(`seal ${where}[${i}] must be an object`);
      if (typeof entry.relPath !== "string" || entry.relPath.length === 0) {
        throw new Error(`seal ${where}[${i}].relPath must be a non-empty string`);
      }
      if (entry.relPath === canonical.TRUST_SEAL_HEADER_RELPATH) {
        throw new Error(
          `${ANCHOR_TRUST_SEAL_CORE_LABEL} files[${flat.length}].relPath ` +
            `${JSON.stringify(entry.relPath)} is reserved for the seal header`
        );
      }
      if (seenRelPath.has(entry.relPath)) {
        throw new Error(`seal has a duplicate relPath across the file set: ${JSON.stringify(entry.relPath)}`);
      }
      seenRelPath.add(entry.relPath);
      for (const f of ["contentHash", "leaf"]) {
        if (typeof entry[f] !== "string" || !merkle.HEX32_RE.test(entry[f])) {
          throw new Error(
            `seal ${where}[${i}].${f} must be a 0x-prefixed 32-byte hex string, got: ${String(entry[f])}`
          );
        }
      }
      const expectedLeaf = merkle.pathLeaf(entry.relPath, entry.contentHash);
      if (entry.leaf.toLowerCase() !== expectedLeaf.toLowerCase()) {
        throw new Error(
          `seal ${where}[${i}].leaf is inconsistent with its relPath+contentHash ` +
            `(expected ${expectedLeaf}, got ${entry.leaf})`
        );
      }
      flat.push({ relPath: entry.relPath, contentHash: entry.contentHash });
    });
  };
  checkEntries(obj.inputs, "inputs");
  obj.inputs.forEach((entry, i) => {
    if (!ANCHOR_TRUST_SEAL_INPUT_ROLES.includes(entry.role)) {
      throw new Error(
        `seal inputs[${i}].role must be one of ${JSON.stringify(ANCHOR_TRUST_SEAL_INPUT_ROLES)}, got: ` +
          `${JSON.stringify(entry.role)}`
      );
    }
    if (seenRole.has(entry.role)) {
      throw new Error(`seal has a duplicate input role: ${JSON.stringify(entry.role)}`);
    }
    seenRole.add(entry.role);
  });
  checkEntries(obj.outputs, "outputs");
  obj.outputs.forEach((entry, i) => {
    if (entry.role !== undefined && entry.role !== null) {
      throw new Error(
        `seal outputs[${i}] must not carry a role (roles partition INPUTS only), got: ` +
          `${JSON.stringify(entry.role)}`
      );
    }
  });
  const total = obj.inputs.length + obj.outputs.length;
  if (obj.fileCount !== undefined && obj.fileCount !== total) {
    throw new Error(`seal fileCount (${String(obj.fileCount)}) does not match the entry total (${total})`);
  }

  // THE LOAD-BEARING CHECK: re-derive the root from the listed leaves PLUS the verdict/role HEADER leaf.
  const headerBytes = canonical.trustSealHeaderBytes(
    obj.verdict,
    obj.inputs.map((e) => ({ role: e.role, relPath: e.relPath }))
  );
  const committed = [
    ...flat,
    { relPath: canonical.TRUST_SEAL_HEADER_RELPATH, contentHash: merkle.hashBytes(headerBytes) },
  ];
  const rederived = merkle.rootFromFlat(committed);
  if (rederived.toLowerCase() !== obj.root.toLowerCase()) {
    throw new Error(
      "seal root does not re-derive from its listed entries + verdict/role header " +
        "(the seal is internally inconsistent: a file, the verdict, or an input role was edited " +
        "without updating the root)"
    );
  }
  return obj;
}

function anchorTrustledgerDigest(artifact) {
  try {
    anchorValidateTrustSeal(artifact);
  } catch (e) {
    return anchorNo(ANCHOR_REASONS.TRUSTLEDGER_SEAL_INVALID, e && e.message ? e.message : String(e));
  }
  return anchorOk(artifact.root.toLowerCase(), KINDS.TRUST_SEAL, ANCHOR_HOW_FIXED[KINDS.TRUST_SEAL]);
}

// verifyhash.dataset-attestation / verifyhash.parcel-attestation — strict ports of the shipped
// validators (cli/dataset.js validateAttestation / cli/parcel.js validateParcelAttestation), then the
// SAME canonical bytes the producers serialize (via the verifier's own lib/canonical port — the two
// attestation shapes share the identical canonical key order), hashed with Node-core sha256. The
// closed field set is enforced FIRST, exactly as the producer core does: an unknown key would ride
// along unbound by the digest, so it is rejected rather than silently dropped.
const ANCHOR_ATTESTATION_FIELDS = Object.freeze([
  "kind",
  "schemaVersion",
  "note",
  "root",
  "fileCount",
  "manifestDigest",
  "signed",
  "signature",
]);
const ANCHOR_ATTESTATION_SCHEMA_VERSIONS = Object.freeze([1]);

function anchorValidateAttestation(obj, kind, noun) {
  if (!anchorIsPlainObject(obj)) throw new Error(`${noun} attestation must be a JSON object`);
  if (obj.kind !== kind) {
    throw new Error(
      `not a verifyhash ${noun} attestation (kind: ${JSON.stringify(obj.kind)}; expected ${JSON.stringify(kind)})`
    );
  }
  if (!ANCHOR_ATTESTATION_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new Error(
      `unsupported ${noun} attestation schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(ANCHOR_ATTESTATION_SCHEMA_VERSIONS)})`
    );
  }
  for (const f of ["root", "manifestDigest"]) {
    if (typeof obj[f] !== "string" || !merkle.HEX32_RE.test(obj[f])) {
      throw new Error(`${noun} attestation ${f} must be a 0x-prefixed 32-byte hex string, got: ${String(obj[f])}`);
    }
  }
  if (!Number.isInteger(obj.fileCount) || obj.fileCount < 1) {
    throw new Error(`${noun} attestation fileCount must be a positive integer, got: ${String(obj.fileCount)}`);
  }
  if (obj.signed !== false) {
    throw new Error(
      `${noun} attestation signed must be false (this build emits/reads only the UNSIGNED payload; ` +
        `attaching a real signature is the human-owned trust-root, P-3), got: ${String(obj.signed)}`
    );
  }
  if (obj.signature !== null) {
    throw new Error(`${noun} attestation signature must be null in the UNSIGNED payload, got: ${String(obj.signature)}`);
  }
  return obj;
}

function anchorAttestationDigest(artifact, kind, noun, reason) {
  for (const k of Object.keys(artifact)) {
    if (!ANCHOR_ATTESTATION_FIELDS.includes(k)) {
      return anchorNo(reason, `attestation has unknown field ${JSON.stringify(k)} (the canonical bytes would not bind it)`);
    }
  }
  let canonicalBytes;
  try {
    anchorValidateAttestation(artifact, kind, noun);
    // The verifier's own canonical serializer: the SAME fixed key order + trailing newline the
    // producer emits (dataset and parcel attestations share the identical canonical shape).
    canonicalBytes = canonical.serializeUnsignedDatasetAttestation(artifact);
  } catch (e) {
    return anchorNo(reason, e && e.message ? e.message : String(e));
  }
  const digest = "0x" + nodeCrypto.createHash("sha256").update(canonicalBytes, "utf8").digest("hex");
  return anchorOk(digest, kind, ANCHOR_HOW_FIXED[kind]);
}

/**
 * Extract the ONE canonical 32-byte digest a chain record binds for `artifact` — the standalone port
 * of the producer core's artifactDigest, dispatching over the SAME closed kind table. TOTAL.
 */
function anchorArtifactDigest(artifact) {
  try {
    if (!anchorIsPlainObject(artifact)) {
      return anchorNo(ANCHOR_REASONS.NOT_AN_OBJECT, "artifact must be a parsed JSON object");
    }
    const kind = artifact.kind;
    if (kind === undefined) {
      if ("size" in artifact || "root" in artifact) {
        return anchorJournalHeadDigest(artifact, false);
      }
      return anchorNo(
        ANCHOR_REASONS.UNKNOWN_KIND,
        "artifact carries no `kind` and is not a { size, root } journal tree head"
      );
    }
    if (typeof kind !== "string") {
      return anchorNo(ANCHOR_REASONS.UNKNOWN_KIND, "artifact `kind` must be a string");
    }
    switch (kind) {
      case KINDS.EVIDENCE_SEAL:
        return anchorEvidenceDigest(artifact);
      case KINDS.AGENT_PACKET:
        return anchorAgentDigest(artifact);
      case ANCHOR_JOURNAL_TREE_HEAD_KIND:
        return anchorJournalHeadDigest(artifact, true);
      case KINDS.TRUST_SEAL:
        return anchorTrustledgerDigest(artifact);
      case KINDS.DATASET_ATTESTATION:
        return anchorAttestationDigest(
          artifact,
          KINDS.DATASET_ATTESTATION,
          "dataset",
          ANCHOR_REASONS.DATASET_ATTESTATION_INVALID
        );
      case ANCHOR_PARCEL_ATTESTATION_KIND:
        return anchorAttestationDigest(
          artifact,
          ANCHOR_PARCEL_ATTESTATION_KIND,
          "parcel",
          ANCHOR_REASONS.PARCEL_ATTESTATION_INVALID
        );
      default:
        return anchorNo(
          ANCHOR_REASONS.UNKNOWN_KIND,
          `unknown artifact kind ${JSON.stringify(kind)} (the closed table: ${ANCHOR_ARTIFACT_KINDS.join(", ")})`
        );
    }
  } catch (e) {
    return anchorNo(ANCHOR_REASONS.NOT_AN_OBJECT, e && e.message ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------------------------------
// Receipt validation + the binding verdict — verbatim ports of the producer core's _validateReceipt /
// verifyAnchoredReceipt (strict form checks; every deviation a named `bad-receipt` naming the field).
// ---------------------------------------------------------------------------------------------------

const ANCHOR_CHAIN_FIELDS = Object.freeze([
  "authorBound",
  "blockNumber",
  "blockTime",
  "chainId",
  "contract",
  "contributor",
  "txHash",
]);
const ANCHOR_RECEIPT_FIELDS = Object.freeze(["artifactKind", "artifactLabel", "chain", "digest", "how", "kind", "note"]);
const ANCHOR_RECEIPT_REQUIRED = Object.freeze(["artifactKind", "chain", "digest", "how", "kind", "note"]);

function anchorBadReceipt(field, detail) {
  return { ok: false, reason: ANCHOR_REASONS.BAD_RECEIPT, field, detail };
}

function anchorCheckChain(chain) {
  if (!anchorIsPlainObject(chain)) {
    return { ok: false, field: "chain", detail: "chain must be an object of the seven recorded chain facts" };
  }
  for (const k of Object.keys(chain)) {
    if (!ANCHOR_CHAIN_FIELDS.includes(k)) {
      return { ok: false, field: `chain.${k}`, detail: `chain has unknown field: ${JSON.stringify(k)}` };
    }
  }
  for (const k of ANCHOR_CHAIN_FIELDS) {
    if (!(k in chain)) {
      return { ok: false, field: `chain.${k}`, detail: `chain is missing required field: ${JSON.stringify(k)}` };
    }
  }
  if (typeof chain.authorBound !== "boolean") {
    return { ok: false, field: "chain.authorBound", detail: "authorBound must be a boolean" };
  }
  for (const k of ["blockNumber", "blockTime"]) {
    if (!Number.isSafeInteger(chain[k]) || chain[k] < 0) {
      return { ok: false, field: `chain.${k}`, detail: `${k} must be a non-negative integer, got: ${String(chain[k])}` };
    }
  }
  if (!Number.isSafeInteger(chain.chainId) || chain.chainId < 1) {
    return { ok: false, field: "chain.chainId", detail: `chainId must be a positive integer, got: ${String(chain.chainId)}` };
  }
  for (const k of ["contract", "contributor"]) {
    if (typeof chain[k] !== "string" || !ANCHOR_ADDRESS_LC_RE.test(chain[k])) {
      return {
        ok: false,
        field: `chain.${k}`,
        detail: `${k} must be a LOWERCASE 0x-address (canonical case), got: ${String(chain[k])}`,
      };
    }
  }
  if (typeof chain.txHash !== "string" || !ANCHOR_HEX32_LC_RE.test(chain.txHash)) {
    return {
      ok: false,
      field: "chain.txHash",
      detail: `txHash must be a LOWERCASE 0x-bytes32 hex string, got: ${String(chain.txHash)}`,
    };
  }
  return { ok: true };
}

function anchorCanonicalChain(chain) {
  return {
    authorBound: chain.authorBound,
    blockNumber: chain.blockNumber,
    blockTime: chain.blockTime,
    chainId: chain.chainId,
    contract: chain.contract,
    contributor: chain.contributor,
    txHash: chain.txHash,
  };
}

function anchorValidateReceipt(receipt) {
  if (!anchorIsPlainObject(receipt)) {
    return anchorBadReceipt("receipt", "receipt must be a parsed JSON object");
  }
  for (const k of Object.keys(receipt)) {
    if (!ANCHOR_RECEIPT_FIELDS.includes(k)) {
      return anchorBadReceipt(k, `receipt has unknown field: ${JSON.stringify(k)}`);
    }
  }
  for (const k of ANCHOR_RECEIPT_REQUIRED) {
    if (!(k in receipt)) {
      return anchorBadReceipt(k, `receipt is missing required field: ${JSON.stringify(k)}`);
    }
  }
  if (receipt.kind !== ANCHORED_RECEIPT_KIND) {
    return anchorBadReceipt(
      "kind",
      `not an anchored receipt this build understands (kind: ${JSON.stringify(receipt.kind)}; expected ${JSON.stringify(ANCHORED_RECEIPT_KIND)})`
    );
  }
  if (receipt.note !== ANCHOR_TRUST_NOTE) {
    return anchorBadReceipt("note", "receipt `note` must be the standing trust note VERBATIM (the caveat must not drift)");
  }
  if (typeof receipt.digest !== "string" || !ANCHOR_HEX32_LC_RE.test(receipt.digest)) {
    return anchorBadReceipt("digest", `receipt digest must be a LOWERCASE 0x-bytes32 hex string, got: ${String(receipt.digest)}`);
  }
  if (typeof receipt.artifactKind !== "string" || !ANCHOR_ARTIFACT_KINDS.includes(receipt.artifactKind)) {
    return anchorBadReceipt(
      "artifactKind",
      `receipt artifactKind ${JSON.stringify(receipt.artifactKind)} is not in the closed table (${ANCHOR_ARTIFACT_KINDS.join(", ")})`
    );
  }
  if (!anchorHowValidFor(receipt.artifactKind, receipt.how)) {
    return anchorBadReceipt("how", `receipt \`how\` is not the documented derivation rule for ${receipt.artifactKind}`);
  }
  if (receipt.artifactLabel !== undefined) {
    const l = receipt.artifactLabel;
    if (typeof l !== "string" || l.length === 0 || l.length > 200 || ANCHOR_CONTROL_CHAR_RE.test(l)) {
      return anchorBadReceipt(
        "artifactLabel",
        "artifactLabel, when present, must be a 1..200-char string with no control characters"
      );
    }
  }
  const c = anchorCheckChain(receipt.chain);
  if (!c.ok) return anchorBadReceipt(c.field, c.detail);
  return { ok: true };
}

/**
 * Verify that `receipt` is a well-formed `vh-anchored-receipt@1` AND that it binds EXACTLY the
 * supplied `artifact` — the OFFLINE binding leg, standalone: the digest is RECOMPUTED from the
 * artifact via the closed table (never trusted from either side) and the full { kind, digest, how }
 * triple must match. NEVER consults a network; the receipt's chain facts are returned as the
 * anchorer's CLAIM. TOTAL: named rejects, no throws. Same verdicts as the producer core.
 *
 * @param {object} args { receipt, artifact } — both caller-supplied PARSED objects
 * @returns {{ ok:true, digest:string, chain:object } |
 *           { ok:false, reason:string, field?:string, detail?:string }}
 */
function verifyAnchoredReceipt(args) {
  try {
    if (!anchorIsPlainObject(args)) {
      return anchorNo(ANCHOR_REASONS.BAD_ARGS, "verifyAnchoredReceipt requires { receipt, artifact }");
    }
    const r = anchorValidateReceipt(args.receipt);
    if (!r.ok) return r;
    const d = anchorArtifactDigest(args.artifact);
    if (!d.ok) return d; // the artifact's OWN named validation reject, propagated verbatim
    const receipt = args.receipt;
    if (d.kind !== receipt.artifactKind) {
      return anchorNo(
        ANCHOR_REASONS.KIND_MISMATCH,
        `receipt anchors a ${receipt.artifactKind} but the supplied artifact is a ${d.kind}`
      );
    }
    if (d.digest !== receipt.digest) {
      return anchorNo(
        ANCHOR_REASONS.DIGEST_MISMATCH,
        `recomputed digest ${d.digest} != receipt digest ${receipt.digest} — this receipt does not bind this artifact`
      );
    }
    if (d.how !== receipt.how) {
      return anchorNo(ANCHOR_REASONS.HOW_MISMATCH, `recomputed derivation rule != receipt \`how\` (recomputed: ${d.how})`);
    }
    return { ok: true, digest: d.digest, chain: anchorCanonicalChain(receipt.chain) };
  } catch (e) {
    return anchorNo(ANCHOR_REASONS.BAD_ARGS, e && e.message ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------------------------------
// The anchored-receipt CLI leg: read + parse the two files, run the pure binding verify, render the
// stable human/JSON verdict. READ-ONLY (no receipt/temp/side-effect file is ever written); exit
// contract 0 ACCEPTED / 3 REJECTED (named) / 2 usage / 1 IO — the family's shared verify contract.
// ---------------------------------------------------------------------------------------------------

// The in-band honesty of the offline leg, stated once for both output shapes.
const ANCHOR_OFFLINE_NOTE =
  "OFFLINE binding check: the receipt binds this exact artifact, but its chain facts were NOT " +
  "re-checked (this standalone verifier opens no network). Confirm them against the chain with the " +
  "producer cli: vh verify-anchored <receipt> <sealed-file> --rpc <url> --contract <addr>.";

// ---------------------------------------------------------------------------------------------------
// CHAIN-CLASS trust guidance for the OFFLINE leg. The offline binding leg proves the receipt binds
// THIS artifact; it can NEVER (offline, by definition) confirm the digest is actually anchored on any
// chain. But it CAN classify the chain the receipt CLAIMS — and that classification is the single most
// load-bearing thing a counterparty needs to avoid this vertical's worst overclaim: mistaking a
// receipt from a worthless LOCAL DEV chain (STRATEGY.md P-2 — a local-chain anchor proves MECHANISM
// only and is worth NOTHING publicly) for a public-chain proof. Surfacing it HERE puts the check in
// the INDEPENDENT verifier a counterparty actually runs, not only in the producer's prose, and makes
// it MACHINE-GATEABLE (`chainClass` / `publiclyMeaningful` in --json — a stable, additive contract a
// future indexer/UI keys on). The id sets MIRROR the producer's cli/anchor.js KNOWN_TESTNET_CHAIN_IDS
// (test/verifier.standalone.test.js pins them against it byte-for-byte so the two sides cannot drift):
// the two generic dev chains are LOCAL-DEV, the remaining known ids are PUBLIC TESTNETS, and every
// other id is UNKNOWN (a chain — possibly a mainnet — whose weight this offline leg cannot judge).
//
// This guidance is STRICTLY ADDITIVE: it never changes the accept/reject decision (a bound receipt is
// still ACCEPTED at exit 0) and it never touches the pure `verifyAnchoredReceipt` verdict object,
// which stays a byte-faithful port of the producer core. It is presentation-layer trust context only.
const ANCHOR_LOCAL_DEV_CHAIN_IDS = Object.freeze([31337, 1337]);
const ANCHOR_PUBLIC_TESTNET_CHAIN_IDS = Object.freeze([
  80002, 80001, 11155111, 17000, 5, 11155420, 84532, 421614,
]);

// Classify the chainId a receipt CLAIMS into { chainClass, publiclyMeaningful, advisory }. TOTAL — a
// non-integer/out-of-set id falls through to the honest "unknown" bucket (never throws). `chainId`
// arrives already strict-validated (a positive safe integer) from anchorCheckChain.
function anchorClassifyChainId(chainId) {
  if (ANCHOR_LOCAL_DEV_CHAIN_IDS.includes(chainId)) {
    return {
      chainClass: "local-dev",
      publiclyMeaningful: false,
      advisory:
        `this receipt's chain (chainId ${chainId}) is a LOCAL DEV chain: the anchor proves MECHANISM ` +
        `ONLY and is worth NOTHING publicly until a human deploys the registry to a public chain ` +
        `(STRATEGY.md P-2). Do NOT treat a local-dev receipt as a public proof.`,
    };
  }
  if (ANCHOR_PUBLIC_TESTNET_CHAIN_IDS.includes(chainId)) {
    return {
      chainClass: "public-testnet",
      publiclyMeaningful: false,
      advisory:
        `this receipt's chain (chainId ${chainId}) is a PUBLIC TESTNET: an anchor there demonstrates ` +
        `the mechanism on a public chain but carries NO economic finality — treat it as a testnet ` +
        `proof, never a mainnet one.`,
    };
  }
  return {
    chainClass: "unknown",
    publiclyMeaningful: null,
    advisory:
      `this receipt's chainId ${chainId} is outside this verifier's known local/testnet set (it may ` +
      `be a mainnet): the OFFLINE leg cannot weigh the chain — re-check the anchor against that chain ` +
      `before relying on it.`,
  };
}

function anchorReadJson(label, filePath) {
  let text;
  try {
    text = fs.readFileSync(path.resolve(filePath), "utf8");
  } catch (e) {
    throw new IOError(`cannot read ${label} ${filePath}: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new IOError(`${label} ${filePath} is not valid JSON: ${e.message}`);
  }
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new IOError(`${label} ${filePath} must be a JSON object`);
  }
  return obj;
}

function runVerifyAnchoredOffline(opts, write, writeErr) {
  let receipt;
  let artifact;
  try {
    receipt = anchorReadJson("receipt", opts.artifact);
    artifact = anchorReadJson("artifact", opts.anchoredArtifact);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }

  const v = verifyAnchoredReceipt({ receipt, artifact });
  if (!v.ok) {
    if (opts.json) {
      write(
        JSON.stringify(
          { ok: false, verdict: "REJECTED", mode: "offline", reason: v.reason, field: v.field, detail: v.detail },
          null,
          2
        ) + "\n"
      );
    } else {
      writeErr(`verify-vh anchored-receipt: REJECTED (${v.reason})${v.detail ? `: ${v.detail}` : ""}\n`);
    }
    return EXIT.REJECTED;
  }

  // Classify the chain the receipt CLAIMS (additive trust context — never changes the ACCEPT verdict).
  const cls = anchorClassifyChainId(v.chain.chainId);

  if (opts.json) {
    write(
      JSON.stringify(
        {
          ok: true,
          verdict: "ACCEPTED",
          mode: "offline",
          digest: v.digest,
          artifactKind: receipt.artifactKind,
          chain: v.chain,
          chainClass: cls.chainClass,
          publiclyMeaningful: cls.publiclyMeaningful,
          chainAdvisory: cls.advisory,
          registry: null,
          note: ANCHOR_OFFLINE_NOTE,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    const c = v.chain;
    write("verify-vh anchored-receipt: ACCEPTED (offline binding check)\n");
    write(`  digest:       ${v.digest}\n`);
    write(`  kind:         ${receipt.artifactKind}\n`);
    write(
      `  chain CLAIM:  chainId ${c.chainId}, contract ${c.contract}, tx ${c.txHash}, ` +
        `block ${c.blockNumber}, blockTime ${c.blockTime}, contributor ${c.contributor}, ` +
        `authorBound ${c.authorBound}\n`
    );
    write(`  chain class:  ${cls.chainClass} (publiclyMeaningful: ${cls.publiclyMeaningful})\n`);
    // For anything not proven publicly meaningful, lead with a WARNING so a counterparty cannot skim
    // past the caveat; a local-dev receipt (the committed-fixture case) is worth NOTHING publicly.
    write(`  ${cls.publiclyMeaningful === true ? "ADVISORY" : "WARNING"}:  ${cls.advisory}\n`);
    write(
      "  NOTE: the OFFLINE binding leg only — the chain facts above are the anchorer's CLAIM, not " +
        "re-checked against any chain. Confirm them with the producer cli: " +
        "vh verify-anchored <receipt> <sealed-file> --rpc <url> --contract <addr>.\n"
    );
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// Argument parsing.
//   SINGLE-ARTIFACT (the original, byte-for-byte unchanged contract):
//     verify-vh <artifact> [--vendor <0xaddr>] [--dir <d>] [--json]
//   BATCH/MANIFEST (T-33.1 — one invocation gates EVERY release artifact, one CI exit code):
//     verify-vh <artifact> <artifact> ... [--vendor <0xaddr>] [--dir <d>] [--json]
//     verify-vh --manifest <file> [--vendor <0xaddr>] [--dir <d>] [--json]
// Batch mode is a pure SUPERSET: it engages ONLY when more than one positional <artifact> is given OR
// `--manifest <file>` is supplied. A lone positional with no --manifest takes the identical single path,
// so existing callers/tests never shift. A top-level `--vendor`/`--dir` is a DEFAULT each entry inherits
// unless the entry (a manifest line) overrides it with its own per-entry `--vendor`/`--dir`.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    artifact: undefined,
    vendor: undefined,
    dir: undefined,
    json: false,
    help: false,
    manifest: undefined,
    revocations: undefined,
    asOf: undefined,
    anchoredArtifact: undefined,
    strict: false,
    _pos: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (flag) => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${flag} requires a value`);
      return v;
    };
    switch (a) {
      case "--vendor":
        opts.vendor = need("--vendor");
        break;
      case "--dir":
        opts.dir = need("--dir");
        break;
      case "--manifest":
        opts.manifest = need("--manifest");
        break;
      case "--revocations":
        opts.revocations = need("--revocations");
        break;
      case "--anchored-artifact":
        opts.anchoredArtifact = need("--anchored-artifact");
        break;
      case "--as-of":
        opts.asOf = need("--as-of");
        break;
      case "--json":
        opts.json = true;
        break;
      case "--strict":
        // FAIL-CLOSED pinning (T-75.2): exit 0 must mean ACCEPT-AND-PINNED. An otherwise-ACCEPTED
        // verdict whose signer was NOT pinned to a --vendor becomes the distinct UNPINNED verdict
        // (exit 4), so a CI gate cannot silently accept an attacker-self-signed artifact.
        opts.strict = true;
        break;
      case "-h":
      case "--help":
      case "help":
        opts.help = true;
        break;
      default:
        if (a && a.startsWith("--")) throw new UsageError(`unknown flag: ${a}`);
        opts._pos.push(a);
    }
  }
  // batch === any path that aggregates MULTIPLE per-artifact verdicts under ONE exit code:
  // either a --manifest file, or more than one repeated positional <artifact>.
  opts.batch = opts.manifest !== undefined || opts._pos.length > 1;
  if (opts.manifest !== undefined && opts._pos.length > 0) {
    throw new UsageError(
      `--manifest <file> lists the artifacts; do not also pass positional <artifact> args (got: ${opts._pos[0]})`
    );
  }
  // Validate the OPTIONAL recipient-side trust-decision flags (--revocations / --as-of, T-51.4) SHAPE up
  // front so a malformed --as-of (or --as-of without --revocations) is a usage error (2), never a runtime
  // throw mid-verify. Mirrors `vh evidence verify-signed`'s validateAsOfFlags so the two stacks reject the
  // same inputs the same way.
  if (opts.asOf !== undefined && !opts.revocations) {
    throw new UsageError(
      "--as-of requires --revocations (it pins the instant the revocation decision is made AS OF)"
    );
  }
  if (opts.asOf !== undefined) {
    const ms = Date.parse(opts.asOf);
    if (
      typeof opts.asOf !== "string" ||
      !revocation.ISO_INSTANT_RE.test(opts.asOf) ||
      Number.isNaN(ms) ||
      new Date(ms).toISOString() !== opts.asOf
    ) {
      throw new UsageError(
        `invalid --as-of: ${opts.asOf} (expected a canonical ISO-8601 UTC instant, e.g. 2026-06-01T00:00:00.000Z)`
      );
    }
  }
  // ANCHORED-RECEIPT leg (T-70.4): `--anchored-artifact <sealed-file>` pairs ONE receipt positional
  // with ONE sealed artifact. It is a dedicated two-file binding check, so the sibling-verify flags
  // (--vendor/--dir/--revocations/--as-of) and the batch/manifest modes do not compose with it — each
  // incompatible combination is a NAMED usage error up front, never a silently-ignored flag.
  if (opts.anchoredArtifact !== undefined) {
    if (opts.manifest !== undefined) {
      throw new UsageError("--anchored-artifact verifies ONE receipt; it cannot be combined with --manifest");
    }
    for (const [flag, val] of [
      ["--vendor", opts.vendor],
      ["--dir", opts.dir],
      ["--revocations", opts.revocations],
      ["--as-of", opts.asOf],
    ]) {
      if (val !== undefined) {
        throw new UsageError(
          `${flag} does not apply to the anchored-receipt binding check (--anchored-artifact reads exactly two files: the receipt and the sealed artifact)`
        );
      }
    }
    if (opts.strict) {
      throw new UsageError(
        "--strict does not apply to the anchored-receipt binding check (it verifies a digest binding, not a signer pin)"
      );
    }
    if (opts._pos.length !== 1) {
      throw new UsageError(
        "--anchored-artifact requires exactly ONE <receipt> positional: verify-vh <receipt> --anchored-artifact <sealed-file>"
      );
    }
    opts.batch = false;
  }
  // Preserve the SINGLE-artifact contract verbatim: exactly one positional and no --manifest.
  opts.artifact = opts._pos[0];
  return opts;
}

// ---------------------------------------------------------------------------
// Manifest parsing. A manifest is a newline list OR a JSON array of artifact entries; each entry names an
// artifact path and may carry a per-entry `--vendor`/`--dir` that overrides the top-level defaults.
//
//   NEWLINE form — one entry per line, shell-style tokens. Blank lines and `#` comments are skipped:
//       releases/a.vhevidence.json
//       releases/b.vhseal --vendor 0xabc... --dir ./out
//   JSON form — an array of strings and/or objects:
//       ["a.vhevidence.json", {"artifact":"b.vhseal","vendor":"0xabc...","dir":"./out"}]
//
// Paths in the manifest resolve relative to the MANIFEST FILE's own directory (a release ships its
// manifest next to its artifacts), unless the path is given a per-entry `--dir` for its SIBLINGS — note
// `dir` localizes where an artifact's SIBLING files are read, exactly as the single-artifact `--dir` does;
// the artifact path itself resolves against the manifest dir. The manifest is parsed in-process; NO new
// crypto and NO network — it is a list, nothing more.
// ---------------------------------------------------------------------------

// Minimal whitespace tokenizer for a newline-form manifest line. No quoting support is needed (artifact
// paths and 0x addresses contain no spaces); a token is any run of non-whitespace.
function tokenizeManifestLine(line) {
  return line.split(/\s+/).filter((t) => t.length > 0);
}

function parseManifestLine(line, lineNo) {
  const toks = tokenizeManifestLine(line);
  const entry = { artifact: undefined, vendor: undefined, dir: undefined };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const need = (flag) => {
      const v = toks[++i];
      if (v === undefined) throw new UsageError(`manifest line ${lineNo}: ${flag} requires a value`);
      return v;
    };
    if (t === "--vendor") entry.vendor = need("--vendor");
    else if (t === "--dir") entry.dir = need("--dir");
    else if (t.startsWith("--")) throw new UsageError(`manifest line ${lineNo}: unknown flag: ${t}`);
    else if (entry.artifact === undefined) entry.artifact = t;
    else throw new UsageError(`manifest line ${lineNo}: unexpected extra token: ${t}`);
  }
  if (entry.artifact === undefined) {
    throw new UsageError(`manifest line ${lineNo}: no artifact path`);
  }
  return entry;
}

function parseManifest(text, manifestPath) {
  const trimmed = text.replace(/^﻿/, "").trim();
  const entries = [];
  if (trimmed.startsWith("[")) {
    // JSON array form.
    let arr;
    try {
      arr = JSON.parse(trimmed);
    } catch (e) {
      throw new IOError(`manifest ${manifestPath} is not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(arr)) throw new IOError(`manifest ${manifestPath} JSON must be an array of entries`);
    arr.forEach((raw, idx) => {
      if (typeof raw === "string") {
        entries.push({ artifact: raw, vendor: undefined, dir: undefined });
      } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        if (typeof raw.artifact !== "string" || raw.artifact.length === 0) {
          throw new IOError(`manifest ${manifestPath} entry ${idx}: "artifact" must be a non-empty string`);
        }
        entries.push({
          artifact: raw.artifact,
          vendor: raw.vendor != null ? String(raw.vendor) : undefined,
          dir: raw.dir != null ? String(raw.dir) : undefined,
        });
      } else {
        throw new IOError(`manifest ${manifestPath} entry ${idx} must be a string or { artifact, vendor?, dir? }`);
      }
    });
  } else {
    // Newline form: one entry per non-blank, non-comment line.
    const lines = trimmed.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const bare = line.trim();
      if (bare.length === 0 || bare.startsWith("#")) continue;
      entries.push(parseManifestLine(line, i + 1));
    }
  }
  if (entries.length === 0) {
    throw new UsageError(`manifest ${manifestPath} lists no artifacts`);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// THE DISK FILE SOURCE — the CLI's `readEntry` implementation, carrying the FULL path-confinement
// discipline the disk path always had (byte-identical classification):
//   (1) string-level confinement, BEFORE any filesystem access: an ABSOLUTE relPath, or any relPath with
//       a `..` path COMPONENT, is REJECTED unread;
//   (2) resolved-path confinement: a resolved path that ESCAPES baseDir (string-wise, against the
//       realpath of baseDir) is REJECTED;
//   (3) post-open symlink confinement: after opening a present file we realpath it and re-assert
//       containment, defeating a sibling that is a SYMLINK pointing out of baseDir (fs.readFileSync
//       follows symlinks regardless of the string check) — the just-read bytes are DROPPED, never hashed.
// ---------------------------------------------------------------------------

// True when a resolved absolute path escapes the (already realpath'd) base directory. A path equal to the
// base or under it does not escape; anything that path.relative()'s to "" / ".." / an absolute drive is out.
function escapesBase(baseReal, abs) {
  const rel = path.relative(baseReal, abs);
  return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
}

function makeDiskReadEntry(baseDir) {
  // Anchor confinement on the REALPATH of baseDir so a symlinked baseDir itself (e.g. /tmp -> /private/tmp
  // on macOS) does not spuriously trip the containment check on otherwise-legitimate siblings.
  let baseReal;
  try {
    baseReal = fs.realpathSync(baseDir);
  } catch (_) {
    baseReal = path.resolve(baseDir);
  }

  return function readEntry(relPath) {
    // (1) String-level confinement, BEFORE any filesystem access.
    if (
      typeof relPath !== "string" ||
      relPath.length === 0 ||
      path.isAbsolute(relPath) ||
      relPath.split(/[\\/]/).includes("..")
    ) {
      return { status: "escaped" };
    }

    // (2) Resolved-path confinement: the resolved absolute path must stay under baseReal.
    const abs = path.resolve(baseDir, relPath);
    if (escapesBase(baseReal, abs)) {
      return { status: "escaped" };
    }

    let bytes;
    try {
      bytes = fs.readFileSync(abs);
    } catch (_) {
      return { status: "missing" };
    }

    // (3) Post-open symlink confinement.
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch (_) {
      real = abs;
    }
    if (escapesBase(baseReal, real)) {
      return { status: "escaped" };
    }

    return { status: "ok", bytes };
  };
}

// The original disk-shaped helpers, kept with their exact signatures + behavior (thin wrappers over the
// engine with a disk source). `relResolver` was always accepted-and-unused on classifyFiles; retained so
// the signature does not shift.
function classifyFiles(sealedEntries, baseDir, relResolver) { // eslint-disable-line no-unused-vars
  return classifyFilesWith(sealedEntries, makeDiskReadEntry(baseDir));
}

function verifyEvidenceSeal(seal, baseDir) {
  return verifyEvidenceSealWith(seal, makeDiskReadEntry(baseDir));
}

function verifyTrustSeal(seal, baseDir) {
  return verifyTrustSealWith(seal, makeDiskReadEntry(baseDir));
}

// ---------------------------------------------------------------------------
// FAIL-CLOSED --strict (T-75.2). Under --strict, exit 0 means ACCEPT-AND-PINNED: an otherwise-
// ACCEPTED verdict whose `pinning` is not "pinned" (a signed artifact verified WITHOUT a --vendor
// pin — anyone's key passes — or an unsigned artifact with nobody vouching) becomes the DISTINCT
// verdict UNPINNED with its own exit code (EXIT.UNPINNED = 4). A REJECTED/REVOKED verdict is left
// untouched (still exit 3), and a pinned accept is untouched (still exit 0) — the pre-existing 0/3
// contract for pinned calls is preserved verbatim. The integrity fields (rootMatches, counts,
// signatureOk, …) stay on the result: the bytes DID verify; what is refused is calling that
// "provenance" without a trusted vendor pin.
// ---------------------------------------------------------------------------

function applyStrict(result, code) {
  result.strict = true;
  if (code === EXIT.OK && result.pinning !== "pinned") {
    result.accepted = false;
    result.verdict = "UNPINNED";
    result.reason = result.signed ? "unpinned_signer" : "unpinned_unsigned";
    return { result, code: EXIT.UNPINNED };
  }
  return { result, code };
}

// ---------------------------------------------------------------------------
// The DISK verify entrypoint — the original CLI contract, byte-identical: reads + JSON-parses the
// artifact, then drives the SAME pure engine with the disk file source. Returns { result, code }.
// ---------------------------------------------------------------------------

function verifyArtifact(opts) {
  if (!opts.artifact) throw new UsageError("verify-vh requires an <artifact>");

  const artifactPath = path.resolve(opts.artifact);
  let text;
  try {
    text = fs.readFileSync(artifactPath, "utf8");
  } catch (e) {
    throw new IOError(`cannot read artifact ${opts.artifact}: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new IOError(`artifact ${opts.artifact} is not valid JSON: ${e.message}`);
  }
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new IOError(`artifact ${opts.artifact} must be a JSON object`);
  }

  // A bare anchored receipt reached the sibling-verify path: point the caller at the two-file binding
  // check instead of the generic "unrecognized kind" (a receipt alone carries nothing to re-derive).
  if (obj.kind === ANCHORED_RECEIPT_KIND) {
    throw new UsageError(
      `${opts.artifact} is a ${ANCHORED_RECEIPT_KIND} anchored receipt — verify its OFFLINE binding ` +
        "leg against the sealed artifact it anchors: verify-vh <receipt> --anchored-artifact <sealed-file>"
    );
  }

  // The base directory siblings resolve against: --dir override else the artifact's own directory.
  const baseDir = opts.dir != null ? path.resolve(opts.dir) : path.dirname(artifactPath);

  const { result, code } = verifyParsedArtifact({
    artifact: opts.artifact,
    obj,
    vendor: opts.vendor,
    readEntry: makeDiskReadEntry(baseDir),
  });

  // OPTIONAL recipient-side TRUST-DECISION-AS-OF (EPIC-51 / T-51.4). Runs ONLY under --revocations — with no
  // flag the result + code are byte-identical to the pre-T-51.4 baseline (regression-pinned). A signer
  // revoked-before-as-of downgrades an otherwise-ACCEPTED artifact to REVOKED (exit 3); a later-dated
  // revocation is informational; a forged/tampered/third-party one is ignored with a warning. OFFLINE /
  // key-free on the read side; the revocations file/dir is the ONLY new I/O. This reaches the SAME downgrade
  // `vh ... verify-signed --revocations` does, byte-for-byte on identical inputs.
  if (opts.revocations) {
    let applied;
    try {
      applied = revocation.loadAndApply({
        result,
        revocationsPath: opts.revocations,
        asOf: opts.asOf,
        nowISO: opts.nowISO || new Date().toISOString(),
      });
    } catch (e) {
      // A malformed --as-of is caught at parse time; here the only failures are an unreadable path or a
      // non-JSON single revocations file — a genuine IO error (exit 1), surfaced (never a stack), never a
      // silently-skipped downgrade.
      throw new IOError(`cannot evaluate --revocations ${opts.revocations}: ${e.message}`);
    }
    // A REVOKED decision flips an otherwise-ACCEPTED verdict to REVOKED (exit 3); an already-REJECTED verdict
    // is left rejected (the trust-as-of never upgrades). The trustAsOf block + defaulted flag ride along for
    // the renderer.
    const downgraded = applied.result;
    downgraded.trustAsOfDefaulted = applied.defaulted;
    const newCode = downgraded.accepted ? EXIT.OK : EXIT.REJECTED;
    // --strict runs AFTER the revocation downgrade: a REVOKED verdict stays exit 3; an accept that
    // survived the revocation check but is unpinned still fails closed (exit 4).
    return opts.strict ? applyStrict(downgraded, newCode) : { result: downgraded, code: newCode };
  }

  return opts.strict ? applyStrict(result, code) : { result, code };
}

// ---------------------------------------------------------------------------
// BATCH / MANIFEST orchestration (T-33.1). One invocation gates EVERY artifact a release produces and
// returns ONE CI exit code. Each entry is verified READ-ONLY through the SAME `verifyArtifact` core (NO
// new crypto, NO new artifact kind, path-escape/no-network guarantees preserved per entry); the per-entry
// `--json` body is the IDENTICAL single-artifact shape, so there is no divergence to drift.
//
// AGGREGATE EXIT CONTRACT:
//   * exit 0 (OK)        — and only if — EVERY artifact verifies (each accepted).
//   * exit 3 (REJECTED)  — if ANY artifact is rejected (CHANGED/MISSING/bad_signature/wrong_issuer/…);
//                          the report names WHICH artifact failed and why.
//   * exit 2 (USAGE)     — a malformed flag / per-entry --vendor (raised before any verify runs).
//   * exit 1 (IO)        — an artifact (or the manifest itself) is unreadable / not the expected shape.
// Usage/IO are evaluated PER ENTRY and SHORT-CIRCUIT the whole run with the matching code, exactly as the
// single-artifact path does — a release gate must not "pass" while one of its artifacts could not even be
// read or parsed. The IO/USAGE code wins over a REJECTED tally (you cannot certify a batch you could not
// fully evaluate).
// ---------------------------------------------------------------------------

function buildBatchEntries(opts) {
  // Returns [{ artifact, vendor, dir }] with top-level --vendor/--dir applied as DEFAULTS each entry may
  // override. Artifact paths from a manifest resolve against the manifest file's own directory.
  if (opts.manifest !== undefined) {
    const manifestPath = path.resolve(opts.manifest);
    let text;
    try {
      text = fs.readFileSync(manifestPath, "utf8");
    } catch (e) {
      throw new IOError(`cannot read manifest ${opts.manifest}: ${e.message}`);
    }
    const manifestDir = path.dirname(manifestPath);
    return parseManifest(text, opts.manifest).map((e) => ({
      // The artifact path resolves relative to the manifest's directory (a release ships them together).
      artifact: path.resolve(manifestDir, e.artifact),
      // Per-entry --vendor/--dir override the top-level defaults; a --dir resolves against the manifest dir.
      vendor: e.vendor != null ? e.vendor : opts.vendor,
      dir: e.dir != null ? path.resolve(manifestDir, e.dir) : opts.dir,
    }));
  }
  // Repeated positional <artifact> args: each inherits the (single) top-level --vendor/--dir.
  return opts._pos.map((a) => ({ artifact: a, vendor: opts.vendor, dir: opts.dir }));
}

function verifyBatch(opts) {
  const entries = buildBatchEntries(opts);
  const results = [];
  for (const e of entries) {
    // Verify each entry through the SAME core. A USAGE/IO problem with any single entry short-circuits the
    // whole batch with that code (the gate cannot certify a release it could not fully evaluate). The
    // top-level --revocations/--as-of (T-51.4) apply to EVERY entry as a default, so one revocations
    // file/dir gates a whole release's signed artifacts under one as-of instant.
    const { result } = verifyArtifact({
      artifact: e.artifact,
      vendor: e.vendor,
      dir: e.dir,
      revocations: opts.revocations,
      asOf: opts.asOf,
      nowISO: opts.nowISO,
      // --strict (T-75.2) applies to EVERY entry: one unpinned accept fails the whole gate closed.
      strict: opts.strict,
    });
    results.push(result);
  }
  const total = results.length;
  const passed = results.filter((r) => r.accepted).length;
  const failed = total - passed;
  // The UNPINNED tally (only ever non-zero under --strict). Exit precedence: any genuine REJECT
  // dominates (3 — something is tampered/forged/wrong-issuer), else any unpinned-under-strict entry
  // makes the whole batch UNPINNED (4), else OK (0). `ok` keeps its original meaning: every entry
  // accepted (so an unpinned-under-strict batch is NOT ok).
  const unpinned = results.filter((r) => r.verdict === "UNPINNED").length;
  const ok = failed === 0;
  const aggregate = { ok, total, passed, failed, unpinned, results };
  const code = failed - unpinned > 0 ? EXIT.REJECTED : unpinned > 0 ? EXIT.UNPINNED : EXIT.OK;
  return { aggregate, code };
}

// ---------------------------------------------------------------------------
// Human + JSON rendering.
// ---------------------------------------------------------------------------

function renderHuman(r) {
  const L = [];
  L.push(TRUST_NOTE);
  L.push("");
  L.push(`# verify-vh — ${r.artifact}`);
  L.push(`kind:            ${r.kind}`);
  if (r.payloadKind !== r.kind) L.push(`embedded kind:   ${r.payloadKind}`);
  L.push(`signed:          ${r.signed ? "yes" : "no"}`);
  if (r.signed) {
    L.push(`recovered signer:${r.recoveredSigner ? " " + r.recoveredSigner : " (unrecoverable)"}`);
    L.push(`claimed signer:  ${r.claimedSigner}`);
    if (r.pinnedVendor != null) {
      L.push(`pinned --vendor: ${r.pinnedVendor}`);
      L.push(`signer matches vendor: ${r.signerMatchesVendor ? "yes" : "NO"}`);
    } else {
      // T-75.2: an unpinned signer must never read as trusted provenance. State it in plain words
      // (the same statement rides the JSON as `unpinnedNote`).
      L.push(
        `pinning:         UNPINNED (no --vendor pin) — signed by ${r.recoveredSigner || r.claimedSigner}, ` +
          "NOT pinned to a trusted vendor; anyone's key passes."
      );
      L.push("                 Pin the producer you trust: --vendor <0xaddr> (obtained out-of-band); --strict fails closed.");
    }
  } else if (r.recoveredSigner == null && r.pinnedVendor != null) {
    L.push("note: --vendor was supplied but this artifact is UNSIGNED (no signer to pin)");
  } else if (r.pinnedVendor == null) {
    L.push("pinning:         UNPINNED — unsigned artifact, no vendor pin (tamper-evidence of the bytes only, never WHO)");
  }
  if (r.sealedRoot != null) L.push(`sealed root:     ${r.sealedRoot}`);
  if (r.recomputedRoot != null) L.push(`recomputed root: ${r.recomputedRoot}`);
  if (r.rootMatches != null) L.push(`root matches:    ${r.rootMatches ? "yes" : "NO"}`);
  if (r.identityOnly) {
    L.push("(identity-only artifact: it commits to a dataset root/digest, not a re-walkable file set)");
  }
  L.push(
    `files: ${r.counts.matched} matched, ${r.counts.changed} changed, ` +
      `${r.counts.missing} missing, ${r.counts.escaped || 0} rejected, ${r.counts.unexpected} unexpected`
  );
  // AGENT-SESSION packet block (T-68.3) — present ONLY for r.agent results, so every other kind's
  // output stays byte-identical.
  if (r.agent) {
    L.push(`declared head:   { size: ${r.agent.head.size}, root: ${r.agent.head.root} }`);
    if (r.agent.counts) {
      L.push(
        `events:          ${r.agent.counts.events} (${r.agent.counts.full} full, ${r.agent.counts.redacted} redacted)`
      );
      L.push(
        `withheld seqs:   ${r.agent.withheld.length === 0 ? "(none — every payload disclosed)" : r.agent.withheld.join(", ")}`
      );
    }
  }
  // OPTIONAL recipient-side TRUST-DECISION-AS-OF block (T-51.4) — printed ONLY when --revocations was
  // supplied (r.trustAsOf is attached then). With no flag this block is absent, so the output is byte-
  // identical to the pre-T-51.4 baseline. The block reads the SAME way the producer's verify-signed does.
  if (r.trustAsOf) {
    L.push("");
    for (const line of revocation.renderTrustAsOf(r.trustAsOf, { defaulted: r.trustAsOfDefaulted })) {
      L.push(line);
    }
  }
  L.push("");
  if (r.accepted) {
    L.push("OK — the artifact verifies.");
    // T-75.2: an accept WITHOUT a vendor pin says so in the verdict itself — never only in the header.
    if (r.unpinnedNote) L.push(r.unpinnedNote);
  } else if (r.verdict === "UNPINNED") {
    // --strict fail-closed (T-75.2): the bytes verified, but no trusted vendor pin backed the accept.
    L.push(`UNPINNED (${r.reason}) — fail-closed under --strict (exit ${EXIT.UNPINNED}):`);
    if (r.signed) {
      L.push(`  signed by ${r.recoveredSigner} — NOT pinned to a trusted vendor; anyone's key passes.`);
      L.push("  The bytes verify, but WITHOUT a --vendor pin this is NOT provenance: an attacker who");
      L.push("  re-signs a tampered release with their OWN key would pass the same check.");
    } else {
      L.push("  the artifact is UNSIGNED and no vendor was pinned — tamper-evidence of the bytes only, never WHO.");
    }
    L.push("  Pin the producer you trust: re-run with --vendor <0xaddr> (obtained out-of-band).");
  } else if (r.reason === "key_revoked_as_of") {
    // The signature + bytes checked out, but the signing key was revoked AT OR BEFORE the as-of instant — a
    // distinct REVOKED verdict (exit 3), matching the producer's verify-signed downgrade.
    const g = r.trustAsOf && r.trustAsOf.governing;
    L.push("REVOKED (key_revoked_as_of):");
    if (g) {
      L.push(
        `  key_revoked_as_of: the signing key (${g.vendorAddress}) was REVOKED as of ${g.revokedAt} ` +
          `(reason: ${g.reason})${g.supersededBy ? `, superseded by ${g.supersededBy}` : ""} — at or before ` +
          `the as-of instant. The bytes + signature check out, but the key was no longer trustworthy then.`
      );
    }
  } else {
    L.push(`REJECTED (${r.reason}):`);
    for (const c of r.changed) {
      L.push(`  CHANGED    ${c.relPath}: sealed ${c.expectedContentHash} != on-disk ${c.actualContentHash}`);
    }
    for (const m of r.missing) {
      L.push(`  MISSING    ${m.relPath}: referenced but not found on disk`);
    }
    for (const x of r.escaped || []) {
      // SECURITY: print the attacker's relPath string ONLY — never a content hash of the out-of-tree target.
      L.push(`  REJECTED   ${x.relPath}: path escapes the artifact directory (refused to read; no hash computed)`);
    }
    for (const u of r.unexpected) {
      L.push(`  UNEXPECTED ${u.relPath}: on disk but not referenced`);
    }
    if (r.reason === "bad_signature") {
      L.push("  bad_signature: the signature does not recover to the claimed signer (tampered or forged).");
    }
    if (r.reason === "wrong_issuer") {
      L.push(
        `  wrong_issuer: recovered ${r.recoveredSigner} but you pinned --vendor ${r.pinnedVendor}.`
      );
    }
    if (r.reason === "unsigned_cannot_pin_vendor") {
      L.push("  --vendor was pinned but the artifact carries no signature to recover a signer from.");
    }
    if (r.reason === "root_mismatch") {
      L.push("  root_mismatch: the recomputed root does not equal the sealed root.");
    }
    if (r.reason === "path_escape") {
      L.push(
        "  path_escape: the artifact references a file OUTSIDE its own directory (absolute path, `..` " +
          "traversal, or an out-of-tree symlink). A genuine artifact never does this; refused to read it."
      );
    }
    // AGENT-SESSION packet reject details (T-68.3): name the first offending event seq + the named fault.
    if (r.agent) {
      if (r.agent.seq !== null && r.agent.seq !== undefined) {
        L.push(`  first offending event seq: ${r.agent.seq}${r.agent.reason ? ` (${r.agent.reason})` : ""}`);
      }
      if (r.reason === "event_invalid") {
        L.push(
          `  event_invalid: an event failed strict canonical validation` +
            `${r.agent.field ? ` (field: ${r.agent.field})` : ""} — the packet cannot be trusted.`
        );
      }
      if (r.reason === "counts_mismatch") {
        L.push("  counts_mismatch: the packet's declared full/redacted counts do not match a recount.");
      }
      if (r.reason === "head_not_bound") {
        L.push(
          "  head_not_bound: the headAttestation signs a DIFFERENT { size, root } than this packet's " +
            "events derive — the signature belongs to another session."
        );
      }
    }
  }
  L.push("");
  return L.join("\n");
}

// Human rendering of a batch aggregate: a per-artifact PASS/FAIL line (FAIL names the reason), then the
// one-line roll-up + the final verdict. The trust note is printed ONCE at the top.
function renderBatchHuman(agg) {
  const L = [];
  L.push(TRUST_NOTE);
  L.push("");
  L.push(`# verify-vh — BATCH (${agg.total} artifact${agg.total === 1 ? "" : "s"})`);
  for (const r of agg.results) {
    if (r.accepted) {
      // T-75.2: a pass with NO vendor pin is labelled UNPINNED right on its PASS line — a green batch
      // log must never read as "the producer signed this" when nobody pinned the producer.
      L.push(
        `  PASS  ${r.artifact}` +
          (r.pinning === "unpinned" ? "  (UNPINNED — no vendor pin; anyone's key passes)" : "")
      );
    } else if (r.verdict === "UNPINNED") {
      // --strict fail-closed: the bytes verified but no trusted vendor pin backed the accept.
      L.push(`  UNPINNED  ${r.artifact}  (${r.reason} — bytes verify, but no trusted --vendor pin; --strict fails closed)`);
    } else {
      L.push(`  FAIL  ${r.artifact}  (${r.reason})`);
      // Localize the first failing detail so a CI log names exactly what moved, per artifact.
      for (const c of r.changed) {
        L.push(`          CHANGED   ${c.relPath}: sealed ${c.expectedContentHash} != on-disk ${c.actualContentHash}`);
      }
      for (const m of r.missing) {
        L.push(`          MISSING   ${m.relPath}`);
      }
      for (const x of r.escaped || []) {
        L.push(`          REJECTED  ${x.relPath}: path escapes the artifact directory (no hash computed)`);
      }
    }
  }
  const unpinnedCount = agg.unpinned || 0; // tolerate a pre-T-75.2 aggregate shape
  L.push("");
  L.push(
    `total: ${agg.total}, passed: ${agg.passed}, failed: ${agg.failed}` +
      (unpinnedCount > 0 ? ` (${unpinnedCount} UNPINNED under --strict)` : "")
  );
  if (agg.ok) {
    L.push("OK — every artifact verifies.");
  } else if (agg.failed - unpinnedCount > 0) {
    L.push(`REJECTED — ${agg.failed} artifact(s) failed.`);
  } else {
    L.push(
      `UNPINNED — ${unpinnedCount} artifact(s) verified WITHOUT a trusted --vendor pin ` +
        `(--strict fail-closed, exit ${EXIT.UNPINNED}).`
    );
  }
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// `demo` — the ZERO-CONFIG, zero-flag, zero-key-knowledge quickstart (T-55.2).
//
// WHY THIS EXISTS
//   A cold prospect should be able to go from NOTHING to a VERIFIED packet in one command — `verify-vh demo`
//   (or `npx … demo`) — with NO flags, NO `--vendor` to paste, and NO key knowledge. The whole sales promise
//   ("don't trust us — verify it yourself, offline") is unfalsifiable until they have RUN the tool once and
//   watched it ACCEPT a genuine packet, name the signer, then REJECT a one-byte-tampered copy. `demo` IS that
//   first run: it ships a tiny, self-contained, GENUINELY-SIGNED evidence packet baked into this file, plays
//   it through the EXACT same `verifyArtifact` core every real verify uses, and prints the honest verdict.
//
// HOW IT STAYS HONEST (no special-case verify path)
//   The fixture below is a REAL `vh.evidence-seal-signed` container: a keccak Merkle seal over two referenced
//   files, signed with a FIXED, well-known TEST-ONLY key (NEVER a real key, NEVER real funds — its address is
//   the standard hardhat account #1, published precisely so no one mistakes it for a production signer). The
//   signature was produced once with the family's real EIP-191 personal-sign path; the demo RECOVERS it with
//   the SAME vendored secp256k1 recovery a real verify uses, so the signer address printed is genuinely
//   recovered from the bytes — not echoed. `demo` materializes the packet + its two files into a throwaway
//   temp dir, runs the real `verifyArtifact` twice (genuine -> ACCEPT pinned to the recovered signer; a
//   one-byte-tampered copy -> REJECT/CHANGED), then deletes the temp dir. It writes NOTHING under cwd.
// ---------------------------------------------------------------------------

// The fixed TEST-ONLY signer (hardhat account #1). Published so it can NEVER be confused with a real key.
const DEMO_SIGNER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

// The two referenced files the demo seal commits to, by relPath -> exact UTF-8 content.
const DEMO_FILES = Object.freeze({
  "model-card.md": "# Demo model card\nThis file is sealed by the verify-vh demo.\n",
  "weights.txt": "0.10 0.20 0.30\n",
});

// The GENUINELY-SIGNED evidence container. `attestation` is the EXACT bytes the signature is over (the same
// plain serialization the producer's evidence path emits for the embedded seal); the signature is a real
// 65-byte EIP-191 personal-sign over those bytes by DEMO_SIGNER. Re-derived from DEMO_FILES (a build-time
// check would re-seal the same bytes), so the root binds the real file content above.
const DEMO_CONTAINER = Object.freeze({
  kind: "vh.evidence-seal-signed",
  attestation:
    '{"kind":"vh.evidence-seal","files":[{"relPath":"model-card.md","contentHash":"0x1aeca0ad922f53e9c30186234c5d1a62ffda62a828988bdd266fa93240675db0","leaf":"0xbbb3052a7359188aed3f114e15b721cf5d707a8bdf09109d1d51ec5765b3c58c"},{"relPath":"weights.txt","contentHash":"0x7716d380e062d1daf7ca58897b55f6b58900ed4fd1eda79445956c5c3d336cdf","leaf":"0x34ce488c6fb49a32d356a2553196dc817a439c13a03ce9a2a2ff2710fcf9eea2"}],"root":"0x621a5eb924a9887f88d4b05ccdf19834cdae2f4ed2399921acc7b8a45d48da9b"}',
  signature: {
    scheme: "eip191-personal-sign",
    signer: DEMO_SIGNER,
    signature:
      "0x1aabba1530df192e87498bbf1a26f63a7e30d84d72c14bf5d08b2d872df9810b672efcf26f30ec6a38a00ffc158be53633daeff9e99f344b6c1a2e99522d61a01b",
  },
});

// The packet filename the demo materializes (shared by the throwaway-temp round-trip and the `demo <dir>`
// keepable scaffold) so the "NEXT" command the demo prints names the file it actually wrote.
const DEMO_PACKET_NAME = "demo-packet.vhevidence.json";

// ---------------------------------------------------------------------------
// The DEMO AGENT-SESSION packet (T-68.3): a small, GENUINE `vh.agent-session-packet` produced by the
// REAL `vh agent seal` + `vh agent redact` path (never re-authored by hand) — a 4-event session
// (prompt -> tool_call -> tool_result -> completion) whose tool_call payload (seq 1) is REDACTED
// behind its hash commitment, so the fixture demonstrates the load-bearing property: a redacted
// packet STILL VERIFIES (identical leaves + root). UNSIGNED — the whole agent verify surface is the
// FREE funnel leg. The standalone HTML page inlines these constants verbatim (next to DEMO_FILES /
// DEMO_CONTAINER above) for its built-in agent demo: click -> ACCEPT; tamper ONE byte of a payload in
// the page -> REJECT naming event seq DEMO_AGENT_TAMPER_SEQ. The TAMPER_FROM/TO pair is a one-byte
// substring edit that occurs EXACTLY once in the packet text (pinned by test/verifier.agent.test.js).
// ---------------------------------------------------------------------------
const DEMO_AGENT_PACKET_NAME = "demo-session.vhagent.json";
const DEMO_AGENT_PACKET_TEXT = "{\"kind\":\"vh.agent-session-packet\",\"schemaVersion\":1,\"note\":\"This agent-session packet is TAMPER-EVIDENT + OFFLINE-RECOMPUTABLE, NOT a trusted timestamp and NOT a claim the agent behaved well. Its ordered Merkle `head` {size, root} (RFC-6962-style, position-bound) commits to every event: verify RE-DERIVES each event leaf — recomputing the payload hash commitment for a FULL event, checking the carried commitment for a REDACTED one — and the root from the events you hold, and a REJECT names the first offending event seq. Redaction WITHHOLDS a payload behind its hash commitment without changing any leaf or the root: it can hide, never silently alter. Event `ts` fields are SELF-ASSERTED metadata (recorded, never verified against any clock); \\\"sealed at time T\\\" rides the human-owned signing/timestamp trust-root (STRATEGY.md P-3). Garbage-in is out of scope: the head proves the LOG is intact and append-only, not that the log faithfully records what the agent actually did. The packet is an UNTRUSTED transport container: verify never trusts the packet's own stored hashes.\",\"head\":{\"size\":4,\"root\":\"0xd455ad3f8050f1d863d65003532055326629bf92574cf8919b022222abdf66d1\"},\"counts\":{\"events\":4,\"full\":3,\"redacted\":1},\"events\":[{\"seq\":0,\"ts\":\"2026-07-01T09:00:00.000Z\",\"actor\":\"user\",\"type\":\"prompt\",\"payload\":\"Summarize the vendor contract and flag any auto-renewal clause.\",\"payloadHash\":\"0x1e2d99e683d2623c77a82721f633f27206cd8051be8c848509f63bb570bd5be4\"},{\"seq\":1,\"ts\":\"2026-07-01T09:00:01.000Z\",\"actor\":\"agent:assistant\",\"type\":\"tool_call\",\"payloadHash\":\"0x32133a5998ab97eaef8850a7a47cec6e1056b964a050e6e5561f97ec22b24498\",\"redacted\":true,\"meta\":{\"tool\":\"contract_search\"}},{\"seq\":2,\"ts\":\"2026-07-01T09:00:02.000Z\",\"actor\":\"tool:contract_search\",\"type\":\"tool_result\",\"payload\":\"Section 12.3: renews automatically for successive 12-month terms unless cancelled 60 days prior.\",\"payloadHash\":\"0x57bed64393fb6ed461a5b00143cc239cf705e4a1ea5d0ee84a8f5f7ecc85bdc1\"},{\"seq\":3,\"ts\":\"2026-07-01T09:00:03.000Z\",\"actor\":\"agent:assistant\",\"type\":\"completion\",\"payload\":\"Flagged: Section 12.3 auto-renews for successive 12-month terms and requires 60 days cancellation notice.\",\"payloadHash\":\"0x43649f64cb62093be040484c6858b80f0973e6aa2bd9bc4df75c0c725dcd5bb4\"}],\"leaves\":[\"0x5a3354160c02d09a5b653227ebd35d8f0a1ade1284e402049b91c4f8acd873e3\",\"0x57ac83bf53104a1d952cf9d00e904f15e31d4cc17bc6ff0aedacd1b6ca40904a\",\"0xb3ee61a8dc496b92e05db48b990edee212bda46ca29e5480efb056a5c2cf817f\",\"0x1000b07e45f6151bcf49be6266358cec551a690654f22dc5dae279e7d6bfb7d1\"]}\n";
const DEMO_AGENT_TAMPER_SEQ = 0;
const DEMO_AGENT_TAMPER_FROM = "\"payload\":\"Summarize the vendor contract";
const DEMO_AGENT_TAMPER_TO = "\"payload\":\"SUMMARIZE the vendor contract";

// Materialize the demo packet + its referenced files into `dir`. Returns the packet path.
function writeDemoFixture(dir) {
  for (const [rel, content] of Object.entries(DEMO_FILES)) {
    fs.writeFileSync(path.join(dir, rel), content);
  }
  const packetPath = path.join(dir, DEMO_PACKET_NAME);
  fs.writeFileSync(packetPath, JSON.stringify(DEMO_CONTAINER, null, 2));
  return packetPath;
}

// ---------------------------------------------------------------------------
// T-74.1 — CHANNEL-AWARE self-naming for every copy-paste command the demo prints. The demo's whole job
// is to hand the user next-step commands that run VERBATIM in their shell; a wrong command name at that
// moment is a crash at the point of highest intent. Three channels, decided from process.argv[1]:
//   * bin      — the user reached us through the npm bin shim: `npx --yes verify-vh …` (npx cache), a
//                global install (`/usr/local/bin/verify-vh`), or any installed copy under a node_modules
//                tree. There is NO verify-vh.js file in their cwd, so a printed `node verify-vh…` line
//                would crash for them; the re-runnable form is `npx --yes verify-vh <args>` (which also
//                resolves a global/local install without a network fetch).
//   * file     — the user ran one of our script files directly (`node verify-vh.js …`,
//                `node verify-vh-standalone.js …`): name the EXACT basename they invoked.
//   * fallback — argv[1] is not ours (an in-process test harness): the canonical `node verify-vh.js`,
//                which keeps in-process output deterministic.
// The output stays a pure function of the invocation channel (no absolute paths, no randomness), so the
// bare-demo byte-determinism invariant still holds per channel; the invariant test canonicalizes the
// self-name across channels before its byte compare.
// ---------------------------------------------------------------------------
function selfCommand() {
  const argv1 = String(process.argv[1] || "");
  const base = path.basename(argv1);
  // Not one of OUR entrypoints (an in-process test harness, a foreign runner — e.g. mocha's own cli.js):
  // fall back to the canonical name, which keeps in-process output deterministic.
  if (!/^verify-vh(\.js|-\S*\.js)?$/.test(base)) return "node verify-vh.js";
  // Ours. The extension-less bin shim (`verify-vh` — npx cache, global install, node_modules/.bin), or
  // ANY installed copy under a node_modules/_npx tree, re-runs portably as `npx --yes verify-vh`.
  const segments = argv1.split(/[\\/]+/);
  if (base === "verify-vh" || segments.includes("node_modules") || segments.includes("_npx")) {
    return "npx --yes verify-vh";
  }
  // A script file the user ran directly: name the EXACT file they invoked.
  return `node ${base}`;
}

// Run the zero-config demo: seal -> ACCEPT (pinned to the recovered signer) -> tamper -> REJECT. Uses the
// REAL verifyArtifact core for BOTH runs (no bespoke verify path), so the verdicts are exactly what a real
// counterparty would see. Returns the EXIT-contract code (0 only when the whole demo behaved as designed).
function runDemo(write, writeErr) {
  // A throwaway temp dir so the demo needs no input and writes NOTHING under cwd. Cleaned in finally.
  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-vh-demo-"));
  } catch (e) {
    writeErr(`error: demo could not create a temp working dir: ${e.message}\n`);
    return EXIT.IO;
  }
  try {
    const packetPath = writeDemoFixture(tmp);

    const L = [];
    L.push(TRUST_NOTE);
    L.push("");
    L.push("# verify-vh demo — a self-contained, GENUINELY-SIGNED packet, verified OFFLINE with zero config.");
    L.push("# (No flags, no key to paste: the demo ships a real signed seal + its files and checks them for you.)");
    L.push(`# Working dir (throwaway, deleted on exit): ${tmp}`);
    L.push("");

    // (1) GENUINE packet: recover the signer first, then PIN it (so the demo proves both recovery AND the
    //     vendor-pin path) — exactly what a real counterparty does once they learn the producer's address.
    const recovered = tryRecover(DEMO_CONTAINER.attestation, DEMO_CONTAINER.signature.signature);
    if (recovered !== DEMO_SIGNER) {
      writeErr(
        `error: demo fixture is corrupt — embedded signature recovered ${String(recovered)} != ${DEMO_SIGNER}\n`
      );
      return EXIT.IO;
    }
    L.push("STEP 1 — verify the genuine packet (signer recovered from the bytes, then pinned):");
    const good = verifyArtifact({ artifact: packetPath, vendor: recovered, dir: tmp });
    if (!good.result.accepted || good.code !== EXIT.OK) {
      // Should never happen for the shipped fixture; treat as an internal fault, not a silent pass.
      writeErr(`error: demo genuine packet did NOT verify (reason: ${good.result.reason})\n`);
      write(renderHuman(good.result));
      return EXIT.IO;
    }
    L.push(`  ACCEPT — the artifact verifies. signer: ${good.result.recoveredSigner}`);
    L.push(`  sealed root:     ${good.result.sealedRoot}`);
    L.push(`  recomputed root: ${good.result.recomputedRoot}  (re-derived from the bytes on disk)`);
    L.push(`  files: ${good.result.counts.matched} matched, 0 changed, 0 missing.`);
    L.push("");

    // (2) TAMPER one byte of a referenced file, re-verify the SAME packet -> a clean REJECT naming the file.
    const victim = path.join(tmp, "model-card.md");
    fs.writeFileSync(victim, DEMO_FILES["model-card.md"] + "X"); // one extra byte
    L.push("STEP 2 — tamper ONE byte of a referenced file, then re-verify the SAME packet:");
    const bad = verifyArtifact({ artifact: packetPath, vendor: recovered, dir: tmp });
    if (bad.result.accepted || bad.code !== EXIT.REJECTED) {
      writeErr(`error: demo tampered packet was NOT rejected (reason: ${bad.result.reason})\n`);
      return EXIT.IO;
    }
    L.push(`  REJECT (${bad.result.reason}) — the tampered copy is caught:`);
    for (const c of bad.result.changed) {
      L.push(`    CHANGED  ${c.relPath}: sealed ${c.expectedContentHash} != on-disk ${c.actualContentHash}`);
    }
    L.push("");

    L.push("That is the whole promise: a genuine packet is ACCEPTED and its signer named, while a one-byte");
    L.push("change is REJECTED — re-derived from the bytes you hold, offline, with no producer stack.");
    L.push("");
    // The bare demo is a closed loop in a temp dir — gone the instant it exits. Hand the user the ONE command
    // that turns "I watched a demo" into "I have a real packet on disk I can poke at": `demo <dir>` writes the
    // same genuine packet somewhere they KEEP, with copy-paste verify/tamper/restore commands. That is the
    // working on-ramp from the canned proof to verifying their OWN bytes (where the paid `--sign` pull begins).
    // T-74.1: the command is named CHANNEL-AWARE via selfCommand() — an npx/global-bin user is told
    // `npx --yes verify-vh …` (a printed `node verify-vh…` would crash for them: they hold no such file), a
    // script-file user is told `node <the exact file they ran>`. The output remains deterministic PER
    // CHANNEL (a pure function of the channel, nothing else); the byte-determinism invariant test
    // canonicalizes the self-name before comparing the in-tree and standalone runs.
    const cmd = selfCommand();
    L.push("TRY IT YOURSELF: keep a copy you can tamper with by hand —");
    L.push(`  ${cmd} demo ./vh-demo`);
    L.push("  # writes the same signed packet + files into ./vh-demo, then prints");
    L.push("  # the exact verify / tamper / restore commands.");
    L.push("");
    L.push("NEXT: run it on a REAL packet you were handed:");
    L.push(`  ${cmd} <packet> --vendor 0xPRODUCER_ADDRESS   # exit 0 = verifies; 3 = REJECTED`);
    L.push("");
    write(L.join("\n"));
    return EXIT.OK;
  } catch (e) {
    writeErr(`error: demo failed unexpectedly: ${e.message}\n`);
    return EXIT.IO;
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {
      /* best-effort cleanup; the OS reaps temp dirs anyway */
    }
  }
}

// ---------------------------------------------------------------------------
// `demo <dir>` — the KEEPABLE scaffold (T-55.2 rework). The bare `demo` proves the round-trip in a throwaway
// temp dir and is GONE the instant it exits — a closed loop the prospect can WATCH but cannot TOUCH. That is
// the funnel dead-end the review panel flagged: the demo's own "NEXT: run it on a REAL packet" is unactionable
// because a brand-new user HAS no packet yet. `demo <dir>` closes that gap: it MATERIALIZES the same genuine
// signed packet + its two referenced files into a directory the user names and KEEPS, then prints the exact,
// copy-pasteable REAL commands to (a) verify it with the real (non-canned) verify path, (b) tamper one byte
// and watch the real REJECT, and (c) restore and re-ACCEPT. The prospect's FIRST hands-on artifact is now one
// they hold on disk and can poke at with the production code path — the working on-ramp from "watched a demo"
// to "verified my own bytes", which is where the free→paid pull (sign YOUR OWN files: `vh evidence seal
// --sign` / the `evidence_unlimited` upgrade) actually begins.
//
// It is a PURE SUPERSET of the flagless quickstart: it engages ONLY when a single <dir> token follows `demo`
// (`verify-vh demo` with no token stays the byte-identical throwaway round-trip above). It WRITES — by design,
// into the dir the user explicitly named — so it is never reached by the bare flagless path the "writes
// nothing under cwd" contract pins. The packet it writes is byte-identical to the round-trip's, signed by the
// same fixed TEST-ONLY key (hardhat #1 — never a real key / real funds).
// ---------------------------------------------------------------------------

function runDemoEmit(targetDir, write, writeErr) {
  // Confirm the shipped fixture is internally sound BEFORE writing anything (recover the signer from the
  // embedded bytes, exactly as a real verify does) — a corrupt fixture is an internal fault, not a scaffold.
  const recovered = tryRecover(DEMO_CONTAINER.attestation, DEMO_CONTAINER.signature.signature);
  if (recovered !== DEMO_SIGNER) {
    writeErr(
      `error: demo fixture is corrupt — embedded signature recovered ${String(recovered)} != ${DEMO_SIGNER}\n`
    );
    return EXIT.IO;
  }

  const dir = path.resolve(targetDir);
  // mkdir -p the target. We create the user-named dir if absent; an existing dir is fine (we only add files).
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    writeErr(`error: demo could not create ${targetDir}: ${e.message}\n`);
    return EXIT.IO;
  }

  let packetPath;
  try {
    packetPath = writeDemoFixture(dir);
  } catch (e) {
    writeErr(`error: demo could not write the scaffold into ${targetDir}: ${e.message}\n`);
    return EXIT.IO;
  }

  // Verify the just-written packet through the REAL core (no canned path), so the scaffold is proven good on
  // disk before we tell the user to trust it — and so the ACCEPT line the user will reproduce is the truth.
  const good = verifyArtifact({ artifact: packetPath, vendor: recovered, dir });
  if (!good.result.accepted || good.code !== EXIT.OK) {
    writeErr(`error: demo scaffold did NOT verify after writing (reason: ${good.result.reason})\n`);
    return EXIT.IO;
  }

  // T-74.1: name the command EXACTLY as this user can re-run it, channel-aware. A bin-style invocation
  // (npx cache / global install / any node_modules copy) is told `npx --yes verify-vh`; a direct script
  // run is told `node <the exact basename they invoked>` (verify-vh.js in-tree, verify-vh-standalone.js as
  // the bundle); an in-process harness falls back to the canonical `node verify-vh.js`. NEVER
  // `node verify-vh` — the bin user holds no such file, so that line would crash at peak intent.
  const cmd = selfCommand();
  // Print a path that is copy-pasteable from the user's CURRENT shell: the relative path when the target sits
  // at/under cwd (the common `demo ./vh-demo` case -> a tidy `vh-demo/...`), else the absolute path (a `../../`
  // chain to a far-off dir is unreadable and brittle — the absolute path always resolves).
  const rel = (p) => {
    const r = path.relative(process.cwd(), p);
    return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : p;
  };
  const pkt = rel(packetPath);
  const card = rel(path.join(dir, "model-card.md"));

  const L = [];
  L.push(TRUST_NOTE);
  L.push("");
  L.push(`# verify-vh demo — wrote a real, KEEPABLE signed packet you can verify yourself, hands-on.`);
  L.push(`# Signed by a fixed TEST-ONLY key (hardhat #1 — never a real key / real funds).`);
  L.push("");
  L.push(`Wrote into ${dir}:`);
  L.push(`  ${DEMO_PACKET_NAME}   (a genuinely-signed evidence packet)`);
  for (const r of Object.keys(DEMO_FILES)) L.push(`  ${r}`);
  L.push(`  signer (recovered from the bytes): ${recovered}`);
  L.push("");
  L.push("It already VERIFIES — run it yourself (the real verify path, no canned demo):");
  L.push(`  ${cmd} ${pkt} --vendor ${recovered}`);
  L.push("  # exit 0 = ACCEPT (root re-derived from YOUR bytes on disk; signer pinned).");
  L.push("");
  L.push("Now PROVE tamper-evidence with your own hands — change one byte, then re-verify:");
  L.push(`  printf 'X' >> ${card}`);
  L.push(`  ${cmd} ${pkt} --vendor ${recovered}   # exit 3 = REJECT (CHANGED ${path.basename(card)})`);
  L.push("");
  // A REAL, copy-pasteable restore command (T-74.1): rewrite the file's exact original bytes straight from
  // the shipped fixture (single source of truth — DEMO_FILES; its content is single-quote/percent/backslash-
  // free, so the printf line below reproduces it byte-for-byte), so the whole ACCEPT -> REJECT -> ACCEPT
  // loop runs verbatim from this transcript.
  L.push("Restore the original bytes and watch it ACCEPT again (the change was the ONLY reason it rejected):");
  L.push(`  printf '${DEMO_FILES["model-card.md"].replace(/\n/g, "\\n")}' > ${card}`);
  L.push(`  ${cmd} ${pkt} --vendor ${recovered}   # exit 0 again — the restored bytes verify`);
  L.push("");
  L.push("NEXT — verify a packet someone handed YOU (same command, their address):");
  L.push(`  ${cmd} <their-packet> --vendor 0xTHEIR_ADDRESS`);
  L.push("");
  L.push("Want to SIGN your OWN files so a counterparty can pin YOU? That is the paid producer side:");
  L.push("  vh evidence seal <your-folder> --sign        (an EIP-191 signer-pin; the `evidence_unlimited`");
  L.push("                                                upgrade lifts the free 25-file cap)");
  L.push("  How-to (§0a of the verifier README): https://verifyhash.com/docs/verifier-README.md");
  L.push("");
  write(L.join("\n"));
  return EXIT.OK;
}

function usage() {
  return [
    "verify-vh — standalone, read-only, OFFLINE verifier for verifyhash artifacts",
    "",
    "Usage:",
    "  verify-vh demo                                                                                   (zero-config quickstart)",
    "  verify-vh demo <dir>                                                                              (write a keepable signed packet you can verify yourself)",
    "  verify-vh <artifact> [--vendor <0xaddr>] [--strict] [--dir <d>] [--revocations <file-or-dir> [--as-of <ISO>]] [--json]",
    "  verify-vh <artifact> <artifact> ... [--vendor <0xaddr>] [--strict] [--dir <d>] [--revocations <file-or-dir>] [--json]   (batch)",
    "  verify-vh --manifest <file> [--vendor <0xaddr>] [--strict] [--dir <d>] [--revocations <file-or-dir>] [--json]           (batch)",
    "  verify-vh <receipt> --anchored-artifact <sealed-file> [--json]                    (anchored-receipt binding check)",
    "",
    "DEMO: `verify-vh demo` runs a self-contained, genuinely-signed packet through the real verify path —",
    "NO flags, NO key, NO install state: it ACCEPTs the packet (naming the signer), then REJECTs a one-byte-",
    "tampered copy. The single command that takes a brand-new user from nothing to a verified packet.",
    "`verify-vh demo <dir>` goes one step further: it WRITES that same genuine signed packet + its files into",
    "<dir> (which you keep) and prints copy-paste commands so you verify, tamper, and re-verify it by hand.",
    "",
    "Auto-detects the artifact kind (evidence seal, reconciliation seal, dataset attestation, proof",
    "bundle — bare or signed — or an agent-session packet *.vhagent.json), RE-DERIVES the keccak root",
    "from the referenced bytes (siblings resolve next to the artifact, or under --dir <d>), recovers",
    "the signer of a signed artifact, and PINS it to --vendor <0xaddr> (or reports the recovered signer",
    "when no pin is given). An agent-session packet is SELF-CONTAINED: every event leaf + the ordered",
    "RFC-6962-style head are re-derived from the events in the packet (REDACTED payloads are checked by",
    "their hash commitments), and a REJECT names the first offending event seq.",
    "",
    "PINNING / --strict (fail-closed): WITHOUT --vendor, a signed artifact is accepted on its OWN",
    "self-asserted key — the verdict says so explicitly (\"UNPINNED … NOT pinned to a trusted vendor;",
    "anyone's key passes\") because an attacker who re-signs a tampered release with their OWN key",
    "passes a vendor-less check. --strict makes that fail-closed: exit 0 then means ACCEPT-AND-PINNED,",
    "and an otherwise-accepted artifact with no satisfied --vendor pin exits 4 (verdict UNPINNED) —",
    "distinct from 3 (REJECTED: tampered/forged/wrong-issuer). CI gates should pin AND pass --strict",
    "(the shipped verifier/ci/ recipes do).",
    "",
    "REVOCATIONS: --revocations <file-or-dir> [--as-of <ISO>] downgrades an otherwise-ACCEPTED signed",
    "artifact to REVOKED (exit 3) when its signing key was REVOKED at or before --as-of (default now). The",
    "file may be one signed revocation or a JSON array; a directory is read as a flat pool of revocation",
    "files. A revocation dated AFTER --as-of stays ACCEPTED with a later-revoked note; a forged/tampered/",
    "third-party revocation is IGNORED with a warning. This reaches the SAME downgrade the producer's",
    "`vh ... verify-signed --revocations` does, OFFLINE — no producer stack, no network, no key.",
    "",
    "ANCHORED RECEIPTS (T-70.4): a `vh-anchored-receipt@1` produced by `vh anchor-artifact` verifies",
    "here WITHOUT the producer stack: --anchored-artifact <sealed-file> re-derives the sealed artifact's",
    "digest through the SAME closed kind table (evidence seal, agent-session packet, journal tree head,",
    "TrustLedger seal, dataset/parcel attestation), validates the receipt strictly (a drifted trust note",
    "is a named bad-receipt), and confirms the receipt binds EXACTLY those bytes — ACCEPTED exit 0, or",
    "the specific named reject (digest-mismatch / kind-mismatch / how-mismatch / bad-receipt / the",
    "artifact's own named reject) exit 3. OFFLINE binding leg ONLY: the receipt's `chain` facts remain",
    "the anchorer's CLAIM — re-check them on chain with the producer cli (`vh verify-anchored --rpc`).",
    "",
    "BATCH/MANIFEST: pass several <artifact> args, or --manifest <file> (a newline list or JSON array of",
    "artifact paths, each line/object may carry its own --vendor/--dir). ALL must pass for exit 0; if ANY",
    "is rejected, exit is 3 and the report names which artifact failed and why. --json emits a stable",
    "aggregate { ok, total, passed, failed, results:[...] } whose entries are the single-artifact shape.",
    "Top-level --vendor/--dir are inherited as defaults a manifest entry may override; --revocations/--as-of",
    "apply to every entry.",
    "",
    "READ-ONLY: holds no key, writes nothing.",
    "Exit: 0 ok (ACCEPT — and pinned, under --strict) / 3 rejected|revoked / 4 UNPINNED (--strict only:",
    "the bytes verify but no trusted --vendor pin backed the accept) / 2 usage / 1 IO.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// run(argv, io) — the testable entrypoint. Returns the EXIT-contract integer. Injectable stdout/stderr.
// ---------------------------------------------------------------------------

function run(argv, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }
  if (opts.help) {
    write(usage());
    return EXIT.OK;
  }
  // DEMO: the zero-config quickstart (T-55.2). `verify-vh demo` — a SINGLE bare positional `demo`, with NO
  // other args at all (no flags, no second positional, no manifest) — runs the self-contained signed packet
  // through the real verify path. We require the LONE argument to be exactly `demo` so the quickstart contract
  // is unambiguous: `demo` with any extra token falls through to the normal path (where it is a clean error),
  // never a silently-flag-ignoring run. It is a pure SUPERSET of the existing contract: `demo` was never a
  // valid artifact path before (there is no file named `demo`, so a lone `demo` was a clean IO error), so
  // intercepting it here shifts no existing caller.
  if (argv.length === 1 && opts.artifact === "demo") {
    return runDemo(write, writeErr);
  }
  // DEMO SCAFFOLD: `verify-vh demo <dir>` — a pure SUPERSET (T-55.2 rework). When `demo` is followed by exactly
  // ONE more bare token (a target directory) and NO flags, write the same genuine signed packet + its files
  // into that dir the user KEEPS, and print copy-paste verify/tamper/restore commands. This is the actionable
  // on-ramp the bare demo (a throwaway temp dir, gone on exit) cannot give. We require EXACTLY two bare
  // positionals and no flags so the contract stays unambiguous; `demo <dir> --anything` falls through to the
  // normal path (where a file literally named `demo` is a clean IO error, byte-identically to before).
  if (
    argv.length === 2 &&
    argv[0] === "demo" &&
    opts._pos.length === 2 &&
    opts._pos[0] === "demo" &&
    !opts.json &&
    opts.manifest === undefined &&
    opts.vendor === undefined &&
    opts.dir === undefined
  ) {
    return runDemoEmit(opts._pos[1], write, writeErr);
  }
  // No artifact AND no manifest → the same usage error as before (the batch additions are a pure superset).
  if (opts.artifact === undefined && opts.manifest === undefined) {
    writeErr("error: verify-vh requires an <artifact>\n\n");
    writeErr(usage());
    return EXIT.USAGE;
  }

  // ANCHORED-RECEIPT binding check (T-70.4): a dedicated two-file leg — parseArgs already guaranteed
  // exactly one <receipt> positional and no incompatible flag. READ-ONLY; exit 0/3/2/1 as everywhere.
  if (opts.anchoredArtifact !== undefined) {
    return runVerifyAnchoredOffline(opts, write, writeErr);
  }

  // The recipient's current decision instant (the default --as-of). Injectable via io.nowISO so a test can
  // pin the clock; otherwise the wall clock. Threaded onto opts for the (optional) revocation evaluation.
  opts.nowISO = io.nowISO || new Date().toISOString();

  // BATCH path: a --manifest file or more than one positional <artifact>. Aggregates per-artifact verdicts
  // under one CI exit code. The single-artifact path below is byte-for-byte the original behavior.
  if (opts.batch) {
    let out;
    try {
      out = verifyBatch(opts);
    } catch (e) {
      if (e instanceof UsageError) {
        writeErr(`error: ${e.message}\n`);
        return EXIT.USAGE;
      }
      if (e instanceof IOError) {
        writeErr(`error: ${e.message}\n`);
        return EXIT.IO;
      }
      writeErr(`error: ${e.message}\n`);
      return EXIT.IO;
    }
    if (opts.json) {
      write(JSON.stringify(out.aggregate, null, 2) + "\n");
    } else {
      write(renderBatchHuman(out.aggregate));
    }
    return out.code;
  }

  let out;
  try {
    out = verifyArtifact(opts);
  } catch (e) {
    if (e instanceof UsageError) {
      writeErr(`error: ${e.message}\n`);
      return EXIT.USAGE;
    }
    if (e instanceof IOError) {
      writeErr(`error: ${e.message}\n`);
      return EXIT.IO;
    }
    // Any other error is an unexpected internal fault — surface it as an IO error (never a stack to a
    // counterparty), exit 1.
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }

  if (opts.json) {
    write(JSON.stringify(out.result, null, 2) + "\n");
  } else {
    write(renderHuman(out.result));
  }
  return out.code;
}

// CLI shim: only run when invoked directly (so the module is importable in tests without side effects).
if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = {
  EXIT,
  KINDS,
  TRUST_NOTE,
  UsageError,
  IOError,
  parseArgs,
  parseManifest,
  verifyArtifact,
  applyStrict,
  verifyArtifactFromBytes,
  verifyBatch,
  buildBatchEntries,
  renderBatchHuman,
  verifyEvidenceSeal,
  verifyTrustSeal,
  verifyDatasetAttestation,
  verifyProofBundle,
  verifyAgentSeal,
  AGENT_TRUST_NOTE,
  // ANCHORED-RECEIPT surface (T-70.4) — wire-format constants + the pure binding verify, exported so
  // the parity test can pin them against the producer core (cli/core/anchor-binding.js) byte-for-byte.
  ANCHORED_RECEIPT_KIND,
  ANCHOR_TRUST_NOTE,
  ANCHOR_REASONS,
  ANCHOR_ARTIFACT_KINDS,
  ANCHOR_JOURNAL_TREE_HEAD_KIND,
  ANCHOR_JOURNAL_EMPTY_ROOT,
  ANCHOR_LOCAL_DEV_CHAIN_IDS,
  ANCHOR_PUBLIC_TESTNET_CHAIN_IDS,
  anchorClassifyChainId,
  anchorArtifactDigest,
  verifyAnchoredReceipt,
  runVerifyAnchoredOffline,
  renderHuman,
  revocation,
  usage,
  run,
  runDemo,
  runDemoEmit,
  DEMO_SIGNER,
  DEMO_FILES,
  DEMO_CONTAINER,
  DEMO_PACKET_NAME,
  DEMO_AGENT_PACKET_NAME,
  DEMO_AGENT_PACKET_TEXT,
  DEMO_AGENT_TAMPER_SEQ,
  DEMO_AGENT_TAMPER_FROM,
  DEMO_AGENT_TAMPER_TO,
  MAX_RELPATH_CHARS,
};

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
//   0 ok / 3 rejected / 2 usage / 1 IO. Stable; a future CI/indexer keys on these.
const EXIT = Object.freeze({ OK: 0, IO: 1, USAGE: 2, REJECTED: 3 });

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
      case "--as-of":
        opts.asOf = need("--as-of");
        break;
      case "--json":
        opts.json = true;
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
    return { result: downgraded, code: newCode };
  }

  return { result, code };
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
    });
    results.push(result);
  }
  const total = results.length;
  const passed = results.filter((r) => r.accepted).length;
  const failed = total - passed;
  const ok = failed === 0;
  const aggregate = { ok, total, passed, failed, results };
  return { aggregate, code: ok ? EXIT.OK : EXIT.REJECTED };
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
      L.push("(no --vendor pin: the recovered signer above is reported, not pinned)");
    }
  } else if (r.recoveredSigner == null && r.pinnedVendor != null) {
    L.push("note: --vendor was supplied but this artifact is UNSIGNED (no signer to pin)");
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
      L.push(`  PASS  ${r.artifact}`);
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
  L.push("");
  L.push(`total: ${agg.total}, passed: ${agg.passed}, failed: ${agg.failed}`);
  L.push(agg.ok ? "OK — every artifact verifies." : `REJECTED — ${agg.failed} artifact(s) failed.`);
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

// Materialize the demo packet + its referenced files into `dir`. Returns the packet path.
function writeDemoFixture(dir) {
  for (const [rel, content] of Object.entries(DEMO_FILES)) {
    fs.writeFileSync(path.join(dir, rel), content);
  }
  const packetPath = path.join(dir, DEMO_PACKET_NAME);
  fs.writeFileSync(packetPath, JSON.stringify(DEMO_CONTAINER, null, 2));
  return packetPath;
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
    // NOTE: we name the command literally (NOT process.argv[1]) so the bare-demo output is byte-identical
    // whether run in-process, as `node verify-vh.js`, or from the standalone bundle — the demo's own
    // determinism is a tested invariant (the standalone must byte-match the in-tree demo).
    L.push("TRY IT YOURSELF: keep a copy you can tamper with by hand —");
    L.push("  node verify-vh.js demo ./vh-demo     # writes the same signed packet + files into ./vh-demo,");
    L.push("                                       # then prints the exact verify / tamper / restore commands.");
    L.push("");
    L.push("NEXT: run it on a REAL packet you were handed:");
    L.push("  node verify-vh.js <packet> --vendor 0xPRODUCER_ADDRESS   (exit 0 = verifies; 3 = REJECTED)");
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

  // The command name as the user invoked us (verify-vh.js in-tree, verify-vh-standalone.js as the bundle), so
  // the copy-paste commands below name the EXACT file they ran — not a guessed path.
  // Name the command the user actually ran (verify-vh.js in-tree, verify-vh-standalone.js as the bundle) so the
  // copy-paste lines below name the EXACT file they invoked. If argv[1] is not one of our scripts (e.g. running
  // in-process under a test harness), fall back to the canonical name rather than printing the harness binary.
  const argv1 = path.basename(process.argv[1] || "");
  const self = /verify-vh/.test(argv1) ? argv1 : "verify-vh.js";
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
  L.push(`  node ${self} ${pkt} --vendor ${recovered}`);
  L.push("  # exit 0 = ACCEPT (root re-derived from YOUR bytes on disk; signer pinned).");
  L.push("");
  L.push("Now PROVE tamper-evidence with your own hands — change one byte, then re-verify:");
  L.push(`  printf 'X' >> ${card}`);
  L.push(`  node ${self} ${pkt} --vendor ${recovered}   # exit 3 = REJECT (CHANGED ${path.basename(card)})`);
  L.push("");
  L.push("Restore it and watch it ACCEPT again (the change was the ONLY reason it rejected):");
  L.push(`  node ${self} ${pkt} --vendor ${recovered}   # after restoring the byte`);
  L.push("");
  L.push("NEXT — verify a packet someone handed YOU (same command, their address):");
  L.push(`  node ${self} <their-packet> --vendor 0xTHEIR_ADDRESS`);
  L.push("");
  L.push("Want to SIGN your OWN files so a counterparty can pin YOU? That is the paid producer side:");
  L.push("  vh evidence seal <your-folder> --sign        (an EIP-191 signer-pin; the `evidence_unlimited`");
  L.push("                                                upgrade lifts the free 25-file cap) — see verifier/README.md §0a.");
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
    "  verify-vh <artifact> [--vendor <0xaddr>] [--dir <d>] [--revocations <file-or-dir> [--as-of <ISO>]] [--json]",
    "  verify-vh <artifact> <artifact> ... [--vendor <0xaddr>] [--dir <d>] [--revocations <file-or-dir>] [--json]   (batch)",
    "  verify-vh --manifest <file> [--vendor <0xaddr>] [--dir <d>] [--revocations <file-or-dir>] [--json]           (batch)",
    "",
    "DEMO: `verify-vh demo` runs a self-contained, genuinely-signed packet through the real verify path —",
    "NO flags, NO key, NO install state: it ACCEPTs the packet (naming the signer), then REJECTs a one-byte-",
    "tampered copy. The single command that takes a brand-new user from nothing to a verified packet.",
    "`verify-vh demo <dir>` goes one step further: it WRITES that same genuine signed packet + its files into",
    "<dir> (which you keep) and prints copy-paste commands so you verify, tamper, and re-verify it by hand.",
    "",
    "Auto-detects the artifact kind (evidence seal, reconciliation seal, dataset attestation, proof",
    "bundle — bare or signed), RE-DERIVES the keccak root from the referenced bytes (siblings resolve",
    "next to the artifact, or under --dir <d>), recovers the signer of a signed artifact, and PINS it",
    "to --vendor <0xaddr> (or reports the recovered signer when no pin is given).",
    "",
    "REVOCATIONS: --revocations <file-or-dir> [--as-of <ISO>] downgrades an otherwise-ACCEPTED signed",
    "artifact to REVOKED (exit 3) when its signing key was REVOKED at or before --as-of (default now). The",
    "file may be one signed revocation or a JSON array; a directory is read as a flat pool of revocation",
    "files. A revocation dated AFTER --as-of stays ACCEPTED with a later-revoked note; a forged/tampered/",
    "third-party revocation is IGNORED with a warning. This reaches the SAME downgrade the producer's",
    "`vh ... verify-signed --revocations` does, OFFLINE — no producer stack, no network, no key.",
    "",
    "BATCH/MANIFEST: pass several <artifact> args, or --manifest <file> (a newline list or JSON array of",
    "artifact paths, each line/object may carry its own --vendor/--dir). ALL must pass for exit 0; if ANY",
    "is rejected, exit is 3 and the report names which artifact failed and why. --json emits a stable",
    "aggregate { ok, total, passed, failed, results:[...] } whose entries are the single-artifact shape.",
    "Top-level --vendor/--dir are inherited as defaults a manifest entry may override; --revocations/--as-of",
    "apply to every entry.",
    "",
    "READ-ONLY: holds no key, writes nothing. Exit: 0 ok / 3 rejected|revoked / 2 usage / 1 IO.",
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
  verifyArtifactFromBytes,
  verifyBatch,
  buildBatchEntries,
  renderBatchHuman,
  verifyEvidenceSeal,
  verifyTrustSeal,
  verifyDatasetAttestation,
  verifyProofBundle,
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
  MAX_RELPATH_CHARS,
};

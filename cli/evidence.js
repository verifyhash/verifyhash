"use strict";

// cli/evidence.js — the EVIDENCE PACKET command (T-30.3): a product-AGNOSTIC, license-gated,
// tamper-evident evidence packet built ENTIRELY on the extracted shared cores.
//
// THE PRODUCT (the SECOND vertical on the provenance core).
//   `vh evidence seal <dir>` walks a directory and binds the WHOLE file set into ONE content-addressed
//   `*.vhevidence.json` packet over the GENERIC `cli/core/packetseal.js` core. `vh evidence verify <p>`
//   RE-DERIVES the root from the bytes referenced and localizes any tamper to the exact file (MATCH /
//   CHANGED / MISSING / UNEXPECTED). It is product-agnostic: there is NO trust-reconcile vocabulary
//   (no verdict / role / period header) — the seal commits ONLY to (relPath, content) pairs. The seal
//   therefore reuses the seal core with NO header (the optional binding seam of packetseal stays unused).
//
// FREE vs PAID.
//   The FREE tier — an UNSIGNED baseline seal + verify over a free SAMPLE size — stays open so a buyer
//   can try before buying. The PAID surface is GATED behind a valid `--license <f>`, verified OFFLINE
//   against the CANONICAL vendor identity (cli/core/vendor-identity.js; NEVER a caller-supplied
//   `--vendor` — T-75.3), via `cli/core/license.js` against a NEW, distinct EVIDENCE-PRODUCT entitlement table
//   (its OWN `kind`, NOT `trustledger-license` — a separate sellable product). The paid surface is:
//     * `evidence_signed`   — wrap the seal in a signed attestation (a vendor/operator vouches for it);
//     * `evidence_unlimited`— seal MORE than the free SAMPLE_LIMIT files in one packet.
//   The gate reuses the SAME verifyLicense / named-reject posture as the TrustLedger CLI.
//
// TRUST-BOUNDARIES (the one-liner the output LEADS with).
//   The seal proves TAMPER-EVIDENCE + OFFLINE-RECOMPUTE, NOT a trusted timestamp: "sealed at T" still
//   rides the human-owned signing/timestamp trust-root (P-3 — the public summary lives at
//   docs/TRUST-BOUNDARIES.md#p-3-trust-root). The packet is an UNTRUSTED
//   transport container — verify RE-DERIVES the root from the bytes you hold, never the packet's own
//   stored hashes. A signed wrap proves WHO vouched, still not WHEN.
//
// PURE CORES + a THIN CLI. All hashing / root math / signing lives in the shared cores; this file is the
// product framing (the seal/license cfgs) plus the I/O-bearing CLI run functions.

const fs = require("fs");
const path = require("path");

const packetseal = require("./core/packetseal");
const coreLicense = require("./core/license");
const vendorIdentity = require("./core/vendor-identity");
const coreAttestation = require("./core/attestation");
const coreTrustAsOf = require("./core/trust-asof");
const { listFiles, hashBytes } = require("./hash");
// REUSE the SAME path-bound file-level diff core the dataset/verify family uses — `diffManifest` — so a
// rename surfaces as REMOVED+ADDED and a content edit as CHANGED (old→new), with NO new diff logic here.
const { diffManifest } = require("./receipt");

// Exit contract (shared with the rest of the family): 0 ok / 1 IO / 2 usage / 3 gate-fail (seal-build /
// verify REJECTED). Mirrors trustledger/cli.js's EXIT so every gate reads the same. UNPINNED (4) is the
// T-75.2 fail-closed code: `verify-signed --strict` exits 4 when every requested check passed but NO
// `--signer` pin was requested — the bytes verify, but an unpinned signer is not provenance (anyone's
// key passes an unpinned check), and a strict CI gate must not go green on it.
const EXIT = Object.freeze({ OK: 0, IO: 1, USAGE: 2, FAIL: 3, UNPINNED: 4 });

// ---------------------------------------------------------------------------
// THE EVIDENCE SEAL product framing — handed to cli/core/packetseal.js. A GENERIC product `kind`
// (no trust-reconcile vocabulary), NO header (the seal binds ONLY the file set). The core does ALL the
// hashing / root / per-file localization; this just names the product.
// ---------------------------------------------------------------------------

const SEAL_KIND = "vh.evidence-seal";
const SEAL_SCHEMA_VERSION = 1;
const SUPPORTED_SEAL_SCHEMA_VERSIONS = Object.freeze([1]);

// The free SAMPLE size: how many files an UNLICENSED packet may seal. Sealing more requires the
// `evidence_unlimited` paid entitlement (try-before-you-buy: a small packet is free).
const SAMPLE_LIMIT = 25;

// The TRUST-BOUNDARIES one-liner the output LEADS with — stated ONCE so the human + JSON paths agree and
// the caveat can never drift. It is the load-bearing honesty of the artifact.
// FROZEN WIRE BYTES (T-78.2): this note is embedded VERBATIM in every seal (`note`) and pinned
// byte-for-byte by every shipped verifier (cli/core/packetseal.js, verifier/lib/seal-evidence.js, the
// published dist bundles) — repointing its internal "STRATEGY.md P-3" reference would invalidate every
// already-issued packet, including the mainnet-anchored releases in anchors/. The pointer's public,
// stable target is docs/TRUST-BOUNDARIES.md#p-3-trust-root ("Human-owned steps"); new prose must point
// THERE, never at the internal strategy log.
const EVIDENCE_TRUST_NOTE =
  "This evidence seal is TAMPER-EVIDENT + OFFLINE-RECOMPUTABLE, NOT a trusted timestamp. Its Merkle " +
  "`root` commits to the full set of (relPath, content) pairs in the directory: any edit, rename, add, " +
  "or remove changes the root, and verify RE-DERIVES the root from the bytes you hold and LOCALIZES the " +
  "change to the exact file (MATCH / CHANGED / MISSING / UNEXPECTED). It does NOT prove WHEN the sealing " +
  'happened ("sealed at T" rides the human-owned signing/timestamp trust-root, STRATEGY.md P-3) and it ' +
  "is NOT a legal opinion. The packet is an UNTRUSTED transport container: verify never trusts the " +
  "packet's own stored hashes.";

const SEAL_CFG = Object.freeze({
  kind: SEAL_KIND,
  schemaVersion: SEAL_SCHEMA_VERSION,
  supportedSchemaVersions: SUPPORTED_SEAL_SCHEMA_VERSIONS,
  note: EVIDENCE_TRUST_NOTE,
  label: "evidence seal",
  // NO header: a product-agnostic, file-only seal (the optional packetseal binding seam stays unused).
});

// ---------------------------------------------------------------------------
// THE EVIDENCE LICENSE product framing — handed to cli/core/license.js. A NEW, DISTINCT product `kind`
// (`vh-evidence-license`), NOT `trustledger-license`: a separate sellable product with its OWN closed
// entitlement table. The license core does ALL the crypto via the shared attestation envelope.
// ---------------------------------------------------------------------------

const LICENSE_KIND = "vh-evidence-license";
const LICENSE_SCHEMA_VERSION = 1;
const SUPPORTED_LICENSE_SCHEMA_VERSIONS = Object.freeze([1]);

// THE CANONICAL VENDOR IDENTITY the paid gate pins license verification to (T-75.3). This is the
// published verifyhash vendor identity — a COMMITTED constant (cli/core/vendor-identity.js), NEVER the
// caller-supplied `--vendor`: a gate that pinned to argv would let anyone self-mint a license with
// their own key and unlock the paid surface for free. `--vendor` is still accepted as an explicit
// assertion, but it must EQUAL this identity (a mismatch is a NAMED refusal, never a re-pin).
// SELF-HOSTING (honest boundary, not DRM — docs/LICENSING.md "Paid-gate vendor pinning"): an operator
// running their OWN instance sets their OWN identity — fork-edit the constant, export
// VH_CANONICAL_VENDOR, or pass the programmatic `io.canonicalVendor` seam (not reachable from argv).
const CANONICAL_VENDOR_ADDRESS = vendorIdentity.VERIFYHASH_VENDOR_ADDRESS;
const CANONICAL_VENDOR_ENV = vendorIdentity.CANONICAL_VENDOR_ENV;

// Resolve the canonical vendor identity for a run: io.canonicalVendor (programmatic embedder/test seam)
// > VH_CANONICAL_VENDOR (self-hosted operator config) > the committed published identity. The result is
// validated at the gate via coreLicense.resolveVendorPin, so a garbage configured value is a NAMED
// usage error — never a silent unlock.
function resolveCanonicalVendor(io) {
  return vendorIdentity.resolveCanonicalVendor({
    override: io && io.canonicalVendor,
    env: process.env,
  });
}

// THE CLOSED ENTITLEMENT TABLE for the EVIDENCE product. Disjoint from TrustLedger's. An unknown flag is
// a hard build error in the core (never silently honored).
const ENTITLEMENTS = Object.freeze({
  evidence_signed:
    "Wrap an evidence seal in a signed attestation (a vendor/operator vouches for the sealed packet).",
  evidence_unlimited:
    `Seal more than the free sample size (${SAMPLE_LIMIT} files) in one evidence packet.`,
});

// FROZEN WIRE BYTES (T-78.2): embedded VERBATIM in every issued license and pinned at verify — the
// internal "STRATEGY.md P-3" pointer inside it stays byte-frozen; its public target is
// docs/TRUST-BOUNDARIES.md#p-3-trust-root ("Human-owned steps").
const LICENSE_TRUST_NOTE =
  "This verifyhash EVIDENCE license is a SIGNED entitlement token, verified OFFLINE by re-deriving the " +
  "signer from these exact bytes and pinning it to the evidence-product vendor key. A valid verdict " +
  "proves the vendor signed THESE entitlements for THIS customer within [issuedAt, expiresAt]; it is an " +
  "UNTRUSTED transport container (verifyLicense never trusts the file's own claims), it is NOT a trusted " +
  "timestamp (issuedAt/expiresAt are self-asserted and ride the vendor key custody, STRATEGY.md P-3), " +
  "and it is NOT the legal subscription agreement (which governs). It gates the evidence product's PAID " +
  "surface; it never replaces the contract.";

const SIGNED_LICENSE_KIND = "vh-evidence-license-signed";
const SIGNED_LICENSE_SCHEMA_VERSION = 1;
const SUPPORTED_SIGNED_LICENSE_SCHEMA_VERSIONS = Object.freeze([1]);

const SIGNED_LICENSE_TRUST_NOTE =
  "This is a SIGNED verifyhash EVIDENCE license container: it WRAPS (never edits) the EXACT canonical " +
  "license bytes in `attestation` and attaches a detached EIP-191 signature. verifyLicense RE-DERIVES " +
  "the signer from those bytes and pins it to the vendor key — it never trusts the file's own claims. " +
  "Every caveat of the embedded license applies. " +
  LICENSE_TRUST_NOTE;

// A dedicated error type so callers/tests catch ONE evidence-license error.
class EvidenceLicenseError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvidenceLicenseError";
  }
}

const LICENSE_CFG = Object.freeze({
  // unsigned license payload framing
  kind: LICENSE_KIND,
  schemaVersion: LICENSE_SCHEMA_VERSION,
  supportedSchemaVersions: SUPPORTED_LICENSE_SCHEMA_VERSIONS,
  note: LICENSE_TRUST_NOTE,
  entitlements: ENTITLEMENTS,
  // the COMMITTED canonical vendor identity the paid gate pins to (T-75.3; see resolveVendorPin)
  canonicalVendor: CANONICAL_VENDOR_ADDRESS,
  // signed-container framing
  signedKind: SIGNED_LICENSE_KIND,
  signedSchemaVersion: SIGNED_LICENSE_SCHEMA_VERSION,
  supportedSignedSchemaVersions: SUPPORTED_SIGNED_LICENSE_SCHEMA_VERSIONS,
  signedNote: SIGNED_LICENSE_TRUST_NOTE,
  signedLabel: "signed verifyhash evidence license",
  ErrorClass: EvidenceLicenseError,
});

// Thin license adapters bound to the evidence CFG (so callers/tests need no cfg).
function buildLicense(params, signer) {
  return coreLicense.buildLicense(params, signer, LICENSE_CFG);
}
function readLicense(input) {
  return coreLicense.readLicense(input, LICENSE_CFG);
}
function verifyLicense(container, opts) {
  if (opts == null || typeof opts !== "object" || Array.isArray(opts)) {
    throw new EvidenceLicenseError("verifyLicense requires an options object { now, vendorAddress }");
  }
  return coreLicense.verifyLicense(container, {
    now: opts.now,
    vendorAddress: opts.vendorAddress,
    cfg: LICENSE_CFG,
  });
}
function hasEntitlement(verdict, flag) {
  return coreLicense.hasEntitlement(verdict, flag);
}
function serializeSignedLicense(container) {
  return coreLicense.serializeSignedLicense(container, LICENSE_CFG);
}

// ---------------------------------------------------------------------------
// THE SEAL build / validate / verify — thin wrappers binding SEAL_CFG to the GENERIC packetseal core.
// ---------------------------------------------------------------------------

/** Build a bare evidence seal from a flat { relPath, bytes } entry list. PURE. */
function buildSeal(entries) {
  return packetseal.buildSeal({ files: { entries } }, SEAL_CFG);
}

/** STRICT structural + root re-derivation validation. Throws PacketSealError on the first problem. */
function validateSeal(obj) {
  return packetseal.validateSeal(obj, SEAL_CFG);
}

/** Serialize a validated seal to canonical, byte-deterministic bytes (newline-terminated). */
function serializeSeal(seal) {
  validateSeal(seal);
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

/** Parse + strictly validate a seal (JSON string or object). A parse error is a PacketSealError. */
function readSeal(input) {
  let obj;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch (e) {
      throw new packetseal.PacketSealError(`evidence seal is not valid JSON: ${e.message}`);
    }
  } else if (input != null && typeof input === "object" && !Array.isArray(input)) {
    obj = input;
  } else {
    throw new packetseal.PacketSealError("readSeal requires a JSON string or a seal object");
  }
  validateSeal(obj);
  return obj;
}

/** The AUTHORITATIVE, PURE verify — recompute per-file + root from the supplied { relPath, bytes } set. */
function verifySeal(seal, entries) {
  return packetseal.verifySeal(seal, { entries }, SEAL_CFG);
}

// ---------------------------------------------------------------------------
// `diffEvidence({ packetA, packetB })` — PURE, OFFLINE, packet-to-packet change report.
//
// WHY THIS EXISTS
//   `vh evidence verify` answers "do these bytes on disk still match this packet?". But a buyer (or a CI
//   pipeline) often holds TWO sealed evidence packets — version A and version B of the SAME file set —
//   and no directory at all, and wants to answer "what changed between A and B?" PURELY from the two
//   portable artifacts: NO directory, NO bytes re-read, NO provider, NO key, NO network. This is the
//   evidence-product mirror of `cli/dataset.js › runDatasetDiff` — it reuses the EXACT SAME diff core.
//
// HOW (no new diff/crypto logic — every primitive is reused VERBATIM)
//   Each input may be EITHER a parsed seal object OR a packet STRING; BOTH are validated through the
//   EXISTING strict `readSeal` FIRST (a corrupt/foreign/edited/wrong-`kind` packet is REJECTED before any
//   diff — never half-accepted). Each packet's `files[]` ({ relPath, contentHash, leaf }) is then mapped
//   into the `{ path, contentHash, leaf }` shape `cli/receipt.js › diffManifest` expects and diffed by
//   REUSING that core verbatim. A is the BASELINE ("recorded"), B is the COMPARISON ("current"): so
//   ADDED = in B not A, REMOVED = in A not B, CHANGED = same relPath with a different leaf (old→new
//   contentHash). A rename surfaces as REMOVED(old path) + ADDED(new path) — the relPath is bound into
//   the leaf — never as a single CHANGED.
//
//   The diff compares what each packet CLAIMS; it re-derives NOTHING from bytes (there is no directory).
//   To re-derive a root from bytes, run `vh evidence verify` against the live tree.
//
// AUTHORITATIVE VERDICT
//   The returned `identical` is `diff.identical` — the CHANGE SET (no ADDED/REMOVED/CHANGED), computed
//   from the per-file LEAVES — NOT root-string equality (mirrors `runDatasetDiff` exactly). So a packet
//   with a hand-edited `root` whose leaves are unchanged still reports `identical:true`: a hand-edited
//   `root` cannot flip the verdict. `rootA`/`rootB`/`rootsIdentical` remain DISPLAYED metadata only.

/**
 * Diff two evidence packets, PURELY and OFFLINE. Accepts EITHER two parsed seal objects OR two packet
 * strings (or a mix); validates BOTH through the EXISTING strict `readSeal` BEFORE any diff (a
 * corrupt/foreign/edited/wrong-kind packet is REJECTED, never half-accepted), then reuses
 * `cli/receipt.js › diffManifest` VERBATIM. Mutates NEITHER input. Order-independent and deterministic.
 *
 * @param {object} args
 * @param {object|string} args.packetA the BASELINE packet (the "from") — a seal object or a packet string
 * @param {object|string} args.packetB the COMPARISON packet (the "to") — a seal object or a packet string
 * @returns {{
 *   rootA: string, rootB: string, rootsIdentical: boolean, identical: boolean,
 *   added: Array<{path:string,contentHash:string}>,
 *   removed: Array<{path:string,contentHash:string}>,
 *   changed: Array<{path:string,oldContentHash:string,newContentHash:string}>,
 *   unchanged: Array<{path:string,contentHash:string}>,
 *   counts: { added: number, removed: number, changed: number, unchanged: number }
 * }}
 */
function diffEvidence(args) {
  if (args == null || typeof args !== "object" || Array.isArray(args)) {
    throw new packetseal.PacketSealError("diffEvidence requires { packetA, packetB }");
  }
  return diffEvidenceSeals(args.packetA, args.packetB);
}

/**
 * The `seal`-object (positional) overload of `diffEvidence`. Same contract: each of `packetA`/`packetB`
 * may be a parsed seal object OR a packet string, both are validated through the strict `readSeal`
 * first, and the change set is computed by reusing `diffManifest` verbatim with the AUTHORITATIVE,
 * change-set-driven `identical` (NOT root-string equality). PURE; mutates neither input.
 *
 * @param {object|string} packetA the BASELINE packet (a seal object or a packet string)
 * @param {object|string} packetB the COMPARISON packet (a seal object or a packet string)
 * @returns {object} see {@link diffEvidence}
 */
function diffEvidenceSeals(packetA, packetB) {
  // STRICT reads FIRST: a corrupt/edited/foreign/wrong-kind packet is REJECTED here (readSeal throws a
  // PacketSealError), never half-accepted, BEFORE any diff is attempted. readSeal accepts EITHER a parsed
  // seal object OR a JSON string and validates structure + per-file leaf re-derivation. It returns the
  // SAME object reference for an object input, so we never mutate the caller's input below (we only READ
  // `.root`/`.files` and map into a fresh array). Both must be structurally sound to be diffed.
  const a = readSeal(packetA);
  const b = readSeal(packetB);

  const rootA = a.root;
  const rootB = b.root;
  // The two roots, recorded in the packets, are DISPLAYED metadata only. readSeal/validateSeal re-derives
  // every leaf == pathLeaf(relPath, contentHash) and the root over those leaves, so for a structurally
  // valid packet the root DOES summarize its leaves — but we still do NOT let root-string equality decide
  // the verdict (see `identical` below), so the policy is identical to `runDatasetDiff`: a hand-edited
  // `root` that survives validation cannot flip the change-set verdict.
  const rootsIdentical = rootA.toLowerCase() === rootB.toLowerCase();

  // Map each packet's `files` (relPath→path) into the shape diffManifest expects, then REUSE the SAME
  // diff core VERBATIM. A is the baseline ("recorded"), B is the comparison ("current"): so diffManifest's
  // ADDED = in B not A, REMOVED = in A not B, CHANGED = same relPath, different leaf (carrying old→new
  // contentHash). A rename is REMOVED(old path) + ADDED(new path) — the relPath is bound into the leaf.
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

  // AUTHORITATIVE verdict is the CHANGE SET, not root-string equality. diffManifest already returns
  // `identical` (true iff there is no ADDED / REMOVED / CHANGED) from the per-file LEAVES — the same data
  // the returned changeset is built from. Deriving the verdict from the changeset guarantees `identical`
  // and the body can never disagree: a packet with a hand-edited `root` (whose leaves are unchanged) still
  // reports `identical:true` with an empty changeset. rootA/rootB/rootsIdentical remain DISPLAYED metadata.
  const identical = diff.identical;

  const counts = {
    added: diff.added.length,
    removed: diff.removed.length,
    changed: diff.changed.length,
    unchanged: diff.unchanged.length,
  };

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

// ---------------------------------------------------------------------------
// DRIFT POLICY (T-46.1 leverage): a CI-gateable verdict over the change set `diffEvidence` produces.
//
// WHY THIS EXISTS (the paying-customer leverage over a bare diff)
//   A bare A->B change report answers "WHAT changed?". A buyer who pins evidence in a compliance / IP /
//   chain-of-custody pipeline needs the next question answered automatically: "is this change ALLOWED?"
//   — and a NON-ZERO exit when it is not, so CI fails the build / blocks the merge / alerts the reviewer.
//   `evaluateDriftPolicy({ diff, policy })` turns the pure `diffEvidence` change set into a PASS/FAIL
//   verdict against a small, explicit policy, with a per-change violation list a human (or a ticket) can
//   read. It mirrors `cli/dataset.js › evaluatePolicy` (the SAME verdict/violation/rulesEvaluated shape,
//   the SAME PASS/FAIL vocabulary), so the two policy gates read identically across the product family.
//
// IT INVENTS NO NEW DIFF/CRYPTO MATH. It consumes the EXACT object `diffEvidence` returns (added /
//   removed / changed) — no second walk of the packets, no re-hashing — and only CLASSIFIES those
//   already-computed changes against the policy. So the gate can never disagree with the diff it gates.
//
// THE RULES (every field OPTIONAL and combinable; a policy with NO rules trivially PASSes)
//   - noAdded      : true  -> ANY ADDED file violates (the new packet may not introduce files).
//   - noRemoved    : true  -> ANY REMOVED file violates (append-only / nothing may disappear — the
//                             load-bearing rule for an evidence chain-of-custody: a removal is suspicious).
//   - noChanged    : true  -> ANY CHANGED file (edited content at the same relPath) violates.
//   - allowChangePaths : [prefixes] -> a CHANGED file whose relPath is NOT under one of these POSIX path
//                             prefixes violates (e.g. only files under "src/" may be edited). A prefix
//                             match is segment-aware: "src" matches "src/x" and "src" but never "srcfoo".
//   - frozenPaths      : [prefixes] -> a file under one of these prefixes that is CHANGED *or* REMOVED
//                             violates (those paths are FROZEN — neither edited nor deleted). ADDING a new
//                             file under a frozen prefix is allowed (freezing protects what already exists).
//   A rename is REMOVED(old)+ADDED(new) in the change set, so it is gated as a remove + an add — never as
//   a silent edit (consistent with the whole family: the relPath is bound into the leaf).
//
// PURE: no I/O, no provider, no key, no network. Deterministic + order-independent: violations are sorted
//   (relPath, then rule), so two runs over the same diff+policy are byte-identical. Mutates NEITHER input.
// ---------------------------------------------------------------------------

const DRIFT_POLICY_KIND = "vh.evidence-drift-policy";
const DRIFT_POLICY_SCHEMA_VERSION = 1;
const SUPPORTED_DRIFT_POLICY_SCHEMA_VERSIONS = Object.freeze([1]);

// Stable, documented rule identifiers a violation reports in its `rule` field — a consumer can gate on
// these EXACT strings (mirrors cli/dataset.js › POLICY_RULE).
const DRIFT_RULE = Object.freeze({
  NO_ADDED: "noAdded",
  NO_REMOVED: "noRemoved",
  NO_CHANGED: "noChanged",
  ALLOW_CHANGE_PATHS: "allowChangePaths",
  FROZEN_PATHS: "frozenPaths",
});

// The boolean rules (each present-and-`true` enables a constraint) and the path-list rules (each, when a
// non-empty array, constrains by POSIX path prefix). Kept as data so validation, the rule count, and the
// evaluator never drift in which fields they recognize.
const DRIFT_BOOL_RULES = Object.freeze([
  DRIFT_RULE.NO_ADDED,
  DRIFT_RULE.NO_REMOVED,
  DRIFT_RULE.NO_CHANGED,
]);
const DRIFT_LIST_RULES = Object.freeze([DRIFT_RULE.ALLOW_CHANGE_PATHS, DRIFT_RULE.FROZEN_PATHS]);

// Possible verdicts (same vocabulary as the dataset policy gate, so the family reads identically).
const DRIFT_VERDICT = Object.freeze({ PASS: "PASS", FAIL: "FAIL" });

// The TRUST one-liner the drift gate LEADS with — stated ONCE so human + JSON agree. A drift PASS is a
// statement about the CHANGE SET BETWEEN TWO PACKETS, computed from what each packet CLAIMS; it does NOT
// re-derive content from bytes and is NOT a trusted timestamp or a legal opinion.
const DRIFT_TRUST_NOTE =
  "A drift-policy verdict gates the CHANGE SET between two evidence packets (what each packet CLAIMS) — " +
  "it does NOT re-derive content from a directory, is NOT a trusted timestamp, and is NOT a legal " +
  "opinion. Run `vh evidence verify <packet> --dir <d>` to re-derive a root from bytes. " +
  EVIDENCE_TRUST_NOTE;

/**
 * Strictly validate a parsed drift-policy object. Throws an Error describing the FIRST problem; never
 * mutates and never fills defaults (mirrors cli/dataset.js › validatePolicy). A wrong kind/schemaVersion,
 * a non-boolean boolean rule, or a non-array / empty-string-entry path list hard-errors here so a
 * corrupt/foreign policy is rejected, never half-accepted. Every rule is OPTIONAL and combinable; a
 * policy with NO rules is valid (and trivially PASSes).
 * @param {any} obj
 * @returns {object} the same object, if valid
 */
function validateDriftPolicy(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new packetseal.PacketSealError("evidence drift policy must be a JSON object");
  }
  if (obj.kind !== DRIFT_POLICY_KIND) {
    throw new packetseal.PacketSealError(
      `not a verifyhash evidence drift policy (kind: ${JSON.stringify(obj.kind)}; expected ${JSON.stringify(
        DRIFT_POLICY_KIND
      )})`
    );
  }
  if (!SUPPORTED_DRIFT_POLICY_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new packetseal.PacketSealError(
      `unsupported evidence drift policy schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(SUPPORTED_DRIFT_POLICY_SCHEMA_VERSIONS)})`
    );
  }
  // Boolean rules: each, WHEN PRESENT, must be a STRICT boolean (reject a truthy string/number that would
  // silently enable the rule).
  for (const f of DRIFT_BOOL_RULES) {
    if (obj[f] !== undefined && typeof obj[f] !== "boolean") {
      throw new packetseal.PacketSealError(
        `evidence drift policy ${f} must be a boolean when present, got: ${String(obj[f])}`
      );
    }
  }
  // Path-list rules: each, WHEN PRESENT, must be an array of non-empty strings. Reject a non-array or an
  // empty/non-string entry rather than silently coercing.
  for (const f of DRIFT_LIST_RULES) {
    if (obj[f] === undefined) continue;
    if (!Array.isArray(obj[f])) {
      throw new packetseal.PacketSealError(
        `evidence drift policy ${f} must be an array of path prefixes when present, got: ${String(obj[f])}`
      );
    }
    obj[f].forEach((v, i) => {
      if (typeof v !== "string" || v.length === 0) {
        throw new packetseal.PacketSealError(
          `evidence drift policy ${f}[${i}] must be a non-empty string, got: ${String(v)}`
        );
      }
    });
  }
  return obj;
}

/**
 * Count the rules a validated drift policy actually carries — so the verdict can report `rulesEvaluated`
 * and a no-rules policy is announced clearly. A boolean rule counts only when exactly `true`; a path-list
 * rule counts only when present AND non-empty (an empty `frozenPaths: []` carries no constraint).
 * @param {object} policy a validated drift policy object
 * @returns {number}
 */
function _countDriftRules(policy) {
  let n = 0;
  for (const f of DRIFT_BOOL_RULES) if (policy[f] === true) n++;
  for (const f of DRIFT_LIST_RULES) if (Array.isArray(policy[f]) && policy[f].length > 0) n++;
  return n;
}

/**
 * Does `relPath` fall under POSIX path `prefix`? SEGMENT-AWARE so a prefix never matches a sibling whose
 * name merely starts with it: "src" matches "src" and "src/x" but NOT "srcfoo". A bare prefix equal to the
 * whole path matches (the file IS that path). Inputs are the relPaths a seal already normalizes to POSIX
 * forward slashes, so no separator juggling is needed.
 * @param {string} relPath
 * @param {string} prefix
 * @returns {boolean}
 */
function _underPrefix(relPath, prefix) {
  // Normalize a trailing slash on the prefix away ("src/" and "src" mean the same subtree).
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return relPath === p || relPath.startsWith(p + "/");
}

/**
 * Evaluate the change set `diffEvidence` produced against a drift policy, in a PURE, deterministic
 * function (no I/O, no provider, no key, no network). Consumes the EXACT object `diffEvidence`/
 * `diffEvidenceSeals` returns — it does NOT re-diff or re-hash — and classifies each already-computed
 * ADDED/REMOVED/CHANGED entry against the policy's rules. Returns a verdict: PASS (no change violates any
 * rule) or FAIL with, per violating change, the relPath + which rule it broke + the change KIND that
 * triggered it. A single file can violate more than one rule (each is its own violation entry).
 * Violations are sorted by relPath then rule, so two runs over the same inputs are byte-identical.
 *
 * Mutates NEITHER input (it only reads `diff.added/removed/changed` and the policy's rule fields).
 *
 * @param {object} args
 * @param {object} args.diff   the object `diffEvidence` returns (added/removed/changed/...)
 * @param {object} args.policy a validated drift policy object (from `validateDriftPolicy`/`readDriftPolicy`)
 * @returns {{
 *   verdict: "PASS"|"FAIL",
 *   rulesEvaluated: number,
 *   addedCount: number, removedCount: number, changedCount: number,
 *   violations: { relPath: string, rule: string, change: "ADDED"|"REMOVED"|"CHANGED" }[],
 * }}
 */
function evaluateDriftPolicy(args) {
  if (args == null || typeof args !== "object" || Array.isArray(args)) {
    throw new packetseal.PacketSealError("evaluateDriftPolicy requires { diff, policy }");
  }
  const { diff, policy } = args;
  if (diff == null || typeof diff !== "object") {
    throw new packetseal.PacketSealError("evaluateDriftPolicy requires a diff (from diffEvidence)");
  }
  validateDriftPolicy(policy); // a foreign/corrupt policy is rejected here, never half-evaluated

  const added = Array.isArray(diff.added) ? diff.added : [];
  const removed = Array.isArray(diff.removed) ? diff.removed : [];
  const changed = Array.isArray(diff.changed) ? diff.changed : [];

  const noAdded = policy.noAdded === true;
  const noRemoved = policy.noRemoved === true;
  const noChanged = policy.noChanged === true;
  const allowChangePaths =
    Array.isArray(policy.allowChangePaths) && policy.allowChangePaths.length > 0
      ? policy.allowChangePaths
      : null;
  const frozenPaths =
    Array.isArray(policy.frozenPaths) && policy.frozenPaths.length > 0 ? policy.frozenPaths : null;

  const violations = [];

  // ADDED files: only `noAdded` constrains them (a new file is allowed under a frozen prefix — freezing
  // protects what already EXISTS, it does not forbid growth).
  for (const a of added) {
    if (noAdded) {
      violations.push({ relPath: a.path, rule: DRIFT_RULE.NO_ADDED, change: "ADDED" });
    }
  }

  // REMOVED files: `noRemoved` forbids any removal; `frozenPaths` forbids removing a file under a frozen
  // prefix (a frozen path may be neither edited nor deleted).
  for (const r of removed) {
    if (noRemoved) {
      violations.push({ relPath: r.path, rule: DRIFT_RULE.NO_REMOVED, change: "REMOVED" });
    }
    if (frozenPaths && frozenPaths.some((p) => _underPrefix(r.path, p))) {
      violations.push({ relPath: r.path, rule: DRIFT_RULE.FROZEN_PATHS, change: "REMOVED" });
    }
  }

  // CHANGED files: `noChanged` forbids any edit; `allowChangePaths`, when set, forbids editing a file NOT
  // under one of the allowed prefixes; `frozenPaths` forbids editing a file under a frozen prefix.
  for (const c of changed) {
    if (noChanged) {
      violations.push({ relPath: c.path, rule: DRIFT_RULE.NO_CHANGED, change: "CHANGED" });
    }
    if (allowChangePaths && !allowChangePaths.some((p) => _underPrefix(c.path, p))) {
      violations.push({ relPath: c.path, rule: DRIFT_RULE.ALLOW_CHANGE_PATHS, change: "CHANGED" });
    }
    if (frozenPaths && frozenPaths.some((p) => _underPrefix(c.path, p))) {
      violations.push({ relPath: c.path, rule: DRIFT_RULE.FROZEN_PATHS, change: "CHANGED" });
    }
  }

  // Deterministic order: by relPath, then by rule (a stable total order, so two runs are byte-identical).
  violations.sort((x, y) => {
    if (x.relPath !== y.relPath) return x.relPath < y.relPath ? -1 : 1;
    return x.rule < y.rule ? -1 : x.rule > y.rule ? 1 : 0;
  });

  return {
    verdict: violations.length === 0 ? DRIFT_VERDICT.PASS : DRIFT_VERDICT.FAIL,
    rulesEvaluated: _countDriftRules(policy),
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changed.length,
    violations,
  };
}

/**
 * Read, parse, and STRICTLY validate the drift policy at `policyPath`. Throws on a missing file, invalid
 * JSON, or ANY schema deviation (a malformed/foreign policy is rejected, never half-accepted) — mirrors
 * cli/dataset.js › readPolicy.
 * @param {string} policyPath
 * @returns {object} the validated drift policy object
 */
function readDriftPolicy(policyPath) {
  if (!policyPath || typeof policyPath !== "string") {
    throw new packetseal.PacketSealError("readDriftPolicy requires a policy file path");
  }
  let raw;
  try {
    raw = fs.readFileSync(policyPath, "utf8");
  } catch (e) {
    throw new packetseal.PacketSealError(
      `cannot read evidence drift policy at ${policyPath}: ${e.message}`
    );
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new packetseal.PacketSealError(
      `evidence drift policy at ${policyPath} is not valid JSON: ${e.message}`
    );
  }
  return validateDriftPolicy(obj);
}

// ---------------------------------------------------------------------------
// SIGNED-attestation WRAP (the PAID `evidence_signed` surface). The seal's CANONICAL bytes become the
// attestation payload — the SAME shared signing path the rest of the family uses (no new scheme).
// ---------------------------------------------------------------------------

const SIGNED_SEAL_KIND = "vh.evidence-seal-signed";
const SIGNED_SEAL_SCHEMA_VERSION = 1;
const SUPPORTED_SIGNED_SEAL_SCHEMA_VERSIONS = Object.freeze([1]);

const SIGNED_SEAL_TRUST_NOTE =
  "This is a SIGNED evidence-seal container: it WRAPS (never edits) the EXACT canonical seal bytes in " +
  "`attestation` and attaches a detached EIP-191 signature. It asserts the holder of the `signer` key " +
  "vouched for THIS sealed packet (the embedded root) at signing time. It does NOT prove a timestamp " +
  '(no "sealed since T" — still the human trust-root P-3) and is NOT a legal opinion. Every caveat of ' +
  "the embedded seal applies. " +
  EVIDENCE_TRUST_NOTE;

const SIGNED_SEAL_CFG = Object.freeze({
  kind: SIGNED_SEAL_KIND,
  schemaVersion: SIGNED_SEAL_SCHEMA_VERSION,
  supportedSchemaVersions: SUPPORTED_SIGNED_SEAL_SCHEMA_VERSIONS,
  note: SIGNED_SEAL_TRUST_NOTE,
  label: "signed evidence seal",
  validateUnsigned: validateSeal,
  serializeUnsigned: serializeSeal,
});

/** Sign a validated seal with a caller-supplied ethers signer-like object and WRAP it. */
async function signSealWith(seal, signer) {
  return coreAttestation.signAttestation({ attestation: seal, signer }, SIGNED_SEAL_CFG);
}

/** Strictly validate a parsed SIGNED-seal container. */
function validateSignedSeal(obj) {
  return coreAttestation.validateSignedAttestation(obj, SIGNED_SEAL_CFG);
}

/** Verify a SIGNED-seal container OFFLINE (recover the signer; optionally pin/bind). */
function verifySignedSeal(params) {
  return coreAttestation.verifySignedAttestation(params);
}

// The standing trust caveat the signed-verify path LEADS with — reuses EVIDENCE_TRUST_NOTE verbatim (so
// the caveats can NEVER drift) plus the signing-specific honesty: a valid signature proves WHO vouched,
// still NOT a timestamp (P-3) and NOT a legal opinion. Mirrors cli/dataset.js › VERIFY_ATTEST_TRUST_NOTE.
const VERIFY_SIGNED_SEAL_TRUST_NOTE =
  "A valid signature proves the HOLDER OF `signer`'s key vouched for THIS evidence seal (the embedded " +
  "root + the full set of (relPath, content) pairs). It does NOT by itself prove a trustworthy " +
  'TIMESTAMP: "sealed/vouched since a date T" still needs the human-owned signing/timestamp trust-root ' +
  "(needs-human, P-3). It is NOT a legal opinion. " +
  EVIDENCE_TRUST_NOTE;

/**
 * Verify (purely, OFFLINE) a SIGNED evidence-seal container — the STRICT, PURE signed-verify path that
 * MIRRORS `cli/dataset.js › verifySignedAttestation` EXACTLY. It recovers the signer from the embedded
 * canonical seal bytes + signature and confirms it equals the container's CLAIMED `signer` (Check 1 —
 * ALWAYS run); OPTIONALLY pins it to an EXPECTED signer (`expectedSigner` / the CLI `--signer` flag —
 * Check 2, run ONLY when present); and OPTIONALLY confirms the signature binds a holder's OWN directory
 * (`dir` / the CLI `--dir` flag) by recomputing the canonical UNSIGNED seal bytes from that directory via
 * the EXISTING build path (`serializeSeal(buildSeal(loadDirEntries(dir)))`) and requiring them
 * byte-identical to the embedded payload. The verdict is ACCEPTED only when EVERY requested check passes;
 * a forged/mismatched/tampered signature is a clean REJECTED — NEVER a silent pass.
 *
 * It is OFFLINE / key-free / network-free: it recovers a PUBLIC address from a signature, holds no private
 * key, and contacts nothing. It writes NOTHING and mutates NEITHER the container NOR the directory (the
 * `--dir` read is the ONLY I/O, and only when binding is requested). Throws only on an unrecoverable
 * signature when the scheme is unknown (defense-in-depth — validateSignedSeal already rejects one) or when
 * the supplied `--dir` cannot be read; a recovered address that simply doesn't match is a clean REJECTED.
 *
 * The returned shape is the SIBLING-PARITY verdict shape (byte-for-byte the fields `verifySignedAttestation`
 * returns, including the `manifestBindsAttestation`/`manifestChecked` field names so a future indexer/UI can
 * depend on ONE stable verdict shape across the product family).
 *
 * @param {object} params
 * @param {object} params.container        a validated signed-seal container (from validateSignedSeal/readPacket)
 * @param {string} [params.expectedSigner] OPTIONAL expected signer 0x-address (--signer); Check 2 runs when present
 * @param {string} [params.dir]            OPTIONAL directory to bind the signature to (--dir); binding runs when present
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
function verifySignedSealAttestation(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("verifySignedSealAttestation requires { container, [expectedSigner], [dir] }");
  }
  const { container, expectedSigner, dir } = params;

  // The ONLY evidence-specific step: the OPTIONAL --dir binding check recomputes the canonical UNSIGNED
  // seal bytes from the holder's OWN directory via the EXISTING build path (the SAME bytes `vh evidence
  // seal` embeds), then hands them to the GENERIC core as `expectedCanonical`. The core does the signer
  // recovery (Check 1, always), the OPTIONAL expected-signer pin (Check 2), and the byte-identity binding
  // comparison — all product-agnostic. We pass `container` straight through (no copy; the container is only
  // READ), so this never mutates the caller's input. The returned shape (incl. the field names) is
  // byte-for-byte what the dataset sibling returns.
  let expectedCanonical;
  if (dir !== undefined && dir !== null) {
    // Recompute the canonical seal bytes from the live directory — the SAME (relPath, content) walk + seal
    // build the seal path uses. A directory the holder cannot read is a genuine error (re-thrown), never a
    // silent "binding skipped" — the caller asked to bind to bytes that must exist.
    const dirAbs = path.resolve(dir);
    const entries = loadDirEntries(dirAbs);
    expectedCanonical = serializeSeal(buildSeal(entries));
  }
  // Route through the existing `verifySignedSeal` thin wrapper (which calls coreAttestation.
  // verifySignedAttestation) so this path stays the single, shared verify core — exactly mirroring how the
  // dataset sibling funnels through coreAttestation.verifySignedAttestation.
  return verifySignedSeal({ container, expectedSigner, expectedCanonical });
}

// ---------------------------------------------------------------------------
// I/O HELPERS — the only filesystem-touching code. Walk a directory into the flat { relPath, bytes }
// entry list the seal core consumes, REUSING cli/hash.js's listFiles (the SAME path-bound enumeration
// `vh hash <dir>` / `vh dataset build` use — no new walk).
// ---------------------------------------------------------------------------

/**
 * Load a directory into a sorted [{ relPath, bytes }] list. relPath is POSIX-normalized + relative to
 * `dirAbs` (the SAME convention the manifest core records), so the seal travels with the directory. PURE
 * except for the file reads.
 */
function loadDirEntries(dirAbs) {
  const files = listFiles(dirAbs); // recursive; skips sockets/fifos/symlinks (no stable hash)
  const entries = files.map((abs) => {
    const rel = path.relative(dirAbs, abs).split(path.sep).join("/");
    return { relPath: rel, bytes: fs.readFileSync(abs) };
  });
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return entries;
}

// ---------------------------------------------------------------------------
// `vh evidence seal <dir> [--out <p>] [--license <f>]`
//
// Walks <dir>, builds the *.vhevidence.json seal, and either prints it (default; writes NOTHING) or
// writes it to --out. NEVER writes to cwd without --out. The PAID surface (signed wrap, or sealing more
// than the free SAMPLE_LIMIT) is GATED behind a valid --license verified OFFLINE against the CANONICAL
// vendor identity (T-75.3; --vendor is accepted only as an assertion that must EQUAL it). The output
// LEADS with the TRUST-BOUNDARIES one-liner. Exit: 0 ok / 3 seal-build-error / 2 usage / 1 IO.
// ---------------------------------------------------------------------------

function parseSealArgs(argv) {
  const opts = {
    dir: undefined,
    out: undefined,
    license: undefined,
    vendor: undefined,
    sign: false,
    keyEnv: undefined,
    keyFile: undefined,
    json: false,
    _positionals: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (flag) => {
      const v = argv[++i];
      if (v === undefined) {
        const e = new Error(`${flag} requires a value`);
        e.usage = true;
        throw e;
      }
      return v;
    };
    switch (a) {
      case "--out":
        opts.out = need("--out");
        break;
      case "--license":
        opts.license = need("--license");
        break;
      case "--vendor":
        opts.vendor = need("--vendor");
        break;
      case "--sign":
        opts.sign = true;
        break;
      case "--key-env":
        opts.keyEnv = need("--key-env");
        break;
      case "--key-file":
        opts.keyFile = need("--key-file");
        break;
      case "--json":
        opts.json = true;
        break;
      default:
        if (a && a.startsWith("--")) {
          const e = new Error(`unknown flag: ${a}`);
          e.usage = true;
          throw e;
        }
        opts._positionals.push(a);
    }
  }
  if (opts._positionals.length > 1) {
    const e = new Error(
      `unexpected extra argument: ${opts._positionals[1]} (evidence seal takes exactly one <dir>)`
    );
    e.usage = true;
    throw e;
  }
  opts.dir = opts._positionals[0];
  return opts;
}

// The license GATE for the paid evidence surfaces. Returns { ok, code?, verdict? }: a clean { ok:true }
// when NO paid surface is requested (FREE tier, no license needed), else REQUIRES a VALID license
// carrying the matching entitlement and reports the precise verifyLicense reason on reject. The reject
// NEVER silently downgrades to a free run. `now` dates the window check.
//
// THE PIN (T-75.3): the license is verified against `canonicalVendor` — the CANONICAL vendor identity
// resolved OUTSIDE argv (committed constant / VH_CANONICAL_VENDOR / io.canonicalVendor) — NEVER against
// the caller-supplied `--vendor`. A `--vendor` that does not EQUAL the canonical identity is a NAMED
// usage refusal (a caller must not re-pin the gate); a license minted by any OTHER key is the NAMED
// `wrong_issuer` reject. Only licenses minted by the real vendor key unlock paid entitlements.
function gatePaid(opts, requested, now, writeErr, canonicalVendor) {
  if (requested.length === 0) {
    return { ok: true, verdict: null }; // FREE tier
  }
  const featureList = requested.map((r) => r.label).join(" and ");

  if (opts.license == null) {
    // NOTE: this refusal stays ADDRESS-FREE (no 0x hex at all) so the "never echoes key material"
    // guard stays trivially auditable; the canonical identity itself is printed by `vh evidence -h`.
    writeErr(
      `error: ${featureList} ${requested.length > 1 ? "are" : "is"} a PAID surface and ` +
        "requires a license; pass --license <file>. Licenses are verified OFFLINE against the " +
        "CANONICAL vendor identity (see `vh evidence -h`) — only a license minted by that vendor key " +
        "unlocks the paid surface. " +
        `The FREE tier — an unsigned baseline seal of up to ${SAMPLE_LIMIT} files + verify — needs no license.\n`
    );
    return { ok: false, code: EXIT.USAGE };
  }

  // Resolve the ONE pin the gate verifies against. An optional --vendor is accepted ONLY as an explicit
  // assertion that must EQUAL the canonical identity — a mismatch (the self-mint re-pin) or a garbage
  // canonical/asserted address is a NAMED usage refusal from the core, never a silent re-pin.
  const cfg =
    canonicalVendor === CANONICAL_VENDOR_ADDRESS
      ? LICENSE_CFG
      : Object.freeze({ ...LICENSE_CFG, canonicalVendor });
  let pin;
  try {
    pin = coreLicense.resolveVendorPin(cfg, opts.vendor);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return { ok: false, code: EXIT.USAGE };
  }

  // Read the license OFFLINE (an unreadable/garbled file is a usage error; there is no key in a license).
  let container;
  try {
    const text = fs.readFileSync(path.resolve(opts.license), "utf8");
    container = readLicense(text);
  } catch (e) {
    writeErr(`error: cannot read --license file ${opts.license}: ${e.message}\n`);
    return { ok: false, code: EXIT.USAGE };
  }

  // Verify OFFLINE against the CANONICAL pin resolved above.
  let verdict;
  try {
    verdict = verifyLicense(container, { now, vendorAddress: pin });
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return { ok: false, code: EXIT.USAGE };
  }
  if (!verdict.valid) {
    const selfMintNote =
      verdict.reason === "wrong_issuer"
        ? " Paid entitlements unlock ONLY with a license minted by the canonical vendor key; a " +
          "self-minted license signed by any other key is refused. Running your OWN instance? Set " +
          "your OWN canonical vendor identity — see docs/LICENSING.md."
        : "";
    writeErr(
      `error: ${featureList} requires a VALID license, but the supplied license is ` +
        `${verdict.reason} (recovered ${verdict.recoveredSigner || "(unrecoverable)"}, ` +
        `pinned to ${verdict.vendorAddress}).${selfMintNote}\n`
    );
    return { ok: false, code: EXIT.FAIL };
  }

  // The license is valid — require it to actually CARRY each requested entitlement.
  for (const r of requested) {
    if (!hasEntitlement(verdict, r.entitlement)) {
      writeErr(
        `error: the supplied license is valid but does NOT include the "${r.entitlement}" ` +
          `entitlement needed for ${r.label}; it grants only ${JSON.stringify(verdict.entitlements)}.\n`
      );
      return { ok: false, code: EXIT.FAIL };
    }
  }
  return { ok: true, verdict };
}

async function runEvidenceSeal(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  const now = io.now || new Date();

  if (!opts.dir) {
    writeErr("error: `vh evidence seal` requires a <dir>\n");
    return EXIT.USAGE;
  }

  // Walk the directory (the only read I/O). A missing/unreadable dir or a non-directory is an IO error.
  const dirAbs = path.resolve(opts.dir);
  let stat;
  try {
    stat = fs.statSync(dirAbs);
  } catch (e) {
    writeErr(`error: cannot read directory ${opts.dir}: ${e.message}\n`);
    return EXIT.IO;
  }
  if (!stat.isDirectory()) {
    writeErr(`error: ${opts.dir} is not a directory\n`);
    return EXIT.IO;
  }
  let entries;
  try {
    entries = loadDirEntries(dirAbs);
  } catch (e) {
    writeErr(`error: cannot read directory ${opts.dir}: ${e.message}\n`);
    return EXIT.IO;
  }
  if (entries.length === 0) {
    writeErr(`error: ${opts.dir} contains no files to seal\n`);
    return EXIT.FAIL;
  }

  // Decide which paid surfaces this invocation requests. Sealing more than the free sample requires
  // `evidence_unlimited`; --sign requires `evidence_signed`. Both are gated OFFLINE before any work.
  const requested = [];
  if (opts.sign) {
    requested.push({ entitlement: "evidence_signed", label: "the signed-attestation wrap (--sign)" });
  }
  if (entries.length > SAMPLE_LIMIT) {
    requested.push({
      entitlement: "evidence_unlimited",
      label: `sealing more than the free sample size (${SAMPLE_LIMIT} files; this dir has ${entries.length})`,
    });
  }
  const gate = gatePaid(opts, requested, now, writeErr, resolveCanonicalVendor(io));
  if (!gate.ok) return gate.code;

  // Build the bare seal over the GENERIC core. A build error (e.g. a duplicate path) is a 3, never a crash.
  let seal;
  try {
    seal = buildSeal(entries);
  } catch (e) {
    writeErr(`error: cannot build evidence seal: ${e.message}\n`);
    return EXIT.FAIL;
  }

  // Optionally WRAP in a signed attestation (the paid `evidence_signed` surface, already gated above).
  // The key is read, used, and discarded inside loadSigningWallet — NEVER persisted or logged.
  let artifactStr;
  let signedBy = null;
  if (opts.sign) {
    let wallet;
    try {
      ({ wallet } = coreAttestation.loadSigningWallet({ keyEnv: opts.keyEnv, keyFile: opts.keyFile }));
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return EXIT.USAGE;
    }
    let container;
    try {
      container = await signSealWith(seal, wallet);
    } catch (e) {
      writeErr(`error: cannot sign evidence seal: ${e.message}\n`);
      return EXIT.FAIL;
    }
    signedBy = coreAttestation.recoverSigner(container);
    artifactStr = coreAttestation.serializeSignedAttestation(container, SIGNED_SEAL_CFG);
  } else {
    artifactStr = serializeSeal(seal);
  }

  // Write to --out (caller-chosen path; NEVER cwd) or print to stdout (writes nothing).
  let outAbs = null;
  if (opts.out) {
    outAbs = path.resolve(opts.out);
    try {
      fs.writeFileSync(outAbs, artifactStr);
    } catch (e) {
      writeErr(`error: cannot write --out file ${opts.out}: ${e.message}\n`);
      return EXIT.IO;
    }
  }

  if (opts.json) {
    write(
      JSON.stringify(
        {
          ok: true,
          note: EVIDENCE_TRUST_NOTE,
          kind: signedBy ? SIGNED_SEAL_KIND : SEAL_KIND,
          root: seal.root,
          fileCount: seal.fileCount,
          signed: !!signedBy,
          signer: signedBy,
          out: outAbs,
          // With NO --out the artifact rides in `artifact` so --json never drops it (parity with the family).
          artifact: outAbs ? null : artifactStr,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(EVIDENCE_TRUST_NOTE + "\n\n");
    write(
      `sealed ${seal.fileCount} file${seal.fileCount === 1 ? "" : "s"} ` +
        `into ${signedBy ? "a SIGNED evidence packet" : "an evidence packet"} — root ${seal.root}\n`
    );
    if (signedBy) write(`  signed by:    ${signedBy}\n`);
    if (outAbs) {
      write(`  written:      ${outAbs}\n`);
    } else {
      // Default: print the seal bytes so a buyer can eyeball/redirect them — still writes nothing.
      write(artifactStr);
    }
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// `vh evidence verify <p>` — read-only, NO key. RE-DERIVES the root from the bytes referenced and reports
// OK / which file CHANGED/MISSING/UNEXPECTED. Files resolve relative to --dir (if given) else the packet
// file's own directory (the packet stores relPaths relative to where its <dir> was sealed). Exit: 0 OK /
// 3 REJECTED / 2 usage / 1 IO. Exactly the offline-recompute posture of `vh verify-seal`/`verify-proof`.
// ---------------------------------------------------------------------------

function parseVerifyArgs(argv) {
  const opts = { packet: undefined, dir: undefined, json: false, _positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dir": {
        const v = argv[++i];
        if (v === undefined) {
          const e = new Error("--dir requires a value");
          e.usage = true;
          throw e;
        }
        opts.dir = v;
        break;
      }
      case "--json":
        opts.json = true;
        break;
      default:
        if (a && a.startsWith("--")) {
          const e = new Error(`unknown flag: ${a}`);
          e.usage = true;
          throw e;
        }
        opts._positionals.push(a);
    }
  }
  if (opts._positionals.length > 1) {
    const e = new Error(
      `unexpected extra argument: ${opts._positionals[1]} (evidence verify takes exactly one <packet>)`
    );
    e.usage = true;
    throw e;
  }
  opts.packet = opts._positionals[0];
  return opts;
}

// Render the human verify report. PURE.
function renderVerify(result, ctx) {
  const L = [];
  L.push(EVIDENCE_TRUST_NOTE);
  L.push("");
  L.push(`# vh evidence verify — ${ctx.packet}`);
  L.push(`sealed root:     ${result.sealedRoot}`);
  L.push(`recomputed root: ${result.recomputedRoot || "(none)"}`);
  L.push(`root matches:    ${result.rootMatches ? "yes" : "NO"}`);
  L.push(
    `files: ${result.counts.matched} matched, ${result.counts.changed} changed, ` +
      `${result.counts.missing} missing, ${result.counts.unexpected} unexpected`
  );
  // SIGNATURE section — only for a SIGNED packet. `verify` re-derives the content root; it does NOT pin the
  // signer (that is `verify-signed --signer`). But it MUST NOT report a CLAIMED signer as if trusted: it
  // recovers the signer from the bytes + signature and either REJECTS a forged signature or labels a
  // genuine one UNVERIFIED-for-pinning, pointing at `verify-signed`. (T-47.2 — close the silent claim.)
  const sig = ctx.sig;
  if (sig) {
    L.push("");
    if (sig.signatureMatchesSigner) {
      L.push(`signature:       UNVERIFIED — claimed signer ${sig.claimedSigner} is GENUINE (the signature`);
      L.push("                 recovers to it), but this command does NOT pin the signer to anyone you trust.");
      L.push(`                 Run \`vh evidence verify-signed ${ctx.packet} --signer <0xaddr>\` to PIN the signer`);
      L.push("                 (and --dir to bind the signature to YOUR bytes).");
    } else {
      L.push(`signature:       FORGED — REJECTED. The container CLAIMS signer ${sig.claimedSigner} but the`);
      L.push(`                 signature actually recovers to ${sig.recoveredSigner}. The \`signer\` label is`);
      L.push("                 UNBACKED. Run `vh evidence verify-signed` for the full per-check verdict.");
    }
  }
  L.push("");
  if (result.accepted && !(sig && !sig.signatureMatchesSigner)) {
    L.push("OK — every sealed file re-derives byte-for-byte and the root matches.");
    if (sig) {
      L.push("    (The content matches; the signature is GENUINE but UNVERIFIED-for-pinning — see above.)");
    }
  } else {
    L.push("REJECTED — the files do NOT match the packet:");
    for (const c of result.changed) {
      L.push(`  CHANGED    ${c.relPath}: sealed ${c.expectedContentHash} != on-disk ${c.actualContentHash}`);
    }
    for (const m of result.missing) {
      L.push(`  MISSING    ${m.relPath}: sealed but not found on disk`);
    }
    for (const u of result.unexpected) {
      L.push(`  UNEXPECTED ${u.relPath}: on disk but not named in the packet`);
    }
    if (
      !result.rootMatches &&
      result.changed.length === 0 &&
      result.missing.length === 0 &&
      result.unexpected.length === 0
    ) {
      L.push("  ROOT       the recomputed root does not equal the sealed root");
    }
    if (sig && !sig.signatureMatchesSigner) {
      L.push("  SIGNATURE  the signature is FORGED (recovers to a different address than claimed)");
    }
  }
  L.push("");
  return L.join("\n");
}

// Read a packet that may be a BARE seal OR a signed-seal container. Returns { seal, signed, container }.
// For a signed container it returns the validated CONTAINER (so `verify` can run the signature check —
// `validateSignedSeal` proves the bytes are CANONICAL but NOT that the signature recovers to the claimed
// `signer`, so the recovery must happen at the call site, never here). It does NOT return a `signer` field:
// the CLAIMED signer is not trustworthy until the signature is recovered (T-47.2 — close the silent claim).
function readPacket(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new packetseal.PacketSealError(`evidence packet is not valid JSON: ${e.message}`);
  }
  if (obj && obj.kind === SIGNED_SEAL_KIND) {
    validateSignedSeal(obj); // strict; rejects a tampered/foreign signed container (but NOT a forged sig)
    const seal = readSeal(obj.attestation); // the embedded canonical seal bytes
    return { seal, signed: true, container: obj };
  }
  return { seal: readSeal(obj), signed: false, container: null };
}

function runEvidenceVerify(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.packet) {
    writeErr("error: `vh evidence verify` requires a <packet>\n");
    return EXIT.USAGE;
  }

  // Load + STRICT-validate the packet BEFORE any referenced file is read — a malformed/missing packet
  // hard-errors (exit 1), never half-accepted nor treated as "everything changed".
  const packetPath = path.resolve(opts.packet);
  let text;
  try {
    text = fs.readFileSync(packetPath, "utf8");
  } catch (e) {
    writeErr(`error: cannot read evidence packet ${opts.packet}: ${e.message}\n`);
    return EXIT.IO;
  }
  let parsed;
  try {
    parsed = readPacket(text);
  } catch (e) {
    writeErr(`error: invalid evidence packet ${opts.packet}: ${e.message}\n`);
    return EXIT.IO;
  }
  const seal = parsed.seal;

  // Resolve referenced files relative to --dir (if given) else the packet file's own directory. A file
  // the packet NAMES but that is absent must NOT abort — it is a MISSING finding verify localizes.
  const baseDir = opts.dir != null ? path.resolve(opts.dir) : path.dirname(packetPath);
  const entries = [];
  for (const f of seal.files) {
    const abs = path.resolve(baseDir, f.relPath);
    let bytes;
    try {
      bytes = fs.readFileSync(abs);
    } catch (_) {
      continue; // absent -> verifySeal reports MISSING
    }
    entries.push({ relPath: f.relPath, bytes });
  }

  let result;
  try {
    result = verifySeal(seal, entries);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }

  // CLOSE THE SILENT CLAIM (T-47.2). For a SIGNED packet, `validateSignedSeal` proved the bytes are
  // canonical but NOT that the signature recovers to the CLAIMED `signer`. So we recover the signer here
  // (Check 1 of the verify-signed verdict, ALWAYS run, key-free/offline) and HONESTLY report it:
  //   * a FORGED signature (recovers to a DIFFERENT address than claimed) is a clean REJECTED — never a
  //     silent pass that reports the claimed signer as if trusted;
  //   * a GENUINE signature is labelled UNVERIFIED-for-pinning (the signer is real but NOT pinned to anyone
  //     the caller trusts) and points at `vh evidence verify-signed` for the full pin/bind verdict.
  // `verify` never PINS the signer (no --signer here) — pinning + binding is the `verify-signed` command.
  let sig = null;
  if (parsed.signed) {
    const sv = verifySignedSeal({ container: parsed.container }); // recovers signer; no pin, no binding
    sig = {
      signed: true,
      signatureMatchesSigner: sv.checks.signatureMatchesSigner,
      recoveredSigner: sv.recoveredSigner,
      claimedSigner: sv.claimedSigner,
      scheme: sv.scheme,
    };
  }

  // A forged signature flips the overall verdict to REJECTED even when the content matches: the packet's
  // own `signer` label is unbacked, so the artifact as a whole must NOT report OK. Content failures still
  // reject as before; the two are independent and either alone is sufficient to REJECT.
  const accepted = result.accepted && !(sig && !sig.signatureMatchesSigner);
  const code = accepted ? EXIT.OK : EXIT.FAIL;
  if (opts.json) {
    write(
      JSON.stringify(
        {
          ...result,
          // Overall accepted/verdict accounts for BOTH content re-derivation AND (for a signed packet) the
          // signature-recovers-to-claimed-signer check. `contentVerdict`/`contentAccepted` preserve the
          // pure seal-content result a machine reader may still want separately.
          accepted,
          verdict: accepted ? "ACCEPTED" : "REJECTED",
          contentAccepted: result.accepted,
          contentVerdict: result.verdict,
          packet: opts.packet,
          dir: baseDir,
          signed: parsed.signed,
          // The recovered + claimed signer + whether the signature is GENUINE; null for an unsigned packet.
          // We NEVER expose a bare `signer` that conflates "claimed" with "trusted" (T-47.2).
          signature: sig
            ? {
                signatureMatchesSigner: sig.signatureMatchesSigner,
                recoveredSigner: sig.recoveredSigner,
                claimedSigner: sig.claimedSigner,
                scheme: sig.scheme,
                // The signer is GENUINE-but-UNVERIFIED-for-pinning here; verify-signed pins/binds it.
                pinned: false,
                hint: "run `vh evidence verify-signed <packet> --signer <addr> [--dir <d>]` to pin + bind",
              }
            : null,
          note: EVIDENCE_TRUST_NOTE,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(renderVerify(result, { packet: opts.packet, sig }));
  }
  return code;
}

// ---------------------------------------------------------------------------
// `vh evidence verify-signed <signed> [--dir <d>] [--signer <addr>] [--json]` — the OFFLINE, key-free,
// network-free signed-verify CLI over the PURE `verifySignedSealAttestation` core (T-47.1). It is the
// command that ACTUALLY CHECKS a signed packet's signature (the closing of the silent claim `vh evidence
// verify` leaves open): it recovers the signer from the embedded canonical bytes + signature (Check 1,
// ALWAYS), OPTIONALLY pins it to an expected `--signer` (Check 2), and OPTIONALLY binds it to the holder's
// OWN `--dir` bytes (Check 3). Leads with the trust caveat; prints per-check PASS/FAIL/skip. The verdict is
// ACCEPTED only when EVERY REQUESTED check passes; a forged/mismatched/tampered/wrong-key signature is a
// clean REJECTED — NEVER a silent pass. Writes NOTHING (the --dir read is the only I/O). Exit: 0 ACCEPTED /
// 3 REJECTED / 2 usage / 1 IO (mirrors `vh dataset verify-attest`).
// ---------------------------------------------------------------------------

function parseVerifySignedArgs(argv) {
  const opts = {
    signed: undefined,
    dir: undefined,
    signer: undefined,
    revocations: undefined,
    asOf: undefined,
    strict: false,
    json: false,
    _positionals: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (flag) => {
      const v = argv[++i];
      if (v === undefined) {
        const e = new Error(`${flag} requires a value`);
        e.usage = true;
        throw e;
      }
      return v;
    };
    switch (a) {
      case "--dir":
        opts.dir = need("--dir");
        break;
      case "--signer":
        opts.signer = need("--signer");
        break;
      case "--revocations":
        opts.revocations = need("--revocations");
        break;
      case "--as-of":
        opts.asOf = need("--as-of");
        break;
      case "--strict":
        // FAIL-CLOSED pinning (T-75.2): exit 0 then means ACCEPT-AND-PINNED — an otherwise-ACCEPTED
        // packet with NO --signer pin becomes the distinct UNPINNED verdict (exit 4), so a CI gate
        // cannot silently accept an attacker-self-signed packet.
        opts.strict = true;
        break;
      case "--json":
        opts.json = true;
        break;
      default:
        if (a && a.startsWith("--")) {
          const e = new Error(`unknown flag: ${a}`);
          e.usage = true;
          throw e;
        }
        opts._positionals.push(a);
    }
  }
  if (opts._positionals.length > 1) {
    const e = new Error(
      `unexpected extra argument: ${opts._positionals[1]} (evidence verify-signed takes exactly one <signed>)`
    );
    e.usage = true;
    throw e;
  }
  opts.signed = opts._positionals[0];
  return opts;
}

// Render the human verify-signed report. PURE. LEADS with the signing trust caveat (the SAME standing note
// the dataset sibling leads with — reuses EVIDENCE_TRUST_NOTE verbatim so the caveats never drift), then the
// verdict, the recovered/claimed/expected signer, and each requested check with PASS/FAIL (or [skip] when an
// optional check was not requested). A REJECTED verdict NAMES which check(s) failed.
function renderVerifySigned(r, ctx) {
  const L = [];
  // TRUST caveat FIRST: a valid signature proves WHO vouched, NOT a timestamp (P-3), NOT a legal opinion.
  L.push("TRUST: " + VERIFY_SIGNED_SEAL_TRUST_NOTE);
  L.push("");
  L.push(`# vh evidence verify-signed — ${ctx.signed}`);
  L.push(`verify-signed:    ${r.verdict}`);
  L.push(`scheme:           ${r.scheme}`);
  L.push(`recovered signer: ${r.recoveredSigner}  (from the embedded canonical seal bytes + signature)`);
  L.push(`claimed signer:   ${r.claimedSigner}  (the container's \`signer\` field)`);
  // Check 1 (ALWAYS): the signature recovers to the claimed signer.
  L.push(
    `  [${r.checks.signatureMatchesSigner ? "PASS" : "FAIL"}] signature recovers to the claimed signer`
  );
  // Check 2 (only under --signer): the recovered signer equals the expected signer.
  if (r.checks.signerMatchesExpected === null) {
    L.push("  [skip] expected-signer pin: not requested (pass --signer <0xaddr> to pin the signer)");
    // T-75.2: an unpinned signer must never read as trusted provenance — say so IN the verdict body.
    L.push(
      `         UNPINNED: signed by ${r.recoveredSigner} — NOT pinned to a trusted vendor; anyone's key`
    );
    L.push(
      "         passes. Pin the publisher you trust (--signer, obtained out-of-band); --strict fails closed."
    );
  } else {
    L.push(
      `  [${r.checks.signerMatchesExpected ? "PASS" : "FAIL"}] recovered signer matches the expected ` +
        `signer (${r.expectedSigner})`
    );
  }
  // Check 3 (only under --dir): the signature binds the holder's OWN directory bytes.
  if (r.checks.manifestBindsAttestation === null) {
    L.push(
      "  [skip] directory binding: not requested (pass --dir <d> to bind the signature to YOUR bytes)"
    );
  } else {
    L.push(
      `  [${r.checks.manifestBindsAttestation ? "PASS" : "FAIL"}] the signature binds YOUR directory ` +
        "(its canonical seal bytes are byte-identical to the signed payload)"
    );
  }
  if (r.accepted) {
    L.push("ACCEPTED: every requested check passed.");
    if (r.pinning === "unpinned") {
      L.push(
        `  NOTE — UNPINNED: no --signer pin was requested, so this ACCEPT only proves ${r.recoveredSigner}`
      );
      L.push("  signed these bytes — NOT that a publisher you trust did (anyone's key passes unpinned).");
    }
  } else if (r.verdict === "UNPINNED") {
    // --strict fail-closed (T-75.2): every requested check passed, but nobody pinned the signer.
    L.push(`UNPINNED (--strict, exit ${EXIT.UNPINNED}): every requested check passed, but NO --signer pin was requested.`);
    L.push(`  signed by ${r.recoveredSigner} — NOT pinned to a trusted vendor; anyone's key passes.`);
    L.push("  Pin the publisher you trust: re-run with --signer <0xaddr> (obtained out-of-band).");
  } else {
    L.push(`REJECTED: failed check(s): ${r.failedChecks.join(", ")}.`);
    if (r.failedChecks.includes("signatureMatchesSigner")) {
      L.push(
        "  forged-signature: the signature does NOT recover to the claimed `signer` — the signer label is"
      );
      L.push("  UNBACKED (a forged/tampered/wrong-key signature), NOT a packet you can trust.");
    }
    if (r.failedChecks.includes("manifestBindsAttestation")) {
      L.push(
        "  binding-mismatch: the signed payload does NOT match YOUR directory — the signature vouches for a"
      );
      L.push("  DIFFERENT file set than the one you hold.");
    }
  }
  L.push("");
  return L.join("\n");
}

// Shared up-front shape validation for the OPTIONAL recipient-side trust-decision flags (--revocations /
// --as-of, T-51.2). Returns null when fine, else a usage-error message. A malformed --as-of is a usage error
// (never a runtime throw mid-verify); --as-of without --revocations is a usage error (it would silently do
// nothing). Mirrors the trust-asof core's canonical-instant grammar.
function validateAsOfFlags(opts) {
  if (opts.asOf !== undefined && !opts.revocations) {
    return "--as-of requires --revocations (it pins the instant the revocation decision is made AS OF)";
  }
  if (opts.asOf !== undefined) {
    const re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
    const ms = Date.parse(opts.asOf);
    if (
      typeof opts.asOf !== "string" ||
      !re.test(opts.asOf) ||
      Number.isNaN(ms) ||
      new Date(ms).toISOString() !== opts.asOf
    ) {
      return `invalid --as-of: ${opts.asOf} (expected a canonical ISO-8601 UTC instant, e.g. 2026-06-01T00:00:00.000Z)`;
    }
  }
  return null;
}

function runEvidenceVerifySigned(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.signed) {
    writeErr("error: `vh evidence verify-signed` requires a <signed> (signed evidence packet path)\n");
    return EXIT.USAGE;
  }

  // Validate the --signer address SHAPE up front (when given) so a malformed expected signer is a usage
  // error (2), never a runtime throw mid-verify. PURELY OFFLINE — no network here either.
  if (opts.signer !== undefined && opts.signer !== null) {
    let isAddress;
    try {
      ({ isAddress } = require("ethers"));
    } catch (_) {
      isAddress = null;
    }
    if (isAddress && !isAddress(opts.signer)) {
      writeErr(
        `error: invalid --signer address: ${opts.signer} (expected a 20-byte 0x-hex address)\n`
      );
      return EXIT.USAGE;
    }
  }

  // Validate the OPTIONAL trust-decision flags (--revocations/--as-of, T-51.2) SHAPE up front so a malformed
  // --as-of (or --as-of without --revocations) is a usage error (2), never a runtime throw mid-verify.
  {
    const asOfErr = validateAsOfFlags(opts);
    if (asOfErr) {
      writeErr(`error: ${asOfErr}\n`);
      return EXIT.USAGE;
    }
  }

  // Read + STRICT-validate the signed container BEFORE any recovery — a malformed/edited/foreign container
  // (or a BARE unsigned seal handed here) hard-errors (exit 1), never half-accepted. A forged signature is
  // NOT a parse error: validateSignedSeal proves the bytes are canonical; the recovery (the verdict) runs
  // below in the PURE core.
  let container;
  try {
    const text = fs.readFileSync(path.resolve(opts.signed), "utf8");
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw new packetseal.PacketSealError(`signed evidence packet is not valid JSON: ${e.message}`);
    }
    if (!obj || obj.kind !== SIGNED_SEAL_KIND) {
      throw new packetseal.PacketSealError(
        `not a signed evidence packet (kind ${JSON.stringify(obj && obj.kind)}; expected ` +
          `${JSON.stringify(SIGNED_SEAL_KIND)}). \`verify-signed\` checks a SIGNED packet; for a bare seal ` +
          "use `vh evidence verify`."
      );
    }
    container = validateSignedSeal(obj); // strict; rejects a tampered/foreign signed container
  } catch (e) {
    writeErr(`error: cannot read signed evidence packet ${opts.signed}: ${e.message}\n`);
    return EXIT.IO;
  }

  // Run the PURE, OFFLINE verify. The ONLY I/O is the optional --dir read (inside the core), and only when
  // binding is requested. An unreadable --dir is a genuine IO error (1), never a silently-skipped binding.
  let result;
  try {
    result = verifySignedSealAttestation({
      container,
      expectedSigner: opts.signer,
      dir: opts.dir,
    });
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }

  // OPTIONAL recipient-side TRUST-DECISION-AS-OF (EPIC-51 / T-51.2). Runs ONLY under --revocations — with no
  // flag the result is byte-identical to the pre-EPIC baseline. A key revoked-before-as-of downgrades an
  // otherwise-ACCEPTED packet to REVOKED (exit 3); a later-dated revocation is informational; a forged one is
  // ignored with a warning. OFFLINE / key-free on the read side. The revocations file is the ONLY new I/O.
  let defaulted = false;
  if (opts.revocations) {
    try {
      const applied = coreTrustAsOf.loadAndApply({
        result,
        revocationsPath: opts.revocations,
        asOf: opts.asOf,
        nowISO: io.nowISO || new Date().toISOString(),
        readFile: (p) => fs.readFileSync(path.resolve(p), "utf8"),
      });
      result = applied.result;
      defaulted = applied.defaulted;
    } catch (e) {
      writeErr(`error: cannot evaluate --revocations ${opts.revocations}: ${e.message}\n`);
      return EXIT.IO;
    }
  }

  // PINNING TRANSPARENCY + FAIL-CLOSED --strict (T-75.2). Every verdict states whether the recovered
  // signer was actually PINNED to a caller-trusted key: without --signer, a genuine signature only
  // proves SOME key signed (an attacker re-signing with their OWN key passes the identical check), so
  // the human AND JSON verdicts say UNPINNED explicitly, and --strict turns an unpinned accept into
  // the distinct non-zero EXIT.UNPINNED (4). A pinned accept stays exit 0; REJECTED/REVOKED stays 3.
  const pinRequested = opts.signer !== undefined && opts.signer !== null;
  if (pinRequested) {
    result.pinning = result.checks.signerMatchesExpected === true ? "pinned" : "pin_failed";
  } else {
    result.pinning = "unpinned";
    if (result.accepted) {
      result.unpinnedNote =
        `UNPINNED: signed by ${result.recoveredSigner} — NOT pinned to a trusted vendor; anyone's ` +
        "key passes. Pin the publisher you trust with --signer <0xaddr> (obtained out-of-band); " +
        "--strict makes an unpinned accept a distinct non-zero exit.";
    }
  }
  if (opts.strict) {
    result.strict = true;
    if (result.accepted && result.pinning !== "pinned") {
      result.accepted = false;
      result.verdict = "UNPINNED";
    }
  }

  if (opts.json) {
    write(
      JSON.stringify(
        {
          ...result,
          signed: opts.signed,
          dir: opts.dir != null ? path.resolve(opts.dir) : null,
          note: VERIFY_SIGNED_SEAL_TRUST_NOTE,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    let out = renderVerifySigned(result, { signed: opts.signed });
    if (result.trustAsOf) {
      out += coreTrustAsOf.renderTrustAsOf(result.trustAsOf, { defaulted }).join("\n") + "\n";
    }
    write(out);
  }

  // Exit non-zero on REJECTED/REVOKED so a buyer's CI can gate (mirrors the family's 0 ACCEPTED / 3
  // not-OK); UNPINNED under --strict is its own fail-closed code (4), distinct from a REJECT.
  if (result.verdict === "UNPINNED") return EXIT.UNPINNED;
  return result.accepted ? EXIT.OK : EXIT.FAIL;
}

// ---------------------------------------------------------------------------
// `vh evidence diff <packetA> <packetB> [--json]` — read-only, FREE, key-free, OFFLINE change report
// between TWO already-sealed evidence packets. The CLI surface over the PURE `diffEvidenceSeals` core
// (T-46.1). It re-derives NOTHING from bytes (there is no directory) — it compares what each packet
// CLAIMS — and writes NOTHING (a diff produces no sealed artifact, so it needs NO license and never
// gates). A is the BASELINE ("recorded"), B is the COMPARISON ("current"): ADDED = in B not A,
// REMOVED = in A not B, CHANGED = same relPath/different content (old→new); a rename surfaces as
// REMOVED+ADDED. The verdict (and exit code + headline) is the CHANGE SET (`identical`), NOT root-string
// equality. Exit: 0 IDENTICAL / 3 DIFFERENT / 2 usage / 1 IO (mirrors `vh dataset diff`).
// ---------------------------------------------------------------------------

function parseDiffArgs(argv) {
  const opts = {
    packetA: undefined,
    packetB: undefined,
    policy: undefined,
    json: false,
    _positionals: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--policy": {
        const v = argv[++i];
        if (v === undefined || (typeof v === "string" && v.startsWith("--"))) {
          const e = new Error("--policy requires a <file> argument");
          e.usage = true;
          throw e;
        }
        opts.policy = v;
        break;
      }
      default:
        if (a && a.startsWith("--")) {
          const e = new Error(`unknown flag: ${a}`);
          e.usage = true;
          throw e;
        }
        opts._positionals.push(a);
    }
  }
  if (opts._positionals.length > 2) {
    const e = new Error(
      `unexpected extra argument: ${opts._positionals[2]} (evidence diff takes exactly two <packet>s)`
    );
    e.usage = true;
    throw e;
  }
  opts.packetA = opts._positionals[0];
  opts.packetB = opts._positionals[1];
  return opts;
}

// Render the human diff report. PURE. LEADS with the CLAIMS-not-content TRUST line (a diff compares what
// each packet CLAIMS — it does NOT re-derive content), prints a deterministic IDENTICAL/DIFFERENT
// headline, the per-file ADDED/REMOVED/CHANGED block, and a count line driven by the change set. The
// headline is driven by `result.identical` — the CHANGE SET, not root-string equality — so it can never
// contradict the per-file body or the exit code. The two recorded roots are DISPLAYED metadata only.
function renderDiff(result, ctx) {
  const L = [];
  // TRUST FIRST: a diff compares what each packet CLAIMS; it does not re-derive content (no directory).
  L.push(
    "TRUST: this compares what each evidence packet CLAIMS — it does NOT re-derive content (there is " +
      "no directory). " +
      EVIDENCE_TRUST_NOTE
  );
  L.push("       (run `vh evidence verify <packet> --dir <d>` against the live tree to re-derive a root from bytes).");
  L.push("");
  L.push(`# vh evidence diff — ${ctx.packetA} -> ${ctx.packetB}`);
  L.push(`packet A root: ${result.rootA}`);
  L.push(`packet B root: ${result.rootB}`);
  if (result.identical) {
    L.push(
      "files: IDENTICAL — the two packets commit to the SAME set of (relPath, content) pairs " +
        "(no ADDED / REMOVED / CHANGED)."
    );
    L.push(`+0 / -0 / ~0 / ${result.counts.unchanged} unchanged`);
    // In the evidence product readSeal RE-DERIVES the root over the leaves, so a structurally-valid pair
    // can NEVER reach here with mismatched roots but identical leaves — a tampered root is rejected
    // outright before the diff. The roots therefore always agree with the change set on this path; we
    // surface no "hand-edited root" note (unlike the dataset diff) because that state is unreachable.
    for (const line of _renderDriftSection(ctx.drift)) L.push(line);
    L.push("");
    return L.join("\n");
  }
  L.push(
    "files: DIFFERENT — the packets commit to different (relPath, content) sets. Per-file changes (A->B). " +
      "A rename surfaces as REMOVED(old path) + ADDED(new path) — the path is bound into the leaf — " +
      "NOT as two unrelated edits."
  );
  L.push(
    `+${result.counts.added} / -${result.counts.removed} / ~${result.counts.changed} / ` +
      `${result.counts.unchanged} unchanged`
  );
  for (const c of result.changed) {
    L.push(`  CHANGED  ${c.path}`);
    L.push(`             old: ${c.oldContentHash}`);
    L.push(`             new: ${c.newContentHash}`);
  }
  for (const a of result.added) {
    L.push(`  ADDED    ${a.path}  (${a.contentHash})   in B, not in A`);
  }
  for (const rm of result.removed) {
    L.push(`  REMOVED  ${rm.path}  (${rm.contentHash})   in A, not in B`);
  }
  for (const line of _renderDriftSection(ctx.drift)) L.push(line);
  L.push("");
  return L.join("\n");
}

// Render the OPTIONAL drift-policy section (printed only when `--policy` was given). LEADS with the
// SAME UNTRUSTED-change-set caveat the gate carries, states the PASS/FAIL verdict + rules evaluated, and
// lists each violation (relPath, the rule it broke, and which change KIND triggered it). The verdict can
// never disagree with the diff above: it is computed from the SAME change set (evaluateDriftPolicy reads
// `diff.added/removed/changed` directly). Returns [] when no policy was evaluated.
function _renderDriftSection(drift) {
  if (!drift) return [];
  const L = ["", "## drift policy"];
  L.push(
    "  TRUST: a drift verdict gates the CHANGE SET above (what each packet CLAIMS) — it does NOT " +
      "re-derive content."
  );
  L.push(`  verdict: ${drift.verdict}  (rules evaluated: ${drift.rulesEvaluated})`);
  if (drift.rulesEvaluated === 0) {
    L.push("  This policy declares NO rules, so it trivially PASSes — any change satisfies it.");
    return L;
  }
  if (drift.verdict === DRIFT_VERDICT.PASS) {
    L.push("  PASS — every change between A and B is permitted by this policy.");
    return L;
  }
  L.push(`  FAIL — ${drift.violations.length} disallowed change(s):`);
  for (const v of drift.violations) {
    L.push(`    ${v.change.padEnd(7)} ${v.relPath}  [${v.rule}]`);
  }
  return L;
}

function runEvidenceDiff(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  if (!opts.packetA || !opts.packetB) {
    writeErr("error: `vh evidence diff` requires exactly two packet paths <packetA> <packetB>\n");
    return EXIT.USAGE;
  }

  // Read BOTH packet files (the only I/O — a diff writes NOTHING). A missing/unreadable file is an IO
  // error (exit 1). We pass the raw bytes through the strict diff core, which re-validates structure +
  // root re-derivation and REJECTS a corrupt/foreign/wrong-kind/hand-edited packet before any diff.
  let textA;
  try {
    textA = fs.readFileSync(path.resolve(opts.packetA), "utf8");
  } catch (e) {
    writeErr(`error: cannot read evidence packet ${opts.packetA}: ${e.message}\n`);
    return EXIT.IO;
  }
  let textB;
  try {
    textB = fs.readFileSync(path.resolve(opts.packetB), "utf8");
  } catch (e) {
    writeErr(`error: cannot read evidence packet ${opts.packetB}: ${e.message}\n`);
    return EXIT.IO;
  }

  let result;
  try {
    result = diffEvidenceSeals(textA, textB);
  } catch (e) {
    // A corrupt/foreign/wrong-kind/hand-edited packet (PacketSealError from readSeal) is a runtime/IO
    // error (exit 1), never a half-accepted diff — exactly like `vh dataset diff`'s corrupt-manifest path.
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }

  // OPTIONAL drift gate: when `--policy <f>` was given, read it strictly (a corrupt/foreign policy is an
  // IO error, never half-accepted) and evaluate the SAME change set against it. The policy verdict is
  // computed from `result` directly (no re-diff), so it can never disagree with the printed/JSON diff.
  let drift = null;
  if (opts.policy) {
    let policy;
    try {
      policy = readDriftPolicy(path.resolve(opts.policy));
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return EXIT.IO;
    }
    drift = evaluateDriftPolicy({ diff: result, policy });
  }

  if (opts.json) {
    write(
      JSON.stringify(
        {
          identical: result.identical,
          rootA: result.rootA,
          rootB: result.rootB,
          rootsIdentical: result.rootsIdentical,
          added: result.added,
          removed: result.removed,
          changed: result.changed,
          unchanged: result.unchanged,
          counts: result.counts,
          packetA: opts.packetA,
          packetB: opts.packetB,
          // The drift verdict (only when --policy was given) rides alongside the change set, so a CI
          // consumer reads the verdict, the rule count, and the exact violations from the SAME object.
          drift: drift
            ? {
                verdict: drift.verdict,
                rulesEvaluated: drift.rulesEvaluated,
                violations: drift.violations,
              }
            : null,
          note: DRIFT_TRUST_NOTE,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(renderDiff(result, { packetA: opts.packetA, packetB: opts.packetB, drift }));
  }

  // EXIT CODE. Without --policy: exit non-zero when the packets DIFFER (mirrors the family's
  // MISMATCH/DIFFERENT). WITH --policy: the gate is the POLICY verdict — a buyer who passes a drift policy
  // is asking "is this change ALLOWED?", so a DIFFERENT-but-PERMITTED change is a PASS (exit 0) and a
  // disallowed change is a FAIL (exit 3). Either way the verdict is derived from the SAME change set, so
  // the exit code can never disagree with the printed/JSON body.
  if (drift) {
    return drift.verdict === DRIFT_VERDICT.PASS ? EXIT.OK : EXIT.FAIL;
  }
  return result.identical ? EXIT.OK : EXIT.FAIL;
}

// ---------------------------------------------------------------------------
// `vh evidence license fulfill --plan <id> --customer <name> [--paid-through <ISO>]
//    [--catalog <file>] (--key-env <VAR> | --key-file <path>) [--issued <ISO>]
//    [--license-id <id>] [--out <file>] [--json]` (T-48.2).
//
// The self-serve EVIDENCE fulfillment seam — the evidence-vertical MIRROR of
// `vh trust license fulfill`. Given the planId a customer bought (+ their name, and
// when the period is paid through), it resolves the plan against the bundled-or-
// `--catalog` VALIDATED evidence plan catalog, copies that plan's entitlements
// VERBATIM (never hand-typed here, so a typo can never mis-entitle a sale), derives
// the [issuedAt, expiresAt] window, and mints the SAME signed `*.vhevidence-license.json`
// the existing `verifyLicense` gate already accepts — so an evidence sale is ONE
// command per billing webhook, not a human hand-crafting a license at a terminal.
//
// The catalog is the BUNDLED DRAFT by default (the seller's reviewed price-list,
// shipped as a skeleton the human prices — the loop sets NO price), or an explicit
// `--catalog <file>`. The key is read the EXACT read-used-discarded way `vh evidence
// seal --sign` reads it (coreAttestation.loadSigningWallet: EXACTLY ONE of
// --key-env/--key-file; the loop NEVER holds the key, NEVER echoes it). Exit mirrors
// the family: 0 ok / 3 gate-fail / 2 usage / 1 IO.
// ---------------------------------------------------------------------------

// The bundled DRAFT evidence plan catalog `fulfill` resolves a plan against when no
// --catalog is given. Read from THIS package's own fixtures dir — never a caller
// path — so the default resolution is deterministic and self-contained.
const BUNDLED_EVIDENCE_CATALOG = path.join(
  __dirname,
  "core",
  "fixtures",
  "evidence-plans",
  "baseline.json"
);

// Real "now" as a canonical ISO-8601 UTC instant — the fulfill default clock,
// isolated + injectable (io.nowISO) so the command stays deterministic under test.
function nowISO() {
  return new Date().toISOString();
}

// Parse `license fulfill` argv. EXACTLY-ONE-of key sources is enforced downstream by
// loadSigningWallet (so neither/both error key-free); the parser only collects flags.
function parseLicenseFulfillArgs(argv) {
  const opts = {
    plan: undefined, // a planId in the catalog
    customer: undefined,
    paidThrough: undefined, // OPTIONAL ISO instant; default = issuedAt + plan term
    issued: undefined, // OPTIONAL ISO instant; default "now" supplied by the command
    licenseId: undefined, // OPTIONAL; defaulted deterministically by fulfillEvidenceOrder
    catalog: undefined, // OPTIONAL path to a plan catalog JSON; default = bundled baseline
    keyEnv: undefined,
    keyFile: undefined,
    out: undefined,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v === undefined || String(v).startsWith("--")) {
        const e = new Error(`${a} requires a value`);
        e.usage = true;
        throw e;
      }
      return v;
    };
    switch (a) {
      case "--plan": opts.plan = need(); break;
      case "--customer": opts.customer = need(); break;
      case "--paid-through": opts.paidThrough = need(); break;
      case "--issued": opts.issued = need(); break;
      case "--license-id": opts.licenseId = need(); break;
      case "--catalog": opts.catalog = need(); break;
      case "--key-env": opts.keyEnv = need(); break;
      case "--key-file": opts.keyFile = need(); break;
      case "--out": opts.out = need(); break;
      case "--json": opts.json = true; break;
      default: {
        const e = new Error(`unknown flag: ${a}`);
        e.usage = true;
        throw e;
      }
    }
  }
  return opts;
}

async function runEvidenceLicenseFulfill(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  // Required order fields (the key sources are validated by loadSigningWallet; the
  // plan is resolved against the catalog by fulfillEvidenceOrder).
  for (const [flag, val] of [
    ["--plan", opts.plan],
    ["--customer", opts.customer],
  ]) {
    if (val == null) {
      writeErr(`error: \`vh evidence license fulfill\` requires ${flag}\n`);
      return EXIT.USAGE;
    }
  }

  // The order -> license-params catalog core. Required lazily (NOT at module load) to
  // avoid the require cycle: cli/core/evidence-plans.js requires THIS module's
  // LICENSE_CFG at its own module-eval time.
  const evidencePlans = require("./core/evidence-plans");

  // Load + strictly validate the plan catalog (bundled DRAFT baseline by default). A
  // malformed/unreadable catalog is a usage error (a bad data file, not an IO crash).
  const catalogPath =
    opts.catalog != null ? path.resolve(opts.catalog) : BUNDLED_EVIDENCE_CATALOG;
  let catalog;
  try {
    const text = fs.readFileSync(catalogPath, "utf8");
    catalog = evidencePlans.validateEvidencePlanCatalog(JSON.parse(text));
  } catch (e) {
    writeErr(`error: cannot load evidence plan catalog ${catalogPath}: ${e.message}\n`);
    return EXIT.USAGE;
  }

  // Resolve the HUMAN-supplied key into an in-process Wallet FIRST, BEFORE building
  // anything — neither/both sources, a missing env var, an unreadable file, or a
  // malformed/zero key hard-errors here with a KEY-FREE message (the SAME core +
  // posture as `vh evidence seal --sign`). The loop never holds a key.
  let wallet;
  try {
    ({ wallet } = coreAttestation.loadSigningWallet({
      keyEnv: opts.keyEnv,
      keyFile: opts.keyFile,
    }));
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  // issuedAt defaults to the injectable clock (a real ISO instant at runtime; a pinned
  // one in tests). The order -> license-params mapping is PURE + deterministic.
  const issuedAt = opts.issued != null ? opts.issued : (io.nowISO || nowISO)();
  let params;
  try {
    params = evidencePlans.fulfillEvidenceOrder(
      {
        plan: opts.plan,
        customer: opts.customer,
        issuedAt,
        paidThrough: opts.paidThrough != null ? opts.paidThrough : undefined,
        licenseId: opts.licenseId != null && opts.licenseId !== "" ? opts.licenseId : undefined,
      },
      catalog
    );
  } catch (e) {
    // An unknown plan / paidThrough<=issuedAt / malformed date is a usage error —
    // NEVER echo the key (a mapping error carries only the bad order field).
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  // Sign the derived params into the SAME signed container `vh evidence seal --sign`'s
  // gate accepts — the existing verifyLicense gate accepts it byte-for-byte. No key
  // handling here; the key lives only inside `wallet`.
  let container;
  try {
    container = await buildLicense(params, wallet);
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  const canonical = serializeSignedLicense(container);
  // The PUBLIC vendor address — recovered from the signature, never the key.
  const vendor = coreAttestation.recoverSigner(container);
  const payload = JSON.parse(container.attestation);

  let outAbs = null;
  if (opts.out) {
    outAbs = path.resolve(opts.out);
    try {
      fs.writeFileSync(outAbs, canonical);
    } catch (e) {
      writeErr(`error: cannot write --out license file ${opts.out}: ${e.message}\n`);
      return EXIT.IO;
    }
  }

  if (opts.json) {
    // ONLY public fields: vendor ADDRESS, the license summary, the path — NEVER the
    // key. With no --out the canonical bytes ride in `container` (artifact parity).
    write(
      JSON.stringify(
        {
          fulfilled: true,
          vendor,
          licenseId: payload.licenseId,
          customer: payload.customer,
          plan: payload.plan,
          entitlements: payload.entitlements,
          issuedAt: payload.issuedAt,
          expiresAt: payload.expiresAt,
          out: outAbs,
          container: outAbs ? null : canonical,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write(`fulfilled evidence license for plan ${payload.plan} by vendor ${vendor}\n`);
    write(`  licenseId:    ${payload.licenseId}\n`);
    write(`  customer:     ${payload.customer}\n`);
    write(`  plan:         ${payload.plan}\n`);
    write(`  entitlements: ${payload.entitlements.join(", ")}\n`);
    write(`  issuedAt:     ${payload.issuedAt}\n`);
    write(`  expiresAt:    ${payload.expiresAt}\n`);
    if (outAbs) {
      write(`  written:      ${outAbs}\n`);
    } else {
      // No --out: emit the canonical signed bytes after the human header.
      write(canonical);
    }
  }
  return EXIT.OK;
}

// `vh evidence license <fulfill> ...` dispatcher. Mirrors `vh trust license` — a thin
// sub-dispatch so a future `issue`/`verify` can slot in without touching cmdEvidence.
async function cmdEvidenceLicense(argv, io = {}) {
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  const [sub, ...rest] = argv;
  if (sub === "fulfill") {
    let opts;
    try {
      opts = parseLicenseFulfillArgs(rest);
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return EXIT.USAGE;
    }
    return runEvidenceLicenseFulfill(opts, io);
  }
  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
    const usageStr =
      "vh evidence license — mint the signed evidence license the paid surfaces accept\n\n" +
      "Usage:\n" +
      "  vh evidence license fulfill --plan <id> --customer <name> [--paid-through <ISO>]\n" +
      "        [--catalog <file>] (--key-env <VAR> | --key-file <path>) [--issued <ISO>]\n" +
      "        [--license-id <id>] [--out <file>] [--json]\n\n" +
      "fulfill resolves <id> in the bundled DRAFT evidence plan catalog (or --catalog), copies\n" +
      "that plan's entitlements VERBATIM, derives the [issuedAt, expiresAt] window (--paid-through\n" +
      "wins, else issuedAt + the plan's term), and mints the signed *.vhevidence-license.json the\n" +
      "existing `verifyLicense` gate accepts (it UNLOCKS `vh evidence seal --sign`). The key is read\n" +
      "read-used-discarded (EXACTLY ONE of --key-env/--key-file); the loop sets NO price.\n" +
      "Exit: 0 ok / 3 gate-fail / 2 usage / 1 IO.\n";
    io.write ? io.write(usageStr) : process.stdout.write(usageStr);
    return sub === undefined ? EXIT.USAGE : EXIT.OK;
  }
  writeErr(`error: unknown evidence license subcommand: ${sub} (expected: fulfill)\n`);
  return EXIT.USAGE;
}

// ---------------------------------------------------------------------------
// CLI dispatch: `vh evidence <seal|verify|verify-signed|diff|license> ...`.
// ---------------------------------------------------------------------------

async function cmdEvidence(argv, io = {}) {
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  const [sub, ...rest] = argv;
  if (sub === "seal") {
    let opts;
    try {
      opts = parseSealArgs(rest);
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return EXIT.USAGE;
    }
    return runEvidenceSeal(opts, io);
  }
  if (sub === "verify") {
    let opts;
    try {
      opts = parseVerifyArgs(rest);
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return EXIT.USAGE;
    }
    return runEvidenceVerify(opts, io);
  }
  if (sub === "verify-signed") {
    let opts;
    try {
      opts = parseVerifySignedArgs(rest);
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return EXIT.USAGE;
    }
    return runEvidenceVerifySigned(opts, io);
  }
  if (sub === "diff") {
    let opts;
    try {
      opts = parseDiffArgs(rest);
    } catch (e) {
      writeErr(`error: ${e.message}\n`);
      return EXIT.USAGE;
    }
    return runEvidenceDiff(opts, io);
  }
  if (sub === "license") {
    return cmdEvidenceLicense(rest, io);
  }
  if (sub === "go-live-preflight") {
    // Lazily required to avoid a require cycle (go-live-preflight requires THIS module's exports).
    return require("./core/go-live-preflight").cmdGoLivePreflight(rest, io);
  }
  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
    io.write
      ? io.write(evidenceUsage())
      : process.stdout.write(evidenceUsage());
    return sub === undefined ? EXIT.USAGE : EXIT.OK;
  }
  writeErr(
    `error: unknown evidence subcommand: ${sub} (expected: seal, verify, verify-signed, diff, license, go-live-preflight)\n`
  );
  return EXIT.USAGE;
}

function evidenceUsage() {
  return [
    "vh evidence — product-agnostic, license-gated, tamper-evident evidence packets",
    "",
    "Usage:",
    "  vh evidence seal <dir> [--out <p>] [--license <f>] [--sign] [--json]",
    "  vh evidence verify <p> [--dir <d>] [--json]",
    "  vh evidence verify-signed <signed> [--dir <d>] [--signer <0xaddr>] [--strict] [--revocations <f> --as-of <ISO>] [--json]",
    "  vh evidence diff <packetA> <packetB> [--policy <f>] [--json]",
    "  vh evidence license fulfill --plan <id> --customer <name> [--paid-through <ISO>] [--catalog <f>] (--key-env <VAR>|--key-file <p>) [--issued <ISO>] [--license-id <id>] [--out <f>] [--json]",
    "  vh evidence go-live-preflight --binding <f> [--catalog <f>] [--secret-env <VAR>] (--key-env <VAR>|--key-file <p>) [--json]",
    "",
    "The seal proves TAMPER-EVIDENCE + OFFLINE-RECOMPUTE, NOT a trusted timestamp (\"sealed at T\" rides P-3).",
    "FREE: an unsigned baseline seal of up to " + SAMPLE_LIMIT + " files + verify + verify-signed + diff (try before buying).",
    "PAID (requires --license <f>): --sign (signed-attestation wrap) and sealing > " + SAMPLE_LIMIT + " files.",
    "  The license is verified OFFLINE against the CANONICAL vendor identity " + CANONICAL_VENDOR_ADDRESS + ";",
    "  only a license minted by that vendor key unlocks the paid surface. --vendor <0xaddr> is accepted only as an",
    "  explicit assertion that must EQUAL that identity — it can NOT re-pin the gate (self-mint defense). Running",
    "  your OWN instance? Set your OWN identity via " + CANONICAL_VENDOR_ENV + " (see docs/LICENSING.md).",
    "verify-signed is OFFLINE/key-free/network-free: it RECOVERS the signer + (--signer) pins it + (--dir) binds the bytes",
    "  + (--revocations) checks the signer was not REVOKED as of --as-of (default now).",
    "  A forged/tampered/wrong-key signature, or a key revoked-before-as-of, is a clean REJECTED/REVOKED — never a silent pass.",
    "  WITHOUT --signer the verdict is labelled UNPINNED (a genuine signature only proves SOME key signed — anyone's key",
    "  passes an unpinned check); --strict fails closed on that: exit 0 then means ACCEPTED-and-pinned, and an unpinned",
    "  accept is the distinct exit 4 (UNPINNED).",
    "  Exit 0 ACCEPTED (and pinned, under --strict) / 3 REJECTED|REVOKED / 4 UNPINNED (--strict only) / 2 usage / 1 IO.",
    "verify on a SIGNED packet no longer trusts the claimed signer: it REJECTS a forged signature OR labels a genuine one",
    "  UNVERIFIED-for-pinning and points at `verify-signed`.",
    "diff is read-only/FREE/key-free/OFFLINE: it compares what TWO packets CLAIM and writes nothing.",
    "  With --policy <f> it GATES the change set (noAdded/noRemoved/noChanged/allowChangePaths/frozenPaths):",
    "  exit is then the policy verdict — a DIFFERENT-but-PERMITTED change PASSes (0), a disallowed change FAILs (3).",
    "Exit: diff 0 IDENTICAL (or policy PASS) / 3 DIFFERENT (or policy FAIL) / 2 usage / 1 IO.",
    "license fulfill MINTS the signed evidence license the paid surfaces accept: it resolves <id> in the bundled DRAFT catalog",
    "  (or --catalog), copies that plan's entitlements VERBATIM, derives the window (--paid-through wins else the plan's term),",
    "  and signs with a HUMAN-provisioned key (EXACTLY ONE of --key-env/--key-file, read-used-discarded; the loop sets NO price).",
    "  The minted license UNLOCKS `vh evidence seal --sign`. Exit: 0 ok / 3 gate-fail / 2 usage / 1 IO.",
    "go-live-preflight VALIDATES the operator's OWN --binding + --catalog + vendor key end-to-end OFFLINE so a config typo",
    "  cannot silently cause 'customer PAID, no license delivered': for every price it RESOLVES the plan (an unmapped/duplicate/",
    "  typo'd price is NAMED, never a silent default), MINTS a signed license, and confirms it PASSES the paid `vh evidence seal",
    "  --sign` gate (a plan lacking `evidence_signed` is caught, never PASS). With --secret-env it exercises your REAL webhook",
    "  secret (fail-closed). No network, no deploy; a throwaway workspace is removed on exit. Exit: 0 all-deliver / 2 config / 3 a price would not deliver.",
    "",
  ].join("\n");
}

module.exports = {
  EXIT,
  SAMPLE_LIMIT,
  // seal product
  SEAL_KIND,
  SEAL_SCHEMA_VERSION,
  EVIDENCE_TRUST_NOTE,
  SEAL_CFG,
  buildSeal,
  validateSeal,
  serializeSeal,
  readSeal,
  verifySeal,
  diffEvidence,
  diffEvidenceSeals,
  // drift policy (the CI-gateable verdict over the change set)
  DRIFT_POLICY_KIND,
  DRIFT_POLICY_SCHEMA_VERSION,
  DRIFT_RULE,
  DRIFT_VERDICT,
  DRIFT_TRUST_NOTE,
  validateDriftPolicy,
  readDriftPolicy,
  evaluateDriftPolicy,
  loadDirEntries,
  // signed wrap
  SIGNED_SEAL_KIND,
  SIGNED_SEAL_CFG,
  signSealWith,
  validateSignedSeal,
  verifySignedSeal,
  verifySignedSealAttestation,
  VERIFY_SIGNED_SEAL_TRUST_NOTE,
  // license product
  LICENSE_KIND,
  LICENSE_CFG,
  ENTITLEMENTS,
  EvidenceLicenseError,
  buildLicense,
  readLicense,
  verifyLicense,
  hasEntitlement,
  serializeSignedLicense,
  // the canonical vendor pin (T-75.3)
  CANONICAL_VENDOR_ADDRESS,
  CANONICAL_VENDOR_ENV,
  resolveCanonicalVendor,
  // license fulfillment
  BUNDLED_EVIDENCE_CATALOG,
  nowISO,
  parseLicenseFulfillArgs,
  runEvidenceLicenseFulfill,
  cmdEvidenceLicense,
  // CLI
  parseSealArgs,
  parseVerifyArgs,
  parseVerifySignedArgs,
  parseDiffArgs,
  runEvidenceSeal,
  runEvidenceVerify,
  runEvidenceVerifySigned,
  runEvidenceDiff,
  renderVerify,
  renderVerifySigned,
  renderDiff,
  cmdEvidence,
  evidenceUsage,
};

"use strict";

// cli/core/timestamp.js — the GENERIC detached-timestamp CONTAINER engine for the product family.
//
// WHY THIS EXISTS (T-20.2, EPIC-20)
//   cli/core/attestation.js wraps a canonical UNSIGNED attestation in a detached SIGNATURE — "the
//   publisher SAYS this payload existed". The honestly-stronger claim a due-diligence / EU-AI-Act reviewer
//   ultimately wants is "an INDEPENDENT third party attests this exact payload existed by time T". RFC-3161
//   delivers that: you send a hash (the messageImprint) to a Time-Stamping Authority (TSA), it returns a
//   signed TimeStampToken whose embedded TSTInfo binds that hash to a genTime. This module is the
//   wrap-don't-edit CONTAINER for that token — the EXACT sibling of `signAttestation`'s envelope, but for a
//   timestamp instead of a signature: it embeds the canonical UNSIGNED attestation bytes verbatim and
//   attaches the TSA's RFC-3161 token, bound to the SHA-256 digest OF THOSE EXACT BYTES.
//
// PARAMETERIZED BY THE PRODUCT'S FRAMING — exactly like attestation.js.
//   Each product (DataLedger, ProofParcel) supplies ONLY its container `kind`/`schemaVersion`/`note` plus
//   its OWN unsigned-payload codec (`validateUnsigned` + `serializeUnsigned`). The core does the shared
//   machinery: assemble the container, re-validate the embedded canonical attestation (the SAME
//   wrap-don't-edit invariant the signed envelope enforces), parse the token via cli/core/rfc3161.js, and
//   confirm `bindsDigest(token, digest)` AND `digest === sha256(canonical attestation bytes)`. No back-edge
//   (the core never requires a product module).
//
// THE DIGEST IS SHA-256 — NOT the project's keccak256 manifestDigest. (Load-bearing.)
//   RFC-3161 TSAs stamp a `messageImprint` over a STANDARD hash. SHA-256 is universal; keccak256 is
//   non-standard and most TSAs will reject it. So the timestamp digest is a FRESH `sha256(utf8(canonical
//   attestation string))` computed via Node's crypto.createHash("sha256") — it is the digest the BUYER can
//   re-derive from the embedded canonical bytes with any standard tool, and the digest the human submits to
//   their TSA. We do NOT reuse the keccak `manifestDigest` (which lives INSIDE the attestation payload and
//   is non-standard).
//
// SCOPE / TRUST (honest about it). The token's AUTHENTICITY — that the bytes really came from a TSA you
//   trust and weren't forged — is the HUMAN out-of-band trust anchor (validate the TSA cert chain / CMS
//   signature with `openssl ts -verify`, exactly as the signed envelope pins the signer ADDRESS out of
//   band). This module proves the BINDING (which digest/genTime the token asserts over the buyer's own
//   re-derivable bytes), NOT the authenticity of the asserting party. It performs NO network and holds NO
//   key.

const crypto = require("crypto");
const rfc3161 = require("./rfc3161");

// The detached timestamp schemes this build understands. EXACTLY one — RFC-3161 — and the hash the
// messageImprint is computed under is SHA-256 (universal across TSAs). Frozen so they can't drift.
const TIMESTAMP_SCHEMES = Object.freeze(["rfc3161"]);
const TIMESTAMP_HASH_ALGORITHMS = Object.freeze(["sha256"]);

// The dotted-decimal OID a SHA-256 messageImprint hashAlgorithm carries, sourced from the rfc3161 reader so
// the OID can never drift between the reader and this container.
const SHA256_OID = rfc3161.OID.sha256;

// A 0x-OPTIONAL, lowercase, EVEN-length, 32-byte (64-hex-char) digest. SHA-256 is exactly 32 bytes. The
// container stores the digest WITHOUT a 0x prefix (it is a standard hash imprint, the form a TSA query/
// `openssl ts` speaks), lowercase, for byte-determinism (an indexer keys on the exact bytes).
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

// A base64 string (the DER token). Permissive on read (whitespace tolerated by the rfc3161 reader's toBuf);
// the container stores it as canonical base64 with NO whitespace so two structurally identical containers
// over the same token serialize identically.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Compute the FRESH SHA-256 digest (lowercase hex, no 0x) over the canonical UNSIGNED attestation bytes.
 * This is the digest a human submits to their TSA and the digest the token must bind. PURE.
 *
 * @param {string} canonicalBytes the exact canonical UNSIGNED attestation string (serializeUnsigned output)
 * @returns {string} lowercase 64-char hex SHA-256 digest (no 0x)
 */
function sha256Hex(canonicalBytes) {
  if (typeof canonicalBytes !== "string") {
    throw new Error("sha256Hex requires the canonical attestation bytes as a string");
  }
  return crypto.createHash("sha256").update(canonicalBytes, "utf8").digest("hex");
}

/**
 * Internal: assert a product passed a structurally complete timestamp-container config. The injected
 * `validateUnsigned`/`serializeUnsigned` are how the core enforces the wrap-don't-edit invariant WITHOUT
 * knowing anything product-specific (no `require("../dataset")` back-edge) — IDENTICAL discipline to
 * attestation.js's `_requireCfg`.
 */
function _requireCfg(cfg) {
  if (!cfg || typeof cfg !== "object") {
    throw new Error(
      "timestamp core requires a { kind, schemaVersion, supportedSchemaVersions, note, validateUnsigned, serializeUnsigned } config"
    );
  }
  if (typeof cfg.kind !== "string" || cfg.kind.length === 0) {
    throw new Error("timestamp core config requires a non-empty string `kind`");
  }
  if (!Array.isArray(cfg.supportedSchemaVersions) || cfg.supportedSchemaVersions.length === 0) {
    throw new Error("timestamp core config requires a non-empty `supportedSchemaVersions` array");
  }
  if (typeof cfg.note !== "string") {
    throw new Error("timestamp core config requires a string `note` (the in-band trust caveat)");
  }
  if (typeof cfg.validateUnsigned !== "function" || typeof cfg.serializeUnsigned !== "function") {
    throw new Error(
      "timestamp core config requires `validateUnsigned` and `serializeUnsigned` functions (the product's UNSIGNED payload codec)"
    );
  }
  if (typeof cfg.label !== "string" && cfg.label !== undefined) {
    throw new Error("timestamp core config `label`, when present, must be a string");
  }
}

/**
 * Strictly validate a parsed DETACHED-TIMESTAMP container against a product's framing. Throws an Error
 * describing the FIRST problem; never mutates and never fills defaults. REJECTS: a wrong kind/schemaVersion/
 * note, a non-string embedded `attestation`, an embedded attestation that does not re-validate as a sound
 * UNSIGNED payload OR is not byte-for-byte canonical (the wrap-don't-edit invariant), a malformed
 * `timestamp` block (wrong scheme/hashAlgorithm, non-hex digest, non-base64 token), a token that does not
 * PARSE as RFC-3161, a token whose messageImprint does not BIND the recorded digest, or a recorded `digest`
 * that is NOT sha256(canonical attestation bytes). It NEVER half-accepts.
 *
 * @param {any} obj
 * @param {object} cfg  the product's timestamp-container framing (see buildTimestampContainer)
 * @returns {object} the same object, if valid
 */
function validateTimestampContainer(obj, cfg) {
  _requireCfg(cfg);
  const label = cfg.label || "timestamped dataset attestation";
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(`${label} must be a JSON object`);
  }
  if (obj.kind !== cfg.kind) {
    throw new Error(
      `not a verifyhash ${label} (kind: ${JSON.stringify(obj.kind)}; expected ${JSON.stringify(cfg.kind)})`
    );
  }
  if (!cfg.supportedSchemaVersions.includes(obj.schemaVersion)) {
    throw new Error(
      `unsupported ${label} schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(cfg.supportedSchemaVersions)})`
    );
  }
  if (obj.note !== cfg.note) {
    throw new Error(`${label} note must be the standing TIMESTAMP_TRUST_NOTE`);
  }

  // The embedded UNSIGNED payload is carried as the EXACT canonical bytes serializeUnsigned emits — a
  // STRING, so the timestamped-over bytes are unambiguous. Re-parse and re-validate it with the PRODUCT's
  // strict unsigned validator: it must STILL be signed:false/signature:null. This is the wrap-don't-edit
  // invariant — a timestamp container can never smuggle an edited or already-"signed" payload.
  if (typeof obj.attestation !== "string") {
    throw new Error(`${label} must embed the canonical UNSIGNED attestation as a string \`attestation\``);
  }
  let embedded;
  try {
    embedded = JSON.parse(obj.attestation);
  } catch (e) {
    throw new Error(`embedded attestation is not valid JSON: ${e.message}`);
  }
  cfg.validateUnsigned(embedded);
  const canonical = cfg.serializeUnsigned(embedded);
  if (obj.attestation !== canonical) {
    throw new Error(
      "embedded attestation is not in canonical form (the timestamped-over bytes must be byte-for-byte " +
        "serializeAttestation's output)"
    );
  }

  // The timestamp block.
  const ts = obj.timestamp;
  if (ts == null || typeof ts !== "object" || Array.isArray(ts)) {
    throw new Error(`${label} timestamp must be a { scheme, hashAlgorithm, digest, token } object`);
  }
  if (!TIMESTAMP_SCHEMES.includes(ts.scheme)) {
    throw new Error(
      `unknown timestamp scheme: ${JSON.stringify(ts.scheme)} ` +
        `(this build understands ${JSON.stringify(TIMESTAMP_SCHEMES)})`
    );
  }
  if (!TIMESTAMP_HASH_ALGORITHMS.includes(ts.hashAlgorithm)) {
    throw new Error(
      `unsupported timestamp hashAlgorithm: ${JSON.stringify(ts.hashAlgorithm)} ` +
        `(this build understands ${JSON.stringify(TIMESTAMP_HASH_ALGORITHMS)}; RFC-3161 TSAs stamp a ` +
        "standard hash — SHA-256 — NOT the project's internal keccak256 manifestDigest)"
    );
  }
  if (typeof ts.digest !== "string" || !SHA256_HEX_RE.test(ts.digest)) {
    throw new Error(
      `timestamp digest must be a 32-byte lowercase SHA-256 hex string (no 0x), got: ${String(ts.digest)}`
    );
  }
  if (typeof ts.token !== "string" || !BASE64_RE.test(ts.token) || ts.token.length === 0) {
    throw new Error(
      `timestamp token must be a non-empty base64 string (the DER-encoded RFC-3161 TimeStampToken), got: ${String(
        ts.token
      )}`
    );
  }

  // The digest MUST be sha256 of the EXACT embedded canonical bytes — the digest the buyer re-derives. A
  // container whose `digest` does not match the bytes it carries is rejected (it could otherwise point a
  // genuine TSA token at a digest unrelated to the payload).
  const expectedDigest = sha256Hex(canonical);
  if (ts.digest !== expectedDigest) {
    throw new Error(
      "timestamp digest does NOT equal sha256(canonical attestation bytes) — the digest must be over the " +
        `EXACT embedded bytes (expected ${expectedDigest}, got ${ts.digest})`
    );
  }

  // The token must PARSE as RFC-3161 (a malformed/non-TSTInfo token is rejected here, clearly) AND its
  // messageImprint must BIND the recorded digest under SHA-256. parseTimeStampToken throws on malformed
  // DER; bindsDigest returns false (never throws) for a valid token that simply binds a different digest.
  let parsed;
  try {
    parsed = rfc3161.parseTimeStampToken(ts.token);
  } catch (e) {
    throw new Error(`timestamp token is not a parseable RFC-3161 TimeStampToken: ${e.message}`);
  }
  const bound = rfc3161.bindsDigest({
    token: parsed,
    expectedDigestHex: ts.digest,
    expectedHashOID: SHA256_OID,
  });
  if (!bound) {
    throw new Error(
      "timestamp token does NOT bind the digest: its messageImprint does not stamp " +
        `${ts.digest} under SHA-256 (the TSA stamped a different digest, or a different hash algorithm)`
    );
  }

  return obj;
}

/**
 * Assemble + validate a DETACHED-TIMESTAMP container from a validated UNSIGNED payload and an RFC-3161
 * token, PARAMETERIZED by the product's container framing. PURE: NO network, NO key. It embeds the EXACT
 * canonical unsigned bytes (cfg.serializeUnsigned(attestation)) as a string, computes the FRESH SHA-256
 * digest OVER those bytes, attaches { scheme:"rfc3161", hashAlgorithm:"sha256", digest, token } (with the
 * token canonicalized to base64), and strictly validates the whole container — so a token that does not
 * bind the re-derived digest is rejected HERE (the build never produces an unbinding container).
 *
 * @param {object} params
 * @param {object} params.attestation a validated UNSIGNED payload (re-validated via cfg.validateUnsigned)
 * @param {Buffer|Uint8Array|string} params.token the RFC-3161 TimeStampToken (raw DER bytes or hex/base64)
 * @param {object} cfg the product's timestamp-container framing
 * @returns {object} a validated detached-timestamp container
 */
function buildTimestampContainer(params, cfg) {
  _requireCfg(cfg);
  if (!params || typeof params !== "object") {
    throw new Error("buildTimestampContainer requires { attestation, token }");
  }
  const { attestation, token } = params;
  // The embedded payload must itself be a sound UNSIGNED payload before we wrap it (re-validate so a
  // programmatic caller that hand-built one is checked too). validateUnsigned rejects signed:true.
  cfg.validateUnsigned(attestation);
  const canonical = cfg.serializeUnsigned(attestation);
  const digest = sha256Hex(canonical);

  // Normalize the token to canonical base64 (no whitespace) so the container is byte-deterministic. toBuf
  // accepts a Buffer/Uint8Array OR a hex/base64 string; a non-token throws here clearly. We re-encode the
  // EXACT DER bytes — never a re-DER'd or mutated form.
  if (token == null) throw new Error("buildTimestampContainer requires a `token` (RFC-3161 DER bytes)");
  const der = rfc3161._internal.toBuf(token);
  const tokenB64 = der.toString("base64");

  const container = {
    kind: cfg.kind,
    schemaVersion: cfg.schemaVersion,
    note: cfg.note,
    attestation: canonical,
    timestamp: {
      scheme: "rfc3161",
      hashAlgorithm: "sha256",
      digest,
      token: tokenB64,
    },
  };
  // Strict validation (re-derives the digest, parses the token, confirms bindsDigest) — a token that does
  // not bind the re-derived digest hard-errors HERE, so a bad handoff never lands an unbinding container.
  validateTimestampContainer(container, cfg);
  return container;
}

/**
 * Serialize a detached-timestamp container to its canonical, byte-deterministic bytes: a FIXED top-level
 * (and timestamp-block) key order, NO insignificant whitespace, a single trailing newline. Two runs over
 * the same inputs produce an identical string.
 * @param {object} container a validated detached-timestamp container
 * @param {object} cfg the product's timestamp-container framing
 * @returns {string} the canonical serialization (newline-terminated)
 */
function serializeTimestampContainer(container, cfg) {
  validateTimestampContainer(container, cfg);
  const canonical = {
    kind: container.kind,
    schemaVersion: container.schemaVersion,
    note: container.note,
    attestation: container.attestation,
    timestamp: {
      scheme: container.timestamp.scheme,
      hashAlgorithm: container.timestamp.hashAlgorithm,
      digest: container.timestamp.digest,
      token: container.timestamp.token,
    },
  };
  return JSON.stringify(canonical) + "\n";
}

/**
 * Read, parse, and STRICTLY validate the detached-timestamp container at `containerPath` against a
 * product's framing. Round-trips with serializeTimestampContainer. Throws on a missing file or invalid JSON
 * too. The `label` (default "timestamped dataset attestation") parameterizes only the human noun in the I/O
 * error messages so each product's strings stay byte-identical.
 *
 * @param {string} containerPath
 * @param {object} cfg the product's timestamp-container framing
 * @returns {object} the validated container
 */
function readTimestampContainer(containerPath, cfg) {
  _requireCfg(cfg);
  const fs = require("fs");
  const label = cfg.label || "timestamped dataset attestation";
  if (!containerPath || typeof containerPath !== "string") {
    throw new Error("readTimestampContainer requires a timestamped attestation file path");
  }
  let raw;
  try {
    raw = fs.readFileSync(containerPath, "utf8");
  } catch (e) {
    throw new Error(`cannot read ${label} at ${containerPath}: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label} at ${containerPath} is not valid JSON: ${e.message}`);
  }
  return validateTimestampContainer(obj, cfg);
}

// Possible verify-timestamp verdicts. ACCEPTED = the container is structurally sound, the digest IS
// sha256(canonical bytes), the token parses + BINDS that digest, and (when a manifest is given) the
// embedded attestation is byte-identical to the buyer's own re-derived canonical bytes. REJECTED = at
// least one check failed.
const VERIFY_TIMESTAMP_VERDICT = Object.freeze({ ACCEPTED: "ACCEPTED", REJECTED: "REJECTED" });

/**
 * Verify (purely, OFFLINE) a DETACHED-TIMESTAMP container against a product's framing — the read-only
 * sibling of `verifySignedAttestation`. PARAMETERIZED by `cfg` exactly like the validate/build path. It
 * answers, with NO key and NO network: (1) does the container re-derive the canonical attestation bytes
 * from the embedded UNSIGNED payload, with `digest === sha256(those bytes)`; (2) does the token PARSE as
 * RFC-3161 and BIND that digest under SHA-256; (3) — OPTIONALLY, when `expectedManifestCanonical` is
 * provided — are the embedded canonical bytes byte-identical to the buyer's OWN re-derived canonical bytes
 * (binding the token to the buyer's data, exactly like verify-attest's `--manifest`).
 *
 * The structural + binding checks (1) and (2) are precisely what `validateTimestampContainer` enforces; we
 * reuse it VERBATIM (never a re-impl) so a tampered token / mismatched digest / edited embedded attestation
 * REJECTS for the same reason the build/read path rejects. A structural failure is a clean REJECTED that
 * NAMES the failing reason — NEVER a false ACCEPT, and never a thrown error from a malformed-but-parseable
 * container. (A non-JSON / unreadable file is still an I/O error at the read boundary, handled by the CLI.)
 *
 * @param {object} params
 * @param {any}    params.container the parsed container object (from readTimestampContainer or JSON.parse)
 * @param {string} [params.expectedManifestCanonical] OPTIONAL: the buyer's OWN canonical UNSIGNED bytes
 *        (serializeUnsigned(buildUnsigned(theirManifest))); when present, the embedded attestation must
 *        equal it byte-for-byte
 * @param {object} cfg the product's timestamp-container framing (see buildTimestampContainer)
 * @returns {{
 *   verdict: "ACCEPTED"|"REJECTED",
 *   accepted: boolean,
 *   checks: { structureAndBinding: boolean, manifestBindsAttestation: boolean|null },
 *   manifestChecked: boolean,
 *   failedChecks: string[],
 *   reason: string|null,
 *   genTime: string|null,
 *   genTimeEpochMs: number|null,
 *   serialNumber: {hex:string,decimal:string}|null,
 *   policyOID: string|null,
 *   hashAlgorithmOID: string|null,
 *   digest: string|null,
 * }}
 */
function verifyTimestampContainer(params, cfg) {
  _requireCfg(cfg);
  if (!params || typeof params !== "object") {
    throw new Error("verifyTimestampContainer requires { container, [expectedManifestCanonical] }");
  }
  const { container, expectedManifestCanonical } = params;
  const manifestChecked =
    expectedManifestCanonical !== undefined && expectedManifestCanonical !== null;

  const result = {
    verdict: VERIFY_TIMESTAMP_VERDICT.REJECTED,
    accepted: false,
    checks: { structureAndBinding: false, manifestBindsAttestation: manifestChecked ? false : null },
    manifestChecked,
    failedChecks: [],
    reason: null,
    genTime: null,
    genTimeEpochMs: null,
    serialNumber: null,
    policyOID: null,
    hashAlgorithmOID: null,
    digest: null,
  };

  // Check 1 + 2 (structure + binding): run the SAME strict validator the build/read path uses. It
  // re-derives sha256(canonical bytes), confirms digest equality, parses the token, and confirms
  // bindsDigest — so an edited embedded attestation, a mismatched digest, or a token binding a different
  // digest all throw HERE with a descriptive message. We turn that throw into a clean, named REJECTED
  // (never a false ACCEPT, never a leaked exception).
  let validated;
  try {
    validated = validateTimestampContainer(container, cfg);
  } catch (e) {
    result.failedChecks.push("structureAndBinding");
    result.reason = e.message;
    return result;
  }
  result.checks.structureAndBinding = true;

  // Surface what the (now-confirmed-binding) token ASSERTS — the same honest scope as readTimestampFacts.
  const facts = readTimestampFacts(validated);
  result.genTime = facts.genTime;
  result.genTimeEpochMs = facts.genTimeEpochMs;
  result.serialNumber = facts.serialNumber;
  result.policyOID = facts.policyOID;
  result.hashAlgorithmOID = facts.hashAlgorithmOID;
  result.digest = facts.digest;

  // Check 3 (OPTIONAL): bind the token to the BUYER's own data. The embedded canonical bytes must equal
  // the buyer's re-derived canonical bytes byte-for-byte. A DIFFERENT manifest -> a different attestation
  // -> a byte mismatch -> REJECTED (the token timestamped a DIFFERENT dataset/parcel identity).
  if (manifestChecked) {
    if (typeof expectedManifestCanonical !== "string") {
      throw new Error("verifyTimestampContainer: expectedManifestCanonical must be a string when provided");
    }
    const binds = validated.attestation === expectedManifestCanonical;
    result.checks.manifestBindsAttestation = binds;
    if (!binds) {
      result.failedChecks.push("manifestBindsAttestation");
      result.reason =
        "the timestamped attestation does NOT match YOUR manifest — the token stamped a DIFFERENT " +
        "dataset/parcel identity than the one you hold";
    }
  }

  result.accepted = result.failedChecks.length === 0;
  result.verdict = result.accepted
    ? VERIFY_TIMESTAMP_VERDICT.ACCEPTED
    : VERIFY_TIMESTAMP_VERDICT.REJECTED;
  return result;
}

/**
 * Read (purely, OFFLINE) the timestamp facts a container ASSERTS: the asserted genTime / TSA serial /
 * policy OID + the bound digest, with the SAME honest scope as cli/core/rfc3161.js — it does NOT validate
 * the TSA cert chain / the CMS signature (that is the human out-of-band trust anchor). Used by the read
 * side to surface what the token claims without re-deciding the binding the validator already confirmed.
 *
 * @param {object} container a validated detached-timestamp container
 * @returns {{ digest: string, genTime: string, genTimeEpochMs: number, serialNumber: {hex,decimal}, policyOID: string, hashAlgorithmOID: string }}
 */
function readTimestampFacts(container) {
  const parsed = rfc3161.parseTimeStampToken(container.timestamp.token);
  return {
    digest: container.timestamp.digest,
    genTime: parsed.genTime,
    genTimeEpochMs: parsed.genTimeEpochMs,
    serialNumber: parsed.serialNumber,
    policyOID: parsed.policyOID,
    hashAlgorithmOID: parsed.messageImprint.hashAlgorithmOID,
  };
}

module.exports = {
  TIMESTAMP_SCHEMES,
  TIMESTAMP_HASH_ALGORITHMS,
  SHA256_OID,
  sha256Hex,
  validateTimestampContainer,
  buildTimestampContainer,
  serializeTimestampContainer,
  readTimestampContainer,
  readTimestampFacts,
  VERIFY_TIMESTAMP_VERDICT,
  verifyTimestampContainer,
};

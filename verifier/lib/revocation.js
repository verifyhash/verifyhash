"use strict";

// verifier/lib/revocation.js — the STACK-FREE recipient-side KEY-REVOCATION reader + as-of decision for the
// INDEPENDENT verifier (EPIC-51 / T-51.4).
//
// WHY THIS EXISTS
//   The producer stack already lets a recipient downgrade an otherwise-ACCEPTED signed artifact to REVOKED
//   when the signing key was revoked-before-the-as-of-instant (`vh ... verify-signed --revocations <f>
//   --as-of <T>`, cli/core/trust-asof.js + cli/core/revocation.js). The OFFLINE, no-producer-stack verifier
//   (`verify-vh`) did NOT — so a counterparty who only holds the single-file verifier reached a DIFFERENT
//   verdict than the producer on the SAME inputs (a clean ACCEPTED where the producer returned REVOKED).
//   This module closes that gap WITHOUT pulling in ethers/hardhat or back-edging into cli/: it RE-IMPLEMENTS
//   the revocation soundness check (EIP-191 signer recovery + the load-bearing SELF-CONTROL invariant) and
//   the as-of trust decision using ONLY the verifier's own pure-JS crypto (./secp256k1-recover, ./keccak).
//
// THE LOAD-BEARING SAFETY INVARIANT — A REVOCATION CAN ONLY EVER REMOVE TRUST, NEVER ADD IT.
//   Every revocation statement is verified the SAME way the producer core does: it must (1) recover to its
//   own claimed `signer` AND (2) recover to its own embedded `vendorAddress` (a key revokes ITSELF). A
//   revocation that fails EITHER check — forged, tampered, third-party, structurally malformed, or simply
//   not parseable — is IGNORED with a WARNING and can NEVER downgrade the verdict. So a planted "revocation"
//   for a victim's key cannot grief a recipient into rejecting a perfectly good artifact.
//
// SUBJECT-SCOPING — A REVOCATION ONLY BITES THE KEY IT NAMES.
//   The `subject` is the artifact's RECOVERED signer (the address verify-vh derived from the bytes). A
//   revocation only affects the verdict when its `vendorAddress` EQUALS that subject; a revocation for some
//   OTHER key is `irrelevant`, never a downgrade.
//
// PURE + I/O-FREE on the decision; the FILE/DIR READ is the only I/O (readRevocationsFromPath), kept here so
//   verify-vh stays a thin wiring layer. No network, no key, no clock (the `asOf` instant is caller-supplied).
//
// PARITY WITH THE PRODUCER STACK
//   The decision semantics (applies / later / irrelevant / ignored; the inclusive `revokedAt <= asOf`
//   boundary; the EARLIEST-applicable governing record; the later-revoked informational note) mirror
//   cli/core/trust-asof.js, and the STRUCTURAL validation (validateSignedRevocation below) mirrors the
//   producer's cli/core/attestation.js validateSignedAttestation + cli/core/revocation.js validateRevocation
//   gate-for-gate: the closed embedded field set, the supported schemaVersion (container AND payload), the
//   standing trust NOTES, the lowercase-only signature/address grammar, and the WRAP-DON'T-EDIT canonical
//   re-serialization binding. A revocation the producer IGNORES (a non-canonical / extra-field / wrong-note /
//   unsupported-schemaVersion / mixed-case-hex but genuinely self-signed one) is therefore IGNORED here too —
//   so on identical inputs verify-vh's verdict + exit code match `vh ... verify-signed --revocations`
//   byte-for-byte, for the SOUND inputs AND the malformed ones. test/verifier.revocation.test.js pins that
//   parity against the REAL producer core, including the malformed-but-self-signed (NEGATIVE-parity) classes.

const fs = require("fs");
const path = require("path");

const { recoverPersonalSignAddress } = require("./secp256k1-recover");

// ---------------------------------------------------------------------------
// On-disk discriminators + grammars — byte-identical to cli/core/revocation.js so a producer-minted
// revocation reads here verbatim.
// ---------------------------------------------------------------------------

const SIGNED_REVOCATION_KIND = "vh-key-revocation-signed";
const REVOCATION_KIND = "vh-key-revocation";

// The SCHEMA versions this build understands — byte-identical to cli/core/revocation.js's
// SUPPORTED_*_SCHEMA_VERSIONS. The producer REJECTS (IGNORES) a revocation whose container OR embedded
// payload carries an unsupported schemaVersion, so the verifier must too (parity).
const REVOCATION_SCHEMA_VERSION = 1;
const SUPPORTED_REVOCATION_SCHEMA_VERSIONS = Object.freeze([1]);
const SUPPORTED_SIGNED_REVOCATION_SCHEMA_VERSIONS = Object.freeze([1]);

// The CLOSED reason set (the producer's REVOCATION_REASON_SET, sorted). An out-of-set reason marks the
// embedded revocation structurally malformed — the entry is IGNORED (never silently honored).
const REVOCATION_REASON_SET = Object.freeze(["compromised", "retired", "rotated", "superseded"]);

// The CLOSED field set of an UNSIGNED revocation payload — byte-identical to cli/core/revocation.js's
// REVOCATION_FIELDS. The producer HARD-rejects any extraneous/unknown key (validateRevocation), IGNORING
// the revocation; the verifier must enforce the SAME closed set so a smuggled extra field can never make
// the two stacks disagree (a self-signed-but-non-canonical revocation the producer ignores must be ignored
// here too). `supersededBy` is OPTIONAL but a member of the set.
const REVOCATION_FIELDS = Object.freeze([
  "kind",
  "schemaVersion",
  "note",
  "vendorAddress",
  "reason",
  "revokedAt",
  "supersededBy",
]);

// The standing in-band trust NOTES — copied VERBATIM from cli/core/revocation.js so the verifier pins the
// EXACT same `note` text the producer requires. The producer's validateRevocation requires the embedded
// payload's `note` to equal REVOCATION_TRUST_NOTE, and validateSignedAttestation requires the container's
// `note` to equal SIGNED_REVOCATION_TRUST_NOTE; a revocation with a wrong/absent note is IGNORED by the
// producer, so the verifier must ignore it too (parity). These strings are LOAD-BEARING for parity, not
// for security (the signature binds the bytes regardless) — they must never drift from the producer's.
const REVOCATION_TRUST_NOTE =
  "This is a verifyhash producer KEY REVOCATION: the holder of `vendorAddress`'s key SIGNED it, declaring " +
  "that address REVOKED as of `revokedAt` for `reason` (optionally superseded by `supersededBy`). verify " +
  "RE-DERIVES the signer from these exact bytes and REQUIRES it to equal `vendorAddress` — a key revokes " +
  "ITSELF; a third party cannot revoke a key it does not control. It proves the KEY-HOLDER's SIGNED CLAIM " +
  'ONLY: `revokedAt` is the holder\'s self-asserted instant, NOT a trusted TIMESTAMP (it rides the human-' +
  "owned timestamp trust-root, STRATEGY.md P-3), and this is NOT a legal opinion.";

const SIGNED_REVOCATION_TRUST_NOTE =
  "This is a SIGNED verifyhash key-revocation container: it WRAPS (never edits) the EXACT canonical " +
  "revocation bytes in `attestation` and attaches a detached EIP-191 signature. verifyRevocation " +
  "RE-DERIVES the signer from those bytes and pins it to the embedded `vendorAddress` — it never trusts " +
  "the file's own claims. Every caveat of the embedded revocation applies. " +
  REVOCATION_TRUST_NOTE;

// A claimed 0x-address INSIDE the payload: 0x + 40 LOWERCASE hex (byte-determinism — mixed-case rejected).
const PAYLOAD_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
// A recovered/expected address (the verifier lowercases everything it compares).
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
// A 65-byte (r||s||v) signature as 0x-hex — LOWERCASE-only, byte-for-byte the producer's EIP191_SIG_RE
// (cli/core/attestation.js). The producer REJECTS mixed/upper-case hex for byte-determinism and IGNORES a
// revocation carrying it; accepting mixed case here would let a third party re-encode a holder's genuine
// revocation into one the producer drops but the verifier honors — a parity split with NO key required. So
// the verifier pins the SAME lowercase grammar.
const SIGNATURE_RE = /^0x[0-9a-f]{130}$/;
// A strict, CANONICAL ISO-8601 UTC instant — the SAME grammar revokedAt / asOf are pinned to.
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

// The recovered-signer sentinel the producer core returns for an unrecoverable signature.
const UNRECOVERABLE = "(unrecoverable)";

// A dedicated error type for the HARD input errors of THIS helper (a malformed asOf, a non-JSON/wrong-type
// revocations input, an unreadable path). An individual BOGUS revocation is NEVER thrown — it is collected as
// an ignored warning so one bad entry can never abort the evaluation of the good ones.
class RevocationReadError extends Error {
  constructor(message) {
    super(message);
    this.name = "RevocationReadError";
  }
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Canonical-instant parsing (asOf + revokedAt share this).
// ---------------------------------------------------------------------------

function parseCanonicalInstant(value, label) {
  if (typeof value !== "string" || !ISO_INSTANT_RE.test(value)) {
    throw new RevocationReadError(
      `${label} must be an ISO-8601 UTC instant ("YYYY-MM-DDTHH:MM:SS(.mmm)Z"), got: ${String(value)}`
    );
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== value) {
    throw new RevocationReadError(
      `${label} must be a canonical ISO-8601 UTC instant (no rolled-over/impossible fields), got: ${String(value)}`
    );
  }
  return ms;
}

/**
 * Resolve the effective `--as-of` instant. PURE. When the recipient supplied one, validate + use it; when
 * they did not, default to the recipient's CURRENT decision time (`nowISO`, injectable for tests). A
 * malformed explicit `--as-of` is a HARD RevocationReadError (never silently coerced to now). Mirrors
 * cli/core/trust-asof.js resolveAsOf.
 * @param {string|undefined|null} asOf
 * @param {string} nowISO the recipient's current instant (ISO-8601 UTC)
 * @returns {{ asOf: string, defaulted: boolean }}
 */
function resolveAsOf(asOf, nowISO) {
  if (asOf !== undefined && asOf !== null && asOf !== "") {
    parseCanonicalInstant(asOf, "--as-of"); // validate shape; throws on malformed
    return { asOf, defaulted: false };
  }
  if (typeof nowISO !== "string") {
    throw new RevocationReadError("resolveAsOf requires a nowISO instant when --as-of is not given");
  }
  parseCanonicalInstant(nowISO, "nowISO"); // the injected/default now must itself be canonical
  return { asOf: nowISO, defaulted: true };
}

/**
 * Serialize a validated UNSIGNED revocation payload to its CANONICAL, byte-deterministic bytes — a FIXED key
 * order, NO insignificant whitespace, a single trailing newline. This is a LINE-FOR-LINE port of
 * cli/core/revocation.js serializeRevocation: the FIXED field order (kind, schemaVersion, note,
 * vendorAddress, reason, revokedAt) with `supersededBy` appended LAST and ONLY when present. It lets the
 * verifier perform the producer's canonical-bytes BINDING check (`attestation === serializeRevocation(...)`)
 * with NO ethers — the producer's whole point that two logically-identical revocations serialize identically.
 * @param {object} payload an already-structurally-validated revocation payload
 * @returns {string} the canonical serialization (newline-terminated)
 */
function serializeRevocation(payload) {
  const canonical = {
    kind: payload.kind,
    schemaVersion: payload.schemaVersion,
    note: payload.note,
    vendorAddress: payload.vendorAddress,
    reason: payload.reason,
    revokedAt: payload.revokedAt,
  };
  if (Object.prototype.hasOwnProperty.call(payload, "supersededBy") && payload.supersededBy !== undefined) {
    canonical.supersededBy = payload.supersededBy;
  }
  return JSON.stringify(canonical) + "\n";
}

// ---------------------------------------------------------------------------
// Structural validation of a parsed SIGNED revocation container + its embedded payload. A structurally
// invalid container is REJECTED by THROWING (the caller catches + IGNORES it with a warning) — never
// half-accepted.
//
// PARITY-CRITICAL: this MIRRORS the producer's cli/core/attestation.js validateSignedAttestation +
// cli/core/revocation.js validateRevocation so the two stacks IGNORE the EXACT same malformed-but-self-signed
// revocations. The producer's verdict-gating structural checks the verifier MUST replicate (or the offline
// path reaches REVOKED where the producer reaches OK on identical inputs) are:
//   - the CONTAINER carries the right kind, a SUPPORTED schemaVersion, and the standing SIGNED note;
//   - the signature block has a known scheme, a 65-byte LOWERCASE-hex signature, and a lowercase signer;
//   - the EMBEDDED payload re-validates as a sound UNSIGNED revocation: a CLOSED field set (no extra/unknown
//     key), the right kind, a SUPPORTED schemaVersion, the standing UNSIGNED note, a lowercase vendorAddress,
//     a closed-set reason, a canonical revokedAt, an optional lowercase supersededBy; AND
//   - the WRAP-DON'T-EDIT binding: the embedded `attestation` STRING is byte-for-byte the canonical
//     re-serialization of the embedded payload (so a non-canonical / reordered / whitespace variant is
//     IGNORED, exactly as the producer ignores it).
// The signature recovery (verifyRevocation) is what makes a revocation SAFE against forgers; these structural
// checks are what make the verifier's VERDICT EQUAL the producer's on every malformed input it sees.
// ---------------------------------------------------------------------------

function validateSignedRevocation(obj) {
  if (!isPlainObject(obj)) {
    throw new RevocationReadError("revocation container must be a JSON object");
  }
  if (obj.kind !== SIGNED_REVOCATION_KIND) {
    throw new RevocationReadError(
      `not a signed key-revocation (kind ${JSON.stringify(obj.kind)}; expected ${JSON.stringify(SIGNED_REVOCATION_KIND)})`
    );
  }
  // The CONTAINER schemaVersion must be supported (the producer's validateSignedAttestation rejects an
  // unsupported one before any recovery — so the verifier must too).
  if (!SUPPORTED_SIGNED_REVOCATION_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new RevocationReadError(
      `unsupported signed revocation schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(SUPPORTED_SIGNED_REVOCATION_SCHEMA_VERSIONS)})`
    );
  }
  // The CONTAINER note must be the standing SIGNED note (the producer pins it; a drifted note is IGNORED).
  if (obj.note !== SIGNED_REVOCATION_TRUST_NOTE) {
    throw new RevocationReadError("signed revocation `note` must be the standing SIGNED_REVOCATION_TRUST_NOTE");
  }
  if (typeof obj.attestation !== "string") {
    throw new RevocationReadError("signed revocation must embed the canonical UNSIGNED bytes as a string `attestation`");
  }
  const sig = obj.signature;
  if (!isPlainObject(sig)) {
    throw new RevocationReadError("signed revocation is missing a { scheme, signer, signature } signature block");
  }
  if (sig.scheme !== "eip191-personal-sign") {
    throw new RevocationReadError(
      `unsupported signature scheme: ${JSON.stringify(sig.scheme)} (this verifier understands eip191-personal-sign)`
    );
  }
  // LOWERCASE-only signer + signature, byte-for-byte the producer's ADDRESS_RE / EIP191_SIG_RE — a
  // mixed/upper-case re-encoding is IGNORED by the producer, so it must be ignored here too.
  if (typeof sig.signer !== "string" || !PAYLOAD_ADDRESS_RE.test(sig.signer)) {
    throw new RevocationReadError(
      "signed revocation signer must be a 0x-prefixed 20-byte LOWERCASE-hex address (mixed/upper case rejected for byte-determinism)"
    );
  }
  if (typeof sig.signature !== "string" || !SIGNATURE_RE.test(sig.signature)) {
    throw new RevocationReadError(
      "signed revocation signature must be a 65-byte (r||s||v) 0x-prefixed LOWERCASE-hex string (mixed/upper case rejected for byte-determinism)"
    );
  }

  // Parse + strictly validate the embedded revocation payload (the producer's validateRevocation, mirrored).
  let rev;
  try {
    rev = JSON.parse(obj.attestation);
  } catch (e) {
    throw new RevocationReadError(`embedded revocation is not valid JSON: ${e.message}`);
  }
  if (!isPlainObject(rev)) {
    throw new RevocationReadError("embedded revocation payload must be a JSON object");
  }
  // CLOSED FIELD SET: an unknown/extraneous key is a HARD reject (the producer IGNORES such a revocation).
  for (const key of Object.keys(rev)) {
    if (!REVOCATION_FIELDS.includes(key)) {
      throw new RevocationReadError(
        `revocation has an unknown field: ${JSON.stringify(key)} (the closed field set is ${JSON.stringify(REVOCATION_FIELDS)})`
      );
    }
  }
  if (rev.kind !== REVOCATION_KIND) {
    throw new RevocationReadError(
      `embedded payload is not a key revocation (kind ${JSON.stringify(rev.kind)}; expected ${JSON.stringify(REVOCATION_KIND)})`
    );
  }
  if (!SUPPORTED_REVOCATION_SCHEMA_VERSIONS.includes(rev.schemaVersion)) {
    throw new RevocationReadError(
      `unsupported revocation schemaVersion: ${JSON.stringify(rev.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(SUPPORTED_REVOCATION_SCHEMA_VERSIONS)})`
    );
  }
  if (rev.note !== REVOCATION_TRUST_NOTE) {
    throw new RevocationReadError("revocation `note` must be the standing REVOCATION_TRUST_NOTE (caveat must not drift)");
  }
  if (typeof rev.vendorAddress !== "string" || !PAYLOAD_ADDRESS_RE.test(rev.vendorAddress)) {
    throw new RevocationReadError(
      `revocation vendorAddress must be a 0x-prefixed 20-byte LOWERCASE-hex address, got: ${String(rev.vendorAddress)}`
    );
  }
  if (typeof rev.reason !== "string" || !REVOCATION_REASON_SET.includes(rev.reason)) {
    throw new RevocationReadError(
      `revocation reason must be one of ${JSON.stringify(REVOCATION_REASON_SET)}, got: ${JSON.stringify(rev.reason)}`
    );
  }
  parseCanonicalInstant(rev.revokedAt, "revocation revokedAt"); // throws on a non-canonical instant
  if (
    Object.prototype.hasOwnProperty.call(rev, "supersededBy") &&
    rev.supersededBy !== undefined &&
    (typeof rev.supersededBy !== "string" || !PAYLOAD_ADDRESS_RE.test(rev.supersededBy))
  ) {
    throw new RevocationReadError(
      `revocation supersededBy, when present, must be a 0x-prefixed 20-byte LOWERCASE-hex address, got: ${String(rev.supersededBy)}`
    );
  }
  // WRAP-DON'T-EDIT BINDING (the producer's `obj.attestation !== cfg.serializeUnsigned(embedded)` gate). The
  // embedded STRING must be byte-for-byte the canonical re-serialization of the embedded payload — so a
  // reordered-keys / extra-whitespace / otherwise non-canonical (but genuinely self-signed) variant is
  // IGNORED here exactly as the producer ignores it. THIS is the check that closes the headline parity gap.
  if (obj.attestation !== serializeRevocation(rev)) {
    throw new RevocationReadError(
      "embedded revocation is not in canonical form (the signed-over bytes must be byte-for-byte the canonical serialization)"
    );
  }
  return { container: obj, revocation: rev };
}

/**
 * Verify (purely, OFFLINE) a parsed SIGNED revocation container — the STACK-FREE mirror of the producer's
 * verifyRevocation. It recovers the signer from the embedded canonical bytes + signature and:
 *   (1) confirms it equals the container's CLAIMED `signer` (signatureMatchesSigner — ALWAYS run);
 *   (2) confirms it equals the revocation's OWN embedded `vendorAddress` (vendorAddressMatchesSigner — the
 *       load-bearing SELF-CONTROL check: a key revokes ITSELF).
 * The verdict is ACCEPTED only when BOTH pass; a forged/tampered/third-party revocation is a clean REJECTED.
 * A structurally invalid container THROWS (RevocationReadError) before any recovery, so an ordinary REJECTED
 * verdict only ever describes a STRUCTURALLY SOUND revocation whose signature simply doesn't back its claims.
 *
 * @param {object} container a parsed signed-revocation container object
 * @returns {{ accepted, recoveredSigner, claimedSigner, vendorAddress, reason, revokedAt, supersededBy, failedChecks }}
 */
function verifyRevocation(container) {
  const { revocation } = validateSignedRevocation(container);
  const claimedSigner = container.signature.signer.toLowerCase();
  const vendorAddress = revocation.vendorAddress;

  // Recover the signer from the EXACT embedded bytes. A tampered/corrupt signature can be UNRECOVERABLE (no
  // valid curve point) — that throws; we map it to the "(unrecoverable)" sentinel, never a crash, mirroring
  // the producer core's catch.
  let recoveredSigner;
  try {
    recoveredSigner = recoverPersonalSignAddress(container.attestation, container.signature.signature);
  } catch (_) {
    recoveredSigner = UNRECOVERABLE;
  }

  const signatureMatchesSigner = recoveredSigner === claimedSigner;
  const vendorAddressMatchesSigner = recoveredSigner === vendorAddress;

  const failedChecks = [];
  if (!signatureMatchesSigner) failedChecks.push("signatureMatchesSigner");
  if (!vendorAddressMatchesSigner) failedChecks.push("vendorAddressMatchesSigner");

  return {
    accepted: failedChecks.length === 0,
    recoveredSigner,
    claimedSigner,
    vendorAddress,
    reason: revocation.reason,
    revokedAt: revocation.revokedAt,
    supersededBy: Object.prototype.hasOwnProperty.call(revocation, "supersededBy")
      ? revocation.supersededBy
      : null,
    failedChecks,
  };
}

// ---------------------------------------------------------------------------
// Normalize the `revocations` input into a flat array of entries to evaluate. PURE. Accepts an ARRAY of
// already-parsed containers (or JSON strings), a single container object, or a JSON STRING of either (a
// bundle file is a JSON ARRAY of containers, or a single container object). A per-entry parse failure becomes
// a `_parseError` marker (IGNORED with a warning); a WHOLE-input parse failure HARD-errors. Mirrors
// cli/core/trust-asof.js normalizeRevocationsInput.
// ---------------------------------------------------------------------------

function normalizeRevocationsInput(revocations) {
  if (typeof revocations === "string") {
    let parsed;
    try {
      parsed = JSON.parse(revocations);
    } catch (e) {
      throw new RevocationReadError(`revocations input is not valid JSON: ${e.message}`);
    }
    return normalizeRevocationsInput(parsed);
  }
  if (Array.isArray(revocations)) {
    return revocations.map((el) => {
      if (typeof el === "string") {
        try {
          return JSON.parse(el);
        } catch (e) {
          return { _parseError: `entry is not valid JSON: ${e.message}`, _raw: el };
        }
      }
      return el;
    });
  }
  if (isPlainObject(revocations)) {
    return [revocations];
  }
  throw new RevocationReadError(
    "revocations input must be a signed-revocation container, an array of them, or JSON text of either"
  );
}

// Classify ONE already-parsed revocation entry against the subject + as-of pivot. PURE. Mirrors
// cli/core/trust-asof.js classifyRevocation exactly (the same `applies`/`later`/`irrelevant`/`ignored`
// outcomes + the inclusive `revokedAt <= asOf` boundary).
function classifyRevocation(entry, subject, asOfMs) {
  if (entry && entry._parseError) {
    return { kind: "ignored", warning: `ignored an unparseable revocation entry (${entry._parseError})` };
  }
  let v;
  try {
    v = verifyRevocation(entry);
  } catch (e) {
    return { kind: "ignored", warning: `ignored a malformed/foreign revocation (${e.message})` };
  }
  if (!v.accepted) {
    return {
      kind: "ignored",
      warning:
        `ignored a revocation that does not verify (failed: ${v.failedChecks.join(", ")}; ` +
        `vendorAddress ${v.vendorAddress}) — a forged/tampered/third-party revocation never downgrades trust`,
    };
  }
  if (v.vendorAddress !== subject) {
    return { kind: "irrelevant", vendorAddress: v.vendorAddress };
  }
  const revokedAtMs = Date.parse(v.revokedAt);
  const detail = {
    vendorAddress: v.vendorAddress,
    reason: v.reason,
    revokedAt: v.revokedAt,
    supersededBy: v.supersededBy,
  };
  // Inclusive on the revoked side: a revocation effective EXACTLY at the as-of instant counts as revoked.
  if (revokedAtMs <= asOfMs) {
    return { kind: "applies", ...detail };
  }
  return { kind: "later", ...detail };
}

/**
 * THE RECIPIENT-SIDE TRUST-DECISION-AS-OF. PURE / OFFLINE / KEY-FREE / I/O-FREE / CLOCK-FREE. Identical
 * semantics to cli/core/trust-asof.js evaluateTrustAsOf (so verify-vh's downgrade matches the producer's
 * byte-for-byte). Returns a stable decision block.
 * @param {object} params { subject, asOf, revocations }
 * @returns {{ status, revoked, subject, asOf, governing, laterRevoked, counts, ignored }}
 */
function evaluateTrustAsOf(params) {
  if (!isPlainObject(params)) {
    throw new RevocationReadError("evaluateTrustAsOf requires { subject, asOf, revocations }");
  }
  const { subject, asOf, revocations } = params;
  if (typeof subject !== "string" || subject.length === 0) {
    throw new RevocationReadError("evaluateTrustAsOf requires a string `subject` (the artifact's recovered signer)");
  }
  const asOfMs = parseCanonicalInstant(asOf, "--as-of");
  const entries = normalizeRevocationsInput(revocations);

  // A non-address subject (the "(unrecoverable)" sentinel) cannot be matched by any revocation — still
  // evaluate every entry (so forged ones are reported as ignored), but no SOUND revocation can apply.
  const subjectIsAddress = ADDRESS_RE.test(subject);

  const applicable = [];
  const later = [];
  let irrelevant = 0;
  const ignored = [];

  for (const entry of entries) {
    const c = classifyRevocation(entry, subject, asOfMs);
    if (c.kind === "ignored") ignored.push(c.warning);
    else if (c.kind === "irrelevant") irrelevant += 1;
    else if (c.kind === "later") later.push(c);
    else if (c.kind === "applies") applicable.push(c);
  }

  // The GOVERNING revocation is the EARLIEST applicable one (smallest revokedAt), tie-broken deterministically
  // on vendorAddress then reason — the instant from which the key was no longer trustworthy.
  const sortByEffective = (a, b) =>
    Date.parse(a.revokedAt) - Date.parse(b.revokedAt) ||
    (a.vendorAddress < b.vendorAddress ? -1 : a.vendorAddress > b.vendorAddress ? 1 : 0) ||
    (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0);

  const govern = (arr) => {
    if (arr.length === 0) return null;
    const [g] = arr.slice().sort(sortByEffective);
    return { vendorAddress: g.vendorAddress, reason: g.reason, revokedAt: g.revokedAt, supersededBy: g.supersededBy };
  };

  const governing = govern(applicable);
  const laterRevoked = governing ? null : govern(later);

  let status;
  if (governing) status = "REVOKED";
  else if (!subjectIsAddress) status = "UNEVALUABLE";
  else status = "OK";

  return {
    status,
    revoked: status === "REVOKED",
    subject,
    asOf,
    governing,
    laterRevoked,
    counts: {
      total: entries.length,
      applicable: applicable.length,
      later: later.length,
      irrelevant,
      ignored: ignored.length,
    },
    ignored,
  };
}

/**
 * Fold a TRUST-DECISION-AS-OF onto an existing verify-vh result, OFFLINE. PURE. Mirrors cli/core/trust-asof.js
 * applyToVerifyResult: it NEVER upgrades a verdict — an already-REJECTED artifact stays rejected; the
 * trust-as-of only ever ADDS a REVOKED downgrade on top of an otherwise-ACCEPTED artifact. Returns a NEW
 * result object (the original is not mutated): the original fields PLUS `trustAsOf`, with accepted/verdict/
 * reason updated when REVOKED.
 *
 * The `subject` is the artifact's RECOVERED signer. When the signature did not even recover (the
 * "(unrecoverable)" sentinel / a null), no revocation can bind — the decision is UNEVALUABLE and never
 * changes the (already-rejected) verdict.
 *
 * @param {object} params { result, revocations, asOf }
 * @returns {object} a new result with `trustAsOf` attached
 */
function applyToVerifyResult(params) {
  if (!isPlainObject(params) || !isPlainObject(params.result)) {
    throw new RevocationReadError("applyToVerifyResult requires { result, revocations, asOf }");
  }
  const { result, revocations, asOf } = params;
  // The subject is the recovered signer. verify-vh leaves recoveredSigner null for an UNSIGNED artifact and
  // sets the "(unrecoverable)" sentinel for a broken signature — both are non-addresses, so neither binds.
  const subject =
    typeof result.recoveredSigner === "string" && result.recoveredSigner.length > 0
      ? result.recoveredSigner
      : UNRECOVERABLE;

  const decision = evaluateTrustAsOf({ subject, asOf, revocations });
  const out = { ...result, trustAsOf: decision };

  if (decision.revoked) {
    // The ONLY downgrading path: an otherwise-ACCEPTED artifact whose signer was revoked-before-as-of becomes
    // REVOKED (exit 3). We flip accepted=false + set a distinct REVOKED verdict + a named reason so the
    // existing `accepted ? 0 : 3` exit mapping yields exit 3, byte-for-byte with the producer.
    out.accepted = false;
    out.verdict = "REVOKED";
    out.reason = "key_revoked_as_of";
  }
  return out;
}

/**
 * Render the human-readable TRUST-DECISION-AS-OF lines verify-vh appends to its report. PURE. Returns an
 * array of lines. Mirrors cli/core/trust-asof.js renderTrustAsOf's content so the two stacks read the same.
 * @param {object} decision the object evaluateTrustAsOf returns
 * @param {{ defaulted?: boolean, indent?: string }} [ctx]
 * @returns {string[]} lines
 */
function renderTrustAsOf(decision, ctx = {}) {
  const I = ctx.indent || "";
  const L = [];
  const asOfNote = ctx.defaulted ? " (defaulted to now; pass --as-of <ISO> to pin the decision instant)" : "";
  L.push(`${I}revocation check (as of ${decision.asOf})${asOfNote}:`);
  if (decision.status === "REVOKED") {
    const g = decision.governing;
    L.push(
      `${I}  [REVOKED] the signing key (${g.vendorAddress}) was REVOKED as of ${g.revokedAt} ` +
        `(reason: ${g.reason})${g.supersededBy ? `, superseded by ${g.supersededBy}` : ""} — at or before ` +
        `the as-of instant. This artifact is NOT trustworthy as of ${decision.asOf}.`
    );
  } else if (decision.status === "UNEVALUABLE") {
    L.push(`${I}  [skip] the signature did not recover to a key — no subject to evaluate revocations against.`);
  } else {
    L.push(`${I}  [OK] no applicable revocation: the signing key was not revoked as of ${decision.asOf}.`);
    if (decision.laterRevoked) {
      const lr = decision.laterRevoked;
      L.push(
        `${I}  [note] this key (${lr.vendorAddress}) IS revoked as of ${lr.revokedAt} ` +
          `(reason: ${lr.reason})${lr.supersededBy ? `, superseded by ${lr.supersededBy}` : ""} — AFTER your ` +
          `as-of instant, so it does NOT downgrade THIS decision (informational).`
      );
    }
  }
  for (const w of decision.ignored) {
    L.push(`${I}  [warning] ${w}`);
  }
  return L;
}

// ---------------------------------------------------------------------------
// FILE-OR-DIR reader. The ONLY I/O in this module. A counterparty may hand the verifier a SINGLE revocation
// file (one container, or a JSON array of them) OR a DIRECTORY of revocation files — a vendor commonly
// publishes one file per revoked key. Reading a directory aggregates every entry into ONE array of parsed
// containers, so the as-of decision sees them all under one --revocations flag.
//
// DIRECTORY MODE: read every *.json / *.vhrevocation.json file in the dir (NON-recursive — a flat folder of
// revocations), parse each, and flatten (a file that is itself a JSON array contributes all its entries). A
// file that is not valid JSON, or whose JSON is not an object/array, becomes a `_parseError` marker so it is
// IGNORED with a warning downstream — a single junk file in the folder never aborts the decision.
//
// FILE MODE: read the one file's text and hand it to normalizeRevocationsInput (so a single file may be one
// container OR a JSON array). A non-JSON single file HARD-errors (the recipient pointed --revocations at
// bytes that aren't a revocations input at all) — same contract as the producer's single-file read.
// ---------------------------------------------------------------------------

// File extensions a directory scan treats as candidate revocation files.
const REVOCATION_FILE_RE = /\.(json|vhrevocation\.json)$/i;

/**
 * Read the --revocations <file-or-dir> path into a normalized array of parsed entries (each a container
 * object or a `_parseError` marker). The caller passes the already-resolved array straight to
 * evaluateTrustAsOf/applyToVerifyResult.
 *
 * @param {string} p the --revocations path (a file or a directory)
 * @param {{ readFile?: Function, statSync?: Function, readdirSync?: Function }} [io] injectable fs for tests
 * @returns {Array<object>} a flat array of parsed entries (containers or `_parseError` markers)
 * @throws {RevocationReadError} on an unreadable path or a non-JSON SINGLE file
 */
function readRevocationsFromPath(p, io = {}) {
  const readFile = io.readFile || ((f) => fs.readFileSync(f, "utf8"));
  const statSync = io.statSync || ((f) => fs.statSync(f));
  const readdirSync = io.readdirSync || ((d) => fs.readdirSync(d));

  let st;
  try {
    st = statSync(p);
  } catch (e) {
    throw new RevocationReadError(`cannot read --revocations ${p}: ${e.message}`);
  }

  if (st.isDirectory()) {
    let names;
    try {
      names = readdirSync(p);
    } catch (e) {
      throw new RevocationReadError(`cannot read --revocations directory ${p}: ${e.message}`);
    }
    // Deterministic order (sorted) so the governing tie-break + ignored-warning order are stable.
    const files = names
      .filter((n) => REVOCATION_FILE_RE.test(n))
      .sort()
      .map((n) => path.join(p, n));
    const entries = [];
    for (const f of files) {
      let text;
      try {
        text = readFile(f);
      } catch (e) {
        entries.push({ _parseError: `cannot read ${path.basename(f)}: ${e.message}`, _raw: f });
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        entries.push({ _parseError: `${path.basename(f)} is not valid JSON: ${e.message}`, _raw: f });
        continue;
      }
      // A file may itself be a single container OR a JSON array of them — flatten either into the pool.
      if (Array.isArray(parsed)) {
        for (const el of parsed) entries.push(el);
      } else if (isPlainObject(parsed)) {
        entries.push(parsed);
      } else {
        entries.push({ _parseError: `${path.basename(f)} is not a revocation object/array`, _raw: f });
      }
    }
    return entries;
  }

  // Single file: read its text and normalize (a non-JSON single file HARD-errors via normalizeRevocationsInput).
  let text;
  try {
    text = readFile(p);
  } catch (e) {
    throw new RevocationReadError(`cannot read --revocations ${p}: ${e.message}`);
  }
  return normalizeRevocationsInput(text);
}

/**
 * The ONE shared integration verify-vh calls: read the --revocations file-or-dir, resolve the --as-of
 * (defaulting to nowISO), evaluate the decision, and fold it onto the verify result. Runs ONLY when
 * `revocationsPath` is truthy; with no path it returns the result UNCHANGED + a null decision (the
 * regression-safety contract — with no --revocations the verifier is byte-identical to today).
 *
 * @param {object} params { result, revocationsPath, asOf, nowISO, io? }
 * @returns {{ result, decision, defaulted }}
 */
function loadAndApply(params) {
  if (!isPlainObject(params) || !isPlainObject(params.result)) {
    throw new RevocationReadError("loadAndApply requires { result, revocationsPath, asOf, nowISO }");
  }
  const { result, revocationsPath, asOf, nowISO, io } = params;
  if (!revocationsPath) {
    return { result, decision: null, defaulted: false };
  }
  const { asOf: effectiveAsOf, defaulted } = resolveAsOf(asOf, nowISO);
  const entries = readRevocationsFromPath(revocationsPath, io || {});
  const out = applyToVerifyResult({ result, revocations: entries, asOf: effectiveAsOf });
  return { result: out, decision: out.trustAsOf, defaulted };
}

module.exports = {
  RevocationReadError,
  SIGNED_REVOCATION_KIND,
  REVOCATION_KIND,
  REVOCATION_SCHEMA_VERSION,
  SUPPORTED_REVOCATION_SCHEMA_VERSIONS,
  SUPPORTED_SIGNED_REVOCATION_SCHEMA_VERSIONS,
  REVOCATION_REASON_SET,
  REVOCATION_FIELDS,
  REVOCATION_TRUST_NOTE,
  SIGNED_REVOCATION_TRUST_NOTE,
  ISO_INSTANT_RE,
  UNRECOVERABLE,
  parseCanonicalInstant,
  resolveAsOf,
  serializeRevocation,
  validateSignedRevocation,
  verifyRevocation,
  normalizeRevocationsInput,
  classifyRevocation,
  evaluateTrustAsOf,
  applyToVerifyResult,
  renderTrustAsOf,
  readRevocationsFromPath,
  loadAndApply,
};

"use strict";

// cli/core/revocation.js — the PURE producer-key REVOCATION core for verifyhash (EPIC-51 / T-51.1).
//
// WHY THIS EXISTS
//   Every sealed/signed artifact this family mints (an evidence seal, a signed license, a dataset/parcel
//   attestation, an identity card) is trusted because a vendor's signing KEY backs it. But a key can be
//   compromised, leave with a contractor, or simply be rotated. Today there is NO first-class, OFFLINE-
//   verifiable way for that vendor to SAY "this key is revoked as of D" — so every artifact the key ever
//   signed keeps verifying as ACCEPTED forever, and a recipient has no way to ask "was this key still good
//   when THIS exhibit was sealed?". The producer REVOCATION statement closes that first gap: a vendor
//   SIGNS, with the SAME key that signed their evidence/licenses/cards, a small self-describing container
//   that marks that key's own `vendorAddress` revoked as of a point in time, for a bounded reason, and
//   OPTIONALLY names a `supersededBy` successor key. A recipient who holds the revocation can recover the
//   signer and confirm it equals the revocation's OWN `vendorAddress` — all OFFLINE, no network, no key,
//   no I/O.
//
// IT IS JUST ONE MORE PRODUCT ON THE SHARED SIGNED-ATTESTATION ENVELOPE.
//   Exactly like the seal/license/dataset/identity-card, the revocation defines an UNSIGNED PAYLOAD (a
//   versioned object: vendorAddress + a CLOSED reason + revokedAt + optional supersededBy + note), a
//   canonical serializer, and a strict validator, then hands those to `cli/core/attestation.js` as the
//   product framing. The attestation core does ALL the crypto: it embeds the EXACT canonical payload
//   bytes as the `attestation`, attaches the detached EIP-191 signature, and later RE-DERIVES the signer
//   from those bytes. There is NO new crypto here, NO new dependency, NO new scheme — `buildRevocation`
//   wraps via `signAttestation`, `verifyRevocation` recovers via `verifySignedAttestation`, byte-for-byte
//   the SAME shared paths the identity card uses. We REUSE core/attestation.js VERBATIM — we never fork
//   the signing/recovery path.
//
// THE LOAD-BEARING SELF-CONTROL INVARIANT — a key REVOKES ITSELF.
//   A revocation carries its OWN `vendorAddress` INSIDE the signed payload, so it asserts "the holder of
//   THIS key declares THIS address revoked". `verifyRevocation` therefore REQUIRES recovered === the
//   embedded `vendorAddress`: a revocation whose signature recovers to any OTHER key is REJECTED
//   (`vendorAddressMatchesSigner` fails), never a silent accept. This is the whole point — a THIRD PARTY
//   cannot revoke a key it does not control (otherwise anyone could grief any vendor by "revoking" their
//   key). `buildRevocation` enforces the SAME invariant at mint time — it refuses to produce a revocation
//   for an address the provisioned signer does not control — so a revocation can never round-trip into a
//   false ACCEPT. This mirrors the EPIC-49 identity-card mint invariant exactly.
//
// PURE + I/O-FREE + KEY-AGNOSTIC.
//   Every function here is pure: no filesystem, no clock, no network. (readRevocation parses a JSON
//   STRING/object — it does NOT read a file; the file read is the CLI layer's job in T-51.3.) The only key
//   handling is a passed-in ethers signer-like object (an ephemeral `Wallet.createRandom()` in tests; the
//   loop NEVER holds a real key) whose private key lives ONLY inside that object — never read, persisted,
//   or logged here. The `revokedAt` instant is a CALLER-supplied argument; this core never reads the system
//   clock, so the same inputs always yield byte-identical bytes + verdict. PRODUCT-AGNOSTIC: this module
//   requires the GENERIC attestation core, never the reverse — no back-edge.

const coreAttestation = require("./attestation");
const { getAddress } = require("ethers");

// On-disk schema discriminators. The revocation carries its OWN kind + version (distinct from every
// seal/license/manifest/identity-card kind) so a random JSON file, a license, a seal, or a card is never
// misread as a revocation.
const REVOCATION_KIND = "vh-key-revocation";
const REVOCATION_SCHEMA_VERSION = 1;
const SUPPORTED_REVOCATION_SCHEMA_VERSIONS = Object.freeze([1]);

// The SIGNED-container framing (the detached-signature envelope kind) — its OWN discriminator.
const SIGNED_REVOCATION_KIND = "vh-key-revocation-signed";
const SIGNED_REVOCATION_SCHEMA_VERSION = 1;
const SUPPORTED_SIGNED_REVOCATION_SCHEMA_VERSIONS = Object.freeze([1]);

// The CLOSED reason set. A revocation declares WHY the key is being revoked; an out-of-set value is a HARD
// build/validate error (never silently honored), exactly like the identity card's closed productLine and
// the license core's closed entitlement table. Frozen + a derived sorted list so error messages are
// deterministic. These are the lifecycle events that make a key's past signatures suspect (compromised /
// retired) or simply rotated (superseded / rotated) — a small, fixed vocabulary a recipient can reason about.
const REVOCATION_REASONS = Object.freeze(["compromised", "rotated", "superseded", "retired"]);
const REVOCATION_REASON_SET = Object.freeze(REVOCATION_REASONS.slice().sort());

// A claimed 0x-address INSIDE the payload: 0x + 40 LOWERCASE hex chars. Lowercase-only for the SAME
// byte-determinism reason the attestation core lowercases the signer — an EIP-55-checksummed address is the
// canonical address in a DIFFERENT encoding, so accepting it verbatim would let one vendor serialize two
// ways. A caller holding a checksummed address lowercases it before building the revocation (buildRevocation
// normalizes for them via getAddress, so a checksummed input is accepted and canonicalized).
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

// A strict ISO-8601 UTC instant ("YYYY-MM-DDTHH:MM:SS(.mmm)Z"). Same canonical instant grammar the identity
// card pins publishedAt to, so two logically-identical revocations serialize to identical bytes. We pin the
// SHAPE here and require the canonical millis round-trip below.
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

// The in-band trust caveat — stated ONCE so the human + JSON paths agree and the boundary can never drift.
// It is the load-bearing honesty of the artifact: a revocation proves the KEY-HOLDER SAID "revoked as of D";
// it is NOT a trusted wall-clock timestamp (the `revokedAt` instant rides the human-owned timestamp
// trust-root, P-3 — public summary at docs/TRUST-BOUNDARIES.md#p-3-trust-root), and it is NOT a legal opinion.
// FROZEN WIRE BYTES (T-78.2): the note below is embedded VERBATIM in every published revocation and pinned
// byte-for-byte at verify time (here and in verifier/lib/revocation-core.js + the dist bundles) —
// repointing its internal "STRATEGY.md P-3" reference would invalidate every already-issued revocation.
// New prose must point at the public anchor above, never at the internal strategy log.
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

// A dedicated error type so callers/tests catch ONE revocation error for the HARD validation failures
// (a closed-field/closed-reason/malformed-address/non-canonical-date violation, an out-of-control mint). An
// ordinary verify REJECT is NOT thrown — it is a clean verdict (verdict: "REJECTED"), exactly like the rest
// of the family.
class RevocationError extends Error {
  constructor(message) {
    super(message);
    this.name = "RevocationError";
  }
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// The CLOSED field set of an UNSIGNED revocation payload. An UNKNOWN/extraneous key is a HARD error (never
// silently dropped) so the revocation's shape ossifies with exactly these fields. `kind`/`schemaVersion`/
// `note` are the framing the core fixes; the rest is the producer-supplied revocation. `supersededBy` is
// OPTIONAL — it is a member of the closed set (so a present-but-malformed value HARD-errors) but absence is
// allowed (validated below).
const REVOCATION_FIELDS = Object.freeze([
  "kind",
  "schemaVersion",
  "note",
  "vendorAddress",
  "reason",
  "revokedAt",
  "supersededBy",
]);

/**
 * STRICT structural validation of an UNSIGNED revocation payload. Throws a RevocationError on the FIRST
 * problem (named + localized); returns the object unchanged on success. NEVER half-accepts and NEVER fills
 * defaults. This is the `validateUnsigned` the attestation core re-runs on the embedded payload (the
 * wrap-don't-edit invariant), so a signed container can never smuggle a malformed/edited revocation.
 *
 * REJECTS (HARD): a non-object; a wrong kind/schemaVersion/note; an UNKNOWN/extraneous field; a missing/
 * malformed (not lowercase-0x) vendorAddress; an out-of-set reason; a non-canonical-ISO revokedAt; a
 * present-but-malformed (not lowercase-0x) supersededBy. `supersededBy` may be ABSENT (optional); when
 * present it must be a valid lowercase-0x address.
 *
 * @param {any} obj
 * @returns {object} the same object, if valid
 */
function validateRevocation(obj) {
  if (!isPlainObject(obj)) {
    throw new RevocationError("revocation payload must be a JSON object");
  }

  // CLOSED FIELD SET: every key must be one of REVOCATION_FIELDS. An unknown/extraneous key HARD-errors
  // (never silently kept) so the revocation can never carry a smuggled, unvalidated field.
  for (const key of Object.keys(obj)) {
    if (!REVOCATION_FIELDS.includes(key)) {
      throw new RevocationError(
        `revocation has an unknown field: ${JSON.stringify(key)} ` +
          `(the closed field set is ${JSON.stringify(REVOCATION_FIELDS)})`
      );
    }
  }

  if (obj.kind !== REVOCATION_KIND) {
    throw new RevocationError(
      `not a verifyhash revocation (kind: ${JSON.stringify(obj.kind)}; expected ${JSON.stringify(REVOCATION_KIND)})`
    );
  }
  if (!SUPPORTED_REVOCATION_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new RevocationError(
      `unsupported revocation schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(SUPPORTED_REVOCATION_SCHEMA_VERSIONS)})`
    );
  }
  if (obj.note !== REVOCATION_TRUST_NOTE) {
    throw new RevocationError(
      "revocation `note` must be the standing REVOCATION_TRUST_NOTE (caveat must not drift)"
    );
  }

  // vendorAddress — the address the revocation BINDS to the signing key (the key that revokes ITSELF). A
  // lowercase 0x-address (checksummed/mixed-case is rejected here for byte-determinism; buildRevocation
  // lowercases a checksummed input).
  if (typeof obj.vendorAddress !== "string" || !ADDRESS_RE.test(obj.vendorAddress)) {
    throw new RevocationError(
      "revocation vendorAddress must be a 0x-prefixed 20-byte LOWERCASE-hex address " +
        `(checksummed/mixed-case rejected for byte-determinism — lowercase it first), got: ${String(obj.vendorAddress)}`
    );
  }

  // reason — a single value drawn from the CLOSED REVOCATION_REASONS set. An out-of-set value HARD-errors.
  if (typeof obj.reason !== "string" || !REVOCATION_REASON_SET.includes(obj.reason)) {
    throw new RevocationError(
      `revocation reason must be one of the closed set ${JSON.stringify(REVOCATION_REASON_SET)}, ` +
        `got: ${JSON.stringify(obj.reason)}`
    );
  }

  // revokedAt — a strict, CANONICAL ISO-8601 UTC instant. The regex pins the SHAPE; the millis round-trip
  // FORCES the `.mmm` form and REJECTS every rolled-over/impossible instant (e.g. Feb-29 in a non-leap year),
  // exactly like the identity card, so a self-asserted date can never silently coerce.
  if (typeof obj.revokedAt !== "string" || !ISO_INSTANT_RE.test(obj.revokedAt)) {
    throw new RevocationError(
      `revocation revokedAt must be an ISO-8601 UTC instant ("YYYY-MM-DDTHH:MM:SS(.mmm)Z"), got: ${String(obj.revokedAt)}`
    );
  }
  const ms = Date.parse(obj.revokedAt);
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== obj.revokedAt) {
    throw new RevocationError(
      `revocation revokedAt must be a canonical ISO-8601 UTC instant ("YYYY-MM-DDTHH:MM:SS.mmmZ", ` +
        `millis required, no rolled-over/impossible fields), got: ${String(obj.revokedAt)}`
    );
  }

  // supersededBy — OPTIONAL. When ABSENT (the key is undefined OR not present), that is allowed: a plain
  // revocation supersedes the key with nothing. When PRESENT it must be a valid lowercase-0x address (a
  // present-but-malformed / checksummed / non-string value HARD-errors — never silently dropped). We do NOT
  // permit `null` to mean "absent": a null value is a present-but-invalid address, rejected, so the wire
  // form has exactly one encoding of "no successor" (the key simply omitted).
  if (Object.prototype.hasOwnProperty.call(obj, "supersededBy") && obj.supersededBy !== undefined) {
    if (typeof obj.supersededBy !== "string" || !ADDRESS_RE.test(obj.supersededBy)) {
      throw new RevocationError(
        "revocation supersededBy, when present, must be a 0x-prefixed 20-byte LOWERCASE-hex address " +
          `(checksummed/mixed-case rejected for byte-determinism — lowercase it first), got: ${String(obj.supersededBy)}`
      );
    }
  }

  return obj;
}

/**
 * Serialize a validated UNSIGNED revocation payload to its canonical, byte-deterministic bytes: a FIXED key
 * order, NO insignificant whitespace, a single trailing newline. `supersededBy` is emitted ONLY when present
 * (an absent successor is OMITTED, never written as null) so the wire form has exactly one encoding of "no
 * successor". This is the EXACT byte sequence the envelope signs over and verifyRevocation re-derives the
 * signer from, so two logically-identical revocations sign identically.
 * @param {object} payload a validated revocation payload
 * @returns {string} the canonical serialization (newline-terminated)
 */
function serializeRevocation(payload) {
  validateRevocation(payload);
  const canonical = {
    kind: payload.kind,
    schemaVersion: payload.schemaVersion,
    note: payload.note,
    vendorAddress: payload.vendorAddress,
    reason: payload.reason,
    revokedAt: payload.revokedAt,
  };
  // OPTIONAL `supersededBy` is appended LAST and ONLY when present — so the canonical bytes of a revocation
  // without a successor never carry a null/empty slot, and one with a successor always carries it in the
  // SAME fixed position.
  if (Object.prototype.hasOwnProperty.call(payload, "supersededBy") && payload.supersededBy !== undefined) {
    canonical.supersededBy = payload.supersededBy;
  }
  return JSON.stringify(canonical) + "\n";
}

/**
 * Assemble + strictly validate an UNSIGNED revocation payload from caller fields. PURE. This is the payload
 * `buildRevocation` then wraps in the signed envelope. Splitting it out lets a caller hold/inspect the
 * unsigned revocation before signing (and validates it the SAME way the embedded payload is re-validated on
 * read). A checksummed/mixed-case vendorAddress/supersededBy is normalized to lowercase here (a syntactically
 * invalid address HARD-errors); every other field passes through to validateRevocation.
 *
 * @param {object} params { vendorAddress, reason, revokedAt, [supersededBy] }
 * @returns {object} a validated, canonicalized revocation payload
 */
function buildRevocationPayload(params) {
  if (!isPlainObject(params)) {
    throw new RevocationError(
      "buildRevocationPayload requires a { vendorAddress, reason, revokedAt, [supersededBy] } object"
    );
  }
  // Normalize a checksummed/mixed-case vendorAddress to canonical lowercase (so a caller may paste an EIP-55
  // address). A syntactically invalid address is a HARD error (named, no surprise).
  let vendorAddress;
  try {
    vendorAddress = getAddress(params.vendorAddress).toLowerCase();
  } catch (_e) {
    throw new RevocationError(
      `revocation vendorAddress must be a valid 0x-address, got: ${String(params.vendorAddress)}`
    );
  }

  const payload = {
    kind: REVOCATION_KIND,
    schemaVersion: REVOCATION_SCHEMA_VERSION,
    note: REVOCATION_TRUST_NOTE,
    vendorAddress,
    reason: params.reason,
    revokedAt: params.revokedAt,
  };

  // OPTIONAL supersededBy — only set it when the caller supplied a non-undefined value, and normalize a
  // checksummed/mixed-case successor to lowercase the same way (a syntactically invalid successor HARD-errors
  // with a named, supersededBy-specific message; a null/empty/wrong-type value flows to validateRevocation
  // which rejects it as a present-but-malformed successor).
  if (params.supersededBy !== undefined) {
    if (typeof params.supersededBy === "string") {
      try {
        payload.supersededBy = getAddress(params.supersededBy).toLowerCase();
      } catch (_e) {
        throw new RevocationError(
          `revocation supersededBy, when present, must be a valid 0x-address, got: ${String(params.supersededBy)}`
        );
      }
    } else {
      // A non-string, non-undefined supersededBy (e.g. null, a number) is a present-but-malformed successor.
      payload.supersededBy = params.supersededBy;
    }
  }

  // validateRevocation throws a named error on any malformed/unknown/missing field — never silently accepts.
  // Return the canonicalized payload (re-parsed from serializeRevocation) so the in-memory object's field
  // order matches the signed bytes exactly.
  validateRevocation(payload);
  return JSON.parse(serializeRevocation(payload));
}

// The SIGNED-attestation framing passed to the GENERIC attestation core. The core does ALL the crypto + the
// wrap-don't-edit invariant; this supplies ONLY the revocation framing + the unsigned codec. SAME pattern
// the seal/license/dataset/identity-card use — frozen so it can never be mutated mid-flight.
const SIGNED_REVOCATION_CFG = Object.freeze({
  kind: SIGNED_REVOCATION_KIND,
  schemaVersion: SIGNED_REVOCATION_SCHEMA_VERSION,
  supportedSchemaVersions: SUPPORTED_SIGNED_REVOCATION_SCHEMA_VERSIONS,
  note: SIGNED_REVOCATION_TRUST_NOTE,
  label: "signed key revocation",
  validateUnsigned: validateRevocation,
  serializeUnsigned: serializeRevocation,
});

/**
 * Mint a SIGNED revocation container. Builds + validates the unsigned payload (canonicalizing vendorAddress/
 * supersededBy), then routes it + the caller's signer through the SHARED `signAttestation` core, which signs
 * the EXACT canonical bytes (EIP-191 personal_sign) and wraps + validates the container.
 *
 * THE LOAD-BEARING SELF-CONTROL INVARIANT — the key MUST control the address it revokes. After signing, the
 * recovered signer is required to EQUAL the embedded `vendorAddress`. A provisioned key that does NOT control
 * the claimed address HARD-errors (RevocationError) — the loop refuses to mint a revocation for an address
 * the signer cannot back (a third party cannot revoke a key it does not control). So a built revocation
 * ALWAYS round-trips to ACCEPT by construction.
 *
 * NO key handling here — the key lives only inside the signer object (an ephemeral Wallet in tests).
 *
 * @param {object} params { vendorAddress, reason, revokedAt, [supersededBy] }
 * @param {object} signer an ethers signer-like object: async getAddress() + signMessage()
 * @returns {Promise<object>} the validated signed-revocation container
 */
async function buildRevocation(params, signer) {
  const payload = buildRevocationPayload(params);
  const container = await coreAttestation.signAttestation(
    { attestation: payload, signer },
    SIGNED_REVOCATION_CFG
  );
  // Enforce the self-control invariant: recover the signer from the just-signed bytes and require it to
  // EQUAL the embedded vendorAddress. signAttestation already pinned the container's CLAIMED signer to the
  // signer's own address, so this catches the genuine "revoking an address this key does not control" case —
  // never a silent mint of an unbacked revocation.
  const recovered = coreAttestation.recoverSigner(container); // lowercase 0x-address
  if (recovered !== payload.vendorAddress) {
    throw new RevocationError(
      "refusing to mint a revocation the signing key does not control: the recovered signer " +
        `(${recovered}) does NOT equal the revocation's vendorAddress (${payload.vendorAddress}). A key ` +
        "revokes ITSELF — sign with the key that controls vendorAddress."
    );
  }
  return container;
}

/** Strictly validate a parsed SIGNED revocation container — thin wrapper over the shared core. */
function validateSignedRevocation(obj) {
  return coreAttestation.validateSignedAttestation(obj, SIGNED_REVOCATION_CFG);
}

/** Serialize a SIGNED revocation container to its canonical bytes — thin wrapper over the shared core. */
function serializeSignedRevocation(container) {
  return coreAttestation.serializeSignedAttestation(container, SIGNED_REVOCATION_CFG);
}

/**
 * Read + strictly validate a SIGNED revocation container (JSON STRING or object). PURE — it parses bytes
 * already in hand; it does NOT read a file (the file read is the CLI layer's job, T-51.3). A parse error is
 * a RevocationError (never a raw SyntaxError); a malformed/corrupt container is rejected by the shared
 * validator, never half-accepted.
 * @param {string|object} input
 * @returns {object} the validated container
 */
function readRevocation(input) {
  let obj;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch (e) {
      throw new RevocationError(`revocation container is not valid JSON: ${e.message}`);
    }
  } else if (isPlainObject(input)) {
    obj = input;
  } else {
    throw new RevocationError(
      "readRevocation requires a JSON string or a signed-revocation container object"
    );
  }
  try {
    coreAttestation.validateSignedAttestation(obj, SIGNED_REVOCATION_CFG);
  } catch (e) {
    throw new RevocationError(e.message);
  }
  return obj;
}

/**
 * Verify (purely, OFFLINE) a SIGNED revocation container — the STRICT, PURE verify path. It recovers the
 * signer from the embedded canonical revocation bytes + signature and:
 *   (1) confirms it equals the container's CLAIMED `signer` (signatureMatchesSigner — ALWAYS run);
 *   (2) confirms it equals the revocation's OWN embedded `vendorAddress` (vendorAddressMatchesSigner —
 *       ALWAYS run; this is the load-bearing SELF-CONTROL check: a key revokes ITSELF);
 *   (3) OPTIONALLY pins it to an EXPECTED signer (`expectedSigner` — signerMatchesExpected, run ONLY when
 *       present).
 * The verdict is ACCEPTED only when EVERY requested check passes; a forged/mismatched/tampered revocation
 * is a clean REJECTED — NEVER a silent pass, NEVER a thrown error for an ordinary rejection.
 *
 * It is OFFLINE / key-free / network-free / I/O-free: it recovers a PUBLIC address from a signature, holds
 * no private key, contacts nothing, writes nothing, and mutates the container NOT at all. The returned shape
 * EXTENDS the FAMILY verdict shape (the byte-for-byte fields `verifySignedAttestation` returns, including
 * checks/failedChecks/recoveredSigner/claimedSigner so a future indexer/UI depends on ONE stable shape) with
 * the revocation-specific vendorAddress/reason/revokedAt/supersededBy + checks.vendorAddressMatchesSigner.
 *
 * STRUCTURAL SAFETY: the container is validated FIRST (validateSignedRevocation); a structurally invalid
 * container HARD-errors (RevocationError) before any recovery, so an ordinary REJECTED verdict only ever
 * describes a SOUND revocation whose signature simply doesn't back its claims.
 *
 * @param {object} params
 * @param {object} params.container        a signed-revocation container (from buildRevocation/readRevocation)
 * @param {string} [params.expectedSigner] OPTIONAL expected signer 0x-address; checked when present
 * @returns {{
 *   verdict: "ACCEPTED"|"REJECTED",
 *   accepted: boolean,
 *   recoveredSigner: string,
 *   claimedSigner: string,
 *   vendorAddress: string,
 *   reason: string,
 *   revokedAt: string,
 *   supersededBy: string|null,
 *   scheme: string,
 *   checks: {
 *     signatureMatchesSigner: boolean,
 *     vendorAddressMatchesSigner: boolean,
 *     signerMatchesExpected: boolean|null,
 *   },
 *   expectedSigner: string|null,
 *   failedChecks: string[],
 * }}
 */
function verifyRevocation(params) {
  if (!isPlainObject(params)) {
    throw new RevocationError("verifyRevocation requires { container, [expectedSigner] }");
  }
  // Validate the container FIRST (and re-validate the embedded revocation) so an ordinary REJECTED verdict
  // only ever describes a STRUCTURALLY SOUND revocation. A corrupt/foreign container is a HARD error, never
  // a verdict.
  const container = validateSignedRevocation(params.container);
  const revocation = JSON.parse(container.attestation); // validated above (lowercase vendorAddress etc.)
  const vendorAddress = revocation.vendorAddress;

  // Route the signature recovery + the OPTIONAL expected-signer pin through the SHARED generic core (the
  // SAME path the identity card uses). We do NOT pass expectedCanonical — the revocation-specific binding is
  // the vendorAddress self-control check below, computed from the embedded revocation.
  const att = coreAttestation.verifySignedAttestation({
    container,
    expectedSigner: params.expectedSigner,
  });

  // (2) The load-bearing SELF-CONTROL check: the RECOVERED signer must equal the revocation's OWN
  //     vendorAddress. We pin against the RECOVERED signer (not the merely-CLAIMED one), so a revocation that
  //     claims a vendorAddress its signature does not back is REJECTED — a third party cannot revoke a key it
  //     does not control. When the signature is unrecoverable, recoveredSigner is the "(unrecoverable)"
  //     sentinel, which can never equal a lowercase 0x-address — so this is false (REJECT).
  const vendorAddressMatchesSigner = att.recoveredSigner === vendorAddress;

  // The verdict is ACCEPTED only when EVERY requested check passes. signatureMatchesSigner +
  // vendorAddressMatchesSigner are ALWAYS required; signerMatchesExpected only when expectedSigner was given
  // (null = not requested, never fails the gate). We REBUILD failedChecks (the core's list does not know
  // about vendorAddressMatchesSigner) so the verdict, the checks, and failedChecks can never disagree.
  const failedChecks = [];
  if (!att.checks.signatureMatchesSigner) failedChecks.push("signatureMatchesSigner");
  if (!vendorAddressMatchesSigner) failedChecks.push("vendorAddressMatchesSigner");
  if (att.checks.signerMatchesExpected === false) failedChecks.push("signerMatchesExpected");
  const accepted = failedChecks.length === 0;

  return {
    verdict: accepted ? "ACCEPTED" : "REJECTED",
    accepted,
    recoveredSigner: att.recoveredSigner,
    claimedSigner: att.claimedSigner,
    vendorAddress,
    reason: revocation.reason,
    revokedAt: revocation.revokedAt,
    // Surface the OPTIONAL successor explicitly as null when absent (so a machine reader gets a stable field
    // rather than an undefined that JSON drops).
    supersededBy: Object.prototype.hasOwnProperty.call(revocation, "supersededBy")
      ? revocation.supersededBy
      : null,
    scheme: att.scheme,
    checks: {
      signatureMatchesSigner: att.checks.signatureMatchesSigner,
      vendorAddressMatchesSigner,
      signerMatchesExpected: att.checks.signerMatchesExpected,
    },
    expectedSigner: att.expectedSigner,
    failedChecks,
  };
}

module.exports = {
  // kinds + closed sets
  REVOCATION_KIND,
  REVOCATION_SCHEMA_VERSION,
  SUPPORTED_REVOCATION_SCHEMA_VERSIONS,
  SIGNED_REVOCATION_KIND,
  SIGNED_REVOCATION_SCHEMA_VERSION,
  SUPPORTED_SIGNED_REVOCATION_SCHEMA_VERSIONS,
  REVOCATION_REASONS,
  REVOCATION_REASON_SET,
  REVOCATION_FIELDS,
  REVOCATION_TRUST_NOTE,
  SIGNED_REVOCATION_TRUST_NOTE,
  RevocationError,
  // unsigned-payload codec
  validateRevocation,
  serializeRevocation,
  buildRevocationPayload,
  // signed container
  buildRevocation,
  validateSignedRevocation,
  serializeSignedRevocation,
  readRevocation,
  verifyRevocation,
};

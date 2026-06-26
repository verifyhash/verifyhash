"use strict";

// cli/identity.js — the PURE producer-IDENTITY core for verifyhash (EPIC-49 / T-49.1).
//
// WHY THIS EXISTS
//   Every sealed/signed artifact this family mints (an evidence seal, a signed license, a dataset
//   attestation) pins its producer by a vendor ADDRESS the recipient must learn OUT OF BAND — an email,
//   a slide, a README line. A cold prospect therefore has NO first-class, OFFLINE-verifiable way to
//   answer "does this 0x-address really belong to THIS vendor, and what exactly do they attest — and,
//   just as load-bearing, what do they explicitly NOT attest?". The producer IDENTITY CARD closes that
//   gap: a vendor SIGNS, with the SAME key that signs their evidence/licenses, a small self-describing
//   container that binds their `vendorAddress` to a bounded `claims[]` set and an honest `nonClaims[]`
//   set. A recipient who holds the card can recover the signer, confirm it equals the card's OWN
//   `vendorAddress` (the key controls the address it claims), and OPTIONALLY pin it to an address they
//   learned out of band — all OFFLINE, no network, no key, no I/O.
//
// IT IS JUST ONE MORE PRODUCT ON THE SHARED SIGNED-ATTESTATION ENVELOPE.
//   Exactly like the seal/license/dataset, the identity card defines an UNSIGNED PAYLOAD (a versioned
//   object: vendorAddress + a CLOSED productLine + the bounded claims[]/nonClaims[] + publishedAt), a
//   canonical serializer, and a strict validator, then hands those to `cli/core/attestation.js` as the
//   product framing. The attestation core does ALL the crypto: it embeds the EXACT canonical payload
//   bytes as the `attestation`, attaches the detached EIP-191 signature, and later RE-DERIVES the signer
//   from those bytes. There is NO new crypto here, NO new dependency, NO new scheme — `buildIdentityCard`
//   wraps via `signAttestation`, `verifyIdentityCard` recovers via `verifySignedAttestation`, byte-for-byte
//   the SAME shared paths the seal uses.
//
// THE LOAD-BEARING EXTRA CHECK — the key controls the address it claims.
//   A license pins the signer to a caller-supplied `vendorAddress`. An identity card carries its OWN
//   `vendorAddress` INSIDE the signed payload, so the card asserts "the holder of this key IS this
//   address". `verifyIdentityCard` therefore REQUIRES recovered === the embedded `vendorAddress`: a card
//   whose signature recovers to any OTHER key is REJECTED (`vendorAddressMatchesSigner` fails), never a
//   silent accept. `buildIdentityCard` enforces the SAME invariant at mint time — it refuses to produce a
//   card for an address the provisioned signer does not control — so a card can never round-trip into a
//   false ACCEPT.
//
// PURE + I/O-FREE + KEY-AGNOSTIC.
//   Every function here is pure: no filesystem, no clock, no network. The only key handling is a passed-in
//   ethers signer-like object (an ephemeral `Wallet.createRandom()` in tests; the loop NEVER holds a real
//   key) whose private key lives ONLY inside that object — never read, persisted, or logged here. The
//   `publishedAt` instant is a CALLER-supplied argument; this core never reads the system clock, so the
//   same inputs always yield byte-identical bytes + verdict. PRODUCT-AGNOSTIC: this module requires the
//   GENERIC attestation core, never the reverse — no back-edge.

const coreAttestation = require("./core/attestation");
const { getAddress } = require("ethers");

// On-disk schema discriminators. The identity card carries its OWN kind + version (distinct from every
// seal/license/manifest kind) so a random JSON file, a license, or a seal is never misread as a card.
const IDENTITY_CARD_KIND = "vh-identity-card";
const IDENTITY_CARD_SCHEMA_VERSION = 1;
const SUPPORTED_IDENTITY_CARD_SCHEMA_VERSIONS = Object.freeze([1]);

// The SIGNED-container framing (the detached-signature envelope kind) — its OWN discriminator.
const SIGNED_IDENTITY_CARD_KIND = "vh-identity-card-signed";
const SIGNED_IDENTITY_CARD_SCHEMA_VERSION = 1;
const SUPPORTED_SIGNED_IDENTITY_CARD_SCHEMA_VERSIONS = Object.freeze([1]);

// The CLOSED productLine set. A card declares WHICH product family the vendor publishes under; an
// out-of-set value is a HARD build/validate error (never silently honored), exactly like the license
// core's closed entitlement table. Frozen + a derived sorted list so error messages are deterministic.
const PRODUCT_LINES = Object.freeze(["evidence", "dataledger", "trustledger"]);
const PRODUCT_LINE_SET = Object.freeze(PRODUCT_LINES.slice().sort());

// A claimed 0x-address INSIDE the payload: 0x + 40 LOWERCASE hex chars. Lowercase-only for the SAME
// byte-determinism reason the attestation core lowercases the signer — an EIP-55-checksummed address is
// the canonical address in a DIFFERENT encoding, so accepting it verbatim would let one vendor serialize
// two ways. A caller holding a checksummed address lowercases it before building the card (buildIdentityCard
// normalizes for them via getAddress, so a checksummed input is accepted and canonicalized).
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

// A strict ISO-8601 UTC instant ("YYYY-MM-DDTHH:MM:SS(.mmm)Z"). Same canonical instant grammar the license
// core pins issuedAt/expiresAt to, so two logically-identical cards serialize to identical bytes. We pin
// the SHAPE here and require the canonical millis round-trip below.
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

// The in-band trust caveat — stated ONCE so the human + JSON paths agree and the boundary can never drift.
// It is the load-bearing honesty of the artifact: a card proves IDENTITY + a bounded claim SET; it is NOT
// a per-packet truth claim, NOT a trusted timestamp, NOT a legal opinion.
const IDENTITY_CARD_TRUST_NOTE =
  "This is a verifyhash producer IDENTITY CARD: the holder of `vendorAddress`'s key SIGNED it, binding " +
  "that address to the `claims` it attests and the `nonClaims` it explicitly does NOT. verify RE-DERIVES " +
  "the signer from these exact bytes and REQUIRES it to equal `vendorAddress` — it never trusts the file's " +
  "own claims. It proves IDENTITY + the claim SET ONLY: it does NOT prove any specific sealed/signed packet " +
  'is true (each packet carries its own proof), it is NOT a trusted TIMESTAMP ("published since T" rides ' +
  "the human-owned signing/timestamp trust-root, STRATEGY.md P-3), and it is NOT a legal opinion.";

const SIGNED_IDENTITY_CARD_TRUST_NOTE =
  "This is a SIGNED verifyhash identity-card container: it WRAPS (never edits) the EXACT canonical " +
  "identity-card bytes in `attestation` and attaches a detached EIP-191 signature. verifyIdentityCard " +
  "RE-DERIVES the signer from those bytes and pins it to the embedded `vendorAddress` — it never trusts " +
  "the file's own claims. Every caveat of the embedded card applies. " +
  IDENTITY_CARD_TRUST_NOTE;

// A dedicated error type so callers/tests catch ONE identity error for the HARD validation failures
// (a closed-field/closed-productLine/empty-claims violation, an out-of-control mint). An ordinary verify
// REJECT is NOT thrown — it is a clean verdict (verdict: "REJECTED"), exactly like the rest of the family.
class IdentityCardError extends Error {
  constructor(message) {
    super(message);
    this.name = "IdentityCardError";
  }
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// The CLOSED field set of an UNSIGNED identity-card payload. An UNKNOWN/extraneous key is a HARD error
// (never silently dropped) so the card's shape ossifies with exactly these fields. `kind`/`schemaVersion`/
// `note` are the framing the core fixes; the rest is the producer-supplied identity.
const IDENTITY_CARD_FIELDS = Object.freeze([
  "kind",
  "schemaVersion",
  "note",
  "vendorAddress",
  "productLine",
  "claims",
  "nonClaims",
  "publishedAt",
]);

/**
 * STRICT structural validation of an UNSIGNED identity-card payload. Throws an IdentityCardError on the
 * FIRST problem (named + localized); returns the object unchanged on success. NEVER half-accepts and NEVER
 * fills defaults. This is the `validateUnsigned` the attestation core re-runs on the embedded payload (the
 * wrap-don't-edit invariant), so a signed container can never smuggle a malformed/edited card.
 *
 * REJECTS (HARD): a non-object; a wrong kind/schemaVersion/note; an UNKNOWN/extraneous field; a missing/
 * malformed (not lowercase-0x) vendorAddress; an out-of-set productLine; a non-array OR EMPTY claims;
 * a non-array OR EMPTY nonClaims; any claim/nonClaim that is not a non-empty string OR a duplicate; a
 * non-canonical-ISO publishedAt.
 *
 * @param {any} obj
 * @returns {object} the same object, if valid
 */
function validateIdentityCard(obj) {
  if (!isPlainObject(obj)) {
    throw new IdentityCardError("identity card payload must be a JSON object");
  }

  // CLOSED FIELD SET: every key must be one of IDENTITY_CARD_FIELDS. An unknown/extraneous key HARD-errors
  // (never silently kept) so the card can never carry a smuggled, unvalidated field.
  for (const key of Object.keys(obj)) {
    if (!IDENTITY_CARD_FIELDS.includes(key)) {
      throw new IdentityCardError(
        `identity card has an unknown field: ${JSON.stringify(key)} ` +
          `(the closed field set is ${JSON.stringify(IDENTITY_CARD_FIELDS)})`
      );
    }
  }

  if (obj.kind !== IDENTITY_CARD_KIND) {
    throw new IdentityCardError(
      `not a verifyhash identity card (kind: ${JSON.stringify(obj.kind)}; expected ${JSON.stringify(IDENTITY_CARD_KIND)})`
    );
  }
  if (!SUPPORTED_IDENTITY_CARD_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new IdentityCardError(
      `unsupported identity card schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(SUPPORTED_IDENTITY_CARD_SCHEMA_VERSIONS)})`
    );
  }
  if (obj.note !== IDENTITY_CARD_TRUST_NOTE) {
    throw new IdentityCardError(
      "identity card `note` must be the standing IDENTITY_CARD_TRUST_NOTE (caveat must not drift)"
    );
  }

  // vendorAddress — the address the card BINDS to the signing key. A lowercase 0x-address (checksummed/
  // mixed-case is rejected here for byte-determinism; buildIdentityCard lowercases a checksummed input).
  if (typeof obj.vendorAddress !== "string" || !ADDRESS_RE.test(obj.vendorAddress)) {
    throw new IdentityCardError(
      "identity card vendorAddress must be a 0x-prefixed 20-byte LOWERCASE-hex address " +
        `(checksummed/mixed-case rejected for byte-determinism — lowercase it first), got: ${String(obj.vendorAddress)}`
    );
  }

  // productLine — a single value drawn from the CLOSED PRODUCT_LINES set. An out-of-set value HARD-errors.
  if (typeof obj.productLine !== "string" || !PRODUCT_LINE_SET.includes(obj.productLine)) {
    throw new IdentityCardError(
      `identity card productLine must be one of the closed set ${JSON.stringify(PRODUCT_LINE_SET)}, ` +
        `got: ${JSON.stringify(obj.productLine)}`
    );
  }

  // claims / nonClaims — each a NON-EMPTY array of unique, non-empty strings. An empty array is a HARD
  // error: a card with no claims attests nothing, and a card with no nonClaims drops the load-bearing
  // honest boundary. Validated by the SAME helper so both stay byte-identical.
  _validateStringList(obj.claims, "claims");
  _validateStringList(obj.nonClaims, "nonClaims");

  // publishedAt — a strict, CANONICAL ISO-8601 UTC instant. The regex pins the SHAPE; the millis round-trip
  // FORCES the `.mmm` form and REJECTS every rolled-over/impossible instant (e.g. Feb-29 in a non-leap year),
  // exactly like the license core, so a self-asserted date can never silently coerce.
  if (typeof obj.publishedAt !== "string" || !ISO_INSTANT_RE.test(obj.publishedAt)) {
    throw new IdentityCardError(
      `identity card publishedAt must be an ISO-8601 UTC instant ("YYYY-MM-DDTHH:MM:SS(.mmm)Z"), got: ${String(obj.publishedAt)}`
    );
  }
  const ms = Date.parse(obj.publishedAt);
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== obj.publishedAt) {
    throw new IdentityCardError(
      `identity card publishedAt must be a canonical ISO-8601 UTC instant ("YYYY-MM-DDTHH:MM:SS.mmmZ", ` +
        `millis required, no rolled-over/impossible fields), got: ${String(obj.publishedAt)}`
    );
  }

  return obj;
}

/**
 * Internal: validate a `claims`/`nonClaims` list — a NON-EMPTY array of unique, non-empty strings. The
 * field NAME parameterizes the error so each list localizes its own failure. HARD-errors (IdentityCardError).
 */
function _validateStringList(list, fieldName) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new IdentityCardError(
      `identity card ${fieldName} must be a non-empty array of strings`
    );
  }
  const seen = new Set();
  for (const item of list) {
    if (typeof item !== "string" || item.length === 0) {
      throw new IdentityCardError(
        `identity card ${fieldName} entry must be a non-empty string, got: ${JSON.stringify(item)}`
      );
    }
    if (seen.has(item)) {
      throw new IdentityCardError(
        `identity card ${fieldName} has a duplicate entry: ${JSON.stringify(item)}`
      );
    }
    seen.add(item);
  }
}

/**
 * Serialize a validated UNSIGNED identity-card payload to its canonical, byte-deterministic bytes: a FIXED
 * key order, NO insignificant whitespace, a single trailing newline. claims/nonClaims are emitted in the
 * caller's order (their order is part of the card the vendor publishes — NOT order-independent like the
 * license entitlement table). This is the EXACT byte sequence the envelope signs over and verifyIdentityCard
 * re-derives the signer from, so two logically-identical cards sign identically.
 * @param {object} payload a validated identity-card payload
 * @returns {string} the canonical serialization (newline-terminated)
 */
function serializeIdentityCard(payload) {
  validateIdentityCard(payload);
  const canonical = {
    kind: payload.kind,
    schemaVersion: payload.schemaVersion,
    note: payload.note,
    vendorAddress: payload.vendorAddress,
    productLine: payload.productLine,
    claims: payload.claims.slice(),
    nonClaims: payload.nonClaims.slice(),
    publishedAt: payload.publishedAt,
  };
  return JSON.stringify(canonical) + "\n";
}

/**
 * Assemble + strictly validate an UNSIGNED identity-card payload from caller fields. PURE. This is the
 * payload `buildIdentityCard` then wraps in the signed envelope. Splitting it out lets a caller hold/inspect
 * the unsigned card before signing (and validates it the SAME way the embedded payload is re-validated on
 * read). A checksummed/mixed-case vendorAddress is normalized to lowercase here (a syntactically invalid
 * address HARD-errors); every other field passes through to validateIdentityCard.
 *
 * @param {object} params { vendorAddress, productLine, claims, nonClaims, publishedAt }
 * @returns {object} a validated, canonicalized identity-card payload
 */
function buildIdentityCardPayload(params) {
  if (!isPlainObject(params)) {
    throw new IdentityCardError(
      "buildIdentityCardPayload requires a { vendorAddress, productLine, claims, nonClaims, publishedAt } object"
    );
  }
  // Normalize a checksummed/mixed-case vendorAddress to canonical lowercase (so a caller may paste an EIP-55
  // address). A syntactically invalid address is a HARD error (named, no surprise).
  let vendorAddress;
  try {
    vendorAddress = getAddress(params.vendorAddress).toLowerCase();
  } catch (_e) {
    throw new IdentityCardError(
      `identity card vendorAddress must be a valid 0x-address, got: ${String(params.vendorAddress)}`
    );
  }
  const payload = {
    kind: IDENTITY_CARD_KIND,
    schemaVersion: IDENTITY_CARD_SCHEMA_VERSION,
    note: IDENTITY_CARD_TRUST_NOTE,
    vendorAddress,
    productLine: params.productLine,
    claims: params.claims,
    nonClaims: params.nonClaims,
    publishedAt: params.publishedAt,
  };
  // validateIdentityCard throws a named error on any malformed/unknown/missing/empty field — never silently
  // accepts. Return the canonicalized payload (re-parsed from serializeIdentityCard) so the in-memory
  // object's field order matches the signed bytes exactly.
  validateIdentityCard(payload);
  return JSON.parse(serializeIdentityCard(payload));
}

// The SIGNED-attestation framing passed to the GENERIC attestation core. The core does ALL the crypto +
// the wrap-don't-edit invariant; this supplies ONLY the identity-card framing + the unsigned codec. SAME
// pattern the seal/license/dataset use — frozen so it can never be mutated mid-flight.
const SIGNED_IDENTITY_CARD_CFG = Object.freeze({
  kind: SIGNED_IDENTITY_CARD_KIND,
  schemaVersion: SIGNED_IDENTITY_CARD_SCHEMA_VERSION,
  supportedSchemaVersions: SUPPORTED_SIGNED_IDENTITY_CARD_SCHEMA_VERSIONS,
  note: SIGNED_IDENTITY_CARD_TRUST_NOTE,
  label: "signed identity card",
  validateUnsigned: validateIdentityCard,
  serializeUnsigned: serializeIdentityCard,
});

/**
 * Mint a SIGNED identity-card container. Builds + validates the unsigned payload (canonicalizing
 * vendorAddress), then routes it + the caller's signer through the SHARED `signAttestation` core, which
 * signs the EXACT canonical bytes (EIP-191 personal_sign) and wraps + validates the container.
 *
 * THE LOAD-BEARING MINT INVARIANT — the key MUST control the address it claims. After signing, the
 * recovered signer is required to EQUAL the embedded `vendorAddress`. A provisioned key that does NOT
 * control the claimed address HARD-errors (IdentityCardError) — the loop refuses to mint a card asserting
 * an identity the signer cannot back. So a built card ALWAYS round-trips to ACCEPT by construction.
 *
 * NO key handling here — the key lives only inside the signer object (an ephemeral Wallet in tests).
 *
 * @param {object} params { vendorAddress, productLine, claims, nonClaims, publishedAt }
 * @param {object} signer an ethers signer-like object: async getAddress() + signMessage()
 * @returns {Promise<object>} the validated signed-identity-card container
 */
async function buildIdentityCard(params, signer) {
  const payload = buildIdentityCardPayload(params);
  const container = await coreAttestation.signAttestation(
    { attestation: payload, signer },
    SIGNED_IDENTITY_CARD_CFG
  );
  // Enforce the mint invariant: recover the signer from the just-signed bytes and require it to EQUAL the
  // embedded vendorAddress. signAttestation already pinned the container's CLAIMED signer to the signer's
  // own address, so this catches the genuine "minting a card for an address this key does not control"
  // case — never a silent mint of an unbacked identity.
  const recovered = coreAttestation.recoverSigner(container); // lowercase 0x-address
  if (recovered !== payload.vendorAddress) {
    throw new IdentityCardError(
      "refusing to mint an identity card the signing key does not control: the recovered signer " +
        `(${recovered}) does NOT equal the card's vendorAddress (${payload.vendorAddress}). Sign with the ` +
        "key that controls vendorAddress, or set vendorAddress to the signing key's address."
    );
  }
  return container;
}

/** Strictly validate a parsed SIGNED identity-card container — thin wrapper over the shared core. */
function validateSignedIdentityCard(obj) {
  return coreAttestation.validateSignedAttestation(obj, SIGNED_IDENTITY_CARD_CFG);
}

/** Serialize a SIGNED identity-card container to its canonical bytes — thin wrapper over the shared core. */
function serializeSignedIdentityCard(container) {
  return coreAttestation.serializeSignedAttestation(container, SIGNED_IDENTITY_CARD_CFG);
}

/**
 * Read + strictly validate a SIGNED identity-card container (JSON string or object). A parse error is an
 * IdentityCardError (never a raw SyntaxError); a malformed/corrupt container is rejected by the shared
 * validator, never half-accepted.
 * @param {string|object} input
 * @returns {object} the validated container
 */
function readIdentityCard(input) {
  let obj;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch (e) {
      throw new IdentityCardError(`identity card container is not valid JSON: ${e.message}`);
    }
  } else if (isPlainObject(input)) {
    obj = input;
  } else {
    throw new IdentityCardError("readIdentityCard requires a JSON string or a signed-identity-card container object");
  }
  try {
    coreAttestation.validateSignedAttestation(obj, SIGNED_IDENTITY_CARD_CFG);
  } catch (e) {
    throw new IdentityCardError(e.message);
  }
  return obj;
}

/**
 * Verify (purely, OFFLINE) a SIGNED identity-card container — the STRICT, PURE verify path. It recovers the
 * signer from the embedded canonical card bytes + signature and:
 *   (1) confirms it equals the container's CLAIMED `signer` (signatureMatchesSigner — ALWAYS run);
 *   (2) confirms it equals the card's OWN embedded `vendorAddress` (vendorAddressMatchesSigner — ALWAYS
 *       run; this is the load-bearing "the key controls the address it claims" check);
 *   (3) OPTIONALLY pins it to an EXPECTED signer (`expectedSigner` / the CLI `--signer` flag —
 *       signerMatchesExpected, run ONLY when present).
 * The verdict is ACCEPTED only when EVERY requested check passes; a forged/mismatched/tampered card is a
 * clean REJECTED — NEVER a silent pass, NEVER a thrown error for an ordinary rejection.
 *
 * It is OFFLINE / key-free / network-free / I/O-free: it recovers a PUBLIC address from a signature, holds
 * no private key, contacts nothing, writes nothing, and mutates the container NOT at all. The returned
 * shape EXTENDS the FAMILY verdict shape (the byte-for-byte fields `verifySignedAttestation` returns,
 * including `checks`/`failedChecks`/`recoveredSigner`/`claimedSigner` so a future indexer/UI depends on
 * ONE stable shape) with the identity-specific `vendorAddress` + `checks.vendorAddressMatchesSigner`.
 *
 * STRUCTURAL SAFETY: the container is validated FIRST (validateSignedIdentityCard); a structurally invalid
 * container HARD-errors (IdentityCardError) before any recovery, so an ordinary REJECTED verdict only ever
 * describes a SOUND card whose signature simply doesn't back its claims.
 *
 * @param {object} params
 * @param {object} params.container        a signed-identity-card container (from buildIdentityCard/readIdentityCard)
 * @param {string} [params.expectedSigner] OPTIONAL expected signer 0x-address (--signer); checked when present
 * @returns {{
 *   verdict: "ACCEPTED"|"REJECTED",
 *   accepted: boolean,
 *   recoveredSigner: string,
 *   claimedSigner: string,
 *   vendorAddress: string,
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
function verifyIdentityCard(params) {
  if (!isPlainObject(params)) {
    throw new IdentityCardError("verifyIdentityCard requires { container, [expectedSigner] }");
  }
  // Validate the container FIRST (and re-validate the embedded card) so an ordinary REJECTED verdict only
  // ever describes a STRUCTURALLY SOUND card. A corrupt/foreign container is a HARD error, never a verdict.
  const container = validateSignedIdentityCard(params.container);
  const vendorAddress = JSON.parse(container.attestation).vendorAddress; // lowercase 0x (validated above)

  // Route the signature recovery + the OPTIONAL expected-signer pin through the SHARED generic core (the
  // SAME path the seal/license use). We do NOT pass expectedCanonical — the identity-specific binding is
  // the vendorAddress check below, computed from the embedded card, not from a caller's directory.
  const att = coreAttestation.verifySignedAttestation({
    container,
    expectedSigner: params.expectedSigner,
  });

  // (2) The load-bearing identity check: the RECOVERED signer must equal the card's OWN vendorAddress. We
  //     pin against the RECOVERED signer (not the merely-CLAIMED one), so a card that claims a vendorAddress
  //     its signature does not back is REJECTED. When the signature is unrecoverable, recoveredSigner is the
  //     "(unrecoverable)" sentinel, which can never equal a lowercase 0x-address — so this is false (REJECT).
  const vendorAddressMatchesSigner = att.recoveredSigner === vendorAddress;

  // The verdict is ACCEPTED only when EVERY requested check passes. signatureMatchesSigner +
  // vendorAddressMatchesSigner are ALWAYS required; signerMatchesExpected only when --signer was given
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
  IDENTITY_CARD_KIND,
  IDENTITY_CARD_SCHEMA_VERSION,
  SUPPORTED_IDENTITY_CARD_SCHEMA_VERSIONS,
  SIGNED_IDENTITY_CARD_KIND,
  SIGNED_IDENTITY_CARD_SCHEMA_VERSION,
  SUPPORTED_SIGNED_IDENTITY_CARD_SCHEMA_VERSIONS,
  PRODUCT_LINES,
  PRODUCT_LINE_SET,
  IDENTITY_CARD_FIELDS,
  IDENTITY_CARD_TRUST_NOTE,
  SIGNED_IDENTITY_CARD_TRUST_NOTE,
  IdentityCardError,
  // unsigned-payload codec
  validateIdentityCard,
  serializeIdentityCard,
  buildIdentityCardPayload,
  // signed container
  buildIdentityCard,
  validateSignedIdentityCard,
  serializeSignedIdentityCard,
  readIdentityCard,
  verifyIdentityCard,
};

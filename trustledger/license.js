"use strict";

// TrustLedger — license.js  (EPIC-? / T-29.1)
//
// THE PRODUCT LICENSE — a PURE, offline-verifiable, signed entitlement token, built on the project's
// EXISTING signed-attestation envelope (`cli/core/attestation.js`), reusing it VERBATIM.
//
// THE PROBLEM THIS SOLVES.
//   TrustLedger's premium surfaces (multi-state policy packs, the reconciliation SEAL, unlimited
//   reconcile runs) are how the product earns subscription/license revenue. We need a way for the
//   VENDOR to issue a customer a `*.vhlicense.json` that the CLI can verify OFFLINE — no license
//   server, no network call, no key on the customer's machine — and that strictly answers two
//   questions: "did OUR vendor key sign this?" and "is it in-window and what does it entitle?".
//   A license signed by anyone else, or expired, or carrying an unknown entitlement, must be a hard
//   REJECT — never silently honored.
//
// THE MOVE — reuse the proven signed-attestation envelope VERBATIM.
//   A license is just one more product on the shared envelope, exactly like the seal: we define an
//   UNSIGNED license PAYLOAD (a strict, versioned object), a canonical serializer, and a strict
//   validator, then hand those to `cli/core/attestation.js` as the product framing. The core does ALL
//   the crypto: it embeds the EXACT canonical payload bytes as the attestation, attaches the detached
//   EIP-191 signature, and later RE-DERIVES the signer from those bytes. There is NO new crypto here,
//   NO new dependency — `buildLicense` wraps via `signAttestation`, `verifyLicense` recovers via
//   `recoverSigner`/`verifySignedAttestation`, exactly as the seal does.
//
// PURE + I/O-FREE.
//   Every function here is pure: no filesystem, no clock, no network, no key handling (the key lives
//   only inside the caller's signer object). `verifyLicense` takes `now` as an explicit argument — it
//   never reads the system clock — so the same container + same `now` + same `vendorAddress` always
//   yield a byte-identical verdict.
//
// TRUST-BOUNDARIES — the license is an UNTRUSTED transport container.
//   Consistent with docs/TRUST-BOUNDARIES.md, `verifyLicense` RE-DERIVES the signer from the supplied
//   bytes and PINS it to the caller's `vendorAddress`. It NEVER trusts the file's own claims: a license
//   that merely SAYS it was signed by the vendor, but recovers to a different key, is `wrong_issuer`,
//   not trusted. Entitlements only mean anything once the verdict is `valid`.
//
// HONEST POSTURE — what a license DOES and DOES NOT prove.
//   A valid verdict proves: the vendor key signed THESE exact entitlements for THIS customer/plan, and
//   `now` falls within [issuedAt, expiresAt]. It is NOT a trusted timestamp (a self-asserted issuedAt/
//   expiresAt rides the vendor's own honesty + key custody, P-3), and it is NOT a legal contract — the
//   actual subscription agreement governs. The license gates FEATURES; it never replaces the SLA.

const coreAttestation = require("../cli/core/attestation");
const { getAddress } = require("ethers");

// ---------------------------------------------------------------------------
// Identity. The license has its OWN `kind`/`schemaVersion`, disjoint from the seal/dataset/parcel
// payloads so a license can never be confused for one of them. `validateLicense` REJECTS any
// unsupported version rather than guessing.
// ---------------------------------------------------------------------------

const LICENSE_KIND = "trustledger-license";
const LICENSE_SCHEMA_VERSION = 1;
const SUPPORTED_LICENSE_SCHEMA_VERSIONS = Object.freeze([1]);

// THE CLOSED ENTITLEMENT TABLE. Every entitlement flag a license can carry is enumerated HERE, in ONE
// exported place, with a human-readable meaning. `entitlements` is a closed set drawn ONLY from these
// keys: an unknown flag is a hard build error (never silently accepted), so a typo'd or forged
// entitlement can never grant a feature. To add a paid feature, add a key here — there is no other
// channel by which an entitlement enters the system.
const ENTITLEMENTS = Object.freeze({
  // Unlock policy packs for more than one US state (multi-state trust-accounting rules).
  multi_state_policy: "Multi-state trust-accounting policy packs (beyond a single state).",
  // Unlock the tamper-evident reconciliation SEAL (EPIC-26) surface.
  seal: "Tamper-evident reconciliation seal (build/verify *.vhseal).",
  // Remove the per-period reconcile-run cap.
  unlimited_reconcile: "Unlimited reconciliation runs (no per-period cap).",
});

// The frozen, SORTED list of valid entitlement flags — derived ONCE from the table so the two can
// never drift. Sorted so error messages + any iteration are deterministic.
const ENTITLEMENT_FLAGS = Object.freeze(Object.keys(ENTITLEMENTS).sort());

// A strict ISO-8601 UTC instant, e.g. "2026-05-31T00:00:00.000Z". We require the canonical form ethers/
// JS emit via `new Date(...).toISOString()` so two logically-identical licenses serialize to identical
// bytes. We REJECT a date-only ("YYYY-MM-DD") or an offset-bearing form (over-loose) — the license dates
// are machine-compared instants, so they must be a single, unambiguous UTC encoding.
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

// The in-band trust caveat carried in EVERY license payload, stated in ONE place so it can never drift
// from the NatSpec above. It is the load-bearing honesty of the artifact.
const LICENSE_TRUST_NOTE =
  "This TrustLedger license is a SIGNED entitlement token, verified OFFLINE by re-deriving the signer " +
  "from these exact bytes and pinning it to the vendor key. A valid verdict proves the vendor signed " +
  "THESE entitlements for THIS customer within [issuedAt, expiresAt]; it is an UNTRUSTED transport " +
  "container (verifyLicense never trusts the file's own claims), it is NOT a trusted timestamp (the " +
  "issuedAt/expiresAt are self-asserted and ride the vendor key custody, P-3), and it is NOT the legal " +
  "subscription agreement (which governs). It gates product FEATURES; it never replaces the contract.";

// ---------------------------------------------------------------------------
// Errors — STRICT. A malformed/ambiguous license raises a NAMED error rather than being silently
// dropped, coerced, or partially accepted (mirrors seal.js / close.js).
// ---------------------------------------------------------------------------

class LicenseError extends Error {
  constructor(message) {
    super(message);
    this.name = "LicenseError";
  }
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// validateLicense(obj) — STRICT structural validation of an UNSIGNED license PAYLOAD. Throws a named
// LicenseError on the FIRST problem; returns the object unchanged on success. This is the
// `validateUnsigned` the attestation core re-runs on the embedded payload (the wrap-don't-edit
// invariant), so a signed container can never smuggle a malformed/edited license.
//
// REJECTS: a wrong kind / schemaVersion; a wrong note; a missing/non-string licenseId/customer/plan; a
// non-array or empty entitlements; a duplicate or unknown entitlement flag; a non-ISO issuedAt/
// expiresAt; expiresAt <= issuedAt. It NEVER half-accepts or fills defaults.
// ---------------------------------------------------------------------------

function validateLicense(obj) {
  if (!isPlainObject(obj)) {
    throw new LicenseError("license payload must be a JSON object");
  }
  if (obj.kind !== LICENSE_KIND) {
    throw new LicenseError(
      `not a trustledger license (kind: ${JSON.stringify(obj.kind)}; expected ${JSON.stringify(LICENSE_KIND)})`
    );
  }
  if (!SUPPORTED_LICENSE_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new LicenseError(
      `unsupported license schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(SUPPORTED_LICENSE_SCHEMA_VERSIONS)})`
    );
  }
  if (obj.note !== LICENSE_TRUST_NOTE) {
    throw new LicenseError("license `note` must be the standing LICENSE_TRUST_NOTE (caveat must not drift)");
  }

  for (const f of ["licenseId", "customer", "plan"]) {
    if (typeof obj[f] !== "string" || obj[f].length === 0) {
      throw new LicenseError(`license ${f} must be a non-empty string`);
    }
  }

  // entitlements — a closed set of known flags, each used at most once.
  if (!Array.isArray(obj.entitlements) || obj.entitlements.length === 0) {
    throw new LicenseError("license `entitlements` must be a non-empty array of known flags");
  }
  const seen = new Set();
  for (const flag of obj.entitlements) {
    if (typeof flag !== "string") {
      throw new LicenseError(`license entitlement must be a string flag, got: ${JSON.stringify(flag)}`);
    }
    if (!Object.prototype.hasOwnProperty.call(ENTITLEMENTS, flag)) {
      throw new LicenseError(
        `unknown license entitlement: ${JSON.stringify(flag)} ` +
          `(this build understands ${JSON.stringify(ENTITLEMENT_FLAGS)})`
      );
    }
    if (seen.has(flag)) {
      throw new LicenseError(`license has a duplicate entitlement: ${JSON.stringify(flag)}`);
    }
    seen.add(flag);
  }

  // issuedAt / expiresAt — strict ISO instants, expiresAt strictly after issuedAt.
  for (const f of ["issuedAt", "expiresAt"]) {
    if (typeof obj[f] !== "string" || !ISO_INSTANT_RE.test(obj[f])) {
      throw new LicenseError(
        `license ${f} must be an ISO-8601 UTC instant ("YYYY-MM-DDTHH:MM:SS(.mmm)Z"), got: ${String(obj[f])}`
      );
    }
    // The regex pins the SHAPE; require it to be a real, CANONICAL calendar instant too. Date.parse on a
    // strict-Z form is UTC, but it (1) does NOT reject out-of-range fields — it ROLLS THEM OVER (e.g.
    // "2026-02-29T00:00:00.000Z" in non-leap 2026 silently becomes 2026-03-01; "...T24:00:00.000Z"
    // becomes the next day), and (2) accepts a missing-millis form ("...:00Z") that is a different BYTE
    // string than the canonical "...:00.000Z". Either case would let two logically-distinct (or
    // logically-identical) inputs sign differently / silently coerce a self-asserted date — breaking the
    // byte-determinism the whole product rests on. So after parsing we require the round-trip to be
    // BYTE-IDENTICAL: `new Date(ms).toISOString() === obj[f]`. toISOString always emits the canonical,
    // normalized "YYYY-MM-DDTHH:MM:SS.mmmZ", so this single equality both FORCES the `.mmm` millis form
    // and REJECTS every rolled-over/impossible instant — never silently coerced.
    const ms = Date.parse(obj[f]);
    if (Number.isNaN(ms) || new Date(ms).toISOString() !== obj[f]) {
      throw new LicenseError(
        `license ${f} must be a canonical ISO-8601 UTC instant ("YYYY-MM-DDTHH:MM:SS.mmmZ", millis required, ` +
          `no rolled-over/impossible fields), got: ${String(obj[f])}`
      );
    }
  }
  const issuedMs = Date.parse(obj.issuedAt);
  const expiresMs = Date.parse(obj.expiresAt);
  if (expiresMs <= issuedMs) {
    throw new LicenseError(
      `license expiresAt (${obj.expiresAt}) must be strictly AFTER issuedAt (${obj.issuedAt})`
    );
  }

  return obj;
}

// ---------------------------------------------------------------------------
// serializeLicense(payload) — canonical, byte-deterministic serialization of an UNSIGNED license
// payload: a FIXED key order, NO insignificant whitespace, a single trailing newline. Entitlements are
// emitted in the FROZEN ENTITLEMENT_FLAGS order (filtered to those present) so the bytes are
// independent of the caller's array order. This is the EXACT byte sequence the envelope signs over and
// `verifyLicense` re-derives the signer from — so two logically-identical licenses sign identically.
// ---------------------------------------------------------------------------

function serializeLicense(payload) {
  validateLicense(payload);
  const present = new Set(payload.entitlements);
  const canonical = {
    kind: payload.kind,
    schemaVersion: payload.schemaVersion,
    note: payload.note,
    licenseId: payload.licenseId,
    customer: payload.customer,
    plan: payload.plan,
    // Emit in the fixed table order, filtered to those present — order-independent canonical form.
    entitlements: ENTITLEMENT_FLAGS.filter((f) => present.has(f)),
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  };
  return JSON.stringify(canonical) + "\n";
}

// ---------------------------------------------------------------------------
// buildLicensePayload({...}) — assemble + strictly validate an UNSIGNED license payload from caller
// fields. PURE. This is the payload that `buildLicense` then wraps in the signed envelope. Splitting it
// out lets a caller hold/inspect the unsigned payload before signing (and lets the build path validate
// the SAME way the embedded payload is re-validated on read).
// ---------------------------------------------------------------------------

function buildLicensePayload(params) {
  if (!isPlainObject(params)) {
    throw new LicenseError("buildLicensePayload requires a { licenseId, customer, plan, entitlements, issuedAt, expiresAt } object");
  }
  const payload = {
    kind: LICENSE_KIND,
    schemaVersion: LICENSE_SCHEMA_VERSION,
    note: LICENSE_TRUST_NOTE,
    licenseId: params.licenseId,
    customer: params.customer,
    plan: params.plan,
    entitlements: params.entitlements,
    issuedAt: params.issuedAt,
    expiresAt: params.expiresAt,
  };
  // validateLicense throws a named error on any malformed/unknown/missing field — never silently
  // accepts. We return the canonicalized payload (re-parsed from serializeLicense) so the in-memory
  // object's entitlement order matches the signed bytes exactly.
  validateLicense(payload);
  return JSON.parse(serializeLicense(payload));
}

// ---------------------------------------------------------------------------
// The license's signed-attestation framing, passed to the GENERIC attestation core. The core does ALL
// the crypto + the wrap-don't-edit invariant; this supplies ONLY the license-specific framing
// (kind/schema/note/label) + the unsigned payload codec. This is the SAME pattern the seal/dataset use.
// ---------------------------------------------------------------------------

const SIGNED_LICENSE_KIND = "trustledger-license-signed";
const SIGNED_LICENSE_SCHEMA_VERSION = 1;
const SUPPORTED_SIGNED_LICENSE_SCHEMA_VERSIONS = Object.freeze([1]);

const SIGNED_LICENSE_TRUST_NOTE =
  "This is a SIGNED TrustLedger license container: it WRAPS (never edits) the EXACT canonical license " +
  "bytes in `attestation` and attaches a detached EIP-191 signature. verifyLicense RE-DERIVES the " +
  "signer from those bytes and pins it to the vendor key — it never trusts the file's own claims. " +
  "Every caveat of the embedded license applies. " +
  LICENSE_TRUST_NOTE;

const SIGNED_LICENSE_CFG = Object.freeze({
  kind: SIGNED_LICENSE_KIND,
  schemaVersion: SIGNED_LICENSE_SCHEMA_VERSION,
  supportedSchemaVersions: SUPPORTED_SIGNED_LICENSE_SCHEMA_VERSIONS,
  note: SIGNED_LICENSE_TRUST_NOTE,
  label: "signed trustledger license",
  validateUnsigned: validateLicense,
  serializeUnsigned: serializeLicense,
});

// ---------------------------------------------------------------------------
// buildLicense({...}, signer) — mint a SIGNED license container. Builds + validates the unsigned
// payload, then routes it + the caller's signer through the SHARED `signAttestation` core, which signs
// the EXACT canonical bytes (EIP-191 personal_sign) and wraps + validates the container. NO key
// handling here — the key lives only inside the signer object. The container ROUND-TRIPS by
// construction: verifyLicense recovers exactly this signer over exactly serializeLicense(payload).
//
// @param {object} params  { licenseId, customer, plan, entitlements, issuedAt, expiresAt }
// @param {object} signer  an ethers signer-like object: async getAddress() + signMessage()
// @returns {Promise<object>} the validated signed-license container
// ---------------------------------------------------------------------------

async function buildLicense(params, signer) {
  const payload = buildLicensePayload(params);
  return coreAttestation.signAttestation({ attestation: payload, signer }, SIGNED_LICENSE_CFG);
}

/** Strictly validate a parsed SIGNED-license container — thin wrapper over the shared core. */
function validateSignedLicense(obj) {
  return coreAttestation.validateSignedAttestation(obj, SIGNED_LICENSE_CFG);
}

/** Serialize a SIGNED-license container to its canonical bytes — thin wrapper over the shared core. */
function serializeSignedLicense(container) {
  return coreAttestation.serializeSignedAttestation(container, SIGNED_LICENSE_CFG);
}

// ---------------------------------------------------------------------------
// readLicense(text|obj) — parse + strictly validate a SIGNED-license container (JSON string or object).
// A parse error is a LicenseError (never a raw SyntaxError); a malformed/corrupt container is rejected
// by the shared validator, never half-accepted.
// ---------------------------------------------------------------------------

function readLicense(input) {
  let obj;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch (e) {
      throw new LicenseError(`license container is not valid JSON: ${e.message}`);
    }
  } else if (isPlainObject(input)) {
    obj = input;
  } else {
    throw new LicenseError("readLicense requires a JSON string or a signed-license container object");
  }
  // Surface the core's structural rejection as a LicenseError so callers catch ONE error type. The core
  // throws plain Errors; we re-tag the message.
  try {
    coreAttestation.validateSignedAttestation(obj, SIGNED_LICENSE_CFG);
  } catch (e) {
    throw new LicenseError(e.message);
  }
  return obj;
}

// ---------------------------------------------------------------------------
// verifyLicense(container, { now, vendorAddress }) — the AUTHORITATIVE, PURE, OFFLINE verify.
//
// Re-derive the canonical payload from the container's embedded bytes, recover the signer via the
// EXISTING core recovery, and return a STRUCTURED verdict. `valid` is true ONLY when ALL hold:
//   (a) the envelope signature verifies (recovers to the CLAIMED signer);
//   (b) the recovered signer EQUALS the pinned `vendorAddress` (any other key => wrong_issuer);
//   (c) `now` is within [issuedAt, expiresAt] inclusive.
// Otherwise a LOCALIZED reason is returned (never thrown for an ordinary rejection):
//   * malformed       — the container is structurally invalid (not a sound signed license)
//   * bad_signature   — the signature does not recover to the claimed signer (tamper / corrupt)
//   * wrong_issuer    — recovered, but NOT the pinned vendor key
//   * not_yet_valid   — now < issuedAt
//   * expired         — now > expiresAt
//
// `now` is an EXPLICIT argument (a Date, an ISO string, or epoch-ms number) — verifyLicense NEVER reads
// the system clock, so it stays pure/deterministic. `vendorAddress` is REQUIRED: a license is worthless
// without a key to pin it to (we never "trust whoever signed it"). NO I/O, NO network, NO key.
//
// @param {object} container  a signed-license container (from buildLicense/readLicense)
// @param {object} opts       { now: Date|string|number, vendorAddress: string }
// @returns {{
//   valid: boolean,
//   reason: null|"malformed"|"bad_signature"|"wrong_issuer"|"not_yet_valid"|"expired",
//   recoveredSigner: string|null,
//   vendorAddress: string,
//   payload: object|null,
//   entitlements: string[],
//   now: string,
// }}
// ---------------------------------------------------------------------------

function verifyLicense(container, opts) {
  if (!isPlainObject(opts)) {
    throw new LicenseError("verifyLicense requires an options object { now, vendorAddress }");
  }
  // vendorAddress is REQUIRED + must be a syntactically valid address. We normalize via the core's
  // ethers getAddress (accepts checksummed/mixed-case) and lowercase it for comparison. A garbage
  // vendorAddress is a CALLER error (thrown), distinct from an ordinary license rejection.
  let normalizedVendor;
  try {
    normalizedVendor = getAddress(opts.vendorAddress);
  } catch (_e) {
    throw new LicenseError(
      `verifyLicense requires a valid vendorAddress (0x-address to pin the issuer to), got: ${String(opts.vendorAddress)}`
    );
  }
  const vendorLc = normalizedVendor.toLowerCase();

  // `now` — accept a Date, an ISO string, or epoch-ms; resolve to epoch-ms. A garbage `now` is a CALLER
  // error (thrown). We record the resolved instant as an ISO string for transparency. NOTE: `now` is
  // INTENTIONALLY lenient (it is the caller's explicit clock arg, not a self-asserted payload date) — a
  // date-only "2026-06-23" is accepted as UTC midnight, unlike the strict, canonical ISO instants the
  // payload's issuedAt/expiresAt are held to. The window check only compares epoch-ms.
  let nowMs;
  if (opts.now instanceof Date) {
    nowMs = opts.now.getTime();
  } else if (typeof opts.now === "number" && Number.isFinite(opts.now)) {
    nowMs = opts.now;
  } else if (typeof opts.now === "string") {
    nowMs = Date.parse(opts.now);
  } else {
    nowMs = NaN;
  }
  if (Number.isNaN(nowMs)) {
    throw new LicenseError(
      `verifyLicense requires a valid \`now\` (a Date, ISO string, or epoch-ms number), got: ${String(opts.now)}`
    );
  }
  const nowIso = new Date(nowMs).toISOString();

  function reject(reason, recoveredSigner, payload) {
    return {
      valid: false,
      reason,
      recoveredSigner: recoveredSigner == null ? null : recoveredSigner,
      vendorAddress: vendorLc,
      payload: payload == null ? null : payload,
      entitlements: [],
      now: nowIso,
    };
  }

  // (0) STRUCTURAL: the container must be a sound signed license, with an embedded payload that
  //     re-validates (the core enforces the wrap-don't-edit invariant). A malformed/hand-corrupted
  //     container is `malformed`, never trusted. The embedded payload must ALSO parse to a sound
  //     license so we can read its dates/entitlements.
  let payload;
  try {
    coreAttestation.validateSignedAttestation(container, SIGNED_LICENSE_CFG);
    payload = JSON.parse(container.attestation);
    validateLicense(payload);
  } catch (_e) {
    return reject("malformed", null, null);
  }

  // (a) SIGNATURE: recover the signer from the embedded bytes and confirm it matches the CLAIMED signer.
  //     A tampered payload byte (the embedded bytes no longer match what was signed) recovers to the
  //     wrong address — signatureMatchesSigner is false — so this is `bad_signature`. A structurally
  //     unrecoverable signature is also caught (the core returns "(unrecoverable)").
  const att = coreAttestation.verifySignedAttestation({ container });
  if (!att.checks.signatureMatchesSigner) {
    return reject("bad_signature", att.recoveredSigner === "(unrecoverable)" ? null : att.recoveredSigner, payload);
  }
  const recovered = att.recoveredSigner; // lowercase 0x-address

  // (b) ISSUER PIN: the recovered signer must EQUAL the pinned vendor key. A license signed by any other
  //     key is REJECTED (wrong_issuer), never trusted — this is the TRUST-BOUNDARIES re-derivation.
  if (recovered !== vendorLc) {
    return reject("wrong_issuer", recovered, payload);
  }

  // (c) WINDOW: `now` must be within [issuedAt, expiresAt] inclusive. validateLicense already proved
  //     expiresAt > issuedAt, so the window is non-empty.
  const issuedMs = Date.parse(payload.issuedAt);
  const expiresMs = Date.parse(payload.expiresAt);
  if (nowMs < issuedMs) {
    return reject("not_yet_valid", recovered, payload);
  }
  if (nowMs > expiresMs) {
    return reject("expired", recovered, payload);
  }

  // VALID — signature verifies, issuer is the vendor, and now is in-window.
  return {
    valid: true,
    reason: null,
    recoveredSigner: recovered,
    vendorAddress: vendorLc,
    payload,
    entitlements: payload.entitlements.slice(),
    now: nowIso,
  };
}

// ---------------------------------------------------------------------------
// hasEntitlement(verdict, flag) — PURE. True ONLY when the verdict is `valid` AND `flag` is present in
// its entitlements. False for ANY non-valid verdict (a rejected/expired/wrong-issuer license entitles
// NOTHING) and for an unknown/absent flag. This is the single gate product code should call — it can
// never accidentally honor an entitlement from an untrusted verdict.
// ---------------------------------------------------------------------------

function hasEntitlement(verdict, flag) {
  if (!isPlainObject(verdict) || verdict.valid !== true) return false;
  if (typeof flag !== "string") return false;
  return Array.isArray(verdict.entitlements) && verdict.entitlements.includes(flag);
}

module.exports = {
  LICENSE_KIND,
  LICENSE_SCHEMA_VERSION,
  SUPPORTED_LICENSE_SCHEMA_VERSIONS,
  LICENSE_TRUST_NOTE,
  ENTITLEMENTS,
  ENTITLEMENT_FLAGS,
  LicenseError,
  // unsigned payload
  validateLicense,
  serializeLicense,
  buildLicensePayload,
  // signed container (shared core)
  SIGNED_LICENSE_CFG,
  SIGNED_LICENSE_KIND,
  SIGNED_LICENSE_TRUST_NOTE,
  buildLicense,
  validateSignedLicense,
  serializeSignedLicense,
  readLicense,
  verifyLicense,
  hasEntitlement,
};

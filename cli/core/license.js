"use strict";

// cli/core/license.js — the GENERIC, product-agnostic SIGNED-ENTITLEMENT (license) engine.
//
// WHY THIS EXISTS
//   verifyhash is growing into a FAMILY of provenance products. Each one that sells a paid surface needs
//   the SAME thing: a way for a VENDOR to mint a `*.vhlicense.json` that the CLI/server can verify
//   OFFLINE — no license server, no network call, no key on the customer's machine — strictly answering
//   "did OUR vendor key sign this?" and "is it in-window, and what does it entitle?". The license PAYLOAD
//   shape (a versioned object: id/customer/plan + a CLOSED set of entitlement flags + an [issuedAt,
//   expiresAt] window), the canonical serializer, the strict validator, and the OFFLINE verify
//   (re-derive the signer, PIN it to the vendor, check the window, localize the reject reason) are
//   IDENTICAL across products; only the product `kind`, its `schemaVersion`, and its CLOSED entitlement
//   TABLE differ. This module is the SINGLE, tested implementation of that machinery; each product is a
//   THIN adapter that supplies its OWN `kind`/`schemaVersion`/entitlement table as an explicit `cfg`
//   (mirroring how cli/core/manifest.js takes a `cfg`).
//
// REUSE — the proven signed-attestation envelope, VERBATIM.
//   A license is just one more product on the shared signed-attestation envelope (cli/core/attestation.js),
//   exactly like the seal/dataset/parcel. We define an UNSIGNED license PAYLOAD, a canonical serializer,
//   and a strict validator, then hand those to `cli/core/attestation.js` as the product framing. The
//   attestation core does ALL the crypto: it embeds the EXACT canonical payload bytes as the attestation,
//   attaches the detached EIP-191 signature, and later RE-DERIVES the signer from those bytes. There is NO
//   new crypto here, NO new dependency — `buildLicense` wraps via `signAttestation`, `verifyLicense`
//   recovers via `verifySignedAttestation`, exactly as the seal does.
//
// PURE + I/O-FREE.
//   Every function here is pure: no filesystem, no clock, no network, no key handling (the key lives only
//   inside the caller's signer object). `verifyLicense` takes `now` as an explicit argument — it never
//   reads the system clock — so the same container + same `now` + same `vendorAddress` + same `cfg`
//   always yield a byte-identical verdict. (The product adapter's `read` may do I/O via the attestation
//   core; this core itself never touches disk.)
//
// TRUST-BOUNDARIES — the license is an UNTRUSTED transport container.
//   `verifyLicense` RE-DERIVES the signer from the supplied bytes and PINS it to the caller's
//   `vendorAddress`. It NEVER trusts the file's own claims: a license that merely SAYS it was signed by
//   the vendor, but recovers to a different key, is `wrong_issuer`, not trusted. An unknown entitlement
//   flag (one not in the supplied `cfg` table) is a hard build REJECT, never silently honored.
//   Entitlements only mean anything once the verdict is `valid`.
//
// PRODUCT-AGNOSTIC: this module NEVER requires a product module, so the dependency points product → core,
//   never the reverse — no back-edge.

const coreAttestation = require("./attestation");
const { getAddress } = require("ethers");

// A strict ISO-8601 UTC instant, e.g. "2026-05-31T00:00:00.000Z". We require the canonical form ethers/
// JS emit via `new Date(...).toISOString()` so two logically-identical licenses serialize to identical
// bytes. We REJECT a date-only ("YYYY-MM-DD") or an offset-bearing form (over-loose) — the license dates
// are machine-compared instants, so they must be a single, unambiguous UTC encoding. Shared across the
// product family so the instant grammar can never diverge between products.
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

// ---------------------------------------------------------------------------
// Errors — STRICT. A malformed/ambiguous license raises a NAMED error rather than being silently
// dropped, coerced, or partially accepted. The error CLASS is product-agnostic; a product adapter that
// wants its OWN error name (e.g. TrustLedger's historical `LicenseError`) supplies it via `cfg.ErrorClass`
// so its byte-for-byte messages + thrown type stay UNCHANGED.
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
// Internal: assert a product passed a structurally complete license config. The injected
// `kind`/`schemaVersion`/entitlement table is how the core stays product-agnostic without knowing
// anything product-specific (so there is no `require("../../trustledger/license")` back-edge). Defends the
// core against an adapter that forgot a field — a clear programmer error HERE, not a confusing downstream
// symptom.
// ---------------------------------------------------------------------------

function _requireCfg(cfg) {
  if (!isPlainObject(cfg)) {
    throw new Error(
      "license core requires a { kind, schemaVersion, supportedSchemaVersions, note, entitlements, signedKind, signedSchemaVersion, supportedSignedSchemaVersions, signedNote } config"
    );
  }
  // OPTIONAL: the product's CANONICAL vendor identity (T-75.3) — the ONE committed address an
  // entitlement GATE pins license verification to (see resolveVendorPin below). When present it must be
  // a non-empty string; address validity is enforced where it is consumed so the error is a named
  // cfg.ErrorClass, not a raw core Error.
  if (cfg.canonicalVendor !== undefined && (typeof cfg.canonicalVendor !== "string" || cfg.canonicalVendor.length === 0)) {
    throw new Error("license core config `canonicalVendor`, when present, must be a non-empty 0x-address string");
  }
  if (typeof cfg.kind !== "string" || cfg.kind.length === 0) {
    throw new Error("license core config requires a non-empty string `kind`");
  }
  if (!Array.isArray(cfg.supportedSchemaVersions) || cfg.supportedSchemaVersions.length === 0) {
    throw new Error("license core config requires a non-empty `supportedSchemaVersions` array");
  }
  if (!cfg.supportedSchemaVersions.includes(cfg.schemaVersion)) {
    throw new Error("license core config `schemaVersion` must be one of `supportedSchemaVersions`");
  }
  if (typeof cfg.note !== "string") {
    throw new Error("license core config requires a string `note` (the in-band trust caveat)");
  }
  if (!isPlainObject(cfg.entitlements) || Object.keys(cfg.entitlements).length === 0) {
    throw new Error(
      "license core config requires a non-empty `entitlements` table { flag -> human meaning } (the CLOSED entitlement set)"
    );
  }
  if (typeof cfg.signedKind !== "string" || cfg.signedKind.length === 0) {
    throw new Error("license core config requires a non-empty string `signedKind`");
  }
  if (!Array.isArray(cfg.supportedSignedSchemaVersions) || cfg.supportedSignedSchemaVersions.length === 0) {
    throw new Error("license core config requires a non-empty `supportedSignedSchemaVersions` array");
  }
  if (typeof cfg.signedNote !== "string") {
    throw new Error("license core config requires a string `signedNote`");
  }
}

// The product's named error class, or the core's default. So an adapter's historical error TYPE + name is
// preserved byte-for-byte.
function _errClass(cfg) {
  return (cfg && typeof cfg.ErrorClass === "function") ? cfg.ErrorClass : LicenseError;
}

// The frozen, SORTED list of valid entitlement flags for a cfg — derived from the table so the two can
// never drift. Sorted so error messages + any iteration are deterministic.
function entitlementFlags(cfg) {
  _requireCfg(cfg);
  return Object.freeze(Object.keys(cfg.entitlements).sort());
}

// ---------------------------------------------------------------------------
// validateLicense(obj, cfg) — STRICT structural validation of an UNSIGNED license PAYLOAD against a
// product's framing. Throws a named error (cfg.ErrorClass) on the FIRST problem; returns the object
// unchanged on success. This is the `validateUnsigned` the attestation core re-runs on the embedded
// payload (the wrap-don't-edit invariant), so a signed container can never smuggle a malformed/edited
// license.
//
// REJECTS: a wrong kind / schemaVersion; a wrong note; a missing/non-string licenseId/customer/plan; a
// non-array or empty entitlements; a duplicate or unknown (not-in-cfg) entitlement flag; a non-ISO
// issuedAt/expiresAt; expiresAt <= issuedAt. It NEVER half-accepts or fills defaults.
// ---------------------------------------------------------------------------

function validateLicense(obj, cfg) {
  _requireCfg(cfg);
  const Err = _errClass(cfg);
  const FLAGS = entitlementFlags(cfg);

  if (!isPlainObject(obj)) {
    throw new Err("license payload must be a JSON object");
  }
  if (obj.kind !== cfg.kind) {
    throw new Err(
      `not a trustledger license (kind: ${JSON.stringify(obj.kind)}; expected ${JSON.stringify(cfg.kind)})`
    );
  }
  if (!cfg.supportedSchemaVersions.includes(obj.schemaVersion)) {
    throw new Err(
      `unsupported license schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(cfg.supportedSchemaVersions)})`
    );
  }
  if (obj.note !== cfg.note) {
    throw new Err("license `note` must be the standing LICENSE_TRUST_NOTE (caveat must not drift)");
  }

  for (const f of ["licenseId", "customer", "plan"]) {
    if (typeof obj[f] !== "string" || obj[f].length === 0) {
      throw new Err(`license ${f} must be a non-empty string`);
    }
  }

  // entitlements — a closed set of KNOWN flags (drawn ONLY from cfg.entitlements), each used at most once.
  if (!Array.isArray(obj.entitlements) || obj.entitlements.length === 0) {
    throw new Err("license `entitlements` must be a non-empty array of known flags");
  }
  const seen = new Set();
  for (const flag of obj.entitlements) {
    if (typeof flag !== "string") {
      throw new Err(`license entitlement must be a string flag, got: ${JSON.stringify(flag)}`);
    }
    if (!Object.prototype.hasOwnProperty.call(cfg.entitlements, flag)) {
      throw new Err(
        `unknown license entitlement: ${JSON.stringify(flag)} ` +
          `(this build understands ${JSON.stringify(FLAGS)})`
      );
    }
    if (seen.has(flag)) {
      throw new Err(`license has a duplicate entitlement: ${JSON.stringify(flag)}`);
    }
    seen.add(flag);
  }

  // issuedAt / expiresAt — strict ISO instants, expiresAt strictly after issuedAt.
  for (const f of ["issuedAt", "expiresAt"]) {
    if (typeof obj[f] !== "string" || !ISO_INSTANT_RE.test(obj[f])) {
      throw new Err(
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
      throw new Err(
        `license ${f} must be a canonical ISO-8601 UTC instant ("YYYY-MM-DDTHH:MM:SS.mmmZ", millis required, ` +
          `no rolled-over/impossible fields), got: ${String(obj[f])}`
      );
    }
  }
  const issuedMs = Date.parse(obj.issuedAt);
  const expiresMs = Date.parse(obj.expiresAt);
  if (expiresMs <= issuedMs) {
    throw new Err(
      `license expiresAt (${obj.expiresAt}) must be strictly AFTER issuedAt (${obj.issuedAt})`
    );
  }

  return obj;
}

// ---------------------------------------------------------------------------
// serializeLicense(payload, cfg) — canonical, byte-deterministic serialization of an UNSIGNED license
// payload: a FIXED key order, NO insignificant whitespace, a single trailing newline. Entitlements are
// emitted in the FROZEN entitlementFlags(cfg) order (filtered to those present) so the bytes are
// independent of the caller's array order. This is the EXACT byte sequence the envelope signs over and
// `verifyLicense` re-derives the signer from — so two logically-identical licenses sign identically.
// ---------------------------------------------------------------------------

function serializeLicense(payload, cfg) {
  validateLicense(payload, cfg);
  const FLAGS = entitlementFlags(cfg);
  const present = new Set(payload.entitlements);
  const canonical = {
    kind: payload.kind,
    schemaVersion: payload.schemaVersion,
    note: payload.note,
    licenseId: payload.licenseId,
    customer: payload.customer,
    plan: payload.plan,
    // Emit in the fixed table order, filtered to those present — order-independent canonical form.
    entitlements: FLAGS.filter((f) => present.has(f)),
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  };
  return JSON.stringify(canonical) + "\n";
}

// ---------------------------------------------------------------------------
// buildLicensePayload(params, cfg) — assemble + strictly validate an UNSIGNED license payload from caller
// fields. PURE. This is the payload that `buildLicense` then wraps in the signed envelope. Splitting it
// out lets a caller hold/inspect the unsigned payload before signing (and lets the build path validate
// the SAME way the embedded payload is re-validated on read).
// ---------------------------------------------------------------------------

function buildLicensePayload(params, cfg) {
  _requireCfg(cfg);
  const Err = _errClass(cfg);
  if (!isPlainObject(params)) {
    throw new Err(
      "buildLicensePayload requires a { licenseId, customer, plan, entitlements, issuedAt, expiresAt } object"
    );
  }
  const payload = {
    kind: cfg.kind,
    schemaVersion: cfg.schemaVersion,
    note: cfg.note,
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
  validateLicense(payload, cfg);
  return JSON.parse(serializeLicense(payload, cfg));
}

// ---------------------------------------------------------------------------
// _signedCfg(cfg) — the SIGNED-attestation framing passed to the GENERIC attestation core, derived from
// the product's license `cfg`. The attestation core does ALL the crypto + the wrap-don't-edit invariant;
// this supplies ONLY the product-specific framing (signedKind/schema/note/label) + the unsigned payload
// codec (bound to THIS cfg). This is the SAME pattern the seal/dataset use.
// ---------------------------------------------------------------------------

function _signedCfg(cfg) {
  _requireCfg(cfg);
  return {
    kind: cfg.signedKind,
    schemaVersion: cfg.signedSchemaVersion,
    supportedSchemaVersions: cfg.supportedSignedSchemaVersions,
    note: cfg.signedNote,
    label: cfg.signedLabel || "signed license",
    validateUnsigned: (obj) => validateLicense(obj, cfg),
    serializeUnsigned: (obj) => serializeLicense(obj, cfg),
  };
}

// ---------------------------------------------------------------------------
// buildLicense(params, signer, cfg) — mint a SIGNED license container. Builds + validates the unsigned
// payload, then routes it + the caller's signer through the SHARED `signAttestation` core, which signs the
// EXACT canonical bytes (EIP-191 personal_sign) and wraps + validates the container. NO key handling here —
// the key lives only inside the signer object. The container ROUND-TRIPS by construction: verifyLicense
// recovers exactly this signer over exactly serializeLicense(payload, cfg).
//
// @param {object} params  { licenseId, customer, plan, entitlements, issuedAt, expiresAt }
// @param {object} signer  an ethers signer-like object: async getAddress() + signMessage()
// @param {object} cfg     the product's license framing
// @returns {Promise<object>} the validated signed-license container
// ---------------------------------------------------------------------------

async function buildLicense(params, signer, cfg) {
  const payload = buildLicensePayload(params, cfg);
  return coreAttestation.signAttestation({ attestation: payload, signer }, _signedCfg(cfg));
}

/** Strictly validate a parsed SIGNED-license container — thin wrapper over the shared core. */
function validateSignedLicense(obj, cfg) {
  return coreAttestation.validateSignedAttestation(obj, _signedCfg(cfg));
}

/** Serialize a SIGNED-license container to its canonical bytes — thin wrapper over the shared core. */
function serializeSignedLicense(container, cfg) {
  return coreAttestation.serializeSignedAttestation(container, _signedCfg(cfg));
}

// ---------------------------------------------------------------------------
// readLicense(text|obj, cfg) — parse + strictly validate a SIGNED-license container (JSON string or
// object). A parse error is a cfg.ErrorClass (never a raw SyntaxError); a malformed/corrupt container is
// rejected by the shared validator, never half-accepted.
// ---------------------------------------------------------------------------

function readLicense(input, cfg) {
  _requireCfg(cfg);
  const Err = _errClass(cfg);
  let obj;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch (e) {
      throw new Err(`license container is not valid JSON: ${e.message}`);
    }
  } else if (isPlainObject(input)) {
    obj = input;
  } else {
    throw new Err("readLicense requires a JSON string or a signed-license container object");
  }
  // Surface the core's structural rejection as a cfg.ErrorClass so callers catch ONE error type. The core
  // throws plain Errors; we re-tag the message.
  try {
    coreAttestation.validateSignedAttestation(obj, _signedCfg(cfg));
  } catch (e) {
    throw new Err(e.message);
  }
  return obj;
}

// ---------------------------------------------------------------------------
// verifyLicense(container, { now, vendorAddress, cfg }) — the AUTHORITATIVE, PURE, OFFLINE verify.
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
// without a key to pin it to (we never "trust whoever signed it"). `cfg` is REQUIRED: it is the product's
// license framing (kind/schema/note/entitlement table). NO I/O, NO network, NO key.
//
// @param {object} container  a signed-license container (from buildLicense/readLicense)
// @param {object} opts       { now: Date|string|number, vendorAddress: string, cfg: object }
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
    throw new LicenseError("verifyLicense requires an options object { now, vendorAddress, cfg }");
  }
  const cfg = opts.cfg;
  _requireCfg(cfg);
  const Err = _errClass(cfg);
  const signedCfg = _signedCfg(cfg);

  // vendorAddress is REQUIRED + must be a syntactically valid address. We normalize via the core's
  // ethers getAddress (accepts checksummed/mixed-case) and lowercase it for comparison. A garbage
  // vendorAddress is a CALLER error (thrown), distinct from an ordinary license rejection.
  let normalizedVendor;
  try {
    normalizedVendor = getAddress(opts.vendorAddress);
  } catch (_e) {
    throw new Err(
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
    throw new Err(
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
    coreAttestation.validateSignedAttestation(container, signedCfg);
    payload = JSON.parse(container.attestation);
    validateLicense(payload, cfg);
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
// resolveVendorPin(cfg, callerVendor) — PURE. Resolve the ONE address an ENTITLEMENT GATE may pin
// license verification to: the product's CANONICAL vendor identity (`cfg.canonicalVendor`, a COMMITTED
// constant/config), never a caller-supplied address.
//
// WHY (T-75.3, the self-mint leak). A gate that verifies a license against "whatever address the caller
// passes as --vendor" is no gate at all: anyone can mint a license with their OWN key and pass their OWN
// address, unlocking the paid surface for free. The pin an entitlement gate verifies against must
// therefore be a committed constant the CALLER cannot choose. A caller-supplied vendor is still ACCEPTED
// as an explicit assertion — but ONLY when it EQUALS the canonical identity; a mismatch is a NAMED
// cfg.ErrorClass, never a silent re-pin and never a silent downgrade.
//
// HONEST BOUNDARY — this is NOT DRM. The source is open (Apache-2.0): an operator running their OWN
// instance legitimately sets their OWN canonical vendor identity (their committed constant / config),
// and their licenses unlock THEIR instance. What this closes is the shipped default free-riding a HOSTED
// vendor: the stock build's paid surface honors ONLY licenses minted by the published vendor key.
// (See docs/LICENSING.md "Paid-gate vendor pinning".)
//
// NOTE: the read-only license-inspection verb (`license verify --vendor <addr>`) is NOT a gate — it
// answers "did THIS key sign it?" for any address, so it keeps calling verifyLicense with an explicit
// caller pin. Only ENTITLEMENT-UNLOCK paths route through resolveVendorPin.
//
// @param {object} cfg           the product's license framing; MUST carry `canonicalVendor`
// @param {string} [callerVendor] optional caller-asserted vendor address; must EQUAL the canonical
// @returns {string} the checksummed canonical vendor address (the pin to hand verifyLicense)
// ---------------------------------------------------------------------------

function resolveVendorPin(cfg, callerVendor) {
  _requireCfg(cfg);
  const Err = _errClass(cfg);
  if (typeof cfg.canonicalVendor !== "string" || cfg.canonicalVendor.length === 0) {
    throw new Err(
      "resolveVendorPin requires cfg.canonicalVendor (the product's COMMITTED canonical vendor identity); " +
        "an entitlement gate must never pin license verification to a caller-supplied address"
    );
  }
  let canonical;
  try {
    canonical = getAddress(cfg.canonicalVendor);
  } catch (_e) {
    throw new Err(
      `license cfg canonicalVendor is not a valid 0x-address: ${String(cfg.canonicalVendor)}`
    );
  }
  if (callerVendor == null) return canonical;
  let caller;
  try {
    caller = getAddress(callerVendor);
  } catch (_e) {
    throw new Err(
      `the supplied vendor pin is not a valid 0x-address: ${String(callerVendor)}`
    );
  }
  if (caller !== canonical) {
    throw new Err(
      `the supplied vendor pin (${caller}) does not match the canonical vendor identity (${canonical}) ` +
        "this build pins paid entitlements to. A caller-supplied vendor cannot re-pin an entitlement gate " +
        "(that would let anyone self-mint a license and unlock the paid surface for free). " +
        "Running your OWN instance? Set your OWN canonical vendor identity instead — see docs/LICENSING.md."
    );
  }
  return canonical;
}

// ---------------------------------------------------------------------------
// hasEntitlement(verdict, flag) — PURE. True ONLY when the verdict is `valid` AND `flag` is present in
// its entitlements. False for ANY non-valid verdict (a rejected/expired/wrong-issuer license entitles
// NOTHING) and for an unknown/absent flag. This is product-AGNOSTIC (it reads only the verdict), so it
// needs no cfg. The single gate product code should call — it can never accidentally honor an entitlement
// from an untrusted verdict.
// ---------------------------------------------------------------------------

function hasEntitlement(verdict, flag) {
  if (!isPlainObject(verdict) || verdict.valid !== true) return false;
  if (typeof flag !== "string") return false;
  return Array.isArray(verdict.entitlements) && verdict.entitlements.includes(flag);
}

module.exports = {
  ISO_INSTANT_RE,
  LicenseError,
  entitlementFlags,
  // unsigned payload
  validateLicense,
  serializeLicense,
  buildLicensePayload,
  // signed container (shared attestation core)
  buildLicense,
  validateSignedLicense,
  serializeSignedLicense,
  readLicense,
  verifyLicense,
  resolveVendorPin,
  hasEntitlement,
};

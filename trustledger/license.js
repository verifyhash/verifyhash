"use strict";

// TrustLedger — license.js  (EPIC-? / T-29.1, T-30.1)
//
// THE PRODUCT LICENSE — a PURE, offline-verifiable, signed entitlement token, built on the project's
// EXISTING signed-attestation envelope (`cli/core/attestation.js`), reusing it VERBATIM.
//
// THIN ADAPTER (T-30.1). All of the license MACHINERY now lives in the PRODUCT-AGNOSTIC core
// `cli/core/license.js` (which itself reuses `cli/core/attestation.js` verbatim for ALL crypto — no new
// crypto, no new dependency). This module is the TrustLedger ADAPTER: it supplies the product-specific
// framing — the `kind`/`schemaVersion`, the CLOSED `ENTITLEMENTS` table, the standing trust notes, and the
// historical `LicenseError` type — as a single closed `cfg`, then re-exports the SAME public surface so
// its byte-for-byte mint/verify outputs and every reject reason are UNCHANGED. No TrustLedger caller
// changes; verifyLicense's localized reasons (bad_signature / wrong_issuer / expired / not_yet_valid /
// malformed / unknown-entitlement) are exactly as before.
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

const coreLicense = require("../cli/core/license");

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
// dropped, coerced, or partially accepted (mirrors seal.js / close.js). TrustLedger keeps its OWN
// LicenseError TYPE (handed to the core as cfg.ErrorClass) so existing callers that `catch (LicenseError)`
// and the byte-for-byte error messages are UNCHANGED.
// ---------------------------------------------------------------------------

class LicenseError extends Error {
  constructor(message) {
    super(message);
    this.name = "LicenseError";
  }
}

// ---------------------------------------------------------------------------
// The signed-license container framing. The license is one more product on the shared signed-attestation
// envelope, exactly like the seal: an UNSIGNED license PAYLOAD wrapped in a detached signature. The
// signed container has its OWN kind/schema/note, disjoint from the embedded license payload's.
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

// ---------------------------------------------------------------------------
// THE TRUSTLEDGER LICENSE CFG — the single closed object handed to cli/core/license.js. It carries the
// product framing (the unsigned license `kind`/`schema`/`note`/`entitlements`), the signed-container
// framing (`signedKind`/...), and the historical `ErrorClass` so the core throws TrustLedger's
// LicenseError verbatim. Every adapter function below routes through the core with THIS cfg, so the
// behaviour is byte-for-byte the pre-extraction behaviour.
// ---------------------------------------------------------------------------

const CFG = Object.freeze({
  // unsigned license payload framing
  kind: LICENSE_KIND,
  schemaVersion: LICENSE_SCHEMA_VERSION,
  supportedSchemaVersions: SUPPORTED_LICENSE_SCHEMA_VERSIONS,
  note: LICENSE_TRUST_NOTE,
  entitlements: ENTITLEMENTS,
  // signed-container framing
  signedKind: SIGNED_LICENSE_KIND,
  signedSchemaVersion: SIGNED_LICENSE_SCHEMA_VERSION,
  supportedSignedSchemaVersions: SUPPORTED_SIGNED_LICENSE_SCHEMA_VERSIONS,
  signedNote: SIGNED_LICENSE_TRUST_NOTE,
  signedLabel: "signed trustledger license",
  // historical error type (so callers + messages are unchanged)
  ErrorClass: LicenseError,
});

// The SIGNED_LICENSE_CFG the previous module exported (the attestation-core framing). Re-derived here from
// the same pieces so any external reader sees the SAME object shape it did before the extraction.
const SIGNED_LICENSE_CFG = Object.freeze({
  kind: SIGNED_LICENSE_KIND,
  schemaVersion: SIGNED_LICENSE_SCHEMA_VERSION,
  supportedSchemaVersions: SUPPORTED_SIGNED_LICENSE_SCHEMA_VERSIONS,
  note: SIGNED_LICENSE_TRUST_NOTE,
  label: "signed trustledger license",
  validateUnsigned: (obj) => coreLicense.validateLicense(obj, CFG),
  serializeUnsigned: (obj) => coreLicense.serializeLicense(obj, CFG),
});

// ---------------------------------------------------------------------------
// Public surface — each a THIN adapter binding the TrustLedger CFG to the product-agnostic core. The
// signatures match the pre-extraction module exactly, so NO TrustLedger caller changes.
// ---------------------------------------------------------------------------

/** STRICT structural validation of an UNSIGNED license PAYLOAD. Throws LicenseError on the first problem. */
function validateLicense(obj) {
  return coreLicense.validateLicense(obj, CFG);
}

/** Canonical, byte-deterministic serialization of an UNSIGNED license payload (newline-terminated). */
function serializeLicense(payload) {
  return coreLicense.serializeLicense(payload, CFG);
}

/** Assemble + strictly validate an UNSIGNED license payload from caller fields. PURE. */
function buildLicensePayload(params) {
  return coreLicense.buildLicensePayload(params, CFG);
}

/** Mint a SIGNED license container from caller fields + an ethers signer object. */
async function buildLicense(params, signer) {
  return coreLicense.buildLicense(params, signer, CFG);
}

/** Strictly validate a parsed SIGNED-license container. */
function validateSignedLicense(obj) {
  return coreLicense.validateSignedLicense(obj, CFG);
}

/** Serialize a SIGNED-license container to its canonical bytes. */
function serializeSignedLicense(container) {
  return coreLicense.serializeSignedLicense(container, CFG);
}

/** Parse + strictly validate a SIGNED-license container (JSON string or object). */
function readLicense(input) {
  return coreLicense.readLicense(input, CFG);
}

/** The AUTHORITATIVE, PURE, OFFLINE verify — re-derive the signer, pin the vendor, check the window. */
function verifyLicense(container, opts) {
  // Bind the TrustLedger CFG into the core's opts (the core requires opts.cfg). We never trust a
  // caller-supplied cfg — TrustLedger's framing is fixed.
  if (opts == null || typeof opts !== "object" || Array.isArray(opts)) {
    throw new LicenseError("verifyLicense requires an options object { now, vendorAddress }");
  }
  return coreLicense.verifyLicense(container, { now: opts.now, vendorAddress: opts.vendorAddress, cfg: CFG });
}

/** PURE entitlement gate — true only for a present flag on a VALID verdict (product-agnostic). */
function hasEntitlement(verdict, flag) {
  return coreLicense.hasEntitlement(verdict, flag);
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

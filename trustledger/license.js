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

// ---------------------------------------------------------------------------
// THE ORDER -> LICENSE MAPPING (T-37.2).
//
// fulfillOrder turns a normalized ORDER — what a billing webhook knows after a
// payment succeeds: which `plan` was bought, for which `customer`, when it was
// `issuedAt`, and through when it is `paidThrough` — into the EXACT params
// `buildLicensePayload`/`buildLicense` consume. It is the single, deterministic
// seam a self-serve fulfillment handler calls: resolve the plan in the catalog,
// copy its entitlements VERBATIM, derive the window, and hand back the params.
//
// PURE + DETERMINISTIC. No filesystem, no clock, no network, no key. The SAME
// { plan, customer, paidThrough, issuedAt } + the SAME catalog yields a
// byte-identical params object EVERY time (so the signed license bytes are
// reproducible). The caller resolves + validates the catalog (validatePlanCatalog)
// and passes it in; we never read it from disk.
//
// THE WINDOW.
//   * issuedAt is REQUIRED and must be a canonical ISO instant (validateLicense's
//     grammar — millis required, no rolled-over fields).
//   * expiresAt comes from `paidThrough` when supplied (the billing system's own
//     period end — the source of truth a renewal extends); otherwise it is DERIVED
//     as issuedAt + plan.termDays days, so a plan with NO explicit period still
//     mints a correct window from the catalog's term. Day arithmetic is on the UTC
//     epoch (termDays * 86_400_000 ms) so it is DST-free and deterministic.
//   * A paidThrough at or BEFORE issuedAt is a NAMED reject (an empty/negative
//     window is never silently honored), exactly as validateLicense rejects
//     expiresAt <= issuedAt.
//
// ENTITLEMENTS come ONLY from the resolved plan — never re-typed by the caller —
// so a typo can never under/over-entitle a paying customer. An unknown `plan` is a
// NAMED reject naming the known planIds. A malformed issuedAt/paidThrough is a
// NAMED reject (it flows through validateLicense's strict grammar when the params
// are built into a payload, and we pre-check the obvious shape here for a clear
// message). fulfillOrder NEVER signs — it only produces the params; the caller
// (fulfill) supplies the key and signs via buildLicense.
// ---------------------------------------------------------------------------

// Strict canonical-ISO check, reused so fulfillOrder's date errors match the
// validateLicense grammar exactly (millis required, no rolled-over/impossible
// fields). Returns epoch-ms or throws a LicenseError naming the offending field.
function _requireCanonicalInstant(field, value) {
  if (typeof value !== "string" || !coreLicense.ISO_INSTANT_RE.test(value)) {
    throw new LicenseError(
      `order ${field} must be an ISO-8601 UTC instant ("YYYY-MM-DDTHH:MM:SS(.mmm)Z"), got: ${String(value)}`
    );
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== value) {
    throw new LicenseError(
      `order ${field} must be a canonical ISO-8601 UTC instant ("YYYY-MM-DDTHH:MM:SS.mmmZ", millis required, ` +
        `no rolled-over/impossible fields), got: ${String(value)}`
    );
  }
  return ms;
}

// Resolve a planId against a VALIDATED catalog WITHOUT importing plans.js (which
// already depends on license.js — importing it back would be a require cycle). We
// read the frozen plansById map the catalog carries; an unknown id is a NAMED
// reject naming the known plans.
function _resolvePlan(catalog, planId) {
  if (
    catalog == null ||
    typeof catalog !== "object" ||
    catalog.plansById == null ||
    typeof catalog.plansById !== "object"
  ) {
    throw new LicenseError("fulfillOrder requires a validated plan catalog (see plans.validatePlanCatalog)");
  }
  if (typeof planId !== "string" || planId.trim() === "") {
    throw new LicenseError("order `plan` must be a non-empty planId string");
  }
  if (!Object.prototype.hasOwnProperty.call(catalog.plansById, planId)) {
    const known = Object.keys(catalog.plansById).sort().join(", ");
    throw new LicenseError(
      `unknown plan ${JSON.stringify(planId)}; known plans are: ${known}`
    );
  }
  return catalog.plansById[planId];
}

/**
 * fulfillOrder(order, catalog) — PURE, DETERMINISTIC order -> license-params mapping.
 *
 * @param {object} order
 *   @param {string} order.plan         a planId present in `catalog`
 *   @param {string} order.customer     the customer name (non-empty)
 *   @param {string} order.issuedAt     REQUIRED canonical ISO instant the license is issued at
 *   @param {string} [order.paidThrough] OPTIONAL canonical ISO instant the period is paid through;
 *                                       when omitted, expiresAt = issuedAt + plan.termDays days
 *   @param {string} [order.licenseId]  OPTIONAL explicit id; defaulted deterministically when omitted
 * @param {object} catalog a VALIDATED plan catalog (plans.validatePlanCatalog output)
 * @returns {{ licenseId, customer, plan, entitlements, issuedAt, expiresAt }}
 *          the EXACT params buildLicensePayload/buildLicense consume.
 */
function fulfillOrder(order, catalog) {
  if (order == null || typeof order !== "object" || Array.isArray(order)) {
    throw new LicenseError(
      "fulfillOrder requires an order object { plan, customer, issuedAt, paidThrough?, licenseId? }"
    );
  }
  const plan = _resolvePlan(catalog, order.plan);

  if (typeof order.customer !== "string" || order.customer.length === 0) {
    throw new LicenseError("order `customer` must be a non-empty string");
  }

  // issuedAt is REQUIRED and held to the strict canonical grammar up front (a clear
  // message rather than a buried buildLicensePayload throw).
  const issuedMs = _requireCanonicalInstant("issuedAt", order.issuedAt);

  // Derive expiresAt: an explicit paidThrough wins (the billing period's own end);
  // otherwise issuedAt + termDays days on the UTC epoch (DST-free, deterministic).
  let expiresAt;
  if (order.paidThrough != null) {
    const paidMs = _requireCanonicalInstant("paidThrough", order.paidThrough);
    if (paidMs <= issuedMs) {
      throw new LicenseError(
        `order paidThrough (${order.paidThrough}) must be strictly AFTER issuedAt (${order.issuedAt})`
      );
    }
    expiresAt = order.paidThrough;
  } else {
    // termDays * one UTC day in ms. termDays is a validated positive integer, so the
    // result is a real future instant; toISOString re-canonicalizes it.
    const DAY_MS = 86400000;
    expiresAt = new Date(issuedMs + plan.termDays * DAY_MS).toISOString();
  }

  // licenseId: an explicit one wins; else a DETERMINISTIC default derived from the
  // order (same order => same id => byte-identical params), mirroring license issue.
  const licenseId =
    order.licenseId != null && order.licenseId !== ""
      ? order.licenseId
      : `LIC-${order.issuedAt}-${plan.planId}`;

  // Entitlements come ONLY from the resolved plan, copied verbatim (a fresh array so
  // the frozen catalog plan is never handed out by reference). buildLicensePayload
  // re-canonicalizes order + validates the closed set.
  return {
    licenseId,
    customer: order.customer,
    plan: plan.planId,
    entitlements: plan.entitlements.slice(),
    issuedAt: order.issuedAt,
    expiresAt,
  };
}

// ===========================================================================
// THE EVENT -> ORDER NORMALIZER + IDEMPOTENCY KEY (T-38.2).
//
// fulfillOrder (above) consumes an ORDER already shaped to OUR vocabulary:
// `{ plan, customer, paidThrough, issuedAt }` with OUR planId and CANONICAL ISO
// instants. But a billing provider's webhook does NOT fire with that shape. A real
// Stripe `invoice.paid` / `checkout.session.completed` (or Paddle) event carries:
//   * the PROVIDER's own price/product id (e.g. `price_...`) — NOT our planId;
//   * a `customer` reference;
//   * a period-end as a UNIX EPOCH in SECONDS (`current_period_end`) — NOT the
//     canonical ISO `fulfillOrder` strictly requires;
//   * and it is delivered AT-LEAST-ONCE, so the SAME event can arrive twice.
//
// normalizeEvent is the PURE seam that closes that gap: it maps a NORMALIZED EVENT
// ENVELOPE (a provider event already flattened to a single canonical shape by the
// integrator's thin per-provider extractor) onto the EXACT order fulfillOrder
// consumes. It:
//   1. reads `rawEvent.provider` + `rawEvent.priceId` and RESOLVES OUR planId via
//      the supplied, catalog-validated price BINDING (plans.resolvePlanId) — an
//      UNMAPPED (provider, priceId) is a NAMED reject, never a silent mis-grant of
//      the wrong PLAN (the exact class T-38.1 closed one level up);
//   2. converts the period-end UNIX EPOCH SECONDS -> the canonical ISO `paidThrough`
//      grammar fulfillOrder requires (a non-integer / negative / out-of-range epoch
//      is a NAMED reject, never coerced/rounded);
//   3. derives `customer` (a missing/blank customer is a NAMED reject — a license
//      with no holder is never silently minted);
//   4. sets `issuedAt` from `rawEvent.issuedAt` or an explicit `opts.issuedAt` —
//      with NO hidden clock read, so the module stays PURE/testable (the caller, who
//      DOES know the wall clock, supplies it; the loop never reads the system clock).
//
// PURE + DETERMINISTIC. No filesystem, no clock, no network, no key. The SAME
// rawEvent + the SAME binding (+ opts) yields a BYTE-IDENTICAL order EVERY time, so
// `fulfillOrder(normalizeEvent(ev, binding), catalog)` is reproducible end-to-end.
//
// IDEMPOTENCY. orderKey(order) returns the DETERMINISTIC `LIC-<issuedAt>-<plan>`
// seed — the SAME value fulfillOrder defaults the licenseId to. A handler that has
// already minted (and stored) the license under that key short-circuits a RETRIED
// delivery of the same event, so a retry re-mints the BYTE-IDENTICAL license, never
// a second/different one. (Authenticating the inbound webhook — verifying the
// provider's signing secret — is a HUMAN step; normalizeEvent only maps an
// ALREADY-AUTHENTICATED event's fields.)
//
// HONEST POSTURE. The normalized envelope is OPERATOR/integrator-supplied: this
// function does NOT call a provider API and does NOT trust an unauthenticated event
// on its own — it is the pure mapping the handler runs AFTER it authenticates.
// ===========================================================================

// The period-end epoch is in SECONDS (Stripe/Paddle convention). Guard the integer
// range so the *1000 ms math stays exact and inside JS's safe-integer window — a
// fractional, negative, or absurd epoch is a NAMED reject, never silently coerced.
const _MAX_EPOCH_SECONDS = 8640000000000; // == Date max (ms) / 1000; beyond this toISOString throws.

// Convert a UNIX epoch in SECONDS -> the canonical ISO instant fulfillOrder's
// grammar requires. STRICT: a non-number/non-integer/negative/out-of-range epoch
// throws a NAMED LicenseError naming the field. Returns the canonical ISO string.
function _epochSecondsToCanonicalISO(field, epochSeconds) {
  if (
    typeof epochSeconds !== "number" ||
    !Number.isInteger(epochSeconds) ||
    epochSeconds < 0 ||
    epochSeconds > _MAX_EPOCH_SECONDS
  ) {
    throw new LicenseError(
      `event ${field} must be a non-negative INTEGER UNIX epoch in SECONDS ` +
        `(0..${_MAX_EPOCH_SECONDS}), got: ${String(epochSeconds)}`
    );
  }
  // Exact: epochSeconds is a safe integer in-range, so *1000 is exact and
  // toISOString re-canonicalizes to "YYYY-MM-DDTHH:MM:SS.mmmZ".
  return new Date(epochSeconds * 1000).toISOString();
}

/**
 * normalizeEvent(rawEvent, binding, opts?) — PURE, DETERMINISTIC map of a NORMALIZED
 * provider event envelope onto the EXACT `{ plan, customer, paidThrough, issuedAt }`
 * order fulfillOrder consumes.
 *
 * @param {object} rawEvent  the normalized event envelope
 *   @param {string} rawEvent.provider    the billing provider id (e.g. "stripe") — bound side of the key
 *   @param {string} [rawEvent.type]      the provider event type (e.g. "invoice.paid"); carried through, advisory
 *   @param {string} rawEvent.priceId     the PROVIDER's price/product id — resolved to OUR planId via `binding`
 *   @param {string} rawEvent.customer    who the license is for (non-empty)
 *   @param {number} rawEvent.periodEnd   the period end as a UNIX epoch in SECONDS -> canonical ISO `paidThrough`
 *   @param {string} [rawEvent.issuedAt]  canonical ISO instant the license is issued at (or pass `opts.issuedAt`)
 * @param {object} binding  a VALIDATED price binding (plans.validatePriceBinding output)
 * @param {object} [opts]
 *   @param {string} [opts.issuedAt]      explicit canonical ISO issuedAt; WINS over rawEvent.issuedAt
 * @returns {{ plan, customer, paidThrough, issuedAt }} the EXACT order fulfillOrder consumes.
 */
function normalizeEvent(rawEvent, binding, opts) {
  if (rawEvent == null || typeof rawEvent !== "object" || Array.isArray(rawEvent)) {
    throw new LicenseError(
      "normalizeEvent requires a normalized event envelope " +
        "{ provider, priceId, customer, periodEnd, issuedAt? }"
    );
  }
  if (opts != null && (typeof opts !== "object" || Array.isArray(opts))) {
    throw new LicenseError("normalizeEvent opts, when given, must be an object { issuedAt? }");
  }

  // ---- provider + priceId -> OUR planId, via the catalog-validated binding ----
  // We resolve THROUGH plans.resolvePlanId (the single authority): an unmapped
  // (provider, priceId) is its NAMED reject. `plans` is required LAZILY inside the
  // function (never at module top-level) because plans.js requires license.js — a
  // top-level back-edge would be a cycle. By call time both modules are fully
  // initialized, so the lazy require is safe and the dependency graph stays acyclic.
  if (typeof rawEvent.provider !== "string" || rawEvent.provider.trim() === "") {
    throw new LicenseError("event `provider` must be a non-empty string");
  }
  if (typeof rawEvent.priceId !== "string" || rawEvent.priceId.trim() === "") {
    throw new LicenseError("event `priceId` must be a non-empty string");
  }
  // eslint-disable-next-line global-require
  const plans = require("./plans");
  let planId;
  try {
    planId = plans.resolvePlanId(binding, rawEvent.provider, rawEvent.priceId);
  } catch (e) {
    // Surface the binding's NAMED reason verbatim, but as a LicenseError so a
    // fulfillment handler catches ONE error type across the normalize+fulfill seam.
    throw new LicenseError(
      `cannot normalize event: ${e && e.message ? e.message : String(e)}`
    );
  }

  // ---- customer (a license with no holder is never silently minted) -----------
  if (typeof rawEvent.customer !== "string" || rawEvent.customer.length === 0) {
    throw new LicenseError("event `customer` must be a non-empty string");
  }

  // ---- period-end UNIX epoch SECONDS -> canonical ISO paidThrough -------------
  if (!Object.prototype.hasOwnProperty.call(rawEvent, "periodEnd")) {
    throw new LicenseError("event is missing required field: periodEnd (UNIX epoch seconds)");
  }
  const paidThrough = _epochSecondsToCanonicalISO("periodEnd", rawEvent.periodEnd);

  // ---- issuedAt: explicit opts.issuedAt WINS, else rawEvent.issuedAt. NO clock.
  // We require ONE of them be supplied so the module never has to read the system
  // clock — it stays pure/testable. The chosen value is held to the canonical grammar so a
  // malformed instant is a NAMED reject here (rather than a buried fulfillOrder throw).
  const issuedAt =
    opts != null && opts.issuedAt != null ? opts.issuedAt : rawEvent.issuedAt;
  if (issuedAt == null) {
    throw new LicenseError(
      "event `issuedAt` is required (supply rawEvent.issuedAt or opts.issuedAt); " +
        "normalizeEvent never reads the system clock"
    );
  }
  _requireCanonicalInstant("issuedAt", issuedAt);

  // The EXACT order shape fulfillOrder consumes — provider event type is advisory
  // and intentionally NOT carried into the order (the order is provider-agnostic).
  return { plan: planId, customer: rawEvent.customer, paidThrough, issuedAt };
}

/**
 * orderKey(order) — the DETERMINISTIC `LIC-<issuedAt>-<plan>` idempotency seed.
 *
 * This is the SAME value fulfillOrder defaults the licenseId to, so an idempotent
 * webhook handler dedupes on it: if a license already exists under this key, a
 * RETRIED delivery of the same event resolves to the SAME order -> the SAME key ->
 * the handler returns the already-minted, BYTE-IDENTICAL license rather than minting
 * a second/different one. PURE — derives only from the order's own fields.
 *
 * @param {{ plan: string, issuedAt: string }} order  an order (e.g. normalizeEvent output)
 * @returns {string} `LIC-<issuedAt>-<plan>`
 */
function orderKey(order) {
  if (order == null || typeof order !== "object" || Array.isArray(order)) {
    throw new LicenseError("orderKey requires an order object { plan, issuedAt }");
  }
  if (typeof order.plan !== "string" || order.plan.trim() === "") {
    throw new LicenseError("order `plan` must be a non-empty planId string");
  }
  // issuedAt is held to the canonical grammar so the key is stable + unambiguous
  // (the same instant always yields the same key).
  _requireCanonicalInstant("issuedAt", order.issuedAt);
  return `LIC-${order.issuedAt}-${order.plan}`;
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
  // order -> license-params mapping (T-37.2)
  fulfillOrder,
  // event -> order normalizer + idempotency key (T-38.2)
  normalizeEvent,
  orderKey,
};

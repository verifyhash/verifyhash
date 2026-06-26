"use strict";

// ---------------------------------------------------------------------------
// cli/core/evidence-plans.js — THE EVIDENCE PLAN CATALOG (T-48.1).
//
// A versioned, strictly-validated planId -> { entitlements, termDays, displayName }
// mapping over the EVIDENCE product's CLOSED ENTITLEMENTS table (evidence_signed,
// evidence_unlimited) + a PURE deterministic fulfillEvidenceOrder(order, catalog).
// This MIRRORS trustledger/plans.js (validatePlanCatalog/getPlan) and
// trustledger/license.js's fulfillOrder EXACTLY, but is bound to the EVIDENCE CFG
// so the two products stay DISJOINT: a different catalog `kind`, a different closed
// entitlement set, and a different license `kind`. The two catalogs can never be
// mistaken for one another and a TrustLedger entitlement can never enter an
// evidence plan (nor vice-versa).
//
// WHY HERE (cli/core/, next to the evidence license framing).
//   The closed entitlement table is the EVIDENCE module's `LICENSE_CFG.entitlements`
//   (cli/evidence.js). This module imports that CFG and derives its allowed flag set
//   from it via the SAME core `entitlementFlags(cfg)` helper the license gate uses —
//   never a hard-coded copy — so the catalog and the gate that honors a license can
//   never drift. The evidence CFG remains the SINGLE source of truth for the closed
//   table.
//
// DESIGN PROPERTIES (identical posture to trustledger/plans.js).
//   * PURE / I-O-FREE / DETERMINISTIC. NO filesystem, NO clock, NO network, NO
//     ethers/key handling. validateEvidencePlanCatalog takes the parsed object as an
//     argument (the caller reads the bundled JSON and passes it); getEvidencePlan is
//     a pure lookup; fulfillEvidenceOrder is a pure mapping. The same inputs always
//     produce byte-identical output, and a grep finds no fs / http / ethers-require /
//     clock use in this file.
//   * STRICT. A malformed catalog (wrong kind, unsupported schemaVersion,
//     empty/missing plans, a duplicate planId, an unknown/forged entitlement flag, an
//     empty entitlement bundle, a non-positive/non-integer termDays, a missing
//     displayName) raises a NAMED error on the FIRST defect — never a silent pass,
//     never a partial accept, never a last-wins mis-grant.
//   * CLOSED ENTITLEMENTS, single source of truth. The set of entitlement flags a
//     plan may grant is the EVIDENCE license CFG's CLOSED table, derived via
//     coreLicense.entitlementFlags(LICENSE_CFG). A flag not in that table is a hard
//     reject.
//
// HONEST POSTURE.
//   A plan is an ACCESS DESCRIPTION for delivered software value: which evidence
//   features the subscription unlocks and for how long. It is NOT a token, NOT
//   tradeable, NOT an appreciating asset, and the catalog makes NO claim of
//   regulatory compliance. The actual subscription agreement governs; this file only
//   maps a purchased plan to the features it entitles.
// ---------------------------------------------------------------------------

const coreLicense = require("./license");
// The evidence product framing (the closed entitlement table + license kind) lives in
// cli/evidence.js. We import its LICENSE_CFG / error class so the catalog is bound to
// the SAME closed table the evidence license gate honors. (cli/evidence.js requires
// this module's siblings but NOT this file, so there is no require cycle.)
const evidence = require("../evidence");

// The evidence catalog has its OWN `kind`/`schemaVersion`, DISJOINT from the
// TrustLedger plan-catalog kind, the evidence seal/license payloads, etc. — so an
// evidence catalog can never be mistaken for one of them. Validation REJECTS any
// unsupported version rather than guessing.
const EVIDENCE_PLAN_CATALOG_KIND = "vh-evidence-plan-catalog";
const EVIDENCE_PLAN_CATALOG_SCHEMA_VERSION = 1;
const SUPPORTED_EVIDENCE_PLAN_CATALOG_SCHEMA_VERSIONS = Object.freeze([1]);

// The dedicated error type for catalog defects. Distinct, named class so callers/tests
// catch ONE evidence-plan-catalog error.
class EvidencePlanCatalogError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvidencePlanCatalogError";
  }
}

// The SINGLE source of valid entitlement flags: the EVIDENCE license CFG's CLOSED
// table, derived (never re-declared) via the SAME core helper the gate uses, so the
// catalog and the gate can never drift. Exposed as a GENUINELY IMMUTABLE frozen array
// (NOT a Set — a frozen Set's `.add()` is a no-op lock; a frozen array cannot be
// extended under "use strict") so the exported closed set cannot grow.
const ALLOWED_ENTITLEMENT_FLAGS = Object.freeze([
  ...coreLicense.entitlementFlags(evidence.LICENSE_CFG),
]);

// A private, frozen null-prototype membership index for O(1) lookup, derived from the
// SAME frozen array. Not exported; frozen + null-proto so it can neither be widened nor
// polluted via __proto__.
const _ALLOWED_FLAG_INDEX = Object.freeze(
  ALLOWED_ENTITLEMENT_FLAGS.reduce((m, f) => {
    m[f] = true;
    return m;
  }, Object.create(null))
);
function _isAllowedEntitlement(flag) {
  return Object.prototype.hasOwnProperty.call(_ALLOWED_FLAG_INDEX, flag);
}

// ---------------------------------------------------------------------------
// validateEvidencePlanCatalog(obj) -> validated, deeply-FROZEN catalog
// ---------------------------------------------------------------------------
//
// Strictly validates and returns a NEW deeply-frozen, canonical catalog object. Throws
// EvidencePlanCatalogError on the FIRST defect. Never mutates the input. PURE: the
// caller parses the JSON (or passes an object) and hands it in. The returned catalog
// carries a planId-sorted `plans` array + a frozen `plansById` lookup map.
function validateEvidencePlanCatalog(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new EvidencePlanCatalogError("evidence plan catalog must be a JSON object");
  }

  // ---- kind: must be exactly the evidence catalog kind ---------------------
  if (obj.kind !== EVIDENCE_PLAN_CATALOG_KIND) {
    throw new EvidencePlanCatalogError(
      `evidence plan catalog has wrong kind ${JSON.stringify(obj.kind)}; ` +
        `expected ${JSON.stringify(EVIDENCE_PLAN_CATALOG_KIND)}`
    );
  }

  // ---- schemaVersion: present and exactly a supported integer --------------
  if (!Object.prototype.hasOwnProperty.call(obj, "schemaVersion")) {
    throw new EvidencePlanCatalogError(
      "evidence plan catalog is missing required field: schemaVersion"
    );
  }
  if (!SUPPORTED_EVIDENCE_PLAN_CATALOG_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new EvidencePlanCatalogError(
      `unsupported evidence plan catalog schemaVersion ${JSON.stringify(obj.schemaVersion)}; ` +
        `this build understands: ${SUPPORTED_EVIDENCE_PLAN_CATALOG_SCHEMA_VERSIONS.join(", ")}`
    );
  }

  // ---- plans: a non-empty array of plan entries ----------------------------
  if (!Object.prototype.hasOwnProperty.call(obj, "plans")) {
    throw new EvidencePlanCatalogError(
      "evidence plan catalog is missing required field: plans"
    );
  }
  if (!Array.isArray(obj.plans)) {
    throw new EvidencePlanCatalogError("evidence plan catalog plans must be an array");
  }
  if (obj.plans.length === 0) {
    throw new EvidencePlanCatalogError(
      "evidence plan catalog plans must be a non-empty array"
    );
  }

  // Validate each plan; collect into a planId -> frozen-plan map, rejecting a duplicate
  // planId (an ambiguous catalog is a hard error, never a last-wins mis-grant).
  const byId = new Map();
  for (let i = 0; i < obj.plans.length; i++) {
    const plan = _validatePlan(obj.plans[i], i);
    if (byId.has(plan.planId)) {
      throw new EvidencePlanCatalogError(
        `evidence plan catalog has duplicate planId ${JSON.stringify(plan.planId)}`
      );
    }
    byId.set(plan.planId, plan);
  }

  // Build a canonical, deeply-frozen catalog. The plans array is emitted in
  // planId-sorted order so enumeration is deterministic regardless of input order;
  // `plansById` is a frozen lookup map for getEvidencePlan.
  const sortedIds = [...byId.keys()].sort();
  const plans = Object.freeze(sortedIds.map((id) => byId.get(id)));
  const plansById = Object.freeze(
    sortedIds.reduce((m, id) => {
      m[id] = byId.get(id);
      return m;
    }, Object.create(null))
  );

  return Object.freeze({
    kind: EVIDENCE_PLAN_CATALOG_KIND,
    schemaVersion: obj.schemaVersion,
    plans,
    plansById,
  });
}

// ---------------------------------------------------------------------------
// _validatePlan(plan, index) -> a frozen, canonical plan
// ---------------------------------------------------------------------------
//
// Strictly validates ONE plan entry. `index` is woven into the error so a defect is
// locatable. Throws EvidencePlanCatalogError on the first problem.
function _validatePlan(plan, index) {
  const at = `plan[${index}]`;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    throw new EvidencePlanCatalogError(`${at} must be an object`);
  }

  // ---- planId: a non-empty string handle -----------------------------------
  if (typeof plan.planId !== "string" || plan.planId.trim() === "") {
    throw new EvidencePlanCatalogError(`${at}.planId must be a non-empty string`);
  }
  const planId = plan.planId;

  // ---- displayName: a non-empty human label (required) ---------------------
  if (typeof plan.displayName !== "string" || plan.displayName.trim() === "") {
    throw new EvidencePlanCatalogError(
      `evidence plan ${JSON.stringify(planId)} is missing a non-empty displayName`
    );
  }

  // ---- entitlements: a non-empty closed set drawn ONLY from the EVIDENCE
  //      closed table; no unknown flag, no duplicate --------------------------
  if (!Array.isArray(plan.entitlements)) {
    throw new EvidencePlanCatalogError(
      `evidence plan ${JSON.stringify(planId)} entitlements must be an array`
    );
  }
  if (plan.entitlements.length === 0) {
    throw new EvidencePlanCatalogError(
      `evidence plan ${JSON.stringify(planId)} entitlements must be a non-empty array`
    );
  }
  const seen = new Set();
  for (const flag of plan.entitlements) {
    if (typeof flag !== "string") {
      throw new EvidencePlanCatalogError(
        `evidence plan ${JSON.stringify(planId)} has a non-string entitlement ${JSON.stringify(flag)}`
      );
    }
    if (!_isAllowedEntitlement(flag)) {
      throw new EvidencePlanCatalogError(
        `evidence plan ${JSON.stringify(planId)} has unknown entitlement ${JSON.stringify(flag)}; ` +
          `closed set is: ${ALLOWED_ENTITLEMENT_FLAGS.join(", ")}`
      );
    }
    if (seen.has(flag)) {
      throw new EvidencePlanCatalogError(
        `evidence plan ${JSON.stringify(planId)} has duplicate entitlement ${JSON.stringify(flag)}`
      );
    }
    seen.add(flag);
  }
  // Emit entitlements in the CLOSED-table sort order regardless of input order, so a
  // plan's serialization is byte-deterministic and order-independent.
  const entitlements = Object.freeze([...seen].sort());

  // ---- termDays: a positive INTEGER number of days -------------------------
  // Integer discipline: a non-integer or non-positive term is a hard reject, never
  // rounded or coerced.
  if (!Object.prototype.hasOwnProperty.call(plan, "termDays")) {
    throw new EvidencePlanCatalogError(
      `evidence plan ${JSON.stringify(planId)} is missing required field: termDays`
    );
  }
  if (typeof plan.termDays !== "number" || !Number.isInteger(plan.termDays)) {
    throw new EvidencePlanCatalogError(
      `evidence plan ${JSON.stringify(planId)} termDays must be an integer; got ${JSON.stringify(plan.termDays)}`
    );
  }
  if (plan.termDays <= 0) {
    throw new EvidencePlanCatalogError(
      `evidence plan ${JSON.stringify(planId)} termDays must be a positive integer; got ${JSON.stringify(plan.termDays)}`
    );
  }

  return Object.freeze({
    planId,
    displayName: plan.displayName,
    entitlements,
    termDays: plan.termDays,
  });
}

// ---------------------------------------------------------------------------
// getEvidencePlan(catalog, planId) -> the frozen plan, or throws on an unknown id
// ---------------------------------------------------------------------------
//
// PURE lookup against a VALIDATED catalog. Returns the frozen plan for a known id;
// throws a NAMED EvidencePlanCatalogError NAMING the known plans for an unknown id
// (never returns undefined — an unknown plan is an error, not an empty entitlement).
function getEvidencePlan(catalog, planId) {
  if (
    catalog === null ||
    typeof catalog !== "object" ||
    catalog.plansById === null ||
    typeof catalog.plansById !== "object"
  ) {
    throw new EvidencePlanCatalogError(
      "getEvidencePlan requires a validated evidence plan catalog"
    );
  }
  if (typeof planId !== "string" || planId.trim() === "") {
    throw new EvidencePlanCatalogError("getEvidencePlan requires a non-empty planId");
  }
  if (!Object.prototype.hasOwnProperty.call(catalog.plansById, planId)) {
    const known = Object.keys(catalog.plansById).sort().join(", ");
    throw new EvidencePlanCatalogError(
      `unknown evidence planId ${JSON.stringify(planId)}; known plans are: ${known}`
    );
  }
  return catalog.plansById[planId];
}

// ===========================================================================
// THE EVIDENCE ORDER -> LICENSE-PARAMS MAPPING.
//
// fulfillEvidenceOrder turns a normalized ORDER — what a billing webhook knows after a
// payment succeeds: which `plan` was bought, for which `customer`, when it was
// `issuedAt`, and through when it is `paidThrough` — into the EXACT params
// buildLicensePayload/buildLicense (evidence.buildLicense) consume. It MIRRORS
// trustledger/license.js's fulfillOrder EXACTLY, but is bound to the EVIDENCE catalog +
// CFG.
//
// PURE + DETERMINISTIC. No filesystem, no clock, no network, no key. The SAME
// { plan, customer, paidThrough, issuedAt } + the SAME catalog yields a byte-identical
// params object EVERY time (so the signed evidence license bytes are reproducible). The
// caller resolves + validates the catalog (validateEvidencePlanCatalog) and passes it
// in; we never read it from disk.
//
// THE WINDOW.
//   * issuedAt is REQUIRED and must be a canonical ISO instant (validateLicense's
//     grammar — millis required, no rolled-over fields).
//   * expiresAt comes from `paidThrough` when supplied (the billing system's own period
//     end — the source of truth a renewal extends); otherwise it is DERIVED as issuedAt
//     + plan.termDays days, so a plan with NO explicit period still mints a correct
//     window from the catalog's term. Day arithmetic is on the UTC epoch
//     (termDays * 86_400_000 ms) so it is DST-free and deterministic.
//   * A paidThrough at or BEFORE issuedAt is a NAMED reject (an empty/negative window is
//     never silently honored), exactly as validateLicense rejects expiresAt <= issuedAt.
//
// ENTITLEMENTS come ONLY from the resolved plan — never re-typed by the caller — so a
// typo can never under/over-entitle a paying customer. An unknown `plan` is a NAMED
// reject naming the known planIds. A malformed issuedAt/paidThrough is a NAMED reject.
// fulfillEvidenceOrder NEVER signs — it only produces the params; the caller supplies
// the key and signs via evidence.buildLicense.
// ===========================================================================

// Strict canonical-ISO check, reused so fulfillEvidenceOrder's date errors match the
// validateLicense grammar exactly (millis optional but seconds required, no
// rolled-over/impossible fields). Returns epoch-ms or throws the EVIDENCE error class
// naming the offending field. Mirrors trustledger/license.js _requireCanonicalInstant.
function _requireCanonicalInstant(field, value) {
  const Err = evidence.EvidenceLicenseError;
  if (typeof value !== "string" || !coreLicense.ISO_INSTANT_RE.test(value)) {
    throw new Err(
      `order ${field} must be an ISO-8601 UTC instant ("YYYY-MM-DDTHH:MM:SS(.mmm)Z"), got: ${String(value)}`
    );
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== value) {
    throw new Err(
      `order ${field} must be a canonical ISO-8601 UTC instant ("YYYY-MM-DDTHH:MM:SS.mmmZ", millis required, ` +
        `no rolled-over/impossible fields), got: ${String(value)}`
    );
  }
  return ms;
}

// Resolve a planId against a VALIDATED catalog. We read the frozen plansById map the
// catalog carries; an unknown id is a NAMED reject naming the known plans. Errors are
// the EVIDENCE license error class so a fulfillment handler catches ONE error type
// across the resolve+build seam.
function _resolvePlan(catalog, planId) {
  const Err = evidence.EvidenceLicenseError;
  if (
    catalog == null ||
    typeof catalog !== "object" ||
    catalog.plansById == null ||
    typeof catalog.plansById !== "object"
  ) {
    throw new Err(
      "fulfillEvidenceOrder requires a validated evidence plan catalog (see validateEvidencePlanCatalog)"
    );
  }
  if (typeof planId !== "string" || planId.trim() === "") {
    throw new Err("order `plan` must be a non-empty planId string");
  }
  if (!Object.prototype.hasOwnProperty.call(catalog.plansById, planId)) {
    const known = Object.keys(catalog.plansById).sort().join(", ");
    throw new Err(`unknown plan ${JSON.stringify(planId)}; known plans are: ${known}`);
  }
  return catalog.plansById[planId];
}

/**
 * fulfillEvidenceOrder(order, catalog) — PURE, DETERMINISTIC order -> license-params mapping.
 *
 * @param {object} order
 *   @param {string} order.plan         a planId present in `catalog`
 *   @param {string} order.customer     the customer name (non-empty)
 *   @param {string} order.issuedAt     REQUIRED canonical ISO instant the license is issued at
 *   @param {string} [order.paidThrough] OPTIONAL canonical ISO instant the period is paid through;
 *                                       when omitted, expiresAt = issuedAt + plan.termDays days
 *   @param {string} [order.licenseId]  OPTIONAL explicit id; defaulted deterministically when omitted
 * @param {object} catalog a VALIDATED evidence plan catalog (validateEvidencePlanCatalog output)
 * @returns {{ licenseId, customer, plan, entitlements, issuedAt, expiresAt }}
 *          the EXACT params buildLicensePayload/evidence.buildLicense consume.
 */
function fulfillEvidenceOrder(order, catalog) {
  const Err = evidence.EvidenceLicenseError;
  if (order == null || typeof order !== "object" || Array.isArray(order)) {
    throw new Err(
      "fulfillEvidenceOrder requires an order object { plan, customer, issuedAt, paidThrough?, licenseId? }"
    );
  }
  const plan = _resolvePlan(catalog, order.plan);

  if (typeof order.customer !== "string" || order.customer.length === 0) {
    throw new Err("order `customer` must be a non-empty string");
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
      throw new Err(
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

  // licenseId: an explicit one wins; else a DETERMINISTIC default derived from the order
  // (same order => same id => byte-identical params), mirroring fulfillOrder.
  const licenseId =
    order.licenseId != null && order.licenseId !== ""
      ? order.licenseId
      : `LIC-${order.issuedAt}-${plan.planId}`;

  // Entitlements come ONLY from the resolved plan, copied verbatim (a fresh array so the
  // frozen catalog plan is never handed out by reference). buildLicensePayload
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

module.exports = {
  EVIDENCE_PLAN_CATALOG_KIND,
  EVIDENCE_PLAN_CATALOG_SCHEMA_VERSION,
  SUPPORTED_EVIDENCE_PLAN_CATALOG_SCHEMA_VERSIONS,
  ALLOWED_ENTITLEMENT_FLAGS,
  EvidencePlanCatalogError,
  validateEvidencePlanCatalog,
  getEvidencePlan,
  fulfillEvidenceOrder,
};

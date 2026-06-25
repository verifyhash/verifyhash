"use strict";

// ---------------------------------------------------------------------------
// trustledger/plans.js — THE PLAN CATALOG (T-37.1).
//
// A versioned, strictly-validated planId -> { entitlements, term } mapping over
// the CLOSED ENTITLEMENTS set. This is the SHIPPING price-list of what a
// customer can buy: each plan names the bundle of paid features (entitlements)
// it grants and the length of the subscription TERM. The mint side of the
// license flow (`vh trust license issue`) chooses a planId; the catalog is the
// single authoritative source for which entitlements that plan unlocks and for
// how long.
//
// WHY A CATALOG (vs. typing entitlements by hand).
//   Issuing a license by hand-listing entitlement flags is error-prone: a typo
//   silently under- or over-entitles a paying customer, and there is no record
//   of what "pro-annual" actually means. A catalog pins each sellable plan to an
//   EXACT, reviewed bundle, so issuing is "pick a planId" and the entitlements
//   are derived — never re-typed.
//
// DESIGN PROPERTIES.
//   * PURE / I-O-FREE / DETERMINISTIC. This module has NO filesystem, NO clock,
//     NO network, NO ethers/key handling. `validatePlanCatalog` takes the parsed
//     object as an argument (the caller reads the bundled JSON and passes it);
//     `getPlan` is a pure lookup. The same inputs always produce byte-identical
//     output, and a grep finds no fs / http / ethers-require / clock use.
//   * STRICT. A malformed catalog (wrong kind, unsupported schemaVersion,
//     empty/missing plans, a duplicate planId, an unknown/forged entitlement
//     flag, an empty entitlement bundle, a non-positive/non-integer term, a
//     missing displayName) raises a NAMED PlanCatalogError on the FIRST defect —
//     never a silent pass, never a partial accept, never a coercion.
//   * CLOSED ENTITLEMENTS, single source of truth. The set of entitlement flags a
//     plan may grant is the license module's CLOSED table, imported as
//     `license.ENTITLEMENT_FLAGS` — NOT a hard-coded copy. A flag not in that
//     table is a hard reject, so a typo'd or forged entitlement can never enter a
//     plan, and the catalog can never drift from the gate that honors it.
//
// HONEST POSTURE.
//   A plan is an ACCESS DESCRIPTION for delivered software value: which features
//   the subscription unlocks and for how long. It is NOT a token, NOT tradeable,
//   NOT an appreciating asset, and the catalog makes NO claim of regulatory
//   compliance. The actual subscription agreement governs; this file only maps a
//   purchased plan to the features it entitles.
// ---------------------------------------------------------------------------

const license = require("./license");

// The catalog has its OWN `kind`/`schemaVersion`, disjoint from the license /
// seal / policy payloads, so a catalog can never be mistaken for one of them.
// `validatePlanCatalog` REJECTS any unsupported version rather than guessing.
const PLAN_CATALOG_KIND = "trustledger-plan-catalog";
const PLAN_CATALOG_SCHEMA_VERSION = 1;
const SUPPORTED_PLAN_CATALOG_SCHEMA_VERSIONS = Object.freeze([1]);

// The SINGLE source of valid entitlement flags: the license module's CLOSED
// table, imported (never re-declared) so the catalog and the gate that honors a
// license can never drift. `ENTITLEMENT_FLAGS` is already the frozen, sorted key
// list of `license.ENTITLEMENTS`; we wrap it in a Set for O(1) membership.
const ALLOWED_ENTITLEMENT_FLAGS = Object.freeze(new Set(license.ENTITLEMENT_FLAGS));

class PlanCatalogError extends Error {
  constructor(message) {
    super(message);
    this.name = "PlanCatalogError";
  }
}

// ---------------------------------------------------------------------------
// validatePlanCatalog(obj) -> validated, deeply-FROZEN catalog
// ---------------------------------------------------------------------------
//
// Strictly validates and returns a NEW deeply-frozen, canonical catalog object.
// Throws PlanCatalogError on the FIRST defect. Never mutates the input. PURE:
// the caller parses the JSON (or passes an object) and hands it in.
function validatePlanCatalog(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new PlanCatalogError("plan catalog must be a JSON object");
  }

  // ---- kind: must be exactly the catalog kind ------------------------------
  if (obj.kind !== PLAN_CATALOG_KIND) {
    throw new PlanCatalogError(
      `plan catalog has wrong kind ${JSON.stringify(obj.kind)}; ` +
        `expected ${JSON.stringify(PLAN_CATALOG_KIND)}`
    );
  }

  // ---- schemaVersion: present and exactly a supported integer --------------
  if (!Object.prototype.hasOwnProperty.call(obj, "schemaVersion")) {
    throw new PlanCatalogError("plan catalog is missing required field: schemaVersion");
  }
  if (!SUPPORTED_PLAN_CATALOG_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new PlanCatalogError(
      `unsupported plan catalog schemaVersion ${JSON.stringify(obj.schemaVersion)}; ` +
        `this build understands: ${SUPPORTED_PLAN_CATALOG_SCHEMA_VERSIONS.join(", ")}`
    );
  }

  // ---- plans: a non-empty array of plan entries ----------------------------
  if (!Object.prototype.hasOwnProperty.call(obj, "plans")) {
    throw new PlanCatalogError("plan catalog is missing required field: plans");
  }
  if (!Array.isArray(obj.plans)) {
    throw new PlanCatalogError("plan catalog plans must be an array");
  }
  if (obj.plans.length === 0) {
    throw new PlanCatalogError("plan catalog plans must be a non-empty array");
  }

  // Validate each plan; collect into a planId -> frozen-plan map, rejecting a
  // duplicate planId (an ambiguous catalog is a hard error, never a last-wins).
  const byId = new Map();
  for (let i = 0; i < obj.plans.length; i++) {
    const plan = validatePlan(obj.plans[i], i);
    if (byId.has(plan.planId)) {
      throw new PlanCatalogError(
        `plan catalog has duplicate planId ${JSON.stringify(plan.planId)}`
      );
    }
    byId.set(plan.planId, plan);
  }

  // Build a canonical, deeply-frozen catalog. The plans array is emitted in
  // planId-sorted order so the catalog's enumeration is deterministic regardless
  // of input order; `plansById` is a frozen lookup map for getPlan.
  const sortedIds = [...byId.keys()].sort();
  const plans = Object.freeze(sortedIds.map((id) => byId.get(id)));
  const plansById = Object.freeze(
    sortedIds.reduce((m, id) => {
      m[id] = byId.get(id);
      return m;
    }, Object.create(null))
  );

  return Object.freeze({
    kind: PLAN_CATALOG_KIND,
    schemaVersion: obj.schemaVersion,
    plans,
    plansById,
  });
}

// ---------------------------------------------------------------------------
// validatePlan(plan, index) -> a frozen, canonical plan
// ---------------------------------------------------------------------------
//
// Strictly validates ONE plan entry. `index` is woven into the error so a defect
// is locatable. Throws PlanCatalogError on the first problem.
function validatePlan(plan, index) {
  const at = `plan[${index}]`;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    throw new PlanCatalogError(`${at} must be an object`);
  }

  // ---- planId: a non-empty string handle -----------------------------------
  if (typeof plan.planId !== "string" || plan.planId.trim() === "") {
    throw new PlanCatalogError(`${at}.planId must be a non-empty string`);
  }
  const planId = plan.planId;

  // ---- displayName: a non-empty human label (required) ---------------------
  if (typeof plan.displayName !== "string" || plan.displayName.trim() === "") {
    throw new PlanCatalogError(
      `plan ${JSON.stringify(planId)} is missing a non-empty displayName`
    );
  }

  // ---- entitlements: a non-empty closed set drawn ONLY from the license
  //      module's CLOSED table; no unknown flag, no duplicate -----------------
  if (!Array.isArray(plan.entitlements)) {
    throw new PlanCatalogError(
      `plan ${JSON.stringify(planId)} entitlements must be an array`
    );
  }
  if (plan.entitlements.length === 0) {
    throw new PlanCatalogError(
      `plan ${JSON.stringify(planId)} entitlements must be a non-empty array`
    );
  }
  const seen = new Set();
  for (const flag of plan.entitlements) {
    if (typeof flag !== "string") {
      throw new PlanCatalogError(
        `plan ${JSON.stringify(planId)} has a non-string entitlement ${JSON.stringify(flag)}`
      );
    }
    if (!ALLOWED_ENTITLEMENT_FLAGS.has(flag)) {
      throw new PlanCatalogError(
        `plan ${JSON.stringify(planId)} has unknown entitlement ${JSON.stringify(flag)}; ` +
          `closed set is: ${license.ENTITLEMENT_FLAGS.join(", ")}`
      );
    }
    if (seen.has(flag)) {
      throw new PlanCatalogError(
        `plan ${JSON.stringify(planId)} has duplicate entitlement ${JSON.stringify(flag)}`
      );
    }
    seen.add(flag);
  }
  // Emit entitlements in the CLOSED-table sort order regardless of input order,
  // so a plan's serialization is byte-deterministic and order-independent.
  const entitlements = Object.freeze([...seen].sort());

  // ---- termDays: a positive INTEGER number of days -------------------------
  // Integer cents-style discipline: a non-integer or non-positive term is a hard
  // reject, never rounded or coerced.
  if (!Object.prototype.hasOwnProperty.call(plan, "termDays")) {
    throw new PlanCatalogError(
      `plan ${JSON.stringify(planId)} is missing required field: termDays`
    );
  }
  if (typeof plan.termDays !== "number" || !Number.isInteger(plan.termDays)) {
    throw new PlanCatalogError(
      `plan ${JSON.stringify(planId)} termDays must be an integer; got ${JSON.stringify(plan.termDays)}`
    );
  }
  if (plan.termDays <= 0) {
    throw new PlanCatalogError(
      `plan ${JSON.stringify(planId)} termDays must be a positive integer; got ${JSON.stringify(plan.termDays)}`
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
// getPlan(catalog, planId) -> the frozen plan, or throws on an unknown id
// ---------------------------------------------------------------------------
//
// PURE lookup against a VALIDATED catalog. Returns the frozen plan for a known
// id; throws a NAMED PlanCatalogError for an unknown id (never returns undefined
// — an unknown plan is an error, not an empty entitlement).
function getPlan(catalog, planId) {
  if (
    catalog === null ||
    typeof catalog !== "object" ||
    catalog.plansById === null ||
    typeof catalog.plansById !== "object"
  ) {
    throw new PlanCatalogError("getPlan requires a validated plan catalog");
  }
  if (typeof planId !== "string" || planId.trim() === "") {
    throw new PlanCatalogError("getPlan requires a non-empty planId");
  }
  if (!Object.prototype.hasOwnProperty.call(catalog.plansById, planId)) {
    const known = Object.keys(catalog.plansById).sort().join(", ");
    throw new PlanCatalogError(
      `unknown planId ${JSON.stringify(planId)}; known plans are: ${known}`
    );
  }
  return catalog.plansById[planId];
}

module.exports = {
  PLAN_CATALOG_KIND,
  PLAN_CATALOG_SCHEMA_VERSION,
  SUPPORTED_PLAN_CATALOG_SCHEMA_VERSIONS,
  ALLOWED_ENTITLEMENT_FLAGS,
  PlanCatalogError,
  validatePlanCatalog,
  getPlan,
};

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
// list of `license.ENTITLEMENTS`.
//
// We expose the closed table as a GENUINELY IMMUTABLE frozen array — NOT a Set:
// `Object.freeze(new Set(...))` does NOT stop `.add()`, so a frozen Set is a
// no-op lock and the security-critical closed table could be WIDENED in-process
// (a forged flag injected, then honored at validation). A frozen array cannot be
// extended (`.push`/index-set throw under "use strict"), so the exported closed
// set cannot grow, and the membership gate below derives from this same frozen
// source so the two can never drift.
const ALLOWED_ENTITLEMENT_FLAGS = Object.freeze([...license.ENTITLEMENT_FLAGS]);

// A private, frozen null-prototype membership index for O(1) lookup, derived from
// the SAME frozen array. Not exported (callers see the frozen array), and frozen +
// null-proto so it can neither be widened nor polluted via __proto__.
const _ALLOWED_FLAG_INDEX = Object.freeze(
  ALLOWED_ENTITLEMENT_FLAGS.reduce((m, f) => {
    m[f] = true;
    return m;
  }, Object.create(null))
);
function _isAllowedEntitlement(flag) {
  return Object.prototype.hasOwnProperty.call(_ALLOWED_FLAG_INDEX, flag);
}

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
    if (!_isAllowedEntitlement(flag)) {
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

// ===========================================================================
// THE PRICE -> PLAN BINDING (T-38.1).
//
// A versioned, strictly-validated `(provider, priceId) -> planId` routing table
// over the SAME plan catalog. A billing provider's "payment succeeded / renewed"
// webhook does NOT carry our planId — it carries the PROVIDER'S own price/product
// id (e.g. a Stripe `price_...` id) plus a customer + a period-end epoch. The
// fulfillment handler must MAP that price id onto one of THIS catalog's plans
// BEFORE it mints a license, or a typo silently grants the wrong PLAN — the exact
// silent-mis-grant class the catalog closed for ENTITLEMENTS but left open one
// level up. This binding closes it: a price id can ONLY point at a planId the
// SUPPLIED CATALOG actually defines (validated here, at load time — never deferred
// to fulfill time), and an unmapped `(provider, priceId)` is a NAMED reject, never
// a silent pass.
//
// DESIGN PROPERTIES (identical posture to validatePlanCatalog).
//   * PURE / I-O-FREE / DETERMINISTIC. No filesystem, clock, network, or ethers.
//     `validatePriceBinding(obj, catalog)` takes the parsed object AND a VALIDATED
//     catalog as arguments (the caller does the I/O); `resolvePlanId` is a pure
//     lookup. The same inputs always produce byte-identical output.
//   * STRICT. A malformed binding (wrong kind, unsupported schemaVersion,
//     empty/missing mappings, a duplicate (provider, priceId), a missing/blank
//     provider or priceId, or a planId NOT present in the supplied catalog) raises
//     a NAMED PriceBindingError on the FIRST defect — never a silent pass.
//   * THE CATALOG IS THE SINGLE SOURCE OF VALID planIds. A mapping pointing at a
//     planId the catalog does not define is REJECTED at validation time (via
//     getPlan), so a price can NEVER resolve to a non-existent plan downstream.
//
// HONEST POSTURE.
//   This binding is an OPERATOR-MAINTAINED routing table, NOT a token / tradeable
//   / appreciating asset, and makes NO claim of regulatory compliance. It does NOT
//   authenticate the inbound webhook — verifying the provider's signing secret is
//   a HUMAN step; this module only maps an already-authenticated event's price id
//   onto a plan. The actual subscription agreement governs.
// ===========================================================================

// The binding has its OWN kind/schemaVersion, disjoint from the catalog / license
// / seal payloads, so a binding can never be mistaken for one of them.
const PRICE_BINDING_KIND = "trustledger-price-binding";
const PRICE_BINDING_SCHEMA_VERSION = 1;
const SUPPORTED_PRICE_BINDING_SCHEMA_VERSIONS = Object.freeze([1]);

class PriceBindingError extends Error {
  constructor(message) {
    super(message);
    this.name = "PriceBindingError";
  }
}

// The composite key under which a mapping (and a lookup) is addressed. provider +
// priceId are joined with a separator that cannot appear in a validated provider
// (validation forbids it), so two distinct (provider, priceId) pairs can never
// collide onto the same key.
const _BINDING_KEY_SEP = "\u0000"; // NUL — forbidden in a provider/priceId below.
function _bindingKey(provider, priceId) {
  return `${provider}${_BINDING_KEY_SEP}${priceId}`;
}

// ---------------------------------------------------------------------------
// validatePriceBinding(obj, catalog) -> validated, deeply-FROZEN binding
// ---------------------------------------------------------------------------
//
// Strictly validates and returns a NEW deeply-frozen, canonical binding object.
// `catalog` MUST be a catalog already validated by validatePlanCatalog — it is the
// SINGLE source of valid planIds: every mapping's planId is checked against it (via
// getPlan) at validation time, so a binding can never point at a non-existent plan.
// Throws PriceBindingError on the FIRST defect. Never mutates either input. PURE.
function validatePriceBinding(obj, catalog) {
  // The catalog is REQUIRED and must be a validated catalog (it is the authority
  // for valid planIds). We probe its shape rather than re-validating it.
  if (
    catalog === null ||
    typeof catalog !== "object" ||
    catalog.plansById === null ||
    typeof catalog.plansById !== "object"
  ) {
    throw new PriceBindingError(
      "validatePriceBinding requires a validated plan catalog (the single source of valid planIds)"
    );
  }

  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new PriceBindingError("price binding must be a JSON object");
  }

  // ---- kind: must be exactly the binding kind ------------------------------
  if (obj.kind !== PRICE_BINDING_KIND) {
    throw new PriceBindingError(
      `price binding has wrong kind ${JSON.stringify(obj.kind)}; ` +
        `expected ${JSON.stringify(PRICE_BINDING_KIND)}`
    );
  }

  // ---- schemaVersion: present and exactly a supported integer --------------
  if (!Object.prototype.hasOwnProperty.call(obj, "schemaVersion")) {
    throw new PriceBindingError("price binding is missing required field: schemaVersion");
  }
  if (!SUPPORTED_PRICE_BINDING_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new PriceBindingError(
      `unsupported price binding schemaVersion ${JSON.stringify(obj.schemaVersion)}; ` +
        `this build understands: ${SUPPORTED_PRICE_BINDING_SCHEMA_VERSIONS.join(", ")}`
    );
  }

  // ---- mappings: a non-empty array of mapping entries ----------------------
  if (!Object.prototype.hasOwnProperty.call(obj, "mappings")) {
    throw new PriceBindingError("price binding is missing required field: mappings");
  }
  if (!Array.isArray(obj.mappings)) {
    throw new PriceBindingError("price binding mappings must be an array");
  }
  if (obj.mappings.length === 0) {
    throw new PriceBindingError("price binding mappings must be a non-empty array");
  }

  // Validate each mapping; collect into a (provider,priceId) -> frozen-mapping
  // map, rejecting a duplicate composite key (an ambiguous routing table is a hard
  // error, never a last-wins). Every planId is checked against the catalog.
  const byKey = new Map();
  for (let i = 0; i < obj.mappings.length; i++) {
    const mapping = validateMapping(obj.mappings[i], i, catalog);
    const key = _bindingKey(mapping.provider, mapping.priceId);
    if (byKey.has(key)) {
      throw new PriceBindingError(
        `price binding has duplicate (provider, priceId) ` +
          `(${JSON.stringify(mapping.provider)}, ${JSON.stringify(mapping.priceId)})`
      );
    }
    byKey.set(key, mapping);
  }

  // Build a canonical, deeply-frozen binding. The mappings array is emitted in
  // (provider, priceId)-sorted order so the binding's enumeration is deterministic
  // regardless of input order; `byKey` is a frozen lookup map for resolvePlanId.
  const sortedKeys = [...byKey.keys()].sort();
  const mappings = Object.freeze(sortedKeys.map((k) => byKey.get(k)));
  const byKeyObj = Object.freeze(
    sortedKeys.reduce((m, k) => {
      m[k] = byKey.get(k);
      return m;
    }, Object.create(null))
  );

  // Assemble the public binding (the ENUMERABLE, serializable surface) first, then
  // attach the internal lookup index as a TRULY non-enumerable property before
  // freezing. `_byKey` is the NUL-keyed (provider,priceId) -> mapping index used
  // ONLY by resolvePlanId; defining it non-enumerable keeps it off the public,
  // serialized surface, so Object.keys / JSON.stringify of a binding emit exactly
  // {kind, schemaVersion, mappings} and the raw NUL-separated keys never leak.
  const result = {
    kind: PRICE_BINDING_KIND,
    schemaVersion: obj.schemaVersion,
    mappings,
  };
  Object.defineProperty(result, "_byKey", {
    value: byKeyObj,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(result);
}

// ---------------------------------------------------------------------------
// validateMapping(mapping, index, catalog) -> a frozen, canonical mapping
// ---------------------------------------------------------------------------
//
// Strictly validates ONE mapping entry. `index` is woven into the error so a defect
// is locatable. `catalog` is the authority for the planId. Throws on the first
// problem.
function validateMapping(mapping, index, catalog) {
  const at = `mapping[${index}]`;
  if (mapping === null || typeof mapping !== "object" || Array.isArray(mapping)) {
    throw new PriceBindingError(`${at} must be an object`);
  }

  // ---- provider: a non-empty string with no NUL (the key separator) --------
  if (typeof mapping.provider !== "string" || mapping.provider.trim() === "") {
    throw new PriceBindingError(`${at}.provider must be a non-empty string`);
  }
  if (mapping.provider.includes(_BINDING_KEY_SEP)) {
    throw new PriceBindingError(`${at}.provider must not contain a NUL character`);
  }
  const provider = mapping.provider;

  // ---- priceId: a non-empty string with no NUL -----------------------------
  if (typeof mapping.priceId !== "string" || mapping.priceId.trim() === "") {
    throw new PriceBindingError(
      `${at} (provider ${JSON.stringify(provider)}) priceId must be a non-empty string`
    );
  }
  if (mapping.priceId.includes(_BINDING_KEY_SEP)) {
    throw new PriceBindingError(
      `${at} (provider ${JSON.stringify(provider)}) priceId must not contain a NUL character`
    );
  }
  const priceId = mapping.priceId;

  // ---- planId: a non-empty string that the SUPPLIED CATALOG defines --------
  // getPlan is the authority: it throws a NAMED PlanCatalogError for an unknown id.
  // We re-wrap it as a PriceBindingError so the binding's error TYPE is uniform and
  // the message names the offending (provider, priceId).
  if (typeof mapping.planId !== "string" || mapping.planId.trim() === "") {
    throw new PriceBindingError(
      `${at} (provider ${JSON.stringify(provider)}, priceId ${JSON.stringify(priceId)}) ` +
        `planId must be a non-empty string`
    );
  }
  const planId = mapping.planId;
  try {
    getPlan(catalog, planId);
  } catch (e) {
    const known = Object.keys(catalog.plansById).sort().join(", ");
    throw new PriceBindingError(
      `${at} (provider ${JSON.stringify(provider)}, priceId ${JSON.stringify(priceId)}) ` +
        `points at planId ${JSON.stringify(planId)} which is NOT in the supplied catalog; ` +
        `known plans are: ${known}`
    );
  }

  return Object.freeze({ provider, priceId, planId });
}

// ---------------------------------------------------------------------------
// resolvePlanId(binding, provider, priceId) -> the bound planId, or throws
// ---------------------------------------------------------------------------
//
// PURE lookup against a VALIDATED binding. Returns the bound planId for a known
// (provider, priceId); throws a NAMED PriceBindingError NAMING both the provider and
// the priceId for an unmapped pair (never returns undefined — an unmapped price is
// an error, not a silent mis-grant).
function resolvePlanId(binding, provider, priceId) {
  if (
    binding === null ||
    typeof binding !== "object" ||
    binding._byKey === null ||
    typeof binding._byKey !== "object"
  ) {
    throw new PriceBindingError("resolvePlanId requires a validated price binding");
  }
  if (typeof provider !== "string" || provider.trim() === "") {
    throw new PriceBindingError("resolvePlanId requires a non-empty provider");
  }
  if (typeof priceId !== "string" || priceId.trim() === "") {
    throw new PriceBindingError("resolvePlanId requires a non-empty priceId");
  }
  const key = _bindingKey(provider, priceId);
  if (!Object.prototype.hasOwnProperty.call(binding._byKey, key)) {
    throw new PriceBindingError(
      `no plan bound for (provider ${JSON.stringify(provider)}, ` +
        `priceId ${JSON.stringify(priceId)}); the price binding has no such mapping`
    );
  }
  return binding._byKey[key].planId;
}

module.exports = {
  PLAN_CATALOG_KIND,
  PLAN_CATALOG_SCHEMA_VERSION,
  SUPPORTED_PLAN_CATALOG_SCHEMA_VERSIONS,
  ALLOWED_ENTITLEMENT_FLAGS,
  PlanCatalogError,
  validatePlanCatalog,
  getPlan,
  // T-38.1: the price -> plan binding over the same catalog.
  PRICE_BINDING_KIND,
  PRICE_BINDING_SCHEMA_VERSION,
  SUPPORTED_PRICE_BINDING_SCHEMA_VERSIONS,
  PriceBindingError,
  validatePriceBinding,
  resolvePlanId,
};

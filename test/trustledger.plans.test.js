"use strict";

// TrustLedger — plans.js tests (T-37.1: THE PLAN CATALOG).
//
// PURE / OFFLINE — no live node, no key material. The catalog module itself is
// pure: the TEST reads the bundled baseline.json from disk and hands the parsed
// object to validatePlanCatalog (the module never touches the filesystem). These
// tests prove:
//   * validatePlanCatalog ACCEPTS the bundled baseline.json;
//   * it REJECTS, with a NAMED error (never a silent pass), each of: wrong kind,
//     wrong/unsupported schemaVersion, empty plans, missing plans, a duplicate
//     planId, a plan with an entitlement NOT in license.ENTITLEMENT_FLAGS, an
//     empty entitlements list, a non-positive term, a non-integer term, and a
//     missing displayName;
//   * getPlan returns the frozen plan for a known id and throws a named error for
//     an unknown id;
//   * the CLOSED ENTITLEMENTS table is the SINGLE source of valid flags — plans.js
//     derives its allowed set from license.ENTITLEMENT_FLAGS, not a hard-coded copy;
//   * the module is PURE — a source grep finds no fs / http / require("ethers") /
//     clock use.

const fs = require("fs");
const path = require("path");
const { expect } = require("chai");

const plans = require("../trustledger/plans");
const license = require("../trustledger/license");

const {
  PLAN_CATALOG_KIND,
  PLAN_CATALOG_SCHEMA_VERSION,
  PlanCatalogError,
  validatePlanCatalog,
  getPlan,
} = plans;

const BASELINE_PATH = path.join(
  __dirname,
  "..",
  "trustledger",
  "fixtures",
  "plans",
  "baseline.json"
);

// Read + parse the bundled fixture once. The TEST does the I/O; the module stays
// pure. Each helper below returns a FRESH deep clone so a mutation in one case
// never leaks into another.
const BASELINE_TEXT = fs.readFileSync(BASELINE_PATH, "utf8");
function baselineObj() {
  return JSON.parse(BASELINE_TEXT);
}

describe("trustledger/plans — bundled baseline acceptance", () => {
  it("validatePlanCatalog ACCEPTS the bundled baseline.json", () => {
    const cat = validatePlanCatalog(baselineObj());
    expect(cat.kind).to.equal(PLAN_CATALOG_KIND);
    expect(cat.schemaVersion).to.equal(PLAN_CATALOG_SCHEMA_VERSION);
    expect(cat.plans.length).to.be.greaterThan(0);
    // Plans are emitted in planId-sorted order, deterministically.
    const ids = cat.plans.map((p) => p.planId);
    expect(ids).to.deep.equal([...ids].sort());
    // Every plan's entitlements are a subset of the CLOSED license table.
    for (const p of cat.plans) {
      expect(p.entitlements.length).to.be.greaterThan(0);
      for (const flag of p.entitlements) {
        expect(license.ENTITLEMENT_FLAGS).to.include(flag);
      }
      expect(Number.isInteger(p.termDays)).to.equal(true);
      expect(p.termDays).to.be.greaterThan(0);
      expect(p.displayName).to.be.a("string").and.not.equal("");
    }
  });

  it("returns a deeply-frozen catalog (no caller can mutate a plan)", () => {
    const cat = validatePlanCatalog(baselineObj());
    expect(Object.isFrozen(cat)).to.equal(true);
    expect(Object.isFrozen(cat.plans)).to.equal(true);
    expect(Object.isFrozen(cat.plans[0])).to.equal(true);
    expect(Object.isFrozen(cat.plans[0].entitlements)).to.equal(true);
    expect(Object.isFrozen(cat.plansById)).to.equal(true);
  });

  it("is deterministic — same input yields a byte-identical re-serialization", () => {
    const a = validatePlanCatalog(baselineObj());
    const b = validatePlanCatalog(baselineObj());
    expect(JSON.stringify(a.plans)).to.equal(JSON.stringify(b.plans));
  });
});

describe("trustledger/plans — STRICT rejection (each a NAMED error, never a silent pass)", () => {
  it("REJECTS a wrong kind", () => {
    const obj = baselineObj();
    obj.kind = "trustledger-license";
    expect(() => validatePlanCatalog(obj)).to.throw(PlanCatalogError, /wrong kind/);
  });

  it("REJECTS a missing kind", () => {
    const obj = baselineObj();
    delete obj.kind;
    expect(() => validatePlanCatalog(obj)).to.throw(PlanCatalogError, /wrong kind/);
  });

  it("REJECTS an unsupported schemaVersion", () => {
    const obj = baselineObj();
    obj.schemaVersion = 2;
    expect(() => validatePlanCatalog(obj)).to.throw(
      PlanCatalogError,
      /unsupported plan catalog schemaVersion/
    );
  });

  it("REJECTS a missing schemaVersion", () => {
    const obj = baselineObj();
    delete obj.schemaVersion;
    expect(() => validatePlanCatalog(obj)).to.throw(
      PlanCatalogError,
      /missing required field: schemaVersion/
    );
  });

  it("REJECTS an empty plans array", () => {
    const obj = baselineObj();
    obj.plans = [];
    expect(() => validatePlanCatalog(obj)).to.throw(
      PlanCatalogError,
      /plans must be a non-empty array/
    );
  });

  it("REJECTS a missing plans field", () => {
    const obj = baselineObj();
    delete obj.plans;
    expect(() => validatePlanCatalog(obj)).to.throw(
      PlanCatalogError,
      /missing required field: plans/
    );
  });

  it("REJECTS a non-array plans field", () => {
    const obj = baselineObj();
    obj.plans = { "pro-annual": {} };
    expect(() => validatePlanCatalog(obj)).to.throw(PlanCatalogError, /plans must be an array/);
  });

  it("REJECTS a duplicate planId", () => {
    const obj = baselineObj();
    obj.plans.push({
      planId: obj.plans[0].planId,
      displayName: "Dupe",
      entitlements: ["seal"],
      termDays: 30,
    });
    expect(() => validatePlanCatalog(obj)).to.throw(PlanCatalogError, /duplicate planId/);
  });

  it("REJECTS a plan whose entitlements contain a flag NOT in license.ENTITLEMENT_FLAGS", () => {
    const obj = baselineObj();
    obj.plans[0].entitlements = ["seal", "teleportation"];
    expect(() => validatePlanCatalog(obj)).to.throw(
      PlanCatalogError,
      /unknown entitlement "teleportation"/
    );
  });

  it("REJECTS an empty entitlements list", () => {
    const obj = baselineObj();
    obj.plans[0].entitlements = [];
    expect(() => validatePlanCatalog(obj)).to.throw(
      PlanCatalogError,
      /entitlements must be a non-empty array/
    );
  });

  it("REJECTS a duplicate entitlement within one plan", () => {
    const obj = baselineObj();
    obj.plans[0].entitlements = ["seal", "seal"];
    expect(() => validatePlanCatalog(obj)).to.throw(
      PlanCatalogError,
      /duplicate entitlement "seal"/
    );
  });

  it("REJECTS a non-positive term", () => {
    const obj = baselineObj();
    obj.plans[0].termDays = 0;
    expect(() => validatePlanCatalog(obj)).to.throw(
      PlanCatalogError,
      /termDays must be a positive integer/
    );
    const neg = baselineObj();
    neg.plans[0].termDays = -30;
    expect(() => validatePlanCatalog(neg)).to.throw(
      PlanCatalogError,
      /termDays must be a positive integer/
    );
  });

  it("REJECTS a non-integer term (never rounds or coerces)", () => {
    const obj = baselineObj();
    obj.plans[0].termDays = 30.5;
    expect(() => validatePlanCatalog(obj)).to.throw(PlanCatalogError, /termDays must be an integer/);
    const str = baselineObj();
    str.plans[0].termDays = "30";
    expect(() => validatePlanCatalog(str)).to.throw(PlanCatalogError, /termDays must be an integer/);
  });

  it("REJECTS a missing termDays", () => {
    const obj = baselineObj();
    delete obj.plans[0].termDays;
    expect(() => validatePlanCatalog(obj)).to.throw(
      PlanCatalogError,
      /missing required field: termDays/
    );
  });

  it("REJECTS a missing displayName", () => {
    const obj = baselineObj();
    delete obj.plans[0].displayName;
    expect(() => validatePlanCatalog(obj)).to.throw(
      PlanCatalogError,
      /missing a non-empty displayName/
    );
    const empty = baselineObj();
    empty.plans[0].displayName = "   ";
    expect(() => validatePlanCatalog(empty)).to.throw(
      PlanCatalogError,
      /missing a non-empty displayName/
    );
  });

  it("REJECTS a non-object catalog", () => {
    expect(() => validatePlanCatalog(null)).to.throw(PlanCatalogError, /must be a JSON object/);
    expect(() => validatePlanCatalog([])).to.throw(PlanCatalogError, /must be a JSON object/);
    expect(() => validatePlanCatalog("x")).to.throw(PlanCatalogError, /must be a JSON object/);
  });

  it("REJECTS a non-string / missing planId", () => {
    const obj = baselineObj();
    obj.plans[0].planId = "";
    expect(() => validatePlanCatalog(obj)).to.throw(
      PlanCatalogError,
      /planId must be a non-empty string/
    );
  });
});

describe("trustledger/plans — getPlan lookup", () => {
  it("returns the frozen plan for a known id", () => {
    const cat = validatePlanCatalog(baselineObj());
    const knownId = cat.plans[0].planId;
    const plan = getPlan(cat, knownId);
    expect(plan.planId).to.equal(knownId);
    expect(Object.isFrozen(plan)).to.equal(true);
    expect(plan).to.equal(cat.plansById[knownId]);
  });

  it("throws a NAMED error for an unknown id (never returns undefined)", () => {
    const cat = validatePlanCatalog(baselineObj());
    expect(() => getPlan(cat, "no-such-plan")).to.throw(PlanCatalogError, /unknown planId/);
  });

  it("throws for a non-validated catalog or empty planId", () => {
    const cat = validatePlanCatalog(baselineObj());
    expect(() => getPlan({}, "pro-annual")).to.throw(
      PlanCatalogError,
      /requires a validated plan catalog/
    );
    expect(() => getPlan(cat, "")).to.throw(PlanCatalogError, /requires a non-empty planId/);
  });
});

describe("trustledger/plans — the CLOSED ENTITLEMENTS table is the SINGLE source of valid flags", () => {
  it("derives its allowed set from license.ENTITLEMENT_FLAGS (not a hard-coded copy)", () => {
    // ALLOWED_ENTITLEMENT_FLAGS must be EXACTLY the license module's closed set.
    expect([...plans.ALLOWED_ENTITLEMENT_FLAGS].sort()).to.deep.equal(
      [...license.ENTITLEMENT_FLAGS].sort()
    );
    // Every flag the license table exposes is accepted by the catalog...
    for (const flag of license.ENTITLEMENT_FLAGS) {
      const obj = baselineObj();
      obj.plans = [
        { planId: "p", displayName: "P", entitlements: [flag], termDays: 30 },
      ];
      expect(() => validatePlanCatalog(obj)).to.not.throw();
    }
  });

  it("plans.js source contains no hard-coded entitlement-flag string literals", () => {
    // The flags must enter ONLY via license.ENTITLEMENT_FLAGS. If a flag string is
    // literally present in plans.js, the two could drift — a regression we forbid.
    const src = fs.readFileSync(
      path.join(__dirname, "..", "trustledger", "plans.js"),
      "utf8"
    );
    for (const flag of license.ENTITLEMENT_FLAGS) {
      expect(src, `plans.js must not hard-code the flag "${flag}"`).to.not.include(
        `"${flag}"`
      );
    }
  });
});

describe("trustledger/plans — PURITY (no fs / http / ethers / clock)", () => {
  it("plans.js source has no I/O, network, ethers, or clock use", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "trustledger", "plans.js"),
      "utf8"
    );
    expect(src).to.not.match(/require\(\s*["']fs["']\s*\)/);
    expect(src).to.not.match(/require\(\s*["']http["']\s*\)/);
    expect(src).to.not.match(/require\(\s*["']https["']\s*\)/);
    expect(src).to.not.match(/require\(\s*["']ethers["']\s*\)/);
    expect(src).to.not.match(/Date\.now/);
    expect(src).to.not.match(/new\s+Date/);
  });
});

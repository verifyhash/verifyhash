"use strict";

// cli/core/evidence-plans.js tests — THE EVIDENCE PLAN CATALOG (T-48.1).
//
// FUNCTION-LEVEL, PURE / OFFLINE. The catalog module is pure: the TEST reads the
// bundled baseline.json from disk and hands the parsed object to
// validateEvidencePlanCatalog (the module never touches the filesystem). The ONLY
// key material is an EPHEMERAL in-process Wallet.createRandom() used to prove the
// fulfill output ROUND-TRIPS through the existing evidence buildLicense/verifyLicense
// gate — never a real key/real funds. These tests prove:
//   * validateEvidencePlanCatalog ACCEPTS the bundled DRAFT baseline.json, freezing +
//     planId-sorting it, carrying a frozen plansById map;
//   * it REJECTS, with a NAMED EvidencePlanCatalogError (never a silent pass), each of:
//     wrong kind, unsupported schemaVersion, empty plans, an UNKNOWN entitlement flag
//     (the message NAMES the flag), and a DUPLICATE planId;
//   * getEvidencePlan returns the frozen plan for a known id and throws a NAMED error
//     naming the known plans for an unknown id;
//   * the closed entitlement set is exactly the EVIDENCE closed table
//     {evidence_signed, evidence_unlimited} — DISJOINT from TrustLedger's;
//   * fulfillEvidenceOrder is PURE + DETERMINISTIC (same order+catalog => byte-identical
//     params), entitlements come ONLY from the resolved plan, paidThrough WINS over
//     termDays, paidThrough <= issuedAt / a missing-or-blank customer / a non-canonical
//     issuedAt each HARD-reject, and it mutates no input;
//   * the output params ROUND-TRIP through evidence.buildLicense and the UNCHANGED
//     evidence.verifyLicense ACCEPTS the resulting license for the granted entitlements;
//   * no network handle is opened.

const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { Wallet } = require("ethers");

const evidencePlans = require("../cli/core/evidence-plans");
const evidence = require("../cli/evidence");

const {
  EVIDENCE_PLAN_CATALOG_KIND,
  EVIDENCE_PLAN_CATALOG_SCHEMA_VERSION,
  ALLOWED_ENTITLEMENT_FLAGS,
  EvidencePlanCatalogError,
  validateEvidencePlanCatalog,
  getEvidencePlan,
  fulfillEvidenceOrder,
} = evidencePlans;

const BASELINE_PATH = path.join(
  __dirname,
  "..",
  "cli",
  "core",
  "fixtures",
  "evidence-plans",
  "baseline.json"
);

// Read + parse the bundled fixture once. The TEST does the I/O; the module stays pure.
// Each helper returns a FRESH deep clone so a mutation in one case never leaks into
// another.
const BASELINE_TEXT = fs.readFileSync(BASELINE_PATH, "utf8");
function baselineObj() {
  return JSON.parse(BASELINE_TEXT);
}

const ISSUED = "2026-01-01T00:00:00.000Z"; // pinned issuedAt

// A minimal hand-built catalog whose single paid tier grants BOTH evidence flags.
function paidCatalog() {
  return validateEvidencePlanCatalog({
    kind: EVIDENCE_PLAN_CATALOG_KIND,
    schemaVersion: 1,
    plans: [
      {
        planId: "paid",
        displayName: "Paid",
        entitlements: ["evidence_signed", "evidence_unlimited"],
        termDays: 365,
      },
    ],
  });
}

// ===========================================================================
// PART 1 — the bundled DRAFT baseline + the closed entitlement table.
// ===========================================================================

describe("evidence-plans T-48.1: bundled DRAFT baseline acceptance", () => {
  it("validateEvidencePlanCatalog ACCEPTS the bundled DRAFT baseline.json", () => {
    const cat = validateEvidencePlanCatalog(baselineObj());
    expect(cat.kind).to.equal(EVIDENCE_PLAN_CATALOG_KIND);
    expect(cat.schemaVersion).to.equal(EVIDENCE_PLAN_CATALOG_SCHEMA_VERSION);
    expect(cat.plans.length).to.be.greaterThan(0);
    // Plans are emitted in planId-sorted order, deterministically.
    const ids = cat.plans.map((p) => p.planId);
    expect(ids).to.deep.equal([...ids].sort());
    // Every plan's entitlements are a subset of the EVIDENCE closed table.
    for (const p of cat.plans) {
      expect(p.entitlements.length).to.be.greaterThan(0);
      for (const flag of p.entitlements) {
        expect(ALLOWED_ENTITLEMENT_FLAGS).to.include(flag);
      }
      expect(Number.isInteger(p.termDays)).to.equal(true);
      expect(p.termDays).to.be.greaterThan(0);
      expect(p.displayName).to.be.a("string").and.not.equal("");
    }
    // The fixture ships at least a paid tier granting BOTH evidence flags.
    const grantsBoth = cat.plans.some(
      (p) =>
        p.entitlements.includes("evidence_signed") &&
        p.entitlements.includes("evidence_unlimited")
    );
    expect(grantsBoth).to.equal(true);
  });

  it("the closed entitlement set is EXACTLY the evidence table {evidence_signed, evidence_unlimited}", () => {
    expect([...ALLOWED_ENTITLEMENT_FLAGS]).to.deep.equal([
      "evidence_signed",
      "evidence_unlimited",
    ]);
    // DISJOINT from TrustLedger's — no TrustLedger flag is accepted here.
    expect(ALLOWED_ENTITLEMENT_FLAGS).to.not.include("seal");
    expect(ALLOWED_ENTITLEMENT_FLAGS).to.not.include("multi_state_policy");
    expect(ALLOWED_ENTITLEMENT_FLAGS).to.not.include("unlimited_reconcile");
  });

  it("returns a deeply-FROZEN catalog (no caller can mutate it)", () => {
    const cat = validateEvidencePlanCatalog(baselineObj());
    expect(Object.isFrozen(cat)).to.equal(true);
    expect(Object.isFrozen(cat.plans)).to.equal(true);
    expect(Object.isFrozen(cat.plans[0])).to.equal(true);
    expect(Object.isFrozen(cat.plans[0].entitlements)).to.equal(true);
    expect(Object.isFrozen(cat.plansById)).to.equal(true);
    // A frozen plan cannot be widened in place.
    expect(() => {
      "use strict";
      cat.plans[0].entitlements.push("FORGED");
    }).to.throw();
  });

  it("is deterministic — same input yields byte-identical re-serialization", () => {
    const a = validateEvidencePlanCatalog(baselineObj());
    const b = validateEvidencePlanCatalog(baselineObj());
    expect(JSON.stringify(a.plans)).to.equal(JSON.stringify(b.plans));
  });

  it("sorts plans by planId regardless of input order", () => {
    const obj = {
      kind: EVIDENCE_PLAN_CATALOG_KIND,
      schemaVersion: 1,
      plans: [
        { planId: "zeta", displayName: "Z", entitlements: ["evidence_signed"], termDays: 30 },
        { planId: "alpha", displayName: "A", entitlements: ["evidence_unlimited"], termDays: 30 },
      ],
    };
    const cat = validateEvidencePlanCatalog(obj);
    expect(cat.plans.map((p) => p.planId)).to.deep.equal(["alpha", "zeta"]);
  });
});

// ===========================================================================
// PART 2 — strict rejection (a NAMED error on the first defect, never silent).
// ===========================================================================

describe("evidence-plans T-48.1: strict validation (NAMED hard rejects)", () => {
  it("WRONG kind is a hard reject naming the expected kind", () => {
    const obj = baselineObj();
    obj.kind = "trustledger-plan-catalog"; // the OTHER product's kind — never accepted here
    expect(() => validateEvidencePlanCatalog(obj)).to.throw(
      EvidencePlanCatalogError,
      /wrong kind/i
    );
  });

  it("an unsupported schemaVersion is a hard reject", () => {
    const obj = baselineObj();
    obj.schemaVersion = 999;
    expect(() => validateEvidencePlanCatalog(obj)).to.throw(
      EvidencePlanCatalogError,
      /schemaVersion/
    );
  });

  it("empty plans is a hard reject", () => {
    const obj = baselineObj();
    obj.plans = [];
    expect(() => validateEvidencePlanCatalog(obj)).to.throw(
      EvidencePlanCatalogError,
      /non-empty array/
    );
  });

  it("an UNKNOWN entitlement flag is a hard reject that NAMES the flag", () => {
    const obj = {
      kind: EVIDENCE_PLAN_CATALOG_KIND,
      schemaVersion: 1,
      plans: [
        {
          planId: "bad",
          displayName: "Bad",
          // `seal` is a TrustLedger flag — NOT in the evidence closed table.
          entitlements: ["evidence_signed", "seal"],
          termDays: 30,
        },
      ],
    };
    let caught;
    try {
      validateEvidencePlanCatalog(obj);
    } catch (e) {
      caught = e;
    }
    expect(caught).to.be.instanceOf(EvidencePlanCatalogError);
    expect(caught.message).to.match(/unknown entitlement/i);
    expect(caught.message).to.include("seal"); // names the offending flag
  });

  it("a DUPLICATE planId is a hard reject (never a silent last-wins)", () => {
    const obj = {
      kind: EVIDENCE_PLAN_CATALOG_KIND,
      schemaVersion: 1,
      plans: [
        { planId: "dup", displayName: "One", entitlements: ["evidence_signed"], termDays: 30 },
        { planId: "dup", displayName: "Two", entitlements: ["evidence_unlimited"], termDays: 60 },
      ],
    };
    expect(() => validateEvidencePlanCatalog(obj)).to.throw(
      EvidencePlanCatalogError,
      /duplicate planId/i
    );
  });

  it("a non-positive / non-integer termDays and a missing displayName each hard-reject", () => {
    const mk = (over) => ({
      kind: EVIDENCE_PLAN_CATALOG_KIND,
      schemaVersion: 1,
      plans: [
        Object.assign(
          { planId: "p", displayName: "P", entitlements: ["evidence_signed"], termDays: 30 },
          over
        ),
      ],
    });
    expect(() => validateEvidencePlanCatalog(mk({ termDays: 0 }))).to.throw(
      EvidencePlanCatalogError,
      /termDays/
    );
    expect(() => validateEvidencePlanCatalog(mk({ termDays: 1.5 }))).to.throw(
      EvidencePlanCatalogError,
      /termDays/
    );
    expect(() => validateEvidencePlanCatalog(mk({ displayName: "" }))).to.throw(
      EvidencePlanCatalogError,
      /displayName/
    );
  });
});

// ===========================================================================
// PART 3 — getEvidencePlan.
// ===========================================================================

describe("evidence-plans T-48.1: getEvidencePlan", () => {
  it("returns the frozen plan for a known id", () => {
    const cat = paidCatalog();
    const plan = getEvidencePlan(cat, "paid");
    expect(plan.planId).to.equal("paid");
    expect(Object.isFrozen(plan)).to.equal(true);
  });

  it("throws a NAMED error naming the known plans for an unknown id", () => {
    const cat = paidCatalog();
    let caught;
    try {
      getEvidencePlan(cat, "no-such-plan");
    } catch (e) {
      caught = e;
    }
    expect(caught).to.be.instanceOf(EvidencePlanCatalogError);
    expect(caught.message).to.match(/unknown evidence planId/i);
    expect(caught.message).to.include("paid"); // names the known plan
  });
});

// ===========================================================================
// PART 4 — fulfillEvidenceOrder: PURE, DETERMINISTIC, strict (no key, no I/O).
// ===========================================================================

describe("evidence-plans T-48.1: fulfillEvidenceOrder (the pure order -> license mapping)", () => {
  it("derives the EXACT buildLicensePayload params from plan + order (entitlements from the plan)", () => {
    const cat = paidCatalog();
    const params = fulfillEvidenceOrder(
      { plan: "paid", customer: "Acme Corp", issuedAt: ISSUED },
      cat
    );
    const plan = cat.plansById["paid"];
    expect(params.entitlements).to.deep.equal(plan.entitlements);
    expect(params.plan).to.equal("paid");
    expect(params.customer).to.equal("Acme Corp");
    expect(params.issuedAt).to.equal(ISSUED);
    expect(params.licenseId).to.equal(`LIC-${ISSUED}-paid`);
  });

  it("is DETERMINISTIC — same order + catalog => byte-identical params", () => {
    const order = { plan: "paid", customer: "Beta LLC", issuedAt: ISSUED };
    const a = JSON.stringify(fulfillEvidenceOrder(order, paidCatalog()));
    const b = JSON.stringify(fulfillEvidenceOrder(order, paidCatalog()));
    expect(a).to.equal(b);
  });

  it("paidThrough OMITTED => expiresAt = issuedAt + plan.termDays days", () => {
    const cat = paidCatalog();
    const params = fulfillEvidenceOrder(
      { plan: "paid", customer: "X", issuedAt: ISSUED },
      cat
    );
    const expectedMs = Date.parse(ISSUED) + cat.plansById["paid"].termDays * 86400000;
    expect(params.expiresAt).to.equal(new Date(expectedMs).toISOString());
  });

  it("an explicit paidThrough WINS over the derived term", () => {
    const params = fulfillEvidenceOrder(
      {
        plan: "paid",
        customer: "X",
        issuedAt: ISSUED,
        paidThrough: "2026-06-15T00:00:00.000Z",
      },
      paidCatalog()
    );
    expect(params.expiresAt).to.equal("2026-06-15T00:00:00.000Z");
  });

  it("an explicit licenseId WINS; an omitted one is a deterministic default", () => {
    const cat = paidCatalog();
    const explicit = fulfillEvidenceOrder(
      { plan: "paid", customer: "X", issuedAt: ISSUED, licenseId: "ORDER-42" },
      cat
    );
    expect(explicit.licenseId).to.equal("ORDER-42");
    const def = fulfillEvidenceOrder({ plan: "paid", customer: "X", issuedAt: ISSUED }, cat);
    expect(def.licenseId).to.equal(`LIC-${ISSUED}-paid`);
  });

  it("an UNKNOWN plan throws a NAMED EvidenceLicenseError naming the known plans", () => {
    let caught;
    try {
      fulfillEvidenceOrder({ plan: "enterprise", customer: "X", issuedAt: ISSUED }, paidCatalog());
    } catch (e) {
      caught = e;
    }
    expect(caught).to.be.instanceOf(evidence.EvidenceLicenseError);
    expect(caught.message).to.match(/unknown plan/i);
    expect(caught.message).to.include("paid");
  });

  it("paidThrough <= issuedAt throws a NAMED error (empty/negative window)", () => {
    // equal to issuedAt
    expect(() =>
      fulfillEvidenceOrder(
        { plan: "paid", customer: "X", issuedAt: ISSUED, paidThrough: ISSUED },
        paidCatalog()
      )
    ).to.throw(evidence.EvidenceLicenseError, /strictly AFTER issuedAt/i);
    // before issuedAt
    expect(() =>
      fulfillEvidenceOrder(
        {
          plan: "paid",
          customer: "X",
          issuedAt: ISSUED,
          paidThrough: "2025-12-01T00:00:00.000Z",
        },
        paidCatalog()
      )
    ).to.throw(evidence.EvidenceLicenseError, /strictly AFTER issuedAt/i);
  });

  it("a MISSING / BLANK customer throws a NAMED error", () => {
    expect(() =>
      fulfillEvidenceOrder({ plan: "paid", issuedAt: ISSUED }, paidCatalog())
    ).to.throw(evidence.EvidenceLicenseError, /customer/i);
    expect(() =>
      fulfillEvidenceOrder({ plan: "paid", customer: "", issuedAt: ISSUED }, paidCatalog())
    ).to.throw(evidence.EvidenceLicenseError, /customer/i);
  });

  it("a NON-CANONICAL issuedAt (or paidThrough) throws a NAMED error", () => {
    // rolled-over / impossible calendar instant
    expect(() =>
      fulfillEvidenceOrder(
        { plan: "paid", customer: "X", issuedAt: "2026-02-30T00:00:00.000Z" },
        paidCatalog()
      )
    ).to.throw(evidence.EvidenceLicenseError, /issuedAt/);
    // date-only (not a canonical instant)
    expect(() =>
      fulfillEvidenceOrder(
        { plan: "paid", customer: "X", issuedAt: "2026-01-01" },
        paidCatalog()
      )
    ).to.throw(evidence.EvidenceLicenseError, /issuedAt/);
    // malformed paidThrough
    expect(() =>
      fulfillEvidenceOrder(
        { plan: "paid", customer: "X", issuedAt: ISSUED, paidThrough: "not-a-date" },
        paidCatalog()
      )
    ).to.throw(evidence.EvidenceLicenseError, /paidThrough/);
  });

  it("does NOT mutate the frozen catalog plan's entitlements (returns a fresh array)", () => {
    const cat = paidCatalog();
    const params = fulfillEvidenceOrder({ plan: "paid", customer: "X", issuedAt: ISSUED }, cat);
    params.entitlements.push("FORGED");
    expect(cat.plansById["paid"].entitlements).to.not.include("FORGED");
  });
});

// ===========================================================================
// PART 5 — the output params ROUND-TRIP through evidence.buildLicense and the
//          UNCHANGED evidence.verifyLicense ACCEPTS the resulting license.
//          (EPHEMERAL in-process key only; no network handle opened.)
// ===========================================================================

describe("evidence-plans T-48.1: fulfillEvidenceOrder output round-trips through buildLicense/verifyLicense", () => {
  it("buildLicense accepts the params and verifyLicense ACCEPTS the license for the granted entitlements", async () => {
    const cat = paidCatalog();
    const wallet = Wallet.createRandom(); // EPHEMERAL, test-only — never a real key
    const params = fulfillEvidenceOrder(
      { plan: "paid", customer: "Acme Corp", issuedAt: ISSUED },
      cat
    );

    // The params feed buildLicense byte-for-byte (it builds + validates the unsigned
    // payload, then signs). No network, no clock inside the core.
    const container = await evidence.buildLicense(params, wallet);

    // verifyLicense at an instant INSIDE the window, pinned to the ephemeral vendor.
    const now = "2026-06-01T00:00:00.000Z"; // between ISSUED and ISSUED+365d
    const verdict = evidence.verifyLicense(container, { now, vendorAddress: wallet.address });
    expect(verdict.valid).to.equal(true);
    expect(verdict.reason).to.equal(null);
    // Every granted entitlement is honored ONLY on the valid verdict.
    for (const flag of cat.plansById["paid"].entitlements) {
      expect(evidence.hasEntitlement(verdict, flag)).to.equal(true);
    }
    // The payload entitlements equal the plan's verbatim.
    expect(verdict.payload.entitlements).to.deep.equal(cat.plansById["paid"].entitlements);
    // A flag the plan does NOT grant (and which is not even in the closed table) is false.
    expect(evidence.hasEntitlement(verdict, "seal")).to.equal(false);
  });

  it("a WRONG vendor REJECTS the round-tripped license (wrong_issuer)", async () => {
    const cat = paidCatalog();
    const wallet = Wallet.createRandom();
    const params = fulfillEvidenceOrder({ plan: "paid", customer: "X", issuedAt: ISSUED }, cat);
    const container = await evidence.buildLicense(params, wallet);
    const other = Wallet.createRandom().address; // a DIFFERENT issuer
    const verdict = evidence.verifyLicense(container, {
      now: "2026-06-01T00:00:00.000Z",
      vendorAddress: other,
    });
    expect(verdict.valid).to.equal(false);
    expect(verdict.reason).to.equal("wrong_issuer");
  });
});

// ===========================================================================
// PART 6 — PURITY: no fs / network / clock / ethers use in the module source.
// ===========================================================================

describe("evidence-plans T-48.1: the module is PURE (no I/O / network / clock / ethers)", () => {
  it("a source grep finds no fs / http(s) / net / require(\"ethers\") / Date.now / clock read", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "cli", "core", "evidence-plans.js"),
      "utf8"
    );
    expect(src).to.not.match(/require\(['"](fs|http|https|net|tls|dns)['"]\)/);
    expect(src).to.not.match(/require\(['"]ethers['"]\)/);
    expect(src).to.not.match(/Date\.now\s*\(/);
    // No bare `new Date()` (a hidden clock read) — every Date is constructed from an
    // explicit epoch-ms argument (Date arithmetic), never the system clock.
    expect(src).to.not.match(/new Date\(\s*\)/);
  });
});

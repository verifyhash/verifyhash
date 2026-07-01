"use strict";

// ---------------------------------------------------------------------------
// T-37.3 docs-rot guard for the TrustLedger PLAN CATALOG & FULFILLMENT (EPIC-37).
//
// Pure (no chain, no CLI run): asserts docs/TRUSTLEDGER.md documents the plan catalog
// (T-37.1) + the order->license fulfillment mapping / `vh trust license fulfill`
// (T-37.2) the way the code actually behaves, so the buyer-/handoff-facing prose can't
// silently drift from trustledger/plans.js + trustledger/license.js (fulfillOrder) + the
// `vh trust license fulfill` CLI wiring.
// Load-bearing properties under test:
//   * docs/TRUSTLEDGER.md has a "## Plan catalog & fulfillment" section that
//       - names `vh trust license fulfill`,
//       - shows the catalog schema (EVERY catalog field + the per-plan fields), pinned
//         against the LIVE plans module / bundled baseline fixture,
//       - documents the bundled draft skeleton, the one-command fulfill shape, and the
//         worked "payment-succeeded webhook -> fulfill -> deliver *.vhlicense.json" flow,
//       - restates the human-vs-loop boundary VERBATIM (loop ships catalog + mapping; the
//         PRICE/term column + the vendor key + the actual webhook/billing are HUMAN steps);
//   * STRATEGY.md's P-6 step (3) is SHARPENED to the one-command webhook handoff and adds
//     NO new needs-human item.
// The guard imports trustledger/plans.js + trustledger/license.js so it fails loudly if a
// module (or its surface) is ever removed — an otherwise-hollow docs guard. It pins the
// documented kind/schemaVersion + the actual plan ids/entitlements/terms against the live
// bundled catalog, so a schema/fixture change trips the guard.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

const plans = require("../trustledger/plans");
const license = require("../trustledger/license");

const BASELINE = JSON.parse(read("trustledger/fixtures/plans/baseline.json"));
const CATALOG = plans.validatePlanCatalog(BASELINE);

describe("T-37.3 docs: TrustLedger plan catalog & fulfillment documented (docs/TRUSTLEDGER.md + STRATEGY.md)", function () {
  let doc, docLower, strategy;

  before(function () {
    doc = read("docs/TRUSTLEDGER.md");
    docLower = doc.toLowerCase();
    strategy = read("STRATEGY.md");
  });

  it("trustledger/plans.js + license.fulfillOrder still export the surface this guard pins against", function () {
    // Tripwire: if these drop, the assertions below would be meaningless.
    expect(plans.PLAN_CATALOG_KIND, "PLAN_CATALOG_KIND").to.be.a("string");
    expect(plans.PLAN_CATALOG_SCHEMA_VERSION, "PLAN_CATALOG_SCHEMA_VERSION").to.be.a("number");
    expect(plans.validatePlanCatalog, "validatePlanCatalog").to.be.a("function");
    expect(plans.getPlan, "getPlan").to.be.a("function");
    expect(license.fulfillOrder, "fulfillOrder").to.be.a("function");
    expect(license.ENTITLEMENT_FLAGS, "ENTITLEMENT_FLAGS").to.be.an("array");
    // The bundled baseline catalog parses and has at least one plan.
    expect(CATALOG.plans.length, "bundled baseline has plans").to.be.greaterThan(0);
  });

  describe("docs/TRUSTLEDGER.md: '## Plan catalog & fulfillment' section", function () {
    let section, sectionLower;
    before(function () {
      const start = docLower.indexOf("## plan catalog & fulfillment");
      expect(start, "plan-catalog-&-fulfillment section present").to.be.greaterThan(-1);
      const rest = doc.slice(start);
      // Stop at the next top-level "## " heading (skip the section's own "## " at index 0).
      const end = rest.indexOf("\n## ", 3);
      section = end === -1 ? rest : rest.slice(0, end);
      sectionLower = section.toLowerCase();
    });

    it("names the `vh trust license fulfill` one-command shape (with its flags)", function () {
      expect(section, "names vh trust license fulfill").to.include("vh trust license fulfill");
      // The one-command shape names the order flags it consumes.
      for (const flag of ["--plan", "--customer", "--paid-through", "--key-env"]) {
        expect(section, `documents ${flag}`).to.include(flag);
      }
      // Either key source is documented (read-used-discarded, never held).
      expect(section).to.match(/--key-env|--key-file/);
      expect(sectionLower).to.match(/read-used-discarded|never held|never holds/);
    });

    it("shows the CATALOG SCHEMA: every catalog + per-plan field (pinned to the live module)", function () {
      // The exact kind + schemaVersion the strict validator enforces must be documented.
      expect(section, "documented catalog kind").to.include(plans.PLAN_CATALOG_KIND);
      expect(section, "documented catalog schemaVersion").to.include(
        String(plans.PLAN_CATALOG_SCHEMA_VERSION)
      );
      // Top-level catalog fields.
      for (const f of ["kind", "schemaVersion", "plans"]) {
        expect(section, `documents catalog field ${f}`).to.include(f);
      }
      // Per-plan fields — derived from a REAL bundled plan, not a hard-coded list, so a
      // schema change to the plan shape trips this guard.
      const samplePlan = CATALOG.plans[0];
      for (const f of Object.keys(samplePlan)) {
        expect(section, `documents per-plan field ${f}`).to.include(f);
      }
      // The mapping is `planId -> {entitlements, term, displayName}` over the CLOSED table.
      expect(sectionLower).to.match(/closed/);
      expect(sectionLower).to.match(/entitlement/);
      // Every entitlement flag the closed license table exposes is named in the section.
      for (const flag of license.ENTITLEMENT_FLAGS) {
        expect(section, `names closed entitlement flag ${flag}`).to.include(flag);
      }
    });

    it("documents the bundled DRAFT skeleton with the live plan ids / entitlements / terms", function () {
      expect(sectionLower).to.match(/draft|skeleton/);
      // The bundled fixture path is named so a reader can find/copy it.
      expect(section).to.match(/fixtures\/plans\/baseline\.json|baseline\.json/);
      // Every bundled plan id + its termDays + each of its entitlements appears verbatim,
      // pinned against the LIVE catalog (so renaming a plan or changing a term trips this).
      for (const p of CATALOG.plans) {
        expect(section, `documents bundled planId ${p.planId}`).to.include(p.planId);
        expect(section, `documents term ${p.termDays} for ${p.planId}`).to.include(
          String(p.termDays)
        );
        for (const e of p.entitlements) {
          expect(section, `documents entitlement ${e} for ${p.planId}`).to.include(e);
        }
      }
    });

    it("documents the deterministic order->license mapping (fulfillOrder, entitlements VERBATIM)", function () {
      expect(sectionLower).to.match(/fulfillorder/);
      expect(sectionLower).to.match(/deterministic/);
      expect(sectionLower).to.match(/byte-identical|byte for byte|byte-for-byte/);
      // Entitlements come from the plan, never re-typed.
      expect(sectionLower).to.match(/verbatim/);
      // The window derives from --paid-through else issuedAt + termDays.
      expect(sectionLower).to.match(/issuedat\s*\+\s*termdays|termdays\s*days|term/);
    });

    it("shows the WORKED payment-succeeded webhook -> fulfill -> deliver *.vhlicense.json flow", function () {
      // The trigger event (payment-succeeded / renewed webhook).
      expect(sectionLower).to.match(/payment[ -]?succeed|payment_succeeded|webhook/);
      expect(sectionLower).to.match(/renew/);
      // The fulfill command actually appears in the worked example with a written file.
      expect(section).to.match(/vh trust license fulfill[\s\S]*--out/);
      expect(section).to.include(".vhlicense.json");
      // Deliver to the paying customer + offline verify against the published vendor address.
      expect(sectionLower).to.match(/deliver/);
      expect(section).to.include("vh trust license verify");
      expect(sectionLower).to.match(/offline/);
      // The per-sale work collapses to NO terminal step per sale.
      expect(sectionLower).to.match(/no terminal step per sale|per sale/);
    });

    it("restates the human-vs-loop boundary VERBATIM (loop ships catalog+mapping; price/key/webhook are HUMAN)", function () {
      // The loop ships ONLY the catalog schema + the mapping (+ ephemeral test keys).
      expect(sectionLower).to.match(/the loop ships only|loop ships (only )?the catalog/);
      expect(sectionLower).to.match(/catalog/);
      expect(sectionLower).to.match(/mapping/);
      // The loop NEVER sets a price / holds a real key / runs a payment processor / takes payment.
      expect(sectionLower).to.match(/never/);
      expect(sectionLower).to.match(/sets a price/);
      expect(sectionLower).to.match(/holds a real key|hold(s)? a real key/);
      expect(sectionLower).to.match(/runs a payment|payment processor/);
      expect(sectionLower).to.match(/takes a real payment|take a real payment/);
      // The three human-owned outward steps: the vendor KEY, the PRICE/term column, the WEBHOOK/billing.
      expect(sectionLower).to.match(/vendor key/);
      expect(sectionLower).to.match(/price\/term|price\/term column|term column/);
      expect(sectionLower).to.match(/webhook\/billing|webhook|billing/);
      expect(sectionLower).to.match(/human(-owned| step| steps)/);
      // Access-description posture: NOT a token / tradeable / appreciating asset.
      expect(sectionLower).to.match(/not a token|access description|access-description/);
      expect(sectionLower).to.match(/not.*tradeable|not.*appreciating/);
      // It SHARPENS P-6 (and adds no new human gate).
      expect(section).to.match(/P-6/);
      expect(sectionLower).to.match(/no new human gate|sharpen|sharpens/);
    });
  });

  describe("STRATEGY.md: P-6 step (3) SHARPENED to the one-command webhook handoff", function () {
    let p6;
    before(function () {
      const start = strategy.indexOf("P-6 (2026-06-24)");
      expect(start, "P-6 proposal present").to.be.greaterThan(-1);
      const tail = strategy.slice(start);
      // P-6 runs to the start of the next top-level proposal bullet (P-7).
      const end = tail.indexOf("\n- **P-7");
      p6 = end === -1 ? tail : tail.slice(0, end);
    });

    it("sharpens step (3) to the catalog + one-command fulfill webhook handoff", function () {
      const lower = p6.toLowerCase();
      // The EPIC-37 update names the catalog + fulfill mapping + the command.
      expect(p6).to.include("vh trust license fulfill");
      expect(lower).to.match(/plan catalog/);
      expect(lower).to.match(/fulfillorder/);
      // The webhook handoff: a payment-succeeded / renewed event -> fulfill, no per-sale terminal step.
      expect(lower).to.match(/payment[ -]?succeed|payment succeeded|webhook/);
      expect(lower).to.match(/renew/);
      expect(lower).to.match(/no terminal step per sale|no hand-authored entitlement|one .*command/);
      // It points at the doc section so the two stay anchored.
      expect(lower).to.match(/plan catalog & fulfillment|docs\/trustledger\.md/);
    });

    it("adds NO new needs-human item and explicitly SHARPENS P-6 step (3) (does not relax (1)/(2) or P-5)", function () {
      const lower = p6.toLowerCase();
      expect(lower).to.match(/sharpens p-6 step \(3\)|sharpens p-6|this sharpens p-6/);
      expect(lower).to.match(/adds no new human gate|no new human gate/);
      expect(lower).to.match(/does not relax \(1\)\/\(2\)|does not relax/);
      // The loop ships ONLY the mechanism (catalog + mapping + ephemeral test keys), never
      // setting a price / holding a key / taking payment.
      expect(lower).to.match(/never sets a price|holds a real key|takes a real payment/);
    });

    it("does NOT introduce a brand-new P-9 proposal as part of this task", function () {
      // T-37.3 must not invent a new needs-human proposal — P-6's step (3) is SHARPENED in place.
      // Scoped to the P-6 block (this task's subject), not the whole file: a LATER, UNRELATED proposal
      // (e.g. P-9, the EMBEDDABLE-SDK distribution ask on a different axis) may legitimately exist elsewhere.
      expect(p6, "this task's P-6 block must not spawn a new P-9 proposal").to.not.match(
        /^\s*-\s+\*\*P-9 \(/m
      );
    });
  });
});

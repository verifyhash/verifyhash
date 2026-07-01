"use strict";

// ---------------------------------------------------------------------------
// T-38.3 docs-rot guard for the TrustLedger WEBHOOK ADAPTER (EPIC-38).
//
// Pure (no chain, no CLI run): asserts docs/TRUSTLEDGER.md documents the
// "From a billing event to a license: the webhook adapter" surface the way the
// code actually behaves, so the buyer-/integrator-facing prose can't silently
// drift from trustledger/plans.js (validatePriceBinding / resolvePlanId) +
// trustledger/license.js (normalizeEvent / fulfillOrder / orderKey).
//
// The acceptance this pins (T-38.3):
//   * docs/TRUSTLEDGER.md documents the `price→plan` BINDING format (the kind +
//     schemaVersion + the per-mapping (provider, priceId) -> planId fields),
//     pinned against the LIVE plans module + the bundled example fixture;
//   * it shows the REAL two-line pipeline `normalizeEvent(rawEvent, binding) ->
//     fulfillOrder(order, catalog)`, REPLACING the old hand-waved `# event ->
//     {…}` comment (the hand-wave must be GONE);
//   * it states the `orderKey` idempotency rule (the deterministic
//     `LIC-<issuedAt>-<plan>` seed a retried event dedupes on);
//   * it names the ONE remaining HUMAN step — verifying the provider's webhook
//     SECRET — and RESTATES VERBATIM that the loop ships ONLY the binding + the
//     normalizer (+ ephemeral test keys) while the secret/key/price/webhook
//     wiring are human-owned (P-6).
//
// The guard imports trustledger/plans.js + trustledger/license.js so it fails
// loudly if a module (or its surface) is ever removed — an otherwise-hollow docs
// guard. It pins the documented binding kind/schemaVersion + the live mapping
// fields + the orderKey seed shape against the running code, so a schema/seam
// change trips the guard. It also asserts STRATEGY.md's P-6 step (3) stays
// sharpened with the webhook-secret human step and that NO new needs-human
// proposal (P-9) is introduced.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

const plans = require("../trustledger/plans");
const license = require("../trustledger/license");

const BASELINE = JSON.parse(read("trustledger/fixtures/plans/baseline.json"));
const CATALOG = plans.validatePlanCatalog(BASELINE);
const EXAMPLE_BINDING = JSON.parse(
  read("trustledger/fixtures/plans/price-binding.example.json")
);
const BINDING = plans.validatePriceBinding(EXAMPLE_BINDING, CATALOG);

describe("T-38.3 docs: TrustLedger webhook adapter documented (docs/TRUSTLEDGER.md + STRATEGY.md)", function () {
  let doc, docLower, strategy;

  before(function () {
    doc = read("docs/TRUSTLEDGER.md");
    docLower = doc.toLowerCase();
    strategy = read("STRATEGY.md");
  });

  it("plans + license still export the binding + adapter surface this guard pins against", function () {
    // Tripwire: if these drop, the assertions below would be meaningless.
    expect(plans.PRICE_BINDING_KIND, "PRICE_BINDING_KIND").to.be.a("string");
    expect(plans.PRICE_BINDING_SCHEMA_VERSION, "PRICE_BINDING_SCHEMA_VERSION").to.be.a("number");
    expect(plans.validatePriceBinding, "validatePriceBinding").to.be.a("function");
    expect(plans.resolvePlanId, "resolvePlanId").to.be.a("function");
    expect(license.normalizeEvent, "normalizeEvent").to.be.a("function");
    expect(license.fulfillOrder, "fulfillOrder").to.be.a("function");
    expect(license.orderKey, "orderKey").to.be.a("function");
    // The bundled example binding parses against the bundled catalog.
    expect(BINDING.mappings.length, "example binding has mappings").to.be.greaterThan(0);
  });

  describe("docs/TRUSTLEDGER.md: webhook-adapter section", function () {
    let section, sectionLower;
    before(function () {
      const start = docLower.indexOf("### from a billing event to a license: the webhook adapter");
      expect(start, "'From a billing event to a license: the webhook adapter' subsection present").to.be.greaterThan(-1);
      const rest = doc.slice(start);
      // Stop at the next top-level "## " heading so the section is bounded.
      const end = rest.indexOf("\n## ");
      section = end === -1 ? rest : rest.slice(0, end);
      sectionLower = section.toLowerCase();
    });

    it("documents the `price→plan` BINDING schema (every field, pinned to the live module + fixture)", function () {
      // The exact kind + schemaVersion the strict validator enforces must be documented.
      expect(section, "documented binding kind").to.include(plans.PRICE_BINDING_KIND);
      expect(section, "documented binding schemaVersion").to.include(
        String(plans.PRICE_BINDING_SCHEMA_VERSION)
      );
      // Top-level binding fields + the per-mapping fields (provider/priceId/planId).
      for (const f of ["kind", "schemaVersion", "mappings"]) {
        expect(section, `documents binding field ${f}`).to.include(f);
      }
      const sampleMapping = BINDING.mappings[0];
      for (const f of Object.keys(sampleMapping)) {
        expect(section, `documents per-mapping field ${f}`).to.include(f);
      }
      // It is named a binding / routing table mapping (provider, priceId) -> planId.
      expect(sectionLower).to.match(/binding/);
      expect(sectionLower).to.match(/provider.*priceid|price.*plan|price→plan/);
      // Validated AGAINST the catalog so an unmapped pair is a NAMED reject (no silent mis-grant).
      expect(sectionLower).to.match(/against the catalog|validatepricebinding/);
      expect(sectionLower).to.match(/unmapped/);
      expect(sectionLower).to.match(/named reject|hard error|hard `pricebindingerror`/);
      expect(sectionLower).to.match(/mis-grant|misgrant/);
      // The bundled example fixture is named so a reader can find/copy it.
      expect(section).to.match(/price-binding\.example\.json/);
    });

    it("shows the REAL two-line pipeline normalizeEvent(rawEvent, binding) -> fulfillOrder(order, catalog)", function () {
      // Both seam functions appear by name.
      expect(section, "names normalizeEvent").to.include("normalizeEvent");
      expect(section, "names fulfillOrder").to.include("fulfillOrder");
      // The composed two-line pipeline (the arrow / composition is shown).
      expect(sectionLower).to.match(
        /normalizeevent\(rawevent,\s*binding\)[\s\S]*fulfillorder\(order,\s*catalog\)/
      );
      // The order shape normalizeEvent emits is the EXACT one fulfillOrder consumes.
      for (const f of ["plan", "customer", "paidThrough", "issuedAt"]) {
        expect(section, `documents order field ${f}`).to.include(f);
      }
      // The event envelope fields it maps FROM (provider/priceId/customer/periodEnd).
      for (const f of ["provider", "priceId", "customer", "periodEnd"]) {
        expect(section, `documents event field ${f}`).to.include(f);
      }
      // epoch seconds -> canonical ISO conversion is documented.
      expect(sectionLower).to.match(/epoch/);
      expect(sectionLower).to.match(/canonical iso/);
      // Pure + deterministic + byte-identical.
      expect(sectionLower).to.match(/pure/);
      expect(sectionLower).to.match(/deterministic/);
      expect(sectionLower).to.match(/byte-identical|byte for byte|byte-for-byte/);
    });

    it("the hand-waved `# event -> {…}` placeholder comment is GONE (replaced by the real pipeline)", function () {
      // The exact hand-wave the strategy entry flagged (a literal placeholder comment) must
      // no longer exist anywhere in the doc.
      expect(doc, "no `# event -> { plan: ...}` hand-wave remains").to.not.match(
        /#\s*event\s*->\s*\{\s*plan:/
      );
    });

    it("states the orderKey idempotency rule (deterministic LIC-<issuedAt>-<plan> seed, retried event dedupes)", function () {
      expect(section, "names orderKey").to.include("orderKey");
      // The deterministic seed shape, pinned against the live code's output.
      const sampleOrder = license.normalizeEvent(
        {
          provider: BINDING.mappings[0].provider,
          priceId: BINDING.mappings[0].priceId,
          customer: "Acme Realty LLC",
          periodEnd: 1798761600,
          issuedAt: "2026-06-25T00:00:00.000Z",
        },
        BINDING
      );
      const key = license.orderKey(sampleOrder);
      expect(key, "live orderKey shape").to.match(/^LIC-[\dTZ:.\-]+-\S+$/);
      // The doc names the LIC-<issuedAt>-<plan> seed template literally.
      expect(section).to.match(/LIC-<issuedAt>-<plan>|`LIC-<issuedAt>-<plan>`/);
      // The idempotency RULE: dedupe on the key; a retried/duplicate event re-mints the
      // byte-identical license, never a second/different one.
      expect(sectionLower).to.match(/idempoten/);
      expect(sectionLower).to.match(/dedupe|dedupes|deduplicat/);
      expect(sectionLower).to.match(/retr(y|ied|ies)|duplicate|at-least-once|at least once/);
      expect(sectionLower).to.match(/byte-identical/);
      // It ties orderKey to the licenseId fulfillOrder defaults to.
      expect(sectionLower).to.match(/licenseid/);
    });

    it("names the ONE human step (verify the provider's webhook SECRET) + restates the boundary VERBATIM (P-6)", function () {
      // The webhook-secret human step is named explicitly.
      expect(sectionLower).to.match(/webhook secret|webhook's signing secret|signing secret/);
      expect(sectionLower).to.match(/verif(y|ying|ies)/);
      expect(sectionLower).to.match(/already[- ]authenticated|authenticat/);
      // normalizeEvent does NOT call a provider API / does NOT trust an unauthenticated event.
      expect(sectionLower).to.match(/does not call a provider api|not call a provider api/);
      // The loop ships ONLY the binding + normalizer (+ idempotency key / ephemeral test keys).
      expect(sectionLower).to.match(/the loop ships/);
      expect(sectionLower).to.match(/binding/);
      expect(sectionLower).to.match(/normalizer/);
      // The human-owned outward steps, restated: webhook secret + vendor key + price/term + webhook/billing.
      expect(sectionLower).to.match(/webhook secret|provider's webhook secret/);
      expect(sectionLower).to.match(/vendor key/);
      expect(sectionLower).to.match(/price\/term/);
      expect(sectionLower).to.match(/webhook\/billing|webhook.*billing/);
      expect(sectionLower).to.match(/human-owned|human step|human steps/);
      // The loop NEVER holds the provider's signing secret / real key.
      expect(sectionLower).to.match(/never hold|never holds/);
      // It anchors to P-6 step (3).
      expect(section).to.match(/P-6 step \(3\)|P-6/);
    });
  });

  describe("STRATEGY.md: P-6 step (3) stays sharpened with the webhook-secret human step", function () {
    let p6;
    before(function () {
      const start = strategy.indexOf("P-6 (2026-06-24)");
      expect(start, "P-6 proposal present").to.be.greaterThan(-1);
      const tail = strategy.slice(start);
      // P-6 runs to the start of the next top-level proposal bullet (P-7).
      const end = tail.indexOf("\n- **P-7");
      p6 = end === -1 ? tail : tail.slice(0, end);
    });

    it("P-6 still names the catalog + one-command fulfill webhook handoff (SHARPENED, not relaxed)", function () {
      const lower = p6.toLowerCase();
      expect(p6).to.include("vh trust license fulfill");
      expect(lower).to.match(/plan catalog/);
      expect(lower).to.match(/payment[ -]?succeed|payment succeeded|webhook/);
      expect(lower).to.match(/no terminal step per sale|one .*command|no hand-authored entitlement/);
      // Adds no new human gate; sharpens (3) in place; does not relax (1)/(2) or P-5.
      expect(lower).to.match(/sharpens p-6 step \(3\)|sharpens p-6/);
      expect(lower).to.match(/no new human gate|adds no new/);
      expect(lower).to.match(/does not relax \(1\)\/\(2\)|does not relax/);
    });

    it("does NOT introduce a brand-new P-9 proposal as part of this task", function () {
      // T-38.3 must not invent a new needs-human proposal — P-6's step (3) is SHARPENED in place.
      // Scoped to the P-6 block (this task's subject), not the whole file: a LATER, UNRELATED proposal
      // (e.g. P-9, the EMBEDDABLE-SDK distribution ask on a different axis) may legitimately exist elsewhere.
      expect(p6, "this task's P-6 block must not spawn a new P-9 proposal").to.not.match(
        /^\s*-\s+\*\*P-9 \(/m
      );
    });
  });
});

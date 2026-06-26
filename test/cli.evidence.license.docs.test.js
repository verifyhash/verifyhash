"use strict";

// ---------------------------------------------------------------------------
// T-48.3 docs-rot guard for `vh evidence license fulfill` + the EVIDENCE PLAN
// CATALOG (EPIC-48).
//
// Pure (no chain, no CLI run): asserts docs/EVIDENCE.md documents the evidence
// fulfillment seam (T-48.2) on top of the pure evidence plan catalog (T-48.1) the way
// the code actually behaves, so the seller-/buyer-facing prose can't silently drift from
// cli/core/evidence-plans.js + the `vh evidence license fulfill` CLI wiring + the bundled
// DRAFT catalog. It also pins the ONE-LINE SHARPENING added to STRATEGY.md's P-7 step 2,
// and proves NO new `needs-human` item / NO change to P-3/P-4/P-5/P-6/P-8 framing.
//
// Load-bearing properties under test:
//   * docs/EVIDENCE.md has an "## Issue a license per sale: `vh evidence license fulfill`"
//     section that
//       - frames fulfill as the seller's "issue a license per sale" step a billing
//         webhook drives,
//       - documents the issuance flow (resolve plan -> copy entitlements VERBATIM ->
//         derive window -> mint the SAME license the gate accepts -> UNLOCKS --sign),
//       - documents the catalog as a DRAFT the HUMAN prices (schema pinned against the
//         LIVE module + bundled fixture),
//       - documents the CLOSED evidence entitlement table (pinned against the live CFG),
//       - documents the KEY-SOURCE rule (EXACTLY ONE, read-used-discarded, never held),
//       - carries the revenue-integrity + trust-boundary caveats VERBATIM;
//   * STRATEGY.md's P-7 step 2 carries a one-line SHARPENING pointing at the fulfill
//     command, adds NO new needs-human item, and changes NO other proposal.
// The guard imports cli/core/evidence-plans.js + cli/evidence.js so it fails loudly if a
// module (or its surface) is ever removed — an otherwise-hollow docs guard. It pins the
// documented kind/schemaVersion + the actual plan ids/entitlements/terms against the LIVE
// bundled catalog, so a schema/fixture change trips the guard.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

const evidencePlans = require("../cli/core/evidence-plans");
const evidence = require("../cli/evidence");

// The LIVE bundled DRAFT catalog (the same file `fulfill` resolves against by default).
const BUNDLED = read("cli/core/fixtures/evidence-plans/baseline.json");
const CATALOG = evidencePlans.validateEvidencePlanCatalog(JSON.parse(BUNDLED));

describe("T-48.3 docs: `vh evidence license fulfill` + evidence plan catalog documented (docs/EVIDENCE.md + STRATEGY.md)", function () {
  let doc, docLower, strategy;

  before(function () {
    doc = read("docs/EVIDENCE.md");
    docLower = doc.toLowerCase();
    strategy = read("STRATEGY.md");
  });

  it("the evidence-plans module + fulfill surface still export what this guard pins against", function () {
    // Tripwire: if these drop, the assertions below would be meaningless.
    expect(evidencePlans.EVIDENCE_PLAN_CATALOG_KIND, "EVIDENCE_PLAN_CATALOG_KIND").to.be.a("string");
    expect(evidencePlans.EVIDENCE_PLAN_CATALOG_SCHEMA_VERSION, "schemaVersion").to.be.a("number");
    expect(evidencePlans.validateEvidencePlanCatalog, "validateEvidencePlanCatalog").to.be.a("function");
    expect(evidencePlans.getEvidencePlan, "getEvidencePlan").to.be.a("function");
    expect(evidencePlans.fulfillEvidenceOrder, "fulfillEvidenceOrder").to.be.a("function");
    expect(evidencePlans.ALLOWED_ENTITLEMENT_FLAGS, "ALLOWED_ENTITLEMENT_FLAGS").to.be.an("array");
    // The fulfill command is wired into the evidence CLI.
    expect(evidence.cmdEvidence, "cmdEvidence").to.be.a("function");
    // The bundled baseline catalog parses and has at least one plan.
    expect(CATALOG.plans.length, "bundled baseline has plans").to.be.greaterThan(0);
  });

  describe("docs/EVIDENCE.md: '## Issue a license per sale' section", function () {
    let section, sectionLower;
    before(function () {
      const start = docLower.indexOf("## issue a license per sale");
      expect(start, "issue-a-license-per-sale section present").to.be.greaterThan(-1);
      const rest = doc.slice(start);
      // Stop at the next top-level "## " heading (skip the section's own "## " at index 0).
      const end = rest.indexOf("\n## ", 3);
      section = end === -1 ? rest : rest.slice(0, end);
      sectionLower = section.toLowerCase();
    });

    it("frames fulfill as the seller's 'issue a license per sale' step a billing webhook drives", function () {
      expect(section, "names vh evidence license fulfill").to.include("vh evidence license fulfill");
      expect(sectionLower).to.match(/issue (the right )?evidence license|issue a license per sale/);
      // A billing webhook drives it; the per-sale work collapses.
      expect(sectionLower).to.match(/webhook/);
      expect(sectionLower).to.match(/payment[ -]?succeed/);
      expect(sectionLower).to.match(/machine-driven|self-serve/);
      expect(sectionLower).to.match(/no per-sale terminal step|no terminal step per sale|per sale/);
      expect(sectionLower).to.match(/renew/);
    });

    it("documents the issuance flow (resolve plan -> entitlements VERBATIM -> window -> mint -> UNLOCKS --sign)", function () {
      // The one-command shape names the order flags it consumes.
      for (const flag of ["--plan", "--customer", "--paid-through", "--key-env", "--out"]) {
        expect(section, `documents ${flag}`).to.include(flag);
      }
      // Entitlements come from the plan, never re-typed.
      expect(sectionLower).to.match(/verbatim/);
      expect(sectionLower).to.match(/fulfillevidenceorder/);
      expect(sectionLower).to.match(/deterministic/);
      expect(sectionLower).to.match(/byte-identical|byte for byte|byte-for-byte/);
      // The window derives from --paid-through else issuedAt + termDays.
      expect(sectionLower).to.match(/issuedat\s*\+\s*termdays|termdays\s*days/);
      // The minted license is the SAME one the gate accepts, and it UNLOCKS --sign.
      expect(sectionLower).to.match(/verifylicense/);
      expect(sectionLower).to.match(/unlock/);
      expect(section).to.match(/vh evidence seal --sign/);
      expect(section).to.include(".vhevidence-license.json");
      // Exit-code contract pinned to fulfill's REAL exit set: a PRODUCER emits only
      // {0 ok, 2 usage, 1 IO} — it has NO exit-3 "gate-fail" path of its own
      // (runEvidenceLicenseFulfill never returns EXIT.FAIL). The exit-3 in the evidence
      // family belongs to the DOWNSTREAM consumer gate (seal --sign / verify / diff), so
      // the doc must NOT advertise an exit-3 "gate-fail" as fulfill's own behavior — a
      // billing webhook keys retry/alert logic off this contract.
      expect(sectionLower, "documents fulfill's exit-0 ok class").to.match(/\*\*0\*\* ok/);
      expect(sectionLower, "documents fulfill's exit-2 usage class").to.match(/\*\*2\*\* usage/);
      expect(sectionLower, "documents fulfill's exit-1 IO class").to.match(/\*\*1\*\* io/);
      // The phantom exit-3 "gate-fail" must NOT be attributed to fulfill's own exit set.
      expect(sectionLower, "no phantom exit-3 gate-fail for fulfill").to.not.match(
        /\*\*3\*\* gate-fail/
      );
      // If exit-3 is mentioned at all, it is explicitly the DOWNSTREAM seal/verify gate.
      expect(sectionLower, "exit-3 attributed to the downstream gate, not fulfill").to.match(
        /downstream consumer gate|downstream.*gate/
      );
    });

    it("documents the CATALOG as a DRAFT the human prices, with every field pinned to the live module", function () {
      expect(sectionLower).to.match(/draft|skeleton/);
      // The exact kind + schemaVersion the strict validator enforces must be documented.
      expect(section, "documented catalog kind").to.include(evidencePlans.EVIDENCE_PLAN_CATALOG_KIND);
      expect(section, "documented catalog schemaVersion").to.include(
        String(evidencePlans.EVIDENCE_PLAN_CATALOG_SCHEMA_VERSION)
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
      // The catalog is the source of truth (the pure module) + the bundled fixture path.
      expect(section).to.match(/cli\/core\/evidence-plans\.js/);
      expect(section).to.match(/fixtures\/evidence-plans\/baseline\.json|baseline\.json/);
      // The human prices the DRAFT (no new engine change, the P-7 step-2 fill-in).
      expect(sectionLower).to.match(/human (prices|sets|fills)|price.*yours to set|yours to set/);
      // It is DISJOINT from the TrustLedger catalog kind.
      expect(sectionLower).to.match(/disjoint/);
    });

    it("documents the bundled DRAFT skeleton with the live plan ids / entitlements / terms", function () {
      // Every bundled plan id + its termDays + each of its entitlements appears verbatim,
      // pinned against the LIVE catalog (so renaming a plan or changing a term trips this).
      for (const p of CATALOG.plans) {
        expect(section, `documents bundled planId ${p.planId}`).to.include(p.planId);
        expect(section, `documents term ${p.termDays} for ${p.planId}`).to.include(String(p.termDays));
        for (const e of p.entitlements) {
          expect(section, `documents entitlement ${e} for ${p.planId}`).to.include(e);
        }
      }
    });

    it("documents the CLOSED evidence entitlement table (pinned against the live CFG, never a hard-coded copy)", function () {
      expect(sectionLower).to.match(/closed/);
      expect(sectionLower).to.match(/entitlement/);
      // Every entitlement flag the closed evidence table exposes is named in the section,
      // derived from the LIVE module (so adding/removing a flag trips this).
      for (const flag of evidencePlans.ALLOWED_ENTITLEMENT_FLAGS) {
        expect(section, `names closed entitlement flag ${flag}`).to.include(flag);
      }
      // It is the gate's table, derived via the same helper (never re-declared / can't drift).
      expect(sectionLower).to.match(/entitlementflags|same core .*helper|can never drift|never drift/);
      expect(sectionLower).to.match(/license_cfg|license cfg/);
    });

    it("documents the KEY-SOURCE rule (EXACTLY ONE, read-used-discarded, never held, only the public address echoed)", function () {
      expect(section).to.match(/--key-env|--key-file/);
      expect(sectionLower).to.match(/exactly one/);
      expect(sectionLower).to.match(/read-used-discarded/);
      expect(sectionLower).to.match(/never holds|never held|loop .*never holds/);
      // Only the PUBLIC vendor address is echoed, never the key.
      expect(sectionLower).to.match(/public vendor address|public.*address/);
      // Neither/both/missing/malformed hard-error key-free at exit 2; nothing written on failure.
      expect(sectionLower).to.match(/key-free/);
      expect(sectionLower).to.match(/no file is written|never cwd/);
    });

    it("carries the revenue-integrity caveat VERBATIM (loop ships mechanism; price/key/webhook are HUMAN; NOT a token)", function () {
      // The loop ships ONLY the catalog schema + the mapping (+ ephemeral test keys).
      expect(sectionLower).to.match(/loop ships .*only.*catalog|ships \*\*only\*\*/);
      expect(sectionLower).to.match(/ephemeral test keys/);
      // The loop NEVER sets a price / holds a real key / runs a payment processor / takes payment.
      expect(sectionLower).to.match(/never/);
      expect(sectionLower).to.match(/sets a price/);
      expect(sectionLower).to.match(/holds a real key|hold(s)? a real key/);
      expect(sectionLower).to.match(/runs a payment processor|payment processor/);
      expect(sectionLower).to.match(/takes a real payment|take a real payment/);
      // The three human-owned outward steps: vendor KEY, PRICE/term column, WEBHOOK/billing.
      expect(sectionLower).to.match(/evidence vendor key|vendor key/);
      expect(sectionLower).to.match(/price\/term column|price\/term/);
      expect(sectionLower).to.match(/webhook\/billing|webhook|billing/);
      expect(sectionLower).to.match(/human-owned outward step/);
      // Access-description posture: NOT a token / tradeable / appreciating asset / no regulatory claim.
      expect(sectionLower).to.match(/access description/);
      expect(sectionLower).to.match(/not a token/);
      expect(sectionLower).to.match(/not tradeable/);
      expect(sectionLower).to.match(/not an appreciating asset/);
      expect(sectionLower).to.match(/no claim of regulatory compliance/);
    });

    it("carries the trust-boundary caveat VERBATIM (license is an ACCESS credential, NOT a trusted timestamp; P-3)", function () {
      expect(sectionLower).to.match(/access credential/);
      expect(sectionLower).to.match(/not a trusted timestamp/);
      expect(sectionLower).to.match(/signing\/timestamp trust-root/);
      expect(section).to.match(/P-3/);
      // verifyLicense re-derives the signer; the claimed vendor is untrusted transport.
      expect(sectionLower).to.match(/re-derives the signer|recovers .*signer|re-derive/);
      expect(sectionLower).to.match(/untrusted transport/);
    });

    it("introduces NO new human gate (the fulfill command automates the MECHANISM of an existing P-7 step)", function () {
      expect(section).to.match(/P-7/);
      expect(sectionLower).to.match(/no new human gate/);
    });
  });

  describe("STRATEGY.md: P-7 step 2 SHARPENED to point at `vh evidence license fulfill`", function () {
    let p7;
    before(function () {
      const start = strategy.indexOf("P-7 (2026-06-24)");
      expect(start, "P-7 proposal present").to.be.greaterThan(-1);
      const tail = strategy.slice(start);
      // P-7 runs to the start of the next top-level proposal bullet (P-8).
      const end = tail.indexOf("\n- **P-8");
      p7 = end === -1 ? tail : tail.slice(0, end);
    });

    it("step 2 carries a one-line SHARPENING pointing at the fulfill command + the doc section", function () {
      const lower = p7.toLowerCase();
      expect(p7).to.include("vh evidence license fulfill");
      expect(lower).to.match(/sharpen/);
      // The mapping detail: entitlements copied VERBATIM, no hand-authored flag list, DRAFT catalog.
      expect(lower).to.match(/verbatim/);
      expect(lower).to.match(/draft .*catalog|evidence plan catalog/);
      expect(lower).to.match(/no hand-authored|no .*flag list/);
      // A billing webhook drives it.
      expect(lower).to.match(/webhook/);
      // It points at the doc section so the two stay anchored.
      expect(lower).to.match(/issue a license per sale|docs\/evidence\.md/);
    });

    it("adds NO new human gate and does NOT introduce a brand-new P-9 proposal", function () {
      const lower = p7.toLowerCase();
      expect(lower).to.match(/no new human gate/);
      // T-48.3 must not invent a new needs-human proposal — P-7's step 2 is SHARPENED in place.
      expect(strategy, "no new P-9 proposal introduced by this task").to.not.match(
        /^\s*-\s+\*\*P-9 \(/m
      );
    });

    it("does NOT add a new `needs-human` item to P-7 (the body still names exactly steps 1-3)", function () {
      // P-7 keeps its existing three narrow human steps — the sharpening adds a pointer, not a 4th step.
      expect(p7).to.match(/three NARROW, decision-ready\s*\n?\s*human steps/);
      // No "step 4" / "(4)" human action sneaks in.
      expect(p7).to.not.match(/\n\s*4\.\s+\*\*/);
    });
  });

  describe("STRATEGY.md: the SHARPENING does NOT touch P-3/P-4/P-5/P-6/P-8 framing", function () {
    // The sharpening lives only inside P-7 step 2. Confirm the other proposals' headings
    // are still present and unmodified by this task (a coarse but load-bearing tripwire:
    // if a careless edit re-titled or deleted one, this fails).
    it("P-3, P-4, P-5, P-6, P-8 proposal bullets are all still present", function () {
      for (const tag of ["P-3", "P-4", "P-5", "P-6", "P-8"]) {
        expect(strategy, `${tag} proposal bullet present`).to.match(
          new RegExp("- \\*\\*" + tag + " \\(")
        );
      }
    });
  });
});

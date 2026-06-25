"use strict";

// ---------------------------------------------------------------------------
// T-40.3 docs-rot guard for the SECURITY-DEPOSIT SEGREGATION rule.
//
// The segregation check is the flagship out-of-trust finding, and it closes TWO
// distinct silent-false-pass holes — but the buyer-/handoff-facing prose used to
// describe only ONE ("counts deposit coverage from one source") and never said the
// match is PER BENEFICIARY. That "one source" claim was now INACCURATE for the
// two-mechanism reality: a reader would believe single-source counting was the
// whole guard and miss that a pooled total ALSO false-passes by netting one
// tenant's shortage against another's surplus. This guard pins the corrected,
// two-mechanism description so the prose can't silently drift from the engine
// (trustledger/reconcile.js).
//
// Load-bearing properties under test (the acceptance criteria):
//   * the doc describes PER-BENEFICIARY segregation matching (a transfer for tenant
//     X covers only X; no spill onto tenant Y);
//   * it CORRECTS the "one source" claim so it is accurate for BOTH false-pass
//     mechanisms (single-source counting AND per-beneficiary matching), naming each;
//   * the DRAFT / NOT-LEGAL-ADVICE / CPA posture is restated VERBATIM (the same
//     canonical blockquote the policy section carries);
//   * it adds NO new `needs-human` item and does NOT alter P-3/P-5/P-6/P-7/P-8.
//
// The guard imports trustledger/reconcile.js so it fails loudly if the predicates
// it pins against (classifySecurityDeposits' single-source rule, the per-beneficiary
// attribution) are ever removed — an otherwise-hollow docs guard. PURE: it only
// reads files and asserts strings; it writes nothing and the cwd is untouched.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const reconcile = require("../trustledger/reconcile");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

describe("T-40.3 docs: the per-beneficiary, single-source segregation rule is documented (docs/TRUSTLEDGER.md)", function () {
  let doc, docLower, cwdBefore;

  before(function () {
    cwdBefore = process.cwd();
    doc = read("docs/TRUSTLEDGER.md");
    docLower = doc.toLowerCase();
  });

  after(function () {
    // Filesystem hygiene: a pure docs guard must not move/leak anything.
    expect(process.cwd(), "cwd untouched by the docs guard").to.equal(cwdBefore);
  });

  it("the engine still exports the segregation surface this guard pins against (tripwire)", function () {
    // If the segregation finding (or its enum string) is removed/renamed, the
    // documented rule would be meaningless.
    expect(
      reconcile.EXCEPTION.SECURITY_DEPOSIT_SEGREGATION,
      "EXCEPTION.SECURITY_DEPOSIT_SEGREGATION"
    ).to.equal("security_deposit_segregation");
    expect(
      reconcile.DEFAULT_SEVERITY[reconcile.EXCEPTION.SECURITY_DEPOSIT_SEGREGATION],
      "default severity is ERROR"
    ).to.equal(reconcile.SEVERITY.ERROR);
  });

  it("CORRECTS the now-inaccurate 'one source' claim: no bare single-mechanism sentence survives", function () {
    // The OLD prose claimed the check "counts deposit coverage from one source so it
    // cannot silently clear an un-segregated deposit by netting it against another
    // figure" — and said NOTHING about per-beneficiary matching. That exact bare
    // single-mechanism sentence must be gone (it implied one source was the whole
    // guard). We assert the inaccurate phrasing no longer appears.
    expect(
      doc.includes("counts deposit coverage from **one** source"),
      "the bare 'one source' claim is corrected/removed"
    ).to.equal(false);
    // The three-balances pointer must now say there are TWO holes the check closes.
    const threeBalances = doc.slice(
      docLower.indexOf("## the three balances"),
      docLower.indexOf("## security-deposit segregation")
    );
    expect(threeBalances, "three-balances section present").to.have.length.greaterThan(0);
    expect(threeBalances).to.match(/\*\*two\*\*/i);
    expect(threeBalances.toLowerCase()).to.match(/silently clear|false[- ]pass|silently/);
  });

  describe("the dedicated '## Security-deposit segregation: per-beneficiary, single-source' section", function () {
    let section, sectionLower, flat, flatLower;
    before(function () {
      const start = docLower.indexOf("## security-deposit segregation: per-beneficiary, single-source");
      expect(start, "segregation section present").to.be.greaterThan(-1);
      const rest = doc.slice(start);
      // Bound the section at the NEXT level-2 heading.
      const end = rest.indexOf("\n## ", 5);
      section = end === -1 ? rest : rest.slice(0, end);
      sectionLower = section.toLowerCase();
      // The prose is hard-wrapped; collapse runs of whitespace so phrase matches
      // are not defeated by a line break landing mid-phrase.
      flat = section.replace(/\s+/g, " ");
      flatLower = flat.toLowerCase();
    });

    it("names BOTH false-pass mechanisms the check closes (single-source AND per-beneficiary)", function () {
      // Mechanism 1: single-source counting (one source, not two).
      expect(flatLower).to.match(/single[- ]source/);
      expect(flatLower).to.match(/one source|one authoritative source/);
      // Mechanism 2: per-beneficiary matching.
      expect(flatLower).to.match(/per[- ]beneficiary/);
      // It must say there are TWO holes/mechanisms, not one.
      expect(flatLower).to.match(/\btwo\b/);
    });

    it("explains Mechanism 1 — single-source counting (book, not book+bank double-count)", function () {
      // The same transfer is recorded twice (book + bank); summing both double-counts.
      expect(flatLower).to.match(/recorded \*?\*?twice|seen from two sources|same money movement/);
      expect(flatLower).to.match(/double[- ]count/);
      // Coverage is counted from the BOOK (the one authoritative source).
      expect(flatLower).to.match(/\bbook\b/);
      expect(flatLower).to.match(/bank.?side copy|bank.{0,40}(mirror|adds no|unused)/);
    });

    it("explains Mechanism 2 — per-beneficiary matching (no spill between tenants)", function () {
      // A transfer for X covers only X; its excess does NOT spill onto Y.
      expect(flatLower).to.match(/each.{0,30}(tenant|beneficiary).{0,30}separate|held \*?\*?separate/);
      expect(flatLower).to.match(/spill|net.{0,40}surplus|surplus.{0,40}shortage|shortage.{0,40}surplus/);
      // The pooled-total false pass it closes (over- vs under-segregated net to zero).
      expect(flatLower).to.match(/pooled total|pooled/);
      expect(flatLower).to.match(/over-?segregat/);
      // The at-risk beneficiary is NAMED in the finding (T-40.2 carried through).
      expect(flatLower).to.match(/named|names the at-risk|at-risk beneficiary/);
      // A generic/unattributable transfer is a residual pool, not a free pass.
      expect(flatLower).to.match(/generic residual pool|residual pool|generic/);
    });

    it("states the check is strictly non-looser than a naïve total (only ADDs/RE-ATTRIBUTEs, never removes)", function () {
      expect(flatLower).to.match(/strictly non-?looser|non-?looser/);
      expect(flatLower).to.match(/add or re-?attribute|re-?attribute/);
      expect(flatLower).to.match(/never remove|never.{0,20}remove/);
    });

    it("names the engine functions the rule is pinned to (so the doc can't drift from the code)", function () {
      expect(section).to.include("classifySecurityDeposits");
      expect(section).to.include("attributeSegregation");
      expect(section).to.include("trustledger/reconcile.js");
    });

    it("restates the DRAFT / NOT-LEGAL-ADVICE posture VERBATIM (the canonical blockquote)", function () {
      // The canonical posture blockquote lives once in the policy section; this
      // section must reproduce it verbatim so the rule inherits the caveat and the
      // two can't drift. Pull the canonical block and assert it appears again here.
      const canonical =
        "> **DRAFT / NOT LEGAL ADVICE.** The policies that SHIP with TrustLedger\n" +
        "> (`trustledger/fixtures/policy/*.json`) are **DRAFT skeletons**, not legal advice and **not a claim of\n" +
        "> regulatory compliance**. The baseline reproduces the built-in defaults verbatim; the example state\n" +
        "> file carries a **PLACEHOLDER** citation. A qualified **CPA and/or counsel must review and SIGN** the\n" +
        "> per-state severity mapping and its statute citations for the actual jurisdiction before the gate is\n" +
        "> relied on. Selecting a policy does **not** make a packet legal advice and does **not** discharge the\n" +
        "> broker's duty as the responsible legal custodian of trust funds. (STRATEGY.md › P-5 #1/#2.)";
      // It appears MORE THAN ONCE in the doc (the policy section + this section + the
      // ambiguous-deposit section): adding this section must not be the only copy.
      const occurrences = doc.split(canonical).length - 1;
      expect(occurrences, "DRAFT/NOT-LEGAL-ADVICE posture restated verbatim ≥ twice").to.be.greaterThan(1);
      // And specifically inside THIS section.
      expect(section).to.include(canonical);
    });

    it("ties the per-state grading to the EXISTING P-5 #2 handoff and adds NO new needs-human item", function () {
      expect(section).to.match(/P-5/);
      expect(flatLower).to.match(/no new `?needs-human`? item|no new needs-human/);
      expect(flatLower).to.match(/no engine change/);
    });

    it("restates the custodian / CPA posture (a PASS is not a legal-compliance certificate)", function () {
      // The section must keep the responsible-custodian + CPA-must-sign posture, so a
      // reader can't mistake the un-foolable check for a compliance guarantee.
      expect(flatLower).to.match(/cpa/);
      expect(flatLower).to.match(/custodian|legal custodian/);
    });
  });

  it("the two documented mechanisms match what the engine actually does (no drift)", function () {
    // Prove the per-beneficiary rule the doc describes is the rule the code runs:
    // an over-segregated tenant's surplus does NOT clear another tenant's
    // un-segregated deposit — exactly the Mechanism-2 false pass the doc claims is
    // closed. (Mirrors the T-40.1 CASE B engine test, kept here so the doc claim is
    // tied to live behaviour, not just to prose.)
    const rec = (date, amount, memo, extra) => ({
      date,
      amount,
      memo,
      source: "quickbooks",
      ...extra,
    });
    const secDeposit = (party, cents) =>
      rec("2026-05-01", Math.abs(cents), `Security deposit - ${party}`, {
        kind: "deposit",
        party,
      });
    const segTransfer = (party, cents) =>
      rec("2026-05-02", -Math.abs(cents), "Transfer security deposit to escrow", {
        kind: "transfer",
        party,
      });

    const book = [
      secDeposit("Jones (4B)", 100000),
      secDeposit("Smith (4A)", 100000),
      segTransfer("Jones (4B)", 200000), // Jones over-segregated; Smith segregates nothing
    ];
    const tenants = { "Jones (4B)": 100000, "Smith (4A)": 100000 };
    const r = reconcile.reconcile([], book, tenants);
    const seg = r.exceptions.filter(
      (e) => e.type === reconcile.EXCEPTION.SECURITY_DEPOSIT_SEGREGATION
    );
    // Pooled total ($200k deposits == $200k segregated) would raise ZERO — a false
    // pass. Per-beneficiary matching flags SMITH for the real $1000 shortfall.
    expect(seg, "exactly one segregation finding (Smith), not a pooled false-pass").to.have.length(1);
    expect(seg[0].records[0].party, "the flagged beneficiary is the un-segregated one").to.equal(
      "Smith (4A)"
    );
    expect(seg[0].severity).to.equal(reconcile.SEVERITY.ERROR);
  });

  it("adds NO new `needs-human` proposal id beyond the existing P-3/P-5/P-6/P-7/P-8", function () {
    // Enumerate every P-<n> reference in the doc; the closed set must not grow.
    const ids = new Set((doc.match(/\bP-\d+\b/g) || []));
    const allowed = new Set(["P-3", "P-5", "P-6", "P-7", "P-8"]);
    for (const id of ids) {
      expect(allowed.has(id), `proposal id ${id} is within the existing P-3/P-5/P-6/P-7/P-8 set`).to.equal(
        true
      );
    }
  });
});

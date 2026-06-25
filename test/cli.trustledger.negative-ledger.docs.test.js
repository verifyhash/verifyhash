"use strict";

// ---------------------------------------------------------------------------
// T-41.3 docs-rot guard for the NEGATIVE-INDIVIDUAL-LEDGER rule + the corrected
// "nothing is commingled or missing" claim in docs/TRUSTLEDGER.md.
//
// The "three balances" section used to assert that the pooled equality
// `book == sub-ledger total` means "nothing is commingled or missing." That
// claim was INACCURATE: the second equality checks only the pooled SUM of every
// per-beneficiary balance, and a sum is necessary but NOT sufficient — one
// beneficiary's surplus can exactly mask another beneficiary's deficit, so the
// pool ties to the penny while a tenant's trust money is in fact gone. The
// per-beneficiary `negative_tenant_ledger` ERROR is the guard that closes that
// hole, and it fires INDEPENDENTLY of whether the SUM ties. This guard pins the
// corrected prose so the buyer-/handoff-facing doc can't silently drift from the
// engine (trustledger/reconcile.js › classifyNegativeTenantLedgers).
//
// Load-bearing properties under test (the acceptance criteria):
//   * the doc CORRECTS the "nothing is commingled or missing" overclaim so the
//     pooled tie-out is described as necessary-but-not-sufficient (a surplus can
//     mask a deficit);
//   * it documents the no-negative-individual-ledger requirement (no single
//     beneficiary's own sub-ledger may be negative) as a third, per-beneficiary
//     in-trust condition beyond the two pooled equalities;
//   * `negative_tenant_ledger` is listed as an out-of-trust ERROR that FAILs the
//     gate, fires independently of whether the SUM ties, and excludes control
//     accounts;
//   * the DRAFT / NOT-LEGAL-ADVICE / CPA custodian posture is restated VERBATIM
//     (the same canonical blockquote the policy section carries);
//   * it adds NO new `needs-human` item and does NOT alter the closed
//     P-3/P-5/P-6/P-7/P-8 proposal-id set.
//
// The guard imports trustledger/reconcile.js so it fails loudly if the finding
// (or its enum string / default severity) is ever removed — an otherwise-hollow
// docs guard — and runs the engine on a real fixture to prove the documented
// behaviour is the behaviour the code runs. PURE: it only reads files and runs
// the in-memory reconciler; it writes nothing and the cwd is untouched.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const reconcile = require("../trustledger/reconcile");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

describe("T-41.3 docs: the negative-individual-ledger rule + corrected commingling claim (docs/TRUSTLEDGER.md)", function () {
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

  it("the engine still exports the negative-ledger surface this guard pins against (tripwire)", function () {
    // If the finding (or its enum string) is removed/renamed, the documented rule
    // would be meaningless — fail loudly rather than guard hollow prose.
    expect(
      reconcile.EXCEPTION.NEGATIVE_TENANT_LEDGER,
      "EXCEPTION.NEGATIVE_TENANT_LEDGER"
    ).to.equal("negative_tenant_ledger");
    expect(
      reconcile.DEFAULT_SEVERITY[reconcile.EXCEPTION.NEGATIVE_TENANT_LEDGER],
      "default severity is ERROR"
    ).to.equal(reconcile.SEVERITY.ERROR);
  });

  describe("the '## The three balances' section corrects the commingling overclaim", function () {
    let section, sectionLower, flat, flatLower;
    before(function () {
      const start = docLower.indexOf("## the three balances");
      expect(start, "three-balances section present").to.be.greaterThan(-1);
      const rest = doc.slice(start);
      const end = rest.indexOf("\n## ", 5);
      section = end === -1 ? rest : rest.slice(0, end);
      sectionLower = section.toLowerCase();
      // The prose is hard-wrapped; collapse whitespace so phrase matches survive a
      // line break landing mid-phrase.
      flat = section.replace(/\s+/g, " ");
      flatLower = flat.toLowerCase();
    });

    it("no longer presents 'nothing is commingled or missing' as a GUARANTEE of the pooled equality", function () {
      // The OLD prose read: "book == sub-ledger total (the money in the account is
      // fully accounted for to its beneficiaries — nothing is commingled or
      // missing)." That parenthetical asserted the pooled SUM tying PROVES nothing
      // is commingled/missing, which is false. The bare guarantee must be gone.
      expect(
        flat.includes("fully accounted for to its beneficiaries — nothing is commingled or missing"),
        "the bare 'nothing is commingled or missing' guarantee is corrected/removed"
      ).to.equal(false);
      // If the phrase appears at all, it must appear only as the CORRECTED/overclaim
      // callout (i.e. accompanied by the word "overclaim"/"not sufficient"), never as
      // a standalone guarantee parenthetical.
      if (flatLower.includes("nothing is commingled or missing")) {
        expect(
          flatLower,
          "any surviving 'commingled or missing' mention is framed as the corrected overclaim"
        ).to.match(/overclaim|not sufficient|does \*?\*?not\*?\*? prove|corrected/);
      }
    });

    it("explains the pooled tie-out is NECESSARY but NOT SUFFICIENT (a surplus can mask a deficit)", function () {
      // The corrected claim: a sum can tie while one beneficiary's surplus masks
      // another's deficit.
      expect(flatLower).to.match(/not sufficient|necessary but not|does \*?\*?not\*?\*? prove/);
      expect(flatLower).to.match(/surplus.{0,40}(mask|deficit)|mask.{0,40}deficit|deficit/);
      expect(flatLower).to.match(/pooled sum|pooled tie|pooled total|the pool/);
    });

    it("documents the no-negative-individual-ledger requirement as a third, per-beneficiary in-trust condition", function () {
      expect(flatLower).to.match(/no-?negative-?individual-?ledger|no single beneficiary.{0,40}negative/);
      expect(flatLower).to.match(/per-?beneficiary/);
      // It must say the broker holds LESS than zero in trust for that person.
      expect(flatLower).to.match(/less than zero|negative individual ledger/);
    });

    it("lists `negative_tenant_ledger` as an out-of-trust ERROR that fires independently of the SUM", function () {
      expect(section).to.include("negative_tenant_ledger");
      expect(flatLower).to.match(/out of trust/);
      expect(flatLower).to.match(/\berror\b/);
      expect(flatLower).to.match(/fail/);
      // Orthogonal to the pooled SUM check — both can fire at once.
      expect(flatLower).to.match(/independently of whether the sum ties|independent.{0,30}sum|both.{0,30}fire/);
      // Control/sink accounts are excluded (their negative is structural).
      expect(flatLower).to.match(/control\/?sink account|control account/);
      // Pinned to the engine function so the doc can't drift from the code.
      expect(section).to.include("classifyNegativeTenantLedgers");
      expect(section).to.include("trustledger/reconcile.js");
    });
  });

  it("the '## Exceptions and their severities' ERROR bullet names negative_tenant_ledger as out-of-trust", function () {
    const start = docLower.indexOf("## exceptions and their severities");
    expect(start, "exceptions section present").to.be.greaterThan(-1);
    const rest = doc.slice(start);
    const end = rest.indexOf("\n## ", 3);
    const section = end === -1 ? rest : rest.slice(0, end);
    // The ERROR bullet (out-of-trust) must name the negative individual ledger.
    // Flatten whitespace first so a hard-wrap landing mid-phrase doesn't defeat the
    // proximity match (the prose is hard-wrapped, like the rest of the doc).
    const flatLower = section.replace(/\s+/g, " ").toLowerCase();
    expect(section).to.include("negative_tenant_ledger");
    expect(flatLower).to.match(/individual.{0,40}(beneficiary|ledger).{0,40}negative|negative.{0,40}(individual|beneficiary)/);
  });

  it("restates the DRAFT / NOT-LEGAL-ADVICE posture VERBATIM (the canonical blockquote, still appearing ≥ twice)", function () {
    // The canonical posture blockquote lives in the policy section; correcting the
    // commingling claim must NOT have dropped or reworded it. Pull the canonical
    // block and assert it still appears more than once (so this task did not become
    // the only copy nor strip an existing one).
    const canonical =
      "> **DRAFT / NOT LEGAL ADVICE.** The policies that SHIP with TrustLedger\n" +
      "> (`trustledger/fixtures/policy/*.json`) are **DRAFT skeletons**, not legal advice and **not a claim of\n" +
      "> regulatory compliance**. The baseline reproduces the built-in defaults verbatim; the example state\n" +
      "> file carries a **PLACEHOLDER** citation. A qualified **CPA and/or counsel must review and SIGN** the\n" +
      "> per-state severity mapping and its statute citations for the actual jurisdiction before the gate is\n" +
      "> relied on. Selecting a policy does **not** make a packet legal advice and does **not** discharge the\n" +
      "> broker's duty as the responsible legal custodian of trust funds. (STRATEGY.md › P-5 #1/#2.)";
    const occurrences = doc.split(canonical).length - 1;
    expect(occurrences, "DRAFT/NOT-LEGAL-ADVICE posture present verbatim ≥ twice").to.be.greaterThan(1);
  });

  it("keeps the responsible-custodian / CPA posture and the top-of-doc 'aids reconciliation, not a certificate' framing", function () {
    // The corrected section must not have weakened the standing custodian posture.
    expect(docLower).to.match(/responsible (legal )?custodian|legal custodian/);
    expect(docLower).to.match(/qualified cpa|cpa or your state regulator|cpa\/counsel|cpa and\/or counsel/);
    expect(docLower).to.match(/a pass does not certify legal compliance|aids\s+reconciliation|tool that aids/);
  });

  it("adds NO new `needs-human` proposal id beyond the existing P-3/P-5/P-6/P-7/P-8 set", function () {
    // Enumerate every P-<n> reference in the doc; the closed set must not grow.
    const ids = new Set((doc.match(/\bP-\d+\b/g) || []));
    const allowed = new Set(["P-3", "P-5", "P-6", "P-7", "P-8"]);
    for (const id of ids) {
      expect(allowed.has(id), `proposal id ${id} is within the existing P-3/P-5/P-6/P-7/P-8 set`).to.equal(
        true
      );
    }
  });

  it("the documented behaviour is the behaviour the engine runs: a pooled-tie month with one negative ledger still FAILs", function () {
    // Prove the doc's central claim against LIVE engine behaviour: the pooled SUM
    // ties to the book to the penny, yet one beneficiary's individual ledger is
    // negative — so the gate is OUT OF TRUST via negative_tenant_ledger, exactly
    // the "surplus masks a deficit" hole the corrected prose says the pooled
    // tie-out leaves open.
    //
    // Book activity: +$2,000 in (so book == opening 0 + 2000 == 2000), and the
    // bank mirrors it so adjusted bank == book. Sub-ledger: tenant A holds +$3,000
    // (a surplus), tenant B holds -$1,000 (their money is gone). The SUM is
    // $3,000 - $1,000 == $2,000 == book: the pooled equality TIES. But B's
    // individual ledger is negative — out of trust.
    const tenants = { "Tenant A": 300000, "Tenant B": -100000 };
    const subTotal = Object.values(tenants).reduce((a, b) => a + b, 0);
    expect(subTotal, "the pooled sub-ledger SUM ties to the $2,000 book").to.equal(200000);

    const book = [
      {
        date: "2026-05-01",
        amount: 200000,
        memo: "Rent receipts",
        source: "quickbooks",
        kind: "rent",
      },
    ];
    const bank = [
      { date: "2026-05-01", amount: 200000, memo: "Rent receipts", source: "bank" },
    ];

    const r = reconcile.reconcile(bank, book, tenants);

    // The pooled book == sub-ledger SUM equality holds (no SUBLEDGER_OUT_OF_BALANCE).
    const pooled = r.exceptions.filter(
      (e) => e.type === reconcile.EXCEPTION.SUBLEDGER_OUT_OF_BALANCE
    );
    expect(pooled, "the pooled SUM ties — no subledger_out_of_balance finding").to.have.length(0);

    // Yet the negative individual ledger is flagged as an out-of-trust ERROR.
    const neg = r.exceptions.filter(
      (e) => e.type === reconcile.EXCEPTION.NEGATIVE_TENANT_LEDGER
    );
    expect(neg, "exactly the negative-ledger beneficiary (B) is flagged").to.have.length(1);
    expect(neg[0].severity, "negative individual ledger is ERROR").to.equal(
      reconcile.SEVERITY.ERROR
    );
    // The finding fires even though the SUM tied — proving it is independent of the SUM.
  });
});

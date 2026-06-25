"use strict";

// ---------------------------------------------------------------------------
// T-42.3 docs-rot guard for the OWNER-OVERDRAW rule + the corrected owner-draw
// severity description in docs/TRUSTLEDGER.md.
//
// EPIC-41 made an owner's negative sub-ledger balance STRUCTURAL while it stays
// WITHIN the owner's own contributed capital (a control account legitimately
// deploying its OWN funds): the negative-ledger check deliberately EXCLUDES such
// accounts. T-42.1 added the precise INVERSE — `owner_overdraw` — which catches
// the negative BEYOND contributed capital: an owner who drew MORE than they
// contributed paid themselves out of OTHER beneficiaries' trust money, a
// conversion of trust funds. A benign owner draw (within contributed capital) is
// the `owner_draw` WARNING; the over-capital EXCESS is the separate
// `owner_overdraw` ERROR.
//
// The "Exceptions and their severities" section used to describe an owner draw as
// ONLY a WARNING. After T-42.1 that is INACCURATE: the over-capital excess is an
// out-of-trust ERROR. This guard pins the corrected prose so the
// buyer-/handoff-facing doc can't silently drift from the engine
// (trustledger/reconcile.js › classifyOwnerDraws), proving the documented
// behaviour is the behaviour the code runs.
//
// Load-bearing properties under test (the acceptance criteria):
//   * the doc describes the owner-overdraw rule (benign up to contributed
//     capital, ERROR for the EXCESS);
//   * `owner_overdraw` is listed as an out-of-trust ERROR (and the ERROR bullet
//     of the severities section names it), distinct from the `owner_draw`
//     WARNING;
//   * the control-account boundary is explained consistent with EPIC-41 (the
//     overdraw is the INVERSE of the negative-ledger control-account exclusion;
//     it catches only the negative BEYOND contributed capital and fires even when
//     the pooled SUM ties out);
//   * the DRAFT / NOT-LEGAL-ADVICE / CPA custodian posture is restated VERBATIM
//     (the same canonical blockquote the policy section carries);
//   * it adds NO new `needs-human` item and does NOT alter the closed
//     P-3/P-5/P-6/P-7/P-8 proposal-id set.
//
// The guard imports trustledger/reconcile.js so it fails loudly if the finding
// (or its enum string / default severity) is ever removed — an otherwise-hollow
// docs guard — and runs the engine on a real model to prove the documented
// behaviour is the behaviour the code runs. PURE: it only reads files and runs
// the in-memory reconciler; it writes nothing and the cwd is untouched.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const reconcile = require("../trustledger/reconcile");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

describe("T-42.3 docs: the owner-overdraw rule + corrected owner-draw severity (docs/TRUSTLEDGER.md)", function () {
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

  it("the engine still exports the owner-overdraw surface this guard pins against (tripwire)", function () {
    // If the finding (or its enum string) is removed/renamed, the documented rule
    // would be meaningless — fail loudly rather than guard hollow prose.
    expect(reconcile.EXCEPTION.OWNER_OVERDRAW, "EXCEPTION.OWNER_OVERDRAW").to.equal(
      "owner_overdraw"
    );
    expect(reconcile.EXCEPTION.OWNER_DRAW, "EXCEPTION.OWNER_DRAW").to.equal("owner_draw");
    // The over-capital excess is out of trust (ERROR); a benign draw is a WARNING.
    expect(
      reconcile.DEFAULT_SEVERITY[reconcile.EXCEPTION.OWNER_OVERDRAW],
      "owner_overdraw default severity is ERROR"
    ).to.equal(reconcile.SEVERITY.ERROR);
    expect(
      reconcile.DEFAULT_SEVERITY[reconcile.EXCEPTION.OWNER_DRAW],
      "owner_draw default severity is WARNING"
    ).to.equal(reconcile.SEVERITY.WARNING);
  });

  it("lists `owner_overdraw` among the legal exception types (the policy keys)", function () {
    // The exception-types fence must enumerate owner_overdraw so a per-state policy
    // can re-grade it like every other type.
    expect(doc).to.include("owner_overdraw");
  });

  describe("the '## Exceptions and their severities' section corrects the owner-draw severity", function () {
    let section, flatLower;
    before(function () {
      const start = docLower.indexOf("## exceptions and their severities");
      expect(start, "exceptions section present").to.be.greaterThan(-1);
      const rest = doc.slice(start);
      const end = rest.indexOf("\n## ", 3);
      section = end === -1 ? rest : rest.slice(0, end);
      // The prose is hard-wrapped; collapse whitespace so phrase matches survive a
      // line break landing mid-phrase.
      flatLower = section.replace(/\s+/g, " ").toLowerCase();
    });

    it("names `owner_overdraw` in the section and ties it to the out-of-trust ERROR severity", function () {
      expect(section).to.include("owner_overdraw");
      expect(flatLower).to.match(/out of trust/);
      expect(flatLower).to.match(/\berror\b/);
    });

    it("describes the benign-vs-excess split: a draw WITHIN contributed capital is WARNING, the EXCESS is ERROR", function () {
      // The benign part (within the owner's OWN contributed capital) stays a WARNING.
      expect(flatLower).to.match(/contributed capital/);
      expect(flatLower).to.match(/\bwarning\b/);
      // The EXCESS beyond contributed capital is the out-of-trust ERROR.
      expect(flatLower).to.match(/excess|exceeds|beyond/);
      // The excess is OTHER beneficiaries' trust money (a conversion of trust funds).
      expect(flatLower).to.match(/other (beneficiaries|beneficiary).{0,40}trust money|out of .{0,20}trust money|conversion of trust/);
    });

    it("corrects the earlier owner-draw-ONLY-a-warning wording rather than silently leaving it", function () {
      // The doc must explicitly mark the correction (so the inaccurate "owner draw is
      // only a WARNING" framing can't quietly persist alongside the new ERROR).
      expect(flatLower).to.match(/corrected here|is corrected|earlier wording/);
    });

    it("pins the engine function so the doc can't drift from the code", function () {
      expect(section).to.include("classifyOwnerDraws");
      expect(section).to.include("trustledger/reconcile.js");
    });
  });

  describe("the control-account boundary is explained consistent with EPIC-41", function () {
    let section, flatLower;
    before(function () {
      // The full per-account rule lives under "The policy file schema".
      const anchor = docLower.indexOf("`owner_overdraw` is raised");
      expect(anchor, "owner_overdraw schema paragraph present").to.be.greaterThan(-1);
      // Grab a generous window around the paragraph + the control-account subsection.
      section = doc.slice(anchor, anchor + 4000);
      flatLower = section.replace(/\s+/g, " ").toLowerCase();
    });

    it("frames owner_overdraw as the INVERSE of the negative-ledger control-account exclusion", function () {
      expect(flatLower).to.match(/inverse/);
      expect(flatLower).to.match(/negative_tenant_ledger|negative-?ledger|negative.{0,30}exclusion/);
      // It catches only the negative BEYOND contributed capital; WITHIN is ignored.
      expect(flatLower).to.match(/within.{0,40}contributed capital|beyond.{0,30}contributed capital/);
    });

    it("explains the contribution-basis boundary: only fires when C>0; an opening-capital deploy is not second-guessed", function () {
      expect(flatLower).to.match(/contributed capital/);
      expect(flatLower).to.match(/in-?period contribution|contribution basis|c > 0|established.{0,30}basis/);
      expect(flatLower).to.match(/opening.{0,20}(owner )?capital/);
    });

    it("states the overdraw fires even when the pooled three-way SUM ties out", function () {
      expect(flatLower).to.match(/even when.{0,40}sum ties|pooled three-?way sum ties|ties out/);
      expect(flatLower).to.match(/out of trust/);
    });
  });

  it("restates the DRAFT / NOT-LEGAL-ADVICE posture VERBATIM (the canonical blockquote, still appearing ≥ twice)", function () {
    // The canonical posture blockquote lives in the policy section; documenting the
    // owner-overdraw rule must NOT have dropped or reworded it. Pull the canonical
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
    // Documenting the owner-overdraw rule must not have weakened the standing
    // custodian posture.
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

  it("the documented behaviour is the behaviour the engine runs: an over-capital owner draw FAILs even when the pooled SUM ties", function () {
    // Prove the doc's central claim against LIVE engine behaviour. The owner account
    // contributes $1,000 of its OWN capital (C) and draws $1,500 (D) — so $500 of the
    // draw is paid out of OTHER beneficiaries' trust money. We model the owner's
    // negative bucket so the pooled three-way SUM still TIES to the book, exactly the
    // "the owner's negative control bucket can absorb the overdraw so tiesOut stays
    // true, yet the account is out of trust" scenario the doc describes.
    //
    // Book: +$1,000 owner contribution, +$2,000 rent in, -$1,500 owner draw  => book == 1500.
    // Bank mirrors the same net so adjusted bank == book.
    // Sub-ledger: tenant A holds +$2,000 (the rent), owner bucket holds -$500
    //   (contributed 1000, drew 1500). SUM == 2000 - 500 == 1500 == book: pooled TIE.
    const book = [
      {
        date: "2026-05-01",
        amount: 100000,
        memo: "Owner contribution",
        party: "Owner Acme",
        source: "quickbooks",
      },
      {
        date: "2026-05-02",
        amount: 200000,
        memo: "Rent receipts",
        source: "quickbooks",
        kind: "rent",
      },
      {
        date: "2026-05-03",
        amount: -150000,
        memo: "Check #1042 owner draw - Acme",
        party: "Owner Acme",
        type: "check",
        source: "quickbooks",
      },
    ];
    // Net book movement = 100000 + 200000 - 150000 = 150000. Bank mirrors net.
    const bank = [
      { date: "2026-05-01", amount: 100000, memo: "Owner contribution", source: "bank" },
      { date: "2026-05-02", amount: 200000, memo: "Rent receipts", source: "bank" },
      {
        date: "2026-05-03",
        amount: -150000,
        memo: "Check #1042 owner draw - Acme",
        type: "check",
        source: "bank",
      },
    ];
    const sub = { "Tenant A": 200000, "Owner Acme": -50000 };
    expect(
      Object.values(sub).reduce((a, b) => a + b, 0),
      "the pooled sub-ledger SUM ties to the $1,500 book"
    ).to.equal(150000);

    const r = reconcile.reconcile(bank, book, sub);

    // The pooled book == sub-ledger SUM equality holds (no SUBLEDGER_OUT_OF_BALANCE).
    const pooled = r.exceptions.filter(
      (e) => e.type === reconcile.EXCEPTION.SUBLEDGER_OUT_OF_BALANCE
    );
    expect(pooled, "the pooled SUM ties — no subledger_out_of_balance finding").to.have.length(0);

    // Yet the over-capital owner draw is flagged as an out-of-trust ERROR for the EXCESS.
    const over = r.exceptions.filter((e) => e.type === reconcile.EXCEPTION.OWNER_OVERDRAW);
    expect(over, "exactly one owner_overdraw finding (the over-capital account)").to.have.length(1);
    expect(over[0].severity, "owner_overdraw is ERROR").to.equal(reconcile.SEVERITY.ERROR);
    expect(over[0].amount, "the flagged amount is the $500 excess (tenant money)").to.equal(50000);

    // And the benign part is still surfaced as the owner_draw WARNING (not escalated).
    const draw = r.exceptions.filter((e) => e.type === reconcile.EXCEPTION.OWNER_DRAW);
    expect(draw.length, "the owner_draw WARNING is also surfaced").to.be.greaterThan(0);
    expect(draw[0].severity, "owner_draw stays a WARNING").to.equal(reconcile.SEVERITY.WARNING);
  });
});

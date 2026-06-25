"use strict";

// ---------------------------------------------------------------------------
// T-43.3 docs-rot guard for the FAIL-triage / "what to fix first" layer in
// docs/TRUSTLEDGER.md — framed as the pilot's first-contact legibility, tied to
// the honest custodian/CPA/DRAFT posture.
//
// EPIC-43 added a NEW, strictly-additive legibility capability: a bare FAIL is a
// COUNT, not a CAUSE, so `trustledger/reconcile.js` › `triage` partitions every
// classified finding into one of FOUR root-cause classes (out_of_trust /
// data_completeness / needs_review / timing), rolls each up by dollar impact, and
// emits ONE headline naming the single highest-priority thing to fix — leading
// with the make-or-break out-of-trust-vs-fix-my-data distinction. T-43.2 surfaces
// that headline as a SECOND CLI line + a `triage` object in `--json` + an HTML
// "Fix first" callout WITHOUT changing the verdict, severities, counts, or exit
// code. T-43.3 (this task) documents that layer.
//
// Load-bearing properties under test (the acceptance criteria):
//   * the doc documents the FAIL-triage layer: the FOUR classes, the headline
//     PRIORITY, and the out-of-trust-vs-fix-my-data distinction;
//   * it states the triage EXPLAINS but does NOT change the verdict (additive:
//     no balance/tiesOut/severity/count/PASS-FAIL/exit-code change);
//   * it restates the custodian / CPA / DRAFT posture VERBATIM (the canonical
//     DRAFT/NOT-LEGAL-ADVICE blockquote, and the top-of-doc custodian framing);
//   * it adds NO new `needs-human` item and does NOT alter the closed
//     P-3/P-5/P-6/P-7/P-8 proposal-id set.
//
// The guard imports trustledger/reconcile.js + report.js so it fails loudly if
// the triage surface (the function, the four class enum values, the report
// headline helper) is ever removed — an otherwise-hollow docs guard — and runs
// the engine to prove the documented behaviour is the behaviour the code runs.
// PURE: it only reads files and runs the in-memory reconciler; it writes nothing
// and the cwd is untouched.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const reconcile = require("../trustledger/reconcile");
const report = require("../trustledger/report");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

describe("T-43.3 docs: the FAIL-triage / what-to-fix-first layer (docs/TRUSTLEDGER.md)", function () {
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

  it("the engine still exports the triage surface this guard pins against (tripwire)", function () {
    // If the triage function / its four root-cause classes / the report headline
    // helper are removed or renamed, the documented layer would be meaningless —
    // fail loudly rather than guard hollow prose.
    expect(typeof reconcile.triage, "reconcile.triage is a function").to.equal("function");
    expect(typeof report.triageHeadline, "report.triageHeadline is a function").to.equal(
      "function"
    );
    expect(reconcile.ROOT_CAUSE_CLASS, "ROOT_CAUSE_CLASS enum present").to.be.an("object");
    expect(reconcile.ROOT_CAUSE_CLASS.OUT_OF_TRUST).to.equal("out_of_trust");
    expect(reconcile.ROOT_CAUSE_CLASS.DATA_COMPLETENESS).to.equal("data_completeness");
    expect(reconcile.ROOT_CAUSE_CLASS.NEEDS_REVIEW).to.equal("needs_review");
    expect(reconcile.ROOT_CAUSE_CLASS.TIMING).to.equal("timing");
  });

  describe("the FAIL-triage section documents the layer", function () {
    let section, sectionLower, flatLower;
    before(function () {
      // The dedicated section header. Match loosely on "triage" + "fix first" so a
      // small header reword does not silently drop the guard.
      const start = docLower.indexOf("## fail triage");
      expect(start, "a '## FAIL triage' section is present").to.be.greaterThan(-1);
      const rest = doc.slice(start);
      const end = rest.indexOf("\n## ", 3);
      section = end === -1 ? rest : rest.slice(0, end);
      sectionLower = section.toLowerCase();
      // The prose is hard-wrapped; collapse whitespace so phrase matches survive a
      // line break landing mid-phrase.
      flatLower = section.replace(/\s+/g, " ").toLowerCase();
    });

    it("frames it as the pilot's FIRST-CONTACT legibility (a count is not a cause)", function () {
      expect(flatLower).to.match(/first[- ]contact/);
      expect(flatLower).to.match(/what to fix first|fix first/);
      expect(flatLower).to.match(/count, not a cause|count.{0,20}not.{0,20}cause/);
      // Tie it to the design-partner pilot (P-5 #3) framing.
      expect(flatLower).to.match(/pilot/);
    });

    it("documents ALL FOUR root-cause classes by name", function () {
      for (const cls of [
        "out_of_trust",
        "data_completeness",
        "needs_review",
        "timing",
      ]) {
        expect(section, `class ${cls} named in the section`).to.include(cls);
      }
      // And the engine's four enum values are exactly these four — pin the doc to
      // the code so a class added/renamed in the engine forces a doc update.
      const engineClasses = Object.values(reconcile.ROOT_CAUSE_CLASS).sort();
      expect(engineClasses, "the engine still has exactly these four classes").to.deep.equal([
        "data_completeness",
        "needs_review",
        "out_of_trust",
        "timing",
      ]);
    });

    it("documents the HEADLINE PRIORITY (out_of_trust first, then data_completeness, …)", function () {
      // The fixed priority order the headline uses.
      expect(flatLower).to.match(/priority/);
      // out_of_trust leads even when data gaps also exist.
      expect(flatLower).to.match(
        /out of trust.{0,80}(lead|first|priority)|leads with .{0,20}out of trust/
      );
      // The order is the CLASS_RANK order — out_of_trust → data_completeness → …
      const i1 = flatLower.indexOf("out_of_trust");
      const i2 = flatLower.indexOf("data_completeness");
      const i3 = flatLower.indexOf("needs_review");
      const i4 = flatLower.indexOf("timing");
      expect(i1, "out_of_trust appears").to.be.greaterThan(-1);
      // The priority sentence orders the classes most-urgent-first. The class names
      // are code-spanned (backticks) and separated by an arrow (→ / ->) or "then",
      // so allow those between each name.
      const sep = "[`\\s]*(?:→|->|then|,)?[`\\s]*";
      const orderRe = new RegExp(
        `out_of_trust${sep}data_completeness${sep}needs_review${sep}timing`
      );
      expect(flatLower).to.match(orderRe);
      expect([i1, i2, i3, i4].every((x) => x > -1)).to.equal(true);
    });

    it("documents the make-or-break OUT-OF-TRUST vs FIX-MY-DATA distinction", function () {
      // The whole point: a FAIL is "fix the trust account" OR "fix the data and
      // re-run" — never blurred.
      expect(flatLower).to.match(/out of trust/);
      expect(flatLower).to.match(/fix your data|fix the data|fix-my-data/);
      // Data-completeness is explicitly NOT (yet) an out-of-trust claim.
      expect(flatLower).to.match(
        /not.{0,30}shown out of trust|not \(yet\) evidence the money is gone|not.{0,20}out-of-trust claim/
      );
      // And it must say it is a fixable data-shape gap to fix and re-run.
      expect(flatLower).to.match(/re-?run/);
    });

    it("states triage EXPLAINS the verdict but does NOT change it (strictly additive)", function () {
      expect(flatLower).to.match(/does not change (it|the verdict)|changes no verdict|does not change/);
      expect(flatLower).to.match(/additive/);
      // It changes no severity / count / PASS-FAIL / exit code.
      expect(flatLower).to.match(/severity/);
      expect(flatLower).to.match(/exit code/);
      expect(flatLower).to.match(/pass\/fail|pass.?fail/);
      // The explicit "explains, not decides" framing.
      expect(flatLower).to.match(
        /explain.{0,40}does not (change|decide)|what to fix first.{0,40}never decides|explains the verdict/
      );
    });

    it("pins the engine functions so the doc can't drift from the code", function () {
      expect(section).to.include("trustledger/reconcile.js");
      expect(section).to.include("triage");
      expect(section).to.include("triageHeadline");
    });
  });

  it("restates the DRAFT / NOT-LEGAL-ADVICE posture VERBATIM (the canonical blockquote, still appearing ≥ twice)", function () {
    // The canonical posture blockquote lives in the policy section; documenting the
    // triage layer must restate it verbatim and must NOT have dropped or reworded an
    // existing copy. Pull the canonical block and assert it still appears more than
    // once (so this task did not become the only copy nor strip an existing one).
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

  it("the FAIL-triage section itself restates the custodian/CPA/DRAFT posture", function () {
    const start = docLower.indexOf("## fail triage");
    const rest = doc.slice(start);
    const end = rest.indexOf("\n## ", 3);
    const section = end === -1 ? rest : rest.slice(0, end);
    const sectionLower = section.toLowerCase();
    // The triage section must carry the canonical DRAFT block VERBATIM (so a reader
    // of just this layer sees the posture, not a reworded paraphrase).
    expect(section).to.include(
      "> **DRAFT / NOT LEGAL ADVICE.** The policies that SHIP with TrustLedger"
    );
    // … and restate the custodian / CPA / aids-not-certifies framing in-section.
    expect(sectionLower).to.match(/legal trust-account custodian|responsible.{0,20}custodian|legal.{0,10}custodian/);
    expect(sectionLower).to.match(/qualified cpa|cpa must still review|cpa\b/);
    expect(sectionLower).to.match(/aids\s+reconciliation|pass does not certify/);
  });

  it("keeps the top-of-doc 'aids reconciliation, not a certificate' custodian framing", function () {
    // Documenting triage must not have weakened the standing custodian posture.
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

  it("the documented headline behaviour is the behaviour the engine runs: out_of_trust LEADS even with a data gap", function () {
    // Prove the doc's central claim against LIVE engine behaviour. A model with BOTH
    // an out_of_trust finding (a negative individual ledger) AND a data_completeness
    // gap (an unreconciled bank line) must triage to an OUT-OF-TRUST headline — the
    // out-of-trust finding is the priority, never softened into a mere data note.
    const t = reconcile.triage({
      exceptions: [
        {
          type: reconcile.EXCEPTION.NEGATIVE_TENANT_LEDGER,
          severity: reconcile.SEVERITY.ERROR,
          amount: -100000, // $1,000 out of trust
        },
        {
          type: reconcile.EXCEPTION.UNRECONCILED_BANK,
          severity: reconcile.SEVERITY.WARNING,
          amount: 25000, // $250 data-completeness gap
        },
      ],
    });
    expect(t.outOfTrust, "an out_of_trust finding is present").to.equal(true);
    expect(t.dataIncomplete, "a data_completeness gap is also present").to.equal(true);
    expect(t.topClass, "the top class to fix first is out_of_trust").to.equal(
      reconcile.ROOT_CAUSE_CLASS.OUT_OF_TRUST
    );
    expect(t.headline, "the headline LEADS with OUT OF TRUST").to.match(/^OUT OF TRUST:/);
    // The data gap is noted but explicitly secondary (the priority is the shortage).
    expect(t.headline).to.match(/priority/);
  });

  it("the documented headline behaviour is the behaviour the engine runs: a data-only gap says FIX YOUR DATA, NOT out of trust", function () {
    // The other side of the make-or-break distinction: with ONLY a data_completeness
    // gap and no out_of_trust finding, the headline must say the account is NOT shown
    // out of trust — exactly the "fix your data and re-run" framing the doc pins.
    const t = reconcile.triage({
      exceptions: [
        {
          type: reconcile.EXCEPTION.AMBIGUOUS_DEPOSIT,
          severity: reconcile.SEVERITY.WARNING,
          amount: 125000, // a $1,250 undetermined deposit
        },
      ],
    });
    expect(t.outOfTrust, "no out_of_trust finding").to.equal(false);
    expect(t.dataIncomplete, "a data_completeness gap is present").to.equal(true);
    expect(t.topClass).to.equal(reconcile.ROOT_CAUSE_CLASS.DATA_COMPLETENESS);
    expect(t.headline, "the headline leads with FIX YOUR DATA").to.match(/^FIX YOUR DATA:/);
    expect(t.headline, "it says NOT shown out of trust").to.match(/NOT shown out of trust/);
    expect(t.headline, "it says re-run, not (yet) evidence the money is gone").to.match(
      /re-run|not \(yet\) evidence the money is gone/
    );
    // report.triageHeadline simply prefixes the engine headline — proving the CLI/
    // packet second line is a pure read of the same triage, not a re-derivation.
    expect(report.triageHeadline({ triage: t })).to.equal(`Triage: ${t.headline}`);
  });
});

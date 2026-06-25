"use strict";

// ---------------------------------------------------------------------------
// T-39.3 docs-rot guard for the `ambiguous_deposit` control + the silent-false-pass
// hazard it closes.
//
// Pure (no chain, no CLI run, no filesystem writes): asserts docs/TRUSTLEDGER.md
// documents the NEW control the way the engine actually behaves, so the
// buyer-/handoff-facing prose can't silently drift from trustledger/reconcile.js.
// Load-bearing properties under test (the acceptance criteria):
//   * `ambiguous_deposit` is listed among the legal exception types (the
//     enum-derived severities/citations keys);
//   * a dedicated section explains WHY a keyword-only security-deposit detector
//     SILENTLY false-passes (an un-segregated deposit recorded without a
//     recognizable keyword slips through as a generic deposit and PASSes);
//   * it documents the WARNING default AND the explicit-label escape valve
//     (kind:"rent" / depositType / ambiguous:false / expected:true);
//   * it states grading it to ERROR is a per-state CPA decision routed through the
//     EXISTING policy layer (severities.ambiguous_deposit: "error"), and restates
//     the DRAFT / NOT-LEGAL-ADVICE posture VERBATIM (the same blockquote the
//     policy section carries);
//   * it adds NO new `needs-human` item and does NOT alter P-3/P-5/P-6/P-7/P-8.
//
// The guard imports trustledger/reconcile.js + policy.js so it fails loudly if the
// predicates/markers it pins against are ever removed — an otherwise-hollow docs
// guard. PURE: it only reads files and asserts strings; it writes nothing and the
// cwd is untouched.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const reconcile = require("../trustledger/reconcile");
const policy = require("../trustledger/policy");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

describe("T-39.3 docs: the ambiguous_deposit silent-false-pass control is documented (docs/TRUSTLEDGER.md)", function () {
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

  it("the engine still exports the surface this guard pins against (tripwire)", function () {
    // If these are removed/renamed, the documented control would be meaningless.
    expect(reconcile.isAmbiguousDeposit, "isAmbiguousDeposit").to.be.a("function");
    expect(reconcile.EXCEPTION.AMBIGUOUS_DEPOSIT, "EXCEPTION.AMBIGUOUS_DEPOSIT").to.equal(
      "ambiguous_deposit"
    );
    expect(
      reconcile.DEFAULT_SEVERITY[reconcile.EXCEPTION.AMBIGUOUS_DEPOSIT],
      "default severity is WARNING"
    ).to.equal(reconcile.SEVERITY.WARNING);
    // The type is an enum-derived legal policy key (re-grade-able per state).
    expect(
      policy.EXCEPTION_TYPES.has(reconcile.EXCEPTION.AMBIGUOUS_DEPOSIT),
      "ambiguous_deposit is a legal exception type"
    ).to.equal(true);
  });

  it("lists ambiguous_deposit among the legal exception types (the policy severities/citations keys)", function () {
    const start = docLower.indexOf("the **legal exception types**");
    expect(start, "legal exception types block present").to.be.greaterThan(-1);
    // The fenced enum list that immediately follows must name the live type.
    const block = doc.slice(start, start + 1200);
    expect(block).to.include("ambiguous_deposit");
  });

  describe("the dedicated '### Why ambiguous_deposit exists: the silent-false-pass hazard' section", function () {
    let section, sectionLower, flat, flatLower;
    before(function () {
      const start = docLower.indexOf("### why `ambiguous_deposit` exists");
      expect(start, "silent-false-pass section present").to.be.greaterThan(-1);
      const rest = doc.slice(start);
      // Bound the section at the next ## or ### heading.
      const end = rest.indexOf("\n### ", 5);
      const end2 = rest.indexOf("\n## ", 5);
      const cut = [end, end2].filter((n) => n !== -1).sort((a, b) => a - b)[0];
      section = cut === undefined ? rest : rest.slice(0, cut);
      sectionLower = section.toLowerCase();
      // The prose is hard-wrapped; collapse runs of whitespace so phrase matches
      // are not defeated by a line break landing mid-phrase.
      flat = section.replace(/\s+/g, " ");
      flatLower = flat.toLowerCase();
    });

    it("names the silent-false-pass hazard explicitly", function () {
      expect(flatLower).to.match(/silent false pass|silent-false-pass/);
    });

    it("explains WHY a keyword-only security-deposit detector false-passes", function () {
      // The detector relies ONLY on a keyword match ...
      expect(flatLower).to.match(/keyword.?only/);
      expect(flatLower).to.match(/security[- ]deposit detector|security deposit detector|segregation check/);
      // ... so an un-segregated deposit recorded WITHOUT the keyword slips through.
      expect(flatLower).to.match(/un-segregated|unsegregated/);
      expect(flatLower).to.match(/generic deposit|bare .*deposit|mislabel/);
      // ... and the gate PASSes anyway (the dangerous part).
      expect(flat).to.match(/PASS/);
    });

    it("names the predicate and that a security-deposit row is NOT double-counted", function () {
      expect(section).to.include("isAmbiguousDeposit");
      expect(flatLower).to.match(/double-count|double count|not.*re-flagged|re-flagged.*not/);
    });

    it("documents the WARNING default and that it does NOT over-FAIL a tying account", function () {
      expect(flatLower).to.match(/default severity is `?warning`?|`?warning`?,? not `?error`?/);
      expect(flatLower).to.match(/does not.*fail|not over-failed|still passes/);
    });

    it("documents the explicit-label escape valve (every honored marker)", function () {
      expect(flatLower).to.match(/escape valve/);
      expect(flatLower).to.match(/explicit.*label|label.*suppress/);
      // Every one of the four markers isAmbiguousDeposit honors must be named.
      expect(section).to.match(/kind:?\s*"?rent"?|`kind: "rent"`/);
      expect(section).to.include("depositType");
      expect(section).to.match(/ambiguous:?\s*false|`ambiguous: false`/);
      expect(section).to.match(/expected:?\s*true|`expected: true`/);
    });

    it("the documented markers are EXACTLY what the engine honors (no drift)", function () {
      // Prove the four documented markers actually suppress the finding, and that a
      // genuinely-unlabeled row is still flagged — so the doc can't claim a marker
      // the code does not honor (or omit one it does).
      const base = {
        date: "2026-05-01",
        amount: 120000,
        memo: "Deposit - 12B Smith",
        kind: "deposit",
        party: "Smith (12B)",
        source: "quickbooks",
      };
      // Unlabeled => flagged (the hazard).
      expect(reconcile.isAmbiguousDeposit(base), "unlabeled is flagged").to.equal(true);
      // Each documented marker suppresses it.
      expect(
        reconcile.isAmbiguousDeposit({ ...base, kind: "rent" }),
        'kind "rent" suppresses'
      ).to.equal(false);
      expect(
        reconcile.isAmbiguousDeposit({ ...base, depositType: "rent" }),
        "depositType suppresses"
      ).to.equal(false);
      expect(
        reconcile.isAmbiguousDeposit({ ...base, ambiguous: false }),
        "ambiguous:false suppresses"
      ).to.equal(false);
      expect(
        reconcile.isAmbiguousDeposit({ ...base, expected: true }),
        "expected:true suppresses"
      ).to.equal(false);
    });

    it("states grading it to ERROR is a per-state CPA decision via the EXISTING policy layer", function () {
      expect(flatLower).to.match(/per-state/);
      expect(flatLower).to.match(/cpa/);
      // The exact override mechanism that the engine already consumes.
      expect(section).to.include('severities.ambiguous_deposit: "error"');
      expect(flatLower).to.match(/existing policy layer|same.*policy layer|policy layer/);
      // No engine change required.
      expect(flatLower).to.match(/no engine change/);
      // A same-files PASS -> FAIL flip, exit 0 -> 3.
      expect(flat).to.match(/PASS *(→|->|to) *FAIL|PASS.*FAIL/);
      expect(flat).to.match(/`?0`? *(→|->|to) *`?3`?/);
    });

    it("names the bundled illustrative fixture (the demonstrating-not-real-jurisdiction escalation)", function () {
      expect(section).to.include("ambiguous-deposit-example");
      expect(section).to.match(/PLACEHOLDER/);
      expect(flatLower).to.match(/illustrative|not a real jurisdiction/);
    });

    it("restates the DRAFT / NOT-LEGAL-ADVICE posture VERBATIM", function () {
      // The canonical posture blockquote lives once in the policy section; this
      // section must reproduce it verbatim so the control inherits the caveat and
      // the two can't drift. Pull the canonical block and assert it appears again.
      const canonical =
        "> **DRAFT / NOT LEGAL ADVICE.** The policies that SHIP with TrustLedger\n" +
        "> (`trustledger/fixtures/policy/*.json`) are **DRAFT skeletons**, not legal advice and **not a claim of\n" +
        "> regulatory compliance**. The baseline reproduces the built-in defaults verbatim; the example state\n" +
        "> file carries a **PLACEHOLDER** citation. A qualified **CPA and/or counsel must review and SIGN** the\n" +
        "> per-state severity mapping and its statute citations for the actual jurisdiction before the gate is\n" +
        "> relied on. Selecting a policy does **not** make a packet legal advice and does **not** discharge the\n" +
        "> broker's duty as the responsible legal custodian of trust funds. (STRATEGY.md › P-5 #1/#2.)";
      // It appears at least twice in the doc (the policy section + this section).
      const occurrences = doc.split(canonical).length - 1;
      expect(occurrences, "DRAFT/NOT-LEGAL-ADVICE posture restated verbatim").to.be.greaterThan(1);
      // And specifically inside THIS section.
      expect(section).to.include(canonical);
    });

    it("ties the per-state grading to the EXISTING P-5 #2 handoff and adds NO new needs-human item", function () {
      expect(section).to.match(/P-5/);
      expect(flatLower).to.match(/no new `?needs-human`? item|no new needs-human/);
    });
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

"use strict";

// ---------------------------------------------------------------------------
// T-44.3 docs-rot guard: the out-of-trust CORPUS documented in
// docs/TRUSTLEDGER.md as the CPA/broker correctness-review ARTIFACT, with P-5 #1
// and the P-8 pilot runbook (docs/PILOT.md) pointed at it.
//
// EPIC-44 shipped a committed out-of-trust corpus (T-44.1) + the one read-only
// command a CPA or broker RUNS to confirm the gate is correct WITHOUT reading
// test/ (`vh trust corpus`, T-44.2). The single defensible, monetizable claim
// TrustLedger makes is its CORRECTNESS — "a FAIL means genuinely out of trust" —
// but that claim lived only in test/, invisible to the CPA who signs the
// disclaimer (P-5 #1) and the broker deciding to pay (P-8), neither of whom reads
// test/. T-44.3 (this task) DOCUMENTS the corpus as that correctness-review
// artifact and re-frames the human review from "trust our disclaimer" to "run
// this to confirm the gate is correct" — WITHOUT changing the still-DRAFT /
// NOT-LEGAL-ADVICE / custodian-remains-responsible posture, and WITHOUT adding a
// new human gate.
//
// Load-bearing properties under test (the acceptance criteria):
//   * docs/TRUSTLEDGER.md documents the corpus: each scenario + its trust-law
//     principle, how to RUN it (`vh trust corpus`), and the does/does-not-mean
//     boundary;
//   * the doc states the corpus CONFIRMS the gate's behaviour but does NOT
//     certify a jurisdiction or constitute legal advice;
//   * it restates the custodian / CPA / DRAFT posture VERBATIM (the canonical
//     DRAFT/NOT-LEGAL-ADVICE blockquote, and the top-of-doc custodian framing);
//   * P-5 #1 points the review at the corpus ("run this to confirm the gate is
//     correct" in place of "trust our disclaimer");
//   * docs/PILOT.md points a verify step at `vh trust corpus`;
//   * it adds NO new `needs-human` item and does NOT alter the closed
//     P-3/P-5/P-6/P-7/P-8 proposal-id set.
//
// The guard imports trustledger/corpus.js so it fails loudly if the runner is
// ever removed — an otherwise-hollow docs guard — and RUNS the committed corpus
// to prove the documented behaviour is the behaviour the code runs (every
// scenario matches: out-of-trust → FAIL, benign twin → PASS). PURE: it only
// reads files and runs the in-memory corpus runner; it writes nothing and the
// cwd is untouched.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const corpus = require("../trustledger/corpus");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// Flatten markdown prose for robust phrase matching: drop bold (`*`) markers and
// leading blockquote (`>`) continuation markers, collapse all whitespace, and
// lowercase — so a phrase split across a line break / a `**bold**` boundary / a
// blockquote line still matches as one contiguous string.
const flatten = (s) =>
  s
    .replace(/^[ \t]*>/gm, " ")
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();

// The canonical DRAFT / NOT-LEGAL-ADVICE posture blockquote — the single source
// of truth that the policy section carries and every layered-feature section
// must restate VERBATIM. Pinned byte-for-byte so a reword anywhere is caught.
const CANONICAL_DRAFT_BLOCK =
  "> **DRAFT / NOT LEGAL ADVICE.** The policies that SHIP with TrustLedger\n" +
  "> (`trustledger/fixtures/policy/*.json`) are **DRAFT skeletons**, not legal advice and **not a claim of\n" +
  "> regulatory compliance**. The baseline reproduces the built-in defaults verbatim; the example state\n" +
  "> file carries a **PLACEHOLDER** citation. A qualified **CPA and/or counsel must review and SIGN** the\n" +
  "> per-state severity mapping and its statute citations for the actual jurisdiction before the gate is\n" +
  "> relied on. Selecting a policy does **not** make a packet legal advice and does **not** discharge the\n" +
  "> broker's duty as the responsible legal custodian of trust funds. (STRATEGY.md › P-5 #1/#2.)";

describe("T-44.3 docs: the correctness corpus as the CPA/broker review artifact (docs/TRUSTLEDGER.md + docs/PILOT.md)", function () {
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

  it("the corpus runner this guard pins against still exists (tripwire)", function () {
    // If the corpus loader/runner is removed or renamed, the documented artifact
    // would be meaningless — fail loudly rather than guard hollow prose.
    expect(typeof corpus.runCorpus, "corpus.runCorpus is a function").to.equal("function");
    expect(typeof corpus.scenarioIds, "corpus.scenarioIds is a function").to.equal("function");
    expect(typeof corpus.runScenario, "corpus.runScenario is a function").to.equal("function");
    const ids = corpus.scenarioIds();
    expect(ids.length, "the committed corpus has scenarios").to.be.at.least(2);
  });

  describe("the dedicated corpus section documents the artifact", function () {
    let section, sectionLower, flatLower;
    before(function () {
      // Locate the dedicated section. Match loosely on "corpus" so a small header
      // reword does not silently drop the guard.
      const start = docLower.indexOf("## the correctness corpus");
      expect(start, "a '## The correctness corpus' section is present").to.be.greaterThan(-1);
      const rest = doc.slice(start);
      const end = rest.indexOf("\n## ", 3);
      section = end === -1 ? rest : rest.slice(0, end);
      sectionLower = section.toLowerCase();
      // The prose is hard-wrapped and uses markdown bold (`**`) + blockquote (`>`)
      // markers that can land mid-phrase. Strip those markers and collapse
      // whitespace so a phrase match survives a line break / a `**bold**` / a
      // blockquote continuation landing between two words.
      flatLower = flatten(section);
    });

    it("frames the corpus as the 'run this to confirm the gate is correct' artifact (not 'trust our disclaimer')", function () {
      expect(flatLower).to.match(/run this to confirm the gate is correct|confirm the gate is correct/);
      // The CPA who signs + the broker deciding to pay — who never read test/.
      expect(flatLower).to.match(/cpa/);
      expect(flatLower).to.match(/broker/);
      // The corpus is the answer to "the CPA + broker never read test/".
      expect(flatLower).to.match(/test\//);
      expect(flatLower).to.match(/will never read|never read\b|without reading test/);
      expect(flatLower).to.match(/correctness/);
    });

    it("documents HOW to run it: the `vh trust corpus` command + its exit-code gate", function () {
      expect(section).to.include("vh trust corpus");
      // The exit-code contract a pipeline / human reads: OK / DRIFT.
      expect(flatLower).to.match(/corpus ok/);
      expect(flatLower).to.match(/corpus drift/);
      // The same engine path the real reconcile exit uses (a faithful caller, not
      // a second engine) — pin the doc to the module.
      expect(section).to.include("trustledger/corpus.js");
      expect(flatLower).to.match(/same.{0,40}(engine|reconcile|verdict|buildpacket).{0,40}(path|exit)/);
      // --json so a pipeline can gate on the data.
      expect(section).to.include("--json");
    });

    it("documents EACH control as a matched out-of-trust / benign-twin pair, with its principle", function () {
      // The doc must name every control the corpus exercises. Derive the set of
      // controls FROM the live corpus so a control added/renamed in the fixtures
      // forces a doc update (the doc cannot drift from the committed corpus).
      const ids = corpus.scenarioIds();
      const controls = new Set();
      for (const id of ids) {
        const meta = JSON.parse(
          read(path.join("trustledger", "fixtures", "corpus", id, "meta.json"))
        );
        controls.add(meta.control);
      }
      // Sanity: the corpus exercises the canonical out-of-trust controls.
      expect(controls.size, "several distinct controls").to.be.at.least(5);
      for (const control of controls) {
        expect(section, `control ${control} named in the corpus section`).to.include(control);
      }
      // Both directions of each pair are documented: it FAILs the fraud AND PASSes
      // the benign twin (so it does not over-FAIL the innocent look-alike).
      expect(flatLower).to.match(/benign.{0,8}twin/);
      expect(flatLower).to.match(/out-of-trust|out of trust/);
      expect(flatLower).to.match(/→ fail|->\s*fail|fails? (the|each)/);
      expect(flatLower).to.match(/→ pass|->\s*pass|passes? (the|each|its)/);
    });

    it("documents the silent-false-pass cases (pooled SUM ties yet out of trust)", function () {
      // The corpus's sharpest claim: three cases tie the pooled SUM perfectly yet
      // are out of trust for an individual beneficiary — a naive total would PASS.
      expect(flatLower).to.match(/silent.{0,8}false.{0,8}pass/);
      expect(flatLower).to.match(/pooled sum ties|sum ties|tie.{0,10}pooled|regardless of the pooled tie/);
    });

    it("states the corpus CONFIRMS the gate's behaviour but does NOT certify a jurisdiction or constitute legal advice", function () {
      // The precise does/does-not-mean boundary the task requires.
      expect(flatLower).to.match(/confirms the gate|confirm.{0,20}gate.{0,20}correct|gate's behaviour/);
      expect(flatLower).to.match(/does not certify (a |any )?jurisdiction|not certify a jurisdiction/);
      expect(flatLower).to.match(/(not|does not).{0,40}(constitute|legal advice)/);
      // It is correctness of the TOOL'S GATE, not compliance of a particular account.
      expect(flatLower).to.match(/not.{0,30}(compliant|compliance)|does not audit|pass does not certify/);
    });

    it("restates the custodian / CPA / aids-not-certifies posture IN-SECTION", function () {
      // Use the marker-stripped flat form: the posture sentence wraps across lines
      // and uses `**bold**` markers (e.g. "TrustLedger **aids** reconciliation").
      expect(flatLower).to.match(/responsible (legal )?(trust-account )?custodian|legal custodian/);
      expect(flatLower).to.match(/qualified cpa|cpa must still review|cpa\b/);
      expect(flatLower).to.match(/aids\s+reconciliation|pass does not certify/);
    });

    it("carries the canonical DRAFT / NOT-LEGAL-ADVICE blockquote VERBATIM in-section", function () {
      expect(section).to.include(CANONICAL_DRAFT_BLOCK);
    });

    it("adds NO new human gate: corpus only asserts the EXISTING verdict, no new `needs-human`", function () {
      // The corpus can only confirm the existing verdict; a failing case is a BUG
      // to fix, never a corpus to weaken — and there is no new needs-human item.
      expect(flatLower).to.match(/bug to fix|never a corpus to weaken|only ever asserts the existing verdict|existing verdict/);
      expect(flatLower).to.match(/no.{0,10}new.{0,10}`?needs-human`?|no new needs-human/);
    });
  });

  it("P-5 #1 points the human review at `vh trust corpus` (run-this-to-confirm in place of trust-the-disclaimer)", function () {
    // The 'What stays a human step' section's P-5 #1 bullet must re-frame the
    // CPA/counsel review around the corpus.
    const start = docLower.indexOf("## what stays a human step");
    expect(start, "a '## What stays a human step' section is present").to.be.greaterThan(-1);
    const rest = doc.slice(start);
    const end = rest.indexOf("\n## ", 3);
    const section = end === -1 ? rest : rest.slice(0, end);
    const flatLower = section.replace(/\s+/g, " ").toLowerCase();
    // The P-5 #1 bullet still exists and now names the corpus command + framing.
    expect(flatLower).to.match(/p-5 #1/);
    expect(section).to.include("vh trust corpus");
    expect(flatLower).to.match(/run this to confirm the gate is correct|confirm the gate is correct/);
    expect(flatLower).to.match(/trust (our|the) disclaimer/);
    // …while keeping the explicit "PASS does not imply legal compliance" framing.
    expect(flatLower).to.match(/pass does\s+not imply legal compliance|does not imply legal compliance/);
    // …and stating the corpus does not itself certify a jurisdiction / give advice.
    expect(flatLower).to.match(/not.{0,30}(certify a jurisdiction|constitute legal advice)/);
  });

  it("keeps the top-of-doc 'aids reconciliation, not a certificate' custodian framing", function () {
    // Documenting the corpus must not have weakened the standing custodian posture.
    expect(docLower).to.match(/responsible (legal )?custodian|legal custodian/);
    expect(docLower).to.match(/qualified cpa|cpa or your state regulator|cpa\/counsel|cpa and\/or counsel/);
    expect(docLower).to.match(/a pass does not certify legal compliance|aids\s+reconciliation|tool that aids/);
  });

  it("the canonical DRAFT/NOT-LEGAL-ADVICE posture still appears verbatim ≥ twice (not the only copy, not stripped)", function () {
    const occurrences = doc.split(CANONICAL_DRAFT_BLOCK).length - 1;
    expect(occurrences, "DRAFT/NOT-LEGAL-ADVICE posture present verbatim ≥ twice").to.be.greaterThan(1);
  });

  it("adds NO new `needs-human` proposal id beyond the existing P-3/P-5/P-6/P-7/P-8 set", function () {
    const ids = new Set((doc.match(/\bP-\d+\b/g) || []));
    const allowed = new Set(["P-3", "P-5", "P-6", "P-7", "P-8"]);
    for (const id of ids) {
      expect(allowed.has(id), `proposal id ${id} is within the existing P-3/P-5/P-6/P-7/P-8 set`).to.equal(
        true
      );
    }
  });

  describe("docs/PILOT.md points the verify step at `vh trust corpus`", function () {
    let pilot, pilotLower, flatLower;
    before(function () {
      pilot = read("docs/PILOT.md");
      pilotLower = pilot.toLowerCase();
      flatLower = flatten(pilot);
    });

    it("names `vh trust corpus` as a verify step, framed run-this-not-trust-disclaimer", function () {
      expect(pilot).to.include("vh trust corpus");
      // It is a VERIFY/CONFIRM step (the runbook's §3 is "what each artifact proves
      // and where you independently verify it").
      expect(flatLower).to.match(/confirm.{0,30}gate.{0,20}(is )?correct|gate (is )?correct/);
      expect(flatLower).to.match(/in place of trusting (our|the) disclaimer|trust (our|the) disclaimer/);
    });

    it("states the corpus confirms the gate but does NOT certify a jurisdiction / give legal advice", function () {
      expect(flatLower).to.match(/confirms the gate|confirm.{0,20}gate/);
      expect(flatLower).to.match(/does not certify a jurisdiction|not certify a jurisdiction/);
      expect(flatLower).to.match(/(not|does not).{0,40}(constitute legal advice|legal advice)/);
      // Keeps the standing TrustLedger pilot posture: PASS is not legal compliance,
      // broker remains the responsible custodian, CPA-reviewed under P-5.
      expect(flatLower).to.match(/pass does\s+not imply legal compliance|does not imply legal compliance/);
      expect(flatLower).to.match(/responsible (legal )?custodian|legal custodian/);
      expect(flatLower).to.match(/\bp-5\b/);
    });

    it("does NOT introduce a new proposal id beyond the existing P-3/P-5/P-6/P-7/P-8 set", function () {
      const ids = new Set((pilot.match(/\bP-\d+\b/g) || []));
      const allowed = new Set(["P-3", "P-5", "P-6", "P-7", "P-8"]);
      for (const id of ids) {
        expect(allowed.has(id), `proposal id ${id} is within the existing set`).to.equal(true);
      }
    });
  });

  it("the documented behaviour is the behaviour the engine runs: the committed corpus is all-OK (out-of-trust→FAIL, benign→PASS)", function () {
    // Prove the doc's central claim against LIVE engine behaviour. Running the
    // committed corpus through the REAL reconcile + buildPacket verdict path must
    // match every recorded verdict, and every '--out-of-trust' scenario must FAIL
    // while its benign twin PASSes — exactly what the doc says the CPA will see.
    const result = corpus.runCorpus();
    expect(result.ok, "the committed corpus is all-OK").to.equal(true);
    expect(result.mismatched, "no scenario drifts from its recorded verdict").to.equal(0);
    expect(result.total, "the corpus has the documented scenario count").to.equal(result.matched);

    let sawOutOfTrustFail = false;
    let sawBenignPass = false;
    for (const row of result.rows) {
      expect(row.match, `${row.id} matches its recorded verdict`).to.equal(true);
      if (row.id.endsWith("--out-of-trust")) {
        expect(row.actual, `${row.id} FAILs`).to.equal("FAIL");
        sawOutOfTrustFail = true;
      }
      if (row.id.endsWith("--benign-twin")) {
        expect(row.actual, `${row.id} PASSes`).to.equal("PASS");
        sawBenignPass = true;
      }
    }
    expect(sawOutOfTrustFail, "at least one out-of-trust scenario FAILs").to.equal(true);
    expect(sawBenignPass, "at least one benign twin PASSes").to.equal(true);
  });
});

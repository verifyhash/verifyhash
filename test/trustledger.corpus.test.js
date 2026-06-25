"use strict";

// TrustLedger — corpus test (T-44.1).
//
// The COMMITTED OUT-OF-TRUST CORPUS: for every ERROR-class control the engine
// claims to catch, a canonical OUT-OF-TRUST scenario (must FAIL) paired with a
// benign NEAR-TWIN (must PASS) — committed as fixtures under
// trustledger/fixtures/corpus/, each folder carrying a meta.json that names the
// control, the expected verdict, the expected finding, and the trust-law
// principle. This test drives EVERY corpus folder through the REAL
// reconcile + buildPacket path (the SAME path the CLI/--json verdict uses) and
// asserts the recorded verdict against the LIVE engine output.
//
// WHY THIS EXISTS (STRATEGY.md EPIC-44). The product's single defensible,
// monetizable claim is its CORRECTNESS — "a FAIL means the trust account is
// genuinely out of trust." That correctness is proven only inside test/, which
// the two humans who gate the money (the CPA who signs off, the broker who pays)
// will never read. This corpus is the human-RUNNABLE, human-READABLE evidence:
// a labeled scenario per fraud, annotated with the trust-law principle and the
// expected verdict, that anyone can run to confirm the gate FAILs the exact
// frauds it claims to catch — and PASSes the benign look-alikes.
//
// THE CORPUS ONLY ASSERTS EXISTING BEHAVIOR. It changes NO engine code, NO
// severity, NO verdict logic. If a case does not behave as its meta claims, that
// is a BUG to fix in the engine (under EPIC-39..42), never a corpus weakening:
// the test reads the meta's expectedVerdict/expectedFinding and asserts them
// against the LIVE buildPacket output, so the corpus can only ever pin down what
// the engine actually does.

const fs = require("fs");
const path = require("path");
const { expect } = require("chai");

const report = require("../trustledger/report");
const { EXCEPTION, SEVERITY } = require("../trustledger/reconcile");

const CORPUS_DIR = path.join(__dirname, "..", "trustledger", "fixtures", "corpus");

// ---------------------------------------------------------------------------
// Helpers — discover the corpus + drive one scenario through the REAL engine.
// ---------------------------------------------------------------------------

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Every scenario folder under the corpus root. A leading-underscore folder
// (_shared) holds shared artifacts (e.g. a prior-close), not a scenario.
function corpusScenarios() {
  return fs
    .readdirSync(CORPUS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name)
    .sort();
}

// Drive ONE corpus folder through the REAL reconcile + buildPacket path — the
// SAME path the CLI verdict / --json output uses — and return the live model.
// The inputs.json carries already-normalized record arrays (the shape ingest.js
// produces) plus optional opening / policy / toleranceCents / a priorClosePath
// (resolved relative to the corpus root, read as the raw close JSON buildPacket
// re-validates). No engine code is touched: this is a faithful caller.
function runScenario(folder) {
  const dir = path.join(CORPUS_DIR, folder);
  const inputs = loadJSON(path.join(dir, "inputs.json"));

  const args = {
    bank: inputs.bank,
    book: inputs.book,
    rentroll: inputs.rentroll,
    reportDate: inputs.reportDate,
    period: inputs.period,
  };
  if (inputs.opening) args.opening = inputs.opening;
  if (inputs.policy) args.policy = inputs.policy;
  if (inputs.toleranceCents !== undefined) {
    args.toleranceCents = inputs.toleranceCents;
  }
  if (inputs.priorClosePath) {
    // Read the prior close as the raw JSON string buildPacket accepts (it calls
    // close.readClose, which re-validates). Resolved relative to the corpus root.
    args.priorClose = fs.readFileSync(
      path.join(CORPUS_DIR, inputs.priorClosePath),
      "utf8"
    );
  }
  return report.buildPacket(args);
}

// ---------------------------------------------------------------------------
// The corpus is non-empty and well-formed.
// ---------------------------------------------------------------------------

describe("trustledger/corpus: the committed out-of-trust corpus is well-formed", function () {
  const scenarios = corpusScenarios();

  it("discovers at least one OUT-OF-TRUST/benign pair (the corpus is non-empty)", function () {
    expect(scenarios.length).to.be.at.least(2);
  });

  it("every scenario carries a complete, valid meta.json", function () {
    const VERDICTS = new Set(["PASS", "FAIL"]);
    // expectedFinding must name a real EXCEPTION type the engine can emit.
    const FINDING_TYPES = new Set(Object.values(EXCEPTION));
    for (const folder of scenarios) {
      const metaPath = path.join(CORPUS_DIR, folder, "meta.json");
      expect(fs.existsSync(metaPath), `${folder}/meta.json exists`).to.equal(true);
      const meta = loadJSON(metaPath);
      expect(meta.id, `${folder}.id`).to.equal(folder);
      expect(typeof meta.control, `${folder}.control`).to.equal("string");
      expect(meta.control, `${folder}.control non-empty`).to.not.equal("");
      expect(VERDICTS.has(meta.expectedVerdict), `${folder}.expectedVerdict`).to.equal(
        true
      );
      expect(
        FINDING_TYPES.has(meta.expectedFinding),
        `${folder}.expectedFinding "${meta.expectedFinding}" is a real EXCEPTION type`
      ).to.equal(true);
      expect(typeof meta.principle, `${folder}.principle`).to.equal("string");
      // The principle must be a real sentence, not a stub — it is the human-
      // readable trust-law annotation the CPA/broker reads.
      expect(meta.principle.length, `${folder}.principle is substantive`).to.be.at.least(
        40
      );
    }
  });

  it("each ERROR-class control has BOTH an out-of-trust scenario and a benign twin", function () {
    // Group folders by control; every control must carry >=1 FAIL and >=1 PASS,
    // so each control is proven by a canonical fraud AND its benign look-alike.
    const byControl = new Map();
    for (const folder of scenarios) {
      const meta = loadJSON(path.join(CORPUS_DIR, folder, "meta.json"));
      const g = byControl.get(meta.control) || { fail: 0, pass: 0 };
      if (meta.expectedVerdict === "FAIL") g.fail += 1;
      else g.pass += 1;
      byControl.set(meta.control, g);
    }
    expect(byControl.size, "at least one ERROR-class control").to.be.at.least(1);
    for (const [control, g] of byControl) {
      expect(g.fail, `${control} has an out-of-trust scenario`).to.be.at.least(1);
      expect(g.pass, `${control} has a benign twin`).to.be.at.least(1);
    }
  });
});

// ---------------------------------------------------------------------------
// The load-bearing assertion: each folder's meta verdict, against the LIVE
// engine output, through the REAL reconcile + buildPacket path.
// ---------------------------------------------------------------------------

describe("trustledger/corpus: every scenario behaves as its meta claims (live engine)", function () {
  for (const folder of corpusScenarios()) {
    const meta = loadJSON(path.join(CORPUS_DIR, folder, "meta.json"));
    const expectPass = meta.expectedVerdict === "PASS";

    it(`${folder}: ${meta.expectedVerdict} (control ${meta.control})`, function () {
      const model = runScenario(folder);

      // 1) The recorded verdict matches the live engine's PASS/FAIL.
      expect(
        model.pass,
        `${folder}: expected ${meta.expectedVerdict}, engine said ${
          model.pass ? "PASS" : "FAIL"
        }`
      ).to.equal(expectPass);

      // 2) The named finding is present (FAIL) or absent (PASS), at the
      //    error severity that drives the verdict via pass = ties && errors==0.
      const namedErrors = model.exceptions.filter(
        (e) => e.type === meta.expectedFinding && e.severity === SEVERITY.ERROR
      );
      if (expectPass) {
        // The benign twin must NOT raise the named out-of-trust finding.
        expect(
          namedErrors.length,
          `${folder}: benign twin must NOT raise an error-severity ${meta.expectedFinding}`
        ).to.equal(0);
        // A PASS packet carries zero error-severity findings at all.
        expect(model.counts.error, `${folder}: a PASS packet has no errors`).to.equal(0);
      } else {
        // The out-of-trust scenario must raise the named finding at error severity.
        expect(
          namedErrors.length,
          `${folder}: out-of-trust scenario must raise an error-severity ${meta.expectedFinding}`
        ).to.be.at.least(1);
        // A FAIL packet carries at least one error-severity finding.
        expect(model.counts.error, `${folder}: a FAIL packet has >=1 error`).to.be.at.least(
          1
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// The corpus is a faithful (non-rubber-stamp) gate: it drives the REAL path and
// is deterministic, so the same fixtures always reproduce the same verdict.
// ---------------------------------------------------------------------------

describe("trustledger/corpus: the corpus is deterministic + drives the real verdict path", function () {
  it("re-running a scenario produces a byte-identical packet model (determinism)", function () {
    // Pick the first scenario; buildPacket is pure, so two runs must be identical.
    const folder = corpusScenarios()[0];
    const a = runScenario(folder);
    const b = runScenario(folder);
    expect(JSON.stringify(a)).to.equal(JSON.stringify(b));
  });

  it("the verdict comes from the SAME buildPacket flag the CLI exits on (pass)", function () {
    // Sanity: each FAIL scenario's model.pass is false AND its summaryLine reads
    // FAIL, so the corpus pins the SAME verdict surface the CLI exit code uses —
    // not a private re-derivation that could drift from the shipped gate.
    for (const folder of corpusScenarios()) {
      const meta = loadJSON(path.join(CORPUS_DIR, folder, "meta.json"));
      const model = runScenario(folder);
      const line = report.summaryLine(model);
      if (meta.expectedVerdict === "FAIL") {
        expect(model.pass, `${folder} pass`).to.equal(false);
        expect(line, `${folder} summary`).to.match(/^FAIL:/);
      } else {
        expect(model.pass, `${folder} pass`).to.equal(true);
        expect(line, `${folder} summary`).to.match(/^PASS:/);
      }
    }
  });
});

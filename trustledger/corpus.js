"use strict";

// TrustLedger — corpus loader + runner (T-44.2).
//
// A PURE loader/runner over the COMMITTED out-of-trust corpus under
// trustledger/fixtures/corpus/. It discovers every scenario folder, runs each
// one through the REAL reconcile + buildPacket verdict path (the SAME path the
// CLI/--json reconcile exit code uses), and returns one structured ROW per
// scenario describing what the corpus EXPECTS versus what the live engine
// ACTUALLY does:
//
//   { id, control, principle, expected, actual, match }
//
// This module adds NO crypto, NO control logic, NO severity, and NO verdict
// rule. It is a faithful caller: the verdict is read straight off
// buildPacket's `model.pass` flag, exactly as the shipped reconcile gate exits.
// The CLI (`vh trust corpus`) renders these rows; tests assert them. The whole
// point is that a CPA or broker can RUN one command to confirm the gate FAILs
// the exact frauds it claims to catch — WITHOUT reading test/.
//
// The runScenario body is a deliberate sibling of test/trustledger.corpus.test.js
// (T-44.1): both drive the same fixture shape through the same real engine path.
// Keeping the runner here (not only in the test) is what makes the corpus a
// shippable, human-runnable artifact rather than a developer-only assertion.

const fs = require("fs");
const path = require("path");

const report = require("./report");

const CORPUS_DIR = path.join(__dirname, "fixtures", "corpus");

// A scenario verdict is one of these two strings; the corpus meta records the
// EXPECTED one and the live engine produces the ACTUAL one.
const VERDICT = Object.freeze({ PASS: "PASS", FAIL: "FAIL" });

// ---------------------------------------------------------------------------
// Discovery + load.
// ---------------------------------------------------------------------------

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Every scenario folder under the corpus root, sorted for a DETERMINISTIC row
// order. A leading-underscore folder (e.g. _shared) holds shared artifacts (a
// prior-close), not a scenario, and is skipped.
function scenarioIds(corpusDir = CORPUS_DIR) {
  return fs
    .readdirSync(corpusDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Run ONE scenario through the REAL reconcile + buildPacket verdict path.
//
// inputs.json carries already-normalized record arrays (the shape ingest.js
// produces) plus optional opening / policy / toleranceCents / a priorClosePath
// (resolved relative to the corpus root, read as the raw close JSON buildPacket
// re-validates). No engine code is touched — this is a faithful caller, the
// SAME wiring the corpus regression test uses.
// ---------------------------------------------------------------------------

function buildArgs(inputs, corpusDir) {
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
      path.join(corpusDir, inputs.priorClosePath),
      "utf8"
    );
  }
  return args;
}

// Run a single scenario folder -> the live packet model + a normalized result.
// Returns { model, actual } where `actual` is "PASS"/"FAIL" read off model.pass
// (the SAME flag the CLI reconcile exit code uses).
function runScenario(id, corpusDir = CORPUS_DIR) {
  const dir = path.join(corpusDir, id);
  const inputs = loadJSON(path.join(dir, "inputs.json"));
  const model = report.buildPacket(buildArgs(inputs, corpusDir));
  const actual = model.pass ? VERDICT.PASS : VERDICT.FAIL;
  return { model, actual };
}

// ---------------------------------------------------------------------------
// Run the WHOLE corpus -> structured rows + an aggregate result.
// ---------------------------------------------------------------------------

// Reduce a meta.principle (which may be a full paragraph) to a SINGLE sentence,
// so the table/JSON `principle` is the one-sentence trust-law annotation the
// task calls for, not a wall of text. Deterministic: takes the text up to and
// including the first sentence terminator, collapsing internal whitespace.
function oneSentence(text) {
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (s === "") return "";
  const m = s.match(/^[^.!?]*[.!?]/);
  return (m ? m[0] : s).trim();
}

// Build the row for one scenario. `expected` comes from the committed meta;
// `actual` from the live engine; `match` is their equality. A row also carries
// the meta `control` and the one-sentence `principle` for the human table.
function buildRow(id, corpusDir = CORPUS_DIR) {
  const meta = loadJSON(path.join(corpusDir, id, "meta.json"));
  const { actual } = runScenario(id, corpusDir);
  const expected = meta.expectedVerdict;
  return {
    id,
    control: meta.control,
    principle: oneSentence(meta.principle),
    expected,
    actual,
    match: expected === actual,
  };
}

// Run every scenario. Returns:
//   { rows, total, matched, mismatched, ok }
// `ok` is true iff EVERY row matched — the CI-gateable condition the CLI exits
// 0 on (and exits 3 on any mismatch / corpus drift). Rows are in deterministic
// (sorted-id) order, so the output is reproducible run to run.
function runCorpus(corpusDir = CORPUS_DIR) {
  const rows = scenarioIds(corpusDir).map((id) => buildRow(id, corpusDir));
  const matched = rows.filter((r) => r.match).length;
  const mismatched = rows.length - matched;
  return {
    rows,
    total: rows.length,
    matched,
    mismatched,
    ok: mismatched === 0,
  };
}

module.exports = {
  CORPUS_DIR,
  VERDICT,
  scenarioIds,
  runScenario,
  buildRow,
  runCorpus,
  oneSentence,
};

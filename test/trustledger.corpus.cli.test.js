"use strict";

// TrustLedger — `vh trust corpus [--json]` CLI test (T-44.2).
//
// `corpus` is the ONE read-only command a CPA or broker RUNS to confirm the
// reconciliation gate is correct WITHOUT reading test/. It loads the committed
// out-of-trust corpus, drives every scenario through the REAL reconcile +
// buildPacket verdict path (the SAME path the reconcile exit code uses), and
// prints a deterministic per-scenario table (id, control, trust-law principle,
// expected vs ACTUAL verdict, OK/MISMATCH) + a one-line summary.
//
// These tests drive the PUBLIC command through the subcommand dispatcher
// (cmdTrust) and assert the documented contract:
//
//   * the table carries a row per scenario, each with the id, control, the
//     one-sentence principle, expected vs actual, and an OK column;
//   * on the committed corpus EVERY scenario matches -> exit 0, "CORPUS OK";
//   * --json round-trips the structured rows + summary + ok flag;
//   * a DELIBERATELY-MISLABELED meta.json (flip a verdict) yields a MISMATCH
//     row AND exit 3 — proving the command is a real gate, not a rubber stamp;
//   * an unknown flag exits 2 (usage); the command writes NOTHING to disk.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  cmdTrust,
  cmdCorpus,
  runCorpusCmd,
  parseCorpusArgs,
  EXIT,
} = require("../trustledger/cli");
const corpus = require("../trustledger/corpus");

const COMMITTED_CORPUS = path.join(
  __dirname,
  "..",
  "trustledger",
  "fixtures",
  "corpus"
);

// Capture stdout/stderr with no real console I/O.
function capture() {
  const out = [];
  const err = [];
  return {
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

// Run `vh trust corpus ...` through the SUBCOMMAND dispatcher (the real wiring).
function runCorpusCli(argv, io) {
  return cmdTrust(["corpus", ...argv], io);
}

// Recursively copy the committed corpus into a temp dir so a test can mutate a
// COPY (e.g. mislabel one meta.json) without touching the committed fixtures.
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const d of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, d.name);
    const t = path.join(dst, d.name);
    if (d.isDirectory()) copyDir(s, t);
    else fs.copyFileSync(s, t);
  }
}

describe("trustledger CLI: `vh trust corpus`", function () {
  let tmpDirs;
  beforeEach(function () {
    tmpDirs = [];
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "tl-corpus-"));
    tmpDirs.push(d);
    return d;
  }

  // -------------------------------------------------- the committed corpus: OK
  describe("the committed corpus (all scenarios match)", function () {
    it("prints a per-scenario table + one-line summary and exits 0", function () {
      const io = capture();
      const code = runCorpusCli([], io);
      expect(code).to.equal(EXIT.PASS);

      const out = io.out();
      // A header naming the columns.
      expect(out).to.match(/SCENARIO\s+CONTROL\s+EXPECT\s+ACTUAL\s+RESULT/);

      // A deterministic row per committed scenario, each carrying its id,
      // control, expected/actual verdict, the principle, and an OK column.
      const ids = corpus.scenarioIds();
      expect(ids.length).to.be.at.least(2);
      for (const id of ids) {
        const meta = JSON.parse(
          fs.readFileSync(path.join(COMMITTED_CORPUS, id, "meta.json"), "utf8")
        );
        expect(out, `${id} row`).to.contain(id);
        expect(out, `${id} control`).to.contain(meta.control);
        // The one-sentence principle is printed verbatim under the row.
        expect(out, `${id} principle`).to.contain(
          corpus.oneSentence(meta.principle)
        );
      }

      // Every committed scenario matches -> the OK marker appears, MISMATCH does
      // NOT, and the summary leads with CORPUS OK and the full count.
      expect(out).to.contain("OK");
      expect(out).to.not.contain("MISMATCH");
      expect(out).to.match(
        new RegExp(`CORPUS OK: ${ids.length}/${ids.length} scenarios match`)
      );
    });

    it("the table has an OK marker for EVERY scenario and no MISMATCH", function () {
      const io = capture();
      runCorpusCli([], io);
      // Count the RESULT-column markers: a scenario row ends in "OK" (the
      // summary's "CORPUS OK:" is excluded — it does not END in OK).
      const okRows = io
        .out()
        .split("\n")
        .filter((l) => /\sOK$/.test(l));
      expect(okRows.length).to.equal(corpus.scenarioIds().length);
    });

    it("output is deterministic — two runs are byte-identical", function () {
      const a = capture();
      const b = capture();
      runCorpusCli([], a);
      runCorpusCli([], b);
      expect(a.out()).to.equal(b.out());
    });

    it("writes NOTHING (no stderr, no files) on the success path", function () {
      const io = capture();
      // Run inside a throwaway cwd and assert it stays empty.
      const d = mkTmp();
      const prev = process.cwd();
      try {
        process.chdir(d);
        runCorpusCli([], io);
      } finally {
        process.chdir(prev);
      }
      expect(io.err()).to.equal("");
      expect(fs.readdirSync(d)).to.deep.equal([]);
    });
  });

  // -------------------------------------------------------------------- --json
  describe("--json structured rows", function () {
    it("round-trips the rows + summary + ok flag + exit code", function () {
      const io = capture();
      const code = runCorpusCli(["--json"], io);
      expect(code).to.equal(EXIT.PASS);

      const j = JSON.parse(io.out());
      expect(j).to.have.all.keys(
        "rows",
        "total",
        "matched",
        "mismatched",
        "ok",
        "summary",
        "caveat",
        "code"
      );
      expect(j.ok).to.equal(true);
      expect(j.code).to.equal(EXIT.PASS);
      expect(j.total).to.equal(corpus.scenarioIds().length);
      expect(j.matched).to.equal(j.total);
      expect(j.mismatched).to.equal(0);
      expect(j.summary).to.match(/^CORPUS OK:/);

      // Every row carries exactly the documented fields.
      expect(j.rows).to.have.length(j.total);
      for (const r of j.rows) {
        expect(r).to.have.all.keys(
          "id",
          "control",
          "principle",
          "expected",
          "actual",
          "match"
        );
        expect(["PASS", "FAIL"]).to.include(r.expected);
        expect(["PASS", "FAIL"]).to.include(r.actual);
        expect(r.match).to.equal(r.expected === r.actual);
        // On the committed corpus every row matches.
        expect(r.match, `${r.id} matches`).to.equal(true);
        // The principle is a single, non-empty sentence (no embedded newline).
        expect(r.principle).to.be.a("string").that.is.not.empty;
        expect(r.principle).to.not.contain("\n");
      }
    });

    it("--json is deterministic (byte-identical across runs)", function () {
      const a = capture();
      const b = capture();
      runCorpusCli(["--json"], a);
      runCorpusCli(["--json"], b);
      expect(a.out()).to.equal(b.out());
    });
  });

  // ---------------------------------------------- the NOT-a-rubber-stamp proof
  describe("a deliberately-mislabeled meta.json FAILS the command (exit 3)", function () {
    it("flipping ONE recorded verdict yields a MISMATCH row + exit 3", function () {
      // Copy the committed corpus, then flip ONE scenario's expectedVerdict so
      // it disagrees with what the live engine actually produces. The command
      // must catch the drift (MISMATCH row + exit 3), proving it re-derives the
      // verdict from the real engine and does not merely echo the meta.
      const root = mkTmp();
      const copy = path.join(root, "corpus");
      copyDir(COMMITTED_CORPUS, copy);

      // Pick the first OUT-OF-TRUST scenario (recorded FAIL) and mislabel it as
      // PASS. The engine still FAILs it -> expected PASS vs actual FAIL.
      const ids = corpus.scenarioIds(copy);
      let victim = null;
      for (const id of ids) {
        const metaPath = path.join(copy, id, "meta.json");
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (meta.expectedVerdict === "FAIL") {
          meta.expectedVerdict = "PASS"; // the lie
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
          victim = id;
          break;
        }
      }
      expect(victim, "found a FAIL scenario to mislabel").to.not.equal(null);

      // Drive the CLI at the mutated copy via the corpusDir override.
      const io = capture();
      const res = runCorpusCmd({ json: false, corpusDir: copy }, io);
      expect(res.code).to.equal(EXIT.FAIL);

      const out = io.out();
      expect(out).to.contain("MISMATCH");
      expect(out).to.match(/CORPUS DRIFT: 1\/\d+ scenario\(s\) did NOT match/);

      // The mislabeled row specifically reads expected PASS, actual FAIL, and is
      // the one flagged MISMATCH.
      const victimLine = out
        .split("\n")
        .find((l) => l.startsWith(victim));
      expect(victimLine, `${victim} row present`).to.be.a("string");
      expect(victimLine).to.contain("PASS"); // the (wrong) expectation
      expect(victimLine).to.contain("FAIL"); // the real engine verdict
      expect(victimLine).to.contain("MISMATCH");
    });

    it("--json marks the mislabeled row match:false and ok:false (exit 3)", function () {
      const root = mkTmp();
      const copy = path.join(root, "corpus");
      copyDir(COMMITTED_CORPUS, copy);

      // Mislabel a benign twin (recorded PASS) as FAIL — the engine PASSes it,
      // so expected FAIL vs actual PASS, the symmetric drift direction.
      const ids = corpus.scenarioIds(copy);
      let victim = null;
      for (const id of ids) {
        const metaPath = path.join(copy, id, "meta.json");
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (meta.expectedVerdict === "PASS") {
          meta.expectedVerdict = "FAIL"; // the lie
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
          victim = id;
          break;
        }
      }
      expect(victim, "found a PASS scenario to mislabel").to.not.equal(null);

      const io = capture();
      const res = runCorpusCmd({ json: true, corpusDir: copy }, io);
      expect(res.code).to.equal(EXIT.FAIL);

      const j = JSON.parse(io.out());
      expect(j.ok).to.equal(false);
      expect(j.code).to.equal(EXIT.FAIL);
      expect(j.mismatched).to.equal(1);
      expect(j.summary).to.match(/^CORPUS DRIFT:/);

      const row = j.rows.find((r) => r.id === victim);
      expect(row, `${victim} row`).to.be.an("object");
      expect(row.expected).to.equal("FAIL"); // the lie
      expect(row.actual).to.equal("PASS"); // the real engine verdict
      expect(row.match).to.equal(false);

      // Every OTHER row still matches — only the mislabeled one drifts.
      const others = j.rows.filter((r) => r.id !== victim);
      expect(others.every((r) => r.match)).to.equal(true);
    });
  });

  // ----------------------------------------------------- usage + arg contract
  describe("argument + exit contract", function () {
    it("an unknown flag exits 2 (usage) and names the flag", function () {
      const io = capture();
      const code = runCorpusCli(["--bogus"], io);
      expect(code).to.equal(EXIT.USAGE);
      expect(io.err()).to.contain("--bogus");
      expect(io.out()).to.equal(""); // no table on a usage error
    });

    it("parseCorpusArgs accepts --json and rejects anything else", function () {
      expect(parseCorpusArgs([])).to.deep.equal({ json: false });
      expect(parseCorpusArgs(["--json"])).to.deep.equal({ json: true });
      expect(() => parseCorpusArgs(["--nope"])).to.throw(/unknown flag/);
    });

    it("cmdCorpus is reachable directly and matches the dispatcher result", function () {
      const a = capture();
      const b = capture();
      const viaCmd = cmdCorpus([], a);
      const viaTrust = runCorpusCli([], b);
      expect(viaCmd).to.equal(viaTrust);
      expect(a.out()).to.equal(b.out());
    });
  });

  // ----------------------------------------------------- the help discoverability
  it("`vh trust help` documents the corpus subcommand", function () {
    const io = capture();
    cmdTrust(["help"], io);
    expect(io.out()).to.match(/corpus \[--json\]/);
  });
});

"use strict";

// TrustLedger — `vh trust inspect` CLI test (T-25.2).
//
// `inspect` is the read-only onboarding companion to `reconcile`: it runs the
// diagnostic ingest over ONE file and turns a dead-end ingest error into a
// self-service fix. These tests drive the PUBLIC command (cmdInspect / cmdTrust)
// over fixtures and assert the documented exit-code + output contract:
//
//   * a clean bank/ledger/rentroll file reports OK with the right column map and
//     exits 0;
//   * a file with a missing REQUIRED column exits 3, names the missing column +
//     the alias hint;
//   * a file with malformed rows exits 3, lists EVERY bad row, AND still previews
//     the good rows;
//   * --json round-trips the full diagnostic report;
//   * an unreadable file exits 1; a bad --as exits 2; an unknown flag exits 2;
//   * inspect writes NOTHING to the filesystem (a throwaway temp dir stays empty),
//     pass or fail — and every temp dir is cleaned up.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { cmdInspect, cmdTrust, EXIT } = require("../trustledger/cli");

const FIX = path.join(__dirname, "..", "trustledger", "fixtures");

// Capture stdout/stderr the command writes, with no real I/O to the console.
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

// Run `vh trust inspect ...` through the SUBCOMMAND dispatcher (cmdTrust) so the
// test exercises the real wiring a user hits, not just the leaf function.
function inspect(argv, io) {
  return cmdTrust(["inspect", ...argv], io);
}

describe("trustledger CLI: `vh trust inspect`", function () {
  let tmpDirs;
  beforeEach(function () {
    tmpDirs = [];
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "tl-inspect-"));
    tmpDirs.push(d);
    return d;
  }
  // Write a throwaway fixture into a temp dir and return its path.
  function writeFix(name, text) {
    const d = mkTmp();
    const p = path.join(d, name);
    fs.writeFileSync(p, text);
    return p;
  }

  // ------------------------------------------------------------ clean files

  it("a CLEAN bank file reports OK with the right column map and exits 0", function () {
    const io = capture();
    const code = inspect([path.join(FIX, "bank.csv"), "--as", "bank"], io);
    expect(code).to.equal(EXIT.PASS);
    const out = io.out();
    // The detected header columns are echoed.
    expect(out).to.contain("Date, Description, Debit, Credit, Type");
    // The logical->header map names the columns the parser actually used.
    expect(out).to.match(/date:\s*Date/);
    expect(out).to.match(/debit:\s*Debit/);
    expect(out).to.match(/credit:\s*Credit/);
    expect(out).to.match(/memo:\s*Description/);
    // Full parse: every data row OK.
    expect(out).to.contain("parsed: 6 OK of 6 data row(s)");
    expect(out).to.contain("failures: none");
    expect(io.err()).to.equal("");
  });

  it("a CLEAN ledger (QuickBooks) file reports OK and exits 0", function () {
    const io = capture();
    const code = inspect([path.join(FIX, "quickbooks.csv"), "--as", "ledger"], io);
    expect(code).to.equal(EXIT.PASS);
    const out = io.out();
    expect(out).to.match(/date:\s*Date/);
    expect(out).to.match(/party:\s*Name/);
    expect(out).to.contain("parsed: 6 OK of 6 data row(s)");
    expect(out).to.contain("failures: none");
  });

  it("a CLEAN rentroll file reports OK and exits 0", function () {
    const io = capture();
    const code = inspect([path.join(FIX, "rentroll.csv"), "--as", "rentroll"], io);
    expect(code).to.equal(EXIT.PASS);
    const out = io.out();
    expect(out).to.match(/date:\s*Date/);
    expect(out).to.match(/tenant:\s*Tenant/);
    expect(out).to.contain("parsed: 5 OK of 5 data row(s)");
    expect(out).to.contain("failures: none");
  });

  // ------------------------------------------------ leads with the caveat + scope

  it("LEADS with the standing custodian caveat and the inspect-only scope, and cross-links reconcile", function () {
    const io = capture();
    inspect([path.join(FIX, "bank.csv"), "--as", "bank"], io);
    const out = io.out();
    expect(out).to.contain(
      "TrustLedger AIDS reconciliation; the broker remains the responsible custodian."
    );
    expect(out).to.contain("does NOT reconcile or attest");
    expect(out).to.contain("vh trust reconcile");
    // The caveat must lead — it appears before the data sections.
    expect(out.indexOf("the broker remains the responsible custodian")).to.be.below(
      out.indexOf("header columns")
    );
  });

  // -------------------------------------------------- missing required column

  it("a missing REQUIRED column exits 3 and names the missing column + the alias hint", function () {
    const p = writeFix("nodate.csv", "Description,Debit,Credit\nrent received,,1500.00\n");
    const io = capture();
    const code = inspect([p, "--as", "bank"], io);
    expect(code).to.equal(EXIT.FAIL);
    const out = io.out();
    // The missing logical field is flagged REQUIRED and "(not found)".
    expect(out).to.match(/date:\s*\(not found\) \[REQUIRED\]/);
    // The actionable hint names the accepted aliases the broker can add/rename to.
    expect(out).to.contain("how to fix:");
    expect(out).to.contain('rename your column to (or add) one named one of [');
    expect(out).to.contain("posting date"); // a real alias of the date field
    // T-25.3: the hint now ALSO advertises the WORKING --map escape hatch.
    expect(out).to.contain("--map");
  });

  it("a missing amount GROUP (no amount and no debit/credit) exits 3 with an add-a-column hint", function () {
    const p = writeFix("noamount.csv", "Date,Description\n2026-05-01,rent\n");
    const io = capture();
    const code = inspect([p, "--as", "bank"], io);
    expect(code).to.equal(EXIT.FAIL);
    const out = io.out();
    expect(out).to.contain("how to fix:");
    expect(out).to.contain("rename/add one of those columns");
    // T-25.3: the amount-group hint now also names the working --map override.
    expect(out).to.contain("--map");
  });

  // T-25.3: the fix hint a broker is told to follow must actually WORK when
  // followed. The hint now advertises the real `--map <logical>=<header>`
  // escape hatch, and passing it loads the file — turning the old dead end into
  // a self-service fix. (Before T-25.3 the flag did not exist and the hint
  // deliberately stayed silent; now it both names AND honors it.)
  it("the actionable hint advertises the WORKING --map flag and following it loads the file", function () {
    const p = writeFix(
      "nodate2.csv",
      "Effective,Description,Debit,Credit\n2026-05-01,rent,,1500.00\n"
    );
    const io = capture();
    const code1 = inspect([p, "--as", "bank"], io);
    expect(code1).to.equal(EXIT.FAIL); // "date" column not auto-detected
    expect(io.out()).to.contain("--map");
    // The --json hint array names it too.
    const io2 = capture();
    inspect([p, "--as", "bank", "--json"], io2);
    const rep = JSON.parse(io2.out());
    expect(JSON.stringify(rep.hint)).to.contain("--map");
    // Following the advice — mapping the existing header — actually LOADS it now.
    const io3 = capture();
    const code = inspect([p, "--as", "bank", "--map", "date=Effective"], io3);
    expect(code).to.equal(EXIT.PASS);
    expect(io3.out()).to.contain("parsed: 1 OK of 1");
  });

  // --------------------------------------------------------- malformed rows

  it("malformed rows exit 3, list EVERY bad row, AND still preview the good rows", function () {
    const p = writeFix(
      "mixed.csv",
      [
        "Date,Description,Debit,Credit,Type",
        "2026-05-01,Good deposit,,1500.00,Deposit",
        "2026-05-02,Bad too many decimals,,10.005,Deposit",
        "2026-05-03,Good draw,750.00,,Check",
        "not-a-date,Bad date,,5.00,Deposit",
      ].join("\n")
    );
    const io = capture();
    const code = inspect([p, "--as", "bank"], io);
    expect(code).to.equal(EXIT.FAIL);
    const out = io.out();
    // Both bad rows are listed by row number (data rows are 1-based).
    expect(out).to.contain("failures (2):");
    expect(out).to.match(/row 2:.*10\.005/);
    expect(out).to.match(/row 4:/);
    // The GOOD rows are still previewed (never fail-closed on the first error).
    expect(out).to.contain("parsed: 2 OK of 4 data row(s)");
    expect(out).to.contain("Good deposit");
    expect(out).to.contain("Good draw");
    // And the row-level fix hint is present.
    expect(out).to.contain("how to fix:");
    expect(out).to.contain("2 row(s) above failed to parse");
  });

  // --------------------------------------------------------------- OFX / QFX

  it("a CLEAN OFX bank file is detected and parses OK (parity with reconcile), exits 0", function () {
    const io = capture();
    const code = inspect([path.join(FIX, "bank.ofx"), "--as", "bank"], io);
    expect(code).to.equal(EXIT.PASS);
    const out = io.out();
    // Auto-detected as OFX — NOT mis-read as a one-column CSV with no date.
    expect(out).to.contain("detected format: ofx");
    expect(out).to.contain("OFX tags");
    expect(out).to.match(/date:\s*DTPOSTED/);
    expect(out).to.match(/amount:\s*TRNAMT/);
    // The same 3 transactions reconcile parses from this fixture.
    expect(out).to.contain("parsed: 3 OK of 3 data row(s)");
    expect(out).to.contain("failures: none");
    // It must NOT regress to the old "(not found)" / "no date column" answer.
    expect(out).to.not.contain("(not found)");
  });

  it("--bank-format ofx forces OFX parsing (the advertised flag is honoured, not ignored)", function () {
    const io = capture();
    const code = inspect(
      [path.join(FIX, "bank.ofx"), "--as", "bank", "--bank-format", "ofx"],
      io
    );
    expect(code).to.equal(EXIT.PASS);
    expect(io.out()).to.contain("detected format: ofx");
    expect(io.out()).to.contain("parsed: 3 OK of 3 data row(s)");
  });

  it("--bank-format ofx on a CSV file reports an honest 'not an OFX document' error (exit 3), not a false column miss", function () {
    const io = capture();
    const code = inspect(
      [path.join(FIX, "bank.csv"), "--as", "bank", "--bank-format", "ofx"],
      io
    );
    expect(code).to.equal(EXIT.FAIL);
    expect(io.out()).to.contain("not an OFX/QFX document");
  });

  it("--json on an OFX file round-trips the report with format:ofx and the OFX records", function () {
    const io = capture();
    const code = inspect(
      [path.join(FIX, "bank.ofx"), "--as", "bank", "--json"],
      io
    );
    expect(code).to.equal(EXIT.PASS);
    const rep = JSON.parse(io.out());
    expect(rep.format).to.equal("ofx");
    expect(rep.source).to.equal("bank");
    expect(rep.clean).to.equal(true);
    expect(rep.okCount).to.equal(3);
    expect(rep.rowCount).to.equal(3);
    expect(rep.errors).to.deep.equal([]);
    expect(rep.records[0]).to.include.keys(["date", "amount", "kind", "party", "memo"]);
  });

  it("a malformed OFX block exits 3, lists the bad txn, AND still previews the good ones", function () {
    // First txn good, second has a malformed TRNAMT (3 decimals -> rejected),
    // third good — the diagnostic path must not fail closed on the first error.
    const p = writeFix(
      "mixed.ofx",
      [
        "<OFX><BANKTRANLIST>",
        "<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260501<TRNAMT>1500.00<MEMO>Good rent</STMTTRN>",
        "<STMTTRN><TRNTYPE>CHECK<DTPOSTED>20260503<TRNAMT>10.005<MEMO>Bad amount</STMTTRN>",
        "<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260505<TRNAMT>200.00<MEMO>Good two</STMTTRN>",
        "</BANKTRANLIST></OFX>",
      ].join("\n")
    );
    const io = capture();
    const code = inspect([p, "--as", "bank"], io);
    expect(code).to.equal(EXIT.FAIL);
    const out = io.out();
    expect(out).to.contain("detected format: ofx");
    expect(out).to.contain("failures (1):");
    expect(out).to.match(/row 2:.*10\.005/);
    expect(out).to.contain("parsed: 2 OK of 3 data row(s)");
    expect(out).to.contain("Good rent");
    expect(out).to.contain("Good two");
  });

  // ------------------------------------------------------------------ --json

  it("--json round-trips the full diagnostic report", function () {
    const io = capture();
    const code = inspect(
      [path.join(FIX, "bank.malformed.csv"), "--as", "bank", "--json"],
      io
    );
    expect(code).to.equal(EXIT.FAIL);
    const rep = JSON.parse(io.out());
    // The full diagnostic report shape, plus the inspect envelope fields.
    expect(rep).to.include.keys([
      "source",
      "header",
      "mapped",
      "requiredMissing",
      "rowCount",
      "okCount",
      "records",
      "errors",
      "sample",
      "file",
      "as",
      "clean",
      "code",
      "hint",
      "caveat",
      "scope",
    ]);
    expect(rep.source).to.equal("bank");
    expect(rep.as).to.equal("bank");
    expect(rep.clean).to.equal(false);
    expect(rep.code).to.equal(EXIT.FAIL);
    expect(rep.okCount).to.equal(1);
    expect(rep.rowCount).to.equal(2);
    expect(rep.errors).to.have.length(1);
    expect(rep.errors[0]).to.have.all.keys(["row", "message"]);
    expect(rep.errors[0].row).to.equal(2);
    // The sample carries normalized records (date/amount/kind/party/memo).
    expect(rep.sample[0]).to.include.keys(["date", "amount", "kind", "party", "memo"]);
  });

  it("--json on a CLEAN file reports clean:true and exits 0", function () {
    const io = capture();
    const code = inspect([path.join(FIX, "rentroll.csv"), "--as", "rentroll", "--json"], io);
    expect(code).to.equal(EXIT.PASS);
    const rep = JSON.parse(io.out());
    expect(rep.clean).to.equal(true);
    expect(rep.code).to.equal(EXIT.PASS);
    expect(rep.requiredMissing).to.deep.equal([]);
    expect(rep.errors).to.deep.equal([]);
    expect(rep.hint).to.deep.equal([]);
  });

  // ------------------------------------------------------- --sample honoured

  it("--sample <n> caps the previewed records", function () {
    const io = capture();
    inspect([path.join(FIX, "bank.csv"), "--as", "bank", "--sample", "2", "--json"], io);
    const rep = JSON.parse(io.out());
    expect(rep.sample).to.have.length(2);
    // records is the FULL parsed set, independent of the sample cap.
    expect(rep.records.length).to.equal(rep.okCount);
    expect(rep.records.length).to.be.above(2);
  });

  // ------------------------------------------------------- usage / IO errors

  it("an unreadable file exits 1", function () {
    const io = capture();
    const code = inspect([path.join(FIX, "does-not-exist.csv"), "--as", "bank"], io);
    expect(code).to.equal(EXIT.IO);
    expect(io.err()).to.contain("cannot read file");
    // Nothing written to stdout on a hard IO error.
    expect(io.out()).to.equal("");
  });

  it("a bad --as value exits 2 (usage)", function () {
    const io = capture();
    const code = inspect([path.join(FIX, "bank.csv"), "--as", "checking"], io);
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.contain("--as must be one of bank|ledger|rentroll");
  });

  it("a missing --as exits 2 (usage)", function () {
    const io = capture();
    const code = inspect([path.join(FIX, "bank.csv")], io);
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.contain("requires --as");
  });

  it("a missing <file> exits 2 (usage)", function () {
    const io = capture();
    const code = inspect(["--as", "bank"], io);
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.contain("requires a <file>");
  });

  it("an unknown flag hard-errors with exit 2 (parser parity with reconcile)", function () {
    const io = capture();
    const code = inspect([path.join(FIX, "bank.csv"), "--as", "bank", "--bogus"], io);
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.contain("unknown option: --bogus");
  });

  it("a bad --bank-format value exits 2 (usage)", function () {
    const io = capture();
    const code = inspect(
      [path.join(FIX, "bank.csv"), "--as", "bank", "--bank-format", "xml"],
      io
    );
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.contain('--bank-format must be "csv" or "ofx"');
  });

  it("an extra positional argument exits 2 (usage)", function () {
    const io = capture();
    const code = inspect(
      [path.join(FIX, "bank.csv"), path.join(FIX, "rentroll.csv"), "--as", "bank"],
      io
    );
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.contain("unexpected extra argument");
  });

  // ----------------------------------------------------- filesystem hygiene

  it("writes NOTHING to the filesystem (a throwaway temp dir stays empty), pass or fail", function () {
    const sandbox = mkTmp();
    // Put the input fixtures INSIDE the sandbox, then assert inspect adds no new
    // files — covering both a clean (exit 0) and a failing (exit 3) run.
    const cleanFile = path.join(sandbox, "clean.csv");
    fs.copyFileSync(path.join(FIX, "bank.csv"), cleanFile);
    const badFile = path.join(sandbox, "bad.csv");
    fs.copyFileSync(path.join(FIX, "bank.malformed.csv"), badFile);
    const ofxFile = path.join(sandbox, "clean.ofx");
    fs.copyFileSync(path.join(FIX, "bank.ofx"), ofxFile);

    const before = fs.readdirSync(sandbox).sort();

    const cleanCode = inspect([cleanFile, "--as", "bank"], capture());
    expect(cleanCode).to.equal(EXIT.PASS);
    const badCode = inspect([badFile, "--as", "bank"], capture());
    expect(badCode).to.equal(EXIT.FAIL);
    // --json path too.
    inspect([cleanFile, "--as", "bank", "--json"], capture());
    // The OFX path writes nothing either.
    inspect([ofxFile, "--as", "bank", "--bank-format", "ofx"], capture());

    const after = fs.readdirSync(sandbox).sort();
    // No new files created anywhere in the sandbox (only the inputs remain).
    expect(after).to.deep.equal(before);
    expect(after).to.deep.equal(["bad.csv", "clean.csv", "clean.ofx"]);
  });

  // --------------------------------------------------------- dispatch parity

  it("an unknown trust subcommand still names inspect as a valid one", function () {
    const io = capture();
    const code = cmdTrust(["bogus"], io);
    expect(code).to.equal(EXIT.USAGE);
    expect(io.err()).to.contain("inspect");
  });
});

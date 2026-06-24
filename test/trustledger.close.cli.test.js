"use strict";

// TrustLedger — `--prior-close` / `--emit-close` CLI wiring tests (T-24.2).
//
// Proves the period chain rolls forward end to end through the public
// `vh trust reconcile` command:
//   * ADDITIVITY: reconciling the existing e2e fixtures with NO close flags
//     yields the SAME PASS/FAIL + balances + exception list as before (no
//     regression to any T-22.4/T-23.2 assertion);
//   * emitting a period-1 close then feeding it as --prior-close to a period-2
//     run whose opening MATCHES seeds the opening and raises NO continuity
//     exception;
//   * a period-2 run whose data does NOT roll forward from the prior close raises
//     a CONTINUITY_BREAK (error), flips the verdict to FAIL with exit 3, and names
//     the gap;
//   * a malformed --prior-close file exits 2 (usage), not 1 (IO);
//   * --emit-close writes a valid close that round-trips through close.readClose;
//   * a per-state policy can RE-GRADE a CONTINUITY_BREAK to a warning;
//   * filesystem hygiene: writes ONLY to caller-named paths, nothing leaks to cwd.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runReconcile, cmdReconcile, EXIT } = require("../trustledger/cli");
const close = require("../trustledger/close");

const FIX = path.join(__dirname, "..", "trustledger", "fixtures", "e2e");
const BANK = path.join(FIX, "bank.csv");
const BOOK = path.join(FIX, "quickbooks.csv");
const RENT = path.join(FIX, "rentroll.csv");

const DATE_1 = "2026-05-31"; // period 1 report date
const DATE_2 = "2026-06-30"; // period 2 report date

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

// The clean e2e fixtures close period 1 at bank 330000 / book 300000 / sub
// 300000 (asserted by the T-22.4 e2e test). A period-2 run that opens at the
// book/sub ending and adds zero net activity should tie out and roll forward
// clean. For period 2 we reuse the SAME source files but seed the opening from
// the emitted close, so the engine path (not hand-faked numbers) is exercised.

describe("trustledger T-24.2: --prior-close / --emit-close period chain", function () {
  let tmpDirs;
  beforeEach(function () {
    tmpDirs = [];
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "tl-close-cli-"));
    tmpDirs.push(d);
    return d;
  }

  // ---- ADDITIVITY: no close flags == today's behaviour ---------------------

  it("ADDITIVITY: no close flags yields the same PASS + balances + exception list", function () {
    const io = capture();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE_1 },
      io
    );
    expect(res.code).to.equal(EXIT.PASS);
    const b = res.model.balances;
    expect(b.bank).to.equal(330000);
    expect(b.book).to.equal(300000);
    expect(b.adjustedBank).to.equal(300000);
    expect(b.subledger).to.equal(300000);
    expect(res.model.pass).to.equal(true);
    // Exactly the one INFO outstanding check, no continuity exception.
    expect(res.model.exceptions).to.have.length(1);
    expect(res.model.exceptions[0].type).to.equal("outstanding_check");
    expect(res.model.exceptions.some((e) => e.type === "continuity_break")).to.equal(false);
    // No continuity metadata is attached without --prior-close.
    expect(res.model.continuity).to.equal(null);
    expect(res.model.priorClose).to.equal(null);
    expect(res.model.emitClose).to.equal(null);
    expect(res.closeWritten == null).to.equal(true);
  });

  // ---- --emit-close writes a valid, round-tripping close -------------------

  it("--emit-close writes a valid close that round-trips through close.readClose", function () {
    const dir = mkTmp();
    const closePath = path.join(dir, "p1.close.json");
    const io = capture();
    const res = runReconcile(
      {
        bank: BANK,
        ledger: BOOK,
        rentroll: RENT,
        date: DATE_1,
        period: "2026-05",
        emitClose: closePath,
      },
      io
    );
    expect(res.code).to.equal(EXIT.PASS);
    expect(res.closeWritten).to.equal(closePath);
    expect(fs.existsSync(closePath)).to.equal(true);

    // It validates + round-trips.
    const obj = close.readClose(fs.readFileSync(closePath, "utf8"));
    expect(obj.schemaVersion).to.equal(close.SCHEMA_VERSION);
    expect(obj.period).to.equal("2026-05");
    expect(obj.reportDate).to.equal(DATE_1);
    expect(obj.ending).to.deep.equal({ bank: 330000, book: 300000 });
    expect(obj.subledger).to.equal(300000);
    expect(obj.pass).to.equal(true);

    // The human output names the emitted close path.
    expect(io.out()).to.contain(`wrote close ${closePath}`);
  });

  // ---- roll-forward that MATCHES: seeds opening, NO continuity exception ----

  it("period 2 whose opening MATCHES the prior close: seeds opening, no continuity break", function () {
    const dir = mkTmp();
    const closePath = path.join(dir, "p1.close.json");
    // Period 1 -> emit close.
    runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE_1, period: "2026-05", emitClose: closePath },
      capture()
    );

    // Period 2: a fresh set of source files whose net activity rolls forward
    // exactly from period 1's ending. We build a tiny period-2 dataset in a temp
    // dir: opening seeded from the close (bank 330000 / book 300000), zero net
    // new activity in each, and a rent roll that re-states the same per-tenant
    // balances so the sub-ledger still ties to the book.
    const p2 = mkTmp();
    // Period 1 closed with the $300 vendor check still OUTSTANDING (bank ending
    // 330000 exceeds book ending 300000 by exactly that uncleared check). Period 2
    // sees that check CLEAR the bank (-300), bringing the bank down to 300000 so
    // the adjusted bank, book, and sub-ledger all tie out — a clean roll-forward.
    fs.writeFileSync(
      path.join(p2, "bank.csv"),
      "Date,Description,Debit,Credit,Type\n" +
        "2026-06-03,Vendor check 2051 cleared,300.00,,Check\n"
    );
    fs.writeFileSync(path.join(p2, "book.csv"), "Date,Type,Name,Memo,Debit,Credit\n");
    // Rent roll restating the sub-ledger so sum == book opening (300000).
    fs.writeFileSync(
      path.join(p2, "rent.csv"),
      "Date,Tenant,Unit,Type,Memo,Payment,Charge\n" +
        "2026-06-01,Jones,101,Payment,carryover,1500.00,\n" +
        "2026-06-01,Doe,103,Payment,carryover,1300.00,\n" +
        "2026-06-01,Smith,OWNER,Payment,carryover,200.00,\n"
    );

    const io = capture();
    const res = runReconcile(
      {
        bank: path.join(p2, "bank.csv"),
        ledger: path.join(p2, "book.csv"),
        rentroll: path.join(p2, "rent.csv"),
        date: DATE_2,
        period: "2026-06",
        priorClose: closePath,
      },
      io
    );

    // Opening was SEEDED from the prior close's ending.
    expect(res.model.opening).to.deep.equal({ bank: 330000, book: 300000 });
    // The outstanding check cleared in period 2: bank falls to 300000, ties book.
    expect(res.model.balances.bank).to.equal(300000);
    expect(res.model.balances.book).to.equal(300000);
    expect(res.model.balances.adjustedBank).to.equal(300000);
    // Roll-forward is clean: NO continuity break, verdict PASS, exit 0.
    expect(res.model.continuity.ok).to.equal(true);
    expect(res.model.continuity.bankGap).to.equal(0);
    expect(res.model.continuity.bookGap).to.equal(0);
    expect(res.model.exceptions.some((e) => e.type === "continuity_break")).to.equal(false);
    expect(res.model.pass).to.equal(true);
    expect(res.code).to.equal(EXIT.PASS);

    // The packet names the prior period it chained from.
    expect(res.model.priorClose.period).to.equal("2026-05");
    expect(res.model.priorClose.ending).to.deep.equal({ bank: 330000, book: 300000 });
  });

  // ---- roll-forward that BREAKS: CONTINUITY_BREAK error, FAIL, exit 3 -------

  it("an explicit opening that does NOT roll forward raises CONTINUITY_BREAK (error), FAIL, exit 3", function () {
    const dir = mkTmp();
    const closePath = path.join(dir, "p1.close.json");
    // Period 1 -> emit close (ending bank 330000 / book 300000).
    runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE_1, period: "2026-05", emitClose: closePath },
      capture()
    );

    // Period 2 rolls forward from that close but the broker OVERRIDES the bank
    // opening to a value that does NOT match the prior ending (a $100 break — a
    // skipped/edited/re-keyed period, the exact footgun this guard exists for).
    // The override is honored-and-noted; the continuity check then compares the
    // opening actually used against the prior ending and flags the gap.
    const io = capture();
    const res = runReconcile(
      {
        bank: BANK,
        ledger: BOOK,
        rentroll: RENT,
        date: DATE_2,
        period: "2026-06",
        priorClose: closePath,
        openingBank: 320000, // $100 LOWER than the prior ending bank (330000)
        openingBankSet: true,
      },
      io
    );

    // A CONTINUITY_BREAK error is raised, naming the gap.
    const breakEx = res.model.exceptions.find((e) => e.type === "continuity_break");
    expect(breakEx, "a continuity_break exception is raised").to.not.equal(undefined);
    expect(breakEx.severity).to.equal("error");
    expect(breakEx.amount).to.equal(-10000); // bank opening 320000 - prior ending 330000
    expect(breakEx.detail).to.contain("-10000");
    expect(breakEx.detail).to.contain("2026-05"); // names the prior period
    expect(res.model.continuity.ok).to.equal(false);
    expect(res.model.continuity.bankGap).to.equal(-10000);

    // The verdict flips to FAIL with exit 3.
    expect(res.model.pass).to.equal(false);
    expect(res.model.counts.error).to.be.greaterThan(0);
    expect(res.code).to.equal(EXIT.FAIL);

    // The override was NOTED on stderr.
    expect(io.err()).to.match(/overrides the prior close/);
  });

  it("the CONTINUITY_BREAK flows through the rendered report (HTML names the break + gap)", function () {
    const dir = mkTmp();
    const closePath = path.join(dir, "p1.close.json");
    runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE_1, period: "2026-05", emitClose: closePath },
      capture()
    );
    const outDir = mkTmp();
    const res = runReconcile(
      {
        bank: BANK,
        ledger: BOOK,
        rentroll: RENT,
        date: DATE_2,
        period: "2026-06",
        priorClose: closePath,
        openingBank: 320000,
        openingBankSet: true,
        out: outDir,
      },
      capture()
    );
    expect(res.code).to.equal(EXIT.FAIL);
    const html = fs.readFileSync(path.join(outDir, `reconciliation-${DATE_2}.html`), "utf8");
    expect(html).to.contain("Roll-forward continuity break");
    expect(html).to.contain("Roll-forward break:");
    // The exceptions CSV carries the continuity_break row.
    const exCsv = fs.readFileSync(
      path.join(outDir, `reconciliation-${DATE_2}-exceptions.csv`),
      "utf8"
    );
    expect(exCsv).to.contain("continuity_break");
  });

  // ---- malformed --prior-close is a USAGE error (exit 2) -------------------

  it("a malformed --prior-close file exits 2 (usage), not 1 (IO)", function () {
    const dir = mkTmp();
    const bad = path.join(dir, "bad.close.json");
    fs.writeFileSync(bad, "{ this is : not valid json");
    const io = capture();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE_2, priorClose: bad },
      io
    );
    expect(res.code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/invalid --prior-close/);

    // A structurally-wrong (parses but fails validation) close is ALSO usage.
    const bad2 = path.join(dir, "bad2.close.json");
    fs.writeFileSync(bad2, JSON.stringify({ schemaVersion: "wrong" }));
    const io2 = capture();
    const res2 = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE_2, priorClose: bad2 },
      io2
    );
    expect(res2.code).to.equal(EXIT.USAGE);
    expect(io2.err()).to.match(/invalid --prior-close/);

    // A missing --prior-close file is also USAGE (a bad flag value), not IO.
    const io3 = capture();
    const res3 = runReconcile(
      {
        bank: BANK,
        ledger: BOOK,
        rentroll: RENT,
        date: DATE_2,
        priorClose: path.join(dir, "nope.json"),
      },
      io3
    );
    expect(res3.code).to.equal(EXIT.USAGE);
    expect(io3.err()).to.match(/cannot read --prior-close/);
  });

  // ---- explicit --opening over a prior close is honored-and-NOTED ----------
  // BUILDER'S CHOICE: a disagreeing explicit override is honored but noted on
  // stderr, AND the continuity check flags the resulting gap in the packet (so a
  // chain-breaking override surfaces as a CONTINUITY_BREAK rather than silently).

  it("an explicit --opening-bank disagreeing with the prior close is honored + NOTED + flagged as a break", function () {
    const dir = mkTmp();
    const closePath = path.join(dir, "p1.close.json");
    runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE_1, period: "2026-05", emitClose: closePath },
      capture()
    );
    // prior ending bank = 330000; override to a DIFFERENT value ($3,200.00).
    const io = capture();
    const res = runReconcile(
      {
        bank: BANK,
        ledger: BOOK,
        rentroll: RENT,
        date: DATE_2,
        period: "2026-06",
        priorClose: closePath,
        openingBank: 320000,
        openingBankSet: true,
      },
      io
    );
    // The override is NOTED on stderr (not a hard usage error).
    expect(io.err()).to.match(/--opening-bank 320000 overrides the prior close/);
    // The opening actually USED is the override, not the seed.
    expect(res.model.opening.bank).to.equal(320000);
    // The continuity check flagged the gap (320000 - 330000 = -10000).
    expect(res.model.continuity.ok).to.equal(false);
    expect(res.model.continuity.bankGap).to.equal(-10000);
    const breakEx = res.model.exceptions.find((e) => e.type === "continuity_break");
    expect(breakEx).to.not.equal(undefined);
  });

  it("an explicit --opening-bank that AGREES with the prior close seeds cleanly (no note, no break)", function () {
    const dir = mkTmp();
    const closePath = path.join(dir, "p1.close.json");
    runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE_1, period: "2026-05", emitClose: closePath },
      capture()
    );
    // 330000 cents matches the prior ending bank => agreement, no note, no break.
    const io = capture();
    const res = runReconcile(
      {
        bank: BANK,
        ledger: BOOK,
        rentroll: RENT,
        date: DATE_2,
        period: "2026-06",
        priorClose: closePath,
        openingBank: 330000,
        openingBankSet: true,
      },
      io
    );
    expect(io.err()).to.not.match(/overrides the prior close/);
    expect(res.model.opening.bank).to.equal(330000);
    expect(res.model.continuity.ok).to.equal(true);
    expect(res.model.exceptions.some((e) => e.type === "continuity_break")).to.equal(false);
  });

  // ---- a policy can RE-GRADE a CONTINUITY_BREAK ----------------------------

  it("a per-state policy can re-grade a CONTINUITY_BREAK to a warning (no longer FAIL)", function () {
    const report = require("../trustledger/report");
    const policyMod = require("../trustledger/policy");

    // A minimal period-2 dataset that ITSELF ties out perfectly (bank == book ==
    // sub-ledger at the opening, zero net activity) so the ONLY error in play is
    // the continuity break — isolating the policy re-grade. Opening is $50 (bank)
    // ABOVE the prior close ending, so the roll-forward is broken by exactly that.
    const r = (date, amount, extra = {}) => ({
      date,
      amount,
      memo: extra.memo || "",
      kind: extra.kind || "other",
      party: extra.party || "",
      source: extra.source || "bank",
    });
    const bank = []; // no new bank activity
    const book = []; // no new book activity
    const rent = [r("2026-06-01", 300000, { source: "rentroll", party: "Tenant A", memo: "carry" })];

    // A prior close whose ending bank is $50 BELOW this period's opening (a break).
    const priorClose = close.buildClose({
      schema: "trustledger.reconciliation-packet/v1",
      reportDate: DATE_1,
      period: "2026-05",
      opening: { bank: 0, book: 0 },
      balances: { bank: 299500, book: 300000, subledger: 300000, adjustedBank: 0, reconciled: null },
      tiesOut: true,
      pass: true,
      inputs: { bankRecords: 1, bookRecords: 1, rentrollRecords: 1 },
    });

    // A policy re-grading continuity_break to a warning (a documented timing
    // roll-forward difference some states tolerate).
    const policy = policyMod.validatePolicy({
      schemaVersion: 1,
      state: "EXAMPLE-STATE (continuity timing tolerated)",
      severities: { continuity_break: "warning" },
      citations: { continuity_break: "Example Admin. Code §X (timing roll-forward)" },
    });

    const baseArgs = {
      bank,
      book,
      rentroll: rent,
      reportDate: DATE_2,
      period: "2026-06",
      // Opening: bank 300000 (== prior ending 299500 + 500 gap), book 300000.
      opening: { bank: 300000, book: 300000 },
      priorClose,
    };

    // Baseline (no policy): the break is an ERROR -> FAIL.
    const baseline = report.buildPacket(baseArgs);
    const baseEx = baseline.exceptions.find((e) => e.type === "continuity_break");
    expect(baseEx, "baseline raises a continuity break").to.not.equal(undefined);
    expect(baseEx.severity).to.equal("error");
    expect(baseEx.amount).to.equal(500); // 300000 - 299500
    expect(baseline.counts.error).to.equal(1);
    expect(baseline.pass).to.equal(false);

    // With the policy: the break is re-graded to WARNING; nothing else errors, so
    // the verdict no longer fails on the continuity break alone.
    const graded = report.buildPacket({ ...baseArgs, policy });
    const gradedEx = graded.exceptions.find((e) => e.type === "continuity_break");
    expect(gradedEx.severity).to.equal("warning");
    expect(gradedEx.citation).to.contain("Example Admin. Code");
    expect(graded.counts.error).to.equal(0);
    expect(graded.pass).to.equal(true);
  });

  // ---- the report names the prior period + roll-forward; hygiene preserved -

  it("the report (HTML + CSV + json) names the prior period and shows the roll-forward; only caller paths written", function () {
    const dir = mkTmp();
    const closePath = path.join(dir, "p1.close.json");
    runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE_1, period: "2026-05", emitClose: closePath },
      capture()
    );

    // A clean period-2 dataset: the outstanding $300 check clears the bank so the
    // adjusted bank, book, and sub-ledger all tie out at 300000 (roll-forward
    // clean). See the "period 2 whose opening MATCHES" test for the same shape.
    const p2 = mkTmp();
    fs.writeFileSync(
      path.join(p2, "bank.csv"),
      "Date,Description,Debit,Credit,Type\n" +
        "2026-06-03,Vendor check 2051 cleared,300.00,,Check\n"
    );
    fs.writeFileSync(path.join(p2, "book.csv"), "Date,Type,Name,Memo,Debit,Credit\n");
    fs.writeFileSync(
      path.join(p2, "rent.csv"),
      "Date,Tenant,Unit,Type,Memo,Payment,Charge\n" +
        "2026-06-01,Jones,101,Payment,carryover,1500.00,\n" +
        "2026-06-01,Doe,103,Payment,carryover,1300.00,\n" +
        "2026-06-01,Smith,OWNER,Payment,carryover,200.00,\n"
    );

    const outDir = mkTmp();
    const emitPath = path.join(mkTmp(), "p2.close.json");
    const cwdBefore = fs.readdirSync(process.cwd()).sort();

    const io = capture();
    const res = runReconcile(
      {
        bank: path.join(p2, "bank.csv"),
        ledger: path.join(p2, "book.csv"),
        rentroll: path.join(p2, "rent.csv"),
        date: DATE_2,
        period: "2026-06",
        priorClose: closePath,
        emitClose: emitPath,
        out: outDir,
        json: true,
      },
      io
    );
    // Seeded opening from the prior close; this run still ties out.
    expect(res.code).to.equal(EXIT.PASS);

    // HTML names the prior period + the roll-forward table.
    const html = fs.readFileSync(path.join(outDir, `reconciliation-${DATE_2}.html`), "utf8");
    expect(html).to.contain("Period continuity (roll-forward)");
    expect(html).to.contain("2026-05");
    expect(html).to.contain("Prior ending");
    expect(html).to.contain("This opening");
    // The emitted close path is referenced in the HTML.
    expect(html).to.contain(emitPath);

    // Balances CSV carries the continuity rows.
    const balCsv = fs.readFileSync(
      path.join(outDir, `reconciliation-${DATE_2}-balances.csv`),
      "utf8"
    );
    expect(balCsv).to.contain("continuity,prior_period");
    expect(balCsv).to.contain("continuity,bank_gap");

    // --json names the chain + the close written.
    const parsed = JSON.parse(io.out());
    expect(parsed.continuity.ok).to.equal(true);
    expect(parsed.priorClose.period).to.equal("2026-05");
    expect(parsed.emitClose).to.equal(emitPath);
    expect(parsed.closeWritten).to.equal(emitPath);

    // The emitted close round-trips.
    const emitted = close.readClose(fs.readFileSync(emitPath, "utf8"));
    expect(emitted.period).to.equal("2026-06");

    // Filesystem hygiene: cwd untouched, only the packet dir + the two close
    // files (in their own temp dirs) were written.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
    expect(fs.readdirSync(outDir).sort()).to.deep.equal([
      `reconciliation-${DATE_2}-balances.csv`,
      `reconciliation-${DATE_2}-exceptions.csv`,
      `reconciliation-${DATE_2}.html`,
    ]);
  });
});

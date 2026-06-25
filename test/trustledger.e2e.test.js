"use strict";

// TrustLedger — end-to-end pipeline test (T-22.4).
//
// This is the demoable core value under test: drive the WHOLE pipeline
// (ingest -> match -> reconcile -> report) on a fixture set of three real-shaped
// files via the public `vh trust reconcile` command, and assert:
//   * the THREE balances (adjusted bank, book, sub-ledger) are exactly right and
//     tie out for the clean fixtures (and DON'T for the short rent roll);
//   * the exception list is the expected set;
//   * the report files (HTML + CSV) are produced, dated, contain the disclaimer,
//     and are byte-deterministic across runs;
//   * the exit code is a stable CI gate (0 PASS / 3 FAIL / 2 usage / 1 IO);
//   * EVERY filesystem effect is isolated to a throwaway temp dir and cleaned up
//     (no leaked packet files in the working tree, pass or fail).

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runReconcile, cmdReconcile, cmdTrust, EXIT } = require("../trustledger/cli");
const report = require("../trustledger/report");

const FIX = path.join(__dirname, "..", "trustledger", "fixtures", "e2e");
const BANK = path.join(FIX, "bank.csv");
const BOOK = path.join(FIX, "quickbooks.csv");
const RENT = path.join(FIX, "rentroll.csv");
const RENT_SHORT = path.join(FIX, "rentroll.short.csv");

const DATE = "2026-06-24"; // pinned so output is byte-reproducible

// Capture stdout/stderr writes into strings so we never pollute the test runner
// and can assert on the exact summary line.
function capture() {
  const out = [];
  const err = [];
  return {
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    today: () => DATE,
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("trustledger e2e: `vh trust reconcile` runs the whole pipeline", function () {
  let tmpDirs;
  beforeEach(function () {
    tmpDirs = [];
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "tl-e2e-"));
    tmpDirs.push(d);
    return d;
  }

  it("the clean fixture set ties out: three balances equal, PASS, exit 0", function () {
    const io = capture();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE, json: false },
      io
    );

    expect(res.code).to.equal(EXIT.PASS);
    const b = res.model.balances;
    // The three numbers a broker watches tie out to the penny.
    expect(b.bank).to.equal(330000); // 1500 + 500 + 1300 cleared
    expect(b.book).to.equal(300000); // 1500 + 500 + 1300 - 300 (outstanding check)
    expect(b.adjustedBank).to.equal(300000); // bank minus the outstanding check
    expect(b.subledger).to.equal(300000); // Jones 1500 + Doe 1300 + Smith 200
    expect(b.reconciled).to.equal(300000);
    expect(res.model.tiesOut).to.equal(true);
    expect(res.model.pass).to.equal(true);

    // The summary line is the one a broker reads.
    expect(io.out()).to.match(/^PASS: three-way reconciliation tie out/);
  });

  it("classifies the exception list: exactly one INFO outstanding check, no errors", function () {
    const io = capture();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE },
      io
    );
    const exs = res.model.exceptions;
    expect(exs).to.have.length(1);
    expect(exs[0].type).to.equal("outstanding_check");
    expect(exs[0].severity).to.equal("info");
    expect(exs[0].amount).to.equal(-30000);
    expect(exs[0].records[0].memo).to.match(/Vendor check/);
    expect(res.model.counts).to.deep.equal({ error: 0, warning: 0, info: 1 });

    // The sub-ledger is broken out per beneficiary, sorted and exact.
    expect(res.model.beneficiaries).to.deep.equal([
      { party: "Doe (103)", balance: 130000 },
      { party: "Jones (101)", balance: 150000 },
      { party: "Smith (OWNER)", balance: 20000 },
    ]);
  });

  it("writes a DATED HTML + CSV packet into --out (and only there)", function () {
    const dir = mkTmp();
    const io = capture();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE, out: dir },
      io
    );
    expect(res.code).to.equal(EXIT.PASS);

    const html = path.join(dir, `reconciliation-${DATE}.html`);
    const exCsv = path.join(dir, `reconciliation-${DATE}-exceptions.csv`);
    const balCsv = path.join(dir, `reconciliation-${DATE}-balances.csv`);
    expect(fs.existsSync(html), "html packet exists").to.equal(true);
    expect(fs.existsSync(exCsv), "exceptions csv exists").to.equal(true);
    expect(fs.existsSync(balCsv), "balances csv exists").to.equal(true);

    // The HTML is a self-contained, print-to-PDF-ready document with the verdict,
    // all three balances, and the responsibility disclaimer.
    const htmlText = fs.readFileSync(html, "utf8");
    expect(htmlText).to.match(/^<!doctype html>/i);
    expect(htmlText).to.contain("PASS — three-way reconciliation ties out");
    expect(htmlText).to.contain("$3,000.00");
    expect(htmlText.toLowerCase()).to.contain("disclaimer");
    expect(htmlText).to.contain("broker remains the legal trust-account custodian");

    // The exceptions CSV has a header + the one outstanding-check row.
    const exText = fs.readFileSync(exCsv, "utf8");
    expect(exText.split("\n")[0]).to.contain("severity,type,label,amount_cents");
    expect(exText).to.contain("outstanding_check");
    expect(exText.endsWith("\n")).to.equal(true);

    // The balances CSV carries the three numbers.
    const balText = fs.readFileSync(balCsv, "utf8");
    expect(balText).to.contain("adjusted_bank,300000");
    expect(balText).to.contain("subledger,300000");

    // EXACTLY these three files were written into the dir — nothing else.
    expect(fs.readdirSync(dir).sort()).to.deep.equal([
      `reconciliation-${DATE}-balances.csv`,
      `reconciliation-${DATE}-exceptions.csv`,
      `reconciliation-${DATE}.html`,
    ]);
  });

  it("the packet is byte-deterministic across runs", function () {
    const d1 = mkTmp();
    const d2 = mkTmp();
    runReconcile({ bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE, out: d1 }, capture());
    runReconcile({ bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE, out: d2 }, capture());

    const names = fs.readdirSync(d1).sort();
    expect(names).to.deep.equal(fs.readdirSync(d2).sort());
    for (const name of names) {
      const a = fs.readFileSync(path.join(d1, name));
      const b = fs.readFileSync(path.join(d2, name));
      expect(b.equals(a), `${name} identical across runs`).to.equal(true);
    }
  });

  it("creates a missing --out directory and never writes to cwd", function () {
    const base = mkTmp();
    const nested = path.join(base, "packets", "may-2026");
    expect(fs.existsSync(nested)).to.equal(false);

    // Run from a clean cwd snapshot: capture the repo-root listing before/after
    // to prove no packet file leaked into the working tree.
    const cwdBefore = fs.readdirSync(process.cwd()).sort();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE, out: nested },
      capture()
    );
    expect(res.code).to.equal(EXIT.PASS);
    expect(fs.existsSync(path.join(nested, `reconciliation-${DATE}.html`))).to.equal(true);

    const cwdAfter = fs.readdirSync(process.cwd()).sort();
    expect(cwdAfter).to.deep.equal(cwdBefore);
    // No stray reconciliation file in cwd.
    expect(cwdAfter.some((f) => /^reconciliation-/.test(f))).to.equal(false);
  });

  it("a short rent roll is OUT OF TRUST: sub-ledger != book, FAIL, exit 3", function () {
    const io = capture();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT_SHORT, date: DATE },
      io
    );
    expect(res.code).to.equal(EXIT.FAIL);
    const b = res.model.balances;
    expect(b.book).to.equal(300000);
    expect(b.subledger).to.equal(250000); // missing the $500 owner funding row
    expect(res.model.tiesOut).to.equal(false);
    expect(res.model.pass).to.equal(false);
    expect(b.reconciled).to.equal(null);

    const types = res.model.exceptions.map((e) => e.type);
    expect(types).to.include("subledger_out_of_balance");
    const oob = res.model.exceptions.find((e) => e.type === "subledger_out_of_balance");
    expect(oob.severity).to.equal("error");
    expect(res.model.counts.error).to.be.greaterThan(0);

    expect(io.out()).to.match(/^FAIL: three-way reconciliation DO NOT tie out/);
  });

  it("--json emits the model + exit-code contract; the FAIL packet still writes", function () {
    const dir = mkTmp();
    const io = capture();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT_SHORT, date: DATE, out: dir, json: true },
      io
    );
    expect(res.code).to.equal(EXIT.FAIL);
    const parsed = JSON.parse(io.out());
    expect(parsed.pass).to.equal(false);
    expect(parsed.schema).to.equal("trustledger.reconciliation-packet/v1");
    expect(parsed.summary).to.match(/^FAIL:/);
    expect(parsed.written).to.have.length(3);
    // The dated packet is on disk even on FAIL (the broker files the finding).
    expect(fs.existsSync(path.join(dir, `reconciliation-${DATE}.html`))).to.equal(true);
  });

  it("exit codes are a stable CI contract: usage (2) and IO (1)", function () {
    // Missing a positional file => usage error (2), writes nothing.
    const io1 = capture();
    expect(cmdReconcile([BANK, BOOK], io1)).to.equal(EXIT.USAGE);
    expect(io1.err()).to.match(/requires three files/);

    // Unknown flag => usage error (2).
    const io2 = capture();
    expect(cmdReconcile([BANK, BOOK, RENT, "--bogus"], io2)).to.equal(EXIT.USAGE);
    expect(io2.err()).to.match(/unknown option/);

    // Unreadable file => IO error (1).
    const io3 = capture();
    const res3 = runReconcile(
      { bank: path.join(os.tmpdir(), "no-such-file-xyz.csv"), ledger: BOOK, rentroll: RENT, date: DATE },
      io3
    );
    expect(res3.code).to.equal(EXIT.IO);
    expect(io3.err()).to.match(/cannot read bank file/);

    // Unknown trust subcommand => usage error (2).
    const io4 = capture();
    expect(cmdTrust(["bogus"], io4)).to.equal(EXIT.USAGE);
    expect(io4.err()).to.match(/unknown trust subcommand/);
  });

  it("no --out prints summary + HTML to stdout and writes NOTHING", function () {
    const io = capture();
    const cwdBefore = fs.readdirSync(process.cwd()).sort();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE },
      io
    );
    expect(res.code).to.equal(EXIT.PASS);
    expect(res.written).to.deep.equal([]);
    const out = io.out();
    expect(out).to.match(/^PASS:/);
    expect(out).to.contain("<!doctype html>");
    // Working tree untouched.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });
});

describe("trustledger report: disclaimer + determinism are first-class", function () {
  it("the disclaimer makes the broker the responsible custodian, in HTML and CSV-ready text", function () {
    expect(report.DISCLAIMER_TEXT).to.match(/broker remains the legal trust-account custodian/i);
    expect(report.DISCLAIMER_TEXT).to.match(/does not constitute legal, accounting, or audit advice/i);
    // The disclaimer is reused verbatim from one source (no drift).
    expect(report.DISCLAIMER_LINES.join(" ")).to.equal(report.DISCLAIMER_TEXT);
  });

  it("buildPacket is pure: identical inputs + date => identical model + render", function () {
    const ingest = report.ingest;
    const bank = ingest.parseBankStatement(fs.readFileSync(BANK, "utf8"));
    const book = ingest.parseQuickBooksCSV(fs.readFileSync(BOOK, "utf8"));
    const rent = ingest.parseRentRollCSV(fs.readFileSync(RENT, "utf8"));

    const m1 = report.buildPacket({ bank, book, rentroll: rent, reportDate: DATE });
    const m2 = report.buildPacket({ bank, book, rentroll: rent, reportDate: DATE });
    expect(JSON.stringify(m1)).to.equal(JSON.stringify(m2));
    expect(report.renderHTML(m1)).to.equal(report.renderHTML(m2));
    expect(report.renderExceptionsCSV(m1)).to.equal(report.renderExceptionsCSV(m2));
  });

  it("requires an explicit YYYY-MM-DD report date (no hidden clock)", function () {
    expect(() => report.buildPacket({ bank: [], book: [], rentroll: [] })).to.throw(
      report.ReportError
    );
    expect(() =>
      report.buildPacket({ bank: [], book: [], rentroll: [], reportDate: "nope" })
    ).to.throw(report.ReportError);
  });

  it("fmtCents formats signed integer cents with grouping", function () {
    expect(report.fmtCents(0)).to.equal("$0.00");
    expect(report.fmtCents(5)).to.equal("$0.05");
    expect(report.fmtCents(123499)).to.equal("$1,234.99");
    expect(report.fmtCents(-30000)).to.equal("-$300.00");
    expect(report.fmtCents(100000000)).to.equal("$1,000,000.00");
  });
});

// ---------------------------------------------------------------------------
// T-43.2: the ROOT-CAUSE triage is surfaced in the CLI verdict line, the --json
// packet, and the HTML packet — so a FAIL is LEGIBLE at first contact (is the
// trust account genuinely out of trust, or did the tool just fail to reconcile
// the data?) WITHOUT changing the PASS/FAIL verdict or the exit code.
// ---------------------------------------------------------------------------
describe("trustledger e2e: triage is surfaced in the verdict line + JSON + HTML (T-43.2)", function () {
  let tmpDirs;
  beforeEach(function () {
    tmpDirs = [];
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "tl-e2e-triage-"));
    tmpDirs.push(d);
    return d;
  }

  // A DATA-COMPLETENESS-ONLY FAIL: the bank carries an extra deposit the book
  // never recorded (bank OVER). Book and rent roll agree to the penny, so there is
  // NO out-of-trust finding — only an unreconciled bank line + a (positive,
  // bank-over) bank/book mismatch, both data_completeness. The verdict is FAIL but
  // the make-or-break headline must say it is NOT an out-of-trust finding.
  function writeDataGapFixtures() {
    const dir = mkTmp();
    const bank = path.join(dir, "bank.csv");
    const book = path.join(dir, "quickbooks.csv");
    const rent = path.join(dir, "rentroll.csv");
    fs.writeFileSync(
      bank,
      "Date,Description,Debit,Credit,Type\n" +
        '2026-05-01,"Deposit - Jones rent received",,1500.00,Deposit\n' +
        '2026-05-20,"Unrecorded misc deposit",,50.00,Deposit\n'
    );
    fs.writeFileSync(
      book,
      "Date,Type,Name,Memo,Debit,Credit\n" +
        "05/01/2026,Deposit,Jones Tenant,Rent received May,,1500.00\n"
    );
    fs.writeFileSync(
      rent,
      "Date,Tenant,Unit,Type,Memo,Payment,Charge\n" +
        "2026-05-01,Jones,101,Payment,Rent received May,1500.00,\n"
    );
    return { bank, ledger: book, rentroll: rent };
  }

  it("the CLI prints the EXISTING verdict first line BYTE-FOR-BYTE, then a triage headline line", function () {
    const io = capture();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE, json: false },
      io
    );
    expect(res.code).to.equal(EXIT.PASS); // verdict + exit code UNCHANGED
    // The summary line is byte-for-byte what summaryLine() emits (unchanged).
    const expectedFirst = report.summaryLine(res.model);
    const lines = io.out().split("\n");
    expect(lines[0]).to.equal(expectedFirst);
    // The SECOND line is the additive triage headline (and matches the helper).
    expect(lines[1]).to.equal(report.triageHeadline(res.model));
    expect(lines[1]).to.match(/^Triage: /);
  });

  it("a DATA-GAP-only FAIL prints a headline that says it is NOT an out-of-trust finding", function () {
    const f = writeDataGapFixtures();
    const io = capture();
    const res = runReconcile({ ...f, date: DATE, json: false }, io);

    // Verdict + exit code UNCHANGED: this is a genuine FAIL (it does not tie out).
    expect(res.code).to.equal(EXIT.FAIL);
    expect(res.model.pass).to.equal(false);
    // ...but caused ONLY by data-completeness, never an out-of-trust finding.
    expect(res.model.triage.outOfTrust).to.equal(false);
    expect(res.model.triage.dataIncomplete).to.equal(true);
    expect(res.model.triage.topClass).to.equal("data_completeness");

    const lines = io.out().split("\n");
    expect(lines[0]).to.equal(report.summaryLine(res.model)); // first line byte-for-byte
    // The triage headline names it FIX YOUR DATA and explicitly NOT out of trust.
    expect(lines[1]).to.match(/^Triage: FIX YOUR DATA:/);
    expect(lines[1]).to.include("NOT shown out of trust");
    expect(lines[1]).to.include("not (yet) evidence the money is gone");
    // It NEVER raises the out-of-trust claim for a mere data gap.
    expect(lines[1]).to.not.include("OUT OF TRUST:");
  });

  it("a genuine OUT-OF-TRUST FAIL prints an OUT OF TRUST triage headline (the short rent roll)", function () {
    const io = capture();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT_SHORT, date: DATE, json: false },
      io
    );
    expect(res.code).to.equal(EXIT.FAIL);
    expect(res.model.triage.outOfTrust).to.equal(true);
    const lines = io.out().split("\n");
    expect(lines[0]).to.equal(report.summaryLine(res.model));
    expect(lines[1]).to.match(/^Triage: OUT OF TRUST:/);
  });

  it("--json carries the `triage` object (classes + headline + flags), additively", function () {
    const io = capture();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT_SHORT, date: DATE, json: true },
      io
    );
    expect(res.code).to.equal(EXIT.FAIL);
    const parsed = JSON.parse(io.out());
    // Every PRE-EXISTING field is still present (additive, never replaced).
    expect(parsed.pass).to.equal(false);
    expect(parsed.schema).to.equal("trustledger.reconciliation-packet/v1");
    expect(parsed.summary).to.match(/^FAIL:/);
    // The NEW triage object rides along with the stable shape it documents.
    expect(parsed.triage).to.be.an("object");
    expect(parsed.triage.outOfTrust).to.equal(true);
    expect(parsed.triage).to.have.property("dataIncomplete");
    expect(parsed.triage).to.have.property("topClass");
    expect(parsed.triage).to.have.property("totals");
    expect(parsed.triage.headline).to.match(/^OUT OF TRUST:/);
    expect(parsed.triage.classes).to.be.an("array");
    // The most-urgent class leads the roll-up array and carries count + impact.
    expect(parsed.triage.classes[0].class).to.equal("out_of_trust");
    expect(parsed.triage.classes[0].count).to.be.greaterThan(0);
    expect(parsed.triage.classes[0]).to.have.property("absImpact");
  });

  it("the HTML packet renders a 'fix first' callout + per-class roll-up", function () {
    const dir = mkTmp();
    const io = capture();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT_SHORT, date: DATE, out: dir },
      io
    );
    expect(res.code).to.equal(EXIT.FAIL);
    const html = fs.readFileSync(
      path.join(dir, `reconciliation-${DATE}.html`),
      "utf8"
    );
    // The "fix first" callout carries the triage headline, toned for out-of-trust.
    expect(html).to.contain("Fix first.");
    expect(html).to.contain('class="triage triage-fail"');
    expect(html).to.contain("OUT OF TRUST:");
    // The per-class roll-up table is present, with the urgent class + an impact.
    expect(html).to.contain("Fix first &rarr;");
    expect(html).to.contain("Out of trust");
    // The verdict box itself is UNCHANGED (the additive callout sits beside it).
    expect(html).to.contain("FAIL — see exceptions");
  });

  it("the DATA-GAP HTML callout is AMBER (warn), never the red out-of-trust tone", function () {
    const f = writeDataGapFixtures();
    const dir = mkTmp();
    runReconcile({ ...f, date: DATE, out: dir }, capture());
    const html = fs.readFileSync(
      path.join(dir, `reconciliation-${DATE}.html`),
      "utf8"
    );
    expect(html).to.contain('class="triage triage-warn"');
    expect(html).to.not.contain('class="triage triage-fail"');
    expect(html).to.contain("FIX YOUR DATA:");
  });

  it("the triage callout HTML-escapes attacker-controllable values (no injection via headline/labels)", function () {
    // The headline embeds dollar figures + class labels — none attacker-controlled
    // today — but the renderer must still route every value through esc(). Forge a
    // model whose triage headline carries an HTML metacharacter and prove the
    // packet escapes it rather than emitting a live tag.
    const model = report.buildPacket({
      bank: [],
      book: [],
      rentroll: [],
      reportDate: DATE,
    });
    model.triage = {
      classes: [{ class: "out_of_trust", label: "<img src=x onerror=1>", count: 1, absImpact: 100 }],
      totals: { count: 1, absImpact: 100 },
      outOfTrust: true,
      dataIncomplete: false,
      topClass: "out_of_trust",
      headline: "OUT OF TRUST: <script>alert(1)</script>",
    };
    const html = report.renderHTML(model);
    expect(html).to.not.contain("<script>alert(1)</script>");
    expect(html).to.not.contain("<img src=x onerror=1>");
    expect(html).to.contain("&lt;script&gt;");
    expect(html).to.contain("&lt;img src=x onerror=1&gt;");
  });

  it("triage is deterministic + additive in the packet: the model still round-trips byte-identically", function () {
    const ingest = report.ingest;
    const bank = ingest.parseBankStatement(fs.readFileSync(BANK, "utf8"));
    const book = ingest.parseQuickBooksCSV(fs.readFileSync(BOOK, "utf8"));
    const rent = ingest.parseRentRollCSV(fs.readFileSync(RENT_SHORT, "utf8"));
    const m1 = report.buildPacket({ bank, book, rentroll: rent, reportDate: DATE });
    const m2 = report.buildPacket({ bank, book, rentroll: rent, reportDate: DATE });
    expect(JSON.stringify(m1)).to.equal(JSON.stringify(m2));
    expect(report.renderHTML(m1)).to.equal(report.renderHTML(m2));
    // The triage object is present on the packet model itself.
    expect(m1.triage).to.be.an("object");
    expect(m1.triage.headline).to.match(/^OUT OF TRUST:/);
  });
});

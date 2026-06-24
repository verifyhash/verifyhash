"use strict";

// T-25.1 — diagnostic ingest core: parse-WITH-report.
//
// These tests prove the diagnostic path:
//   * never throws on a row error (it accumulates EVERY failing row),
//   * reports the detected header + the logical->header column map,
//   * surfaces a missing REQUIRED column in `requiredMissing` (not a crash),
//   * still returns the rows that DID parse, and
//   * leaves the strict, fail-closed parsers byte-for-byte unchanged.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const {
  SOURCE,
  KIND,
  IngestError,
  parseBankStatement,
  parseQuickBooksCSV,
  parseRentRollCSV,
  diagnoseSource,
  diagnoseBank,
  diagnoseQuickBooks,
  diagnoseRentRoll,
} = require("../trustledger/ingest");

const FIX = path.join(__dirname, "..", "trustledger", "fixtures");
const readFix = (name) => fs.readFileSync(path.join(FIX, name), "utf8");

// Shape guard for the diagnostic report — every key always present.
function assertReportShape(rep) {
  expect(rep).to.have.all.keys([
    "source",
    "format",
    "header",
    "mapped",
    "requiredMissing",
    "rowCount",
    "okCount",
    "records",
    "errors",
    "sample",
  ]);
  expect(rep.format).to.be.oneOf(["csv", "ofx"]);
  expect(rep.header).to.be.an("array");
  expect(rep.mapped).to.be.an("object");
  expect(rep.requiredMissing).to.be.an("array");
  expect(rep.rowCount).to.be.a("number");
  expect(rep.okCount).to.be.a("number");
  expect(rep.records).to.be.an("array");
  expect(rep.errors).to.be.an("array");
  expect(rep.sample).to.be.an("array");
  for (const e of rep.errors) {
    expect(e).to.have.all.keys(["row", "message"]);
  }
}

// A clean split debit/credit bank file (matches the shipped fixture shape).
const CLEAN_BANK = [
  "Date,Description,Debit,Credit,Type",
  "2026-05-01,Deposit - rent received,,1500.00,Deposit",
  "2026-05-03,Check #1042 owner draw,750.00,,Check",
  "2026-05-09,Monthly service charge,12.50,,Fee",
].join("\n");

// A signed-amount bank file (single Amount column, signs explicit).
const SIGNED_BANK = [
  "Posted,Memo,Amount",
  "2026-05-01,Rent received,1500.00",
  "2026-05-03,Owner draw,-750.00",
  "2026-05-09,Service charge,(12.50)",
].join("\n");

describe("trustledger/ingest: diagnoseSource (parse-with-report)", function () {
  describe("a CLEAN file", function () {
    it("reports okCount == rowCount and NO errors (split debit/credit)", function () {
      const rep = diagnoseBank(CLEAN_BANK);
      assertReportShape(rep);
      expect(rep.source).to.equal(SOURCE.BANK);
      expect(rep.rowCount).to.equal(3);
      expect(rep.okCount).to.equal(3);
      expect(rep.errors).to.deep.equal([]);
      expect(rep.requiredMissing).to.deep.equal([]);
      expect(rep.records).to.have.length(3);
    });

    it("echoes the detected header and maps each logical field to its header name", function () {
      const rep = diagnoseBank(CLEAN_BANK);
      expect(rep.header).to.deep.equal([
        "Date",
        "Description",
        "Debit",
        "Credit",
        "Type",
      ]);
      // mapped shows WHICH header satisfied each logical field, ORIGINAL casing.
      expect(rep.mapped.date).to.equal("Date");
      expect(rep.mapped.debit).to.equal("Debit");
      expect(rep.mapped.credit).to.equal("Credit");
      expect(rep.mapped.memo).to.equal("Description");
      expect(rep.mapped.type).to.equal("Type");
      // an optional logical field with no matching header is null, not missing.
      expect(rep.mapped.amount).to.equal(null);
    });

    it("returns a sample of the first N ok rows (default 5)", function () {
      const rep = diagnoseBank(CLEAN_BANK);
      expect(rep.sample).to.have.length(3); // fewer than 5 rows => all of them
      expect(rep.sample).to.deep.equal(rep.records);
    });

    it("honours an explicit sampleSize", function () {
      const rep = diagnoseBank(CLEAN_BANK, { sampleSize: 1 });
      expect(rep.sample).to.have.length(1);
      expect(rep.sample[0]).to.deep.equal(rep.records[0]);
      // records is the FULL parsed set, independent of sample.
      expect(rep.records).to.have.length(3);
    });

    it("the parsed records are byte-identical to the strict parser's output", function () {
      const rep = diagnoseBank(CLEAN_BANK);
      const strict = parseBankStatement(CLEAN_BANK);
      expect(rep.records).to.deep.equal(strict);
    });
  });

  describe("a SIGNED-amount file", function () {
    it("maps the amount column and parses signs exactly", function () {
      const rep = diagnoseBank(SIGNED_BANK);
      assertReportShape(rep);
      expect(rep.mapped.amount).to.equal("Amount");
      expect(rep.mapped.date).to.equal("Posted");
      expect(rep.mapped.memo).to.equal("Memo");
      // split columns are unmatched optionals here.
      expect(rep.mapped.debit).to.equal(null);
      expect(rep.mapped.credit).to.equal(null);
      expect(rep.okCount).to.equal(3);
      expect(rep.errors).to.deep.equal([]);
      expect(rep.records.map((r) => r.amount)).to.deep.equal([
        150000, -75000, -1250,
      ]);
    });
  });

  describe("a file with 3 BAD rows", function () {
    // rows 2, 4, 6 are bad; rows 1, 3, 5 are good.
    const THREE_BAD = [
      "Date,Description,Debit,Credit,Type",
      "2026-05-01,good one,,1500.00,Deposit", // row 1 ok
      "2026-13-40,bad date,,10.00,Deposit", // row 2 bad: invalid month
      "2026-05-03,good two,750.00,,Check", // row 3 ok
      "2026-05-04,over-precise,,10.005,Deposit", // row 4 bad: > 2 decimals
      "2026-05-05,good three,,200.00,Deposit", // row 5 ok
      "2026-05-06,both sides,5.00,5.00,Deposit", // row 6 bad: debit AND credit
    ].join("\n");

    it("does NOT throw, and reports ALL 3 failing rows with 1-based row numbers", function () {
      const rep = diagnoseBank(THREE_BAD);
      assertReportShape(rep);
      expect(rep.rowCount).to.equal(6);
      expect(rep.okCount).to.equal(3);
      expect(rep.errors).to.have.length(3);
      expect(rep.errors.map((e) => e.row)).to.deep.equal([2, 4, 6]);
      // the messages name the actual problem.
      expect(rep.errors[0].message).to.match(/month/i);
      expect(rep.errors[1].message).to.match(/amount|decimal|malformed/i);
      expect(rep.errors[2].message).to.match(/both/i);
    });

    it("STILL returns the rows that parsed, in order", function () {
      const rep = diagnoseBank(THREE_BAD);
      expect(rep.records).to.have.length(3);
      expect(rep.records.map((r) => r.memo)).to.deep.equal([
        "good one",
        "good two",
        "good three",
      ]);
    });

    it("the SAME file makes the strict parser fail closed on the FIRST bad row", function () {
      expect(() => parseBankStatement(THREE_BAD)).to.throw(IngestError);
      try {
        parseBankStatement(THREE_BAD);
      } catch (e) {
        expect(e.row).to.equal(2); // first bad row, nothing after it parsed
      }
    });
  });

  describe("a file MISSING a required column", function () {
    const NO_DATE = [
      "Description,Debit,Credit,Type",
      "rent,,1500.00,Deposit",
      "draw,750.00,,Check",
    ].join("\n");

    it("reports `date` in requiredMissing and echoes the header back", function () {
      const rep = diagnoseBank(NO_DATE);
      assertReportShape(rep);
      expect(rep.requiredMissing).to.deep.equal(["date"]);
      expect(rep.header).to.deep.equal([
        "Description",
        "Debit",
        "Credit",
        "Type",
      ]);
      // the columns that DID match are still shown, so the broker can see the map.
      expect(rep.mapped.debit).to.equal("Debit");
      expect(rep.mapped.credit).to.equal("Credit");
      expect(rep.mapped.date).to.equal(null);
    });

    it("does NOT collapse to a single crash and does NOT throw", function () {
      expect(() => diagnoseBank(NO_DATE)).to.not.throw();
      // and the strict parser DOES fail closed on the same file.
      expect(() => parseBankStatement(NO_DATE)).to.throw(
        IngestError,
        /missing required column "date"/
      );
    });

    it("reports a missing tenant column for rent rolls (multiple required)", function () {
      const NO_TENANT = [
        "Date,Unit,Payment,Charge",
        "2026-05-01,101,1500.00,",
      ].join("\n");
      const rep = diagnoseRentRoll(NO_TENANT);
      expect(rep.requiredMissing).to.deep.equal(["tenant"]);
      expect(rep.mapped.date).to.equal("Date");
      expect(rep.mapped.unit).to.equal("Unit");
      expect(rep.mapped.tenant).to.equal(null);
    });
  });

  describe("an unmatched OPTIONAL field maps to null", function () {
    it("shows null for logical fields with no matching header", function () {
      const rep = diagnoseBank(CLEAN_BANK);
      // CLEAN_BANK has no Amount column -> amount logical field is null.
      expect(rep.mapped).to.have.property("amount", null);
      // but date/debit/credit are present.
      expect(rep.mapped.date).to.equal("Date");
    });
  });

  describe("QuickBooks and rent-roll sources map correctly", function () {
    it("maps a QuickBooks split export and parses every row", function () {
      const text = readFix("quickbooks.csv");
      const rep = diagnoseQuickBooks(text);
      assertReportShape(rep);
      expect(rep.source).to.equal(SOURCE.QUICKBOOKS);
      expect(rep.mapped.date).to.equal("Date");
      expect(rep.mapped.type).to.equal("Type");
      expect(rep.mapped.party).to.equal("Name");
      expect(rep.mapped.memo).to.equal("Memo");
      expect(rep.mapped.debit).to.equal("Debit");
      expect(rep.mapped.credit).to.equal("Credit");
      expect(rep.errors).to.deep.equal([]);
      expect(rep.okCount).to.equal(rep.rowCount);
      // identical to the strict parse.
      expect(rep.records).to.deep.equal(parseQuickBooksCSV(text));
    });

    it("maps a split payment/charge rent roll and parses every row", function () {
      const text = readFix("rentroll.csv");
      const rep = diagnoseRentRoll(text);
      assertReportShape(rep);
      expect(rep.source).to.equal(SOURCE.RENT_ROLL);
      expect(rep.mapped.tenant).to.equal("Tenant");
      expect(rep.mapped.unit).to.equal("Unit");
      expect(rep.mapped.payment).to.equal("Payment");
      expect(rep.mapped.charge).to.equal("Charge");
      expect(rep.errors).to.deep.equal([]);
      expect(rep.okCount).to.equal(rep.rowCount);
      expect(rep.records).to.deep.equal(parseRentRollCSV(text));
    });
  });

  describe("the shipped malformed fixture", function () {
    it("collects the over-precise row rather than aborting the file", function () {
      const text = readFix("bank.malformed.csv");
      const rep = diagnoseBank(text);
      assertReportShape(rep);
      // one good row, one bad (10.005 has 3 decimals -> rejected, not rounded).
      expect(rep.okCount).to.equal(1);
      expect(rep.errors).to.have.length(1);
      expect(rep.errors[0].row).to.equal(2);
      expect(rep.records).to.have.length(1);
      expect(rep.records[0].amount).to.equal(150000);
      // the strict parser still fails closed on the same file.
      expect(() => parseBankStatement(text)).to.throw(IngestError);
    });
  });

  describe("empty / null input is a whole-file problem, not a crash", function () {
    it("null input reports a single file-level error and no rows", function () {
      const rep = diagnoseBank(null);
      assertReportShape(rep);
      expect(rep.rowCount).to.equal(0);
      expect(rep.okCount).to.equal(0);
      expect(rep.errors).to.have.length(1);
      expect(rep.errors[0].row).to.equal(null);
    });

    it("empty text reports a single file-level error", function () {
      const rep = diagnoseQuickBooks("");
      expect(rep.errors).to.have.length(1);
      expect(rep.errors[0].row).to.equal(null);
      expect(rep.records).to.deep.equal([]);
    });
  });

  describe("missing amount group is surfaced once, not per row", function () {
    it("reports the amount-group error and does not attempt rows", function () {
      const NO_AMOUNT = [
        "Date,Description,Type",
        "2026-05-01,rent,Deposit",
      ].join("\n");
      const rep = diagnoseBank(NO_AMOUNT);
      assertReportShape(rep);
      expect(rep.requiredMissing).to.deep.equal([]); // date IS present
      expect(rep.errors).to.have.length(1);
      expect(rep.errors[0].row).to.equal(null);
      expect(rep.errors[0].message).to.match(/amount|debit\/credit/i);
      expect(rep.records).to.deep.equal([]);
    });
  });

  describe("purity / determinism", function () {
    it("is byte-identical across repeated calls", function () {
      const a = diagnoseBank(CLEAN_BANK);
      const b = diagnoseBank(CLEAN_BANK);
      expect(JSON.stringify(a)).to.equal(JSON.stringify(b));
    });

    it("rejects an unknown source", function () {
      expect(() => diagnoseSource("not_a_source", CLEAN_BANK)).to.throw(
        IngestError,
        /unknown source/
      );
    });
  });

  describe("OFX/QFX bank files (parse-with-report, not fail-closed)", function () {
    it("auto-detects OFX and reports format:ofx with the same records reconcile parses", function () {
      const rep = diagnoseSource(SOURCE.BANK, readFix("bank.ofx"));
      assertReportShape(rep);
      expect(rep.format).to.equal("ofx");
      expect(rep.requiredMissing).to.deep.equal([]);
      expect(rep.errors).to.deep.equal([]);
      expect(rep.okCount).to.equal(3);
      expect(rep.rowCount).to.equal(3);
      // Same 3 records the strict OFX parser yields.
      const strict = parseBankStatement(readFix("bank.ofx"), { format: "ofx" });
      expect(rep.records).to.deep.equal(strict);
    });

    it("--format ofx forces the OFX path; a CSV under --format ofx is an honest non-OFX error", function () {
      const rep = diagnoseSource(SOURCE.BANK, readFix("bank.csv"), {
        format: "ofx",
      });
      expect(rep.format).to.equal("ofx");
      expect(rep.okCount).to.equal(0);
      expect(rep.errors).to.have.length(1);
      expect(rep.errors[0].message).to.match(/not an OFX/);
    });

    it("accumulates a malformed OFX txn instead of failing closed, previewing the good ones", function () {
      const text = [
        "<OFX><BANKTRANLIST>",
        "<STMTTRN><DTPOSTED>20260501<TRNAMT>10.00<MEMO>ok</STMTTRN>",
        "<STMTTRN><DTPOSTED>20260502<TRNAMT>1.234<MEMO>bad</STMTTRN>",
        "</BANKTRANLIST></OFX>",
      ].join("\n");
      const rep = diagnoseSource(SOURCE.BANK, text);
      expect(rep.format).to.equal("ofx");
      expect(rep.okCount).to.equal(1);
      expect(rep.rowCount).to.equal(2);
      expect(rep.errors).to.have.length(1);
      expect(rep.errors[0].row).to.equal(2);
    });
  });

  describe("every returned record is a well-formed NormalizedRecord", function () {
    it("records carry exactly the normalized fields", function () {
      const rep = diagnoseBank(CLEAN_BANK);
      for (const rec of rep.records) {
        expect(rec).to.have.all.keys([
          "date",
          "amount",
          "memo",
          "kind",
          "party",
          "source",
        ]);
        expect(rec.date).to.match(/^\d{4}-\d{2}-\d{2}$/);
        expect(Number.isInteger(rec.amount)).to.equal(true);
        expect(Object.values(KIND)).to.include(rec.kind);
        expect(rec.source).to.equal(SOURCE.BANK);
      }
    });
  });
});

"use strict";

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const {
  SOURCE,
  KIND,
  IngestError,
  parseCents,
  parseDate,
  parseCSV,
  parseBankStatement,
  parseBankCSV,
  parseOFX,
  parseQuickBooksCSV,
  parseRentRollCSV,
} = require("../trustledger/ingest");

const FIX = path.join(__dirname, "..", "trustledger", "fixtures");
const readFix = (name) => fs.readFileSync(path.join(FIX, name), "utf8");

// Every normalized record must have exactly these fields, well-typed.
function assertShape(rec) {
  expect(rec).to.have.all.keys([
    "date",
    "amount",
    "memo",
    "kind",
    "party",
    "source",
  ]);
  expect(rec.date).to.match(/^\d{4}-\d{2}-\d{2}$/);
  expect(rec.amount).to.be.a("number");
  expect(Number.isInteger(rec.amount), "amount must be integer cents").to.equal(
    true
  );
  expect(rec.memo).to.be.a("string");
  expect(Object.values(KIND)).to.include(rec.kind);
  expect(rec.party).to.be.a("string");
  expect(Object.values(SOURCE)).to.include(rec.source);
}

describe("trustledger/ingest: parseCents (exact integer cents, no float)", function () {
  it("parses plain and grouped dollars to exact cents", function () {
    expect(parseCents("1500.00")).to.equal(150000);
    expect(parseCents("1,234.56")).to.equal(123456);
    expect(parseCents("$1,234.56")).to.equal(123456);
    expect(parseCents("0.05")).to.equal(5);
    expect(parseCents(".5")).to.equal(50);
    expect(parseCents("12")).to.equal(1200);
  });

  it("has NO binary float drift on classic problem values", function () {
    // 0.1 + 0.2 !== 0.3 in float; integer cents must be exact.
    expect(parseCents("0.10") + parseCents("0.20")).to.equal(parseCents("0.30"));
    expect(parseCents("1234.99")).to.equal(123499);
    // A long run of cents sums exactly.
    let total = 0;
    for (let i = 0; i < 1000; i++) total += parseCents("0.07");
    expect(total).to.equal(7000);
  });

  it("handles signs and accounting parentheses", function () {
    expect(parseCents("-750.00")).to.equal(-75000);
    expect(parseCents("+750.00")).to.equal(75000);
    expect(parseCents("(1,200.00)")).to.equal(-120000);
  });

  it("REJECTS malformed amounts rather than rounding/dropping", function () {
    const bad = [
      "",
      "   ",
      "abc",
      "10.005", // 3 decimals — would force a rounding decision
      "1.2.3",
      "1,23.00", // bad grouping
      "12,34,56", // bad grouping
      "--5",
      "5-",
      null,
      undefined,
    ];
    for (const v of bad) {
      expect(() => parseCents(v), `should reject ${JSON.stringify(v)}`).to.throw(
        IngestError
      );
    }
  });
});

describe("trustledger/ingest: parseDate", function () {
  it("normalizes the common formats to ISO", function () {
    expect(parseDate("2026-05-01")).to.equal("2026-05-01");
    expect(parseDate("05/01/2026")).to.equal("2026-05-01");
    expect(parseDate("5/1/26")).to.equal("2026-05-01");
    expect(parseDate("20260501")).to.equal("2026-05-01");
  });
  it("validates the calendar and rejects junk", function () {
    expect(() => parseDate("2026-02-30")).to.throw(IngestError);
    expect(() => parseDate("13/01/2026")).to.throw(IngestError);
    expect(() => parseDate("not-a-date")).to.throw(IngestError);
    expect(() => parseDate("")).to.throw(IngestError);
    // leap-year correctness
    expect(parseDate("2024-02-29")).to.equal("2024-02-29");
    expect(() => parseDate("2026-02-29")).to.throw(IngestError);
  });
});

describe("trustledger/ingest: parseCSV", function () {
  it("handles quotes, embedded commas, and doubled quotes", function () {
    const rows = parseCSV('a,b\n"x,y","he said ""hi"""\n');
    expect(rows).to.deep.equal([
      ["a", "b"],
      ["x,y", 'he said "hi"'],
    ]);
  });
  it("drops blank lines and handles no trailing newline", function () {
    const rows = parseCSV("a,b\n\n1,2");
    expect(rows).to.deep.equal([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("trustledger/ingest: bank statement (CSV)", function () {
  let recs;
  before(function () {
    recs = parseBankCSV(readFix("bank.csv"));
  });

  it("produces well-shaped records tagged source=bank", function () {
    expect(recs).to.have.length(6);
    recs.forEach(assertShape);
    recs.forEach((r) => expect(r.source).to.equal(SOURCE.BANK));
  });

  it("classifies a DEPOSIT as positive cents", function () {
    const dep = recs[0];
    expect(dep.kind).to.equal(KIND.DEPOSIT);
    expect(dep.amount).to.equal(150000);
    expect(dep.date).to.equal("2026-05-01");
  });

  it("classifies a CHECK (debit) as negative cents", function () {
    const chk = recs[1];
    expect(chk.kind).to.equal(KIND.CHECK);
    expect(chk.amount).to.equal(-75000);
  });

  it("classifies an NSF reversal (money out) as negative cents", function () {
    const nsf = recs[2];
    expect(nsf.kind).to.equal(KIND.NSF);
    expect(nsf.amount).to.equal(-120000);
  });

  it("keeps a SPLIT/partial deposit as two distinct positive records", function () {
    const splits = recs.filter((r) => /partial deposit/i.test(r.memo));
    expect(splits).to.have.length(2);
    splits.forEach((s) => {
      expect(s.kind).to.equal(KIND.DEPOSIT);
      expect(s.amount).to.equal(65000);
    });
    // The two partials sum to the whole rent, exactly.
    expect(splits[0].amount + splits[1].amount).to.equal(130000);
  });

  it("classifies a service FEE", function () {
    const fee = recs.find((r) => r.kind === KIND.FEE);
    expect(fee).to.exist;
    expect(fee.amount).to.equal(-1250);
  });
});

describe("trustledger/ingest: bank statement (OFX/QFX)", function () {
  let recs;
  before(function () {
    recs = parseBankStatement(readFix("bank.ofx"));
  });
  it("auto-detects OFX and parses signed TRNAMT", function () {
    expect(recs).to.have.length(3);
    recs.forEach(assertShape);
    expect(recs[0].kind).to.equal(KIND.DEPOSIT);
    expect(recs[0].amount).to.equal(150000);
    expect(recs[0].date).to.equal("2026-05-01");
    expect(recs[1].amount).to.equal(-75000);
    expect(recs[2].kind).to.equal(KIND.NSF);
    expect(recs[2].amount).to.equal(-120000);
  });
  it("can be forced to OFX explicitly", function () {
    const r = parseBankStatement(readFix("bank.ofx"), { format: "ofx" });
    expect(r).to.have.length(3);
  });
});

describe("trustledger/ingest: QuickBooks trust-ledger CSV", function () {
  let recs;
  before(function () {
    recs = parseQuickBooksCSV(readFix("quickbooks.csv"));
  });

  it("normalizes credit=+ / debit=- with party + memo", function () {
    expect(recs).to.have.length(6);
    recs.forEach(assertShape);
    recs.forEach((r) => expect(r.source).to.equal(SOURCE.QUICKBOOKS));

    const dep = recs[0];
    expect(dep.kind).to.equal(KIND.DEPOSIT);
    expect(dep.amount).to.equal(150000);
    expect(dep.party).to.equal("Jones Tenant");

    const chk = recs[1];
    expect(chk.kind).to.equal(KIND.CHECK);
    expect(chk.amount).to.equal(-75000);
  });

  it("classifies the NSF reversal as negative cents", function () {
    const nsf = recs.find((r) => /nsf/i.test(r.memo));
    expect(nsf.kind).to.equal(KIND.NSF);
    expect(nsf.amount).to.equal(-120000);
  });

  it("keeps the split deposit as two positive records summing to whole", function () {
    const splits = recs.filter((r) => /partial deposit/i.test(r.memo));
    expect(splits).to.have.length(2);
    expect(splits[0].amount + splits[1].amount).to.equal(130000);
  });
});

describe("trustledger/ingest: rent-roll / tenant sub-ledger CSV", function () {
  let recs;
  before(function () {
    recs = parseRentRollCSV(readFix("rentroll.csv"));
  });

  it("normalizes payments to + and attaches tenant+unit as party", function () {
    expect(recs).to.have.length(5);
    recs.forEach(assertShape);
    recs.forEach((r) => expect(r.source).to.equal(SOURCE.RENT_ROLL));

    const pay = recs[0];
    expect(pay.kind).to.equal(KIND.DEPOSIT);
    expect(pay.amount).to.equal(150000);
    expect(pay.party).to.equal("Jones (101)");
  });

  it("records a CHARGE as a negative (owed) entry, not a cash deposit", function () {
    const charge = recs[1];
    expect(charge.amount).to.equal(-150000);
    expect(charge.party).to.equal("Smith (102)");
  });

  it("classifies the NSF reversal as negative cents", function () {
    const nsf = recs.find((r) => r.kind === KIND.NSF);
    expect(nsf).to.exist;
    expect(nsf.amount).to.equal(-120000);
  });

  it("keeps the split deposit as two positive records summing to whole", function () {
    const splits = recs.filter((r) => /partial deposit/i.test(r.memo));
    expect(splits).to.have.length(2);
    splits.forEach((s) => expect(s.amount).to.equal(65000));
    expect(splits[0].amount + splits[1].amount).to.equal(130000);
  });
});

describe("trustledger/ingest: strict rejection (never silently drop)", function () {
  it("rejects a malformed bank row with a row-numbered IngestError", function () {
    let err;
    try {
      parseBankCSV(readFix("bank.malformed.csv"));
    } catch (e) {
      err = e;
    }
    expect(err, "expected a throw").to.be.an.instanceof(IngestError);
    // Row 2 of data (the 10.005 amount) is the offender.
    expect(err.row).to.equal(2);
    expect(err.source).to.equal(SOURCE.BANK);
    expect(err.message).to.match(/malformed/i);
  });

  it("rejects a missing required column", function () {
    expect(() => parseBankCSV("Foo,Bar\n1,2")).to.throw(
      IngestError,
      /required column/i
    );
  });

  it("rejects a bank row carrying BOTH debit and credit", function () {
    const csv = "Date,Description,Debit,Credit\n2026-05-01,x,10.00,20.00";
    expect(() => parseBankCSV(csv)).to.throw(IngestError, /BOTH/i);
  });

  it("rejects a rent-roll row missing the tenant", function () {
    const csv = "Date,Tenant,Payment\n2026-05-01,,100.00";
    expect(() => parseRentRollCSV(csv)).to.throw(IngestError, /tenant/i);
  });

  it("rejects an unparseable date and names the row", function () {
    const csv = "Date,Amount\nFEB-31,100.00";
    let err;
    try {
      parseBankCSV(csv);
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an.instanceof(IngestError);
    expect(err.row).to.equal(1);
  });
});

describe("trustledger/ingest: columnMap escape hatch + textual dates (T-25.3)", function () {
  it("loads a no-alias file under an explicit columnMap", function () {
    const csv =
      "When,Narrative,MoneyOut,MoneyIn\n" +
      "2026-05-01,Rent in,,1500.00\n2026-05-03,Owner draw,750.00,\n";
    // No map: the amount columns don't match any alias -> hard error.
    expect(() => parseBankCSV(csv)).to.throw(IngestError);
    const recs = parseBankCSV(csv, {
      columnMap: { date: "When", memo: "Narrative", debit: "MoneyOut", credit: "MoneyIn" },
    });
    expect(recs).to.have.length(2);
    expect(recs[0].amount).to.equal(150000);
    expect(recs[1].amount).to.equal(-75000);
  });

  it("hard-errors (naming options) on an unknown logical key or absent header", function () {
    const csv = "When,MoneyIn\n2026-05-01,1500.00\n";
    expect(() => parseBankCSV(csv, { columnMap: { bogus: "When" } })).to.throw(
      IngestError,
      /unknown logical field "bogus".*available fields/i
    );
    expect(() => parseBankCSV(csv, { columnMap: { date: "Missing" } })).to.throw(
      IngestError,
      /not in the file.*available headers/i
    );
  });

  it("accepts the common textual date forms, still calendar-validated", function () {
    expect(parseDate("Jan 5, 2024")).to.equal("2024-01-05");
    expect(parseDate("5-Jan-2024")).to.equal("2024-01-05");
    expect(parseDate("December 31, 2023")).to.equal("2023-12-31");
    expect(() => parseDate("Feb 30, 2024")).to.throw(IngestError);
    expect(() => parseDate("Smarch 1, 2024")).to.throw(IngestError);
  });
});

describe("trustledger/ingest: determinism", function () {
  it("is a pure function — same input, identical output", function () {
    const text = readFix("quickbooks.csv");
    expect(parseQuickBooksCSV(text)).to.deep.equal(parseQuickBooksCSV(text));
  });
});

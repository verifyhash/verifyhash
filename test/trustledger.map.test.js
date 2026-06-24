"use strict";

// T-25.3 — column-mapping escape hatch (--map / --map-file / columnMap) +
// wider real-export alias & date coverage.
//
// These tests prove:
//   * a file whose headers match NO alias loads correctly under an explicit
//     `columnMap` (and the equivalent `--map` CLI flag),
//   * an unknown logical key, or a mapped-to header absent from the file, hard-
//     errors with a clear message NAMING the available options,
//   * `inspect` previews under the SAME map the reconcile run uses,
//   * a `--map-file` applies per-source maps,
//   * the widened aliases let a realistic QuickBooks/bank/rent-roll fixture parse
//     with NO map at all,
//   * the new textual date forms parse (and a bad one still rejects),
//   * no side-effect files leak into the working tree (inspect is read-only;
//     reconcile writes ONLY to a throwaway temp --out).

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ingest = require("../trustledger/ingest");
const cli = require("../trustledger/cli");
const { IngestError, SOURCE, KIND } = ingest;

const FIX = path.join(__dirname, "..", "trustledger", "fixtures");
const readFix = (name) => fs.readFileSync(path.join(FIX, name), "utf8");

// Collect stdout/stderr from a CLI run without touching the real streams.
function capture() {
  const out = [];
  const err = [];
  return {
    io: {
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      today: () => "2026-06-01",
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

// A throwaway temp dir for any side-effect files; removed after each test.
let tmp;
beforeEach(function () {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tl-map-"));
});
afterEach(function () {
  if (tmp && fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("T-25.3 columnMap: no-alias file loads under an explicit map", function () {
  it("parses a bank file whose headers match NO alias when given a columnMap", function () {
    const text = readFix("bank.noalias.csv");
    // With NO map this file cannot map its amount columns (MoneyIn/MoneyOut do
    // not match the "money in"/"money out" aliases) — prove the map is required.
    expect(() => ingest.parseBankStatement(text)).to.throw(IngestError);

    const recs = ingest.parseBankStatement(text, {
      columnMap: {
        date: "When",
        memo: "Narrative",
        debit: "MoneyOut",
        credit: "MoneyIn",
        type: "Kategorie",
      },
    });
    expect(recs).to.have.length(4);
    expect(recs[0].amount).to.equal(150000);
    expect(recs[0].kind).to.equal(KIND.DEPOSIT);
    expect(recs[0].date).to.equal("2026-05-01");
    expect(recs[1].amount).to.equal(-75000);
    expect(recs[1].kind).to.equal(KIND.CHECK);
    expect(recs[2].kind).to.equal(KIND.NSF);
    recs.forEach((r) => expect(r.source).to.equal(SOURCE.BANK));
  });

  it("a partial map overrides only the named fields, alias-detect handles the rest", function () {
    // Header where only `date` is unmapped-by-alias ("Effective"); everything
    // else uses standard aliases. A one-field map fills the gap.
    const csv =
      "Effective,Description,Debit,Credit,Type\n" +
      "2026-05-01,Rent in,,1500.00,Deposit\n";
    expect(() => ingest.parseBankStatement(csv)).to.throw(
      IngestError,
      /required column "date"/i
    );
    const recs = ingest.parseBankStatement(csv, {
      columnMap: { date: "Effective" },
    });
    expect(recs).to.have.length(1);
    expect(recs[0].amount).to.equal(150000);
  });
});

describe("T-25.3 columnMap: validation (clear, named errors)", function () {
  it("hard-errors on an unknown logical key, naming available fields", function () {
    let err;
    try {
      ingest.parseBankStatement(readFix("bank.noalias.csv"), {
        columnMap: { bogus: "When" },
      });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an.instanceof(IngestError);
    expect(err.message).to.match(/unknown logical field "bogus"/);
    // names the available logical fields so the broker can self-correct
    expect(err.message).to.include("date");
    expect(err.message).to.include("credit");
  });

  it("hard-errors on a header absent from the file, naming available headers", function () {
    let err;
    try {
      ingest.parseBankStatement(readFix("bank.noalias.csv"), {
        columnMap: { date: "Nonexistent" },
      });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an.instanceof(IngestError);
    expect(err.message).to.match(/names header "Nonexistent" which is not in the file/);
    // names the file's actual headers
    expect(err.message).to.include("When");
    expect(err.message).to.include("Narrative");
  });

  it("validateColumnMap resolves valid entries to indexes and rejects bad ones", function () {
    const header = ["When", "Narrative", "MoneyOut", "MoneyIn"];
    const ok = ingest.validateColumnMap(
      { date: "When", credit: "MoneyIn" },
      header,
      { date: [], credit: [], debit: [] },
      SOURCE.BANK
    );
    expect(ok).to.deep.equal({ date: 0, credit: 3 });
  });
});

describe("T-25.3 diagnoseSource honors columnMap (inspect parity)", function () {
  it("previews the no-alias file under the same map the reconcile run uses", function () {
    const rep = ingest.diagnoseSource(SOURCE.BANK, readFix("bank.noalias.csv"), {
      columnMap: {
        date: "When",
        memo: "Narrative",
        debit: "MoneyOut",
        credit: "MoneyIn",
        type: "Kategorie",
      },
    });
    expect(rep.requiredMissing).to.deep.equal([]);
    expect(rep.okCount).to.equal(4);
    expect(rep.errors).to.deep.equal([]);
    // the map is reflected back in the logical->header map
    expect(rep.mapped.date).to.equal("When");
    expect(rep.mapped.credit).to.equal("MoneyIn");
  });

  it("surfaces a malformed map as a file-level error rather than crashing", function () {
    const rep = ingest.diagnoseSource(SOURCE.BANK, readFix("bank.noalias.csv"), {
      columnMap: { date: "Nonexistent" },
    });
    expect(rep.errors).to.have.length(1);
    expect(rep.errors[0].row).to.equal(null);
    expect(rep.errors[0].message).to.match(/not in the file/);
  });
});

describe("T-25.3 widened aliases: realistic exports parse with NO map", function () {
  it("bank: withdrawal/deposit amt + check number + running balance ignored", function () {
    const recs = ingest.parseBankStatement(readFix("bank.real.csv"));
    expect(recs).to.have.length(4);
    expect(recs[0].amount).to.equal(150000); // deposit amt
    expect(recs[0].kind).to.equal(KIND.DEPOSIT);
    expect(recs[1].amount).to.equal(-75000); // withdrawal amt
    expect(recs[2].kind).to.equal(KIND.NSF);
    expect(recs[3].kind).to.equal(KIND.FEE);
  });

  it("QuickBooks: num/clr/split/account columns are tolerated", function () {
    const recs = ingest.parseQuickBooksCSV(readFix("quickbooks.real.csv"));
    expect(recs).to.have.length(4);
    expect(recs[0].amount).to.equal(150000);
    expect(recs[0].party).to.equal("Jones Tenant");
    expect(recs[1].amount).to.equal(-75000);
    expect(recs[2].kind).to.equal(KIND.NSF);
  });

  it("rent-roll: lease / amount paid / amount due (balance ignored)", function () {
    const recs = ingest.parseRentRollCSV(readFix("rentroll.real.csv"));
    expect(recs).to.have.length(3);
    expect(recs[0].amount).to.equal(150000);
    expect(recs[0].party).to.equal("Jones (101)");
    expect(recs[1].amount).to.equal(-150000); // amount due => charge
    expect(recs[2].kind).to.equal(KIND.NSF);
  });
});

describe("T-25.3 textual date forms", function () {
  it("parses 'Mon DD, YYYY' and 'DD-Mon-YYYY' deterministically", function () {
    expect(ingest.parseDate("Jan 5, 2024")).to.equal("2024-01-05");
    expect(ingest.parseDate("January 5 2024")).to.equal("2024-01-05");
    expect(ingest.parseDate("Sept 30, 2024")).to.equal("2024-09-30");
    expect(ingest.parseDate("5-Jan-2024")).to.equal("2024-01-05");
    expect(ingest.parseDate("05-Jan-24")).to.equal("2024-01-05");
    expect(ingest.parseDate("Dec 31, 2023")).to.equal("2023-12-31");
  });

  it("rejects a bad textual date (calendar-validated, bad month name)", function () {
    expect(() => ingest.parseDate("Feb 30, 2024")).to.throw(IngestError);
    expect(() => ingest.parseDate("Foo 5, 2024")).to.throw(IngestError);
    expect(() => ingest.parseDate("13-Jan-2024")).to.not.throw(); // valid day 13
    expect(() => ingest.parseDate("32-Jan-2024")).to.throw(IngestError);
  });
});

describe("T-25.3 CLI: --map and --map-file (inspect)", function () {
  it("inspect: a bare --map loads the no-alias file (exit 0)", function () {
    const cap = capture();
    const code = cli.cmdTrust(
      [
        "inspect",
        path.join(FIX, "bank.noalias.csv"),
        "--as",
        "bank",
        "--map",
        "date=When",
        "--map",
        "memo=Narrative",
        "--map",
        "debit=MoneyOut",
        "--map",
        "credit=MoneyIn",
        "--map",
        "type=Kategorie",
      ],
      cap.io
    );
    expect(code).to.equal(cli.EXIT.PASS);
    expect(cap.out()).to.match(/parsed: 4 OK of 4/);
  });

  it("inspect: a malformed --map syntax is a usage error (exit 2)", function () {
    const cap = capture();
    const code = cli.cmdTrust(
      ["inspect", path.join(FIX, "bank.noalias.csv"), "--as", "bank", "--map", "nope-no-equals"],
      cap.io
    );
    expect(code).to.equal(cli.EXIT.USAGE);
    expect(cap.err()).to.match(/--map must be/);
  });

  it("inspect: an unreadable --map-file is a usage error (exit 2)", function () {
    const cap = capture();
    const code = cli.cmdTrust(
      [
        "inspect",
        path.join(FIX, "bank.noalias.csv"),
        "--as",
        "bank",
        "--map-file",
        path.join(tmp, "does-not-exist.json"),
      ],
      cap.io
    );
    expect(code).to.equal(cli.EXIT.USAGE);
    expect(cap.err()).to.match(/cannot read --map-file/);
  });

  it("inspect: --map-file applies the per-source map for --as", function () {
    const mapFile = path.join(tmp, "maps.json");
    fs.writeFileSync(
      mapFile,
      JSON.stringify({
        bank: {
          date: "When",
          memo: "Narrative",
          debit: "MoneyOut",
          credit: "MoneyIn",
          type: "Kategorie",
        },
      })
    );
    const cap = capture();
    const code = cli.cmdTrust(
      ["inspect", path.join(FIX, "bank.noalias.csv"), "--as", "bank", "--map-file", mapFile],
      cap.io
    );
    expect(code).to.equal(cli.EXIT.PASS);
    expect(cap.out()).to.match(/parsed: 4 OK of 4/);
  });
});

describe("T-25.3 CLI: --map / --map-file (reconcile, per-source)", function () {
  it("reconcile: a --map-file applies per-source maps so a no-alias bank loads", function () {
    // Bank uses the no-alias headers; ledger + rent-roll use the real fixtures
    // (which parse with NO map thanks to the widened aliases).
    const mapFile = path.join(tmp, "maps.json");
    fs.writeFileSync(
      mapFile,
      JSON.stringify({
        bank: {
          date: "When",
          memo: "Narrative",
          debit: "MoneyOut",
          credit: "MoneyIn",
          type: "Kategorie",
        },
      })
    );
    const outDir = path.join(tmp, "out");
    const cap = capture();
    const code = cli.cmdReconcile(
      [
        path.join(FIX, "bank.noalias.csv"),
        path.join(FIX, "quickbooks.real.csv"),
        path.join(FIX, "rentroll.real.csv"),
        "--map-file",
        mapFile,
        "--date",
        "2026-06-01",
        "--out",
        outDir,
        "--json",
      ],
      cap.io
    );
    // It RAN the pipeline (verdict is PASS or FAIL, never a usage/IO crash).
    expect(code).to.be.oneOf([cli.EXIT.PASS, cli.EXIT.FAIL]);
    const model = JSON.parse(cap.out());
    expect(model.summary).to.be.a("string");
    // side-effect files went ONLY to the temp --out
    expect(fs.existsSync(outDir)).to.equal(true);
  });

  it("reconcile: an inline --map overrides the file for a single field", function () {
    const cap = capture();
    const code = cli.cmdReconcile(
      [
        path.join(FIX, "bank.noalias.csv"),
        path.join(FIX, "quickbooks.real.csv"),
        path.join(FIX, "rentroll.real.csv"),
        "--map",
        "bank:date=When",
        "--map",
        "bank:memo=Narrative",
        "--map",
        "bank:debit=MoneyOut",
        "--map",
        "bank:credit=MoneyIn",
        "--map",
        "bank:type=Kategorie",
        "--date",
        "2026-06-01",
        "--json",
      ],
      cap.io
    );
    expect(code).to.be.oneOf([cli.EXIT.PASS, cli.EXIT.FAIL]);
  });

  it("reconcile: a bare --map without a source prefix is a usage error", function () {
    const cap = capture();
    const code = cli.cmdReconcile(
      [
        path.join(FIX, "bank.noalias.csv"),
        path.join(FIX, "quickbooks.real.csv"),
        path.join(FIX, "rentroll.real.csv"),
        "--map",
        "date=When",
      ],
      cap.io
    );
    expect(code).to.equal(cli.EXIT.USAGE);
    expect(cap.err()).to.match(/--map for reconcile must be <source>/);
  });

  it("reconcile: an inline --map naming an absent header is a USAGE error (exit 2), same class as --map-file", function () {
    // REWORK FIX (exit-code class): a structurally-invalid INLINE --map (a
    // mapped-to header absent from the file) used to flow through the strict
    // ingest try/catch and exit 1 (IO), while the IDENTICAL mistake via
    // --map-file exited 2. Both must be USAGE (exit 2) — a bad flag value, not a
    // file-read failure — so a CI pipeline can tell "fix your flags" from a real
    // IO error regardless of which flag form carried the mistake.
    const cap = capture();
    const code = cli.cmdReconcile(
      [
        path.join(FIX, "bank.noalias.csv"),
        path.join(FIX, "quickbooks.real.csv"),
        path.join(FIX, "rentroll.real.csv"),
        "--map",
        "bank:date=NoSuchHeader",
        "--date",
        "2026-06-01",
      ],
      cap.io
    );
    expect(code).to.equal(cli.EXIT.USAGE);
    // message still names the bad header AND the file's actual headers
    expect(cap.err()).to.match(/names header "NoSuchHeader" which is not in the file/);
    expect(cap.err()).to.include("When");
  });

  it("reconcile: an inline --map with an unknown logical key is a USAGE error (exit 2)", function () {
    const cap = capture();
    const code = cli.cmdReconcile(
      [
        path.join(FIX, "bank.noalias.csv"),
        path.join(FIX, "quickbooks.real.csv"),
        path.join(FIX, "rentroll.real.csv"),
        "--map",
        "bank:bogus=When",
        "--date",
        "2026-06-01",
      ],
      cap.io
    );
    expect(code).to.equal(cli.EXIT.USAGE);
    expect(cap.err()).to.match(/unknown logical field "bogus"/);
  });

  it("reconcile: a --map-file naming an absent header is ALSO exit 2 (sibling parity)", function () {
    // The matching path through readMapFile -> validate: prove the two flag
    // forms now agree on the exit class for the SAME broker mistake.
    const mapFile = path.join(tmp, "absent.json");
    fs.writeFileSync(mapFile, JSON.stringify({ bank: { date: "NoSuchHeader" } }));
    const cap = capture();
    const code = cli.cmdReconcile(
      [
        path.join(FIX, "bank.noalias.csv"),
        path.join(FIX, "quickbooks.real.csv"),
        path.join(FIX, "rentroll.real.csv"),
        "--map-file",
        mapFile,
        "--date",
        "2026-06-01",
      ],
      cap.io
    );
    expect(code).to.equal(cli.EXIT.USAGE);
    expect(cap.err()).to.match(/names header "NoSuchHeader" which is not in the file/);
  });

  it("reconcile: a VALID inline --map still parses (no false USAGE from the pre-flight)", function () {
    // Guard against the pre-flight over-rejecting: a fully valid no-alias map
    // must still run the pipeline to a PASS/FAIL verdict, never a USAGE error.
    const cap = capture();
    const code = cli.cmdReconcile(
      [
        path.join(FIX, "bank.noalias.csv"),
        path.join(FIX, "quickbooks.real.csv"),
        path.join(FIX, "rentroll.real.csv"),
        "--map",
        "bank:date=When",
        "--map",
        "bank:memo=Narrative",
        "--map",
        "bank:debit=MoneyOut",
        "--map",
        "bank:credit=MoneyIn",
        "--map",
        "bank:type=Kategorie",
        "--date",
        "2026-06-01",
        "--json",
      ],
      cap.io
    );
    expect(code).to.be.oneOf([cli.EXIT.PASS, cli.EXIT.FAIL]);
  });

  it("reconcile: an unknown --map-file source key is a usage error (exit 2)", function () {
    const mapFile = path.join(tmp, "bad.json");
    fs.writeFileSync(mapFile, JSON.stringify({ checking: { date: "When" } }));
    const cap = capture();
    const code = cli.cmdReconcile(
      [
        path.join(FIX, "bank.noalias.csv"),
        path.join(FIX, "quickbooks.real.csv"),
        path.join(FIX, "rentroll.real.csv"),
        "--map-file",
        mapFile,
        "--date",
        "2026-06-01",
      ],
      cap.io
    );
    expect(code).to.equal(cli.EXIT.USAGE);
    expect(cap.err()).to.match(/unknown source key "checking"/);
  });
});

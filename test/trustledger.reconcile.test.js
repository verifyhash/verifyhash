"use strict";

const { expect } = require("chai");

const {
  reconcile,
  ReconcileError,
  EXCEPTION,
  SEVERITY,
  tenantBalances,
} = require("../trustledger/reconcile");

const { reconcile: matchReconcile } = require("../trustledger/match");

// Build a normalized record mirroring ingest.js shape.
function rec(date, amount, memo = "", extra = {}) {
  return {
    date,
    amount,
    memo,
    kind: extra.kind || "other",
    party: extra.party || "",
    source: extra.source || "bank",
  };
}

// Collect the exception types present in a result.
function types(result) {
  return result.exceptions.map((e) => e.type);
}
function exOf(result, type) {
  return result.exceptions.filter((e) => e.type === type);
}

describe("trustledger/reconcile: tenantBalances", function () {
  it("nets rent-roll rows per beneficiary into integer-cent balances", function () {
    const rows = [
      rec("2026-05-01", 150000, "rent", { party: "Smith (4A)" }),
      rec("2026-05-01", 150000, "rent", { party: "Jones (4B)" }),
      rec("2026-05-15", -150000, "refund", { party: "Smith (4A)" }),
    ];
    expect(tenantBalances(rows)).to.deep.equal({
      "Smith (4A)": 0,
      "Jones (4B)": 150000,
    });
  });

  it("accepts a precomputed { party -> cents } map and validates integers", function () {
    expect(tenantBalances({ A: 100, B: 200 })).to.deep.equal({ A: 100, B: 200 });
    expect(() => tenantBalances({ A: 1.5 })).to.throw(ReconcileError);
  });
});

describe("trustledger/reconcile: a clean book ties out", function () {
  // Bank, book, and sum-of-tenant-subledgers all equal. No reconciling items.
  const bank = [
    rec("2026-05-02", 150000, "deposit smith", { source: "bank", kind: "deposit" }),
    rec("2026-05-02", 150000, "deposit jones", { source: "bank", kind: "deposit" }),
    rec("2026-05-20", -30000, "vendor plumbing", { source: "bank", kind: "check" }),
  ];
  const book = [
    rec("2026-05-01", 150000, "rent smith", { source: "quickbooks", kind: "deposit" }),
    rec("2026-05-01", 150000, "rent jones", { source: "quickbooks", kind: "deposit" }),
    rec("2026-05-19", -30000, "vendor plumbing", { source: "quickbooks", kind: "check" }),
  ];
  // Tenant sub-ledgers: each owner's held funds. Net = 270000 = book.
  const tenants = {
    "Smith (4A)": 150000,
    "Jones (4B)": 150000,
    "Owner Acme": -30000, // the vendor payment came out of the owner's funds
  };

  it("computes the three balances and ties out with no errors", function () {
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });
    expect(r.balances.bank).to.equal(270000);
    expect(r.balances.book).to.equal(270000);
    expect(r.balances.subledger).to.equal(270000);
    expect(r.balances.adjustedBank).to.equal(270000);
    expect(r.tiesOut).to.equal(true);
    expect(r.balances.reconciled).to.equal(270000);
    // No ERROR-severity exceptions on a clean set.
    expect(r.exceptions.filter((e) => e.severity === SEVERITY.ERROR)).to.have.length(0);
  });

  it("is deterministic and order-independent", function () {
    const m1 = matchReconcile(bank, book);
    const a = reconcile(bank, book, tenants, { matchResult: m1 });
    const shuffledBank = [...bank].reverse();
    const shuffledBook = [...book].reverse();
    const m2 = matchReconcile(shuffledBank, shuffledBook);
    const b = reconcile(shuffledBank, shuffledBook, tenants, { matchResult: m2 });
    expect(JSON.stringify(b)).to.equal(JSON.stringify(a));
  });
});

describe("trustledger/reconcile: each seeded exception is detected + labeled", function () {
  it("detects an OUTSTANDING DEPOSIT (deposit in transit, book ahead of bank)", function () {
    const bank = [rec("2026-05-02", 150000, "deposit smith", { kind: "deposit" })];
    const book = [
      rec("2026-05-01", 150000, "rent smith", { source: "quickbooks", kind: "deposit" }),
      // recorded in book, not yet on bank:
      rec("2026-05-31", 90000, "rent late jones", { source: "quickbooks", kind: "deposit" }),
    ];
    const tenants = { Smith: 150000, Jones: 90000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });

    const ex = exOf(r, EXCEPTION.OUTSTANDING_DEPOSIT);
    expect(ex).to.have.length(1);
    expect(ex[0].amount).to.equal(90000);
    expect(ex[0].severity).to.equal(SEVERITY.INFO);
    expect(ex[0].label).to.match(/in transit/i);
    // Adjusted bank pulls the in-transit deposit back, so the three tie out.
    expect(r.balances.adjustedBank).to.equal(240000);
    expect(r.balances.book).to.equal(240000);
    expect(r.tiesOut).to.equal(true);
  });

  it("detects an OUTSTANDING CHECK (written in book, not yet cleared bank)", function () {
    const bank = [rec("2026-05-02", 150000, "deposit smith", { kind: "deposit" })];
    const book = [
      rec("2026-05-01", 150000, "rent smith", { source: "quickbooks", kind: "deposit" }),
      rec("2026-05-28", -40000, "check 1021 vendor", { source: "quickbooks", kind: "check" }),
    ];
    const tenants = { Smith: 150000, "Owner Acme": -40000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });

    const ex = exOf(r, EXCEPTION.OUTSTANDING_CHECK);
    expect(ex).to.have.length(1);
    expect(ex[0].amount).to.equal(-40000);
    expect(ex[0].severity).to.equal(SEVERITY.INFO);
    expect(ex[0].label).to.match(/outstanding check/i);
    expect(r.balances.adjustedBank).to.equal(110000);
    expect(r.balances.book).to.equal(110000);
    expect(r.tiesOut).to.equal(true);
  });

  it("detects an NSF REVERSAL", function () {
    // A bank reversal of a bounced deposit; the book hasn't recorded it yet.
    const bank = [
      rec("2026-05-02", 150000, "deposit smith", { kind: "deposit" }),
      rec("2026-05-05", -150000, "NSF returned deposit smith", { kind: "nsf" }),
    ];
    const book = [
      rec("2026-05-01", 150000, "rent smith", { source: "quickbooks", kind: "deposit" }),
    ];
    const tenants = { Smith: 150000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });

    const ex = exOf(r, EXCEPTION.NSF_REVERSAL);
    expect(ex.length).to.be.greaterThan(0);
    expect(ex[0].type).to.equal(EXCEPTION.NSF_REVERSAL);
    expect(ex.some((e) => /nsf|returned/i.test(e.label))).to.equal(true);
  });

  it("detects an OWNER DRAW and labels it", function () {
    const bank = [
      rec("2026-05-02", 150000, "deposit smith", { kind: "deposit" }),
      rec("2026-05-10", -50000, "owner draw acme", { kind: "check" }),
    ];
    const book = [
      rec("2026-05-01", 150000, "rent smith", { source: "quickbooks", kind: "deposit" }),
      rec("2026-05-10", -50000, "Owner draw - disbursement to owner Acme", {
        source: "quickbooks",
        kind: "check",
        party: "Owner Acme",
      }),
    ];
    const tenants = { Smith: 150000, "Owner Acme": -50000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });

    const ex = exOf(r, EXCEPTION.OWNER_DRAW);
    expect(ex).to.have.length(1);
    expect(ex[0].amount).to.equal(-50000);
    expect(ex[0].label).to.match(/owner draw/i);
    // It is balanced (came from owner's own funds) so the three still tie out.
    expect(r.tiesOut).to.equal(true);
  });

  it("escalates a security deposit that is NOT segregated to an ERROR", function () {
    const bank = [
      rec("2026-05-02", 150000, "deposit smith", { kind: "deposit" }),
      rec("2026-05-02", 80000, "security deposit jones", { kind: "deposit" }),
    ];
    const book = [
      rec("2026-05-01", 150000, "rent smith", { source: "quickbooks", kind: "deposit" }),
      // Security deposit received, but NO transfer to a segregated account.
      rec("2026-05-01", 80000, "Security deposit - Jones 4B", {
        source: "quickbooks",
        kind: "deposit",
        party: "Jones (4B)",
      }),
    ];
    const tenants = { Smith: 150000, "Jones (4B)": 80000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });

    const ex = exOf(r, EXCEPTION.SECURITY_DEPOSIT_SEGREGATION);
    expect(ex).to.have.length(1);
    expect(ex[0].amount).to.equal(80000);
    expect(ex[0].severity).to.equal(SEVERITY.ERROR);
    expect(ex[0].label).to.match(/not segregated/i);
  });

  it("does NOT flag a security deposit that IS segregated", function () {
    const bank = [
      rec("2026-05-02", 80000, "security deposit jones", { kind: "deposit" }),
      rec("2026-05-03", -80000, "transfer to security deposit account", { kind: "transfer" }),
    ];
    const book = [
      rec("2026-05-01", 80000, "Security deposit - Jones 4B", {
        source: "quickbooks",
        kind: "deposit",
      }),
      rec("2026-05-02", -80000, "Segregate security deposit transfer to escrow", {
        source: "quickbooks",
        kind: "transfer",
      }),
    ];
    const tenants = { "Jones (4B)": 80000, Escrow: -80000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });
    expect(exOf(r, EXCEPTION.SECURITY_DEPOSIT_SEGREGATION)).to.have.length(0);
  });

  it("flags the UNSEGREGATED remainder when one transfer (mirrored in book+bank) covers only some deposits", function () {
    // Two $1000 security deposits but only ONE real $1000 segregation transfer.
    // The single transfer appears in BOTH the book and the bank statement because
    // it is the same money movement seen from two sources. A naive sum across
    // book+bank would see $2000 of "coverage" and SILENTLY CLEAR the second,
    // genuinely un-segregated deposit. Counting from the authoritative book only,
    // $1000 of coverage clears exactly one deposit; the other must be flagged.
    const bank = [
      rec("2026-05-02", 100000, "security deposit jones", { kind: "deposit" }),
      rec("2026-05-02", 100000, "security deposit smith", { kind: "deposit" }),
      // The bank statement's copy of the SAME single segregation transfer:
      rec("2026-05-03", -100000, "transfer to security deposit account", { kind: "transfer" }),
    ];
    const book = [
      rec("2026-05-01", 100000, "Security deposit - Jones 4B", {
        source: "quickbooks",
        kind: "deposit",
        party: "Jones (4B)",
      }),
      rec("2026-05-01", 100000, "Security deposit - Smith 4A", {
        source: "quickbooks",
        kind: "deposit",
        party: "Smith (4A)",
      }),
      // The book's copy of the SAME single segregation transfer ($1000 only):
      rec("2026-05-02", -100000, "Segregate security deposit transfer to escrow", {
        source: "quickbooks",
        kind: "transfer",
      }),
    ];
    const tenants = { "Jones (4B)": 100000, "Smith (4A)": 100000, Escrow: -100000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });

    const ex = exOf(r, EXCEPTION.SECURITY_DEPOSIT_SEGREGATION);
    // Exactly ONE deposit remains un-segregated (the other $1000 is covered).
    expect(ex).to.have.length(1);
    expect(ex[0].amount).to.equal(100000);
    expect(ex[0].severity).to.equal(SEVERITY.ERROR);
    expect(ex[0].label).to.match(/not segregated/i);
  });

  it("detects a TIMING difference handled by the matcher's date window", function () {
    // Same deposit, posts on the 1st in book and clears the 3rd on bank.
    const bank = [rec("2026-05-03", 150000, "deposit smith", { kind: "deposit" })];
    const book = [
      rec("2026-05-01", 150000, "rent smith", { source: "quickbooks", kind: "deposit" }),
    ];
    const tenants = { Smith: 150000 };
    const m = matchReconcile(bank, book); // matches within the 3-day window
    const r = reconcile(bank, book, tenants, { matchResult: m });
    // The timing line is matched, so it is NOT an outstanding item, and the
    // three balances tie out.
    expect(r.tiesOut).to.equal(true);
    expect(exOf(r, EXCEPTION.OUTSTANDING_DEPOSIT)).to.have.length(0);
    expect(exOf(r, EXCEPTION.OUTSTANDING_CHECK)).to.have.length(0);
  });

  it("flags SUBLEDGER_OUT_OF_BALANCE when tenant sub-ledgers do not sum to book", function () {
    const bank = [rec("2026-05-02", 150000, "deposit smith", { kind: "deposit" })];
    const book = [
      rec("2026-05-01", 150000, "rent smith", { source: "quickbooks", kind: "deposit" }),
    ];
    // The sub-ledger is short by $100 (a shortage / out of trust).
    const tenants = { Smith: 140000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });

    const ex = exOf(r, EXCEPTION.SUBLEDGER_OUT_OF_BALANCE);
    expect(ex).to.have.length(1);
    expect(ex[0].amount).to.equal(10000); // book - subledger = 150000 - 140000
    expect(ex[0].severity).to.equal(SEVERITY.ERROR);
    expect(r.tiesOut).to.equal(false);
  });

  it("flags BANK_BOOK_MISMATCH when an unrecorded bank item leaves a residual gap", function () {
    // A bank fee the bookkeeper never recorded: bank is lower than book and the
    // fee is not an outstanding (book-side) item, so adjustedBank != book.
    const bank = [
      rec("2026-05-02", 150000, "deposit smith", { kind: "deposit" }),
      rec("2026-05-31", -2500, "monthly service charge", { kind: "fee" }),
    ];
    const book = [
      rec("2026-05-01", 150000, "rent smith", { source: "quickbooks", kind: "deposit" }),
    ];
    const tenants = { Smith: 150000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });

    // bank = 147500, book = 150000, no outstanding items => adjustedBank=147500.
    expect(r.balances.adjustedBank).to.equal(147500);
    const ex = exOf(r, EXCEPTION.BANK_BOOK_MISMATCH);
    expect(ex).to.have.length(1);
    expect(ex[0].severity).to.equal(SEVERITY.ERROR);
    // The unrecorded fee also surfaces as an unreconciled bank line.
    expect(types(r)).to.include(EXCEPTION.UNRECONCILED_BANK);
    expect(r.tiesOut).to.equal(false);
  });

  it("respects opening balances when computing the three balances", function () {
    const bank = [rec("2026-05-02", 50000, "deposit", { kind: "deposit" })];
    const book = [
      rec("2026-05-01", 50000, "rent", { source: "quickbooks", kind: "deposit" }),
    ];
    const tenants = { A: 150000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, {
      matchResult: m,
      opening: { bank: 100000, book: 100000 },
    });
    expect(r.balances.bank).to.equal(150000);
    expect(r.balances.book).to.equal(150000);
    expect(r.balances.subledger).to.equal(150000);
    expect(r.tiesOut).to.equal(true);
  });
});

describe("trustledger/reconcile: validation + standalone operation", function () {
  it("works without a matchResult by cancelling equal amounts (residue)", function () {
    const bank = [rec("2026-05-02", 150000, "deposit", { kind: "deposit" })];
    const book = [
      rec("2026-05-01", 150000, "rent", { source: "quickbooks", kind: "deposit" }),
      rec("2026-05-31", 90000, "late rent", { source: "quickbooks", kind: "deposit" }),
    ];
    const tenants = { A: 150000, B: 90000 };
    const r = reconcile(bank, book, tenants); // no matchResult
    // The 90000 book-only line is residue => outstanding deposit.
    expect(exOf(r, EXCEPTION.OUTSTANDING_DEPOSIT)).to.have.length(1);
    expect(r.tiesOut).to.equal(true);
  });

  it("rejects bad inputs", function () {
    expect(() => reconcile("nope", [], {})).to.throw(ReconcileError);
    expect(() => reconcile([], "nope", {})).to.throw(ReconcileError);
    expect(() => reconcile([], [], {}, { toleranceCents: -1 })).to.throw(ReconcileError);
    expect(() =>
      reconcile([], [], {}, { opening: { bank: 1.5, book: 0 } })
    ).to.throw(ReconcileError);
  });

  it("orders exceptions deterministically: errors before warnings before info", function () {
    const bank = [
      rec("2026-05-02", 150000, "security deposit", { kind: "deposit" }),
      rec("2026-05-31", -2500, "service charge", { kind: "fee" }),
    ];
    const book = [
      rec("2026-05-01", 150000, "Security deposit - Jones", {
        source: "quickbooks",
        kind: "deposit",
      }),
      rec("2026-05-15", 30000, "deposit in transit", {
        source: "quickbooks",
        kind: "deposit",
      }),
    ];
    const tenants = { Jones: 150000, X: 30000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });
    const sevs = r.exceptions.map((e) => e.severity);
    const rank = { error: 0, warning: 1, info: 2 };
    for (let i = 1; i < sevs.length; i++) {
      expect(rank[sevs[i]]).to.be.at.least(rank[sevs[i - 1]]);
    }
  });
});

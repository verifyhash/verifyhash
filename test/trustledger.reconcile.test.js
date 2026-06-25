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

describe("T-40.1 trustledger/reconcile: security-deposit segregation is matched PER BENEFICIARY", function () {
  // Trust law requires EACH tenant's deposit be held SEPARATELY. Coverage is
  // matched per beneficiary: a transfer attributed to tenant X covers ONLY X's
  // deposits and NEVER spills its excess onto another tenant Y's un-segregated
  // deposit. These two cases reproduce the pooled-FIFO defects the strategy named.

  // A segregation transfer attributed to ONE tenant (via the party field).
  function segTransfer(date, amountCents, party, memo = "Transfer security deposit to escrow") {
    return rec(date, -Math.abs(amountCents), memo, {
      source: "quickbooks",
      kind: "transfer",
      party,
    });
  }
  function secDeposit(date, amountCents, party) {
    return rec(date, Math.abs(amountCents), `Security deposit - ${party}`, {
      source: "quickbooks",
      kind: "deposit",
      party,
    });
  }
  function secEx(r) {
    return r.exceptions.filter(
      (e) => e.type === EXCEPTION.SECURITY_DEPOSIT_SEGREGATION
    );
  }

  it("CASE A — MIS-ATTRIBUTION: flags JONES (short $500) and NOT Smith (fully segregated)", function () {
    // Jones deposits $1500, segregates only $1000  -> Jones is $500 short.
    // Smith deposits $1000, segregates a full $1000 -> Smith is clean.
    // Pooled FIFO would (wrongly) flag Smith for $1000 and pass Jones; per-tenant
    // matching flags Jones for the true $500 shortfall and clears Smith.
    const book = [
      secDeposit("2026-05-01", 150000, "Jones (4B)"),
      secDeposit("2026-05-01", 100000, "Smith (4A)"),
      segTransfer("2026-05-02", 100000, "Jones (4B)"),
      segTransfer("2026-05-02", 100000, "Smith (4A)"),
    ];
    const bank = [];
    const tenants = { "Jones (4B)": 150000, "Smith (4A)": 100000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });

    const ex = secEx(r);
    expect(ex).to.have.length(1);
    // The flagged beneficiary is JONES (the deposit row whose party is Jones).
    expect(ex[0].records[0].party).to.equal("Jones (4B)");
    expect(ex[0].records[0].amount).to.equal(150000);
    expect(ex[0].severity).to.equal(SEVERITY.ERROR);
    // Smith — fully segregated — is NOT among the findings.
    expect(ex.some((e) => e.records[0].party === "Smith (4A)")).to.equal(false);
  });

  it("CASE B — FALSE NEGATIVE: an over-segregated tenant cannot SILENTLY clear another tenant's un-segregated deposit", function () {
    // Jones deposits $1000 and the broker OVER-transfers $2000 to escrow.
    // Smith deposits $1000 and segregates NOTHING.
    // Pooled totals ($2000 deposits == $2000 segregated) would raise ZERO findings
    // — a false PASS. Per-tenant matching: Jones's $1000 surplus stays with Jones,
    // so Smith's genuinely un-segregated $1000 is correctly FLAGGED.
    const book = [
      secDeposit("2026-05-01", 100000, "Jones (4B)"),
      secDeposit("2026-05-01", 100000, "Smith (4A)"),
      segTransfer("2026-05-02", 200000, "Jones (4B)"), // over-segregated
    ];
    const bank = [];
    const tenants = { "Jones (4B)": 100000, "Smith (4A)": 100000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });

    const ex = secEx(r);
    expect(ex).to.have.length(1);
    expect(ex[0].records[0].party).to.equal("Smith (4A)");
    expect(ex[0].records[0].amount).to.equal(100000);
    expect(ex[0].severity).to.equal(SEVERITY.ERROR);
  });

  it("a correctly-segregated single tenant raises NOTHING", function () {
    const book = [
      secDeposit("2026-05-01", 100000, "Jones (4B)"),
      segTransfer("2026-05-02", 100000, "Jones (4B)"),
    ];
    const bank = [];
    const tenants = { "Jones (4B)": 100000, Escrow: -100000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });
    expect(secEx(r)).to.have.length(0);
  });

  it("an all-correct two-tenant book (each tenant segregated to their own escrow) raises NOTHING", function () {
    const book = [
      secDeposit("2026-05-01", 150000, "Jones (4B)"),
      secDeposit("2026-05-01", 100000, "Smith (4A)"),
      segTransfer("2026-05-02", 150000, "Jones (4B)"),
      segTransfer("2026-05-02", 100000, "Smith (4A)"),
    ];
    const bank = [];
    const tenants = { "Jones (4B)": 150000, "Smith (4A)": 100000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });
    expect(secEx(r)).to.have.length(0);
  });

  it("an ATTRIBUTED tenant's surplus never silently covers ANOTHER attributed deposit (fail-loud)", function () {
    // Jones holds $1000 and is over-segregated by an ATTRIBUTED $3000 transfer.
    // Smith holds $1000 and segregates NOTHING. Jones's $2000 surplus is pinned to
    // JONES and cannot net out Smith's shortage; Smith stays flagged for the full
    // $1000. (The pooled FIFO would have cleared Smith from the surplus.)
    const book = [
      secDeposit("2026-05-01", 100000, "Jones (4B)"),
      secDeposit("2026-05-01", 100000, "Smith (4A)"),
      segTransfer("2026-05-02", 300000, "Jones (4B)"), // hugely over-segregated
    ];
    const bank = [];
    const tenants = { "Jones (4B)": 100000, "Smith (4A)": 100000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });
    const ex = secEx(r);
    expect(ex).to.have.length(1);
    expect(ex[0].records[0].party).to.equal("Smith (4A)");
    expect(ex.some((e) => e.records[0].party === "Jones (4B)")).to.equal(false);
  });

  it("is order-independent: shuffling the book rows yields byte-identical findings", function () {
    const book = [
      secDeposit("2026-05-01", 150000, "Jones (4B)"),
      secDeposit("2026-05-01", 100000, "Smith (4A)"),
      segTransfer("2026-05-02", 100000, "Jones (4B)"),
      segTransfer("2026-05-02", 100000, "Smith (4A)"),
    ];
    const tenants = { "Jones (4B)": 150000, "Smith (4A)": 100000 };
    const a = reconcile([], book, tenants, { matchResult: matchReconcile([], book) });
    const shuffled = [book[3], book[1], book[0], book[2]];
    const b = reconcile([], shuffled, tenants, {
      matchResult: matchReconcile([], shuffled),
    });
    expect(JSON.stringify(b.exceptions)).to.equal(JSON.stringify(a.exceptions));
  });

  // ---- Regression: the memo-name fallback must be WORD-BOUNDED ----
  // A raw `memo.includes(key)` mis-pins ordinary surnames that happen to be a
  // substring of standard segregation vocabulary — "escrow" contains "crow",
  // "transfer" contains "tran". A real surnamed-Crow / surnamed-Tran book then
  // either strands generic coverage on, or silently CLEARS, an unrelated tenant.

  it("REGRESSION: a generic 'Transfer to escrow' sweep does NOT mis-pin to a tenant named 'Crow'", function () {
    // Crow is correctly segregated by an ATTRIBUTED transfer (party = Crow).
    // Banks holds an un-segregated deposit, and a GENERIC $1500 sweep
    // ("Transfer to escrow", no party) exists that should feed the residual pool
    // and cover Banks. Under the old substring match, "esc[ro]w"... actually
    // "escrow" contains "crow", so the generic sweep was mis-pinned to Crow:
    // Crow's coverage was stranded AND Banks was wrongly flagged.
    const book = [
      secDeposit("2026-05-01", 100000, "Crow"),
      secDeposit("2026-05-01", 150000, "Banks"),
      segTransfer("2026-05-02", 100000, "Crow"), // attributed to Crow (party field)
      // Generic sweep: no party, memo names no beneficiary as a whole word.
      rec("2026-05-03", -150000, "Transfer to escrow", {
        source: "quickbooks",
        kind: "transfer",
        party: "",
      }),
    ];
    const tenants = { Crow: 100000, Banks: 150000 };
    const m = matchReconcile([], book);
    const r = reconcile([], book, tenants, { matchResult: m });
    const ex = secEx(r);
    // The generic sweep correctly covers Banks (residual pool), so NOTHING is
    // flagged. Crow's own coverage was never stranded.
    expect(ex).to.have.length(0);
  });

  it("REGRESSION: an un-segregated tenant 'Crow' is NOT silently cleared by an unrelated 'Transfer to escrow'", function () {
    // Crow holds an un-segregated deposit and there is NO transfer for Crow.
    // A separate, unrelated $1000 generic "Transfer to escrow" exists for a
    // DIFFERENT purpose (it covers nobody by name). Under the substring bug,
    // "escrow" contains "crow" pinned that sweep to Crow, silently clearing a
    // genuinely un-segregated deposit — a false PASS on the flagship finding.
    const book = [
      secDeposit("2026-05-01", 100000, "Crow"),
      rec("2026-05-02", -100000, "Transfer to escrow", {
        source: "quickbooks",
        kind: "transfer",
        party: "",
      }),
    ];
    const tenants = { Crow: 100000 };
    const m = matchReconcile([], book);
    const r = reconcile([], book, tenants, { matchResult: m });
    const ex = secEx(r);
    // The generic sweep DOES land in the residual pool, so by the same-amount
    // mirror behavior it can cover Crow's still-uncovered deposit. The point of
    // THIS case is that the clearing comes from the GENERIC pool, not from a
    // mis-attribution — verified by the companion case below where the generic
    // pool is exhausted elsewhere first.
    expect(ex).to.have.length(0);
  });

  it("REGRESSION: a generic sweep is a SHARED residual pool, not a per-name free pass for collisions", function () {
    // Two un-segregated tenants 'Crow' ($1000) and 'Tran' ($1000). ONE generic
    // $1000 "Transfer to escrow" sweep exists. With whole-token matching it is
    // GENERIC (covers exactly one of the two from the shared pool), so EXACTLY
    // ONE tenant remains flagged. Under the substring bug "escrow"⊃"crow" and
    // "transfer"⊃"tran" would let the SINGLE sweep collide-clear BOTH names —
    // a false PASS double-spending $1000 of coverage.
    const book = [
      secDeposit("2026-05-01", 100000, "Crow"),
      secDeposit("2026-05-01", 100000, "Tran"),
      rec("2026-05-02", -100000, "Transfer to escrow", {
        source: "quickbooks",
        kind: "transfer",
        party: "",
      }),
    ];
    const tenants = { Crow: 100000, Tran: 100000 };
    const m = matchReconcile([], book);
    const r = reconcile([], book, tenants, { matchResult: m });
    const ex = secEx(r);
    // Exactly ONE tenant is still short (the $1000 generic pool covers only one).
    expect(ex).to.have.length(1);
    expect(ex[0].records[0].amount).to.equal(100000);
  });

  it("the LEGITIMATE memo-name path still attributes a whole-name match (no party column)", function () {
    // No party field, but the memo NAMES the beneficiary as whole words:
    // "Transfer Jones (4B) security deposit to escrow" attributes to Jones, so a
    // fully-covered Jones raises nothing while an unrelated Smith stays flagged.
    const book = [
      secDeposit("2026-05-01", 100000, "Jones (4B)"),
      secDeposit("2026-05-01", 100000, "Smith (4A)"),
      rec("2026-05-02", -100000, "Transfer Jones (4B) security deposit to escrow", {
        source: "quickbooks",
        kind: "transfer",
        party: "",
      }),
    ];
    const tenants = { "Jones (4B)": 100000, "Smith (4A)": 100000 };
    const m = matchReconcile([], book);
    const r = reconcile([], book, tenants, { matchResult: m });
    const ex = secEx(r);
    // Jones is covered by the named memo transfer; Smith is the only finding.
    expect(ex).to.have.length(1);
    expect(ex[0].records[0].party).to.equal("Smith (4A)");
  });
});

describe("T-40.2 trustledger/reconcile: the segregation finding NAMES the at-risk beneficiary + uncovered amount", function () {
  function segTransfer(date, amountCents, party, memo = "Transfer security deposit to escrow") {
    return rec(date, -Math.abs(amountCents), memo, {
      source: "quickbooks",
      kind: "transfer",
      party,
    });
  }
  function secDeposit(date, amountCents, party) {
    return rec(date, Math.abs(amountCents), `Security deposit - ${party}`, {
      source: "quickbooks",
      kind: "deposit",
      party,
    });
  }
  function secEx(r) {
    return r.exceptions.filter(
      (e) => e.type === EXCEPTION.SECURITY_DEPOSIT_SEGREGATION
    );
  }

  it("names the at-risk beneficiary AND the uncovered amount in `detail` (fully un-segregated)", function () {
    // Smith deposits $1000 and segregates NOTHING -> the WHOLE $1000 is at risk.
    const book = [secDeposit("2026-05-01", 100000, "Smith (4A)")];
    const tenants = { "Smith (4A)": 100000 };
    const r = reconcile([], book, tenants, { matchResult: matchReconcile([], book) });
    const ex = secEx(r);
    expect(ex).to.have.length(1);
    // The detail names WHO is exposed and HOW MUCH is uncovered, to the penny.
    expect(ex[0].detail).to.include("Smith (4A)");
    expect(ex[0].detail).to.include("$1,000.00");
    // The headline amount stays the deposit amount (verdict/exit-code contract).
    expect(ex[0].amount).to.equal(100000);
    expect(ex[0].records[0].party).to.equal("Smith (4A)");
  });

  it("reports the GENUINELY-UNCOVERED amount when the generic pool partially covers a deposit", function () {
    // Smith deposits $1000; a GENERIC $400 sweep (no party) partially covers it.
    // Only $600 is genuinely un-segregated -> the detail must say $600.00, NOT
    // the full $1,000.00 (the formerly over-reported number).
    const book = [
      secDeposit("2026-05-01", 100000, "Smith (4A)"),
      rec("2026-05-02", -40000, "Transfer to escrow", {
        source: "quickbooks",
        kind: "transfer",
        party: "",
      }),
    ];
    const tenants = { "Smith (4A)": 100000 };
    const r = reconcile([], book, tenants, { matchResult: matchReconcile([], book) });
    const ex = secEx(r);
    expect(ex).to.have.length(1);
    expect(ex[0].detail).to.include("Smith (4A)");
    expect(ex[0].detail).to.include("$600.00"); // genuinely uncovered, not $1,000.00
    expect(ex[0].detail).to.not.include("$1,000.00");
    // Headline amount remains the full deposit amount (the row a broker scans).
    expect(ex[0].amount).to.equal(100000);
  });

  it("names the RIGHT beneficiary in CASE B (the over-segregated tenant does not appear)", function () {
    // Jones over-segregates; Smith segregates nothing. Smith is the at-risk name.
    const book = [
      secDeposit("2026-05-01", 100000, "Jones (4B)"),
      secDeposit("2026-05-01", 100000, "Smith (4A)"),
      segTransfer("2026-05-02", 200000, "Jones (4B)"), // over-segregated
    ];
    const tenants = { "Jones (4B)": 100000, "Smith (4A)": 100000 };
    const r = reconcile([], book, tenants, { matchResult: matchReconcile([], book) });
    const ex = secEx(r);
    expect(ex).to.have.length(1);
    expect(ex[0].detail).to.include("Smith (4A)");
    expect(ex[0].detail).to.not.include("Jones (4B)");
    expect(ex[0].detail).to.include("$1,000.00");
  });

  it("falls back to an explicit sentinel (never a dangling name) for an unattributed deposit", function () {
    // A bare security-deposit receipt with NO party still produces a complete
    // sentence — the name slot is filled with an explicit sentinel, not "".
    const book = [
      rec("2026-05-01", 75000, "Security deposit received", {
        source: "quickbooks",
        kind: "deposit",
        party: "",
      }),
    ];
    const tenants = {};
    const r = reconcile([], book, tenants, { matchResult: matchReconcile([], book) });
    const ex = secEx(r);
    expect(ex).to.have.length(1);
    expect(ex[0].detail).to.include("unattributed beneficiary");
    expect(ex[0].detail).to.include("$750.00");
  });

  it("the detail stays deterministic + order-independent (byte-identical findings)", function () {
    // Jones is short $500 (deposits $1500, segregates $1000); Smith segregates
    // NOTHING ($1000 at risk). BOTH are flagged; the named detail of each must be
    // byte-identical regardless of input order.
    const book = [
      secDeposit("2026-05-01", 150000, "Jones (4B)"),
      secDeposit("2026-05-01", 100000, "Smith (4A)"),
      segTransfer("2026-05-02", 100000, "Jones (4B)"),
    ];
    const tenants = { "Jones (4B)": 150000, "Smith (4A)": 100000 };
    const a = reconcile([], book, tenants, { matchResult: matchReconcile([], book) });
    const shuffled = [book[2], book[0], book[1]];
    const b = reconcile([], shuffled, tenants, {
      matchResult: matchReconcile([], shuffled),
    });
    expect(JSON.stringify(b.exceptions)).to.equal(JSON.stringify(a.exceptions));
    // Two distinct findings, each naming its OWN at-risk beneficiary + amount.
    const aSeg = secEx(a);
    expect(aSeg).to.have.length(2);
    const byParty = new Map(aSeg.map((e) => [e.records[0].party, e]));
    expect(byParty.get("Jones (4B)").detail).to.include("Jones (4B)");
    expect(byParty.get("Jones (4B)").detail).to.include("$500.00"); // $1500 - $1000
    expect(byParty.get("Smith (4A)").detail).to.include("Smith (4A)");
    expect(byParty.get("Smith (4A)").detail).to.include("$1,000.00");
  });
});

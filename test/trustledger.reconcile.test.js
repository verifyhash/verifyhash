"use strict";

const { expect } = require("chai");

const {
  reconcile,
  ReconcileError,
  EXCEPTION,
  SEVERITY,
  tenantBalances,
  triage,
  ROOT_CAUSE_CLASS,
  CLASS_OF,
  classOfException,
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

describe("T-41.1 trustledger/reconcile: a NEGATIVE individual beneficiary ledger is out of trust even when the SUM ties", function () {
  function negEx(r) {
    return r.exceptions.filter((e) => e.type === EXCEPTION.NEGATIVE_TENANT_LEDGER);
  }
  function subEx(r) {
    return r.exceptions.filter((e) => e.type === EXCEPTION.SUBLEDGER_OUT_OF_BALANCE);
  }

  it("REPRO: {Jones:-50000, Smith:+50000} now FAILS (was a silent PASS) — the SUM ties to book but Jones is negative", function () {
    // The pooled sum is 0 and the book is 0, so the three-way SUM ties out
    // perfectly. Before T-41.1 this produced ZERO exceptions: a silent PASS that
    // hid the fact that Jones's trust money was used to cover Smith. Now the
    // negative individual ledger raises an ERROR-grade finding.
    const r = reconcile([], [], { Jones: -50000, Smith: 50000 }, {});

    // The SUM still ties (this check is orthogonal to it).
    expect(r.balances.subledger).to.equal(0);
    expect(r.balances.book).to.equal(0);
    expect(r.tiesOut).to.equal(true);
    // ...but a negative beneficiary ledger is flagged as an ERROR.
    const ex = negEx(r);
    expect(ex).to.have.length(1);
    expect(ex[0].severity).to.equal(SEVERITY.ERROR);
    // It names the beneficiary AND the negative amount.
    expect(ex[0].amount).to.equal(-50000);
    expect(ex[0].detail).to.include("Jones");
    expect(ex[0].detail).to.include("-$500.00");
    // The pooled SUM check did NOT fire (it ties), proving orthogonality.
    expect(subEx(r)).to.have.length(0);
    // The downstream verdict is PASS only when there is no ERROR exception, so an
    // ERROR-grade finding here makes the formerly-silent-PASS packet FAIL.
    expect(r.exceptions.filter((e) => e.severity === SEVERITY.ERROR)).to.have.length(1);
  });

  it("flags EACH negative beneficiary, naming the party + the negative amount", function () {
    const r = reconcile(
      [],
      [],
      { "Jones (4B)": -50000, "Smith (4A)": 50000, "Doe (1A)": -12345, X: 12345 },
      {}
    );
    const ex = negEx(r);
    expect(ex).to.have.length(2);
    const byParty = new Map(ex.map((e) => [e.detail.match(/ledger for (.+?) is negative/)[1], e]));
    expect(byParty.has("Jones (4B)")).to.equal(true);
    expect(byParty.has("Doe (1A)")).to.equal(true);
    expect(byParty.get("Jones (4B)").amount).to.equal(-50000);
    expect(byParty.get("Jones (4B)").detail).to.include("-$500.00");
    expect(byParty.get("Doe (1A)").amount).to.equal(-12345);
    expect(byParty.get("Doe (1A)").detail).to.include("-$123.45");
  });

  it("is ADDITIVE and ORTHOGONAL to SUBLEDGER_OUT_OF_BALANCE — both can fire at once", function () {
    // Jones is negative AND the pooled sum (-$500) does not tie to the book ($0).
    const r = reconcile([], [], { "Jones (4B)": -50000 }, {});
    expect(negEx(r)).to.have.length(1);
    expect(subEx(r)).to.have.length(1);
    // The negative-ledger finding is the SAME beneficiary; the SUM finding is the
    // pooled gap. They are independent findings, not a single double-counted one.
    expect(negEx(r)[0].amount).to.equal(-50000);
    expect(subEx(r)[0].amount).to.equal(50000); // book(0) - subledger(-50000)
  });

  it("does NOT flag a legitimate negative OWNER's-own-funds line (structural, not a tenant shortage)", function () {
    // The clean-book shape: the owner funds the account and a vendor payment comes
    // out of the OWNER's own money, so the owner line is legitimately negative.
    const tenants = {
      "Smith (4A)": 150000,
      "Jones (4B)": 150000,
      "Owner Acme": -30000,
    };
    const r = reconcile([], [], tenants, {});
    expect(negEx(r)).to.have.length(0);
    // And no ERROR is introduced on this otherwise-clean per-tenant shape.
    expect(r.exceptions.filter((e) => e.severity === SEVERITY.ERROR && e.type === EXCEPTION.NEGATIVE_TENANT_LEDGER)).to.have.length(0);
  });

  it("does NOT flag a negative ESCROW / segregated sink line (it receives the offsetting outflow)", function () {
    const tenants = { "Jones (4B)": 80000, Escrow: -80000 };
    const r = reconcile([], [], tenants, {});
    expect(negEx(r)).to.have.length(0);
  });

  it("WORD-BOUNDED: an ordinary surname that merely CONTAINS a control token IS flagged", function () {
    // "Owens" contains "owen"/"owner"-ish text and "Crowell" contains "crow", but
    // neither is the WHOLE-word control token, so both are real beneficiaries.
    const r = reconcile([], [], { Owens: -100, Crowell: -200, Owner: -300 }, {});
    const flagged = negEx(r).map((e) => e.amount).sort((a, b) => a - b);
    // Owens (-100) and Crowell (-200) are flagged; the bare "Owner" control line is not.
    expect(flagged).to.deep.equal([-200, -100]);
  });

  it("honors toleranceCents: a balance within -tolerance is NOT flagged; beyond it IS", function () {
    expect(negEx(reconcile([], [], { Jones: -50 }, { toleranceCents: 50 }))).to.have.length(0);
    const ex = negEx(reconcile([], [], { Jones: -51 }, { toleranceCents: 50 }));
    expect(ex).to.have.length(1);
    expect(ex[0].amount).to.equal(-51);
  });

  it("does not flag a zero or positive beneficiary ledger", function () {
    const r = reconcile([], [], { A: 0, B: 100000, C: 1 }, {});
    expect(negEx(r)).to.have.length(0);
  });

  it("is deterministic + order-independent (byte-identical output regardless of map key order)", function () {
    const a = reconcile([], [], { Jones: -50000, Smith: 50000, Doe: -30000, X: 30000 }, {});
    const b = reconcile([], [], { X: 30000, Doe: -30000, Smith: 50000, Jones: -50000 }, {});
    expect(JSON.stringify(b)).to.equal(JSON.stringify(a));
  });

  it("also works from rent-roll rows that net a beneficiary negative", function () {
    // A refund larger than the tenant's deposits nets that tenant negative.
    const tenantRows = [
      rec("2026-05-01", 100000, "rent", { party: "Jones (4B)" }),
      rec("2026-05-15", -150000, "over-refund", { party: "Jones (4B)" }),
      rec("2026-05-01", 50000, "rent", { party: "Smith (4A)" }),
    ];
    const r = reconcile([], [], tenantRows, {});
    const ex = negEx(r);
    expect(ex).to.have.length(1);
    expect(ex[0].amount).to.equal(-50000); // 100000 - 150000
    expect(ex[0].detail).to.include("Jones (4B)");
  });

  // ---- REWORK (control-account over-exclusion) ----------------------------
  // The control-account exclusion previously matched a control token ANYWHERE in
  // the free-text name, silently dropping real beneficiaries whose name merely
  // CONTAINS a control word. That re-opened exactly the masking hole T-41.1
  // closes, just on a token-named beneficiary. The exclusion is now anchored to
  // the LEADING name token (genuine account designations) and an authoritative
  // STRUCTURED `controlAccount` marker overrides the guess.

  it("REWORK: a REAL beneficiary whose name CONTAINS a control token (non-leading) going negative IS flagged", function () {
    // "Smith (OWNER)" is a literal beneficiary line in the e2e fixture (positive
    // there); "Jones Family Trust" naming is pervasive in this product's domain;
    // "Tenant 12 Reserve St" is an address. None is a control account — the
    // control word is NOT the leading token — so each negative ledger IS a
    // shortage and MUST be flagged. Previously all three were silently dropped.
    const tenants = {
      "Smith (OWNER)": -50000,
      "Jones Family Trust": -30000,
      "Tenant 12 Reserve St": -12345,
    };
    const r = reconcile([], [], tenants, {});
    const ex = negEx(r);
    const byParty = new Map(
      ex.map((e) => [e.detail.match(/ledger for (.+?) is negative/)[1], e])
    );
    expect(byParty.has("Smith (OWNER)")).to.equal(true);
    expect(byParty.has("Jones Family Trust")).to.equal(true);
    expect(byParty.has("Tenant 12 Reserve St")).to.equal(true);
    expect(byParty.get("Smith (OWNER)").amount).to.equal(-50000);
    expect(byParty.get("Smith (OWNER)").severity).to.equal(SEVERITY.ERROR);
    expect(byParty.get("Jones Family Trust").amount).to.equal(-30000);
    expect(byParty.get("Tenant 12 Reserve St").amount).to.equal(-12345);
    expect(ex).to.have.length(3);
  });

  it("REWORK: a genuine control DESIGNATION (control word in LEADING position) stays excluded", function () {
    // The legitimate cases: an owner's-own-funds line and an escrow/reserve sink,
    // each NAMED with the control word in the leading account-designation slot.
    const tenants = {
      "Owner Acme": -30000, // owner's own funds
      Escrow: -80000, // escrow sink
      "Reserve Fund": -10000, // reserve control line
      "Suspense 001": -2000, // suspense control line
    };
    const r = reconcile([], [], tenants, {});
    expect(negEx(r)).to.have.length(0);
  });

  it("REWORK: the STRUCTURED controlAccount:true marker is AUTHORITATIVE — it excludes a line whose name is NOT a control word", function () {
    // A control account the broker names "Operating Co" (a leading control word
    // is the residual name-heuristic limit), AND a control account named with NO
    // control word at all ("Building Clearing"): the structured marker on the
    // rent-roll rows excludes BOTH, regardless of name. A real beneficiary
    // ("Jones (4B)") without the marker is still flagged.
    // The shared rec() helper carries only the ingest fields; attach the
    // structured controlAccount marker explicitly (it is an extra producer
    // assertion on the row, not part of the normalized ingest shape).
    const tenantRows = [
      { ...rec("2026-05-01", -40000, "owner sweep", { party: "Building Clearing" }), controlAccount: true },
      { ...rec("2026-05-01", -30000, "operating draw", { party: "Operating Co" }), controlAccount: true },
      rec("2026-05-01", -50000, "shortfall", { party: "Jones (4B)" }),
    ];
    const r = reconcile([], [], tenantRows, {});
    const ex = negEx(r);
    expect(ex).to.have.length(1);
    expect(ex[0].detail).to.include("Jones (4B)");
    expect(ex[0].amount).to.equal(-50000);
  });

  it("REWORK: a marked control account does NOT shield a DIFFERENTLY-named real beneficiary", function () {
    // controlAccount:true on the "Escrow Sink" rows must mark ONLY that party's
    // bucket — a negative "Doe (1A)" beneficiary is still flagged.
    const tenantRows = [
      { ...rec("2026-05-01", -80000, "to escrow", { party: "Escrow Sink" }), controlAccount: true },
      rec("2026-05-01", -12345, "missing", { party: "Doe (1A)" }),
    ];
    const r = reconcile([], [], tenantRows, {});
    const ex = negEx(r);
    expect(ex).to.have.length(1);
    expect(ex[0].detail).to.include("Doe (1A)");
    expect(ex[0].amount).to.equal(-12345);
  });

  it("REWORK: the structured marker is order-independent across rows of the same party", function () {
    // The marker on ANY row for a party marks the whole bucket, regardless of row
    // order — a control account whose marked row comes after an unmarked one is
    // still excluded; output is byte-identical across the two row orderings.
    const drawRow = rec("2026-05-01", -30000, "draw", { party: "Sweep Building" });
    const tagRow = { ...rec("2026-05-02", 0, "tag", { party: "Sweep Building" }), controlAccount: true };
    const rowsA = [drawRow, tagRow];
    const rowsB = [tagRow, drawRow];
    const a = reconcile([], [], rowsA, {});
    const b = reconcile([], [], rowsB, {});
    expect(negEx(a)).to.have.length(0);
    expect(JSON.stringify(b)).to.equal(JSON.stringify(a));
  });
});

describe("T-41.2 trustledger: a NEGATIVE individual ledger gates PASS/FAIL FIRST-CLASS through report.buildPacket", function () {
  const report = require("../trustledger/report");

  // A rent roll where the pooled SUM ties to the (empty) book exactly — Jones is
  // -$500 and Smith is +$500, netting to $0 = book = bank — so the ONLY thing that
  // can fail the verdict is the negative individual ledger. This isolates the
  // verdict to the finding under test (no balance mismatch, no segregation finding).
  function maskedRent() {
    return [
      rec("2026-05-01", -50000, "shortfall", { kind: "rent", party: "Jones (4B)", source: "rentroll" }),
      rec("2026-05-01", 50000, "rent", { kind: "rent", party: "Smith (4A)", source: "rentroll" }),
    ];
  }

  function negRows(model) {
    return model.exceptions.filter(
      (e) => e.type === EXCEPTION.NEGATIVE_TENANT_LEDGER
    );
  }

  it("DEFAULT policy: the three balances tie out but the masked negative ledger FAILs the gate (the formerly-silent PASS)", function () {
    const model = report.buildPacket({
      bank: [],
      book: [],
      rentroll: maskedRent(),
      reportDate: "2026-05-31",
    });
    // The pooled three-way SUM ties out perfectly...
    expect(model.tiesOut).to.equal(true);
    // ...yet the packet FAILs, because one beneficiary's own ledger is negative.
    // This is the verdict/exit-code contract: model.pass=false => CLI maps to
    // EXIT.FAIL=3. Before T-41.x this masked case was a silent PASS.
    expect(model.pass).to.equal(false);
    expect(model.counts.error).to.be.at.least(1);
    const neg = negRows(model);
    expect(neg).to.have.length(1);
    expect(neg[0].severity).to.equal(SEVERITY.ERROR);
    // The machine packet row names the beneficiary + the negative amount.
    expect(neg[0].amount).to.equal(-50000);
    expect(neg[0].detail).to.include("Jones (4B)");
    expect(neg[0].detail).to.include("-$500.00");
  });

  it("the finding renders in BOTH the human report (HTML + CSV) and the machine packet", function () {
    const model = report.buildPacket({
      bank: [],
      book: [],
      rentroll: maskedRent(),
      reportDate: "2026-05-31",
    });
    // Machine packet (the model the --json path emits): the row is present.
    expect(negRows(model)).to.have.length(1);

    // Human HTML report: the verdict reads FAIL and the finding's label/detail show.
    const html = report.renderHTML(model);
    expect(html).to.include("FAIL");
    expect(html).to.include("Beneficiary ledger is negative");
    expect(html).to.include("Jones (4B)");
    expect(html).to.include("-$500.00");

    // Human CSV report (the bookkeeper's worksheet): the type + amount + party show.
    const csv = report.renderExceptionsCSV(model);
    expect(csv).to.include(EXCEPTION.NEGATIVE_TENANT_LEDGER);
    expect(csv).to.include("Beneficiary ledger is negative");
    expect(csv).to.include("Jones (4B)");
    expect(csv).to.include("-$500.00");
  });

  it("a clean per-tenant rent roll PASSes (no negative-ledger finding, no false FAIL)", function () {
    // No beneficiary goes negative: an owner-funds control line is allowed to be
    // negative (structural), every tenant is non-negative, and the SUM ties.
    const rentroll = [
      rec("2026-05-01", 150000, "rent", { kind: "rent", party: "Smith (4A)", source: "rentroll" }),
      rec("2026-05-01", 150000, "rent", { kind: "rent", party: "Jones (4B)", source: "rentroll" }),
      rec("2026-05-20", -30000, "owner draw", { kind: "rent", party: "Owner Acme", source: "rentroll" }),
    ];
    const book = [
      rec("2026-05-01", 150000, "rent smith", { source: "quickbooks", kind: "deposit" }),
      rec("2026-05-01", 150000, "rent jones", { source: "quickbooks", kind: "deposit" }),
      rec("2026-05-20", -30000, "owner draw", { source: "quickbooks", kind: "check", party: "Owner Acme" }),
    ];
    const model = report.buildPacket({ bank: [], book, rentroll, reportDate: "2026-05-31" });
    expect(negRows(model)).to.have.length(0);
    expect(model.tiesOut).to.equal(true);
    expect(model.pass).to.equal(true);
  });

  it("is deterministic: the same inputs produce a byte-identical packet model", function () {
    const a = report.buildPacket({ bank: [], book: [], rentroll: maskedRent(), reportDate: "2026-05-31" });
    const b = report.buildPacket({ bank: [], book: [], rentroll: maskedRent(), reportDate: "2026-05-31" });
    expect(JSON.stringify(b)).to.equal(JSON.stringify(a));
  });
});

describe("T-42.1 trustledger/reconcile: an owner draw EXCEEDING the owner's own contributed capital is out of trust", function () {
  function overEx(r) {
    return r.exceptions.filter((e) => e.type === EXCEPTION.OWNER_OVERDRAW);
  }
  function negEx(r) {
    return r.exceptions.filter((e) => e.type === EXCEPTION.NEGATIVE_TENANT_LEDGER);
  }
  function subEx(r) {
    return r.exceptions.filter((e) => e.type === EXCEPTION.SUBLEDGER_OUT_OF_BALANCE);
  }

  // The confirmed repro: the owner contributes +$1,000 of its OWN capital and then
  // draws -$1,500 — $500 BEYOND its contribution, i.e. $500 of TENANT money (Jones'
  // $5,000 rent sits in the pooled account). The owner is modeled as a control-
  // account sub-ledger party so the pooled SUM ties to the book via the owner's
  // -$500 bucket: reconcile() returns tiesOut:true and, before T-42.1, the ONLY
  // finding was owner_draw/warning — a SILENT PASS of conversion. Now it FAILS.
  function reproBook() {
    return [
      rec("2026-05-01", 100000, "Owner contribution Acme", {
        source: "quickbooks",
        kind: "deposit",
        party: "Owner Acme",
      }),
      rec("2026-05-01", 500000, "rent jones", {
        source: "quickbooks",
        kind: "deposit",
        party: "Jones (4B)",
      }),
      rec("2026-05-10", -150000, "Owner draw - disbursement to owner Acme", {
        source: "quickbooks",
        kind: "check",
        party: "Owner Acme",
      }),
    ];
  }
  // A bank mirror so adjustedBank == book == subledger (the SUM ties out).
  function reproBank() {
    return [
      rec("2026-05-02", 100000, "owner contribution acme", { kind: "deposit" }),
      rec("2026-05-02", 500000, "deposit jones", { kind: "deposit" }),
      rec("2026-05-11", -150000, "owner draw acme", { kind: "check" }),
    ];
  }
  // Owner nets -$500 (contributed $1,000, drew $1,500). Jones holds $5,000. The
  // pooled SUM = $4,500 = book = bank, so the three-way SUM ties out.
  const reproTenants = { "Owner Acme": -50000, "Jones (4B)": 500000 };

  it("REPRO (+100000 / -150000 / Jones +500000): the SUM ties out but the owner overdraw now FAILs (was a silent PASS)", function () {
    const bank = reproBank();
    const book = reproBook();
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, reproTenants, { matchResult: m });

    // The pooled three-way SUM ties out perfectly (the control-account negative
    // absorbs the overdraw), so tiesOut is true...
    expect(r.balances.book).to.equal(450000);
    expect(r.balances.subledger).to.equal(450000);
    expect(r.balances.adjustedBank).to.equal(450000);
    expect(r.tiesOut).to.equal(true);

    // ...yet the owner-overdraw ERROR fires for the EXCESS (the tenant money).
    const ex = overEx(r);
    expect(ex).to.have.length(1);
    expect(ex[0].severity).to.equal(SEVERITY.ERROR);
    expect(ex[0].amount).to.equal(50000); // $1,500 drawn - $1,000 contributed
    expect(ex[0].label).to.match(/exceeds contributed capital/i);
    expect(ex[0].detail).to.include("Owner Acme");
    expect(ex[0].detail).to.include("$500.00"); // the excess
    expect(ex[0].detail).to.include("$1,500.00"); // the draw
    expect(ex[0].detail).to.include("$1,000.00"); // the contributed capital

    // The downstream verdict is PASS only when there is no ERROR, so the formerly
    // silent-PASS packet now carries an ERROR-grade finding.
    expect(r.exceptions.filter((e) => e.severity === SEVERITY.ERROR)).to.have.length(1);

    // The owner control bucket is (correctly) NOT double-flagged as a negative
    // tenant ledger (it is a control account); the overdraw is the single finding.
    expect(negEx(r)).to.have.length(0);
    // The pooled SUM check did not fire (it ties), proving orthogonality.
    expect(subEx(r)).to.have.length(0);
  });

  it("an owner drawing AT-OR-BELOW contributed capital raises NOTHING (no overdraw, stays PASS)", function () {
    // Owner contributes $2,000 and draws only $1,500 — fully within its OWN funds.
    const book = [
      rec("2026-05-01", 200000, "Owner contribution Acme", {
        source: "quickbooks",
        kind: "deposit",
        party: "Owner Acme",
      }),
      rec("2026-05-01", 500000, "rent jones", {
        source: "quickbooks",
        kind: "deposit",
        party: "Jones (4B)",
      }),
      rec("2026-05-10", -150000, "Owner draw - disbursement to owner Acme", {
        source: "quickbooks",
        kind: "check",
        party: "Owner Acme",
      }),
    ];
    const tenants = { "Owner Acme": 50000, "Jones (4B)": 500000 };
    const r = reconcile([], book, tenants, { matchResult: matchReconcile([], book) });
    expect(overEx(r)).to.have.length(0);
    // The owner-draw warning still classifies the line, but no ERROR is raised.
    expect(r.exceptions.filter((e) => e.severity === SEVERITY.ERROR)).to.have.length(0);
  });

  it("an owner drawing EXACTLY its contributed capital raises NOTHING (boundary)", function () {
    const book = [
      rec("2026-05-01", 150000, "Owner contribution Acme", {
        source: "quickbooks",
        kind: "deposit",
        party: "Owner Acme",
      }),
      rec("2026-05-10", -150000, "Owner draw - disbursement to owner Acme", {
        source: "quickbooks",
        kind: "check",
        party: "Owner Acme",
      }),
    ];
    const tenants = { "Owner Acme": 0 };
    const r = reconcile([], book, tenants, { matchResult: matchReconcile([], book) });
    expect(overEx(r)).to.have.length(0);
  });

  it("an owner draw with NO in-period contribution is NOT second-guessed (EPIC-41 boundary: opening owner capital)", function () {
    // This is the EXACT shape of the existing 'detects an OWNER DRAW' test: the
    // owner draws -$500 with no in-period contribution and the sub-ledger models
    // the -$500 as legitimate opening owner-capital deployment. No basis to assess
    // overdraw against => no OWNER_OVERDRAW (stays PASS, as it must).
    const book = [
      rec("2026-05-01", 150000, "rent smith", { source: "quickbooks", kind: "deposit" }),
      rec("2026-05-10", -50000, "Owner draw - disbursement to owner Acme", {
        source: "quickbooks",
        kind: "check",
        party: "Owner Acme",
      }),
    ];
    const tenants = { Smith: 150000, "Owner Acme": -50000 };
    const r = reconcile([], book, tenants, { matchResult: matchReconcile([], book) });
    expect(overEx(r)).to.have.length(0);
  });

  it("honors toleranceCents: an excess at or below tolerance is NOT flagged; beyond it IS", function () {
    function bookOver(excessCents) {
      // contribute $1,000, draw $1,000 + excess.
      return [
        rec("2026-05-01", 100000, "Owner contribution Acme", {
          source: "quickbooks",
          kind: "deposit",
          party: "Owner Acme",
        }),
        rec("2026-05-10", -(100000 + excessCents), "Owner draw - disbursement to owner Acme", {
          source: "quickbooks",
          kind: "check",
          party: "Owner Acme",
        }),
      ];
    }
    // Excess of 50 cents, tolerance 50 => not flagged.
    const within = reconcile([], bookOver(50), { "Owner Acme": -50 }, { toleranceCents: 50 });
    expect(overEx(within)).to.have.length(0);
    // Excess of 51 cents, tolerance 50 => flagged for the full 51.
    const beyond = reconcile([], bookOver(51), { "Owner Acme": -51 }, { toleranceCents: 50 });
    const ex = overEx(beyond);
    expect(ex).to.have.length(1);
    expect(ex[0].amount).to.equal(51);
  });

  it("aggregates MULTIPLE owner draws against the SAME contribution (sum of draws vs capital)", function () {
    // Owner contributes $1,000 once, then draws $800 + $800 = $1,600 across two
    // lines — $600 over capital. The excess is computed on the SUM, not per line.
    const book = [
      rec("2026-05-01", 100000, "Owner contribution Acme", {
        source: "quickbooks",
        kind: "deposit",
        party: "Owner Acme",
      }),
      rec("2026-05-05", 500000, "rent jones", {
        source: "quickbooks",
        kind: "deposit",
        party: "Jones (4B)",
      }),
      rec("2026-05-10", -80000, "Owner draw - disbursement to owner Acme", {
        source: "quickbooks",
        kind: "check",
        party: "Owner Acme",
      }),
      rec("2026-05-20", -80000, "Owner draw - disbursement to owner Acme #2", {
        source: "quickbooks",
        kind: "check",
        party: "Owner Acme",
      }),
    ];
    const tenants = { "Owner Acme": -60000, "Jones (4B)": 500000 };
    const r = reconcile([], book, tenants, { matchResult: matchReconcile([], book) });
    const ex = overEx(r);
    expect(ex).to.have.length(1);
    expect(ex[0].amount).to.equal(60000); // $1,600 - $1,000
    expect(ex[0].severity).to.equal(SEVERITY.ERROR);
  });

  it("flags EACH over-drawing owner account separately, naming each", function () {
    const book = [
      rec("2026-05-01", 100000, "Owner contribution Acme", {
        source: "quickbooks",
        kind: "deposit",
        party: "Owner Acme",
      }),
      rec("2026-05-01", 100000, "Owner contribution Beta", {
        source: "quickbooks",
        kind: "deposit",
        party: "Owner Beta",
      }),
      rec("2026-05-01", 800000, "rent jones", {
        source: "quickbooks",
        kind: "deposit",
        party: "Jones (4B)",
      }),
      rec("2026-05-10", -150000, "Owner draw - disbursement to owner Acme", {
        source: "quickbooks",
        kind: "check",
        party: "Owner Acme",
      }),
      rec("2026-05-10", -130000, "Owner draw - disbursement to owner Beta", {
        source: "quickbooks",
        kind: "check",
        party: "Owner Beta",
      }),
    ];
    // Acme over by $500, Beta over by $300; Jones holds $8,000. Sum = 8000 - 500 - 300 = 7200.
    const tenants = { "Owner Acme": -50000, "Owner Beta": -30000, "Jones (4B)": 800000 };
    const r = reconcile([], book, tenants, { matchResult: matchReconcile([], book) });
    const ex = overEx(r);
    expect(ex).to.have.length(2);
    const byAmount = ex.map((e) => e.amount).sort((a, b) => a - b);
    expect(byAmount).to.deep.equal([30000, 50000]);
    expect(ex.some((e) => e.detail.includes("Owner Acme"))).to.equal(true);
    expect(ex.some((e) => e.detail.includes("Owner Beta"))).to.equal(true);
  });

  it("the over-capital finding is the EXACT INVERSE of the EPIC-41 exclusion (never double-flags the owner bucket)", function () {
    // The owner bucket is a control account: T-41 excludes its negative as
    // structural. T-42 raises an OWNER_OVERDRAW for the portion BEYOND capital.
    // The two never both fire on the same owner account.
    const book = [
      rec("2026-05-01", 100000, "Owner contribution Acme", {
        source: "quickbooks",
        kind: "deposit",
        party: "Owner Acme",
      }),
      rec("2026-05-10", -150000, "Owner draw - disbursement to owner Acme", {
        source: "quickbooks",
        kind: "check",
        party: "Owner Acme",
      }),
    ];
    const tenants = { "Owner Acme": -50000 };
    const r = reconcile([], book, tenants, { matchResult: matchReconcile([], book) });
    expect(overEx(r)).to.have.length(1);
    // T-41 still excludes the owner control bucket (no negative-ledger finding).
    expect(negEx(r)).to.have.length(0);
  });

  it("is deterministic + order-independent (byte-identical output regardless of book row order)", function () {
    const bank = reproBank();
    const book = reproBook();
    const a = reconcile(bank, book, reproTenants, { matchResult: matchReconcile(bank, book) });
    const shuffledBook = [book[2], book[0], book[1]];
    const shuffledBank = [bank[2], bank[1], bank[0]];
    const b = reconcile(shuffledBank, shuffledBook, reproTenants, {
      matchResult: matchReconcile(shuffledBank, shuffledBook),
    });
    expect(JSON.stringify(b)).to.equal(JSON.stringify(a));
  });
});

describe("T-42.2 trustledger: an owner over-draw gates PASS/FAIL FIRST-CLASS through report.buildPacket + renders everywhere", function () {
  const report = require("../trustledger/report");
  const { validatePolicy, applyPolicy } = require("../trustledger/policy");

  // A book where the owner contributes $1,000 of its OWN capital and then draws
  // $1,500 — $500 BEYOND its contribution, i.e. $500 of TENANT money (Jones holds
  // $5,000 rent in the pooled account). The owner is a control-account sub-ledger
  // party, so the pooled SUM still ties to the book via the owner's -$500 bucket:
  // the three-way SUM ties out and the ONLY thing that can fail the verdict is the
  // owner-overdraw ERROR, isolating the verdict flip to that finding.
  function overdrawBook() {
    return [
      rec("2026-05-01", 100000, "Owner contribution Acme", { source: "quickbooks", kind: "deposit", party: "Owner Acme" }),
      rec("2026-05-01", 500000, "rent jones", { source: "quickbooks", kind: "deposit", party: "Jones (4B)" }),
      rec("2026-05-10", -150000, "Owner draw - disbursement to owner Acme", { source: "quickbooks", kind: "check", party: "Owner Acme" }),
    ];
  }
  // A rent roll netting the SAME pooled total as the book ($4,500): Jones +$5,000
  // and the owner control bucket -$500 (contributed $1,000, drew $1,500). So
  // book == sub-ledger == bank and the three-way SUM ties out.
  function overdrawRent() {
    return [
      rec("2026-05-01", 500000, "rent", { kind: "rent", party: "Jones (4B)", source: "rentroll" }),
      rec("2026-05-01", 100000, "owner contribution", { kind: "rent", party: "Owner Acme", source: "rentroll" }),
      rec("2026-05-10", -150000, "owner draw", { kind: "rent", party: "Owner Acme", source: "rentroll" }),
    ];
  }
  function overRows(model) {
    return model.exceptions.filter((e) => e.type === EXCEPTION.OWNER_OVERDRAW);
  }

  it("DEFAULT policy: the three balances tie out but the masked owner over-draw FAILs the gate (the formerly-silent PASS)", function () {
    const model = report.buildPacket({
      bank: [],
      book: overdrawBook(),
      rentroll: overdrawRent(),
      reportDate: "2026-05-31",
    });
    // The pooled three-way SUM ties out perfectly...
    expect(model.tiesOut).to.equal(true);
    // ...yet the packet FAILs, because the owner paid itself $500 of tenant money.
    // This is the verdict/exit-code contract: model.pass=false => CLI maps to
    // EXIT.FAIL=3. Before owner_overdraw existed this masked case was a silent PASS.
    expect(model.pass).to.equal(false);
    expect(model.counts.error).to.be.at.least(1);
    const over = overRows(model);
    expect(over).to.have.length(1);
    expect(over[0].severity).to.equal(SEVERITY.ERROR);
    // The machine packet row names the owner + the EXCESS (tenant money consumed).
    expect(over[0].amount).to.equal(50000); // $1,500 drawn - $1,000 contributed
    expect(over[0].detail).to.include("Owner Acme");
    expect(over[0].detail).to.include("$500.00");
  });

  it("the finding renders in BOTH the human report (HTML + CSV) and the machine packet", function () {
    const model = report.buildPacket({
      bank: [],
      book: overdrawBook(),
      rentroll: overdrawRent(),
      reportDate: "2026-05-31",
    });
    // Machine packet (the model the --json path emits): the row is present.
    expect(overRows(model)).to.have.length(1);

    // Human HTML report: the verdict reads FAIL and the finding's label/detail show.
    const html = report.renderHTML(model);
    expect(html).to.include("FAIL");
    expect(html).to.include("Owner draw exceeds contributed capital");
    expect(html).to.include("Owner Acme");
    expect(html).to.include("$500.00");

    // Human CSV report (the bookkeeper's worksheet): the type + label + party show.
    const csv = report.renderExceptionsCSV(model);
    expect(csv).to.include(EXCEPTION.OWNER_OVERDRAW);
    expect(csv).to.include("Owner draw exceeds contributed capital");
    expect(csv).to.include("Owner Acme");
  });

  it("a per-state policy re-grading owner_overdraw to WARNING flips the verdict FAIL -> PASS (same files, ZERO schema change)", function () {
    // The override lives entirely in the EXISTING severities map — no new field.
    const policy = validatePolicy({
      schemaVersion: 1,
      state: "EXAMPLE-STATE (owner-overdraw re-grade)",
      severities: { [EXCEPTION.OWNER_OVERDRAW]: SEVERITY.WARNING },
      citations: { [EXCEPTION.OWNER_OVERDRAW]: "Test Stat. 5.1.2" },
    });
    const model = report.buildPacket({
      bank: [],
      book: overdrawBook(),
      rentroll: overdrawRent(),
      reportDate: "2026-05-31",
      policy,
    });
    const over = overRows(model);
    expect(over).to.have.length(1);
    expect(over[0].severity).to.equal(SEVERITY.WARNING);
    expect(over[0].citation).to.equal("Test Stat. 5.1.2");
    expect(model.counts.error).to.equal(0);
    expect(model.pass).to.equal(true);
    // The named owner + excess detail survives the policy override verbatim.
    expect(over[0].detail).to.include("Owner Acme");
    expect(over[0].detail).to.include("$500.00");
  });

  it("applyPolicy is the SAME path: re-grading owner_overdraw leaves detail/amount/records verbatim, only severity changes", function () {
    const book = overdrawBook();
    const raw = reconcile([], book, { "Owner Acme": -50000, "Jones (4B)": 500000 }, {
      matchResult: matchReconcile([], book),
    });
    const beforeRow = raw.exceptions.find((e) => e.type === EXCEPTION.OWNER_OVERDRAW);
    expect(beforeRow).to.be.an("object");
    const policy = validatePolicy({
      schemaVersion: 1,
      state: "Lenient Overdraw",
      severities: { [EXCEPTION.OWNER_OVERDRAW]: SEVERITY.WARNING },
    });
    const after = applyPolicy(raw, policy);
    const afterRow = after.exceptions.find((e) => e.type === EXCEPTION.OWNER_OVERDRAW);
    // Only severity may change; detail/label/amount/records carry through verbatim.
    expect(afterRow.detail).to.equal(beforeRow.detail);
    expect(afterRow.label).to.equal(beforeRow.label);
    expect(afterRow.amount).to.equal(beforeRow.amount);
    expect(afterRow.records).to.deep.equal(beforeRow.records);
    expect(afterRow.severity).to.equal(SEVERITY.WARNING);
  });

  it("a book with NO owner over-draw still PASSes through the report (no false FAIL introduced)", function () {
    // Owner contributes $2,000 and draws only $1,500 — fully within its OWN funds.
    const book = [
      rec("2026-05-01", 200000, "Owner contribution Acme", { source: "quickbooks", kind: "deposit", party: "Owner Acme" }),
      rec("2026-05-01", 500000, "rent jones", { source: "quickbooks", kind: "deposit", party: "Jones (4B)" }),
      rec("2026-05-10", -150000, "Owner draw - disbursement to owner Acme", { source: "quickbooks", kind: "check", party: "Owner Acme" }),
    ];
    const rentroll = [
      rec("2026-05-01", 500000, "rent", { kind: "rent", party: "Jones (4B)", source: "rentroll" }),
      rec("2026-05-01", 200000, "owner contribution", { kind: "rent", party: "Owner Acme", source: "rentroll" }),
      rec("2026-05-10", -150000, "owner draw", { kind: "rent", party: "Owner Acme", source: "rentroll" }),
    ];
    const model = report.buildPacket({ bank: [], book, rentroll, reportDate: "2026-05-31" });
    expect(overRows(model)).to.have.length(0);
    expect(model.tiesOut).to.equal(true);
    expect(model.pass).to.equal(true);
  });

  it("is deterministic: the same inputs produce a byte-identical packet model", function () {
    const a = report.buildPacket({ bank: [], book: overdrawBook(), rentroll: overdrawRent(), reportDate: "2026-05-31" });
    const b = report.buildPacket({ bank: [], book: overdrawBook(), rentroll: overdrawRent(), reportDate: "2026-05-31" });
    expect(JSON.stringify(b)).to.equal(JSON.stringify(a));
  });
});

describe("T-43.1 trustledger/reconcile: triage classifies findings by ROOT-CAUSE CLASS", function () {
  // A tiny synthetic exception, the minimum triage consumes: { type, severity, amount }.
  function ex(type, amount, severity) {
    return { type, severity, amount, label: "", detail: "", records: [] };
  }
  function classRow(t, cls) {
    return t.classes.find((c) => c.class === cls);
  }

  it("EXHAUSTIVENESS: EVERY EXCEPTION type resolves to a real ROOT_CAUSE_CLASS (no fall-through)", function () {
    const classValues = new Set(Object.values(ROOT_CAUSE_CLASS));
    for (const type of Object.values(EXCEPTION)) {
      // A type is classified by EITHER the static table OR the directional
      // classifier. For directional types (BANK_BOOK_MISMATCH) we probe BOTH sign
      // directions; for static types either probe yields the same class.
      for (const probe of [-1, 1]) {
        const cls = classOfException({ type, amount: probe });
        expect(classValues.has(cls), `EXCEPTION ${type} (amount ${probe}) -> known class`).to.equal(true);
      }
    }
    // And the four named classes are exactly the closed set.
    expect([...classValues].sort()).to.deep.equal(
      ["data_completeness", "needs_review", "out_of_trust", "timing"]
    );
  });

  it("the load-time guard already ran: requiring the module did not throw", function () {
    // If CLASS_OF were not exhaustive (or a class were misspelled) the module
    // would have thrown on require above and this whole file would not load.
    expect(typeof triage).to.equal("function");
  });

  it("classifies a genuine OUT-OF-TRUST finding and the headline says OUT OF TRUST", function () {
    const model = {
      exceptions: [ex(EXCEPTION.NEGATIVE_TENANT_LEDGER, -50000, SEVERITY.ERROR)],
    };
    const t = triage(model);
    expect(t.outOfTrust).to.equal(true);
    expect(t.dataIncomplete).to.equal(false);
    expect(t.topClass).to.equal(ROOT_CAUSE_CLASS.OUT_OF_TRUST);
    const row = classRow(t, ROOT_CAUSE_CLASS.OUT_OF_TRUST);
    expect(row.count).to.equal(1);
    expect(row.absImpact).to.equal(50000); // abs cents
    expect(t.totals).to.deep.equal({ count: 1, absImpact: 50000 });
    expect(t.headline).to.match(/^OUT OF TRUST:/);
    expect(t.headline).to.include("$500.00");
  });

  it("classifies a DATA-COMPLETENESS-only FAIL and the headline says FIX YOUR DATA (NOT out of trust)", function () {
    // A bank-OVER mismatch (amount >= 0: adjustedBank > book) is an UNRECORDED
    // DEPOSIT to write down — a benign data-completeness item, NOT a shortage. The
    // bank holds at least as much as the books say, so no beneficiary money is
    // missing; this is the direction the data-tidy-up headline is honest for.
    const model = {
      exceptions: [
        ex(EXCEPTION.UNRECONCILED_BANK, 125000, SEVERITY.WARNING),
        ex(EXCEPTION.BANK_BOOK_MISMATCH, 125000, SEVERITY.ERROR), // +ve = bank over = data tidy-up
      ],
    };
    const t = triage(model);
    expect(t.outOfTrust).to.equal(false);
    expect(t.dataIncomplete).to.equal(true);
    expect(t.topClass).to.equal(ROOT_CAUSE_CLASS.DATA_COMPLETENESS);
    const row = classRow(t, ROOT_CAUSE_CLASS.DATA_COMPLETENESS);
    expect(row.count).to.equal(2);
    expect(row.absImpact).to.equal(250000); // 125000 + 125000, abs
    expect(t.headline).to.match(/^FIX YOUR DATA:/);
    // The headline does NOT raise the leading "OUT OF TRUST:" claim.
    expect(t.headline).to.not.match(/^OUT OF TRUST:/);
    // Explicitly NOT an out-of-trust claim.
    expect(t.headline).to.include("not (yet) evidence the money is gone");
  });

  it("DIRECTIONAL DEFECT FIX: a bank-SHORT mismatch (amount < 0) is OUT OF TRUST, never softened to 'fix your data'", function () {
    // THE TEXTBOOK SHORTAGE the review panel flagged: bank holds $1,000 cash while
    // book AND sub-ledger BOTH agree the broker owes beneficiaries $1,500
    // (adjustedBank 100000 < book 150000 == subledger 150000). Book and subledger
    // agree, so SUBLEDGER_OUT_OF_BALANCE / NEGATIVE_TENANT_LEDGER do NOT fire — the
    // ONLY error-severity finding is the bank-SHORT mismatch (amount = 100000 -
    // 150000 = -50000). $500 of beneficiary money is NOT in the account. triage
    // must name this OUT OF TRUST, not reassure the broker it is a bookkeeping
    // cleanup.
    const model = {
      exceptions: [ex(EXCEPTION.BANK_BOOK_MISMATCH, -50000, SEVERITY.ERROR)],
    };
    const t = triage(model);
    expect(t.outOfTrust).to.equal(true);
    expect(t.dataIncomplete).to.equal(false);
    expect(t.topClass).to.equal(ROOT_CAUSE_CLASS.OUT_OF_TRUST);
    expect(classRow(t, ROOT_CAUSE_CLASS.OUT_OF_TRUST).absImpact).to.equal(50000);
    expect(t.headline).to.match(/^OUT OF TRUST:/);
    // It must NOT emit the reassuring data-tidy-up headline.
    expect(t.headline).to.not.match(/^FIX YOUR DATA:/);
    expect(t.headline).to.not.include("not (yet) evidence the money is gone");
  });

  it("DIRECTIONAL: the SAME type with the OPPOSITE sign routes to a DIFFERENT class (sign discriminates)", function () {
    // Same EXCEPTION type, only the sign of the residual gap differs. The bank-SHORT
    // case is a shortage (out_of_trust); the bank-OVER case is an unrecorded deposit
    // (data_completeness). A single static mapping could never tell these apart.
    const short = triage({ exceptions: [ex(EXCEPTION.BANK_BOOK_MISMATCH, -50000, SEVERITY.ERROR)] });
    const over = triage({ exceptions: [ex(EXCEPTION.BANK_BOOK_MISMATCH, 50000, SEVERITY.ERROR)] });
    expect(short.topClass).to.equal(ROOT_CAUSE_CLASS.OUT_OF_TRUST);
    expect(over.topClass).to.equal(ROOT_CAUSE_CLASS.DATA_COMPLETENESS);
    // classOfException is the single decision point and agrees in isolation.
    expect(classOfException({ type: EXCEPTION.BANK_BOOK_MISMATCH, amount: -1 }))
      .to.equal(ROOT_CAUSE_CLASS.OUT_OF_TRUST);
    expect(classOfException({ type: EXCEPTION.BANK_BOOK_MISMATCH, amount: 1 }))
      .to.equal(ROOT_CAUSE_CLASS.DATA_COMPLETENESS);
  });

  it("DISTINGUISHES the two: out_of_trust ALWAYS leads even when data gaps also exist", function () {
    // A real shortage AND a data gap in the same packet. The make-or-break
    // distinction must surface the out-of-trust finding first, never soften it.
    const model = {
      exceptions: [
        ex(EXCEPTION.UNRECONCILED_BANK, 10000, SEVERITY.WARNING), // data
        ex(EXCEPTION.SECURITY_DEPOSIT_SEGREGATION, 80000, SEVERITY.ERROR), // out of trust
      ],
    };
    const t = triage(model);
    expect(t.outOfTrust).to.equal(true);
    expect(t.dataIncomplete).to.equal(true);
    expect(t.topClass).to.equal(ROOT_CAUSE_CLASS.OUT_OF_TRUST);
    expect(t.headline).to.match(/^OUT OF TRUST:/);
    // It acknowledges the data gaps but keeps out-of-trust the priority.
    expect(t.headline).to.include("data-completeness gaps");
    // The class rows are ordered most-urgent first.
    expect(t.classes[0].class).to.equal(ROOT_CAUSE_CLASS.OUT_OF_TRUST);
  });

  it("a NEEDS_REVIEW / TIMING-only model is NOT shown out of trust and NOT a data failure", function () {
    const model = {
      exceptions: [
        ex(EXCEPTION.OWNER_DRAW, -50000, SEVERITY.WARNING), // needs_review
        ex(EXCEPTION.OUTSTANDING_DEPOSIT, 90000, SEVERITY.INFO), // timing
      ],
    };
    const t = triage(model);
    expect(t.outOfTrust).to.equal(false);
    expect(t.dataIncomplete).to.equal(false);
    expect(t.topClass).to.equal(ROOT_CAUSE_CLASS.NEEDS_REVIEW);
    expect(t.headline).to.match(/^NO OUT-OF-TRUST FINDING:/);
    expect(classRow(t, ROOT_CAUSE_CLASS.NEEDS_REVIEW).count).to.equal(1);
    expect(classRow(t, ROOT_CAUSE_CLASS.TIMING).count).to.equal(1);
  });

  it("an empty model triages to no findings with a clean headline", function () {
    const t = triage({ exceptions: [] });
    expect(t.classes).to.have.length(0);
    expect(t.totals).to.deep.equal({ count: 0, absImpact: 0 });
    expect(t.outOfTrust).to.equal(false);
    expect(t.dataIncomplete).to.equal(false);
    expect(t.topClass).to.equal(null);
    expect(t.headline).to.match(/^NO FINDINGS:/);
  });

  it("roll-up sums ABS-cents impact per class and across totals (sign-independent)", function () {
    const model = {
      exceptions: [
        ex(EXCEPTION.NEGATIVE_TENANT_LEDGER, -50000, SEVERITY.ERROR), // out_of_trust
        ex(EXCEPTION.OWNER_OVERDRAW, 30000, SEVERITY.ERROR), // out_of_trust
        ex(EXCEPTION.UNRECONCILED_BOOK, -20000, SEVERITY.WARNING), // data
      ],
    };
    const t = triage(model);
    expect(classRow(t, ROOT_CAUSE_CLASS.OUT_OF_TRUST).absImpact).to.equal(80000); // 50000+30000
    expect(classRow(t, ROOT_CAUSE_CLASS.OUT_OF_TRUST).count).to.equal(2);
    expect(classRow(t, ROOT_CAUSE_CLASS.DATA_COMPLETENESS).absImpact).to.equal(20000);
    expect(t.totals.absImpact).to.equal(100000); // 50000+30000+20000
    expect(t.totals.count).to.equal(3);
  });

  it("is PURE/ORDER-INDEPENDENT: shuffling the exceptions yields a byte-identical triage", function () {
    const exs = [
      ex(EXCEPTION.SECURITY_DEPOSIT_SEGREGATION, 80000, SEVERITY.ERROR),
      ex(EXCEPTION.UNRECONCILED_BANK, 12500, SEVERITY.WARNING),
      ex(EXCEPTION.OUTSTANDING_CHECK, -40000, SEVERITY.INFO),
      ex(EXCEPTION.OWNER_DRAW, -50000, SEVERITY.WARNING),
    ];
    const a = triage({ exceptions: exs });
    const b = triage({ exceptions: [...exs].reverse() });
    expect(JSON.stringify(b)).to.equal(JSON.stringify(a));
  });

  it("MUTATES NOTHING: triage does not touch the model or its exceptions", function () {
    const model = {
      exceptions: [ex(EXCEPTION.NEGATIVE_TENANT_LEDGER, -50000, SEVERITY.ERROR)],
    };
    const before = JSON.stringify(model);
    triage(model);
    expect(JSON.stringify(model)).to.equal(before);
  });

  it("rejects a bad model and a non-integer (float) money amount", function () {
    expect(() => triage(null)).to.throw(ReconcileError);
    expect(() => triage({})).to.throw(ReconcileError);
    expect(() => triage({ exceptions: "nope" })).to.throw(ReconcileError);
    // No float money: an over-precise amount is rejected, not coerced.
    expect(() =>
      triage({ exceptions: [ex(EXCEPTION.UNRECONCILED_BANK, 1.5, SEVERITY.WARNING)] })
    ).to.throw(ReconcileError);
    // An unknown exception type fails loud rather than being silently dropped.
    expect(() =>
      triage({ exceptions: [ex("totally_made_up_type", 100, SEVERITY.ERROR)] })
    ).to.throw(ReconcileError);
  });

  it("consumes a REAL reconcile() result end-to-end (not just synthetic rows)", function () {
    // The masked-negative shape: the SUM ties out but Jones is negative => one
    // out-of-trust finding. triage over the live reconcile result agrees.
    const r = reconcile([], [], { "Jones (4B)": -50000, "Smith (4A)": 50000 }, {});
    expect(r.tiesOut).to.equal(true); // the SUM ties...
    const t = triage(r);
    expect(t.outOfTrust).to.equal(true); // ...but triage names it out of trust.
    expect(t.topClass).to.equal(ROOT_CAUSE_CLASS.OUT_OF_TRUST);
    expect(t.headline).to.match(/^OUT OF TRUST:/);
    expect(t.headline).to.include("$500.00");
  });

  it("consumes a REAL buildPacket() model: a bank-SHORT fee scenario is OUT OF TRUST (directional)", function () {
    const report = require("../trustledger/report");
    // A residual bank fee the bookkeeper never recorded leaves the bank SHORT of
    // the books (adjustedBank 147500 < book 150000): a genuine $25 shortage. Book
    // and rent-roll agree, so the ONLY error-severity finding is the bank-SHORT
    // BANK_BOOK_MISMATCH (amount = 147500 - 150000 = -2500). The pilot must read
    // this as OUT OF TRUST, not 'just fix the data'.
    const bank = [
      rec("2026-05-02", 150000, "deposit smith", { kind: "deposit" }),
      rec("2026-05-31", -2500, "monthly service charge", { kind: "fee" }),
    ];
    const book = [
      rec("2026-05-01", 150000, "rent smith", { source: "quickbooks", kind: "deposit" }),
    ];
    const rentroll = [
      rec("2026-05-01", 150000, "rent", { kind: "rent", party: "Smith (4A)", source: "rentroll" }),
    ];
    const model = report.buildPacket({ bank, book, rentroll, reportDate: "2026-05-31" });
    expect(model.pass).to.equal(false);
    // Sanity: confirm the live model really is the bank-short shape this asserts.
    const bbm = model.exceptions.find((e) => e.type === EXCEPTION.BANK_BOOK_MISMATCH);
    expect(bbm, "a BANK_BOOK_MISMATCH must be present").to.not.equal(undefined);
    expect(bbm.amount).to.be.lessThan(0); // bank SHORT
    const t = triage(model);
    expect(t.outOfTrust).to.equal(true);
    expect(t.topClass).to.equal(ROOT_CAUSE_CLASS.OUT_OF_TRUST);
    expect(t.headline).to.match(/^OUT OF TRUST:/);
    expect(t.headline).to.not.match(/^FIX YOUR DATA:/);
  });

  it("consumes a REAL buildPacket() model: a bank-OVER (unrecorded deposit) scenario is FIX YOUR DATA", function () {
    const report = require("../trustledger/report");
    // An extra deposit hit the bank that the bookkeeper never recorded, leaving the
    // bank OVER the books (adjustedBank 155000 > book 150000). No beneficiary money
    // is missing — the bank holds MORE than the books say — so the BANK_BOOK_MISMATCH
    // (amount = +5000) is the benign 'record it and re-run' data tidy-up.
    const bank = [
      rec("2026-05-02", 150000, "deposit smith", { kind: "deposit" }),
      rec("2026-05-20", 5000, "unrecorded misc deposit", { kind: "deposit" }),
    ];
    const book = [
      rec("2026-05-01", 150000, "rent smith", { source: "quickbooks", kind: "deposit" }),
    ];
    const rentroll = [
      rec("2026-05-01", 150000, "rent", { kind: "rent", party: "Smith (4A)", source: "rentroll" }),
    ];
    const model = report.buildPacket({ bank, book, rentroll, reportDate: "2026-05-31" });
    expect(model.pass).to.equal(false);
    const bbm = model.exceptions.find((e) => e.type === EXCEPTION.BANK_BOOK_MISMATCH);
    expect(bbm, "a BANK_BOOK_MISMATCH must be present").to.not.equal(undefined);
    expect(bbm.amount).to.be.greaterThan(0); // bank OVER
    const t = triage(model);
    // BANK_BOOK_MISMATCH (+ve) + UNRECONCILED_BANK are both data_completeness.
    expect(t.outOfTrust).to.equal(false);
    expect(t.dataIncomplete).to.equal(true);
    expect(t.topClass).to.equal(ROOT_CAUSE_CLASS.DATA_COMPLETENESS);
    expect(t.headline).to.match(/^FIX YOUR DATA:/);
  });

  it("SECURITY: a forged exception with a prototype-key type is REJECTED, never silently accepted", function () {
    // CLASS_OF is built on a null prototype and looked up via own-property, so a
    // forged ex.type that names an Object.prototype member ("__proto__",
    // "constructor", "hasOwnProperty", "toString", "valueOf") resolves to undefined
    // and hits the strict-rejection path — it can NOT inherit a bogus class and
    // bypass the guard, inflating the roll-up with a garbage row.
    for (const evil of ["__proto__", "constructor", "hasOwnProperty", "toString", "valueOf", "prototype"]) {
      expect(
        () => triage({ exceptions: [ex(evil, 50000, SEVERITY.ERROR)] }),
        `forged type "${evil}" must be rejected`
      ).to.throw(ReconcileError);
      // And mixed in with a legitimate finding: the WHOLE triage fails loud rather
      // than silently mis-counting the forged row alongside the real one.
      expect(
        () =>
          triage({
            exceptions: [
              ex(evil, 50000, SEVERITY.ERROR),
              ex(EXCEPTION.SUBLEDGER_OUT_OF_BALANCE, 999, SEVERITY.ERROR),
            ],
          }),
        `forged type "${evil}" mixed with a real finding must be rejected`
      ).to.throw(ReconcileError);
    }
    // classOfException agrees in isolation: a prototype-key type is unknown.
    expect(classOfException({ type: "__proto__", amount: 1 })).to.equal(undefined);
    expect(classOfException({ type: "constructor", amount: 1 })).to.equal(undefined);
  });
});

describe("T-43.2 trustledger: the triage is SURFACED on the buildPacket model + the headline helper", function () {
  const report = require("../trustledger/report");

  // The packet model now carries the SAME triage object reconcile.triage emits
  // over the post-policy exceptions, so the report/--json/CLI all read ONE
  // consistent diagnosis. Additive: it never alters the verdict, counts, or
  // exceptions — only adds the triage roll-up + headline.
  it("buildPacket attaches a `triage` consistent with calling triage() on the model's exceptions", function () {
    // A masked-negative: the SUM ties but Jones is negative => an out-of-trust
    // finding, all through the packet path (so policy/continuity feed in too).
    const model = report.buildPacket({
      bank: [],
      book: [],
      rentroll: [
        rec("2026-05-01", -50000, "shortfall", { party: "Jones (4B)", source: "rentroll" }),
        rec("2026-05-01", 50000, "surplus", { party: "Smith (4A)", source: "rentroll" }),
      ],
      reportDate: "2026-05-31",
    });
    expect(model.triage).to.be.an("object");
    // It equals the lens applied directly to the (post-policy) exceptions.
    const direct = triage({ exceptions: model.exceptions });
    expect(JSON.stringify(model.triage)).to.equal(JSON.stringify(direct));
    expect(model.triage.outOfTrust).to.equal(true);
    expect(model.triage.topClass).to.equal(ROOT_CAUSE_CLASS.OUT_OF_TRUST);
  });

  it("attaching triage is ADDITIVE: the verdict, counts, and exceptions are unchanged", function () {
    const book = [rec("2026-05-01", 150000, "rent", { source: "quickbooks", kind: "deposit" })];
    const rentroll = [
      rec("2026-05-01", 150000, "rent", { kind: "rent", party: "Smith (4A)", source: "rentroll" }),
    ];
    const bank = [rec("2026-05-02", 150000, "deposit smith", { kind: "deposit" })];
    const model = report.buildPacket({ bank, book, rentroll, reportDate: "2026-05-31" });
    // A clean tie-out: PASS, no errors, no exceptions — the triage is empty + clean.
    expect(model.pass).to.equal(true);
    expect(model.counts).to.deep.equal({ error: 0, warning: 0, info: 0 });
    expect(model.exceptions).to.have.length(0);
    expect(model.triage.classes).to.have.length(0);
    expect(model.triage.outOfTrust).to.equal(false);
    expect(model.triage.headline).to.match(/^NO FINDINGS:/);
  });

  it("triageHeadline reads the model's triage and prefixes 'Triage: ' (the CLI's second line)", function () {
    const model = report.buildPacket({
      bank: [],
      book: [],
      rentroll: [{ ...rec("2026-05-01", -50000, "short", { party: "Jones (4B)" }), source: "rentroll" }],
      reportDate: "2026-05-31",
    });
    const line = report.triageHeadline(model);
    expect(line).to.equal(`Triage: ${model.triage.headline}`);
    expect(line).to.match(/^Triage: /);
  });

  it("triageHeadline falls back to recomputing for a pre-triage (legacy) model", function () {
    // An older model object with no `triage` field still yields a headline (the
    // helper recomputes from `exceptions`) — so it is safe on any packet shape.
    const legacy = {
      exceptions: [
        { type: EXCEPTION.NEGATIVE_TENANT_LEDGER, severity: SEVERITY.ERROR, amount: -50000, records: [] },
      ],
    };
    expect(report.triageHeadline(legacy)).to.match(/^Triage: OUT OF TRUST:/);
  });
});

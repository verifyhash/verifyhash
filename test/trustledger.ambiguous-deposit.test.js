"use strict";

// ---------------------------------------------------------------------------
// T-39.1: a book deposit whose beneficiary type can't be determined raises a
// NEW `ambiguous_deposit` exception (default WARNING) — so a security deposit
// recorded WITHOUT a recognizable keyword becomes a LOUD, gradable finding
// instead of silently passing as a generic deposit.
//
// Properties under test:
//   * an unlabeled book deposit (memo "Deposit - 12B Smith", party set,
//     deposit-scale amount) now raises ambiguous_deposit (default WARNING) and
//     is no longer SILENTLY a generic deposit;
//   * a deposit that DOES match isSecurityDeposit raises ONLY
//     security_deposit_segregation (ERROR), never ambiguous_deposit (no
//     double-count of the same row);
//   * an explicitly rent-labeled receipt (kind "rent" / explicit marker) raises
//     NOTHING new;
//   * isAmbiguousDeposit is PURE (no fs / http / ethers / clock — a grep over
//     the module proves it) and deterministic.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const {
  reconcile,
  isAmbiguousDeposit,
  EXCEPTION,
  SEVERITY,
  DEFAULT_SEVERITY,
} = require("../trustledger/reconcile");

const { reconcile: matchReconcile } = require("../trustledger/match");

// Build a normalized record mirroring ingest.js shape (same helper the sibling
// reconcile test uses), with pass-through for the explicit deposit markers.
function rec(date, amount, memo = "", extra = {}) {
  const r = {
    date,
    amount,
    memo,
    kind: extra.kind || "other",
    party: extra.party || "",
    source: extra.source || "bank",
  };
  if (extra.depositType !== undefined) r.depositType = extra.depositType;
  if (extra.ambiguous !== undefined) r.ambiguous = extra.ambiguous;
  if (extra.expected !== undefined) r.expected = extra.expected;
  return r;
}

function exOf(result, type) {
  return result.exceptions.filter((e) => e.type === type);
}

describe("T-39.1 trustledger/reconcile: isAmbiguousDeposit predicate (PURE)", function () {
  it("flags a deposit-scale book inflow that calls itself a deposit with a party but NO recognized keyword", function () {
    const r = rec("2026-05-02", 120000, "Deposit - 12B Smith", {
      source: "quickbooks",
      kind: "deposit",
      party: "Smith (12B)",
    });
    expect(isAmbiguousDeposit(r)).to.equal(true);
  });

  it("does NOT flag a record with no party (an unattributed bare bank line is not over-flagged)", function () {
    const r = rec("2026-05-02", 120000, "Deposit", { kind: "deposit" });
    expect(isAmbiguousDeposit(r)).to.equal(false);
  });

  it("does NOT flag an OUTFLOW (negative amount) or a non-integer amount", function () {
    const out = rec("2026-05-02", -120000, "Deposit - 12B Smith", {
      kind: "deposit",
      party: "Smith (12B)",
    });
    expect(isAmbiguousDeposit(out)).to.equal(false);
    const frac = { ...out, amount: 1200.5 };
    expect(isAmbiguousDeposit(frac)).to.equal(false);
    expect(isAmbiguousDeposit(null)).to.equal(false);
    expect(isAmbiguousDeposit(undefined)).to.equal(false);
  });

  it("does NOT flag a deposit with a RECOGNIZED purpose keyword (rent, owner, payment, partial, refund, ...)", function () {
    const recognized = [
      "Rent received May",
      "Partial deposit (1 of 2)",
      "Tenant payment - unit 7",
      "Owner contribution Acme",
      "Refund deposit to tenant",
      "Operating transfer in",
      "Management fee credit",
      "ACH deposit from owner",
    ];
    for (const memo of recognized) {
      const r = rec("2026-05-02", 120000, memo, {
        source: "quickbooks",
        kind: "deposit",
        party: "Someone",
      });
      expect(isAmbiguousDeposit(r), `recognized: "${memo}"`).to.equal(false);
    }
  });

  it("does NOT flag a record that matches isSecurityDeposit (it is a RECOGNIZED security deposit, handled elsewhere)", function () {
    const r = rec("2026-05-02", 80000, "Security deposit - Jones 4B", {
      source: "quickbooks",
      kind: "deposit",
      party: "Jones (4B)",
    });
    expect(isAmbiguousDeposit(r)).to.equal(false);
  });

  it("honors EXPLICIT per-record markers so a labeled deposit/rent receipt is never flagged", function () {
    const base = {
      source: "quickbooks",
      kind: "deposit",
      party: "Smith (12B)",
    };
    // kind: "rent" explicit receipt
    expect(
      isAmbiguousDeposit(
        rec("2026-05-02", 120000, "Deposit - 12B Smith", { ...base, kind: "rent" })
      )
    ).to.equal(false);
    // explicit depositType
    expect(
      isAmbiguousDeposit(
        rec("2026-05-02", 120000, "Deposit - 12B Smith", {
          ...base,
          depositType: "rent",
        })
      )
    ).to.equal(false);
    // explicit ambiguous: false assertion
    expect(
      isAmbiguousDeposit(
        rec("2026-05-02", 120000, "Deposit - 12B Smith", { ...base, ambiguous: false })
      )
    ).to.equal(false);
    // explicit expected: true
    expect(
      isAmbiguousDeposit(
        rec("2026-05-02", 120000, "Deposit - 12B Smith", { ...base, expected: true })
      )
    ).to.equal(false);
  });

  it("is PURE: a grep over reconcile.js finds no fs / http / require('ethers') / clock use", function () {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "trustledger", "reconcile.js"),
      "utf8"
    );
    expect(src).to.not.match(/require\(['"]fs['"]\)/);
    expect(src).to.not.match(/require\(['"](node:)?http['"]\)/);
    expect(src).to.not.match(/require\(['"](node:)?https['"]\)/);
    expect(src).to.not.match(/require\(['"]ethers['"]\)/);
    expect(src).to.not.match(/Date\.now|new Date\(|performance\.now|Math\.random/);
  });
});

describe("T-39.1 trustledger/reconcile: ambiguous_deposit finding wired into reconcile()", function () {
  it("a book deposit with NO recognized keyword now raises ambiguous_deposit (default WARNING) — no longer silently generic", function () {
    // Bank sees the cleared deposit; the book records it as a bare, unlabeled
    // "Deposit - 12B Smith" with a party. Nothing in the prior engine would say
    // a word about it; now it is a LOUD, gradable WARNING.
    const bank = [rec("2026-05-02", 120000, "deposit smith", { kind: "deposit" })];
    const book = [
      rec("2026-05-01", 120000, "Deposit - 12B Smith", {
        source: "quickbooks",
        kind: "deposit",
        party: "Smith (12B)",
      }),
    ];
    const tenants = { "Smith (12B)": 120000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });

    const ex = exOf(r, EXCEPTION.AMBIGUOUS_DEPOSIT);
    expect(ex).to.have.length(1);
    expect(ex[0].amount).to.equal(120000);
    expect(ex[0].severity).to.equal(SEVERITY.WARNING);
    expect(ex[0].severity).to.equal(DEFAULT_SEVERITY[EXCEPTION.AMBIGUOUS_DEPOSIT]);
    expect(ex[0].label).to.match(/ambiguous deposit/i);
    expect(ex[0].records[0].memo).to.equal("Deposit - 12B Smith");
    // It is balance-neutral (the deposit cleared and is on the sub-ledger), so a
    // mere WARNING does NOT flip the three-way tie-out.
    expect(r.tiesOut).to.equal(true);
  });

  it("a deposit that DOES match isSecurityDeposit raises ONLY security_deposit_segregation (ERROR), never ambiguous_deposit", function () {
    const bank = [rec("2026-05-02", 80000, "security deposit jones", { kind: "deposit" })];
    const book = [
      // recognized security deposit, NO segregating transfer => the ERROR finding
      rec("2026-05-01", 80000, "Security deposit - Jones 4B", {
        source: "quickbooks",
        kind: "deposit",
        party: "Jones (4B)",
      }),
    ];
    const tenants = { "Jones (4B)": 80000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });

    const seg = exOf(r, EXCEPTION.SECURITY_DEPOSIT_SEGREGATION);
    expect(seg).to.have.length(1);
    expect(seg[0].severity).to.equal(SEVERITY.ERROR);
    // The SAME row must NOT also appear as ambiguous_deposit (no double-count).
    expect(exOf(r, EXCEPTION.AMBIGUOUS_DEPOSIT)).to.have.length(0);
  });

  it("an explicitly rent-labeled receipt (kind 'rent' / explicit marker) raises NOTHING new", function () {
    const bank = [rec("2026-05-02", 120000, "deposit smith", { kind: "deposit" })];
    const book = [
      // Same unlabeled-looking memo, but the producer marked it kind:"rent".
      rec("2026-05-01", 120000, "Deposit - 12B Smith", {
        source: "quickbooks",
        kind: "rent",
        party: "Smith (12B)",
      }),
    ];
    const tenants = { "Smith (12B)": 120000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });

    expect(exOf(r, EXCEPTION.AMBIGUOUS_DEPOSIT)).to.have.length(0);
    expect(exOf(r, EXCEPTION.SECURITY_DEPOSIT_SEGREGATION)).to.have.length(0);
    expect(r.exceptions.filter((e) => e.severity === SEVERITY.ERROR)).to.have.length(0);
    expect(r.tiesOut).to.equal(true);
  });

  it("a recognized rent deposit (memo contains 'rent') raises NOTHING new even without an explicit marker", function () {
    const bank = [rec("2026-05-02", 150000, "deposit jones", { kind: "deposit" })];
    const book = [
      rec("2026-05-01", 150000, "Rent received May - Jones", {
        source: "quickbooks",
        kind: "deposit",
        party: "Jones (4B)",
      }),
    ];
    const tenants = { "Jones (4B)": 150000 };
    const m = matchReconcile(bank, book);
    const r = reconcile(bank, book, tenants, { matchResult: m });
    expect(exOf(r, EXCEPTION.AMBIGUOUS_DEPOSIT)).to.have.length(0);
  });

  it("is deterministic + order-independent for the ambiguous finding", function () {
    const bank = [
      rec("2026-05-02", 120000, "deposit a", { kind: "deposit" }),
      rec("2026-05-03", 90000, "deposit b", { kind: "deposit" }),
    ];
    const book = [
      rec("2026-05-01", 120000, "Deposit - 12B Smith", {
        source: "quickbooks",
        kind: "deposit",
        party: "Smith (12B)",
      }),
      rec("2026-05-01", 90000, "Deposit - 4A Doe", {
        source: "quickbooks",
        kind: "deposit",
        party: "Doe (4A)",
      }),
    ];
    const tenants = { "Smith (12B)": 120000, "Doe (4A)": 90000 };
    const a = reconcile(bank, book, tenants, { matchResult: matchReconcile(bank, book) });
    const rb = [...book].reverse();
    const rk = [...bank].reverse();
    const b = reconcile(rk, rb, tenants, { matchResult: matchReconcile(rk, rb) });
    expect(JSON.stringify(b)).to.equal(JSON.stringify(a));
    expect(exOf(a, EXCEPTION.AMBIGUOUS_DEPOSIT)).to.have.length(2);
  });
});

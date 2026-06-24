"use strict";

// TrustLedger — reconcile.js
//
// T-22.3: the THREE-BALANCE check + exception classification.
//
// A real-estate broker who holds client money in a trust account is the legal
// custodian of that money. In every US state the broker must be able to prove,
// on demand, that THREE numbers agree:
//
//   1. BANK balance  — what the bank statement says the trust account holds.
//   2. BOOK balance  — what the broker's own ledger (QuickBooks) says it holds.
//   3. SUB-LEDGER    — the SUM of every individual beneficiary's balance (each
//      tenant's deposit/credit, each owner's held funds). The trust account is
//      pooled, so the bank holds ONE number that must equal the sum of all the
//      little per-beneficiary numbers underneath it.
//
// This is the "three-way reconciliation" the product sells. When all three tie
// out, the broker is clean. When they DON'T, the gap is the audit finding, and
// it is almost always explained by a small set of well-known RECONCILING ITEMS
// (timing) or genuine EXCEPTIONS (a real shortage/overage, an owner draw that
// touched a tenant's money, a bounced deposit, a security deposit that was not
// segregated). This module computes the three balances, decides whether they
// tie out, and CLASSIFIES every reconciling item / exception so a human sees
// exactly what to fix.
//
// PURE + DETERMINISTIC. Given the same inputs (and the upstream match.js result)
// it returns byte-identical output regardless of input order. No clock, no I/O,
// no randomness — the same property the matcher has, for the same reason: a
// reconciliation a broker signs and an auditor reads must be reproducible.
//
// -------------------------------------------------------------------------
// Sign convention (inherited from ingest.js):
//   amount > 0  => money INTO the trust account (deposit, rent, owner funding)
//   amount < 0  => money OUT of the trust account (check, draw, fee, refund)
// A "balance" here is therefore a running net of signed amounts plus a known
// opening balance.
// -------------------------------------------------------------------------
//
// Return shape:
//   {
//     balances: {
//       bank:           <int cents>,   // opening + bank activity
//       book:           <int cents>,   // opening + book activity
//       subledger:      <int cents>,   // sum of per-beneficiary balances
//       adjustedBank:   <int cents>,   // bank +/- outstanding items
//       reconciled:     <int cents>,   // the single number all three should hit
//     },
//     tiesOut: <bool>,                 // do all three agree after reconciling items?
//     exceptions: [
//       { type, severity, amount, label, detail, records } , ...
//     ],
//   }
//
// `type` is one of EXCEPTION (a stable machine string). `severity` is "info"
// for benign timing items that EXPLAIN a gap vs. "error" for items that mean
// the trust account is actually out of trust (a shortage, commingling, an
// unsegregated deposit). `label` is a short human caption; `detail` a sentence.

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

const EXCEPTION = Object.freeze({
  OUTSTANDING_DEPOSIT: "outstanding_deposit", // in book, not yet on bank (in transit)
  OUTSTANDING_CHECK: "outstanding_check", // written in book, not yet cleared bank
  NSF_REVERSAL: "nsf_reversal", // a bounced deposit reversed by the bank
  OWNER_DRAW: "owner_draw", // owner pulled funds (must not dip into tenant money)
  SECURITY_DEPOSIT_SEGREGATION: "security_deposit_segregation", // deposit not held separately
  TIMING: "timing", // generic date-window timing difference
  UNRECONCILED_BANK: "unreconciled_bank", // a bank line nothing explains
  UNRECONCILED_BOOK: "unreconciled_book", // a book line nothing explains
  SUBLEDGER_OUT_OF_BALANCE: "subledger_out_of_balance", // sum-of-tenants != book
  BANK_BOOK_MISMATCH: "bank_book_mismatch", // adjusted bank != book
});

const SEVERITY = Object.freeze({
  INFO: "info", // a benign, self-clearing reconciling item (timing)
  WARNING: "warning", // needs a human eye but may be legitimate
  ERROR: "error", // trust account is out of trust: a real finding
});

// Map each exception type to its default severity. Timing/outstanding items are
// the normal, expected reconciling items (INFO). A draw, an unsegregated
// security deposit, an NSF, or any balance that fails to tie is a real finding.
const DEFAULT_SEVERITY = Object.freeze({
  [EXCEPTION.OUTSTANDING_DEPOSIT]: SEVERITY.INFO,
  [EXCEPTION.OUTSTANDING_CHECK]: SEVERITY.INFO,
  [EXCEPTION.TIMING]: SEVERITY.INFO,
  [EXCEPTION.NSF_REVERSAL]: SEVERITY.WARNING,
  [EXCEPTION.OWNER_DRAW]: SEVERITY.WARNING,
  [EXCEPTION.SECURITY_DEPOSIT_SEGREGATION]: SEVERITY.ERROR,
  [EXCEPTION.UNRECONCILED_BANK]: SEVERITY.WARNING,
  [EXCEPTION.UNRECONCILED_BOOK]: SEVERITY.WARNING,
  [EXCEPTION.SUBLEDGER_OUT_OF_BALANCE]: SEVERITY.ERROR,
  [EXCEPTION.BANK_BOOK_MISMATCH]: SEVERITY.ERROR,
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class ReconcileError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReconcileError";
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sumAmounts(records) {
  let t = 0;
  for (const r of records) {
    if (!Number.isInteger(r.amount)) {
      throw new ReconcileError("record.amount must be integer cents");
    }
    t += r.amount;
  }
  return t;
}

function isOwnerDraw(rec) {
  const t = `${rec.memo || ""} ${rec.party || ""} ${rec.kind || ""}`.toLowerCase();
  // An owner DRAW is money OUT, attributed to the owner (not a tenant/vendor).
  return rec.amount < 0 && /\bowner\b|\bdraw\b|disbursement to owner|owner distribution/.test(t);
}

function isSecurityDeposit(rec) {
  const t = `${rec.memo || ""} ${rec.party || ""} ${rec.kind || ""}`.toLowerCase();
  return /security deposit|sec dep|sec\.? deposit|damage deposit|\bdeposit held\b/.test(t);
}

function isNsf(rec) {
  if (rec.kind === "nsf") return true;
  const t = `${rec.memo || ""} ${rec.kind || ""}`.toLowerCase();
  return /\bnsf\b|returned|bounced|insufficient|reversal/.test(t);
}

// A canonical, order-independent sort key for a record (date, amount, memo).
function recKey(r) {
  return `${r.date}|${String(r.amount).padStart(16, "0")}|${(r.memo || "")
    .toLowerCase()
    .trim()}|${(r.party || "").toLowerCase().trim()}`;
}

function pushException(out, ex) {
  out.push({
    type: ex.type,
    severity: ex.severity || DEFAULT_SEVERITY[ex.type] || SEVERITY.WARNING,
    amount: ex.amount,
    label: ex.label,
    detail: ex.detail,
    records: ex.records || [],
  });
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

// Inputs:
//   bank:      NormalizedRecord[]  (source = bank)
//   book:      NormalizedRecord[]  (source = quickbooks)
//   tenants:   either
//                - NormalizedRecord[]  (rent-roll rows; we net per party), OR
//                - { [party]: <balanceCents> }  (precomputed per-tenant balances)
//   opts:
//     opening:   { bank, book } opening balances in cents (default 0/0)
//     matchResult: the object returned by match.reconcile(bank, book) — used to
//                  identify which lines are reconciling items (outstanding /
//                  in-transit) vs. genuinely unexplained exceptions. Optional;
//                  if omitted we classify purely from the records themselves.
//     toleranceCents: how far the three may differ and still "tie out" (default 0;
//                  money ties to the penny — a non-zero tolerance must be a
//                  deliberate caller choice).
function reconcile(bank, book, tenants, opts = {}) {
  if (!Array.isArray(bank)) throw new ReconcileError("bank must be an array");
  if (!Array.isArray(book)) throw new ReconcileError("book must be an array");
  const cfg = {
    opening: { bank: 0, book: 0 },
    matchResult: null,
    toleranceCents: 0,
    ...opts,
  };
  cfg.opening = { bank: 0, book: 0, ...(opts.opening || {}) };
  if (!Number.isInteger(cfg.toleranceCents) || cfg.toleranceCents < 0) {
    throw new ReconcileError("toleranceCents must be a non-negative integer");
  }
  if (
    !Number.isInteger(cfg.opening.bank) ||
    !Number.isInteger(cfg.opening.book)
  ) {
    throw new ReconcileError("opening balances must be integer cents");
  }

  // -- The three raw balances. ---------------------------------------------
  const bankBalance = cfg.opening.bank + sumAmounts(bank);
  const bookBalance = cfg.opening.book + sumAmounts(book);
  const subBalances = tenantBalances(tenants);
  const subledgerBalance = Object.values(subBalances).reduce((a, b) => a + b, 0);

  const exceptions = [];

  // -- Identify reconciling items from the matcher (timing in/out of bank). -
  // Anything in the BOOK that the matcher could not pair to a BANK line is
  // "outstanding": the book knows about it but the bank doesn't yet. A positive
  // such item is a deposit in transit; a negative one is an outstanding check.
  // Anything on the BANK with no book partner is a bank-only line (a fee the
  // bookkeeper hasn't recorded, or an NSF reversal) — also a reconciling item,
  // classified by what it is.
  let outstandingDeposits = 0;
  let outstandingChecks = 0;

  // The caller runs match.reconcile(bank, book), so listA == bank (=> unmatchedA)
  // and listB == book (=> unmatchedB).
  const unmatchedBank = matcherUnmatched(cfg.matchResult, "unmatchedA", bank, book, "bank");
  const unmatchedBook = matcherUnmatched(cfg.matchResult, "unmatchedB", bank, book, "book");

  // Book-only lines => outstanding items (book ahead of bank).
  for (const r of [...unmatchedBook].sort((x, y) => cmp(recKey(x), recKey(y)))) {
    if (isNsf(r)) {
      pushException(exceptions, {
        type: EXCEPTION.NSF_REVERSAL,
        amount: r.amount,
        label: "NSF / returned-item reversal (book)",
        detail:
          "A bounced or returned item recorded in the book; confirm the bank " +
          "posted the matching reversal and the tenant balance was re-debited.",
        records: [r],
      });
      continue;
    }
    if (r.amount > 0) {
      outstandingDeposits += r.amount;
      pushException(exceptions, {
        type: EXCEPTION.OUTSTANDING_DEPOSIT,
        amount: r.amount,
        label: "Deposit in transit",
        detail:
          "Recorded in the book but not yet on the bank statement; expected to " +
          "clear in the next few days (timing).",
        records: [r],
      });
    } else if (r.amount < 0) {
      outstandingChecks += r.amount; // negative
      pushException(exceptions, {
        type: isOwnerDraw(r) ? EXCEPTION.OWNER_DRAW : EXCEPTION.OUTSTANDING_CHECK,
        amount: r.amount,
        label: isOwnerDraw(r) ? "Outstanding owner draw" : "Outstanding check",
        detail: isOwnerDraw(r)
          ? "An owner draw written in the book that has not yet cleared the bank; " +
            "verify it does not draw against tenant or security-deposit funds."
          : "A check written in the book that has not yet cleared the bank (timing).",
        records: [r],
      });
    }
  }

  // Bank-only lines => the bank knows something the book doesn't yet.
  for (const r of [...unmatchedBank].sort((x, y) => cmp(recKey(x), recKey(y)))) {
    if (isNsf(r)) {
      pushException(exceptions, {
        type: EXCEPTION.NSF_REVERSAL,
        amount: r.amount,
        label: "NSF / returned-item reversal (bank)",
        detail:
          "The bank reversed a deposit that bounced; the book must record the " +
          "reversal and re-debit the tenant's sub-ledger.",
        records: [r],
      });
    } else {
      pushException(exceptions, {
        type: EXCEPTION.UNRECONCILED_BANK,
        amount: r.amount,
        label: "Unreconciled bank line",
        detail:
          "A bank transaction with no matching book entry; record it in the " +
          "book or explain it before signing.",
        records: [r],
      });
    }
  }

  // -- Adjusted bank balance: bank +/- the outstanding (in-transit) items. --
  // adjustedBank = bank + deposits-in-transit + outstanding-checks(negative).
  // After this adjustment the bank should equal the book.
  const adjustedBank = bankBalance + outstandingDeposits + outstandingChecks;

  // -- Classify owner draws and security-deposit segregation across ALL book
  //    activity (not only the unmatched), since these are policy findings about
  //    what the money WAS, independent of whether the line cleared. -----------
  classifyOwnerDraws(book, subBalances, exceptions);
  classifySecurityDeposits(book, bank, exceptions);

  // -- The three-way tie-out. ----------------------------------------------
  // After reconciling items, adjustedBank should equal book, and book should
  // equal the sum of the sub-ledgers.
  const tol = cfg.toleranceCents;
  const bankBookGap = adjustedBank - bookBalance;
  const bookSubGap = bookBalance - subledgerBalance;

  if (Math.abs(bankBookGap) > tol) {
    pushException(exceptions, {
      type: EXCEPTION.BANK_BOOK_MISMATCH,
      amount: bankBookGap,
      label: "Adjusted bank does not equal book",
      detail:
        `After outstanding items the bank balance (${adjustedBank}) and the ` +
        `book balance (${bookBalance}) differ by ${bankBookGap} cents; an ` +
        "unrecorded transaction or a posting error remains.",
      records: [],
    });
  }
  if (Math.abs(bookSubGap) > tol) {
    pushException(exceptions, {
      type: EXCEPTION.SUBLEDGER_OUT_OF_BALANCE,
      amount: bookSubGap,
      label: "Sum of tenant sub-ledgers does not equal book",
      detail:
        `The book balance (${bookBalance}) and the sum of all beneficiary ` +
        `sub-ledger balances (${subledgerBalance}) differ by ${bookSubGap} ` +
        "cents; the trust account is out of trust until this is resolved.",
      records: [],
    });
  }

  const tiesOut =
    Math.abs(bankBookGap) <= tol && Math.abs(bookSubGap) <= tol;

  // Stable, deterministic ordering of exceptions: by severity (errors first),
  // then type, then amount, then a record key — independent of detection order.
  exceptions.sort(compareExceptions);

  return {
    balances: {
      bank: bankBalance,
      book: bookBalance,
      subledger: subledgerBalance,
      adjustedBank,
      reconciled: tiesOut ? bookBalance : null,
    },
    tiesOut,
    exceptions,
  };
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// The canonical, stable severity-first ordering of an exception list: errors
// before warnings before info, then by type, then by amount, then by a record
// key — independent of detection order. Exported (and reused by policy.js's
// applyPolicy) so the order an auditor reads is computed in ONE place and a
// freshly-escalated ERROR re-sorts to the top of the table the same way a
// natively-detected one does. Pure: a comparator over two exceptions.
const SEV_RANK = Object.freeze({ error: 0, warning: 1, info: 2 });
function compareExceptions(a, b) {
  const sa = SEV_RANK[a.severity] ?? 3;
  const sb = SEV_RANK[b.severity] ?? 3;
  if (sa !== sb) return sa - sb;
  if (a.type !== b.type) return cmp(a.type, b.type);
  if (a.amount !== b.amount) return a.amount - b.amount;
  const ka = a.records && a.records[0] ? recKey(a.records[0]) : "";
  const kb = b.records && b.records[0] ? recKey(b.records[0]) : "";
  return cmp(ka, kb);
}

// Net the rent-roll rows into a per-beneficiary balance map, or accept a
// precomputed { party -> cents } map directly.
function tenantBalances(tenants) {
  if (tenants == null) return {};
  if (!Array.isArray(tenants)) {
    // Precomputed balance map.
    const out = {};
    for (const [k, v] of Object.entries(tenants)) {
      if (!Number.isInteger(v)) {
        throw new ReconcileError(`tenant balance for "${k}" must be integer cents`);
      }
      out[k] = v;
    }
    return out;
  }
  const out = {};
  for (const r of tenants) {
    const party = String(r.party || "unknown").trim() || "unknown";
    if (!Number.isInteger(r.amount)) {
      throw new ReconcileError("tenant record.amount must be integer cents");
    }
    out[party] = (out[party] || 0) + r.amount;
  }
  return out;
}

// Pull the matcher's unmatched list for one side, falling back to "everything"
// when no matchResult was supplied (so the function still works standalone).
function matcherUnmatched(matchResult, key, bank, book, side) {
  if (matchResult && Array.isArray(matchResult[key])) {
    return matchResult[key];
  }
  // No matcher result: derive a best-effort reconciling set by cancelling out
  // bank/book lines that share the same (amount) so only the genuine residue
  // remains. This keeps reconcile() useful on its own while staying deterministic.
  if (!matchResult) {
    return residue(side === "bank" ? bank : book, side === "bank" ? book : bank);
  }
  return [];
}

// Multiset difference by amount: return the records in `self` whose amounts are
// not cancelled by an equal amount in `other`. Deterministic.
function residue(self, other) {
  const otherCounts = new Map();
  for (const r of other) {
    otherCounts.set(r.amount, (otherCounts.get(r.amount) || 0) + 1);
  }
  const out = [];
  for (const r of [...self].sort((x, y) => cmp(recKey(x), recKey(y)))) {
    const c = otherCounts.get(r.amount) || 0;
    if (c > 0) {
      otherCounts.set(r.amount, c - 1);
    } else {
      out.push(r);
    }
  }
  return out;
}

// Owner draws: flag every owner-draw line, and ESCALATE to an error if drawing
// it would leave the pooled balance below the protected (tenant) sub-ledger
// total — i.e. the owner is being paid out of someone else's money.
function classifyOwnerDraws(book, subBalances, exceptions) {
  const protectedTotal = Object.values(subBalances).reduce((a, b) => a + b, 0);
  for (const r of [...book]
    .filter(isOwnerDraw)
    .sort((x, y) => cmp(recKey(x), recKey(y)))) {
    // Already emitted as OUTSTANDING owner draw above if it was unmatched; emit
    // the policy-level OWNER_DRAW classification here once, deduped by record.
    if (
      exceptions.some(
        (e) => e.type === EXCEPTION.OWNER_DRAW && e.records[0] && recKey(e.records[0]) === recKey(r)
      )
    ) {
      continue;
    }
    pushException(exceptions, {
      type: EXCEPTION.OWNER_DRAW,
      amount: r.amount,
      label: "Owner draw",
      detail:
        "A disbursement to the property owner; confirm it is paid only from " +
        "that owner's own funds and never from tenant or security-deposit money.",
      records: [r],
    });
  }
  // Note: protectedTotal is used by the bank/book vs sub-ledger tie-out; an
  // owner draw that breaks segregation surfaces there as SUBLEDGER_OUT_OF_BALANCE.
  void protectedTotal;
}

// Security-deposit segregation: every security-deposit RECEIPT recorded in the
// book must have a corresponding movement OUT to a segregated account (or be
// flagged as held separately). If a security-deposit inflow is sitting in the
// operating/pooled book with no offsetting segregation transfer, that is a
// compliance finding in many states.
function classifySecurityDeposits(book, bank, exceptions) {
  // Find security-deposit inflows in the book.
  const secDeposits = [...book]
    .filter((r) => isSecurityDeposit(r) && r.amount > 0)
    .sort((x, y) => cmp(recKey(x), recKey(y)));
  if (secDeposits.length === 0) return;

  // A segregation movement is an OUTFLOW whose memo references segregation /
  // transfer of the deposit.
  const isSegregationMove = (r) => {
    const t = `${r.memo || ""} ${r.kind || ""}`.toLowerCase();
    return (
      r.amount < 0 &&
      (/segregat|transfer to (security|escrow|trust)|to security deposit account|escrow/.test(t) ||
        (isSecurityDeposit(r) && /transfer|segregat|escrow/.test(t)))
    );
  };
  // CRITICAL: count each segregation transfer from ONE authoritative source —
  // the BOOK — never from both book and bank. A single real segregation transfer
  // is recorded twice (once in QuickBooks, once on the bank statement) because it
  // is the same money movement seen from two sources. Summing across both sources
  // double-counts one $X transfer as $2X of coverage, which can SILENTLY CLEAR a
  // genuinely un-segregated security deposit — a false negative on the flagship
  // finding this product exists to catch. The bank-side copy is the mirror of the
  // same movement (match.js pairs them); it adds no NEW segregation, so it must
  // NOT add coverage. `bank` is therefore intentionally unused for the sum.
  const segregatedAmount = [...book]
    .filter(isSegregationMove)
    .reduce((a, r) => a + Math.abs(r.amount), 0);
  void bank;

  let coveredRemaining = segregatedAmount;
  for (const r of secDeposits) {
    if (coveredRemaining >= r.amount) {
      coveredRemaining -= r.amount; // this deposit's segregation is accounted for
      continue;
    }
    // Not (fully) segregated.
    pushException(exceptions, {
      type: EXCEPTION.SECURITY_DEPOSIT_SEGREGATION,
      amount: r.amount,
      label: "Security deposit not segregated",
      detail:
        "A security-deposit receipt with no matching transfer to a segregated " +
        "deposit account; many states require security deposits be held " +
        "separately from operating trust funds.",
      records: [r],
    });
    coveredRemaining = 0;
  }
}

module.exports = {
  reconcile,
  ReconcileError,
  EXCEPTION,
  SEVERITY,
  DEFAULT_SEVERITY,
  // exported for focused tests / reuse
  tenantBalances,
  compareExceptions,
};

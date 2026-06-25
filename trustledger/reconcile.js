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
  OWNER_OVERDRAW: "owner_overdraw", // owner drew MORE than their own contributed capital (tenant money)
  SECURITY_DEPOSIT_SEGREGATION: "security_deposit_segregation", // deposit not held separately
  AMBIGUOUS_DEPOSIT: "ambiguous_deposit", // a book deposit whose beneficiary type can't be determined
  TIMING: "timing", // generic date-window timing difference
  UNRECONCILED_BANK: "unreconciled_bank", // a bank line nothing explains
  UNRECONCILED_BOOK: "unreconciled_book", // a book line nothing explains
  SUBLEDGER_OUT_OF_BALANCE: "subledger_out_of_balance", // sum-of-tenants != book
  NEGATIVE_TENANT_LEDGER: "negative_tenant_ledger", // an individual beneficiary balance is below zero
  BANK_BOOK_MISMATCH: "bank_book_mismatch", // adjusted bank != book
  CONTINUITY_BREAK: "continuity_break", // this period's opening != prior period's signed ending
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
  // An owner that DRAWS more than its OWN contributed capital paid itself out of
  // other beneficiaries' trust money (the excess). That is a conversion of trust
  // funds and leaves the account out of trust REGARDLESS of whether the pooled
  // sum still ties via the owner's negative control bucket, so it is an
  // ERROR-grade finding by default. A state MAY re-grade it via policy.
  [EXCEPTION.OWNER_OVERDRAW]: SEVERITY.ERROR,
  [EXCEPTION.SECURITY_DEPOSIT_SEGREGATION]: SEVERITY.ERROR,
  // A deposit whose beneficiary type we cannot determine (no recognizable
  // keyword, not an explicitly-labeled rent/receipt) is a WARNING by default: it
  // MIGHT be an un-segregated security deposit hiding as a generic deposit, so a
  // human must look — but absent a security-deposit signal we do NOT escalate it
  // to the out-of-trust ERROR a confirmed unsegregated deposit gets. A state MAY
  // re-grade it via policy.
  [EXCEPTION.AMBIGUOUS_DEPOSIT]: SEVERITY.WARNING,
  [EXCEPTION.UNRECONCILED_BANK]: SEVERITY.WARNING,
  [EXCEPTION.UNRECONCILED_BOOK]: SEVERITY.WARNING,
  [EXCEPTION.SUBLEDGER_OUT_OF_BALANCE]: SEVERITY.ERROR,
  // An individual beneficiary whose own sub-ledger balance is NEGATIVE means the
  // trust account is short for that beneficiary — money the broker holds in trust
  // FOR that person is not actually there (it was spent, or used to cover another
  // beneficiary's shortfall). That is out of trust REGARDLESS of whether the
  // pooled SUM still ties to the book, so it is an ERROR-grade finding by default.
  [EXCEPTION.NEGATIVE_TENANT_LEDGER]: SEVERITY.ERROR,
  [EXCEPTION.BANK_BOOK_MISMATCH]: SEVERITY.ERROR,
  // A broken roll-forward means the books do not actually continue from the
  // signed prior period — an out-of-trust-grade finding by default. A state MAY
  // re-grade a documented timing roll-forward difference to a warning via policy.
  [EXCEPTION.CONTINUITY_BREAK]: SEVERITY.ERROR,
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

// A CLOSED allowlist of purpose keywords that make a book inflow's beneficiary
// type RECOGNIZABLE. If a deposit's memo/kind matches ANY of these, we know what
// the money is (rent, an owner contribution, a refund, a fee credit, a payment
// installment, an explicit transfer, etc.), so it is NOT ambiguous. Security-
// deposit keywords are handled separately by isSecurityDeposit (which produces
// the ERROR-grade segregation finding) and so are intentionally NOT here — a
// recognizable security deposit must never be downgraded to a mere "recognized"
// inflow. Keeping the list CLOSED means a genuinely-unlabeled "Deposit - 12B
// Smith" stays LOUD instead of being silently swept into a generic bucket.
const RECOGNIZED_DEPOSIT_PURPOSE =
  /\brent\b|\brents?\b|lease|tenant payment|\bpayment\b|\bpaid\b|partial|installment|instalment|\bowner\b|contribution|capital|reserve|distribution|\bdraw\b|\brefund\b|reimburs|\bfee\b|charge|interest|\bnsf\b|returned|bounced|reversal|transfer|segregat|escrow|in transit|in-transit|operating|management|commission|\bproceeds\b|payoff|\bach\b|wire|adjustment|correction|chargeback/;

// An EXPLICIT per-record marker that LABELS the deposit, so a labeled deposit /
// rent receipt is never flagged as ambiguous even if its free-text memo happens
// to lack a recognized keyword. Honored markers (any one suffices):
//   * rec.kind === "rent"                 — an explicit rent receipt
//   * rec.depositType is a non-empty str  — the beneficiary type was stated
//   * rec.ambiguous === false             — the caller asserts it is determined
//   * rec.expected === true               — an expected/known line
// A marker is a deliberate, structured assertion by the producer of the row —
// distinct from us GUESSING from free text — so it is authoritative here.
function hasExplicitDepositLabel(rec) {
  if (rec.kind === "rent") return true;
  if (typeof rec.depositType === "string" && rec.depositType.trim() !== "") {
    return true;
  }
  if (rec.ambiguous === false) return true;
  if (rec.expected === true) return true;
  return false;
}

// A book deposit whose BENEFICIARY TYPE cannot be determined: a deposit-scale
// INFLOW that calls itself a "deposit" (the word, or kind === "deposit") but
// carries NO recognized purpose keyword and is NOT an explicitly-labeled
// rent/receipt — so we cannot tell whether it is rent, an owner contribution, or
// an un-segregated security deposit hiding as a generic deposit. We REQUIRE a
// party (an attributed beneficiary) so a bare bank-statement "Deposit" line with
// no counterparty is not over-flagged. A record that already matches
// isSecurityDeposit is NOT ambiguous — it is a recognized security deposit and is
// handled (as an ERROR) by classifySecurityDeposits; flagging it here too would
// double-count the same row. PURE: free-text classification only — no fs, no
// http, no ethers, no clock.
function isAmbiguousDeposit(rec) {
  if (!rec) return false;
  if (!Number.isInteger(rec.amount) || rec.amount <= 0) return false; // inflow only
  if (hasExplicitDepositLabel(rec)) return false; // labeled => determined
  if (isSecurityDeposit(rec)) return false; // recognized sec dep => not ambiguous
  if (isOwnerDraw(rec) || isNsf(rec)) return false; // recognized otherwise
  const party = String(rec.party || "").trim();
  if (party === "") return false; // unattributed bare line: don't over-flag
  const t = `${rec.memo || ""} ${rec.kind || ""}`.toLowerCase();
  // It must call itself a deposit (the only signal we have), ...
  const callsItselfDeposit = /\bdeposit\b/.test(t) || rec.kind === "deposit";
  if (!callsItselfDeposit) return false;
  // ... and offer NO recognized purpose to disambiguate it.
  if (RECOGNIZED_DEPOSIT_PURPOSE.test(t)) return false;
  return true;
}

// The canonical, order-independent per-BENEFICIARY key for a record's party.
// Mirrors the sub-ledger's own normalization (tenantBalances uses the SAME
// `String(party).trim()` convention) so a deposit and a segregation transfer
// that name the same tenant bucket together. Case-folded + whitespace-collapsed
// so "Jones (4B)" and "jones (4b)" are ONE beneficiary. An empty/absent party
// normalizes to "" — the sentinel for "no attributable beneficiary", which the
// segregation matcher treats as covering NOTHING on its own. PURE.
function partyKey(party) {
  return String(party == null ? "" : party)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
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
  classifyOwnerDraws(book, subBalances, exceptions, cfg.toleranceCents);
  classifySecurityDeposits(book, bank, exceptions);
  // A deposit whose beneficiary type can't be determined is a LOUD WARNING, but
  // only AFTER classifySecurityDeposits has had its say: isAmbiguousDeposit
  // excludes anything isSecurityDeposit recognizes, so a confirmed un-segregated
  // security deposit raises ONLY the ERROR-grade segregation finding (no
  // double-count), while a previously-silent generic-looking deposit is no
  // longer swept under the rug.
  classifyAmbiguousDeposits(book, exceptions);

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

  // -- Per-beneficiary negative-ledger check (T-41.1). ----------------------
  // ORTHOGONAL to the pooled SUBLEDGER_OUT_OF_BALANCE check above: the SUM of all
  // sub-ledgers can tie perfectly to the book while an INDIVIDUAL beneficiary's
  // balance is negative — one tenant's surplus masking another tenant's deficit
  // in the pooled total. A negative individual ledger means the broker is holding
  // LESS than zero in trust for that person: their money was spent or used to
  // cover someone else. That is out of trust on its own, so flag it regardless of
  // whether the SUM ties. This can only ADD findings (it never removes one), so
  // it is strictly non-looser. A control/sink account is excluded only when it is
  // STRUCTURALLY marked (`controlAccount: true`, authoritative) or its name leads
  // with a control word; a real beneficiary whose name merely contains a control
  // token in a non-leading position is no longer silently dropped.
  classifyNegativeTenantLedgers(subBalances, tol, exceptions, controlAccountKeys(tenants));

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

// Build a CONTINUITY_BREAK exception from a non-zero roll-forward gap. PURE.
// `cont` is the structured result of close.checkContinuity(priorClose, opening):
// { ok, bankGap, bookGap }. The exception carries the bank gap in `amount` (the
// headline number) and BOTH gaps + the prior period label in `detail`, so an
// auditor reads exactly which leg failed to roll forward and by how much. The
// severity is the DEFAULT_SEVERITY for the type (error) unless the caller's
// policy later overrides it — it flows through the SAME applyPolicy path as
// every other exception. Returns null when there is no gap (ok), so the caller
// can simply skip a null.
function buildContinuityException(cont, priorPeriodLabel) {
  if (!cont || cont.ok) return null;
  const bankGap = Number.isInteger(cont.bankGap) ? cont.bankGap : 0;
  const bookGap = Number.isInteger(cont.bookGap) ? cont.bookGap : 0;
  const priorName =
    priorPeriodLabel == null || String(priorPeriodLabel).trim() === ""
      ? "the prior period"
      : `prior period "${String(priorPeriodLabel)}"`;
  return {
    type: EXCEPTION.CONTINUITY_BREAK,
    severity: DEFAULT_SEVERITY[EXCEPTION.CONTINUITY_BREAK],
    amount: bankGap,
    label: "Roll-forward continuity break",
    detail:
      `This period's opening balances do not roll forward from ${priorName}: ` +
      `the bank opening differs from the prior ending by ${bankGap} cents and ` +
      `the book opening differs by ${bookGap} cents. A non-zero gap means a ` +
      "period was skipped, edited, or re-keyed and the chain of custody over " +
      "the trust money is broken; reconcile the opening to the prior signed " +
      "ending before relying on this packet.",
    records: [],
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

// Owner draws (T-22.3 + T-42.1). TWO findings, computed in ONE pass over the
// owner activity in the book:
//
//   1. OWNER_DRAW (warning, per line) — every owner-draw line is classified so a
//      human confirms it was paid only from the owner's OWN funds.
//
//   2. OWNER_OVERDRAW (ERROR, per owner account) — when an owner DRAWS MORE than
//      that owner CONTRIBUTED in this period's book, the EXCESS is tenant money:
//      the owner paid themselves out of someone else's trust funds. This is the
//      single most-prosecuted residential-PM trust violation (conversion), and
//      before T-42.1 it was a SILENT PASS whenever the owner was modeled as a
//      control-account sub-ledger party — the pooled SUM still ties to the book
//      via the owner's negative bucket, and the EPIC-41 negative-ledger check
//      deliberately EXCLUDES control/owner accounts (an owner's negative is
//      structural WHILE it stays within the owner's own contributed capital).
//      That EPIC-41 exclusion was UNBOUNDED: it also swallowed the negative
//      BEYOND contributed capital. OWNER_OVERDRAW is the precise INVERSE: EPIC-41
//      keeps ignoring the negative WITHIN contributed capital (the owner
//      legitimately deploying their OWN funds, which every existing owner-draw
//      test exercises and which stays PASS), and this check catches only the
//      negative BEYOND it.
//
// Per owner account (keyed by the draw's party, case-folded):
//   C = contributed capital = the sum of that account's OWN positive book inflows
//       in this period (the basis the owner is entitled to draw against).
//   D = total draws          = the sum of |amount| of that account's owner-draw
//       lines in the book.
//   B = the account's sub-ledger balance (how negative the owner actually went).
// The over-capital excess is `D - C`, BOUNDED by the owner's actual negative
// `-B` so we never claim more tenant money than is genuinely missing. We only
// assess overdraw when the owner ESTABLISHED an in-period contribution basis
// (`C > 0`): absent any in-period contribution, the sub-ledger negative is
// treated as legitimate OPENING owner capital being deployed (the EPIC-41
// boundary) and is NOT second-guessed from a name. `toleranceCents` is honored
// (an excess at or below tolerance is not flagged). This can only ADD a finding,
// never remove one, so it is STRICTLY non-looser. PURE + order-independent.
function classifyOwnerDraws(book, subBalances, exceptions, toleranceCents) {
  const tol = Number.isInteger(toleranceCents) && toleranceCents >= 0 ? toleranceCents : 0;

  // Per-owner-account accumulation of draws (D) and contributed capital (C),
  // keyed by the case-folded party so a deposit and a draw that name the same
  // owner account aggregate together. Order-independent.
  const draws = new Map(); // ownerKey -> total |draw amount|
  const capital = new Map(); // ownerKey -> total positive book inflow
  const drawRecords = new Map(); // ownerKey -> the owner-draw record sorted first (for naming)

  const sortedBook = [...book].sort((x, y) => cmp(recKey(x), recKey(y)));

  for (const r of sortedBook) {
    if (isOwnerDraw(r)) {
      const key = partyKey(r.party);
      draws.set(key, (draws.get(key) || 0) + Math.abs(r.amount));
      if (!drawRecords.has(key)) drawRecords.set(key, r);
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
    } else if (Number.isInteger(r.amount) && r.amount > 0) {
      // A positive book inflow attributed to a party is that party's contributed
      // capital basis (only consulted for parties that also have owner draws).
      const key = partyKey(r.party);
      if (key !== "") capital.set(key, (capital.get(key) || 0) + r.amount);
    }
  }

  // The owner's sub-ledger balance per case-folded key (an owner account may be
  // spelled with different casing in the sub-ledger than in a book line; fold).
  const ownerBalance = new Map();
  for (const [party, bal] of Object.entries(subBalances)) {
    if (!Number.isInteger(bal)) continue;
    const key = partyKey(party);
    ownerBalance.set(key, (ownerBalance.get(key) || 0) + bal);
  }

  // OWNER_OVERDRAW: per owner account, in a stable key-sorted order.
  for (const key of [...draws.keys()].sort(cmp)) {
    const D = draws.get(key) || 0;
    const C = capital.get(key) || 0;
    if (C <= 0) continue; // no in-period basis: EPIC-41 boundary, not second-guessed
    const overCapital = D - C;
    if (overCapital <= 0) continue; // drew at or below contributed capital — fine
    // Bound by how negative the owner actually went, so we never claim more
    // tenant money than is genuinely missing (e.g. opening owner capital covered
    // part of it). When no owner bucket exists, the full over-capital amount is
    // the unbacked excess.
    const B = ownerBalance.has(key) ? ownerBalance.get(key) : -overCapital;
    const shortfall = B < 0 ? -B : 0;
    const excess = Math.min(overCapital, shortfall);
    if (excess <= tol) continue; // within tolerance (or fully backed by capital)

    const r = drawRecords.get(key);
    const who = beneficiaryLabel(r ? r.party : "");
    pushException(exceptions, {
      type: EXCEPTION.OWNER_OVERDRAW,
      amount: excess, // the EXCESS (tenant money consumed), a positive cents figure
      label: "Owner draw exceeds contributed capital",
      detail:
        `Owner account ${who} drew ${fmtCentsForDetail(D)} against only ` +
        `${fmtCentsForDetail(C)} of its OWN contributed capital, so ` +
        `${fmtCentsForDetail(excess)} of the draw was paid out of other ` +
        "beneficiaries' trust money. An owner may be disbursed only from their " +
        "own funds; paying an owner out of tenant or security-deposit money is a " +
        "conversion of trust funds and leaves the account out of trust. Restore " +
        `${fmtCentsForDetail(excess)} to the trust account before relying on this packet.`,
      records: r ? [r] : [],
    });
  }
}

// A segregation movement is an OUTFLOW whose memo/kind references segregation /
// transfer of the deposit. PURE: free-text classification only.
function isSegregationMove(r) {
  const t = `${r.memo || ""} ${r.kind || ""}`.toLowerCase();
  return (
    r.amount < 0 &&
    (/segregat|transfer to (security|escrow|trust)|to security deposit account|escrow/.test(t) ||
      (isSecurityDeposit(r) && /transfer|segregat|escrow/.test(t)))
  );
}

// Tokenize a string into lowercase WHOLE word tokens (alphanumeric runs). The
// boundary is /[^a-z0-9]+/ so punctuation, spaces, and unit markers separate
// tokens. Used to make beneficiary-name matching WORD-BOUNDED instead of a raw
// substring test. PURE.
function nameTokens(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== "");
}

// Build a name-matching index over the beneficiary keys ONCE per reconcile pass.
// The index lets a transfer's memo be matched against beneficiary names in time
// proportional to the MEMO length (not the number of beneficiaries D), closing
// the O(D × T) algorithmic-complexity blowup the per-transfer O(D) scan caused on
// the untrusted-upload endpoint. Structure: a Map from each key's FIRST token to
// the list of { key, tokens } whose name begins with that token. A memo can then
// be probed by walking its tokens once and, at each position, checking only the
// keys that share that starting token. PURE.
function buildDepositNameIndex(depositKeys) {
  const byFirstToken = new Map();
  for (const key of depositKeys) {
    if (key === "") continue;
    const tokens = nameTokens(key);
    if (tokens.length === 0) continue; // a key with no word characters cannot be named in a memo
    const first = tokens[0];
    let bucket = byFirstToken.get(first);
    if (!bucket) {
      bucket = [];
      byFirstToken.set(first, bucket);
    }
    bucket.push({ key, tokens });
  }
  return byFirstToken;
}

// Does `memoTokens` contain `keyTokens` as a CONTIGUOUS run starting at index i?
function tokensMatchAt(memoTokens, i, keyTokens) {
  if (i + keyTokens.length > memoTokens.length) return false;
  for (let j = 0; j < keyTokens.length; j++) {
    if (memoTokens[i + j] !== keyTokens[j]) return false;
  }
  return true;
}

// Attribute a segregation transfer to the BENEFICIARY whose deposit it covers.
// Trust law segregates EACH tenant's deposit SEPARATELY, so a transfer's coverage
// must be pinned to one beneficiary — it can NEVER spill its excess onto another
// tenant's un-segregated deposit. Two signals, in priority order:
//   1. The transfer's own `party` field, if it names a beneficiary that actually
//      holds a security deposit (the structured, authoritative signal).
//   2. Failing that, a beneficiary NAME appearing in the transfer's memo (so a
//      "Transfer Jones security deposit to escrow" line still attributes even
//      with no party column).
// A transfer that matches NEITHER is GENERIC (returns "") — it provides only a
// residual pool that the existing same-amount mirror tests rely on, and is the
// fail-loud sentinel for an unattributable transfer (it can clear at most a
// still-uncovered deposit, never silently absorb one tenant's shortage into
// another's surplus).
//
// The memo fallback is WORD-BOUNDED: a key matches only as a contiguous run of
// WHOLE memo tokens, never as an incidental substring. A raw `memo.includes(key)`
// mis-pins ordinary surnames to standard segregation vocabulary — "escrow"
// contains "crow", "transfer" contains "tran" — silently stranding generic
// coverage on, or falsely clearing, an unrelated real tenant. Whole-token
// matching makes "Transfer to escrow" attribute to NOBODY (no token equals a
// beneficiary key), leaving it correctly in the generic residual pool.
//
// `index` is the prebuilt Map from buildDepositNameIndex (first token -> keys),
// so attribution is O(memo tokens), not O(beneficiaries). Among all matching
// keys the LONGEST (most tokens, then longest string) wins, deterministically, so
// "jones (4b)" beats a bare "jones". PURE + deterministic.
function attributeSegregation(transfer, depositKeys, index) {
  const own = partyKey(transfer.party);
  if (own !== "" && depositKeys.has(own)) return own;
  const memoTokens = nameTokens(transfer.memo);
  if (memoTokens.length === 0) return "";
  let best = "";
  let bestTokenLen = 0;
  for (let i = 0; i < memoTokens.length; i++) {
    const bucket = index.get(memoTokens[i]);
    if (!bucket) continue;
    for (const { key, tokens } of bucket) {
      if (!tokensMatchAt(memoTokens, i, tokens)) continue;
      // Longest match wins: more tokens first, then longer key string, so the
      // tie-break is total and order-independent across the bucket.
      if (
        tokens.length > bestTokenLen ||
        (tokens.length === bestTokenLen && key.length > best.length)
      ) {
        best = key;
        bestTokenLen = tokens.length;
      }
    }
  }
  return best;
}

// Security-deposit segregation: every security-deposit RECEIPT recorded in the
// book must have a corresponding movement OUT to a segregated account (or be
// flagged as held separately). If a security-deposit inflow is sitting in the
// operating/pooled book with no offsetting segregation transfer, that is a
// compliance finding in many states.
//
// PER-BENEFICIARY MATCHING (T-40.1). Trust law requires EACH tenant's deposit be
// held SEPARATELY, so coverage is matched PER BENEFICIARY — never from a single
// pooled total. Concretely: a segregation transfer attributed to tenant X covers
// ONLY X's deposits; its excess does NOT spill onto another tenant Y's
// un-segregated deposit (the false-negative the pooled FIFO produced). This can
// only ADD or RE-ATTRIBUTE a finding versus the old pooled sum — never remove a
// real one — so it is STRICTLY non-looser.
function classifySecurityDeposits(book, bank, exceptions) {
  // Find security-deposit inflows in the book, grouped by beneficiary key.
  const secDeposits = [...book]
    .filter((r) => isSecurityDeposit(r) && r.amount > 0)
    .sort((x, y) => cmp(recKey(x), recKey(y)));
  if (secDeposits.length === 0) return;

  // The set of beneficiary keys that actually hold a security deposit — the only
  // keys a transfer may attribute to. The name index is built ONCE here so the
  // per-transfer memo fallback is O(memo length), not O(beneficiaries).
  const depositKeys = new Set(secDeposits.map((r) => partyKey(r.party)));
  const depositNameIndex = buildDepositNameIndex(depositKeys);

  // CRITICAL: count each segregation transfer from ONE authoritative source —
  // the BOOK — never from both book and bank. A single real segregation transfer
  // is recorded twice (once in QuickBooks, once on the bank statement) because it
  // is the same money movement seen from two sources. Summing across both sources
  // double-counts one $X transfer as $2X of coverage, which can SILENTLY CLEAR a
  // genuinely un-segregated security deposit — a false negative on the flagship
  // finding this product exists to catch. The bank-side copy is the mirror of the
  // same movement (match.js pairs them); it adds no NEW segregation, so it must
  // NOT add coverage. `bank` is therefore intentionally unused for the sum.
  void bank;

  // Bucket each book segregation move's coverage by the beneficiary it is
  // attributed to. A GENERIC (unattributable) transfer (key "") goes into a
  // residual pool applied ONLY to deposits no attributed transfer covered — it
  // can clear at most a still-uncovered deposit, never silently net one tenant's
  // shortage against another tenant's surplus.
  const coveredByParty = new Map(); // key -> cents available
  let genericPool = 0;
  for (const r of [...book]
    .filter(isSegregationMove)
    .sort((x, y) => cmp(recKey(x), recKey(y)))) {
    const key = attributeSegregation(r, depositKeys, depositNameIndex);
    const cents = Math.abs(r.amount);
    if (key === "") {
      genericPool += cents;
    } else {
      coveredByParty.set(key, (coveredByParty.get(key) || 0) + cents);
    }
  }

  // Apply each beneficiary's OWN coverage to that beneficiary's deposits first;
  // any deposit still short then draws from the GENERIC residual pool (preserving
  // the long-standing behavior for transfers that name no tenant). A deposit that
  // remains short after both is flagged — attributed to the RIGHT beneficiary.
  const stillShort = [];
  for (const r of secDeposits) {
    const key = partyKey(r.party);
    let need = r.amount;
    const own = coveredByParty.get(key) || 0;
    const fromOwn = Math.min(own, need);
    coveredByParty.set(key, own - fromOwn);
    need -= fromOwn;
    if (need > 0) stillShort.push({ rec: r, need });
  }
  // Generic pool covers whatever remains, in the same deterministic order.
  for (const { rec: r, need } of stillShort) {
    if (genericPool >= need) {
      genericPool -= need;
      continue;
    }
    // The genuinely-UNCOVERED amount is what the generic residual pool could not
    // cover (`need` minus whatever this draw consumed) — never the full deposit
    // when the pool partially covered it. This is the number at risk in trust.
    const uncovered = need - genericPool;
    genericPool = 0; // a partial generic draw is consumed; the rest is a finding
    // NAME the at-risk beneficiary so the finding (and the report row) says WHO is
    // exposed, not just that "a" deposit is un-segregated. A deposit with no party
    // attributed falls back to an explicit "(unattributed beneficiary)" sentinel
    // rather than an empty string, so the sentence never reads as a dangling name.
    const who = beneficiaryLabel(r.party);
    pushException(exceptions, {
      type: EXCEPTION.SECURITY_DEPOSIT_SEGREGATION,
      amount: r.amount,
      label: "Security deposit not segregated",
      detail:
        `Security deposit for ${who} is not segregated: ${fmtCentsForDetail(uncovered)} ` +
        "of this receipt has no matching transfer to a segregated deposit account. " +
        "Many states require each beneficiary's security deposit be held separately " +
        "from operating trust funds; transfer the uncovered amount to a segregated " +
        `account attributed to ${who}.`,
      records: [r],
    });
  }
}

// A human-readable beneficiary label for a finding sentence. Uses the record's
// raw party string verbatim when present (so "Jones (4B)" reads naturally), and a
// loud, explicit sentinel when the deposit names no beneficiary — never an empty
// string that would leave the sentence dangling. PURE.
function beneficiaryLabel(party) {
  const p = String(party == null ? "" : party).trim();
  return p === "" ? "an unattributed beneficiary" : p;
}

// Format integer cents as a signed dollar string ("$1,234.56") for embedding in a
// finding's detail sentence. reconcile.js is the pure core and intentionally does
// NOT depend on report.js, so this mirrors report.fmtCents's grouping locally with
// no new dependency. Deterministic; throws on non-integer input (no float money).
function fmtCentsForDetail(cents) {
  if (!Number.isInteger(cents)) {
    throw new ReconcileError("fmtCentsForDetail requires integer cents");
  }
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = `$${grouped}.${String(rem).padStart(2, "0")}`;
  return neg ? `-${body}` : body;
}

// The CLOSED set of control / sink account designations whose negative balance
// is STRUCTURAL, not a tenant shortage. The pooled trust account holds
// beneficiaries' money, but the per-party sub-ledger map also carries a few
// non-beneficiary control accounts whose balance is legitimately negative:
//   * the OWNER's-own-funds line — an owner funds the account and DRAWS against
//     their OWN money, so a negative owner position is expected (it is the
//     owner's capital being deployed, not a tenant's trust money vanishing); and
//   * an ESCROW / SEGREGATED / TRUST sink, or an OPERATING / RESERVE / SUSPENSE
//     control line, which RECEIVES the offsetting outflow (the money that left
//     the pooled side to be held separately), so it nets negative by design.
const CONTROL_ACCOUNT_TOKENS = Object.freeze([
  "owner",
  "owners",
  "escrow",
  "segregated",
  "trust",
  "operating",
  "reserve",
  "suspense",
]);

// Does a free-text party name READ as a control-account DESIGNATION? A negative
// balance on a control/sink account is structural; a negative balance on any
// OTHER party is a real beneficiary whose trust money is gone, so this is the
// ONLY thing that suppresses a negative_tenant_ledger finding when the caller
// gave us no structured marker.
//
// NARROWLY ANCHORED to the LEADING token (the account-designation position):
// only when the FIRST whole-word token of the name is a control word
// ("Owner ...", "Escrow ...", "Reserve ...") do we treat the line as a control
// account. The previous rule matched a control token ANYWHERE in the name, which
// silently OVER-EXCLUDED real beneficiaries whose name merely contains a control
// word — "Smith (OWNER)", "Jones Family Trust", "Tenant 12 Reserve St" — and so
// swallowed exactly the shortage T-41.1 exists to surface. The leading-token
// anchor keeps the genuine designations ("Owner Acme", "Escrow") excluded while
// no longer dropping a beneficiary whose unit/address/entity name happens to
// carry a control token in a NON-leading position.
//
// LIMITATION (documented in docs/TRUSTLEDGER.md): a name heuristic cannot tell a
// real company named "Operating Co LLC" from an "Operating" control account, so a
// leading control word is still treated as a designation. A real beneficiary
// whose name LEADS with a control word — and any control account the broker wants
// recognized unambiguously — must carry the STRUCTURED `controlAccount` marker,
// which is authoritative over this guess (see controlAccountKeys / the
// per-row/per-balance marker). Still WORD-BOUNDED so an ordinary surname that
// merely CONTAINS one of these tokens ("Owens", "Crowell") is never mistaken for
// a control account. PURE.
function isControlAccountParty(party) {
  const tokens = nameTokens(party);
  if (tokens.length === 0) return false;
  return CONTROL_ACCOUNT_TOKENS.includes(tokens[0]);
}

// Mirror the EXACT per-party normalization tenantBalances uses for the array
// (rent-roll) form, so a control-account marker keys to the SAME sub-ledger
// bucket the balance lives under. PURE.
function normTenantParty(party) {
  return String(party == null ? "unknown" : party).trim() || "unknown";
}

// The set of sub-ledger party keys the CALLER has STRUCTURALLY asserted are
// control / sink accounts (not beneficiaries), via an explicit `controlAccount:
// true` marker. This is a deliberate, structured assertion by the producer of
// the data — distinct from us GUESSING from the free-text name — and is therefore
// AUTHORITATIVE: a marked party is excluded from the negative-ledger finding no
// matter what its name reads like, and (because the marker only ever ADDS to the
// exclusion set, never removes the name heuristic) it can only make the check
// MORE permissive about structural negatives, never flag fewer real shortages
// than the name heuristic alone would. Mirrors how hasExplicitDepositLabel
// prefers a structured assertion over a free-text guess.
//
// The marker is honored on the ARRAY (rent-roll) form, where each row may carry
// `controlAccount: true`; ANY such row marks its party's bucket. The precomputed
// `{ party: cents }` map form has no per-key slot for a marker, so a bare map
// falls back to the name heuristic alone (a caller who needs to mark a control
// account in the map form should supply rows or rely on the leading-token name).
// Returns a Set of normalized party keys. PURE + order-independent.
function controlAccountKeys(tenants) {
  const keys = new Set();
  if (!Array.isArray(tenants)) return keys;
  for (const r of tenants) {
    if (r && r.controlAccount === true) {
      keys.add(normTenantParty(r.party));
    }
  }
  return keys;
}

// Per-beneficiary negative-ledger check (T-41.1). Flag EACH individual
// beneficiary whose own sub-ledger balance is negative beyond tolerance — i.e.
// the broker is holding LESS than zero in trust for that person, because their
// money was spent or used to cover another beneficiary's shortfall. This is
// ORTHOGONAL to the pooled SUBLEDGER_OUT_OF_BALANCE check: the SUM of all
// sub-ledgers can tie perfectly to the book (one tenant's surplus masking
// another's deficit) while an individual ledger is negative, so this check fires
// independently of the SUM. A control/sink account is NOT a beneficiary and is
// excluded — its negative balance is structural, not a shortage. A control
// account is recognized by EITHER an authoritative STRUCTURED `controlAccount`
// marker (`controlKeys`, preferred) OR, absent a marker, a NARROWLY-ANCHORED
// leading-token name heuristic (owner/escrow/segregated/trust/operating/reserve/
// suspense in the FIRST name token) — see isControlAccountParty for why the
// heuristic is anchored to the leading token and its documented limitation.
// `toleranceCents` is honored: a balance is flagged only when it is below
// `-toleranceCents`, so a caller's deliberate penny-tolerance applies the SAME
// way it does to the SUM checks. Deterministic + order-independent: beneficiaries
// are flagged in a stable key-sorted order. This can only ADD findings, never
// remove one (strictly non-looser). PURE.
function classifyNegativeTenantLedgers(subBalances, toleranceCents, exceptions, controlKeys) {
  const tol = Number.isInteger(toleranceCents) && toleranceCents >= 0 ? toleranceCents : 0;
  const control = controlKeys instanceof Set ? controlKeys : new Set();
  const parties = Object.keys(subBalances).sort(cmp);
  for (const party of parties) {
    const bal = subBalances[party];
    if (!Number.isInteger(bal)) continue; // tenantBalances already validated; guard anyway
    if (bal >= -tol) continue; // zero/positive (or within tolerance) is fine
    // A structured marker is authoritative; absent one, fall back to the
    // narrowly-anchored leading-token name heuristic.
    if (control.has(party) || isControlAccountParty(party)) continue; // structural negative, not a shortage
    const who = beneficiaryLabel(party);
    pushException(exceptions, {
      type: EXCEPTION.NEGATIVE_TENANT_LEDGER,
      amount: bal, // the negative balance itself (signed), so the row says how short
      label: "Beneficiary ledger is negative",
      detail:
        `The individual trust ledger for ${who} is negative (${fmtCentsForDetail(bal)}): ` +
        "the broker is holding less than zero in trust for this beneficiary, so " +
        "their money has been spent or used to cover another beneficiary's " +
        "shortfall. A negative individual ledger is out of trust even when the " +
        "pooled sum of all sub-ledgers still ties to the book; restore the " +
        "beneficiary's balance to at least zero before relying on this packet.",
      records: [],
    });
  }
}

// Ambiguous deposits: every book INFLOW that calls itself a deposit but whose
// beneficiary type we cannot determine (no recognized purpose keyword, not an
// explicitly-labeled rent/receipt) becomes a LOUD, gradable WARNING finding
// rather than passing silently as a generic deposit. A record that already
// surfaced as a SECURITY_DEPOSIT_SEGREGATION finding is NOT re-flagged here:
// isAmbiguousDeposit already excludes anything isSecurityDeposit recognizes, so
// there is no double-count of the same row across the two findings. PURE +
// deterministic: order-independent (sorted by record key) free-text classification.
function classifyAmbiguousDeposits(book, exceptions) {
  for (const r of [...book]
    .filter(isAmbiguousDeposit)
    .sort((x, y) => cmp(recKey(x), recKey(y)))) {
    pushException(exceptions, {
      type: EXCEPTION.AMBIGUOUS_DEPOSIT,
      amount: r.amount,
      label: "Ambiguous deposit (beneficiary type undetermined)",
      detail:
        "A book deposit with no recognizable beneficiary-type keyword (it is " +
        "not clearly rent, an owner contribution, or a labeled security " +
        "deposit). Confirm what it is: an un-segregated security deposit hiding " +
        "as a generic deposit is an out-of-trust finding. Label the row " +
        "(e.g. kind \"rent\", a security-deposit memo, or an explicit deposit " +
        "type) so this resolves.",
      records: [r],
    });
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
  buildContinuityException,
  isAmbiguousDeposit,
};

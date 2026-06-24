"use strict";

// TrustLedger — ingest.js
//
// T-22.1: parse + NORMALIZE the three monthly inputs a small property-management
// trust-account reconciliation needs into ONE transaction model:
//
//   (a) a BANK STATEMENT          — CSV or OFX/QFX
//   (b) a QUICKBOOKS trust ledger — CSV export
//   (c) a RENT-ROLL / tenant      — CSV sub-ledger
//
// Every parser is a PURE function: (text, [opts]) -> NormalizedRecord[].
// No I/O, no clock, no globals — the same input always yields the same output,
// which is what makes the downstream matcher/reconciler deterministic and
// audit-defensible.
//
// Normalized record shape (every field always present):
//   {
//     date:   "YYYY-MM-DD",        // ISO calendar date
//     amount: <integer cents>,     // SIGNED: + = money INTO the trust account,
//                                  //         - = money OUT. Never a float.
//     memo:   <string>,            // free-text description (trimmed)
//     kind:   <Kind>,              // coarse transaction class (see KIND)
//     party:  <string>,            // tenant / payee / counterparty ("" if unknown)
//     source: <Source>,            // which input this row came from
//   }
//
// Amounts are INTEGER CENTS throughout. Dollar strings are parsed by exact
// digit manipulation (never `parseFloat`), so "1234.99" -> 123499 with zero
// binary-float drift, and a value like "10.005" is REJECTED, not rounded.
//
// "Strict" is the whole point: a malformed row raises an IngestError naming the
// row number and the problem, rather than being silently dropped. A trust
// reconciliation that quietly skips a row is worse than useless — it hides the
// exact discrepancy a broker is legally on the hook to find.

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

const SOURCE = Object.freeze({
  BANK: "bank",
  QUICKBOOKS: "quickbooks",
  RENT_ROLL: "rent_roll",
});

const KIND = Object.freeze({
  DEPOSIT: "deposit", // money in (rent received, owner contribution)
  CHECK: "check", // money out by check (owner draw, vendor, refund)
  TRANSFER: "transfer", // money moved between accounts
  FEE: "fee", // bank/service fee out
  NSF: "nsf", // returned/bounced item reversal
  ADJUSTMENT: "adjustment", // manual correction
  OTHER: "other", // classified but uncategorized
});

const VALID_KINDS = new Set(Object.values(KIND));

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class IngestError extends Error {
  // `row` is a 1-based line number within the data (1 = first data row, header
  // excluded) when known, else null. `source` is the SOURCE being parsed.
  constructor(message, { row = null, source = null } = {}) {
    const where =
      row != null ? ` (row ${row}${source ? `, ${source}` : ""})` : "";
    super(`${message}${where}`);
    this.name = "IngestError";
    this.row = row;
    this.source = source;
  }
}

// ---------------------------------------------------------------------------
// Amount parsing — exact integer cents, no float
// ---------------------------------------------------------------------------

// Parse a human dollar string into SIGNED integer cents, exactly.
//
// Accepts:
//   "1,234.56" "1234.56" "1234" ".5" "0.05" "$1,234.56"
//   leading "-" or "+", and accounting-style parentheses "(1,234.56)" => negative.
// Rejects (throws):
//   empty, non-numeric, > 2 decimal places, multiple signs, malformed grouping.
//
// `field` and `loc` ({row, source}) only flavor the error message.
function parseCents(raw, field = "amount", loc = {}) {
  if (raw == null) {
    throw new IngestError(`missing ${field}`, loc);
  }
  let s = String(raw).trim();
  if (s === "") {
    throw new IngestError(`empty ${field}`, loc);
  }

  // Accounting negatives: (1,234.56) == -1234.56
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  // Strip a single currency symbol if present.
  s = s.replace(/^\$/, "").trim();

  // Leading sign.
  const signMatch = s.match(/^([+-])/);
  if (signMatch) {
    if (signMatch[1] === "-") negative = !negative;
    s = s.slice(1).trim();
  }
  if (s === "") {
    throw new IngestError(`malformed ${field}: "${raw}"`, loc);
  }

  // No further signs allowed anywhere.
  if (/[+-]/.test(s)) {
    throw new IngestError(`malformed ${field}: "${raw}"`, loc);
  }

  // Remove thousands separators ONLY when they group digits correctly.
  // (We do not try to be clever about locale; commas are grouping, period is
  // the decimal point — the US convention these inputs use.)
  if (s.includes(",")) {
    const parts = s.split(",");
    // First group: 1..3 digits; every later group: exactly 3 digits.
    // The last group may carry the decimal portion.
    for (let i = 0; i < parts.length; i++) {
      const seg = i === parts.length - 1 ? parts[i].split(".")[0] : parts[i];
      const ok = i === 0 ? /^\d{1,3}$/.test(seg) : /^\d{3}$/.test(seg);
      if (!ok) {
        throw new IngestError(`malformed ${field}: "${raw}"`, loc);
      }
    }
    s = s.replace(/,/g, "");
  }

  // Now s must be digits with at most one dot and <=2 fractional digits.
  const m = s.match(/^(\d*)(?:\.(\d{0,2}))?$/);
  if (!m || (m[1] === "" && (m[2] === undefined || m[2] === ""))) {
    throw new IngestError(`malformed ${field}: "${raw}"`, loc);
  }
  const whole = m[1] === "" ? "0" : m[1];
  const frac = (m[2] || "").padEnd(2, "0");

  // Build cents via integer math — no Number on the dollar portion's magnitude
  // beyond safe-integer range checks.
  const dollars = Number(whole);
  const cents = Number(frac);
  if (!Number.isSafeInteger(dollars)) {
    throw new IngestError(`amount out of range: "${raw}"`, loc);
  }
  let total = dollars * 100 + cents;
  if (!Number.isSafeInteger(total)) {
    throw new IngestError(`amount out of range: "${raw}"`, loc);
  }
  if (negative) total = -total;
  return total;
}

// ---------------------------------------------------------------------------
// Date parsing — normalize to YYYY-MM-DD
// ---------------------------------------------------------------------------

// Accepts: YYYY-MM-DD, MM/DD/YYYY, M/D/YY, YYYYMMDD (OFX style).
// Returns a strict ISO date string, validating the calendar (no 02/30).
function parseDate(raw, loc = {}) {
  if (raw == null) throw new IngestError("missing date", loc);
  const s = String(raw).trim();
  if (s === "") throw new IngestError("empty date", loc);

  let y;
  let mo;
  let d;

  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    [, y, mo, d] = m;
  } else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/))) {
    mo = m[1];
    d = m[2];
    y = m[3].length === 2 ? `20${m[3]}` : m[3];
  } else if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) {
    // OFX/QFX YYYYMMDD (optionally followed by HHMMSS we ignore upstream).
    [, y, mo, d] = m;
  } else {
    throw new IngestError(`unrecognized date: "${raw}"`, loc);
  }

  const yi = Number(y);
  const mi = Number(mo);
  const di = Number(d);
  if (mi < 1 || mi > 12) throw new IngestError(`invalid month in date: "${raw}"`, loc);
  const daysInMonth = [
    31,
    // leap-year aware February
    (yi % 4 === 0 && yi % 100 !== 0) || yi % 400 === 0 ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
  ];
  if (di < 1 || di > daysInMonth[mi - 1]) {
    throw new IngestError(`invalid day in date: "${raw}"`, loc);
  }
  const pad = (n) => String(n).padStart(2, "0");
  return `${yi}-${pad(mi)}-${pad(di)}`;
}

// ---------------------------------------------------------------------------
// CSV parsing — RFC-4180-ish: quotes, embedded commas/newlines, "" escape
// ---------------------------------------------------------------------------

// Parse CSV text into an array of rows (each a string[]). Handles quoted fields
// containing commas, newlines, and doubled quotes. Blank lines are dropped.
function parseCSV(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  let sawAny = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    // Drop fully-blank lines (single empty field, nothing else).
    const blank = row.length === 1 && row[0].trim() === "";
    if (!blank) rows.push(row);
    row = [];
  };

  // Normalize CRLF/CR to LF for a single state machine.
  const s = text.replace(/\r\n?/g, "\n");

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    sawAny = true;
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushRow();
    } else {
      field += c;
    }
  }
  // Flush trailing field/row if the text didn't end with a newline.
  if (field !== "" || row.length > 0 || (sawAny && rows.length === 0)) {
    pushRow();
  }
  return rows;
}

// Map header names to column indexes. Case-insensitive, trims, and accepts a
// list of aliases per logical column. Returns { name -> index }.
function indexHeader(header, schema, source) {
  const norm = header.map((h) => String(h).trim().toLowerCase());
  const out = {};
  for (const [key, aliases] of Object.entries(schema)) {
    let idx = -1;
    for (const a of aliases) {
      idx = norm.indexOf(a.toLowerCase());
      if (idx !== -1) break;
    }
    out[key] = idx;
  }
  return out;
}

function requireCols(cols, names, source) {
  for (const n of names) {
    if (cols[n] === -1 || cols[n] === undefined) {
      throw new IngestError(
        `missing required column "${n}" in header`,
        { source }
      );
    }
  }
}

// Pull a cell, tolerating short rows by treating absent as undefined.
function cell(arr, idx) {
  if (idx === -1 || idx === undefined) return undefined;
  return arr[idx];
}

// ---------------------------------------------------------------------------
// Kind classification helpers
// ---------------------------------------------------------------------------

// Infer a coarse kind from a free-text memo/type when the source doesn't give
// an explicit one. Deterministic keyword match; falls back to sign-based guess.
function classifyKind(text, amountCents) {
  const t = String(text || "").toLowerCase();
  if (/\bnsf\b|returned|bounced|insufficient|reversal|reverse/.test(t)) {
    return KIND.NSF;
  }
  if (/\bfee\b|service charge|svc chg|charge\b/.test(t)) return KIND.FEE;
  if (/transfer|xfer|ach out|ach in/.test(t)) return KIND.TRANSFER;
  if (/\bcheck\b|chk #|chk#|ck#|draw|disbursement|payee/.test(t)) {
    return KIND.CHECK;
  }
  if (/deposit|rent|payment received|received from/.test(t)) {
    return KIND.DEPOSIT;
  }
  if (/adjust|correction|void/.test(t)) return KIND.ADJUSTMENT;
  // Sign-based fallback: positive => deposit, negative => check.
  if (amountCents > 0) return KIND.DEPOSIT;
  if (amountCents < 0) return KIND.CHECK;
  return KIND.OTHER;
}

// Normalize / validate an explicitly-supplied kind string.
function coerceKind(raw, fallbackText, amountCents, loc) {
  // An NSF / returned-item is the single most important exception a trust
  // reconciliation must surface, and accounting exports routinely file the
  // reversal under a generic "Deposit"/"Check" type with "NSF" only in the
  // memo. So a returned-item keyword ALWAYS wins over the explicit type — we
  // would rather over-flag than silently fold a reversal into a clean deposit.
  if (/\bnsf\b|returned|bounced|insufficient|reversal/i.test(fallbackText)) {
    return KIND.NSF;
  }
  if (raw == null || String(raw).trim() === "") {
    return classifyKind(fallbackText, amountCents);
  }
  const k = String(raw).trim().toLowerCase();
  if (VALID_KINDS.has(k)) return k;
  // Common aliases.
  const aliases = {
    dep: KIND.DEPOSIT,
    chk: KIND.CHECK,
    cheque: KIND.CHECK,
    payment: KIND.DEPOSIT,
    "service charge": KIND.FEE,
    xfer: KIND.TRANSFER,
    returned: KIND.NSF,
    bounce: KIND.NSF,
    adj: KIND.ADJUSTMENT,
  };
  if (aliases[k]) return aliases[k];
  // Unknown kind word is not fatal — classify from text/sign but keep going.
  return classifyKind(`${raw} ${fallbackText}`, amountCents);
}

function makeRecord({ date, amount, memo, kind, party, source }) {
  return {
    date,
    amount,
    memo: String(memo == null ? "" : memo).trim(),
    kind,
    party: String(party == null ? "" : party).trim(),
    source,
  };
}

// ---------------------------------------------------------------------------
// (a) BANK STATEMENT — CSV or OFX/QFX
// ---------------------------------------------------------------------------

// Bank CSVs vary wildly; we support BOTH common shapes:
//   * a single signed Amount column, OR
//   * separate Debit / Credit columns (debit => money out => negative).
const BANK_SCHEMA = {
  date: ["date", "posted", "posting date", "transaction date", "trans date"],
  amount: ["amount", "amt"],
  debit: ["debit", "withdrawal", "withdrawals", "money out"],
  credit: ["credit", "deposit", "deposits", "money in"],
  memo: ["description", "memo", "details", "name", "payee"],
  type: ["type", "transaction type"],
};

function parseBankCSV(text) {
  const rows = parseCSV(text);
  if (rows.length === 0) {
    throw new IngestError("empty bank statement", { source: SOURCE.BANK });
  }
  const cols = indexHeader(rows[0], BANK_SCHEMA, SOURCE.BANK);
  requireCols(cols, ["date"], SOURCE.BANK);
  const hasSigned = cols.amount !== -1;
  const hasSplit = cols.debit !== -1 || cols.credit !== -1;
  if (!hasSigned && !hasSplit) {
    throw new IngestError(
      'bank statement needs an "amount" column or debit/credit columns',
      { source: SOURCE.BANK }
    );
  }

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const arr = rows[r];
    const loc = { row: r, source: SOURCE.BANK };
    const date = parseDate(cell(arr, cols.date), loc);

    let amount;
    if (hasSigned) {
      amount = parseCents(cell(arr, cols.amount), "amount", loc);
    } else {
      const dRaw = cell(arr, cols.debit);
      const cRaw = cell(arr, cols.credit);
      const dHas = dRaw != null && String(dRaw).trim() !== "";
      const cHas = cRaw != null && String(cRaw).trim() !== "";
      if (dHas && cHas) {
        throw new IngestError(
          "row has BOTH a debit and a credit value",
          loc
        );
      }
      if (!dHas && !cHas) {
        throw new IngestError("row has neither debit nor credit value", loc);
      }
      if (dHas) {
        const v = parseCents(dRaw, "debit", loc);
        amount = -Math.abs(v);
      } else {
        const v = parseCents(cRaw, "credit", loc);
        amount = Math.abs(v);
      }
    }

    const memo = cell(arr, cols.memo) || "";
    const typeText = cell(arr, cols.type) || "";
    const kind = coerceKind(typeText, `${typeText} ${memo}`, amount, loc);
    out.push(
      makeRecord({ date, amount, memo, kind, party: "", source: SOURCE.BANK })
    );
  }
  return out;
}

// Minimal OFX/QFX SGML reader: pull each <STMTTRN> block's fields. We only need
// TRNTYPE, DTPOSTED, TRNAMT, NAME/MEMO. OFX tags are often unclosed (SGML), so
// we read each tag's value as "everything up to the next '<'".
function parseOFX(text) {
  const out = [];
  const blocks = text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || [];
  if (blocks.length === 0) {
    // Could be a non-OFX file misrouted here.
    if (!/<OFX>|<STMTTRN>/i.test(text)) {
      throw new IngestError("not an OFX/QFX document", { source: SOURCE.BANK });
    }
  }
  const tagVal = (block, tag) => {
    const m = block.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, "i"));
    return m ? m[1].trim() : undefined;
  };
  blocks.forEach((block, i) => {
    const loc = { row: i + 1, source: SOURCE.BANK };
    const dtRaw = tagVal(block, "DTPOSTED");
    if (dtRaw == null) throw new IngestError("OFX txn missing DTPOSTED", loc);
    // DTPOSTED may include time/zone: take the leading YYYYMMDD.
    const date = parseDate(dtRaw.slice(0, 8), loc);
    const amount = parseCents(tagVal(block, "TRNAMT"), "TRNAMT", loc);
    const memo = tagVal(block, "MEMO") || tagVal(block, "NAME") || "";
    const trntype = tagVal(block, "TRNTYPE") || "";
    const kind = coerceKind(trntype, `${trntype} ${memo}`, amount, loc);
    out.push(
      makeRecord({ date, amount, memo, kind, party: "", source: SOURCE.BANK })
    );
  });
  return out;
}

// Auto-detect OFX vs CSV from the content; `format` ("csv"|"ofx") forces it.
function parseBankStatement(text, { format } = {}) {
  if (text == null) throw new IngestError("no bank input", { source: SOURCE.BANK });
  const fmt = format || (/<OFX>|<STMTTRN>|OFXHEADER/i.test(text) ? "ofx" : "csv");
  if (fmt === "ofx") return parseOFX(text);
  return parseBankCSV(text);
}

// ---------------------------------------------------------------------------
// (b) QUICKBOOKS trust-ledger CSV
// ---------------------------------------------------------------------------

// A QuickBooks account "transaction detail" export. QB typically emits separate
// Debit (money out of the bank/trust register) and Credit (money in) columns,
// plus Type, Name, Memo, Date. We treat Credit as +, Debit as -, matching the
// bank's signed convention so the two can be reconciled directly.
const QB_SCHEMA = {
  date: ["date", "trans date", "transaction date"],
  type: ["type", "transaction type"],
  party: ["name", "payee", "customer", "vendor", "received from", "paid to"],
  memo: ["memo", "description", "memo/description"],
  debit: ["debit", "payment", "decrease"],
  credit: ["credit", "deposit", "increase"],
  amount: ["amount", "amt"],
};

function parseQuickBooksCSV(text) {
  if (text == null) {
    throw new IngestError("no QuickBooks input", { source: SOURCE.QUICKBOOKS });
  }
  const rows = parseCSV(text);
  if (rows.length === 0) {
    throw new IngestError("empty QuickBooks export", {
      source: SOURCE.QUICKBOOKS,
    });
  }
  const cols = indexHeader(rows[0], QB_SCHEMA, SOURCE.QUICKBOOKS);
  requireCols(cols, ["date"], SOURCE.QUICKBOOKS);
  const hasSigned = cols.amount !== -1;
  const hasSplit = cols.debit !== -1 || cols.credit !== -1;
  if (!hasSigned && !hasSplit) {
    throw new IngestError(
      'QuickBooks export needs an "amount" column or debit/credit columns',
      { source: SOURCE.QUICKBOOKS }
    );
  }

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const arr = rows[r];
    const loc = { row: r, source: SOURCE.QUICKBOOKS };
    const date = parseDate(cell(arr, cols.date), loc);

    let amount;
    if (hasSigned) {
      amount = parseCents(cell(arr, cols.amount), "amount", loc);
    } else {
      const dRaw = cell(arr, cols.debit);
      const cRaw = cell(arr, cols.credit);
      const dHas = dRaw != null && String(dRaw).trim() !== "";
      const cHas = cRaw != null && String(cRaw).trim() !== "";
      if (dHas && cHas) {
        throw new IngestError("row has BOTH debit and credit values", loc);
      }
      if (!dHas && !cHas) {
        throw new IngestError("row has neither debit nor credit value", loc);
      }
      amount = dHas
        ? -Math.abs(parseCents(dRaw, "debit", loc))
        : Math.abs(parseCents(cRaw, "credit", loc));
    }

    const memo = cell(arr, cols.memo) || "";
    const party = cell(arr, cols.party) || "";
    const typeText = cell(arr, cols.type) || "";
    const kind = coerceKind(typeText, `${typeText} ${memo}`, amount, loc);
    out.push(
      makeRecord({
        date,
        amount,
        memo,
        kind,
        party,
        source: SOURCE.QUICKBOOKS,
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// (c) RENT-ROLL / tenant sub-ledger CSV
// ---------------------------------------------------------------------------

// A per-tenant sub-ledger: each row is a charge or a payment against a tenant.
// Convention here: a tenant PAYMENT is money INTO the trust account (+), a
// CHARGE/assessment is what the tenant owes and is recorded as negative on the
// cash side only when it represents an outflow; for reconciliation against the
// bank we care about CASH events, so charges (non-cash) are tagged but kept
// with their signed cash effect (0 unless they move money).
//
// To stay simple and cash-focused we accept either:
//   * a signed Amount (positive = payment received), OR
//   * separate Payment / Charge columns (payment => +, charge => recorded but
//     non-cash, sign 0 unless it is a refund which is negative cash).
const RENT_SCHEMA = {
  date: ["date", "posted", "transaction date"],
  tenant: ["tenant", "name", "resident", "lessee", "party"],
  unit: ["unit", "apt", "apartment", "property", "door"],
  memo: ["memo", "description", "note", "charge type", "details"],
  amount: ["amount", "amt"],
  payment: ["payment", "paid", "received", "credit"],
  charge: ["charge", "owed", "assessment", "debit"],
  type: ["type", "transaction type"],
};

function parseRentRollCSV(text) {
  if (text == null) {
    throw new IngestError("no rent-roll input", { source: SOURCE.RENT_ROLL });
  }
  const rows = parseCSV(text);
  if (rows.length === 0) {
    throw new IngestError("empty rent roll", { source: SOURCE.RENT_ROLL });
  }
  const cols = indexHeader(rows[0], RENT_SCHEMA, SOURCE.RENT_ROLL);
  requireCols(cols, ["date", "tenant"], SOURCE.RENT_ROLL);
  const hasSigned = cols.amount !== -1;
  const hasSplit = cols.payment !== -1 || cols.charge !== -1;
  if (!hasSigned && !hasSplit) {
    throw new IngestError(
      'rent roll needs an "amount" column or payment/charge columns',
      { source: SOURCE.RENT_ROLL }
    );
  }

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const arr = rows[r];
    const loc = { row: r, source: SOURCE.RENT_ROLL };
    const date = parseDate(cell(arr, cols.date), loc);
    const tenant = cell(arr, cols.tenant);
    if (tenant == null || String(tenant).trim() === "") {
      throw new IngestError("rent-roll row missing tenant", loc);
    }
    const unit = cell(arr, cols.unit);

    let amount;
    let kindHint;
    if (hasSigned) {
      amount = parseCents(cell(arr, cols.amount), "amount", loc);
      kindHint = amount >= 0 ? KIND.DEPOSIT : KIND.CHECK;
    } else {
      const pRaw = cell(arr, cols.payment);
      const cRaw = cell(arr, cols.charge);
      const pHas = pRaw != null && String(pRaw).trim() !== "";
      const cHas = cRaw != null && String(cRaw).trim() !== "";
      if (pHas && cHas) {
        throw new IngestError(
          "rent-roll row has BOTH a payment and a charge",
          loc
        );
      }
      if (!pHas && !cHas) {
        throw new IngestError(
          "rent-roll row has neither payment nor charge",
          loc
        );
      }
      if (pHas) {
        amount = Math.abs(parseCents(pRaw, "payment", loc));
        kindHint = KIND.DEPOSIT;
      } else {
        // A charge is an accrual, not a cash movement: record it but with a
        // negative sign reflecting what the tenant owes the trust ledger.
        amount = -Math.abs(parseCents(cRaw, "charge", loc));
        kindHint = KIND.ADJUSTMENT;
      }
    }

    const memoRaw = cell(arr, cols.memo) || "";
    const typeText = cell(arr, cols.type) || "";
    // Let explicit type/keywords (e.g. "NSF") override the cash-based hint.
    let kind = coerceKind(typeText, `${typeText} ${memoRaw}`, amount, loc);
    if (
      (typeText == null || typeText.trim() === "") &&
      !/nsf|returned|fee|transfer|adjust|void/i.test(memoRaw)
    ) {
      kind = kindHint;
    }
    const party = unit
      ? `${String(tenant).trim()} (${String(unit).trim()})`
      : String(tenant).trim();
    out.push(
      makeRecord({
        date,
        amount,
        memo: memoRaw,
        kind,
        party,
        source: SOURCE.RENT_ROLL,
      })
    );
  }
  return out;
}

module.exports = {
  SOURCE,
  KIND,
  IngestError,
  // primitives (exported for focused tests / reuse)
  parseCents,
  parseDate,
  parseCSV,
  classifyKind,
  // the three normalizers
  parseBankStatement,
  parseBankCSV,
  parseOFX,
  parseQuickBooksCSV,
  parseRentRollCSV,
};

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

// Deterministic month-name -> 1..12 table. Covers the full names and the common
// 3-letter abbreviations QuickBooks/bank exports emit (e.g. "Jan", "Sept").
// Lower-cased keys; matched case-insensitively. NO locale/Date() dependency, so
// the same textual date always parses to the same ISO string.
const MONTH_NAMES = Object.freeze({
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
});

// Accepts: YYYY-MM-DD, MM/DD/YYYY, M/D/YY, YYYYMMDD (OFX style), and the common
// textual forms QuickBooks exports use — "Mon DD, YYYY" ("Jan 5, 2024") and
// "DD-Mon-YYYY" ("5-Jan-2024"). Returns a strict ISO date string, validating
// the calendar (no 02/30) with a deterministic month-name table (no Date()).
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
  } else if ((m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
    // "Mon DD, YYYY" — e.g. "Jan 5, 2024", "January 5 2024", "Sept. 5, 2024".
    const mon = MONTH_NAMES[m[1].toLowerCase()];
    if (mon == null) throw new IngestError(`unrecognized month in date: "${raw}"`, loc);
    mo = String(mon);
    d = m[2];
    y = m[3];
  } else if ((m = s.match(/^(\d{1,2})-([A-Za-z]+)\.?-(\d{2}|\d{4})$/))) {
    // "DD-Mon-YYYY" — e.g. "5-Jan-2024", "05-Jan-24".
    const mon = MONTH_NAMES[m[2].toLowerCase()];
    if (mon == null) throw new IngestError(`unrecognized month in date: "${raw}"`, loc);
    d = m[1];
    mo = String(mon);
    y = m[3].length === 2 ? `20${m[3]}` : m[3];
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
//
// `columnMap` (T-25.3) is an OPTIONAL pure `{ <logical>: <exactHeaderName> }`
// escape hatch: for any logical field it names, it OVERRIDES the alias auto-
// detect and binds that field to the EXACT (case-insensitive, trimmed) header
// the caller specified — for a file whose headers no alias matches. It is
// VALIDATED first by validateColumnMap (an unknown logical key, or a header not
// present in the file, hard-errors naming the available headers). Logical fields
// NOT named in the map fall through to the normal alias detect, so a partial map
// only overrides what it touches. With no columnMap, behaviour is unchanged.
function indexHeader(header, schema, source, columnMap = null) {
  const norm = header.map((h) => String(h).trim().toLowerCase());
  const overrides = columnMap
    ? validateColumnMap(columnMap, header, schema, source)
    : null;
  const out = {};
  for (const [key, aliases] of Object.entries(schema)) {
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)) {
      out[key] = overrides[key];
      continue;
    }
    let idx = -1;
    for (const a of aliases) {
      idx = norm.indexOf(a.toLowerCase());
      if (idx !== -1) break;
    }
    out[key] = idx;
  }
  return out;
}

// Validate a `columnMap` against the file's actual header + the source schema,
// and resolve each entry to a 0-based column index. PURE; throws an IngestError
// (the existing error style) on:
//   * an unknown logical key (not a field of this source's schema), or
//   * a mapped-to header that is not present in the file.
// Both messages NAME the available options so a broker can self-correct without
// reading source. Returns { <logical>: <index> } for the validated entries only.
function validateColumnMap(columnMap, header, schema, source) {
  const norm = header.map((h) => String(h).trim().toLowerCase());
  const logicalKeys = Object.keys(schema);
  const out = {};
  for (const [logical, wantHeader] of Object.entries(columnMap)) {
    if (!Object.prototype.hasOwnProperty.call(schema, logical)) {
      throw new IngestError(
        `unknown logical field "${logical}" in column map for ${source} ` +
          `(available fields: ${logicalKeys.join(", ")})`,
        { source }
      );
    }
    if (wantHeader == null || String(wantHeader).trim() === "") {
      throw new IngestError(
        `column map for "${logical}" must name a header (got empty value)`,
        { source }
      );
    }
    const idx = norm.indexOf(String(wantHeader).trim().toLowerCase());
    if (idx === -1) {
      throw new IngestError(
        `column map for "${logical}" names header "${wantHeader}" which is not ` +
          `in the file (available headers: ${header.join(", ")})`,
        { source }
      );
    }
    out[logical] = idx;
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
  debit: [
    "debit",
    "withdrawal",
    "withdrawals",
    "money out",
    // real bank exports (Chase/BofA/Wells/QB CSV) — money OUT columns
    "withdrawal amt",
    "withdrawal amount",
    "debit amt",
    "debit amount",
  ],
  credit: [
    "credit",
    "deposit",
    "deposits",
    "money in",
    // real bank exports — money IN columns
    "deposit amt",
    "deposit amount",
    "credit amt",
    "credit amount",
  ],
  memo: ["description", "memo", "details", "name", "payee", "check number", "check #", "check no"],
  type: ["type", "transaction type"],
};

// Build ONE normalized bank record from a parsed row, given the column map and
// the signed/split detection. PURE: throws an IngestError (with `loc`) on any
// bad cell, exactly as the strict parser must. The strict parser and the
// diagnostic parser share this single copy of the per-row logic — they differ
// ONLY in that the diagnostic path wraps it in try/catch to accumulate errors.
function buildBankRecord(arr, cols, hasSigned, loc) {
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
      throw new IngestError("row has BOTH a debit and a credit value", loc);
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
  return makeRecord({
    date,
    amount,
    memo,
    kind,
    party: "",
    source: SOURCE.BANK,
  });
}

function parseBankCSV(text, opts = {}) {
  const rows = parseCSV(text);
  if (rows.length === 0) {
    throw new IngestError("empty bank statement", { source: SOURCE.BANK });
  }
  const cols = indexHeader(rows[0], BANK_SCHEMA, SOURCE.BANK, opts.columnMap);
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
    const loc = { row: r, source: SOURCE.BANK };
    out.push(buildBankRecord(rows[r], cols, hasSigned, loc));
  }
  return out;
}

// Pull a single (possibly unclosed, SGML-style) tag value from an OFX block:
// "everything up to the next '<' or newline".
function ofxTagVal(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, "i"));
  return m ? m[1].trim() : undefined;
}

// Split an OFX/QFX document into its <STMTTRN> transaction blocks. Throws when
// the text is plainly not an OFX document at all (so a misrouted CSV is a clear
// error, not a silent empty result).
function ofxBlocks(text) {
  const blocks = text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || [];
  if (blocks.length === 0 && !/<OFX>|<STMTTRN>/i.test(text)) {
    throw new IngestError("not an OFX/QFX document", { source: SOURCE.BANK });
  }
  return blocks;
}

// Build ONE normalized bank record from a single OFX <STMTTRN> block. PURE;
// throws an IngestError (with `loc`) on any bad/missing tag, exactly like the
// CSV per-row builders. Shared verbatim by the strict and diagnostic OFX paths.
function buildOFXRecord(block, loc) {
  const dtRaw = ofxTagVal(block, "DTPOSTED");
  if (dtRaw == null) throw new IngestError("OFX txn missing DTPOSTED", loc);
  // DTPOSTED may include time/zone: take the leading YYYYMMDD.
  const date = parseDate(dtRaw.slice(0, 8), loc);
  const amount = parseCents(ofxTagVal(block, "TRNAMT"), "TRNAMT", loc);
  const memo = ofxTagVal(block, "MEMO") || ofxTagVal(block, "NAME") || "";
  const trntype = ofxTagVal(block, "TRNTYPE") || "";
  const kind = coerceKind(trntype, `${trntype} ${memo}`, amount, loc);
  return makeRecord({ date, amount, memo, kind, party: "", source: SOURCE.BANK });
}

// Minimal OFX/QFX SGML reader: pull each <STMTTRN> block's fields. We only need
// TRNTYPE, DTPOSTED, TRNAMT, NAME/MEMO. OFX tags are often unclosed (SGML), so
// we read each tag's value as "everything up to the next '<'".
function parseOFX(text) {
  const out = [];
  ofxBlocks(text).forEach((block, i) => {
    out.push(buildOFXRecord(block, { row: i + 1, source: SOURCE.BANK }));
  });
  return out;
}

// Auto-detect OFX vs CSV from the content; `format` ("csv"|"ofx") forces it.
// `columnMap` (CSV only) overrides the alias auto-detect — OFX has no CSV header.
function parseBankStatement(text, { format, columnMap } = {}) {
  if (text == null) throw new IngestError("no bank input", { source: SOURCE.BANK });
  const fmt = format || (/<OFX>|<STMTTRN>|OFXHEADER/i.test(text) ? "ofx" : "csv");
  if (fmt === "ofx") return parseOFX(text);
  return parseBankCSV(text, { columnMap });
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
  party: [
    "name",
    "payee",
    "customer",
    "vendor",
    "received from",
    "paid to",
    // QuickBooks "transaction detail" report columns
    "split",
    "account",
  ],
  // QB exports often carry the check/reference number in a "Num" column and a
  // cleared flag in "Clr"; fold them into the free-text memo so they survive.
  memo: ["memo", "description", "memo/description", "num", "clr"],
  debit: ["debit", "payment", "decrease"],
  credit: ["credit", "deposit", "increase"],
  amount: ["amount", "amt"],
};

// Build ONE normalized QuickBooks record from a parsed row. PURE; throws on a
// bad cell. Shared verbatim by the strict and diagnostic QuickBooks parsers.
function buildQuickBooksRecord(arr, cols, hasSigned, loc) {
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
  return makeRecord({
    date,
    amount,
    memo,
    kind,
    party,
    source: SOURCE.QUICKBOOKS,
  });
}

function parseQuickBooksCSV(text, opts = {}) {
  if (text == null) {
    throw new IngestError("no QuickBooks input", { source: SOURCE.QUICKBOOKS });
  }
  const rows = parseCSV(text);
  if (rows.length === 0) {
    throw new IngestError("empty QuickBooks export", {
      source: SOURCE.QUICKBOOKS,
    });
  }
  const cols = indexHeader(rows[0], QB_SCHEMA, SOURCE.QUICKBOOKS, opts.columnMap);
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
    const loc = { row: r, source: SOURCE.QUICKBOOKS };
    out.push(buildQuickBooksRecord(rows[r], cols, hasSigned, loc));
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
  tenant: ["tenant", "name", "resident", "lessee", "party", "lease"],
  unit: ["unit", "apt", "apartment", "property", "door"],
  memo: ["memo", "description", "note", "charge type", "details"],
  amount: ["amount", "amt"],
  payment: ["payment", "paid", "received", "credit", "amount paid"],
  charge: ["charge", "owed", "assessment", "debit", "amount due"],
  type: ["type", "transaction type"],
};

// Build ONE normalized rent-roll record from a parsed row. PURE; throws on a
// bad cell or a missing tenant. Shared verbatim by the strict and diagnostic
// rent-roll parsers.
function buildRentRollRecord(arr, cols, hasSigned, loc) {
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
  return makeRecord({
    date,
    amount,
    memo: memoRaw,
    kind,
    party,
    source: SOURCE.RENT_ROLL,
  });
}

function parseRentRollCSV(text, opts = {}) {
  if (text == null) {
    throw new IngestError("no rent-roll input", { source: SOURCE.RENT_ROLL });
  }
  const rows = parseCSV(text);
  if (rows.length === 0) {
    throw new IngestError("empty rent roll", { source: SOURCE.RENT_ROLL });
  }
  const cols = indexHeader(rows[0], RENT_SCHEMA, SOURCE.RENT_ROLL, opts.columnMap);
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
    const loc = { row: r, source: SOURCE.RENT_ROLL };
    out.push(buildRentRollRecord(rows[r], cols, hasSigned, loc));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diagnostic ingest core (T-25.1) — parse-WITH-report, never fail-closed
// ---------------------------------------------------------------------------
//
// The strict parsers above (parseBankStatement / parseQuickBooksCSV /
// parseRentRollCSV) fail CLOSED: the first malformed row aborts the whole file.
// That is correct for the reconcile path — a trust reconciliation must NEVER
// silently partial-parse, because a dropped row hides the exact discrepancy the
// broker is legally on the hook to find.
//
// But ONBOARDING needs the opposite: when a broker first feeds the tool a real
// export, they need to SEE what happened — which header columns mapped to which
// logical field, how many rows normalized, and EVERY row that failed (not just
// the first) — so they can fix the file or supply a column map. That is what the
// `diagnose*` family provides.
//
// CRITICAL INVARIANT: the diagnostic path REUSES the exact same per-row builders
// (buildBankRecord / buildQuickBooksRecord / buildRentRollRecord) and the same
// primitives (parseCSV / indexHeader / parseDate / parseCents / coerceKind) that
// the strict parsers use. It re-implements NONE of the parse logic. It differs
// from the strict parsers in EXACTLY two ways:
//   (1) it wraps each per-row build in try/catch and ACCUMULATES IngestErrors
//       instead of throwing on the first, and
//   (2) it returns the detected header + the logical->header column map.
// A missing REQUIRED column is reported in `requiredMissing` (still a hard
// problem, surfaced to the caller) rather than collapsing the whole file.
//
// `diagnose*` is PURE and side-effect-free: no I/O, no clock, no globals. Given
// the same (text, opts) it returns a byte-identical report.

// Per-source diagnostic config. Each entry names the schema, the REQUIRED
// logical columns, and the per-row builder + amount-mode detector reused from
// the strict path. Centralizing this keeps the strict and diagnostic paths in
// lock-step: they consult the SAME schema and the SAME required set.
const DIAGNOSE_CONFIG = Object.freeze({
  [SOURCE.BANK]: {
    schema: BANK_SCHEMA,
    required: ["date"],
    // logical fields whose presence (any one) is also required for a usable file
    amountGroups: [["amount"], ["debit", "credit"]],
    amountGroupMessage:
      'bank statement needs an "amount" column or debit/credit columns',
    build: buildBankRecord,
  },
  [SOURCE.QUICKBOOKS]: {
    schema: QB_SCHEMA,
    required: ["date"],
    amountGroups: [["amount"], ["debit", "credit"]],
    amountGroupMessage:
      'QuickBooks export needs an "amount" column or debit/credit columns',
    build: buildQuickBooksRecord,
  },
  [SOURCE.RENT_ROLL]: {
    schema: RENT_SCHEMA,
    required: ["date", "tenant"],
    amountGroups: [["amount"], ["payment", "charge"]],
    amountGroupMessage:
      'rent roll needs an "amount" column or payment/charge columns',
    build: buildRentRollRecord,
  },
});

// Diagnose an OFX/QFX bank file: the same parse-WITH-report contract as the CSV
// path, but OFX has no header row / column map — it is a stream of <STMTTRN>
// blocks. We REUSE buildOFXRecord verbatim (the strict OFX path uses the same
// builder) and accumulate per-transaction errors instead of failing closed. The
// report keeps the SAME shape so inspect renders it uniformly; `format` is set
// to "ofx", `header`/`mapped` reflect the OFX tags rather than CSV columns.
function diagnoseOFX(text, sampleSize) {
  const report = {
    source: SOURCE.BANK,
    format: "ofx",
    // For OFX there is no CSV header row; surface the OFX tags we read so the
    // human view still has a "what columns did you see" line.
    header: ["DTPOSTED", "TRNAMT", "TRNTYPE", "NAME/MEMO"],
    mapped: {
      date: "DTPOSTED",
      amount: "TRNAMT",
      type: "TRNTYPE",
      memo: "NAME/MEMO",
    },
    requiredMissing: [],
    rowCount: 0,
    okCount: 0,
    records: [],
    errors: [],
    sample: [],
  };

  let blocks;
  try {
    blocks = ofxBlocks(text);
  } catch (err) {
    if (err instanceof IngestError) {
      report.errors.push({ row: null, message: err.message });
      return report;
    }
    throw err;
  }
  if (blocks.length === 0) {
    report.errors.push({
      row: null,
      message: "OFX document has no <STMTTRN> transactions",
    });
    return report;
  }

  blocks.forEach((block, i) => {
    report.rowCount += 1;
    const loc = { row: i + 1, source: SOURCE.BANK };
    try {
      const rec = buildOFXRecord(block, loc);
      report.records.push(rec);
      report.okCount += 1;
      if (report.sample.length < sampleSize) report.sample.push(rec);
    } catch (err) {
      if (err instanceof IngestError) {
        report.errors.push({ row: i + 1, message: err.message });
      } else {
        throw err;
      }
    }
  });
  return report;
}

// The single diagnostic driver. `source` selects the config; `text` is the raw
// file; `opts.sampleSize` controls how many ok rows are echoed in `sample`
// (default 5). For the bank source `opts.format` ("csv"|"ofx") forces the file
// format; otherwise it is auto-detected exactly like `parseBankStatement`, so
// inspect gives the SAME answer the reconcile pipeline would for OFX/QFX exports.
// Returns the structured report described in the module header.
function diagnoseSource(source, text, opts = {}) {
  const cfg = DIAGNOSE_CONFIG[source];
  if (!cfg) {
    throw new IngestError(`unknown source "${source}" for diagnose`);
  }
  const sampleSize = opts.sampleSize == null ? 5 : opts.sampleSize;

  // Bank files may be OFX/QFX. Honour an explicit format, else auto-detect with
  // the SAME predicate parseBankStatement uses, and route to the OFX diagnostic
  // path so the onboarding tool never gives a worse answer than the real pipeline.
  if (source === SOURCE.BANK && text != null) {
    const fmt =
      opts.format ||
      (/<OFX>|<STMTTRN>|OFXHEADER/i.test(text) ? "ofx" : "csv");
    if (fmt === "ofx") return diagnoseOFX(text, sampleSize);
  }

  const report = {
    source,
    format: "csv",
    header: [],
    mapped: {},
    requiredMissing: [],
    rowCount: 0,
    okCount: 0,
    records: [],
    errors: [],
    sample: [],
  };

  // A null/empty file is a whole-file problem, not a row problem. Report it as a
  // hard error rather than throwing, so the inspect command can surface it.
  if (text == null) {
    report.errors.push({ row: null, message: `no ${source} input` });
    return report;
  }

  const rows = parseCSV(text);
  if (rows.length === 0) {
    report.errors.push({ row: null, message: `empty ${source} file` });
    return report;
  }

  const header = rows[0].map((h) => String(h));
  report.header = header.slice();

  // Reuse indexHeader VERBATIM (including the SAME columnMap the reconcile run
  // will use, so `inspect` previews under the identical mapping), then translate
  // each index back to the ORIGINAL header name (or null when unmatched) so the
  // caller sees which column satisfied each logical field. A malformed columnMap
  // (unknown logical key or a header absent from the file) hard-errors here with
  // the SAME message the strict parser would give — surfaced as a file-level
  // error rather than crashing, so inspect can render it.
  let cols;
  try {
    cols = indexHeader(header, cfg.schema, source, opts.columnMap);
  } catch (err) {
    if (err instanceof IngestError) {
      report.errors.push({ row: null, message: err.message });
      report.rowCount = Math.max(rows.length - 1, 0);
      return report;
    }
    throw err;
  }
  for (const key of Object.keys(cfg.schema)) {
    const idx = cols[key];
    report.mapped[key] = idx === -1 || idx === undefined ? null : header[idx];
  }

  // Missing REQUIRED columns are surfaced (hard problem) but do NOT collapse the
  // whole file — we still echo the header and the partial map back so the broker
  // can see exactly what to add or remap.
  for (const n of cfg.required) {
    if (cols[n] === -1 || cols[n] === undefined) {
      report.requiredMissing.push(n);
    }
  }

  // An amount group must be present (signed amount OR a split pair). If none is,
  // record it as a hard error; without it, no row can yield a usable amount.
  const groupPresent = cfg.amountGroups.some((group) =>
    group.some((k) => cols[k] !== -1 && cols[k] !== undefined)
  );
  const hasSigned = cols.amount !== -1 && cols.amount !== undefined;

  // If a required column or the amount group is missing, the per-row builder
  // would throw the SAME structural error on every single row (e.g. "missing
  // date"), which is noise. Report the structural problems once and return — the
  // caller fixes the header first, then re-runs to see row-level errors.
  if (report.requiredMissing.length > 0 || !groupPresent) {
    if (!groupPresent) {
      report.errors.push({ row: null, message: cfg.amountGroupMessage });
    }
    report.rowCount = Math.max(rows.length - 1, 0);
    return report;
  }

  for (let r = 1; r < rows.length; r++) {
    report.rowCount += 1;
    const loc = { row: r, source };
    try {
      const rec = cfg.build(rows[r], cols, hasSigned, loc);
      report.records.push(rec);
      report.okCount += 1;
      if (report.sample.length < sampleSize) report.sample.push(rec);
    } catch (err) {
      if (err instanceof IngestError) {
        report.errors.push({ row: r, message: err.message });
      } else {
        throw err; // a non-ingest bug is real — do not swallow it
      }
    }
  }

  return report;
}

// Pre-flight a resolved columnMap for a source against a file's actual header,
// WITHOUT parsing any data rows. Reuses the SAME parseCSV + per-source schema +
// validateColumnMap the strict parsers use, so it accepts/rejects EXACTLY what
// the strict parse would — but it throws the IngestError EARLY (before any row
// work), letting the CLI classify a bad map as a USAGE error (a bad flag value)
// rather than an IO/data error. PURE; no I/O, no clock.
//
// For the bank source an OFX/QFX document has NO CSV header row and ignores the
// columnMap entirely (parseBankStatement routes OFX past it), so this is a no-op
// for OFX — there is nothing to validate against and nothing the strict parse
// would reject. `opts.format` ("csv"|"ofx") forces the bank format; otherwise it
// is auto-detected with the SAME predicate parseBankStatement uses.
function validateColumnMapForSource(source, text, columnMap, opts = {}) {
  if (!columnMap || Object.keys(columnMap).length === 0) return;
  const cfg = DIAGNOSE_CONFIG[source];
  if (!cfg) {
    throw new IngestError(`unknown source "${source}" for column-map validation`);
  }
  // OFX bank files carry no header to validate the map against; the strict
  // parser ignores columnMap for OFX, so skip (no-op), matching that behaviour.
  if (source === SOURCE.BANK && text != null) {
    const fmt =
      opts.format ||
      (/<OFX>|<STMTTRN>|OFXHEADER/i.test(text) ? "ofx" : "csv");
    if (fmt === "ofx") return;
  }
  if (text == null) return; // a null file is its own (later) error, not a map error
  const rows = parseCSV(text);
  if (rows.length === 0) return; // an empty file is its own (later) error
  // Throws an IngestError (naming available headers/fields) on a bad entry.
  validateColumnMap(columnMap, rows[0], cfg.schema, source);
}

// Report the accepted header ALIASES for a logical field of a source. The
// inspect/onboarding path uses this to print an ACTIONABLE hint ("add a column
// named one of [...]") without re-declaring the schema — it reads the SAME
// schema the diagnostic + strict parsers consult, so the hint can never drift
// from what the parser actually accepts. Returns [] for an unknown field.
function aliasesFor(source, logical) {
  const cfg = DIAGNOSE_CONFIG[source];
  if (!cfg) throw new IngestError(`unknown source "${source}" for aliasesFor`);
  const a = cfg.schema[logical];
  return Array.isArray(a) ? a.slice() : [];
}

// Convenience per-source wrappers (the `diagnose{Bank,QuickBooks,RentRoll}`
// family named in the acceptance), each a thin call into diagnoseSource.
function diagnoseBank(text, opts) {
  return diagnoseSource(SOURCE.BANK, text, opts);
}
function diagnoseQuickBooks(text, opts) {
  return diagnoseSource(SOURCE.QUICKBOOKS, text, opts);
}
function diagnoseRentRoll(text, opts) {
  return diagnoseSource(SOURCE.RENT_ROLL, text, opts);
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
  validateColumnMap,
  parseBankStatement,
  parseBankCSV,
  parseOFX,
  diagnoseOFX,
  parseQuickBooksCSV,
  parseRentRollCSV,
  validateColumnMapForSource,
  // diagnostic ingest core (T-25.1) — parse-with-report, never fail-closed
  diagnoseSource,
  diagnoseBank,
  diagnoseQuickBooks,
  diagnoseRentRoll,
  aliasesFor,
};

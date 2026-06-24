"use strict";

// TrustLedger — close.js
//
// T-24.1: the versioned PERIOD-CLOSE artifact + pure build / read / validate,
// plus a pure continuity check that chains one period to the next.
//
// THE PROBLEM THIS SOLVES.
// A three-way trust reconciliation is a MONTHLY ritual. Each month's reconciled
// ending balances become the NEXT month's opening balances — the "roll-forward".
// If June closes at a bank balance of $12,345.67, July MUST open at exactly
// $12,345.67; any other opening means a period was skipped, edited, or re-keyed,
// and the chain of custody over the trust money is broken. This module emits a
// small, strictly-validated JSON "close" artifact at the end of a period so the
// next period can SEED its opening from it and the tool can CHECK the roll-forward
// is penny-exact.
//
// PURE + DETERMINISTIC. `buildClose(model)` derives the artifact purely from the
// report packet model (no clock, no I/O, no randomness). Given the same model it
// returns a byte-identical artifact — including a deterministic `inputsDigest`
// (a SHA-256 over the normalized inputs the packet already holds, via Node's
// built-in `crypto` — NO new dependency) that BINDS the close to the data it
// summarizes, so a tampered or swapped close is detectable.
//
// HONEST POSTURE — the close is an UNTRUSTED CONVENIENCE HINT.
// Consistent with the codebase's standing trust boundary (docs/TRUST-BOUNDARIES.md
// and the receipt NatSpec): this artifact carries the prior period's ASSERTED
// ending so the next run can seed + check the opening, but the AUTHORITATIVE
// verdict is always the freshly RECOMPUTED reconciliation — never the value
// written here. A broker who edits this file changes a hint, not the truth: the
// next reconciliation recomputes the three balances from the source files and the
// continuity check merely reports whether the asserted roll-forward matched. The
// close is NOT signed and NOT timestamped; like every other artifact in this repo
// it rides the human trust-root (the broker remains the legal custodian and a CPA
// review still governs). It does not, and cannot, replace that review.

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Schema version. Bumped only on a breaking shape change. `validateClose`
// REJECTS any other value rather than guessing — a close from a future/older
// tool must be handled deliberately, never silently coerced.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = "trustledger.period-close/v1";

// A SHA-256 hex digest is exactly 64 lowercase hex chars.
const DIGEST_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Errors — STRICT. A malformed/ambiguous close raises a NAMED error rather than
// being silently dropped, coerced, or partially accepted.
// ---------------------------------------------------------------------------

class CloseError extends Error {
  constructor(message) {
    super(message);
    this.name = "CloseError";
  }
}

// ---------------------------------------------------------------------------
// Small strict helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// An integer-cents money value: a JS integer (no floats, no NaN, no Infinity).
function isCents(v) {
  return Number.isInteger(v);
}

// A { bank, book } balance pair where both legs are integer cents.
function isBalancePair(v) {
  return isPlainObject(v) && isCents(v.bank) && isCents(v.book);
}

// ---------------------------------------------------------------------------
// The deterministic inputs digest.
//
// We hash a CANONICAL, order-stable JSON projection of the inputs the packet
// already summarizes — the period, report date, opening, ending, subledger, and
// the input record counts — so the digest is reproducible to the byte for the
// same model and CHANGES if any of those summarized facts change. This binds the
// close to its data without pulling in a new dependency: Node's built-in crypto.
//
// NOTE: this is a convenience integrity tag over the SUMMARY the close carries,
// NOT a cryptographic proof of the underlying source files (which are the
// authoritative inputs and are re-read on the next reconciliation). It lets a
// reader detect a hand-edited close field; it is not a signature.
// ---------------------------------------------------------------------------

function canonicalInputs(parts) {
  // Build the object with keys in a fixed, explicit order so JSON.stringify is
  // byte-stable regardless of how the caller's model was assembled.
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    period: parts.period,
    reportDate: parts.reportDate,
    opening: { bank: parts.opening.bank, book: parts.opening.book },
    ending: { bank: parts.ending.bank, book: parts.ending.book },
    subledger: parts.subledger,
    tiesOut: parts.tiesOut,
    pass: parts.pass,
    inputs: {
      bankRecords: parts.inputs.bankRecords,
      bookRecords: parts.inputs.bookRecords,
      rentrollRecords: parts.inputs.rentrollRecords,
    },
  });
}

function digestInputs(parts) {
  return crypto
    .createHash("sha256")
    .update(canonicalInputs(parts), "utf8")
    .digest("hex");
}

// ---------------------------------------------------------------------------
// buildClose(model) — derive the close artifact PURELY from the packet model.
//
// Reuses model.opening / model.balances / model.period / model.reportDate and
// the model's pass/tiesOut verdict. The `ending` balances are the period's
// CLOSING bank/book ({ bank: model.balances.bank, book: model.balances.book });
// `subledger` is model.balances.subledger. Computes the deterministic
// inputsDigest. Returns a JSON-serializable object; byte-deterministic for a
// given model.
// ---------------------------------------------------------------------------

function buildClose(model) {
  if (!isPlainObject(model)) {
    throw new CloseError("buildClose requires the report packet model object");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(model.reportDate || ""))) {
    throw new CloseError('model.reportDate must be a "YYYY-MM-DD" string');
  }
  if (!isBalancePair(model.balances)) {
    throw new CloseError(
      "model.balances must carry integer-cents bank/book balances"
    );
  }
  if (!isCents(model.balances.subledger)) {
    throw new CloseError("model.balances.subledger must be integer cents");
  }

  // opening: reuse model.opening when present (integer cents both legs), else
  // treat the period as opening from zero. We never coerce a non-integer opening
  // into something else — a present-but-garbled opening is a hard error.
  let opening;
  if (model.opening == null) {
    opening = { bank: 0, book: 0 };
  } else if (isBalancePair(model.opening)) {
    opening = { bank: model.opening.bank, book: model.opening.book };
  } else {
    throw new CloseError(
      "model.opening, when present, must carry integer-cents bank/book balances"
    );
  }

  const ending = { bank: model.balances.bank, book: model.balances.book };
  const subledger = model.balances.subledger;

  // The verdict the close records: prefer the explicit pass flag, fall back to
  // tiesOut. Both are booleans on the packet model.
  const tiesOut = model.tiesOut === true;
  const pass = model.pass === undefined ? tiesOut : model.pass === true;

  const inputs = {
    bankRecords: countOf(model, "bankRecords"),
    bookRecords: countOf(model, "bookRecords"),
    rentrollRecords: countOf(model, "rentrollRecords"),
  };

  const digestParts = {
    period: model.period == null ? null : String(model.period),
    reportDate: model.reportDate,
    opening,
    ending,
    subledger,
    tiesOut,
    pass,
    inputs,
  };

  const close = {
    schemaVersion: SCHEMA_VERSION,
    period: model.period == null ? null : String(model.period),
    reportDate: model.reportDate,
    opening,
    ending,
    subledger,
    tiesOut,
    pass,
    inputs,
    inputsDigest: digestInputs(digestParts),
  };

  // Self-check: the artifact we just built must itself validate. This guarantees
  // build/validate stay in lock-step — a build can never emit something read
  // back as corrupt.
  validateClose(close);
  return close;
}

// Pull a record count off the packet model's `inputs` block, defaulting to 0
// when the model did not carry it. Always a non-negative integer in the digest.
function countOf(model, key) {
  const n = model.inputs && model.inputs[key];
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// readClose(text|obj) — parse + validate a close. Accepts either a JSON string
// (parsed strictly — a parse error is a CloseError, not a thrown SyntaxError) or
// an already-parsed object. Returns the validated object. STRICT: a partial or
// corrupt close NEVER round-trips silently — validateClose rejects it.
// ---------------------------------------------------------------------------

function readClose(input) {
  let obj;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch (e) {
      throw new CloseError(`close is not valid JSON: ${e.message}`);
    }
  } else if (isPlainObject(input)) {
    obj = input;
  } else {
    throw new CloseError("readClose requires a JSON string or a close object");
  }
  validateClose(obj);
  return obj;
}

// ---------------------------------------------------------------------------
// validateClose(obj) — STRICT structural + value validation. Throws a named
// CloseError on the FIRST problem found; returns the object unchanged on success.
// Rejects: a wrong schemaVersion; a missing/garbled period / reportDate /
// opening / ending / subledger; a non-integer-cents balance; a malformed digest.
// ---------------------------------------------------------------------------

function validateClose(obj) {
  if (!isPlainObject(obj)) {
    throw new CloseError("close must be an object");
  }

  if (obj.schemaVersion !== SCHEMA_VERSION) {
    throw new CloseError(
      `unsupported schemaVersion: expected "${SCHEMA_VERSION}", got ${JSON.stringify(
        obj.schemaVersion
      )}`
    );
  }

  // period: required key; null is allowed (a period label is optional metadata),
  // but a present period MUST be a string — an object/number is garbled.
  if (!("period" in obj)) {
    throw new CloseError("close is missing `period`");
  }
  if (obj.period !== null && typeof obj.period !== "string") {
    throw new CloseError("close.period must be a string or null");
  }

  // reportDate: required, a strict "YYYY-MM-DD" string.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(obj.reportDate || ""))) {
    throw new CloseError('close.reportDate must be a "YYYY-MM-DD" string');
  }

  // opening / ending: required integer-cents { bank, book } pairs.
  if (!("opening" in obj)) {
    throw new CloseError("close is missing `opening`");
  }
  if (!isBalancePair(obj.opening)) {
    throw new CloseError(
      "close.opening must carry integer-cents bank/book balances"
    );
  }
  if (!("ending" in obj)) {
    throw new CloseError("close is missing `ending`");
  }
  if (!isBalancePair(obj.ending)) {
    throw new CloseError(
      "close.ending must carry integer-cents bank/book balances"
    );
  }

  // subledger: required integer cents.
  if (!("subledger" in obj)) {
    throw new CloseError("close is missing `subledger`");
  }
  if (!isCents(obj.subledger)) {
    throw new CloseError("close.subledger must be integer cents");
  }

  // verdict flags: required booleans.
  if (typeof obj.tiesOut !== "boolean") {
    throw new CloseError("close.tiesOut must be a boolean");
  }
  if (typeof obj.pass !== "boolean") {
    throw new CloseError("close.pass must be a boolean");
  }

  // inputs: required record-count block, each a non-negative integer.
  if (!isPlainObject(obj.inputs)) {
    throw new CloseError("close is missing `inputs` record counts");
  }
  for (const k of ["bankRecords", "bookRecords", "rentrollRecords"]) {
    const n = obj.inputs[k];
    if (!Number.isInteger(n) || n < 0) {
      throw new CloseError(`close.inputs.${k} must be a non-negative integer`);
    }
  }

  // inputsDigest: required, a well-formed lowercase SHA-256 hex string.
  if (typeof obj.inputsDigest !== "string" || !DIGEST_RE.test(obj.inputsDigest)) {
    throw new CloseError(
      "close.inputsDigest must be a 64-char lowercase hex SHA-256 digest"
    );
  }

  return obj;
}

// ---------------------------------------------------------------------------
// checkContinuity(priorClose, opening) — pure roll-forward check.
//
// Compares the prior period's asserted `ending` to THIS period's `opening`,
// PENNY-EXACT. The comparison takes NO tolerance: a roll-forward must be exact,
// so a one-cent drift is a real gap, not noise.
//
// Returns a structured result, never throwing on a gap (the CALLER decides how
// to surface it — T-24.2 turns a gap into a continuity exception):
//   { ok: <bool>, bankGap: <int cents>, bookGap: <int cents> }
// where bankGap = opening.bank - priorEnding.bank (signed; positive means this
// period opened HIGHER than the prior period closed) and likewise bookGap. `ok`
// is true iff both gaps are exactly zero.
//
// A null/undefined priorClose means there is NO prior period to chain from (the
// first period a broker runs): that is `{ ok: true }` — nothing to reconcile
// against, so nothing can be out of continuity.
//
// SIDE-EFFECT FREE. Reads its arguments, returns a fresh object, mutates nothing.
// Honest-posture reminder: a passing continuity check confirms the asserted
// roll-forward is internally consistent; it does NOT independently verify the
// prior period — the prior close is an untrusted hint, and the authoritative
// numbers are the freshly recomputed reconciliation.
// ---------------------------------------------------------------------------

function checkContinuity(priorClose, opening) {
  // No prior period to chain from.
  if (priorClose == null) {
    return { ok: true };
  }

  // The prior close must be a well-formed close to be compared against — a
  // garbled prior is a hard error here (not a silent pass), because chaining
  // from corrupt data would defeat the whole point of the check. Use readClose
  // so a JSON string or object both work, and a corrupt one is rejected loudly.
  const prior = readClose(priorClose);

  if (!isBalancePair(opening)) {
    throw new CloseError(
      "checkContinuity opening must carry integer-cents bank/book balances"
    );
  }

  const bankGap = opening.bank - prior.ending.bank;
  const bookGap = opening.book - prior.ending.book;
  const ok = bankGap === 0 && bookGap === 0;
  return { ok, bankGap, bookGap };
}

module.exports = {
  SCHEMA_VERSION,
  CloseError,
  buildClose,
  readClose,
  validateClose,
  checkContinuity,
  // exported for focused tests / reuse
  digestInputs,
};

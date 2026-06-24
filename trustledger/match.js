"use strict";

// TrustLedger — match.js
//
// T-22.2: the EXACT-then-FUZZY transaction matcher.
//
// Reconciliation is, at its core, a bipartite matching problem: each line on
// one statement (e.g. the BANK) should correspond to one — or, for a batched
// deposit, SEVERAL — lines on the other (e.g. the QuickBooks/rent ledger). The
// real world makes this hard in three recurring ways a property manager hits
// EVERY month:
//
//   1. TIMING. A tenant's payment posts to the ledger on the 1st but clears the
//      bank on the 2nd or 3rd. Same money, different date. We need a tolerant
//      date window, not an equality test.
//
//   2. SPLIT / BATCHED DEPOSITS. The manager walks three rent checks to the
//      bank and they land as ONE $4,500 bank credit, while the ledger has three
//      separate $1,500 tenant payments. One bank line must match a SET of
//      ledger lines whose amounts sum to it.
//
//   3. NSF REVERSALS. A deposit bounces; the bank posts a NEGATIVE reversal of
//      the exact (or near) amount. Both the original and the reversal must be
//      reconciled so the net effect is visible, not silently netted away.
//
// This module is a PURE, DETERMINISTIC function of its two input arrays and the
// options. No clock, no randomness, no I/O. Given the same inputs it returns
// byte-identical output regardless of the ORDER of either list — a property the
// tests assert directly, because a reconciliation a broker signs must be
// reproducible.
//
// Return shape:
//   {
//     matched:     [ { a, b, confidence, kind } , ... ],
//     unmatchedA:  [ <record>, ... ],
//     unmatchedB:  [ <record>, ... ],
//   }
// where in each pairing exactly ONE side is a single record and the other side
// MAY be an array (the split). `a` always refers to a record (or array) drawn
// from list A, `b` from list B. `confidence` is a 0..1 number; `kind` is a short
// machine string explaining WHY it matched ("exact", "amount+window",
// "split", "nsf-reversal").

// ---------------------------------------------------------------------------
// Tunables (all overridable via opts)
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  // How many calendar days the two sides of a pairing may differ by and still
  // be considered the same event. 0 => same-day only.
  dateToleranceDays: 3,

  // Amounts are integer cents and must match EXACTLY in magnitude — money does
  // not "almost" reconcile. This is a guard against a future caller passing a
  // float tolerance; we keep it 0 and reject non-zero with a clear error rather
  // than silently fuzzing dollars.
  amountToleranceCents: 0,

  // Largest number of B-records allowed to combine into one A-record (or vice
  // versa) for a split/batched deposit. Bounds the combinatorial search so a
  // pathological month can never blow up; a single deposit batching more than
  // this many tenant payments is vanishingly rare and better surfaced as an
  // exception than matched by brute force.
  maxSplitParts: 6,

  // Largest WINDOWED, same-sign candidate POOL we will brute-force a split over
  // for a single record. maxSplitParts bounds the DEPTH of the search; this
  // bounds its BREADTH. When many unmatched same-sign lines cluster inside one
  // date window (the real-world shape on the 1st-5th of a month, when most rent
  // posts), C(n, k) explodes even though each subset is shallow. Above this
  // pool size we DECLINE the brute-force split and leave the record as an
  // exception for a human — the same "surface it rather than guess" philosophy
  // as maxSplitParts, applied to the dimension that actually blows up. A real
  // batched deposit almost never draws from more than a couple dozen same-day,
  // same-sign candidates; a pool larger than this is itself a signal the file
  // needs a human eye, not a 2-minute combinatorial grind.
  maxSplitCandidates: 24,

  // Minimum memo similarity (0..1) required to LOWER confidence vs. raise it;
  // memo never blocks a same-amount/in-window match, it only modulates the
  // reported confidence so a reviewer can sort by it.
  memoWeight: 0.25,
});

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

// Whole-day difference between two "YYYY-MM-DD" strings (absolute value).
// Pure calendar arithmetic via UTC epoch days — no timezone, no Date-locale.
function dayDiff(isoA, isoB) {
  return Math.abs(epochDay(isoA) - epochDay(isoB));
}

function epochDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new MatchError(`bad date in record: "${iso}"`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // Days from a fixed civil epoch (Howard Hinnant's algorithm). Deterministic,
  // leap-correct, and independent of the host Date implementation.
  const yy = mo <= 2 ? y - 1 : y;
  const era = Math.floor((yy >= 0 ? yy : yy - 399) / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (mo > 2 ? mo - 3 : mo + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

// Normalize a memo for comparison: lowercase, collapse whitespace, drop
// punctuation. Deterministic.
function normMemo(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Token-set Jaccard similarity of two memos, 0..1. Empty-vs-empty => 1 (no
// information either way is treated as neutral-high so blank memos don't punish
// an otherwise-perfect amount/date match). Empty-vs-nonempty => 0.
function memoSimilarity(a, b) {
  const na = normMemo(a);
  const nb = normMemo(b);
  if (na === "" && nb === "") return 1;
  if (na === "" || nb === "") return 0;
  const sa = new Set(na.split(" "));
  const sb = new Set(nb.split(" "));
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class MatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "MatchError";
  }
}

// ---------------------------------------------------------------------------
// Stable identity / ordering
//
// To be order-independent yet deterministic we (1) tag every input record with
// its original index, (2) sort a STABLE working copy by an intrinsic key
// (date, amount, memo, original index), and (3) always iterate that sorted copy.
// Two callers passing the same multiset of records in different orders therefore
// walk the SAME sequence of decisions and produce the same pairings.
// ---------------------------------------------------------------------------

function sortKey(rec) {
  // Intrinsic, input-order-free key. Original index is the FINAL tiebreak only
  // for genuinely identical records (same date/amount/memo), where the choice
  // cannot affect amounts and is therefore reconciliation-neutral.
  return [rec.date, pad(rec.amount), normMemo(rec.memo)];
}

// Zero-pad a signed integer so lexical sort == numeric sort.
function pad(n) {
  const neg = n < 0;
  const s = String(Math.abs(n)).padStart(15, "0");
  // "-" sorts before "0" in ASCII, but we want -100 < -1 < 0 < 1; invert the
  // magnitude ordering for negatives by mapping to a complement.
  return neg ? "0:" + complement(s) : "1:" + s;
}
function complement(digits) {
  // Nine's-complement so larger magnitude negatives sort first.
  let out = "";
  for (const c of digits) out += String(9 - Number(c));
  return out;
}

function cmpKey(a, b) {
  const ka = a.__key;
  const kb = b.__key;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  // Final, stable tiebreak on original index.
  return a.__idx - b.__idx;
}

// Wrap input records with stable metadata WITHOUT mutating the caller's objects.
function prepare(list, label) {
  if (!Array.isArray(list)) {
    throw new MatchError(`${label} must be an array of records`);
  }
  return list.map((rec, i) => {
    if (rec == null || typeof rec !== "object") {
      throw new MatchError(`${label}[${i}] is not a record object`);
    }
    if (typeof rec.amount !== "number" || !Number.isInteger(rec.amount)) {
      throw new MatchError(`${label}[${i}].amount must be integer cents`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rec.date || ""))) {
      throw new MatchError(`${label}[${i}].date must be "YYYY-MM-DD"`);
    }
    const w = {
      __idx: i,
      __rec: rec,
      date: rec.date,
      amount: rec.amount,
      memo: rec.memo == null ? "" : String(rec.memo),
      used: false,
    };
    w.__key = sortKey(w);
    return w;
  });
}

// ---------------------------------------------------------------------------
// Confidence model
// ---------------------------------------------------------------------------

// Combine the date closeness and memo similarity into a 0..1 confidence for a
// same-amount pairing. Exact same-day with matching memo => ~1.0; a far-but-in-
// window date and unrelated memo => lower but still > a floor that keeps it
// above "unmatched". Monotonic and deterministic.
function confidenceFor(dDiff, tol, memoSim, memoWeight) {
  // Date component: 1 at 0 days, linearly down to a 0.5 floor at the tolerance
  // edge (in-window is never "low confidence on date alone").
  const dateComp = tol === 0 ? 1 : 1 - 0.5 * (dDiff / tol);
  // Blend in memo similarity with its configured weight.
  const c = (1 - memoWeight) * dateComp + memoWeight * memoSim;
  // Clamp and round to 4 dp so output is stable/printable.
  return Math.round(Math.min(1, Math.max(0, c)) * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

function reconcile(listA, listB, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts || {}) };
  if (cfg.amountToleranceCents !== 0) {
    throw new MatchError(
      "amountToleranceCents must be 0: money reconciles exactly, only DATE is fuzzy"
    );
  }
  if (!Number.isInteger(cfg.dateToleranceDays) || cfg.dateToleranceDays < 0) {
    throw new MatchError("dateToleranceDays must be a non-negative integer");
  }
  if (!Number.isInteger(cfg.maxSplitParts) || cfg.maxSplitParts < 1) {
    throw new MatchError("maxSplitParts must be a positive integer");
  }
  if (
    !Number.isInteger(cfg.maxSplitCandidates) ||
    cfg.maxSplitCandidates < 1
  ) {
    throw new MatchError("maxSplitCandidates must be a positive integer");
  }

  const A = prepare(listA, "listA").sort(cmpKey);
  const B = prepare(listB, "listB").sort(cmpKey);

  const matched = [];

  // -- Pass 1: EXACT (same amount AND same date). --------------------------
  // Most lines reconcile here. Index B by an exact (date,amount) bucket so the
  // pass is linear; consume greedily in stable sorted order so the choice among
  // identical candidates is deterministic.
  pairOneToOne(A, B, matched, {
    tol: 0,
    cfg,
    kind: "exact",
    sameDateOnly: true,
  });

  // -- Pass 2: AMOUNT + DATE WINDOW (timing differences, incl. NSF). -------
  // Same magnitude, date within tolerance. An equal-and-opposite amount within
  // the window is the signature of an NSF reversal and is labeled as such.
  pairOneToOne(A, B, matched, {
    tol: cfg.dateToleranceDays,
    cfg,
    kind: "amount+window",
    sameDateOnly: false,
  });

  // -- Pass 3: SPLIT / BATCHED deposits. -----------------------------------
  // One remaining record on one side whose amount equals the SUM of a small set
  // of remaining records on the other side, all within the date window of the
  // single side. Try A-singletons against B-subsets, then B-singletons against
  // A-subsets, so both "bank batched the ledger" and "ledger batched the bank"
  // are covered.
  pairSplits(A, B, matched, cfg, /*aIsSingle=*/ true);
  pairSplits(B, A, matched, cfg, /*aIsSingle=*/ false);

  // Whatever is still unused is a genuine exception the broker must investigate.
  const unmatchedA = A.filter((w) => !w.used)
    .sort(cmpKey)
    .map((w) => w.__rec);
  const unmatchedB = B.filter((w) => !w.used)
    .sort(cmpKey)
    .map((w) => w.__rec);

  // Sort matched deterministically by the A-side key then B-side key so output
  // order is independent of pass order and input order.
  matched.sort((x, y) => {
    const ka = firstKey(x.__akeys);
    const kb = firstKey(y.__akeys);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    const kc = firstKey(x.__bkeys);
    const kd = firstKey(y.__bkeys);
    if (kc < kd) return -1;
    if (kc > kd) return 1;
    return 0;
  });

  return {
    matched: matched.map(stripMeta),
    unmatchedA,
    unmatchedB,
  };
}

function firstKey(keys) {
  // keys is an array of __key arrays; compare by their min for stable ordering.
  let best = null;
  for (const k of keys) {
    const s = k.join(" ");
    if (best === null || s < best) best = s;
  }
  return best == null ? "" : best;
}

function stripMeta(m) {
  return { a: m.a, b: m.b, confidence: m.confidence, kind: m.kind };
}

// ---------------------------------------------------------------------------
// Pass 1 & 2: one-to-one pairing
// ---------------------------------------------------------------------------

function pairOneToOne(A, B, matched, { tol, cfg, kind, sameDateOnly }) {
  // Bucket unused B by amount magnitude AND by signed amount so we can find both
  // equal and equal-and-opposite (NSF) partners quickly.
  const bByAmount = new Map(); // signed amount -> array of unused B (sorted)
  for (const w of B) {
    if (w.used) continue;
    if (!bByAmount.has(w.amount)) bByAmount.set(w.amount, []);
    bByAmount.get(w.amount).push(w);
  }

  for (const a of A) {
    if (a.used) continue;

    // Candidate B records: same signed amount (normal) OR equal-and-opposite
    // (NSF reversal). We prefer a same-sign partner; only treat opposite-sign as
    // an NSF reversal, which we label distinctly.
    const sameSign = bByAmount.get(a.amount) || [];
    const oppSign = a.amount !== 0 ? bByAmount.get(-a.amount) || [] : [];

    let chosen = null;
    let chosenIsNsf = false;
    let chosenDiff = Infinity;

    // Helper to scan a candidate list and pick the best (smallest date diff,
    // then highest memo similarity, then stable key) within the window.
    const scan = (cands, isNsf) => {
      for (const b of cands) {
        if (b.used) continue;
        const dd = dayDiff(a.date, b.date);
        if (sameDateOnly && dd !== 0) continue;
        if (!sameDateOnly && dd > tol) continue;
        if (chosen === null) {
          chosen = b;
          chosenIsNsf = isNsf;
          chosenDiff = dd;
          continue;
        }
        // Prefer non-NSF over NSF, then smaller date diff, then stable key.
        const better =
          (chosenIsNsf && !isNsf) ||
          (chosenIsNsf === isNsf && dd < chosenDiff) ||
          (chosenIsNsf === isNsf && dd === chosenDiff && cmpKey(b, chosen) < 0);
        if (better) {
          chosen = b;
          chosenIsNsf = isNsf;
          chosenDiff = dd;
        }
      }
    };

    scan(sameSign, false);
    // Only consider an NSF reversal when no clean same-sign partner was found
    // OR the NSF is strictly closer in date — but a same-sign exact match always
    // wins. We bias toward same-sign by scanning it first and only letting NSF
    // replace it when nothing same-sign qualified.
    if (chosen === null) scan(oppSign, true);

    if (chosen) {
      a.used = true;
      chosen.used = true;
      const memoSim = memoSimilarity(a.memo, chosen.memo);
      const conf = confidenceFor(chosenDiff, tol, memoSim, cfg.memoWeight);
      matched.push({
        a: a.__rec,
        b: chosen.__rec,
        confidence: chosenIsNsf ? Math.min(conf, 0.95) : conf,
        kind: chosenIsNsf ? "nsf-reversal" : kind,
        __akeys: [a.__key],
        __bkeys: [chosen.__key],
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 3: split / batched-deposit pairing
//
// For each unused single record S on the "single" side, search the unused
// records on the other side for a SUBSET whose amounts sum EXACTLY to S.amount
// and that all fall within S's date window. Deterministic subset search bounded
// by cfg.maxSplitParts, candidates pre-filtered to the window and ordered by
// stable key so the FIRST exact-sum subset found is reproducible.
// ---------------------------------------------------------------------------

function pairSplits(single, many, matched, cfg, singleIsA) {
  for (const s of single) {
    if (s.used) continue;
    if (s.amount === 0) continue; // a zero line never needs a multi-part sum

    // Eligible parts: unused, same SIGN as the single (a positive deposit is the
    // sum of positive payments), and within the date window of the single.
    const parts = many
      .filter(
        (w) =>
          !w.used &&
          sameSign(w.amount, s.amount) &&
          dayDiff(s.date, w.date) <= cfg.dateToleranceDays
      )
      .sort(cmpKey);

    // BREADTH guard. findSubsetSum bounds DEPTH (maxSplitParts) but C(n, k)
    // still explodes when the windowed pool n is large — exactly what happens
    // when dozens of same-sign lines cluster on one date. Rather than grind for
    // minutes on a single reconciliation, we decline the brute-force split once
    // the pool exceeds maxSplitCandidates and leave the single as an exception.
    // This is deterministic (pool size is order-independent) and mirrors the
    // maxSplitParts "surface it rather than guess" philosophy. We only skip the
    // SPLIT search; the record still appears in the unmatched output below.
    if (parts.length > cfg.maxSplitCandidates) continue;

    const combo = findSubsetSum(parts, s.amount, cfg.maxSplitParts);
    if (!combo) continue;

    // Commit.
    s.used = true;
    for (const p of combo) p.used = true;

    // Confidence: worst (largest) date gap among parts drives the date
    // component; memo similarity averaged across parts.
    let maxDiff = 0;
    let memoAcc = 0;
    for (const p of combo) {
      maxDiff = Math.max(maxDiff, dayDiff(s.date, p.date));
      memoAcc += memoSimilarity(s.memo, p.memo);
    }
    const memoSim = combo.length ? memoAcc / combo.length : 0;
    const conf = confidenceFor(
      maxDiff,
      cfg.dateToleranceDays,
      memoSim,
      cfg.memoWeight
    );

    const partsRecs = combo.map((p) => p.__rec);
    const partsKeys = combo.map((p) => p.__key);
    matched.push({
      a: singleIsA ? s.__rec : partsRecs,
      b: singleIsA ? partsRecs : s.__rec,
      confidence: Math.round(Math.min(conf, 0.99) * 10000) / 10000,
      kind: "split",
      __akeys: singleIsA ? [s.__key] : partsKeys,
      __bkeys: singleIsA ? partsKeys : [s.__key],
    });
  }
}

function sameSign(x, y) {
  return (x >= 0 && y >= 0) || (x < 0 && y < 0);
}

// Find a subset of `parts` (each {amount}) summing EXACTLY to `target`, using
// 2..maxParts elements, returning the elements or null. Deterministic: explores
// in the stable order `parts` is already sorted in and returns the first hit,
// preferring FEWER parts (shallower combinations) first.
function findSubsetSum(parts, target, maxParts) {
  // We require at least 2 parts — a 1-part "split" is just a one-to-one match
  // that the earlier passes already had their chance at.
  const n = parts.length;
  const cap = Math.min(maxParts, n);

  // Try increasing subset sizes so the smallest valid combination wins.
  for (let size = 2; size <= cap; size++) {
    const pick = new Array(size);
    const res = recurse(0, 0, 0, target);
    if (res) return res;

    // Depth-first choose `size` indices in increasing order summing to target.
    function recurse(start, depth, sum) {
      if (depth === size) {
        return sum === target ? pick.slice() : null;
      }
      const remaining = size - depth;
      for (let i = start; i <= n - remaining; i++) {
        const next = sum + parts[i].amount;
        // Prune: with same-sign positive parts an overshoot can never recover,
        // so skip this index. `parts` is ordered by (date, amount) — not purely
        // by amount — so we `continue` past this candidate rather than `break`
        // out, since a smaller-amount part may still appear at a later index.
        if (target >= 0 && next > target && parts[i].amount > 0) {
          continue;
        }
        // Symmetric prune for negative targets (sum of negative parts).
        if (target < 0 && next < target && parts[i].amount < 0) {
          continue;
        }
        pick[depth] = parts[i];
        const found = recurse(i + 1, depth + 1, next);
        if (found) return found;
      }
      return null;
    }
  }
  return null;
}

module.exports = {
  reconcile,
  MatchError,
  DEFAULTS,
  // exported for focused tests / reuse
  dayDiff,
  memoSimilarity,
  findSubsetSum: (parts, target, maxParts = DEFAULTS.maxSplitParts) =>
    findSubsetSum(
      parts.map((p) => ({ amount: p.amount, __key: [], __idx: 0 })),
      target,
      maxParts
    ),
};

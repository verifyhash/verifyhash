"use strict";

// TrustLedger — valueProof (T-45.1).
//
// A PURE, OFFLINE, DETERMINISTIC read over the gate's ALREADY-COMPUTED verdict
// that converts a pilot. It takes:
//
//   * `model`       — a buildPacket reconciliation packet (it carries the
//                     already-computed `triage` root-cause rollup, `counts`, and
//                     the PASS/FAIL `pass` flag). valueProof CONSUMES that
//                     rollup; it NEVER re-derives, re-classifies, or re-runs the
//                     engine, and it NEVER mutates the model.
//   * `manualClose` — the broker's OWN asserted result for the SAME period: a
//                     manual close they already signed off on. The pilot's
//                     highest-signal input is a month the broker manually
//                     reconciled and called CLEAN, so the assertion we diff
//                     against is `manualClose.assertedClean` (did the manual
//                     process flag ANY out-of-trust / data finding for this
//                     period?). It MAY also carry an OPTIONAL
//                     `assertedNetCents` — the integer-cents net figure the
//                     manual close signed off on — which is ECHOED to annotate
//                     the result and is NEVER used to change a verdict, severity,
//                     count, or the outcome (consistent with this module's
//                     read-only posture).
//
// and returns a structured "what your manual close missed" result — the count +
// total abs-cents dollar impact of every finding the gate produced that the
// manual close did not flag, partitioned by the EXISTING triage root-cause
// classes, PLUS an explicit outcome:
//
//   * "out_of_trust_missed" — the gate found >=1 genuine out-of-trust finding the
//                         manual close called clean. THE WTP CASE: the dollar
//                         figure is the conversion/commingling the manual close
//                         let through.
//   * "data_gap_only"   — the gate found NO out-of-trust finding but COULD NOT
//                         fully reconcile/classify the data (data_completeness
//                         gaps). NOT (yet) evidence the money is gone — a
//                         data-shape gap to fix and re-run, surfaced honestly so
//                         a clean-vs-missed claim is never overstated.
//   * "clean_confirmed" — the gate AGREES with the manual close: no out-of-trust
//                         finding and no data gap. The broker now has a signed,
//                         independent, one-command proof of a clean trust account
//                         to hand their auditor (the recurring-deliverable value).
//
// HONEST LIABILITY POSTURE. valueProof asserts NOTHING the gate did not already
// assert. Every number it reports is read VERBATIM off `model.triage` (the SAME
// rollup the verdict/--json/HTML packet shows); it adds no new severity, no new
// finding, no new verdict, and no new exit-code rule. It is a presentation lens
// for a go-to-market conversation, not a second opinion on the books.
//
// NO new dependency. No fs/http/clock/crypto/random. Order-independent (it folds
// `model.triage.classes`, which reconcile.triage already emits deterministically).

// A dedicated error so a malformed model/assertion is a LOUD, typed failure
// rather than a silent miscount — the same strict-input discipline the rest of
// this core uses.
class ValueProofError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValueProofError";
  }
}

// The three outcomes a value-proof can have. A CLOSED enum: the load-time guard
// below proves every triage root-cause class maps into exactly one of these, so
// a newly-added triage class can never silently fall through to a wrong outcome.
const VALUE_OUTCOME = Object.freeze({
  OUT_OF_TRUST: "out_of_trust_missed",
  DATA_GAP: "data_gap_only",
  CLEAN_CONFIRMED: "clean_confirmed",
});

// The triage root-cause classes, mirrored here as a CLOSED set so this module's
// exhaustiveness guard does not depend on importing reconcile internals (it
// imports the public enum below and asserts the two agree). Keeping the names
// local keeps valueproof.js a pure presentation lens with no engine coupling
// beyond the public triage contract.
const reconcile = require("./reconcile");
const ROOT_CAUSE_CLASS = reconcile.ROOT_CAUSE_CLASS;

// How each triage root-cause class maps to a value-proof outcome WHEN it is the
// MOST-URGENT class present. The outcome is decided by the single highest-urgency
// class the gate found (out_of_trust dominates data_completeness dominates the
// benign review/timing notes), so this table is keyed by that class:
//
//   * out_of_trust      => OUT_OF_TRUST    (a missed genuine shortage)
//   * data_completeness => DATA_GAP        (the tool could not fully reconcile)
//   * needs_review      => CLEAN_CONFIRMED (a benign note; not a missed finding,
//                          not a data gap — the account is not shown out of trust
//                          and the data reconciled)
//   * timing            => CLEAN_CONFIRMED (a self-clearing reconciling item)
//
// Built on a NULL prototype: this is keyed by our own ROOT_CAUSE_CLASS values
// (never untrusted input), but mirrors reconcile's null-proto discipline so a
// stray prototype-name key can never resolve to an inherited garbage outcome.
const OUTCOME_OF_CLASS = Object.freeze(
  Object.assign(Object.create(null), {
    [ROOT_CAUSE_CLASS.OUT_OF_TRUST]: VALUE_OUTCOME.OUT_OF_TRUST,
    [ROOT_CAUSE_CLASS.DATA_COMPLETENESS]: VALUE_OUTCOME.DATA_GAP,
    [ROOT_CAUSE_CLASS.NEEDS_REVIEW]: VALUE_OUTCOME.CLEAN_CONFIRMED,
    [ROOT_CAUSE_CLASS.TIMING]: VALUE_OUTCOME.CLEAN_CONFIRMED,
  })
);

// LOAD-TIME EXHAUSTIVENESS GUARD over the triage classes. Proves, on require:
//   1. EVERY ROOT_CAUSE_CLASS member has an OUTCOME_OF_CLASS mapping (no triage
//      class falls through unclassified into a wrong/undefined outcome), and
//   2. EVERY mapped outcome is a real VALUE_OUTCOME member (no typo'd target).
// Any violation is a BUILD error thrown at module load — so adding a new triage
// class without deciding its value-proof outcome breaks the build, never silently
// mis-buckets a finding in a customer-facing pilot number.
(function assertOutcomeExhaustive() {
  const outcomeValues = new Set(Object.values(VALUE_OUTCOME));
  for (const cls of Object.values(ROOT_CAUSE_CLASS)) {
    if (!Object.prototype.hasOwnProperty.call(OUTCOME_OF_CLASS, cls)) {
      throw new ValueProofError(
        `valueProof: triage root-cause class "${cls}" has no value-proof outcome mapping`
      );
    }
    const outcome = OUTCOME_OF_CLASS[cls];
    if (!outcomeValues.has(outcome)) {
      throw new ValueProofError(
        `valueProof: triage class "${cls}" maps to unknown value outcome "${outcome}"`
      );
    }
  }
})();

// Format integer cents as a dollar string ("$1,234.56") for the headline. Mirrors
// reconcile.fmtCentsForDetail's grouping locally so this module takes NO new
// dependency on report.js. Deterministic; throws on non-integer (no float money).
function fmtCents(cents) {
  if (!Number.isInteger(cents)) {
    throw new ValueProofError("valueProof: dollar impact must be integer cents");
  }
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = `$${grouped}.${String(rem).padStart(2, "0")}`;
  return neg ? `-${body}` : body;
}

// "1 finding" / "2 findings" — a deterministically-pluralized count noun.
function countNoun(n, noun) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// Read + validate the triage rollup carried on the model. We require the model to
// ALREADY carry a `triage` object (buildPacket -> reconcile.triage). valueProof
// does NOT re-run triage: the whole point is that the numbers a pilot reads EQUAL
// the verdict the gate already produced, so a re-derivation that drifted would
// defeat it. A model with no triage is a typed error, not a silent re-compute.
function readTriage(model) {
  if (!model || typeof model !== "object") {
    throw new ValueProofError("valueProof requires a reconciliation model");
  }
  const t = model.triage;
  if (!t || typeof t !== "object" || !Array.isArray(t.classes)) {
    throw new ValueProofError(
      "valueProof requires model.triage (run buildPacket / reconcile.triage first)"
    );
  }
  if (!t.totals || !Number.isInteger(t.totals.count) || !Number.isInteger(t.totals.absImpact)) {
    throw new ValueProofError("valueProof: model.triage.totals must carry integer count/absImpact");
  }
  return t;
}

// Validate the broker's manual-close assertion. The pilot's highest-signal input
// is a period the broker ALREADY closed and signed off as clean, so the assertion
// we diff against is the boolean `assertedClean`. We require it explicitly (no
// defaulting) so a caller can never accidentally diff against an UNSTATED baseline
// and have the result silently read as "clean confirmed".
//
// `assertedNetCents` is OPTIONAL: the integer-cents net figure the manual close
// signed off on. It is ECHOED to ANNOTATE the result only; it NEVER changes the
// outcome, a verdict, a severity, a count, or any dollar number read off triage.
// When present it must be an integer (no float money); a non-integer is a typed
// error, not a silently-coerced figure.
function readManualClose(manualClose) {
  if (!manualClose || typeof manualClose !== "object") {
    throw new ValueProofError("valueProof requires a manualClose assertion object");
  }
  if (typeof manualClose.assertedClean !== "boolean") {
    throw new ValueProofError(
      "valueProof: manualClose.assertedClean must be a boolean (did the manual close flag any finding?)"
    );
  }
  let assertedNetCents = null;
  if (manualClose.assertedNetCents != null) {
    if (!Number.isInteger(manualClose.assertedNetCents)) {
      throw new ValueProofError(
        "valueProof: manualClose.assertedNetCents must be integer cents when provided (no float money)"
      );
    }
    assertedNetCents = manualClose.assertedNetCents;
  }
  return {
    assertedClean: manualClose.assertedClean,
    assertedNetCents,
    period: manualClose.period == null ? null : String(manualClose.period),
  };
}

// valueProof(model, manualClose) — the pure "what your manual close missed" diff.
//
// Returns a NEW object (model is NEVER mutated):
//   {
//     outcome:        "out_of_trust_missed" | "data_gap_only" | "clean_confirmed",
//     period:         <string|null>,        // echoed from manualClose
//     manualCloseClean: <bool>,             // the broker's asserted baseline (assertedClean)
//     assertedNetCents: <int|null>,         // echoed annotation only; never changes a verdict
//     missedFindings: {
//       count:     <int>,                   // == model.triage.totals.count
//       absImpact: <int cents>,             // == model.triage.totals.absImpact
//       byClass:   [ { class, label, count, absImpact }, ... ],  // == triage.classes
//     },
//     outOfTrust:     <bool>,               // == model.triage.outOfTrust
//     dataGap:        <bool>,               // == model.triage.dataIncomplete
//     topClass:       <ROOT_CAUSE_CLASS|null>, // == model.triage.topClass
//     agrees:         <bool>,               // does the gate agree with the close?
//     headline:       <string>,             // ONE sentence for the human
//   }
//
// EVERY count/dollar number is read VERBATIM off model.triage — the function
// classifies the OUTCOME and writes a sentence; it computes no new money figure.
function valueProof(model, manualClose) {
  const t = readTriage(model);
  const mc = readManualClose(manualClose);

  // The per-class rollup, copied VERBATIM from triage (a fresh array of fresh
  // rows so the returned object shares no reference with the model — guaranteeing
  // valueProof cannot mutate the model even via a returned-and-edited row).
  const byClass = t.classes.map((c) => ({
    class: c.class,
    label: c.label,
    count: c.count,
    absImpact: c.absImpact,
  }));

  // Pull the booleans + totals straight off the model's triage. These are the
  // SAME flags the verdict line reads; valueProof never recomputes them.
  const outOfTrust = t.outOfTrust === true;
  const dataGap = t.dataIncomplete === true;
  const topClass = t.topClass == null ? null : t.topClass;
  const count = t.totals.count;
  const absImpact = t.totals.absImpact;

  // The outcome is decided by the MOST-URGENT class the gate found, which is
  // exactly `topClass` (reconcile.triage already rank-sorts classes most-urgent
  // first, so classes[0].class === topClass). When there is no finding at all
  // (topClass === null) the gate found nothing — clean confirmed. Routing
  // through OUTCOME_OF_CLASS (guarded exhaustive above) means a newly-added
  // triage class cannot silently mis-route.
  let outcome;
  if (topClass === null) {
    outcome = VALUE_OUTCOME.CLEAN_CONFIRMED;
  } else {
    const mapped = OUTCOME_OF_CLASS[topClass];
    if (mapped === undefined) {
      // Unreachable for the built-in classes (the load-time guard proves it);
      // defends a forged/hand-built model.triage carrying an unknown topClass.
      throw new ValueProofError(
        `valueProof: triage topClass "${topClass}" has no value-proof outcome`
      );
    }
    outcome = mapped;
  }

  // Does the gate AGREE with the broker's manual close? The manual close asserted
  // CLEAN (assertedClean === true) iff it flagged nothing; the gate agrees when
  // its outcome is clean_confirmed. So agreement is (assertedClean === gateClean).
  const gateClean = outcome === VALUE_OUTCOME.CLEAN_CONFIRMED;
  const agrees = mc.assertedClean === gateClean;

  return {
    outcome,
    period: mc.period,
    manualCloseClean: mc.assertedClean,
    assertedNetCents: mc.assertedNetCents,
    missedFindings: { count, absImpact, byClass },
    outOfTrust,
    dataGap,
    topClass,
    agrees,
    headline: buildHeadline(outcome, mc, byClass, { count, absImpact }),
  };
}

// Build the ONE plain-English sentence the human reads to decide whether to keep
// selling. PURE. It leads with the outcome and quotes ONLY numbers already in the
// triage rollup. The liability posture is honest: a data_gap is NEVER framed as a
// missed shortage, and a clean_confirmed never overstates beyond "the gate agrees."
function buildHeadline(outcome, mc, byClass, totals) {
  const baseline = mc.assertedClean
    ? "Your manual close signed this period off as clean"
    : "Your manual close flagged this period";

  if (outcome === VALUE_OUTCOME.OUT_OF_TRUST) {
    // The most-urgent class is out_of_trust; quote ITS count/impact specifically
    // (the WTP figure), read verbatim from the rollup.
    const row = byClass.find((c) => c.class === ROOT_CAUSE_CLASS.OUT_OF_TRUST);
    const c = row || { count: 0, absImpact: 0 };
    return (
      `${baseline}, but the gate found ${countNoun(c.count, "out-of-trust finding")} ` +
      `totaling ${fmtCents(c.absImpact)} the manual close let through. ` +
      `Restore the trust account before relying on this period.`
    );
  }

  if (outcome === VALUE_OUTCOME.DATA_GAP) {
    const row = byClass.find((c) => c.class === ROOT_CAUSE_CLASS.DATA_COMPLETENESS);
    const c = row || { count: 0, absImpact: 0 };
    return (
      `${baseline}, and the gate found NO out-of-trust finding — but it could not ` +
      `fully reconcile your data (${countNoun(c.count, "item")} totaling ${fmtCents(c.absImpact)}). ` +
      `Resolve these data gaps and re-run; this is not (yet) evidence the money is gone.`
    );
  }

  // clean_confirmed: the gate agrees there is nothing out of trust and the data
  // reconciled. Whether the broker's manual close called it clean (agreement) or
  // flagged it (the gate clears items the broker queued for review) is stated
  // honestly without claiming a missed shortage.
  const noted =
    totals.count > 0
      ? ` ${countNoun(totals.count, "item")} remain as benign review/timing notes for a human to confirm.`
      : "";
  if (mc.assertedClean) {
    return (
      `The gate AGREES with your manual close: no out-of-trust finding and the data ` +
      `reconciled. This is a signed, independent confirmation of a clean trust account.` +
      noted
    );
  }
  return (
    `Your manual close flagged this period, but the gate found nothing out of trust ` +
    `and the data reconciled.` +
    noted
  );
}

module.exports = {
  valueProof,
  ValueProofError,
  VALUE_OUTCOME,
  OUTCOME_OF_CLASS,
};

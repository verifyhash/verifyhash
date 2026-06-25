"use strict";

const { expect } = require("chai");

const {
  valueProof,
  ValueProofError,
  VALUE_OUTCOME,
  OUTCOME_OF_CLASS,
} = require("../trustledger/valueproof");

const {
  reconcile,
  triage,
  EXCEPTION,
  SEVERITY,
  ROOT_CAUSE_CLASS,
} = require("../trustledger/reconcile");

const { buildPacket } = require("../trustledger/report");

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

// A minimal classified exception, the shape triage consumes.
function ex(type, amount, severity) {
  return { type, severity, amount, label: "", detail: "", records: [] };
}

// A model carrying a REAL triage rollup over the given exceptions — exactly what
// buildPacket produces (model.triage = reconcile.triage({ exceptions })). Using
// the real triage (not a hand-rolled object) is the whole point: valueProof must
// read THOSE numbers verbatim.
function modelWithTriage(exceptions) {
  return { exceptions, triage: triage({ exceptions }) };
}

function classRow(byClass, cls) {
  return byClass.find((c) => c.class === cls);
}

// A normalized record mirroring ingest.js shape (for the end-to-end buildPacket test).
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

// ---------------------------------------------------------------------------

describe("T-45.1 trustledger/valueproof: valueProof diffs the gate against a manual close", function () {
  describe("load-time exhaustiveness guard over the triage classes", function () {
    it("the module loaded: requiring it did not throw (the guard already ran)", function () {
      expect(typeof valueProof).to.equal("function");
    });

    it("EVERY triage ROOT_CAUSE_CLASS maps to a real VALUE_OUTCOME (no fall-through)", function () {
      const outcomes = new Set(Object.values(VALUE_OUTCOME));
      for (const cls of Object.values(ROOT_CAUSE_CLASS)) {
        expect(
          Object.prototype.hasOwnProperty.call(OUTCOME_OF_CLASS, cls),
          `class ${cls} has an outcome mapping`
        ).to.equal(true);
        expect(outcomes.has(OUTCOME_OF_CLASS[cls]), `class ${cls} -> known outcome`).to.equal(true);
      }
      // The closed outcome set is exactly these three. These STRINGS are the
      // machine contract T-45.2 switches exit codes on and T-45.3 prints into
      // customer docs verbatim, so pin them explicitly.
      expect([...outcomes].sort()).to.deep.equal([
        "clean_confirmed",
        "data_gap_only",
        "out_of_trust_missed",
      ]);
      expect(VALUE_OUTCOME.OUT_OF_TRUST).to.equal("out_of_trust_missed");
      expect(VALUE_OUTCOME.DATA_GAP).to.equal("data_gap_only");
      expect(VALUE_OUTCOME.CLEAN_CONFIRMED).to.equal("clean_confirmed");
    });
  });

  describe("classification: out-of-trust vs data-gap vs clean-confirmed", function () {
    it("OUT-OF-TRUST: a missed genuine shortage the manual close called clean", function () {
      const model = modelWithTriage([
        ex(EXCEPTION.NEGATIVE_TENANT_LEDGER, -50000, SEVERITY.ERROR),
      ]);
      const vp = valueProof(model, { assertedClean: true, period: "2026-05" });

      expect(vp.outcome).to.equal(VALUE_OUTCOME.OUT_OF_TRUST);
      // Pin the literal contract string (what T-45.2 switches exit codes on).
      expect(vp.outcome).to.equal("out_of_trust_missed");
      expect(vp.outOfTrust).to.equal(true);
      expect(vp.dataGap).to.equal(false);
      expect(vp.topClass).to.equal(ROOT_CAUSE_CLASS.OUT_OF_TRUST);
      // The manual close said clean; the gate disagrees => no agreement.
      expect(vp.manualCloseClean).to.equal(true);
      expect(vp.agrees).to.equal(false);
      expect(vp.period).to.equal("2026-05");
      // Headline quotes the out-of-trust dollar figure ($500.00) — the WTP case.
      expect(vp.headline).to.include("$500.00");
      expect(vp.headline).to.match(/out-of-trust/i);
    });

    it("DATA-GAP: NO out-of-trust finding but the gate could not fully reconcile", function () {
      // A bank-OVER mismatch (amount >= 0) is a benign unrecorded-deposit data item.
      const model = modelWithTriage([
        ex(EXCEPTION.BANK_BOOK_MISMATCH, 125000, SEVERITY.ERROR),
      ]);
      const vp = valueProof(model, { assertedClean: true });

      expect(vp.outcome).to.equal(VALUE_OUTCOME.DATA_GAP);
      // Pin the literal contract string (the distinct fix-and-rerun exit code).
      expect(vp.outcome).to.equal("data_gap_only");
      expect(vp.outOfTrust).to.equal(false);
      expect(vp.dataGap).to.equal(true);
      expect(vp.topClass).to.equal(ROOT_CAUSE_CLASS.DATA_COMPLETENESS);
      // The honest posture: a data gap is NEVER framed as a missed shortage. The
      // headline explicitly says NO out-of-trust finding and never claims a count
      // of out-of-trust findings the close "let through".
      expect(vp.headline).to.match(/not \(yet\) evidence the money is gone/i);
      expect(vp.headline).to.match(/NO out-of-trust finding/i);
      expect(vp.headline).to.not.match(/let through/i);
      // It is a disagreement (manual close clean, gate found a blocking gap).
      expect(vp.agrees).to.equal(false);
    });

    it("CLEAN-CONFIRMED: the gate agrees with a clean manual close (no findings)", function () {
      const model = modelWithTriage([]);
      const vp = valueProof(model, { assertedClean: true });

      expect(vp.outcome).to.equal(VALUE_OUTCOME.CLEAN_CONFIRMED);
      expect(vp.outOfTrust).to.equal(false);
      expect(vp.dataGap).to.equal(false);
      expect(vp.topClass).to.equal(null);
      expect(vp.agrees).to.equal(true);
      expect(vp.missedFindings.count).to.equal(0);
      expect(vp.missedFindings.absImpact).to.equal(0);
      expect(vp.missedFindings.byClass).to.have.length(0);
      expect(vp.headline).to.match(/agrees with your manual close/i);
    });

    it("CLEAN-CONFIRMED: only benign review/timing notes still confirms clean", function () {
      // An owner draw (needs_review) + an outstanding check (timing): neither is
      // out-of-trust nor a data gap, so the gate confirms the account is not shown
      // out of trust even though there are items to eyeball.
      const model = modelWithTriage([
        ex(EXCEPTION.OWNER_DRAW, -10000, SEVERITY.WARNING),
        ex(EXCEPTION.OUTSTANDING_CHECK, -20000, SEVERITY.INFO),
      ]);
      const vp = valueProof(model, { assertedClean: true });

      expect(vp.outcome).to.equal(VALUE_OUTCOME.CLEAN_CONFIRMED);
      expect(vp.outOfTrust).to.equal(false);
      expect(vp.dataGap).to.equal(false);
      expect(vp.agrees).to.equal(true);
      // The notes are surfaced honestly as review/timing, not as a missed finding.
      expect(vp.headline).to.match(/review\/timing notes/i);
    });

    it("OUT-OF-TRUST dominates even when data gaps also exist (priority, not blur)", function () {
      const model = modelWithTriage([
        ex(EXCEPTION.SUBLEDGER_OUT_OF_BALANCE, -30000, SEVERITY.ERROR), // out_of_trust
        ex(EXCEPTION.AMBIGUOUS_DEPOSIT, 40000, SEVERITY.WARNING), // data_completeness
      ]);
      const vp = valueProof(model, { assertedClean: true });

      expect(vp.outcome).to.equal(VALUE_OUTCOME.OUT_OF_TRUST);
      expect(vp.outOfTrust).to.equal(true);
      expect(vp.dataGap).to.equal(true); // the data gap is reported...
      expect(vp.topClass).to.equal(ROOT_CAUSE_CLASS.OUT_OF_TRUST); // ...but does not lead
      // Headline leads with the out-of-trust dollar figure ($300.00), not the data item.
      expect(vp.headline).to.include("$300.00");
    });
  });

  describe("the broker's manual-close baseline drives `agrees`, never a verdict", function () {
    it("a manual close that FLAGGED the period agrees when the gate finds out-of-trust", function () {
      const model = modelWithTriage([
        ex(EXCEPTION.NEGATIVE_TENANT_LEDGER, -50000, SEVERITY.ERROR),
      ]);
      const clean = valueProof(model, { assertedClean: true });
      const flagged = valueProof(model, { assertedClean: false });

      // SAME gate outcome regardless of the manual-close baseline...
      expect(clean.outcome).to.equal(VALUE_OUTCOME.OUT_OF_TRUST);
      expect(flagged.outcome).to.equal(VALUE_OUTCOME.OUT_OF_TRUST);
      expect(clean.missedFindings).to.deep.equal(flagged.missedFindings);
      // ...only `agrees` flips: a manual close that ALSO flagged it agrees.
      expect(clean.agrees).to.equal(false);
      expect(flagged.agrees).to.equal(true);
    });

    it("a manual close that FLAGGED a clean period does NOT agree (false alarm)", function () {
      const model = modelWithTriage([]);
      const vp = valueProof(model, { assertedClean: false });
      expect(vp.outcome).to.equal(VALUE_OUTCOME.CLEAN_CONFIRMED);
      expect(vp.agrees).to.equal(false);
      expect(vp.headline).to.match(/the gate found nothing out of trust/i);
    });

    it("the optional assertedNetCents is ECHOED and NEVER changes a verdict/number", function () {
      const model = modelWithTriage([
        ex(EXCEPTION.NEGATIVE_TENANT_LEDGER, -50000, SEVERITY.ERROR),
      ]);
      const without = valueProof(model, { assertedClean: true });
      const withNet = valueProof(model, { assertedClean: true, assertedNetCents: 9999999 });

      // The annotation is echoed verbatim (null when absent, the integer when present).
      expect(without.assertedNetCents).to.equal(null);
      expect(withNet.assertedNetCents).to.equal(9999999);
      // ...but it changes NOTHING the gate computed: outcome, every triage number,
      // the agreement flag, and the headline are identical with or without it.
      expect(withNet.outcome).to.equal(without.outcome);
      expect(withNet.missedFindings).to.deep.equal(without.missedFindings);
      expect(withNet.agrees).to.equal(without.agrees);
      expect(withNet.headline).to.equal(without.headline);
      // A zero net is a meaningful, distinct annotation from "unstated" (null).
      const zero = valueProof(model, { assertedClean: true, assertedNetCents: 0 });
      expect(zero.assertedNetCents).to.equal(0);
    });
  });

  describe("numbers EQUAL model.triage verbatim", function () {
    it("count, absImpact, and every byClass row match model.triage exactly", function () {
      const model = modelWithTriage([
        ex(EXCEPTION.NEGATIVE_TENANT_LEDGER, -50000, SEVERITY.ERROR),
        ex(EXCEPTION.OWNER_OVERDRAW, -25000, SEVERITY.ERROR),
        ex(EXCEPTION.AMBIGUOUS_DEPOSIT, 40000, SEVERITY.WARNING),
        ex(EXCEPTION.OUTSTANDING_CHECK, -20000, SEVERITY.INFO),
      ]);
      const t = model.triage;
      const vp = valueProof(model, { assertedClean: true });

      expect(vp.missedFindings.count).to.equal(t.totals.count);
      expect(vp.missedFindings.absImpact).to.equal(t.totals.absImpact);
      // byClass mirrors triage.classes exactly (same order, same numbers).
      expect(vp.missedFindings.byClass).to.deep.equal(
        t.classes.map((c) => ({
          class: c.class,
          label: c.label,
          count: c.count,
          absImpact: c.absImpact,
        }))
      );
      // The booleans + topClass are read straight off triage.
      expect(vp.outOfTrust).to.equal(t.outOfTrust);
      expect(vp.dataGap).to.equal(t.dataIncomplete);
      expect(vp.topClass).to.equal(t.topClass);
    });

    it("the out-of-trust row impact in the headline equals triage's class absImpact", function () {
      const model = modelWithTriage([
        ex(EXCEPTION.NEGATIVE_TENANT_LEDGER, -50000, SEVERITY.ERROR),
        ex(EXCEPTION.OWNER_OVERDRAW, -25000, SEVERITY.ERROR),
      ]);
      const oot = classRow(
        valueProof(model, { assertedClean: true }).missedFindings.byClass,
        ROOT_CAUSE_CLASS.OUT_OF_TRUST
      );
      // $750.00 = $500 + $250, the summed out-of-trust impact triage reports.
      expect(oot.absImpact).to.equal(75000);
      expect(valueProof(model, { assertedClean: true }).headline).to.include("$750.00");
    });
  });

  describe("purity: never mutates the model, deterministic, offline", function () {
    it("does NOT mutate the model or its triage rollup", function () {
      const model = modelWithTriage([
        ex(EXCEPTION.NEGATIVE_TENANT_LEDGER, -50000, SEVERITY.ERROR),
      ]);
      const before = JSON.stringify(model);
      valueProof(model, { assertedClean: true });
      expect(JSON.stringify(model)).to.equal(before);
    });

    it("returns a byClass array that shares no reference with model.triage.classes", function () {
      const model = modelWithTriage([
        ex(EXCEPTION.NEGATIVE_TENANT_LEDGER, -50000, SEVERITY.ERROR),
      ]);
      const vp = valueProof(model, { assertedClean: true });
      // Mutating the returned rollup must not touch the model's triage.
      vp.missedFindings.byClass[0].absImpact = 999999;
      vp.missedFindings.byClass.push({ class: "x" });
      expect(model.triage.classes[0].absImpact).to.equal(50000);
      expect(model.triage.classes).to.have.length(1);
    });

    it("is deterministic: same inputs => deeply equal output across calls", function () {
      const model = modelWithTriage([
        ex(EXCEPTION.SUBLEDGER_OUT_OF_BALANCE, -30000, SEVERITY.ERROR),
        ex(EXCEPTION.AMBIGUOUS_DEPOSIT, 40000, SEVERITY.WARNING),
      ]);
      const a = valueProof(model, { assertedClean: true, period: "2026-05" });
      const b = valueProof(model, { assertedClean: true, period: "2026-05" });
      expect(a).to.deep.equal(b);
    });

    it("is order-independent: shuffling the exceptions yields the same numbers", function () {
      const a = modelWithTriage([
        ex(EXCEPTION.NEGATIVE_TENANT_LEDGER, -50000, SEVERITY.ERROR),
        ex(EXCEPTION.AMBIGUOUS_DEPOSIT, 40000, SEVERITY.WARNING),
        ex(EXCEPTION.OUTSTANDING_CHECK, -20000, SEVERITY.INFO),
      ]);
      const b = modelWithTriage([
        ex(EXCEPTION.OUTSTANDING_CHECK, -20000, SEVERITY.INFO),
        ex(EXCEPTION.AMBIGUOUS_DEPOSIT, 40000, SEVERITY.WARNING),
        ex(EXCEPTION.NEGATIVE_TENANT_LEDGER, -50000, SEVERITY.ERROR),
      ]);
      const va = valueProof(a, { assertedClean: true });
      const vb = valueProof(b, { assertedClean: true });
      expect(va.outcome).to.equal(vb.outcome);
      expect(va.missedFindings).to.deep.equal(vb.missedFindings);
    });
  });

  describe("strict input validation (typed errors, no silent miscount)", function () {
    it("rejects a model with no triage rollup", function () {
      expect(() => valueProof({ exceptions: [] }, { assertedClean: true })).to.throw(
        ValueProofError,
        /model\.triage/
      );
    });

    it("rejects a missing / non-object model", function () {
      expect(() => valueProof(null, { assertedClean: true })).to.throw(ValueProofError);
      expect(() => valueProof(undefined, { assertedClean: true })).to.throw(ValueProofError);
    });

    it("rejects a missing manualClose assertion", function () {
      const model = modelWithTriage([]);
      expect(() => valueProof(model, null)).to.throw(ValueProofError, /manualClose/);
    });

    it("rejects a manualClose without an explicit boolean `assertedClean` (no silent default)", function () {
      const model = modelWithTriage([]);
      expect(() => valueProof(model, {})).to.throw(ValueProofError, /assertedClean/);
      expect(() => valueProof(model, { assertedClean: "yes" })).to.throw(
        ValueProofError,
        /assertedClean/
      );
      // The OLD field name is no longer accepted as the baseline: passing only
      // `clean` leaves `assertedClean` unstated and is rejected (no silent default).
      expect(() => valueProof(model, { clean: true })).to.throw(
        ValueProofError,
        /assertedClean/
      );
    });

    it("rejects a non-integer assertedNetCents annotation (no float money)", function () {
      const model = modelWithTriage([]);
      expect(() =>
        valueProof(model, { assertedClean: true, assertedNetCents: 1234.56 })
      ).to.throw(ValueProofError, /integer/);
      expect(() =>
        valueProof(model, { assertedClean: true, assertedNetCents: "100" })
      ).to.throw(ValueProofError, /integer/);
    });

    it("rejects a triage rollup with non-integer totals", function () {
      const model = {
        exceptions: [],
        triage: { classes: [], totals: { count: 1.5, absImpact: 100 } },
      };
      expect(() => valueProof(model, { assertedClean: true })).to.throw(ValueProofError, /integer/);
    });

    it("rejects a forged triage topClass with no known outcome", function () {
      const model = {
        exceptions: [],
        triage: {
          classes: [{ class: "bogus_class", label: "x", count: 1, absImpact: 100 }],
          totals: { count: 1, absImpact: 100 },
          outOfTrust: false,
          dataIncomplete: false,
          topClass: "bogus_class",
        },
      };
      expect(() => valueProof(model, { assertedClean: true })).to.throw(
        ValueProofError,
        /no value-proof outcome/
      );
    });
  });

  describe("end-to-end over a REAL buildPacket model (not a hand-built triage)", function () {
    it("a real out-of-trust reconciliation produces an OUT-OF-TRUST value proof", function () {
      // A negative individual tenant ledger: $1,500 collected for Smith, $2,000
      // refunded — Smith's sub-ledger goes negative => out-of-trust.
      const bank = [rec("2026-05-01", 150000, "deposit")];
      const book = [rec("2026-05-01", 150000, "rent received")];
      const rentroll = [
        rec("2026-05-01", 150000, "rent", { party: "Smith (4A)" }),
        rec("2026-05-10", -200000, "refund", { party: "Smith (4A)" }),
      ];
      const model = buildPacket({ bank, book, rentroll, reportDate: "2026-05-31" });
      // Sanity: the gate itself FAILed and carries a triage rollup.
      expect(model.pass).to.equal(false);
      expect(model.triage).to.be.an("object");

      const vp = valueProof(model, { assertedClean: true, period: "2026-05" });
      expect(vp.outcome).to.equal(VALUE_OUTCOME.OUT_OF_TRUST);
      expect(vp.outOfTrust).to.equal(true);
      // Numbers equal the packet's own triage verbatim.
      expect(vp.missedFindings.count).to.equal(model.triage.totals.count);
      expect(vp.missedFindings.absImpact).to.equal(model.triage.totals.absImpact);
      // valueProof did not change the packet's verdict / counts.
      expect(model.pass).to.equal(false);
    });

    it("a real clean reconciliation produces a CLEAN-CONFIRMED value proof", function () {
      const bank = [rec("2026-05-01", 150000, "deposit")];
      const book = [rec("2026-05-01", 150000, "rent received")];
      const rentroll = [rec("2026-05-01", 150000, "rent", { party: "Smith (4A)" })];
      const model = buildPacket({ bank, book, rentroll, reportDate: "2026-05-31" });
      expect(model.pass).to.equal(true);

      const vp = valueProof(model, { assertedClean: true });
      expect(vp.outcome).to.equal(VALUE_OUTCOME.CLEAN_CONFIRMED);
      expect(vp.agrees).to.equal(true);
      expect(vp.headline).to.match(/agrees with your manual close/i);
    });
  });
});

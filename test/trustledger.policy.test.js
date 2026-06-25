"use strict";

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const {
  EXCEPTION,
  SEVERITY,
  DEFAULT_SEVERITY,
} = require("../trustledger/reconcile");

const {
  SCHEMA_VERSION,
  PolicyError,
  readPolicy,
  validatePolicy,
  applyPolicy,
} = require("../trustledger/policy");

const FIX = path.join(__dirname, "..", "trustledger", "fixtures", "policy");

function readFixture(name) {
  return fs.readFileSync(path.join(FIX, name), "utf8");
}

// A minimal, well-formed policy object for mutation in rejection tests.
function goodPolicy(overrides = {}) {
  return Object.assign(
    {
      schemaVersion: SCHEMA_VERSION,
      state: "Testlandia",
      severities: { [EXCEPTION.NSF_REVERSAL]: SEVERITY.ERROR },
    },
    overrides
  );
}

// Build a synthetic reconcile-shaped result carrying one exception of every
// known type at its DEFAULT_SEVERITY, so we can assert applyPolicy precisely.
function syntheticResult() {
  const exceptions = Object.values(EXCEPTION).map((type, i) => ({
    type,
    severity: DEFAULT_SEVERITY[type],
    amount: (i + 1) * 100,
    label: `label for ${type}`,
    detail: `detail for ${type}`,
    records: [{ date: "2026-01-01", amount: (i + 1) * 100, memo: type }],
  }));
  return {
    balances: { bank: 1, book: 1, subledger: 1, adjustedBank: 1, reconciled: 1 },
    tiesOut: true,
    exceptions,
  };
}

describe("trustledger/policy: validatePolicy / readPolicy", function () {
  it("round-trips a well-formed policy object", function () {
    const p = validatePolicy(goodPolicy());
    expect(p.schemaVersion).to.equal(SCHEMA_VERSION);
    expect(p.state).to.equal("Testlandia");
    expect(p.severities[EXCEPTION.NSF_REVERSAL]).to.equal(SEVERITY.ERROR);
  });

  it("readPolicy parses a JSON string and validates it", function () {
    const p = readPolicy(JSON.stringify(goodPolicy()));
    expect(p.severities[EXCEPTION.NSF_REVERSAL]).to.equal(SEVERITY.ERROR);
  });

  it("readPolicy round-trips the baseline fixture and the canonical JSON is stable", function () {
    const p1 = readPolicy(readFixture("baseline.json"));
    // Re-serialize the validated (canonical) object and re-read: byte-identical.
    const json = JSON.stringify(p1);
    const p2 = readPolicy(json);
    expect(JSON.stringify(p2)).to.equal(json);
  });

  it("does not mutate the input object", function () {
    const input = goodPolicy();
    const frozenSnapshot = JSON.stringify(input);
    validatePolicy(input);
    expect(JSON.stringify(input)).to.equal(frozenSnapshot);
  });

  it("emits severities in deterministic (sorted) key order regardless of input order", function () {
    const a = validatePolicy(
      goodPolicy({
        severities: {
          [EXCEPTION.OWNER_DRAW]: SEVERITY.ERROR,
          [EXCEPTION.NSF_REVERSAL]: SEVERITY.ERROR,
        },
      })
    );
    const b = validatePolicy(
      goodPolicy({
        severities: {
          [EXCEPTION.NSF_REVERSAL]: SEVERITY.ERROR,
          [EXCEPTION.OWNER_DRAW]: SEVERITY.ERROR,
        },
      })
    );
    expect(JSON.stringify(a.severities)).to.equal(JSON.stringify(b.severities));
  });

  // ---- rejection branches --------------------------------------------------

  it("rejects a non-object policy", function () {
    expect(() => validatePolicy(null)).to.throw(PolicyError, /must be a JSON object/);
    expect(() => validatePolicy([])).to.throw(PolicyError, /must be a JSON object/);
    expect(() => validatePolicy(42)).to.throw(PolicyError, /must be a JSON object/);
  });

  it("rejects invalid JSON text", function () {
    expect(() => readPolicy("{ not json ")).to.throw(PolicyError, /not valid JSON/);
  });

  it("rejects a wrong schemaVersion", function () {
    expect(() => validatePolicy(goodPolicy({ schemaVersion: 0 }))).to.throw(
      PolicyError,
      /unsupported policy schemaVersion/
    );
    expect(() => validatePolicy(goodPolicy({ schemaVersion: "1" }))).to.throw(
      PolicyError,
      /unsupported policy schemaVersion/
    );
    const noVer = goodPolicy();
    delete noVer.schemaVersion;
    expect(() => validatePolicy(noVer)).to.throw(PolicyError, /missing required field: schemaVersion/);
  });

  it("rejects a missing/empty state label", function () {
    expect(() => validatePolicy(goodPolicy({ state: "" }))).to.throw(PolicyError, /state/);
    expect(() => validatePolicy(goodPolicy({ state: "   " }))).to.throw(PolicyError, /state/);
    const noState = goodPolicy();
    delete noState.state;
    expect(() => validatePolicy(noState)).to.throw(PolicyError, /state/);
  });

  it("rejects an unknown exception type key in severities", function () {
    expect(() =>
      validatePolicy(
        goodPolicy({ severities: { not_a_real_type: SEVERITY.ERROR } })
      )
    ).to.throw(PolicyError, /unknown exception type/);
  });

  it("rejects a severity value not in {info,warning,error}", function () {
    expect(() =>
      validatePolicy(
        goodPolicy({ severities: { [EXCEPTION.NSF_REVERSAL]: "critical" } })
      )
    ).to.throw(PolicyError, /invalid severity/);
    expect(() =>
      validatePolicy(
        goodPolicy({ severities: { [EXCEPTION.NSF_REVERSAL]: 2 } })
      )
    ).to.throw(PolicyError, /invalid severity/);
  });

  it("rejects a missing or non-object severities map", function () {
    const noSev = goodPolicy();
    delete noSev.severities;
    expect(() => validatePolicy(noSev)).to.throw(PolicyError, /missing required field: severities/);
    expect(() => validatePolicy(goodPolicy({ severities: [] }))).to.throw(
      PolicyError,
      /severities must be an object map/
    );
  });

  it("rejects a malformed toleranceCents", function () {
    expect(() => validatePolicy(goodPolicy({ toleranceCents: 1.5 }))).to.throw(
      PolicyError,
      /toleranceCents/
    );
    expect(() => validatePolicy(goodPolicy({ toleranceCents: -100 }))).to.throw(
      PolicyError,
      /toleranceCents/
    );
    expect(() => validatePolicy(goodPolicy({ toleranceCents: "100" }))).to.throw(
      PolicyError,
      /toleranceCents/
    );
  });

  it("accepts a valid non-negative integer toleranceCents", function () {
    const p = validatePolicy(goodPolicy({ toleranceCents: 0 }));
    expect(p.toleranceCents).to.equal(0);
    const p2 = validatePolicy(goodPolicy({ toleranceCents: 250 }));
    expect(p2.toleranceCents).to.equal(250);
  });

  it("rejects a citation for an unknown type or for a type without an override", function () {
    expect(() =>
      validatePolicy(goodPolicy({ citations: { not_a_real_type: "x" } }))
    ).to.throw(PolicyError, /unknown exception type/);
    expect(() =>
      validatePolicy(goodPolicy({ citations: { [EXCEPTION.OWNER_DRAW]: "x" } }))
    ).to.throw(PolicyError, /no severity override/);
  });

  it("rejects an empty/non-string citation", function () {
    expect(() =>
      validatePolicy(goodPolicy({ citations: { [EXCEPTION.NSF_REVERSAL]: "" } }))
    ).to.throw(PolicyError, /citations/);
    expect(() =>
      validatePolicy(goodPolicy({ citations: { [EXCEPTION.NSF_REVERSAL]: 5 } }))
    ).to.throw(PolicyError, /citations/);
  });
});

describe("trustledger/policy: applyPolicy", function () {
  it("returns the input UNCHANGED (same reference) when policy is null/undefined", function () {
    const r = syntheticResult();
    expect(applyPolicy(r, null)).to.equal(r);
    expect(applyPolicy(r, undefined)).to.equal(r);
  });

  it("with the BASELINE fixture leaves every severity equal to the hard-coded DEFAULT_SEVERITY", function () {
    const policy = readPolicy(readFixture("baseline.json"));
    const before = syntheticResult();
    const after = applyPolicy(before, policy);
    for (const ex of after.exceptions) {
      expect(ex.severity).to.equal(
        DEFAULT_SEVERITY[ex.type],
        `severity for ${ex.type}`
      );
    }
    // And the per-exception severities match the pre-policy result exactly
    // (matched BY TYPE — applyPolicy re-sorts errors-first, so positions move
    // even when, as here, no severity actually changes).
    const beforeSev = before.exceptions
      .map((e) => `${e.type}=${e.severity}`)
      .sort();
    const afterSev = after.exceptions.map((e) => `${e.type}=${e.severity}`).sort();
    expect(afterSev).to.deep.equal(beforeSev);
  });

  it("the OVERRIDE fixture flips exactly the targeted type and nothing else", function () {
    const policy = readPolicy(readFixture("ca-example.json"));
    const before = syntheticResult();
    const after = applyPolicy(before, policy);

    for (const ex of after.exceptions) {
      if (ex.type === EXCEPTION.NSF_REVERSAL) {
        expect(ex.severity).to.equal(SEVERITY.ERROR);
      } else {
        // Every other type keeps its default severity untouched.
        expect(ex.severity).to.equal(DEFAULT_SEVERITY[ex.type]);
      }
    }
    // The default for NSF_REVERSAL is WARNING, so this is a real flip.
    expect(DEFAULT_SEVERITY[EXCEPTION.NSF_REVERSAL]).to.equal(SEVERITY.WARNING);
  });

  it("carries the citation through onto the overridden exception only", function () {
    const policy = readPolicy(readFixture("ca-example.json"));
    const after = applyPolicy(syntheticResult(), policy);
    for (const ex of after.exceptions) {
      if (ex.type === EXCEPTION.NSF_REVERSAL) {
        expect(ex.citation).to.be.a("string").and.match(/PLACEHOLDER/);
      } else {
        expect(ex).to.not.have.property("citation");
      }
    }
  });

  it("leaves records, amounts, labels, details, and balances untouched", function () {
    const policy = readPolicy(readFixture("ca-example.json"));
    const before = syntheticResult();
    const after = applyPolicy(before, policy);
    expect(after.balances).to.deep.equal(before.balances);
    expect(after.tiesOut).to.equal(before.tiesOut);
    // applyPolicy re-sorts the exceptions under the new severities (a
    // freshly-escalated ERROR rises to the top), so match the before/after rows
    // BY TYPE rather than by position. Every field except severity/citation is
    // carried through verbatim.
    const beforeByType = new Map(before.exceptions.map((e) => [e.type, e]));
    expect(after.exceptions.length).to.equal(before.exceptions.length);
    for (const a of after.exceptions) {
      const b = beforeByType.get(a.type);
      expect(b, `before row for ${a.type}`).to.be.an("object");
      expect(a.amount).to.equal(b.amount);
      expect(a.label).to.equal(b.label);
      expect(a.detail).to.equal(b.detail);
      expect(a.records).to.deep.equal(b.records);
    }
  });

  it("re-sorts errors-first after escalation: a freshly-escalated ERROR rises to the top", function () {
    // The ca-example policy escalates NSF_REVERSAL (default WARNING) to ERROR.
    // In syntheticResult the exceptions are in EXCEPTION-declaration order (NOT
    // severity order), so before applyPolicy the nsf_reversal row is NOT first.
    const policy = readPolicy(readFixture("ca-example.json"));
    const after = applyPolicy(syntheticResult(), policy);
    // Every error-severity row precedes every non-error row (stable, errors
    // first), and the escalated nsf_reversal is among the leading errors.
    const sevRank = { error: 0, warning: 1, info: 2 };
    for (let i = 1; i < after.exceptions.length; i++) {
      expect(
        sevRank[after.exceptions[i - 1].severity]
      ).to.be.at.most(sevRank[after.exceptions[i].severity]);
    }
    const firstNonError = after.exceptions.findIndex((e) => e.severity !== "error");
    const nsfIndex = after.exceptions.findIndex((e) => e.type === EXCEPTION.NSF_REVERSAL);
    expect(after.exceptions[nsfIndex].severity).to.equal(SEVERITY.ERROR);
    // nsf_reversal sits within the leading error block (before the first
    // non-error row), i.e. it is no longer buried below lower-severity rows.
    expect(nsfIndex).to.be.below(firstNonError === -1 ? after.exceptions.length : firstNonError);
  });

  it("a policy toleranceCents is carried on the validated policy for buildPacket to apply", function () {
    // The knob is no longer inert: validatePolicy stores it AND report.buildPacket
    // applies it (proven in the e2e/CLI suite). Here we just assert it survives
    // validation as an integer the downstream can read.
    const policy = validatePolicy(goodPolicy({ toleranceCents: 500 }));
    expect(policy.toleranceCents).to.equal(500);
  });

  it("is side-effect-free: the input result is not mutated", function () {
    const policy = readPolicy(readFixture("ca-example.json"));
    const before = syntheticResult();
    const snapshot = JSON.stringify(before);
    applyPolicy(before, policy);
    expect(JSON.stringify(before)).to.equal(snapshot);
  });

  it("is deterministic: two applications produce byte-identical output", function () {
    const policy = readPolicy(readFixture("ca-example.json"));
    const r = syntheticResult();
    expect(JSON.stringify(applyPolicy(r, policy))).to.equal(
      JSON.stringify(applyPolicy(r, policy))
    );
  });

  it("rejects a malformed policy or a non-reconcile-shaped result", function () {
    expect(() => applyPolicy(syntheticResult(), { severities: null })).to.throw(
      PolicyError,
      /validated policy/
    );
    expect(() => applyPolicy({}, validatePolicy(goodPolicy()))).to.throw(
      PolicyError,
      /exceptions array/
    );
  });
});

describe("T-40.2 trustledger/policy: segregation verdict/exit-code flow through report, named beneficiary survives policy", function () {
  const report = require("../trustledger/report");
  const { reconcile: matchReconcile } = require("../trustledger/match");

  function rec(date, amount, memo, extra = {}) {
    return {
      date,
      amount,
      memo,
      kind: extra.kind || "other",
      party: extra.party || "",
      source: extra.source || "quickbooks",
    };
  }
  function secDeposit(date, amountCents, party) {
    return rec(date, Math.abs(amountCents), `Security deposit - ${party}`, {
      kind: "deposit",
      party,
    });
  }
  function segTransfer(date, amountCents, party) {
    return rec(date, -Math.abs(amountCents), "Transfer security deposit to escrow", {
      kind: "transfer",
      party,
    });
  }

  // CASE B: Jones over-segregates $2000 against a $1000 deposit; Smith segregates
  // NOTHING against a $1000 deposit. Per-beneficiary matching flags Smith — and
  // the verdict must FAIL through the WHOLE report path (the formerly-false-PASS).
  function caseBBook() {
    return [
      secDeposit("2026-05-01", 100000, "Jones (4B)"),
      secDeposit("2026-05-01", 100000, "Smith (4A)"),
      segTransfer("2026-05-02", 200000, "Jones (4B)"),
    ];
  }
  // A rent roll that ties out arithmetically (book == sub-ledger), so the ONLY
  // thing that can fail the verdict is the out-of-trust segregation ERROR — this
  // isolates the verdict to the finding under test (not a balance mismatch).
  // The CASE B book nets to $0 ($1000 + $1000 deposits - $2000 transfer out), so
  // the sub-ledger must net to $0 too: Jones +$1000, Smith +$1000, and the
  // segregated/escrow account holding the -$2000 that left the operating pool.
  const caseBRent = [
    rec("2026-05-01", 100000, "rent", { kind: "rent", party: "Jones (4B)" }),
    rec("2026-05-01", 100000, "rent", { kind: "rent", party: "Smith (4A)" }),
    rec("2026-05-02", -200000, "segregated escrow", { kind: "rent", party: "Escrow" }),
  ];

  it("CASE B FAILs through report.buildPacket: pass=false, an ERROR, and the row NAMES Smith + the uncovered amount", function () {
    const book = caseBBook();
    const model = report.buildPacket({
      bank: [],
      book,
      rentroll: caseBRent,
      reportDate: "2026-05-31",
    });
    // The three balances tie out arithmetically, but the un-segregated deposit is
    // an out-of-trust ERROR, so the packet FAILs (the verdict/exit-code contract:
    // model.pass=false => the CLI maps to EXIT.FAIL=3).
    expect(model.tiesOut).to.equal(true);
    expect(model.pass).to.equal(false);
    expect(model.counts.error).to.be.at.least(1);
    const segRows = model.exceptions.filter(
      (e) => e.type === EXCEPTION.SECURITY_DEPOSIT_SEGREGATION
    );
    expect(segRows).to.have.length(1);
    // The REPORT ROW names the at-risk tenant + uncovered amount in its detail.
    expect(segRows[0].severity).to.equal(SEVERITY.ERROR);
    expect(segRows[0].detail).to.include("Smith (4A)");
    expect(segRows[0].detail).to.include("$1,000.00");
    expect(segRows[0].detail).to.not.include("Jones (4B)");
    expect(segRows[0].records[0].party).to.equal("Smith (4A)");
  });

  it("a per-state policy override of the segregation severity still flows through (re-grade to WARNING flips the verdict to PASS)", function () {
    const book = caseBBook();
    // A reviewed policy that re-grades the segregation finding to WARNING (no
    // schema change — same severities map) must flip the verdict to PASS, proving
    // the policy layer feeds the SAME verdict/exit-code path with the named row
    // intact.
    const policy = validatePolicy(
      goodPolicy({
        state: "Testlandia (lenient seg)",
        severities: {
          [EXCEPTION.SECURITY_DEPOSIT_SEGREGATION]: SEVERITY.WARNING,
        },
        citations: {
          [EXCEPTION.SECURITY_DEPOSIT_SEGREGATION]: "Test Stat. 1.2.3",
        },
      })
    );
    const model = report.buildPacket({
      bank: [],
      book,
      rentroll: caseBRent,
      reportDate: "2026-05-31",
      policy,
    });
    const segRows = model.exceptions.filter(
      (e) => e.type === EXCEPTION.SECURITY_DEPOSIT_SEGREGATION
    );
    expect(segRows).to.have.length(1);
    // Re-graded to WARNING by policy => no ERROR => PASS, exit code path unchanged.
    expect(segRows[0].severity).to.equal(SEVERITY.WARNING);
    expect(segRows[0].citation).to.equal("Test Stat. 1.2.3");
    expect(model.counts.error).to.equal(0);
    expect(model.pass).to.equal(true);
    // The named beneficiary detail survives the policy override verbatim.
    expect(segRows[0].detail).to.include("Smith (4A)");
    expect(segRows[0].detail).to.include("$1,000.00");
  });

  it("the named-beneficiary detail survives applyPolicy verbatim (no schema change to the override map)", function () {
    const book = caseBBook();
    const matchResult = matchReconcile([], book);
    const reconcileMod = require("../trustledger/reconcile");
    const raw = reconcileMod.reconcile([], book, { "Jones (4B)": 100000, "Smith (4A)": 100000 }, {
      matchResult,
    });
    const beforeRow = raw.exceptions.find(
      (e) => e.type === EXCEPTION.SECURITY_DEPOSIT_SEGREGATION
    );
    const policy = validatePolicy(
      goodPolicy({
        severities: { [EXCEPTION.SECURITY_DEPOSIT_SEGREGATION]: SEVERITY.WARNING },
      })
    );
    const after = applyPolicy(raw, policy);
    const afterRow = after.exceptions.find(
      (e) => e.type === EXCEPTION.SECURITY_DEPOSIT_SEGREGATION
    );
    // Only severity (and citation) may change; the detail/label/amount/records are
    // carried through verbatim — the named beneficiary is not touched by policy.
    expect(afterRow.detail).to.equal(beforeRow.detail);
    expect(afterRow.detail).to.include("Smith (4A)");
    expect(afterRow.amount).to.equal(beforeRow.amount);
    expect(afterRow.severity).to.equal(SEVERITY.WARNING);
  });
});

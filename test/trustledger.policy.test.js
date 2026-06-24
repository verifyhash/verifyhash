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
    // And the per-exception severities match the pre-policy result exactly.
    const beforeSev = before.exceptions.map((e) => `${e.type}=${e.severity}`);
    const afterSev = after.exceptions.map((e) => `${e.type}=${e.severity}`);
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
    for (let i = 0; i < before.exceptions.length; i++) {
      const b = before.exceptions[i];
      const a = after.exceptions[i];
      expect(a.amount).to.equal(b.amount);
      expect(a.label).to.equal(b.label);
      expect(a.detail).to.equal(b.detail);
      expect(a.records).to.deep.equal(b.records);
    }
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

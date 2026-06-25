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

describe("T-41.2 trustledger/policy: negative_tenant_ledger is FIRST-CLASS — re-gradable by state with ZERO schema change", function () {
  const report = require("../trustledger/report");
  const policyMod = require("../trustledger/policy");

  // A rent roll whose pooled SUM ties to the (empty) book but masks a negative
  // individual ledger: Jones -$500, Smith +$500 => net $0 = book = bank. The ONLY
  // thing that can fail the verdict is the negative individual ledger, so the
  // verdict flip we observe is attributable solely to the negative-ledger severity.
  function maskedRent() {
    return [
      { date: "2026-05-01", amount: -50000, memo: "shortfall", kind: "rent", party: "Jones (4B)", source: "rentroll" },
      { date: "2026-05-01", amount: 50000, memo: "rent", kind: "rent", party: "Smith (4A)", source: "rentroll" },
    ];
  }
  function negRows(result) {
    return result.exceptions.filter(
      (e) => e.type === EXCEPTION.NEGATIVE_TENANT_LEDGER
    );
  }

  it("the legal-type set ALREADY accepts negative_tenant_ledger as a severities key (enum-derived, no schema change)", function () {
    // No new field, no re-listing: validatePolicy accepts the key because it is
    // derived from the engine's EXCEPTION enum. Re-grading is a value in the
    // EXISTING severities map — proof there is zero schema change to make.
    const p = validatePolicy(
      goodPolicy({
        state: "Lenient Negatives",
        severities: { [EXCEPTION.NEGATIVE_TENANT_LEDGER]: SEVERITY.WARNING },
        citations: { [EXCEPTION.NEGATIVE_TENANT_LEDGER]: "Test Stat. 4.1.2" },
      })
    );
    expect(p.severities[EXCEPTION.NEGATIVE_TENANT_LEDGER]).to.equal(SEVERITY.WARNING);
    expect(p.citations[EXCEPTION.NEGATIVE_TENANT_LEDGER]).to.equal("Test Stat. 4.1.2");
    // The default is ERROR, so WARNING is a genuine de-escalation.
    expect(DEFAULT_SEVERITY[EXCEPTION.NEGATIVE_TENANT_LEDGER]).to.equal(SEVERITY.ERROR);
  });

  it("applyPolicy re-grades negative_tenant_ledger and ONLY it (every other type keeps its default)", function () {
    const policy = validatePolicy(
      goodPolicy({
        state: "Lenient Negatives",
        severities: { [EXCEPTION.NEGATIVE_TENANT_LEDGER]: SEVERITY.WARNING },
      })
    );
    const after = applyPolicy(syntheticResult(), policy);
    for (const ex of after.exceptions) {
      if (ex.type === EXCEPTION.NEGATIVE_TENANT_LEDGER) {
        expect(ex.severity).to.equal(SEVERITY.WARNING);
      } else {
        expect(ex.severity).to.equal(DEFAULT_SEVERITY[ex.type], `severity for ${ex.type}`);
      }
    }
  });

  it("DEFAULT policy through report.buildPacket: a masked negative ledger FAILs (pass=false, an ERROR row)", function () {
    const model = report.buildPacket({
      bank: [],
      book: [],
      rentroll: maskedRent(),
      reportDate: "2026-05-31",
    });
    expect(model.tiesOut).to.equal(true); // the pooled SUM ties
    expect(model.pass).to.equal(false); // ...but the negative individual ledger FAILs
    expect(model.counts.error).to.be.at.least(1);
    const neg = negRows(model);
    expect(neg).to.have.length(1);
    expect(neg[0].severity).to.equal(SEVERITY.ERROR);
    expect(neg[0].detail).to.include("Jones (4B)");
  });

  it("a per-state policy re-grading negative_tenant_ledger to WARNING flips the verdict FAIL -> PASS (same files)", function () {
    const policy = validatePolicy(
      goodPolicy({
        state: "EXAMPLE-STATE (negative-ledger re-grade)",
        severities: { [EXCEPTION.NEGATIVE_TENANT_LEDGER]: SEVERITY.WARNING },
        citations: { [EXCEPTION.NEGATIVE_TENANT_LEDGER]: "Test Stat. 4.1.2" },
      })
    );
    const model = report.buildPacket({
      bank: [],
      book: [],
      rentroll: maskedRent(),
      reportDate: "2026-05-31",
      policy,
    });
    const neg = negRows(model);
    expect(neg).to.have.length(1);
    // Re-graded to WARNING by policy => no ERROR => PASS, on the IDENTICAL files.
    expect(neg[0].severity).to.equal(SEVERITY.WARNING);
    expect(neg[0].citation).to.equal("Test Stat. 4.1.2");
    expect(model.counts.error).to.equal(0);
    expect(model.pass).to.equal(true);
    // The named beneficiary detail survives the policy override verbatim.
    expect(neg[0].detail).to.include("Jones (4B)");
    expect(neg[0].detail).to.include("-$500.00");
    // The packet names the governing policy + carries the override in its meta.
    expect(model.policy.state).to.equal("EXAMPLE-STATE (negative-ledger re-grade)");
    const ov = model.policy.overrides.find((o) => o.type === EXCEPTION.NEGATIVE_TENANT_LEDGER);
    expect(ov).to.be.an("object");
    expect(ov.severity).to.equal(SEVERITY.WARNING);
    expect(ov.citation).to.equal("Test Stat. 4.1.2");
  });

  it("the bundled `negative-tenant-ledger-example` fixture resolves and de-escalates the finding to WARNING", function () {
    const resolved = policyMod.resolveState("negative-tenant-ledger-example");
    expect(resolved.state).to.equal("EXAMPLE-STATE (negative-ledger re-grade)");
    expect(resolved.severities[EXCEPTION.NEGATIVE_TENANT_LEDGER]).to.equal(SEVERITY.WARNING);
    // It changes ONLY the negative-ledger severity — no other override.
    expect(Object.keys(resolved.severities)).to.deep.equal([EXCEPTION.NEGATIVE_TENANT_LEDGER]);

    const model = report.buildPacket({
      bank: [],
      book: [],
      rentroll: maskedRent(),
      reportDate: "2026-05-31",
      policy: resolved,
    });
    expect(negRows(model)[0].severity).to.equal(SEVERITY.WARNING);
    expect(model.pass).to.equal(true);
  });

  it("the shipped baseline fixture grades negative_tenant_ledger at its built-in ERROR default (no behaviour change)", function () {
    const baseline = readPolicy(readFixture("baseline.json"));
    expect(baseline.severities[EXCEPTION.NEGATIVE_TENANT_LEDGER]).to.equal(SEVERITY.ERROR);
    // Applying the baseline leaves the verdict identical to no policy: a masked
    // negative ledger still FAILs.
    const model = report.buildPacket({
      bank: [],
      book: [],
      rentroll: maskedRent(),
      reportDate: "2026-05-31",
      policy: baseline,
    });
    expect(negRows(model)[0].severity).to.equal(SEVERITY.ERROR);
    expect(model.pass).to.equal(false);
  });
});

describe("T-42.2 trustledger/policy: owner_overdraw is FIRST-CLASS — gates PASS/FAIL + re-gradable by state with ZERO schema change", function () {
  const report = require("../trustledger/report");
  const policyMod = require("../trustledger/policy");

  // A book in which the owner CONTRIBUTES $1,000 of its OWN capital and then DRAWS
  // $1,500 — $500 BEYOND its contribution, i.e. $500 of TENANT money (Jones holds
  // $5,000 rent in the pooled account). The owner is modeled as a control-account
  // sub-ledger party so the pooled SUM still ties to the book via the owner's
  // -$500 bucket: the three-way SUM ties out, yet $500 of tenant money was
  // converted. The ONLY thing that can fail the verdict is the owner-overdraw
  // ERROR, so the verdict flip we observe is attributable solely to that severity.
  function overdrawBook() {
    return [
      {
        date: "2026-05-01", amount: 100000, memo: "Owner contribution Acme",
        kind: "deposit", party: "Owner Acme", source: "quickbooks",
      },
      {
        date: "2026-05-01", amount: 500000, memo: "rent jones",
        kind: "deposit", party: "Jones (4B)", source: "quickbooks",
      },
      {
        date: "2026-05-10", amount: -150000, memo: "Owner draw - disbursement to owner Acme",
        kind: "check", party: "Owner Acme", source: "quickbooks",
      },
    ];
  }
  // A rent roll that nets the SAME pooled total as the book ($4,500): Jones holds
  // $5,000 and the owner control bucket nets -$500 (contributed $1,000, drew
  // $1,500). So book == sub-ledger == bank and the three-way SUM ties out, leaving
  // the owner-overdraw ERROR as the sole driver of the verdict.
  function overdrawRent() {
    return [
      { date: "2026-05-01", amount: 500000, memo: "rent", kind: "rent", party: "Jones (4B)", source: "rentroll" },
      { date: "2026-05-01", amount: 100000, memo: "owner contribution", kind: "rent", party: "Owner Acme", source: "rentroll" },
      { date: "2026-05-10", amount: -150000, memo: "owner draw", kind: "rent", party: "Owner Acme", source: "rentroll" },
    ];
  }
  function overRows(result) {
    return result.exceptions.filter((e) => e.type === EXCEPTION.OWNER_OVERDRAW);
  }

  it("the legal-type set ALREADY accepts owner_overdraw as a severities key (enum-derived, no schema change)", function () {
    // No new field, no re-listing: validatePolicy accepts the key because it is
    // derived from the engine's EXCEPTION enum. Re-grading is a value in the
    // EXISTING severities map — proof there is zero schema change to make.
    const p = validatePolicy(
      goodPolicy({
        state: "Lenient Overdraw",
        severities: { [EXCEPTION.OWNER_OVERDRAW]: SEVERITY.WARNING },
        citations: { [EXCEPTION.OWNER_OVERDRAW]: "Test Stat. 5.1.2" },
      })
    );
    expect(p.severities[EXCEPTION.OWNER_OVERDRAW]).to.equal(SEVERITY.WARNING);
    expect(p.citations[EXCEPTION.OWNER_OVERDRAW]).to.equal("Test Stat. 5.1.2");
    // The default is ERROR, so WARNING is a genuine de-escalation.
    expect(DEFAULT_SEVERITY[EXCEPTION.OWNER_OVERDRAW]).to.equal(SEVERITY.ERROR);
  });

  it("applyPolicy re-grades owner_overdraw and ONLY it (every other type keeps its default)", function () {
    const policy = validatePolicy(
      goodPolicy({
        state: "Lenient Overdraw",
        severities: { [EXCEPTION.OWNER_OVERDRAW]: SEVERITY.WARNING },
      })
    );
    const after = applyPolicy(syntheticResult(), policy);
    for (const ex of after.exceptions) {
      if (ex.type === EXCEPTION.OWNER_OVERDRAW) {
        expect(ex.severity).to.equal(SEVERITY.WARNING);
      } else {
        expect(ex.severity).to.equal(DEFAULT_SEVERITY[ex.type], `severity for ${ex.type}`);
      }
    }
  });

  it("DEFAULT policy through report.buildPacket: a masked owner over-draw FAILs (pass=false, an ERROR row) — the formerly-silent PASS", function () {
    const model = report.buildPacket({
      bank: [],
      book: overdrawBook(),
      rentroll: overdrawRent(),
      reportDate: "2026-05-31",
    });
    // The pooled three-way SUM ties out perfectly (the owner control bucket absorbs
    // the overdraw)...
    expect(model.tiesOut).to.equal(true);
    // ...yet the packet FAILs, because the owner paid itself $500 of tenant money.
    // This is the verdict/exit-code contract: model.pass=false => the CLI maps to
    // EXIT.FAIL=3. Before owner_overdraw existed this masked case was a silent PASS.
    expect(model.pass).to.equal(false);
    expect(model.counts.error).to.be.at.least(1);
    const over = overRows(model);
    expect(over).to.have.length(1);
    expect(over[0].severity).to.equal(SEVERITY.ERROR);
    // The machine packet row names the owner + the EXCESS (tenant money consumed).
    expect(over[0].amount).to.equal(50000); // $1,500 drawn - $1,000 contributed
    expect(over[0].detail).to.include("Owner Acme");
    expect(over[0].detail).to.include("$500.00");
  });

  it("a per-state policy re-grading owner_overdraw to WARNING flips the verdict FAIL -> PASS (same files)", function () {
    const policy = validatePolicy(
      goodPolicy({
        state: "EXAMPLE-STATE (owner-overdraw re-grade)",
        severities: { [EXCEPTION.OWNER_OVERDRAW]: SEVERITY.WARNING },
        citations: { [EXCEPTION.OWNER_OVERDRAW]: "Test Stat. 5.1.2" },
      })
    );
    const model = report.buildPacket({
      bank: [],
      book: overdrawBook(),
      rentroll: overdrawRent(),
      reportDate: "2026-05-31",
      policy,
    });
    const over = overRows(model);
    expect(over).to.have.length(1);
    // Re-graded to WARNING by policy => no ERROR => PASS, on the IDENTICAL files.
    expect(over[0].severity).to.equal(SEVERITY.WARNING);
    expect(over[0].citation).to.equal("Test Stat. 5.1.2");
    expect(model.counts.error).to.equal(0);
    expect(model.pass).to.equal(true);
    // The named owner + excess detail survives the policy override verbatim.
    expect(over[0].detail).to.include("Owner Acme");
    expect(over[0].detail).to.include("$500.00");
    // The packet names the governing policy + carries the override in its meta.
    expect(model.policy.state).to.equal("EXAMPLE-STATE (owner-overdraw re-grade)");
    const ov = model.policy.overrides.find((o) => o.type === EXCEPTION.OWNER_OVERDRAW);
    expect(ov).to.be.an("object");
    expect(ov.severity).to.equal(SEVERITY.WARNING);
    expect(ov.citation).to.equal("Test Stat. 5.1.2");
  });

  it("the bundled `owner-overdraw-example` fixture resolves and de-escalates the finding to WARNING", function () {
    const resolved = policyMod.resolveState("owner-overdraw-example");
    expect(resolved.state).to.equal("EXAMPLE-STATE (owner-overdraw re-grade)");
    expect(resolved.severities[EXCEPTION.OWNER_OVERDRAW]).to.equal(SEVERITY.WARNING);
    // It changes ONLY the owner-overdraw severity — no other override.
    expect(Object.keys(resolved.severities)).to.deep.equal([EXCEPTION.OWNER_OVERDRAW]);

    const model = report.buildPacket({
      bank: [],
      book: overdrawBook(),
      rentroll: overdrawRent(),
      reportDate: "2026-05-31",
      policy: resolved,
    });
    expect(overRows(model)[0].severity).to.equal(SEVERITY.WARNING);
    expect(model.pass).to.equal(true);
  });

  it("the shipped baseline fixture grades owner_overdraw at its built-in ERROR default (no behaviour change)", function () {
    const baseline = readPolicy(readFixture("baseline.json"));
    expect(baseline.severities[EXCEPTION.OWNER_OVERDRAW]).to.equal(SEVERITY.ERROR);
    // Applying the baseline leaves the verdict identical to no policy: a masked
    // owner over-draw still FAILs.
    const model = report.buildPacket({
      bank: [],
      book: overdrawBook(),
      rentroll: overdrawRent(),
      reportDate: "2026-05-31",
      policy: baseline,
    });
    expect(overRows(model)[0].severity).to.equal(SEVERITY.ERROR);
    expect(model.pass).to.equal(false);
  });
});

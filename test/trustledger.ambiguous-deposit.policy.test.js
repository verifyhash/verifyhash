"use strict";

// ---------------------------------------------------------------------------
// T-39.2: `ambiguous_deposit` is FIRST-CLASS in the verdict + packet + the
// per-state policy layer — so a state CAN grade it to ERROR (a hard FAIL) and
// the packet/CSV surface it next to the other classified exceptions.
//
// Properties under test (the acceptance criteria, end-to-end through report.js):
//   * with NO policy, an `ambiguous_deposit` is a WARNING and does NOT by itself
//     FAIL the gate — a firm whose three balances tie out and whose only finding
//     is the ambiguous deposit still PASSES (not over-FAILed);
//   * with a policy that sets `severities.ambiguous_deposit: "error"`, the SAME
//     run FAILs (pass === false; the CLI maps that to exit 3) — the worked
//     verdict-flips-under-override behavior, now covering the new type;
//   * the policy module ACCEPTS `ambiguous_deposit` as a `severities`/`citations`
//     key (derived from the enum, NOT re-listed) and the bundled example fixture
//     grades it with a PLACEHOLDER citation;
//   * the exception renders in the packet (HTML) and the exception CSV with a
//     human label.
//
// Determinism + isolation: this exercises the PURE report path (buildPacket /
// renderHTML / renderExceptionsCSV) with an explicit reportDate — no clock, no
// filesystem writes, no chain.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const {
  EXCEPTION,
  SEVERITY,
  DEFAULT_SEVERITY,
} = require("../trustledger/reconcile");

const policyMod = require("../trustledger/policy");
const report = require("../trustledger/report");
const match = require("../trustledger/match");

const FIX = path.join(__dirname, "..", "trustledger", "fixtures", "policy");
const readFixture = (name) => fs.readFileSync(path.join(FIX, name), "utf8");

// A normalized-record helper mirroring ingest.js shape.
function rec(date, amount, memo = "", extra = {}) {
  const r = {
    date,
    amount,
    memo,
    kind: extra.kind || "other",
    party: extra.party || "",
    source: extra.source || "bank",
  };
  if (extra.depositType !== undefined) r.depositType = extra.depositType;
  return r;
}

// A clean month that TIES OUT and whose ONLY finding is one ambiguous deposit:
// the bank shows the cleared deposit, the book records it as a bare unlabeled
// "Deposit - 12B Smith" (a party, deposit-scale amount, NO recognized purpose
// keyword), and the rent roll credits the same beneficiary the same amount — so
// adjusted-bank == book == sub-ledger to the penny.
const REPORT_DATE = "2026-05-31";
function cleanTyingScenario() {
  const bank = [rec("2026-05-02", 120000, "deposit smith", { kind: "deposit" })];
  const book = [
    rec("2026-05-01", 120000, "Deposit - 12B Smith", {
      source: "quickbooks",
      kind: "deposit",
      party: "Smith (12B)",
    }),
  ];
  const rentroll = [
    rec("2026-05-01", 120000, "Smith deposit", {
      source: "rentroll",
      party: "Smith (12B)",
    }),
  ];
  return { bank, book, rentroll };
}

function buildWith(policy) {
  const { bank, book, rentroll } = cleanTyingScenario();
  return report.buildPacket({
    bank,
    book,
    rentroll,
    reportDate: REPORT_DATE,
    period: "2026-05",
    opening: { bank: 0, book: 0 },
    toleranceCents: 0,
    policy: policy || null,
  });
}

function exOf(model, type) {
  return model.exceptions.filter((e) => e.type === type);
}

describe("T-39.2 ambiguous_deposit: NO policy is a WARNING that does NOT fail a tying-out account", function () {
  it("the account PASSES (ties out, zero errors) with the ambiguous deposit as a WARNING", function () {
    const model = buildWith(null);
    expect(model.tiesOut, "the three balances tie out").to.equal(true);
    expect(model.counts.error, "no ERROR-severity findings").to.equal(0);
    expect(model.counts.warning, "the ambiguous deposit is the warning").to.be.greaterThan(0);
    expect(model.pass, "a firm with clean, tying data is NOT over-FAILed").to.equal(true);

    const amb = exOf(model, EXCEPTION.AMBIGUOUS_DEPOSIT);
    expect(amb, "exactly one ambiguous_deposit finding").to.have.length(1);
    expect(amb[0].severity).to.equal(SEVERITY.WARNING);
    expect(amb[0].severity).to.equal(DEFAULT_SEVERITY[EXCEPTION.AMBIGUOUS_DEPOSIT]);
    // No policy => no citation attached.
    expect(amb[0].citation).to.equal(null);
  });

  it("the summary line reports PASS with the warning counted (not an error)", function () {
    const model = buildWith(null);
    const line = report.summaryLine(model);
    expect(line).to.match(/^PASS:/);
    expect(line).to.match(/0 error/);
    expect(line).to.match(/1 warning/);
  });
});

describe("T-39.2 ambiguous_deposit: a policy grading it 'error' flips the SAME run to FAIL", function () {
  it("with severities.ambiguous_deposit = 'error' the run FAILs even though the balances still tie out", function () {
    const policy = policyMod.validatePolicy({
      schemaVersion: 1,
      state: "TEST (ambiguous hard-fail)",
      severities: { [EXCEPTION.AMBIGUOUS_DEPOSIT]: SEVERITY.ERROR },
      citations: {
        [EXCEPTION.AMBIGUOUS_DEPOSIT]: "TEST RULE §1 (PLACEHOLDER) — classify it.",
      },
    });
    const model = buildWith(policy);

    // The arithmetic is unchanged — still ties out — but the finding is now an
    // ERROR, so the gate FAILs. This is the verdict-flip-under-override behavior.
    expect(model.tiesOut, "balances still tie out").to.equal(true);
    expect(model.counts.error, "the escalated finding is now an error").to.equal(1);
    expect(model.pass, "an ERROR-graded finding fails the gate").to.equal(false);

    const amb = exOf(model, EXCEPTION.AMBIGUOUS_DEPOSIT);
    expect(amb).to.have.length(1);
    expect(amb[0].severity).to.equal(SEVERITY.ERROR);
    expect(amb[0].citation).to.match(/PLACEHOLDER/);
  });

  it("the SAME files: baseline PASS vs. override FAIL on the same inputs (the worked flip)", function () {
    const passModel = buildWith(null);
    const policy = policyMod.validatePolicy({
      schemaVersion: 1,
      state: "TEST",
      severities: { [EXCEPTION.AMBIGUOUS_DEPOSIT]: SEVERITY.ERROR },
    });
    const failModel = buildWith(policy);

    // Identical balances and identical ambiguous-deposit record; only the
    // severity (and thus the verdict) differs.
    expect(passModel.balances).to.deep.equal(failModel.balances);
    expect(passModel.tiesOut).to.equal(failModel.tiesOut);
    expect(passModel.pass).to.equal(true);
    expect(failModel.pass).to.equal(false);
  });

  it("escalating it to ERROR re-sorts it into the leading error block (errors first)", function () {
    const policy = policyMod.validatePolicy({
      schemaVersion: 1,
      state: "TEST",
      severities: { [EXCEPTION.AMBIGUOUS_DEPOSIT]: SEVERITY.ERROR },
    });
    const model = buildWith(policy);
    const sevRank = { error: 0, warning: 1, info: 2 };
    for (let i = 1; i < model.exceptions.length; i++) {
      expect(sevRank[model.exceptions[i - 1].severity]).to.be.at.most(
        sevRank[model.exceptions[i].severity]
      );
    }
    const idx = model.exceptions.findIndex(
      (e) => e.type === EXCEPTION.AMBIGUOUS_DEPOSIT
    );
    const firstNonError = model.exceptions.findIndex((e) => e.severity !== "error");
    expect(model.exceptions[idx].severity).to.equal(SEVERITY.ERROR);
    expect(idx).to.be.below(
      firstNonError === -1 ? model.exceptions.length : firstNonError
    );
  });
});

describe("T-39.2 ambiguous_deposit: the policy module ACCEPTS it as a severities/citations key", function () {
  it("ambiguous_deposit is in the enum-derived EXCEPTION_TYPES set (no re-listing)", function () {
    expect(policyMod.EXCEPTION_TYPES.has(EXCEPTION.AMBIGUOUS_DEPOSIT)).to.equal(true);
    expect(EXCEPTION.AMBIGUOUS_DEPOSIT).to.equal("ambiguous_deposit");
  });

  it("validatePolicy accepts ambiguous_deposit as a severities key + a citation for it", function () {
    const p = policyMod.validatePolicy({
      schemaVersion: 1,
      state: "TEST",
      severities: { [EXCEPTION.AMBIGUOUS_DEPOSIT]: SEVERITY.ERROR },
      citations: { [EXCEPTION.AMBIGUOUS_DEPOSIT]: "cite" },
    });
    expect(p.severities[EXCEPTION.AMBIGUOUS_DEPOSIT]).to.equal(SEVERITY.ERROR);
    expect(p.citations[EXCEPTION.AMBIGUOUS_DEPOSIT]).to.equal("cite");
  });

  it("still rejects a citation for ambiguous_deposit with NO matching severity override (the misleading-citation rule)", function () {
    expect(() =>
      policyMod.validatePolicy({
        schemaVersion: 1,
        state: "TEST",
        severities: { [EXCEPTION.NSF_REVERSAL]: SEVERITY.ERROR },
        citations: { [EXCEPTION.AMBIGUOUS_DEPOSIT]: "cite" },
      })
    ).to.throw(policyMod.PolicyError, /no severity override/);
  });
});

describe("T-39.2 ambiguous_deposit: the bundled example fixture grades it with a PLACEHOLDER citation", function () {
  let fixturePolicy;
  before(function () {
    fixturePolicy = policyMod.readPolicy(readFixture("ambiguous-deposit-example.json"));
  });

  it("the fixture is a valid policy that grades ambiguous_deposit -> ERROR", function () {
    expect(fixturePolicy.severities[EXCEPTION.AMBIGUOUS_DEPOSIT]).to.equal(SEVERITY.ERROR);
  });

  it("the fixture's citation for ambiguous_deposit is a PLACEHOLDER (not real legal text)", function () {
    const cite = fixturePolicy.citations[EXCEPTION.AMBIGUOUS_DEPOSIT];
    expect(cite).to.be.a("string");
    expect(cite).to.match(/PLACEHOLDER/);
  });

  it("the fixture is discoverable via --state resolution by code AND by state label", function () {
    const byCode = policyMod.resolveState("ambiguous-deposit-example");
    expect(byCode.severities[EXCEPTION.AMBIGUOUS_DEPOSIT]).to.equal(SEVERITY.ERROR);
    const byLabel = policyMod.resolveState(byCode.state);
    expect(byLabel.state).to.equal(byCode.state);
  });

  it("running with the bundled fixture flips the clean-tying account to FAIL", function () {
    const model = buildWith(fixturePolicy);
    expect(model.tiesOut).to.equal(true);
    expect(model.pass).to.equal(false);
    const amb = exOf(model, EXCEPTION.AMBIGUOUS_DEPOSIT)[0];
    expect(amb.severity).to.equal(SEVERITY.ERROR);
    expect(amb.citation).to.match(/PLACEHOLDER/);
  });
});

describe("T-39.2 ambiguous_deposit: it renders in the packet (HTML + CSV) with a human label", function () {
  it("the HTML exception table renders the ambiguous-deposit human label and its policy citation", function () {
    const policy = policyMod.validatePolicy({
      schemaVersion: 1,
      state: "TEST",
      severities: { [EXCEPTION.AMBIGUOUS_DEPOSIT]: SEVERITY.ERROR },
      citations: { [EXCEPTION.AMBIGUOUS_DEPOSIT]: "PLACEHOLDER cite XYZ" },
    });
    const model = buildWith(policy);
    const html = report.renderHTML(model);
    // The human label (not the machine type) is what an auditor reads.
    expect(html).to.contain("Ambiguous deposit");
    expect(html).to.contain("PLACEHOLDER cite XYZ");
    // The FAIL verdict is shown.
    expect(html).to.contain("FAIL");
  });

  it("the exceptions CSV carries a row for the ambiguous deposit with its machine type, label, severity and citation", function () {
    const policy = policyMod.validatePolicy({
      schemaVersion: 1,
      state: "TEST",
      severities: { [EXCEPTION.AMBIGUOUS_DEPOSIT]: SEVERITY.ERROR },
      citations: { [EXCEPTION.AMBIGUOUS_DEPOSIT]: "PLACEHOLDER cite XYZ" },
    });
    const model = buildWith(policy);
    const csv = report.renderExceptionsCSV(model);
    const lines = csv.split("\n");
    const row = lines.find((l) => l.includes("ambiguous_deposit"));
    expect(row, "a CSV row for ambiguous_deposit").to.be.a("string");
    expect(row).to.contain("error");
    expect(row).to.contain("Ambiguous deposit");
    expect(row).to.contain("PLACEHOLDER cite XYZ");
  });

  it("with NO policy the ambiguous deposit still renders (as a WARNING) in the HTML table", function () {
    const model = buildWith(null);
    const html = report.renderHTML(model);
    expect(html).to.contain("Ambiguous deposit");
    // The verdict stays PASS.
    expect(html).to.match(/verdict pass/);
  });
});

describe("T-39.2 ambiguous_deposit: packet output is deterministic for a given policy", function () {
  it("two identical buildPacket+renderHTML runs are byte-identical (no hidden clock / order)", function () {
    const policy = policyMod.validatePolicy({
      schemaVersion: 1,
      state: "TEST",
      severities: { [EXCEPTION.AMBIGUOUS_DEPOSIT]: SEVERITY.ERROR },
    });
    const a = report.renderHTML(buildWith(policy));
    const b = report.renderHTML(buildWith(policy));
    expect(a).to.equal(b);
  });

  it("two identical buildPacket runs JSON-serialize byte-identically (no policy)", function () {
    expect(JSON.stringify(buildWith(null))).to.equal(JSON.stringify(buildWith(null)));
  });
});

// Touch `match` so an unused-require lint never silently drops the proven pairing
// path this scenario relies on (the bank/book deposit must pair to tie out).
describe("T-39.2 ambiguous_deposit: the tying scenario actually pairs bank<->book", function () {
  it("the matcher pairs the cleared deposit so the residue does not create a spurious mismatch", function () {
    const { bank, book } = cleanTyingScenario();
    const m = match.reconcile(bank, book);
    expect(m.matched.length, "the deposit pairs bank<->book").to.equal(1);
  });
});

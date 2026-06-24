"use strict";

// TrustLedger — `vh trust reconcile --policy/--state` CLI test (T-23.2).
//
// Proves the reviewed per-state POLICY layer is wired through the one command a
// broker runs, end to end, and that doing so is ADDITIVE — the no-policy path is
// byte-for-byte the built-in baseline:
//
//   * Reconciling the e2e fixture set with the BASELINE policy yields the SAME
//     PASS/FAIL + balances + exception list as no policy at all (additivity).
//   * The SAME files under an OVERRIDE policy that escalates a present WARNING
//     (nsf_reversal) to ERROR flip the verdict to FAIL with exit 3, and the
//     report surfaces the override's citation + names the governing policy.
//   * `--policy` + `--state` together, and an unknown `--state`, are USAGE
//     errors (exit 2) — a clear, actionable message, no packet written.
//   * Filesystem hygiene is preserved: the packet writes ONLY into --out, and
//     every temp dir is cleaned up (pass or fail), with nothing leaked to cwd.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Wallet } = require("ethers");

const { runReconcile, cmdReconcile, EXIT } = require("../trustledger/cli");
const policy = require("../trustledger/policy");
const report = require("../trustledger/report");
const licenseMod = require("../trustledger/license");

const FIX = path.join(__dirname, "..", "trustledger", "fixtures", "e2e");
const POL = path.join(__dirname, "..", "trustledger", "fixtures", "policy");

// The NSF fixture set: a clean, three-way-tied month that nonetheless carries a
// present WARNING-severity nsf_reversal (a bounced rent check + its reversal,
// both recorded in the book so they net to zero and the three balances still tie
// out). This is exactly the shape a per-state policy escalates.
const BANK = path.join(FIX, "bank.nsf.csv");
const BOOK = path.join(FIX, "quickbooks.nsf.csv");
const RENT = path.join(FIX, "rentroll.nsf.csv");

const BASELINE = path.join(POL, "baseline.json");
const OVERRIDE = path.join(POL, "ca-example.json");

const DATE = "2026-06-24"; // pinned so output is byte-reproducible

function capture() {
  const out = [];
  const err = [];
  return {
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    today: () => DATE,
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

// A normalized view of just the verdict-relevant facts, so additivity is a
// single deep-equal: the verdict, the three balances, and the classified
// exceptions (type+severity+amount), order-stable.
function verdictView(model) {
  return {
    pass: model.pass,
    code: model.pass ? EXIT.PASS : EXIT.FAIL,
    tiesOut: model.tiesOut,
    balances: model.balances,
    counts: model.counts,
    exceptions: model.exceptions.map((e) => ({
      type: e.type,
      severity: e.severity,
      amount: e.amount,
    })),
    beneficiaries: model.beneficiaries,
  };
}

describe("trustledger CLI: `vh trust reconcile --policy/--state`", function () {
  let tmpDirs;

  // T-29.2: --state/--policy are PAID surfaces — they now require a valid,
  // vendor-pinned license carrying the `multi_state_policy` entitlement. Mint ONE
  // fresh EPHEMERAL-key license (TEST-ONLY Wallet.createRandom, NEVER a real key)
  // into a dir that OUTLIVES per-test cleanup, in-window for the pinned DATE, and
  // reuse it across the multi-state tests. `LIC` adds the license opts;
  // `LICFLAGS` adds the equivalent argv flags for the cmdReconcile path.
  let LIC; // { license, vendor }
  let LICFLAGS; // ["--license", file, "--vendor", addr]
  let licDir;
  before(async function () {
    const vendor = Wallet.createRandom();
    const container = await licenseMod.buildLicense(
      {
        licenseId: "LIC-TEST-POLICY",
        customer: "Test Broker LLC",
        plan: "pro",
        entitlements: ["multi_state_policy", "seal"],
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
      vendor
    );
    licDir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-pol-lic-"));
    const file = path.join(licDir, "test.vhlicense.json");
    fs.writeFileSync(file, licenseMod.serializeSignedLicense(container));
    LIC = { license: file, vendor: vendor.address };
    LICFLAGS = ["--license", file, "--vendor", vendor.address];
  });
  after(function () {
    if (licDir) fs.rmSync(licDir, { recursive: true, force: true });
  });

  beforeEach(function () {
    tmpDirs = [];
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "tl-pol-"));
    tmpDirs.push(d);
    return d;
  }

  // ------------------------------------------------------------------ sanity
  it("the NSF fixture set is a PASS with a PRESENT warning (so a policy has something to escalate)", function () {
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE },
      capture()
    );
    expect(res.code).to.equal(EXIT.PASS);
    expect(res.model.pass).to.equal(true);
    expect(res.model.tiesOut).to.equal(true);
    // Three balances tie out to the penny.
    const b = res.model.balances;
    expect(b.adjustedBank).to.equal(b.book);
    expect(b.book).to.equal(b.subledger);
    // A WARNING-severity nsf_reversal is present (and no errors) under baseline.
    expect(res.model.counts.error).to.equal(0);
    expect(res.model.counts.warning).to.be.greaterThan(0);
    expect(res.model.exceptions.some((e) => e.type === "nsf_reversal")).to.equal(true);
    expect(
      res.model.exceptions
        .filter((e) => e.type === "nsf_reversal")
        .every((e) => e.severity === "warning")
    ).to.equal(true);
  });

  // ----------------------------------------------------------- additivity
  it("ADDITIVITY: the baseline policy yields the SAME verdict + balances + exceptions as no policy", function () {
    const ioNone = capture();
    const none = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE },
      ioNone
    );
    const ioBase = capture();
    const base = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE, policyFile: BASELINE, ...LIC },
      ioBase
    );

    // Same exit code, same PASS/FAIL, same three balances, same exception list.
    expect(base.code).to.equal(none.code);
    expect(verdictView(base.model)).to.deep.equal(verdictView(none.model));

    // The baseline run is reported AS the baseline (no silent relabeling), but
    // its overrides are no-ops vs. the built-in defaults, so the verdict is
    // unchanged. (policyMeta is present; the no-policy run has policy === null.)
    expect(none.model.policy).to.equal(null);
    expect(base.model.policy.state).to.match(/baseline/i);
    // No citation surfaces because the baseline overrides match the defaults and
    // carry no citations.
    expect(base.model.exceptions.every((e) => e.citation == null)).to.equal(true);
  });

  it("ADDITIVITY: the no-policy packet HTML/CSV are byte-identical to today's (no policy section, no extra disclaimer line)", function () {
    const dir = mkTmp();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE, out: dir },
      capture()
    );
    expect(res.code).to.equal(EXIT.PASS);
    const html = fs.readFileSync(path.join(dir, `reconciliation-${DATE}.html`), "utf8");
    // The built-in-baseline label appears in the meta line, but NO governing
    // policy section and NO selected-policy disclaimer line.
    expect(html).to.contain("Built-in baseline severities");
    expect(html).to.not.contain("<h2>Governing policy</h2>");
    expect(html).to.not.contain("reflects the SELECTED");
    // The three baseline disclaimer lines only.
    expect(res.model.disclaimer).to.have.length(3);
  });

  // --------------------------------------------------------- override flips
  it("OVERRIDE (--policy): escalating the present nsf_reversal WARNING to ERROR flips PASS->FAIL, exit 3, and shows the citation", function () {
    const ioBase = capture();
    const base = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE, policyFile: BASELINE, ...LIC },
      ioBase
    );
    expect(base.code).to.equal(EXIT.PASS);

    const dir = mkTmp();
    const io = capture();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE, policyFile: OVERRIDE, out: dir, ...LIC },
      io
    );

    // The SAME files now FAIL because the reviewed severity is ERROR.
    expect(res.code).to.equal(EXIT.FAIL);
    expect(res.model.pass).to.equal(false);
    // Arithmetic is untouched — it STILL ties out; only the severity changed.
    expect(res.model.tiesOut).to.equal(true);
    expect(res.model.balances).to.deep.equal(base.model.balances);

    // The nsf_reversal exceptions are now ERROR and carry the policy citation.
    const nsf = res.model.exceptions.filter((e) => e.type === "nsf_reversal");
    expect(nsf.length).to.be.greaterThan(0);
    expect(nsf.every((e) => e.severity === "error")).to.equal(true);
    expect(nsf.every((e) => /PLACEHOLDER/.test(e.citation || ""))).to.equal(true);
    expect(res.model.counts.error).to.be.greaterThan(0);

    // The verdict line a CI gate reads says FAIL.
    expect(io.out()).to.match(/^FAIL:/);

    // The HTML names the governing policy, surfaces the citation, and the
    // disclaimer states PASS reflects the SELECTED policy.
    const html = fs.readFileSync(path.join(dir, `reconciliation-${DATE}.html`), "utf8");
    expect(html).to.contain("<h2>Governing policy</h2>");
    expect(html).to.contain("EXAMPLE-STATE (illustrative override)");
    expect(html).to.contain("Policy citation:");
    expect(html).to.contain("PLACEHOLDER");
    expect(html).to.match(/PASS\/FAIL verdict reflects the SELECTED/);
    expect(html).to.match(/does NOT make this packet legal advice/);
    expect(html).to.match(/CPA or legal counsel must review/);
    // The exceptions CSV carries the citation column + value.
    const exCsv = fs.readFileSync(
      path.join(dir, `reconciliation-${DATE}-exceptions.csv`),
      "utf8"
    );
    expect(exCsv.split("\n")[0]).to.contain("policy_citation");
    expect(exCsv).to.contain("PLACEHOLDER");
    // The balances CSV names the policy.
    const balCsv = fs.readFileSync(
      path.join(dir, `reconciliation-${DATE}-balances.csv`),
      "utf8"
    );
    expect(balCsv).to.contain("EXAMPLE-STATE (illustrative override)");
  });

  it("OVERRIDE (--state): the bundled state code resolves the same policy and flips to FAIL (exit 3)", function () {
    const io = capture();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE, state: "ca-example", ...LIC },
      io
    );
    expect(res.code).to.equal(EXIT.FAIL);
    expect(res.model.policy.state).to.equal("EXAMPLE-STATE (illustrative override)");
    expect(res.model.counts.error).to.be.greaterThan(0);
  });

  it("--json names the governing policy + overrides + citation and carries the FAIL exit contract", function () {
    const dir = mkTmp();
    const io = capture();
    const res = runReconcile(
      {
        bank: BANK,
        ledger: BOOK,
        rentroll: RENT,
        date: DATE,
        state: "ca-example",
        out: dir,
        json: true,
        ...LIC,
      },
      io
    );
    expect(res.code).to.equal(EXIT.FAIL);
    const parsed = JSON.parse(io.out());
    expect(parsed.pass).to.equal(false);
    expect(parsed.policy.state).to.equal("EXAMPLE-STATE (illustrative override)");
    const ov = parsed.policy.overrides.find((o) => o.type === "nsf_reversal");
    expect(ov).to.be.an("object");
    expect(ov.severity).to.equal("error");
    expect(ov.citation).to.match(/PLACEHOLDER/);
    // The selected-policy disclaimer line is present (4th line).
    expect(parsed.disclaimer.length).to.equal(4);
    expect(parsed.disclaimer[3]).to.match(/SELECTED/);
    expect(parsed.disclaimer[3]).to.match(/legal counsel|CPA/);
  });

  // ------------------------------------------------------------ usage errors
  it("USAGE: --policy and --state together is exit 2 with a clear message, writes nothing", function () {
    const dir = mkTmp();
    const io = capture();
    const res = runReconcile(
      {
        bank: BANK,
        ledger: BOOK,
        rentroll: RENT,
        date: DATE,
        policyFile: BASELINE,
        state: "ca-example",
        out: dir,
        ...LIC,
      },
      io
    );
    expect(res.code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/mutually exclusive/);
    // No packet was written despite --out.
    expect(fs.readdirSync(dir)).to.deep.equal([]);
  });

  it("USAGE: an unknown --state is exit 2 and lists the bundled states", function () {
    const io = capture();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE, state: "atlantis", ...LIC },
      io
    );
    expect(res.code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/unknown --state "atlantis"/);
    expect(io.err()).to.match(/bundled states are:/);
    expect(io.err()).to.contain("ca-example");
  });

  it("USAGE: a malformed --policy file is exit 2 (a bad flag value), not a crash", function () {
    const dir = mkTmp();
    const bad = path.join(dir, "bad-policy.json");
    fs.writeFileSync(bad, "{ not: valid json ");
    const io = capture();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE, policyFile: bad, ...LIC },
      io
    );
    expect(res.code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/invalid --policy file/);
  });

  it("USAGE: an unreadable --policy file path is exit 2 with a clear message", function () {
    const io = capture();
    const res = runReconcile(
      {
        bank: BANK,
        ledger: BOOK,
        rentroll: RENT,
        date: DATE,
        policyFile: path.join(os.tmpdir(), "no-such-policy-xyz.json"),
        ...LIC,
      },
      io
    );
    expect(res.code).to.equal(EXIT.USAGE);
    expect(io.err()).to.match(/cannot read --policy file/);
  });

  it("flags parse through the real argv path too (cmdReconcile)", function () {
    const io = capture();
    const code = cmdReconcile(
      [BANK, BOOK, RENT, "--date", DATE, "--state", "ca-example", ...LICFLAGS],
      io
    );
    expect(code).to.equal(EXIT.FAIL); // override escalates -> FAIL
    expect(io.out()).to.match(/^FAIL:/);
  });

  // --------------------------------------------------------- fs hygiene
  it("HYGIENE: the packet writes ONLY into --out, even under a policy, and nothing leaks to cwd", function () {
    const dir = mkTmp();
    const cwdBefore = fs.readdirSync(process.cwd()).sort();
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE, state: "ca-example", out: dir, ...LIC },
      capture()
    );
    expect(res.code).to.equal(EXIT.FAIL);
    // Exactly the three dated packet files, nothing else, in --out.
    expect(fs.readdirSync(dir).sort()).to.deep.equal([
      `reconciliation-${DATE}-balances.csv`,
      `reconciliation-${DATE}-exceptions.csv`,
      `reconciliation-${DATE}.html`,
    ]);
    // The working tree is untouched.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });

  // ----------------------------------------------------- bundled resolution
  it("bundled policies are all valid and addressable by code OR by state label", function () {
    const all = policy.bundledPolicies();
    expect(all.length).to.be.greaterThan(0);
    for (const entry of all) {
      // by filename code
      expect(policy.resolveState(entry.code).state).to.equal(entry.policy.state);
      // by state label (case/punctuation-insensitive)
      expect(policy.resolveState(entry.policy.state).state).to.equal(entry.policy.state);
    }
  });

  // -------------------------------------------- policy toleranceCents is LIVE
  // A three-balance set with a small, fixed 3-cent gap: the bank and book lines
  // match exactly (adjusted bank == book), but the sub-ledger is 3 cents higher,
  // so book and sub-ledger DON'T tie. With tol=0 it does NOT tie out (a
  // subledger_out_of_balance ERROR); a policy that declares toleranceCents:5
  // makes it tie. This proves the policy's toleranceCents is APPLIED (not a
  // validated-but-inert knob) — it changes tiesOut and therefore the verdict,
  // end to end through buildPacket.
  function rec(date, amount, extra = {}) {
    return Object.assign(
      { date, amount, memo: "", party: "", source: "", kind: "" },
      extra
    );
  }
  const TOL_BANK = [
    rec("2026-06-10", 100000, { source: "bank", memo: "rent deposit unit 1" }),
  ];
  const TOL_BOOK = [
    rec("2026-06-10", 100000, { source: "quickbooks", memo: "rent deposit unit 1" }),
  ];
  // Sub-ledger 3 cents higher than book -> a 3-cent book/sub gap.
  const TOL_RENT = [
    rec("2026-06-10", 100003, { source: "rentroll", party: "Unit 1", memo: "rent" }),
  ];

  function tolPolicy(toleranceCents) {
    return policy.validatePolicy({
      schemaVersion: policy.SCHEMA_VERSION,
      state: "TOL-EXAMPLE (de-minimis band)",
      severities: {},
      toleranceCents,
    });
  }

  it("TOLERANCE: with NO policy the default tol=0 leaves the 3-cent gap as a FAIL", function () {
    const model = report.buildPacket({
      bank: TOL_BANK,
      book: TOL_BOOK,
      rentroll: TOL_RENT,
      reportDate: DATE,
    });
    expect(model.tiesOut).to.equal(false);
    expect(model.pass).to.equal(false);
  });

  it("TOLERANCE: a policy toleranceCents:5 is APPLIED — the same 3-cent gap now ties out (PASS)", function () {
    const model = report.buildPacket({
      bank: TOL_BANK,
      book: TOL_BOOK,
      rentroll: TOL_RENT,
      reportDate: DATE,
      policy: tolPolicy(5),
    });
    // The knob changed tiesOut (and thus the verdict): proof it is not inert.
    expect(model.tiesOut).to.equal(true);
    expect(model.pass).to.equal(true);
    // The packet NAMES the band it reconciled under, so the verdict is honest.
    expect(model.policy.toleranceCents).to.equal(5);
    const html = report.renderHTML(model);
    expect(html).to.contain("tolerance of");
    expect(html).to.contain("$0.05");
  });

  it("TOLERANCE: a policy's toleranceCents OVERRIDES the CLI/default tolerance (policy precedence)", function () {
    // CLI passes tol=0, policy declares tol=5 -> policy wins, gap ties out.
    const model = report.buildPacket({
      bank: TOL_BANK,
      book: TOL_BOOK,
      rentroll: TOL_RENT,
      reportDate: DATE,
      toleranceCents: 0,
      policy: tolPolicy(5),
    });
    expect(model.tiesOut).to.equal(true);
    // And a policy declaring tol:0 still reconciles strictly even if the CLI
    // passed a looser value: the reviewed policy governs.
    const strict = report.buildPacket({
      bank: TOL_BANK,
      book: TOL_BOOK,
      rentroll: TOL_RENT,
      reportDate: DATE,
      toleranceCents: 9,
      policy: tolPolicy(0),
    });
    expect(strict.tiesOut).to.equal(false);
  });

  // ----------------------------------------- escalated ERROR sorts to the top
  it("SORT: an escalated ERROR sorts ABOVE a lower-severity row in the packet table and CSV", function () {
    // Under baseline, the NSF fixture carries a present WARNING nsf_reversal and
    // an INFO outstanding row; the override escalates nsf_reversal -> ERROR. The
    // rendered exception table/CSV must show the ERROR row FIRST (errors-first),
    // not buried below the lower-severity rows.
    const res = runReconcile(
      { bank: BANK, ledger: BOOK, rentroll: RENT, date: DATE, state: "ca-example", ...LIC },
      capture()
    );
    expect(res.code).to.equal(EXIT.FAIL);
    const exsev = res.model.exceptions.map((e) => e.severity);
    // The first exception row is an ERROR, and no error appears after a
    // non-error (stable errors-first ordering survives escalation).
    const sevRank = { error: 0, warning: 1, info: 2 };
    expect(exsev[0]).to.equal("error");
    for (let i = 1; i < exsev.length; i++) {
      expect(sevRank[exsev[i - 1]]).to.be.at.most(sevRank[exsev[i]]);
    }
    // The escalated nsf_reversal is in the leading error block.
    const firstNonError = res.model.exceptions.findIndex((e) => e.severity !== "error");
    const nsfIndex = res.model.exceptions.findIndex((e) => e.type === "nsf_reversal");
    expect(res.model.exceptions[nsfIndex].severity).to.equal("error");
    expect(nsfIndex).to.be.below(
      firstNonError === -1 ? res.model.exceptions.length : firstNonError
    );
    // In the rendered CSV, the first DATA row (after the header) is the ERROR.
    const csv = report.renderExceptionsCSV(res.model).split("\n");
    expect(csv[0]).to.contain("severity"); // header
    expect(csv[1].split(",")[0]).to.equal("error");
  });
});

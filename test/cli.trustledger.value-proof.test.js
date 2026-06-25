"use strict";

// ---------------------------------------------------------------------------
// T-45.2 — `vh trust value-proof <bank> <ledger> <rentroll>`: the read-only,
// CI-gateable "what your manual close let through" command.
//
// The command runs the partner's OWN already-closed period through the SAME
// reconcile/buildPacket verdict path the gate uses, diffs the gate's findings
// against the manual close via the pure `valueproof.valueProof` lens, and prints
// a deterministic OUTCOME + headline + per-class dollar table, exiting:
//
//   0 = clean_confirmed   (the gate agrees the account is not out of trust),
//   3 = out_of_trust_missed (a genuine shortage the manual close let through),
//   4 = data_gap_only     (no out-of-trust finding, but data could not reconcile),
//   2 = usage error, 1 = IO/input error.
//
// Load-bearing acceptance the tests prove:
//   * deterministic outcome + headline + per-class dollar table;
//   * exit code maps the outcome 0/3/4 (+ 2 usage / 1 IO);
//   * writes NOTHING anywhere (no packet/seal/file) and leaves cwd untouched;
//   * --json carries the structured result;
//   * EVERY number EQUALS the reconcile/triage verdict for the SAME inputs —
//     proven by driving the SAME files through BOTH `reconcile --json` AND
//     `value-proof --json` and asserting the triage numbers are identical;
//   * NO engine/verdict/severity/count change (value-proof is a read-only lens —
//     running it does not alter what reconcile reports for the same inputs).
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet } = require("ethers");

const cli = require("../trustledger/cli");
const licenseMod = require("../trustledger/license");
const { VALUE_OUTCOME } = require("../trustledger/valueproof");
const { ROOT_CAUSE_CLASS } = require("../trustledger/reconcile");

// A pinned report date so the packet (and thus every number) is reproducible.
const TODAY = "2026-05-31";

// Drive a `vh trust <sub>` command with captured stdout/stderr and a pinned
// clock. Returns { code, out, err }.
function run(cmd, argv) {
  let out = "";
  let err = "";
  const io = {
    write: (s) => (out += s),
    writeErr: (s) => (err += s),
    today: () => TODAY,
  };
  const code = cmd(argv, io);
  return { code, out, err };
}

const valueProof = (argv) => run(cli.cmdValueProof, argv);
const reconcile = (argv) => run(cli.cmdReconcile, argv);

// ---------------------------------------------------------------------------
// Fixtures. We author tiny CSVs in an OS temp dir (NEVER the repo) so the command
// reads REAL files and we can prove it writes nothing back. Each scenario is a
// closed period the broker would hand a pilot.
// ---------------------------------------------------------------------------

// CLEAN: bank == book == sum-of-subledgers; one timing item (a vendor charge not
// yet cleared). The gate ties out -> clean_confirmed.
const CLEAN = {
  bank:
    "Date,Description,Debit,Credit\n" +
    "2026-05-01,Smith rent deposit,,1500.00\n",
  ledger:
    "Date,Type,Name,Memo,Debit,Credit\n" +
    "05/01/2026,Deposit,Smith,rent received,,1500.00\n",
  rentroll:
    "Date,Tenant,Unit,Type,Memo,Payment,Charge\n" +
    "2026-05-01,Smith,4A,Payment,rent received,1500.00,\n",
};

// OUT-OF-TRUST: a NEGATIVE individual tenant ledger. Bank+book both $1,000; the
// rent roll applies $1,500 to Smith and -$500 to Jones (Jones's money was used to
// cover Smith). The pooled sum still ties to $1,000, but Jones's individual ledger
// is negative -> a genuine out-of-trust finding the manual close let through.
const OUT_OF_TRUST = {
  bank:
    "Date,Description,Debit,Credit\n" +
    "2026-05-01,Smith deposit,,500.00\n" +
    "2026-05-01,Jones deposit,,500.00\n",
  ledger:
    "Date,Type,Name,Memo,Debit,Credit\n" +
    "05/01/2026,Deposit,Smith,rent smith,,500.00\n" +
    "05/01/2026,Deposit,Jones,rent jones,,500.00\n",
  rentroll:
    "Date,Tenant,Unit,Type,Memo,Payment,Charge\n" +
    "2026-05-01,Smith,4A,Payment,smith plus jones applied to smith,1500.00,\n" +
    "2026-05-01,Jones,4B,Payment,jones shortfall,-500.00,\n",
};

// DATA-GAP: the bank holds MORE cash than the books record (an unrecorded
// deposit). That is a benign "fix this one item and re-run" data-completeness gap,
// NOT a shortage -> data_gap_only.
const DATA_GAP = {
  bank:
    "Date,Description,Debit,Credit\n" +
    "2026-05-01,Smith rent deposit,,1500.00\n" +
    "2026-05-02,Unrecorded deposit,,1250.00\n",
  ledger:
    "Date,Type,Name,Memo,Debit,Credit\n" +
    "05/01/2026,Deposit,Smith,rent,,1500.00\n",
  rentroll:
    "Date,Tenant,Unit,Type,Memo,Payment,Charge\n" +
    "2026-05-01,Smith,4A,Payment,rent,1500.00,\n",
};

describe("T-45.2 `vh trust value-proof` — the CI-gateable value-proof command", function () {
  let tmp;
  let cwdBefore;

  // Write the three CSVs for a scenario into the temp dir; return their paths +
  // a snapshot of the dir's contents so we can prove nothing new was written.
  function writeScenario(name, scn) {
    const d = path.join(tmp, name);
    fs.mkdirSync(d, { recursive: true });
    const p = {
      bank: path.join(d, "bank.csv"),
      ledger: path.join(d, "ledger.csv"),
      rentroll: path.join(d, "rentroll.csv"),
    };
    fs.writeFileSync(p.bank, scn.bank);
    fs.writeFileSync(p.ledger, scn.ledger);
    fs.writeFileSync(p.rentroll, scn.rentroll);
    return { dir: d, paths: p };
  }

  function snapshot(d) {
    return fs.readdirSync(d).sort();
  }

  before(function () {
    cwdBefore = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vh-valueproof-"));
  });

  after(function () {
    // Filesystem hygiene: the command writes nothing, so a clean recursive remove
    // of OUR temp dir is the only cleanup. The cwd must be untouched throughout.
    expect(process.cwd(), "cwd untouched by value-proof").to.equal(cwdBefore);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // The three outcomes + their exit codes.
  // -------------------------------------------------------------------------

  describe("outcome -> exit code (0 clean / 3 out-of-trust / 4 data-gap)", function () {
    it("CLEAN: clean_confirmed exits 0 and the headline says the gate AGREES", function () {
      const { paths } = writeScenario("clean", CLEAN);
      const r = valueProof([
        paths.bank,
        paths.ledger,
        paths.rentroll,
        "--period",
        "2026-05",
      ]);
      expect(r.code).to.equal(0);
      expect(r.err).to.equal("");
      expect(r.out).to.match(/outcome:\s+clean_confirmed/);
      expect(r.out).to.match(/agrees with your manual close/i);
      // The per-class dollar table is present and human-scannable.
      expect(r.out).to.include("findings the manual close did not flag, by root cause:");
      expect(r.out).to.match(/TOTAL/);
    });

    it("OUT-OF-TRUST: out_of_trust_missed exits 3 with the missed-shortage headline", function () {
      const { paths } = writeScenario("oot", OUT_OF_TRUST);
      const r = valueProof([paths.bank, paths.ledger, paths.rentroll, "--period", "2026-05"]);
      expect(r.code).to.equal(3);
      expect(r.out).to.match(/outcome:\s+out_of_trust_missed/);
      expect(r.out).to.match(/out-of-trust/i);
      expect(r.out).to.match(/let through/i);
      // $1,000.00 = the negative-tenant-ledger impact the manual close missed.
      expect(r.out).to.include("$1,000.00");
    });

    it("DATA-GAP: data_gap_only exits 4 (distinct from a real FAIL) and never claims a shortage", function () {
      const { paths } = writeScenario("gap", DATA_GAP);
      const r = valueProof([paths.bank, paths.ledger, paths.rentroll, "--period", "2026-05"]);
      expect(r.code).to.equal(4);
      expect(r.out).to.match(/outcome:\s+data_gap_only/);
      // Honest posture: a data gap is NEVER framed as a missed shortage.
      expect(r.out).to.match(/not \(yet\) evidence the money is gone/i);
      expect(r.out).to.match(/NO out-of-trust finding/i);
      expect(r.out).to.not.match(/let through/i);
    });
  });

  // -------------------------------------------------------------------------
  // THE load-bearing criterion: every number EQUALS the reconcile/triage verdict
  // for the SAME inputs, proven by driving BOTH commands over the SAME files.
  // -------------------------------------------------------------------------

  describe("every number matches the reconcile/triage verdict for the same inputs", function () {
    // For each scenario, reconcile --json (the authoritative verdict path) and
    // value-proof --json over the SAME files, and assert the triage numbers the
    // value-proof reports EQUAL the reconcile packet's own triage verbatim.
    for (const [name, scn] of Object.entries({
      clean: CLEAN,
      "out-of-trust": OUT_OF_TRUST,
      "data-gap": DATA_GAP,
    })) {
      it(`${name}: value-proof's counts/impact/byClass === reconcile's triage`, function () {
        const { paths } = writeScenario("match-" + name, scn);
        const args = [paths.bank, paths.ledger, paths.rentroll, "--period", "2026-05", "--json"];

        const rec = reconcile(args);
        const vpr = valueProof(args);
        const recJ = JSON.parse(rec.out);
        const vpJ = JSON.parse(vpr.out);

        // The reconcile packet carries the authoritative triage rollup.
        expect(recJ.triage, "reconcile --json carries triage").to.be.an("object");

        // Totals match verbatim.
        expect(vpJ.missedFindings.count).to.equal(recJ.triage.totals.count);
        expect(vpJ.missedFindings.absImpact).to.equal(recJ.triage.totals.absImpact);

        // Every per-class row matches verbatim (same order, same numbers).
        expect(vpJ.missedFindings.byClass).to.deep.equal(
          recJ.triage.classes.map((c) => ({
            class: c.class,
            label: c.label,
            count: c.count,
            absImpact: c.absImpact,
          }))
        );

        // The booleans + topClass are read straight off the same triage.
        expect(vpJ.outOfTrust).to.equal(recJ.triage.outOfTrust);
        expect(vpJ.dataGap).to.equal(recJ.triage.dataIncomplete);
        expect(vpJ.topClass).to.equal(recJ.triage.topClass);

        // The value-proof exit code is consistent with the reconcile verdict:
        //   reconcile PASS  <-> value-proof clean(0) OR data-gap(4) (no out-of-trust),
        //   reconcile FAIL  <-> value-proof out-of-trust(3) OR data-gap(4).
        if (vpr.code === 3) {
          expect(recJ.pass, "out-of-trust => reconcile FAILed").to.equal(false);
          expect(recJ.triage.outOfTrust).to.equal(true);
        }
        if (vpr.code === 0) {
          expect(recJ.triage.outOfTrust, "clean => no out-of-trust finding").to.equal(false);
          expect(recJ.triage.dataIncomplete, "clean => no data gap").to.equal(false);
        }
        if (vpr.code === 4) {
          expect(recJ.triage.outOfTrust, "data-gap => no out-of-trust finding").to.equal(false);
          expect(recJ.triage.dataIncomplete, "data-gap => a data gap is present").to.equal(true);
        }
      });
    }

    it("the value-proof number EQUALS the human reconcile triage headline figure", function () {
      // Cross-check the OUT-OF-TRUST scenario's dollar figure across BOTH commands'
      // HUMAN output, so a human reading either sees the SAME number.
      const { paths } = writeScenario("human-match", OUT_OF_TRUST);
      const base = [paths.bank, paths.ledger, paths.rentroll, "--period", "2026-05"];
      const recHuman = reconcile(base);
      const vpHuman = valueProof(base);
      expect(recHuman.out).to.include("$1,000.00");
      expect(vpHuman.out).to.include("$1,000.00");
    });
  });

  // -------------------------------------------------------------------------
  // Determinism + --json shape.
  // -------------------------------------------------------------------------

  describe("deterministic output + structured --json", function () {
    it("identical inputs => byte-identical human AND json output", function () {
      const { paths } = writeScenario("determ", OUT_OF_TRUST);
      const args = [paths.bank, paths.ledger, paths.rentroll, "--period", "2026-05"];
      const a = valueProof(args);
      const b = valueProof(args);
      expect(a.out).to.equal(b.out);
      expect(a.code).to.equal(b.code);

      const ja = valueProof([...args, "--json"]);
      const jb = valueProof([...args, "--json"]);
      expect(ja.out).to.equal(jb.out);
    });

    it("--json carries the full structured result (outcome, code, missedFindings, headline, caveat)", function () {
      const { paths } = writeScenario("json", OUT_OF_TRUST);
      const r = valueProof([
        paths.bank,
        paths.ledger,
        paths.rentroll,
        "--period",
        "2026-05",
        "--json",
      ]);
      expect(r.code).to.equal(3);
      const j = JSON.parse(r.out);
      expect(j.outcome).to.equal(VALUE_OUTCOME.OUT_OF_TRUST);
      expect(j.code).to.equal(3); // the exit code rides in the JSON too
      expect(j.topClass).to.equal(ROOT_CAUSE_CLASS.OUT_OF_TRUST);
      expect(j.outOfTrust).to.equal(true);
      expect(j.dataGap).to.equal(false);
      expect(j.missedFindings).to.have.keys(["count", "absImpact", "byClass"]);
      expect(j.missedFindings.count).to.equal(1);
      expect(j.missedFindings.absImpact).to.equal(100000);
      expect(j.headline).to.be.a("string").and.match(/let through/i);
      expect(j.caveat).to.equal(cli.VALUE_PROOF_CAVEAT);
      expect(j.period).to.equal("2026-05");
    });
  });

  // -------------------------------------------------------------------------
  // The manual-close baseline (drives `agrees`, never a number/verdict).
  // -------------------------------------------------------------------------

  describe("the manual-close baseline drives `agrees`, never a verdict/number", function () {
    it("default baseline is CLEAN; --asserted-flagged flips ONLY `agrees`", function () {
      const { paths } = writeScenario("baseline", OUT_OF_TRUST);
      const base = [paths.bank, paths.ledger, paths.rentroll, "--period", "2026-05", "--json"];

      const dflt = JSON.parse(valueProof(base).out);
      const flagged = JSON.parse(valueProof([...base, "--asserted-flagged"]).out);

      // Default: the broker asserted CLEAN; the gate disagrees (out-of-trust).
      expect(dflt.manualCloseClean).to.equal(true);
      expect(dflt.agrees).to.equal(false);
      // Flagged: the manual close ALSO flagged it -> now they AGREE.
      expect(flagged.manualCloseClean).to.equal(false);
      expect(flagged.agrees).to.equal(true);

      // ...but the OUTCOME + every gate number is identical regardless of baseline.
      expect(flagged.outcome).to.equal(dflt.outcome);
      expect(flagged.missedFindings).to.deep.equal(dflt.missedFindings);
      // ...and so is the exit code (the gate verdict, not the baseline, gates CI).
      expect(valueProof(base).code).to.equal(
        valueProof([...base, "--asserted-flagged"]).code
      );
    });

    it("--asserted-net is an echoed annotation ONLY; it never changes a number/outcome/exit", function () {
      const { paths } = writeScenario("net", OUT_OF_TRUST);
      const base = [paths.bank, paths.ledger, paths.rentroll, "--period", "2026-05", "--json"];

      const without = JSON.parse(valueProof(base).out);
      // --asserted-net takes a DOLLAR figure (like --opening-bank): "99999.99" => 9999999 cents.
      const withNetRun = valueProof([...base, "--asserted-net", "99999.99"]);
      const withNet = JSON.parse(withNetRun.out);

      expect(without.assertedNetCents).to.equal(null);
      expect(withNet.assertedNetCents).to.equal(9999999);
      // Everything the gate computed is identical with or without the annotation.
      expect(withNet.outcome).to.equal(without.outcome);
      expect(withNet.missedFindings).to.deep.equal(without.missedFindings);
      expect(withNet.headline).to.equal(without.headline);
      expect(withNet.agrees).to.equal(without.agrees);
      expect(withNetRun.code).to.equal(valueProof(base).code);
      // The annotation surfaces in the human output too.
      const human = valueProof([paths.bank, paths.ledger, paths.rentroll, "--asserted-net", "99999.99"]);
      expect(human.out).to.match(/annotation only/i);
    });
  });

  // -------------------------------------------------------------------------
  // Filesystem hygiene: writes NOTHING.
  // -------------------------------------------------------------------------

  describe("filesystem hygiene: writes nothing", function () {
    it("produces no new files in the inputs' directory (no packet, no seal, no close)", function () {
      const { dir, paths } = writeScenario("hygiene", OUT_OF_TRUST);
      const before = snapshot(dir);
      valueProof([paths.bank, paths.ledger, paths.rentroll, "--period", "2026-05"]);
      valueProof([paths.bank, paths.ledger, paths.rentroll, "--period", "2026-05", "--json"]);
      const after = snapshot(dir);
      expect(after).to.deep.equal(before);
      // Specifically: only the three input files exist — no emitted artifacts.
      expect(after).to.deep.equal(["bank.csv", "ledger.csv", "rentroll.csv"]);
    });

    it("does NOT mutate what reconcile reports (the lens is read-only over the same inputs)", function () {
      // Run value-proof, THEN reconcile the same files: reconcile's verdict + triage
      // must be exactly what it would be alone (value-proof changed no engine state).
      const { paths } = writeScenario("readonly", OUT_OF_TRUST);
      const args = [paths.bank, paths.ledger, paths.rentroll, "--period", "2026-05", "--json"];
      const recAlone = JSON.parse(reconcile(args).out);
      valueProof(args); // run the lens in between
      const recAfter = JSON.parse(reconcile(args).out);
      expect(recAfter.pass).to.equal(recAlone.pass);
      expect(recAfter.triage).to.deep.equal(recAlone.triage);
    });
  });

  // -------------------------------------------------------------------------
  // Usage (exit 2) + IO (exit 1) error contracts.
  // -------------------------------------------------------------------------

  describe("usage (2) and IO (1) error contracts", function () {
    it("missing positionals -> usage error (exit 2), writes nothing to stdout", function () {
      const r = valueProof([]);
      expect(r.code).to.equal(2);
      expect(r.err).to.match(/requires three files/);
      expect(r.out).to.equal("");
    });

    it("an unknown flag -> usage error (exit 2)", function () {
      const { paths } = writeScenario("badflag", CLEAN);
      const r = valueProof([paths.bank, paths.ledger, paths.rentroll, "--nope"]);
      expect(r.code).to.equal(2);
      expect(r.err).to.match(/unknown option: --nope/);
    });

    it("a too-many-positionals -> usage error (exit 2)", function () {
      const { paths } = writeScenario("extra", CLEAN);
      const r = valueProof([paths.bank, paths.ledger, paths.rentroll, paths.bank]);
      expect(r.code).to.equal(2);
      expect(r.err).to.match(/exactly three files/);
    });

    it("a bad --date -> usage error (exit 2)", function () {
      const { paths } = writeScenario("baddate", CLEAN);
      const r = valueProof([paths.bank, paths.ledger, paths.rentroll, "--date", "05-31-2026"]);
      expect(r.code).to.equal(2);
      expect(r.err).to.match(/--date must be/);
    });

    it("an unreadable bank file -> IO error (exit 1)", function () {
      const { paths } = writeScenario("noio", CLEAN);
      const missing = path.join(tmp, "noio", "does-not-exist.csv");
      const r = valueProof([missing, paths.ledger, paths.rentroll]);
      expect(r.code).to.equal(1);
      expect(r.err).to.match(/cannot read bank file/);
    });

    it("a malformed ledger row -> IO error (exit 1)", function () {
      const { paths } = writeScenario("malformed", CLEAN);
      // Overwrite the ledger with a row missing its date -> a located ingest error.
      fs.writeFileSync(
        paths.ledger,
        "Date,Type,Name,Memo,Debit,Credit\n,Deposit,Smith,no date,,1500.00\n"
      );
      const r = valueProof([paths.bank, paths.ledger, paths.rentroll]);
      expect(r.code).to.equal(1);
      expect(r.err).to.match(/error:/);
    });
  });

  // -------------------------------------------------------------------------
  // Dispatcher wiring: reachable as `vh trust value-proof`.
  // -------------------------------------------------------------------------

  describe("dispatcher wiring + help", function () {
    it("is reachable through `cmdTrust('value-proof', ...)` with the same exit code", function () {
      const { paths } = writeScenario("dispatch", OUT_OF_TRUST);
      const r = run(cli.cmdTrust, [
        "value-proof",
        paths.bank,
        paths.ledger,
        paths.rentroll,
        "--period",
        "2026-05",
      ]);
      expect(r.code).to.equal(3);
      expect(r.out).to.match(/out_of_trust_missed/);
    });

    it("`vh trust help` lists the value-proof subcommand", function () {
      const r = run(cli.cmdTrust, ["help"]);
      expect(r.code).to.equal(0);
      expect(r.out).to.include("value-proof");
    });

    it("an unknown subcommand error names value-proof in the expected set", function () {
      const r = run(cli.cmdTrust, ["bogus-sub"]);
      expect(r.code).to.equal(2);
      expect(r.err).to.match(/value-proof/);
    });
  });

  // -------------------------------------------------------------------------
  // VERDICT EQUIVALENCE (T-45.2 rework). value-proof must run the broker's period
  // through the SAME verdict-shaping inputs the production reconcile gate threads
  // (--state/--policy, --prior-close, --map-file/--map) so it is GENUINELY the same
  // verdict path — never a narrower baseline-only one that could confidently print
  // "clean confirmed" / exit 0 on a period the broker's OWN licensed gate FAILs.
  //
  // The shipped NSF fixture set is a clean, three-way-tied month that carries a
  // present WARNING-severity `nsf_reversal` (a bounced rent check + its reversal,
  // both recorded so they net to zero and the balances still tie). Its root-cause
  // CLASS is `needs_review` (policy-INDEPENDENT), so the type-based value-proof
  // OUTCOME is `clean_confirmed` regardless of policy. The shipped `ca-example.json`
  // policy ESCALATES `nsf_reversal` WARNING->ERROR, which flips the SAME files
  // PASS->FAIL in the production gate WITHOUT changing the class. THIS is the exact
  // silent-inversion the rework targets: pre-fix, value-proof could not take the
  // policy and would print clean_confirmed / exit 0 on a period reconcile FAILs.
  // -------------------------------------------------------------------------

  describe("verdict-equivalence under the SAME verdict-shaping inputs reconcile threads", function () {
    const FIX = path.join(__dirname, "..", "trustledger", "fixtures", "e2e");
    const POL = path.join(__dirname, "..", "trustledger", "fixtures", "policy");
    // The clean-but-carries-a-warning NSF fixture set (needs_review class).
    const NSF = {
      bank: path.join(FIX, "bank.nsf.csv"),
      ledger: path.join(FIX, "quickbooks.nsf.csv"),
      rentroll: path.join(FIX, "rentroll.nsf.csv"),
    };
    // The policy that escalates nsf_reversal WARNING->ERROR (flips PASS->FAIL).
    const ESCALATE_POLICY = path.join(POL, "ca-example.json");
    const POL_DATE = "2026-06-24"; // the date the NSF fixtures are authored against

    // A run() variant pinned to the NSF fixtures' date.
    function runAt(cmd, argv, date) {
      let out = "";
      let err = "";
      const io = {
        write: (s) => (out += s),
        writeErr: (s) => (err += s),
        today: () => date || POL_DATE,
      };
      const code = cmd(argv, io);
      return { code, out, err };
    }

    // Mint ONE fresh EPHEMERAL-key license (TEST-ONLY Wallet.createRandom — NEVER a
    // real key) carrying multi_state_policy, in-window for POL_DATE, into a dir that
    // outlives the tests; reuse it for every --policy run below.
    let LICFLAGS;
    let licDir;
    before(async function () {
      const vendor = Wallet.createRandom();
      const container = await licenseMod.buildLicense(
        {
          licenseId: "LIC-TEST-VALUEPROOF",
          customer: "Test Broker LLC",
          plan: "pro",
          entitlements: ["multi_state_policy", "seal"],
          issuedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2027-01-01T00:00:00.000Z",
        },
        vendor
      );
      licDir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-vp-lic-"));
      const file = path.join(licDir, "test.vhlicense.json");
      fs.writeFileSync(file, licenseMod.serializeSignedLicense(container));
      LICFLAGS = ["--license", file, "--vendor", vendor.address];
    });
    after(function () {
      if (licDir) fs.rmSync(licDir, { recursive: true, force: true });
    });

    // THE load-bearing rework criterion: drive reconcile AND value-proof through the
    // SAME `--policy ca-example.json` and assert value-proof reports non-clean
    // (exit != 0) EXACTLY when reconcile FAILs — for the SAME inputs, BOTH on the
    // free baseline (no policy) AND under the escalating policy.
    it("value-proof exit is non-zero EXACTLY when reconcile FAILs (baseline AND --policy)", function () {
      const baseArgs = [NSF.bank, NSF.ledger, NSF.rentroll, "--date", POL_DATE];

      // (a) BASELINE (no policy): reconcile PASSes; value-proof is clean (exit 0).
      const recBase = runAt(cli.cmdReconcile, [...baseArgs, "--json"]);
      const vpBase = runAt(cli.cmdValueProof, [...baseArgs, "--json"]);
      const recBaseJ = JSON.parse(recBase.out);
      const vpBaseJ = JSON.parse(vpBase.out);
      expect(recBase.code, "baseline reconcile PASSes").to.equal(0);
      expect(recBaseJ.pass).to.equal(true);
      expect(vpBase.code, "baseline value-proof clean (0)").to.equal(0);
      expect(vpBaseJ.outcome).to.equal(VALUE_OUTCOME.CLEAN_CONFIRMED);
      expect(vpBaseJ.gateVerdict).to.equal("PASS");
      expect(vpBaseJ.policyEscalated).to.equal(false);

      // (b) UNDER THE ESCALATING POLICY: reconcile FAILs (exit 3) — the SAME files,
      //     the nsf_reversal warning graded up to a hard ERROR.
      const polArgs = [...baseArgs, "--policy", ESCALATE_POLICY, ...LICFLAGS];
      const recPol = runAt(cli.cmdReconcile, [...polArgs, "--json"]);
      const vpPol = runAt(cli.cmdValueProof, [...polArgs, "--json"]);
      const recPolJ = JSON.parse(recPol.out);
      const vpPolJ = JSON.parse(vpPol.out);
      expect(recPol.code, "policy reconcile FAILs").to.equal(3);
      expect(recPolJ.pass).to.equal(false);

      // THE FIX: value-proof must NOT exit 0 / claim clean on a period reconcile
      // FAILs. The class-based OUTCOME is still clean_confirmed (policy-independent),
      // but the gate verdict is FAIL, so value-proof exits non-zero (3) and discloses
      // the escalation — it never silently inverts the claim.
      expect(vpPol.code, "policy value-proof is NON-clean (exit 3)").to.equal(3);
      expect(vpPolJ.gateVerdict).to.equal("FAIL");
      expect(vpPolJ.policyEscalated).to.equal(true);

      // The biconditional, stated directly: value-proof clean (exit 0) IFF reconcile PASSes.
      expect(vpBase.code === 0).to.equal(recBaseJ.pass);
      expect(vpPol.code === 0).to.equal(recPolJ.pass);
    });

    it("the per-class dollar table stays FAITHFUL (verbatim from triage) under the policy", function () {
      // The rework is explicit: the per-class rollup is faithful even when the
      // verdict flips. Prove value-proof's byClass/totals still EQUAL reconcile's
      // triage verbatim under the escalating policy (only the exit/framing changed).
      const polArgs = [
        NSF.bank,
        NSF.ledger,
        NSF.rentroll,
        "--date",
        POL_DATE,
        "--policy",
        ESCALATE_POLICY,
        ...LICFLAGS,
        "--json",
      ];
      const recJ = JSON.parse(runAt(cli.cmdReconcile, polArgs).out);
      const vpJ = JSON.parse(runAt(cli.cmdValueProof, polArgs).out);
      expect(vpJ.missedFindings.count).to.equal(recJ.triage.totals.count);
      expect(vpJ.missedFindings.absImpact).to.equal(recJ.triage.totals.absImpact);
      expect(vpJ.missedFindings.byClass).to.deep.equal(
        recJ.triage.classes.map((c) => ({
          class: c.class,
          label: c.label,
          count: c.count,
          absImpact: c.absImpact,
        }))
      );
      // topClass is the policy-independent class diagnosis; it is unchanged.
      expect(vpJ.topClass).to.equal(recJ.triage.topClass);
    });

    it("the human output names the FAIL gate verdict + the escalation note (never a silent clean)", function () {
      const polArgs = [
        NSF.bank,
        NSF.ledger,
        NSF.rentroll,
        "--date",
        POL_DATE,
        "--policy",
        ESCALATE_POLICY,
        ...LICFLAGS,
      ];
      const r = runAt(cli.cmdValueProof, polArgs);
      expect(r.code).to.equal(3);
      expect(r.out).to.match(/gate verdict:\s+FAIL/);
      expect(r.out).to.match(/ESCALATED a finding/);
      expect(r.out).to.match(/NOT\s+a clean confirmation/i);
    });

    // LICENSE-GATE PARITY: --policy is a license-gated PAID surface in BOTH commands.
    // value-proof must REFUSE the policy run with the SAME usage error (exit 2)
    // reconcile does when no valid license is supplied — never silently run an
    // unlicensed policy path the production gate would never grant.
    it("REFUSES --policy without a license, exit 2, the SAME way reconcile does", function () {
      const argv = [NSF.bank, NSF.ledger, NSF.rentroll, "--date", POL_DATE, "--policy", ESCALATE_POLICY];
      const rec = runAt(cli.cmdReconcile, argv);
      const vp = runAt(cli.cmdValueProof, argv);
      expect(rec.code).to.equal(2);
      expect(vp.code, "value-proof refuses an unlicensed policy run").to.equal(2);
      expect(vp.err).to.match(/PAID feature/);
      expect(vp.err).to.match(/requires a license/);
      // It refused BEFORE doing any data work — no value-proof output leaked.
      expect(vp.out).to.equal("");
    });

    it("an unknown --state is a USAGE error (exit 2), matching reconcile", function () {
      const argv = [NSF.bank, NSF.ledger, NSF.rentroll, "--date", POL_DATE, "--state", "ZZ", ...LICFLAGS];
      const vp = runAt(cli.cmdValueProof, argv);
      expect(vp.code).to.equal(2);
      expect(vp.out).to.equal("");
    });

    it("--policy and --state together is a USAGE error (exit 2), matching reconcile", function () {
      const argv = [
        NSF.bank,
        NSF.ledger,
        NSF.rentroll,
        "--date",
        POL_DATE,
        "--policy",
        ESCALATE_POLICY,
        "--state",
        "CA",
        ...LICFLAGS,
      ];
      const vp = runAt(cli.cmdValueProof, argv);
      expect(vp.code).to.equal(2);
      expect(vp.err).to.match(/mutually exclusive/);
    });
  });

  // -------------------------------------------------------------------------
  // SECONDARY (rework): --map-file/--map threading. A broker whose real files use
  // non-default headers must reconcile through value-proof exactly as through
  // reconcile — not hit an IO error (exit 1) value-proof alone would have raised.
  // -------------------------------------------------------------------------

  describe("--map/--map-file threading (non-default headers load, not IO-error)", function () {
    // A clean tying-out period whose BANK file uses a NON-default date header
    // ("TxnDate" instead of "Date"). Without a column map the bank parser cannot
    // find the date column and the run is an IO/input error.
    const MAPPED = {
      bank:
        "TxnDate,Description,Debit,Credit\n" +
        "2026-05-01,Smith rent deposit,,1500.00\n",
      ledger:
        "Date,Type,Name,Memo,Debit,Credit\n" +
        "05/01/2026,Deposit,Smith,rent received,,1500.00\n",
      rentroll:
        "Date,Tenant,Unit,Type,Memo,Payment,Charge\n" +
        "2026-05-01,Smith,4A,Payment,rent received,1500.00,\n",
    };

    it("WITHOUT --map the non-default header is an IO error (exit 1)", function () {
      const { paths } = writeScenario("map-missing", MAPPED);
      const r = valueProof([paths.bank, paths.ledger, paths.rentroll, "--period", "2026-05"]);
      expect(r.code).to.equal(1);
      expect(r.err).to.match(/error:/);
    });

    it("WITH --map bank:date=TxnDate the file loads and reconciles (clean, exit 0) like reconcile", function () {
      const { paths } = writeScenario("map-present", MAPPED);
      const args = [
        paths.bank,
        paths.ledger,
        paths.rentroll,
        "--period",
        "2026-05",
        "--map",
        "bank:date=TxnDate",
        "--json",
      ];
      const rec = reconcile(args);
      const vp = valueProof(args);
      expect(rec.code, "reconcile loads the mapped file").to.equal(0);
      expect(vp.code, "value-proof loads the SAME mapped file (clean, 0)").to.equal(0);
      const vpJ = JSON.parse(vp.out);
      expect(vpJ.outcome).to.equal(VALUE_OUTCOME.CLEAN_CONFIRMED);
      expect(vpJ.gateVerdict).to.equal("PASS");
    });

    it("a structurally-invalid --map is a USAGE error (exit 2), matching reconcile", function () {
      const { paths } = writeScenario("map-bad", MAPPED);
      // Map bank.date to a header that is NOT in the file -> a bad flag value (USAGE).
      const args = [paths.bank, paths.ledger, paths.rentroll, "--map", "bank:date=NoSuchHeader"];
      const r = valueProof(args);
      expect(r.code).to.equal(2);
      expect(r.out).to.equal("");
    });
  });

  // -------------------------------------------------------------------------
  // --prior-close threading: a roll-forward break (the opening this period starts
  // from does not match the prior period's asserted ending) is a CONTINUITY_BREAK
  // (out_of_trust class) that flips the gate to FAIL — value-proof must thread the
  // prior close and reflect that FAIL, never report clean.
  // -------------------------------------------------------------------------

  describe("--prior-close threading (a continuity break flips the verdict)", function () {
    it("a prior close whose ending disagrees with this period surfaces a non-clean verdict", function () {
      // Emit a REAL prior close (with a valid inputsDigest) from a prior clean month,
      // exactly as a broker would via `vh trust reconcile --emit-close`. Reuse it as
      // this period's --prior-close so the roll-forward is checked against a genuine,
      // tool-emitted artifact — not a hand-crafted one.
      const prior = writeScenario("prior-month", CLEAN);
      const outDir = path.join(prior.dir, "out");
      const priorClosePath = path.join(prior.dir, "prior.close.json");
      const emit = reconcile([
        prior.paths.bank,
        prior.paths.ledger,
        prior.paths.rentroll,
        "--period",
        "2026-04",
        "--date",
        "2026-04-30",
        "--out",
        outDir,
        "--emit-close",
        priorClosePath,
      ]);
      expect(emit.code, "prior month reconciles + emits a close").to.equal(0);
      expect(fs.existsSync(priorClosePath)).to.equal(true);
      // The CLEAN month ends at 1500/1500, so the prior close's ending is non-zero.
      const priorEnding = JSON.parse(fs.readFileSync(priorClosePath, "utf8")).ending;
      expect(priorEnding.bank).to.be.greaterThan(0);

      // THIS period (its own clean files), rolling forward FROM that prior close, but
      // with the opening OVERRIDDEN to 0/0 so it disagrees with the prior ending ->
      // the roll-forward continuity check flags a CONTINUITY_BREAK (out-of-trust).
      const cur = writeScenario("cur-month", CLEAN);
      const argsPrior = [
        cur.paths.bank,
        cur.paths.ledger,
        cur.paths.rentroll,
        "--period",
        "2026-05",
        "--prior-close",
        priorClosePath,
        "--opening-bank",
        "0",
        "--opening-book",
        "0",
        "--json",
      ];

      const rec = reconcile(argsPrior);
      const vp = valueProof(argsPrior);
      const recJ = JSON.parse(rec.out);
      const vpJ = JSON.parse(vp.out);

      // The continuity break flips the gate to FAIL for BOTH commands on the SAME inputs.
      expect(recJ.pass, "prior-close break FAILs reconcile").to.equal(false);
      expect(rec.code).to.equal(3);
      // value-proof threads the SAME prior close -> reflects the FAIL (never clean/0).
      expect(vp.code, "value-proof reflects the continuity-break FAIL").to.not.equal(0);
      expect(vpJ.gateVerdict).to.equal("FAIL");
      // And the numbers still match the reconcile triage verbatim.
      expect(vpJ.missedFindings.byClass).to.deep.equal(
        recJ.triage.classes.map((c) => ({
          class: c.class,
          label: c.label,
          count: c.count,
          absImpact: c.absImpact,
        }))
      );
    });

    it("WITHOUT --prior-close the SAME files are clean (proves the break came from the prior close)", function () {
      // The negative control: the current month's files alone (no prior close, default
      // 0/0 opening) are CLEAN — so the FAIL above is attributable to threading the
      // prior close, not to the files themselves.
      const cur = writeScenario("cur-clean", CLEAN);
      const vp = valueProof([cur.paths.bank, cur.paths.ledger, cur.paths.rentroll, "--period", "2026-05", "--json"]);
      expect(vp.code).to.equal(0);
      expect(JSON.parse(vp.out).gateVerdict).to.equal("PASS");
    });
  });
});

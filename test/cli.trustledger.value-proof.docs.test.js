"use strict";

// ---------------------------------------------------------------------------
// T-45.3 docs-rot guard: `vh trust value-proof` documented as the PILOT's
// willingness-to-pay (WTP) instrument in docs/TRUSTLEDGER.md, with the P-8 pilot
// runbook (docs/PILOT.md) success contract + the P-5 #3 design-partner step
// pointed at it.
//
// EPIC-45 shipped the value-proof: a PURE, OFFLINE, READ-ONLY lens
// (trustledger/valueproof.js, T-45.1) and a CI-gateable `vh trust value-proof`
// command (trustledger/cli.js › cmdValueProof, T-45.2) that runs the partner's
// OWN already-closed period through the SAME reconcile gate, diffs the gate's
// findings against the broker's manual close, and prints ONE of three outcomes
// (out_of_trust_missed / data_gap_only / clean_confirmed) + the dollars the
// manual close let through — every number read VERBATIM off the period's triage.
// T-45.3 (this task) DOCUMENTS it as the pilot's WTP instrument and points the
// P-8 runbook + P-5 #3 at it — WITHOUT changing the still-DRAFT / NOT-LEGAL-ADVICE
// / custodian-remains-responsible posture, and WITHOUT adding a new human gate.
//
// Load-bearing properties under test (the acceptance criteria):
//   * docs/TRUSTLEDGER.md documents the value-proof: the THREE outcomes, HOW to
//     run it (`vh trust value-proof`), and the does/does-not-mean BOUNDARY;
//   * the doc states the value-proof COMPARES the gate to the manual close but
//     does NOT certify a jurisdiction or constitute legal advice;
//   * it restates the custodian / CPA / DRAFT posture VERBATIM (the canonical
//     DRAFT/NOT-LEGAL-ADVICE blockquote, and the top-of-doc custodian framing);
//   * docs/PILOT.md points the pilot SUCCESS CONTRACT at `vh trust value-proof`;
//   * it adds NO new `needs-human` item and does NOT alter the closed
//     P-3/P-5/P-6/P-7/P-8 proposal-id set.
//
// The guard imports trustledger/cli.js + trustledger/valueproof.js so it fails
// loudly if the command/lens is ever removed — an otherwise-hollow docs guard —
// and RUNS the live command on tiny in-memory fixtures to prove the documented
// behaviour (the three outcomes + their exit codes) is the behaviour the code
// runs. PURE: it only reads doc files + writes throwaway CSVs to an OS temp dir
// (NEVER the repo) and runs the in-memory command; cwd is untouched.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const cli = require("../trustledger/cli");
const { VALUE_OUTCOME } = require("../trustledger/valueproof");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// Flatten markdown prose for robust phrase matching: drop bold (`*`) markers and
// leading blockquote (`>`) continuation markers, collapse all whitespace, and
// lowercase — so a phrase split across a line break / a `**bold**` boundary / a
// blockquote line still matches as one contiguous string.
const flatten = (s) =>
  s
    .replace(/^[ \t]*>/gm, " ")
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();

// The canonical DRAFT / NOT-LEGAL-ADVICE posture blockquote — the single source
// of truth that the policy section carries and every layered-feature section
// must restate VERBATIM. Pinned byte-for-byte so a reword anywhere is caught.
const CANONICAL_DRAFT_BLOCK =
  "> **DRAFT / NOT LEGAL ADVICE.** The policies that SHIP with TrustLedger\n" +
  "> (`trustledger/fixtures/policy/*.json`) are **DRAFT skeletons**, not legal advice and **not a claim of\n" +
  "> regulatory compliance**. The baseline reproduces the built-in defaults verbatim; the example state\n" +
  "> file carries a **PLACEHOLDER** citation. A qualified **CPA and/or counsel must review and SIGN** the\n" +
  "> per-state severity mapping and its statute citations for the actual jurisdiction before the gate is\n" +
  "> relied on. Selecting a policy does **not** make a packet legal advice and does **not** discharge the\n" +
  "> broker's duty as the responsible legal custodian of trust funds. (STRATEGY.md › P-5 #1/#2.)";

// A pinned report date so any run we drive is reproducible.
const TODAY = "2026-05-31";

// Drive `vh trust value-proof` with captured stdout/stderr and a pinned clock.
function runValueProof(argv) {
  let out = "";
  let err = "";
  const io = { write: (s) => (out += s), writeErr: (s) => (err += s), today: () => TODAY };
  const code = cli.cmdValueProof(argv, io);
  return { code, out, err };
}

describe("T-45.3 docs: the value-proof as the pilot's WTP instrument (docs/TRUSTLEDGER.md + docs/PILOT.md)", function () {
  let doc, docLower, cwdBefore, tmp;

  before(function () {
    cwdBefore = process.cwd();
    doc = read("docs/TRUSTLEDGER.md");
    docLower = doc.toLowerCase();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vh-vp-docs-"));
  });

  after(function () {
    // Filesystem hygiene: cwd untouched; clean recursive remove of OUR temp dir.
    expect(process.cwd(), "cwd untouched by the docs guard").to.equal(cwdBefore);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("the command + lens this guard pins against still exist (tripwire)", function () {
    // If the command/lens is removed or renamed, the documented instrument would
    // be meaningless — fail loudly rather than guard hollow prose.
    expect(typeof cli.cmdValueProof, "cli.cmdValueProof is a function").to.equal("function");
    expect(typeof cli.VALUE_PROOF_CAVEAT, "cli.VALUE_PROOF_CAVEAT is a string").to.equal("string");
    expect(VALUE_OUTCOME.OUT_OF_TRUST).to.equal("out_of_trust_missed");
    expect(VALUE_OUTCOME.DATA_GAP).to.equal("data_gap_only");
    expect(VALUE_OUTCOME.CLEAN_CONFIRMED).to.equal("clean_confirmed");
  });

  describe("the dedicated value-proof section documents the instrument", function () {
    let section, sectionLower, flatLower;
    before(function () {
      // Locate the dedicated section. Match loosely on "value-proof" so a small
      // header reword does not silently drop the guard.
      const start = docLower.indexOf("## the value-proof");
      expect(start, "a '## The value-proof' section is present").to.be.greaterThan(-1);
      const rest = doc.slice(start);
      const end = rest.indexOf("\n## ", 3);
      section = end === -1 ? rest : rest.slice(0, end);
      sectionLower = section.toLowerCase();
      flatLower = flatten(section);
    });

    it("frames the value-proof as the pilot's willingness-to-pay (WTP) instrument", function () {
      expect(flatLower).to.match(/willingness.to.pay|wtp/);
      // The make-or-break pilot question it answers, on the partner's OWN data.
      expect(flatLower).to.match(/worth paying for on my data|on my data|your own/);
      expect(flatLower).to.match(/manual close/);
      // It is the P-5 #3 / pilot instrument.
      expect(flatLower).to.match(/pilot/);
    });

    it("documents HOW to run it: the `vh trust value-proof` command + exit codes 0/3/4", function () {
      expect(section).to.include("vh trust value-proof");
      // The three outcomes, by name.
      expect(section).to.include("out_of_trust_missed");
      expect(section).to.include("data_gap_only");
      expect(section).to.include("clean_confirmed");
      // The exit-code contract a pipeline / human reads.
      expect(flatLower).to.match(/exit.{0,6}\b3\b|`3`/);
      expect(flatLower).to.match(/exit.{0,6}\b4\b|`4`/);
      expect(flatLower).to.match(/exit.{0,6}\b0\b|`0`/);
      // It is read VERBATIM off the same reconcile triage — pin the module.
      expect(section).to.include("trustledger/valueproof.js");
      expect(flatLower).to.match(/verbatim/);
      expect(flatLower).to.match(/same.{0,30}reconcile|same.{0,30}gate|same.{0,30}verdict/);
      // --json so a pipeline can gate on the data.
      expect(section).to.include("--json");
    });

    it("documents the THREE outcomes with their meaning (the WTP case + the honest data-gap)", function () {
      // out_of_trust_missed = the dollars the manual close let through (the WTP case).
      expect(flatLower).to.match(/let through/);
      expect(flatLower).to.match(/out.of.trust/);
      // data_gap_only stated honestly: never framed as a missed shortage.
      expect(flatLower).to.match(/not \(yet\) evidence the money is gone|fix.{0,10}(your |my )?data/);
      // clean_confirmed = a signed, independent confirmation of a clean account.
      expect(flatLower).to.match(/clean.{0,12}(trust )?account|confirmation of a clean/);
    });

    it("states the value-proof COMPARES the gate to the manual close but does NOT certify a jurisdiction / give legal advice", function () {
      // The precise does/does-not-mean boundary the task requires.
      expect(flatLower).to.match(/compares the gate to the (broker's )?manual close|comparison of the gate against the manual close/);
      expect(flatLower).to.match(/does not certify (a |any )?jurisdiction|not certify a jurisdiction/);
      expect(flatLower).to.match(/(not|does not).{0,40}(constitute|legal advice)/);
      // It is a measurement against the manual close, NOT compliance of a particular account.
      expect(flatLower).to.match(/not.{0,30}(audit|compliant|compliance)|pass does not certify|not a legal determination/);
    });

    it("restates the custodian / CPA / aids-not-certifies posture IN-SECTION", function () {
      expect(flatLower).to.match(/responsible (legal )?(trust-account )?custodian|legal custodian/);
      expect(flatLower).to.match(/qualified cpa|cpa must still review|cpa\b/);
      expect(flatLower).to.match(/aids\s+reconciliation|pass does not certify/);
    });

    it("carries the canonical DRAFT / NOT-LEGAL-ADVICE blockquote VERBATIM in-section", function () {
      expect(section).to.include(CANONICAL_DRAFT_BLOCK);
    });

    it("adds NO new human gate: the value-proof only reads the EXISTING verdict, no new `needs-human`", function () {
      expect(flatLower).to.match(/only ever reads the existing verdict|existing verdict|reads.{0,30}existing|read-only/);
      expect(flatLower).to.match(/no.{0,10}new.{0,10}`?needs-human`?|no new needs-human/);
    });
  });

  it("P-5 #3 (the design-partner step) points the measured WTP figure at `vh trust value-proof`", function () {
    // The 'What stays a human step' section's two-month design-partner bullet must
    // now name the value-proof as the measured WTP figure.
    const start = docLower.indexOf("## what stays a human step");
    expect(start, "a '## What stays a human step' section is present").to.be.greaterThan(-1);
    const rest = doc.slice(start);
    const end = rest.indexOf("\n## ", 3);
    const section = end === -1 ? rest : rest.slice(0, end);
    const flatLower = flatten(section);
    expect(flatLower).to.match(/p-5 #3/);
    expect(section).to.include("vh trust value-proof");
    // It is the MEASURED form of the WTP validation.
    expect(flatLower).to.match(/measured wtp|wtp figure|measured.{0,20}wtp|willingness.to.pay/);
    expect(flatLower).to.match(/let through/);
    // …keeping the boundary: compares to the manual close, not a legal certification.
    expect(flatLower).to.match(/compares the gate to the manual close|compare.{0,30}manual close/);
    expect(flatLower).to.match(/not.{0,30}(certify a jurisdiction|constitute legal advice)/);
  });

  it("keeps the top-of-doc 'aids reconciliation, not a certificate' custodian framing", function () {
    expect(docLower).to.match(/responsible (legal )?custodian|legal custodian/);
    expect(docLower).to.match(/qualified cpa|cpa or your state regulator|cpa\/counsel|cpa and\/or counsel/);
    expect(docLower).to.match(/a pass does not certify legal compliance|aids\s+reconciliation|tool that aids/);
  });

  it("the canonical DRAFT/NOT-LEGAL-ADVICE posture still appears verbatim ≥ twice (not the only copy, not stripped)", function () {
    const occurrences = doc.split(CANONICAL_DRAFT_BLOCK).length - 1;
    expect(occurrences, "DRAFT/NOT-LEGAL-ADVICE posture present verbatim ≥ twice").to.be.greaterThan(1);
  });

  it("adds NO new `needs-human` proposal id beyond the existing P-3/P-5/P-6/P-7/P-8 set", function () {
    const ids = new Set(doc.match(/\bP-\d+\b/g) || []);
    const allowed = new Set(["P-3", "P-5", "P-6", "P-7", "P-8"]);
    for (const id of ids) {
      expect(allowed.has(id), `proposal id ${id} is within the existing P-3/P-5/P-6/P-7/P-8 set`).to.equal(
        true
      );
    }
  });

  describe("docs/PILOT.md points the pilot success contract at `vh trust value-proof`", function () {
    let pilot, flatLower;
    before(function () {
      pilot = read("docs/PILOT.md");
      flatLower = flatten(pilot);
    });

    it("names `vh trust value-proof` as the pilot's measured success contract / WTP instrument", function () {
      expect(pilot).to.include("vh trust value-proof");
      // It is the SUCCESS CONTRACT / measured WTP instrument of the pilot.
      expect(flatLower).to.match(/success contract|willingness.to.pay|wtp instrument|measured wtp|measured/);
      expect(flatLower).to.match(/worth paying for on my data|on (my|your) (own )?data|own.{0,20}(closed )?period/);
      // The three outcomes are named so the pilot reads the result without interpretation.
      expect(pilot).to.include("out_of_trust_missed");
      expect(pilot).to.include("data_gap_only");
      expect(pilot).to.include("clean_confirmed");
      expect(flatLower).to.match(/let through/);
    });

    it("states the value-proof compares the gate to the manual close but does NOT certify a jurisdiction / give legal advice", function () {
      expect(flatLower).to.match(/compares the gate to the manual close|compare.{0,30}manual close/);
      expect(flatLower).to.match(/does not certify a jurisdiction|not certify a jurisdiction/);
      expect(flatLower).to.match(/(not|does not).{0,40}(constitute legal advice|legal advice)/);
      // Keeps the standing TrustLedger pilot posture.
      expect(flatLower).to.match(/pass does\s+not imply legal compliance|does not imply legal compliance/);
      expect(flatLower).to.match(/responsible (legal )?custodian|legal custodian/);
      expect(flatLower).to.match(/\bp-5\b/);
    });

    it("does NOT introduce a new proposal id beyond the existing P-3/P-5/P-6/P-7/P-8 set", function () {
      const ids = new Set(pilot.match(/\bP-\d+\b/g) || []);
      const allowed = new Set(["P-3", "P-5", "P-6", "P-7", "P-8"]);
      for (const id of ids) {
        expect(allowed.has(id), `proposal id ${id} is within the existing set`).to.equal(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // The documented behaviour is the behaviour the engine runs: drive the LIVE
  // `vh trust value-proof` over tiny fixtures and prove the three documented
  // outcomes + their exit codes are exactly what the command produces.
  // -------------------------------------------------------------------------

  describe("the documented outcomes are the engine's actual behaviour (live command)", function () {
    function writeScn(name, scn) {
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
      return p;
    }

    // CLEAN: bank == book == sum-of-subledgers -> clean_confirmed (exit 0).
    const CLEAN = {
      bank: "Date,Description,Debit,Credit\n2026-05-01,Smith rent deposit,,1500.00\n",
      ledger:
        "Date,Type,Name,Memo,Debit,Credit\n05/01/2026,Deposit,Smith,rent received,,1500.00\n",
      rentroll:
        "Date,Tenant,Unit,Type,Memo,Payment,Charge\n2026-05-01,Smith,4A,Payment,rent received,1500.00,\n",
    };

    // OUT-OF-TRUST: a negative individual tenant ledger -> out_of_trust_missed (exit 3).
    const OUT_OF_TRUST = {
      bank:
        "Date,Description,Debit,Credit\n2026-05-01,Smith deposit,,500.00\n2026-05-01,Jones deposit,,500.00\n",
      ledger:
        "Date,Type,Name,Memo,Debit,Credit\n05/01/2026,Deposit,Smith,rent smith,,500.00\n05/01/2026,Deposit,Jones,rent jones,,500.00\n",
      rentroll:
        "Date,Tenant,Unit,Type,Memo,Payment,Charge\n2026-05-01,Smith,4A,Payment,smith plus jones,1500.00,\n2026-05-01,Jones,4B,Payment,jones shortfall,-500.00,\n",
    };

    // DATA-GAP: the bank holds MORE cash than the books record -> data_gap_only (exit 4).
    const DATA_GAP = {
      bank:
        "Date,Description,Debit,Credit\n2026-05-01,Smith rent deposit,,1500.00\n2026-05-02,Unrecorded deposit,,1250.00\n",
      ledger: "Date,Type,Name,Memo,Debit,Credit\n05/01/2026,Deposit,Smith,rent,,1500.00\n",
      rentroll:
        "Date,Tenant,Unit,Type,Memo,Payment,Charge\n2026-05-01,Smith,4A,Payment,rent,1500.00,\n",
    };

    it("clean_confirmed exits 0 (as documented)", function () {
      const p = writeScn("doc-clean", CLEAN);
      const r = runValueProof([p.bank, p.ledger, p.rentroll, "--period", "2026-05"]);
      expect(r.code).to.equal(0);
      expect(r.out).to.match(/outcome:\s+clean_confirmed/);
    });

    it("out_of_trust_missed exits 3 and names the dollars the manual close let through (as documented)", function () {
      const p = writeScn("doc-oot", OUT_OF_TRUST);
      const r = runValueProof([p.bank, p.ledger, p.rentroll, "--period", "2026-05"]);
      expect(r.code).to.equal(3);
      expect(r.out).to.match(/outcome:\s+out_of_trust_missed/);
      expect(r.out).to.match(/let through/i);
      expect(r.out).to.include("$1,000.00");
    });

    it("data_gap_only exits 4 and never claims a shortage (as documented)", function () {
      const p = writeScn("doc-gap", DATA_GAP);
      const r = runValueProof([p.bank, p.ledger, p.rentroll, "--period", "2026-05"]);
      expect(r.code).to.equal(4);
      expect(r.out).to.match(/outcome:\s+data_gap_only/);
      expect(r.out).to.not.match(/let through/i);
    });
  });
});

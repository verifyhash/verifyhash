"use strict";

// ---------------------------------------------------------------------------
// T-32.3 docs-rot guard for the BUYER-FACING PILOT RUNBOOK.
//
// Pure (no chain, no fixtures, no network): asserts that docs/PILOT.md + pilot/README.md keep
// documenting the runnable pilot kit (pilot/run-pilot.js) the way it actually behaves, that the README
// and STRATEGY.md keep linking it, and that the honest trust boundary + the consolidated go-to-market
// ask (P-8) stay stated — so the buyer-facing prose can't silently drift from the kit.
//
// Load-bearing properties under test:
//   * docs/PILOT.md exists, is non-trivial, and a NON-AUTHOR can follow it: it tells the reader to run
//     `node pilot/run-pilot.js`, names the combined PASS/FAIL verdict, and labels BOTH verticals.
//   * For each artifact it states what it PROVES and WHERE the partner independently verifies it — i.e.
//     it routes the counterparty through verifier/verify-vh.js with the 0-accept / 3-reject contract.
//   * The honest trust boundary is stated explicitly: tamper-evidence + signer-pin, and NO trusted
//     timestamp ("sealed at T") WITHOUT P-3.
//   * P-8 is a SINGLE consolidated, decision-ready ask in STRATEGY.md that folds the shared
//     design-partner precondition of P-3/P-5/P-6/P-7 into one, whose deliverable IS this kit.
//   * pilot/README.md exists and points a partner at docs/PILOT.md; README.md links both docs.
//   * The files the docs reference actually exist (pilot/run-pilot.js, verifier/verify-vh.js, the test
//     gates), so the prose can't point at vapor.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(REPO, rel));

// Importing the kit both anchors the behaviour the docs describe AND fails loudly if the module (or its
// vertical/source exports) is ever removed — the docs guard would otherwise be hollow.
const pilot = require("../pilot/run-pilot");

describe("T-32.3 docs: buyer-facing pilot runbook (docs/PILOT.md + pilot/README.md)", function () {
  let pilotDoc, pilotDocLower, pilotReadme, pilotReadmeLower, readme, readmeLower, strategy;

  before(function () {
    pilotDoc = read("docs/PILOT.md");
    pilotDocLower = pilotDoc.toLowerCase();
    pilotReadme = read("pilot/README.md");
    pilotReadmeLower = pilotReadme.toLowerCase();
    readme = read("README.md");
    readmeLower = readme.toLowerCase();
    strategy = read("STRATEGY.md");
  });

  it("the kit still exports the verticals + sources the docs describe (tripwire)", function () {
    expect(pilot.runPilot, "runPilot").to.be.a("function");
    expect(pilot.SAMPLE_EVIDENCE, "SAMPLE_EVIDENCE").to.be.a("string");
    expect(pilot.SAMPLE_RECONCILE, "SAMPLE_RECONCILE").to.be.a("string");
    expect(pilot.RECONCILE_SOURCES, "RECONCILE_SOURCES").to.be.an("object");
  });

  describe("the referenced artifacts exist (the prose can't point at vapor)", function () {
    it("the runnable kit + independent verifier exist", function () {
      expect(exists("pilot/run-pilot.js"), "pilot/run-pilot.js").to.equal(true);
      expect(exists("verifier/verify-vh.js"), "verifier/verify-vh.js").to.equal(true);
    });
    it("the test gates the docs cite exist", function () {
      expect(exists("test/pilot.evidence.test.js"), "pilot.evidence.test.js").to.equal(true);
      expect(exists("test/pilot.reconcile.test.js"), "pilot.reconcile.test.js").to.equal(true);
    });
  });

  describe("docs/PILOT.md — a non-author can run it and read one verdict", function () {
    it("exists and is non-trivial", function () {
      expect(pilotDoc, "docs/PILOT.md").to.be.a("string");
      expect(pilotDoc.length).to.be.greaterThan(1500);
    });

    it("tells the reader the exact one command to run", function () {
      expect(pilotDoc).to.include("node pilot/run-pilot.js");
    });

    it("names the single combined PASS/FAIL verdict and exit-0 success", function () {
      expect(pilotDoc).to.include("VERDICT: PASS");
      expect(pilotDocLower).to.match(/exit(s)?\s*\*{0,2}0\*{0,2}/);
    });

    it("labels BOTH sellable verticals", function () {
      expect(pilotDoc).to.include("VERTICAL A — EVIDENCE");
      expect(pilotDoc).to.include("VERTICAL B — RECONCILE");
    });

    it("states no setup / offline / no real key / no network", function () {
      expect(pilotDocLower).to.include("offline");
      expect(pilotDocLower).to.match(/no (real )?key/);
      expect(pilotDocLower).to.include("no network");
    });
  });

  describe("docs/PILOT.md — what each artifact proves + WHERE to independently verify", function () {
    it("names the three artifact kinds", function () {
      expect(pilotDoc).to.include(".vhevidence.json");
      expect(pilotDocLower).to.match(/reconciliation seal/);
      expect(pilotDoc).to.include(".vhlicense.json");
    });

    it("routes the partner through the INDEPENDENT verifier with the accept/reject contract", function () {
      expect(pilotDoc).to.include("verifier/verify-vh.js");
      // exit 0 = ACCEPT, exit 3 = REJECT, localized.
      expect(pilotDocLower).to.match(/exit\s*\*{0,2}0\*{0,2}/);
      expect(pilotDocLower).to.match(/exit\s*\*{0,2}3\*{0,2}/);
      expect(pilotDocLower).to.match(/reject/);
      expect(pilotDocLower).to.match(/localiz/);
    });

    it("says the independent verifier needs NO ethers/hardhat producer stack", function () {
      expect(pilotDocLower).to.include("js-sha3");
      expect(pilotDocLower).to.match(/no.*ethers|ethers.*no/);
      expect(pilotDocLower).to.match(/no.*hardhat|hardhat.*no/);
    });
  });

  // -------------------------------------------------------------------------------------------------
  // T-34.1 — the docs must keep the "run it on YOUR OWN folder" path + the no-mutation promise in sync
  // with the kit (the flag name and the read-only guarantee are load-bearing, partner-facing claims).
  // -------------------------------------------------------------------------------------------------
  describe("T-34.1 — run-on-your-own-folder (--evidence-dir) docs stay in sync with the kit", function () {
    it("the kit actually exposes the --evidence-dir / PILOT_EVIDENCE_DIR knob the docs promise", function () {
      // Tripwire: if the parser stops accepting the flag the docs describe, this fails loudly.
      expect(pilot.parseArgs, "parseArgs").to.be.a("function");
      expect(pilot.parseArgs(["--evidence-dir", "/x/y"]).evidenceDir).to.equal("/x/y");
      expect(pilot.resolveEvidenceSource, "resolveEvidenceSource").to.be.a("function");
    });

    it("docs/PILOT.md documents the one-command own-folder path (flag + env)", function () {
      expect(pilotDoc).to.include("--evidence-dir");
      expect(pilotDoc).to.include("PILOT_EVIDENCE_DIR");
      expect(pilotDoc).to.include("node pilot/run-pilot.js --evidence-dir");
    });

    it("docs/PILOT.md states plainly the kit does NOT modify the partner's files", function () {
      // The exact promise the test suite enforces: copy-then-operate, originals never written.
      expect(pilotDocLower).to.match(/does not modify your files|not modify (the )?partner/);
      expect(pilotDocLower).to.match(/cop(y|ies)/);
      expect(pilotDocLower).to.match(/never (written|modif)|read-only/);
    });

    it("docs/PILOT.md states the missing/empty folder HARD-ERRORS before sealing (no false PASS)", function () {
      expect(pilotDocLower).to.match(/missing|empty|unreadable/);
      expect(pilotDocLower).to.match(/hard-error|hard error/);
      // "…before it seals anything" — tolerate the line-wrap between "before" and "seal".
      expect(pilotDocLower).to.match(/before[\s\S]{0,40}seal/);
    });

    it("docs/PILOT.md reaffirms the honest boundary still holds on the partner's own data", function () {
      // Even on your own data: tamper-evidence + signer-pin, NOT a trusted "sealed at T" without P-3.
      const idx = pilotDocLower.indexOf("--evidence-dir");
      expect(idx, "own-folder section present").to.be.greaterThan(-1);
      // The boundary qualifier must appear somewhere in the runbook alongside the own-folder path.
      expect(pilotDocLower).to.include("tamper-evidence");
      expect(pilotDoc).to.include("P-3");
    });

    it("pilot/README.md documents the same --evidence-dir knob + no-mutation promise", function () {
      expect(pilotReadme).to.include("--evidence-dir");
      expect(pilotReadme).to.include("PILOT_EVIDENCE_DIR");
      expect(pilotReadmeLower).to.match(/never (written|modif)|read-only/);
      expect(pilotReadmeLower).to.match(/cop(y|ies)/);
    });
  });

  describe("the HONEST trust boundary is stated (no trusted timestamp without P-3)", function () {
    it("docs/PILOT.md states tamper-evidence + signer-pin, NOT a trusted timestamp", function () {
      expect(pilotDocLower).to.include("tamper-evidence");
      expect(pilotDocLower).to.match(/signer.?pin/);
      // The load-bearing honest claim: there is no trusted "sealed at T" without P-3.
      expect(pilotDoc).to.match(/no trusted .*"?sealed (on|at) date? ?t/i);
      expect(pilotDoc).to.include("P-3");
    });

    it("pilot/README.md states the SAME honest boundary", function () {
      expect(pilotReadmeLower).to.include("tamper-evidence");
      expect(pilotReadme).to.include("P-3");
      expect(pilotReadmeLower).to.match(/sealed (on|at) date/);
    });

    it("does NOT claim 'unaltered since date T' without the P-3 qualifier nearby", function () {
      // If the phrase ever appears, P-3 must be discussed in the same doc (the honest qualification).
      if (/unaltered since date t/i.test(pilotDoc)) {
        expect(pilotDoc).to.include("P-3");
      }
    });
  });

  // -------------------------------------------------------------------------------------------------
  // T-33.3 — the CI merge-gate is the pilot->renewal conversion lever, and the buyer docs keep two
  // load-bearing claims that MUST NOT drift from the shipped artifact (T-33.2):
  //   (1) the runbook + verifier README carry a copy-paste "wire it into your pipeline" CI section that
  //       points at the SHIPPED snippet path (verifier/ci/verify-vh.generic.sh), and
  //   (2) the FREE-verify / PAID-seal boundary is stated explicitly in that CI context (so a partner is
  //       never told to pay to gate on a proof, only to pay to PRODUCE a seal).
  // P-8 must NAME the CI gate as the renewal lever without adding a new needs-human item.
  // -------------------------------------------------------------------------------------------------
  describe("T-33.3 — CI merge-gate is the pilot->renewal lever, docs can't drift from the snippet", function () {
    let verifierReadme, verifierReadmeLower;
    before(function () {
      verifierReadme = read("verifier/README.md");
      verifierReadmeLower = verifierReadme.toLowerCase();
    });

    it("the shipped CI snippets from T-33.2 actually exist (the docs can't point at vapor)", function () {
      expect(exists("verifier/ci/verify-vh.generic.sh"), "verify-vh.generic.sh").to.equal(true);
      expect(exists("verifier/ci/verify-vh.github-actions.yml"), "verify-vh.github-actions.yml").to.equal(true);
      expect(exists("test/verifier.ci-snippet.test.js"), "ci-snippet anti-rot test").to.equal(true);
    });

    it("docs/PILOT.md carries a copy-paste CI section pointing at the SHIPPED generic snippet", function () {
      // The runbook must teach the partner to wire the gate in, and point at the real artifact path
      // from T-33.2 (not a renamed/aspirational one).
      expect(pilotDocLower).to.match(/wire it into your pipeline/);
      expect(pilotDoc).to.include("verifier/ci/verify-vh.generic.sh");
      // The 3-line CI shape the buyer pastes.
      expect(pilotDoc).to.include("VH_VENDOR");
      expect(pilotDoc).to.match(/VH_MANIFEST|VH_ARTIFACTS/);
      // What green vs red means at the gate.
      expect(pilotDocLower).to.match(/green/);
      expect(pilotDocLower).to.match(/red|block/);
    });

    it("docs/PILOT.md states the FREE-verify / PAID-seal boundary explicitly", function () {
      // The load-bearing boundary: verification costs nothing; only producing a seal is paid.
      expect(pilotDocLower).to.match(/verification is free|verify[^.]*free|free[^.]*verif/);
      expect(pilotDocLower).to.match(/sealing is paid|paid[^.]*seal|seal[^.]*paid/);
    });

    it("verifier/README.md keeps the SAME CI section + FREE-verify / PAID-seal boundary", function () {
      // README §2b links the snippet relative to its own tree (ci/verify-vh.generic.sh).
      expect(verifierReadme).to.include("ci/verify-vh.generic.sh");
      expect(verifierReadmeLower).to.match(/verification is free|verify[^.]*free|free[^.]*verif/);
      expect(verifierReadmeLower).to.match(/sealing is paid|paid[^.]*seal|seal[^.]*paid/);
    });

    it("STRATEGY.md P-8 names the CI gate as the pilot->renewal lever, adding NO new needs-human", function () {
      // Anchor on the actual needs-human PROPOSAL block (dated), not the earlier narrative mention.
      const p8 = strategy.indexOf("P-8 (2026");
      expect(p8, "P-8 proposal present").to.be.greaterThan(-1);
      const block = strategy.slice(p8, p8 + 6000);
      const blockLower = block.toLowerCase();
      // Names the CI merge-gate as the conversion lever.
      expect(blockLower).to.match(/merge.?gate|ci .*gate|ci merge/);
      expect(blockLower).to.match(/renew/);
      expect(block).to.include("verifier/ci/verify-vh.generic.sh");
      // It explicitly does NOT add a new human gate and keeps the free/paid split.
      expect(blockLower).to.match(/no new human gate|without adding (any|a) new human gate/);
      expect(blockLower).to.match(/free.?verify|free[^.]*seal|verify[^.]*free/);
      // Tripwire (T-33.3's real contract): the CI-gate SHARPENING must NOT turn the P-8 block into (or
      // spawn from within it) a SECOND consolidated go-to-market needs-human ask. Scoped to the P-8 block,
      // not the whole file — a LATER, UNRELATED proposal (e.g. P-9, the EMBEDDABLE-SDK distribution ask on a
      // different axis) is legitimately allowed to exist elsewhere.
      expect(block).to.not.match(/P-9 \(/);
    });
  });

  describe("pilot/README.md — operator quick reference", function () {
    it("exists, is non-trivial, and points the partner at the buyer runbook", function () {
      expect(pilotReadme, "pilot/README.md").to.be.a("string");
      expect(pilotReadme.length).to.be.greaterThan(800);
      expect(pilotReadme).to.match(/docs\/PILOT\.md/);
    });

    it("documents the one run command + the PILOT_OUT/PILOT_KEEP knobs", function () {
      expect(pilotReadme).to.include("node pilot/run-pilot.js");
      expect(pilotReadme).to.include("PILOT_OUT");
      expect(pilotReadme).to.include("PILOT_KEEP");
    });

    it("references the consolidated go-to-market ask P-8", function () {
      expect(pilotReadme).to.include("P-8");
    });
  });

  describe("README.md links the pilot docs", function () {
    it("links docs/PILOT.md and pilot/README.md", function () {
      expect(readme).to.match(/docs\/PILOT\.md/);
      expect(readme).to.match(/pilot\/README\.md/);
    });

    it("documents running the kit in one command", function () {
      expect(readme).to.include("node pilot/run-pilot.js");
    });
  });

  // -------------------------------------------------------------------------------------------------
  // T-53.3 — the pilot RESULT CERTIFICATE is the pilot's SHAREABLE deliverable. The docs must keep three
  // load-bearing, partner-facing claims in sync with the shipped `--certificate` flag (T-53.2):
  //   (1) docs/PILOT.md names `--certificate`, describes the verify-with-your-team flow through the
  //       zero-install verify-vh-standalone.js, and states the honest boundary VERBATIM;
  //   (2) pilot/README.md carries the operator note (the flag + the forwardable-record purpose);
  //   (3) STRATEGY.md P-8 step 3c→4 gains a one-line POINTER (no change to the ask, no new needs-human).
  // -------------------------------------------------------------------------------------------------
  describe("T-53.3 — the pilot result certificate is documented as the shareable deliverable", function () {
    it("the kit actually exposes the --certificate flag + writer the docs describe (tripwire)", function () {
      expect(pilot.writeCertificate, "writeCertificate").to.be.a("function");
      expect(pilot.parseArgs(["--certificate", "/x/c.vhevidence.json"]).certificate)
        .to.equal("/x/c.vhevidence.json");
    });

    it("docs/PILOT.md names --certificate and the *.vhevidence.json deliverable", function () {
      expect(pilotDoc).to.include("--certificate");
      expect(pilotDoc).to.include(".vhevidence.json");
      // The one-command own-folder + certificate invocation the partner copies.
      expect(pilotDoc).to.match(/run-pilot\.js[\s\S]{0,120}--certificate/);
    });

    it("docs/PILOT.md describes the verify-WITH-YOUR-TEAM flow via the zero-install standalone verifier", function () {
      // Independently verifiable by the prospect's security/procurement team, no install.
      expect(pilotDocLower).to.match(/security|procurement/);
      expect(pilotDoc).to.include("verify-vh-standalone.js");
      // Zero-install: no clone, no npm install, no key.
      expect(pilotDocLower).to.match(/no clone/);
      expect(pilotDocLower).to.match(/no .*npm install|npm install.*no/);
      // The accept/reject contract on the forwarded bytes.
      expect(pilotDocLower).to.match(/exit\s*\*{0,2}0\*{0,2}/);
      expect(pilotDocLower).to.match(/exit\s*\*{0,2}3\*{0,2}/);
      // Turning "the demo passed on my machine" into a forwardable record.
      expect(pilotDocLower).to.match(/forward/);
    });

    it("docs/PILOT.md teaches READING the verdict/checklist out of the VERIFIED certificate bytes (the leverage over a screenshot)", function () {
      // The high-leverage claim a procurement reviewer relies on: the verdict + counts + labelled
      // checklist live INSIDE the byte stream the keccak root commits to, so after verify-vh ACCEPTs they
      // are part of what was proven unaltered — a self-contained record, not a checksum the reviewer must
      // pair with a separate sales claim about "what the run checked".
      expect(pilotDoc).to.include("pilot-result.files/pilot-result.json");
      // It names the machine-readable fields the reviewer reads out (the record schema, not prose).
      expect(pilotDoc).to.match(/\bverdict\b/);
      expect(pilotDoc).to.match(/passed\b[\s\S]{0,40}\btotal\b|\btotal\b[\s\S]{0,40}passed\b/);
      expect(pilotDoc).to.include("evidenceSource");
      // It states WHY this is trustworthy: the read file is inside the certified/verified surface.
      expect(pilotDocLower).to.match(/inside (the )?(certified|verified)|part of what (you|was) (just )?(verified|proven)/);
      // A concrete, install-free recipe (Node one-liner; jq is offered only as an alternative).
      expect(pilotDoc).to.match(/node -e/);
    });

    it("the kit PRINTS the read-the-verdict hint after the verify command (the docs claim stays honest)", function () {
      // Drive the SAME write path the operator runs and assert the printed certificate note teaches the
      // next step — so the docs ('the kit prints the precise verify command') do not over-promise.
      const certBlock = String(read("pilot/run-pilot.js"));
      expect(certBlock).to.match(/READ the verdict out of the bytes you just verified/);
      // The printed recipe surfaces the verdict + counts + evidenceSource the docs describe.
      expect(certBlock).to.include("r.verdict");
      expect(certBlock).to.include("evidenceSource");
    });

    it("docs/PILOT.md states the honest certificate boundary VERBATIM", function () {
      // The exact task-mandated boundary sentence (tolerant of soft-wrap whitespace and of the leading
      // article's sentence-capitalisation only — every load-bearing clause is matched word-for-word).
      const verbatim =
        "certificate proves WHAT the pilot run checked and that the result bytes are unaltered " +
        "— it is tamper-evidence over the run record, NOT a trusted \"the pilot ran at time T\" without P-3, " +
        "and NOT a legal/compliance verdict.";
      const norm = (s) => s.replace(/\s+/g, " ");
      expect(norm(pilotDoc)).to.include(norm(verbatim));
    });

    it("pilot/README.md carries the operator note (the --certificate flag + forwardable-record purpose)", function () {
      expect(pilotReadme).to.include("--certificate");
      expect(pilotReadmeLower).to.match(/forward/);
      expect(pilotReadme).to.include("verify-vh-standalone.js");
      // Points at the buyer-facing section.
      expect(pilotReadme).to.match(/docs\/PILOT\.md/);
    });

    it("STRATEGY.md P-8 step 3c→4 gains a one-line POINTER with NO new needs-human item", function () {
      const p8 = strategy.indexOf("P-8 (2026");
      expect(p8, "P-8 proposal present").to.be.greaterThan(-1);
      // Bound the block to the ACTUAL P-8 proposal — up to the next top-level proposal bullet (P-9) or, if
      // none yet, a generous window. A fixed-width slice would bleed into a later, unrelated proposal.
      const p8Tail = strategy.slice(p8);
      const nextProposal = p8Tail.indexOf("\n- **P-9");
      const block = nextProposal === -1 ? p8Tail.slice(0, 12000) : p8Tail.slice(0, nextProposal);
      const blockLower = block.toLowerCase();
      // The pointer names the certificate as the forwardable end of the pilot.
      expect(block).to.include("--certificate");
      expect(blockLower).to.match(/forwardable/);
      expect(block).to.include("verify-vh-standalone.js");
      // It is a POINTER, explicitly no new gate, and re-states the honest boundary.
      expect(blockLower).to.match(/no new gate/);
      expect(blockLower).to.match(/tamper-evidence over the run record/);
      expect(blockLower).to.match(/not a trusted "ran at time t"|without p-3/);
      // Tripwire (T-53.3's real contract): the CERTIFICATE POINTER must stay a pointer — it must NOT turn
      // P-8 into (or spawn from within the P-8 block) a NEW consolidated go-to-market needs-human ask. We
      // scope the check to the P-8 block, not the whole file: a LATER, UNRELATED proposal (e.g. P-9, the
      // EMBEDDABLE-SDK distribution ask on a different axis) is legitimately allowed to exist elsewhere —
      // the tripwire only guards that the pilot-certificate work here did not smuggle one in.
      expect(block).to.not.match(/P-9 \(/);
    });
  });

  describe("STRATEGY.md — P-8 is ONE consolidated, decision-ready ask", function () {
    it("P-8 exists in the needs-human proposals and consolidates the design-partner precondition", function () {
      // Anchor the P-8 PROPOSAL inside the `## Proposals — needs-human` section (the test's actual
      // contract: "P-8 exists in the needs-human proposals"). The `## Direction` log above may legitimately
      // MENTION "P-8 (…)" in passing — we must not match those, only the real proposal block.
      const proposalsHeader = strategy.search(/##\s*Proposals — needs-human/);
      expect(proposalsHeader, "needs-human proposals section present").to.be.greaterThan(-1);
      const p8 = strategy.indexOf("P-8 (", proposalsHeader);
      expect(p8, "P-8 proposal present in the needs-human section").to.be.greaterThan(-1);
      const block = strategy.slice(p8, p8 + 4000);
      const blockLower = block.toLowerCase();
      // It is decision-ready and outward-facing (needs-human).
      expect(blockLower).to.include("needs-human");
      // It folds the SHARED design-partner / pilot precondition.
      expect(blockLower).to.match(/design partner|design-partner/);
      expect(blockLower).to.match(/run (the|a) pilot/);
      // It consolidates the four prior gates explicitly (does not re-sharpen them).
      for (const p of ["P-3", "P-5", "P-6", "P-7"]) {
        expect(block, `P-8 references ${p}`).to.include(p);
      }
      // Its deliverable IS this kit.
      expect(block).to.match(/run-pilot\.js|pilot kit|this (very )?kit/i);
    });
  });
});

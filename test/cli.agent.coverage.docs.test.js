"use strict";

// test/cli.agent.coverage.docs.test.js — the ANTI-DRIFT acceptance suite for the fleet-coverage
// docs + the scripted worked fleet example (T-71.3, the T-68.4/T-69.3 discipline).
//
// WHY THIS TEST EXISTS
//   docs/AGENTTRACE.md § "Coverage: prove it fleet-wide" is the buyer-facing statement of what a
//   coverage report PROVES and — load-bearingly — what it does NOT. A boundary sentence that rots is
//   an overclaim (the exact failure mode this vertical exists to prevent), and a scripted example
//   that rots sends an adopter at commands that no longer work. So this suite does NOT trust the
//   prose; it PROVES, against the REAL code and a throwaway fixture built by the example itself:
//     (a) the doc pins the PROVES sentences (for each covered commit an UNALTERED sealed session
//         contains a disclosed claim to exactly that oid; under --deep to exactly that re-derived
//         tracked-set root; the report is deterministic and sealable with the existing `vh evidence
//         seal`) and the NOT-PROVES sentences VERBATIM — containment-NOT-causation per commit ("it
//         does NOT prove the session's events produced the commit"), the inventory sentence ("An
//         uncovered commit proves NOTHING about how it was authored: coverage is an INVENTORY
//         control, not an authorship detector."), a redacted claim is not disclosable, `ts`
//         self-asserted / no trusted timestamp without P-3 — plus the code's in-band
//         COVERAGE_TRUST_NOTE byte-for-byte, the free line VERBATIM ("Coverage and the CI gate are
//         FREE"; "`--sign` is unchanged behind the existing gate"), and the CI recipe pointers
//         (which name files that really exist);
//     (b) examples/agent-session/fleet-coverage.js REALLY runs the documented flow — fixture repo →
//         two sessions → claims → seal → coverage → `--require-all` FAILING (exit 3, naming the
//         uncovered commit) then PASSING (exit 0, --deep, both commits covered-verified) — offline,
//         against a temp workdir, node core + git + the shipped CLI only; the written report is the
//         canonical vh-agent-coverage@1 artifact (strict-parse round-trip, byte-identical across two
//         runs: DETERMINISTIC), and its facts re-derive with the EXACT reused hashGit/resolveCommit;
//     (c) the funnel pointers exist (README.md, docs/ADOPT.md, docs/PILOT.md's journeys list, the
//         example README);
//     (d) NO P-1..P-11 human step in STRATEGY.md was deleted or relaxed — and the touched docs
//         declare no needs-human item of their own.
//   Filesystem hygiene: every artifact lands in a throwaway temp dir (cleaned up pass or fail); the
//   suite asserts the working directory is left untouched.

const { expect } = require("chai");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const agent = require("../cli/agent");
const agentCoverage = require("../cli/core/agent-coverage");
const evidencePlans = require("../cli/core/evidence-plans");
const git = require("../cli/git");
const { hashGit } = require("../cli/hash");

const REPO = path.resolve(__dirname, "..");
const DOC = path.join(REPO, "docs", "AGENTTRACE.md");
const README = path.join(REPO, "README.md");
const ADOPT = path.join(REPO, "docs", "ADOPT.md");
const PILOT = path.join(REPO, "docs", "PILOT.md");
const STRATEGY = path.join(REPO, "STRATEGY.md");
const EXAMPLE_DIR = path.join(REPO, "examples", "agent-session");
const EXAMPLE_README = path.join(EXAMPLE_DIR, "README.md");
const SCRIPT = path.join(EXAMPLE_DIR, "fleet-coverage.js");
const GENERIC_SH = path.join(REPO, "verifier", "ci", "agent-coverage.generic.sh");
const GHA_YML = path.join(REPO, "verifier", "ci", "agent-coverage.github-actions.yml");

const doc = fs.readFileSync(DOC, "utf8");

// The coverage section, sliced heading-to-next-H2 so every pin below anchors to THE section (not a
// stray mention elsewhere in the doc).
const SECTION_HEADING = "## Coverage: prove it fleet-wide";
const secStart = doc.indexOf(SECTION_HEADING);
const secEnd = secStart === -1 ? -1 : doc.indexOf("\n## ", secStart + SECTION_HEADING.length);
const section = secStart === -1 ? "" : secEnd === -1 ? doc.slice(secStart) : doc.slice(secStart, secEnd);
const sectLow = section.toLowerCase();

describe("T-71.3: fleet-coverage docs + the scripted worked fleet example — honest boundary, impossible to overclaim", function () {
  this.timeout(180000);

  // -------------------------------------------------------------------------
  // (a) docs/AGENTTRACE.md § "Coverage: prove it fleet-wide" — the pins.
  // -------------------------------------------------------------------------
  describe('(a) docs/AGENTTRACE.md § "Coverage: prove it fleet-wide"', function () {
    it("the section exists and the verb rides the command surface", function () {
      expect(secStart, `docs/AGENTTRACE.md must contain "${SECTION_HEADING}"`).to.be.greaterThan(-1);
      expect(doc).to.contain("vh agent coverage --repo <dir> --range <rev-range> --packets <dir>");
      for (const flag of ["--deep", "--require-all", "--require-since <oid>", "--out <report>"]) {
        expect(section, `the section documents ${flag}`).to.contain(flag);
      }
    });

    it("PROVES: for each covered commit, an UNALTERED sealed session contains a disclosed claim to exactly that oid", function () {
      expect(sectLow).to.match(
        /an unaltered sealed session contains a disclosed claim to exactly that\s+oid/
      );
      // …and only because the packet passed the FULL shipped verify path first.
      expect(sectLow).to.match(/full shipped verify path/);
      expect(section).to.contain("claim-unverified-packet");
    });

    it("PROVES: under --deep, to exactly that re-derived tracked-set root (and without --deep the output says root-not-re-derived)", function () {
      expect(sectLow).to.match(/under `--deep`, to exactly that re-derived tracked-set root/);
      expect(section).to.contain("claim-root-mismatch");
      expect(section).to.contain("covered-oid-only");
      expect(sectLow).to.contain("root-not-re-derived");
    });

    it("PROVES: the report is deterministic and sealable with the existing `vh evidence seal`", function () {
      expect(section).to.contain("deterministic and sealable with the existing `vh evidence seal`");
      expect(section, "the canonical report kind is named").to.contain(agentCoverage.REPORT_KIND);
    });

    it("NOT-PROVES, VERBATIM: containment, NOT causation — per commit", function () {
      // The load-bearing sentence, pinned byte-for-byte IN THE SECTION (the acceptance requires it
      // verbatim; the commit-binding section's own copy does not count for the fleet claim).
      expect(section).to.contain("it does NOT prove the session's events produced the commit");
      expect(sectLow).to.match(/containment, not causation — per commit/);
    });

    it("NOT-PROVES, VERBATIM: an uncovered commit proves NOTHING about how it was authored — an INVENTORY control, not an authorship detector", function () {
      expect(section).to.contain(
        "An uncovered commit proves NOTHING about how it was authored: coverage is an INVENTORY control, not an authorship detector."
      );
    });

    it("NOT-PROVES: a redacted claim is not disclosable; `ts` self-asserted; NOT a trusted timestamp without P-3", function () {
      expect(sectLow).to.contain("a redacted claim is not disclosable");
      expect(sectLow).to.match(/`ts` is self-asserted/);
      expect(section).to.contain("NOT a trusted timestamp");
      expect(section).to.contain("P-3");
    });

    it("carries the code's in-band COVERAGE_TRUST_NOTE VERBATIM (the TRUST_NOTE discipline: doc == verdict wording)", function () {
      expect(doc, "docs/AGENTTRACE.md must quote COVERAGE_TRUST_NOTE byte-for-byte").to.contain(
        agent.COVERAGE_TRUST_NOTE
      );
      // Belt-and-braces: the note itself still says the load-bearing things this section leans on.
      expect(agent.COVERAGE_TRUST_NOTE).to.contain("INVENTORY control, NOT an authorship detector");
      expect(agent.COVERAGE_TRUST_NOTE).to.contain("containment, NOT causation");
      expect(agent.COVERAGE_TRUST_NOTE).to.contain("uncovered commit proves NOTHING about how it was authored");
      expect(agent.COVERAGE_TRUST_NOTE).to.contain("claim-unverified-packet");
    });

    it("draws the free line VERBATIM: coverage/CI-gate FREE; --sign UNCHANGED behind the existing gate", function () {
      expect(section).to.contain("Coverage and the CI gate are FREE");
      expect(section).to.contain("`--sign` is unchanged behind the existing gate");
      expect(evidencePlans.AGENT_SIGNED_CAPABILITY).to.equal("agent_signed");
      expect(section, "the gate is the REAL capability the code declares").to.contain(
        evidencePlans.AGENT_SIGNED_CAPABILITY
      );
      expect(sectLow, "no new human gate is claimed").to.match(/no new paid\s+surface and no new human gate/);
    });

    it("points at CI recipes that REALLY exist (generic + GitHub Actions)", function () {
      expect(section).to.contain("verifier/ci/agent-coverage.generic.sh");
      expect(section).to.contain("verifier/ci/agent-coverage.github-actions.yml");
      expect(fs.existsSync(GENERIC_SH), "the generic recipe must be shipped").to.equal(true);
      expect(fs.existsSync(GHA_YML), "the GH Actions example must be shipped").to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // (b) The scripted fleet flow REALLY runs, end-to-end, in a temp workdir.
  // -------------------------------------------------------------------------
  describe("(b) examples/agent-session/fleet-coverage.js — fixture repo → two sessions → claims → seal → coverage, failing then passing", function () {
    let tmpDirs;
    let cwdBefore;
    beforeEach(function () {
      tmpDirs = [];
      cwdBefore = fs.readdirSync(process.cwd()).sort();
    });
    afterEach(function () {
      for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
      // FILESYSTEM HYGIENE: nothing leaked into the working tree, pass or fail.
      expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
    });
    function tmp(prefix = "vh-fleet-docs-") {
      // realpath'd so "lands under --workdir" comparisons hold on hosts with a symlinked tmpdir.
      const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
      tmpDirs.push(d);
      return d;
    }
    function runScript(args, cwd) {
      try {
        return {
          status: 0,
          stdout: execFileSync(process.execPath, [SCRIPT, ...args], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }),
        };
      } catch (e) {
        return { status: e.status, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") };
      }
    }
    function runFlow() {
      const work = tmp("vh-fleet-docs-work-");
      const scratchCwd = tmp("vh-fleet-docs-cwd-"); // the script's cwd — must stay EMPTY
      const run = runScript(["--workdir", work], scratchCwd);
      expect(run.status, run.stderr || run.stdout).to.equal(0);
      // stdout is ONE machine-readable JSON summary line.
      expect(run.stdout.trim().split("\n")).to.have.lengthOf(1);
      const summary = JSON.parse(run.stdout);
      expect(fs.readdirSync(scratchCwd), "the script wrote NOTHING to its cwd").to.deep.equal([]);
      return { work, summary };
    }

    it("the script is committed and stays node-core + committed-fixture only (no new dependency)", function () {
      expect(fs.existsSync(SCRIPT), "examples/agent-session/fleet-coverage.js must be committed").to.equal(true);
      const src = fs.readFileSync(SCRIPT, "utf8");
      const required = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
      expect(required.length).to.be.greaterThan(0);
      const ALLOWED = new Set(["fs", "os", "path", "child_process", "./map-transcript"]);
      for (const r of required) {
        expect(ALLOWED.has(r), `node core + the committed mapper only, got require("${r}")`).to.equal(true);
      }
    });

    it("runs the documented fail-then-pass flow end-to-end — and the report is the canonical, re-derivable artifact", function () {
      const { work, summary } = runFlow();
      expect(summary.ok).to.equal(true);
      expect(summary.commits, "two distinct fixture commits").to.have.lengthOf(2);
      expect(new Set(summary.commits).size).to.equal(2);

      // COVERAGE #1: `--require-all` FAILED (exit 3) NAMING the uncovered commit — the gate blocks.
      expect(summary.firstRun.exit).to.equal(3);
      expect(summary.firstRun.pass).to.equal(false);
      expect(summary.firstRun.failures).to.deep.equal([
        { oid: summary.commits[1], rule: "require-all", status: "uncovered" },
      ]);

      // COVERAGE #2: once commit 2's session is sealed, `--deep --require-all` PASSES (exit 0) with
      // BOTH commits covered-verified — the strongest verdict, roots re-derived.
      expect(summary.secondRun.exit).to.equal(0);
      expect(summary.secondRun.pass).to.equal(true);
      expect(summary.secondRun.deep).to.equal(true);
      for (const oid of summary.commits) {
        expect(summary.secondRun.statuses[oid], `commit ${oid}`).to.equal("covered-verified");
      }

      // Every documented artifact exists, under the EXPLICIT --workdir (never cwd).
      for (const p of [summary.repo, summary.packetsDir, summary.packets.a, summary.packets.b, summary.report]) {
        expect(p.startsWith(work + path.sep), `${p} lands under --workdir`).to.equal(true);
        expect(fs.existsSync(p), `${p} exists`).to.equal(true);
      }

      // The --out report is EXACTLY the canonical vh-agent-coverage@1 bytes: the STRICT parser
      // accepts them and re-serializes byte-identically (so the file is sealable + byte-diffable).
      const bytes = fs.readFileSync(summary.report, "utf8");
      const parsed = agentCoverage.parseCoverageReport(bytes);
      expect(parsed.ok, JSON.stringify(parsed)).to.equal(true);
      expect(agentCoverage.serializeCoverageReport(parsed.report).json).to.equal(bytes);
      expect(parsed.report.verdict.pass).to.equal(true);
      expect(parsed.report.policy.requireAll).to.equal(true);
      // Oldest-first order — the fixture's two commits, exactly.
      expect(parsed.report.commits.map((c) => c.oid)).to.deep.equal(summary.commits);

      // The claim facts re-derive with the EXACT reused machinery (resolveCommit + hashGit): the
      // fixture work tree ends at commit 2, so its tracked-set root re-derives in place.
      expect(git.resolveCommit(summary.repo, "HEAD")).to.equal(summary.commits[1]);
      const commit2 = parsed.report.commits.find((c) => c.oid === summary.commits[1]);
      expect(commit2.claims[0].rootVerified).to.equal(true);
      expect(commit2.claims[0].gitRoot).to.equal(hashGit(summary.repo, { ref: summary.commits[1] }).root);
    });

    it("is DETERMINISTIC: a second run in a fresh workdir derives the same commits and byte-identical report bytes", function () {
      const a = runFlow();
      const b = runFlow();
      expect(b.summary.commits).to.deep.equal(a.summary.commits);
      expect(fs.readFileSync(b.summary.report, "utf8")).to.equal(fs.readFileSync(a.summary.report, "utf8"));
    });

    it("usage mistakes are exit 2 with a named error (unknown flag, valueless flag) — and nothing is written", function () {
      const scratchCwd = tmp("vh-fleet-docs-cwd-");
      const badFlag = runScript(["--bogus"], scratchCwd);
      expect(badFlag.status).to.equal(2);
      expect(badFlag.stderr).to.contain("unknown flag");
      const noValue = runScript(["--workdir"], scratchCwd);
      expect(noValue.status).to.equal(2);
      expect(noValue.stderr).to.contain("--workdir requires a value");
      const extra = runScript(["stray-positional"], scratchCwd);
      expect(extra.status).to.equal(2);
      expect(fs.readdirSync(scratchCwd)).to.deep.equal([]);
    });
  });

  // -------------------------------------------------------------------------
  // (c) Funnel pointers.
  // -------------------------------------------------------------------------
  describe("(c) pointers from README.md, docs/ADOPT.md, docs/PILOT.md's journeys list, and the example README", function () {
    it("README.md names the verb, states the inventory boundary, and links the section + the scripted flow + the CI recipes", function () {
      const readme = fs.readFileSync(README, "utf8");
      expect(readme).to.contain("vh agent coverage");
      expect(readme.toLowerCase()).to.match(/inventory control, not an authorship\s+detector/);
      expect(readme.toLowerCase()).to.match(/coverage: prove it\s+fleet-wide/);
      expect(readme).to.match(/\]\(examples\/agent-session\/fleet-coverage\.js\)/);
      expect(readme).to.contain("verifier/ci/agent-coverage.generic.sh");
    });

    it("docs/ADOPT.md points at the coverage section + the scripted flow + the CI recipes", function () {
      const adopt = fs.readFileSync(ADOPT, "utf8");
      expect(adopt).to.contain("vh agent coverage");
      expect(adopt.toLowerCase()).to.match(/coverage:\s+prove it fleet-wide/);
      expect(adopt.toLowerCase()).to.match(/inventory control, not an\s+authorship detector/);
      expect(adopt).to.contain("examples/agent-session/fleet-coverage.js");
      expect(adopt).to.contain("verifier/ci/agent-coverage.generic.sh");
    });

    it("docs/PILOT.md's journeys list names the fleet leg honestly (FREE gate; inventory control)", function () {
      const pilot = fs.readFileSync(PILOT, "utf8");
      const journeys = pilot.slice(pilot.indexOf("## 1. What you are evaluating"), pilot.indexOf("## 2."));
      expect(journeys).to.contain("vh agent coverage");
      expect(journeys.toLowerCase()).to.match(/inventory[\s>]+control, not an authorship detector/);
      expect(journeys).to.contain("fleet-coverage.js");
    });

    it("the example README documents the scripted fleet flow + its honest boundary", function () {
      const ex = fs.readFileSync(EXAMPLE_README, "utf8");
      expect(ex).to.contain("fleet-coverage.js");
      expect(ex).to.contain("--require-all");
      expect(ex.toLowerCase()).to.match(/inventory control, not an authorship detector/);
      expect(ex, "the containment sentence rides the example too").to.contain(
        "it does NOT prove the session's events produced the commit"
      );
      expect(ex.toLowerCase()).to.match(/uncovered commit\s+proves nothing about how it was authored/);
      expect(ex).to.contain("Coverage: prove it fleet-wide");
    });
  });

  // -------------------------------------------------------------------------
  // (d) NO P-1..P-11 human step deleted or relaxed; no new needs-human item.
  // -------------------------------------------------------------------------
  describe("(d) the standing human gates", function () {
    it("every P-1..P-11 proposal block still exists and still carries its needs-human status", function () {
      const strategy = fs.readFileSync(STRATEGY, "utf8");
      const header = strategy.search(/##\s*Proposals — needs-human/);
      expect(header, "the needs-human proposals section exists").to.be.greaterThan(-1);
      const proposals = strategy.slice(header);
      for (let n = 1; n <= 11; n++) {
        const id = `P-${n}`;
        const start = proposals.indexOf(`- **${id} (`);
        expect(start, `${id} proposal block still exists`).to.be.greaterThan(-1);
        const next = proposals.slice(start + 4).search(/\n- \*\*P-\d+ \(/);
        const block = next === -1 ? proposals.slice(start) : proposals.slice(start, start + 4 + next);
        expect(block, `${id} still carries its needs-human status (not relaxed)`).to.match(
          /\*Status:\s*needs-human/
        );
      }
    });

    it("the touched docs declare NO needs-human item of their own (this task adds no human gate)", function () {
      for (const [name, p] of [
        ["docs/AGENTTRACE.md", DOC],
        ["examples/agent-session/README.md", EXAMPLE_README],
      ]) {
        expect(fs.readFileSync(p, "utf8"), `${name} must not declare a needs-human proposal`).to.not.match(
          /\*Status:\s*needs-human/
        );
      }
    });
  });
});

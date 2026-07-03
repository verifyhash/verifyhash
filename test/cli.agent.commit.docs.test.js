"use strict";

// test/cli.agent.commit.docs.test.js — the ANTI-DRIFT acceptance suite for the commit-binding docs +
// the scripted worked example (T-69.3, the T-68.4 discipline).
//
// WHY THIS TEST EXISTS
//   docs/AGENTTRACE.md § "Binding a session to a git commit" is the buyer-facing statement of what a
//   commit-bound packet PROVES and — load-bearingly — what it does NOT. A boundary sentence that rots
//   is an overclaim (the exact failure mode this vertical exists to prevent), and a scripted example
//   that rots sends an adopter at commands that no longer work. So this suite does NOT trust the
//   prose; it PROVES, against the REAL code and a temp fixture git repo built inside the test:
//     (a) the doc pins the PROVES sentences (claim to exactly commit oid X with tracked-set root R at
//         position k; a clean checkout of X re-derives R via `vh hash <repo> --git`; redaction of any
//         other payload leaves the claim checkable) and the NOT-PROVES sentences VERBATIM —
//         containment-NOT-causation ("it does NOT prove the session's events produced the commit"),
//         not-faithful-recording, self-asserted `ts`, no trusted timestamp without P-3 — plus the
//         code's in-band COMMIT_CLAIM_TRUST_NOTE byte-for-byte, the free-vs-paid line (commit-claim /
//         verify-commit FREE; --sign unchanged behind the existing `agent_signed` gate), and the
//         honest standalone-page note (the zero-install page verifies the PACKET; the COMMIT facts
//         need git + a clone — the CLI is the auditor tool for that leg);
//     (b) examples/agent-session/commit-bound-session.js REALLY runs the documented flow — map →
//         commit-claim → seal → redact-all-but-claim → verify-commit — end-to-end against a temp
//         fixture repo (committed fixtures + node core + git only, offline), its facts re-derive with
//         the EXACT reused resolveCommit/hashGit, and the flow is evidentiary, not a happy-path demo
//         (dirty checkout → root-mismatch; redacted claim → no-disclosed-claim);
//     (c) the funnel pointers exist (README.md, docs/ADOPT.md, the example README);
//     (d) NO P-1..P-11 human step in STRATEGY.md was deleted or relaxed — and the touched docs declare
//         no needs-human item of their own.
//   Filesystem hygiene: every artifact lands in a throwaway temp dir (cleaned up pass or fail); the
//   suite asserts the working directory is left untouched.

const { expect } = require("chai");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const agent = require("../cli/agent");
const agentCommit = require("../cli/core/agent-commit");
const evidencePlans = require("../cli/core/evidence-plans");
const git = require("../cli/git");
const { hashGit } = require("../cli/hash");

const REPO = path.resolve(__dirname, "..");
const DOC = path.join(REPO, "docs", "AGENTTRACE.md");
const README = path.join(REPO, "README.md");
const ADOPT = path.join(REPO, "docs", "ADOPT.md");
const STRATEGY = path.join(REPO, "STRATEGY.md");
const EXAMPLE_DIR = path.join(REPO, "examples", "agent-session");
const EXAMPLE_README = path.join(EXAMPLE_DIR, "README.md");
const SCRIPT = path.join(EXAMPLE_DIR, "commit-bound-session.js");

const doc = fs.readFileSync(DOC, "utf8");

// The commit-binding section, sliced heading-to-next-H2 so every pin below anchors to THE section
// (not a stray mention elsewhere in the doc).
const SECTION_HEADING = "## Binding a session to a git commit";
const secStart = doc.indexOf(SECTION_HEADING);
const secEnd = secStart === -1 ? -1 : doc.indexOf("\n## ", secStart + SECTION_HEADING.length);
const section = secStart === -1 ? "" : secEnd === -1 ? doc.slice(secStart) : doc.slice(secStart, secEnd);
const sectLow = section.toLowerCase();

function capture() {
  const out = [];
  const err = [];
  return {
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

// Throwaway git fixture repos isolated from the host's global git config.
const GIT_ID = [
  "-c", "user.name=verifyhash-test",
  "-c", "user.email=test@verifyhash.invalid",
  "-c", "commit.gpgsign=false",
  "-c", "init.defaultBranch=main",
];
function runGit(cwd, args) {
  return execFileSync("git", [...GIT_ID, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("T-69.3: commit-binding docs + the scripted worked example — honest boundary, impossible to overclaim", function () {
  this.timeout(120000);

  // -------------------------------------------------------------------------
  // (a) docs/AGENTTRACE.md § "Binding a session to a git commit" — the pins.
  // -------------------------------------------------------------------------
  describe('(a) docs/AGENTTRACE.md § "Binding a session to a git commit"', function () {
    it("the section exists (heading + both verbs in the command surface)", function () {
      expect(secStart, `docs/AGENTTRACE.md must contain "${SECTION_HEADING}"`).to.be.greaterThan(-1);
      expect(doc).to.contain("vh agent commit-claim --repo");
      expect(doc).to.contain("vh agent verify-commit <packet> --repo");
    });

    it("PROVES: the sealed, unaltered log contains a claim to exactly commit oid X with tracked-set root R at position k", function () {
      expect(sectLow).to.match(
        /the sealed, unaltered log contains a claim to exactly commit oid x with tracked-set root r at\s+position k/
      );
    });

    it("PROVES: anyone with a clean checkout of X re-derives R via the shipped `vh hash <repo> --git` machinery", function () {
      expect(sectLow).to.match(/clean checkout of x re-derives r/);
      expect(section).to.contain("`vh hash <repo> --git`");
      // …and the doc names the honest dirty-checkout behavior (hashGit reads work-tree bytes).
      expect(sectLow).to.match(/dirty checkout[\s\S]{0,200}honest/);
      expect(section).to.contain("root-mismatch");
    });

    it("PROVES: redaction of any other payload leaves the claim checkable (and a redacted claim is no-disclosed-claim)", function () {
      expect(sectLow).to.contain("redaction of any other payload leaves the claim checkable");
      expect(section).to.contain("no-disclosed-claim");
    });

    it("NOT-PROVES, VERBATIM: containment, NOT causation — it does NOT prove the session's events produced the commit", function () {
      // The load-bearing sentence, pinned byte-for-byte (the acceptance requires it verbatim).
      expect(doc).to.contain("it does NOT prove the session's events produced the commit");
      expect(sectLow).to.match(/containment, not causation/);
    });

    it("NOT-PROVES: not faithful recording (garbage-in out of scope), `ts` self-asserted, NOT a trusted timestamp without P-3", function () {
      expect(sectLow).to.contain("not faithful recording");
      expect(sectLow).to.contain("garbage-in is out of scope");
      expect(sectLow).to.contain("`ts` is self-asserted");
      expect(section).to.contain("NOT a trusted timestamp");
      expect(section).to.contain("P-3");
    });

    it("carries the code's in-band COMMIT_CLAIM_TRUST_NOTE VERBATIM (the TRUST_NOTE discipline: doc == artifact wording)", function () {
      expect(doc, "docs/AGENTTRACE.md must quote COMMIT_CLAIM_TRUST_NOTE byte-for-byte").to.contain(
        agent.COMMIT_CLAIM_TRUST_NOTE
      );
      // Belt-and-braces: the note itself still says the load-bearing things this section leans on.
      expect(agent.COMMIT_CLAIM_TRUST_NOTE).to.contain("CONTAINMENT, NOT CAUSATION");
      expect(agent.COMMIT_CLAIM_TRUST_NOTE).to.contain("does NOT prove the session's events PRODUCED that commit");
      expect(agent.COMMIT_CLAIM_TRUST_NOTE).to.contain("SELF-ASSERTED");
    });

    it("draws the free-vs-paid line: commit-claim/verify-commit FREE; --sign UNCHANGED behind the existing gate", function () {
      expect(section).to.contain("FREE");
      expect(section).to.contain("`--sign` is unchanged behind the existing");
      expect(evidencePlans.AGENT_SIGNED_CAPABILITY).to.equal("agent_signed");
      expect(section, "the gate is the REAL capability the code declares").to.contain(
        evidencePlans.AGENT_SIGNED_CAPABILITY
      );
      expect(sectLow, "no new human gate is claimed").to.match(/no new paid surface and no new\s+human gate/);
    });

    it("states the standalone-page boundary honestly: the page verifies the PACKET; the COMMIT facts need git + a clone (the CLI is the auditor tool)", function () {
      expect(sectLow).to.contain("the zero-install page verifies the packet");
      expect(sectLow).to.contain("re-deriving the commit facts requires git + a clone");
      expect(sectLow).to.contain("is the auditor tool for that leg");
    });
  });

  // -------------------------------------------------------------------------
  // (b) The scripted flow REALLY runs, end-to-end, against a temp fixture repo.
  // -------------------------------------------------------------------------
  describe("(b) examples/agent-session/commit-bound-session.js — map → commit-claim → seal → redact-all-but-claim → verify-commit", function () {
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
    function tmp(prefix = "vh-commit-docs-") {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      tmpDirs.push(d);
      return d;
    }
    // The temp FIXTURE repo the flow binds to — built inside the test: git + node core only, offline.
    function makeRepo() {
      const dir = fs.realpathSync(tmp("vh-commit-docs-repo-"));
      runGit(dir, ["init", "-q"]);
      const files = {
        "README.md": "# fixture project\n",
        "src/index.js": "module.exports = 42;\n",
        "src/util/helper.js": "exports.h = () => 1;\n",
      };
      for (const [rel, content] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      }
      runGit(dir, ["add", "-A"]);
      runGit(dir, ["commit", "-q", "-m", "initial"]);
      return dir;
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

    it("the script is committed and stays node-core + committed-fixture only (no new dependency)", function () {
      expect(fs.existsSync(SCRIPT), "examples/agent-session/commit-bound-session.js must be committed").to.equal(true);
      const src = fs.readFileSync(SCRIPT, "utf8");
      const required = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
      expect(required.length).to.be.greaterThan(0);
      const ALLOWED = new Set(["fs", "os", "path", "child_process", "./map-transcript"]);
      for (const r of required) {
        expect(ALLOWED.has(r), `node core + the committed mapper only, got require("${r}")`).to.equal(true);
      }
    });

    it("runs the whole documented flow end-to-end against the temp fixture repo (offline, deterministic verdicts)", async function () {
      const repo = makeRepo();
      const work = tmp("vh-commit-docs-work-");
      const scratchCwd = tmp("vh-commit-docs-cwd-"); // the script's cwd — must stay EMPTY

      const run = runScript(["--repo", repo, "--workdir", work], scratchCwd);
      expect(run.status, run.stderr || run.stdout).to.equal(0);

      // stdout is ONE machine-readable JSON summary line.
      expect(run.stdout.trim().split("\n")).to.have.lengthOf(1);
      const summary = JSON.parse(run.stdout);
      expect(summary.ok).to.equal(true);
      expect(summary.verdict).to.equal("ACCEPTED");

      // The claim's facts re-derive with the EXACT reused machinery (resolveCommit + hashGit).
      expect(summary.claim.commit).to.equal(git.resolveCommit(repo, "HEAD"));
      expect(summary.claim.gitRoot).to.equal(hashGit(repo, {}).root);

      // Every documented artifact exists, under the EXPLICIT --workdir (never cwd).
      for (const k of ["events", "session", "packet", "redactedPacket"]) {
        expect(path.dirname(summary[k]), `${k} lands under --workdir`).to.equal(work);
        expect(fs.existsSync(summary[k]), `${k} artifact exists`).to.equal(true);
      }
      expect(fs.readdirSync(scratchCwd), "the script wrote NOTHING to its cwd").to.deep.equal([]);

      // The claim sits at the NEXT seq after the mapped events.
      const mapped = fs.readFileSync(summary.events, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
      expect(summary.claim.seq).to.equal(mapped.length);

      // redact-all-but-claim, verified against the bytes: every OTHER event withheld, the claim
      // disclosed and parseable, and the transcript's PII really GONE from the redacted packet.
      const redacted = JSON.parse(fs.readFileSync(summary.redactedPacket, "utf8"));
      const claimEvent = redacted.events.find((e) => e.seq === summary.claim.seq);
      expect(claimEvent.redacted, "the claim stays disclosed").to.not.equal(true);
      const parsed = agentCommit.parseCommitClaim(claimEvent.payload);
      expect(parsed.ok).to.equal(true);
      expect(parsed.claim.commit).to.equal(summary.claim.commit);
      expect(parsed.claim.gitRoot).to.equal(summary.claim.gitRoot);
      for (const e of redacted.events) {
        if (e.seq !== summary.claim.seq) expect(e.redacted, `seq ${e.seq} is withheld`).to.equal(true);
      }
      expect(fs.readFileSync(summary.redactedPacket, "utf8")).to.not.contain("customer_email");

      // The auditor leg re-checks IN-PROCESS via the real CLI entrypoint: ACCEPTED, claim matched.
      let io = capture();
      expect(
        await agent.cmdAgent(["verify-commit", summary.redactedPacket, "--repo", repo, "--json"], io),
        io.err()
      ).to.equal(0);
      const verdict = JSON.parse(io.out());
      expect(verdict.verdict).to.equal("ACCEPTED");
      expect(verdict.matched.seq).to.equal(summary.claim.seq);

      // EVIDENTIARY, not happy-path #1: a DIRTY checkout of the right commit is an HONEST
      // root-mismatch (exit 3, named) — and a restored clean tree ACCEPTs again.
      fs.writeFileSync(path.join(repo, "README.md"), "# tampered work tree\n");
      io = capture();
      expect(await agent.cmdAgent(["verify-commit", summary.redactedPacket, "--repo", repo, "--json"], io)).to.equal(3);
      expect(JSON.parse(io.out()).reason).to.equal("root-mismatch");
      runGit(repo, ["checkout", "--", "."]);
      io = capture();
      expect(await agent.cmdAgent(["verify-commit", summary.redactedPacket, "--repo", repo, "--json"], io)).to.equal(0);

      // EVIDENTIARY #2: redacting the CLAIM itself makes it undisclosable — no-disclosed-claim.
      const claimRedacted = path.join(work, "claim-redacted.vhagent.json");
      io = capture();
      expect(
        await agent.cmdAgent(
          ["redact", summary.packet, "--seq", String(summary.claim.seq), "--out", claimRedacted],
          io
        ),
        io.err()
      ).to.equal(0);
      io = capture();
      expect(await agent.cmdAgent(["verify-commit", claimRedacted, "--repo", repo, "--json"], io)).to.equal(3);
      expect(JSON.parse(io.out()).reason).to.equal("no-disclosed-claim");
    });

    it("usage mistakes are exit 2 with a named error (missing --repo, unknown flag) — and nothing is written", function () {
      const scratchCwd = tmp("vh-commit-docs-cwd-");
      const noRepo = runScript([], scratchCwd);
      expect(noRepo.status).to.equal(2);
      expect(noRepo.stderr).to.contain("--repo");
      const badFlag = runScript(["--repo", scratchCwd, "--bogus"], scratchCwd);
      expect(badFlag.status).to.equal(2);
      expect(badFlag.stderr).to.contain("unknown flag");
      expect(fs.readdirSync(scratchCwd)).to.deep.equal([]);
    });
  });

  // -------------------------------------------------------------------------
  // (c) Funnel pointers.
  // -------------------------------------------------------------------------
  describe("(c) pointers from README.md, docs/ADOPT.md, and the example README", function () {
    it("README.md names both verbs, states containment-not-causation, and links the scripted flow", function () {
      const readme = fs.readFileSync(README, "utf8");
      expect(readme).to.contain("commit-claim");
      expect(readme).to.contain("verify-commit");
      expect(readme.toLowerCase()).to.match(/containment, not causation/);
      expect(readme).to.match(/\]\(examples\/agent-session\/commit-bound-session\.js\)/);
      expect(readme).to.contain("Binding a session to a git commit");
    });

    it("docs/ADOPT.md points at the commit-binding section + the scripted flow", function () {
      const adopt = fs.readFileSync(ADOPT, "utf8");
      expect(adopt).to.contain("commit-claim");
      expect(adopt).to.contain("Binding a session to a git commit");
      expect(adopt).to.match(/\]\(AGENTTRACE\.md\)/);
      expect(adopt).to.contain("examples/agent-session/commit-bound-session.js");
    });

    it("the example README documents the scripted flow + its honest boundary", function () {
      const ex = fs.readFileSync(EXAMPLE_README, "utf8");
      expect(ex).to.contain("commit-bound-session.js");
      expect(ex).to.contain("redact");
      expect(ex).to.contain("verify-commit");
      expect(ex.toLowerCase()).to.match(/containment, not causation/);
      expect(ex, "the boundary sentence rides the example too").to.contain(
        "it does NOT prove the session's events"
      );
      expect(ex).to.contain("Binding a session to a git commit");
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

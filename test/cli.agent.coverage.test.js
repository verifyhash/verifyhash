"use strict";

// `vh agent coverage` (T-71.2) — the CLI verb + the CI gate shape over the PURE fleet-coverage
// core (cli/core/agent-coverage.js, T-71.1). FREE, read-only, key-less.
//
// What this proves (the T-71.2 acceptance criteria, each as an honest test):
//   (1) END-TO-END in a THROWAWAY temp git repo with pinned author/committer/date env (the
//       cli.hash.git.test.js discipline; offline, deterministic): 3 commits; sessions with claims
//       for commits 1 and 3 sealed via the SHIPPED verbs (`vh agent commit-claim` + `vh agent
//       seal`); `coverage --range` reports commit 2 `uncovered`, commits 1/3 `covered-oid-only`
//       (and the human output SAYS root-not-re-derived); with `--deep` both flip to
//       `covered-verified` and the temp clone is PROVEN removed — on success AND after an
//       injected failure.
//   (2) TAMPER MATRIX: one payload byte flipped inside a sealed packet → the FULL shipped verify
//       path rejects it, so its claim counts ONLY as `claim-unverified-packet` (never coverage),
//       the packet is NAMED in the report, and `--require-all` gates exit 3; a claim whose
//       gitRoot was edited BEFORE sealing (the packet itself verifies — the operator lied) →
//       `claim-root-mismatch` under `--deep` (named, never covered; without --deep the lie is
//       honestly invisible: covered-oid-only); an unknown `--range` → the NAMED git error, exit 2.
//   (3) POLICY EXITS on the shared contract: `--require-all` on the 2/3-covered fixture exits 3
//       (the failure NAMES commit 2), on the fully-covered fixture exits 0; report-only default
//       exits 0 either way; `--require-since` gates the range tail; `--out` writes the T-71.1
//       canonical report BYTES (parseCoverageReport round-trips them byte-identically).
//   (4) THE GENERIC CI RECIPE runs GREEN in-test against the fixture repo (the journal-ci example
//       discipline): `bash -n` valid, exit 0 on the fully-covered fixture via the REAL `vh`
//       command, exit 3 on the partial fixture (blocking the merge), exit 2 on missing env; the
//       GitHub Actions example is shipped and carries the gate + the honesty boundary.
//   (5) FREE SURFACE: NO paid gate is consulted anywhere in the coverage section (grep-proven
//       between the FREE-SURFACE markers); usage lines exist in `vh agent` help and `vh` help.
//
// Offline + deterministic: no chain, no provider, no network (the --deep clone is a LOCAL-path
// clone), no real key. Every write lands under a throwaway temp dir and is cleaned up.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const agent = require("../cli/agent");
const agentCommit = require("../cli/core/agent-commit");
const agentCoverage = require("../cli/core/agent-coverage");
const git = require("../cli/git");
const { hashGit } = require("../cli/hash");

const REPO = path.resolve(__dirname, "..");
const VH_BIN = path.join(REPO, "cli", "vh.js");
const GENERIC_SH = path.join(REPO, "verifier", "ci", "agent-coverage.generic.sh");
const GHA_YML = path.join(REPO, "verifier", "ci", "agent-coverage.github-actions.yml");

// ---------------------------------------------------------------------------
// Throwaway git repos with PINNED identity AND pinned author/committer dates, fully isolated from
// the host's global git config — deterministic on any machine / CI (the cli.hash.git.test.js
// discipline, extended with the date env pin).
// ---------------------------------------------------------------------------

const GIT_ID = [
  "-c", "user.name=verifyhash-test",
  "-c", "user.email=test@verifyhash.invalid",
  "-c", "commit.gpgsign=false",
  "-c", "init.defaultBranch=main",
];

function runGit(cwd, args, when = "2026-07-01T00:00:00Z") {
  return execFileSync("git", [...GIT_ID, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
}

function capture(extra = {}) {
  const out = [];
  const err = [];
  return Object.assign(
    {
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      out: () => out.join(""),
      err: () => err.join(""),
    },
    extra
  );
}

// A small, valid fixture session of `n` events (seqs 0..n-1) — the log each claim appends to.
function fixtureEvents(n) {
  const events = [];
  for (let i = 0; i < n; i++) {
    events.push({
      seq: i,
      ts: `2026-07-01T09:00:${String(i).padStart(2, "0")}.000Z`,
      actor: i % 2 === 0 ? "agent:assistant" : "tool:bash",
      type: i % 2 === 0 ? "prompt" : "completion",
      payload: JSON.stringify({ i, text: `payload #${i}` }),
    });
  }
  return events;
}

describe("cli/agent T-71.2: `vh agent coverage` — the fleet gate + CI recipes", function () {
  this.timeout(120000);

  // The SHARED fixture (built once — the coverage runs against it are all read-only):
  //   repo:       3 commits [o1, o2, o3] with pinned identity + dates;
  //   partialDir: sealed packets claiming commits 1 and 3 ONLY (the 2/3-covered fixture);
  //   fullDir:    sealed packets claiming all three commits (the fully-covered fixture).
  let baseTmp;
  let repo;
  let oids;
  let partialDir;
  let fullDir;
  let cwdBefore;

  let extraTmpDirs = [];
  function tmp(prefix = "vh-agent-coverage-test-") {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    extraTmpDirs.push(d);
    return d;
  }

  // Emit the claim for the repo's CURRENT HEAD via the SHIPPED verb, append it to a fresh fixture
  // session, and seal it via the SHIPPED verb into `<dir>/<name>.vhagent.json`.
  async function sealClaimPacket(dir, name) {
    const io1 = capture();
    let code = await agent.cmdAgent(
      ["commit-claim", "--repo", repo, "--seq", "2", "--ts", "2026-07-01T10:00:00.000Z", "--json"],
      io1
    );
    expect(code, io1.err()).to.equal(0);
    const claimLine = JSON.parse(io1.out()).artifact;
    const session = path.join(baseTmp, `${name}.session.jsonl`);
    fs.writeFileSync(
      session,
      fixtureEvents(2).map((e) => JSON.stringify(e)).join("\n") + "\n" + claimLine
    );
    const io2 = capture();
    code = await agent.cmdAgent(["seal", session, "--out", path.join(dir, `${name}.vhagent.json`)], io2);
    expect(code, io2.err()).to.equal(0);
  }

  before(async function () {
    cwdBefore = fs.readdirSync(process.cwd()).sort();
    baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), "vh-agent-coverage-fixture-"));
    repo = fs.realpathSync(fs.mkdtempSync(path.join(baseTmp, "repo-")));
    partialDir = path.join(baseTmp, "packets-partial");
    fullDir = path.join(baseTmp, "packets-full");
    fs.mkdirSync(partialDir);
    fs.mkdirSync(fullDir);

    runGit(repo, ["init", "-q"]);
    oids = [];
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(repo, "file.txt"), `content of commit ${i}\n`);
      fs.writeFileSync(path.join(repo, `c${i}.txt`), `file added by commit ${i}\n`);
      const when = `2026-07-01T00:0${i}:00Z`;
      runGit(repo, ["add", "-A"], when);
      runGit(repo, ["commit", "-q", "-m", `commit ${i}`], when);
      oids.push(runGit(repo, ["rev-parse", "HEAD"]).trim());
      // Claim + seal AT this commit (the work tree is exactly this commit's content — hashGit
      // reads work-tree bytes, so the sealed gitRoot is the honest root of commit i).
      await sealClaimPacket(fullDir, `session-${i}`);
      if (i !== 2) {
        fs.copyFileSync(
          path.join(fullDir, `session-${i}.vhagent.json`),
          path.join(partialDir, `session-${i}.vhagent.json`)
        );
      }
    }
    expect(new Set(oids).size).to.equal(3);
  });

  after(function () {
    if (baseTmp) fs.rmSync(baseTmp, { recursive: true, force: true });
    // FILESYSTEM HYGIENE: nothing the whole suite did leaked into the working tree.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });

  afterEach(function () {
    for (const d of extraTmpDirs) fs.rmSync(d, { recursive: true, force: true });
    extraTmpDirs = [];
  });

  // Run the coverage verb in-process with captured io; returns { code, io, json? }.
  async function runCoverage(args, extraIo = {}) {
    const io = capture(extraIo);
    const code = await agent.cmdAgent(["coverage", ...args], io);
    let json = null;
    if (args.includes("--json") && io.out().trim() !== "") json = JSON.parse(io.out());
    return { code, io, json };
  }

  function statusOf(report, oid) {
    const entry = report.commits.find((c) => c.oid === oid);
    expect(entry, `commit ${oid} missing from the report`).to.not.equal(undefined);
    return entry.status;
  }

  // =========================================================================
  // (1) End-to-end in the throwaway fixture repo.
  // =========================================================================

  describe("(1) end-to-end: 3 commits, claims sealed for commits 1 and 3 via the shipped verbs", function () {
    it("`coverage --range` (no --deep): commit 2 uncovered, commits 1/3 covered-oid-only; report-only exits 0", async function () {
      const { code, json } = await runCoverage(
        ["--repo", repo, "--range", "HEAD", "--packets", partialDir, "--json"]
      );
      expect(code).to.equal(0); // report-only default: exit 0 even though a commit is uncovered
      expect(json.ok).to.equal(true);
      expect(json.kind).to.equal(agentCoverage.REPORT_KIND);
      expect(json.deep).to.equal(false);
      // The ORDER is oldest-first (git rev-list --reverse) — the requireSince order the core pins.
      expect(json.report.commits.map((c) => c.oid)).to.deep.equal(oids);
      expect(statusOf(json.report, oids[0])).to.equal("covered-oid-only");
      expect(statusOf(json.report, oids[1])).to.equal("uncovered");
      expect(statusOf(json.report, oids[2])).to.equal("covered-oid-only");
      expect(json.summary.totalCommits).to.equal(3);
      expect(json.summary.coveredCommits).to.equal(2);
      expect(json.summary.uncoveredCommits).to.equal(1);
      expect(json.summary.deepCovered).to.equal(0);
      expect(json.summary.oidOnlyCovered).to.equal(2);
      expect(json.summary.pass).to.equal(true); // no policy -> vacuous pass
      // Both packets went through the FULL shipped verify path and are VERIFIED in the inventory.
      expect(json.packets).to.have.lengthOf(2);
      for (const p of json.packets) {
        expect(p.verified).to.equal(true);
        expect(p.claims).to.equal(1);
      }
    });

    it("the human output LEADS with the trust note and SAYS root-not-re-derived without --deep", async function () {
      const { code, io } = await runCoverage(["--repo", repo, "--range", "HEAD", "--packets", partialDir]);
      expect(code).to.equal(0);
      const out = io.out();
      expect(out.startsWith(agent.COVERAGE_TRUST_NOTE)).to.equal(true);
      expect(out).to.include("OID-ONLY");
      expect(out).to.include("root not re-derived");
      expect(out).to.include("uncovered");
      expect(out).to.include(oids[1]); // the uncovered commit is NAMED
      expect(out).to.include("containment, NOT causation");
      expect(out).to.include("INVENTORY control");
    });

    it("--deep flips commits 1/3 to covered-verified — and the temp clone is PROVEN removed on success", async function () {
      const temps = [];
      const { code, json } = await runCoverage(
        ["--repo", repo, "--range", "HEAD", "--packets", partialDir, "--deep", "--json"],
        { onTempClone: (p) => temps.push(p) }
      );
      expect(code).to.equal(0);
      expect(statusOf(json.report, oids[0])).to.equal("covered-verified");
      expect(statusOf(json.report, oids[1])).to.equal("uncovered");
      expect(statusOf(json.report, oids[2])).to.equal("covered-verified");
      expect(json.summary.deepCovered).to.equal(2);
      expect(json.summary.oidOnlyCovered).to.equal(0);
      // Exactly ONE throwaway clone dir, under the OS temp dir, and it is GONE afterwards.
      expect(temps).to.have.lengthOf(1);
      expect(temps[0].startsWith(fs.realpathSync(os.tmpdir()) + path.sep) ||
             temps[0].startsWith(os.tmpdir() + path.sep)).to.equal(true);
      expect(path.basename(temps[0])).to.match(/^vh-agent-coverage-/);
      expect(fs.existsSync(temps[0]), "the temp clone must be removed on success").to.equal(false);
      // The deep verdict is the SHIPPED hashGit root: re-derive commit 3's root independently.
      const claimed = json.report.commits.find((c) => c.oid === oids[2]).claims[0];
      expect(claimed.rootVerified).to.equal(true);
      expect(claimed.gitRoot).to.equal(hashGit(repo, { ref: oids[2] }).root);
    });

    it("--deep after an INJECTED failure: named error, exit 1, and the temp clone is STILL removed", async function () {
      const temps = [];
      const { code, io } = await runCoverage(
        ["--repo", repo, "--range", "HEAD", "--packets", partialDir, "--deep"],
        {
          // The injection: the hook fires right after mkdtemp; replacing the dir with a FILE makes
          // `git clone` fail (works whatever uid the suite runs as), exercising the failure path.
          onTempClone: (p) => {
            temps.push(p);
            fs.rmdirSync(p);
            fs.writeFileSync(p, "sabotage — the clone target is not a directory\n");
          },
        }
      );
      expect(code).to.equal(1); // an unexpected/IO failure is NEVER reported as a pass
      expect(io.err()).to.match(/--deep root re-derivation failed/);
      expect(io.err()).to.not.match(/\n\s+at /); // named error, never a stack trace
      expect(temps).to.have.lengthOf(1);
      expect(fs.existsSync(temps[0]), "the temp path must be removed on the failure path too").to.equal(false);
    });
  });

  // =========================================================================
  // (2) Tamper matrix.
  // =========================================================================

  describe("(2) tamper matrix", function () {
    it("one payload byte flipped in a packet → its claim counts ONLY as claim-unverified-packet, the packet is NAMED, --require-all gates exit 3", async function () {
      // A tampered copy of the partial fixture: flip one payload byte of a NON-claim event in the
      // commit-3 packet (the packet stays structurally valid; the FULL verify path rejects it).
      const dir = tmp();
      fs.copyFileSync(path.join(partialDir, "session-1.vhagent.json"), path.join(dir, "session-1.vhagent.json"));
      const packet = JSON.parse(fs.readFileSync(path.join(partialDir, "session-3.vhagent.json"), "utf8"));
      expect(typeof packet.events[0].payload).to.equal("string");
      packet.events[0].payload = packet.events[0].payload.replace("#0", "#X"); // ONE byte class of tamper
      fs.writeFileSync(path.join(dir, "session-3.vhagent.json"), JSON.stringify(packet) + "\n");

      const { code, json } = await runCoverage(
        ["--repo", repo, "--range", "HEAD", "--packets", dir, "--require-all", "--json"]
      );
      expect(code).to.equal(3); // the gate BLOCKS
      expect(json.ok).to.equal(false);
      // Commit 3's only claim rides the tampered packet: NEVER coverage, named as such.
      expect(statusOf(json.report, oids[2])).to.equal("claim-unverified-packet");
      const claimRow = json.report.commits.find((c) => c.oid === oids[2]).claims[0];
      expect(claimRow.packetVerified).to.equal(false);
      expect(claimRow.status).to.equal("claim-unverified-packet");
      // The packet is NAMED in the inventory with the verify path's named reason.
      const named = json.packets.find((p) => p.packet === "session-3.vhagent.json");
      expect(named.verified).to.equal(false);
      expect(named.reason).to.be.a("string").and.to.not.equal("");
      // Both gaps gate: commit 2 (uncovered) AND commit 3 (claim-unverified-packet).
      expect(json.report.verdict.pass).to.equal(false);
      expect(json.report.verdict.failures.map((f) => f.oid)).to.deep.equal([oids[1], oids[2]]);
      expect(json.report.verdict.failures[1].status).to.equal("claim-unverified-packet");
      expect(json.summary.unverifiablePackets).to.equal(1);

      // Report-only default still exits 0 — the tamper is REPORTED, the gate is opt-in.
      const reportOnly = await runCoverage(["--repo", repo, "--range", "HEAD", "--packets", dir, "--json"]);
      expect(reportOnly.code).to.equal(0);
      expect(statusOf(reportOnly.json.report, oids[2])).to.equal("claim-unverified-packet");
    });

    it("a claim whose gitRoot was edited (sealed lie) → claim-root-mismatch under --deep (named, NEVER covered)", async function () {
      // The operator seals a LYING claim: right commit oid, wrong gitRoot. The packet itself
      // VERIFIES (nothing was tampered after seal) — only --deep can surface the lie.
      const dir = tmp();
      const lying = agentCommit.commitClaimPayload({
        commit: oids[2],
        gitRoot: "0x" + "ab".repeat(32), // an edited/false tracked-set root
      });
      expect(lying.ok).to.equal(true);
      const session = path.join(dir, "lying.session.jsonl");
      const events = fixtureEvents(2);
      events.push({
        seq: 2,
        ts: "2026-07-01T10:00:00.000Z",
        actor: "agent",
        type: agentCommit.CLAIM_EVENT_TYPE,
        payload: lying.payload,
      });
      fs.writeFileSync(session, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      const ioSeal = capture();
      expect(
        await agent.cmdAgent(["seal", session, "--out", path.join(dir, "lying.vhagent.json")], ioSeal),
        ioSeal.err()
      ).to.equal(0);
      fs.rmSync(session);

      // WITHOUT --deep the lie is honestly invisible: the packet verifies, the root is simply not
      // re-derived this run — covered-oid-only (exactly what the trust note warns about).
      const shallow = await runCoverage(["--repo", repo, "--range", "HEAD", "--packets", dir, "--json"]);
      expect(shallow.code).to.equal(0);
      expect(statusOf(shallow.json.report, oids[2])).to.equal("covered-oid-only");

      // WITH --deep the re-derived root does not match: the NAMED discrepancy, never coverage.
      const deep = await runCoverage(
        ["--repo", repo, "--range", "HEAD", "--packets", dir, "--deep", "--require-all", "--json"]
      );
      expect(deep.code).to.equal(3);
      expect(statusOf(deep.json.report, oids[2])).to.equal("claim-root-mismatch");
      const row = deep.json.report.commits.find((c) => c.oid === oids[2]).claims[0];
      expect(row.packetVerified).to.equal(true);
      expect(row.rootVerified).to.equal(false);
      expect(deep.json.summary.discrepancies).to.equal(1);
      expect(deep.json.summary.coveredCommits).to.equal(0); // a mismatch NEVER counts as covered
      const failure = deep.json.report.verdict.failures.find((f) => f.oid === oids[2]);
      expect(failure.status).to.equal("claim-root-mismatch");
    });

    it("an unknown --range → the NAMED git error at exit 2 (never a stack trace)", async function () {
      const { code, io } = await runCoverage(
        ["--repo", repo, "--range", "no-such-ref..HEAD", "--packets", partialDir]
      );
      expect(code).to.equal(2);
      expect(io.err()).to.match(/unknown git range: no-such-ref\.\.HEAD/);
      expect(io.err()).to.match(/git rev-list could not enumerate it/);
      expect(io.err()).to.not.match(/\n\s+at /);
      expect(io.out()).to.equal("");
    });
  });

  // =========================================================================
  // (3) Policy verdict + exits on the shared contract; --out canonical bytes.
  // =========================================================================

  describe("(3) policy exits + the canonical --out artifact", function () {
    it("--require-all: exit 3 on the 2/3-covered fixture (naming commit 2), exit 0 on the fully-covered fixture; report-only 0 either way", async function () {
      const failing = await runCoverage(
        ["--repo", repo, "--range", "HEAD", "--packets", partialDir, "--require-all", "--json"]
      );
      expect(failing.code).to.equal(3);
      expect(failing.json.report.verdict.pass).to.equal(false);
      expect(failing.json.report.verdict.failures).to.deep.equal([
        { oid: oids[1], rule: "require-all", status: "uncovered" },
      ]);

      const passing = await runCoverage(
        ["--repo", repo, "--range", "HEAD", "--packets", fullDir, "--require-all", "--json"]
      );
      expect(passing.code).to.equal(0);
      expect(passing.json.report.verdict.pass).to.equal(true);
      expect(passing.json.summary.fullyCovered).to.equal(true);
      expect(passing.json.summary.coveragePercent).to.equal(100);

      // Report-only default: exit 0 on BOTH fixtures (the report carries the same facts).
      for (const dir of [partialDir, fullDir]) {
        const r = await runCoverage(["--repo", repo, "--range", "HEAD", "--packets", dir]);
        expect(r.code, dir).to.equal(0);
      }
    });

    it("--require-since gates the tail of the (oldest-first) range and resolves refs", async function () {
      // Since commit 3 (given as the ref HEAD — resolution proven): commit 2 is BEFORE it -> pass.
      const sinceHead = await runCoverage(
        ["--repo", repo, "--range", "HEAD", "--packets", partialDir, "--require-since", "HEAD", "--json"]
      );
      expect(sinceHead.code).to.equal(0);
      expect(sinceHead.json.report.policy.requireSince).to.equal(oids[2]);

      // Since commit 2: commit 2 itself is uncovered -> the require-since rule gates exit 3.
      const sinceMid = await runCoverage(
        ["--repo", repo, "--range", "HEAD", "--packets", partialDir, "--require-since", oids[1], "--json"]
      );
      expect(sinceMid.code).to.equal(3);
      expect(sinceMid.json.report.verdict.failures).to.deep.equal([
        { oid: oids[1], rule: "require-since", status: "uncovered" },
      ]);

      // A since-commit OUTSIDE the range cannot anchor the policy: named usage error, exit 2.
      const outside = await runCoverage(
        ["--repo", repo, "--range", "HEAD~1..HEAD", "--packets", partialDir, "--require-since", oids[0]]
      );
      expect(outside.code).to.equal(2);
      expect(outside.io.err()).to.match(/not IN the --range/);

      // An unresolvable --require-since is the named git error, exit 2.
      const garbage = await runCoverage(
        ["--repo", repo, "--range", "HEAD", "--packets", partialDir, "--require-since", "no-such-ref"]
      );
      expect(garbage.code).to.equal(2);
      expect(garbage.io.err()).to.match(/--require-since/);
      expect(garbage.io.err()).to.match(/unknown git ref/);
    });

    it("--out writes EXACTLY the canonical vh-agent-coverage@1 bytes — parseCoverageReport round-trips them", async function () {
      const dir = tmp();
      const outPath = path.join(dir, "coverage-report.json");
      const { code, json } = await runCoverage(
        ["--repo", repo, "--range", "HEAD", "--packets", partialDir, "--out", outPath, "--json"]
      );
      expect(code).to.equal(0);
      expect(json.out).to.equal(outPath);
      expect(json.artifact).to.equal(null); // with --out the bytes live in the file, not the envelope
      const bytes = fs.readFileSync(outPath, "utf8");
      // The STRICT inverse accepts the file bytes as-is: they ARE the one canonical representation.
      const parsed = agentCoverage.parseCoverageReport(bytes);
      expect(parsed.ok, JSON.stringify(parsed)).to.equal(true);
      expect(agentCoverage.serializeCoverageReport(parsed.report).json).to.equal(bytes);
      // And they carry the SAME report the --json envelope reported.
      expect(parsed.report).to.deep.equal(json.report);
    });

    it("usage/IO contract: missing flags exit 2; unknown flag exits 2; a non-repo --repo exits 1 named; a missing packets dir exits 1 named", async function () {
      const missing = [
        [["--range", "HEAD", "--packets", partialDir], /--repo/],
        [["--repo", repo, "--packets", partialDir], /--range/],
        [["--repo", repo, "--range", "HEAD"], /--packets/],
      ];
      for (const [args, re] of missing) {
        const r = await runCoverage(args);
        expect(r.code, args.join(" ")).to.equal(2);
        expect(r.io.err()).to.match(re);
      }
      const unknownFlag = await runCoverage(
        ["--repo", repo, "--range", "HEAD", "--packets", partialDir, "--frob"]
      );
      expect(unknownFlag.code).to.equal(2);
      expect(unknownFlag.io.err()).to.include("unknown flag: --frob");

      const positional = await runCoverage(
        ["stray", "--repo", repo, "--range", "HEAD", "--packets", partialDir]
      );
      expect(positional.code).to.equal(2);

      const notRepo = await runCoverage(["--repo", tmp(), "--range", "HEAD", "--packets", partialDir]);
      expect(notRepo.code).to.equal(1);
      expect(notRepo.io.err()).to.match(/not a git repos|not a git work tree/i);

      const noPackets = await runCoverage(
        ["--repo", repo, "--range", "HEAD", "--packets", path.join(baseTmp, "does-not-exist")]
      );
      expect(noPackets.code).to.equal(1);
      expect(noPackets.io.err()).to.match(/--packets/);
    });

    it("an EMPTY packets dir: every commit uncovered, report-only 0, --require-all 3, and the human output says so", async function () {
      const dir = tmp();
      const reportOnly = await runCoverage(["--repo", repo, "--range", "HEAD", "--packets", dir, "--json"]);
      expect(reportOnly.code).to.equal(0);
      expect(reportOnly.json.summary.uncoveredCommits).to.equal(3);
      const gated = await runCoverage(["--repo", repo, "--range", "HEAD", "--packets", dir, "--require-all"]);
      expect(gated.code).to.equal(3);
      expect(gated.io.out()).to.include("no *.vhagent.json under --packets");
    });
  });

  // =========================================================================
  // (4) The CI recipes (the journal-ci example discipline: the generic gate is DRIVEN in-test
  //     against the REAL command; the GH Actions file is a shipped, asserted example).
  // =========================================================================

  describe("(4) verifier/ci/agent-coverage.generic.sh — run against the real `vh` command", function () {
    // An executable `vh` wrapper so the shell gate runs the REAL CLI exactly as a user with `vh`
    // on PATH would (the journal.example.test.js pattern).
    function mkVhWrapper() {
      const dir = tmp("vh-bin-");
      const p = path.join(dir, "vh");
      fs.writeFileSync(p, `#!/usr/bin/env bash\nexec node ${JSON.stringify(VH_BIN)} "$@"\n`);
      fs.chmodSync(p, 0o755);
      return p;
    }

    function runGate(env) {
      try {
        const stdout = execFileSync("bash", [GENERIC_SH], {
          env: { ...process.env, ...env },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, stdout, stderr: "" };
      } catch (e) {
        return {
          code: typeof e.status === "number" ? e.status : 1,
          stdout: e.stdout ? e.stdout.toString() : "",
          stderr: e.stderr ? e.stderr.toString() : "",
        };
      }
    }

    it("is shipped, a real bash script, `bash -n` valid, and carries the env contract + the honesty boundary", function () {
      expect(fs.existsSync(GENERIC_SH), "agent-coverage.generic.sh must be shipped").to.equal(true);
      const src = fs.readFileSync(GENERIC_SH, "utf8");
      expect(src).to.match(/^#!.*\bbash\b/m);
      expect(src).to.match(/set -euo pipefail/);
      execFileSync("bash", ["-n", GENERIC_SH], { stdio: ["ignore", "pipe", "pipe"] });
      for (const envVar of ["VH_BIN", "VH_REPO", "VH_RANGE", "VH_PACKETS", "VH_DEEP", "VH_REQUIRE_ALL", "VH_REQUIRE_SINCE", "VH_OUT"]) {
        expect(src, `must document ${envVar}`).to.include(envVar);
      }
      expect(src).to.include("INVENTORY control");
      expect(src).to.match(/CONTAINMENT, not\s+causation/i);
      expect(src).to.include("P-3");
      expect(src).to.include("claim-unverified-packet");
      // Honest-posture consistency (mirrors journal.generic.sh): this producer-stack recipe must
      // NOT be conflated with the zero-install standalone verifier. It carries the INDEPENDENCE NOTE
      // naming what needs the producer package, and points the packet-verification leg at the
      // standalone bundle (verifier/README.md §2c).
      expect(src).to.include("INDEPENDENCE NOTE");
      expect(src).to.match(/PRODUCER package/);
      expect(src).to.match(/NOT part of the zero-install independent verifier/);
      expect(src).to.match(/verifier\/README\.md §2c/);
    });

    it("runs GREEN (exit 0) against the fully-covered fixture repo (the CI recipe, end-to-end)", function () {
      const r = runGate({
        VH_BIN: mkVhWrapper(),
        VH_REPO: repo,
        VH_RANGE: "HEAD",
        VH_PACKETS: fullDir,
      });
      expect(r.code, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).to.equal(0);
      expect(r.stdout).to.include("AgentTrace coverage — PASS");
      expect(r.stdout).to.include("policy: require-all");
    });

    it("exits 3 on the 2/3-covered fixture — a commit without a verifiable claim BLOCKS the merge", function () {
      const r = runGate({
        VH_BIN: mkVhWrapper(),
        VH_REPO: repo,
        VH_RANGE: "HEAD",
        VH_PACKETS: partialDir,
      });
      expect(r.code, `stdout: ${r.stdout}`).to.equal(3);
      expect(r.stdout).to.include("AgentTrace coverage — FAIL");
      expect(r.stdout).to.include(oids[1]); // the gating commit is NAMED
      expect(r.stderr).to.match(/blocking the merge/);
    });

    it("VH_REQUIRE_ALL=0 (report-only) exits 0 even on the partial fixture; missing env is exit 2", function () {
      const reportOnly = runGate({
        VH_BIN: mkVhWrapper(),
        VH_REPO: repo,
        VH_RANGE: "HEAD",
        VH_PACKETS: partialDir,
        VH_REQUIRE_ALL: "0",
      });
      expect(reportOnly.code, reportOnly.stderr).to.equal(0);

      const noRange = runGate({ VH_BIN: mkVhWrapper(), VH_PACKETS: partialDir });
      expect(noRange.code).to.equal(2);
      expect(noRange.stderr).to.match(/set VH_RANGE/);

      const noPackets = runGate({ VH_BIN: mkVhWrapper(), VH_RANGE: "HEAD" });
      expect(noPackets.code).to.equal(2);
      expect(noPackets.stderr).to.match(/set VH_PACKETS/);
    });

    it("the GitHub Actions example is shipped: triggers on push/pull_request, full-history checkout, the --require-all gate, the boundary", function () {
      expect(fs.existsSync(GHA_YML)).to.equal(true);
      const yml = fs.readFileSync(GHA_YML, "utf8");
      expect(yml).to.match(/^on:/m);
      expect(yml).to.match(/push:/);
      expect(yml).to.match(/pull_request:/);
      expect(yml).to.match(/jobs:/);
      expect(yml).to.match(/fetch-depth: 0/); // rev-list needs real history, not a shallow tip
      expect(yml).to.match(/vh agent coverage/);
      expect(yml).to.match(/--require-all/);
      // The honesty boundary rides the shipped example.
      expect(yml).to.include("INVENTORY control");
      expect(yml).to.match(/CONTAINMENT, not\s+causation/i);
      expect(yml).to.include("P-3");
      expect(yml).to.include("claim-unverified-packet");
      // The loop never executes workflows; the file is an example whose gate logic IS tested here.
      expect(yml).to.match(/the loop NEVER runs this file/);
      // Honest-posture consistency: the example must carry the same INDEPENDENCE NOTE as the generic
      // recipe — this producer-stack gate is NOT the zero-install standalone verifier.
      expect(yml).to.include("INDEPENDENCE NOTE");
      expect(yml).to.match(/PRODUCER package/);
      expect(yml).to.match(/NOT part of the zero-install independent verifier/);
      expect(yml).to.match(/verifier\/README\.md §2c/);
    });
  });

  // =========================================================================
  // (5) Free surface + wiring.
  // =========================================================================

  describe("(5) free surface (grep-proven) + usage wiring", function () {
    it("the coverage section consults NO paid gate: grep of the FREE-SURFACE-marked source slice", function () {
      const src = fs.readFileSync(path.join(REPO, "cli", "agent.js"), "utf8");
      const begin = src.indexOf("FREE-SURFACE-BEGIN");
      const end = src.indexOf("FREE-SURFACE-END");
      expect(begin, "FREE-SURFACE-BEGIN marker must exist").to.be.greaterThan(-1);
      expect(end, "FREE-SURFACE-END marker must exist").to.be.greaterThan(begin);
      const section = src.slice(begin, end);
      // The whole verb runs between the markers.
      expect(section).to.include("function runAgentCoverage(");
      expect(section).to.include("function deriveRootsViaTempClone(");
      // NO paid-gate machinery — not the gate function, not a license, not an entitlement, no key.
      expect(section).to.not.match(/gateAgentPaid/);
      expect(section).to.not.match(/licen[cs]e/i);
      expect(section).to.not.match(/vendor/i);
      expect(section).to.not.match(/entitlement/i);
      expect(section).to.not.match(/keyEnv|keyFile|key-env|key-file/);
      // And the POSITIVE reuse proof: the shipped verify path, the T-69.1 extractor verbatim,
      // the shipped hashGit engine, and the new listCommits enumerator.
      expect(section).to.match(/verifyPacket\(/);
      expect(section).to.match(/agentCommit\.findCommitClaims\(/);
      expect(section).to.match(/hashGit\(/);
      expect(section).to.match(/git\.listCommits\(/);
    });

    it("cli/git.js listCommits: oldest-first enumeration beside the existing plumbing; named error on an unknown range", function () {
      // Oldest-first over the fixture repo (rev-list --reverse).
      expect(git.listCommits(repo, "HEAD")).to.deep.equal(oids);
      // A bounded range; and an empty range is [] (valid), never an error.
      expect(git.listCommits(repo, "HEAD~1..HEAD")).to.deep.equal([oids[2]]);
      expect(git.listCommits(repo, "HEAD..HEAD")).to.deep.equal([]);
      // The named errors (same discipline as resolveCommit/listTrackedFiles).
      expect(() => git.listCommits(repo, "no-such..HEAD")).to.throw(/unknown git range/);
      expect(() => git.listCommits(repo, "")).to.throw(/empty git rev-range/);
    });

    it("usage lines exist in `vh agent` help and cli/vh.js top-level usage; the dispatcher routes `coverage`", async function () {
      const u = agent.agentUsage();
      expect(u).to.include("vh agent coverage --repo <dir> --range <rev-range> --packets <dir>");
      expect(u).to.include("--require-since <oid>");
      expect(u).to.include("claim-unverified-packet");
      expect(u).to.include("INVENTORY control");
      const vhSrc = fs.readFileSync(path.join(REPO, "cli", "vh.js"), "utf8");
      expect(vhSrc).to.include("vh agent coverage --repo <dir> --range <rev-range> --packets <dir>");
      // The dispatcher routes the verb (a bare `coverage` is a usage error naming --repo, not
      // an unknown-subcommand error) and the unknown-subcommand message now names it.
      const bare = capture();
      expect(await agent.cmdAgent(["coverage"], bare)).to.equal(2);
      expect(bare.err()).to.include("--repo");
      const unknown = capture();
      expect(await agent.cmdAgent(["frobnicate"], unknown)).to.equal(2);
      expect(unknown.err()).to.include("coverage");
    });
  });
});

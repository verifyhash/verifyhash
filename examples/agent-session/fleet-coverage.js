#!/usr/bin/env node
"use strict";

// examples/agent-session/fleet-coverage.js — the WORKED FLEET-COVERAGE flow, scripted (T-71.3).
//
// Answers the fleet question end-to-end with the shipped CLI, offline, inside a throwaway fixture:
// "across this commit range, WHICH changes carry a verifiable agent-session record — and fail my
// build when one doesn't." The flow is EVIDENTIARY, not a happy-path demo: the gate is shown
// FAILING on a real gap before it is shown passing.
//
//   1. FIXTURE REPO   a fresh git repo (inside --workdir, never your checkout) with pinned
//                     author/committer identity + dates, so every run derives the SAME oids;
//   2. SESSION A      commit 1 is made; `vh agent commit-claim` derives its oid + tracked-set root,
//                     the claim is appended to the mapped transcript, `vh agent seal` packets it;
//   3. THE GAP        commit 2 is made with NO session sealed for it;
//   4. COVERAGE #1    `vh agent coverage --require-all` — exit 3: the report NAMES commit 2 as
//                     `uncovered` and the gate BLOCKS (what your CI would do);
//   5. SESSION B      commit 2's session is claimed + sealed the same way;
//   6. COVERAGE #2    `vh agent coverage --deep --require-all --out <report>` — exit 0: both
//                     commits `covered-verified` (each root RE-DERIVED in a throwaway local clone),
//                     and the canonical vh-agent-coverage@1 report is written, byte-diffable and
//                     sealable with the existing `vh evidence seal`.
//
// DEPENDENCY posture (a test greps this): Node core only (`fs`/`os`/`path`/`child_process`) plus the
// sibling dependency-free mapper — every crypto/git step is the shipped `cli/vh.js` or `git` as a
// child process, exactly the commands an adopter runs by hand.
//
// HONESTY (the coverage boundary, verbatim in docs/AGENTTRACE.md › "Coverage: prove it fleet-wide"):
// a covered commit means the UNALTERED sealed log CONTAINS a disclosed claim naming exactly that
// commit — it does NOT prove the session's events produced the commit. An uncovered commit proves
// NOTHING about how it was authored: coverage is an INVENTORY control, not an authorship detector.
//
// Usage:
//   node examples/agent-session/fleet-coverage.js [--workdir <dir>] [--transcript <jsonl>]
// Every artifact (fixture repo included) lands under --workdir (or a fresh temp dir, printed on
// stderr) — NEVER the current directory. stdout is ONE machine-readable JSON summary line; progress
// rides stderr. Exit: 0 when the documented fail-then-pass flow holds / 2 usage / 1 any other
// failure (including a gate that did not behave as documented — this example never fakes a PASS).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { mapTranscript } = require("./map-transcript");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const VH = path.join(REPO_ROOT, "cli", "vh.js");

// Pinned identity + dates: the fixture is DETERMINISTIC — the same oids, the same claim bytes, and
// the same canonical coverage report on every run, on any machine.
const GIT_ID = [
  "-c", "user.name=verifyhash-example",
  "-c", "user.email=example@verifyhash.invalid",
  "-c", "commit.gpgsign=false",
  "-c", "init.defaultBranch=main",
];
const COMMIT_DATES = ["2026-07-01T00:01:00Z", "2026-07-01T00:02:00Z"];
const CLAIM_TS = "2026-07-01T10:00:00.000Z";

function runGit(cwd, args, when) {
  return execFileSync("git", [...GIT_ID, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
}

// Run one `vh` command, returning { status, stdout, stderr } WITHOUT throwing on a nonzero exit —
// the coverage gate is EXPECTED to exit 3 mid-flow, and that verdict (plus its --json report) is
// part of what this script demonstrates.
function vhRun(args) {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [VH, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (e) {
    if (typeof e.status !== "number") throw e;
    return { status: e.status, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") };
  }
}

// Run one `vh` command that MUST succeed; a nonzero exit is a named error carrying the step.
function vh(args, step) {
  const r = vhRun(args);
  if (r.status !== 0) {
    const err = new Error(`step ${step} failed (exit ${r.status}):\n${(r.stdout + r.stderr).trim()}`);
    err.step = step;
    throw err;
  }
  return r.stdout;
}

function main(argv, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  let workdir = null;
  let transcript = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workdir" || a === "--transcript") {
      const v = argv[++i];
      if (v === undefined) {
        writeErr(`error: ${a} requires a value\n`);
        return 2;
      }
      if (a === "--workdir") workdir = v;
      else transcript = v;
    } else if (a === "-h" || a === "--help") {
      write(
        "usage: node fleet-coverage.js [--workdir <dir>] [--transcript <jsonl>]\n" +
          "Scripted fleet-coverage flow: fixture repo -> two sessions -> claims -> seal -> coverage\n" +
          "(`--require-all` FAILING on the uncovered commit, then PASSING once its session is sealed).\n"
      );
      return 0;
    } else if (a.startsWith("--")) {
      writeErr(`error: unknown flag: ${a}\n`);
      return 2;
    } else {
      writeErr(`error: unexpected extra argument: ${a}\n`);
      return 2;
    }
  }

  try {
    if (workdir) {
      workdir = path.resolve(workdir);
      fs.mkdirSync(workdir, { recursive: true });
    } else {
      workdir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-fleet-coverage-"));
    }
    writeErr(`workdir: ${workdir} (every artifact lands here — never the current directory)\n`);

    // 1. FIXTURE REPO — fresh, pinned, inside the workdir. Two commits; each session is sealed while
    //    the work tree IS that commit's content (hashGit reads work-tree bytes, so each sealed
    //    gitRoot is the honest tracked-set root of the claimed commit).
    const repoRaw = path.join(workdir, "fleet-repo");
    if (fs.existsSync(repoRaw)) {
      throw new Error(`refusing to reuse ${repoRaw} — pass a fresh --workdir (the fixture repo must start empty)`);
    }
    fs.mkdirSync(repoRaw, { recursive: true });
    const repo = fs.realpathSync(repoRaw); // resolved once, so every derived path/oid comparison is stable
    const packetsDir = path.join(workdir, "packets");
    fs.mkdirSync(packetsDir, { recursive: true });
    runGit(repo, ["init", "-q"], COMMIT_DATES[0]);

    const transcriptPath = transcript
      ? path.resolve(transcript)
      : path.join(__dirname, "transcript.openai.jsonl");
    const events = mapTranscript(fs.readFileSync(transcriptPath, "utf8"));
    const eventsJsonl = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const claimSeq = events.length; // the claim is always the NEXT seq after the mapped events

    // Claim the repo's CURRENT HEAD into a session log and seal it into `<packetsDir>/<name>`.
    const sealSessionForHead = (name) => {
      const claim = JSON.parse(
        vh(
          ["agent", "commit-claim", "--repo", repo, "--seq", String(claimSeq), "--ts", CLAIM_TS, "--json"],
          `commit-claim (${name})`
        )
      );
      const sessionPath = path.join(workdir, `${name}.session.jsonl`);
      fs.writeFileSync(sessionPath, eventsJsonl + claim.artifact);
      const packetPath = path.join(packetsDir, `${name}.vhagent.json`);
      vh(["agent", "seal", sessionPath, "--out", packetPath, "--json"], `seal (${name})`);
      return { claim, sessionPath, packetPath };
    };

    // 2. COMMIT 1 + SESSION A — the covered change.
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "# fleet fixture\n");
    fs.writeFileSync(path.join(repo, "src", "service.js"), "module.exports = () => 'v1';\n");
    runGit(repo, ["add", "-A"], COMMIT_DATES[0]);
    runGit(repo, ["commit", "-q", "-m", "commit 1: the covered change"], COMMIT_DATES[0]);
    const oid1 = runGit(repo, ["rev-parse", "HEAD"], COMMIT_DATES[0]).trim();
    const sessionA = sealSessionForHead("session-a");
    writeErr(`1. SESSION A     commit ${oid1} claimed + sealed -> ${sessionA.packetPath}\n`);

    // 3. COMMIT 2, NO SESSION — the gap the gate must catch.
    fs.writeFileSync(path.join(repo, "src", "service.js"), "module.exports = () => 'v2';\n");
    fs.writeFileSync(path.join(repo, "src", "cache.js"), "exports.get = () => null;\n");
    runGit(repo, ["add", "-A"], COMMIT_DATES[1]);
    runGit(repo, ["commit", "-q", "-m", "commit 2: the gap (no session sealed)"], COMMIT_DATES[1]);
    const oid2 = runGit(repo, ["rev-parse", "HEAD"], COMMIT_DATES[1]).trim();
    writeErr(`2. THE GAP       commit ${oid2} made with NO session sealed\n`);

    // 4. COVERAGE #1 — `--require-all` MUST fail (exit 3) and NAME the uncovered commit. This is
    //    the CI gate blocking a merge; anything but that documented verdict is a hard error here.
    const first = vhRun([
      "agent", "coverage", "--repo", repo, "--range", "HEAD", "--packets", packetsDir,
      "--require-all", "--json",
    ]);
    if (first.status !== 3) {
      throw new Error(
        `coverage #1 was documented to gate exit 3 on the uncovered commit, got exit ${first.status}:\n` +
          (first.stdout + first.stderr).trim()
      );
    }
    const firstJson = JSON.parse(first.stdout);
    const firstFailures = firstJson.report.verdict.failures;
    if (!firstFailures.some((f) => f.oid === oid2 && f.status === "uncovered")) {
      throw new Error(`coverage #1 did not NAME commit ${oid2} as uncovered: ${JSON.stringify(firstFailures)}`);
    }
    writeErr(`3. COVERAGE #1   --require-all FAILED (exit 3) naming ${oid2} uncovered — the gate BLOCKS\n`);

    // 5. SESSION B — seal the missing session for commit 2 (the work tree IS commit 2).
    const sessionB = sealSessionForHead("session-b");
    writeErr(`4. SESSION B     commit ${oid2} claimed + sealed -> ${sessionB.packetPath}\n`);

    // 6. COVERAGE #2 — `--deep --require-all` MUST pass (exit 0): both commits covered-verified,
    //    each tracked-set root RE-DERIVED in a throwaway local clone; the canonical report written.
    const reportPath = path.join(workdir, "coverage-report.json");
    const second = vhRun([
      "agent", "coverage", "--repo", repo, "--range", "HEAD", "--packets", packetsDir,
      "--deep", "--require-all", "--out", reportPath, "--json",
    ]);
    if (second.status !== 0) {
      throw new Error(
        `coverage #2 was documented to pass (exit 0) once every commit carries a sealed claim, got ` +
          `exit ${second.status}:\n${(second.stdout + second.stderr).trim()}`
      );
    }
    const secondJson = JSON.parse(second.stdout);
    const statuses = {};
    for (const c of secondJson.report.commits) statuses[c.oid] = c.status;
    for (const oid of [oid1, oid2]) {
      if (statuses[oid] !== "covered-verified") {
        throw new Error(`coverage #2: commit ${oid} is ${statuses[oid]}, expected covered-verified (--deep)`);
      }
    }
    writeErr(`5. COVERAGE #2   --deep --require-all PASSED (exit 0); report -> ${reportPath}\n`);
    writeErr(
      "\nHONESTY — coverage is an INVENTORY control, not an authorship detector: a covered commit\n" +
        "means the unaltered sealed log CONTAINS a claim naming it (containment, NOT causation), and\n" +
        "an uncovered commit proves NOTHING about how it was authored (docs/AGENTTRACE.md).\n"
    );

    write(
      JSON.stringify({
        ok: true,
        workdir,
        repo,
        packetsDir,
        commits: [oid1, oid2],
        packets: { a: sessionA.packetPath, b: sessionB.packetPath },
        claimSeq,
        firstRun: {
          exit: first.status,
          pass: firstJson.report.verdict.pass,
          failures: firstFailures,
        },
        secondRun: {
          exit: second.status,
          pass: secondJson.report.verdict.pass,
          deep: secondJson.deep,
          statuses,
        },
        report: reportPath,
      }) + "\n"
    );
    return 0;
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main };

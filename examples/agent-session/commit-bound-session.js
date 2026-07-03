#!/usr/bin/env node
"use strict";

// examples/agent-session/commit-bound-session.js — the COMMIT-BOUND session flow, scripted (T-69.3).
//
// Drives the whole "bind an agent session to a git commit" journey end-to-end with the shipped CLI,
// offline, against a git checkout YOU name:
//
//   1. MAP           the committed third-party transcript into canonical events (map-transcript.js);
//   2. COMMIT-CLAIM  `vh agent commit-claim --repo <repo> --seq <next>` — derive the commit oid +
//                    the `vh hash --git` tracked-set root from YOUR checkout and append the ONE
//                    canonical claim event line to the session log;
//   3. SEAL          `vh agent seal` the claim-bearing log into ONE tamper-evident packet;
//   4. REDACT        `vh agent redact` EVERY event EXCEPT the claim — leaves and head UNCHANGED,
//                    the claim stays disclosed (redaction-safety, demonstrated);
//   5. VERIFY-COMMIT `vh agent verify-commit` the redacted packet against the same checkout — the
//                    auditor leg: FULL packet verification FIRST, then oid + root RE-DERIVED from
//                    the clone; ACCEPTED only if the disclosed claim matches.
//
// DEPENDENCY posture (a test greps this): Node core only (`fs`/`os`/`path`/`child_process`) plus the
// sibling dependency-free mapper — every crypto/git step is the shipped `cli/vh.js` as a child
// process, exactly the commands an adopter runs by hand.
//
// HONESTY (containment, NOT causation): the sealed packet proves the unaltered log CONTAINS a claim
// to exactly that commit oid + tracked-set root — it does NOT prove the session's events produced
// the commit. Full boundary: docs/AGENTTRACE.md › "Binding a session to a git commit".
//
// Usage:
//   node examples/agent-session/commit-bound-session.js --repo <git-checkout>
//       [--workdir <dir>] [--transcript <jsonl>]
// Every artifact lands under --workdir (or a fresh temp dir, printed on stderr) — NEVER the current
// directory. stdout is ONE machine-readable JSON summary line; progress rides stderr.
// Exit: 0 ACCEPTED / 3 verify-commit REJECTED (named reason) / 2 usage / 1 any other step failure.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { mapTranscript } = require("./map-transcript");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const VH = path.join(REPO_ROOT, "cli", "vh.js");

// Run one `vh` command as a child process; on failure throw a named error carrying the step,
// the child's exit code, and its combined output (so a REJECT verdict is never swallowed).
function vh(args, step) {
  try {
    return execFileSync(process.execPath, [VH, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const detail = `${e.stdout ? String(e.stdout) : ""}${e.stderr ? String(e.stderr) : ""}`.trim();
    const err = new Error(`step ${step} failed (exit ${e.status}):\n${detail}`);
    err.step = step;
    err.exitCode = typeof e.status === "number" ? e.status : 1;
    throw err;
  }
}

function main(argv, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));

  let repo = null;
  let workdir = null;
  let transcript = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo" || a === "--workdir" || a === "--transcript") {
      const v = argv[++i];
      if (v === undefined) {
        writeErr(`error: ${a} requires a value\n`);
        return 2;
      }
      if (a === "--repo") repo = v;
      else if (a === "--workdir") workdir = v;
      else transcript = v;
    } else if (a === "-h" || a === "--help") {
      write(
        "usage: node commit-bound-session.js --repo <git-checkout> [--workdir <dir>] [--transcript <jsonl>]\n" +
          "Scripted commit-bound AgentTrace flow: map -> commit-claim -> seal -> redact-all-but-claim -> verify-commit.\n"
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
  if (!repo) {
    writeErr("error: --repo <git-checkout> is required — the repo the commit-claim binds the session to\n");
    return 2;
  }
  repo = path.resolve(repo);

  try {
    if (workdir) {
      workdir = path.resolve(workdir);
      fs.mkdirSync(workdir, { recursive: true });
    } else {
      workdir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-commit-bound-"));
    }
    writeErr(`workdir: ${workdir} (every artifact lands here — never the current directory)\n`);

    // 1. MAP — the committed third-party transcript -> canonical events (the adopter's ~20 lines).
    const transcriptPath = transcript
      ? path.resolve(transcript)
      : path.join(__dirname, "transcript.openai.jsonl");
    const events = mapTranscript(fs.readFileSync(transcriptPath, "utf8"));
    const eventsJsonl = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const eventsPath = path.join(workdir, "events.jsonl");
    fs.writeFileSync(eventsPath, eventsJsonl);
    writeErr(`1. MAP           ${events.length} events -> ${eventsPath}\n`);

    // 2. COMMIT-CLAIM at the NEXT seq — oid + tracked-set root derived from YOUR checkout.
    const claimSeq = events.length;
    const claim = JSON.parse(
      vh(["agent", "commit-claim", "--repo", repo, "--seq", String(claimSeq), "--json"], "commit-claim")
    );
    const sessionPath = path.join(workdir, "session.jsonl");
    fs.writeFileSync(sessionPath, eventsJsonl + claim.artifact);
    writeErr(
      `2. COMMIT-CLAIM  seq ${claimSeq} — commit ${claim.commit}, tracked-set root ${claim.gitRoot}\n`
    );

    // 3. SEAL the claim-bearing log (free, unsigned, offline).
    const packetPath = path.join(workdir, "session.vhagent.json");
    vh(["agent", "seal", sessionPath, "--out", packetPath, "--json"], "seal");
    writeErr(`3. SEAL          ${packetPath}\n`);

    // 4. REDACT ALL BUT THE CLAIM — head unchanged; the claim stays disclosed.
    const redactedPath = path.join(workdir, "session.redacted.vhagent.json");
    const allButClaim = events.map((e) => e.seq).join(",");
    vh(["agent", "redact", packetPath, "--seq", allButClaim, "--out", redactedPath, "--json"], "redact");
    writeErr(`4. REDACT        seqs ${allButClaim} withheld -> ${redactedPath}\n`);

    // 5. VERIFY-COMMIT — the auditor leg, re-derived from the clone (a REJECT exits 3, named).
    const verdict = JSON.parse(
      vh(["agent", "verify-commit", redactedPath, "--repo", repo, "--json"], "verify-commit")
    );
    if (verdict.accepted !== true) {
      // Defensive: a REJECT already threw above (exit 3); never report a false ACCEPT.
      throw Object.assign(new Error(`verify-commit did not ACCEPT: ${JSON.stringify(verdict)}`), {
        step: "verify-commit",
        exitCode: 3,
      });
    }
    writeErr(`5. VERIFY-COMMIT ACCEPTED — disclosed claim (seq ${verdict.matched.seq}) matches the re-derived facts\n`);
    writeErr(
      "\nHONESTY — containment, NOT causation: the packet proves the unaltered log CONTAINS this claim;\n" +
        "it does NOT prove the session's events produced the commit (docs/AGENTTRACE.md).\n"
    );

    write(
      JSON.stringify({
        ok: true,
        verdict: verdict.verdict,
        workdir,
        repo,
        claim: { seq: claimSeq, commit: claim.commit, gitRoot: claim.gitRoot },
        events: eventsPath,
        session: sessionPath,
        packet: packetPath,
        redactedPacket: redactedPath,
      }) + "\n"
    );
    return 0;
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return e.step === "verify-commit" && e.exitCode === 3 ? 3 : 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main };

#!/usr/bin/env node
"use strict";

// challenge/corpus/run-corpus.js — T-52.2: the SELF-AUDITING CONFORMANCE RUNNER.
//
// WHY THIS FILE EXISTS
//   The corpus (T-52.1, challenge/corpus/) commits one CLEAN business packet per vertical plus one
//   POISONED packet per tamper class. That is the AMMUNITION. THIS file is the GUN: it drives EVERY
//   shipped verifier — the PRODUCER's own `vh evidence verify` AND the two INDEPENDENT offline
//   verifiers a counterparty actually runs (the single-file standalone bundle and the split-tree
//   `verify-vh.js`) — against EVERY poisoned artifact, and asserts the ONE load-bearing safety
//   invariant the whole product rests on:
//
//        NO verifier EVER returns ACCEPT (exit 0) on a poisoned input.
//
//   It is the buyer's answer to "how do I know your verifier won't say ACCEPT on something it
//   shouldn't?" — mechanical, runnable in seconds, trusting nothing but `node` and the bytes on disk.
//   And it is a permanent REGRESSION FLOOR: if any future refactor ever opens a false-ACCEPT hole in
//   ANY verifier, this runner goes RED.
//
// WHAT IT ASSERTS (per poisoned class, per applicable verifier)
//   * The cardinal rule, no exceptions: exit 0 on a poisoned input is a FALSE ACCEPT — always a FAIL.
//   * Beyond that, each verifier has its OWN documented REJECT contract (the set of acceptable
//     non-zero exit codes for a given mutation kind), and the runner checks the verifier rejected
//     WITHIN its contract — so a verifier that rejects "by accident" with the wrong failure mode is
//     still flagged. The independent verifiers RE-DERIVE the root and return 3 (tamper) or 2
//     (unrecognized seal kind); the producer's `vh evidence verify` STRUCTURALLY validates the seal
//     first and surfaces a forged root / corrupt kind as a validation error (exit 1) before it ever
//     reaches byte re-derivation. Both are honest REJECTs; neither is ever a 0.
//
// THE GATE HAS TEETH
//   The companion test (test/challenge.corpus.run.test.js) injects a SYNTHETIC verifier that wrongly
//   ACCEPTS a poisoned input and proves the runner then exits 1, NAMING the offending class + verifier.
//   A gate that cannot fail proves nothing.
//
// USAGE
//   node challenge/corpus/run-corpus.js            # human report; exit 0 PASS / 1 FAIL
//   node challenge/corpus/run-corpus.js --json      # stable machine-readable result on stdout
//   node challenge/corpus/run-corpus.js --quiet      # suppress the per-class report, keep the summary
//
// POSTURE — READ-ONLY. It spawns each verifier in a CHILD PROCESS with NODE_PATH cleared (proving the
//   independent verifiers need nothing outside Node core), reads only the committed corpus, and writes
//   NOTHING. It is overridable for tests via env (VH_CORPUS_DIR, VH_RUN_VERIFIERS) but defaults to the
//   committed tree and the real shipped verifiers.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// ---- exit contract (this runner's OWN aggregate contract) -----------------------------------------
//   0 = PASS  (every applicable verifier REJECTED every poisoned input within its contract)
//   1 = FAIL  (a verifier ACCEPTED a poisoned input, or rejected with an out-of-contract exit, or a
//              corpus/config error made the gate unrunnable — a gate that cannot run is not a PASS)
const RUN_EXIT = Object.freeze({ PASS: 0, FAIL: 1 });

const CORPUS_DIR = process.env.VH_CORPUS_DIR
  ? path.resolve(process.env.VH_CORPUS_DIR)
  : __dirname;
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ---- the shipped verifiers this runner drives -----------------------------------------------------
//
// Each verifier is one shipped entry point. `argv(sealAbs, dirAbs)` returns the FULL child argv (the
// node script path first, then its args) so producer (a subcommand) and independent (a bare script)
// invoke uniformly. `tier` is "producer" or "independent" — the runner prints a per-tier ✓ and the
// invariant must hold for BOTH tiers.
//
// `rejectExits(mutationOp)` is this verifier's DOCUMENTED reject contract: the set of acceptable
// NON-ZERO exit codes for that tamper kind. 0 is NEVER in any set (that is the cardinal false-ACCEPT
// rule, enforced separately and unconditionally below).
const DEFAULT_VERIFIERS = [
  {
    id: "independent-standalone",
    tier: "independent",
    label: "verifier/dist/verify-vh-standalone.js (single-file, zero-dep, offline)",
    script: path.join(REPO_ROOT, "verifier", "dist", "verify-vh-standalone.js"),
    argv(sealAbs, dirAbs) {
      return [this.script, sealAbs, "--dir", dirAbs];
    },
    // The independent verifiers RE-DERIVE the root: tamper -> 3, unrecognized seal kind -> 2 (usage).
    rejectExits(op) {
      return op === "edit-seal-kind" ? [2] : [3];
    },
  },
  {
    id: "independent-intree",
    tier: "independent",
    label: "verifier/verify-vh.js (split-tree, js-sha3 only, offline)",
    script: path.join(REPO_ROOT, "verifier", "verify-vh.js"),
    argv(sealAbs, dirAbs) {
      return [this.script, sealAbs, "--dir", dirAbs];
    },
    rejectExits(op) {
      return op === "edit-seal-kind" ? [2] : [3];
    },
  },
  {
    id: "producer",
    tier: "producer",
    label: "vh evidence verify (the producer's own CLI verifier)",
    script: path.join(REPO_ROOT, "cli", "vh.js"),
    argv(sealAbs, dirAbs) {
      return [this.script, "evidence", "verify", sealAbs, "--dir", dirAbs];
    },
    // The producer STRUCTURALLY validates the seal first: a byte tamper still re-derives to a clean
    // REJECTED (3); but a forged root / corrupt kind is caught as an internal-consistency / wrong-kind
    // VALIDATION error (exit 1) BEFORE byte re-derivation. Both are honest non-zero REJECTs.
    rejectExits(op) {
      if (op === "edit-seal-root" || op === "edit-seal-kind") return [1];
      return [3];
    },
  },
];

// Allow the test harness to inject/override the verifier set (e.g. a synthetic false-ACCEPT verifier
// to prove the gate has teeth) without touching this file. VH_RUN_VERIFIERS is a path to a CJS module
// exporting an array of verifier descriptors in the same shape as DEFAULT_VERIFIERS.
function loadVerifiers() {
  if (process.env.VH_RUN_VERIFIERS) {
    const mod = require(path.resolve(process.env.VH_RUN_VERIFIERS));
    const list = typeof mod === "function" ? mod({ REPO_ROOT, CORPUS_DIR }) : mod;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error("VH_RUN_VERIFIERS must export a non-empty array (or a factory returning one)");
    }
    return list;
  }
  return DEFAULT_VERIFIERS;
}

function readManifest() {
  const p = path.join(CORPUS_DIR, "manifest.json");
  if (!fs.existsSync(p)) throw new Error(`corpus manifest not found: ${p}`);
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  if (m.kind !== "vh.challenge-corpus" || !Array.isArray(m.classes) || m.classes.length === 0) {
    throw new Error(`not a usable corpus manifest (kind=${JSON.stringify(m.kind)})`);
  }
  return m;
}

// Drive ONE verifier against ONE poisoned class. Returns a per-result record. The single hard rule:
// exit 0 is a FALSE ACCEPT (pass=false, reason="false-accept"); otherwise pass iff the non-zero exit
// is within the verifier's documented reject contract for that mutation op.
function runOne(verifier, cls) {
  const sealAbs = path.join(CORPUS_DIR, cls.seal);
  const dirAbs = path.join(CORPUS_DIR, cls.poisonedPacket);
  const argv = verifier.argv(sealAbs, dirAbs);
  const child = spawnSync(process.execPath, argv, {
    encoding: "utf8",
    // Clear NODE_PATH so the independent verifiers cannot reach this repo's node_modules — proving the
    // zero-install claim, not assuming it. (The producer require()s in-tree relative modules only.)
    env: { ...process.env, NODE_PATH: "" },
  });

  const exit = child.status;
  const allowed = verifier.rejectExits(cls.mutationOp);

  let pass;
  let reason;
  if (exit === 0) {
    // The cardinal rule — a poisoned input that VERIFIES is the one failure the whole corpus exists to
    // catch. Always a FAIL, regardless of any per-verifier contract.
    pass = false;
    reason = "FALSE-ACCEPT (verifier returned exit 0 / VERIFIED on a poisoned input)";
  } else if (exit === null) {
    // Killed by signal / failed to spawn — not a clean reject; the gate cannot vouch for this.
    pass = false;
    reason = `verifier did not exit cleanly (signal=${child.signal || "?"}, error=${
      child.error ? child.error.message : "n/a"
    })`;
  } else if (allowed.includes(exit)) {
    pass = true;
    reason = `REJECTED (exit ${exit}, within contract {${allowed.join(",")}})`;
  } else {
    // Rejected, but with an UNEXPECTED failure mode (e.g. an IO error where we documented a tamper
    // reject). Not a false accept, but a contract drift the gate must surface, not hide.
    pass = false;
    reason = `REJECTED but OUT-OF-CONTRACT (exit ${exit}, expected one of {${allowed.join(",")}})`;
  }

  return {
    classId: cls.id,
    vertical: cls.vertical,
    mutationOp: cls.mutationOp,
    verifier: verifier.id,
    tier: verifier.tier,
    exit,
    allowed,
    pass,
    falseAccept: exit === 0,
    reason,
  };
}

// Run the full matrix: every applicable verifier x every poisoned class. Returns the aggregate result.
function runCorpus(opts = {}) {
  const manifest = readManifest();
  const verifiers = opts.verifiers || loadVerifiers();

  const results = [];
  for (const cls of manifest.classes) {
    for (const v of verifiers) {
      results.push(runOne(v, cls));
    }
  }

  const failures = results.filter((r) => !r.pass);
  const falseAccepts = failures.filter((r) => r.falseAccept);

  // Per-class roll-up: a class PASSES iff every verifier rejected it within contract.
  const byClass = {};
  for (const r of results) {
    (byClass[r.classId] = byClass[r.classId] || []).push(r);
  }
  const classSummaries = manifest.classes.map((cls) => {
    const rs = byClass[cls.id] || [];
    return {
      classId: cls.id,
      vertical: cls.vertical,
      mutationOp: cls.mutationOp,
      pass: rs.length > 0 && rs.every((r) => r.pass),
      verifiers: rs.map((r) => ({ verifier: r.verifier, tier: r.tier, exit: r.exit, pass: r.pass })),
    };
  });

  return {
    kind: "vh.corpus-run-result",
    corpusVersion: manifest.corpusVersion,
    ok: failures.length === 0,
    classCount: manifest.classes.length,
    verifierCount: verifiers.length,
    checkCount: results.length,
    falseAcceptCount: falseAccepts.length,
    failureCount: failures.length,
    verifiers: verifiers.map((v) => ({ id: v.id, tier: v.tier, label: v.label })),
    classes: classSummaries,
    failures: failures.map((r) => ({
      classId: r.classId,
      verifier: r.verifier,
      tier: r.tier,
      exit: r.exit,
      reason: r.reason,
    })),
    results,
  };
}

// ---- presentation ---------------------------------------------------------------------------------
function printHuman(out, write) {
  write("==============================================================");
  write(" VerifyHash adversarial CONFORMANCE corpus — self-audit runner");
  write("==============================================================");
  write("");
  write(`corpus v${out.corpusVersion} — ${out.classCount} tamper classes x ${out.verifierCount} verifiers = ${out.checkCount} checks`);
  write("Verifiers driven (every poisoned artifact is run against EACH):");
  for (const v of out.verifiers) write(`  - [${v.tier}] ${v.id}: ${v.label}`);
  write("");
  write("Per-class verdict (every verifier must REJECT — exit 0 is a FALSE ACCEPT):");
  write("--------------------------------------------------------------");
  for (const c of out.classes) {
    const mark = c.pass ? "✓" : "✗"; // ✓ / ✗
    const detail = c.verifiers
      .map((v) => `${v.tier}/${v.verifier}=${v.pass ? `reject(${v.exit})` : `FAIL(exit ${v.exit})`}`)
      .join("  ");
    write(`  ${mark} ${c.classId.padEnd(30)} [${c.mutationOp}]  ${detail}`);
  }
  write("--------------------------------------------------------------");
  if (out.ok) {
    write(`PASS — all ${out.checkCount} checks REJECTED. No verifier ever accepted a poisoned input.`);
  } else {
    write(`FAIL — ${out.failureCount} check(s) did not REJECT within contract (${out.falseAcceptCount} FALSE ACCEPT):`);
    for (const f of out.failures) {
      write(`  ✗ class=${f.classId} verifier=${f.tier}/${f.verifier}: ${f.reason}`);
    }
  }
}

function main(argv) {
  const wantJson = argv.includes("--json");
  const quiet = argv.includes("--quiet");
  let out;
  try {
    out = runCorpus();
  } catch (e) {
    // A corpus/config error is a FAIL: a gate that cannot run must never look like a PASS.
    if (wantJson) {
      process.stdout.write(
        JSON.stringify({ kind: "vh.corpus-run-result", ok: false, error: String(e.message || e) }, null, 2) + "\n"
      );
    } else {
      process.stderr.write(`run-corpus: ERROR: ${e.message || e}\n`);
    }
    return RUN_EXIT.FAIL;
  }

  if (wantJson) {
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } else if (!quiet) {
    printHuman(out, (l) => process.stdout.write(l + "\n"));
  } else {
    process.stdout.write(
      (out.ok ? "PASS" : "FAIL") + ` — ${out.checkCount} checks, ${out.failureCount} failure(s)\n`
    );
  }

  return out.ok ? RUN_EXIT.PASS : RUN_EXIT.FAIL;
}

module.exports = { runCorpus, runOne, DEFAULT_VERIFIERS, RUN_EXIT, CORPUS_DIR };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

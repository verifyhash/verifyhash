#!/usr/bin/env node
"use strict";

// examples/journal-ci.js — a runnable, DEPENDENCY-FREE CONTINUOUS-INTEGRITY CI STEP that treats the
// `vh journal` append-only, hash-chained integrity journal as a DROP-IN dependency (T-60.3).
//
// THE POINT
//   Every other verifyhash surface answers "do these exact bytes match this seal RIGHT NOW?" and exits.
//   The INTEGRITY JOURNAL is the structurally-new shape: each CI run APPENDS one verify verdict to an
//   append-only, hash-chained log, and re-VERIFIES the whole chain. The log is ITSELF tamper-evident, so a
//   deleted / edited / reordered / inserted past entry BREAKS the chain and `vh journal verify` LOCALIZES
//   the first break. That is the "verified CONTINUOUSLY from run A to run B" artifact a one-shot verify
//   cannot produce — a standing record a recipient RE-RUNS, not a one-time event.
//
//   This file is the smallest honest DROP-IN of that step. It:
//     (1) builds + serializes a seal over an in-memory file set with the PUBLIC SDK, and writes the sealed
//         bytes + the seal packet to a throwaway workdir (what a real build produces);
//     (2) shells out ONCE per run to `vh journal append <packet> --to <journal>` — recording this run's
//         verdict as ONE new hash-chained line, STRICTLY ADDITIVELY (prior lines are never rewritten);
//     (3) runs `vh journal verify <journal>` — reporting an UNBROKEN chain (exit 0);
//   then prints an APPEND then a VERIFY line and exits 0. A CI system copies this ~150 lines to keep a
//   standing, verifiable integrity record that grows one entry per build.
//
// WHAT IT IMPORTS (asserted by test/journal.example.test.js — a grep proves this is the WHOLE list)
//   * `require("verifyhash")`  — the SINGLE public entrypoint (index.js, via package "exports"). Used ONLY
//                                to BUILD + serialize the seal the journal will record a verdict for. No
//                                deep `cli/…` reach-in — the pure journal CORE (cli/journal.js) is NOT
//                                imported; the example reaches the journal purely through the COMMAND.
//   * the `vh journal` COMMAND — spawned as a child process via the package's own declared `bin.vh` path
//                                (read from verifyhash's package.json — NOT a hard-coded `cli/…` path).
//   * Node built-ins ONLY (`fs`, `os`, `path`, `child_process`) — NO third-party dependency, NO `ethers`.
//   There is NO other require: the example depends on the PUBLIC package + the PUBLIC command + Node —
//   exactly what an external CI integrator has.
//
// TRUST BOUNDARY (the example will not let you overclaim)
//   A PASS means "every recorded observation is authentic + in order, and each verdict was ACCEPTED"
//   (tamper-evidence OVER TIME). The `ts` on each entry is SELF-ASSERTED — the verifier's OWN wall clock,
//   NOT a trusted timestamp — so the journal NEVER claims "unaltered since date T" on its own; that claim
//   needs a trust-root that signs/timestamps the `ts` (STRATEGY.md P-3). See docs/INTEGRITY-JOURNAL.md.
//
// RUN IT
//   node examples/journal-ci.js     # appends two entries, verifies an UNBROKEN chain, exits 0
//
// It is test-gated by test/journal.example.test.js on every `npx hardhat test`, so it can never rot.

// The public package entrypoint — resolved BY NAME through package.json "exports" (Node's self-reference
// makes this identical to what an npm installer sees). Used ONLY to BUILD + serialize the seal.
const vh = require("verifyhash");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// Resolve the `vh journal` COMMAND from the package's OWN declared `bin.vh`, not a hard-coded cli/ path.
// require.resolve("verifyhash/package.json") is allowed by the "exports" map; from it we read the bin entry
// the package itself declares, so the example runs exactly the command an installer would put on the PATH.
function resolveVhBin() {
  const pkgPath = require.resolve("verifyhash/package.json");
  const pkg = require(pkgPath);
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin && pkg.bin.vh;
  if (!binRel) throw new Error("verifyhash package.json does not declare a `vh` bin");
  return path.join(path.dirname(pkgPath), binRel);
}

// A tiny in-memory { relPath, bytes } file set — the shape buildSeal accepts. A CI step seals the bytes it
// already produced (a build artifact) and records a verify verdict for them in the standing journal.
const ENTRIES = [
  { relPath: "dist/app.js", bytes: Buffer.from("console.log('build 1');\n") },
  { relPath: "dist/app.css", bytes: Buffer.from("body{margin:0}\n") },
  { relPath: "README.md", bytes: Buffer.from("# release\n") },
];

// Materialize the sealed bytes + the seal packet under `dir` (what a real build leaves on disk). `vh journal
// append` re-reads these bytes off disk and RE-DERIVES the root, so they must be present for an ACCEPTED
// verdict — the journal records what it actually saw, not what we claim.
function writeWorkspace(dir, entries, seal) {
  for (const e of entries) {
    const abs = path.join(dir, e.relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, e.bytes);
  }
  const packet = path.join(dir, "release.vhevidence.json");
  fs.writeFileSync(packet, vh.serializeSeal(seal));
  return packet;
}

// Run `vh <args...>` as a child process and return { code, stdout, stderr }. Pure Node `child_process` — a
// CI integrator drops exactly this shell-out into their pipeline (or calls the `vh` binary directly).
function runVh(binVh, args) {
  const r = spawnSync("node", [binVh, ...args], { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// The demo. Returns a structured result so a test can assert on DATA, not only stdout.
function runExample(out = console.log) {
  const log = (line = "") => out(line);
  const binVh = resolveVhBin();

  log("verifyhash integrity-journal CI step — append this run's verdict, then verify the WHOLE chain.");
  log(`using verifyhash public API v${vh.apiVersion} (require("verifyhash") + the vh journal command + Node).`);
  log("");
  log("TRUST NOTE: a PASS means every recorded observation is authentic + in order and each verdict was");
  log("ACCEPTED (tamper-evidence OVER TIME). The `ts` is SELF-ASSERTED (the verifier's own wall clock), NOT");
  log('a trusted timestamp — the journal never claims "unaltered since date T" on its own (P-3).');
  log("");

  // A throwaway workspace + journal. In real CI the JOURNAL FILE is PERSISTED across runs (cached, committed,
  // or stored as a build artifact) so the chain GROWS one entry per build; here we use a fresh dir so the
  // example is self-contained and exits clean.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-journal-ci-"));
  let result;
  try {
    // Build + serialize the seal this run will record a verdict for. This is the PUBLIC SDK path.
    const seal = vh.buildSeal(ENTRIES);
    const sealObj = vh.readSeal(vh.serializeSeal(seal)); // parsed form (fileCount lives on the packet)
    const packet = writeWorkspace(dir, ENTRIES, seal);
    const journal = path.join(dir, "integrity.jsonl");
    log(`[build] sealed ${sealObj.files.length} files; Merkle root = ${seal.root}`);

    // (1) APPEND run #1's observation — a genesis (seq 0) entry, STRICTLY ADDITIVELY. Exit 0 = clean append.
    const a1 = runVh(binVh, ["journal", "append", packet, "--to", journal, "--dir", dir, "--ts", "2026-07-01T00:00:00.000Z"]);
    if (a1.code !== 0) throw new Error(`journal append #1 exited ${a1.code}; stderr:\n${a1.stderr}`);
    log(`[append] run 1 -> ${a1.stdout.trim().split("\n")[0]}`);

    // (2) APPEND run #2's observation — the recurring re-check. It chains onto seq 0 (seq 1), demonstrating a
    //     GROWING, continuous record. This is the touchpoint a one-shot verify cannot produce.
    const a2 = runVh(binVh, ["journal", "append", packet, "--to", journal, "--dir", dir, "--ts", "2026-07-01T01:00:00.000Z"]);
    if (a2.code !== 0) throw new Error(`journal append #2 exited ${a2.code}; stderr:\n${a2.stderr}`);
    log(`[append] run 2 -> ${a2.stdout.trim().split("\n")[0]}`);

    // (3) VERIFY the whole standing chain. 0 = PASS (unbroken + every observation ACCEPTED) — the SHARED 0/3
    //     verify contract (3 would mean a broken chain or a recorded drift; the CI gate blocks on non-zero).
    const v = runVh(binVh, ["journal", "verify", journal]);
    if (v.code !== 0) throw new Error(`journal verify exited ${v.code}; output:\n${v.stdout}${v.stderr}`);
    log(`[verify] ${v.stdout.trim()}`);

    const entryCount = fs
      .readFileSync(journal, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "").length;

    result = {
      apiVersion: vh.apiVersion,
      root: seal.root,
      fileCount: sealObj.files.length,
      appendExit: 0,
      entryCount,
      verifyExit: v.code,
      verifyStdout: v.stdout,
    };
  } finally {
    // ALWAYS clean the throwaway workspace (pass or fail) — nothing leaks past the example's run.
    fs.rmSync(dir, { recursive: true, force: true });
  }

  log("");
  log(`RESULT: PASS — appended ${result.entryCount} hash-chained entries, verify reports an UNBROKEN chain (exit 0).`);
  return result;
}

// Run when invoked directly (`node examples/journal-ci.js`); export for the test harness.
if (require.main === module) {
  try {
    runExample();
    process.exit(0);
  } catch (err) {
    console.error(`journal-ci example FAILED: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}

module.exports = { runExample, ENTRIES };

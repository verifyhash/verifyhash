"use strict";

// test/verifier.reproduce-ci-snippet.test.js — the ANTI-ROT acceptance suite for the shipped
// REPRODUCE-FROM-SOURCE CI gate snippets (T-54.3 rework).
//
// WHY THIS TEST EXISTS — "who verifies the verifier?", wired into a pipeline
//   The §0b reproduce-from-source answer (`node verifier/build-standalone.js --check`) is the strongest
//   honest trust claim verifyhash makes: "don't trust our binary or our checksum — reproduce both, and
//   every source file that composes them, from the source you just read." But a one-time hand-run is a
//   one-time read. A paying customer's security/procurement team wants that answer as a PINNED,
//   AUTOMATABLE control: a gate that re-confirms on EVERY build that the verifier they depend on still
//   reproduces byte-for-byte from the source they audited, so a supply-chain swap of the verifier ITSELF
//   fails their build. verifyhash ships TWO copy-paste snippets that do exactly that:
//     * verifier/ci/reproduce-vh.generic.sh        — a portable `set -e` shell gate (GitLab CI / Makefile
//                                                     / any shell step) that runs `--check` and passes its
//                                                     exit code straight through.
//     * verifier/ci/reproduce-vh.github-actions.yml — a GitHub Actions workflow EXAMPLE.
//   A snippet that drifts from `--check`'s real behaviour is worse than no snippet — it gives a customer
//   false confidence. So this suite does NOT re-implement the gate; it RUNS the shipped files VERBATIM (the
//   generic.sh as-is; the EXACT `run:` command extracted from the YAML) and PROVES, on a real COPY of the
//   verifier tree the test controls:
//     * the gate EXITS 0 on a clean checkout (the verifier reproduces -> allow the merge);
//     * flipping ONE byte of an inlined source file (lib/merkle.js) makes the gate EXIT NON-ZERO and the
//       report NAME that exact source file (-> block the merge);
//     * flipping ONE byte of a committed BUNDLE makes the gate EXIT NON-ZERO (-> block the merge);
//     * the snippets install NO producer stack (no ethers/hardhat) and need NO `npm install` at all;
//     * the buyer-facing docs LINK both snippets (so the docs and the shipped files cannot diverge).
//
// FILESYSTEM HYGIENE
//   All work lands under throwaway temp dirs cleaned in afterEach (pass or fail). `--check` is read-only
//   and the snippets are read-only; the real tree is never mutated.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const VERIFIER_DIR = path.join(REPO, "verifier");
const GENERIC_SH = path.join(VERIFIER_DIR, "ci", "reproduce-vh.generic.sh");
const GHA_YML = path.join(VERIFIER_DIR, "ci", "reproduce-vh.github-actions.yml");
const VERIFIER_README = path.join(VERIFIER_DIR, "README.md");

describe("verifier reproduce-from-source CI gate snippets (T-54.3)", function () {
  // Copying the verifier tree + child spawns is a touch slow; give headroom.
  this.timeout(60000);

  let tmpDirs;
  beforeEach(function () {
    tmpDirs = [];
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-reproduce-ci-"));
    tmpDirs.push(d);
    return d;
  }

  // Copy the WHOLE verifier/ tree into a fresh temp dir so a corruption test mutates a COPY only. Returns
  // the copied repo root (so a snippet path like ./verifier/build-standalone.js resolves the same way it
  // would in a partner's checkout).
  function copyVerifierTreeIntoRepo() {
    const root = mkTmp();
    fs.cpSync(VERIFIER_DIR, path.join(root, "verifier"), { recursive: true });
    return root;
  }

  // Run a shell FILE (the shipped generic.sh) with env overrides + a chosen cwd, capturing exit + stdio
  // (never throwing on non-zero). NODE_PATH is cleared so the gate exercises only what ships.
  function runShell(file, env, cwd) {
    try {
      const stdout = execFileSync("bash", [file], {
        env: { ...process.env, NODE_PATH: "", ...env },
        cwd: cwd || REPO,
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

  // Run a raw `command [args...]` via bash with env overrides + cwd; capture exit + stdio.
  function runCommand(command, env, cwd) {
    try {
      const stdout = execFileSync("bash", ["-c", command], {
        env: { ...process.env, NODE_PATH: "", ...env },
        cwd: cwd || REPO,
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

  // ===============================================================================================
  // THE GENERIC SHELL SNIPPET — executed VERBATIM (the shipped file itself).
  // ===============================================================================================
  describe("reproduce-vh.generic.sh (the shipped portable shell gate, run verbatim)", function () {
    it("is shipped, executable, and a real `set -e` shell script that runs `--check` and NOTHING heavier", function () {
      expect(fs.existsSync(GENERIC_SH), "reproduce-vh.generic.sh must be shipped").to.equal(true);
      const src = fs.readFileSync(GENERIC_SH, "utf8");
      expect(src).to.match(/^#!.*\bbash\b/m);
      expect(src).to.match(/set -euo pipefail/);
      // The only thing it runs is `node <build-standalone.js> --check`.
      expect(src).to.contain("build-standalone.js");
      expect(src).to.match(/node "\$BUILD_STANDALONE" --check/);
      // It must NOT pull the producer stack or RUN any install/network step. (The header comment
      // legitimately says the words "no `npm install`", so we assert on a real command line — a `run`/
      // executed `npm ci|install ...` — not mere mention.)
      expect(src).to.not.match(/require\(['"](ethers|hardhat)/);
      expect(src).to.not.match(/^\s*npm (ci|install)\b/m);
      expect(src).to.not.match(/\bnpx hardhat\b/);
    });

    it("EXITS 0 on a clean checkout (the verifier reproduces -> merge allowed)", function () {
      const repo = copyVerifierTreeIntoRepo();
      const r = runShell(GENERIC_SH, {}, repo);
      expect(r.code, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).to.equal(0);
      expect(r.stdout).to.match(/ALL MATCH/);
    });

    it("EXITS NON-ZERO and NAMES the source file when ONE byte of lib/merkle.js is flipped (-> merge blocked)", function () {
      const repo = copyVerifierTreeIntoRepo();
      const src = path.join(repo, "verifier", "lib", "merkle.js");
      const bytes = fs.readFileSync(src);
      bytes[100] = bytes[100] ^ 0x01; // ONE byte of an audited source file
      fs.writeFileSync(src, bytes);

      const r = runShell(GENERIC_SH, {}, repo);
      expect(r.code, `stdout: ${r.stdout}`).to.not.equal(0);
      // The gate localizes the failure to the exact audited source file...
      expect(r.stdout).to.match(/\[MISMATCH\] sources->manifest: .*verifier\/lib\/merkle\.js/);
      // ...and announces the block on stderr.
      expect(r.stderr).to.match(/FAILED \(exit 1\) — the verifier does NOT reproduce from source; blocking the merge\./);
    });

    it("EXITS NON-ZERO when ONE byte of a committed BUNDLE is flipped (-> merge blocked)", function () {
      const repo = copyVerifierTreeIntoRepo();
      const bundle = path.join(repo, "verifier", "dist", "verify-vh-standalone.js");
      const bytes = fs.readFileSync(bundle);
      bytes[0] = bytes[0] ^ 0xff; // ONE byte of the committed bundle
      fs.writeFileSync(bundle, bytes);

      const r = runShell(GENERIC_SH, {}, repo);
      expect(r.code).to.not.equal(0);
      expect(r.stdout).to.match(/\[MISMATCH\] bundle  dist\/verify-vh-standalone\.js:/);
    });

    it("a missing build-standalone.js is a clean error (exit 1) — never a silent pass", function () {
      const r = runShell(GENERIC_SH, { BUILD_STANDALONE: "/no/such/build-standalone.js" }, REPO);
      expect(r.code).to.equal(1);
      expect(r.stderr).to.match(/build-standalone\.js not found/);
    });
  });

  // ===============================================================================================
  // THE GITHUB ACTIONS YAML — we NEVER run the workflow; we EXTRACT the exact gate command from its
  // `run:` block and execute THAT one string, proving the shipped example actually works.
  // ===============================================================================================
  describe("reproduce-vh.github-actions.yml (the shipped GH Actions example)", function () {
    // Pull the single shell command out of the gate step's `run:` block (a `run: |` block scalar).
    function extractGateCommand(yml) {
      const lines = yml.split("\n");
      const idx = lines.findIndex((l) => /^\s*run:\s*\|\s*$/.test(l));
      expect(idx, "could not find a `run: |` block in the YAML").to.be.greaterThan(-1);
      const indent = lines[idx].match(/^(\s*)/)[1].length;
      const body = [];
      for (let i = idx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "") continue;
        const lead = line.match(/^(\s*)/)[1].length;
        if (lead <= indent) break; // dedent ends the block scalar
        body.push(line.slice(indent + 2));
      }
      return body.join("\n").trim();
    }

    it("is a shipped workflow that triggers on push/pull_request and names the gate job", function () {
      expect(fs.existsSync(GHA_YML)).to.equal(true);
      const yml = fs.readFileSync(GHA_YML, "utf8");
      expect(yml).to.match(/^on:/m);
      expect(yml).to.match(/pull_request:/);
      expect(yml).to.match(/jobs:/);
      expect(yml).to.match(/reproduce-vh:/);
    });

    it("installs NO producer stack and runs no `npm install` (the gate needs nothing but Node core)", function () {
      const yml = fs.readFileSync(GHA_YML, "utf8");
      // No STEP runs an install — `--check` depends on nothing but Node core. (The header comment
      // legitimately says "needs no `npm install`", so we assert no `run:` line invokes one, not that the
      // words never appear.)
      const runLines = yml.split("\n").filter((l) => /^\s*(run:|-\s|\S)/.test(l) && !/^\s*#/.test(l));
      for (const l of runLines) {
        expect(l, `no install step: ${l}`).to.not.match(/\bnpm (ci|install)\b/);
      }
      expect(yml).to.not.match(/\bnpx hardhat\b/);
      expect(yml).to.not.match(/\b(ethers|@nomicfoundation)\b/);
    });

    it("the EXACT gate command extracted from the YAML EXITS 0 on a clean checkout", function () {
      const yml = fs.readFileSync(GHA_YML, "utf8");
      const cmd = extractGateCommand(yml);
      expect(cmd).to.contain("build-standalone.js");
      expect(cmd).to.contain("--check");

      const repo = copyVerifierTreeIntoRepo();
      // The YAML references `verifier/build-standalone.js` relative to the repo root; run with cwd = the
      // copied repo so the shipped path resolves exactly as in a partner's checkout.
      const r = runCommand(cmd, {}, repo);
      expect(r.code, `stderr: ${r.stderr}\ncmd: ${cmd}`).to.equal(0);
      expect(r.stdout).to.match(/ALL MATCH/);
    });

    it("the EXACT gate command extracted from the YAML EXITS NON-ZERO when a source byte is flipped", function () {
      const yml = fs.readFileSync(GHA_YML, "utf8");
      const cmd = extractGateCommand(yml);

      const repo = copyVerifierTreeIntoRepo();
      const src = path.join(repo, "verifier", "lib", "canonical.js");
      fs.writeFileSync(src, fs.readFileSync(src, "utf8") + "\n// tamper\n");
      const r = runCommand(cmd, {}, repo);
      expect(r.code, `cmd: ${cmd}`).to.not.equal(0);
      expect(r.stdout).to.match(/\[MISMATCH\] sources->manifest: .*verifier\/lib\/canonical\.js/);
    });

    it("the YAML gate command is the SAME `--check` the generic.sh gate runs (one source of truth)", function () {
      const yml = fs.readFileSync(GHA_YML, "utf8");
      const cmd = extractGateCommand(yml);
      const sh = fs.readFileSync(GENERIC_SH, "utf8");
      // Both gates run `build-standalone.js ... --check`; neither adds any other verifier surface. (The
      // YAML names the path literally; the shell file runs it via $BUILD_STANDALONE.)
      expect(cmd).to.match(/build-standalone\.js --check/);
      expect(sh).to.match(/build-standalone\.js/);
      expect(sh).to.match(/node "\$BUILD_STANDALONE" --check/);
    });
  });

  // ===============================================================================================
  // DOCS LINK THE SNIPPETS (so the shipped files and the buyer-facing docs cannot silently diverge).
  // ===============================================================================================
  describe("docs link the shipped reproduce-from-source snippets", function () {
    it("verifier/README.md links both reproduce ci/ snippets from the §0b bootstrap section", function () {
      const md = fs.readFileSync(VERIFIER_README, "utf8");
      expect(md).to.contain("ci/reproduce-vh.generic.sh");
      expect(md).to.contain("ci/reproduce-vh.github-actions.yml");
    });
  });
});

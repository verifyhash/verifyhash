"use strict";

// test/verifier.ci-snippet.test.js — the ANTI-ROT acceptance suite for the shipped CI merge-gate
// snippets (T-33.2).
//
// WHY THIS TEST EXISTS
//   verifyhash ships TWO copy-paste CI snippets a design partner drops into their pipeline to make a
//   tampered/forged artifact FAIL THE BUILD on every merge:
//     * verifier/ci/verify-vh.generic.sh        — a portable `set -e` shell gate (GitLab CI / Makefile /
//                                                  any shell step) configured purely by env vars.
//     * verifier/ci/verify-vh.github-actions.yml — a GitHub Actions workflow EXAMPLE.
//   A snippet that drifts from the verifier's real behaviour is worse than no snippet — it gives a
//   partner false confidence. So this suite does NOT re-implement the gate; it EXTRACTS the command the
//   shipped files actually run and PROVES, on REAL fixtures produced by the REAL producer code path:
//     * the generic shell snippet, run verbatim, EXITS 0 on a good release and EXITS 3 on a tampered one;
//     * the EXACT `run:` command line shipped in the GitHub Actions YAML does the same;
//     * the YAML installs ONLY the standalone verifier (js-sha3), never the producer's ethers/hardhat;
//     * the buyer docs LINK the snippets (so the docs and the shipped files cannot silently diverge).
//   Every key is an EPHEMERAL Wallet.createRandom() (TEST-ONLY — never a real key / real funds). The
//   loop NEVER runs the YAML itself; we only execute the single command STRING extracted from it.
//
// FILESYSTEM HYGIENE
//   All fixtures land under throwaway temp dirs cleaned in afterEach (pass or fail). The snippets are
//   read-only and the verifier writes nothing.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { Wallet } = require("ethers");

const trustSeal = require("../trustledger/seal");

const REPO = path.resolve(__dirname, "..");
const VERIFY_VH = path.join(REPO, "verifier", "verify-vh.js");
const GENERIC_SH = path.join(REPO, "verifier", "ci", "verify-vh.generic.sh");
const GHA_YML = path.join(REPO, "verifier", "ci", "verify-vh.github-actions.yml");
const VERIFIER_README = path.join(REPO, "verifier", "README.md");
const INDEP_DOC = path.join(REPO, "docs", "INDEPENDENT-VERIFICATION.md");

describe("verifier CI merge-gate snippets (T-33.2)", function () {
  // Signing real seals is async + a touch slow; give the suite headroom.
  this.timeout(20000);

  let tmpDirs;
  beforeEach(function () {
    tmpDirs = [];
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-ci-"));
    tmpDirs.push(d);
    return d;
  }

  // Build a genuine signed reconciliation seal whose source/output files sit NEXT TO the seal (so the
  // verifier's default sibling resolution works without --dir). Returns the seal path, its dir, and the
  // ephemeral operator wallet (the signer the gate pins via --vendor).
  async function makeSignedSeal() {
    const root = mkTmp();
    fs.writeFileSync(path.join(root, "bank.csv"), "date,amount\n2026-06-01,100\n");
    fs.writeFileSync(path.join(root, "book.csv"), "date,amount\n2026-06-01,100\n");
    fs.writeFileSync(path.join(root, "report.html"), "<html><body>reconciled</body></html>");
    const rd = (f) => fs.readFileSync(path.join(root, f));
    const bare = trustSeal.buildSeal({
      files: {
        inputs: [
          { role: "bank", relPath: "bank.csv", bytes: rd("bank.csv") },
          { role: "book", relPath: "book.csv", bytes: rd("book.csv") },
        ],
        outputs: [{ relPath: "report.html", bytes: rd("report.html") }],
      },
      verdict: { pass: true, reportDate: "2026-06-24", period: "2026-Q2" },
    });
    const opWallet = Wallet.createRandom();
    const container = await trustSeal.signSealWith(bare, opWallet);
    const sealPath = path.join(root, "recon.vhseal");
    fs.writeFileSync(sealPath, trustSeal.serializeSignedSeal(container));
    return { root, sealPath, opWallet };
  }

  // Write a release manifest (newline form) listing one or more seals, each pinned to its own vendor.
  function writeManifest(dir, entries) {
    const body = entries.map((e) => `${e.sealPath} --vendor ${e.opWallet.address}`).join("\n") + "\n";
    const p = path.join(dir, "release.manifest");
    fs.writeFileSync(p, body);
    return p;
  }

  // Run a shell file with env overrides, capturing exit code + stdio (never throwing on non-zero).
  function runShell(file, env) {
    try {
      const stdout = execFileSync("bash", [file], {
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

  // Run a raw `command [args...]` via the shell with env overrides; capture exit + stdio.
  function runCommand(command, env) {
    try {
      const stdout = execFileSync("bash", ["-c", command], {
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

  // ===============================================================================================
  // THE GENERIC SHELL SNIPPET — executed VERBATIM (the shipped file itself), driven by its env vars.
  // ===============================================================================================
  describe("verify-vh.generic.sh (the shipped portable shell gate, run verbatim)", function () {
    it("is shipped, executable, and a real `set -e` shell script", function () {
      expect(fs.existsSync(GENERIC_SH), "generic.sh must be shipped").to.equal(true);
      const src = fs.readFileSync(GENERIC_SH, "utf8");
      expect(src).to.match(/^#!.*\bbash\b/m);
      expect(src).to.match(/set -euo pipefail/);
      // It must invoke the standalone verifier and never the producer stack: the only thing it runs is
      // `node <verify-vh.js>`. (The header comment legitimately says the words "no ethers/hardhat", so we
      // assert on the executed COMMAND, not mere mention.)
      expect(src).to.contain("verify-vh.js");
      expect(src).to.match(/node "\$VERIFY_VH"/);
      expect(src).to.not.match(/require\(['"](ethers|hardhat)/);
      expect(src).to.not.match(/npm (ci|install)[^\n]*\b(ethers|hardhat)\b/);
    });

    it("EXITS 0 on a good single-artifact release (gate passes -> merge allowed)", async function () {
      const { sealPath, opWallet } = await makeSignedSeal();
      const r = runShell(GENERIC_SH, {
        VERIFY_VH,
        VH_VENDOR: opWallet.address,
        VH_ARTIFACTS: sealPath,
      });
      expect(r.code, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).to.equal(0);
      expect(r.stdout).to.match(/OK — the artifact verifies\./);
    });

    it("EXITS 3 when a sealed byte was tampered (gate fails -> merge blocked)", async function () {
      const { root, sealPath, opWallet } = await makeSignedSeal();
      // Flip one byte of a sealed source file AFTER signing.
      fs.writeFileSync(path.join(root, "bank.csv"), "date,amount\n2026-06-01,999\n");
      const r = runShell(GENERIC_SH, {
        VERIFY_VH,
        VH_VENDOR: opWallet.address,
        VH_ARTIFACTS: sealPath,
      });
      expect(r.code).to.equal(3);
      // The gate localizes the failure and announces the block on stderr.
      expect(r.stdout).to.contain("bank.csv");
      expect(r.stderr).to.match(/FAILED \(exit 3\) — blocking the merge\./);
    });

    it("gates a WHOLE release via a manifest in ONE invocation (all good -> exit 0)", async function () {
      const dir = mkTmp();
      const a = await makeSignedSeal();
      const b = await makeSignedSeal();
      const manifest = writeManifest(dir, [a, b]);
      const r = runShell(GENERIC_SH, { VERIFY_VH, VH_VENDOR: a.opWallet.address, VH_MANIFEST: manifest });
      // a and b are signed by DIFFERENT ephemeral keys; per-entry --vendor in the manifest pins each,
      // so the top-level VH_VENDOR is only a default. Both entries pin their own signer -> all pass.
      expect(r.code, `stderr: ${r.stderr}`).to.equal(0);
    });

    it("one tampered artifact in a multi-artifact manifest fails the whole gate (exit 3, names it)", async function () {
      const dir = mkTmp();
      const good = await makeSignedSeal();
      const bad = await makeSignedSeal();
      fs.writeFileSync(path.join(bad.root, "bank.csv"), "date,amount\n2026-06-01,999\n");
      const manifest = writeManifest(dir, [good, bad]);
      const r = runShell(GENERIC_SH, { VERIFY_VH, VH_VENDOR: good.opWallet.address, VH_MANIFEST: manifest });
      expect(r.code).to.equal(3);
      expect(r.stdout).to.match(/REJECTED — 1 artifact\(s\) failed\./);
      expect(r.stdout).to.contain(path.basename(bad.sealPath));
    });

    it("a missing VH_VENDOR is a usage error (exit 2) — never a silent pass", function () {
      const r = runShell(GENERIC_SH, { VERIFY_VH, VH_ARTIFACTS: "anything.vhseal" });
      expect(r.code).to.equal(2);
      expect(r.stderr).to.match(/set VH_VENDOR/);
    });

    it("neither VH_MANIFEST nor VH_ARTIFACTS set is a usage error (exit 2)", function () {
      const r = runShell(GENERIC_SH, { VERIFY_VH, VH_VENDOR: Wallet.createRandom().address });
      expect(r.code).to.equal(2);
      expect(r.stderr).to.match(/set VH_MANIFEST or VH_ARTIFACTS/);
    });
  });

  // ===============================================================================================
  // THE GITHUB ACTIONS YAML — we NEVER run the workflow; we EXTRACT the exact gate command from its
  // `run:` block and execute THAT one string, proving the shipped example actually works.
  // ===============================================================================================
  describe("verify-vh.github-actions.yml (the shipped GH Actions example)", function () {
    // Pull the single shell command out of the gate step's `run:` block. The shipped YAML uses a block
    // scalar (`run: |`) whose body is the `node verifier/verify-vh.js ...` line.
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
      expect(yml).to.match(/verify-vh:/);
    });

    it("installs ONLY the standalone verifier (js-sha3) — never the producer ethers/hardhat stack", function () {
      const yml = fs.readFileSync(GHA_YML, "utf8");
      // The install step runs npm in the verifier/ tree (which declares ONLY js-sha3), and the whole
      // workflow must not reference the heavy producer toolchain anywhere.
      expect(yml).to.match(/working-directory:\s*verifier/);
      expect(yml).to.match(/npm (ci|install)/);
      // No STEP installs the producer toolchain (the prose may mention "no ethers/hardhat", so we assert
      // that no install command pulls them, not that the words never appear).
      expect(yml).to.not.match(/npm (ci|install)[^\n]*\b(ethers|hardhat|@nomicfoundation)\b/);
      expect(yml).to.not.match(/\bnpx hardhat\b/);
      // Cross-check: the verifier package it installs truly declares ONLY js-sha3.
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "verifier", "package.json"), "utf8"));
      expect(Object.keys(pkg.dependencies || {})).to.deep.equal(["js-sha3"]);
    });

    it("the EXACT gate command extracted from the YAML EXITS 0 on a good release", async function () {
      const yml = fs.readFileSync(GHA_YML, "utf8");
      const cmd = extractGateCommand(yml);
      // The shipped command runs the standalone verifier in manifest mode against $VH_MANIFEST/$VH_VENDOR.
      expect(cmd).to.contain("verify-vh.js");
      expect(cmd).to.contain("--manifest");
      expect(cmd).to.contain("--vendor");

      const dir = mkTmp();
      const a = await makeSignedSeal();
      const manifest = writeManifest(dir, [a]);
      // The YAML references `verifier/verify-vh.js` relative to the repo root; run with cwd = repo so the
      // shipped path resolves exactly as it would in the partner's checkout.
      const r = runCommand(cmd, {
        VH_MANIFEST: manifest,
        VH_VENDOR: a.opWallet.address,
      });
      expect(r.code, `stderr: ${r.stderr}\ncmd: ${cmd}`).to.equal(0);
      expect(r.stdout).to.match(/OK/);
    });

    it("the EXACT gate command extracted from the YAML EXITS 3 on a tampered release", async function () {
      const yml = fs.readFileSync(GHA_YML, "utf8");
      const cmd = extractGateCommand(yml);

      const dir = mkTmp();
      const a = await makeSignedSeal();
      const manifest = writeManifest(dir, [a]);
      // Tamper one sealed byte after signing -> the gate command must fail the build.
      fs.writeFileSync(path.join(a.root, "bank.csv"), "date,amount\n2026-06-01,999\n");
      const r = runCommand(cmd, {
        VH_MANIFEST: manifest,
        VH_VENDOR: a.opWallet.address,
      });
      expect(r.code, `cmd: ${cmd}`).to.equal(3);
      expect(r.stdout).to.contain("bank.csv");
    });
  });

  // ===============================================================================================
  // DOCS LINK THE SNIPPETS (so the shipped files and the buyer-facing docs cannot silently diverge).
  // ===============================================================================================
  describe("docs link the shipped snippets", function () {
    it("verifier/README.md links both ci/ snippets", function () {
      const md = fs.readFileSync(VERIFIER_README, "utf8");
      expect(md).to.contain("ci/verify-vh.generic.sh");
      expect(md).to.contain("ci/verify-vh.github-actions.yml");
    });

    it("docs/INDEPENDENT-VERIFICATION.md links both ci/ snippets", function () {
      const md = fs.readFileSync(INDEP_DOC, "utf8");
      expect(md).to.contain("verifier/ci/verify-vh.generic.sh");
      expect(md).to.contain("verifier/ci/verify-vh.github-actions.yml");
    });
  });
});

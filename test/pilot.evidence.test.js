"use strict";

// Tests for the runnable, OFFLINE, ephemeral-key EVIDENCE PILOT KIT (T-32.1): pilot/run-pilot.js.
//
// What these prove (the kit is a LIVING, test-gated buyer-journey demo that cannot rot):
//   * `node pilot/run-pilot.js` runs end to end against the committed sample, OFFLINE, and exits 0 with an
//     all-PASS verdict — the whole evidence journey (issue license -> gate -> sign -> independent verify ->
//     tamper -> reject) actually works.
//   * The PAID `evidence seal --sign` surface is PROVABLY refused without a valid license (usage exit) and
//     allowed WITH a valid license pinned to the matching vendor (the gate is real, not cosmetic).
//   * The counterparty hand-off uses ONLY the independent verifier tree (verifier/verify-vh.js): it ACCEPTS
//     the untampered packet (exit 0) and REJECTS the tampered one (exit 3), localizing the change.
//   * NO real key is ever created/held/persisted — only ephemeral Wallet.createRandom() keys — and no key
//     material is ever echoed.
//   * The kit writes ONLY to a caller-chosen workspace; the repo working tree (and cwd) is left CLEAN,
//     pass OR fail.
//
// Fully OFFLINE/no-key/no-network: no hardhat node, no provider. Every filesystem effect is isolated to a
// throwaway temp dir and cleaned up.

const { expect } = require("chai");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const RUN_JS = path.join(REPO, "pilot", "run-pilot.js");
const PILOT_DIR = path.join(REPO, "pilot");
const SAMPLE_EVIDENCE = path.join(PILOT_DIR, "sample-evidence");

const pilot = require("../pilot/run-pilot");

// Snapshot tracked + untracked state of a path via git porcelain. An empty string means "nothing changed /
// nothing new appeared".
function gitPorcelain(relPath) {
  return execFileSync("git", ["status", "--porcelain", "--", relPath], {
    cwd: REPO,
    encoding: "utf8",
  });
}

describe("pilot/run-pilot.js T-32.1: OFFLINE ephemeral-key evidence pilot kit", function () {
  // The signing + verification work is light, but spawn the subprocess test gives headroom.
  this.timeout(60000);

  let tmpDirs;
  let cwdBefore;
  beforeEach(function () {
    tmpDirs = [];
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    // FILESYSTEM HYGIENE: nothing the kit did leaked into the working tree.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-pilot-test-"));
    tmpDirs.push(d);
    return d;
  }

  it("committed sample-evidence has the expected tiny inputs", function () {
    expect(fs.existsSync(SAMPLE_EVIDENCE)).to.equal(true);
    const names = fs.readdirSync(SAMPLE_EVIDENCE).sort();
    expect(names).to.deep.equal([
      "README.txt",
      "access-log.csv",
      "control-matrix.json",
      "incident-report.md",
    ]);
    // Comfortably under the FREE sample limit, so the pilot does NOT need evidence_unlimited (only the
    // signed-wrap surface is exercised as the paid gate).
    expect(names.length).to.be.below(require("../cli/evidence").SAMPLE_LIMIT);
  });

  it("runPilot(workspace) drives the whole journey to an all-PASS verdict, writing only under workspace", async function () {
    const ws = mkTmp();
    const ok = await pilot.runPilot(ws);
    expect(ok).to.equal(true);

    // The kit produced its artifacts UNDER the caller-chosen workspace — never elsewhere.
    expect(fs.existsSync(path.join(ws, "evidence.vhlicense.json"))).to.equal(true);
    expect(fs.existsSync(path.join(ws, "evidence-packet.vhevidence.json"))).to.equal(true);
    // The wrong-vendor gate reject wrote NOTHING.
    expect(fs.existsSync(path.join(ws, "should-not-exist.vhevidence.json"))).to.equal(false);

    // The packet is a SIGNED evidence-seal container (the paid surface really ran).
    const packet = JSON.parse(
      fs.readFileSync(path.join(ws, "evidence-packet.vhevidence.json"), "utf8")
    );
    expect(packet.kind).to.equal("vh.evidence-seal-signed");
    expect(packet.signature).to.have.property("signer");
  });

  it("the committed sample is READ-ONLY: the kit tampers a COPY, never the fixture", async function () {
    const before = fs
      .readdirSync(SAMPLE_EVIDENCE)
      .sort()
      .map((n) => fs.readFileSync(path.join(SAMPLE_EVIDENCE, n)));
    const ws = mkTmp();
    await pilot.runPilot(ws);
    const after = fs
      .readdirSync(SAMPLE_EVIDENCE)
      .sort()
      .map((n) => fs.readFileSync(path.join(SAMPLE_EVIDENCE, n)));
    expect(after.map((b) => b.toString("hex"))).to.deep.equal(before.map((b) => b.toString("hex")));
    // And git reports no MODIFICATION of the committed fixture. (Before the driver commits the new tree
    // these files are untracked `??`; what we forbid is a tracked-but-MODIFIED ` M`/`MM` line — i.e. the
    // run mutating a file that is already under version control.)
    const porcelain = gitPorcelain("pilot/sample-evidence");
    expect(porcelain).to.not.match(/^[ MARC]M /m, "the run must not modify a tracked fixture file");
  });

  it("`node pilot/run-pilot.js` exits 0 OFFLINE with an all-PASS verdict and a key-free transcript", function () {
    // Run the REAL script as a subprocess (the way a human/CI runs it). Cut all network env so the run is
    // demonstrably offline-capable; point PILOT_OUT at a throwaway dir so nothing lands in cwd or /tmp-leak.
    const ws = mkTmp();
    const env = Object.assign({}, process.env, {
      PILOT_OUT: ws,
      // Belt-and-suspenders: no RPC/TSA endpoints exist for the script to reach even if it tried.
      VH_RPC_URL: "",
      VH_TSA_URL: "",
    });
    const stdout = execFileSync("node", [RUN_JS], { cwd: REPO, env, encoding: "utf8" });

    // The verdict line is a clean all-PASS, every step PASSed, no FAILs. (Since T-32.2 the kit drives
    // BOTH the evidence AND the reconcile vertical into ONE combined verdict line, so the suffix names
    // both; the count is still passed === total.)
    expect(stdout).to.match(/VERDICT: PASS — \d+\/\d+ checks passed/);
    expect(stdout).to.match(/VERDICT: PASS — (\d+)\/\1 checks passed/); // passed === total
    expect(stdout).to.not.match(/\[FAIL\]/);
    expect(stdout).to.include("[PASS] independent verify-vh ACCEPTS the untampered packet (exit 0)");
    expect(stdout).to.include("[PASS] independent verify-vh REJECTS the tampered packet (exit 3)");

    // KEY HYGIENE: the transcript never echoes a 40-hex private-key-shaped or full-address-shaped secret in
    // a way that would leak material. (The kit prints only a TRUNCATED vendor address.)
    expect(stdout).to.not.match(/0x[0-9a-fA-F]{64}/); // never a 32-byte private key
  });

  it("the exit CODE is 0 from the real script (CI-gateable success)", function () {
    const ws = mkTmp();
    const env = Object.assign({}, process.env, { PILOT_OUT: ws });
    // execFileSync throws on a non-zero exit; a clean return proves exit 0.
    execFileSync("node", [RUN_JS], { cwd: REPO, env, stdio: "pipe" });
  });

  it("the paid `--sign` surface is REFUSED without a license and ALLOWED with one (the gate is real)", async function () {
    const evidence = require("../cli/evidence");
    const { Wallet } = require("ethers");

    const ws = mkTmp();
    const dir = path.join(ws, "ev");
    fs.mkdirSync(dir);
    for (const n of fs.readdirSync(SAMPLE_EVIDENCE)) {
      fs.copyFileSync(path.join(SAMPLE_EVIDENCE, n), path.join(dir, n));
    }
    const NOW = pilot.NOW;

    // (a) REFUSED without a license — usage exit, key-free message.
    {
      const errs = [];
      const io = {
        write: () => {},
        writeErr: (s) => errs.push(s),
        now: NOW,
      };
      const code = await evidence.runEvidenceSeal({ dir, sign: true, keyEnv: "NOPE_KEY" }, io);
      expect(code).to.equal(evidence.EXIT.USAGE);
      expect(errs.join("")).to.match(/PAID surface and\s+requires a license/);
      expect(errs.join("")).to.not.match(/0x[0-9a-fA-F]{40}/);
    }

    // (b) ALLOWED with a valid license pinned to the matching vendor + a separate ephemeral operator key.
    {
      const vendorWallet = Wallet.createRandom();
      const container = await evidence.buildLicense(
        {
          licenseId: "GATE-1",
          customer: "x",
          plan: "pro",
          entitlements: ["evidence_signed"],
          issuedAt: pilot.ISSUED,
          expiresAt: pilot.EXPIRES,
        },
        vendorWallet
      );
      const licFile = path.join(ws, "g.vhlicense.json");
      fs.writeFileSync(licFile, JSON.stringify(container) + "\n");
      const out = path.join(ws, "g.vhevidence.json");

      const opWallet = Wallet.createRandom();
      const PREV = process.env.GATE_OP_KEY;
      process.env.GATE_OP_KEY = opWallet.privateKey;
      try {
        const io = { write: () => {}, writeErr: () => {}, now: NOW };
        const code = await evidence.runEvidenceSeal(
          { dir, out, sign: true, keyEnv: "GATE_OP_KEY", license: licFile, vendor: vendorWallet.address },
          io
        );
        expect(code).to.equal(evidence.EXIT.OK);
        expect(fs.existsSync(out)).to.equal(true);
      } finally {
        if (PREV === undefined) delete process.env.GATE_OP_KEY;
        else process.env.GATE_OP_KEY = PREV;
      }
    }
  });

  it("the counterparty verify uses ONLY the verifier tree: accepts untampered (0), rejects tampered (3)", function () {
    // Build a signed packet via the producer CLI, then verify it with the INDEPENDENT verifier directly —
    // proving the accept/reject contract lives in verifier/verify-vh.js (no producer code on the verify path).
    const evidence = require("../cli/evidence");
    const verifyVh = require("../verifier/verify-vh");
    const { Wallet } = require("ethers");

    return (async () => {
      const ws = mkTmp();
      const dir = path.join(ws, "ev");
      fs.mkdirSync(dir);
      for (const n of fs.readdirSync(SAMPLE_EVIDENCE)) {
        fs.copyFileSync(path.join(SAMPLE_EVIDENCE, n), path.join(dir, n));
      }

      const vendorWallet = Wallet.createRandom();
      const lic = await evidence.buildLicense(
        {
          licenseId: "CP-1",
          customer: "x",
          plan: "pro",
          entitlements: ["evidence_signed"],
          issuedAt: pilot.ISSUED,
          expiresAt: pilot.EXPIRES,
        },
        vendorWallet
      );
      const licFile = path.join(ws, "cp.vhlicense.json");
      fs.writeFileSync(licFile, JSON.stringify(lic) + "\n");
      const packetFile = path.join(ws, "cp.vhevidence.json");

      const opWallet = Wallet.createRandom();
      const PREV = process.env.CP_OP_KEY;
      process.env.CP_OP_KEY = opWallet.privateKey;
      try {
        const io = { write: () => {}, writeErr: () => {}, now: pilot.NOW };
        const code = await evidence.runEvidenceSeal(
          {
            dir,
            out: packetFile,
            sign: true,
            keyEnv: "CP_OP_KEY",
            license: licFile,
            vendor: vendorWallet.address,
          },
          io
        );
        expect(code).to.equal(evidence.EXIT.OK);
      } finally {
        if (PREV === undefined) delete process.env.CP_OP_KEY;
        else process.env.CP_OP_KEY = PREV;
      }

      // ACCEPT (exit 0), pinning the operator key as --vendor.
      {
        const o = [];
        const io = { write: (s) => o.push(s), writeErr: () => {} };
        const code = verifyVh.run(
          ["--json", "--dir", dir, "--vendor", opWallet.address, packetFile],
          io
        );
        expect(code).to.equal(verifyVh.EXIT.OK);
        const r = JSON.parse(o.join(""));
        expect(r.verdict).to.equal("OK");
        expect(r.rootMatches).to.equal(true);
        expect(String(r.recoveredSigner).toLowerCase()).to.equal(opWallet.address.toLowerCase());
      }

      // TAMPER one sealed file -> REJECT (exit 3), localized to the changed file.
      {
        const target = path.join(dir, "control-matrix.json");
        fs.writeFileSync(target, fs.readFileSync(target, "utf8") + "\n// tampered\n");
        const o = [];
        const io = { write: (s) => o.push(s), writeErr: () => {} };
        const code = verifyVh.run(
          ["--json", "--dir", dir, "--vendor", opWallet.address, packetFile],
          io
        );
        expect(code).to.equal(verifyVh.EXIT.REJECTED);
        const r = JSON.parse(o.join(""));
        expect(r.verdict).to.equal("REJECTED");
        expect(r.changed.map((c) => c.relPath)).to.deep.equal(["control-matrix.json"]);
      }
    })();
  });

  it("the verifier tree pulls in NO producer crypto stack (independence holds on the pilot path)", function () {
    // Static guard: nothing the pilot routes the COUNTERPARTY through (verifier/) requires ethers/hardhat.
    // (The producer steps in the pilot DO use ethers to mint ephemeral keys — that is the producer side; the
    // hand-off the buyer runs is verifier-only.)
    function requiresOf(file) {
      const src = fs.readFileSync(file, "utf8");
      const re = /require\(\s*["']([^"']+)["']\s*\)/g;
      const out = [];
      let m;
      while ((m = re.exec(src)) !== null) out.push(m[1]);
      return out;
    }
    const verifierFiles = [path.join(REPO, "verifier", "verify-vh.js")].concat(
      fs.readdirSync(path.join(REPO, "verifier", "lib")).map((n) => path.join(REPO, "verifier", "lib", n))
    );
    for (const f of verifierFiles) {
      for (const dep of requiresOf(f)) {
        expect(dep).to.not.match(/ethers/, `${f} must not require ethers`);
        expect(dep).to.not.match(/hardhat/, `${f} must not require hardhat`);
        expect(dep).to.not.match(/@nomicfoundation/, `${f} must not require hardhat-toolbox`);
        // No back-edge into the producer CLI/trustledger trees.
        expect(dep).to.not.match(/\.\.\/cli\//, `${f} must not reach into cli/`);
        expect(dep).to.not.match(/\.\.\/trustledger\//, `${f} must not reach into trustledger/`);
      }
    }
  });
});

"use strict";

// Tests for the RECONCILE vertical of the OFFLINE, ephemeral-key PILOT KIT (T-32.2): the TrustLedger
// three-way trust-account reconciliation journey folded into pilot/run-pilot.js alongside the evidence
// journey, under ONE combined PASS/FAIL verdict.
//
// What these prove (the kit is a LIVING, test-gated buyer-journey demo that cannot rot):
//   * `node pilot/run-pilot.js` now drives BOTH the evidence AND the reconcile journeys end to end,
//     OFFLINE, and exits 0 with a SINGLE all-PASS verdict spanning both verticals.
//   * The reconcile PAID surface (`vh trust reconcile --seal`) is PROVABLY license-gated: REFUSED without
//     a license (usage exit), REFUSED with a license pinned to the WRONG vendor (nothing written), and
//     UNLOCKED with a valid license pinned to the matching vendor — the gate is real, not cosmetic.
//   * The emitted reconciliation SEAL is independently accepted by verifier/verify-vh.js (exit 0, the
//     keccak root RE-DERIVES) and a tamper is REJECTED (exit 3) with the change localized — the same
//     standalone verifier a counterparty runs, with NO producer crypto stack on the verify path.
//   * NO real key is ever created/held/persisted — only ephemeral Wallet.createRandom() keys.
//   * The kit writes ONLY to a caller-chosen workspace; the repo working tree (and cwd) is left CLEAN,
//     and the committed e2e fixtures are READ-ONLY (the tamper hits a COPY).
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

const pilot = require("../pilot/run-pilot");
const trust = require("../trustledger/cli");
const trustLicense = require("../trustledger/license");
const trustSeal = require("../trustledger/seal");
const verifyVh = require("../verifier/verify-vh");
const { Wallet } = require("ethers");

function gitPorcelain(relPath) {
  return execFileSync("git", ["status", "--porcelain", "--", relPath], {
    cwd: REPO,
    encoding: "utf8",
  });
}

describe("pilot/run-pilot.js T-32.2: OFFLINE ephemeral-key RECONCILE vertical (+ combined verdict)", function () {
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
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-pilot-reconcile-test-"));
    tmpDirs.push(d);
    return d;
  }

  it("committed reconcile sample exists and reuses the trustledger e2e fixtures", function () {
    expect(fs.existsSync(pilot.SAMPLE_RECONCILE)).to.equal(true);
    for (const name of Object.values(pilot.RECONCILE_SOURCES)) {
      expect(fs.existsSync(path.join(pilot.SAMPLE_RECONCILE, name))).to.equal(true);
    }
    // The reconcile report date the gate dates the license at falls inside [ISSUED, EXPIRES].
    expect(Date.parse(pilot.RECONCILE_DATE)).to.be.greaterThan(Date.parse(pilot.ISSUED));
    expect(Date.parse(pilot.RECONCILE_DATE)).to.be.lessThan(Date.parse(pilot.EXPIRES));
  });

  it("runPilot(workspace) drives BOTH verticals to ONE all-PASS verdict, writing only under workspace", async function () {
    const ws = mkTmp();
    const result = await pilot.runPilot(ws);
    expect(result.ok).to.equal(true);
    expect(result.verdict).to.equal("PASS");

    // The evidence vertical's artifacts.
    expect(fs.existsSync(path.join(ws, "evidence.vhlicense.json"))).to.equal(true);
    expect(fs.existsSync(path.join(ws, "evidence-packet.vhevidence.json"))).to.equal(true);

    // The reconcile vertical's artifacts: a TrustLedger license, the audit packet, and the seal — all
    // under the caller-chosen workspace, never elsewhere.
    expect(fs.existsSync(path.join(ws, "trustledger.vhlicense.json"))).to.equal(true);
    const recDir = path.join(ws, "reconcile");
    const sealFile = path.join(recDir, `reconciliation-${pilot.RECONCILE_DATE}-seal.json`);
    expect(fs.existsSync(sealFile)).to.equal(true);
    // A seal is only present when the paid surface actually ran — i.e. the gate was unlocked.
    const seal = JSON.parse(fs.readFileSync(sealFile, "utf8"));
    expect(seal.kind).to.equal(trustSeal.SEAL_KIND);
    // The HTML/CSV audit packet was emitted next to the seal.
    const recFiles = fs.readdirSync(recDir);
    expect(recFiles.some((n) => n.endsWith(".html"))).to.equal(true);
  });

  it("`node pilot/run-pilot.js` exits 0 OFFLINE with ONE all-PASS verdict covering evidence + reconcile", function () {
    const ws = mkTmp();
    const env = Object.assign({}, process.env, {
      PILOT_OUT: ws,
      VH_RPC_URL: "",
      VH_TSA_URL: "",
    });
    const stdout = execFileSync("node", [RUN_JS], { cwd: REPO, env, encoding: "utf8" });

    expect(stdout).to.match(/VERDICT: PASS — \d+\/\d+ checks passed \(evidence \+ reconcile\)\./);
    expect(stdout).to.match(/VERDICT: PASS — (\d+)\/\1 checks passed/); // passed === total
    expect(stdout).to.not.match(/\[FAIL\]/);

    // BOTH verticals demonstrably ran.
    expect(stdout).to.include("VERTICAL A — EVIDENCE");
    expect(stdout).to.include("VERTICAL B — RECONCILE");

    // The reconcile gate + independent verify lines are present and PASS.
    expect(stdout).to.include(
      "[PASS] no-license `reconcile --seal` is REFUSED (usage exit), naming the paid feature"
    );
    expect(stdout).to.include(
      "[PASS] independent verify-vh ACCEPTS the untampered reconciliation seal (exit 0)"
    );
    expect(stdout).to.include(
      "[PASS] independent verify-vh REJECTS the tampered reconciliation seal (exit 3)"
    );

    // KEY HYGIENE: the transcript never echoes a 32-byte private-key-shaped secret.
    expect(stdout).to.not.match(/0x[0-9a-fA-F]{64}/);
  });

  it("the committed e2e fixtures are READ-ONLY: the reconcile kit tampers a COPY, never the fixture", async function () {
    const names = Object.values(pilot.RECONCILE_SOURCES);
    const before = names.map((n) =>
      fs.readFileSync(path.join(pilot.SAMPLE_RECONCILE, n)).toString("hex")
    );
    const ws = mkTmp();
    await pilot.runPilot(ws);
    const after = names.map((n) =>
      fs.readFileSync(path.join(pilot.SAMPLE_RECONCILE, n)).toString("hex")
    );
    expect(after).to.deep.equal(before);

    const porcelain = gitPorcelain("trustledger/fixtures/e2e");
    expect(porcelain).to.not.match(/^[ MARC]M /m, "the run must not modify a tracked fixture file");
  });

  it("the paid `reconcile --seal` surface is REFUSED without a license and UNLOCKED with one (the gate is real)", async function () {
    const ws = mkTmp();
    const recDir = path.join(ws, "rec");
    fs.mkdirSync(recDir);
    const bank = path.join(recDir, pilot.RECONCILE_SOURCES.bank);
    const ledger = path.join(recDir, pilot.RECONCILE_SOURCES.ledger);
    const rent = path.join(recDir, pilot.RECONCILE_SOURCES.rentroll);
    fs.copyFileSync(path.join(pilot.SAMPLE_RECONCILE, pilot.RECONCILE_SOURCES.bank), bank);
    fs.copyFileSync(path.join(pilot.SAMPLE_RECONCILE, pilot.RECONCILE_SOURCES.ledger), ledger);
    fs.copyFileSync(path.join(pilot.SAMPLE_RECONCILE, pilot.RECONCILE_SOURCES.rentroll), rent);
    const date = pilot.RECONCILE_DATE;
    const sealFile = path.join(recDir, `reconciliation-${date}-seal.json`);
    const baseArgs = [bank, ledger, rent, "--date", date, "--out", recDir, "--seal"];
    const io = () => {
      const o = [];
      const e = [];
      return { write: (s) => o.push(s), writeErr: (s) => e.push(s), today: () => date, out: () => o.join(""), err: () => e.join("") };
    };

    // (a) REFUSED without a license — usage exit, naming the paid feature, NOTHING written.
    {
      const cap = io();
      const r = trust.runReconcile(trust.parseReconcileArgs(baseArgs), cap);
      expect(r.code).to.equal(trust.EXIT.USAGE);
      expect(cap.err()).to.match(/PAID feature and\s+requires a license/);
      expect(fs.existsSync(sealFile)).to.equal(false);
    }

    // (b) UNLOCKED with a valid license pinned to the matching vendor.
    const vendorWallet = Wallet.createRandom();
    const container = await trustLicense.buildLicense(
      {
        licenseId: "GATE-REC-1",
        customer: "x",
        plan: "pro",
        entitlements: ["seal"],
        issuedAt: pilot.ISSUED,
        expiresAt: pilot.EXPIRES,
      },
      vendorWallet
    );
    const licFile = path.join(ws, "g.vhlicense.json");
    fs.writeFileSync(licFile, trustLicense.serializeSignedLicense(container));
    {
      // T-75.3: the gate pins to the CANONICAL vendor identity, resolved OUTSIDE argv. This operator
      // instance declares its ephemeral vendor canonical via the programmatic io.canonicalVendor seam.
      const cap = io();
      cap.canonicalVendor = vendorWallet.address;
      const r = trust.runReconcile(
        trust.parseReconcileArgs([...baseArgs, "--license", licFile, "--vendor", vendorWallet.address]),
        cap
      );
      expect(r.code).to.equal(trust.EXIT.PASS);
      expect(r.model.pass).to.equal(true);
      expect(fs.existsSync(sealFile)).to.equal(true);
    }

    // (c) A SELF-MINTED license (signed by a NON-canonical key) is REFUSED (wrong_issuer) — the gate
    //     pins to the canonical vendor identity, so an attacker's own key can never unlock the surface.
    {
      const attacker = Wallet.createRandom();
      const attackerContainer = await trustLicense.buildLicense(
        {
          licenseId: "GATE-REC-SELFMINT",
          customer: "attacker",
          plan: "pro",
          entitlements: ["seal"],
          issuedAt: pilot.ISSUED,
          expiresAt: pilot.EXPIRES,
        },
        attacker
      );
      const attackerFile = path.join(ws, "attacker.vhlicense.json");
      fs.writeFileSync(attackerFile, trustLicense.serializeSignedLicense(attackerContainer));
      const cap = io();
      cap.canonicalVendor = vendorWallet.address; // pinned to the REAL vendor, not the attacker
      const r = trust.runReconcile(
        trust.parseReconcileArgs([...baseArgs, "--license", attackerFile]),
        cap
      );
      expect(r.code).to.equal(trust.EXIT.USAGE);
      expect(cap.err()).to.match(/reason: wrong_issuer/);
    }
  });

  it("the counterparty verify uses ONLY verify-vh on the reconciliation seal: accepts untampered (0), rejects tampered (3)", async function () {
    const ws = mkTmp();
    const recDir = path.join(ws, "rec");
    fs.mkdirSync(recDir);
    const bank = path.join(recDir, pilot.RECONCILE_SOURCES.bank);
    const ledger = path.join(recDir, pilot.RECONCILE_SOURCES.ledger);
    const rent = path.join(recDir, pilot.RECONCILE_SOURCES.rentroll);
    fs.copyFileSync(path.join(pilot.SAMPLE_RECONCILE, pilot.RECONCILE_SOURCES.bank), bank);
    fs.copyFileSync(path.join(pilot.SAMPLE_RECONCILE, pilot.RECONCILE_SOURCES.ledger), ledger);
    fs.copyFileSync(path.join(pilot.SAMPLE_RECONCILE, pilot.RECONCILE_SOURCES.rentroll), rent);
    const date = pilot.RECONCILE_DATE;
    const sealFile = path.join(recDir, `reconciliation-${date}-seal.json`);

    const vendorWallet = Wallet.createRandom();
    const container = await trustLicense.buildLicense(
      {
        licenseId: "CP-REC-1",
        customer: "x",
        plan: "pro",
        entitlements: ["seal"],
        issuedAt: pilot.ISSUED,
        expiresAt: pilot.EXPIRES,
      },
      vendorWallet
    );
    const licFile = path.join(ws, "cp.vhlicense.json");
    fs.writeFileSync(licFile, trustLicense.serializeSignedLicense(container));

    const cap = { write: () => {}, writeErr: () => {}, today: () => date, canonicalVendor: vendorWallet.address };
    const r = trust.runReconcile(
      trust.parseReconcileArgs([
        bank, ledger, rent, "--date", date, "--out", recDir, "--seal", "--license", licFile, "--vendor", vendorWallet.address,
      ]),
      cap
    );
    expect(r.code).to.equal(trust.EXIT.PASS);
    expect(fs.existsSync(sealFile)).to.equal(true);

    // ACCEPT (exit 0) — verify-vh re-derives the keccak root from the bytes on disk. The seal is UNSIGNED,
    // so we do NOT pin --vendor (an unsigned artifact cannot be signer-pinned).
    {
      const o = [];
      const code = verifyVh.run(["--json", "--dir", recDir, sealFile], { write: (s) => o.push(s), writeErr: () => {} });
      expect(code).to.equal(verifyVh.EXIT.OK);
      const v = JSON.parse(o.join(""));
      expect(v.verdict).to.equal("OK");
      expect(v.payloadKind).to.equal(verifyVh.KINDS.TRUST_SEAL);
      expect(v.rootMatches).to.equal(true);
    }

    // TAMPER a sealed source dollar figure -> REJECT (exit 3), localized to the changed source.
    {
      const beforeBytes = fs.readFileSync(bank, "utf8");
      fs.writeFileSync(bank, beforeBytes.replace("1500.00", "9500.00"));
      const o = [];
      const code = verifyVh.run(["--json", "--dir", recDir, sealFile], { write: (s) => o.push(s), writeErr: () => {} });
      expect(code).to.equal(verifyVh.EXIT.REJECTED);
      const v = JSON.parse(o.join(""));
      expect(v.verdict).to.equal("REJECTED");
      expect(v.changed.map((c) => c.relPath)).to.deep.equal([pilot.RECONCILE_SOURCES.bank]);
    }
  });

  it("the reconcile verify path stays verifier-only (no ethers/hardhat on the counterparty seal check)", function () {
    // The reconcile hand-off the buyer runs is the SAME verifier/ tree the evidence hand-off uses. Static
    // guard: nothing under verifier/ requires the producer crypto stack or reaches back into the producer trees.
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
        expect(dep).to.not.match(/\.\.\/trustledger\//, `${f} must not reach into trustledger/`);
        expect(dep).to.not.match(/\.\.\/cli\//, `${f} must not reach into cli/`);
      }
    }
  });
});

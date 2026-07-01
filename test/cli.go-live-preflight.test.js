"use strict";

// test/cli.go-live-preflight.test.js — acceptance suite for the GO-LIVE CONFIG PREFLIGHT (T-61.3).
//
// WHAT THIS PROVES (one describe per acceptance clause)
//   (1) POSITIVE: a SYNTHETIC binding+catalog mapping >=2 prices to evidence plans, a SYNTHETIC webhook
//       secret, and an ephemeral Wallet.createRandom() vendor key -> exit 0, every price delivers a license
//       that PASSES the existing `vh evidence seal --sign` gate for its mapped plan.
//   (2) A binding with an UNMAPPED / DUPLICATE / TYPO'd price exits NON-ZERO, NAMING the offending price
//       (never a silent default plan).
//   (3) With --secret-env, a price whose synthesized event fails signature/parse is NAMED (the operator's
//       real secret path is exercised, fail-closed).
//   (4) A delivered license whose mapped plan LACKS the paid entitlement is caught by the gate (FAIL, not PASS).
//   (5) GUARDRAILS: the module imports NONE of http/https/net/dns, the vendor key comes ONLY from
//       --key-env/--key-file (never written to disk/logs), and the temp workspace is removed on exit.
//   (6) --json emits the machine verdict; the command is wired into `vh` help; exit 0 (all deliver) vs
//       non-zero (a config error).
//
// Every signing key here is an EPHEMERAL in-process Wallet.createRandom() (TEST-ONLY, never a real key/funds),
// passed to the module ONLY via an env var (--key-env). The suite isolates ALL filesystem effects to a
// throwaway temp dir it removes in afterEach.

const { expect } = require("chai");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet } = require("ethers");

const preflight = require("../cli/core/go-live-preflight");

const REPO = path.resolve(__dirname, "..");
const VH = path.join(REPO, "cli", "vh.js");
const MODULE_SRC_PATH = path.join(REPO, "cli", "core", "go-live-preflight.js");

// A fixed clock so the minted license windows (issuedAt .. +30d) and the gate check are deterministic.
const TODAY = new Date("2026-07-01T12:00:00.000Z");

// A synthetic plan catalog: three plans over the CLOSED evidence entitlement set. `unlimited-only` is a
// VALID plan that deliberately LACKS the paid `evidence_signed` entitlement (drives clause 4).
const CATALOG = {
  kind: "vh-evidence-plan-catalog",
  schemaVersion: 1,
  plans: [
    { planId: "signed-monthly", displayName: "Signed (monthly)", entitlements: ["evidence_signed"], termDays: 30 },
    { planId: "pro-annual", displayName: "Pro (annual)", entitlements: ["evidence_signed", "evidence_unlimited"], termDays: 365 },
    { planId: "unlimited-only", displayName: "Unlimited only (NO signing)", entitlements: ["evidence_unlimited"], termDays: 30 },
  ],
};

// A GOOD binding: >=2 Stripe prices, each mapped to a plan that includes evidence_signed.
const GOOD_BINDING = {
  kind: "vh-evidence-price-binding",
  schemaVersion: 1,
  mappings: [
    { provider: "stripe", priceId: "price_signed_monthly", planId: "signed-monthly" },
    { provider: "stripe", priceId: "price_pro_annual", planId: "pro-annual" },
  ],
};

describe("T-61.3: vh evidence go-live-preflight — offline go-live config preflight", function () {
  this.timeout(60000);

  let dir; // per-test throwaway workspace
  let keyEnv;
  let secretEnv;
  let vendor; // the ephemeral vendor address

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "glp-test-"));
    const w = Wallet.createRandom(); // EPHEMERAL, TEST-ONLY — never a real key/funds.
    vendor = w.address;
    keyEnv = `VH_GLP_KEY_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
    secretEnv = `VH_GLP_SECRET_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
    process.env[keyEnv] = w.privateKey;
    process.env[secretEnv] = "whsec_synthetic_preflight_secret";
  });

  afterEach(function () {
    delete process.env[keyEnv];
    delete process.env[secretEnv];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Write a catalog + binding into the test dir; return their paths.
  function writeConfig(binding, catalog) {
    const catalogPath = path.join(dir, "catalog.json");
    const bindingPath = path.join(dir, "binding.json");
    fs.writeFileSync(catalogPath, JSON.stringify(catalog || CATALOG, null, 2));
    fs.writeFileSync(bindingPath, JSON.stringify(binding, null, 2));
    return { catalogPath, bindingPath };
  }

  // Run the preflight IN-PROCESS, capturing stdout/stderr. Returns { code, out, err }.
  async function run(opts) {
    let out = "";
    let err = "";
    const code = await preflight.runGoLivePreflight(opts, {
      write: (s) => { out += s; },
      writeErr: (s) => { err += s; },
      now: TODAY,
    });
    return { code, out, err };
  }

  // Count leftover preflight workspaces in the OS temp dir (proves cleanup).
  function leakedWorkspaces() {
    return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("vh-golive-preflight-"));
  }

  // ---------------------------------------------------------------------------------------------------
  describe("(1) POSITIVE — every price delivers a license that PASSES the gate", function () {
    it("exits 0 with a synthetic binding+catalog+secret and an ephemeral vendor key", async function () {
      const { catalogPath, bindingPath } = writeConfig(GOOD_BINDING);
      const { code, out } = await run({
        binding: bindingPath, catalog: catalogPath, secretEnv, keyEnv, json: false,
      });
      expect(code, out).to.equal(0);
      // Every mapped price is PASS; each is confirmed to pass the paid `--sign` gate.
      expect(out).to.include("PRICE stripe:price_signed_monthly  ->  plan signed-monthly  ...  PASS");
      expect(out).to.include("PRICE stripe:price_pro_annual  ->  plan pro-annual  ...  PASS");
      expect(out).to.match(/ALL 2 prices deliver a license that PASSES the paid gate/);
      expect(out).to.not.match(/\bFAIL\b/);
    });

    it("the --json verdict reports ok:true, secretExercised, and one ok result per price", async function () {
      const { catalogPath, bindingPath } = writeConfig(GOOD_BINDING);
      const { code, out } = await run({
        binding: bindingPath, catalog: catalogPath, secretEnv, keyEnv, json: true,
      });
      expect(code).to.equal(0);
      const v = JSON.parse(out);
      expect(v.ok).to.equal(true);
      expect(v.secretExercised).to.equal(true);
      expect(v.requiredEntitlement).to.equal("evidence_signed");
      expect(v.priceCount).to.equal(2);
      expect(v.passed).to.equal(2);
      expect(v.failed).to.equal(0);
      expect(v.results.map((r) => r.priceId).sort()).to.deep.equal(["price_pro_annual", "price_signed_monthly"]);
      v.results.forEach((r) => expect(r.ok, JSON.stringify(r)).to.equal(true));
    });

    it("passes WITHOUT --secret-env too (the secret leg is optional)", async function () {
      const { catalogPath, bindingPath } = writeConfig(GOOD_BINDING);
      const { code, out } = await run({ binding: bindingPath, catalog: catalogPath, keyEnv, json: true });
      expect(code, out).to.equal(0);
      const v = JSON.parse(out);
      expect(v.secretExercised).to.equal(false);
      expect(v.passed).to.equal(2);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  describe("(2) a bad binding exits non-zero NAMING the offending price (never a silent default plan)", function () {
    it("a TYPO'd price (planId not in the catalog) is NAMED and non-zero", async function () {
      const binding = {
        kind: "vh-evidence-price-binding", schemaVersion: 1,
        mappings: [{ provider: "stripe", priceId: "price_typo", planId: "signed-monthlyyy" }],
      };
      const { catalogPath, bindingPath } = writeConfig(binding);
      const { code, out, err } = await run({ binding: bindingPath, catalog: catalogPath, keyEnv });
      expect(code).to.not.equal(0);
      expect(err).to.include("price_typo");
      expect(err).to.include("signed-monthlyyy");
      // never a silent default plan — no PASS was emitted.
      expect(out).to.not.include("PASS");
    });

    it("a DUPLICATE (provider, priceId) is NAMED and non-zero", async function () {
      const binding = {
        kind: "vh-evidence-price-binding", schemaVersion: 1,
        mappings: [
          { provider: "stripe", priceId: "price_dup", planId: "signed-monthly" },
          { provider: "stripe", priceId: "price_dup", planId: "pro-annual" },
        ],
      };
      const { catalogPath, bindingPath } = writeConfig(binding);
      const { code, err } = await run({ binding: bindingPath, catalog: catalogPath, keyEnv });
      expect(code).to.not.equal(0);
      expect(err.toLowerCase()).to.include("duplicate");
      expect(err).to.include("price_dup");
    });

    it("an UNMAPPED price (empty planId) is NAMED and non-zero", async function () {
      const binding = {
        kind: "vh-evidence-price-binding", schemaVersion: 1,
        mappings: [{ provider: "stripe", priceId: "price_unmapped", planId: "" }],
      };
      const { catalogPath, bindingPath } = writeConfig(binding);
      const { code, err } = await run({ binding: bindingPath, catalog: catalogPath, keyEnv });
      expect(code).to.not.equal(0);
      expect(err).to.include("price_unmapped");
      expect(err).to.include("planId");
    });
  });

  // ---------------------------------------------------------------------------------------------------
  describe("(3) --secret-env: a price whose event fails signature/parse is NAMED (fail-closed)", function () {
    it("a corrupted signature (injected fault) NAMES the price and delivers nothing", async function () {
      const { catalogPath, bindingPath } = writeConfig(GOOD_BINDING);
      const { code, out } = await run({
        binding: bindingPath, catalog: catalogPath, secretEnv, keyEnv, injectFault: "signature", json: false,
      });
      expect(code).to.not.equal(0);
      // Exactly one price FAILs at the secret path, NAMED, fail-closed.
      expect(out).to.match(/FAILED the webhook secret path/);
      expect(out).to.match(/fail-closed/);
      expect(out).to.match(/PREFLIGHT FAILED/);
      // the OTHER price still PASSes — the failure is per-price, not global.
      expect(out).to.match(/\bPASS\b/);
    });

    it("--secret-env pointing at an UNSET var is a NAMED config error (non-zero)", async function () {
      const { catalogPath, bindingPath } = writeConfig(GOOD_BINDING);
      const missing = `VH_GLP_MISSING_${Math.random().toString(36).slice(2)}`;
      const { code, err } = await run({ binding: bindingPath, catalog: catalogPath, secretEnv: missing, keyEnv });
      expect(code).to.not.equal(0);
      expect(err).to.include(missing);
      expect(err).to.include("not set");
    });
  });

  // ---------------------------------------------------------------------------------------------------
  describe("(4) a plan LACKING the paid entitlement is caught by the gate (FAIL, never PASS)", function () {
    it("a price mapped to an evidence_unlimited-only plan is reported FAIL by the paid gate", async function () {
      const binding = {
        kind: "vh-evidence-price-binding", schemaVersion: 1,
        mappings: [
          { provider: "stripe", priceId: "price_ok", planId: "signed-monthly" },
          { provider: "stripe", priceId: "price_no_sign", planId: "unlimited-only" },
        ],
      };
      const { catalogPath, bindingPath } = writeConfig(binding);
      const { code, out } = await run({ binding: bindingPath, catalog: catalogPath, keyEnv, json: false });
      expect(code).to.not.equal(0);
      expect(out).to.include("PRICE stripe:price_no_sign  ->  plan unlimited-only  ...  FAIL");
      // the gate NAMES the missing entitlement and the offending price; never a false PASS.
      expect(out).to.match(/price stripe:price_no_sign delivered a license the paid .* gate REJECTED/);
      expect(out).to.include("needs 'evidence_signed'");
      // the well-formed price still PASSes.
      expect(out).to.include("PRICE stripe:price_ok  ->  plan signed-monthly  ...  PASS");
    });

    it("the --json result for that price is ok:false (never silently ok:true)", async function () {
      const binding = {
        kind: "vh-evidence-price-binding", schemaVersion: 1,
        mappings: [{ provider: "stripe", priceId: "price_no_sign", planId: "unlimited-only" }],
      };
      const { catalogPath, bindingPath } = writeConfig(binding);
      const { code, out } = await run({ binding: bindingPath, catalog: catalogPath, keyEnv, json: true });
      expect(code).to.not.equal(0);
      const v = JSON.parse(out);
      expect(v.ok).to.equal(false);
      expect(v.failed).to.equal(1);
      const r = v.results.find((x) => x.priceId === "price_no_sign");
      expect(r.ok).to.equal(false);
      expect(r.reason).to.include("evidence_signed");
    });
  });

  // ---------------------------------------------------------------------------------------------------
  describe("(5) GUARDRAILS — no network imports, key only from --key-env/--key-file, workspace removed", function () {
    const SRC = fs.readFileSync(MODULE_SRC_PATH, "utf8");

    it("imports NONE of http/https/net/dns", function () {
      expect(SRC).to.not.match(/require\(\s*['"](?:http|https|net|dns)['"]\s*\)/);
      expect(SRC).to.not.match(/from\s+['"](?:http|https|net|dns)['"]/);
    });

    it("reads the vendor key ONLY via loadSigningWallet(--key-env/--key-file) — never touches raw key material", function () {
      expect(SRC).to.match(/loadSigningWallet/);
      expect(SRC).to.match(/keyEnv/);
      expect(SRC).to.match(/keyFile/);
      // the module never handles/echoes raw private-key material itself.
      expect(SRC, "no raw privateKey handling").to.not.match(/privateKey/);
      expect(SRC, "no hardcoded 64-hex key").to.not.match(/0x[0-9a-fA-F]{64}/);
      expect(SRC, "no real-key indicators").to.not.match(/MNEMONIC|keystore|id_rsa|\.pem\b/i);
    });

    it("removes its throwaway workspace on a PASSING run (no leaked temp dirs)", async function () {
      const before = leakedWorkspaces();
      const { catalogPath, bindingPath } = writeConfig(GOOD_BINDING);
      await run({ binding: bindingPath, catalog: catalogPath, secretEnv, keyEnv });
      expect(leakedWorkspaces()).to.deep.equal(before);
    });

    it("removes its throwaway workspace on a FAILING run too (pass or fail)", async function () {
      const before = leakedWorkspaces();
      const binding = {
        kind: "vh-evidence-price-binding", schemaVersion: 1,
        mappings: [{ provider: "stripe", priceId: "price_no_sign", planId: "unlimited-only" }],
      };
      const { catalogPath, bindingPath } = writeConfig(binding);
      const { code } = await run({ binding: bindingPath, catalog: catalogPath, keyEnv });
      expect(code).to.not.equal(0);
      expect(leakedWorkspaces()).to.deep.equal(before);
    });

    it("writes NO receipt/artifact into the current working directory", async function () {
      const before = fs.readdirSync(REPO).sort();
      const { catalogPath, bindingPath } = writeConfig(GOOD_BINDING);
      await run({ binding: bindingPath, catalog: catalogPath, secretEnv, keyEnv });
      expect(fs.readdirSync(REPO).sort()).to.deep.equal(before);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  describe("(6) --json contract + wired into vh help + exit 0 vs non-zero", function () {
    it("--json always carries the honest note + machine verdict shape", async function () {
      const { catalogPath, bindingPath } = writeConfig(GOOD_BINDING);
      const { out } = await run({ binding: bindingPath, catalog: catalogPath, keyEnv, json: true });
      const v = JSON.parse(out);
      expect(v).to.have.all.keys(
        "ok", "note", "catalog", "binding", "secretExercised", "requiredEntitlement",
        "priceCount", "passed", "failed", "results"
      );
      expect(v.note).to.equal(preflight.PREFLIGHT_TRUST_NOTE);
      expect(v.note).to.match(/ACCESS credential/);
      expect(v.note).to.match(/NOT a token/);
    });

    it("a MISSING --binding is a non-zero usage error before any work", async function () {
      const { code, err } = await run({ keyEnv });
      expect(code).to.not.equal(0);
      expect(err).to.include("--binding");
    });

    it("is listed in `vh help` and in `vh evidence` usage", function () {
      const help = spawnSync(process.execPath, [VH, "help"], { encoding: "utf8" });
      expect(help.stdout).to.include("go-live-preflight");
      const evHelp = spawnSync(process.execPath, [VH, "evidence"], { encoding: "utf8" });
      expect(evHelp.stdout).to.include("go-live-preflight");
    });

    it("the CLI (`node cli/vh.js evidence go-live-preflight`) exits 0 on a good config", function () {
      const { catalogPath, bindingPath } = writeConfig(GOOD_BINDING);
      const run = spawnSync(
        process.execPath,
        [VH, "evidence", "go-live-preflight", "--binding", bindingPath, "--catalog", catalogPath, "--key-env", keyEnv, "--json"],
        { encoding: "utf8", env: process.env }
      );
      expect(run.status, run.stdout + run.stderr).to.equal(0);
      const v = JSON.parse(run.stdout);
      expect(v.ok).to.equal(true);
      expect(v.passed).to.equal(2);
    });

    it("the CLI exits non-zero on a bad config (typo'd price)", function () {
      const binding = {
        kind: "vh-evidence-price-binding", schemaVersion: 1,
        mappings: [{ provider: "stripe", priceId: "price_typo", planId: "nope" }],
      };
      const { catalogPath, bindingPath } = writeConfig(binding);
      const run = spawnSync(
        process.execPath,
        [VH, "evidence", "go-live-preflight", "--binding", bindingPath, "--catalog", catalogPath, "--key-env", keyEnv],
        { encoding: "utf8", env: process.env }
      );
      expect(run.status).to.not.equal(0);
      expect(run.stderr).to.include("price_typo");
    });
  });
});

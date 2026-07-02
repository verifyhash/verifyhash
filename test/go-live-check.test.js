"use strict";

// test/go-live-check.test.js — the acceptance suite for the GO-LIVE READINESS PROOF (T-61.1).
//
// WHAT THIS PROVES (each acceptance clause is a describe/it below)
//   (1) POSITIVE: `node scripts/go-live-check.js` runs in a CHILD PROCESS on a clean checkout, EXITS 0
//       with EVERY leg (seal->independent-verify, issue->verify->fail-closed-gate,
//       fulfill->deliver->gate-accept) marked PASS, and prints the exact bounded HUMAN steps VERBATIM, last.
//   (2) NEGATIVE: breaking exactly ONE leg in an isolated fixture (a tampered seal; a wrong-vendor license)
//       makes the check EXIT NON-ZERO naming the broken leg — never a false all-green.
//   (3) GUARDRAIL GREP: the script uses ONLY Wallet.createRandom()/env-or-file test keys, requires NO
//       http/https/net/dns, and bakes in NO real key path.
//   (4) HYGIENE: the script cleans up its throwaway workspace and writes NOTHING into the checkout.
//   (5) WIRING: package.json exposes it as `npm run go-live`.
//
// The proof is offline + ephemeral-key by construction; this suite only OBSERVES it (spawns it, reads its
// output/exit code, and inspects its source) — it opens no network and holds no key of its own.

const { expect } = require("chai");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "go-live-check.js");

// The script exports its verbatim final block + leg table so this test can assert them without re-typing
// (and thus without drift). Requiring it does NOT run main() (guarded by require.main === module).
const { HUMAN_STEPS, LEGS } = require("../scripts/go-live-check");

// Spawn `node scripts/go-live-check.js` from the repo root (the clean-checkout equivalent), with an optional
// extra-env overlay. status === null (killed by signal) is normalized to a non-zero failure.
function runScript(extraEnv) {
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    cwd: REPO,
    env: Object.assign({}, process.env, extraEnv || {}),
  });
  return {
    status: res.status === null ? 1 : res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

describe("T-61.1: scripts/go-live-check.js — the go-live readiness proof", function () {
  this.timeout(180000); // each run spawns the CLI + the independent verifier several times

  describe("(1) POSITIVE — exits 0, every leg PASS, human steps verbatim", function () {
    let run;
    before(function () {
      run = runScript();
    });

    it("exits 0", function () {
      expect(run.status, run.stdout + run.stderr).to.equal(0);
    });

    it("marks EVERY leg PASS (all three named legs)", function () {
      // Each leg's exact PASS line — proving no leg was skipped or silently degraded.
      LEGS.forEach((leg, i) => {
        expect(run.stdout).to.include(`LEG ${i + 1}  ${leg.title}  ...  PASS`);
      });
      // The three legs the acceptance names, by name.
      expect(run.stdout).to.include("seal -> independent-verify");
      expect(run.stdout).to.include("issue -> verify -> fail-closed-gate");
      expect(run.stdout).to.include("fulfill -> deliver -> gate-accept");
      expect(run.stdout).to.include("ALL LEGS PASS");
      expect(run.stdout).to.not.match(/\bFAIL\b/);
    });

    it("prints the exact bounded HUMAN steps VERBATIM, last", function () {
      expect(run.stdout).to.include(HUMAN_STEPS);
      // "last": nothing but whitespace follows the human-steps block.
      const idx = run.stdout.indexOf(HUMAN_STEPS);
      expect(idx, "human steps present").to.be.greaterThan(-1);
      expect(run.stdout.slice(idx + HUMAN_STEPS.length).trim()).to.equal("");
      // The block names all four bounded human steps + the revenue-integrity boundary.
      expect(HUMAN_STEPS).to.match(/1\. Provision a REAL vendor signing key/);
      expect(HUMAN_STEPS).to.match(/2\. Set the real PRICE and TERM/);
      expect(HUMAN_STEPS).to.match(/3\. Wire Stripe Checkout/);
      expect(HUMAN_STEPS).to.match(/4\. PUBLISH/);
      expect(HUMAN_STEPS).to.match(/REVENUE-INTEGRITY BOUNDARY:.*ACCESS credential/);
      expect(HUMAN_STEPS).to.match(/NOT a token\/coin\/NFT, not tradeable/);
    });
  });

  describe("(2) NEGATIVE — one broken leg => non-zero, names the failed leg, no false all-green", function () {
    it("a TAMPERED SEAL fails leg 1 (seal -> independent-verify)", function () {
      const run = runScript({ GO_LIVE_INJECT_FAULT: "seal" });
      expect(run.status, "must exit non-zero").to.not.equal(0);
      expect(run.stdout).to.include("LEG 1  seal -> independent-verify  ...  FAIL");
      expect(run.stdout).to.include("GO-LIVE CHECK FAILED at leg: seal -> independent-verify");
      expect(run.stdout).to.not.include("ALL LEGS PASS"); // never a false all-green
    });

    it("a WRONG-VENDOR license fails leg 2 (issue -> verify -> fail-closed-gate)", function () {
      const run = runScript({ GO_LIVE_INJECT_FAULT: "gate" });
      expect(run.status, "must exit non-zero").to.not.equal(0);
      expect(run.stdout).to.include("LEG 2  issue -> verify -> fail-closed-gate  ...  FAIL");
      expect(run.stdout).to.include("GO-LIVE CHECK FAILED at leg: issue -> verify -> fail-closed-gate");
      expect(run.stdout).to.not.include("ALL LEGS PASS");
    });

    it("a TAMPERED DELIVERY fails leg 3 (fulfill -> deliver -> gate-accept)", function () {
      const run = runScript({ GO_LIVE_INJECT_FAULT: "fulfill" });
      expect(run.status, "must exit non-zero").to.not.equal(0);
      expect(run.stdout).to.include("LEG 3  fulfill -> deliver -> gate-accept  ...  FAIL");
      expect(run.stdout).to.include("GO-LIVE CHECK FAILED at leg: fulfill -> deliver -> gate-accept");
      expect(run.stdout).to.not.include("ALL LEGS PASS");
    });
  });

  describe("(3) GUARDRAIL GREP — ephemeral keys only, no network, no real key path", function () {
    const SRC = fs.readFileSync(SCRIPT, "utf8");

    it("keys come ONLY from Wallet.createRandom(), passed via an env-var key source", function () {
      expect(SRC).to.match(/Wallet\.createRandom\(\)/);
      expect(SRC).to.match(/--key-env/);
    });

    it("requires NONE of http/https/net/dns", function () {
      expect(SRC).to.not.match(/require\(\s*['"](?:http|https|net|dns)['"]\s*\)/);
      // also no ESM-style import of those transports
      expect(SRC).to.not.match(/from\s+['"](?:http|https|net|dns)['"]/);
    });

    it("bakes in NO real key path (no hardcoded private key, no real-key file/env references)", function () {
      expect(SRC, "no hardcoded 64-hex private key").to.not.match(/0x[0-9a-fA-F]{64}/);
      expect(SRC, "no real-key indicators").to.not.match(/PRIVATE_KEY|MNEMONIC|keystore|id_rsa|\.pem\b/i);
    });
  });

  describe("(4) HYGIENE — cleans up its workspace, writes nothing into the checkout", function () {
    it("removes the throwaway workspace it announces", function () {
      const run = runScript();
      const m = run.stdout.match(/workspace:\s*(\S+)/);
      expect(m, "script announces its workspace path").to.not.equal(null);
      const ws = m[1];
      expect(ws).to.match(/vh-golive-/);
      expect(fs.existsSync(ws), `workspace ${ws} must be removed`).to.equal(false);
    });

    it("leaves the repo checkout's top-level listing UNCHANGED", function () {
      const before = fs.readdirSync(REPO).sort();
      runScript();
      const after = fs.readdirSync(REPO).sort();
      expect(after).to.deep.equal(before);
    });
  });

  describe("(5) WIRING — exposed as `npm run go-live`", function () {
    it("package.json scripts.go-live runs the check", function () {
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
      expect(pkg.scripts).to.have.property("go-live");
      expect(pkg.scripts["go-live"]).to.match(/scripts\/go-live-check\.js/);
    });
  });
});

// ---------------------------------------------------------------------------
// T-61.2: the readiness proof above is only worth anything if a repo visitor
// can FIND the page that frames it. This block guards the DISCOVERABILITY
// CONTRACT — the one README front-door pointer to docs/GO-LIVE.md — so the
// single most revenue-critical page (the "first dollar" decision page) cannot
// silently rot out of the front door and cannot point at a gutted target:
//   * the front-door markdown link to docs/GO-LIVE.md is present (the pointer
//     can't be deleted without turning this test red);
//   * it keeps the load-bearing framing — self-serve is the RECOMMENDED DEFAULT,
//     the pilot is the ENTERPRISE FALLBACK — so a future edit can't quietly
//     invert the recommended path;
//   * it keeps citing `npm run go-live`, the exact proof this file exercises,
//     so the pointer and the proof can't drift apart;
//   * the LINKED page still carries the readiness command + its ordered human
//     steps + the needs-human / P-7 gate, so the pointer can't lead to an empty
//     or a relaxed-guardrail page.
//
// This is the same rot-guard the ADOPT.md funnel already has
// (test/adopt.docs.test.js › "README.md links to docs/ADOPT.md"); GO-LIVE.md is
// the more revenue-critical funnel and previously had none. Pure: reads the two
// files, opens no network, spawns nothing.
// ---------------------------------------------------------------------------
describe("T-61.2: docs/GO-LIVE.md is DISCOVERABLE + accurate from the repo front door", function () {
  const README = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
  const GOLIVE = fs.readFileSync(path.join(REPO, "docs", "GO-LIVE.md"), "utf8");

  // The single front-door pointer line — the one README line that links the page.
  const pointer = README.split("\n").find((l) => /\]\(docs\/GO-LIVE\.md\)/.test(l));

  it("the README front door carries a markdown link to docs/GO-LIVE.md", function () {
    expect(pointer, "README must have a line linking docs/GO-LIVE.md").to.be.a("string");
  });

  it("the pointer frames SELF-SERVE as the recommended default and the PILOT as the enterprise fallback", function () {
    expect(pointer, "pointer names the self-serve path").to.match(/self-serve/i);
    expect(pointer, "pointer marks self-serve the recommended default").to.match(/recommended default/i);
    expect(pointer, "pointer names the pilot path").to.match(/pilot/i);
    expect(pointer, "pointer marks the pilot the enterprise fallback").to.match(/enterprise fallback/i);
  });

  it("the pointer frames the page as the decision-ready 'first dollar' page", function () {
    expect(pointer, "pointer marks the page decision-ready").to.match(/decision-ready/i);
    expect(pointer, "pointer frames it as the first-dollar page").to.match(/first[ -]dollar/i);
  });

  it("the pointer cites `npm run go-live` — the exact proof this suite exercises (they can't drift apart)", function () {
    expect(pointer, "pointer cites npm run go-live").to.match(/npm run go-live/);
  });

  it("the LINKED page still cites the readiness proof and keeps its ordered human steps (no rot to a gutted page)", function () {
    expect(GOLIVE, "GO-LIVE.md cites npm run go-live").to.match(/npm run go-live/);
    expect(GOLIVE, "GO-LIVE.md keeps its ordered human-steps section").to.match(/##\s+The human steps/);
    expect(GOLIVE, "step 1 (provision the vendor keypair) present").to.match(/1\.\s+\*\*Provision the vendor keypair/);
    expect(GOLIVE, "step 4 (deploy) present").to.match(/4\.\s+\*\*Deploy/);
  });

  it("the linked page keeps its needs-human / P-7 gate (the discoverability change never relaxes the human step)", function () {
    expect(GOLIVE, "GO-LIVE.md keeps its needs-human tag").to.match(/needs-human/);
    expect(GOLIVE, "GO-LIVE.md keeps the P-7 pointer").to.match(/P-7/);
  });
});

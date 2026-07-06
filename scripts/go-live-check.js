#!/usr/bin/env node
"use strict";

// scripts/go-live-check.js — the EXECUTABLE, offline, dependency-free GO-LIVE READINESS PROOF (T-61.1).
//
// WHY THIS EXISTS
//   The whole verifyhash income family is BUILT and green — the last mile is a HUMAN switch-flip (provision
//   a real vendor key, set a price, wire Stripe, publish). The unresolved question that has kept the loop
//   from earning its first dollar is not "is a feature missing?" but "is this pile REALLY revenue-ready?".
//   This script turns that doubt into an executable YES: in one offline run it drives the WHOLE revenue
//   mechanism end-to-end with EPHEMERAL throwaway keys and prints a PASS/FAIL checklist, ending — verbatim,
//   last — with the ONLY remaining HUMAN steps and the revenue-integrity boundary.
//
// WHAT IT PROVES (three legs, each a real end-to-end path a customer would exercise)
//   LEG 1  seal -> independent-verify ...... the producer seals a folder and the INDEPENDENT verifier
//                                            (verifier/verify-vh.js, js-sha3 only) re-derives the SAME root
//                                            with no producer stack — "you need not trust the producer".
//   LEG 2  issue -> verify -> fail-closed ... a license is minted with an EPHEMERAL vendor key, verified
//                                            VALID against that vendor, and the paid `--sign` surface is
//                                            proven FAIL-CLOSED: REFUSED without a license, ACCEPTED with it.
//   LEG 3  fulfill -> deliver -> gate-accept  a sample paid ORDER is fulfilled from the bundled DRAFT plan
//                                            catalog (the self-serve billing-webhook -> fulfill -> deliver
//                                            loop) and the delivered signed license unlocks the gate, whose
//                                            output the INDEPENDENT verifier then accepts (vendor-pinned).
//
// POSTURE — GUARDRAILS BAKED IN. It holds NO real key (every key is an in-process Wallet.createRandom(),
//   passed to the CLI ONLY via an ephemeral env var and discarded on exit), opens NO network (no
//   http/https/net/dns — the only child processes are this repo's own `node cli/vh.js` and
//   `node verifier/verify-vh.js`), deploys NOTHING, takes NO payment, and writes ONLY a throwaway workspace
//   under the OS temp dir that it removes on exit (pass or fail). Same CI-gateable exit contract as the
//   family: 0 all-green / non-zero if ANY leg fails, naming the failed leg (never a false all-green).
//
// NEGATIVE SELF-TEST HOOK. Set GO_LIVE_INJECT_FAULT=<seal|gate|fulfill> to inject a realistic fault into
//   exactly one leg (a tampered sealed file, a wrong pinned vendor, a tampered delivery). This exists so the
//   proof can demonstrate it is NOT a rubber stamp: with a fault injected the check EXITS NON-ZERO and names
//   the broken leg. Unset (the normal case), it runs the real thing.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { Wallet } = require("ethers");

const REPO_ROOT = path.resolve(__dirname, "..");
const VH = path.join(REPO_ROOT, "cli", "vh.js");
const VERIFY_VH = path.join(REPO_ROOT, "verifier", "verify-vh.js");

// The license module supplies the INDEPENDENT license-verify (leg 2's "verify" step) — the same
// verifyLicense/readLicense core the paid gate uses, exercised out-of-band. Requiring a local module is
// fine; it pulls in NO network (this script requires no http/https/net/dns).
const evidence = require(path.join(REPO_ROOT, "cli", "evidence"));

// A plan in the bundled DRAFT catalog that carries the `evidence_signed` entitlement the `--sign` gate wants.
const PLAN_ID = "evidence-signed-monthly";

// Which single leg (if any) to inject a fault into — the negative self-test hook (see header).
const INJECT = String(process.env.GO_LIVE_INJECT_FAULT || "").trim();

// -----------------------------------------------------------------------------------------------------
// The VERBATIM final block. The positive test asserts this exact text is present, last. Kept as an exported
// constant so the proof's output and the test can never silently drift from each other.
// -----------------------------------------------------------------------------------------------------
const HUMAN_STEPS = [
  "================ REMAINING HUMAN STEPS — the loop CANNOT and MUST NOT do these ================",
  "",
  "  1. Provision a REAL vendor signing key OUTSIDE the loop (hardware wallet / KMS / secret",
  "     manager). The loop holds NO real key and never will; this check used ONLY an ephemeral",
  "     Wallet.createRandom() key that is discarded when it exits.",
  "  2. Set the real PRICE and TERM for each tier in the evidence plan catalog",
  "     (cli/core/fixtures/evidence-plans/baseline.json is a DRAFT skeleton — the loop sets NO price).",
  "  3. Wire Stripe Checkout (or any billing webhook) so a paid order runs",
  "     `vh evidence license fulfill --plan <id> --customer <name> --key-env <VAR>` and DELIVERS the",
  "     minted *.vhevidence-license.json to the customer.",
  "  4. PUBLISH: deploy the independent verifier / verify service where customers can reach it — a HUMAN",
  "     deploy step (the loop deploys NOTHING to any real or public network).",
  "",
  "REVENUE-INTEGRITY BOUNDARY: a verifyhash license is an ACCESS credential for delivered software value —",
  "NOT a token/coin/NFT, not tradeable, not an appreciating asset. Income comes from selling software value",
  "to paying customers, never from anyone buying an asset that must appreciate.",
].join("\n");

// -----------------------------------------------------------------------------------------------------
// Tiny process + result helpers.
// -----------------------------------------------------------------------------------------------------

// Run `node <script> <args...>` with an optional extra-env overlay; capture status/stdout/stderr. A process
// killed by a signal (status === null) is normalized to a non-zero failure.
function node(script, args, extraEnv) {
  const res = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: Object.assign({}, process.env, extraEnv || {}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: res.status === null ? 1 : res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

function pass(detail) {
  return { ok: true, detail };
}
// A leg failure carries a human reason and (optionally) the offending child run for diagnostics.
function fail(reason, run) {
  const detail = [reason];
  if (run) {
    detail.push(`exit ${run.status}`);
    const msg = (run.stderr || run.stdout || "").trim().split("\n").slice(-3).join("\n");
    if (msg) detail.push(msg);
  }
  return { ok: false, detail };
}

// Seed a small sample folder with a couple of files.
function seedData(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.txt"), "alpha payload — go-live self-test\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "beta payload — go-live self-test\n");
  return dir;
}

// -----------------------------------------------------------------------------------------------------
// LEG 1 — seal -> independent-verify.
// -----------------------------------------------------------------------------------------------------
function legSeal(ws) {
  const data = seedData(path.join(ws, "leg1-data"));
  const seal = path.join(ws, "leg1-seal.vhevidence.json");

  const s = node(VH, ["evidence", "seal", data, "--out", seal]);
  if (s.status !== 0 || !fs.existsSync(seal)) {
    return fail("producer `vh evidence seal` did not produce a seal", s);
  }

  // NEGATIVE self-test: tamper a sealed file AFTER sealing so the independent re-derivation must catch it.
  if (INJECT === "seal") fs.writeFileSync(path.join(data, "a.txt"), "TAMPERED after sealing\n");

  const v = node(VERIFY_VH, [seal, "--dir", data]);
  if (v.status !== 0) {
    return fail("INDEPENDENT verifier (verify-vh) rejected the seal — root did not re-derive", v);
  }
  return pass([
    "producer sealed a sample folder into a *.vhevidence.json packet",
    "INDEPENDENT verifier re-derived the SAME keccak root (no producer stack) — exit 0",
  ]);
}

// -----------------------------------------------------------------------------------------------------
// LEG 2 — issue -> verify -> fail-closed-gate.
// -----------------------------------------------------------------------------------------------------
function legGate(ws) {
  const data = seedData(path.join(ws, "leg2-data"));
  const wallet = Wallet.createRandom();
  const keyVar = "VH_GOLIVE_VENDOR_KEY_2";
  // The paid gate pins license verification to the CANONICAL vendor identity (T-75.3). This check
  // validates an OPERATOR instance end-to-end with an EPHEMERAL vendor key, so it declares that key as
  // the child CLI's canonical identity via VH_CANONICAL_VENDOR — the documented self-hosting config
  // channel (docs/LICENSING.md), NOT a --vendor re-pin (argv can never re-pin the gate).
  const env = { [keyVar]: wallet.privateKey, VH_CANONICAL_VENDOR: wallet.address };
  const lic = path.join(ws, "leg2-license.vhevidence-license.json");

  // ISSUE — mint a signed license with the EPHEMERAL vendor key (key passed only via env, never on disk).
  const f = node(
    VH,
    ["evidence", "license", "fulfill", "--plan", PLAN_ID, "--customer", "Go-Live Self-Test", "--key-env", keyVar, "--out", lic],
    env
  );
  if (f.status !== 0 || !fs.existsSync(lic)) {
    return fail("could not ISSUE (fulfill) an evidence license with an ephemeral vendor key", f);
  }

  // VERIFY — independently confirm the minted license is VALID against that vendor (same core the gate uses).
  let verdict;
  try {
    verdict = evidence.verifyLicense(evidence.readLicense(fs.readFileSync(lic, "utf8")), {
      now: new Date(),
      vendorAddress: wallet.address,
    });
  } catch (e) {
    return fail(`minted license failed to parse/verify: ${e.message}`);
  }
  if (!verdict || verdict.valid !== true) {
    return fail(`minted license did NOT verify VALID (reason: ${verdict ? verdict.reason : "unknown"})`);
  }

  // FAIL-CLOSED — the paid `--sign` surface must be REFUSED without a license (no output, non-zero exit).
  const signOut = path.join(ws, "leg2-signed.vhevidence.json");
  const noLic = node(VH, ["evidence", "seal", data, "--sign", "--key-env", keyVar, "--out", signOut], env);
  if (noLic.status === 0 || fs.existsSync(signOut)) {
    return fail("GATE NOT FAIL-CLOSED: paid `--sign` was accepted WITHOUT a license", noLic);
  }

  // ACCEPT-WITH — the same surface must be ACCEPTED with the valid license. The fault injection asserts
  // a WRONG --vendor: under the canonical pin that is a NAMED re-pin refusal (usage exit, nothing
  // written) — the gate must fail loud, proving --vendor can no longer re-pin verification (T-75.3).
  const vendorArg = INJECT === "gate" ? Wallet.createRandom().address : wallet.address;
  const withLic = node(
    VH,
    ["evidence", "seal", data, "--sign", "--key-env", keyVar, "--license", lic, "--vendor", vendorArg, "--out", signOut],
    env
  );
  if (withLic.status !== 0 || !fs.existsSync(signOut)) {
    return fail("gate REJECTED a VALID license — the paid `--sign` should have been accepted", withLic);
  }
  return pass([
    "minted a signed evidence license with an EPHEMERAL Wallet.createRandom() vendor key",
    "license verified VALID against the vendor (independent verifyLicense)",
    "paid `--sign` REFUSED without a license (fail-closed) and ACCEPTED with it",
  ]);
}

// -----------------------------------------------------------------------------------------------------
// LEG 3 — fulfill -> deliver -> gate-accept (the self-serve loop).
// -----------------------------------------------------------------------------------------------------
function legFulfill(ws) {
  const data = seedData(path.join(ws, "leg3-data"));
  const wallet = Wallet.createRandom();
  const keyVar = "VH_GOLIVE_VENDOR_KEY_3";
  // As in leg 2: the ephemeral operator key is declared as the child CLI's canonical vendor identity
  // via the documented VH_CANONICAL_VENDOR config channel (T-75.3) — never a --vendor re-pin.
  const env = { [keyVar]: wallet.privateKey, VH_CANONICAL_VENDOR: wallet.address };
  const lic = path.join(ws, "leg3-license.vhevidence-license.json");

  // FULFILL — a sample paid order resolved against the bundled DRAFT catalog (billing-webhook -> fulfill).
  const f = node(
    VH,
    ["evidence", "license", "fulfill", "--plan", PLAN_ID, "--customer", "Acme (self-serve order)", "--key-env", keyVar, "--out", lic],
    env
  );
  if (f.status !== 0 || !fs.existsSync(lic)) {
    return fail("could not FULFILL the sample order from the bundled DRAFT plan catalog", f);
  }

  // DELIVER — hand the minted license to the paid gate and confirm it unlocks `--sign`.
  const signed = path.join(ws, "leg3-signed.vhevidence.json");
  const g = node(
    VH,
    ["evidence", "seal", data, "--sign", "--key-env", keyVar, "--license", lic, "--vendor", wallet.address, "--out", signed],
    env
  );
  if (g.status !== 0 || !fs.existsSync(signed)) {
    return fail("the delivered license did NOT unlock the paid gate (`--sign` rejected)", g);
  }

  // NEGATIVE self-test: tamper the delivered bytes so the independent gate-accept verify must catch it.
  if (INJECT === "fulfill") fs.writeFileSync(path.join(data, "a.txt"), "TAMPERED delivery\n");

  // GATE-ACCEPT — the INDEPENDENT verifier accepts the delivered signed seal, pinned to the vendor.
  const v = node(VERIFY_VH, [signed, "--dir", data, "--vendor", wallet.address]);
  if (v.status !== 0) {
    return fail("INDEPENDENT verifier rejected the delivered signed seal (root/vendor did not check out)", v);
  }
  return pass([
    `fulfilled plan '${PLAN_ID}' from the bundled DRAFT catalog (self-serve fulfill)`,
    "the delivered signed license unlocked the paid `--sign` gate",
    "INDEPENDENT verifier accepted the delivered signed seal (vendor-pinned) — exit 0",
  ]);
}

// -----------------------------------------------------------------------------------------------------
// Driver.
// -----------------------------------------------------------------------------------------------------
const LEGS = [
  { id: "seal", title: "seal -> independent-verify", run: legSeal },
  { id: "gate", title: "issue -> verify -> fail-closed-gate", run: legGate },
  { id: "fulfill", title: "fulfill -> deliver -> gate-accept", run: legFulfill },
];

function main(write) {
  const emit = write || ((s) => process.stdout.write(s));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "vh-golive-"));

  emit("verifyhash — GO-LIVE READINESS PROOF\n");
  emit("(offline, ephemeral-key, no network, no deploy, no real funds)\n");
  emit(`workspace: ${ws} (throwaway; removed on exit)\n`);
  if (INJECT) emit(`NOTE: fault injected into leg '${INJECT}' (negative self-test)\n`);
  emit("\n");

  let failedLeg = null;
  try {
    for (let i = 0; i < LEGS.length; i++) {
      const leg = LEGS[i];
      let r;
      try {
        r = leg.run(ws);
      } catch (e) {
        r = fail(`unexpected error: ${e && e.message ? e.message : String(e)}`);
      }
      const verdict = r.ok ? "PASS" : "FAIL";
      emit(`LEG ${i + 1}  ${leg.title}  ...  ${verdict}\n`);
      for (const d of r.detail) emit(`         - ${d}\n`);
      emit("\n");
      if (!r.ok) {
        failedLeg = leg;
        break; // fail fast — a broken leg means NOT go-live-ready
      }
    }
  } finally {
    // Always remove the throwaway workspace — pass or fail, no stray files.
    fs.rmSync(ws, { recursive: true, force: true });
  }

  if (failedLeg) {
    emit(`GO-LIVE CHECK FAILED at leg: ${failedLeg.title}\n`);
    emit("The revenue mechanism is NOT green end-to-end — fix the failing leg before going live.\n");
    return 1;
  }

  emit("ALL LEGS PASS — the revenue mechanism is green end-to-end.\n\n");
  emit(HUMAN_STEPS + "\n");
  return 0;
}

module.exports = { main, HUMAN_STEPS, LEGS, PLAN_ID };

if (require.main === module) {
  process.exit(main());
}

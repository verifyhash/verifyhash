#!/usr/bin/env node
"use strict";

// =================================================================================================
// verifyhash — the runnable, OFFLINE, EPHEMERAL-KEY EVIDENCE PILOT KIT (T-32.1)
//
// WHAT THIS IS
//   The single artifact every revenue gate waits on: an end-to-end, OFFLINE, ephemeral-key demo a human
//   can hand a paying design partner TODAY. It drives the REAL evidence buyer journey end to end against
//   the committed sample under pilot/sample-evidence/ — with ZERO setup (no real key, no TSA, no RPC, no
//   network) — and prints ONE PASS/FAIL verdict:
//
//     1. ISSUE   an evidence LICENSE signed by an ephemeral VENDOR key (Wallet.createRandom()).
//     2. GATE    prove the PAID `evidence seal --sign` surface is REFUSED with no license (usage exit),
//                and REFUSED again when the license is pinned to the WRONG vendor (a clean gate reject).
//     3. SIGN    run the SAME paid surface WITH the valid license + a SEPARATE ephemeral operator key,
//                and confirm it succeeds (a signed *.vhevidence.json packet).
//     4. HAND OFF only the PACKET (+ its sibling files) to the INDEPENDENT verifier (verifier/verify-vh.js
//                — js-sha3 only, NO ethers/hardhat) and confirm it ACCEPTS (exit 0), pinning the operator
//                key as --vendor.
//     5. TAMPER  mutate one sealed file and confirm the SAME independent verifier REJECTS it (exit 3) and
//                localizes the change to the exact file.
//
//   It reuses the EXACT module entrypoints the `vh` CLI dispatches to (cli/evidence.js) and the exact
//   standalone `verify-vh` the counterparty would run — it is NOT a brittle shell pipeline of strings.
//
// REVENUE-INTEGRITY + GUARDRAILS (load-bearing; the kit will not let you forget them)
//   * EPHEMERAL KEYS ONLY. Every signing key is an in-process Wallet.createRandom() created, used, and
//     discarded. The kit NEVER creates, holds, persists, or reads a real private key, and never echoes key
//     material. The operator key is handed to the seal command via a process-scoped env var that is
//     restored when the step ends.
//   * NO FILESYSTEM FOOTPRINT IN THE REPO. The committed sample under pilot/sample-evidence/ is READ-ONLY.
//     Everything the run produces — the license, the signed packet, the working COPY it deliberately
//     tampers — is written to a fresh OS temp workspace (or PILOT_OUT if you set it) and removed on exit.
//     Set PILOT_KEEP=1 to keep the temp dir for inspection.
//   * OFFLINE + DETERMINISTIC. No network, no clock dependence in the trust decisions: the license window
//     is dated with an INJECTED `now`, so the verdict is reproducible.
//   * THE HONEST TRUST BOUNDARY. The seal proves TAMPER-EVIDENCE + WHO vouched (the operator key), NOT a
//     trusted timestamp ("sealed at T" rides the human-owned signing/timestamp trust-root, STRATEGY.md
//     P-3) and NOT a legal opinion. The kit ENDS at the explicit human handoff and overclaims nothing.
// =================================================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet } = require("ethers");

const evidence = require("../cli/evidence");
const verifyVh = require("../verifier/verify-vh");

const PILOT_DIR = __dirname;
const SAMPLE_EVIDENCE = path.join(PILOT_DIR, "sample-evidence");

// A FIXED injected clock so the license window verdict is deterministic (no system-clock dependence). The
// license is minted issued < NOW < expires.
const NOW = new Date("2026-06-24T12:00:00.000Z");
const ISSUED = "2026-06-01T00:00:00.000Z";
const EXPIRES = "2027-06-01T00:00:00.000Z";

// ---- tiny output + check helpers -----------------------------------------------------------------

const out = (s) => process.stdout.write(s + "\n");
const hr = () => out("-".repeat(92));

const checks = []; // { ok, label } — the run's verdict is the AND of every one of these.
function check(label, ok, detail) {
  checks.push({ ok: !!ok, label });
  out(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? "  — " + detail : ""}`);
}

// Capture an io object for the cli/evidence run functions: collects stdout/stderr, injects the fixed clock.
function capture() {
  const o = [];
  const e = [];
  return {
    write: (s) => o.push(s),
    writeErr: (s) => e.push(s),
    now: NOW,
    out: () => o.join(""),
    err: () => e.join(""),
  };
}

// Recursively copy a directory tree (the sample is tiny). The TAMPER step mutates a working COPY in the
// temp workspace, never the committed sample under pilot/sample-evidence/.
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

// ---- the pilot run -------------------------------------------------------------------------------

// runPilot(workspace) — drive the whole journey inside `workspace` (a caller-owned temp dir). PURE w.r.t.
// the repo: it reads pilot/sample-evidence/ and writes ONLY under `workspace`. Returns true iff every
// check passed. Injectable so the test can run it against its own throwaway dir and assert cwd is clean.
async function runPilot(workspace) {
  out("");
  out("verifyhash — OFFLINE, ephemeral-key EVIDENCE PILOT KIT");
  out(
    "This kit drives the REAL evidence buyer journey end to end against committed sample data, with no\n" +
      "real key, no network, and no timestamp/anchor. It proves TAMPER-EVIDENCE + WHO vouched — NOT a\n" +
      'trusted timestamp ("sealed at T" rides the human trust-root, STRATEGY.md P-3) and NOT legal advice.'
  );
  hr();

  // The working COPY of the evidence dir we will seal (and later tamper). The committed sample is untouched.
  const evidenceDir = path.join(workspace, "evidence");
  copyDir(SAMPLE_EVIDENCE, evidenceDir);

  // -----------------------------------------------------------------------------------------------
  // STEP 1 — ISSUE: mint an evidence LICENSE signed by an EPHEMERAL VENDOR key.
  // -----------------------------------------------------------------------------------------------
  out("STEP 1 — issue an evidence license (ephemeral vendor key)");
  const vendorWallet = Wallet.createRandom(); // EPHEMERAL — created, used, discarded. Never persisted.
  const vendorAddress = vendorWallet.address;
  const licenseContainer = await evidence.buildLicense(
    {
      licenseId: "PILOT-EVIDENCE-1",
      customer: "Design Partner (pilot)",
      plan: "pro",
      entitlements: ["evidence_signed"],
      issuedAt: ISSUED,
      expiresAt: EXPIRES,
    },
    vendorWallet
  );
  const licenseFile = path.join(workspace, "evidence.vhlicense.json");
  fs.writeFileSync(licenseFile, JSON.stringify(licenseContainer) + "\n");

  // The license re-verifies OFFLINE, pinned to the vendor key, in-window at NOW, granting evidence_signed.
  const licVerdict = evidence.verifyLicense(evidence.readLicense(fs.readFileSync(licenseFile, "utf8")), {
    now: NOW,
    vendorAddress,
  });
  check(
    "license verifies OFFLINE, pinned to the ephemeral vendor key, in-window",
    licVerdict.valid && licVerdict.reason === null,
    `vendor ${vendorAddress.slice(0, 10)}…`
  );
  check(
    "license carries the paid `evidence_signed` entitlement",
    evidence.hasEntitlement(licVerdict, "evidence_signed")
  );
  hr();

  // -----------------------------------------------------------------------------------------------
  // STEP 2 — GATE: the PAID `--sign` surface is REFUSED without a valid license.
  // -----------------------------------------------------------------------------------------------
  out("STEP 2 — the PAID `evidence seal --sign` surface is refused without a valid license");

  // (a) NO license at all -> a usage refusal (exit 2), naming the paid surface, never echoing a key.
  {
    const io = capture();
    const code = await evidence.runEvidenceSeal(
      { dir: evidenceDir, sign: true, keyEnv: "PILOT_NO_SUCH_KEY" },
      io
    );
    check(
      "no-license `--sign` is REFUSED (usage exit), with a key-free message",
      code === evidence.EXIT.USAGE &&
        /PAID surface and\s+requires a license/.test(io.err()) &&
        !/0x[0-9a-fA-F]{40}/.test(io.err()),
      `exit ${code}`
    );
  }

  // (b) A license pinned to the WRONG vendor -> a clean gate reject (exit 3, wrong_issuer), nothing written.
  {
    const wrongVendor = Wallet.createRandom().address; // a DIFFERENT key than the one that signed the license
    const wrongOut = path.join(workspace, "should-not-exist.vhevidence.json");
    const opWallet = Wallet.createRandom();
    const PREV = process.env.PILOT_OP_KEY;
    process.env.PILOT_OP_KEY = opWallet.privateKey;
    try {
      const io = capture();
      const code = await evidence.runEvidenceSeal(
        {
          dir: evidenceDir,
          out: wrongOut,
          sign: true,
          keyEnv: "PILOT_OP_KEY",
          license: licenseFile,
          vendor: wrongVendor,
        },
        io
      );
      check(
        "license pinned to the WRONG vendor is REFUSED (wrong_issuer), nothing written",
        code === evidence.EXIT.FAIL &&
          /wrong_issuer/.test(io.err()) &&
          !fs.existsSync(wrongOut),
        `exit ${code}`
      );
    } finally {
      if (PREV === undefined) delete process.env.PILOT_OP_KEY;
      else process.env.PILOT_OP_KEY = PREV;
    }
  }
  hr();

  // -----------------------------------------------------------------------------------------------
  // STEP 3 — SIGN: the SAME paid surface SUCCEEDS with the valid license + a separate operator key.
  // -----------------------------------------------------------------------------------------------
  out("STEP 3 — `evidence seal --sign` SUCCEEDS with the valid license (ephemeral operator key)");
  const packetFile = path.join(workspace, "evidence-packet.vhevidence.json");
  const operatorWallet = Wallet.createRandom(); // SEPARATE ephemeral key — the operator who vouches.
  const operatorAddress = operatorWallet.address;
  {
    const PREV = process.env.PILOT_OP_KEY;
    process.env.PILOT_OP_KEY = operatorWallet.privateKey;
    try {
      const io = capture();
      const code = await evidence.runEvidenceSeal(
        {
          dir: evidenceDir,
          out: packetFile,
          sign: true,
          keyEnv: "PILOT_OP_KEY",
          license: licenseFile,
          vendor: vendorAddress,
        },
        io
      );
      check(
        "valid-license `--sign` SUCCEEDS and writes a signed packet",
        code === evidence.EXIT.OK && fs.existsSync(packetFile),
        `exit ${code}`
      );
    } finally {
      if (PREV === undefined) delete process.env.PILOT_OP_KEY;
      else process.env.PILOT_OP_KEY = PREV;
    }
  }

  // The packet on disk is a signed evidence-seal container; the operator key is recorded as the signer.
  const packet = JSON.parse(fs.readFileSync(packetFile, "utf8"));
  check(
    "the packet is a signed evidence-seal container (`vh.evidence-seal-signed`)",
    packet.kind === evidence.SIGNED_SEAL_KIND
  );
  check(
    "the packet's signer is the ephemeral OPERATOR key",
    packet.signature &&
      typeof packet.signature.signer === "string" &&
      packet.signature.signer.toLowerCase() === operatorAddress.toLowerCase()
  );
  hr();

  // -----------------------------------------------------------------------------------------------
  // STEP 4 — HAND OFF: the INDEPENDENT verifier ACCEPTS the untampered packet (exit 0), using ONLY
  //          the verifier tree (verifier/verify-vh.js — js-sha3, NO ethers/hardhat).
  // -----------------------------------------------------------------------------------------------
  out("STEP 4 — hand ONLY the packet to the INDEPENDENT verifier (verify-vh); it ACCEPTS");
  {
    // The counterparty resolves sibling bytes next to the packet; we pass --dir explicitly so the demo is
    // location-independent. We PIN the operator key as --vendor — the verifier confirms WHO vouched.
    const io = capture();
    const code = verifyVh.run(
      ["--json", "--dir", evidenceDir, "--vendor", operatorAddress, packetFile],
      io
    );
    let parsed = null;
    try {
      parsed = JSON.parse(io.out());
    } catch (_) {
      parsed = null;
    }
    check(
      "independent verify-vh ACCEPTS the untampered packet (exit 0)",
      code === verifyVh.EXIT.OK && parsed && parsed.verdict === "OK",
      `exit ${code}`
    );
    check(
      "verify-vh recovered + pinned the operator key as the signer (signed: yes)",
      parsed &&
        parsed.signed === true &&
        parsed.signerMatchesVendor === true &&
        String(parsed.recoveredSigner).toLowerCase() === operatorAddress.toLowerCase()
    );
    check(
      "verify-vh RE-DERIVED the root from the bytes you hold (root matches)",
      parsed && parsed.rootMatches === true
    );
  }
  hr();

  // -----------------------------------------------------------------------------------------------
  // STEP 5 — TAMPER: mutate one sealed file; the SAME independent verifier REJECTS it (exit 3).
  // -----------------------------------------------------------------------------------------------
  out("STEP 5 — tamper one sealed file; the INDEPENDENT verifier REJECTS it (exit 3)");
  {
    const tamperTarget = path.join(evidenceDir, "access-log.csv");
    const before = fs.readFileSync(tamperTarget, "utf8");
    fs.writeFileSync(tamperTarget, before + "2026-05-12T11:00:00Z,attacker,delete,access-log,ok\n");

    const io = capture();
    const code = verifyVh.run(
      ["--json", "--dir", evidenceDir, "--vendor", operatorAddress, packetFile],
      io
    );
    let parsed = null;
    try {
      parsed = JSON.parse(io.out());
    } catch (_) {
      parsed = null;
    }
    const changedPaths = parsed && Array.isArray(parsed.changed) ? parsed.changed.map((c) => c.relPath) : [];
    check(
      "independent verify-vh REJECTS the tampered packet (exit 3)",
      code === verifyVh.EXIT.REJECTED && parsed && parsed.verdict === "REJECTED",
      `exit ${code}`
    );
    check(
      "verify-vh localizes the tamper to EXACTLY the changed file (access-log.csv)",
      changedPaths.length === 1 && changedPaths[0] === "access-log.csv"
    );
  }
  hr();

  out("HUMAN HANDOFF (where the pilot ENDS — these are the needs-human steps, NOT done here):");
  out("  * provision a REAL vendor signing key in your own KMS/secret store (this kit used throwaway keys);");
  out("  * agree the subscription contract + price; the license GATES the paid surface, it is NOT the contract;");
  out('  * for a standing "sealed at T" claim, add the human-owned timestamp/anchor trust-root (P-3).');
  hr();

  const passed = checks.filter((c) => c.ok).length;
  const total = checks.length;
  const allOk = passed === total;
  out(`VERDICT: ${allOk ? "PASS" : "FAIL"} — ${passed}/${total} checks passed.`);
  out("");
  return allOk;
}

// ---- entrypoint: own a temp workspace, run, clean up (pass or fail) -------------------------------

async function main() {
  // A caller-chosen workspace (PILOT_OUT) or a throwaway OS temp dir. NEVER cwd, NEVER the repo tree.
  const keep = process.env.PILOT_KEEP === "1";
  let workspace;
  let ownTemp = false;
  if (process.env.PILOT_OUT) {
    workspace = path.resolve(process.env.PILOT_OUT);
    fs.mkdirSync(workspace, { recursive: true });
  } else {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "vh-pilot-"));
    ownTemp = true;
  }

  let ok = false;
  try {
    ok = await runPilot(workspace);
  } finally {
    if (ownTemp && !keep) {
      fs.rmSync(workspace, { recursive: true, force: true });
    } else if (keep) {
      out(`(PILOT_KEEP=1) workspace kept at: ${workspace}`);
    }
  }
  return ok ? 0 : 1;
}

// CLI shim: only run when invoked directly (so the module is importable in tests without side effects).
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`pilot: unexpected error: ${e && e.stack ? e.stack : e}\n`);
      process.exit(1);
    });
}

module.exports = { runPilot, main, NOW, ISSUED, EXPIRES, SAMPLE_EVIDENCE };

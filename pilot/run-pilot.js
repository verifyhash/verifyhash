#!/usr/bin/env node
"use strict";

// =================================================================================================
// verifyhash — the runnable, OFFLINE, EPHEMERAL-KEY PILOT KIT (T-32.1 evidence + T-32.2 reconcile)
//
// WHAT THIS IS
//   The single artifact every revenue gate waits on: an end-to-end, OFFLINE, ephemeral-key demo a human
//   can hand a paying design partner TODAY. It drives BOTH sellable buyer journeys end to end against
//   committed sample data — with ZERO setup (no real key, no TSA, no RPC, no network) — and prints ONE
//   combined PASS/FAIL verdict spanning both verticals:
//
//   VERTICAL A — EVIDENCE (the security/audit-evidence packet; pilot/sample-evidence/):
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
//   VERTICAL B — RECONCILE (the TrustLedger three-way trust-account reconciliation; trustledger e2e fixtures):
//     1. ISSUE   a TrustLedger LICENSE (the `seal` entitlement) signed by an ephemeral VENDOR key.
//     2. GATE    prove the PAID `vh trust reconcile --seal` surface is REFUSED with no license (usage exit),
//                and REFUSED again when the license is pinned to the WRONG vendor — and that the gate writes
//                NO packet/seal when it refuses.
//     3. UNLOCK  run the SAME paid surface WITH the valid license + matching vendor, confirm it reconciles
//                (a single PASS/FAIL) and emits the audit packet + a tamper-evident reconciliation seal.
//     4. HAND OFF only the SEAL (+ the sibling source/packet files) to the SAME INDEPENDENT verify-vh and
//                confirm it ACCEPTS (exit 0) by RE-DERIVING the keccak root — no producer stack.
//     5. TAMPER  mutate one sealed file and confirm verify-vh REJECTS it (exit 3) and localizes the change.
//
//   It reuses the EXACT module entrypoints the `vh` CLI dispatches to (cli/evidence.js, trustledger/cli.js)
//   and the exact standalone `verify-vh` the counterparty would run — NOT a brittle shell pipeline of strings.
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
const trust = require("../trustledger/cli");
const trustLicense = require("../trustledger/license");
const trustSeal = require("../trustledger/seal");
const verifyVh = require("../verifier/verify-vh");

const PILOT_DIR = __dirname;
const REPO_DIR = path.resolve(PILOT_DIR, "..");
const SAMPLE_EVIDENCE = path.join(PILOT_DIR, "sample-evidence");

// The committed three-way reconcile sample. Reuses the proven trustledger e2e fixtures (READ-ONLY) so
// the reconcile vertical drives REAL, known-good inputs that tie out to a clean PASS.
const SAMPLE_RECONCILE = path.join(REPO_DIR, "trustledger", "fixtures", "e2e");
const RECONCILE_SOURCES = Object.freeze({
  bank: "bank.csv",
  ledger: "quickbooks.csv",
  rentroll: "rentroll.csv",
});

// A FIXED injected clock so the license window verdict is deterministic (no system-clock dependence). The
// license is minted issued < NOW < expires.
const NOW = new Date("2026-06-24T12:00:00.000Z");
const ISSUED = "2026-06-01T00:00:00.000Z";
const EXPIRES = "2027-06-01T00:00:00.000Z";

// The reconcile report date — a FIXED "YYYY-MM-DD" so the packet/seal are byte-deterministic, AND the
// instant the TrustLedger license gate dates verification at. It falls strictly inside [ISSUED, EXPIRES]
// so a VALID license is in-window. The e2e sample is a May-2026 statement period.
const RECONCILE_DATE = "2026-06-15";

// ---- tiny output + check helpers -----------------------------------------------------------------

const out = (s) => process.stdout.write(s + "\n");
const hr = () => out("-".repeat(92));

// check(checks, label, ok, detail) — record + print one check onto a caller-owned array. The run's
// combined verdict is the AND of every check across BOTH verticals.
function check(checks, label, ok, detail) {
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

// runPilot(workspace) — drive BOTH sellable journeys (evidence + reconcile) inside `workspace` (a
// caller-owned temp dir) and fold them into ONE combined PASS/FAIL verdict. PURE w.r.t. the repo: it
// reads the committed READ-ONLY samples and writes ONLY under `workspace`. Returns true iff EVERY check
// across BOTH verticals passed. Injectable so the test can run it against its own throwaway dir.
async function runPilot(workspace) {
  out("");
  out("verifyhash — OFFLINE, ephemeral-key PILOT KIT (evidence + reconcile)");
  out(
    "This kit drives BOTH real buyer journeys end to end against committed sample data, with no real key,\n" +
      "no network, and no timestamp/anchor. Each license-GATES a paid surface (refused without, unlocked\n" +
      "with) and the INDEPENDENT verify-vh accepts the emitted artifact and REJECTS a tamper. It proves\n" +
      'TAMPER-EVIDENCE + WHO vouched — NOT a trusted timestamp ("sealed at T" rides the human trust-root,\n' +
      "STRATEGY.md P-3) and NOT legal advice (a CPA still governs the reconciliation)."
  );
  hr();

  // ONE shared verdict array: every check from BOTH verticals lands here, so the printed VERDICT is the
  // single AND of the whole combined journey.
  const checks = [];

  await runEvidencePilot(workspace, checks);
  await runReconcilePilot(workspace, checks);

  out("HUMAN HANDOFF (where the pilot ENDS — these are the needs-human steps, NOT done here):");
  out("  * provision a REAL vendor signing key in your own KMS/secret store (this kit used throwaway keys);");
  out("  * agree the subscription contract + price; the license GATES the paid surface, it is NOT the contract;");
  out('  * for a standing "sealed at T" claim, add the human-owned timestamp/anchor trust-root (P-3);');
  out("  * have a CPA review the reconciliation — the seal proves the bytes, not the legal verdict.");
  hr();

  const passed = checks.filter((c) => c.ok).length;
  const total = checks.length;
  const allOk = passed === total;
  out(`VERDICT: ${allOk ? "PASS" : "FAIL"} — ${passed}/${total} checks passed (evidence + reconcile).`);
  out("");
  return allOk;
}

// ---- VERTICAL A — the EVIDENCE buyer journey ----------------------------------------------------

// runEvidencePilot(workspace, checks) — drive the evidence journey, appending each check to `checks`.
// Reads pilot/sample-evidence/ (READ-ONLY) and writes ONLY under `workspace`.
async function runEvidencePilot(workspace, checks) {
  out("VERTICAL A — EVIDENCE (the signed, tamper-evident audit-evidence packet)");
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
  check(checks,
    "license verifies OFFLINE, pinned to the ephemeral vendor key, in-window",
    licVerdict.valid && licVerdict.reason === null,
    `vendor ${vendorAddress.slice(0, 10)}…`
  );
  check(checks,
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
    check(checks,
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
      check(checks,
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
      check(checks,
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
  check(checks,
    "the packet is a signed evidence-seal container (`vh.evidence-seal-signed`)",
    packet.kind === evidence.SIGNED_SEAL_KIND
  );
  check(checks,
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
    check(checks,
      "independent verify-vh ACCEPTS the untampered packet (exit 0)",
      code === verifyVh.EXIT.OK && parsed && parsed.verdict === "OK",
      `exit ${code}`
    );
    check(checks,
      "verify-vh recovered + pinned the operator key as the signer (signed: yes)",
      parsed &&
        parsed.signed === true &&
        parsed.signerMatchesVendor === true &&
        String(parsed.recoveredSigner).toLowerCase() === operatorAddress.toLowerCase()
    );
    check(checks,
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
    check(checks,
      "independent verify-vh REJECTS the tampered packet (exit 3)",
      code === verifyVh.EXIT.REJECTED && parsed && parsed.verdict === "REJECTED",
      `exit ${code}`
    );
    check(
      checks,
      "verify-vh localizes the tamper to EXACTLY the changed file (access-log.csv)",
      changedPaths.length === 1 && changedPaths[0] === "access-log.csv"
    );
  }
  hr();
}

// ---- VERTICAL B — the RECONCILE (TrustLedger) buyer journey -------------------------------------

// runReconcilePilot(workspace, checks) — drive the TrustLedger three-way reconcile journey, appending
// each check to the SAME shared `checks` array so it folds into the one combined verdict. Reads the
// committed trustledger/fixtures/e2e/ sources (READ-ONLY) and writes ONLY under `workspace`.
//
// The paid surface here is `vh trust reconcile --seal` (the tamper-evident reconciliation seal). The
// FREE tier — a baseline reconcile with NO seal — needs no license; the seal is license-gated on the
// `seal` entitlement. We prove: refused without a license, refused with the WRONG vendor (nothing
// written), unlocked WITH the matching license; the emitted seal is independently accepted by the SAME
// verify-vh and a tamper is rejected + localized.
async function runReconcilePilot(workspace, checks) {
  out("VERTICAL B — RECONCILE (the TrustLedger three-way trust-account reconciliation seal)");
  hr();

  // A working COPY of the three reconcile sources we will seal (and later tamper). The committed e2e
  // fixtures are untouched. The CLI seals INPUTS by basename, so verify-vh resolves the sources NEXT TO
  // the seal — we therefore keep them in a flat dir and emit the packet/seal into the SAME dir.
  const reconcileDir = path.join(workspace, "reconcile");
  fs.mkdirSync(reconcileDir, { recursive: true });
  const bankFile = path.join(reconcileDir, RECONCILE_SOURCES.bank);
  const ledgerFile = path.join(reconcileDir, RECONCILE_SOURCES.ledger);
  const rentFile = path.join(reconcileDir, RECONCILE_SOURCES.rentroll);
  fs.copyFileSync(path.join(SAMPLE_RECONCILE, RECONCILE_SOURCES.bank), bankFile);
  fs.copyFileSync(path.join(SAMPLE_RECONCILE, RECONCILE_SOURCES.ledger), ledgerFile);
  fs.copyFileSync(path.join(SAMPLE_RECONCILE, RECONCILE_SOURCES.rentroll), rentFile);

  // The seal lands at the CLI's default name under --out (reconciliation-<date>-seal.json).
  const sealFile = path.join(reconcileDir, `reconciliation-${RECONCILE_DATE}-seal.json`);

  // A small io capture for the trustledger CLI runReconcile (collects stdout/stderr; pins `today` so the
  // report date is deterministic when --date is also passed — belt and suspenders).
  const trustIo = () => {
    const o = [];
    const e = [];
    return {
      write: (s) => o.push(s),
      writeErr: (s) => e.push(s),
      today: () => RECONCILE_DATE,
      out: () => o.join(""),
      err: () => e.join(""),
    };
  };

  // The base reconcile argv (the three sources + a fixed date), shared across the gate/unlock runs.
  const baseArgs = [bankFile, ledgerFile, rentFile, "--date", RECONCILE_DATE];

  // -----------------------------------------------------------------------------------------------
  // STEP 1 — ISSUE: mint a TrustLedger LICENSE (the `seal` entitlement) signed by an EPHEMERAL VENDOR key.
  // -----------------------------------------------------------------------------------------------
  out("STEP 1 — issue a TrustLedger license with the `seal` entitlement (ephemeral vendor key)");
  const vendorWallet = Wallet.createRandom(); // EPHEMERAL — created, used, discarded. Never persisted.
  const vendorAddress = vendorWallet.address;
  const licenseContainer = await trustLicense.buildLicense(
    {
      licenseId: "PILOT-RECONCILE-1",
      customer: "Design Partner (pilot)",
      plan: "pro",
      entitlements: ["seal"],
      issuedAt: ISSUED,
      expiresAt: EXPIRES,
    },
    vendorWallet
  );
  const licenseFile = path.join(workspace, "trustledger.vhlicense.json");
  fs.writeFileSync(licenseFile, trustLicense.serializeSignedLicense(licenseContainer));

  // The license re-verifies OFFLINE, pinned to the vendor key, in-window at the report date, granting `seal`.
  const licVerdict = trustLicense.verifyLicense(
    trustLicense.readLicense(fs.readFileSync(licenseFile, "utf8")),
    { now: RECONCILE_DATE, vendorAddress }
  );
  check(
    checks,
    "trustledger license verifies OFFLINE, pinned to the ephemeral vendor key, in-window",
    licVerdict.valid && licVerdict.reason === null,
    `vendor ${vendorAddress.slice(0, 10)}…`
  );
  check(
    checks,
    "license carries the paid `seal` entitlement",
    trustLicense.hasEntitlement(licVerdict, "seal")
  );
  hr();

  // -----------------------------------------------------------------------------------------------
  // STEP 2 — GATE: the PAID `reconcile --seal` surface is REFUSED without a valid license.
  // -----------------------------------------------------------------------------------------------
  out("STEP 2 — the PAID `vh trust reconcile --seal` surface is refused without a valid license");

  // (a) NO license at all -> a usage refusal (exit 2), naming the paid feature, and NOTHING written.
  {
    const io = trustIo();
    const opts = trust.parseReconcileArgs([...baseArgs, "--out", reconcileDir, "--seal"]);
    const r = trust.runReconcile(opts, io);
    check(
      checks,
      "no-license `reconcile --seal` is REFUSED (usage exit), naming the paid feature",
      r.code === trust.EXIT.USAGE &&
        /PAID feature and\s+requires a license/.test(io.err()) &&
        !fs.existsSync(sealFile),
      `exit ${r.code}`
    );
  }

  // (b) A license pinned to the WRONG vendor -> the gate REFUSES (usage exit, reason wrong_issuer) and
  //     writes NO seal. (`reconcile` gates BEFORE any data/packet work, so nothing lands on disk.)
  {
    const wrongVendor = Wallet.createRandom().address; // a DIFFERENT key than the one that signed the license
    const io = trustIo();
    const opts = trust.parseReconcileArgs([
      ...baseArgs,
      "--out",
      reconcileDir,
      "--seal",
      "--license",
      licenseFile,
      "--vendor",
      wrongVendor,
    ]);
    const r = trust.runReconcile(opts, io);
    check(
      checks,
      "license pinned to the WRONG vendor is REFUSED (wrong_issuer), no seal written",
      r.code === trust.EXIT.USAGE &&
        /reason: wrong_issuer/.test(io.err()) &&
        !fs.existsSync(sealFile),
      `exit ${r.code}`
    );
  }
  hr();

  // -----------------------------------------------------------------------------------------------
  // STEP 3 — UNLOCK: the SAME paid surface SUCCEEDS with the valid license + matching vendor, emitting
  //          the audit packet + a tamper-evident reconciliation seal, with a single PASS/FAIL verdict.
  // -----------------------------------------------------------------------------------------------
  out("STEP 3 — `reconcile --seal` SUCCEEDS with the valid license; one PASS/FAIL + a sealed packet");
  let reconcilePass = false;
  {
    const io = trustIo();
    const opts = trust.parseReconcileArgs([
      ...baseArgs,
      "--out",
      reconcileDir,
      "--seal",
      "--license",
      licenseFile,
      "--vendor",
      vendorAddress,
    ]);
    const r = trust.runReconcile(opts, io);
    reconcilePass = r.code === trust.EXIT.PASS;
    check(
      checks,
      "valid-license `reconcile --seal` reconciles to a single PASS verdict (exit 0)",
      r.code === trust.EXIT.PASS && r.model && r.model.pass === true,
      `exit ${r.code}`
    );
    check(
      checks,
      "the run emitted a tamper-evident reconciliation seal",
      fs.existsSync(sealFile) && r.sealWritten === sealFile
    );
  }

  // The seal on disk is a TrustLedger reconciliation seal binding the 3 sources + every packet file +
  // the recorded verdict/role header into ONE keccak root.
  const sealObj = JSON.parse(fs.readFileSync(sealFile, "utf8"));
  check(
    checks,
    "the seal is a trustledger reconciliation seal (`trustledger.reconcile-seal`)",
    sealObj.kind === trustSeal.SEAL_KIND
  );
  check(
    checks,
    "the seal binds the 3 source inputs (bank/book/rentroll) by role",
    Array.isArray(sealObj.inputs) &&
      sealObj.inputs.length === 3 &&
      ["bank", "book", "rentroll"].every((role) => sealObj.inputs.some((i) => i.role === role))
  );
  hr();

  // -----------------------------------------------------------------------------------------------
  // STEP 4 — HAND OFF: the SAME INDEPENDENT verifier ACCEPTS the untampered seal (exit 0) by RE-DERIVING
  //          the keccak root from the bytes on disk — verifier/verify-vh.js (js-sha3, NO ethers/hardhat).
  // -----------------------------------------------------------------------------------------------
  out("STEP 4 — hand the seal to the INDEPENDENT verifier (verify-vh); it ACCEPTS by re-deriving the root");
  {
    // The sources + packet sit next to the seal, so verify-vh resolves siblings in --dir = reconcileDir.
    // The reconciliation seal is UNSIGNED, so we DON'T pass --vendor (an unsigned artifact cannot be pinned);
    // verify-vh's job here is the tamper-evidence root re-derivation, not signer recovery.
    const io = capture();
    const code = verifyVh.run(["--json", "--dir", reconcileDir, sealFile], io);
    let parsed = null;
    try {
      parsed = JSON.parse(io.out());
    } catch (_) {
      parsed = null;
    }
    check(
      checks,
      "independent verify-vh ACCEPTS the untampered reconciliation seal (exit 0)",
      code === verifyVh.EXIT.OK && parsed && parsed.verdict === "OK",
      `exit ${code}`
    );
    check(
      checks,
      "verify-vh RE-DERIVED the keccak root from the bytes you hold (root matches)",
      parsed && parsed.rootMatches === true && parsed.payloadKind === verifyVh.KINDS.TRUST_SEAL
    );
  }
  hr();

  // -----------------------------------------------------------------------------------------------
  // STEP 5 — TAMPER: mutate one sealed source file; the SAME independent verifier REJECTS it (exit 3).
  // -----------------------------------------------------------------------------------------------
  out("STEP 5 — tamper one sealed source file; the INDEPENDENT verifier REJECTS it (exit 3)");
  {
    // Rewrite a dollar figure in the bank source — exactly the silent edit the seal exists to catch.
    const before = fs.readFileSync(bankFile, "utf8");
    fs.writeFileSync(bankFile, before.replace("1500.00", "9500.00"));

    const io = capture();
    const code = verifyVh.run(["--json", "--dir", reconcileDir, sealFile], io);
    let parsed = null;
    try {
      parsed = JSON.parse(io.out());
    } catch (_) {
      parsed = null;
    }
    const changedPaths = parsed && Array.isArray(parsed.changed) ? parsed.changed.map((c) => c.relPath) : [];
    check(
      checks,
      "independent verify-vh REJECTS the tampered reconciliation seal (exit 3)",
      code === verifyVh.EXIT.REJECTED && parsed && parsed.verdict === "REJECTED",
      `exit ${code}`
    );
    check(
      checks,
      "verify-vh localizes the tamper to EXACTLY the changed source (bank.csv)",
      changedPaths.length === 1 && changedPaths[0] === RECONCILE_SOURCES.bank
    );
  }
  hr();
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

module.exports = {
  runPilot,
  runEvidencePilot,
  runReconcilePilot,
  main,
  NOW,
  ISSUED,
  EXPIRES,
  RECONCILE_DATE,
  SAMPLE_EVIDENCE,
  SAMPLE_RECONCILE,
  RECONCILE_SOURCES,
};

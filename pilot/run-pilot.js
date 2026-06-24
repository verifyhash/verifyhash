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
// temp workspace, never the committed sample under pilot/sample-evidence/ NOR a partner's supplied folder.
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

// Recursively count the regular files under a directory tree (so we can hard-error on an EMPTY partner
// folder BEFORE we seal anything — never a misleading PASS over zero files).
function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else if (entry.isFile()) n += 1;
  }
  return n;
}

// resolveEvidenceSource(opts) — decide which folder the EVIDENCE vertical seals.
//   * default (no --evidence-dir / PILOT_EVIDENCE_DIR): the committed, READ-ONLY canned sample. The run
//     is byte-for-byte identical to the historical pilot.
//   * partner override: the partner's OWN folder. We validate it up front and HARD-ERROR with a clear
//     message BEFORE any sealing if it is missing, not a directory, unreadable, or empty — so a broken
//     input can never surface as a misleading PASS.
// Returns { source, isPartner }. Throws an Error (caught by main) on an invalid partner folder.
function resolveEvidenceSource(opts) {
  const supplied =
    (opts && opts.evidenceDir != null ? opts.evidenceDir : undefined) ?? process.env.PILOT_EVIDENCE_DIR;
  if (supplied === undefined || supplied === null || supplied === "") {
    return { source: SAMPLE_EVIDENCE, isPartner: false };
  }
  const abs = path.resolve(supplied);

  let st;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    throw new PilotInputError(
      `evidence folder not found: ${abs} (set --evidence-dir / PILOT_EVIDENCE_DIR to an existing folder)`
    );
  }
  if (!st.isDirectory()) {
    throw new PilotInputError(`evidence folder is not a directory: ${abs}`);
  }
  // Readable as a directory? (a permission/unreadable folder errors HERE, before sealing).
  let count;
  try {
    count = countFiles(abs);
  } catch (e) {
    throw new PilotInputError(`evidence folder is unreadable: ${abs} (${e && e.code ? e.code : e})`);
  }
  if (count === 0) {
    throw new PilotInputError(`evidence folder is empty (no files to seal): ${abs}`);
  }
  return { source: abs, isPartner: true };
}

// A user-facing input error (bad flag / bad partner folder). Tagged so the CLI shim prints ONE clean
// line (no stack) and exits with a usage code, instead of a confusing "unexpected error" stack trace.
class PilotInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "PilotInputError";
    this.userError = true;
  }
}

// parseArgs(argv) — the kit's tiny CLI: only `--evidence-dir <path>` today (env PILOT_EVIDENCE_DIR is
// the same knob). Unknown flags are tolerated (the kit is a demo, not a general CLI) but the one knob it
// owns is parsed strictly so `--evidence-dir` with no value is a usage error, not a silent default.
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--evidence-dir") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new PilotInputError("--evidence-dir requires a <path> argument");
      }
      opts.evidenceDir = v;
      i++;
    } else if (a.startsWith("--evidence-dir=")) {
      opts.evidenceDir = a.slice("--evidence-dir=".length);
    }
  }
  return opts;
}

// ---- the pilot run -------------------------------------------------------------------------------

// runPilot(workspace, opts) — drive BOTH sellable journeys (evidence + reconcile) inside `workspace` (a
// caller-owned temp dir) and fold them into ONE combined PASS/FAIL verdict. PURE w.r.t. its inputs: it
// reads the chosen source folders READ-ONLY (copying each into `workspace`) and writes ONLY under
// `workspace`. Returns true iff EVERY check across BOTH verticals passed. Injectable so the test can run
// it against its own throwaway dir.
//
// opts.evidenceDir (or env PILOT_EVIDENCE_DIR) points the EVIDENCE vertical at a PARTNER'S OWN folder
// instead of the canned sample. The partner's originals are NEVER written — we operate on a COPY. An
// invalid (missing/empty/unreadable) partner folder HARD-ERRORS before any sealing (it never PASSes).
async function runPilot(workspace, opts) {
  // Resolve (and VALIDATE) the evidence source BEFORE we print a journey or seal anything — a broken
  // partner folder must surface as a hard error here, never as a misleading PASS later.
  const { source: evidenceSource, isPartner } = resolveEvidenceSource(opts || {});
  out("");
  out("verifyhash — OFFLINE, ephemeral-key PILOT KIT (evidence + reconcile)");
  out(
    "This kit drives BOTH real buyer journeys end to end against committed sample data, with no real key,\n" +
      "no network, and no timestamp/anchor. Each license-GATES a paid surface (refused without, unlocked\n" +
      "with) and the INDEPENDENT verify-vh accepts the emitted artifact and REJECTS a tamper. It proves\n" +
      'TAMPER-EVIDENCE + WHO vouched — NOT a trusted timestamp ("sealed at T" rides the human trust-root,\n' +
      "STRATEGY.md P-3) and NOT legal advice (a CPA still governs the reconciliation)."
  );
  if (isPartner) {
    out(
      `EVIDENCE SOURCE: your folder ${evidenceSource}\n` +
        "  The kit COPIES it into a throwaway workspace and seals/tampers ONLY the copy — your originals\n" +
        "  are READ-ONLY and are never written, renamed, or deleted."
    );
  } else {
    out(`EVIDENCE SOURCE: the canned sample ${evidenceSource} (pass --evidence-dir to run YOUR folder).`);
  }
  hr();

  // ONE shared verdict array: every check from BOTH verticals lands here, so the printed VERDICT is the
  // single AND of the whole combined journey.
  const checks = [];

  await runEvidencePilot(workspace, checks, { source: evidenceSource, isPartner });
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

// runEvidencePilot(workspace, checks, src) — drive the evidence journey, appending each check to
// `checks`. `src.source` is the folder to seal (the canned sample by default, or the partner's OWN
// folder when --evidence-dir / PILOT_EVIDENCE_DIR is set). EITHER WAY the source is read READ-ONLY and
// COPIED into `workspace`; every seal/tamper touches ONLY the copy. Writes ONLY under `workspace`.
async function runEvidencePilot(workspace, checks, src) {
  const source = (src && src.source) || SAMPLE_EVIDENCE;
  const isPartner = !!(src && src.isPartner);

  out("VERTICAL A — EVIDENCE (the signed, tamper-evident audit-evidence packet)");
  hr();

  // The working COPY of the evidence dir we will seal (and later tamper). The SOURCE — the committed
  // sample OR the partner's own folder — is untouched (we only ever read it, here, to copy it).
  const evidenceDir = path.join(workspace, "evidence");
  copyDir(source, evidenceDir);

  // -----------------------------------------------------------------------------------------------
  // STEP 1 — ISSUE: mint an evidence LICENSE signed by an EPHEMERAL VENDOR key.
  // -----------------------------------------------------------------------------------------------
  out("STEP 1 — issue an evidence license (ephemeral vendor key)");
  const vendorWallet = Wallet.createRandom(); // EPHEMERAL — created, used, discarded. Never persisted.
  const vendorAddress = vendorWallet.address;
  // Grant BOTH paid evidence entitlements on this throwaway demo license. `evidence_signed` unlocks the
  // `--sign` wrap; `evidence_unlimited` unlocks sealing MORE than the free SAMPLE_LIMIT (25) files. A real
  // PARTNER folder routinely has dozens of files, so withholding `evidence_unlimited` here would make the
  // valid-license STEP 3 seal REJECT (>25 files) and the whole kit print a FALSE "VERDICT: FAIL" — even
  // though nothing is wrong. It's an ephemeral demo license; there is no reason to withhold either grant.
  const licenseContainer = await evidence.buildLicense(
    {
      licenseId: "PILOT-EVIDENCE-1",
      customer: "Design Partner (pilot)",
      plan: "pro",
      entitlements: ["evidence_signed", "evidence_unlimited"],
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
    "license carries the paid `evidence_signed` + `evidence_unlimited` entitlements",
    evidence.hasEntitlement(licVerdict, "evidence_signed") &&
      evidence.hasEntitlement(licVerdict, "evidence_unlimited")
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
  out("STEP 5 — tamper one sealed file (in the WORKSPACE COPY only); the INDEPENDENT verifier REJECTS it (exit 3)");
  {
    // Choose the tamper target IN THE COPY. For the canned sample we keep mutating access-log.csv so the
    // default run is byte-for-byte historical; for a partner folder (which has unknown filenames) we pick
    // the FIRST sealed file deterministically (loadDirEntries returns a sorted [{relPath,bytes}] list — the
    // exact enumeration the seal commits to), so the localization assertion is exact on ANY folder. EITHER
    // target lives under evidenceDir (the workspace copy) — never the partner's original.
    const tamperRel = isPartner ? evidence.loadDirEntries(evidenceDir)[0].relPath : "access-log.csv";
    const tamperTarget = path.join(evidenceDir, tamperRel);
    const before = fs.readFileSync(tamperTarget);
    // The appended bytes are arbitrary — any change must REJECT. The default sample keeps its historical
    // marker line (byte-for-byte the canned run); a partner file gets a neutral, format-agnostic marker.
    const marker = isPartner
      ? Buffer.from("\n# pilot tamper marker\n")
      : Buffer.from("2026-05-12T11:00:00Z,attacker,delete,access-log,ok\n");
    fs.writeFileSync(tamperTarget, Buffer.concat([before, marker]));

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
      `verify-vh localizes the tamper to EXACTLY the changed file (${tamperRel})`,
      changedPaths.length === 1 && changedPaths[0] === tamperRel
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

async function main(argv) {
  // Parse the kit's one CLI knob (--evidence-dir) BEFORE touching the filesystem so a bad flag is a clean
  // usage error, not a half-created workspace. PILOT_EVIDENCE_DIR is read inside resolveEvidenceSource.
  const opts = parseArgs(Array.isArray(argv) ? argv : process.argv.slice(2));

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
    ok = await runPilot(workspace, opts);
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
      if (e && e.userError) {
        // A bad flag or an invalid partner folder: ONE clean line, no stack, usage exit (2) — and
        // crucially BEFORE any sealing, so a broken input never reads as a PASS.
        process.stderr.write(`pilot: ${e.message}\n`);
        process.exit(2);
      }
      process.stderr.write(`pilot: unexpected error: ${e && e.stack ? e.stack : e}\n`);
      process.exit(1);
    });
}

module.exports = {
  runPilot,
  runEvidencePilot,
  runReconcilePilot,
  main,
  parseArgs,
  resolveEvidenceSource,
  copyDir,
  countFiles,
  PilotInputError,
  NOW,
  ISSUED,
  EXPIRES,
  RECONCILE_DATE,
  SAMPLE_EVIDENCE,
  SAMPLE_RECONCILE,
  RECONCILE_SOURCES,
};

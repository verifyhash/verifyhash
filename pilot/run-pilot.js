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

// parseArgs(argv) — the kit's tiny CLI. Knobs it OWNS (each parsed strictly: a flag with no/`--`-prefixed
// value is a usage error, never a silent default):
//   --evidence-dir <path>     point the EVIDENCE vertical at YOUR folder (env PILOT_EVIDENCE_DIR is the same knob)
//   --certificate <path>      SEAL the pilot result into a tamper-evident, independently-verifiable
//                             `*.vhevidence.json` packet at <path> (T-53.2). With NO --certificate the run is
//                             byte-for-byte the historical pilot (no file written, same stdout, same exit code).
//   --sign                    (only with --certificate) WRAP the certificate in a signed attestation, vouched
//                             for by an EPHEMERAL operator key (Wallet.createRandom()) — never a real key.
//   --vendor <0xaddr>         (only with --certificate --sign) ASSERT the address that must vouch — the kit
//                             signs with the OPERATOR key (--key-env/--key-file, or the ephemeral key it
//                             mints) and ENFORCES that --vendor EQUALS that signer, failing loud on a
//                             mismatch (it never silently re-pins to a different identity). An independent
//                             `verify-vh --vendor` / `vh evidence verify-signed --signer` then confirms WHO
//                             vouched. If omitted on a --sign run, the kit pins the operator key it signed
//                             with (a self-attested certificate).
//   --key-env <NAME>          (only with --certificate --sign) read the operator signing key from this env var
//   --key-file <path>         (only with --certificate --sign) read the operator signing key from this file
// Unknown OTHER flags are tolerated (the kit is a demo, not a general CLI). --sign/--vendor/--key-* are
// inert without --certificate (the certificate is the only thing they configure), so a stray --sign on a
// plain run is a no-op, never a crash — preserving the byte-for-byte default contract.
function parseArgs(argv) {
  const opts = {};
  const needValue = (i, flag, noun) => {
    const v = argv[i + 1];
    if (v === undefined || (typeof v === "string" && v.startsWith("--"))) {
      throw new PilotInputError(`${flag} requires a ${noun || "<value>"} argument`);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--evidence-dir") {
      opts.evidenceDir = needValue(i, "--evidence-dir", "<path>");
      i++;
    } else if (a.startsWith("--evidence-dir=")) {
      opts.evidenceDir = a.slice("--evidence-dir=".length);
    } else if (a === "--certificate") {
      opts.certificate = needValue(i, "--certificate", "<path>");
      i++;
    } else if (a.startsWith("--certificate=")) {
      opts.certificate = a.slice("--certificate=".length);
    } else if (a === "--sign") {
      opts.sign = true;
    } else if (a === "--vendor") {
      opts.vendor = needValue(i, "--vendor");
      i++;
    } else if (a.startsWith("--vendor=")) {
      opts.vendor = a.slice("--vendor=".length);
    } else if (a === "--key-env") {
      opts.keyEnv = needValue(i, "--key-env");
      i++;
    } else if (a.startsWith("--key-env=")) {
      opts.keyEnv = a.slice("--key-env=".length);
    } else if (a === "--key-file") {
      opts.keyFile = needValue(i, "--key-file");
      i++;
    } else if (a.startsWith("--key-file=")) {
      opts.keyFile = a.slice("--key-file=".length);
    }
  }
  return opts;
}

// ---- the canonical, deterministic PILOT-RESULT record --------------------------------------------

// The schema tag + version stamped onto every record runPilot returns. A consumer (a CI gate, a JSON
// sink, a future signed-result wrapper) keys off `schema` to know what it holds; `schemaVersion` lets
// the shape evolve without silently misreading an old record.
const PILOT_RESULT_SCHEMA = "vh-pilot-result";
const PILOT_RESULT_SCHEMA_VERSION = 1;

// tallyChecks(checks) — the SINGLE place the combined verdict is derived. `passed`/`total`/`verdict`/`ok`
// are ALL computed here from the checks array — never tracked in a parallel variable that could drift —
// so a forced failing check provably flips `verdict` to FAIL (passed < total ⇒ not allOk ⇒ "FAIL").
function tallyChecks(checks) {
  const total = checks.length;
  const passed = checks.reduce((n, c) => n + (c.ok ? 1 : 0), 0);
  const ok = total > 0 && passed === total;
  return { passed, total, ok, verdict: ok ? "PASS" : "FAIL" };
}

// buildPilotResult(checks, meta) — fold the recorded checks into the canonical `vh-pilot-result` record.
// DETERMINISM CONTRACT: every field is a pure function of `checks` (which carry ONLY {ok, label} — no
// addresses, exit codes, timings, or temp paths) plus `meta.evidenceSource`, a NORMALIZED category
// ("canned" | "partner"), never an absolute/temp path. So two runs over identical inputs yield a
// byte-identical record (after path normalization, which here means: there is no path to normalize away
// in the first place). The record OMITS the random ephemeral keys, the per-step exit codes, and any
// clock value — none of that belongs in a reproducible verdict.
function buildPilotResult(checks, meta) {
  const tally = tallyChecks(checks);
  return {
    schema: PILOT_RESULT_SCHEMA,
    schemaVersion: PILOT_RESULT_SCHEMA_VERSION,
    // The combined verdict + counts, all derived from checks[] (single source of truth).
    verdict: tally.verdict,
    passed: tally.passed,
    total: tally.total,
    ok: tally.ok,
    // Which source the evidence vertical sealed, as a NORMALIZED category — NOT the absolute folder
    // (a partner/temp path would make the record non-reproducible across machines/runs).
    evidenceSource: meta && meta.isPartner ? "partner" : "canned",
    // The canonical, ordered check list. We re-shape each entry to EXACTLY {ok, label} so no incidental
    // field (added later to the in-memory check) can leak nondeterminism into the record.
    checks: checks.map((c) => ({ ok: !!c.ok, label: String(c.label) })),
  };
}

// ---- T-53.2: the SHAREABLE pilot-result CERTIFICATE ----------------------------------------------

// The basename the result record is sealed under, INSIDE the certificate. The independent verifier
// resolves this sibling next to the packet (via its --dir) and RE-DERIVES the keccak root from these exact
// bytes — so this name is part of the certificate's verifiable surface and must stay stable.
const CERTIFICATE_RESULT_NAME = "pilot-result.json";

// serializeResultForCertificate(result) — the EXACT bytes the certificate seals over. Pretty-printed +
// newline-terminated so the sealed artifact is human-eyeballable (a procurement reviewer can open it), and
// DETERMINISTIC because `result` is the canonical, path/clock/key-free record buildPilotResult returns.
function serializeResultForCertificate(result) {
  return JSON.stringify(result, null, 2) + "\n";
}

// writeCertificate(result, certPath, opts, io) — SEAL the pilot result into a tamper-evident,
// independently-verifiable `*.vhevidence.json` packet at `certPath`, by DOGFOODING the SHIPPED
// `cli/evidence.js` seal core (NO new crypto / seal / verify logic). The flow:
//   1. write the canonical result record as a single file (pilot-result.json) into a throwaway seal dir;
//   2. run the REAL `evidence.runEvidenceSeal` over that dir — producing the exact same packet shape the
//      paid `vh evidence seal` ships, which the INDEPENDENT verify-vh ACCEPTS (root re-derived from the
//      result bytes) and REJECTS on a one-byte tamper, localized to pilot-result.json;
//   3. emit the seal-dir COPY of the result file next to the certificate (as `<cert>.result.json`) so a
//      counterparty who only receives the certificate can re-derive the root from the bytes it commits to.
//
// The OPTIONAL --sign path wraps the seal in a signed attestation vouched-for by an EPHEMERAL operator key
// (Wallet.createRandom()) — NEVER a real key. Because runEvidenceSeal GATES --sign behind a paid license,
// we mint a throwaway vendor license granting `evidence_signed` and pin it, EXACTLY as the pilot's own
// evidence vertical does — all keys are created, used, and discarded in-process.
//
// Returns { path, signed, signer, vendor, root, fileCount } describing the written certificate. Throws a
// PilotInputError on a usage problem (bad --vendor, unwritable path) so the CLI shim prints one clean line.
//
// `io.evidence`/`io.now` are injectable so a test can drive the SAME path with a fixed clock; production
// passes neither (uses the real module + real clock — but the certificate bytes do NOT depend on the clock:
// the UNSIGNED seal is a pure function of the result bytes, and a signature is over those same bytes).
async function writeCertificate(result, certPath, opts, io) {
  io = io || {};
  const ev = io.evidence || evidence;
  const now = io.now || new Date();
  opts = opts || {};

  const certAbs = path.resolve(certPath);
  const certDirAbs = path.dirname(certAbs) || os.tmpdir();

  // The throwaway license file (used ONLY to satisfy the --sign gate). Declared out here so the `finally`
  // can always remove it, even if sealing throws. It is written OUTSIDE sealDir (never sealed content).
  let licenseFile = null;

  // A throwaway dir holding ONLY the result record, which we seal. Lives next to the certificate target so
  // we never touch cwd/the repo; removed in `finally`. (We deliberately DO NOT reuse the pilot's evidence
  // workspace — the certificate seals the RESULT record, not the partner's audit files.)
  const sealDir = fs.mkdtempSync(path.join(certDirAbs, ".vh-pilot-cert-"));
  try {
    const resultBytes = serializeResultForCertificate(result);
    fs.writeFileSync(path.join(sealDir, CERTIFICATE_RESULT_NAME), resultBytes);

    // Capture the seal command's stdout/stderr so the certificate write is SILENT on the pilot transcript
    // (the run's own verdict line is the only thing that prints by default; the cert is an extra artifact).
    const capErr = [];
    const sealIo = {
      write: () => {},
      writeErr: (s) => capErr.push(s),
      now,
    };

    // Build the seal opts. --sign mints an EPHEMERAL operator key + a throwaway vendor license granting
    // `evidence_signed`, then pins it — mirroring runEvidencePilot STEP 3 (the shipped paid surface).
    const sealOpts = {
      dir: sealDir,
      out: certAbs,
      sign: !!opts.sign,
    };

    let restoreKeyEnv = null;
    try {
      if (opts.sign) {
        // VALIDATE --vendor SHAPE up front (when given) so a malformed pin is a clean usage error, never a
        // runtime throw mid-seal. --vendor is the SIGNER address the caller EXPECTS to vouch — it is what
        // the recipient pins with `verify-vh --vendor` / `vh evidence verify-signed --signer`. It does NOT
        // configure the license gate (the license is an internal throwaway artifact, below). The ACTUAL pin
        // is the OPERATOR key recovered after sealing; once we know that address we ENFORCE that --vendor
        // (if supplied) EQUALS it — never silently re-pin to a different identity (see the mismatch guard
        // after the packet is read back, below).
        if (opts.vendor != null) {
          const { isAddress } = require("ethers");
          if (!isAddress(opts.vendor)) {
            throw new PilotInputError(
              `--vendor must be a 20-byte 0x-hex address, got: ${opts.vendor}`
            );
          }
        }

        // The OPERATOR signing key: a HUMAN-supplied key (--key-env / --key-file) when given, else an
        // EPHEMERAL operator key the kit mints, uses in-process, and discards. The loop itself NEVER holds
        // a real key; when the caller supplies a key it is read, used, and discarded inside the seal core.
        let keyEnv = opts.keyEnv;
        let keyFile = opts.keyFile;
        if (keyEnv == null && keyFile == null) {
          const operatorWallet = Wallet.createRandom();
          keyEnv = "PILOT_CERT_OP_KEY";
          // Stash the key in a PROCESS-SCOPED env var the seal reads, restored on the way out so we never
          // leave key material behind in the environment.
          const PREV = process.env[keyEnv];
          process.env[keyEnv] = operatorWallet.privateKey;
          restoreKeyEnv = () => {
            if (PREV === undefined) delete process.env[keyEnv];
            else process.env[keyEnv] = PREV;
          };
        }
        sealOpts.keyEnv = keyEnv;
        sealOpts.keyFile = keyFile;

        // --sign is license-GATED on `evidence_signed`. Mint a THROWAWAY vendor license (a fresh ephemeral
        // vendor wallet that signs it, pinned to its OWN address) granting the paid entitlements, purely to
        // satisfy the gate with ephemeral material — no real key, no foreign key. This license is a gate
        // formality; the certificate's vouching identity is the OPERATOR key recovered on verify, which the
        // recipient pins via --vendor.
        const vendorWallet = Wallet.createRandom();
        const licenseContainer = await ev.buildLicense(
          {
            licenseId: "PILOT-CERT-1",
            customer: "Pilot certificate (ephemeral)",
            plan: "pro",
            entitlements: ["evidence_signed", "evidence_unlimited"],
            issuedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
          vendorWallet
        );
        // CRITICAL: write the license OUTSIDE sealDir (it is a gate formality, NOT sealed content). The
        // seal must commit to EXACTLY the result record — a stray file in sealDir would land in the seal
        // and make the independent verifier report it MISSING next to the certificate.
        licenseFile = path.join(certDirAbs, `.vh-pilot-cert-license-${process.pid}-${Date.now()}.json`);
        fs.writeFileSync(licenseFile, JSON.stringify(licenseContainer) + "\n");
        sealOpts.license = licenseFile;
        sealOpts.vendor = vendorWallet.address;
      }

      const code = await ev.runEvidenceSeal(sealOpts, sealIo);
      if (code !== ev.EXIT.OK) {
        throw new PilotInputError(
          `failed to seal the pilot certificate (evidence seal exit ${code})` +
            (capErr.length ? `: ${capErr.join("").trim()}` : "")
        );
      }
    } finally {
      if (restoreKeyEnv) restoreKeyEnv();
    }

    // The packet on disk is the certificate. Read it back to surface its kind/root/signer for the caller.
    // A SIGNED packet WRAPS the seal under `attestation` (root/fileCount live there) and carries the
    // recovered signer in `signature.signer`; an UNSIGNED packet is the bare seal (root/fileCount at top).
    const packet = JSON.parse(fs.readFileSync(certAbs, "utf8"));
    const signed = packet.kind === ev.SIGNED_SEAL_KIND;
    const inner = signed ? packet.attestation || {} : packet;
    const signer =
      signed && packet.signature && typeof packet.signature.signer === "string"
        ? packet.signature.signer
        : null;

    // ENFORCE the --vendor PIN: the certificate's vouching identity is the OPERATOR key recovered above
    // (`signer`). If the caller PINNED a specific `--vendor`, it MUST equal that recovered signer — the kit
    // signs with the operator key, so a `--vendor` that names a DIFFERENT address can NEVER be honored. We
    // FAIL LOUD rather than silently re-pin to the operator: a user who supplies a real corporate key plus a
    // deliberate `--vendor` must not walk away with a certificate vouching for a DIFFERENT identity. The
    // certificate-on-disk is removed first so a mismatch never leaves a half-written packet that vouches for
    // the wrong identity. (Address compare is case-insensitive: --vendor may be any 0x-hex casing.)
    if (signed && opts.vendor != null && signer != null) {
      if (String(opts.vendor).toLowerCase() !== String(signer).toLowerCase()) {
        fs.rmSync(certAbs, { force: true });
        throw new PilotInputError(
          `--vendor pin mismatch: you asked to pin ${opts.vendor} as the certificate's signer, ` +
            `but the signing key vouches as ${signer}. The kit signs with the OPERATOR key ` +
            `(--key-env/--key-file, or the ephemeral key it minted); --vendor must EQUAL that signer. ` +
            `Supply the key whose address is ${opts.vendor}, or drop --vendor to pin ${signer}.`
        );
      }
    }

    // Emit the sealed result bytes into a DEDICATED sibling directory (`<certBase>.files/`) holding ONLY
    // the sealed file under the EXACT relPath the certificate commits to (CERTIFICATE_RESULT_NAME). A
    // counterparty who receives the certificate + this directory re-derives the keccak root with
    //   verify-vh --dir <certBase>.files <certificate>
    // and (for a signed certificate) `vh evidence verify-signed --dir <certBase>.files` — because the
    // directory contains EXACTLY the sealed file, the signed-attestation's OPTIONAL dir-binding (which
    // re-seals the whole directory) matches too. Putting it in its OWN dir (not loose beside the cert)
    // keeps that re-seal exact even when several certificates share one folder.
    const filesDir = certAbs.replace(/\.vhevidence\.json$/i, "") + ".files";
    fs.mkdirSync(filesDir, { recursive: true });
    const siblingResult = path.join(filesDir, CERTIFICATE_RESULT_NAME);
    fs.copyFileSync(path.join(sealDir, CERTIFICATE_RESULT_NAME), siblingResult);

    return {
      path: certAbs,
      filesDir,
      siblingResult,
      resultName: CERTIFICATE_RESULT_NAME,
      signed,
      signer,
      root: inner.root,
      fileCount: inner.fileCount,
    };
  } finally {
    fs.rmSync(sealDir, { recursive: true, force: true });
    if (licenseFile) fs.rmSync(licenseFile, { force: true });
  }
}

// ---- the pilot run -------------------------------------------------------------------------------

// runPilot(workspace, opts) — drive BOTH sellable journeys (evidence + reconcile) inside `workspace` (a
// caller-owned temp dir) and fold them into ONE combined PASS/FAIL verdict. PURE w.r.t. its inputs: it
// reads the chosen source folders READ-ONLY (copying each into `workspace`) and writes ONLY under
// `workspace`. RETURNS a canonical, deterministic `vh-pilot-result` record (see buildPilotResult) whose
// `verdict`/`passed`/`total`/`ok` are DERIVED from the checks across BOTH verticals — `result.ok` is true
// iff every check passed. Injectable so the test can run it against its own throwaway dir.
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

  // Derive the verdict + counts ONCE from the checks (the single source of truth) and print the SAME
  // numbers the returned record carries — the printed line is byte-for-byte the historical baseline.
  const result = buildPilotResult(checks, { isPartner });
  out(
    `VERDICT: ${result.verdict} — ${result.passed}/${result.total} checks passed (evidence + reconcile).`
  );
  out("");
  return result;
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

  let result = null;
  try {
    result = await runPilot(workspace, opts);
  } finally {
    if (ownTemp && !keep) {
      fs.rmSync(workspace, { recursive: true, force: true });
    } else if (keep) {
      out(`(PILOT_KEEP=1) workspace kept at: ${workspace}`);
    }
  }

  // T-53.2 — OPTIONAL: seal the pilot result into a SHAREABLE, tamper-evident certificate. This runs ONLY
  // under --certificate; with NO flag NOTHING here executes, so the run's stdout + exit code stay BYTE-FOR-
  // BYTE the historical baseline. The seal/note print AFTER the verdict line (an extra trailing artifact),
  // never inside the regression-pinned transcript. A seal failure is surfaced as a clean usage line by the
  // CLI shim (the certificate is additive; it does not change the pilot's own PASS/FAIL exit code).
  if (opts.certificate && result) {
    const cert = await writeCertificate(result, opts.certificate, opts);
    out("");
    out(
      `PILOT CERTIFICATE — a tamper-evident, independently-verifiable record of THIS run, written to:\n` +
        `  ${cert.path}\n` +
        `  ${cert.filesDir}/   (the sealed result bytes; ships ALONGSIDE the certificate)\n` +
        `Verify it with the INDEPENDENT verifier (js-sha3 only, no producer stack):\n` +
        `  node verifier/verify-vh.js --dir "${cert.filesDir}"` +
        (cert.signed ? ` --vendor ${cert.signer}` : "") +
        ` "${cert.path}"\n` +
        (cert.signed
          ? `It is a SIGNED certificate; the recovered signer is ${cert.signer} (an EPHEMERAL key — the\n` +
            `  loop holds no real key). It proves TAMPER-EVIDENCE + WHO vouched, NOT a trusted timestamp (P-3).`
          : `It is an UNSIGNED certificate; it proves TAMPER-EVIDENCE (the bytes), NOT who vouched or when (P-3).`)
    );
  }

  // runPilot now returns the canonical record; the exit code is driven by its derived `ok` — exit 0 iff
  // EVERY check passed, exit 1 otherwise. Byte-for-byte the historical exit-code contract.
  return result && result.ok ? 0 : 1;
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
  tallyChecks,
  buildPilotResult,
  writeCertificate,
  serializeResultForCertificate,
  CERTIFICATE_RESULT_NAME,
  PilotInputError,
  PILOT_RESULT_SCHEMA,
  PILOT_RESULT_SCHEMA_VERSION,
  NOW,
  ISSUED,
  EXPIRES,
  RECONCILE_DATE,
  SAMPLE_EVIDENCE,
  SAMPLE_RECONCILE,
  RECONCILE_SOURCES,
};

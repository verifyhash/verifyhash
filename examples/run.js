#!/usr/bin/env node
"use strict";

// =================================================================================================
// verifyhash — runnable, self-checking, OFFLINE end-to-end EXAMPLE (T-21.2)
//
// WHAT THIS IS
//   A single script a buyer/evaluator (and CI) can run with ZERO setup — no key, no TSA, no RPC, no
//   network — to watch the real DataLedger + ProofParcel buyer pipeline work against the committed
//   sample data in examples/. It reuses the EXACT module entrypoints the `vh` CLI dispatches to
//   (cli/dataset.js, cli/parcel.js) — it is NOT a brittle shell pipeline of string parsing.
//
//   DataLedger : dataset build -> check --policy (PASS + FAIL) -> verify (MATCH + TAMPER) -> report -> attest
//   ProofParcel: parcel  build -> verify (MATCH + TAMPER) -> attest
//
// FILESYSTEM HYGIENE (load-bearing)
//   The committed sample data under examples/ is READ-ONLY here. Everything this script produces —
//   manifests, the report, the unsigned attestation bytes, and the working copies it deliberately
//   tampers — is written to a fresh OS temp workspace (or VH_EXAMPLE_OUT if you set it). NOTHING is
//   ever scattered into the repo working tree. Set VH_EXAMPLE_KEEP=1 to keep the temp dir for inspection.
//
// TRUST POSTURE (read this; the script will not let you forget it)
//   This example demonstrates TAMPER-EVIDENCE (any edit/rename/add/remove flips the Merkle root) and
//   emits the canonical UNSIGNED attestation bytes a human trust-root would sign. It does NOT, and
//   cannot, prove "unaltered since date T": that standing claim rides the HUMAN-OWNED signing/timestamp/
//   anchor trust-root (needs-human, P-3 in STRATEGY.md). This script references — but never executes —
//   those `sign` / `timestamp` / anchor steps, and says exactly where the human handoff is.
// =================================================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");

const dataset = require("../cli/dataset");
const parcel = require("../cli/parcel");

const EX_DIR = __dirname;
const SAMPLE_DATASET = path.join(EX_DIR, "sample-dataset");
const SAMPLE_DATASET_HINTS = path.join(EX_DIR, "sample-dataset.hints.json");
const POLICY_LENIENT = path.join(EX_DIR, "policy.lenient.json");
const POLICY_STRICT = path.join(EX_DIR, "policy.strict.json");
const SAMPLE_PARCEL = path.join(EX_DIR, "sample-parcel");

// ---- tiny output + check helpers -----------------------------------------------------------------

const out = (s) => process.stdout.write(s + "\n");
const hr = () => out("-".repeat(88));

const checks = []; // { ok, label } — the script's verdict is the AND of every one of these.
function check(label, ok, detail) {
  checks.push({ ok: !!ok, label });
  out(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? "  — " + detail : ""}`);
}

// Recursively copy a directory tree (the sample is tiny). Used so the TAMPER step mutates a working
// COPY in the temp workspace, never the committed sample under examples/.
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// A stdout sink that swallows the command's own human output — the example prints its OWN narration so
// the PASS/FAIL summary stays readable. (The commands still run for real; we just don't echo their block.)
const quiet = () => {};

// =================================================================================================

function main() {
  // LEAD with the standing trust note so the example can never overclaim.
  hr();
  out("verifyhash — OFFLINE end-to-end example (DataLedger + ProofParcel)");
  hr();
  out("TRUST NOTE (DataLedger): " + dataset.TRUST_NOTE);
  out("TRUST NOTE (ProofParcel): " + parcel.TRUST_NOTE);
  out("");
  out("This example proves TAMPER-EVIDENCE and emits the canonical UNSIGNED attestation bytes.");
  out('It does NOT prove "unaltered since date T" — that rides the HUMAN-OWNED signing/timestamp/');
  out("anchor trust-root (needs-human, P-3). Those steps are referenced below but NEVER executed.");
  hr();

  // Fresh, isolated output workspace. Default: an OS temp dir; override via VH_EXAMPLE_OUT.
  const work =
    process.env.VH_EXAMPLE_OUT && process.env.VH_EXAMPLE_OUT.trim()
      ? path.resolve(process.env.VH_EXAMPLE_OUT.trim())
      : fs.mkdtempSync(path.join(os.tmpdir(), "vh-example-"));
  fs.mkdirSync(work, { recursive: true });
  out(`output workspace (gitignored / OS temp — never the repo): ${work}`);
  out("");

  const artifacts = {};

  // ===============================================================================================
  // PART 1 — DataLedger: the AI training-data provenance pipeline.
  // ===============================================================================================
  out("== DataLedger ==");

  const dsManifest = path.join(work, "dataset.manifest.json");
  const hints = JSON.parse(fs.readFileSync(SAMPLE_DATASET_HINTS, "utf8"));

  // build — tamper-evident manifest (Merkle root + per-file leaves) with the UNTRUSTED hints attached.
  const dsBuild = dataset.runDatasetBuild({
    dir: SAMPLE_DATASET,
    out: dsManifest,
    hints,
    stdout: quiet,
  });
  artifacts.datasetManifest = dsManifest;
  check(
    "dataset build produced a manifest with a Merkle root over every file",
    /^0x[0-9a-fA-F]{64}$/.test(dsBuild.root) && dsBuild.fileCount === 5,
    `root=${dsBuild.root.slice(0, 14)}… files=${dsBuild.fileCount}`
  );

  // check --policy (LENIENT) — the org-policy gate should PASS (CI exit 0).
  const lenient = dataset.runDatasetCheck({
    manifest: dsManifest,
    policy: POLICY_LENIENT,
    stdout: quiet,
  });
  check(
    "dataset check --policy (lenient) PASSes  → CLI exit 0",
    lenient.verdict === "PASS",
    `verdict=${lenient.verdict}`
  );

  // check --policy (STRICT) — the DELIBERATE violations in the sample (a GPL-3.0 file + a file with no
  // license hint under requireLicense) must be FLAGGED (CI exit 3). This is the core "the gate works" proof.
  const strict = dataset.runDatasetCheck({
    manifest: dsManifest,
    policy: POLICY_STRICT,
    stdout: quiet,
  });
  const flaggedGpl = strict.violations.some(
    (v) => v.rule === "denyLicenses" && v.value === "GPL-3.0"
  );
  const flaggedMissing = strict.violations.some((v) => v.rule === "requireLicense");
  check(
    "dataset check --policy (strict) FLAGS the deliberate violations → CLI exit 3",
    strict.verdict === "FAIL" && flaggedGpl && flaggedMissing,
    `verdict=${strict.verdict} violations=${strict.violations.length} (GPL-3.0 + missing-license)`
  );

  // verify (MATCH) — re-derive the root from the UNTOUCHED committed sample; must MATCH (CI exit 0).
  const dsVerifyOk = dataset.runDatasetVerify({
    dir: SAMPLE_DATASET,
    manifest: dsManifest,
    stdout: quiet,
  });
  check(
    "dataset verify against the untouched sample → MATCH (CLI exit 0)",
    dsVerifyOk.status === "MATCH",
    `status=${dsVerifyOk.status}`
  );

  // verify (TAMPER) — copy the sample, mutate ONE file, and confirm verify catches it as MISMATCH and
  // localizes the CHANGED file. The mutation happens on the temp COPY, never the committed sample.
  const dsTamperDir = path.join(work, "tampered-dataset");
  copyDir(SAMPLE_DATASET, dsTamperDir);
  const tamperedFile = path.join(dsTamperDir, "corpus", "mit-notes.txt");
  fs.appendFileSync(tamperedFile, "\nTAMPER: one extra byte changes the file's bytes.\n");
  const dsVerifyTamper = dataset.runDatasetVerify({
    dir: dsTamperDir,
    manifest: dsManifest,
    stdout: quiet,
  });
  const caughtChanged = dsVerifyTamper.diff.changed.some(
    (c) => c.path === "corpus/mit-notes.txt"
  );
  check(
    "dataset verify catches a one-byte TAMPER → MISMATCH, localized to the CHANGED file (CLI exit 3)",
    dsVerifyTamper.status === "MISMATCH" && caughtChanged,
    `status=${dsVerifyTamper.status} changed=[${dsVerifyTamper.diff.changed
      .map((c) => c.path)
      .join(", ")}]`
  );

  // report — ONE filed evidence document (identity + license roll-up + embedded verify + policy verdict).
  // Run with BOTH gates against the strict policy: the report is the combined CI gate and reports FAIL.
  const dsReport = path.join(work, "dataset.evidence.md");
  const reportRes = dataset.runDatasetReport({
    manifest: dsManifest,
    verifyDir: SAMPLE_DATASET,
    policy: POLICY_STRICT,
    out: dsReport,
    stdout: quiet,
  });
  artifacts.datasetReport = dsReport;
  check(
    "dataset report wrote ONE evidence document (verify=MATCH embedded, policy=FAIL embedded)",
    fs.existsSync(dsReport) &&
      reportRes.verifyStatus === "MATCH" &&
      reportRes.policyVerdict === "FAIL",
    `verify=${reportRes.verifyStatus} policy=${reportRes.policyVerdict}`
  );

  // attest — emit the canonical UNSIGNED attestation bytes the human trust-root would sign.
  const dsAttest = path.join(work, "dataset.attestation.json");
  const attestRes = dataset.runDatasetAttest({
    manifest: dsManifest,
    out: dsAttest,
    stdout: quiet,
  });
  artifacts.datasetAttestation = dsAttest;
  check(
    "dataset attest emitted canonical UNSIGNED bytes (signed:false) for the human trust-root to sign",
    fs.existsSync(dsAttest) &&
      attestRes.envelope.signed === false &&
      typeof attestRes.canonical === "string" &&
      attestRes.canonical.length > 0,
    `signed=${attestRes.envelope.signed}`
  );

  out("");

  // ===============================================================================================
  // PART 2 — ProofParcel: the B2B data-delivery receipt pipeline.
  // ===============================================================================================
  out("== ProofParcel ==");

  const pManifest = path.join(work, "parcel.manifest.json");

  // build — tamper-evident delivery receipt (root + per-file leaves + UNTRUSTED parcel metadata).
  const pBuild = parcel.runParcelBuild({
    dir: SAMPLE_PARCEL,
    out: pManifest,
    parcel: {
      parcelId: "EX-0001",
      sender: "acme-data-co",
      recipient: "globex-ml",
    },
    stdout: quiet,
  });
  artifacts.parcelManifest = pManifest;
  check(
    "parcel build produced a delivery receipt with a Merkle root over every delivered file",
    /^0x[0-9a-fA-F]{64}$/.test(pBuild.root) && pBuild.fileCount === 3,
    `root=${pBuild.root.slice(0, 14)}… files=${pBuild.fileCount}`
  );

  // verify (MATCH) — the recipient re-derives the root from the delivered bytes; must MATCH (CI exit 0).
  const pVerifyOk = parcel.runParcelVerify({
    dir: SAMPLE_PARCEL,
    manifest: pManifest,
    stdout: quiet,
  });
  check(
    "parcel verify against the delivered files → MATCH (CLI exit 0)",
    pVerifyOk.status === "MATCH",
    `status=${pVerifyOk.status}`
  );

  // verify (TAMPER) — mutate ONE delivered file on a temp copy; verify must catch it as MISMATCH.
  const pTamperDir = path.join(work, "tampered-parcel");
  copyDir(SAMPLE_PARCEL, pTamperDir);
  fs.appendFileSync(path.join(pTamperDir, "data", "records.csv"), "4,delta,400\n");
  const pVerifyTamper = parcel.runParcelVerify({
    dir: pTamperDir,
    manifest: pManifest,
    stdout: quiet,
  });
  const pCaughtChanged = pVerifyTamper.diff.changed.some((c) => c.path === "data/records.csv");
  check(
    "parcel verify catches a TAMPER → MISMATCH, localized to the CHANGED file (CLI exit 3)",
    pVerifyTamper.status === "MISMATCH" && pCaughtChanged,
    `status=${pVerifyTamper.status} changed=[${pVerifyTamper.diff.changed
      .map((c) => c.path)
      .join(", ")}]`
  );

  // attest — emit the canonical UNSIGNED parcel-attestation bytes the human trust-root would sign.
  const pAttest = path.join(work, "parcel.attestation.json");
  const pAttestRes = parcel.runParcelAttest({
    manifest: pManifest,
    out: pAttest,
    stdout: quiet,
  });
  artifacts.parcelAttestation = pAttest;
  check(
    "parcel attest emitted canonical UNSIGNED bytes (signed:false) for the human trust-root to sign",
    fs.existsSync(pAttest) &&
      pAttestRes.envelope.signed === false &&
      typeof pAttestRes.canonical === "string" &&
      pAttestRes.canonical.length > 0,
    `signed=${pAttestRes.envelope.signed}`
  );

  // ===============================================================================================
  // Summary + the human-gated trust-root handoff (referenced, NOT executed).
  // ===============================================================================================
  out("");
  hr();
  out("Produced artifacts (all under the temp workspace — none in the repo):");
  for (const [k, v] of Object.entries(artifacts)) out(`  ${k}: ${v}`);
  out("");
  out("NEXT — the HUMAN-OWNED trust-root steps (NOT run here; they need a key / a TSA / an RPC):");
  out(
    "  vh dataset sign " +
      dsAttest +
      " --key-file <YOUR-KEY>        # sign the UNSIGNED bytes with a key YOU provisioned"
  );
  out(
    "  vh dataset timestamp-request " +
      dsManifest +
      "                  # then stamp the digest at an RFC-3161 TSA"
  );
  out(
    "  vh parcel  sign " +
      pAttest +
      " --key-file <YOUR-KEY>         # same handoff for the parcel attestation"
  );
  out(
    "  (on-chain anchor is a deploy + real funds — also needs-human, P-2 in STRATEGY.md)"
  );
  out(
    '  These convert "the bytes are these" into "signed/stamped by a trusted party at time T". The'
  );
  out("  example deliberately stops at the unsigned bytes — that boundary is the product's honesty line.");
  hr();

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    out(`RESULT: PASS — all ${checks.length} pipeline checks passed.`);
  } else {
    out(`RESULT: FAIL — ${failed.length} of ${checks.length} checks failed:`);
    for (const c of failed) out(`  - ${c.label}`);
  }

  return {
    code: failed.length === 0 ? 0 : 1,
    work,
    artifacts,
    checks: checks.slice(),
    // A temp workspace is OURS to delete on success; a caller-chosen VH_EXAMPLE_OUT is theirs to keep.
    ownsWorkspace: !(process.env.VH_EXAMPLE_OUT && process.env.VH_EXAMPLE_OUT.trim()),
  };
}

// Run, then clean up the temp workspace (unless the caller asked to keep it or chose their own --out).
if (require.main === module) {
  let result;
  try {
    result = main();
  } catch (e) {
    process.stderr.write("example crashed: " + (e && e.stack ? e.stack : e) + "\n");
    process.exit(1);
    return;
  }
  const keep = process.env.VH_EXAMPLE_KEEP === "1";
  if (result.work && result.ownsWorkspace && !keep) {
    try {
      fs.rmSync(result.work, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup; never fail the example over it */
    }
  } else if (result.work) {
    out(`(kept workspace: ${result.work})`);
  }
  process.exit(result.code);
}

module.exports = { main };

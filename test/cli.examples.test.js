"use strict";

// Tests for the runnable, self-checking OFFLINE end-to-end example (T-21.2): examples/run.js.
//
// What these prove (the example is a LIVING, test-gated demo that cannot rot):
//   * Running `node examples/run.js` end-to-end against the committed sample data exits 0 and prints a
//     clear PASS summary — the whole DataLedger + ProofParcel buyer pipeline actually works.
//   * The expected artifacts (dataset manifest/report/attestation, parcel manifest/attestation) are
//     produced — at the caller-chosen output path, NEVER scattered into the repo.
//   * A DELIBERATE policy violation in the committed sample (a GPL-3.0 file + a no-license file) is
//     correctly FLAGGED by `dataset check --policy` as FAIL (the CLI's exit-3 contract).
//   * A TAMPER (mutate one sample file) is correctly caught by dataset/parcel verify as a MISMATCH and
//     localized to the CHANGED file (the CLI's exit-3 contract).
//   * The example leaves the repo working tree CLEAN — zero stray artifacts under examples/ (pass OR fail).
//   * The example LEADS with the standing TRUST_NOTE and references — but does NOT execute — the
//     human-gated sign/timestamp/anchor steps, so it never overclaims.
//
// These are fully OFFLINE/no-key/no-network: no hardhat node, no provider. Every filesystem effect is
// isolated to a throwaway temp dir and cleaned up, pass or fail.

const { expect } = require("chai");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const RUN_JS = path.join(REPO, "examples", "run.js");
const EXAMPLES_DIR = path.join(REPO, "examples");

const dataset = require("../cli/dataset");
const parcel = require("../cli/parcel");

// Snapshot the tracked + untracked state of examples/ via git porcelain. An empty string for the
// untracked-artifact check means "nothing new appeared in the sample tree".
function gitPorcelain(relPath) {
  return execFileSync("git", ["status", "--porcelain", "--", relPath], {
    cwd: REPO,
    encoding: "utf8",
  });
}

describe("examples/run.js — runnable OFFLINE end-to-end demo (T-21.2)", function () {
  // The example copies + hashes a handful of tiny files; generous but bounded for slow CI.
  this.timeout(60000);

  let outDir;

  beforeEach(function () {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-example-test-"));
  });

  afterEach(function () {
    // Always clean our temp workspace, pass or fail — no leaked artifacts in the working tree.
    if (outDir && fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("runs end-to-end against the committed sample, exits 0, and prints a PASS summary", function () {
    // VH_EXAMPLE_OUT points the example at OUR temp dir so we can inspect its artifacts; because we set
    // it, the example treats the workspace as caller-owned and does NOT delete it (we clean it in afterEach).
    const stdout = execFileSync("node", [RUN_JS], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, VH_EXAMPLE_OUT: outDir },
    });

    expect(stdout).to.match(/RESULT: PASS — all \d+ pipeline checks passed\./);

    // It LEADS with the standing trust note and references (does NOT execute) the human-gated handoff.
    expect(stdout).to.include(dataset.TRUST_NOTE);
    expect(stdout).to.match(/unaltered since date T/i);
    expect(stdout).to.include("vh dataset sign");
    expect(stdout).to.include("vh dataset timestamp-request");
    expect(stdout).to.include("needs-human");

    // The expected artifacts were produced — at OUR chosen path, not in the repo.
    const expected = [
      "dataset.manifest.json",
      "dataset.evidence.md",
      "dataset.attestation.json",
      "parcel.manifest.json",
      "parcel.attestation.json",
    ];
    for (const f of expected) {
      expect(fs.existsSync(path.join(outDir, f)), `expected artifact ${f}`).to.equal(true);
    }

    // The unsigned attestation really is the canonical UNSIGNED payload (signed:false).
    const dsAtt = JSON.parse(fs.readFileSync(path.join(outDir, "dataset.attestation.json"), "utf8"));
    expect(dsAtt.signed).to.equal(false);
    const pAtt = JSON.parse(fs.readFileSync(path.join(outDir, "parcel.attestation.json"), "utf8"));
    expect(pAtt.signed).to.equal(false);
  });

  it("leaves the repo working tree CLEAN — no stray artifacts appear under examples/", function () {
    // Capture the set of untracked paths under examples/ BEFORE the run (examples/ itself is committed
    // by the driver; here we only assert the RUN introduces nothing new INTO the sample tree).
    const before = gitPorcelain("examples/");

    execFileSync("node", [RUN_JS], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, VH_EXAMPLE_OUT: outDir },
    });

    const after = gitPorcelain("examples/");
    // The example must not write ANY artifact into examples/ (it writes only to VH_EXAMPLE_OUT/temp).
    expect(after).to.equal(before);

    // And with the DEFAULT (no VH_EXAMPLE_OUT) the example self-cleans its own OS temp dir: a second run
    // with no output override must still leave examples/ byte-for-byte unchanged.
    const env2 = { ...process.env };
    delete env2.VH_EXAMPLE_OUT;
    delete env2.VH_EXAMPLE_KEEP;
    execFileSync("node", [RUN_JS], { cwd: REPO, encoding: "utf8", env: env2 });
    expect(gitPorcelain("examples/")).to.equal(before);
  });

  it("flags the DELIBERATE policy violation in the committed sample (check --policy → FAIL / exit-3 contract)", function () {
    // Drive the SAME module the example + CLI use, against the committed sample, to assert the exit-3
    // semantics precisely (PASS=>exit 0, FAIL=>exit 3 per cli/vh.js cmdDatasetCheck).
    const manifestPath = path.join(outDir, "ds.manifest.json");
    const hints = JSON.parse(
      fs.readFileSync(path.join(EXAMPLES_DIR, "sample-dataset.hints.json"), "utf8")
    );
    dataset.runDatasetBuild({
      dir: path.join(EXAMPLES_DIR, "sample-dataset"),
      out: manifestPath,
      hints,
      stdout: () => {},
    });

    // Lenient policy => PASS (the gate is not vacuously failing).
    const lenient = dataset.runDatasetCheck({
      manifest: manifestPath,
      policy: path.join(EXAMPLES_DIR, "policy.lenient.json"),
      stdout: () => {},
    });
    expect(lenient.verdict).to.equal("PASS");

    // Strict policy => FAIL, flagging BOTH planted violations: the GPL-3.0 file and the no-license file.
    const strict = dataset.runDatasetCheck({
      manifest: manifestPath,
      policy: path.join(EXAMPLES_DIR, "policy.strict.json"),
      stdout: () => {},
    });
    expect(strict.verdict).to.equal("FAIL");
    const rules = strict.violations.map((v) => v.rule);
    expect(rules).to.include("denyLicenses"); // the GPL-3.0 file
    expect(rules).to.include("requireLicense"); // the no-license file
    const gpl = strict.violations.find((v) => v.rule === "denyLicenses");
    expect(gpl.value).to.equal("GPL-3.0");
    expect(gpl.relPath).to.equal("vendored/gpl-snippet.txt");
  });

  it("catches a TAMPER in both pipelines (dataset + parcel verify → MISMATCH, localized)", function () {
    // ---- DataLedger tamper ----
    const dsManifest = path.join(outDir, "ds.manifest.json");
    dataset.runDatasetBuild({
      dir: path.join(EXAMPLES_DIR, "sample-dataset"),
      out: dsManifest,
      stdout: () => {},
    });

    // Untouched sample re-derives the same root.
    const ok = dataset.runDatasetVerify({
      dir: path.join(EXAMPLES_DIR, "sample-dataset"),
      manifest: dsManifest,
      stdout: () => {},
    });
    expect(ok.status).to.equal("MATCH");

    // Copy the sample into the temp dir, mutate ONE file, and confirm verify catches it.
    const tamperDir = path.join(outDir, "tampered-ds");
    copyDir(path.join(EXAMPLES_DIR, "sample-dataset"), tamperDir);
    fs.appendFileSync(path.join(tamperDir, "corpus", "mit-notes.txt"), "\nTAMPER\n");
    const bad = dataset.runDatasetVerify({ dir: tamperDir, manifest: dsManifest, stdout: () => {} });
    expect(bad.status).to.equal("MISMATCH");
    expect(bad.diff.changed.map((c) => c.path)).to.include("corpus/mit-notes.txt");

    // ---- ProofParcel tamper ----
    const pManifest = path.join(outDir, "p.manifest.json");
    parcel.runParcelBuild({
      dir: path.join(EXAMPLES_DIR, "sample-parcel"),
      out: pManifest,
      parcel: { parcelId: "EX-0001", sender: "acme", recipient: "globex" },
      stdout: () => {},
    });
    const pok = parcel.runParcelVerify({
      dir: path.join(EXAMPLES_DIR, "sample-parcel"),
      manifest: pManifest,
      stdout: () => {},
    });
    expect(pok.status).to.equal("MATCH");

    const pTamperDir = path.join(outDir, "tampered-p");
    copyDir(path.join(EXAMPLES_DIR, "sample-parcel"), pTamperDir);
    fs.appendFileSync(path.join(pTamperDir, "data", "records.csv"), "9,zzz,999\n");
    const pbad = parcel.runParcelVerify({ dir: pTamperDir, manifest: pManifest, stdout: () => {} });
    expect(pbad.status).to.equal("MISMATCH");
    expect(pbad.diff.changed.map((c) => c.path)).to.include("data/records.csv");
  });

  it("exposes a testable main() that returns a structured PASS result with the artifact set", function () {
    // The example is importable: main() returns { code, work, artifacts, checks, ownsWorkspace } so a
    // harness can assert on it without scraping stdout. We point it at our temp dir (caller-owned, so it
    // is NOT auto-deleted) and assert every check passed.
    const prevOut = process.env.VH_EXAMPLE_OUT;
    process.env.VH_EXAMPLE_OUT = outDir;
    try {
      const { main } = require("../examples/run");
      const result = main();
      expect(result.code).to.equal(0);
      expect(result.ownsWorkspace).to.equal(false); // caller-chosen VH_EXAMPLE_OUT => not ours to delete
      expect(result.checks.length).to.be.greaterThan(0);
      expect(result.checks.every((c) => c.ok)).to.equal(true);
      expect(result.artifacts).to.have.all.keys(
        "datasetManifest",
        "datasetReport",
        "datasetAttestation",
        "parcelManifest",
        "parcelAttestation"
      );
    } finally {
      if (prevOut === undefined) delete process.env.VH_EXAMPLE_OUT;
      else process.env.VH_EXAMPLE_OUT = prevOut;
    }
  });
});

// Recursively copy a directory tree (the sample is tiny) — mirrors examples/run.js so the test's tamper
// step mutates a working COPY, never the committed sample under examples/.
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

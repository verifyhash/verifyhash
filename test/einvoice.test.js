"use strict";
// Bridges the einvoice/ expansion product into the loop's mechanical gate (npx hardhat test).
// The full differential-vs-official-Schematron run (einvoice/differential.py over ~1005 invoices) is the
// per-task acceptance check + a supervisor boundary check (it needs SaxonC + minutes); here we gate the
// FAST, always-runnable conformance harness so an einvoice change that regresses its own proven verdicts
// turns the loop's build RED. Skips cleanly where python3 is absent (the gate must not fail for tooling).
const { execFileSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const REPO = path.resolve(__dirname, "..");
const EINVOICE = path.join(REPO, "einvoice");
const CONFORMANCE = path.join(EINVOICE, "conformance.py");
const XRECHNUNG_TESTS = path.join(EINVOICE, "test_xrechnung.py");
const PACKAGING_TESTS = path.join(EINVOICE, "test_packaging.py");
const RULES_TESTS = path.join(EINVOICE, "test_rules.py");

function havePython() {
  try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

describe("einvoice (expansion product): conformance gate", function () {
  this.timeout(120000);

  it("einvoice/conformance.py passes (0 hard fails, 0 false positives) — or SKIPS if python3 absent", function () {
    if (!havePython()) { this.skip(); return; }
    if (!fs.existsSync(CONFORMANCE)) throw new Error("einvoice/conformance.py missing — the expansion product is not wired");
    const res = spawnSync("python3", [CONFORMANCE], { cwd: EINVOICE, encoding: "utf8", timeout: 110000 });
    if (res.status !== 0) {
      throw new Error(
        "einvoice conformance FAILED (exit " + res.status + "). The validator regressed against its proven vectors.\n" +
        (res.stdout || "").split("\n").slice(-25).join("\n") + "\n" + (res.stderr || "").slice(-2000)
      );
    }
  });

  it("einvoice/test_xrechnung.py passes (XRechnung BR-DE CIUS layer pinned) — or SKIPS if python3 absent", function () {
    if (!havePython()) { this.skip(); return; }
    if (!fs.existsSync(XRECHNUNG_TESTS)) throw new Error("einvoice/test_xrechnung.py missing — the XRechnung CIUS layer is not gated");
    const res = spawnSync("python3", [XRECHNUNG_TESTS], { cwd: EINVOICE, encoding: "utf8", timeout: 110000 });
    if (res.status !== 0) {
      throw new Error(
        "einvoice XRechnung layer tests FAILED (exit " + res.status + "). The BR-DE rules regressed against their differential-proven behaviour.\n" +
        (res.stdout || "").split("\n").slice(-25).join("\n") + "\n" + (res.stderr || "").slice(-2000)
      );
    }
  });

  it("einvoice/test_packaging.py passes (entry points, zero-dep packaging, CI gate) — or SKIPS if python3 absent", function () {
    if (!havePython()) { this.skip(); return; }
    if (!fs.existsSync(PACKAGING_TESTS)) throw new Error("einvoice/test_packaging.py missing — the packaging/CI-gate surface is not gated");
    const res = spawnSync("python3", [PACKAGING_TESTS], { cwd: EINVOICE, encoding: "utf8", timeout: 110000 });
    if (res.status !== 0) {
      throw new Error(
        "einvoice packaging tests FAILED (exit " + res.status + "). The installable/embeddable surface (pip entry point, python -m, ci/validate-invoices.sh) regressed.\n" +
        (res.stdout || "").split("\n").slice(-25).join("\n") + "\n" + (res.stderr || "").slice(-2000)
      );
    }
  });

  it("einvoice/test_rules.py passes (EN 16931 core VAT-breakdown + Standard-rate rules pinned) — or SKIPS if python3 absent", function () {
    if (!havePython()) { this.skip(); return; }
    if (!fs.existsSync(RULES_TESTS)) throw new Error("einvoice/test_rules.py missing — the EN core BR-45..48 / BR-S-* rules are not gated");
    const res = spawnSync("python3", [RULES_TESTS], { cwd: EINVOICE, encoding: "utf8", timeout: 110000 });
    if (res.status !== 0) {
      throw new Error(
        "einvoice EN-core rule tests FAILED (exit " + res.status + "). The BR-45..48 / BR-S-* rules regressed against their differential-proven behaviour.\n" +
        (res.stdout || "").split("\n").slice(-25).join("\n") + "\n" + (res.stderr || "").slice(-2000)
      );
    }
  });
});

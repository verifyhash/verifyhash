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
});

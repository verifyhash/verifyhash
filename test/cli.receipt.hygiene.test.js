const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// T-9.1 filesystem-hygiene guard.
//
// A claim receipt holds the SECRET salt. No command (and so no test) may ever silently drop a
// `*.vhclaim.json` into the repository root: every receipt write must go to an explicit,
// caller-chosen path (the suite uses an OS temp dir). This file enforces that as an assertion the
// suite itself must satisfy, so a regression that reintroduces a cwd-relative receipt write (the old
// `runClaim`/`runCommit` default) FAILS the build instead of quietly leaking a secret artifact.
//
// We snapshot the set of repo-root `*.vhclaim.json` files at load time (there should be none — the
// stale leaked receipts were deleted in T-9.1) and re-check in a root-level `after` hook, which mocha
// runs once after the ENTIRE suite regardless of file order. If any new receipt appeared during the
// run, we report (and clean up) the leak and fail.
// ---------------------------------------------------------------------------
const REPO_ROOT = path.join(__dirname, "..");

function repoRootReceipts() {
  return fs
    .readdirSync(REPO_ROOT)
    .filter((f) => f.endsWith(".vhclaim.json"))
    .sort();
}

// Captured the moment this file is loaded (before any test in the run has executed a command).
const baselineReceipts = repoRootReceipts();

describe("T-9.1 filesystem hygiene: no receipts leak into the repo root", function () {
  it("the repo root starts with ZERO *.vhclaim.json files (stale leaks were deleted)", function () {
    expect(
      baselineReceipts,
      `unexpected receipt files in the repo root at suite start: ${baselineReceipts.join(", ")}`
    ).to.deep.equal([]);
  });

  // Root-level after: runs once, after every test in the whole suite has finished, so it catches a
  // receipt written by ANY test file (claim/commit/anchor/etc.), not just this one.
  after(function () {
    const now = repoRootReceipts();
    const leaked = now.filter((f) => !baselineReceipts.includes(f));
    // Always clean up so a failure here never itself leaves a leaked secret in the working tree.
    for (const f of leaked) fs.rmSync(path.join(REPO_ROOT, f), { force: true });
    expect(
      leaked,
      `the suite leaked ${leaked.length} receipt(s) into the repo root (now cleaned): ${leaked.join(", ")}. ` +
        "Every receipt write must target an explicit temp/--receipt path, never cwd."
    ).to.deep.equal([]);
  });
});

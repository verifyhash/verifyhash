"use strict";

// Single source of truth for the ContributionRegistry ABI used by the on-chain
// `vh` subcommands (anchor/claim/verify/list/show/…).
//
// Why this exists: the CLI must ship and run as a published npm package whose
// `files` allowlist contains only `cli/` — it does NOT ship hardhat's build
// output under `artifacts/`. If the on-chain modules required
// `../artifacts/contracts/ContributionRegistry.sol/ContributionRegistry.json`
// directly (as they historically did), then a clean install would CRASH on
// load — even for on-chain-free commands like `vh hash`, because vh.js eagerly
// requires those modules.
//
// Resolution order:
//   1. The committed, shipped copy bundled in `cli/abi/…` (always present in a
//      published install).
//   2. The hardhat artifact under `artifacts/…` when developing inside the repo
//      (kept as a freshness cross-check; see test/cli.packaging.test.js).
//
// Either source yields the same ABI. We prefer the bundled copy so the package
// is self-contained and never depends on a compile step at runtime.

const path = require("path");

function tryRequire(p) {
  try {
    return require(p);
  } catch (_err) {
    return null;
  }
}

// Bundled, version-controlled copy that ships with the package.
const bundled = tryRequire(path.join(__dirname, "..", "abi", "ContributionRegistry.json"));

// Hardhat build output — only present in a dev checkout after `hardhat compile`.
const hardhat = tryRequire(
  path.join(__dirname, "..", "..", "artifacts", "contracts", "ContributionRegistry.sol", "ContributionRegistry.json")
);

const ARTIFACT = bundled || hardhat;

if (!ARTIFACT || !Array.isArray(ARTIFACT.abi)) {
  throw new Error(
    "ContributionRegistry ABI unavailable: neither the bundled cli/abi copy nor the hardhat artifact could be loaded."
  );
}

module.exports = ARTIFACT;

"use strict";

// `vh prove <file> --root <repoDir>` — prove a single file belongs to an anchored repo root.
//
// The big idea of EPIC-2: you don't have to anchor every file in a repository. You anchor the
// repo's *Merkle root* once (one hash, one tx) and later prove that any individual file was part
// of that exact snapshot by producing a Merkle proof — a short list of sibling hashes that folds
// the file's leaf up to the anchored root. The on-chain `verifyLeaf(root, leaf, proof)` replays
// that fold with sorted-pair hashing and returns true iff the file really was in the tree.
//
// The flow:
//   1. Hash the repo root directory into its sorted-leaf Merkle root and per-file leaves
//      (cli/hash.js — the exact same construction `vh anchor <dir>` and `verifyLeaf` agree on).
//   2. Locate <file> within that tree and generate its Merkle proof.
//   3. Either *print* the proof (`--dry-run`, no key/network) or *check it on-chain*:
//        - read the registry: confirm the root is actually anchored (else there is nothing to
//          prove the file against), then
//        - call `verifyLeaf(root, leaf, proof)` and report ACCEPTED / REJECTED.
//   4. (Optional) `--anchor` first submits the root via anchor() so a fresh repo can be proven in
//      one shot; this is the only path that needs a signer.
//
// Why this is tamper-evident: the leaf is keccak256(file bytes). Change one byte of the file and
// its leaf changes, so the proof (built for the *original* leaf) no longer folds to the anchored
// root and `verifyLeaf` returns false. That property is exactly what the test pins down.
//
// Split into pure pieces (buildProof) and an on-chain runner (runProve) so the end-to-end test can
// drive it against a live hardhat node and assert the contract's verifyLeaf verdict directly.

const path = require("path");
const fs = require("fs");
const { hashDir, hashFile } = require("./hash");

const ARTIFACT = require("../artifacts/contracts/ContributionRegistry.sol/ContributionRegistry.json");
const ABI = ARTIFACT.abi;

/**
 * Build (purely, no network) a Merkle proof for `filePath` within the repo at `rootDir`.
 *
 * Returns the directory's anchored root, the file's leaf (= keccak256 of its bytes), and the
 * proof. Replaying `proof` against `leaf` with sorted-pair hashing reproduces `root`, so the proof
 * is exactly what the contract's `verifyLeaf` accepts.
 *
 * @param {object} opts
 * @param {string} opts.file     path to a file that must live under rootDir
 * @param {string} opts.rootDir  the repository root directory to anchor/prove against
 * @returns {{
 *   root: string,
 *   leaf: string,
 *   proof: string[],
 *   file: string,       // path of the file relative to rootDir
 *   rootDir: string,
 *   fileCount: number,  // number of files (leaves) in the tree
 * }}
 */
function buildProof(opts) {
  const { file, rootDir } = opts;
  if (!file) throw new Error("prove requires a <file>");
  if (!rootDir) {
    throw new Error("no repo root: pass --root <dir> (the repository root to prove against)");
  }

  const rootStat = fs.statSync(rootDir);
  if (!rootStat.isDirectory()) {
    throw new Error(`--root must be a directory (the repo root), got: ${rootDir}`);
  }

  // Resolve the target file to an absolute path and confirm it is a regular file that actually
  // sits *inside* the repo root. Proving a file that isn't in the tree is meaningless, and we want
  // a clear error rather than a confusing "not found in tree" later.
  const absRoot = path.resolve(rootDir);
  const absFile = path.resolve(path.isAbsolute(file) ? file : path.join(absRoot, file));
  const fileStat = fs.statSync(absFile);
  if (!fileStat.isFile()) {
    throw new Error(`not a regular file: ${absFile}`);
  }
  const rel = path.relative(absRoot, absFile);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`file is not inside the repo root: ${absFile} (root: ${absRoot})`);
  }

  const { root, leaves, proofFor } = hashDir(absRoot);
  const leaf = hashFile(absFile);
  // proofFor accepts a path relative to the root, an absolute path, or a leaf hash. Use the
  // relative path so duplicate-content files still resolve to *this* file's position.
  const proof = proofFor(rel);

  return {
    root,
    leaf,
    proof,
    file: rel,
    rootDir: absRoot,
    fileCount: leaves.length,
  };
}

/** Render a built proof as the multi-line block `--dry-run` (and the runner) prints. */
function formatProof(p, extra) {
  const lines = [
    `  repo root dir: ${p.rootDir}  (${p.fileCount} files)`,
    `  file:          ${p.file}`,
    `  merkle root:   ${p.root}`,
    `  leaf:          ${p.leaf}`,
    `  proof (${p.proof.length} sibling${p.proof.length === 1 ? "" : "s"}):`,
  ];
  if (p.proof.length === 0) {
    lines.push("    (none — single-file tree: leaf == root)");
  } else {
    for (const h of p.proof) lines.push(`    ${h}`);
  }
  if (extra && extra.length) {
    lines.push("");
    for (const l of extra) lines.push(l);
  }
  return lines.join("\n");
}

/**
 * Run the prove command end to end.
 *
 * In `--dry-run` mode it only builds + prints the proof (no key, no network) and returns
 * `{ dryRun: true, ...proof }`.
 *
 * Otherwise it talks to the deployed ContributionRegistry:
 *   - If `anchorFirst` is set, it submits the root via anchor() with `signer` (the only path that
 *     needs a key), so a brand-new repo can be anchored and proven in one command.
 *   - It confirms the root is anchored on-chain (via isAnchored) — there is nothing to prove a
 *     file against if the root was never anchored.
 *   - It calls `verifyLeaf(root, leaf, proof)` on-chain and reports the contract's verdict.
 *
 * @param {object} opts
 * @param {string}  opts.file
 * @param {string}  opts.rootDir
 * @param {string}  opts.contractAddress
 * @param {object}  opts.provider               ethers v6 Provider (read-only; required)
 * @param {boolean}[opts.dryRun]
 * @param {boolean}[opts.anchorFirst]           anchor the root before proving (needs a signer)
 * @param {object} [opts.signer]                ethers Signer (required iff anchorFirst)
 * @param {boolean}[opts.iUnderstandMainnet]    forwarded to anchor()'s chainId guard
 * @param {object} [opts.ethers]                ethers v6 module
 * @param {(s:string)=>void}[opts.log]          sink for human output (defaults to process.stdout)
 * @returns {Promise<object>} result describing what happened
 */
async function runProve(opts) {
  const ethersLib = opts.ethers || require("ethers");
  const log = opts.log || ((s) => process.stdout.write(s));

  const built = buildProof({ file: opts.file, rootDir: opts.rootDir });

  // The contract rejects a zero hash, and a zero leaf/root means an empty or degenerate tree.
  if (/^0x0{64}$/i.test(built.root)) {
    throw new Error("refusing to prove against the zero root (contract rejects it)");
  }

  if (opts.dryRun) {
    log(formatProof(built) + "\n");
    return { dryRun: true, ...built };
  }

  const { contractAddress, provider } = opts;
  if (!contractAddress) {
    throw new Error(
      "no contract address: pass --contract <address> or set VH_CONTRACT in the environment"
    );
  }
  if (!ethersLib.isAddress(contractAddress)) {
    throw new Error(`invalid contract address: ${contractAddress}`);
  }
  if (!provider) {
    throw new Error("no provider: pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL");
  }

  const address = ethersLib.getAddress(contractAddress);
  const readContract = new ethersLib.Contract(address, ABI, provider);

  // Optionally anchor the root first so a fresh repo can be proven in one shot.
  let anchored = null;
  if (opts.anchorFirst) {
    if (!opts.signer) {
      throw new Error("--anchor needs a signer (set PRIVATE_KEY) to submit the root");
    }
    // Reuse the audited anchor flow (chainId guard, event parsing) instead of re-implementing it.
    const { runAnchor } = require("./anchor");
    const anchorRes = await runAnchor({
      path: built.rootDir,
      contractAddress: address,
      provider,
      signer: opts.signer,
      iUnderstandMainnet: opts.iUnderstandMainnet,
      ethers: ethersLib,
      log: () => {}, // keep prove's own output clean; we summarize below
    });
    anchored = anchorRes.anchored;
    log(`Anchored repo root ${built.root} (${built.fileCount} files).\n`);
  }

  // There is nothing to prove a file against if the root was never anchored.
  const rootIsAnchored = await readContract.isAnchored(built.root);
  if (!rootIsAnchored) {
    throw new Error(
      `repo root ${built.root} is not anchored on-chain; ` +
        "anchor it first (`vh anchor <repoDir>` or pass --anchor) before proving a file against it."
    );
  }

  // The acceptance criterion: the *on-chain* verifyLeaf must accept a genuine file's proof.
  const accepted = await readContract.verifyLeaf(built.root, built.leaf, built.proof);

  const extra = [
    `  root anchored: yes`,
    `  verifyLeaf:    ${accepted ? "ACCEPTED" : "REJECTED"}`,
  ];
  if (!accepted) {
    extra.push(
      "  The on-chain verifyLeaf rejected this proof: the file does not match the anchored",
      "  repo root (it was modified/tampered, or it was not part of the anchored snapshot)."
    );
  }
  log(formatProof(built, extra) + "\n");

  return {
    dryRun: false,
    ...built,
    contractAddress: address,
    rootIsAnchored: true,
    accepted,
    anchored,
  };
}

module.exports = {
  buildProof,
  runProve,
  formatProof,
  ABI,
};

"use strict";

// `vh anchor <path> [--uri <uri>]` — submit a contribution's content hash on-chain.
//
// The flow:
//   1. Hash the target path (file -> keccak256 of bytes; directory -> sorted-leaf Merkle root),
//      reusing the exact logic the contract's verifyLeaf convention expects (see cli/hash.js).
//   2. Encode a call to ContributionRegistry.anchor(contentHash, uri).
//   3. Either *print* that transaction (`--dry-run`, no key required) or *send* it with a signer.
//
// Safety rails:
//   * --dry-run never touches a key and never broadcasts; it only shows the tx that would be sent.
//   * Submitting refuses to run against a chainId that is not a known testnet/dev chain unless the
//     operator passes --i-understand-mainnet. This keeps the auto-build loop (and a sleepy human)
//     from accidentally spending real funds / writing to a production chain.
//
// This module is split into small, side-effect-free pieces (buildAnchorTx, chainId guard) so the
// integration test can drive it against a local hardhat node and assert the on-chain Anchored event.

const { hashPath, hashGit } = require("./hash");
const { buildAnchorReceipt, writeReceipt } = require("./receipt");

const ARTIFACT = require("../artifacts/contracts/ContributionRegistry.sol/ContributionRegistry.json");
const ABI = ARTIFACT.abi;

// Chains we consider safe to anchor on without an explicit override. These are local dev chains and
// public testnets only — never mainnets. Anything outside this set is treated as "could be mainnet"
// and is blocked unless --i-understand-mainnet is given.
//
//   31337  Hardhat (local)            1337   Ganache / generic local dev
//   80002  Polygon Amoy testnet       80001  Polygon Mumbai testnet (legacy)
//   11155111 Ethereum Sepolia         17000  Ethereum Holesky
//   5      Ethereum Goerli (legacy)   11155420 Optimism Sepolia
//   84532  Base Sepolia               421614 Arbitrum Sepolia
const KNOWN_TESTNET_CHAIN_IDS = new Set([
  31337n, 1337n, 80002n, 80001n, 11155111n, 17000n, 5n, 11155420n, 84532n, 421614n,
]);

/** True iff `chainId` is a known local/dev/testnet chain that is safe to anchor on by default. */
function isTestnetChainId(chainId) {
  return KNOWN_TESTNET_CHAIN_IDS.has(BigInt(chainId));
}

/**
 * Compute the content hash to anchor for a filesystem path.
 * A file anchors its keccak256 digest; a directory anchors its sorted-leaf Merkle root. For a
 * directory the per-file MANIFEST (sorted `{ path, contentHash, leaf }` — exactly what `vh hash <dir>`
 * produces) is also returned so an anchor receipt can record it and a later `vh verify --receipt`
 * can localize which file diverged.
 *
 * With `opts.git`, the root and manifest are computed over EXACTLY the files git tracks at `opts.ref`
 * (default HEAD) — the same reproducible, untracked-junk-ignoring enumeration as `vh hash --git`
 * (T-8.1) — and a `git` provenance block `{ commit, scope }` is returned so the receipt can record
 * the resolved commit oid and the repo-relative scope used to enumerate the tracked set. That block
 * is an UNTRUSTED convenience hint (docs/TRUST-BOUNDARIES); the anchored contentHash is unchanged
 * whether it was derived by the filesystem walk or the git walk for the same tracked content.
 *
 * @param {string} targetPath
 * @param {{ git?: boolean, ref?: string }} [opts]
 * @returns {{ contentHash: string, kind: "file"|"dir",
 *            manifest: Array<{path:string,contentHash:string,leaf:string}>|null,
 *            git: {commit:string,scope:string}|null }}
 */
function contentHashForPath(targetPath, opts = {}) {
  if (opts.git) {
    // git-scoped: a directory root over the tracked set, with provenance. (--git always means a dir
    // root; hashGit errors clearly on a non-git dir / unknown ref / zero tracked files.)
    const res = hashGit(targetPath, { ref: opts.ref });
    const manifest = res.leaves.map((l) => ({
      path: l.path,
      contentHash: l.contentHash,
      leaf: l.leaf,
    }));
    return {
      contentHash: res.root,
      kind: "dir",
      manifest,
      git: { commit: res.commit, scope: res.scope },
    };
  }
  const res = hashPath(targetPath);
  const manifest =
    res.kind === "dir" && Array.isArray(res.leaves)
      ? res.leaves.map((l) => ({ path: l.path, contentHash: l.contentHash, leaf: l.leaf }))
      : null;
  return { contentHash: res.root, kind: res.kind, manifest, git: null };
}

/**
 * Build (but do not send) the anchor transaction for a path. No private key, signer, or network
 * connection is required — this is exactly what `--dry-run` prints. Returns both the encoded EVM
 * transaction request and the human-readable pieces that went into it.
 *
 * @param {object} opts
 * @param {string} opts.path             path to a file or directory to hash & anchor
 * @param {string} [opts.uri]            optional off-chain pointer stored alongside the hash
 * @param {boolean}[opts.git]            hash EXACTLY the git-tracked files (ignores untracked junk)
 * @param {string} [opts.ref]            with git: which commit's tracked set to hash (default HEAD)
 * @param {string} opts.contractAddress  deployed ContributionRegistry address (the tx `to`)
 * @param {object} [opts.ethers]         an ethers v6 module (defaults to the one bundled here)
 * @returns {{
 *   to: string, data: string, value: string,
 *   contentHash: string, uri: string, kind: "file"|"dir", path: string,
 *   manifest: Array|null, git: {commit:string,scope:string}|null,
 *   functionName: "anchor"
 * }}
 */
function buildAnchorTx(opts) {
  const { path: targetPath, contractAddress } = opts;
  const ethersLib = opts.ethers || require("ethers");
  const uri = opts.uri == null ? "" : String(opts.uri);

  if (!targetPath) throw new Error("anchor requires a <path>");
  if (!contractAddress) {
    throw new Error(
      "no contract address: pass --contract <address> or set VH_CONTRACT in the environment"
    );
  }
  if (!ethersLib.isAddress(contractAddress)) {
    throw new Error(`invalid contract address: ${contractAddress}`);
  }

  const { contentHash, kind, manifest, git } = contentHashForPath(targetPath, {
    git: opts.git,
    ref: opts.ref,
  });
  // The contract reverts on a zero hash; catch it here with a clearer message before we ever
  // try to build/send a doomed transaction.
  if (/^0x0{64}$/i.test(contentHash)) {
    throw new Error("refusing to anchor the zero hash (contract rejects it)");
  }

  const iface = new ethersLib.Interface(ABI);
  const data = iface.encodeFunctionData("anchor", [contentHash, uri]);

  return {
    to: ethersLib.getAddress(contractAddress),
    data,
    value: "0x0", // anchor() is non-payable; never attach value.
    contentHash,
    uri,
    kind,
    path: targetPath,
    manifest, // per-file manifest for a dir (null for a file); recorded into a --receipt
    git, // { commit, scope } when --git was used; null otherwise. Recorded into a --receipt.
    functionName: "anchor",
  };
}

/** Render a built anchor tx as the multi-line block `--dry-run` prints. */
function formatDryRun(tx, chainId) {
  const lines = [
    "DRY RUN — no transaction will be sent.",
    "",
    `  path:         ${tx.path}  (${tx.kind})`,
    `  contentHash:  ${tx.contentHash}`,
    `  uri:          ${tx.uri === "" ? "(none)" : tx.uri}`,
  ];
  if (tx.git) {
    // Provenance is an untrusted convenience hint — say so, so it is never mistaken for the verdict.
    lines.push(
      `  git commit:   ${tx.git.commit}  (untrusted provenance hint)`,
      `  git scope:    ${tx.git.scope}`
    );
  }
  lines.push("");
  lines.push(
    "  Transaction that WOULD be sent:",
    `    to:    ${tx.to}`,
    `    value: ${tx.value}`,
    `    data:  ${tx.data}`
  );
  if (chainId != null) lines.push(`    chainId: ${BigInt(chainId).toString()}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Run the anchor command end to end.
 *
 * In `--dry-run` mode it returns `{ dryRun: true, tx }` after only building the tx (no key, no
 * network write). Otherwise it enforces the testnet guard, sends the tx with `signer`, waits for it
 * to mine, and parses the `Anchored` event off the receipt.
 *
 * @param {object} opts
 * @param {string}  opts.path
 * @param {string} [opts.uri]
 * @param {boolean}[opts.git]                   hash EXACTLY the git-tracked files (T-8.1 enumeration)
 * @param {string} [opts.ref]                   with git: which commit's tracked set (default HEAD)
 * @param {string}  opts.contractAddress
 * @param {boolean}[opts.dryRun]
 * @param {boolean}[opts.iUnderstandMainnet]   bypass the non-testnet chainId refusal
 * @param {object} [opts.signer]               ethers Signer (required unless dryRun)
 * @param {object} [opts.provider]             ethers Provider (used to read chainId; falls back to signer.provider)
 * @param {bigint|number}[opts.chainId]        override/short-circuit the chainId lookup (tests)
 * @param {string} [opts.receiptPath]          if set, write an anchor receipt here (records the dir
 *                                             manifest so `vh verify --receipt` can localize a tamper)
 * @param {object} [opts.ethers]               ethers v6 module
 * @param {(s:string)=>void}[opts.log]         sink for human output (defaults to process.stdout)
 * @returns {Promise<object>} result describing what happened (includes `receiptPath` when one was written)
 */
async function runAnchor(opts) {
  const ethersLib = opts.ethers || require("ethers");
  const log = opts.log || ((s) => process.stdout.write(s));

  const tx = buildAnchorTx({
    path: opts.path,
    uri: opts.uri,
    git: opts.git,
    ref: opts.ref,
    contractAddress: opts.contractAddress,
    ethers: ethersLib,
  });

  // Resolve the chainId we'd be writing to (override > provider > signer.provider).
  let chainId = opts.chainId;
  const provider = opts.provider || (opts.signer && opts.signer.provider);
  if (chainId == null && provider) {
    const net = await provider.getNetwork();
    chainId = net.chainId;
  }

  // Write a receipt (recording the dir manifest) when asked. For a dry run we still write it if a
  // path was given, so a user can produce the manifest offline without ever broadcasting; the
  // anchorTxHash/anchorBlockNumber are simply omitted until a real submission fills them in.
  const maybeWriteReceipt = (extra) => {
    if (!opts.receiptPath) return undefined;
    const receipt = buildAnchorReceipt({
      contentHash: tx.contentHash,
      contractAddress: tx.to,
      chainId: chainId == null ? 0 : chainId,
      uri: tx.uri,
      path: tx.path,
      kind: tx.kind,
      manifest: tx.manifest || undefined,
      git: tx.git || undefined, // untrusted provenance hint: { commit, scope } when --git was used
      ...extra,
    });
    writeReceipt(receipt, opts.receiptPath);
    log(`  receipt written: ${opts.receiptPath}\n`);
    return receipt;
  };

  if (opts.dryRun) {
    log(formatDryRun(tx, chainId) + "\n");
    const receipt = maybeWriteReceipt();
    return {
      dryRun: true,
      tx,
      chainId: chainId == null ? null : BigInt(chainId),
      receiptPath: opts.receiptPath,
      receipt,
    };
  }

  // Real submission from here on — enforce the safety rail first.
  if (chainId == null) {
    throw new Error("cannot determine chainId; refusing to submit without knowing the network");
  }
  if (!isTestnetChainId(chainId) && !opts.iUnderstandMainnet) {
    throw new Error(
      `refusing to anchor on chainId ${BigInt(chainId).toString()} (not a known testnet). ` +
        "If you really mean to write to this chain, re-run with --i-understand-mainnet."
    );
  }
  if (!opts.signer) {
    throw new Error("no signer available to submit the transaction (set PRIVATE_KEY?)");
  }

  const contract = new ethersLib.Contract(tx.to, ABI, opts.signer);
  log(`Anchoring ${tx.path} (${tx.kind}) as ${tx.contentHash} on chainId ${BigInt(chainId)}...\n`);

  const sent = await contract.anchor(tx.contentHash, tx.uri);
  log(`  tx sent: ${sent.hash}\n`);
  const receipt = await sent.wait();

  // Pull the Anchored event back out of the receipt so callers see what was recorded.
  const iface = new ethersLib.Interface(ABI);
  let anchored = null;
  for (const lg of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: lg.topics, data: lg.data });
      if (parsed && parsed.name === "Anchored") {
        anchored = {
          contentHash: parsed.args.contentHash,
          contributor: parsed.args.contributor,
          index: parsed.args.index,
          timestamp: parsed.args.timestamp,
          uri: parsed.args.uri,
        };
        break;
      }
    } catch (_) {
      // Not one of our events; skip.
    }
  }

  if (anchored) {
    log(`  Anchored at index ${anchored.index} by ${anchored.contributor} in tx ${receipt.hash}\n`);
  }

  // Persist an anchor receipt (with the dir manifest + the now-known tx hash/block) when asked.
  const anchorReceipt = maybeWriteReceipt({
    anchorTxHash: receipt.hash,
    anchorBlockNumber: receipt.blockNumber,
  });

  return {
    dryRun: false,
    tx,
    chainId: BigInt(chainId),
    txHash: receipt.hash,
    receipt,
    anchored,
    receiptPath: opts.receiptPath,
    anchorReceipt,
  };
}

module.exports = {
  buildAnchorTx,
  runAnchor,
  formatDryRun,
  contentHashForPath,
  isTestnetChainId,
  KNOWN_TESTNET_CHAIN_IDS,
  ABI,
};

"use strict";

// `vh claim <path>` — front-running-resistant attribution via commit-reveal.
//
// WHY THIS EXISTS
//   The one-shot `vh anchor` puts the raw contentHash in the public mempool. Anyone watching can
//   copy it and anchor it first, becoming the recorded `contributor` (audit findings F4/F14/F2/F5).
//   So `anchor` records are only "first anchorer", never proven authorship.
//
//   `vh claim` instead runs the contract's commit-reveal flow:
//     1. commit(commitment) where commitment = keccak256(abi.encode(contentHash, you, salt)).
//        Only the opaque, sender-bound, salt-blinded hash goes on-chain — it leaks nothing about
//        the contentHash and cannot be reused by anyone else.
//     2. ...wait MIN_REVEAL_DELAY blocks...
//     3. reveal(contentHash, salt, uri) — now the contentHash is public, but a mempool copier who
//        resubmits this reveal as themselves recomputes a DIFFERENT commitment (bound to their
//        address) that they never registered, so their reveal reverts. The committed claimant wins.
//
//   The result is a record with authorBound = true and contributor = you, which front-running
//   cannot redirect.
//
// The module is split into pure pieces (computeCommitment, buildCommitTx, buildRevealTx) plus an
// orchestration runner (runClaim) so the end-to-end test can drive both legs against a live hardhat
// node and prove a front-runner cannot steal the attribution.

const { hashPath } = require("./hash");

const ARTIFACT = require("../artifacts/contracts/ContributionRegistry.sol/ContributionRegistry.json");
const ABI = ARTIFACT.abi;

/**
 * Compute the content hash to claim for a filesystem path (same convention as `vh anchor`):
 * a file claims its keccak256 digest, a directory its sorted-leaf Merkle root.
 * @param {string} targetPath
 * @returns {{ contentHash: string, kind: "file"|"dir" }}
 */
function contentHashForPath(targetPath) {
  const res = hashPath(targetPath);
  return { contentHash: res.root, kind: res.kind };
}

/**
 * Generate a fresh, cryptographically-random 32-byte salt (hex). The salt is the secret that, with
 * the committer's address, blinds the commitment — it MUST be kept private until reveal.
 * @param {object} [ethersLib] ethers v6 module
 * @returns {string} 0x-prefixed 32-byte hex
 */
function newSalt(ethersLib) {
  const e = ethersLib || require("ethers");
  return e.hexlify(e.randomBytes(32));
}

/**
 * Compute the commitment hash exactly as the contract's `commitmentOf` does:
 *   keccak256(abi.encode(contentHash, committer, salt)).
 * Binding `committer` is what makes a stolen reveal resolve to a different, never-registered
 * commitment, so a front-runner cannot claim someone else's content.
 *
 * @param {object} args
 * @param {string} args.contentHash 0x 32-byte digest being claimed
 * @param {string} args.committer   the address that will reveal (== eventual msg.sender)
 * @param {string} args.salt        0x 32-byte secret salt
 * @param {object} [args.ethers]    ethers v6 module
 * @returns {string} 0x 32-byte commitment hash
 */
function computeCommitment(args) {
  const e = args.ethers || require("ethers");
  const { contentHash, committer, salt } = args;
  if (!contentHash) throw new Error("computeCommitment requires contentHash");
  if (!committer || !e.isAddress(committer)) {
    throw new Error(`computeCommitment requires a valid committer address, got: ${committer}`);
  }
  if (!salt) throw new Error("computeCommitment requires a salt");
  const encoded = e.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "address", "bytes32"],
    [contentHash, e.getAddress(committer), salt]
  );
  return e.keccak256(encoded);
}

/** Internal: validate + normalize the shared inputs both legs need. */
function _resolveContext(opts) {
  const ethersLib = opts.ethers || require("ethers");
  const { contractAddress } = opts;
  if (!contractAddress) {
    throw new Error(
      "no contract address: pass --contract <address> or set VH_CONTRACT in the environment"
    );
  }
  if (!ethersLib.isAddress(contractAddress)) {
    throw new Error(`invalid contract address: ${contractAddress}`);
  }
  return { ethersLib, to: ethersLib.getAddress(contractAddress) };
}

/**
 * Build (without sending) the `commit` transaction for a path. No network needed beyond knowing the
 * committer's address. Generates a salt if one is not supplied; the caller MUST persist the returned
 * salt (and contentHash + committer) to later reveal.
 *
 * @param {object} opts
 * @param {string}  opts.path             file/dir to claim
 * @param {string}  opts.committer        address that will commit & reveal
 * @param {string}  opts.contractAddress  ContributionRegistry address (tx `to`)
 * @param {string} [opts.salt]            reuse a salt (else a fresh random one is generated)
 * @param {object} [opts.ethers]          ethers v6 module
 * @returns {{
 *   to: string, data: string, value: string, functionName: "commit",
 *   contentHash: string, kind: "file"|"dir", path: string,
 *   committer: string, salt: string, commitment: string
 * }}
 */
function buildCommitTx(opts) {
  const { ethersLib, to } = _resolveContext(opts);
  const { path: targetPath, committer } = opts;
  if (!targetPath) throw new Error("claim requires a <path>");
  if (!committer || !ethersLib.isAddress(committer)) {
    throw new Error(`claim requires a valid committer address, got: ${committer}`);
  }

  const { contentHash, kind } = contentHashForPath(targetPath);
  if (/^0x0{64}$/i.test(contentHash)) {
    throw new Error("refusing to claim the zero hash (contract rejects it)");
  }

  const salt = opts.salt || newSalt(ethersLib);
  const committerAddr = ethersLib.getAddress(committer);
  const commitment = computeCommitment({
    contentHash,
    committer: committerAddr,
    salt,
    ethers: ethersLib,
  });

  const iface = new ethersLib.Interface(ABI);
  const data = iface.encodeFunctionData("commit", [commitment]);

  return {
    to,
    data,
    value: "0x0", // commit() is non-payable.
    functionName: "commit",
    contentHash,
    kind,
    path: targetPath,
    committer: committerAddr,
    salt,
    commitment,
  };
}

/**
 * Build (without sending) the `reveal` transaction. Requires the salt produced at commit time.
 *
 * @param {object} opts
 * @param {string}  opts.contentHash      the digest committed to
 * @param {string}  opts.salt             the secret salt used to build the commitment
 * @param {string} [opts.uri]             optional untrusted off-chain pointer hint
 * @param {string}  opts.contractAddress  ContributionRegistry address (tx `to`)
 * @param {object} [opts.ethers]          ethers v6 module
 * @returns {{ to: string, data: string, value: string, functionName: "reveal",
 *            contentHash: string, salt: string, uri: string }}
 */
function buildRevealTx(opts) {
  const { ethersLib, to } = _resolveContext(opts);
  const { contentHash, salt } = opts;
  if (!contentHash) throw new Error("reveal requires the committed contentHash");
  if (!salt) throw new Error("reveal requires the secret salt from the commit step");
  const uri = opts.uri == null ? "" : String(opts.uri);

  const iface = new ethersLib.Interface(ABI);
  const data = iface.encodeFunctionData("reveal", [contentHash, salt, uri]);

  return {
    to,
    data,
    value: "0x0", // reveal() is non-payable.
    functionName: "reveal",
    contentHash,
    salt,
    uri,
  };
}

/** Render the commit/reveal plan a `--dry-run` claim prints (no key, no network). */
function formatDryRun(commitTx) {
  return [
    "DRY RUN — no transaction will be sent (commit-reveal attribution).",
    "",
    `  path:         ${commitTx.path}  (${commitTx.kind})`,
    `  contentHash:  ${commitTx.contentHash}`,
    `  committer:    ${commitTx.committer}`,
    `  salt:         ${commitTx.salt}   <-- SECRET: keep this to reveal later`,
    `  commitment:   ${commitTx.commitment}`,
    "",
    "  Step 1 — commit() that WOULD be sent:",
    `    to:    ${commitTx.to}`,
    `    value: ${commitTx.value}`,
    `    data:  ${commitTx.data}`,
    "",
    "  Step 2 — after MIN_REVEAL_DELAY blocks, reveal(contentHash, salt, uri) is sent.",
    "  A mempool copier who lifts your reveal cannot win: their commitment (bound to THEIR",
    "  address) was never registered, so their reveal reverts. Attribution stays yours.",
    "",
  ].join("\n");
}

/**
 * Run the full commit-reveal claim end to end.
 *
 * In `--dry-run` mode it only builds the commitment + both txs and returns them (no key, no
 * network). Otherwise it: enforces the testnet guard, sends commit(), waits for it to mine and for
 * the MIN_REVEAL_DELAY window to pass, sends reveal(), and parses the Revealed event.
 *
 * @param {object} opts
 * @param {string}  opts.path
 * @param {string} [opts.uri]
 * @param {string}  opts.contractAddress
 * @param {boolean}[opts.dryRun]
 * @param {boolean}[opts.iUnderstandMainnet]
 * @param {object} [opts.signer]            ethers Signer (required unless dryRun)
 * @param {object} [opts.provider]          ethers Provider (chainId + block waits)
 * @param {bigint|number}[opts.chainId]     override chainId lookup (tests)
 * @param {string} [opts.salt]              reuse a salt (else random)
 * @param {object} [opts.ethers]
 * @param {(s:string)=>void}[opts.log]
 * @param {(target:bigint)=>Promise<void>}[opts.waitForBlock]  test hook to advance/await blocks
 * @returns {Promise<object>}
 */
async function runClaim(opts) {
  const ethersLib = opts.ethers || require("ethers");
  const log = opts.log || ((s) => process.stdout.write(s));

  // Resolve who the committer is. For a dry run we may not have a signer; allow an explicit
  // committer address so the plan can still be shown.
  let committer = opts.committer;
  if (!committer && opts.signer) {
    committer = await opts.signer.getAddress();
  }

  const commitTx = buildCommitTx({
    path: opts.path,
    committer,
    contractAddress: opts.contractAddress,
    salt: opts.salt,
    ethers: ethersLib,
  });

  if (opts.dryRun) {
    const revealTx = buildRevealTx({
      contentHash: commitTx.contentHash,
      salt: commitTx.salt,
      uri: opts.uri,
      contractAddress: opts.contractAddress,
      ethers: ethersLib,
    });
    log(formatDryRun(commitTx) + "\n");
    return { dryRun: true, commitTx, revealTx };
  }

  // Real submission from here on.
  if (!opts.signer) {
    throw new Error("no signer available to submit the claim (set PRIVATE_KEY?)");
  }
  const provider = opts.provider || opts.signer.provider;

  let chainId = opts.chainId;
  if (chainId == null && provider) {
    const net = await provider.getNetwork();
    chainId = net.chainId;
  }
  // Reuse the same testnet guard policy as anchor (imported lazily to avoid a cycle at load time).
  const { isTestnetChainId } = require("./anchor");
  if (chainId == null) {
    throw new Error("cannot determine chainId; refusing to submit without knowing the network");
  }
  if (!isTestnetChainId(chainId) && !opts.iUnderstandMainnet) {
    throw new Error(
      `refusing to claim on chainId ${BigInt(chainId).toString()} (not a known testnet). ` +
        "If you really mean to write to this chain, re-run with --i-understand-mainnet."
    );
  }

  const contract = new ethersLib.Contract(commitTx.to, ABI, opts.signer);

  // --- Step 1: commit ---
  log(`claim: committing ${commitTx.path} (${commitTx.kind}) as ${commitTx.committer}...\n`);
  const commitSent = await contract.commit(commitTx.commitment);
  log(`  commit tx: ${commitSent.hash}\n`);
  const commitReceipt = await commitSent.wait();
  const commitBlock = BigInt(commitReceipt.blockNumber);

  // --- Wait out MIN_REVEAL_DELAY ---
  const minDelay = BigInt(await contract.MIN_REVEAL_DELAY());
  const revealAfter = commitBlock + minDelay; // reveal requires current > commitBlock + minDelay
  if (opts.waitForBlock) {
    await opts.waitForBlock(revealAfter + 1n);
  } else if (provider) {
    // Poll until the chain advances past the window.
    // (On a live testnet this just waits for blocks to be produced.)
    /* eslint-disable no-await-in-loop */
    while (BigInt(await provider.getBlockNumber()) <= revealAfter) {
      await new Promise((r) => setTimeout(r, 1500));
    }
    /* eslint-enable no-await-in-loop */
  }

  // --- Step 2: reveal ---
  log(`claim: revealing ${commitTx.contentHash}...\n`);
  const revealSent = await contract.reveal(commitTx.contentHash, commitTx.salt, opts.uri == null ? "" : String(opts.uri));
  log(`  reveal tx: ${revealSent.hash}\n`);
  const revealReceipt = await revealSent.wait();

  // Parse the Revealed event.
  const iface = new ethersLib.Interface(ABI);
  let revealed = null;
  for (const lg of revealReceipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: lg.topics, data: lg.data });
      if (parsed && parsed.name === "Revealed") {
        revealed = {
          contentHash: parsed.args.contentHash,
          contributor: parsed.args.contributor,
          index: parsed.args.index,
          commitment: parsed.args.commitment,
          timestamp: parsed.args.timestamp,
          uri: parsed.args.uri,
        };
        break;
      }
    } catch (_) {
      /* not our event */
    }
  }

  if (revealed) {
    log(
      `  Claimed (authorBound) at index ${revealed.index} by ${revealed.contributor} ` +
        `in tx ${revealReceipt.hash}\n`
    );
  }

  return {
    dryRun: false,
    chainId: BigInt(chainId),
    commitTx,
    commitTxHash: commitReceipt.hash,
    revealTxHash: revealReceipt.hash,
    revealed,
  };
}

module.exports = {
  contentHashForPath,
  newSalt,
  computeCommitment,
  buildCommitTx,
  buildRevealTx,
  formatDryRun,
  runClaim,
  ABI,
};

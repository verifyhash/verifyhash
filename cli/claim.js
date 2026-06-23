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
const {
  buildReceipt,
  writeReceipt,
  readReceipt,
  defaultReceiptPath,
} = require("./receipt");

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
 * Resolve and guard the chain to submit to. Determines the chainId (from opts or the provider) and
 * enforces the same testnet guard policy as `anchor`: refuse a non-testnet chain unless the caller
 * explicitly passed `iUnderstandMainnet`.
 * @param {object} opts {chainId?, provider, iUnderstandMainnet?, verb?}
 * @returns {Promise<bigint>} the resolved chainId
 */
async function _resolveChainGuard(opts) {
  let chainId = opts.chainId;
  if (chainId == null && opts.provider) {
    const net = await opts.provider.getNetwork();
    chainId = net.chainId;
  }
  // Reuse the same testnet guard policy as anchor (imported lazily to avoid a cycle at load time).
  const { isTestnetChainId } = require("./anchor");
  if (chainId == null) {
    throw new Error("cannot determine chainId; refusing to submit without knowing the network");
  }
  if (!isTestnetChainId(chainId) && !opts.iUnderstandMainnet) {
    const verb = opts.verb || "claim";
    throw new Error(
      `refusing to ${verb} on chainId ${BigInt(chainId).toString()} (not a known testnet). ` +
        "If you really mean to write to this chain, re-run with --i-understand-mainnet."
    );
  }
  return BigInt(chainId);
}

/**
 * Wait until the chain has advanced past the MIN_REVEAL_DELAY window for a commit that mined in
 * `commitBlock`. A reveal requires `current > commitBlock + minDelay`, so we wait for
 * `commitBlock + minDelay + 1`.
 * @param {object} args {provider, commitBlock: bigint, minDelay: bigint, waitForBlock?}
 */
async function _waitRevealWindow(args) {
  const { provider, commitBlock, minDelay } = args;
  const revealAfter = commitBlock + minDelay;
  if (args.waitForBlock) {
    await args.waitForBlock(revealAfter + 1n);
  } else if (provider) {
    // Poll until the chain advances past the window. (On a live testnet this just waits for blocks
    // to be produced.)
    /* eslint-disable no-await-in-loop */
    while (BigInt(await provider.getBlockNumber()) <= revealAfter) {
      await new Promise((r) => setTimeout(r, 1500));
    }
    /* eslint-enable no-await-in-loop */
  }
}

/** Parse the first `Revealed` event out of a transaction receipt's logs, or return null. */
function _parseRevealed(receipt, ethersLib) {
  const iface = new ethersLib.Interface(ABI);
  for (const lg of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: lg.topics, data: lg.data });
      if (parsed && parsed.name === "Revealed") {
        return {
          contentHash: parsed.args.contentHash,
          contributor: parsed.args.contributor,
          index: parsed.args.index,
          commitment: parsed.args.commitment,
          timestamp: parsed.args.timestamp,
          uri: parsed.args.uri,
        };
      }
    } catch (_) {
      /* not our event */
    }
  }
  return null;
}

/**
 * Run ONLY the commit leg of a resumable claim, persisting a durable receipt BEFORE it returns.
 *
 * This is the safe, restartable half of commit-reveal: it sends `commit()`, waits for it to mine,
 * reads MIN_REVEAL_DELAY, then writes the receipt (salt + commitment + everything `reveal()` needs)
 * to disk so a separate `runReveal` process can finish the claim even after a crash/restart.
 *
 * @param {object} opts
 * @param {string}  opts.path
 * @param {string} [opts.uri]
 * @param {string}  opts.contractAddress
 * @param {string} [opts.receiptPath]       where to write the receipt (default ./<prefix>.vhclaim.json)
 * @param {boolean}[opts.iUnderstandMainnet]
 * @param {object}  opts.signer             ethers Signer
 * @param {object} [opts.provider]
 * @param {bigint|number}[opts.chainId]
 * @param {string} [opts.salt]              reuse a salt (else random)
 * @param {object} [opts.ethers]
 * @param {(s:string)=>void}[opts.log]
 * @returns {Promise<{commitTx, commitTxHash, commitBlockNumber, minRevealDelay, chainId, receiptPath, receipt}>}
 */
async function runCommit(opts) {
  const ethersLib = opts.ethers || require("ethers");
  const log = opts.log || ((s) => process.stdout.write(s));

  if (!opts.signer) {
    throw new Error("no signer available to submit the commit (set PRIVATE_KEY?)");
  }

  let committer = opts.committer;
  if (!committer) committer = await opts.signer.getAddress();

  const commitTx = buildCommitTx({
    path: opts.path,
    committer,
    contractAddress: opts.contractAddress,
    salt: opts.salt,
    ethers: ethersLib,
  });

  const provider = opts.provider || opts.signer.provider;
  const chainId = await _resolveChainGuard({
    chainId: opts.chainId,
    provider,
    iUnderstandMainnet: opts.iUnderstandMainnet,
    verb: "commit",
  });

  const contract = new ethersLib.Contract(commitTx.to, ABI, opts.signer);

  log(`commit: committing ${commitTx.path} (${commitTx.kind}) as ${commitTx.committer}...\n`);
  const commitSent = await contract.commit(commitTx.commitment);
  log(`  commit tx: ${commitSent.hash}\n`);
  const commitReceiptTx = await commitSent.wait();
  const commitBlock = BigInt(commitReceiptTx.blockNumber);
  const minDelay = BigInt(await contract.MIN_REVEAL_DELAY());

  // Persist the receipt BEFORE returning/waiting, so the salt survives a crash from here on.
  const receiptPath = opts.receiptPath || defaultReceiptPath(commitTx.contentHash);
  const receipt = buildReceipt({
    contentHash: commitTx.contentHash,
    committer: commitTx.committer,
    salt: commitTx.salt,
    commitment: commitTx.commitment,
    contractAddress: commitTx.to,
    chainId,
    uri: opts.uri,
    path: commitTx.path,
    kind: commitTx.kind,
    commitTxHash: commitReceiptTx.hash,
    commitBlockNumber: commitBlock,
    minRevealDelay: minDelay,
  });
  writeReceipt(receipt, receiptPath);
  log(`  receipt written: ${receiptPath} (resume with: vh reveal --receipt ${receiptPath})\n`);

  return {
    commitTx,
    commitTxHash: commitReceiptTx.hash,
    commitBlockNumber: commitBlock,
    minRevealDelay: minDelay,
    chainId,
    receiptPath,
    receipt,
  };
}

/**
 * Resume a claim from a persisted receipt and submit the `reveal()` leg once the MIN_REVEAL_DELAY
 * window has matured. Loads the salt/commitment/uri from the receipt — it needs NO information that
 * wasn't durably written at commit time, so it works from a completely fresh process.
 *
 * If the window has not yet matured the contract reverts with `RevealTooSoon`; this function lets
 * that error propagate and leaves the receipt file untouched so the user can simply retry later.
 *
 * @param {object} opts
 * @param {string}  opts.receiptPath        the receipt written by runCommit
 * @param {object}  opts.signer             ethers Signer (must be the original committer)
 * @param {object} [opts.provider]
 * @param {bigint|number}[opts.chainId]
 * @param {boolean}[opts.iUnderstandMainnet]
 * @param {object} [opts.ethers]
 * @param {(s:string)=>void}[opts.log]
 * @param {(target:bigint)=>Promise<void>}[opts.waitForBlock] test hook to advance/await blocks
 * @param {boolean}[opts.noWait]            skip the maturation wait (let the contract enforce it)
 * @returns {Promise<{revealed, revealTxHash, chainId, receiptPath, receipt}>}
 */
async function runReveal(opts) {
  const ethersLib = opts.ethers || require("ethers");
  const log = opts.log || ((s) => process.stdout.write(s));

  if (!opts.receiptPath) throw new Error("runReveal requires a receiptPath");
  if (!opts.signer) {
    throw new Error("no signer available to submit the reveal (set PRIVATE_KEY?)");
  }

  // Strict read: a corrupt/partial receipt throws here rather than producing a wrong reveal.
  const receipt = readReceipt(opts.receiptPath);

  const provider = opts.provider || opts.signer.provider;
  const chainId = await _resolveChainGuard({
    chainId: opts.chainId,
    provider,
    iUnderstandMainnet: opts.iUnderstandMainnet,
    verb: "reveal",
  });

  // Sanity check: the signer must be the address bound into the commitment, else reveal would hit
  // NoSuchCommitment. Fail fast with a clear message instead.
  const signerAddr = ethersLib.getAddress(await opts.signer.getAddress());
  if (ethersLib.getAddress(receipt.committer) !== signerAddr) {
    throw new Error(
      `signer ${signerAddr} is not the committer ${receipt.committer} bound in this receipt; ` +
        "only the original committer can reveal it."
    );
  }

  const contract = new ethersLib.Contract(receipt.contractAddress, ABI, opts.signer);

  // Wait out MIN_REVEAL_DELAY when we know the commit block (unless the caller opts out / handles it).
  if (!opts.noWait && receipt.commitBlockNumber != null) {
    const minDelay =
      receipt.minRevealDelay != null
        ? BigInt(receipt.minRevealDelay)
        : BigInt(await contract.MIN_REVEAL_DELAY());
    await _waitRevealWindow({
      provider,
      commitBlock: BigInt(receipt.commitBlockNumber),
      minDelay,
      waitForBlock: opts.waitForBlock,
    });
  }

  log(`reveal: revealing ${receipt.contentHash} as ${receipt.committer}...\n`);
  const revealSent = await contract.reveal(receipt.contentHash, receipt.salt, receipt.uri || "");
  log(`  reveal tx: ${revealSent.hash}\n`);
  const revealReceiptTx = await revealSent.wait();

  const revealed = _parseRevealed(revealReceiptTx, ethersLib);
  if (revealed) {
    log(
      `  Claimed (authorBound) at index ${revealed.index} by ${revealed.contributor} ` +
        `in tx ${revealReceiptTx.hash}\n`
    );
  }

  return {
    revealed,
    revealTxHash: revealReceiptTx.hash,
    chainId,
    receiptPath: opts.receiptPath,
    receipt,
  };
}

/**
 * Run the full commit-reveal claim end to end (the one-shot convenience, both legs in one process).
 *
 * In `--dry-run` mode it only builds the commitment + both txs and returns them (no key, no
 * network). Otherwise it: enforces the testnet guard, sends commit(), persists a durable receipt,
 * waits for the MIN_REVEAL_DELAY window to pass, sends reveal(), and parses the Revealed event.
 *
 * The legacy single-process behaviour (used by the existing e2e test) is preserved exactly; the
 * only addition is that a receipt is also written at commit time (so even the one-shot path is
 * crash-recoverable). Pass `writeReceiptFile: false` to opt out.
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
 * @param {string} [opts.receiptPath]       where to write the receipt (default ./<prefix>.vhclaim.json)
 * @param {boolean}[opts.writeReceiptFile]  set false to skip writing the receipt (default true)
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

  const chainId = await _resolveChainGuard({
    chainId: opts.chainId,
    provider,
    iUnderstandMainnet: opts.iUnderstandMainnet,
    verb: "claim",
  });

  const contract = new ethersLib.Contract(commitTx.to, ABI, opts.signer);

  // --- Step 1: commit ---
  log(`claim: committing ${commitTx.path} (${commitTx.kind}) as ${commitTx.committer}...\n`);
  const commitSent = await contract.commit(commitTx.commitment);
  log(`  commit tx: ${commitSent.hash}\n`);
  const commitReceipt = await commitSent.wait();
  const commitBlock = BigInt(commitReceipt.blockNumber);
  const minDelay = BigInt(await contract.MIN_REVEAL_DELAY());

  // Persist a durable receipt so even this one-shot path is crash-recoverable: if the process dies
  // during the wait, the salt is on disk and `vh reveal` can finish the claim.
  let receiptPath;
  if (opts.writeReceiptFile !== false) {
    receiptPath = opts.receiptPath || defaultReceiptPath(commitTx.contentHash);
    const receipt = buildReceipt({
      contentHash: commitTx.contentHash,
      committer: commitTx.committer,
      salt: commitTx.salt,
      commitment: commitTx.commitment,
      contractAddress: commitTx.to,
      chainId,
      uri: opts.uri,
      path: commitTx.path,
      kind: commitTx.kind,
      commitTxHash: commitReceipt.hash,
      commitBlockNumber: commitBlock,
      minRevealDelay: minDelay,
    });
    writeReceipt(receipt, receiptPath);
    log(`  receipt written: ${receiptPath}\n`);
  }

  // --- Wait out MIN_REVEAL_DELAY ---
  await _waitRevealWindow({
    provider,
    commitBlock,
    minDelay,
    waitForBlock: opts.waitForBlock,
  });

  // --- Step 2: reveal ---
  log(`claim: revealing ${commitTx.contentHash}...\n`);
  const revealSent = await contract.reveal(commitTx.contentHash, commitTx.salt, opts.uri == null ? "" : String(opts.uri));
  log(`  reveal tx: ${revealSent.hash}\n`);
  const revealReceipt = await revealSent.wait();

  const revealed = _parseRevealed(revealReceipt, ethersLib);
  if (revealed) {
    log(
      `  Claimed (authorBound) at index ${revealed.index} by ${revealed.contributor} ` +
        `in tx ${revealReceipt.hash}\n`
    );
  }

  return {
    dryRun: false,
    chainId,
    commitTx,
    commitTxHash: commitReceipt.hash,
    revealTxHash: revealReceipt.hash,
    revealed,
    receiptPath,
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
  runCommit,
  runReveal,
  ABI,
};

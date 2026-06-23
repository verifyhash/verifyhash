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

const path = require("path");
const { hashPath, hashGit } = require("./hash");
const {
  buildReceipt,
  writeReceipt,
  readReceipt,
  defaultReceiptPath,
} = require("./receipt");

/**
 * Resolve where a receipt file should be written from the caller's explicit choices, returning an
 * ABSOLUTE path so the success line can name the exact file the user can see/relocate/delete.
 *
 * Precedence (all caller-opted-in; none of them silently default to cwd without telling the user):
 *   1. `receiptPath` — an explicit full path (from `--receipt <path>`): used verbatim (resolved to
 *      absolute). The caller picked the exact file.
 *   2. `receiptDir` + `contentHash` — an explicit destination directory (from `--receipt-dir <dir>`):
 *      `<dir>/<defaultName>`. The caller picked the folder; we pick the tidy default file name.
 *   3. `contentHash` only — the documented default: `<baseDir>/<defaultName>` where `baseDir`
 *      defaults to `process.cwd()`. This is only reached for the DURABLE `vh commit` command, which
 *      MUST then print the exact resolved path (see runCommit) — never a silent cwd drop.
 *
 * @param {object} args
 * @param {string} [args.receiptPath] explicit full path
 * @param {string} [args.receiptDir]  explicit destination directory
 * @param {string} [args.contentHash] 0x digest, used to derive the default file name
 * @param {string} [args.baseDir]     base for the bare default (defaults to process.cwd())
 * @returns {string} an ABSOLUTE receipt path
 */
function resolveReceiptPath(args) {
  if (args.receiptPath) return path.resolve(args.receiptPath);
  const name = path.basename(defaultReceiptPath(args.contentHash)); // "<prefix>.vhclaim.json"
  const base = args.receiptDir ? args.receiptDir : args.baseDir || process.cwd();
  return path.resolve(base, name);
}

const ARTIFACT = require("../artifacts/contracts/ContributionRegistry.sol/ContributionRegistry.json");
const ABI = ARTIFACT.abi;

/**
 * Compute the content hash to claim for a filesystem path (same convention as `vh anchor`):
 * a file claims its keccak256 digest, a directory its sorted-leaf Merkle root. For a directory the
 * per-file manifest (sorted `{ path, contentHash, leaf }`) is returned too, so the claim/commit
 * receipt records it (letting a later `vh verify --receipt` localize a tamper).
 *
 * With `opts.git`, the root and manifest are computed over EXACTLY the files git tracks at `opts.ref`
 * (default HEAD) — the same reproducible `vh hash --git` enumeration (T-8.1) — and a `git` provenance
 * block `{ commit, scope }` is returned so the claim/commit receipt records the resolved commit oid
 * and the repo-relative scope used to enumerate the tracked set (an UNTRUSTED convenience hint).
 *
 * @param {string} targetPath
 * @param {{ git?: boolean, ref?: string }} [opts]
 * @returns {{ contentHash: string, kind: "file"|"dir",
 *            manifest: Array<{path:string,contentHash:string,leaf:string}>|null,
 *            git: {commit:string,scope:string}|null }}
 */
function contentHashForPath(targetPath, opts = {}) {
  if (opts.git) {
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
 * @param {boolean}[opts.git]             hash EXACTLY the git-tracked files (T-8.1 enumeration)
 * @param {string} [opts.ref]             with git: which commit's tracked set (default HEAD)
 * @param {string}  opts.contractAddress  ContributionRegistry address (tx `to`)
 * @param {string} [opts.salt]            reuse a salt (else a fresh random one is generated)
 * @param {object} [opts.ethers]          ethers v6 module
 * @returns {{
 *   to: string, data: string, value: string, functionName: "commit",
 *   contentHash: string, kind: "file"|"dir", path: string,
 *   manifest: Array|null, git: {commit:string,scope:string}|null,
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

  const { contentHash, kind, manifest, git } = contentHashForPath(targetPath, {
    git: opts.git,
    ref: opts.ref,
  });
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
    manifest, // per-file manifest for a dir target (null for a file); recorded into the receipt
    git, // { commit, scope } when --git was used; null otherwise. Recorded into the receipt.
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
 * @param {string} [opts.parent]          optional predecessor contentHash (T-10.1 lineage edge);
 *                                        non-zero routes to revealWithParent() and records the edge
 * @param {string}  opts.contractAddress  ContributionRegistry address (tx `to`)
 * @param {object} [opts.ethers]          ethers v6 module
 * @returns {{ to: string, data: string, value: string,
 *            functionName: "reveal"|"revealWithParent",
 *            contentHash: string, salt: string, uri: string, parent: string|null }}
 */
function buildRevealTx(opts) {
  const { ethersLib, to } = _resolveContext(opts);
  const { contentHash, salt } = opts;
  if (!contentHash) throw new Error("reveal requires the committed contentHash");
  if (!salt) throw new Error("reveal requires the secret salt from the commit step");
  const uri = opts.uri == null ? "" : String(opts.uri);

  // Resolve the optional lineage edge (same convention/validation as `vh anchor --parent`): a
  // missing/zero parent is a root via the legacy reveal(); a non-zero 32-byte hash routes to
  // revealWithParent(). Self-reference is rejected here; the contract enforces UnknownParent/SelfParent.
  const { normalizeParent } = require("./anchor");
  const parent = normalizeParent(opts.parent, ethersLib);
  if (parent !== null && parent.toLowerCase() === contentHash.toLowerCase()) {
    throw new Error(
      "refusing to reveal a record as its own parent (self-reference; the contract rejects it as SelfParent)"
    );
  }

  const iface = new ethersLib.Interface(ABI);
  const functionName = parent === null ? "reveal" : "revealWithParent";
  const data =
    parent === null
      ? iface.encodeFunctionData("reveal", [contentHash, salt, uri])
      : iface.encodeFunctionData("revealWithParent", [contentHash, salt, uri, parent]);

  return {
    to,
    data,
    value: "0x0", // reveal()/revealWithParent() are non-payable.
    functionName,
    contentHash,
    salt,
    uri,
    parent, // null for a lineage root; the predecessor hash when --parent was given.
  };
}

/** Render the commit/reveal plan a `--dry-run` claim prints (no key, no network). */
function formatDryRun(commitTx) {
  const lines = [
    "DRY RUN — no transaction will be sent (commit-reveal attribution).",
    "",
    `  path:         ${commitTx.path}  (${commitTx.kind})`,
    `  contentHash:  ${commitTx.contentHash}`,
    `  committer:    ${commitTx.committer}`,
    `  salt:         ${commitTx.salt}   <-- SECRET: keep this to reveal later`,
    `  commitment:   ${commitTx.commitment}`,
  ];
  if (commitTx.git) {
    lines.push(
      `  git commit:   ${commitTx.git.commit}  (untrusted provenance hint)`,
      `  git scope:    ${commitTx.git.scope}`
    );
  }
  lines.push(
    "",
    "  Step 1 — commit() that WOULD be sent:",
    `    to:    ${commitTx.to}`,
    `    value: ${commitTx.value}`,
    `    data:  ${commitTx.data}`,
    "",
    "  Step 2 — after MIN_REVEAL_DELAY blocks, reveal(contentHash, salt, uri) is sent.",
    "  A mempool copier who lifts your reveal cannot win: their commitment (bound to THEIR",
    "  address) was never registered, so their reveal reverts. Attribution stays yours.",
    ""
  );
  return lines.join("\n");
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
 * @param {boolean}[opts.git]               hash EXACTLY the git-tracked files (T-8.1 enumeration)
 * @param {string} [opts.ref]               with git: which commit's tracked set (default HEAD)
 * @param {string}  opts.contractAddress
 * @param {string} [opts.receiptPath]       explicit full path to write the receipt to (--receipt)
 * @param {string} [opts.receiptDir]        explicit destination DIRECTORY (--receipt-dir); the tidy
 *                                          default file name is used inside it
 * @param {string} [opts.baseDir]           base dir for the bare default name (default process.cwd())
 * @param {boolean}[opts.iUnderstandMainnet]
 * @param {object}  opts.signer             ethers Signer
 * @param {object} [opts.provider]
 * @param {bigint|number}[opts.chainId]
 * @param {string} [opts.salt]              reuse a salt (else random)
 * @param {object} [opts.ethers]
 * @param {(s:string)=>void}[opts.log]
 * @returns {Promise<{commitTx, commitTxHash, commitBlockNumber, minRevealDelay, chainId, receiptPath, receipt}>}
 *
 * The receipt path is resolved to an ABSOLUTE path (see resolveReceiptPath) and the EXACT file is
 * named in the success log so the user can always see/relocate/delete the secret-bearing receipt.
 * When no `--receipt`/`--receipt-dir` is given the default lands in `baseDir` (cwd) — but only ever
 * after the success line names that exact resolved file, so it is never a silent secret drop.
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
    git: opts.git,
    ref: opts.ref,
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
  // Resolve to an ABSOLUTE path from the caller's explicit choices; we name it exactly below so the
  // secret-bearing file is never silently dropped somewhere the user can't find.
  const receiptPath = resolveReceiptPath({
    receiptPath: opts.receiptPath,
    receiptDir: opts.receiptDir,
    baseDir: opts.baseDir,
    contentHash: commitTx.contentHash,
  });
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
    manifest: commitTx.manifest || undefined,
    git: commitTx.git || undefined, // untrusted provenance hint: { commit, scope } when --git
    commitTxHash: commitReceiptTx.hash,
    commitBlockNumber: commitBlock,
    minRevealDelay: minDelay,
  });
  writeReceipt(receipt, receiptPath);
  log(
    `  receipt written: ${receiptPath}\n` +
      `  KEEP THIS PRIVATE — it holds the secret salt. Resume with: vh reveal --receipt ${receiptPath}\n`
  );

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
 * RECEIPT POLICY (T-9.1). This one-shot helper NEVER silently drops a secret-bearing receipt into
 * the current working directory. A claim receipt holds the secret `salt`, so persisting it is OPT-IN:
 *   - if an explicit `receiptPath` (or `receiptDir`) is given (and `writeReceiptFile !== false`), the
 *     receipt is written and the exact resolved file is named in the success log;
 *   - if NEITHER is given, NOTHING is written — the validated receipt object is returned in-memory on
 *     the result as `receipt` (and `receiptPath` stays undefined). The caller that wants a durable,
 *     resumable artifact should use `runCommit`/`vh commit` (the intended durable command, which
 *     resolves a documented default path), or pass an explicit `receiptPath`/`receiptDir` here.
 * `writeReceiptFile: false` still hard-disables the write even when a destination is present.
 *
 * @param {object} opts
 * @param {string}  opts.path
 * @param {string} [opts.uri]
 * @param {string} [opts.parent]            optional predecessor contentHash (T-10.1 lineage edge);
 *                                          non-zero routes the reveal leg to revealWithParent()
 * @param {boolean}[opts.git]               hash EXACTLY the git-tracked files (T-8.1 enumeration)
 * @param {string} [opts.ref]               with git: which commit's tracked set (default HEAD)
 * @param {string}  opts.contractAddress
 * @param {boolean}[opts.dryRun]
 * @param {boolean}[opts.iUnderstandMainnet]
 * @param {object} [opts.signer]            ethers Signer (required unless dryRun)
 * @param {object} [opts.provider]          ethers Provider (chainId + block waits)
 * @param {bigint|number}[opts.chainId]     override chainId lookup (tests)
 * @param {string} [opts.salt]              reuse a salt (else random)
 * @param {string} [opts.receiptPath]       explicit full path to persist the receipt (else nothing)
 * @param {string} [opts.receiptDir]        explicit destination DIR to persist the receipt into (else nothing)
 * @param {boolean}[opts.writeReceiptFile]  set false to hard-disable the write even with a destination
 * @param {object} [opts.ethers]
 * @param {(s:string)=>void}[opts.log]
 * @param {(target:bigint)=>Promise<void>}[opts.waitForBlock]  test hook to advance/await blocks
 * @returns {Promise<object>}  includes `receipt` (the in-memory receipt object) and `receiptPath`
 *                             (the file written, or undefined when none was)
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
    git: opts.git,
    ref: opts.ref,
    contractAddress: opts.contractAddress,
    salt: opts.salt,
    ethers: ethersLib,
  });

  if (opts.dryRun) {
    const revealTx = buildRevealTx({
      contentHash: commitTx.contentHash,
      salt: commitTx.salt,
      uri: opts.uri,
      parent: opts.parent,
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

  // Build the validated receipt object in memory regardless — it is always returned so a caller can
  // persist it itself. We PERSIST it to disk only when the caller explicitly opted in with a
  // `receiptPath` (and did not set writeReceiptFile:false). A claim receipt holds the secret salt, so
  // this one-shot convenience never silently drops it into cwd; for a durable, resumable artifact use
  // `runCommit`/`vh commit` (which resolves a documented default path and names the exact file).
  let receiptPath;
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
    manifest: commitTx.manifest || undefined,
    git: commitTx.git || undefined, // untrusted provenance hint: { commit, scope } when --git
    commitTxHash: commitReceipt.hash,
    commitBlockNumber: commitBlock,
    minRevealDelay: minDelay,
  });
  const persistOptIn = opts.receiptPath != null || opts.receiptDir != null;
  if (opts.writeReceiptFile !== false && persistOptIn) {
    receiptPath = resolveReceiptPath({
      receiptPath: opts.receiptPath,
      receiptDir: opts.receiptDir,
      contentHash: commitTx.contentHash,
    });
    writeReceipt(receipt, receiptPath);
    log(
      `  receipt written: ${receiptPath}\n` +
        `  KEEP THIS PRIVATE — it holds the secret salt.\n`
    );
  } else if (opts.writeReceiptFile !== false) {
    // No explicit destination: do NOT silently write a secret receipt to cwd. Tell the user how to
    // persist one if they want a resumable artifact.
    log(
      "  (no --receipt given: not persisting a claim receipt. " +
        "Pass --receipt <path> to persist a resumable receipt, or use `vh commit`.)\n"
    );
  }

  // --- Wait out MIN_REVEAL_DELAY ---
  await _waitRevealWindow({
    provider,
    commitBlock,
    minDelay,
    waitForBlock: opts.waitForBlock,
  });

  // --- Step 2: reveal ---
  // Route to revealWithParent() iff a non-zero predecessor was given (T-10.1); otherwise the legacy
  // reveal(), byte-for-byte unchanged. Reuse the same parent normalization/self-ref guard as anchor.
  const { normalizeParent } = require("./anchor");
  const parent = normalizeParent(opts.parent, ethersLib);
  if (parent !== null && parent.toLowerCase() === commitTx.contentHash.toLowerCase()) {
    throw new Error(
      "refusing to reveal a record as its own parent (self-reference; the contract rejects it as SelfParent)"
    );
  }
  const lineageNote = parent == null ? "" : ` with parent ${parent}`;
  log(`claim: revealing ${commitTx.contentHash}${lineageNote}...\n`);
  const revealUri = opts.uri == null ? "" : String(opts.uri);
  const revealSent =
    parent == null
      ? await contract.reveal(commitTx.contentHash, commitTx.salt, revealUri)
      : await contract.revealWithParent(commitTx.contentHash, commitTx.salt, revealUri, parent);
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
    receiptPath, // undefined when no receipt file was written (the default, safe behaviour)
    receipt, // the validated receipt object, always returned in-memory for the caller to persist
  };
}

module.exports = {
  contentHashForPath,
  newSalt,
  computeCommitment,
  buildCommitTx,
  buildRevealTx,
  formatDryRun,
  resolveReceiptPath,
  runClaim,
  runCommit,
  runReveal,
  ABI,
};

#!/usr/bin/env node
"use strict";

// verifyhash CLI entrypoint.
//
// Implemented commands:
//   vh hash <path>             Print the keccak256 of a file, or the sorted-leaf Merkle root of a
//                              directory (matching ContributionRegistry.verifyLeaf).
//   vh anchor <path> [opts]    Submit a file/dir's content hash on-chain via anchor().
//   vh verify <path> [opts]    Recompute a file/dir's hash, read it back from the registry, and
//                              report MATCH / MISMATCH (a one-byte edit flips it to MISMATCH).
//   vh prove <file> [opts]     Prove a single file belongs to an anchored repo root: build its
//                              Merkle proof and have the on-chain verifyLeaf accept/reject it.

const { hashPath, hashGit } = require("./hash");
const { runAnchor } = require("./anchor");
const { runVerify } = require("./verify");
const { runProve } = require("./prove");
const { runVerifyProof } = require("./proof");
const { runClaim, runCommit, runReveal } = require("./claim");
const { runList } = require("./list");
const { runShow } = require("./show");

function usage() {
  return [
    "vh — verifyhash CLI",
    "",
    "Usage:",
    "  vh hash <path> [--git]     keccak256 of a file, or sorted-leaf Merkle root of a directory",
    "                             (--git [--ref <ref>]: hash ONLY the files git tracks at that commit)",
    "  vh anchor <path> [opts]    anchor a file/dir's content hash on-chain (FRONT-RUNNABLE)",
    "  vh claim <path> [opts]     front-running-resistant attribution via commit-reveal (one-shot)",
    "  vh commit <path> [opts]    commit-reveal step 1: commit + write a resumable claim receipt",
    "  vh reveal --receipt <p>    commit-reveal step 2: resume from a receipt and reveal",
    "  vh verify <path> [opts]    recompute the hash, read the registry, print MATCH / MISMATCH",
    "  vh prove <file> [opts]     Merkle-prove a file against an anchored repo root via verifyLeaf",
    "  vh verify-proof <p> [opts] independently verify a portable proof artifact (offline + on-chain)",
    "  vh list [opts]             enumerate the registry read-only (discovery + audit)",
    "  vh show <0xhash> [opts]    look up ONE record by content hash (no local content needed)",
    "",
    "hash options:",
    "  --git                      hash EXACTLY the files git tracks (ignores untracked junk like",
    "                             node_modules/, .env, build artifacts); <path> must be in a git repo",
    "  --ref <ref>                with --git: which commit's tracked set to hash (default HEAD)",
    "",
    "anchor options (one-shot; contributor = 'first anchorer', NOT proven authorship):",
    "  --uri <uri>                optional off-chain pointer stored with the hash (IPFS CID, URL)",
    "  --parent <0xhash>          record an immutable predecessor edge to an ALREADY-anchored hash",
    "                             (the lineage graph). Routes to anchorWithParent(); the parent must",
    "                             already exist or the tx reverts UnknownParent. Omit it for a root.",
    "                             A `parent` is only a CLAIMED predecessor: it proves neither content",
    "                             ancestry nor any transfer of the parent's authorship.",
    "  --git                      anchor EXACTLY the files git tracks (ignores untracked junk); records",
    "                             a `git` provenance hint (commit oid + scope) in the receipt",
    "  --ref <ref>                with --git: which commit's tracked set to anchor (default HEAD)",
    "  --receipt <path>           write an anchor receipt here (records a dir's per-file manifest",
    "                             so `vh verify <dir> --receipt <p>` can localize WHICH file changed)",
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --dry-run                  print the tx that would be sent; needs no key, sends nothing",
    "  --i-understand-mainnet     allow anchoring on a non-testnet chainId (DANGER: real funds)",
    "",
    "claim options (commit-reveal one-shot; contributor = proven first claimant, authorBound = true):",
    "  --uri <uri>                optional off-chain pointer stored with the hash (IPFS CID, URL)",
    "  --parent <0xhash>          record an immutable predecessor edge to an ALREADY-anchored hash",
    "                             (routes the reveal leg to revealWithParent(); the parent must already",
    "                             exist or it reverts UnknownParent). Only on the one-shot `vh claim`;",
    "                             `vh commit`/`vh reveal` do not carry it yet (BACKLOG B-10.1).",
    "  --git                      claim EXACTLY the files git tracks (records a `git` provenance hint)",
    "  --ref <ref>                with --git: which commit's tracked set to claim (default HEAD)",
    "  --salt <0xhex>             reuse a 32-byte salt (default: a fresh random one)",
    "  --receipt <path>           persist a resumable claim receipt at this exact path (holds the SECRET",
    "                             salt). WITHOUT it the one-shot claim persists NOTHING — use `vh commit`",
    "                             for a durable, resumable receipt.",
    "  --receipt-dir <dir>        persist the receipt into this directory under its default file name",
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --dry-run                  print the commit+reveal plan; needs no key, sends nothing",
    "  --i-understand-mainnet     allow claiming on a non-testnet chainId (DANGER: real funds)",
    "",
    "commit options (step 1 of a resumable claim; writes a receipt, then commits):",
    "  --uri <uri>                pointer recorded at reveal time (kept in the receipt until then)",
    "  --git                      commit EXACTLY the files git tracks (records a `git` provenance hint)",
    "  --ref <ref>                with --git: which commit's tracked set to commit (default HEAD)",
    "  --salt <0xhex>             reuse a 32-byte salt (default: a fresh random one)",
    "  --receipt <path>           write the claim receipt (holds the SECRET salt) at this exact path;",
    "                             default <cwd>/<hashPrefix>.vhclaim.json — the EXACT file written is",
    "                             always named in the success output so you can see/relocate/delete it",
    "  --receipt-dir <dir>        write the receipt into this directory under its default file name",
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --i-understand-mainnet     allow committing on a non-testnet chainId (DANGER: real funds)",
    "",
    "reveal options (step 2; resumes a prior commit from its receipt and reveals):",
    "  --receipt <path>           REQUIRED: the receipt file written by `vh commit`",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --i-understand-mainnet     allow revealing on a non-testnet chainId (DANGER: real funds)",
    "",
    "verify options:",
    "  --git                      recompute the root over EXACTLY the files git tracks (ignores",
    "                             untracked junk); reproducible end-to-end against a fresh checkout",
    "  --ref <ref>                with --git: which commit's tracked set to verify (default HEAD)",
    "  --receipt <path>           UNTRUSTED hint: diff a dir against this receipt's manifest and print",
    "                             ADDED/REMOVED/CHANGED per file (verdict still = root vs on-chain)",
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "",
    "prove options:",
    "  --root <dir>               the repo root directory whose Merkle root <file> is proven against",
    "  --out <path>               write a self-contained, portable proof artifact here (works on the",
    "                             no-key --dry-run/build path); verify it later with `vh verify-proof`",
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --anchor                   anchor the repo root first (needs PRIVATE_KEY), then prove",
    "  --i-understand-mainnet     allow --anchor on a non-testnet chainId (DANGER: real funds)",
    "  --dry-run                  build & print the proof only; needs no key and no network",
    "",
    "verify-proof options (read-only, NO key; needs only the artifact + an RPC URL — no repo):",
    "  <p>                        path to a proof artifact written by `vh prove --out <p>`",
    "  --contract <address>       ContributionRegistry address (or the artifact's recorded address)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --json                     emit a machine-readable JSON object instead of the human block",
    "  Re-derives the leaf + re-folds the proof OFFLINE, then confirms the root is anchored on-chain.",
    "  Prints ACCEPTED only when the offline fold AND the on-chain checks all pass; else REJECTED /",
    "  NOT ANCHORED (non-zero exit). Proves SET-MEMBERSHIP in an anchored root, not authorship/uri.",
    "",
    "list options (read-only enumeration; provider only, never a signer/key):",
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --contributor <address>    only records whose contributor is this address",
    "  --author-bound             only commit-reveal records (authorBound = proven first claimant)",
    "  --limit <n>                show at most n records (after --offset)",
    "  --offset <n>               skip the first n (filtered) records",
    "  --json                     emit a machine-readable JSON array instead of the human block",
    "",
    "show options (read-only lookup by hash; provider only, never a signer/key):",
    "  <0xhash>                   a 32-byte (0x + 64 hex) content hash, e.g. from `vh list`",
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --json                     emit a machine-readable JSON object instead of the human block",
    "  NOTE: `show` proves only that the hash is on-chain; it does NOT re-derive content. To bind a",
    "        record to real bytes you must still run `vh verify <path>`. Exits non-zero if NOT ANCHORED.",
    "",
  ].join("\n");
}

/**
 * Parse `hash` argv into { path, git, ref }. Takes exactly one positional <path>. `--git` scopes the
 * hash to git-tracked files; `--ref <ref>` selects which commit's tracked set (only with `--git`).
 * Throws on unknown/incomplete flags, a duplicate path, or `--ref` without `--git` (parser parity
 * with the other commands) so a typo never silently changes what gets hashed.
 */
function parseHashArgs(argv) {
  const opts = { path: undefined, git: false, ref: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--git":
        opts.git = true;
        break;
      case "--ref":
        opts.ref = argv[++i];
        if (opts.ref === undefined) throw new Error("--ref requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.path !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.path = a;
    }
  }
  // --ref is meaningful only when scoping to git-tracked files; flag it rather than silently ignore.
  if (opts.ref !== undefined && !opts.git) {
    throw new Error("--ref requires --git (it selects which commit's tracked files to hash)");
  }
  return opts;
}

function cmdHash(argv) {
  let opts;
  try {
    opts = parseHashArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.path) {
    process.stderr.write("error: `vh hash` requires a <path>\n\n" + usage());
    return 2;
  }

  // --git: hash EXACTLY the files git tracks (no filesystem walk, no untracked junk). Errors clearly
  // on a non-git dir / unknown ref / zero tracked files — it never silently falls back to the walk.
  if (opts.git) {
    let result;
    try {
      result = hashGit(opts.path, { ref: opts.ref });
    } catch (e) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    }
    // Print the root, then the resolved commit oid as a `# commit <oid>` comment so the snapshot is
    // SELF-DESCRIBING: an operator running `--git --ref some-branch` can see WHICH commit produced
    // this root (the whole point of a commit-pinned, reproducible snapshot). The comment leads with
    // `#` so a downstream consumer of the line-oriented `<leaf>  <path>` body can skip it trivially,
    // and the root stays on line 1 — the human shape is otherwise byte-identical to the dir output.
    process.stdout.write(result.root + "\n");
    process.stdout.write(`# commit ${result.commit}\n`);
    for (const { path: p, leaf } of result.leaves) {
      process.stdout.write(`${leaf}  ${p}\n`);
    }
    return 0;
  }

  let result;
  try {
    result = hashPath(opts.path);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  if (result.kind === "file") {
    process.stdout.write(result.root + "\n");
  } else {
    // Directory: print the root, then each file's path-bound leaf (what verifyLeaf consumes) for
    // transparency. The root commits to file NAMES and content, so the leaf binds the path.
    process.stdout.write(result.root + "\n");
    for (const { path: p, leaf } of result.leaves) {
      process.stdout.write(`${leaf}  ${p}\n`);
    }
  }
  return 0;
}

/**
 * Parse `anchor` argv into { path, uri, contract, rpc, dryRun, iUnderstandMainnet }.
 * Throws on unknown/incomplete flags so a typo never silently turns into a real submission.
 */
function parseAnchorArgs(argv) {
  const opts = {
    path: undefined,
    uri: undefined,
    parent: undefined,
    receipt: undefined,
    contract: undefined,
    rpc: undefined,
    git: false,
    ref: undefined,
    dryRun: false,
    iUnderstandMainnet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--i-understand-mainnet":
        opts.iUnderstandMainnet = true;
        break;
      case "--git":
        opts.git = true;
        break;
      case "--ref":
        opts.ref = argv[++i];
        if (opts.ref === undefined) throw new Error("--ref requires a value");
        break;
      case "--uri":
        opts.uri = argv[++i];
        if (opts.uri === undefined) throw new Error("--uri requires a value");
        break;
      case "--parent":
        opts.parent = argv[++i];
        if (opts.parent === undefined) throw new Error("--parent requires a value");
        break;
      case "--receipt":
        opts.receipt = argv[++i];
        if (opts.receipt === undefined) throw new Error("--receipt requires a value");
        break;
      case "--contract":
        opts.contract = argv[++i];
        if (opts.contract === undefined) throw new Error("--contract requires a value");
        break;
      case "--rpc":
        opts.rpc = argv[++i];
        if (opts.rpc === undefined) throw new Error("--rpc requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.path !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.path = a;
    }
  }
  // --ref is meaningful only when scoping to git-tracked files (parser parity with `vh hash`).
  if (opts.ref !== undefined && !opts.git) {
    throw new Error("--ref requires --git (it selects which commit's tracked files to anchor)");
  }
  return opts;
}

async function cmdAnchor(argv) {
  let opts;
  try {
    opts = parseAnchorArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.path) {
    process.stderr.write("error: `vh anchor` requires a <path>\n\n" + usage());
    return 2;
  }

  const ethers = require("ethers");
  const contractAddress = opts.contract || process.env.VH_CONTRACT;

  // For a dry run we never construct a signer/provider: it must work with no key and no network.
  if (opts.dryRun) {
    try {
      await runAnchor({
        path: opts.path,
        uri: opts.uri,
        parent: opts.parent,
        git: opts.git,
        ref: opts.ref,
        contractAddress,
        receiptPath: opts.receipt,
        dryRun: true,
        ethers,
      });
    } catch (e) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    }
    return 0;
  }

  // Real submission: build provider + signer from env/flags.
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL " +
        "(or use --dry-run to preview without a network)\n"
    );
    return 1;
  }
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    process.stderr.write(
      "error: no PRIVATE_KEY in the environment; cannot sign. Use --dry-run to preview.\n"
    );
    return 1;
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(pk, provider);
    await runAnchor({
      path: opts.path,
      uri: opts.uri,
      parent: opts.parent,
      git: opts.git,
      ref: opts.ref,
      contractAddress,
      receiptPath: opts.receipt,
      iUnderstandMainnet: opts.iUnderstandMainnet,
      provider,
      signer,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

/**
 * Parse `claim`/`commit` argv into { path, uri, salt, receipt, contract, rpc, dryRun,
 * iUnderstandMainnet }. Throws on unknown/incomplete flags so a typo never silently turns into a
 * real submission. Both `vh claim` and `vh commit` take the same flags (commit ignores --dry-run).
 */
function parseClaimArgs(argv) {
  const opts = {
    path: undefined,
    uri: undefined,
    parent: undefined,
    salt: undefined,
    receipt: undefined,
    receiptDir: undefined,
    contract: undefined,
    rpc: undefined,
    git: false,
    ref: undefined,
    dryRun: false,
    iUnderstandMainnet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--i-understand-mainnet":
        opts.iUnderstandMainnet = true;
        break;
      case "--git":
        opts.git = true;
        break;
      case "--ref":
        opts.ref = argv[++i];
        if (opts.ref === undefined) throw new Error("--ref requires a value");
        break;
      case "--uri":
        opts.uri = argv[++i];
        if (opts.uri === undefined) throw new Error("--uri requires a value");
        break;
      case "--parent":
        opts.parent = argv[++i];
        if (opts.parent === undefined) throw new Error("--parent requires a value");
        break;
      case "--salt":
        opts.salt = argv[++i];
        if (opts.salt === undefined) throw new Error("--salt requires a value");
        break;
      case "--receipt":
        opts.receipt = argv[++i];
        if (opts.receipt === undefined) throw new Error("--receipt requires a value");
        break;
      case "--receipt-dir":
        opts.receiptDir = argv[++i];
        if (opts.receiptDir === undefined) throw new Error("--receipt-dir requires a value");
        break;
      case "--contract":
        opts.contract = argv[++i];
        if (opts.contract === undefined) throw new Error("--contract requires a value");
        break;
      case "--rpc":
        opts.rpc = argv[++i];
        if (opts.rpc === undefined) throw new Error("--rpc requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.path !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.path = a;
    }
  }
  // --ref is meaningful only when scoping to git-tracked files (parser parity with `vh hash`).
  if (opts.ref !== undefined && !opts.git) {
    throw new Error("--ref requires --git (it selects which commit's tracked files to claim)");
  }
  // --receipt picks the exact file; --receipt-dir picks the folder. Asking for both is ambiguous, so
  // hard-error rather than silently honor one (a fat-fingered combination must not pick a surprise path).
  if (opts.receipt !== undefined && opts.receiptDir !== undefined) {
    throw new Error("--receipt and --receipt-dir are mutually exclusive; pass at most one");
  }
  return opts;
}

/**
 * Parse `reveal` argv into { receipt, rpc, iUnderstandMainnet }. `--receipt <path>` is required and
 * carries everything reveal needs; there is no <path> positional. Throws on unknown/incomplete flags.
 */
function parseRevealArgs(argv) {
  const opts = { receipt: undefined, rpc: undefined, iUnderstandMainnet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--i-understand-mainnet":
        opts.iUnderstandMainnet = true;
        break;
      case "--receipt":
        opts.receipt = argv[++i];
        if (opts.receipt === undefined) throw new Error("--receipt requires a value");
        break;
      case "--rpc":
        opts.rpc = argv[++i];
        if (opts.rpc === undefined) throw new Error("--rpc requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        throw new Error(`unexpected extra argument: ${a}`);
    }
  }
  return opts;
}

async function cmdClaim(argv) {
  let opts;
  try {
    opts = parseClaimArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.path) {
    process.stderr.write("error: `vh claim` requires a <path>\n\n" + usage());
    return 2;
  }

  const ethers = require("ethers");
  const contractAddress = opts.contract || process.env.VH_CONTRACT;

  // Dry run: build the commit-reveal plan with no key and no network. We still need a committer
  // address to compute the (sender-bound) commitment; allow VH_COMMITTER for previewing.
  if (opts.dryRun) {
    try {
      await runClaim({
        path: opts.path,
        uri: opts.uri,
        parent: opts.parent,
        salt: opts.salt,
        git: opts.git,
        ref: opts.ref,
        committer: process.env.VH_COMMITTER,
        contractAddress,
        dryRun: true,
        ethers,
      });
    } catch (e) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    }
    return 0;
  }

  // Real submission: build provider + signer from env/flags.
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL " +
        "(or use --dry-run to preview without a network)\n"
    );
    return 1;
  }
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    process.stderr.write(
      "error: no PRIVATE_KEY in the environment; cannot sign. Use --dry-run to preview.\n"
    );
    return 1;
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(pk, provider);
    await runClaim({
      path: opts.path,
      uri: opts.uri,
      parent: opts.parent,
      salt: opts.salt,
      git: opts.git,
      ref: opts.ref,
      receiptPath: opts.receipt,
      receiptDir: opts.receiptDir,
      contractAddress,
      iUnderstandMainnet: opts.iUnderstandMainnet,
      provider,
      signer,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

async function cmdCommit(argv) {
  let opts;
  try {
    opts = parseClaimArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.path) {
    process.stderr.write("error: `vh commit` requires a <path>\n\n" + usage());
    return 2;
  }
  // `commit` has no dry-run: it intentionally sends a real tx and writes a receipt. A typo'd
  // --dry-run should not silently no-op into nothing useful.
  if (opts.dryRun) {
    process.stderr.write(
      "error: `vh commit` has no --dry-run; use `vh claim --dry-run` to preview the plan\n"
    );
    return 2;
  }
  // The lineage edge belongs on the REVEAL leg (revealWithParent), but the resumable receipt schema
  // does not yet persist a `parent` (that is BACKLOG B-10.1). Rather than silently drop the edge,
  // hard-error and point to the one-shot path that DOES support it (`vh claim --parent`).
  if (opts.parent !== undefined) {
    process.stderr.write(
      "error: `vh commit` does not yet support --parent (the resumable receipt cannot carry the " +
        "lineage edge yet; see BACKLOG B-10.1). Use the one-shot `vh claim --parent <hash>` instead.\n"
    );
    return 2;
  }

  const ethers = require("ethers");
  const contractAddress = opts.contract || process.env.VH_CONTRACT;
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL\n"
    );
    return 1;
  }
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    process.stderr.write(
      "error: no PRIVATE_KEY in the environment; cannot sign the commit.\n"
    );
    return 1;
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(pk, provider);
    await runCommit({
      path: opts.path,
      uri: opts.uri,
      salt: opts.salt,
      git: opts.git,
      ref: opts.ref,
      receiptPath: opts.receipt,
      receiptDir: opts.receiptDir,
      contractAddress,
      iUnderstandMainnet: opts.iUnderstandMainnet,
      provider,
      signer,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

async function cmdReveal(argv) {
  let opts;
  try {
    opts = parseRevealArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.receipt) {
    process.stderr.write("error: `vh reveal` requires --receipt <path>\n\n" + usage());
    return 2;
  }

  const ethers = require("ethers");
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL\n"
    );
    return 1;
  }
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    process.stderr.write(
      "error: no PRIVATE_KEY in the environment; cannot sign the reveal.\n"
    );
    return 1;
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(pk, provider);
    await runReveal({
      receiptPath: opts.receipt,
      iUnderstandMainnet: opts.iUnderstandMainnet,
      provider,
      signer,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

/**
 * Parse `verify` argv into { path, contract, rpc }.
 * Throws on unknown/incomplete flags so a typo is never silently ignored.
 */
function parseVerifyArgs(argv) {
  const opts = {
    path: undefined,
    contract: undefined,
    rpc: undefined,
    receipt: undefined,
    git: false,
    ref: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--git":
        opts.git = true;
        break;
      case "--ref":
        opts.ref = argv[++i];
        if (opts.ref === undefined) throw new Error("--ref requires a value");
        break;
      case "--receipt":
        opts.receipt = argv[++i];
        if (opts.receipt === undefined) throw new Error("--receipt requires a value");
        break;
      case "--contract":
        opts.contract = argv[++i];
        if (opts.contract === undefined) throw new Error("--contract requires a value");
        break;
      case "--rpc":
        opts.rpc = argv[++i];
        if (opts.rpc === undefined) throw new Error("--rpc requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.path !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.path = a;
    }
  }
  // --ref is meaningful only when scoping to git-tracked files (parser parity with `vh hash`).
  if (opts.ref !== undefined && !opts.git) {
    throw new Error("--ref requires --git (it selects which commit's tracked files to verify)");
  }
  return opts;
}

async function cmdVerify(argv) {
  let opts;
  try {
    opts = parseVerifyArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.path) {
    process.stderr.write("error: `vh verify` requires a <path>\n\n" + usage());
    return 2;
  }

  const ethers = require("ethers");
  const contractAddress = opts.contract || process.env.VH_CONTRACT;
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL\n"
    );
    return 1;
  }

  let result;
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    result = await runVerify({
      path: opts.path,
      git: opts.git,
      ref: opts.ref,
      contractAddress,
      receiptPath: opts.receipt,
      provider,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // Exit non-zero on a tamper/MISMATCH so scripts and CI can branch on it.
  return result.status === "MATCH" ? 0 : 3;
}

/**
 * Parse `prove` argv into { file, root, contract, rpc, anchor, iUnderstandMainnet, dryRun }.
 * Throws on unknown/incomplete flags so a typo is never silently ignored.
 */
function parseProveArgs(argv) {
  const opts = {
    file: undefined,
    root: undefined,
    out: undefined,
    contract: undefined,
    rpc: undefined,
    anchor: false,
    iUnderstandMainnet: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--anchor":
        opts.anchor = true;
        break;
      case "--i-understand-mainnet":
        opts.iUnderstandMainnet = true;
        break;
      case "--root":
        opts.root = argv[++i];
        if (opts.root === undefined) throw new Error("--root requires a value");
        break;
      case "--out":
        opts.out = argv[++i];
        if (opts.out === undefined) throw new Error("--out requires a value");
        break;
      case "--contract":
        opts.contract = argv[++i];
        if (opts.contract === undefined) throw new Error("--contract requires a value");
        break;
      case "--rpc":
        opts.rpc = argv[++i];
        if (opts.rpc === undefined) throw new Error("--rpc requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.file !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.file = a;
    }
  }
  return opts;
}

async function cmdProve(argv) {
  let opts;
  try {
    opts = parseProveArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.file) {
    process.stderr.write("error: `vh prove` requires a <file>\n\n" + usage());
    return 2;
  }
  if (!opts.root) {
    process.stderr.write("error: `vh prove` requires --root <dir> (the repo root)\n\n" + usage());
    return 2;
  }

  const ethers = require("ethers");

  // Dry run: only builds & prints the proof (and writes the --out artifact if asked). No key, no
  // network — must work entirely offline. This is the no-key build path for `--out`.
  if (opts.dryRun) {
    try {
      await runProve({ file: opts.file, rootDir: opts.root, out: opts.out, dryRun: true, ethers });
    } catch (e) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    }
    return 0;
  }

  const contractAddress = opts.contract || process.env.VH_CONTRACT;
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL " +
        "(or use --dry-run to build the proof without a network)\n"
    );
    return 1;
  }

  let result;
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    // Only the --anchor path needs to sign; verifying a proof is read-only.
    let signer;
    if (opts.anchor) {
      const pk = process.env.PRIVATE_KEY;
      if (!pk) {
        process.stderr.write(
          "error: --anchor needs a PRIVATE_KEY in the environment to submit the root\n"
        );
        return 1;
      }
      signer = new ethers.Wallet(pk, provider);
    }
    result = await runProve({
      file: opts.file,
      rootDir: opts.root,
      out: opts.out,
      contractAddress,
      provider,
      signer,
      anchorFirst: opts.anchor,
      iUnderstandMainnet: opts.iUnderstandMainnet,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // Exit non-zero when the on-chain verifyLeaf rejects the proof (tampered / not in the snapshot),
  // so scripts and CI can branch on it.
  return result.accepted ? 0 : 3;
}

/**
 * Parse `verify-proof` argv into { artifact, contract, rpc, json }. Takes exactly one positional
 * <p> (the artifact path). Throws on unknown/incomplete flags or a duplicate/missing positional so a
 * typo never silently verifies the wrong file (parser parity with the other commands).
 */
function parseVerifyProofArgs(argv) {
  const opts = { artifact: undefined, contract: undefined, rpc: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--contract":
        opts.contract = argv[++i];
        if (opts.contract === undefined) throw new Error("--contract requires a value");
        break;
      case "--rpc":
        opts.rpc = argv[++i];
        if (opts.rpc === undefined) throw new Error("--rpc requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.artifact !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.artifact = a;
    }
  }
  return opts;
}

async function cmdVerifyProof(argv) {
  let opts;
  try {
    opts = parseVerifyProofArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.artifact) {
    process.stderr.write("error: `vh verify-proof` requires a <p> (proof artifact path)\n\n" + usage());
    return 2;
  }

  const ethers = require("ethers");
  const contractAddress = opts.contract || process.env.VH_CONTRACT;
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL " +
        "(verify-proof confirms the root is anchored on-chain)\n"
    );
    return 1;
  }

  let result;
  try {
    // Read-only: provider only — `vh verify-proof` NEVER constructs a signer or touches a key.
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    result = await runVerifyProof({
      artifactPath: opts.artifact,
      contractAddress,
      provider,
      json: opts.json,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // Exit 0 ONLY on ACCEPTED. A NOT ANCHORED root is exit 4 (mirrors `vh show`'s NOT ANCHORED), a
  // REJECTED proof is exit 3 (mirrors `vh verify`/`vh prove`), so scripts/CI can branch on each.
  if (result.status === "ACCEPTED") return 0;
  if (result.status === "NOT_ANCHORED") return 4;
  return 3;
}

/**
 * Parse `list` argv into { contract, rpc, contributor, authorBound, limit, offset, json }.
 * `list` takes NO positional argument (it enumerates the whole registry). Throws on unknown or
 * incomplete flags so a typo never silently returns a wrong/empty list (parser parity with the
 * other commands). `--limit`/`--offset` must be non-negative integers.
 */
function parseListArgs(argv) {
  const opts = {
    contract: undefined,
    rpc: undefined,
    contributor: undefined,
    authorBound: false,
    limit: undefined,
    offset: undefined,
    json: false,
  };
  // Parse a flag value as a non-negative integer, hard-erroring on anything else.
  const intArg = (flag, raw) => {
    if (raw === undefined) throw new Error(`${flag} requires a value`);
    if (!/^\d+$/.test(raw)) throw new Error(`${flag} requires a non-negative integer, got: ${raw}`);
    return Number(raw);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--author-bound":
        opts.authorBound = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--contract":
        opts.contract = argv[++i];
        if (opts.contract === undefined) throw new Error("--contract requires a value");
        break;
      case "--rpc":
        opts.rpc = argv[++i];
        if (opts.rpc === undefined) throw new Error("--rpc requires a value");
        break;
      case "--contributor":
        opts.contributor = argv[++i];
        if (opts.contributor === undefined) throw new Error("--contributor requires a value");
        break;
      case "--limit":
        opts.limit = intArg("--limit", argv[++i]);
        break;
      case "--offset":
        opts.offset = intArg("--offset", argv[++i]);
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        throw new Error(`unexpected argument: ${a} (vh list takes no positional path)`);
    }
  }
  return opts;
}

async function cmdList(argv) {
  let opts;
  try {
    opts = parseListArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }

  const ethers = require("ethers");
  const contractAddress = opts.contract || process.env.VH_CONTRACT;
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL\n"
    );
    return 1;
  }

  try {
    // Read-only: provider only — `vh list` NEVER constructs a signer or touches a key.
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    await runList({
      contractAddress,
      provider,
      filters: {
        contributor: opts.contributor,
        authorBound: opts.authorBound,
        limit: opts.limit,
        offset: opts.offset,
      },
      json: opts.json,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
  return 0;
}

/**
 * Parse `show` argv into { hash, contract, rpc, json }. Takes exactly one positional <0xhash>.
 * Throws on unknown/incomplete flags or a duplicate/missing hash so a typo never silently looks up
 * the wrong thing. The hash VALUE is shape-validated later (in runShow) so the same usage-grade error
 * fires whether the hash came from the CLI or a programmatic caller.
 */
function parseShowArgs(argv) {
  const opts = { hash: undefined, contract: undefined, rpc: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        opts.json = true;
        break;
      case "--contract":
        opts.contract = argv[++i];
        if (opts.contract === undefined) throw new Error("--contract requires a value");
        break;
      case "--rpc":
        opts.rpc = argv[++i];
        if (opts.rpc === undefined) throw new Error("--rpc requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.hash !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.hash = a;
    }
  }
  return opts;
}

async function cmdShow(argv) {
  let opts;
  try {
    opts = parseShowArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }
  if (!opts.hash) {
    process.stderr.write("error: `vh show` requires a <0xhash>\n\n" + usage());
    return 2;
  }

  const ethers = require("ethers");

  // Validate the hash shape BEFORE building a provider or reading any env/network — a malformed/short
  // hash must hard-error with usage and never hit the network. We re-use runShow's normalizer (via a
  // dry, provider-less throw) by checking the shape here directly so the error precedes the RPC check.
  const { normalizeContentHash } = require("./show");
  try {
    normalizeContentHash(opts.hash, ethers);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n` + usage());
    return 2;
  }

  const contractAddress = opts.contract || process.env.VH_CONTRACT;
  const rpcUrl = opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) {
    process.stderr.write(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL\n"
    );
    return 1;
  }

  let result;
  try {
    // Read-only: provider only — `vh show` NEVER constructs a signer or touches a key.
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    result = await runShow({
      contentHash: opts.hash,
      contractAddress,
      provider,
      json: opts.json,
      ethers,
    });
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // Exit non-zero when the hash has no record so scripts/CI can branch on "NOT ANCHORED".
  return result.status === "ANCHORED" ? 0 : 4;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "hash":
      return cmdHash(rest);
    case "anchor":
      return cmdAnchor(rest);
    case "claim":
      return cmdClaim(rest);
    case "commit":
      return cmdCommit(rest);
    case "reveal":
      return cmdReveal(rest);
    case "verify":
      return cmdVerify(rest);
    case "prove":
      return cmdProve(rest);
    case "verify-proof":
      return cmdVerifyProof(rest);
    case "list":
      return cmdList(rest);
    case "show":
      return cmdShow(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(usage());
      return 0;
    default:
      process.stderr.write(`error: unknown command: ${cmd}\n\n` + usage());
      return 2;
  }
}

if (require.main === module) {
  Promise.resolve(main(process.argv.slice(2))).then((code) => process.exit(code));
}

module.exports = {
  main,
  cmdHash,
  cmdAnchor,
  cmdClaim,
  cmdCommit,
  cmdReveal,
  cmdVerify,
  cmdProve,
  cmdVerifyProof,
  cmdList,
  cmdShow,
  parseHashArgs,
  parseAnchorArgs,
  parseClaimArgs,
  parseRevealArgs,
  parseVerifyArgs,
  parseProveArgs,
  parseVerifyProofArgs,
  parseListArgs,
  parseShowArgs,
  usage,
};

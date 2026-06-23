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

const { hashPath } = require("./hash");
const { runAnchor } = require("./anchor");
const { runVerify } = require("./verify");
const { runProve } = require("./prove");
const { runClaim, runCommit, runReveal } = require("./claim");

function usage() {
  return [
    "vh — verifyhash CLI",
    "",
    "Usage:",
    "  vh hash <path>             keccak256 of a file, or sorted-leaf Merkle root of a directory",
    "  vh anchor <path> [opts]    anchor a file/dir's content hash on-chain (FRONT-RUNNABLE)",
    "  vh claim <path> [opts]     front-running-resistant attribution via commit-reveal (one-shot)",
    "  vh commit <path> [opts]    commit-reveal step 1: commit + write a resumable claim receipt",
    "  vh reveal --receipt <p>    commit-reveal step 2: resume from a receipt and reveal",
    "  vh verify <path> [opts]    recompute the hash, read the registry, print MATCH / MISMATCH",
    "  vh prove <file> [opts]     Merkle-prove a file against an anchored repo root via verifyLeaf",
    "",
    "anchor options (one-shot; contributor = 'first anchorer', NOT proven authorship):",
    "  --uri <uri>                optional off-chain pointer stored with the hash (IPFS CID, URL)",
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --dry-run                  print the tx that would be sent; needs no key, sends nothing",
    "  --i-understand-mainnet     allow anchoring on a non-testnet chainId (DANGER: real funds)",
    "",
    "claim options (commit-reveal; contributor = proven first claimant, authorBound = true):",
    "  --uri <uri>                optional off-chain pointer stored with the hash (IPFS CID, URL)",
    "  --salt <0xhex>             reuse a 32-byte salt (default: a fresh random one)",
    "  --receipt <path>           where to write the claim receipt (default ./<hashPrefix>.vhclaim.json)",
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --dry-run                  print the commit+reveal plan; needs no key, sends nothing",
    "  --i-understand-mainnet     allow claiming on a non-testnet chainId (DANGER: real funds)",
    "",
    "commit options (step 1 of a resumable claim; writes a receipt, then commits):",
    "  --uri <uri>                pointer recorded at reveal time (kept in the receipt until then)",
    "  --salt <0xhex>             reuse a 32-byte salt (default: a fresh random one)",
    "  --receipt <path>           where to write the claim receipt (default ./<hashPrefix>.vhclaim.json)",
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
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "",
    "prove options:",
    "  --root <dir>               the repo root directory whose Merkle root <file> is proven against",
    "  --contract <address>       ContributionRegistry address (or env VH_CONTRACT)",
    "  --rpc <url>                JSON-RPC endpoint (or env VH_RPC_URL / AMOY_RPC_URL)",
    "  --anchor                   anchor the repo root first (needs PRIVATE_KEY), then prove",
    "  --i-understand-mainnet     allow --anchor on a non-testnet chainId (DANGER: real funds)",
    "  --dry-run                  build & print the proof only; needs no key and no network",
    "",
  ].join("\n");
}

function cmdHash(argv) {
  const target = argv[0];
  if (!target) {
    process.stderr.write("error: `vh hash` requires a <path>\n\n" + usage());
    return 2;
  }
  let result;
  try {
    result = hashPath(target);
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
    contract: undefined,
    rpc: undefined,
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
      case "--uri":
        opts.uri = argv[++i];
        if (opts.uri === undefined) throw new Error("--uri requires a value");
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
    await runAnchor({
      path: opts.path,
      uri: opts.uri,
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

/**
 * Parse `claim`/`commit` argv into { path, uri, salt, receipt, contract, rpc, dryRun,
 * iUnderstandMainnet }. Throws on unknown/incomplete flags so a typo never silently turns into a
 * real submission. Both `vh claim` and `vh commit` take the same flags (commit ignores --dry-run).
 */
function parseClaimArgs(argv) {
  const opts = {
    path: undefined,
    uri: undefined,
    salt: undefined,
    receipt: undefined,
    contract: undefined,
    rpc: undefined,
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
      case "--uri":
        opts.uri = argv[++i];
        if (opts.uri === undefined) throw new Error("--uri requires a value");
        break;
      case "--salt":
        opts.salt = argv[++i];
        if (opts.salt === undefined) throw new Error("--salt requires a value");
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
        salt: opts.salt,
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
      salt: opts.salt,
      receiptPath: opts.receipt,
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
      receiptPath: opts.receipt,
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
  const opts = { path: undefined, contract: undefined, rpc: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
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
      contractAddress,
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

  // Dry run: only builds & prints the proof. No key, no network — must work entirely offline.
  if (opts.dryRun) {
    try {
      await runProve({ file: opts.file, rootDir: opts.root, dryRun: true, ethers });
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
  parseAnchorArgs,
  parseClaimArgs,
  parseRevealArgs,
  parseVerifyArgs,
  parseProveArgs,
  usage,
};

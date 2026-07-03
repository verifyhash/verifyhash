"use strict";

// cli/anchor-artifact.js — `vh anchor-artifact` / `vh verify-anchored` (T-70.2, EPIC-70).
//
// WHAT THIS IS
//   The thin CLI bridge between the PURE anchor-binding core (T-70.1, cli/core/anchor-binding.js)
//   and a live ContributionRegistry:
//
//     vh anchor-artifact <sealed-file> --contract <addr> --rpc <url>
//                        (--key-env <VAR> | --key-file <p>)
//                        [--author-bound] [--uri <s>] [--out <receipt>] [--json]
//                        [--i-understand-mainnet]
//       read + parse the sealed artifact, extract its ONE canonical digest via the closed T-70.1
//       kind table (each leg re-validates through the artifact's own shipped validator), submit
//       that digest as the registry contentHash, wait for the tx to mine, READ THE RECORD BACK
//       (contributor / authorBound / blockNumber / block timestamp — the D-1 semantics surfaced
//       from the chain, never re-implemented here), and emit the canonical
//       kind:"vh-anchored-receipt@1" container.
//         * default: the ONE-SHOT anchor() write path — the record is NOT author-bound (the
//           contract records the first broadcaster; a mempool copier could have been first).
//         * --author-bound: the commit-reveal claim (D-1): commit(keccak256(abi.encode(digest,
//           committer, salt))) — the SHIPPED cli/claim.js computeCommitment/newSalt, reused
//           verbatim — wait out MIN_REVEAL_DELAY, then reveal(digest, salt, uri). The resulting
//           record reads back authorBound:true and cannot be redirected by a front-runner.
//
//     vh verify-anchored <receipt> <sealed-file> [--rpc <url> --contract <addr>] [--json]
//       OFFLINE by default: strict T-70.1 verifyAnchoredReceipt — validate the receipt container,
//       RECOMPUTE the artifact's digest through the same closed table, and match the full
//       {kind, digest, how} triple; every deviation is a SPECIFIC named reject. With BOTH --rpc
//       and --contract it ADDITIONALLY (a) authenticates the registry through the EXISTING EPIC-11
//       identity probe (cli/registry.js assertRegistry — no record is believed until the contract
//       self-identifies on the receipt's chainId), then (b) re-checks the receipt's chain facts
//       against the chain: the record for the digest must exist and its contributor / authorBound /
//       blockNumber / block timestamp must equal the receipt's, and the receipt's txHash must be a
//       real mined tx in the recorded block targeting the recorded contract. Each mismatch is a
//       SPECIFIC named reject. verify-anchored NEVER signs and needs NO key.
//
// KEY HYGIENE (the house discipline, reused — not re-implemented)
//   The signing key for anchor-artifact comes ONLY from --key-env <VAR> / --key-file <path> via the
//   ONE shared read-used-discarded path, cli/core/attestation.js loadSigningWallet: EXACTLY ONE
//   source (neither/both is a usage error BEFORE anything is read), a missing var / unreadable file /
//   malformed or zero key hard-errors naming only the SOURCE (never echoing key material), and the
//   raw key exists only inside the in-process Wallet. It is never generated, persisted, or logged.
//
// MAINNET GUARD (reused verbatim)
//   The EXISTING cli/anchor.js isTestnetChainId set gates every submission: a chainId outside the
//   known local/dev/testnet set refuses to write unless --i-understand-mainnet is passed. The guard
//   runs BEFORE any transaction is built or sent.
//
// FREE SURFACE
//   Both verbs are free: no paid gate is consulted anywhere in this module (the acceptance grep
//   pins that), and verify-anchored is verify-only (no key, no signer, nothing written except what
//   --out of the anchor verb explicitly asked for).
//
// OUTPUT / EXIT CONTRACT (stable; a future indexer/UI may depend on it)
//   vh anchor-artifact:  exit 0 anchored (receipt emitted; --json prints ONE machine object)
//                        exit 3 named reject — the artifact failed its own validator/binding, OR
//                               the registry itself reverted with a named error (e.g.
//                               AlreadyAnchored) — always a clean one-line error, never a stack
//                        exit 2 usage (bad flag, missing <sealed-file>/--contract/--rpc, neither or
//                               both key sources)
//                        exit 1 IO / network / key-source runtime error (unreadable file, RPC down,
//                               missing env var, malformed key, non-testnet refusal)
//   vh verify-anchored:  exit 0 ACCEPTED / 3 REJECTED (named) / 2 usage / 1 IO — the SHARED 0/3
//                        verify contract every vh verify-verb keeps.
//
// FILESYSTEM HYGIENE
//   The only file either verb ever writes is the anchored receipt, and only when the caller passed
//   an explicit --out <path> — never silently into cwd. Without --out the receipt is printed to
//   stdout (its canonical one-line serialization) so the caller can redirect it wherever they want.

const fs = require("fs");
const path = require("path");

const { isTestnetChainId } = require("./anchor"); // the EXISTING mainnet guard, reused verbatim
const { computeCommitment, newSalt } = require("./claim"); // the SHIPPED commit-reveal building blocks
const { loadSigningWallet } = require("./core/attestation"); // the ONE read-used-discarded key path
const binding = require("./core/anchor-binding"); // T-70.1: the pure digest/receipt/verify core
const {
  assertRegistry,
  isGenuineRpcError,
  formatRegistryLine,
  jsonRegistryBlock,
} = require("./registry"); // EPIC-11: the EXISTING authenticated read path (identity probe)

const ARTIFACT = require("./core/registryArtifact");
const ABI = ARTIFACT.abi;

// The shared exit contract (matches the wider vh family).
const EXIT = Object.freeze({ OK: 0, IO: 1, USAGE: 2, REJECT: 3 });

const ANCHOR_ARTIFACT_USAGE =
  "usage: vh anchor-artifact <sealed-file> --contract <addr> --rpc <url> " +
  "(--key-env <VAR> | --key-file <p>) [--author-bound] [--uri <s>] [--out <receipt>] [--json] " +
  "[--i-understand-mainnet]\n";

const VERIFY_ANCHORED_USAGE =
  "usage: vh verify-anchored <receipt> <sealed-file> [--rpc <url> --contract <addr>] [--json]\n";

// The registry's own named custom errors (from the contract ABI). Used only as a last-resort
// textual fallback when a node surfaces a revert without decodable data.
const REGISTRY_ERROR_NAMES = Object.freeze([
  "ZeroHash",
  "AlreadyAnchored",
  "NotAnchored",
  "IndexOutOfRange",
  "ZeroCommitment",
  "CommitmentExists",
  "NoSuchCommitment",
  "RevealTooSoon",
  "UnknownParent",
  "SelfParent",
]);

// ---------------------------------------------------------------------------------------------------
// argv parsers — throw on unknown/incomplete flags so a typo never silently becomes a real submission.
// ---------------------------------------------------------------------------------------------------

/**
 * Parse `anchor-artifact` argv. One positional (<sealed-file>); throws on unknown flags, a flag
 * missing its value, or extra positionals.
 */
function parseAnchorArtifactArgs(argv) {
  const opts = {
    artifact: undefined,
    contract: undefined,
    rpc: undefined,
    keyEnv: undefined,
    keyFile: undefined,
    uri: undefined,
    out: undefined,
    authorBound: false,
    json: false,
    iUnderstandMainnet: false,
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
      case "--i-understand-mainnet":
        opts.iUnderstandMainnet = true;
        break;
      case "--uri":
        opts.uri = argv[++i];
        if (opts.uri === undefined) throw new Error("--uri requires a value");
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
      case "--key-env":
        opts.keyEnv = argv[++i];
        if (opts.keyEnv === undefined) throw new Error("--key-env requires a value");
        break;
      case "--key-file":
        opts.keyFile = argv[++i];
        if (opts.keyFile === undefined) throw new Error("--key-file requires a value");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        if (opts.artifact !== undefined) throw new Error(`unexpected extra argument: ${a}`);
        opts.artifact = a;
    }
  }
  return opts;
}

/**
 * Parse `verify-anchored` argv. TWO positionals, in order: <receipt> then <sealed-file>.
 */
function parseVerifyAnchoredArgs(argv) {
  const opts = {
    receipt: undefined,
    artifact: undefined,
    contract: undefined,
    rpc: undefined,
    json: false,
  };
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
        if (opts.receipt === undefined) opts.receipt = a;
        else if (opts.artifact === undefined) opts.artifact = a;
        else throw new Error(`unexpected extra argument: ${a}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------------------------------

/** Read + JSON.parse a file; on failure write an actionable error and return null (caller exits 1). */
function readJson(label, filePath, writeErr) {
  let text;
  try {
    text = fs.readFileSync(path.resolve(filePath), "utf8");
  } catch (e) {
    writeErr(`error: cannot read ${label} ${filePath}: ${e.message}\n`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    writeErr(`error: ${label} ${filePath} is not valid JSON: ${e.message}\n`);
    return null;
  }
}

/** Pull raw revert data out of the several places ethers/hardhat nodes stash it. */
function extractRevertData(err) {
  if (!err || typeof err !== "object") return null;
  const candidates = [
    err.data,
    err.info && err.info.error && err.info.error.data,
    err.info && err.info.error && err.info.error.data && err.info.error.data.data,
    err.error && err.error.data,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("0x") && c.length >= 10) return c;
  }
  return null;
}

/**
 * Resolve a send/read failure to the REGISTRY'S OWN named error (e.g. "AlreadyAnchored(0x…, 0x…)"),
 * or null when the failure is not a decodable contract revert. Tries, in order: ethers' decoded
 * `err.revert`, parsing raw revert data against the registry ABI, ethers' `err.reason`, and finally
 * a known-error-name match in the message (some nodes surface only "unknown custom error" text).
 */
function namedRegistryReject(err, ethersLib) {
  if (err && err.revert && err.revert.name) {
    const args = Array.isArray(err.revert.args) ? Array.from(err.revert.args).map(String).join(", ") : "";
    return `${err.revert.name}(${args})`;
  }
  const data = extractRevertData(err);
  if (data) {
    try {
      const parsed = new ethersLib.Interface(ABI).parseError(data);
      if (parsed) return `${parsed.name}(${Array.from(parsed.args).map(String).join(", ")})`;
    } catch (_) {
      /* not one of the registry's errors */
    }
  }
  if (err && typeof err.reason === "string" && /[A-Za-z]/.test(err.reason)) return err.reason;
  const msg = err && err.message ? String(err.message) : "";
  for (const name of REGISTRY_ERROR_NAMES) {
    if (msg.includes(name)) return name;
  }
  return null;
}

/**
 * Wait until the chain has advanced past the MIN_REVEAL_DELAY window for a commit mined in
 * `commitBlock` (a reveal needs `current > commitBlock + minDelay`). Mirrors the shipped
 * cli/claim.js window wait: an injectable `waitForBlock` lets a test mine the blocks itself; the
 * real path polls the node until blocks are produced.
 */
async function waitRevealWindow({ provider, commitBlock, minDelay, waitForBlock }) {
  const revealAfter = commitBlock + minDelay;
  if (waitForBlock) {
    await waitForBlock(revealAfter + 1n);
    return;
  }
  /* eslint-disable no-await-in-loop */
  while (BigInt(await provider.getBlockNumber()) <= revealAfter) {
    await new Promise((r) => setTimeout(r, 1500));
  }
  /* eslint-enable no-await-in-loop */
}

// ---------------------------------------------------------------------------------------------------
// vh anchor-artifact
// ---------------------------------------------------------------------------------------------------

/**
 * Run `vh anchor-artifact` end to end. Returns the process exit code.
 *
 * @param {object} opts
 * @param {string}  opts.artifact           path to the sealed artifact file (JSON)
 * @param {string}  opts.contract           deployed ContributionRegistry address
 * @param {string} [opts.rpc]               RPC endpoint URL (or inject opts.provider)
 * @param {string} [opts.keyEnv]            env var NAME holding the key (EXACTLY ONE of keyEnv/keyFile)
 * @param {string} [opts.keyFile]           path to a key file the caller created
 * @param {boolean}[opts.authorBound]       use the commit-reveal claim (record reads back authorBound:true)
 * @param {string} [opts.uri]               optional untrusted off-chain pointer hint
 * @param {string} [opts.out]               write the anchored receipt to THIS explicit path (else stdout)
 * @param {boolean}[opts.json]              emit ONE machine-readable JSON object instead of human lines
 * @param {boolean}[opts.iUnderstandMainnet] bypass the non-testnet refusal (the EXISTING guard)
 * @param {object} [opts.provider]          injected ethers Provider (tests; else built from opts.rpc)
 * @param {bigint|number}[opts.chainId]     override/short-circuit the chainId lookup (tests — same
 *                                          hook the shipped runAnchor exposes)
 * @param {(target:bigint)=>Promise<void>}[opts.waitForBlock] test hook to advance/await blocks
 * @param {object} [opts.ethers]            ethers v6 module
 * @param {{write?:Function, writeErr?:Function}} [io]
 * @returns {Promise<number>} exit code (see the module-header contract)
 */
async function runAnchorArtifact(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  const ethersLib = opts.ethers || require("ethers");

  const reject = (reason, detail) => {
    if (opts.json) {
      write(JSON.stringify({ ok: false, verdict: "REJECTED", reason, detail }, null, 2) + "\n");
    } else {
      writeErr(`anchor-artifact: REJECTED (${reason}): ${detail}\n`);
    }
    return EXIT.REJECT;
  };

  // ---- usage-shape validation FIRST (nothing read, no key touched, no network) ----
  if (!opts.artifact) {
    writeErr("error: `vh anchor-artifact` requires a <sealed-file>\n" + ANCHOR_ARTIFACT_USAGE);
    return EXIT.USAGE;
  }
  if (!opts.contract) {
    writeErr(
      "error: no contract address: pass --contract <address> or set VH_CONTRACT in the environment\n" +
        ANCHOR_ARTIFACT_USAGE
    );
    return EXIT.USAGE;
  }
  if (!ethersLib.isAddress(opts.contract)) {
    writeErr(`error: invalid contract address: ${opts.contract}\n`);
    return EXIT.USAGE;
  }
  const hasEnv = opts.keyEnv !== undefined && opts.keyEnv !== null;
  const hasFile = opts.keyFile !== undefined && opts.keyFile !== null;
  if (!hasEnv && !hasFile) {
    writeErr(
      "error: `vh anchor-artifact` requires EXACTLY ONE signing-key source: --key-env <VAR> or " +
        "--key-file <path>\n" +
        ANCHOR_ARTIFACT_USAGE
    );
    return EXIT.USAGE;
  }
  if (hasEnv && hasFile) {
    writeErr("error: --key-env and --key-file are mutually exclusive; pass EXACTLY ONE signing-key source\n");
    return EXIT.USAGE;
  }
  if (!opts.provider && !opts.rpc) {
    writeErr(
      "error: no RPC endpoint; pass --rpc <url> or set VH_RPC_URL / AMOY_RPC_URL in the environment\n" +
        ANCHOR_ARTIFACT_USAGE
    );
    return EXIT.USAGE;
  }

  // ---- read the artifact + extract its ONE canonical digest (offline; the T-70.1 closed table) ----
  const artifactPath = path.resolve(opts.artifact);
  const artifact = readJson("artifact", opts.artifact, writeErr);
  if (artifact === null) return EXIT.IO;
  const d = binding.artifactDigest(artifact);
  if (!d.ok) {
    // The artifact's own named validation reject — nothing was signed or sent.
    return reject(d.reason, d.detail || "the artifact failed its own validator; refusing to anchor it");
  }

  // ---- signing key: the ONE house read-used-discarded path. Loaded only AFTER the artifact proved
  //      anchorable, and BEFORE any network use; errors name only the SOURCE, never key material. ----
  let wallet;
  try {
    ({ wallet } = loadSigningWallet({ keyEnv: opts.keyEnv, keyFile: opts.keyFile }));
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }

  // ---- chain resolution + the EXISTING mainnet guard (BEFORE any transaction is built/sent) ----
  const provider = opts.provider || new ethersLib.JsonRpcProvider(opts.rpc);
  let chainId = opts.chainId;
  if (chainId == null) {
    try {
      chainId = (await provider.getNetwork()).chainId;
    } catch (e) {
      writeErr(`error: cannot reach the RPC endpoint to determine the chainId: ${e.message}\n`);
      return EXIT.IO;
    }
  }
  chainId = BigInt(chainId);
  if (!isTestnetChainId(chainId) && !opts.iUnderstandMainnet) {
    writeErr(
      `error: refusing to anchor on chainId ${chainId.toString()} (not a known testnet). ` +
        "If you really mean to write to this chain, re-run with --i-understand-mainnet.\n"
    );
    return EXIT.IO;
  }

  // NonceManager keeps back-to-back sends (the --author-bound commit + reveal pair, possibly
  // interleaved with externally mined blocks) from tripping ethers' briefly-cached nonce reads —
  // the same wrapper the shipped commit-reveal test discipline uses.
  const signer = new ethersLib.NonceManager(wallet.connect(provider));
  const contractAddr = ethersLib.getAddress(opts.contract);
  const contract = new ethersLib.Contract(contractAddr, ABI, signer);
  const uri = opts.uri == null ? "" : String(opts.uri);

  // ---- submit: one-shot anchor() by default; commit-reveal (D-1) with --author-bound ----
  let txHash;
  try {
    if (opts.authorBound) {
      const salt = newSalt(ethersLib); // fresh random 32-byte secret (public after reveal)
      const committer = await signer.getAddress();
      // The SHIPPED commitment construction, reused verbatim (sender-bound + salt-blinded).
      const commitment = computeCommitment({ contentHash: d.digest, committer, salt, ethers: ethersLib });
      if (!opts.json) {
        write(`anchor-artifact: committing digest ${d.digest} (author-bound commit-reveal) as ${committer}...\n`);
      }
      const commitMined = await (await contract.commit(commitment)).wait();
      const minDelay = BigInt(await contract.MIN_REVEAL_DELAY());
      if (!opts.json) {
        write(`  commit tx: ${commitMined.hash} (block ${commitMined.blockNumber}); revealing after ${minDelay} block(s)...\n`);
      }
      await waitRevealWindow({
        provider,
        commitBlock: BigInt(commitMined.blockNumber),
        minDelay,
        waitForBlock: opts.waitForBlock,
      });
      const revealMined = await (await contract.reveal(d.digest, salt, uri)).wait();
      txHash = revealMined.hash;
    } else {
      if (!opts.json) {
        write(`anchor-artifact: anchoring digest ${d.digest} (one-shot; the record will NOT be author-bound)...\n`);
      }
      const mined = await (await contract.anchor(d.digest, uri)).wait();
      txHash = mined.hash;
    }
  } catch (e) {
    // The registry's OWN named revert (e.g. AlreadyAnchored) is a clean, named reject — never a
    // stack trace. Anything else is a genuine runtime/network failure.
    const named = namedRegistryReject(e, ethersLib);
    if (named) {
      return reject("registry-reject", `the registry rejected this write: ${named}`);
    }
    if (isGenuineRpcError(e)) {
      writeErr(`error: RPC failure while anchoring: ${e.message}\n`);
      return EXIT.IO;
    }
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }

  // ---- read the record BACK from the chain (the D-1 semantics surfaced, not re-implemented):
  //      contributor / authorBound / blockNumber / block timestamp come from the registry itself ----
  let rec;
  try {
    rec = await contract.getRecord(d.digest);
  } catch (e) {
    writeErr(`error: the anchor tx mined (${txHash}) but the record could not be read back: ${e.message}\n`);
    return EXIT.IO;
  }
  const chain = {
    authorBound: Boolean(rec.authorBound),
    blockNumber: Number(rec.blockNumber),
    blockTime: Number(rec.timestamp),
    chainId: Number(chainId),
    contract: contractAddr.toLowerCase(),
    contributor: String(rec.contributor).toLowerCase(),
    txHash: String(txHash).toLowerCase(),
  };

  const built = binding.buildAnchoredReceipt({
    digest: d.digest,
    kind: d.kind,
    how: d.how,
    artifactLabel: path.basename(artifactPath),
    chain,
  });
  if (!built.ok) {
    writeErr(
      `error: the anchor tx mined (${txHash}) but the anchored receipt could not be assembled ` +
        `(${built.reason}): ${built.detail || ""}\n`
    );
    return EXIT.IO;
  }
  const receipt = built.receipt;
  // The canonical byte serialization (the core's sorted-key container: stringify + newline IS it).
  const receiptBytes = JSON.stringify(receipt) + "\n";

  let outPath = null;
  if (opts.out) {
    outPath = path.resolve(opts.out); // explicit, caller-chosen path — never a silent cwd drop
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, receiptBytes);
    } catch (e) {
      writeErr(`error: cannot write receipt ${opts.out}: ${e.message}\n`);
      return EXIT.IO;
    }
  }

  if (opts.json) {
    write(
      JSON.stringify(
        {
          ok: true,
          verdict: "ANCHORED",
          artifact: opts.artifact,
          digest: d.digest,
          artifactKind: d.kind,
          how: d.how,
          chain,
          receiptPath: outPath,
          receipt,
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write("anchor-artifact: ANCHORED\n");
    write(`  digest:       ${d.digest}\n`);
    write(`  kind:         ${d.kind}\n`);
    write(`  chainId:      ${chain.chainId}  contract: ${chain.contract}\n`);
    write(`  tx:           ${chain.txHash}  (block ${chain.blockNumber}, blockTime ${chain.blockTime})\n`);
    write(`  contributor:  ${chain.contributor}  authorBound: ${chain.authorBound}\n`);
    if (outPath) {
      write(`  receipt written: ${outPath}\n`);
    } else {
      write("  receipt (NOT written to disk; pass --out <path> to save it):\n");
      write(receiptBytes);
    }
    write(`  NOTE: ${binding.ANCHOR_TRUST_NOTE}\n`);
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------------------------------
// vh verify-anchored
// ---------------------------------------------------------------------------------------------------

/**
 * Run `vh verify-anchored`. OFFLINE by default (pure T-70.1 binding verify); with BOTH an endpoint
 * (--rpc, or an injected provider) AND --contract it additionally authenticates the registry (the
 * EXISTING EPIC-11 identity probe) and re-checks the receipt's chain facts against the chain.
 * Never signs; needs no key. Returns the process exit code (0 ACCEPTED / 3 REJECTED / 2 / 1).
 *
 * @param {object} opts { receipt, artifact, rpc?, contract?, json?, provider?, ethers? }
 * @param {{write?:Function, writeErr?:Function}} [io]
 * @returns {Promise<number>}
 */
async function runVerifyAnchored(opts, io = {}) {
  const write = io.write || ((s) => process.stdout.write(s));
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  const ethersLib = opts.ethers || require("ethers");

  const hasEndpoint = opts.provider !== undefined || opts.rpc !== undefined;
  const hasContract = opts.contract !== undefined;
  const mode = hasEndpoint || hasContract ? "rpc" : "offline";

  const reject = (reason, detail, field) => {
    if (opts.json) {
      write(JSON.stringify({ ok: false, verdict: "REJECTED", mode, reason, field, detail }, null, 2) + "\n");
    } else {
      writeErr(`verify-anchored: REJECTED (${reason})${detail ? `: ${detail}` : ""}\n`);
    }
    return EXIT.REJECT;
  };

  if (!opts.receipt || !opts.artifact) {
    writeErr("error: `vh verify-anchored` requires a <receipt> and a <sealed-file>\n" + VERIFY_ANCHORED_USAGE);
    return EXIT.USAGE;
  }
  if (hasEndpoint !== hasContract) {
    writeErr(
      "error: the on-chain re-check needs BOTH --rpc <url> AND --contract <address> " +
        "(omit both for the offline binding check)\n" +
        VERIFY_ANCHORED_USAGE
    );
    return EXIT.USAGE;
  }
  if (hasContract && !ethersLib.isAddress(opts.contract)) {
    writeErr(`error: invalid contract address: ${opts.contract}\n`);
    return EXIT.USAGE;
  }

  const receipt = readJson("receipt", opts.receipt, writeErr);
  if (receipt === null) return EXIT.IO;
  const artifact = readJson("artifact", opts.artifact, writeErr);
  if (artifact === null) return EXIT.IO;

  // ---- leg 1 (always): the pure, offline binding verify — the T-70.1 core, reused verbatim ----
  const v = binding.verifyAnchoredReceipt({ receipt, artifact });
  if (!v.ok) return reject(v.reason, v.detail, v.field);

  // ---- offline mode stops here: the binding holds; the chain facts remain the anchorer's CLAIM ----
  if (!hasContract) {
    if (opts.json) {
      write(
        JSON.stringify(
          {
            ok: true,
            verdict: "ACCEPTED",
            mode,
            digest: v.digest,
            artifactKind: receipt.artifactKind,
            chain: v.chain,
            registry: null,
            note:
              "OFFLINE verify: the receipt binds this exact artifact, but its chain facts were NOT " +
              "re-checked. Pass --rpc <url> --contract <addr> to confirm them against the chain.",
          },
          null,
          2
        ) + "\n"
      );
    } else {
      write("verify-anchored: ACCEPTED (offline binding check)\n");
      write(`  digest:       ${v.digest}\n`);
      write(`  kind:         ${receipt.artifactKind}\n`);
      write(
        `  chain CLAIM:  chainId ${v.chain.chainId}, contract ${v.chain.contract}, tx ${v.chain.txHash}, ` +
          `block ${v.chain.blockNumber}, blockTime ${v.chain.blockTime}, contributor ${v.chain.contributor}, ` +
          `authorBound ${v.chain.authorBound}\n`
      );
      write(
        "  NOTE: offline mode did NOT re-check the chain facts — they are the anchorer's claim. " +
          "Pass --rpc <url> --contract <addr> to confirm them against the chain.\n"
      );
    }
    return EXIT.OK;
  }

  // ---- leg 2 (--rpc --contract): authenticate the registry FIRST (the EXISTING EPIC-11 identity
  //      probe — no record is believed until the contract self-identifies on the receipt's chain),
  //      then re-check every chain fact the receipt claims. ----
  const provider = opts.provider || new ethersLib.JsonRpcProvider(opts.rpc);
  let auth;
  try {
    auth = await assertRegistry({
      provider,
      contractAddress: opts.contract,
      expectedChainId: v.chain.chainId,
      ethers: ethersLib,
    });
  } catch (e) {
    if (e && e.code === "REGISTRY_AUTH_FAILED") {
      // The EXISTING identity-probe reject, surfaced verbatim (wrong address / non-registry / wrong chain).
      return reject("registry-auth-failed", e.message);
    }
    if (isGenuineRpcError(e)) {
      writeErr(`error: RPC failure during the registry identity check: ${e.message}\n`);
      return EXIT.IO;
    }
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }

  const contractLc = ethersLib.getAddress(opts.contract).toLowerCase();
  if (contractLc !== v.chain.contract) {
    return reject(
      "contract-mismatch",
      `the receipt was anchored on contract ${v.chain.contract} but you passed --contract ${contractLc} — ` +
        "a record on a different contract says nothing about this receipt"
    );
  }

  const contract = new ethersLib.Contract(ethersLib.getAddress(opts.contract), ABI, provider);
  let rec;
  try {
    rec = await contract.getRecord(v.digest);
  } catch (e) {
    const named = namedRegistryReject(e, ethersLib);
    if (named && named.startsWith("NotAnchored")) {
      return reject(
        "not-anchored-on-chain",
        `the registry has NO record for digest ${v.digest} (${named}) — the receipt's chain facts are not real`
      );
    }
    if (isGenuineRpcError(e)) {
      writeErr(`error: RPC failure while reading the record back: ${e.message}\n`);
      return EXIT.IO;
    }
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }
  const onchain = {
    contributor: String(rec.contributor).toLowerCase(),
    authorBound: Boolean(rec.authorBound),
    blockNumber: Number(rec.blockNumber),
    blockTime: Number(rec.timestamp),
  };
  if (onchain.contributor !== v.chain.contributor) {
    return reject(
      "contributor-mismatch",
      `on-chain contributor ${onchain.contributor} != receipt contributor ${v.chain.contributor}`
    );
  }
  if (onchain.authorBound !== v.chain.authorBound) {
    return reject(
      "author-bound-mismatch",
      `on-chain authorBound ${onchain.authorBound} != receipt authorBound ${v.chain.authorBound}`
    );
  }
  if (onchain.blockNumber !== v.chain.blockNumber) {
    return reject(
      "block-number-mismatch",
      `on-chain record block ${onchain.blockNumber} != receipt blockNumber ${v.chain.blockNumber}`
    );
  }
  if (onchain.blockTime !== v.chain.blockTime) {
    return reject(
      "block-time-mismatch",
      `on-chain record timestamp ${onchain.blockTime} != receipt blockTime ${v.chain.blockTime}`
    );
  }

  // The receipt's txHash must be a REAL mined transaction, in the recorded block, targeting the
  // recorded contract — an edited txHash cannot masquerade as the anchoring write.
  let txr;
  try {
    txr = await provider.getTransactionReceipt(v.chain.txHash);
  } catch (e) {
    if (isGenuineRpcError(e)) {
      writeErr(`error: RPC failure while re-checking the anchoring tx: ${e.message}\n`);
      return EXIT.IO;
    }
    writeErr(`error: ${e.message}\n`);
    return EXIT.IO;
  }
  if (!txr) {
    return reject(
      "tx-not-found",
      `no transaction ${v.chain.txHash} exists on this chain — the receipt's txHash is not real`
    );
  }
  if (Number(txr.blockNumber) !== v.chain.blockNumber) {
    return reject(
      "tx-block-mismatch",
      `tx ${v.chain.txHash} mined in block ${Number(txr.blockNumber)}, not the receipt's block ${v.chain.blockNumber}`
    );
  }
  if (txr.to && String(txr.to).toLowerCase() !== v.chain.contract) {
    return reject(
      "tx-target-mismatch",
      `tx ${v.chain.txHash} targets ${String(txr.to).toLowerCase()}, not the receipt's contract ${v.chain.contract}`
    );
  }

  if (opts.json) {
    write(
      JSON.stringify(
        {
          ok: true,
          verdict: "ACCEPTED",
          mode,
          digest: v.digest,
          artifactKind: receipt.artifactKind,
          chain: v.chain,
          registry: jsonRegistryBlock(auth),
          onchain,
          note:
            "The registry was authenticated (EPIC-11 identity probe) and every chain fact in the " +
            "receipt matches the on-chain record and its mined transaction.",
        },
        null,
        2
      ) + "\n"
    );
  } else {
    write("verify-anchored: ACCEPTED (offline binding + on-chain re-check)\n");
    write(formatRegistryLine(auth) + "\n");
    write(`  digest:       ${v.digest}\n`);
    write(`  kind:         ${receipt.artifactKind}\n`);
    write(
      `  on-chain:     contributor ${onchain.contributor}, authorBound ${onchain.authorBound}, ` +
        `block ${onchain.blockNumber}, blockTime ${onchain.blockTime} — ALL match the receipt\n`
    );
    write(`  tx:           ${v.chain.txHash} found in block ${Number(txr.blockNumber)}, targeting the recorded contract\n`);
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------------------------------
// cmd wrappers (argv -> opts -> run). io is optional and defaults to the process streams.
// ---------------------------------------------------------------------------------------------------

async function cmdAnchorArtifact(argv, io = {}) {
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  let opts;
  try {
    opts = parseAnchorArtifactArgs(argv);
  } catch (e) {
    writeErr(`error: ${e.message}\n` + ANCHOR_ARTIFACT_USAGE);
    return EXIT.USAGE;
  }
  return runAnchorArtifact(
    {
      ...opts,
      // The same env fallbacks the other write verbs honor — for the ADDRESS and ENDPOINT only.
      // The signing key NEVER has an implicit env fallback: only --key-env/--key-file name it.
      contract: opts.contract || process.env.VH_CONTRACT,
      rpc: opts.rpc || process.env.VH_RPC_URL || process.env.AMOY_RPC_URL,
    },
    io
  );
}

async function cmdVerifyAnchored(argv, io = {}) {
  const writeErr = io.writeErr || ((s) => process.stderr.write(s));
  let opts;
  try {
    opts = parseVerifyAnchoredArgs(argv);
  } catch (e) {
    writeErr(`error: ${e.message}\n` + VERIFY_ANCHORED_USAGE);
    return EXIT.USAGE;
  }
  // No env fallbacks here on purpose: verify-anchored is OFFLINE unless the caller EXPLICITLY passes
  // both --rpc and --contract (an env var must never silently flip a verify onto a network).
  return runVerifyAnchored(opts, io);
}

module.exports = {
  EXIT,
  ANCHOR_ARTIFACT_USAGE,
  VERIFY_ANCHORED_USAGE,
  parseAnchorArtifactArgs,
  parseVerifyAnchoredArgs,
  runAnchorArtifact,
  runVerifyAnchored,
  cmdAnchorArtifact,
  cmdVerifyAnchored,
  namedRegistryReject,
  ABI,
};

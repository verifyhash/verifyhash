"use strict";

// `vh verify <path>` — tamper check against the on-chain registry.
//
// The flow:
//   1. Recompute the content hash of the target path (file -> keccak256 of bytes;
//      directory -> sorted-leaf Merkle root), using the exact same logic anchoring used
//      (see cli/hash.js). The whole point: if a single byte of the file changed since it
//      was anchored, this recomputed hash will differ.
//   2. Read ContributionRegistry.getRecord(hash) for that recomputed hash.
//        * If a record exists for it -> the file is byte-for-byte what was anchored: MATCH.
//          We report the recorded contributor and timestamp.
//        * If getRecord reverts with NotAnchored (no record for this exact hash) -> either the
//          content was never anchored, or it was anchored and has since been TAMPERED with so its
//          hash no longer matches: MISMATCH.
//
// This is intentionally read-only: it needs only a provider (no signer, no key, no funds), and it
// never writes to the chain. Verification of a public, immutable record should never require a
// private key.

const { hashPath } = require("./hash");

const ARTIFACT = require("../artifacts/contracts/ContributionRegistry.sol/ContributionRegistry.json");
const ABI = ARTIFACT.abi;

// Possible outcomes of a verify run.
const STATUS = Object.freeze({
  MATCH: "MATCH", // recomputed hash is anchored on-chain
  MISMATCH: "MISMATCH", // recomputed hash is NOT anchored (never anchored, or content was tampered)
});

/**
 * Recompute the content hash for a filesystem path: a file hashes its keccak256 digest, a
 * directory its sorted-leaf Merkle root — matching exactly what `vh anchor` would have stored.
 * @param {string} targetPath
 * @returns {{ contentHash: string, kind: "file"|"dir" }}
 */
function contentHashForPath(targetPath) {
  const res = hashPath(targetPath);
  return { contentHash: res.root, kind: res.kind };
}

/**
 * Decide whether a getRecord() failure means "no such record" (NotAnchored, an expected MISMATCH)
 * versus a real, unexpected error (bad RPC, wrong address, network down) we must surface.
 *
 * The contract reverts with the custom error `NotAnchored(bytes32)` when a hash was never anchored.
 * We also fall back to its 4-byte selector and a couple of generic revert-shaped signals, so this
 * keeps working even if an RPC layer doesn't decode the named custom error for us.
 */
function isNotAnchoredError(err, ethersLib, notAnchoredSelector) {
  if (!err) return false;
  // ethers v6 decodes known custom errors onto err.revert / err.errorName.
  if (err.errorName === "NotAnchored") return true;
  if (err.revert && err.revert.name === "NotAnchored") return true;

  // Fall back to the raw revert data carrying the NotAnchored selector.
  const data =
    (err.data && (typeof err.data === "string" ? err.data : err.data.data)) ||
    (err.info && err.info.error && err.info.error.data) ||
    null;
  if (typeof data === "string" && notAnchoredSelector && data.startsWith(notAnchoredSelector)) {
    return true;
  }

  // Last-resort textual match (some providers only give a message).
  const msg = String((err && err.message) || "");
  return /NotAnchored/.test(msg);
}

/**
 * Verify a path against the on-chain registry. Read-only: requires a provider, never a signer.
 *
 * @param {object} opts
 * @param {string}  opts.path             path to a file or directory to verify
 * @param {string}  opts.contractAddress  deployed ContributionRegistry address to read from
 * @param {object}  opts.provider         ethers v6 Provider (read-only RPC connection)
 * @param {object} [opts.ethers]          ethers v6 module (defaults to the bundled one)
 * @param {(s:string)=>void}[opts.log]    sink for human output (defaults to process.stdout)
 * @returns {Promise<{
 *   status: "MATCH"|"MISMATCH",
 *   contentHash: string,
 *   kind: "file"|"dir",
 *   path: string,
 *   contributor: string|null,
 *   timestamp: bigint|null,
 *   blockNumber: bigint|null,
 *   uri: string|null,
 * }>}
 */
async function runVerify(opts) {
  const ethersLib = opts.ethers || require("ethers");
  const log = opts.log || ((s) => process.stdout.write(s));

  const { path: targetPath, contractAddress, provider } = opts;
  if (!targetPath) throw new Error("verify requires a <path>");
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

  const { contentHash, kind } = contentHashForPath(targetPath);

  const iface = new ethersLib.Interface(ABI);
  const notAnchoredSelector = iface.getError("NotAnchored").selector;

  const contract = new ethersLib.Contract(
    ethersLib.getAddress(contractAddress),
    ABI,
    provider
  );

  let record = null;
  try {
    record = await contract.getRecord(contentHash);
  } catch (err) {
    if (isNotAnchoredError(err, ethersLib, notAnchoredSelector)) {
      record = null; // not anchored -> MISMATCH below
    } else {
      throw err; // genuine failure (network/address/etc.) — don't masquerade as a tamper result.
    }
  }

  const result = {
    contentHash,
    kind,
    path: targetPath,
    contributor: null,
    timestamp: null,
    blockNumber: null,
    uri: null,
  };

  if (record === null) {
    result.status = STATUS.MISMATCH;
  } else {
    result.status = STATUS.MATCH;
    result.contributor = record.contributor;
    result.timestamp = BigInt(record.timestamp);
    result.blockNumber = BigInt(record.blockNumber);
    result.uri = record.uri;
  }

  log(formatVerify(result) + "\n");
  return result;
}

/** Render a verify result as the human-readable block the CLI prints. */
function formatVerify(r) {
  const lines = [
    `  path:         ${r.path}  (${r.kind})`,
    `  contentHash:  ${r.contentHash}`,
    `  result:       ${r.status}`,
  ];
  if (r.status === STATUS.MATCH) {
    const ts = r.timestamp == null ? "(unknown)" : isoFromUnix(r.timestamp);
    lines.push(
      `  contributor:  ${r.contributor}`,
      `  timestamp:    ${r.timestamp} (${ts})`
    );
    if (r.uri) lines.push(`  uri:          ${r.uri}`);
  } else {
    lines.push(
      "  This content's hash is NOT anchored on-chain.",
      "  It was either never anchored, or it has been modified since it was anchored (tampered)."
    );
  }
  return lines.join("\n");
}

/** Format a unix-seconds bigint as an ISO-8601 UTC string for human display. */
function isoFromUnix(unixSeconds) {
  try {
    return new Date(Number(unixSeconds) * 1000).toISOString();
  } catch (_) {
    return "(unparseable)";
  }
}

module.exports = {
  runVerify,
  formatVerify,
  contentHashForPath,
  isNotAnchoredError,
  STATUS,
  ABI,
};

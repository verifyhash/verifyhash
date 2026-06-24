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

const { hashPath, hashGit } = require("./hash");
const { readReceipt, diffManifest } = require("./receipt");
const {
  assertRegistry,
  formatRegistryLine,
  formatSkippedLine,
} = require("./registry");

const ARTIFACT = require("./core/registryArtifact");
const ABI = ARTIFACT.abi;

// Possible outcomes of a verify run.
const STATUS = Object.freeze({
  MATCH: "MATCH", // recomputed hash is anchored on-chain
  MISMATCH: "MISMATCH", // recomputed hash is NOT anchored (never anchored, or content was tampered)
});

/**
 * Recompute the content hash for a filesystem path: a file hashes its keccak256 digest, a
 * directory its sorted-leaf Merkle root — matching exactly what `vh anchor` would have stored. For a
 * directory the per-file leaves are returned too (so a `--receipt` diff can localize a change).
 *
 * With `opts.git`, the root and leaves are recomputed over EXACTLY the files git tracks at `opts.ref`
 * (default HEAD) — the SAME reproducible enumeration `vh anchor <dir> --git` used and `vh hash --git`
 * defines (T-8.1). Untracked junk in the work tree is ignored, so the verdict depends only on the
 * tracked content. The resolved commit oid + repo-relative scope are also returned for display (an
 * untrusted provenance hint, never the verdict).
 *
 * @param {string} targetPath
 * @param {{ git?: boolean, ref?: string }} [opts]
 * @returns {{ contentHash: string, kind: "file"|"dir",
 *            leaves: Array<{path:string,contentHash:string,leaf:string}>|null,
 *            git: {commit:string,scope:string}|null }}
 */
function contentHashForPath(targetPath, opts = {}) {
  if (opts.git) {
    const res = hashGit(targetPath, { ref: opts.ref });
    const leaves = res.leaves.map((l) => ({
      path: l.path,
      contentHash: l.contentHash,
      leaf: l.leaf,
    }));
    return {
      contentHash: res.root,
      kind: "dir",
      leaves,
      git: { commit: res.commit, scope: res.scope },
    };
  }
  const res = hashPath(targetPath);
  const leaves =
    res.kind === "dir" && Array.isArray(res.leaves)
      ? res.leaves.map((l) => ({ path: l.path, contentHash: l.contentHash, leaf: l.leaf }))
      : null;
  return { contentHash: res.root, kind: res.kind, leaves, git: null };
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
 * The AUTHORITATIVE verdict is always re-deriving the content hash here and comparing it to the
 * on-chain record (MATCH iff the recomputed hash is anchored). An optional `receiptPath` adds a
 * convenience: for a directory it loads the receipt's per-file manifest and prints a precise
 * ADDED/REMOVED/CHANGED diff so a MISMATCH localizes to specific files. The receipt is an UNTRUSTED
 * hint (docs/TRUST-BOUNDARIES.md) — it only says *which* file diverged, never *whether* the content
 * is valid. The diff is reported even on MATCH (it should be empty); a receipt for a different repo
 * shows up as a fully-divergent diff, never a silent mislabel.
 *
 * @param {object} opts
 * @param {string}  opts.path             path to a file or directory to verify
 * @param {boolean}[opts.git]             recompute the root over EXACTLY the git-tracked files (T-8.1)
 * @param {string} [opts.ref]             with git: which commit's tracked set (default HEAD)
 * @param {string}  opts.contractAddress  deployed ContributionRegistry address to read from
 * @param {object}  opts.provider         ethers v6 Provider (read-only RPC connection)
 * @param {string} [opts.receiptPath]     optional receipt whose manifest localizes a dir diff
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
 *   manifestDiff: object|null,   // present when a --receipt manifest was applied to a dir
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

  const { contentHash, kind, leaves, git } = contentHashForPath(targetPath, {
    git: opts.git,
    ref: opts.ref,
  });

  // T-11.2: authenticate the registry BEFORE any record read — no verdict is reported until we have
  // confirmed there is a real verifyhash ContributionRegistry at this address (unless the caller
  // explicitly, loudly opts out with skipIdentityCheck for a known not-yet-deployed/local-dev target).
  let registryAuth = null;
  if (!opts.skipIdentityCheck) {
    registryAuth = await assertRegistry({ provider, contractAddress, ethers: ethersLib });
  }

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
    git, // { commit, scope } when --git was used; null otherwise (untrusted provenance hint)
    // T-11.2: the resolved registry identity (or null when the check was skipped). The human block and
    // --json both surface this so a user can SEE the registry was authenticated before the verdict.
    registry: registryAuth,
    identitySkipped: Boolean(opts.skipIdentityCheck),
    contributor: null,
    authorBound: null,
    timestamp: null,
    blockNumber: null,
    uri: null,
    manifestDiff: null,
  };

  if (record === null) {
    result.status = STATUS.MISMATCH;
  } else {
    result.status = STATUS.MATCH;
    result.contributor = record.contributor;
    result.authorBound = Boolean(record.authorBound);
    result.timestamp = BigInt(record.timestamp);
    result.blockNumber = BigInt(record.blockNumber);
    result.uri = record.uri;
  }

  // Optional, UNTRUSTED localization: if a --receipt was given, diff its recorded manifest against
  // the freshly-recomputed per-file leaves. This never changes the MATCH/MISMATCH verdict above
  // (which is the authoritative re-derive-and-compare-to-chain check); it only says WHICH file moved.
  if (opts.receiptPath) {
    result.manifestDiff = _buildManifestDiff({
      receiptPath: opts.receiptPath,
      kind,
      leaves,
      contentHash,
    });
  }

  log(formatVerify(result) + "\n");
  return result;
}

/**
 * Load the receipt at `receiptPath` and diff its manifest against the recomputed `leaves` for a
 * directory target. Returns a structured diff (or an `error`/`note` object that formatVerify will
 * render) — it never throws on a missing/foreign receipt, because the receipt is only an UNTRUSTED
 * convenience and must not be able to break the authoritative verify.
 */
function _buildManifestDiff({ receiptPath, kind, leaves, contentHash }) {
  if (kind !== "dir") {
    return { note: "--receipt manifest diff applies to a directory target only; ignored for a file." };
  }
  let receipt;
  try {
    receipt = readReceipt(receiptPath);
  } catch (e) {
    return { error: `could not read receipt: ${e.message}` };
  }
  if (!Array.isArray(receipt.manifest) || receipt.manifest.length === 0) {
    return {
      error:
        "receipt has no manifest (it was written by an older build or for a file). " +
        "Re-anchor with `vh anchor <dir> --receipt <p>` to record a manifest.",
    };
  }
  // Cross-check that the receipt is even *about* this anchored hash, when it records one. A receipt
  // for a different repo records a different contentHash; flagging it makes a foreign receipt show up
  // as "different repo" rather than silently mislabeling unrelated files.
  const receiptHashMismatch =
    typeof receipt.contentHash === "string" &&
    receipt.contentHash.toLowerCase() !== contentHash.toLowerCase();
  const diff = diffManifest(receipt.manifest, leaves || []);
  return { ...diff, receiptContentHash: receipt.contentHash || null, receiptHashMismatch };
}

/** Render a verify result as the human-readable block the CLI prints. */
function formatVerify(r) {
  const lines = [
    `  path:         ${r.path}  (${r.kind})`,
    `  contentHash:  ${r.contentHash}`,
  ];
  // T-11.2: the registry-authentication confirmation (or the loud skip warning) so the user can SEE
  // the preflight ran before believing the verdict below.
  if (r.identitySkipped) {
    lines.push(formatSkippedLine());
  } else if (r.registry) {
    lines.push(formatRegistryLine(r.registry));
  }
  if (r.git) {
    // Show WHICH commit's tracked set produced this root — an untrusted provenance hint, never the
    // verdict (that is the MATCH/MISMATCH below, recomputed root vs the on-chain record).
    lines.push(
      `  git commit:   ${r.git.commit}  (untrusted provenance hint)`,
      `  git scope:    ${r.git.scope}`
    );
  }
  lines.push(`  result:       ${r.status}`);
  if (r.status === STATUS.MATCH) {
    const ts = r.timestamp == null ? "(unknown)" : isoFromUnix(r.timestamp);
    // Spell out exactly what `contributor` is allowed to mean for THIS record. A commit-reveal
    // record (authorBound) is a front-running-resistant claim; a one-shot anchor is not.
    const attribution = r.authorBound
      ? "proven first claimant (commit-reveal, front-running-resistant)"
      : "first anchorer only — NOT proven authorship (anyone could have anchored this hash)";
    lines.push(
      `  contributor:  ${r.contributor}`,
      `  attribution:  ${attribution}`,
      `  timestamp:    ${r.timestamp} (${ts})`
    );
    if (r.uri) lines.push(`  uri:          ${r.uri}`);
  } else {
    lines.push(
      "  This content's hash is NOT anchored on-chain.",
      "  It was either never anchored, or it has been modified since it was anchored (tampered)."
    );
  }
  if (r.manifestDiff) {
    for (const line of formatManifestDiff(r.manifestDiff, r.status)) lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Render the optional --receipt manifest diff. Always leads with the trust caveat so a reader never
 * mistakes the per-file localization for the authoritative verdict (which is the MATCH/MISMATCH above,
 * derived from the on-chain record).
 * @param {object} d the manifestDiff object built by _buildManifestDiff
 * @param {string} status the authoritative MATCH/MISMATCH
 * @returns {string[]} lines
 */
function formatManifestDiff(d, status) {
  const out = ["", "  --- receipt manifest diff (UNTRUSTED hint) ---"];
  out.push(
    "  NOTE: the receipt is an untrusted convenience. The authoritative verdict is the",
    "  MATCH/MISMATCH above (recomputed root vs the on-chain record). This diff only localizes",
    "  WHICH file diverged; it cannot make content valid or invalid on its own."
  );
  if (d.note) {
    out.push(`  ${d.note}`);
    return out;
  }
  if (d.error) {
    out.push(`  receipt unusable: ${d.error}`);
    return out;
  }
  if (d.receiptHashMismatch) {
    out.push(
      "  WARNING: this receipt's recorded root does NOT match the recomputed root for this path.",
      `    receipt root:    ${d.receiptContentHash}`,
      "  The receipt is for a DIFFERENT directory snapshot (or a different repo). The per-file",
      "  diff below is between two unrelated manifests and should be read as fully divergent."
    );
  }
  if (d.identical) {
    out.push("  manifest: IDENTICAL — every file matches the receipt (no ADDED/REMOVED/CHANGED).");
    return out;
  }
  out.push(
    `  files: ${d.changed.length} CHANGED, ${d.added.length} ADDED, ${d.removed.length} REMOVED` +
      ` (${d.unchanged.length} unchanged)`
  );
  for (const c of d.changed) {
    out.push(`    CHANGED  ${c.path}`);
    out.push(`               old: ${c.oldContentHash}`);
    out.push(`               new: ${c.newContentHash}`);
  }
  for (const a of d.added) {
    out.push(`    ADDED    ${a.path}  (${a.contentHash})   present now, not in the receipt`);
  }
  for (const rm of d.removed) {
    out.push(`    REMOVED  ${rm.path}  (${rm.contentHash})   in the receipt, gone now`);
  }
  return out;
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
  formatManifestDiff,
  contentHashForPath,
  isNotAnchoredError,
  STATUS,
  ABI,
};

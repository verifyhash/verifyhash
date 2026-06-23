"use strict";

// `vh reputation <addr> [--contract a] [--rpc u] [--json] [--skip-identity-check]` — a read-only,
// verifiable CONTRIBUTION SCORE for one contributor (T-12.2).
//
// WHAT THIS IS
//   A TRANSPARENT, DOCUMENTED aggregate over the records the registry holds under one address. It is
//   purely DERIVED from on-chain state and re-derivable by anyone with the same RPC: total records,
//   the authorBound (proven first claimant / commit-reveal) vs anchor-only (front-runnable "first
//   anchorer") breakdown, the lineage-root (parent == 0x0) vs revision (parent != 0x0) breakdown, and
//   the earliest/latest blockNumber + timestamp seen.
//
// WHAT THIS IS NOT (the trust posture — see docs/TRUST-BOUNDARIES.md, mirrored from list.js/verify.js)
//   * It is NOT A TOKEN and NOT TRANSFERABLE. It holds no value, grants no rights; it is a view.
//   * A score is only as meaningful as the `authorBound` bar. An anchor-only count is EXPLICITLY
//     WEAKER, because a plain `anchor()` is front-runnable: anyone who saw a contentHash could have
//     anchored it, so an anchor-only record proves order-of-anchoring, never authorship. The breakdown
//     therefore reports authorBound and anchor-only SEPARATELY and NEVER collapses them into one number
//     that would hide the difference.
//   * It does NOT validate the CONTENT of any record. "This address has N records" says nothing about
//     whether those records correspond to real, untampered bytes — re-derive the content hash and run
//     `vh verify` for that.
//   * Any tradeable/reputation-TOKEN layer is a separate, human-gated decision (D-2 / P-1 in
//     STRATEGY.md) and is NOT built here.
//
// READ-ONLY BY CONSTRUCTION: takes a PROVIDER only, never a signer and never a key. It runs the
// EPIC-11 `assertRegistry` preflight FIRST (reused from cli/registry.js) so the score is never reported
// against an unauthenticated/look-alike contract, then pages through the contract's
// `getRecordsByContributor` clamped view (the T-12.1 per-contributor index).

const ARTIFACT = require("../artifacts/contracts/ContributionRegistry.sol/ContributionRegistry.json");
const ABI = ARTIFACT.abi;

// Reuse the lineage-root predicate so reputation, show and list never disagree about what a "root"
// (parent == bytes32(0)) is. T-10.1.
const { isRoot } = require("./show");
const { isoFromUnix, ATTRIBUTION_PROVEN, ATTRIBUTION_ANCHOR_ONLY } = require("./list");
const {
  assertRegistry,
  formatRegistryLine,
  formatSkippedLine,
  jsonRegistryBlock,
  jsonSkippedBlock,
} = require("./registry");

// Default page size for walking getRecordsByContributor(). The contract clamps a window to what that
// contributor actually owns, so this is purely a request-batching knob; it never affects which records
// come back. Mirrors list.js's DEFAULT_PAGE.
const DEFAULT_PAGE = 100;

// The trust caveat that LEADS every human-readable run. It is the load-bearing part of this command:
// a reader must see, before any number, that the score is only as meaningful as the authorBound bar,
// that it does not validate content, and that it is not a token. Wording is kept consistent with
// cli/list.js's TRUST_CAVEAT and cli/verify.js's attribution language so the read commands never drift.
const TRUST_CAVEAT = [
  "NOTE: this score is a TRANSPARENT, on-chain-DERIVED aggregate — NOT a reputation token, NOT",
  "transferable, and re-derivable by anyone from the same registry. It is only as meaningful as the",
  "authorBound bar: authorBound records are proven first claimants (commit-reveal); anchor-only records",
  "are merely the FIRST ANCHORER and are WEAKER, because a plain anchor() is front-runnable (anyone who",
  "saw the contentHash could have anchored it). The two are reported SEPARATELY and never collapsed into",
  "one number. The score does NOT validate the CONTENT of any record — re-derive the hash and run",
  "`vh verify` for that. Any tradeable/reputation-token layer is gated on a human decision (D-2 / P-1).",
].join("\n");

/**
 * Page through ONE contributor's records using the clamped getRecordsByContributor read (T-12.1).
 * Read-only: uses only the provider. Walks fixed-size pages and stops on a short/empty page, exactly
 * as the contract's NatSpec documents (no need to know the count up front, never a boundary revert).
 * Returns normalized record objects in that contributor's own insertion order.
 *
 * @param {object} contract  an ethers v6 Contract bound to a provider
 * @param {string} contributor  the 20-byte address (already validated/checksummed by the caller)
 * @param {number} [pageSize]
 * @returns {Promise<Array<{
 *   contentHash:string, contributor:string, authorBound:boolean,
 *   timestamp:bigint, blockNumber:bigint, uri:string, parent:string
 * }>>}
 */
async function readContributorRecords(contract, contributor, pageSize = DEFAULT_PAGE) {
  const out = [];
  for (let start = 0; ; start += pageSize) {
    const [contentHashes, records] = await contract.getRecordsByContributor(
      contributor,
      start,
      pageSize
    );
    // The contract clamps to what this contributor owns: a window at/past the end returns empty arrays
    // (never a revert), so an empty/short page is the stop signal.
    if (contentHashes.length === 0) break;
    for (let i = 0; i < contentHashes.length; i++) {
      const r = records[i];
      out.push({
        contentHash: contentHashes[i],
        contributor: r.contributor,
        authorBound: Boolean(r.authorBound),
        timestamp: BigInt(r.timestamp),
        blockNumber: BigInt(r.blockNumber),
        uri: r.uri,
        // The immutable lineage edge (T-10.1). Normalized to a lowercase 0x string; a root reads back
        // as the 32-byte zero hash (isRoot() flags it below).
        parent: String(r.parent).toLowerCase(),
      });
    }
    // A short page (fewer than requested) also means we reached the end; stop without an extra read.
    if (contentHashes.length < pageSize) break;
  }
  return out;
}

/**
 * Compute the TRANSPARENT aggregate score over a contributor's normalized records. Pure: no I/O, fully
 * re-derivable from the same input. Returns the documented breakdowns and block/time bounds. The
 * authorBound and anchor-only counts are kept SEPARATE (never summed into a single opaque number).
 *
 * @param {Array} records  normalized records from readContributorRecords (any order)
 * @returns {{
 *   total:number,
 *   authorBound:number, anchorOnly:number,
 *   lineageRoots:number, revisions:number,
 *   earliest:{blockNumber:bigint, timestamp:bigint}|null,
 *   latest:{blockNumber:bigint, timestamp:bigint}|null
 * }}
 */
function computeScore(records) {
  let authorBound = 0;
  let anchorOnly = 0;
  let lineageRoots = 0;
  let revisions = 0;
  let earliest = null; // by blockNumber (on-chain ordering), tie-broken by timestamp
  let latest = null;

  for (const r of records) {
    if (r.authorBound) authorBound++;
    else anchorOnly++;

    if (isRoot(r.parent)) lineageRoots++;
    else revisions++;

    const point = { blockNumber: r.blockNumber, timestamp: r.timestamp };
    if (earliest === null || r.blockNumber < earliest.blockNumber) earliest = point;
    if (latest === null || r.blockNumber > latest.blockNumber) latest = point;
  }

  return {
    total: records.length,
    authorBound,
    anchorOnly,
    lineageRoots,
    revisions,
    earliest,
    latest,
  };
}

/**
 * Shape the score + bounds for `--json`: BigInts become Numbers (unix seconds / block heights fit
 * safely), block/time bounds carry an ISO string, and a zero-record address serializes with total: 0
 * and null bounds (distinguishable from an error). The breakdowns stay separate fields.
 */
function jsonScore(addr, score, registryBlock) {
  const bound = (b) =>
    b === null
      ? null
      : {
          blockNumber: Number(b.blockNumber),
          timestamp: Number(b.timestamp),
          timestampISO: isoFromUnix(b.timestamp),
        };
  return {
    address: addr,
    registry: registryBlock,
    total: score.total,
    // Reported SEPARATELY and never collapsed: a consumer that wants a single number must decide how to
    // weight a front-runnable anchor-only record itself.
    authorBound: score.authorBound,
    anchorOnly: score.anchorOnly,
    attribution: {
      authorBound: ATTRIBUTION_PROVEN,
      anchorOnly: ATTRIBUTION_ANCHOR_ONLY,
    },
    lineageRoots: score.lineageRoots,
    revisions: score.revisions,
    earliest: bound(score.earliest),
    latest: bound(score.latest),
  };
}

/** Render the score as the human-readable block the CLI prints (after the trust caveat + registry line). */
function formatScore(addr, score, opts = {}) {
  const lines = [];
  lines.push(`  contributor:   ${addr}`);
  if (opts.identitySkipped) {
    lines.push(formatSkippedLine());
  } else if (opts.registryAuth) {
    lines.push(formatRegistryLine(opts.registryAuth));
  }

  if (score.total === 0) {
    lines.push("  no contributions: this address has no records in the registry.");
    return lines.join("\n");
  }

  lines.push(`  total records: ${score.total}`);
  lines.push("  attribution breakdown (reported SEPARATELY — never summed):");
  lines.push(`    authorBound:   ${score.authorBound}  (${ATTRIBUTION_PROVEN})`);
  lines.push(`    anchor-only:   ${score.anchorOnly}  (${ATTRIBUTION_ANCHOR_ONLY})`);
  lines.push("  lineage breakdown:");
  lines.push(`    lineage roots: ${score.lineageRoots}  (parent == 0x0)`);
  lines.push(`    revisions:     ${score.revisions}  (parent != 0x0 — a CLAIMED predecessor edge)`);
  const e = score.earliest;
  const l = score.latest;
  lines.push(
    `  earliest:      block ${e.blockNumber}, ts ${e.timestamp} (${isoFromUnix(e.timestamp)})`
  );
  lines.push(
    `  latest:        block ${l.blockNumber}, ts ${l.timestamp} (${isoFromUnix(l.timestamp)})`
  );
  return lines.join("\n");
}

/**
 * Compute and report a contributor's verifiable contribution score, read-only. Validates `<addr>` is a
 * 20-byte hex address BEFORE any network call, runs the assertRegistry preflight, pages through
 * getRecordsByContributor, then emits either a human block (led by the trust caveat) or a
 * machine-readable JSON object (`--json`). Requires a provider; NEVER a signer or key.
 *
 * @param {object}  opts
 * @param {string}  opts.address           the contributor address to score
 * @param {string}  opts.contractAddress   deployed ContributionRegistry address to read from
 * @param {object}  opts.provider          ethers v6 Provider (read-only RPC connection)
 * @param {boolean} [opts.json]            emit a JSON object instead of the human block
 * @param {boolean} [opts.skipIdentityCheck] loudly skip the registry preflight (KNOWN local target only)
 * @param {object}  [opts.ethers]          ethers v6 module (defaults to the bundled one)
 * @param {(s:string)=>void} [opts.log]    sink for output (defaults to process.stdout)
 * @returns {Promise<{ address:string, total:number, authorBound:number, anchorOnly:number,
 *   lineageRoots:number, revisions:number, earliest:object|null, latest:object|null,
 *   registry:object|null, json:boolean }>}
 */
async function runReputation(opts) {
  const ethersLib = opts.ethers || require("ethers");
  const log = opts.log || ((s) => process.stdout.write(s));

  const { address: rawAddress, contractAddress, provider } = opts;

  // Validate the address shape FIRST — before touching env, the provider, or the network. A malformed
  // value must hard-error with a usage-grade message and never hit the network (parser parity with the
  // existing read commands; mirrors show.js's normalizeContentHash precedence).
  if (!rawAddress) throw new Error("reputation requires an <addr>");
  if (!ethersLib.isAddress(rawAddress)) {
    throw new Error(`invalid address: ${rawAddress} (expected a 20-byte 0x-hex address)`);
  }
  const address = ethersLib.getAddress(rawAddress);

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

  // T-11.2 preflight: authenticate the registry BEFORE reading any record — the score is never reported
  // against an unauthenticated/look-alike contract (unless the caller explicitly, loudly opts out with
  // skipIdentityCheck for a KNOWN not-yet-deployed/local-dev target).
  let registryAuth = null;
  if (!opts.skipIdentityCheck) {
    registryAuth = await assertRegistry({ provider, contractAddress, ethers: ethersLib });
  }

  const contract = new ethersLib.Contract(
    ethersLib.getAddress(contractAddress),
    ABI,
    provider
  );

  const records = await readContributorRecords(contract, address);
  const score = computeScore(records);

  // T-11.2: the machine-readable registry block — the same identity a UI/indexer can depend on to know
  // the score was derived from an authenticated registry (or that the check was skipped).
  const registryBlock = opts.skipIdentityCheck
    ? jsonSkippedBlock()
    : registryAuth
    ? jsonRegistryBlock(registryAuth)
    : null;

  if (opts.json) {
    log(JSON.stringify(jsonScore(address, score, registryBlock), null, 2) + "\n");
  } else {
    // Human-readable: LEAD with the trust caveat, then the score block (which carries the registry-auth
    // confirmation or the loud skip warning, then the breakdowns / bounds).
    log(TRUST_CAVEAT + "\n\n");
    log(
      formatScore(address, score, {
        registryAuth,
        identitySkipped: Boolean(opts.skipIdentityCheck),
      }) + "\n"
    );
  }

  return {
    address,
    total: score.total,
    authorBound: score.authorBound,
    anchorOnly: score.anchorOnly,
    lineageRoots: score.lineageRoots,
    revisions: score.revisions,
    // BigInts normalized to JSON-safe numbers in the structured result too, so a programmatic caller
    // gets the same shape as --json.
    earliest:
      score.earliest === null
        ? null
        : {
            blockNumber: Number(score.earliest.blockNumber),
            timestamp: Number(score.earliest.timestamp),
            timestampISO: isoFromUnix(score.earliest.timestamp),
          },
    latest:
      score.latest === null
        ? null
        : {
            blockNumber: Number(score.latest.blockNumber),
            timestamp: Number(score.latest.timestamp),
            timestampISO: isoFromUnix(score.latest.timestamp),
          },
    registry: registryBlock,
    json: Boolean(opts.json),
  };
}

module.exports = {
  runReputation,
  readContributorRecords,
  computeScore,
  jsonScore,
  formatScore,
  TRUST_CAVEAT,
  DEFAULT_PAGE,
  ABI,
};

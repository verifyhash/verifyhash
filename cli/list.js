"use strict";

// `vh list [--contract a] [--rpc u] [filters]` — enumerate the registry, read-only.
//
// This is the discovery + audit counterpart to `vh verify`: where verify answers "is THIS content
// anchored?", list answers "WHAT is in the registry?". It reads `total()` and pages through the
// contract's `getRecords(start, count)` view, printing one block per record (or a JSON array under
// `--json`).
//
// Read-only by construction: it takes a PROVIDER only, never a signer and never a key. Enumerating a
// public, immutable registry must never require the ability to write to it.
//
// Trust posture (mirrors docs/TRUST-BOUNDARIES.md): the per-record `uri` is an UNTRUSTED hint the
// contract never validated, and `contributor` only means "proven first claimant" when `authorBound`
// is true — otherwise it is merely "first anchorer". Human output always leads with that caveat so a
// browser of the list does not over-trust either field.

const ARTIFACT = require("../artifacts/contracts/ContributionRegistry.sol/ContributionRegistry.json");
const ABI = ARTIFACT.abi;

// Reuse the lineage-root predicate from `show` so `list` and `show` never disagree about what a
// "root" (parent == bytes32(0)) is. T-10.1.
const { isRoot } = require("./show");

// Default page size for walking getRecords(). The contract clamps a window to what exists, so this is
// purely a request-batching knob; it never affects which records come back.
const DEFAULT_PAGE = 100;

// The one-line trust caveat that leads every human-readable run. Kept consistent with the
// `uri`/`contributor` rows in docs/TRUST-BOUNDARIES.md so a reader of the list does not over-trust
// the off-chain pointer or the recorded address.
const TRUST_CAVEAT =
  "NOTE: `uri` is an UNTRUSTED hint (never fetched/validated — re-fetch + re-hash yourself); " +
  "`contributor` only means proven authorship when authorBound is true (commit-reveal), " +
  "otherwise it is merely the first anchorer.";

// The two attribution strings, reused verbatim from cli/verify.js so list and verify never drift.
const ATTRIBUTION_PROVEN = "proven first claimant (commit-reveal)";
const ATTRIBUTION_ANCHOR_ONLY = "first anchorer only — NOT authorship";

/**
 * Read every record from the registry in insertion order by paging through getRecords().
 * Read-only: uses only the provider. Returns a plain array of normalized record objects with their
 * insertion `index`, so callers can filter/slice client-side without re-reading the chain.
 *
 * @param {object} contract  an ethers v6 Contract bound to a provider
 * @param {number} [pageSize]
 * @returns {Promise<Array<{
 *   index:number, contentHash:string, contributor:string, authorBound:boolean,
 *   timestamp:bigint, blockNumber:bigint, uri:string, parent:string
 * }>>}
 */
async function readAllRecords(contract, pageSize = DEFAULT_PAGE) {
  const total = Number(await contract.total());
  const out = [];
  for (let start = 0; start < total; start += pageSize) {
    const [contentHashes, records] = await contract.getRecords(start, pageSize);
    // Defensive: the contract clamps, so a window past the end returns empty and we stop.
    if (contentHashes.length === 0) break;
    for (let i = 0; i < contentHashes.length; i++) {
      const r = records[i];
      out.push({
        index: start + i,
        contentHash: contentHashes[i],
        contributor: r.contributor,
        authorBound: Boolean(r.authorBound),
        timestamp: BigInt(r.timestamp),
        blockNumber: BigInt(r.blockNumber),
        uri: r.uri,
        // The immutable lineage edge (T-10.1). Normalized to a lowercase 0x string; a root reads back
        // as the 32-byte zero hash (isRoot() flags it for the JSON/human shapes below).
        parent: String(r.parent).toLowerCase(),
      });
    }
  }
  return out;
}

/**
 * Apply the client-side filters to an in-order record array. All filters are optional and combine
 * (logical AND); offset/limit page the *filtered* result so `vh list --contributor X --limit 5`
 * means "the first 5 of X's records", which is what a reader expects.
 *
 * @param {Array} records      normalized records from readAllRecords (insertion order preserved)
 * @param {object} filters
 * @param {string}  [filters.contributor]  lowercase-compared address; keep only this contributor
 * @param {boolean} [filters.authorBound]  if true, keep only authorBound (commit-reveal) records
 * @param {number}  [filters.offset]       skip this many of the filtered records (default 0)
 * @param {number}  [filters.limit]        keep at most this many after the offset (default: all)
 * @returns {Array} the filtered + windowed records (insertion order preserved)
 */
function applyFilters(records, filters = {}) {
  let rows = records;
  if (filters.contributor) {
    const want = String(filters.contributor).toLowerCase();
    rows = rows.filter((r) => String(r.contributor).toLowerCase() === want);
  }
  if (filters.authorBound) {
    rows = rows.filter((r) => r.authorBound === true);
  }
  const offset = filters.offset || 0;
  const start = offset;
  const end = filters.limit == null ? rows.length : start + filters.limit;
  return rows.slice(start, end);
}

/** The human attribution phrase for a record, reusing verify.js wording exactly. */
function attributionFor(authorBound) {
  return authorBound ? ATTRIBUTION_PROVEN : ATTRIBUTION_ANCHOR_ONLY;
}

/** Format a unix-seconds bigint as an ISO-8601 UTC string for human display. */
function isoFromUnix(unixSeconds) {
  try {
    return new Date(Number(unixSeconds) * 1000).toISOString();
  } catch (_) {
    return "(unparseable)";
  }
}

/**
 * Render one record as the human-readable block printed per row. Includes the acceptance fields:
 * index, contentHash, contributor, attribution strength, timestamp (+ISO), blockNumber, uri.
 */
function formatRecord(r) {
  // `parent` (T-10.1): a root (0x0) shows "(none) — lineage root"; a parented record shows the
  // predecessor hash. The edge is only a CLAIM (see the trust caveat), so it is reported, not trusted.
  const parentLine = isRoot(r.parent)
    ? "      parent:       (none) — lineage root"
    : `      parent:       ${r.parent}`;
  return [
    `[${r.index}]  ${r.contentHash}`,
    `      contributor:  ${r.contributor}`,
    `      attribution:  ${attributionFor(r.authorBound)}`,
    `      timestamp:    ${r.timestamp} (${isoFromUnix(r.timestamp)})`,
    `      blockNumber:  ${r.blockNumber}`,
    `      uri:          ${r.uri ? r.uri : "(none)"}`,
    parentLine,
  ].join("\n");
}

/**
 * Shape a record for `--json`: BigInts become Numbers (unix seconds / block heights fit safely) and
 * the attribution phrase is included so a machine consumer gets the same semantics as the human block.
 */
function jsonRecord(r) {
  const root = isRoot(r.parent);
  return {
    index: r.index,
    contentHash: r.contentHash,
    contributor: r.contributor,
    authorBound: r.authorBound,
    attribution: attributionFor(r.authorBound),
    timestamp: Number(r.timestamp),
    timestampISO: isoFromUnix(r.timestamp),
    blockNumber: Number(r.blockNumber),
    uri: r.uri ? r.uri : null,
    // Lineage edge (T-10.1): a root serializes parent:null + isRoot:true (distinguishable from a
    // missing key); a parented record carries the predecessor hash + isRoot:false. So an indexer can
    // reconstruct the full edge set from `vh list --json` alone, mirroring the on-chain Linked logs.
    parent: root ? null : r.parent,
    isRoot: root,
  };
}

/**
 * Enumerate the registry, read-only. Reads `total`, pages through `getRecords`, applies the
 * client-side filters, then emits either a human block (led by the trust caveat) per record or a
 * machine-readable JSON array (`--json`). Requires a provider; NEVER a signer or key.
 *
 * @param {object}  opts
 * @param {string}  opts.contractAddress  deployed ContributionRegistry address to read from
 * @param {object}  opts.provider         ethers v6 Provider (read-only RPC connection)
 * @param {object}  [opts.filters]        { contributor, authorBound, offset, limit } (see applyFilters)
 * @param {boolean} [opts.json]           emit a JSON array instead of the human block
 * @param {object}  [opts.ethers]         ethers v6 module (defaults to the bundled one)
 * @param {(s:string)=>void} [opts.log]   sink for output (defaults to process.stdout)
 * @returns {Promise<{records: Array, total: number, shown: number, json: boolean}>}
 *          `records` is the normalized + filtered list actually emitted (the JSON-shaped objects).
 */
async function runList(opts) {
  const ethersLib = opts.ethers || require("ethers");
  const log = opts.log || ((s) => process.stdout.write(s));

  const { contractAddress, provider } = opts;
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

  const filters = opts.filters || {};
  // Validate a --contributor address up front so a typo'd address hard-errors rather than silently
  // matching nothing (which would look like an empty registry).
  if (filters.contributor && !ethersLib.isAddress(filters.contributor)) {
    throw new Error(`invalid --contributor address: ${filters.contributor}`);
  }

  const contract = new ethersLib.Contract(
    ethersLib.getAddress(contractAddress),
    ABI,
    provider
  );

  const all = await readAllRecords(contract);
  const filtered = applyFilters(all, {
    contributor: filters.contributor,
    authorBound: filters.authorBound,
    offset: filters.offset,
    limit: filters.limit,
  });

  const jsonRows = filtered.map(jsonRecord);

  if (opts.json) {
    // Machine-readable: a JSON array (possibly empty) and nothing else, so it pipes cleanly into CI.
    log(JSON.stringify(jsonRows, null, 2) + "\n");
  } else {
    // Human-readable: lead with the trust caveat, then one block per record.
    log(TRUST_CAVEAT + "\n\n");
    if (filtered.length === 0) {
      log("no records\n");
    } else {
      log(filtered.map(formatRecord).join("\n\n") + "\n");
    }
  }

  return { records: jsonRows, total: all.length, shown: filtered.length, json: Boolean(opts.json) };
}

module.exports = {
  runList,
  readAllRecords,
  applyFilters,
  formatRecord,
  jsonRecord,
  attributionFor,
  isoFromUnix,
  TRUST_CAVEAT,
  ATTRIBUTION_PROVEN,
  ATTRIBUTION_ANCHOR_ONLY,
  DEFAULT_PAGE,
  ABI,
};

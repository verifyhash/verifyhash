"use strict";

// `vh lineage <0xhash> [--contract a] [--rpc u] [--json] [--max-depth n]` — walk the immutable
// `parent` chain UP from a record to its lineage root, read-only.
//
// WHERE THIS FITS
//   T-10.1 added an optional, immutable predecessor edge (`parent`) to every record, and
//   `vh anchor/claim --parent <hash>` writes it. This is the read counterpart: given any record's
//   contentHash, it follows `record.parent` from child -> parent -> ... until it reaches a lineage
//   root (parent == bytes32(0)), printing each ancestor in order. It is the "what is the full history
//   of this contribution, and who authored each step?" query.
//
//   The walk is purely OFF-CHAIN: there is no on-chain loop (the contract deliberately never walks an
//   unbounded set), so we issue one bounded `getRecord` per hop. The chain is acyclic by construction
//   (a non-zero parent MUST already be anchored at write time), so a finite chain always terminates at
//   a root — but a client must still cap the walk so a pathological/huge chain cannot hang it. That cap
//   is `--max-depth` (default 256); reaching it prints a clear "deeper than --max-depth" note rather
//   than looping forever.
//
// TRUST POSTURE (mirrors docs/TRUST-BOUNDARIES.md and the contract NatSpec). Two caveats lead every
// human run:
//   1. the shared record caveat (uri untrusted; contributor only proves authorship when authorBound);
//   2. a lineage-specific one: a `parent` edge is the CHILD author's CLAIM of a predecessor. It does
//      NOT prove the predecessor's content is a genuine ancestor of the child's content (re-derive
//      BOTH and reason about it yourself), and it does NOT transfer the parent's authorship to the
//      child. Each record's contributor/authorBound stands on its own.
//
// Read-only by construction: it takes a PROVIDER only, never a signer and never a key. Walking a
// public, immutable lineage must never require the ability to write to it.

const {
  normalizeContentHash,
  attributionFor,
  isoFromUnix,
  isRoot,
  ZERO_HASH,
} = require("./show");
const { isNotAnchoredError } = require("./verify");
const {
  assertRegistry,
  formatRegistryLine,
  formatSkippedLine,
  jsonRegistryBlock,
  jsonSkippedBlock,
} = require("./registry");

const ARTIFACT = require("../artifacts/contracts/ContributionRegistry.sol/ContributionRegistry.json");
const ABI = ARTIFACT.abi;

// Default cap on how many ancestors the walk follows. A finite, acyclic chain always terminates at a
// root well before this; the cap exists only so a client can't be hung by a pathological/huge chain.
// 256 is generous for a real revision history yet bounds the worst case to 256 cheap eth_calls.
const DEFAULT_MAX_DEPTH = 256;

// Outcomes of a lineage run. WALKED == we read the start record and followed the chain (possibly to a
// root, possibly capped). NOT_ANCHORED == the START hash itself has no record (the contract reverted
// NotAnchored). A genuine RPC error is neither — it throws.
const STATUS = Object.freeze({
  WALKED: "WALKED",
  NOT_ANCHORED: "NOT_ANCHORED",
});

// The shared record trust caveat, kept consistent with cli/list.js / cli/show.js so the read commands
// never disagree about what `uri` / `contributor` are allowed to mean.
const RECORD_CAVEAT =
  "NOTE: `uri` is an UNTRUSTED hint (never fetched/validated — re-fetch + re-hash yourself); " +
  "`contributor` only means proven authorship when authorBound is true (commit-reveal), " +
  "otherwise it is merely the first anchorer.";

// The lineage-specific caveat that ALSO leads every human run (acceptance #3). A parent edge is only a
// CLAIM by the child's author; spelling out what it does NOT prove keeps a reader from over-trusting an
// ancestry edge as proof of derivation or as a transfer of authorship.
const LINEAGE_CAVEAT =
  "NOTE (lineage): a `parent` edge is the CHILD author's CLAIM of a predecessor. It does NOT prove " +
  "the predecessor's content is a genuine ancestor of the child's content (re-derive BOTH yourself " +
  "and reason about the relationship), and it does NOT transfer the parent's authorship to the child. " +
  "Each record's contributor/authorBound stands on its own.";

/**
 * Validate and normalize the `--max-depth` value. A missing value means the default; anything present
 * must be a positive integer (a zero/negative/non-integer cap is a usage error — a 0-depth walk could
 * never even read the start record, and a typo must never silently change how far we walk).
 *
 * @param {number|string|undefined|null} value
 * @returns {number} the resolved positive-integer cap
 */
function normalizeMaxDepth(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_MAX_DEPTH;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`invalid --max-depth: must be a positive integer, got: ${value}`);
  }
  return n;
}

/**
 * Read ONE record by content hash, classifying a NotAnchored revert (an expected "no record") versus a
 * genuine RPC/network failure (re-thrown), reusing the SAME `isNotAnchoredError` classifier verify.js /
 * show.js use so the three commands never drift. Returns a normalized record object, or null when the
 * hash has no record.
 *
 * @param {object} contract             ethers v6 Contract bound to a provider
 * @param {string} contentHash          the 0x 32-byte hash to read
 * @param {object} ethersLib            ethers v6 module
 * @param {string} notAnchoredSelector  the NotAnchored 4-byte selector (for raw-data fallback)
 * @returns {Promise<{
 *   contentHash:string, contributor:string, authorBound:boolean,
 *   timestamp:bigint, blockNumber:bigint, uri:string, parent:string
 * }|null>}
 */
async function readOne(contract, contentHash, ethersLib, notAnchoredSelector) {
  let record;
  try {
    record = await contract.getRecord(contentHash);
  } catch (err) {
    if (isNotAnchoredError(err, ethersLib, notAnchoredSelector)) return null;
    throw err; // genuine failure (network/address/etc.) — never masquerade as a missing record.
  }
  return {
    contentHash: contentHash.toLowerCase(),
    contributor: record.contributor,
    authorBound: Boolean(record.authorBound),
    timestamp: BigInt(record.timestamp),
    blockNumber: BigInt(record.blockNumber),
    uri: record.uri,
    // The immutable lineage edge. Normalize to a lowercase 0x string so isRoot()/equality is stable; a
    // root reads back as the 32-byte zero hash.
    parent: String(record.parent).toLowerCase(),
  };
}

/**
 * Walk the parent chain UP from `startHash`, bounded by `maxDepth`. Read-only: it issues at most
 * `maxDepth` `getRecord` calls (one per hop), each through the shared NotAnchored classifier.
 *
 * Returns a structured result:
 *   - status NOT_ANCHORED + an empty ancestors[] when the START hash itself has no record;
 *   - status WALKED + ancestors[] in child->root order otherwise. `cappedAtDepth` is true iff we hit
 *     the cap before reaching a root (there is still an un-walked parent), in which case
 *     `nextParent` names the predecessor we stopped before so a caller could resume from there.
 *
 * The chain is acyclic by construction (a non-zero parent must already be anchored at write time), so
 * a finite chain always terminates at a root before the cap; the cap only guards a pathological depth.
 * A defensive in-walk visited-set still breaks on any repeat (it must never happen on a real chain),
 * so even a (impossible) cycle can never spin forever.
 *
 * @param {object} contract  ethers v6 Contract bound to a provider
 * @param {string} startHash normalized 0x 32-byte start hash
 * @param {object} opts      { maxDepth:number, ethers:object }
 * @returns {Promise<{
 *   status:"WALKED"|"NOT_ANCHORED",
 *   start:string,
 *   ancestors:Array<object>,
 *   cappedAtDepth:boolean,
 *   maxDepth:number,
 *   nextParent:string|null
 * }>}
 */
async function walkLineage(contract, startHash, opts) {
  const ethersLib = opts.ethers || require("ethers");
  const maxDepth = opts.maxDepth || DEFAULT_MAX_DEPTH;

  const iface = new ethersLib.Interface(ABI);
  const notAnchoredSelector = iface.getError("NotAnchored").selector;

  const ancestors = [];
  const seen = new Set(); // defensive cycle guard (cannot trigger on a real acyclic chain)
  let cursor = startHash.toLowerCase();
  let cappedAtDepth = false;
  let nextParent = null;

  for (let depth = 0; depth < maxDepth; depth++) {
    if (seen.has(cursor)) break; // impossible on an acyclic chain; never loop forever regardless
    seen.add(cursor);

    /* eslint-disable no-await-in-loop */
    const rec = await readOne(contract, cursor, ethersLib, notAnchoredSelector);
    /* eslint-enable no-await-in-loop */

    if (rec === null) {
      // Only the very FIRST hop can be NOT_ANCHORED: a non-zero parent is required to be anchored at
      // write time, so an interior hash is always present. If the START hash is missing we report
      // NOT_ANCHORED; an (impossible) missing interior just terminates the walk at what we have.
      if (depth === 0) {
        return {
          status: STATUS.NOT_ANCHORED,
          start: startHash.toLowerCase(),
          ancestors: [],
          cappedAtDepth: false,
          maxDepth,
          nextParent: null,
        };
      }
      break;
    }

    ancestors.push({
      depth,
      contentHash: rec.contentHash,
      contributor: rec.contributor,
      authorBound: rec.authorBound,
      attribution: attributionFor(rec.authorBound),
      timestamp: rec.timestamp,
      blockNumber: rec.blockNumber,
      uri: rec.uri,
      parent: rec.parent,
      isRoot: isRoot(rec.parent),
    });

    if (isRoot(rec.parent)) {
      // Reached the lineage root: no predecessor. Done.
      return {
        status: STATUS.WALKED,
        start: startHash.toLowerCase(),
        ancestors,
        cappedAtDepth: false,
        maxDepth,
        nextParent: null,
      };
    }

    cursor = rec.parent;
    // If this was the last allowed iteration and the record still has a (non-root) parent, the walk is
    // capped: there is an un-walked predecessor. Record it so the caller can resume from there.
    if (depth === maxDepth - 1) {
      cappedAtDepth = true;
      nextParent = rec.parent;
    }
  }

  return {
    status: STATUS.WALKED,
    start: startHash.toLowerCase(),
    ancestors,
    cappedAtDepth,
    maxDepth,
    nextParent,
  };
}

/** Render one ancestor as the human-readable block printed per hop. Mirrors list.js/show.js fields. */
function formatAncestor(a, index) {
  const rootTag = a.isRoot ? "  <- lineage root (no predecessor)" : "";
  const lines = [
    `[${index}]  ${a.contentHash}${rootTag}`,
    `      contributor:  ${a.contributor}`,
    `      attribution:  ${a.attribution}`,
    `      timestamp:    ${a.timestamp} (${isoFromUnix(a.timestamp)})`,
    `      blockNumber:  ${a.blockNumber}`,
    `      uri:          ${a.uri ? a.uri : "(none)"}`,
  ];
  // Show the edge to the next ancestor explicitly so a reader can see the chain links, not just nodes.
  const parentLine = a.isRoot
    ? "      parent:       (none) — lineage root"
    : `      parent:       ${a.parent}`;
  lines.push(parentLine);
  return lines.join("\n");
}

/**
 * Render a full lineage walk as the human-readable block the CLI prints. ALWAYS leads with both trust
 * caveats (record + lineage-specific), then either the ordered ancestors or a NOT ANCHORED block, then
 * a capped-walk note when the cap was hit.
 */
function formatLineage(r) {
  const lines = [RECORD_CAVEAT, "", LINEAGE_CAVEAT, ""];
  // T-11.2: the registry-authentication confirmation (or the loud skip warning), printed BEFORE the
  // walk so a reader sees the contract was authenticated before believing any ancestor below.
  if (r.identitySkipped) {
    lines.push(formatSkippedLine(), "");
  } else if (r.registry) {
    lines.push(formatRegistryLine(r.registry), "");
  }
  lines.push(`  start:        ${r.start}`);

  if (r.status === STATUS.NOT_ANCHORED) {
    lines.push(
      "  result:       NOT ANCHORED",
      "  No record exists for this content hash, so it has no lineage. It was never anchored (or you",
      "  mistyped the hash). `vh anchor <path> --parent <hash>` / `vh claim <path> --parent <hash>`",
      "  anchor a record AS a revision of an existing one; `vh verify <path>` recomputes a path's hash."
    );
    return lines.join("\n");
  }

  const n = r.ancestors.length;
  lines.push(
    `  result:       WALKED ${n} record${n === 1 ? "" : "s"} (child -> root order)`,
    ""
  );
  lines.push(r.ancestors.map((a, i) => formatAncestor(a, i)).join("\n\n"));

  if (r.cappedAtDepth) {
    lines.push(
      "",
      `  NOTE: lineage deeper than --max-depth (${r.maxDepth}); the walk stopped before its root.`,
      `  The next un-walked predecessor is ${r.nextParent}.`,
      `  Re-run \`vh lineage ${r.nextParent} --max-depth <n>\` to continue from there.`
    );
  }
  return lines.join("\n");
}

/**
 * Shape a lineage result for `--json`: an ordered ancestor ARRAY carrying the same fields as the human
 * block (BigInts -> Numbers so unix seconds / block heights pipe cleanly into CI). NOT_ANCHORED is a
 * first-class value (anchored:false, empty ancestors), not an error object, so a script can branch on
 * it without parsing stderr — while still seeing a non-zero exit from the CLI.
 */
function jsonLineage(r) {
  // T-11.2: the machine-readable registry block — proves the walk was read from an authenticated
  // registry (or that the check was skipped).
  const registry = r.identitySkipped
    ? jsonSkippedBlock()
    : r.registry
    ? jsonRegistryBlock(r.registry)
    : null;
  if (r.status === STATUS.NOT_ANCHORED) {
    return {
      start: r.start,
      registry,
      anchored: false,
      ancestors: [],
      note:
        "NOT ANCHORED: no on-chain record for this hash, so it has no lineage. `lineage` only walks " +
        "anchored records; run `vh verify <path>` to bind a record to real content.",
    };
  }
  return {
    start: r.start,
    registry,
    anchored: true,
    // The ordered ancestor array, child -> root. An indexer/UI can reconstruct the lineage path from
    // this alone, mirroring the on-chain Linked(child, parent) logs.
    ancestors: r.ancestors.map((a) => ({
      depth: a.depth,
      contentHash: a.contentHash,
      contributor: a.contributor,
      authorBound: a.authorBound,
      attribution: a.attribution,
      timestamp: Number(a.timestamp),
      timestampISO: isoFromUnix(a.timestamp),
      blockNumber: Number(a.blockNumber),
      uri: a.uri ? a.uri : null,
      // A root serializes parent:null + isRoot:true (distinguishable from a missing key); a parented
      // record carries the predecessor hash + isRoot:false.
      parent: a.isRoot ? null : a.parent,
      isRoot: a.isRoot,
    })),
    // True iff the walk hit --max-depth before a root; `nextParent` is the un-walked predecessor.
    cappedAtDepth: r.cappedAtDepth,
    maxDepth: r.maxDepth,
    nextParent: r.cappedAtDepth ? r.nextParent : null,
  };
}

/**
 * Walk a record's lineage by content hash. Read-only: requires a provider, never a signer.
 *
 * Validates the hash shape FIRST (a malformed/short hash throws BEFORE any network call, reusing
 * show.js's normalizeContentHash so the same usage-grade error fires everywhere), then walks the chain.
 * A NotAnchored revert on the START hash is the expected "no record" path (STATUS.NOT_ANCHORED); any
 * other failure (bad RPC, wrong address, network down) is re-thrown rather than masqueraded — exactly as
 * verify.js / show.js handle it, via the shared `isNotAnchoredError`.
 *
 * @param {object}  opts
 * @param {string}  opts.contentHash      the 0x 32-byte hash to start the walk from
 * @param {string}  opts.contractAddress  deployed ContributionRegistry address to read from
 * @param {object}  opts.provider         ethers v6 Provider (read-only RPC connection)
 * @param {number|string} [opts.maxDepth] cap on how many ancestors to walk (default 256)
 * @param {boolean} [opts.json]           emit a JSON object instead of the human block
 * @param {object}  [opts.ethers]         ethers v6 module (defaults to the bundled one)
 * @param {(s:string)=>void} [opts.log]   sink for output (defaults to process.stdout)
 * @returns {Promise<{
 *   status:"WALKED"|"NOT_ANCHORED",
 *   start:string,
 *   ancestors:Array<object>,
 *   cappedAtDepth:boolean,
 *   maxDepth:number,
 *   nextParent:string|null
 * }>}
 */
async function runLineage(opts) {
  const ethersLib = opts.ethers || require("ethers");
  const log = opts.log || ((s) => process.stdout.write(s));

  // Validate the hash + the cap BEFORE touching the contract address / provider, so a bad input
  // hard-errors with a usage-grade message and never reaches the network.
  const contentHash = normalizeContentHash(opts.contentHash, ethersLib);
  const maxDepth = normalizeMaxDepth(opts.maxDepth);

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

  // T-11.2: authenticate the registry BEFORE walking the chain — no lineage is reported until we have
  // confirmed there is a real verifyhash ContributionRegistry at this address (unless the caller
  // explicitly, loudly opts out with skipIdentityCheck for a known not-yet-deployed/local-dev target).
  let registryAuth = null;
  if (!opts.skipIdentityCheck) {
    registryAuth = await assertRegistry({ provider, contractAddress, ethers: ethersLib });
  }

  const contract = new ethersLib.Contract(
    ethersLib.getAddress(contractAddress),
    ABI,
    provider
  );

  const result = await walkLineage(contract, contentHash, { maxDepth, ethers: ethersLib });
  // Attach the registry identity (or the skip marker) so the human block and --json both surface it.
  result.registry = registryAuth;
  result.identitySkipped = Boolean(opts.skipIdentityCheck);

  if (opts.json) {
    log(JSON.stringify(jsonLineage(result), null, 2) + "\n");
  } else {
    log(formatLineage(result) + "\n");
  }

  return result;
}

module.exports = {
  runLineage,
  walkLineage,
  readOne,
  normalizeMaxDepth,
  formatLineage,
  formatAncestor,
  jsonLineage,
  STATUS,
  RECORD_CAVEAT,
  LINEAGE_CAVEAT,
  DEFAULT_MAX_DEPTH,
  ZERO_HASH,
  ABI,
};

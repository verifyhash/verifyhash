"use strict";

// `vh show <0xhash> [--contract a] [--rpc u] [--json]` — look up ONE record by its content hash,
// with NO local content needed.
//
// Where `vh verify <path>` re-derives a hash from real bytes on disk and binds it to the chain, `show`
// starts from a hash you already have (e.g. one printed by `vh list`, copied from a receipt, or quoted
// in a PR) and just reads back the registry record for THAT exact hash:
//   * If a record exists -> print contributor, attribution strength, timestamp (+ISO), blockNumber, uri.
//   * If getRecord reverts with NotAnchored -> print a clear "NOT ANCHORED" line and exit non-zero,
//     distinguishing that expected "no such record" from a genuine RPC/network error (reusing the same
//     `isNotAnchoredError` classifier verify.js uses, so the two commands never drift).
//
// CRITICAL TRUST CAVEAT (and why this is a deliberately weaker tool than `verify`): `show` proves only
// that this EXACT hash is on-chain. It does NOT, and cannot, re-derive content — it never touches your
// files. So a record here does NOT bind the hash to any real bytes you hold; to make that binding you
// must still run `vh verify <path>` (which recomputes the hash from the path and compares). The output
// and usage cross-link the two commands so a reader is never lulled into treating a `show` hit as proof
// that some file is authentic.
//
// Read-only by construction: it takes a PROVIDER only, never a signer and never a key.

const { isNotAnchoredError } = require("./verify");
const {
  assertRegistry,
  formatRegistryLine,
  formatSkippedLine,
  jsonRegistryBlock,
  jsonSkippedBlock,
} = require("./registry");

const ARTIFACT = require("./core/registryArtifact");
const ABI = ARTIFACT.abi;

// Outcomes of a show run. ANCHORED == a record exists for the queried hash; NOT_ANCHORED == the
// contract reverted NotAnchored (no record). A genuine RPC error is neither — it throws.
const STATUS = Object.freeze({
  ANCHORED: "ANCHORED",
  NOT_ANCHORED: "NOT_ANCHORED",
});

// The lineage sentinel: a record whose `parent` is the 32-byte zero hash has NO predecessor and is a
// "lineage root" (the contract's documented convention; bytes32(0) == "no predecessor / root of a
// lineage"). Both the human block and the --json shape flag this explicitly so a consumer can tell a
// deliberate root from a missing/omitted field.
const ZERO_HASH = "0x" + "0".repeat(64);

/**
 * True iff `parent` is the zero-hash sentinel (== lineage root / no predecessor). Tolerant of a
 * null/undefined/missing value (an older record shape or a NOT_ANCHORED result) — those are treated
 * as "root" too, so callers never crash on a missing edge.
 */
function isRoot(parent) {
  return parent == null || BigInt(parent) === 0n;
}

// The two attribution phrases, kept consistent with cli/verify.js / cli/list.js so show, verify and
// list never disagree about what `contributor` is allowed to mean for a given record.
const ATTRIBUTION_PROVEN =
  "proven first claimant (commit-reveal, front-running-resistant)";
const ATTRIBUTION_ANCHOR_ONLY =
  "first anchorer only — NOT proven authorship (anyone could have anchored this hash)";

// The trust caveat that LEADS every human-readable run. It spells out the core limitation: a `show`
// hit only proves the hash is on-chain, never that any file you hold actually hashes to it. The cross
// link to `vh verify` is load-bearing, not decorative — it is the only command that binds bytes.
const TRUST_CAVEAT = [
  "NOTE: `show` proves only that THIS exact hash is recorded on-chain. It does NOT re-derive any",
  "content — it never reads your files — so a hit here does NOT bind this hash to real bytes you hold.",
  "To prove a file/dir actually hashes to this record, run `vh verify <path>` (it recomputes the hash",
  "from the path and compares). Also: `uri` is an UNTRUSTED hint (never fetched/validated), and",
  "`contributor` only means proven authorship when authorBound is true (commit-reveal).",
].join("\n");

/**
 * Validate that `value` is a 32-byte (0x + 64 hex chars) content hash, the exact shape getRecord
 * keys on. Returns the lowercased, normalized hash. Throws a usage-grade error otherwise so a
 * malformed/short hash hard-errors BEFORE any network call (the caller surfaces usage on throw).
 *
 * @param {string} value
 * @param {object} ethersLib ethers v6 module (for isHexString)
 * @returns {string} the normalized 0x-prefixed 32-byte hash (lowercase)
 */
function normalizeContentHash(value, ethersLib) {
  if (value === undefined || value === null || value === "") {
    throw new Error("show requires a <0xhash> (a 32-byte content hash)");
  }
  if (typeof value !== "string") {
    throw new Error(`invalid content hash: expected a 0x string, got ${typeof value}`);
  }
  if (!value.startsWith("0x") && !value.startsWith("0X")) {
    throw new Error(
      `invalid content hash: must be 0x-prefixed 32-byte hex, got: ${value}`
    );
  }
  // isHexString(v, 32) is true ONLY for exactly 0x + 64 hex chars — rejecting short, long, and
  // non-hex inputs in one check, before we ever build a provider or send a request.
  if (!ethersLib.isHexString(value, 32)) {
    throw new Error(
      `invalid content hash: must be a 32-byte (64 hex char) 0x value, got: ${value} ` +
        `(length ${value.length}). Did you mean to run \`vh verify <path>\` on a file instead?`
    );
  }
  return value.toLowerCase();
}

/** Format a unix-seconds bigint as an ISO-8601 UTC string for human display. */
function isoFromUnix(unixSeconds) {
  try {
    return new Date(Number(unixSeconds) * 1000).toISOString();
  } catch (_) {
    return "(unparseable)";
  }
}

/** The human attribution phrase for a record, reusing verify.js/list.js wording exactly. */
function attributionFor(authorBound) {
  return authorBound ? ATTRIBUTION_PROVEN : ATTRIBUTION_ANCHOR_ONLY;
}

/**
 * Render a show result as the human-readable block the CLI prints. Always leads with the trust
 * caveat (which cross-links `vh verify`), then either the record fields or a NOT ANCHORED block.
 */
function formatShow(r) {
  const lines = [TRUST_CAVEAT, ""];
  // T-11.2: the registry-authentication confirmation (or the loud skip warning), printed BEFORE the
  // record so a reader sees the contract was authenticated before believing any field below.
  if (r.identitySkipped) {
    lines.push(formatSkippedLine());
  } else if (r.registry) {
    lines.push(formatRegistryLine(r.registry));
  }
  lines.push(`  contentHash:  ${r.contentHash}`);
  if (r.status === STATUS.ANCHORED) {
    const ts = r.timestamp == null ? "(unknown)" : isoFromUnix(r.timestamp);
    // `parent` is the optional immutable lineage edge. A root (0x0) renders as "(none) — lineage
    // root" so a reader can tell a deliberate root from a missing field; a parented record shows the
    // predecessor hash and `vh show <parent>` to walk one step back. Per TRUST BOUNDARIES the edge is
    // only a CLAIM by this record's author — it proves neither content ancestry nor authorship.
    const parentLine = isRoot(r.parent)
      ? "  parent:       (none) — lineage root (no predecessor)"
      : `  parent:       ${r.parent}  (claimed predecessor — walk it with \`vh show ${r.parent}\`)`;
    lines.push(
      "  result:       ANCHORED",
      `  contributor:  ${r.contributor}`,
      `  attribution:  ${attributionFor(r.authorBound)}`,
      `  authorBound:  ${r.authorBound}`,
      `  timestamp:    ${r.timestamp} (${ts})`,
      `  blockNumber:  ${r.blockNumber}`,
      `  uri:          ${r.uri ? r.uri : "(none)"}`,
      parentLine,
      "",
      "  This record attests only that the EXACT hash above is on-chain. To bind it to real bytes,",
      "  run `vh verify <path>` — `show` does not re-derive content. A `parent` is only this author's",
      "  CLAIMED predecessor: it proves neither content ancestry nor a transfer of the parent's authorship."
    );
  } else {
    lines.push(
      "  result:       NOT ANCHORED",
      "  No record exists for this content hash. It was never anchored (or you mistyped the hash).",
      "  If you have the content, `vh anchor <path>` / `vh claim <path>` can anchor it; `vh verify",
      "  <path>` recomputes a path's hash and tells you whether THAT resolves to a record."
    );
  }
  return lines.join("\n");
}

/**
 * Shape a show result for `--json`: BigInts become Numbers (unix seconds / block heights fit safely)
 * and the attribution phrase is included so a machine consumer gets the same semantics as the human
 * block. NOT_ANCHORED is a first-class JSON value (anchored:false), not an error object, so a script
 * can branch on it without parsing stderr — while still seeing a non-zero exit from the CLI.
 */
function jsonShow(r) {
  // T-11.2: the machine-readable registry block — the same identity a UI/indexer can depend on to
  // know the record was read from an authenticated registry (or that the check was skipped).
  const registry = r.identitySkipped
    ? jsonSkippedBlock()
    : r.registry
    ? jsonRegistryBlock(r.registry)
    : null;
  if (r.status === STATUS.ANCHORED) {
    const root = isRoot(r.parent);
    return {
      contentHash: r.contentHash,
      registry,
      anchored: true,
      contributor: r.contributor,
      authorBound: r.authorBound,
      attribution: attributionFor(r.authorBound),
      timestamp: Number(r.timestamp),
      timestampISO: isoFromUnix(r.timestamp),
      blockNumber: Number(r.blockNumber),
      uri: r.uri ? r.uri : null,
      // Lineage edge (T-10.1): `parent` is always present in the contract; surface it explicitly so an
      // indexer/UI consuming the documented --json contract can see the edge. A root serializes
      // parent:null + isRoot:true (so a deliberate root is distinguishable from a missing key), a
      // parented record carries the predecessor hash + isRoot:false. The edge is only this author's
      // CLAIMED predecessor — it proves neither content ancestry nor a transfer of authorship.
      parent: root ? null : r.parent,
      isRoot: root,
    };
  }
  return {
    contentHash: r.contentHash,
    registry,
    anchored: false,
    note:
      "NOT ANCHORED: no on-chain record for this hash. `show` only proves a hash is on-chain; " +
      "run `vh verify <path>` to bind a record to real content.",
  };
}

/**
 * Look up ONE record by content hash. Read-only: requires a provider, never a signer.
 *
 * Validates the hash shape FIRST (a malformed/short hash throws before any network call), then reads
 * getRecord(hash). A NotAnchored revert is the expected "no record" path (STATUS.NOT_ANCHORED); any
 * other failure (bad RPC, wrong address, network down) is re-thrown rather than masqueraded as
 * "not anchored" — exactly as verify.js handles it, via the shared `isNotAnchoredError`.
 *
 * @param {object}  opts
 * @param {string}  opts.contentHash      the 0x 32-byte hash to look up
 * @param {string}  opts.contractAddress  deployed ContributionRegistry address to read from
 * @param {object}  opts.provider         ethers v6 Provider (read-only RPC connection)
 * @param {boolean} [opts.json]           emit a JSON object instead of the human block
 * @param {object}  [opts.ethers]         ethers v6 module (defaults to the bundled one)
 * @param {(s:string)=>void} [opts.log]   sink for output (defaults to process.stdout)
 * @returns {Promise<{
 *   status: "ANCHORED"|"NOT_ANCHORED",
 *   contentHash: string,
 *   contributor: string|null,
 *   authorBound: boolean|null,
 *   timestamp: bigint|null,
 *   blockNumber: bigint|null,
 *   uri: string|null,
 *   parent: string|null,
 * }>}
 */
async function runShow(opts) {
  const ethersLib = opts.ethers || require("ethers");
  const log = opts.log || ((s) => process.stdout.write(s));

  // Validate the hash BEFORE touching the contract address / provider, so a bad hash hard-errors with
  // a usage-grade message and never reaches the network.
  const contentHash = normalizeContentHash(opts.contentHash, ethersLib);

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

  // T-11.2: authenticate the registry BEFORE reading the record — no record is reported until we have
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
      record = null; // expected "no record" -> NOT_ANCHORED below
    } else {
      throw err; // genuine failure (network/address/etc.) — don't masquerade as NOT ANCHORED.
    }
  }

  const result = {
    contentHash,
    status: record === null ? STATUS.NOT_ANCHORED : STATUS.ANCHORED,
    // T-11.2: the resolved registry identity (or null when skipped). Surfaced in both the human block
    // and --json so a consumer can SEE the registry was authenticated before believing this record.
    registry: registryAuth,
    identitySkipped: Boolean(opts.skipIdentityCheck),
    contributor: null,
    authorBound: null,
    timestamp: null,
    blockNumber: null,
    uri: null,
    parent: null,
  };

  if (record !== null) {
    result.contributor = record.contributor;
    result.authorBound = Boolean(record.authorBound);
    result.timestamp = BigInt(record.timestamp);
    result.blockNumber = BigInt(record.blockNumber);
    result.uri = record.uri;
    // The immutable lineage edge (T-10.1). Normalize to a lowercase 0x string so isRoot() / equality
    // checks are stable; a root reads back as the 32-byte zero hash.
    result.parent = String(record.parent).toLowerCase();
  }

  if (opts.json) {
    log(JSON.stringify(jsonShow(result), null, 2) + "\n");
  } else {
    log(formatShow(result) + "\n");
  }

  return result;
}

module.exports = {
  runShow,
  normalizeContentHash,
  formatShow,
  jsonShow,
  attributionFor,
  isoFromUnix,
  isRoot,
  STATUS,
  TRUST_CAVEAT,
  ZERO_HASH,
  ATTRIBUTION_PROVEN,
  ATTRIBUTION_ANCHOR_ONLY,
  ABI,
};

"use strict";

// cli/registry.js — authenticate a deployed ContributionRegistry BEFORE believing any record it
// returns (T-11.2).
//
// WHY THIS EXISTS
//   Every read command (`vh verify` / `show` / `list` / `lineage` / `verify-proof`) historically
//   trusted whatever (rpc, address) pair the caller supplied: it just called `getRecord` and reported
//   the answer. But the answer is only as trustworthy as the assumption that the address really is a
//   verifyhash registry on the network the caller thinks it is. Two failure modes silently produced a
//   confident-looking-but-wrong verdict:
//     * pointed at an address with NO contract (typo'd address, or right address on the WRONG network)
//       — `getRecord` reverts and is read as "not anchored" (a MISMATCH), so a genuinely-anchored
//       contribution is mislabeled as tampered/absent;
//     * pointed at a DEPLOYED but DIFFERENT contract (a look-alike, a fork, an unrelated contract whose
//       storage happens to decode) — it may answer with garbage records that get reported as truth.
//   T-11.1 baked an immutable, ownerless `REGISTRY_ID` / `REGISTRY_VERSION` self-identification marker
//   into the contract precisely so an off-chain verifier can authenticate the bytecode is the right
//   interface. This module is that verifier: a single, reusable, side-effect-free preflight every read
//   command runs FIRST, so no record/verdict is reported until the registry is authenticated.
//
// WHAT THE PREFLIGHT PROVES (and what it does NOT)
//   It proves you are talking to a contract that (a) exists at the address, (b) self-identifies as a
//   verifyhash ContributionRegistry of a version this build understands, and (c) — when an
//   artifact/receipt records the chain it was anchored on — lives on THAT chain. That closes the
//   "wrong address / wrong network / wrong contract" gap.
//   It does NOT make the RECORDS honest beyond the contract's own immutable first-writer-wins +
//   commit-reveal rules, and (as the contract NatSpec warns) a FORK can reuse the same REGISTRY_ID — so
//   the marker is a POSITIVE "right interface on the right chain" signal, never a sole root of trust.
//   See docs/TRUST-BOUNDARIES.md and the contract's "ON-CHAIN IDENTITY MARKER" notice.
//
// DISCIPLINE (mirrors verify.js's isNotAnchoredError): a genuine RPC/network error is RE-THROWN as
// itself, never masqueraded as an identity failure. An identity failure is only ever reported when the
// chain answered and the answer was wrong (no code / wrong id / wrong version / wrong chain).

const ARTIFACT = require("./core/registryArtifact");
const ABI = ARTIFACT.abi;

// The DOCUMENTED, frozen identity (T-11.1). Re-derived from the same preimage string the contract's
// NatSpec pins, so this module and the contract can never silently drift: if the preimage moved, this
// derived value would move with it AND the pinned digest below would mismatch in tests.
const REGISTRY_ID_PREIMAGE = "verifyhash.ContributionRegistry.v1";
// The frozen on-chain digest, pinned literally (same value test/Identity.test.js pins). We compare the
// contract's REGISTRY_ID against THIS, not against a value we re-derive at call time, so a tampered
// derivation can't move the goalpost. (deriveRegistryId() lets a test confirm the pin matches the
// preimage.)
const EXPECTED_REGISTRY_ID =
  "0x0395e2ec987e96e51cdf619980638100236c5fc7f7c3646f8b759f3cdceb2df3";

// The maximum REGISTRY_VERSION this build understands. A registry reporting a HIGHER version made a
// breaking interface change we cannot safely read, so we refuse it rather than mis-decode its records.
const MAX_SUPPORTED_REGISTRY_VERSION = 1n;

// The "0x" / "0x0" empty-code sentinels eth_getCode returns for an address with no contract. ethers v6
// returns "0x" for an externally-owned (or non-existent) account.
const EMPTY_CODE = new Set(["0x", "0x0", ""]);

/**
 * Re-derive REGISTRY_ID from the documented preimage. Used by tests to confirm the pinned digest above
 * actually equals keccak256(preimage) — kept here so the preimage lives in exactly one place.
 * @param {object} ethersLib ethers v6 module
 * @returns {string} the 0x 32-byte id
 */
function deriveRegistryId(ethersLib) {
  return ethersLib.keccak256(ethersLib.toUtf8Bytes(REGISTRY_ID_PREIMAGE));
}

/**
 * Distinguish a genuine RPC/network error (provider down, bad URL, timeout, decode-layer failure on a
 * malformed response) from a clean negative answer the chain actually gave us. We RE-THROW genuine
 * errors as themselves so the preflight never masquerades a network problem as an identity failure
 * (mirroring verify.js's isNotAnchoredError discipline, in the opposite direction).
 *
 * A call to a method that does not exist on the target contract (e.g. REGISTRY_ID on a non-registry)
 * reverts — ethers v6 surfaces that as a CALL_EXCEPTION / BAD_DATA (the function selector found nothing
 * to decode), which IS a clean "the chain answered, it is not this contract" signal, NOT a network
 * error. Everything else (NETWORK_ERROR, TIMEOUT, SERVER_ERROR, connection refused, …) is genuine.
 *
 * @param {any} err
 * @returns {boolean} true iff this looks like a real network/RPC failure (re-throw), not an identity miss
 */
function isGenuineRpcError(err) {
  if (!err) return false;
  const code = err.code;
  // ethers v6 network/transport failure codes — these are genuine and must be re-thrown.
  if (
    code === "NETWORK_ERROR" ||
    code === "TIMEOUT" ||
    code === "SERVER_ERROR" ||
    code === "UNKNOWN_ERROR" ||
    code === "UNSUPPORTED_OPERATION"
  ) {
    return true;
  }
  // A reverted/empty call (the method isn't there, or returned no decodable data) is a clean negative,
  // not a network error: CALL_EXCEPTION / BAD_DATA mean "the chain answered; that contract has no such
  // function / returned undecodable data". Those are identity misses, handled by the caller.
  if (code === "CALL_EXCEPTION" || code === "BAD_DATA") return false;
  // Textual fallbacks for providers that don't set a code: connection-shaped messages are genuine.
  const msg = String((err && err.message) || "").toLowerCase();
  if (/econnrefused|enotfound|etimedout|socket hang up|fetch failed|network|timeout|failed to detect/.test(msg)) {
    return true;
  }
  // Default: treat an undecorated failure as an identity miss, NOT a network error — the caller turns
  // it into the actionable "not a verifyhash registry" message. (A real network error almost always
  // carries one of the codes/messages above.)
  return false;
}

/**
 * A typed error for an authentication failure, so a caller can distinguish a registry-identity failure
 * (the chain answered, the answer was wrong) from a re-thrown genuine RPC error.
 */
class RegistryAuthError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "RegistryAuthError";
    this.code = "REGISTRY_AUTH_FAILED";
    if (detail) this.detail = detail;
  }
}

/**
 * Authenticate a deployed ContributionRegistry BEFORE any record read. Pure-ish and side-effect-free:
 * it makes only read-only `eth_call` / `eth_getCode` / `eth_chainId` requests through the supplied
 * provider, writes nothing, and constructs nothing persistent.
 *
 * Checks, in order:
 *   (a) there IS a contract at `contractAddress` (provider.getCode != "0x"); otherwise hard-error with
 *       an actionable "no contract at <addr> on this RPC — wrong address or wrong network?" message;
 *   (b) the contract self-identifies as a verifyhash registry: REGISTRY_ID equals the documented,
 *       frozen id AND REGISTRY_VERSION is present and <= the max version this build understands;
 *       otherwise hard-error "the contract at <addr> is not a verifyhash ContributionRegistry
 *       (identity check failed) — refusing to trust its records";
 *   (c) if `expectedChainId` is supplied (from a receipt/proof artifact), the provider's chainId equals
 *       it; otherwise hard-error "artifact/receipt was anchored on chainId X but this RPC is chainId Y —
 *       refusing to report a verdict against the wrong network".
 *
 * A genuine RPC/network error is RE-THROWN as itself (never masqueraded as an identity failure).
 *
 * @param {object} opts
 * @param {object} opts.provider          ethers v6 Provider (read-only)
 * @param {string} opts.contractAddress   the address to authenticate
 * @param {number|string|bigint} [opts.expectedChainId] chain the artifact/receipt was anchored on
 * @param {object} [opts.ethers]          ethers v6 module (defaults to the bundled one)
 * @returns {Promise<{ chainId: number, registryVersion: number, registryId: string,
 *                     address: string }>} resolved identity on success
 */
async function assertRegistry(opts) {
  const ethersLib = (opts && opts.ethers) || require("ethers");
  const provider = opts && opts.provider;
  const rawAddress = opts && opts.contractAddress;

  if (!provider) {
    throw new Error("assertRegistry requires a provider");
  }
  if (!rawAddress) {
    throw new Error(
      "no contract address: pass --contract <address> or set VH_CONTRACT in the environment"
    );
  }
  if (!ethersLib.isAddress(rawAddress)) {
    throw new Error(`invalid contract address: ${rawAddress}`);
  }
  const address = ethersLib.getAddress(rawAddress);

  // (a) Is there a contract at all? An address with NO code answers every call with empty data, which
  // a naive getRecord reads as "not anchored" — exactly the wrong-address/wrong-network silent failure
  // we are closing. Check code FIRST so the message is the actionable one, not a downstream decode error.
  let code;
  try {
    code = await provider.getCode(address);
  } catch (err) {
    if (isGenuineRpcError(err)) throw err; // never masquerade a network error as an identity failure
    // A non-network failure to even read code is still genuine-ish; surface it rather than guessing.
    throw err;
  }
  if (typeof code !== "string" || EMPTY_CODE.has(code.toLowerCase())) {
    throw new RegistryAuthError(
      `no contract at ${address} on this RPC — wrong address or wrong network? ` +
        "Nothing is deployed there, so there are no records to trust. " +
        "Check --contract / VH_CONTRACT and --rpc / VH_RPC_URL.",
      { reason: "no-code", address }
    );
  }

  const contract = new ethersLib.Contract(address, ABI, provider);

  // (b) Does it self-identify as a verifyhash registry? Read REGISTRY_ID and REGISTRY_VERSION. A
  // contract that lacks these (a non-registry) reverts the call — a CLEAN "not this contract" negative
  // (CALL_EXCEPTION/BAD_DATA), distinct from a network error, which we re-throw.
  let registryId;
  let registryVersion;
  try {
    registryId = await contract.REGISTRY_ID();
  } catch (err) {
    if (isGenuineRpcError(err)) throw err;
    throw new RegistryAuthError(
      identityFailureMessage(address) +
        " (it has no REGISTRY_ID() — the on-chain identity marker is absent).",
      { reason: "no-registry-id", address }
    );
  }
  if (String(registryId).toLowerCase() !== EXPECTED_REGISTRY_ID.toLowerCase()) {
    throw new RegistryAuthError(
      identityFailureMessage(address) +
        ` (REGISTRY_ID mismatch: got ${String(registryId)}, expected ${EXPECTED_REGISTRY_ID}).`,
      { reason: "registry-id-mismatch", address, got: String(registryId) }
    );
  }

  try {
    registryVersion = await contract.REGISTRY_VERSION();
  } catch (err) {
    if (isGenuineRpcError(err)) throw err;
    throw new RegistryAuthError(
      identityFailureMessage(address) +
        " (it has no REGISTRY_VERSION() — the on-chain identity marker is incomplete).",
      { reason: "no-registry-version", address }
    );
  }
  const versionBig = BigInt(registryVersion);
  if (versionBig > MAX_SUPPORTED_REGISTRY_VERSION) {
    throw new RegistryAuthError(
      `the contract at ${address} reports REGISTRY_VERSION ${versionBig}, but this build only ` +
        `understands up to ${MAX_SUPPORTED_REGISTRY_VERSION} — refusing to mis-read a newer ` +
        "registry's records. Upgrade your verifyhash CLI.",
      { reason: "version-too-new", address, version: Number(versionBig) }
    );
  }

  // Resolve the provider's chainId once (needed for the cross-check AND surfaced to the caller).
  let networkChainId;
  try {
    const net = await provider.getNetwork();
    networkChainId = BigInt(net.chainId);
  } catch (err) {
    if (isGenuineRpcError(err)) throw err;
    throw err; // can't read the network — genuine, surface it
  }

  // (c) Optional chainId cross-check: an artifact/receipt that records WHERE it was anchored must be
  // verified against THE SAME chain, or the on-chain checks are meaningless (a root anchored on chain X
  // says nothing about chain Y). This is the portability promise made trustworthy: the consumer no
  // longer has to trust the prover's RPC blindly.
  if (opts.expectedChainId !== undefined && opts.expectedChainId !== null) {
    const want = BigInt(opts.expectedChainId);
    if (want !== networkChainId) {
      throw new RegistryAuthError(
        `artifact/receipt was anchored on chainId ${want} but this RPC is chainId ${networkChainId} ` +
          "— refusing to report a verdict against the wrong network. " +
          "Point --rpc / VH_RPC_URL at the chain the artifact was anchored on.",
        { reason: "chainid-mismatch", expected: Number(want), actual: Number(networkChainId) }
      );
    }
  }

  return {
    chainId: Number(networkChainId),
    registryVersion: Number(versionBig),
    registryId: String(registryId).toLowerCase(),
    address,
  };
}

/** The shared identity-failure lead sentence, reused for every (b)-class failure so callers/tests see
 * one consistent, actionable message. */
function identityFailureMessage(address) {
  return (
    `the contract at ${address} is not a verifyhash ContributionRegistry ` +
    "(identity check failed) — refusing to trust its records"
  );
}

/**
 * Format the one-line "registry authenticated" human confirmation a read command prints so a user can
 * SEE the check ran. Kept in one place so every command's confirmation reads identically.
 * @param {{registryVersion:number, chainId:number}} auth the assertRegistry result
 * @returns {string}
 */
function formatRegistryLine(auth) {
  return `  registry authenticated: REGISTRY_ID ok (v${auth.registryVersion}), chainId ${auth.chainId}`;
}

/**
 * The loud one-liner printed when the preflight is SKIPPED via --skip-identity-check. It must make
 * unmistakably clear the verdict is only as trustworthy as the RPC the caller pointed at.
 * @returns {string}
 */
function formatSkippedLine() {
  return (
    "  registry authentication: SKIPPED (--skip-identity-check). " +
    "The verdict is only as trustworthy as the RPC/address you supplied — the contract was NOT " +
    "confirmed to be a verifyhash registry on the expected network."
  );
}

/**
 * Build the machine-readable `registry` block for `--json` output on success.
 * @param {{registryId:string, registryVersion:number, chainId:number}} auth
 * @returns {{id:string, version:number, chainId:number}}
 */
function jsonRegistryBlock(auth) {
  return { id: auth.registryId, version: auth.registryVersion, chainId: auth.chainId };
}

/** The `registry` block for `--json` when the check was skipped. */
function jsonSkippedBlock() {
  return {
    skipped: true,
    note:
      "registry authentication SKIPPED (--skip-identity-check): the contract was NOT confirmed to be " +
      "a verifyhash registry on the expected network. The verdict is only as trustworthy as the RPC.",
  };
}

module.exports = {
  assertRegistry,
  RegistryAuthError,
  isGenuineRpcError,
  deriveRegistryId,
  identityFailureMessage,
  formatRegistryLine,
  formatSkippedLine,
  jsonRegistryBlock,
  jsonSkippedBlock,
  REGISTRY_ID_PREIMAGE,
  EXPECTED_REGISTRY_ID,
  MAX_SUPPORTED_REGISTRY_VERSION,
  ABI,
};

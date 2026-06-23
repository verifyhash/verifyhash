"use strict";

// cli/proof.js — a versioned, strictly-validated, PORTABLE Merkle-proof artifact for verifyhash.
//
// WHY THIS EXISTS
//   `vh prove <file> --root <dir>` builds a genuine Merkle proof that a single file belongs to an
//   anchored repository root, but historically it only PRINTED the proof or checked it on-chain
//   in-process against the prover's own working tree. That makes the proof non-portable: a third
//   party handed "file X is in anchored repo root R" cannot independently confirm it without
//   re-running the prover against the prover's files. That directly contradicts the project's core
//   promise — "anyone can later prove some content is byte-for-byte what was anchored, without
//   trusting any server."
//
//   This module closes that gap. `vh prove <file> --root <dir> --out <p>` writes a SELF-CONTAINED
//   proof artifact: everything a verifier needs is in the file. `vh verify-proof <p>` then verifies
//   it needing ONLY the artifact + an RPC URL — never the original repo or working tree:
//     (a) it re-derives the leaf from `contentHash` + `relPath` and re-folds `proof` PURELY OFFLINE,
//         using the SAME sorted-pair / domain-separated convention the contract's verifyLeaf uses
//         (reusing hash.js's pathLeaf / leafHash / nodeHash — NOT a re-implementation), to confirm
//         the proof folds back to `root`; then
//     (b) it makes ONE read-only on-chain check that the root is ACTUALLY anchored (isAnchored) and
//         that the contract's own verifyLeaf accepts the proof.
//
// TRUST POSTURE (consistent with docs/TRUST-BOUNDARIES.md)
//   The artifact is an UNTRUSTED TRANSPORT CONTAINER. verify-proof never trusts the file's claims —
//   it RE-DERIVES the leaf from contentHash+relPath (so a forged `leaf` field that doesn't match its
//   own contentHash+relPath is rejected) and re-folds the proof itself; the `root` it checks on-chain
//   is the one the offline fold produced from the proof, and a root that was never anchored reports
//   NOT ANCHORED rather than a false ACCEPT. What this proves is SET-MEMBERSHIP: that the named file
//   (path + bytes) is a leaf of an anchored repo root. It says NOTHING about authorship, the meaning
//   of `contributor`, or any `uri` — exactly as the contract's verifyLeaf says nothing about those.
//   A corrupt artifact must never be silently half-accepted: readProofArtifact validates strictly and
//   throws on ANY deviation rather than filling defaults (mirroring cli/receipt.js's posture).

const fs = require("fs");
const { pathLeaf, leafHash, nodeHash } = require("./hash");
const {
  assertRegistry,
  formatRegistryLine,
  formatSkippedLine,
  jsonRegistryBlock,
  jsonSkippedBlock,
} = require("./registry");

const ARTIFACT = require("../artifacts/contracts/ContributionRegistry.sol/ContributionRegistry.json");
const ABI = ARTIFACT.abi;

// On-disk schema discriminators. A proof artifact carries its OWN kind + version (distinct from the
// receipt kinds in cli/receipt.js) so a random JSON file, a receipt, or a future/foreign artifact is
// never misread as a current proof artifact.
const PROOF_KIND = "verifyhash.merkle-proof";
const PROOF_SCHEMA_VERSION = 1;
const SUPPORTED_PROOF_SCHEMA_VERSIONS = Object.freeze([1]);

// Same hex/address shapes cli/receipt.js validates against, so the two modules never drift.
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// The one-line trust boundary that LEADS every human-readable verify-proof run. It is load-bearing,
// not decorative: a reader must never mistake a set-membership proof for proof of authorship/URI.
const TRUST_CAVEAT = [
  "NOTE: this proves SET-MEMBERSHIP only — that the named file (its path + bytes) is a leaf of an",
  "anchored repo Merkle root. It does NOT prove authorship, who anchored the root, or anything about",
  "any `uri`. The artifact is an UNTRUSTED transport container: verify-proof RE-DERIVES the leaf and",
  "RE-FOLDS the proof itself (it never trusts the file's claims), then confirms the root is anchored",
  "on-chain. Set-membership in an anchored root is exactly what the contract's verifyLeaf attests.",
].join("\n");

// Verify-proof outcomes. ACCEPTED requires BOTH the offline fold AND the on-chain checks to pass.
const STATUS = Object.freeze({
  ACCEPTED: "ACCEPTED", // offline fold folds to root AND root is anchored AND on-chain verifyLeaf true
  REJECTED: "REJECTED", // an offline or on-chain check failed (tampered proof, leaf, contentHash, …)
  NOT_ANCHORED: "NOT_ANCHORED", // offline fold is fine, but the root was never anchored on-chain
});

/**
 * Build a normalized, fully-validated portable proof artifact from a built proof (the object
 * `buildProof` in cli/prove.js returns) plus optional on-chain context. Throws if any required field
 * is missing or malformed, so a corrupt artifact is never even written.
 *
 * `relPath` is the file's repo-relative POSIX path — exactly what was bound into the leaf, so a
 * verifier can RE-DERIVE the leaf from contentHash + relPath without the original tree. The optional
 * `contractAddress` / `chainId` record WHERE the prover expects the root to be anchored; they are
 * UNTRUSTED hints (the verifier may override with --contract/--rpc) but recording them makes the
 * artifact more self-describing.
 *
 * @param {object} built          a buildProof() result: { root, leaf, contentHash, proof, file }
 * @param {object} [ctx]
 * @param {string} [ctx.contractAddress] 0x 20-byte ContributionRegistry address the root is anchored at
 * @param {number|string|bigint} [ctx.chainId] the chain the root is anchored on
 * @returns {object} a validated proof-artifact object
 */
function buildProofArtifact(built, ctx = {}) {
  if (!built || typeof built !== "object") {
    throw new Error("buildProofArtifact requires the object buildProof() returns");
  }
  const artifact = {
    kind: PROOF_KIND,
    schemaVersion: PROOF_SCHEMA_VERSION,
    root: built.root,
    leaf: built.leaf,
    contentHash: built.contentHash,
    relPath: built.file,
    proof: built.proof,
  };
  if (ctx.contractAddress != null) artifact.contractAddress = ctx.contractAddress;
  if (ctx.chainId != null) artifact.chainId = _normChainId(ctx.chainId);
  _validate(artifact);
  return artifact;
}

/** Normalize a chainId (number|string|bigint) to a non-negative integer Number, like receipt.js. */
function _normChainId(v) {
  let n;
  try {
    n = Number(BigInt(v));
  } catch (_) {
    throw new Error(`proof artifact chainId must be an integer, got: ${String(v)}`);
  }
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`proof artifact chainId must be a non-negative integer, got: ${String(v)}`);
  }
  return n;
}

/**
 * Strictly validate a parsed proof-artifact object. Throws an Error describing the FIRST problem.
 * Never mutates and never fills defaults — an artifact either is complete and well-formed or it is
 * rejected outright (mirroring cli/receipt.js's _validate). A malformed/short hash or a `proof` that
 * is not an array of 32-byte hex strings hard-errors here, so verify-proof can never silently accept
 * a structurally bogus file.
 * @param {any} obj
 * @returns {object} the same object, if valid
 */
function _validate(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("proof artifact must be a JSON object");
  }
  if (obj.kind !== PROOF_KIND) {
    throw new Error(
      `not a verifyhash proof artifact (kind: ${JSON.stringify(obj.kind)}; expected ${JSON.stringify(
        PROOF_KIND
      )})`
    );
  }
  if (!SUPPORTED_PROOF_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    throw new Error(
      `unsupported proof artifact schemaVersion: ${JSON.stringify(obj.schemaVersion)} ` +
        `(this build understands ${JSON.stringify(SUPPORTED_PROOF_SCHEMA_VERSIONS)})`
    );
  }

  for (const f of ["root", "leaf", "contentHash"]) {
    const v = obj[f];
    if (v === undefined || v === null) throw new Error(`proof artifact missing required field: ${f}`);
    if (typeof v !== "string" || !HEX32_RE.test(v)) {
      throw new Error(
        `proof artifact field ${f} must be a 0x-prefixed 32-byte hex string, got: ${String(v)}`
      );
    }
  }

  if (typeof obj.relPath !== "string" || obj.relPath.length === 0) {
    throw new Error(`proof artifact relPath must be a non-empty string, got: ${String(obj.relPath)}`);
  }

  if (!Array.isArray(obj.proof)) {
    throw new Error("proof artifact field proof must be an array of 0x 32-byte hex siblings");
  }
  obj.proof.forEach((sib, i) => {
    if (typeof sib !== "string" || !HEX32_RE.test(sib)) {
      throw new Error(
        `proof artifact proof[${i}] must be a 0x-prefixed 32-byte hex string, got: ${String(sib)}`
      );
    }
  });

  // Optional on-chain context. Validate SHAPE only when present (an artifact built with --dry-run and
  // no chain context legitimately omits both).
  if (obj.contractAddress !== undefined && obj.contractAddress !== null) {
    if (typeof obj.contractAddress !== "string" || !ADDR_RE.test(obj.contractAddress)) {
      throw new Error(
        `proof artifact contractAddress must be a 0x-prefixed 20-byte address when present, got: ${String(
          obj.contractAddress
        )}`
      );
    }
  }
  if (obj.chainId !== undefined && obj.chainId !== null) {
    if (!Number.isSafeInteger(obj.chainId) || obj.chainId < 0) {
      throw new Error(
        `proof artifact chainId must be a non-negative integer when present, got: ${String(obj.chainId)}`
      );
    }
  }

  return obj;
}

/**
 * Validate and write a proof artifact to `path` as pretty JSON. The only side effect is the file
 * write, and it throws (before writing) if the object is not a valid artifact, so a corrupt artifact
 * never lands on disk. Mirrors cli/receipt.js's writeReceipt.
 * @param {object} obj  a proof artifact (typically from buildProofArtifact)
 * @param {string} path destination file path (caller-chosen — never silently the cwd)
 * @returns {object} the validated object that was written
 */
function writeProofArtifact(obj, path) {
  if (!path || typeof path !== "string") {
    throw new Error("writeProofArtifact requires a destination path");
  }
  const valid = _validate(obj);
  fs.writeFileSync(path, JSON.stringify(valid, null, 2) + "\n");
  return valid;
}

/**
 * Read, JSON-parse, and strictly validate a proof artifact from `path`. Throws a clear error if the
 * file is missing, not JSON, or fails validation — it NEVER returns a partial/corrupt artifact.
 * Mirrors cli/receipt.js's readReceipt.
 * @param {string} path
 * @returns {object} the validated artifact
 */
function readProofArtifact(path) {
  if (!path || typeof path !== "string") {
    throw new Error("readProofArtifact requires a path");
  }
  let raw;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read proof artifact at ${path}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`proof artifact at ${path} is not valid JSON: ${e.message}`);
  }
  try {
    return _validate(parsed);
  } catch (e) {
    throw new Error(`proof artifact at ${path} is invalid: ${e.message}`);
  }
}

/**
 * Re-fold a proof artifact PURELY OFFLINE — no network — to confirm it is internally consistent. This
 * is the portability core: it re-derives the leaf from contentHash + relPath and replays the proof
 * with the SAME convention the contract's verifyLeaf uses, reusing hash.js's pathLeaf / leafHash /
 * nodeHash (NOT a re-implementation). Two independent things are checked:
 *
 *   1. leafMatches — the artifact's `leaf` actually equals pathLeaf(relPath, contentHash). A forged
 *      `leaf` that does not match its own claimed contentHash+relPath fails here, so verify-proof can
 *      never be fooled by swapping the leaf alone.
 *   2. foldsToRoot — folding leafHash(leaf) up through `proof` with nodeHash reproduces `root` (the
 *      exact computation verifyLeaf does on-chain: it applies LEAF_TAG to the supplied value, then
 *      folds NODE_TAG sorted-pairs). The `computedRoot` is returned so the caller checks the SAME root
 *      on-chain that the offline fold produced — not merely the `root` field the file claims.
 *
 * @param {object} artifact a validated proof artifact (from readProofArtifact / buildProofArtifact)
 * @returns {{
 *   derivedLeaf: string,   // pathLeaf(relPath, contentHash) — what the leaf MUST be
 *   leafMatches: boolean,  // artifact.leaf === derivedLeaf
 *   computedRoot: string,  // fold of leafHash(leaf) through proof
 *   foldsToRoot: boolean,  // computedRoot === artifact.root
 *   offlineOk: boolean,    // leafMatches && foldsToRoot
 * }}
 */
function recomputeFold(artifact) {
  // Re-derive the leaf from the path + content digest the artifact carries. This is exactly the
  // path-bound leaf hashDir/buildProof produced, so a genuine artifact's stored `leaf` equals it.
  const derivedLeaf = pathLeaf(artifact.relPath, artifact.contentHash);
  const leafMatches = derivedLeaf.toLowerCase() === artifact.leaf.toLowerCase();

  // Fold the (tagged) leaf up through the proof, byte-identically to the on-chain verifyLeaf:
  //   computed = leafHash(leaf);  for each sibling s: computed = nodeHash(computed, s)
  // We fold the artifact's stored leaf (the value the contract is handed); leafMatches above
  // independently guarantees that stored leaf is the genuine pathLeaf for (relPath, contentHash).
  let computed = leafHash(artifact.leaf);
  for (const sibling of artifact.proof) {
    computed = nodeHash(computed, sibling);
  }
  const computedRoot = computed;
  const foldsToRoot = computedRoot.toLowerCase() === artifact.root.toLowerCase();

  return {
    derivedLeaf,
    leafMatches,
    computedRoot,
    foldsToRoot,
    offlineOk: leafMatches && foldsToRoot,
  };
}

/**
 * Render a verify-proof result as the human-readable block the CLI prints. Always LEADS with the
 * trust-boundary one-liner (set-membership only, not authorship/uri), then the per-check breakdown,
 * then the verdict and — on anything other than ACCEPTED — exactly which check failed.
 */
function formatVerifyProof(r) {
  const yn = (b) => (b ? "yes" : "NO");
  const lines = [
    TRUST_CAVEAT,
    "",
    `  proof artifact: ${r.artifactPath}`,
    `  relPath:        ${r.relPath}`,
    `  contentHash:    ${r.contentHash}`,
    `  leaf:           ${r.leaf}`,
    `  root:           ${r.root}`,
    `  proof siblings: ${r.proofLength}`,
    "",
    "  offline recompute (no network):",
    `    leaf re-derived from contentHash+relPath: ${yn(r.leafMatches)}`,
    `    proof folds to the claimed root:          ${yn(r.foldsToRoot)}`,
  ];
  // T-11.2: the registry-authentication confirmation (or the loud skip warning), printed BEFORE the
  // on-chain checks so a reader sees the contract+network were authenticated before believing them.
  if (r.checkedChain || r.identitySkipped) {
    if (r.identitySkipped) {
      lines.push("", formatSkippedLine());
    } else if (r.registry) {
      lines.push("", formatRegistryLine(r.registry));
    }
  }
  // On-chain checks are only meaningful once the offline fold holds; we still report what we did.
  if (r.checkedChain) {
    lines.push(
      "",
      "  on-chain checks (one read-only call set):",
      `    root is anchored (isAnchored):            ${yn(r.rootAnchored)}`,
      `    contract verifyLeaf accepts the proof:    ${yn(r.onChainVerified)}`
    );
  } else if (r.offlineOk) {
    lines.push("", "  on-chain checks: SKIPPED (no provider) — offline fold only.");
  }
  lines.push("", `  result:         ${r.status}`);

  if (r.status === STATUS.ACCEPTED) {
    lines.push(
      "  ACCEPTED: the file is a leaf of a Merkle root that is anchored on-chain (set-membership",
      "  proven offline AND confirmed on-chain). This binds the file's path + bytes to the anchored",
      "  root; it does NOT attest authorship or the meaning of `contributor`/`uri`."
    );
  } else if (r.status === STATUS.NOT_ANCHORED) {
    lines.push(
      "  NOT ANCHORED: the proof folds to its root OFFLINE, but that root was never anchored on-chain.",
      "  There is nothing on-chain to prove the file against (it was never anchored, or you are pointed",
      "  at the wrong contract/chain). This is NOT an accept."
    );
  } else {
    // REJECTED — name the first failed check so the reason is unambiguous.
    if (!r.leafMatches) {
      lines.push(
        "  REJECTED: the artifact's `leaf` does NOT equal pathLeaf(contentHash, relPath) — the leaf,",
        "  contentHash, or relPath was altered. A tampered leaf/contentHash is caught here offline."
      );
    } else if (!r.foldsToRoot) {
      lines.push(
        "  REJECTED: the proof does NOT fold to the claimed root — a `proof` sibling (or the root) was",
        "  altered. The file is not a member of that root. Caught here offline, no network needed."
      );
    } else if (r.checkedChain && !r.onChainVerified) {
      lines.push(
        "  REJECTED: the offline fold held, but the on-chain verifyLeaf rejected the proof against the",
        "  anchored root. (The on-chain root differs from the artifact's root, or the proof was altered.)"
      );
    } else {
      lines.push("  REJECTED: a verification check failed.");
    }
  }
  return lines.join("\n");
}

/**
 * Shape a verify-proof result for `--json`. A machine consumer gets the same verdict + per-check
 * booleans as the human block (so `--json` round-trips), plus the artifact's identifying hashes. The
 * trust caveat is included verbatim so a JSON consumer can surface it too.
 */
function jsonVerifyProof(r) {
  return {
    kind: PROOF_KIND,
    artifactPath: r.artifactPath,
    relPath: r.relPath,
    contentHash: r.contentHash,
    leaf: r.leaf,
    root: r.root,
    proofLength: r.proofLength,
    offline: {
      leafMatches: r.leafMatches,
      foldsToRoot: r.foldsToRoot,
      ok: r.offlineOk,
    },
    onChain: r.checkedChain
      ? { checked: true, rootAnchored: r.rootAnchored, verifyLeaf: r.onChainVerified }
      : { checked: false },
    // T-11.2: the machine-readable registry block — proves the on-chain leg ran against an
    // authenticated registry on the artifact's recorded chain (or that the check was skipped). null
    // when no on-chain leg ran (offline-only / rejected before the chain check).
    registry: r.identitySkipped
      ? jsonSkippedBlock()
      : r.registry
      ? jsonRegistryBlock(r.registry)
      : null,
    accepted: r.status === STATUS.ACCEPTED,
    status: r.status,
    trustNote: TRUST_CAVEAT,
  };
}

/**
 * Verify a portable proof artifact. Read-only: needs ONLY the artifact + (for the on-chain leg) a
 * provider. NEVER needs the original repo/working tree, and NEVER a signer or key — that is the
 * portability property: hand someone the artifact and an RPC URL and they can independently confirm
 * the file is in the anchored root with no trust in the prover.
 *
 * Flow:
 *   1. Read + strictly validate the artifact (a malformed/short hash or non-hex proof hard-ERRORS).
 *   2. Recompute the leaf from contentHash+relPath and re-fold the proof PURELY OFFLINE. If that fold
 *      fails (tampered leaf/contentHash/proof/root), the verdict is REJECTED immediately — no network.
 *   3. If a provider is supplied, make the on-chain checks against the SAME root the offline fold
 *      produced: isAnchored(root) AND verifyLeaf(root, leaf, proof). A root that was never anchored is
 *      reported as NOT_ANCHORED (a distinct, non-accept outcome), distinguished from a genuine RPC
 *      error exactly as verify.js/show.js do (a real error is re-thrown, not masqueraded). ACCEPTED is
 *      printed ONLY when the offline fold AND both on-chain checks pass.
 *
 * @param {object} opts
 * @param {string}  opts.artifactPath        path to the proof artifact JSON
 * @param {string} [opts.contractAddress]    override the artifact's contractAddress (else use it)
 * @param {object} [opts.provider]           ethers v6 Provider (read-only); omit for an offline-only run
 * @param {boolean}[opts.json]               emit a JSON object instead of the human block
 * @param {object} [opts.ethers]             ethers v6 module (defaults to the bundled one)
 * @param {(s:string)=>void}[opts.log]       sink for output (defaults to process.stdout)
 * @returns {Promise<object>} the structured result
 */
async function runVerifyProof(opts) {
  const ethersLib = opts.ethers || require("ethers");
  const log = opts.log || ((s) => process.stdout.write(s));

  const artifact = readProofArtifact(opts.artifactPath);
  const fold = recomputeFold(artifact);

  const result = {
    artifactPath: opts.artifactPath,
    relPath: artifact.relPath,
    contentHash: artifact.contentHash,
    leaf: artifact.leaf,
    root: artifact.root,
    proofLength: artifact.proof.length,
    derivedLeaf: fold.derivedLeaf,
    leafMatches: fold.leafMatches,
    computedRoot: fold.computedRoot,
    foldsToRoot: fold.foldsToRoot,
    offlineOk: fold.offlineOk,
    checkedChain: false,
    rootAnchored: null,
    onChainVerified: null,
    contractAddress: null,
    // T-11.2: the resolved registry identity (or null when not yet checked / skipped / offline-only).
    registry: null,
    identitySkipped: Boolean(opts.skipIdentityCheck),
    artifactChainId: artifact.chainId != null ? artifact.chainId : null,
    status: STATUS.REJECTED,
  };

  // The offline fold is the gate: if the artifact is not internally consistent (tampered leaf/
  // contentHash/proof/root), it is REJECTED before any network call. Membership in a root the proof
  // does not even fold to is meaningless to check on-chain.
  if (!fold.offlineOk) {
    result.status = STATUS.REJECTED;
    _emit(result, opts, log);
    return result;
  }

  const provider = opts.provider;
  if (!provider) {
    // No provider: the offline fold is the only thing we can assert. The acceptance criteria require
    // the on-chain leg for an ACCEPTED verdict, so without a provider we do NOT claim ACCEPTED — we
    // surface the offline-only result (status stays REJECTED so a script never reads it as a full
    // pass). Callers that want an offline-only confirmation read result.offlineOk.
    result.status = STATUS.REJECTED;
    result.note = "no provider: offline fold passed but the on-chain anchored check was not performed";
    _emit(result, opts, log);
    return result;
  }

  // Resolve the contract address: explicit override > the artifact's recorded address. The artifact's
  // address is an untrusted hint, so an explicit --contract always wins.
  const contractAddress = opts.contractAddress || artifact.contractAddress;
  if (!contractAddress) {
    throw new Error(
      "no contract address: pass --contract <address> (or set VH_CONTRACT), " +
        "or use an artifact that records its contractAddress"
    );
  }
  if (!ethersLib.isAddress(contractAddress)) {
    throw new Error(`invalid contract address: ${contractAddress}`);
  }
  result.contractAddress = ethersLib.getAddress(contractAddress);

  // T-11.2: authenticate the registry BEFORE the on-chain checks — and cross-check the chainId. The
  // artifact's recorded `chainId` (T-9.2) is passed as expectedChainId, so the offline fold + on-chain
  // checks are believed ONLY once the provider is confirmed to be the right network AND the contract is
  // the real registry. This is the portability promise made trustworthy: the consumer no longer has to
  // trust the prover's RPC blindly. (A power user pointed at a known local/not-yet-deployed contract can
  // opt out, loudly, via skipIdentityCheck.)
  let registryAuth = null;
  if (!opts.skipIdentityCheck) {
    registryAuth = await assertRegistry({
      provider,
      contractAddress: result.contractAddress,
      // The artifact's chainId is an UNTRUSTED hint we now ENFORCE: if it disagrees with the provider's
      // chain, refuse to report a verdict against the wrong network.
      expectedChainId: artifact.chainId,
      ethers: ethersLib,
    });
  }
  result.registry = registryAuth;
  result.identitySkipped = Boolean(opts.skipIdentityCheck);

  const contract = new ethersLib.Contract(result.contractAddress, ABI, provider);

  // ONE read-only on-chain check set: is the root anchored, and does the contract's verifyLeaf accept
  // the proof. We check anchoring against the root the OFFLINE FOLD produced (computedRoot), which
  // equals the artifact root here (foldsToRoot held) — so we never trust the file's root unchecked.
  result.checkedChain = true;
  result.rootAnchored = await contract.isAnchored(fold.computedRoot);
  if (!result.rootAnchored) {
    // The proof is internally valid but its root was never anchored — distinct from a tamper. This is
    // NOT a false ACCEPT; the CLI exits non-zero on it.
    result.status = STATUS.NOT_ANCHORED;
    _emit(result, opts, log);
    return result;
  }

  // The contract's own verdict (defense in depth: even if our offline fold had a bug, the chain
  // decides). verifyLeaf takes the path-bound leaf as its `contentHash` argument and tags it itself.
  result.onChainVerified = await contract.verifyLeaf(
    fold.computedRoot,
    artifact.leaf,
    artifact.proof
  );

  result.status =
    result.offlineOk && result.rootAnchored && result.onChainVerified
      ? STATUS.ACCEPTED
      : STATUS.REJECTED;

  _emit(result, opts, log);
  return result;
}

/** Emit the result as JSON or the human block, per opts.json. */
function _emit(result, opts, log) {
  if (opts.json) {
    log(JSON.stringify(jsonVerifyProof(result), null, 2) + "\n");
  } else {
    log(formatVerifyProof(result) + "\n");
  }
}

module.exports = {
  PROOF_KIND,
  PROOF_SCHEMA_VERSION,
  SUPPORTED_PROOF_SCHEMA_VERSIONS,
  STATUS,
  TRUST_CAVEAT,
  buildProofArtifact,
  writeProofArtifact,
  readProofArtifact,
  recomputeFold,
  runVerifyProof,
  formatVerifyProof,
  jsonVerifyProof,
  ABI,
  // Exported for unit tests that exercise validation directly.
  _validate,
};

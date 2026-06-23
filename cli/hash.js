"use strict";

// Content hashing for the verifyhash CLI.
//
// Two operations, both designed to line up exactly with the on-chain contract:
//
//   * hashFile(path)  -> keccak256 of the file's raw bytes. This is the same digest
//     the contract sees: `keccak256(abi.encodePacked(content))` in Solidity. Anchoring
//     this value and later proving against it requires byte-for-byte equality.
//
//   * hashDir(path)   -> a *stable, sorted-leaf* Merkle root whose proofs verify against
//     ContributionRegistry.verifyLeaf. The tree is DOMAIN-SEPARATED (RFC 6962 /
//     OpenZeppelin style) so that a crafted interior node can never be re-presented as a
//     leaf (second-preimage resistance):
//       - a leaf is leafHash(c) = keccak256(LEAF_TAG ++ c), where c = keccak256(file bytes)
//       - an interior node is nodeHash(a,b) = keccak256(NODE_TAG ++ min(a,b) ++ max(a,b))
//     The on-chain verifyLeaf applies LEAF_TAG to its content-digest argument itself and
//     folds with NODE_TAG, so a root produced here is exactly the root the contract
//     reconstructs from a content digest + proof. The two conventions are byte-identical.
//
//     "Stable" means the root does not depend on filesystem enumeration order: leaves are
//     sorted before the tree is built, so the same set of files always yields the same root.

const fs = require("fs");
const path = require("path");
const { keccak256, concat } = require("ethers");

/**
 * keccak256 of a single file's raw bytes, as a 0x-prefixed 32-byte hex string.
 * Deterministic: identical bytes always produce the identical digest, and an empty
 * file hashes to keccak256("") just like Solidity's keccak256 of empty input.
 * @param {string} filePath
 * @returns {string} 0x-prefixed bytes32 hex
 */
function hashFile(filePath) {
  const data = fs.readFileSync(filePath); // Buffer; works for empty files (length 0) too.
  return keccak256(data);
}

/**
 * keccak256 of an in-memory buffer / byte array. Exposed so callers (and tests) can hash
 * content without touching the filesystem. Equivalent to hashFile for the same bytes.
 * @param {Buffer|Uint8Array|string} bytes a Buffer/Uint8Array, or a 0x hex string
 * @returns {string} 0x-prefixed bytes32 hex
 */
function hashBytes(bytes) {
  return keccak256(bytes);
}

// Domain tags, byte-identical to ContributionRegistry's LEAF_TAG / NODE_TAG. These keep a leaf
// hash, an interior-node hash, and a bare content digest in three disjoint value spaces, so an
// interior node can never be replayed as a leaf (second-preimage resistance).
const LEAF_TAG = "0x00";
const NODE_TAG = "0x01";

/**
 * Domain-separated leaf hash, matching ContributionRegistry.leafHash:
 *   leafHash(c) = keccak256(LEAF_TAG ++ c)
 * `c` is a per-file content digest = keccak256(file bytes). Tagging the leaf means the value at the
 * bottom of the tree differs from `c` itself and from any interior node, defeating second-preimage
 * forgeries that try to pass a node (or a bare content digest) off as a leaf.
 * @param {string} c 0x bytes32 content digest
 * @returns {string} 0x bytes32 tagged leaf
 */
function leafHash(c) {
  return keccak256(concat([LEAF_TAG, c]));
}

/**
 * One level of sorted-pair, domain-tagged interior hashing, matching ContributionRegistry.nodeHash:
 *   nodeHash(a,b) = a <= b ? keccak256(NODE_TAG ++ a ++ b) : keccak256(NODE_TAG ++ b ++ a)
 * Comparison is on the 32-byte big-endian value, exactly as Solidity compares bytes32. The NODE_TAG
 * prefix is what keeps an interior node from ever colliding with a (LEAF_TAG-prefixed) leaf.
 * @param {string} a 0x bytes32
 * @param {string} b 0x bytes32
 * @returns {string} 0x bytes32
 */
function nodeHash(a, b) {
  const [lo, hi] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
  return keccak256(concat([NODE_TAG, lo, hi]));
}

/**
 * Recursively collect every file under `dirPath`, returning absolute file paths.
 * Symlinks are not followed (we hash real file content, not link targets).
 * @param {string} dirPath
 * @returns {string[]} absolute file paths
 */
function listFiles(dirPath) {
  const out = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
    // sockets/fifos/symlinks are intentionally skipped: they have no stable content hash.
  }
  return out;
}

/**
 * Build a sorted-leaf, domain-separated Merkle tree and return its layers (bottom-up).
 *
 * Input `leaves` are per-file CONTENT DIGESTS (c = keccak256(file bytes)). They are sorted ascending
 * by their 32-byte value so the tree — and thus the root — is independent of input order. Each is
 * then mapped to a *tagged* leaf via leafHash(c) = keccak256(LEAF_TAG ++ c); the tagged values form
 * the bottom layer of `layers`. Interior layers are folded with nodeHash (NODE_TAG-tagged), exactly
 * as ContributionRegistry.verifyLeaf does. This domain separation is what makes the scheme
 * second-preimage resistant: an interior node value can never be re-presented as a leaf.
 *
 * `sortedLeaves` (returned) is the sorted CONTENT DIGEST array (pre-tag), used for index lookup by a
 * caller that knows a file's content digest. `layers[0]` is the corresponding TAGGED-leaf layer.
 *
 * Odd nodes are paired with *themselves* (`nodeHash(node, node)`) rather than promoted unchanged to
 * the next level. This is the OpenZeppelin / merkletreejs "duplicate the lone node" convention.
 * Promoting a node unchanged (the old carry rule) makes that node its own ancestor, so its Merkle
 * proof skips a level and can collapse to a single sibling (or none) — a degenerate, shorter-than-
 * the-tree proof. Hashing the lone node against itself gives every leaf a genuine sibling at each
 * level, so a depth-d tree yields a depth-d proof for *all* leaves, and stays compatible with the
 * contract's verifyLeaf (it folds `computed == x` with proof element `x` as `nodeHash(x, x)`).
 * @param {string[]} leaves array of 0x bytes32 content digests
 * @returns {{ root: string, layers: string[][], sortedLeaves: string[] }}
 */
function buildTree(leaves) {
  if (leaves.length === 0) {
    throw new Error("cannot build a Merkle tree from zero leaves");
  }
  const sortedLeaves = leaves.slice().sort((a, b) => {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });

  // Bottom layer is the DOMAIN-TAGGED leaves; folding then matches the on-chain verifier exactly.
  let layer = sortedLeaves.map((c) => leafHash(c));
  const layers = [layer];
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      // Pair (i, i+1); if i is the lone last (odd) node, pair it with itself.
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];
      next.push(nodeHash(layer[i], right));
    }
    layer = next;
    layers.push(layer);
  }
  return { root: layers[layers.length - 1][0], layers, sortedLeaves };
}

/**
 * Generate a Merkle proof for the leaf at `index` within `layers` (as produced by
 * buildTree). The proof is the sequence of sibling hashes from leaf to root; replaying
 * it with sorted-pair hashing reproduces the root — i.e. it is accepted by verifyLeaf.
 *
 * Mirrors buildTree's "duplicate the lone node" rule: when a node is the last in an
 * odd-length level it has no real neighbor, so its sibling is its own value (the parent
 * was `nodeHash(node, node)`). We therefore push `lvl[idx]` itself in that case, giving a
 * full-depth proof for every leaf rather than skipping the level.
 *
 * `layers[0]` is the TAGGED-leaf layer (see buildTree), so the sibling values pushed here are the
 * exact node/leaf hashes the on-chain verifyLeaf folds against — the proof is replay-compatible.
 * @param {string[][]} layers
 * @param {number} index index into the *sorted* leaf layer
 * @returns {string[]} proof (array of 0x bytes32)
 */
function proofForIndex(layers, index) {
  const proof = [];
  let idx = index;
  for (let l = 0; l < layers.length - 1; l++) {
    const lvl = layers[l];
    const sibling = idx ^ 1;
    // In-range sibling -> push it. Otherwise this is a lone odd node whose sibling is
    // itself (buildTree paired it with itself), so push its own value.
    proof.push(sibling < lvl.length ? lvl[sibling] : lvl[idx]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/**
 * Hash a directory into a stable sorted-leaf Merkle root.
 *
 * Each file contributes one leaf = keccak256(file bytes) — the same per-file digest
 * hashFile returns, so a single file proven against the directory root uses its own
 * content hash as the leaf. Duplicate-content files collapse to the same leaf value.
 *
 * @param {string} dirPath
 * @returns {{
 *   root: string,
 *   leaves: { path: string, leaf: string }[],   // per-file, sorted by leaf value
 *   proofFor: (relOrAbsPath: string) => string[]
 * }}
 */
function hashDir(dirPath) {
  const files = listFiles(dirPath);
  if (files.length === 0) {
    throw new Error(`no files found under directory: ${dirPath}`);
  }
  // Compute (path, leaf) pairs, then sort by leaf so the root is order-independent.
  const pairs = files.map((f) => ({
    path: path.relative(dirPath, f),
    abs: f,
    leaf: hashFile(f),
  }));

  const { root, layers, sortedLeaves } = buildTree(pairs.map((p) => p.leaf));

  // Re-order the metadata to match the sorted leaf layer used to build the tree.
  // (Sort the pairs the same way buildTree sorted the bare leaves.)
  const sortedPairs = pairs
    .slice()
    .sort((a, b) => {
      const x = BigInt(a.leaf);
      const y = BigInt(b.leaf);
      return x < y ? -1 : x > y ? 1 : 0;
    });

  function proofFor(target) {
    // Allow lookup either by a leaf hash directly, or by file path (rel or abs).
    let index = -1;
    if (/^0x[0-9a-fA-F]{64}$/.test(target)) {
      index = sortedLeaves.findIndex((l) => BigInt(l) === BigInt(target));
    } else {
      const absTarget = path.isAbsolute(target) ? target : path.resolve(dirPath, target);
      index = sortedPairs.findIndex(
        (p) => p.abs === absTarget || p.path === target
      );
    }
    if (index < 0) throw new Error(`target not found in directory tree: ${target}`);
    return proofForIndex(layers, index);
  }

  return {
    root,
    leaves: sortedPairs.map((p) => ({ path: p.path, leaf: p.leaf })),
    proofFor,
  };
}

/**
 * Hash a path, dispatching on whether it is a file or a directory.
 * @param {string} targetPath
 * @returns {{ kind: "file"|"dir", root: string, leaves?: {path:string,leaf:string}[] }}
 */
function hashPath(targetPath) {
  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    const { root, leaves } = hashDir(targetPath);
    return { kind: "dir", root, leaves };
  }
  if (stat.isFile()) {
    return { kind: "file", root: hashFile(targetPath) };
  }
  throw new Error(`not a regular file or directory: ${targetPath}`);
}

module.exports = {
  hashFile,
  hashBytes,
  hashDir,
  hashPath,
  leafHash,
  nodeHash,
  buildTree,
  proofForIndex,
  listFiles,
};

"use strict";

// cli/journal-log.js — the pure, transport/filesystem-agnostic ORDERED MERKLE-LOG CORE (T-63.1).
//
// WHY THIS EXISTS (EPIC-63, an AUDITABLE transparency log over the journal)
//   cli/journal.js gives an APPEND-ONLY hash-chain: verifyJournal walks the whole chain and localizes
//   the first break. That proves continuity, but a consumer must hold (or re-walk) the ENTIRE log to
//   check any one fact. This module adds the second half a real transparency log needs: an RFC-6962 /
//   Certificate-Transparency-style ORDERED Merkle tree over the journal's entry hashes, so that:
//     - a single tree HEAD (root + size) commits to the whole ordered log;
//     - INCLUSION can be proven for one entry with an O(log n) path — the consumer never needs the log;
//     - CONSISTENCY between an old head (size m) and a new head (size n) can be proven with an O(log n)
//       path — proving the new log is an APPEND-ONLY EXTENSION of the old one WITHOUT the full log.
//   Together these let an auditor who saw an old signed head later confirm the operator only ever
//   APPENDED — the exact "no history was rewritten" guarantee a hash-chain alone cannot prove compactly.
//
// POSITION-PRESERVING, NOT SORTED (the crucial difference from cli/hash.js buildTree)
//   cli/hash.js builds a *sorted-leaf, sorted-pair* Merkle root: it commits to a SET of files and is
//   deliberately order-independent. A journal is the opposite: ORDER IS MEANING. So this tree keeps
//   leaves in their given position and folds interior nodes as HASH(0x01 || left || right) with the
//   children in TREE ORDER (NOT min/max). Reordering the log therefore changes the root — which is
//   exactly what makes an append-only/consistency proof possible. The two trees intentionally produce
//   DIFFERENT roots for the same leaves when order matters (a test demonstrates this).
//
// CRYPTO REUSED VERBATIM (no new primitive invented here)
//   The only hash is `hashBytes` (keccak256) from cli/hash.js — the SAME primitive the project already
//   trusts for seals and Merkle roots. Domain separation follows RFC 6962:
//     - leaf   hash: HASH(0x00 || leafData)            -> leafHash()
//     - node   hash: HASH(0x01 || left || right)       -> nodeHash()   (children in ORDER, not sorted)
//   The 0x00 / 0x01 prefixes keep a leaf value and an interior node in disjoint spaces, so a node can
//   never be replayed as a leaf (second-preimage resistance).
//
// PURITY (a hard acceptance criterion)
//   This file does NO disk I/O, opens NO socket, and holds no signing material. It requires ONLY:
//     - `hashBytes` from cli/hash.js, and
//     - the pure byte helpers `concat` / `toUtf8Bytes` from ethers (NOT network or signing primitives).
//   A grep in test/journal-log.core.test.js asserts it requires NONE of fs/http/https/net/dns and does
//   no signer/keyfile work. Every exported function is TOTAL: it NEVER throws on malformed/adversarial
//   input — generators return `null`, verifiers return `false`, and there is NO clock and NO randomness,
//   so results are fully deterministic.
//
// ALGORITHMS
//   The tree head (MTH), inclusion PATH and consistency PROOF/SUBPROOF are the recursive definitions
//   from RFC 6962 §2.1. The verifiers are the iterative, index-arithmetic reference algorithm used by
//   Certificate Transparency (decompose the index into an "inner" run + a "border" of carried subtrees,
//   then fold) — an INDEPENDENT reconstruction path from the generator, so a generate→verify round-trip
//   over every (size, index) and every (m ≤ n) pair is a strong correctness check (the test does this).

const { concat, toUtf8Bytes } = require("ethers");
const { hashBytes } = require("./hash");

// ---------------------------------------------------------------------------------------------------
// Domain-separated hashing (RFC 6962). leaf = 0x00-prefixed, node = 0x01-prefixed, children NOT sorted.
// ---------------------------------------------------------------------------------------------------

const LEAF_PREFIX = "0x00";
const NODE_PREFIX = "0x01";

// The documented root of the EMPTY log. RFC 6962 hashes the empty string; we use a domain-separated
// constant instead so an empty-tree root can never collide with a real leaf/node hash. Deterministic
// and recomputable: keccak256 of the fixed ASCII domain below.
const EMPTY_ROOT_DOMAIN = "vh.journal-log/v1:empty-root";
const EMPTY_ROOT = hashBytes(toUtf8Bytes(EMPTY_ROOT_DOMAIN));

const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;

function _isHex32(x) {
  return typeof x === "string" && HEX32_RE.test(x);
}

function _allHex32(arr) {
  return Array.isArray(arr) && arr.every(_isHex32);
}

/**
 * RFC-6962 leaf hash: HASH(0x00 || leafData). `leafData` is a 0x-prefixed 32-byte hex value (here, a
 * journal entry hash). Single-leaf trees have root === leafHash(leaf0).
 * @param {string} leaf 0x bytes32
 * @returns {string} 0x bytes32
 */
function leafHash(leaf) {
  return hashBytes(concat([LEAF_PREFIX, leaf]));
}

/**
 * RFC-6962 interior node hash: HASH(0x01 || left || right). Children are folded in TREE ORDER — NOT
 * min/max sorted — which is what makes the tree position-preserving.
 * @param {string} left 0x bytes32
 * @param {string} right 0x bytes32
 * @returns {string} 0x bytes32
 */
function nodeHash(left, right) {
  return hashBytes(concat([NODE_PREFIX, left, right]));
}

// ---------------------------------------------------------------------------------------------------
// Small non-negative-integer bit helpers. Implemented with division/modulo (not JS 32-bit bitwise
// operators) so they stay correct for any safe integer and never surprise on large sizes. Pure.
// ---------------------------------------------------------------------------------------------------

// Number of bits to represent x (x >= 0): bitLength(0)=0, bitLength(1)=1, bitLength(5)=3.
function _bitLength(x) {
  let n = 0;
  while (x > 0) {
    x = Math.floor(x / 2);
    n++;
  }
  return n;
}

// Population count (number of set bits) of x (x >= 0).
function _onesCount(x) {
  let c = 0;
  while (x > 0) {
    c += x % 2;
    x = Math.floor(x / 2);
  }
  return c;
}

// Number of trailing zero bits of x (x >= 1): trailingZeros(1)=0, trailingZeros(4)=2, trailingZeros(6)=1.
function _trailingZeros(x) {
  let n = 0;
  while (x > 0 && x % 2 === 0) {
    x = Math.floor(x / 2);
    n++;
  }
  return n;
}

// Bitwise XOR of two non-negative integers, without 32-bit truncation.
function _xor(a, b) {
  let res = 0;
  let bit = 1;
  while (a > 0 || b > 0) {
    if (a % 2 !== b % 2) res += bit;
    a = Math.floor(a / 2);
    b = Math.floor(b / 2);
    bit *= 2;
  }
  return res;
}

// Logical right shift: floor(x / 2^k).
function _shr(x, k) {
  return Math.floor(x / Math.pow(2, k));
}

// The i-th bit of x (0 = least significant).
function _bitAt(x, i) {
  return _shr(x, i) % 2;
}

// Largest power of two STRICTLY less than n (RFC 6962 "k"), for n >= 2. e.g. 2->1, 3->2, 4->2, 5->4.
function _largestPowerOfTwoLessThan(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

// ---------------------------------------------------------------------------------------------------
// Merkle Tree Hash (MTH) — RFC 6962 §2.1, recursive. Operates on the ORDERED raw leaf values.
//   MTH({})      = EMPTY_ROOT
//   MTH({d0})    = leafHash(d0)
//   MTH(D[0:n])  = nodeHash(MTH(D[0:k]), MTH(D[k:n])),  k = largest power of two < n
// Assumes `data` is a validated array of hex32; callers validate first.
// ---------------------------------------------------------------------------------------------------

function _mth(data) {
  const n = data.length;
  if (n === 0) return EMPTY_ROOT;
  if (n === 1) return leafHash(data[0]);
  const k = _largestPowerOfTwoLessThan(n);
  return nodeHash(_mth(data.slice(0, k)), _mth(data.slice(k)));
}

/**
 * Compute the tree HEAD over an ORDERED list of leaf values.
 *
 * @param {string[]} leaves ordered 0x-bytes32 leaf values (e.g. journal entry hashes).
 * @returns {{ size: number, root: string|null }}
 *          `root` is the RFC-6962 MTH of the leaves (EMPTY_ROOT for []). On malformed input (not an
 *          array, or any non-hex32 leaf) `root` is null and `size` is the array length (or 0) — TOTAL,
 *          never throws.
 */
function treeHead(leaves) {
  if (!Array.isArray(leaves)) return { size: 0, root: null };
  if (!_allHex32(leaves)) return { size: leaves.length, root: null };
  return { size: leaves.length, root: _mth(leaves) };
}

// ---------------------------------------------------------------------------------------------------
// Inclusion proof — RFC 6962 §2.1.1 PATH(m, D[n]). Returns the audit path (sibling subtree roots) from
// leaf m up to the root, bottom-first.
// ---------------------------------------------------------------------------------------------------

function _path(m, data) {
  const n = data.length;
  if (n === 1) return []; // m must be 0 here; the lone leaf has no sibling.
  const k = _largestPowerOfTwoLessThan(n);
  if (m < k) {
    // Leaf is in the left subtree; sibling is the whole right subtree root.
    return _path(m, data.slice(0, k)).concat([_mth(data.slice(k))]);
  }
  // Leaf is in the right subtree; sibling is the whole left subtree root.
  return _path(m - k, data.slice(k)).concat([_mth(data.slice(0, k))]);
}

/**
 * Build an inclusion proof for the leaf at index `i` in the ordered `leaves`.
 *
 * @param {string[]} leaves ordered 0x-bytes32 leaf values.
 * @param {number} i leaf index, 0 <= i < leaves.length.
 * @returns {{ leaf: string, leafIndex: number, treeSize: number, path: string[] } | null}
 *          A self-describing proof, or `null` on malformed input (bad leaves, non-integer/out-of-range
 *          index). TOTAL — never throws.
 */
function inclusionProof(leaves, i) {
  if (!_allHex32(leaves)) return null;
  const n = leaves.length;
  if (!Number.isInteger(i) || i < 0 || i >= n) return null;
  return {
    leaf: leaves[i],
    leafIndex: i,
    treeSize: n,
    path: _path(i, leaves),
  };
}

// ---------------------------------------------------------------------------------------------------
// Inclusion verification — iterative CT reference algorithm. Reconstructs the root from the leaf hash,
// index and path, then compares. Independent of the recursive generator above.
// ---------------------------------------------------------------------------------------------------

// Fold the "inner" portion of the path: at level i, the sibling is on the right if bit i of `index` is
// 0 (seed is the left child), else on the left.
function _chainInner(seed, path, index) {
  let acc = seed;
  for (let i = 0; i < path.length; i++) {
    acc = _bitAt(index, i) === 0 ? nodeHash(acc, path[i]) : nodeHash(path[i], acc);
  }
  return acc;
}

// Like _chainInner but only folds the levels where bit i of `index` is 1 (used by consistency).
function _chainInnerRight(seed, path, index) {
  let acc = seed;
  for (let i = 0; i < path.length; i++) {
    if (_bitAt(index, i) === 1) acc = nodeHash(path[i], acc);
  }
  return acc;
}

// Fold the "border" portion: each remaining sibling is always on the left (a carried left subtree).
function _chainBorderRight(seed, path) {
  let acc = seed;
  for (const h of path) acc = nodeHash(h, acc);
  return acc;
}

// Reconstruct the root implied by (index, size, leafHash, path), or null if shapes are inconsistent.
function _rootFromInclusionPath(index, size, leafHashVal, path) {
  if (!Number.isInteger(index) || !Number.isInteger(size)) return null;
  if (size < 1 || index < 0 || index >= size) return null;
  if (!_isHex32(leafHashVal) || !_allHex32(path)) return null;
  const inner = _bitLength(_xor(index, size - 1));
  const border = _onesCount(_shr(index, inner));
  if (path.length !== inner + border) return null;
  let res = _chainInner(leafHashVal, path.slice(0, inner), index);
  res = _chainBorderRight(res, path.slice(inner));
  return res;
}

/**
 * Verify an inclusion proof against a tree head.
 *
 * Recomputes the leaf hash from `proof.leaf` (so the proof is bound to the actual leaf DATA, not a
 * caller-supplied leaf hash), reconstructs the root from (leafIndex, treeSize, path), and checks it
 * equals the head's root. Returns a plain boolean and NEVER throws.
 *
 * `head` may be either:
 *   - a bare 0x-bytes32 root string (e.g. `treeHead(leaves).root`), or
 *   - the full head object `{ size, root }` (e.g. `treeHead(leaves)` — the RECOMMENDED form).
 * In a real Signed Tree Head the size and root are trusted TOGETHER, so passing the full head also
 * BINDS the size: a proof whose self-asserted `treeSize` disagrees with the trusted `head.size` is
 * rejected even if its path happens to reconstruct the same root. (With a bare root the size is not
 * independently known, so only the root is checked — exactly the RFC 6962 §2.1.1 contract.)
 *
 * @param {{ leaf: string, leafIndex: number, treeSize: number, path: string[] }} proof
 * @param {string|{size:number,root:string}} head the trusted tree root, or the full `{size,root}` head.
 * @returns {boolean} true iff the proof is valid for `head`; false on any tampering or malformed input.
 */
function verifyInclusion(proof, head) {
  // Accept either a bare root string or a { size, root } head. Binding size (when present) is what
  // lets a "replayed against a different size" proof be rejected outright.
  let root = head;
  let expectedSize = null;
  if (head !== null && typeof head === "object" && !Array.isArray(head)) {
    root = head.root;
    if (Number.isInteger(head.size)) expectedSize = head.size;
  }
  if (proof === null || typeof proof !== "object" || Array.isArray(proof)) return false;
  if (!_isHex32(root)) return false;
  if (expectedSize !== null && proof.treeSize !== expectedSize) return false;
  if (!_isHex32(proof.leaf) || !_allHex32(proof.path)) return false;
  const recomputed = _rootFromInclusionPath(
    proof.leafIndex,
    proof.treeSize,
    leafHash(proof.leaf),
    proof.path
  );
  return recomputed !== null && recomputed === root;
}

// ---------------------------------------------------------------------------------------------------
// Consistency proof — RFC 6962 §2.1.2 PROOF(m, D[n]) = SUBPROOF(m, D[n], true). Proves that the tree of
// size n is an APPEND-ONLY extension of the tree of size m (0 < m <= n).
// ---------------------------------------------------------------------------------------------------

function _subproof(m, data, b) {
  const n = data.length;
  if (m === n) {
    // The old tree is exactly this subtree. If it is a complete subtree the verifier already knows
    // (b === true, first call side), omit its root; otherwise include it so the verifier can seed.
    return b ? [] : [_mth(data)];
  }
  const k = _largestPowerOfTwoLessThan(n);
  if (m <= k) {
    // Old tree lives entirely in the left subtree; carry the right subtree root.
    return _subproof(m, data.slice(0, k), b).concat([_mth(data.slice(k))]);
  }
  // Old tree spans the whole left subtree plus part of the right; the left subtree root is now a
  // "known" complete subtree, so recurse into the right with b = false.
  return _subproof(m - k, data.slice(k), false).concat([_mth(data.slice(0, k))]);
}

/**
 * Build a consistency proof between the size-`m` prefix and the size-`n` prefix of `leaves`.
 *
 * @param {string[]} leaves ordered 0x-bytes32 leaf values (length >= n).
 * @param {number} m first (older) tree size, 0 < m <= n.
 * @param {number} n second (newer) tree size, m <= n <= leaves.length.
 * @returns {{ firstSize: number, secondSize: number, path: string[] } | null}
 *          A self-describing proof, or `null` on malformed input. TOTAL — never throws.
 */
function consistencyProof(leaves, m, n) {
  if (!_allHex32(leaves)) return null;
  if (!Number.isInteger(m) || !Number.isInteger(n)) return null;
  if (m <= 0 || n < m || n > leaves.length) return null;
  const data = leaves.slice(0, n);
  // SUBPROOF is defined for 0 < m < n; when m === n the proof is empty (the roots are compared directly).
  const path = m === n ? [] : _subproof(m, data, true);
  return { firstSize: m, secondSize: n, path };
}

/**
 * Verify a consistency proof: that the tree with root `secondRoot` (size proof.secondSize) is an
 * append-only extension of the tree with root `firstRoot` (size proof.firstSize).
 *
 * Iterative CT reference algorithm: it folds the shared path twice — once biased to reproduce the OLD
 * root and once the NEW root — and both must match. Returns a plain boolean and NEVER throws. A proof
 * that rewrote/reordered any of the first `firstSize` leaves cannot make BOTH folds match, so it is
 * rejected: append-only-ness is verifiable WITHOUT the full log.
 *
 * `firstRoot` / `secondRoot` may each be a bare 0x-bytes32 root string OR the full head object
 * `{ size, root }` (the RECOMMENDED form). Passing the full heads also BINDS the sizes: a proof whose
 * self-asserted `firstSize`/`secondSize` disagrees with a supplied head size is rejected outright.
 *
 * @param {{ firstSize: number, secondSize: number, path: string[] }} proof
 * @param {string|{size:number,root:string}} firstRoot  root (or head) of the older tree.
 * @param {string|{size:number,root:string}} secondRoot root (or head) of the newer tree.
 * @returns {boolean}
 */
function verifyConsistency(proof, firstRoot, secondRoot) {
  if (proof === null || typeof proof !== "object" || Array.isArray(proof)) return false;
  const m = proof.firstSize;
  const n = proof.secondSize;
  const path = proof.path;
  if (!Number.isInteger(m) || !Number.isInteger(n)) return false;
  // Accept either bare root strings or { size, root } heads; bind sizes when heads are supplied.
  const _head = (h, size) => {
    if (h !== null && typeof h === "object" && !Array.isArray(h)) {
      if (Number.isInteger(h.size) && h.size !== size) return null; // size mismatch => reject
      return h.root;
    }
    return h;
  };
  firstRoot = _head(firstRoot, m);
  secondRoot = _head(secondRoot, n);
  if (!_isHex32(firstRoot) || !_isHex32(secondRoot)) return false;
  if (!_allHex32(path)) return false;

  if (n < m) return false;
  if (m === n) {
    // Same size ⇒ same tree ⇒ empty proof and identical roots.
    return path.length === 0 && firstRoot === secondRoot;
  }
  if (m === 0) {
    // The empty tree is trivially consistent with any tree; the proof carries nothing.
    return path.length === 0;
  }
  // 0 < m < n
  if (path.length === 0) return false;

  // Decompose as if proving inclusion of leaf (m-1) in a tree of size n, then strip the trailing zeros
  // of m (the old tree's right border is a run of complete subtrees the verifier folds itself).
  let inner = _bitLength(_xor(m - 1, n - 1));
  const border = _onesCount(_shr(m - 1, inner));
  const shift = _trailingZeros(m);
  inner -= shift;

  // When m is an exact power of two the old root IS a complete subtree, so it seeds both folds and is
  // NOT transmitted; otherwise the first path element is the shared seed.
  let seed;
  let start;
  if (m === Math.pow(2, shift)) {
    seed = firstRoot;
    start = 0;
  } else {
    seed = path[0];
    start = 1;
  }
  if (path.length !== start + inner + border) return false;
  const p = path.slice(start);
  const mask = _shr(m - 1, shift);

  // Fold biased to the OLD tree: only the right-hand carries participate in the inner run.
  let hash1 = _chainInnerRight(seed, p.slice(0, inner), mask);
  hash1 = _chainBorderRight(hash1, p.slice(inner));
  if (hash1 !== firstRoot) return false;

  // Fold biased to the NEW tree: the full inner run participates.
  let hash2 = _chainInner(seed, p.slice(0, inner), mask);
  hash2 = _chainBorderRight(hash2, p.slice(inner));
  if (hash2 !== secondRoot) return false;

  return true;
}

module.exports = {
  // The 5 required exports.
  treeHead,
  inclusionProof,
  verifyInclusion,
  consistencyProof,
  verifyConsistency,
  // Building blocks / documented constants (useful to callers and tests).
  leafHash,
  nodeHash,
  EMPTY_ROOT,
  EMPTY_ROOT_DOMAIN,
  LEAF_PREFIX,
  NODE_PREFIX,
};

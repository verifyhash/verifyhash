"use strict";

// verifier/lib/merkle.js — INDEPENDENT re-derivation of the family's path-bound, domain-separated
// Merkle convention, using ONLY ./keccak (js-sha3). NO ethers, NO hardhat, NO require back into cli/.
//
// WHY THIS EXISTS
//   To verify an evidence seal / reconciliation seal / proof bundle OFFLINE without the producer stack,
//   the independent verifier must RE-DERIVE the same per-file leaves and the same Merkle root the
//   producer (cli/hash.js) computes. cli/hash.js uses `ethers` (keccak256/concat/toUtf8Bytes), which the
//   verifier explicitly refuses to depend on. So this file reproduces the EXACT byte composition of
//   pathLeaf / leafHash / nodeHash / buildTree from first principles — and test/verifier.cli.test.js
//   cross-checks the result is byte-identical to the producer's. The two can never silently diverge.
//
// THE CONVENTION (must match cli/hash.js VERBATIM)
//   * content digest      c          = keccak256(file bytes)
//   * DIR_LEAF_DOMAIN      = keccak256("verifyhash/dir-leaf/v1")  (a fixed 32-byte prefix)
//   * path-bound leaf      pathLeaf   = keccak256(DIR_LEAF_DOMAIN ++ utf8(relPath) ++ 0x00 ++ c)
//   * tagged leaf          leafHash   = keccak256(0x00 ++ leaf)
//   * interior node        nodeHash   = keccak256(0x01 ++ min(a,b) ++ max(a,b))   (sorted 32-byte pair)
//   * tree                 sorted-leaf, "duplicate the lone odd node" pairing (OpenZeppelin style)
//   relPath is normalized with no leading "./", exactly as the producer's toPosixRel does. CRUCIALLY
//   this must be BYTE-FOR-BYTE the producer's normalization (cli/hash.js#toPosixRel) — see toPosixRel
//   below — or the verifier would re-derive a DIFFERENT root than the producer sealed for some input
//   class and would either falsely reject a genuine artifact or falsely accept the wrong one.

const { keccak256 } = require("./keccak");

// Domain tags, byte-identical to ContributionRegistry / cli/hash.js LEAF_TAG / NODE_TAG.
const LEAF_TAG = Buffer.from([0x00]);
const NODE_TAG = Buffer.from([0x01]);
const PATH_SEP = Buffer.from([0x00]);

// The fixed, versioned domain prefix for path-bound directory leaves: keccak256 of the ASCII tag.
const DIR_LEAF_DOMAIN_STR = "verifyhash/dir-leaf/v1";
const DIR_LEAF_DOMAIN = keccak256(Buffer.from(DIR_LEAF_DOMAIN_STR, "utf8")); // 32-byte Buffer

const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;

// 0x-hex string (no 0x, lowercase) <-> 32-byte Buffer.
function hexToBuf32(hex) {
  if (typeof hex !== "string" || !HEX32_RE.test(hex)) {
    throw new Error(`expected a 0x-prefixed 32-byte hex string, got: ${String(hex)}`);
  }
  return Buffer.from(hex.slice(2), "hex");
}
function bufToHex(buf) {
  return "0x" + Buffer.from(buf).toString("hex");
}

/** keccak256 of raw bytes, returned as a 0x-prefixed 32-byte hex string (matches cli/hash.js hashBytes). */
function hashBytes(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return bufToHex(keccak256(buf));
}

/**
 * Normalize a relPath EXACTLY as the producer (cli/hash.js#toPosixRel) does, so the verifier
 * re-derives the IDENTICAL root the producer sealed. The producer is `split(path.sep).join("/")`
 * then `.replace(/^\.\//, "")`. The artifacts the verifier reads carry relPaths the producer wrote,
 * and those are produced on POSIX hosts (cli/evidence.js#loadDirEntries does the same `path.sep`
 * split) — where `path.sep === "/"`, so the split/join is a no-op and a literal backslash byte is a
 * CONTENT byte that survives into the hash. We therefore must NOT collapse backslashes: a previous
 * version unconditionally mapped "\\"->"/", which made the verifier hash `a/b.txt` while the producer
 * hashed `a\b.txt` — a silent root divergence that could falsely REJECT a genuine backslash-named
 * directory or falsely ACCEPT one where `a/b.txt` and `a\b.txt` collide. All we strip is the leading
 * "./", which the producer also strips on every host. (Windows-authored relPaths, if ever needed,
 * must be converted to "/" on BOTH the producer and verifier sides identically — not only here.)
 */
function toPosixRel(relPath) {
  return String(relPath).replace(/^\.\//, "");
}

/**
 * pathLeaf(relPath, contentDigest) = keccak256(DIR_LEAF_DOMAIN ++ utf8(relPath) ++ 0x00 ++ c).
 * @param {string} relPath
 * @param {string} contentDigest 0x bytes32
 * @returns {string} 0x bytes32
 */
function pathLeaf(relPath, contentDigest) {
  const relBytes = Buffer.from(toPosixRel(relPath), "utf8");
  const c = hexToBuf32(contentDigest);
  return bufToHex(keccak256(Buffer.concat([DIR_LEAF_DOMAIN, relBytes, PATH_SEP, c])));
}

/** leafHash(c) = keccak256(LEAF_TAG ++ c). */
function leafHash(c) {
  return bufToHex(keccak256(Buffer.concat([LEAF_TAG, hexToBuf32(c)])));
}

/** nodeHash(a,b) = keccak256(NODE_TAG ++ min(a,b) ++ max(a,b)) comparing as 32-byte big-endian values. */
function nodeHash(a, b) {
  const A = hexToBuf32(a);
  const B = hexToBuf32(b);
  const [lo, hi] = Buffer.compare(A, B) <= 0 ? [A, B] : [B, A];
  return bufToHex(keccak256(Buffer.concat([NODE_TAG, lo, hi])));
}

/**
 * Build the sorted-leaf, domain-separated Merkle root from an array of per-file PATH-BOUND leaves
 * (the same values pathLeaf produces). Leaves are sorted ascending by their 32-byte value, tagged via
 * leafHash, then folded with nodeHash, pairing a lone odd node with itself — byte-identical to
 * cli/hash.js buildTree's root.
 * @param {string[]} leaves array of 0x bytes32 path-bound leaves
 * @returns {string} the 0x bytes32 root
 */
function rootFromLeaves(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) {
    throw new Error("cannot build a Merkle tree from zero leaves");
  }
  const sorted = leaves
    .slice()
    .sort((a, b) => Buffer.compare(hexToBuf32(a), hexToBuf32(b)));
  let layer = sorted.map((c) => leafHash(c));
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];
      next.push(nodeHash(layer[i], right));
    }
    layer = next;
  }
  return layer[0];
}

/**
 * Re-derive the top-level root from a flat list of { relPath, contentHash } — the SAME computation the
 * seal cores use: pathLeaf each, then rootFromLeaves. PURE.
 * @param {{relPath:string, contentHash:string}[]} flat
 * @returns {string} 0x bytes32 root
 */
function rootFromFlat(flat) {
  return rootFromLeaves(flat.map((e) => pathLeaf(e.relPath, e.contentHash)));
}

module.exports = {
  HEX32_RE,
  DIR_LEAF_DOMAIN_STR,
  hashBytes,
  toPosixRel,
  pathLeaf,
  leafHash,
  nodeHash,
  rootFromLeaves,
  rootFromFlat,
};

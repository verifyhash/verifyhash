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
//     leaf (second-preimage resistance), AND every leaf is *path-bound* so the root commits
//     to file NAMES as well as their content:
//       - each file's content digest is c = keccak256(file bytes)
//       - the per-file leaf VALUE is the path-bound digest
//             pathLeaf = keccak256(DIR_LEAF_DOMAIN ++ relPath ++ 0x00 ++ c)
//         (DIR_LEAF_DOMAIN is `domainPrefix`; the 0x00 byte separates the variable-length
//         relPath from the fixed-length content digest so no (relPath, c) pair can be
//         re-segmented into a different (relPath', c') pair — an unambiguous encoding).
//       - that pathLeaf is then domain-tagged for the tree:
//             leafHash(pathLeaf) = keccak256(LEAF_TAG ++ pathLeaf)
//       - an interior node is nodeHash(a,b) = keccak256(NODE_TAG ++ min(a,b) ++ max(a,b))
//     The on-chain verifyLeaf applies LEAF_TAG to whatever 32-byte value it is handed and
//     folds with NODE_TAG. The CLI hands it the pathLeaf (NOT the bare content digest), so
//     a root produced here is exactly the root the contract reconstructs from a pathLeaf +
//     proof. The two conventions are byte-identical; the contract needs no change.
//
//     WHAT THE ROOT COMMITS TO. Because the path is hashed into every leaf, the directory
//     root commits to the full set of (relPath, content) pairs — both the names and the
//     bytes. Renaming a file (same bytes, new path) changes that file's pathLeaf and hence
//     the root; moving a file between directories changes its relPath and hence the root;
//     editing a byte changes c and hence the root. Two trees share a root iff they contain
//     the identical set of files at the identical relative paths with identical content.
//
//     "Stable" means the root does not depend on filesystem enumeration order: leaves are
//     sorted before the tree is built, so the same set of files always yields the same root.
//     Relative paths are normalized to forward slashes so the root is identical regardless
//     of the host OS path separator.

const fs = require("fs");
const path = require("path");
const { keccak256, concat, toUtf8Bytes } = require("ethers");

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

// Domain prefix for path-bound directory leaves (the `domainPrefix` in the leaf formula). A fixed,
// versioned ASCII tag so a directory pathLeaf lives in its own value space: it can never collide
// with a bare content digest, an on-chain anchor of a single file, or a leaf from a future scheme.
// Bump the version suffix if the leaf encoding ever changes, to keep old and new roots disjoint.
const DIR_LEAF_DOMAIN_STR = "verifyhash/dir-leaf/v1";
const DIR_LEAF_DOMAIN = keccak256(toUtf8Bytes(DIR_LEAF_DOMAIN_STR)); // 32-byte fixed-length prefix

// Separator byte between the variable-length relPath and the fixed-length content digest.
const PATH_SEP = "0x00";

/**
 * Normalize a relative path to a canonical, OS-independent form: forward-slash separators with no
 * leading "./". This makes the leaf (and thus the root) identical regardless of the host platform's
 * path separator, so a repo hashed on Windows and on Linux yields the same root.
 * @param {string} relPath
 * @returns {string}
 */
function toPosixRel(relPath) {
  return relPath.split(path.sep).join("/").replace(/^\.\//, "");
}

/**
 * Path-bound directory leaf, the `dir leaf` of T-0.2:
 *   pathLeaf(relPath, c) = keccak256(DIR_LEAF_DOMAIN ++ relPath ++ 0x00 ++ c)
 * where c = keccak256(file bytes). Binding relPath into the leaf is what makes the directory root
 * commit to file NAMES as well as content: rename a file (new relPath, same bytes) and its pathLeaf
 * — and therefore the root — changes. The 0x00 separator + fixed-length 32-byte c give an
 * unambiguous encoding: there is exactly one (relPath, c) split for any leaf preimage, so two
 * distinct (relPath, content) pairs can never alias to the same leaf via boundary ambiguity.
 *
 * NOTE: this pathLeaf is the *content-digest-layer* value the on-chain verifyLeaf is handed — the
 * verifier re-tags it with LEAF_TAG (keccak256(LEAF_TAG ++ pathLeaf)) to form the actual tree leaf,
 * so the second-preimage protection of T-0.1 still applies on top of the path binding.
 *
 * @param {string} relPath file path relative to the repo root (normalized to forward slashes here)
 * @param {string} contentDigest 0x bytes32, = keccak256(file bytes)
 * @returns {string} 0x bytes32 path-bound leaf value
 */
function pathLeaf(relPath, contentDigest) {
  const relBytes = toUtf8Bytes(toPosixRel(relPath));
  return keccak256(concat([DIR_LEAF_DOMAIN, relBytes, PATH_SEP, contentDigest]));
}

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
 * Hash a directory into a stable sorted-leaf Merkle root that commits to file NAMES and content.
 *
 * Each file contributes one PATH-BOUND leaf:
 *   leaf = pathLeaf(relPath, c) = keccak256(DIR_LEAF_DOMAIN ++ relPath ++ 0x00 ++ c)
 * where c = keccak256(file bytes) is the file's content digest (= hashFile). Because relPath is
 * hashed in, two files with identical bytes but different paths get DIFFERENT leaves, and renaming
 * a file changes its leaf — so the root commits to the full set of (relPath, content) pairs.
 *
 * The returned per-file `leaf` is exactly the value the on-chain verifyLeaf expects as its
 * `contentHash` argument (it tags it with LEAF_TAG itself); `contentHash` is also returned for
 * transparency (the bare keccak256 of the file's bytes).
 *
 * @param {string} dirPath
 * @returns {{
 *   root: string,
 *   leaves: { path: string, leaf: string, contentHash: string }[],   // per-file, sorted by leaf
 *   proofFor: (relOrAbsPathOrLeaf: string) => string[],
 *   leafFor: (relOrAbsPath: string) => string,                       // path-bound leaf for a file
 * }}
 */
function hashDir(dirPath) {
  const files = listFiles(dirPath);
  if (files.length === 0) {
    throw new Error(`no files found under directory: ${dirPath}`);
  }
  // Map each absolute file path to its repo-relative POSIX path + bytes, then hand the entries to the
  // shared tree builder so the filesystem walk and the git-scoped walk produce byte-identical roots.
  const entries = files.map((f) => ({
    path: toPosixRel(path.relative(dirPath, f)),
    abs: f,
    content: fs.readFileSync(f),
  }));
  return hashEntries(entries);
}

/**
 * Build the directory-root result from an explicit list of file entries. This is the shared core
 * behind both `hashDir` (filesystem walk) and the git-scoped walk in cli/git.js, so they compute the
 * IDENTICAL Merkle root via the same pathLeaf/buildTree/leafHash/nodeHash convention the contract's
 * verifyLeaf accepts. Each entry is `{ path: repoRelPosixPath, content: Buffer, abs?: absPath }`;
 * `abs` is optional and only used to let `proofFor`/`leafFor` accept an absolute path.
 *
 * @param {{ path: string, content: Buffer|Uint8Array, abs?: string }[]} entries
 * @returns {{
 *   root: string,
 *   leaves: { path: string, leaf: string, contentHash: string }[],
 *   proofFor: (relOrAbsPathOrLeaf: string) => string[],
 *   leafFor: (relOrAbsPath: string) => string,
 * }}
 */
function hashEntries(entries) {
  if (!entries || entries.length === 0) {
    throw new Error("cannot build a directory root from zero files");
  }
  // Compute (path, contentHash, leaf) triples. The tree leaf is the PATH-BOUND digest so the root
  // commits to names+content; the bare contentHash is kept for display. Sort by leaf so the root is
  // order-independent. `path` is already a normalized POSIX relPath; pathLeaf re-normalizes anyway.
  const pairs = entries.map((e) => {
    const rel = toPosixRel(e.path);
    const contentHash = hashBytes(e.content);
    return {
      path: rel,
      abs: e.abs,
      contentHash,
      leaf: pathLeaf(rel, contentHash),
    };
  });

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

  // Resolve a target (relative/absolute path, or a path-bound leaf hash) to its index in the sorted
  // leaf layer. Path matching uses the normalized (forward-slash) relPath; an absolute target is
  // matched against each entry's recorded absolute path (entries carry their own `abs`, so there is
  // no single base directory to resolve against).
  function indexFor(target) {
    if (/^0x[0-9a-fA-F]{64}$/.test(target)) {
      return sortedLeaves.findIndex((l) => BigInt(l) === BigInt(target));
    }
    if (path.isAbsolute(target)) {
      return sortedPairs.findIndex((p) => p.abs === target);
    }
    const normTarget = toPosixRel(target);
    return sortedPairs.findIndex((p) => p.path === normTarget);
  }

  function proofFor(target) {
    const index = indexFor(target);
    if (index < 0) throw new Error(`target not found in directory tree: ${target}`);
    return proofForIndex(layers, index);
  }

  function leafFor(target) {
    const index = indexFor(target);
    if (index < 0) throw new Error(`target not found in directory tree: ${target}`);
    return sortedPairs[index].leaf;
  }

  return {
    root,
    leaves: sortedPairs.map((p) => ({
      path: p.path,
      leaf: p.leaf,
      contentHash: p.contentHash,
    })),
    proofFor,
    leafFor,
  };
}

/**
 * Hash a directory into a stable Merkle root over EXACTLY the files git tracks at `ref` (default
 * HEAD), reading their bytes from the WORKING TREE. This is the engine behind `vh hash <path> --git`.
 *
 * The tracked set is enumerated from the commit's tree (`git ls-tree`, via cli/git.js), so untracked
 * junk in the work tree (`node_modules/`, `.env`, unstaged scratch files) is IGNORED — the root
 * depends only on which files git tracks. Each tracked file's bytes are read from the work tree and
 * fed through the IDENTICAL pathLeaf/buildTree/leafHash/nodeHash convention as `hashDir`, with the
 * git path bound into each leaf, so the resulting root is byte-identical to (and verifiable by) the
 * contract's verifyLeaf — no new leaf scheme, no contract change.
 *
 * Errors explicitly (never silently falls back to a filesystem walk):
 *   - `dirPath` not in a git work tree -> error (via repoRoot),
 *   - unknown `ref` -> error (via resolveCommit),
 *   - zero tracked files -> actionable error (cannot build a tree from zero leaves).
 * A tracked file that is missing from the work tree (e.g. `git rm` without commit) is reported as a
 * clear error rather than silently skipped, so the root always reflects the full tracked set.
 *
 * @param {string} dirPath a directory inside the repo
 * @param {{ ref?: string }} [opts] `ref` to enumerate (default HEAD)
 * @returns {{
 *   root: string,
 *   commit: string,
 *   scope: string,
 *   leaves: { path: string, leaf: string, contentHash: string }[],
 *   proofFor: (relOrAbsPathOrLeaf: string) => string[],
 *   leafFor: (relOrAbsPath: string) => string,
 * }}
 */
function hashGit(dirPath, opts = {}) {
  // Lazy-require so cli/hash.js stays usable (and unit-testable) without git on the host unless the
  // --git path is actually taken.
  const git = require("./git");
  const root = git.repoRoot(dirPath); // errors clearly if dirPath is not in a git work tree
  const commit = git.resolveCommit(dirPath, opts.ref); // errors clearly on an unknown ref
  // Repo-relative scope (the operator's vantage point) recorded as an untrusted provenance hint.
  const scope = git.repoRelativeScope(root, dirPath);
  const tracked = git.listTrackedFiles(dirPath, opts.ref); // sorted repo-relative POSIX paths
  if (tracked.length === 0) {
    throw new Error(
      `git tracks zero files at ${opts.ref || "HEAD"} (${commit.slice(0, 12)}); ` +
        `nothing to hash. Commit at least one file, or hash without --git.`
    );
  }
  const entries = tracked.map((rel) => {
    const abs = path.join(root, rel);
    let content;
    try {
      content = fs.readFileSync(abs);
    } catch (e) {
      throw new Error(
        `tracked file is missing from the work tree: ${rel}\n` +
          `  (git lists it at ${commit.slice(0, 12)} but it could not be read: ${e.message})`
      );
    }
    return { path: rel, abs, content };
  });
  const result = hashEntries(entries);
  return { ...result, commit, scope };
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
  hashEntries,
  hashGit,
  hashPath,
  leafHash,
  nodeHash,
  pathLeaf,
  toPosixRel,
  buildTree,
  proofForIndex,
  listFiles,
  DIR_LEAF_DOMAIN,
  DIR_LEAF_DOMAIN_STR,
};

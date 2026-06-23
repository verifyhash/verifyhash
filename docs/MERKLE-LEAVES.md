# What the verifyhash directory root commits to

This is the canonical spec for how `vh hash <dir>` / `hashDir()` (cli/hash.js) build a directory's
Merkle root and exactly what that root proves. It is the reference for T-0.1 (domain separation)
and T-0.2 (path binding).

## TL;DR

The directory root commits to the **full set of `(relative-path, content)` pairs** in the tree —
both the file **names/locations** and the file **bytes**. Two directories produce the same root
**iff** they contain the identical set of files, at the identical relative paths, with identical
content. Therefore:

- editing a single byte of any file changes the root (content binding),
- **renaming** a file (same bytes, new name) changes the root (path binding),
- **moving** a file to another directory (same bytes, new relPath) changes the root,
- adding or removing a file changes the root,
- the root does **not** depend on filesystem enumeration order or on the host OS path separator.

## Leaf construction (two layers)

Each file `F` at relative path `relPath` with bytes `B` produces a tree leaf in two stages.

1. **Content digest** — the bare keccak256 of the file's bytes (this is also what `vh hash <file>`
   prints and what `anchor()` stores for a single file):

   ```
   c = keccak256(B)
   ```

2. **Path-bound leaf** (T-0.2) — bind the relative path into the leaf so the root commits to names:

   ```
   pathLeaf = keccak256( DIR_LEAF_DOMAIN ‖ relPath ‖ 0x00 ‖ c )
   ```

   - `DIR_LEAF_DOMAIN = keccak256("verifyhash/dir-leaf/v1")` is a fixed 32-byte `domainPrefix`. It
     isolates a directory leaf in its own value space so it can never collide with a bare content
     digest, a single-file anchor, or a leaf from a future scheme. Bump the `v1` suffix if the
     encoding ever changes, to keep old and new roots disjoint.
   - `relPath` is normalized to forward slashes (POSIX), so a repo hashed on Windows and on Linux
     yields the same root.
   - The single `0x00` separator sits between the variable-length `relPath` and the fixed-length
     32-byte `c`. Because `c` is always exactly 32 bytes, there is exactly one way to split any
     `pathLeaf` preimage back into `(relPath, c)` — two different `(relPath, content)` pairs can
     never alias to the same leaf via boundary ambiguity.

`pathLeaf` is the value the on-chain `verifyLeaf(root, contentHash, proof)` is handed as its
`contentHash` argument (NOT the bare digest `c`).

3. **Domain-tagged tree leaf** (T-0.1) — `verifyLeaf` then re-tags `pathLeaf` with the leaf domain
   tag to form the actual bottom-of-tree value, keeping leaves and interior nodes in disjoint value
   spaces (second-preimage resistance):

   ```
   treeLeaf  = keccak256( LEAF_TAG ‖ pathLeaf )            // LEAF_TAG = 0x00
   nodeHash(a,b) = keccak256( NODE_TAG ‖ min(a,b) ‖ max(a,b) )   // NODE_TAG = 0x01, sorted pair
   ```

The CLI and the contract use byte-identical conventions, so a root produced by `vh hash <dir>` is
exactly the root `verifyLeaf` reconstructs from a `pathLeaf` + Merkle proof. The contract did not
change for T-0.2: path binding lives entirely in the value the CLI feeds to `verifyLeaf`.

## Tree shape

Leaves are **sorted by their `pathLeaf` value** before the tree is built, so the root is
independent of enumeration/creation order. Odd (lone) nodes are paired with themselves
(`nodeHash(node, node)`) rather than promoted, giving every leaf a full-depth proof.

## What the root does NOT commit to

- File mode/permissions, mtimes, or other filesystem metadata (only path + bytes).
- Empty directories (only files become leaves).
- Symlinks / sockets / fifos are skipped (they have no stable content hash).

## Consequences for `vh prove`

`vh prove <file> --root <dir>` builds the file's `pathLeaf` and Merkle proof. The proof binds the
file to **its location** in the repo: the same bytes at a different path produce a different leaf and
do not verify. A renamed or moved file's old proof no longer folds to the new root.

## Tests

See `test/cli.hash.test.js`:
- "RENAMING a file changes the root …" and "MOVING a file …" prove path binding,
- "a renamed file's OLD proof no longer verifies on-chain against the new root" proves it end to end
  against the deployed `ContributionRegistry.verifyLeaf`,
- "pathLeaf matches the explicit keccak256(domain ‖ relPath ‖ 0x00 ‖ content) formula" pins the
  encoding.

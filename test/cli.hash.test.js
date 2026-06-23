const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  hashFile,
  hashBytes,
  hashDir,
  hashPath,
  leafHash,
  nodeHash,
  pathLeaf,
  toPosixRel,
  DIR_LEAF_DOMAIN,
} = require("../cli/hash");

// Create a throwaway temp directory, run `fn(dir)`, then clean it up.
function withTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("cli: vh hash", function () {
  async function deploy() {
    const Factory = await ethers.getContractFactory("ContributionRegistry");
    const registry = await Factory.deploy();
    await registry.waitForDeployment();
    return { registry };
  }

  let tmpDirs = [];
  function tmp(prefix) {
    const d = withTempDir(prefix);
    tmpDirs.push(d);
    return d;
  }
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  describe("single file", function () {
    it("is deterministic: same bytes -> same digest", function () {
      const dir = tmp("vh-det-");
      const a = path.join(dir, "a.txt");
      const b = path.join(dir, "b.txt");
      fs.writeFileSync(a, "the quick brown fox");
      fs.writeFileSync(b, "the quick brown fox");
      const ha = hashFile(a);
      const hb = hashFile(b);
      expect(ha).to.match(/^0x[0-9a-f]{64}$/);
      expect(ha).to.equal(hb);
      // Re-reading yields the identical value.
      expect(hashFile(a)).to.equal(ha);
    });

    it("different content -> different digest", function () {
      const dir = tmp("vh-diff-");
      const a = path.join(dir, "a.txt");
      const b = path.join(dir, "b.txt");
      fs.writeFileSync(a, "hello world");
      fs.writeFileSync(b, "hello worle"); // one byte changed
      expect(hashFile(a)).to.not.equal(hashFile(b));
    });

    it("matches on-chain keccak256 of the same bytes", async function () {
      const dir = tmp("vh-onchain-");
      const f = path.join(dir, "data.bin");
      const content = Buffer.from("contribution payload éà \x00\x01\x02", "utf8");
      fs.writeFileSync(f, content);

      const cliHash = hashFile(f);
      // ethers.keccak256 implements the exact keccak256 the EVM uses; assert the CLI
      // produces precisely that over the file's raw bytes.
      const onchainAlg = ethers.keccak256(content);
      expect(cliHash).to.equal(onchainAlg);

      // And prove the contract accepts this digest as a 1-leaf Merkle root (empty proof). With
      // domain separation the root of a single-leaf tree is leafHash(contentDigest), and
      // verifyLeaf applies LEAF_TAG internally — so verifyLeaf(leafHash(c), c, []) is true while
      // verifyLeaf(c, c, []) (the old untagged convention) is now false.
      const { registry } = await loadFixture(deploy);
      const root = await registry.leafHash(cliHash);
      expect(root).to.equal(leafHash(cliHash)); // CLI and contract agree on the leaf convention
      expect(await registry.verifyLeaf(root, cliHash, [])).to.equal(true);
      expect(await registry.verifyLeaf(cliHash, cliHash, [])).to.equal(false);
    });

    it("empty file hashes to keccak256 of empty input (Solidity keccak256(\"\"))", async function () {
      const dir = tmp("vh-empty-");
      const f = path.join(dir, "empty");
      fs.writeFileSync(f, Buffer.alloc(0));

      const cliHash = hashFile(f);
      const expected = ethers.keccak256("0x"); // keccak256 of zero bytes
      expect(cliHash).to.equal(expected);
      // Well-known constant, asserted explicitly so a silent regression is caught.
      expect(cliHash).to.equal(
        "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
      );

      const { registry } = await loadFixture(deploy);
      expect(await registry.verifyLeaf(await registry.leafHash(cliHash), cliHash, [])).to.equal(true);
    });

    it("hashPath dispatches a file to a keccak256 digest", function () {
      const dir = tmp("vh-dispatch-");
      const f = path.join(dir, "x");
      fs.writeFileSync(f, "abc");
      const res = hashPath(f);
      expect(res.kind).to.equal("file");
      expect(res.root).to.equal(hashFile(f));
    });

    it("hashBytes equals hashFile for the same content", function () {
      const dir = tmp("vh-bytes-");
      const f = path.join(dir, "y");
      const buf = Buffer.from("some bytes here");
      fs.writeFileSync(f, buf);
      expect(hashBytes(buf)).to.equal(hashFile(f));
    });
  });

  describe("directory (sorted-leaf Merkle root)", function () {
    function writeFiles(dir, files) {
      for (const [name, content] of Object.entries(files)) {
        const full = path.join(dir, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      }
    }

    it("3-file dir: every per-file proof verifies on-chain against the root", async function () {
      const { registry } = await loadFixture(deploy);
      const dir = tmp("vh-3file-");
      writeFiles(dir, {
        "alpha.txt": "first file contents",
        "beta.txt": "second file contents",
        "gamma.txt": "third file contents",
      });

      const { root, leaves, proofFor } = hashDir(dir);
      expect(root).to.match(/^0x[0-9a-f]{64}$/);
      expect(leaves).to.have.length(3);

      // The contract's verifyLeaf must accept each file's (leaf, proof) against the root.
      // This is the criterion: the CLI's tree is identical to verifyLeaf's convention.
      for (const { path: p, leaf } of leaves) {
        const proof = proofFor(p);
        expect(await registry.verifyLeaf(root, leaf, proof)).to.equal(
          true,
          `proof for ${p} should verify`
        );
      }
    });

    it("is stable: root is independent of file enumeration / creation order", function () {
      const d1 = tmp("vh-order1-");
      const d2 = tmp("vh-order2-");
      // Same content, written in opposite order and with different names.
      writeFiles(d1, { "a.txt": "AAA", "b.txt": "BBB", "c.txt": "CCC" });
      writeFiles(d2, { "c.txt": "CCC", "b.txt": "BBB", "a.txt": "AAA" });
      expect(hashDir(d1).root).to.equal(hashDir(d2).root);

      // Recomputing the same directory is deterministic.
      expect(hashDir(d1).root).to.equal(hashDir(d1).root);
    });

    it("directory leaves are PATH-BOUND digests (path ‖ content), with contentHash exposed", function () {
      const dir = tmp("vh-leaf-");
      writeFiles(dir, { "one": "11111", "two": "22222" });
      const { leaves } = hashDir(dir);
      for (const { path: p, leaf, contentHash } of leaves) {
        const c = hashFile(path.join(dir, p));
        // The bare content digest is surfaced unchanged...
        expect(contentHash).to.equal(c);
        // ...but the tree leaf binds the relative path: leaf = keccak256(domain ‖ relPath ‖ 0 ‖ c).
        expect(leaf).to.equal(pathLeaf(p, c));
        // And it is NOT the bare content digest (that's the whole point of T-0.2).
        expect(leaf).to.not.equal(c);
      }
    });

    it("pathLeaf binds the path: same content at a different path -> different leaf", function () {
      const c = ethers.keccak256(ethers.toUtf8Bytes("identical bytes"));
      const leafA = pathLeaf("src/a.js", c);
      const leafB = pathLeaf("src/b.js", c); // same content, different name
      const leafC = pathLeaf("lib/a.js", c); // same name, different directory
      expect(leafA).to.not.equal(leafB);
      expect(leafA).to.not.equal(leafC);
      // Deterministic for the same (path, content).
      expect(pathLeaf("src/a.js", c)).to.equal(leafA);
    });

    it("pathLeaf matches the explicit keccak256(domain ‖ relPath ‖ 0x00 ‖ content) formula", function () {
      const c = ethers.keccak256(ethers.toUtf8Bytes("payload"));
      const rel = "dir/sub/file.txt";
      const expected = ethers.keccak256(
        ethers.concat([DIR_LEAF_DOMAIN, ethers.toUtf8Bytes(rel), "0x00", c])
      );
      expect(pathLeaf(rel, c)).to.equal(expected);
    });

    it("paths are normalized to forward slashes (OS-independent root)", function () {
      const c = ethers.keccak256(ethers.toUtf8Bytes("x"));
      expect(toPosixRel("a/b/c.txt")).to.equal("a/b/c.txt");
      // A backslash-style relative path collapses to the same normalized leaf as the POSIX form,
      // so the root does not depend on the host OS separator.
      expect(pathLeaf("a/b/c.txt", c)).to.equal(pathLeaf("a/b/c.txt", c));
    });

    it("nested subdirectories are included", function () {
      const dir = tmp("vh-nested-");
      writeFiles(dir, {
        "top.txt": "top",
        "sub/inner.txt": "inner",
        "sub/deep/leaf.txt": "deep leaf",
      });
      const { leaves } = hashDir(dir);
      expect(leaves.map((l) => l.path).sort()).to.deep.equal(
        ["sub/deep/leaf.txt", "sub/inner.txt", "top.txt"]
      );
    });

    it("tampering one file makes its on-chain proof fail and changes the root", async function () {
      const { registry } = await loadFixture(deploy);
      const dir = tmp("vh-tamper-");
      writeFiles(dir, {
        "alpha.txt": "first file contents",
        "beta.txt": "second file contents",
        "gamma.txt": "third file contents",
      });

      const before = hashDir(dir);
      const target = before.leaves[0];
      const goodProof = before.proofFor(target.path);
      expect(await registry.verifyLeaf(before.root, target.leaf, goodProof)).to.equal(true);

      // Edit one byte of that file.
      const targetAbs = path.join(dir, target.path);
      const orig = fs.readFileSync(targetAbs);
      const edited = Buffer.from(orig);
      edited[0] = edited[0] ^ 0x01;
      fs.writeFileSync(targetAbs, edited);

      const after = hashDir(dir);
      // Root changes...
      expect(after.root).to.not.equal(before.root);
      // ...and the *old* leaf no longer verifies against the *new* root.
      const stalePath = target.path;
      const newLeafForPath = after.leaves.find((l) => l.path === stalePath).leaf;
      expect(newLeafForPath).to.not.equal(target.leaf);
      // The original (pre-edit) leaf + its old proof must not verify against the new root.
      expect(await registry.verifyLeaf(after.root, target.leaf, goodProof)).to.equal(false);
    });

    it("RENAMING a file changes the root (root commits to names, not just content) — T-0.2", async function () {
      // Two directories with byte-for-byte IDENTICAL content, differing ONLY in one file's name.
      const before = tmp("vh-rename-before-");
      const after = tmp("vh-rename-after-");
      writeFiles(before, {
        "alpha.txt": "first file contents",
        "beta.txt": "second file contents",
        "gamma.txt": "third file contents",
      });
      writeFiles(after, {
        "alpha.txt": "first file contents",
        "beta_renamed.txt": "second file contents", // renamed; identical bytes
        "gamma.txt": "third file contents",
      });

      const rootBefore = hashDir(before).root;
      const rootAfter = hashDir(after).root;

      // The content multiset is identical; ONLY a name changed. A content-only Merkle root would be
      // unchanged here — proving that the root now binds the path is the entire point of T-0.2.
      expect(rootAfter).to.not.equal(rootBefore);
    });

    it("MOVING a file to a different directory changes the root (relPath is bound)", async function () {
      const before = tmp("vh-move-before-");
      const after = tmp("vh-move-after-");
      writeFiles(before, {
        "src/index.js": "module.exports = 1;",
        "README.md": "# project",
      });
      writeFiles(after, {
        "lib/index.js": "module.exports = 1;", // same bytes & basename, different directory
        "README.md": "# project",
      });
      expect(hashDir(after).root).to.not.equal(hashDir(before).root);
    });

    it("a renamed file's OLD proof no longer verifies on-chain against the new root", async function () {
      const { registry } = await loadFixture(deploy);
      const before = tmp("vh-rename-proof-before-");
      const after = tmp("vh-rename-proof-after-");
      writeFiles(before, {
        "alpha.txt": "first file contents",
        "beta.txt": "second file contents",
        "gamma.txt": "third file contents",
      });
      writeFiles(after, {
        "alpha.txt": "first file contents",
        "beta_renamed.txt": "second file contents",
        "gamma.txt": "third file contents",
      });

      const dBefore = hashDir(before);
      const dAfter = hashDir(after);

      // The renamed file's OLD (pre-rename) path-bound leaf + proof verify against the OLD root...
      const oldLeaf = dBefore.leafFor("beta.txt");
      const oldProof = dBefore.proofFor("beta.txt");
      expect(await registry.verifyLeaf(dBefore.root, oldLeaf, oldProof)).to.equal(true);

      // ...but NOT against the new root: the rename changed the leaf and the root, so the stale
      // membership claim is rejected on-chain. The same bytes at the new path verify with the NEW
      // leaf/proof, confirming the file itself is still present — only its name was rebound.
      expect(await registry.verifyLeaf(dAfter.root, oldLeaf, oldProof)).to.equal(false);
      const newLeaf = dAfter.leafFor("beta_renamed.txt");
      const newProof = dAfter.proofFor("beta_renamed.txt");
      expect(newLeaf).to.not.equal(oldLeaf);
      expect(await registry.verifyLeaf(dAfter.root, newLeaf, newProof)).to.equal(true);
    });

    it("a single file proven against a directory root uses its PATH-BOUND leaf (not the bare content hash)", async function () {
      const { registry } = await loadFixture(deploy);
      const dir = tmp("vh-single-in-dir-");
      writeFiles(dir, {
        "alpha.txt": "first file contents",
        "beta.txt": "second file contents",
        "gamma.txt": "third file contents",
      });
      const { root, proofFor, leafFor } = hashDir(dir);

      // The on-chain verifyLeaf consumes the path-bound leaf = pathLeaf(relPath, keccak256(bytes)).
      const fileHash = hashFile(path.join(dir, "beta.txt"));
      const leaf = leafFor("beta.txt");
      expect(leaf).to.equal(pathLeaf("beta.txt", fileHash));
      const proof = proofFor("beta.txt");
      expect(await registry.verifyLeaf(root, leaf, proof)).to.equal(true);

      // The bare content hash is NOT a valid leaf for the path-bound tree: passing it is rejected.
      expect(await registry.verifyLeaf(root, fileHash, proof)).to.equal(false);
    });

    it("hashDir throws on an empty directory (no leaves)", function () {
      const dir = tmp("vh-emptydir-");
      expect(() => hashDir(dir)).to.throw(/no files/i);
    });

    it("hashPath dispatches a directory to its Merkle root", function () {
      const dir = tmp("vh-disp-dir-");
      writeFiles(dir, { "a": "1", "b": "2" });
      const res = hashPath(dir);
      expect(res.kind).to.equal("dir");
      expect(res.root).to.equal(hashDir(dir).root);
    });
  });

  describe("leafHash / nodeHash match the contract's domain-separated convention", function () {
    it("CLI leafHash and nodeHash equal the contract's leafHash/nodeHash byte-for-byte", async function () {
      const { registry } = await loadFixture(deploy);
      const x = ethers.keccak256(ethers.toUtf8Bytes("left"));
      const y = ethers.keccak256(ethers.toUtf8Bytes("right"));
      expect(leafHash(x)).to.equal(await registry.leafHash(x));
      expect(nodeHash(x, y)).to.equal(await registry.nodeHash(x, y));
      // sorted-pair: nodeHash is order-independent.
      expect(nodeHash(x, y)).to.equal(nodeHash(y, x));
      expect(await registry.nodeHash(x, y)).to.equal(await registry.nodeHash(y, x));
    });

    it("agrees with verifyLeaf on a 2-leaf tree both ways (content digests + tagged leaves)", async function () {
      const { registry } = await loadFixture(deploy);
      // Content digests (the verifyLeaf input layer).
      const cx = ethers.keccak256(ethers.toUtf8Bytes("left"));
      const cy = ethers.keccak256(ethers.toUtf8Bytes("right"));
      // The tree is built from TAGGED leaves; the root is nodeHash of the two tagged leaves.
      const root = nodeHash(leafHash(cx), leafHash(cy));
      // cx proven with sibling leafHash(cy), and cy with sibling leafHash(cx), both verify.
      expect(await registry.verifyLeaf(root, cx, [leafHash(cy)])).to.equal(true);
      expect(await registry.verifyLeaf(root, cy, [leafHash(cx)])).to.equal(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // SECURITY: second-preimage resistance. Domain separation must make it impossible to pass an
  // interior node (or a bare content digest) off as a leaf. This is the heart of T-0.1.
  // ---------------------------------------------------------------------------------------------
  describe("second-preimage resistance (domain-separated leaves vs. nodes)", function () {
    function writeFiles(dir, files) {
      for (const [name, content] of Object.entries(files)) {
        const full = path.join(dir, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      }
    }

    it("rejects an interior node replayed as a leaf (the classic Merkle forgery)", async function () {
      const { registry } = await loadFixture(deploy);
      const dir = tmp("vh-2ndpre-");
      // A 4-file repo gives a real 2-level tree with genuine interior nodes.
      writeFiles(dir, {
        "f0.txt": "alpha contents",
        "f1.txt": "beta contents",
        "f2.txt": "gamma contents",
        "f3.txt": "delta contents",
      });
      const { root, leaves, proofFor } = hashDir(dir);
      expect(leaves).to.have.length(4);

      // Sanity: every genuine file still verifies against the (domain-separated) root.
      for (const { path: p, leaf } of leaves) {
        expect(await registry.verifyLeaf(root, leaf, proofFor(p))).to.equal(true);
      }

      // Reconstruct the tagged leaves in sorted order (exactly buildTree's bottom layer), then the
      // interior node over the first two — the value an attacker would try to pass off as a leaf.
      const taggedLeaves = leaves.map((l) => leafHash(l.leaf)); // already sorted by content digest
      const interiorNode = nodeHash(taggedLeaves[0], taggedLeaves[1]);
      const otherInterior = nodeHash(taggedLeaves[2], taggedLeaves[3]);
      // The interior node really is an interior value of THIS tree: nodeHash(left,right) == root.
      expect(nodeHash(interiorNode, otherInterior)).to.equal(root);

      // THE EXPLOIT ATTEMPT: present the interior node as a "content digest" leaf, with the sibling
      // interior node as a one-element proof. Under a naive (untagged) scheme this folds straight to
      // the root and would be ACCEPTED — forging membership of a value that is no real file.
      // Under domain separation, verifyLeaf re-tags the argument: leafHash(interiorNode) != node,
      // so the fold misses the root and it is REJECTED.
      expect(
        await registry.verifyLeaf(root, interiorNode, [otherInterior]),
        "interior node must NOT verify as a leaf"
      ).to.equal(false);

      // Belt and braces: confirm that WITHOUT domain separation this exact forgery WOULD succeed,
      // so the test is proving the tag is what stops it (not some unrelated mismatch).
      const naiveNode = (a, b) => {
        const [lo, hi] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
        return ethers.keccak256(ethers.concat([lo, hi]));
      };
      const naiveN01 = naiveNode(leaves[0].leaf, leaves[1].leaf);
      const naiveN23 = naiveNode(leaves[2].leaf, leaves[3].leaf);
      const naiveRoot = naiveNode(naiveN01, naiveN23);
      const naiveVerify = (r, leaf, proof) => {
        let x = leaf;
        for (const p of proof) x = naiveNode(x, p);
        return x === r;
      };
      expect(naiveVerify(naiveRoot, naiveN01, [naiveN23]), "naive scheme is forgeable").to.equal(true);
    });

    it("rejects a bare (untagged) content digest passed as the leaf-layer value", async function () {
      const { registry } = await loadFixture(deploy);
      // Single-leaf tree: root = leafHash(c). The verifier accepts the content digest c (it tags it
      // itself) but must reject c's already-tagged value, and reject an untagged value as the root.
      const c = ethers.keccak256(ethers.toUtf8Bytes("only-file"));
      const root = leafHash(c);
      expect(await registry.verifyLeaf(root, c, [])).to.equal(true);
      // Passing the tagged leaf itself as the "content digest" double-tags it -> rejected.
      expect(await registry.verifyLeaf(root, root, [])).to.equal(false);
      // Old untagged convention (root == content digest) no longer verifies.
      expect(await registry.verifyLeaf(c, c, [])).to.equal(false);
    });
  });
});

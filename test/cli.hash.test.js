const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { hashFile, hashBytes, hashDir, hashPath, hashPair } = require("../cli/hash");

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

      // And prove the contract accepts this digest as a 1-leaf Merkle root (empty proof):
      // verifyLeaf(root, leaf, []) returns root == leaf, so the CLI digest *is* a valid
      // anchorable/verifiable value on-chain.
      const { registry } = await loadFixture(deploy);
      expect(await registry.verifyLeaf(cliHash, cliHash, [])).to.equal(true);
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
      expect(await registry.verifyLeaf(cliHash, cliHash, [])).to.equal(true);
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

    it("directory leaves are the per-file keccak256 digests", function () {
      const dir = tmp("vh-leaf-");
      writeFiles(dir, { "one": "11111", "two": "22222" });
      const { leaves } = hashDir(dir);
      for (const { path: p, leaf } of leaves) {
        expect(leaf).to.equal(hashFile(path.join(dir, p)));
      }
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

    it("a single file proven against a directory root uses its own content hash as the leaf", async function () {
      const { registry } = await loadFixture(deploy);
      const dir = tmp("vh-single-in-dir-");
      writeFiles(dir, {
        "alpha.txt": "first file contents",
        "beta.txt": "second file contents",
        "gamma.txt": "third file contents",
      });
      const { root, proofFor } = hashDir(dir);

      // hashFile of an individual file equals the leaf used in the directory tree.
      const fileHash = hashFile(path.join(dir, "beta.txt"));
      const proof = proofFor("beta.txt");
      expect(await registry.verifyLeaf(root, fileHash, proof)).to.equal(true);
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

  describe("hashPair matches the contract's sorted-pair convention", function () {
    it("agrees with verifyLeaf on a 2-leaf tree both ways", async function () {
      const { registry } = await loadFixture(deploy);
      const x = ethers.keccak256(ethers.toUtf8Bytes("left"));
      const y = ethers.keccak256(ethers.toUtf8Bytes("right"));
      const root = hashPair(x, y);
      // x proven with sibling y, and y proven with sibling x, both verify against root.
      expect(await registry.verifyLeaf(root, x, [y])).to.equal(true);
      expect(await registry.verifyLeaf(root, y, [x])).to.equal(true);
      // sorted-pair: order of inputs to hashPair does not matter.
      expect(hashPair(x, y)).to.equal(hashPair(y, x));
    });
  });
});

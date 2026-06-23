const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { anyUint } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

// ---- tiny sorted-pair Merkle helper, mirroring the contract's verifyLeaf ----
function hashPair(a, b) {
  const [lo, hi] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([lo, hi]));
}
function buildTree(leaves) {
  // returns { root, proofFor(i) }
  let layer = leaves.slice();
  const layers = [layer];
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(i + 1 < layer.length ? hashPair(layer[i], layer[i + 1]) : layer[i]);
    }
    layer = next;
    layers.push(layer);
  }
  const root = layers[layers.length - 1][0];
  function proofFor(index) {
    const proof = [];
    let idx = index;
    for (let l = 0; l < layers.length - 1; l++) {
      const lvl = layers[l];
      const pair = idx ^ 1;
      if (pair < lvl.length) proof.push(lvl[pair]);
      idx = Math.floor(idx / 2);
    }
    return proof;
  }
  return { root, proofFor };
}

describe("ContributionRegistry", function () {
  async function deploy() {
    const [deployer, alice, bob] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ContributionRegistry");
    const registry = await Factory.deploy();
    await registry.waitForDeployment();
    return { registry, deployer, alice, bob };
  }

  const H1 = ethers.keccak256(ethers.toUtf8Bytes("contribution-one"));
  const H2 = ethers.keccak256(ethers.toUtf8Bytes("contribution-two"));
  const ZERO = ethers.ZeroHash;

  describe("anchor", function () {
    it("records contributor, uri, timestamp, block, and index", async function () {
      const { registry, alice } = await loadFixture(deploy);
      await registry.connect(alice).anchor(H1, "ipfs://cid-1");

      const rec = await registry.getRecord(H1);
      expect(rec.contributor).to.equal(alice.address);
      expect(rec.uri).to.equal("ipfs://cid-1");
      expect(rec.blockNumber).to.be.greaterThan(0n);
      expect(rec.timestamp).to.be.greaterThan(0n);
      expect(await registry.total()).to.equal(1n);
      expect(await registry.hashAtIndex(0)).to.equal(H1);
    });

    it("emits Anchored with correct args", async function () {
      const { registry, alice } = await loadFixture(deploy);
      await expect(registry.connect(alice).anchor(H1, "ipfs://cid-1"))
        .to.emit(registry, "Anchored")
        .withArgs(H1, alice.address, 0, anyUint, "ipfs://cid-1");
    });

    it("reverts on the zero hash", async function () {
      const { registry, alice } = await loadFixture(deploy);
      await expect(registry.connect(alice).anchor(ZERO, "")).to.be.revertedWithCustomError(
        registry,
        "ZeroHash"
      );
    });

    it("is first-writer-wins: a duplicate hash reverts and the original contributor is preserved", async function () {
      const { registry, alice, bob } = await loadFixture(deploy);
      await registry.connect(alice).anchor(H1, "ipfs://cid-1");

      await expect(registry.connect(bob).anchor(H1, "ipfs://evil"))
        .to.be.revertedWithCustomError(registry, "AlreadyAnchored")
        .withArgs(H1, alice.address);

      const rec = await registry.getRecord(H1);
      expect(rec.contributor).to.equal(alice.address);
      expect(rec.uri).to.equal("ipfs://cid-1");
      expect(await registry.total()).to.equal(1n);
    });

    it("supports many distinct hashes from many senders", async function () {
      const { registry, alice, bob } = await loadFixture(deploy);
      await registry.connect(alice).anchor(H1, "a");
      await registry.connect(bob).anchor(H2, "b");
      expect(await registry.total()).to.equal(2n);
      expect(await registry.hashAtIndex(0)).to.equal(H1);
      expect(await registry.hashAtIndex(1)).to.equal(H2);
      expect((await registry.getRecord(H2)).contributor).to.equal(bob.address);
    });

    it("rejects ETH sent to anchor (non-payable, holds no funds)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      // Encode the call and attach value; a non-payable function must reject it.
      const data = registry.interface.encodeFunctionData("anchor", [H1, ""]);
      await expect(
        alice.sendTransaction({ to: await registry.getAddress(), data, value: 1n })
      ).to.be.reverted;
    });
  });

  describe("views", function () {
    it("isAnchored reflects state", async function () {
      const { registry, alice } = await loadFixture(deploy);
      expect(await registry.isAnchored(H1)).to.equal(false);
      await registry.connect(alice).anchor(H1, "");
      expect(await registry.isAnchored(H1)).to.equal(true);
    });

    it("getRecord reverts for an unknown hash", async function () {
      const { registry } = await loadFixture(deploy);
      await expect(registry.getRecord(H2)).to.be.revertedWithCustomError(registry, "NotAnchored");
    });

    it("hashAtIndex reverts out of range", async function () {
      const { registry, alice } = await loadFixture(deploy);
      await registry.connect(alice).anchor(H1, "");
      await expect(registry.hashAtIndex(1)).to.be.revertedWithCustomError(
        registry,
        "IndexOutOfRange"
      );
    });
  });

  describe("verifyLeaf (Merkle)", function () {
    it("verifies a valid leaf+proof against the anchored root", async function () {
      const { registry } = await loadFixture(deploy);
      const leaves = [0, 1, 2, 3, 4].map((i) =>
        ethers.keccak256(ethers.toUtf8Bytes("file-" + i))
      );
      const { root, proofFor } = buildTree(leaves);
      for (let i = 0; i < leaves.length; i++) {
        expect(await registry.verifyLeaf(root, leaves[i], proofFor(i))).to.equal(true);
      }
    });

    it("rejects a tampered leaf", async function () {
      const { registry } = await loadFixture(deploy);
      const leaves = [0, 1, 2, 3].map((i) => ethers.keccak256(ethers.toUtf8Bytes("file-" + i)));
      const { root, proofFor } = buildTree(leaves);
      const tampered = ethers.keccak256(ethers.toUtf8Bytes("file-0-tampered"));
      expect(await registry.verifyLeaf(root, tampered, proofFor(0))).to.equal(false);
    });

    it("rejects a valid leaf against the wrong root", async function () {
      const { registry } = await loadFixture(deploy);
      const leaves = [0, 1, 2, 3].map((i) => ethers.keccak256(ethers.toUtf8Bytes("file-" + i)));
      const { proofFor } = buildTree(leaves);
      const wrongRoot = ethers.keccak256(ethers.toUtf8Bytes("not-the-root"));
      expect(await registry.verifyLeaf(wrongRoot, leaves[0], proofFor(0))).to.equal(false);
    });
  });
});

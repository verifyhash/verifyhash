const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");

// ---------------------------------------------------------------------------------------------
// T-7.1 — bounded, paginated read views: getRecordAtIndex(index) and getRecords(start, count).
//
// These are purely additive, ownerless `view` reads over the existing _hashByIndex / _records
// mappings. They must:
//   * read back an anchored/revealed sequence in EXACT insertion order, by index and by page;
//   * reuse the existing IndexOutOfRange(index, total) error on getRecordAtIndex(total);
//   * CLAMP getRecords to `total` — a window past the end returns empty/partial WITHOUT reverting;
//   * distinguish an authorBound=true (reveal) record from an authorBound=false (anchor) record.
// ---------------------------------------------------------------------------------------------

describe("Enumeration — paginated reads (T-7.1)", function () {
  async function deploy() {
    const [deployer, alice, bob, carol] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ContributionRegistry");
    const registry = await Factory.deploy();
    await registry.waitForDeployment();
    return { registry, deployer, alice, bob, carol };
  }

  // Compute the commitment exactly as the contract does: keccak256(abi.encode(hash, addr, salt)).
  function commitmentOf(contentHash, committer, salt) {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "bytes32"],
        [contentHash, committer, salt]
      )
    );
  }

  // Anchor `n` one-shot (authorBound=false) records from `signer`. Returns the ordered hashes/uris.
  async function anchorSequence(registry, signer, n) {
    const hashes = [];
    const uris = [];
    for (let i = 0; i < n; i++) {
      const h = ethers.keccak256(ethers.toUtf8Bytes("seq-item-" + i));
      const u = "ipfs://cid-" + i;
      await registry.connect(signer).anchor(h, u);
      hashes.push(h);
      uris.push(u);
    }
    return { hashes, uris };
  }

  describe("getRecordAtIndex", function () {
    it("returns the (hash, record) at each index in insertion order", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const { hashes, uris } = await anchorSequence(registry, alice, 4);

      expect(await registry.total()).to.equal(4n);
      for (let i = 0; i < hashes.length; i++) {
        const [contentHash, record] = await registry.getRecordAtIndex(i);
        expect(contentHash).to.equal(hashes[i]);
        expect(record.contributor).to.equal(alice.address);
        expect(record.uri).to.equal(uris[i]);
        expect(record.authorBound).to.equal(false);
        expect(record.blockNumber).to.be.greaterThan(0n);
        expect(record.timestamp).to.be.greaterThan(0n);
      }
    });

    it("matches getRecord(hashAtIndex(i)) for every index (consistent view)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const { hashes } = await anchorSequence(registry, alice, 3);
      for (let i = 0; i < hashes.length; i++) {
        const [contentHash, record] = await registry.getRecordAtIndex(i);
        const byHash = await registry.getRecord(await registry.hashAtIndex(i));
        expect(contentHash).to.equal(await registry.hashAtIndex(i));
        expect(record.contributor).to.equal(byHash.contributor);
        expect(record.uri).to.equal(byHash.uri);
        expect(record.authorBound).to.equal(byHash.authorBound);
        expect(record.timestamp).to.equal(byHash.timestamp);
        expect(record.blockNumber).to.equal(byHash.blockNumber);
      }
    });

    it("reverts IndexOutOfRange(index, total) at index == total (reuses existing error)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      await anchorSequence(registry, alice, 2);
      await expect(registry.getRecordAtIndex(2))
        .to.be.revertedWithCustomError(registry, "IndexOutOfRange")
        .withArgs(2, 2);
    });

    it("reverts IndexOutOfRange on an empty registry (index 0, total 0)", async function () {
      const { registry } = await loadFixture(deploy);
      await expect(registry.getRecordAtIndex(0))
        .to.be.revertedWithCustomError(registry, "IndexOutOfRange")
        .withArgs(0, 0);
    });

    it("reverts IndexOutOfRange far past the end with the real total", async function () {
      const { registry, alice } = await loadFixture(deploy);
      await anchorSequence(registry, alice, 3);
      await expect(registry.getRecordAtIndex(99))
        .to.be.revertedWithCustomError(registry, "IndexOutOfRange")
        .withArgs(99, 3);
    });
  });

  describe("getRecords (paginated, clamped)", function () {
    it("returns the full set as parallel arrays in insertion order", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const { hashes, uris } = await anchorSequence(registry, alice, 5);

      const [contentHashes, records] = await registry.getRecords(0, 5);
      expect(contentHashes.length).to.equal(5);
      expect(records.length).to.equal(5);
      for (let i = 0; i < 5; i++) {
        expect(contentHashes[i]).to.equal(hashes[i]);
        expect(records[i].contributor).to.equal(alice.address);
        expect(records[i].uri).to.equal(uris[i]);
        expect(records[i].authorBound).to.equal(false);
      }
    });

    it("pages through the registry: walking fixed-size pages reproduces the whole sequence", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const N = 7;
      const { hashes, uris } = await anchorSequence(registry, alice, N);

      const page = 3;
      const seenHashes = [];
      const seenUris = [];
      for (let start = 0; start < N; start += page) {
        const [contentHashes, records] = await registry.getRecords(start, page);
        for (let i = 0; i < contentHashes.length; i++) {
          seenHashes.push(contentHashes[i]);
          seenUris.push(records[i].uri);
        }
      }
      expect(seenHashes).to.deep.equal(hashes);
      expect(seenUris).to.deep.equal(uris);
    });

    it("returns a middle window for [start, start+count)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const { hashes } = await anchorSequence(registry, alice, 6);
      const [contentHashes, records] = await registry.getRecords(2, 3);
      expect(contentHashes.length).to.equal(3);
      expect(contentHashes[0]).to.equal(hashes[2]);
      expect(contentHashes[1]).to.equal(hashes[3]);
      expect(contentHashes[2]).to.equal(hashes[4]);
      expect(records.length).to.equal(3);
    });

    it("CLAMP: start >= total returns empty arrays (no revert)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      await anchorSequence(registry, alice, 3);

      // start exactly at total
      let [contentHashes, records] = await registry.getRecords(3, 10);
      expect(contentHashes.length).to.equal(0);
      expect(records.length).to.equal(0);

      // start well past total
      [contentHashes, records] = await registry.getRecords(1000, 10);
      expect(contentHashes.length).to.equal(0);
      expect(records.length).to.equal(0);
    });

    it("CLAMP: an over-long count returns only what exists in the tail (no revert)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const { hashes } = await anchorSequence(registry, alice, 4);

      // window [2, 2+100) -> only indices 2,3 exist; length clamps to 2.
      const [contentHashes, records] = await registry.getRecords(2, 100);
      expect(contentHashes.length).to.equal(2);
      expect(records.length).to.equal(2);
      expect(contentHashes[0]).to.equal(hashes[2]);
      expect(contentHashes[1]).to.equal(hashes[3]);
    });

    it("CLAMP: count == 0 returns empty arrays (no revert)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      await anchorSequence(registry, alice, 3);
      const [contentHashes, records] = await registry.getRecords(0, 0);
      expect(contentHashes.length).to.equal(0);
      expect(records.length).to.equal(0);
    });

    it("CLAMP: empty registry returns empty arrays for any window (no revert)", async function () {
      const { registry } = await loadFixture(deploy);
      const [contentHashes, records] = await registry.getRecords(0, 50);
      expect(contentHashes.length).to.equal(0);
      expect(records.length).to.equal(0);
    });
  });

  describe("authorBound is preserved through the read-back", function () {
    it("distinguishes a reveal (authorBound=true) from an anchor (authorBound=false)", async function () {
      const { registry, alice, bob } = await loadFixture(deploy);

      // Index 0: one-shot anchor() by bob -> authorBound = false.
      const anchored = ethers.keccak256(ethers.toUtf8Bytes("plain-anchor"));
      await registry.connect(bob).anchor(anchored, "ipfs://anchored");

      // Index 1: commit+reveal() by alice -> authorBound = true.
      const revealed = ethers.keccak256(ethers.toUtf8Bytes("revealed-claim"));
      const salt = ethers.keccak256(ethers.toUtf8Bytes("alice-salt"));
      await registry.connect(alice).commit(commitmentOf(revealed, alice.address, salt));
      await mine(2); // age past MIN_REVEAL_DELAY
      await registry.connect(alice).reveal(revealed, salt, "ipfs://revealed");

      expect(await registry.total()).to.equal(2n);

      // By index.
      const [h0, r0] = await registry.getRecordAtIndex(0);
      const [h1, r1] = await registry.getRecordAtIndex(1);
      expect(h0).to.equal(anchored);
      expect(r0.contributor).to.equal(bob.address);
      expect(r0.authorBound).to.equal(false);
      expect(h1).to.equal(revealed);
      expect(r1.contributor).to.equal(alice.address);
      expect(r1.authorBound).to.equal(true);

      // By page — the same distinction survives the batch read.
      const [hashes, records] = await registry.getRecords(0, 10);
      expect(hashes.length).to.equal(2);
      expect(hashes[0]).to.equal(anchored);
      expect(records[0].contributor).to.equal(bob.address);
      expect(records[0].authorBound).to.equal(false);
      expect(hashes[1]).to.equal(revealed);
      expect(records[1].contributor).to.equal(alice.address);
      expect(records[1].authorBound).to.equal(true);
    });
  });

  describe("additive & ownerless (no new write path / no state)", function () {
    it("getRecords and getRecordAtIndex are view: they execute via eth_call without a tx", async function () {
      const { registry, alice } = await loadFixture(deploy);
      await anchorSequence(registry, alice, 2);
      // staticCall succeeds and total is unchanged -> no state mutation.
      const before = await registry.total();
      await registry.getRecords.staticCall(0, 2);
      await registry.getRecordAtIndex.staticCall(0);
      expect(await registry.total()).to.equal(before);
    });
  });
});

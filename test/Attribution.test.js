const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { anyUint } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

// Commit-reveal attribution (decision D-1, task T-0.3).
//
// THE THREAT (audit F4/F14/F2/F5): anchor(contentHash, uri) puts the raw contentHash in the public
// mempool. A front-runner copies it, lands first, and becomes the permanent `contributor`. First-
// writer-wins makes the mis-attribution irreversible.
//
// THE FIX: commit(keccak256(abi.encode(contentHash, msg.sender, salt))) then reveal(contentHash,
// salt, uri) after MIN_REVEAL_DELAY blocks. The committer is bound INTO the commitment before the
// contentHash is ever public, so a copier who lifts the reveal from the mempool cannot redirect
// attribution to themselves. These tests pin that property down.

describe("Attribution — commit-reveal (T-0.3 / D-1)", function () {
  async function deploy() {
    const [deployer, alice, attacker] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ContributionRegistry");
    const registry = await Factory.deploy();
    await registry.waitForDeployment();
    return { registry, deployer, alice, attacker };
  }

  const CONTENT = ethers.keccak256(ethers.toUtf8Bytes("alice's brilliant contribution"));
  const SALT = ethers.keccak256(ethers.toUtf8Bytes("alice-secret-salt"));

  // Compute the commitment exactly as the contract does: keccak256(abi.encode(hash, addr, salt)).
  function commitmentOf(contentHash, committer, salt) {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "bytes32"],
      [contentHash, committer, salt]
    );
    return ethers.keccak256(encoded);
  }

  describe("commitmentOf helper", function () {
    it("matches the JS construction (abi.encode of hash, committer, salt)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      expect(await registry.commitmentOf(CONTENT, alice.address, SALT)).to.equal(
        commitmentOf(CONTENT, alice.address, SALT)
      );
    });

    it("is bound to the committer: same hash+salt, different address => different commitment", async function () {
      const { registry, alice, attacker } = await loadFixture(deploy);
      const cA = await registry.commitmentOf(CONTENT, alice.address, SALT);
      const cB = await registry.commitmentOf(CONTENT, attacker.address, SALT);
      expect(cA).to.not.equal(cB);
    });
  });

  describe("happy path", function () {
    it("commit then reveal records the committer with authorBound = true", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const commitment = commitmentOf(CONTENT, alice.address, SALT);

      await expect(registry.connect(alice).commit(commitment))
        .to.emit(registry, "Committed")
        .withArgs(commitment, alice.address, anyUint);

      // Wait out the maturation window.
      await mine(2);

      await expect(registry.connect(alice).reveal(CONTENT, SALT, "ipfs://cid-alice"))
        .to.emit(registry, "Revealed")
        .withArgs(CONTENT, alice.address, 0, commitment, anyUint, "ipfs://cid-alice")
        .and.to.emit(registry, "Anchored")
        .withArgs(CONTENT, alice.address, 0, anyUint, "ipfs://cid-alice");

      const rec = await registry.getRecord(CONTENT);
      expect(rec.contributor).to.equal(alice.address);
      expect(rec.authorBound).to.equal(true);
      expect(rec.uri).to.equal("ipfs://cid-alice");
      expect(await registry.total()).to.equal(1n);

      // The commitment is single-use: it is cleared after a successful reveal.
      const [committer] = await registry.getCommitment(commitment);
      expect(committer).to.equal(ethers.ZeroAddress);
    });

    it("a one-shot anchor() records authorBound = false (first anchorer only)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      await registry.connect(alice).anchor(CONTENT, "");
      const rec = await registry.getRecord(CONTENT);
      expect(rec.contributor).to.equal(alice.address);
      expect(rec.authorBound).to.equal(false);
    });
  });

  describe("FRONT-RUNNING RESISTANCE (the core property)", function () {
    it("a front-runner who copies the revealed (contentHash, salt) from the mempool CANNOT become the author", async function () {
      const { registry, alice, attacker } = await loadFixture(deploy);

      // 1. Alice commits (her commitment is bound to HER address + secret salt).
      const aliceCommitment = commitmentOf(CONTENT, alice.address, SALT);
      await registry.connect(alice).commit(aliceCommitment);
      await mine(2);

      // 2. Alice broadcasts reveal(CONTENT, SALT, uri). The attacker sees the EXACT calldata in the
      //    mempool (contentHash AND salt are now visible) and tries to front-run by submitting the
      //    same reveal from their own account FIRST.
      //
      //    It must fail: reveal recomputes commitmentOf(CONTENT, attacker, SALT) — a commitment the
      //    attacker never registered — so there is nothing to open.
      const stolenCommitment = commitmentOf(CONTENT, attacker.address, SALT);
      await expect(registry.connect(attacker).reveal(CONTENT, SALT, "ipfs://attacker"))
        .to.be.revertedWithCustomError(registry, "NoSuchCommitment")
        .withArgs(stolenCommitment);

      // 3. Alice's reveal lands and SHE is the recorded, author-bound contributor.
      await registry.connect(alice).reveal(CONTENT, SALT, "ipfs://cid-alice");
      const rec = await registry.getRecord(CONTENT);
      expect(rec.contributor).to.equal(alice.address);
      expect(rec.authorBound).to.equal(true);
    });

    it("the attacker cannot pre-register a stolen commitment and reveal it the same block (MIN_REVEAL_DELAY blocks it)", async function () {
      const { registry, attacker } = await loadFixture(deploy);
      // Even if the attacker forms their OWN commitment for the content, the maturation window means
      // they cannot commit and reveal atomically/instantly — so they cannot win a same-block race
      // against an already-matured legitimate commitment.
      const c = commitmentOf(CONTENT, attacker.address, SALT);
      await registry.connect(attacker).commit(c);
      // No blocks mined: reveal in the very next tx is still inside the window.
      await expect(
        registry.connect(attacker).reveal(CONTENT, SALT, "")
      ).to.be.revertedWithCustomError(registry, "RevealTooSoon");
    });

    it("after the legitimate claim lands, a copier's later anchor()/reveal of the same hash reverts (first-writer-wins)", async function () {
      const { registry, alice, attacker } = await loadFixture(deploy);
      const aliceCommitment = commitmentOf(CONTENT, alice.address, SALT);
      await registry.connect(alice).commit(aliceCommitment);
      await mine(2);
      await registry.connect(alice).reveal(CONTENT, SALT, "ipfs://cid-alice");

      // Attacker tries a plain anchor of the same content — too late, Alice owns the record.
      await expect(registry.connect(attacker).anchor(CONTENT, "ipfs://attacker"))
        .to.be.revertedWithCustomError(registry, "AlreadyAnchored")
        .withArgs(CONTENT, alice.address);

      // Attacker even commits + reveals their own (attacker-bound) commitment — the contentHash is
      // already taken, so reveal reverts at the record-write step.
      const attackerCommitment = commitmentOf(CONTENT, attacker.address, SALT);
      await registry.connect(attacker).commit(attackerCommitment);
      await mine(2);
      await expect(registry.connect(attacker).reveal(CONTENT, SALT, "ipfs://attacker"))
        .to.be.revertedWithCustomError(registry, "AlreadyAnchored")
        .withArgs(CONTENT, alice.address);

      const rec = await registry.getRecord(CONTENT);
      expect(rec.contributor).to.equal(alice.address);
      expect(rec.authorBound).to.equal(true);
    });
  });

  describe("commit / reveal validation", function () {
    it("rejects the zero commitment", async function () {
      const { registry, alice } = await loadFixture(deploy);
      await expect(
        registry.connect(alice).commit(ethers.ZeroHash)
      ).to.be.revertedWithCustomError(registry, "ZeroCommitment");
    });

    it("rejects a duplicate (still-open) commitment", async function () {
      const { registry, alice, attacker } = await loadFixture(deploy);
      const c = commitmentOf(CONTENT, alice.address, SALT);
      await registry.connect(alice).commit(c);
      await expect(registry.connect(attacker).commit(c))
        .to.be.revertedWithCustomError(registry, "CommitmentExists")
        .withArgs(c, alice.address);
    });

    it("reveal reverts if there is no matching commitment for the sender", async function () {
      const { registry, alice } = await loadFixture(deploy);
      // Nobody committed: the recomputed commitment does not exist.
      await expect(
        registry.connect(alice).reveal(CONTENT, SALT, "")
      ).to.be.revertedWithCustomError(registry, "NoSuchCommitment");
    });

    it("reveal reverts on the zero hash", async function () {
      const { registry, alice } = await loadFixture(deploy);
      await expect(
        registry.connect(alice).reveal(ethers.ZeroHash, SALT, "")
      ).to.be.revertedWithCustomError(registry, "ZeroHash");
    });

    it("a wrong salt at reveal time does not open the commitment", async function () {
      const { registry, alice } = await loadFixture(deploy);
      await registry.connect(alice).commit(commitmentOf(CONTENT, alice.address, SALT));
      await mine(2);
      const wrongSalt = ethers.keccak256(ethers.toUtf8Bytes("not-the-salt"));
      await expect(
        registry.connect(alice).reveal(CONTENT, wrongSalt, "")
      ).to.be.revertedWithCustomError(registry, "NoSuchCommitment");
    });

    it("getCommitment exposes a pending commitment and zeroes after reveal", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const c = commitmentOf(CONTENT, alice.address, SALT);
      await registry.connect(alice).commit(c);
      const [committer, blockNumber] = await registry.getCommitment(c);
      expect(committer).to.equal(alice.address);
      expect(blockNumber).to.be.greaterThan(0n);
      await mine(2);
      await registry.connect(alice).reveal(CONTENT, SALT, "");
      const [after] = await registry.getCommitment(c);
      expect(after).to.equal(ethers.ZeroAddress);
    });
  });
});

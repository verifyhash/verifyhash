const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");

const rp = require("../cli/core/reputation-points");

// ---------------------------------------------------------------------------------------------
// ReputationGate (EPIC-3 reference consumer): the smallest copyable base a paying verification /
// evidence integration inherits to GATE a business action on PROVEN contribution history — exactly the
// buyer use case docs/REPUTATION-SBT-DESIGN.md §5 names ("only auto-honor a claimed contribution when
// the claiming address holds >= N proven, front-running-resistant contributions; route everything below
// to manual review"). It exists to prove the reputation layer's central claim with real, tested code
// rather than prose: the whole gate decision is a single O(1) call to the pinned SBT's meetsThreshold.
//
// What this file proves, bullet by bullet:
//   * the gate pins ONE identity-probed ReputationSBT + an immutable threshold (EPIC-11 pinning rule):
//     the zero address, a look-alike that LIES about REPUTATION_ID, and a marker-less contract/EOA are
//     all rejected at construction, so a gate can never be wired over an arbitrary/lying contract;
//   * isAllowed / requireReputation reflect points vs the threshold, INCLUSIVE at the boundary;
//   * the gate FAILS CLOSED: below the threshold requireReputation/autoHonor revert
//     InsufficientReputation(account, have, required) so the caller routes to manual review; at/above
//     the threshold autoHonor emits Honored and returns true;
//   * THE SOULBOUND TIE (the load-bearing property): because the SBT credits every point to the backing
//     record's own contributor — never to whoever paid gas to mint it — a stranger who mints another's
//     points CANNOT pass the gate for themselves; only the address that provably contributed can;
//   * a zero threshold admits everyone (a floor of zero), even a zero-point address;
//   * CONFORMANCE: the gate's on-chain decision equals the off-chain oracle's
//     hasAtLeast(records, addr, threshold) and the SBT's own meetsThreshold, for the same records;
//   * the gate holds NO funds (non-payable, no receive/fallback) and exposes NO owner/admin/transfer
//     surface — it is infrastructure the products consume, not a token.
//
// Local hardhat only — nothing here deploys anywhere (P-2 remains the only path to a public chain).
// ---------------------------------------------------------------------------------------------

describe("ReputationGate (EPIC-3 reference consumer): fail-closed gate on proven contribution history", function () {
  const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

  function commitmentOf(contentHash, committer, salt) {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "bytes32"],
        [contentHash, committer, salt]
      )
    );
  }

  async function commitReveal(registry, signer, contentHash, uri) {
    const salt = ethers.keccak256(ethers.toUtf8Bytes("salt-" + uri));
    await registry.connect(signer).commit(commitmentOf(contentHash, signer.address, salt));
    await mine(2); // age past MIN_REVEAL_DELAY
    await registry.connect(signer).reveal(contentHash, salt, uri);
  }

  // Deploy registry + SBT + a gate with the given threshold (default 2).
  async function deployWithThreshold(minPoints) {
    const [deployer, alice, bob, carol] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("ContributionRegistry");
    const registry = await Registry.deploy();
    await registry.waitForDeployment();
    const SBT = await ethers.getContractFactory("ReputationSBT");
    const sbt = await SBT.deploy(await registry.getAddress());
    await sbt.waitForDeployment();
    const Gate = await ethers.getContractFactory("ReputationGate");
    const gate = await Gate.deploy(await sbt.getAddress(), minPoints);
    await gate.waitForDeployment();
    return { registry, sbt, gate, Gate, deployer, alice, bob, carol };
  }

  function deploy2() {
    return deployWithThreshold(2n);
  }
  function deploy0() {
    return deployWithThreshold(0n);
  }

  // Page every record out of the registry, shaped for the pure projection oracle.
  async function allRecords(registry) {
    const out = [];
    const page = 100n;
    for (let start = 0n; ; start += page) {
      const [hashes, records] = await registry.getRecords(start, page);
      for (let i = 0; i < hashes.length; i++) {
        out.push({
          contentHash: hashes[i],
          contributor: records[i].contributor,
          authorBound: records[i].authorBound,
        });
      }
      if (BigInt(hashes.length) < page) break;
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Constructor: pins ONE identity-probed ReputationSBT + an immutable threshold.
  // -------------------------------------------------------------------------------------------
  describe("constructor pins one identity-probed ReputationSBT + an immutable threshold", function () {
    it("pins the SBT address and threshold immutably (readable, and no setter exists)", async function () {
      const { sbt, gate } = await loadFixture(deploy2);
      expect(await gate.reputation()).to.equal(await sbt.getAddress());
      expect(await gate.minPoints()).to.equal(2n);
      // No function in the ABI can change either (both are view-only reads).
      const setters = gate.interface.fragments.filter(
        (f) =>
          f.type === "function" &&
          /reputation|minPoints/i.test(f.name) &&
          f.stateMutability !== "view"
      );
      expect(setters).to.deep.equal([]);
    });

    it("the compile-time EXPECTED_REPUTATION_ID equals the SBT's frozen REPUTATION_ID (no drift)", async function () {
      const { sbt, gate } = await loadFixture(deploy2);
      const expected = await gate.EXPECTED_REPUTATION_ID();
      expect(expected).to.equal(await sbt.REPUTATION_ID());
      expect(expected).to.equal(h("verifyhash.ReputationSBT.v1"));
    });

    it("rejects the zero address (ZeroReputation)", async function () {
      const { Gate } = await loadFixture(deploy2);
      await expect(Gate.deploy(ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(
        Gate,
        "ZeroReputation"
      );
    });

    it("rejects a contract that LIES about its reputation identity (NotAReputationSBT)", async function () {
      const { Gate } = await loadFixture(deploy2);
      const Liar = await ethers.getContractFactory("LyingReputationId");
      const liar = await Liar.deploy();
      await liar.waitForDeployment();
      await expect(Gate.deploy(await liar.getAddress(), 1n))
        .to.be.revertedWithCustomError(Gate, "NotAReputationSBT")
        .withArgs(await liar.getAddress());
    });

    it("rejects a contract with NO reputation identity marker (probe call reverts)", async function () {
      const { Gate } = await loadFixture(deploy2);
      // A real ContributionRegistry answers REGISTRY_ID(), not REPUTATION_ID() — the probe selector is
      // absent, so the call itself reverts (a marker-less contract can never be pinned).
      const Registry = await ethers.getContractFactory("ContributionRegistry");
      const registry = await Registry.deploy();
      await registry.waitForDeployment();
      await expect(Gate.deploy(await registry.getAddress(), 1n)).to.be.reverted;
    });

    it("rejects an EOA (no code to answer the identity probe)", async function () {
      const { Gate, alice } = await loadFixture(deploy2);
      await expect(Gate.deploy(alice.address, 1n)).to.be.reverted;
    });
  });

  // -------------------------------------------------------------------------------------------
  // The gate decision: isAllowed / requireReputation reflect points vs the threshold, inclusive.
  // -------------------------------------------------------------------------------------------
  describe("isAllowed / requireReputation reflect points vs the threshold (inclusive)", function () {
    async function scenario() {
      const ctx = await deployWithThreshold(2n);
      const { registry, sbt, deployer } = ctx;
      // alice: 2 authorBound points; bob: 1; carol: 0.
      await commitReveal(registry, ctx.alice, h("s-a1"), "s-a1");
      await commitReveal(registry, ctx.alice, h("s-a2"), "s-a2");
      await commitReveal(registry, ctx.bob, h("s-b1"), "s-b1");
      const records = await allRecords(registry);
      await sbt.connect(deployer).mintBatch(rp.projectPoints(records).minted);
      return { ...ctx, records };
    }

    it("an account at/above the threshold is allowed; requireReputation does not revert", async function () {
      const { gate, alice } = await scenario();
      expect(await gate.isAllowed(alice.address)).to.equal(true); // 2 >= 2 (inclusive)
      await gate.requireReputation(alice.address); // static view call — must not revert
    });

    it("an account below the threshold is not allowed; requireReputation reverts InsufficientReputation(account, have, required)", async function () {
      const { gate, bob } = await scenario();
      expect(await gate.isAllowed(bob.address)).to.equal(false); // 1 < 2
      await expect(gate.requireReputation(bob.address))
        .to.be.revertedWithCustomError(gate, "InsufficientReputation")
        .withArgs(bob.address, 1n, 2n);
    });

    it("a zero-point account is refused and the error carries have=0", async function () {
      const { gate, carol } = await scenario();
      expect(await gate.isAllowed(carol.address)).to.equal(false);
      await expect(gate.requireReputation(carol.address))
        .to.be.revertedWithCustomError(gate, "InsufficientReputation")
        .withArgs(carol.address, 0n, 2n);
    });
  });

  // -------------------------------------------------------------------------------------------
  // autoHonor: the buyer pattern end-to-end — fail closed below the threshold, honor at/above it.
  // -------------------------------------------------------------------------------------------
  describe("autoHonor: fails closed below the threshold, honors at/above it", function () {
    async function scenario() {
      const ctx = await deployWithThreshold(2n);
      const { registry, sbt, deployer } = ctx;
      await commitReveal(registry, ctx.alice, h("h-a1"), "h-a1");
      await commitReveal(registry, ctx.alice, h("h-a2"), "h-a2");
      await commitReveal(registry, ctx.bob, h("h-b1"), "h-b1");
      const records = await allRecords(registry);
      await sbt.connect(deployer).mintBatch(rp.projectPoints(records).minted);
      return ctx;
    }

    it("a caller who clears the gate auto-honors: emits Honored(caller, ref) and returns true", async function () {
      const { gate, alice } = await scenario();
      const ref = h("claim-ref-1");
      expect(await gate.connect(alice).autoHonor.staticCall(ref)).to.equal(true);
      await expect(gate.connect(alice).autoHonor(ref))
        .to.emit(gate, "Honored")
        .withArgs(alice.address, ref);
    });

    it("a caller below the threshold is routed to manual review: autoHonor reverts and emits no Honored", async function () {
      const { gate, bob } = await scenario();
      const ref = h("claim-ref-2");
      await expect(gate.connect(bob).autoHonor(ref))
        .to.be.revertedWithCustomError(gate, "InsufficientReputation")
        .withArgs(bob.address, 1n, 2n);
    });
  });

  // -------------------------------------------------------------------------------------------
  // THE SOULBOUND TIE: the gate inherits the SBT's credit-to-the-record property, so a stranger cannot
  // buy their way past it. This is the property that makes reputation gating meaningful at all.
  // -------------------------------------------------------------------------------------------
  describe("soulbound tie: a stranger who pays to mint another's points cannot pass the gate", function () {
    it("carol paying gas to mint alice's record credits ALICE — alice clears the gate, carol does not", async function () {
      const { registry, sbt, gate, alice, carol } = await deployWithThreshold(1n);
      const hash = h("tie-a1");
      await commitReveal(registry, alice, hash, "tie-a1");

      // Carol (a stranger) pays for the mint. The point is credited to Alice, never Carol.
      await sbt.connect(carol).mint(hash);
      expect(await sbt.points(alice.address)).to.equal(1n);
      expect(await sbt.points(carol.address)).to.equal(0n);

      // Alice — who provably contributed — clears the gate. Carol — who only paid gas — cannot.
      expect(await gate.isAllowed(alice.address)).to.equal(true);
      expect(await gate.isAllowed(carol.address)).to.equal(false);
      await expect(gate.connect(alice).autoHonor(h("ok"))).to.emit(gate, "Honored");
      await expect(gate.connect(carol).autoHonor(h("nope")))
        .to.be.revertedWithCustomError(gate, "InsufficientReputation")
        .withArgs(carol.address, 0n, 1n);
    });
  });

  // -------------------------------------------------------------------------------------------
  // A zero threshold admits everyone (floor of zero) — including a zero-point address.
  // -------------------------------------------------------------------------------------------
  describe("a zero threshold admits everyone (a floor of zero)", function () {
    it("even a zero-point address is allowed and can auto-honor", async function () {
      const { gate, carol } = await loadFixture(deploy0);
      expect(await gate.minPoints()).to.equal(0n);
      expect(await gate.isAllowed(carol.address)).to.equal(true);
      await gate.requireReputation(carol.address); // does not revert
      await expect(gate.connect(carol).autoHonor(h("free"))).to.emit(gate, "Honored");
    });
  });

  // -------------------------------------------------------------------------------------------
  // Conformance: the gate's on-chain decision == the off-chain oracle == the SBT's own meetsThreshold.
  // -------------------------------------------------------------------------------------------
  describe("conformance: gate decision == off-chain hasAtLeast == SBT.meetsThreshold", function () {
    it("for a mixed record set, isAllowed(addr) matches the oracle and the SBT for every address", async function () {
      const threshold = 2n;
      const { registry, sbt, gate, deployer, alice, bob, carol } = await deployWithThreshold(threshold);
      // alice: 2 authorBound; bob: 1 authorBound + 1 anchorOnly; carol: anchorOnly only.
      await commitReveal(registry, alice, h("c-a1"), "c-a1");
      await commitReveal(registry, alice, h("c-a2"), "c-a2");
      await commitReveal(registry, bob, h("c-b1"), "c-b1");
      await registry.connect(bob).anchor(h("c-b2"), "c-b2");
      await registry.connect(carol).anchor(h("c-c1"), "c-c1");

      const records = await allRecords(registry);
      await sbt.connect(deployer).mintBatch(rp.projectPoints(records).minted);

      for (const who of [alice, bob, carol, deployer]) {
        const offChain = rp.hasAtLeast(records, who.address, Number(threshold));
        expect(await gate.isAllowed(who.address), `gate vs oracle for ${who.address}`).to.equal(
          offChain
        );
        expect(
          await sbt.meetsThreshold(who.address, threshold),
          `SBT vs oracle for ${who.address}`
        ).to.equal(offChain);
      }
      // Concretely: alice (2) clears a bar of 2; bob (1 authorBound; the anchorOnly is worthless) does not.
      expect(await gate.isAllowed(alice.address)).to.equal(true);
      expect(await gate.isAllowed(bob.address)).to.equal(false);
      expect(await gate.isAllowed(carol.address)).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Attack surface: holds no funds, exposes no owner/admin/transfer surface.
  // -------------------------------------------------------------------------------------------
  describe("attack surface: no funds, no owner/admin/transfer surface", function () {
    it("autoHonor is non-payable and the contract cannot receive ETH (no receive/fallback)", async function () {
      const { gate, alice, registry, sbt, deployer } = await deployWithThreshold(0n);
      // Sending value with the call reverts (non-payable), and a bare transfer bounces.
      await expect(
        alice.sendTransaction({
          to: await gate.getAddress(),
          data: gate.interface.encodeFunctionData("autoHonor", [h("x")]),
          value: 1n,
        })
      ).to.be.reverted;
      await expect(
        alice.sendTransaction({ to: await gate.getAddress(), value: 1n })
      ).to.be.reverted;
      expect(await ethers.provider.getBalance(await gate.getAddress())).to.equal(0n);
      // (deployer/registry/sbt are unused here beyond fixture wiring)
      void registry;
      void sbt;
      void deployer;
    });

    it("the ABI exposes NO owner/admin/pause/upgrade and NO transfer/approval surface", async function () {
      const { gate } = await loadFixture(deploy2);
      const bannedAdmin = /owner|admin|pause|unpause|upgrade|initialize|renounce|grant|role/i;
      const bannedXfer =
        /transfer|approve|approval|operator|allowance|permit|delegate|safeTransfer|burn|revoke/i;
      for (const f of gate.interface.fragments) {
        if (f.type !== "function") continue;
        expect(f.name, `ABI function ${f.name} must not be an owner/admin path`).to.not.match(
          bannedAdmin
        );
        expect(f.name, `ABI function ${f.name} must not be a transfer/approval path`).to.not.match(
          bannedXfer
        );
        expect(f.payable, `${f.name} must be non-payable`).to.equal(false);
      }
    });
  });
});

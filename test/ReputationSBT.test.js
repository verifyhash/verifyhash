const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");
const fs = require("fs");
const path = require("path");

const rp = require("../cli/core/reputation-points");
const { computeScore } = require("../cli/reputation");

// ---------------------------------------------------------------------------------------------
// T-3.2 — ReputationSBT: soulbound (non-transferable) contribution points.
//
// The on-chain layer specified by docs/REPUTATION-SBT-DESIGN.md (§4 acceptance handles), over the
// EPIC-12 registry substrate. What this file proves, bullet by bullet:
//   * constructor pins ONE identity-probed registry (EPIC-11 pinning rule; wrong/absent
//     REGISTRY_ID or the zero address cannot be pinned);
//   * mint against an `authorBound` record credits the RECORD's contributor REGARDLESS of caller
//     (never msg.sender); `anchorOnly` records revert; double-mint reverts; unknown/zero hash
//     reverts; batch mint has identical per-hash semantics and is atomic;
//   * every mint emits events (PointMinted + the ERC-5192-spirit Locked signal);
//   * NON-TRANSFERABILITY IS ENFORCED BY ABSENCE: the ABI exposes NO transfer/approve/operator
//     surface, NO owner/admin surface, NO payable path, and the ONLY state-mutating functions are
//     mint/mintBatch — so balances can only ever change via mint (monotonic);
//   * CONFORMANCE TO THE OFF-CHAIN ORACLE: after minting every record, on-chain `points(addr)`
//     equals cli/core/reputation-points.js `pointsOf(records, addr)` and `totalPoints` equals
//     `projectPoints(records).totalPoints`, and each balance equals the EPIC-12 derived view's
//     `authorBound` count (cli/reputation.js computeScore);
//   * DOCS-ROT GUARD: the on-chain POINT_MEANING string equals the off-chain module's export
//     byte-for-byte, the COMPILED NatSpec restates §2's honest boundary + §3's non-transferability
//     rationale, and the design doc / docs/REPUTATION.md still say what the code implements.
//
// Local hardhat only — nothing here deploys anywhere (P-2 remains the only path to a public chain).
// ---------------------------------------------------------------------------------------------

describe("ReputationSBT (T-3.2): soulbound, non-transferable contribution points", function () {
  async function deploy() {
    const [deployer, alice, bob, carol] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("ContributionRegistry");
    const registry = await Registry.deploy();
    await registry.waitForDeployment();
    const SBT = await ethers.getContractFactory("ReputationSBT");
    const sbt = await SBT.deploy(await registry.getAddress());
    await sbt.waitForDeployment();
    return { registry, sbt, SBT, deployer, alice, bob, carol };
  }

  const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

  // Compute the commitment exactly as the contract does: keccak256(abi.encode(hash, addr, salt)).
  function commitmentOf(contentHash, committer, salt) {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "bytes32"],
        [contentHash, committer, salt]
      )
    );
  }

  // Commit + reveal `contentHash` from `signer` (authorBound = true). Optional parent.
  async function commitReveal(registry, signer, contentHash, uri, parent) {
    const salt = ethers.keccak256(ethers.toUtf8Bytes("salt-" + uri));
    await registry.connect(signer).commit(commitmentOf(contentHash, signer.address, salt));
    await mine(2); // age past MIN_REVEAL_DELAY
    if (parent === undefined) {
      await registry.connect(signer).reveal(contentHash, salt, uri);
    } else {
      await registry.connect(signer).revealWithParent(contentHash, salt, uri, parent);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Constructor: pins ONE identity-probed registry, forever (EPIC-11 pinning rule).
  // -------------------------------------------------------------------------------------------
  describe("constructor pins one identity-probed registry", function () {
    it("pins the deployed registry address immutably (readable, and no setter exists)", async function () {
      const { registry, sbt } = await loadFixture(deploy);
      expect(await sbt.registry()).to.equal(await registry.getAddress());
      // No function in the ABI can change it (registry( ) is the only mention, and it is a view).
      const setters = sbt.interface.fragments.filter(
        (f) => f.type === "function" && /registry/i.test(f.name) && f.stateMutability !== "view"
      );
      expect(setters).to.deep.equal([]);
    });

    it("the compile-time EXPECTED_REGISTRY_ID equals the registry's frozen REGISTRY_ID (no drift)", async function () {
      const { registry, sbt } = await loadFixture(deploy);
      const expected = await sbt.EXPECTED_REGISTRY_ID();
      expect(expected).to.equal(await registry.REGISTRY_ID());
      // ...and both equal the documented frozen preimage hash.
      expect(expected).to.equal(h("verifyhash.ContributionRegistry.v1"));
    });

    it("REPUTATION_ID is the frozen keccak256('verifyhash.ReputationSBT.v1')", async function () {
      const { sbt } = await loadFixture(deploy);
      expect(await sbt.REPUTATION_ID()).to.equal(h("verifyhash.ReputationSBT.v1"));
      expect(await sbt.REPUTATION_ID()).to.equal(
        "0xecbbfdea57ced2f80c720d372fa881fd59bfbe31d186a8d493fb8a9177a71623"
      );
    });

    it("rejects the zero address (ZeroRegistry)", async function () {
      const { SBT } = await loadFixture(deploy);
      await expect(SBT.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        SBT,
        "ZeroRegistry"
      );
    });

    it("rejects a contract with NO registry identity marker (probe call reverts)", async function () {
      const { SBT } = await loadFixture(deploy);
      const Not = await ethers.getContractFactory("NotARegistry");
      const not = await Not.deploy();
      await not.waitForDeployment();
      await expect(SBT.deploy(await not.getAddress())).to.be.reverted;
    });

    it("rejects a contract that LIES about its registry identity (NotARegistry error)", async function () {
      const { SBT } = await loadFixture(deploy);
      const Liar = await ethers.getContractFactory("LyingRegistryId");
      const liar = await Liar.deploy();
      await liar.waitForDeployment();
      await expect(SBT.deploy(await liar.getAddress()))
        .to.be.revertedWithCustomError(SBT, "NotARegistry")
        .withArgs(await liar.getAddress());
    });

    it("rejects an EOA (no code to answer the identity probe)", async function () {
      const { SBT, alice } = await loadFixture(deploy);
      await expect(SBT.deploy(alice.address)).to.be.reverted;
    });
  });

  // -------------------------------------------------------------------------------------------
  // mint(): permissionless, credit-to-the-record, authorBound-only, once per contentHash.
  // -------------------------------------------------------------------------------------------
  describe("mint: permissionless, credits the RECORD's contributor (never msg.sender)", function () {
    it("an authorBound record credits its contributor REGARDLESS of who calls mint", async function () {
      const { registry, sbt, alice, carol } = await loadFixture(deploy);
      const hash = h("alice-authorbound");
      await commitReveal(registry, alice, hash, "ipfs://a");

      // Carol (a stranger/keeper) pays for the mint; Alice is credited. Carol gets NOTHING.
      const returned = await sbt.connect(carol).mint.staticCall(hash);
      expect(returned).to.equal(alice.address);
      await sbt.connect(carol).mint(hash);

      expect(await sbt.points(alice.address)).to.equal(1n);
      expect(await sbt.points(carol.address)).to.equal(0n);
      expect(await sbt.minted(hash)).to.equal(true);
      expect(await sbt.totalPoints()).to.equal(1n);
    });

    it("the contributor themself may also mint (permissionless includes the holder)", async function () {
      const { registry, sbt, alice } = await loadFixture(deploy);
      const hash = h("alice-self-mint");
      await commitReveal(registry, alice, hash, "ipfs://self");
      await sbt.connect(alice).mint(hash);
      expect(await sbt.points(alice.address)).to.equal(1n);
    });

    it("emits PointMinted(contributor, contentHash, newBalance, newTotal) and the ERC-5192-spirit Locked signal on every mint", async function () {
      const { registry, sbt, alice, bob } = await loadFixture(deploy);
      const h1 = h("evt-1");
      const h2 = h("evt-2");
      await commitReveal(registry, alice, h1, "ipfs://e1");
      await commitReveal(registry, alice, h2, "ipfs://e2");

      await expect(sbt.connect(bob).mint(h1))
        .to.emit(sbt, "PointMinted")
        .withArgs(alice.address, h1, 1n, 1n)
        .and.to.emit(sbt, "Locked")
        .withArgs(h1);
      await expect(sbt.connect(bob).mint(h2))
        .to.emit(sbt, "PointMinted")
        .withArgs(alice.address, h2, 2n, 2n)
        .and.to.emit(sbt, "Locked")
        .withArgs(h2);
    });

    it("an anchorOnly record (authorBound == false) reverts NotAuthorBound and mints nothing, ever", async function () {
      const { registry, sbt, alice, bob } = await loadFixture(deploy);
      const hash = h("anchor-only");
      await registry.connect(alice).anchor(hash, "ipfs://anchor-only");

      await expect(sbt.connect(bob).mint(hash))
        .to.be.revertedWithCustomError(sbt, "NotAuthorBound")
        .withArgs(hash);
      // ...even when the anchorer themself asks.
      await expect(sbt.connect(alice).mint(hash))
        .to.be.revertedWithCustomError(sbt, "NotAuthorBound")
        .withArgs(hash);
      expect(await sbt.points(alice.address)).to.equal(0n);
      expect(await sbt.minted(hash)).to.equal(false);
      expect(await sbt.totalPoints()).to.equal(0n);
    });

    it("double-mint reverts AlreadyMinted (also from a different caller)", async function () {
      const { registry, sbt, alice, bob, carol } = await loadFixture(deploy);
      const hash = h("double-mint");
      await commitReveal(registry, alice, hash, "ipfs://d");
      await sbt.connect(bob).mint(hash);

      await expect(sbt.connect(bob).mint(hash))
        .to.be.revertedWithCustomError(sbt, "AlreadyMinted")
        .withArgs(hash);
      await expect(sbt.connect(carol).mint(hash))
        .to.be.revertedWithCustomError(sbt, "AlreadyMinted")
        .withArgs(hash);
      // The balance did not move: one point per contentHash, globally, forever.
      expect(await sbt.points(alice.address)).to.equal(1n);
      expect(await sbt.totalPoints()).to.equal(1n);
    });

    it("an unknown hash reverts with the registry's own NotAnchored (a point with no backing record is unmintable)", async function () {
      const { registry, sbt, bob } = await loadFixture(deploy);
      const unknown = h("never-anchored");
      await expect(sbt.connect(bob).mint(unknown))
        .to.be.revertedWithCustomError(registry, "NotAnchored")
        .withArgs(unknown);
    });

    it("the zero hash reverts too (unanchorable upstream, unmintable here)", async function () {
      const { registry, sbt, bob } = await loadFixture(deploy);
      await expect(sbt.connect(bob).mint(ethers.ZeroHash))
        .to.be.revertedWithCustomError(registry, "NotAnchored")
        .withArgs(ethers.ZeroHash);
    });

    it("an authorBound record written via revealWithParent mints exactly like a plain reveal", async function () {
      const { registry, sbt, alice, bob } = await loadFixture(deploy);
      const root = h("parent-root");
      await registry.connect(alice).anchor(root, "ipfs://root");
      const child = h("parent-child");
      await commitReveal(registry, alice, child, "child", root);

      await sbt.connect(bob).mint(child);
      expect(await sbt.points(alice.address)).to.equal(1n);
      // The parent root itself is anchorOnly and still refuses to mint.
      await expect(sbt.mint(root)).to.be.revertedWithCustomError(sbt, "NotAuthorBound");
    });

    it("mint is non-payable: the contract never holds funds", async function () {
      const { registry, sbt, alice } = await loadFixture(deploy);
      const hash = h("no-funds");
      await commitReveal(registry, alice, hash, "ipfs://nf");
      await expect(
        alice.sendTransaction({
          to: await sbt.getAddress(),
          data: sbt.interface.encodeFunctionData("mint", [hash]),
          value: 1n,
        })
      ).to.be.reverted;
      // ...and plain ETH transfers bounce as well (no receive/fallback).
      await expect(
        alice.sendTransaction({ to: await sbt.getAddress(), value: 1n })
      ).to.be.reverted;
      expect(await ethers.provider.getBalance(await sbt.getAddress())).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------------------------
  // mintBatch(): identical per-hash semantics, atomic, bounded by the caller's own calldata.
  // -------------------------------------------------------------------------------------------
  describe("mintBatch: identical per-hash semantics, atomic", function () {
    it("mints many hashes across contributors in one tx, crediting each record's own contributor", async function () {
      const { registry, sbt, alice, bob, carol } = await loadFixture(deploy);
      const a1 = h("batch-a1");
      const a2 = h("batch-a2");
      const b1 = h("batch-b1");
      await commitReveal(registry, alice, a1, "a1");
      await commitReveal(registry, alice, a2, "a2");
      await commitReveal(registry, bob, b1, "b1");

      // Carol the keeper pays; Alice and Bob are credited.
      const returned = await sbt.connect(carol).mintBatch.staticCall([a1, b1, a2]);
      expect(returned).to.deep.equal([alice.address, bob.address, alice.address]);
      await expect(sbt.connect(carol).mintBatch([a1, b1, a2]))
        .to.emit(sbt, "PointMinted")
        .withArgs(alice.address, a1, 1n, 1n)
        .and.to.emit(sbt, "PointMinted")
        .withArgs(bob.address, b1, 1n, 2n)
        .and.to.emit(sbt, "PointMinted")
        .withArgs(alice.address, a2, 2n, 3n);

      expect(await sbt.points(alice.address)).to.equal(2n);
      expect(await sbt.points(bob.address)).to.equal(1n);
      expect(await sbt.points(carol.address)).to.equal(0n);
      expect(await sbt.totalPoints()).to.equal(3n);
    });

    it("ATOMIC: one bad hash (anchorOnly) reverts the whole batch and no state changes", async function () {
      const { registry, sbt, alice, bob } = await loadFixture(deploy);
      const good = h("batch-good");
      const bad = h("batch-bad-anchoronly");
      await commitReveal(registry, alice, good, "good");
      await registry.connect(alice).anchor(bad, "bad");

      await expect(sbt.connect(bob).mintBatch([good, bad]))
        .to.be.revertedWithCustomError(sbt, "NotAuthorBound")
        .withArgs(bad);
      expect(await sbt.points(alice.address)).to.equal(0n);
      expect(await sbt.minted(good)).to.equal(false);
      expect(await sbt.totalPoints()).to.equal(0n);
    });

    it("ATOMIC: a duplicate hash WITHIN the same batch reverts AlreadyMinted (one point per contentHash)", async function () {
      const { registry, sbt, alice, bob } = await loadFixture(deploy);
      const hash = h("batch-dupe");
      await commitReveal(registry, alice, hash, "dupe");
      await expect(sbt.connect(bob).mintBatch([hash, hash]))
        .to.be.revertedWithCustomError(sbt, "AlreadyMinted")
        .withArgs(hash);
      expect(await sbt.totalPoints()).to.equal(0n);
    });

    it("an empty batch is a harmless no-op", async function () {
      const { sbt, bob } = await loadFixture(deploy);
      await sbt.connect(bob).mintBatch([]);
      expect(await sbt.totalPoints()).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Soulbound: non-transferability enforced by ABSENCE (design doc §3, made mechanical).
  // -------------------------------------------------------------------------------------------
  describe("non-transferable by ABSENCE: no transfer/approval/owner surface exists at all", function () {
    it("the ABI exposes NO transfer, approval, or operator function (absent, not merely reverting)", async function () {
      const { sbt } = await loadFixture(deploy);
      const banned =
        /transfer|approve|approval|operator|allowance|permit|delegate|safeTransfer|burn|revoke/i;
      for (const f of sbt.interface.fragments) {
        if (f.type !== "function") continue;
        expect(f.name, `ABI function ${f.name} must not be a transfer/approval path`).to.not.match(
          banned
        );
      }
      // Nor the ERC-20/721 Transfer/Approval EVENTS a marketplace/wallet would treat as inventory.
      for (const f of sbt.interface.fragments) {
        if (f.type !== "event") continue;
        expect(f.name, `ABI event ${f.name}`).to.not.match(/^(Transfer|Approval|ApprovalForAll)$/);
      }
    });

    it("the ABI exposes NO owner/admin/pause/upgrade surface (ownerless like the registry)", async function () {
      const { sbt } = await loadFixture(deploy);
      const banned = /owner|admin|pause|unpause|upgrade|initialize|renounce|grant|role/i;
      for (const f of sbt.interface.fragments) {
        if (f.type !== "function") continue;
        expect(f.name, `ABI function ${f.name} must not be an owner/admin path`).to.not.match(
          banned
        );
      }
    });

    it("the ONLY state-mutating functions are mint and mintBatch — balances can only ever change via mint", async function () {
      const { sbt } = await loadFixture(deploy);
      const mutating = sbt.interface.fragments
        .filter(
          (f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)
        )
        .map((f) => f.name)
        .sort();
      expect(mutating).to.deep.equal(["mint", "mintBatch"]);
      // ...and neither is payable; the contract cannot even receive funds through them.
      for (const f of sbt.interface.fragments) {
        if (f.type !== "function") continue;
        expect(f.payable, `${f.name} must be non-payable`).to.equal(false);
      }
    });

    it("balances are MONOTONIC: minting for one address never lowers any other balance", async function () {
      const { registry, sbt, alice, bob, carol } = await loadFixture(deploy);
      const a1 = h("mono-a1");
      const b1 = h("mono-b1");
      await commitReveal(registry, alice, a1, "ma1");
      await commitReveal(registry, bob, b1, "mb1");

      await sbt.connect(carol).mint(a1);
      const aliceBefore = await sbt.points(alice.address);
      await sbt.connect(carol).mint(b1);
      // Bob gaining a point moved nobody else's balance.
      expect(await sbt.points(alice.address)).to.equal(aliceBefore);
      expect(await sbt.points(bob.address)).to.equal(1n);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Conformance to the off-chain oracle (design doc §4, the load-bearing acceptance bullet):
  // points(addr) == pointsOf(records, addr); totalPoints == projectPoints(records).totalPoints;
  // and each balance equals the EPIC-12 derived view's authorBound count.
  // -------------------------------------------------------------------------------------------
  describe("conformance: on-chain balances == cli/core/reputation-points.js == EPIC-12 derived view", function () {
    // A mixed scenario across three addresses and all four registry write paths.
    async function mixedScenario() {
      const ctx = await loadFixture(deploy);
      const { registry, alice, bob, carol } = ctx;

      // alice: 2 authorBound (one with a parent edge) + 1 anchorOnly.
      await commitReveal(registry, alice, h("mx-a-r1"), "a-r1");
      await registry.connect(alice).anchor(h("mx-a-p1"), "a-p1");
      await commitReveal(registry, alice, h("mx-a-r2"), "a-r2", h("mx-a-p1"));
      // bob: 1 authorBound + 2 anchorOnly (one with a parent edge).
      await registry.connect(bob).anchor(h("mx-b-p1"), "b-p1");
      await commitReveal(registry, bob, h("mx-b-r1"), "b-r1");
      await registry.connect(bob).anchorWithParent(h("mx-b-p2"), "b-p2", h("mx-b-p1"));
      // carol: anchorOnly ONLY — provably zero points.
      await registry.connect(carol).anchor(h("mx-c-p1"), "c-p1");

      return ctx;
    }

    // Page every record out of the registry the way an off-chain consumer would, shaped for the
    // pure projection module.
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
            parent: records[i].parent,
            blockNumber: records[i].blockNumber,
            timestamp: records[i].timestamp,
            uri: records[i].uri,
          });
        }
        if (BigInt(hashes.length) < page) break;
      }
      return out;
    }

    it("after minting every authorBound record, points(addr) equals the oracle's pointsOf for every address", async function () {
      const { registry, sbt, deployer, alice, bob, carol } = await mixedScenario();
      const records = await allRecords(registry);

      // Mint EVERY record the oracle says mints (the keeper flow), in one batch.
      const mintable = rp.projectPoints(records).minted;
      expect(mintable.length).to.be.greaterThan(0);
      await sbt.connect(deployer).mintBatch(mintable);

      for (const who of [alice, bob, carol, deployer]) {
        expect(
          await sbt.points(who.address),
          `points(${who.address}) must equal the off-chain oracle`
        ).to.equal(BigInt(rp.pointsOf(records, who.address)));
      }
      // Concretely: alice 2, bob 1, carol 0 — carol's anchorOnly activity is worth nothing here.
      expect(await sbt.points(alice.address)).to.equal(2n);
      expect(await sbt.points(bob.address)).to.equal(1n);
      expect(await sbt.points(carol.address)).to.equal(0n);
    });

    it("totalPoints equals the oracle's projectPoints(records).totalPoints", async function () {
      const { registry, sbt, deployer } = await mixedScenario();
      const records = await allRecords(registry);
      const projection = rp.projectPoints(records);

      await sbt.connect(deployer).mintBatch(projection.minted);
      expect(await sbt.totalPoints()).to.equal(BigInt(projection.totalPoints));
      // And the oracle's per-point credit list matches what the chain minted.
      for (const { contentHash } of projection.credited) {
        expect(await sbt.minted(contentHash)).to.equal(true);
      }
    });

    it("each balance equals the EPIC-12 derived view's authorBound count (computeScore), per contributor", async function () {
      const { registry, sbt, deployer, alice, bob, carol } = await mixedScenario();
      const records = await allRecords(registry);
      await sbt.connect(deployer).mintBatch(rp.projectPoints(records).minted);

      for (const who of [alice, bob, carol]) {
        const [, theirRecords] = await registry.getRecordsByContributor(who.address, 0, 1000);
        const score = computeScore(
          theirRecords.map((r) => ({
            authorBound: r.authorBound,
            parent: r.parent,
            blockNumber: r.blockNumber,
            timestamp: r.timestamp,
          }))
        );
        expect(
          await sbt.points(who.address),
          `points(${who.address}) must equal the derived view's authorBound count`
        ).to.equal(BigInt(score.authorBound));
      }
    });

    it("hasAtLeast (the composable consumer gate) agrees with the on-chain balances", async function () {
      const { registry, sbt, deployer, alice, carol } = await mixedScenario();
      const records = await allRecords(registry);
      await sbt.connect(deployer).mintBatch(rp.projectPoints(records).minted);

      // The exact predicate a consumer contract would apply on-chain (points >= n), mirrored off-chain.
      expect(rp.hasAtLeast(records, alice.address, 2)).to.equal(
        (await sbt.points(alice.address)) >= 2n
      );
      expect(rp.hasAtLeast(records, carol.address, 1)).to.equal(
        (await sbt.points(carol.address)) >= 1n
      );
    });

    it("points can LAG the registry (unminted records) but never exceed the authorBound count", async function () {
      const { registry, sbt, alice, bob } = await mixedScenario();
      // Mint only ONE of alice's two authorBound records: the balance lags but never exceeds.
      await sbt.connect(bob).mint(h("mx-a-r1"));
      const records = await allRecords(registry);
      const onChain = await sbt.points(alice.address);
      expect(onChain).to.equal(1n); // lagging: the second record's mint is unpaid-for
      expect(onChain <= BigInt(rp.pointsOf(records, alice.address))).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------------------------
  // On-chain composable gate: meetsThreshold — the design §5 buyer predicate, made real on-chain and
  // pinned to the off-chain oracle's hasAtLeast so the two gates can never diverge. This is the
  // difference between the layer EXPOSING a raw count (which every consumer must re-compare) and
  // DELIVERING the composable decision once, so contracts/ReputationGate.sol can branch in O(1).
  // -------------------------------------------------------------------------------------------
  describe("meetsThreshold: the on-chain composable gate mirrors off-chain hasAtLeast", function () {
    // Page every record out of the registry, shaped for the pure projection module.
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

    it("a zero threshold admits everyone — even an address with no points (floor of zero)", async function () {
      const { sbt, alice } = await loadFixture(deploy);
      expect(await sbt.points(alice.address)).to.equal(0n);
      expect(await sbt.meetsThreshold(alice.address, 0n)).to.equal(true);
      // ...but any positive bar refuses a zero-point address.
      expect(await sbt.meetsThreshold(alice.address, 1n)).to.equal(false);
    });

    it("is INCLUSIVE at the boundary and tracks points as they are minted", async function () {
      const { registry, sbt, alice, bob } = await loadFixture(deploy);
      const a1 = h("mt-a1");
      const a2 = h("mt-a2");
      await commitReveal(registry, alice, a1, "mt-a1");
      await commitReveal(registry, alice, a2, "mt-a2");
      // Before minting: alice is still at zero on-chain (points lag until someone pays gas).
      expect(await sbt.meetsThreshold(alice.address, 1n)).to.equal(false);
      await sbt.connect(bob).mint(a1);
      expect(await sbt.meetsThreshold(alice.address, 1n)).to.equal(true); // inclusive: 1 >= 1
      expect(await sbt.meetsThreshold(alice.address, 2n)).to.equal(false);
      await sbt.connect(bob).mint(a2);
      expect(await sbt.meetsThreshold(alice.address, 2n)).to.equal(true);
    });

    it("is a read-only view (cannot change a balance; adds no mutating surface)", async function () {
      const { sbt } = await loadFixture(deploy);
      const frag = sbt.interface.getFunction("meetsThreshold");
      expect(frag.stateMutability).to.equal("view");
      expect(frag.payable).to.equal(false);
    });

    it("CONFORMANCE: on-chain meetsThreshold equals off-chain hasAtLeast for every address across a range of thresholds", async function () {
      const ctx = await loadFixture(deploy);
      const { registry, sbt, deployer, alice, bob, carol } = ctx;
      // alice: 2 authorBound; bob: 1 authorBound; carol: anchorOnly only (0 points).
      await commitReveal(registry, alice, h("g-a1"), "g-a1");
      await commitReveal(registry, alice, h("g-a2"), "g-a2");
      await commitReveal(registry, bob, h("g-b1"), "g-b1");
      await registry.connect(carol).anchor(h("g-c1"), "g-c1");

      const records = await allRecords(registry);
      await sbt.connect(deployer).mintBatch(rp.projectPoints(records).minted);

      for (const who of [alice, bob, carol, deployer]) {
        for (const n of [0, 1, 2, 3]) {
          expect(
            await sbt.meetsThreshold(who.address, n),
            `meetsThreshold(${who.address}, ${n}) must equal off-chain hasAtLeast`
          ).to.equal(rp.hasAtLeast(records, who.address, n));
        }
      }
      // Concretely: alice clears a bar of 2, bob does not; carol clears only a bar of 0.
      expect(await sbt.meetsThreshold(alice.address, 2n)).to.equal(true);
      expect(await sbt.meetsThreshold(bob.address, 2n)).to.equal(false);
      expect(await sbt.meetsThreshold(carol.address, 1n)).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Docs-rot guard: the honest boundary lives in ONE place and every surface restates it.
  // -------------------------------------------------------------------------------------------
  describe("docs-rot guard: NatSpec, POINT_MEANING, design doc and REPUTATION.md stay consistent", function () {
    const readDoc = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

    // Pull the compiled NatSpec for ReputationSBT out of the newest build-info that carries it
    // (same discipline as test/TrustBoundaries.test.js: prove the DOCUMENTATION solc compiled, not
    // merely source comments).
    function loadCompiledDoc() {
      const dir = path.join(__dirname, "..", "artifacts", "build-info");
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      const KEY = "contracts/ReputationSBT.sol";
      for (const { f } of files) {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (parsed.output && parsed.output.contracts && parsed.output.contracts[KEY]) {
          const out = parsed.output.contracts[KEY]["ReputationSBT"];
          if (!out.devdoc || !out.userdoc) {
            throw new Error("compiled devdoc/userdoc missing for ReputationSBT");
          }
          return { devdoc: out.devdoc, userdoc: out.userdoc };
        }
      }
      throw new Error("no build-info contains ReputationSBT; run `npx hardhat compile`");
    }

    function allDocText(doc) {
      const parts = [];
      const visit = (v) => {
        if (v == null) return;
        if (typeof v === "string") parts.push(v);
        else if (Array.isArray(v)) v.forEach(visit);
        else if (typeof v === "object") Object.values(v).forEach(visit);
      };
      visit(doc.devdoc);
      visit(doc.userdoc);
      return parts.join("\n").toLowerCase();
    }

    it("the on-chain POINT_MEANING equals the off-chain module's export byte-for-byte (the single source)", async function () {
      const { sbt } = await loadFixture(deploy);
      expect(await sbt.POINT_MEANING()).to.equal(rp.POINT_MEANING);
    });

    it("the COMPILED NatSpec restates §2's honest boundary (activity floor, not merit, not sybil-proof)", function () {
      const text = allDocText(loadCompiledDoc());
      expect(text).to.match(/floor of verifiable activity/);
      expect(text).to.match(/never a proof of merit/);
      expect(text).to.match(/do not make raw point counts sybil-proof/);
      expect(text, "must direct load-bearing consumers to the backing records").to.match(
        /inspecting the backing records|inspect the backing records/
      );
    });

    it("the COMPILED NatSpec restates §3's non-transferability rationale (enforced by absence)", function () {
      const text = allDocText(loadCompiledDoc());
      expect(text).to.match(/a transferred attestation is a lie/);
      expect(text).to.match(/enforced by absence/);
      expect(text).to.match(/no transfer, approval, or operator surface/);
      expect(text, "credit goes to the record, never the caller").to.match(
        /never[\s\S]{0,10}(to\s+)?`?msg\.sender`?|never the caller/
      );
    });

    it("the design doc's §4 acceptance handles name exactly the surface the contract ships", function () {
      const design = readDoc("docs/REPUTATION-SBT-DESIGN.md");
      const source = readDoc("contracts/ReputationSBT.sol");
      expect(design).to.include("contracts/ReputationSBT.sol");
      for (const handle of ["mint(contentHash)", "points(address)", "minted(bytes32)", "totalPoints"]) {
        expect(design, `design doc names ${handle}`).to.include(handle);
      }
      // ...and the contract really exposes them (source-level pin; the ABI tests prove behavior).
      for (const decl of [
        "function mint(bytes32 contentHash)",
        "function mintBatch(bytes32[] calldata contentHashes)",
        "mapping(address => uint256) public points",
        "mapping(bytes32 => bool) public minted",
        "uint256 public totalPoints",
      ]) {
        expect(source, `contract declares ${decl}`).to.include(decl);
      }
    });

    it("docs/REPUTATION.md's derived view stays canonical and its meaningful signal is still the authorBound count", function () {
      const reputation = readDoc("docs/REPUTATION.md");
      expect(reputation.toLowerCase()).to.match(
        /meaningful signal is the `?authorbound`? \(commit-reveal\) count|meaningful signal is the `?authorbound`? count/
      );
      // The design doc keeps the derived view canonical over this layer (registry records authoritative).
      const design = readDoc("docs/REPUTATION-SBT-DESIGN.md");
      expect(design).to.match(/Derived view stays canonical/i);
      expect(design).to.match(/registry.s records[\s\S]{0,80}authoritative/i);
    });
  });
});

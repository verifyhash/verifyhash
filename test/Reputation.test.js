const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");

// ---------------------------------------------------------------------------------------------
// T-12.1 — bounded, ownerless per-contributor index + paginated read.
//
// So an off-chain reputation/scoring consumer can enumerate ONE address's records in
// O(that contributor's own records) instead of scanning all N, the shared writer `_record` appends
// each new record's GLOBAL insertion index to a per-contributor index (append-only, insertion order
// preserved) and bumps a per-contributor counter — for BOTH the legacy `anchor`/`reveal` (no-parent)
// and the `*WithParent` paths, via the SAME shared writer (no per-path special-casing).
//
// New ownerless `view` reads:
//   * contributorRecordCount(address)           -> uint256
//   * getRecordsByContributor(addr, start, count) -> (bytes32[] contentHashes, Record[] records)
// with the SAME clamped/forgiving pagination as getRecords (start past the end -> empty; over-long
// count -> only what exists; never reverts on an out-of-range tail; loop bounded by `count`).
//
// SAFETY this file pins:
//   * purely ADDITIVE: existing events / _records layout / attribution unchanged by the new index;
//   * grouping by contributor is a RAW ENUMERATION — an authorBound==false anchor() record under an
//     address is still only "first anchorer", NOT proven authorship.
// ---------------------------------------------------------------------------------------------

describe("Reputation — per-contributor index + paginated read (T-12.1)", function () {
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

  const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

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

  // ---------------------------------------------------------------------------------------------
  // The acceptance scenario, exactly: A anchors 2 (one plain anchor, one commit-reveal so
  // authorBound differs) and B anchors 1.
  // ---------------------------------------------------------------------------------------------
  describe("acceptance scenario (A=2 mixed, B=1)", function () {
    // A's record 0: plain anchor (authorBound=false). A's record 1: commit-reveal (authorBound=true).
    // B's single record: plain anchor.
    async function scenario() {
      const ctx = await loadFixture(deploy);
      const { registry, alice, bob } = ctx;

      const aPlain = h("A-plain-anchor");
      const aReveal = h("A-commit-reveal");
      const bPlain = h("B-plain-anchor");

      await registry.connect(alice).anchor(aPlain, "ipfs://a-plain"); // global index 0
      await commitReveal(registry, alice, aReveal, "ipfs://a-reveal"); // global index 1
      await registry.connect(bob).anchor(bPlain, "ipfs://b-plain"); // global index 2

      return { ...ctx, aPlain, aReveal, bPlain };
    }

    it("contributorRecordCount: A==2, B==1, unknown==0", async function () {
      const { registry, alice, bob, carol } = await scenario();
      expect(await registry.contributorRecordCount(alice.address)).to.equal(2n);
      expect(await registry.contributorRecordCount(bob.address)).to.equal(1n);
      // carol never wrote anything; an unknown address is 0, not a revert.
      expect(await registry.contributorRecordCount(carol.address)).to.equal(0n);
      expect(await registry.contributorRecordCount(ethers.ZeroAddress)).to.equal(0n);
      // Sanity: total is unaffected — the index is side state.
      expect(await registry.total()).to.equal(3n);
    });

    it("getRecordsByContributor(A,0,10) returns A's two records in insertion order with correct authorBound/parent, and NONE of B's", async function () {
      const { registry, alice, aPlain, aReveal, bPlain } = await scenario();

      const [hashes, records] = await registry.getRecordsByContributor(alice.address, 0, 10);
      expect(hashes.length).to.equal(2);
      expect(records.length).to.equal(2);

      // Insertion order: aPlain (anchor) then aReveal (reveal).
      expect(hashes[0]).to.equal(aPlain);
      expect(records[0].contributor).to.equal(alice.address);
      expect(records[0].authorBound).to.equal(false); // plain anchor -> first anchorer only
      expect(records[0].uri).to.equal("ipfs://a-plain");
      expect(records[0].parent).to.equal(ethers.ZeroHash);

      expect(hashes[1]).to.equal(aReveal);
      expect(records[1].contributor).to.equal(alice.address);
      expect(records[1].authorBound).to.equal(true); // commit-reveal -> proven first claimant
      expect(records[1].uri).to.equal("ipfs://a-reveal");
      expect(records[1].parent).to.equal(ethers.ZeroHash);

      // None of B's records leak into A's page.
      for (const hh of hashes) {
        expect(hh).to.not.equal(bPlain);
      }

      // And B's own page returns exactly B's one record.
      const [bHashes, bRecords] = await registry.getRecordsByContributor(
        (await ethers.getSigners())[2].address, // bob
        0,
        10
      );
      expect(bHashes.length).to.equal(1);
      expect(bHashes[0]).to.equal(bPlain);
      expect(bRecords[0].authorBound).to.equal(false);
    });

    it("each returned record matches the canonical getRecord(hash) (no attribution/content drift)", async function () {
      const { registry, alice } = await scenario();
      const [hashes, records] = await registry.getRecordsByContributor(alice.address, 0, 10);
      for (let i = 0; i < hashes.length; i++) {
        const canonical = await registry.getRecord(hashes[i]);
        expect(records[i].contributor).to.equal(canonical.contributor);
        expect(records[i].authorBound).to.equal(canonical.authorBound);
        expect(records[i].uri).to.equal(canonical.uri);
        expect(records[i].timestamp).to.equal(canonical.timestamp);
        expect(records[i].blockNumber).to.equal(canonical.blockNumber);
        expect(records[i].parent).to.equal(canonical.parent);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Pagination must be forgiving and clamped, identical to getRecords.
  // ---------------------------------------------------------------------------------------------
  describe("forgiving / clamped pagination (never reverts on an out-of-range tail)", function () {
    // Anchor `n` plain records from one signer.
    async function anchorN(registry, signer, n, tag) {
      const hashes = [];
      for (let i = 0; i < n; i++) {
        const hh = h(tag + "-" + i);
        await registry.connect(signer).anchor(hh, "ipfs://" + tag + "-" + i);
        hashes.push(hh);
      }
      return hashes;
    }

    it("start == count returns the whole contributor sequence in order", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const hashes = await anchorN(registry, alice, 5, "a");
      const [got] = await registry.getRecordsByContributor(alice.address, 0, 5);
      expect(got.length).to.equal(5);
      for (let i = 0; i < 5; i++) expect(got[i]).to.equal(hashes[i]);
    });

    it("walking fixed-size pages reproduces the contributor's whole sequence", async function () {
      const { registry, alice, bob } = await loadFixture(deploy);
      // Interleave B's writes between A's to prove the index skips foreign records.
      const aHashes = [];
      for (let i = 0; i < 7; i++) {
        const ha = h("a-" + i);
        await registry.connect(alice).anchor(ha, "ipfs://a-" + i);
        aHashes.push(ha);
        // an unrelated B write in between every A write
        await registry.connect(bob).anchor(h("b-" + i), "ipfs://b-" + i);
      }

      expect(await registry.contributorRecordCount(alice.address)).to.equal(7n);

      const page = 3;
      const seen = [];
      for (let start = 0; start < 7; start += page) {
        const [hashes] = await registry.getRecordsByContributor(alice.address, start, page);
        for (const hh of hashes) seen.push(hh);
      }
      expect(seen).to.deep.equal(aHashes);
    });

    it("CLAMP: start >= count returns empty arrays (no revert)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      await anchorN(registry, alice, 3, "a");

      // start exactly at the contributor's count
      let [hashes, records] = await registry.getRecordsByContributor(alice.address, 3, 10);
      expect(hashes.length).to.equal(0);
      expect(records.length).to.equal(0);

      // start well past the count
      [hashes, records] = await registry.getRecordsByContributor(alice.address, 1000, 10);
      expect(hashes.length).to.equal(0);
      expect(records.length).to.equal(0);
    });

    it("CLAMP: over-long count returns only the tail that exists (no revert)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const hashes = await anchorN(registry, alice, 4, "a");
      // window [2, 2+100) -> only this contributor's indices 2,3 exist; clamps to 2.
      const [got] = await registry.getRecordsByContributor(alice.address, 2, 100);
      expect(got.length).to.equal(2);
      expect(got[0]).to.equal(hashes[2]);
      expect(got[1]).to.equal(hashes[3]);
    });

    it("CLAMP: count == 0 returns empty arrays (no revert)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      await anchorN(registry, alice, 3, "a");
      const [hashes, records] = await registry.getRecordsByContributor(alice.address, 0, 0);
      expect(hashes.length).to.equal(0);
      expect(records.length).to.equal(0);
    });

    it("CLAMP: an unknown contributor returns empty arrays for any window (no revert)", async function () {
      const { registry, carol } = await loadFixture(deploy);
      const [hashes, records] = await registry.getRecordsByContributor(carol.address, 0, 50);
      expect(hashes.length).to.equal(0);
      expect(records.length).to.equal(0);
      // and a non-zero start on an unknown address is still empty, not a revert.
      const [h2, r2] = await registry.getRecordsByContributor(carol.address, 5, 50);
      expect(h2.length).to.equal(0);
      expect(r2.length).to.equal(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Every write path is indexed identically by the SAME shared writer — including *WithParent.
  // ---------------------------------------------------------------------------------------------
  describe("all write paths covered by the same shared writer", function () {
    it("anchorWithParent is indexed under its writer exactly like a no-parent anchor", async function () {
      const { registry, alice } = await loadFixture(deploy);

      // root (no parent) then a child via anchorWithParent — both by alice.
      const root = h("wp-root");
      await registry.connect(alice).anchor(root, "ipfs://wp-root");
      const child = h("wp-child");
      await registry.connect(alice).anchorWithParent(child, "ipfs://wp-child", root);

      expect(await registry.contributorRecordCount(alice.address)).to.equal(2n);
      const [hashes, records] = await registry.getRecordsByContributor(alice.address, 0, 10);
      expect(hashes).to.deep.equal([root, child]);
      // the *WithParent record carries its parent edge, indexed just like any other write.
      expect(records[0].parent).to.equal(ethers.ZeroHash);
      expect(records[1].parent).to.equal(root);
      expect(records[1].authorBound).to.equal(false);
    });

    it("revealWithParent is indexed under its writer exactly like a no-parent reveal", async function () {
      const { registry, alice } = await loadFixture(deploy);

      // root via plain anchor, then a child via revealWithParent (authorBound=true) — both by alice.
      const root = h("rp-root");
      await registry.connect(alice).anchor(root, "ipfs://rp-root");
      const child = h("rp-child");
      await commitReveal(registry, alice, child, "rp-child", root);

      expect(await registry.contributorRecordCount(alice.address)).to.equal(2n);
      const [hashes, records] = await registry.getRecordsByContributor(alice.address, 0, 10);
      expect(hashes).to.deep.equal([root, child]);
      expect(records[1].parent).to.equal(root);
      expect(records[1].authorBound).to.equal(true); // commit-reveal -> bound
    });

    it("a contributor mixing all four write paths is indexed in exact insertion order", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const a0 = h("mix-anchor"); // anchor
      const a1 = h("mix-reveal"); // reveal
      const a2 = h("mix-anchor-parent"); // anchorWithParent (parent a0)
      const a3 = h("mix-reveal-parent"); // revealWithParent (parent a1)

      await registry.connect(alice).anchor(a0, "u0");
      await commitReveal(registry, alice, a1, "u1");
      await registry.connect(alice).anchorWithParent(a2, "u2", a0);
      await commitReveal(registry, alice, a3, "u3", a1);

      expect(await registry.contributorRecordCount(alice.address)).to.equal(4n);
      const [hashes, records] = await registry.getRecordsByContributor(alice.address, 0, 10);
      expect(hashes).to.deep.equal([a0, a1, a2, a3]);
      expect(records.map((r) => r.authorBound)).to.deep.equal([false, true, false, true]);
      expect(records.map((r) => r.parent)).to.deep.equal([
        ethers.ZeroHash,
        ethers.ZeroHash,
        a0,
        a1,
      ]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Additive & ownerless: no new write path, no state mutation, existing reads/events unchanged.
  // ---------------------------------------------------------------------------------------------
  describe("additive, ownerless, read-only side state", function () {
    it("the new reads are view: they execute via eth_call without mutating state", async function () {
      const { registry, alice } = await loadFixture(deploy);
      await registry.connect(alice).anchor(h("v0"), "u0");
      await registry.connect(alice).anchor(h("v1"), "u1");

      const before = await registry.total();
      await registry.contributorRecordCount.staticCall(alice.address);
      await registry.getRecordsByContributor.staticCall(alice.address, 0, 10);
      expect(await registry.total()).to.equal(before);
    });

    it("the per-contributor count always equals the returned array length (invariant)", async function () {
      const { registry, alice, bob } = await loadFixture(deploy);
      await registry.connect(alice).anchor(h("c0"), "u0");
      await registry.connect(alice).anchor(h("c1"), "u1");
      await registry.connect(bob).anchor(h("c2"), "u2");

      for (const s of [alice, bob]) {
        const count = await registry.contributorRecordCount(s.address);
        const [hashes] = await registry.getRecordsByContributor(s.address, 0, 1000);
        expect(BigInt(hashes.length)).to.equal(count);
      }
    });

    it("the new index does not change existing events or attribution (Anchored unchanged)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const ha = h("evt");
      // The legacy Anchored event still fires with the same args; the index is invisible to it.
      await expect(registry.connect(alice).anchor(ha, "ipfs://evt"))
        .to.emit(registry, "Anchored")
        .withArgs(ha, alice.address, 0, anyTimestamp(), "ipfs://evt");
      // canonical record still reads back identically.
      const rec = await registry.getRecord(ha);
      expect(rec.contributor).to.equal(alice.address);
      expect(rec.authorBound).to.equal(false);
    });
  });

  // chai matcher helper: Anchored's timestamp is block.timestamp, which we don't pin exactly.
  function anyTimestamp() {
    const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
    return anyValue;
  }
});

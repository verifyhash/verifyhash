const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { anyUint, anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

// CLI modules under test for the end-to-end consumability of the lineage edge (the T-10.1 REWORK):
// the on-chain `parent` must be SURFACED by the read tools (`vh show`/`vh list`) and REACHABLE by the
// write tools (`vh anchor --parent` / `vh claim --parent`), not silently dropped at the tool boundary.
const { runShow, jsonShow, isRoot, ZERO_HASH } = require("../cli/show");
const { runList } = require("../cli/list");
const { buildAnchorTx, runAnchor, normalizeParent } = require("../cli/anchor");
const { buildRevealTx, runClaim } = require("../cli/claim");
const { parseAnchorArgs, parseClaimArgs } = require("../cli/vh");

// ---------------------------------------------------------------------------------------------
// T-10.1 — optional, immutable predecessor link (the on-chain lineage graph edge).
//
// New write paths (additive, the legacy zero-arg-predecessor callers are unchanged):
//   * anchorWithParent(contentHash, uri, parent)         -> authorBound = false, edge child->parent
//   * revealWithParent(contentHash, salt, uri, parent)   -> authorBound = true,  edge child->parent
// The Record struct gains an immutable `bytes32 parent` (0x0 == "no predecessor / lineage root").
//
// Invariants proven here:
//   * a child's parent reads back exactly, on every read path (getRecord / getRecordAtIndex /
//     getRecords) and is observable off-chain via the new Linked(child, parent) event;
//   * a non-zero parent MUST already be anchored, else revert UnknownParent (NOT NotAnchored);
//   * self-reference (parent == contentHash) reverts SelfParent;
//   * the graph is acyclic BY CONSTRUCTION: you can walk a 2-3 deep chain off-chain by following
//     `parent`, and a record with parent == 0x0 is a valid lineage root;
//   * the no-parent paths (anchor/reveal) behave IDENTICALLY: parent reads back as 0x0, no Linked
//     event, same Anchored/Revealed signatures, same first-writer-wins, same reveal semantics.
// ---------------------------------------------------------------------------------------------

const ZERO = ethers.ZeroHash;

describe("Lineage — immutable predecessor edge (T-10.1)", function () {
  async function deploy() {
    const [deployer, alice, bob, carol] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ContributionRegistry");
    const registry = await Factory.deploy();
    await registry.waitForDeployment();
    return { registry, deployer, alice, bob, carol };
  }

  // Commitment exactly as the contract computes it: keccak256(abi.encode(hash, addr, salt)).
  function commitmentOf(contentHash, committer, salt) {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "bytes32"],
        [contentHash, committer, salt]
      )
    );
  }

  const H = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

  // Reveal helper (commit, age past MIN_REVEAL_DELAY, then reveal-with-parent) for authorBound=true.
  async function commitRevealWithParent(registry, signer, contentHash, uri, parent) {
    const salt = H("salt-for-" + contentHash);
    await registry.connect(signer).commit(commitmentOf(contentHash, signer.address, salt));
    await mine(2);
    return registry.connect(signer).revealWithParent(contentHash, salt, uri, parent);
  }

  describe("anchorWithParent — basic edge", function () {
    it("anchor A then anchorWithParent B(parent=A): B.parent == A; A is a root (0x0)", async function () {
      const { registry, alice, bob } = await loadFixture(deploy);
      const A = H("A");
      const B = H("B");

      await registry.connect(alice).anchor(A, "ipfs://A");
      await registry.connect(bob).anchorWithParent(B, "ipfs://B", A);

      const recA = await registry.getRecord(A);
      const recB = await registry.getRecord(B);
      expect(recA.parent).to.equal(ZERO); // A has no predecessor -> lineage root
      expect(recB.parent).to.equal(A); // B points back at A
      expect(recB.contributor).to.equal(bob.address);
      expect(recB.authorBound).to.equal(false);
      expect(recB.uri).to.equal("ipfs://B");
      expect(await registry.total()).to.equal(2n);
    });

    it("emits Linked(B, A) in addition to Anchored (edge observable off-chain)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const A = H("edge-A");
      const B = H("edge-B");
      await registry.connect(alice).anchor(A, "");

      await expect(registry.connect(alice).anchorWithParent(B, "u", A))
        .to.emit(registry, "Anchored")
        .withArgs(B, alice.address, 1, anyUint, "u")
        .and.to.emit(registry, "Linked")
        .withArgs(B, A);
    });

    it("the edge set is reconstructable from Linked logs alone (indexer view)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const A = H("rec-A");
      const B = H("rec-B");
      const C = H("rec-C");

      await registry.connect(alice).anchor(A, ""); // root: no Linked log
      await registry.connect(alice).anchorWithParent(B, "", A); // edge B->A
      await registry.connect(alice).anchorWithParent(C, "", B); // edge C->B

      const logs = await registry.queryFilter(registry.filters.Linked());
      const edges = logs.map((l) => [l.args.child, l.args.parent]);
      expect(edges).to.have.lengthOf(2);
      expect(edges).to.deep.include([B, A]);
      expect(edges).to.deep.include([C, B]);
    });

    it("parent == 0x0 explicitly is a valid lineage root (== plain anchor, no Linked event)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const R = H("explicit-root");

      await expect(registry.connect(alice).anchorWithParent(R, "ipfs://root", ZERO))
        .to.emit(registry, "Anchored")
        .withArgs(R, alice.address, 0, anyUint, "ipfs://root");

      // No Linked log was emitted for an explicit-0x0 parent.
      const logs = await registry.queryFilter(registry.filters.Linked());
      expect(logs).to.have.lengthOf(0);

      const rec = await registry.getRecord(R);
      expect(rec.parent).to.equal(ZERO);
      expect(rec.authorBound).to.equal(false);
    });
  });

  describe("revealWithParent — authorBound edge", function () {
    it("reveal C with parent=B sets authorBound==true AND parent==B", async function () {
      const { registry, alice, bob } = await loadFixture(deploy);
      const B = H("rev-B");
      const C = H("rev-C");

      // B is anchored first so it can be a parent.
      await registry.connect(alice).anchor(B, "ipfs://B");

      await expect(commitRevealWithParent(registry, bob, C, "ipfs://C", B))
        .to.emit(registry, "Revealed")
        .withArgs(C, bob.address, 1, anyValue, anyUint, "ipfs://C")
        .and.to.emit(registry, "Anchored")
        .withArgs(C, bob.address, 1, anyUint, "ipfs://C")
        .and.to.emit(registry, "Linked")
        .withArgs(C, B);

      const recC = await registry.getRecord(C);
      expect(recC.authorBound).to.equal(true);
      expect(recC.parent).to.equal(B);
      expect(recC.contributor).to.equal(bob.address);
    });

    it("revealWithParent with parent=0x0 is a root and behaves like reveal (authorBound, no Linked)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const C = H("rev-root");
      await commitRevealWithParent(registry, alice, C, "u", ZERO);

      const rec = await registry.getRecord(C);
      expect(rec.authorBound).to.equal(true);
      expect(rec.parent).to.equal(ZERO);

      const logs = await registry.queryFilter(registry.filters.Linked());
      expect(logs).to.have.lengthOf(0);
    });
  });

  describe("preconditions: UnknownParent and SelfParent", function () {
    it("referencing an UNanchored parent reverts UnknownParent(parent) — NOT NotAnchored", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const child = H("orphan-child");
      const ghost = H("never-anchored-parent");

      await expect(registry.connect(alice).anchorWithParent(child, "u", ghost))
        .to.be.revertedWithCustomError(registry, "UnknownParent")
        .withArgs(ghost);

      // Distinct from the read-side NotAnchored error and the child was NOT written.
      expect(await registry.isAnchored(child)).to.equal(false);
      expect(await registry.total()).to.equal(0n);
    });

    it("revealWithParent also rejects an unanchored parent with UnknownParent", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const child = H("rev-orphan");
      const ghost = H("rev-ghost-parent");
      const salt = H("rev-orphan-salt");

      await registry.connect(alice).commit(commitmentOf(child, alice.address, salt));
      await mine(2);
      await expect(registry.connect(alice).revealWithParent(child, salt, "u", ghost))
        .to.be.revertedWithCustomError(registry, "UnknownParent")
        .withArgs(ghost);

      // Reveal reverted, so the commitment is untouched and the child unwritten.
      expect(await registry.isAnchored(child)).to.equal(false);
      const [committer] = await registry.getCommitment(
        commitmentOf(child, alice.address, salt)
      );
      expect(committer).to.equal(alice.address);
    });

    it("self-parent (parent == contentHash) reverts SelfParent(contentHash)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const X = H("self-ref");

      await expect(registry.connect(alice).anchorWithParent(X, "u", X))
        .to.be.revertedWithCustomError(registry, "SelfParent")
        .withArgs(X);

      expect(await registry.isAnchored(X)).to.equal(false);
    });

    it("self-parent is rejected even if a record with that hash existed would-be (still SelfParent, not UnknownParent)", async function () {
      // A self-edge can never be legal: the child cannot pre-exist itself. The contract catches it as
      // SelfParent before the existence check, so even on an empty registry it's SelfParent.
      const { registry, alice } = await loadFixture(deploy);
      const X = H("self-ref-empty");
      await expect(registry.connect(alice).anchorWithParent(X, "u", X))
        .to.be.revertedWithCustomError(registry, "SelfParent")
        .withArgs(X);
    });

    it("zero contentHash still reverts ZeroHash on the with-parent path", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const A = H("zerochild-parent");
      await registry.connect(alice).anchor(A, "");
      await expect(
        registry.connect(alice).anchorWithParent(ZERO, "u", A)
      ).to.be.revertedWithCustomError(registry, "ZeroHash");
    });

    it("with-parent path is still first-writer-wins (AlreadyAnchored on duplicate child)", async function () {
      const { registry, alice, bob } = await loadFixture(deploy);
      const A = H("fww-parent");
      const B = H("fww-child");
      await registry.connect(alice).anchor(A, "");
      await registry.connect(alice).anchorWithParent(B, "first", A);

      await expect(registry.connect(bob).anchorWithParent(B, "second", A))
        .to.be.revertedWithCustomError(registry, "AlreadyAnchored")
        .withArgs(B, alice.address);

      // Original record (incl. its parent) is preserved.
      const rec = await registry.getRecord(B);
      expect(rec.contributor).to.equal(alice.address);
      expect(rec.uri).to.equal("first");
      expect(rec.parent).to.equal(A);
    });
  });

  describe("acyclic by construction: walk a multi-deep chain off-chain", function () {
    it("root -> v2 -> v3 reads back the full lineage by walking `parent`", async function () {
      const { registry, alice, bob, carol } = await loadFixture(deploy);
      const root = H("v1-root");
      const v2 = H("v2");
      const v3 = H("v3");

      await registry.connect(alice).anchor(root, "ipfs://v1");
      await registry.connect(bob).anchorWithParent(v2, "ipfs://v2", root);
      // v3 via reveal to also cover an authorBound link in the chain.
      await commitRevealWithParent(registry, carol, v3, "ipfs://v3", v2);

      // Walk from the tip back to the root purely off-chain via `parent`. Bounded because each step
      // must point at an EARLIER record; the chain terminates at 0x0 (the root).
      const lineage = [];
      let cursor = v3;
      let guard = 0;
      while (cursor !== ZERO) {
        const rec = await registry.getRecord(cursor);
        lineage.push({ hash: cursor, uri: rec.uri, parent: rec.parent });
        cursor = rec.parent;
        if (++guard > 16) throw new Error("lineage walk did not terminate (cycle?)");
      }

      expect(lineage.map((x) => x.hash)).to.deep.equal([v3, v2, root]);
      expect(lineage.map((x) => x.uri)).to.deep.equal(["ipfs://v3", "ipfs://v2", "ipfs://v1"]);
      // Tip's parent is v2; root terminates the walk (its parent is 0x0).
      expect(lineage[0].parent).to.equal(v2);
      expect(lineage[1].parent).to.equal(root);
      expect(lineage[2].parent).to.equal(ZERO);
    });

    it("a parent must pre-exist, so an edge can only point at a lower index (forward edge impossible)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const root = H("idx-root");
      const child = H("idx-child");
      await registry.connect(alice).anchor(root, "");
      await registry.connect(alice).anchorWithParent(child, "", root);

      const [, recRoot] = await registry.getRecordAtIndex(0);
      const [, recChild] = await registry.getRecordAtIndex(1);
      expect(recRoot.parent).to.equal(ZERO);
      expect(recChild.parent).to.equal(root);
      // The parent (root) has a strictly lower insertion index than the child -> no forward edge.
      expect(await registry.hashAtIndex(0)).to.equal(root);
      expect(await registry.hashAtIndex(1)).to.equal(child);
    });
  });

  describe("parent surfaces on all read paths", function () {
    it("getRecordAtIndex returns the parent field", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const A = H("ri-A");
      const B = H("ri-B");
      await registry.connect(alice).anchor(A, "");
      await registry.connect(alice).anchorWithParent(B, "", A);

      const [h0, r0] = await registry.getRecordAtIndex(0);
      const [h1, r1] = await registry.getRecordAtIndex(1);
      expect(h0).to.equal(A);
      expect(r0.parent).to.equal(ZERO);
      expect(h1).to.equal(B);
      expect(r1.parent).to.equal(A);
    });

    it("getRecords (paginated) returns the parent field for every entry", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const A = H("rs-A");
      const B = H("rs-B");
      const C = H("rs-C");
      await registry.connect(alice).anchor(A, "");
      await registry.connect(alice).anchorWithParent(B, "", A);
      await registry.connect(alice).anchorWithParent(C, "", B);

      const [hashes, records] = await registry.getRecords(0, 10);
      expect(hashes).to.deep.equal([A, B, C]);
      expect(records[0].parent).to.equal(ZERO);
      expect(records[1].parent).to.equal(A);
      expect(records[2].parent).to.equal(B);
    });
  });

  describe("legacy no-parent paths are unchanged", function () {
    it("plain anchor() leaves parent == 0x0 and emits NO Linked event", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const A = H("legacy-anchor");
      await expect(registry.connect(alice).anchor(A, "ipfs://A"))
        .to.emit(registry, "Anchored")
        .withArgs(A, alice.address, 0, anyUint, "ipfs://A");

      const rec = await registry.getRecord(A);
      expect(rec.parent).to.equal(ZERO);

      const logs = await registry.queryFilter(registry.filters.Linked());
      expect(logs).to.have.lengthOf(0);
    });

    it("plain reveal() leaves parent == 0x0, authorBound == true, emits NO Linked event", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const C = H("legacy-reveal");
      const salt = H("legacy-reveal-salt");
      await registry.connect(alice).commit(commitmentOf(C, alice.address, salt));
      await mine(2);
      await expect(registry.connect(alice).reveal(C, salt, "ipfs://C"))
        .to.emit(registry, "Revealed")
        .withArgs(C, alice.address, 0, anyValue, anyUint, "ipfs://C")
        .and.to.emit(registry, "Anchored")
        .withArgs(C, alice.address, 0, anyUint, "ipfs://C");

      const rec = await registry.getRecord(C);
      expect(rec.parent).to.equal(ZERO);
      expect(rec.authorBound).to.equal(true);

      const logs = await registry.queryFilter(registry.filters.Linked());
      expect(logs).to.have.lengthOf(0);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// T-10.1 REWORK — the lineage edge must be CONSUMABLE end-to-end through the product, not just
// present in the contract struct. The review panel found the edge was silently dropped at the tool
// boundary: `vh show --json` / `vh list --json` enumerated named fields and omitted `parent`, and no
// CLI write path could create an edge. These tests lock in the fix:
//   * READ: runShow/runList surface `parent` (+ `isRoot`) in BOTH the --json shape and the human
//     block, for a parented record AND a root (0x0 flagged, never silently absent).
//   * WRITE: `--parent` routes anchor->anchorWithParent and claim/reveal->revealWithParent, validates
//     a malformed/self parent, and actually writes the edge on-chain (observable back via show/list).
// The in-process hardhat provider (`ethers.provider`) backs the read-only CLI calls; writes go
// through the same fixture registry, so the whole loop (write edge -> read it back) is exercised.
// ---------------------------------------------------------------------------------------------
describe("Lineage CLI consumability (T-10.1 rework: show/list surface + --parent write path)", function () {
  const H = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

  function commitmentOf(contentHash, committer, salt) {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "bytes32"],
        [contentHash, committer, salt]
      )
    );
  }

  async function deploy() {
    const [deployer, alice, bob] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ContributionRegistry");
    const registry = await Factory.deploy();
    await registry.waitForDeployment();
    const address = await registry.getAddress();
    return { registry, address, deployer, alice, bob };
  }

  // ---------------------------------------------------------------------------
  // READ side: `vh show` surfaces the parent edge (the documented --json gap).
  // ---------------------------------------------------------------------------
  describe("vh show surfaces `parent`/`isRoot`", function () {
    it("--json carries parent + isRoot:false for a parented record and parent:null + isRoot:true for a root", async function () {
      const { registry, address, alice } = await loadFixture(deploy);
      const A = H("show-root");
      const B = H("show-child");
      await registry.connect(alice).anchor(A, "ipfs://A");
      await registry.connect(alice).anchorWithParent(B, "ipfs://B", A);

      // The ROOT (A): parent serializes as null but isRoot:true so a consumer can tell it apart from
      // a missing field.
      let rootOut = "";
      const rootRes = await runShow({
        contentHash: A,
        contractAddress: address,
        provider: ethers.provider,
        json: true,
        log: (s) => (rootOut += s),
      });
      const rootJson = JSON.parse(rootOut);
      expect(rootRes.parent).to.equal(ZERO_HASH); // the underlying field IS the zero hash
      expect(rootJson).to.have.property("parent", null);
      expect(rootJson).to.have.property("isRoot", true);
      expect(rootJson).to.deep.equal(jsonShow(rootRes));

      // The CHILD (B): the documented --json contract now EXPOSES the predecessor hash.
      let childOut = "";
      const childRes = await runShow({
        contentHash: B,
        contractAddress: address,
        provider: ethers.provider,
        json: true,
        log: (s) => (childOut += s),
      });
      const childJson = JSON.parse(childOut);
      expect(childRes.parent).to.equal(A.toLowerCase());
      expect(childJson).to.have.property("parent", A.toLowerCase());
      expect(childJson).to.have.property("isRoot", false);
      expect(childJson).to.deep.equal(jsonShow(childRes));
    });

    it("the human block prints the parent edge (predecessor hash for a child, 'lineage root' for a root)", async function () {
      const { registry, address, alice } = await loadFixture(deploy);
      const A = H("show-human-root");
      const B = H("show-human-child");
      await registry.connect(alice).anchor(A, "");
      await registry.connect(alice).anchorWithParent(B, "", A);

      let rootOut = "";
      await runShow({ contentHash: A, contractAddress: address, provider: ethers.provider, log: (s) => (rootOut += s) });
      expect(rootOut).to.match(/parent:\s+\(none\) — lineage root/);

      let childOut = "";
      await runShow({ contentHash: B, contractAddress: address, provider: ethers.provider, log: (s) => (childOut += s) });
      expect(childOut).to.contain(A); // the predecessor hash appears in the human block
      expect(childOut).to.match(/parent:\s+0x[0-9a-fA-F]{64}/);
      // The trust caveat for the edge is carried (claimed predecessor, not proven ancestry).
      expect(childOut).to.match(/CLAIMED predecessor/i);
    });
  });

  // ---------------------------------------------------------------------------
  // READ side: `vh list` surfaces the parent edge for every row.
  // ---------------------------------------------------------------------------
  describe("vh list surfaces `parent`/`isRoot` per record", function () {
    it("--json: each record carries parent + isRoot; the edge set is reconstructable from list alone", async function () {
      const { registry, address, alice } = await loadFixture(deploy);
      const A = H("list-root");
      const B = H("list-v2");
      const C = H("list-v3");
      await registry.connect(alice).anchor(A, "");
      await registry.connect(alice).anchorWithParent(B, "", A);
      await registry.connect(alice).anchorWithParent(C, "", B);

      let out = "";
      const res = await runList({
        contractAddress: address,
        provider: ethers.provider,
        json: true,
        log: (s) => (out += s),
      });
      const arr = JSON.parse(out);
      expect(arr).to.have.lengthOf(3);
      // The emitted JSON is exactly the structured result `res.records` (which is the jsonRecord shape
      // for each row) — no drift between what runList returns and what it prints.
      expect(arr).to.deep.equal(res.records);

      // Row 0 is the root; rows 1,2 carry their predecessor.
      expect(arr[0]).to.include({ contentHash: A, parent: null, isRoot: true });
      expect(arr[1]).to.include({ contentHash: B, parent: A.toLowerCase(), isRoot: false });
      expect(arr[2]).to.include({ contentHash: C, parent: B.toLowerCase(), isRoot: false });

      // An indexer can rebuild the full edge set from `vh list --json` ALONE (mirrors Linked logs).
      const edges = arr.filter((r) => !r.isRoot).map((r) => [r.contentHash, r.parent]);
      expect(edges).to.deep.equal([
        [B, A.toLowerCase()],
        [C, B.toLowerCase()],
      ]);
    });

    it("the human block prints a parent line per row (root vs child)", async function () {
      const { registry, address, alice } = await loadFixture(deploy);
      const A = H("list-human-root");
      const B = H("list-human-child");
      await registry.connect(alice).anchor(A, "");
      await registry.connect(alice).anchorWithParent(B, "", A);

      let out = "";
      await runList({ contractAddress: address, provider: ethers.provider, log: (s) => (out += s) });
      expect(out).to.match(/parent:\s+\(none\) — lineage root/); // the root row
      expect(out).to.contain(A); // the child row shows its predecessor hash
      expect(out).to.match(/parent:\s+0x[0-9a-fA-F]{64}/);
    });

    it("isRoot() helper: zero hash / null / undefined are roots; a real hash is not", function () {
      expect(isRoot(ZERO_HASH)).to.equal(true);
      expect(isRoot(null)).to.equal(true);
      expect(isRoot(undefined)).to.equal(true);
      expect(isRoot("0x" + "0".repeat(64))).to.equal(true);
      expect(isRoot(H("anything-nonzero"))).to.equal(false);
    });
  });

  // ---------------------------------------------------------------------------
  // WRITE side: `vh anchor --parent` routes to anchorWithParent and writes the edge.
  // ---------------------------------------------------------------------------
  describe("vh anchor --parent (routes to anchorWithParent)", function () {
    it("normalizeParent: empty/zero -> null (root); a 32-byte hash -> lowercased; junk -> throws", function () {
      expect(normalizeParent(undefined, ethers)).to.equal(null);
      expect(normalizeParent("", ethers)).to.equal(null);
      expect(normalizeParent(ZERO_HASH, ethers)).to.equal(null); // zero hash is the root sentinel
      const h = "0x" + "AB".repeat(32);
      expect(normalizeParent(h, ethers)).to.equal(h.toLowerCase());
      expect(() => normalizeParent("0x1234", ethers)).to.throw(/invalid --parent/i);
      expect(() => normalizeParent("not-a-hash", ethers)).to.throw(/invalid --parent/i);
    });

    it("buildAnchorTx: no --parent encodes anchor(); a --parent encodes anchorWithParent()", function () {
      const A = H("build-parent");
      const child = H("build-child");
      const noParent = buildAnchorTx({
        path: __filename, // a real file so hashPath succeeds; contentHash is irrelevant here
        contractAddress: "0x" + "11".repeat(20),
        ethers,
      });
      expect(noParent.functionName).to.equal("anchor");
      expect(noParent.parent).to.equal(null);

      const withParent = buildAnchorTx({
        path: __filename,
        parent: A,
        contractAddress: "0x" + "11".repeat(20),
        ethers,
      });
      expect(withParent.functionName).to.equal("anchorWithParent");
      expect(withParent.parent).to.equal(A.toLowerCase());
      // The two encode to different calldata (different selector), proving the route really differs.
      expect(withParent.data).to.not.equal(noParent.data);
      // self-reference is caught before any tx is built.
      expect(() =>
        buildAnchorTx({ path: __filename, parent: child, contractAddress: "0x" + "11".repeat(20), ethers })
      ).to.not.throw(); // (child != file's hash, so not self) — sanity that a normal parent is fine
    });

    it("end-to-end: runAnchor with --parent writes the edge on-chain, observable via show + Linked", async function () {
      const { registry, address, alice } = await loadFixture(deploy);
      // First anchor a real parent (a file's hash) so the edge target exists.
      const parentRes = await runAnchor({
        path: __filename,
        contractAddress: address,
        chainId: 31337n, // hardhat; skips the network lookup + passes the testnet guard
        signer: alice,
        provider: ethers.provider,
        ethers,
        log: () => {},
      });
      const parentHash = parentRes.anchored.contentHash;
      expect(parentRes.tx.functionName).to.equal("anchor");
      expect(parentRes.linked).to.equal(null); // a root: no Linked edge

      // Now anchor a DISTINCT child hash naming that parent. Use a tiny temp content via a 2nd file:
      // reuse the package.json in the repo root as a different file with a different hash.
      const childPath = require("path").join(__dirname, "..", "package.json");
      const childRes = await runAnchor({
        path: childPath,
        parent: parentHash,
        contractAddress: address,
        chainId: 31337n,
        signer: alice,
        provider: ethers.provider,
        ethers,
        log: () => {},
      });
      expect(childRes.tx.functionName).to.equal("anchorWithParent");
      expect(childRes.linked).to.not.equal(null);
      expect(childRes.linked.parent).to.equal(parentHash);
      const childHash = childRes.anchored.contentHash;

      // The edge is now readable back through `vh show --json`.
      let out = "";
      const shown = await runShow({
        contentHash: childHash,
        contractAddress: address,
        provider: ethers.provider,
        json: true,
        log: (s) => (out += s),
      });
      expect(shown.parent).to.equal(parentHash.toLowerCase());
      expect(JSON.parse(out).parent).to.equal(parentHash.toLowerCase());

      // And the Linked log was emitted on-chain (indexer view).
      const logs = await registry.queryFilter(registry.filters.Linked());
      const edges = logs.map((l) => [l.args.child, l.args.parent]);
      expect(edges).to.deep.include([childHash, parentHash]);
    });

    it("end-to-end: runAnchor with a NON-existent parent reverts (contract's UnknownParent precondition)", async function () {
      const { address, alice } = await loadFixture(deploy);
      const ghost = H("never-anchored");
      let err = null;
      try {
        await runAnchor({
          path: __filename,
          parent: ghost,
          contractAddress: address,
          chainId: 31337n,
          signer: alice,
          provider: ethers.provider,
          ethers,
          log: () => {},
        });
      } catch (e) {
        err = e;
      }
      expect(err, "naming an unanchored parent must revert").to.not.equal(null);
      expect(String(err.message)).to.match(/UnknownParent|revert/i);
    });
  });

  // ---------------------------------------------------------------------------
  // WRITE side: `vh claim --parent` routes the reveal leg to revealWithParent.
  // ---------------------------------------------------------------------------
  describe("vh claim --parent (routes reveal -> revealWithParent)", function () {
    it("buildRevealTx: no --parent encodes reveal(); a --parent encodes revealWithParent()", function () {
      const salt = H("reveal-salt");
      const child = H("reveal-child");
      const parent = H("reveal-parent");
      const noParent = buildRevealTx({
        contentHash: child,
        salt,
        contractAddress: "0x" + "22".repeat(20),
        ethers,
      });
      expect(noParent.functionName).to.equal("reveal");
      expect(noParent.parent).to.equal(null);

      const withParent = buildRevealTx({
        contentHash: child,
        salt,
        parent,
        contractAddress: "0x" + "22".repeat(20),
        ethers,
      });
      expect(withParent.functionName).to.equal("revealWithParent");
      expect(withParent.parent).to.equal(parent.toLowerCase());
      expect(withParent.data).to.not.equal(noParent.data);

      // Self-reference is rejected at build time (the contract would revert SelfParent).
      expect(() =>
        buildRevealTx({ contentHash: child, salt, parent: child, contractAddress: "0x" + "22".repeat(20), ethers })
      ).to.throw(/self-reference|SelfParent/i);
    });

    it("end-to-end: runClaim with --parent reveals an authorBound record whose parent is the named edge", async function () {
      const { registry, address, alice, bob } = await loadFixture(deploy);
      // Anchor a parent first (a real file hash) so the edge target exists.
      const parentRes = await runAnchor({
        path: __filename,
        contractAddress: address,
        chainId: 31337n,
        signer: alice,
        provider: ethers.provider,
        ethers,
        log: () => {},
      });
      const parentHash = parentRes.anchored.contentHash;

      // Claim a DISTINCT child (a different file) WITH that parent. waitForBlock mines the reveal
      // window so the in-process node advances past MIN_REVEAL_DELAY.
      const childPath = require("path").join(__dirname, "..", "package.json");
      const claimRes = await runClaim({
        path: childPath,
        parent: parentHash,
        contractAddress: address,
        chainId: 31337n,
        signer: bob,
        provider: ethers.provider,
        ethers,
        waitForBlock: async (target) => {
          while (BigInt(await ethers.provider.getBlockNumber()) < target) await mine(1);
        },
        log: () => {},
      });
      const childHash = claimRes.revealed.contentHash;

      const rec = await registry.getRecord(childHash);
      expect(rec.authorBound).to.equal(true); // commit-reveal => proven first claimant
      expect(rec.parent).to.equal(parentHash); // the lineage edge was recorded by revealWithParent
      expect(rec.contributor).to.equal(bob.address);

      // The Linked edge is on-chain and the read tool surfaces the parent.
      const logs = await registry.queryFilter(registry.filters.Linked());
      expect(logs.map((l) => [l.args.child, l.args.parent])).to.deep.include([childHash, parentHash]);
      const shown = await runShow({
        contentHash: childHash,
        contractAddress: address,
        provider: ethers.provider,
        log: () => {},
      });
      expect(shown.parent).to.equal(parentHash.toLowerCase());
    });
  });

  // ---------------------------------------------------------------------------
  // Arg parsers accept --parent and reject a missing value (parser parity).
  // ---------------------------------------------------------------------------
  describe("vh.js parsers accept --parent", function () {
    it("parseAnchorArgs parses --parent and rejects a missing value", function () {
      const o = parseAnchorArgs(["f", "--parent", "0xabc"]);
      expect(o.parent).to.equal("0xabc");
      expect(() => parseAnchorArgs(["f", "--parent"])).to.throw(/--parent requires a value/i);
    });

    it("parseClaimArgs parses --parent and rejects a missing value", function () {
      const o = parseClaimArgs(["f", "--parent", "0xdef"]);
      expect(o.parent).to.equal("0xdef");
      expect(() => parseClaimArgs(["f", "--parent"])).to.throw(/--parent requires a value/i);
    });
  });
});

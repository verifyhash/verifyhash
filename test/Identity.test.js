const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// ---------------------------------------------------------------------------------------------
// T-11.1 — On-chain IDENTITY marker.
//
// These tests prove the acceptance criteria for a cheap, immutable, ownerless self-identification
// tag an off-chain verifier can use to authenticate a real ContributionRegistry vs. a lying
// look-alike BEFORE trusting any record it returns:
//   1. `REGISTRY_ID` equals the DOCUMENTED keccak256 preimage and is stable (re-deriving it from the
//      literal string in the NatSpec reproduces the on-chain constant).
//   2. `REGISTRY_VERSION` is 1.
//   3. The ERC-165-style `supportsInterface` returns true for the declared core read interface id and
//      for ERC-165 itself, and false for the reserved `0xffffffff` and an unrelated id.
//   4. The marker is purely a READ probe: `pure`/`constant`, no owner/admin/setter, no storage write.
//
// The marker is a POSITIVE "right interface" signal only — it does not prove the records are honest
// (that comes from the immutable first-writer-wins + commit-reveal rules) and a fork can reuse the
// same id, so it must be verified alongside bytecode + chainId. See the contract's
// "ON-CHAIN IDENTITY MARKER" / "TRUST BOUNDARIES" NatSpec.
// ---------------------------------------------------------------------------------------------

describe("Identity marker (T-11.1)", function () {
  // The DOCUMENTED preimage, frozen in the contract's NatSpec. Re-deriving the hash here (rather than
  // hardcoding the digest) is what proves the on-chain constant matches the documented string.
  const REGISTRY_ID_PREIMAGE = "verifyhash.ContributionRegistry.v1";
  const EXPECTED_REGISTRY_ID = ethers.keccak256(
    ethers.toUtf8Bytes(REGISTRY_ID_PREIMAGE)
  );
  // Frozen value also pinned literally so an accidental change to the preimage string can't silently
  // move BOTH this constant and the derived expectation together.
  const PINNED_REGISTRY_ID =
    "0x0395e2ec987e96e51cdf619980638100236c5fc7f7c3646f8b759f3cdceb2df3";

  const ERC165_ID = "0x01ffc9a7";
  const INVALID_ID = "0xffffffff";
  const CORE_INTERFACE_ID = "0xc5d8cdda";

  async function deploy() {
    const [deployer] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ContributionRegistry");
    const registry = await Factory.deploy();
    await registry.waitForDeployment();
    return { registry, deployer };
  }

  it("REGISTRY_ID equals keccak256 of the documented preimage", async function () {
    const { registry } = await loadFixture(deploy);
    expect(await registry.REGISTRY_ID()).to.equal(EXPECTED_REGISTRY_ID);
  });

  it("REGISTRY_ID matches the frozen pinned digest (catches preimage drift)", async function () {
    const { registry } = await loadFixture(deploy);
    // The derived expectation and the literal pin must agree, AND both must equal the on-chain value.
    expect(EXPECTED_REGISTRY_ID).to.equal(PINNED_REGISTRY_ID);
    expect(await registry.REGISTRY_ID()).to.equal(PINNED_REGISTRY_ID);
  });

  it("REGISTRY_ID is stable across calls and fresh deployments", async function () {
    const { registry } = await loadFixture(deploy);
    const a = await registry.REGISTRY_ID();
    const b = await registry.REGISTRY_ID();
    expect(a).to.equal(b);

    // A second, independent deployment must report the SAME id (it is baked into the bytecode).
    const Factory = await ethers.getContractFactory("ContributionRegistry");
    const registry2 = await Factory.deploy();
    await registry2.waitForDeployment();
    expect(await registry2.REGISTRY_ID()).to.equal(a);
  });

  it("REGISTRY_VERSION is 1", async function () {
    const { registry } = await loadFixture(deploy);
    expect(await registry.REGISTRY_VERSION()).to.equal(1n);
  });

  it("REGISTRY_INTERFACE_ID equals the XOR of the core read selectors", async function () {
    const { registry } = await loadFixture(deploy);
    const sigs = [
      "isAnchored(bytes32)",
      "getRecord(bytes32)",
      "total()",
      "hashAtIndex(uint256)",
      "verifyLeaf(bytes32,bytes32,bytes32[])",
    ];
    let id = 0n;
    for (const s of sigs) id ^= BigInt(ethers.id(s).slice(0, 10));
    const derived = "0x" + id.toString(16).padStart(8, "0");
    expect(derived).to.equal(CORE_INTERFACE_ID);
    expect(await registry.REGISTRY_INTERFACE_ID()).to.equal(CORE_INTERFACE_ID);
  });

  describe("supportsInterface (ERC-165-style)", function () {
    it("returns true for the declared core read interface id", async function () {
      const { registry } = await loadFixture(deploy);
      expect(await registry.supportsInterface(CORE_INTERFACE_ID)).to.equal(true);
      // and for whatever the contract reports as its own interface id
      const declared = await registry.REGISTRY_INTERFACE_ID();
      expect(await registry.supportsInterface(declared)).to.equal(true);
    });

    it("returns true for the ERC-165 interface id (0x01ffc9a7)", async function () {
      const { registry } = await loadFixture(deploy);
      expect(await registry.supportsInterface(ERC165_ID)).to.equal(true);
    });

    it("returns false for the reserved invalid id 0xffffffff", async function () {
      const { registry } = await loadFixture(deploy);
      expect(await registry.supportsInterface(INVALID_ID)).to.equal(false);
    });

    it("returns false for an unrelated interface id", async function () {
      const { registry } = await loadFixture(deploy);
      // 0xdeadbeef is not ERC-165, not the core id, not the invalid id.
      expect(await registry.supportsInterface("0xdeadbeef")).to.equal(false);
      // The zero id is also unrelated.
      expect(await registry.supportsInterface("0x00000000")).to.equal(false);
    });
  });

  it("is a pure/constant read probe: no setter, no write surface added", async function () {
    const { registry } = await loadFixture(deploy);
    const i = registry.interface;
    // The identity surface is exactly these read-only fragments — assert there is NO setter for them.
    for (const name of ["REGISTRY_ID", "REGISTRY_VERSION", "REGISTRY_INTERFACE_ID"]) {
      const fn = i.getFunction(name);
      expect(fn.stateMutability, `${name} must be view/pure`).to.match(/view|pure/);
    }
    const si = i.getFunction("supportsInterface");
    expect(si.stateMutability).to.equal("pure");

    // No NON-view/pure function references the identity (i.e. there is no setter/mutator for it).
    const mutators = i.fragments
      .filter((f) => f.type === "function")
      .filter((f) => f.stateMutability !== "view" && f.stateMutability !== "pure")
      .map((f) => f.name)
      .filter((n) => /registry|version|interface|identif/i.test(n));
    expect(mutators, "no mutating function touches the identity marker").to.have.lengthOf(0);

    // And there is no `set*` function at all (the whole contract is ownerless/setterless).
    const setters = i.fragments
      .filter((f) => f.type === "function")
      .map((f) => f.name)
      .filter((n) => /^set[A-Z]/.test(n));
    expect(setters, "no setter functions exist").to.have.lengthOf(0);
  });
});

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");

// ---------------------------------------------------------------------------------------------
// T-11.2 — Authenticate the registry on EVERY read command before believing it.
//
// These tests prove the acceptance criteria:
//   * `assertRegistry` (cli/registry.js) hard-errors with an actionable message when there is NO
//     contract at the address, when the contract is a DEPLOYED non-registry (no/lying REGISTRY_ID),
//     and when an artifact/receipt chainId does NOT match the provider's chainId; and it RETURNS the
//     resolved { chainId, registryVersion } on success while re-throwing a genuine RPC error as itself.
//   * The preflight is wired into the read path of `vh verify`, `show`, `list`, `lineage`,
//     `verify-proof`: no record/verdict is reported until the registry is authenticated. The human
//     output gains a "registry authenticated" confirmation line and `--json` carries a `registry` block.
//   * `--skip-identity-check` bypasses the preflight, LOUDLY (and is never the default).
//   * The genuine, locally-deployed registry PASSES the identity check WITHOUT the opt-out (post-T-11.1).
//
// Everything filesystem-touching writes only to throwaway temp dirs and is cleaned up in `after`.
// ---------------------------------------------------------------------------------------------

const {
  assertRegistry,
  RegistryAuthError,
  isGenuineRpcError,
  deriveRegistryId,
  formatRegistryLine,
  formatSkippedLine,
  jsonRegistryBlock,
  jsonSkippedBlock,
  EXPECTED_REGISTRY_ID,
  REGISTRY_ID_PREIMAGE,
} = require("../cli/registry");
const { runVerify, STATUS: VERIFY_STATUS } = require("../cli/verify");
const { runShow, STATUS: SHOW_STATUS } = require("../cli/show");
const { runList } = require("../cli/list");
const { runLineage } = require("../cli/lineage");
const { runVerifyProof, STATUS: PROOF_STATUS } = require("../cli/proof");
const { runAnchor } = require("../cli/anchor");
const { runProve, buildProof } = require("../cli/prove");
const {
  buildProofArtifact,
  writeProofArtifact,
  readProofArtifact,
} = require("../cli/proof");
const { hashFile, hashDir } = require("../cli/hash");

let tmpDirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
function writeFile(dir, name, content) {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function waitForRpc(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.request(
        url,
        { method: "POST", headers: { "content-type": "application/json" } },
        (res) => {
          res.resume();
          resolve();
        }
      );
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error("hardhat node did not start in time"));
        else setTimeout(tryOnce, 150);
      });
      req.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }));
      req.end();
    };
    tryOnce();
  });
}

// =============================================================================================
// Pure-ish helpers that need NO node: shape of the formatters/JSON blocks + the frozen identity.
// =============================================================================================
describe("cli/registry — formatters + frozen identity (no node)", function () {
  it("the pinned EXPECTED_REGISTRY_ID equals keccak256 of the documented preimage", function () {
    // The module pins the digest; deriving it from the same preimage the contract NatSpec documents
    // must reproduce it (no silent drift between this module and the contract).
    expect(deriveRegistryId(ethers)).to.equal(EXPECTED_REGISTRY_ID);
    expect(REGISTRY_ID_PREIMAGE).to.equal("verifyhash.ContributionRegistry.v1");
  });

  it("formatRegistryLine names REGISTRY_ID, the version, and the chainId", function () {
    const line = formatRegistryLine({ registryVersion: 1, chainId: 31337 });
    expect(line).to.match(/registry authenticated/i);
    expect(line).to.contain("REGISTRY_ID");
    expect(line).to.contain("v1");
    expect(line).to.contain("31337");
  });

  it("formatSkippedLine is LOUD: it says SKIPPED and that trust is only as good as the RPC", function () {
    const line = formatSkippedLine();
    expect(line).to.match(/SKIPPED/);
    expect(line).to.match(/skip-identity-check/);
    expect(line).to.match(/only as trustworthy as the RPC/i);
  });

  it("jsonRegistryBlock / jsonSkippedBlock are machine-readable", function () {
    expect(jsonRegistryBlock({ registryId: "0xabc", registryVersion: 1, chainId: 31337 })).to.deep.equal({
      id: "0xabc",
      version: 1,
      chainId: 31337,
    });
    const skipped = jsonSkippedBlock();
    expect(skipped.skipped).to.equal(true);
    expect(skipped.note).to.match(/SKIPPED/);
  });

  it("isGenuineRpcError: network codes are genuine (re-thrown), reverts are identity misses", function () {
    expect(isGenuineRpcError({ code: "NETWORK_ERROR" })).to.equal(true);
    expect(isGenuineRpcError({ code: "TIMEOUT" })).to.equal(true);
    expect(isGenuineRpcError({ code: "SERVER_ERROR" })).to.equal(true);
    expect(isGenuineRpcError({ message: "connect ECONNREFUSED 127.0.0.1:9" })).to.equal(true);
    // A reverted/empty call is the chain answering "not this contract" — NOT a network error.
    expect(isGenuineRpcError({ code: "CALL_EXCEPTION" })).to.equal(false);
    expect(isGenuineRpcError({ code: "BAD_DATA" })).to.equal(false);
  });
});

// =============================================================================================
// Live hardhat node: the genuine registry, a deployed non-registry stub, and a no-code address.
// =============================================================================================
describe("cli/registry — assertRegistry + read-command wiring (live node)", function () {
  this.timeout(90000);

  const PORT = 18561; // distinct from every other suite's port so they never collide
  const RPC_URL = `http://127.0.0.1:${PORT}`;
  let nodeProc;
  let provider;
  let deployer;
  let registryAddress; // a GENUINE ContributionRegistry (post-T-11.1)
  let notRegistryAddress; // a deployed contract that is NOT a registry (no REGISTRY_ID)
  let lyingRegistryAddress; // a deployed contract that LIES about REGISTRY_ID
  let noCodeAddress; // a valid-shape address with NO contract deployed
  let chainId;

  // Distinct pre-funded hardhat dev signers so anchoring txs never contend on a shared nonce.
  const DEV_KEYS = [
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // #1
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // #3
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // #4
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // #5
    "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // #6
    "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356", // #7
    "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97", // #8
    "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6", // #9
    "0xf214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897", // #10
    "0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82", // #11
    "0xa267530f49f8280200edf313ee7af6b827f2a8bce2897751d06a843f644967b1", // #12
    "0x47c99abed3324a2707c28affff1267e45918ec8c3f20b8aa892e8b065d2942dd", // #13
    "0xc526ee95bf44d8fc405a158bb884d9d1238d99f0612e9f33d006bb0789009aaa", // #14
    "0x8166f546bab6da521a8369cab06c5d2b9e46670292d85c875977f4a791f9c701", // #15
    "0xea6c44ac03bff858b476bba40716402b03e41b8e97e276d1baec7c37d42484a0", // #16
    "0x689af8efa8c651a91ad287602527f3af2fe9f6501a7ac4b061667b5a93e037fd", // #17
    "0xde9be858da4a475276426320d5e9262ecfc3ba460bfac56360bfa6c4c28b4ee0", // #18
  ];
  let keyIdx = 0;
  // Hand out a brand-new Wallet instance each call, cycling through the dev keys. A fresh instance
  // re-fetches its nonce from the node, so even reusing a key across SEQUENTIAL txs never contends on a
  // stale provider-cached nonce (each test awaits its tx before the next, so there is no concurrency).
  function freshSigner() {
    const k = DEV_KEYS[keyIdx++ % DEV_KEYS.length];
    return new ethers.Wallet(k, provider);
  }

  before(async function () {
    nodeProc = spawn(
      "npx",
      ["hardhat", "node", "--hostname", "127.0.0.1", "--port", String(PORT)],
      { cwd: path.join(__dirname, ".."), stdio: ["ignore", "ignore", "ignore"] }
    );
    await waitForRpc(RPC_URL, 45000);

    provider = new ethers.JsonRpcProvider(RPC_URL);
    deployer = new ethers.Wallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // hardhat #0
      provider
    );
    chainId = Number((await provider.getNetwork()).chainId);

    // Each deployment uses its OWN fresh dev signer so deploys never contend on a shared, provider-
    // cached nonce (the deployer wallet #0 is reserved and not used to send txs here).
    const Registry = await ethers.getContractFactory("ContributionRegistry", freshSigner());
    const registry = await Registry.deploy();
    await registry.waitForDeployment();
    registryAddress = await registry.getAddress();

    const NotReg = await ethers.getContractFactory("NotARegistry", freshSigner());
    const notReg = await NotReg.deploy();
    await notReg.waitForDeployment();
    notRegistryAddress = await notReg.getAddress();

    const Lying = await ethers.getContractFactory("LyingRegistryId", freshSigner());
    const lying = await Lying.deploy();
    await lying.waitForDeployment();
    lyingRegistryAddress = await lying.getAddress();

    // A well-formed address with no contract at it (high nonce of the deployer, never deployed to).
    noCodeAddress = ethers.getCreateAddress({ from: deployer.address, nonce: 9999 });
    expect(await provider.getCode(noCodeAddress)).to.equal("0x");
  });

  after(function () {
    if (nodeProc) nodeProc.kill("SIGKILL");
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  // -------------------------------------------------------------------------------------------
  // assertRegistry — the preflight itself.
  // -------------------------------------------------------------------------------------------
  describe("assertRegistry", function () {
    it("PASSES for the genuine, locally-deployed registry and returns { chainId, registryVersion }", async function () {
      const auth = await assertRegistry({ provider, contractAddress: registryAddress });
      expect(auth.chainId).to.equal(chainId);
      expect(auth.registryVersion).to.equal(1);
      expect(auth.registryId.toLowerCase()).to.equal(EXPECTED_REGISTRY_ID.toLowerCase());
      expect(auth.address.toLowerCase()).to.equal(registryAddress.toLowerCase());
    });

    it("hard-errors with the 'no contract' message for an address with NO code", async function () {
      let err;
      try {
        await assertRegistry({ provider, contractAddress: noCodeAddress });
      } catch (e) {
        err = e;
      }
      expect(err, "must throw").to.be.instanceOf(RegistryAuthError);
      expect(err.message).to.match(/no contract at .* on this RPC/i);
      expect(err.message).to.match(/wrong address or wrong network/i);
      expect(err.detail.reason).to.equal("no-code");
    });

    it("hard-errors with the identity-failure message for a DEPLOYED non-registry (no REGISTRY_ID)", async function () {
      let err;
      try {
        await assertRegistry({ provider, contractAddress: notRegistryAddress });
      } catch (e) {
        err = e;
      }
      expect(err, "must throw").to.be.instanceOf(RegistryAuthError);
      expect(err.message).to.match(/is not a verifyhash ContributionRegistry/);
      expect(err.message).to.match(/refusing to trust its records/);
      expect(err.detail.reason).to.equal("no-registry-id");
    });

    it("hard-errors for a contract that LIES about REGISTRY_ID (wrong id)", async function () {
      let err;
      try {
        await assertRegistry({ provider, contractAddress: lyingRegistryAddress });
      } catch (e) {
        err = e;
      }
      expect(err, "must throw").to.be.instanceOf(RegistryAuthError);
      expect(err.message).to.match(/is not a verifyhash ContributionRegistry/);
      expect(err.message).to.match(/REGISTRY_ID mismatch/);
      expect(err.detail.reason).to.equal("registry-id-mismatch");
    });

    it("hard-errors on a chainId mismatch when expectedChainId is supplied", async function () {
      let err;
      try {
        await assertRegistry({
          provider,
          contractAddress: registryAddress,
          expectedChainId: chainId + 1, // deliberately wrong
        });
      } catch (e) {
        err = e;
      }
      expect(err, "must throw").to.be.instanceOf(RegistryAuthError);
      expect(err.message).to.match(/anchored on chainId/);
      expect(err.message).to.match(/refusing to report a verdict against the wrong network/);
      expect(err.detail.reason).to.equal("chainid-mismatch");
    });

    it("PASSES the chainId cross-check when expectedChainId matches the provider", async function () {
      const auth = await assertRegistry({
        provider,
        contractAddress: registryAddress,
        expectedChainId: chainId,
      });
      expect(auth.chainId).to.equal(chainId);
    });

    it("RE-THROWS a genuine RPC error as itself (never masquerades it as an identity failure)", async function () {
      // Point at a dead port so getCode fails with a real connection error.
      const deadProvider = new ethers.JsonRpcProvider("http://127.0.0.1:18599");
      let err;
      try {
        await assertRegistry({ provider: deadProvider, contractAddress: registryAddress });
      } catch (e) {
        err = e;
      }
      expect(err, "must throw").to.exist;
      // It is NOT a RegistryAuthError — a network failure is surfaced as the real error.
      expect(err).to.not.be.instanceOf(RegistryAuthError);
    });

    it("is side-effect-free: total() is unchanged after a preflight (read-only)", async function () {
      const ABI = require("../cli/registry").ABI;
      const c = new ethers.Contract(registryAddress, ABI, provider);
      const before = await c.total();
      await assertRegistry({ provider, contractAddress: registryAddress });
      expect(await c.total()).to.equal(before);
    });
  });

  // -------------------------------------------------------------------------------------------
  // vh verify — authenticated before any verdict.
  // -------------------------------------------------------------------------------------------
  describe("vh verify wiring", function () {
    async function anchoredFile() {
      const dir = tmp("vh-reg-verify-");
      const f = writeFile(dir, "c.txt", "verify content " + Date.now() + Math.random());
      await runAnchor({
        path: f,
        contractAddress: registryAddress,
        provider,
        signer: freshSigner(),
        log: () => {},
      });
      return f;
    }

    it("genuine registry: verify MATCHES and prints the 'registry authenticated' line + result.registry", async function () {
      const f = await anchoredFile();
      let out = "";
      const res = await runVerify({
        path: f,
        contractAddress: registryAddress,
        provider,
        log: (s) => (out += s),
      });
      expect(res.status).to.equal(VERIFY_STATUS.MATCH);
      expect(res.registry).to.not.equal(null);
      expect(res.registry.chainId).to.equal(chainId);
      expect(res.registry.registryVersion).to.equal(1);
      expect(out).to.match(/registry authenticated/i);
      expect(out).to.contain(String(chainId));
    });

    it("no-code address: verify hard-errors (no verdict) BEFORE reporting MATCH/MISMATCH", async function () {
      const f = await anchoredFile();
      let out = "";
      let err;
      try {
        await runVerify({
          path: f,
          contractAddress: noCodeAddress,
          provider,
          log: (s) => (out += s),
        });
      } catch (e) {
        err = e;
      }
      expect(err, "must throw").to.be.instanceOf(RegistryAuthError);
      expect(err.message).to.match(/no contract at/i);
      // It must NOT have reported a verdict.
      expect(out).to.not.match(/MATCH|MISMATCH/);
    });

    it("deployed non-registry: verify hard-errors with the identity message and reports NO verdict", async function () {
      const f = await anchoredFile();
      let out = "";
      let err;
      try {
        await runVerify({
          path: f,
          contractAddress: notRegistryAddress,
          provider,
          log: (s) => (out += s),
        });
      } catch (e) {
        err = e;
      }
      expect(err, "must throw").to.be.instanceOf(RegistryAuthError);
      expect(err.message).to.match(/is not a verifyhash ContributionRegistry/);
      expect(out).to.not.match(/MATCH|MISMATCH/);
    });

    it("--skip-identity-check bypasses the preflight LOUDLY and still produces a verdict", async function () {
      const f = await anchoredFile();
      let out = "";
      const res = await runVerify({
        path: f,
        contractAddress: registryAddress,
        provider,
        skipIdentityCheck: true,
        log: (s) => (out += s),
      });
      expect(res.status).to.equal(VERIFY_STATUS.MATCH);
      expect(res.registry).to.equal(null);
      expect(res.identitySkipped).to.equal(true);
      expect(out).to.match(/SKIPPED/);
      expect(out).to.match(/only as trustworthy as the RPC/i);
    });
  });

  // -------------------------------------------------------------------------------------------
  // vh show — authenticated before any record.
  // -------------------------------------------------------------------------------------------
  describe("vh show wiring", function () {
    let anchoredHash;
    before(async function () {
      const dir = tmp("vh-reg-show-");
      const f = writeFile(dir, "s.txt", "show content " + Date.now() + Math.random());
      anchoredHash = hashFile(f);
      await runAnchor({
        path: f,
        contractAddress: registryAddress,
        provider,
        signer: freshSigner(),
        log: () => {},
      });
    });

    it("genuine registry: show ANCHORED prints the registry line and --json carries the block", async function () {
      let humanOut = "";
      const res = await runShow({
        contentHash: anchoredHash,
        contractAddress: registryAddress,
        provider,
        log: (s) => (humanOut += s),
      });
      expect(res.status).to.equal(SHOW_STATUS.ANCHORED);
      expect(humanOut).to.match(/registry authenticated/i);

      let jsonOut = "";
      await runShow({
        contentHash: anchoredHash,
        contractAddress: registryAddress,
        provider,
        json: true,
        log: (s) => (jsonOut += s),
      });
      const parsed = JSON.parse(jsonOut);
      expect(parsed.registry).to.deep.equal({
        id: EXPECTED_REGISTRY_ID.toLowerCase(),
        version: 1,
        chainId,
      });
      expect(parsed.anchored).to.equal(true);
    });

    it("deployed non-registry: show hard-errors and reports NO record (no fake contributor leaks)", async function () {
      let out = "";
      let err;
      try {
        await runShow({
          contentHash: anchoredHash,
          contractAddress: notRegistryAddress,
          provider,
          log: (s) => (out += s),
        });
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(RegistryAuthError);
      // The lying contract's fabricated contributor must NEVER reach output.
      expect(out).to.not.match(/ANCHORED/);
      expect(out.toLowerCase()).to.not.contain("badc0ffee");
    });

    it("--skip-identity-check: show still reads (loud skip), --json carries the skipped block", async function () {
      let jsonOut = "";
      const res = await runShow({
        contentHash: anchoredHash,
        contractAddress: registryAddress,
        provider,
        json: true,
        skipIdentityCheck: true,
        log: (s) => (jsonOut += s),
      });
      expect(res.status).to.equal(SHOW_STATUS.ANCHORED);
      const parsed = JSON.parse(jsonOut);
      expect(parsed.registry.skipped).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------------------------
  // vh list — authenticated before enumerating.
  // -------------------------------------------------------------------------------------------
  describe("vh list wiring", function () {
    it("genuine registry: list prints the registry line; --json is an envelope { registry, records }", async function () {
      let humanOut = "";
      await runList({ contractAddress: registryAddress, provider, log: (s) => (humanOut += s) });
      expect(humanOut).to.match(/registry authenticated/i);

      let jsonOut = "";
      const res = await runList({
        contractAddress: registryAddress,
        provider,
        json: true,
        log: (s) => (jsonOut += s),
      });
      const parsed = JSON.parse(jsonOut);
      expect(parsed).to.have.property("registry");
      expect(parsed).to.have.property("records");
      expect(parsed.records).to.be.an("array");
      expect(parsed.registry).to.deep.equal({
        id: EXPECTED_REGISTRY_ID.toLowerCase(),
        version: 1,
        chainId,
      });
      expect(res.registry).to.deep.equal(parsed.registry);
    });

    it("deployed non-registry: list hard-errors and enumerates NOTHING", async function () {
      let out = "";
      let err;
      try {
        await runList({ contractAddress: notRegistryAddress, provider, log: (s) => (out += s) });
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(RegistryAuthError);
      expect(out).to.equal(""); // not even the trust caveat printed before the failure
    });

    it("--skip-identity-check: list enumerates with the loud skip block", async function () {
      let jsonOut = "";
      await runList({
        contractAddress: registryAddress,
        provider,
        json: true,
        skipIdentityCheck: true,
        log: (s) => (jsonOut += s),
      });
      const parsed = JSON.parse(jsonOut);
      expect(parsed.registry.skipped).to.equal(true);
      expect(parsed.records).to.be.an("array");
    });
  });

  // -------------------------------------------------------------------------------------------
  // vh lineage — authenticated before walking.
  // -------------------------------------------------------------------------------------------
  describe("vh lineage wiring", function () {
    let startHash;
    before(async function () {
      const dir = tmp("vh-reg-lineage-");
      const f = writeFile(dir, "l.txt", "lineage content " + Date.now() + Math.random());
      startHash = hashFile(f);
      await runAnchor({
        path: f,
        contractAddress: registryAddress,
        provider,
        signer: freshSigner(),
        log: () => {},
      });
    });

    it("genuine registry: lineage prints the registry line; --json carries the block", async function () {
      let humanOut = "";
      const res = await runLineage({
        contentHash: startHash,
        contractAddress: registryAddress,
        provider,
        log: (s) => (humanOut += s),
      });
      expect(res.status).to.equal("WALKED");
      expect(humanOut).to.match(/registry authenticated/i);

      let jsonOut = "";
      await runLineage({
        contentHash: startHash,
        contractAddress: registryAddress,
        provider,
        json: true,
        log: (s) => (jsonOut += s),
      });
      const parsed = JSON.parse(jsonOut);
      expect(parsed.registry).to.deep.equal({
        id: EXPECTED_REGISTRY_ID.toLowerCase(),
        version: 1,
        chainId,
      });
    });

    it("deployed non-registry: lineage hard-errors and walks NOTHING", async function () {
      let out = "";
      let err;
      try {
        await runLineage({
          contentHash: startHash,
          contractAddress: notRegistryAddress,
          provider,
          log: (s) => (out += s),
        });
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(RegistryAuthError);
      expect(out).to.equal("");
    });

    it("--skip-identity-check: lineage walks with the loud skip block", async function () {
      let jsonOut = "";
      await runLineage({
        contentHash: startHash,
        contractAddress: registryAddress,
        provider,
        json: true,
        skipIdentityCheck: true,
        log: (s) => (jsonOut += s),
      });
      const parsed = JSON.parse(jsonOut);
      expect(parsed.registry.skipped).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------------------------
  // vh verify-proof — authenticated AND chainId cross-checked against the artifact (T-9.2 chainId).
  // -------------------------------------------------------------------------------------------
  describe("vh verify-proof wiring (artifact chainId cross-check)", function () {
    function makeRepo(prefix) {
      const dir = tmp(prefix);
      const stamp = Date.now() + "-" + Math.random().toString(16).slice(2);
      writeFile(dir, "README.md", "# project " + stamp);
      writeFile(dir, "src/index.js", "module.exports = 1; // " + stamp);
      writeFile(dir, "src/util.js", "function u(){} // " + stamp);
      return dir;
    }

    // Anchor a repo and build a portable artifact that records contractAddress + the CURRENT chainId.
    async function anchorAndProve(prefix, relFile) {
      const dir = makeRepo(prefix);
      await runAnchor({
        path: dir,
        contractAddress: registryAddress,
        provider,
        signer: freshSigner(),
        log: () => {},
      });
      const outDir = tmp(prefix + "out-");
      const p = path.join(outDir, "proof.json");
      // Build through the ON-CHAIN prove path so the artifact records the real chainId.
      await runProve({
        file: relFile,
        rootDir: dir,
        out: p,
        contractAddress: registryAddress,
        provider,
        log: () => {},
      });
      return { dir, artifactPath: p };
    }

    it("genuine registry + matching artifact chainId: ACCEPTS and prints/carries the registry block", async function () {
      const { artifactPath } = await anchorAndProve("vh-reg-vp-accept-", "src/index.js");
      const art = readProofArtifact(artifactPath);
      expect(art.chainId).to.equal(chainId);

      let humanOut = "";
      const res = await runVerifyProof({
        artifactPath,
        provider,
        log: (s) => (humanOut += s),
      });
      expect(res.status).to.equal(PROOF_STATUS.ACCEPTED);
      expect(res.registry).to.not.equal(null);
      expect(humanOut).to.match(/registry authenticated/i);

      let jsonOut = "";
      await runVerifyProof({ artifactPath, provider, json: true, log: (s) => (jsonOut += s) });
      const parsed = JSON.parse(jsonOut);
      expect(parsed.registry).to.deep.equal({
        id: EXPECTED_REGISTRY_ID.toLowerCase(),
        version: 1,
        chainId,
      });
      expect(parsed.accepted).to.equal(true);
    });

    it("artifact chainId that does NOT match the provider chainId hard-errors (NO verdict)", async function () {
      const { artifactPath } = await anchorAndProve("vh-reg-vp-chainmiss-", "src/util.js");
      // Rewrite the artifact's recorded chainId to a value the provider is NOT on.
      const art = readProofArtifact(artifactPath);
      art.chainId = chainId + 7;
      writeProofArtifact(art, artifactPath);

      let out = "";
      let err;
      try {
        await runVerifyProof({ artifactPath, provider, log: (s) => (out += s) });
      } catch (e) {
        err = e;
      }
      expect(err, "must throw").to.be.instanceOf(RegistryAuthError);
      expect(err.message).to.match(/anchored on chainId/);
      expect(err.message).to.match(/wrong network/);
      expect(out).to.not.match(/ACCEPTED|REJECTED|NOT ANCHORED/);
    });

    it("the SAME artifact against the MATCHING chain still ACCEPTS (cross-check is correct, not paranoid)", async function () {
      const { artifactPath } = await anchorAndProve("vh-reg-vp-same-", "README.md");
      // Untouched artifact (chainId == provider chainId) accepts.
      const res = await runVerifyProof({ artifactPath, provider, log: () => {} });
      expect(res.status).to.equal(PROOF_STATUS.ACCEPTED);
    });

    it("deployed non-registry contract: verify-proof hard-errors (no false ACCEPT off a lying isAnchored)", async function () {
      const { artifactPath } = await anchorAndProve("vh-reg-vp-nonreg-", "src/index.js");
      let out = "";
      let err;
      try {
        // Override the contract to the lying non-registry; its isAnchored() returns true for everything.
        await runVerifyProof({
          artifactPath,
          contractAddress: notRegistryAddress,
          provider,
          log: (s) => (out += s),
        });
      } catch (e) {
        err = e;
      }
      expect(err, "must throw").to.be.instanceOf(RegistryAuthError);
      expect(err.message).to.match(/is not a verifyhash ContributionRegistry/);
      // Without the preflight, the lying isAnchored would have produced a false ACCEPTED.
      expect(out).to.not.match(/ACCEPTED/);
    });

    it("--skip-identity-check: verify-proof runs the chain leg with the loud skip block", async function () {
      const { artifactPath } = await anchorAndProve("vh-reg-vp-skip-", "src/util.js");
      // Even with a mismatched chainId recorded, the skip flag bypasses the cross-check.
      const art = readProofArtifact(artifactPath);
      art.chainId = chainId + 11;
      writeProofArtifact(art, artifactPath);

      let jsonOut = "";
      const res = await runVerifyProof({
        artifactPath,
        provider,
        json: true,
        skipIdentityCheck: true,
        log: (s) => (jsonOut += s),
      });
      // Skipping the preflight means the chainId mismatch is NOT enforced; the on-chain checks run.
      expect(res.status).to.equal(PROOF_STATUS.ACCEPTED);
      const parsed = JSON.parse(jsonOut);
      expect(parsed.registry.skipped).to.equal(true);
    });
  });
});

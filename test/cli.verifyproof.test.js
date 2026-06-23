const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");

const { runProve } = require("../cli/prove");
const {
  buildProofArtifact,
  writeProofArtifact,
  readProofArtifact,
  recomputeFold,
  runVerifyProof,
  PROOF_KIND,
  PROOF_SCHEMA_VERSION,
  STATUS,
  TRUST_CAVEAT,
  ABI,
} = require("../cli/proof");
const { buildProof } = require("../cli/prove");
const { runAnchor } = require("../cli/anchor");
const { hashDir, pathLeaf } = require("../cli/hash");

// ---------------------------------------------------------------------------
// Helpers: throwaway temp dirs (always cleaned up, pass OR fail) + a real local
// hardhat JSON-RPC node, mirroring cli.prove.test.js / cli.verify.test.js.
// ---------------------------------------------------------------------------

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

// ===========================================================================
// PART 1 — Offline-only: schema validation + the offline fold WITHOUT a network.
// This part deliberately needs NO hardhat node: the recompute step is exercised
// purely offline, which is the portability property under test.
// ===========================================================================
describe("cli: vh verify-proof — offline artifact + fold (NO network)", function () {
  let offDirs = [];
  function offTmp(prefix) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    offDirs.push(d);
    return d;
  }
  function makeRepo(prefix) {
    const dir = offTmp(prefix);
    const stamp = Date.now() + "-" + Math.random().toString(16).slice(2);
    writeFile(dir, "README.md", "# project " + stamp);
    writeFile(dir, "src/index.js", "module.exports = 1; // " + stamp);
    writeFile(dir, "src/util.js", "function u(){} // " + stamp);
    writeFile(dir, "src/lib/math.js", "exports.add = (a,b)=>a+b; // " + stamp);
    writeFile(dir, "docs/guide.txt", "how to use it " + stamp);
    return dir;
  }
  after(function () {
    for (const d of offDirs) fs.rmSync(d, { recursive: true, force: true });
    offDirs = [];
  });

  it("buildProofArtifact produces a versioned, self-contained schema for the named file", function () {
    const dir = makeRepo("vh-vp-build-");
    const built = buildProof({ file: "src/index.js", rootDir: dir });
    const art = buildProofArtifact(built, {
      contractAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      chainId: 31337,
    });
    expect(art.kind).to.equal(PROOF_KIND);
    expect(art.schemaVersion).to.equal(PROOF_SCHEMA_VERSION);
    expect(art.root).to.equal(built.root);
    expect(art.leaf).to.equal(built.leaf);
    expect(art.contentHash).to.equal(built.contentHash);
    expect(art.relPath).to.equal("src/index.js");
    expect(art.proof).to.deep.equal(built.proof);
    expect(art.contractAddress).to.equal("0x5FbDB2315678afecb367f032d93F642f64180aa3");
    expect(art.chainId).to.equal(31337);
  });

  it("write+read round-trips and validates strictly", function () {
    const dir = makeRepo("vh-vp-rt-");
    const built = buildProof({ file: "docs/guide.txt", rootDir: dir });
    const art = buildProofArtifact(built);
    const out = offTmp("vh-vp-rt-out-");
    const p = path.join(out, "proof.json");
    writeProofArtifact(art, p);
    const back = readProofArtifact(p);
    expect(back).to.deep.equal(art);
  });

  it("the offline fold re-derives the leaf and folds to the root with NO network", function () {
    const dir = makeRepo("vh-vp-fold-");
    const built = buildProof({ file: "src/lib/math.js", rootDir: dir });
    const art = buildProofArtifact(built);

    const fold = recomputeFold(art);
    // The leaf is RE-DERIVED from contentHash+relPath (not trusted from the file).
    expect(fold.derivedLeaf).to.equal(pathLeaf("src/lib/math.js", art.contentHash));
    expect(fold.leafMatches).to.equal(true);
    expect(fold.foldsToRoot).to.equal(true);
    expect(fold.computedRoot).to.equal(built.root);
    expect(fold.offlineOk).to.equal(true);

    // Independent cross-check: the recomputed root must equal hashDir's root for this repo.
    expect(fold.computedRoot).to.equal(hashDir(dir).root);
  });

  it("runVerifyProof with NO provider exercises the offline fold and does NOT claim ACCEPTED", async function () {
    const dir = makeRepo("vh-vp-offline-");
    const built = buildProof({ file: "src/util.js", rootDir: dir });
    const out = offTmp("vh-vp-offline-out-");
    const p = path.join(out, "proof.json");
    writeProofArtifact(buildProofArtifact(built), p);

    let log = "";
    const res = await runVerifyProof({ artifactPath: p, log: (s) => (log += s) });
    // Offline fold passed...
    expect(res.offlineOk).to.equal(true);
    expect(res.leafMatches).to.equal(true);
    expect(res.foldsToRoot).to.equal(true);
    // ...but with no on-chain leg the verdict is NOT ACCEPTED (acceptance requires the chain check).
    expect(res.status).to.not.equal(STATUS.ACCEPTED);
    expect(res.checkedChain).to.equal(false);
    // And it LEADS with the trust-boundary one-liner (set-membership, not authorship).
    expect(log).to.contain(TRUST_CAVEAT.split("\n")[0]);
  });

  it("a tampered `proof` field folds to a DIFFERENT root (never silently OK) — offline", function () {
    const dir = makeRepo("vh-vp-tamper-proof-");
    const built = buildProof({ file: "README.md", rootDir: dir });
    const art = buildProofArtifact(built);
    const bad = JSON.parse(JSON.stringify(art));
    // Flip one sibling to a value that can't possibly fold to the same root.
    bad.proof[0] = "0x" + "ab".repeat(32);
    const fold = recomputeFold(bad);
    expect(fold.leafMatches).to.equal(true); // leaf still derives fine
    expect(fold.foldsToRoot).to.equal(false); // ...but the fold no longer reaches root
    expect(fold.offlineOk).to.equal(false);
  });

  it("a tampered `contentHash` breaks the leaf re-derivation — offline", function () {
    const dir = makeRepo("vh-vp-tamper-ch-");
    const built = buildProof({ file: "src/index.js", rootDir: dir });
    const art = buildProofArtifact(built);
    const bad = JSON.parse(JSON.stringify(art));
    bad.contentHash = "0x" + "11".repeat(32);
    const fold = recomputeFold(bad);
    expect(fold.leafMatches).to.equal(false); // re-derived leaf no longer matches the stored leaf
    expect(fold.offlineOk).to.equal(false);
  });

  it("a tampered `leaf` field is caught: it no longer equals pathLeaf(contentHash, relPath)", function () {
    const dir = makeRepo("vh-vp-tamper-leaf-");
    const built = buildProof({ file: "src/util.js", rootDir: dir });
    const art = buildProofArtifact(built);
    const bad = JSON.parse(JSON.stringify(art));
    bad.leaf = "0x" + "22".repeat(32);
    const fold = recomputeFold(bad);
    expect(fold.leafMatches).to.equal(false);
    expect(fold.offlineOk).to.equal(false);
  });

  describe("strict validation hard-errors (never silently accepts)", function () {
    function validArt() {
      const dir = makeRepo("vh-vp-valid-");
      return buildProofArtifact(buildProof({ file: "README.md", rootDir: dir }));
    }
    it("rejects a wrong kind", function () {
      const a = validArt();
      a.kind = "verifyhash.claim-receipt";
      expect(() => writeProofArtifact(a, path.join(offTmp("x-"), "p.json"))).to.throw(
        /not a verifyhash proof artifact/i
      );
    });
    it("rejects an unsupported schemaVersion", function () {
      const a = validArt();
      a.schemaVersion = 99;
      expect(() => writeProofArtifact(a, path.join(offTmp("x-"), "p.json"))).to.throw(
        /unsupported proof artifact schemaVersion/i
      );
    });
    it("rejects a short/malformed root hash", function () {
      const a = validArt();
      a.root = "0xdead";
      expect(() => writeProofArtifact(a, path.join(offTmp("x-"), "p.json"))).to.throw(
        /root must be a 0x-prefixed 32-byte hex/i
      );
    });
    it("rejects a non-hex proof sibling", function () {
      const a = validArt();
      a.proof = [...a.proof, "not-hex"];
      expect(() => writeProofArtifact(a, path.join(offTmp("x-"), "p.json"))).to.throw(
        /proof\[\d+\] must be a 0x-prefixed 32-byte hex/i
      );
    });
    it("rejects a proof that is not an array", function () {
      const a = validArt();
      a.proof = "0xabc";
      expect(() => writeProofArtifact(a, path.join(offTmp("x-"), "p.json"))).to.throw(
        /proof must be an array/i
      );
    });
    it("rejects an empty relPath", function () {
      const a = validArt();
      a.relPath = "";
      expect(() => writeProofArtifact(a, path.join(offTmp("x-"), "p.json"))).to.throw(
        /relPath must be a non-empty string/i
      );
    });
    it("readProofArtifact rejects non-JSON and a missing file", function () {
      const out = offTmp("vh-vp-bad-");
      const p = path.join(out, "garbage.json");
      fs.writeFileSync(p, "{ this is not json");
      expect(() => readProofArtifact(p)).to.throw(/is not valid JSON/i);
      expect(() => readProofArtifact(path.join(out, "nope.json"))).to.throw(/cannot read proof artifact/i);
    });
  });
});

// ===========================================================================
// PART 2 — End-to-end against a LIVE hardhat node. This is the heart of the
// acceptance criteria: build --out then verify-proof needing ONLY the artifact
// + an RPC URL (no repo), ACCEPT a genuine proof, REJECT a tampered one, and
// report NOT ANCHORED for a never-anchored root.
// ===========================================================================
describe("cli: vh verify-proof — end-to-end on a local hardhat node", function () {
  this.timeout(60000);

  const PORT = 18549; // distinct from the other suites' ports so nodes never collide
  const RPC_URL = `http://127.0.0.1:${PORT}`;
  let nodeProc;
  let provider;
  let registryAddress;

  // Distinct dev signers for submissions so a tx never contends on a provider-cached nonce.
  const DEV_KEYS = [
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // #1
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // #3
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // #4
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // #5
    "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // #6
    "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356", // #7
    "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97", // #8
  ];
  let keyIdx = 0;
  function freshSigner() {
    const k = DEV_KEYS[keyIdx++];
    if (!k) throw new Error("ran out of dev keys for the test");
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
    const deployer = new ethers.Wallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // #0
      provider
    );
    const Factory = await ethers.getContractFactory("ContributionRegistry", deployer);
    const registry = await Factory.deploy();
    await registry.waitForDeployment();
    registryAddress = await registry.getAddress();
  });

  after(function () {
    if (nodeProc) nodeProc.kill("SIGKILL");
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  function makeRepo(prefix) {
    const dir = tmp(prefix);
    const stamp = Date.now() + "-" + Math.random().toString(16).slice(2);
    writeFile(dir, "README.md", "# project " + stamp);
    writeFile(dir, "src/index.js", "module.exports = 1; // " + stamp);
    writeFile(dir, "src/util.js", "function u(){} // " + stamp);
    writeFile(dir, "src/lib/math.js", "exports.add = (a,b)=>a+b; // " + stamp);
    writeFile(dir, "docs/guide.txt", "how to use it " + stamp);
    return dir;
  }

  // Build a portable artifact via `vh prove --out` (the no-key build path), then verify it. Returns
  // the artifact PATH (in a temp dir, cleaned up by `after`).
  async function proveOut(dir, relFile, outDir) {
    const p = path.join(outDir, "proof.json");
    const res = await runProve({
      file: relFile,
      rootDir: dir,
      out: p,
      dryRun: true, // no key, no network needed to BUILD + write the artifact
      log: () => {},
    });
    expect(res.out).to.equal(p);
    expect(fs.existsSync(p), "artifact file written").to.equal(true);
    return p;
  }

  it("build --out then verify-proof ACCEPTS a genuine proof (artifact + RPC only, no repo)", async function () {
    const dir = makeRepo("vh-vp-e2e-accept-");
    const expectedRoot = hashDir(dir).root;

    // Anchor the repo root once.
    await runAnchor({
      path: dir,
      contractAddress: registryAddress,
      provider,
      signer: freshSigner(),
      log: () => {},
    });
    const registry = new ethers.Contract(registryAddress, ABI, provider);
    expect(await registry.isAnchored(expectedRoot)).to.equal(true);

    // Build the portable artifact in a temp dir (no key) — for EVERY file.
    const outDir = tmp("vh-vp-e2e-accept-out-");
    const files = ["README.md", "src/index.js", "src/util.js", "src/lib/math.js", "docs/guide.txt"];
    for (const rel of files) {
      const p = await proveOut(dir, rel, fs.mkdtempSync(path.join(outDir, "f-")));

      // Verify needing ONLY the artifact + the provider — we never pass `dir` to verify-proof.
      let log = "";
      const res = await runVerifyProof({
        artifactPath: p,
        contractAddress: registryAddress,
        provider,
        log: (s) => (log += s),
      });
      expect(res.status, `ACCEPTED for ${rel}`).to.equal(STATUS.ACCEPTED);
      expect(res.offlineOk).to.equal(true);
      expect(res.rootAnchored).to.equal(true);
      expect(res.onChainVerified).to.equal(true);
      // Leads with the trust-boundary one-liner.
      expect(log).to.contain(TRUST_CAVEAT.split("\n")[0]);
      expect(log).to.contain("ACCEPTED");
    }
  });

  it("the artifact records its contractAddress so verify-proof needs NO --contract", async function () {
    const dir = makeRepo("vh-vp-e2e-selfdesc-");
    const expectedRoot = hashDir(dir).root;
    await runAnchor({
      path: dir,
      contractAddress: registryAddress,
      provider,
      signer: freshSigner(),
      log: () => {},
    });

    // Build the artifact through the ON-CHAIN prove path so it records contractAddress + chainId.
    const outDir = tmp("vh-vp-e2e-selfdesc-out-");
    const p = path.join(outDir, "proof.json");
    const proveRes = await runProve({
      file: "src/index.js",
      rootDir: dir,
      out: p,
      contractAddress: registryAddress,
      provider,
      log: () => {},
    });
    expect(proveRes.accepted).to.equal(true);
    const art = readProofArtifact(p);
    expect(art.contractAddress.toLowerCase()).to.equal(registryAddress.toLowerCase());
    expect(typeof art.chainId).to.equal("number");

    // Verify with NO explicit --contract: it falls back to the artifact's recorded address.
    const res = await runVerifyProof({ artifactPath: p, provider, log: () => {} });
    expect(res.status).to.equal(STATUS.ACCEPTED);
    expect(res.root).to.equal(expectedRoot);
  });

  it("tampering the artifact's proof REJECTS (never a false ACCEPT)", async function () {
    const dir = makeRepo("vh-vp-e2e-tamper-proof-");
    await runAnchor({
      path: dir,
      contractAddress: registryAddress,
      provider,
      signer: freshSigner(),
      log: () => {},
    });

    const outDir = tmp("vh-vp-e2e-tamper-proof-out-");
    const p = await proveOut(dir, "src/util.js", outDir);

    // Tamper one sibling of the proof on disk.
    const art = readProofArtifact(p);
    art.proof[0] = "0x" + "cd".repeat(32);
    writeProofArtifact(art, p);

    let log = "";
    const res = await runVerifyProof({
      artifactPath: p,
      contractAddress: registryAddress,
      provider,
      log: (s) => (log += s),
    });
    expect(res.status).to.equal(STATUS.REJECTED);
    expect(res.foldsToRoot).to.equal(false);
    expect(log).to.contain("REJECTED");
  });

  it("tampering the artifact's leaf REJECTS", async function () {
    const dir = makeRepo("vh-vp-e2e-tamper-leaf-");
    await runAnchor({
      path: dir,
      contractAddress: registryAddress,
      provider,
      signer: freshSigner(),
      log: () => {},
    });

    const outDir = tmp("vh-vp-e2e-tamper-leaf-out-");
    const p = await proveOut(dir, "README.md", outDir);
    const art = readProofArtifact(p);
    art.leaf = "0x" + "ef".repeat(32);
    writeProofArtifact(art, p);

    const res = await runVerifyProof({
      artifactPath: p,
      contractAddress: registryAddress,
      provider,
      log: () => {},
    });
    expect(res.status).to.equal(STATUS.REJECTED);
    expect(res.leafMatches).to.equal(false);
  });

  it("tampering the artifact's contentHash REJECTS", async function () {
    const dir = makeRepo("vh-vp-e2e-tamper-ch-");
    await runAnchor({
      path: dir,
      contractAddress: registryAddress,
      provider,
      signer: freshSigner(),
      log: () => {},
    });

    const outDir = tmp("vh-vp-e2e-tamper-ch-out-");
    const p = await proveOut(dir, "src/lib/math.js", outDir);
    const art = readProofArtifact(p);
    art.contentHash = "0x" + "01".repeat(32);
    writeProofArtifact(art, p);

    const res = await runVerifyProof({
      artifactPath: p,
      contractAddress: registryAddress,
      provider,
      log: () => {},
    });
    expect(res.status).to.equal(STATUS.REJECTED);
    expect(res.leafMatches).to.equal(false);
  });

  it("an artifact whose root was NEVER anchored reports NOT ANCHORED (not a false ACCEPT)", async function () {
    const dir = makeRepo("vh-vp-e2e-unanchored-");
    // Deliberately do NOT anchor this repo's root.
    const outDir = tmp("vh-vp-e2e-unanchored-out-");
    const p = await proveOut(dir, "README.md", outDir);

    const res = await runVerifyProof({
      artifactPath: p,
      contractAddress: registryAddress,
      provider,
      log: () => {},
    });
    // The proof folds fine OFFLINE, but the root was never anchored -> NOT ANCHORED, not ACCEPTED.
    expect(res.offlineOk).to.equal(true);
    expect(res.status).to.equal(STATUS.NOT_ANCHORED);
    expect(res.rootAnchored).to.equal(false);
  });

  it("--json round-trips: machine output carries the same verdict + per-check booleans", async function () {
    const dir = makeRepo("vh-vp-e2e-json-");
    await runAnchor({
      path: dir,
      contractAddress: registryAddress,
      provider,
      signer: freshSigner(),
      log: () => {},
    });

    const outDir = tmp("vh-vp-e2e-json-out-");
    const p = await proveOut(dir, "src/index.js", outDir);

    let out = "";
    const res = await runVerifyProof({
      artifactPath: p,
      contractAddress: registryAddress,
      provider,
      json: true,
      log: (s) => (out += s),
    });
    const parsed = JSON.parse(out);
    expect(parsed.kind).to.equal(PROOF_KIND);
    expect(parsed.accepted).to.equal(true);
    expect(parsed.status).to.equal(STATUS.ACCEPTED);
    expect(parsed.offline.ok).to.equal(true);
    expect(parsed.offline.leafMatches).to.equal(true);
    expect(parsed.offline.foldsToRoot).to.equal(true);
    expect(parsed.onChain.checked).to.equal(true);
    expect(parsed.onChain.rootAnchored).to.equal(true);
    expect(parsed.onChain.verifyLeaf).to.equal(true);
    expect(parsed.contentHash).to.equal(res.contentHash);
    expect(parsed.root).to.equal(res.root);
    // The JSON carries the trust note too.
    expect(parsed.trustNote).to.contain("SET-MEMBERSHIP");
  });
});

// ===========================================================================
// PART 3 — CLI surface (cli/vh.js): arg parsing + exit codes. No node needed
// for the parser tests; the exit-code tests isolate FS effects to a temp dir.
// ===========================================================================
describe("cli surface: vh verify-proof + vh prove --out (cli/vh.js)", function () {
  const { parseVerifyProofArgs, parseProveArgs, cmdVerifyProof, cmdProve } = require("../cli/vh");

  let cliTmpDirs = [];
  function cliTmp(prefix) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cliTmpDirs.push(d);
    return d;
  }
  afterEach(function () {
    for (const d of cliTmpDirs) fs.rmSync(d, { recursive: true, force: true });
    cliTmpDirs = [];
  });

  describe("parseVerifyProofArgs", function () {
    it("parses <p>, --contract, --rpc, --json", function () {
      const o = parseVerifyProofArgs(["proof.json", "--contract", "0xabc", "--rpc", "http://x", "--json"]);
      expect(o.artifact).to.equal("proof.json");
      expect(o.contract).to.equal("0xabc");
      expect(o.rpc).to.equal("http://x");
      expect(o.json).to.equal(true);
    });
    it("rejects an unknown flag (a typo must not silently change behavior)", function () {
      expect(() => parseVerifyProofArgs(["p.json", "--nope"])).to.throw(/unknown flag/i);
    });
    it("rejects a duplicate positional", function () {
      expect(() => parseVerifyProofArgs(["a.json", "b.json"])).to.throw(/unexpected extra argument/i);
    });
    it("rejects --contract with no value", function () {
      expect(() => parseVerifyProofArgs(["p.json", "--contract"])).to.throw(/--contract requires a value/);
    });
  });

  describe("parseProveArgs --out", function () {
    it("parses --out", function () {
      const o = parseProveArgs(["f", "--root", "./r", "--out", "./proof.json"]);
      expect(o.out).to.equal("./proof.json");
    });
    it("rejects --out with no value", function () {
      expect(() => parseProveArgs(["f", "--out"])).to.throw(/--out requires a value/);
    });
  });

  describe("cmdVerifyProof", function () {
    let saved;
    beforeEach(function () {
      saved = {
        PRIVATE_KEY: process.env.PRIVATE_KEY,
        VH_RPC_URL: process.env.VH_RPC_URL,
        AMOY_RPC_URL: process.env.AMOY_RPC_URL,
        VH_CONTRACT: process.env.VH_CONTRACT,
      };
      delete process.env.PRIVATE_KEY;
      delete process.env.VH_RPC_URL;
      delete process.env.AMOY_RPC_URL;
      delete process.env.VH_CONTRACT;
    });
    afterEach(function () {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it("requires a <p> and exits 2 without it", async function () {
      const errs = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = (s) => (errs.push(s), true);
      let code;
      try {
        code = await cmdVerifyProof([]);
      } finally {
        process.stderr.write = orig;
      }
      expect(code).to.equal(2);
      expect(errs.join("")).to.match(/requires a <p>/);
    });

    it("exits 1 with a clean error when no RPC is configured", async function () {
      const dir = cliTmp("vh-cli-vp-norpc-");
      const p = path.join(dir, "proof.json");
      // A minimally-valid artifact so the failure is the RPC check, not validation.
      const built = buildProof({
        file: writeFile(dir, "a.txt", "alpha") && "a.txt",
        rootDir: dir,
      });
      writeProofArtifact(buildProofArtifact(built), p);

      const errs = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = (s) => (errs.push(s), true);
      let code;
      try {
        code = await cmdVerifyProof([p, "--contract", "0x5FbDB2315678afecb367f032d93F642f64180aa3"]);
      } finally {
        process.stderr.write = orig;
      }
      expect(code).to.equal(1);
      expect(errs.join("")).to.match(/RPC/i);
    });

    it("`vh prove --out --dry-run` writes the artifact with NO key/RPC and exits 0", async function () {
      const dir = cliTmp("vh-cli-prove-out-");
      writeFile(dir, "a.txt", "alpha");
      writeFile(dir, "b.txt", "beta");
      const outDir = cliTmp("vh-cli-prove-out-dest-");
      const p = path.join(outDir, "proof.json");

      const writes = [];
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = (s) => (writes.push(s), true);
      let code;
      try {
        code = await cmdProve(["a.txt", "--root", dir, "--out", p, "--dry-run"]);
      } finally {
        process.stdout.write = orig;
      }
      expect(code).to.equal(0);
      expect(fs.existsSync(p), "artifact written by --out").to.equal(true);
      const art = readProofArtifact(p);
      expect(art.kind).to.equal(PROOF_KIND);
      expect(art.relPath).to.equal("a.txt");
      expect(writes.join("")).to.contain(p); // the exact path is named in the output
    });
  });
});

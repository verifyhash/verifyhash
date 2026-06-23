const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");

const { runVerify, isNotAnchoredError, STATUS } = require("../cli/verify");
const { runAnchor, ABI } = require("../cli/anchor");
const { hashFile } = require("../cli/hash");

// ---------------------------------------------------------------------------
// Helpers: throwaway temp dirs + a real local hardhat JSON-RPC node, mirroring
// the integration setup used by cli.anchor.test.js.
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

describe("cli: vh verify", function () {
  this.timeout(60000);

  const PORT = 18546; // distinct from the anchor test's port so the two suites never collide
  const RPC_URL = `http://127.0.0.1:${PORT}`;
  let nodeProc;
  let provider;
  let signer; // account #0: deployer only
  let registryAddress;

  // Hand out distinct dev signers for anchoring submissions so a tx never contends on the
  // deployer's provider-cached nonce (the deployer already used a nonce in `before`).
  const DEV_KEYS = [
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // #1
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // #3
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
    signer = new ethers.Wallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // hardhat #0
      provider
    );

    const Factory = await ethers.getContractFactory("ContributionRegistry", signer);
    const registry = await Factory.deploy();
    await registry.waitForDeployment();
    registryAddress = await registry.getAddress();
  });

  after(function () {
    if (nodeProc) nodeProc.kill("SIGKILL");
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  // -------------------------------------------------------------------------
  // THE core acceptance criterion: a one-byte edit flips MATCH -> MISMATCH.
  // -------------------------------------------------------------------------
  it("a one-byte edit to an anchored file flips the result from MATCH to MISMATCH", async function () {
    const dir = tmp("vh-verify-tamper-");
    const original = "the integrity of this file is anchored on-chain " + Date.now();
    const f = writeFile(dir, "contribution.txt", original);
    const anchoredHash = hashFile(f);
    const anchorer = freshSigner();
    const anchorerAddr = await anchorer.getAddress();

    // 1) Anchor the file's content hash on the live node.
    const anchorRes = await runAnchor({
      path: f,
      uri: "https://example.com/commit/deadbeef",
      contractAddress: registryAddress,
      provider,
      signer: anchorer,
      log: () => {},
    });
    expect(anchorRes.anchored, "file should anchor").to.not.equal(null);

    // 2) Verify the UNMODIFIED file: must MATCH and report the recorded contributor + timestamp.
    let matchOut = "";
    const matchRes = await runVerify({
      path: f,
      contractAddress: registryAddress,
      provider,
      log: (s) => (matchOut += s),
    });
    expect(matchRes.status).to.equal(STATUS.MATCH);
    expect(matchRes.contentHash).to.equal(anchoredHash);
    expect(matchRes.contributor).to.equal(anchorerAddr);
    // Timestamp is the block timestamp captured at anchor time — a positive unix-seconds value.
    expect(matchRes.timestamp).to.be.a("bigint");
    expect(matchRes.timestamp > 0n).to.equal(true);
    expect(matchRes.uri).to.equal("https://example.com/commit/deadbeef");
    // Human output prints match + contributor + timestamp (the acceptance fields).
    expect(matchOut).to.match(/MATCH/);
    expect(matchOut).to.contain(anchorerAddr);
    expect(matchOut).to.contain(String(matchRes.timestamp));

    // 3) Tamper: flip exactly ONE byte of the file on disk.
    const buf = fs.readFileSync(f);
    expect(buf.length).to.be.greaterThan(0);
    const idx = Math.floor(buf.length / 2);
    const tamperedBuf = Buffer.from(buf);
    tamperedBuf[idx] = tamperedBuf[idx] ^ 0x01; // single-bit -> single-byte change
    fs.writeFileSync(f, tamperedBuf);

    // Sanity: exactly one byte differs, and the file is the same length.
    expect(tamperedBuf.length).to.equal(buf.length);
    let differingBytes = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] !== tamperedBuf[i]) differingBytes++;
    expect(differingBytes, "exactly one byte should differ").to.equal(1);

    // The recomputed hash must now differ from what was anchored.
    expect(hashFile(f)).to.not.equal(anchoredHash);

    // 4) Verify the TAMPERED file: must flip to MISMATCH (its new hash is not anchored).
    let mismatchOut = "";
    const mismatchRes = await runVerify({
      path: f,
      contractAddress: registryAddress,
      provider,
      log: (s) => (mismatchOut += s),
    });
    expect(mismatchRes.status).to.equal(STATUS.MISMATCH);
    expect(mismatchRes.contentHash).to.not.equal(anchoredHash);
    expect(mismatchRes.contributor).to.equal(null);
    expect(mismatchRes.timestamp).to.equal(null);
    expect(mismatchOut).to.match(/MISMATCH/);

    // 5) Restore the original byte -> hash returns to the anchored value -> MATCH again.
    fs.writeFileSync(f, buf);
    expect(hashFile(f)).to.equal(anchoredHash);
    const restoredRes = await runVerify({
      path: f,
      contractAddress: registryAddress,
      provider,
      log: () => {},
    });
    expect(restoredRes.status).to.equal(STATUS.MATCH);
    expect(restoredRes.contributor).to.equal(anchorerAddr);
  });

  it("verify is read-only: it does not change on-chain state (total unchanged, nothing anchored)", async function () {
    const registry = new ethers.Contract(registryAddress, ABI, provider);
    const before = await registry.total();

    const dir = tmp("vh-verify-readonly-");
    const f = writeFile(dir, "never-anchored.txt", "this file is never anchored " + Date.now());

    // Verifying with NO signer must work (read-only) and report MISMATCH for never-anchored content.
    const res = await runVerify({
      path: f,
      contractAddress: registryAddress,
      provider,
      log: () => {},
    });
    expect(res.status).to.equal(STATUS.MISMATCH);

    const after = await registry.total();
    expect(after).to.equal(before); // a verify wrote nothing
    expect(await registry.isAnchored(hashFile(f))).to.equal(false);
  });

  it("reports MISMATCH for content that was never anchored (not just for tampered content)", async function () {
    const dir = tmp("vh-verify-unanchored-");
    const f = writeFile(dir, "fresh.txt", "totally fresh, unseen content " + Date.now());
    const res = await runVerify({
      path: f,
      contractAddress: registryAddress,
      provider,
      log: () => {},
    });
    expect(res.status).to.equal(STATUS.MISMATCH);
    expect(res.contributor).to.equal(null);
  });

  it("surfaces a genuine RPC error instead of masquerading it as MISMATCH", async function () {
    const dir = tmp("vh-verify-badrpc-");
    const f = writeFile(dir, "x.txt", "content " + Date.now());
    // Point at a dead port so getRecord() fails with a network error, NOT NotAnchored.
    const deadProvider = new ethers.JsonRpcProvider("http://127.0.0.1:1"); // nothing listening

    let err = null;
    try {
      await runVerify({
        path: f,
        contractAddress: registryAddress,
        provider: deadProvider,
        log: () => {},
      });
    } catch (e) {
      err = e;
    }
    expect(err, "a network failure must throw, not silently report MISMATCH").to.not.equal(null);
    expect(/NotAnchored/.test(String(err.message))).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // Input validation (pure, no node needed for these branches).
  // -------------------------------------------------------------------------
  it("requires a contract address", async function () {
    const dir = tmp("vh-verify-noaddr-");
    const f = writeFile(dir, "x.txt", "x");
    let err = null;
    try {
      await runVerify({ path: f, provider });
    } catch (e) {
      err = e;
    }
    expect(err).to.not.equal(null);
    expect(err.message).to.match(/contract address/i);
  });

  it("rejects an invalid contract address", async function () {
    const dir = tmp("vh-verify-badaddr-");
    const f = writeFile(dir, "x.txt", "x");
    let err = null;
    try {
      await runVerify({ path: f, contractAddress: "0xnothex", provider });
    } catch (e) {
      err = e;
    }
    expect(err).to.not.equal(null);
    expect(err.message).to.match(/invalid contract address/i);
  });

  it("requires a provider (verify needs a network to read from)", async function () {
    const dir = tmp("vh-verify-noprov-");
    const f = writeFile(dir, "x.txt", "x");
    let err = null;
    try {
      await runVerify({ path: f, contractAddress: registryAddress });
    } catch (e) {
      err = e;
    }
    expect(err).to.not.equal(null);
    expect(err.message).to.match(/provider/i);
  });
});

// ---------------------------------------------------------------------------
// Pure unit: the NotAnchored classifier distinguishes "no record" from real errors.
// ---------------------------------------------------------------------------
describe("verify: isNotAnchoredError", function () {
  const iface = new ethers.Interface(ABI);
  const selector = iface.getError("NotAnchored").selector;

  it("recognizes a decoded NotAnchored custom error (errorName)", function () {
    expect(isNotAnchoredError({ errorName: "NotAnchored" }, ethers, selector)).to.equal(true);
  });

  it("recognizes NotAnchored via err.revert.name", function () {
    expect(
      isNotAnchoredError({ revert: { name: "NotAnchored" } }, ethers, selector)
    ).to.equal(true);
  });

  it("recognizes NotAnchored from raw revert data carrying its selector", function () {
    const data = selector + "0".repeat(64); // selector + a bytes32 arg
    expect(isNotAnchoredError({ data }, ethers, selector)).to.equal(true);
  });

  it("does NOT classify a generic network error as NotAnchored", function () {
    expect(
      isNotAnchoredError(new Error("could not detect network"), ethers, selector)
    ).to.equal(false);
  });
});

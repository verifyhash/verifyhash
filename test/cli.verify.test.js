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
const { hashFile, hashDir } = require("../cli/hash");
const { readReceipt } = require("../cli/receipt");

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

  // Hand out distinct pre-funded hardhat dev signers (accounts #1..#19) for anchoring submissions so
  // a tx never contends on a shared, provider-cached nonce. Each test takes its own key and sends a
  // single tx with it. (Account #0 is reserved for the deployer in `before`.)
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
  ];
  let keyIdx = 0;
  function freshSigner() {
    const k = DEV_KEYS[keyIdx++];
    if (!k) throw new Error("ran out of dev keys for the test");
    return new ethers.Wallet(k, provider);
  }

  // A receipt destination OUTSIDE any anchored directory. Writing the receipt INTO the directory we
  // are anchoring/verifying would make the receipt file itself part of the next directory hash (the
  // tree would gain an `anchor.vhclaim.json` leaf), which is a self-inflicted mismatch. Keep it apart.
  function receiptOutside(label) {
    return path.join(tmp(`vh-verify-receipt-${label}-`), "anchor.vhclaim.json");
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

  // -------------------------------------------------------------------------
  // Directory anchor receipts + `vh verify <dir> --receipt`: localize a tamper
  // to the exact file (ADDED / REMOVED / CHANGED) while the AUTHORITATIVE verdict
  // stays root-vs-on-chain. (T-6.2.)
  // -------------------------------------------------------------------------

  // Build a fresh 3-file directory; returns { dir, files: {name: absPath} }.
  function make3FileDir(label) {
    const dir = tmp(`vh-verify-dir-${label}-`);
    const stamp = Date.now() + "-" + Math.random();
    writeFile(dir, "a.txt", "alpha file " + stamp);
    writeFile(dir, "src/b.txt", "beta file " + stamp);
    writeFile(dir, "src/c.txt", "gamma file " + stamp);
    return dir;
  }

  it("anchoring a 3-file dir with --receipt writes a manifest of all per-file leaves", async function () {
    const dir = make3FileDir("manifest");
    const receiptPath = receiptOutside("manifest");
    const anchorer = freshSigner();

    const res = await runAnchor({
      path: dir,
      contractAddress: registryAddress,
      receiptPath,
      provider,
      signer: anchorer,
      log: () => {},
    });
    expect(res.anchored, "dir root should anchor").to.not.equal(null);
    expect(res.tx.kind).to.equal("dir");

    // The receipt on disk records the full manifest (one entry per file), matching `hashDir`.
    const receipt = readReceipt(receiptPath);
    expect(receipt.manifest, "receipt records a manifest").to.be.an("array").with.length(3);
    const recordedPaths = receipt.manifest.map((m) => m.path).sort();
    expect(recordedPaths).to.deep.equal(["a.txt", "src/b.txt", "src/c.txt"]);
    // The recorded leaves are exactly the ones hashDir computes.
    const live = hashDir(dir);
    const byPath = new Map(receipt.manifest.map((m) => [m.path, m]));
    for (const l of live.leaves) {
      expect(byPath.get(l.path).leaf).to.equal(l.leaf);
      expect(byPath.get(l.path).contentHash).to.equal(l.contentHash);
    }
    // The receipt's recorded root matches the on-chain anchored root.
    expect(receipt.contentHash).to.equal(live.root);
  });

  it("editing one file: `verify --receipt` reports exactly that file CHANGED, and still MISMATCH overall", async function () {
    const dir = make3FileDir("changed");
    const receiptPath = receiptOutside("changed");
    const anchorer = freshSigner();

    await runAnchor({ path: dir, contractAddress: registryAddress, receiptPath, provider, signer: anchorer, log: () => {} });

    // Sanity: unmodified dir verifies MATCH and the manifest diff is empty.
    let matchOut = "";
    const matchRes = await runVerify({
      path: dir, contractAddress: registryAddress, receiptPath, provider, log: (s) => (matchOut += s),
    });
    expect(matchRes.status).to.equal(STATUS.MATCH);
    expect(matchRes.manifestDiff.identical).to.equal(true);
    expect(matchOut).to.match(/IDENTICAL/);
    // The untrusted-hint caveat is always present in the output.
    expect(matchOut).to.match(/UNTRUSTED/);
    expect(matchOut).to.match(/authoritative/i);

    // Edit exactly one file (src/b.txt).
    fs.writeFileSync(path.join(dir, "src/b.txt"), "beta file MUTATED " + Date.now());

    let out = "";
    const res = await runVerify({
      path: dir, contractAddress: registryAddress, receiptPath, provider, log: (s) => (out += s),
    });
    // Authoritative verdict: the root changed, so it is no longer anchored -> MISMATCH.
    expect(res.status).to.equal(STATUS.MISMATCH);
    // Localized: exactly src/b.txt is CHANGED; nothing added/removed.
    const d = res.manifestDiff;
    expect(d.changed.map((c) => c.path)).to.deep.equal(["src/b.txt"]);
    expect(d.added).to.be.empty;
    expect(d.removed).to.be.empty;
    expect(d.changed[0].oldContentHash).to.not.equal(d.changed[0].newContentHash);
    expect(out).to.match(/MISMATCH/);
    expect(out).to.match(/CHANGED {2}src\/b\.txt/);
  });

  it("adding a file: `verify --receipt` reports it as ADDED (and MISMATCH overall)", async function () {
    const dir = make3FileDir("added");
    const receiptPath = receiptOutside("added");
    const anchorer = freshSigner();
    await runAnchor({ path: dir, contractAddress: registryAddress, receiptPath, provider, signer: anchorer, log: () => {} });

    // Add a 4th file after anchoring.
    writeFile(dir, "src/d.txt", "delta file " + Date.now());

    let out = "";
    const res = await runVerify({
      path: dir, contractAddress: registryAddress, receiptPath, provider, log: (s) => (out += s),
    });
    expect(res.status).to.equal(STATUS.MISMATCH);
    const d = res.manifestDiff;
    expect(d.added.map((a) => a.path)).to.deep.equal(["src/d.txt"]);
    expect(d.removed).to.be.empty;
    expect(d.changed).to.be.empty;
    expect(out).to.match(/ADDED {4}src\/d\.txt/);
  });

  it("removing a file: `verify --receipt` reports it as REMOVED (and MISMATCH overall)", async function () {
    const dir = make3FileDir("removed");
    const receiptPath = receiptOutside("removed");
    const anchorer = freshSigner();
    await runAnchor({ path: dir, contractAddress: registryAddress, receiptPath, provider, signer: anchorer, log: () => {} });

    // Remove a file after anchoring.
    fs.rmSync(path.join(dir, "src/c.txt"));

    let out = "";
    const res = await runVerify({
      path: dir, contractAddress: registryAddress, receiptPath, provider, log: (s) => (out += s),
    });
    expect(res.status).to.equal(STATUS.MISMATCH);
    const d = res.manifestDiff;
    expect(d.removed.map((r) => r.path)).to.deep.equal(["src/c.txt"]);
    expect(d.added).to.be.empty;
    expect(d.changed).to.be.empty;
    expect(out).to.match(/REMOVED {2}src\/c\.txt/);
  });

  it("a receipt for a DIFFERENT repo is reported as fully divergent, not silently mislabeled", async function () {
    // Anchor + receipt for repo ONE (files a.txt, src/b.txt, src/c.txt).
    const dirOne = make3FileDir("repo-one");
    const receiptOne = receiptOutside("repo-one");
    await runAnchor({ path: dirOne, contractAddress: registryAddress, receiptPath: receiptOne, provider, signer: freshSigner(), log: () => {} });

    // A completely unrelated repo TWO with DIFFERENT filenames (so the divergence is unambiguous and
    // shows up as ADDED/REMOVED rather than CHANGED). It was never anchored with this receipt.
    const dirTwo = tmp("vh-verify-dir-repo-two-");
    const stamp = Date.now() + "-" + Math.random();
    writeFile(dirTwo, "lib/x.js", "ex " + stamp);
    writeFile(dirTwo, "lib/y.js", "why " + stamp);
    writeFile(dirTwo, "README.md", "readme " + stamp);

    let out = "";
    const res = await runVerify({
      path: dirTwo, contractAddress: registryAddress, receiptPath: receiptOne, provider, log: (s) => (out += s),
    });
    // Repo two's own root was never anchored -> MISMATCH (authoritative).
    expect(res.status).to.equal(STATUS.MISMATCH);
    const d = res.manifestDiff;
    // The receipt's recorded root does not match repo two's recomputed root: flagged, not hidden.
    expect(d.receiptHashMismatch).to.equal(true);
    // Fully divergent: all of repo two's files are ADDED, all of repo one's are REMOVED, none CHANGED.
    // (No path overlaps, so nothing can be silently mislabeled as a content change.)
    expect(d.changed).to.be.empty;
    expect(d.added.map((a) => a.path).sort()).to.deep.equal(["README.md", "lib/x.js", "lib/y.js"]);
    expect(d.removed.map((r) => r.path).sort()).to.deep.equal(["a.txt", "src/b.txt", "src/c.txt"]);
    expect(out).to.match(/DIFFERENT directory snapshot|different repo/i);
  });

  it("verify without --receipt is unchanged: a clean dir MATCHes and prints no manifest diff", async function () {
    const dir = make3FileDir("noreceipt");
    await runAnchor({ path: dir, contractAddress: registryAddress, provider, signer: freshSigner(), log: () => {} });

    let out = "";
    const res = await runVerify({ path: dir, contractAddress: registryAddress, provider, log: (s) => (out += s) });
    expect(res.status).to.equal(STATUS.MATCH);
    expect(res.manifestDiff).to.equal(null);
    expect(out).to.not.match(/manifest diff/i); // no regression: root-only output
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

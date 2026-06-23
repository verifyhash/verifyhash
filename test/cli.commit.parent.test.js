const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildCommitTx,
  runCommit,
  runReveal,
} = require("../cli/claim");
const { readReceipt } = require("../cli/receipt");
const { runShow, STATUS: SHOW_STATUS } = require("../cli/show");
const { runLineage, STATUS: LINEAGE_STATUS } = require("../cli/lineage");
const ARTIFACT = require("../artifacts/contracts/ContributionRegistry.sol/ContributionRegistry.json");
const ABI = ARTIFACT.abi;

// ---------------------------------------------------------------------------
// B-10.1: thread the lineage `--parent` edge through the RESUMABLE commit/reveal
// receipt (schema v4). `vh commit --parent R` persists the edge into the receipt;
// a SEPARATE `vh reveal` (fresh process) reads it and routes to revealWithParent.
//
// Filesystem hygiene (T-9.1): every receipt-writing test here writes ONLY to an OS
// temp dir tracked in `tmpDirs` and removed in `after`, so no secret-bearing
// *.vhclaim.json ever leaks into the repo root (the hygiene guard still passes).
// ---------------------------------------------------------------------------

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

let tmpDirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || "vh-commit-parent-"));
  tmpDirs.push(d);
  return d;
}
function writeFile(dir, name, contents) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return p;
}

describe("cli: vh commit --parent -> vh reveal (resumable lineage edge, schema v4)", function () {
  this.timeout(60000);

  const PORT = 18551; // distinct from the other suites' ports so nodes never collide
  const RPC_URL = `http://127.0.0.1:${PORT}`;
  let nodeProc;
  let provider;
  let deployer;
  let deployerNonce; // a SINGLE NonceManager over the deployer, reused for every setup write
  let registryAddress;
  let registry; // deployer-bound, for anchoring roots

  // Dedicated hardhat dev keys, each used by a SINGLE test so every phase reads a pristine on-chain
  // nonce (no NonceManager cross-test contention). Account #0 is the deployer.
  const ROOT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // #1
  const CHILD_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // #2
  const UNANCHORED_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"; // #3
  const BADPARENT_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"; // #4

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
    // A SINGLE NonceManager over the deployer, used for the deploy AND every later setup write, so the
    // nonce is tracked consistently across calls (a fresh NonceManager per call can read a stale nonce).
    deployerNonce = new ethers.NonceManager(deployer);
    const Factory = new ethers.ContractFactory(ARTIFACT.abi, ARTIFACT.bytecode, deployerNonce);
    const c = await Factory.deploy();
    await c.waitForDeployment();
    registryAddress = await c.getAddress();
    registry = c;
  });

  after(function () {
    if (nodeProc) nodeProc.kill("SIGKILL");
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  async function mineBlocks(n) {
    for (let i = 0; i < n; i++) await provider.send("evm_mine", []);
  }

  // The selector of `error UnknownParent(bytes32)`. A spawned node sometimes surfaces a custom-error
  // revert as raw data ("unknown custom error") rather than a decoded name, so we match either the
  // decoded name OR this selector to keep the assertion robust across nodes (mirrors isRevealTooSoon).
  const UNKNOWN_PARENT_SELECTOR = "0x3116cbec";
  function isUnknownParent(err) {
    const msg = err && err.message ? err.message : "";
    if (/UnknownParent/.test(msg)) return true;
    if (msg.includes(UNKNOWN_PARENT_SELECTOR)) return true;
    const data =
      (err && err.data) ||
      (err && err.info && err.info.error && err.info.error.data && err.info.error.data.data);
    return typeof data === "string" && data.startsWith(UNKNOWN_PARENT_SELECTOR);
  }

  // Anchor a one-shot root R (a lineage root; authorBound = false) and return its contentHash. Reuses
  // the single deployer NonceManager so back-to-back setup anchors never contend on a stale nonce.
  async function anchorRoot(uri) {
    const hash = ethers.hexlify(ethers.randomBytes(32));
    const r = registry.connect(deployerNonce);
    await (await r.anchor(hash, uri || "")).wait();
    return hash.toLowerCase();
  }

  // -------------------------------------------------------------------------
  // (b) The headline end-to-end: anchor a root R; runCommit --parent R writes a v4 receipt whose
  //     parent === R; then in a SEPARATE call (fresh process) runReveal from ONLY that receipt routes
  //     to revealWithParent, and `vh show`/`vh lineage` on the child report parent === R, authorBound.
  // -------------------------------------------------------------------------
  it("commit --parent R writes parent into the receipt; a SEPARATE reveal routes to revealWithParent and links the child", async function () {
    const root = await anchorRoot("ipfs://b101-root");

    const committer = new ethers.NonceManager(new ethers.Wallet(CHILD_KEY, provider));
    const committerAddr = await committer.getAddress();
    const f = writeFile(tmp("vh-b101-child-"), "v2.txt", "child of root " + Date.now());
    const receiptPath = path.join(tmp("vh-b101-rcpt-"), "child.vhclaim.json");

    // --- Phase 1: commit --parent R (persists the edge into the receipt BEFORE returning) ---
    const committed = await runCommit({
      path: f,
      uri: "ipfs://b101-child",
      parent: root,
      contractAddress: registryAddress,
      receiptPath,
      provider,
      signer: committer,
      log: () => {},
    });
    const childHash = committed.commitTx.contentHash.toLowerCase();
    expect(committed.commitTx.parent).to.equal(root); // built tx carries the normalized parent
    // The commit() tx itself is unchanged whether or not a parent is given: it only encodes the
    // commitment (the edge rides the reveal leg).
    const noParentTx = buildCommitTx({
      path: f,
      committer: committerAddr,
      salt: committed.commitTx.salt,
      contractAddress: registryAddress,
    });
    expect(committed.commitTx.data).to.equal(noParentTx.data);

    // The receipt on disk is v4 and records parent === R (the durable lineage edge).
    expect(fs.existsSync(receiptPath)).to.equal(true);
    const receipt = readReceipt(receiptPath);
    expect(receipt.schemaVersion).to.equal(4);
    expect(receipt.parent).to.equal(root);
    expect(receipt.contentHash.toLowerCase()).to.equal(childHash);
    expect(receipt.salt).to.match(/^0x[0-9a-fA-F]{64}$/);

    // Mine past the maturation window, simulating real time between two CLI invocations.
    await mineBlocks(2);

    // --- Phase 2: reveal from ONLY the receipt, in a SIMULATED FRESH PROCESS ---
    const freshProvider = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
    const freshSigner = new ethers.Wallet(CHILD_KEY, freshProvider);
    const revealedRes = await runReveal({
      receiptPath,
      provider: freshProvider,
      signer: freshSigner,
      noWait: true, // window already matured above
      log: () => {},
    });
    expect(revealedRes.revealed, "Revealed event should be present").to.not.equal(null);
    expect(revealedRes.revealed.contentHash.toLowerCase()).to.equal(childHash);
    expect(revealedRes.revealed.contributor).to.equal(committerAddr);

    // The reveal recorded the lineage edge: the on-chain record points at R as its parent.
    const reg = new ethers.Contract(registryAddress, ABI, provider);
    const rec = await reg.getRecord(childHash);
    expect(rec.authorBound).to.equal(true);
    expect(rec.parent.toLowerCase()).to.equal(root);

    // `vh show <child>` reports parent === R and authorBound = true.
    let showOut = "";
    const show = await runShow({
      contentHash: childHash,
      contractAddress: registryAddress,
      provider,
      log: (s) => (showOut += s),
    });
    expect(show.status).to.equal(SHOW_STATUS.ANCHORED);
    expect(show.parent.toLowerCase()).to.equal(root);
    expect(show.authorBound).to.equal(true);
    expect(showOut).to.contain(root);

    // `vh lineage <child>` reads back [child, root] in order, the child authorBound.
    const walk = await runLineage({
      contentHash: childHash,
      contractAddress: registryAddress,
      provider,
      log: () => {},
    });
    expect(walk.status).to.equal(LINEAGE_STATUS.WALKED);
    expect(walk.ancestors.map((a) => a.contentHash.toLowerCase())).to.deep.equal([childHash, root]);
    expect(walk.ancestors[0].authorBound).to.equal(true);
    expect(walk.ancestors[0].parent.toLowerCase()).to.equal(root);
  });

  // -------------------------------------------------------------------------
  // No --parent: the commit/reveal split behaves EXACTLY as today (legacy reveal(), a lineage root).
  // This pins that the parent path is purely additive — no regression to the existing flow.
  // -------------------------------------------------------------------------
  it("WITHOUT --parent the resumable flow is unchanged: receipt has no parent, reveal is a lineage root", async function () {
    const committer = new ethers.NonceManager(new ethers.Wallet(ROOT_KEY, provider));
    const committerAddr = await committer.getAddress();
    const f = writeFile(tmp("vh-b101-root-"), "r.txt", "no parent " + Date.now());
    const receiptPath = path.join(tmp("vh-b101-root-rcpt-"), "root.vhclaim.json");

    const committed = await runCommit({
      path: f,
      uri: "ipfs://b101-noparent",
      contractAddress: registryAddress,
      receiptPath,
      provider,
      signer: committer,
      log: () => {},
    });
    const childHash = committed.commitTx.contentHash.toLowerCase();
    expect(committed.commitTx.parent).to.equal(null);

    // The receipt records NO parent field (a lineage root omits it entirely).
    const receipt = readReceipt(receiptPath);
    expect(receipt).to.not.have.property("parent");

    await mineBlocks(2);
    const fp = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
    const revealedRes = await runReveal({
      receiptPath,
      provider: fp,
      signer: new ethers.Wallet(ROOT_KEY, fp),
      noWait: true,
      log: () => {},
    });
    expect(revealedRes.revealed.contentHash.toLowerCase()).to.equal(childHash);

    // The record is a lineage root (parent == 0) and still authorBound (commit-reveal).
    const reg = new ethers.Contract(registryAddress, ABI, provider);
    const rec = await reg.getRecord(childHash);
    expect(rec.authorBound).to.equal(true);
    expect(BigInt(rec.parent)).to.equal(0n);
    expect(rec.contributor).to.equal(committerAddr);
  });

  // -------------------------------------------------------------------------
  // (c) commit --parent with an UNANCHORED parent: the commit still SUCCEEDS (the contract checks the
  //     parent at REVEAL time), but the later reveal reverts UnknownParent and leaves the receipt
  //     intact for retry — so the salt is never lost. Documents the failure mode end to end.
  // -------------------------------------------------------------------------
  it("commit --parent <UNANCHORED>: commit succeeds, but reveal reverts UnknownParent and the receipt survives for retry", async function () {
    // A non-zero 32-byte hash that was never anchored on this node.
    const ghostParent = ethers.hexlify(ethers.randomBytes(32)).toLowerCase();

    const committer = new ethers.NonceManager(new ethers.Wallet(UNANCHORED_KEY, provider));
    const f = writeFile(tmp("vh-b101-ghost-"), "g.txt", "ghost parent " + Date.now());
    const receiptPath = path.join(tmp("vh-b101-ghost-rcpt-"), "ghost.vhclaim.json");

    // commit() does NOT check the parent (the contract's commit takes only the commitment), so this
    // succeeds and persists the edge for reveal.
    const committed = await runCommit({
      path: f,
      uri: "ipfs://b101-ghost",
      parent: ghostParent,
      contractAddress: registryAddress,
      receiptPath,
      provider,
      signer: committer,
      log: () => {},
    });
    expect(committed.commitTxHash).to.be.a("string");
    expect(fs.existsSync(receiptPath)).to.equal(true);
    const before = fs.readFileSync(receiptPath, "utf8");
    expect(readReceipt(receiptPath).parent).to.equal(ghostParent);

    await mineBlocks(2);

    // reveal routes to revealWithParent(child, salt, uri, ghostParent); the contract now checks the
    // parent and reverts UnknownParent because it was never anchored.
    let err = null;
    try {
      const fp = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
      await runReveal({
        receiptPath,
        provider: fp,
        signer: new ethers.Wallet(UNANCHORED_KEY, fp),
        noWait: true,
        log: () => {},
      });
    } catch (e) {
      err = e;
    }
    expect(err, "reveal with an unanchored parent must revert").to.not.equal(null);
    expect(isUnknownParent(err), `expected UnknownParent, got: ${err && err.message}`).to.equal(true);

    // The receipt is untouched, so the user can anchor the parent and retry without losing the salt.
    expect(fs.existsSync(receiptPath), "receipt must survive a failed reveal").to.equal(true);
    expect(fs.readFileSync(receiptPath, "utf8")).to.equal(before);

    // Prove retryability: anchor the (formerly ghost) parent, then the SAME receipt reveals cleanly.
    const r = registry.connect(deployerNonce);
    await (await r.anchor(ghostParent, "")).wait();
    const fp2 = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
    const ok = await runReveal({
      receiptPath,
      provider: fp2,
      signer: new ethers.Wallet(UNANCHORED_KEY, fp2),
      noWait: true,
      log: () => {},
    });
    expect(ok.revealed, "the retried reveal should now succeed").to.not.equal(null);
    const childHash = committed.commitTx.contentHash.toLowerCase();
    const reg = new ethers.Contract(registryAddress, ABI, provider);
    const rec = await reg.getRecord(childHash);
    expect(rec.parent.toLowerCase()).to.equal(ghostParent);
    expect(rec.authorBound).to.equal(true);
  });

  // -------------------------------------------------------------------------
  // (d) A malformed --parent on `vh commit` (runCommit) hard-errors BEFORE any network call — parser
  //     parity with `vh anchor --parent`. Two airtight signals against the LIVE node:
  //       1. a signer tripwire: any sendTransaction flips a flag (commit() would have tripped it);
  //       2. the on-chain nonce of the signer is UNCHANGED (a broadcast commit() would increment it).
  //     A self-referential parent is also a pre-network hard error.
  // -------------------------------------------------------------------------
  it("commit --parent <malformed> hard-errors BEFORE broadcasting commit() (and writes no receipt)", async function () {
    const f = writeFile(tmp("vh-b101-bad-"), "b.txt", "bad parent " + Date.now());
    const receiptDir = tmp("vh-b101-bad-rcpt-");

    const BAD_PARENTS = [
      "0x1234", // too short
      "0x" + "ab".repeat(33), // too long
      "0x" + "zz".repeat(32), // right length, non-hex
      "deadbeef".repeat(8), // 64 hex chars, missing 0x prefix
      "not-a-hash",
    ];

    for (const bad of BAD_PARENTS) {
      const realSigner = new ethers.Wallet(BADPARENT_KEY, provider);
      const signerAddr = await realSigner.getAddress();
      const nonceBefore = await provider.getTransactionCount(signerAddr);
      let broadcastAttempted = false;
      const trippable = new Proxy(realSigner, {
        get(target, prop, receiver) {
          if (prop === "sendTransaction") {
            return (...a) => {
              broadcastAttempted = true;
              return target.sendTransaction(...a);
            };
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });

      let err = null;
      try {
        await runCommit({
          path: f,
          parent: bad,
          contractAddress: registryAddress,
          receiptDir, // even if it tried to write, it lands in the temp dir (never repo root)
          provider,
          signer: trippable,
          chainId: 31337n,
          log: () => {},
        });
      } catch (e) {
        err = e;
      }
      expect(err, `malformed parent should reject: ${bad}`).to.not.equal(null);
      expect(err.message, `for ${bad}`).to.match(/invalid --parent/i);
      // It must be the up-front validation error, not a downstream network/contract failure.
      expect(
        /ECONNREFUSED|could not detect network|revert|NoSuchCommitment|UnknownParent/i.test(
          String(err.message)
        ),
        `error for ${bad} must be the up-front validation error`
      ).to.equal(false);
      expect(broadcastAttempted, `commit() must NOT be broadcast for ${bad}`).to.equal(false);
      expect(await provider.getTransactionCount(signerAddr), `nonce unchanged for ${bad}`).to.equal(
        nonceBefore
      );
    }

    // A well-formed but self-referential parent (parent === the child's own contentHash) is also a
    // pre-network hard error (mirrors the contract's SelfParent guard, client-side).
    const realSigner = new ethers.Wallet(BADPARENT_KEY, provider);
    const signerAddr = await realSigner.getAddress();
    const ownHash = buildCommitTx({
      path: f,
      committer: signerAddr,
      contractAddress: registryAddress,
    }).contentHash;
    const nonceBefore = await provider.getTransactionCount(signerAddr);
    let selfBroadcast = false;
    const selfTrip = new Proxy(realSigner, {
      get(target, prop, receiver) {
        if (prop === "sendTransaction") {
          return (...a) => {
            selfBroadcast = true;
            return target.sendTransaction(...a);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    let selfErr = null;
    try {
      await runCommit({
        path: f,
        parent: ownHash,
        contractAddress: registryAddress,
        receiptDir,
        provider,
        signer: selfTrip,
        chainId: 31337n,
        log: () => {},
      });
    } catch (e) {
      selfErr = e;
    }
    expect(selfErr, "self-parent must reject").to.not.equal(null);
    expect(selfErr.message).to.match(/own parent|self-reference|SelfParent/i);
    expect(selfBroadcast, "self-parent must not broadcast commit()").to.equal(false);
    expect(await provider.getTransactionCount(signerAddr)).to.equal(nonceBefore);

    // No receipt was written for any of these rejected commits.
    const leaked = fs.readdirSync(receiptDir).filter((f2) => f2.endsWith(".vhclaim.json"));
    expect(leaked, `no receipt should be written for a rejected commit: ${leaked.join(", ")}`).to.deep.equal(
      []
    );
  });
});

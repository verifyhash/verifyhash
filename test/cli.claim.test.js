const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");

const {
  computeCommitment,
  buildCommitTx,
  buildRevealTx,
  newSalt,
  resolveReceiptPath,
  runClaim,
  runCommit,
  runReveal,
  ABI,
} = require("../cli/claim");
const { readReceipt } = require("../cli/receipt");
const { hashFile } = require("../cli/hash");
const { cmdClaim, parseClaimArgs } = require("../cli/vh");

const ARTIFACT = require("../artifacts/contracts/ContributionRegistry.sol/ContributionRegistry.json");

// ---------------------------------------------------------------------------
// Helpers (mirror cli.anchor.test.js): temp dirs + a real local hardhat node.
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

// ---------------------------------------------------------------------------
// Pure (no network) tests of the commit-reveal building blocks.
// ---------------------------------------------------------------------------
describe("cli: vh claim — pure helpers", function () {
  const ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // hardhat account #1
  const CONTENT = ethers.keccak256(ethers.toUtf8Bytes("some content"));
  const SALT = "0x" + "ab".repeat(32);
  const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

  it("computeCommitment matches the contract's abi.encode construction", function () {
    const expected = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "bytes32"],
        [CONTENT, ethers.getAddress(ADDR), SALT]
      )
    );
    expect(computeCommitment({ contentHash: CONTENT, committer: ADDR, salt: SALT })).to.equal(
      expected
    );
  });

  it("commitment is bound to the committer (different address => different commitment)", function () {
    const c1 = computeCommitment({ contentHash: CONTENT, committer: ADDR, salt: SALT });
    const other = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // account #2
    const c2 = computeCommitment({ contentHash: CONTENT, committer: other, salt: SALT });
    expect(c1).to.not.equal(c2);
  });

  it("newSalt returns a fresh random 32-byte hex each call", function () {
    const a = newSalt(ethers);
    const b = newSalt(ethers);
    expect(a).to.match(/^0x[0-9a-f]{64}$/);
    expect(a).to.not.equal(b);
  });

  it("buildCommitTx encodes commit(commitment) and carries the salt for later reveal", function () {
    const f = writeFile(tmp("vh-claim-pure-"), "x.txt", "claim me");
    const tx = buildCommitTx({
      path: f,
      committer: ADDR,
      contractAddress: CONTRACT,
      salt: SALT,
      ethers,
    });
    expect(tx.functionName).to.equal("commit");
    expect(tx.value).to.equal("0x0");
    expect(tx.contentHash).to.equal(hashFile(f));
    expect(tx.salt).to.equal(SALT);
    expect(tx.commitment).to.equal(
      computeCommitment({ contentHash: tx.contentHash, committer: ADDR, salt: SALT })
    );
    const decoded = new ethers.Interface(ABI).decodeFunctionData("commit", tx.data);
    expect(decoded[0]).to.equal(tx.commitment);
  });

  it("buildRevealTx encodes reveal(contentHash, salt, uri)", function () {
    const tx = buildRevealTx({
      contentHash: CONTENT,
      salt: SALT,
      uri: "ipfs://cid",
      contractAddress: CONTRACT,
      ethers,
    });
    expect(tx.functionName).to.equal("reveal");
    expect(tx.value).to.equal("0x0");
    const decoded = new ethers.Interface(ABI).decodeFunctionData("reveal", tx.data);
    expect(decoded[0]).to.equal(CONTENT);
    expect(decoded[1]).to.equal(SALT);
    expect(decoded[2]).to.equal("ipfs://cid");
  });

  it("parseClaimArgs accepts --receipt-dir and preserves typo/flag parity (T-9.1)", function () {
    // --receipt-dir captures a value.
    expect(parseClaimArgs(["./src", "--receipt-dir", "/tmp/out"]).receiptDir).to.equal("/tmp/out");
    expect(parseClaimArgs(["./src", "--receipt", "/tmp/r.json"]).receipt).to.equal("/tmp/r.json");
    // A typo in the new flag still hard-errors (it is not silently swallowed as a positional).
    expect(() => parseClaimArgs(["./src", "--reciept-dir", "/tmp/out"])).to.throw(/unknown flag/);
    // --receipt-dir with no value hard-errors.
    expect(() => parseClaimArgs(["./src", "--receipt-dir"])).to.throw(/--receipt-dir requires a value/);
    // --receipt and --receipt-dir are mutually exclusive.
    expect(() =>
      parseClaimArgs(["./src", "--receipt", "/tmp/r.json", "--receipt-dir", "/tmp/out"])
    ).to.throw(/mutually exclusive/);
  });

  it("resolveReceiptPath honors an explicit path / dir / documented default base (T-9.1)", function () {
    // 1. An explicit --receipt path wins and is resolved to absolute.
    const explicit = path.join(os.tmpdir(), "vh-explicit", "r.vhclaim.json");
    expect(resolveReceiptPath({ receiptPath: explicit, contentHash: CONTENT })).to.equal(
      path.resolve(explicit)
    );
    // 2. An explicit --receipt-dir picks the folder; the tidy default file name goes inside it.
    const dir = path.join(os.tmpdir(), "vh-rdir");
    const inDir = resolveReceiptPath({ receiptDir: dir, contentHash: CONTENT });
    expect(path.dirname(inDir)).to.equal(path.resolve(dir));
    expect(path.basename(inDir)).to.match(/^[0-9a-f]{16}\.vhclaim\.json$/);
    // 3. With only a contentHash + an explicit baseDir, it resolves the default INTO that base —
    //    never silently into some unrelated cwd. The result is always absolute.
    const base = path.join(os.tmpdir(), "vh-base");
    const def = resolveReceiptPath({ contentHash: CONTENT, baseDir: base });
    expect(def).to.equal(path.join(path.resolve(base), path.basename(inDir)));
    expect(path.isAbsolute(def)).to.equal(true);
  });

  it("a --dry-run claim needs no key/network and prints the commit+reveal plan", async function () {
    const f = writeFile(tmp("vh-claim-dry-"), "y.txt", "dry claim");
    let out = "";
    const res = await runClaim({
      path: f,
      uri: "ipfs://cid",
      committer: ADDR,
      contractAddress: CONTRACT,
      salt: SALT,
      dryRun: true,
      // No signer, no provider.
      log: (s) => (out += s),
    });
    expect(res.dryRun).to.equal(true);
    expect(res.commitTx.contentHash).to.equal(hashFile(f));
    expect(res.revealTx.functionName).to.equal("reveal");
    expect(out).to.match(/DRY RUN/);
    expect(out).to.contain("commit-reveal");
    expect(out).to.contain(res.commitTx.commitment);
    // The secret salt must be surfaced so the user can persist it.
    expect(out).to.contain(SALT);
  });
});

// ---------------------------------------------------------------------------
// End-to-end against a live hardhat node, including front-running resistance.
// ---------------------------------------------------------------------------
describe("cli: vh claim — end to end (local hardhat node)", function () {
  this.timeout(60000);

  const PORT = 18547; // distinct from the anchor test's port
  const RPC_URL = `http://127.0.0.1:${PORT}`;
  let nodeProc;
  let provider;
  let deployer;
  let registryAddress;

  // hardhat dev keys #1.. (account #0 is the deployer).
  const DEV_KEYS = [
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // #1 alice
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2 attacker
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // #3
  ];
  // Dedicated keys for the resumable (commit/reveal) tests, used by NO other test so each runs
  // against a pristine on-chain nonce (no NonceManager cross-test interference).
  const RESUME_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"; // #4
  const TOOSOON_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"; // #5
  // Dedicated key for the T-9.1 "default path resolves into an explicit base" commit test, used by
  // NO other test, so it runs against a pristine on-chain nonce (no cross-test nonce contention).
  const COMMITDIR_KEY = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"; // #6
  // Dedicated key for the explicit---receipt-path test below. It previously reused DEV_KEYS[0] (alice),
  // the same key the happy-path test uses; when both ran back-to-back each spun up its OWN NonceManager
  // for that one account and the second could read a stale on-chain nonce ("Nonce too low") under load.
  // Giving this test its own account (as the resume/toosoon/commitdir tests already do) removes that
  // cross-test contention entirely — a test-isolation fix, not a weakened assertion.
  const RECEIPT_KEY = "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356"; // #7

  before(async function () {
    nodeProc = spawn(
      "npx",
      ["hardhat", "node", "--hostname", "127.0.0.1", "--port", String(PORT)],
      { cwd: path.join(__dirname, ".."), stdio: ["ignore", "ignore", "ignore"] }
    );
    await waitForRpc(RPC_URL, 45000);
    provider = new ethers.JsonRpcProvider(RPC_URL);
    deployer = new ethers.Wallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      provider
    );
    // Deploy through the deployer Wallet's JsonRpcProvider explicitly so the contract lands on the
    // SPAWNED node (not the in-process VM), and writes/reads target the same chain.
    const Factory = new ethers.ContractFactory(ARTIFACT.abi, ARTIFACT.bytecode, deployer);
    const registry = await Factory.deploy();
    await registry.waitForDeployment();
    registryAddress = await registry.getAddress();
  });

  after(function () {
    if (nodeProc) nodeProc.kill("SIGKILL");
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  // Helper: mine `n` empty blocks on the node so the reveal window can pass.
  async function mineBlocks(n) {
    for (let i = 0; i < n; i++) {
      await provider.send("evm_mine", []);
    }
  }

  // Wrap a key in a NonceManager so back-to-back sends interleaved with manual `evm_mine` calls
  // don't trip ethers' cached-nonce behavior (a test-harness timing artifact, not a product bug).
  function managedSigner(key) {
    return new ethers.NonceManager(new ethers.Wallet(key, provider));
  }

  it("commit+reveal records the claimant with authorBound = true (and writes NO receipt by default)", async function () {
    const alice = managedSigner(DEV_KEYS[0]);
    const f = writeFile(tmp("vh-claim-e2e-"), "work.txt", "alice work " + Date.now());
    const expected = hashFile(f);

    const res = await runClaim({
      path: f,
      uri: "ipfs://cid-alice",
      contractAddress: registryAddress,
      provider,
      signer: alice,
      // No receiptPath / receiptDir: the one-shot must persist NOTHING (T-9.1).
      // Test hook: instead of polling real time, mine the blocks the window needs.
      waitForBlock: async () => mineBlocks(2),
      log: () => {},
    });

    expect(res.revealed, "Revealed event should be present").to.not.equal(null);
    expect(res.revealed.contentHash).to.equal(expected);
    expect(res.revealed.contributor).to.equal(await alice.getAddress());

    // T-9.1: a one-shot runClaim with no explicit receipt destination writes no file at all, but
    // still surfaces the validated receipt object in-memory for a caller that wants to persist it.
    expect(res.receiptPath, "no receipt file should be written without an explicit destination").to.equal(
      undefined
    );
    expect(res.receipt, "the receipt object is returned in-memory").to.be.an("object");
    expect(res.receipt.salt).to.match(/^0x[0-9a-fA-F]{64}$/);
    expect(res.receipt.contentHash).to.equal(expected);

    const registry = new ethers.Contract(registryAddress, ABI, provider);
    const rec = await registry.getRecord(expected);
    expect(rec.contributor).to.equal(await alice.getAddress());
    expect(rec.authorBound).to.equal(true);
    expect(rec.uri).to.equal("ipfs://cid-alice");
  });

  it("runClaim with an explicit --receipt path persists the receipt THERE (and nowhere else)", async function () {
    const alice = managedSigner(RECEIPT_KEY); // own account: no nonce contention with the happy-path test
    const f = writeFile(tmp("vh-claim-rcpt-"), "work.txt", "alice receipt " + Date.now());
    const expected = hashFile(f);
    const receiptPath = path.join(tmp("vh-claim-rcpt-out-"), "explicit.vhclaim.json");

    const res = await runClaim({
      path: f,
      uri: "ipfs://cid-explicit",
      contractAddress: registryAddress,
      receiptPath,
      provider,
      signer: alice,
      waitForBlock: async () => mineBlocks(2),
      log: () => {},
    });

    expect(res.revealed.contentHash).to.equal(expected);
    // The receipt landed exactly where asked (resolved to absolute), carrying the secret salt.
    expect(res.receiptPath).to.equal(path.resolve(receiptPath));
    expect(fs.existsSync(receiptPath), "receipt must exist at the explicit path").to.equal(true);
    const written = readReceipt(receiptPath);
    expect(written.contentHash).to.equal(expected);
    expect(written.salt).to.equal(res.receipt.salt);
  });

  it("FRONT-RUN: an attacker copying the reveal calldata cannot become the recorded author", async function () {
    const alice = managedSigner(DEV_KEYS[2]); // distinct key from the happy-path test
    const attacker = managedSigner(DEV_KEYS[1]);
    const f = writeFile(tmp("vh-claim-fr-"), "secret.txt", "alice secret " + Date.now());
    const expected = hashFile(f);
    const salt = newSalt(ethers);

    const registry = new ethers.Contract(registryAddress, ABI, provider);

    // 1. Alice commits (sender-bound, salt-blinded) and the window matures.
    const aliceCommitment = computeCommitment({
      contentHash: expected,
      committer: await alice.getAddress(),
      salt,
    });
    await (await registry.connect(alice).commit(aliceCommitment)).wait();
    await mineBlocks(2);

    // 2. Attacker watches the mempool and resubmits Alice's reveal calldata verbatim FIRST.
    //    It must revert: the recomputed commitment is bound to the attacker, who never committed.
    const revealTx = buildRevealTx({
      contentHash: expected,
      salt,
      uri: "ipfs://attacker",
      contractAddress: registryAddress,
      ethers,
    });
    let attackerReverted = false;
    try {
      await (await attacker.sendTransaction({ to: revealTx.to, data: revealTx.data })).wait();
    } catch (_) {
      attackerReverted = true;
    }
    expect(attackerReverted, "attacker's stolen reveal must revert").to.equal(true);

    // 3. Alice reveals and is the author-bound contributor — the attacker never appears.
    await (await registry.connect(alice).reveal(expected, salt, "ipfs://cid-alice")).wait();
    const rec = await registry.getRecord(expected);
    expect(rec.contributor).to.equal(await alice.getAddress());
    expect(rec.authorBound).to.equal(true);
    expect(rec.contributor).to.not.equal(await attacker.getAddress());
  });

  // The selector of `error RevealTooSoon(uint64,uint64,uint64)` — a spawned node sometimes surfaces
  // a custom-error revert as raw data ("unknown custom error") rather than a decoded name, so we
  // match either the decoded name OR this selector to keep the assertion robust across nodes.
  const REVEAL_TOO_SOON_SELECTOR = "0x6c6a2001";
  function isRevealTooSoon(err) {
    const msg = err && err.message ? err.message : "";
    if (/RevealTooSoon/.test(msg)) return true;
    if (msg.includes(REVEAL_TOO_SOON_SELECTOR)) return true;
    // ethers attaches the raw revert payload on .data / nested info when it cannot decode it.
    const data =
      (err && err.data) ||
      (err && err.info && err.info.error && err.info.error.data && err.info.error.data.data);
    return typeof data === "string" && data.startsWith(REVEAL_TOO_SOON_SELECTOR);
  }

  it("RESUMABLE: commit writes a receipt, then a SEPARATE reveal from only that file claims authorBound", async function () {
    // Dedicated key (used by no other test) and PLAIN wallets per phase, so each phase reads its
    // own on-chain nonce — the point of the test is that reveal needs nothing held in memory.
    const committer = managedSigner(RESUME_KEY);
    const committerAddr = await committer.getAddress();
    const f = writeFile(tmp("vh-resume-"), "resumable.txt", "alice resumable " + Date.now());
    const expected = hashFile(f);
    const receiptPath = path.join(tmp("vh-receipt-"), "claim.vhclaim.json");

    // --- Phase 1: commit (writes the receipt BEFORE returning) ---
    const committed = await runCommit({
      path: f,
      uri: "ipfs://cid-resume",
      contractAddress: registryAddress,
      receiptPath,
      provider,
      signer: committer,
      log: () => {},
    });
    expect(committed.commitTxHash).to.be.a("string");

    // The receipt file must exist and carry the secret salt + commitment for a later process.
    expect(fs.existsSync(receiptPath), "receipt file should exist after commit").to.equal(true);
    const receipt = readReceipt(receiptPath);
    expect(receipt.contentHash).to.equal(expected);
    expect(receipt.committer).to.equal(committerAddr);
    expect(receipt.salt).to.equal(committed.commitTx.salt);
    expect(receipt.commitment).to.equal(committed.commitTx.commitment);
    expect(receipt.salt).to.match(/^0x[0-9a-fA-F]{64}$/);

    // Mine past the maturation window, simulating real time passing between two CLI invocations.
    await mineBlocks(2);

    // --- Phase 2: reveal from ONLY the receipt, in a SIMULATED FRESH PROCESS ---
    // A brand-new provider (no cached block/nonce state) + a fresh plain Wallet reconstructed from
    // the same key — exactly what `vh reveal --receipt` does in a separate invocation. This proves
    // reveal depends only on what was durably written to the receipt, nothing held in memory.
    const freshProvider = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
    const freshSigner = new ethers.Wallet(RESUME_KEY, freshProvider);
    const revealedRes = await runReveal({
      receiptPath,
      provider: freshProvider,
      signer: freshSigner,
      noWait: true, // window already matured above
      log: () => {},
    });

    expect(revealedRes.revealed, "Revealed event should be present").to.not.equal(null);
    expect(revealedRes.revealed.contentHash).to.equal(expected);
    expect(revealedRes.revealed.contributor).to.equal(committerAddr);

    const registry = new ethers.Contract(registryAddress, ABI, provider);
    const rec = await registry.getRecord(expected);
    expect(rec.contributor).to.equal(committerAddr);
    expect(rec.authorBound).to.equal(true);
    expect(rec.uri).to.equal("ipfs://cid-resume");
  });

  it("runCommit default path resolves into an explicit base dir and the log NAMES the exact file (T-9.1)", async function () {
    // The durable command keeps a default file name, but it must resolve against an explicit base
    // (here a temp dir, never the repo cwd) and the success line must name the EXACT absolute file so
    // the user can see/relocate/delete the secret-bearing receipt.
    const committer = managedSigner(COMMITDIR_KEY);
    const f = writeFile(tmp("vh-commit-default-"), "d.txt", "default base " + Date.now());
    const expected = hashFile(f);
    const baseDir = tmp("vh-commit-base-"); // stands in for "cwd", but isolated under the OS temp dir

    let out = "";
    const committed = await runCommit({
      path: f,
      uri: "ipfs://cid-default",
      contractAddress: registryAddress,
      baseDir, // explicit, documented base for the default file name (never a silent cwd drop)
      provider,
      signer: committer,
      log: (s) => (out += s),
    });

    // The receipt landed inside the explicit base under the default <prefix>.vhclaim.json name.
    expect(path.dirname(committed.receiptPath)).to.equal(path.resolve(baseDir));
    expect(path.basename(committed.receiptPath)).to.match(/^[0-9a-f]{16}\.vhclaim\.json$/);
    expect(fs.existsSync(committed.receiptPath)).to.equal(true);
    // The success output names the EXACT file written and warns it is secret.
    expect(out).to.include(committed.receiptPath);
    expect(out).to.match(/KEEP THIS PRIVATE|secret salt/i);

    const written = readReceipt(committed.receiptPath);
    expect(written.contentHash).to.equal(expected);
    expect(written.salt).to.match(/^0x[0-9a-fA-F]{64}$/);
  });

  it("reveal before the window matures reverts with RevealTooSoon and leaves the receipt intact for retry", async function () {
    const committer = managedSigner(TOOSOON_KEY);
    const f = writeFile(tmp("vh-toosoon-"), "early.txt", "too soon " + Date.now());
    const expected = hashFile(f);
    const receiptPath = path.join(tmp("vh-receipt-too-"), "early.vhclaim.json");

    await runCommit({
      path: f,
      uri: "ipfs://cid-early",
      contractAddress: registryAddress,
      receiptPath,
      provider,
      signer: committer,
      log: () => {},
    });
    expect(fs.existsSync(receiptPath)).to.equal(true);
    const before = fs.readFileSync(receiptPath, "utf8");

    // Reveal immediately (noWait + do NOT mine): MIN_REVEAL_DELAY has not elapsed, so the contract
    // must revert with RevealTooSoon. Use a fresh-process provider/wallet (resume semantics).
    let err = null;
    try {
      const fp = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
      await runReveal({
        receiptPath,
        provider: fp,
        signer: new ethers.Wallet(TOOSOON_KEY, fp),
        noWait: true,
        log: () => {},
      });
    } catch (e) {
      err = e;
    }
    expect(err, "early reveal must throw").to.not.equal(null);
    expect(isRevealTooSoon(err), `expected a RevealTooSoon revert, got: ${err && err.message}`).to.equal(
      true
    );

    // The receipt must be left untouched so the user can simply retry once the window opens.
    expect(fs.existsSync(receiptPath), "receipt must survive a failed reveal").to.equal(true);
    expect(fs.readFileSync(receiptPath, "utf8")).to.equal(before);

    // Prove it really is retryable: mine past the window, reveal again, and it now succeeds.
    await mineBlocks(2);
    const fp2 = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
    const ok = await runReveal({
      receiptPath,
      provider: fp2,
      signer: new ethers.Wallet(TOOSOON_KEY, fp2),
      noWait: true,
      log: () => {},
    });
    expect(ok.revealed.contentHash).to.equal(expected);
    expect(ok.revealed.contributor).to.equal(await committer.getAddress());
  });

  it("cmdClaim --dry-run exits 0 with no key/RPC and prints the plan (uses VH_COMMITTER)", async function () {
    const f = writeFile(tmp("vh-claim-cmd-"), "z.txt", "cmd dry");
    const prevContract = process.env.VH_CONTRACT;
    const prevCommitter = process.env.VH_COMMITTER;
    process.env.VH_CONTRACT = registryAddress;
    process.env.VH_COMMITTER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    try {
      const code = await cmdClaim([f, "--dry-run"]);
      expect(code).to.equal(0);
    } finally {
      if (prevContract === undefined) delete process.env.VH_CONTRACT;
      else process.env.VH_CONTRACT = prevContract;
      if (prevCommitter === undefined) delete process.env.VH_COMMITTER;
      else process.env.VH_COMMITTER = prevCommitter;
    }
  });
});

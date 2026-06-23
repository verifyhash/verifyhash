const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { spawn } = require("child_process");
const http = require("http");

const {
  runShow,
  normalizeContentHash,
  jsonShow,
  STATUS,
  ATTRIBUTION_PROVEN,
  ATTRIBUTION_ANCHOR_ONLY,
} = require("../cli/show");
const { ABI } = require("../cli/verify");
const { parseShowArgs } = require("../cli/vh");

// ---------------------------------------------------------------------------
// Helpers: a real local hardhat JSON-RPC node, mirroring cli.verify.test.js.
// `vh show` needs no local files at all — it is a pure hash -> record lookup —
// so unlike the verify suite this one never touches the filesystem.
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

// A throwaway non-zero 32-byte hash that was never anchored. Random so reruns never collide with a
// previously anchored value on a shared node.
function unanchoredHash() {
  return ethers.hexlify(ethers.randomBytes(32));
}

describe("cli: vh show", function () {
  this.timeout(60000);

  const PORT = 18547; // distinct from the anchor (18545) and verify (18546) suites
  const RPC_URL = `http://127.0.0.1:${PORT}`;
  let nodeProc;
  let provider;
  let deployer; // account #0 — the single writer for all setup txs in this suite
  let registryAddress;
  let registry; // bound to the deployer for writing in tests

  // Distinct pre-funded hardhat dev signers used ONLY where a test needs a record whose `contributor`
  // is a known, deployer-distinct address (so the assertion is meaningful). Each returns a fresh
  // wallet; writes through them are still serialized (await wait) so a provider-cached nonce never
  // contends.
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
      { cwd: require("path").join(__dirname, ".."), stdio: ["ignore", "ignore", "ignore"] }
    );
    await waitForRpc(RPC_URL, 45000);

    provider = new ethers.JsonRpcProvider(RPC_URL);
    deployer = new ethers.Wallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // hardhat #0
      provider
    );

    const Factory = await ethers.getContractFactory("ContributionRegistry", deployer);
    const c = await Factory.deploy();
    await c.waitForDeployment();
    registryAddress = await c.getAddress();
    registry = c;
  });

  after(function () {
    if (nodeProc) nodeProc.kill("SIGKILL");
  });

  // Anchor a known hash via a one-shot anchor() and return { hash, contributor }. The signer is wrapped
  // in a NonceManager so repeated anchors across the suite never contend on a provider-cached nonce.
  async function anchorKnownHash(uri) {
    const hash = ethers.hexlify(ethers.randomBytes(32));
    const signer = new ethers.NonceManager(freshSigner());
    const r = registry.connect(signer);
    const tx = await r.anchor(hash, uri || "");
    await tx.wait();
    return { hash, contributor: await signer.getAddress() };
  }

  // Mine `n` empty blocks so the reveal window (MIN_REVEAL_DELAY) can pass — mirrors cli.claim.test.js.
  async function mineBlocks(n) {
    for (let i = 0; i < n; i++) await provider.send("evm_mine", []);
  }

  // Full commit -> reveal so the record has authorBound = true (a proven first claimant). The signer is
  // wrapped in a NonceManager so back-to-back sends interleaved with manual `evm_mine` don't trip
  // ethers' cached-nonce behavior (a test-harness timing artifact, not a product bug) — same approach
  // the commit-reveal suite (cli.claim.test.js) uses.
  async function claimKnownHash(uri) {
    const hash = ethers.hexlify(ethers.randomBytes(32));
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const signer = new ethers.NonceManager(freshSigner());
    const claimant = await signer.getAddress();
    const r = registry.connect(signer);
    const commitment = await r.commitmentOf(hash, claimant, salt);
    await (await r.commit(commitment)).wait();
    await mineBlocks(2); // window: block.number > commitBlock + MIN_REVEAL_DELAY
    await (await r.reveal(hash, salt, uri || "")).wait();
    return { hash, contributor: claimant };
  }

  // -------------------------------------------------------------------------
  // ANCHORED: a known anchored hash reports its record fields.
  // -------------------------------------------------------------------------
  it("anchors a known hash, then `show <thatHash>` reports ANCHORED + the record fields", async function () {
    const { hash, contributor } = await anchorKnownHash("ipfs://bafyShowTest");

    let out = "";
    const res = await runShow({
      contentHash: hash,
      contractAddress: registryAddress,
      provider,
      log: (s) => (out += s),
    });

    expect(res.status).to.equal(STATUS.ANCHORED);
    expect(res.contentHash).to.equal(hash.toLowerCase());
    expect(res.contributor).to.equal(contributor);
    expect(res.authorBound).to.equal(false); // one-shot anchor
    expect(res.timestamp).to.be.a("bigint");
    expect(res.timestamp > 0n).to.equal(true);
    expect(res.blockNumber).to.be.a("bigint");
    expect(res.blockNumber > 0n).to.equal(true);
    expect(res.uri).to.equal("ipfs://bafyShowTest");

    // Human output carries every acceptance field, the ISO timestamp, and the trust caveat that
    // cross-links `vh verify`.
    expect(out).to.match(/ANCHORED/);
    expect(out).to.contain(contributor);
    expect(out).to.contain(String(res.timestamp));
    expect(out).to.contain(String(res.blockNumber));
    expect(out).to.contain("ipfs://bafyShowTest");
    // ISO-8601 timestamp is rendered next to the unix seconds.
    expect(out).to.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Trust caveat + cross-link to verify is load-bearing per the acceptance criteria.
    expect(out).to.match(/vh verify <path>/);
    expect(out).to.match(/does NOT re-derive/i);
  });

  // -------------------------------------------------------------------------
  // NOT ANCHORED: an unanchored hash reports NOT ANCHORED (and the CLI exits non-zero).
  // -------------------------------------------------------------------------
  it("`show <unanchoredHash>` reports NOT ANCHORED (distinct from a record, not an error)", async function () {
    const hash = unanchoredHash();

    let out = "";
    const res = await runShow({
      contentHash: hash,
      contractAddress: registryAddress,
      provider,
      log: (s) => (out += s),
    });

    expect(res.status).to.equal(STATUS.NOT_ANCHORED);
    expect(res.contributor).to.equal(null);
    expect(res.timestamp).to.equal(null);
    expect(res.blockNumber).to.equal(null);
    expect(out).to.match(/NOT ANCHORED/);
    // Even the NOT ANCHORED path cross-links verify so a reader knows how to bind real bytes.
    expect(out).to.match(/vh verify/);
  });

  it("the CLI exits NON-ZERO for a NOT ANCHORED hash and ZERO for an anchored one", async function () {
    const { main } = require("../cli/vh");
    const { hash: anchored } = await anchorKnownHash("");
    const missing = unanchoredHash();

    // Silence stdout while running the real CLI dispatcher (it writes via process.stdout by default).
    const origWrite = process.stdout.write;
    process.stdout.write = () => true;
    let anchoredCode, missingCode;
    try {
      anchoredCode = await main(["show", anchored, "--contract", registryAddress, "--rpc", RPC_URL]);
      missingCode = await main(["show", missing, "--contract", registryAddress, "--rpc", RPC_URL]);
    } finally {
      process.stdout.write = origWrite;
    }
    expect(anchoredCode).to.equal(0);
    expect(missingCode).to.not.equal(0); // NOT ANCHORED is a non-zero exit
  });

  // -------------------------------------------------------------------------
  // --json round-trips both states.
  // -------------------------------------------------------------------------
  it("--json round-trips an anchored record (parseable, fields preserved)", async function () {
    const { hash, contributor } = await anchorKnownHash("https://example.com/x");

    let out = "";
    const res = await runShow({
      contentHash: hash,
      contractAddress: registryAddress,
      provider,
      json: true,
      log: (s) => (out += s),
    });
    expect(res.status).to.equal(STATUS.ANCHORED);

    const parsed = JSON.parse(out);
    expect(parsed.anchored).to.equal(true);
    expect(parsed.contentHash).to.equal(hash.toLowerCase());
    expect(parsed.contributor).to.equal(contributor);
    expect(parsed.authorBound).to.equal(false);
    expect(parsed.attribution).to.equal(ATTRIBUTION_ANCHOR_ONLY);
    expect(parsed.timestamp).to.be.a("number");
    expect(parsed.timestamp).to.equal(Number(res.timestamp));
    expect(parsed.timestampISO).to.match(/\d{4}-\d{2}-\d{2}T/);
    expect(parsed.blockNumber).to.equal(Number(res.blockNumber));
    expect(parsed.uri).to.equal("https://example.com/x");
    // jsonShow(result) is exactly what was emitted.
    expect(parsed).to.deep.equal(jsonShow(res));
  });

  it("--json round-trips a NOT ANCHORED hash as anchored:false (not an error object)", async function () {
    const hash = unanchoredHash();

    let out = "";
    const res = await runShow({
      contentHash: hash,
      contractAddress: registryAddress,
      provider,
      json: true,
      log: (s) => (out += s),
    });
    expect(res.status).to.equal(STATUS.NOT_ANCHORED);

    const parsed = JSON.parse(out);
    expect(parsed.anchored).to.equal(false);
    expect(parsed.contentHash).to.equal(hash.toLowerCase());
    expect(parsed.note).to.match(/NOT ANCHORED/);
    expect(parsed.note).to.match(/vh verify/);
  });

  // -------------------------------------------------------------------------
  // authorBound (commit-reveal) vs a plain anchor are distinguished.
  // -------------------------------------------------------------------------
  it("distinguishes an authorBound (commit-reveal) record from a plain anchor", async function () {
    const claimed = await claimKnownHash("ipfs://claimed");
    const anchored = await anchorKnownHash("ipfs://anchored");

    let claimOut = "";
    const claimRes = await runShow({
      contentHash: claimed.hash,
      contractAddress: registryAddress,
      provider,
      log: (s) => (claimOut += s),
    });
    expect(claimRes.status).to.equal(STATUS.ANCHORED);
    expect(claimRes.authorBound).to.equal(true);
    expect(claimRes.contributor).to.equal(claimed.contributor);
    expect(claimOut).to.contain(ATTRIBUTION_PROVEN);
    expect(claimOut).to.match(/authorBound:\s+true/);

    let anchorOut = "";
    const anchorRes = await runShow({
      contentHash: anchored.hash,
      contractAddress: registryAddress,
      provider,
      log: (s) => (anchorOut += s),
    });
    expect(anchorRes.status).to.equal(STATUS.ANCHORED);
    expect(anchorRes.authorBound).to.equal(false);
    expect(anchorOut).to.contain(ATTRIBUTION_ANCHOR_ONLY);
    expect(anchorOut).to.match(/authorBound:\s+false/);

    // The two attribution phrases are genuinely different, so the records are not confusable.
    expect(ATTRIBUTION_PROVEN).to.not.equal(ATTRIBUTION_ANCHOR_ONLY);
  });

  // -------------------------------------------------------------------------
  // A malformed/short hash hard-errors with usage BEFORE any network call.
  // -------------------------------------------------------------------------
  it("a malformed hash errors WITHOUT hitting the network (validation precedes any RPC)", async function () {
    // A provider pointed at a dead port: if validation leaked through to the network, this would throw
    // a NETWORK error instead of the validation error. It throws the validation error, proving order.
    const deadProvider = new ethers.JsonRpcProvider("http://127.0.0.1:1");

    for (const bad of [
      "0x1234", // too short
      "0x" + "ab".repeat(33), // too long
      "0x" + "zz".repeat(32), // non-hex
      "deadbeef".repeat(8), // missing 0x prefix, even though length-ish
      "not-a-hash",
    ]) {
      let err = null;
      try {
        await runShow({
          contentHash: bad,
          contractAddress: registryAddress,
          provider: deadProvider,
          log: () => {},
        });
      } catch (e) {
        err = e;
      }
      expect(err, `malformed hash should throw: ${bad}`).to.not.equal(null);
      expect(err.message, `for ${bad}`).to.match(/invalid content hash|requires a <0xhash>/i);
      // It must be the VALIDATION error, not a network/connection error from the dead provider.
      expect(/ECONNREFUSED|could not detect network|connect/i.test(String(err.message))).to.equal(
        false
      );
    }
  });

  it("the CLI returns usage exit code 2 for a malformed hash and never builds a provider", async function () {
    const { main } = require("../cli/vh");
    // Deliberately give NO --rpc and a bad hash. If the hash were validated AFTER the RPC check, this
    // would error on the missing RPC (exit 1). Instead it must fail on the hash (exit 2, usage).
    const origErr = process.stderr.write;
    let captured = "";
    process.stderr.write = (s) => {
      captured += s;
      return true;
    };
    let code;
    try {
      code = await main(["show", "0x1234", "--contract", registryAddress]);
    } finally {
      process.stderr.write = origErr;
    }
    expect(code).to.equal(2); // usage error, not a runtime/RPC error
    expect(captured).to.match(/invalid content hash/i);
    expect(captured).to.match(/Usage:/); // usage was printed
  });

  // -------------------------------------------------------------------------
  // Genuine RPC error is surfaced, NOT masqueraded as NOT ANCHORED.
  // -------------------------------------------------------------------------
  it("surfaces a genuine RPC error instead of masquerading it as NOT ANCHORED", async function () {
    const hash = unanchoredHash();
    const deadProvider = new ethers.JsonRpcProvider("http://127.0.0.1:1"); // nothing listening

    let err = null;
    try {
      await runShow({
        contentHash: hash,
        contractAddress: registryAddress,
        provider: deadProvider,
        log: () => {},
      });
    } catch (e) {
      err = e;
    }
    expect(err, "a network failure must throw, not silently report NOT ANCHORED").to.not.equal(null);
    expect(/NotAnchored/.test(String(err.message))).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // Read-only: show wrote nothing to the chain.
  // -------------------------------------------------------------------------
  it("is read-only: a show (anchored or not) changes no on-chain state", async function () {
    const r = new ethers.Contract(registryAddress, ABI, provider);
    const before = await r.total();

    await runShow({
      contentHash: unanchoredHash(),
      contractAddress: registryAddress,
      provider,
      log: () => {},
    });
    const { hash } = await anchorKnownHash(""); // this anchor adds 1; show below must add 0
    const mid = await r.total();
    await runShow({ contentHash: hash, contractAddress: registryAddress, provider, log: () => {} });
    const after = await r.total();

    expect(after).to.equal(mid); // the show after the anchor wrote nothing
    expect(after - before).to.equal(1n); // only the single anchor() above changed total
  });

  // -------------------------------------------------------------------------
  // Input validation (pure; no node needed for these branches).
  // -------------------------------------------------------------------------
  it("requires a contract address (after a VALID hash, so it is not a hash error)", async function () {
    let err = null;
    try {
      await runShow({ contentHash: unanchoredHash(), provider });
    } catch (e) {
      err = e;
    }
    expect(err).to.not.equal(null);
    expect(err.message).to.match(/contract address/i);
  });

  it("requires a provider", async function () {
    let err = null;
    try {
      await runShow({ contentHash: unanchoredHash(), contractAddress: registryAddress });
    } catch (e) {
      err = e;
    }
    expect(err).to.not.equal(null);
    expect(err.message).to.match(/provider/i);
  });
});

// ---------------------------------------------------------------------------
// Pure unit: the hash normalizer + the arg parser (no node needed).
// ---------------------------------------------------------------------------
describe("show: normalizeContentHash", function () {
  it("accepts a well-formed 32-byte hash and lowercases it", function () {
    const h = "0x" + "AB".repeat(32);
    expect(normalizeContentHash(h, ethers)).to.equal(h.toLowerCase());
  });

  it("rejects a short hash", function () {
    expect(() => normalizeContentHash("0x1234", ethers)).to.throw(/invalid content hash/i);
  });

  it("rejects a long hash", function () {
    expect(() => normalizeContentHash("0x" + "ab".repeat(33), ethers)).to.throw(
      /invalid content hash/i
    );
  });

  it("rejects a non-hex hash of the right length", function () {
    expect(() => normalizeContentHash("0x" + "zz".repeat(32), ethers)).to.throw(
      /invalid content hash/i
    );
  });

  it("rejects a hash missing the 0x prefix", function () {
    expect(() => normalizeContentHash("ab".repeat(32), ethers)).to.throw(/0x-prefixed/i);
  });

  it("rejects empty/undefined input", function () {
    expect(() => normalizeContentHash("", ethers)).to.throw(/requires a <0xhash>/i);
    expect(() => normalizeContentHash(undefined, ethers)).to.throw(/requires a <0xhash>/i);
  });
});

describe("show: parseShowArgs", function () {
  it("parses a positional hash plus flags", function () {
    const o = parseShowArgs(["0xabc", "--contract", "0xC", "--rpc", "http://x", "--json"]);
    expect(o.hash).to.equal("0xabc");
    expect(o.contract).to.equal("0xC");
    expect(o.rpc).to.equal("http://x");
    expect(o.json).to.equal(true);
  });

  it("rejects an unknown flag", function () {
    expect(() => parseShowArgs(["0xabc", "--nope"])).to.throw(/unknown flag/i);
  });

  it("rejects a second positional argument", function () {
    expect(() => parseShowArgs(["0xabc", "0xdef"])).to.throw(/unexpected extra argument/i);
  });

  it("rejects a flag missing its value", function () {
    expect(() => parseShowArgs(["0xabc", "--contract"])).to.throw(/--contract requires a value/i);
  });
});

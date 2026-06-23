const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const { runList, applyFilters, jsonRecord } = require("../cli/list");
const { ATTRIBUTION_PROVEN, ATTRIBUTION_ANCHOR_ONLY, TRUST_CAVEAT } = require("../cli/list");
const { ABI } = require("../cli/anchor");

// ---------------------------------------------------------------------------
// T-7.2 — `vh list`: read-only enumeration of the registry (discovery + audit).
//
// Strategy: spin up a real local hardhat JSON-RPC node (mirroring cli.verify.test.js), seed it with
// 2 one-shot anchors (authorBound=false) from distinct signers and 1 commit-reveal (authorBound=true),
// then drive runList() through a read-only provider and assert ordering, fields, attribution, the
// trust caveat, every filter, JSON output, and the empty-registry path.
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

// Compute the commitment exactly as the contract does: keccak256(abi.encode(hash, addr, salt)).
function commitmentOf(contentHash, committer, salt) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "bytes32"],
      [contentHash, committer, salt]
    )
  );
}

describe("cli: vh list", function () {
  this.timeout(60000);

  const PORT = 18548; // distinct from the anchor/verify suites so the nodes never collide
  const RPC_URL = `http://127.0.0.1:${PORT}`;
  let nodeProc;
  let provider;
  let deployer;
  let alice; // anchors record [0] (one-shot) and reveals record [2] (commit-reveal)
  let bob; // anchors record [1] (one-shot)
  let registryAddress; // the SEEDED registry (3 records)
  let emptyAddress; // a freshly-deployed, never-written registry (0 records)

  // Stable, known content hashes/uris so assertions are exact.
  const H0 = ethers.keccak256(ethers.toUtf8Bytes("list-item-0"));
  const H1 = ethers.keccak256(ethers.toUtf8Bytes("list-item-1"));
  const H2 = ethers.keccak256(ethers.toUtf8Bytes("list-item-2-revealed"));
  const URI0 = "ipfs://cid-0";
  const URI1 = ""; // record [1] is anchored with NO uri -> list must print "(none)"
  const URI2 = "https://example.com/claim";
  const SALT = ethers.keccak256(ethers.toUtf8Bytes("alice-list-salt"));

  before(async function () {
    nodeProc = spawn(
      "npx",
      ["hardhat", "node", "--hostname", "127.0.0.1", "--port", String(PORT)],
      { cwd: path.join(__dirname, ".."), stdio: ["ignore", "ignore", "ignore"] }
    );
    await waitForRpc(RPC_URL, 45000);

    provider = new ethers.JsonRpcProvider(RPC_URL);
    // Hardhat dev accounts #0..#2 (deployer / alice / bob).
    deployer = new ethers.Wallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // #0
      provider
    );
    // Alice sends multiple back-to-back txs (anchor + commit + reveal). Wrap her (and bob, for
    // symmetry) in a NonceManager so sequential sends on this shared provider don't reuse a nonce.
    // `.address` is not on a NonceManager, so capture the underlying wallet addresses too.
    const aliceWallet = new ethers.Wallet(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // #1
      provider
    );
    const bobWallet = new ethers.Wallet(
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2
      provider
    );
    alice = new ethers.NonceManager(aliceWallet);
    alice.address = aliceWallet.address;
    bob = new ethers.NonceManager(bobWallet);
    bob.address = bobWallet.address;

    const Factory = await ethers.getContractFactory("ContributionRegistry", deployer);

    // Seeded registry: 3 records in a known insertion order.
    const registry = await Factory.deploy();
    await registry.waitForDeployment();
    registryAddress = await registry.getAddress();

    // [0] one-shot anchor by alice (authorBound=false), with a uri.
    await (await registry.connect(alice).anchor(H0, URI0)).wait();
    // [1] one-shot anchor by bob (authorBound=false), NO uri.
    await (await registry.connect(bob).anchor(H1, URI1)).wait();
    // [2] commit-reveal by alice (authorBound=true): commit, mature, reveal.
    await (await registry.connect(alice).commit(commitmentOf(H2, alice.address, SALT))).wait();
    await provider.send("evm_mine", []);
    await provider.send("evm_mine", []);
    await (await registry.connect(alice).reveal(H2, SALT, URI2)).wait();

    expect(await registry.total()).to.equal(3n);

    // A separate, untouched registry for the empty-registry path.
    const empty = await Factory.deploy();
    await empty.waitForDeployment();
    emptyAddress = await empty.getAddress();
  });

  after(function () {
    if (nodeProc) nodeProc.kill("SIGKILL");
  });

  // A read-only provider call helper: build the result, capture human output.
  async function list(extra = {}) {
    let out = "";
    const res = await runList({
      contractAddress: registryAddress,
      provider,
      log: (s) => (out += s),
      ...extra,
    });
    return { res, out };
  }

  // -------------------------------------------------------------------------
  // Core: all 3 records, insertion order, correct fields + authorBound.
  // -------------------------------------------------------------------------
  it("lists all 3 records in insertion order with the right authorBound per record", async function () {
    const { res, out } = await list();
    expect(res.total).to.equal(3);
    expect(res.shown).to.equal(3);

    const recs = res.records;
    expect(recs.map((r) => r.index)).to.deep.equal([0, 1, 2]);
    expect(recs.map((r) => r.contentHash)).to.deep.equal([H0, H1, H2]);
    expect(recs.map((r) => r.contributor)).to.deep.equal([
      alice.address,
      bob.address,
      alice.address,
    ]);
    // The two one-shot anchors are NOT author-bound; the revealed claim is.
    expect(recs.map((r) => r.authorBound)).to.deep.equal([false, false, true]);

    // Attribution strings reuse verify.js wording exactly.
    expect(recs[0].attribution).to.equal(ATTRIBUTION_ANCHOR_ONLY);
    expect(recs[1].attribution).to.equal(ATTRIBUTION_ANCHOR_ONLY);
    expect(recs[2].attribution).to.equal(ATTRIBUTION_PROVEN);

    // Timestamps / blockNumbers are real positive values; block heights are non-decreasing in order.
    for (const r of recs) {
      expect(r.timestamp).to.be.a("number").and.greaterThan(0);
      expect(r.blockNumber).to.be.a("number").and.greaterThan(0);
      expect(r.timestampISO).to.match(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(recs[1].blockNumber).to.be.at.least(recs[0].blockNumber);
    expect(recs[2].blockNumber).to.be.at.least(recs[1].blockNumber);

    // Human block carries index, contentHash, contributor, attribution, timestamp(+ISO),
    // blockNumber, and uri (record [1] has none -> "(none)").
    expect(out).to.match(/\[0\]/);
    expect(out).to.match(/\[1\]/);
    expect(out).to.match(/\[2\]/);
    expect(out).to.contain(H0);
    expect(out).to.contain(alice.address);
    expect(out).to.contain(bob.address);
    expect(out).to.contain(ATTRIBUTION_PROVEN);
    expect(out).to.contain(ATTRIBUTION_ANCHOR_ONLY);
    expect(out).to.match(/blockNumber:/);
    expect(out).to.contain(URI0);
    expect(out).to.match(/uri: +\(none\)/); // record [1]'s empty uri renders as "(none)"
  });

  // -------------------------------------------------------------------------
  // Trust caveat leads every human run.
  // -------------------------------------------------------------------------
  it("leads the human output with the one-line trust caveat (uri untrusted; contributor meaning)", async function () {
    const { out } = await list();
    // The caveat is the very first line of human output.
    expect(out.startsWith(TRUST_CAVEAT)).to.equal(true);
    expect(out).to.match(/UNTRUSTED/);
    expect(out).to.match(/authorBound/);
    expect(out).to.match(/first anchorer/);
  });

  // -------------------------------------------------------------------------
  // --contributor filters to a single signer's records.
  // -------------------------------------------------------------------------
  it("--contributor filters to only that address's records (insertion order kept)", async function () {
    // Alice authored records [0] and [2].
    const { res } = await list({ filters: { contributor: alice.address } });
    expect(res.shown).to.equal(2);
    expect(res.records.map((r) => r.index)).to.deep.equal([0, 2]);
    expect(res.records.every((r) => r.contributor === alice.address)).to.equal(true);

    // Bob authored only record [1].
    const bobOnly = await list({ filters: { contributor: bob.address } });
    expect(bobOnly.res.shown).to.equal(1);
    expect(bobOnly.res.records[0].index).to.equal(1);
    expect(bobOnly.res.records[0].contributor).to.equal(bob.address);
  });

  it("--contributor is case-insensitive on the address", async function () {
    const { res } = await list({ filters: { contributor: alice.address.toLowerCase() } });
    expect(res.shown).to.equal(2);
    const upper = await list({ filters: { contributor: alice.address.toUpperCase().replace("0X", "0x") } });
    expect(upper.res.shown).to.equal(2);
  });

  it("--contributor with no matches prints the 'no records' line", async function () {
    const stranger = ethers.Wallet.createRandom().address;
    const { res, out } = await list({ filters: { contributor: stranger } });
    expect(res.shown).to.equal(0);
    expect(out).to.match(/no records/);
  });

  it("rejects an invalid --contributor address (a typo never silently returns empty)", async function () {
    let err = null;
    try {
      await runList({ contractAddress: registryAddress, provider, filters: { contributor: "0xnothex" }, log: () => {} });
    } catch (e) {
      err = e;
    }
    expect(err).to.not.equal(null);
    expect(err.message).to.match(/invalid --contributor/i);
  });

  // -------------------------------------------------------------------------
  // --author-bound returns only the revealed (commit-reveal) record.
  // -------------------------------------------------------------------------
  it("--author-bound returns only the commit-reveal record", async function () {
    const { res } = await list({ filters: { authorBound: true } });
    expect(res.shown).to.equal(1);
    expect(res.records[0].index).to.equal(2);
    expect(res.records[0].contentHash).to.equal(H2);
    expect(res.records[0].authorBound).to.equal(true);
    expect(res.records[0].attribution).to.equal(ATTRIBUTION_PROVEN);
  });

  it("--author-bound combines with --contributor (AND)", async function () {
    // Alice's author-bound records = only [2]. Bob has none.
    const aliceBound = await list({ filters: { authorBound: true, contributor: alice.address } });
    expect(aliceBound.res.records.map((r) => r.index)).to.deep.equal([2]);

    const bobBound = await list({ filters: { authorBound: true, contributor: bob.address } });
    expect(bobBound.res.shown).to.equal(0);
  });

  // -------------------------------------------------------------------------
  // --json: machine-readable array carrying the same fields.
  // -------------------------------------------------------------------------
  it("--json emits a parseable array carrying the same fields", async function () {
    const { res, out } = await list({ json: true });
    const parsed = JSON.parse(out);
    expect(parsed).to.be.an("array").with.length(3);
    // Same fields/semantics as the structured result.
    expect(parsed).to.deep.equal(res.records);

    expect(parsed[0]).to.include({
      index: 0,
      contentHash: H0,
      contributor: alice.address,
      authorBound: false,
      attribution: ATTRIBUTION_ANCHOR_ONLY,
      uri: URI0,
    });
    expect(parsed[2]).to.include({
      index: 2,
      contentHash: H2,
      contributor: alice.address,
      authorBound: true,
      attribution: ATTRIBUTION_PROVEN,
      uri: URI2,
    });
    // Record [1]'s empty uri serializes as null in JSON (the human renderer shows "(none)").
    expect(parsed[1].uri).to.equal(null);
    // Numeric, JSON-safe timestamp/blockNumber + an ISO string.
    expect(parsed[0].timestamp).to.be.a("number");
    expect(parsed[0].blockNumber).to.be.a("number");
    expect(parsed[0].timestampISO).to.match(/^\d{4}-\d{2}-\d{2}T/);
    // No human caveat leaks into the JSON stream (clean for piping).
    expect(out).to.not.contain("UNTRUSTED");
  });

  it("--json respects filters (e.g. --author-bound yields a single-element array)", async function () {
    const { out } = await list({ json: true, filters: { authorBound: true } });
    const parsed = JSON.parse(out);
    expect(parsed).to.have.length(1);
    expect(parsed[0].index).to.equal(2);
  });

  it("--json on an empty result is the empty array []", async function () {
    let out = "";
    await runList({
      contractAddress: emptyAddress,
      provider,
      json: true,
      log: (s) => (out += s),
    });
    expect(JSON.parse(out)).to.deep.equal([]);
  });

  // -------------------------------------------------------------------------
  // --limit / --offset page over the (filtered) result.
  // -------------------------------------------------------------------------
  it("--limit and --offset page correctly over the full set", async function () {
    // First page: limit 2 -> records [0],[1].
    const p0 = await list({ filters: { limit: 2 } });
    expect(p0.res.records.map((r) => r.index)).to.deep.equal([0, 1]);

    // Second page: offset 2, limit 2 -> only record [2] remains.
    const p1 = await list({ filters: { offset: 2, limit: 2 } });
    expect(p1.res.records.map((r) => r.index)).to.deep.equal([2]);

    // A single middle record: offset 1, limit 1 -> [1].
    const mid = await list({ filters: { offset: 1, limit: 1 } });
    expect(mid.res.records.map((r) => r.index)).to.deep.equal([1]);

    // Offset past the end -> empty, "no records".
    const past = await list({ filters: { offset: 99 } });
    expect(past.res.shown).to.equal(0);
    expect(past.out).to.match(/no records/);

    // Walking fixed-size pages reproduces the whole sequence in order.
    const seen = [];
    for (let off = 0; off < 3; off += 2) {
      const pg = await list({ filters: { offset: off, limit: 2 } });
      for (const r of pg.res.records) seen.push(r.index);
    }
    expect(seen).to.deep.equal([0, 1, 2]);
  });

  it("--limit/--offset page over the FILTERED set, not the raw registry", async function () {
    // Alice's records are [0] and [2]. offset 1 over that filtered set -> only [2].
    const { res } = await list({ filters: { contributor: alice.address, offset: 1 } });
    expect(res.records.map((r) => r.index)).to.deep.equal([2]);
  });

  // -------------------------------------------------------------------------
  // Empty registry path.
  // -------------------------------------------------------------------------
  it("an empty registry prints a clear 'no records' line (and total 0)", async function () {
    let out = "";
    const res = await runList({
      contractAddress: emptyAddress,
      provider,
      log: (s) => (out += s),
    });
    expect(res.total).to.equal(0);
    expect(res.shown).to.equal(0);
    expect(out).to.match(/no records/);
    // Even the empty run still leads with the trust caveat.
    expect(out.startsWith(TRUST_CAVEAT)).to.equal(true);
  });

  // -------------------------------------------------------------------------
  // Read-only: list never writes (total unchanged).
  // -------------------------------------------------------------------------
  it("is read-only: enumerating does not change on-chain state", async function () {
    const registry = new ethers.Contract(registryAddress, ABI, provider);
    const before = await registry.total();
    await list();
    await list({ json: true, filters: { authorBound: true } });
    expect(await registry.total()).to.equal(before);
  });

  // -------------------------------------------------------------------------
  // Input validation.
  // -------------------------------------------------------------------------
  it("requires a contract address", async function () {
    let err = null;
    try {
      await runList({ provider });
    } catch (e) {
      err = e;
    }
    expect(err).to.not.equal(null);
    expect(err.message).to.match(/contract address/i);
  });

  it("rejects an invalid contract address", async function () {
    let err = null;
    try {
      await runList({ contractAddress: "0xnothex", provider });
    } catch (e) {
      err = e;
    }
    expect(err).to.not.equal(null);
    expect(err.message).to.match(/invalid contract address/i);
  });

  it("requires a provider (list needs a network to read from)", async function () {
    let err = null;
    try {
      await runList({ contractAddress: registryAddress });
    } catch (e) {
      err = e;
    }
    expect(err).to.not.equal(null);
    expect(err.message).to.match(/provider/i);
  });
});

// ---------------------------------------------------------------------------
// Pure unit: applyFilters / jsonRecord — no node needed.
// ---------------------------------------------------------------------------
describe("list: applyFilters (pure)", function () {
  const A = "0x1111111111111111111111111111111111111111";
  const B = "0x2222222222222222222222222222222222222222";
  const sample = [
    { index: 0, contributor: A, authorBound: false, timestamp: 1n, blockNumber: 1n, contentHash: "0xaa", uri: "u0" },
    { index: 1, contributor: B, authorBound: false, timestamp: 2n, blockNumber: 2n, contentHash: "0xbb", uri: "" },
    { index: 2, contributor: A, authorBound: true, timestamp: 3n, blockNumber: 3n, contentHash: "0xcc", uri: "u2" },
  ];

  it("no filters returns everything in order", function () {
    expect(applyFilters(sample, {}).map((r) => r.index)).to.deep.equal([0, 1, 2]);
  });

  it("contributor filter is case-insensitive and keeps order", function () {
    expect(applyFilters(sample, { contributor: A.toUpperCase().replace("0X", "0x") }).map((r) => r.index)).to.deep.equal([0, 2]);
  });

  it("authorBound filter keeps only true", function () {
    expect(applyFilters(sample, { authorBound: true }).map((r) => r.index)).to.deep.equal([2]);
  });

  it("offset/limit window the filtered set", function () {
    expect(applyFilters(sample, { offset: 1, limit: 1 }).map((r) => r.index)).to.deep.equal([1]);
    expect(applyFilters(sample, { contributor: A, offset: 1 }).map((r) => r.index)).to.deep.equal([2]);
  });

  it("limit of 0 returns nothing", function () {
    expect(applyFilters(sample, { limit: 0 })).to.have.length(0);
  });

  it("jsonRecord maps an empty uri to null and BigInts to numbers", function () {
    const j = jsonRecord(sample[1]);
    expect(j.uri).to.equal(null);
    expect(j.timestamp).to.equal(2);
    expect(j.blockNumber).to.equal(2);
    expect(j.attribution).to.equal(ATTRIBUTION_ANCHOR_ONLY);
  });
});

// ---------------------------------------------------------------------------
// Pure unit: parseListArgs — strict parser parity with the other vh commands.
// ---------------------------------------------------------------------------
describe("list: parseListArgs (strict parser parity)", function () {
  const { parseListArgs } = require("../cli/vh");

  it("parses every flag", function () {
    const o = parseListArgs([
      "--contract", "0xabc", "--rpc", "http://x", "--contributor", "0xdef",
      "--author-bound", "--limit", "5", "--offset", "2", "--json",
    ]);
    expect(o.contract).to.equal("0xabc");
    expect(o.rpc).to.equal("http://x");
    expect(o.contributor).to.equal("0xdef");
    expect(o.authorBound).to.equal(true);
    expect(o.limit).to.equal(5);
    expect(o.offset).to.equal(2);
    expect(o.json).to.equal(true);
  });

  it("defaults: no flags -> no filters, human output", function () {
    const o = parseListArgs([]);
    expect(o.authorBound).to.equal(false);
    expect(o.json).to.equal(false);
    expect(o.limit).to.equal(undefined);
    expect(o.offset).to.equal(undefined);
  });

  it("hard-errors on an unknown flag (a typo never silently returns a wrong list)", function () {
    expect(() => parseListArgs(["--auther-bound"])).to.throw(/unknown flag/i);
    expect(() => parseListArgs(["--limt", "5"])).to.throw(/unknown flag/i);
  });

  it("hard-errors on a positional argument (list takes none)", function () {
    expect(() => parseListArgs(["somepath"])).to.throw(/no positional/i);
  });

  it("hard-errors on an incomplete flag (missing value)", function () {
    expect(() => parseListArgs(["--contract"])).to.throw(/requires a value/i);
    expect(() => parseListArgs(["--contributor"])).to.throw(/requires a value/i);
    expect(() => parseListArgs(["--limit"])).to.throw(/requires/i);
  });

  it("hard-errors on a non-integer --limit/--offset", function () {
    expect(() => parseListArgs(["--limit", "five"])).to.throw(/non-negative integer/i);
    expect(() => parseListArgs(["--offset", "-1"])).to.throw(/non-negative integer/i);
    expect(() => parseListArgs(["--limit", "3.5"])).to.throw(/non-negative integer/i);
  });
});

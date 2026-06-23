const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const {
  runReputation,
  computeScore,
  jsonScore,
  TRUST_CAVEAT,
} = require("../cli/reputation");
const { ATTRIBUTION_PROVEN, ATTRIBUTION_ANCHOR_ONLY } = require("../cli/list");
const { RegistryAuthError } = require("../cli/registry");
const { ABI } = require("../cli/anchor");

// ---------------------------------------------------------------------------
// T-12.2 — `vh reputation <addr>`: read-only, verifiable contribution score for ONE contributor.
//
// Strategy: spin up a real local hardhat JSON-RPC node (mirroring cli.list.test.js), seed it with a
// known mix:
//   A: [0] one-shot anchor (authorBound=false, lineage root)
//      [1] commit-reveal     (authorBound=true,  lineage root)
//      [2] revision WITH parent (anchorWithParent of A's [0]; authorBound=false, NOT a root)
//   B: [3] one-shot anchor (authorBound=false, lineage root)
// then drive runReputation() through a read-only provider and assert the total, the authorBound vs
// anchor-only breakdown, the lineage-root vs revision breakdown, block/time bounds, the empty path, the
// malformed-address-without-network path, the --json round-trip (carrying the registry block), and a
// non-registry contract hard-erroring via assertRegistry (T-11.2 stub pattern).
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

describe("cli: vh reputation (T-12.2)", function () {
  this.timeout(60000);

  const PORT = 18556; // distinct from the other CLI suites so the nodes never collide
  const RPC_URL = `http://127.0.0.1:${PORT}`;
  let nodeProc;
  let provider;
  let deployer;
  let alice; // A: anchors [0], reveals [1], anchorWithParent [2]
  let bob; // B: anchors [3]
  let registryAddress; // the SEEDED registry (A: 3 records, B: 1 record)
  let emptyAddress; // a freshly-deployed, never-written registry (0 records)
  let notRegistryAddress; // a deployed NON-registry (assertRegistry must reject it)

  // Stable, known content hashes/uris so assertions are exact.
  const HA0 = ethers.keccak256(ethers.toUtf8Bytes("rep-A-0-anchor-root"));
  const HA1 = ethers.keccak256(ethers.toUtf8Bytes("rep-A-1-revealed-root"));
  const HA2 = ethers.keccak256(ethers.toUtf8Bytes("rep-A-2-revision-child"));
  const HB0 = ethers.keccak256(ethers.toUtf8Bytes("rep-B-0-anchor-root"));
  const SALT = ethers.keccak256(ethers.toUtf8Bytes("alice-rep-salt"));

  before(async function () {
    nodeProc = spawn(
      "npx",
      ["hardhat", "node", "--hostname", "127.0.0.1", "--port", String(PORT)],
      { cwd: path.join(__dirname, ".."), stdio: ["ignore", "ignore", "ignore"] }
    );
    await waitForRpc(RPC_URL, 45000);

    provider = new ethers.JsonRpcProvider(RPC_URL);
    // The deployer (#0) sends MULTIPLE deploy txs (seeded registry, empty registry, non-registry stub).
    // Wrap it in a NonceManager so those sequential deploys never contend on a stale provider-cached
    // nonce (same discipline used for alice/bob below).
    deployer = new ethers.NonceManager(
      new ethers.Wallet(
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // hardhat #0
        provider
      )
    );
    // Alice sends several back-to-back txs (anchor + commit + reveal + anchorWithParent). Wrap her (and
    // bob) in a NonceManager so sequential sends on this shared provider don't reuse a nonce. `.address`
    // is not on a NonceManager, so capture the underlying wallet addresses too.
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

    // Seeded registry: A has 3 records, B has 1.
    const registry = await Factory.deploy();
    await registry.waitForDeployment();
    registryAddress = await registry.getAddress();

    // A:[0] one-shot anchor (authorBound=false, lineage root).
    await (await registry.connect(alice).anchor(HA0, "ipfs://a0")).wait();
    // A:[1] commit-reveal (authorBound=true, lineage root): commit, mature, reveal.
    await (await registry.connect(alice).commit(commitmentOf(HA1, alice.address, SALT))).wait();
    await provider.send("evm_mine", []);
    await provider.send("evm_mine", []);
    await (await registry.connect(alice).reveal(HA1, SALT, "https://example.com/a1")).wait();
    // A:[2] revision WITH parent (anchorWithParent of HA0; authorBound=false, parent != 0x0).
    await (await registry.connect(alice).anchorWithParent(HA2, "ipfs://a2", HA0)).wait();
    // B:[0] one-shot anchor (authorBound=false, lineage root).
    await (await registry.connect(bob).anchor(HB0, "")).wait();

    expect(await registry.total()).to.equal(4n);
    expect(await registry.contributorRecordCount(alice.address)).to.equal(3n);
    expect(await registry.contributorRecordCount(bob.address)).to.equal(1n);

    // A separate, untouched registry for the empty path.
    const empty = await Factory.deploy();
    await empty.waitForDeployment();
    emptyAddress = await empty.getAddress();

    // A DEPLOYED non-registry stub (T-11.2 pattern): assertRegistry must reject it.
    const NotReg = await ethers.getContractFactory("NotARegistry", deployer);
    const notReg = await NotReg.deploy();
    await notReg.waitForDeployment();
    notRegistryAddress = await notReg.getAddress();
  });

  after(function () {
    if (nodeProc) nodeProc.kill("SIGKILL");
  });

  // A read-only provider call helper: build the result, capture human output.
  async function rep(address, extra = {}) {
    let out = "";
    const res = await runReputation({
      address,
      contractAddress: registryAddress,
      provider,
      log: (s) => (out += s),
      ...extra,
    });
    return { res, out };
  }

  // -------------------------------------------------------------------------
  // Core: A's full score — total + breakdowns + bounds.
  // -------------------------------------------------------------------------
  it("reputation A reports the right total + authorBound/anchor-only + root/revision breakdowns", async function () {
    const { res, out } = await rep(alice.address);

    expect(res.total).to.equal(3);
    // A: [0] anchor (false), [1] reveal (true), [2] anchorWithParent (false).
    expect(res.authorBound).to.equal(1);
    expect(res.anchorOnly).to.equal(2);
    // The two MUST stay separate — never collapsed into one number.
    expect(res.authorBound + res.anchorOnly).to.equal(res.total);

    // Lineage: [0] and [1] are roots (parent == 0x0); [2] is a revision (parent != 0x0).
    expect(res.lineageRoots).to.equal(2);
    expect(res.revisions).to.equal(1);
    expect(res.lineageRoots + res.revisions).to.equal(res.total);

    // Human block carries the address, the separate breakdowns, and both attribution strings.
    expect(out).to.contain(alice.address);
    expect(out).to.match(/total records: 3/);
    expect(out).to.match(/authorBound: +1/);
    expect(out).to.match(/anchor-only: +2/);
    expect(out).to.match(/lineage roots: 2/);
    expect(out).to.match(/revisions: +1/);
    expect(out).to.contain(ATTRIBUTION_PROVEN);
    expect(out).to.contain(ATTRIBUTION_ANCHOR_ONLY);
  });

  it("reputation A reports the earliest/latest blockNumber + timestamp (+ISO) bounds", async function () {
    const { res, out } = await rep(alice.address);

    expect(res.earliest).to.not.equal(null);
    expect(res.latest).to.not.equal(null);
    // Earliest is A's first record (HA0), latest is A's last (HA2): earliest block < latest block.
    expect(res.earliest.blockNumber).to.be.a("number").and.greaterThan(0);
    expect(res.latest.blockNumber).to.be.a("number").and.greaterThan(0);
    expect(res.latest.blockNumber).to.be.at.least(res.earliest.blockNumber);
    expect(res.latest.timestamp).to.be.at.least(res.earliest.timestamp);
    expect(res.earliest.timestampISO).to.match(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.latest.timestampISO).to.match(/^\d{4}-\d{2}-\d{2}T/);

    // Cross-check the bounds against the on-chain records directly (verifiable / re-derivable).
    const c = new ethers.Contract(registryAddress, ABI, provider);
    const r0 = await c.getRecord(HA0);
    const r2 = await c.getRecord(HA2);
    expect(res.earliest.blockNumber).to.equal(Number(r0.blockNumber));
    expect(res.latest.blockNumber).to.equal(Number(r2.blockNumber));

    expect(out).to.match(/earliest: +block \d+, ts \d+/);
    expect(out).to.match(/latest: +block \d+, ts \d+/);
  });

  // -------------------------------------------------------------------------
  // Trust caveat LEADS the human output.
  // -------------------------------------------------------------------------
  it("leads the human output with the trust caveat (not a token; authorBound bar; does not validate content)", async function () {
    const { out } = await rep(alice.address);
    expect(out.startsWith(TRUST_CAVEAT)).to.equal(true);
    expect(out).to.match(/NOT a reputation token/i);
    expect(out).to.match(/front-runnable/i);
    expect(out).to.match(/does NOT validate the CONTENT/i);
    expect(out).to.match(/vh verify/);
    expect(out).to.match(/D-2 \/ P-1/);
  });

  // -------------------------------------------------------------------------
  // reputation B reports only B's.
  // -------------------------------------------------------------------------
  it("reputation B reports only B's single record (no A records leak in)", async function () {
    const { res } = await rep(bob.address);
    expect(res.total).to.equal(1);
    expect(res.authorBound).to.equal(0); // B's only record is a one-shot anchor
    expect(res.anchorOnly).to.equal(1);
    expect(res.lineageRoots).to.equal(1); // it's a root
    expect(res.revisions).to.equal(0);
    // B's earliest == latest (one record).
    expect(res.earliest.blockNumber).to.equal(res.latest.blockNumber);

    const c = new ethers.Contract(registryAddress, ABI, provider);
    const rb = await c.getRecord(HB0);
    expect(res.earliest.blockNumber).to.equal(Number(rb.blockNumber));
  });

  // -------------------------------------------------------------------------
  // Zero-record address -> "no contributions".
  // -------------------------------------------------------------------------
  it("an address with no records reports 'no contributions' (total 0)", async function () {
    const stranger = ethers.Wallet.createRandom().address;
    const { res, out } = await rep(stranger);
    expect(res.total).to.equal(0);
    expect(res.authorBound).to.equal(0);
    expect(res.anchorOnly).to.equal(0);
    expect(res.earliest).to.equal(null);
    expect(res.latest).to.equal(null);
    expect(out).to.match(/no contributions/i);
    // Even the empty run still leads with the trust caveat.
    expect(out.startsWith(TRUST_CAVEAT)).to.equal(true);
  });

  it("--json on a zero-record address emits { total: 0, ... } with null bounds and the registry block", async function () {
    const stranger = ethers.Wallet.createRandom().address;
    let out = "";
    await runReputation({
      address: stranger,
      contractAddress: registryAddress,
      provider,
      json: true,
      log: (s) => (out += s),
    });
    const parsed = JSON.parse(out);
    expect(parsed.total).to.equal(0);
    expect(parsed.earliest).to.equal(null);
    expect(parsed.latest).to.equal(null);
    // Distinguished from an RPC/identity error: it's a clean object, with a real registry block.
    expect(parsed.registry).to.include({ version: 1, chainId: 31337 });
  });

  // -------------------------------------------------------------------------
  // Malformed address -> hard error BEFORE any network call.
  // -------------------------------------------------------------------------
  it("a malformed address errors WITHOUT hitting the network (validation precedes any RPC)", async function () {
    // A provider pointed at a dead port: if validation leaked through to the network, this would throw
    // a NETWORK error instead of the validation error. It throws the validation error, proving order.
    const deadProvider = new ethers.JsonRpcProvider("http://127.0.0.1:1");
    // NOTE: ethers.isAddress() (the same validator the other read commands use) is lenient about a
    // bare 40-hex string with no `0x`, so that is NOT malformed by the project's parser contract; these
    // are the genuinely-malformed shapes that must be rejected before any RPC.
    for (const bad of [
      "0x1234", // too short
      "0x" + "ab".repeat(21), // too long
      "0x" + "zz".repeat(20), // non-hex
      "not-an-address",
    ]) {
      let err = null;
      try {
        await runReputation({
          address: bad,
          contractAddress: registryAddress,
          provider: deadProvider,
          log: () => {},
        });
      } catch (e) {
        err = e;
      }
      expect(err, `malformed address should throw: ${bad}`).to.not.equal(null);
      expect(err.message, `for ${bad}`).to.match(/invalid address|requires an <addr>/i);
      // It must be the VALIDATION error, not a network/connection error from the dead provider.
      expect(/ECONNREFUSED|could not detect network|connect/i.test(String(err.message))).to.equal(
        false
      );
    }
  });

  it("the CLI returns usage exit code 2 for a malformed address and never builds a provider", async function () {
    const { main } = require("../cli/vh");
    // Deliberately give NO --rpc and a bad address. If the address were validated AFTER the RPC check,
    // this would error on the missing RPC (exit 1). Instead it must fail on the address (exit 2, usage).
    const origErr = process.stderr.write;
    let captured = "";
    process.stderr.write = (s) => {
      captured += s;
      return true;
    };
    let code;
    try {
      code = await main(["reputation", "0x1234", "--contract", registryAddress]);
    } finally {
      process.stderr.write = origErr;
    }
    expect(code).to.equal(2); // usage error, not a runtime/RPC error
    expect(captured).to.match(/invalid address/i);
    expect(captured).to.match(/Usage:/); // usage was printed
  });

  // -------------------------------------------------------------------------
  // --json round-trips and carries the registry block.
  // -------------------------------------------------------------------------
  it("--json round-trips A's score and carries the registry authentication block (T-11.2)", async function () {
    let out = "";
    const res = await runReputation({
      address: alice.address,
      contractAddress: registryAddress,
      provider,
      json: true,
      log: (s) => (out += s),
    });
    const parsed = JSON.parse(out);

    // Same fields/semantics as the structured result.
    expect(parsed.address).to.equal(alice.address);
    expect(parsed.total).to.equal(3);
    expect(parsed.authorBound).to.equal(1);
    expect(parsed.anchorOnly).to.equal(2);
    expect(parsed.lineageRoots).to.equal(2);
    expect(parsed.revisions).to.equal(1);
    expect(parsed.total).to.equal(res.total);

    // Breakdowns are SEPARATE keys + carry the documented attribution strings.
    expect(parsed.attribution.authorBound).to.equal(ATTRIBUTION_PROVEN);
    expect(parsed.attribution.anchorOnly).to.equal(ATTRIBUTION_ANCHOR_ONLY);

    // Block/time bounds are numeric + JSON-safe + ISO.
    expect(parsed.earliest.blockNumber).to.be.a("number");
    expect(parsed.earliest.timestamp).to.be.a("number");
    expect(parsed.earliest.timestampISO).to.match(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.latest.blockNumber).to.be.a("number");

    // The registry authentication block (T-11.2) so a UI/indexer knows the score came from an
    // authenticated verifyhash registry.
    expect(parsed.registry).to.include({ version: 1, chainId: 31337 });
    expect(parsed.registry.id).to.match(/^0x[0-9a-f]{64}$/);

    // No human caveat leaks into the JSON stream (clean for piping).
    expect(out).to.not.contain("NOTE:");
  });

  // -------------------------------------------------------------------------
  // Non-registry contract -> hard-error via assertRegistry (T-11.2 stub pattern).
  // -------------------------------------------------------------------------
  it("pointing at a DEPLOYED non-registry hard-errors via assertRegistry and reports NO score", async function () {
    let err = null;
    let out = "";
    try {
      await runReputation({
        address: alice.address,
        contractAddress: notRegistryAddress,
        provider,
        log: (s) => (out += s),
      });
    } catch (e) {
      err = e;
    }
    expect(err, "must throw").to.be.instanceOf(RegistryAuthError);
    expect(err.message).to.match(/is not a verifyhash ContributionRegistry/);
    // No score / no records were reported before the preflight failed.
    expect(out).to.equal("");
  });

  it("--skip-identity-check bypasses the preflight (loud skip block in human + json)", async function () {
    // On the GENUINE registry, skipping still works and emits the loud skip warning instead of the
    // registry-auth confirmation. (Skipping never changes the derived numbers.)
    const { res, out } = await rep(alice.address, { skipIdentityCheck: true });
    expect(res.total).to.equal(3);
    expect(out).to.match(/SKIPPED/);

    let jout = "";
    const jres = await runReputation({
      address: alice.address,
      contractAddress: registryAddress,
      provider,
      json: true,
      skipIdentityCheck: true,
      log: (s) => (jout += s),
    });
    expect(jres.total).to.equal(3);
    const parsed = JSON.parse(jout);
    expect(parsed.registry).to.have.property("skipped", true);
  });

  // -------------------------------------------------------------------------
  // Read-only: scoring never writes (total unchanged).
  // -------------------------------------------------------------------------
  it("is read-only: scoring does not change on-chain state", async function () {
    const registry = new ethers.Contract(registryAddress, ABI, provider);
    const before = await registry.total();
    await rep(alice.address);
    await rep(alice.address, { json: true });
    await rep(bob.address);
    expect(await registry.total()).to.equal(before);
  });

  // -------------------------------------------------------------------------
  // Input validation (programmatic).
  // -------------------------------------------------------------------------
  it("requires a contract address", async function () {
    let err = null;
    try {
      await runReputation({ address: alice.address, provider });
    } catch (e) {
      err = e;
    }
    expect(err).to.not.equal(null);
    expect(err.message).to.match(/contract address/i);
  });

  it("requires a provider", async function () {
    let err = null;
    try {
      await runReputation({ address: alice.address, contractAddress: registryAddress });
    } catch (e) {
      err = e;
    }
    expect(err).to.not.equal(null);
    expect(err.message).to.match(/provider/i);
  });

  // -------------------------------------------------------------------------
  // CLI exit codes: 0 when records exist, 4 (not-found convention) when none.
  // -------------------------------------------------------------------------
  it("the CLI exits 0 for an address with records and 4 (not-found convention) for none", async function () {
    const { main } = require("../cli/vh");
    const origOut = process.stdout.write;
    process.stdout.write = () => true; // swallow the human/json blocks
    let codeWith;
    let codeNone;
    try {
      codeWith = await main([
        "reputation",
        alice.address,
        "--contract",
        registryAddress,
        "--rpc",
        RPC_URL,
        "--json",
      ]);
      const stranger = ethers.Wallet.createRandom().address;
      codeNone = await main([
        "reputation",
        stranger,
        "--contract",
        registryAddress,
        "--rpc",
        RPC_URL,
        "--json",
      ]);
    } finally {
      process.stdout.write = origOut;
    }
    expect(codeWith).to.equal(0);
    expect(codeNone).to.equal(4);
  });
});

// ---------------------------------------------------------------------------
// Pure unit: computeScore / jsonScore — no node needed.
// ---------------------------------------------------------------------------
describe("reputation: computeScore / jsonScore (pure)", function () {
  const ZERO = "0x" + "0".repeat(64);
  const PARENT = "0x" + "1".repeat(64);
  const A = "0x1111111111111111111111111111111111111111";

  const sample = [
    { authorBound: true, parent: ZERO, blockNumber: 5n, timestamp: 100n },
    { authorBound: false, parent: PARENT, blockNumber: 3n, timestamp: 80n }, // earliest by block
    { authorBound: false, parent: ZERO, blockNumber: 9n, timestamp: 150n }, // latest by block
  ];

  it("keeps authorBound and anchor-only SEPARATE and never collapses them", function () {
    const s = computeScore(sample);
    expect(s.total).to.equal(3);
    expect(s.authorBound).to.equal(1);
    expect(s.anchorOnly).to.equal(2);
    expect(s.authorBound + s.anchorOnly).to.equal(s.total);
  });

  it("splits lineage roots (parent==0x0) from revisions (parent!=0x0)", function () {
    const s = computeScore(sample);
    expect(s.lineageRoots).to.equal(2);
    expect(s.revisions).to.equal(1);
  });

  it("finds the earliest/latest by blockNumber", function () {
    const s = computeScore(sample);
    expect(s.earliest.blockNumber).to.equal(3n);
    expect(s.earliest.timestamp).to.equal(80n);
    expect(s.latest.blockNumber).to.equal(9n);
    expect(s.latest.timestamp).to.equal(150n);
  });

  it("an empty record set yields total 0 with null bounds", function () {
    const s = computeScore([]);
    expect(s.total).to.equal(0);
    expect(s.authorBound).to.equal(0);
    expect(s.anchorOnly).to.equal(0);
    expect(s.lineageRoots).to.equal(0);
    expect(s.revisions).to.equal(0);
    expect(s.earliest).to.equal(null);
    expect(s.latest).to.equal(null);
  });

  it("jsonScore maps BigInts to numbers, adds ISO, and carries separate breakdown keys", function () {
    const s = computeScore(sample);
    const j = jsonScore(A, s, { id: "0xabc", version: 1, chainId: 31337 });
    expect(j.address).to.equal(A);
    expect(j.total).to.equal(3);
    expect(j.authorBound).to.equal(1);
    expect(j.anchorOnly).to.equal(2);
    expect(j.lineageRoots).to.equal(2);
    expect(j.revisions).to.equal(1);
    expect(j.earliest.blockNumber).to.equal(3);
    expect(j.earliest.timestamp).to.equal(80);
    expect(j.earliest.timestampISO).to.match(/^\d{4}-\d{2}-\d{2}T/);
    expect(j.attribution.authorBound).to.equal(ATTRIBUTION_PROVEN);
    expect(j.attribution.anchorOnly).to.equal(ATTRIBUTION_ANCHOR_ONLY);
    expect(j.registry).to.include({ version: 1, chainId: 31337 });
    // The whole object must be JSON-serializable (no BigInt leaks).
    expect(() => JSON.stringify(j)).to.not.throw();
  });
});

// ---------------------------------------------------------------------------
// Pure unit: parseReputationArgs — strict parser parity with the other vh commands.
// ---------------------------------------------------------------------------
describe("reputation: parseReputationArgs (strict parser parity)", function () {
  const { parseReputationArgs } = require("../cli/vh");

  it("parses every flag + the positional address", function () {
    const o = parseReputationArgs([
      "0xAbC0000000000000000000000000000000000001",
      "--contract",
      "0xdef",
      "--rpc",
      "http://x",
      "--json",
      "--skip-identity-check",
    ]);
    expect(o.addr).to.equal("0xAbC0000000000000000000000000000000000001");
    expect(o.contract).to.equal("0xdef");
    expect(o.rpc).to.equal("http://x");
    expect(o.json).to.equal(true);
    expect(o.skipIdentityCheck).to.equal(true);
  });

  it("defaults: just an address -> human output, identity check ON", function () {
    const o = parseReputationArgs(["0xabc"]);
    expect(o.addr).to.equal("0xabc");
    expect(o.json).to.equal(false);
    expect(o.skipIdentityCheck).to.equal(false);
  });

  it("hard-errors on an unknown/typo flag (a typo never silently returns a wrong score)", function () {
    expect(() => parseReputationArgs(["0xabc", "--jsom"])).to.throw(/unknown flag/i);
    expect(() => parseReputationArgs(["0xabc", "--contrct", "0xdef"])).to.throw(/unknown flag/i);
  });

  it("hard-errors on a duplicate positional argument", function () {
    expect(() => parseReputationArgs(["0xabc", "0xdef"])).to.throw(/extra argument/i);
  });

  it("hard-errors on an incomplete flag (missing value)", function () {
    expect(() => parseReputationArgs(["0xabc", "--contract"])).to.throw(/requires a value/i);
    expect(() => parseReputationArgs(["0xabc", "--rpc"])).to.throw(/requires a value/i);
  });
});

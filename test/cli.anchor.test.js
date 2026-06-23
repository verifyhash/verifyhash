const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");

const {
  buildAnchorTx,
  runAnchor,
  isTestnetChainId,
  ABI,
} = require("../cli/anchor");
const { hashFile, hashDir } = require("../cli/hash");

// ---------------------------------------------------------------------------
// Helpers: a throwaway temp dir, and a real local hardhat JSON-RPC node.
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

// Poll a URL until it answers JSON-RPC, or time out.
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

describe("cli: vh anchor", function () {
  // Spinning up a real node is slower than the unit tests; give it room.
  this.timeout(60000);

  const PORT = 18545;
  const RPC_URL = `http://127.0.0.1:${PORT}`;
  let nodeProc;
  let provider;
  let signer;
  let registryAddress;

  // Well-known hardhat dev account private keys (accounts #0..#5). Each submitting test takes its
  // own signer so sequential txs never contend on a shared, provider-cached nonce.
  const DEV_KEYS = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // #0
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // #1
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // #3
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // #4
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // #5
  ];
  let keyIdx = 1; // #0 is the deployer/shared `signer`; hand out #1.. to submitting tests.
  function freshSigner() {
    const k = DEV_KEYS[keyIdx++];
    if (!k) throw new Error("ran out of dev keys for the test");
    return new ethers.Wallet(k, provider);
  }

  before(async function () {
    // Launch an actual `hardhat node` so the integration test talks to a live JSON-RPC chain,
    // not the in-process VM. This is the "runs against a local hardhat node" criterion.
    nodeProc = spawn(
      "npx",
      ["hardhat", "node", "--hostname", "127.0.0.1", "--port", String(PORT)],
      { cwd: path.join(__dirname, ".."), stdio: ["ignore", "ignore", "ignore"] }
    );
    await waitForRpc(RPC_URL, 45000);

    provider = new ethers.JsonRpcProvider(RPC_URL);
    // hardhat node funds account #0 with this well-known dev key.
    signer = new ethers.Wallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      provider
    );

    // Deploy ContributionRegistry to the live node and use that address for anchoring.
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
  // --dry-run: no key, no network write, prints the tx it WOULD send.
  // -------------------------------------------------------------------------
  describe("--dry-run", function () {
    it("builds the correct anchor tx with no signer/provider and never sends", async function () {
      const dir = tmp("vh-anchor-dry-");
      const f = writeFile(dir, "thing.txt", "anchor me");
      const expectedHash = hashFile(f);

      let out = "";
      const res = await runAnchor({
        path: f,
        uri: "ipfs://bafyExample",
        contractAddress: registryAddress,
        dryRun: true,
        // Deliberately NO signer and NO provider: dry run must not need either.
        log: (s) => (out += s),
      });

      expect(res.dryRun).to.equal(true);
      expect(res.tx.contentHash).to.equal(expectedHash);
      expect(res.tx.to).to.equal(ethers.getAddress(registryAddress));
      expect(res.tx.uri).to.equal("ipfs://bafyExample");
      expect(res.tx.value).to.equal("0x0");

      // The printed data must be a real, decodable anchor(contentHash, uri) calldata.
      const iface = new ethers.Interface(ABI);
      const decoded = iface.decodeFunctionData("anchor", res.tx.data);
      expect(decoded[0]).to.equal(expectedHash);
      expect(decoded[1]).to.equal("ipfs://bafyExample");

      // And the human output actually shows the tx that would be sent.
      expect(out).to.match(/DRY RUN/);
      expect(out).to.contain(expectedHash);
      expect(out).to.contain(res.tx.data);
      expect(out).to.contain(ethers.getAddress(registryAddress));
    });

    it("a dry run does NOT change on-chain state (total stays put)", async function () {
      const registry = new ethers.Contract(registryAddress, ABI, provider);
      const before = await registry.total();

      const dir = tmp("vh-anchor-dry-nostate-");
      const f = writeFile(dir, "noop.txt", "this should never be anchored by a dry run");
      await runAnchor({
        path: f,
        uri: "",
        contractAddress: registryAddress,
        dryRun: true,
        log: () => {},
      });

      const after = await registry.total();
      expect(after).to.equal(before);
      // And the hash is genuinely not anchored.
      expect(await registry.isAnchored(hashFile(f))).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------
  // Real submission against the live node: must emit Anchored with our hash.
  // -------------------------------------------------------------------------
  describe("submit (against a local hardhat node)", function () {
    it("anchors a single file and emits Anchored(contentHash, contributor, ...)", async function () {
      const dir = tmp("vh-anchor-file-");
      const f = writeFile(dir, "contribution.txt", "real on-chain contribution " + Date.now());
      const expectedHash = hashFile(f);

      const submitter = freshSigner();
      const res = await runAnchor({
        path: f,
        uri: "https://example.com/commit/abc123",
        contractAddress: registryAddress,
        provider,
        signer: submitter,
        log: () => {},
      });

      // The Anchored event must have been emitted and parsed off the receipt.
      expect(res.dryRun).to.equal(false);
      expect(res.anchored, "Anchored event should be present").to.not.equal(null);
      expect(res.anchored.contentHash).to.equal(expectedHash);
      expect(res.anchored.contributor).to.equal(await submitter.getAddress());
      expect(res.anchored.uri).to.equal("https://example.com/commit/abc123");

      // Cross-check the *receipt logs* directly (not just our parsed copy) for the event topic,
      // so the assertion can't be satisfied by a bug in our own parser.
      const iface = new ethers.Interface(ABI);
      const anchoredTopic = iface.getEvent("Anchored").topicHash;
      const evLog = res.receipt.logs.find((l) => l.topics[0] === anchoredTopic);
      expect(evLog, "receipt must contain an Anchored log").to.not.equal(undefined);
      const parsed = iface.parseLog({ topics: evLog.topics, data: evLog.data });
      expect(parsed.args.contentHash).to.equal(expectedHash);

      // The chain now reports the hash as anchored to our contributor.
      const registry = new ethers.Contract(registryAddress, ABI, provider);
      expect(await registry.isAnchored(expectedHash)).to.equal(true);
      const record = await registry.getRecord(expectedHash);
      expect(record.contributor).to.equal(await submitter.getAddress());
      expect(record.uri).to.equal("https://example.com/commit/abc123");
    });

    it("anchors a directory's Merkle root (kind=dir) and the root matches hashDir", async function () {
      const dir = tmp("vh-anchor-dir-");
      writeFile(dir, "a.txt", "alpha " + Date.now());
      writeFile(dir, "sub/b.txt", "beta");
      writeFile(dir, "sub/c.txt", "gamma");
      const expectedRoot = hashDir(dir).root;

      const res = await runAnchor({
        path: dir,
        contractAddress: registryAddress,
        provider,
        signer: freshSigner(),
        log: () => {},
      });

      expect(res.tx.kind).to.equal("dir");
      expect(res.anchored).to.not.equal(null);
      expect(res.anchored.contentHash).to.equal(expectedRoot);
      expect(res.anchored.uri).to.equal(""); // no --uri given -> empty string
    });

    it("the second anchor of the same content reverts (AlreadyAnchored), not silently", async function () {
      const dir = tmp("vh-anchor-dup-");
      const f = writeFile(dir, "dup.txt", "anchor twice " + Date.now());
      const dupSigner = freshSigner();

      await runAnchor({
        path: f,
        contractAddress: registryAddress,
        provider,
        signer: dupSigner,
        log: () => {},
      });

      let threw = false;
      try {
        await runAnchor({
          path: f,
          contractAddress: registryAddress,
          provider,
          signer: dupSigner,
          log: () => {},
        });
      } catch (e) {
        threw = true;
      }
      expect(threw, "re-anchoring identical content must revert").to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // Non-testnet chainId guard.
  // -------------------------------------------------------------------------
  describe("non-testnet chainId refusal", function () {
    it("refuses to submit on a mainnet chainId without --i-understand-mainnet", async function () {
      const dir = tmp("vh-anchor-mainnet-");
      const f = writeFile(dir, "danger.txt", "do not send to mainnet");

      let err = null;
      try {
        await runAnchor({
          path: f,
          contractAddress: registryAddress,
          provider,
          signer,
          chainId: 1n, // Ethereum mainnet — must be refused.
          log: () => {},
        });
      } catch (e) {
        err = e;
      }
      expect(err, "should have refused").to.not.equal(null);
      expect(err.message).to.match(/refusing to anchor on chainId 1\b/i);
      expect(err.message).to.match(/--i-understand-mainnet/);

      // And it must NOT have written anything: hash is still not anchored.
      const registry = new ethers.Contract(registryAddress, ABI, provider);
      expect(await registry.isAnchored(hashFile(f))).to.equal(false);
    });

    it("with --i-understand-mainnet, the chainId guard is bypassed and it actually anchors", async function () {
      // We can't force the *real* local node to report chainId 1, but the guard's branch is the
      // unit under test: override chainId to mainnet AND pass the flag, then prove it still
      // submits to the live node and emits Anchored.
      const dir = tmp("vh-anchor-override-");
      const f = writeFile(dir, "override.txt", "override mainnet guard " + Date.now());
      const expectedHash = hashFile(f);

      const res = await runAnchor({
        path: f,
        contractAddress: registryAddress,
        provider,
        signer: freshSigner(),
        chainId: 1n,
        iUnderstandMainnet: true,
        log: () => {},
      });
      expect(res.anchored).to.not.equal(null);
      expect(res.anchored.contentHash).to.equal(expectedHash);
    });

    it("allows a known testnet chainId without the override flag", async function () {
      // The real node's chainId (31337) is a known testnet, so no override is needed.
      const net = await provider.getNetwork();
      expect(isTestnetChainId(net.chainId)).to.equal(true);

      const dir = tmp("vh-anchor-testnet-ok-");
      const f = writeFile(dir, "ok.txt", "testnet ok " + Date.now());
      const res = await runAnchor({
        path: f,
        contractAddress: registryAddress,
        provider,
        signer: freshSigner(),
        // No chainId override, no --i-understand-mainnet: relies on the live node's testnet id.
        log: () => {},
      });
      expect(res.anchored).to.not.equal(null);
      expect(res.chainId).to.equal(net.chainId);
    });
  });

  // -------------------------------------------------------------------------
  // buildAnchorTx input validation (pure, no network).
  // -------------------------------------------------------------------------
  describe("buildAnchorTx validation", function () {
    it("requires a contract address", function () {
      const dir = tmp("vh-anchor-noaddr-");
      const f = writeFile(dir, "x.txt", "x");
      expect(() => buildAnchorTx({ path: f })).to.throw(/contract address/i);
    });

    it("rejects an invalid contract address", function () {
      const dir = tmp("vh-anchor-badaddr-");
      const f = writeFile(dir, "x.txt", "x");
      expect(() => buildAnchorTx({ path: f, contractAddress: "0xnothex" })).to.throw(
        /invalid contract address/i
      );
    });

    it("defaults uri to empty string when omitted", function () {
      const dir = tmp("vh-anchor-nouri-");
      const f = writeFile(dir, "x.txt", "x");
      const tx = buildAnchorTx({ path: f, contractAddress: registryAddress });
      expect(tx.uri).to.equal("");
    });
  });

  describe("isTestnetChainId", function () {
    it("accepts hardhat(31337) and amoy(80002), rejects mainnet(1) and polygon(137)", function () {
      expect(isTestnetChainId(31337)).to.equal(true);
      expect(isTestnetChainId(80002)).to.equal(true);
      expect(isTestnetChainId(1)).to.equal(false);
      expect(isTestnetChainId(137)).to.equal(false);
    });
  });
});

// ---------------------------------------------------------------------------
// CLI surface (cli/vh.js): arg parsing + that `--dry-run` works through the real
// command with NO key and NO RPC configured. No node needed here.
// ---------------------------------------------------------------------------
describe("cli surface: vh anchor (cli/vh.js)", function () {
  const { parseAnchorArgs, cmdAnchor } = require("../cli/vh");

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

  describe("parseAnchorArgs", function () {
    it("parses path, --uri, --contract, --dry-run, --i-understand-mainnet", function () {
      const o = parseAnchorArgs([
        "./some/path",
        "--uri",
        "ipfs://x",
        "--contract",
        "0xabc",
        "--dry-run",
        "--i-understand-mainnet",
      ]);
      expect(o.path).to.equal("./some/path");
      expect(o.uri).to.equal("ipfs://x");
      expect(o.contract).to.equal("0xabc");
      expect(o.dryRun).to.equal(true);
      expect(o.iUnderstandMainnet).to.equal(true);
    });

    it("defaults: dryRun=false, mainnet override=false, uri undefined", function () {
      const o = parseAnchorArgs(["p"]);
      expect(o.dryRun).to.equal(false);
      expect(o.iUnderstandMainnet).to.equal(false);
      expect(o.uri).to.equal(undefined);
    });

    it("rejects an unknown flag (a typo must not silently become a real submission)", function () {
      expect(() => parseAnchorArgs(["p", "--dryrun"])).to.throw(/unknown flag/i);
    });

    it("rejects --uri with no value", function () {
      expect(() => parseAnchorArgs(["p", "--uri"])).to.throw(/--uri requires a value/);
    });
  });

  describe("--dry-run through cmdAnchor (no key, no RPC)", function () {
    // Guarantee the environment carries no key/RPC for this path.
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

    it("returns 0 and prints the tx with no key/RPC present", async function () {
      const dir = cliTmp("vh-cli-dry-");
      const f = path.join(dir, "f.txt");
      fs.writeFileSync(f, "cli dry run content");

      const writes = [];
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = (s) => {
        writes.push(s);
        return true;
      };
      let code;
      try {
        code = await cmdAnchor([
          f,
          "--dry-run",
          "--contract",
          "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        ]);
      } finally {
        process.stdout.write = orig;
      }

      expect(code).to.equal(0);
      const out = writes.join("");
      expect(out).to.match(/DRY RUN/);
      expect(out).to.contain(hashFile(f)); // the real content hash appears in the preview
    });

    it("a real (non-dry) submit with no RPC configured fails cleanly with exit code 1", async function () {
      const dir = cliTmp("vh-cli-norpc-");
      const f = path.join(dir, "f.txt");
      fs.writeFileSync(f, "cli no rpc");

      const errs = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = (s) => {
        errs.push(s);
        return true;
      };
      let code;
      try {
        code = await cmdAnchor([f, "--contract", "0x5FbDB2315678afecb367f032d93F642f64180aa3"]);
      } finally {
        process.stderr.write = orig;
      }
      expect(code).to.equal(1);
      expect(errs.join("")).to.match(/RPC/i);
    });
  });
});

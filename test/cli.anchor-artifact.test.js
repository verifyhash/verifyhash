"use strict";

// test/cli.anchor-artifact.test.js — T-70.2: `vh anchor-artifact` / `vh verify-anchored`.
//
// The LIVE end-to-end proof (the cli.claim.test.js discipline: a spawned local hardhat node on
// 127.0.0.1, ephemeral pre-funded dev accounts, the registry deployed in-test):
//   (1) seal a fixture evidence packet, an agent-session packet, and a journal tree-head artifact;
//       anchor-artifact each (evidence/journal one-shot; agent --author-bound with the reveal-delay
//       blocks mined in-test); every emitted receipt passes verify-anchored OFFLINE (exit 0) AND
//       with --rpc --contract (exit 0);
//   (2) the tamper matrix — each edit the SPECIFIC named REJECT (exit 3): an artifact byte flip,
//       an edited receipt txHash / blockNumber / contributor, --contract at a non-registry address
//       (the EXISTING identity-probe reject), and the same digest anchored twice (the registry's
//       own named AlreadyAnchored, no stack trace);
//   (3) the guardrails: keys ONLY via --key-env/--key-file (read-used-discarded, never logged),
//       tests connect ONLY to 127.0.0.1, and the mainnet guard refuses a mocked non-test chainId
//       without --i-understand-mainnet;
//   (4) --author-bound records read back authorBound:true; one-shot records authorBound:false
//       (the D-1 semantics read back from the registry, never re-implemented);
//   (5) the free surface: no paid gate is consulted on either verb (grep-proven below).

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");

const aa = require("../cli/anchor-artifact");
const binding = require("../cli/core/anchor-binding");
const evidence = require("../cli/evidence");
const agent = require("../cli/agent");
const journalLog = require("../cli/journal-log");
const { hashBytes } = require("../cli/hash");
const { toUtf8Bytes } = require("ethers");
const vh = require("../cli/vh");

const ARTIFACT = require("../artifacts/contracts/ContributionRegistry.sol/ContributionRegistry.json");

const CLI_SOURCE_PATH = path.join(__dirname, "..", "cli", "anchor-artifact.js");
const VH_SOURCE_PATH = path.join(__dirname, "..", "cli", "vh.js");

// ---------------------------------------------------------------------------------------------------
// Helpers: temp dirs isolated under the OS temp root (cleaned in after()), io capture, fixtures.
// ---------------------------------------------------------------------------------------------------

let tmpDirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function capture() {
  const out = [];
  const err = [];
  return {
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    out: () => out.join(""),
    err: () => err.join(""),
    all: () => out.join("") + err.join(""),
  };
}

/** Build a fresh evidence-seal fixture (unique bytes per call) and write it to a temp file. */
function evidenceFixture(tag) {
  const seal = evidence.buildSeal([
    { relPath: "src/app.js", bytes: Buffer.from(`console.log(${JSON.stringify(tag)})\n`) },
    { relPath: "README.md", bytes: Buffer.from(`# demo ${tag}\n`) },
  ]);
  const file = path.join(tmp("vh-aa-ev-"), "packet.vhevidence.json");
  fs.writeFileSync(file, JSON.stringify(seal, null, 2) + "\n");
  return { seal, file };
}

/** Build a fresh agent-session packet fixture and write it to a temp file. */
function agentFixture(tag) {
  const built = agent.buildPacket([
    { seq: 0, ts: "2026-01-01T00:00:00Z", actor: "user", type: "prompt", payload: `write tests ${tag}` },
    { seq: 1, ts: "2026-01-01T00:00:05Z", actor: "agent", type: "completion", payload: `done ${tag}` },
  ]);
  expect(built.ok, "agent fixture must build").to.equal(true);
  const file = path.join(tmp("vh-aa-ag-"), "session.vhagent.json");
  fs.writeFileSync(file, JSON.stringify(built.packet, null, 2) + "\n");
  return { packet: built.packet, file };
}

/** Build a fresh kind-tagged journal tree-head artifact and write it to a temp file. */
function journalFixture(tag) {
  const head = journalLog.treeHead(
    [`entry-0-${tag}`, `entry-1-${tag}`, `entry-2-${tag}`].map((s) => hashBytes(toUtf8Bytes(s)))
  );
  const artifact = { kind: "vh.journal-tree-head", size: head.size, root: head.root };
  const file = path.join(tmp("vh-aa-jl-"), "tree-head.json");
  fs.writeFileSync(file, JSON.stringify(artifact, null, 2) + "\n");
  return { artifact, file };
}

function writeJson(dir, name, obj) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
  return file;
}

function waitForRpc(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, rejectP) => {
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
        if (Date.now() > deadline) rejectP(new Error("hardhat node did not start in time"));
        else setTimeout(tryOnce, 150);
      });
      req.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }));
      req.end();
    };
    tryOnce();
  });
}

/** Run fn with process.env[name]=value, restoring (or deleting) it afterwards. */
async function withEnv(name, value, fn) {
  const prev = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

// A provider stub that PROVES no network is touched: every method throws a sentinel.
function throwingProvider() {
  const boom = () => {
    throw new Error("network touched — the guard must refuse BEFORE any network use");
  };
  return { getNetwork: boom, getBlockNumber: boom, send: boom, call: boom, getCode: boom };
}

// ---------------------------------------------------------------------------------------------------
// Static guardrail greps (criteria 3 + 5) — no node needed.
// ---------------------------------------------------------------------------------------------------

describe("cli: anchor-artifact — static guardrails (grep-proven)", function () {
  const SRC = fs.readFileSync(CLI_SOURCE_PATH, "utf8");
  const VH_SRC = fs.readFileSync(VH_SOURCE_PATH, "utf8");
  const TEST_SRC = fs.readFileSync(__filename, "utf8");

  it("keys come ONLY from --key-env/--key-file via the house read-used-discarded path", function () {
    // The ONE shared key loader is used; no implicit PRIVATE_KEY env fallback; the raw key material
    // is never referenced (it lives only inside the Wallet loadSigningWallet constructs).
    expect(SRC).to.include("loadSigningWallet");
    expect(SRC).to.not.match(/PRIVATE_KEY/);
    expect(SRC).to.not.match(/privateKey/);
    // Nothing is ever logged outside the io sinks (no stray console writes to leak into).
    expect(SRC).to.not.match(/console\./);
  });

  it("the EXISTING mainnet guard and the EXISTING identity probe are reused, not re-implemented", function () {
    expect(SRC).to.include('require("./anchor")');
    expect(SRC).to.include("isTestnetChainId");
    expect(SRC).to.include('require("./registry")');
    expect(SRC).to.include("assertRegistry");
    // The shipped commit-reveal building blocks (D-1) power --author-bound.
    expect(SRC).to.include('require("./claim")');
    expect(SRC).to.include("computeCommitment");
  });

  it("FREE surface: no paid gate is consulted on either verb", function () {
    // The word itself is absent from the module — no gate module required, no entitlement checked.
    expect(SRC).to.not.match(/licen[cs]e/i);
    expect(SRC).to.not.match(/entitlement/i);
    expect(SRC).to.not.match(/evidence-plans/);
  });

  it("the module opens no sockets of its own (network only via the ethers provider)", function () {
    expect(SRC).to.not.match(/require\((["'])(node:)?(http|https|net|dns|tls|dgram|child_process)\1\)/);
  });

  it("vh.js dispatches both verbs and documents them in usage()", function () {
    expect(VH_SRC).to.include('case "anchor-artifact":');
    expect(VH_SRC).to.include('case "verify-anchored":');
    expect(VH_SRC).to.include("vh anchor-artifact <sealed-file>");
    expect(VH_SRC).to.include("vh verify-anchored <receipt> <sealed-file>");
    expect(typeof vh.cmdAnchorArtifact).to.equal("function");
    expect(typeof vh.cmdVerifyAnchored).to.equal("function");
  });

  it("this test file (and the CLI module) reference NO host other than 127.0.0.1", function () {
    // Every scheme-separator occurrence in this test must be immediately followed by 127.0.0.1; the
    // CLI module contains none at all. The separator is assembled so this check cannot match itself.
    const sep = ":" + "//";
    const chunks = TEST_SRC.split(sep).slice(1);
    expect(chunks.length, "the test must actually contain its 127.0.0.1 RPC URL").to.be.greaterThan(0);
    for (const c of chunks) {
      expect(c.startsWith("127.0.0.1"), `URL host must be 127.0.0.1, saw: ${c.slice(0, 24)}`).to.equal(true);
    }
    expect(SRC.includes(sep), "the CLI module must embed no URLs").to.equal(false);
  });
});

// ---------------------------------------------------------------------------------------------------
// Offline behavior: parsers, usage errors, key-source errors, binding rejects, the mainnet guard.
// ---------------------------------------------------------------------------------------------------

describe("cli: anchor-artifact / verify-anchored — offline (no node)", function () {
  const GOOD_CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  // hardhat dev key #9 — used ONLY for offline tests that never touch a network.
  const OFFLINE_KEY = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";

  after(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  it("parseAnchorArtifactArgs: unknown flags, value-less flags, extra positionals all throw", function () {
    expect(() => aa.parseAnchorArtifactArgs(["a.json", "--bogus"])).to.throw(/unknown flag/);
    expect(() => aa.parseAnchorArtifactArgs(["a.json", "--out"])).to.throw(/--out requires a value/);
    expect(() => aa.parseAnchorArtifactArgs(["a.json", "--key-env"])).to.throw(/--key-env requires a value/);
    expect(() => aa.parseAnchorArtifactArgs(["a.json", "b.json"])).to.throw(/unexpected extra argument/);
    const opts = aa.parseAnchorArtifactArgs(["a.json", "--author-bound", "--json", "--uri", "u"]);
    expect(opts.authorBound).to.equal(true);
    expect(opts.json).to.equal(true);
    expect(opts.uri).to.equal("u");
  });

  it("parseVerifyAnchoredArgs: two positionals in order; a third throws", function () {
    const opts = aa.parseVerifyAnchoredArgs(["r.json", "a.json", "--json"]);
    expect(opts.receipt).to.equal("r.json");
    expect(opts.artifact).to.equal("a.json");
    expect(opts.json).to.equal(true);
    expect(() => aa.parseVerifyAnchoredArgs(["r.json", "a.json", "c.json"])).to.throw(/unexpected extra/);
    expect(() => aa.parseVerifyAnchoredArgs(["r.json", "--nope"])).to.throw(/unknown flag/);
  });

  it("anchor-artifact usage errors exit 2 BEFORE any file/key/network is touched", async function () {
    const { file } = evidenceFixture("usage");
    const cases = [
      // [opts, message-must-match]
      [{ contract: GOOD_CONTRACT, keyEnv: "X", rpc: "unused" }, /requires a <sealed-file>/],
      [{ artifact: file, keyEnv: "X", rpc: "unused" }, /no contract address/],
      [{ artifact: file, contract: "0xnothex", keyEnv: "X", rpc: "unused" }, /invalid contract address/],
      [{ artifact: file, contract: GOOD_CONTRACT, rpc: "unused" }, /EXACTLY ONE signing-key source/],
      [
        { artifact: file, contract: GOOD_CONTRACT, keyEnv: "A", keyFile: "b", rpc: "unused" },
        /mutually exclusive/,
      ],
      [{ artifact: file, contract: GOOD_CONTRACT, keyEnv: "X" }, /no RPC endpoint/],
    ];
    for (const [opts, re] of cases) {
      const io = capture();
      const code = await aa.runAnchorArtifact({ ...opts, ethers }, io);
      expect(code, io.err()).to.equal(2);
      expect(io.err()).to.match(re);
    }
  });

  it("key-source runtime errors exit 1, name only the SOURCE, and never echo key material", async function () {
    const { file } = evidenceFixture("keysrc");
    // (a) --key-env naming an UNSET var.
    let io = capture();
    let code = await aa.runAnchorArtifact(
      { artifact: file, contract: GOOD_CONTRACT, keyEnv: "VH_AA_DEFINITELY_UNSET", rpc: "unused", ethers },
      io
    );
    expect(code).to.equal(1);
    expect(io.err()).to.match(/VH_AA_DEFINITELY_UNSET/);
    // (b) a malformed key: the error must NOT echo the value.
    io = capture();
    code = await withEnv("VH_AA_BAD_KEY", "hello-not-a-key", () =>
      aa.runAnchorArtifact(
        { artifact: file, contract: GOOD_CONTRACT, keyEnv: "VH_AA_BAD_KEY", rpc: "unused", ethers },
        io
      )
    );
    expect(code).to.equal(1);
    expect(io.all()).to.not.include("hello-not-a-key");
  });

  it("an invalid artifact is the T-70.1 NAMED binding reject (exit 3) — before key or network", async function () {
    const dir = tmp("vh-aa-badart-");
    const file = writeJson(dir, "bad.json", { kind: "not-a-real-kind", stuff: 1 });
    const io = capture();
    // keyEnv names an UNSET var and rpc is a non-URL: neither may be touched — the reject fires first.
    const code = await aa.runAnchorArtifact(
      { artifact: file, contract: GOOD_CONTRACT, keyEnv: "VH_AA_NEVER_READ", rpc: "unused", ethers },
      io
    );
    expect(code).to.equal(3);
    expect(io.err()).to.match(/REJECTED \(unknown-kind\)/);
  });

  it("MAINNET GUARD: a mocked non-test chainId refuses without --i-understand-mainnet (no network use)", async function () {
    const { file } = evidenceFixture("guard");
    const io = capture();
    const code = await withEnv("VH_AA_GUARD_KEY", OFFLINE_KEY, () =>
      aa.runAnchorArtifact(
        {
          artifact: file,
          contract: GOOD_CONTRACT,
          keyEnv: "VH_AA_GUARD_KEY",
          rpc: "unused-because-provider-injected",
          provider: throwingProvider(), // proves the refusal happens BEFORE any network call
          chainId: 137, // Polygon MAINNET — mocked via the same short-circuit hook runAnchor exposes
          ethers,
        },
        io
      )
    );
    expect(code).to.equal(1);
    expect(io.err()).to.match(/refusing to anchor on chainId 137 \(not a known testnet\)/);
    expect(io.err()).to.match(/--i-understand-mainnet/);
    expect(io.all()).to.not.include("network touched");
  });

  it("verify-anchored usage errors exit 2 (half an on-chain flag pair is ambiguous)", async function () {
    const { file } = evidenceFixture("vusage");
    let io = capture();
    expect(await aa.runVerifyAnchored({ artifact: file, ethers }, io)).to.equal(2);
    expect(io.err()).to.match(/requires a <receipt> and a <sealed-file>/);

    io = capture();
    expect(await aa.runVerifyAnchored({ receipt: file, artifact: file, rpc: "u", ethers }, io)).to.equal(2);
    expect(io.err()).to.match(/BOTH --rpc <url> AND --contract <address>/);

    io = capture();
    expect(
      await aa.runVerifyAnchored({ receipt: file, artifact: file, contract: GOOD_CONTRACT, ethers }, io)
    ).to.equal(2);
    expect(io.err()).to.match(/BOTH --rpc <url> AND --contract <address>/);
  });

  it("verify-anchored on a malformed receipt is the named bad-receipt reject (exit 3, offline)", async function () {
    const { file } = evidenceFixture("badrcpt");
    const rfile = writeJson(tmp("vh-aa-badrcpt-"), "r.json", { kind: "not-an-anchored-receipt" });
    const io = capture();
    const code = await aa.runVerifyAnchored({ receipt: rfile, artifact: file, ethers }, io);
    expect(code).to.equal(3);
    expect(io.err()).to.match(/REJECTED \(bad-receipt\)/);
  });
});

// ---------------------------------------------------------------------------------------------------
// LIVE end to end against a spawned local hardhat node (127.0.0.1 only).
// ---------------------------------------------------------------------------------------------------

describe("cli: anchor-artifact / verify-anchored — end to end (local hardhat node)", function () {
  this.timeout(120000);

  const PORT = 18563; // distinct from every other suite's spawned-node port so they never collide
  const RPC_URL = `http://127.0.0.1:${PORT}`;
  let nodeProc;
  let provider;
  let registryAddress;

  // Dedicated pre-funded hardhat dev keys — ONE PER TEST so no cross-test nonce contention.
  const KEY_EVIDENCE = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // #1
  const KEY_AGENT = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // #2
  const KEY_JOURNAL = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"; // #3
  const KEY_TAMPER = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"; // #4
  const KEY_DOUBLE = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"; // #5
  const KEY_CMD = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"; // #6
  const ADDR_AGENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // account #2 (KEY_AGENT's address)

  before(async function () {
    nodeProc = spawn(
      "npx",
      ["hardhat", "node", "--hostname", "127.0.0.1", "--port", String(PORT)],
      { cwd: path.join(__dirname, ".."), stdio: ["ignore", "ignore", "ignore"] }
    );
    await waitForRpc(RPC_URL, 45000);
    provider = new ethers.JsonRpcProvider(RPC_URL);
    const deployer = new ethers.Wallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // hardhat dev account #0
      provider
    );
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

  async function mineBlocks(n) {
    for (let i = 0; i < n; i++) {
      await provider.send("evm_mine", []);
    }
  }

  /** anchor `file` with `key` (via --key-env semantics) and return { code, io, receiptPath }. */
  async function anchorFile(file, key, extra = {}) {
    const receiptPath = path.join(tmp("vh-aa-out-"), "anchored.json");
    const io = capture();
    const code = await withEnv("VH_AA_E2E_KEY", key, () =>
      aa.runAnchorArtifact(
        {
          artifact: file,
          contract: registryAddress,
          rpc: RPC_URL,
          keyEnv: "VH_AA_E2E_KEY",
          out: receiptPath,
          ...extra,
        },
        io
      )
    );
    return { code, io, receiptPath };
  }

  it("EVIDENCE packet: one-shot anchor -> receipt (authorBound:false) -> verify OFFLINE 0 AND --rpc 0", async function () {
    const { seal, file } = evidenceFixture("e2e-evidence");
    const { code, io, receiptPath } = await anchorFile(file, KEY_EVIDENCE, { uri: "evidence-demo" });
    expect(code, io.err()).to.equal(0);
    expect(io.out()).to.match(/ANCHORED/);

    // The receipt binds the packet's own sealed root (the T-70.1 digest), not a re-hash of the file.
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    expect(receipt.kind).to.equal("vh-anchored-receipt@1");
    expect(receipt.digest).to.equal(evidence.readSeal(seal).root.toLowerCase());
    expect(receipt.artifactKind).to.equal("vh.evidence-seal");
    expect(receipt.chain.chainId).to.equal(31337);
    expect(receipt.chain.authorBound, "one-shot records read back authorBound:false").to.equal(false);
    expect(receipt.chain.contract).to.equal(registryAddress.toLowerCase());

    // The key material never leaked into ANY output (read-used-discarded, never logged).
    expect(io.all()).to.not.include(KEY_EVIDENCE);
    expect(io.all()).to.not.include(KEY_EVIDENCE.slice(2));

    // OFFLINE verify: exit 0.
    const vio = capture();
    expect(await aa.runVerifyAnchored({ receipt: receiptPath, artifact: file }, vio)).to.equal(0);
    expect(vio.out()).to.match(/ACCEPTED \(offline binding check\)/);
    expect(vio.out()).to.match(/NOT re-check/);

    // --rpc --contract verify: exit 0, registry authenticated (the EPIC-11 probe ran).
    const rio = capture();
    expect(
      await aa.runVerifyAnchored(
        { receipt: receiptPath, artifact: file, rpc: RPC_URL, contract: registryAddress },
        rio
      )
    ).to.equal(0);
    expect(rio.out()).to.match(/registry authenticated: REGISTRY_ID ok/);
    expect(rio.out()).to.match(/ALL match the receipt/);
  });

  it("AGENT packet: --author-bound commit-reveal (delay blocks mined in-test) reads back authorBound:true", async function () {
    const { packet, file } = agentFixture("e2e-agent");
    const { code, io, receiptPath } = await anchorFile(file, KEY_AGENT, {
      authorBound: true,
      waitForBlock: async () => {
        await mineBlocks(2); // mature the MIN_REVEAL_DELAY window in-test
      },
    });
    expect(code, io.err()).to.equal(0);
    expect(io.out()).to.match(/author-bound commit-reveal/);
    expect(io.out()).to.match(/commit tx: 0x/);

    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    const expectedDigest = agent.verifyPacket(packet).head.root;
    expect(receipt.digest).to.equal(expectedDigest);
    expect(receipt.artifactKind).to.equal("vh.agent-session-packet");
    expect(receipt.chain.authorBound, "--author-bound records read back authorBound:true").to.equal(true);
    expect(receipt.chain.contributor).to.equal(ADDR_AGENT.toLowerCase());

    // The registry itself says so too (D-1 semantics surfaced from the chain, not re-implemented).
    const registry = new ethers.Contract(registryAddress, ARTIFACT.abi, provider);
    const rec = await registry.getRecord(receipt.digest);
    expect(rec.authorBound).to.equal(true);
    expect(rec.contributor).to.equal(ADDR_AGENT);

    // OFFLINE + --rpc verify both exit 0.
    const vio = capture();
    expect(await aa.runVerifyAnchored({ receipt: receiptPath, artifact: file }, vio)).to.equal(0);
    const rio = capture();
    expect(
      await aa.runVerifyAnchored(
        { receipt: receiptPath, artifact: file, rpc: RPC_URL, contract: registryAddress },
        rio
      )
    ).to.equal(0);
    expect(rio.out()).to.match(/authorBound true/);
  });

  it("JOURNAL tree-head: one-shot anchor -> verify OFFLINE 0 AND --rpc 0", async function () {
    const { artifact, file } = journalFixture("e2e-journal");
    const { code, io, receiptPath } = await anchorFile(file, KEY_JOURNAL);
    expect(code, io.err()).to.equal(0);

    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    expect(receipt.digest).to.equal(artifact.root);
    expect(receipt.artifactKind).to.equal("vh.journal-tree-head");
    expect(receipt.how).to.include(`over ${artifact.size} entries`);
    expect(receipt.chain.authorBound).to.equal(false);

    const vio = capture();
    expect(await aa.runVerifyAnchored({ receipt: receiptPath, artifact: file }, vio)).to.equal(0);
    const rio = capture();
    expect(
      await aa.runVerifyAnchored(
        { receipt: receiptPath, artifact: file, rpc: RPC_URL, contract: registryAddress },
        rio
      )
    ).to.equal(0);
  });

  it("TAMPER MATRIX: artifact byte flip / edited receipt facts / non-registry --contract — each the SPECIFIC named reject (exit 3)", async function () {
    // Anchor a fresh journal head to get a genuine receipt to tamper with.
    const { file } = journalFixture("e2e-tamper");
    const { code, receiptPath, io } = await anchorFile(file, KEY_TAMPER);
    expect(code, io.err()).to.equal(0);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    const rdir = tmp("vh-aa-tamper-");

    // (a) ONE ARTIFACT BYTE flipped -> the binding reject, offline (the artifact's own named reject).
    const tampered = JSON.parse(fs.readFileSync(file, "utf8"));
    const lastChar = tampered.root.slice(-1) === "0" ? "1" : "0";
    tampered.root = tampered.root.slice(0, -1) + lastChar;
    const tamperedFile = writeJson(rdir, "tampered-artifact.json", tampered);
    let vio = capture();
    expect(await aa.runVerifyAnchored({ receipt: receiptPath, artifact: tamperedFile }, vio)).to.equal(3);
    expect(vio.err()).to.match(/REJECTED \((journal-tree-head-invalid|digest-mismatch)\)/);

    // (a2) a DIFFERENT valid artifact of the same kind -> the named digest-mismatch.
    const other = journalFixture("e2e-tamper-other");
    vio = capture();
    expect(await aa.runVerifyAnchored({ receipt: receiptPath, artifact: other.file }, vio)).to.equal(3);
    expect(vio.err()).to.match(/REJECTED \(digest-mismatch\)/);

    // (b) receipt txHash edited -> the rpc recheck's tx-not-found (offline still ACCEPTS: form-valid).
    const txEdited = writeJson(rdir, "tx-edited.json", {
      ...receipt,
      chain: { ...receipt.chain, txHash: "0x" + "ab".repeat(32) },
    });
    vio = capture();
    expect(await aa.runVerifyAnchored({ receipt: txEdited, artifact: file }, vio)).to.equal(0); // offline can't see it
    vio = capture();
    expect(
      await aa.runVerifyAnchored(
        { receipt: txEdited, artifact: file, rpc: RPC_URL, contract: registryAddress },
        vio
      )
    ).to.equal(3);
    expect(vio.err()).to.match(/REJECTED \(tx-not-found\)/);

    // (c) receipt blockNumber edited -> the rpc recheck's block-number-mismatch.
    const blockEdited = writeJson(rdir, "block-edited.json", {
      ...receipt,
      chain: { ...receipt.chain, blockNumber: receipt.chain.blockNumber + 1 },
    });
    vio = capture();
    expect(
      await aa.runVerifyAnchored(
        { receipt: blockEdited, artifact: file, rpc: RPC_URL, contract: registryAddress },
        vio
      )
    ).to.equal(3);
    expect(vio.err()).to.match(/REJECTED \(block-number-mismatch\)/);

    // (d) receipt contributor edited -> the rpc recheck's contributor-mismatch.
    const contribEdited = writeJson(rdir, "contrib-edited.json", {
      ...receipt,
      chain: { ...receipt.chain, contributor: ADDR_AGENT.toLowerCase() }, // a real, but WRONG, address
    });
    vio = capture();
    expect(
      await aa.runVerifyAnchored(
        { receipt: contribEdited, artifact: file, rpc: RPC_URL, contract: registryAddress },
        vio
      )
    ).to.equal(3);
    expect(vio.err()).to.match(/REJECTED \(contributor-mismatch\)/);

    // (e) --contract at a NON-REGISTRY address -> the EXISTING identity-probe reject (EPIC-11).
    vio = capture();
    expect(
      await aa.runVerifyAnchored(
        { receipt: receiptPath, artifact: file, rpc: RPC_URL, contract: ADDR_AGENT }, // an EOA: no code
        vio
      )
    ).to.equal(3);
    expect(vio.err()).to.match(/REJECTED \(registry-auth-failed\)/);
    expect(vio.err()).to.match(/no contract at .* wrong address or wrong network/);
  });

  it("DOUBLE ANCHOR: the same digest anchored twice surfaces the registry's own AlreadyAnchored (exit 3, no stack trace)", async function () {
    const { file } = journalFixture("e2e-double");
    const first = await anchorFile(file, KEY_DOUBLE);
    expect(first.code, first.io.err()).to.equal(0);

    const second = await anchorFile(file, KEY_DOUBLE);
    expect(second.code).to.equal(3);
    expect(second.io.err()).to.match(/REJECTED \(registry-reject\)/);
    expect(second.io.err()).to.match(/AlreadyAnchored/);
    // A clean named error line — never a raw stack trace.
    expect(second.io.err()).to.not.match(/\n\s+at /);
  });

  it("cmd-level (--rpc/--contract/--key-env flags through the vh dispatcher): anchor --json, verify offline + --rpc --json", async function () {
    const { file } = evidenceFixture("e2e-cmd");
    const out = path.join(tmp("vh-aa-cmd-"), "cmd.vhanchored.json");
    const io = capture();
    const code = await withEnv("VH_AA_CMD_KEY", KEY_CMD, () =>
      vh.cmdAnchorArtifact(
        [
          file,
          "--contract",
          registryAddress,
          "--rpc",
          RPC_URL,
          "--key-env",
          "VH_AA_CMD_KEY",
          "--out",
          out,
          "--uri",
          "cmd-demo",
          "--json",
        ],
        io
      )
    );
    expect(code, io.err()).to.equal(0);
    const machine = JSON.parse(io.out()); // --json emits EXACTLY one machine object
    expect(machine.verdict).to.equal("ANCHORED");
    expect(machine.chain.authorBound).to.equal(false);
    expect(machine.receiptPath).to.equal(out);
    expect(fs.existsSync(out)).to.equal(true);
    expect(io.all()).to.not.include(KEY_CMD);

    // verify-anchored via the dispatcher: OFFLINE exit 0, then --rpc --contract --json exit 0.
    const v1 = capture();
    expect(await vh.cmdVerifyAnchored([out, file], v1)).to.equal(0);
    expect(v1.out()).to.match(/ACCEPTED/);

    const v2 = capture();
    expect(
      await vh.cmdVerifyAnchored(
        [out, file, "--rpc", RPC_URL, "--contract", registryAddress, "--json"],
        v2
      )
    ).to.equal(0);
    const verdict = JSON.parse(v2.out());
    expect(verdict.verdict).to.equal("ACCEPTED");
    expect(verdict.mode).to.equal("rpc");
    expect(verdict.registry && verdict.registry.chainId).to.equal(31337);
    expect(verdict.onchain && verdict.onchain.authorBound).to.equal(false);

    // A wrong artifact through the dispatcher is the shared exit-3 reject (json verdict on stdout).
    const otherFixture = evidenceFixture("e2e-cmd-other");
    const v3 = capture();
    expect(await vh.cmdVerifyAnchored([out, otherFixture.file, "--json"], v3)).to.equal(3);
    expect(JSON.parse(v3.out()).reason).to.equal("digest-mismatch");
  });
});

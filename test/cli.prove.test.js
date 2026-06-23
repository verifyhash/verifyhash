const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");

const { buildProof, runProve, ABI } = require("../cli/prove");
const { runAnchor } = require("../cli/anchor");
const { hashFile, hashDir, pathLeaf } = require("../cli/hash");

// ---------------------------------------------------------------------------
// Helpers: throwaway temp dirs + a real local hardhat JSON-RPC node, mirroring
// the integration setup used by cli.anchor.test.js / cli.verify.test.js.
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

describe("cli: vh prove (repo-level Merkle proof)", function () {
  this.timeout(60000);

  const PORT = 18547; // distinct from anchor(18545)/verify(18546) so suites never collide
  const RPC_URL = `http://127.0.0.1:${PORT}`;
  let nodeProc;
  let provider;
  let signer; // account #0: deployer only
  let registryAddress;

  // Distinct dev signers for submissions so a tx never contends on a provider-cached nonce.
  const DEV_KEYS = [
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // #1
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // #3
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // #4
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // #5
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
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // #0
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

  // Build a small multi-file "repo" so the Merkle tree has real interior nodes (proof length > 1).
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

  // -------------------------------------------------------------------------
  // buildProof (pure, no network): the proof must fold the leaf back to the root.
  // -------------------------------------------------------------------------
  describe("buildProof (pure)", function () {
    it("produces a root/leaf/proof consistent with hashDir for the named file", function () {
      const dir = makeRepo("vh-prove-pure-");
      const built = buildProof({ file: "src/index.js", rootDir: dir });

      const dh = hashDir(dir);
      expect(built.root).to.equal(dh.root);
      // The proof leaf is the PATH-BOUND digest (what verifyLeaf consumes); the bare content digest
      // is surfaced separately as contentHash.
      const content = hashFile(path.join(dir, "src/index.js"));
      expect(built.contentHash).to.equal(content);
      expect(built.leaf).to.equal(pathLeaf("src/index.js", content));
      expect(built.leaf).to.not.equal(content); // not the old content-only leaf
      // It also matches the leaf hashDir recorded for that path.
      expect(built.leaf).to.equal(dh.leafFor("src/index.js"));
      expect(built.fileCount).to.equal(5);
      // A 5-leaf tree is genuinely multi-level: this proof carries real interior siblings.
      expect(built.proof.length).to.be.greaterThan(1);
    });

    it("rejects a file that lives outside the repo root", function () {
      const dir = makeRepo("vh-prove-outside-");
      const outside = tmp("vh-prove-outside-other-");
      const f = writeFile(outside, "stray.txt", "not in the repo");
      expect(() => buildProof({ file: f, rootDir: dir })).to.throw(/not inside the repo root/i);
    });

    it("requires a --root directory", function () {
      const dir = makeRepo("vh-prove-noroot-");
      const f = path.join(dir, "README.md");
      expect(() => buildProof({ file: f })).to.throw(/repo root/i);
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end against a LIVE node: anchor the root, prove each file on-chain.
  // This is the heart of the acceptance criteria.
  // -------------------------------------------------------------------------
  describe("end-to-end on a local hardhat node", function () {
    it("anchors the repo root and the on-chain verifyLeaf accepts every file's proof", async function () {
      const dir = makeRepo("vh-prove-e2e-");
      const expectedRoot = hashDir(dir).root;
      const files = ["README.md", "src/index.js", "src/util.js", "src/lib/math.js", "docs/guide.txt"];

      // Anchor the directory's Merkle root once via the real anchor flow.
      const anchorRes = await runAnchor({
        path: dir,
        contractAddress: registryAddress,
        provider,
        signer: freshSigner(),
        log: () => {},
      });
      expect(anchorRes.anchored, "Anchored event").to.not.equal(null);
      expect(anchorRes.anchored.contentHash).to.equal(expectedRoot);

      // Sanity: the root is anchored on-chain.
      const registry = new ethers.Contract(registryAddress, ABI, provider);
      expect(await registry.isAnchored(expectedRoot)).to.equal(true);

      // Prove EACH file: the contract's verifyLeaf must accept the generated proof.
      for (const rel of files) {
        const res = await runProve({
          file: rel,
          rootDir: dir,
          contractAddress: registryAddress,
          provider,
          log: () => {},
        });
        expect(res.root, `root for ${rel}`).to.equal(expectedRoot);
        expect(res.rootIsAnchored).to.equal(true);
        expect(res.accepted, `verifyLeaf must accept ${rel}`).to.equal(true);

        // Cross-check the on-chain verdict directly (not just runProve's copy), so a bug in
        // runProve can't make this pass: call verifyLeaf ourselves with the built proof.
        const direct = await registry.verifyLeaf(res.root, res.leaf, res.proof);
        expect(direct, `direct verifyLeaf for ${rel}`).to.equal(true);
      }
    });

    it("can anchor-and-prove in one shot via anchorFirst", async function () {
      const dir = makeRepo("vh-prove-anchorfirst-");
      const expectedRoot = hashDir(dir).root;

      const res = await runProve({
        file: "src/lib/math.js",
        rootDir: dir,
        contractAddress: registryAddress,
        provider,
        signer: freshSigner(),
        anchorFirst: true,
        log: () => {},
      });

      expect(res.anchored, "anchored via anchorFirst").to.not.equal(null);
      expect(res.anchored.contentHash).to.equal(expectedRoot);
      expect(res.accepted).to.equal(true);

      const registry = new ethers.Contract(registryAddress, ABI, provider);
      expect(await registry.isAnchored(expectedRoot)).to.equal(true);
    });

    it("TAMPERING a file makes its proof fail: verifyLeaf rejects the modified file", async function () {
      const dir = makeRepo("vh-prove-tamper-");
      const targetRel = "src/index.js";
      const targetAbs = path.join(dir, targetRel);

      // Anchor the ORIGINAL repo root.
      const originalRoot = hashDir(dir).root;
      await runAnchor({
        path: dir,
        contractAddress: registryAddress,
        provider,
        signer: freshSigner(),
        log: () => {},
      });
      const registry = new ethers.Contract(registryAddress, ABI, provider);
      expect(await registry.isAnchored(originalRoot)).to.equal(true);

      // The genuine, untampered file proves fine against the anchored root.
      const ok = await runProve({
        file: targetRel,
        rootDir: dir,
        contractAddress: registryAddress,
        provider,
        log: () => {},
      });
      expect(ok.accepted, "untampered file should verify").to.equal(true);

      // Now TAMPER the file by a single byte.
      const before = fs.readFileSync(targetAbs);
      fs.writeFileSync(targetAbs, Buffer.concat([before, Buffer.from("X")]));

      // buildProof now recomputes a DIFFERENT directory root (because a leaf changed). Proving the
      // tampered file against the *anchored* (original) root must be rejected on-chain. We feed the
      // tampered file's new leaf + proof against the originally anchored root and assert false.
      const tampered = buildProof({ file: targetRel, rootDir: dir });
      expect(tampered.root, "tampering changes the directory root").to.not.equal(originalRoot);

      // Direct on-chain check: tampered leaf + its proof, against the ANCHORED original root -> false.
      const acceptedAgainstAnchored = await registry.verifyLeaf(
        originalRoot,
        tampered.leaf,
        tampered.proof
      );
      expect(acceptedAgainstAnchored, "verifyLeaf must reject the tampered file").to.equal(false);

      // And runProve against the still-anchored original root must report not-accepted. Because the
      // tampered directory now has a *new* root that was never anchored, runProve refuses up front
      // (nothing to prove against), which is the correct tamper-evident behavior.
      let proveErr = null;
      let proveRes = null;
      try {
        proveRes = await runProve({
          file: targetRel,
          rootDir: dir,
          contractAddress: registryAddress,
          provider,
          log: () => {},
        });
      } catch (e) {
        proveErr = e;
      }
      // Either it throws "root not anchored", or (if anchored) returns accepted=false — never a
      // silent success.
      if (proveErr) {
        expect(proveErr.message).to.match(/not anchored/i);
      } else {
        expect(proveRes.accepted).to.equal(false);
      }

      // Restore so cleanup/other refs aren't surprised (not strictly required; temp dir is removed).
      fs.writeFileSync(targetAbs, before);
    });

    it("refuses to prove against a root that was never anchored", async function () {
      const dir = makeRepo("vh-prove-unanchored-");
      // Deliberately do NOT anchor this repo's root.
      let err = null;
      try {
        await runProve({
          file: "README.md",
          rootDir: dir,
          contractAddress: registryAddress,
          provider,
          log: () => {},
        });
      } catch (e) {
        err = e;
      }
      expect(err, "should refuse: nothing anchored to prove against").to.not.equal(null);
      expect(err.message).to.match(/not anchored/i);
    });
  });

  // -------------------------------------------------------------------------
  // --dry-run: builds & prints the proof with NO key and NO network.
  // -------------------------------------------------------------------------
  describe("--dry-run (no key, no network)", function () {
    it("prints the root/leaf/proof and contacts no chain", async function () {
      const dir = makeRepo("vh-prove-dry-");
      const built = buildProof({ file: "src/util.js", rootDir: dir });

      let out = "";
      const res = await runProve({
        file: "src/util.js",
        rootDir: dir,
        dryRun: true,
        // No contractAddress, no provider, no signer: dry run must need none of them.
        log: (s) => (out += s),
      });

      expect(res.dryRun).to.equal(true);
      expect(res.root).to.equal(built.root);
      expect(res.leaf).to.equal(built.leaf);
      expect(res.proof).to.deep.equal(built.proof);
      expect(out).to.contain(built.root);
      expect(out).to.contain(built.leaf);
      for (const h of built.proof) expect(out).to.contain(h);
    });
  });
});

// ---------------------------------------------------------------------------
// CLI surface (cli/vh.js): arg parsing + that `--dry-run` works through the real
// command with NO key and NO RPC configured. No node needed here.
// ---------------------------------------------------------------------------
describe("cli surface: vh prove (cli/vh.js)", function () {
  const { parseProveArgs, cmdProve } = require("../cli/vh");

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

  describe("parseProveArgs", function () {
    it("parses file, --root, --contract, --anchor, --dry-run, --i-understand-mainnet", function () {
      const o = parseProveArgs([
        "src/index.js",
        "--root",
        "./repo",
        "--contract",
        "0xabc",
        "--anchor",
        "--dry-run",
        "--i-understand-mainnet",
      ]);
      expect(o.file).to.equal("src/index.js");
      expect(o.root).to.equal("./repo");
      expect(o.contract).to.equal("0xabc");
      expect(o.anchor).to.equal(true);
      expect(o.dryRun).to.equal(true);
      expect(o.iUnderstandMainnet).to.equal(true);
    });

    it("defaults: anchor=false, dryRun=false, root undefined", function () {
      const o = parseProveArgs(["f"]);
      expect(o.anchor).to.equal(false);
      expect(o.dryRun).to.equal(false);
      expect(o.root).to.equal(undefined);
    });

    it("rejects an unknown flag (a typo must not silently change behavior)", function () {
      expect(() => parseProveArgs(["f", "--prov"])).to.throw(/unknown flag/i);
    });

    it("rejects --root with no value", function () {
      expect(() => parseProveArgs(["f", "--root"])).to.throw(/--root requires a value/);
    });
  });

  describe("cmdProve", function () {
    // Guarantee the environment carries no key/RPC for these paths.
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

    it("--dry-run returns 0 and prints the proof with no key/RPC present", async function () {
      const dir = cliTmp("vh-cli-prove-dry-");
      fs.writeFileSync(path.join(dir, "a.txt"), "alpha");
      fs.writeFileSync(path.join(dir, "b.txt"), "beta");
      const leaf = hashFile(path.join(dir, "a.txt"));

      const writes = [];
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = (s) => {
        writes.push(s);
        return true;
      };
      let code;
      try {
        code = await cmdProve(["a.txt", "--root", dir, "--dry-run"]);
      } finally {
        process.stdout.write = orig;
      }

      expect(code).to.equal(0);
      const out = writes.join("");
      expect(out).to.contain(leaf); // the real file leaf appears in the preview
    });

    it("requires --root and exits 2 without it", async function () {
      const errs = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = (s) => {
        errs.push(s);
        return true;
      };
      let code;
      try {
        code = await cmdProve(["somefile.txt"]);
      } finally {
        process.stderr.write = orig;
      }
      expect(code).to.equal(2);
      expect(errs.join("")).to.match(/--root/);
    });

    it("a real (non-dry) prove with no RPC configured fails cleanly with exit code 1", async function () {
      const dir = cliTmp("vh-cli-prove-norpc-");
      fs.writeFileSync(path.join(dir, "a.txt"), "alpha");

      const errs = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = (s) => {
        errs.push(s);
        return true;
      };
      let code;
      try {
        code = await cmdProve([
          "a.txt",
          "--root",
          dir,
          "--contract",
          "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        ]);
      } finally {
        process.stderr.write = orig;
      }
      expect(code).to.equal(1);
      expect(errs.join("")).to.match(/RPC/i);
    });
  });
});

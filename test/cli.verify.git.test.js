const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const http = require("http");

const { runVerify, STATUS } = require("../cli/verify");
const { runAnchor } = require("../cli/anchor");
const { hashGit } = require("../cli/hash");
const { readReceipt } = require("../cli/receipt");
const git = require("../cli/git");

// --------------------------------------------------------------------------------------------------
// T-8.2: git provenance carried into anchor/claim receipts + `vh verify --git`.
//
// This drives the WHOLE flow against a live local hardhat JSON-RPC node (the same pattern as
// cli.verify.test.js / cli.anchor.test.js): anchor a temp repo's `--git` root, then from a SECOND
// fresh checkout of the same commit `vh verify --git` reports MATCH (reproducibility end-to-end). A
// one-file edit flips it to MISMATCH and `--receipt` names exactly that file; untracked junk in the
// work tree never affects the verdict. The receipt round-trips the new `git` block.
// --------------------------------------------------------------------------------------------------

// Throwaway git repos, isolated from the host's global git config (deterministic on any machine/CI).
const GIT_ID = [
  "-c", "user.name=verifyhash-test",
  "-c", "user.email=test@verifyhash.invalid",
  "-c", "commit.gpgsign=false",
  "-c", "init.defaultBranch=main",
];
function runGit(cwd, args) {
  return execFileSync("git", [...GIT_ID, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

let tmpDirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
function writeFile(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// A git repo with `files` committed. realpath'd so /tmp -> /private/tmp symlinks (macOS) don't break
// path comparisons against git rev-parse --show-toplevel.
function makeRepo(prefix, files) {
  const dir = fs.realpathSync(tmp(prefix));
  runGit(dir, ["init", "-q"]);
  for (const [rel, content] of Object.entries(files)) writeFile(dir, rel, content);
  runGit(dir, ["add", "-A"]);
  runGit(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

// The tracked fileset. Each call STAMPS the content uniquely so two repos hash to DIFFERENT roots —
// the contract reverts `AlreadyAnchored` if two tests tried to anchor the identical root, so every
// test anchors its own distinct snapshot. The set of PATHS is constant (used to assert manifests).
function knownFiles() {
  const stamp = Date.now() + "-" + Math.random();
  return {
    "README.md": `# project ${stamp}\n`,
    "src/index.js": `module.exports = 42; // ${stamp}\n`,
    "src/util/helper.js": `exports.h = () => 1; // ${stamp}\n`,
    "package.json": `{"name":"x","stamp":"${stamp}"}\n`,
  };
}
const KNOWN_PATHS = ["README.md", "package.json", "src/index.js", "src/util/helper.js"];

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

describe("cli: vh verify --git (git provenance end-to-end)", function () {
  this.timeout(60000);

  const PORT = 18548; // distinct from the other suites' ports so they never collide
  const RPC_URL = `http://127.0.0.1:${PORT}`;
  let nodeProc;
  let provider;
  let registryAddress;

  // Distinct pre-funded hardhat dev signers (accounts #1..#12) so anchoring txs never contend on a
  // shared, provider-cached nonce. Account #0 is the deployer in `before`.
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

  // A receipt destination OUTSIDE any repo we anchor/verify. Writing it INTO the repo would make the
  // receipt file itself a tracked/untracked artifact — keep it apart.
  function receiptOutside(label) {
    return path.join(tmp(`vh-verify-git-receipt-${label}-`), "anchor.vhclaim.json");
  }

  before(async function () {
    nodeProc = spawn(
      "npx",
      ["hardhat", "node", "--hostname", "127.0.0.1", "--port", String(PORT)],
      { cwd: path.join(__dirname, ".."), stdio: ["ignore", "ignore", "ignore"] }
    );
    await waitForRpc(RPC_URL, 45000);

    provider = new ethers.JsonRpcProvider(RPC_URL);
    const deployer = new ethers.Wallet(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // hardhat #0
      provider
    );
    const Factory = await ethers.getContractFactory("ContributionRegistry", deployer);
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
  // THE reproducibility criterion: anchor repo A's --git root; a SECOND fresh
  // checkout of the same commit verifies --git as MATCH; the git block round-
  // trips through the receipt; and old (no-git-block) receipts still read.
  // -------------------------------------------------------------------------
  it("anchor --git records a git block; a fresh checkout of the same commit verifies --git as MATCH", async function () {
    const repo = makeRepo("vh-vg-anchor-", knownFiles());
    const receiptPath = receiptOutside("anchor");
    const anchorer = freshSigner();

    // Untracked junk in the SOURCE work tree must not affect the anchored root.
    writeFile(repo, "node_modules/dep/index.js", "junk");
    writeFile(repo, ".env", "SECRET=1");

    const commit = git.resolveCommit(repo, "HEAD");
    const expected = hashGit(repo, {});

    // 1) Anchor EXACTLY the git-tracked set, recording a git provenance block + manifest in a receipt.
    const res = await runAnchor({
      path: repo,
      git: true,
      contractAddress: registryAddress,
      receiptPath,
      provider,
      signer: anchorer,
      log: () => {},
    });
    expect(res.anchored, "git root should anchor").to.not.equal(null);
    expect(res.tx.kind).to.equal("dir");
    // The anchored root is the git-tracked root (untracked junk ignored), not the filesystem walk.
    expect(res.tx.contentHash).to.equal(expected.root);
    expect(res.tx.git).to.deep.equal({ commit, scope: "." });

    // The receipt on disk carries the new `git` block (commit + scope) and the per-file manifest of
    // the TRACKED set (no node_modules/.env), at schemaVersion >= 3.
    const receipt = readReceipt(receiptPath);
    expect(receipt.schemaVersion).to.be.at.least(3);
    expect(receipt.git).to.deep.equal({ commit, scope: "." });
    const recordedPaths = receipt.manifest.map((m) => m.path).sort();
    expect(recordedPaths).to.deep.equal(KNOWN_PATHS.slice().sort());
    expect(recordedPaths).to.not.include("node_modules/dep/index.js");
    expect(recordedPaths).to.not.include(".env");

    // 2) Reproducibility: a SECOND fresh `git clone` of the same commit must verify --git as MATCH,
    //    proving the verdict is content-addressed to the tracked set, not to the original machine.
    const fresh = fs.realpathSync(tmp("vh-vg-fresh-"));
    runGit(fresh, ["clone", "-q", repo, "."]);
    expect(git.resolveCommit(fresh, "HEAD")).to.equal(commit);

    let out = "";
    const verifyRes = await runVerify({
      path: fresh,
      git: true,
      contractAddress: registryAddress,
      provider,
      log: (s) => (out += s),
    });
    expect(verifyRes.status).to.equal(STATUS.MATCH);
    expect(verifyRes.contentHash).to.equal(expected.root);
    // The verify result surfaces the same commit oid (untrusted provenance hint) — and says so.
    expect(verifyRes.git).to.deep.equal({ commit, scope: "." });
    expect(out).to.match(/MATCH/);
    expect(out).to.match(/git commit/i);
    expect(out).to.contain(commit);
    expect(out).to.match(/untrusted/i);
  });

  it("editing a tracked file flips --git to MISMATCH and --receipt names exactly that file", async function () {
    const repo = makeRepo("vh-vg-edit-", knownFiles());
    const receiptPath = receiptOutside("edit");
    const anchorer = freshSigner();

    await runAnchor({
      path: repo,
      git: true,
      contractAddress: registryAddress,
      receiptPath,
      provider,
      signer: anchorer,
      log: () => {},
    });

    // Sanity: a clean fresh checkout verifies --git --receipt as MATCH with an identical manifest.
    const fresh = fs.realpathSync(tmp("vh-vg-edit-fresh-"));
    runGit(fresh, ["clone", "-q", repo, "."]);
    let matchOut = "";
    const matchRes = await runVerify({
      path: fresh,
      git: true,
      contractAddress: registryAddress,
      receiptPath,
      provider,
      log: (s) => (matchOut += s),
    });
    expect(matchRes.status).to.equal(STATUS.MATCH);
    expect(matchRes.manifestDiff.identical).to.equal(true);
    expect(matchOut).to.match(/IDENTICAL/);

    // Edit exactly ONE tracked file in the fresh checkout's work tree (no new commit). The --git
    // enumeration reads the tracked set's bytes from the work tree, so the root changes.
    fs.writeFileSync(path.join(fresh, "src/index.js"), "module.exports = 999; // tampered\n");
    expect(hashGit(fresh, {}).root).to.not.equal(matchRes.contentHash);

    let out = "";
    const res = await runVerify({
      path: fresh,
      git: true,
      contractAddress: registryAddress,
      receiptPath,
      provider,
      log: (s) => (out += s),
    });
    // Authoritative verdict: the recomputed root is no longer the anchored one -> MISMATCH.
    expect(res.status).to.equal(STATUS.MISMATCH);
    // Localized over the TRACKED set: exactly src/index.js is CHANGED; nothing added/removed.
    const d = res.manifestDiff;
    expect(d.changed.map((c) => c.path)).to.deep.equal(["src/index.js"]);
    expect(d.added).to.be.empty;
    expect(d.removed).to.be.empty;
    expect(d.changed[0].oldContentHash).to.not.equal(d.changed[0].newContentHash);
    expect(out).to.match(/MISMATCH/);
    expect(out).to.match(/CHANGED {2}src\/index\.js/);
  });

  it("untracked junk in the work tree never affects the --git verdict", async function () {
    const repo = makeRepo("vh-vg-junk-", knownFiles());
    const receiptPath = receiptOutside("junk");
    const anchorer = freshSigner();

    await runAnchor({
      path: repo,
      git: true,
      contractAddress: registryAddress,
      receiptPath,
      provider,
      signer: anchorer,
      log: () => {},
    });

    // Fresh checkout, then drop a pile of untracked junk into the work tree AFTER cloning.
    const fresh = fs.realpathSync(tmp("vh-vg-junk-fresh-"));
    runGit(fresh, ["clone", "-q", repo, "."]);
    writeFile(fresh, "node_modules/big/dep.js", "a dependency we don't track");
    writeFile(fresh, ".env", "PRIVATE_KEY=0xdeadbeef");
    writeFile(fresh, "scratch-unstaged.txt", "work in progress, never added");
    writeFile(fresh, "build/output.bin", "artifact");

    let out = "";
    const res = await runVerify({
      path: fresh,
      git: true,
      contractAddress: registryAddress,
      receiptPath,
      provider,
      log: (s) => (out += s),
    });
    // The untracked junk is ignored: still MATCH, and the manifest diff is IDENTICAL (the junk is
    // neither ADDED nor CHANGED nor REMOVED, because --git never enumerated it).
    expect(res.status).to.equal(STATUS.MATCH);
    expect(res.manifestDiff.identical).to.equal(true);
    expect(res.manifestDiff.added).to.be.empty;
    expect(out).to.match(/MATCH/);
  });

  it("verify WITHOUT --git is exactly today's behaviour: a plain (non-git) dir still MATCHes its filesystem-walk anchor", async function () {
    // No regression: a plain (non-git) verify still walks the FILESYSTEM. Anchor a directory that is
    // NOT a git repo (no .git internals to sweep in) without --git, then verify it without --git: it
    // recomputes the identical filesystem-walk root and MATCHes, with NO provenance block. This pins
    // that the default verify path is untouched by T-8.2.
    const plainDir = tmp("vh-vg-plain-");
    const files = knownFiles();
    for (const [rel, content] of Object.entries(files)) writeFile(plainDir, rel, content);

    const anchorRes = await runAnchor({
      path: plainDir,
      contractAddress: registryAddress,
      provider,
      signer: freshSigner(),
      log: () => {},
    });
    const plainRoot = anchorRes.tx.contentHash;
    expect(anchorRes.tx.git, "no git block without --git").to.equal(null);

    let out = "";
    const cleanRes = await runVerify({
      path: plainDir,
      contractAddress: registryAddress,
      provider,
      log: (s) => (out += s),
    });
    expect(cleanRes.status).to.equal(STATUS.MATCH);
    expect(cleanRes.contentHash).to.equal(plainRoot);
    expect(cleanRes.git).to.equal(null); // no provenance block without --git
    expect(out).to.not.match(/git commit/i); // and no provenance line in the output

    // Editing a file flips the plain verify to MISMATCH (the today's-behaviour tamper check).
    fs.writeFileSync(path.join(plainDir, "README.md"), "# tampered\n");
    const tamper = await runVerify({
      path: plainDir,
      contractAddress: registryAddress,
      provider,
      log: () => {},
    });
    expect(tamper.status).to.equal(STATUS.MISMATCH);
    expect(tamper.contentHash).to.not.equal(plainRoot);
  });

  it("--git changes the enumeration only when passed: a git repo's plain verify sweeps in .git/junk, --git ignores it", async function () {
    // Inside a git repo, a PLAIN verify walks the filesystem and sweeps in the .git/ internals (and
    // any untracked junk), so its root differs from the git-tracked root that was anchored -> MISMATCH.
    // The same repo verified WITH --git ignores all of that and MATCHes. This is the whole point of
    // the flag, and proves it is the enumeration — not some content change — that differs.
    const repo = makeRepo("vh-vg-noflag-", knownFiles());
    const anchorRes = await runAnchor({
      path: repo,
      git: true,
      contractAddress: registryAddress,
      provider,
      signer: freshSigner(),
      log: () => {},
    });
    const gitRoot = anchorRes.tx.contentHash;

    // Drop extra untracked junk on top of the always-present .git/ directory.
    writeFile(repo, "untracked-junk.txt", "swept in by the plain walk");

    // Plain verify: filesystem walk (incl. .git/ + junk) -> different root -> MISMATCH.
    const plainRes = await runVerify({
      path: repo,
      contractAddress: registryAddress,
      provider,
      log: () => {},
    });
    expect(plainRes.status).to.equal(STATUS.MISMATCH);
    expect(plainRes.contentHash).to.not.equal(gitRoot);
    expect(plainRes.git).to.equal(null);

    // --git verify: tracked set only -> the anchored root -> MATCH.
    const gitRes = await runVerify({
      path: repo,
      git: true,
      contractAddress: registryAddress,
      provider,
      log: () => {},
    });
    expect(gitRes.status).to.equal(STATUS.MATCH);
    expect(gitRes.contentHash).to.equal(gitRoot);
  });

  it("--ref verifies the tracked set AT THAT COMMIT, independent of later commits", async function () {
    const repo = makeRepo("vh-vg-ref-", knownFiles());
    const firstCommit = git.resolveCommit(repo, "HEAD");
    const anchorer = freshSigner();

    // Anchor the tracked set at the FIRST commit.
    const anchorRes = await runAnchor({
      path: repo,
      git: true,
      ref: firstCommit,
      contractAddress: registryAddress,
      provider,
      signer: anchorer,
      log: () => {},
    });
    expect(anchorRes.tx.git.commit).to.equal(firstCommit);

    // Add a new tracked file in a SECOND commit; HEAD's tracked set now differs.
    writeFile(repo, "NEW.md", "added later\n");
    runGit(repo, ["add", "-A"]);
    runGit(repo, ["commit", "-q", "-m", "add NEW.md"]);

    // Verify at HEAD --git: the new file is in the tree, so the root differs -> MISMATCH.
    const headRes = await runVerify({
      path: repo,
      git: true,
      contractAddress: registryAddress,
      provider,
      log: () => {},
    });
    expect(headRes.status).to.equal(STATUS.MISMATCH);

    // Verify at the FIRST commit --ref reproduces the anchored root -> MATCH, even though NEW.md now
    // sits in the work tree (it isn't in that commit's tree).
    let out = "";
    const refRes = await runVerify({
      path: repo,
      git: true,
      ref: firstCommit,
      contractAddress: registryAddress,
      provider,
      log: (s) => (out += s),
    });
    expect(refRes.status).to.equal(STATUS.MATCH);
    expect(refRes.contentHash).to.equal(anchorRes.tx.contentHash);
    expect(refRes.git.commit).to.equal(firstCommit);
    expect(out).to.contain(firstCommit);
  });

  it("a legacy receipt with NO git block still reads and still localizes (back-compat)", async function () {
    // Anchor a git root and write a receipt, then strip its git block to simulate a pre-T-8.2 (v2)
    // artifact, and confirm `vh verify --git --receipt` still reads it and localizes a tamper.
    const repo = makeRepo("vh-vg-legacy-", knownFiles());
    const receiptPath = receiptOutside("legacy");
    const anchorer = freshSigner();

    await runAnchor({
      path: repo,
      git: true,
      contractAddress: registryAddress,
      receiptPath,
      provider,
      signer: anchorer,
      log: () => {},
    });

    // Downgrade the on-disk receipt to a genuine v2 (manifest, but no git block).
    const raw = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    expect(raw.git, "the fresh receipt has a git block").to.be.an("object");
    delete raw.git;
    raw.schemaVersion = 2;
    fs.writeFileSync(receiptPath, JSON.stringify(raw, null, 2) + "\n");

    // The reader still accepts it (back-compat), and a fresh checkout still verifies MATCH with an
    // identical manifest diff.
    const legacy = readReceipt(receiptPath);
    expect(legacy.schemaVersion).to.equal(2);
    expect(legacy).to.not.have.property("git");

    const fresh = fs.realpathSync(tmp("vh-vg-legacy-fresh-"));
    runGit(fresh, ["clone", "-q", repo, "."]);
    const res = await runVerify({
      path: fresh,
      git: true,
      contractAddress: registryAddress,
      receiptPath,
      provider,
      log: () => {},
    });
    expect(res.status).to.equal(STATUS.MATCH);
    expect(res.manifestDiff.identical).to.equal(true);

    // And a tamper is still localized over the tracked set even with the legacy (git-less) receipt.
    fs.writeFileSync(path.join(fresh, "package.json"), '{"name":"x","tampered":true}\n');
    const tamper = await runVerify({
      path: fresh,
      git: true,
      contractAddress: registryAddress,
      receiptPath,
      provider,
      log: () => {},
    });
    expect(tamper.status).to.equal(STATUS.MISMATCH);
    expect(tamper.manifestDiff.changed.map((c) => c.path)).to.deep.equal(["package.json"]);
  });
});

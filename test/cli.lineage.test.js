const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { spawn } = require("child_process");
const http = require("http");

const {
  runLineage,
  walkLineage,
  normalizeMaxDepth,
  jsonLineage,
  STATUS,
  RECORD_CAVEAT,
  LINEAGE_CAVEAT,
  DEFAULT_MAX_DEPTH,
} = require("../cli/lineage");
const { runShow, STATUS: SHOW_STATUS } = require("../cli/show");
const { runAnchor, buildAnchorTx } = require("../cli/anchor");
const { runClaim, formatDryRun: formatClaimDryRun } = require("../cli/claim");
const {
  ATTRIBUTION_PROVEN,
  ATTRIBUTION_ANCHOR_ONLY,
} = require("../cli/show");
const { parseLineageArgs } = require("../cli/vh");

// ---------------------------------------------------------------------------
// Helpers: a real local hardhat JSON-RPC node, mirroring cli.show.test.js.
// `vh lineage` needs no local files — it is a pure hash -> record -> parent walk —
// so like the show suite this one never touches the filesystem.
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

describe("cli: vh lineage", function () {
  this.timeout(60000);

  const PORT = 18550; // distinct from the anchor/verify/show/etc. suites
  const RPC_URL = `http://127.0.0.1:${PORT}`;
  let nodeProc;
  let provider;
  let deployer; // account #0 — single writer for all setup txs
  let registryAddress;
  let registry; // bound to the deployer for writing in tests

  // Distinct pre-funded hardhat dev signers, used where a test needs a record whose contributor is a
  // known, deployer-distinct address (so an attribution assertion is meaningful). Each returns a fresh
  // wallet; writes through them are still serialized (await wait) so a cached nonce never contends.
  const DEV_KEYS = [
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // #1
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // #3
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // #4
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // #5
    "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // #6
  ];
  let keyIdx = 0;
  function freshSigner() {
    const k = DEV_KEYS[keyIdx++ % DEV_KEYS.length];
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

  // Anchor a known hash via a one-shot anchor() (a lineage ROOT) and return { hash, contributor }. The
  // signer is wrapped in a NonceManager so repeated anchors across the suite never contend on a nonce.
  async function anchorRoot(uri) {
    const hash = ethers.hexlify(ethers.randomBytes(32));
    const signer = new ethers.NonceManager(freshSigner());
    const r = registry.connect(signer);
    await (await r.anchor(hash, uri || "")).wait();
    return { hash: hash.toLowerCase(), contributor: await signer.getAddress() };
  }

  // Anchor a known hash AS a revision of `parent` via anchorWithParent() and return its record.
  async function anchorChild(parentHash, uri) {
    const hash = ethers.hexlify(ethers.randomBytes(32));
    const signer = new ethers.NonceManager(freshSigner());
    const r = registry.connect(signer);
    await (await r.anchorWithParent(hash, uri || "", parentHash)).wait();
    return { hash: hash.toLowerCase(), contributor: await signer.getAddress() };
  }

  // Mine n empty blocks so a reveal window can pass (commit-reveal helper below).
  async function mineBlocks(n) {
    for (let i = 0; i < n; i++) await provider.send("evm_mine", []);
  }

  // Full commit -> reveal AS a revision of `parent` (revealWithParent) so the child record has
  // authorBound = true (a proven first claimant). Returns { hash, contributor }.
  async function claimChild(parentHash, uri) {
    const hash = ethers.hexlify(ethers.randomBytes(32));
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const signer = new ethers.NonceManager(freshSigner());
    const claimant = await signer.getAddress();
    const r = registry.connect(signer);
    const commitment = await r.commitmentOf(hash, claimant, salt);
    await (await r.commit(commitment)).wait();
    await mineBlocks(2); // window: block.number > commitBlock + MIN_REVEAL_DELAY
    await (await r.revealWithParent(hash, salt, uri || "", parentHash)).wait();
    return { hash: hash.toLowerCase(), contributor: claimant };
  }

  // -------------------------------------------------------------------------
  // WRITE-side coverage: `vh anchor --parent <root>` routes to anchorWithParent and actually links.
  // Drives the REAL runAnchor (not the contract directly) so the CLI write path is exercised too.
  // -------------------------------------------------------------------------
  it("`vh anchor --parent <root>` (runAnchor) anchors a child linked to the root", async function () {
    const root = await anchorRoot("ipfs://root");

    // The child content is a throwaway file-less hash: build it through the real runAnchor with a
    // signer, asserting the Linked(child, parent) edge comes back. We anchor a small temp file so
    // contentHashForPath has something to hash; the hash value is incidental to the lineage assertion.
    const os = require("os");
    const fs = require("fs");
    const path = require("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-lineage-write-"));
    const file = path.join(dir, "v2.txt");
    fs.writeFileSync(file, "version two\n");
    try {
      const signer = new ethers.NonceManager(freshSigner());
      const res = await runAnchor({
        path: file,
        parent: root.hash,
        contractAddress: registryAddress,
        provider,
        signer,
        chainId: 31337n,
        log: () => {},
      });
      expect(res.tx.functionName).to.equal("anchorWithParent");
      expect(res.tx.parent).to.equal(root.hash);
      expect(res.linked).to.not.equal(null);
      expect(res.linked.parent.toLowerCase()).to.equal(root.hash);
      // The child's lineage now reads back [child, root] in order.
      let out = "";
      const walk = await runLineage({
        contentHash: res.tx.contentHash,
        contractAddress: registryAddress,
        provider,
        log: (s) => (out += s),
      });
      expect(walk.status).to.equal(STATUS.WALKED);
      expect(walk.ancestors.map((a) => a.contentHash)).to.deep.equal([
        res.tx.contentHash.toLowerCase(),
        root.hash,
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`--dry-run` prints the parent it would link (no key, no network)", async function () {
    // buildAnchorTx is what --dry-run renders from; assert it routes to anchorWithParent and carries
    // the parent. (formatDryRun output is covered by the anchor suite; here we pin the lineage edge.)
    const os = require("os");
    const fs = require("fs");
    const path = require("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-lineage-dry-"));
    const file = path.join(dir, "x.txt");
    fs.writeFileSync(file, "x\n");
    const parent = unanchoredHash().toLowerCase();
    try {
      const tx = buildAnchorTx({ path: file, parent, contractAddress: registryAddress });
      expect(tx.functionName).to.equal("anchorWithParent");
      expect(tx.parent).to.equal(parent);
      const { formatDryRun } = require("../cli/anchor");
      expect(formatDryRun(tx, 31337n)).to.contain(parent);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`vh claim --parent <hash> --dry-run` prints the parent edge it would link (no key, no network)", async function () {
    // Regression guard for the claim-side dry-run: the printed commit-reveal plan must SHOW the lineage
    // edge a `--parent` records, exactly like `vh anchor --dry-run` does. Previously formatDryRun(commitTx)
    // never rendered the parent, so a user previewing `vh claim --parent` got a plan that silently omitted
    // the edge. This drives the REAL runClaim dry-run path (no signer, no provider) and asserts the parent
    // appears in the output; it also confirms the reveal leg routes to revealWithParent().
    const os = require("os");
    const fs = require("fs");
    const path = require("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-claim-dry-"));
    const file = path.join(dir, "c.txt");
    fs.writeFileSync(file, "claim child\n");
    // A non-zero 32-byte hash (need not be anchored — dry-run never touches the network).
    const parent = ("0x" + "ab".repeat(32)).toLowerCase();
    // A salt + committer so the (sender-bound) commitment is deterministic for the plan; no key needed.
    const salt = ("0x" + "cd".repeat(32)).toLowerCase();
    const committer = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // hardhat #1
    try {
      let out = "";
      const res = await runClaim({
        path: file,
        parent,
        salt,
        committer,
        contractAddress: registryAddress,
        dryRun: true,
        // No signer, no provider — a dry-run must work entirely offline.
        log: (s) => (out += s),
      });
      // The reveal leg is the one that carries the edge: it must route to revealWithParent.
      expect(res.dryRun).to.equal(true);
      expect(res.revealTx.functionName).to.equal("revealWithParent");
      expect(res.revealTx.parent).to.equal(parent);
      // The PRINTED plan must contain the parent hash (this is exactly the criterion that regressed) and
      // name the revealWithParent route, so the previewed plan never silently drops the lineage edge.
      expect(out).to.match(/DRY RUN/);
      expect(out).to.contain(parent);
      expect(out).to.contain("revealWithParent");

      // Without --parent the plan is byte-for-byte the legacy no-parent rendering: the legacy
      // reveal(contentHash, salt, uri) line is present, the parent line reads "lineage root", and no
      // stray parent hash leaks in. This pins that the parent path is purely additive (no regression).
      let outRoot = "";
      const resRoot = await runClaim({
        path: file,
        salt,
        committer,
        contractAddress: registryAddress,
        dryRun: true,
        log: (s) => (outRoot += s),
      });
      expect(resRoot.revealTx.functionName).to.equal("reveal");
      expect(outRoot).to.contain("reveal(contentHash, salt, uri) is sent");
      expect(outRoot).to.contain("(none) — lineage root");
      expect(outRoot).to.not.contain("revealWithParent");

      // Unit-level: formatDryRun renders the parent only when handed a parented revealTx, and degrades
      // to the no-parent rendering when the revealTx is omitted entirely (older-caller safety).
      expect(formatClaimDryRun(res.commitTx, res.revealTx)).to.contain(parent);
      expect(formatClaimDryRun(res.commitTx)).to.contain("(none) — lineage root");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // WRITE-side parser parity (the regressed criterion): a malformed `--parent` on a REAL (non-dry-run)
  // `vh claim` submission must hard-error BEFORE any network call — it must NOT broadcast commit(), wait
  // out MIN_REVEAL_DELAY, and only then reject the parent at the reveal step. We prove "no network call"
  // with TWO independent, airtight signals against a LIVE node:
  //   1. a signer tripwire: the wallet is wrapped so any `sendTransaction` flips a flag — if commit() had
  //      been broadcast, the flag would be true;
  //   2. the on-chain nonce (transaction count) of the signer is UNCHANGED across the failed call — a
  //      broadcast commit() would have incremented it.
  // Parity is asserted directly: the same malformed value fails `vh anchor` (via buildAnchorTx, which
  // already validated up front) with the same `invalid --parent` message.
  // -------------------------------------------------------------------------
  it("`vh claim --parent <malformed>` (REAL submission) hard-errors BEFORE broadcasting commit() — parser parity with anchor", async function () {
    const os = require("os");
    const fs = require("fs");
    const path = require("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-claim-badparent-"));
    const file = path.join(dir, "v2.txt");
    fs.writeFileSync(file, "version two\n");

    // Malformed parent values that a typo would produce. None is a valid 32-byte 0x hash, so each must
    // be rejected up front. (The empty string / zero hash are the legitimate "no parent" sentinels and
    // are deliberately NOT in this list — those mean "lineage root", not "malformed".)
    const BAD_PARENTS = [
      "0x1234", // too short
      "0x" + "ab".repeat(33), // too long (33 bytes)
      "0x" + "zz".repeat(32), // right length, non-hex
      "deadbeef".repeat(8), // 64 hex chars but missing the 0x prefix
      "not-a-hash",
    ];

    try {
      for (const bad of BAD_PARENTS) {
        // A fresh, real signer on the LIVE node. We wrap it so any broadcast trips the flag, while every
        // other method (getAddress, provider access, MIN_REVEAL_DELAY reads, etc.) passes straight
        // through to the genuine wallet — so this proves ONLY that no tx was sent, nothing more.
        const realSigner = freshSigner();
        const signerAddr = await realSigner.getAddress();
        const nonceBefore = await provider.getTransactionCount(signerAddr);
        let broadcastAttempted = false;
        const trippableSigner = new Proxy(realSigner, {
          get(target, prop, receiver) {
            if (prop === "sendTransaction") {
              return (...txArgs) => {
                broadcastAttempted = true;
                return target.sendTransaction(...txArgs);
              };
            }
            const v = Reflect.get(target, prop, receiver);
            return typeof v === "function" ? v.bind(target) : v;
          },
        });

        let err = null;
        try {
          await runClaim({
            path: file,
            parent: bad,
            contractAddress: registryAddress,
            provider,
            signer: trippableSigner,
            chainId: 31337n, // pin the chain so even chainId lookup can't be the thing that errors
            log: () => {},
          });
        } catch (e) {
          err = e;
        }

        // It must throw the VALIDATION error (not a network/contract revert) and name --parent.
        expect(err, `malformed parent should reject (real submission): ${bad}`).to.not.equal(null);
        expect(err.message, `for ${bad}`).to.match(/invalid --parent/i);
        // And it must NOT be a downstream network/contract failure — proving validation came first.
        expect(
          /ECONNREFUSED|could not detect network|revert|NoSuchCommitment|RevealTooSoon|UnknownParent/i.test(
            String(err.message)
          ),
          `error for ${bad} must be the up-front validation error, not a downstream failure`
        ).to.equal(false);

        // Signal 1: no transaction was ever broadcast through the signer.
        expect(broadcastAttempted, `commit() must NOT be broadcast for ${bad}`).to.equal(false);
        // Signal 2: the on-chain nonce is unchanged — a commit() would have incremented it.
        const nonceAfter = await provider.getTransactionCount(signerAddr);
        expect(nonceAfter, `signer nonce must be unchanged for ${bad}`).to.equal(nonceBefore);

        // PARITY: the same malformed value fails the anchor path the same way, up front (buildAnchorTx
        // runs normalizeParent before any tx is built). Same error class -> the two commands agree.
        let anchorErr = null;
        try {
          buildAnchorTx({ path: file, parent: bad, contractAddress: registryAddress });
        } catch (e) {
          anchorErr = e;
        }
        expect(anchorErr, `anchor must also reject ${bad}`).to.not.equal(null);
        expect(anchorErr.message, `anchor parity for ${bad}`).to.match(/invalid --parent/i);
      }

      // A WELL-FORMED but self-referential parent is also a pre-network hard error (the contract's
      // SelfParent guard mirrored client-side) — proving the self-ref check runs up front too.
      const realSigner = freshSigner();
      const signerAddr = await realSigner.getAddress();
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
      // The child content hash equals hashing `file`; reuse buildCommitTx to learn it, then pass it as
      // its own parent so the self-reference guard fires.
      const { buildCommitTx } = require("../cli/claim");
      const ownHash = buildCommitTx({
        path: file,
        committer: signerAddr,
        contractAddress: registryAddress,
      }).contentHash;
      let selfErr = null;
      try {
        await runClaim({
          path: file,
          parent: ownHash,
          contractAddress: registryAddress,
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
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // WRITE-side: a VALID --parent on a REAL `vh claim` submission actually records the lineage edge
  // (routes the reveal leg to revealWithParent) and the child reads back [child, root] in order. This
  // proves the up-front validation did NOT break the happy path (no regression to the real claim flow).
  // -------------------------------------------------------------------------
  it("`vh claim --parent <root>` (REAL runClaim) reveals via revealWithParent and links the child", async function () {
    const root = await anchorRoot("ipfs://claim-link-root");

    const os = require("os");
    const fs = require("fs");
    const path = require("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-claim-link-"));
    const file = path.join(dir, "v2.txt");
    fs.writeFileSync(file, "claimed version two\n");
    try {
      const signer = new ethers.NonceManager(freshSigner());
      const claimant = await signer.getAddress();
      const res = await runClaim({
        path: file,
        parent: root.hash,
        contractAddress: registryAddress,
        provider,
        signer,
        chainId: 31337n,
        // Advance the chain past MIN_REVEAL_DELAY so the reveal leg can land on the live node.
        waitForBlock: async (target) => {
          while (BigInt(await provider.getBlockNumber()) < target) {
            await provider.send("evm_mine", []);
          }
        },
        log: () => {},
      });
      expect(res.dryRun).to.equal(false);
      expect(res.revealed).to.not.equal(null);
      expect(res.commitTx.contentHash).to.be.a("string");

      // The child's lineage reads back [child, root] in order, and the child is authorBound (a proven
      // first claimant via commit-reveal), while the plain-anchored root is not.
      const walk = await runLineage({
        contentHash: res.commitTx.contentHash,
        contractAddress: registryAddress,
        provider,
        log: () => {},
      });
      expect(walk.status).to.equal(STATUS.WALKED);
      expect(walk.ancestors.map((a) => a.contentHash)).to.deep.equal([
        res.commitTx.contentHash.toLowerCase(),
        root.hash,
      ]);
      expect(walk.ancestors[0].authorBound).to.equal(true);
      expect(walk.ancestors[0].contributor.toLowerCase()).to.equal(claimant.toLowerCase());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // READ side: a child anchored with --parent <root> reads back [child, root] in order.
  // -------------------------------------------------------------------------
  it("anchors a root then a child --parent <root>; `lineage <child>` returns [child, root] in order", async function () {
    const root = await anchorRoot("ipfs://root-v1");
    const child = await anchorChild(root.hash, "ipfs://child-v2");

    let out = "";
    const res = await runLineage({
      contentHash: child.hash,
      contractAddress: registryAddress,
      provider,
      log: (s) => (out += s),
    });

    expect(res.status).to.equal(STATUS.WALKED);
    expect(res.ancestors).to.have.length(2);
    // Order is child -> root.
    expect(res.ancestors[0].contentHash).to.equal(child.hash);
    expect(res.ancestors[1].contentHash).to.equal(root.hash);
    // Per-record contributors are preserved exactly.
    expect(res.ancestors[0].contributor).to.equal(child.contributor);
    expect(res.ancestors[1].contributor).to.equal(root.contributor);
    // The root is flagged; the child points at the root.
    expect(res.ancestors[0].isRoot).to.equal(false);
    expect(res.ancestors[0].parent).to.equal(root.hash);
    expect(res.ancestors[1].isRoot).to.equal(true);

    // Human output leads with BOTH caveats and renders each ancestor's fields.
    expect(out).to.contain(RECORD_CAVEAT);
    expect(out).to.contain(LINEAGE_CAVEAT);
    expect(out).to.contain(child.hash);
    expect(out).to.contain(root.hash);
    expect(out).to.contain("ipfs://child-v2");
    expect(out).to.match(/lineage root/);
    // ISO-8601 timestamps are rendered next to the unix seconds.
    expect(out).to.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // -------------------------------------------------------------------------
  // Per-record attribution: a commit-reveal child reads back authorBound, a plain anchor does not.
  // -------------------------------------------------------------------------
  it("walks per-record attribution: an authorBound (commit-reveal) child over a plain-anchor root", async function () {
    const root = await anchorRoot("ipfs://anchored-root"); // authorBound = false
    const child = await claimChild(root.hash, "ipfs://claimed-child"); // authorBound = true

    let out = "";
    const res = await runLineage({
      contentHash: child.hash,
      contractAddress: registryAddress,
      provider,
      log: (s) => (out += s),
    });
    expect(res.status).to.equal(STATUS.WALKED);
    expect(res.ancestors).to.have.length(2);

    // child: proven first claimant; root: first anchorer only — the two attributions are distinct.
    expect(res.ancestors[0].authorBound).to.equal(true);
    expect(res.ancestors[0].attribution).to.equal(ATTRIBUTION_PROVEN);
    expect(res.ancestors[1].authorBound).to.equal(false);
    expect(res.ancestors[1].attribution).to.equal(ATTRIBUTION_ANCHOR_ONLY);
    expect(out).to.contain(ATTRIBUTION_PROVEN);
    expect(out).to.contain(ATTRIBUTION_ANCHOR_ONLY);
    expect(ATTRIBUTION_PROVEN).to.not.equal(ATTRIBUTION_ANCHOR_ONLY);
  });

  // -------------------------------------------------------------------------
  // A 3-deep chain root -> v2 -> v3 reads back all three in order.
  // -------------------------------------------------------------------------
  it("a 3-deep chain (root -> v2 -> v3) reads back all three in order", async function () {
    const root = await anchorRoot("ipfs://r");
    const v2 = await anchorChild(root.hash, "ipfs://v2");
    const v3 = await anchorChild(v2.hash, "ipfs://v3");

    const res = await runLineage({
      contentHash: v3.hash,
      contractAddress: registryAddress,
      provider,
      log: () => {},
    });
    expect(res.status).to.equal(STATUS.WALKED);
    expect(res.ancestors.map((a) => a.contentHash)).to.deep.equal([v3.hash, v2.hash, root.hash]);
    // Depth indices increase from the start (0) to the root.
    expect(res.ancestors.map((a) => a.depth)).to.deep.equal([0, 1, 2]);
    expect(res.ancestors[2].isRoot).to.equal(true);
    expect(res.cappedAtDepth).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // `vh show <child>` reports the parent field (the same render lineage uses).
  // -------------------------------------------------------------------------
  it("`vh show <child>` reports the parent field; `vh show <root>` reports a lineage root", async function () {
    const root = await anchorRoot("");
    const child = await anchorChild(root.hash, "");

    let childOut = "";
    const childRes = await runShow({
      contentHash: child.hash,
      contractAddress: registryAddress,
      provider,
      log: (s) => (childOut += s),
    });
    expect(childRes.status).to.equal(SHOW_STATUS.ANCHORED);
    expect(childRes.parent).to.equal(root.hash);
    expect(childOut).to.match(/parent:\s+0x[0-9a-f]{64}/);
    expect(childOut).to.contain(root.hash);

    let rootOut = "";
    const rootRes = await runShow({
      contentHash: root.hash,
      contractAddress: registryAddress,
      provider,
      log: (s) => (rootOut += s),
    });
    expect(rootRes.status).to.equal(SHOW_STATUS.ANCHORED);
    // A root's parent is the zero hash; show renders "(none) — lineage root".
    expect(BigInt(rootRes.parent)).to.equal(0n);
    expect(rootOut).to.match(/parent:\s+\(none\) — lineage root/);
  });

  // -------------------------------------------------------------------------
  // NOT ANCHORED start hash -> distinct from a record, and the CLI exits non-zero.
  // -------------------------------------------------------------------------
  it("`lineage <unanchoredHash>` reports NOT ANCHORED (distinct from a record, not an error)", async function () {
    const hash = unanchoredHash();

    let out = "";
    const res = await runLineage({
      contentHash: hash,
      contractAddress: registryAddress,
      provider,
      log: (s) => (out += s),
    });
    expect(res.status).to.equal(STATUS.NOT_ANCHORED);
    expect(res.ancestors).to.have.length(0);
    expect(out).to.match(/NOT ANCHORED/);
  });

  it("the CLI exits NON-ZERO for a NOT ANCHORED start and ZERO for a walkable record", async function () {
    const { main } = require("../cli/vh");
    const root = await anchorRoot("");
    const child = await anchorChild(root.hash, "");
    const missing = unanchoredHash();

    const origWrite = process.stdout.write;
    process.stdout.write = () => true;
    let walkedCode, missingCode;
    try {
      walkedCode = await main([
        "lineage", child.hash, "--contract", registryAddress, "--rpc", RPC_URL,
      ]);
      missingCode = await main([
        "lineage", missing, "--contract", registryAddress, "--rpc", RPC_URL,
      ]);
    } finally {
      process.stdout.write = origWrite;
    }
    expect(walkedCode).to.equal(0);
    expect(missingCode).to.not.equal(0); // NOT ANCHORED is a non-zero exit
    expect(missingCode).to.equal(4); // mirrors `vh show`'s NOT ANCHORED exit code
  });

  // -------------------------------------------------------------------------
  // A malformed start hash hard-errors with usage BEFORE any network call.
  // -------------------------------------------------------------------------
  it("a malformed lineage <hash> errors WITHOUT hitting the network (validation precedes any RPC)", async function () {
    // A provider pointed at a dead port: if validation leaked through to the network, this would throw
    // a NETWORK error instead of the validation error. It throws the validation error, proving order.
    const deadProvider = new ethers.JsonRpcProvider("http://127.0.0.1:1");

    for (const bad of [
      "0x1234", // too short
      "0x" + "ab".repeat(33), // too long
      "0x" + "zz".repeat(32), // non-hex
      "deadbeef".repeat(8), // missing 0x prefix
      "not-a-hash",
    ]) {
      let err = null;
      try {
        await runLineage({
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
      expect(/ECONNREFUSED|could not detect network|connect/i.test(String(err.message))).to.equal(
        false
      );
    }
  });

  it("the CLI returns usage exit 2 for a malformed hash and never builds a provider", async function () {
    const { main } = require("../cli/vh");
    // Deliberately give NO --rpc and a bad hash. If the hash were validated AFTER the RPC check, this
    // would error on the missing RPC (exit 1). Instead it must fail on the hash (exit 2, usage).
    const origErr = process.stderr.write;
    process.stderr.write = () => true;
    let code;
    try {
      code = await main(["lineage", "0xnope", "--contract", registryAddress]);
    } finally {
      process.stderr.write = origErr;
    }
    expect(code).to.equal(2);
  });

  it("a malformed --max-depth errors with usage exit 2 WITHOUT hitting the network", async function () {
    const { main } = require("../cli/vh");
    const root = await anchorRoot("");
    const origErr = process.stderr.write;
    process.stderr.write = () => true;
    let code;
    try {
      // Valid hash, but a 0 depth is a usage error and must precede any RPC use (no --rpc here either).
      code = await main(["lineage", root.hash, "--contract", registryAddress, "--max-depth", "0"]);
    } finally {
      process.stderr.write = origErr;
    }
    expect(code).to.equal(2);
  });

  // -------------------------------------------------------------------------
  // --max-depth caps the walk and prints a clear note rather than looping forever.
  // -------------------------------------------------------------------------
  it("`--max-depth` caps the walk (stops before the root) and reports the cap + next predecessor", async function () {
    const root = await anchorRoot("ipfs://cap-root");
    const v2 = await anchorChild(root.hash, "ipfs://cap-v2");
    const v3 = await anchorChild(v2.hash, "ipfs://cap-v3");

    // Cap at 2: we read v3 and v2, then stop before the root (v2 still has a non-root parent).
    let out = "";
    const res = await runLineage({
      contentHash: v3.hash,
      contractAddress: registryAddress,
      provider,
      maxDepth: 2,
      log: (s) => (out += s),
    });
    expect(res.status).to.equal(STATUS.WALKED);
    expect(res.ancestors).to.have.length(2);
    expect(res.ancestors.map((a) => a.contentHash)).to.deep.equal([v3.hash, v2.hash]);
    expect(res.cappedAtDepth).to.equal(true);
    expect(res.maxDepth).to.equal(2);
    // The next un-walked predecessor is the root (v2's parent).
    expect(res.nextParent).to.equal(root.hash);
    // The human note names the cap and how to continue.
    expect(out).to.match(/lineage deeper than --max-depth \(2\)/);
    expect(out).to.contain(root.hash);

    // A cap >= the chain length walks the whole thing and is NOT flagged as capped.
    const full = await runLineage({
      contentHash: v3.hash,
      contractAddress: registryAddress,
      provider,
      maxDepth: 10,
      log: () => {},
    });
    expect(full.ancestors).to.have.length(3);
    expect(full.cappedAtDepth).to.equal(false);
    expect(full.nextParent).to.equal(null);
  });

  // -------------------------------------------------------------------------
  // --json round-trips: an ordered ancestor array carrying the same fields.
  // -------------------------------------------------------------------------
  it("--json round-trips a walked chain (parseable ordered ancestor array, fields preserved)", async function () {
    const root = await anchorRoot("ipfs://json-root");
    const v2 = await anchorChild(root.hash, "ipfs://json-v2");

    let out = "";
    const res = await runLineage({
      contentHash: v2.hash,
      contractAddress: registryAddress,
      provider,
      json: true,
      log: (s) => (out += s),
    });
    expect(res.status).to.equal(STATUS.WALKED);

    const parsed = JSON.parse(out);
    expect(parsed.anchored).to.equal(true);
    expect(parsed.start).to.equal(v2.hash);
    expect(Array.isArray(parsed.ancestors)).to.equal(true);
    expect(parsed.ancestors.map((a) => a.contentHash)).to.deep.equal([v2.hash, root.hash]);
    // Same fields as the human block, machine-typed.
    expect(parsed.ancestors[0].contributor).to.equal(v2.contributor);
    expect(parsed.ancestors[0].uri).to.equal("ipfs://json-v2");
    expect(parsed.ancestors[0].parent).to.equal(root.hash);
    expect(parsed.ancestors[0].isRoot).to.equal(false);
    expect(parsed.ancestors[0].timestamp).to.be.a("number");
    expect(parsed.ancestors[0].timestampISO).to.match(/\d{4}-\d{2}-\d{2}T/);
    expect(parsed.ancestors[0].blockNumber).to.be.a("number");
    // The root serializes parent:null + isRoot:true.
    expect(parsed.ancestors[1].parent).to.equal(null);
    expect(parsed.ancestors[1].isRoot).to.equal(true);
    expect(parsed.cappedAtDepth).to.equal(false);
    // jsonLineage(result) is exactly what was emitted.
    expect(parsed).to.deep.equal(jsonLineage(res));
  });

  it("--json round-trips a NOT ANCHORED start as anchored:false (not an error object)", async function () {
    const hash = unanchoredHash();
    let out = "";
    const res = await runLineage({
      contentHash: hash,
      contractAddress: registryAddress,
      provider,
      json: true,
      log: (s) => (out += s),
    });
    expect(res.status).to.equal(STATUS.NOT_ANCHORED);
    const parsed = JSON.parse(out);
    expect(parsed.anchored).to.equal(false);
    expect(parsed.ancestors).to.deep.equal([]);
    expect(parsed.note).to.match(/NOT ANCHORED/);
  });

  // -------------------------------------------------------------------------
  // Pure-unit guards (no node needed) for the parser + cap normalizer.
  // -------------------------------------------------------------------------
  it("parseLineageArgs / normalizeMaxDepth validate inputs (unit)", function () {
    expect(parseLineageArgs(["0xabc", "--json"]).hash).to.equal("0xabc");
    expect(parseLineageArgs(["0xabc", "--max-depth", "5"]).maxDepth).to.equal(5);
    expect(() => parseLineageArgs(["0xa", "0xb"])).to.throw(/extra argument/);
    expect(() => parseLineageArgs(["0xa", "--nope"])).to.throw(/unknown flag/);
    for (const bad of ["0", "-1", "abc", ""]) {
      expect(() => parseLineageArgs(["0xa", "--max-depth", bad]), bad).to.throw(/positive integer/);
    }
    expect(normalizeMaxDepth(undefined)).to.equal(DEFAULT_MAX_DEPTH);
    expect(normalizeMaxDepth(7)).to.equal(7);
    for (const bad of [0, -1, 1.5, "x"]) {
      expect(() => normalizeMaxDepth(bad), String(bad)).to.throw(/positive integer/);
    }
  });
});

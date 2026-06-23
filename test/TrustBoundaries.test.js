const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------------------------
// T-0.4 — Trust boundaries: uri + timestamp/blockNumber.
//
// These tests prove BOTH halves of the acceptance criteria:
//   1. The trust boundaries are actually DOCUMENTED — not only in source comments but in the
//      *compiled* NatSpec (devdoc/userdoc), and in docs/TRUST-BOUNDARIES.md + README.md. Asserting
//      against the compiled documentation means the docs cannot silently rot away from the code.
//   2. The trust boundaries are behaviourally TRUE:
//        - `uri` is never validated/derived by the contract (you can anchor a uri that points at the
//          wrong content and the contract stores it unchanged), so consumers MUST re-derive+re-hash.
//        - `timestamp`/`blockNumber` reflect the ANCHORING block (set by the chain at anchor time),
//          so they are an upper bound on existence + ordering, never authorship time.
// Covers audit findings F17 (uri unauthenticated) and C3 (timestamp validator-influenced, not time).
// ---------------------------------------------------------------------------------------------

// Pull the compiled NatSpec for ContributionRegistry out of the latest hardhat build-info. This is
// the machine-readable documentation solc emits from the /// NatSpec comments (enabled via
// outputSelection devdoc/userdoc in hardhat.config.js), so a test against it proves the contract is
// genuinely documented, not just commented.
function loadCompiledDoc() {
  const dir = path.join(__dirname, "..", "artifacts", "build-info");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (files.length === 0) throw new Error("no build-info; run `npx hardhat compile` first");
  // Pick the NEWEST build-info that actually contains ContributionRegistry. An incremental compile can
  // split unrelated contracts (e.g. the test-only stubs in contracts/test/) into their own newer
  // build-info that does NOT carry ContributionRegistry, so "latest file" alone is not enough.
  const KEY = "contracts/ContributionRegistry.sol";
  let bi = null;
  for (const { f } of files) {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (parsed.output && parsed.output.contracts && parsed.output.contracts[KEY]) {
      bi = parsed;
      break;
    }
  }
  if (!bi) throw new Error("no build-info contains ContributionRegistry; run `npx hardhat compile`");
  const out = bi.output.contracts[KEY]["ContributionRegistry"];
  if (!out.devdoc || !out.userdoc) {
    throw new Error(
      "compiled devdoc/userdoc missing — ensure hardhat.config.js outputSelection emits them"
    );
  }
  return { devdoc: out.devdoc, userdoc: out.userdoc };
}

// Flatten all the human text in a devdoc/userdoc object (contract notice/details + every method's
// notice/details/params) into one lowercased blob we can search for required phrases.
function allDocText(doc) {
  const parts = [];
  const visit = (v) => {
    if (v == null) return;
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(doc.devdoc);
  visit(doc.userdoc);
  return parts.join("\n").toLowerCase();
}

describe("Trust boundaries (T-0.4): uri + timestamp/blockNumber", function () {
  async function deploy() {
    const [deployer, alice] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ContributionRegistry");
    const registry = await Factory.deploy();
    await registry.waitForDeployment();
    return { registry, deployer, alice };
  }

  // -------------------------------------------------------------------------------------------
  // 1) The boundaries are documented in the COMPILED NatSpec.
  // -------------------------------------------------------------------------------------------
  describe("documented in the compiled NatSpec (devdoc/userdoc)", function () {
    it("uri is documented as an untrusted hint that consumers must re-derive + re-hash", function () {
      const text = allDocText(loadCompiledDoc());
      // uri must be called out as untrusted / a hint / not validated...
      expect(text).to.match(/uri/);
      expect(text).to.match(/untrusted/);
      // ...and the remedy (re-derive and re-hash the content, compare to the hash) must be stated.
      expect(text, "NatSpec must tell consumers to re-derive the hash").to.match(/re-?derive/);
      expect(text, "NatSpec must tell consumers to re-hash").to.match(/re-?hash/);
    });

    it("timestamp/blockNumber are documented as ordering + an upper bound, NOT authorship time", function () {
      const text = allDocText(loadCompiledDoc());
      expect(text).to.match(/timestamp/);
      expect(text).to.match(/blocknumber/);
      // The key honest disclaimers:
      expect(text, "NatSpec must say it is an upper bound on existence time").to.match(
        /upper bound/
      );
      expect(text, "NatSpec must say it is on-chain ordering").to.match(/ordering/);
      expect(text, "NatSpec must say it is NOT authorship time").to.match(
        /not[\s\S]{0,40}authorship time/
      );
      // And that block.timestamp is validator-influenced (audit finding C3).
      expect(text, "NatSpec must note timestamp is validator/proposer-influenced").to.match(
        /validator|proposer/
      );
    });
  });

  // -------------------------------------------------------------------------------------------
  // 2) The boundaries are documented in the prose docs (README + docs/TRUST-BOUNDARIES.md).
  // -------------------------------------------------------------------------------------------
  describe("documented in README + docs/TRUST-BOUNDARIES.md", function () {
    const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8").toLowerCase();

    it("docs/TRUST-BOUNDARIES.md states both the uri and the timestamp boundaries", function () {
      const doc = read("docs/TRUST-BOUNDARIES.md");
      expect(doc).to.include("untrusted");
      expect(doc).to.match(/re-?derive/);
      expect(doc).to.match(/re-?hash/);
      expect(doc).to.include("upper bound");
      expect(doc).to.match(/not[\s\S]{0,40}authorship time/);
      expect(doc).to.match(/validator|proposer/);
    });

    it("README links the trust-boundaries doc and summarizes both boundaries", function () {
      const readme = read("README.md");
      expect(readme).to.include("docs/trust-boundaries.md");
      expect(readme).to.include("untrusted");
      expect(readme).to.match(/re-?derive/);
      expect(readme).to.include("upper bound");
      expect(readme).to.match(/not[\s\S]{0,40}authorship time|not[\s\S]{0,40}authorship/);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3) uri is behaviourally UNTRUSTED: the contract never validates/derives it.
  // -------------------------------------------------------------------------------------------
  describe("uri is never validated by the contract (so consumers must re-hash)", function () {
    it("anchors a uri that points at DIFFERENT content; the contract stores it verbatim and unchecked", async function () {
      const { registry, alice } = await loadFixture(deploy);

      const realContent = ethers.toUtf8Bytes("the actual contribution bytes");
      const contentHash = ethers.keccak256(realContent);

      // A deliberately mismatched / dishonest uri: it claims to point at some OTHER content whose
      // hash is NOT contentHash. A registry that validated uris could never accept this. Ours does,
      // because uri is just an untrusted hint — that is exactly the boundary we are documenting.
      const lyingUri = "ipfs://this-cid-resolves-to-completely-different-bytes";

      await registry.connect(alice).anchor(contentHash, lyingUri);

      const rec = await registry.getRecord(contentHash);
      // The contract stored the (untrusted) uri byte-for-byte, never having checked it.
      expect(rec.uri).to.equal(lyingUri);
      // The ONLY integrity guarantee is contentHash: re-deriving the real content's hash matches it,
      // independent of whatever the uri says. This is the consumer-side check the docs prescribe.
      expect(ethers.keccak256(realContent)).to.equal(contentHash);
    });

    it("accepts an empty uri (it is optional metadata, not a security input)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const h = ethers.keccak256(ethers.toUtf8Bytes("content-with-no-uri"));
      await registry.connect(alice).anchor(h, "");
      expect((await registry.getRecord(h)).uri).to.equal("");
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4) timestamp/blockNumber are an upper bound + ordering, set at ANCHOR time — not authorship.
  // -------------------------------------------------------------------------------------------
  describe("timestamp/blockNumber prove anchor-time ordering + upper bound, not authorship", function () {
    it("records the block's timestamp/number from anchor time (chain-set, not caller-set)", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const h = ethers.keccak256(ethers.toUtf8Bytes("anchored-now"));

      const tx = await registry.connect(alice).anchor(h, "");
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const rec = await registry.getRecord(h);
      // The stored values equal the mined block's own values — proving they come from the chain at
      // anchor time, and that a caller cannot assert an arbitrary (e.g. backdated authorship) time.
      expect(rec.blockNumber).to.equal(BigInt(receipt.blockNumber));
      expect(rec.timestamp).to.equal(BigInt(block.timestamp));
    });

    it("content created long ago, anchored much later, records the LATE anchor time (upper bound only)", async function () {
      const { registry, alice } = await loadFixture(deploy);

      // Imagine this content was authored back at t0; it sat un-anchored for a "year".
      const content = ethers.toUtf8Bytes("authored long before it was ever anchored");
      const h = ethers.keccak256(content);

      const t0 = await time.latest();
      const oneYear = 365 * 24 * 60 * 60;
      const anchorTime = t0 + oneYear;

      // Anchor it only now, far in the future relative to authorship.
      await time.setNextBlockTimestamp(anchorTime);
      await registry.connect(alice).anchor(h, "");

      const rec = await registry.getRecord(h);
      // The recorded timestamp is the (late) ANCHOR time, with no knowledge of the earlier authorship
      // time — it is only an UPPER BOUND on existence ("existed by anchorTime"), never authorship.
      expect(rec.timestamp).to.equal(BigInt(anchorTime));
      expect(Number(rec.timestamp)).to.be.greaterThan(t0); // strictly later than authorship
    });

    it("blockNumber gives a hard, monotonic ordering between two anchors", async function () {
      const { registry, alice } = await loadFixture(deploy);
      const hEarly = ethers.keccak256(ethers.toUtf8Bytes("anchored-first"));
      const hLate = ethers.keccak256(ethers.toUtf8Bytes("anchored-second"));

      await registry.connect(alice).anchor(hEarly, "");
      // Advance several blocks between the two anchors.
      await network.provider.send("hardhat_mine", ["0x5"]);
      await registry.connect(alice).anchor(hLate, "");

      const early = await registry.getRecord(hEarly);
      const late = await registry.getRecord(hLate);
      // Ordering is provable from block height regardless of any timestamp games.
      expect(late.blockNumber).to.be.greaterThan(early.blockNumber);
      expect(late.timestamp).to.be.greaterThanOrEqual(early.timestamp);
    });
  });
});

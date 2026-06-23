const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// T-6.3 docs-rot guard for docs/RECEIPTS.md.
//
// Pure (no chain, no fixtures): asserts the receipt spec keeps documenting the things the code
// actually does, so the prose can't silently drift from cli/receipt.js / cli/verify.js / cli/claim.js.
// We cross-check load-bearing strings (the kind discriminators, the supported schema versions, the
// required/secret fields, the diff verbs, and the trust caveats) against the real exports/wording.
// ---------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

const {
  CLAIM_RECEIPT_KIND,
  ANCHOR_RECEIPT_KIND,
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
} = require("../cli/receipt");

describe("T-6.3 docs: docs/RECEIPTS.md specifies the receipt format + lifecycle", function () {
  const doc = read("docs/RECEIPTS.md");
  const docLower = doc.toLowerCase();

  it("exists and is non-trivial", function () {
    expect(doc.length).to.be.greaterThan(2000);
  });

  describe("schema: both kinds + the supported versions, pinned to the code", function () {
    it("names both receipt kind discriminators exactly as the code defines them", function () {
      // If someone renames the kind in receipt.js, this fails until the spec is updated too.
      expect(doc).to.include(CLAIM_RECEIPT_KIND);
      expect(doc).to.include(ANCHOR_RECEIPT_KIND);
    });

    it("documents the schema version this build writes and every version it reads", function () {
      expect(doc).to.include("schemaVersion");
      expect(doc).to.include(String(SCHEMA_VERSION)); // the version we write
      for (const v of SUPPORTED_SCHEMA_VERSIONS) {
        expect(doc).to.include(String(v)); // every version we still read
      }
    });

    it("documents every required header + claim field", function () {
      // Required everywhere.
      for (const f of ["contentHash", "contractAddress", "chainId", "uri"]) {
        expect(doc).to.include(f);
      }
      // Claim-receipt secret material (the whole reason the resume flow is durable).
      for (const f of ["salt", "commitment", "committer"]) {
        expect(doc).to.include(f);
      }
    });

    it("documents the per-file manifest triple { path, contentHash, leaf }", function () {
      expect(doc).to.include("manifest");
      expect(doc).to.include("leaf");
      expect(doc).to.include("path");
    });

    it("separates trusted fields from untrusted hints (uri caveat reused from the contract)", function () {
      expect(docLower).to.include("untrusted");
      expect(docLower).to.match(/re-?fetch/);
      expect(docLower).to.match(/re-?hash/);
      // The salt is the one operationally-sensitive field; the spec must say to keep it private.
      expect(docLower).to.match(/secret[\s\S]{0,80}salt|salt[\s\S]{0,80}secret|keep.{0,30}private/);
    });
  });

  describe("commit -> reveal resume lifecycle (T-6.1)", function () {
    it("explains the two-step split and the resumable commands", function () {
      expect(doc).to.include("vh commit");
      expect(doc).to.include("vh reveal");
      expect(doc).to.match(/--receipt/);
      expect(docLower).to.include("min_reveal_delay");
    });

    it("documents the durability problem the receipt solves (lost salt => unrevealable)", function () {
      // The exact failure mode that justifies persisting the salt before commit returns.
      expect(docLower).to.match(/unrevealable|cannot.{0,20}reveal|lost/);
      expect(docLower).to.match(/before[\s\S]{0,40}(commit|return)|persist/);
    });

    it("documents the retry semantics (RevealTooSoon leaves the receipt intact)", function () {
      expect(doc).to.include("RevealTooSoon");
      expect(doc).to.match(/NoSuchCommitment/);
    });
  });

  describe("directory-manifest diff semantics (T-6.2)", function () {
    it("documents the ADDED / REMOVED / CHANGED verbs and that the diff only localizes", function () {
      expect(doc).to.include("ADDED");
      expect(doc).to.include("REMOVED");
      expect(doc).to.include("CHANGED");
      expect(docLower).to.match(/localize|localizes|which file/);
    });

    it("states the authoritative verdict is the recomputed root vs the on-chain record", function () {
      expect(docLower).to.match(/recomputed root|re-?derive/);
      expect(docLower).to.include("on-chain record");
      expect(docLower).to.match(/match\/mismatch|mismatch/);
      // The stale/foreign-receipt guard surfaced by verify.js.
      expect(doc).to.include("receiptHashMismatch");
    });
  });

  it("includes a worked example with a concrete JSON receipt", function () {
    expect(doc).to.include("```json");
    expect(doc).to.include(CLAIM_RECEIPT_KIND); // inside the worked example block too
  });

  describe("cross-doc consistency", function () {
    it("links to TRUST-BOUNDARIES and MERKLE-LEAVES so the caveats stay consistent", function () {
      expect(doc).to.include("TRUST-BOUNDARIES.md");
      expect(doc).to.include("MERKLE-LEAVES.md");
    });

    it("README links docs/RECEIPTS.md next to the other docs", function () {
      const readme = read("README.md");
      expect(readme).to.include("docs/RECEIPTS.md");
      // It should sit in the same Docs list as the sibling specs.
      expect(readme).to.include("docs/TRUST-BOUNDARIES.md");
      expect(readme).to.include("docs/MERKLE-LEAVES.md");
    });
  });
});

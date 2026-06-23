const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// T-10.3 docs-rot guard for contribution lineage (docs/LINEAGE.md + the README CLI block
// + docs/TRUST-BOUNDARIES.md).
//
// Pure (no chain, no fixtures): asserts the prose keeps documenting what T-10.1 (the on-chain
// `parent` edge + `Linked` event) and T-10.2 (`vh anchor/claim --parent`, `vh lineage`, `vh show`'s
// parent line) actually do, so docs/LINEAGE.md, the README, and docs/TRUST-BOUNDARIES.md can't
// silently drift from cli/lineage.js / cli/show.js / cli/vh.js and the contract ABI. Load-bearing
// strings are cross-checked against the real exports (the trust caveats, the max-depth default, the
// WALKED/NOT_ANCHORED statuses) and the compiled ABI (the `Linked` event + the `parent` field), so a
// rename or a behaviour change fails THIS suite, not silently rots the docs.
//
// Reuses the TRUST-BOUNDARIES wording requirement (acceptance #3): the lineage caveat the CLI prints
// is the same CLAIM / re-derive-both / no-authorship-transfer language as the contract NatSpec and
// docs/TRUST-BOUNDARIES.md, so the three never disagree about what a `parent` edge means.
// ---------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

const {
  RECORD_CAVEAT,
  LINEAGE_CAVEAT,
  DEFAULT_MAX_DEPTH,
  STATUS,
  runLineage,
} = require("../cli/lineage");
const show = require("../cli/show");

// The compiled contract ABI — the source of truth for the on-chain shape the docs describe.
const ABI =
  require("../artifacts/contracts/ContributionRegistry.sol/ContributionRegistry.json").abi;

describe("T-10.3 docs: contribution lineage (docs/LINEAGE.md) + README CLI block + TRUST-BOUNDARIES", function () {
  const lineage = read("docs/LINEAGE.md");
  const lineageLower = lineage.toLowerCase();
  const readme = read("README.md");
  const readmeLower = readme.toLowerCase();
  const tb = read("docs/TRUST-BOUNDARIES.md");
  const tbLower = tb.toLowerCase();

  it("the lineage/show modules still export the symbols this guard pins against (tripwire)", function () {
    expect(RECORD_CAVEAT, "RECORD_CAVEAT export").to.be.a("string");
    expect(LINEAGE_CAVEAT, "LINEAGE_CAVEAT export").to.be.a("string");
    expect(DEFAULT_MAX_DEPTH, "DEFAULT_MAX_DEPTH export").to.be.a("number");
    expect(STATUS, "STATUS export").to.be.an("object");
    expect(runLineage, "runLineage export").to.be.a("function");
    expect(show.isRoot, "show.isRoot export").to.be.a("function");
  });

  it("the contract ABI still carries the Linked event + the Record.parent field (tripwire)", function () {
    const linked = ABI.find((e) => e.type === "event" && e.name === "Linked");
    expect(linked, "Linked event").to.be.an("object");
    expect(linked.inputs.map((i) => i.name)).to.deep.equal(["child", "parent"]);
    const getRecord = ABI.find((f) => f.name === "getRecord");
    const fields = getRecord.outputs[0].components.map((c) => c.name);
    expect(fields, "Record fields").to.include("parent");
    // The write entrypoints the --parent flag routes to.
    for (const fn of ["anchorWithParent", "revealWithParent"]) {
      expect(ABI.find((f) => f.name === fn), `${fn} ABI`).to.be.an("object");
    }
  });

  it("docs/LINEAGE.md exists and is non-trivial", function () {
    expect(lineage.length).to.be.greaterThan(2000);
  });

  describe("docs/LINEAGE.md specifies the on-chain parent edge", function () {
    it("states the edge is acyclic-by-construction, immutable, and O(1)", function () {
      expect(lineageLower).to.match(/acyclic by construction/);
      expect(lineageLower).to.include("immutable");
      expect(lineageLower).to.match(/o\(1\)/);
    });

    it("states bytes32(0) is the lineage root sentinel (no predecessor)", function () {
      expect(lineage).to.include("bytes32(0)");
      expect(lineageLower).to.match(/lineage root/);
    });

    it("states what the edge does NOT prove (ancestry, authorship transfer)", function () {
      // The two negatives the contract NatSpec / TRUST-BOUNDARIES draw.
      expect(lineageLower).to.match(/not[\s\S]{0,80}ancestry|does not prove[\s\S]{0,120}ancestor/);
      expect(lineageLower).to.match(/not[\s\S]{0,80}transfer[\s\S]{0,40}authorship|authorship[\s\S]{0,80}not[\s\S]{0,40}transfer/);
      // The positive framing: an edge is a CLAIM, and you re-derive BOTH contents.
      expect(lineage).to.match(/CLAIM/);
      expect(lineageLower).to.match(/re-derive\s+both/);
    });

    it("names the revert pair (UnknownParent / SelfParent) the write enforces", function () {
      expect(lineage).to.include("UnknownParent");
      expect(lineage).to.include("SelfParent");
    });
  });

  describe("docs/LINEAGE.md documents the Linked event log shape an indexer uses", function () {
    it("names the Linked(child, parent) event", function () {
      expect(lineage).to.include("Linked");
      expect(lineage).to.match(/Linked\(child, *parent\)|child.*parent/);
    });

    it("states a root emits NO Linked event (absence == lineage root) and that it is parallel/additive", function () {
      // Tolerate markdown emphasis between words (the doc bolds "no"/"absence").
      expect(lineageLower).to.match(/no[\s*]+`?linked`?\s+(log|event)|absence[\s*]+of a `?linked`?/);
      expect(lineageLower).to.match(/parallel|in addition to|alongside|byte-for-byte/);
    });

    it("states an indexer reconstructs the graph from the logs", function () {
      expect(lineageLower).to.match(/indexer/);
      expect(lineageLower).to.match(/reconstruct/);
    });
  });

  describe("docs/LINEAGE.md documents the --parent write flow and the read flow", function () {
    it("documents vh anchor/claim --parent routing to anchorWithParent/revealWithParent", function () {
      expect(lineage).to.include("--parent");
      expect(lineage).to.include("anchorWithParent");
      expect(lineage).to.include("revealWithParent");
    });

    it("documents vh lineage as the read-only walk with --max-depth and its default", function () {
      expect(lineage).to.include("vh lineage");
      expect(lineage).to.include("--max-depth");
      // The default cap must match cli/lineage.js's DEFAULT_MAX_DEPTH so the doc can't lie about it.
      expect(lineage).to.include(String(DEFAULT_MAX_DEPTH));
      expect(lineageLower).to.match(/read-only/);
      expect(lineageLower).to.match(/no key/);
    });

    it("documents vh show surfacing a record's parent", function () {
      expect(lineage).to.include("vh show");
      expect(lineage).to.include("parent");
    });

    it("states the order is child -> root and that attribution is per-record", function () {
      expect(lineageLower).to.match(/child\s*(->|→)\s*root|child.{0,10}root order/);
      expect(lineage).to.include("authorBound");
    });
  });

  describe("docs/LINEAGE.md has a worked end-to-end example", function () {
    it("walks anchor root -> anchor revision -> walk lineage", function () {
      // The three-step framing the acceptance asks for.
      expect(lineage).to.include("vh anchor");
      expect(lineage).to.include("--parent");
      expect(lineage).to.include("vh lineage");
      expect(lineageLower).to.match(/anchor.{0,40}root[\s\S]{0,400}revision[\s\S]{0,400}lineage|worked/);
    });

    it("shows the human walk leading with BOTH trust caveats it actually prints", function () {
      // The example reproduces the exact caveats cli/lineage.js emits, so they can't drift.
      expect(lineage).to.include(RECORD_CAVEAT);
      expect(lineage).to.include(LINEAGE_CAVEAT);
    });

    it("shows the WALKED result and a --json ancestor array", function () {
      expect(lineage).to.include("WALKED");
      expect(lineage).to.include("--json");
      expect(lineage).to.include("ancestors");
      // A root serializes parent:null + isRoot:true in the JSON example.
      expect(lineage).to.match(/"isRoot":\s*true/);
    });
  });

  describe("README CLI block lists vh lineage and the --parent flag", function () {
    const block = readme.split("```").find((b) => b.includes("vh hash") && b.includes("vh verify"));

    it("has the CLI fenced block", function () {
      expect(block, "CLI fenced block").to.be.a("string");
    });

    it("lists vh lineage with a description", function () {
      const line = block.split("\n").find((l) => l.includes("vh lineage"));
      expect(line, "vh lineage line").to.be.a("string");
      expect(line).to.match(/vh lineage[^\n]*#[^\n]+/);
    });

    it("states the read-only walk, no-key property for vh lineage in that block", function () {
      const line = block.split("\n").find((l) => l.includes("vh lineage")).toLowerCase();
      expect(line).to.match(/read-only|walk/);
      expect(line).to.match(/no key|no\s*key/);
    });

    it("lists the --parent flag in the CLI block", function () {
      expect(block).to.include("--parent");
    });
  });

  describe("README lineage prose + Docs list cross-link to docs/LINEAGE.md", function () {
    it("has a contribution-lineage section naming the commands", function () {
      expect(readmeLower).to.include("lineage");
      expect(readme).to.include("--parent");
      expect(readme).to.include("vh lineage");
    });

    it("states the --parent edge is the child author's CLAIM (no ancestry/authorship proof)", function () {
      expect(readme).to.match(/CLAIM/);
      // Tolerate markdown emphasis around "both" (the README bolds it).
      expect(readmeLower).to.match(/re-derive[\s*]+both/);
      expect(readmeLower).to.match(/not[\s\S]{0,60}ancestry|genuine[\s\S]{0,40}ancestor/);
      expect(readmeLower).to.match(/not[\s\S]{0,60}transfer[\s\S]{0,40}authorship/);
    });

    it("reuses the TRUST-BOUNDARIES caveats (untrusted uri + authorBound) so wording stays consistent", function () {
      // The lineage prose ties back to the shared record caveats, not a fresh, divergent set.
      expect(readme).to.include("authorBound");
      expect(readme).to.include("docs/TRUST-BOUNDARIES.md");
    });

    it("links docs/LINEAGE.md from both the prose and the Docs list", function () {
      expect(readme).to.include("docs/LINEAGE.md");
      // It appears in the Docs bullet list (after RECEIPTS, before AUDIT) AND in the prose section.
      const occurrences = readme.split("docs/LINEAGE.md").length - 1;
      expect(occurrences).to.be.greaterThan(1);
    });
  });

  describe("docs/TRUST-BOUNDARIES.md carries the lineage parent caveat (reuses existing wording)", function () {
    it("shows the parent field in the Record struct", function () {
      expect(tb).to.include("parent");
      expect(tb).to.include("bytes32(0)");
    });

    it("states a parent edge is a CLAIMED predecessor proving neither ancestry nor authorship transfer", function () {
      expect(tb).to.match(/CLAIM/);
      expect(tbLower).to.match(/not[\s\S]{0,80}ancestry|genuine[\s\S]{0,40}ancestor/);
      expect(tbLower).to.match(/not[\s\S]{0,80}transfer[\s\S]{0,40}authorship|transfer[\s\S]{0,40}authorship/);
      expect(tbLower).to.match(/re-derive\s+both/);
    });

    it("names vh lineage and keeps it read-only / no key, consistent with vh list / vh show", function () {
      expect(tb).to.include("vh lineage");
      expect(tbLower).to.match(/read-only/);
      expect(tbLower).to.match(/no key/);
    });

    it("ties the lineage caveat to the existing record caveats (authorBound + untrusted uri)", function () {
      expect(tb).to.include("authorBound");
      expect(tbLower).to.include("untrusted");
    });

    it("cross-links docs/LINEAGE.md for the full graph spec", function () {
      expect(tb).to.include("LINEAGE.md");
    });
  });
});

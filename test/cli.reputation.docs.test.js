const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// T-12.3 docs-rot guard for the CONTRIBUTION SCORE (`vh reputation <addr>`).
//
// Pure (no chain, no fixtures): asserts that docs/REPUTATION.md, README.md, and
// docs/TRUST-BOUNDARIES.md keep documenting the score the way cli/reputation.js actually behaves, so
// the prose can't silently drift from the implementation. Pure documentation of the T-12.1/T-12.2
// runtime; no new behaviour. The load-bearing properties under test:
//   * REPUTATION.md gives the EXACT definition (the single getRecordsByContributor read it aggregates,
//     with contributorRecordCount as the companion O(1) count it does not itself call, the breakdowns, the
//     block/time bounds), states plainly it is a NON-TRANSFERABLE DERIVED VIEW / NOT a token (tradeable
//     layer = D-2/P-1, human-only), and documents what it does NOT prove,
//   * an anti-sybil note: the meaningful signal is the authorBound (commit-reveal) count,
//   * README's CLI block lists `vh reputation <addr>` with read-only/no-key/authenticated, and a short
//     TRUST-BOUNDARIES note cross-links it, reusing the existing TRUST-BOUNDARIES wording.
// ---------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// Importing these fails this suite loudly if the reputation module or its caveats are ever removed,
// and lets us pin the docs to the exact phrases the code exports so they cannot drift.
const reputation = require("../cli/reputation");
const { ATTRIBUTION_PROVEN, ATTRIBUTION_ANCHOR_ONLY } = require("../cli/list");

describe("T-12.3 docs: README + TRUST-BOUNDARIES + REPUTATION document the contribution score", function () {
  const readme = read("README.md");
  const readmeLower = readme.toLowerCase();
  const tb = read("docs/TRUST-BOUNDARIES.md");
  const tbLower = tb.toLowerCase();
  const rep = read("docs/REPUTATION.md");
  const repLower = rep.toLowerCase();

  it("the reputation module still exports the surface this guard pins against", function () {
    // Tripwire: if cli/reputation.js drops these, the docs guards below describe nothing.
    expect(reputation.runReputation, "runReputation export").to.be.a("function");
    expect(reputation.computeScore, "computeScore export").to.be.a("function");
    expect(reputation.TRUST_CAVEAT, "TRUST_CAVEAT export").to.be.a("string");
    expect(ATTRIBUTION_PROVEN, "ATTRIBUTION_PROVEN export").to.be.a("string");
    expect(ATTRIBUTION_ANCHOR_ONLY, "ATTRIBUTION_ANCHOR_ONLY export").to.be.a("string");
    // The computed score keeps the breakdown keys the docs name, kept SEPARATE (never one number).
    const empty = reputation.computeScore([]);
    for (const k of ["total", "authorBound", "anchorOnly", "lineageRoots", "revisions", "earliest", "latest"]) {
      expect(empty, `computeScore key ${k}`).to.have.property(k);
    }
  });

  describe("docs/REPUTATION.md specifies the EXACT definition", function () {
    it("names the single read it aggregates (getRecordsByContributor) and contributorRecordCount as the companion count", function () {
      // The command issues ONLY the paged getRecordsByContributor walk; total = records.length from it.
      expect(rep).to.include("getRecordsByContributor");
      // contributorRecordCount must be described as the COMPANION O(1) count an external consumer may
      // call, NOT as a read the command itself issues. Pin that it appears AND is framed as a companion.
      expect(rep).to.include("contributorRecordCount");
      expect(repLower).to.match(/companion/);
      // and the doc must say the command makes a single read, not two
      expect(repLower).to.match(/single ownerless .{0,20}read|exactly\s*\*?\*?one read shape/);
    });

    it("documents the authorBound vs anchor-only breakdown", function () {
      expect(rep).to.include("authorBound");
      expect(repLower).to.match(/anchor-only|anchoronly/);
    });

    it("documents the lineage-root vs revision breakdown", function () {
      expect(repLower).to.match(/lineage root/);
      expect(repLower).to.include("revision");
      // root == parent zero; revision == a CLAIMED parent edge.
      expect(rep).to.match(/parent == (bytes32\(0\)|0x0)/);
    });

    it("documents the block/time bounds (earliest/latest, upper bound on existence)", function () {
      expect(repLower).to.match(/earliest/);
      expect(repLower).to.match(/latest/);
      expect(repLower).to.match(/upper bound on existence/);
      // the same ordering caveat as the rest of the trust model
      expect(repLower).to.match(/not authorship time|never authorship time/);
    });
  });

  describe("docs/REPUTATION.md: NON-TRANSFERABLE DERIVED VIEW, NOT a token", function () {
    it("states it is a non-transferable derived view, re-derivable by anyone", function () {
      expect(repLower).to.match(/non-transferable/);
      expect(repLower).to.match(/derived view/);
      expect(repLower).to.match(/re-?derivable by anyone/);
    });

    it("states plainly it is NOT a token", function () {
      expect(repLower).to.match(/not a token/);
    });

    it("says any tradeable layer is the human-gated D-2/P-1 decision (not built here)", function () {
      expect(rep).to.match(/D-2/);
      expect(rep).to.match(/P-1/);
      expect(repLower).to.match(/human-?gated|needs-human|human-only/);
    });
  });

  describe("docs/REPUTATION.md: what it does NOT prove", function () {
    it("does NOT validate record content — re-derive + vh verify", function () {
      expect(repLower).to.match(/does not validate|not validate/);
      expect(repLower).to.match(/content/);
      expect(repLower).to.match(/re-?derive/);
      expect(rep).to.include("vh verify");
    });

    it("does NOT upgrade a front-runnable anchor's attribution", function () {
      expect(repLower).to.match(/does not upgrade|not upgrade/);
      expect(repLower).to.match(/front-runnable|front-running/);
      expect(repLower).to.match(/raw enumeration|not an endorsement/);
    });

    it("for anchor-only records the grouping address is merely the first anchorer", function () {
      expect(repLower).to.match(/first anchorer/);
    });
  });

  describe("docs/REPUTATION.md: anti-sybil — the meaningful signal is the authorBound count", function () {
    it("names sybil and identifies the authorBound (commit-reveal) count as the meaningful signal", function () {
      expect(repLower).to.match(/sybil/);
      expect(repLower).to.match(/meaningful signal is the .{0,30}authorbound/);
      expect(repLower).to.match(/commit-reveal/);
    });

    it("explains the cost asymmetry (front-running-resistant claim costs; anchors + addresses are cheap)", function () {
      expect(repLower).to.match(/real,? .{0,20}cost|real cost/);
      expect(repLower).to.match(/cheap/);
      // and that the two counts are reported separately, never summed
      expect(repLower).to.match(/separately and never sum/);
    });
  });

  describe("README CLI block lists vh reputation with read-only/no-key/authenticated", function () {
    it("names the command", function () {
      expect(readme).to.include("vh reputation");
    });

    it("gives it a one-line description in the CLI fenced block with read-only + no-key + authenticated", function () {
      const block = readme.split("```").find((b) => b.includes("vh hash") && b.includes("vh verify"));
      expect(block, "CLI fenced block").to.be.a("string");
      const line = block.split("\n").find((l) => l.includes("vh reputation"));
      expect(line, "vh reputation CLI line").to.be.a("string");
      expect(line).to.match(/#[^\n]+/); // has a description
      expect(line.toLowerCase()).to.match(/read-only/);
      expect(line.toLowerCase()).to.match(/no key/);
      expect(line.toLowerCase()).to.match(/authenticated/);
    });
  });

  describe("README documents the score with the consistent caveats + cross-link", function () {
    it("states it is a non-transferable derived view / NOT a token", function () {
      expect(readmeLower).to.match(/non-transferable derived view/);
      expect(readmeLower).to.match(/not a token/);
    });

    it("carries the anti-sybil note (meaningful signal = authorBound; anchors + addresses cheap)", function () {
      expect(readmeLower).to.match(/anti-?sybil/);
      expect(readmeLower).to.match(/authorbound .{0,40}count|meaningful signal/);
      expect(readmeLower).to.match(/cheap/);
    });

    it("reuses the TRUST-BOUNDARIES caveats (does not validate content; first anchorer)", function () {
      expect(readmeLower).to.match(/does not validate|not validate/);
      expect(readmeLower).to.match(/first anchorer/);
    });

    it("cross-links to docs/TRUST-BOUNDARIES.md and docs/REPUTATION.md", function () {
      expect(readme).to.include("docs/TRUST-BOUNDARIES.md");
      expect(readme).to.include("docs/REPUTATION.md");
    });
  });

  describe("docs/TRUST-BOUNDARIES.md carries the score caveat (consistent wording)", function () {
    it("names vh reputation and the single read it groups by (getRecordsByContributor), companion count", function () {
      expect(tb).to.include("vh reputation");
      expect(tb).to.include("getRecordsByContributor");
      // contributorRecordCount appears, framed as the companion count the command does not itself call.
      expect(tb).to.include("contributorRecordCount");
      expect(tbLower).to.match(/companion/);
    });

    it("states it is a non-transferable derived view, NOT a token (D-2/P-1 human-gated)", function () {
      expect(tbLower).to.match(/non-transferable derived view/);
      expect(tbLower).to.match(/not a token/);
      expect(tb).to.match(/D-2/);
      expect(tb).to.match(/P-1/);
    });

    it("reuses the existing caveats: read-only/no key, does not validate content, first anchorer", function () {
      expect(tbLower).to.match(/read-only/);
      expect(tbLower).to.match(/no key/);
      expect(tbLower).to.match(/does not validate/);
      expect(tbLower).to.match(/first anchorer/);
    });

    it("carries the anti-sybil note (meaningful signal = authorBound count; never summed)", function () {
      expect(tbLower).to.match(/anti-?sybil/);
      expect(tbLower).to.match(/meaningful signal is the .{0,30}authorbound/);
      expect(tbLower).to.match(/separately and never\s+sum/);
    });

    it("cross-links to docs/REPUTATION.md", function () {
      expect(tb).to.include("REPUTATION.md");
    });
  });
});

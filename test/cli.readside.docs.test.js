const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// T-7.4 docs-rot guard for the READ side (`vh list` + `vh show`).
//
// Pure (no chain, no fixtures): asserts that README.md and docs/TRUST-BOUNDARIES.md keep documenting
// the read commands the way the code actually behaves, so the prose can't silently drift from
// cli/list.js / cli/show.js / cli/vh.js. The load-bearing properties under test:
//   * both commands are listed in the README CLI block with a one-line description + the
//     "read-only, no key" property,
//   * a discovery/audit section explains them and reiterates that listing/showing does NOT validate
//     content — you still re-derive + `vh verify`,
//   * the caveats reuse the existing TRUST-BOUNDARIES wording (untrusted `uri`, authorBound) so they
//     stay consistent, and TRUST-BOUNDARIES itself carries the read-side caveat.
// ---------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// The trust caveats the CLI prints. We don't pin README to these verbatim (the docs paraphrase), but
// we DO require the README/docs to carry the same load-bearing phrases the code does, so they can't
// drift apart. Importing them also fails this suite loudly if the read modules are ever removed.
const list = require("../cli/list");
const show = require("../cli/show");

describe("T-7.4 docs: README + TRUST-BOUNDARIES document the read side (vh list / vh show)", function () {
  const readme = read("README.md");
  const readmeLower = readme.toLowerCase();
  const tb = read("docs/TRUST-BOUNDARIES.md");
  const tbLower = tb.toLowerCase();

  it("the read modules still export the caveats this guard pins against", function () {
    // Tripwire: if cli/list.js or cli/show.js drop these, the docs guard below is meaningless.
    for (const mod of [list, show]) {
      expect(mod.TRUST_CAVEAT, "TRUST_CAVEAT export").to.be.a("string");
      expect(mod.ATTRIBUTION_PROVEN, "ATTRIBUTION_PROVEN export").to.be.a("string");
      expect(mod.ATTRIBUTION_ANCHOR_ONLY, "ATTRIBUTION_ANCHOR_ONLY export").to.be.a("string");
    }
  });

  describe("README CLI block lists vh list and vh show", function () {
    it("names both commands", function () {
      expect(readme).to.include("vh list");
      expect(readme).to.include("vh show");
    });

    it("gives each a one-line description in the CLI fenced block", function () {
      // Pull the first fenced ``` block that holds the command list and assert both lines exist there
      // with a description (text after the command), not just a bare mention elsewhere.
      const block = readme.split("```").find((b) => b.includes("vh hash") && b.includes("vh verify"));
      expect(block, "CLI fenced block").to.be.a("string");
      // `vh list ...   # <something>` and `vh show ...  # <something>`.
      expect(block).to.match(/vh list[^\n]*#[^\n]+/);
      expect(block).to.match(/vh show[^\n]*#[^\n]+/);
    });

    it("states the read-only, no-key property for the read commands in that block", function () {
      const block = readme.split("```").find((b) => b.includes("vh hash") && b.includes("vh verify"));
      // Both lines must advertise read-only-ness / no key right where they are introduced.
      const listLine = block.split("\n").find((l) => l.includes("vh list"));
      const showLine = block.split("\n").find((l) => l.includes("vh show"));
      expect(listLine.toLowerCase()).to.match(/read-only/);
      expect(listLine.toLowerCase()).to.match(/no key|no\s*key/);
      expect(showLine.toLowerCase()).to.match(/read-only/);
      expect(showLine.toLowerCase()).to.match(/no key|no\s*key/);
    });
  });

  describe("README has a discovery/audit section for the read side", function () {
    it("calls out discovery and audit by name", function () {
      expect(readmeLower).to.include("discovery");
      expect(readmeLower).to.include("audit");
    });

    it("reiterates that listing/showing does NOT validate content", function () {
      // The exact property T-7.4 requires: reading a record is not the integrity check.
      expect(readmeLower).to.match(/does not validate|not validate (its )?content/);
    });

    it("tells the reader they must still re-derive + vh verify", function () {
      expect(readmeLower).to.match(/re-?derive/);
      expect(readme).to.include("vh verify");
    });

    it("reuses the TRUST-BOUNDARIES caveats (untrusted uri + authorBound) so wording stays consistent", function () {
      expect(readmeLower).to.include("untrusted");
      expect(readme).to.include("authorBound");
    });

    it("cross-links to docs/TRUST-BOUNDARIES.md from the read-side prose", function () {
      expect(readme).to.include("docs/TRUST-BOUNDARIES.md");
    });
  });

  describe("docs/TRUST-BOUNDARIES.md carries the read-side caveat", function () {
    it("names both read commands", function () {
      expect(tb).to.include("vh list");
      expect(tb).to.include("vh show");
    });

    it("states reading a record does NOT validate its content", function () {
      expect(tbLower).to.match(/does not validate|not the integrity check/);
    });

    it("reiterates the re-derive-and-compare / vh verify integrity check", function () {
      expect(tbLower).to.match(/re-?derive/);
      expect(tb).to.include("vh verify");
    });

    it("keeps the read commands read-only / no key", function () {
      expect(tbLower).to.match(/read-only/);
      expect(tbLower).to.match(/no key/);
    });

    it("ties contributor trust to authorBound, consistent with the rest of the doc", function () {
      expect(tb).to.include("authorBound");
    });
  });
});

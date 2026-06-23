const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// T-14.3 docs-rot guard for DataLedger as a PRODUCT.
//
// Pure (no chain, no fixtures): asserts that docs/DATALEDGER.md and README.md keep documenting the
// `vh dataset` product the way the code actually behaves, so the buyer-facing prose can't silently
// drift from cli/dataset.js / cli/vh.js. Load-bearing properties under test:
//   * docs/DATALEDGER.md exists and specifies what DataLedger PROVES (names AND bytes; offline
//     set-membership; precise add/remove/change between versions; a provenance/license roll-up),
//   * and what it does NOT prove (NOT a timestamp — "unaltered since date T" needs the human-owned
//     signing/timestamp trust-root, a needs-human step in STRATEGY.md — and {source,license} hints are
//     UNTRUSTED self-asserted metadata),
//   * the end-to-end workflow (build → diff → summary → prove → verify-proof) with a worked example,
//   * a "what an auditor / EU-AI-Act reviewer gets" command→evidence mapping,
//   * README gains a `### Dataset provenance (DataLedger)` section in the CLI block listing all six
//     subcommands with the "offline, no key, no network" property and a link to docs/DATALEDGER.md,
//   * the caveats reuse the existing dataset TRUST_NOTE / MEMBERSHIP_TRUST_NOTE wording so they stay
//     consistent with the artifacts the code writes in-band.
// ---------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// Importing dataset.js both pins the in-band trust wording this guard reuses AND fails loudly if the
// module (or its caveat exports) is ever removed — the docs guard would otherwise be meaningless.
const dataset = require("../cli/dataset");

const SUBCOMMANDS = ["build", "verify", "diff", "summary", "prove", "verify-proof"];

describe("T-14.3 docs: DataLedger documented as a product (docs/DATALEDGER.md + README)", function () {
  let doc, docLower, readme, readmeLower;

  before(function () {
    doc = read("docs/DATALEDGER.md");
    docLower = doc.toLowerCase();
    readme = read("README.md");
    readmeLower = readme.toLowerCase();
  });

  it("dataset.js still exports the caveat wording this guard pins against", function () {
    // Tripwire: if cli/dataset.js drops these, the wording-consistency assertions below are hollow.
    expect(dataset.TRUST_NOTE, "TRUST_NOTE export").to.be.a("string");
    expect(dataset.MEMBERSHIP_TRUST_NOTE, "MEMBERSHIP_TRUST_NOTE export").to.be.a("string");
  });

  describe("docs/DATALEDGER.md exists and specifies what DataLedger PROVES", function () {
    it("the file exists and is non-trivial", function () {
      expect(doc, "docs/DATALEDGER.md").to.be.a("string");
      expect(doc.length).to.be.greaterThan(1000);
    });

    it("proves the dataset contained exactly which files — names AND bytes", function () {
      expect(docLower).to.match(/names? and bytes|file names? and bytes/);
      // The root commits to (relPath, content) pairs — names + content.
      expect(docLower).to.include("(relpath, content)");
    });

    it("proves offline set-membership of any one file", function () {
      expect(docLower).to.include("set-membership");
      expect(docLower).to.include("offline");
    });

    it("proves the precise add/remove/change between two versions", function () {
      expect(doc).to.include("ADDED");
      expect(doc).to.include("REMOVED");
      expect(doc).to.include("CHANGED");
      expect(docLower).to.match(/between two (dataset )?versions|model version n and n\+1/);
    });

    it("proves a provenance/license roll-up", function () {
      expect(docLower).to.match(/provenance ?\/? ?license roll-up|license.*roll-up|roll-up/);
      expect(docLower).to.include("histogram");
    });
  });

  describe("docs/DATALEDGER.md states what it does NOT prove (no overclaim)", function () {
    it("is explicit it is NOT a timestamp", function () {
      expect(docLower).to.match(/not a timestamp|is not a timestamp/);
      expect(docLower).to.include("unaltered since");
    });

    it("routes the time-anchored claim to the human-owned signing/timestamp trust-root in STRATEGY.md", function () {
      expect(docLower).to.match(/signing ?\/? ?timestamp trust-root|signing\/timestamp/);
      expect(docLower).to.include("needs-human");
      expect(doc).to.include("STRATEGY.md");
    });

    it("labels the {source, license} hints as UNTRUSTED self-asserted metadata", function () {
      expect(doc).to.include("UNTRUSTED");
      expect(docLower).to.include("self-asserted");
      // not bound into the root.
      expect(docLower).to.match(/not bound into the (merkle )?root/);
    });
  });

  describe("docs/DATALEDGER.md reuses the existing in-band TRUST wording (no drift)", function () {
    it("carries the dataset TRUST_NOTE wording verbatim", function () {
      expect(doc).to.include(dataset.TRUST_NOTE);
    });

    it("uses the same load-bearing membership phrase as MEMBERSHIP_TRUST_NOTE", function () {
      // Both the code's MEMBERSHIP_TRUST_NOTE and the doc must say membership is NOT 'unaltered since'.
      expect(dataset.MEMBERSHIP_TRUST_NOTE.toLowerCase()).to.include("unaltered since");
      expect(docLower).to.include("unaltered since");
    });
  });

  describe("docs/DATALEDGER.md documents the workflow end-to-end with a worked example", function () {
    it("names the full pipeline build → diff → summary → prove → verify-proof", function () {
      // All five stages present.
      for (const stage of ["build", "diff", "summary", "prove", "verify-proof"]) {
        expect(docLower, `mentions ${stage}`).to.include(stage);
      }
      // The canonical ordered pipeline line lists them in order on a single line.
      const pipelineLine = doc
        .split("\n")
        .find((l) => /build/.test(l) && /diff/.test(l) && /summary/.test(l) && /verify-proof/.test(l));
      expect(pipelineLine, "an ordered build→diff→summary→prove→verify-proof line").to.be.a("string");
      const p = pipelineLine.toLowerCase();
      const idx = (s) => p.indexOf(s);
      expect(idx("build")).to.be.lessThan(idx("diff"));
      expect(idx("diff")).to.be.lessThan(idx("summary"));
      expect(idx("summary")).to.be.lessThan(idx("prove"));
      // 'prove' vs 'verify-proof': verify-proof contains 'proof' not 'prove', so compare last index of 'prove'.
      expect(p.indexOf("prove")).to.be.lessThan(idx("verify-proof"));
    });

    it("has a worked example invoking each dataset subcommand", function () {
      for (const sub of SUBCOMMANDS) {
        expect(doc, `worked example uses vh dataset ${sub}`).to.include(`vh dataset ${sub}`);
      }
    });

    it("documents the diff/verify mismatch exit code so CI can gate on it", function () {
      expect(doc).to.match(/exit\s*0|exit\s*3/i);
      expect(docLower).to.include("exit 3");
    });
  });

  describe("docs/DATALEDGER.md has the auditor / EU-AI-Act evidence mapping", function () {
    it("names an auditor / EU AI Act reviewer", function () {
      expect(docLower).to.match(/eu ai act|eu-ai-act/);
      expect(docLower).to.include("auditor");
    });

    it("maps each command to the evidence it produces", function () {
      // The mapping section must mention each command that produces evidence.
      for (const sub of ["build", "verify", "diff", "summary", "prove"]) {
        expect(doc, `mapping references vh dataset ${sub}`).to.include(`vh dataset ${sub}`);
      }
      expect(docLower).to.match(/evidence|what .* gets/);
    });
  });

  describe("README has a Dataset provenance (DataLedger) section", function () {
    it("uses the exact required heading", function () {
      expect(readme).to.include("### Dataset provenance (DataLedger)");
    });

    it("lists all six vh dataset subcommands in the CLI block", function () {
      // The fenced CLI block(s) must list each subcommand with a description.
      for (const sub of SUBCOMMANDS) {
        expect(readme, `README lists vh dataset ${sub}`).to.match(
          new RegExp(`vh dataset ${sub.replace(/[-]/g, "\\$&")}[^\\n]*`)
        );
      }
    });

    it("advertises the offline / no key / no network property for the dataset commands", function () {
      // Pull the section text from the heading to the next top-level/section heading.
      const start = readme.indexOf("### Dataset provenance (DataLedger)");
      expect(start, "DataLedger section present").to.be.greaterThan(-1);
      const rest = readme.slice(start);
      const end = rest.indexOf("\n## ");
      const section = end === -1 ? rest : rest.slice(0, end);
      const sectionLower = section.toLowerCase();
      expect(sectionLower).to.include("offline");
      expect(sectionLower).to.match(/no key/);
      expect(sectionLower).to.match(/no network|no net\b/);
    });

    it("links to docs/DATALEDGER.md from the section", function () {
      const start = readme.indexOf("### Dataset provenance (DataLedger)");
      const section = readme.slice(start);
      expect(section).to.include("docs/DATALEDGER.md");
    });

    it("reiterates the no-overclaim caveats (not a timestamp; untrusted hints) in the README section", function () {
      const start = readme.indexOf("### Dataset provenance (DataLedger)");
      const rest = readme.slice(start);
      const end = rest.indexOf("\n## ");
      const section = (end === -1 ? rest : rest.slice(0, end)).toLowerCase();
      expect(section).to.match(/not a timestamp/);
      expect(section).to.include("unaltered since");
      expect(section).to.include("untrusted");
      expect(section).to.include("self-asserted");
    });
  });

  describe("README CLI quick-list mentions DataLedger dataset commands with no-key/no-network", function () {
    it("lists the dataset commands in the top CLI fenced block", function () {
      const block = readme.split("```").find((b) => b.includes("vh hash") && b.includes("vh verify"));
      expect(block, "top CLI fenced block").to.be.a("string");
      expect(block).to.match(/vh dataset build[^\n]*#[^\n]+/);
      expect(block).to.match(/vh dataset verify-proof[^\n]*#[^\n]+/);
    });
  });

  describe("README Docs index links DataLedger", function () {
    it("references docs/DATALEDGER.md in the ## Docs list", function () {
      const docsIdx = readme.indexOf("## Docs");
      expect(docsIdx, "## Docs section").to.be.greaterThan(-1);
      expect(readme.slice(docsIdx)).to.include("docs/DATALEDGER.md");
    });
  });
});

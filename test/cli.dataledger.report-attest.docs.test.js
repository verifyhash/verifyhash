const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// T-15.3 docs-rot guard for the DataLedger evidence report + UNSIGNED attestation payload.
//
// Pure (no chain, no fixtures): asserts docs/DATALEDGER.md + README.md document `vh dataset report`
// (T-15.1) and `vh dataset attest` (T-15.2) the way the code actually behaves, so the buyer-facing
// prose can't silently drift from cli/dataset.js. Load-bearing properties under test:
//   * docs/DATALEDGER.md has an "evidence report" section documenting what `vh dataset report`
//     consolidates, deterministic Markdown vs --json, the optional --verify status section, and the
//     EU-AI-Act / due-diligence "what the reviewer files" framing,
//   * docs/DATALEDGER.md has an "Unsigned attestation payload" section documenting `vh dataset attest`:
//     the canonical byte-deterministic payload, what it commits to (root/fileCount/manifestDigest), that
//     it is UNSIGNED, and that attaching a real signature/timestamp is the human-owned trust-root
//     (cross-linking STRATEGY.md P-3, never overclaiming past it),
//   * the command table and the auditor mapping add `report` and `attest` rows,
//   * README's `### Dataset provenance (DataLedger)` section lists `vh dataset report` and
//     `vh dataset attest` with the "offline, no key, no network" property,
//   * the caveats reuse the existing in-band TRUST wording so they stay consistent.
// ---------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// Importing dataset.js pins the in-band caveat wording this guard reuses AND fails loudly if the module
// (or the report/attest runners/caveats) is ever removed — the docs guard would otherwise be hollow.
const dataset = require("../cli/dataset");

describe("T-15.3 docs: DataLedger report + attest documented (docs/DATALEDGER.md + README)", function () {
  let doc, docLower, readme;

  before(function () {
    doc = read("docs/DATALEDGER.md");
    docLower = doc.toLowerCase();
    readme = read("README.md");
  });

  it("dataset.js still exports the report/attest surface + caveat wording this guard pins against", function () {
    // Tripwire: if cli/dataset.js drops these, the assertions below would be meaningless.
    expect(dataset.runDatasetReport, "runDatasetReport export").to.be.a("function");
    expect(dataset.runDatasetAttest, "runDatasetAttest export").to.be.a("function");
    expect(dataset.TRUST_NOTE, "TRUST_NOTE export").to.be.a("string");
    expect(dataset.ATTESTATION_TRUST_NOTE, "ATTESTATION_TRUST_NOTE export").to.be.a("string");
  });

  describe("docs/DATALEDGER.md: 'The evidence report' section documents `vh dataset report`", function () {
    it("has an evidence-report section heading", function () {
      expect(docLower).to.match(/##+\s*the evidence report/);
    });

    it("documents WHAT the report consolidates (identity + roll-up + caveats + optional verify verdict)", function () {
      // Section text from the heading to the next section heading.
      const start = doc.toLowerCase().indexOf("## the evidence report");
      expect(start, "evidence-report section present").to.be.greaterThan(-1);
      const rest = doc.slice(start);
      const end = rest.indexOf("\n## ", 3);
      const section = (end === -1 ? rest : rest.slice(0, end)).toLowerCase();
      expect(section).to.match(/identity/);
      expect(section).to.match(/roll-up/);
      expect(section).to.match(/trust posture|trust caveat|caveat/);
      // Reuses the verify verdict vocabulary.
      expect(section).to.match(/match\/mismatch|verdict/);
    });

    it("documents deterministic Markdown vs --json", function () {
      expect(docLower).to.match(/deterministic markdown|byte-identical markdown/);
      expect(doc).to.include("--json");
    });

    it("documents the optional --verify status section", function () {
      expect(doc).to.include("--verify");
      // The mismatch exit code so a pipeline can gate on a live-tree drift.
      expect(docLower).to.match(/exit 3|exit `3`/);
    });

    it("uses the EU-AI-Act / due-diligence 'what the reviewer files' framing", function () {
      const start = doc.toLowerCase().indexOf("## the evidence report");
      const rest = doc.slice(start);
      const end = rest.indexOf("\n## ", 3);
      const section = (end === -1 ? rest : rest.slice(0, end)).toLowerCase();
      expect(section).to.match(/eu-ai-act|eu ai act/);
      expect(section).to.match(/due[- ]diligence/);
      expect(section).to.match(/files|deliverable/);
    });

    it("shows a worked `vh dataset report` invocation", function () {
      expect(doc).to.include("vh dataset report");
    });
  });

  describe("docs/DATALEDGER.md: 'Unsigned attestation payload' section documents `vh dataset attest`", function () {
    let section;
    before(function () {
      const start = docLower.indexOf("## unsigned attestation payload");
      expect(start, "unsigned-attestation section present").to.be.greaterThan(-1);
      const rest = doc.slice(start);
      const end = rest.indexOf("\n## ", 3);
      section = end === -1 ? rest : rest.slice(0, end);
    });

    it("documents the canonical, byte-deterministic payload", function () {
      const s = section.toLowerCase();
      expect(s).to.match(/canonical/);
      expect(s).to.match(/byte-deterministic|deterministic|identical bytes|byte-identical/);
    });

    it("documents what it commits to: root / fileCount / manifestDigest", function () {
      expect(section).to.include("root");
      expect(section).to.include("fileCount");
      expect(section).to.include("manifestDigest");
    });

    it("is explicit the payload is UNSIGNED (signed:false, signature:null)", function () {
      expect(section).to.include("UNSIGNED");
      expect(section.toLowerCase()).to.match(/signed.*false|`signed: false`|signed: false/);
      expect(section.toLowerCase()).to.match(/signature.*null|`signature: null`/);
    });

    it("states attaching a real signature/timestamp is the human-owned trust-root, cross-linking P-3", function () {
      const s = section.toLowerCase();
      expect(s).to.match(/human-owned trust-root|human signing|signing\/timestamp trust-root|trust-root/);
      expect(s).to.include("needs-human");
      expect(section).to.include("P-3");
      expect(section).to.include("STRATEGY.md");
    });

    it("does NOT overclaim past P-3 (still not 'unaltered since date T')", function () {
      expect(section.toLowerCase()).to.include("unaltered since");
    });

    it("shows a worked `vh dataset attest` invocation", function () {
      expect(doc).to.include("vh dataset attest");
    });
  });

  describe("docs/DATALEDGER.md command table + auditor mapping add report and attest rows", function () {
    it("the command table lists `vh dataset report` and `vh dataset attest`", function () {
      // Table rows are pipe-delimited; ensure each command appears inside a table row.
      const rows = doc.split("\n").filter((l) => l.trim().startsWith("|"));
      const joined = rows.join("\n");
      expect(joined).to.include("vh dataset report");
      expect(joined).to.include("vh dataset attest");
    });

    it("the auditor / EU-AI-Act mapping maps report and attest to the evidence they produce", function () {
      const start = docLower.indexOf("what an auditor");
      expect(start, "auditor mapping section present").to.be.greaterThan(-1);
      const mapping = doc.slice(start);
      expect(mapping).to.include("vh dataset report");
      expect(mapping).to.include("vh dataset attest");
    });
  });

  describe("docs/DATALEDGER.md reuses the in-band attestation caveat wording (no drift)", function () {
    it("carries the same load-bearing 'unaltered since' phrasing as the in-band notes", function () {
      // The code's ATTESTATION_TRUST_NOTE and the doc both must refuse the time-anchored claim.
      expect(dataset.ATTESTATION_TRUST_NOTE.toLowerCase()).to.include("unaltered since");
      expect(docLower).to.include("unaltered since");
      // The code's note also points at P-3 / the human trust-root; so must the doc.
      expect(dataset.ATTESTATION_TRUST_NOTE).to.include("P-3");
      expect(doc).to.include("P-3");
    });
  });

  describe("README's Dataset provenance section lists report + attest with offline/no-key/no-network", function () {
    let section;
    before(function () {
      const start = readme.indexOf("### Dataset provenance (DataLedger)");
      expect(start, "DataLedger section present").to.be.greaterThan(-1);
      const rest = readme.slice(start);
      const end = rest.indexOf("\n## ");
      section = end === -1 ? rest : rest.slice(0, end);
    });

    it("lists `vh dataset report` and `vh dataset attest` in the section", function () {
      expect(section).to.match(/vh dataset report[^\n]+/);
      expect(section).to.match(/vh dataset attest[^\n]+/);
    });

    it("advertises offline / no key / no network for report + attest", function () {
      const s = section.toLowerCase();
      expect(s).to.include("offline");
      expect(s).to.match(/no key/);
      expect(s).to.match(/no network|no net\b/);
    });

    it("cross-links the UNSIGNED attestation to the human trust-root (P-3)", function () {
      expect(section).to.include("UNSIGNED");
      expect(section).to.include("P-3");
      expect(section).to.include("STRATEGY.md");
    });
  });

  describe("README top CLI quick-list mentions report + attest", function () {
    it("lists report and attest in the top CLI fenced block", function () {
      const block = readme.split("```").find((b) => b.includes("vh hash") && b.includes("vh dataset build"));
      expect(block, "top CLI fenced block").to.be.a("string");
      expect(block).to.match(/vh dataset report[^\n]*#[^\n]+/);
      expect(block).to.match(/vh dataset attest[^\n]*#[^\n]+/);
    });
  });
});

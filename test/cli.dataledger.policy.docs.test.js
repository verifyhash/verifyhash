const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// T-16.3 docs-rot guard for the DataLedger license-policy gate.
//
// Pure (no chain, no fixtures): asserts docs/DATALEDGER.md + README.md document `vh dataset check`
// (T-16.1) and `vh dataset report --policy` (T-16.2) the way the code actually behaves, so the
// buyer-facing prose can't silently drift from cli/dataset.js. Load-bearing properties under test:
//   * docs/DATALEDGER.md has a "Policy compliance gate" section documenting the policy file schema
//     (every field + match semantics + the no-rules case), `vh dataset check` (PASS/FAIL, the 0/3 exit
//     contract a CI job gates on, the violating-file output, --json), and the `vh dataset report
//     --policy` embedding, with the EU-AI-Act / due-diligence framing and a worked example,
//   * the command table and the auditor mapping add a `check` row and the `report --policy` flag,
//   * README's `### Dataset provenance (DataLedger)` section lists `vh dataset check` with the
//     "offline, no key, no network, CI-gateable exit code" property,
//   * the section LEADS with / reuses the existing dataset TRUST_NOTE wording so the UNTRUSTED-hints
//     caveat (a PASS attests the hints satisfy the policy, NOT that the licenses are genuinely correct)
//     stays consistent with the code.
// ---------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// Importing dataset.js pins the in-band caveat wording this guard reuses AND fails loudly if the module
// (or the check runner / policy surface) is ever removed — the docs guard would otherwise be hollow.
const dataset = require("../cli/dataset");

describe("T-16.3 docs: DataLedger policy gate documented (docs/DATALEDGER.md + README)", function () {
  let doc, docLower, readme;

  before(function () {
    doc = read("docs/DATALEDGER.md");
    docLower = doc.toLowerCase();
    readme = read("README.md");
  });

  it("dataset.js still exports the policy surface + caveat wording this guard pins against", function () {
    // Tripwire: if cli/dataset.js drops these, the assertions below would be meaningless.
    expect(dataset.runDatasetCheck, "runDatasetCheck export").to.be.a("function");
    expect(dataset.evaluatePolicy, "evaluatePolicy export").to.be.a("function");
    expect(dataset.readPolicy, "readPolicy export").to.be.a("function");
    expect(dataset.POLICY_KIND, "POLICY_KIND export").to.be.a("string");
    expect(dataset.POLICY_RULE, "POLICY_RULE export").to.be.an("object");
    expect(dataset.POLICY_VERDICT, "POLICY_VERDICT export").to.be.an("object");
    expect(dataset.TRUST_NOTE, "TRUST_NOTE export").to.be.a("string");
  });

  describe("docs/DATALEDGER.md: 'Policy compliance gate' section", function () {
    let section, sectionLower;
    before(function () {
      const start = docLower.indexOf("## policy compliance gate");
      expect(start, "policy-compliance-gate section present").to.be.greaterThan(-1);
      const rest = doc.slice(start);
      const end = rest.indexOf("\n## ", 3);
      section = end === -1 ? rest : rest.slice(0, end);
      sectionLower = section.toLowerCase();
    });

    it("LEADS with / reuses the UNTRUSTED-hints caveat: a PASS is about self-asserted hints, NOT real licenses", function () {
      expect(section).to.include("UNTRUSTED");
      expect(sectionLower).to.match(/self-asserted/);
      expect(sectionLower).to.match(/not that the licenses are genuinely correct/);
      // The standing in-band caveat sentence must appear verbatim so it can never drift from the code.
      expect(doc).to.include(
        "Per-file `hints` (source/license) are UNTRUSTED, self-asserted metadata — they are NOT bound into the root and prove nothing."
      );
    });

    it("documents the policy file schema: every field", function () {
      // The two fixed identity fields and all five optional rule fields, plus the required kind value.
      expect(section).to.include("verifyhash.dataset-policy");
      expect(section).to.include("schemaVersion");
      for (const f of ["allowLicenses", "denyLicenses", "allowSources", "denySources", "requireLicense"]) {
        expect(section, `policy field ${f}`).to.include(f);
      }
      // The exported rule identifiers a consumer gates on must match the documented field names.
      for (const r of Object.values(dataset.POLICY_RULE)) {
        expect(section, `documented rule id ${r}`).to.include(r);
      }
      // The exact kind constant the strict reader enforces must be the one documented.
      expect(section).to.include(dataset.POLICY_KIND);
    });

    it("documents the match semantics (case-sensitive exact string match) and the no-hint sentinel", function () {
      expect(sectionLower).to.match(/case-sensitive exact string/);
      expect(section).to.include("(no license hint)");
    });

    it("documents the no-rules case (a policy with no rules trivially PASSes)", function () {
      expect(sectionLower).to.match(/no rules/);
      expect(sectionLower).to.match(/trivially pass/);
    });

    it("documents `vh dataset check` PASS/FAIL", function () {
      expect(section).to.include("vh dataset check");
      expect(section).to.include("PASS");
      expect(section).to.include("FAIL");
    });

    it("documents the 0/3 exit contract a CI job gates on", function () {
      expect(sectionLower).to.match(/exit/);
      expect(section).to.match(/`0`/);
      expect(section).to.match(/`3`/);
      // The framing: a CI job gates on the exit code.
      expect(sectionLower).to.match(/ci/);
    });

    it("documents the violating-file output (relPath / rule / value)", function () {
      expect(sectionLower).to.match(/relpath/);
      expect(sectionLower).to.match(/rule/);
      expect(sectionLower).to.match(/value|offending hint/);
    });

    it("documents --json", function () {
      expect(section).to.include("--json");
      // The documented machine shape must name the actual keys evaluatePolicy returns.
      expect(section).to.include("violations");
      expect(section).to.include("rulesEvaluated");
    });

    it("documents the `vh dataset report --policy` embedding (same evaluator, combined CI gate)", function () {
      expect(section).to.include("vh dataset report");
      expect(section).to.include("--policy");
      expect(sectionLower).to.match(/policy compliance/);
      // The combined-exit semantics: 3 if EITHER verify MISMATCH or policy FAIL.
      expect(sectionLower).to.match(/either/);
    });

    it("uses the EU-AI-Act / due-diligence 'control your pipeline runs / your auditor files' framing", function () {
      expect(sectionLower).to.match(/eu-ai-act|eu ai act/);
      expect(sectionLower).to.match(/due[- ]diligence/);
      expect(sectionLower).to.match(/control your pipeline runs|auditor files|compliance control/);
    });

    it("shows a worked example: build with hints -> write a policy -> check -> embed in a report", function () {
      expect(section).to.include("vh dataset build");
      expect(section).to.match(/--hints/);
      expect(section).to.include("vh dataset check");
      expect(section).to.include("vh dataset report");
      // A literal policy document is shown (the kind + a rule).
      expect(section).to.include("verifyhash.dataset-policy");
    });
  });

  describe("docs/DATALEDGER.md command table + auditor mapping add check and the report --policy flag", function () {
    it("the command table lists `vh dataset check` and shows `--policy` on `vh dataset report`", function () {
      const rows = doc.split("\n").filter((l) => l.trim().startsWith("|"));
      const joined = rows.join("\n");
      expect(joined).to.include("vh dataset check");
      // The report row gains the --policy flag.
      const reportRow = rows.find((l) => l.includes("vh dataset report"));
      expect(reportRow, "report table row").to.be.a("string");
      expect(reportRow).to.include("--policy");
    });

    it("the auditor / EU-AI-Act mapping maps `vh dataset check` to the evidence it produces", function () {
      const start = docLower.indexOf("what an auditor");
      expect(start, "auditor mapping section present").to.be.greaterThan(-1);
      const mapping = doc.slice(start);
      expect(mapping).to.include("vh dataset check");
    });
  });

  describe("README's Dataset provenance section lists check with the CI-gateable / offline property", function () {
    let section, sectionLower;
    before(function () {
      const start = readme.indexOf("### Dataset provenance (DataLedger)");
      expect(start, "DataLedger section present").to.be.greaterThan(-1);
      const rest = readme.slice(start);
      const end = rest.indexOf("\n## ");
      section = end === -1 ? rest : rest.slice(0, end);
      sectionLower = section.toLowerCase();
    });

    it("lists `vh dataset check` in the section", function () {
      expect(section).to.match(/vh dataset check[^\n]+/);
    });

    it("advertises offline / no key / no network and a CI-gateable exit code for check", function () {
      expect(sectionLower).to.include("offline");
      expect(sectionLower).to.match(/no key/);
      expect(sectionLower).to.match(/no network|no net\b/);
      expect(sectionLower).to.match(/ci-gateable|ci-gate|gate/);
      expect(sectionLower).to.match(/exit code|exit/);
    });

    it("keeps the UNTRUSTED-hints caveat consistent (a PASS is about hints, not real licenses)", function () {
      expect(section).to.include("UNTRUSTED");
      expect(sectionLower).to.match(/not that the licenses are genuinely correct|self-asserted/);
    });
  });

  describe("README top CLI quick-list mentions check", function () {
    it("lists check in the top CLI fenced block", function () {
      const block = readme.split("```").find((b) => b.includes("vh hash") && b.includes("vh dataset build"));
      expect(block, "top CLI fenced block").to.be.a("string");
      expect(block).to.match(/vh dataset check[^\n]*#[^\n]+/);
    });
  });
});

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// T-23.3 docs-rot guard for the TrustLedger per-state policy layer.
//
// Pure (no chain, no CLI run): asserts docs/TRUSTLEDGER.md + STRATEGY.md document the policy layer
// (T-23.1/T-23.2) the way the code actually behaves, so the buyer-/handoff-facing prose can't silently
// drift from trustledger/policy.js + the bundled fixtures. Load-bearing properties under test:
//   * docs/TRUSTLEDGER.md has a "## The per-state policy layer" section documenting the policy file
//     schema (every field, with citations/labels called out), the --state/--policy selection (and that
//     no flag is byte-for-byte the baseline), how PASS now depends on the selected policy, and a worked
//     example where the SAME files flip PASS->FAIL under a state override,
//   * the section states plainly the SHIPPED policies are DRAFTS / NOT legal advice and that a
//     CPA/counsel must review + SIGN the per-state mapping (P-5 #1/#2),
//   * the Usage options block gains --state and --policy,
//   * STRATEGY.md's P-5 item #2 is SHARPENED to the fill-in-the-table handoff ("the engine already
//     consumes it"), not "replace/rewrite the engine's classification".
// The guard imports trustledger/policy.js so it fails loudly if the module (or its schema surface) is
// ever removed — an otherwise-hollow docs guard.
// ---------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

const policy = require("../trustledger/policy");

describe("T-23.3 docs: TrustLedger per-state policy layer documented (docs/TRUSTLEDGER.md + STRATEGY.md)", function () {
  let doc, docLower, strategy;

  before(function () {
    doc = read("docs/TRUSTLEDGER.md");
    docLower = doc.toLowerCase();
    strategy = read("STRATEGY.md");
  });

  it("trustledger/policy.js still exports the schema surface this guard pins against", function () {
    // Tripwire: if the policy module drops these, the assertions below would be meaningless.
    expect(policy.SCHEMA_VERSION, "SCHEMA_VERSION").to.be.a("number");
    expect(policy.readPolicy, "readPolicy").to.be.a("function");
    expect(policy.validatePolicy, "validatePolicy").to.be.a("function");
    expect(policy.applyPolicy, "applyPolicy").to.be.a("function");
    expect(policy.resolveState, "resolveState").to.be.a("function");
    expect(policy.bundledPolicies, "bundledPolicies").to.be.a("function");
    expect(policy.EXCEPTION_TYPES, "EXCEPTION_TYPES").to.be.an.instanceof(Set);
  });

  describe("docs/TRUSTLEDGER.md: '## The per-state policy layer' section", function () {
    let section, sectionLower;
    before(function () {
      const start = docLower.indexOf("## the per-state policy layer");
      expect(start, "policy-layer section present").to.be.greaterThan(-1);
      const rest = doc.slice(start);
      const end = rest.indexOf("\n## ", 3);
      section = end === -1 ? rest : rest.slice(0, end);
      sectionLower = section.toLowerCase();
    });

    it("frames severities as state-dependent, with the baseline a DEFAULT a policy overrides", function () {
      expect(sectionLower).to.match(/state.?dependent|state's trust-account statute|state's trust account statute/);
      expect(sectionLower).to.match(/override|overrides/);
      expect(sectionLower).to.match(/data, not code/);
    });

    it("documents the policy file schema: EVERY field", function () {
      for (const f of ["schemaVersion", "state", "severities", "citations", "toleranceCents"]) {
        expect(section, `documented field ${f}`).to.include(f);
      }
      // The exact supported schema version the strict reader enforces must be the documented one.
      expect(section, "documented schemaVersion value").to.include(String(policy.SCHEMA_VERSION));
    });

    it("calls out which fields are CITATIONS / LABELS vs mechanical", function () {
      expect(sectionLower).to.match(/citation/);
      expect(sectionLower).to.match(/label/);
      // citations may only cite a type that is also overridden (the misleading-citation rule).
      expect(sectionLower).to.match(/only.*override|override.*only/);
    });

    it("lists the legal exception types derived from the engine's EXCEPTION enum", function () {
      // Pin EVERY allowed severities/citations key against the live module set, so a new exception
      // type (or a renamed one) trips the guard rather than silently de-documenting the schema.
      for (const t of policy.EXCEPTION_TYPES) {
        expect(section, `documented exception type ${t}`).to.include(t);
      }
    });

    it("documents toleranceCents precedence over the CLI/default tolerance", function () {
      expect(sectionLower).to.match(/precedence|takes precedence/);
      expect(sectionLower).to.match(/tolerancecents/);
    });

    it("documents --state vs --policy selection AND that NO flag is byte-for-byte the baseline", function () {
      expect(section).to.include("--state");
      expect(section).to.include("--policy");
      expect(sectionLower).to.match(/mutually exclusive/);
      expect(sectionLower).to.match(/byte-for-byte/);
      // unknown --state and a bad --policy file are usage errors (exit 2).
      expect(section).to.match(/exit `?2`?/);
    });

    it("lists the actual bundled policies by code AND state label (no drift from the fixtures)", function () {
      // Resolve the live fixtures and assert the doc names each code and its state label.
      const bundled = policy.bundledPolicies();
      expect(bundled.length, "at least one bundled policy").to.be.greaterThan(0);
      for (const b of bundled) {
        expect(section, `documented bundled code ${b.code}`).to.include(b.code);
        expect(section, `documented bundled state label ${b.policy.state}`).to.include(b.policy.state);
      }
    });

    it("documents that PASS now DEPENDS on the selected policy (a flip is possible)", function () {
      expect(sectionLower).to.match(/pass.*depend|depend.*policy/);
      expect(sectionLower).to.match(/tiesout|ties out/);
      expect(sectionLower).to.match(/flip/);
    });

    it("shows a WORKED example: same files, baseline PASS -> state override FAIL (exit flips 0 -> 3)", function () {
      expect(section).to.include("vh trust reconcile");
      expect(section).to.include("PASS");
      expect(section).to.include("FAIL");
      expect(section).to.match(/exit=0/);
      expect(section).to.match(/exit=3/);
      // The override is named in the run and the same-input framing is explicit.
      expect(section).to.include("--state");
      expect(sectionLower).to.match(/same input|identical files|because the policy changed/);
    });

    it("states plainly the SHIPPED policies are DRAFTS / NOT legal advice and a CPA/counsel must SIGN", function () {
      expect(section).to.match(/DRAFT/);
      expect(sectionLower).to.match(/not legal advice/);
      expect(sectionLower).to.match(/cpa/);
      expect(sectionLower).to.match(/counsel/);
      expect(sectionLower).to.match(/sign/);
      // The honest posture: selecting a policy does not discharge the custodian's duty.
      expect(sectionLower).to.match(/custodian|responsible legal custodian/);
      expect(section).to.match(/P-5/);
    });
  });

  describe("docs/TRUSTLEDGER.md: usage + human-step sections updated", function () {
    it("the Usage options block lists --state and --policy", function () {
      const start = docLower.indexOf("## usage");
      expect(start, "usage section present").to.be.greaterThan(-1);
      const usage = doc.slice(start);
      expect(usage).to.match(/--state <code>/);
      expect(usage).to.match(/--policy <file>/);
    });

    it("the 'What stays a human step' bullet for P-5 #2 is the narrow fill-in-the-table handoff", function () {
      const start = docLower.indexOf("## what stays a human step");
      expect(start, "human-step section present").to.be.greaterThan(-1);
      const human = doc.slice(start);
      const humanLower = human.toLowerCase();
      // The narrowed task: fill in the per-state policy file, the engine already consumes it.
      expect(humanLower).to.match(/fill in/);
      expect(human).to.include("trustledger/fixtures/policy/");
      expect(humanLower).to.match(/already consumes|engine already/);
      expect(humanLower).to.match(/no engine change|no engine-change/);
    });
  });

  describe("STRATEGY.md: P-5 item #2 SHARPENED to the fill-in-the-table handoff", function () {
    let item2;
    before(function () {
      // Isolate P-5 item #2 from "2." to the next numbered "3." item.
      const p5 = strategy.indexOf("P-5 (2026-06-24)");
      expect(p5, "P-5 proposal present").to.be.greaterThan(-1);
      const tail = strategy.slice(p5);
      const start = tail.indexOf("\n  2. ");
      expect(start, "P-5 item 2 present").to.be.greaterThan(-1);
      const rest = tail.slice(start);
      const end = rest.indexOf("\n  3. ");
      item2 = (end === -1 ? rest : rest.slice(0, end)).toLowerCase();
    });

    it("describes the NOW-NARROW human task (fill in + counsel SIGN the per-state TABLE)", function () {
      expect(item2).to.match(/fill in/);
      expect(item2).to.match(/trustledger\/fixtures\/policy\/<state>\.json/);
      expect(item2).to.match(/sign/);
      expect(item2).to.match(/cpa\/counsel|cpa\b.*counsel|counsel/);
    });

    it("states the engine ALREADY consumes the policy (not a rewrite-the-engine task)", function () {
      expect(item2).to.match(/already consume|already make|already/);
      expect(item2).to.match(/no longer|no engine change|no engine-change/);
      // Names the shipped mechanism so the claim is anchored to real code.
      expect(item2).to.match(/policy\.js|--state|--policy/);
    });

    it("points at the bundled DRAFT skeletons + the doc", function () {
      expect(item2).to.match(/baseline\.json/);
      expect(item2).to.match(/ca-example\.json/);
      expect(item2).to.match(/docs\/trustledger\.md/);
    });
  });
});

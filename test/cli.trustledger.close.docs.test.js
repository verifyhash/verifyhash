"use strict";

// ---------------------------------------------------------------------------
// T-24.3 docs-rot guard for the TrustLedger period-close continuity layer.
//
// Pure (no chain, no CLI run): asserts docs/TRUSTLEDGER.md + STRATEGY.md document the period-close
// continuity layer (T-24.1/T-24.2) the way the code actually behaves, so the buyer-/handoff-facing
// prose can't silently drift from trustledger/close.js + the --prior-close/--emit-close CLI wiring.
// Load-bearing properties under test:
//   * docs/TRUSTLEDGER.md has a "## Period-close continuity" section documenting the close-artifact
//     schema (EVERY field, with which are hints/digests called out), the --prior-close/--emit-close
//     flow, how the continuity check + CONTINUITY_BREAK work, that a close is an UNTRUSTED hint
//     (re-derive; not signed/timestamped), and a worked month-1 -> month-2 -> break example,
//   * the section states plainly the artifact is a CONVENIENCE for chaining periods, NOT a legal record,
//   * the Usage options block gains --prior-close and --emit-close,
//   * STRATEGY.md's P-5 item #3 is SHARPENED to the concrete two-month design-partner script
//     (--emit-close month1.json, then --prior-close month1.json; "that two-month run IS the WTP
//     validation"), not the vague "engage partners and run their files".
// The guard imports trustledger/close.js so it fails loudly if the module (or its surface) is ever
// removed — an otherwise-hollow docs guard. It also pins the documented schemaVersion + the actual
// close field names against the live module, so a schema change trips the guard.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

const close = require("../trustledger/close");

describe("T-24.3 docs: TrustLedger period-close continuity documented (docs/TRUSTLEDGER.md + STRATEGY.md)", function () {
  let doc, docLower, strategy;

  before(function () {
    doc = read("docs/TRUSTLEDGER.md");
    docLower = doc.toLowerCase();
    strategy = read("STRATEGY.md");
  });

  it("trustledger/close.js still exports the surface this guard pins against", function () {
    // Tripwire: if the close module drops these, the assertions below would be meaningless.
    expect(close.SCHEMA_VERSION, "SCHEMA_VERSION").to.be.a("string");
    expect(close.buildClose, "buildClose").to.be.a("function");
    expect(close.readClose, "readClose").to.be.a("function");
    expect(close.validateClose, "validateClose").to.be.a("function");
    expect(close.checkContinuity, "checkContinuity").to.be.a("function");
    expect(close.CloseError, "CloseError").to.be.a("function");
  });

  describe("docs/TRUSTLEDGER.md: '## Period-close continuity' section", function () {
    let section, sectionLower;
    before(function () {
      const start = docLower.indexOf("## period-close continuity");
      expect(start, "period-close continuity section present").to.be.greaterThan(-1);
      const rest = doc.slice(start);
      // Stop at the next top-level "## " heading (skip the section's own "## " at index 0).
      const end = rest.indexOf("\n## ", 3);
      section = end === -1 ? rest : rest.slice(0, end);
      sectionLower = section.toLowerCase();
    });

    it("frames the roll-forward: each month's ending is next month's opening, exact", function () {
      expect(sectionLower).to.match(/roll-forward|roll forward/);
      expect(sectionLower).to.match(/monthly|month/);
      // The footgun the layer guards: a skipped/edited/re-keyed period / fat-fingered opening.
      expect(sectionLower).to.match(/skipped|edited|re-keyed|fat-?fingered/);
    });

    it("documents the close-artifact schema: EVERY field", function () {
      // A close built from a real model exposes the authoritative field set; pin the doc against it.
      const sample = close.buildClose({
        schema: "trustledger.reconciliation-packet/v1",
        reportDate: "2026-05-31",
        period: "2026-05",
        opening: { bank: 0, book: 0 },
        balances: { bank: 330000, book: 300000, subledger: 300000, adjustedBank: 0, reconciled: null },
        tiesOut: true,
        pass: true,
        inputs: { bankRecords: 1, bookRecords: 1, rentrollRecords: 1 },
      });
      for (const f of Object.keys(sample)) {
        expect(section, `documented close field ${f}`).to.include(f);
      }
      // The exact schemaVersion string the strict reader enforces must be the documented one.
      expect(section, "documented schemaVersion value").to.include(close.SCHEMA_VERSION);
      // The input sub-fields are named too.
      for (const k of ["bankRecords", "bookRecords", "rentrollRecords"]) {
        expect(section, `documented inputs.${k}`).to.include(k);
      }
    });

    it("calls out which fields are HINTS vs the DIGEST vs mechanical", function () {
      expect(sectionLower).to.match(/hint/);
      expect(sectionLower).to.match(/digest/);
      expect(sectionLower).to.match(/sha-256/);
      expect(sectionLower).to.match(/mechanical/);
      // Integer cents, no floats, named error on a non-integer balance.
      expect(sectionLower).to.match(/integer cents/);
      // The digest is NOT a signature / NOT a proof of the source files.
      expect(sectionLower).to.match(/not a signature|not.*signature/);
    });

    it("documents the --prior-close / --emit-close flow", function () {
      expect(section).to.include("--prior-close");
      expect(section).to.include("--emit-close");
      // Seeds opening from the prior ending.
      expect(sectionLower).to.match(/seed/);
      // A malformed/missing prior-close is a USAGE error (exit 2), not IO.
      expect(section).to.match(/exit `?2`?|usage error/);
      // An explicit override is honored-and-noted.
      expect(sectionLower).to.match(/override|overrides/);
      expect(sectionLower).to.match(/noted|note:/);
    });

    it("documents the continuity check + CONTINUITY_BREAK (penny-exact, default ERROR, FAILs gate)", function () {
      expect(sectionLower).to.match(/continuity check/);
      expect(section).to.match(/continuity_break|CONTINUITY_BREAK/);
      expect(sectionLower).to.match(/penny-exact|zero tolerance|penny exact/);
      // Default severity error -> FAILs the gate (exit 3).
      expect(sectionLower).to.match(/error/);
      expect(section).to.match(/exit `?3`?/);
      // A policy MAY re-grade it (consistent with the policy layer).
      expect(sectionLower).to.match(/re-grade|regrade|re-graded|warning/);
    });

    it("states the close is an UNTRUSTED HINT: re-derived, NOT signed, NOT timestamped", function () {
      expect(sectionLower).to.match(/untrusted/);
      expect(sectionLower).to.match(/re-derive|re-derived|recompute|recomputed|freshly recomputed/);
      expect(sectionLower).to.match(/not signed/);
      // "NOT signed and NOT\ntimestamped" may wrap, so assert both halves independently.
      expect(sectionLower).to.match(/not\b[\s\S]{0,40}timestamp/);
      // The authoritative numbers are the fresh reconciliation, not the close.
      expect(sectionLower).to.match(/authoritative/);
      // Custodian / CPA posture preserved.
      expect(sectionLower).to.match(/custodian/);
    });

    it("states PLAINLY the artifact is a CONVENIENCE for chaining periods, NOT a legal record", function () {
      expect(sectionLower).to.match(/convenience/);
      expect(sectionLower).to.match(/not a legal record/);
      expect(sectionLower).to.match(/chain/);
    });

    it("shows the WORKED example: month 1 --emit-close, month 2 --prior-close, then a BREAK FAILs", function () {
      expect(section).to.include("--emit-close");
      expect(section).to.include("--prior-close");
      expect(section).to.include("month1.json");
      // Month 1 emits, month 2 holds, then a break.
      expect(section).to.match(/wrote close/);
      expect(section).to.include("PASS");
      expect(section).to.include("FAIL");
      expect(section).to.match(/exit=0/);
      expect(section).to.match(/exit=3/);
      // The break is named with its gap + the prior period.
      expect(section).to.match(/continuity_break|CONTINUITY_BREAK/);
      expect(sectionLower).to.match(/break a balance|broke|gap/);
    });

    it("documents ADDITIVITY: no close flags == byte-for-byte prior behaviour", function () {
      expect(sectionLower).to.match(/additiv/);
      expect(sectionLower).to.match(/byte-for-byte/);
      expect(sectionLower).to.match(/neither/);
    });
  });

  describe("docs/TRUSTLEDGER.md: usage + human-step sections updated", function () {
    it("the Usage options block lists --prior-close and --emit-close", function () {
      const start = docLower.indexOf("## usage");
      expect(start, "usage section present").to.be.greaterThan(-1);
      const usage = doc.slice(start);
      expect(usage).to.match(/--prior-close <file>/);
      expect(usage).to.match(/--emit-close <file>/);
    });

    it("the 'What stays a human step' bullet for P-5 #3 is the two-month design-partner script", function () {
      const start = docLower.indexOf("## what stays a human step");
      expect(start, "human-step section present").to.be.greaterThan(-1);
      const human = doc.slice(start);
      const humanLower = human.toLowerCase();
      expect(human).to.include("--emit-close month1.json");
      expect(human).to.include("--prior-close month1.json");
      expect(humanLower).to.match(/both months/);
      expect(humanLower).to.match(/roll-forward is clean/);
      expect(humanLower).to.match(/willingness-to-pay|wtp/);
    });
  });

  describe("STRATEGY.md: P-5 item #3 SHARPENED to the two-month design-partner script", function () {
    let item3;
    before(function () {
      const p5 = strategy.indexOf("P-5 (2026-06-24)");
      expect(p5, "P-5 proposal present").to.be.greaterThan(-1);
      const tail = strategy.slice(p5);
      const start = tail.indexOf("\n  3. ");
      expect(start, "P-5 item 3 present").to.be.greaterThan(-1);
      const rest = tail.slice(start);
      // Item 3 runs to the next non-numbered paragraph (the "Hosting, …" wrap-up line).
      const end = rest.indexOf("\n  Hosting");
      item3 = (end === -1 ? rest : rest.slice(0, end)).toLowerCase();
    });

    it("describes the CONCRETE script: --emit-close month1.json then --prior-close month1.json", function () {
      expect(item3).to.include("--emit-close month1.json");
      expect(item3).to.include("--prior-close month1.json");
      expect(item3).to.match(/real month-1|real.*month.?1/);
      expect(item3).to.match(/month-2|month 2/);
    });

    it("states the three confirmations (tie out both months, clean roll-forward, exceptions read right)", function () {
      expect(item3).to.match(/both months/);
      expect(item3).to.match(/roll-forward is clean|roll-forward.*clean/);
      expect(item3).to.match(/continuity_break/);
      expect(item3).to.match(/exceptions read correctly|exceptions.*read/);
    });

    it("states that the two-month run IS the WTP validation, past month one", function () {
      expect(item3).to.match(/two-month run is the wtp validation|is the wtp validation/);
      expect(item3).to.match(/past month one|past month-one|month one/);
    });

    it("anchors the claim to the shipped mechanism + the doc (not a rewrite)", function () {
      expect(item3).to.match(/close\.js|--prior-close|--emit-close/);
      expect(item3).to.match(/no longer/);
      expect(item3).to.match(/docs\/trustledger\.md/);
      expect(item3).to.match(/no engine change|no engine-change/);
    });
  });
});

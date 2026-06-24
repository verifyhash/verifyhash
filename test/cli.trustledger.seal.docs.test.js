"use strict";

// ---------------------------------------------------------------------------
// T-26.3 docs-rot guard for the TrustLedger reconciliation SEAL (EPIC-26).
//
// Pure (no chain, no CLI run): asserts docs/TRUSTLEDGER.md + STRATEGY.md document the
// tamper-evident reconciliation seal (T-26.1/T-26.2) the way the code actually behaves, so the
// buyer-/handoff-facing prose can't silently drift from trustledger/seal.js + the
// --seal / verify-seal CLI wiring.
// Load-bearing properties under test:
//   * docs/TRUSTLEDGER.md has a "## Sealing the packet" section documenting the seal schema (EVERY
//     field; all UNTRUSTED transport — verification re-derives), the --seal write flow (requires
//     --out), the offline verify-seal flow + its 0/3/2/1 exit codes, the per-file
//     CHANGED/MISSING/UNEXPECTED semantics, the honest posture (tamper-evidence, NOT a trusted
//     timestamp — that rides P-3; the seal MAY be signed via the shared attestation envelope), and a
//     worked end-to-end example (reconcile --seal -> hand over -> verify-seal),
//   * the Usage block gains --seal and verify-seal,
//   * STRATEGY.md's P-5 item #1 is SHARPENED to note the deliverable is now a SEALED artifact an
//     examiner can independently verify byte-for-byte, with the "sealed on date T" trust-root = P-3.
// The guard imports trustledger/seal.js so it fails loudly if the module (or its surface) is ever
// removed. It also pins the documented kind/schemaVersion + the actual seal field names against the
// live module, so a schema change trips the guard.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

const seal = require("../trustledger/seal");
const report = require("../trustledger/report");

describe("T-26.3 docs: TrustLedger reconciliation seal documented (docs/TRUSTLEDGER.md + STRATEGY.md)", function () {
  let doc, docLower, strategy;

  before(function () {
    doc = read("docs/TRUSTLEDGER.md");
    docLower = doc.toLowerCase();
    strategy = read("STRATEGY.md");
  });

  it("trustledger/seal.js still exports the surface this guard pins against", function () {
    // Tripwire: if the seal module drops these, the assertions below would be meaningless.
    expect(seal.SEAL_KIND, "SEAL_KIND").to.be.a("string");
    expect(seal.SEAL_SCHEMA_VERSION, "SEAL_SCHEMA_VERSION").to.be.a("number");
    expect(seal.INPUT_ROLES, "INPUT_ROLES").to.be.an("array");
    expect(seal.buildSeal, "buildSeal").to.be.a("function");
    expect(seal.validateSeal, "validateSeal").to.be.a("function");
    expect(seal.readSeal, "readSeal").to.be.a("function");
    expect(seal.serializeSeal, "serializeSeal").to.be.a("function");
    expect(seal.verifySeal, "verifySeal").to.be.a("function");
    expect(seal.signSealWith, "signSealWith").to.be.a("function");
  });

  describe("docs/TRUSTLEDGER.md: '## Sealing the packet' section", function () {
    let section, sectionLower;
    before(function () {
      const start = docLower.indexOf("## sealing the packet");
      expect(start, "sealing-the-packet section present").to.be.greaterThan(-1);
      const rest = doc.slice(start);
      const end = rest.indexOf("\n## ", 3);
      section = end === -1 ? rest : rest.slice(0, end);
      sectionLower = section.toLowerCase();
    });

    it("frames the gap: an editable printout vs a byte-for-byte verifiable artifact", function () {
      expect(sectionLower).to.match(/tamper-evident|tamper evident/);
      expect(sectionLower).to.match(/byte-for-byte|byte for byte/);
      expect(sectionLower).to.match(/examiner/);
      expect(sectionLower).to.match(/printout/);
    });

    it("documents the seal schema: EVERY field", function () {
      // Build a real seal from minimal entries; pin the doc against its authoritative field set.
      const built = seal.buildSeal({
        files: {
          inputs: [
            { role: "bank", relPath: "bank.csv", bytes: Buffer.from("b") },
            { role: "book", relPath: "ledger.csv", bytes: Buffer.from("k") },
            { role: "rentroll", relPath: "rentroll.csv", bytes: Buffer.from("r") },
          ],
          outputs: [{ relPath: "packet.html", bytes: Buffer.from("h") }],
        },
        verdict: { pass: true, reportDate: "2026-05-31", period: "2026-05" },
      });
      for (const f of Object.keys(built)) {
        expect(section, `documented seal field ${f}`).to.include(f);
      }
      // The exact kind + schemaVersion the strict reader enforces must be the documented ones.
      expect(section, "documented kind value").to.include(seal.SEAL_KIND);
      expect(section, "documented schemaVersion").to.include(String(seal.SEAL_SCHEMA_VERSION));
      // The per-file entry sub-fields + the three input roles are named.
      for (const k of ["relPath", "contentHash", "leaf"]) {
        expect(section, `documented entry.${k}`).to.include(k);
      }
      for (const role of seal.INPUT_ROLES) {
        expect(section, `documented input role ${role}`).to.include(role);
      }
      // The verdict triple is named.
      for (const k of ["pass", "reportDate", "period"]) {
        expect(section, `documented verdict.${k}`).to.include(k);
      }
    });

    it("states ALL fields are UNTRUSTED transport — verification RE-DERIVES the root", function () {
      expect(sectionLower).to.match(/untrusted/);
      expect(sectionLower).to.match(/re-derive|re-derives|re-derived|recompute|recomputes/);
      // Reuses the provenance core verbatim — no new hashing scheme.
      expect(sectionLower).to.match(/no second hashing scheme|verbatim/);
      expect(section).to.match(/manifest\.js|cli\/core|hashEntries|pathLeaf/);
      // The verdict/role HEADER leaf is part of the SAME root.
      expect(sectionLower).to.match(/header/);
      expect(sectionLower).to.match(/role/);
    });

    it("documents the --seal write flow (requires --out, default name, after the packet)", function () {
      expect(section).to.include("--seal");
      expect(section).to.include("--out");
      expect(sectionLower).to.match(/requires --out|--seal\b.{0,40}requires/);
      // A default seal name is documented.
      expect(section).to.match(/reconciliation-.*-seal\.json|-seal\.json/);
    });

    it("documents the offline verify-seal flow + its 0/3/2/1 exit codes", function () {
      expect(section).to.include("verify-seal");
      expect(sectionLower).to.match(/offline/);
      expect(sectionLower).to.match(/read-only|read only|writes nothing/);
      expect(sectionLower).to.match(/no key|no network/);
      // ACCEPTED/REJECTED + the four exit codes.
      expect(section).to.include("ACCEPTED");
      expect(section).to.include("REJECTED");
      expect(section).to.match(/exit `?0`?|`0`/);
      expect(section).to.match(/`3`/);
      expect(section).to.match(/`2`/);
      expect(section).to.match(/`1`/);
    });

    it("documents the per-file CHANGED / MISSING / UNEXPECTED semantics (+ role swap)", function () {
      expect(section).to.include("MATCH");
      expect(section).to.include("CHANGED");
      expect(section).to.include("MISSING");
      expect(section).to.include("UNEXPECTED");
      // A role swap is localized.
      expect(sectionLower).to.match(/role/);
      expect(sectionLower).to.match(/swap|bank.?book/);
      // Localizes the exact file; no tampered file verifies clean.
      expect(sectionLower).to.match(/localize|localizes|localized/);
    });

    it("states the honest posture: tamper-evidence, NOT a trusted timestamp (rides P-3), NOT legal", function () {
      expect(sectionLower).to.match(/not a trusted timestamp|not.*timestamp/);
      expect(section).to.match(/P-3/);
      expect(sectionLower).to.match(/sealed on date t|sealed on date|when.*sealing/);
      // Custodian / CPA posture preserved.
      expect(sectionLower).to.match(/custodian/);
      expect(sectionLower).to.match(/cpa/);
      expect(sectionLower).to.match(/not a legal opinion|not.*legal/);
      // needs-human signing/timestamp.
      expect(sectionLower).to.match(/needs-human|human-owned|human owned/);
    });

    it("states the seal MAY be signed via the shared attestation envelope", function () {
      expect(sectionLower).to.match(/may be (wrapped|signed)|signed-attestation|attestation envelope/);
      expect(sectionLower).to.match(/who vouched|vouch/);
      // Still not a timestamp even when signed.
      expect(section).to.match(/P-3/);
    });

    it("shows the WORKED end-to-end example: reconcile --seal -> hand over -> verify-seal", function () {
      expect(section).to.match(/reconcile .*--seal|--out .*--seal/);
      expect(section).to.match(/wrote seal/);
      expect(section).to.include("verify-seal");
      // A clean ACCEPTED and a tampered REJECTED both shown.
      expect(section).to.match(/root matches:\s*yes/);
      expect(section).to.match(/root matches:\s*NO/);
      expect(section).to.match(/exit=0/);
      expect(section).to.match(/exit=3/);
      // Hand over the out dir + the seal.
      expect(sectionLower).to.match(/hand over|hand-over|handover/);
    });

    // REWORK (operability): the worked example used to invent output filenames
    // (`trust-reconciliation-<date>.html`, a single `.csv`) and an off-by-one match
    // count (5 / "4 matched, 1 changed") the engine NEVER produces. Pin the example to
    // GROUND TRUTH derived from the live engine so it can't drift back:
    //   * the documented packet basenames == report.packetFilenames(date), and
    //   * the headline match count == #inputs (3) + #outputs (3) == 6 (clean) / 5 + 1
    //     changed (one packet file tampered).
    // We derive the date from the example's own `wrote seal reconciliation-<date>-seal.json`
    // line so the test follows the doc rather than hard-coding a date.
    it("the worked example uses the engine's REAL packet filenames + correct match counts", function () {
      const sealLine = section.match(/wrote seal[^\n]*reconciliation-(\d{4}-\d{2}-\d{2})-seal\.json/);
      expect(sealLine, "worked example names a dated seal file").to.not.equal(null);
      const date = sealLine[1];

      // GROUND TRUTH — the only filenames the packet writer emits for that date.
      const names = report.packetFilenames(date);
      const packetBasenames = [names.html, names.balancesCsv, names.exceptionsCsv];

      // Every real packet filename must appear verbatim in the worked example
      // (the `wrote ...` lines), and the CHANGED localization line must point at one.
      for (const f of packetBasenames) {
        expect(section, `worked example shows real packet file ${f}`).to.include(f);
      }
      expect(section, "CHANGED line names a real emitted packet file").to.match(
        new RegExp(`CHANGED\\s+${names.html.replace(/[.]/g, "\\$&")}`)
      );

      // The engine NEVER prefixes packet files with `trust-` and NEVER emits a single
      // bare `reconciliation-<date>.csv`; the old (wrong) example did. Forbid both so
      // the broken names can't creep back in.
      expect(section, "no fictitious trust-reconciliation-* packet name").to.not.match(
        /trust-reconciliation-\d{4}-\d{2}-\d{2}\.(html|csv)/
      );
      expect(section, "no fictitious single reconciliation-<date>.csv").to.not.match(
        /\breconciliation-\d{4}-\d{2}-\d{2}\.csv\b/
      );

      // Headline match counts: 3 source inputs + 3 emitted outputs = 6 sealed files.
      const inputs = seal.INPUT_ROLES.length; // bank / book / rentroll = 3
      const outputs = packetBasenames.length; // html + 2 csv = 3
      const total = inputs + outputs;
      expect(inputs, "three source-input roles").to.equal(3);
      expect(outputs, "three emitted packet files").to.equal(3);
      // Clean ACCEPTED run: all `total` matched, nothing else.
      expect(section, `clean run shows ${total} matched`).to.include(
        `files: ${total} matched, 0 changed, 0 missing, 0 unexpected`
      );
      // Tampered run: exactly one packet file CHANGED, the rest matched.
      expect(section, `tampered run shows ${total - 1} matched, 1 changed`).to.include(
        `files: ${total - 1} matched, 1 changed, 0 missing, 0 unexpected`
      );
    });
  });

  describe("docs/TRUSTLEDGER.md: usage + pipeline + human-step sections updated", function () {
    it("the Usage block lists --seal and verify-seal", function () {
      const start = docLower.indexOf("## usage");
      expect(start, "usage section present").to.be.greaterThan(-1);
      const usage = doc.slice(start);
      expect(usage).to.match(/--seal \[<file>\]/);
      expect(usage).to.include("vh trust verify-seal <sealfile>");
      expect(usage).to.match(/--inputs <d>/);
    });

    it("the pipeline diagram names seal.js + verify-seal", function () {
      const start = docLower.indexOf("## how it works");
      expect(start, "how-it-works section present").to.be.greaterThan(-1);
      const how = doc.slice(start);
      expect(how).to.match(/seal\.js/);
      expect(how).to.include("verify-seal");
    });

    it("the 'What stays a human step' P-5 #1 bullet notes the SEALED, verifiable deliverable", function () {
      const start = docLower.indexOf("## what stays a human step");
      expect(start, "human-step section present").to.be.greaterThan(-1);
      const human = doc.slice(start);
      const humanLower = human.toLowerCase();
      expect(humanLower).to.match(/sealed/);
      expect(humanLower).to.match(/byte-for-byte|independently-verifiable|independently verifiable/);
      expect(human).to.match(/P-3/);
      expect(human).to.include("--seal");
      expect(human).to.include("verify-seal");
    });
  });

  describe("STRATEGY.md: P-5 item #1 SHARPENED to the SEALED, independently-verifiable deliverable", function () {
    let item1;
    before(function () {
      const p5 = strategy.indexOf("P-5 (2026-06-24)");
      expect(p5, "P-5 proposal present").to.be.greaterThan(-1);
      const tail = strategy.slice(p5);
      const start = tail.indexOf("\n  1. ");
      expect(start, "P-5 item 1 present").to.be.greaterThan(-1);
      const rest = tail.slice(start);
      // Item 1 runs to the start of item 2.
      const end = rest.indexOf("\n  2. ");
      item1 = (end === -1 ? rest : rest.slice(0, end));
    });

    it("notes the audit deliverable is now a SEALED, byte-for-byte independently-verifiable artifact", function () {
      const lower = item1.toLowerCase();
      expect(lower).to.match(/seal/);
      expect(lower).to.match(/byte-for-byte|independently-verifiable|independently verifiable/);
      expect(lower).to.match(/tamper-evident|tamper evident/);
      // The examiner reviews a tamper-evident packet, not an editable printout.
      expect(lower).to.match(/examiner|printout/);
    });

    it("anchors the claim to the shipped mechanism (--seal / verify-seal), not a rewrite", function () {
      expect(item1).to.include("--seal");
      expect(item1).to.include("verify-seal");
      expect(item1).to.match(/EPIC-26|T-26/);
      expect(item1.toLowerCase()).to.match(/no new crypto|provenance core/);
    });

    it("states the 'sealed on date T' trust-root is P-3 and stays needs-human", function () {
      expect(item1).to.match(/P-3/);
      expect(item1.toLowerCase()).to.match(/sealed on date t|sealed on date/);
      expect(item1.toLowerCase()).to.match(/needs-human|never provisions/);
      // The seal does not weaken the disclaimer / replace the CPA review.
      expect(item1.toLowerCase()).to.match(/does not weaken|replace the cpa|not.*replace/);
    });
  });
});

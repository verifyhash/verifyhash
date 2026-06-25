"use strict";

// ---------------------------------------------------------------------------
// T-46.3 docs-rot guard for `vh evidence diff` (docs/EVIDENCE.md).
//
// PURE (no chain, no fixtures, no filesystem writes): asserts the buyer/recipient-facing prose documents
// the `vh evidence diff` surface the way `cli/evidence.js` actually behaves, so the doc can't silently
// drift from the code. Load-bearing properties the doc MUST carry (the T-46.3 acceptance criteria):
//   * names `vh evidence diff` and lists it in the Commands block;
//   * frames it as the RECIPIENT-SIDE companion to `verify` (you hold the v1 packet you were handed and
//     the v2 packet of the next hand-off);
//   * documents the rename behavior — a rename surfaces as REMOVED + ADDED, never a single CHANGED;
//   * states the compares-CLAIMS-not-content boundary VERBATIM, and points at `verify --dir` for the
//     bytes-level check;
//   * states `diff` is FREE / key-free (no license, no vendor, nothing to gate) AND a free-tier-funnel
//     reinforcement (P-7);
//   * states it changes no existing `seal`/`verify` verdict (purely additive);
//   * restates the standing tamper-evidence / NOT-a-trusted-timestamp boundary verbatim;
//   * does NOT introduce a NEW needs-human item or alter the P-3/P-5/P-6/P-7/P-8 asks.
//
// Importing evidence.js pins the in-band TRUST-note wording this guard reuses AND fails loudly if the
// module (or its diff surface) is ever removed — the guard would otherwise be hollow.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

const evidence = require("../cli/evidence");

describe("T-46.3 docs: `vh evidence diff` documented (docs/EVIDENCE.md)", function () {
  let doc, docLower, diffSection;
  // Whitespace-collapsed views so a phrase that WRAPS across markdown lines (incl. `>` blockquote markers)
  // still matches a single-space regex — the prose meaning, not its line-wrapping, is what we pin.
  let docFlat, sectionFlat;
  const flatten = (s) => s.replace(/\s*\n\s*>?\s*/g, " ").replace(/\s+/g, " ");

  before(function () {
    doc = read("docs/EVIDENCE.md");
    docLower = doc.toLowerCase();
    // The dedicated section that explains the recipient-side hand-off diff.
    const start = doc.indexOf("## What changed between two hand-offs?");
    expect(start, "the `vh evidence diff` section is present").to.be.greaterThan(-1);
    const rest = doc.slice(start);
    const end = rest.indexOf("\n## ", 3);
    diffSection = end === -1 ? rest : rest.slice(0, end);
    docFlat = flatten(doc);
    sectionFlat = flatten(diffSection);
  });

  it("evidence.js still exports the diff surface + TRUST note this guard pins against", function () {
    // If these go away, the doc is documenting vapor — fail loudly rather than pass a hollow guard.
    expect(evidence.runEvidenceDiff, "runEvidenceDiff export").to.be.a("function");
    expect(evidence.diffEvidence, "diffEvidence export").to.be.a("function");
    expect(evidence.cmdEvidence, "cmdEvidence export").to.be.a("function");
    expect(evidence.EVIDENCE_TRUST_NOTE, "EVIDENCE_TRUST_NOTE export").to.be.a("string");
  });

  it("names `vh evidence diff` and lists it in the Commands block", function () {
    expect(doc).to.include("vh evidence diff");
    // The Commands fenced block carries the diff usage line (two packets, optional --json).
    const cmdStart = doc.indexOf("## Commands");
    expect(cmdStart, "Commands section present").to.be.greaterThan(-1);
    const block = doc.slice(cmdStart).split("```")[1];
    expect(block, "Commands fenced block").to.be.a("string");
    expect(block).to.match(/vh evidence diff <p1> <p2> \[--json\]/);
  });

  it("frames diff as the RECIPIENT-SIDE companion to verify (v1 packet you hold vs v2 of the next hand-off)", function () {
    const s = sectionFlat.toLowerCase();
    expect(s).to.match(/recipient-side/);
    // The v1-you-were-handed / v2-next-hand-off framing.
    expect(s).to.match(/v1/);
    expect(s).to.match(/v2/);
    expect(s).to.match(/hand-off|hand off|handed/);
  });

  it("documents the rename behavior: a rename shows as REMOVED + ADDED, never a single CHANGED", function () {
    const s = sectionFlat.toLowerCase();
    expect(s).to.match(/rename/);
    expect(s).to.match(/removed.*added|added.*removed/);
    // Explicitly NOT a single CHANGED.
    expect(s).to.match(/never a single changed|not a single changed/);
  });

  it("states the compares-CLAIMS-not-content boundary AND points at `verify --dir` for the bytes-level check", function () {
    // The exact boundary phrasing the task requires (CLAIMS, not re-derived content).
    expect(diffSection).to.match(/compares what each packet \*\*CLAIMS\*\*|CLAIMS/);
    expect(diffSection).to.match(/does \*\*NOT\*\* re-derive content|does NOT re-derive content|not re-derive content from bytes/i);
    // The explicit pointer at the bytes-level check.
    expect(diffSection).to.include("vh evidence verify <p> --dir <d>");
    expect(diffSection.toLowerCase()).to.match(/bytes-level check|byte-for-byte|re-derive a root from bytes/);
  });

  it("states diff is FREE / key-free with nothing to gate, and reinforces the P-7 free-tier funnel", function () {
    const s = diffSection.toLowerCase();
    expect(s).to.match(/free/);
    expect(s).to.match(/key-free/);
    // No artifact, nothing to gate — no license / no vendor.
    expect(s).to.match(/nothing to gate/);
    expect(s).to.match(/no `?--license`?|no license/);
    expect(s).to.match(/no `?--vendor`?|no vendor/);
    // The free-tier funnel reinforcement (P-7).
    expect(diffSection).to.include("P-7");
    expect(s).to.match(/free-tier funnel|funnel/);
  });

  it("states diff changes no existing seal/verify verdict (purely additive)", function () {
    const s = diffSection.toLowerCase();
    expect(s).to.match(/changes no `?seal`?\/`?verify`? behavior|changes no .*verdict|purely additive|no .*behavior/);
    // It is explicitly a read-only path that does not alter seal/verify.
    expect(s).to.match(/read-only|read only|additive read/);
  });

  it("restates the standing tamper-evidence / NOT-a-trusted-timestamp boundary VERBATIM", function () {
    // The standing boundary, carried in the doc's own trust-boundary note AND in the diff section's note.
    // Use the whitespace-flattened views so the bolded phrase still matches even where it wraps a line
    // (incl. across a `>` blockquote marker).
    expect(docFlat).to.include("TAMPER-EVIDENCE + OFFLINE-RECOMPUTE");
    expect(docFlat).to.match(/NOT a trusted\s+timestamp/i);
    // The diff section itself carries the standing boundary (so it can't drift out of the new section).
    expect(sectionFlat).to.include("TAMPER-EVIDENCE + OFFLINE-RECOMPUTE");
    expect(sectionFlat).to.match(/NOT a trusted\s+timestamp/i);
    // "Sealed at T" still rides the human-owned trust-root, P-3.
    expect(diffSection).to.include("P-3");
    expect(diffSection.toLowerCase()).to.match(/sealed at (time )?t/);
    // The exact in-band TRUST-note clause from the code is echoed in the doc (so prose can't drift).
    expect(doc).to.include("This evidence seal is TAMPER-EVIDENT + OFFLINE-RECOMPUTABLE, NOT a trusted timestamp.");
  });

  it("introduces NO new needs-human ITEM — every needs-human pointer rides an EXISTING proposal (P-3/P-7)", function () {
    // The acceptance bar is "NO new needs-human ITEM" — i.e. no NEW proposal number tagged needs-human.
    // `diff` is FREE/key-free (nothing to gate), so it escalates nothing. The doc may still RESTATE the
    // standing P-3 trust-root boundary (which legitimately carries `needs-human`) verbatim — that is a
    // restatement of an EXISTING proposal, not a new ask. Assert every `needs-human` mention sits next to
    // an already-existing proposal number (P-3 or P-7), and that NO other P-N is tagged needs-human.
    const allowed = new Set(["P-3", "P-7"]);
    const lines = doc.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/needs-human/i.test(lines[i])) continue;
      // Look at this line plus its neighbors (the note can wrap) for the proposal number it points at.
      const context = [lines[i - 1] || "", lines[i], lines[i + 1] || ""].join(" ");
      const pNums = context.match(/P-\d+/g) || [];
      expect(pNums.length, `a needs-human mention near line ${i + 1} names its proposal`).to.be.greaterThan(0);
      for (const p of pNums) {
        expect(allowed.has(p), `needs-human near line ${i + 1} rides an EXISTING proposal (got ${p})`).to.equal(true);
      }
    }
    // The diff section specifically escalates nothing new: it carries ONLY the standing P-3 boundary as its
    // needs-human pointer (no fresh proposal, no P-5/P-6/P-8 re-sharpening text).
    expect(diffSection).to.not.match(/P-5|P-6|P-8/);
  });
});

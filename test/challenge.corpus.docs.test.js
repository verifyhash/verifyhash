"use strict";

// test/challenge.corpus.docs.test.js — T-52.3: wire the adversarial conformance corpus into the
// BUYER-FACING trust story and the regression floor, and pin it so it cannot silently rot.
//
// WHY THIS TEST EXISTS
//   T-52.1 committed the corpus (one poisoned packet per tamper class) and T-52.2 the self-auditing
//   runner (challenge/corpus/run-corpus.js). Those prove the MECHANISM. THIS suite proves the PROSE
//   around it is honest, reachable, and load-bearing: a buyer's security reviewer who reads
//   docs/CONFORMANCE.md is told EXACTLY what an all-REJECT run proves and what it does NOT, the doc
//   enumerates EVERY tamper class the manifest publishes (so adding a class without documenting it
//   FAILS the build — the docs-rot floor), the cold-prospect challenge links the corpus step, and the
//   buyer-facing pointers in docs/PILOT.md + STRATEGY.md P-7/P-8 carry the corpus WITHOUT changing any
//   ask or adding any needs-human item.
//
// PURE: no chain, no spawns, no filesystem writes. It reads the committed docs + the corpus manifest
// and cross-checks the prose against the taxonomy it claims to cover.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// Whitespace-collapsed view so a phrase that WRAPS across markdown lines (incl. `>` blockquote markers,
// table cells, list continuation) still matches a single-space regex — we pin the meaning, not the wrap.
const flatten = (s) => s.replace(/\s*\n\s*>?\s*/g, " ").replace(/\s+/g, " ");

describe("T-52.3 docs: the adversarial conformance corpus is in the buyer trust story + a regression floor", function () {
  let conformance, conformanceFlat;
  let challenge, challengeFlat;
  let pilot, pilotFlat;
  let strategy;
  let manifest;

  before(function () {
    conformance = read("docs/CONFORMANCE.md");
    conformanceFlat = flatten(conformance);
    challenge = read("challenge/README.md");
    challengeFlat = flatten(challenge);
    pilot = read("docs/PILOT.md");
    pilotFlat = flatten(pilot);
    strategy = read("STRATEGY.md");
    manifest = JSON.parse(read("challenge/corpus/manifest.json"));
  });

  // -----------------------------------------------------------------------
  // docs/CONFORMANCE.md exists and names the runner.
  // -----------------------------------------------------------------------
  describe("docs/CONFORMANCE.md exists and names the self-auditing runner", function () {
    it("the file exists", function () {
      expect(fs.existsSync(path.join(ROOT, "docs/CONFORMANCE.md")), "docs/CONFORMANCE.md").to.equal(true);
    });

    it("names challenge/corpus/run-corpus.js (the runner it documents)", function () {
      expect(conformance, "names the runner script").to.match(/challenge\/corpus\/run-corpus\.js/);
    });

    it("frames the one load-bearing safety invariant (no verifier ever ACCEPTs a poisoned input)", function () {
      const f = conformanceFlat.toLowerCase();
      expect(f, "states the no-false-ACCEPT invariant").to.match(
        /no verifier ever returns? accept|never (returns? )?accept|false[- ]accept/
      );
      // It drives EVERY shipped verifier — producer + the two independent offline verifiers.
      expect(conformance).to.match(/verify-vh-standalone\.js/);
      expect(conformance).to.match(/verify-vh\.js/);
      expect(conformanceFlat).to.match(/vh evidence verify/);
    });
  });

  // -----------------------------------------------------------------------
  // It states the HONEST BOUNDARY verbatim — the three load-bearing narrowings the acceptance pins.
  // -----------------------------------------------------------------------
  describe("docs/CONFORMANCE.md states the honest boundary VERBATIM", function () {
    it("proves REJECT of every ENUMERATED class + re-derive-from-the-bytes (not the seal's stored hashes)", function () {
      const f = conformanceFlat.toLowerCase();
      // REJECT of every ENUMERATED tamper class.
      expect(f, "proves REJECT of every enumerated class").to.match(
        /reject(s|ed)? (of )?every enumerated (tamper )?class|every enumerated (tamper )?class/
      );
      // RE-DERIVE the root from the bytes you hold — never trusting the seal's own stored hashes.
      expect(f, "re-derives from the bytes").to.match(/re-deriv|recompute/);
      expect(f, "names the keccak Merkle root re-derivation").to.match(/keccak.*merkle root|merkle root/);
      expect(f, "does not trust the seal's own stored hashes").to.match(
        /never trusting the seal|not trust(ing)? the seal|seal's own stored hashes/
      );
    });

    it("is explicit it does NOT prove the absence of unknown tamper classes", function () {
      const f = conformanceFlat.toLowerCase();
      expect(f, "does NOT prove absence of unknown classes").to.match(
        /does not prove the absence of unknown|not (a )?proof that no other|never a proof that no other|absence of unknown (tamper )?class/
      );
    });

    it("is explicit a REJECT is tamper-evidence, NOT a trusted timestamp without P-3", function () {
      const f = conformanceFlat.toLowerCase();
      expect(f, "a REJECT is tamper-evidence not a trusted timestamp").to.match(
        /reject is tamper-evidence,? not a trusted timestamp|tamper-evidence,? not a trusted timestamp/
      );
      expect(f, "the trusted-time upgrade is P-3").to.match(/p-3/);
      // And it is the FREE/UNSIGNED path with no signer to pin + not a legal/accounting opinion.
      expect(f).to.match(/unsigned/);
      expect(f).to.match(/no signer to pin/);
      expect(f).to.match(/not a legal or accounting opinion|not a legal/);
    });

    it("is explicit it covers the UNSIGNED content-integrity surface only and does NOT red-team the signer-pin (--vendor) path", function () {
      const f = conformanceFlat.toLowerCase();
      // The corpus scope is the UNSIGNED content-integrity surface — stated plainly, not buried in the
      // timestamp bullet. (Honesty floor: the corpus drives only the 3 unsigned verifiers; it ships ZERO
      // signed fixtures and NO signature/signer-substitution class, so the page must NOT let a buyer's
      // security reviewer believe the signer-pin PAID upgrade was adversarially tested here.)
      expect(f, "states it covers the unsigned content-integrity surface only").to.match(
        /unsigned content-integrity surface only|content-integrity surface only/
      );
      // It exercises NO signature-corruption / signer-substitution class.
      expect(f, "no signature-corruption / signer-substitution class").to.match(
        /no signature-corruption|signature-corruption \/ signer-substitution|no signer-substitution/
      );
      // It does NOT red-team / exercise the signer-pin (--vendor) path — the named PAID upgrade.
      expect(f, "does not red-team the signer-pin (--vendor) path").to.match(
        /does not red-team the signer-pin|not red-team the signer-pin|signer-pin \(`?--vendor`?\) path/
      );
      expect(f, "names the --vendor signer-pin path explicitly").to.match(/--vendor/);
      expect(f, "ties the disclosure to the PAID signer-pin upgrade").to.match(/paid/);
    });
  });

  // -----------------------------------------------------------------------
  // THE DOCS-ROT FLOOR: docs/CONFORMANCE.md lists EVERY tamper-class id in the manifest, and lists no
  // STALE id. Adding a class to the manifest without documenting it here therefore FAILS the build.
  // -----------------------------------------------------------------------
  describe("docs/CONFORMANCE.md lists EVERY manifest tamper-class id (the docs-rot floor)", function () {
    it("the manifest is the published taxonomy this doc must mirror", function () {
      expect(manifest.kind, "manifest kind").to.equal("vh.challenge-corpus");
      expect(Array.isArray(manifest.classes), "manifest.classes is an array").to.equal(true);
      expect(manifest.classes.length, "the corpus has classes").to.be.greaterThan(0);
    });

    it("every manifest class id appears in docs/CONFORMANCE.md (adding a class without documenting FAILS)", function () {
      const missing = manifest.classes
        .map((c) => c.id)
        .filter((id) => !conformance.includes(id));
      expect(
        missing,
        `docs/CONFORMANCE.md is missing tamper-class id(s) present in manifest.json: ${JSON.stringify(missing)} ` +
          `— document the new class in docs/CONFORMANCE.md (the buyer trust story must enumerate the whole taxonomy)`
      ).to.deep.equal([]);
    });

    it("docs/CONFORMANCE.md lists no STALE class id (every documented id is a real manifest class)", function () {
      // Pin against the reverse drift too: a backtick-quoted `id-like` token in the table that is NOT a
      // real class id is a stale/typo'd entry the floor should catch. We scope to the kebab-case ids that
      // match the manifest's id shape (vertical-prefixed) to avoid flagging unrelated inline code.
      const manifestIds = new Set(manifest.classes.map((c) => c.id));
      const quoted = conformance.match(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g) || [];
      const idShaped = quoted
        .map((q) => q.slice(1, -1))
        // Only consider tokens that LOOK like a corpus class id: start with a known vertical prefix.
        .filter((t) => /^(finance|ai-data|legal|software|seal)-/.test(t));
      const stale = idShaped.filter((t) => !manifestIds.has(t));
      expect(
        stale,
        `docs/CONFORMANCE.md documents class-id-shaped token(s) not in manifest.json (stale/typo): ${JSON.stringify(stale)}`
      ).to.deep.equal([]);
    });
  });

  // -----------------------------------------------------------------------
  // challenge/README.md links the corpus step.
  // -----------------------------------------------------------------------
  describe("challenge/README.md links the conformance-corpus step", function () {
    it("links docs/CONFORMANCE.md and names the runner command", function () {
      expect(challenge, "challenge/README.md links the conformance doc").to.match(
        /\.\.\/docs\/CONFORMANCE\.md/
      );
      expect(challenge, "names the corpus runner command").to.match(/run-corpus\.js/);
    });

    it("frames it honestly as MORE than one byte (enumerated classes), not an over-promise", function () {
      const f = challengeFlat.toLowerCase();
      expect(f).to.match(/conformance corpus|adversarial .* corpus/);
      expect(f, "enumerated, not all-conceivable").to.match(/enumerated/);
    });

    it("does NOT over-claim 'every shipped verifier' unscoped, and carries the signer-pin narrowing", function () {
      const f = challengeFlat.toLowerCase();
      // HONESTY FLOOR: the corpus drives only the 3 unsigned content-integrity verifiers. Any
      // "every shipped verifier" claim on the cold-prospect page MUST be scoped to the unsigned seal,
      // or it falsely implies the signer-pin (--vendor) PAID path was red-teamed.
      const overclaim = /every shipped verifier(?! of the unsigned)/;
      expect(
        overclaim.test(f),
        "challenge/README.md must not say 'every shipped verifier' without scoping it to the unsigned content-integrity seal"
      ).to.equal(false);
      // The corpus pointer carries the signer-pin narrowing pointing at the --vendor PAID path.
      expect(f, "challenge corpus pointer names the signer-pin --vendor path").to.match(/--vendor/);
      expect(f, "challenge corpus pointer flags it does NOT red-team the signer-pin path").to.match(
        /does not red-team the signer-pin|not red-team the signer-pin|signer-pin `?--vendor`? path/
      );
    });
  });

  // -----------------------------------------------------------------------
  // docs/PILOT.md gains a one-line pointer — NO change to any ASK, NO new needs-human item.
  // -----------------------------------------------------------------------
  describe("docs/PILOT.md gains a corpus pointer that changes no ask", function () {
    it("links docs/CONFORMANCE.md and names the runner", function () {
      expect(pilot, "PILOT.md links the conformance doc").to.match(/\(CONFORMANCE\.md\)|CONFORMANCE\.md/);
      expect(pilot, "names the runner command").to.match(/run-corpus\.js/);
    });

    it("the PILOT pointer carries the honest narrowing (enumerated, not absence; not a timestamp w/o P-3)", function () {
      // Scope to the window around the corpus mention so we pin the NEW pointer, not unrelated prose.
      const lines = pilot.split("\n");
      const idx = lines.findIndex((ln) => /run-corpus\.js/.test(ln));
      expect(idx, "PILOT.md mentions the runner").to.be.greaterThan(-1);
      const ctx = flatten(lines.slice(Math.max(0, idx - 4), idx + 6).join("\n")).toLowerCase();
      expect(ctx, "enumerated, not absence of unknown").to.match(/enumerated/);
      expect(ctx, "REJECT is tamper-evidence not a trusted timestamp w/o P-3").to.match(/p-3/);
    });

    it("the PILOT pointer adds NO new needs-human item near the corpus mention", function () {
      const lines = pilot.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!/run-corpus\.js|CONFORMANCE\.md/.test(lines[i])) continue;
        const ctx = lines.slice(Math.max(0, i - 5), i + 6).join(" ");
        expect(/needs-human/i.test(ctx), `PILOT.md corpus pointer must not add a needs-human item near line ${i + 1}`).to.equal(false);
      }
    });

    it("the corpus pointer does NOT redefine any proposal (it only POINTS)", function () {
      const lines = pilot.split("\n");
      const sharpen = /\b(sharpen|sharpened|redefine|redefined|re-?sharpen|now reads|is updated to|amend)\b/i;
      const offenders = lines.filter(
        (ln) => /run-corpus\.js|CONFORMANCE\.md/.test(ln) && sharpen.test(ln)
      );
      expect(offenders, `PILOT.md corpus pointer must not re-sharpen a proposal: ${JSON.stringify(offenders)}`).to.deep.equal([]);
    });
  });

  // -----------------------------------------------------------------------
  // STRATEGY.md P-7 step 3 + P-8 gain a one-line pointer — NO change to any ASK, NO new needs-human item.
  // -----------------------------------------------------------------------
  describe("STRATEGY.md P-7 step 3 and P-8 gain a corpus pointer that changes no ask", function () {
    // Helper: the small window around each TAGGED proposal pointer. The two new P-7/P-8 pointers carry
    // the distinctive marker "POINTER (T-52.3, no new gate)" — scoping to that marker isolates the
    // proposal pointers from the EPIC-52 strategy-log narrative (which also mentions T-52.3 + the corpus).
    const POINTER_MARKER = "POINTER (T-52.3, no new gate)";
    function pointerWindows() {
      const wins = [];
      let from = 0;
      for (;;) {
        const idx = strategy.indexOf(POINTER_MARKER, from);
        if (idx === -1) break;
        wins.push(strategy.slice(idx, idx + 600));
        from = idx + POINTER_MARKER.length;
      }
      return wins;
    }

    it("STRATEGY.md carries a T-52.3 corpus pointer linking CONFORMANCE.md + the runner", function () {
      expect(strategy, "STRATEGY.md references the conformance doc").to.match(/docs\/CONFORMANCE\.md/);
      expect(strategy, "STRATEGY.md names the runner").to.match(/run-corpus\.js/);
      // The pointer is tagged T-52.3 so it is unmistakably the new addition.
      expect(strategy).to.match(/T-52\.3/);
    });

    it("there is a pointer attached to P-7 step 3 (the design-partner step) AND to P-8 step 3", function () {
      // P-7 step 3 = the "Land a B2B design partner" step. The new pointer sits in its body, between that
      // step header and the "P-7 is **DISTINCT**" summary line.
      const p7StepStart = strategy.indexOf("Land a B2B design partner");
      expect(p7StepStart, "P-7 step 3 body is present").to.be.greaterThan(-1);
      const p7Summary = strategy.indexOf("P-7 is **DISTINCT**", p7StepStart);
      expect(p7Summary, "P-7 step-3 summary boundary present").to.be.greaterThan(p7StepStart);
      const p7Body = strategy.slice(p7StepStart, p7Summary);
      expect(p7Body, "P-7 step 3 carries the corpus pointer").to.match(/run-corpus\.js/);
      expect(p7Body, "P-7 step 3 corpus pointer is tagged T-52.3").to.match(/T-52\.3/);

      // P-8: the pointer rides the cold-prospect first-contact step (the zero-install challenge handoff).
      const p8Anchor = strategy.indexOf("zero-install COLD-PROSPECT CHALLENGE");
      expect(p8Anchor, "P-8 cold-prospect step present").to.be.greaterThan(-1);
      const p8Window = strategy.slice(p8Anchor, p8Anchor + 1200);
      expect(p8Window, "P-8 carries the corpus pointer").to.match(/run-corpus\.js/);
      expect(p8Window, "P-8 corpus pointer is tagged T-52.3").to.match(/T-52\.3/);
    });

    it("each STRATEGY.md corpus pointer carries the honest narrowing (enumerated, not absence; P-3 for time)", function () {
      const wins = pointerWindows();
      expect(wins.length, "found at least the P-7 and P-8 corpus pointers").to.be.greaterThan(1);
      for (const w of wins) {
        const f = flatten(w).toLowerCase();
        expect(f, "enumerated, not absence of unknown classes").to.match(/enumerated/);
        expect(f, "not a trusted timestamp without P-3").to.match(/p-3/);
      }
    });

    it("each STRATEGY.md corpus pointer adds NO new needs-human item and explicitly says 'no new gate'", function () {
      const wins = pointerWindows();
      for (const w of wins) {
        // The pointer must self-declare it is not an escalation (mirrors the SHARPENING/POINTER convention).
        expect(/no new gate|no new `?needs-human`? item|no new needs-human/i.test(w),
          `each T-52.3 corpus pointer self-declares it is no new gate: ${JSON.stringify(w)}`).to.equal(true);
      }
    });

    it("the corpus pointers do NOT re-sharpen / redefine any proposal (POINTER only)", function () {
      const wins = pointerWindows();
      const sharpen = /\b(sharpen|sharpened|redefine|redefined|re-?sharpen|now reads|is updated to|amend|relax|loosen|weaken)\b/i;
      for (const w of wins) {
        // Allow the literal self-negation ("no new gate") but no positive redefinition verb.
        const offending = w
          .split("\n")
          .filter((ln) => sharpen.test(ln) && /run-corpus\.js|CONFORMANCE\.md|conformance corpus/i.test(ln));
        expect(offending, `corpus pointer must not re-sharpen a proposal: ${JSON.stringify(offending)}`).to.deep.equal([]);
      }
    });
  });

  // -----------------------------------------------------------------------
  // GLOBAL: T-52.3 introduced NO new needs-human ITEM anywhere. The "Proposals — needs-human" section
  // must still contain exactly the SAME proposal set (P-1..P-8) — no fresh P-<n> ask.
  // -----------------------------------------------------------------------
  describe("T-52.3 introduces NO new needs-human proposal", function () {
    it("the highest proposal number in the Proposals section is still P-8 (no P-9+ added)", function () {
      const secStart = strategy.indexOf("## Proposals — needs-human");
      expect(secStart, "Proposals section present").to.be.greaterThan(-1);
      const section = strategy.slice(secStart);
      const proposalHeaders = section.match(/^- \*\*P-(\d+)\b/gm) || [];
      const nums = proposalHeaders.map((h) => parseInt(h.match(/P-(\d+)/)[1], 10));
      expect(nums.length, "the section declares proposals").to.be.greaterThan(0);
      expect(Math.max(...nums), "no proposal beyond P-8 was added by T-52.3").to.equal(8);
    });
  });
});

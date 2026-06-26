"use strict";

// ---------------------------------------------------------------------------
// T-54.3 docs-rot guard for the reproduce-from-source TRUST-BOOTSTRAP ("who verifies the verifier?").
//
// PURE (no chain, no spawns, no filesystem writes): asserts the prose that answers the FIRST question a
// cold prospect's security/procurement reviewer asks — "how do I know your standalone verifier is the
// source I can read, not a vendor binary + a circular checksum?" — is documented and wired into the
// cold-prospect flow, and that none of it over-promises or escalates.
//
// What the EPIC-54 CODE already proves (NOT re-proved here): `node verifier/build-standalone.js --check`
// rebuilds the bundle byte-for-byte from in-tree source and attests the source->bundle->checksum chain
// (test/verifier.reproduce.test.js), and the bundle's bytes are a pure function of the committed sources
// (test/verifier.standalone.test.js). THIS suite proves the DOCS describe that behavior accurately and
// reachably, so the funnel's trust-bootstrap pitch can never silently rot or drift into an over-promise.
//
// Load-bearing properties pinned (the T-54.3 acceptance criteria):
//   * verifier/README.md DOCUMENTS the reproduce-from-source bootstrap (the §0b section): the circular-
//     checksum problem, the offline Node-core-only `--check` command, and that it trust-roots in SOURCE;
//   * verifier/README.md restates the VERBATIM trust boundary alongside that bootstrap (the SAME sentence
//     docs/INDEPENDENT-VERIFICATION.md carries), so the reproduce step never widens the CLAIM;
//   * challenge/README.md gains a ONE-LINE pointer to the bootstrap, with NO change to its ask and NO new
//     needs-human item;
//   * STRATEGY.md P-8 step 3a AND step 3b each gain a ONE-LINE pointer (POINTER-tagged, ask unchanged),
//     with NO new needs-human item and NO proposal re-sharpen.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// Whitespace-collapsed view so a phrase that WRAPS across markdown lines (incl. `>` blockquote markers,
// table cells, list indents) still matches a single-space regex — we pin prose meaning, not line-wrapping.
const flatten = (s) => s.replace(/\s*\n\s*>?\s*/g, " ").replace(/\s+/g, " ");

// The ONE boundary sentence the whole funnel rides, carried VERBATIM in docs/INDEPENDENT-VERIFICATION.md
// (the canonical source). The reproduce-from-source bootstrap must NOT widen this claim, so verifier/
// README.md restates it verbatim beside the bootstrap.
const BOUNDARY_VERBATIM =
  'the seal proves **tamper-evidence + signer-pin**, NOT a trusted "sealed at T"';

// The exact third-party-runnable reproduce command the docs must name (offline, Node-core-only).
const CHECK_CMD = "build-standalone.js --check";

describe("T-54.3 docs: the reproduce-from-source trust-bootstrap is documented and wired into the cold-prospect flow", function () {
  let verifierReadme, verifierFlat;
  let challenge, challengeFlat;
  let strategy, strategyFlat;
  let indep;

  before(function () {
    verifierReadme = read("verifier/README.md");
    verifierFlat = flatten(verifierReadme);
    challenge = read("challenge/README.md");
    challengeFlat = flatten(challenge);
    strategy = read("STRATEGY.md");
    strategyFlat = flatten(strategy);
    indep = read("docs/INDEPENDENT-VERIFICATION.md");
  });

  // -----------------------------------------------------------------------
  // Pin the canonical boundary source FIRST, so "verbatim" assertions below are a real cross-check.
  // -----------------------------------------------------------------------
  it("the canonical boundary sentence is present VERBATIM in docs/INDEPENDENT-VERIFICATION.md (the source)", function () {
    expect(indep, "INDEPENDENT-VERIFICATION.md carries the boundary sentence verbatim").to.include(
      BOUNDARY_VERBATIM
    );
  });

  // -----------------------------------------------------------------------
  // verifier/README.md documents the reproduce-from-source bootstrap (§0b).
  // -----------------------------------------------------------------------
  describe("verifier/README.md documents the reproduce-from-source bootstrap", function () {
    it("frames the 'who verifies the verifier?' question", function () {
      const f = verifierFlat.toLowerCase();
      expect(f, "asks who verifies the verifier").to.match(/who verifies the verifier/);
      // The CIRCULAR-checksum problem the bootstrap solves: the sidecar comes from the SAME place as the
      // bundle, so on its own it proves only transport, not that the bundle is the audited source.
      expect(f).to.match(/same place as|from the same place/);
      expect(f).to.match(/transport/);
    });

    it("names the offline, Node-core-only third-party-runnable `--check` command (no hardhat/npm)", function () {
      expect(verifierReadme, "names the reproduce command verbatim").to.include(CHECK_CMD);
      const f = verifierFlat.toLowerCase();
      // It is OFFLINE and needs nothing but Node core (no npm install / no hardhat).
      expect(f).to.match(/offline/);
      expect(f).to.match(/node[- ]core|node core[- ]only|no `?npm install`?|no `?hardhat`?/);
    });

    it("explains the bundle reproduces BYTE-FOR-BYTE from source, so trust roots in SOURCE not our hex", function () {
      const f = verifierFlat.toLowerCase();
      expect(f, "byte-for-byte reproduction from source").to.match(/byte[- ]for[- ]byte|reproduce.*from.*source/);
      expect(f, "trust roots in reading source, not our hex").to.match(
        /reading source|trust roots in .*source|not in trusting our hex|reading the source/
      );
      // It points at the committed build-provenance manifest that maps a bundle hash -> its source hashes.
      expect(verifierReadme).to.match(/BUILD-PROVENANCE\.json/);
    });

    it("restates the VERBATIM trust boundary beside the bootstrap (the reproduce step does NOT widen the claim)", function () {
      // The verbatim canonical boundary sentence must appear in verifier/README.md.
      expect(verifierReadme, "verifier/README.md carries the boundary verbatim").to.include(BOUNDARY_VERBATIM);
      const f = verifierFlat.toLowerCase();
      // And the README is explicit that reproducing the bundle proves BUILD INTEGRITY only — not that the
      // source's LOGIC is correct, and not a trusted timestamp/identity (that is P-3).
      expect(f).to.match(/build integrity/);
      expect(f).to.match(/logic.*correct|source's logic/);
      expect(verifierReadme).to.match(/\bP-3\b/);
    });

    it("the bootstrap section is mechanically pinned to the reproduce TEST (the docs cannot outrun the code)", function () {
      // The doc names the test that makes the reproduce promise true, so a reader can confirm it is enforced.
      expect(verifierReadme).to.match(/test\/verifier\.reproduce\.test\.js/);
    });

    it("wires the reproduce answer into a RENEWING CI control (the two shipped reproduce ci/ snippets)", function () {
      // The §0b bootstrap is more than a one-time read: it links the two copy-paste CI snippets that run
      // `--check` on every build, so a supply-chain swap of the verifier ITSELF fails the customer's
      // pipeline. This is the higher-leverage half of the answer — pin it so it cannot rot.
      expect(verifierReadme, "links the shell reproduce gate").to.contain("ci/reproduce-vh.generic.sh");
      expect(verifierReadme, "links the GitHub Actions reproduce gate").to.contain(
        "ci/reproduce-vh.github-actions.yml"
      );
      const f = verifierFlat.toLowerCase();
      expect(f, "frames it as a renewing control, not a one-time read").to.match(
        /renewing control|every build|on every build|fails your pipeline|blocks the merge/
      );
      // The snippets are honest "examples the loop never runs" but mechanically tested — the README names
      // that anti-rot test so the copy-paste gate is known-good, not aspirational.
      expect(verifierReadme, "names the snippet anti-rot test").to.match(
        /test\/verifier\.reproduce-ci-snippet\.test\.js/
      );
      // Wiring the gate must NOT widen the claim: the README is explicit it changes nothing about §4.
      expect(f, "the CI gate widens nothing about the trust boundary").to.match(
        /widens \*\*nothing\*\*|widens nothing|changes \*\*nothing\*\*|changes nothing/
      );
    });
  });

  // -----------------------------------------------------------------------
  // challenge/README.md gains a ONE-LINE pointer (ask unchanged, no new escalation).
  // -----------------------------------------------------------------------
  describe("challenge/README.md gains a one-line pointer to the bootstrap (ask unchanged)", function () {
    it("points at the reproduce bootstrap and the `--check` command, linking verifier/README.md §0b", function () {
      const f = challengeFlat.toLowerCase();
      expect(f, "the challenge asks 'who verifies the verifier?'").to.match(/who verifies the verifier/);
      expect(challenge, "names the reproduce command").to.include(CHECK_CMD);
      // It is honest the reproduce path is offline.
      expect(f).to.match(/offline/);
      // It links the deeper bootstrap section in verifier/README.md.
      expect(challenge, "links verifier/README.md").to.match(/\.\.\/verifier\/README\.md/);
      expect(challenge, "points at §0b").to.match(/§0b/);
    });

    it("is a ONE-LINE pointer: it does NOT re-explain or duplicate the full bootstrap mechanism", function () {
      // Guard against the pointer ballooning into a second copy of §0b. The challenge must NOT restate the
      // build-provenance manifest mechanism — that lives in verifier/README.md; here it is a pointer only.
      expect(challenge, "challenge does not duplicate the manifest mechanism").to.not.match(/BUILD-PROVENANCE\.json/);
    });

    it("introduces NO new needs-human item and re-sharpens NO proposal", function () {
      expect(challenge, "challenge/README.md must not introduce a needs-human item").to.not.match(/needs-human/i);
      // Every PROPOSAL reference must be an existing, allowed one (the standing P-3 boundary only) — the new
      // pointer rides the existing trust-root, it does not invent a fresh ask. (`EIP-191` etc. are standards,
      // not verifyhash proposals, and are excluded by the negative lookbehind.)
      const pNums = challenge.match(/(?<![A-Za-z])P-\d+/g) || [];
      const allowed = new Set(["P-3"]);
      for (const p of pNums) {
        expect(allowed.has(p), `challenge/README.md references only existing proposals (got ${p})`).to.equal(true);
      }
      // No proposal-redefinition verbs next to a P-<n>.
      const sharpen = /\b(sharpen|sharpened|redefine|redefined|re-?sharpen|now reads|is updated to|amend)\b/i;
      const offenders = challenge.split("\n").filter((ln) => /P-\d+/.test(ln) && sharpen.test(ln));
      expect(offenders, `challenge must not re-sharpen a proposal: ${JSON.stringify(offenders)}`).to.deep.equal([]);
    });
  });

  // -----------------------------------------------------------------------
  // STRATEGY.md P-8 step 3a AND 3b each gain a ONE-LINE pointer (POINTER-tagged, ask unchanged).
  // -----------------------------------------------------------------------
  describe("STRATEGY.md P-8 step 3a/3b each gain a one-line pointer (ask unchanged)", function () {
    // Isolate the P-8 "3-step first contact" block so the pointers are pinned where they belong, not just
    // anywhere in the file.
    function p8FirstContactBlock() {
      const marker = "3. **The 3-step first contact (no slide deck):**";
      const start = strategy.indexOf(marker);
      expect(start, "P-8 3-step-first-contact block is present").to.be.greaterThan(-1);
      // The block runs to the next top-level numbered step ("4. **A time box...").
      const end = strategy.indexOf("4. **A time box", start);
      expect(end, "block has a terminating step 4").to.be.greaterThan(start);
      return strategy.slice(start, end);
    }

    it("both T-54.3 POINTERs land inside the P-8 3-step-first-contact block", function () {
      const block = flatten(p8FirstContactBlock());
      const pointerCount = (block.match(/POINTER \(T-54\.3, no new gate\):/g) || []).length;
      expect(pointerCount, "exactly two T-54.3 POINTERs (one per step 3a / 3b)").to.equal(2);
    });

    it("step 3a's pointer names the reproducible-from-source verifier (`--check`) linking §0b", function () {
      const block = flatten(p8FirstContactBlock());
      // Step 3a is the producer-identity-card step; its pointer says the verifier the prospect will run is
      // itself reproducible-from-source.
      expect(block, "3a pointer names the reproduce command").to.include(CHECK_CMD);
      expect(block.toLowerCase(), "3a pointer says reproducible-from-source").to.match(
        /reproducible[- ]from[- ]source|rebuilds .* from .* source/
      );
      expect(block, "3a pointer links verifier/README.md §0b").to.match(/verifier\/README\.md.*§0b/);
    });

    it("step 3b's pointer answers 'who verifies the verifier?' with the verbatim-scope boundary (P-3)", function () {
      const block = p8FirstContactBlock();
      const f = flatten(block).toLowerCase();
      expect(f, "3b pointer asks who verifies the verifier").to.match(/who verifies the verifier/);
      // It keeps the honest scope: proves the bundle IS the audited source, NOT that the logic is correct,
      // NOT a trusted timestamp without P-3.
      expect(f).to.match(/not that the source's logic is correct|not that the source.?s logic/);
      expect(block, "3b pointer rides the standing P-3 boundary").to.match(/\bP-3\b/);
      // It cites the test that makes the reproduce promise true.
      expect(block).to.match(/verifier\.reproduce\.test\.js/);
    });

    it("the pointers introduce NO new needs-human item and re-sharpen NO proposal", function () {
      const block = p8FirstContactBlock();
      // The whole P-8 block legitimately discusses gates, but the NEW pointer lines must not add a fresh
      // needs-human escalation. Scope to the two POINTER lines.
      const pointerLines = block.split("\n").filter((ln) => /POINTER \(T-54\.3/.test(ln) || /T-54\.3, no new gate/.test(ln));
      // Each POINTER explicitly declares "no new gate"; none may contain a needs-human token.
      for (const ln of pointerLines) {
        expect(ln, `T-54.3 pointer must not escalate: ${ln}`).to.not.match(/needs-human/i);
      }
      // And the pointers are tagged "no new gate" — the contract that they change no ask.
      const block2 = flatten(block);
      expect(block2, "each pointer is tagged no-new-gate").to.match(/T-54\.3, no new gate/);
    });
  });

  // -----------------------------------------------------------------------
  // Cross-doc consistency: the SAME command + the SAME boundary scope are used everywhere, so the three
  // surfaces can never drift apart.
  // -----------------------------------------------------------------------
  describe("the three surfaces stay consistent (no drift)", function () {
    it("all three docs name the exact same reproduce command", function () {
      for (const [name, text] of [
        ["verifier/README.md", verifierReadme],
        ["challenge/README.md", challenge],
        ["STRATEGY.md", strategy],
      ]) {
        expect(text, `${name} names ${CHECK_CMD}`).to.include(CHECK_CMD);
      }
    });

    it("every surface keeps the honest scope: build-integrity, NOT a P-3 timestamp", function () {
      // None of the three may claim the reproduce step proves a trusted timestamp or that the logic is
      // correct — each must name P-3 as the boundary for the time/identity claim.
      for (const [name, text] of [
        ["verifier/README.md", verifierReadme],
        ["STRATEGY.md (P-8 block)", strategyFlat],
      ]) {
        expect(text, `${name} cites P-3 as the time/identity boundary`).to.match(/\bP-3\b/);
      }
    });
  });
});

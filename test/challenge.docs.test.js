"use strict";

// ---------------------------------------------------------------------------
// T-50.2 docs-rot guard for the cold-prospect CHALLENGE entry point.
//
// PURE (no chain, no spawns, no filesystem writes): asserts the prose around the `challenge/` kit says
// exactly what the kit DOES, and that the top-level README + docs/INDEPENDENT-VERIFICATION.md cross-link
// it — so the cold-start funnel can never silently rot or drift into an over-promise.
//
// Load-bearing properties this guard pins (the T-50.2 acceptance criteria):
//   * challenge/README.md FRAMES the zero-install / zero-trust cold-prospect flow (no account, no
//     `npm install`, no build, no key, no network; only `node`);
//   * it restates the tamper-evidence / signer-pin-NOT-timestamp boundary VERBATIM (the SAME phrasing
//     docs/INDEPENDENT-VERIFICATION.md §0 carries), and — because the sample is the FREE UNSIGNED path —
//     is honest that there is no signer to pin in this sample;
//   * it points free-verify -> (free-produce ->) PAID-produce (signing + unlimited sealing);
//   * the top-level README.md AND docs/INDEPENDENT-VERIFICATION.md each cross-link challenge/README.md;
//   * NO new needs-human ITEM (the only proposal pointer is the standing P-3 boundary);
//   * NO change to any proposal (the doc does not re-sharpen / redefine P-1..P-8).
//
// The challenge kit's BEHAVIOR is proved by test/challenge.test.js (it drives the real standalone
// verifier); THIS suite proves the kit's PROSE matches that behavior and is reachable from the docs.
// ---------------------------------------------------------------------------

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// Whitespace-collapsed view so a phrase that WRAPS across markdown lines (incl. `>` blockquote markers,
// table cells) still matches a single-space regex — we pin the prose meaning, not its line-wrapping.
const flatten = (s) => s.replace(/\s*\n\s*>?\s*/g, " ").replace(/\s+/g, " ");

// The ONE boundary sentence the cold-start demo must never drift from. It is carried VERBATIM in
// docs/INDEPENDENT-VERIFICATION.md §0 (and verifier/README.md §0); challenge/README.md must restate it.
const BOUNDARY_VERBATIM =
  'the seal proves **tamper-evidence + signer-pin**, NOT a trusted "sealed at T"';

describe("T-50.2 docs: the cold-prospect CHALLENGE is the documented entry point", function () {
  let challenge, challengeFlat;
  let readmeTop, readmeTopFlat;
  let indep, indepFlat;

  before(function () {
    challenge = read("challenge/README.md");
    challengeFlat = flatten(challenge);
    readmeTop = read("README.md");
    readmeTopFlat = flatten(readmeTop);
    indep = read("docs/INDEPENDENT-VERIFICATION.md");
    indepFlat = flatten(indep);
  });

  // -----------------------------------------------------------------------
  // The boundary sentence the whole funnel rides is REALLY verbatim in the canonical spec — if it ever
  // changes there, this guard (and the challenge doc that copies it) must be updated in lock-step. Pin
  // the source first so the "verbatim" assertions below are a real cross-check, not a hand-copied literal.
  // -----------------------------------------------------------------------
  it("the canonical boundary sentence is present VERBATIM in docs/INDEPENDENT-VERIFICATION.md (the source)", function () {
    expect(indep, "INDEPENDENT-VERIFICATION.md carries the boundary sentence verbatim").to.include(
      BOUNDARY_VERBATIM
    );
  });

  // -----------------------------------------------------------------------
  // challenge/README.md FRAMES the zero-install / zero-trust cold-prospect flow.
  // -----------------------------------------------------------------------
  describe("challenge/README.md frames the zero-install / zero-trust cold-prospect flow", function () {
    it("the file exists", function () {
      expect(fs.existsSync(path.join(ROOT, "challenge/README.md")), "challenge/README.md").to.equal(true);
    });

    it("names the cold prospect and the zero-install / zero-trust / zero-network posture", function () {
      const f = challengeFlat.toLowerCase();
      expect(f, "names the cold prospect").to.match(/cold[ -]?prospect|cold start|cold/);
      // Zero-install: no account, no npm install, no build, no key, no network — only node.
      expect(f).to.match(/no account/);
      expect(f).to.match(/no `?npm install`?|no install|zero[- ]install/);
      expect(f).to.match(/no (repo )?build|no build/);
      expect(f).to.match(/no network/);
      expect(f).to.match(/\bnode\b/);
      // Zero-trust: trust no server / no producer software / not us.
      expect(f).to.match(/zero[- ]trust|trusting no server|no trust in|trust no/);
      expect(f).to.match(/not us|trusting .*not us|and not us/);
    });

    it("describes the verify -> tamper-one-byte -> reject-and-name-the-file loop", function () {
      const f = challengeFlat.toLowerCase();
      expect(f, "verify a real sealed packet").to.match(/verif(y|ies|ied).*packet|sealed packet/);
      expect(f, "tamper one byte").to.match(/one byte|single (byte|character)|tamper/);
      // It REJECTS and LOCALIZES (names) the changed file.
      expect(f).to.match(/reject/);
      expect(f).to.match(/which file|name(s)? the file|the file you changed|localiz/);
      // The stable exit-code contract is restated (0 verified / 3 rejected).
      expect(challenge).to.match(/exit\s*0|exit 0/i);
      expect(challenge).to.match(/exit\s*3|exit 3|REJECTED/i);
    });

    it("references the committed standalone verifier (NOT a fork)", function () {
      expect(challenge).to.match(/verify-vh-standalone\.js/);
      expect(challenge, "points at run.sh as the one command").to.match(/run\.sh/);
    });
  });

  // -----------------------------------------------------------------------
  // It restates the boundary VERBATIM and is honest about the unsigned sample.
  // -----------------------------------------------------------------------
  describe("challenge/README.md restates the boundary VERBATIM (and is honest it is the UNSIGNED path)", function () {
    it("carries the tamper-evidence / signer-pin-NOT-timestamp sentence verbatim", function () {
      expect(challenge, "challenge/README.md restates the boundary verbatim").to.include(BOUNDARY_VERBATIM);
      // The boundary rides the EXISTING P-3 trust-root (the standing proposal), not a fresh ask.
      expect(challenge).to.include("P-3");
    });

    it("is honest that the FREE sample is UNSIGNED, so there is NO signer to pin here", function () {
      const f = challengeFlat.toLowerCase();
      expect(f, "says the sample/seal is unsigned").to.match(/unsigned/);
      expect(f, "says there is no signer to pin in this sample").to.match(
        /no signer to pin|there is no signer|nothing to pin|no signature to/
      );
      // And NOT a legal opinion / not a trusted timestamp restated (tolerate **markdown** between words).
      expect(f).to.match(/not\*{0,2}\s*a legal (or accounting )?opinion/);
    });

    it("does NOT over-promise: it never claims an ADDED unreferenced file is rejected", function () {
      // The same honesty defect test/challenge.test.js (E) guards in TAMPER-ME.md: the standalone verifier
      // checks only the seal's NAMED set, so an extra unnamed file is NOT flagged. The README must not imply
      // otherwise.
      const lines = challenge.split("\n");
      const addish = /\b(add|adding|added|extra|new file|new one)\b/i;
      const rejectish = /\b(reject|rejected|fail|fails|failed|UNEXPECTED|exit\s*3)\b/i;
      const offenders = lines.filter((ln) => addish.test(ln) && rejectish.test(ln));
      expect(
        offenders,
        `challenge/README.md must not claim an ADDED file is rejected: ${JSON.stringify(offenders)}`
      ).to.deep.equal([]);
    });
  });

  // -----------------------------------------------------------------------
  // It points free-verify -> (free-produce ->) PAID-produce.
  // -----------------------------------------------------------------------
  describe("challenge/README.md points free-verify -> paid-produce (the funnel)", function () {
    it("frames verification as FREE forever and sealing >25 / signing as the PAID upgrade", function () {
      const f = challengeFlat.toLowerCase();
      // Free verify.
      expect(f).to.match(/free verify|verify (is )?free|free, offline|verify .*forever|anyone may verify/);
      // The paid upgrade: signing + unlimited sealing, via vh evidence seal --sign / the entitlement.
      expect(f).to.match(/paid/);
      expect(challenge).to.match(/vh evidence seal --sign|--sign/);
      expect(f).to.match(/unlimited|no file cap|file cap/);
      expect(f).to.match(/--vendor/);
      // It names the entitlement that gates the paid surface.
      expect(challenge).to.match(/evidence_unlimited|--license/);
    });

    it("names the free-produce single-file sealer between the two ends", function () {
      expect(challenge, "the free seal half is reachable too").to.match(/seal-vh-standalone\.js/);
    });
  });

  // -----------------------------------------------------------------------
  // The top-level README + docs/INDEPENDENT-VERIFICATION.md cross-link it.
  // -----------------------------------------------------------------------
  describe("the top-level README and docs/INDEPENDENT-VERIFICATION.md cross-link the challenge", function () {
    it("README.md cross-links challenge/README.md and frames it as the cold-prospect entry point", function () {
      expect(readmeTop, "README links challenge/README.md").to.match(/\(challenge\/README\.md\)|challenge\/README\.md/);
      const f = readmeTopFlat.toLowerCase();
      expect(f, "README frames the challenge as the zero-install cold-prospect entry").to.match(
        /cold[ -]?prospect|cold[ -]?start/
      );
      expect(f).to.match(/challenge/);
      // The README cross-link also carries the boundary (free-verify -> paid-produce + NOT sealed at T).
      expect(readmeTop).to.match(/tamper-evidence \+ signer-pin/);
    });

    it("docs/INDEPENDENT-VERIFICATION.md cross-links challenge/README.md as the guided entry point", function () {
      expect(indep, "INDEPENDENT-VERIFICATION.md links the challenge dir").to.match(
        /\(\.\.\/challenge\/\)|\.\.\/challenge\//
      );
      expect(indep, "and links the challenge README").to.match(/\.\.\/challenge\/README\.md/);
      const f = indepFlat.toLowerCase();
      expect(f).to.match(/60-second challenge|guided .* challenge|start with the .* challenge/);
      expect(f).to.match(/cold[ -]?prospect|cold/);
    });
  });

  // -----------------------------------------------------------------------
  // NO new needs-human ITEM; NO change to any proposal.
  // -----------------------------------------------------------------------
  describe("the challenge doc escalates NOTHING: no new needs-human item, no proposal change", function () {
    it("challenge/README.md introduces NO new needs-human item (only the standing P-3 pointer)", function () {
      // The challenge is FREE/UNSIGNED/key-free — it gates nothing, so it must escalate nothing. It MAY
      // restate the standing P-3 trust-root boundary (which legitimately carries needs-human upstream), but
      // every proposal pointer in the doc must be an EXISTING one (P-3), never a fresh ask, and the doc must
      // not contain the literal escalation token "needs-human".
      expect(challenge, "challenge/README.md must not introduce a needs-human item").to.not.match(/needs-human/i);
      // Every PROPOSAL reference in the challenge doc is an existing, allowed one (only P-3 here). Exclude
      // `EIP-191` and other `…IP-<n>` tokens — those are standards, not verifyhash proposal numbers.
      const pNums = challenge.match(/(?<![A-Za-z])P-\d+/g) || [];
      const allowed = new Set(["P-3"]);
      for (const p of pNums) {
        expect(allowed.has(p), `challenge/README.md references only existing proposals (got ${p})`).to.equal(true);
      }
    });

    it("the challenge doc does NOT redefine/re-sharpen any proposal (it only POINTS at P-3)", function () {
      // It must not contain proposal-redefinition verbs next to a P-<n> (e.g. "P-7 is sharpened to ...").
      const lines = challenge.split("\n");
      const sharpen = /\b(sharpen|sharpened|redefine|redefined|re-?sharpen|now reads|is updated to|amend)\b/i;
      const offenders = lines.filter((ln) => /P-\d+/.test(ln) && sharpen.test(ln));
      expect(
        offenders,
        `challenge/README.md must not re-sharpen a proposal: ${JSON.stringify(offenders)}`
      ).to.deep.equal([]);
    });

    it("neither cross-link introduces a new needs-human item near the challenge mention", function () {
      // Guard the two edited docs at the point they mention the challenge: the new prose must not carry a
      // bare "needs-human" escalation. (Both docs legitimately mention needs-human/P-3 elsewhere; we scope to
      // the challenge cross-link sentences.)
      for (const [name, text] of [
        ["README.md", readmeTop],
        ["docs/INDEPENDENT-VERIFICATION.md", indep],
      ]) {
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!/challenge\/README\.md|\.\.\/challenge\//.test(lines[i])) continue;
          // Inspect the small window around the challenge mention.
          const ctx = lines.slice(Math.max(0, i - 6), i + 7).join(" ");
          if (/needs-human/i.test(ctx)) {
            const pNums = ctx.match(/P-\d+/g) || [];
            expect(pNums.length, `${name}: a needs-human near the challenge mention names its proposal`).to.be.greaterThan(0);
            for (const p of pNums) {
              expect(
                ["P-3"].includes(p),
                `${name}: needs-human near the challenge mention rides existing P-3 (got ${p})`
              ).to.equal(true);
            }
          }
        }
      }
    });
  });
});

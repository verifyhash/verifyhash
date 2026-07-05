const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// T-3.1 docs-rot guard for the EPIC-3 reputation-layer DESIGN DOC
// (docs/REPUTATION-SBT-DESIGN.md).
//
// Pure (no chain, no fixtures). T-3.1's acceptance is: "a short design doc covering data model,
// anti-sybil, and why non-transferable; no code." This suite pins exactly that:
//   * the doc exists and covers all three mandated areas (data model / anti-sybil /
//     why non-transferable), each as a real section, plus the T-3.2 acceptance handles;
//   * it is DESIGN ONLY — the doc declares it contains no code and mechanically carries no
//     fenced code block at all (the "no code" bullet, made testable);
//   * it is grounded in the decisions and substrate it claims: D-2 resolved to Option A
//     (soulbound / non-transferable; tradeable REJECTED) in the backlog, and the registry facts
//     the design leans on (authorBound records, MIN_REVEAL_DELAY commit-reveal maturation,
//     getRecordsByContributor) still exist in contracts/ContributionRegistry.sol;
//   * the load-bearing design commitments can't silently drift: points keyed to authorBound
//     commit-reveal records only, anchorOnly never mints, one point per contentHash, credit goes
//     to record.contributor (never msg.sender), no owner/admin/revocation, no transfer/approval
//     surface, honest sybil boundary stated, and cross-links to docs/REPUTATION.md +
//     docs/TRUST-BOUNDARIES.md.
// ---------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

describe("T-3.1 design doc: docs/REPUTATION-SBT-DESIGN.md (reputation keyed to verified anchors)", function () {
  const doc = read("docs/REPUTATION-SBT-DESIGN.md");
  const docLower = doc.toLowerCase();

  describe("covers the three mandated areas as real sections", function () {
    it("has a data-model section", function () {
      expect(doc).to.match(/^##\s+1\.\s+Data model/m);
    });
    it("has an anti-sybil section", function () {
      expect(doc).to.match(/^##\s+2\.\s+Anti-sybil/m);
    });
    it("has a why-non-transferable section", function () {
      expect(doc).to.match(/^##\s+3\.\s+Why non-transferable/m);
    });
    it("hands T-3.2 concrete acceptance handles (contract name + required reverts/reads)", function () {
      expect(doc).to.match(/^##\s+4\.\s+What T-3\.2 must implement/m);
      expect(doc).to.include("contracts/ReputationSBT.sol");
      expect(docLower).to.include("double-mint reverts");
      expect(docLower).to.include("no deployment anywhere");
    });
  });

  describe("is DESIGN ONLY — no code (the acceptance's 'no code' bullet, made mechanical)", function () {
    it("declares itself design-only with no code", function () {
      expect(doc).to.include("DESIGN ONLY");
      expect(docLower).to.include("this document contains no code");
    });
    it("contains no fenced code block at all", function () {
      expect(doc).to.not.include("```");
      expect(doc).to.not.include("~~~");
    });
  });

  describe("is grounded in the resolved decisions and the real registry substrate", function () {
    it("cites D-2 resolved to Option A (soulbound / non-transferable) and the rejection of a tradeable token", function () {
      expect(doc).to.match(/D-2\s*\(RESOLVED/);
      expect(docLower).to.include("soulbound");
      expect(docLower).to.match(/tradeable token\s+rejected/);
      // ...and the backlog really does record D-2 as resolved (the doc's premise).
      const backlog = read("BACKLOG.md");
      expect(backlog).to.match(/D-2[\s\S]{0,120}RESOLVED/);
      expect(backlog.toLowerCase()).to.match(/option a:?\s*non-transferable,?\s*soulbound/);
    });
    it("the registry facts the design leans on still exist in ContributionRegistry.sol", function () {
      const registry = read("contracts/ContributionRegistry.sol");
      for (const fact of ["authorBound", "MIN_REVEAL_DELAY", "getRecordsByContributor", "contributor"]) {
        expect(registry, `registry still has ${fact}`).to.include(fact);
      }
      // The doc names the same primitives it keys reputation to.
      expect(doc).to.include("authorBound");
      expect(doc).to.include("MIN_REVEAL_DELAY");
      expect(doc).to.include("getRecordsByContributor");
    });
    it("cross-links the EPIC-12 derived-view spec and TRUST-BOUNDARIES", function () {
      expect(doc).to.include("REPUTATION.md");
      expect(doc).to.include("TRUST-BOUNDARIES.md");
    });
  });

  describe("load-bearing design commitments are stated and cannot silently drift", function () {
    it("points are keyed to authorBound (commit-reveal) records ONLY; anchorOnly never mints", function () {
      expect(doc).to.match(/`authorBound == true`/);
      expect(doc).to.match(/`anchorOnly` records[\s\S]{0,120}mint\s+\*\*nothing, ever\*\*/i);
    });
    it("one point per contentHash, credited to record.contributor (never msg.sender)", function () {
      expect(doc).to.match(/at most one point per contentHash, globally, forever/i);
      expect(doc).to.match(/never\s+`msg\.sender`/i);
    });
    it("no admin / no owner / no revocation, and non-transferability enforced by ABSENCE of a transfer surface", function () {
      expect(doc).to.match(/no admin, no owner, no revocation/i);
      expect(docLower).to.include("enforced by absence");
      expect(doc).to.match(/transferFrom|transfer, approval, or operator functions/i);
    });
    it("states the honest anti-sybil boundary: raises cost + auditability, does NOT make counts sybil-proof", function () {
      expect(doc).to.match(/do not make raw point counts sybil-proof/i);
      expect(doc).to.match(/floor of verifiable \*activity\*, never a proof of \*merit\*/i);
    });
    it("states the securities rationale for non-transferability (attestation, not an asset)", function () {
      expect(docLower).to.include("howey");
      expect(doc).to.match(/an attestation, not an asset/i);
    });
  });

  // The T-3.1 rework raised the doc's leverage: the design is no longer paper-only. It now names a pure,
  // runnable-today off-chain reference (the conformance oracle for T-3.2 and the composable consumer
  // filter). This block pins the doc's claims to the module that actually ships, so they can't drift.
  describe("is grounded in a runnable off-chain reference (not paper-only)", function () {
    const rp = require("../cli/core/reputation-points");

    it("the reference module exists and exports the projection surface the doc names", function () {
      expect(rp.projectPoints, "projectPoints export").to.be.a("function");
      expect(rp.pointsOf, "pointsOf export").to.be.a("function");
      expect(rp.hasAtLeast, "hasAtLeast export").to.be.a("function");
      expect(rp.POINT_MEANING, "POINT_MEANING export").to.be.a("string");
    });

    it("the doc points at cli/core/reputation-points.js and names its projection helpers", function () {
      expect(doc).to.include("cli/core/reputation-points.js");
      expect(doc).to.include("projectPoints");
      expect(doc).to.include("pointsOf");
      expect(doc).to.include("hasAtLeast");
    });

    it("frames the reference as the conformance oracle T-3.2's points(addr) must equal", function () {
      expect(docLower).to.match(/conformance oracle/);
      expect(doc).to.match(/points\(addr\)[\s\S]{0,80}must equal[\s\S]{0,40}pointsOf/i);
    });

    it("has a consumer-value section: composable filter, runnable with NO deploy, and NOT itself sold", function () {
      expect(doc).to.match(/^##\s+5\.\s+Consumer value/m);
      expect(docLower).to.match(/no deploy|without any deploy|zero deploy|ahead of\b[\s\S]{0,40}deploy/);
      // The honest revenue-integrity boundary: reputation is infrastructure the products CONSUME, not sold.
      expect(doc).to.match(/consume[s]?,? not (a thing that is )?sold|not a thing that is sold/i);
    });

    it("the doc's honest boundary matches the module's single-source POINT_MEANING string", function () {
      // Both must say the same thing: a floor of verifiable ACTIVITY, never proof of MERIT. Pinning them
      // together means the prose can't soften while the code's exported boundary stays honest (or vice versa).
      expect(rp.POINT_MEANING.toLowerCase()).to.match(/never a proof of merit/);
      expect(rp.POINT_MEANING.toLowerCase()).to.include("front-running-resistant");
      expect(doc).to.match(/floor of verifiable \*activity\*, never a proof of \*merit\*/i);
    });
  });
});

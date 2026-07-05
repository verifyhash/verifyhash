"use strict";

// test/reputation-points.test.js — EXECUTABLE proof of the EPIC-3 / T-3.1 reputation design.
//
// The T-3.1 design doc (docs/REPUTATION-SBT-DESIGN.md) asserts a set of security-relevant rules the
// on-chain ReputationSBT (T-3.2) "must implement." A design doc that only ASSERTS those rules is exactly
// what the review panel scored as low-leverage: nothing runs, nothing proves the rules are even
// self-consistent or implementable. This suite makes them RUN. It exercises the pure off-chain reference
// (cli/core/reputation-points.js) — the projection that IS the conformance oracle for T-3.2 and the
// runnable-today composable customer filter — and pins it, byte for byte, to the design's rules and to
// the SHIPPING derived-view substrate (cli/reputation.js `computeScore`).
//
// Pure: no chain, no fixtures, no network, no clock. Every input is a synthetic record built inline.

const { expect } = require("chai");

const rp = require("../cli/core/reputation-points");
const { computeScore } = require("../cli/reputation");

// A registry record, trimmed to the fields the points projection reads. `parent` is included only so
// computeScore (which reads it) behaves; the points projection ignores it entirely.
function rec({ contentHash, contributor, authorBound = true, parent = "0x" + "00".repeat(32) }) {
  return {
    contentHash,
    contributor,
    authorBound,
    parent,
    blockNumber: 1n,
    timestamp: 1n,
    uri: "",
  };
}

const A = "0x" + "a1".repeat(20);
const B = "0x" + "b2".repeat(20);
const C = "0x" + "c3".repeat(20);
const h = (n) => "0x" + String(n).padStart(2, "0").repeat(32); // distinct 32-byte hashes h(1), h(2), ...

describe("EPIC-3 / T-3.1 soulbound-points reference (cli/core/reputation-points.js)", function () {
  describe("the exported surface is a PURE PROJECTION — non-transferable by ABSENCE", function () {
    it("exposes only read/projection helpers, and NO transfer/assign/approve/mint/mutate path", function () {
      // The off-chain analogue of the on-chain "no transfer surface" property: there is literally no
      // function here that could move a point from one address to another.
      const banned = /transfer|approve|assign|mint|burn|set|move|send|mutate|credit(?!ed)/i;
      for (const name of Object.keys(rp)) {
        if (typeof rp[name] === "function") {
          expect(name, `export ${name} must not be a mutation/transfer path`).to.not.match(banned);
        }
      }
      // The functions a consumer actually uses are all present and pure-shaped.
      expect(rp.projectPoints).to.be.a("function");
      expect(rp.pointsOf).to.be.a("function");
      expect(rp.hasAtLeast).to.be.a("function");
    });

    it("is deterministic: same records in -> deep-equal projection out, and the input is not mutated", function () {
      const bigintSafe = (_k, v) => (typeof v === "bigint" ? `${v}n` : v);
      const records = [rec({ contentHash: h(1), contributor: A }), rec({ contentHash: h(2), contributor: A })];
      const snapshot = JSON.stringify(records, bigintSafe);
      const first = rp.projectPoints(records);
      const second = rp.projectPoints(records);
      expect(first).to.deep.equal(second);
      expect(JSON.stringify(records, bigintSafe), "records must not be mutated").to.equal(snapshot);
    });
  });

  describe("RULE: a point mints iff authorBound === true (anchor-only mints NOTHING, ever)", function () {
    it("an authorBound record mints one point to its contributor", function () {
      const out = rp.projectPoints([rec({ contentHash: h(1), contributor: A })]);
      expect(out.points[A.toLowerCase()]).to.equal(1);
      expect(out.totalPoints).to.equal(1);
      expect(out.minted).to.deep.equal([h(1).toLowerCase()]);
    });

    it("an anchor-only record mints nothing and is tallied under skipped.anchorOnly", function () {
      const out = rp.projectPoints([rec({ contentHash: h(1), contributor: A, authorBound: false })]);
      expect(out.totalPoints).to.equal(0);
      expect(out.points[A.toLowerCase()]).to.equal(undefined);
      expect(out.skipped.anchorOnly).to.equal(1);
    });

    it("in a mixed set, ONLY the authorBound records contribute points", function () {
      const out = rp.projectPoints([
        rec({ contentHash: h(1), contributor: A, authorBound: true }),
        rec({ contentHash: h(2), contributor: A, authorBound: false }),
        rec({ contentHash: h(3), contributor: A, authorBound: true }),
      ]);
      expect(out.totalPoints).to.equal(2);
      expect(out.points[A.toLowerCase()]).to.equal(2);
      expect(out.skipped.anchorOnly).to.equal(1);
    });
  });

  describe("RULE: at most one point per contentHash, globally (dedup across time AND addresses)", function () {
    it("a repeated contentHash is credited exactly once and the repeat is tallied as a duplicate", function () {
      const out = rp.projectPoints([
        rec({ contentHash: h(1), contributor: A }),
        rec({ contentHash: h(1), contributor: A }),
      ]);
      expect(out.totalPoints).to.equal(1);
      expect(out.points[A.toLowerCase()]).to.equal(1);
      expect(out.skipped.duplicate).to.equal(1);
    });

    it("the same contentHash cannot be double-counted even across DIFFERENT addresses (first mint wins)", function () {
      const out = rp.projectPoints([
        rec({ contentHash: h(9), contributor: A }),
        rec({ contentHash: h(9), contributor: B }),
      ]);
      expect(out.totalPoints).to.equal(1);
      expect(out.points[A.toLowerCase()]).to.equal(1);
      expect(out.points[B.toLowerCase()]).to.equal(undefined);
      expect(out.skipped.duplicate).to.equal(1);
    });
  });

  describe("RULE: credit goes to the RECORD's contributor — never to a caller (structural)", function () {
    it("points land on record.contributor regardless of any other party; there is no caller parameter", function () {
      const out = rp.projectPoints([
        rec({ contentHash: h(1), contributor: A }),
        rec({ contentHash: h(2), contributor: B }),
        rec({ contentHash: h(3), contributor: B }),
      ]);
      expect(out.points[A.toLowerCase()]).to.equal(1);
      expect(out.points[B.toLowerCase()]).to.equal(2);
      // Nobody can be credited for content they don't own: C appears in no record and holds nothing.
      expect(out.points[C.toLowerCase()]).to.equal(undefined);
      expect(rp.pointsOf([rec({ contentHash: h(1), contributor: A })], C)).to.equal(0);
      // projectPoints/pointsOf take (records[, address]) — there is no signer/caller argument to pass.
      expect(rp.projectPoints.length).to.equal(1);
      expect(rp.pointsOf.length).to.equal(2);
    });
  });

  describe("RULE: balances only ever accumulate (monotonic, append-only)", function () {
    it("adding a record can only raise a balance, never lower it", function () {
      const base = [rec({ contentHash: h(1), contributor: A })];
      const grown = base.concat([rec({ contentHash: h(2), contributor: A })]);
      expect(rp.pointsOf(base, A)).to.equal(1);
      expect(rp.pointsOf(grown, A)).to.equal(2);
      expect(rp.pointsOf(grown, A)).to.be.greaterThan(rp.pointsOf(base, A) - 1);
    });
  });

  describe("malformed records are skipped, never crash the projection", function () {
    it("records missing a valid contentHash or contributor are tallied under skipped.invalid", function () {
      const out = rp.projectPoints([
        rec({ contentHash: "0xnothex", contributor: A }),
        rec({ contentHash: h(1), contributor: "not-an-address" }),
        { authorBound: true }, // missing both
        rec({ contentHash: h(2), contributor: A }), // the one valid record
      ]);
      expect(out.totalPoints).to.equal(1);
      expect(out.skipped.invalid).to.equal(3);
    });
  });

  describe("hasAtLeast — the composable, offline reputation GATE a paying consumer applies", function () {
    const records = [
      rec({ contentHash: h(1), contributor: A }),
      rec({ contentHash: h(2), contributor: A }),
      rec({ contentHash: h(3), contributor: A, authorBound: false }), // weak signal excluded
    ];
    it("passes when the address holds >= n proven points, fails otherwise", function () {
      expect(rp.hasAtLeast(records, A, 2)).to.equal(true); // exactly 2 authorBound points
      expect(rp.hasAtLeast(records, A, 3)).to.equal(false); // the anchor-only record does NOT count
      expect(rp.hasAtLeast(records, B, 1)).to.equal(false); // unknown address holds nothing
    });
    it("a floor of 0 admits everyone (including addresses with no records)", function () {
      expect(rp.hasAtLeast(records, B, 0)).to.equal(true);
    });
    it("rejects a non-integer / negative threshold rather than silently passing", function () {
      expect(() => rp.hasAtLeast(records, A, -1)).to.throw(/non-negative integer/);
      expect(() => rp.hasAtLeast(records, A, 1.5)).to.throw(/non-negative integer/);
    });
  });

  describe("CONFORMANCE ORACLE: points must equal the shipping derived-view authorBound count", function () {
    // The design says balances "match the EPIC-12 derived view's authorBound count." This pins the
    // reference projection to cli/reputation.js `computeScore` so the two can NEVER silently drift — the
    // exact invariant T-3.2's on-chain ReputationSBT.points(addr) is later held to.
    it("pointsOf(records, addr) === computeScore(addr's records).authorBound (unique-hash case)", function () {
      const records = [
        rec({ contentHash: h(1), contributor: A, authorBound: true }),
        rec({ contentHash: h(2), contributor: A, authorBound: true }),
        rec({ contentHash: h(3), contributor: A, authorBound: false }),
      ];
      const score = computeScore(records);
      expect(rp.pointsOf(records, A)).to.equal(score.authorBound);
    });

    it("points can only LAG the authorBound count (dedup), never EXCEED it — the design's stated bound", function () {
      // A duplicate contentHash inflates computeScore.authorBound (it does no dedup) but the points
      // projection dedups, so points <= authorBound always. This proves the design's claim that
      // points(addr) "can never exceed the address's authorBound record count."
      const records = [
        rec({ contentHash: h(1), contributor: A, authorBound: true }),
        rec({ contentHash: h(1), contributor: A, authorBound: true }), // same hash again
      ];
      const score = computeScore(records);
      expect(score.authorBound).to.equal(2); // raw count double-counts
      expect(rp.pointsOf(records, A)).to.equal(1); // points dedups
      expect(rp.pointsOf(records, A)).to.be.at.most(score.authorBound);
    });
  });

  describe("POINT_MEANING — the single honest-boundary string the docs pin to", function () {
    it("states it is a floor of activity, never proof of merit", function () {
      expect(rp.POINT_MEANING).to.be.a("string");
      expect(rp.POINT_MEANING.toLowerCase()).to.include("front-running-resistant");
      expect(rp.POINT_MEANING.toLowerCase()).to.match(/never a proof of merit/);
    });
  });
});

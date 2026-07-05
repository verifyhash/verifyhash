"use strict";

// cli/core/reputation-points.js — the OFF-CHAIN SOULBOUND-POINTS PROJECTION (EPIC-3 / T-3.1).
//
// WHAT THIS IS
//   The pure, deployment-free REFERENCE for the reputation layer specified in
//   docs/REPUTATION-SBT-DESIGN.md. Given a set of ContributionRegistry records (the exact objects the
//   shipping read path `cli/reputation.js › readContributorRecords` already returns), it computes the
//   soulbound POINTS an on-chain `ReputationSBT` (T-3.2) would hold — applying the design's rules
//   EXACTLY:
//     * a record mints ONE point iff `authorBound === true` (a proven, front-running-resistant
//       commit-reveal claim); an anchor-only record (`authorBound === false`) mints NOTHING, ever;
//     * at most ONE point per unique `contentHash`, globally (dedup) — the same content can never be
//       counted twice, across addresses or across time;
//     * the point is credited to the record's own `contributor` — there is NO concept of a caller in
//       this module at all, which is the structural proof that a mint can never be redirected to
//       `msg.sender`;
//     * points only ever ACCUMULATE (monotonic, append-only, like the registry itself).
//
// WHY IT EXISTS (the leverage T-3.1's design doc could not deliver on paper)
//   1. RUNNABLE TODAY, ZERO DEPLOY. The on-chain contract (T-3.2) needs the human-gated P-2 deploy
//      before it means anything. This projection needs NONE of that: a consumer feeds it the records
//      the live registry already exposes and gets the identical points a deployed ReputationSBT would
//      report. So the reputation layer delivers value BEFORE the deploy, not only after it.
//   2. THE CONFORMANCE ORACLE. The design says the contract's balances "match the EPIC-12 derived
//      view's authorBound count after minting all records." This module IS that oracle, made
//      executable — T-3.2's contract is correct iff `points(addr)` equals `pointsOf(records, addr)`
//      here for the same records. Tests pin the two together so neither can silently drift.
//   3. THE COMPOSABLE CUSTOMER FILTER. A paying verification/evidence integration that wants to gate
//      or weight acceptance by contributor reputation ("only honor claims from addresses with >= N
//      proven, front-running-resistant contributions") calls `hasAtLeast(records, addr, n)` — a pure,
//      offline, re-derivable predicate over records it can already fetch. No token, no custody, no
//      deploy.
//
// NON-TRANSFERABILITY BY ABSENCE (mirrors the on-chain design)
//   This module exposes ONLY pure projections — there is NO transfer / assign / approve / mutate / set
//   surface. Points are a deterministic function of the records; there is no state to move. That is the
//   off-chain analogue of the contract's "non-transferable enforced by the ABSENCE of a transfer path."
//
// HONEST BOUNDARY (POINT_MEANING is the single source of truth the docs pin to)
//   A point means EXACTLY: "this address provably made this front-running-resistant claim, once per
//   content." It is a floor of verifiable ACTIVITY, never a proof of MERIT: content quality, novelty,
//   and value are out of scope, and a determined sybil can still commit-reveal N junk hashes from N
//   addresses and mint N points, paying gas each time. See docs/REPUTATION-SBT-DESIGN.md §2 and
//   docs/TRUST-BOUNDARIES.md — every caveat there applies unchanged.
//
// PURITY DISCIPLINE (cli/core/*): no fs, no network, no clock, no new dependency. Everything is a pure
// function of the caller-supplied records. Deterministic: same records in -> same projection out.

/** A 0x-prefixed 20-byte hex address (case-insensitive). Validation only; never touches the network. */
const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** A 0x-prefixed 32-byte hex contentHash (case-insensitive). */
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;

// The load-bearing, honest definition of a single point. Exported so docs/NatSpec pin against THIS
// string instead of paraphrasing it (the same discipline as cli/list.js's ATTRIBUTION_* constants).
const POINT_MEANING =
  "a point means: this address provably made this front-running-resistant (commit-reveal) claim, " +
  "exactly once per content — a floor of verifiable activity, NEVER a proof of merit, content " +
  "quality, or value";

/**
 * Lower-case a validated 20-byte hex address for use as a stable map key. Rejects anything that is not
 * a 0x-prefixed 40-hex-nibble string. (Lower-casing, not checksumming, keeps this module dependency-free
 * and is sufficient for keying: EIP-55 checksums differ only in letter case.)
 * @param {string} a
 * @returns {string} the lower-cased address
 */
function normalizeAddress(a) {
  if (typeof a !== "string" || !HEX_ADDRESS_RE.test(a)) {
    throw new Error(`invalid address: ${String(a)} (expected a 20-byte 0x-hex address)`);
  }
  return a.toLowerCase();
}

/** Lower-case a validated 32-byte contentHash for stable comparison. */
function normalizeContentHash(h) {
  if (typeof h !== "string" || !HEX32_RE.test(h)) return null;
  return h.toLowerCase();
}

/**
 * Project a set of registry records into the soulbound-points state a `ReputationSBT` would hold.
 *
 * Pure and deterministic: records are processed in the given order, and re-running on the same input
 * yields a deep-equal result. A record that is malformed (missing/!hex contentHash or contributor) or
 * that is anchor-only, or whose contentHash was already minted, contributes NOTHING and is tallied under
 * `skipped` so the projection is fully auditable.
 *
 * @param {Array<{contentHash?:string, contributor?:string, authorBound?:boolean}>} records
 * @returns {{
 *   points: Object.<string, number>,        // address (lower-case) -> point balance
 *   totalPoints: number,                     // sum of all balances
 *   minted: string[],                        // contentHashes credited, in mint order
 *   credited: Array<{contentHash:string, contributor:string}>,  // one entry per minted point
 *   skipped: { anchorOnly:number, duplicate:number, invalid:number }
 * }}
 */
function projectPoints(records) {
  if (!Array.isArray(records)) {
    throw new Error("projectPoints requires an array of records");
  }
  const points = Object.create(null);
  const mintedSet = new Set();
  const minted = [];
  const credited = [];
  const skipped = { anchorOnly: 0, duplicate: 0, invalid: 0 };

  for (const r of records || []) {
    const contentHash = r && normalizeContentHash(r.contentHash);
    let contributor;
    try {
      contributor = r && normalizeAddress(r.contributor);
    } catch (_e) {
      contributor = null;
    }
    // A record must name both a valid content hash and a valid contributor to be considered at all.
    if (!contentHash || !contributor) {
      skipped.invalid++;
      continue;
    }
    // Anchor-only records prove first-anchoring, not authorship — they mint nothing, ever.
    if (!Boolean(r.authorBound)) {
      skipped.anchorOnly++;
      continue;
    }
    // One point per contentHash, globally — the same content can never be counted twice.
    if (mintedSet.has(contentHash)) {
      skipped.duplicate++;
      continue;
    }
    // Mint: credit the RECORD's contributor (never a caller — there is no caller here by construction).
    mintedSet.add(contentHash);
    minted.push(contentHash);
    credited.push({ contentHash, contributor });
    points[contributor] = (points[contributor] || 0) + 1;
  }

  let totalPoints = 0;
  for (const k of Object.keys(points)) totalPoints += points[k];

  return { points, totalPoints, minted, credited, skipped };
}

/**
 * The soulbound point balance a single address would hold. Pure; re-derivable by anyone from the same
 * records. This is the exact value a deployed `ReputationSBT.points(addr)` must equal (the conformance
 * oracle for T-3.2).
 * @param {Array} records
 * @param {string} address
 * @returns {number}
 */
function pointsOf(records, address) {
  const key = normalizeAddress(address);
  const { points } = projectPoints(records);
  return points[key] || 0;
}

/**
 * The composable, offline reputation GATE a paying consumer applies: does `address` hold at least `n`
 * proven, front-running-resistant contribution points? `n` must be a non-negative integer; `n === 0` is
 * always true (a floor of zero admits everyone). Returns a plain boolean — no token, no key, no deploy.
 * @param {Array} records
 * @param {string} address
 * @param {number} n
 * @returns {boolean}
 */
function hasAtLeast(records, address, n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`hasAtLeast: threshold n must be a non-negative integer, got ${String(n)}`);
  }
  return pointsOf(records, address) >= n;
}

module.exports = {
  projectPoints,
  pointsOf,
  hasAtLeast,
  normalizeAddress,
  normalizeContentHash,
  POINT_MEANING,
  HEX_ADDRESS_RE,
  HEX32_RE,
};

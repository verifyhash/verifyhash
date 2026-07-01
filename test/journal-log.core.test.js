"use strict";

// test/journal-log.core.test.js — DIRECT coverage of the pure ORDERED MERKLE-LOG CORE
// (cli/journal-log.js, T-63.1): an RFC-6962 / Certificate-Transparency-style position-preserving Merkle
// tree over ordered journal entry hashes.
//
// WHAT THIS PROVES (the T-63.1 acceptance criteria, each as an honest test):
//   1. treeHead is deterministic; its root differs from the SORTED-tree root of cli/hash.js buildTree on
//      the SAME leaves in a case where order matters (position-preservation); empty log -> EMPTY_ROOT;
//      single leaf -> leafHash(leaf0).
//   2. For every i in a size-n log, verifyInclusion ACCEPTS the honest inclusionProof and REJECTS a
//      tampered leaf, a wrong leafIndex, a truncated/extended path, and a replay against a DIFFERENT
//      size/root. Never a false accept.
//   3. For every 0<m<=n, verifyConsistency ACCEPTS the honest consistencyProof and REJECTS a proof where
//      the size-n log is NOT an append-only extension of size-m (rewritten past leaf / reordered prefix).
//   4. All functions are pure (no I/O, no clock) and never throw on malformed/adversarial input (they
//      return false / named results). A static grep asserts cli/journal-log.js requires ONLY cli/hash.js
//      + ethers byte helpers — NONE of fs/http/https/net/dns, and no signer/keyfile work.
//
// PURITY: this suite touches NO filesystem for the core under test (except reading cli/journal-log.js as
// TEXT for the static grep). No temp dirs, no sockets, no keys.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { toUtf8Bytes } = require("ethers");

const log = require("../cli/journal-log");
const {
  treeHead,
  inclusionProof,
  verifyInclusion,
  consistencyProof,
  verifyConsistency,
  leafHash,
  nodeHash,
  EMPTY_ROOT,
} = log;

const { hashBytes, buildTree } = require("../cli/hash");

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

// Deterministic, distinct, well-formed 0x-bytes32 leaf values.
function leafVal(i) {
  return hashBytes(toUtf8Bytes("vh.journal-log.test/leaf/" + i));
}
function leavesUpTo(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(leafVal(i));
  return out;
}

// The largest tree size exercised by the exhaustive loops. Includes powers of two (16), just-below
// (15) and just-above (17) so both branches of every algorithm are covered.
const N = 17;

describe("cli/journal-log.js — pure ordered Merkle-log core (T-63.1)", function () {
  // -------------------------------------------------------------------------------------------------
  describe("treeHead: deterministic, position-preserving, documented edges (criterion 1)", function () {
    it("empty log returns the documented EMPTY_ROOT", function () {
      const h = treeHead([]);
      expect(h.size).to.equal(0);
      expect(h.root).to.equal(EMPTY_ROOT);
      expect(EMPTY_ROOT).to.match(HEX32);
    });

    it("single-leaf tree's root equals leafHash(leaf0)", function () {
      const l0 = leafVal(0);
      const h = treeHead([l0]);
      expect(h.size).to.equal(1);
      expect(h.root).to.equal(leafHash(l0));
      expect(h.root).to.match(HEX32);
    });

    it("is deterministic: same leaves -> byte-identical root", function () {
      const leaves = leavesUpTo(7);
      expect(treeHead(leaves).root).to.equal(treeHead(leaves.slice()).root);
    });

    it("ORDER MATTERS: reordering the leaves changes the root (position-preserving)", function () {
      const leaves = leavesUpTo(3);
      const swapped = [leaves[1], leaves[0], leaves[2]];
      expect(treeHead(leaves).root).to.not.equal(treeHead(swapped).root);
    });

    it("root DIFFERS from cli/hash.js buildTree (sorted) root on the same order-sensitive leaves", function () {
      // Pick leaves whose given order is NOT their sorted-by-value order, so buildTree (which sorts)
      // and treeHead (which preserves position) cannot coincide.
      const a = "0x" + "cc".repeat(32);
      const b = "0x" + "aa".repeat(32);
      const c = "0x" + "bb".repeat(32);
      const leaves = [a, b, c]; // descending-ish; buildTree will sort to [aa, bb, cc]
      const ordered = treeHead(leaves).root;
      const sorted = buildTree(leaves).root;
      expect(ordered).to.match(HEX32);
      expect(sorted).to.match(HEX32);
      expect(ordered).to.not.equal(sorted);

      // And buildTree is order-INSENSITIVE (it sorts) while treeHead is order-SENSITIVE — the essence
      // of position-preservation.
      const reordered = [b, c, a];
      expect(buildTree(leaves).root).to.equal(buildTree(reordered).root);
      expect(treeHead(leaves).root).to.not.equal(treeHead(reordered).root);
    });

    it("root recomputes by hand for a 2-leaf tree: nodeHash(leafHash(l0), leafHash(l1))", function () {
      const l0 = leafVal(0);
      const l1 = leafVal(1);
      expect(treeHead([l0, l1]).root).to.equal(nodeHash(leafHash(l0), leafHash(l1)));
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe("inclusion: accept honest, reject every tamper (criterion 2)", function () {
    it("ACCEPTS the honest inclusionProof for every index in every size 1..N", function () {
      for (let n = 1; n <= N; n++) {
        const leaves = leavesUpTo(n);
        const root = treeHead(leaves).root;
        for (let i = 0; i < n; i++) {
          const proof = inclusionProof(leaves, i);
          expect(proof, `size ${n} index ${i}`).to.be.an("object");
          expect(proof.leaf).to.equal(leaves[i]);
          expect(proof.leafIndex).to.equal(i);
          expect(proof.treeSize).to.equal(n);
          expect(verifyInclusion(proof, root), `size ${n} index ${i}`).to.equal(true);
        }
      }
    });

    it("REJECTS a tampered leaf", function () {
      for (let n = 1; n <= N; n++) {
        const leaves = leavesUpTo(n);
        const root = treeHead(leaves).root;
        for (let i = 0; i < n; i++) {
          const proof = inclusionProof(leaves, i);
          const tampered = { ...proof, leaf: leafVal(9999) };
          expect(verifyInclusion(tampered, root), `size ${n} index ${i}`).to.equal(false);
        }
      }
    });

    it("REJECTS a wrong leafIndex", function () {
      for (let n = 2; n <= N; n++) {
        const leaves = leavesUpTo(n);
        const root = treeHead(leaves).root;
        for (let i = 0; i < n; i++) {
          const proof = inclusionProof(leaves, i);
          const wrong = (i + 1) % n; // a different in-range index
          const bad = { ...proof, leafIndex: wrong };
          expect(verifyInclusion(bad, root), `size ${n} index ${i}->${wrong}`).to.equal(false);
        }
      }
    });

    it("REJECTS a truncated OR extended path", function () {
      for (let n = 2; n <= N; n++) {
        const leaves = leavesUpTo(n);
        const root = treeHead(leaves).root;
        for (let i = 0; i < n; i++) {
          const proof = inclusionProof(leaves, i);
          if (proof.path.length > 0) {
            const truncated = { ...proof, path: proof.path.slice(0, -1) };
            expect(verifyInclusion(truncated, root), `trunc size ${n} idx ${i}`).to.equal(false);
          }
          const extended = { ...proof, path: proof.path.concat([leafVal(1234)]) };
          expect(verifyInclusion(extended, root), `ext size ${n} idx ${i}`).to.equal(false);
        }
      }
    });

    it("REJECTS a proof replayed against a DIFFERENT head (bumped size + that tree's real root)", function () {
      // A size-n proof, presented as if it proves inclusion in the size-(n+1) tree (claimed treeSize =
      // n+1) and checked against that bigger tree's REAL root, must fail for every index. (Checking a
      // bumped size against the SAME root is intentionally NOT a rejection case: for some indices sizes
      // n and n+1 share a decomposition, and a proof is genuinely bound to a ROOT, not to a size label —
      // so a real committed head, which is a (size, root) pair, is the honest thing to replay against.)
      for (let n = 1; n <= N; n++) {
        const leaves = leavesUpTo(n);
        const biggerRoot = treeHead(leavesUpTo(n + 1)).root;
        for (let i = 0; i < n; i++) {
          const proof = inclusionProof(leaves, i);
          const replayed = { ...proof, treeSize: n + 1 };
          expect(verifyInclusion(replayed, biggerRoot), `replay-head ${n} idx ${i}`).to.equal(false);
        }
      }
    });

    it("REJECTS a proof replayed against a DIFFERENT root (a bigger tree's head)", function () {
      for (let n = 1; n <= N; n++) {
        const leaves = leavesUpTo(n);
        const proof = inclusionProof(leaves, n - 1);
        // The SAME proof (for a size-n tree) verified against a size-(n+1) tree's root must fail.
        const biggerRoot = treeHead(leavesUpTo(n + 1)).root;
        expect(verifyInclusion(proof, biggerRoot), `replay size ${n}`).to.equal(false);
      }
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe("consistency: accept honest, reject non-append-only (criterion 3)", function () {
    it("ACCEPTS the honest consistencyProof for every 0<m<=n<=N", function () {
      for (let n = 1; n <= N; n++) {
        const leaves = leavesUpTo(n);
        const root2 = treeHead(leaves).root;
        for (let m = 1; m <= n; m++) {
          const proof = consistencyProof(leaves, m, n);
          expect(proof, `m ${m} n ${n}`).to.be.an("object");
          const root1 = treeHead(leaves.slice(0, m)).root;
          expect(verifyConsistency(proof, root1, root2), `m ${m} n ${n}`).to.equal(true);
        }
      }
    });

    it("append-only holds across a longer log (each prefix consistent with the full log)", function () {
      const leaves = leavesUpTo(N);
      const full = treeHead(leaves).root;
      for (let m = 1; m <= N; m++) {
        const proof = consistencyProof(leaves, m, N);
        const root1 = treeHead(leaves.slice(0, m)).root;
        expect(verifyConsistency(proof, root1, full), `prefix ${m}`).to.equal(true);
      }
    });

    it("REJECTS a REWRITTEN past leaf (size-n log is not an extension of the committed size-m root)", function () {
      // For each m<n: the auditor holds the ORIGINAL size-m root (root1). A malicious operator publishes
      // a size-n log that REWROTE a leaf inside the first m positions and offers its own honest proof.
      // Because root1 commits to the original prefix, no proof can bridge it to the rewritten log.
      for (let n = 2; n <= N; n++) {
        const orig = leavesUpTo(n);
        for (let m = 1; m < n; m++) {
          const root1 = treeHead(orig.slice(0, m)).root; // committed original prefix root
          const j = m - 1; // rewrite a leaf inside the first m positions
          const tampered = orig.slice();
          tampered[j] = leafVal(50000 + j); // a different value at a PAST position
          const badProof = consistencyProof(tampered, m, n); // operator's own honest proof for its log
          const root2 = treeHead(tampered).root;
          expect(verifyConsistency(badProof, root1, root2), `rewrite m ${m} n ${n}`).to.equal(false);
        }
      }
    });

    it("REJECTS a REORDERED prefix (order is meaning; a swap is not append-only)", function () {
      for (let n = 3; n <= N; n++) {
        const orig = leavesUpTo(n);
        for (let m = 2; m < n; m++) {
          const root1 = treeHead(orig.slice(0, m)).root; // original prefix root
          const reordered = orig.slice();
          const tmp = reordered[0];
          reordered[0] = reordered[1];
          reordered[1] = tmp; // swap the first two PAST leaves
          const badProof = consistencyProof(reordered, m, n);
          const root2 = treeHead(reordered).root;
          expect(verifyConsistency(badProof, root1, root2), `reorder m ${m} n ${n}`).to.equal(false);
        }
      }
    });

    it("REJECTS an honest proof verified against a WRONG second root", function () {
      const leaves = leavesUpTo(N);
      const root1 = treeHead(leaves.slice(0, 5)).root;
      const proof = consistencyProof(leaves, 5, N);
      const wrongSecond = treeHead(leavesUpTo(N + 3)).root;
      expect(verifyConsistency(proof, root1, wrongSecond)).to.equal(false);
    });

    it("m===n accepts only with an empty proof and identical roots", function () {
      const leaves = leavesUpTo(6);
      const root = treeHead(leaves).root;
      const proof = consistencyProof(leaves, 6, 6);
      expect(proof.path).to.deep.equal([]);
      expect(verifyConsistency(proof, root, root)).to.equal(true);
      // Same size but different roots => reject.
      expect(verifyConsistency(proof, root, treeHead(leavesUpTo(7)).root)).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe("TOTALITY: pure, never throws on malformed/adversarial input (criterion 4)", function () {
    it("treeHead returns a named result (root:null) on garbage, never throws", function () {
      for (const bad of [null, undefined, 7, "x", {}, [1, 2, 3], ["0xnothex"], [leafVal(0), 5]]) {
        let r;
        expect(() => (r = treeHead(bad)), JSON.stringify(bad)).to.not.throw();
        expect(r.root, JSON.stringify(bad)).to.equal(null);
      }
    });

    it("inclusionProof returns null on garbage, never throws", function () {
      const leaves = leavesUpTo(4);
      const cases = [
        [null, 0],
        [leaves, -1],
        [leaves, 4],
        [leaves, 1.5],
        [leaves, "0"],
        [[leafVal(0), "0xnope"], 0],
      ];
      for (const [lv, i] of cases) {
        let r;
        expect(() => (r = inclusionProof(lv, i))).to.not.throw();
        expect(r).to.equal(null);
      }
    });

    it("verifyInclusion returns false (never throws) on malformed proofs", function () {
      const leaves = leavesUpTo(5);
      const root = treeHead(leaves).root;
      const good = inclusionProof(leaves, 2);
      const bads = [
        null,
        undefined,
        {},
        [],
        "proof",
        { ...good, leaf: "0xnothex" },
        { ...good, path: "notarray" },
        { ...good, path: [42] },
        { ...good, leafIndex: "2" },
        { ...good, treeSize: -1 },
        { ...good, leafIndex: 99 },
      ];
      for (const b of bads) {
        let r;
        expect(() => (r = verifyInclusion(b, root)), JSON.stringify(b)).to.not.throw();
        expect(r, JSON.stringify(b)).to.equal(false);
      }
      // Also a malformed root.
      expect(verifyInclusion(good, "0xnope")).to.equal(false);
      expect(verifyInclusion(good, null)).to.equal(false);
    });

    it("consistencyProof returns null on garbage, never throws", function () {
      const leaves = leavesUpTo(4);
      const cases = [
        [null, 1, 2],
        [leaves, 0, 2], // m must be > 0
        [leaves, 3, 2], // n < m
        [leaves, 1, 99], // n > length
        [leaves, 1.5, 2],
        [[leafVal(0), "0xnope"], 1, 2],
      ];
      for (const [lv, m, n] of cases) {
        let r;
        expect(() => (r = consistencyProof(lv, m, n))).to.not.throw();
        expect(r, `${JSON.stringify(lv)} ${m} ${n}`).to.equal(null);
      }
    });

    it("verifyConsistency returns false (never throws) on malformed proofs", function () {
      const leaves = leavesUpTo(6);
      const root1 = treeHead(leaves.slice(0, 3)).root;
      const root2 = treeHead(leaves).root;
      const good = consistencyProof(leaves, 3, 6);
      const bads = [
        null,
        undefined,
        {},
        [],
        "proof",
        { ...good, path: "notarray" },
        { ...good, path: [1, 2] },
        { ...good, firstSize: "3" },
        { ...good, secondSize: null },
      ];
      for (const b of bads) {
        let r;
        expect(() => (r = verifyConsistency(b, root1, root2)), JSON.stringify(b)).to.not.throw();
        expect(r, JSON.stringify(b)).to.equal(false);
      }
      // Malformed roots.
      expect(verifyConsistency(good, "0xnope", root2)).to.equal(false);
      expect(verifyConsistency(good, root1, null)).to.equal(false);
    });

    it("verify* are deterministic (no clock/randomness): same inputs -> same answer", function () {
      const leaves = leavesUpTo(9);
      const root = treeHead(leaves).root;
      const ip = inclusionProof(leaves, 4);
      expect(verifyInclusion(ip, root)).to.equal(verifyInclusion(ip, root));
      const cp = consistencyProof(leaves, 4, 9);
      const r1 = treeHead(leaves.slice(0, 4)).root;
      expect(verifyConsistency(cp, r1, root)).to.equal(verifyConsistency(cp, r1, root));
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe("STATIC purity guard (criterion 4): only cli/hash.js + ethers byte helpers", function () {
    let src;
    before(function () {
      src = fs.readFileSync(path.join(__dirname, "..", "cli", "journal-log.js"), "utf8");
    });

    it("requires NONE of fs / http / https / net / dns / tls / dgram", function () {
      for (const mod of ["fs", "http", "https", "net", "dns", "tls", "dgram"]) {
        const re = new RegExp("require\\(\\s*['\"]" + mod + "['\"]\\s*\\)");
        expect(re.test(src), `must not require '${mod}'`).to.equal(false);
      }
    });

    it("requires ONLY ./hash and ethers", function () {
      const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
      expect(requires.length).to.be.greaterThan(0);
      for (const r of requires) {
        expect(["./hash", "ethers"], `unexpected require('${r}')`).to.include(r);
      }
    });

    it("does no signer/keyfile work (no Wallet, no private key, no fs read/write)", function () {
      expect(/\bWallet\b/.test(src), "must not reference Wallet").to.equal(false);
      expect(
        /privateKey|PRIVATE_KEY|readFileSync|writeFileSync|openSync/.test(src),
        "must do no key/fs I/O"
      ).to.equal(false);
    });

    it("has no clock or randomness (pure, deterministic)", function () {
      expect(/Date\.now|new Date\b|Math\.random|randomBytes/.test(src)).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------------------------------
  // The verifiers also accept the FULL head { size, root } (a real Signed-Tree-Head is a (size, root)
  // pair). Passing the head BINDS the size, so a proof that lies about its own size is rejected even
  // when its path would reconstruct the same root — the strongest form of "reject a size replay".
  // -------------------------------------------------------------------------------------------------
  describe("head-binding: verifiers accept a {size,root} head and bind the trusted size", function () {
    it("verifyInclusion accepts against the full head for every index/size and rejects a size lie", function () {
      for (let n = 1; n <= N; n++) {
        const leaves = leavesUpTo(n);
        const head = treeHead(leaves);
        for (let i = 0; i < n; i++) {
          const proof = inclusionProof(leaves, i);
          expect(verifyInclusion(proof, head), `head-accept ${n}/${i}`).to.equal(true);
          // A proof lying about its treeSize is rejected against the head (which pins the real size),
          // even for indices where a bare-root check could not tell the sizes apart.
          expect(verifyInclusion({ ...proof, treeSize: n + 1 }, head), `size-lie ${n}/${i}`).to.equal(
            false
          );
        }
      }
    });

    it("verifyConsistency accepts against full heads and rejects a first/second size lie", function () {
      const leaves = leavesUpTo(N);
      const secondHead = treeHead(leaves);
      for (let m = 1; m < N; m++) {
        const firstHead = treeHead(leaves.slice(0, m));
        const proof = consistencyProof(leaves, m, N);
        expect(verifyConsistency(proof, firstHead, secondHead), `head-accept ${m}`).to.equal(true);
        if (m > 1) {
          expect(verifyConsistency({ ...proof, firstSize: m - 1 }, firstHead, secondHead)).to.equal(false);
        }
        expect(verifyConsistency({ ...proof, secondSize: N - 1 }, firstHead, secondHead)).to.equal(false);
      }
    });

    it("a head whose root is malformed is still rejected (no throw)", function () {
      const leaves = leavesUpTo(5);
      const proof = inclusionProof(leaves, 2);
      expect(verifyInclusion(proof, { size: 5, root: "0xnope" })).to.equal(false);
      const cp = consistencyProof(leaves, 2, 5);
      expect(verifyConsistency(cp, { size: 2, root: "0xnope" }, treeHead(leaves))).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------------------------------
  // Integration: the log genuinely operates over the JOURNAL's ORDERED entry hashes (cli/journal.js),
  // which is the whole point of T-63.1 (a transparency log ON TOP of the append-only hash chain).
  // -------------------------------------------------------------------------------------------------
  describe("integration with cli/journal.js: over real ordered entry hashes", function () {
    const { appendEntry } = require("../cli/journal");

    function journalEntryHashes(count) {
      const hashes = [];
      let prev = null;
      for (let i = 0; i < count; i++) {
        prev = appendEntry(prev, { verdict: { verdict: "ACCEPTED", i }, artifact: "art-" + i, ts: i });
        hashes.push(prev.entryHash);
      }
      return hashes;
    }

    it("proves inclusion of every real entry and append-only growth of the real chain", function () {
      const leaves = journalEntryHashes(12);
      leaves.forEach((l) => expect(l).to.match(HEX32));
      const head = treeHead(leaves);
      for (let i = 0; i < leaves.length; i++) {
        expect(verifyInclusion(inclusionProof(leaves, i), head), `entry ${i}`).to.equal(true);
      }
      // An earlier head over the first 7 entries is provably an append-only prefix of the current head.
      const oldHead = treeHead(leaves.slice(0, 7));
      expect(verifyConsistency(consistencyProof(leaves, 7, 12), oldHead, head)).to.equal(true);
    });

    it("catches an operator who REWRITES a past journal entry hash (no bridging proof exists)", function () {
      const leaves = journalEntryHashes(12);
      const oldHead = treeHead(leaves.slice(0, 7)); // the honest, previously-committed head
      const tampered = leaves.slice();
      tampered[3] = leafVal(777001); // swap in a forged entry hash at a PAST position
      const badProof = consistencyProof(tampered, 7, 12);
      expect(verifyConsistency(badProof, oldHead, treeHead(tampered))).to.equal(false);
    });
  });
});

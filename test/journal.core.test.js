"use strict";

// test/journal.core.test.js — DIRECT coverage of the pure INTEGRITY-JOURNAL CORE (cli/journal.js, T-60.1).
//
// WHAT THIS PROVES (the T-60.1 acceptance criteria, each as an honest test):
//   1. appendEntry(null, obs) yields seq 0 with prevHash === the documented GENESIS constant, and a
//      DETERMINISTIC entryHash (same inputs, even with different key insertion order, ⇒ byte-identical entry).
//   2. A chain of ≥3 appends verifies ok:true via verifyJournal.
//   3. Editing any past entry's verdict / ts / artifact, DELETING an entry, REORDERING two, or INSERTING a
//      forged entry each makes verifyJournal return ok:false with brokenAt = the FIRST broken index and a
//      reason string. NEVER a false ok:true.
//   4. The stored `verdict` is VERBATIM: the journal entry's verdict deep-equals the verifyRequest output it
//      was built from.
//   5. A grep asserts cli/journal.js requires NONE of http/https/net/dns and never names Wallet / reads a
//      private key — the core is transport- and filesystem-agnostic.
//
// PURITY: this suite touches NO filesystem for the core under test (except reading cli/journal.js as TEXT for
// the static grep). No temp dirs, no sockets, no keys.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const journal = require("../cli/journal");
const { appendEntry, verifyJournal, computeEntryHash, GENESIS_PREV_HASH } = journal;

// We build the recorded verdicts through the REAL verifyRequest so the "stored VERBATIM" test is honest —
// it asserts the journal preserves the exact object shape the composed verify service actually emits.
const { verifyRequest, VERDICT } = require("../cli/serve-verify");

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

// A deep clone helper so a test can tamper with a copy without disturbing the pristine chain.
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

// Produce a REAL verifyRequest verdict (an ERROR verdict is fine here — it is a stable, well-formed envelope
// and we only care that whatever verifyRequest returns is stored byte-for-byte).
function realVerdict(seed) {
  // An unknown-kind request yields a clean ERROR envelope — deterministic and dependency-free (no seal bytes,
  // no key, no network). Perfect as a stand-in "observation" whose SHAPE is the production verdict shape.
  return verifyRequest({ kind: "no-such-kind", seed });
}

describe("cli/journal.js — pure integrity-journal core (T-60.1)", function () {
  describe("genesis + determinism (criterion 1)", function () {
    it("appendEntry(null, obs) yields seq 0 with prevHash = the documented genesis constant", function () {
      const e0 = appendEntry(null, { verdict: { verdict: "ACCEPTED" }, artifact: "a.txt", ts: "2026-07-01T00:00:00.000Z" });
      expect(e0.seq).to.equal(0);
      expect(e0.prevHash).to.equal(GENESIS_PREV_HASH);
      expect(GENESIS_PREV_HASH).to.match(HEX32);
      expect(e0.entryHash).to.match(HEX32);
    });

    it("the genesis constant is the documented keccak256 of the genesis domain (recomputable, stable)", function () {
      const { toUtf8Bytes } = require("ethers");
      const { hashBytes } = require("../cli/hash");
      expect(GENESIS_PREV_HASH).to.equal(hashBytes(toUtf8Bytes(journal.GENESIS_DOMAIN)));
    });

    it("same inputs ⇒ BYTE-IDENTICAL entry, independent of key insertion order in the verdict", function () {
      const a = appendEntry(null, {
        verdict: { verdict: "ACCEPTED", detail: { root: "0x01", ok: true } },
        artifact: "x",
        ts: 1000,
      });
      const b = appendEntry(null, {
        // Same logical value, DIFFERENT key insertion order at both levels.
        verdict: { detail: { ok: true, root: "0x01" }, verdict: "ACCEPTED" },
        artifact: "x",
        ts: 1000,
      });
      expect(b).to.deep.equal(a);
      expect(b.entryHash).to.equal(a.entryHash);
    });

    it("a different observation ⇒ a different entryHash (the hash actually commits to the content)", function () {
      const a = appendEntry(null, { verdict: { verdict: "ACCEPTED" }, artifact: "x", ts: 1 });
      const b = appendEntry(null, { verdict: { verdict: "REJECTED" }, artifact: "x", ts: 1 });
      const c = appendEntry(null, { verdict: { verdict: "ACCEPTED" }, artifact: "y", ts: 1 });
      const d = appendEntry(null, { verdict: { verdict: "ACCEPTED" }, artifact: "x", ts: 2 });
      const hashes = new Set([a.entryHash, b.entryHash, c.entryHash, d.entryHash]);
      expect(hashes.size).to.equal(4);
    });

    it("appendEntry does NOT mutate the prior entry (pure)", function () {
      const e0 = appendEntry(null, { verdict: { verdict: "ACCEPTED" }, artifact: "a" });
      const snapshot = clone(e0);
      appendEntry(e0, { verdict: { verdict: "ACCEPTED" }, artifact: "b" });
      expect(e0).to.deep.equal(snapshot);
    });

    it("appendEntry defaults artifact and ts to null when omitted (stable, canonicalizable)", function () {
      const e0 = appendEntry(null, { verdict: { verdict: "ACCEPTED" } });
      expect(e0.artifact).to.equal(null);
      expect(e0.ts).to.equal(null);
      expect(verifyJournal([e0]).ok).to.equal(true);
    });
  });

  describe("verdict stored VERBATIM (criterion 4)", function () {
    it("the journal entry's verdict deep-equals the verifyRequest output it was built from", function () {
      const v = realVerdict(42);
      // Sanity: verifyRequest really did return a structured verdict envelope.
      expect(v).to.have.property("schema");
      expect(v).to.have.property("verdict");
      const e0 = appendEntry(null, { verdict: v, artifact: "req.json", ts: "2026-07-01T00:00:00.000Z" });
      expect(e0.verdict).to.deep.equal(v);
    });

    it("a REAL ACCEPTED/REJECTED-shaped verdict envelope survives verbatim through a chain", function () {
      // Two distinct verifyRequest verdicts, recorded across a chain, both preserved byte-for-byte.
      const v1 = realVerdict("one");
      const v2 = realVerdict("two");
      const e0 = appendEntry(null, { verdict: v1, artifact: "a" });
      const e1 = appendEntry(e0, { verdict: v2, artifact: "b" });
      expect(e0.verdict).to.deep.equal(v1);
      expect(e1.verdict).to.deep.equal(v2);
      // And the exported VERDICT vocabulary is still the source of truth (not re-invented here).
      expect(v1.verdict).to.equal(VERDICT.ERROR);
    });

    it("mutating the caller's verdict object AFTER append does not change the recorded entry", function () {
      const v = { verdict: "ACCEPTED", detail: { note: "original" } };
      const e0 = appendEntry(null, { verdict: v, artifact: "a" });
      v.detail.note = "mutated-later";
      expect(e0.verdict.detail.note).to.equal("original");
    });
  });

  describe("a chain of ≥3 appends verifies ok:true (criterion 2)", function () {
    let e0, e1, e2, e3;
    beforeEach(function () {
      e0 = appendEntry(null, { verdict: realVerdict(0), artifact: "a", ts: "2026-07-01T00:00:00.000Z" });
      e1 = appendEntry(e0, { verdict: realVerdict(1), artifact: "b", ts: "2026-07-01T01:00:00.000Z" });
      e2 = appendEntry(e1, { verdict: realVerdict(2), artifact: "c", ts: "2026-07-01T02:00:00.000Z" });
      e3 = appendEntry(e2, { verdict: realVerdict(3), artifact: "d", ts: "2026-07-01T03:00:00.000Z" });
    });

    it("verifyJournal([e0,e1,e2,e3]) => ok:true with count and head", function () {
      const r = verifyJournal([e0, e1, e2, e3]);
      expect(r.ok).to.equal(true);
      expect(r.count).to.equal(4);
      expect(r.head).to.equal(e3.entryHash);
    });

    it("seqs are 0..N-1 and each prevHash chains to the previous entryHash", function () {
      expect([e0.seq, e1.seq, e2.seq, e3.seq]).to.deep.equal([0, 1, 2, 3]);
      expect(e0.prevHash).to.equal(GENESIS_PREV_HASH);
      expect(e1.prevHash).to.equal(e0.entryHash);
      expect(e2.prevHash).to.equal(e1.entryHash);
      expect(e3.prevHash).to.equal(e2.entryHash);
    });

    it("an empty journal is vacuously ok:true with head = genesis", function () {
      const r = verifyJournal([]);
      expect(r.ok).to.equal(true);
      expect(r.count).to.equal(0);
      expect(r.head).to.equal(GENESIS_PREV_HASH);
    });

    it("a tail truncation stays consistent (append-only; only a KNOWN head detects a dropped tail)", function () {
      expect(verifyJournal([e0, e1]).ok).to.equal(true);
      expect(verifyJournal([e0, e1, e2]).ok).to.equal(true);
    });
  });

  describe("tamper detection LOCALIZES the first break, never a false ok:true (criterion 3)", function () {
    let chain;
    beforeEach(function () {
      const e0 = appendEntry(null, { verdict: realVerdict(0), artifact: "a", ts: "T0" });
      const e1 = appendEntry(e0, { verdict: realVerdict(1), artifact: "b", ts: "T1" });
      const e2 = appendEntry(e1, { verdict: realVerdict(2), artifact: "c", ts: "T2" });
      const e3 = appendEntry(e2, { verdict: realVerdict(3), artifact: "d", ts: "T3" });
      chain = [e0, e1, e2, e3];
      // Guard: the pristine chain verifies, so any ok:false below is caused by the tamper, not a setup bug.
      expect(verifyJournal(chain).ok).to.equal(true);
    });

    it("EDITING a past entry's verdict is caught at that entry's index", function () {
      const bad = clone(chain);
      bad[1].verdict.verdict = "TAMPERED";
      const r = verifyJournal(bad);
      expect(r.ok).to.equal(false);
      expect(r.brokenAt).to.equal(1);
      expect(r.reason).to.be.a("string").and.match(/edited|forged/i);
    });

    it("EDITING a past entry's ts is caught at that entry's index", function () {
      const bad = clone(chain);
      bad[2].ts = "9999-99-99";
      const r = verifyJournal(bad);
      expect(r.ok).to.equal(false);
      expect(r.brokenAt).to.equal(2);
      expect(r.reason).to.be.a("string");
    });

    it("EDITING a past entry's artifact is caught at that entry's index", function () {
      const bad = clone(chain);
      bad[0].artifact = "hacked";
      const r = verifyJournal(bad);
      expect(r.ok).to.equal(false);
      expect(r.brokenAt).to.equal(0);
      expect(r.reason).to.be.a("string");
    });

    it("DELETING an entry breaks the chain at the first shifted index", function () {
      const bad = clone(chain);
      bad.splice(1, 1); // drop entry 1; entry formerly at index 2 (seq 2) now sits at index 1
      const r = verifyJournal(bad);
      expect(r.ok).to.equal(false);
      expect(r.brokenAt).to.equal(1);
      expect(r.reason).to.match(/reorder|deleted|inserted|seq/i);
    });

    it("REORDERING two entries breaks the chain at the first out-of-order index", function () {
      const bad = clone(chain);
      const tmp = bad[1];
      bad[1] = bad[2];
      bad[2] = tmp; // swap entries 1 and 2
      const r = verifyJournal(bad);
      expect(r.ok).to.equal(false);
      expect(r.brokenAt).to.equal(1);
    });

    it("INSERTING a forged entry (kept at its own seq) breaks at the insertion index", function () {
      const bad = clone(chain);
      const forged = appendEntry(chain[0], { verdict: realVerdict("FORGED"), artifact: "evil", ts: "Tx" });
      // forged has seq 1 and a valid prevHash from entry 0, but inserting it at index 2 puts a seq-1 entry
      // where a seq-2 entry belongs.
      bad.splice(2, 0, forged);
      const r = verifyJournal(bad);
      expect(r.ok).to.equal(false);
      expect(r.brokenAt).to.equal(2);
    });

    it("INSERTING a forged entry at the front (seq collision) breaks at that index", function () {
      const bad = clone(chain);
      const forged = appendEntry(null, { verdict: realVerdict("FRONT"), artifact: "evil", ts: "Tx" });
      bad.splice(1, 0, forged); // a second seq-0-derived entry, now at index 1 where seq 1 belongs
      const r = verifyJournal(bad);
      expect(r.ok).to.equal(false);
      expect(r.brokenAt).to.equal(1);
    });

    it("corrupting a prevHash (not the genesis, not the prior entryHash) breaks the chain there", function () {
      const bad = clone(chain);
      bad[2].prevHash = "0x" + "aa".repeat(32);
      const r = verifyJournal(bad);
      expect(r.ok).to.equal(false);
      expect(r.brokenAt).to.equal(2);
      expect(r.reason).to.match(/prevHash|chain/i);
    });

    it("corrupting entry 0's prevHash away from the genesis constant is caught at index 0", function () {
      const bad = clone(chain);
      bad[0].prevHash = "0x" + "bb".repeat(32);
      const r = verifyJournal(bad);
      expect(r.ok).to.equal(false);
      expect(r.brokenAt).to.equal(0);
      expect(r.reason).to.match(/genesis/i);
    });

    it("re-signing entryHash to match a tampered verdict STILL breaks (prevHash of the next entry no longer matches)", function () {
      const bad = clone(chain);
      // Attacker edits entry 1's verdict AND recomputes its entryHash so entry 1 is self-consistent.
      bad[1].verdict = { verdict: "TAMPERED" };
      bad[1].entryHash = computeEntryHash(bad[1]);
      const r = verifyJournal(bad);
      // Entry 1 now self-verifies, but entry 2's prevHash still points at the OLD entry-1 hash — break at 2.
      expect(r.ok).to.equal(false);
      expect(r.brokenAt).to.equal(2);
      expect(r.reason).to.match(/prevHash|chain/i);
    });

    it("the FIRST break wins when there are multiple tampers", function () {
      const bad = clone(chain);
      bad[0].artifact = "hacked-0"; // break at 0
      bad[2].ts = "hacked-2"; // also broken, but later
      const r = verifyJournal(bad);
      expect(r.ok).to.equal(false);
      expect(r.brokenAt).to.equal(0);
    });
  });

  describe("verifyJournal fails closed on malformed input (never throws, never a false ok)", function () {
    it("a non-array input => ok:false", function () {
      for (const bad of [null, undefined, {}, "x", 7]) {
        const r = verifyJournal(bad);
        expect(r.ok, JSON.stringify(bad)).to.equal(false);
      }
    });

    it("an entry with a missing/short entryHash => ok:false at that index", function () {
      const e0 = appendEntry(null, { verdict: realVerdict(0), artifact: "a" });
      const bad = clone([e0]);
      delete bad[0].entryHash;
      const r = verifyJournal(bad);
      expect(r.ok).to.equal(false);
      expect(r.brokenAt).to.equal(0);
    });

    it("an entry that is not an object => ok:false at that index", function () {
      const e0 = appendEntry(null, { verdict: realVerdict(0), artifact: "a" });
      const r = verifyJournal([e0, "not-an-entry"]);
      expect(r.ok).to.equal(false);
      expect(r.brokenAt).to.equal(1);
    });

    it("appendEntry rejects a missing/undefined verdict with a JournalError", function () {
      expect(() => appendEntry(null, {})).to.throw(journal.JournalError, /verdict/i);
      expect(() => appendEntry(null, { verdict: undefined })).to.throw(journal.JournalError, /verdict/i);
      expect(() => appendEntry(null, null)).to.throw(journal.JournalError);
    });

    it("appendEntry rejects a non-JSON verdict (BigInt / function) rather than silently dropping it", function () {
      expect(() => appendEntry(null, { verdict: 10n })).to.throw(journal.JournalError);
      expect(() => appendEntry(null, { verdict: () => {} })).to.throw(journal.JournalError);
    });

    it("appendEntry rejects a malformed priorEntry", function () {
      expect(() => appendEntry({ seq: 0 /* no hashes */ }, { verdict: {} })).to.throw(journal.JournalError);
    });
  });

  describe("STATIC purity guard (criterion 5): no network, no key, no Wallet", function () {
    let src;
    before(function () {
      src = fs.readFileSync(path.join(__dirname, "..", "cli", "journal.js"), "utf8");
    });

    it("requires NONE of http / https / net / dns", function () {
      for (const mod of ["http", "https", "net", "dns", "tls", "dgram"]) {
        const re = new RegExp("require\\(\\s*['\"]" + mod + "['\"]\\s*\\)");
        expect(re.test(src), `must not require '${mod}'`).to.equal(false);
      }
    });

    it("never names Wallet and never reads a private key", function () {
      expect(/\bWallet\b/.test(src), "must not reference Wallet").to.equal(false);
      expect(/privateKey|PRIVATE_KEY|readFileSync|writeFileSync/i.test(src), "must do no key/fs I/O").to.equal(false);
    });

    it("does no filesystem I/O (does not require 'fs')", function () {
      expect(/require\(\s*['"]fs['"]\s*\)/.test(src), "must not require 'fs'").to.equal(false);
    });
  });
});

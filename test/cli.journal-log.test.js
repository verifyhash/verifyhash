"use strict";

// test/cli.journal-log.test.js — `vh journal tree-head|prove-inclusion|prove-consistency|check-proof`
// (T-63.2): the four strictly-additive, VERIFY-ONLY subcommands wiring the T-63.1 ordered Merkle-log
// core (cli/journal-log.js) onto the on-disk JSONL journal, PLUS the OFFLINE, journal-LESS third-party
// auditor path.
//
// WHAT THESE PROVE (the T-63.2 acceptance criteria, each an honest test):
//   1. On a journal with ≥3 appended entries, `tree-head` prints { size, root } matching `treeHead` of
//      the parsed entries, and carries the self-asserted-head honesty note (text AND --json).
//   2. `prove-inclusion --seq <i>` emits an artifact `check-proof` ACCEPTS (exit 0), and check-proof
//      REJECTS (exit 3) after a single byte of `leaf`/`root`/`path` is edited.
//   3. After 2 MORE appends, `prove-consistency --from <oldSize>` emits an artifact `check-proof`
//      ACCEPTS (exit 0) — while a consistency artifact whose second.root is swapped for the root of a
//      log that REWROTE a past entry (with every downstream hash recomputed, so its CHAIN still
//      verifies!) is REJECTED (exit 3). The Merkle consistency proof catches what the chain cannot.
//   4. `check-proof` reads ONLY the proof file: a subprocess test runs it with the journal DELETED,
//      under a preloaded guard that crashes the process on ANY fs touch of the journal path or ANY
//      outbound network primitive — a clean exit 0 PROVES neither happened.
//   5. The 0/3/2/1 exit contract matches the SHARED verify contract (parity vs evidence.EXIT).
//   6. `--json` emits the machine verdict for every subcommand.
//   Plus: all four verbs are READ-ONLY (journal bytes byte-identical after each), and the verbs are
//   wired through the real `vh` main() dispatcher.
//
// FILESYSTEM HYGIENE: every write lands under a throwaway temp dir; the working tree (cwd) is left CLEAN.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const evidence = require("../cli/evidence");
const journalCli = require("../cli/journal-cli");
const journalLog = require("../cli/journal-log");
const { appendEntry, verifyJournal } = require("../cli/journal");
const vh = require("../cli/vh");

const VH_ENTRY = path.join(__dirname, "..", "cli", "vh.js");

// io capture (mirrors the convention used across the CLI test suite).
function capture() {
  const out = [];
  const err = [];
  return {
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

// Flip ONE hex character of a 0x-prefixed hex string (a strictly-minimal single-byte-of-text edit).
function flipHexChar(hex, pos = 10) {
  const c = hex[pos];
  const flipped = c === "a" ? "b" : "a";
  return hex.slice(0, pos) + flipped + hex.slice(pos + 1);
}

describe("cli/journal-cli T-63.2: `vh journal tree-head|prove-inclusion|prove-consistency|check-proof`", function () {
  let tmpDirs;
  let cwdBefore;
  beforeEach(function () {
    tmpDirs = [];
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    // FILESYSTEM HYGIENE: nothing the commands did leaked into the working tree.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-journal-log-"));
    tmpDirs.push(d);
    return d;
  }

  // Build a throwaway workspace: a payload dir + an UNSIGNED evidence seal packet over it.
  async function mkSealed(files = { "a.txt": "hello\n", "b.txt": "world\n" }) {
    const root = mkTmp();
    const dir = path.join(root, "payload");
    fs.mkdirSync(dir);
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    const packet = path.join(root, "packet.vhevidence.json");
    const io = capture();
    const code = await evidence.runEvidenceSeal({ dir, out: packet }, io);
    expect(code, `seal build should succeed: ${io.err()}`).to.equal(evidence.EXIT.OK);
    return { root, dir, packet };
  }

  // Append `count` clean observations to the journal at `jf` (creating it on the first append).
  function appendN(jf, packet, dir, count, startAt = 0) {
    for (let i = 0; i < count; i++) {
      const io = capture();
      const code = journalCli.runJournalAppend(
        { artifact: packet, to: jf, dir, ts: `2026-07-02T0${startAt + i}:00:00.000Z` },
        io
      );
      expect(code, `append ${startAt + i} should succeed: ${io.err()}`).to.equal(0);
    }
  }

  // A ready 3-entry journal workspace. Returns { root, dir, packet, jf }.
  async function mkJournal3() {
    const { root, dir, packet } = await mkSealed();
    const jf = path.join(root, "integrity.jsonl");
    appendN(jf, packet, dir, 3);
    return { root, dir, packet, jf };
  }

  function readEntries(jf) {
    return fs
      .readFileSync(jf, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
  }

  // ---------------------------------------------------------------------------------------------------
  // Criterion 1 — tree-head prints { size, root } matching the core treeHead of the parsed entries,
  // and carries the self-asserted-head honesty note.
  // ---------------------------------------------------------------------------------------------------
  describe("tree-head — { size, root } matches the core over the parsed entries (criterion 1)", function () {
    it("on a 3-entry journal, tree-head --json emits size+root EQUAL to treeHead(entry hashes) and the honesty note", async function () {
      const { jf } = await mkJournal3();
      const entries = readEntries(jf);
      expect(entries.length).to.be.at.least(3);
      const expected = journalLog.treeHead(entries.map((e) => e.entryHash));

      const io = capture();
      expect(journalCli.runJournalTreeHead({ journal: jf, json: true }, io)).to.equal(0);
      const j = JSON.parse(io.out());
      expect(j.ok).to.equal(true);
      expect(j.verdict).to.equal("HEAD");
      expect(j.size).to.equal(expected.size);
      expect(j.size).to.equal(3);
      expect(j.root).to.equal(expected.root);
      expect(j.root).to.match(/^0x[0-9a-fA-F]{64}$/);
      // The honesty note rides along in the machine verdict too.
      expect(j.note).to.equal(journalCli.SELF_ASSERTED_HEAD_NOTE);
      expect(j.note).to.match(/SELF-ASSERTED/);
    });

    it("the human-readable tree-head output prints the size + root AND the self-asserted honesty note", async function () {
      const { jf } = await mkJournal3();
      const entries = readEntries(jf);
      const expected = journalLog.treeHead(entries.map((e) => e.entryHash));

      const io = capture();
      expect(journalCli.runJournalTreeHead({ journal: jf }, io)).to.equal(0);
      expect(io.out()).to.include(`size: ${expected.size}`);
      expect(io.out()).to.include(expected.root);
      expect(io.out()).to.match(/SELF-ASSERTED/);
      expect(io.out()).to.include(journalCli.SELF_ASSERTED_HEAD_NOTE);
    });

    it("tree-head REFUSES a journal whose chain is broken (exit 3) — no head over tampered history", async function () {
      const { jf } = await mkJournal3();
      // Hand-edit a PAST line: the chain no longer verifies, so NO head may be attested.
      const lines = fs.readFileSync(jf, "utf8").split("\n").filter((l) => l.length > 0);
      lines[1] = lines[1].replace("2026-07-02T01", "2026-07-02T09");
      fs.writeFileSync(jf, lines.join("\n") + "\n");

      const io = capture();
      expect(journalCli.runJournalTreeHead({ journal: jf, json: true }, io)).to.equal(3);
      const j = JSON.parse(io.out());
      expect(j.ok).to.equal(false);
      expect(j.verdict).to.equal("BROKEN");
    });

    it("tree-head is READ-ONLY: the journal bytes are byte-identical after it runs", async function () {
      const { jf } = await mkJournal3();
      const before = fs.readFileSync(jf);
      expect(journalCli.runJournalTreeHead({ journal: jf }, capture())).to.equal(0);
      expect(fs.readFileSync(jf).equals(before)).to.equal(true);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // Criterion 2 — prove-inclusion round-trips through check-proof; a single edited byte of
  // leaf/root/path is REJECTED (exit 3).
  // ---------------------------------------------------------------------------------------------------
  describe("prove-inclusion -> check-proof ACCEPT; one edited byte -> REJECT (criterion 2)", function () {
    it("prove-inclusion --seq 1 emits a self-contained artifact that check-proof ACCEPTS (exit 0)", async function () {
      const { root, jf } = await mkJournal3();
      const proofFile = path.join(root, "incl.vhproof.json");

      const p = capture();
      expect(
        journalCli.runJournalProveInclusion({ journal: jf, seq: "1", out: proofFile }, p)
      ).to.equal(0);

      // The artifact is the DOCUMENTED self-contained schema, tied to the real journal entries.
      const entries = readEntries(jf);
      const head = journalLog.treeHead(entries.map((e) => e.entryHash));
      const artifact = JSON.parse(fs.readFileSync(proofFile, "utf8"));
      expect(artifact.kind).to.equal(journalCli.JOURNAL_INCLUSION_PROOF_KIND);
      expect(artifact.kind).to.equal("vh-journal-inclusion");
      expect(artifact.leaf).to.equal(entries[1].entryHash);
      expect(artifact.seq).to.equal(1);
      expect(artifact.size).to.equal(head.size);
      expect(artifact.root).to.equal(head.root);
      expect(artifact.path).to.be.an("array").with.length.greaterThan(0);
      for (const h of artifact.path) expect(h).to.match(/^0x[0-9a-fA-F]{64}$/);

      const c = capture();
      expect(journalCli.runJournalCheckProof({ proof: proofFile, json: true }, c)).to.equal(0);
      const verdict = JSON.parse(c.out());
      expect(verdict.ok).to.equal(true);
      expect(verdict.verdict).to.equal("ACCEPTED");
      expect(verdict.kind).to.equal("vh-journal-inclusion");
    });

    it("check-proof REJECTS (exit 3) after a single byte of `leaf`, `root`, or `path` is edited", async function () {
      const { root, jf } = await mkJournal3();
      const proofFile = path.join(root, "incl.vhproof.json");
      expect(
        journalCli.runJournalProveInclusion({ journal: jf, seq: "1", out: proofFile }, capture())
      ).to.equal(0);
      const pristine = JSON.parse(fs.readFileSync(proofFile, "utf8"));
      // Guard: the pristine artifact IS accepted (so the rejections below are caused by the edits).
      expect(journalCli.runJournalCheckProof({ proof: proofFile }, capture())).to.equal(0);

      const tamper = (mutate, label) => {
        const t = JSON.parse(JSON.stringify(pristine));
        mutate(t);
        const tf = path.join(root, `tampered-${label}.vhproof.json`);
        fs.writeFileSync(tf, JSON.stringify(t, null, 2) + "\n");
        const io = capture();
        const code = journalCli.runJournalCheckProof({ proof: tf, json: true }, io);
        expect(code, `${label}: single-byte edit must be REJECTED`).to.equal(3);
        const j = JSON.parse(io.out());
        expect(j.ok, label).to.equal(false);
        expect(j.verdict, label).to.equal("REJECTED");
      };

      tamper((t) => (t.leaf = flipHexChar(t.leaf)), "leaf");
      tamper((t) => (t.root = flipHexChar(t.root)), "root");
      tamper((t) => (t.path[0] = flipHexChar(t.path[0])), "path");
    });

    it("prove-inclusion works for EVERY seq of the journal (each artifact round-trips)", async function () {
      const { root, jf } = await mkJournal3();
      for (const seq of [0, 1, 2]) {
        const proofFile = path.join(root, `incl-${seq}.vhproof.json`);
        expect(
          journalCli.runJournalProveInclusion({ journal: jf, seq: String(seq), out: proofFile }, capture()),
          `prove seq ${seq}`
        ).to.equal(0);
        expect(journalCli.runJournalCheckProof({ proof: proofFile }, capture()), `check seq ${seq}`).to.equal(0);
      }
    });

    it("prove-inclusion without --out prints the artifact itself to stdout (parseable, checkable)", async function () {
      const { root, jf } = await mkJournal3();
      const io = capture();
      expect(journalCli.runJournalProveInclusion({ journal: jf, seq: "2" }, io)).to.equal(0);
      const artifact = JSON.parse(io.out());
      expect(artifact.kind).to.equal("vh-journal-inclusion");
      // Piping stdout into a file yields a proof check-proof accepts.
      const proofFile = path.join(root, "piped.vhproof.json");
      fs.writeFileSync(proofFile, io.out());
      expect(journalCli.runJournalCheckProof({ proof: proofFile }, capture())).to.equal(0);
    });

    it("prove-inclusion is READ-ONLY on the journal (bytes identical after)", async function () {
      const { root, jf } = await mkJournal3();
      const before = fs.readFileSync(jf);
      expect(
        journalCli.runJournalProveInclusion({ journal: jf, seq: "0", out: path.join(root, "p.json") }, capture())
      ).to.equal(0);
      expect(fs.readFileSync(jf).equals(before)).to.equal(true);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // Criterion 3 — append 2 MORE entries, prove-consistency --from <oldSize> ACCEPTS; swapping
  // second.root for the root of a REWRITTEN log (chain-valid!) is REJECTED.
  // ---------------------------------------------------------------------------------------------------
  describe("prove-consistency -> check-proof ACCEPT; a rewritten-history root -> REJECT (criterion 3)", function () {
    it("after 2 more appends, prove-consistency --from 3 emits an artifact check-proof ACCEPTS (exit 0)", async function () {
      const { root, dir, packet, jf } = await mkJournal3();
      // Pin the OLD head (size 3) BEFORE growing the log — the auditor's remembered commitment.
      const oldEntries = readEntries(jf);
      const oldHead = journalLog.treeHead(oldEntries.map((e) => e.entryHash));
      expect(oldHead.size).to.equal(3);

      appendN(jf, packet, dir, 2, 3); // grow 3 -> 5, strictly additively

      const proofFile = path.join(root, "cons.vhproof.json");
      const p = capture();
      expect(
        journalCli.runJournalProveConsistency({ journal: jf, from: "3", out: proofFile }, p)
      ).to.equal(0);

      const artifact = JSON.parse(fs.readFileSync(proofFile, "utf8"));
      expect(artifact.kind).to.equal(journalCli.JOURNAL_CONSISTENCY_PROOF_KIND);
      expect(artifact.kind).to.equal("vh-journal-consistency");
      // first is EXACTLY the head the auditor pinned at size 3; second is the current head.
      expect(artifact.first).to.deep.equal({ size: 3, root: oldHead.root });
      const newEntries = readEntries(jf);
      const newHead = journalLog.treeHead(newEntries.map((e) => e.entryHash));
      expect(artifact.second).to.deep.equal({ size: 5, root: newHead.root });
      expect(artifact.proof).to.be.an("array");

      const c = capture();
      expect(journalCli.runJournalCheckProof({ proof: proofFile, json: true }, c)).to.equal(0);
      const verdict = JSON.parse(c.out());
      expect(verdict.ok).to.equal(true);
      expect(verdict.verdict).to.equal("ACCEPTED");
      expect(verdict.kind).to.equal("vh-journal-consistency");
    });

    it("a consistency artifact whose second.root is the root of a log that REWROTE a past entry is REJECTED (exit 3) — even though the rewritten CHAIN verifies", async function () {
      const { root, dir, packet, jf } = await mkJournal3();
      appendN(jf, packet, dir, 2, 3); // 5 entries

      const proofFile = path.join(root, "cons.vhproof.json");
      expect(
        journalCli.runJournalProveConsistency({ journal: jf, from: "3", out: proofFile }, capture())
      ).to.equal(0);
      const artifact = JSON.parse(fs.readFileSync(proofFile, "utf8"));

      // THE ATTACK: rewrite entry seq 1's ts and recompute EVERY downstream hash — a "smart" tamper
      // that keeps the hash-CHAIN fully valid (verifyJournal PASSes!). Only the Merkle consistency
      // proof against the OLD head can catch it.
      const entries = readEntries(jf);
      let prior = null;
      const rewritten = [];
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        prior = appendEntry(prior, {
          verdict: e.verdict,
          artifact: e.artifact,
          ts: i === 1 ? "1999-01-01T00:00:00.000Z" : e.ts, // the rewritten past observation
        });
        rewritten.push(prior);
      }
      // The rewritten log's CHAIN is intact — the exact blind spot the Merkle log exists to close.
      expect(verifyJournal(rewritten).ok).to.equal(true);
      const rewrittenRoot = journalLog.treeHead(rewritten.map((e) => e.entryHash)).root;
      expect(rewrittenRoot).to.not.equal(artifact.second.root);

      // Swap the rewritten log's root in as second.root: the proof no longer links first -> second.
      artifact.second.root = rewrittenRoot;
      const tf = path.join(root, "cons-rewritten.vhproof.json");
      fs.writeFileSync(tf, JSON.stringify(artifact, null, 2) + "\n");

      const io = capture();
      expect(journalCli.runJournalCheckProof({ proof: tf, json: true }, io)).to.equal(3);
      const verdict = JSON.parse(io.out());
      expect(verdict.ok).to.equal(false);
      expect(verdict.verdict).to.equal("REJECTED");
      expect(verdict.reason).to.match(/append-only|rewritten/);
    });

    it("--from equal to the current size is valid (same head both sides, empty proof, ACCEPTED)", async function () {
      const { root, jf } = await mkJournal3();
      const proofFile = path.join(root, "cons-eq.vhproof.json");
      expect(
        journalCli.runJournalProveConsistency({ journal: jf, from: "3", out: proofFile }, capture())
      ).to.equal(0);
      const artifact = JSON.parse(fs.readFileSync(proofFile, "utf8"));
      expect(artifact.first).to.deep.equal(artifact.second);
      expect(artifact.proof).to.deep.equal([]);
      expect(journalCli.runJournalCheckProof({ proof: proofFile }, capture())).to.equal(0);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // Criterion 4 — check-proof reads ONLY the proof file: run it in a subprocess with the journal
  // DELETED, under a guard that crashes on any journal-path fs access or any outbound network call.
  // ---------------------------------------------------------------------------------------------------
  describe("check-proof is OFFLINE and journal-LESS — no journal open, no socket (criterion 4)", function () {
    // A Node preload that POISONS (a) every outbound network primitive and (b) EVERY public fs entry
    // point touching the journal path. If check-proof did either, the child crashes; exit 0 proves not.
    function writeOfflineGuard(dir, journalPath) {
      const guard = path.join(dir, "offline-guard.cjs");
      fs.writeFileSync(
        guard,
        [
          "'use strict';",
          "const TRIP = (what) => { throw new Error(what); };",
          "// ---- network poison: any attempt to OPEN a connection / resolve DNS crashes ----",
          "for (const mod of ['net','tls','http','https','http2']) {",
          "  let m; try { m = require(mod); } catch (_) { continue; }",
          "  for (const fn of ['connect','createConnection','request','get']) {",
          "    if (typeof m[fn] === 'function') {",
          "      const name = mod + '.' + fn;",
          "      Object.defineProperty(m, fn, { configurable: true, writable: true, value: function () { TRIP('NETWORK ACCESS ATTEMPTED: ' + name); } });",
          "    }",
          "  }",
          "}",
          "const dns = require('dns');",
          "for (const fn of ['lookup','resolve','resolve4','resolve6','lookupService']) {",
          "  if (typeof dns[fn] === 'function') dns[fn] = function () { TRIP('NETWORK ACCESS ATTEMPTED: dns.' + fn); };",
          "  if (dns.promises && typeof dns.promises[fn] === 'function') dns.promises[fn] = function () { return Promise.reject(new Error('NETWORK ACCESS ATTEMPTED: dns.promises.' + fn)); };",
          "}",
          "// ---- journal poison: ANY fs touch of the journal path crashes ----",
          `const JOURNAL = ${JSON.stringify(journalPath)};`,
          `const JOURNAL_BASE = ${JSON.stringify(path.basename(journalPath))};`,
          "const fsMod = require('fs');",
          "const hits = (p) => { const s = String(p); return s === JOURNAL || s.includes(JOURNAL_BASE); };",
          "const wrap = (obj, fn) => {",
          "  if (typeof obj[fn] !== 'function') return;",
          "  const orig = obj[fn];",
          "  obj[fn] = function (p, ...rest) { if (hits(p)) TRIP('JOURNAL ACCESS ATTEMPTED: fs.' + fn + ' ' + String(p)); return orig.call(this, p, ...rest); };",
          "};",
          "for (const fn of ['readFileSync','openSync','open','createReadStream','statSync','stat','existsSync','accessSync','access','readFile','lstatSync','realpathSync']) wrap(fsMod, fn);",
          "if (fsMod.promises) for (const fn of ['open','readFile','stat','access','lstat']) wrap(fsMod.promises, fn);",
          "",
        ].join("\n")
      );
      return guard;
    }

    it("check-proof ACCEPTS (exit 0) with the journal DELETED and journal-fs + network POISONED", async function () {
      this.timeout(30000);
      const { root, jf } = await mkJournal3();
      const proofFile = path.join(root, "incl.vhproof.json");
      expect(
        journalCli.runJournalProveInclusion({ journal: jf, seq: "1", out: proofFile }, capture())
      ).to.equal(0);

      // The auditor genuinely holds ONLY the proof file: the journal is GONE.
      fs.rmSync(jf);
      expect(fs.existsSync(jf)).to.equal(false);

      const guard = writeOfflineGuard(root, jf);
      const res = spawnSync(
        process.execPath,
        ["--require", guard, VH_ENTRY, "journal", "check-proof", proofFile, "--json"],
        { encoding: "utf8" }
      );

      expect(res.error, "no spawn error").to.equal(undefined);
      const combined = (res.stdout || "") + (res.stderr || "");
      expect(combined, "never opened the journal").to.not.match(/JOURNAL ACCESS ATTEMPTED/);
      expect(combined, "never opened a socket").to.not.match(/NETWORK ACCESS ATTEMPTED/);
      expect(res.status, `exit 0 (out: ${combined})`).to.equal(0);
      const verdict = JSON.parse(res.stdout);
      expect(verdict.ok).to.equal(true);
      expect(verdict.verdict).to.equal("ACCEPTED");
    });

    it("the guard is not a no-op: a journal read and a network call each crash a guarded child", function () {
      this.timeout(30000);
      const dir = mkTmp();
      const jf = path.join(dir, "integrity.jsonl");
      fs.writeFileSync(jf, "x\n");
      const guard = writeOfflineGuard(dir, jf);

      const fsOffender = path.join(dir, "fs-offender.cjs");
      fs.writeFileSync(fsOffender, `require('fs').readFileSync(${JSON.stringify(jf)}, 'utf8');\n`);
      const r1 = spawnSync(process.execPath, ["--require", guard, fsOffender], { encoding: "utf8" });
      expect(r1.status, "journal-read offender crashed").to.not.equal(0);
      expect((r1.stdout || "") + (r1.stderr || "")).to.match(/JOURNAL ACCESS ATTEMPTED/);

      const netOffender = path.join(dir, "net-offender.cjs");
      fs.writeFileSync(netOffender, "require('http').get('http://127.0.0.1:9/');\n");
      const r2 = spawnSync(process.execPath, ["--require", guard, netOffender], { encoding: "utf8" });
      expect(r2.status, "network offender crashed").to.not.equal(0);
      expect((r2.stdout || "") + (r2.stderr || "")).to.match(/NETWORK ACCESS ATTEMPTED/);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // Criterion 5 — the 0/3/2/1 exit contract matches the SHARED verify contract.
  // ---------------------------------------------------------------------------------------------------
  describe("exit-code contract parity with the shared verify contract (criterion 5)", function () {
    it("JOURNAL_EXIT maps 1:1 onto evidence.EXIT (0 ok / 3 fail / 2 usage / 1 IO)", function () {
      expect(journalCli.JOURNAL_EXIT.OK).to.equal(evidence.EXIT.OK);
      expect(journalCli.JOURNAL_EXIT.DRIFT).to.equal(evidence.EXIT.FAIL);
      expect(journalCli.JOURNAL_EXIT.USAGE).to.equal(evidence.EXIT.USAGE);
      expect(journalCli.JOURNAL_EXIT.IO).to.equal(evidence.EXIT.IO);
      expect(journalCli.JOURNAL_EXIT.OK).to.equal(0);
      expect(journalCli.JOURNAL_EXIT.DRIFT).to.equal(3);
      expect(journalCli.JOURNAL_EXIT.USAGE).to.equal(2);
      expect(journalCli.JOURNAL_EXIT.IO).to.equal(1);
    });

    it("every new subcommand exercises 0/3/2/1 on the shared contract", async function () {
      const { root, jf } = await mkJournal3();
      const proofFile = path.join(root, "incl.vhproof.json");
      expect(
        journalCli.runJournalProveInclusion({ journal: jf, seq: "0", out: proofFile }, capture())
      ).to.equal(0);

      // 0 — every verb's happy path (proved above too; pinned here against the shared constants).
      expect(journalCli.runJournalTreeHead({ journal: jf }, capture())).to.equal(evidence.EXIT.OK);
      expect(journalCli.runJournalCheckProof({ proof: proofFile }, capture())).to.equal(evidence.EXIT.OK);

      // 2 — usage errors.
      expect(journalCli.runJournalTreeHead({}, capture())).to.equal(evidence.EXIT.USAGE);
      expect(journalCli.runJournalProveInclusion({ journal: jf }, capture())).to.equal(evidence.EXIT.USAGE); // no --seq
      expect(journalCli.runJournalProveInclusion({ journal: jf, seq: "abc" }, capture())).to.equal(evidence.EXIT.USAGE);
      expect(journalCli.runJournalProveInclusion({ journal: jf, seq: "99" }, capture())).to.equal(evidence.EXIT.USAGE); // out of range
      expect(journalCli.runJournalProveConsistency({ journal: jf }, capture())).to.equal(evidence.EXIT.USAGE); // no --from
      expect(journalCli.runJournalProveConsistency({ journal: jf, from: "0" }, capture())).to.equal(evidence.EXIT.USAGE);
      expect(journalCli.runJournalProveConsistency({ journal: jf, from: "99" }, capture())).to.equal(evidence.EXIT.USAGE);
      expect(journalCli.runJournalCheckProof({}, capture())).to.equal(evidence.EXIT.USAGE);

      // 1 — IO errors (a file that is not there).
      const missing = path.join(root, "nope.jsonl");
      expect(journalCli.runJournalTreeHead({ journal: missing }, capture())).to.equal(evidence.EXIT.IO);
      expect(journalCli.runJournalProveInclusion({ journal: missing, seq: "0" }, capture())).to.equal(evidence.EXIT.IO);
      expect(journalCli.runJournalProveConsistency({ journal: missing, from: "1" }, capture())).to.equal(evidence.EXIT.IO);
      expect(journalCli.runJournalCheckProof({ proof: missing }, capture())).to.equal(evidence.EXIT.IO);

      // 3 — verify-shaped failures: a tampered proof, a non-JSON proof, an unknown kind (fail CLOSED).
      const bad = path.join(root, "bad.vhproof.json");
      fs.writeFileSync(bad, "{{not json");
      expect(journalCli.runJournalCheckProof({ proof: bad }, capture())).to.equal(evidence.EXIT.FAIL);
      const foreign = path.join(root, "foreign.vhproof.json");
      fs.writeFileSync(foreign, JSON.stringify({ kind: "something-else" }) + "\n");
      expect(journalCli.runJournalCheckProof({ proof: foreign }, capture())).to.equal(evidence.EXIT.FAIL);
    });

    it("usage-error messages are HELPFUL: out-of-range --seq names the valid range", async function () {
      const { jf } = await mkJournal3();
      const io = capture();
      expect(journalCli.runJournalProveInclusion({ journal: jf, seq: "7" }, io)).to.equal(2);
      expect(io.err()).to.match(/out of range/);
      expect(io.err()).to.match(/valid seq: 0\.\.2/);

      const io2 = capture();
      expect(journalCli.runJournalProveConsistency({ journal: jf, from: "9" }, io2)).to.equal(2);
      expect(io2.err()).to.match(/valid --from: 1\.\.3/);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // Criterion 6 — `--json` emits the machine verdict for EVERY subcommand.
  // ---------------------------------------------------------------------------------------------------
  describe("--json emits the machine verdict for every subcommand (criterion 6)", function () {
    it("tree-head / prove-inclusion / prove-consistency / check-proof each emit parseable machine verdicts", async function () {
      const { root, dir, packet, jf } = await mkJournal3();
      appendN(jf, packet, dir, 2, 3);

      // tree-head --json
      const th = capture();
      expect(journalCli.runJournalTreeHead({ journal: jf, json: true }, th)).to.equal(0);
      const thJ = JSON.parse(th.out());
      expect(thJ).to.include.keys("ok", "verdict", "size", "root", "note");

      // prove-inclusion --json (envelope carries the artifact VERBATIM, matching the --out file)
      const inclFile = path.join(root, "incl.vhproof.json");
      const pi = capture();
      expect(
        journalCli.runJournalProveInclusion({ journal: jf, seq: "1", out: inclFile, json: true }, pi)
      ).to.equal(0);
      const piJ = JSON.parse(pi.out());
      expect(piJ.ok).to.equal(true);
      expect(piJ.verdict).to.equal("PROVED");
      expect(piJ.kind).to.equal("vh-journal-inclusion");
      expect(piJ.out).to.equal(inclFile);
      expect(piJ.artifact).to.deep.equal(JSON.parse(fs.readFileSync(inclFile, "utf8")));

      // prove-consistency --json
      const consFile = path.join(root, "cons.vhproof.json");
      const pc = capture();
      expect(
        journalCli.runJournalProveConsistency({ journal: jf, from: "3", out: consFile, json: true }, pc)
      ).to.equal(0);
      const pcJ = JSON.parse(pc.out());
      expect(pcJ.ok).to.equal(true);
      expect(pcJ.verdict).to.equal("PROVED");
      expect(pcJ.kind).to.equal("vh-journal-consistency");
      expect(pcJ.first.size).to.equal(3);
      expect(pcJ.second.size).to.equal(5);
      expect(pcJ.artifact).to.deep.equal(JSON.parse(fs.readFileSync(consFile, "utf8")));

      // check-proof --json (ACCEPTED and REJECTED both machine-readable)
      const cp = capture();
      expect(journalCli.runJournalCheckProof({ proof: inclFile, json: true }, cp)).to.equal(0);
      expect(JSON.parse(cp.out()).verdict).to.equal("ACCEPTED");

      const tampered = JSON.parse(fs.readFileSync(inclFile, "utf8"));
      tampered.root = flipHexChar(tampered.root);
      const tf = path.join(root, "tampered.vhproof.json");
      fs.writeFileSync(tf, JSON.stringify(tampered) + "\n");
      const cpBad = capture();
      expect(journalCli.runJournalCheckProof({ proof: tf, json: true }, cpBad)).to.equal(3);
      const bad = JSON.parse(cpBad.out());
      expect(bad.verdict).to.equal("REJECTED");
      expect(bad.reason).to.be.a("string");
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // Dispatch + argument handling (the verb wiring in journal-cli's dispatcher and cli/vh.js).
  // ---------------------------------------------------------------------------------------------------
  describe("dispatch + usage errors", function () {
    it("`vh journal help` names all four new subcommands", function () {
      const io = capture();
      expect(journalCli.cmdJournal(["help"], io)).to.equal(0);
      for (const verb of ["tree-head", "prove-inclusion", "prove-consistency", "check-proof"]) {
        expect(io.out(), verb).to.include(verb);
      }
    });

    it("the unknown-subcommand error now names the new verbs", function () {
      const io = capture();
      expect(journalCli.cmdJournal(["frobnicate"], io)).to.equal(2);
      expect(io.err()).to.match(/tree-head, prove-inclusion, prove-consistency, check-proof/);
    });

    it("dispatcher: each verb parses its flags and routes (tree-head/prove-*/check-proof via argv)", async function () {
      const { root, jf } = await mkJournal3();
      const proofFile = path.join(root, "d.vhproof.json");
      expect(journalCli.cmdJournal(["tree-head", jf], capture())).to.equal(0);
      expect(journalCli.cmdJournal(["prove-inclusion", jf, "--seq", "1", "--out", proofFile], capture())).to.equal(0);
      expect(journalCli.cmdJournal(["check-proof", proofFile], capture())).to.equal(0);
      const consFile = path.join(root, "dc.vhproof.json");
      expect(journalCli.cmdJournal(["prove-consistency", jf, "--from", "2", "--out", consFile], capture())).to.equal(0);
      expect(journalCli.cmdJournal(["check-proof", consFile], capture())).to.equal(0);
    });

    it("unknown flags and missing flag values are usage errors (exit 2) with helpful messages", function () {
      const cases = [
        [["tree-head", "j", "--bogus"], /unknown flag/],
        [["prove-inclusion", "j", "--seq"], /--seq requires a value/],
        [["prove-inclusion", "j", "--seq", "0", "extra", "arg"], /unexpected extra argument/],
        [["prove-consistency", "j", "--from"], /--from requires a value/],
        [["check-proof", "p", "--nope"], /unknown flag/],
      ];
      for (const [argv, re] of cases) {
        const io = capture();
        expect(journalCli.cmdJournal(argv, io), argv.join(" ")).to.equal(2);
        expect(io.err(), argv.join(" ")).to.match(re);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // End-to-end through the real `vh` main() dispatcher — the verbs are wired into cli/vh.js.
  // ---------------------------------------------------------------------------------------------------
  describe("wired into `vh` main() (cli/vh.js)", function () {
    let restore;
    beforeEach(function () {
      const origOut = process.stdout.write.bind(process.stdout);
      const origErr = process.stderr.write.bind(process.stderr);
      process.stdout.write = () => true;
      process.stderr.write = () => true;
      restore = () => {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
      };
    });
    afterEach(function () {
      if (restore) restore();
    });

    it("the full worked flow runs through vh.main: tree-head -> prove-inclusion -> check-proof -> grow -> prove-consistency -> check-proof", async function () {
      const { root, dir, packet, jf } = await mkJournal3();
      const incl = path.join(root, "incl.vhproof.json");
      const cons = path.join(root, "cons.vhproof.json");

      expect(await vh.main(["journal", "tree-head", jf])).to.equal(0);
      expect(await vh.main(["journal", "prove-inclusion", jf, "--seq", "1", "--out", incl])).to.equal(0);
      expect(await vh.main(["journal", "check-proof", incl])).to.equal(0);

      expect(await vh.main(["journal", "append", packet, "--to", jf, "--dir", dir, "--ts", "T3"])).to.equal(0);
      expect(await vh.main(["journal", "append", packet, "--to", jf, "--dir", dir, "--ts", "T4"])).to.equal(0);

      expect(await vh.main(["journal", "prove-consistency", jf, "--from", "3", "--out", cons])).to.equal(0);
      expect(await vh.main(["journal", "check-proof", cons])).to.equal(0);
    });

    it("vh.main check-proof exits 3 on a tampered artifact", async function () {
      const { root, jf } = await mkJournal3();
      const incl = path.join(root, "incl.vhproof.json");
      expect(await vh.main(["journal", "prove-inclusion", jf, "--seq", "0", "--out", incl])).to.equal(0);
      const artifact = JSON.parse(fs.readFileSync(incl, "utf8"));
      artifact.leaf = flipHexChar(artifact.leaf);
      fs.writeFileSync(incl, JSON.stringify(artifact) + "\n");
      expect(await vh.main(["journal", "check-proof", incl])).to.equal(3);
    });

    it("the vh top-level usage names the four new subcommands", function () {
      // usage() is module-internal; assert via the help output of a bad command path instead: the
      // journal usage is reachable, and the TOP-LEVEL usage string in cli/vh.js is asserted by grep.
      const src = fs.readFileSync(VH_ENTRY, "utf8");
      for (const verb of [
        "vh journal tree-head",
        "vh journal prove-inclusion",
        "vh journal prove-consistency",
        "vh journal check-proof",
      ]) {
        expect(src, verb).to.include(verb);
      }
    });
  });
});

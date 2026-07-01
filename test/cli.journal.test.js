"use strict";

// test/cli.journal.test.js — `vh journal append|verify` (T-60.2): the disk-backed, verb-shaped surface
// that wires the pure T-60.1 integrity-journal core (cli/journal.js) to REAL files via cli/journal-cli.js.
//
// WHAT THESE PROVE (the T-60.2 acceptance criteria, each an honest test):
//   1. `append` on a clean artifact TWICE yields a 2-entry chain that `verify` reports PASS / exit 0.
//   2. Tampering the artifact then `append`ing records a REJECT entry, and `verify` exits 3 NAMING the
//      drifted artifact + the seq where it drifted.
//   3. Hand-editing a PAST journal line makes `verify` exit 3 with `brokenAt` (the chain localizes it).
//   4. `append` is STRICTLY ADDITIVE — the pre-existing lines are byte-for-byte unchanged after a new append.
//   5. `--json` emits the machine verdict (for both append and verify, PASS + both drift modes).
//   6. The 0/3 exit-code contract matches the SHARED verify contract (evidence.EXIT) — a parity assertion.
//
// FILESYSTEM HYGIENE: every write lands under a throwaway temp dir; the working tree (cwd) is left CLEAN.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const evidence = require("../cli/evidence");
const journalCli = require("../cli/journal-cli");
const vh = require("../cli/vh");

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

describe("cli/journal-cli T-60.2: `vh journal append|verify`", function () {
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
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-journal-"));
    tmpDirs.push(d);
    return d;
  }

  // Build a throwaway workspace: a payload dir with a couple of small files + an UNSIGNED evidence seal
  // packet over them. Returns { root, dir, packet }.
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

  // Read a JSONL journal file into its raw lines (no trailing empties).
  function readLines(jf) {
    return fs.readFileSync(jf, "utf8").split("\n").filter((l) => l.length > 0);
  }

  // ---------------------------------------------------------------------------------------------------
  // Criterion 1 — two clean appends -> a 2-entry chain -> verify PASS / exit 0.
  // ---------------------------------------------------------------------------------------------------
  describe("clean append x2 -> verify PASS / exit 0 (criterion 1)", function () {
    it("appends twice and verify reports PASS with exit 0 and a 2-entry chain", async function () {
      const { dir, packet } = await mkSealed();
      const jf = path.join(path.dirname(packet), "integrity.jsonl");

      const a1 = capture();
      expect(
        journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "2026-07-01T00:00:00.000Z" }, a1)
      ).to.equal(0);
      const a2 = capture();
      expect(
        journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "2026-07-01T01:00:00.000Z" }, a2)
      ).to.equal(0);

      // Two lines on disk, one per append.
      const lines = readLines(jf);
      expect(lines.length).to.equal(2);

      const v = capture();
      const code = journalCli.runJournalVerify({ journal: jf }, v);
      expect(code).to.equal(0);
      expect(v.out()).to.match(/PASS/);
      expect(v.out()).to.match(/2 entries/);
    });

    it("the two appended entries are seq 0 and seq 1 with a genesis-anchored chain", async function () {
      const { dir, packet } = await mkSealed();
      const jf = path.join(path.dirname(packet), "integrity.jsonl");
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T0" }, capture());
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T1" }, capture());

      const entries = readLines(jf).map((l) => JSON.parse(l));
      expect(entries.map((e) => e.seq)).to.deep.equal([0, 1]);
      const { GENESIS_PREV_HASH } = require("../cli/journal");
      expect(entries[0].prevHash).to.equal(GENESIS_PREV_HASH);
      expect(entries[1].prevHash).to.equal(entries[0].entryHash);
      // Both recorded an ACCEPTED verdict (clean artifact).
      expect(entries[0].verdict.verdict).to.equal("ACCEPTED");
      expect(entries[1].verdict.verdict).to.equal("ACCEPTED");
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // Criterion 2 — tamper the artifact then append records a REJECT entry; verify exits 3 naming the
  // drifted artifact + the seq where it drifted.
  // ---------------------------------------------------------------------------------------------------
  describe("tamper-then-append records a REJECT; verify exits 3 naming artifact+seq (criterion 2)", function () {
    it("records a REJECTED verdict and verify localizes the drift by artifact + seq", async function () {
      const { dir, packet } = await mkSealed();
      const jf = path.join(path.dirname(packet), "integrity.jsonl");

      // Two clean observations first.
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T0" }, capture());
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T1" }, capture());

      // A clean journal PASSes before the tamper (guards the assertion below is caused by the drift).
      expect(journalCli.runJournalVerify({ journal: jf }, capture())).to.equal(0);

      // Now TAMPER a sealed file, then append: the composed verify path returns REJECTED and it is recorded.
      fs.writeFileSync(path.join(dir, "a.txt"), "TAMPERED\n");
      const ap = capture();
      const appendCode = journalCli.runJournalAppend(
        { artifact: packet, to: jf, dir, ts: "T2", json: true },
        ap
      );
      // Recording a REJECT is a SUCCESSFUL append (exit 0) — the journal faithfully records what it saw.
      expect(appendCode).to.equal(0);
      const appendVerdict = JSON.parse(ap.out());
      expect(appendVerdict.appended).to.equal(true);
      expect(appendVerdict.verdict).to.equal("REJECTED");
      expect(appendVerdict.seq).to.equal(2);

      // verify now FAILS with exit 3, naming the drifted artifact + the seq where it drifted.
      const v = capture();
      const verifyCode = journalCli.runJournalVerify({ journal: jf, json: true }, v);
      expect(verifyCode).to.equal(3);
      const verdict = JSON.parse(v.out());
      expect(verdict.ok).to.equal(false);
      expect(verdict.verdict).to.equal("DRIFTED");
      // The seq where it drifted...
      expect(verdict.seq).to.equal(2);
      // ...and the drifted artifact is NAMED.
      expect(verdict.artifact).to.equal(packet);
      expect(verdict.recordedVerdict).to.equal("REJECTED");
      // The chain itself is intact (nothing was TAMPERED in the log), so brokenAt is null: an observation FAILED.
      expect(verdict.brokenAt).to.equal(null);
    });

    it("the human-readable verify output names the seq and the artifact on a recorded drift", async function () {
      const { dir, packet } = await mkSealed();
      const jf = path.join(path.dirname(packet), "integrity.jsonl");
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T0" }, capture());
      fs.writeFileSync(path.join(dir, "a.txt"), "DRIFTED\n");
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T1" }, capture());

      const v = capture();
      expect(journalCli.runJournalVerify({ journal: jf }, v)).to.equal(3);
      expect(v.err()).to.match(/DRIFT/);
      expect(v.err()).to.match(/seq 1/);
      expect(v.err()).to.include(packet);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // Criterion 3 — hand-editing a PAST journal line makes verify exit 3 with brokenAt.
  // ---------------------------------------------------------------------------------------------------
  describe("hand-editing a past line -> verify exit 3 with brokenAt (criterion 3)", function () {
    it("editing a past entry's ts breaks the chain and verify exits 3 with brokenAt = that index", async function () {
      const { dir, packet } = await mkSealed();
      const jf = path.join(path.dirname(packet), "integrity.jsonl");
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "2026-07-01T00:00:00.000Z" }, capture());
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "2026-07-01T01:00:00.000Z" }, capture());
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "2026-07-01T02:00:00.000Z" }, capture());

      // Pristine chain PASSes.
      expect(journalCli.runJournalVerify({ journal: jf }, capture())).to.equal(0);

      // HAND-EDIT the FIRST line's recorded ts. Its stored entryHash no longer re-derives from its fields.
      const lines = readLines(jf);
      lines[1] = lines[1].replace("2026-07-01T01:00:00.000Z", "2026-07-01T09:99:99.999Z");
      fs.writeFileSync(jf, lines.join("\n") + "\n");

      const v = capture();
      const code = journalCli.runJournalVerify({ journal: jf, json: true }, v);
      expect(code).to.equal(3);
      const verdict = JSON.parse(v.out());
      expect(verdict.ok).to.equal(false);
      expect(verdict.verdict).to.equal("BROKEN");
      // The edit was to the entry at index 1, so brokenAt localizes there.
      expect(verdict.brokenAt).to.equal(1);
      expect(verdict.reason).to.be.a("string");
    });

    it("hand-editing a past line into non-JSON is still a BROKEN exit 3 (never a silent IO pass)", async function () {
      const { dir, packet } = await mkSealed();
      const jf = path.join(path.dirname(packet), "integrity.jsonl");
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T0" }, capture());
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T1" }, capture());

      const lines = readLines(jf);
      lines[0] = lines[0].slice(0, -5) + "{{corrupt"; // mangle the first line into invalid JSON
      fs.writeFileSync(jf, lines.join("\n") + "\n");

      const v = capture();
      expect(journalCli.runJournalVerify({ journal: jf, json: true }, v)).to.equal(3);
      expect(JSON.parse(v.out()).verdict).to.equal("BROKEN");
    });

    it("deleting a past line (a dropped middle entry) is caught as a BROKEN exit 3", async function () {
      const { dir, packet } = await mkSealed();
      const jf = path.join(path.dirname(packet), "integrity.jsonl");
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T0" }, capture());
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T1" }, capture());
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T2" }, capture());

      const lines = readLines(jf);
      lines.splice(1, 1); // drop the middle entry -> seqs no longer match positions
      fs.writeFileSync(jf, lines.join("\n") + "\n");

      const v = capture();
      expect(journalCli.runJournalVerify({ journal: jf, json: true }, v)).to.equal(3);
      const verdict = JSON.parse(v.out());
      expect(verdict.verdict).to.equal("BROKEN");
      expect(verdict.brokenAt).to.equal(1);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // Criterion 4 — append is STRICTLY ADDITIVE: the pre-existing lines are byte-for-byte unchanged.
  // ---------------------------------------------------------------------------------------------------
  describe("append is strictly additive — prior bytes unchanged (criterion 4)", function () {
    it("the bytes of the file BEFORE an append are a byte-for-byte prefix of the bytes AFTER", async function () {
      const { dir, packet } = await mkSealed();
      const jf = path.join(path.dirname(packet), "integrity.jsonl");

      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T0" }, capture());
      const before1 = fs.readFileSync(jf); // Buffer after 1 append

      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T1" }, capture());
      const after2 = fs.readFileSync(jf); // Buffer after 2 appends

      // STRICT ADDITIVITY: the earlier bytes are an exact prefix of the later bytes — no rewrite.
      expect(after2.length).to.be.greaterThan(before1.length);
      expect(after2.slice(0, before1.length).equals(before1)).to.equal(true);

      // And a third append preserves the 2-append prefix too.
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T2" }, capture());
      const after3 = fs.readFileSync(jf);
      expect(after3.slice(0, after2.length).equals(after2)).to.equal(true);
    });

    it("the FIRST line's parsed entry is identical before and after later appends", async function () {
      const { dir, packet } = await mkSealed();
      const jf = path.join(path.dirname(packet), "integrity.jsonl");
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T0" }, capture());
      const firstLineAfter1 = readLines(jf)[0];

      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T1" }, capture());
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T2" }, capture());
      const firstLineAfter3 = readLines(jf)[0];

      // The exact first line text is unchanged (not just logically equal).
      expect(firstLineAfter3).to.equal(firstLineAfter1);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // Criterion 5 — `--json` emits the machine verdict.
  // ---------------------------------------------------------------------------------------------------
  describe("--json emits the machine verdict (criterion 5)", function () {
    it("append --json emits a structured, parseable verdict carrying the recorded envelope VERBATIM", async function () {
      const { dir, packet } = await mkSealed();
      const jf = path.join(path.dirname(packet), "integrity.jsonl");
      const io = capture();
      expect(
        journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T0", json: true }, io)
      ).to.equal(0);
      const j = JSON.parse(io.out());
      expect(j).to.have.property("appended", true);
      expect(j).to.have.property("seq", 0);
      expect(j).to.have.property("entryHash").that.matches(/^0x[0-9a-fA-F]{64}$/);
      // The full composed verdict is carried VERBATIM (the same envelope the persisted entry holds).
      const persisted = JSON.parse(readLines(jf)[0]);
      expect(j.recorded).to.deep.equal(persisted.verdict);
    });

    it("verify --json PASS emits { ok:true, verdict:'PASS', count, head }", async function () {
      const { dir, packet } = await mkSealed();
      const jf = path.join(path.dirname(packet), "integrity.jsonl");
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T0" }, capture());
      const io = capture();
      expect(journalCli.runJournalVerify({ journal: jf, json: true }, io)).to.equal(0);
      const j = JSON.parse(io.out());
      expect(j.ok).to.equal(true);
      expect(j.verdict).to.equal("PASS");
      expect(j.count).to.equal(1);
      expect(j.head).to.match(/^0x[0-9a-fA-F]{64}$/);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // Criterion 6 — the 0/3 exit-code contract matches the SHARED verify contract.
  // ---------------------------------------------------------------------------------------------------
  describe("exit-code contract parity with the shared verify contract (criterion 6)", function () {
    it("journal OK/DRIFT map to the SAME numeric codes as evidence.EXIT OK/FAIL (and USAGE/IO too)", function () {
      // Parity, not a coincidence: 0 = ok, 3 = drift/fail, 2 = usage, 1 = IO across BOTH surfaces.
      expect(journalCli.JOURNAL_EXIT.OK).to.equal(evidence.EXIT.OK);
      expect(journalCli.JOURNAL_EXIT.DRIFT).to.equal(evidence.EXIT.FAIL);
      expect(journalCli.JOURNAL_EXIT.USAGE).to.equal(evidence.EXIT.USAGE);
      expect(journalCli.JOURNAL_EXIT.IO).to.equal(evidence.EXIT.IO);
      // And the specific 0/3 the acceptance criteria call out:
      expect(journalCli.JOURNAL_EXIT.OK).to.equal(0);
      expect(journalCli.JOURNAL_EXIT.DRIFT).to.equal(3);
    });

    it("a genuine `vh evidence verify` of the SAME clean artifact exits 0, matching journal verify's PASS", async function () {
      const { dir, packet } = await mkSealed();
      // The evidence verify surface is the composed verify path the journal records — its exit on a clean
      // packet is 0 (ACCEPTED), the same code journal verify returns for an all-ACCEPTED chain.
      const ev = capture();
      expect(await evidence.runEvidenceVerify({ packet, dir }, ev)).to.equal(evidence.EXIT.OK);

      const jf = path.join(path.dirname(packet), "integrity.jsonl");
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T0" }, capture());
      expect(journalCli.runJournalVerify({ journal: jf }, capture())).to.equal(0);
    });

    it("a genuine `vh evidence verify` of a TAMPERED artifact exits 3, matching journal's recorded-drift verify", async function () {
      const { dir, packet } = await mkSealed();
      fs.writeFileSync(path.join(dir, "a.txt"), "TAMPERED\n");
      // Direct evidence verify: exit 3 (REJECTED).
      const ev = capture();
      expect(await evidence.runEvidenceVerify({ packet, dir }, ev)).to.equal(evidence.EXIT.FAIL);

      // Journal: record that same drift, then verify -> the SAME exit 3.
      const jf = path.join(path.dirname(packet), "integrity.jsonl");
      journalCli.runJournalAppend({ artifact: packet, to: jf, dir, ts: "T0" }, capture());
      expect(journalCli.runJournalVerify({ journal: jf }, capture())).to.equal(3);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // Dispatch + argument handling (the verb wiring in vh.js and the journal-cli dispatcher).
  // ---------------------------------------------------------------------------------------------------
  describe("dispatch + usage errors", function () {
    it("`vh journal` with no subcommand prints usage and exits 2", async function () {
      const io = capture();
      expect(await journalCli.cmdJournal([], io)).to.equal(2);
      expect(io.out()).to.match(/vh journal/);
    });

    it("`vh journal help` prints usage and exits 0", async function () {
      const io = capture();
      expect(await journalCli.cmdJournal(["help"], io)).to.equal(0);
      expect(io.out()).to.match(/append/);
      expect(io.out()).to.match(/verify/);
    });

    it("an unknown journal subcommand exits 2 with a helpful error", async function () {
      const io = capture();
      expect(await journalCli.cmdJournal(["frobnicate"], io)).to.equal(2);
      expect(io.err()).to.match(/unknown journal subcommand/);
    });

    it("`append` without --to is a usage error (exit 2)", async function () {
      const { packet } = await mkSealed();
      const io = capture();
      expect(await journalCli.cmdJournal(["append", packet], io)).to.equal(2);
      expect(io.err()).to.match(/--to/);
    });

    it("`append` without an artifact is a usage error (exit 2)", async function () {
      const io = capture();
      expect(await journalCli.cmdJournal(["append", "--to", "/tmp/none.jsonl"], io)).to.equal(2);
      expect(io.err()).to.match(/artifact/);
    });

    it("`verify` without a journalfile is a usage error (exit 2)", async function () {
      const io = capture();
      expect(await journalCli.cmdJournal(["verify"], io)).to.equal(2);
      expect(io.err()).to.match(/journalfile/);
    });

    it("`verify` on a missing journal file is an IO error (exit 1), not a false PASS", async function () {
      const io = capture();
      const missing = path.join(mkTmp(), "does-not-exist.jsonl");
      expect(await journalCli.cmdJournal(["verify", missing], io)).to.equal(1);
      expect(io.err()).to.match(/does not exist/);
    });

    it("`append` on an unreadable artifact is an IO error (exit 1)", async function () {
      const io = capture();
      const jf = path.join(mkTmp(), "j.jsonl");
      expect(
        await journalCli.cmdJournal(["append", "/no/such/artifact.json", "--to", jf], io)
      ).to.equal(1);
      expect(io.err()).to.match(/cannot read artifact/);
    });

    it("an unknown flag on append is a usage error (exit 2)", async function () {
      const io = capture();
      expect(await journalCli.cmdJournal(["append", "x", "--to", "j", "--bogus"], io)).to.equal(2);
      expect(io.err()).to.match(/unknown flag/);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // End-to-end through the real `vh` main() dispatcher — proves the verb is wired into cli/vh.js.
  // ---------------------------------------------------------------------------------------------------
  describe("wired into `vh` main() (cli/vh.js)", function () {
    // main() writes to process.stdout/stderr; we only assert the exit CODE here (the io-injected paths
    // above already assert the output shape), so this stays quiet and deterministic.
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

    it("`vh journal append ... --to ...` twice then `vh journal verify` exits 0", async function () {
      const { dir, packet } = await mkSealed();
      const jf = path.join(path.dirname(packet), "integrity.jsonl");
      expect(await vh.main(["journal", "append", packet, "--to", jf, "--dir", dir, "--ts", "T0"])).to.equal(0);
      expect(await vh.main(["journal", "append", packet, "--to", jf, "--dir", dir, "--ts", "T1"])).to.equal(0);
      expect(await vh.main(["journal", "verify", jf])).to.equal(0);
    });

    it("`vh journal verify` exits 3 after a tampered-artifact append is recorded", async function () {
      const { dir, packet } = await mkSealed();
      const jf = path.join(path.dirname(packet), "integrity.jsonl");
      await vh.main(["journal", "append", packet, "--to", jf, "--dir", dir, "--ts", "T0"]);
      fs.writeFileSync(path.join(dir, "a.txt"), "TAMPERED\n");
      await vh.main(["journal", "append", packet, "--to", jf, "--dir", dir, "--ts", "T1"]);
      expect(await vh.main(["journal", "verify", jf])).to.equal(3);
    });
  });
});

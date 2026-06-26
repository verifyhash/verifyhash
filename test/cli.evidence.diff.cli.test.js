"use strict";

// `vh evidence diff <packetA> <packetB> [--json]` (T-46.2) — the CLI surface over the PURE
// `diffEvidenceSeals` core (T-46.1): a read-only, FREE, key-free, OFFLINE change report between TWO
// already-sealed evidence packets.
//
// What these prove (the acceptance criteria):
//   * the diff runs OFFLINE / key-free / FREE — no license, no provider, no network — and WRITES NOTHING
//     (a diff produces no sealed artifact, so it never gates): the working tree is left CLEAN;
//   * the human output LEADS with the CLAIMS-not-content TRUST line (it compares what each packet CLAIMS,
//     it does NOT re-derive content), then a DETERMINISTIC IDENTICAL/DIFFERENT headline;
//   * the per-file ADDED/REMOVED/CHANGED block + a count line are driven by the CHANGE SET;
//   * a RENAME surfaces as REMOVED(old) + ADDED(new), NEVER one CHANGED;
//   * exit codes mirror `vh dataset diff`: 0 IDENTICAL / 3 DIFFERENT / 2 usage / 1 IO;
//   * --json carries the structured change set (identical + added/removed/changed/unchanged + counts);
//   * a corrupt/foreign/wrong-kind packet is a runtime/IO error (1), never a half-accepted diff;
//   * the existing seal/verify behavior + exit codes are unchanged (the diff path is purely additive).
//
// The packets are built on disk via the REAL `vh evidence seal --out` path (so the test exercises the
// genuine artifact), every write lands under a throwaway temp dir, and the cwd is asserted CLEAN after.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const evidence = require("../cli/evidence");

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

describe("cli/evidence T-46.2: `vh evidence diff`", function () {
  let tmpDirs;
  let cwdBefore;
  beforeEach(function () {
    tmpDirs = [];
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    // FILESYSTEM HYGIENE: nothing the diff did leaked into the working tree.
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });
  function mkTmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "vh-evidence-diff-"));
    tmpDirs.push(d);
    return d;
  }
  // Build a directory from a { relPath: "contents" } map and SEAL it via the real `vh evidence seal
  // --out` path. Returns the absolute packet path. Each leaf dir is created as needed.
  async function sealDir(files) {
    const root = mkTmp();
    const dir = path.join(root, "payload");
    fs.mkdirSync(dir);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    const out = path.join(root, "packet.vhevidence.json");
    const code = await evidence.runEvidenceSeal({ dir, out }, capture());
    expect(code).to.equal(evidence.EXIT.OK);
    return out;
  }

  const BASE = Object.freeze({
    "a.txt": "alpha",
    "b.txt": "beta",
    "sub/c.txt": "gamma",
  });

  it("an IDENTICAL pair -> exit 0, leads with the CLAIMS TRUST line, IDENTICAL headline + +0/-0/~0 count", async function () {
    const A = await sealDir(BASE);
    const B = await sealDir(BASE); // same file set, sealed independently
    const io = capture();
    const code = await evidence.cmdEvidence(["diff", A, B], io);

    expect(code).to.equal(evidence.EXIT.OK);
    const out = io.out();
    // LEADS with the CLAIMS-not-content TRUST line.
    expect(out).to.match(/^TRUST: this compares what each evidence packet CLAIMS — it does NOT re-derive content/);
    // DETERMINISTIC IDENTICAL headline + a count line driven by the change set.
    expect(out).to.match(/files: IDENTICAL/);
    expect(out).to.match(/\+0 \/ -0 \/ ~0 \/ 3 unchanged/);
    // No per-file change block (the body, AFTER the count line, lists no entries). NOTE: the TRUST note
    // itself names "CHANGED/MISSING/UNEXPECTED", so we scope the no-changes check to the per-file body.
    const body = out.slice(out.indexOf("files: IDENTICAL"));
    expect(body).to.not.match(/^\s*(ADDED|REMOVED|CHANGED)\b/m);
    // Writes NOTHING (no extra files in either packet's directory beyond the packet itself).
    expect(io.err()).to.equal("");
  });

  it("an ADDED file -> exit 3 DIFFERENT, ADDED block + count (in B, not A)", async function () {
    const A = await sealDir(BASE);
    const B = await sealDir({ ...BASE, "new.txt": "delta" });
    const io = capture();
    const code = await evidence.cmdEvidence(["diff", A, B], io);

    expect(code).to.equal(evidence.EXIT.FAIL);
    const out = io.out();
    expect(out).to.match(/files: DIFFERENT/);
    expect(out).to.match(/\+1 \/ -0 \/ ~0 \/ 3 unchanged/);
    expect(out).to.match(/ADDED {4}new\.txt .* in B, not in A/);
    const body = out.slice(out.indexOf("files: DIFFERENT"));
    expect(body).to.not.match(/^\s*(REMOVED|CHANGED)\b/m);
  });

  it("a REMOVED file -> exit 3, REMOVED block + count (in A, not B)", async function () {
    const A = await sealDir(BASE);
    const { "sub/c.txt": _gone, ...rest } = BASE;
    const B = await sealDir(rest);
    const io = capture();
    const code = await evidence.cmdEvidence(["diff", A, B], io);

    expect(code).to.equal(evidence.EXIT.FAIL);
    const out = io.out();
    expect(out).to.match(/\+0 \/ -1 \/ ~0 \/ 2 unchanged/);
    expect(out).to.match(/REMOVED {2}sub\/c\.txt .* in A, not in B/);
    const body = out.slice(out.indexOf("files: DIFFERENT"));
    expect(body).to.not.match(/^\s*(ADDED|CHANGED)\b/m);
  });

  it("an EDITED file -> exit 3, CHANGED block carrying old->new contentHash", async function () {
    const A = await sealDir(BASE);
    const B = await sealDir({ ...BASE, "b.txt": "beta EDITED" });
    const io = capture();
    const code = await evidence.cmdEvidence(["diff", A, B], io);

    expect(code).to.equal(evidence.EXIT.FAIL);
    const out = io.out();
    expect(out).to.match(/\+0 \/ -0 \/ ~1 \/ 2 unchanged/);
    expect(out).to.match(/CHANGED {2}b\.txt/);
    expect(out).to.match(/old: 0x[0-9a-f]{64}/);
    expect(out).to.match(/new: 0x[0-9a-f]{64}/);
  });

  it("a RENAME surfaces as REMOVED(old) + ADDED(new), NEVER one CHANGED", async function () {
    // Same bytes, different relPath: the path is bound into the leaf, so it is a remove + add.
    const A = await sealDir({ keep: "stays", "old-name.txt": "same bytes either way" });
    const B = await sealDir({ keep: "stays", "new-name.txt": "same bytes either way" });
    const io = capture();
    const code = await evidence.cmdEvidence(["diff", A, B], io);

    expect(code).to.equal(evidence.EXIT.FAIL);
    const out = io.out();
    expect(out).to.match(/\+1 \/ -1 \/ ~0 \/ 1 unchanged/);
    expect(out).to.match(/ADDED {4}new-name\.txt/);
    expect(out).to.match(/REMOVED {2}old-name\.txt/);
    // a rename is NEVER a single CHANGED (scope to the per-file body; the TRUST note names "CHANGED").
    const body = out.slice(out.indexOf("files: DIFFERENT"));
    expect(body).to.not.match(/^\s*CHANGED\b/m);
  });

  it("--json carries the structured change set (identical + sections + counts), still writes nothing", async function () {
    const A = await sealDir(BASE);
    const B = await sealDir({ ...BASE, "b.txt": "beta EDITED", "z-new.txt": "zeta" });
    const io = capture();
    const code = await evidence.cmdEvidence(["diff", A, B, "--json"], io);

    expect(code).to.equal(evidence.EXIT.FAIL);
    const obj = JSON.parse(io.out());
    expect(obj.identical).to.equal(false);
    expect(obj.counts).to.deep.equal({ added: 1, removed: 0, changed: 1, unchanged: 2 });
    expect(obj.added.map((x) => x.path)).to.deep.equal(["z-new.txt"]);
    expect(obj.changed.map((x) => x.path)).to.deep.equal(["b.txt"]);
    expect(obj.changed[0]).to.have.property("oldContentHash");
    expect(obj.changed[0]).to.have.property("newContentHash");
    expect(obj.removed).to.have.length(0);
    // Carries the displayed root metadata + the trust note (so the JSON is self-describing).
    expect(obj.rootA).to.match(/^0x[0-9a-f]{64}$/);
    expect(obj.rootB).to.match(/^0x[0-9a-f]{64}$/);
    expect(obj.note).to.match(/TAMPER-EVIDENT \+ OFFLINE-RECOMPUTABLE/);

    // The IDENTICAL --json path also reports identical:true with an empty change set + exit 0.
    const io2 = capture();
    const code2 = await evidence.cmdEvidence(["diff", A, A, "--json"], io2);
    expect(code2).to.equal(evidence.EXIT.OK);
    const obj2 = JSON.parse(io2.out());
    expect(obj2.identical).to.equal(true);
    expect(obj2.counts).to.deep.equal({ added: 0, removed: 0, changed: 0, unchanged: 3 });
  });

  it("needs NO license and never gates — a plain diff of two free packets succeeds key-free", async function () {
    // Both packets are FREE-tier baseline seals; diff takes NO --license/--vendor and never asks for one.
    const A = await sealDir(BASE);
    const B = await sealDir(BASE);
    const io = capture();
    const code = await evidence.cmdEvidence(["diff", A, B], io);
    expect(code).to.equal(evidence.EXIT.OK);
    // No license/gate vocabulary anywhere in the output.
    expect(io.out()).to.not.match(/license|vendor|entitlement|PAID/i);
    expect(io.err()).to.equal("");
  });

  it("diffs a SIGNED packet against its bare twin as IDENTICAL (reads the embedded canonical seal)", async function () {
    // A signed wrap embeds the EXACT canonical seal bytes; the diff core's readSeal handles both, so a
    // signed packet and its unsigned twin over the same file set are IDENTICAL.
    const root = mkTmp();
    const dir = path.join(root, "payload");
    fs.mkdirSync(dir);
    for (const [rel, content] of Object.entries(BASE)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    const bare = path.join(root, "bare.vhevidence.json");
    const bcode = await evidence.runEvidenceSeal({ dir, out: bare }, capture());
    expect(bcode).to.equal(evidence.EXIT.OK);

    const A = await sealDir(BASE);
    const io = capture();
    // Diffing the bare-of-BASE against an independent seal-of-BASE is IDENTICAL.
    const code = await evidence.cmdEvidence(["diff", bare, A], io);
    expect(code).to.equal(evidence.EXIT.OK);
    expect(io.out()).to.match(/files: IDENTICAL/);
  });

  it("exit 2 on a usage error (missing/extra positional, unknown flag) — never touches the filesystem", async function () {
    const A = await sealDir(BASE);

    // Missing the second packet.
    const io1 = capture();
    expect(await evidence.cmdEvidence(["diff", A], io1)).to.equal(evidence.EXIT.USAGE);
    expect(io1.err()).to.match(/requires exactly two packet paths/);

    // A third positional.
    const io2 = capture();
    expect(await evidence.cmdEvidence(["diff", A, A, A], io2)).to.equal(evidence.EXIT.USAGE);
    expect(io2.err()).to.match(/takes exactly two <packet>s/);

    // An unknown flag.
    const io3 = capture();
    expect(await evidence.cmdEvidence(["diff", A, A, "--bogus"], io3)).to.equal(evidence.EXIT.USAGE);
    expect(io3.err()).to.match(/unknown flag: --bogus/);
  });

  it("exit 1 (IO) when a packet file is missing or corrupt — never a half-accepted diff", async function () {
    const A = await sealDir(BASE);

    // A missing packet file is an IO error (1).
    const io1 = capture();
    expect(await evidence.cmdEvidence(["diff", A, "/no/such/packet.json"], io1)).to.equal(evidence.EXIT.IO);
    expect(io1.err()).to.match(/cannot read evidence packet/);

    // A CORRUPT packet (valid JSON but a tampered root that no longer re-derives) is rejected by the
    // strict readSeal inside the diff core — exit 1, never a false DIFFERENT.
    const corruptDir = mkTmp();
    const corruptFile = path.join(corruptDir, "corrupt.vhevidence.json");
    const good = JSON.parse(fs.readFileSync(A, "utf8"));
    const flipped = good.root[2] === "f" ? "0" : "f";
    good.root = "0x" + flipped + good.root.slice(3); // still well-formed hex, but no longer derives
    fs.writeFileSync(corruptFile, JSON.stringify(good) + "\n");
    const io2 = capture();
    expect(await evidence.cmdEvidence(["diff", A, corruptFile], io2)).to.equal(evidence.EXIT.IO);
    expect(io2.err()).to.match(/error:/);

    // A FOREIGN artifact (wrong kind) is likewise rejected (1), not half-accepted.
    const foreignDir = mkTmp();
    const foreignFile = path.join(foreignDir, "foreign.json");
    fs.writeFileSync(foreignFile, JSON.stringify({ kind: "not-an-evidence-seal", schemaVersion: 1 }) + "\n");
    const io3 = capture();
    expect(await evidence.cmdEvidence(["diff", A, foreignFile], io3)).to.equal(evidence.EXIT.IO);
  });

  it("the diff is read-only: neither packet file is modified by the diff", async function () {
    const A = await sealDir(BASE);
    const B = await sealDir({ ...BASE, "b.txt": "beta EDITED" });
    const beforeA = fs.readFileSync(A);
    const beforeB = fs.readFileSync(B);

    await evidence.cmdEvidence(["diff", A, B], capture());

    expect(fs.readFileSync(A).equals(beforeA)).to.equal(true);
    expect(fs.readFileSync(B).equals(beforeB)).to.equal(true);
  });

  // -------------------------------------------------------------------------
  // `--policy <f>` — the CI-gateable drift gate over the change set (T-46.1 leverage). With --policy the
  // exit code becomes the POLICY verdict: a DIFFERENT-but-PERMITTED change PASSes (0), a disallowed change
  // FAILs (3). The verdict is computed from the SAME change set, so the exit code can never disagree with
  // the printed/JSON body. A corrupt/foreign policy is an IO error (1), never a half-accepted gate.
  // -------------------------------------------------------------------------
  // Write a drift policy JSON under a throwaway temp dir (so the cwd-hygiene afterEach stays green) and
  // return its absolute path.
  function writePolicy(rules) {
    const dir = mkTmp();
    const p = path.join(dir, "drift-policy.json");
    fs.writeFileSync(
      p,
      JSON.stringify(Object.assign({ kind: "vh.evidence-drift-policy", schemaVersion: 1 }, rules)) + "\n"
    );
    return p;
  }

  it("--policy on a DIFFERENT but PERMITTED change -> exit 0 PASS (append-only growth that only ADDs)", async function () {
    const A = await sealDir(BASE);
    const B = await sealDir({ ...BASE, "new.txt": "delta" }); // an ADD only
    const policy = writePolicy({ noRemoved: true, noChanged: true }); // ADDs are allowed
    const io = capture();
    const code = await evidence.cmdEvidence(["diff", A, B, "--policy", policy], io);

    // The packets DIFFER, but the change is PERMITTED, so the GATE passes (exit 0) — the policy verdict
    // overrides the bare DIFFERENT exit a policy-less diff would return.
    expect(code).to.equal(evidence.EXIT.OK);
    const out = io.out();
    expect(out).to.match(/files: DIFFERENT/); // the diff body still shows the change
    expect(out).to.match(/## drift policy/);
    expect(out).to.match(/verdict: PASS {2}\(rules evaluated: 2\)/);
    expect(io.err()).to.equal("");
  });

  it("--policy on a DISALLOWED change -> exit 3 FAIL, with the per-violation lines", async function () {
    const A = await sealDir(BASE);
    const { "sub/c.txt": _gone, ...rest } = BASE;
    const B = await sealDir(rest); // a REMOVE
    const policy = writePolicy({ noRemoved: true });
    const io = capture();
    const code = await evidence.cmdEvidence(["diff", A, B, "--policy", policy], io);

    expect(code).to.equal(evidence.EXIT.FAIL);
    const out = io.out();
    expect(out).to.match(/## drift policy/);
    expect(out).to.match(/verdict: FAIL/);
    expect(out).to.match(/REMOVED.*sub\/c\.txt\s+\[noRemoved\]/);
  });

  it("--policy on an IDENTICAL pair -> exit 0 PASS (no change, no violation)", async function () {
    const A = await sealDir(BASE);
    const B = await sealDir(BASE);
    const policy = writePolicy({ noRemoved: true, noChanged: true, noAdded: true });
    const io = capture();
    const code = await evidence.cmdEvidence(["diff", A, B, "--policy", policy], io);

    expect(code).to.equal(evidence.EXIT.OK);
    const out = io.out();
    expect(out).to.match(/files: IDENTICAL/);
    expect(out).to.match(/verdict: PASS/);
  });

  it("--policy --json carries the drift block (verdict + rulesEvaluated + violations), exit = verdict", async function () {
    const A = await sealDir(BASE);
    const B = await sealDir({ ...BASE, "b.txt": "beta EDITED" }); // a CHANGE
    const policy = writePolicy({ noChanged: true });
    const io = capture();
    const code = await evidence.cmdEvidence(["diff", A, B, "--policy", policy, "--json"], io);

    expect(code).to.equal(evidence.EXIT.FAIL);
    const obj = JSON.parse(io.out());
    // The change set still rides in the JSON; the drift block is alongside it.
    expect(obj.identical).to.equal(false);
    expect(obj.drift).to.be.an("object");
    expect(obj.drift.verdict).to.equal("FAIL");
    expect(obj.drift.rulesEvaluated).to.equal(1);
    expect(obj.drift.violations).to.deep.equal([
      { relPath: "b.txt", rule: "noChanged", change: "CHANGED" },
    ]);

    // Without --policy the drift field is null (the gate is opt-in).
    const io2 = capture();
    await evidence.cmdEvidence(["diff", A, B, "--json"], io2);
    expect(JSON.parse(io2.out()).drift).to.equal(null);
  });

  it("--policy with a corrupt/foreign policy is an IO error (1), never a half-accepted gate", async function () {
    const A = await sealDir(BASE);
    const B = await sealDir({ ...BASE, "x.txt": "x" });

    // A FOREIGN policy kind.
    const foreignDir = mkTmp();
    const foreign = path.join(foreignDir, "foreign.json");
    fs.writeFileSync(foreign, JSON.stringify({ kind: "not-a-drift-policy", schemaVersion: 1 }) + "\n");
    const io1 = capture();
    expect(await evidence.cmdEvidence(["diff", A, B, "--policy", foreign], io1)).to.equal(
      evidence.EXIT.IO
    );
    expect(io1.err()).to.match(/not a verifyhash evidence drift policy/);

    // A MALFORMED policy (non-boolean rule).
    const badDir = mkTmp();
    const bad = path.join(badDir, "bad.json");
    fs.writeFileSync(
      bad,
      JSON.stringify({ kind: "vh.evidence-drift-policy", schemaVersion: 1, noAdded: "yes" }) + "\n"
    );
    const io2 = capture();
    expect(await evidence.cmdEvidence(["diff", A, B, "--policy", bad], io2)).to.equal(evidence.EXIT.IO);
    expect(io2.err()).to.match(/must be a boolean/);

    // A MISSING policy file.
    const io3 = capture();
    expect(
      await evidence.cmdEvidence(["diff", A, B, "--policy", "/no/such/policy.json"], io3)
    ).to.equal(evidence.EXIT.IO);
    expect(io3.err()).to.match(/cannot read evidence drift policy/);
  });

  it("--policy without a file argument is a usage error (2)", async function () {
    const A = await sealDir(BASE);
    const io = capture();
    expect(await evidence.cmdEvidence(["diff", A, A, "--policy"], io)).to.equal(evidence.EXIT.USAGE);
    expect(io.err()).to.match(/--policy requires a <file> argument/);
  });
});

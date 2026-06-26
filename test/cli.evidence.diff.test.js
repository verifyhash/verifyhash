"use strict";

// `diffEvidence` / `diffEvidenceSeals` (T-46.1) — the PURE, OFFLINE, packet-to-packet change report for
// the EVIDENCE product, the mirror of `cli/dataset.js › runDatasetDiff`.
//
// What these prove (the acceptance criteria):
//   * PURE / OFFLINE / I/O-free / deterministic / order-independent — no directory, no provider, no key,
//     no network: every input is a parsed seal OBJECT or a packet STRING, never a path;
//   * BOTH inputs are validated through the EXISTING strict `readSeal` BEFORE any diff (a corrupt /
//     foreign / wrong-kind / hand-edited packet is REJECTED, never half-accepted);
//   * the change set is DIRECTIONAL (A = baseline / "recorded", B = comparison / "current"):
//       - an identical pair    → identical:true, +0 / -0 / ~0,
//       - an ADDED file        → ADDED only,
//       - a REMOVED file       → REMOVED only,
//       - an EDITED file       → CHANGED, carrying old→new contentHash,
//       - a RENAMED file       → REMOVED(old) + ADDED(new), NEVER one CHANGED (the relPath is in the leaf);
//   * the AUTHORITATIVE `identical` is the CHANGE SET (`diff.identical`), NOT root-string equality — so a
//     hand-edited `root` cannot flip the verdict; in the evidence product `readSeal` re-derives the root
//     over the leaves, so a hand-edited root is REJECTED outright (an even stronger guarantee than the
//     dataset case), and the verdict still ignores root strings;
//   * neither input packet is MUTATED;
//   * accepts EITHER two seal objects OR two packet strings (or a mix), via BOTH the `{ packetA, packetB }`
//     object form and the positional `seal`-object overload.
//
// This file touches NO filesystem (no temp dirs): the packets are built in-process via `evidence.buildSeal`
// — the same pure builder `vh evidence seal` uses — so the working tree is left untouched by construction.

const { expect } = require("chai");
const { keccak256 } = require("ethers");

const evidence = require("../cli/evidence");
const { PacketSealError } = require("../cli/core/packetseal");

// Build a bare evidence seal from a { relPath: "string contents" } map. The bytes are exactly what
// `buildSeal` (and `vh evidence seal`) hash, so a per-file contentHash equals keccak256(those bytes).
function seal(files) {
  const entries = Object.entries(files).map(([relPath, content]) => ({
    relPath,
    bytes: Buffer.from(content),
  }));
  return evidence.buildSeal(entries);
}

// The contentHash the seal records for a given string content — keccak256 over the bytes. Lets the tests
// assert the exact old→new hashes a CHANGED entry carries (and that a rename keeps the same hash).
function contentHashOf(content) {
  return keccak256(Buffer.from(content));
}

const BASE = Object.freeze({
  "a.txt": "alpha",
  "b.txt": "beta",
  "sub/c.txt": "gamma",
});

describe("cli/evidence T-46.1: diffEvidence — pure, offline packet-to-packet diff", function () {
  it("an IDENTICAL pair → identical:true, +0 / -0 / ~0 (all unchanged)", function () {
    const A = seal(BASE);
    const B = seal(BASE); // same file set, built independently
    const d = evidence.diffEvidence({ packetA: A, packetB: B });

    expect(d.identical).to.equal(true);
    expect(d.counts).to.deep.equal({ added: 0, removed: 0, changed: 0, unchanged: 3 });
    expect(d.added).to.have.length(0);
    expect(d.removed).to.have.length(0);
    expect(d.changed).to.have.length(0);
    // Two independently-built seals over the SAME bytes share a root (deterministic), so the displayed
    // metadata agrees with the (authoritative) change set here.
    expect(d.rootsIdentical).to.equal(true);
    expect(d.rootA).to.equal(d.rootB);
  });

  it("an ADDED file → ADDED only (in B, not A)", function () {
    const A = seal(BASE);
    const B = seal({ ...BASE, "new.txt": "delta" });
    const d = evidence.diffEvidence({ packetA: A, packetB: B });

    expect(d.identical).to.equal(false);
    expect(d.counts).to.deep.equal({ added: 1, removed: 0, changed: 0, unchanged: 3 });
    expect(d.added.map((x) => x.path)).to.deep.equal(["new.txt"]);
    expect(d.added[0].contentHash).to.equal(contentHashOf("delta"));
    expect(d.removed).to.have.length(0);
    expect(d.changed).to.have.length(0);
  });

  it("a REMOVED file → REMOVED only (in A, not B)", function () {
    const A = seal(BASE);
    const { "sub/c.txt": _gone, ...rest } = BASE;
    const B = seal(rest);
    const d = evidence.diffEvidence({ packetA: A, packetB: B });

    expect(d.identical).to.equal(false);
    expect(d.counts).to.deep.equal({ added: 0, removed: 1, changed: 0, unchanged: 2 });
    expect(d.removed.map((x) => x.path)).to.deep.equal(["sub/c.txt"]);
    expect(d.removed[0].contentHash).to.equal(contentHashOf("gamma"));
    expect(d.added).to.have.length(0);
    expect(d.changed).to.have.length(0);
  });

  it("an EDITED file → CHANGED with old→new contentHash (same relPath, different leaf)", function () {
    const A = seal(BASE);
    const B = seal({ ...BASE, "b.txt": "beta EDITED" });
    const d = evidence.diffEvidence({ packetA: A, packetB: B });

    expect(d.identical).to.equal(false);
    expect(d.counts).to.deep.equal({ added: 0, removed: 0, changed: 1, unchanged: 2 });
    expect(d.changed.map((c) => c.path)).to.deep.equal(["b.txt"]);
    // Directional: old (A) → new (B), carried verbatim from the diff core.
    expect(d.changed[0].oldContentHash).to.equal(contentHashOf("beta"));
    expect(d.changed[0].newContentHash).to.equal(contentHashOf("beta EDITED"));
    expect(d.added).to.have.length(0);
    expect(d.removed).to.have.length(0);
  });

  it("a RENAMED file → REMOVED(old) + ADDED(new), same bytes — NEVER one CHANGED", function () {
    // Same bytes, different relPath: the path is bound into the leaf, so this is a remove + add.
    const A = seal({ keep: "stays", "old-name.txt": "same bytes either way" });
    const B = seal({ keep: "stays", "new-name.txt": "same bytes either way" });
    const d = evidence.diffEvidence({ packetA: A, packetB: B });

    expect(d.identical).to.equal(false);
    expect(d.counts).to.deep.equal({ added: 1, removed: 1, changed: 0, unchanged: 1 });
    expect(d.removed.map((r) => r.path)).to.deep.equal(["old-name.txt"]);
    expect(d.added.map((a) => a.path)).to.deep.equal(["new-name.txt"]);
    expect(d.changed).to.have.length(0); // a rename is NEVER a single CHANGED
    const sameHash = contentHashOf("same bytes either way");
    expect(d.removed[0].contentHash).to.equal(sameHash);
    expect(d.added[0].contentHash).to.equal(sameHash);
  });

  it("the verdict is the CHANGE SET, NOT root-string equality — a hand-edited root cannot flip it", function () {
    // PART 1 — `identical` is `diff.identical`, never `rootsIdentical`. Build A and a deep-clone B with
    // IDENTICAL leaves; both validate, their roots are equal (root is a deterministic fold over the
    // leaves), and the verdict is identical:true driven by the empty change set.
    const A = seal(BASE);
    const B = JSON.parse(JSON.stringify(A)); // a structurally-identical packet OBJECT
    const d = evidence.diffEvidence({ packetA: A, packetB: B });
    expect(d.identical).to.equal(true);
    expect(d.rootsIdentical).to.equal(true);
    expect(d.counts).to.deep.equal({ added: 0, removed: 0, changed: 0, unchanged: 3 });

    // PART 2 — a hand-edited `root` (leaves intact) cannot flip the verdict because, in the EVIDENCE
    // product, the strict `readSeal` RE-DERIVES the root over the listed leaves and REJECTS an
    // internally-inconsistent packet BEFORE any diff (an even stronger guarantee than the dataset case,
    // where a hand-edited root survives validation). So a tampered root can never reach the diff to
    // produce a false identical:false — it is rejected outright.
    const tampered = JSON.parse(JSON.stringify(A));
    const flipped = tampered.root[2] === "f" ? "0" : "f";
    tampered.root = "0x" + flipped + tampered.root.slice(3); // still a well-formed 32-byte hex
    expect(() => evidence.diffEvidence({ packetA: A, packetB: tampered })).to.throw(
      PacketSealError,
      /root does not re-derive/
    );
    // The verdict field the function returns is the change set's `identical`, NOT the root-string compare:
    // a swapped pair of valid packets whose leaves differ is identical:false regardless of the roots.
    const dDiff = evidence.diffEvidence({ packetA: A, packetB: seal({ ...BASE, "a.txt": "alpha2" }) });
    expect(dDiff.identical).to.equal(false);
  });

  it("REJECTS a corrupt / foreign / wrong-kind packet via readSeal (no half-accept) — for EITHER side", function () {
    const A = seal(BASE);

    // A FOREIGN artifact (wrong kind) is rejected — as either packetA or packetB.
    const foreign = { kind: "not-an-evidence-seal", schemaVersion: 1 };
    expect(() => evidence.diffEvidence({ packetA: A, packetB: foreign })).to.throw(PacketSealError);
    expect(() => evidence.diffEvidence({ packetA: foreign, packetB: A })).to.throw(PacketSealError);

    // A CORRUPT packet — valid evidence kind but a non-hex root — is rejected (strict structural check).
    const corrupt = JSON.parse(JSON.stringify(A));
    corrupt.root = "0xnothex";
    expect(() => evidence.diffEvidence({ packetA: A, packetB: corrupt })).to.throw(PacketSealError);

    // A malformed packet STRING (not JSON) is rejected by readSeal too.
    expect(() => evidence.diffEvidence({ packetA: A, packetB: "{not json" })).to.throw(PacketSealError);

    // Bad args object → a clear PacketSealError, never a crash.
    expect(() => evidence.diffEvidence(null)).to.throw(PacketSealError, /requires \{ packetA, packetB \}/);
  });

  it("accepts EITHER two seal OBJECTS or two packet STRINGS (or a mix), via both the object and positional forms", function () {
    const A = seal(BASE);
    const B = seal({ ...BASE, "b.txt": "beta EDITED" });
    const aStr = evidence.serializeSeal(A);
    const bStr = evidence.serializeSeal(B);

    const fromObjects = evidence.diffEvidence({ packetA: A, packetB: B });
    const fromStrings = evidence.diffEvidence({ packetA: aStr, packetB: bStr });
    const fromMix = evidence.diffEvidence({ packetA: A, packetB: bStr });
    // The positional `seal`-object overload yields the SAME result as the object form.
    const fromPositional = evidence.diffEvidenceSeals(A, B);

    expect(fromStrings).to.deep.equal(fromObjects);
    expect(fromMix).to.deep.equal(fromObjects);
    expect(fromPositional).to.deep.equal(fromObjects);
    expect(fromObjects.changed.map((c) => c.path)).to.deep.equal(["b.txt"]);
  });

  it("is DETERMINISTIC and ORDER-INDEPENDENT, and MUTATES neither input packet", function () {
    const A = seal(BASE);
    const B = seal({ ...BASE, "b.txt": "beta EDITED", "z-new.txt": "zeta" });

    // DETERMINISTIC: two runs over the same inputs are deeply equal.
    const d1 = evidence.diffEvidence({ packetA: A, packetB: B });
    const d2 = evidence.diffEvidence({ packetA: A, packetB: B });
    expect(d1).to.deep.equal(d2);

    // ORDER-INDEPENDENT within each section: a packet whose `files[]` array is REVERSED produces the same
    // change set (the diff is keyed by relPath, not array position). Reverse a CLONE so we never touch the
    // originals (and so we can prove the originals are untouched below).
    const Brev = JSON.parse(JSON.stringify(B));
    Brev.files.reverse();
    const dRev = evidence.diffEvidence({ packetA: A, packetB: Brev });
    expect(dRev).to.deep.equal(d1);
    // Each section is itself sorted by path (the diff core sorts), so the order is stable regardless.
    expect(d1.changed.map((c) => c.path)).to.deep.equal(["b.txt"]);
    expect(d1.added.map((a) => a.path)).to.deep.equal(["z-new.txt"]);

    // MUTATES NEITHER input: capture a deep snapshot before, diff, and assert byte-identical after. Run
    // BOTH the object form and the positional overload to cover both entry points.
    const snapA = JSON.parse(JSON.stringify(A));
    const snapB = JSON.parse(JSON.stringify(B));
    evidence.diffEvidence({ packetA: A, packetB: B });
    evidence.diffEvidenceSeals(A, B);
    expect(A).to.deep.equal(snapA);
    expect(B).to.deep.equal(snapB);
  });
});

// ---------------------------------------------------------------------------
// `evaluateDriftPolicy({ diff, policy })` (T-46.1 leverage) — the CI-gateable PASS/FAIL verdict over the
// change set `diffEvidence` produces. This is the paying-customer upgrade over a bare diff: a buyer who
// pins evidence in a compliance / IP / chain-of-custody pipeline asks "is this change ALLOWED?" and wants
// a verdict (and, in the CLI, a non-zero exit) when it is not.
//
// What these prove:
//   * PURE / deterministic / order-independent: it consumes the EXACT `diffEvidence` change set (no
//     re-diff, no re-hash) and never mutates the diff or the policy;
//   * a NO-rules policy trivially PASSes; the verdict reports `rulesEvaluated` honestly;
//   * each rule (noAdded / noRemoved / noChanged / allowChangePaths / frozenPaths) fires EXACTLY on the
//     change kind it governs, with a segment-aware POSIX path-prefix match (never a sibling-name match);
//   * a RENAME (REMOVED(old)+ADDED(new)) is gated as a remove + an add, never as a silent edit;
//   * violations are sorted (relPath, then rule) so two runs are byte-identical;
//   * a corrupt / foreign / wrong-kind policy is REJECTED (PacketSealError), never half-evaluated.
function driftPolicy(rules) {
  return Object.assign(
    { kind: "vh.evidence-drift-policy", schemaVersion: 1 },
    rules
  );
}

describe("cli/evidence T-46.1: evaluateDriftPolicy — CI-gateable verdict over the change set", function () {
  it("a NO-rules policy trivially PASSes (rulesEvaluated 0), even with a non-empty change set", function () {
    const A = seal(BASE);
    const B = seal({ ...BASE, "new.txt": "delta", "b.txt": "beta EDITED" });
    const diff = evidence.diffEvidence({ packetA: A, packetB: B });

    const v = evidence.evaluateDriftPolicy({ diff, policy: driftPolicy({}) });
    expect(v.verdict).to.equal("PASS");
    expect(v.rulesEvaluated).to.equal(0);
    expect(v.violations).to.have.length(0);
    // The change-kind tallies echo the diff so a consumer reads them from the verdict alone.
    expect(v.addedCount).to.equal(1);
    expect(v.changedCount).to.equal(1);
    expect(v.removedCount).to.equal(0);
  });

  it("noAdded FAILs on an ADDED file (and ONLY on added — a frozen subtree may still grow)", function () {
    const A = seal(BASE);
    const B = seal({ ...BASE, "new.txt": "delta" });
    const diff = evidence.diffEvidence({ packetA: A, packetB: B });

    const v = evidence.evaluateDriftPolicy({ diff, policy: driftPolicy({ noAdded: true }) });
    expect(v.verdict).to.equal("FAIL");
    expect(v.rulesEvaluated).to.equal(1);
    expect(v.violations).to.deep.equal([
      { relPath: "new.txt", rule: "noAdded", change: "ADDED" },
    ]);

    // An ADD under a frozen prefix is allowed: freezing protects what already EXISTS, it does not forbid
    // growth. So `frozenPaths` alone does NOT flag the new file.
    const v2 = evidence.evaluateDriftPolicy({
      diff: evidence.diffEvidence({ packetA: seal(BASE), packetB: seal({ ...BASE, "sub/new.txt": "x" }) }),
      policy: driftPolicy({ frozenPaths: ["sub"] }),
    });
    expect(v2.verdict).to.equal("PASS");
    expect(v2.violations).to.have.length(0);
  });

  it("noRemoved FAILs on a REMOVED file — the append-only / chain-of-custody guard", function () {
    const A = seal(BASE);
    const { "sub/c.txt": _gone, ...rest } = BASE;
    const B = seal(rest);
    const diff = evidence.diffEvidence({ packetA: A, packetB: B });

    const v = evidence.evaluateDriftPolicy({ diff, policy: driftPolicy({ noRemoved: true }) });
    expect(v.verdict).to.equal("FAIL");
    expect(v.violations).to.deep.equal([
      { relPath: "sub/c.txt", rule: "noRemoved", change: "REMOVED" },
    ]);
  });

  it("noChanged FAILs on an EDITED file (same relPath, different content)", function () {
    const A = seal(BASE);
    const B = seal({ ...BASE, "b.txt": "beta EDITED" });
    const diff = evidence.diffEvidence({ packetA: A, packetB: B });

    const v = evidence.evaluateDriftPolicy({ diff, policy: driftPolicy({ noChanged: true }) });
    expect(v.verdict).to.equal("FAIL");
    expect(v.violations).to.deep.equal([
      { relPath: "b.txt", rule: "noChanged", change: "CHANGED" },
    ]);
  });

  it("allowChangePaths FAILs an edit OUTSIDE the allowed subtree and PASSes one inside (segment-aware)", function () {
    // Edit one file under src/ (allowed) and one at the repo root (not allowed).
    const base = { "src/app.js": "v1", "README.md": "r1", "src/keep.js": "k" };
    const A = seal(base);
    const B = seal({ ...base, "src/app.js": "v2", "README.md": "r2" });
    const diff = evidence.diffEvidence({ packetA: A, packetB: B });

    const v = evidence.evaluateDriftPolicy({
      diff,
      policy: driftPolicy({ allowChangePaths: ["src"] }),
    });
    expect(v.verdict).to.equal("FAIL");
    // Only the OUT-of-subtree edit violates; the in-subtree edit is permitted.
    expect(v.violations).to.deep.equal([
      { relPath: "README.md", rule: "allowChangePaths", change: "CHANGED" },
    ]);
  });

  it("the path match is SEGMENT-aware: a prefix never matches a sibling whose name merely starts with it", function () {
    // "src" must NOT match "srcfoo.txt". Editing srcfoo.txt while only src/ is allowed is a violation.
    const base = { "src/a.js": "1", "srcfoo.txt": "x" };
    const A = seal(base);
    const B = seal({ ...base, "srcfoo.txt": "y" });
    const diff = evidence.diffEvidence({ packetA: A, packetB: B });

    const v = evidence.evaluateDriftPolicy({
      diff,
      policy: driftPolicy({ allowChangePaths: ["src"] }),
    });
    expect(v.verdict).to.equal("FAIL");
    expect(v.violations).to.deep.equal([
      { relPath: "srcfoo.txt", rule: "allowChangePaths", change: "CHANGED" },
    ]);

    // A trailing slash on the prefix is equivalent ("src/" === "src" subtree): the in-subtree edit passes.
    const okDiff = evidence.diffEvidence({
      packetA: seal(base),
      packetB: seal({ ...base, "src/a.js": "2" }),
    });
    const ok = evidence.evaluateDriftPolicy({
      diff: okDiff,
      policy: driftPolicy({ allowChangePaths: ["src/"] }),
    });
    expect(ok.verdict).to.equal("PASS");
  });

  it("frozenPaths forbids a CHANGE *or* a REMOVE under the prefix — but permits an ADD there", function () {
    const base = { "legal/contract.pdf": "C", "legal/notes.txt": "N", "work/d.txt": "D" };
    // Edit one frozen file, remove another frozen file, ADD a new frozen-subtree file, edit a non-frozen.
    const A = seal(base);
    const { "legal/notes.txt": _removed, ...rest } = base;
    const B = seal({
      ...rest,
      "legal/contract.pdf": "C2", // CHANGED under frozen -> violation
      "legal/new.txt": "NEW", // ADDED under frozen -> allowed
      "work/d.txt": "D2", // CHANGED outside frozen -> allowed
    });
    const diff = evidence.diffEvidence({ packetA: A, packetB: B });

    const v = evidence.evaluateDriftPolicy({ diff, policy: driftPolicy({ frozenPaths: ["legal"] }) });
    expect(v.verdict).to.equal("FAIL");
    // Sorted by relPath: the changed contract, then the removed notes. The added legal/new.txt and the
    // edited work/d.txt are NOT violations.
    expect(v.violations).to.deep.equal([
      { relPath: "legal/contract.pdf", rule: "frozenPaths", change: "CHANGED" },
      { relPath: "legal/notes.txt", rule: "frozenPaths", change: "REMOVED" },
    ]);
  });

  it("a RENAME (REMOVED+ADDED) under noRemoved/noAdded is gated as a remove + an add, never a silent edit", function () {
    const A = seal({ keep: "k", "old.txt": "same bytes" });
    const B = seal({ keep: "k", "new.txt": "same bytes" });
    const diff = evidence.diffEvidence({ packetA: A, packetB: B });

    const v = evidence.evaluateDriftPolicy({
      diff,
      policy: driftPolicy({ noRemoved: true, noAdded: true }),
    });
    expect(v.verdict).to.equal("FAIL");
    expect(v.violations).to.deep.equal([
      { relPath: "new.txt", rule: "noAdded", change: "ADDED" },
      { relPath: "old.txt", rule: "noRemoved", change: "REMOVED" },
    ]);
  });

  it("one file can violate MULTIPLE rules; violations are sorted (relPath, then rule), deterministically", function () {
    // Edit a frozen file while noChanged is ALSO set: that one CHANGED file breaks both rules.
    const base = { "f/a.txt": "1", "g/b.txt": "2" };
    const A = seal(base);
    const B = seal({ ...base, "f/a.txt": "1x", "g/b.txt": "2x" });
    const diff = evidence.diffEvidence({ packetA: A, packetB: B });

    const v1 = evidence.evaluateDriftPolicy({
      diff,
      policy: driftPolicy({ noChanged: true, frozenPaths: ["f"] }),
    });
    expect(v1.verdict).to.equal("FAIL");
    expect(v1.rulesEvaluated).to.equal(2);
    // f/a.txt breaks BOTH rules (sorted: frozenPaths < noChanged); g/b.txt breaks only noChanged.
    expect(v1.violations).to.deep.equal([
      { relPath: "f/a.txt", rule: "frozenPaths", change: "CHANGED" },
      { relPath: "f/a.txt", rule: "noChanged", change: "CHANGED" },
      { relPath: "g/b.txt", rule: "noChanged", change: "CHANGED" },
    ]);
    // DETERMINISTIC: a second run is byte-identical.
    const v2 = evidence.evaluateDriftPolicy({
      diff,
      policy: driftPolicy({ noChanged: true, frozenPaths: ["f"] }),
    });
    expect(v2).to.deep.equal(v1);
  });

  it("a PERMITTED change set PASSes — append-only growth that only ADDs satisfies noRemoved+noChanged", function () {
    const A = seal(BASE);
    const B = seal({ ...BASE, "d.txt": "delta", "e.txt": "epsilon" });
    const diff = evidence.diffEvidence({ packetA: A, packetB: B });

    const v = evidence.evaluateDriftPolicy({
      diff,
      policy: driftPolicy({ noRemoved: true, noChanged: true }),
    });
    expect(v.verdict).to.equal("PASS");
    expect(v.rulesEvaluated).to.equal(2);
    expect(v.violations).to.have.length(0);
  });

  it("MUTATES neither the diff nor the policy, and is ORDER-INDEPENDENT in the change arrays", function () {
    const A = seal(BASE);
    const B = seal({ "a.txt": "alpha", "z.txt": "zeta", "b.txt": "beta EDITED" }); // removes sub/c.txt, adds z, edits b
    const diff = evidence.diffEvidence({ packetA: A, packetB: B });
    const policy = driftPolicy({ noRemoved: true, noAdded: true, noChanged: true });

    const snapDiff = JSON.parse(JSON.stringify(diff));
    const snapPolicy = JSON.parse(JSON.stringify(policy));
    const v = evidence.evaluateDriftPolicy({ diff, policy });
    expect(diff).to.deep.equal(snapDiff);
    expect(policy).to.deep.equal(snapPolicy);

    // ORDER-INDEPENDENT: reversing each change array yields the SAME verdict (the evaluator sorts).
    const shuffled = JSON.parse(JSON.stringify(diff));
    shuffled.added.reverse();
    shuffled.removed.reverse();
    shuffled.changed.reverse();
    const v2 = evidence.evaluateDriftPolicy({ diff: shuffled, policy });
    expect(v2).to.deep.equal(v);
  });

  it("REJECTS a corrupt / foreign / wrong-kind / malformed policy (no half-evaluate)", function () {
    const A = seal(BASE);
    const diff = evidence.diffEvidence({ packetA: A, packetB: seal({ ...BASE, "x.txt": "x" }) });

    // FOREIGN kind.
    expect(() =>
      evidence.evaluateDriftPolicy({ diff, policy: { kind: "not-a-drift-policy", schemaVersion: 1 } })
    ).to.throw(PacketSealError, /not a verifyhash evidence drift policy/);
    // Unsupported schemaVersion.
    expect(() =>
      evidence.evaluateDriftPolicy({ diff, policy: driftPolicy({ schemaVersion: 99 }) })
    ).to.throw(PacketSealError, /schemaVersion/);
    // A truthy-but-non-boolean rule is rejected (never silently enabled).
    expect(() =>
      evidence.evaluateDriftPolicy({ diff, policy: driftPolicy({ noAdded: "yes" }) })
    ).to.throw(PacketSealError, /must be a boolean/);
    // A non-array path list is rejected.
    expect(() =>
      evidence.evaluateDriftPolicy({ diff, policy: driftPolicy({ frozenPaths: "legal" }) })
    ).to.throw(PacketSealError, /must be an array/);
    // An empty-string list entry is rejected.
    expect(() =>
      evidence.evaluateDriftPolicy({ diff, policy: driftPolicy({ allowChangePaths: [""] }) })
    ).to.throw(PacketSealError, /non-empty string/);
    // Bad args object.
    expect(() => evidence.evaluateDriftPolicy(null)).to.throw(
      PacketSealError,
      /requires \{ diff, policy \}/
    );
    expect(() => evidence.evaluateDriftPolicy({ policy: driftPolicy({}) })).to.throw(
      PacketSealError,
      /requires a diff/
    );
  });
});

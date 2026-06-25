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

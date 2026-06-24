"use strict";

// TrustLedger — seal.js tests (EPIC-26, T-26.1).
//
// PURE / OFFLINE — no live node, no filesystem, no key persistence. Every signing key is an
// EPHEMERAL, in-process `Wallet.createRandom()` (TEST-ONLY, never persisted/real). Proves the
// reconciliation seal:
//   * buildSeal over a known input+output set; verifySeal ACCEPTS the unmodified set;
//   * flipping ONE byte of ONE OUTPUT file → REJECT, naming exactly that file as CHANGED;
//   * dropping a file → MISSING; adding one → UNEXPECTED; an INPUT byte-flip is localized too;
//   * validateSeal REJECTS a wrong schemaVersion / malformed hash / bad (edited) root, and a
//     missing / duplicate input role;
//   * the seal's `root` RE-DERIVES from its listed entries via the SAME cli/core/manifest.js
//     convention (proving REUSE, not a re-implementation);
//   * a seal WRAPPED in a signed attestation round-trips through recoverSigner /
//     verifySignedAttestation with an ephemeral key (wrong-key + tampered-payload → REJECTED).

const { expect } = require("chai");
const { Wallet } = require("ethers");

const seal = require("../trustledger/seal");
const coreManifest = require("../cli/core/manifest");
const { hashEntries, buildTree, pathLeaf } = require("../cli/hash");

const {
  SEAL_KIND,
  SEAL_SCHEMA_VERSION,
  SEAL_TRUST_NOTE,
  INPUT_ROLES,
  SealError,
  buildSeal,
  validateSeal,
  readSeal,
  serializeSeal,
  verifySeal,
  signSealWith,
  recoverSigner,
  verifySignedSeal,
  validateSignedSeal,
} = seal;

// A small helper: bytes from a UTF-8 string.
function b(s) {
  return Buffer.from(s, "utf8");
}

// A representative reconcile file set: three SOURCE inputs (one per role) + several emitted
// packet files (HTML, two CSVs). Returns a FRESH object each call so a mutation in one test
// never leaks into another.
function sampleFiles() {
  return {
    inputs: [
      { role: "bank", relPath: "sources/bank-statement.csv", bytes: b("date,amount\n2026-05-31,270000\n") },
      { role: "book", relPath: "sources/ledger.csv", bytes: b("date,amount\n2026-05-31,270000\n") },
      { role: "rentroll", relPath: "sources/rentroll.csv", bytes: b("tenant,balance\nA,150000\nB,120000\n") },
    ],
    outputs: [
      { role: undefined, relPath: "reconciliation-2026-05-31.html", bytes: b("<html>PASS — ties out</html>") },
      { role: undefined, relPath: "reconciliation-2026-05-31-exceptions.csv", bytes: b("severity,message\n") },
      { role: undefined, relPath: "reconciliation-2026-05-31-balances.csv", bytes: b("leg,cents\nbank,270000\nbook,270000\n") },
    ],
  };
}

const VERDICT = { pass: true, reportDate: "2026-05-31", period: "2026-05" };

describe("trustledger/seal — build + strict validation", () => {
  it("builds a seal that records role/relPath/contentHash per file + a single top-level root", () => {
    const s = buildSeal({ files: sampleFiles(), verdict: VERDICT });
    expect(s.kind).to.equal(SEAL_KIND);
    expect(s.schemaVersion).to.equal(SEAL_SCHEMA_VERSION);
    expect(s.note).to.equal(SEAL_TRUST_NOTE);
    expect(s.root).to.match(/^0x[0-9a-f]{64}$/);
    expect(s.fileCount).to.equal(6);

    // Recorded facts (it NAMES what it sealed) — NOT proofs.
    expect(s.verdict).to.deep.equal({ pass: true, reportDate: "2026-05-31", period: "2026-05" });

    // Inputs are partitioned by logical role, in the fixed INPUT_ROLES order.
    expect(s.inputs.map((i) => i.role)).to.deep.equal(["bank", "book", "rentroll"]);
    for (const e of [...s.inputs, ...s.outputs]) {
      expect(e.relPath).to.be.a("string").with.length.greaterThan(0);
      expect(e.contentHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(e.leaf).to.match(/^0x[0-9a-f]{64}$/);
    }
  });

  it("round-trips through serializeSeal -> readSeal byte-deterministically", () => {
    const s = buildSeal({ files: sampleFiles(), verdict: VERDICT });
    const bytes1 = serializeSeal(s);
    const bytes2 = serializeSeal(buildSeal({ files: sampleFiles(), verdict: VERDICT }));
    expect(bytes1).to.equal(bytes2); // deterministic regardless of build
    expect(bytes1.endsWith("\n")).to.equal(true);
    const back = readSeal(bytes1);
    expect(back).to.deep.equal(s);
  });

  it("REUSE PROOF: the seal root re-derives from its committed leaves (files + verdict/role header) via the SAME manifest convention", () => {
    const files = sampleFiles();
    const s = buildSeal({ files, verdict: VERDICT });

    // The seal's committed set is files + the synthetic verdict/role header. committedLeaves() returns
    // that full ordered { relPath, contentHash } list. Independently rebuild the root with
    // cli/core/manifest.js (buildItemManifest) + cli/hash.js (hashEntries) — the SAME path-bound
    // pathLeaf/buildTree the manifest core/contract use, NOT seal.js's own code. If seal.js had its
    // own hashing this would diverge.
    const committed = seal.committedLeaves(s);
    // Reconstruct each committed leaf's "content" is not available here (the header content is
    // internal), so we feed the manifest core the (relPath, contentHash) leaves directly through the
    // pathLeaf/buildTree convention — exactly what hashEntries does internally over content. We prove
    // reuse two ways:

    //   (a) buildTree over pathLeaf(relPath, contentHash) for the WHOLE committed set == seal.root.
    const leaves = committed.map((e) => pathLeaf(e.relPath, e.contentHash));
    expect(buildTree(leaves).root).to.equal(s.root);

    //   (b) the FILE subset, hashed from bytes via hashEntries + buildItemManifest (the real reuse
    //       path), reproduces each file's contentHash/leaf the seal stored — proving seal.js delegates
    //       file hashing to the core verbatim (it just additionally commits the header leaf).
    const fileEntries = [...files.inputs, ...files.outputs].map((e) => ({ path: e.relPath, content: e.bytes }));
    const built = hashEntries(fileEntries);
    const manifest = coreManifest.buildItemManifest(built, {
      kind: "x.test-manifest",
      schemaVersion: 1,
      supportedSchemaVersions: [1],
      note: coreManifest.TRUST_NOTE,
      label: "test manifest",
    });
    const coreByRel = new Map(manifest.files.map((f) => [f.relPath, f]));
    for (const e of [...s.inputs, ...s.outputs]) {
      expect(e.contentHash).to.equal(coreByRel.get(e.relPath).contentHash);
      expect(e.leaf).to.equal(coreByRel.get(e.relPath).leaf);
    }
    // The header leaf is the ONLY committed leaf NOT among the file leaves — that is exactly what binds
    // the verdict/roles into the root.
    expect(committed.length).to.equal(s.inputs.length + s.outputs.length + 1);
    expect(committed[committed.length - 1].relPath).to.equal(seal.SEAL_HEADER_RELPATH);
  });

  it("self-validates: buildSeal emits something validateSeal/readSeal accept", () => {
    const s = buildSeal({ files: sampleFiles(), verdict: VERDICT });
    expect(() => validateSeal(s)).to.not.throw();
    expect(readSeal(JSON.parse(serializeSeal(s)))).to.deep.equal(s);
  });
});

describe("trustledger/seal — validateSeal rejections (never half-accepts)", () => {
  function fresh() {
    return JSON.parse(serializeSeal(buildSeal({ files: sampleFiles(), verdict: VERDICT })));
  }

  it("rejects a wrong schemaVersion", () => {
    const s = fresh();
    s.schemaVersion = 999;
    expect(() => validateSeal(s)).to.throw(SealError, /unsupported seal schemaVersion/);
  });

  it("rejects a wrong kind", () => {
    const s = fresh();
    s.kind = "something.else";
    expect(() => validateSeal(s)).to.throw(SealError, /not a trustledger reconciliation seal/);
  });

  it("rejects a malformed hex contentHash", () => {
    const s = fresh();
    s.outputs[0].contentHash = "0xnothex";
    expect(() => validateSeal(s)).to.throw(SealError, /must be a 0x-prefixed 32-byte hex string/);
  });

  it("rejects a leaf inconsistent with its relPath+contentHash", () => {
    const s = fresh();
    // Flip the contentHash but leave the leaf: leaf no longer re-derives from (relPath, contentHash).
    s.inputs[0].contentHash = "0x" + "a".repeat(64);
    expect(() => validateSeal(s)).to.throw(SealError, /leaf is inconsistent with its relPath\+contentHash/);
  });

  it("rejects a top-level root that does not re-derive from the listed entries", () => {
    const s = fresh();
    s.root = "0x" + "b".repeat(64);
    expect(() => validateSeal(s)).to.throw(SealError, /root does not re-derive from its listed entries/);
  });

  it("rejects a missing input role (zero inputs)", () => {
    const s = fresh();
    s.inputs = [];
    expect(() => validateSeal(s)).to.throw(SealError, /`inputs` must be a non-empty array/);
  });

  it("rejects a duplicate input role", () => {
    const files = sampleFiles();
    files.inputs.push({ role: "bank", relPath: "sources/bank-2.csv", bytes: b("dup") });
    expect(() => buildSeal({ files, verdict: VERDICT })).to.throw(SealError, /duplicate input role/);
  });

  it("rejects an unknown input role", () => {
    const files = sampleFiles();
    files.inputs[0].role = "escrow";
    expect(() => buildSeal({ files, verdict: VERDICT })).to.throw(SealError, /input role must be one of/);
  });

  it("rejects a duplicate relPath across the file set", () => {
    const files = sampleFiles();
    files.outputs[1].relPath = files.outputs[0].relPath; // collide two outputs
    expect(() => buildSeal({ files, verdict: VERDICT })).to.throw(SealError, /duplicate relPath/);
  });

  it("rejects a tampered verdict shape (bad reportDate)", () => {
    const s = fresh();
    s.verdict.reportDate = "May 31";
    expect(() => validateSeal(s)).to.throw(SealError, /reportDate must be a "YYYY-MM-DD" string/);
  });

  // REWORK lock-in (Finding 1): the verdict is BOUND into the root, so flipping pass true->false
  // (or editing reportDate/period) on the BARE seal makes the root stop re-deriving — validateSeal
  // REJECTS it. An out-of-trust FAIL can no longer be edited to PASS undetected in the unsigned seal.
  it("rejects an edited verdict.pass (true->false) — the verdict is bound into the root", () => {
    const s = fresh();
    expect(s.verdict.pass).to.equal(true);
    s.verdict.pass = false; // flip the headline verdict, leave the root untouched
    expect(() => validateSeal(s)).to.throw(
      SealError,
      /root does not re-derive from its listed entries \+ verdict\/role header/
    );
  });

  it("rejects an edited verdict.reportDate — the date is bound into the root", () => {
    const s = fresh();
    s.verdict.reportDate = "2026-04-30"; // a valid-SHAPE but DIFFERENT date than was sealed
    expect(() => validateSeal(s)).to.throw(
      SealError,
      /root does not re-derive from its listed entries \+ verdict\/role header/
    );
  });

  it("rejects an edited verdict.period — period is bound into the root", () => {
    const s = fresh();
    s.verdict.period = "1999-12";
    expect(() => validateSeal(s)).to.throw(
      SealError,
      /root does not re-derive from its listed entries \+ verdict\/role header/
    );
  });

  // REWORK lock-in (Finding 2): the input ROLE is bound into the root. Swapping the bank<->book role
  // labels in the seal (same relPaths/bytes) makes the root stop re-deriving — validateSeal REJECTS.
  it("rejects a swapped input role (bank<->book) — the role partition is bound into the root", () => {
    const s = fresh();
    const bank = s.inputs.find((i) => i.role === "bank");
    const book = s.inputs.find((i) => i.role === "book");
    bank.role = "book";
    book.role = "bank"; // swap labels; relPath/contentHash/leaf untouched
    expect(() => validateSeal(s)).to.throw(
      SealError,
      /root does not re-derive from its listed entries \+ verdict\/role header/
    );
  });

  it("a seal with an edited verdict NO LONGER verifies against the original files", () => {
    // Build over real files, then edit the verdict in the seal object: verifySeal recomputes the
    // root over (files + the seal's now-edited verdict header) and the SEALED root no longer matches.
    const files = sampleFiles();
    const built = buildSeal({ files, verdict: VERDICT });
    const tamperedSeal = JSON.parse(serializeSeal(built));
    tamperedSeal.verdict.pass = false;
    // validateSeal (called inside verifySeal) already rejects it — the seal is internally inconsistent.
    expect(() => verifySeal(tamperedSeal, sampleFiles())).to.throw(
      SealError,
      /root does not re-derive/
    );
  });
});

describe("trustledger/seal — verifySeal localizes tamper to a single file", () => {
  it("ACCEPTS the unmodified set", () => {
    const files = sampleFiles();
    const s = buildSeal({ files, verdict: VERDICT });
    const res = verifySeal(s, sampleFiles());
    expect(res.verdict).to.equal("ACCEPTED");
    expect(res.accepted).to.equal(true);
    expect(res.rootMatches).to.equal(true);
    expect(res.recomputedRoot).to.equal(s.root);
    expect(res.counts).to.deep.equal({ matched: 6, changed: 0, missing: 0, unexpected: 0, roleMismatched: 0 });
  });

  it("REJECTS and names exactly the OUTPUT file whose byte was flipped (CHANGED)", () => {
    const s = buildSeal({ files: sampleFiles(), verdict: VERDICT });
    const tampered = sampleFiles();
    // Flip one byte of one OUTPUT file.
    tampered.outputs[0].bytes = b("<html>FAIL — altered</html>");
    const res = verifySeal(s, tampered);

    expect(res.verdict).to.equal("REJECTED");
    expect(res.rootMatches).to.equal(false);
    expect(res.counts).to.deep.equal({ matched: 5, changed: 1, missing: 0, unexpected: 0, roleMismatched: 0 });
    expect(res.changed).to.have.length(1);
    expect(res.changed[0].relPath).to.equal("reconciliation-2026-05-31.html");
    expect(res.changed[0].role).to.equal(null); // an output
    expect(res.changed[0].expectedContentHash).to.not.equal(res.changed[0].actualContentHash);
    // Nothing ELSE is flagged — the tamper is localized.
    expect(res.matched.map((m) => m.relPath)).to.not.include("reconciliation-2026-05-31.html");
  });

  it("REJECTS and names the INPUT role whose byte was flipped (CHANGED, role=bank)", () => {
    const s = buildSeal({ files: sampleFiles(), verdict: VERDICT });
    const tampered = sampleFiles();
    tampered.inputs[0].bytes = b("date,amount\n2026-05-31,999999\n"); // bank input altered
    const res = verifySeal(s, tampered);
    expect(res.verdict).to.equal("REJECTED");
    expect(res.changed).to.have.length(1);
    expect(res.changed[0].relPath).to.equal("sources/bank-statement.csv");
    expect(res.changed[0].role).to.equal("bank");
  });

  it("REJECTS a dropped file as MISSING (named exactly)", () => {
    const s = buildSeal({ files: sampleFiles(), verdict: VERDICT });
    const dropped = sampleFiles();
    dropped.outputs.pop(); // drop the balances CSV
    const res = verifySeal(s, dropped);
    expect(res.verdict).to.equal("REJECTED");
    expect(res.counts.missing).to.equal(1);
    expect(res.missing.map((m) => m.relPath)).to.deep.equal([
      "reconciliation-2026-05-31-balances.csv",
    ]);
    expect(res.changed).to.have.length(0);
  });

  // REWORK lock-in (Finding 2): supplying the SAME relPaths+bytes but swapping the bank<->book role
  // LABELS must be caught — the role bindings are committed into the root, so verifySeal both flips
  // rootMatches to false AND localizes which paths' roles mismatched. Previously this was ACCEPTED.
  it("REJECTS a role swap (bank<->book) and localizes the mismatched roles", () => {
    const s = buildSeal({ files: sampleFiles(), verdict: VERDICT });
    const swapped = sampleFiles();
    // Same files (relPath + bytes), but the role labels on bank and book are swapped.
    const bank = swapped.inputs.find((i) => i.role === "bank");
    const book = swapped.inputs.find((i) => i.role === "book");
    bank.role = "book";
    book.role = "bank";

    const res = verifySeal(s, swapped);
    expect(res.verdict).to.equal("REJECTED");
    expect(res.rootMatches).to.equal(false); // the role binding changed the recomputed root
    // The file BYTES are unchanged, so nothing is CHANGED/MISSING/UNEXPECTED — the defect is the role.
    expect(res.counts.changed).to.equal(0);
    expect(res.counts.missing).to.equal(0);
    expect(res.counts.unexpected).to.equal(0);
    expect(res.counts.roleMismatched).to.equal(2);
    const mism = res.roleMismatches.reduce((m, r) => ((m[r.relPath] = r), m), {});
    expect(mism["sources/bank-statement.csv"]).to.include({ sealedRole: "bank", suppliedRole: "book" });
    expect(mism["sources/ledger.csv"]).to.include({ sealedRole: "book", suppliedRole: "bank" });
  });

  it("REJECTS an added file as UNEXPECTED (named exactly)", () => {
    const s = buildSeal({ files: sampleFiles(), verdict: VERDICT });
    const added = sampleFiles();
    added.outputs.push({ role: undefined, relPath: "reconciliation-2026-05-31-notes.txt", bytes: b("extra") });
    const res = verifySeal(s, added);
    expect(res.verdict).to.equal("REJECTED");
    expect(res.counts.unexpected).to.equal(1);
    expect(res.unexpected.map((m) => m.relPath)).to.deep.equal([
      "reconciliation-2026-05-31-notes.txt",
    ]);
    expect(res.changed).to.have.length(0);
    expect(res.missing).to.have.length(0);
  });
});

describe("trustledger/seal — optional signed-attestation wrap (ephemeral key)", () => {
  it("wraps a seal in a signed attestation that round-trips through recoverSigner / verifySignedSeal", async () => {
    const s = buildSeal({ files: sampleFiles(), verdict: VERDICT });
    const wallet = Wallet.createRandom(); // EPHEMERAL, in-memory, TEST-ONLY — never persisted.

    const container = await signSealWith(s, wallet);
    // Structurally valid signed container that WRAPS (does not edit) the seal.
    expect(() => validateSignedSeal(container)).to.not.throw();
    // The embedded payload is the EXACT canonical seal bytes.
    expect(container.attestation).to.equal(serializeSeal(s));

    // recoverSigner recovers the ephemeral signer over exactly those bytes.
    expect(recoverSigner(container)).to.equal((await wallet.getAddress()).toLowerCase());

    // verifySignedSeal ACCEPTS, pinned to the expected signer AND bound to the recomputed seal bytes.
    const res = verifySignedSeal({
      container,
      expectedSigner: await wallet.getAddress(),
      expectedCanonical: serializeSeal(s),
    });
    expect(res.verdict).to.equal("ACCEPTED");
    expect(res.accepted).to.equal(true);
    expect(res.checks.signatureMatchesSigner).to.equal(true);
    expect(res.checks.signerMatchesExpected).to.equal(true);
    expect(res.checks.manifestBindsAttestation).to.equal(true);
  });

  it("REJECTS the signed container when pinned to a DIFFERENT signer", async () => {
    const s = buildSeal({ files: sampleFiles(), verdict: VERDICT });
    const wallet = Wallet.createRandom();
    const other = Wallet.createRandom(); // a different ephemeral key
    const container = await signSealWith(s, wallet);

    const res = verifySignedSeal({ container, expectedSigner: await other.getAddress() });
    expect(res.verdict).to.equal("REJECTED");
    expect(res.checks.signatureMatchesSigner).to.equal(true); // signature still matches its own signer
    expect(res.checks.signerMatchesExpected).to.equal(false); // but not the pinned one
  });

  it("REJECTS when the caller binds DIFFERENT seal bytes than were signed", async () => {
    const s = buildSeal({ files: sampleFiles(), verdict: VERDICT });
    const wallet = Wallet.createRandom();
    const container = await signSealWith(s, wallet);

    // A seal over a DIFFERENT file set produces different canonical bytes -> binding fails.
    const otherFiles = sampleFiles();
    otherFiles.outputs[0].bytes = b("<html>different</html>");
    const other = buildSeal({ files: otherFiles, verdict: VERDICT });

    const res = verifySignedSeal({ container, expectedCanonical: serializeSeal(other) });
    expect(res.verdict).to.equal("REJECTED");
    expect(res.checks.manifestBindsAttestation).to.equal(false);
  });
});

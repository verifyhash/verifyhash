"use strict";

// cli/core/packetseal.js tests (T-30.2) — the GENERIC, product-agnostic tamper-evident packet-seal core.
//
// PURE / OFFLINE — no live node, no filesystem, no key persistence. Every signing key is an EPHEMERAL,
// in-process `Wallet.createRandom()` (TEST-ONLY, never persisted/real). These tests exercise the core
// with a SYNTHETIC product (a DIFFERENT `kind` than TrustLedger), proving the core is product-agnostic:
//   * a HEADERLESS product (a plain file set, no header) builds + verifies, and localizes a
//     CHANGED / MISSING / UNEXPECTED file to the EXACT entry;
//   * a HEADER product (a synthetic, opaque { relPath, content } header bound into the same root)
//     builds + verifies, and a HEADER edit makes the root stop re-deriving;
//   * the root RE-DERIVES from the committed leaves via the SAME cli/core/manifest.js + cli/hash.js
//     convention (proving REUSE, not a re-implementation);
//   * the optional signed-attestation wrap round-trips through the shared attestation core with an
//     ephemeral key (wrong-key + tampered-payload → REJECTED).

const { expect } = require("chai");
const crypto = require("crypto");
const { Wallet } = require("ethers");

const packetseal = require("../cli/core/packetseal");
const coreManifest = require("../cli/core/manifest");
const coreAttestation = require("../cli/core/attestation");
const { hashEntries, buildTree, pathLeaf } = require("../cli/hash");

const {
  PacketSealError,
  buildSeal,
  validateSeal,
  verifySeal,
  committedLeaves,
} = packetseal;

function b(s) {
  return Buffer.from(s, "utf8");
}

// ---- A SYNTHETIC, product-agnostic seal product (NOT TrustLedger). --------------------------------
// Its `kind` is disjoint from the reconcile seal, proving the core carries no product vocabulary.

const SYNTH_NOTE =
  "Synthetic packet seal: the Merkle root commits to the full set of (relPath, content) pairs; any " +
  "edit/rename/add/remove changes the root. UNTRUSTED transport container — verify RE-DERIVES the root.";

// (a) A HEADERLESS product — a plain bag of files, no header.
const PLAIN_CFG = Object.freeze({
  kind: "synthetic.packet-seal",
  schemaVersion: 1,
  supportedSchemaVersions: [1],
  note: SYNTH_NOTE,
  label: "synthetic packet seal",
});

// (b) A HEADER product — binds an opaque { batchId, status } fact into the SAME root via a reserved
//     header leaf. headerContentFor re-derives the header content from the seal's OWN recorded `meta`.
const SYNTH_HEADER_RELPATH = "__synthetic.header__v1";
function synthHeaderBytes(meta) {
  // Deterministic canonical bytes — the product's choice. The core treats them as opaque.
  return b(JSON.stringify({ v: 1, batchId: meta.batchId, status: meta.status }));
}
const HEADER_CFG = Object.freeze({
  kind: "synthetic.packet-seal-hdr",
  schemaVersion: 1,
  supportedSchemaVersions: [1],
  note: SYNTH_NOTE,
  label: "synthetic header seal",
  headerRelPath: SYNTH_HEADER_RELPATH,
  headerContentFor: (seal) => synthHeaderBytes(seal.meta),
});

function plainFiles() {
  return {
    entries: [
      { relPath: "data/a.txt", bytes: b("alpha\n") },
      { relPath: "data/b.txt", bytes: b("bravo\n") },
      { relPath: "report.html", bytes: b("<html>ok</html>") },
    ],
  };
}

const META = { batchId: "batch-2026-06", status: "sealed" };

// ===================================================================================================
describe("cli/core/packetseal — headerless synthetic product: build + verify + localize", () => {
  it("builds a seal over a plain file set (no header) that self-validates", () => {
    const s = buildSeal({ files: plainFiles() }, PLAIN_CFG);
    expect(s.kind).to.equal("synthetic.packet-seal");
    expect(s.schemaVersion).to.equal(1);
    expect(s.note).to.equal(SYNTH_NOTE);
    expect(s.root).to.match(/^0x[0-9a-f]{64}$/);
    expect(s.fileCount).to.equal(3);
    expect(s.header).to.equal(undefined); // headerless
    // files emitted sorted by relPath, deterministic regardless of caller order.
    expect(s.files.map((f) => f.relPath)).to.deep.equal(["data/a.txt", "data/b.txt", "report.html"]);
    for (const f of s.files) {
      expect(f.contentHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(f.leaf).to.match(/^0x[0-9a-f]{64}$/);
    }
    expect(() => validateSeal(s, PLAIN_CFG)).to.not.throw();
  });

  it("is build-deterministic regardless of caller array order", () => {
    const s1 = buildSeal({ files: plainFiles() }, PLAIN_CFG);
    const shuffled = { entries: plainFiles().entries.slice().reverse() };
    const s2 = buildSeal({ files: shuffled }, PLAIN_CFG);
    expect(s2.root).to.equal(s1.root);
    expect(JSON.stringify(s2)).to.equal(JSON.stringify(s1));
  });

  it("REUSE PROOF: the root re-derives from its committed leaves via the SAME manifest/hash convention", () => {
    const files = plainFiles();
    const s = buildSeal({ files }, PLAIN_CFG);
    // committedLeaves returns the { relPath, contentHash } the root commits to (just the files here).
    const committed = committedLeaves(s, PLAIN_CFG);
    expect(committed.length).to.equal(3);
    // (a) buildTree over pathLeaf(relPath, contentHash) for the whole committed set == seal.root.
    const leaves = committed.map((e) => pathLeaf(e.relPath, e.contentHash));
    expect(buildTree(leaves).root).to.equal(s.root);
    // (b) re-hash the files from bytes via the REAL reuse path (hashEntries + buildItemManifest) and
    //     confirm every contentHash/leaf the seal stored matches — proving delegation, not re-impl.
    const built = hashEntries(files.entries.map((e) => ({ path: e.relPath, content: e.bytes })));
    const manifest = coreManifest.buildItemManifest(built, {
      kind: "x.test-manifest",
      schemaVersion: 1,
      supportedSchemaVersions: [1],
      note: coreManifest.TRUST_NOTE,
      label: "test manifest",
    });
    const byRel = new Map(manifest.files.map((f) => [f.relPath, f]));
    for (const f of s.files) {
      expect(f.contentHash).to.equal(byRel.get(f.relPath).contentHash);
      expect(f.leaf).to.equal(byRel.get(f.relPath).leaf);
    }
  });

  it("ACCEPTS the unmodified set", () => {
    const s = buildSeal({ files: plainFiles() }, PLAIN_CFG);
    const res = verifySeal(s, plainFiles(), PLAIN_CFG);
    expect(res.verdict).to.equal("ACCEPTED");
    expect(res.accepted).to.equal(true);
    expect(res.rootMatches).to.equal(true);
    expect(res.recomputedRoot).to.equal(s.root);
    expect(res.counts).to.deep.equal({ matched: 3, changed: 0, missing: 0, unexpected: 0 });
  });

  it("REJECTS and names exactly the CHANGED file (byte flipped)", () => {
    const s = buildSeal({ files: plainFiles() }, PLAIN_CFG);
    const tampered = plainFiles();
    tampered.entries[2].bytes = b("<html>ALTERED</html>");
    const res = verifySeal(s, tampered, PLAIN_CFG);
    expect(res.verdict).to.equal("REJECTED");
    expect(res.rootMatches).to.equal(false);
    expect(res.counts).to.deep.equal({ matched: 2, changed: 1, missing: 0, unexpected: 0 });
    expect(res.changed.map((c) => c.relPath)).to.deep.equal(["report.html"]);
    expect(res.changed[0].expectedContentHash).to.not.equal(res.changed[0].actualContentHash);
    expect(res.matched.map((m) => m.relPath)).to.not.include("report.html");
  });

  it("REJECTS a dropped file as MISSING (named exactly)", () => {
    const s = buildSeal({ files: plainFiles() }, PLAIN_CFG);
    const dropped = plainFiles();
    dropped.entries.pop(); // remove report.html
    const res = verifySeal(s, dropped, PLAIN_CFG);
    expect(res.verdict).to.equal("REJECTED");
    expect(res.counts.missing).to.equal(1);
    expect(res.missing.map((m) => m.relPath)).to.deep.equal(["report.html"]);
    expect(res.changed).to.have.length(0);
  });

  it("REJECTS an added file as UNEXPECTED (named exactly)", () => {
    const s = buildSeal({ files: plainFiles() }, PLAIN_CFG);
    const added = plainFiles();
    added.entries.push({ relPath: "data/c.txt", bytes: b("charlie\n") });
    const res = verifySeal(s, added, PLAIN_CFG);
    expect(res.verdict).to.equal("REJECTED");
    expect(res.counts.unexpected).to.equal(1);
    expect(res.unexpected.map((u) => u.relPath)).to.deep.equal(["data/c.txt"]);
    expect(res.missing).to.have.length(0);
    expect(res.changed).to.have.length(0);
  });

  it("REJECTS the WHOLE seal when an ADDED + MISSING + CHANGED all happen together (each localized)", () => {
    const s = buildSeal({ files: plainFiles() }, PLAIN_CFG);
    const mangled = { entries: [
      { relPath: "data/a.txt", bytes: b("alpha\n") }, // MATCH
      { relPath: "data/b.txt", bytes: b("MUTATED\n") }, // CHANGED
      // report.html dropped -> MISSING
      { relPath: "data/new.txt", bytes: b("added\n") }, // UNEXPECTED
    ] };
    const res = verifySeal(s, mangled, PLAIN_CFG);
    expect(res.verdict).to.equal("REJECTED");
    expect(res.counts).to.deep.equal({ matched: 1, changed: 1, missing: 1, unexpected: 1 });
    expect(res.changed.map((c) => c.relPath)).to.deep.equal(["data/b.txt"]);
    expect(res.missing.map((m) => m.relPath)).to.deep.equal(["report.html"]);
    expect(res.unexpected.map((u) => u.relPath)).to.deep.equal(["data/new.txt"]);
  });
});

// ===================================================================================================
describe("cli/core/packetseal — synthetic HEADER product: binds an opaque fact into the same root", () => {
  function buildHdr(metaOverride) {
    const meta = metaOverride || META;
    const s = buildSeal(
      { files: plainFiles(), header: { relPath: SYNTH_HEADER_RELPATH, content: synthHeaderBytes(meta) } },
      HEADER_CFG
    );
    // The product records its OWN fact on the seal so headerContentFor can re-derive the header content.
    s.meta = { batchId: meta.batchId, status: meta.status };
    return s;
  }

  it("builds a seal whose root commits to the files PLUS the opaque header leaf", () => {
    const s = buildHdr();
    expect(s.kind).to.equal("synthetic.packet-seal-hdr");
    expect(s.header).to.deep.equal({ relPath: SYNTH_HEADER_RELPATH });
    expect(s.fileCount).to.equal(3); // fileCount counts the REAL files, not the header
    expect(() => validateSeal(s, HEADER_CFG)).to.not.throw();

    // committedLeaves includes the header leaf as the FINAL committed leaf.
    const committed = committedLeaves(s, HEADER_CFG);
    expect(committed.length).to.equal(4);
    expect(committed[committed.length - 1].relPath).to.equal(SYNTH_HEADER_RELPATH);
    const leaves = committed.map((e) => pathLeaf(e.relPath, e.contentHash));
    expect(buildTree(leaves).root).to.equal(s.root);
  });

  it("a header product with a DIFFERENT bound fact has a DIFFERENT root (the header is committed)", () => {
    const a = buildHdr({ batchId: "batch-2026-06", status: "sealed" });
    const b2 = buildHdr({ batchId: "batch-2026-06", status: "VOIDED" }); // same files, different header fact
    expect(b2.root).to.not.equal(a.root);
  });

  it("ACCEPTS when the supplied files + re-derived header content match", () => {
    const s = buildHdr();
    const res = verifySeal(
      s,
      plainFiles(),
      HEADER_CFG,
      { headerContent: synthHeaderBytes(s.meta) }
    );
    expect(res.verdict).to.equal("ACCEPTED");
    expect(res.rootMatches).to.equal(true);
    expect(res.recomputedRoot).to.equal(s.root);
  });

  it("DETECTS a header edit: validateSeal REJECTS when a bound fact is edited but the root left untouched", () => {
    const s = buildHdr();
    s.meta.status = "VOIDED"; // edit the bound fact, leave root/files alone
    expect(() => validateSeal(s, HEADER_CFG)).to.throw(
      PacketSealError,
      /root does not re-derive from its listed entries \+ header/
    );
  });

  it("DETECTS a header edit on the SUPPLIED side: verifySeal flips rootMatches when the supplied header differs", () => {
    const s = buildHdr();
    // Supply the SAME files, but a DIFFERENT header content than was sealed.
    const res = verifySeal(
      s,
      plainFiles(),
      HEADER_CFG,
      { headerContent: synthHeaderBytes({ batchId: s.meta.batchId, status: "TAMPERED" }) }
    );
    expect(res.verdict).to.equal("REJECTED");
    expect(res.rootMatches).to.equal(false);
    // every FILE still matches — the defect is purely the header binding.
    expect(res.counts).to.deep.equal({ matched: 3, changed: 0, missing: 0, unexpected: 0 });
  });

  it("REQUIRES headerContent on verify for a header product (a header product binds it into the root)", () => {
    const s = buildHdr();
    expect(() => verifySeal(s, plainFiles(), HEADER_CFG)).to.throw(
      PacketSealError,
      /requires `headerContent`/
    );
  });
});

// ===================================================================================================
describe("cli/core/packetseal — strict rejections (never half-accepts)", () => {
  function fresh() {
    return JSON.parse(JSON.stringify(buildSeal({ files: plainFiles() }, PLAIN_CFG)));
  }

  it("rejects a reserved-slot file in a header product", () => {
    expect(() =>
      buildSeal(
        {
          files: { entries: [{ relPath: SYNTH_HEADER_RELPATH, bytes: b("x") }] },
          header: { relPath: SYNTH_HEADER_RELPATH, content: synthHeaderBytes(META) },
        },
        HEADER_CFG
      )
    ).to.throw(PacketSealError, /is reserved for the seal header/);
  });

  it("rejects a header arg for a headerless product", () => {
    expect(() =>
      buildSeal(
        { files: plainFiles(), header: { relPath: "x", content: b("x") } },
        PLAIN_CFG
      )
    ).to.throw(PacketSealError, /config declares none/);
  });

  it("rejects a wrong kind / schemaVersion / drifted note / bad root", () => {
    let s = fresh();
    s.kind = "nope";
    expect(() => validateSeal(s, PLAIN_CFG)).to.throw(PacketSealError, /not a synthetic packet seal/);
    s = fresh();
    s.schemaVersion = 999;
    expect(() => validateSeal(s, PLAIN_CFG)).to.throw(PacketSealError, /unsupported .* schemaVersion/);
    s = fresh();
    s.note = "drifted";
    expect(() => validateSeal(s, PLAIN_CFG)).to.throw(PacketSealError, /must be the standing trust note/);
    s = fresh();
    s.root = "0x" + "b".repeat(64);
    expect(() => validateSeal(s, PLAIN_CFG)).to.throw(PacketSealError, /root does not re-derive/);
  });

  it("rejects a leaf inconsistent with its relPath+contentHash", () => {
    const s = fresh();
    s.files[0].contentHash = "0x" + "a".repeat(64);
    expect(() => validateSeal(s, PLAIN_CFG)).to.throw(
      PacketSealError,
      /leaf is inconsistent with its relPath\+contentHash/
    );
  });

  it("rejects a duplicate relPath across the file set at build", () => {
    const files = plainFiles();
    files.entries[1].relPath = files.entries[0].relPath;
    expect(() => buildSeal({ files }, PLAIN_CFG)).to.throw(PacketSealError, /duplicate relPath/);
  });

  it("rejects an incomplete config (header all-or-nothing)", () => {
    const bad = { ...PLAIN_CFG, headerRelPath: "x" }; // headerRelPath without headerContentFor
    expect(() => buildSeal({ files: plainFiles() }, bad)).to.throw(PacketSealError, /header is all-or-nothing/);
  });
});

// ===================================================================================================
describe("cli/core/packetseal — optional signed-attestation wrap (ephemeral key)", () => {
  // The core leaves serialization/signing to the product (each product supplies its own canonical codec),
  // so here we drive the SHARED attestation core directly with a synthetic seal codec — proving a
  // packet-seal can be wrapped + round-tripped through the same signing path with an ephemeral key.

  // A canonical serializer for the synthetic seal (FIXED key order, trailing newline).
  function serializeSynthSeal(seal) {
    validateSeal(seal, PLAIN_CFG);
    const canonical = {
      kind: seal.kind,
      schemaVersion: seal.schemaVersion,
      note: seal.note,
      root: seal.root,
      fileCount: seal.fileCount,
      files: seal.files.map((f) => ({ relPath: f.relPath, contentHash: f.contentHash, leaf: f.leaf })),
    };
    return JSON.stringify(canonical) + "\n";
  }

  const SIGNED_NOTE =
    "Signed synthetic packet seal: WRAPS (never edits) the canonical seal bytes + a detached EIP-191 " +
    "signature. " +
    SYNTH_NOTE;
  const SIGNED_CFG = Object.freeze({
    kind: "synthetic.packet-seal-signed",
    schemaVersion: 1,
    supportedSchemaVersions: [1],
    note: SIGNED_NOTE,
    label: "signed synthetic packet seal",
    validateUnsigned: (o) => validateSeal(o, PLAIN_CFG),
    serializeUnsigned: serializeSynthSeal,
  });

  it("wraps a packet seal in a signed attestation that round-trips with an ephemeral key", async () => {
    const s = buildSeal({ files: plainFiles() }, PLAIN_CFG);
    const wallet = Wallet.createRandom(); // EPHEMERAL, in-memory, TEST-ONLY — never persisted.

    const container = await coreAttestation.signAttestation({ attestation: s, signer: wallet }, SIGNED_CFG);
    expect(() => coreAttestation.validateSignedAttestation(container, SIGNED_CFG)).to.not.throw();
    expect(container.attestation).to.equal(serializeSynthSeal(s));

    expect(coreAttestation.recoverSigner(container)).to.equal((await wallet.getAddress()).toLowerCase());

    const res = coreAttestation.verifySignedAttestation({
      container,
      expectedSigner: await wallet.getAddress(),
      expectedCanonical: serializeSynthSeal(s),
    });
    expect(res.verdict).to.equal("ACCEPTED");
    expect(res.checks.signatureMatchesSigner).to.equal(true);
    expect(res.checks.signerMatchesExpected).to.equal(true);
    expect(res.checks.manifestBindsAttestation).to.equal(true);
  });

  it("REJECTS the signed container when pinned to a DIFFERENT signer", async () => {
    const s = buildSeal({ files: plainFiles() }, PLAIN_CFG);
    const wallet = Wallet.createRandom();
    const other = Wallet.createRandom();
    const container = await coreAttestation.signAttestation({ attestation: s, signer: wallet }, SIGNED_CFG);
    const res = coreAttestation.verifySignedAttestation({ container, expectedSigner: await other.getAddress() });
    expect(res.verdict).to.equal("REJECTED");
    expect(res.checks.signatureMatchesSigner).to.equal(true);
    expect(res.checks.signerMatchesExpected).to.equal(false);
  });

  it("REJECTS when the caller binds DIFFERENT seal bytes than were signed (tampered payload)", async () => {
    const s = buildSeal({ files: plainFiles() }, PLAIN_CFG);
    const wallet = Wallet.createRandom();
    const container = await coreAttestation.signAttestation({ attestation: s, signer: wallet }, SIGNED_CFG);

    const otherFiles = plainFiles();
    otherFiles.entries[0].bytes = b("DIFFERENT\n");
    const other = buildSeal({ files: otherFiles }, PLAIN_CFG);

    const res = coreAttestation.verifySignedAttestation({ container, expectedCanonical: serializeSynthSeal(other) });
    expect(res.verdict).to.equal("REJECTED");
    expect(res.checks.manifestBindsAttestation).to.equal(false);
  });
});

// A stray require so an unused-import lint never trips (crypto is available for ad-hoc byte fixtures).
void crypto;

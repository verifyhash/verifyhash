"use strict";

// Tests for the SIGNED-attestation envelope (T-17.1).
//
// What these prove:
//   * A signed container round-trips: build -> serialize -> read -> equal.
//   * The embedded canonical bytes are byte-IDENTICAL to serializeAttestation over the same manifest
//     (the signed-over bytes are unambiguous).
//   * The strict reader/validator REJECTS each malformed variant (wrong kind/schemaVersion, missing/!hex
//     signature, malformed signer, unknown scheme, an embedded payload that fails validateAttestation,
//     a non-round-tripping container) and NEVER half-accepts.
//   * The wrap-don't-edit invariant: an embedded UNSIGNED envelope that is itself `signed:true` is rejected.
//   * The UNSIGNED guarantee is preserved verbatim — the wrapped payload still validates as
//     signed:false/signature:null.
//   * Side effects land ONLY at the caller's explicit path; every test isolates to a throwaway temp dir
//     and self-cleans, pass or fail.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  runDatasetBuild,
  readManifest,
  buildAttestation,
  serializeAttestation,
  ATTESTATION_KIND,
  SIGNED_ATTESTATION_KIND,
  SIGNED_ATTESTATION_SCHEMA_VERSION,
  SIGNED_ATTESTATION_SCHEMES,
  SIGNED_ATTESTATION_TRUST_NOTE,
  TRUST_NOTE,
  buildSignedAttestation,
  validateSignedAttestation,
  serializeSignedAttestation,
  readSignedAttestation,
} = require("../cli/dataset");

describe("cli: signed dataset attestation (T-17.1)", function () {
  let tmpDirs = [];
  function tmp(prefix) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  }
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  function writeFiles(dir, files) {
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(dir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }

  // Build a manifest, read it, and return { manifest, unsigned }. Purely offline.
  function fixtureUnsigned(files, prefix) {
    const dir = tmp((prefix || "sig") + "-tree-");
    writeFiles(dir, files);
    const manifestPath = path.join(tmp((prefix || "sig") + "-man-"), "manifest.json");
    runDatasetBuild({ dir, out: manifestPath, stdout: () => {} });
    const manifest = readManifest(manifestPath);
    const unsigned = buildAttestation(manifest);
    return { manifest, manifestPath, unsigned };
  }

  // A representative, structurally valid detached signature triple (NOT a real signature; this layer
  // does no crypto recovery — see T-17.2). 65 bytes for eip191-personal-sign.
  const SIGNER = "0x" + "ab".repeat(20);
  const SIG65 = "0x" + "cd".repeat(65);
  const goodSig = () => ({ scheme: "eip191-personal-sign", signer: SIGNER, signature: SIG65 });

  it("round-trips: build -> serialize -> read -> deep-equal", function () {
    const { unsigned } = fixtureUnsigned({ "a.txt": "AAA", "b.txt": "BBB" }, "sig-rt");
    const container = buildSignedAttestation({ attestation: unsigned, ...goodSig() });

    const bytes = serializeSignedAttestation(container);
    expect(bytes.endsWith("\n")).to.equal(true);
    expect(bytes.endsWith("\n\n")).to.equal(false); // exactly one trailing newline
    // No insignificant whitespace at the top level.
    expect(JSON.stringify(JSON.parse(bytes))).to.equal(bytes.slice(0, -1));

    const outPath = path.join(tmp("sig-rt-out-"), "signed.json");
    fs.writeFileSync(outPath, bytes);
    const back = readSignedAttestation(outPath);
    expect(back).to.deep.equal(container);
    expect(serializeSignedAttestation(back)).to.equal(bytes); // canonical round-trip
  });

  it("the embedded bytes are byte-IDENTICAL to serializeAttestation over the same manifest", function () {
    const { manifest, unsigned } = fixtureUnsigned({ "x.txt": "X", "y.txt": "Y" }, "sig-embed");
    const container = buildSignedAttestation({ attestation: unsigned, ...goodSig() });
    const canonicalUnsigned = serializeAttestation(buildAttestation(manifest));
    expect(container.attestation).to.equal(canonicalUnsigned);
  });

  it("the wrapped payload PRESERVES the UNSIGNED guarantee verbatim (signed:false/signature:null)", function () {
    const { unsigned } = fixtureUnsigned({ "a.txt": "AAA" }, "sig-preserve");
    const container = buildSignedAttestation({ attestation: unsigned, ...goodSig() });
    const embedded = JSON.parse(container.attestation);
    expect(embedded.kind).to.equal(ATTESTATION_KIND);
    expect(embedded.signed).to.equal(false);
    expect(embedded.signature).to.equal(null);
  });

  it("the container shape is the versioned signed kind and reuses TRUST_NOTE verbatim", function () {
    const { unsigned } = fixtureUnsigned({ "a.txt": "AAA" }, "sig-shape");
    const container = buildSignedAttestation({ attestation: unsigned, ...goodSig() });
    expect(container.kind).to.equal(SIGNED_ATTESTATION_KIND);
    expect(container.schemaVersion).to.equal(SIGNED_ATTESTATION_SCHEMA_VERSION);
    expect(container.note).to.equal(SIGNED_ATTESTATION_TRUST_NOTE);
    // The standing dataset TRUST_NOTE is REUSED, not reworded.
    expect(container.note).to.contain(TRUST_NOTE);
    // It disavows a timestamp and points at the human trust-root.
    expect(container.note).to.contain("does NOT prove a timestamp");
    expect(container.note).to.contain("P-3");
    expect(container.signature).to.deep.equal(goodSig());
    expect(SIGNED_ATTESTATION_SCHEMES).to.include("eip191-personal-sign");
  });

  describe("strict validation REJECTS each malformed variant (never half-accepts)", function () {
    let unsigned;
    beforeEach(function () {
      unsigned = fixtureUnsigned({ "a.txt": "AAA", "b.txt": "BBB" }, "sig-reject").unsigned;
    });

    // Build a good container, mutate the parsed JSON, write it, and return the path (for readSignedAttestation).
    function writeBad(mut, name) {
      const container = buildSignedAttestation({ attestation: unsigned, ...goodSig() });
      const o = JSON.parse(serializeSignedAttestation(container));
      mut(o);
      const p = path.join(tmp("sig-bad-" + name + "-"), "signed.json");
      fs.writeFileSync(p, JSON.stringify(o));
      return p;
    }

    it("wrong kind", function () {
      expect(() => readSignedAttestation(writeBad((o) => (o.kind = "nope"), "kind"))).to.throw(
        /not a verifyhash signed dataset attestation/
      );
    });
    it("wrong schemaVersion", function () {
      expect(() => readSignedAttestation(writeBad((o) => (o.schemaVersion = 99), "ver"))).to.throw(
        /unsupported signed dataset attestation schemaVersion/
      );
    });
    it("missing signature block", function () {
      expect(() => readSignedAttestation(writeBad((o) => delete o.signature, "nosig"))).to.throw(
        /signature must be a \{ scheme, signer, signature \} object/
      );
    });
    it("non-hex signature value", function () {
      expect(() =>
        readSignedAttestation(writeBad((o) => (o.signature.signature = "0xZZ"), "nothex"))
      ).to.throw(/signature value must be a 0x-prefixed LOWERCASE-hex string/);
    });
    it("signature wrong length for the scheme", function () {
      expect(() =>
        readSignedAttestation(writeBad((o) => (o.signature.signature = "0xdead"), "shortsig"))
      ).to.throw(/eip191-personal-sign signature must be a 65-byte/);
    });
    it("malformed signer address", function () {
      expect(() =>
        readSignedAttestation(writeBad((o) => (o.signature.signer = "0xnotanaddress"), "signer"))
      ).to.throw(/signer must be a 0x-prefixed 20-byte LOWERCASE-hex address/);
    });
    it("unknown scheme", function () {
      expect(() =>
        readSignedAttestation(writeBad((o) => (o.signature.scheme = "eip712"), "scheme"))
      ).to.throw(/unknown signature scheme/);
    });
    it("reworded/missing note", function () {
      expect(() =>
        readSignedAttestation(writeBad((o) => (o.note = "trust me"), "note"))
      ).to.throw(/note must be the standing SIGNED_ATTESTATION_TRUST_NOTE/);
    });
    it("embedded attestation is not a string", function () {
      expect(() =>
        readSignedAttestation(writeBad((o) => (o.attestation = { kind: ATTESTATION_KIND }), "notstr"))
      ).to.throw(/must embed the canonical UNSIGNED attestation as a string/);
    });
    it("embedded attestation fails validateAttestation (tampered embedded payload)", function () {
      expect(() =>
        readSignedAttestation(
          writeBad((o) => {
            const e = JSON.parse(o.attestation);
            e.root = "0xnothex";
            o.attestation = JSON.stringify(e) + "\n";
          }, "badembed")
        )
      ).to.throw(/root must be a 0x-prefixed 32-byte hex/);
    });
    it("embedded attestation is itself signed:true (wrap-don't-edit invariant)", function () {
      expect(() =>
        readSignedAttestation(
          writeBad((o) => {
            const e = JSON.parse(o.attestation);
            e.signed = true;
            o.attestation = JSON.stringify(e) + "\n";
          }, "signedtrue")
        )
      ).to.throw(/signed must be false/);
    });
    it("embedded attestation is not in canonical form (reordered keys / extra whitespace)", function () {
      expect(() =>
        readSignedAttestation(
          writeBad((o) => {
            const e = JSON.parse(o.attestation);
            // Pretty-print: valid JSON, validates fine, but NOT byte-identical to serializeAttestation.
            o.attestation = JSON.stringify(e, null, 2) + "\n";
          }, "noncanon")
        )
      ).to.throw(/not in canonical form/);
    });
    it("embedded attestation is not valid JSON", function () {
      expect(() =>
        readSignedAttestation(writeBad((o) => (o.attestation = "{not json"), "badjson"))
      ).to.throw(/embedded attestation is not valid JSON/);
    });
  });

  it("buildSignedAttestation does NO key handling and rejects a signed:true embedded payload at build time", function () {
    const { unsigned } = fixtureUnsigned({ "a.txt": "AAA" }, "sig-build");
    const tampered = JSON.parse(JSON.stringify(unsigned));
    tampered.signed = true;
    expect(() => buildSignedAttestation({ attestation: tampered, ...goodSig() })).to.throw(
      /signed must be false/
    );
    // A bad signer is caught at build time too (the container is never produced malformed).
    expect(() =>
      buildSignedAttestation({ attestation: unsigned, scheme: "eip191-personal-sign", signer: "0xbad", signature: SIG65 })
    ).to.throw(/signer must be a 0x-prefixed 20-byte LOWERCASE-hex address/);
  });

  describe("byte-determinism of the signature block (T-17.1 rework)", function () {
    it("a mixed-case (EIP-55 checksummed) signer is REJECTED — not silently round-tripped to other bytes", function () {
      const { unsigned } = fixtureUnsigned({ "a.txt": "AAA" }, "sig-mixedsigner");
      // Same logical address as SIGNER but with some upper-case hex (an EIP-55-style checksum form).
      const checksummed = "0x" + "Ab".repeat(20);
      expect(() =>
        buildSignedAttestation({ attestation: unsigned, scheme: "eip191-personal-sign", signer: checksummed, signature: SIG65 })
      ).to.throw(/signer must be a 0x-prefixed 20-byte LOWERCASE-hex address/);
    });

    it("an upper/mixed-case signature value is REJECTED — not silently round-tripped to other bytes", function () {
      const { unsigned } = fixtureUnsigned({ "a.txt": "AAA" }, "sig-mixedsig");
      const upperSig = "0x" + "CD".repeat(65); // same logical sig as SIG65, upper-cased
      expect(() =>
        buildSignedAttestation({ attestation: unsigned, scheme: "eip191-personal-sign", signer: SIGNER, signature: upperSig })
      ).to.throw(/signature value must be a 0x-prefixed LOWERCASE-hex string/);
    });

    it("the only ACCEPTED encoding of a logical signature serializes to ONE byte string (deterministic)", function () {
      // Because mixed/upper case is rejected on build AND read, every accepted container over a given
      // logical signature carries the SAME (lowercase) bytes — so two structurally-identical containers
      // CANNOT serialize to different bytes. Build the lowercase form twice and confirm byte-equality.
      const { unsigned } = fixtureUnsigned({ "a.txt": "AAA", "b.txt": "BBB" }, "sig-det");
      const c1 = buildSignedAttestation({ attestation: unsigned, ...goodSig() });
      const c2 = buildSignedAttestation({ attestation: unsigned, ...goodSig() });
      expect(serializeSignedAttestation(c1)).to.equal(serializeSignedAttestation(c2));
      // And a reader cannot resurrect a mixed-case container that was hand-written to disk: it is rejected,
      // never normalized into the canonical bytes (reject-don't-fix keeps the wire format single-valued).
      const onDisk = JSON.parse(serializeSignedAttestation(c1));
      onDisk.signature.signature = "0x" + "CD".repeat(65); // upper-case the sig bytes
      const p = path.join(tmp("sig-det-disk-"), "signed.json");
      fs.writeFileSync(p, JSON.stringify(onDisk));
      expect(() => readSignedAttestation(p)).to.throw(/signature value must be a 0x-prefixed LOWERCASE-hex string/);
    });

    it("validateSignedAttestation directly rejects a mixed-case signer in an otherwise-valid container", function () {
      const { unsigned } = fixtureUnsigned({ "a.txt": "AAA" }, "sig-valmixed");
      const good = buildSignedAttestation({ attestation: unsigned, ...goodSig() });
      const bad = JSON.parse(serializeSignedAttestation(good));
      bad.signature.signer = "0x" + "Ab".repeat(20);
      expect(() => validateSignedAttestation(bad)).to.throw(
        /signer must be a 0x-prefixed 20-byte LOWERCASE-hex address/
      );
    });
  });

  it("readSignedAttestation rejects a missing file and invalid JSON", function () {
    expect(() => readSignedAttestation("/no/such/signed.json")).to.throw(
      /cannot read signed dataset attestation/
    );
    const p = path.join(tmp("sig-badjson-"), "signed.json");
    fs.writeFileSync(p, "{not json");
    expect(() => readSignedAttestation(p)).to.throw(/is not valid JSON/);
  });
});

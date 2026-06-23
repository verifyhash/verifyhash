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

// =================================================================================================
// T-17.2 — `vh dataset verify-attest <signed> [--manifest <m>] [--signer <addr>] [--json]`: an OFFLINE
// verifier that confirms a signed attestation, PROVED end-to-end with THROWAWAY test keys.
//
// CRITICAL: every key here is an EPHEMERAL, in-process `Wallet.createRandom()` — a TEST-ONLY key that is
// NEVER persisted and is NEVER a real-funds key. We assert/comment this throughout. NO network, NO real
// key, NO provider anywhere in this suite (the verifier is purely offline).
const { Wallet, getAddress } = require("ethers");
const {
  runDatasetVerifyAttest,
  verifySignedAttestation,
  recoverSignedAttestationSigner,
  VERIFY_ATTEST_TRUST_NOTE,
} = require("../cli/dataset");
const { cmdDataset, cmdDatasetVerifyAttest, parseDatasetVerifyAttestArgs } = require("../cli/vh");

describe("cli: vh dataset verify-attest (T-17.2) — OFFLINE signed-attestation verifier", function () {
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

  // Build a manifest from a fresh tree and return { manifestPath, manifest, unsigned, canonical }.
  function buildFixture(files, prefix) {
    const dir = tmp((prefix || "va") + "-tree-");
    writeFiles(dir, files);
    const manifestPath = path.join(tmp((prefix || "va") + "-man-"), "manifest.json");
    runDatasetBuild({ dir, out: manifestPath, stdout: () => {} });
    const manifest = readManifest(manifestPath);
    const unsigned = buildAttestation(manifest);
    const canonical = serializeAttestation(unsigned);
    return { manifestPath, manifest, unsigned, canonical };
  }

  // Sign the EXACT canonical UNSIGNED bytes per the eip191-personal-sign scheme with an EPHEMERAL,
  // THROWAWAY test-only key (NEVER persisted, NEVER a real-funds key), build the signed container
  // (T-17.1), write it to a throwaway temp path, and return everything the tests need.
  async function signFixture(files, prefix, wallet) {
    const fx = buildFixture(files, prefix);
    // TEST-ONLY KEY: generated in-process, never written to disk, never funded. Asserted below.
    const w = wallet || Wallet.createRandom();
    expect(w.privateKey).to.match(/^0x[0-9a-fA-F]{64}$/); // an in-memory key — never a real-funds key
    const signature = (await w.signMessage(fx.canonical)).toLowerCase();
    const container = buildSignedAttestation({
      attestation: fx.unsigned,
      scheme: "eip191-personal-sign",
      signer: w.address.toLowerCase(),
      signature,
    });
    const signedPath = path.join(tmp(prefix + "-signed-"), "signed.json");
    fs.writeFileSync(signedPath, serializeSignedAttestation(container));
    return { ...fx, wallet: w, container, signedPath };
  }

  it("ACCEPTS a genuinely-signed container (signature recovers to the claimed signer)", async function () {
    const fx = await signFixture({ "a.txt": "AAA", "b.txt": "BBB" }, "va-accept");
    let out = "";
    const r = runDatasetVerifyAttest({ signed: fx.signedPath, stdout: (s) => (out += s) });
    expect(r.verdict).to.equal("ACCEPTED");
    expect(r.accepted).to.equal(true);
    expect(r.recoveredSigner).to.equal(fx.wallet.address.toLowerCase());
    expect(r.claimedSigner).to.equal(fx.wallet.address.toLowerCase());
    expect(r.checks.signatureMatchesSigner).to.equal(true);
    // The two optional checks were not requested -> null, never fail the gate.
    expect(r.checks.signerMatchesExpected).to.equal(null);
    expect(r.checks.manifestBindsAttestation).to.equal(null);
    expect(out).to.contain("ACCEPTED");
  });

  it("OUTPUT LEADS with the standing TRUST_NOTE + signing caveat; never overclaims past P-3", async function () {
    const fx = await signFixture({ "a.txt": "AAA" }, "va-trust");
    let out = "";
    runDatasetVerifyAttest({ signed: fx.signedPath, stdout: (s) => (out += s) });
    // Leads with the trust caveat.
    expect(out.indexOf("TRUST:")).to.be.lessThan(out.indexOf("verify-attest:"));
    // Reuses the standing dataset TRUST_NOTE verbatim.
    expect(VERIFY_ATTEST_TRUST_NOTE).to.contain(TRUST_NOTE);
    expect(out).to.contain(TRUST_NOTE);
    // Signing-specific caveats: NOT a timestamp (P-3), NOT a license/source validation.
    expect(out).to.contain("does NOT by itself prove a trustworthy TIMESTAMP");
    expect(out).to.contain("P-3");
    expect(out).to.contain("license/source");
  });

  it("--signer PINS the expected publisher: ACCEPTS the right one, REJECTS a different one", async function () {
    const fx = await signFixture({ "a.txt": "AAA", "b.txt": "BBB" }, "va-pin");
    // Right publisher (checksummed form accepted via getAddress) -> ACCEPTED + pin PASS.
    const ok = runDatasetVerifyAttest({
      signed: fx.signedPath,
      signer: getAddress(fx.wallet.address), // EIP-55 checksummed; the verifier normalizes
      stdout: () => {},
    });
    expect(ok.verdict).to.equal("ACCEPTED");
    expect(ok.checks.signerMatchesExpected).to.equal(true);
    expect(ok.expectedSigner).to.equal(fx.wallet.address.toLowerCase());

    // A DIFFERENT expected publisher (another throwaway key's address) -> REJECTED, naming the failed pin.
    const other = Wallet.createRandom(); // TEST-ONLY key
    let out = "";
    const bad = runDatasetVerifyAttest({
      signed: fx.signedPath,
      signer: other.address,
      stdout: (s) => (out += s),
    });
    expect(bad.verdict).to.equal("REJECTED");
    expect(bad.checks.signerMatchesExpected).to.equal(false);
    // The signature itself is still genuine — only the EXPECTED-publisher pin failed.
    expect(bad.checks.signatureMatchesSigner).to.equal(true);
    expect(bad.failedChecks).to.deep.equal(["signerMatchesExpected"]);
    expect(out).to.contain("signerMatchesExpected");
  });

  it("--manifest BINDS the signature to the buyer's dataset: ACCEPTS the matching one", async function () {
    const fx = await signFixture({ "a.txt": "AAA", "b.txt": "BBB" }, "va-bind-ok");
    const r = runDatasetVerifyAttest({
      signed: fx.signedPath,
      manifest: fx.manifestPath,
      stdout: () => {},
    });
    expect(r.verdict).to.equal("ACCEPTED");
    expect(r.checks.manifestBindsAttestation).to.equal(true);
    expect(r.manifestChecked).to.equal(true);
  });

  it("--manifest that DIFFERS from the signed payload REJECTS with a clear binding-mismatch", async function () {
    // Sign over dataset A...
    const fx = await signFixture({ "a.txt": "AAA", "b.txt": "BBB" }, "va-bind-bad");
    // ...but the buyer holds a DIFFERENT dataset B (different content -> different canonical bytes).
    const otherDir = tmp("va-bind-bad-other-tree-");
    writeFiles(otherDir, { "a.txt": "DIFFERENT", "b.txt": "BBB" });
    const otherManifest = path.join(tmp("va-bind-bad-other-man-"), "manifest.json");
    runDatasetBuild({ dir: otherDir, out: otherManifest, stdout: () => {} });

    let out = "";
    const r = runDatasetVerifyAttest({
      signed: fx.signedPath,
      manifest: otherManifest,
      stdout: (s) => (out += s),
    });
    expect(r.verdict).to.equal("REJECTED");
    expect(r.checks.manifestBindsAttestation).to.equal(false);
    // The signature is genuine; only the dataset binding failed.
    expect(r.checks.signatureMatchesSigner).to.equal(true);
    expect(r.failedChecks).to.deep.equal(["manifestBindsAttestation"]);
    expect(out).to.contain("binding-mismatch");
  });

  it("TAMPERING the signature REJECTS (recovers to a different/garbage address)", async function () {
    const fx = await signFixture({ "a.txt": "AAA", "b.txt": "BBB" }, "va-tamper-sig");
    // Flip one byte of the signature -> it recovers to some OTHER address, not the claimed signer.
    const onDisk = JSON.parse(serializeSignedAttestation(fx.container));
    const sig = onDisk.signature.signature;
    // Mutate a middle hex char (stay lowercase + 65 bytes so it passes the shape validator but is wrong).
    const idx = 50;
    const ch = sig[idx] === "a" ? "b" : "a";
    onDisk.signature.signature = sig.slice(0, idx) + ch + sig.slice(idx + 1);
    const p = path.join(tmp("va-tamper-sig-w-"), "signed.json");
    fs.writeFileSync(p, JSON.stringify(onDisk));
    const r = runDatasetVerifyAttest({ signed: p, stdout: () => {} });
    expect(r.verdict).to.equal("REJECTED");
    expect(r.checks.signatureMatchesSigner).to.equal(false);
    expect(r.recoveredSigner).to.not.equal(r.claimedSigner);
  });

  it("TAMPERING the claimed `signer` REJECTS (recovered != claimed)", async function () {
    const fx = await signFixture({ "a.txt": "AAA" }, "va-tamper-signer");
    const onDisk = JSON.parse(serializeSignedAttestation(fx.container));
    // Replace the claimed signer with a DIFFERENT (throwaway) address; the signature still recovers to the
    // ORIGINAL signer, so recovered != claimed -> REJECTED.
    const other = Wallet.createRandom(); // TEST-ONLY key
    onDisk.signature.signer = other.address.toLowerCase();
    const p = path.join(tmp("va-tamper-signer-w-"), "signed.json");
    fs.writeFileSync(p, JSON.stringify(onDisk));
    const r = runDatasetVerifyAttest({ signed: p, stdout: () => {} });
    expect(r.verdict).to.equal("REJECTED");
    expect(r.checks.signatureMatchesSigner).to.equal(false);
    expect(r.recoveredSigner).to.equal(fx.wallet.address.toLowerCase());
    expect(r.claimedSigner).to.equal(other.address.toLowerCase());
  });

  it("TAMPERING the embedded payload REJECTS (the signature no longer recovers to the claimed signer)", async function () {
    const fx = await signFixture({ "a.txt": "AAA", "b.txt": "BBB" }, "va-tamper-payload");
    const onDisk = JSON.parse(serializeSignedAttestation(fx.container));
    // Edit the embedded canonical bytes in a way that STAYS structurally valid + canonical (so the strict
    // reader accepts the container) but changes the signed-over identity: swap the manifestDigest to a
    // different (still-32-byte-hex) value. The signature was made over the ORIGINAL bytes, so it now
    // recovers to a DIFFERENT address than the claimed signer -> REJECTED. The signed identity is bound.
    const embedded = JSON.parse(onDisk.attestation);
    embedded.manifestDigest = "0x" + "11".repeat(32);
    onDisk.attestation = JSON.stringify(embedded) + "\n";
    const p = path.join(tmp("va-tamper-payload-w-"), "signed.json");
    fs.writeFileSync(p, JSON.stringify(onDisk));
    const r = runDatasetVerifyAttest({ signed: p, stdout: () => {} });
    expect(r.verdict).to.equal("REJECTED");
    expect(r.checks.signatureMatchesSigner).to.equal(false);
    // The signature recovered to SOMETHING, but not the claimed signer (the payload was altered after signing).
    expect(r.recoveredSigner).to.not.equal(r.claimedSigner);
  });

  it("a NON-CANONICAL embedded payload is rejected at READ (strict reader, runtime error -> exit 1)", async function () {
    const fx = await signFixture({ "a.txt": "AAA", "b.txt": "BBB" }, "va-noncanon");
    const onDisk = JSON.parse(serializeSignedAttestation(fx.container));
    // Pretty-print the embedded payload: valid JSON, validates fine, but NOT byte-identical to
    // serializeAttestation -> readSignedAttestation rejects it (the signed-over bytes must be canonical).
    const embedded = JSON.parse(onDisk.attestation);
    onDisk.attestation = JSON.stringify(embedded, null, 2) + "\n";
    const p = path.join(tmp("va-noncanon-w-"), "signed.json");
    fs.writeFileSync(p, JSON.stringify(onDisk));
    expect(() => runDatasetVerifyAttest({ signed: p, stdout: () => {} })).to.throw(/not in canonical form/);
  });

  it("a WRONG-KEY signature REJECTS (valid 65-byte sig from a different key over the same bytes)", async function () {
    const fx = buildFixture({ "a.txt": "AAA", "b.txt": "BBB" }, "va-wrongkey");
    // Two distinct THROWAWAY keys. The container CLAIMS `claimant` signed, but `imposter` actually signed
    // the bytes -> recovered (imposter) != claimed (claimant) -> REJECTED.
    const claimant = Wallet.createRandom(); // TEST-ONLY key
    const imposter = Wallet.createRandom(); // TEST-ONLY key
    const imposterSig = (await imposter.signMessage(fx.canonical)).toLowerCase();
    const container = buildSignedAttestation({
      attestation: fx.unsigned,
      scheme: "eip191-personal-sign",
      signer: claimant.address.toLowerCase(), // claims claimant, but imposter signed
      signature: imposterSig,
    });
    const p = path.join(tmp("va-wrongkey-w-"), "signed.json");
    fs.writeFileSync(p, serializeSignedAttestation(container));
    const r = runDatasetVerifyAttest({ signed: p, stdout: () => {} });
    expect(r.verdict).to.equal("REJECTED");
    expect(r.checks.signatureMatchesSigner).to.equal(false);
    expect(r.recoveredSigner).to.equal(imposter.address.toLowerCase());
    expect(r.claimedSigner).to.equal(claimant.address.toLowerCase());
  });

  it("ALL THREE checks together: a fully-pinned ACCEPT round-trips through --json", async function () {
    const fx = await signFixture({ "a.txt": "AAA", "b.txt": "BBB", "sub/c.txt": "CCC" }, "va-all");
    let out = "";
    const r = runDatasetVerifyAttest({
      signed: fx.signedPath,
      manifest: fx.manifestPath,
      signer: fx.wallet.address,
      json: true,
      stdout: (s) => (out += s),
    });
    expect(r.verdict).to.equal("ACCEPTED");
    // --json emits a machine verdict carrying recovered/expected signer, the binding result, per-check bools.
    const parsed = JSON.parse(out);
    expect(parsed).to.deep.equal(r);
    expect(parsed.recoveredSigner).to.equal(fx.wallet.address.toLowerCase());
    expect(parsed.expectedSigner).to.equal(fx.wallet.address.toLowerCase());
    expect(parsed.checks).to.deep.equal({
      signatureMatchesSigner: true,
      signerMatchesExpected: true,
      manifestBindsAttestation: true,
    });
    expect(parsed.failedChecks).to.deep.equal([]);
  });

  it("recoverSignedAttestationSigner recovers the exact signer from the embedded bytes (pure helper)", async function () {
    const fx = await signFixture({ "a.txt": "AAA" }, "va-recover");
    expect(recoverSignedAttestationSigner(fx.container)).to.equal(fx.wallet.address.toLowerCase());
  });

  describe("CLI exit codes mirror the dataset gate convention (0 ACCEPTED, 3 REJECTED, 2 usage, 1 runtime)", function () {
    it("exit 0 on ACCEPTED", async function () {
      const fx = await signFixture({ "a.txt": "AAA", "b.txt": "BBB" }, "va-exit0");
      const code = cmdDataset([
        "verify-attest",
        fx.signedPath,
        "--manifest",
        fx.manifestPath,
        "--signer",
        fx.wallet.address,
        "--json",
      ]);
      expect(code).to.equal(0);
    });

    it("exit 3 on REJECTED (wrong --signer)", async function () {
      const fx = await signFixture({ "a.txt": "AAA" }, "va-exit3");
      const other = Wallet.createRandom(); // TEST-ONLY key
      const code = cmdDataset(["verify-attest", fx.signedPath, "--signer", other.address, "--json"]);
      expect(code).to.equal(3);
    });

    it("exit 2 on a usage error (unknown flag)", async function () {
      const fx = await signFixture({ "a.txt": "AAA" }, "va-exit2-flag");
      const code = cmdDatasetVerifyAttest([fx.signedPath, "--nope"]);
      expect(code).to.equal(2);
    });

    it("exit 2 on a usage error (missing positional)", function () {
      const code = cmdDatasetVerifyAttest(["--json"]);
      expect(code).to.equal(2);
    });

    it("exit 2 on a usage error (extra positional)", async function () {
      const fx = await signFixture({ "a.txt": "AAA" }, "va-exit2-extra");
      const code = cmdDatasetVerifyAttest([fx.signedPath, "extra.json"]);
      expect(code).to.equal(2);
    });

    it("exit 2 on a malformed --signer address (caught before any work)", async function () {
      const fx = await signFixture({ "a.txt": "AAA" }, "va-exit2-signer");
      const code = cmdDatasetVerifyAttest([fx.signedPath, "--signer", "0xnotanaddress"]);
      expect(code).to.equal(2);
    });

    it("exit 1 on a runtime error (missing container)", function () {
      const code = cmdDatasetVerifyAttest(["/no/such/signed.json"]);
      expect(code).to.equal(1);
    });

    it("exit 1 on a runtime error (corrupt/edited embedded payload)", async function () {
      const fx = await signFixture({ "a.txt": "AAA", "b.txt": "BBB" }, "va-exit1-corrupt");
      const onDisk = JSON.parse(serializeSignedAttestation(fx.container));
      const embedded = JSON.parse(onDisk.attestation);
      embedded.root = "0xnothex";
      onDisk.attestation = JSON.stringify(embedded) + "\n";
      const p = path.join(tmp("va-exit1-corrupt-w-"), "signed.json");
      fs.writeFileSync(p, JSON.stringify(onDisk));
      const code = cmdDatasetVerifyAttest([p]);
      expect(code).to.equal(1);
    });
  });

  describe("parser parity: unknown/incomplete flags hard-error (a typo never silently passes)", function () {
    it("unknown flag throws", function () {
      expect(() => parseDatasetVerifyAttestArgs(["s.json", "--bogus"])).to.throw(/unknown flag: --bogus/);
    });
    it("--manifest without a value throws", function () {
      expect(() => parseDatasetVerifyAttestArgs(["s.json", "--manifest"])).to.throw(
        /--manifest requires a value/
      );
    });
    it("--signer without a value throws", function () {
      expect(() => parseDatasetVerifyAttestArgs(["s.json", "--signer"])).to.throw(
        /--signer requires a value/
      );
    });
    it("a duplicate positional throws", function () {
      expect(() => parseDatasetVerifyAttestArgs(["a.json", "b.json"])).to.throw(
        /unexpected extra argument/
      );
    });
    it("a well-formed argv parses cleanly", function () {
      expect(parseDatasetVerifyAttestArgs(["s.json", "--manifest", "m.json", "--signer", "0xabc", "--json"])).to.deep.equal({
        signed: "s.json",
        manifest: "m.json",
        signer: "0xabc",
        json: true,
      });
    });
  });

  it("leaves ZERO artifacts in the repo working tree (filesystem hygiene; all side effects in temp dirs)", function () {
    // A sentinel check: this suite writes ONLY under os.tmpdir() (every helper uses tmp()), and afterEach
    // removes them. There is no caller-less write path here. Confirm the cwd has no leaked signed.json.
    const leaked = fs.existsSync(path.join(process.cwd(), "signed.json"));
    expect(leaked).to.equal(false);
  });
});

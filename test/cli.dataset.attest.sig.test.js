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

// =====================================================================================================
// T-19.1 — core signing helper: signAttestation({ attestation, signer }, cfg)
//
// What these prove:
//   * signAttestation produces an EIP-191 personal_sign signature over the EXACT canonical UNSIGNED bytes
//     and WRAPS it into a validated signed container via the existing buildSignedAttestation path.
//   * The container ROUND-TRIPS: verifySignedAttestation recovers exactly the signer address over exactly
//     those bytes, AND binding against the caller's recomputed canonical bytes (expectedCanonical) passes
//     — proving signAttestation and recoverSigner/verify agree on the signed-over bytes byte-for-byte.
//   * Wrap-don't-edit: the embedded payload stays signed:false/signature:null.
//   * A DIFFERENT wallet's expectedSigner pin REJECTS (the signature is bound to the real signer).
//   * It works with BOTH a dataset unsigned payload and a parcel unsigned payload, against the respective
//     product cfg — proving the helper is genuinely product-agnostic and parameterized by cfg.
//   * It never accepts a raw private-key string (it takes a signer OBJECT); key handling is the CLI layer's.
//
// CRITICAL: every key here is an EPHEMERAL, in-process `Wallet.createRandom()` — a TEST-ONLY key, never
// persisted, NEVER a real-funds key, NO network, NO provider. It exists solely to mint a genuine
// eip191-personal-sign signature so the round-trip is honestly exercised.
// =====================================================================================================
const coreAttestation = require("../cli/core/attestation");
const datasetMod = require("../cli/dataset");
const parcelMod = require("../cli/parcel");

describe("cli/core: signAttestation (T-19.1) — ephemeral TEST-ONLY keys, NO network, NO real funds", function () {
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
  function writeTree(files, prefix) {
    const dir = tmp(prefix);
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(dir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return dir;
  }

  // The DataLedger signed-container cfg, rebuilt from the dataset module's PUBLIC exports (kind/schema/
  // note + the unsigned codec). Faithful to the product framing — proven below because the product's OWN
  // validateSignedAttestation (which uses the REAL internal cfg) accepts every container we produce, so a
  // drift between this reconstructed cfg and the product's would surface as a rejection, not a silent pass.
  const DATASET_CFG = Object.freeze({
    kind: datasetMod.SIGNED_ATTESTATION_KIND,
    schemaVersion: datasetMod.SIGNED_ATTESTATION_SCHEMA_VERSION,
    supportedSchemaVersions: datasetMod.SUPPORTED_SIGNED_ATTESTATION_SCHEMA_VERSIONS,
    note: datasetMod.SIGNED_ATTESTATION_TRUST_NOTE,
    label: "signed dataset attestation",
    validateUnsigned: datasetMod.validateAttestation,
    serializeUnsigned: datasetMod.serializeAttestation,
  });

  // Build a REAL dataset UNSIGNED attestation payload (offline) + its canonical bytes.
  function datasetUnsigned(files) {
    const dir = writeTree(files, "t191-ds-tree-");
    const manifestPath = path.join(tmp("t191-ds-man-"), "manifest.json");
    datasetMod.runDatasetBuild({ dir, out: manifestPath, stdout: () => {} });
    const manifest = datasetMod.readManifest(manifestPath);
    const unsigned = datasetMod.buildAttestation(manifest);
    return { unsigned, canonical: datasetMod.serializeAttestation(unsigned) };
  }

  // The ProofParcel signed-container cfg, rebuilt the same way from parcel's PUBLIC exports.
  const PARCEL_CFG = Object.freeze({
    kind: parcelMod.SIGNED_PARCEL_ATTESTATION_KIND,
    schemaVersion: parcelMod.PARCEL_ATTESTATION_SCHEMA_VERSION,
    supportedSchemaVersions: parcelMod.SUPPORTED_PARCEL_ATTESTATION_SCHEMA_VERSIONS,
    note: parcelMod.SIGNED_PARCEL_ATTESTATION_TRUST_NOTE,
    label: "signed parcel attestation",
    validateUnsigned: parcelMod.validateParcelAttestation,
    serializeUnsigned: parcelMod.serializeParcelAttestation,
  });

  // Build a REAL parcel UNSIGNED attestation payload (offline) + its canonical bytes.
  function parcelUnsigned(files) {
    const dir = writeTree(files, "t191-pc-tree-");
    const manifestPath = path.join(tmp("t191-pc-man-"), "manifest.json");
    parcelMod.runParcelBuild({ dir, out: manifestPath, stdout: () => {} });
    const manifest = parcelMod.readParcelManifest(manifestPath);
    const unsigned = parcelMod.buildParcelAttestation(manifest);
    return { unsigned, canonical: parcelMod.serializeParcelAttestation(unsigned) };
  }

  // The product-level validator (uses the REAL internal cfg) — used as a drift guard on the cfgs above.
  const PRODUCT_VALIDATOR = {
    "signed dataset attestation": datasetMod.validateSignedAttestation,
    "signed parcel attestation": parcelMod.validateSignedParcelAttestation,
  };

  // The single parameterized round-trip assertion, run against BOTH products.
  function assertSignRoundTrip(label, cfg, build) {
    it(`${label}: signs, wraps, recovers the signer, binds its own bytes, and the product validator accepts it`, async function () {
      const { unsigned, canonical } = build();
      const wallet = Wallet.createRandom(); // EPHEMERAL, in-memory, TEST-ONLY — never persisted.

      const container = await coreAttestation.signAttestation({ attestation: unsigned, signer: wallet }, cfg);

      // The produced container passes the PRODUCT's own strict validator (real internal cfg) — proving the
      // reconstructed cfg here matches the product framing (no silent drift) and the container is sound.
      expect(PRODUCT_VALIDATOR[label](container)).to.equal(container);

      // Container framing: the product's kind/note, eip191 scheme, claimed signer = lowercased wallet addr.
      expect(container.kind).to.equal(cfg.kind);
      expect(container.note).to.equal(cfg.note);
      expect(container.signature.scheme).to.equal("eip191-personal-sign");
      expect(container.signature.signer).to.equal(wallet.address.toLowerCase());

      // The embedded payload is the EXACT canonical UNSIGNED bytes the caller would recompute — byte-for-byte.
      expect(container.attestation).to.equal(canonical);

      // WRAP-DON'T-EDIT: the embedded payload stays signed:false/signature:null.
      const embedded = JSON.parse(container.attestation);
      expect(embedded.signed).to.equal(false);
      expect(embedded.signature).to.equal(null);

      // ROUND-TRIP: recoverSigner + verify agree on the signed-over bytes. ACCEPTED, recovers the wallet
      // address, and binding the caller's own recomputed canonical bytes also passes.
      expect(coreAttestation.recoverSigner(container)).to.equal(wallet.address.toLowerCase());
      const verdict = coreAttestation.verifySignedAttestation({
        container,
        expectedSigner: wallet.address,
        expectedCanonical: canonical,
      });
      expect(verdict.verdict).to.equal("ACCEPTED");
      expect(verdict.accepted).to.equal(true);
      expect(verdict.recoveredSigner).to.equal(wallet.address.toLowerCase());
      expect(verdict.checks.signatureMatchesSigner).to.equal(true);
      expect(verdict.checks.signerMatchesExpected).to.equal(true);
      expect(verdict.checks.manifestBindsAttestation).to.equal(true);

      // A DIFFERENT wallet's expectedSigner pin REJECTS (the signature is bound to the real signer).
      const imposter = Wallet.createRandom(); // TEST-ONLY key
      const rej = coreAttestation.verifySignedAttestation({ container, expectedSigner: imposter.address });
      expect(rej.verdict).to.equal("REJECTED");
      expect(rej.checks.signerMatchesExpected).to.equal(false);
      expect(rej.failedChecks).to.include("signerMatchesExpected");
    });
  }

  assertSignRoundTrip("signed dataset attestation", DATASET_CFG, function () {
    return datasetUnsigned({ "a.txt": "AAA", "b.txt": "BBB" });
  });
  assertSignRoundTrip("signed parcel attestation", PARCEL_CFG, function () {
    return parcelUnsigned({ "x.txt": "XYZ", "nested/y.txt": "YZ" });
  });

  it("two ephemeral signers over the SAME payload recover to their OWN distinct addresses", async function () {
    const { unsigned } = datasetUnsigned({ "a.txt": "AAA" });
    const w1 = Wallet.createRandom(); // TEST-ONLY
    const w2 = Wallet.createRandom(); // TEST-ONLY
    const c1 = await coreAttestation.signAttestation({ attestation: unsigned, signer: w1 }, DATASET_CFG);
    const c2 = await coreAttestation.signAttestation({ attestation: unsigned, signer: w2 }, DATASET_CFG);
    expect(coreAttestation.recoverSigner(c1)).to.equal(w1.address.toLowerCase());
    expect(coreAttestation.recoverSigner(c2)).to.equal(w2.address.toLowerCase());
    expect(coreAttestation.recoverSigner(c1)).to.not.equal(coreAttestation.recoverSigner(c2));
    // Both bind the SAME embedded canonical bytes (only the signature/signer differ).
    expect(c1.attestation).to.equal(c2.attestation);
  });

  it("rejects a raw private-key STRING and a non-signer object (key handling is the CLI layer's job)", async function () {
    const { unsigned } = datasetUnsigned({ "a.txt": "AAA" });
    const wallet = Wallet.createRandom(); // TEST-ONLY — we use its private key string ONLY to prove rejection
    let threw;
    try {
      await coreAttestation.signAttestation({ attestation: unsigned, signer: wallet.privateKey }, DATASET_CFG);
      threw = null;
    } catch (e) {
      threw = e;
    }
    expect(threw, "a raw private-key string must be rejected").to.be.an("error");
    expect(threw.message).to.match(/signer.*object|getAddress|signMessage/);

    // A plain object missing signMessage/getAddress is rejected too.
    let threw2;
    try {
      await coreAttestation.signAttestation({ attestation: unsigned, signer: {} }, DATASET_CFG);
      threw2 = null;
    } catch (e) {
      threw2 = e;
    }
    expect(threw2).to.be.an("error");
    expect(threw2.message).to.match(/getAddress.*signMessage|signMessage/);
  });

  it("re-validates the UNSIGNED payload before signing (never signs an already-'signed' payload)", async function () {
    const { unsigned } = datasetUnsigned({ "a.txt": "AAA" });
    const wallet = Wallet.createRandom(); // TEST-ONLY
    // An already-"signed" payload must be rejected by cfg.validateUnsigned BEFORE any signing happens.
    const tampered = { ...unsigned, signed: true };
    let threw;
    try {
      await coreAttestation.signAttestation({ attestation: tampered, signer: wallet }, DATASET_CFG);
      threw = null;
    } catch (e) {
      threw = e;
    }
    expect(threw).to.be.an("error");
  });

  it("leaves ZERO artifacts in the repo working tree (all side effects in temp dirs)", function () {
    expect(fs.existsSync(path.join(process.cwd(), "manifest.json"))).to.equal(false);
    expect(fs.existsSync(path.join(process.cwd(), "signed.json"))).to.equal(false);
  });
});

// =================================================================================================
// T-19.2 — `vh dataset sign <manifest> --key-env <VAR> | --key-file <path> [--out <p>] [--json]`: read a
// HUMAN-supplied key, sign the UNSIGNED dataset attestation, write the signed container.
//
// CRITICAL: every key here is an EPHEMERAL, in-process `Wallet.createRandom()` — a TEST-ONLY key written
// ONLY to a TEMP env var / a TEMP file under the OS temp dir, NEVER the repo, NEVER a real key. NO network,
// NO provider anywhere in this suite (signing is purely offline EIP-191 personal_sign).
const { runDatasetSign, SIGN_TRUST_NOTE, runDatasetVerifyAttest: runDsVerifyAttest } = require("../cli/dataset");
const { cmdDatasetSign, parseSignArgs } = require("../cli/vh");

describe("cli: vh dataset sign (T-19.2) — sign with a HUMAN-supplied key, EPHEMERAL test keys only", function () {
  let tmpDirs = [];
  function tmp(prefix) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  }
  let envVars = [];
  function setTempEnv(name, value) {
    envVars.push(name);
    process.env[name] = value;
  }
  afterEach(function () {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
    for (const n of envVars) delete process.env[n];
    envVars = [];
  });
  function writeTree(files, prefix) {
    const dir = tmp(prefix);
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(dir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return dir;
  }
  function buildManifestFixture(files = { "a.txt": "AAA", "b.txt": "BBB" }, prefix = "dsign") {
    const dir = writeTree(files, prefix + "-tree-");
    const manifestPath = path.join(tmp(prefix + "-man-"), "manifest.json");
    runDatasetBuild({ dir, out: manifestPath, stdout: () => {} });
    return { dir, manifestPath, manifest: readManifest(manifestPath) };
  }

  it("--key-env signs; the container is ACCEPTED by `vh dataset verify-attest --signer <thatAddr> --manifest`", async function () {
    const fx = buildManifestFixture();
    const w = Wallet.createRandom(); // EPHEMERAL TEST-ONLY key — never persisted to the repo
    setTempEnv("VH_DS_TEST_KEY", w.privateKey);
    const out = path.join(tmp("dsign-out-"), "signed.json");

    let printed = "";
    const r = await runDatasetSign({
      manifest: fx.manifestPath,
      keyEnv: "VH_DS_TEST_KEY",
      out,
      stdout: (s) => (printed += s),
    });
    expect(r.signer).to.equal(w.address.toLowerCase());
    expect(r.scheme).to.equal("eip191-personal-sign");
    // "signed by <0xaddr>" names WHICH key signed (its public address) so the human can confirm.
    expect(printed).to.include(`signed by ${w.address.toLowerCase()}`);
    // The output NEVER contains the private key.
    expect(printed).to.not.include(w.privateKey);
    expect(fs.readFileSync(out, "utf8")).to.not.include(w.privateKey);

    // The EXISTING verify-attest accepts it unchanged — pins the expected signer + binds the manifest.
    const va = runDsVerifyAttest({ signed: out, manifest: fx.manifestPath, signer: w.address, stdout: () => {} });
    expect(va.verdict).to.equal("ACCEPTED");
    expect(va.accepted).to.equal(true);
    expect(va.recoveredSigner).to.equal(w.address.toLowerCase());
    expect(va.checks.signatureMatchesSigner).to.equal(true);
    expect(va.checks.signerMatchesExpected).to.equal(true);
    expect(va.checks.manifestBindsAttestation).to.equal(true);
  });

  it("--key-file (a file the human created) signs and verify-attest ACCEPTS it", async function () {
    const fx = buildManifestFixture(undefined, "dsign-file");
    const w = Wallet.createRandom(); // TEST-ONLY
    const keyPath = path.join(tmp("dsign-key-"), "key.hex"); // TEMP dir, NEVER the repo
    fs.writeFileSync(keyPath, w.privateKey + "\n"); // trailing newline tolerated
    const out = path.join(tmp("dsign-fout-"), "signed.json");

    const r = await runDatasetSign({ manifest: fx.manifestPath, keyFile: keyPath, out, stdout: () => {} });
    expect(r.signer).to.equal(w.address.toLowerCase());

    const va = runDsVerifyAttest({ signed: out, manifest: fx.manifestPath, signer: w.address, stdout: () => {} });
    expect(va.accepted).to.equal(true);
  });

  it("a bare 64-hex key (no 0x) in --key-file is accepted (0x is prefixed)", async function () {
    const fx = buildManifestFixture(undefined, "dsign-bare");
    const w = Wallet.createRandom(); // TEST-ONLY
    const keyPath = path.join(tmp("dsign-bare-key-"), "key.hex");
    fs.writeFileSync(keyPath, w.privateKey.slice(2)); // strip the 0x prefix
    const out = path.join(tmp("dsign-bare-out-"), "signed.json");
    const r = await runDatasetSign({ manifest: fx.manifestPath, keyFile: keyPath, out, stdout: () => {} });
    expect(r.signer).to.equal(w.address.toLowerCase());
  });

  it("--json round-trips: prints ONLY public fields (signer, scheme, out) — NEVER the key", async function () {
    const fx = buildManifestFixture(undefined, "dsign-json");
    const w = Wallet.createRandom(); // TEST-ONLY
    setTempEnv("VH_DS_JSON_KEY", w.privateKey);
    const out = path.join(tmp("dsign-jout-"), "signed.json");
    let printed = "";
    await runDatasetSign({
      manifest: fx.manifestPath,
      keyEnv: "VH_DS_JSON_KEY",
      out,
      json: true,
      stdout: (s) => (printed += s),
    });
    const obj = JSON.parse(printed);
    expect(obj.signed).to.equal(true);
    expect(obj.signer).to.equal(w.address.toLowerCase());
    expect(obj.scheme).to.equal("eip191-personal-sign");
    expect(obj.out).to.equal(path.resolve(out));
    // With --out, the bytes live on disk; the JSON `container` field is null (no redundant copy).
    expect(obj.container).to.equal(null);
    expect(JSON.stringify(obj)).to.not.include(w.privateKey);
  });

  it("--json WITHOUT --out NEVER drops the artifact: the canonical signed bytes ride in `container`, and verify-attest ACCEPTS them", async function () {
    const fx = buildManifestFixture(undefined, "dsign-json-noout");
    const w = Wallet.createRandom(); // TEST-ONLY
    setTempEnv("VH_DS_JSON_NOOUT_KEY", w.privateKey);

    let printed = "";
    const r = await runDatasetSign({
      manifest: fx.manifestPath,
      keyEnv: "VH_DS_JSON_NOOUT_KEY",
      // NO --out: the only place the signed container can live is the JSON output itself.
      json: true,
      stdout: (s) => (printed += s),
    });
    const obj = JSON.parse(printed);
    expect(obj.signed).to.equal(true);
    expect(obj.signer).to.equal(w.address.toLowerCase());
    expect(obj.out).to.equal(null);
    // The artifact is NOT dropped: `container` carries the EXACT canonical signed bytes the function built.
    expect(obj.container).to.be.a("string");
    expect(obj.container).to.equal(r.canonical);
    // No key ever leaks into the JSON (the container holds only the PUBLIC signer + signature).
    expect(printed).to.not.include(w.privateKey);
    expect(obj.container).to.not.include(w.privateKey);

    // Round-trip: write the carried bytes to a TEMP file and confirm the EXISTING verify-attest ACCEPTS them.
    const reconstructed = path.join(tmp("dsign-json-noout-rt-"), "signed.json");
    fs.writeFileSync(reconstructed, obj.container);
    const va = runDsVerifyAttest({
      signed: reconstructed,
      manifest: fx.manifestPath,
      signer: w.address,
      stdout: () => {},
    });
    expect(va.accepted).to.equal(true);
    expect(va.recoveredSigner).to.equal(w.address.toLowerCase());
  });

  it("the signed container output never contains the private key (on disk)", async function () {
    const fx = buildManifestFixture(undefined, "dsign-leak");
    const w = Wallet.createRandom(); // TEST-ONLY
    setTempEnv("VH_DS_LEAK_KEY", w.privateKey);
    const out = path.join(tmp("dsign-lout-"), "signed.json");
    await runDatasetSign({ manifest: fx.manifestPath, keyEnv: "VH_DS_LEAK_KEY", out, stdout: () => {} });
    const bytes = fs.readFileSync(out, "utf8");
    expect(bytes).to.not.include(w.privateKey);
    expect(bytes).to.not.include(w.privateKey.slice(2)); // not the bare form either
    expect(bytes).to.include(w.address.toLowerCase()); // does carry the PUBLIC signer
  });

  describe("HARD-ERRORS before signing, and NEVER leak the key", function () {
    it("NEITHER key source: exit 2, no output written", async function () {
      const fx = buildManifestFixture(undefined, "dsign-none");
      const out = path.join(tmp("dsign-none-out-"), "signed.json");
      const code = await cmdDatasetSign([fx.manifestPath, "--out", out]);
      expect(code).to.equal(2);
      expect(fs.existsSync(out)).to.equal(false);
    });

    it("BOTH key sources: exit 2, no output written", async function () {
      const fx = buildManifestFixture(undefined, "dsign-both");
      const w = Wallet.createRandom(); // TEST-ONLY
      setTempEnv("VH_DS_BOTH_KEY", w.privateKey);
      const keyPath = path.join(tmp("dsign-both-key-"), "k.hex");
      fs.writeFileSync(keyPath, w.privateKey);
      const out = path.join(tmp("dsign-both-out-"), "signed.json");
      const code = await cmdDatasetSign([
        fx.manifestPath,
        "--key-env",
        "VH_DS_BOTH_KEY",
        "--key-file",
        keyPath,
        "--out",
        out,
      ]);
      expect(code).to.equal(2);
      expect(fs.existsSync(out)).to.equal(false);
    });

    it("missing env var: throws BEFORE signing, no output, message names only the SOURCE", async function () {
      const fx = buildManifestFixture(undefined, "dsign-missing");
      const out = path.join(tmp("dsign-missing-out-"), "signed.json");
      let threw;
      try {
        await runDatasetSign({ manifest: fx.manifestPath, keyEnv: "VH_DS_UNSET_KEY_XYZ", out, stdout: () => {} });
        threw = null;
      } catch (e) {
        threw = e;
      }
      expect(threw).to.be.an("error");
      expect(threw.message).to.match(/VH_DS_UNSET_KEY_XYZ.*not set|not set.*VH_DS_UNSET_KEY_XYZ/);
      expect(fs.existsSync(out)).to.equal(false);
    });

    it("unreadable key file: throws BEFORE signing, no output, message names the PATH (not the key)", async function () {
      const fx = buildManifestFixture(undefined, "dsign-badfile");
      const out = path.join(tmp("dsign-badfile-out-"), "signed.json");
      let threw;
      try {
        await runDatasetSign({ manifest: fx.manifestPath, keyFile: "/no/such/key.hex", out, stdout: () => {} });
        threw = null;
      } catch (e) {
        threw = e;
      }
      expect(threw).to.be.an("error");
      expect(threw.message).to.include("/no/such/key.hex");
      expect(fs.existsSync(out)).to.equal(false);
    });

    it("a malformed key HARD-ERRORS without writing output and WITHOUT leaking the key value", async function () {
      const fx = buildManifestFixture(undefined, "dsign-malformed");
      const malformed = "definitely-not-a-key-value";
      setTempEnv("VH_DS_MALFORMED_KEY", malformed);
      const out = path.join(tmp("dsign-malformed-out-"), "signed.json");
      let threw;
      try {
        await runDatasetSign({ manifest: fx.manifestPath, keyEnv: "VH_DS_MALFORMED_KEY", out, stdout: () => {} });
        threw = null;
      } catch (e) {
        threw = e;
      }
      expect(threw).to.be.an("error");
      expect(threw.message).to.include("env:VH_DS_MALFORMED_KEY");
      expect(threw.message).to.not.include(malformed);
      expect(fs.existsSync(out)).to.equal(false);
    });

    it("an all-zero key is rejected (not a usable signer), no output, no leak", async function () {
      const fx = buildManifestFixture(undefined, "dsign-zero");
      setTempEnv("VH_DS_ZERO_KEY", "0x" + "00".repeat(32));
      const out = path.join(tmp("dsign-zero-out-"), "signed.json");
      let threw;
      try {
        await runDatasetSign({ manifest: fx.manifestPath, keyEnv: "VH_DS_ZERO_KEY", out, stdout: () => {} });
        threw = null;
      } catch (e) {
        threw = e;
      }
      expect(threw).to.be.an("error");
      expect(threw.message).to.match(/all-zero/);
      expect(fs.existsSync(out)).to.equal(false);
    });
  });

  describe("CLI exit codes + parser parity", function () {
    it("a clean sign via the cmd handler returns exit 0", async function () {
      const fx = buildManifestFixture(undefined, "dsign-cli-ok");
      const w = Wallet.createRandom(); // TEST-ONLY
      setTempEnv("VH_DS_CLI_KEY", w.privateKey);
      const out = path.join(tmp("dsign-cli-out-"), "signed.json");
      let printed = "";
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = (s) => ((printed += s), true);
      let code;
      try {
        code = await cmdDatasetSign([fx.manifestPath, "--key-env", "VH_DS_CLI_KEY", "--out", out]);
      } finally {
        process.stdout.write = orig;
      }
      expect(code).to.equal(0);
      expect(fs.existsSync(out)).to.equal(true);
      expect(printed).to.not.include(w.privateKey);
    });

    it("missing <manifest> is exit 2; a present-but-bad key surfaces as exit 1 (runtime, not usage)", async function () {
      const code2 = await cmdDatasetSign(["--key-env", "VH_DS_X"]);
      expect(code2).to.equal(2);
      const fx = buildManifestFixture(undefined, "dsign-rt");
      setTempEnv("VH_DS_BADV", "nope");
      const out = path.join(tmp("dsign-rt-out-"), "signed.json");
      const code1 = await cmdDatasetSign([fx.manifestPath, "--key-env", "VH_DS_BADV", "--out", out]);
      expect(code1).to.equal(1);
      expect(fs.existsSync(out)).to.equal(false);
    });

    it("parser parity: unknown/incomplete flag, duplicate positional hard-error", function () {
      expect(() => parseSignArgs(["/m", "--bogus"])).to.throw(/unknown flag/);
      expect(() => parseSignArgs(["/m", "/n"])).to.throw(/unexpected extra argument/);
      expect(() => parseSignArgs(["/m", "--key-env"])).to.throw(/--key-env requires a value/);
      expect(() => parseSignArgs(["/m", "--key-file"])).to.throw(/--key-file requires a value/);
      expect(() => parseSignArgs(["/m", "--out"])).to.throw(/--out requires a value/);
    });

    it("a typo'd flag via the cmd handler is exit 2 (a typo never silently signs)", async function () {
      const fx = buildManifestFixture(undefined, "dsign-typo");
      setTempEnv("VH_DS_TYPO_KEY", Wallet.createRandom().privateKey);
      const code = await cmdDatasetSign([fx.manifestPath, "--key-env", "VH_DS_TYPO_KEY", "--nope"]);
      expect(code).to.equal(2);
    });

    it("the SIGN_TRUST_NOTE carries the P-3 posture (NOT a trusted timestamp; key YOU supplied)", function () {
      expect(SIGN_TRUST_NOTE).to.match(/NOT an independent, trusted TIMESTAMP/);
      expect(SIGN_TRUST_NOTE).to.include("P-3");
      expect(SIGN_TRUST_NOTE).to.match(/key YOU supplied/);
    });
  });

  it("leaves ZERO key files / signed containers in the repo working tree (all side effects in temp dirs)", function () {
    expect(fs.existsSync(path.join(process.cwd(), "signed.json"))).to.equal(false);
    expect(fs.existsSync(path.join(process.cwd(), "key.hex"))).to.equal(false);
    expect(fs.existsSync(path.join(process.cwd(), "manifest.json"))).to.equal(false);
  });
});

// =====================================================================================================
// verify-timestamp (T-20.3) — the OFFLINE independent-timestamp verifier for DataLedger. ==============
//   These prove a MINTED-token container (test-only mock TSA, ephemeral genTime, NO real TSA, NO network)
//   verifies ACCEPTED and reports the asserted genTime/serial/policy; that `--manifest` binds to the
//   buyer's OWN data (a DIFFERENT manifest REJECTS); that a tampered token, a mismatched digest, and an
//   EDITED embedded attestation each REJECT with the family's 3-exit; that `--json` round-trips; and that
//   the offline verify needs no network. The suite isolates every side effect to a throwaway temp dir.
// =====================================================================================================

const crypto = require("crypto");
const {
  runDatasetBuild: rdtBuild,
  readManifest: rdtReadManifest,
  buildAttestation: rdtBuildAttestation,
  serializeAttestation: rdtSerializeAttestation,
  buildTimestampedAttestation: rdtBuildTimestamped,
  serializeTimestampedAttestation: rdtSerializeTimestamped,
  runDatasetVerifyTimestamp,
  verifyTimestampedAttestation,
  VERIFY_TIMESTAMP_TRUST_NOTE,
  TRUST_NOTE: RDT_TRUST_NOTE,
} = require("../cli/dataset");
const { OID: RDT_OID } = require("../cli/core/rfc3161");
const { main: vhMain, cmdDatasetVerifyTimestamp, parseVerifyTimestampArgs } = require("../cli/vh");

// ---- TEST-ONLY DER token minter (mock TSA; NO real TSA, NO key, NO funds, NO network). --------------
// The timestamp analogue of Wallet.createRandom(): it stamps a chosen SHA-256 digest into a minimal,
// valid RFC-3161 TimeStampToken. Defined HERE on the test surface only — never on a command path.
function tsDerLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  let x = n;
  while (x > 0) {
    b.unshift(x & 0xff);
    x = Math.floor(x / 256);
  }
  return Buffer.from([0x80 | b.length, ...b]);
}
function tsTlv(tag, v) {
  v = Buffer.isBuffer(v) ? v : Buffer.from(v);
  return Buffer.concat([Buffer.from([tag]), tsDerLen(v.length), v]);
}
const tsSeq = (...p) => tsTlv(0x30, Buffer.concat(p));
const tsSet = (...p) => tsTlv(0x31, Buffer.concat(p));
const tsOct = (v) => tsTlv(0x04, v);
const tsCtx0 = (v) => tsTlv(0xa0, v);
function tsInt(v) {
  let big = BigInt(v);
  let h = big.toString(16);
  if (h.length % 2) h = "0" + h;
  let by = Buffer.from(h, "hex");
  if (by.length === 0) by = Buffer.from([0]);
  if (by[0] & 0x80) by = Buffer.concat([Buffer.from([0]), by]);
  return tsTlv(0x02, by);
}
function tsOid(d) {
  const a = d.split(".").map((s) => parseInt(s, 10));
  const o = [40 * a[0] + a[1]];
  for (let i = 2; i < a.length; i++) {
    let v = a[i];
    const s = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) {
      s.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    o.push(...s);
  }
  return tsTlv(0x06, Buffer.from(o));
}
const tsGt = (s) => tsTlv(0x18, Buffer.from(s, "ascii"));
function mintTestToken(opts = {}) {
  const digestHex = (opts.digestHex || "").replace(/^0x/i, "").toLowerCase();
  const hashOID = opts.hashOID || RDT_OID.sha256;
  const genTime = opts.genTime || "20260623120000Z";
  const serial = opts.serial !== undefined ? opts.serial : 42;
  const policyOID = opts.policyOID || "1.2.3.4.5";
  const ha = tsSeq(tsOid(hashOID), Buffer.from([0x05, 0x00]));
  const mi = tsSeq(ha, tsOct(Buffer.from(digestHex, "hex")));
  const ti = tsSeq(tsInt(1), tsOid(policyOID), mi, tsInt(serial), tsGt(genTime));
  const encap = tsSeq(tsOid(RDT_OID.tstInfo), tsCtx0(tsOct(ti)));
  const sd = tsSeq(tsInt(3), tsSet(tsSeq(tsOid(hashOID), Buffer.from([0x05, 0x00]))), encap);
  return tsSeq(tsOid(RDT_OID.signedData), tsCtx0(sd));
}

describe("cli: vh dataset verify-timestamp (T-20.3) — OFFLINE independent-timestamp verifier", function () {
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

  async function capture(fn) {
    const orig = process.stdout.write.bind(process.stdout);
    let buf = "";
    process.stdout.write = (s) => {
      buf += s;
      return true;
    };
    try {
      const ret = await fn();
      return { ret, out: buf };
    } finally {
      process.stdout.write = orig;
    }
  }

  // Build a dataset + its timestamped container over a MINTED token bound to the canonical sha256 digest.
  function fixture(files, prefix, tokenOpts) {
    const tree = tmp((prefix || "vt") + "-tree-");
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(tree, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    const manifestPath = path.join(tmp((prefix || "vt") + "-man-"), "manifest.json");
    rdtBuild({ dir: tree, out: manifestPath, stdout: () => {} });
    const manifest = rdtReadManifest(manifestPath);
    const unsigned = rdtBuildAttestation(manifest);
    const canonical = rdtSerializeAttestation(unsigned);
    const digest = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
    const token = mintTestToken({ digestHex: digest, ...(tokenOpts || {}) });
    const container = rdtBuildTimestamped({ attestation: unsigned, token });
    const containerPath = path.join(tmp((prefix || "vt") + "-c-"), "ts.json");
    fs.writeFileSync(containerPath, rdtSerializeTimestamped(container));
    return { tree, manifestPath, manifest, unsigned, canonical, digest, container, containerPath };
  }

  it("a MINTED-token container verifies ACCEPTED and reports the asserted genTime/serial/policy", async function () {
    const f = fixture({ "a.txt": "AAA", "b.txt": "BBB" }, "ok", {
      genTime: "20260101000000Z",
      serial: 12345,
      policyOID: "1.3.6.1.4.1.13762.3",
    });
    const { ret, out } = await capture(() =>
      runDatasetVerifyTimestamp({ container: f.containerPath })
    );
    expect(ret.verdict).to.equal("ACCEPTED");
    expect(ret.accepted).to.equal(true);
    expect(ret.checks.structureAndBinding).to.equal(true);
    expect(ret.checks.manifestBindsAttestation).to.equal(null); // not requested
    expect(ret.genTime).to.equal("2026-01-01T00:00:00Z");
    expect(ret.serialNumber.decimal).to.equal("12345");
    expect(ret.policyOID).to.equal("1.3.6.1.4.1.13762.3");
    expect(ret.digest).to.equal(f.digest);
    // Human output LEADS with the bounded claim and reports the asserted facts.
    expect(out).to.include("ACCEPTED means an RFC-3161");
    expect(out).to.include("verify-timestamp: ACCEPTED");
    expect(out).to.include("2026-01-01T00:00:00Z");
  });

  it("the exit code is 0 on ACCEPTED via the cmd handler (the family's 0/3 gate convention)", async function () {
    const f = fixture({ "x.txt": "X" }, "exit0");
    const { ret } = await capture(() => cmdDatasetVerifyTimestamp([f.containerPath]));
    expect(ret).to.equal(0);
  });

  describe("--manifest binds the timestamp to the buyer's OWN data", function () {
    it("the SAME manifest ACCEPTS with the binding check PASS", async function () {
      const f = fixture({ "a.txt": "AAA", "b.txt": "BBB" }, "bind-ok");
      const { ret } = await capture(() =>
        runDatasetVerifyTimestamp({ container: f.containerPath, manifest: f.manifestPath })
      );
      expect(ret.accepted).to.equal(true);
      expect(ret.manifestChecked).to.equal(true);
      expect(ret.checks.manifestBindsAttestation).to.equal(true);
    });

    it("a DIFFERENT manifest REJECTS (the token stamped a different dataset identity)", async function () {
      const f = fixture({ "a.txt": "AAA", "b.txt": "BBB" }, "bind-diff");
      // A different dataset -> a different manifest -> different canonical bytes.
      const other = fixture({ "a.txt": "DIFFERENT", "b.txt": "BBB" }, "bind-other");
      const { ret } = await capture(() =>
        runDatasetVerifyTimestamp({ container: f.containerPath, manifest: other.manifestPath })
      );
      expect(ret.accepted).to.equal(false);
      expect(ret.verdict).to.equal("REJECTED");
      expect(ret.checks.structureAndBinding).to.equal(true); // structure is fine; only the binding fails
      expect(ret.checks.manifestBindsAttestation).to.equal(false);
      expect(ret.failedChecks).to.deep.equal(["manifestBindsAttestation"]);
    });

    it("a DIFFERENT manifest is exit 3 via the cmd handler", async function () {
      const f = fixture({ "a.txt": "AAA" }, "bind-exit");
      const other = fixture({ "a.txt": "CHANGED" }, "bind-exit-other");
      const { ret } = await capture(() =>
        cmdDatasetVerifyTimestamp([f.containerPath, "--manifest", other.manifestPath])
      );
      expect(ret).to.equal(3);
    });
  });

  describe("a tampered token / mismatched digest / edited embedded attestation each REJECT (3-exit)", function () {
    it("a token that binds a DIFFERENT digest REJECTS (the recorded digest is rewritten to match the bytes)", async function () {
      const f = fixture({ "a.txt": "AAA" }, "tok-diff");
      // Mint a token over a DIFFERENT digest, then write a container whose recorded digest matches the
      // bytes but whose TOKEN stamps something else — the bindsDigest check must fail.
      const wrongToken = mintTestToken({ digestHex: "c".repeat(64), genTime: "20260101000000Z" });
      const obj = JSON.parse(fs.readFileSync(f.containerPath, "utf8"));
      obj.timestamp.token = require("../cli/core/rfc3161")._internal.toBuf(wrongToken).toString("base64");
      // recorded digest stays = sha256(bytes); only the token disagrees.
      const p = path.join(tmp("tok-diff-c-"), "c.json");
      fs.writeFileSync(p, JSON.stringify(obj));
      const { ret } = await capture(() => runDatasetVerifyTimestamp({ container: p }));
      expect(ret.accepted).to.equal(false);
      expect(ret.checks.structureAndBinding).to.equal(false);
      expect(ret.failedChecks).to.deep.equal(["structureAndBinding"]);
      expect(ret.reason).to.match(/does NOT bind|messageImprint/i);
    });

    it("a mismatched recorded digest (!= sha256(bytes)) REJECTS", async function () {
      const f = fixture({ "a.txt": "AAA" }, "dig-mismatch");
      const obj = JSON.parse(fs.readFileSync(f.containerPath, "utf8"));
      obj.timestamp.digest = "d".repeat(64);
      const p = path.join(tmp("dig-c-"), "c.json");
      fs.writeFileSync(p, JSON.stringify(obj));
      const { ret } = await capture(() => cmdDatasetVerifyTimestamp([p]));
      expect(ret).to.equal(3);
    });

    it("an EDITED embedded attestation REJECTS (wrap-don't-edit: the bytes no longer round-trip)", async function () {
      const f = fixture({ "a.txt": "AAA", "b.txt": "BBB" }, "edit");
      const obj = JSON.parse(fs.readFileSync(f.containerPath, "utf8"));
      // Tamper the embedded canonical bytes (flip a hex char in the root) — no longer canonical/binding.
      const edited = JSON.parse(obj.attestation);
      edited.root = "0x" + "0".repeat(64);
      obj.attestation = JSON.stringify(edited);
      const p = path.join(tmp("edit-c-"), "c.json");
      fs.writeFileSync(p, JSON.stringify(obj));
      const { ret, out } = await capture(() =>
        runDatasetVerifyTimestamp({ container: p })
      );
      expect(ret.accepted).to.equal(false);
      expect(ret.checks.structureAndBinding).to.equal(false);
      expect(out).to.include("verify-timestamp: REJECTED");
    });

    it("a wrong-kind container (a DATASET reader given some other JSON) REJECTS, never throws to the user", async function () {
      const p = path.join(tmp("wrong-kind-"), "c.json");
      fs.writeFileSync(p, JSON.stringify({ kind: "verifyhash.something-else", schemaVersion: 1 }));
      const { ret } = await capture(() => cmdDatasetVerifyTimestamp([p]));
      expect(ret).to.equal(3); // clean named REJECTED, NOT a runtime error (1)
    });
  });

  describe("--json round-trips the verdict", function () {
    it("ACCEPTED --json parses and carries the asserted facts + per-check booleans", async function () {
      const f = fixture({ "a.txt": "AAA" }, "json-ok", { serial: 99, genTime: "20251231235959Z" });
      const { out } = await capture(() =>
        runDatasetVerifyTimestamp({ container: f.containerPath, manifest: f.manifestPath, json: true })
      );
      const parsed = JSON.parse(out);
      expect(parsed.verdict).to.equal("ACCEPTED");
      expect(parsed.accepted).to.equal(true);
      expect(parsed.checks.structureAndBinding).to.equal(true);
      expect(parsed.checks.manifestBindsAttestation).to.equal(true);
      expect(parsed.genTime).to.equal("2025-12-31T23:59:59Z");
      expect(parsed.serialNumber.decimal).to.equal("99");
      expect(parsed.digest).to.equal(f.digest);
    });

    it("REJECTED --json carries failedChecks + a reason", async function () {
      const f = fixture({ "a.txt": "AAA" }, "json-rej");
      const obj = JSON.parse(fs.readFileSync(f.containerPath, "utf8"));
      obj.timestamp.digest = "e".repeat(64);
      const p = path.join(tmp("json-rej-c-"), "c.json");
      fs.writeFileSync(p, JSON.stringify(obj));
      const { out } = await capture(() => runDatasetVerifyTimestamp({ container: p, json: true }));
      const parsed = JSON.parse(out);
      expect(parsed.verdict).to.equal("REJECTED");
      expect(parsed.failedChecks).to.deep.equal(["structureAndBinding"]);
      expect(parsed.reason).to.be.a("string").and.have.length.greaterThan(0);
    });
  });

  describe("bounded, honest trust claim (never a false 'unaltered since T')", function () {
    it("the TRUST_NOTE states what ACCEPTED means + disavows the cert chain, and reuses the dataset TRUST_NOTE", function () {
      expect(VERIFY_TIMESTAMP_TRUST_NOTE).to.match(/ACCEPTED means an RFC-3161/);
      expect(VERIFY_TIMESTAMP_TRUST_NOTE).to.match(/does NOT validate the TSA's certificate chain/);
      expect(VERIFY_TIMESTAMP_TRUST_NOTE).to.match(/openssl ts -verify/);
      expect(VERIFY_TIMESTAMP_TRUST_NOTE).to.match(/NEVER claims "unaltered since date T"/);
      // Reuses the shared dataset TRUST_NOTE verbatim so caveats never drift.
      expect(VERIFY_TIMESTAMP_TRUST_NOTE).to.include(RDT_TRUST_NOTE);
    });
  });

  describe("usage / parser parity (a typo never silently passes)", function () {
    it("a missing <container> is a usage error (exit 2)", async function () {
      const { ret } = await capture(() => cmdDatasetVerifyTimestamp([]));
      expect(ret).to.equal(2);
    });
    it("an unknown flag is a usage error (exit 2)", async function () {
      const f = fixture({ "a.txt": "AAA" }, "typo");
      const { ret } = await capture(() => cmdDatasetVerifyTimestamp([f.containerPath, "--nope"]));
      expect(ret).to.equal(2);
    });
    it("a duplicate positional hard-errors in the parser", function () {
      expect(() => parseVerifyTimestampArgs(["a", "b"])).to.throw(/extra argument/);
    });
    it("a missing/corrupt container FILE is a runtime error (exit 1), distinct from a clean REJECT", async function () {
      const { ret } = await capture(() =>
        cmdDatasetVerifyTimestamp([path.join(os.tmpdir(), "definitely-missing-vt.json")])
      );
      expect(ret).to.equal(1);
    });
  });

  it("the offline verify needs no network (works against a temp file with no provider/RPC env)", async function () {
    const f = fixture({ "a.txt": "AAA" }, "offline");
    const savedRpc = process.env.VH_RPC_URL;
    delete process.env.VH_RPC_URL;
    try {
      const { ret } = await capture(() => runDatasetVerifyTimestamp({ container: f.containerPath }));
      expect(ret.accepted).to.equal(true);
    } finally {
      if (savedRpc !== undefined) process.env.VH_RPC_URL = savedRpc;
    }
  });

  it("the suite leaves ZERO timestamped containers in the repo working tree (all side effects in temp)", function () {
    expect(fs.existsSync(path.join(process.cwd(), "ts.json"))).to.equal(false);
    expect(fs.existsSync(path.join(process.cwd(), "attestation.timestamped.json"))).to.equal(false);
  });

  it("verifyTimestampedAttestation is PURE (no I/O) over an already-parsed container", function () {
    const f = fixture({ "a.txt": "AAA" }, "pure");
    const obj = JSON.parse(fs.readFileSync(f.containerPath, "utf8"));
    const r = verifyTimestampedAttestation({ container: obj });
    expect(r.accepted).to.equal(true);
  });
});

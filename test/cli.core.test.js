"use strict";

// test/cli.core.test.js — DIRECT coverage of the GENERIC provenance engine in cli/core/.
//
// WHY THIS SUITE EXISTS (T-18.1)
//   cli/core/manifest.js and cli/core/attestation.js are the product-agnostic core BOTH DataLedger and
//   ProofParcel depend on. The existing dataset/attest/verify-attest suites already exercise this code
//   THROUGH DataLedger's thin wrappers; this suite exercises the core DIRECTLY — and, crucially, with a
//   SECOND, non-DataLedger product config (a synthetic "ProofParcel-like" framing) — to PROVE the core
//   is genuinely parameterized by `kind`/`note`/`label` and shares ONE implementation across products.
//
//   It covers: the manifest builder/validator round-trip + every validation-rejection case the dataset
//   tests assert (now at the core layer, against a DIFFERENT kind/label, so the parameterization is
//   real); the signed-attestation envelope round-trip; the wrap-don't-edit invariant; the supported
//   scheme list; and a REAL signer-recovery round-trip using an EPHEMERAL, TEST-ONLY Wallet.createRandom()
//   key (NEVER persisted, NEVER a real-funds key, NO network, NO provider anywhere).
//
//   Filesystem hygiene: every test that touches disk writes ONLY under a throwaway temp dir created with
//   fs.mkdtempSync and removes it in afterEach — pass or fail, no artifacts leak into the working tree.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Wallet } = require("ethers");

const { hashDirStream, pathLeaf } = require("../cli/hash");
const coreManifest = require("../cli/core/manifest");
const coreAttestation = require("../cli/core/attestation");

describe("cli/core: generic provenance engine (T-18.1)", function () {
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
    const dir = tmp((prefix || "core") + "-tree-");
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(dir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return dir;
  }

  // A SECOND product config that is NOT DataLedger: a synthetic "ProofParcel-like" framing with its OWN
  // kind, note, and label. Using this throughout proves the core is parameterized — not hard-wired to the
  // dataset strings — while DataLedger's own byte-for-byte behaviour is locked by the dataset suites.
  const PP_NOTE = "ProofParcel delivery note — " + coreManifest.TRUST_NOTE;
  const PP_MANIFEST_CFG = Object.freeze({
    kind: "verifyhash.proofparcel-manifest",
    schemaVersion: 1,
    supportedSchemaVersions: [1],
    note: PP_NOTE,
    label: "delivery manifest",
  });

  // ---------------------------------------------------------------------------------------------------
  // SHARED TRUST_NOTE — lives in EXACTLY ONE place and is what DataLedger imports.
  // ---------------------------------------------------------------------------------------------------
  describe("shared TRUST_NOTE", function () {
    it("is exported from the core and is the SAME object the dataset adapter re-exports", function () {
      const dataset = require("../cli/dataset");
      expect(typeof coreManifest.TRUST_NOTE).to.equal("string");
      expect(coreManifest.TRUST_NOTE.length).to.be.greaterThan(40);
      // DataLedger's TRUST_NOTE must be IMPORTED from core (not a copy) so the caveats can never drift.
      expect(dataset.TRUST_NOTE).to.equal(coreManifest.TRUST_NOTE);
    });
    it("HEX32_RE is exported and matches a 0x 32-byte hex string (and rejects junk)", function () {
      expect(coreManifest.HEX32_RE.test("0x" + "ab".repeat(32))).to.equal(true);
      expect(coreManifest.HEX32_RE.test("0xnothex")).to.equal(false);
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // buildItemManifest / validateItemManifest — round-trip + the rejection cases, against a NON-dataset cfg.
  // ---------------------------------------------------------------------------------------------------
  describe("buildItemManifest + validateItemManifest", function () {
    function built(files, prefix) {
      return hashDirStream(writeTree(files, prefix));
    }

    it("builds a valid manifest carrying the product's OWN kind/note (not dataset's)", function () {
      const m = coreManifest.buildItemManifest(built({ "a.txt": "AAA", "b.txt": "BBB" }), PP_MANIFEST_CFG);
      expect(m.kind).to.equal("verifyhash.proofparcel-manifest");
      expect(m.note).to.equal(PP_NOTE);
      expect(m.schemaVersion).to.equal(1);
      expect(m.fileCount).to.equal(2);
      expect(m.files).to.have.length(2);
      // The per-file leaf is the SAME path-bound digest the contract/`vh hash` use.
      for (const f of m.files) {
        expect(f.leaf.toLowerCase()).to.equal(pathLeaf(f.relPath, f.contentHash).toLowerCase());
      }
      // It validates under its own cfg and is returned unchanged.
      expect(coreManifest.validateItemManifest(m, PP_MANIFEST_CFG)).to.equal(m);
    });

    it("attaches normalized untrusted hints inline (and only labeled string fields)", function () {
      const m = coreManifest.buildItemManifest(built({ "a.txt": "AAA" }, "hints"), PP_MANIFEST_CFG, {
        hints: { "a.txt": { source: "vendorX", license: "MIT", junk: "dropped" } },
      });
      expect(m.files[0].hints).to.deep.equal({ source: "vendorX", license: "MIT" });
    });

    it("rejects a hint for a path not in the tree, and a non-string hint value", function () {
      const b = built({ "a.txt": "AAA" }, "hint-bad");
      expect(() =>
        coreManifest.buildItemManifest(b, PP_MANIFEST_CFG, { hints: { "nope.txt": { license: "MIT" } } })
      ).to.throw(/hint for unknown path/);
      expect(() =>
        coreManifest.buildItemManifest(b, PP_MANIFEST_CFG, { hints: { "a.txt": { license: 42 } } })
      ).to.throw(/hint license for .* must be a string/);
    });

    it("uses the product's LABEL in error strings (a foreign kind is rejected by THIS product's name)", function () {
      const m = coreManifest.buildItemManifest(built({ "a.txt": "AAA" }, "kind"), PP_MANIFEST_CFG);
      const wrong = { ...m, kind: "verifyhash.dataset-manifest" };
      expect(() => coreManifest.validateItemManifest(wrong, PP_MANIFEST_CFG)).to.throw(
        /not a verifyhash delivery manifest/
      );
    });

    it("rejects: bad schemaVersion, non-hex root, non-hex contentHash, tampered leaf, empty/dup relPath, fileCount mismatch", function () {
      const m = coreManifest.buildItemManifest(
        built({ "a.txt": "AAA", "b.txt": "BBB" }, "rej"),
        PP_MANIFEST_CFG
      );
      const clone = () => JSON.parse(JSON.stringify(m));

      let bad = clone();
      bad.schemaVersion = 99;
      expect(() => coreManifest.validateItemManifest(bad, PP_MANIFEST_CFG)).to.throw(/schemaVersion/);

      bad = clone();
      bad.root = "0xnothex";
      expect(() => coreManifest.validateItemManifest(bad, PP_MANIFEST_CFG)).to.throw(
        /root must be a 0x-prefixed 32-byte hex/
      );

      bad = clone();
      bad.files[0].contentHash = "0xshort";
      expect(() => coreManifest.validateItemManifest(bad, PP_MANIFEST_CFG)).to.throw(
        /contentHash must be a 0x-prefixed 32-byte hex/
      );

      // A leaf edited independently of relPath/contentHash is caught by the self-consistency check.
      bad = clone();
      bad.files[0].leaf = "0x" + "00".repeat(32);
      expect(() => coreManifest.validateItemManifest(bad, PP_MANIFEST_CFG)).to.throw(/leaf is inconsistent/);

      bad = clone();
      bad.files[0].relPath = "";
      expect(() => coreManifest.validateItemManifest(bad, PP_MANIFEST_CFG)).to.throw(
        /relPath must be a non-empty string/
      );

      bad = clone();
      bad.files[1].relPath = bad.files[0].relPath; // duplicate
      expect(() => coreManifest.validateItemManifest(bad, PP_MANIFEST_CFG)).to.throw(/duplicate relPath/);

      bad = clone();
      bad.fileCount = 99;
      expect(() => coreManifest.validateItemManifest(bad, PP_MANIFEST_CFG)).to.throw(/fileCount/);

      bad = clone();
      bad.files = [];
      expect(() => coreManifest.validateItemManifest(bad, PP_MANIFEST_CFG)).to.throw(/non-empty/);
    });

    it("rejects a config missing required fields (defends the core against a malformed adapter)", function () {
      const b = built({ "a.txt": "AAA" }, "cfg");
      expect(() => coreManifest.buildItemManifest(b, { schemaVersion: 1, supportedSchemaVersions: [1] })).to.throw(
        /non-empty string `kind`/
      );
      expect(() => coreManifest.buildItemManifest(b, { kind: "x", supportedSchemaVersions: [] })).to.throw(
        /non-empty `supportedSchemaVersions`/
      );
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // Signed-attestation ENVELOPE — round-trip, wrap-don't-edit, scheme list, and a REAL ephemeral-key sign.
  //
  // The core needs an UNSIGNED-payload codec (validate + serialize) injected by the product. We build a
  // minimal but FAITHFUL one here (a tiny "unsigned" object with the signed:false/signature:null marker
  // and a canonical serializer), so the core's wrap-don't-edit invariant is exercised end to end without
  // depending on DataLedger's specific payload shape.
  // ---------------------------------------------------------------------------------------------------
  describe("signed-attestation envelope", function () {
    function validateUnsigned(o) {
      if (o == null || typeof o !== "object" || Array.isArray(o)) throw new Error("unsigned must be an object");
      if (o.kind !== "test.unsigned") throw new Error("not a test unsigned payload");
      if (o.signed !== false) throw new Error("unsigned signed must be false");
      if (o.signature !== null) throw new Error("unsigned signature must be null");
      if (typeof o.root !== "string" || !coreManifest.HEX32_RE.test(o.root)) {
        throw new Error("unsigned root must be 0x 32-byte hex");
      }
      return o;
    }
    function serializeUnsigned(o) {
      validateUnsigned(o);
      return JSON.stringify({ kind: o.kind, root: o.root, signed: o.signed, signature: o.signature }) + "\n";
    }
    const PP_SIGNED_NOTE = "ProofParcel signed delivery receipt — " + coreManifest.TRUST_NOTE;
    const SIGNED_CFG = Object.freeze({
      kind: "verifyhash.proofparcel-receipt-signed",
      schemaVersion: 1,
      supportedSchemaVersions: [1],
      note: PP_SIGNED_NOTE,
      label: "signed delivery receipt",
      validateUnsigned,
      serializeUnsigned,
    });
    const unsigned = () => ({ kind: "test.unsigned", root: "0x" + "11".repeat(32), signed: false, signature: null });

    // A representative, structurally valid detached signature triple (NOT a real signature for the
    // validate/serialize-shape tests; the recovery round-trip below uses a REAL ephemeral key).
    const SIGNER = "0x" + "ab".repeat(20);
    const SIG65 = "0x" + "cd".repeat(65);
    const goodSig = () => ({ scheme: "eip191-personal-sign", signer: SIGNER, signature: SIG65 });

    it("exports the shared scheme list (eip191-personal-sign)", function () {
      expect(coreAttestation.SIGNED_ATTESTATION_SCHEMES).to.deep.equal(["eip191-personal-sign"]);
    });

    it("round-trips: build -> serialize -> read (via disk) -> deep-equal, with the product's OWN kind/note", function () {
      const container = coreAttestation.buildSignedAttestation(
        { attestation: unsigned(), ...goodSig() },
        SIGNED_CFG
      );
      expect(container.kind).to.equal("verifyhash.proofparcel-receipt-signed");
      expect(container.note).to.equal(PP_SIGNED_NOTE);
      // The embedded payload is the EXACT canonical bytes (a string), preserved through serialize+read.
      expect(container.attestation).to.equal(serializeUnsigned(unsigned()));

      const dir = tmp("signed-rt-");
      const p = path.join(dir, "receipt.json");
      fs.writeFileSync(p, coreAttestation.serializeSignedAttestation(container, SIGNED_CFG));
      const readBack = coreAttestation.readSignedAttestation(p, SIGNED_CFG);
      expect(readBack).to.deep.equal(container);
    });

    it("serialization is byte-deterministic (two runs over the same inputs are identical)", function () {
      const c = coreAttestation.buildSignedAttestation({ attestation: unsigned(), ...goodSig() }, SIGNED_CFG);
      expect(coreAttestation.serializeSignedAttestation(c, SIGNED_CFG)).to.equal(
        coreAttestation.serializeSignedAttestation(c, SIGNED_CFG)
      );
    });

    it("WRAP-DON'T-EDIT: rejects an embedded payload that is itself 'signed' or not canonical", function () {
      const c = coreAttestation.buildSignedAttestation({ attestation: unsigned(), ...goodSig() }, SIGNED_CFG);
      // Smuggle a 'signed' embedded payload: re-validation must reject it (the wrap can never edit it).
      const tampered = { ...c, attestation: JSON.stringify({ kind: "test.unsigned", root: "0x" + "11".repeat(32), signed: true, signature: "0xdead" }) + "\n" };
      expect(() => coreAttestation.validateSignedAttestation(tampered, SIGNED_CFG)).to.throw(
        /unsigned signed must be false/
      );
      // A non-canonical embedded string (extra whitespace) is rejected even if it parses to a valid payload.
      const nonCanon = { ...c, attestation: "  " + c.attestation };
      expect(() => coreAttestation.validateSignedAttestation(nonCanon, SIGNED_CFG)).to.throw(
        /not in canonical form/
      );
    });

    it("rejects: wrong kind/schemaVersion/note, unknown scheme, mixed-case signer/signature, wrong sig length", function () {
      const c = coreAttestation.buildSignedAttestation({ attestation: unsigned(), ...goodSig() }, SIGNED_CFG);
      const clone = () => JSON.parse(JSON.stringify(c));

      expect(() => coreAttestation.validateSignedAttestation({ ...clone(), kind: "x" }, SIGNED_CFG)).to.throw(
        /not a verifyhash signed delivery receipt/
      );
      expect(() => coreAttestation.validateSignedAttestation({ ...clone(), schemaVersion: 9 }, SIGNED_CFG)).to.throw(
        /schemaVersion/
      );
      expect(() => coreAttestation.validateSignedAttestation({ ...clone(), note: "drifted" }, SIGNED_CFG)).to.throw(
        /note must be the standing/
      );

      let bad = clone();
      bad.signature.scheme = "rsa-pkcs1";
      expect(() => coreAttestation.validateSignedAttestation(bad, SIGNED_CFG)).to.throw(/unknown signature scheme/);

      bad = clone();
      bad.signature.signer = "0x" + "AB".repeat(20); // mixed/upper case
      expect(() => coreAttestation.validateSignedAttestation(bad, SIGNED_CFG)).to.throw(/LOWERCASE-hex address/);

      bad = clone();
      bad.signature.signature = "0x" + "CD".repeat(65); // upper case
      expect(() => coreAttestation.validateSignedAttestation(bad, SIGNED_CFG)).to.throw(/LOWERCASE-hex string/);

      bad = clone();
      bad.signature.signature = "0x" + "cd".repeat(10); // too short for eip191
      expect(() => coreAttestation.validateSignedAttestation(bad, SIGNED_CFG)).to.throw(/65-byte/);
    });

    it("readSignedAttestation: clear errors for a missing file and invalid JSON", function () {
      const dir = tmp("signed-io-");
      expect(() => coreAttestation.readSignedAttestation(path.join(dir, "nope.json"), SIGNED_CFG)).to.throw(
        /cannot read signed delivery receipt/
      );
      const p = path.join(dir, "bad.json");
      fs.writeFileSync(p, "{ not json");
      expect(() => coreAttestation.readSignedAttestation(p, SIGNED_CFG)).to.throw(/is not valid JSON/);
    });

    // -------------------------------------------------------------------------------------------------
    // REAL signer recovery with an EPHEMERAL, TEST-ONLY key. This is the ONLY place the suite signs
    // anything: Wallet.createRandom() mints a throwaway secp256k1 key in-memory. It is NEVER persisted,
    // NEVER a real-funds key, and there is NO network / NO provider. It exists solely to produce a
    // genuine eip191-personal-sign signature so the core's recovery + verify gate is honestly exercised.
    // -------------------------------------------------------------------------------------------------
    describe("recoverSigner + verifySignedAttestation (ephemeral TEST-ONLY key — NO network, NO real funds)", function () {
      async function signedFixture() {
        const u = unsigned();
        const canonical = serializeUnsigned(u);
        const wallet = Wallet.createRandom(); // EPHEMERAL, in-memory, test-only — never persisted.
        const signature = await wallet.signMessage(canonical); // EIP-191 personal_sign over the EXACT bytes.
        const container = coreAttestation.buildSignedAttestation(
          { attestation: u, scheme: "eip191-personal-sign", signer: wallet.address.toLowerCase(), signature },
          SIGNED_CFG
        );
        return { container, address: wallet.address.toLowerCase(), canonical };
      }

      it("recovers the genuine signer and ACCEPTS a real signature", async function () {
        const { container, address } = await signedFixture();
        expect(coreAttestation.recoverSigner(container)).to.equal(address);
        const r = coreAttestation.verifySignedAttestation({ container });
        expect(r.verdict).to.equal("ACCEPTED");
        expect(r.accepted).to.equal(true);
        expect(r.recoveredSigner).to.equal(address);
        expect(r.checks.signatureMatchesSigner).to.equal(true);
        expect(r.checks.signerMatchesExpected).to.equal(null); // not requested
        expect(r.checks.manifestBindsAttestation).to.equal(null); // not requested
      });

      it("pins the expected signer (PASS for the real signer, FAIL — REJECTED — for another address)", async function () {
        const { container, address } = await signedFixture();
        const ok = coreAttestation.verifySignedAttestation({ container, expectedSigner: address });
        expect(ok.verdict).to.equal("ACCEPTED");
        expect(ok.checks.signerMatchesExpected).to.equal(true);

        const other = Wallet.createRandom().address; // different ephemeral address, EIP-55 checksummed
        const bad = coreAttestation.verifySignedAttestation({ container, expectedSigner: other });
        expect(bad.verdict).to.equal("REJECTED");
        expect(bad.checks.signerMatchesExpected).to.equal(false);
        expect(bad.failedChecks).to.include("signerMatchesExpected");
      });

      it("binds the caller's own canonical bytes (PASS when identical, REJECTED when they differ)", async function () {
        const { container, canonical } = await signedFixture();
        const ok = coreAttestation.verifySignedAttestation({ container, expectedCanonical: canonical });
        expect(ok.verdict).to.equal("ACCEPTED");
        expect(ok.checks.manifestBindsAttestation).to.equal(true);
        expect(ok.manifestChecked).to.equal(true);

        const otherCanonical = serializeUnsigned({ kind: "test.unsigned", root: "0x" + "22".repeat(32), signed: false, signature: null });
        const bad = coreAttestation.verifySignedAttestation({ container, expectedCanonical: otherCanonical });
        expect(bad.verdict).to.equal("REJECTED");
        expect(bad.checks.manifestBindsAttestation).to.equal(false);
        expect(bad.failedChecks).to.include("manifestBindsAttestation");
      });

      it("a tampered (unrecoverable/mismatched) signature is a clean REJECTED, not a crash", async function () {
        const { container } = await signedFixture();
        // Flip the signature to a structurally valid but wrong/garbage 65-byte value.
        const tampered = JSON.parse(JSON.stringify(container));
        tampered.signature.signature = "0x" + "00".repeat(65);
        // It must still be a structurally valid container (shape passes) ...
        coreAttestation.validateSignedAttestation(tampered, SIGNED_CFG);
        // ... but recovery does NOT match the claimed signer -> REJECTED (a normal verdict, no throw).
        const r = coreAttestation.verifySignedAttestation({ container: tampered });
        expect(r.verdict).to.equal("REJECTED");
        expect(r.checks.signatureMatchesSigner).to.equal(false);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------------
  // NO back-edge: cli/core must NEVER require a product module. This guards the dependency direction
  // (product -> core, never the reverse) so the core stays genuinely shared and reusable.
  // ---------------------------------------------------------------------------------------------------
  describe("dependency hygiene", function () {
    it("cli/core/*.js contain no require(\"../dataset\") back-edge", function () {
      for (const f of ["manifest.js", "attestation.js"]) {
        const src = fs.readFileSync(path.join(__dirname, "..", "cli", "core", f), "utf8");
        // Strip block AND line comments so an illustrative `require("../dataset")` mentioned in prose
        // (explaining the no-back-edge rule) is not mistaken for a real import. We then assert NO
        // executable require of any dataset module remains.
        const code = src
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .split("\n")
          .map((line) => line.replace(/\/\/.*$/, ""))
          .join("\n");
        expect(code).to.not.match(/require\(["'][^"']*dataset["']\)/);
      }
    });
  });
});

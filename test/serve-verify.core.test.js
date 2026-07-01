"use strict";

// T-59.1 — `cli/serve-verify.js › verifyRequest(body)`: the PURE, transport-agnostic verify CORE for the
// `vh serve-verify` service. It dispatches on the request `kind` to the already-green SDK verify cores
// (evidence.verifySeal / evidence.verifySignedSeal) and returns a stable, versioned verdict envelope.
//
// What these prove (the acceptance criteria):
//   * `verifyRequest` is a PURE function: a source-grep proves the module names NO `http`/`https`/`net`/
//     `fs`/`dns`/key material, and a test drives it with `fs`/`http`/`net` monkey-patched to THROW —
//     verifyRequest still returns correct verdicts, proving it touches none of them.
//   * An UNSIGNED seal built via the SDK verifies ACCEPTED; a ONE-BYTE-tampered entry verifies REJECTED.
//   * A SIGNED container (EPHEMERAL Wallet.createRandom() key) verifies ACCEPTED under the matching
//     `expectedSigner`, REJECTED under a WRONG `expectedSigner`, and REJECTED when an in-body `entries`
//     binding is supplied that does NOT match the signed bytes.
//   * Every malformed / oversized / unknown-`kind` request returns `verdict:"ERROR"` — NEVER throws, NEVER
//     a false ACCEPT.
//   * The verdict shape's field names are asserted BYTE-FOR-BYTE against the existing verify cores' shape.
//
// Every signing key is an EPHEMERAL in-process Wallet.createRandom() (TEST-ONLY, never a real key / real
// funds). The payloads are built PURELY IN MEMORY (no directory, no file read) — this core needs no fs.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { Wallet } = require("ethers");

const evidence = require("../cli/evidence");
const serveVerify = require("../cli/serve-verify");
const { verifyRequest, VERDICT, ERR } = serveVerify;

// ---------------------------------------------------------------------------------------------------
// In-memory fixtures. NO filesystem: entries are literal { relPath, bytes } and the transport shape is
// { relPath, content, encoding } with content base64-encoded so ANY bytes round-trip through JSON.
// ---------------------------------------------------------------------------------------------------
const FILES = Object.freeze({
  "a.txt": Buffer.from("AAA\n"),
  "b.txt": Buffer.from("BBB\n"),
  "sub/c.txt": Buffer.from("CCC\n"),
});

function memEntries(files = FILES) {
  return Object.entries(files).map(([relPath, bytes]) => ({ relPath, bytes: Buffer.from(bytes) }));
}

// Transport-shape entries (what a client actually POSTs): content is base64 of the bytes.
function wireEntries(files = FILES) {
  return Object.entries(files).map(([relPath, bytes]) => ({
    relPath,
    content: Buffer.from(bytes).toString("base64"),
    encoding: "base64",
  }));
}

function buildSealObject(files = FILES) {
  return evidence.buildSeal(memEntries(files));
}

async function signContainer(files = FILES, wallet) {
  const w = wallet || Wallet.createRandom(); // EPHEMERAL, in-memory, TEST-ONLY — never persisted/funded.
  expect(w.privateKey).to.match(/^0x[0-9a-fA-F]{64}$/);
  const seal = evidence.buildSeal(memEntries(files));
  const container = await evidence.signSealWith(seal, w);
  return { wallet: w, seal, container };
}

describe("cli/serve-verify T-59.1: verifyRequest (pure, transport-agnostic verify core)", function () {
  // FILESYSTEM HYGIENE: this PURE core writes NOTHING — assert the working tree is untouched around every test.
  let cwdBefore;
  beforeEach(function () {
    cwdBefore = fs.readdirSync(process.cwd()).sort();
  });
  afterEach(function () {
    expect(fs.readdirSync(process.cwd()).sort()).to.deep.equal(cwdBefore);
  });

  // -------------------------------------------------------------------------------------------------
  // PURITY — a source grep + a "filesystem/network unavailable" execution proof.
  // -------------------------------------------------------------------------------------------------
  describe("purity", function () {
    it("the module source names NO http/https/net/fs/dns require and NO key material (grep)", function () {
      const src = fs.readFileSync(path.join(__dirname, "..", "cli", "serve-verify.js"), "utf8");
      // Strip comments so the prose (which legitimately MENTIONS these words to explain the invariant) can't
      // trip the grep — the ban is on real CODE references, not documentation.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
        .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments (leave `://` in URLs alone — none here)
      for (const forbidden of [
        'require("http")',
        'require("https")',
        'require("net")',
        'require("fs")',
        'require("dns")',
        "require('http')",
        "require('https')",
        "require('net')",
        "require('fs')",
        "require('dns')",
        "createRandom", // never mints a key
        "privateKey", // never reads a private key
        "signMessage", // never signs
        "signSealWith", // never signs
      ]) {
        expect(code, `forbidden token in serve-verify.js code: ${forbidden}`).to.not.include(forbidden);
      }
      // Its ONLY require is the SDK core module.
      const requires = [...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
      expect(requires).to.deep.equal(["./evidence"]);
    });

    it("runs correctly with fs/http/net made to THROW (proves it touches none of them)", function () {
      // Poison the very modules a NON-pure implementation would reach for. If verifyRequest touched fs, a
      // network socket, etc., these would throw and the verdict would be wrong / an ERROR. Restore after.
      const realReadFileSync = fs.readFileSync;
      const realWriteFileSync = fs.writeFileSync;
      const realExistsSync = fs.existsSync;
      const http = require("http");
      const net = require("net");
      const realHttpCreateServer = http.createServer;
      const realNetConnect = net.connect;
      const boom = () => {
        throw new Error("PURITY VIOLATION: verifyRequest touched fs/network");
      };
      fs.readFileSync = boom;
      fs.writeFileSync = boom;
      fs.existsSync = boom;
      http.createServer = boom;
      net.connect = boom;
      try {
        const seal = buildSealObject();
        const res = verifyRequest({
          kind: "verify-seal",
          seal,
          entries: wireEntries(),
        });
        expect(res.verdict).to.equal(VERDICT.ACCEPTED);
        expect(res.detail.accepted).to.equal(true);
      } finally {
        fs.readFileSync = realReadFileSync;
        fs.writeFileSync = realWriteFileSync;
        fs.existsSync = realExistsSync;
        http.createServer = realHttpCreateServer;
        net.connect = realNetConnect;
      }
    });
  });

  // -------------------------------------------------------------------------------------------------
  // UNSIGNED path — ACCEPTED / one-byte-tamper REJECTED.
  // -------------------------------------------------------------------------------------------------
  describe("kind: verify-seal (unsigned)", function () {
    it("ACCEPTS a seal whose supplied bytes match", function () {
      const seal = buildSealObject();
      const res = verifyRequest({ kind: "verify-seal", seal, entries: wireEntries() });
      expect(res.verdict).to.equal(VERDICT.ACCEPTED);
      expect(res.kind).to.equal("verify-seal");
      expect(res.detail.accepted).to.equal(true);
      expect(res.detail.rootMatches).to.equal(true);
      expect(res.detail.counts.matched).to.equal(Object.keys(FILES).length);
    });

    it("REJECTS a ONE-BYTE-tampered entry (root re-derived from the SUPPLIED bytes, never the seal)", function () {
      const seal = buildSealObject();
      // Flip exactly one byte of one entry's content — re-derivation must catch it.
      const tampered = memEntries();
      const buf = Buffer.from(tampered[0].bytes);
      buf[0] = buf[0] ^ 0x01; // one bit -> one byte differs
      const wire = wireEntries();
      wire[0] = { relPath: tampered[0].relPath, content: buf.toString("base64"), encoding: "base64" };
      const res = verifyRequest({ kind: "verify-seal", seal, entries: wire });
      expect(res.verdict).to.equal(VERDICT.REJECTED);
      expect(res.detail.accepted).to.equal(false);
      expect(res.detail.rootMatches).to.equal(false);
      expect(res.detail.counts.changed).to.equal(1);
      // NEVER a false ACCEPT.
      expect(res.verdict).to.not.equal(VERDICT.ACCEPTED);
    });

    it("accepts the seal as a JSON STRING too (readSeal parses it) and utf8-encoded entries", function () {
      const seal = buildSealObject();
      const sealStr = evidence.serializeSeal(seal);
      const utf8Entries = Object.entries(FILES).map(([relPath, bytes]) => ({
        relPath,
        content: bytes.toString("utf8"),
        encoding: "utf8",
      }));
      const res = verifyRequest({ kind: "verify-seal", seal: sealStr, entries: utf8Entries });
      expect(res.verdict).to.equal(VERDICT.ACCEPTED);
    });
  });

  // -------------------------------------------------------------------------------------------------
  // SIGNED path — matching signer ACCEPTED, wrong signer REJECTED, non-matching entries binding REJECTED.
  // -------------------------------------------------------------------------------------------------
  describe("kind: verify-signed-seal (signed)", function () {
    it("ACCEPTS under the matching expectedSigner", async function () {
      const fx = await signContainer();
      const res = verifyRequest({
        kind: "verify-signed-seal",
        container: fx.container,
        expectedSigner: fx.wallet.address,
      });
      expect(res.verdict).to.equal(VERDICT.ACCEPTED);
      expect(res.detail.accepted).to.equal(true);
      expect(res.detail.checks.signatureMatchesSigner).to.equal(true);
      expect(res.detail.checks.signerMatchesExpected).to.equal(true);
      expect(res.detail.recoveredSigner).to.equal(fx.wallet.address.toLowerCase());
      expect(res.detail.failedChecks).to.deep.equal([]);
    });

    it("REJECTS under a WRONG expectedSigner (a different ephemeral address)", async function () {
      const fx = await signContainer();
      const wrong = Wallet.createRandom(); // TEST-ONLY key; NOT the signer.
      const res = verifyRequest({
        kind: "verify-signed-seal",
        container: fx.container,
        expectedSigner: wrong.address,
      });
      expect(res.verdict).to.equal(VERDICT.REJECTED);
      expect(res.detail.accepted).to.equal(false);
      // Check 1 (signature recovers to claimed signer) still passes; the PIN is what fails.
      expect(res.detail.checks.signatureMatchesSigner).to.equal(true);
      expect(res.detail.checks.signerMatchesExpected).to.equal(false);
      expect(res.detail.failedChecks).to.include("signerMatchesExpected");
      expect(res.verdict).to.not.equal(VERDICT.ACCEPTED);
    });

    it("ACCEPTS when a supplied entries BINDING matches the signed bytes", async function () {
      const fx = await signContainer();
      const res = verifyRequest({
        kind: "verify-signed-seal",
        container: fx.container,
        expectedSigner: fx.wallet.address,
        entries: wireEntries(), // the SAME (relPath, content) the seal was built over
      });
      expect(res.verdict).to.equal(VERDICT.ACCEPTED);
      expect(res.detail.checks.manifestBindsAttestation).to.equal(true);
      expect(res.detail.manifestChecked).to.equal(true);
    });

    it("REJECTS when a supplied entries BINDING does NOT match the signed bytes", async function () {
      const fx = await signContainer();
      // Bind against a DIFFERENT file set than what was signed -> canonical bytes differ -> binding fails.
      const otherFiles = { "a.txt": Buffer.from("AAA\n"), "b.txt": Buffer.from("DIFFERENT\n") };
      const res = verifyRequest({
        kind: "verify-signed-seal",
        container: fx.container,
        entries: wireEntries(otherFiles),
      });
      expect(res.verdict).to.equal(VERDICT.REJECTED);
      expect(res.detail.accepted).to.equal(false);
      // The signature itself is genuine; the BINDING is what fails.
      expect(res.detail.checks.signatureMatchesSigner).to.equal(true);
      expect(res.detail.checks.manifestBindsAttestation).to.equal(false);
      expect(res.detail.failedChecks).to.include("manifestBindsAttestation");
      expect(res.verdict).to.not.equal(VERDICT.ACCEPTED);
    });

    it("accepts the container as a JSON STRING too", async function () {
      const fx = await signContainer();
      const containerStr = JSON.stringify(fx.container);
      const res = verifyRequest({
        kind: "verify-signed-seal",
        container: containerStr,
        expectedSigner: fx.wallet.address,
      });
      expect(res.verdict).to.equal(VERDICT.ACCEPTED);
    });
  });

  // -------------------------------------------------------------------------------------------------
  // VERDICT SHAPE PARITY — the envelope's `detail` is byte-for-byte the existing cores' verdict shape.
  // -------------------------------------------------------------------------------------------------
  describe("verdict shape parity with the existing cores", function () {
    it("the UNSIGNED envelope + detail have EXACTLY the core verifySeal field set", function () {
      const seal = buildSealObject();
      const res = verifyRequest({ kind: "verify-seal", seal, entries: wireEntries() });
      // Envelope fields.
      expect(res).to.have.all.keys("schema", "service", "verdict", "kind", "detail");
      expect(res.schema).to.equal(serveVerify.VERIFY_REQUEST_SCHEMA);
      expect(res.service).to.equal(serveVerify.SERVICE_NAME);
      // `detail` MUST be byte-for-byte the core verifySeal shape (same keys, same nested `counts` keys).
      const coreVerdict = evidence.verifySeal(seal, memEntries());
      expect(Object.keys(res.detail).sort()).to.deep.equal(Object.keys(coreVerdict).sort());
      expect(Object.keys(res.detail.counts).sort()).to.deep.equal(Object.keys(coreVerdict.counts).sort());
      // The top-level verdict string equals the core detail's own verdict — never re-derived.
      expect(res.verdict).to.equal(res.detail.verdict);
    });

    it("the SIGNED envelope + detail have EXACTLY the core verifySignedSeal field set", async function () {
      const fx = await signContainer();
      const res = verifyRequest({
        kind: "verify-signed-seal",
        container: fx.container,
        expectedSigner: fx.wallet.address,
      });
      expect(res).to.have.all.keys("schema", "service", "verdict", "kind", "detail");
      const coreVerdict = evidence.verifySignedSeal({
        container: fx.container,
        expectedSigner: fx.wallet.address,
      });
      expect(Object.keys(res.detail).sort()).to.deep.equal(Object.keys(coreVerdict).sort());
      expect(Object.keys(res.detail.checks).sort()).to.deep.equal(Object.keys(coreVerdict.checks).sort());
      expect(res.verdict).to.equal(res.detail.verdict);
    });
  });

  // -------------------------------------------------------------------------------------------------
  // FAIL CLOSED — every malformed / oversized / unknown-kind request is a clean ERROR, never a throw,
  // never a false ACCEPT.
  // -------------------------------------------------------------------------------------------------
  describe("fail closed (ERROR, never throw, never false ACCEPT)", function () {
    const nonObjectBodies = [
      ["null", null],
      ["undefined", undefined],
      ["a number", 42],
      ["a string", "verify-seal"],
      ["an array", [{ kind: "verify-seal" }]],
      ["a boolean", true],
    ];
    for (const [label, body] of nonObjectBodies) {
      it(`ERROR (never throws) for a non-object body: ${label}`, function () {
        let res;
        expect(() => (res = verifyRequest(body))).to.not.throw();
        expect(res.verdict).to.equal(VERDICT.ERROR);
        expect(res.code).to.equal(ERR.NOT_OBJECT);
        expect(res.verdict).to.not.equal(VERDICT.ACCEPTED);
      });
    }

    it("ERROR for an unknown / missing kind", function () {
      for (const kind of [undefined, null, "", "verify", "VERIFY-SEAL", "verify-anchor", 7]) {
        const res = verifyRequest({ kind });
        expect(res.verdict).to.equal(VERDICT.ERROR);
        expect(res.code).to.equal(ERR.UNKNOWN_KIND);
      }
    });

    it("ERROR for an OVERSIZED body (never OOM, never ACCEPT)", function () {
      // A body just over the byte cap -> clean ERROR. Build a big filler string (not a real seal).
      const big = "x".repeat(serveVerify.MAX_BODY_BYTES + 1024);
      const res = verifyRequest({ kind: "verify-seal", seal: {}, filler: big });
      expect(res.verdict).to.equal(VERDICT.ERROR);
      expect(res.code).to.equal(ERR.TOO_LARGE);
    });

    it("ERROR for a body that can't be JSON-measured (circular ref)", function () {
      const body = { kind: "verify-seal" };
      body.self = body; // circular
      let res;
      expect(() => (res = verifyRequest(body))).to.not.throw();
      expect(res.verdict).to.equal(VERDICT.ERROR);
      expect(res.code).to.equal(ERR.TOO_LARGE);
    });

    it("ERROR (verify-seal) for a missing seal", function () {
      const res = verifyRequest({ kind: "verify-seal", entries: [] });
      expect(res.verdict).to.equal(VERDICT.ERROR);
      expect(res.code).to.equal(ERR.MISSING_SEAL);
    });

    it("ERROR (verify-seal) for a corrupt / foreign / wrong-kind seal", function () {
      for (const seal of [
        { not: "a seal" },
        "{ not json",
        { kind: "vh.evidence-seal", schemaVersion: 1 }, // structurally incomplete
        buildSealObject() && Object.assign(buildSealObject(), { root: "0xdeadbeef" }), // tampered root
      ]) {
        const res = verifyRequest({ kind: "verify-seal", seal, entries: wireEntries() });
        expect(res.verdict).to.equal(VERDICT.ERROR);
        expect(res.code).to.equal(ERR.BAD_SEAL);
        expect(res.verdict).to.not.equal(VERDICT.ACCEPTED);
      }
    });

    it("ERROR (verify-seal) for malformed entries", function () {
      const seal = buildSealObject();
      const badEntrySets = [
        "not an array",
        [{ relPath: "a.txt" }], // no content
        [{ relPath: "a.txt", content: 123 }], // non-string content
        [{ relPath: "", content: "AA", encoding: "base64" }], // empty relPath
        [{ relPath: "a.txt", content: "!!!not-base64!!!", encoding: "base64" }], // invalid base64
        [{ relPath: "a.txt", content: "zz", encoding: "hex" }], // invalid hex
        [{ relPath: "a.txt", content: "AA", encoding: "rot13" }], // unknown encoding
      ];
      for (const entries of badEntrySets) {
        const res = verifyRequest({ kind: "verify-seal", seal, entries });
        expect(res.verdict).to.equal(VERDICT.ERROR);
        expect(res.code).to.equal(ERR.BAD_ENTRIES);
      }
    });

    it("ERROR (verify-signed-seal) for a missing / corrupt container", function () {
      const missing = verifyRequest({ kind: "verify-signed-seal" });
      expect(missing.verdict).to.equal(VERDICT.ERROR);
      expect(missing.code).to.equal(ERR.MISSING_CONTAINER);

      for (const container of ["{ not json", { kind: "wrong" }, 42, ["x"]]) {
        const res = verifyRequest({ kind: "verify-signed-seal", container });
        expect(res.verdict).to.equal(VERDICT.ERROR);
        expect(res.code).to.equal(ERR.BAD_CONTAINER);
        expect(res.verdict).to.not.equal(VERDICT.ACCEPTED);
      }
    });

    it("ERROR (verify-signed-seal) for a malformed expectedSigner", async function () {
      const fx = await signContainer();
      for (const expectedSigner of ["not-an-address", "0x123", 42]) {
        const res = verifyRequest({
          kind: "verify-signed-seal",
          container: fx.container,
          expectedSigner,
        });
        expect(res.verdict).to.equal(VERDICT.ERROR);
        expect([ERR.BAD_EXPECTED_SIGNER]).to.include(res.code);
        expect(res.verdict).to.not.equal(VERDICT.ACCEPTED);
      }
    });

    it("a FORGED signature is REJECTED (not ERROR, not ACCEPT) — signer recovery is done here, not trusted", async function () {
      // Sign with one key, then rewrite the CLAIMED signer to a different address: validateSignedSeal passes
      // (structure is fine) but the signature no longer recovers to the claimed signer -> clean REJECTED.
      const fx = await signContainer();
      const imposter = Wallet.createRandom(); // TEST-ONLY
      const forged = JSON.parse(JSON.stringify(fx.container));
      forged.signature.signer = imposter.address.toLowerCase();
      const res = verifyRequest({ kind: "verify-signed-seal", container: forged });
      expect(res.verdict).to.equal(VERDICT.REJECTED);
      expect(res.detail.checks.signatureMatchesSigner).to.equal(false);
      expect(res.verdict).to.not.equal(VERDICT.ACCEPTED);
    });
  });
});

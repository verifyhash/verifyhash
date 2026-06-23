"use strict";

// test/cli.core.rfc3161.test.js — DIRECT coverage of the pure RFC-3161 TimeStampToken reader (T-20.1).
//
// WHY THIS SUITE EXISTS
//   cli/core/rfc3161.js is the OFFLINE half of EPIC-20's independent-timestamp proof: given a TSA's
//   TimeStampToken bytes, parse the embedded TSTInfo and confirm it binds EXACTLY a given digest. We must
//   prove the reader WITHOUT a real TSA and WITHOUT a network. So this file carries a TEST-ONLY DER
//   encoder, mintTestToken(), that builds a minimal-but-valid TimeStampToken/TSTInfo over a chosen digest
//   — the timestamp analogue of Wallet.createRandom(): NO real TSA, NO real key, NO funds, NO network. It
//   is defined HERE (the test surface), never on the command path, so nothing ships a token forger.
//
//   Coverage: round-trip a minted token through the reader and assert EVERY extracted field; bindsDigest
//   true for the matching digest+OID and false for a one-bit-flipped digest or a different hashAlgorithm
//   OID; truncated/garbage DER and a non-id-ct-TSTInfo eContentType each error clearly; a GeneralizedTime
//   (incl. fractional seconds and a non-UTC/zoneless form) parses to the exact ISO UTC instant / is
//   rejected. No filesystem effects at all (pure in-memory bytes), so nothing leaks into the working tree.

const { expect } = require("chai");
const rfc3161 = require("../cli/core/rfc3161");
const { OID } = rfc3161;

// =====================================================================================================
// TEST-ONLY DER encoder + minter. NOT shipped on any command path. ====================================
// =====================================================================================================

// Encode a definite-length DER length field (minimal form).
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let x = n;
  while (x > 0) {
    bytes.unshift(x & 0xff);
    x = Math.floor(x / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

// Wrap a value buffer in a TLV with the given tag byte.
function tlv(tag, value) {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), derLen(v.length), v]);
}

function derSequence(...parts) {
  return tlv(0x30, Buffer.concat(parts));
}
function derSet(...parts) {
  return tlv(0x31, Buffer.concat(parts));
}
function derOctetString(value) {
  return tlv(0x04, value);
}
function derContext0(value) {
  return tlv(0xa0, value); // [0] EXPLICIT, constructed
}

// Encode a non-negative integer as a DER INTEGER (minimal, with a sign-padding 0x00 if the high bit is
// set). `value` may be a non-negative number or a BigInt.
function derInteger(value) {
  let big = typeof value === "bigint" ? value : BigInt(value);
  if (big < 0n) throw new Error("test minter only encodes non-negative integers");
  let hex = big.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let bytes = Buffer.from(hex, "hex");
  if (bytes.length === 0) bytes = Buffer.from([0x00]);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  return tlv(0x02, bytes);
}

// Encode a dotted-decimal OID string as a DER OBJECT IDENTIFIER.
function derOID(dotted) {
  const arcs = dotted.split(".").map((s) => parseInt(s, 10));
  if (arcs.length < 2) throw new Error("OID needs >=2 arcs");
  const out = [40 * arcs[0] + arcs[1]];
  for (let i = 2; i < arcs.length; i++) {
    let v = arcs[i];
    const stack = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

function derGeneralizedTime(str) {
  return tlv(0x18, Buffer.from(str, "ascii"));
}

// mintTestToken — TEST-ONLY. DER-encode a minimal valid RFC-3161 TimeStampToken over `digestHex`.
//   Options: { digestHex, hashOID, genTime, serial, policyOID, eContentType, version }.
//   - genTime is the literal GeneralizedTime string (e.g. "20260623120000Z" or with ".5").
//   - eContentType lets a test deliberately mint a NON-TSTInfo CMS blob to prove rejection.
function mintTestToken(opts = {}) {
  const digestHex = (opts.digestHex || "").replace(/^0x/i, "").toLowerCase();
  const hashOID = opts.hashOID || OID.sha256;
  const genTime = opts.genTime || "20260623120000Z";
  const serial = opts.serial !== undefined ? opts.serial : 42;
  const policyOID = opts.policyOID || "1.2.3.4.5";
  const eContentType = opts.eContentType || OID.tstInfo;
  const version = opts.version !== undefined ? opts.version : 1;

  // messageImprint ::= SEQUENCE { hashAlgorithm AlgorithmIdentifier SEQUENCE { OID, NULL }, hashedMessage OCTET STRING }
  const hashAlg = derSequence(derOID(hashOID), Buffer.from([0x05, 0x00])); // OID + explicit NULL params
  const messageImprint = derSequence(hashAlg, derOctetString(Buffer.from(digestHex, "hex")));

  // TSTInfo ::= SEQUENCE { version, policy OID, messageImprint, serialNumber, genTime }
  const tstInfo = derSequence(
    derInteger(version),
    derOID(policyOID),
    messageImprint,
    derInteger(serial),
    derGeneralizedTime(genTime)
  );

  // encapContentInfo ::= SEQUENCE { eContentType OID, eContent [0] EXPLICIT OCTET STRING(TSTInfo) }
  const encap = derSequence(derOID(eContentType), derContext0(derOctetString(tstInfo)));

  // SignedData ::= SEQUENCE { version INT(3), digestAlgorithms SET{}, encapContentInfo, ... }
  // (We omit the OPTIONAL certificates/crls/signerInfos — the reader doesn't traverse past encap, by
  //  design: signature/cert validation is the human trust anchor, explicitly OUT of scope.)
  const signedData = derSequence(
    derInteger(3),
    derSet(derSequence(derOID(hashOID), Buffer.from([0x05, 0x00]))),
    encap
  );

  // ContentInfo ::= SEQUENCE { contentType OID(signedData), content [0] EXPLICIT SignedData }
  return derSequence(derOID(OID.signedData), derContext0(signedData));
}

// =====================================================================================================

describe("cli/core/rfc3161: pure RFC-3161 TimeStampToken reader (T-20.1)", function () {
  const DIGEST = "a".repeat(64); // 32-byte SHA-256-shaped digest, all 0xaa
  const GENTIME = "20260623123456Z";
  const ISO = "2026-06-23T12:34:56Z";

  describe("parseTimeStampToken: round-trip every field", function () {
    it("extracts version/policyOID/messageImprint/serialNumber/genTime from a minted token", function () {
      const der = mintTestToken({
        digestHex: DIGEST,
        hashOID: OID.sha256,
        genTime: GENTIME,
        serial: 12345,
        policyOID: "1.3.6.1.4.1.13762.3",
      });
      const t = rfc3161.parseTimeStampToken(der);
      expect(t.version).to.equal(1);
      expect(t.policyOID).to.equal("1.3.6.1.4.1.13762.3");
      expect(t.messageImprint.hashAlgorithmOID).to.equal(OID.sha256);
      expect(t.messageImprint.hashedMessage).to.equal(DIGEST);
      expect(t.serialNumber.decimal).to.equal("12345");
      expect(t.serialNumber.hex).to.equal("3039"); // 12345 = 0x3039
      expect(t.genTime).to.equal(ISO);
      expect(t.genTimeEpochMs).to.equal(Date.UTC(2026, 5, 23, 12, 34, 56, 0));
    });

    it("accepts a hex or base64 string as input, not just a Buffer", function () {
      const der = mintTestToken({ digestHex: DIGEST, genTime: GENTIME });
      const fromHex = rfc3161.parseTimeStampToken(der.toString("hex"));
      const fromB64 = rfc3161.parseTimeStampToken(der.toString("base64"));
      expect(fromHex.messageImprint.hashedMessage).to.equal(DIGEST);
      expect(fromB64.messageImprint.hashedMessage).to.equal(DIGEST);
    });

    it("handles a large (>53-bit) serialNumber via hex+decimal", function () {
      const big = 0xdeadbeefcafef00dbaben;
      const der = mintTestToken({ digestHex: DIGEST, genTime: GENTIME, serial: big });
      const t = rfc3161.parseTimeStampToken(der);
      expect(t.serialNumber.decimal).to.equal(big.toString(10));
      expect(t.serialNumber.hex).to.equal(big.toString(16));
    });
  });

  describe("genTime parsing: canonical ISO UTC, reject ambiguous", function () {
    it("parses fractional seconds to the exact instant and preserves precision", function () {
      const der = mintTestToken({ digestHex: DIGEST, genTime: "20260623123456.5Z" });
      const t = rfc3161.parseTimeStampToken(der);
      expect(t.genTime).to.equal("2026-06-23T12:34:56.5Z");
      expect(t.genTimeEpochMs).to.equal(Date.UTC(2026, 5, 23, 12, 34, 56, 500));
    });

    it("rejects a zoneless GeneralizedTime (no trailing Z)", function () {
      const der = mintTestToken({ digestHex: DIGEST, genTime: "20260623123456" });
      expect(() => rfc3161.parseTimeStampToken(der)).to.throw(/UTC|zoneless|GeneralizedTime/i);
    });

    it("rejects an offset (+hhmm) GeneralizedTime", function () {
      const der = mintTestToken({ digestHex: DIGEST, genTime: "20260623123456+0100" });
      expect(() => rfc3161.parseTimeStampToken(der)).to.throw(/UTC|offset/i);
    });

    it("rejects trailing-zero fractional seconds (non-canonical)", function () {
      const der = mintTestToken({ digestHex: DIGEST, genTime: "20260623123456.500Z" });
      expect(() => rfc3161.parseTimeStampToken(der)).to.throw(/trailing zero|fractional/i);
    });
  });

  describe("bindsDigest: binds ONLY the exact digest under the expected hash algorithm", function () {
    it("returns true for the matching digest + OID", function () {
      const der = mintTestToken({ digestHex: DIGEST, hashOID: OID.sha256, genTime: GENTIME });
      expect(
        rfc3161.bindsDigest({ token: der, expectedDigestHex: DIGEST, expectedHashOID: OID.sha256 })
      ).to.equal(true);
    });

    it("accepts a 0x-prefixed / uppercase expectedDigestHex (compared lowercased, exact)", function () {
      const der = mintTestToken({ digestHex: DIGEST, hashOID: OID.sha256, genTime: GENTIME });
      expect(
        rfc3161.bindsDigest({
          token: der,
          expectedDigestHex: "0x" + DIGEST.toUpperCase(),
          expectedHashOID: OID.sha256,
        })
      ).to.equal(true);
    });

    it("works on an already-parsed token object, not just raw DER", function () {
      const t = rfc3161.parseTimeStampToken(mintTestToken({ digestHex: DIGEST, genTime: GENTIME }));
      expect(
        rfc3161.bindsDigest({ token: t, expectedDigestHex: DIGEST, expectedHashOID: OID.sha256 })
      ).to.equal(true);
    });

    it("returns false for a one-bit-flipped digest", function () {
      const der = mintTestToken({ digestHex: DIGEST, genTime: GENTIME });
      // Flip the low bit of the last byte: 0xaa -> 0xab.
      const flipped = DIGEST.slice(0, 62) + "ab";
      expect(flipped).to.not.equal(DIGEST);
      expect(
        rfc3161.bindsDigest({ token: der, expectedDigestHex: flipped, expectedHashOID: OID.sha256 })
      ).to.equal(false);
    });

    it("returns false when the token's hashAlgorithm OID differs from expected", function () {
      // Token stamps the SAME digest bytes but under SHA-512; expecting SHA-256 must NOT bind.
      const der = mintTestToken({ digestHex: DIGEST, hashOID: OID.sha512, genTime: GENTIME });
      expect(
        rfc3161.bindsDigest({ token: der, expectedDigestHex: DIGEST, expectedHashOID: OID.sha256 })
      ).to.equal(false);
      // And it DOES bind when the expected OID matches the token's.
      expect(
        rfc3161.bindsDigest({ token: der, expectedDigestHex: DIGEST, expectedHashOID: OID.sha512 })
      ).to.equal(true);
    });

    it("requires token/expectedDigestHex/expectedHashOID arguments", function () {
      const der = mintTestToken({ digestHex: DIGEST, genTime: GENTIME });
      expect(() => rfc3161.bindsDigest({ expectedDigestHex: DIGEST, expectedHashOID: OID.sha256 })).to.throw(
        /token is required/
      );
      expect(() => rfc3161.bindsDigest({ token: der, expectedHashOID: OID.sha256 })).to.throw(
        /expectedDigestHex/
      );
      expect(() => rfc3161.bindsDigest({ token: der, expectedDigestHex: DIGEST })).to.throw(
        /expectedHashOID/
      );
    });
  });

  describe("malformed / wrong input: clear errors, never a silent wrong field", function () {
    it("rejects empty input", function () {
      expect(() => rfc3161.parseTimeStampToken(Buffer.alloc(0))).to.throw(/empty input/i);
    });

    it("rejects truncated DER (token cut short mid-value)", function () {
      const der = mintTestToken({ digestHex: DIGEST, genTime: GENTIME });
      const truncated = der.subarray(0, der.length - 10);
      expect(() => rfc3161.parseTimeStampToken(truncated)).to.throw(rfc3161.DerError);
    });

    it("rejects garbage bytes that are not DER at all", function () {
      const garbage = Buffer.from([0xff, 0x01, 0x02, 0x03, 0x04, 0x05]);
      expect(() => rfc3161.parseTimeStampToken(garbage)).to.throw(rfc3161.DerError);
    });

    it("rejects indefinite-length encoding (forbidden in DER)", function () {
      // SEQUENCE with indefinite length (0x30 0x80 ...).
      const bad = Buffer.from([0x30, 0x80, 0x00, 0x00]);
      expect(() => rfc3161.parseTimeStampToken(bad)).to.throw(/indefinite length/i);
    });

    it("rejects a CMS blob whose eContentType is NOT id-ct-TSTInfo", function () {
      // Mint with a bogus eContentType (id-data, 1.2.840.113549.1.7.1) — a structurally valid CMS
      // SignedData, but not a TimeStampToken. Must error clearly, not parse garbage.
      const der = mintTestToken({
        digestHex: DIGEST,
        genTime: GENTIME,
        eContentType: "1.2.840.113549.1.7.1",
      });
      expect(() => rfc3161.parseTimeStampToken(der)).to.throw(/id-ct-TSTInfo|not an RFC-3161/i);
    });

    it("rejects a ContentInfo whose contentType is not signedData", function () {
      // Hand-build a ContentInfo with the wrong outer contentType OID.
      const inner = tlv(0xa0, Buffer.from([0x05, 0x00]));
      const ci = derSequence(derOID("1.2.840.113549.1.7.1"), inner);
      expect(() => rfc3161.parseTimeStampToken(ci)).to.throw(/signedData/i);
    });

    it("rejects trailing bytes after the ContentInfo", function () {
      const der = mintTestToken({ digestHex: DIGEST, genTime: GENTIME });
      const withTail = Buffer.concat([der, Buffer.from([0x00, 0x00])]);
      expect(() => rfc3161.parseTimeStampToken(withTail)).to.throw(/trailing bytes/i);
    });

    it("rejects an unsupported TSTInfo version", function () {
      const der = mintTestToken({ digestHex: DIGEST, genTime: GENTIME, version: 2 });
      expect(() => rfc3161.parseTimeStampToken(der)).to.throw(/version/i);
    });
  });
});

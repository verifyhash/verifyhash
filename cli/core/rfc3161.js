"use strict";

// cli/core/rfc3161.js — a small, PURE, dependency-free RFC-3161 TimeStampToken reader.
//
// WHY THIS EXISTS (T-20.1, EPIC-20)
//   verifyhash's signed-attestation envelope (cli/core/attestation.js) proves "the publisher SAYS this
//   payload existed" — a SELF-managed signature. The honestly-stronger claim a due-diligence / EU-AI-Act
//   reviewer ultimately wants is "an INDEPENDENT third party attests this exact digest existed by time T."
//   RFC-3161 is the standard way to get that: you send a hash (the messageImprint) to a Time-Stamping
//   Authority (TSA) and it returns a signed TimeStampToken whose embedded TSTInfo binds that hash to a
//   genTime. This module is the OFFLINE half: given a token's bytes, parse the TSTInfo and confirm it
//   binds EXACTLY the buyer's own digest. Obtaining a token requires a network call to a real (possibly
//   paid) TSA — a HUMAN step; this loop never makes it. The only tokens this module ever sees in-suite
//   are self-minted throwaway TEST tokens (see __testutil / the test file), the timestamp analogue of
//   Wallet.createRandom().
//
// SCOPE — DELIBERATELY MINIMAL, AND HONEST ABOUT IT.
//   IN : a bounded, pure DER reader for EXACTLY the types on the TSTInfo path (SEQUENCE, OID, INTEGER,
//        OCTET STRING, GeneralizedTime, and the [0] EXPLICIT context tags it must traverse); reaching the
//        embedded TSTInfo through the CMS SignedData wrapper; extracting version/policy/messageImprint/
//        serialNumber/genTime; and a bindsDigest() check.
//   OUT: NO X.509 certificate-chain parsing, NO verification of the TSA's signature OVER the TSTInfo, NO
//        network. Trusting that the TOKEN itself is authentic (that the bytes really came from your TSA
//        and weren't forged) is the HUMAN TRUST-ANCHOR step: you validate the TSA's cert chain / the CMS
//        signature out-of-band (e.g. `openssl ts -verify`, a CMS verifier), exactly as Option A pins the
//        signer ADDRESS out-of-band. This module proves the BINDING (which digest/genTime the token
//        asserts), not the AUTHENTICITY of the asserting party. The reader REJECTS malformed/truncated
//        DER with a clear error — it never silently returns a partial or wrong field.
//
// IMPORTANT: zero dependencies, zero I/O, zero global state. Operates on a Buffer/Uint8Array of DER bytes.

// ---------------------------------------------------------------------------------------------------
// OIDs we care about (dotted-decimal strings). Frozen so they can't drift.
// ---------------------------------------------------------------------------------------------------
const OID = Object.freeze({
  // CMS ContentInfo contentType for SignedData (PKCS#7 / RFC 5652).
  signedData: "1.2.840.113549.1.7.2",
  // RFC-3161 id-ct-TSTInfo: the eContentType whose eContent is the DER-encoded TSTInfo.
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  // Common digest algorithms a messageImprint hashAlgorithm may name. SHA-256 is the default we expect.
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  sha1: "1.3.14.3.2.26",
});

// DER universal tag numbers (class 0, the low 5 bits of the identifier octet for primitive forms).
const TAG = Object.freeze({
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  OID: 0x06,
  SEQUENCE: 0x30, // constructed
  SET: 0x31, // constructed
  GENERALIZED_TIME: 0x18,
});

// ---------------------------------------------------------------------------------------------------
// A tiny, BOUNDED DER cursor. Every read is length-checked against `end`; any over-read throws. This is
// the single place that turns "DER bytes" into "a value", so truncation/garbage can NEVER leak past it
// as a silently-wrong field — a partial read is always a thrown error.
// ---------------------------------------------------------------------------------------------------
class DerError extends Error {
  constructor(msg) {
    super("RFC-3161 DER: " + msg);
    this.name = "DerError";
  }
}

function toBuf(der) {
  if (Buffer.isBuffer(der)) return der;
  if (der instanceof Uint8Array) return Buffer.from(der);
  if (typeof der === "string") {
    // Accept hex (0x-optional) or base64. Hex if it's all hex of even length; else try base64.
    const s = der.trim();
    const hex = s.replace(/^0x/i, "");
    if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) return Buffer.from(hex, "hex");
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) {
      const b = Buffer.from(s.replace(/\s+/g, ""), "base64");
      if (b.length > 0) return b;
    }
    throw new DerError("input string is neither valid hex nor base64");
  }
  throw new DerError("input must be a Buffer, Uint8Array, or hex/base64 string");
}

// Read one TLV at offset `pos` within [0,end). Returns { tag, valStart, valEnd, next } where the value
// occupies bytes [valStart, valEnd) and the NEXT TLV (if any) starts at `next` (== valEnd here, since DER
// is definite-length). Rejects indefinite length (0x80) — forbidden in DER — and any length that runs
// past `end`.
function readTLV(buf, pos, end) {
  if (pos >= end) throw new DerError("unexpected end of input while reading tag");
  const tag = buf[pos];
  // Multi-byte (high-tag-number) identifiers (low 5 bits all 1) are not used on the TSTInfo path; reject.
  if ((tag & 0x1f) === 0x1f) throw new DerError("high-tag-number form is unsupported");
  let p = pos + 1;
  if (p >= end) throw new DerError("unexpected end of input while reading length");
  let lenByte = buf[p++];
  let len;
  if (lenByte < 0x80) {
    len = lenByte; // short form
  } else if (lenByte === 0x80) {
    throw new DerError("indefinite length is forbidden in DER");
  } else {
    const numBytes = lenByte & 0x7f;
    if (numBytes > 4) throw new DerError("length field too large");
    if (p + numBytes > end) throw new DerError("truncated long-form length");
    len = 0;
    for (let i = 0; i < numBytes; i++) len = len * 256 + buf[p++];
    // DER requires the minimal length encoding; a long form encoding a value < 0x80 is malformed, and a
    // leading zero byte is non-minimal.
    if (numBytes === 1 && len < 0x80) throw new DerError("non-minimal long-form length");
    if (buf[p - numBytes] === 0x00) throw new DerError("non-minimal long-form length (leading zero)");
  }
  const valStart = p;
  const valEnd = p + len;
  if (valEnd > end) throw new DerError("value length runs past end of input");
  return { tag, valStart, valEnd, next: valEnd };
}

// Read a TLV and assert it carries the expected tag; otherwise a clear error naming both.
function expectTLV(buf, pos, end, wantTag, what) {
  const t = readTLV(buf, pos, end);
  if (t.tag !== wantTag) {
    throw new DerError(
      `expected ${what} (tag 0x${wantTag.toString(16).padStart(2, "0")}) but found tag 0x${t.tag
        .toString(16)
        .padStart(2, "0")}`
    );
  }
  return t;
}

// Decode a DER OBJECT IDENTIFIER value (the bytes between valStart/valEnd) to dotted-decimal.
function decodeOID(buf, valStart, valEnd) {
  if (valEnd <= valStart) throw new DerError("empty OID");
  const parts = [];
  // First byte encodes the first two arcs: X*40 + Y.
  const first = buf[valStart];
  parts.push(Math.floor(first / 40));
  parts.push(first % 40);
  let val = 0;
  let started = false;
  for (let i = valStart + 1; i < valEnd; i++) {
    const b = buf[i];
    // base-128, high bit = continuation. Reject non-minimal (leading 0x80 in a sub-identifier).
    if (!started && b === 0x80) throw new DerError("non-minimal OID sub-identifier");
    started = true;
    val = val * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(val);
      val = 0;
      started = false;
    }
  }
  if (started) throw new DerError("truncated OID (last sub-identifier unterminated)");
  return parts.join(".");
}

// Decode a DER INTEGER value to BOTH a lowercase hex string (no 0x, magnitude, leading zero stripped to a
// single byte minimum) and a decimal string. Used for serialNumber, which RFC-3161 allows to be large
// (>53 bits) — so we go through BigInt for the decimal and keep the raw hex for byte-exactness. We only
// support NON-NEGATIVE integers here (serialNumber and version are non-negative); a negative DER INTEGER
// (high bit set after the minimal-zero rule) is rejected.
function decodeUInt(buf, valStart, valEnd, what) {
  if (valEnd <= valStart) throw new DerError(`empty INTEGER (${what})`);
  // DER minimal-encoding rules for INTEGER.
  if (valEnd - valStart >= 2) {
    if (buf[valStart] === 0x00 && (buf[valStart + 1] & 0x80) === 0)
      throw new DerError(`non-minimal INTEGER encoding (${what})`);
    if (buf[valStart] === 0xff && (buf[valStart + 1] & 0x80) !== 0)
      throw new DerError(`non-minimal negative INTEGER encoding (${what})`);
  }
  if (buf[valStart] & 0x80) throw new DerError(`negative INTEGER not supported (${what})`);
  // Strip the single leading 0x00 sign byte (if present) for the magnitude.
  let start = valStart;
  if (buf[start] === 0x00 && valEnd - start > 1) start += 1;
  let hex = "";
  let big = 0n;
  for (let i = start; i < valEnd; i++) {
    hex += buf[i].toString(16).padStart(2, "0");
    big = (big << 8n) | BigInt(buf[i]);
  }
  if (hex === "") hex = "00";
  return { hex, decimal: big.toString(10) };
}

// Decode an RFC-3161 GeneralizedTime to a canonical ISO-8601 UTC string. RFC-3161 §2.4.2 constrains
// genTime to the form YYYYMMDDHHMMSS[.fff]Z — ALWAYS UTC (trailing Z), with optional fractional seconds
// and NO trailing zeros in the fraction. We REJECT zoneless or offset (+hhmm) forms: a timestamp whose
// instant is ambiguous must never be silently coerced.
function decodeGeneralizedTime(buf, valStart, valEnd) {
  const raw = buf.toString("ascii", valStart, valEnd);
  // Must end in Z (UTC). Anything else (no zone, or a +/- offset) is rejected.
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z$/.exec(raw);
  if (!m) {
    if (/[+-]\d{2,4}$/.test(raw))
      throw new DerError(`genTime must be UTC (trailing Z); got offset form "${raw}"`);
    if (!/Z$/.test(raw)) throw new DerError(`genTime must be UTC (trailing Z); got zoneless "${raw}"`);
    throw new DerError(`malformed GeneralizedTime "${raw}"`);
  }
  const [, Y, Mo, D, H, Mi, S, frac] = m;
  const year = Number(Y);
  const month = Number(Mo);
  const day = Number(D);
  const hour = Number(H);
  const min = Number(Mi);
  const sec = Number(S);
  if (month < 1 || month > 12) throw new DerError(`genTime month out of range "${raw}"`);
  if (day < 1 || day > 31) throw new DerError(`genTime day out of range "${raw}"`);
  if (hour > 23 || min > 59 || sec > 60) throw new DerError(`genTime time-of-day out of range "${raw}"`);
  // Build a canonical ISO string. Use Date.UTC for the instant; preserve fractional seconds (trimmed of
  // trailing zeros, max 3 digits surfaced as milliseconds in the ISO form) when present.
  let ms = 0;
  let fracStr = "";
  if (frac !== undefined) {
    const trimmed = frac.replace(/0+$/, "");
    if (trimmed === "") throw new DerError(`genTime fractional seconds must not be all-zero "${raw}"`);
    if (trimmed !== frac) throw new DerError(`genTime fractional seconds must not have trailing zeros "${raw}"`);
    fracStr = trimmed;
    ms = Math.round(Number("0." + trimmed) * 1000);
  }
  const epoch = Date.UTC(year, month - 1, day, hour, min, sec, ms);
  if (!Number.isFinite(epoch)) throw new DerError(`genTime is not a valid date "${raw}"`);
  // Canonical ISO-8601 UTC. We surface the original fractional precision (not just milliseconds) so a
  // sub-millisecond stamp isn't silently rounded away in the human/text form.
  const iso =
    `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(min, 2)}:${pad(sec, 2)}` +
    (fracStr ? "." + fracStr : "") +
    "Z";
  return { iso, epochMs: epoch };
}

function pad(n, w) {
  return String(n).padStart(w, "0");
}

// ---------------------------------------------------------------------------------------------------
// Reach the embedded TSTInfo through the CMS SignedData wrapper, then parse it.
// ---------------------------------------------------------------------------------------------------

// Given the value-range of a [0] EXPLICIT context tag (the outermost ContentInfo's content, and the
// encapContentInfo's eContent), return the inner TLV range. EXPLICIT context tags wrap exactly one inner
// element. Tag byte for [0] constructed-explicit is 0xA0.
function CONTEXT(n) {
  return 0xa0 + n; // constructed context-specific [n]
}

// Parse a CMS ContentInfo (SignedData) and return the byte range of the embedded TSTInfo OCTET STRING's
// VALUE (the DER-encoded TSTInfo). Throws if eContentType is not id-ct-TSTInfo (so a non-timestamp CMS
// blob errors clearly instead of producing nonsense).
function reachTSTInfo(buf) {
  const end = buf.length;
  // ContentInfo ::= SEQUENCE { contentType OID, content [0] EXPLICIT ANY }
  const ci = expectTLV(buf, 0, end, TAG.SEQUENCE, "ContentInfo SEQUENCE");
  if (ci.next !== end) throw new DerError("trailing bytes after ContentInfo");
  let pos = ci.valStart;
  const ct = expectTLV(buf, pos, ci.valEnd, TAG.OID, "ContentInfo.contentType OID");
  const ctOid = decodeOID(buf, ct.valStart, ct.valEnd);
  if (ctOid !== OID.signedData)
    throw new DerError(`ContentInfo.contentType is ${ctOid}, expected signedData (${OID.signedData})`);
  pos = ct.next;
  const content = expectTLV(buf, pos, ci.valEnd, CONTEXT(0), "ContentInfo.content [0] EXPLICIT");
  // SignedData ::= SEQUENCE { version, digestAlgorithms SET, encapContentInfo SEQUENCE {...}, ... }
  const sd = expectTLV(buf, content.valStart, content.valEnd, TAG.SEQUENCE, "SignedData SEQUENCE");
  let sp = sd.valStart;
  const sdVer = expectTLV(buf, sp, sd.valEnd, TAG.INTEGER, "SignedData.version");
  sp = sdVer.next;
  const digestAlgs = expectTLV(buf, sp, sd.valEnd, TAG.SET, "SignedData.digestAlgorithms SET");
  sp = digestAlgs.next;
  // encapContentInfo ::= SEQUENCE { eContentType OID, eContent [0] EXPLICIT OCTET STRING OPTIONAL }
  const enc = expectTLV(buf, sp, sd.valEnd, TAG.SEQUENCE, "encapContentInfo SEQUENCE");
  let ep = enc.valStart;
  const eContentType = expectTLV(buf, ep, enc.valEnd, TAG.OID, "eContentType OID");
  const eOid = decodeOID(buf, eContentType.valStart, eContentType.valEnd);
  if (eOid !== OID.tstInfo)
    throw new DerError(
      `eContentType is ${eOid}, not id-ct-TSTInfo (${OID.tstInfo}) — this is not an RFC-3161 TimeStampToken`
    );
  ep = eContentType.next;
  const eContent = expectTLV(buf, ep, enc.valEnd, CONTEXT(0), "eContent [0] EXPLICIT");
  // eContent wraps an OCTET STRING whose bytes ARE the DER-encoded TSTInfo.
  const octet = expectTLV(buf, eContent.valStart, eContent.valEnd, TAG.OCTET_STRING, "TSTInfo OCTET STRING");
  return { start: octet.valStart, end: octet.valEnd };
}

// Parse the TSTInfo at [start,end) into the extracted field set.
function parseTSTInfo(buf, start, end) {
  // TSTInfo ::= SEQUENCE { version INTEGER, policy OID, messageImprint SEQUENCE,
  //                        serialNumber INTEGER, genTime GeneralizedTime, ... (optionals ignored) }
  const seq = expectTLV(buf, start, end, TAG.SEQUENCE, "TSTInfo SEQUENCE");
  let p = seq.valStart;
  const limit = seq.valEnd;

  const ver = expectTLV(buf, p, limit, TAG.INTEGER, "TSTInfo.version");
  const version = Number(decodeUInt(buf, ver.valStart, ver.valEnd, "TSTInfo.version").decimal);
  if (version !== 1) throw new DerError(`unsupported TSTInfo version ${version} (expected 1)`);
  p = ver.next;

  const pol = expectTLV(buf, p, limit, TAG.OID, "TSTInfo.policy OID");
  const policyOID = decodeOID(buf, pol.valStart, pol.valEnd);
  p = pol.next;

  // messageImprint ::= SEQUENCE { hashAlgorithm AlgorithmIdentifier, hashedMessage OCTET STRING }
  const mi = expectTLV(buf, p, limit, TAG.SEQUENCE, "messageImprint SEQUENCE");
  let mp = mi.valStart;
  const alg = expectTLV(buf, mp, mi.valEnd, TAG.SEQUENCE, "hashAlgorithm AlgorithmIdentifier SEQUENCE");
  const algOid = expectTLV(buf, alg.valStart, alg.valEnd, TAG.OID, "hashAlgorithm OID");
  const hashAlgorithmOID = decodeOID(buf, algOid.valStart, algOid.valEnd);
  // (Any AlgorithmIdentifier parameters after the OID — e.g. an explicit NULL — are intentionally ignored.)
  mp = alg.next;
  const hm = expectTLV(buf, mp, mi.valEnd, TAG.OCTET_STRING, "hashedMessage OCTET STRING");
  const hashedMessage = buf.toString("hex", hm.valStart, hm.valEnd);
  p = mi.next;

  const ser = expectTLV(buf, p, limit, TAG.INTEGER, "TSTInfo.serialNumber");
  const serial = decodeUInt(buf, ser.valStart, ser.valEnd, "TSTInfo.serialNumber");
  p = ser.next;

  const gt = expectTLV(buf, p, limit, TAG.GENERALIZED_TIME, "TSTInfo.genTime");
  const time = decodeGeneralizedTime(buf, gt.valStart, gt.valEnd);

  return {
    version,
    policyOID,
    messageImprint: {
      hashAlgorithmOID,
      hashedMessage, // lowercase hex, no 0x
    },
    serialNumber: { hex: serial.hex, decimal: serial.decimal },
    genTime: time.iso,
    genTimeEpochMs: time.epochMs,
  };
}

// ---------------------------------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------------------------------

// parseTimeStampToken(der) -> the extracted TSTInfo field set (see parseTSTInfo). `der` may be a Buffer,
// Uint8Array, or a hex/base64 string. Throws a DerError on any malformed/truncated/non-TSTInfo input.
function parseTimeStampToken(der) {
  const buf = toBuf(der);
  if (buf.length === 0) throw new DerError("empty input");
  const range = reachTSTInfo(buf);
  return parseTSTInfo(buf, range.start, range.end);
}

// bindsDigest({ token, expectedDigestHex, expectedHashOID }) -> boolean.
//   `token` is EITHER raw DER (Buffer/Uint8Array/string) OR an already-parsed object from
//   parseTimeStampToken. Returns true ONLY when the token's messageImprint.hashedMessage equals
//   expectedDigestHex (compared lowercased, exact) AND messageImprint.hashAlgorithmOID equals
//   expectedHashOID. Any mismatch — a different digest, or the same digest under a different hash
//   algorithm — returns false. This is the OFFLINE binding check: it proves WHICH digest the token
//   asserts existed, NOT that the asserting TSA is authentic (that is the out-of-band human trust anchor).
//
//   Returns false (never throws) for a structurally-parsed token that simply doesn't match. It DOES throw
//   if asked to parse raw DER that is malformed (so callers can distinguish "valid token, wrong digest"
//   from "not a token at all").
function bindsDigest({ token, expectedDigestHex, expectedHashOID } = {}) {
  if (token == null) throw new DerError("bindsDigest: token is required");
  if (typeof expectedDigestHex !== "string" || expectedDigestHex.length === 0)
    throw new DerError("bindsDigest: expectedDigestHex (hex string) is required");
  if (typeof expectedHashOID !== "string" || expectedHashOID.length === 0)
    throw new DerError("bindsDigest: expectedHashOID (dotted-decimal string) is required");

  const parsed =
    token && typeof token === "object" && token.messageImprint
      ? token
      : parseTimeStampToken(token);

  const want = expectedDigestHex.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]*$/.test(want) || want.length === 0) return false;

  const got = String(parsed.messageImprint.hashedMessage).toLowerCase();
  if (got !== want) return false;
  if (parsed.messageImprint.hashAlgorithmOID !== expectedHashOID) return false;
  return true;
}

module.exports = {
  OID,
  TAG,
  DerError,
  parseTimeStampToken,
  bindsDigest,
  // Exposed for the test-only minter + potential reuse; not part of the command path's required surface.
  _internal: { readTLV, decodeOID, decodeUInt, decodeGeneralizedTime, reachTSTInfo, parseTSTInfo, toBuf },
};

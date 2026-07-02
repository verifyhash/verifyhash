"use strict";

// trustledger/lib/sha256-vendored.js — a PURE-JS, ZERO-DEPENDENCY SHA-256 (T-65.1).
//
// WHY THIS FILE EXISTS
//   The TrustLedger reconciliation core (ingest -> match -> reconcile -> report -> close) is pure JS with
//   ONE Node-only dependency left on its hot path: close.js took SHA-256 from Node's built-in `crypto` to
//   compute the period-close `inputsDigest`. That is correct in Node but makes the core non-portable — a
//   browser has no Node `crypto` builtin — and the zero-install offline app (EPIC-65) must run the SAME core,
//   byte-for-byte, inside a single HTML file. This module is the missing piece: a from-scratch SHA-256 that
//   `require`s NOTHING (no Node core, no third-party package, no relative module), following the EXACT
//   discipline of verifier/lib/keccak256-vendored.js (T-35.1). It is a drop-in for the one call close.js
//   makes, so every existing `inputsDigest` byte is UNCHANGED.
//
// CORRECTNESS, NOT NOVELTY
//   SHA-256 is the FIXED, standardized FIPS 180-4 algorithm: 64-byte blocks, Merkle–Damgård padding
//   (0x80, zero fill, 64-bit big-endian bit length), the 64 published K round constants (fractional cube
//   roots of the first 64 primes) and 8 published H init words (fractional square roots of the first 8
//   primes). Everything below runs on plain 32-bit JS integer ops (>>> and | keep values in uint32 space;
//   sums of up to five uint32 values stay < 2^53 so plain + is exact before the final >>> 0). This is
//   independent CODE but never an independent ALGORITHM: test/trustledger.browser-core.test.js proves the
//   output byte-identical to Node's `crypto.createHash("sha256")` across the published vectors, every
//   committed fixture file, every committed close artifact, all block-padding edge lengths, and hundreds of
//   random buffers — a single mismatch FAILS the suite, so this file cannot silently diverge.
//
// UTF-8, EXPLICITLY
//   close.js hashes a canonical JSON STRING as UTF-8. Node spells that Buffer.from(s, "utf8"); a browser
//   spells it TextEncoder. To depend on NEITHER, utf8Bytes() below is a from-scratch WHATWG-compatible
//   UTF-8 encoder (surrogate pairs combined; LONE surrogates replaced with U+FFFD — exactly what both
//   Buffer.from(s, "utf8") and TextEncoder produce), cross-checked byte-for-byte against Buffer.from in the
//   same test suite.
//
// REQUIRES NOTHING: a grep of this source finds no CommonJS require call and no bare-name import.
// (Intentional — this property is asserted by test/trustledger.browser-core.test.js.)

// ---- FIPS 180-4 round constants: first 32 bits of the fractional parts of the cube roots of the first
// 64 primes (2..311). Published, fixed, independently checkable against the standard. ----------------------
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

// 32-bit right-rotate (result kept unsigned via >>> 0 at the call sites' final masking).
function rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

// SHA-256 over `bytes` (Uint8Array/Buffer/array of byte values), returning a 32-byte Uint8Array.
function sha256Bytes(bytes) {
  const len = bytes.length;

  // ---- pad: 0x80, zero fill to 56 mod 64, then the 64-bit big-endian BIT length --------------------------
  const total = Math.ceil((len + 9) / 64) * 64;
  const msg = new Uint8Array(total); // zero-filled by construction
  for (let i = 0; i < len; i++) msg[i] = bytes[i] & 0xff;
  msg[len] = 0x80;
  // Bit length as two 32-bit big-endian words. len < 2^53 in JS; the high word is floor(len*8 / 2^32)
  // = floor(len / 2^29), the low word is (len*8) mod 2^32 (which is exactly what << gives).
  const hiBits = Math.floor(len / 0x20000000);
  const loBits = (len << 3) >>> 0;
  msg[total - 8] = (hiBits >>> 24) & 0xff;
  msg[total - 7] = (hiBits >>> 16) & 0xff;
  msg[total - 6] = (hiBits >>> 8) & 0xff;
  msg[total - 5] = hiBits & 0xff;
  msg[total - 4] = (loBits >>> 24) & 0xff;
  msg[total - 3] = (loBits >>> 16) & 0xff;
  msg[total - 2] = (loBits >>> 8) & 0xff;
  msg[total - 1] = loBits & 0xff;

  // ---- FIPS 180-4 initial hash value ---------------------------------------------------------------------
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const w = new Array(64);

  // ---- compress each 64-byte block -----------------------------------------------------------------------
  for (let off = 0; off < total; off += 64) {
    // message schedule: 16 big-endian words from the block, expanded to 64
    for (let i = 0; i < 16; i++) {
      const b = off + i * 4;
      w[i] = ((msg[b] << 24) | (msg[b + 1] << 16) | (msg[b + 2] << 8) | msg[b + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  // ---- emit the 8 words big-endian ------------------------------------------------------------------------
  const out = new Uint8Array(32);
  const hs = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (hs[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (hs[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (hs[i] >>> 8) & 0xff;
    out[i * 4 + 3] = hs[i] & 0xff;
  }
  return out;
}

// Lowercase hex (no 0x prefix) of a byte array — matches crypto's .digest("hex").
function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] & 0xff;
    s += (b < 16 ? "0" : "") + b.toString(16);
  }
  return s;
}

/**
 * WHATWG/Node-compatible UTF-8 encoder for a JS string: surrogate pairs are combined into their
 * astral code point; LONE surrogates are replaced with U+FFFD (byte-for-byte what BOTH
 * Buffer.from(s, "utf8") and TextEncoder emit). Pure; no TextEncoder, no Buffer.
 * @param {string} str the JS (UTF-16) string to encode
 * @returns {Uint8Array} the UTF-8 bytes
 */
function utf8Bytes(str) {
  if (typeof str !== "string") {
    throw new TypeError("utf8Bytes requires a string");
  }
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      // high surrogate: pair with a following low surrogate, else U+FFFD
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      // lone low surrogate
      cp = 0xfffd;
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
    }
  }
  return Uint8Array.from(out);
}

/**
 * SHA-256 over a byte buffer.
 * @param {Uint8Array|Buffer|number[]} bytes input bytes
 * @returns {Uint8Array} the 32-byte digest
 */
function sha256(bytes) {
  if (
    !(bytes instanceof Uint8Array) &&
    !Array.isArray(bytes) &&
    !(typeof Buffer !== "undefined" && Buffer.isBuffer && Buffer.isBuffer(bytes))
  ) {
    throw new TypeError("sha256 requires a Uint8Array/Buffer/byte-array of input bytes");
  }
  return sha256Bytes(bytes);
}

/**
 * SHA-256 over a byte buffer, returned as a lowercase hex string WITHOUT a 0x prefix
 * (matching crypto.createHash("sha256").update(bytes).digest("hex"), for drop-in cross-checking).
 * @param {Uint8Array|Buffer|number[]} bytes input bytes
 * @returns {string} 64-char lowercase hex
 */
function sha256Hex(bytes) {
  return toHex(sha256(bytes));
}

/**
 * SHA-256 of a JS string's UTF-8 bytes, as lowercase hex — the exact drop-in for
 * crypto.createHash("sha256").update(str, "utf8").digest("hex") (the one call close.js makes).
 * @param {string} str the string to hash as UTF-8
 * @returns {string} 64-char lowercase hex
 */
function sha256HexUtf8(str) {
  return toHex(sha256Bytes(utf8Bytes(str)));
}

module.exports = { sha256, sha256Hex, sha256HexUtf8, utf8Bytes };

"use strict";

// test/verifier.keccak-vendored.test.js — T-35.1: PROVE the vendored, zero-dependency keccak256 is
// byte-identical to BOTH the audited `js-sha3` package AND the production `ethers` keccak path.
//
// WHY THIS TEST EXISTS
//   verifier/lib/keccak256-vendored.js is a from-scratch keccak256 with NO runtime dependency — the last
//   piece needed to inline the free verifier into one self-contained, zero-install file (EPIC-35). A second
//   implementation of a hash is only safe if it can NEVER silently diverge from the standard. So this suite
//   is the anti-divergence guard: for the empty input, every known fixed vector, AND >=500 random buffers
//   of varied length, the vendored digest must equal BOTH references EXACTLY. A single mismatch FAILS the
//   whole suite. It also locks the file's "requires nothing" property in code (a grep finds no require()).

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// REFERENCE #1: the audited, dependency-free js-sha3 package (the SAME primitive ethers uses under the hood,
// and what verifier/lib/keccak.js wraps today).
const { keccak256: jsSha3Keccak } = require("js-sha3");
// REFERENCE #2: the production ethers keccak path (what the whole producer stack actually hashes with).
const { keccak256: ethersKeccak } = require("ethers");

// THE CODE UNDER TEST: the vendored, zero-dependency implementation. Loaded by path so we can assert it
// lives under verifier/lib and grep its source.
const VENDORED_PATH = path.resolve(__dirname, "..", "verifier", "lib", "keccak256-vendored.js");
const vendored = require(VENDORED_PATH);
const { keccak256: vKeccak, keccak256Hex: vKeccakHex } = vendored;

// Reference digests as lowercase hex (no 0x), to compare against the vendored hex output.
function jsSha3Hex(bytes) {
  return jsSha3Keccak.create().update(bytes).hex();
}
function ethersHex(bytes) {
  return ethersKeccak(bytes).slice(2); // strip 0x
}
function toHex(u8) {
  return Buffer.from(u8).toString("hex");
}

describe("vendored keccak256: byte-identical to js-sha3 AND ethers, zero deps (T-35.1)", function () {
  describe("the vendored module is genuinely dependency-free (source-level)", function () {
    it("its source contains no require( and no bare-name import", function () {
      const src = fs.readFileSync(VENDORED_PATH, "utf8");
      // No CommonJS require() of any kind.
      expect(src, "vendored keccak must not require() anything").to.not.match(/\brequire\s*\(/);
      // No ESM import of a bare module name (a relative './x' would also be a dependency we forbid here).
      expect(src, "vendored keccak must not import anything").to.not.match(/^\s*import\s/m);
    });

    it("the vendored API shape matches the wrapper it replaces (Uint8Array out, hex helper)", function () {
      const out = vKeccak(new Uint8Array([]));
      expect(out).to.be.instanceOf(Uint8Array);
      expect(out.length, "keccak256 emits a 32-byte digest").to.equal(32);
      expect(vKeccakHex(new Uint8Array([])), "hex helper is 64 lowercase hex chars").to.match(
        /^[0-9a-f]{64}$/
      );
    });

    it("rejects non-byte-buffer input with a TypeError", function () {
      expect(() => vKeccak("not bytes")).to.throw(TypeError);
      expect(() => vKeccak(123)).to.throw(TypeError);
      expect(() => vKeccak(null)).to.throw(TypeError);
    });
  });

  describe("(a) the empty input", function () {
    it("vendored('') equals js-sha3 AND ethers, and is the canonical empty-keccak constant", function () {
      const empty = new Uint8Array([]);
      const v = vKeccakHex(empty);
      expect(v, "vendored == js-sha3 (empty)").to.equal(jsSha3Hex(empty));
      expect(v, "vendored == ethers (empty)").to.equal(ethersHex(empty));
      // The well-known keccak256 of the empty string.
      expect(v).to.equal("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    });
  });

  describe("(b) known/fixed keccak256 test vectors", function () {
    // Canonical keccak256 vectors (ASCII message -> expected lowercase hex digest). These are independently
    // verifiable against any keccak256 reference (etherscan, web3, solidity keccak256, etc.).
    const KNOWN = [
      ["", "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
      ["abc", "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"],
      [
        "The quick brown fox jumps over the lazy dog",
        "4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15",
      ],
      [
        "The quick brown fox jumps over the lazy dog.",
        "578951e24efd62a3d63a86f7cd19aaa53c898fe287d2552133220370240b572d",
      ],
      // Exactly one rate-block-minus-one, exactly the rate, and just over: stresses the padding/absorb edge.
      ["a".repeat(135), null],
      ["a".repeat(136), null],
      ["a".repeat(137), null],
    ];

    it("matches every fixed vector, and (where a literal digest is given) the published constant", function () {
      for (const [msg, expectedHex] of KNOWN) {
        const bytes = Buffer.from(msg, "utf8");
        const v = vKeccakHex(bytes);
        expect(v, `vendored vs js-sha3 for ${JSON.stringify(msg.slice(0, 16))}`).to.equal(
          jsSha3Hex(bytes)
        );
        expect(v, `vendored vs ethers for ${JSON.stringify(msg.slice(0, 16))}`).to.equal(
          ethersHex(bytes)
        );
        if (expectedHex) {
          expect(v, `vendored vs published constant for ${JSON.stringify(msg.slice(0, 16))}`).to.equal(
            expectedHex
          );
        }
      }
    });

    it("matches across many byte-length boundaries around the 136-byte rate (block edges)", function () {
      // Deterministic (non-random) content so a failure here is reproducible. Lengths span 0..~5 blocks
      // plus the exact block boundaries where absorb/padding logic is most fragile.
      const lengths = [0, 1, 2, 7, 8, 9, 31, 32, 33, 63, 64, 135, 136, 137, 271, 272, 273, 408, 544, 680];
      for (const len of lengths) {
        const buf = Buffer.alloc(len);
        for (let i = 0; i < len; i++) buf[i] = (i * 31 + 7) & 0xff; // deterministic fill
        const v = vKeccakHex(buf);
        expect(v, `vendored vs js-sha3 at len ${len}`).to.equal(jsSha3Hex(buf));
        expect(v, `vendored vs ethers at len ${len}`).to.equal(ethersHex(buf));
      }
    });

    it("the Uint8Array digest equals the hex helper (internal consistency)", function () {
      const buf = Buffer.from("verifyhash", "utf8");
      expect(toHex(vKeccak(buf))).to.equal(vKeccakHex(buf));
    });
  });

  describe("(c) >=500 random byte buffers of varied length — a single mismatch FAILS", function () {
    it("vendored == js-sha3 == ethers for 750 random buffers (0..1024 bytes)", function () {
      const N = 750; // comfortably exceeds the >=500 acceptance bar
      let checked = 0;
      let maxLen = 0;
      for (let i = 0; i < N; i++) {
        // Varied length 0..1024 so we span single-block, multi-block, and exact-boundary cases.
        const len = crypto.randomBytes(2).readUInt16BE(0) % 1025;
        const buf = crypto.randomBytes(len);
        maxLen = Math.max(maxLen, len);
        const v = vKeccakHex(buf);
        // ONE assertion against EACH reference; any single mismatch throws and fails the suite.
        expect(v, `vendored vs js-sha3 (iter ${i}, len ${len}, data ${buf.toString("hex")})`).to.equal(
          jsSha3Hex(buf)
        );
        expect(v, `vendored vs ethers (iter ${i}, len ${len}, data ${buf.toString("hex")})`).to.equal(
          ethersHex(buf)
        );
        checked++;
      }
      expect(checked, "ran the full random battery").to.equal(N);
      expect(N, "random battery exceeds the >=500 acceptance bar").to.be.greaterThanOrEqual(500);
      // Make sure we actually exercised multi-block inputs (not vacuously all tiny).
      expect(maxLen, "exercised buffers larger than one keccak rate block").to.be.greaterThan(136);
    });

    it("a deliberately WRONG digest would be caught (the cross-check is not vacuous)", function () {
      // Sanity: corrupting one nibble of the reference makes the equality assertion fail — proving the
      // comparison has teeth and isn't comparing a value to itself.
      const buf = Buffer.from("teeth-check", "utf8");
      const good = vKeccakHex(buf);
      const corrupted = (good[0] === "0" ? "1" : "0") + good.slice(1);
      expect(corrupted).to.not.equal(good);
      expect(good).to.equal(jsSha3Hex(buf)); // the real one still agrees
    });
  });
});

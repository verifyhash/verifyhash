"use strict";

// verifier/lib/keccak.js — the keccak256 used by the INDEPENDENT verifier core.
//
// WHY A SHIM (and not a re-implementation)
//   The whole point of `verifier/` is to be an INDEPENDENT re-derivation of the family's crypto that can
//   be CROSS-CHECKED against the production (ethers) path, so the two can never silently diverge. keccak256
//   is a fixed, standardized permutation; re-rolling it by hand would add risk, not independence. So we
//   take it from `js-sha3` — an audited, dependency-free implementation that is ALREADY a direct dependency
//   of this project (package.json), and is the SAME primitive ethers itself uses under the hood. The
//   independence that matters for the anti-divergence guard is the EIP-191 framing + secp256k1 recovery +
//   canonical serialization, all of which `verifier/` implements WITHOUT ethers/hardhat. This file has NO
//   dependency on `cli/` or `trustledger/`.

const { keccak256: keccakHex } = require("js-sha3");

/**
 * keccak256 over a byte buffer, returning a 32-byte Buffer.
 * @param {Buffer|Uint8Array} bytes
 * @returns {Buffer} the 32-byte digest
 */
function keccak256(bytes) {
  if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) {
    throw new TypeError("keccak256 requires a Buffer/Uint8Array of input bytes");
  }
  // js-sha3's keccak256 accepts a byte array and returns a lowercase hex string (no 0x).
  return Buffer.from(keccakHex.create().update(bytes).hex(), "hex");
}

module.exports = { keccak256 };

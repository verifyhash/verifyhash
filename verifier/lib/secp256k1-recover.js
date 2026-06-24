"use strict";

// verifier/lib/secp256k1-recover.js — INDEPENDENT EIP-191 personal_sign signer recovery.
//
// WHY THIS EXISTS
//   `verifier/` is a near-zero-dependency, SECOND implementation of the family's signature recovery, kept
//   deliberately separate from the production ethers path so the two can be CROSS-CHECKED and can never
//   silently drift (the anti-divergence guard in test/verifier.crypto.test.js). This file recovers the
//   secp256k1 signer ADDRESS from an `eip191-personal-sign` 65-byte (r||s||v) signature over a message,
//   using ONLY:
//     * `js-sha3` (via ./keccak) for keccak256, and
//     * a single, tiny, vendored elliptic-curve routine (below) for the secp256k1 public-key RECOVERY.
//   It does NOT require `ethers`, `hardhat`, `cli/`, or `trustledger/`.
//
// THE secp256k1 ROUTINE (vendored, audited, standard)
//   Public-key recovery from an ECDSA signature is textbook curve math over the secp256k1 group
//   (SEC 1, §4.1.6 / §2.3). We implement exactly that with Node BigInt: affine point add/double on
//   y^2 = x^3 + 7 (mod p), a constant-time-agnostic double-and-add scalar multiply, and a Tonelli-Shanks
//   style square root (p ≡ 3 mod 4, so √a = a^((p+1)/4)). No randomness, no secrets — recovery is a PUBLIC
//   computation over the signature + message hash, so timing/side-channels are irrelevant here. The curve
//   constants are the canonical secp256k1 domain parameters.

const { keccak256 } = require("./keccak");

// ---- secp256k1 domain parameters (canonical) -------------------------------------------------------
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn; // field prime
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n; // group order
const A = 0n; // curve a
const B = 7n; // curve b
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

// ---- modular arithmetic helpers --------------------------------------------------------------------
function mod(a, m) {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

// Modular inverse via the extended Euclidean algorithm (m is prime here, so a is invertible unless 0).
function invmod(a, m) {
  a = mod(a, m);
  if (a === 0n) throw new Error("secp256k1: inverse of zero");
  let [old_r, r] = [a, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return mod(old_s, m);
}

// Modular exponentiation (square-and-multiply).
function powmod(base, exp, m) {
  base = mod(base, m);
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = mod(result * base, m);
    base = mod(base * base, m);
    exp >>= 1n;
  }
  return result;
}

// Square root mod p. secp256k1's p ≡ 3 (mod 4), so √a = a^((p+1)/4) mod p (when a is a QR).
function sqrtmod(a) {
  const r = powmod(a, (P + 1n) / 4n, P);
  if (mod(r * r, P) !== mod(a, P)) throw new Error("secp256k1: no square root (x not on curve)");
  return r;
}

// ---- elliptic-curve point arithmetic (affine; null = point at infinity) ---------------------------
const INF = null;

function isInf(Pt) {
  return Pt === INF;
}

function pointAdd(p1, p2) {
  if (isInf(p1)) return p2;
  if (isInf(p2)) return p1;
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  if (x1 === x2 && mod(y1 + y2, P) === 0n) return INF; // p1 = -p2
  let m;
  if (x1 === x2 && y1 === y2) {
    // doubling: m = (3x^2 + a) / (2y)
    m = mod((3n * x1 * x1 + A) * invmod(2n * y1, P), P);
  } else {
    m = mod((y2 - y1) * invmod(x2 - x1, P), P);
  }
  const x3 = mod(m * m - x1 - x2, P);
  const y3 = mod(m * (x1 - x3) - y1, P);
  return [x3, y3];
}

function scalarMul(k, point) {
  k = mod(k, N);
  let result = INF;
  let addend = point;
  while (k > 0n) {
    if (k & 1n) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    k >>= 1n;
  }
  return result;
}

const G = [GX, GY];

// Decompress the curve point with x-coordinate `x` and the given y-parity (0 = even, 1 = odd).
function liftX(x, yParity) {
  const alpha = mod(x * x * x + A * x + B, P); // y^2
  let y = sqrtmod(alpha);
  if ((y & 1n) !== BigInt(yParity)) y = mod(P - y, P);
  return [x, y];
}

// ---- big-endian buffer <-> BigInt ------------------------------------------------------------------
function bufToBig(buf) {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n;
}

function bigTo32(n) {
  const out = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/**
 * Recover the secp256k1 PUBLIC KEY from an ECDSA signature + 32-byte message hash (SEC 1, §4.1.6).
 * @param {Buffer} msgHash 32-byte hash that was signed
 * @param {bigint} r       signature r
 * @param {bigint} s       signature s
 * @param {number} recId   recovery id 0..3 (derived from v)
 * @returns {{x: bigint, y: bigint}} the recovered public-key point
 */
function recoverPublicKey(msgHash, r, s, recId) {
  if (r <= 0n || r >= N) throw new Error("secp256k1: r out of range");
  if (s <= 0n || s >= N) throw new Error("secp256k1: s out of range");
  if (recId < 0 || recId > 3) throw new Error("secp256k1: invalid recovery id");

  // x = r + (recId >> 1) * N  (the high bit of recId says whether r overflowed the field by one order)
  const x = r + (recId >> 1 ? N : 0n);
  if (x >= P) throw new Error("secp256k1: recovered x not in field");

  // R = point with x-coordinate x and y-parity = (recId & 1).
  const R = liftX(x, recId & 1);

  // Q = r^-1 (s*R - e*G), where e = msgHash mod N.
  const e = mod(bufToBig(msgHash), N);
  const rInv = invmod(r, N);
  const sR = scalarMul(s, R);
  const eG = scalarMul(e, G);
  const negEG = isInf(eG) ? INF : [eG[0], mod(P - eG[1], P)];
  const Q = scalarMul(rInv, pointAdd(sR, negEG));
  if (isInf(Q)) throw new Error("secp256k1: recovered point at infinity");
  return { x: Q[0], y: Q[1] };
}

/**
 * Derive the lowercase 0x Ethereum address from a recovered public-key point.
 * address = "0x" + last 20 bytes of keccak256( X(32) || Y(32) ).
 */
function pubKeyToAddress(pub) {
  const raw = Buffer.concat([bigTo32(pub.x), bigTo32(pub.y)]); // 64-byte uncompressed (no 0x04 prefix)
  const hash = keccak256(raw);
  return "0x" + hash.slice(12).toString("hex");
}

/**
 * Build the EIP-191 personal_sign pre-image for a message and return its keccak256 digest.
 *
 * EIP-191 personal_sign: keccak256( "\x19Ethereum Signed Message:\n" + <decimal byte length> + <message> ),
 * where <message> is the EXACT canonical UTF-8 bytes (here, the canonical attestation string including its
 * single trailing newline). This reproduces, byte-for-byte, what `cli/core/attestation.js` documents and
 * what ethers' personal_sign hashes.
 *
 * @param {Buffer|Uint8Array|string} message UTF-8 message (string is encoded as UTF-8)
 * @returns {Buffer} the 32-byte EIP-191 digest
 */
function eip191Hash(message) {
  const msgBytes = Buffer.isBuffer(message)
    ? message
    : message instanceof Uint8Array
    ? Buffer.from(message)
    : Buffer.from(String(message), "utf8");
  const prefix = Buffer.from("\x19Ethereum Signed Message:\n" + msgBytes.length, "utf8");
  return keccak256(Buffer.concat([prefix, msgBytes]));
}

/**
 * Recover the lowercase 0x signer ADDRESS from an `eip191-personal-sign` 65-byte (r||s||v) signature over
 * `message`. INDEPENDENT of ethers/hardhat — only ./keccak (js-sha3) + the vendored secp256k1 above.
 *
 * @param {Buffer|Uint8Array|string} message    the EXACT canonical UTF-8 bytes that were signed
 * @param {string|Buffer|Uint8Array} signature  65-byte r(32)||s(32)||v(1), as 0x-hex or raw bytes
 * @returns {string} the recovered signer address, 0x-prefixed lowercase
 */
function recoverPersonalSignAddress(message, signature) {
  const sig = normalizeSig(signature);
  const r = bufToBig(sig.subarray(0, 32));
  const s = bufToBig(sig.subarray(32, 64));
  let v = sig[64];
  // Accept v in {0,1} or {27,28} (and EIP-155-ish higher v reduced to parity). recId is v's low bit.
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) {
    // Fall back to parity for any non-canonical encoding; reject only the wildly invalid.
    v = v & 1;
  }
  const digest = eip191Hash(message);
  const pub = recoverPublicKey(digest, r, s, v);
  return pubKeyToAddress(pub);
}

function normalizeSig(signature) {
  let buf;
  if (Buffer.isBuffer(signature)) {
    buf = signature;
  } else if (signature instanceof Uint8Array) {
    buf = Buffer.from(signature);
  } else if (typeof signature === "string") {
    const hex = signature.startsWith("0x") || signature.startsWith("0X") ? signature.slice(2) : signature;
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
      throw new Error("secp256k1: signature must be 0x-hex (even length)");
    }
    buf = Buffer.from(hex, "hex");
  } else {
    throw new TypeError("secp256k1: signature must be a 0x-hex string or byte buffer");
  }
  if (buf.length !== 65) {
    throw new Error(`secp256k1: eip191-personal-sign signature must be 65 bytes (r||s||v), got ${buf.length}`);
  }
  return buf;
}

module.exports = {
  recoverPersonalSignAddress,
  eip191Hash,
  recoverPublicKey,
  pubKeyToAddress,
  // exported for tests/audit:
  _internal: { mod, invmod, powmod, sqrtmod, pointAdd, scalarMul, liftX, G, N, P },
};

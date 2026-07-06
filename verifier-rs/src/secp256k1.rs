//! secp256k1 ECDSA public-key recovery (SEC 1 §4.1.6), curve y² = x³ + 7 mod p.
//!
//! Affine coordinates, matching the reference math directly. Modular inverses
//! come from `field::inv_mod` (binary ext-euclid), so per-point-op inversions
//! are cheap and the whole recovery stays well under a second.

use crate::field::{add_mod, inv_mod, mul_mod, pow_mod, sub_mod, U256};
use crate::keccak::keccak256;

// Field prime p.
const P: U256 = U256([
    0xFFFFFFFEFFFFFC2F,
    0xFFFFFFFFFFFFFFFF,
    0xFFFFFFFFFFFFFFFF,
    0xFFFFFFFFFFFFFFFF,
]);
// Group order n.
const N: U256 = U256([
    0xBFD25E8CD0364141,
    0xBAAEDCE6AF48A03B,
    0xFFFFFFFFFFFFFFFE,
    0xFFFFFFFFFFFFFFFF,
]);
// Generator G = (GX, GY).
const GX: U256 = U256([
    0x59F2815B16F81798,
    0x029BFCDB2DCE28D9,
    0x55A06295CE870B07,
    0x79BE667EF9DCBBAC,
]);
const GY: U256 = U256([
    0x9C47D08FFB10D4B8,
    0xFD17B448A6855419,
    0x5DA4FBFC0E1108A8,
    0x483ADA7726A3C465,
]);

/// An affine point, or the point at infinity (`None`).
type Point = Option<(U256, U256)>;

/// EC addition (handles the doubling and inverse cases like the reference).
fn point_add(p1: Point, p2: Point) -> Point {
    let (x1, y1) = match p1 {
        None => return p2,
        Some(p) => p,
    };
    let (x2, y2) = match p2 {
        None => return p1,
        Some(p) => p,
    };

    if x1 == x2 {
        // P + (-P) = O
        if add_mod(&y1, &y2, &P).is_zero() {
            return None;
        }
        // Otherwise it's a genuine doubling (y1 == y2, y1 != 0).
    }

    let lambda = if x1 == x2 && y1 == y2 {
        // (3*x1^2) / (2*y1)
        let x_sq = mul_mod(&x1, &x1, &P);
        let three_x_sq = add_mod(&add_mod(&x_sq, &x_sq, &P), &x_sq, &P);
        let two_y = add_mod(&y1, &y1, &P);
        mul_mod(&three_x_sq, &inv_mod(&two_y, &P), &P)
    } else {
        // (y2 - y1) / (x2 - x1)
        let num = sub_mod(&y2, &y1, &P);
        let den = sub_mod(&x2, &x1, &P);
        mul_mod(&num, &inv_mod(&den, &P), &P)
    };

    // x3 = lambda^2 - x1 - x2
    let lambda_sq = mul_mod(&lambda, &lambda, &P);
    let x3 = sub_mod(&sub_mod(&lambda_sq, &x1, &P), &x2, &P);
    // y3 = lambda*(x1 - x3) - y1
    let y3 = sub_mod(&mul_mod(&lambda, &sub_mod(&x1, &x3, &P), &P), &y1, &P);
    Some((x3, y3))
}

/// k * point via double-and-add. `k` is reduced mod n first.
fn scalar_mul(k: &U256, point: Point) -> Point {
    // Reduce k mod n (k < 2^256 < 2n, so at most one subtraction).
    let k = if *k >= N { k.sbb(&N).0 } else { *k };
    let mut result: Point = None;
    for i in (0..256).rev() {
        result = point_add(result, result); // double
        if k.bit(i) {
            result = point_add(result, point);
        }
    }
    result
}

/// (p + 1) / 4, the sqrt exponent (valid since p ≡ 3 mod 4).
fn sqrt_exponent() -> U256 {
    let (p1, _) = P.adc(&U256::ONE);
    p1.shr1().shr1()
}

/// Lift x to a curve point with the requested low-bit parity of y.
fn lift_x(x: &U256, y_parity: u64) -> Option<(U256, U256)> {
    // alpha = x^3 + 7 mod p
    let x2 = mul_mod(x, x, &P);
    let x3 = mul_mod(&x2, x, &P);
    let seven = U256([7, 0, 0, 0]);
    let alpha = add_mod(&x3, &seven, &P);

    let mut y = pow_mod(&alpha, &sqrt_exponent(), &P);
    // Verify it is a genuine square root.
    if mul_mod(&y, &y, &P) != alpha {
        return None;
    }
    if (y.0[0] & 1) != y_parity {
        y = P.sbb(&y).0; // p - y
    }
    Some((*x, y))
}

/// Recover the public-key point Q from (msg_hash, r, s, rec_id).
/// Returns `None` on any failure (out-of-range, off-curve, point at infinity).
fn recover_pubkey(msg_hash: &[u8; 32], r: &U256, s: &U256, rec_id: u8) -> Point {
    if r.is_zero() || *r >= N {
        return None;
    }
    if s.is_zero() || *s >= N {
        return None;
    }
    if rec_id > 3 {
        return None;
    }

    // x = r + (rec_id>>1 ? n : 0); reject if x >= p.
    let x = if rec_id >> 1 == 1 {
        let (sum, carry) = r.adc(&N);
        if carry {
            return None; // >= 2^256 > p
        }
        sum
    } else {
        *r
    };
    if x >= P {
        return None;
    }

    let point_r = lift_x(&x, (rec_id & 1) as u64)?;

    // e = msg_hash mod n
    let e_full = U256::from_be_bytes(msg_hash);
    let e = if e_full >= N { e_full.sbb(&N).0 } else { e_full };

    let r_inv = inv_mod(r, &N);
    let s_r = scalar_mul(s, Some(point_r));
    let e_g = scalar_mul(&e, Some((GX, GY)));
    let neg_e_g = e_g.map(|(x, y)| (x, P.sbb(&y).0));

    // Q = r^{-1} * (s*R - e*G)
    let q = scalar_mul(&r_inv, point_add(s_r, neg_e_g));
    q
}

/// keccak256("\x19Ethereum Signed Message:\n" + len + message).
pub fn eip191_hash(message: &[u8]) -> [u8; 32] {
    let mut preimage = Vec::new();
    preimage.extend_from_slice(b"\x19Ethereum Signed Message:\n");
    preimage.extend_from_slice(message.len().to_string().as_bytes());
    preimage.extend_from_slice(message);
    keccak256(&preimage)
}

/// Recover the lowercase `0x…` signer address for an EIP-191 personal_sign
/// signature, or `None` if the signature is unrecoverable.
///
/// `sig` is 65 bytes: r(32) ‖ s(32) ‖ v(1), all big-endian.
pub fn recover_personal_sign(message: &[u8], sig: &[u8]) -> Option<String> {
    if sig.len() != 65 {
        return None;
    }
    let mut r_bytes = [0u8; 32];
    let mut s_bytes = [0u8; 32];
    r_bytes.copy_from_slice(&sig[0..32]);
    s_bytes.copy_from_slice(&sig[32..64]);
    let r = U256::from_be_bytes(&r_bytes);
    let s = U256::from_be_bytes(&s_bytes);

    let mut v = sig[64];
    if v >= 27 {
        v -= 27;
    }
    if v != 0 && v != 1 {
        v &= 1;
    }

    let digest = eip191_hash(message);
    let (qx, qy) = recover_pubkey(&digest, &r, &s, v)?;

    // address = keccak256(X(32) ‖ Y(32))[12..32], lowercase.
    let mut raw = [0u8; 64];
    raw[0..32].copy_from_slice(&qx.to_be_bytes());
    raw[32..64].copy_from_slice(&qy.to_be_bytes());
    let h = keccak256(&raw);
    let mut addr = String::from("0x");
    for &b in &h[12..32] {
        addr.push_str(&format!("{:02x}", b));
    }
    Some(addr)
}

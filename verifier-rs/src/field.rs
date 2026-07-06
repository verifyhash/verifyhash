//! Fixed 256-bit unsigned integer with modular arithmetic.
//!
//! Rust's std has no bignum, so this is a hand-rolled four-`u64`-limb field
//! type (limb[0] is least significant). It carries just enough to do the
//! modular arithmetic secp256k1 recovery needs: add/sub/mul/pow/inverse modulo
//! an odd 256-bit prime (used with both `p` and the group order `n`).

use std::cmp::Ordering;

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct U256(pub [u64; 4]);

impl U256 {
    pub const ZERO: U256 = U256([0, 0, 0, 0]);
    pub const ONE: U256 = U256([1, 0, 0, 0]);

    pub fn from_be_bytes(b: &[u8; 32]) -> U256 {
        let mut limbs = [0u64; 4];
        for i in 0..4 {
            let mut v = 0u64;
            for j in 0..8 {
                v = (v << 8) | b[i * 8 + j] as u64;
            }
            limbs[3 - i] = v;
        }
        U256(limbs)
    }

    pub fn to_be_bytes(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        for i in 0..4 {
            let v = self.0[3 - i];
            for j in 0..8 {
                out[i * 8 + j] = (v >> (8 * (7 - j))) as u8;
            }
        }
        out
    }

    pub fn is_zero(&self) -> bool {
        self.0 == [0u64; 4]
    }

    pub fn is_even(&self) -> bool {
        self.0[0] & 1 == 0
    }

    /// Bit `i` (0 = least significant).
    pub fn bit(&self, i: usize) -> bool {
        (self.0[i / 64] >> (i % 64)) & 1 == 1
    }

    /// Logical shift right by one bit.
    pub fn shr1(&self) -> U256 {
        let mut r = [0u64; 4];
        for i in 0..4 {
            r[i] = self.0[i] >> 1;
            if i < 3 {
                r[i] |= self.0[i + 1] << 63;
            }
        }
        U256(r)
    }

    /// Add with carry-out.
    pub fn adc(&self, o: &U256) -> (U256, bool) {
        let mut r = [0u64; 4];
        let mut carry = 0u128;
        for i in 0..4 {
            let s = self.0[i] as u128 + o.0[i] as u128 + carry;
            r[i] = s as u64;
            carry = s >> 64;
        }
        (U256(r), carry != 0)
    }

    /// Subtract with borrow-out.
    pub fn sbb(&self, o: &U256) -> (U256, bool) {
        let mut r = [0u64; 4];
        let mut borrow = 0i128;
        for i in 0..4 {
            let d = self.0[i] as i128 - o.0[i] as i128 - borrow;
            if d < 0 {
                r[i] = (d + (1i128 << 64)) as u64;
                borrow = 1;
            } else {
                r[i] = d as u64;
                borrow = 0;
            }
        }
        (U256(r), borrow != 0)
    }
}

impl PartialOrd for U256 {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for U256 {
    fn cmp(&self, other: &Self) -> Ordering {
        for i in (0..4).rev() {
            match self.0[i].cmp(&other.0[i]) {
                Ordering::Equal => continue,
                non_eq => return non_eq,
            }
        }
        Ordering::Equal
    }
}

/// Reduce a value known to be < 2*m into [0, m).
fn reduce_once(a: &U256, m: &U256) -> U256 {
    if a >= m {
        a.sbb(m).0
    } else {
        *a
    }
}

/// (a + b) mod m, with a, b < m.
pub fn add_mod(a: &U256, b: &U256, m: &U256) -> U256 {
    let (s, carry) = a.adc(b);
    // a + b < 2m < 2^257. If it overflowed 256 bits (carry) OR the low word
    // is already >= m, a single subtraction of m lands it back in [0, m).
    if carry || s >= *m {
        s.sbb(m).0
    } else {
        s
    }
}

/// (a - b) mod m, with a, b < m.
pub fn sub_mod(a: &U256, b: &U256, m: &U256) -> U256 {
    let (d, borrow) = a.sbb(b);
    if borrow {
        d.adc(m).0
    } else {
        d
    }
}

/// (a * b) mod m via double-and-add (no 512-bit intermediate needed).
pub fn mul_mod(a: &U256, b: &U256, m: &U256) -> U256 {
    let a = reduce_once(a, m);
    let mut acc = U256::ZERO;
    for i in (0..256).rev() {
        acc = add_mod(&acc, &acc, m); // double
        if b.bit(i) {
            acc = add_mod(&acc, &a, m);
        }
    }
    acc
}

/// (base ^ exp) mod m via square-and-multiply.
pub fn pow_mod(base: &U256, exp: &U256, m: &U256) -> U256 {
    let base = reduce_once(base, m);
    let mut result = U256::ONE;
    for i in (0..256).rev() {
        result = mul_mod(&result, &result, m);
        if exp.bit(i) {
            result = mul_mod(&result, &base, m);
        }
    }
    result
}

/// a/2 mod m (m odd).
fn half_mod(a: &U256, m: &U256) -> U256 {
    if a.is_even() {
        a.shr1()
    } else {
        // a is odd, m is odd, so a + m is even; (a+m)/2 fits in 256 bits.
        let (s, carry) = a.adc(m);
        let mut r = s.shr1();
        if carry {
            r.0[3] |= 1u64 << 63;
        }
        r
    }
}

/// Modular inverse via the binary extended Euclidean algorithm (HAC 14.61).
/// Requires `a` invertible mod the odd modulus `m` (i.e. gcd(a, m) = 1).
pub fn inv_mod(a: &U256, m: &U256) -> U256 {
    let mut u = reduce_once(a, m);
    let mut v = *m;
    let mut x1 = U256::ONE;
    let mut x2 = U256::ZERO;

    while u != U256::ONE && v != U256::ONE {
        while u.is_even() {
            u = u.shr1();
            x1 = half_mod(&x1, m);
        }
        while v.is_even() {
            v = v.shr1();
            x2 = half_mod(&x2, m);
        }
        if u >= v {
            u = u.sbb(&v).0;
            x1 = sub_mod(&x1, &x2, m);
        } else {
            v = v.sbb(&u).0;
            x2 = sub_mod(&x2, &x1, m);
        }
    }

    if u == U256::ONE {
        x1
    } else {
        x2
    }
}

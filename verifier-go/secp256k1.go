package main

// Pure-Go secp256k1 ECDSA public-key recovery (SEC 1 v2.0 §4.1.6), built on
// math/big because the Go standard library ships no secp256k1 curve. Only the
// operations needed to recover an EIP-191 personal_sign address are provided:
// affine point add/double, scalar multiply, x-coordinate lift, and recovery.

import (
	"encoding/hex"
	"errors"
	"math/big"
	"strconv"
)

// secp256k1 domain parameters (short Weierstrass y^2 = x^3 + 7 over F_p).
var (
	secpP  = mustHex("fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f")
	secpN  = mustHex("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141")
	secpGx = mustHex("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")
	secpGy = mustHex("483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")

	big0 = big.NewInt(0)
	big1 = big.NewInt(1)
	big2 = big.NewInt(2)
	big3 = big.NewInt(3)
	big7 = big.NewInt(7)
)

func mustHex(s string) *big.Int {
	v, ok := new(big.Int).SetString(s, 16)
	if !ok {
		panic("bad secp256k1 constant: " + s)
	}
	return v
}

var errRecovery = errors.New("secp256k1: recovery failed")

// point is an affine curve point; a nil pointer denotes the point at infinity.
type point struct {
	x, y *big.Int
}

func (p *point) isInfinity() bool { return p == nil }

// mod reduces v into [0,p).
func mod(v, m *big.Int) *big.Int {
	r := new(big.Int).Mod(v, m)
	if r.Sign() < 0 {
		r.Add(r, m)
	}
	return r
}

// add returns p + q on the curve over F_secpP.
func add(p, q *point) *point {
	if p.isInfinity() {
		return q
	}
	if q.isInfinity() {
		return p
	}
	// P + (-P) = O when the x-coordinates match but the y-coordinates are negatives.
	if p.x.Cmp(q.x) == 0 {
		ySum := mod(new(big.Int).Add(p.y, q.y), secpP)
		if ySum.Sign() == 0 {
			return nil
		}
	}

	var slope *big.Int
	if p.x.Cmp(q.x) == 0 && p.y.Cmp(q.y) == 0 {
		// doubling: s = 3x^2 / 2y
		num := mod(new(big.Int).Mul(big3, new(big.Int).Mul(p.x, p.x)), secpP)
		den := modInverse(mod(new(big.Int).Mul(big2, p.y), secpP), secpP)
		slope = mod(new(big.Int).Mul(num, den), secpP)
	} else {
		// chord: s = (y2 - y1) / (x2 - x1)
		num := mod(new(big.Int).Sub(q.y, p.y), secpP)
		den := modInverse(mod(new(big.Int).Sub(q.x, p.x), secpP), secpP)
		slope = mod(new(big.Int).Mul(num, den), secpP)
	}

	x3 := mod(new(big.Int).Sub(new(big.Int).Mul(slope, slope), new(big.Int).Add(p.x, q.x)), secpP)
	y3 := mod(new(big.Int).Sub(new(big.Int).Mul(slope, new(big.Int).Sub(p.x, x3)), p.y), secpP)
	return &point{x: x3, y: y3}
}

// scalarMul computes k*p via double-and-add, reducing k mod n.
func scalarMul(k *big.Int, p *point) *point {
	kk := mod(k, secpN)
	var result *point // infinity
	addend := p
	for _, bit := range bitsLSB(kk) {
		if bit {
			result = add(result, addend)
		}
		addend = add(addend, addend)
	}
	return result
}

// bitsLSB returns the bits of k from least to most significant.
func bitsLSB(k *big.Int) []bool {
	n := k.BitLen()
	bits := make([]bool, n)
	for i := 0; i < n; i++ {
		bits[i] = k.Bit(i) == 1
	}
	return bits
}

// modInverse returns a^-1 mod m.
func modInverse(a, m *big.Int) *big.Int {
	return new(big.Int).ModInverse(mod(a, m), m)
}

// liftX recovers the curve point with the given x and the requested y parity
// (0 = even, 1 = odd). Valid because secpP ≡ 3 (mod 4), so sqrt is a^((p+1)/4).
func liftX(x *big.Int, yParity uint) (*point, error) {
	alpha := mod(new(big.Int).Add(new(big.Int).Mul(new(big.Int).Mul(x, x), x), big7), secpP)
	exp := new(big.Int).Div(new(big.Int).Add(secpP, big1), big.NewInt(4))
	y := new(big.Int).Exp(alpha, exp, secpP)
	if mod(new(big.Int).Mul(y, y), secpP).Cmp(alpha) != 0 {
		return nil, errRecovery // x is not on the curve
	}
	if y.Bit(0) != yParity {
		y = new(big.Int).Sub(secpP, y)
	}
	return &point{x: new(big.Int).Set(x), y: y}, nil
}

// recoverPublicKey implements SEC 1 §4.1.6: given the message hash and (r,s,recID)
// it returns the recovered public-key point Q.
func recoverPublicKey(msgHash []byte, r, s *big.Int, recID int) (*point, error) {
	if r.Sign() <= 0 || r.Cmp(secpN) >= 0 {
		return nil, errRecovery
	}
	if s.Sign() <= 0 || s.Cmp(secpN) >= 0 {
		return nil, errRecovery
	}
	if recID < 0 || recID > 3 {
		return nil, errRecovery
	}

	// x = r + (recID>>1) * n, must lie in the base field.
	x := new(big.Int).Set(r)
	if recID>>1 == 1 {
		x.Add(x, secpN)
	}
	if x.Cmp(secpP) >= 0 {
		return nil, errRecovery
	}

	pointR, err := liftX(x, uint(recID&1))
	if err != nil {
		return nil, err
	}

	e := mod(new(big.Int).SetBytes(msgHash), secpN)
	rInv := modInverse(r, secpN)
	if rInv == nil {
		return nil, errRecovery
	}

	// Q = r^-1 * (s*R - e*G)
	sR := scalarMul(s, pointR)
	eG := scalarMul(e, &point{x: new(big.Int).Set(secpGx), y: new(big.Int).Set(secpGy)})
	negEG := negate(eG)
	q := scalarMul(rInv, add(sR, negEG))
	if q.isInfinity() {
		return nil, errRecovery
	}
	return q, nil
}

// negate returns -p (reflection over the x-axis).
func negate(p *point) *point {
	if p.isInfinity() {
		return nil
	}
	return &point{x: new(big.Int).Set(p.x), y: mod(new(big.Int).Sub(secpP, p.y), secpP)}
}

// pubKeyToAddress derives the lowercase 0x Ethereum address: the last 20 bytes
// of keccak256( X(32) || Y(32) ).
func pubKeyToAddress(pub *point) string {
	var raw [64]byte
	pub.x.FillBytes(raw[0:32])
	pub.y.FillBytes(raw[32:64])
	h := keccak256(raw[:])
	return "0x" + hex.EncodeToString(h[12:32])
}

// recoverPersonalSign recovers the lowercase signer address from a 65-byte
// (r||s||v) EIP-191 personal_sign signature over message. Returns ok=false if
// recovery is impossible for any reason (treated as bad_signature upstream).
func recoverPersonalSign(message, sig []byte) (addr string, ok bool) {
	if len(sig) != 65 {
		return "", false
	}
	r := new(big.Int).SetBytes(sig[0:32])
	s := new(big.Int).SetBytes(sig[32:64])
	v := sig[64]
	if v >= 27 {
		v -= 27
	}
	if v != 0 && v != 1 {
		v &= 1
	}

	digest := eip191Hash(message)
	pub, err := recoverPublicKey(digest[:], r, s, int(v))
	if err != nil {
		return "", false
	}
	return pubKeyToAddress(pub), true
}

// eip191Hash computes keccak256( "\x19Ethereum Signed Message:\n" + len + msg ).
func eip191Hash(message []byte) [32]byte {
	prefix := append([]byte("\x19Ethereum Signed Message:\n"), []byte(strconv.Itoa(len(message)))...)
	return keccak256(append(prefix, message...))
}

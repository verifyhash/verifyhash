# Dependencies

NONE. This verifier uses only the CPython 3.10 standard library.

- **keccak256**: pure-Python Keccak-f[1600] (Ethereum/original-Keccak padding, domain byte
  0x01 — NOT NIST SHA3's 0x06). See `keccak256()` in `verify_vh.py`. Verified against the
  canonical vectors keccak256("") and keccak256("abc").
- **secp256k1 (v,r,s) public-key recovery**: pure-Python affine EC arithmetic + Tonelli-Shanks
  square root (p ≡ 3 mod 4), SEC 1 §4.1.6. See `_recover_public_key()`.

No `pip install` was performed; the `_vendor/` directory is intentionally empty/absent.

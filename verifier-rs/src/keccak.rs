//! Pure-Rust keccak256 — the *Ethereum* (original Keccak) variant.
//!
//! This is NOT NIST SHA3-256. The only difference that matters here is the
//! domain-padding byte: Keccak pads with `0x01` (then the terminal `0x80`),
//! whereas SHA3 pads with `0x06`. Everything else (Keccak-f[1600], rate 136)
//! is identical.

const RATE: usize = 136; // 1088-bit rate for a 256-bit digest

const ROUND_CONSTANTS: [u64; 24] = [
    0x0000000000000001,
    0x0000000000008082,
    0x800000000000808a,
    0x8000000080008000,
    0x000000000000808b,
    0x0000000080000001,
    0x8000000080008081,
    0x8000000000008009,
    0x000000000000008a,
    0x0000000000000088,
    0x0000000080008009,
    0x000000008000000a,
    0x000000008000808b,
    0x800000000000008b,
    0x8000000000008089,
    0x8000000000008003,
    0x8000000000008002,
    0x8000000000000080,
    0x000000000000800a,
    0x800000008000000a,
    0x8000000080008081,
    0x8000000000008080,
    0x0000000080000001,
    0x8000000080008008,
];

// Rho rotation offsets, indexed [x][y] (matching the reference tables).
const ROTATION: [[u32; 5]; 5] = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
];

/// The Keccak-f[1600] permutation over 25 little-endian 64-bit lanes.
/// Lane (x, y) lives at flat index `x + 5*y`.
fn keccak_f1600(a: &mut [u64; 25]) {
    for &rc in ROUND_CONSTANTS.iter() {
        // theta
        let mut c = [0u64; 5];
        for x in 0..5 {
            c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
        }
        let mut d = [0u64; 5];
        for x in 0..5 {
            d[x] = c[(x + 4) % 5] ^ c[(x + 1) % 5].rotate_left(1);
        }
        for x in 0..5 {
            for y in 0..5 {
                a[x + 5 * y] ^= d[x];
            }
        }

        // rho + pi
        let mut b = [0u64; 25];
        for x in 0..5 {
            for y in 0..5 {
                let dest = y + 5 * ((2 * x + 3 * y) % 5);
                b[dest] = a[x + 5 * y].rotate_left(ROTATION[x][y]);
            }
        }

        // chi
        for x in 0..5 {
            for y in 0..5 {
                a[x + 5 * y] = b[x + 5 * y] ^ ((!b[(x + 1) % 5 + 5 * y]) & b[(x + 2) % 5 + 5 * y]);
            }
        }

        // iota
        a[0] ^= rc;
    }
}

/// Return the 32-byte Ethereum keccak256 digest of `input`.
pub fn keccak256(input: &[u8]) -> [u8; 32] {
    // pad10*1 with the Keccak domain byte 0x01 and terminal 0x80.
    let mut padded = input.to_vec();
    padded.push(0x01);
    while padded.len() % RATE != 0 {
        padded.push(0x00);
    }
    let last = padded.len() - 1;
    padded[last] ^= 0x80;

    let mut state = [0u64; 25];
    for block in padded.chunks(RATE) {
        for (i, lane) in block.chunks(8).enumerate() {
            let mut v = 0u64;
            for (j, &byte) in lane.iter().enumerate() {
                v |= (byte as u64) << (8 * j);
            }
            state[i] ^= v;
        }
        keccak_f1600(&mut state);
    }

    let mut out = [0u8; 32];
    for i in 0..4 {
        let lane = state[i];
        for j in 0..8 {
            out[i * 8 + j] = (lane >> (8 * j)) as u8;
        }
    }
    out
}

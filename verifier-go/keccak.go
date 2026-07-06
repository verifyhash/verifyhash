package main

// Pure-Go keccak256 — the original Keccak submission padding (domain byte 0x01),
// NOT NIST FIPS-202 SHA3-256 (which pads with 0x06). This is the hash Ethereum
// uses. Implemented from the Keccak-f[1600] permutation spec with no external
// dependencies.

import "encoding/binary"

// roundConstants are the 24 iota RC values for Keccak-f[1600].
var roundConstants = [24]uint64{
	0x0000000000000001, 0x0000000000008082, 0x800000000000808a, 0x8000000080008000,
	0x000000000000808b, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
	0x000000000000008a, 0x0000000000000088, 0x0000000080008009, 0x000000008000000a,
	0x000000008000808b, 0x800000000000008b, 0x8000000000008089, 0x8000000000008003,
	0x8000000000008002, 0x8000000000000080, 0x000000000000800a, 0x800000008000000a,
	0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
}

// rotationOffsets[x][y] is the rho rotation applied to lane (x,y).
var rotationOffsets = [5][5]uint{
	{0, 36, 3, 41, 18},
	{1, 44, 10, 45, 2},
	{62, 6, 43, 15, 61},
	{28, 55, 25, 21, 56},
	{27, 20, 39, 8, 14},
}

// keccakF applies the 24-round Keccak-f[1600] permutation to the lane state,
// indexed as state[x][y].
func keccakF(state *[5][5]uint64) {
	for round := 0; round < 24; round++ {
		// theta
		var c [5]uint64
		for x := 0; x < 5; x++ {
			c[x] = state[x][0] ^ state[x][1] ^ state[x][2] ^ state[x][3] ^ state[x][4]
		}
		var d [5]uint64
		for x := 0; x < 5; x++ {
			d[x] = c[(x+4)%5] ^ rotl64(c[(x+1)%5], 1)
		}
		for x := 0; x < 5; x++ {
			for y := 0; y < 5; y++ {
				state[x][y] ^= d[x]
			}
		}

		// rho + pi
		var b [5][5]uint64
		for x := 0; x < 5; x++ {
			for y := 0; y < 5; y++ {
				b[y][(2*x+3*y)%5] = rotl64(state[x][y], rotationOffsets[x][y])
			}
		}

		// chi
		for x := 0; x < 5; x++ {
			for y := 0; y < 5; y++ {
				state[x][y] = b[x][y] ^ (^b[(x+1)%5][y] & b[(x+2)%5][y])
			}
		}

		// iota
		state[0][0] ^= roundConstants[round]
	}
}

func rotl64(v uint64, n uint) uint64 {
	return (v << n) | (v >> (64 - n))
}

// keccak256 returns the 32-byte Ethereum keccak256 digest of data.
func keccak256(data []byte) [32]byte {
	const rate = 136 // bytes absorbed per block for keccak-256 (1088-bit rate)

	// pad10*1 with the original-Keccak domain byte 0x01 and terminal bit 0x80.
	padded := make([]byte, len(data), len(data)+rate)
	copy(padded, data)
	padded = append(padded, 0x01)
	for len(padded)%rate != 0 {
		padded = append(padded, 0x00)
	}
	padded[len(padded)-1] ^= 0x80

	var state [5][5]uint64
	for off := 0; off < len(padded); off += rate {
		block := padded[off : off+rate]
		for i := 0; i < rate/8; i++ {
			lane := binary.LittleEndian.Uint64(block[i*8:])
			state[i%5][i/5] ^= lane
		}
		keccakF(&state)
	}

	var out [32]byte
	// The rate covers 17 lanes (>= the 4 we need), so a single squeeze suffices.
	for i := 0; i < 4; i++ {
		binary.LittleEndian.PutUint64(out[i*8:], state[i%5][i/5])
	}
	return out
}

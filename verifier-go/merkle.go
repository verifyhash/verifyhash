package main

// Domain-separated, sorted-leaf keccak Merkle root, re-derived from the bytes
// held on disk (never from the seal's stored hashes). Matches lib/merkle.js:
// a fixed 32-byte directory-leaf domain prefix, a 0x00 path separator, leaf tag
// 0x00, node tag 0x01, ascending 32-byte-big-endian leaf sort, and the
// OpenZeppelin "duplicate the lone odd node" fold.

import (
	"bytes"
	"encoding/hex"
	"errors"
	"sort"
	"strings"
)

// dirLeafDomain = keccak256("verifyhash/dir-leaf/v1"), a fixed 32-byte prefix.
var dirLeafDomain = func() [32]byte {
	return keccak256([]byte("verifyhash/dir-leaf/v1"))
}()

// toPosixRel strips ONLY a single leading "./" (byte-for-byte, per SPEC). A
// backslash is a literal content byte and is left untouched.
func toPosixRel(rel string) string {
	return strings.TrimPrefix(rel, "./")
}

// contentDigestHex returns the 0x-prefixed keccak256 of raw file bytes.
func contentDigestHex(data []byte) string {
	h := keccak256(data)
	return "0x" + hex.EncodeToString(h[:])
}

// hexToBytes32 decodes a validated 0x-prefixed 32-byte hex string.
func hexToBytes32(s string) ([32]byte, error) {
	var out [32]byte
	raw, err := hex.DecodeString(strings.TrimPrefix(s, "0x"))
	if err != nil || len(raw) != 32 {
		return out, errors.New("not a 32-byte hex value")
	}
	copy(out[:], raw)
	return out, nil
}

// pathLeaf = keccak256( DIR_LEAF_DOMAIN(32) || utf8(toPosixRel(rel)) || 0x00 || contentDigest(32) ).
func pathLeaf(rel, contentHex string) ([32]byte, error) {
	c, err := hexToBytes32(contentHex)
	if err != nil {
		return [32]byte{}, err
	}
	var pre []byte
	pre = append(pre, dirLeafDomain[:]...)
	pre = append(pre, []byte(toPosixRel(rel))...)
	pre = append(pre, 0x00)
	pre = append(pre, c[:]...)
	return keccak256(pre), nil
}

// leafHash = keccak256( 0x00 || leaf ).
func leafHash(leaf [32]byte) [32]byte {
	return keccak256(append([]byte{0x00}, leaf[:]...))
}

// nodeHash = keccak256( 0x01 || min(a,b) || max(a,b) ), sorting the pair as
// 32-byte big-endian values.
func nodeHash(a, b [32]byte) [32]byte {
	lo, hi := a, b
	if bytes.Compare(a[:], b[:]) > 0 {
		lo, hi = b, a
	}
	buf := make([]byte, 0, 65)
	buf = append(buf, 0x01)
	buf = append(buf, lo[:]...)
	buf = append(buf, hi[:]...)
	return keccak256(buf)
}

// presentFile is a seal entry whose bytes were found on disk.
type presentFile struct {
	relPath     string
	contentHash string // recomputed 0x-hex of the on-disk bytes
}

// rootFromFlat re-derives the sorted-leaf Merkle root over the present files.
// Zero files is an error (a tree needs at least one leaf).
func rootFromFlat(flat []presentFile) (string, error) {
	if len(flat) == 0 {
		return "", errors.New("cannot build a Merkle tree from zero leaves")
	}

	leaves := make([][32]byte, len(flat))
	for i, f := range flat {
		leaf, err := pathLeaf(f.relPath, f.contentHash)
		if err != nil {
			return "", err
		}
		leaves[i] = leaf
	}
	sort.Slice(leaves, func(i, j int) bool {
		return bytes.Compare(leaves[i][:], leaves[j][:]) < 0
	})

	layer := make([][32]byte, len(leaves))
	for i, l := range leaves {
		layer[i] = leafHash(l)
	}

	for len(layer) > 1 {
		next := make([][32]byte, 0, (len(layer)+1)/2)
		for i := 0; i < len(layer); i += 2 {
			right := layer[i] // lone odd node pairs with itself
			if i+1 < len(layer) {
				right = layer[i+1]
			}
			next = append(next, nodeHash(layer[i], right))
		}
		layer = next
	}
	return "0x" + hex.EncodeToString(layer[0][:]), nil
}

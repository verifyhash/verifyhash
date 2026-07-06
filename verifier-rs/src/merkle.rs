//! Domain-separated, sorted-leaf keccak Merkle root re-derivation.
//!
//! Mirrors the verifyhash `lib/merkle.js` construction: a fixed 32-byte domain
//! prefix binds each leaf to its relPath, leaves are tagged and sorted by their
//! 32-byte big-endian value, and interior nodes hash the sorted pair with a
//! `0x01` tag. A lone odd node is paired with itself (the OpenZeppelin rule).

use crate::keccak::keccak256;

/// keccak256("verifyhash/dir-leaf/v1") — the fixed 32-byte leaf domain prefix.
fn dir_leaf_domain() -> [u8; 32] {
    keccak256(b"verifyhash/dir-leaf/v1")
}

/// Strip only a single leading "./" (byte-for-byte; a backslash is content).
pub fn to_posix_rel(rel_path: &str) -> &str {
    rel_path.strip_prefix("./").unwrap_or(rel_path)
}

/// pathLeaf = keccak256( DOMAIN(32) ++ utf8(posixRel) ++ 0x00 ++ contentDigest(32) )
fn path_leaf(rel_path: &str, content_digest: &[u8; 32]) -> [u8; 32] {
    let mut preimage = Vec::new();
    preimage.extend_from_slice(&dir_leaf_domain());
    preimage.extend_from_slice(to_posix_rel(rel_path).as_bytes());
    preimage.push(0x00);
    preimage.extend_from_slice(content_digest);
    keccak256(&preimage)
}

/// leafHash = keccak256( 0x00 ++ leaf(32) )
fn leaf_hash(leaf: &[u8; 32]) -> [u8; 32] {
    let mut buf = [0u8; 33];
    buf[0] = 0x00;
    buf[1..].copy_from_slice(leaf);
    keccak256(&buf)
}

/// nodeHash = keccak256( 0x01 ++ min(a,b) ++ max(a,b) ) comparing big-endian.
fn node_hash(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut buf = [0u8; 65];
    buf[0] = 0x01;
    buf[1..33].copy_from_slice(lo);
    buf[33..].copy_from_slice(hi);
    keccak256(&buf)
}

/// Re-derive the sorted-leaf Merkle root from the present files.
/// `flat` is a slice of (relPath, recomputed-content-digest-bytes) pairs.
/// Returns `None` if there are zero leaves (cannot build a tree).
pub fn root_from_flat(flat: &[(String, [u8; 32])]) -> Option<[u8; 32]> {
    if flat.is_empty() {
        return None;
    }

    let mut leaves: Vec<[u8; 32]> = flat
        .iter()
        .map(|(rel, digest)| path_leaf(rel, digest))
        .collect();
    // Sort ascending by 32-byte big-endian value (== lexicographic on bytes).
    leaves.sort();

    let mut layer: Vec<[u8; 32]> = leaves.iter().map(leaf_hash).collect();
    while layer.len() > 1 {
        let mut next = Vec::with_capacity((layer.len() + 1) / 2);
        let mut i = 0;
        while i < layer.len() {
            let right = if i + 1 < layer.len() {
                &layer[i + 1]
            } else {
                &layer[i] // lone odd node paired with itself
            };
            next.push(node_hash(&layer[i], right));
            i += 2;
        }
        layer = next;
    }
    Some(layer[0])
}

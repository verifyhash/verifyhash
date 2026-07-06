#!/usr/bin/env python3
"""verify_vh.py -- INDEPENDENT, offline evidence-seal verifier (Python port of verify-vh).

A clean-room re-implementation of the verifyhash `verify-vh` evidence-seal path, written
against SPEC.md. It re-derives the keccak Merkle root from the bytes you hold (never trusting
the artifact's stored hashes), recovers the EIP-191 signer with an independent secp256k1
routine, and prints a deterministic ACCEPT/REJECT verdict.

Dependencies: NONE. keccak256 and secp256k1 public-key recovery are both implemented in pure
Python below, so this file can be audited and run with only the CPython standard library.

Exit contract (identical to verify-vh):
    0  OK        artifact ACCEPTED
    3  REJECTED  clean negative verdict (CHANGED / MISSING / path_escape / root_mismatch /
                 bad_signature / wrong_issuer / unsigned_cannot_pin_vendor)
    2  USAGE     bad CLI usage / malformed --vendor / unrecognized kind
    1  IO        cannot read artifact / not JSON / structurally malformed seal
"""

from __future__ import annotations

import json
import os
import re
import sys

# ===========================================================================
# keccak256 -- pure-Python Keccak-f[1600], Ethereum (original Keccak) variant.
# NOT NIST SHA3: the domain-padding byte is 0x01, not 0x06.
# ===========================================================================

_KECCAK_ROUND_CONSTANTS = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_KECCAK_ROTATION_OFFSETS = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
]
_MASK64 = (1 << 64) - 1


def _rotl64(value: int, shift: int) -> int:
    return ((value << shift) | (value >> (64 - shift))) & _MASK64


def _keccak_f1600(state: list[list[int]]) -> None:
    for rc in _KECCAK_ROUND_CONSTANTS:
        # theta
        c = [state[x][0] ^ state[x][1] ^ state[x][2] ^ state[x][3] ^ state[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rotl64(c[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            for y in range(5):
                state[x][y] ^= d[x]
        # rho + pi
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rotl64(state[x][y], _KECCAK_ROTATION_OFFSETS[x][y])
        # chi
        for x in range(5):
            for y in range(5):
                state[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y])
        # iota
        state[0][0] ^= rc


def keccak256(data: bytes) -> bytes:
    """Return the 32-byte Ethereum keccak256 digest of `data`."""
    rate = 136  # 1088-bit rate for keccak-256
    # pad10*1 with the Keccak domain byte 0x01, final bit 0x80.
    padded = bytearray(data)
    padded.append(0x01)
    while len(padded) % rate != 0:
        padded.append(0x00)
    padded[-1] ^= 0x80

    state = [[0] * 5 for _ in range(5)]
    for offset in range(0, len(padded), rate):
        block = padded[offset:offset + rate]
        for i in range(rate // 8):
            lane = int.from_bytes(block[i * 8:i * 8 + 8], "little")
            state[i % 5][i // 5] ^= lane
        _keccak_f1600(state)

    out = bytearray()
    while len(out) < 32:
        for i in range(rate // 8):
            if len(out) >= 32:
                break
            out += state[i % 5][i // 5].to_bytes(8, "little")
    return bytes(out[:32])


def keccak_hex(data: bytes) -> str:
    return "0x" + keccak256(data).hex()


# ===========================================================================
# secp256k1 ECDSA public-key recovery (SEC 1 Section 4.1.6), pure Python.
# ===========================================================================

_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
_GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8


class _RecoveryError(Exception):
    pass


def _inv_mod(a: int, m: int) -> int:
    return pow(a % m, -1, m)


def _point_add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1 = p1
    x2, y2 = p2
    if x1 == x2 and (y1 + y2) % _P == 0:
        return None
    if x1 == x2 and y1 == y2:
        m = (3 * x1 * x1) * _inv_mod(2 * y1, _P) % _P
    else:
        m = (y2 - y1) * _inv_mod(x2 - x1, _P) % _P
    x3 = (m * m - x1 - x2) % _P
    y3 = (m * (x1 - x3) - y1) % _P
    return (x3, y3)


def _scalar_mul(k: int, point):
    k %= _N
    result = None
    addend = point
    while k > 0:
        if k & 1:
            result = _point_add(result, addend)
        addend = _point_add(addend, addend)
        k >>= 1
    return result


def _lift_x(x: int, y_parity: int):
    alpha = (x * x * x + 7) % _P
    y = pow(alpha, (_P + 1) // 4, _P)  # sqrt, valid since p == 3 (mod 4)
    if (y * y) % _P != alpha:
        raise _RecoveryError("x not on curve")
    if (y & 1) != y_parity:
        y = _P - y
    return (x, y)


def _recover_public_key(msg_hash: bytes, r: int, s: int, rec_id: int):
    if not (0 < r < _N):
        raise _RecoveryError("r out of range")
    if not (0 < s < _N):
        raise _RecoveryError("s out of range")
    if rec_id < 0 or rec_id > 3:
        raise _RecoveryError("invalid recovery id")
    x = r + (_N if (rec_id >> 1) else 0)
    if x >= _P:
        raise _RecoveryError("recovered x not in field")
    point_r = _lift_x(x, rec_id & 1)
    e = int.from_bytes(msg_hash, "big") % _N
    r_inv = _inv_mod(r, _N)
    s_r = _scalar_mul(s, point_r)
    e_g = _scalar_mul(e, (_GX, _GY))
    neg_e_g = None if e_g is None else (e_g[0], _P - e_g[1])
    q = _scalar_mul(r_inv, _point_add(s_r, neg_e_g))
    if q is None:
        raise _RecoveryError("recovered point at infinity")
    return q


def _pubkey_to_address(pub) -> str:
    raw = pub[0].to_bytes(32, "big") + pub[1].to_bytes(32, "big")
    return "0x" + keccak256(raw)[12:].hex()


def eip191_hash(message: bytes) -> bytes:
    prefix = b"\x19Ethereum Signed Message:\n" + str(len(message)).encode("utf-8")
    return keccak256(prefix + message)


def recover_personal_sign_address(message: bytes, signature: bytes) -> str:
    """Recover the lowercase 0x signer address from a 65-byte (r||s||v) EIP-191 signature."""
    if len(signature) != 65:
        raise _RecoveryError("signature must be 65 bytes (r||s||v)")
    r = int.from_bytes(signature[0:32], "big")
    s = int.from_bytes(signature[32:64], "big")
    v = signature[64]
    if v >= 27:
        v -= 27
    if v not in (0, 1):
        v &= 1
    digest = eip191_hash(message)
    pub = _recover_public_key(digest, r, s, v)
    return _pubkey_to_address(pub)


def try_recover(message: bytes, signature_hex: str):
    """Return the recovered lowercase address, or None if recovery is impossible."""
    try:
        return recover_personal_sign_address(message, bytes.fromhex(signature_hex[2:]))
    except Exception:
        return None


# ===========================================================================
# Merkle root re-derivation (domain-separated, sorted-leaf, OpenZeppelin fold).
# ===========================================================================

HEX32_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")
ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
SIG_RE = re.compile(r"^0x[0-9a-fA-F]{130}$")

DIR_LEAF_DOMAIN = keccak256(b"verifyhash/dir-leaf/v1")  # fixed 32-byte prefix


def to_posix_rel(rel_path: str) -> str:
    # Byte-for-byte per SPEC: strip ONLY a single leading "./". A backslash is a literal byte.
    return rel_path[2:] if rel_path.startswith("./") else rel_path


def _hex_to_bytes32(value: str) -> bytes:
    return bytes.fromhex(value[2:])


def path_leaf(rel_path: str, content_digest_hex: str) -> bytes:
    rel_bytes = to_posix_rel(rel_path).encode("utf-8")
    preimage = DIR_LEAF_DOMAIN + rel_bytes + b"\x00" + _hex_to_bytes32(content_digest_hex)
    return keccak256(preimage)


def _leaf_hash(leaf: bytes) -> bytes:
    return keccak256(b"\x00" + leaf)


def _node_hash(a: bytes, b: bytes) -> bytes:
    lo, hi = (a, b) if int.from_bytes(a, "big") <= int.from_bytes(b, "big") else (b, a)
    return keccak256(b"\x01" + lo + hi)


def root_from_flat(flat: list[dict]) -> str:
    """Re-derive the sorted-leaf Merkle root from present files [{relPath, contentHash}]."""
    if not flat:
        raise ValueError("cannot build a Merkle tree from zero leaves")
    leaves = sorted(
        (path_leaf(e["relPath"], e["contentHash"]) for e in flat),
        key=lambda b: int.from_bytes(b, "big"),
    )
    layer = [_leaf_hash(leaf) for leaf in leaves]
    while len(layer) > 1:
        nxt = []
        for i in range(0, len(layer), 2):
            right = layer[i + 1] if i + 1 < len(layer) else layer[i]  # lone odd node paired with itself
            nxt.append(_node_hash(layer[i], right))
        layer = nxt
    return "0x" + layer[0].hex()


# ===========================================================================
# Verify engine.
# ===========================================================================

EXIT_OK, EXIT_IO, EXIT_USAGE, EXIT_REJECTED = 0, 1, 2, 3

EVIDENCE_SEAL = "vh.evidence-seal"
EVIDENCE_SEAL_SIGNED = "vh.evidence-seal-signed"

TRUST_NOTE = (
    "verify-vh is an INDEPENDENT, read-only, OFFLINE verifier. It RE-DERIVES the keccak root from the "
    "bytes you hold and recovers the signer with no producer stack. It proves TAMPER-EVIDENCE + WHO "
    "vouched — NOT a trusted timestamp and NOT a legal opinion."
)


class UsageError(Exception):
    pass


class IOError_(Exception):
    pass


def _make_disk_read_entry(base_dir: str):
    """A confined file source: returns ('ok', bytes) / ('missing', None) / ('escaped', None)."""
    try:
        base_real = os.path.realpath(base_dir)
    except OSError:
        base_real = os.path.abspath(base_dir)

    def escapes(abs_path: str) -> bool:
        rel = os.path.relpath(abs_path, base_real)
        return rel == ".." or rel.startswith(".." + os.sep) or os.path.isabs(rel)

    def read_entry(rel_path):
        # (1) string-level confinement, before any filesystem access
        if (
            not isinstance(rel_path, str)
            or rel_path == ""
            or os.path.isabs(rel_path)
            or ".." in re.split(r"[\\/]", rel_path)
        ):
            return ("escaped", None)
        # (2) resolved-path confinement
        abs_path = os.path.abspath(os.path.join(base_dir, rel_path))
        if escapes(abs_path):
            return ("escaped", None)
        try:
            with open(abs_path, "rb") as fh:
                data = fh.read()
        except OSError:
            return ("missing", None)
        # (3) post-open symlink confinement
        try:
            real = os.path.realpath(abs_path)
        except OSError:
            real = abs_path
        if escapes(real):
            return ("escaped", None)
        return ("ok", data)

    return read_entry


def _classify_files(sealed_entries, read_entry):
    matched, changed, missing, escaped, flat = [], [], [], [], []
    for entry in sealed_entries:
        rel_path = entry["relPath"]
        status, data = read_entry(rel_path)
        if status == "escaped":
            escaped.append({"relPath": str(rel_path)})
            continue
        if status == "missing":
            missing.append({"relPath": rel_path})
            continue
        actual = keccak_hex(data)
        flat.append({"relPath": rel_path, "contentHash": actual})
        if actual.lower() == str(entry["contentHash"]).lower():
            matched.append({"relPath": rel_path, "contentHash": actual})
        else:
            changed.append({
                "relPath": rel_path,
                "expectedContentHash": entry["contentHash"],
                "actualContentHash": actual,
            })
    return matched, changed, missing, escaped, flat


def _verify_evidence_seal(seal, read_entry):
    files = seal.get("files")
    if not isinstance(files, list) or len(files) == 0:
        raise IOError_("evidence seal `files` must be a non-empty array")
    root = seal.get("root")
    if not isinstance(root, str) or not HEX32_RE.match(root):
        raise IOError_("evidence seal `root` must be a 0x-prefixed 32-byte hex string")

    matched, changed, missing, escaped, flat = _classify_files(files, read_entry)

    recomputed_root = None
    if flat:
        try:
            recomputed_root = root_from_flat(flat)
        except Exception:
            recomputed_root = None

    root_matches = (
        len(missing) == 0
        and len(changed) == 0
        and len(escaped) == 0
        and recomputed_root is not None
        and recomputed_root.lower() == root.lower()
    )
    files_ok = len(changed) == 0 and len(missing) == 0 and len(escaped) == 0 and root_matches
    return {
        "matched": matched,
        "changed": changed,
        "missing": missing,
        "escaped": escaped,
        "unexpected": [],
        "sealedRoot": root,
        "recomputedRoot": recomputed_root,
        "rootMatches": root_matches,
        "filesOk": files_ok,
    }


def _normalize_address(addr, label):
    if not isinstance(addr, str) or not ADDRESS_RE.match(addr):
        raise UsageError(f"{label} must be a 0x-prefixed 20-byte hex address, got: {addr}")
    return addr.lower()


# ===========================================================================
# FAIL-CLOSED --exact-dir (T-75.5 parity with the JS verifier). A seal binds a
# NAMED FILE SET, never a directory boundary: the default verify checks exactly
# the (relPath, content) set the seal names, so a file INJECTED into a sealed
# directory that the seal never named is simply NOT COVERED — the default
# verdict stays ACCEPT (the seal's honest, by-design semantics). --exact-dir
# closes the boundary: it scans the WHOLE base directory (recursively) and
# REJECTS (exit 3, reason UNEXPECTED) any file present on disk but not named
# by the seal. Scan semantics mirror verifier/verify-vh.js:
#   * every non-directory entry counts (a symlink — including one to a
#     directory — is listed as itself and NEVER followed);
#   * the artifact file itself is exempt when it lives inside the scanned
#     directory (a seal never names its own container);
#   * an unreadable (sub)directory is an IO error (exit 1) — fail closed,
#     never a silently-partial scan;
#   * an already-REJECTED verdict keeps its dominant reason; the unexpected
#     list still rides along as extra localization.
# ===========================================================================

def _list_dir_entries_recursive(base_dir):
    out = []

    def walk(dir_abs, rel_prefix):
        try:
            entries = list(os.scandir(dir_abs))
        except OSError as exc:
            raise IOError_(f"--exact-dir could not scan {dir_abs}: {exc}")
        for ent in entries:
            rel = ent.name if not rel_prefix else f"{rel_prefix}/{ent.name}"
            try:
                is_dir = ent.is_dir(follow_symlinks=False)
            except OSError:
                is_dir = False
            if is_dir:
                walk(os.path.join(dir_abs, ent.name), rel)
            else:
                out.append(rel)

    walk(base_dir, "")
    out.sort()
    return out


def _apply_exact_dir(result, code, base_dir, artifact_path):
    named = set()
    for key in ("matched", "changed", "missing", "escaped"):
        for e in result[key]:
            named.add(e["relPath"])
    unexpected = []
    for rel in _list_dir_entries_recursive(base_dir):
        if rel in named:
            continue
        # The artifact's own container file is exempt (a seal never names itself).
        if artifact_path is not None and os.path.abspath(os.path.join(base_dir, rel)) == artifact_path:
            continue
        unexpected.append({"relPath": rel})
    result["exactDir"] = True
    result["unexpected"] = unexpected
    result["counts"]["unexpected"] = len(unexpected)
    if unexpected and result["accepted"]:
        result["accepted"] = False
        result["verdict"] = "REJECTED"
        result["reason"] = "UNEXPECTED"
        return EXIT_REJECTED
    return code


def _decode_signed(container):
    sig = container.get("signature")
    if not isinstance(sig, dict):
        raise IOError_("signed artifact is missing a { scheme, signer, signature } signature block")
    if sig.get("scheme") != "eip191-personal-sign":
        raise IOError_(
            f"unsupported signature scheme: {json.dumps(sig.get('scheme'))} "
            "(this verifier understands eip191-personal-sign)"
        )
    attestation = container.get("attestation")
    if not isinstance(attestation, str):
        raise IOError_("signed artifact must embed the canonical UNSIGNED bytes as a string `attestation`")
    signature = sig.get("signature")
    if not isinstance(signature, str) or not SIG_RE.match(signature):
        raise IOError_("signed artifact signature must be a 65-byte (r||s||v) 0x-hex string")
    signer = sig.get("signer")
    if not isinstance(signer, str) or not ADDRESS_RE.match(signer):
        raise IOError_("signed artifact signer must be a 0x-prefixed 20-byte hex address")
    try:
        embedded = json.loads(attestation)
    except json.JSONDecodeError as exc:
        raise IOError_(f"embedded attestation is not valid JSON: {exc}")
    return {
        "embedded": embedded,
        # The signed message is the attestation string verbatim, as UTF-8 bytes.
        "message": attestation.encode("utf-8"),
        "claimedSigner": signer.lower(),
        "signature": signature,
    }


def verify_parsed_artifact(artifact_name, obj, vendor):
    kind = obj.get("kind")
    pinned = _normalize_address(vendor, "--vendor") if vendor is not None else None

    signed = False
    recovered_signer = None
    claimed_signer = None
    signature_ok = None
    payload = obj
    payload_kind = kind

    if kind == EVIDENCE_SEAL_SIGNED:
        signed = True
        dec = _decode_signed(obj)
        payload = dec["embedded"]
        payload_kind = payload.get("kind") if isinstance(payload, dict) else None
        claimed_signer = dec["claimedSigner"]
        recovered_signer = try_recover(dec["message"], dec["signature"])
        signature_ok = recovered_signer is not None and recovered_signer == claimed_signer
    elif kind != EVIDENCE_SEAL:
        raise UsageError(
            f"unrecognized artifact kind: {json.dumps(kind)} "
            "(verify-vh understands evidence seals, reconciliation seals, dataset attestations, and proof bundles)"
        )

    if payload_kind == EVIDENCE_SEAL:
        file_result = _verify_evidence_seal(payload, _make_disk_read_entry(verify_parsed_artifact.base_dir))
    else:
        raise UsageError(f"unrecognized embedded artifact kind: {json.dumps(payload_kind)}")

    reason = "OK"
    accepted = True
    escaped = file_result["escaped"]

    if not file_result["filesOk"]:
        accepted = False
        if len(escaped) > 0:
            reason = "path_escape"
        elif len(file_result["changed"]) > 0:
            reason = "CHANGED"
        elif len(file_result["missing"]) > 0:
            reason = "MISSING"
        elif len(file_result["unexpected"]) > 0:
            reason = "UNEXPECTED"
        else:
            reason = "root_mismatch"

    signer_matches_vendor = None
    if signed:
        if not signature_ok:
            accepted = False
            reason = "bad_signature"
        elif pinned is not None:
            signer_matches_vendor = recovered_signer == pinned
            if not signer_matches_vendor:
                accepted = False
                if file_result["filesOk"] or reason == "OK":
                    reason = "wrong_issuer"
    elif pinned is not None:
        accepted = False
        reason = "unsigned_cannot_pin_vendor"

    result = {
        "artifact": artifact_name,
        "kind": kind,
        "payloadKind": payload_kind,
        "signed": signed,
        "verdict": "OK" if accepted else "REJECTED",
        "reason": reason,
        "accepted": accepted,
        "recoveredSigner": recovered_signer,
        "claimedSigner": claimed_signer,
        "pinnedVendor": pinned,
        "signatureOk": signature_ok,
        "signerMatchesVendor": signer_matches_vendor,
        "sealedRoot": file_result["sealedRoot"],
        "recomputedRoot": file_result["recomputedRoot"],
        "rootMatches": file_result["rootMatches"],
        "counts": {
            "matched": len(file_result["matched"]),
            "changed": len(file_result["changed"]),
            "missing": len(file_result["missing"]),
            "escaped": len(escaped),
            "unexpected": len(file_result["unexpected"]),
        },
        "matched": file_result["matched"],
        "changed": file_result["changed"],
        "missing": file_result["missing"],
        "escaped": escaped,
        "unexpected": file_result["unexpected"],
        "note": TRUST_NOTE,
    }
    return result, (EXIT_OK if accepted else EXIT_REJECTED)


def verify_artifact(opts):
    if not opts.get("artifact"):
        raise UsageError("verify-vh requires an <artifact>")
    artifact_path = os.path.abspath(opts["artifact"])
    try:
        with open(artifact_path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError as exc:
        raise IOError_(f"cannot read artifact {opts['artifact']}: {exc}")
    try:
        obj = json.loads(text)
    except json.JSONDecodeError as exc:
        raise IOError_(f"artifact {opts['artifact']} is not valid JSON: {exc}")
    if not isinstance(obj, dict):
        raise IOError_(f"artifact {opts['artifact']} must be a JSON object")

    base_dir = os.path.abspath(opts["dir"]) if opts.get("dir") else os.path.dirname(artifact_path)
    verify_parsed_artifact.base_dir = base_dir
    result, code = verify_parsed_artifact(opts["artifact"], obj, opts.get("vendor"))
    if opts.get("exactDir"):
        code = _apply_exact_dir(result, code, base_dir, artifact_path)
    return result, code


# ===========================================================================
# Human-readable rendering.
# ===========================================================================

def render_human(r):
    lines = [TRUST_NOTE, "", f"# verify-vh — {r['artifact']}", f"kind:            {r['kind']}"]
    if r["payloadKind"] != r["kind"]:
        lines.append(f"embedded kind:   {r['payloadKind']}")
    lines.append(f"signed:          {'yes' if r['signed'] else 'no'}")
    if r["signed"]:
        rs = (" " + r["recoveredSigner"]) if r["recoveredSigner"] else " (unrecoverable)"
        lines.append(f"recovered signer:{rs}")
        lines.append(f"claimed signer:  {r['claimedSigner']}")
        if r["pinnedVendor"] is not None:
            lines.append(f"pinned --vendor: {r['pinnedVendor']}")
            lines.append(f"signer matches vendor: {'yes' if r['signerMatchesVendor'] else 'NO'}")
        else:
            lines.append("(no --vendor pin: the recovered signer above is reported, not pinned)")
    elif r["recoveredSigner"] is None and r["pinnedVendor"] is not None:
        lines.append("note: --vendor was supplied but this artifact is UNSIGNED (no signer to pin)")
    if r["sealedRoot"] is not None:
        lines.append(f"sealed root:     {r['sealedRoot']}")
    if r["recomputedRoot"] is not None:
        lines.append(f"recomputed root: {r['recomputedRoot']}")
    if r["rootMatches"] is not None:
        lines.append(f"root matches:    {'yes' if r['rootMatches'] else 'NO'}")
    c = r["counts"]
    lines.append(
        f"files: {c['matched']} matched, {c['changed']} changed, "
        f"{c['missing']} missing, {c['escaped']} rejected, {c['unexpected']} unexpected"
    )
    lines.append("")
    if r["accepted"]:
        lines.append("OK — the artifact verifies.")
    else:
        lines.append(f"REJECTED ({r['reason']}):")
        for ch in r["changed"]:
            lines.append(
                f"  CHANGED    {ch['relPath']}: sealed {ch['expectedContentHash']} "
                f"!= on-disk {ch['actualContentHash']}"
            )
        for m in r["missing"]:
            lines.append(f"  MISSING    {m['relPath']}: referenced but not found on disk")
        for x in r["escaped"]:
            lines.append(
                f"  REJECTED   {x['relPath']}: path escapes the artifact directory "
                "(refused to read; no hash computed)"
            )
        for u in r["unexpected"]:
            lines.append(f"  UNEXPECTED {u['relPath']}: on disk but not referenced")
        if r["reason"] == "bad_signature":
            lines.append("  bad_signature: the signature does not recover to the claimed signer (tampered or forged).")
        if r["reason"] == "wrong_issuer":
            lines.append(f"  wrong_issuer: recovered {r['recoveredSigner']} but you pinned --vendor {r['pinnedVendor']}.")
        if r["reason"] == "unsigned_cannot_pin_vendor":
            lines.append("  --vendor was pinned but the artifact carries no signature to recover a signer from.")
        if r["reason"] == "root_mismatch":
            lines.append("  root_mismatch: the recomputed root does not equal the sealed root.")
        if r["reason"] == "path_escape":
            lines.append(
                "  path_escape: the artifact references a file OUTSIDE its own directory (absolute path, `..` "
                "traversal, or an out-of-tree symlink). A genuine artifact never does this; refused to read it."
            )
    lines.append("")
    return "\n".join(lines)


# ===========================================================================
# CLI.
# ===========================================================================

USAGE = "usage: verify_vh.py <artifact> [--vendor <0xaddr>] [--dir <d>] [--exact-dir] [--json]"


def parse_args(argv):
    opts = {"artifact": None, "vendor": None, "dir": None, "exactDir": False, "json": False}

    def need(flag, i):
        if i + 1 >= len(argv):
            raise UsageError(f"{flag} requires a value")
        return argv[i + 1]

    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--vendor":
            opts["vendor"] = need("--vendor", i)
            i += 2
        elif arg == "--dir":
            opts["dir"] = need("--dir", i)
            i += 2
        elif arg == "--exact-dir":
            opts["exactDir"] = True
            i += 1
        elif arg == "--json":
            opts["json"] = True
            i += 1
        elif arg in ("-h", "--help"):
            print(USAGE)
            sys.exit(EXIT_OK)
        elif arg.startswith("--"):
            raise UsageError(f"unknown flag: {arg}")
        else:
            if opts["artifact"] is not None:
                raise UsageError("verify_vh.py verifies a single <artifact>")
            opts["artifact"] = arg
            i += 1
    return opts


def main(argv):
    try:
        opts = parse_args(argv)
        result, code = verify_artifact(opts)
    except UsageError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return EXIT_USAGE
    except IOError_ as exc:
        sys.stderr.write(f"error: {exc}\n")
        return EXIT_IO

    if opts["json"]:
        sys.stdout.write(json.dumps(result, indent=2) + "\n")
    else:
        sys.stdout.write(render_human(result) + "\n")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

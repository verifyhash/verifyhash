# verify-vh Evidence-Seal Verifier — Implementation SPEC (for a Python port)

Scope: verifying a signed/bare **evidence seal** (`*.vhevidence.json`, kind `vh.evidence-seal`
or `vh.evidence-seal-signed`) to a deterministic ACCEPT/REJECT with the exit-code contract
`0 ok / 3 rejected / 2 usage / 1 IO`. Derived from `verifier/verify-vh.js`, `verifier/lib/merkle.js`,
`verifier/lib/keccak.js`, `verifier/lib/secp256k1-recover.js`, and confirmed by running the real
verifier against the fixtures. Other artifact kinds (trust seal, dataset attestation, proof bundle,
agent packet, anchored receipt) are out of scope here but share the same hash/exit primitives.

---

## 0. Exit-code contract (the top-level return value)

| code | name     | meaning |
|------|----------|---------|
| `0`  | OK       | artifact ACCEPTED — all files match, root re-derives, and (if signed & pinned) signer == vendor |
| `3`  | REJECTED | a clean negative verdict: `CHANGED` / `MISSING` / `UNEXPECTED` / `root_mismatch` / `path_escape` / `bad_signature` / `wrong_issuer` / `unsigned_cannot_pin_vendor` |
| `2`  | USAGE    | bad CLI usage: no `<artifact>`, unknown flag, malformed `--vendor` address, unrecognized artifact `kind`, unrecognized embedded `kind` |
| `1`  | IO       | cannot read the artifact file; artifact not valid JSON; artifact not a JSON object; structurally malformed seal (missing/wrong-typed `files`/`root`, bad signature block shape, embedded attestation not JSON) |

Precedence inside a single verify: file-structure faults are computed first; then for a **signed**
artifact a broken signature (`bad_signature`) overrides everything, and `wrong_issuer` applies only
when the signature is sound but the recovered signer != pinned vendor. IO/USAGE (thrown as exceptions)
short-circuit before any verdict.

Note: `IOError` = structural/parse problems (exit 1); `UsageError` = caller/flag problems (exit 2);
a computed REJECTED verdict is NOT an exception (exit 3). ACCEPT prints `OK — the artifact verifies.`

---

## 1. Hash primitive + domain separation

Primitive: **keccak256** (Ethereum keccak, NOT NIST SHA3-256). In Python use
`pysha3`/`Crypto`-style `keccak_256`, or `eth_hash`/`pycryptodome` keccak. Input = raw bytes,
output = 32 bytes. Helpers return `0x`-prefixed lowercase 64-hex.

Domain-separation constants (byte-exact, from `lib/merkle.js`):
- `DIR_LEAF_DOMAIN = keccak256(utf8("verifyhash/dir-leaf/v1"))` — a fixed 32-byte prefix.
- `PATH_SEP = 0x00` (single byte)
- `LEAF_TAG = 0x00` (single byte)
- `NODE_TAG = 0x01` (single byte)

relPath normalization (`toPosixRel`), byte-for-byte:
`toPosixRel(s) = str(s).replace(/^\.\//, "")` — i.e. **only strip a leading `./`**. Do NOT
translate backslashes to slashes (a `\` is a literal content byte). relPaths in genuine artifacts
were authored on POSIX so `path.sep == "/"`.

---

## 2. Per-file digest, path-bound leaf, and the Merkle root

Given a seal entry `{ relPath, contentHash, leaf }` and the file's on-disk bytes `B`:

1. **content digest** `c = keccak256(B)` → 0x-hex. Empty file → `keccak256("")`.
   (This is `merkle.hashBytes` / `hashFile`.)
2. **path-bound leaf** (the value the on-chain `verifyLeaf` is handed):
   `pathLeaf(relPath, c) = keccak256( DIR_LEAF_DOMAIN(32) ++ utf8(toPosixRel(relPath)) ++ 0x00 ++ c(32) )`
3. **tagged leaf** `leafHash(L) = keccak256( 0x00 ++ L(32) )`
4. **interior node** `nodeHash(a,b) = keccak256( 0x01 ++ min(a,b) ++ max(a,b) )`,
   comparing the two as **32-byte big-endian** values (sorted pair).

**Root construction** (`rootFromFlat` → `rootFromLeaves`) over the seal's file set:
- For each of the seal's `files` that is present on disk, form `pathLeaf(relPath, actual_c)`
  using the **recomputed** content digest of the bytes on disk (never the seal's stored `contentHash`).
- **Sort** the path-bound leaves ascending by 32-byte big-endian value (order-independent root).
- Bottom layer = `leafHash(sortedLeaf)` for each.
- Fold pairwise with `nodeHash`; a **lone odd node is paired with itself** (`nodeHash(x, x)`),
  the OpenZeppelin "duplicate the lone node" rule — NOT promoted unchanged.
- Repeat until one node remains = the root.
- Zero leaves is an error (cannot build a tree). The seal `files` must be a non-empty array.

The re-derived root is **authoritative**; the seal's stored `root` and per-entry `leaf`/`contentHash`
are only expectations to compare against.

---

## 3. Canonical packet fields + the EXACT signed preimage

### Bare seal (`vh.evidence-seal`)
Fields used: `kind`, `schemaVersion` (=1), `note`, `root` (0x-32-byte hex), `files[]` where each
entry is `{ relPath, contentHash, leaf }`. (`fileCount` may be present.) The verifier does NOT
require the note to match for the sibling-verify path (the strict note check lives only in the
anchored-receipt port), but it DOES require `files` non-empty and `root` to be valid 0x-32-byte hex.

### Signed container (`vh.evidence-seal-signed`)
Shape: `{ kind, schemaVersion, note, attestation, signature:{ scheme, signer, signature } }`.
- `attestation` is a **STRING**: the EXACT canonical JSON bytes of the embedded bare seal
  (including its single trailing `\n`). This string IS the signed message, verbatim.
- `signature.scheme` MUST be `"eip191-personal-sign"` (else IOError → exit 1).
- `signature.signature` MUST match `^0x[0-9a-fA-F]{130}$` (65 bytes = r‖s‖v).
- `signature.signer` MUST match `^0x[0-9a-fA-F]{40}$`; it is lowercased and used as the *claimed* signer.
- The embedded payload = `JSON.parse(container.attestation)`; its `kind` selects the underlying
  verify core (here `vh.evidence-seal`).

### The signed preimage (EIP-191 personal_sign)
`message = container.attestation` (the exact UTF-8 bytes of that string).
`digest = keccak256( utf8("\x19Ethereum Signed Message:\n" + str(len(message_bytes))) ++ message_bytes )`
where the length is the **decimal byte-length** of the message. This is what `secp256k1-recover.js`
`eip191Hash` computes and what is fed to ECDSA public-key recovery.

---

## 4. Signer recovery from (v,r,s) and comparison to `--vendor`

Signature bytes = 65: `r = sig[0:32]`, `s = sig[32:64]`, `v = sig[64]` (all big-endian).
- Normalize `v`: if `v >= 27` subtract 27; if result not in {0,1}, take `v & 1`. `recId = v`.
- ECDSA recovery over secp256k1 (SEC 1 §4.1.6), curve `y² = x³ + 7 mod p`:
  - `p = 0xffff…fefffffc2f`, `n = 0xffff…d0364141`, `G = (0x79be…16f81798, 0x483a…fb10d4b8)`.
  - Reject if `r∉(0,n)` or `s∉(0,n)` or `recId∉{0..3}` (→ recovery fails → `bad_signature`).
  - `x = r + (recId>>1 ? n : 0)`; reject if `x >= p`. Lift `R` from `x` with y-parity `recId&1`
    (√ via `a^((p+1)/4) mod p`, valid since p≡3 mod 4).
  - `e = digest mod n`; `Q = r⁻¹ · (s·R − e·G)`. Reject point at infinity.
- **Address** = `"0x" + keccak256( X(32) ‖ Y(32) )[12:32].hex()` (last 20 bytes), **lowercase**.
- Any failure in recovery → return `null` (caught) → treated as `recoveredSigner = null`.

Decision on the recovered address:
- `signatureOk = (recoveredSigner != null) AND (recoveredSigner == claimedSigner)`.
  (Both compared lowercase; claimedSigner is `signature.signer` lowercased.)
- `--vendor` (if given) is validated `^0x[0-9a-fA-F]{40}$` (else UsageError → exit 2), then lowercased
  to `pinned`. `signerMatchesVendor = (recoveredSigner == pinned)`. Checksum case is irrelevant;
  20 raw bytes are compared.

---

## 5. Verdict assembly (evidence seal) — the exact decision tree

Let `fileResult` = classify each seal `files` entry via the file source (disk `--dir` or artifact
directory), producing lists `matched / changed / missing / escaped` and `flat` (present files).
Per entry, read bytes through a confined source:
- source returns `escaped` (hostile relPath: absolute, any `..` component, or resolves/​symlinks
  outside baseDir) → recorded by relPath only, NEVER hashed.
- `missing` (not found) → recorded.
- present → `actual_c = keccak256(bytes)`; compare to entry.contentHash (case-insensitive):
  equal → `matched`, else → `changed {relPath, expectedContentHash, actualContentHash}`.

`recomputedRoot` = `rootFromFlat(flat)` (only if `flat` non-empty; else null).
`rootMatches = (missing==0 AND changed==0 AND escaped==0 AND recomputedRoot != null AND
recomputedRoot == seal.root)` (lowercased compare).
`filesOk = (changed==0 AND missing==0 AND escaped==0 AND rootMatches)`.

Then:
```
accepted = true; reason = "OK"
if not filesOk:
    accepted = false
    if escaped   > 0: reason = "path_escape"     # DOMINATES — hostile artifact
    elif changed > 0: reason = "CHANGED"
    elif missing > 0: reason = "MISSING"
    elif unexpected>0: reason = "UNEXPECTED"      # (not produced by the standalone evidence path)
    else:             reason = "root_mismatch"
if signed:
    if not signatureOk:
        accepted = false; reason = "bad_signature"     # overrides file reason
    elif pinned is not None:
        signerMatchesVendor = (recoveredSigner == pinned)
        if not signerMatchesVendor:
            accepted = false
            if filesOk or reason=="OK": reason = "wrong_issuer"
elif pinned is not None:          # --vendor pin on an UNSIGNED artifact
    accepted = false; reason = "unsigned_cannot_pin_vendor"
verdict = "OK" if accepted else "REJECTED"
code    = 0 if accepted else 3
```

REJECT reason meanings: **CHANGED** = a listed file's bytes differ (names the file + both hashes);
**MISSING** = a listed file absent from the source; **UNEXPECTED** = an extra file (structural in
evidence path — a doctored/omitted entry instead surfaces as `root_mismatch` or breaks the signature);
**path_escape** = a seal relPath tried to read outside the source (malicious producer); **root_mismatch**
= files individually matched but the re-derived root ≠ sealed root; **bad_signature** = signature does
not recover to the claimed signer (or is unrecoverable); **wrong_issuer** = sound signature but signer
≠ `--vendor`; **unsigned_cannot_pin_vendor** = `--vendor` given but the artifact carries no signature.

---

## 6. CLI resolution + JSON result shape (for parity)

- baseDir for sibling files = `--dir <d>` (resolved) if given, else the artifact file's own directory.
  Sealed relPaths are resolved against baseDir, then confined (§5 escaped rules; also post-open
  realpath/symlink check on disk).
- JSON result object keys (order as emitted): `artifact, kind, payloadKind, signed, verdict, reason,
  accepted, recoveredSigner, claimedSigner, pinnedVendor, signatureOk, signerMatchesVendor,
  sealedRoot, recomputedRoot, rootMatches, counts:{matched,changed,missing,escaped,unexpected},
  matched[], changed[], missing[], escaped[], unexpected[], note`.
- With no `--vendor`, `signerMatchesVendor` stays `null` and the recovered signer is reported, not pinned.
- `--exact-dir` (T-75.5 parity): after the normal verdict, recursively list every non-directory entry
  under baseDir (a symlink — even to a directory — is listed as itself, never followed; an unreadable
  (sub)directory is an IO error → exit 1). Every relPath not named by the seal (i.e. not in
  matched/changed/missing/escaped) and not the artifact file itself is `unexpected`. If any exist and
  the verdict was ACCEPT, downgrade to REJECTED, reason `UNEXPECTED`, exit 3; an already-REJECTED
  verdict keeps its dominant reason (the list still rides along). Emits `exactDir: true` in JSON.

---

## 7. Observed fixture behavior (ground truth to match)

Fixtures under `fixtures/` (packet references relPaths `custody.md`, `report.txt`; sibling bytes live
in the adjacent `files/` dir, so use `--dir …/files`). Signer/vendor =
`0x7cb4d3dc6c52996b6386473bfb32f898263412f7`. Embedded root =
`0xfda420457b111edb25ac9fe52c3752f11d0197cfa394775009b5e685c48062a6`.
- genuine + correct `--vendor`  → verdict OK,  reason OK,  exit 0 (signatureOk true, rootMatches true).
- genuine + no `--vendor`       → OK, exit 0 (recovered signer reported, not pinned).
- genuine + WRONG `--vendor`    → REJECTED, reason `wrong_issuer`, exit 3 (signatureOk true, rootMatches true).
- tampered file (report.txt edited) → REJECTED, reason `CHANGED`, exit 3; names report.txt with expected
  `0xc47d…` vs actual `0x228e…`; rootMatches false.
- files absent (empty `--dir`)  → REJECTED, reason `MISSING`, exit 3 (both files listed missing).
- corrupted `r` in signature    → REJECTED, reason `bad_signature`, exit 3, recoveredSigner null.
- bare embedded seal + `--vendor` → REJECTED, reason `unsigned_cannot_pin_vendor`, exit 3.
- bare embedded seal, no vendor → OK, exit 0.
- unrecognized `kind`           → `error: unrecognized artifact kind …`, exit 2.
- nonexistent artifact path     → `error: cannot read artifact … ENOENT`, exit 1.
- no `<artifact>` arg           → `error: verify-vh requires an <artifact>`, exit 2.

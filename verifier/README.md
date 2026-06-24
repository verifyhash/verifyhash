# `verify-vh` — the independent, offline verifier

**You received a sealed verifyhash artifact and you are NOT a verifyhash customer.** This directory
is everything you need to check it yourself: a single command, near-zero dependencies, **no network,
and no back-edge into the producer's stack**. You do not need our `ethers`/`hardhat` toolchain, an
account, a license, or our permission. Read this file, `npm install`, run one command, and decide.

`verify-vh` is **free**. There is no paid tier for verification — the producer pays to *seal*; anyone
may *verify* forever, offline, at zero cost. That is deliberate: a proof a counterparty cannot
independently check is not a proof.

---

## 1. What you have, in one minute

A counterparty (the "producer") ran a paid verifyhash tool over some files and handed you:

1. **The artifact** — a small JSON file (`*.vhevidence.json`, `*.vhseal`, `*.vhdataset.json`, or a
   proof bundle). It lists, for each file, a `relPath` and a keccak-256 `contentHash`, folds those
   into one keccak Merkle **root**, and (if signed) carries a 65-byte secp256k1 signature over the
   canonical bytes of that root.
2. **The referenced files** themselves (e.g. `model-card.md`, `weights.bin`). By default they sit
   next to the artifact; otherwise point `--dir` at them.
3. **The producer's signer address** (`0x…`, 20 bytes) — out-of-band: a contract, an email
   signature, a website. You pin it with `--vendor` so a *different* key cannot impersonate them.

`verify-vh` recomputes the root from **the bytes you actually hold**, recovers **who signed it**, and
tells you in one line whether both match.

---

## 2. Install & run

```bash
cd verifier
npm install            # pulls ONE runtime dependency: js-sha3 (keccak). Nothing else.
node verify-vh.js <artifact> [--vendor 0xADDR] [--dir <files-dir>] [--json]
# or, after `npm link` / global install:
verify-vh <artifact> --vendor 0xADDR
```

Requires Node ≥ 18. No build step, no native modules, no compiler.

**Exit codes** (so you can gate CI on them):

| code | meaning |
|------|---------|
| `0`  | **OK** — every referenced byte matches the seal, signature valid, signer == `--vendor` |
| `3`  | **REJECTED** — a clean, expected NO verdict (file changed/missing, bad signature, wrong issuer) |
| `2`  | usage error (bad flags) |
| `1`  | I/O error (artifact unreadable) |

---

## 2a. Gate a whole release in one command — batch / manifest mode

A release produces *many* artifacts (an evidence packet per dataset, a reconciliation seal per report, a
proof bundle per claim). You should not have to call the verifier once per file and `&&` the exit codes
by hand. Pass several artifacts — or a **manifest** listing them — and get **ONE** verdict and **ONE** CI
exit code:

```bash
# Repeated artifacts (each inherits the one --vendor/--dir you pass):
verify-vh a.vhevidence.json b.vhseal c.vhevidence.json --vendor 0xADDR --dir ./out

# A manifest file (newline list OR JSON array), each entry with its OWN optional --vendor/--dir:
verify-vh --manifest release.manifest --json
```

**The aggregate exit contract** — the same four codes, now over the *whole set*:

| code | meaning |
|------|---------|
| `0`  | **OK** — and only if — **every** artifact in the batch verifies |
| `3`  | **REJECTED** — **any** artifact is rejected; the report names **which** artifact failed and why |
| `2`  | usage error (bad flag, malformed per-entry `--vendor`, empty manifest, `--manifest` + a positional) |
| `1`  | I/O error (the manifest, or any listed artifact, is unreadable) — the batch never "passes" while an artifact could not be evaluated |

**Manifest format.** Either a **newline list** (one entry per line; blank lines and `#` comments are
skipped) or a **JSON array**. Each entry is an artifact path with an optional per-entry `--vendor` /
`--dir`. Paths resolve relative to the **manifest file's own directory** (a release ships its manifest
next to its artifacts); a top-level `--vendor`/`--dir` is a **default** each entry may override.

```text
# release.manifest (newline form)
datasets/march.vhevidence.json --vendor 0xb463…3221 --dir datasets/march
recon/q2.vhseal                --vendor 0xb463…3221
proofs/claim-7.vhproof.json
```

```json
[
  "proofs/claim-7.vhproof.json",
  { "artifact": "recon/q2.vhseal", "vendor": "0xb463…3221" },
  { "artifact": "datasets/march.vhevidence.json", "vendor": "0xb463…3221", "dir": "datasets/march" }
]
```

`--json` emits a **stable aggregate**:

```json
{ "ok": false, "total": 3, "passed": 2, "failed": 1,
  "results": [ /* …one entry PER artifact, each the SAME shape the single-artifact --json emits… */ ] }
```

Each `results[]` entry is byte-identical in shape to the single-artifact `--json` object (the same core
verifies every entry — no divergence). Gate your release CI on `ok` (or the process exit code). The
batch path adds **no new crypto and no new artifact kind**, and every entry keeps the same per-entry
**path-escape / no-network** guarantees as a lone verify. The **single-artifact** invocation
(`verify-vh <artifact>`) is unchanged — a lone positional still emits the single-artifact object, not an
aggregate.

---

## 2b. Wire it into your pipeline — a copy-paste CI merge gate

A pilot becomes a renewal when the gate is *wired in*: the build fails the moment a sealed artifact is
tampered, forged, or signed by the wrong key. Two shipped snippets make that one paste:

- **[`ci/verify-vh.generic.sh`](ci/verify-vh.generic.sh)** — a portable `set -e` shell gate for **GitLab
  CI, CircleCI, Jenkins, a Makefile recipe, or a git hook**. It is configured entirely by environment
  variables (no in-file editing), runs the standalone verifier in single-artifact *or* manifest mode, and
  passes the `0/3/2/1` exit code straight through so any non-zero verdict **fails the job**:

  ```bash
  # gate one artifact:
  VH_VENDOR=0xPRODUCER VH_ARTIFACTS="dist/packet.vhevidence.json" ./verifier/ci/verify-vh.generic.sh
  # gate a WHOLE release in one invocation:
  VH_VENDOR=0xPRODUCER VH_MANIFEST=release.manifest               ./verifier/ci/verify-vh.generic.sh
  ```

  | env | meaning |
  |-----|---------|
  | `VH_VENDOR`    | **required** — the producer's signer address (`0x` + 20 bytes), pinned out-of-band |
  | `VH_MANIFEST`  | a release manifest (gate every artifact at once) |
  | `VH_ARTIFACTS` | space-separated artifact paths (when no manifest) |
  | `VH_DIR`       | optional dir holding the referenced files |
  | `VERIFY_VH`    | path to `verify-vh.js` (default `./verifier/verify-vh.js`) |

- **[`ci/verify-vh.github-actions.yml`](ci/verify-vh.github-actions.yml)** — a GitHub Actions workflow you
  drop at `.github/workflows/verify-vh.yml`. It installs **only** the standalone verifier (`js-sha3`, no
  ethers/hardhat) and runs the gate on every push / pull request; a green check then *means* every sealed
  artifact still matches the bytes the producer signed.

Both ship as **examples the loop never runs**, but their exact gate command is mechanically tested
(`../test/verifier.ci-snippet.test.js`): it must exit `0` on a good release and `3` on a tampered one, so
the snippet you copy is known-good, not aspirational.

---

## 3. The exact bytes verified, and the scheme

Nothing here is magic; it is two standard primitives you can re-implement in an afternoon.

### 3a. Per-file content hash
For each referenced file, `contentHash = keccak256(file_bytes)`, the raw file bytes with no framing,
no normalization, no encoding step. Change one byte → a different hash. The verifier reports that file
as `CHANGED` and prints both the sealed and the on-disk hash.

### 3b. The keccak Merkle root
The per-file `(relPath, contentHash)` leaves (plus, for reconciliation seals, a synthetic
`verdict`/role header leaf so a verdict edit also moves the root) are folded into one **keccak-256
Merkle root**. The verifier re-derives this root from the files on disk and compares it, byte-for-byte,
to the `root` embedded in the artifact. (See `lib/merkle.js` for the exact leaf encoding and pairing
order — it is short and dependency-free.)

### 3c. The signature: EIP-191 `personal_sign` over keccak
A signed artifact carries a 65-byte `r(32) || s(32) || v(1)` secp256k1 signature. The signed message
is the **canonical UTF-8 bytes** of the artifact's unsigned payload (the same bytes the verifier
re-derives in `lib/canonical.js` — it does NOT trust a "signature" field that just echoes a hash). The
digest is the standard EIP-191 personal-sign pre-image:

```
keccak256( "\x19Ethereum Signed Message:\n" + <decimal byte length> + <canonical message bytes> )
```

`verify-vh` recovers the signer **address** from `(message, signature)` using a tiny vendored
secp256k1 public-key recovery (SEC 1 §4.1.6) over `js-sha3` keccak — **no `ethers`**. The address is
`"0x" + last-20-bytes( keccak256( X32 || Y32 ) )`, lowercased. If you pass `--vendor 0xADDR`, the
recovered address must equal it (compared as 20 raw bytes; checksum casing is ignored), or the verdict
is `wrong_issuer`.

---

## 4. The trust boundary — read this before you rely on it

`verify-vh` is honest about what a recomputation can and cannot prove. It proves, **purely from the
bytes in your hands**:

- ✅ **Tamper-evidence** — the referenced files are byte-for-byte the ones the producer sealed (if any
  file changed, you see exactly which one, sealed-hash vs on-disk-hash).
- ✅ **Offline recompute** — the root is independently re-derivable; you are not trusting our software,
  our servers, or a "trust us, it matched" claim. No network call happens (proven mechanically — see
  §6 and `test/verifier.isolation.test.js`).
- ✅ **Signer-pin** — *which key* vouched for this artifact, pinned to an address you supply
  out-of-band, so a different key cannot impersonate the producer.

It deliberately does **NOT** prove:

- ❌ **A trusted "sealed at time T".** The signature says *this key vouched for these bytes*, not *on
  this date*. Any `timestamp`/`sealedAt` field inside an artifact is producer-asserted and rides the
  human-owned signing/timestamp trust-root (proposal **P-3** in `../STRATEGY.md`). For an *independent*
  time anchor, the family offers a separate **RFC-3161** timestamp path (`vh … verify-timestamp`,
  also offline) — that is a different deliverable, not something `verify-vh` asserts.
- ❌ **A legal or accounting opinion.** A green verdict means the bytes and the signer check out. It is
  not an attestation that the underlying claim (a reconciliation, a model's provenance) is *correct* —
  that judgement belongs to the producer and their reviewers.

In one sentence: **`verify-vh` tells you the bytes are unchanged and which key signed them — not when,
and not whether the producer's conclusion is true.**

---

## 5. Worked example: producer seals → hands over packet → you run `verify-vh`

This is a real, end-to-end run (test-only ephemeral keys; never a real key or real funds).

**Step 1 — the producer seals** a directory of files into a signed evidence packet with their paid
tool, then publishes their signer address `0xb463…3221` somewhere you trust:

```
data/
  model-card.md
  weights.bin
  packet.vhevidence.json   ← the signed seal the producer hands you, alongside the two files
```

**Step 2 — you, the counterparty, verify** (you did NOT install the producer's stack):

```bash
cd verifier && npm install
node verify-vh.js ../data/packet.vhevidence.json --vendor 0xb463f30cf53d1e0365130363ae9b9867998c3221
```

Output (exit `0`):

```
# verify-vh — .../data/packet.vhevidence.json
kind:            vh.evidence-seal-signed
embedded kind:   vh.evidence-seal
signed:          yes
recovered signer: 0xb463f30cf53d1e0365130363ae9b9867998c3221
claimed signer:  0xb463f30cf53d1e0365130363ae9b9867998c3221
pinned --vendor: 0xb463f30cf53d1e0365130363ae9b9867998c3221
signer matches vendor: yes
sealed root:     0x51004f29ea5b0081be2943d377b2c1572b0543af4bfea724642fa73db3589dd5
recomputed root: 0x51004f29ea5b0081be2943d377b2c1572b0543af4bfea724642fa73db3589dd5
root matches:    yes
files: 2 matched, 0 changed, 0 missing, 0 rejected, 0 unexpected

OK — the artifact verifies.
```

**Step 3 — tamper detection.** Suppose `model-card.md` was altered by one byte in transit. Re-running
exits `3` and names the file:

```
recomputed root: 0xb2dd6f94…   (≠ sealed root)
root matches:    NO
REJECTED (CHANGED):
  CHANGED    model-card.md: sealed 0x59396c16… != on-disk 0xd241bee9…
```

A wrong `--vendor` yields `wrong_issuer`; a corrupted signature yields `bad_signature` — both clean
exit `3` verdicts, never a crash. Add `--json` for a stable machine verdict object
(`{ verdict, reason, accepted, rootMatches, signerMatchesVendor, counts, … }`) to gate CI.

---

## 6. Why you can trust *this verifier* itself

Independence is **mechanically enforced**, not just promised:

- **No producer stack.** Every `require(` in this whole tree (`verify-vh.js` + `lib/*`) is grepped by
  `../test/verifier.isolation.test.js`; it must never pull `ethers`, `hardhat`, `@nomicfoundation/*`,
  or anything under `../cli/` or `../trustledger/`. The only runtime dependency is `js-sha3`.
- **No network, no back-edge.** The same test runs a real verify and asserts the process opens **no
  socket and no network handle** — `verify-vh` never `require`s `http`/`https`/`net`/`dns`. It cannot
  phone home, because it has nothing to phone home *with*.
- **Read-only.** It holds no key, writes nothing, and leaves your working tree byte-for-byte untouched.
- **Cross-checked crypto.** Its secp256k1 recovery is independently re-implemented and continuously
  cross-checked against the production path (`../test/verifier.crypto.test.js`) so the two can never
  silently drift.

See [`../docs/INDEPENDENT-VERIFICATION.md`](../docs/INDEPENDENT-VERIFICATION.md) for the full
counterparty-facing specification.

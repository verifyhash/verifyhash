# `verify-vh` — the independent, offline verifier

**You received a sealed verifyhash artifact and you are NOT a verifyhash customer.** This directory
is everything you need to check it yourself: a single command, near-zero dependencies, **no network,
and no back-edge into the producer's stack**. You do not need our `ethers`/`hardhat` toolchain, an
account, a license, or our permission. Read this file, `npm install`, run one command, and decide.

`verify-vh` is **free**. There is no paid tier for verification — the producer pays to *seal*; anyone
may *verify* forever, offline, at zero cost. That is deliberate: a proof a counterparty cannot
independently check is not a proof.

---

## 0. Get it in 10 seconds (zero-install — start here)

The fastest way to check a seal needs **no clone, no `npm install`, no `node_modules`, no account**:
save ONE self-contained file — [`dist/verify-vh-standalone.js`](dist/verify-vh-standalone.js) — and run
it with `node`. It depends on **nothing but Node core** (the keccak provider is a vendored pure-JS one,
cross-checked against `js-sha3` and `ethers`):

```bash
# 1. Save the single file dist/verify-vh-standalone.js next to the packet you were handed.

# 2. (Optional, recommended) check its PUBLISHED checksum so you know the file wasn't swapped in transit.
#    We ship it beside the bundle as dist/verify-vh-standalone.js.sha256 (standard `sha256sum` format):
sha256sum -c verify-vh-standalone.js.sha256        # -> "verify-vh-standalone.js: OK"
#    (macOS: shasum -a 256 -c verify-vh-standalone.js.sha256)

# 3. Run it — no install:
node verify-vh-standalone.js <packet> --vendor 0xPRODUCER_ADDRESS
#    exit 0 = verifies; exit 3 = REJECTED (names the changed file / wrong signer).
```

That one file is **byte-for-byte the same verifier** described in the rest of this README — it is built
deterministically from these sources, and a stale bundle FAILS CI
(`../test/verifier.standalone.test.js`). The split-source path below (`npm install` the `verifier/` tree
and run `verify-vh.js`) stays for auditors who want to read each `lib/*` file on its own; **both compute
the identical verdict and exit code.** The checksum is a transport-integrity check pinned to a hex you
get out-of-band from the producer — like `--vendor`; the real trust anchor is the source audit in §6.
**Don't want to trust our checksum either? Reproduce the bundle from source yourself — see §0b.**

**The easier path changes nothing about what is proven:** whether you run the one-file bundle or the
split tree, the seal proves **tamper-evidence + signer-pin**, NOT a trusted "sealed at T" (that still
requires **P-3** — see §4). The convenience is in the *install*, never in the *claim*.

---

## 0b. "Who verifies the verifier?" — reproduce the bundle from source yourself (zero-trust bootstrap)

The published checksum in §0 proves the file survived transport — but it comes **from the same place as
the bundle**, so on its own it cannot prove the bundle is the source you can read here (if our
distribution were compromised, both would swap together). The answer to *"who verifies the verifier?"* is
to **reproduce the bundle from the in-tree source** and confirm the published checksum is exactly what
that source compiles to. It is offline, Node-core-only (no `npm install`, no `hardhat`), and writes
nothing:

```bash
# From the verifier/ tree you can READ end to end (the builder + every lib/*.js it inlines):
node build-standalone.js --check
#   -> per-target MATCH/MISMATCH for each bundle, its .sha256 sidecar, AND every inlined source file.
#   exit 0 = every committed bundle, sidecar, and the build-provenance manifest reproduce byte-for-byte
#            from source, and every source file hashes to its manifest-pinned sha256.
#   exit 1 = something does not reproduce — the line NAMES the offending file (bundle, sidecar, or a
#            specific lib/*.js source).
```

The build is **deterministic** (no timestamp, no randomness, a hand-fixed module list), so the bundle
bytes are a pure function of the committed sources. `--check` recompiles both bundles in memory, recomputes
their checksums, and compares against the committed files — and cross-checks each inlined source against the
committed **build-provenance manifest**, [`dist/BUILD-PROVENANCE.json`](dist/BUILD-PROVENANCE.json). That
manifest maps each published bundle's sha256 to the **ordered, individually-hashed** `lib/*.js` files it
inlines — so you can `sha256` the exact files you audited and find their hashes there, then see they compose
(in that order) the bundle whose hash is in the `.sha256` sidecar. Trust roots in **reading source**, not in
trusting our hex.

This proves **build integrity** — the bundle faithfully reproduces the audited source. It is NOT a claim
that the source's *logic* is correct (read it, and run the conformance corpus, for that), and NOT a trusted
timestamp/identity (that is **P-3**). `--check` opens **no network** and writes nothing under the tree
(proven by `../test/verifier.reproduce.test.js`).

Reproducing the bundle changes **nothing** about the trust boundary in §4: whether you run the one-file
bundle or the split tree, the seal proves **tamper-evidence + signer-pin**, NOT a trusted "sealed at T"
(that still requires **P-3** — see §4). The reproduce step moves trust from *our hex* to *the source you
read*; it does not widen the *claim*.

**Make it a RENEWING control, not a one-time read — wire `--check` into your own CI.** Auditing the
verifier once is good; re-confirming it on *every* build is better, because a supply-chain swap of the
verifier itself (a stale bundle, a one-byte source edit) then **fails your pipeline** instead of slipping
past. Two shipped, copy-paste snippets do exactly that — they run `--check` and pass its exit code
straight through, so any drift blocks the merge:

- **[`ci/reproduce-vh.generic.sh`](ci/reproduce-vh.generic.sh)** — a portable `set -e` shell gate for
  GitLab CI, CircleCI, Jenkins, a Makefile recipe, or a git hook. No config, no install: `./verifier/ci/reproduce-vh.generic.sh`.
- **[`ci/reproduce-vh.github-actions.yml`](ci/reproduce-vh.github-actions.yml)** — a GitHub Actions
  workflow you drop at `.github/workflows/reproduce-vh.yml`; a green check then *means* "the verifier we
  depend on is still the exact source we audited."

These are the verifier-integrity twins of the seal-gate snippets in §2b (that gate your *seals*; these
gate the *verifier*). They are **examples the loop never runs**, but their exact gate command is
mechanically tested (`../test/verifier.reproduce-ci-snippet.test.js`): it must exit `0` on a clean
checkout and **non-zero, naming the offending source file,** when one byte of an inlined `lib/*.js`
changes — so the snippet you copy is known-good, not aspirational. Wiring the gate widens **nothing**
about the trust boundary in §4; it just makes the §0b reproduce answer *renew* on every build.

---

## 0a. Produce your OWN seal in 10 seconds, then hand it off (the free self-service round-trip)

§0 is the FREE **verify** side. There is a matching FREE **produce** side, so you can run the *whole*
loop yourself — seal your own files, hand the result to a counterparty, watch them verify it — with **no
clone, no `npm install`, no account, no key**, on either side. Save ONE file —
[`dist/seal-vh-standalone.js`](dist/seal-vh-standalone.js) — and run it with `node`. Like the verifier,
it depends on **nothing but Node core** (the keccak provider is the same vendored pure-JS one):

```bash
# 1. Save the single file dist/seal-vh-standalone.js (optionally check dist/seal-vh-standalone.js.sha256
#    the same way as the verifier in §0).

# 2. Seal up to 25 of YOUR OWN files into one tamper-evident packet — no install, no key, no account:
node seal-vh-standalone.js <your-folder> -o packet.vhevidence.json      # exit 0 = sealed

# 3. Hand packet.vhevidence.json + your folder to a counterparty. They run the FREE verifier from §0:
node verify-vh-standalone.js packet.vhevidence.json --dir <your-folder> # exit 0 = verifies; 3 = REJECTED
```

That is the entire organic adoption loop, self-service and free on both ends, before any sales call: one
file to **seal**, one file to **verify**, and the `.vhevidence.json` is the only thing that has to change
hands. The standalone sealer is built deterministically from these sources and a stale bundle FAILS CI
(`../test/freeseal.standalone.test.js`); its seal bytes are byte-for-byte identical to the producer's own
`cli/evidence.js` seal over the same folder, so a free seal is the *same* artifact the paid tool wraps —
never a toy.

**The honest scope boundary is exactly the same as §0 — and the free seal is *narrower* still.** A
standalone seal proves **tamper-evidence + offline-recompute** — the referenced files are byte-for-byte
the ones sealed, independently re-derivable by anyone — and **NOT** a trusted "sealed at T" without
**P-3** (see §4). On top of that, the FREE seal is **UNSIGNED** (no signer to pin — there is no
`--sign`/`--license`/`--key` flag here at all) and **capped at 25 files** (a folder of more than 25
hard-errors and writes nothing). **SIGNING** (an EIP-191 signer-pin so a counterparty can pin you with
`--vendor`) and **UNLIMITED** sealing are the PAID upgrade — `vh evidence seal --sign` / the
`evidence_unlimited` entitlement (`--license`), routed through the full producer CLI. The free loop is
the funnel; the paid upgrade adds *who signed it* and *no file cap*.

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

**The boundary holds in CI too: verification is FREE, sealing is PAID.** Running this gate — like every
`verify-vh` call — costs nothing, needs no licence, and opens no network. The licence gates only the
**producer's** paid sealing surface; your pipeline gates on the proofs for free. A green gate is a
*renewing* dependency precisely because checking the producer's seal never costs you anything, while
producing a valid one is what the producer pays for.

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
- ✅ **Revocation-aware (opt-in)** — with `--revocations <file-or-dir> [--as-of <ISO>]` `verify-vh`
  consults the producer's signed key revocations and **downgrades** an otherwise-ACCEPTED artifact to
  **REVOKED** (exit 3) when the signing key was revoked **at or before** the as-of instant (default:
  now). A revocation dated *after* the as-of leaves it ACCEPTED with an informational later-revoked note;
  a forged / tampered / third-party revocation is **ignored** with a warning (a revocation only ever
  *removes* trust, never adds it — a key revokes itself). This reaches the **same** downgrade the
  producer-stack `vh ... verify-signed --revocations <f> --as-of <T>` reaches on the identical inputs —
  fully OFFLINE, no producer stack, no network, no key (see
  [`../docs/KEY-LIFECYCLE.md`](../docs/KEY-LIFECYCLE.md)). A directory is read as a flat pool of
  revocation files; a single file may be one revocation or a JSON array.

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

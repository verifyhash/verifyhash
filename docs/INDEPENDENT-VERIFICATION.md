# Independent verification — the buyer/counterparty deliverable

> **Audience: a NON-customer.** You were handed a sealed verifyhash artifact by a counterparty (a
> "producer") and you need to decide whether to believe it — without trusting the producer's software,
> their servers, or us. This document is the contract that makes that possible. The runnable tool and a
> quickstart live in [`../verifier/README.md`](../verifier/README.md); this is the deeper specification.

The whole point of a provenance seal is that **the party relying on it is not the party who made it.**
A proof you can only check with the producer's own toolchain is not a proof — it is a request to trust
them. `verify-vh` exists so the relying party can recompute everything themselves, offline, for free.

---

## 1. The deliverable, precisely

`verify-vh` is a **standalone, read-only, OFFLINE** verifier that, given an artifact plus the files it
references and the producer's signer address:

1. **re-derives** the keccak-256 Merkle root from the bytes you hold,
2. **compares** it to the root embedded (and signed) in the artifact,
3. **recovers** the secp256k1 signer of the signature, and
4. **pins** that signer to an address you supply out-of-band.

It emits a deterministic verdict and a CI-gateable exit code. It is **free** — verification is never a
paid tier (the producer pays to seal; anyone may verify forever). It ships with near-zero dependencies
(`js-sha3` + a tiny vendored secp256k1 routine), so a third party can `npm install` it alone and audit
the entire thing in an afternoon.

---

## 2. The exact bytes that are verified

### 2.1 Content hash (per file)
```
contentHash(file) = keccak256( raw file bytes )
```
No normalization, no encoding, no line-ending fixups — the literal bytes on disk. A single changed byte
produces a different hash, and the verifier reports that file as `CHANGED` with both the sealed and the
on-disk hash so the diff is attributable.

### 2.2 Merkle root (per artifact)
Each referenced file contributes a leaf binding its `relPath` to its `contentHash`. Reconciliation
seals additionally fold in a synthetic **header leaf** computed from the seal's own `verdict` + input
role bindings, so editing the verdict (which lives in the seal, not in any file) still changes the
recomputed root. All leaves are folded into one keccak-256 **root**. The exact leaf encoding and
pairing order are in [`../verifier/lib/merkle.js`](../verifier/lib/merkle.js) — short and
dependency-free by design, so you can re-implement it.

### 2.3 Signature (EIP-191 `personal_sign` / keccak)
A signed artifact carries a 65-byte `r(32) || s(32) || v(1)` secp256k1 signature whose **message is the
canonical UTF-8 bytes of the artifact's unsigned payload** — re-derived by the verifier in
[`../verifier/lib/canonical.js`](../verifier/lib/canonical.js), **not** read back from a self-asserting
field. The digest is the standard EIP-191 personal-sign pre-image:

```
digest = keccak256( "\x19Ethereum Signed Message:\n" + decimal(byteLength(message)) + message )
```

The signer address is recovered via standard secp256k1 public-key recovery (SEC 1 §4.1.6) and rendered
as `"0x" + lastBytes20( keccak256( X32 || Y32 ) )`, lowercased. With `--vendor 0xADDR` the recovered
address must equal it (20 raw bytes; checksum casing ignored) or the verdict is `wrong_issuer`. This is
a second, independent implementation of the family's recovery, continuously cross-checked against the
production `ethers` path so the two cannot silently diverge
([`../test/verifier.crypto.test.js`](../test/verifier.crypto.test.js)).

---

## 3. The trust boundary

`verify-vh` makes exactly three claims, all derivable from the bytes in your hands, and explicitly
disclaims everything else.

### What it DOES prove
- **Tamper-evidence.** The referenced files are byte-for-byte the ones sealed; any change is localized
  and attributable (which file, sealed-hash vs on-disk-hash).
- **Offline recompute.** The root is re-derivable by you alone — no trusted server, no "it matched on
  our end." No network access occurs (proven mechanically; see §5).
- **Signer-pin.** *Which key* vouched, pinned to an address you obtained out-of-band, so a different
  key cannot impersonate the producer.

### What it does NOT prove
- **NOT a trusted "sealed at time T."** A signature attests *this key vouched for these bytes* — not
  *when*. Any `timestamp`/`sealedAt`/`reportDate` field inside an artifact is **producer-asserted** and
  rides the human-owned signing/timestamp trust-root (proposal **P-3** in
  [`../STRATEGY.md`](../STRATEGY.md)). For an *independent* time anchor the family ships a separate,
  also-offline **RFC-3161** timestamp path (`vh dataset/parcel verify-timestamp`, P-3 Option B) — that
  is a different deliverable, and `verify-vh` does not assert it.
- **NOT a legal/accounting opinion.** A green verdict means the bytes and the signer check out — not
  that the producer's underlying conclusion (a reconciliation result, a dataset's lawful provenance) is
  correct. That judgement stays with the producer and their reviewers.

> **One sentence:** `verify-vh` tells you the bytes are unchanged and which key signed them — **not
> when, and not whether the producer's conclusion is true.**

---

## 4. Worked example: `producer seals → hands over packet → counterparty runs verify-vh`

A real end-to-end run (test-only ephemeral keys — never a real key or real funds; the same path the
acceptance suite [`../test/verifier.cli.test.js`](../test/verifier.cli.test.js) exercises against the
REAL producer code).

**(a) Producer side.** With their paid evidence tool, the producer seals a directory and publishes
their signer address (`0xb463…3221`) somewhere the counterparty trusts (contract, site, email sig):

```
data/
  model-card.md
  weights.bin
  packet.vhevidence.json     # the signed seal, handed to the counterparty alongside the files
```

**(b) Hand-over.** The counterparty receives the three files. No producer software, account, or license
is involved.

**(c) Counterparty verifies** (one runtime dependency, no network):

```bash
cd verifier && npm install
node verify-vh.js ../data/packet.vhevidence.json \
     --vendor 0xb463f30cf53d1e0365130363ae9b9867998c3221
```

Accepted output (exit `0`):

```
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

`--json` returns a stable verdict object — e.g.
`{"verdict":"OK","reason":"OK","accepted":true,"rootMatches":true,"signerMatchesVendor":true,"counts":{"matched":2,"changed":0,"missing":0,"escaped":0,"unexpected":0}}`
— so a counterparty's CI can gate on `accepted`.

**(d) The rejections you should be able to reproduce** (each a clean exit `3`, never a crash):

| you change | verdict | exit |
|------------|---------|------|
| any sealed byte (`echo x >> model-card.md`) | `CHANGED` (names the file, sealed vs on-disk hash) | 3 |
| a sealed file is absent | `MISSING` | 3 |
| pass a `--vendor` that is not the signer | `wrong_issuer` | 3 |
| corrupt the embedded signature | `bad_signature` | 3 |

---

## 4a. Batch / manifest mode — gate a whole release in one invocation

A release is rarely one artifact. To make `verify-vh` a wired-in CI **merge gate** rather than a one-off
demo, a single invocation can verify **every** artifact a release produces and return **one** exit code.

**Two ways to name the set:**

```bash
# (i) repeated positionals — each inherits the one top-level --vendor/--dir:
verify-vh a.vhevidence.json b.vhseal --vendor 0xADDR --dir ./out

# (ii) a manifest file — each entry carries its OWN optional --vendor/--dir:
verify-vh --manifest release.manifest [--vendor 0xADDR] [--dir <d>] [--json]
```

**Manifest format.** A manifest is EITHER a **newline list** OR a **JSON array**:

- *Newline form* — one entry per line; blank lines and lines beginning with `#` are skipped. A line is an
  artifact path followed by optional `--vendor <0xaddr>` / `--dir <d>` tokens:
  ```text
  # 2026-Q2 release
  datasets/march.vhevidence.json --vendor 0xb463…3221 --dir datasets/march
  recon/q2.vhseal                --vendor 0xb463…3221
  proofs/claim-7.vhproof.json
  ```
- *JSON form* — an array of strings and/or `{ "artifact": "...", "vendor"?: "0x...", "dir"?: "..." }`
  objects.

Artifact paths resolve relative to the **manifest file's own directory** (a release ships its manifest
alongside its artifacts). A per-entry `--dir` likewise resolves against the manifest directory and
localizes where THAT artifact's sibling files are read. A **top-level** `--vendor`/`--dir` is a
**default** every entry inherits unless the entry overrides it. The manifest is parsed in-process; it
introduces **no new crypto and no network** — it is a list, and nothing more.

**Aggregate exit contract** (the existing `0/3/2/1` codes, now over the whole set):

| exit | when |
|------|------|
| `0` (OK)       | **and only if** EVERY artifact verifies (each `accepted`) |
| `3` (REJECTED) | ANY artifact is rejected — the report names WHICH artifact failed and why (per-entry `reason`) |
| `2` (USAGE)    | a bad flag, a malformed per-entry `--vendor`, an empty manifest, or `--manifest` passed together with a positional artifact |
| `1` (IO)       | the manifest itself, or any listed artifact, is unreadable / not the expected shape |

Usage and IO faults are evaluated per entry and **short-circuit** the whole run with the matching code:
a release gate must never report `ok` while one of its artifacts could not even be read or parsed.

**Stable `--json` aggregate.** With `--json`, batch mode emits one object:

```json
{ "ok": false, "total": 3, "passed": 2, "failed": 1, "results": [ /* …per-artifact… */ ] }
```

Each element of `results[]` is **byte-identical in shape** to the single-artifact `--json` verdict object
(§4) — the SAME core (`verifyArtifact`) verifies every entry, so the per-artifact body cannot drift from
the single path. Gate your CI on `ok` (or the exit code). Every entry preserves the same per-entry
path-escape / no-network guarantees (§3, §5) as a lone verify. The **single-artifact** invocation
(`verify-vh <artifact>`) is a strict subset and is unchanged: a lone positional emits the single-artifact
object, not an aggregate.

---

## 4b. A copy-paste CI merge gate — wire it into the partner's pipeline

Batch mode answers the most common B2B adoption question — *"how do I make my pipeline AUTOMATICALLY
reject a tampered/forged artifact on every merge?"* — only once it is actually **wired into CI**. Two
shipped snippets do that with a single paste, and both install **only** the standalone verifier
(`js-sha3`, never the producer's ethers/hardhat stack):

- **[`../verifier/ci/verify-vh.generic.sh`](../verifier/ci/verify-vh.generic.sh)** — a portable `set -e`
  shell gate for GitLab CI / CircleCI / Jenkins / a Makefile / a git hook. Configured purely by env vars
  (`VH_VENDOR`, plus `VH_MANIFEST` *or* `VH_ARTIFACTS`, optional `VH_DIR`), it runs `verify-vh` over the
  release and passes the `0/3/2/1` exit code straight through, so any non-zero verdict **fails the job**.
- **[`../verifier/ci/verify-vh.github-actions.yml`](../verifier/ci/verify-vh.github-actions.yml)** — a
  GitHub Actions workflow dropped at `.github/workflows/verify-vh.yml` that gates every push / pull
  request.

These are shipped **examples the loop never executes**. To prevent doc-rot, their exact gate command is
mechanically extracted and run by [`../test/verifier.ci-snippet.test.js`](../test/verifier.ci-snippet.test.js):
the shipped command MUST exit `0` on a good release and `3` on a tampered one. A snippet a partner copies
is therefore known-good, not aspirational — the gate that converts a one-off pilot into a wired-in
renewal.

---

## 5. Why you can trust the verifier itself (proven, not promised)

Independence is enforced by [`../test/verifier.isolation.test.js`](../test/verifier.isolation.test.js),
which is part of the standard `npx hardhat test` suite:

- **No producer stack / no back-edge.** It statically greps **every** `require(` across the whole
  `verifier/` tree and asserts none resolves to `ethers`, `hardhat`, `@nomicfoundation/*`, or anything
  under `cli/` or `trustledger/`. The only runtime dependency is `js-sha3`.
- **No network.** It runs a real verify and asserts the process opens **no socket or network handle**,
  and that the source never `require`s `http`/`https`/`net`/`dns`/`tls`. The tool cannot phone home —
  it has nothing to phone home with.
- **Read-only.** Holds no key, writes nothing, leaves the working tree untouched
  ([`../test/verifier.cli.test.js`](../test/verifier.cli.test.js)).
- **No silent crypto drift.** The vendored secp256k1 recovery is cross-checked against the production
  `ethers` recovery ([`../test/verifier.crypto.test.js`](../test/verifier.crypto.test.js)).

This is what lets a counterparty audit the verifier in an afternoon and then rely on its verdict
without relying on us.

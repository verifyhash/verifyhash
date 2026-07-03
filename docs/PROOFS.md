# verifyhash portable proofs — artifact schema, verification steps, worked example

This is the canonical spec for the **portable Merkle-proof artifact** that `cli/proof.js` writes and
verifies (task **T-9.2**), exported by `vh prove <file> --root <dir> --out <p>` and consumed by the
read-only `vh verify-proof <p>`. A proof artifact is a versioned, strictly-validated JSON file that
lets a third party **independently** confirm a single file is part of an anchored repository Merkle
root — needing **only the artifact + an RPC URL**, never the original repo, no working tree, no key.

That portability is the missing half of the project's core promise ("anyone can later prove that some
content is byte-for-byte what was anchored, without trusting any server"). `vh prove` already builds a
genuine proof, but on its own that proof only lives in the prover's terminal. `--out` exports it so it
can leave the prover's machine; `vh verify-proof` lets the recipient verify it with **no trust in the
prover** (it re-derives and re-folds everything itself).

> **Trust posture (read this first).** The artifact is an **UNTRUSTED transport container**, in exactly
> the spirit of [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md) and the receipt posture in
> [`docs/RECEIPTS.md`](RECEIPTS.md). `vh verify-proof` **never trusts the file's claims** — it
> RE-DERIVES the leaf from `contentHash` + `relPath`, RE-FOLDS the `proof` itself, and checks the root
> the *fold produced* on-chain (not the `root` field the file claims). Every field below is therefore
> labelled **UNTRUSTED transport — verification re-derives**: tampering with any of them is either
> caught offline or produces a non-`ACCEPTED` verdict, never a false accept.

> **What an `ACCEPTED` verdict proves: SET-MEMBERSHIP — not authorship, not the `uri`.** It binds the
> file's path + bytes to an anchored Merkle **root**, exactly the boundary the contract's `verifyLeaf`
> draws. It says nothing about who anchored that root, what `contributor` means (see the `authorBound`
> rule in [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md)), or any `uri`. `vh verify-proof` leads its
> human-readable output with this caveat verbatim.

---

## Schema

`cli/proof.js` defines the discriminators `kind: "verifyhash.merkle-proof"` and `schemaVersion: 1`
(distinct from the receipt kinds in [`docs/RECEIPTS.md`](RECEIPTS.md), so a random JSON file, a
receipt, or a future/foreign artifact is never misread as a current proof). `readProofArtifact`
validates **strictly** and throws on ANY deviation rather than filling defaults — a malformed/short
hash or a non-hex `proof` hard-errors, so `vh verify-proof` can never silently accept a structurally
bogus file. This mirrors the receipt schema's strict-validation posture.

Every field is **UNTRUSTED transport**: verification re-derives, it never relies on a field being
honest. The columns below name what each field is *for* and how verification *re-checks* it.

| Field | Type | Required | How verification re-checks it (UNTRUSTED transport) |
|-------|------|----------|------------------------------------------------------|
| `kind` | string | yes | Must equal `"verifyhash.merkle-proof"` exactly, else rejected as not-a-proof-artifact. A structural discriminator only. |
| `schemaVersion` | integer | yes | Must be a version this build understands (currently `1`); any other is rejected so a future/foreign file is never misread. |
| `contentHash` | `0x`+64 hex (32 bytes) | yes | The bare `keccak256` of the file's bytes. The leaf is RE-DERIVED from this + `relPath`; a tampered `contentHash` breaks the re-derived leaf and is REJECTED offline. |
| `relPath` | non-empty string | yes | The file's repo-relative POSIX path, the value bound into the leaf. The leaf is RE-DERIVED from `contentHash` + `relPath`; changing it changes the re-derived leaf and is REJECTED offline. |
| `leaf` | `0x`+64 hex (32 bytes) | yes | The path-bound leaf `pathLeaf(relPath, contentHash) = keccak256(DIR_LEAF_DOMAIN ‖ relPath ‖ 0x00 ‖ contentHash)`. Verification RE-DERIVES this from `contentHash`+`relPath` and rejects if the stored `leaf` does not equal the re-derived one — a forged `leaf` alone cannot fool it. |
| `root` | `0x`+64 hex (32 bytes) | yes | The directory's anchored Merkle root the proof folds to. Verification computes its OWN root by folding `leaf` through `proof`; the `root` field is only confirmed to equal that computed root, and it is the *computed* root that is checked on-chain. |
| `proof` | array of `0x`+64 hex | yes | The sorted-pair Merkle siblings. RE-FOLDED with the same `nodeHash` convention the contract's `verifyLeaf` uses; a tampered sibling no longer folds to `root` and is REJECTED offline. May be `[]` for a single-file tree (`leaf == root`). |
| `contractAddress` | `0x`+40 hex (address) | optional | A hint of WHERE the prover expects the root anchored. Recorded when the artifact is built on the on-chain prove path. An explicit `--contract` always overrides it; it is never trusted blindly. |
| `chainId` | non-negative integer | optional | A hint of WHICH chain the root is anchored on. Informational/self-describing; recorded on the on-chain build path, never required. |

An artifact built with the no-key `--dry-run`/build path legitimately omits `contractAddress`/`chainId`
(there was no chain context); the verifier then supplies `--contract`/`--rpc`. An artifact built on the
on-chain prove path records both so `vh verify-proof` can run with **no** `--contract` flag.

### The leaf and fold convention (same as the contract)

The proof artifact reuses the **exact** Merkle machinery `vh hash <dir>` and the contract's
`verifyLeaf` agree on — there is no second scheme (see [`docs/MERKLE-LEAVES.md`](MERKLE-LEAVES.md)):

- the **path-bound leaf** is `pathLeaf(relPath, contentHash) = keccak256(DIR_LEAF_DOMAIN ‖ relPath ‖ 0x00 ‖ contentHash)`,
  so the proof is tied to the file's **location**, not just its bytes (renaming or moving the file
  changes the leaf and the proof no longer folds);
- the **fold** tags the leaf with `LEAF_TAG`, then walks `proof` applying `NODE_TAG` sorted-pair
  hashing (`nodeHash`) — byte-identically to the contract's `verifyLeaf`.

`vh verify-proof` reuses `hash.js`'s `pathLeaf` / `leafHash` / `nodeHash` directly (not a
re-implementation), so the offline fold and the on-chain `verifyLeaf` can never silently diverge.

---

## Verification steps

`vh verify-proof <p>` is **read-only and needs no key, no repo, and no working tree** — just the
artifact and an RPC URL. It never constructs a signer. It runs two stages, and prints `ACCEPTED`
**only** when the offline fold **and** both on-chain checks pass:

### 1. Offline fold (no network)

The internal-consistency gate. Purely offline (no network even needed), it:

1. **RE-DERIVES the leaf** from `contentHash` + `relPath`: `derivedLeaf = pathLeaf(relPath, contentHash)`,
   and checks `leafMatches = (artifact.leaf == derivedLeaf)`. A forged `leaf`, or a tampered
   `contentHash`/`relPath`, fails here.
2. **RE-FOLDS the proof**: `computed = leafHash(leaf)`, then for each sibling `s`,
   `computed = nodeHash(computed, s)`; checks `foldsToRoot = (computed == artifact.root)`. A tampered
   `proof` sibling (or `root`) fails here.

If either check fails the verdict is **`REJECTED`** immediately, **with no network call** — there is
nothing meaningful to ask the chain about a proof that does not even fold to its own claimed root.
The CLI names exactly which check failed.

### 2. On-chain check (one read-only call set)

Only when the offline fold holds, and only if a provider is supplied, `vh verify-proof` makes one
read-only check set against the root the **offline fold produced** (`computedRoot`, which equals the
artifact `root` since the fold held — so the file's `root` is never trusted unchecked):

1. `isAnchored(root)` — is the root actually anchored on-chain? If not, the verdict is **`NOT ANCHORED`**
   (a distinct, non-zero exit), NOT a false accept: the proof is internally valid but there is nothing
   on-chain to prove it against (it was never anchored, or you are pointed at the wrong contract/chain).
2. `verifyLeaf(root, leaf, proof)` — the contract's own verdict (defense in depth: even if the offline
   fold had a bug, the chain decides). `verifyLeaf` tags the supplied `leaf` itself and replays the
   sorted-pair fold.

The contract address resolves as: explicit `--contract` (or `VH_CONTRACT`) > the artifact's recorded
`contractAddress`. With no provider at all, `vh verify-proof` reports the offline fold result but does
**not** claim `ACCEPTED` (acceptance requires the on-chain leg) — a script reading the status never
mistakes an offline-only pass for a full accept.

### Verdicts

| Verdict | Meaning | Exit |
|---------|---------|------|
| `ACCEPTED` | Offline fold held AND root is anchored AND on-chain `verifyLeaf` accepted. The file's path + bytes are a leaf of an anchored root. | 0 |
| `REJECTED` | An offline or on-chain check failed (tampered `leaf`/`contentHash`/`proof`/`root`, or the chain rejected the proof). Never a false accept. | non-zero |
| `NOT ANCHORED` | The proof folds offline, but its root was never anchored on-chain. Distinct from a tamper. | non-zero |

---

## Worked end-to-end example (prove → hand over → verify-proof)

The whole point is that the **prover** and the **verifier** can be different people on different
machines: the only thing that crosses between them is the artifact file.

**Prover** — build and export the artifact (no key needed; works on the `--dry-run` build path):

```
$ vh prove src/index.js --root ./repo --out proof.json --dry-run
Wrote portable proof artifact: /work/repo/proof.json
  repo root dir: /work/repo  (5 files)
  file:          src/index.js
  merkle root:   0x9f8c…a1
  content hash:  0x4b2e…7c
  leaf (path-bound): 0x77ad…02
  proof (2 siblings):
    0x1c3d…9e
    0xa0f5…44
```

The exported `proof.json` (every field UNTRUSTED transport — `vh verify-proof` re-derives):

```json
{
  "kind": "verifyhash.merkle-proof",
  "schemaVersion": 1,
  "root": "0x9f8c00000000000000000000000000000000000000000000000000000000a100",
  "leaf": "0x77ad00000000000000000000000000000000000000000000000000000000a200",
  "contentHash": "0x4b2e00000000000000000000000000000000000000000000000000000000a300",
  "relPath": "src/index.js",
  "proof": [
    "0x1c3d00000000000000000000000000000000000000000000000000000000a400",
    "0xa0f500000000000000000000000000000000000000000000000000000000a500"
  ],
  "contractAddress": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  "chainId": 31337
}
```

> An artifact built on the **on-chain** prove path (with `--contract`/`--rpc`) records
> `contractAddress` + `chainId`, so the verifier needs no `--contract`. An artifact built with bare
> `--dry-run` and no chain context omits both; the verifier then passes `--contract`/`--rpc`.

**Hand over** the file (email, attach to a PR, drop in a bucket — it is read-only public-membership
evidence; it holds **no secret**, unlike a claim receipt). The recipient does **not** need the repo.

**Verifier** — confirm it with only the artifact + an RPC URL, no repo, no key:

```
$ vh verify-proof proof.json --rpc https://… 
NOTE: this proves SET-MEMBERSHIP only — that the named file (its path + bytes) is a leaf of an
anchored repo Merkle root. It does NOT prove authorship, who anchored the root, or anything about
any `uri`. The artifact is an UNTRUSTED transport container: verify-proof RE-DERIVES the leaf and
RE-FOLDS the proof itself (it never trusts the file's claims), then confirms the root is anchored
on-chain. Set-membership in an anchored root is exactly what the contract's verifyLeaf attests.

  proof artifact: proof.json
  relPath:        src/index.js
  contentHash:    0x4b2e…7c
  leaf:           0x77ad…02
  root:           0x9f8c…a1
  proof siblings: 2

  offline recompute (no network):
    leaf re-derived from contentHash+relPath: yes
    proof folds to the claimed root:          yes

  registry authenticated: REGISTRY_ID ok (v1), chainId 137

  on-chain checks (one read-only call set):
    root is anchored (isAnchored):            yes
    contract verifyLeaf accepts the proof:    yes

  result:         ACCEPTED
```

If the verifier (or anyone in transit) had altered the artifact's `proof`, `leaf`, or `contentHash`,
the offline fold would not hold and the verdict would be `REJECTED` — caught offline, no network even
needed. If the `root` was never anchored, the verdict would be `NOT ANCHORED` rather than a false
accept.

**The on-chain leg authenticates the registry first, on the artifact's recorded chain** (T-11.2).
Before any on-chain check, verify-proof runs the shared `assertRegistry` preflight: it confirms a
contract is actually deployed at the address, that it self-identifies as a genuine verifyhash registry
(`REGISTRY_ID` / `REGISTRY_VERSION`), AND — because the artifact records the `chainId` it was anchored
on — that the provider is on **that same chain**. An artifact that says "anchored on chainId 137"
**hard-errors** rather than be "verified" against a different chain that returns fakes. That is the
portability promise made trustworthy: the consumer no longer trusts the prover's RPC blindly. The
human verdict prints a `registry authenticated: REGISTRY_ID ok (vN), chainId N` line (above) before
the on-chain checks; a loud, non-default `--skip-identity-check` bypasses the preflight for a known
local-dev contract. See the README's
[authenticated reads](../README.md#authenticated-reads-registry-identity--chainid) section.

`--json` emits the same verdict + per-check booleans (`offline.{leafMatches,foldsToRoot,ok}`,
`onChain.{checked,rootAnchored,verifyLeaf}`, `accepted`, `status`) plus the trust note, for tooling. It
also carries a top-level `registry: { id, version, chainId }` block proving the on-chain leg ran
against an authenticated registry on the artifact's recorded chain (or `{ "skipped": true, "note": … }`
under `--skip-identity-check`, or `null` when no on-chain leg ran — an offline-only / rejected-early
verdict).

---

## What this does NOT prove

Consistent with [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md) and the contract's `verifyLeaf`
boundary:

- **Not authorship.** `ACCEPTED` says the file is in an anchored root; it says nothing about who
  anchored it or what `contributor` means (that is the `authorBound` distinction — one-shot `anchor`
  is front-runnable, only commit-reveal binds an author).
- **Not the `uri`.** The artifact carries no `uri`; even where one exists on the record, it is an
  untrusted hint the contract never fetched or validated.
- **Not "this is the latest/only version."** It proves membership in *the* root in the artifact; a
  different snapshot has a different root.

> Rule of thumb: **`vh verify-proof` binds a file's path + bytes to an anchored root; that is all.**

---

## Tests

`test/cli.verifyproof.test.js` proves the behaviour this doc describes:

- the offline fold re-derives the leaf and folds to the root with **no network**, and a tampered
  `proof` / `leaf` / `contentHash` is caught offline (`offlineOk === false`);
- strict validation hard-errors on a wrong `kind`, an unsupported `schemaVersion`, a short/malformed
  hash, a non-hex/non-array `proof`, an empty `relPath`, and non-JSON input;
- end-to-end against a live hardhat node: build `--out` then `vh verify-proof` (artifact + RPC only,
  **no repo**) `ACCEPTED`s a genuine proof, the on-chain build path records `contractAddress` so
  verify needs no `--contract`, tampering `proof`/`leaf`/`contentHash` `REJECTED`s, a never-anchored
  root reports `NOT ANCHORED`, and `--json` round-trips the verdict + per-check booleans.

`test/cli.proofs.docs.test.js` is the docs-rot guard for this file + the README CLI block: it pins the
schema fields, the `kind`/`schemaVersion`, the verification stages, and the trust caveats to the real
`cli/proof.js` exports, so the prose cannot silently drift from the code.


---
<sub>© 2026 verifyhash.com · Licensed under Apache-2.0 (SPDX-License-Identifier: Apache-2.0) — see the [LICENSE](https://verifyhash.com/LICENSE) and [NOTICE](https://verifyhash.com/NOTICE) served with this file.</sub>

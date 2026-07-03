# The adversarial conformance corpus — what "REJECT" actually proves

> **Audience: a buyer's security/procurement reviewer asking "how do I know your verifier won't say
> ACCEPT on something it shouldn't?"** This page answers that mechanically, with a runnable gate and a
> precise statement of what it proves — and what it does **not**. It trusts nothing but `node` and the
> bytes committed in this repo.

The 60-second [`../challenge/`](../challenge/) kit proves a verifier catches **one** byte-edit on **one**
packet. The conformance corpus raises that to the real question: *does the verifier catch the OTHER ways
an artifact gets poisoned, across the kinds of packets a business actually seals?* It commits one CLEAN
business packet per vertical plus exactly one POISONED packet per tamper class, and drives every shipped
evidence-seal verifier of the UNSIGNED content-integrity seal against every poisoned artifact in one
read-only command.

## Run it

```sh
node challenge/corpus/run-corpus.js          # human report; exit 0 = PASS, 1 = FAIL
node challenge/corpus/run-corpus.js --json    # stable, machine-readable result on stdout
```

[`challenge/corpus/run-corpus.js`](../challenge/corpus/run-corpus.js) is the **self-auditing conformance
runner**: it drives every shipped verifier of the unsigned content-integrity seal — the producer's own
`vh evidence verify` **and** the two INDEPENDENT offline verifiers a counterparty actually runs (the
single-file standalone bundle
[`../verifier/dist/verify-vh-standalone.js`](../verifier/dist/verify-vh-standalone.js) and the split-tree
[`../verifier/verify-vh.js`](../verifier/verify-vh.js)) — against EVERY poisoned artifact in the corpus,
and asserts the one load-bearing safety invariant the whole product rests on:

> **NO verifier EVER returns ACCEPT (exit 0) on a poisoned input.**

It is a permanent **regression floor**: if any future refactor ever opens a false-ACCEPT hole in ANY
verifier, this runner goes RED. The gate is proven to have teeth — its companion test injects a synthetic
verifier that wrongly ACCEPTS a poisoned input and proves the runner then exits 1, naming the offending
class + verifier (a gate that cannot fail proves nothing).

## The honest boundary — what a green run proves, and what it does NOT

Be precise about what an all-REJECT run buys you:

- **It proves the verifier REJECTs every ENUMERATED tamper class** in the corpus (each clean packet plus
  exactly one documented mutation), **by re-deriving the keccak-256 Merkle root from the bytes you hold**
  — never trusting the seal's own stored hashes. That is mechanical, runnable in seconds, and trusts
  nothing but `node` and the committed bytes.
- **It does NOT prove the absence of unknown tamper classes.** The corpus is a finite, enumerated
  taxonomy; passing it means the verifier rejects *these* poisonings, not *every conceivable* one. A
  green run is evidence of conformance to the published classes, never a proof that no other attack
  exists.
- **A REJECT is tamper-evidence, NOT a trusted timestamp.** The verifier re-derives "these are exactly
  those bytes"; it asserts nothing about *when*. A trustworthy "sealed at T" still requires **P-3** (the
  human-owned trust-root — a self-managed signing key, an RFC-3161 timestamp authority, or an on-chain
  anchor; see [`INDEPENDENT-VERIFICATION.md`](INDEPENDENT-VERIFICATION.md) §3 and **P-3** in
  [`../STRATEGY.md`](../STRATEGY.md)). The corpus is the **FREE, UNSIGNED** path, so there is no signer to
  pin here either; a green verdict is not a legal or accounting opinion.
- **It covers the UNSIGNED content-integrity surface ONLY — it does NOT red-team the signer-pin
  (`--vendor`) path.** Every fixture in the corpus is unsigned, and the taxonomy contains **no
  signature-corruption / signer-substitution / attestation-edit class**. So this corpus exercises only the
  three verifiers of the unsigned content-integrity seal (the standalone bundle, the split-tree
  `verify-vh.js`, and the producer's `vh evidence verify`); it does **not** exercise the signed-verifier
  surface — the standalone verifier's `--vendor` signer-pin, `vh evidence verify-signed`, or the
  attestation verifiers (`vh dataset/parcel verify-attest`, `vh revocation/identity verify`). Signer-pin
  is the page's named **PAID** upgrade; a green corpus run is **not** evidence that the signer-pin path was
  adversarially tested.

This is the same trust boundary every verifyhash seal carries — stated once, so the conformance story
never over-promises.

## The enumerated tamper classes

The taxonomy is published in [`../challenge/corpus/manifest.json`](../challenge/corpus/manifest.json) and
regenerated deterministically by [`../challenge/corpus/generate.js`](../challenge/corpus/generate.js).
Each class is one clean business packet plus exactly one documented mutation the verifier must REJECT.
`expectedExit` is the standalone verifier's own contract: **3** = REJECTED (tamper: CHANGED / MISSING /
forged root), **2** = usage (unrecognized seal kind).

| class id | vertical | mutation | expected exit |
|----------|----------|----------|---------------|
| `finance-amount-edited` | finance | Flip one digit in a ledger credit amount. | 3 |
| `finance-tie-out-dropped` | finance | Delete the bank tie-out file the seal still references. | 3 |
| `ai-data-sample-swapped` | ai-data | Relabel one training sample in `samples.jsonl`. | 3 |
| `ai-data-license-stripped` | ai-data | Truncate `LICENSE.txt` to empty (strip the provenance license). | 3 |
| `ai-data-file-renamed` | ai-data | Rename a sealed file so the sealed path is now MISSING. | 3 |
| `software-sbom-injected` | software | Inject an undeclared dependency line into `sbom.json`. | 3 |
| `software-checksum-edited` | software | Alter one published artifact checksum digit in `checksums.txt`. | 3 |
| `legal-clause-altered` | legal | Alter the fee amount in `agreement.txt`. | 3 |
| `legal-signature-page-dropped` | legal | Delete the executed signature page the seal references. | 3 |
| `seal-root-forged` | finance | Forge the seal's Merkle root (packet bytes untouched); the verifier RE-DERIVES the root and rejects. | 3 |
| `seal-kind-corrupted` | software | Corrupt the seal's `kind` to an unrecognized value (usage error). | 2 |

Adding a new tamper class to the manifest WITHOUT also documenting it here FAILS the build: the docs-rot
guard [`../test/challenge.corpus.docs.test.js`](../test/challenge.corpus.docs.test.js) cross-checks this
list against `manifest.json` (every manifest class id appears here, and no id here is stale), so the
buyer-facing trust story can never silently drift from the taxonomy it claims to cover.

## Where this fits

- The corpus is reachable from the cold-prospect kit: [`../challenge/README.md`](../challenge/README.md)
  links this conformance step after the one-byte tamper walkthrough.
- The deeper specification of the verifiers it drives — the exact bytes verified, the no-network posture,
  and how their independence is proven mechanically — is in
  [`INDEPENDENT-VERIFICATION.md`](INDEPENDENT-VERIFICATION.md).
- The buyer pilot runbook [`PILOT.md`](PILOT.md) points at this corpus as the procurement-grade
  conformance check a security reviewer runs before relying on the verifier.


---
<sub>© 2026 verifyhash.com · Licensed under Apache-2.0 (SPDX-License-Identifier: Apache-2.0) — see the [LICENSE](https://verifyhash.com/LICENSE) and [NOTICE](https://verifyhash.com/NOTICE) served with this file.</sub>

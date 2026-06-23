# DataLedger — verifiable AI training-data provenance

DataLedger turns a training dataset into a **reproducible, tamper-evident manifest** and a small set
of artifacts a data-provenance reviewer (enterprise due-diligence, EU AI Act technical documentation)
actually consumes. It runs on the same path-bound Merkle core as `vh hash`/`vh prove`, so every claim
it makes is independently re-derivable.

Every DataLedger command is **offline, needs NO private key, and needs NO network**. You can hand a
manifest, a diff, a summary, or a single-file proof to a third party and they can re-derive the result
on an air-gapped machine with only the `vh` CLI — they do not have to trust your server, your build
machine, or you.

> **Read this first:** the trust posture below is the SAME wording carried in-band in every artifact
> (`cli/dataset.js` › `TRUST_NOTE` / `MEMBERSHIP_TRUST_NOTE`) and in
> [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md). Do not overclaim past it.

---

## What DataLedger PROVES

A DataLedger manifest commits to a Merkle root over the full set of `(relPath, content)` pairs in a
dataset — **file names AND bytes**. From that root and the manifest the following are
re-derivable by anyone, offline:

1. **Exactly which files a dataset contained — names and bytes.** The root commits to the complete
   `(relPath, content)` set. Any edit, rename, add, or remove changes the root. A manifest whose
   recomputed root (from the bytes on disk) matches its recorded root is byte-for-byte the dataset it
   claims to be — a hand-edited manifest root cannot fake a `MATCH`, because `vh dataset verify`
   re-derives the root from the actual file bytes, not from the manifest's recorded string.

2. **Offline set-membership of any one file.** `vh dataset prove` builds a Merkle proof that a single
   file (its `relPath` + bytes) was a leaf of the manifest's root, matched by **content** (not by the
   caller's filename). `vh dataset verify-proof` folds that proof back to the recorded root **purely
   offline** — no dataset copy, no manifest, no key, no network. A fabricated or altered file does not
   fold to the root and is REJECTED.

3. **The precise add / remove / change between two dataset versions.** `vh dataset diff` compares two
   manifests offline and reports `ADDED` (in B not A), `REMOVED` (in A not B), and `CHANGED` (same
   `relPath`, different content, old→new). A rename shows as `REMOVED`+`ADDED` because the path is bound
   into the leaf. This answers the most common auditor question — "what changed in the training data
   between model version N and N+1?" — without either dataset on disk.

4. **A provenance / license roll-up.** `vh dataset summary` aggregates the manifest into a histogram of
   the claimed `{source, license}` hints over the **trusted file set** (total `fileCount`, the root,
   counts of files per claimed license/source, and explicit buckets for files with no hint).

---

## What DataLedger does NOT prove (do not overclaim)

- **It is NOT a timestamp.** A manifest binds a file SET to a root; it says nothing about *when* the
  dataset existed. "Unaltered since date T" is a strictly stronger, time-anchored claim that needs the
  **human-owned signing / timestamp trust-root** — a `needs-human` step recorded in
  [`STRATEGY.md`](../STRATEGY.md) (the loop only BUILDS and locally TESTS; standing up a real signing
  key / timestamp anchor is a human action). Until that trust-root exists, never report or imply
  "unaltered since date T".

- **The `{source, license}` hints are UNTRUSTED self-asserted metadata.** Per-file `hints`
  (source/license) are recorded labeled as untrusted and are **NOT bound into the Merkle root** —
  editing a hint does not change the root, and the summary counts what the dataset **CLAIMS**, it does
  NOT verify any license or source is correct. `(no license hint)` means the manifest asserts nothing,
  NOT that the file is unlicensed.

- **Set-membership ≠ time / authorship / licensing.** A membership proof binds a file to a ROOT; it
  does NOT prove the file is unaltered since a date, who authored it, or under what license — that needs
  the same human-owned signing/timestamp trust-root above.

This is the same boundary the artifacts carry in-band, verbatim, so the caveats can never drift from
the code:

> The Merkle root commits to the full set of (relPath, content) pairs (names AND bytes): any edit, rename, add, or remove changes the root. Per-file `hints` (source/license) are UNTRUSTED, self-asserted metadata — they are NOT bound into the root and prove nothing.

---

## Workflow, end to end

```
build → diff (between versions) → summary → prove (a single file) → verify-proof
```

| Command | What it does | Offline? Key? Network? |
| --- | --- | --- |
| `vh dataset build <dir> --out <p>` | Write a tamper-evident manifest (Merkle root + per-file leaves; optional untrusted hints) | offline, no key, no network |
| `vh dataset verify <dir> --manifest <p>` | Re-derive the root from a fresh copy on disk + a per-file ADDED/REMOVED/CHANGED diff vs the manifest | offline, no key, no network |
| `vh dataset diff <manifestA> <manifestB>` | Compare two manifests; report the exact change set between versions | offline, no tree, no key, no network |
| `vh dataset summary <manifest>` | Provenance/license roll-up over the trusted file set | offline, no tree, no key, no network |
| `vh dataset prove --file <p> --manifest <m> --out <a>` | Build a portable set-membership proof for ONE file | offline, no key, no network |
| `vh dataset verify-proof <proof>` | Fold the membership proof back to the recorded root | purely offline, no dataset, no key, no network |

### Worked example

Manifest a dataset, then snapshot a later version and ask what changed.

```sh
# 1. BUILD a manifest of dataset version 1 (optionally attach untrusted source/license hints).
vh dataset build ./dataset-v1 --out v1.manifest.json --hints ./hints.json
#   wrote v1.manifest.json   root: 0xabc…   fileCount: 1024

# 2. VERIFY a fresh copy on disk re-derives the same root, and localize any drift per file.
vh dataset verify ./dataset-v1 --manifest v1.manifest.json
#   MATCH — recomputed root == manifest root        (exit 0)

# 3. Later: build version 2's manifest, then DIFF the two versions OFFLINE (no datasets on disk).
vh dataset build ./dataset-v2 --out v2.manifest.json
vh dataset diff v1.manifest.json v2.manifest.json
#   DIFFERENT
#     ADDED:   12 files
#     REMOVED:  3 files
#     CHANGED:  5 files (relPath same, content differs)     (exit 3)

# 4. SUMMARY: the provenance/license roll-up a reviewer reads.
vh dataset summary v2.manifest.json
#   fileCount: 1033   root: 0xdef…
#   licenses:  { MIT: 900, CC-BY-4.0: 110, (no license hint): 23 }
#   TRUST: the file SET is bound into the root; hints are UNTRUSTED self-asserted metadata.

# 5. PROVE one file was a member of v2, as a portable artifact…
vh dataset prove --file ./dataset-v2/img/0007.jpg --manifest v2.manifest.json --out 0007.proof.json
#   MEMBER — wrote 0007.proof.json                  (exit 0)

# 6. …and the reviewer VERIFY-PROOFs it on an air-gapped machine — no dataset, no manifest, no key, no net.
vh dataset verify-proof 0007.proof.json
#   CONFIRMED — leaf folds to the recorded root      (exit 0)
```

Exit codes are CI-friendly: `vh dataset verify` and `vh dataset diff` exit `3` on
mismatch/difference (so a pipeline can gate "the training set changed unexpectedly"), `0` on
match/identical; `vh dataset prove`/`verify-proof` exit `0` MEMBER/CONFIRMED, `3` non-member/rejected.

---

## What an auditor / EU AI Act reviewer gets

A mapping from the reviewer's question to the command that produces the evidence:

| Reviewer's question | Command | Evidence produced |
| --- | --- | --- |
| "Exactly which files — names and bytes — did this dataset contain?" | `vh dataset build` | A manifest: a Merkle root over every `(relPath, content)` pair + per-file leaves |
| "Is this copy of the dataset byte-for-byte the one you manifested?" | `vh dataset verify` | Recomputed-root vs manifest-root verdict + a per-file ADDED/REMOVED/CHANGED localization |
| "What changed in the training data between model version N and N+1?" | `vh dataset diff` | The precise add/remove/change set between two manifests (offline) |
| "What is the provenance/license composition of the dataset?" | `vh dataset summary` | A `{source, license}` histogram over the trusted file set (claims, clearly labeled untrusted) |
| "Prove this specific record/file was actually in the dataset." | `vh dataset prove` → `vh dataset verify-proof` | A portable, offline-verifiable set-membership proof for one file |

What this mapping deliberately does NOT claim: a wall-clock "unaltered since date T", and the
truth of any `{source, license}` hint. Both require the human-owned signing/timestamp trust-root
(`needs-human`, see [`STRATEGY.md`](../STRATEGY.md)).

---

## See also

- [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md) — the full trust model the caveats above reuse.
- [`docs/MERKLE-LEAVES.md`](MERKLE-LEAVES.md) — the exact path-bound leaf/root construction the
  manifest commits to (DataLedger reuses it unchanged).
- [`docs/PROOFS.md`](PROOFS.md) — the portable proof-artifact schema membership proofs reuse.

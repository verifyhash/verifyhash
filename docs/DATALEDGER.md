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
build → diff (between versions) → summary → check (the policy gate) → report (the filed deliverable) → attest (the signing-ready payload) → [human signs, P-3] → verify-attest (offline-verify a signed container) → prove (a single file) → verify-proof
```

| Command | What it does | Offline? Key? Network? |
| --- | --- | --- |
| `vh dataset build <dir> --out <p>` | Write a tamper-evident manifest (Merkle root + per-file leaves; optional untrusted hints) | offline, no key, no network |
| `vh dataset verify <dir> --manifest <p>` | Re-derive the root from a fresh copy on disk + a per-file ADDED/REMOVED/CHANGED diff vs the manifest | offline, no key, no network |
| `vh dataset diff <manifestA> <manifestB>` | Compare two manifests; report the exact change set between versions | offline, no tree, no key, no network |
| `vh dataset summary <manifest>` | Provenance/license roll-up over the trusted file set | offline, no tree, no key, no network |
| `vh dataset check <manifest> --policy <p> [--json]` | GATE the manifest's self-asserted hints against a written license/source policy: PASS/FAIL + the exact violating files; CI-gateable exit 0/3 | offline, no tree, no key, no network |
| `vh dataset report <manifest> [--verify <dir>] [--policy <p>] [--json] [--out <p>]` | Consolidate identity + roll-up + (optional) verify verdict + (optional) policy verdict + caveats into ONE deterministic evidence document the reviewer files | offline, no key, no network |
| `vh dataset attest <manifest> [--json] [--out <p>]` | Emit the canonical, byte-deterministic UNSIGNED attestation payload (root + fileCount + manifestDigest) a human signing/timestamp trust-root will sign | offline, no key, no network |
| `vh dataset sign <manifest> --key-env <VAR>\|--key-file <p> [--out <p>] [--json]` | Sign the UNSIGNED attestation with a key YOU provisioned → the signed container `verify-attest` accepts. Read-only of YOUR key; never generates/persists/logs a key | offline, **caller-supplied key**, no network |
| `vh dataset verify-attest <signed> [--manifest <m>] [--signer <addr>] [--json]` | OFFLINE-verify a SIGNED attestation container: recover the signer, optionally pin the publisher (`--signer`) and bind to your manifest (`--manifest`); ACCEPTED/REJECTED with a CI-gateable exit 0/3 | offline, no key, no network |
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
match/identical; `vh dataset prove`/`verify-proof` exit `0` MEMBER/CONFIRMED, `3` non-member/rejected;
and `vh dataset check` exits `0` PASS / `3` FAIL (the policy gate, below).

---

## Policy compliance gate

`vh dataset summary` *describes* a dataset's license/source composition; `vh dataset check <manifest>
--policy <p>` **GATES** it. It is the difference between "a provenance report" and "a compliance control":
the control your pipeline runs on every change and the verdict your auditor files (an EU-AI-Act
technical-documentation / enterprise due-diligence packet). It answers the one question a compliance
reviewer and a CI job actually ask — **"does this training set VIOLATE our written policy?"** — as a
deterministic, OFFLINE PASS/FAIL with the exact list of which files broke which rule.

> **Trust posture, FIRST (the same wording the artifact carries in-band, verbatim).** The `{source,
> license}` hints checked here are **UNTRUSTED, self-asserted metadata that are NOT bound into the
> Merkle root.** A PASS means the dataset's self-asserted hints satisfy this policy —
> **NOT that the licenses are genuinely correct.** A `(no license hint)` file ASSERTS NOTHING (the `requireLicense` rule
> is the one that flags it). This NEVER verifies that any license or source is real. It is the same
> boundary every DataLedger artifact carries:
>
> > The Merkle root commits to the full set of (relPath, content) pairs (names AND bytes): any edit, rename, add, or remove changes the root. Per-file `hints` (source/license) are UNTRUSTED, self-asserted metadata — they are NOT bound into the root and prove nothing.

### The policy file

A policy is a small, versioned, strictly-validated JSON document. A corrupt, foreign, or malformed
policy is **rejected outright** (never half-accepted into a surprise verdict). Two fixed fields identify
it, then every RULE field is **optional and combinable**:

| Field | Required | Type | Meaning / match semantics |
| --- | --- | --- | --- |
| `kind` | yes | string | MUST be exactly `verifyhash.dataset-policy`. |
| `schemaVersion` | yes | number | MUST be a supported version (this build understands `1`). |
| `allowLicenses` | no | string[] | A file whose license hint is **NOT** in this list VIOLATES. A file with **no** license hint also violates (it is in no allowlist). |
| `denyLicenses` | no | string[] | A file whose license hint **IS** in this list VIOLATES. A file with **no** license hint does NOT violate (no value to match). |
| `allowSources` | no | string[] | Same as `allowLicenses`, on the `source` hint. |
| `denySources` | no | string[] | Same as `denyLicenses`, on the `source` hint. |
| `requireLicense` | no | boolean | When `true`, every file MUST carry a license hint; a `(no license hint)` file VIOLATES. This is the ONE rule that flags a missing hint. |

**Match semantics (so a verdict is reproducible).** A file's "license hint value" is its
`hints.license` string, or the **absence** of one (no `hints` at all, or `hints` with no `license`);
likewise for `hints.source`. All comparisons against the policy's lists are **CASE-SENSITIVE EXACT STRING
matches** — `"GPL-3.0"` matches only `"GPL-3.0"`, never `"gpl-3.0"` or `"GPL-3.0-or-later"`. A missing
hint is reported with the explicit `(no license hint)` / `(no source hint)` sentinel value, never a
literal string named that.

**The no-rules case.** A policy that declares **no rules** (no list fields, or only empty lists, and
`requireLicense` not `true`) is valid and **trivially PASSes** — every dataset satisfies a policy with no
constraints. `vh dataset check` says so explicitly (`rules evaluated: 0` + a NOTE) so a green check from
an empty policy can never be mistaken for a real gate.

### `vh dataset check` — the gate

`vh dataset check <manifest> --policy <p>` reads the manifest via the SAME strict reader the other
commands use and the policy via its strict reader, then evaluates the manifest's **trusted file set**
against the policy in a **pure, deterministic** function (no tree, no provider, no key, no network) and
emits a verdict:

- **PASS / FAIL.** PASS when no file's self-asserted hints violate any rule; FAIL when at least one does.
- **The violating-file output.** On FAIL, one line per violation — the **file (relPath)**, the **rule it
  broke**, and the **offending hint value** — sorted by relPath then rule, so two runs over the same
  inputs produce byte-identical output. A single file that breaks two rules produces two lines.
- **The 0/3 exit contract a CI job gates on.** `vh dataset check` exits **`0` on PASS, `3` on FAIL** —
  the SAME data-divergence exit convention as `vh dataset verify`/`diff`, so all dataset gates share one
  contract. A missing/unreadable manifest or policy is a runtime error (exit `1`); a missing `--policy`
  is a usage error (exit `2`) — a gate with no policy must never silently pass. So a pipeline step is
  simply `vh dataset check ds.manifest.json --policy org-policy.json` and the build blocks on a non-zero
  exit.
- **`--json`.** Emits the machine object
  `{ verdict, fileCount, rulesEvaluated, violations: [{ relPath, rule, value }] }` for an ingestion
  pipeline. The `rule` strings are stable identifiers a consumer can gate on
  (`allowLicenses` / `denyLicenses` / `allowSources` / `denySources` / `requireLicense`).

### `vh dataset report --policy` — embedding the verdict in the filed document

`vh dataset report <manifest> --policy <p>` folds the **SAME pure evaluator** `vh dataset check` runs
(verbatim — no re-implementation) into the filed evidence document as a **"Policy compliance" section**:
the verdict, the number of rules evaluated, and (on FAIL) the violating files. Because it reuses the same
evaluator, the report's PASS/FAIL **can never diverge** from `vh dataset check`'s for the same manifest +
policy. The section LEADS with the same UNTRUSTED-hints caveat as `vh dataset check`, so the embedded
verdict never implies a real license was checked.

`--policy` combines with `--verify` to make **one report invocation a complete CI gate**: with `--verify`
the exit is `0` MATCH / `3` MISMATCH; with `--policy` it is `0` PASS / `3` FAIL; with **both**, the report
exits `3` if **EITHER** the live-tree verify is a MISMATCH OR the policy is a FAIL, and `0` only when the
verify is MATCH **and** the policy is PASS — so a single command gates data integrity AND policy
compliance, and the buyer's filed document shows both verdicts.

### Worked example — build with hints, write a policy, check, then embed in a report

```sh
# 1. BUILD a manifest, attaching the (UNTRUSTED, self-asserted) source/license hints per file.
vh dataset build ./dataset-v2 --out v2.manifest.json --hints ./hints.json
#   wrote v2.manifest.json   root: 0xdef…   fileCount: 1033

# 2. WRITE a policy: a proprietary product that forbids copyleft and requires every file to be licensed.
cat > org-policy.json <<'JSON'
{
  "kind": "verifyhash.dataset-policy",
  "schemaVersion": 1,
  "denyLicenses": ["GPL-3.0", "AGPL-3.0"],
  "requireLicense": true
}
JSON

# 3. CHECK the dataset against the policy — the gate a CI job runs (exit 0 PASS / 3 FAIL).
vh dataset check v2.manifest.json --policy org-policy.json
#   TRUST: the {source, license} hints checked here are UNTRUSTED, self-asserted metadata. …
#   policy check: FAIL
#   files:           1033
#   rules evaluated: 2
#   FAIL: 2 violations (each line: the file, the rule it broke, and the offending hint value):
#     src/vendored/lib.py   [denyLicenses]      value: GPL-3.0
#     data/notes.txt        [requireLicense]    value: (no license hint)     (exit 3)

# 4. …or as a machine object for an ingestion pipeline:
vh dataset check v2.manifest.json --policy org-policy.json --json
#   {"verdict":"FAIL","fileCount":1033,"rulesEvaluated":2,"violations":[…]}

# 5. EMBED the SAME verdict in the ONE document the reviewer files (and gate integrity + policy at once):
vh dataset report v2.manifest.json --verify ./dataset-v2 --policy org-policy.json --out evidence.md
#   dataset report written: /abs/path/evidence.md     (exit 3 if EITHER verify MISMATCH or policy FAIL)
```

> **What a PASS does and does NOT mean.** A PASS attests that the dataset's **self-asserted hints satisfy
> the policy** — the control your pipeline ran and the verdict your auditor files. It is **NOT** a claim
> that the licenses are genuinely correct, nor a timestamp ("unaltered since date T"). Those require the
> human-owned signing/timestamp trust-root (`needs-human`, P-3 in [`STRATEGY.md`](../STRATEGY.md)).

---

## The evidence report

A reviewer does not file three terminal outputs — they file **one document**. `vh dataset report
<manifest> [--verify <dir>] [--policy <p>] [--json] [--out <p>]` consolidates everything a manifest
already proves into a single deterministic artifact you attach to an EU-AI-Act technical-documentation
section or an enterprise data-provenance due-diligence packet.

It **invents no new math.** The dataset identity (root + fileCount) comes from the strict manifest read;
the provenance/license roll-up reuses the SAME aggregation `vh dataset summary` emits (identical
histogram order); the optional verification reuses `vh dataset verify` verbatim; the optional policy
verdict reuses the SAME pure evaluator `vh dataset check` runs (see [Policy compliance
gate](#policy-compliance-gate) above). So the report can never drift from the commands it consolidates.

What it consolidates, in a stable section order:

1. **Trust posture, FIRST.** The same in-band `TRUST_NOTE` (file SET bound into the root and trustworthy;
   `{source, license}` hints UNTRUSTED and NOT bound into the root) plus the explicit no-overclaim line:
   this report is NOT a timestamp — it does not prove the dataset is "unaltered since date T", nor
   authorship/licensing.
2. **Dataset identity** — the Merkle `root` and `fileCount`.
3. **Verification status** — either the embedded `--verify` verdict, or a plain statement that NO
   live-tree verification was performed (so the report never *implies* a verify that did not run).
4. **Policy compliance** — ONLY when `--policy` is given: the PASS/FAIL verdict, rules evaluated, and (on
   FAIL) the violating files (relPath / rule / value), leading with the same UNTRUSTED-hints caveat as
   `vh dataset check`. Omitted entirely without `--policy`, so the report never implies a gate that did
   not run.
5. **Provenance / license roll-up** — the `{source, license}` histogram over the trusted file set.

**Deterministic Markdown vs `--json`.** The default human output is a Markdown document with a stable
section order and a histogram ordered by the same rule `vh dataset summary` uses, so two runs over the
same manifest produce **byte-identical Markdown** — suitable to attach to a filing and to diff in CI.
`--json` emits the same consolidated model as a machine object for an ingestion pipeline. `--out <p>`
writes the document to a caller-chosen explicit path (never silently the cwd) and names the file.

**The optional `--verify` status section.** Without `--verify`, the report documents the manifest's
*claimed* root and says so plainly. With `--verify <dir>` it re-derives the root from the live tree
(still offline — no network) and embeds the **MATCH/MISMATCH verdict** plus the per-file
ADDED/REMOVED/CHANGED localization; under `--verify` the command's exit code mirrors `vh dataset verify`
(`0` on MATCH, `3` on MISMATCH) so a pipeline can gate on it.

**The optional `--policy` compliance section.** With `--policy <p>` the report embeds the SAME PASS/FAIL
verdict `vh dataset check` produces (see above). Combined with `--verify`, ONE report invocation is a
complete CI gate: it exits `3` if **EITHER** the live-tree verify is a MISMATCH **OR** the policy is a
FAIL, and `0` only when both pass.

```sh
# The single document a reviewer files (manifest-only — claims the manifest's root):
vh dataset report v2.manifest.json --out evidence.md
#   dataset report written: /abs/path/evidence.md

# …or with a live-tree verdict embedded, gating on the recomputed-root match (exit 3 on drift):
vh dataset report v2.manifest.json --verify ./dataset-v2 --out evidence.md

# …or with the policy verdict embedded too, so ONE invocation gates integrity AND policy (exit 3 if either fails):
vh dataset report v2.manifest.json --verify ./dataset-v2 --policy org-policy.json --out evidence.md

# …or the machine form for an ingestion pipeline:
vh dataset report v2.manifest.json --json
```

> **What the reviewer files.** This Markdown (or its `--json` twin) IS the deliverable — the EU-AI-Act
> technical-documentation section / due-diligence evidence packet a buyer's compliance process is built
> around — not a transcript of three commands. It still claims nothing past the standing trust posture:
> no wall-clock "unaltered since date T", no truth of any `{source, license}` hint.

---

## Unsigned attestation payload

`vh dataset attest <manifest> [--json] [--out <p>]` emits the **canonical, byte-deterministic** payload a
human-owned signing/timestamp trust-root will sign. It is the bridge that turns the human step (P-3) from
"design and sign a payload" into "sign THIS exact file."

**What it commits to.** A small envelope binding the dataset IDENTITY:

- `root` — the manifest's Merkle root.
- `fileCount` — the number of files in the committed set.
- `manifestDigest` — `keccak256` over a canonical serialization of the manifest's committed file set
  (each entry's root-committed `{relPath, contentHash, leaf}`, keys in fixed order, entries sorted by
  `relPath`, no insignificant whitespace; the UNTRUSTED `hints` are excluded). Any edit/rename/add/remove
  to the committed set changes the digest.

The envelope serializes with a fixed top-level key order and no insignificant whitespace, so **two runs
over the same manifest produce identical bytes** — that determinism is exactly what makes "sign the
bytes" well-defined. `--json` emits those same canonical bytes (pipe it straight into a signer); `--out
<p>` writes them to a caller-chosen explicit path (never the cwd) and names the file.

**It is UNSIGNED — and says so, in-band.** The envelope carries an explicit `signed: false` and a
`signature: null` slot, plus the standing caveat verbatim. The strict reader REJECTS any payload that
claims `signed: true` or a non-null `signature`, so this build can never be tricked into treating a
hand-edited envelope as if it were signed.

```sh
# Emit the canonical UNSIGNED payload (the exact bytes a signer/timestamp service signs over):
vh dataset attest v2.manifest.json --out v2.attestation.json
#   dataset attestation written: /abs/path/v2.attestation.json

# …or to stdout / piped into a signer:
vh dataset attest v2.manifest.json --json
```

> **Attaching a real signature/timestamp is the human-owned trust-root.** Standing up a real signing key
> or an external timestamp authority is a `needs-human` step recorded in
> [`STRATEGY.md`](../STRATEGY.md) as **P-3** — the loop only BUILDS and locally TESTS the UNSIGNED
> payload. Until a signature is attached, this payload proves only the same set-membership / identity the
> manifest already does — **NOT** that the dataset is unaltered since a date T. Do not overclaim past P-3.

### Signed attestation + verification

The UNSIGNED payload above is the bytes a publisher signs; this build also ships the **detached signature
container that WRAPS those bytes** and the **offline VERIFIER** a buyer runs to confirm a signature is
genuine — `vh dataset verify-attest`. Read the boundary FIRST, because it is exactly the standing dataset
trust posture plus one signing-specific line:

> **Trust posture, FIRST (reuses the standing dataset `TRUST_NOTE` verbatim).** A valid signature proves
> **the holder of `signer`'s key vouched for THIS dataset identity** (the embedded `root` / `fileCount` /
> `manifestDigest`). It does **NOT** by itself prove a trustworthy TIMESTAMP — there is still no "unaltered
> since a date T" unless the `scheme` is a timestamp authority, which is **still the human-owned trust-root,
> `needs-human`, P-3** in [`STRATEGY.md`](../STRATEGY.md). It does **NOT** validate that the dataset's
> `{source, license}` hints are genuinely correct (that is `vh dataset check`'s untrusted-hint caveat). It
> is the same boundary every DataLedger artifact carries:
>
> > The Merkle root commits to the full set of (relPath, content) pairs (names AND bytes): any edit, rename, add, or remove changes the root. Per-file `hints` (source/license) are UNTRUSTED, self-asserted metadata — they are NOT bound into the root and prove nothing.

> **CRITICAL — what this build ships, and what it does NOT.** This build ships the **FORMAT** (the
> signed-container schema below), the **VERIFIER** (`vh dataset verify-attest`), **AND the SIGNING command**
> (`vh dataset sign`, below) — all proved end-to-end in the test suite with **EPHEMERAL, throwaway
> `Wallet.createRandom()` keys generated in-process and never persisted**. **Provisioning a real signing key
> and choosing trust-root option A/B/C is still the human-owned trust-root, P-3** (`needs-human`,
> [`STRATEGY.md`](../STRATEGY.md)). The loop NEVER generates, holds, persists, or logs a real key — `vh
> dataset sign` reads a key the human provisioned OUTSIDE the loop, uses it in-process ONLY to sign, and
> discards it. Emitting/signing/verifying a signed container NEVER implies "unaltered since date T": a signed
> container says only "this key vouched for this dataset identity" — the trustworthy *timestamp* is the part
> P-3 still owns.

#### The signed-container schema (`verifyhash.dataset-attestation-signed`)

The signed container **WRAPS, never edits** the unsigned payload: it embeds the EXACT canonical UNSIGNED
bytes verbatim (byte-for-byte the string `vh dataset attest` emits, including its trailing newline) and
attaches a detached signature alongside. Every field, with a FIXED key order so the container is itself
byte-deterministic:

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | string | MUST be exactly `verifyhash.dataset-attestation-signed`. |
| `schemaVersion` | number | MUST be a supported version (this build understands `1`). |
| `note` | string | The standing in-band trust caveat (the dataset `TRUST_NOTE` + the signing-specific line above), carried verbatim so the caveats can never drift from the artifact. |
| `attestation` | string | **The EXACT canonical UNSIGNED bytes**, embedded as a string. Re-parsed and re-validated by the SAME unsigned reader on every read: it must STILL be strictly `signed: false` / `signature: null`, and must be byte-for-byte `serializeAttestation`'s output. |
| `signature` | object | The detached `{ scheme, signer, signature }` triple (below). |
| `signature.scheme` | string | The signature scheme. This build's `scheme` value is **`eip191-personal-sign`** — EIP-191 `personal_sign` over the EXACT embedded canonical bytes (a detached signature, deliberately NOT EIP-712, so the signed message IS the payload bytes verbatim with no separate domain/struct to drift from). |
| `signature.signer` | string | The CLAIMED `0x` signer address, **lowercase** (a checksummed/mixed-case address is rejected for byte-determinism — lowercase it first). |
| `signature.signature` | string | The detached signature: for `eip191-personal-sign`, a 65-byte `r‖s‖v` secp256k1 signature as a **lowercase** `0x`-hex string (130 hex chars). |

**The wrap-don't-edit invariant.** The embedded `attestation` stays strictly `signed: false` /
`signature: null`: the strict reader re-parses it and runs the SAME `validateAttestation` the unsigned path
uses (which hard-rejects any `signed: true` / non-null `signature`), then requires the embedded string to
be byte-for-byte canonical. So a signed container can never smuggle in an edited or already-"signed"
payload — wrapping adds a vouch, it never edits the thing vouched for. T-15.2's strict UNSIGNED guarantee
is preserved unchanged.

#### `vh dataset sign` — the one-command signing leg (reads a key YOU provisioned)

`vh dataset sign <manifest> --key-env <VAR> | --key-file <path> [--out <p>] [--json]` is the **one command
that turns "a human has a key" into a signed container a buyer can verify.** It builds the UNSIGNED payload
exactly as `vh dataset attest` does (no re-implementation), constructs an in-process ethers `Wallet` from
the key YOU supply, signs the canonical bytes (`eip191-personal-sign`), and **wraps WITHOUT editing** the
payload into the `verifyhash.dataset-attestation-signed` container the existing `vh dataset verify-attest`
accepts. The result round-trips by construction.

**Key hygiene (load-bearing — the property that keeps this guardrail-safe).** `vh dataset sign` performs a
**read-only of a key YOU provisioned outside this tool**; it **never generates, never persists, and never
logs (or echoes) a key**, and it is **OFFLINE — no provider, no network**. The key is read from EXACTLY ONE
of `--key-env <VAR>` (read `process.env[VAR]`) or `--key-file <path>` (a file you created), used in-process
ONLY to sign, then discarded. **Neither source, both sources, a missing env var, an unreadable file, or a
malformed/all-zero key HARD-ERRORS before any signing**, with a message that names only the SOURCE (the env
var name or the file path) — **never the key material**. On success the output prints ONLY the PUBLIC signer
address, the output path, and the scheme. A usage error (no `<manifest>`, or not exactly one key source)
exits `2`; a runtime error (bad key, unreadable manifest) exits `1`.

> **Trust posture (inherited verbatim — a signature is NOT a timestamp).** This is the SHARED in-band
> `SIGN_TRUST_NOTE` (`cli/dataset.js`), the same wording the `sign` command prints and the human reads, so
> the caveat can never drift from the code:
>
> > This signs the dataset IDENTITY (root, fileCount, manifestDigest) with the key YOU supplied. A self-managed key attests "the signer says so" — it is NOT an independent, trusted TIMESTAMP: "existed/unaltered since a date T" still needs the human-owned signing/timestamp trust-root (needs-human, P-3). The key must be one YOU provisioned OUTSIDE this tool.
>
> The stronger B/C options buy an independent timestamp; (A) does not. It also still carries the standing
> dataset caveat verbatim:
>
> > The Merkle root commits to the full set of (relPath, content) pairs (names AND bytes): any edit, rename, add, or remove changes the root. Per-file `hints` (source/license) are UNTRUSTED, self-asserted metadata — they are NOT bound into the root and prove nothing.

```sh
# Sign the dataset attestation with a key YOU provisioned outside the loop (env var or key file).
# Read-only of YOUR key; never generates/persists/logs a key; OFFLINE; no network.
vh dataset sign v2.manifest.json --key-env DATASET_SIGNING_KEY --out v2.attestation.signed.json
#   TRUST: This signs the dataset IDENTITY … it is NOT an independent, trusted TIMESTAMP …
#   signed by 0x<your public address>
#     scheme: eip191-personal-sign
#     signed attestation written: /abs/path/v2.attestation.signed.json
```

#### `vh dataset verify-attest` — the offline verifier

`vh dataset verify-attest <signed> [--manifest <m>] [--signer <addr>] [--json]` is **purely offline — no
tree walk, no provider, no key, no network.** It reads the container with the strict reader (a
malformed/edited/foreign container is rejected, never half-accepted), then runs up to three checks:

1. **Signature recovery (always).** Recover the signer from the embedded canonical bytes + signature
   (`eip191-personal-sign` → ethers' `verifyMessage` over exactly those bytes) and confirm it equals the
   container's CLAIMED `signer`. A signature that does not recover to the claimed signer — or a tampered,
   unrecoverable signature — is a clean **REJECTED**, not a crash.
2. **`--signer <addr>` (optional publisher pin).** Confirm the RECOVERED signer equals the SPECIFIC
   publisher address the buyer pinned — so a buyer pins WHO must have signed, not merely that someone did.
   Accepts a checksummed or lowercase address.
3. **`--manifest <m>` (optional identity binding).** Recompute the canonical UNSIGNED bytes from the
   buyer's OWN manifest via the EXISTING build path and require them byte-identical to the embedded
   (signed-over) payload — proving the signature binds the dataset the buyer actually holds, not some other
   set.

**The 0/3 exit contract a buyer's CI gates on.** The verdict is **ACCEPTED only when EVERY requested check
passes**; any failure is REJECTED. It exits **`0` on ACCEPTED, `3` on REJECTED** — the SAME
data-divergence convention as `vh dataset verify` / `diff` / `check`, so all dataset gates share one exit
contract. A usage error (e.g. missing `<signed>`) exits `2`; a missing/corrupt container or manifest is a
runtime error (exit `1`). `--json` emits the machine object
`{ verdict, accepted, recoveredSigner, claimedSigner, scheme, checks: { signatureMatchesSigner,
signerMatchesExpected, manifestBindsAttestation }, expectedSigner, manifestChecked, failedChecks }` — the
`checks.*` booleans are `null` for a check that was not requested (never a silent fail), and `failedChecks`
names the stable rule ids a consumer gates on. So a buyer's pipeline step is simply
`vh dataset verify-attest signed.json --signer 0x<ourPublishedAddr> --manifest ds.manifest.json` and the
build blocks on a non-zero exit.

#### Worked end-to-end example (attest → sign → verify-attest)

```sh
# 1. ATTEST: emit the canonical UNSIGNED bytes (the exact bytes the publisher signs over).
vh dataset attest v2.manifest.json --out v2.attestation.json
#   dataset attestation written: /abs/path/v2.attestation.json

# 2. [HUMAN-OWNED, P-3 — PROVISION ONLY] Provision a real signing key OUTSIDE the loop (env var or key file),
#    then SIGN with ONE command. The loop NEVER generates/persists/logs the key — `vh dataset sign` reads the
#    key YOU provisioned, signs the canonical bytes (eip191-personal-sign), and wraps them WITHOUT editing the
#    payload (it stays signed:false). Choosing/provisioning the key + trust-root option A/B/C is the P-3 part.
vh dataset sign v2.manifest.json --key-env DATASET_SIGNING_KEY --out v2.attestation.signed.json
#   signed by 0x<your public address>     scheme: eip191-personal-sign
#   signed attestation written: /abs/path/v2.attestation.signed.json
#    (In tests this signing step uses an EPHEMERAL throwaway Wallet.createRandom() key — never a real key.)

# 3. The BUYER VERIFIES offline — no key, no network — pinning WHO signed AND binding it to THEIR dataset:
vh dataset verify-attest v2.attestation.signed.json \
  --signer 0x<the publisher's published address> --manifest ./my-copy.manifest.json
#   TRUST: A valid signature proves the holder of `signer`'s key vouched for THIS dataset identity …
#   verify-attest: ACCEPTED
#   [PASS] signature recovers to the claimed signer
#   [PASS] recovered signer matches the expected publisher (0x…)
#   [PASS] the signature binds YOUR manifest (its canonical bytes are byte-identical to the signed payload)
#   ACCEPTED: every requested check passed.            (exit 0; exit 3 if ANY requested check FAILs)
```

> **Still bounded by P-3.** An ACCEPTED verdict proves the key-holder vouched for this dataset identity —
> it does **NOT** prove a trustworthy timestamp ("unaltered since date T") and does **NOT** validate any
> `{source, license}` hint. The trustworthy timestamp is the human-owned trust-root, `needs-human`, P-3 in
> [`STRATEGY.md`](../STRATEGY.md). This build ships the FORMAT, the VERIFIER, AND the `vh dataset sign`
> command (all proved with throwaway test keys); the human still owns PROVISIONING the key and choosing
> trust-root option A/B/C.

---

## What an auditor / EU AI Act reviewer gets

A mapping from the reviewer's question to the command that produces the evidence:

| Reviewer's question | Command | Evidence produced |
| --- | --- | --- |
| "Exactly which files — names and bytes — did this dataset contain?" | `vh dataset build` | A manifest: a Merkle root over every `(relPath, content)` pair + per-file leaves |
| "Is this copy of the dataset byte-for-byte the one you manifested?" | `vh dataset verify` | Recomputed-root vs manifest-root verdict + a per-file ADDED/REMOVED/CHANGED localization |
| "What changed in the training data between model version N and N+1?" | `vh dataset diff` | The precise add/remove/change set between two manifests (offline) |
| "What is the provenance/license composition of the dataset?" | `vh dataset summary` | A `{source, license}` histogram over the trusted file set (claims, clearly labeled untrusted) |
| "Does this dataset VIOLATE our written license/source policy? (the control CI runs)" | `vh dataset check --policy` | A PASS/FAIL verdict + the exact violating files (relPath / rule / value); a CI-gateable exit code (0 PASS / 3 FAIL) over the dataset's self-asserted hints (clearly labeled untrusted) |
| "Give me ONE document to file in the technical-documentation / due-diligence packet." | `vh dataset report` | A single deterministic Markdown (or `--json`) document: dataset identity + the provenance/license roll-up + the standing trust caveats + an optional live-tree verify verdict + (with `--policy`) the embedded policy-compliance verdict |
| "Give me the exact bytes our publisher (or a timestamp authority) will sign over." | `vh dataset attest` | A canonical, byte-deterministic UNSIGNED attestation payload committing to `root` / `fileCount` / `manifestDigest` (the file a human signing/timestamp trust-root signs — see P-3) |
| "I provisioned a signing key — turn the attestation into a signed container in one command." | `vh dataset sign` | The `verifyhash.dataset-attestation-signed` container, signed (`eip191-personal-sign`) with the key YOU supplied (`--key-env`/`--key-file`), ready for any buyer to `verify-attest`. Read-only of your key; never generates/persists/logs a key; offline. Attests the IDENTITY + "the signer says so" — NOT a timestamp (still P-3) |
| "A vendor handed me a 'signed by the publisher' attestation — confirm it is genuine and binds the dataset I hold." | `vh dataset verify-attest` | An OFFLINE ACCEPTED/REJECTED verdict: the signature recovers to the claimed signer, (with `--signer`) the recovered signer is the publisher I pinned, and (with `--manifest`) it binds MY dataset; CI-gateable exit 0/3. Proves the key-holder vouched for this dataset identity — NOT a timestamp (P-3) |
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

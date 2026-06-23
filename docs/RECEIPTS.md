# verifyhash receipts — schema, lifecycle, and diff semantics

This is the canonical spec for the on-disk **receipt** artifacts that `cli/receipt.js` reads and
writes (tasks **T-6.1** and **T-6.2**). A receipt is a versioned, strictly-validated JSON file that
makes two CLI flows durable and operable:

- a **claim receipt** (`kind: "verifyhash.claim-receipt"`) persists everything `reveal()` needs so a
  crashed/interrupted commit-reveal claim can be **resumed** from a fresh process (T-6.1);
- an **anchor receipt** (`kind: "verifyhash.anchor-receipt"`) records the per-file **manifest** of a
  directory so a later `vh verify <dir> --receipt <p>` can **localize** which file diverged (T-6.2).

> **Trust posture (read this first).** A receipt is an **UNTRUSTED local convenience**, exactly as
> stated in [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md). The authoritative result always comes
> from the on-chain record — for `verify`, from re-deriving the Merkle root and comparing it to that
> record. A receipt's `manifest` only **localizes** which file diverged; it can never, by itself, make
> content "verified". Rule of thumb: **the on-chain root decides MATCH/MISMATCH; the receipt manifest
> only points at the file.** The one field that is operationally load-bearing is the claim receipt's
> secret `salt` — see [Trust vs hints](#trust-vs-hints).

The receipt is **never** consumed by the contract and is **never** uploaded anywhere. **A claim receipt
holds the SECRET `salt`**, so where it is written is always something you opt into — `vh` never silently
drops it into your repo unless you ask:

- the durable **`vh commit`** writes a claim receipt to `--receipt <path>` (exact file) or
  `--receipt-dir <dir>` (into that folder under a tidy default file name), or — with neither — defaults
  to `<cwd>/<contentHashPrefix>.vhclaim.json` **and prints the EXACT absolute path it wrote**
  (`receipt written: <abs path>`), so you can always see, move, or delete it. It is never written
  somewhere you can't find;
- the one-shot **`vh claim`** persists a receipt **only if you pass `--receipt`/`--receipt-dir`**; with
  neither it writes **nothing** (the in-memory receipt is just returned to the caller). Use `vh commit`
  for a durable, resumable claim;
- the pure helper `defaultReceiptPath(contentHash)` only computes a **relative** file name
  (`./<prefix>.vhclaim.json`); the caller is responsible for resolving it against a safe base.

Receipt files are also git-ignored (`*.vhclaim.json`). **Keep a claim receipt private until you reveal:**
anyone holding the `salt` before reveal could front-run the open (after a successful reveal the
commitment is single-use and spent, so the receipt is no longer sensitive). This reuses the trust posture
in [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md): the receipt is an **untrusted local convenience**;
the authoritative result always comes from the on-chain record.

---

## Schema

Two `kind`s share a common header. `readReceipt` validates **strictly** and throws on ANY deviation
rather than filling defaults: a partial claim receipt could make you re-derive a wrong commitment or
reveal with the wrong salt and waste (or burn) a transaction, so a corrupt receipt is rejected outright,
never silently half-accepted.

### Common header (every receipt)

| Field | Type | Required | Trust | Meaning |
|-------|------|----------|-------|---------|
| `kind` | string | yes | structural | `"verifyhash.claim-receipt"` or `"verifyhash.anchor-receipt"`. A discriminator so a random JSON file is never mistaken for a receipt. |
| `schemaVersion` | integer | yes | structural | On-disk schema version. This build **writes** `4` and **reads** `1`, `2`, `3`, or `4`. Any other version is rejected, so a future/foreign file is never misread. (`1` → base, `2` added the optional `manifest`, `3` added the optional `git` block, `4` added the optional `parent` on a CLAIM receipt — all additive.) |
| `contentHash` | `0x`+64 hex (32 bytes) | yes | **trusted-as-target** | The digest being claimed/anchored: a file's `keccak256`, or a directory's Merkle **root** (see [`docs/MERKLE-LEAVES.md`](MERKLE-LEAVES.md)). This is the only thing the chain attests to; everything else is metadata. |
| `contractAddress` | `0x`+40 hex (address) | yes | hint | The `ContributionRegistry` the receipt is about. Used to target the right contract on resume. |
| `chainId` | non-negative integer | yes | hint | Chain the commit/anchor was sent to (e.g. `31337` local, `80002` Amoy). |
| `uri` | string | yes (may be `""`) | **UNTRUSTED hint** | Off-chain pointer (IPFS CID, commit URL, …). The contract **never fetches, validates, or hashes it**; consumers must re-fetch + re-hash and compare to `contentHash`. Defaulted to `""`, never `undefined`. |
| `path` | string | optional | informational | The source path that was hashed. For humans only. |
| `targetKind` | `"file"` \| `"dir"` | optional | informational | Whether the target was a single file or a directory. |
| `manifest` | array | optional (v2+) | **UNTRUSTED hint** | Per-file breakdown of a directory target; see [Manifest](#the-manifest-directory-targets). A v1 receipt that carries a manifest is rejected (the version must not lie). |
| `git` | object | optional (v3+) | **UNTRUSTED hint** | Git provenance `{ commit, scope }` recorded by a `--git` anchor/claim; see [Git provenance](#the-git-provenance-block-git-scoped-targets). A v1/v2 receipt that carries a git block is rejected (the version must not lie). |

### Claim receipt — additional fields (`kind: "verifyhash.claim-receipt"`)

A claim receipt carries the **secret material** that lets a separate process finish a commit-reveal claim.

| Field | Type | Required | Trust | Meaning |
|-------|------|----------|-------|---------|
| `salt` | `0x`+64 hex (32 bytes) | yes | **SECRET — keep private** | The blinding salt bound into the commitment. `reveal()` needs this exact value; lose it and the claim is **unrevealable by anyone**. |
| `commitment` | `0x`+64 hex (32 bytes) | yes | trusted-as-derived | `keccak256(abi.encode(contentHash, committer, salt))` — the blinded value that went on-chain in `commit()`. |
| `committer` | `0x`+40 hex (address) | yes | trusted-as-target | The address that committed and is the only one that can reveal (it is hashed into the commitment). |
| `commitTxHash` | `0x`+64 hex (32 bytes) | optional | informational | The `commit()` transaction hash. |
| `commitBlockNumber` | non-negative integer | optional | operational | Block the commit mined in; used to compute when the reveal window matures. |
| `minRevealDelay` | non-negative integer | optional | operational | `MIN_REVEAL_DELAY` read from the contract at commit time; how many blocks must pass before `reveal()`. |
| `parent` | `0x`+64 hex (32 bytes) | optional (v4+) | **UNTRUSTED hint** | The lineage edge (B-10.1): an **already-anchored** predecessor's `contentHash`, recorded by `vh commit --parent`. Present only for a revision; **omitted entirely** for a lineage root (the all-zero hash is rejected, never recorded). On resume, `vh reveal` routes to `revealWithParent(contentHash, salt, uri, parent)` and records the edge; the **authoritative** edge is what that on-chain call records, not this field. It is a *claim* of a predecessor — never proof of content ancestry or any transfer of the parent's authorship. Rejected on an anchor receipt, on a receipt below v4, when malformed/zero, or when equal to `contentHash` (`SelfParent`). |

### Anchor receipt — additional fields (`kind: "verifyhash.anchor-receipt"`)

An anchor receipt has **no secret material at all** (anchoring needs none). Its only reason to exist
beyond the header is the optional directory `manifest`.

| Field | Type | Required | Trust | Meaning |
|-------|------|----------|-------|---------|
| `anchorTxHash` | `0x`+64 hex (32 bytes) | optional | informational | The `anchor()` transaction hash, when one was sent. |
| `anchorBlockNumber` | non-negative integer | optional | informational | Block the anchor mined in. |

> An anchor receipt deliberately has **no `salt`, `commitment`, or `committer`** — there is no secret to
> protect and no signer needed to verify a hash you already know. `readReceipt` rejects an anchor receipt
> that smuggles those in, and a claim receipt missing any of them.

### The manifest (directory targets)

For a directory target the receipt may carry a `manifest` (schemaVersion ≥ 2): the **sorted list of
every file's `{ path, contentHash, leaf }`** — exactly what `vh hash <dir>` / `hashDir()` computes and
then would otherwise discard. Each entry:

| Field | Type | Meaning |
|-------|------|---------|
| `path` | non-empty string | the file's POSIX relative path inside the directory |
| `contentHash` | `0x`+64 hex | `keccak256` of the file's bytes (the bare content digest `c` in [`docs/MERKLE-LEAVES.md`](MERKLE-LEAVES.md)) |
| `leaf` | `0x`+64 hex | the **path-bound** leaf `keccak256(DIR_LEAF_DOMAIN ‖ relPath ‖ 0x00 ‖ c)`, which is what the tree is actually built from |

The manifest is stored **sorted ascending by `leaf` value** (the same total order `hashDir` uses to
build the tree), so a written manifest is deterministic regardless of input enumeration order. Because
the `leaf` binds the path, two files at different paths can never collide, and a leaf change with the
same path is unambiguously a **content** change.

### The git provenance block (`--git`-scoped targets)

When a directory is anchored/claimed with **`--git`** (T-8.2), the root and `manifest` are computed over
**exactly the files git tracks** at a commit — the same reproducible, untracked-junk-ignoring enumeration
as `vh hash <dir> --git` (see [`docs/MERKLE-LEAVES.md`](MERKLE-LEAVES.md)). The receipt then records a
`git` block (schemaVersion ≥ 3):

| Field | Type | Meaning |
|-------|------|---------|
| `commit` | 40-hex (bare, no `0x`) | the resolved commit object id the tracked set was enumerated from (paste straight into `git show <oid>`) |
| `scope` | non-empty string | the repo-relative POSIX path the operator pointed `vh` at (`"."` for the repo root) — *how* the tracked set was scoped |

The `git` block is an **UNTRUSTED convenience hint**, consistent with
[`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md): it records *how* a root was produced so a reader can
reproduce the `--git --ref <oid>` enumeration, but the authoritative verdict is still the **recomputed
root vs the on-chain record**. A receipt's `git.commit` is never re-checked against the chain — the chain
attests only to `contentHash`. `vh verify <dir> --git [--ref <ref>]` re-derives the root over the tracked
set at that ref and reports MATCH/MISMATCH; with `--receipt` it localizes ADDED/REMOVED/CHANGED over the
tracked set. Untracked junk in the work tree never affects the verdict.

### Trust vs hints

Summarizing the columns above, in the same spirit as the [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md)
one-liner table:

| Field(s) | Trust it for | Do NOT trust it for |
|----------|--------------|---------------------|
| `contentHash` | the exact digest/root the on-chain record is keyed by | being "valid" without the on-chain lookup + (for dirs) a recomputed root |
| `salt` (claim only) | finishing **your** reveal — **keep it secret until revealed** | sharing; anyone with it before reveal could front-run the open (and after a successful reveal it is spent and harmless) |
| `commitment`, `committer` | knowing who can reveal and what was committed | proving authorship by themselves — that comes from the on-chain `Record.authorBound` |
| `uri` | a human hint of where the content might be | anything security-relevant — re-fetch + re-hash |
| `manifest` | **localizing** which file diverged (ADDED/REMOVED/CHANGED) | deciding MATCH/MISMATCH — the recomputed root vs the on-chain record decides that |
| `git` (`{ commit, scope }`) | reproducing *how* a `--git` root was enumerated (which commit/scope) | proving the root — it is never re-checked against the chain; the chain attests only to `contentHash` |
| `*TxHash`, `*BlockNumber`, `path`, `targetKind` | operational convenience (resume timing, display) | any security claim |

---

## Commit → reveal resume lifecycle (claim receipts, T-6.1)

The front-running-resistant claim (`vh claim`) is a **two-transaction** commit-reveal flow separated by
a maturation window of `MIN_REVEAL_DELAY` blocks. The commitment is
`keccak256(abi.encode(contentHash, committer, salt))`; only that opaque hash goes on-chain first, so a
mempool watcher cannot copy your content hash. After the window the committer reveals `(contentHash,
salt)`; an attacker who replays the revealed values as themselves recomputes a **different** commitment
they never registered, so their reveal reverts with `NoSuchCommitment` and `contributor` stays the
original committer (full threat model: [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md)).

**The durability problem (why the receipt exists).** On a live testnet the maturation window is minutes.
The single-process `vh claim` holds the secret `salt` only in memory while it waits. If that process
crashes or is interrupted between the two legs, the salt is lost — and since `reveal()` needs that exact
salt, the `contentHash` becomes **committed-but-unrevealable by anyone**, permanently burning the
attribution. The receipt fixes this by persisting the salt (and everything `reveal()` needs) to disk
**before** the commit step returns, so a separate process can finish later.

### The split: `vh commit` then `vh reveal`

```
vh commit ./src --uri ipfs://cid      # sends commit(), writes the receipt, PRINTS its exact path, exits
# ...wait out MIN_REVEAL_DELAY (a few blocks)...
vh reveal --receipt <that exact path>   # resumes from the receipt and reveals
```

1. **`vh commit <path>`** (`runCommit`) hashes the target, derives `(salt, commitment)`, sends
   `commit(commitment)`, reads `MIN_REVEAL_DELAY`, then **writes the claim receipt before it returns**.
   For a directory it also records the `manifest`. The receipt destination is **always opted into**:
   `--receipt <path>` (exact file), `--receipt-dir <dir>` (default name inside that folder), or — with
   neither — `<cwd>/<contentHashPrefix>.vhclaim.json`; in every case the success line names the **exact
   absolute path written** (`receipt written: <abs path>`), so the secret-bearing file is never dropped
   silently. From this point on, a crash is survivable: the salt is durable.
2. **Wait** out `MIN_REVEAL_DELAY` blocks. The commit-block height and the delay are in the receipt, so
   any process can compute when the window matures.
3. **`vh reveal --receipt <p>`** (`runReveal`) `readReceipt`s the file (strict — a corrupt receipt throws
   here rather than producing a wrong reveal), checks the signer **is** the receipt's `committer` (else
   the reveal would hit `NoSuchCommitment`; it fails fast with a clear message instead), waits out the
   window, then sends `reveal(contentHash, salt, uri)`. This needs **no** information that was not durably
   written at commit time, so it works from a completely fresh process — even after a reboot.

**Retry semantics.** If you reveal before the window matures the contract reverts with `RevealTooSoon`;
`runReveal` lets that propagate and **leaves the receipt file untouched**, so you simply retry later. The
receipt is also unaffected by an unrelated crash, so resume is idempotent up to the single successful
reveal.

**`vh claim` is still the one-shot convenience** (commit + reveal in one process). To keep it safe by
default it persists a receipt **only if you ask** — pass `--receipt <path>` or `--receipt-dir <dir>` and
it writes the secret-bearing receipt to that exact, named location (so even the one-shot path is then
crash-recoverable: resume with `vh reveal --receipt <p>`). With **neither**, `vh claim` writes
**nothing** to disk (the in-memory `runClaim` helper just returns the receipt object); use `vh commit`
for a durable, resumable claim rather than relying on a silent cwd drop.

> **Keep the receipt private until you reveal:** it contains the secret `salt`. After a successful reveal
> the commitment is single-use and spent, so the receipt is no longer sensitive.

---

## Directory-manifest diff semantics (anchor receipts, T-6.2)

A one-shot `vh anchor <dir>` records only the Merkle **root** on-chain. So plain `vh verify <dir>` can
only ever say "the whole tree's root matches / does not match" — it cannot say WHICH file diverged.
`vh anchor <dir> --receipt <p>` records the directory's `manifest` (every `{ path, contentHash, leaf }`),
and `vh verify <dir> --receipt <p>` then prints a precise per-file diff.

### How the diff is computed (`diffManifest`)

`diffManifest(recordedManifest, currentLeaves)` is a **pure** localizer. It keys both sides by `path` and
compares the path-bound `leaf`:

- **ADDED** — a path present in the current tree but not in the receipt's manifest.
- **REMOVED** — a path in the receipt's manifest, gone from the current tree.
- **CHANGED** — same `path`, different `leaf`. Because the path is bound into the leaf, an identical key
  with a different leaf is unambiguously a **content** change; the diff reports `oldContentHash` → `newContentHash`.
- **unchanged** — same `path`, same `leaf`.
- `identical: true` iff there are zero added, removed, or changed entries.

### What decides the verdict (and what does not)

The diff **does not** decide MATCH/MISMATCH. The authoritative verdict is the same re-derive-and-compare
check the trust model requires: `vh verify` recomputes the directory's Merkle **root** from the files on
disk and compares that root to the on-chain record. **MATCH/MISMATCH comes only from that comparison.**
The manifest never participates in the verdict.

A malicious or stale receipt can at worst mislabel which file moved, and even that is caught: `verify`
flags a receipt whose recorded root does not match the recomputed root (`receiptHashMismatch`) and reports
it as a **different directory snapshot** rather than silently pretending the files line up. The verify
output leads with the caveat:

```
  --- receipt manifest diff (UNTRUSTED hint) ---
  NOTE: the receipt is an untrusted convenience. The authoritative verdict is the
  MATCH/MISMATCH above (recomputed root vs the on-chain record). This diff only localizes
  WHICH file diverged; it cannot make content valid or invalid on its own.
```

If you pass `--receipt` for a **file** target (not a directory), the manifest diff is simply ignored with
a note — there are no per-file leaves to localize.

---

## Worked example

### A. Resumable claim (claim receipt)

```
$ vh commit ./src --uri ipfs://bafy...   # step 1
commit: committing ./src (file) as 0x7099...79C8...
  commit tx: 0x...
  receipt written: /work/0c271a48a26d075d.vhclaim.json
  KEEP THIS PRIVATE — it holds the secret salt. Resume with: vh reveal --receipt /work/0c271a48a26d075d.vhclaim.json
```

The `receipt written:` line names the **exact absolute path** so you can see, relocate, or delete the
secret-bearing file. Choose where it goes with `--receipt <path>` or `--receipt-dir <dir>`.

The receipt on disk (a real v1 claim receipt; v2 adds an optional `manifest` for a directory target):

```json
{
  "kind": "verifyhash.claim-receipt",
  "schemaVersion": 1,
  "contentHash": "0x0c271a48a26d075dabf24d6d9474fe3dde105ed15d05638972142c1c5a2a02b5",
  "committer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "salt": "0x59b7ae3c7fba3c5420517d1897b82bbd17d6d568aa303ebf3dbd5347cf6df1b6",
  "commitment": "0x0cf4ffdbdc94d8fab10bceb57af65c02c9daa109cc080c54d49ca7481271dd43",
  "contractAddress": "0xD0141E899a65C95a556fE2B27e5982A6DE7fDD7A",
  "chainId": 31337,
  "uri": "ipfs://cid-alice",
  "path": "/work/src",
  "targetKind": "file",
  "commitTxHash": "0x7470198b01e39a7e11270e826f6305cd15fc1ee34f6d28ee11d80c1f38e50831",
  "commitBlockNumber": 649,
  "minRevealDelay": 1
}
```

Later — even after a reboot, from a fresh process:

```
$ vh reveal --receipt ./0c271a48a26d075d.vhclaim.json   # step 2
reveal: revealing 0x0c271a48...02b5 as 0x7099...79C8...
  Claimed (authorBound) at index 3 by 0x7099...79C8 in tx 0x...
```

### B. Localized directory verify (anchor receipt + manifest)

After `vh anchor ./repo --receipt ./repo.vhclaim.json`, the receipt records the manifest. If `src/b.js`
is later edited and `src/new.js` is added, `vh verify ./repo --receipt ./repo.vhclaim.json` prints:

```
MISMATCH: recomputed root is NOT the anchored record.
  ...
  --- receipt manifest diff (UNTRUSTED hint) ---
  NOTE: the receipt is an untrusted convenience. The authoritative verdict is the
  MATCH/MISMATCH above (recomputed root vs the on-chain record). This diff only localizes
  WHICH file diverged; it cannot make content valid or invalid on its own.
  files: 1 CHANGED, 1 ADDED, 0 REMOVED (1 unchanged)
    CHANGED  src/b.js
               old: 0x0202...0202
               new: 0x0909...0909
    ADDED    src/new.js  (0x0303...0303)   present now, not in the receipt
```

The `MISMATCH` is decided by the recomputed root vs the on-chain record; the diff only tells you it was
`src/b.js` (and the new file) that moved the root.

---

## Tests

- `test/cli.receipt.test.js` round-trips both receipt kinds, proves strict validation (rejects wrong
  version/kind, missing/malformed fields, a v1 receipt smuggling a v2 manifest), and exercises
  `diffManifest`'s ADDED/REMOVED/CHANGED localization.
- `test/cli.claim.test.js` covers the `commit`/`reveal` split end-to-end against a live node, including a
  resume-from-a-fresh-process path and the front-run-resistance proof.
- `test/cli.verify.test.js` covers `vh verify <dir> --receipt` localization and the `receiptHashMismatch`
  caveat.
- `test/cli.receipt.docs.test.js` is a docs-rot guard: it asserts this file and the README keep the
  schema, the resume lifecycle, and the untrusted/localizes-not-decides caveats in sync with the code.

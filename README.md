# verifyhash

A tamper-evident, permissionless, immutable on-chain registry of code-contribution hashes
(Polygon-targeted). Anchor the hash of a file or an entire repository on-chain; anyone can later
prove that some content is byte-for-byte what was anchored — without trusting any server, any
admin, or any private key to read.

The registry contract (`contracts/ContributionRegistry.sol`) is deliberately ownerless: no admin,
no pause, no upgrade path, and it never holds funds. Each content hash can be anchored exactly once
(first-writer-wins) and can never be altered or deleted. That immutability is the product.

## What it proves (and what it does NOT)

> **Read this before relying on a record:** [`docs/TRUST-BOUNDARIES.md`](docs/TRUST-BOUNDARIES.md)

A record attests to **one** thing: the exact 32-byte `contentHash` you queried was anchored
on-chain, by some address, in some block, and has not changed since. The other fields are weaker
than they look:

- **`uri` is an untrusted hint.** The contract never fetches, validates, or hashes it. To trust a
  record you must independently fetch the content, **re-derive its hash** (`vh hash`), and check that
  the recomputed hash equals the anchored `contentHash`. The `uri` proves nothing on its own.
- **`timestamp` / `blockNumber` prove on-chain ordering and an upper bound on existence time**
  ("this content existed no later than this block") — **not** authorship time and not who authored
  it. `block.timestamp` is set by the block proposer (validator-influenced), so it is not a precise
  wall clock; prefer `blockNumber` for hard ordering.
- **`contributor` has two strengths, told apart by the `authorBound` flag** (decision D-1 /
  task T-0.3). A one-shot `anchor()` is **front-runnable** — `contributor` is only the "first
  anchorer", not a proven author (`authorBound = false`). The **commit-reveal** path (`vh claim`)
  binds the claimant to the content before the hash is public, so a mempool copier cannot steal
  attribution; those records have `authorBound = true` and `contributor` is the proven first
  *claimant*.

Full detail, including the table of "trust it for / do NOT trust it for", is in
[`docs/TRUST-BOUNDARIES.md`](docs/TRUST-BOUNDARIES.md). The exact directory-root construction is in
[`docs/MERKLE-LEAVES.md`](docs/MERKLE-LEAVES.md).

## CLI (`cli/vh.js`)

```
vh hash   <path> [--git [--ref r]]   # keccak256 of a file, or the Merkle root of a directory
vh anchor <path> [--uri u] [--git]   # one-shot anchor (FRONT-RUNNABLE: contributor = first anchorer only)
vh claim  <path> [--uri u] [--git]   # commit-reveal in one shot: front-running-resistant claim (authorBound)
vh commit <path> [--receipt p]       # commit-reveal step 1: commit + persist a resumable claim receipt
vh reveal --receipt <p>              # commit-reveal step 2: resume from the receipt and reveal
vh verify <path> [--git [--ref r]]   # recompute the hash, look it up on-chain, report MATCH / MISMATCH
vh prove  <file> --root dir          # generate + on-chain-verify a per-file Merkle proof
vh list   [filters]                  # read-only: enumerate the registry (discovery + audit, NO key)
vh show   <0xhash>                   # read-only: look up ONE record by hash, no local content (NO key)
```

> **`--git` scopes a directory to exactly what git tracks.** `vh hash/anchor/claim/verify <dir> --git
> [--ref <ref>]` hashes **EXACTLY the files git tracks at that commit** (`--ref` defaults to `HEAD`),
> reading their bytes from the work tree. It deliberately **never** includes `.git/` internals,
> untracked files, secrets like `.env`, `node_modules/`, or build output — so the git-scoped root is
> **reproducible from a fresh clone of the same commit** and is not perturbed by whatever junk happens
> to sit in your working tree. See [git-scoped, reproducible anchoring](#git-scoped-reproducible-anchoring).

`vh anchor` is a single cheap transaction but its `contentHash` is public in the mempool, so anyone
can copy and anchor it first — use it only for existence/timestamp proofs where attribution does not
matter. `vh claim` runs the two-step commit-reveal flow (`commit` a sender-bound, salt-blinded
commitment, wait `MIN_REVEAL_DELAY` blocks, then `reveal`) so a front-runner cannot become the
recorded contributor. See `docs/TRUST-BOUNDARIES.md` for the threat model and why it holds.

### Resumable claims (`vh commit` + `vh reveal`)

The commit-reveal flow spans two transactions separated by a maturation window of `MIN_REVEAL_DELAY`
blocks (minutes on a live testnet). The secret salt that binds your commitment exists only in memory
during that wait — if the one-shot `vh claim` process crashes or is interrupted, the salt is lost and
the claim is **permanently unrevealable by anyone** (reveal requires that exact salt). To make a claim
durable and crash-recoverable, split it:

```
vh commit ./src --uri ipfs://cid      # sends commit(), writes ./<hashPrefix>.vhclaim.json, then exits
# ...wait out MIN_REVEAL_DELAY (a few blocks)...
vh reveal --receipt ./<hashPrefix>.vhclaim.json   # resumes from the receipt and reveals
```

`vh commit` persists a versioned JSON **claim receipt** (salt, commitment, contentHash, committer,
contract, chainId, commit tx/block, `MIN_REVEAL_DELAY`) to `--receipt <path>` (default
`./<contentHashPrefix>.vhclaim.json`) **before it returns**, so a separate `vh reveal` invocation — even
after a reboot — can finish the claim. If you reveal before the window matures the contract reverts with
`RevealTooSoon` and the receipt is left intact, so you can simply retry. The receipt is an *untrusted
local convenience*: the authoritative attribution is always the on-chain record (see
`docs/TRUST-BOUNDARIES.md`). `vh claim` remains the one-shot convenience and now also drops a receipt at
commit time, so even it is crash-recoverable.

> Keep the receipt private until you reveal: it contains the secret salt. After a successful reveal the
> commitment is single-use and spent, so the receipt is no longer sensitive.

The full receipt JSON schema (every field, which are trusted vs untrusted hints), the commit→reveal
resume lifecycle, and the directory-manifest diff semantics are specified in
[`docs/RECEIPTS.md`](docs/RECEIPTS.md).

### Discovery & audit (`vh list` + `vh show`)

`vh verify` answers "is THIS content anchored?"; the read side answers "WHAT is in the registry?".
Both are **read-only and need no key** — they take an RPC provider only and never construct a signer,
because enumerating or reading a public, immutable registry must never require the ability to write
to it.

```
vh list                              # every record, in insertion order
vh list --contributor 0xABC… --json  # filter by address; machine-readable JSON
vh list --author-bound --limit 20    # only commit-reveal records; page with --limit/--offset
vh show 0x<64-hex>                    # one record by content hash — no files on disk needed
```

`vh list` pages through the registry and prints one block per record (contentHash, contributor,
attribution strength, timestamp, blockNumber, uri), filterable by `--contributor` / `--author-bound`
and sliceable with `--limit` / `--offset` (or `--json` for tooling). `vh show <0xhash>` looks up a
single record by a hash you already have (copied from `vh list`, a receipt, or a PR) and exits
non-zero with `NOT ANCHORED` when there is no such record.

> **Listing or showing a record does NOT validate its content.** Both commands only read what is
> on-chain — they never touch your files, so a hit binds nothing to real bytes you hold. `uri` stays
> an **untrusted hint** the contract never fetched or validated, and `contributor` only means proven
> authorship when `authorBound` is `true` (commit-reveal); otherwise it is merely the first anchorer.
> To bind a record to actual content you must still independently fetch it, **re-derive its hash**,
> and run `vh verify <path>` (re-derive-and-compare). These are exactly the caveats in
> [`docs/TRUST-BOUNDARIES.md`](docs/TRUST-BOUNDARIES.md), which the read commands lead their output
> with verbatim.

`vh verify` is read-only: it re-derives the content hash and compares it to what is anchored, which
is exactly the integrity check the trust model requires. It needs only an RPC URL — no key, no
funds.

### Git-scoped, reproducible anchoring

A "code contribution" is a git tree, not whatever files happen to be on disk. By default `vh hash
<dir>` walks the raw filesystem and hashes **every** regular file it finds — including `.git/`
internals, untracked files, `node_modules/`, build artifacts, and secrets like `.env`. That makes a
directory root **non-reproducible** (two clones of the same commit yield different roots because of
local junk) and is a privacy footgun (it silently hashes secrets).

`--git` fixes both. `vh hash/anchor/claim/verify <dir> --git [--ref <ref>]` feeds **EXACTLY the set
of files git tracks at the chosen commit** (`git ls-tree -r`, `--ref` defaults to `HEAD`) through the
*same* path-bound, sorted-leaf Merkle machinery — the leaf formula is unchanged; only the file **set**
differs (see [`docs/MERKLE-LEAVES.md`](docs/MERKLE-LEAVES.md)). Concretely the git-scoped root:

- anchors **exactly the files git tracks at that commit** and nothing else — it **never** includes
  `.git/`, untracked files, `.env`/secrets, `node_modules/`, or build output;
- is **reproducible from a fresh clone**: anyone who checks out the same commit and runs
  `vh verify <dir> --git --ref <commit>` re-derives the identical root and gets `MATCH`, with no
  server, admin, or key to trust (the project's core promise, now true for repos, not just single files);
- still binds each file's **path** into its leaf, so renaming or moving a tracked file changes the root.

```
vh hash   ./repo --git                 # root over the files tracked at HEAD (prints the resolved commit oid)
vh anchor ./repo --git --uri https://… # anchor that reproducible root; records a git provenance hint
vh verify ./repo --git --ref <commit>  # re-derive over the same tracked set and report MATCH / MISMATCH
```

`--git` requires `<dir>` to be inside a git work tree and errors clearly otherwise (it **never**
silently falls back to the raw filesystem walk); `--ref` is only meaningful with `--git`. When you
`anchor`/`claim` with `--git`, the receipt records a `git` block (`{ commit, scope }`) as an
**UNTRUSTED hint** so a reader can reproduce the enumeration — exactly the trust posture of every other
receipt field (see [`docs/RECEIPTS.md`](docs/RECEIPTS.md) and [`docs/TRUST-BOUNDARIES.md`](docs/TRUST-BOUNDARIES.md)).
The authoritative verdict is still the recomputed root vs the on-chain record; the `git.commit` is
never re-checked against the chain.

## Develop

```
npm install
npx hardhat compile
npx hardhat test
```

Local hardhat / in-memory EVM only. Deployment to any real network is a human checkpoint
(see `BACKLOG.md`, EPIC-4); never run automatically.

## Docs

- [`docs/TRUST-BOUNDARIES.md`](docs/TRUST-BOUNDARIES.md) — what each record field proves and does not.
- [`docs/MERKLE-LEAVES.md`](docs/MERKLE-LEAVES.md) — what a directory root commits to (paths + bytes),
  including the `--git` scope note (same leaf formula, reproducible git-tracked file set).
- [`docs/RECEIPTS.md`](docs/RECEIPTS.md) — the receipt JSON schema (trusted vs hints), the
  commit→reveal resume lifecycle, and the directory-manifest diff semantics.
- [`docs/AUDIT.md`](docs/AUDIT.md) — security audit findings and the fix tasks they spawned.

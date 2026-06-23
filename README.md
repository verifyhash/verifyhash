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
vh hash    <path> [--git [--ref r]]  # keccak256 of a file, or the Merkle root of a directory
vh anchor  <path> [--uri u] [--git] [--parent 0xhash] # one-shot anchor (FRONT-RUNNABLE: contributor = first anchorer only); --parent records a lineage edge
vh claim   <path> [--uri u] [--git] [--parent 0xhash] # commit-reveal in one shot: front-running-resistant claim (authorBound); --parent records a lineage edge
vh commit  <path> [--receipt p] [--parent 0xhash] # commit-reveal step 1: commit + persist a resumable claim receipt (records --parent into the receipt, schema v4)
vh reveal  --receipt <p>             # commit-reveal step 2: resume from the receipt and reveal (carries the receipt's --parent edge — no flag needed)
vh verify  <path> [--git [--ref r]]  # recompute the hash, look it up on-chain, report MATCH / MISMATCH
vh prove   <file> --root dir [--out p] # Merkle-prove a file against an anchored root; --out exports a portable artifact (read-only, no key, no repo needed to verify)
vh verify-proof <p>                  # read-only: independently verify a portable proof artifact (offline fold + on-chain; no key, no repo needed)
vh list    [filters]                 # read-only: enumerate the registry (discovery + audit, NO key)
vh show    <0xhash>                  # read-only: look up ONE record by hash, no local content (NO key)
vh lineage <0xhash> [--max-depth n]  # read-only walk UP the parent chain to the lineage root (no key)
```

> Every read command (`verify` / `show` / `list` / `lineage` / `verify-proof`) **authenticates the
> registry before reporting anything** and prints a `registry authenticated: …` line (`--json`: a
> `registry` block). A loud, non-default `--skip-identity-check` opts out for a known local-dev
> contract. See [authenticated reads](#authenticated-reads-registry-identity--chainid).

> **`--parent <0xhash>` records a contribution lineage edge.** `vh anchor/claim <path> --parent
> <hash>` anchors the record AS a revision of an ALREADY-anchored predecessor (the parent must already
> exist on-chain or the tx reverts `UnknownParent`); omit it for a lineage root. A `parent` edge is the
> **child author's CLAIM** of a predecessor — it neither proves genuine content ancestry (re-derive
> **both** contents) nor transfers the parent's authorship. `vh lineage <0xhash>` is the **read-only
> walk, no key**: it follows the parent chain from a record UP to its lineage root. See
> [contribution lineage](#contribution-lineage-vh-anchorclaim---parent--vh-lineage).

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
vh commit ./src --uri ipfs://cid      # sends commit(), writes the receipt, prints its EXACT path, then exits
# ...wait out MIN_REVEAL_DELAY (a few blocks)...
vh reveal --receipt <that exact path>   # resumes from the receipt and reveals
```

`vh commit` persists a versioned JSON **claim receipt** (salt, commitment, contentHash, committer,
contract, chainId, commit tx/block, `MIN_REVEAL_DELAY`) **before it returns**, so a separate `vh reveal`
invocation — even after a reboot — can finish the claim.

**The receipt holds the SECRET `salt`** that binds your commitment. Where it is written is always
something you opt into, and `vh commit` **never writes it silently**:

- `--receipt <path>` writes it to that exact file;
- `--receipt-dir <dir>` writes it into that directory under a tidy default file name;
- with neither, `vh commit` defaults to `<cwd>/<contentHashPrefix>.vhclaim.json` — **but the success
  output always names the EXACT file written** (`receipt written: <abs path>`), so you can see, move, or
  delete it. It is never dropped where you can't find it. (`*.vhclaim.json` is also git-ignored.)

**Keep it private until you reveal** — anyone who holds the salt before reveal could front-run the open;
after a successful reveal the commitment is single-use and spent, so the receipt is no longer sensitive.
This reuses the receipt trust posture in [`docs/TRUST-BOUNDARIES.md`](docs/TRUST-BOUNDARIES.md): the
receipt is an *untrusted local convenience*; the authoritative attribution is always the on-chain record.

If you reveal before the window matures the contract reverts with `RevealTooSoon` and the receipt is left
intact, so you can simply retry. **`vh claim`** remains the one-shot convenience (commit + reveal in one
process); to keep it safe it persists a receipt **only if you ask** (`--receipt`/`--receipt-dir`) — by
default it writes nothing and you use `vh commit` for a durable, resumable claim.

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

> **`vh list --json` is an ENVELOPE, not a bare array** (changed in T-11.2). The output is
> `{ "registry": { "id", "version", "chainId" }, "records": [ … ] }` — the `registry` block proves the
> records were read from an [authenticated registry](#authenticated-reads-registry-identity--chainid)
> (or carries `{ "skipped": true, "note": … }` when `--skip-identity-check` was used), and `records` is
> the array a consumer iterates. **This is a breaking change for any consumer that previously did
> `JSON.parse(out)[0]`** — iterate `JSON.parse(out).records` instead. (`vh show` / `vh lineage` /
> `vh verify-proof` each likewise carry a top-level `registry` block.)

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

### Authenticated reads (registry identity + chainId)

The project's core promise is to prove things **without trusting any server**. But the `(rpc, address)`
pair a reader uses is itself untrusted — it comes from a prover, a receipt's `contractAddress`, a
README, or a forwarded event. A *rogue or wrong* contract that implements the same ABI shape could
return `isAnchored = true` / fabricated records and make the CLI print `MATCH` / `ACCEPTED`. So before
believing any record, **every read command authenticates the registry first** (T-11.2):

- `vh verify`, `vh show`, `vh list`, `vh lineage`, and `vh verify-proof` run a shared preflight
  (`cli/registry.js › assertRegistry`) that (a) confirms a contract is actually deployed at the address
  (`getCode`), (b) reads the contract's immutable `REGISTRY_ID()` / `REGISTRY_VERSION()` self-identity
  marker and refuses to trust a contract that is not a genuine verifyhash registry, and (c) — for
  `vh verify-proof`, whose artifact records the `chainId` it was anchored on — cross-checks the
  provider's chainId so a verdict is never reported against the wrong network.
- The human output gains a one-line confirmation so you can **see** the check ran:
  `registry authenticated: REGISTRY_ID ok (vN), chainId N` — printed **before** any verdict/record.
- `--json` carries a machine-readable `registry: { id, version, chainId }` block on every read command.
- A genuine RPC/network error is surfaced **as itself** — it is never masqueraded as an identity
  failure (mirroring the `isNotAnchoredError` discipline `vh verify` already uses).

```
vh verify ./repo --git                          # prints "registry authenticated: …" then MATCH/MISMATCH
vh show 0x<hash> --json                          # → { "registry": { id, version, chainId }, … }
vh verify-proof proof.json --rpc <url>           # rejects if the provider's chainId != the artifact's
```

> **Opt-out (`--skip-identity-check`) is loud and never the default.** If you KNOW you are pointed at a
> not-yet-deployed / local-dev contract, every read command accepts `--skip-identity-check` to bypass
> the preflight. When you use it the output says so unmistakably — human:
> `registry authentication: SKIPPED (--skip-identity-check) … the verdict is only as trustworthy as the
> RPC/address you supplied`; `--json`: `registry: { "skipped": true, "note": … }`. Without the flag,
> **every read command authenticates**.

### Contribution lineage (`vh anchor/claim --parent` + `vh lineage`)

A contribution evolves — v2 fixes v1, a fork derives from an upstream, a patch builds on a base. Each
record may optionally name **one already-anchored predecessor**, turning the registry from a pile of
unrelated hashes into a contribution **history you can walk and audit**.

```
vh anchor ./repo-v2 --parent 0xROOT…   # anchor v2 AS a revision of the already-anchored root 0xROOT…
vh claim  ./repo-v2 --parent 0xROOT…   # same, via commit-reveal (the revision is authorBound)
vh lineage 0xCHILD… --rpc <url>        # read-only walk UP the parent chain: child -> parent -> … -> root
```

`--parent <0xhash>` records an **immutable predecessor edge** to a hash that **must already be
anchored** (the contract reverts `UnknownParent` otherwise, and `SelfParent` if a record names itself);
omit it for a **lineage root**. Because a parent must pre-exist, the graph is **acyclic by
construction** and the on-chain check is O(1) — no on-chain walk. `--parent` works on the one-shot
`vh anchor`/`vh claim` **and** on the resumable `vh commit`/`vh reveal` split: `vh commit --parent
<hash>` persists the edge into the claim receipt (schema **v4**) and a later, separate `vh reveal
--receipt <p>` reads it back and records it — no `--parent` flag on `vh reveal`. The parent is checked
on-chain at **reveal** time, so a stale/unanchored parent reverts the *reveal* (not the commit) and
leaves the receipt reusable for a retry. Naming a parent does not change the child's own attribution
(lineage and `authorBound` are orthogonal).

`vh lineage <0xhash>` is **read-only and needs no key** — it takes a provider only, never a signer —
and follows `record.parent` from a record UP to its lineage root, printing each ancestor in child→root
order (`contentHash`, `contributor`, attribution strength, timestamp, blockNumber, uri, parent). The
walk is **off-chain** and bounded by `--max-depth` (default 256, so a pathological chain can't hang the
client); `--json` emits an ordered ancestor array an indexer/UI can reconstruct the graph from, and a
`NOT ANCHORED` start exits non-zero. `vh show <0xhash>` also surfaces a record's `parent` (or
`(none) — lineage root`).

> **A `parent` edge is the child author's CLAIM — not proof of ancestry, not a transfer of authorship.**
> It proves only that the named predecessor was anchored *before* this child and that the child's author
> chose to point at it. It does **NOT** prove the predecessor's content is a genuine ancestor of the
> child's content — re-derive **both** contents (`vh hash`) and judge the relationship yourself — and it
> does **NOT** transfer the parent's authorship: each record's `contributor`/`authorBound` stands alone.
> An indexer reconstructs the graph from the `Linked(child, parent)` event (emitted only for non-root
> records, alongside the unchanged `Anchored`/`Revealed`). These are exactly the caveats in
> [`docs/TRUST-BOUNDARIES.md`](docs/TRUST-BOUNDARIES.md); the full graph spec, the log shape, and a
> worked anchor-root → anchor-revision → walk-lineage example are in [`docs/LINEAGE.md`](docs/LINEAGE.md).

### Portable proofs (`vh prove --out` + `vh verify-proof`)

`vh prove <file> --root <dir>` builds a Merkle proof that a single file is part of an anchored repo
root, but on its own that proof only lives in the prover's terminal. `--out <p>` exports it as a
**self-contained, portable proof artifact** — a versioned JSON file carrying everything a verifier
needs:

```
vh prove src/index.js --root ./repo --out proof.json   # build + export (no key; works with --dry-run)
vh verify-proof proof.json --rpc <url>                 # independently verify, needing ONLY the file + an RPC URL
```

`vh verify-proof <p>` is **read-only and needs no key, no repo, and no working tree** — just the
artifact and an RPC URL. That is the portability property: hand someone the artifact and they can
**independently** confirm the file is in the anchored root with **no trust in the prover**. It:

1. **Re-derives the leaf** from the artifact's `contentHash` + `relPath` and **re-folds** the `proof`
   **purely offline**, using the same sorted-pair / domain-separated convention the contract's
   `verifyLeaf` uses (the leaf must equal `pathLeaf(contentHash, relPath)`, then the fold must reach
   `root`). The artifact is an **untrusted transport container** — verify-proof never trusts its
   claims; it re-computes them.
2. Makes **one read-only on-chain check** that the root is actually anchored (`isAnchored`) and that
   the contract's own `verifyLeaf` accepts the proof.

It prints `ACCEPTED` **only** when the offline fold **and** both on-chain checks pass. A tampered
`proof`/`leaf`/`contentHash` is caught (offline, no network even needed) and `REJECTED`; an artifact
whose `root` was never anchored reports `NOT ANCHORED` (a distinct, non-zero exit) rather than a false
accept. The artifact records its `contractAddress`/`chainId` when built on the on-chain path, so
verify-proof can run with no `--contract` flag; an explicit `--contract`/`--rpc` always overrides.

Before the on-chain leg runs, verify-proof [authenticates the
registry](#authenticated-reads-registry-identity--chainid) AND cross-checks the artifact's recorded
`chainId` against the provider's chainId — so it **hard-errors** rather than report a verdict against
the wrong network (the portability promise made trustworthy: the consumer no longer trusts the prover's
RPC blindly). `--json` therefore carries a `registry: { id, version, chainId }` block alongside
`offline.*` / `onChain.*` / `accepted` / `status` / `trustNote`.

> **This proves SET-MEMBERSHIP in a root — not authorship, not the `uri`.** An `ACCEPTED` verdict
> binds the file's path + bytes to an anchored Merkle root. It says nothing about who anchored that
> root or what `contributor`/`uri` mean — exactly the boundary the contract's `verifyLeaf` draws.
> `vh verify-proof` leads its output with this caveat verbatim. See
> [`docs/TRUST-BOUNDARIES.md`](docs/TRUST-BOUNDARIES.md).

The artifact schema is `{ kind, schemaVersion, root, leaf, contentHash, relPath, proof, contractAddress?, chainId? }`,
strictly validated on read (a malformed/short hash or a non-hex proof hard-errors), reusing the same
validation style as the receipt schema in [`docs/RECEIPTS.md`](docs/RECEIPTS.md). The full proof-artifact
spec — every field (all UNTRUSTED transport, verification re-derives), the offline-fold + on-chain-check
steps, and a worked prove → hand over → verify-proof example — is in [`docs/PROOFS.md`](docs/PROOFS.md).

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
- [`docs/PROOFS.md`](docs/PROOFS.md) — the portable proof-artifact schema (every field UNTRUSTED
  transport), the offline-fold + on-chain-check verification steps, and a worked
  prove → hand over → `vh verify-proof` example (read-only, no key, no repo needed).
- [`docs/RECEIPTS.md`](docs/RECEIPTS.md) — the receipt JSON schema (trusted vs hints), the
  commit→reveal resume lifecycle, and the directory-manifest diff semantics.
- [`docs/LINEAGE.md`](docs/LINEAGE.md) — the contribution lineage graph: the immutable `parent` edge
  (acyclic-by-construction, O(1), a CLAIM that proves no ancestry/authorship), the `Linked` log an
  indexer reconstructs the graph from, the `--parent` write flow, and the `vh lineage`/`vh show` read
  flow with a worked anchor-root → anchor-revision → walk-lineage example.
- [`docs/AUDIT.md`](docs/AUDIT.md) — security audit findings and the fix tasks they spawned.

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
vh hash   <path>                 # keccak256 of a file, or the Merkle root of a directory
vh anchor <path> [--uri u]       # one-shot anchor (FRONT-RUNNABLE: contributor = first anchorer only)
vh claim  <path> [--uri u]       # commit-reveal in one shot: front-running-resistant claim (authorBound)
vh commit <path> [--receipt p]   # commit-reveal step 1: commit + persist a resumable claim receipt
vh reveal --receipt <p>          # commit-reveal step 2: resume from the receipt and reveal
vh verify <path>                 # recompute the hash, look it up on-chain, report MATCH / MISMATCH
vh prove  <file> --root dir      # generate + on-chain-verify a per-file Merkle proof
```

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

`vh verify` is read-only: it re-derives the content hash and compares it to what is anchored, which
is exactly the integrity check the trust model requires. It needs only an RPC URL — no key, no
funds.

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
- [`docs/MERKLE-LEAVES.md`](docs/MERKLE-LEAVES.md) — what a directory root commits to (paths + bytes).
- [`docs/AUDIT.md`](docs/AUDIT.md) — security audit findings and the fix tasks they spawned.

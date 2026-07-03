# verifyhash contribution score — what it is, what it does and does NOT prove

This is the canonical spec for the **contribution score** surfaced by `vh reputation <addr>` (task
**T-12.2**) over the bounded per-contributor on-chain index (task **T-12.1**). It is **pure
documentation** of behaviour that already ships; no new runtime behaviour is introduced here.

The single sentence to keep in mind before everything below:

> **The score is a NON-TRANSFERABLE DERIVED VIEW over records that already exist on-chain. It is
> re-derivable by anyone from the same registry. It is NOT a token, holds no value, grants no rights,
> and is only as meaningful as the `authorBound` bar.**

It exists to answer one question — *"who are the real contributors, and how much have they verifiably
contributed?"* — without inventing any new on-chain object. It groups the registry's existing,
immutable records by address and counts them, separating the strong signal (commit-reveal,
front-running-resistant claims) from the weak one (front-runnable plain anchors).

> **Read [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md) first.** Every caveat here is the same
> caveat the record fields already carry; this doc reuses that wording verbatim so the boundaries stay
> consistent. If the two ever drift, TRUST-BOUNDARIES (and the contract NatSpec it mirrors) is
> authoritative.

---

## EXACT definition — which on-chain read it aggregates

The score is computed entirely off-chain from **a single ownerless `view` read** on
`contracts/ContributionRegistry.sol` (the T-12.1 per-contributor index): the paged
`getRecordsByContributor` walk. It reads **nothing else** and re-derives everything — there is no
stored "score" on-chain.

| Read | What it returns | Used for |
|------|-----------------|----------|
| `getRecordsByContributor(addr, start, count)` | a clamped, forgiving page of `{ contentHash, Record }` for `addr`'s own records, in insertion order | **the only read the command issues** — `total` and every breakdown below are derived from the records this walk returns |
| `contributorRecordCount(addr)` | how many records carry `addr` (0 for an unknown address) | **companion read, NOT issued by `vh reputation`.** The T-12.1 O(1) count an external consumer can call to get the same `total` *without* paging; it equals the CLI's `total` because both count the same records |

`getRecordsByContributor` is paged in fixed-size chunks (`cli/reputation.js` walks pages of
`DEFAULT_PAGE = 100`, stopping on a **short/empty page** — that short-page stop, not any count read, is
the page-walk's bound). Because the contract clamps an out-of-range window to empty (it **never** reverts
on a tail), enumerating one address is **O(that address's own records), never O(total)** — that is the
whole point of the T-12.1 index.

So `vh reputation` makes exactly **one read shape** (`getRecordsByContributor`), not two.
`contributorRecordCount` is the matching O(1) count an indexer/UI may call independently; the command
itself never calls it (`computeScore` sets `total = records.length` from the walked page set).

From that page-walk, `computeScore` (pure, no I/O, fully re-derivable from the same input) produces:

- **`total`** — `records.length` from the page-walk: the number of records the walk returned for the
  address (which equals what `contributorRecordCount` would return, since both count the same records).
- **the attribution breakdown — reported SEPARATELY, never summed into one number:**
  - **`authorBound`** — records with `record.authorBound == true`: written via the commit-reveal path
    (`vh claim` / `vh commit`+`vh reveal`). The **proven first claimant** — front-running-resistant.
  - **`anchorOnly`** — records with `record.authorBound == false`: written via the one-shot `anchor()`
    path (`vh anchor`). The **first anchorer only — NOT authorship** (see anti-sybil below).
- **the lineage breakdown** (orthogonal to attribution; uses `record.parent`):
  - **`lineageRoots`** — records whose `parent == bytes32(0)` (a lineage root; `cli/show.js › isRoot`).
  - **`revisions`** — records whose `parent != bytes32(0)` (a **CLAIMED** predecessor edge — see
    `parent` in TRUST-BOUNDARIES; it is a claim, not proof of ancestry).
- **the block/time bounds** — the **earliest** and **latest** `{ blockNumber, timestamp }` seen across
  the address's records. These are the same `block.number` / `block.timestamp` the records carry, with
  the same meaning: on-chain ordering + an **UPPER BOUND on existence time**, never authorship time,
  and `timestamp` is validator-influenced (prefer `blockNumber` for hard ordering).

The attribution counts are kept SEPARATE on purpose. `authorBound` and `anchorOnly` are **never**
collapsed into a single opaque number that would hide the difference between a front-running-resistant
claim and a cheap first-anchor.

---

## It is a NON-TRANSFERABLE DERIVED VIEW — NOT a token

The score is a **read**, not an asset:

- **Re-derivable by anyone.** Hand someone the same `(rpc, address)` and they recompute the identical
  numbers. There is no privileged issuer, no per-address balance stored on-chain, nothing to mint, hold,
  or move. `vh reputation` takes a **provider only — never a signer, never a key.**
- **Non-transferable.** There is nothing to transfer. The "score" is just `count`s over immutable
  records; it cannot be sent, sold, or assigned. It confers no rights and holds no value.
- **NOT a token, NOT a security.** Issuing a transferable/tradeable reputation **token** on top of this
  view is a **separate, human-gated decision** — proposal **D-2 / P-1** in
  [`STRATEGY.md`](../STRATEGY.md), tagged `needs-human`, and **NOT built here**. This document and the
  `vh reputation` command stay strictly on the non-transferable derived-view side of that line.

---

## What the score does NOT prove

The score inherits every limit of the records it counts. It adds **no** trust beyond them.

1. **It does NOT validate record CONTENT.** "This address has N records" says nothing about whether
   those records correspond to real, untampered bytes. A record only ever attested to a `contentHash`;
   the `uri` is an **UNTRUSTED hint** the contract never fetched or validated. To bind any record to
   actual content you must independently obtain it, **re-derive its hash** (`vh hash`), and run
   `vh verify <path>` (re-derive-and-compare). The score never does this and never claims to.
2. **It does NOT upgrade a front-runnable anchor's attribution.** Grouping records by `contributor` is
   a **RAW ENUMERATION, NOT AN ENDORSEMENT** (the contract's own NatSpec on
   `getRecordsByContributor` / `contributorRecordCount`). A record written via the front-runnable
   `anchor()` is counted under its writer's address while staying `authorBound == false` — still only
   "first anchorer", never proven authorship. Counting it does not make it stronger.
3. **For anchor-only records, the grouping address is merely "first anchorer".** When
   `authorBound == false`, `contributor` is whoever broadcast the `anchor()` transaction first — anyone
   who learned a `contentHash` (e.g. from the public mempool) could have anchored it. So the address an
   anchor-only record is grouped under is **not** a proven author; it is the first broadcaster. Only the
   `authorBound` count groups under a **proven first claimant**.

---

## Anti-sybil: the meaningful signal is the `authorBound` count

Addresses are free to create and one-shot `anchor()` calls are cheap, so any metric that treats every
record equally is trivially **sybil-inflatable** — a single actor can spin up many addresses and anchor
many hashes (including hashes copied from someone else's mempool) at near-zero cost. None of that
proves authorship of anything.

The defense is **not** a gate or a stake; it is **reading the breakdown correctly**:

> **The meaningful signal is the `authorBound` (commit-reveal) count.** Producing a
> front-running-resistant claim has a real, irreducible cost: you must `commit` a sender-bound,
> salt-blinded commitment, wait out the `MIN_REVEAL_DELAY` maturation window, and then `reveal` — and
> only the original committer can ever reveal it (a copier who lifts the revealed values recomputes a
> commitment they never registered and reverts). That is the only count that reflects a proven,
> front-running-resistant claim of authorship.

By contrast, the `anchorOnly` count and the raw `total` are **cheap to inflate** (free address creation
+ front-runnable single-tx anchors) and prove only order-of-anchoring. That is exactly why
`vh reputation` reports `authorBound` and `anchorOnly` **separately and never sums them**: a consumer
who wants a sybil-resistant reading should weight (or restrict to) `authorBound`, and treat `anchorOnly`
/ `total` as the weak, inflatable figures they are. The score makes the distinction visible; it does not
make the weak signal strong.

---

## One-line summary

| Field | What it is | Do NOT read it as |
|-------|-----------|-------------------|
| `total` | how many records carry this address | a sybil-resistant measure (cheap to inflate) |
| `authorBound` | proven first-claimant (commit-reveal) records — the **meaningful, costly** signal | content validation (re-derive + `vh verify`) |
| `anchorOnly` | first-anchorer-only records — front-runnable, **weak**, cheap to inflate | proven authorship |
| `lineageRoots` / `revisions` | `parent == 0x0` vs a CLAIMED predecessor edge | proof of genuine content ancestry |
| `earliest` / `latest` block+ts | on-chain ordering + upper bound on existence time | authorship time; a precise wall clock |
| the whole score | a non-transferable, re-derivable DERIVED VIEW | a token, an asset, an endorsement, or content validation |

## Tests

`test/cli.reputation.docs.test.js` is a docs-rot guard (pure: no chain, no fixtures). It asserts that
this file and README.md keep documenting the score the way `cli/reputation.js` actually behaves — that
the single read it aggregates is the paged `getRecordsByContributor` walk (with `contributorRecordCount`
named as the companion O(1) count, not a read the command issues), the authorBound vs
anchor-only and root vs revision breakdowns, that it is a non-transferable derived view (NOT a token;
any tradeable layer is D-2/P-1), what it does NOT prove, and the anti-sybil note that the meaningful
signal is the `authorBound` count — pinned to the caveats `cli/reputation.js` / `cli/list.js` export so
the prose can't silently drift from the implementation.


---
<sub>© 2026 verifyhash.com · Licensed under Apache-2.0 (SPDX-License-Identifier: Apache-2.0) — see the [LICENSE](https://verifyhash.com/LICENSE) and [NOTICE](https://verifyhash.com/NOTICE) served with this file.</sub>

# verifyhash contribution lineage — the `parent` edge, the graph, and how to walk it

This is the canonical spec for the **contribution lineage graph**: the optional, immutable `parent`
edge every record may carry (task **T-10.1**), how a record names a predecessor (`vh anchor/claim
--parent`), and how anyone reads the graph back (`vh lineage` / `vh show`, task **T-10.2**). It is
pure documentation of behaviour that already ships; no new runtime behaviour is introduced here.

A contribution is not a flat island — v2 fixes v1, a fork derives from an upstream, a patch builds on
a base. Before lineage, the registry could not express the single most basic relationship a
contribution has: "this came after / revises / builds on that." The `parent` edge turns the registry
from a pile of unrelated hashes into a contribution **history you can walk and audit**.

> **Trust posture (read this first).** A `parent` edge is the **child author's CLAIM** of a
> predecessor, in exactly the spirit of [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md). It does
> **NOT** prove the predecessor's content is a genuine ancestor of the child's content (re-derive
> **both** contents yourself and reason about the relationship), and it does **NOT** transfer the
> parent's authorship to the child — each record's `contributor`/`authorBound` stands on its own.
> See [What a `parent` edge does and does NOT prove](#what-a-parent-edge-does-and-does-not-prove)
> below; that section reuses the TRUST-BOUNDARIES wording verbatim so the caveats stay consistent.

---

## The on-chain `parent` edge

Every `Record` carries one optional, immutable `parent` field (`contracts/ContributionRegistry.sol`):

```solidity
struct Record {
    address contributor;  // who is recorded — meaning depends on authorBound
    bool    authorBound;  // true => commit-reveal (proven first claimant); false => first anchorer
    uint64  timestamp;    // block.timestamp at anchor time
    uint64  blockNumber;  // block.number at anchor time
    string  uri;          // off-chain pointer hint (UNTRUSTED)
    bytes32 parent;       // OPTIONAL predecessor edge; bytes32(0) == "no predecessor / lineage root"
}
```

The edge has exactly these properties:

- **Optional.** `parent == bytes32(0)` (the 32-byte zero hash) means "no predecessor": this record is
  a **lineage root**. Every legacy `anchor`/`reveal` record is a root by construction (it never names a
  parent).
- **Acyclic by construction (a DAG).** A non-zero `parent` is **REQUIRED to already be anchored** at
  the moment the child is written, else the write reverts. A new record cannot be named as anyone's
  parent until after it is itself written, so an edge can only ever point at an *earlier* (lower-index)
  record — no forward edge and no cycle can form. There is no on-chain cycle check; acyclicity falls
  out of the "parent must pre-exist" rule alone.
- **O(1) per write, no on-chain walk.** The parent check is a single `_records[parent]` existence read
  — **no loop, no walk of the ancestry chain** — so it preserves the contract's hard "no unbounded
  loop / no gas-DoS" invariant. The chain is walked **off-chain** (see [Reading the graph](#reading-the-graph-vh-lineage--vh-show)).
- **Immutable.** Like every other field, once written the `parent` can never change. First-writer-wins
  still applies to the child's own `contentHash`.
- **Self-reference rejected.** `parent == contentHash` reverts `SelfParent(contentHash)` (a self-loop);
  this is a distinct error from naming a not-yet-anchored hash.

### What a `parent` edge does and does NOT prove

This reuses the `parent` clause of the contract-level `TRUST BOUNDARIES` NatSpec and
[`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md) verbatim so the caveats stay consistent:

> `parent` is an OPTIONAL, immutable predecessor edge (bytes32(0) == "no predecessor / root of a
> lineage"). It asserts ONLY that the author of THIS record CLAIMED the named predecessor. It does
> NOT prove the predecessor's content is genuinely an ancestor of this content — consumers must still
> independently re-derive BOTH contents and judge the relationship themselves — and it does NOT
> transfer or imply the predecessor's authorship/attribution to this record (each record's
> `contributor`/`authorBound` stand alone).

Concretely, a `parent` edge **proves**:

- the named predecessor `contentHash` **was anchored on-chain before** this child (acyclic-by-
  construction — the contract enforced it at write time), and
- the child's author **chose to point at it** as a predecessor.

It does **NOT** prove:

- **content ancestry** — that the predecessor's bytes are genuinely an earlier version of, or were
  derived into, the child's bytes. Anyone can name any already-anchored hash as a parent. To reason
  about a real derivation you must independently obtain and **re-derive both** contents (`vh hash`)
  and compare them yourself.
- **authorship transfer** — naming a parent grants the child nothing from it. The parent's
  `contributor`/`authorBound` say nothing about the child's, and vice versa. Attribution is per-record.

> Rule of thumb: **a `parent` edge is a claim of "I built on that", not a proof of "that became this".**

---

## The log shape an indexer reconstructs the graph from

The graph's full edge set is reconstructable **purely from logs**, so an off-chain indexer never needs
to read storage to build it:

```solidity
event Linked(bytes32 indexed child, bytes32 indexed parent);
```

- A `Linked(child, parent)` log is emitted **in addition to** `Anchored`/`Revealed` **iff** the record
  was written with a **non-zero** `parent`.
- A record written with **no** predecessor (`parent == 0x0`, including **every** legacy
  `anchor`/`reveal` call) emits **no** `Linked` log. The **absence** of a `Linked` log for a child is
  exactly "this record is a lineage root."
- `Linked` is a **parallel** event: the legacy `Anchored`/`Revealed` signatures are left byte-for-byte
  unchanged, so pre-lineage indexers keep working without modification.
- **Both** `child` and `parent` are `indexed`, so an indexer can query "all edges **into** a node"
  (filter on the `parent` topic) or "all edges **out of** a node" (filter on the `child` topic)
  directly by topic — and assemble the whole DAG from the union of `Anchored`/`Revealed` (the nodes)
  and `Linked` (the edges).

`Linked` carries the same trust boundary as the `Record.parent` field: it records only that the author
of `child` CLAIMED `parent` as a predecessor; it proves neither content ancestry nor an authorship
transfer.

---

## Writing an edge — `vh anchor/claim --parent <hash>`

A revision is written by pointing a new record at an already-anchored predecessor with `--parent`:

```
vh anchor <path> --parent <0xhash> [--uri u] [--git]   # one-shot revision (FRONT-RUNNABLE attribution)
vh claim  <path> --parent <0xhash> [--uri u] [--git]   # commit-reveal revision (authorBound = true)
```

- `--parent <0xhash>` takes a 32-byte (`0x` + 64 hex) content hash that **must already be anchored**.
  Its shape is validated **before any network call** (a malformed/short hash, or a `parent` equal to
  the child's own hash, is a usage error that fails locally); the contract then enforces existence and
  self-reference at write time.
- On `vh anchor`, a non-zero `--parent` routes the write to `anchorWithParent(contentHash, uri,
  parent)` instead of `anchor(...)`. Omitting it (or passing the zero hash) anchors a **lineage root**
  via the legacy `anchor`, emitting **no** `Linked` event.
- On `vh claim`, a non-zero `--parent` routes the **reveal leg** to `revealWithParent(contentHash,
  salt, uri, parent)`; the commit leg is unchanged (the edge is recorded at reveal time). `--parent`
  is supported on the **one-shot `vh claim`** only; the resumable `vh commit`/`vh reveal` split does
  not carry it yet (the receipt schema cannot persist a `parent` — see `BACKLOG` B-10.1 — so
  `vh commit --parent` hard-errors and points you at `vh claim --parent`).
- If the named `parent` was never anchored, the transaction reverts `UnknownParent(parent)`; a
  self-referencing parent reverts `SelfParent(contentHash)`.
- `--dry-run` prints the plan including a `parent:` line (the predecessor hash, or `(none) — lineage
  root`) and which function it routes to (`anchor` vs `anchorWithParent`), so you can preview the exact
  edge you would record before sending anything — no key needed.

The edge does not change the child's own attribution: a `vh anchor --parent` child is still
`authorBound = false` (first anchorer only), and a `vh claim --parent` child is still `authorBound =
true` (proven first claimant). Lineage and attribution are orthogonal.

---

## Reading the graph — `vh lineage` + `vh show`

Reading the graph is **read-only and needs no key**: both commands take an RPC **provider** only and
**never construct a signer** — walking a public, immutable lineage must never require the ability to
write to it.

### `vh lineage <0xhash>` — walk UP the parent chain to the root

```
vh lineage <0xhash> [--contract a] [--rpc u] [--max-depth n] [--json]
```

`vh lineage` follows `record.parent` from **child → parent → … → root**, issuing one bounded
`getRecord` per hop (the contract deliberately never walks an unbounded set on-chain, so the walk is
**off-chain**). It prints each ancestor in order — `contentHash`, `contributor`, attribution strength,
`timestamp` (+ ISO-8601), `blockNumber`, `uri`, and the `parent` edge — and flags the lineage root
(`<- lineage root (no predecessor)`).

- **Order is child → root**, with `depth` 0 at the start and increasing toward the root.
- **Per-record attribution is preserved exactly**: a commit-reveal child reads back
  `authorBound = true` ("proven first claimant"), a plain-anchor ancestor reads back
  `authorBound = false` ("first anchorer only — NOT authorship"). The walk never conflates them — this
  is the same per-record `authorBound` rule from [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md).
- **`--max-depth <n>`** (default **256**) caps the walk. A finite acyclic chain always terminates at a
  root well before the cap; the cap exists only so a pathological/huge chain can't hang the client.
  Reaching the cap prints a clear note naming the next un-walked predecessor and how to resume — it
  never loops forever. (A non-positive/non-integer `--max-depth` is a usage error.)
- **`--json`** emits an **ordered ancestor array** (child → root) carrying the same fields, with a root
  serialized as `parent: null, isRoot: true`. A `NOT ANCHORED` start is a first-class value
  (`anchored: false`, empty `ancestors`), not an error object, so a script can branch on it — while the
  CLI still exits non-zero (exit code **4**, mirroring `vh show`'s NOT ANCHORED exit).
- The human output **always leads with both trust caveats** — the shared record caveat (untrusted
  `uri`; `contributor` only proves authorship when `authorBound` is true) **and** the lineage-specific
  caveat (a `parent` edge is the child author's CLAIM; re-derive both; it transfers no authorship).

### `vh show <0xhash>` — one record, including its `parent`

`vh show` looks up a single record by hash (read-only, no key) and now surfaces its `parent` edge: a
parented record shows the predecessor hash (and suggests `vh show <parent>` to step back one hop); a
root renders `parent: (none) — lineage root (no predecessor)` so a deliberate root is distinguishable
from a missing field. As always, `show` proves only that the hash is on-chain — it does **not**
re-derive content; to bind a record to real bytes you still run `vh verify <path>`.

---

## Worked end-to-end example: anchor a root → anchor a revision → walk the lineage

Suppose `0xROOT…` is the anchored Merkle root of `v1` of a contribution and `0xCHILD…` is `v2`. (All
write commands here also work with `--git` to anchor exactly the files git tracks at a commit — see
[`docs/MERKLE-LEAVES.md`](MERKLE-LEAVES.md).)

**1. Anchor the root (v1) — no `--parent`, so it is a lineage root.**

```
$ vh anchor ./repo --uri ipfs://root-v1
anchored 0xROOT…  (contributor = 0xAlice…, first anchorer only)
```

**2. Anchor the revision (v2) — point it at the root with `--parent`.**

```
$ vh anchor ./repo-v2 --parent 0xROOT… --uri ipfs://child-v2
anchored 0xCHILD…  (parent 0xROOT…)   # routed to anchorWithParent; emits Linked(0xCHILD…, 0xROOT…)
```

If `0xROOT…` had not already been anchored, step 2 would revert `UnknownParent(0xROOT…)`. Passing
`--parent 0xCHILD…` (the child's own hash) would revert `SelfParent`.

**3. Walk the lineage of the child — read-only, no key.**

```
$ vh lineage 0xCHILD… --contract 0x… --rpc <url>
NOTE: `uri` is an UNTRUSTED hint (never fetched/validated — re-fetch + re-hash yourself); `contributor` only means proven authorship when authorBound is true (commit-reveal), otherwise it is merely the first anchorer.

NOTE (lineage): a `parent` edge is the CHILD author's CLAIM of a predecessor. It does NOT prove the predecessor's content is a genuine ancestor of the child's content (re-derive BOTH yourself and reason about the relationship), and it does NOT transfer the parent's authorship to the child. Each record's contributor/authorBound stands on its own.

  start:        0xchild…
  result:       WALKED 2 records (child -> root order)

[0]  0xchild…
      contributor:  0xAlice…
      attribution:  first anchorer only — NOT authorship
      timestamp:    1750000123 (2025-06-15T12:02:03Z)
      blockNumber:  42
      uri:          ipfs://child-v2
      parent:       0xroot…

[1]  0xroot…  <- lineage root (no predecessor)
      contributor:  0xAlice…
      attribution:  first anchorer only — NOT authorship
      timestamp:    1750000001 (2025-06-15T12:00:01Z)
      blockNumber:  41
      uri:          ipfs://root-v1
      parent:       (none) — lineage root
```

The same walk as machine-readable JSON for tooling/an indexer:

```
$ vh lineage 0xCHILD… --contract 0x… --rpc <url> --json
{
  "start": "0xchild…",
  "anchored": true,
  "ancestors": [
    { "depth": 0, "contentHash": "0xchild…", "contributor": "0xAlice…", "authorBound": false,
      "attribution": "first anchorer only — NOT authorship", "uri": "ipfs://child-v2",
      "parent": "0xroot…", "isRoot": false },
    { "depth": 1, "contentHash": "0xroot…", "contributor": "0xAlice…", "authorBound": false,
      "attribution": "first anchorer only — NOT authorship", "uri": "ipfs://root-v1",
      "parent": null, "isRoot": true }
  ],
  "cappedAtDepth": false,
  "maxDepth": 256,
  "nextParent": null
}
```

**What this shows you — and what it does not.** You have proven, on-chain, that `0xROOT…` was anchored
**before** `0xCHILD…` and that `0xCHILD…`'s author **claimed** `0xROOT…` as a predecessor. You have
**not** proven that `0xCHILD…`'s bytes are a genuine revision of `0xROOT…`'s — to establish that you
must independently obtain both contents, **re-derive both hashes** (`vh hash`), and judge the
relationship yourself. And `0xCHILD…` inherits **no** authorship from `0xROOT…`: each record's
`contributor`/`authorBound` stands alone. This is the lineage trust boundary, identical in spirit to
every other field in [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md).

---

## See also

- [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md) — what each record field proves and does not,
  including the `parent` clause this doc reuses verbatim.
- [`docs/MERKLE-LEAVES.md`](MERKLE-LEAVES.md) — what a directory/repo root commits to (paths + bytes),
  including the `--git` scope used to make a revision's root reproducible.
- [`docs/RECEIPTS.md`](RECEIPTS.md) — why the resumable `vh commit`/`vh reveal` split cannot yet carry a
  `--parent` (BACKLOG B-10.1) and the receipt trust posture.

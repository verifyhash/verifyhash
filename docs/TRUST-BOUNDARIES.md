# Trust boundaries — what a verifyhash record does and does NOT prove

This is the canonical, plain-language statement of what you may rely on when you read a
`ContributionRegistry` record, and what you must verify yourself. It mirrors the `@notice
TRUST BOUNDARIES` block in `contracts/ContributionRegistry.sol`; if the two ever drift, the
NatSpec in the contract is authoritative. Resolves audit findings **F17** and **C3**.

A record returned by `getRecord(contentHash)` has these fields:

```solidity
struct Record {
    address contributor;  // who is recorded — meaning depends on authorBound (see below)
    bool    authorBound;  // true => front-running-resistant claim (commit-reveal); false => first anchorer
    uint64  timestamp;    // block.timestamp at anchor time
    uint64  blockNumber;  // block.number at anchor time
    string  uri;          // off-chain pointer hint
}
```

The one and only thing the chain guarantees about a record is this:

> The exact 32-byte `contentHash` you queried was anchored on-chain by `contributor`,
> in block `blockNumber`, at (approximately) `timestamp`, and has not changed since.

Everything else below is about how *little* the other fields are allowed to mean.

---

## `uri` is an UNTRUSTED hint — always re-derive and re-hash

`uri` is a free-form string (an IPFS CID, a commit URL, a Swarm hash, anything). It is supplied by
whoever anchored the hash and is stored verbatim.

**The contract never fetches it, never validates it, never hashes it, and never compares it to
anything.** It is metadata for humans, not a security guarantee. A `uri` can:

- point at content whose hash is *not* the anchored `contentHash` (mismatched or swapped later),
- point at content that no longer exists, or never existed,
- point at completely unrelated content,
- be empty.

None of those make the record "invalid" — the record only ever attested to the `contentHash`, not
to the `uri`.

### How a consumer trusts a record

To rely on a record you must do the integrity check yourself:

1. Obtain the content you care about (e.g. fetch what the `uri` claims to point at, or take a local
   file/directory).
2. **Re-derive its hash** with the *same scheme* the registry uses — `vh hash <path>` (see
   `docs/MERKLE-LEAVES.md` for the exact directory-root construction). Do not trust a hash someone
   else computed.
3. **Compare** your recomputed hash to the anchored `contentHash`. They must be byte-for-byte equal.

If and only if they match, you know the content is exactly what was anchored. The `vh verify`
command automates exactly this re-derive-and-compare flow and is read-only (no key, no funds).
If they do not match, the content was either never anchored or has been tampered with — regardless
of what the `uri` says.

> Rule of thumb: **the `contentHash` is the proof; the `uri` is just a convenience pointer.**

### Reading a record (`vh list` / `vh show`) does NOT validate its content

`vh list` enumerates the registry and `vh show <0xhash>` looks up one record by hash. Both are
**read-only and need no key** — they take a provider only, never a signer — and both exist for
*discovery and audit*: answering "what is in the registry?" and "what does the record for this hash
say?". Neither command touches your files, so **a hit does not bind the record to any real bytes you
hold.** Seeing a record in `vh list`, or a populated record from `vh show`, tells you only that some
hash was anchored — it is *not* the integrity check.

The integrity check is unchanged: it is the same re-derive-and-compare flow above. To trust that some
content is what a record attests, you must still independently obtain the content, **re-derive its
hash** (`vh hash`), and confirm it equals the anchored `contentHash` — which is exactly what
`vh verify <path>` automates. Until you have done that, treat a listed/shown record's `uri` as an
untrusted hint and its `contributor` per the `authorBound` rule below. The read commands lead their
human-readable output with this caveat verbatim, so a browser of the registry is never lulled into
treating a `list`/`show` hit as proof that any file is authentic.

> Rule of thumb: **`list`/`show` tell you a hash is on-chain; only `vh verify` binds that hash to
> bytes.**

### A `--receipt` manifest is an UNTRUSTED hint too — it localizes, it does not verify

`vh anchor <dir> --receipt <p>` records a `manifest`: the sorted list of `{ path, contentHash, leaf }`
for every file in the directory (exactly what `vh hash <dir>` computes). `vh verify <dir> --receipt <p>`
then loads that manifest and prints a precise per-file diff — files **ADDED / REMOVED / CHANGED**
(old→new `contentHash`) — so a `MISMATCH` tells you *which* file diverged, not just *that* the tree
diverged.

The manifest is a **local convenience, not a trust anchor.** The authoritative verdict is still the
same re-derive-and-compare check above: `vh verify` recomputes the directory's Merkle **root** from
the files on disk and compares that root to the on-chain record. **MATCH/MISMATCH comes only from
that comparison.** The manifest never participates in the verdict; a malicious or stale receipt can at
worst mislabel which file moved, and even that is caught — `vh verify` flags a receipt whose recorded
root does not match the recomputed root (`receiptHashMismatch`) and reports it as a different snapshot
rather than silently pretending the files line up. The verify output prints this caveat inline, and
the receipt schema's NatSpec (`cli/receipt.js`) states it as well.

> Rule of thumb: **the on-chain root decides MATCH/MISMATCH; the receipt manifest only points at the file.**

---

## `timestamp` / `blockNumber` prove ordering + an UPPER BOUND on existence — NOT authorship time

`timestamp` is the `block.timestamp` and `blockNumber` is the `block.number` of the anchoring
transaction. They let you say two true things:

1. **On-chain ordering.** If record A's `blockNumber` is less than record B's, A was anchored first.
   Within a block, `index` (the insertion order) breaks ties.
2. **An upper bound on existence time.** The content *existed no later than* that block — you cannot
   anchor the hash of content that does not yet exist. So "this content existed by block N / by time
   T" is provable.

They do **NOT** prove:

- **Authorship time.** The content may have been created long before it was anchored. The anchor
  timestamp is when someone *recorded* the hash, not when the work was done.
- **A lower bound.** Nothing here says the content did *not* exist earlier; it only caps how late it
  could have appeared.
- **Who authored it — for a one-shot `anchor()` record (`authorBound == false`).** There,
  `contributor` is only the first *anchorer* (broadcaster), not a proven author: anyone who learns a
  `contentHash` (for example from the public mempool) can `anchor` it first. A
  commit-reveal record (`authorBound == true`) is different — see below.

---

## `contributor` — two attribution strengths, told apart by `authorBound`

This was decision **D-1** / task **T-0.3**: one-shot anchoring is front-runnable (a mempool watcher
can copy your `contentHash` and `anchor` it first, becoming the recorded `contributor`). The fix is a
**commit-reveal** path that binds the claimant to the content *before* the content hash is public.
Both paths write the same `Record`; `authorBound` tells you which guarantee you actually have:

| How the record was written | `authorBound` | What `contributor` means |
|----------------------------|---------------|--------------------------|
| `anchor(contentHash, uri)` (one tx) | `false` | **First anchorer only.** Front-runnable; NOT proven authorship. Use for cheap existence/timestamp proofs where attribution does not matter. |
| `commit(commitment)` then `reveal(contentHash, salt, uri)` | `true` | **Proven first claimant.** Front-running-resistant: the committer is hashed into the commitment before the content hash is exposed, so a copier cannot redirect attribution. |

**Why commit-reveal defeats the front-runner.** The commitment is
`keccak256(abi.encode(contentHash, committer, salt))`. Only that opaque hash goes on-chain first
(it leaks nothing about the content and is bound to the committer's address + a secret salt). After
`MIN_REVEAL_DELAY` blocks the committer reveals `(contentHash, salt)`. An attacker who copies the
revealed values from the mempool and resubmits the reveal as themselves recomputes
`keccak256(abi.encode(contentHash, ATTACKER, salt))` — a commitment they never registered — so their
reveal reverts (`NoSuchCommitment`). The maturation window stops them from committing-then-revealing
fast enough to beat an already-matured legitimate commitment. Net result: `contributor` stays the
original committer.

The CLI exposes this as `vh claim <path>` (commit-reveal) versus `vh anchor <path>` (one-shot).
`vh verify` prints the attribution strength for the record it finds. Tests live in
`test/Attribution.test.js` (contract) and `test/cli.claim.test.js` (CLI + a live-node front-run
proof).

### `timestamp` is validator-influenced — don't treat it as a precise clock

`block.timestamp` is chosen by the block proposer, constrained only loosely by consensus (it must
move forward and stay within a tolerance of real time). A proposer has a few seconds of slack and a
small incentive surface to nudge it. Therefore:

- Use `timestamp` for **coarse ordering** and **"existed by roughly T"** statements.
- Do **not** use it as a trustworthy wall clock, for sub-minute precision, or anywhere a few seconds
  of adversarial drift would matter.
- Prefer **`blockNumber`** when you need a hard, monotonic, harder-to-game ordering — block height
  cannot be reordered or nudged the way a timestamp can.

---

## One-line summary

| Field | Trust it for | Do NOT trust it for |
|-------|--------------|---------------------|
| `contentHash` | integrity of the exact content (after you re-hash and compare) | — |
| `contributor` (`authorBound = true`) | proven first *claimant* (commit-reveal; front-running-resistant) | — |
| `contributor` (`authorBound = false`) | who *anchored* it first | who *authored* it |
| `blockNumber` | hard on-chain ordering; "existed by block N" | authorship time; a lower time bound |
| `timestamp` | coarse ordering; "existed by ~T" | precise wall-clock time; authorship time |
| `uri` | a human hint of where the content might be | anything security-relevant — re-fetch + re-hash |

## Tests

`test/TrustBoundaries.test.js` proves these boundaries are documented and behaviourally true:

- the compiled NatSpec (devdoc/userdoc) actually contains the "untrusted"/"re-derive"/"re-hash" and
  "upper bound … NOT authorship time" statements (so the docs can't silently rot),
- a record can be anchored with a `uri` that points at the *wrong* content, and the contract accepts
  it unchanged — demonstrating the `uri` is never validated, so consumers must re-hash,
- `timestamp`/`blockNumber` reflect the *anchoring* block (set by the chain at anchor time), and the
  same content can be anchored long after it was created, demonstrating they are not authorship time.

`test/cli.readside.docs.test.js` additionally guards that the read-side caveat above can't rot: it
asserts that README.md and this file keep documenting `vh list` / `vh show` as read-only/no-key and
keep stating that listing or showing a record does NOT validate its content (you still re-derive +
`vh verify`), pinned to the caveats the read commands actually export.

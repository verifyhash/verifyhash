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
    bytes32 parent;       // optional predecessor edge; bytes32(0) == lineage root (see below)
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

## Authenticating the registry you read from — "don't believe a record until you know who answered"

Everything above is about trusting a *record*. This section is about trusting the *source* of the
record. The project's core promise is to prove things **without trusting any server**, but the
`(rpc, address)` pair a reader uses is itself **untrusted** — it comes from a prover, a receipt's
`contractAddress`, a proof artifact's `chainId`, a README, or a forwarded event. None of those are
the chain; any of them can be wrong or hostile.

### The threat — a wrong/rogue RPC+address can fabricate verdicts

A read command does `getRecord(contentHash)` (or `isAnchored` / `verifyLeaf`) against whatever
`(rpc, address)` it was handed and reports the answer. Two ways that silently produces a
confident-looking-but-wrong verdict:

- **Wrong address / wrong network.** Point at an address with *no contract* (a typo, or the right
  address on the wrong chain) and `getRecord` returns empty — read naively as "not anchored", so a
  genuinely-anchored contribution is mislabeled `MISMATCH`/absent.
- **Rogue look-alike contract.** Point at a *deployed but different* contract that implements the
  same ABI shape and it can return `isAnchored = true` / fabricated records, making the CLI print
  `MATCH` / `ACCEPTED` for content that was never anchored. The consumer is then trusting exactly the
  server the promise says they should not have to.

### What the read path now does to defend against it (T-11.1 / T-11.2)

Before believing any record, **every read command** (`vh verify`, `vh show`, `vh list`,
`vh lineage`, `vh verify-proof`) runs a shared, side-effect-free preflight
(`cli/registry.js › assertRegistry`) that authenticates the registry first, in this order:

1. **Bytecode-present check (`getCode`).** Confirm a contract is *actually deployed* at the address —
   so a typo'd address or right-address-wrong-network is caught with an actionable
   "no contract at &lt;addr&gt; on this RPC" error instead of a silent false `MISMATCH`.
2. **`REGISTRY_ID` / `REGISTRY_VERSION` identity probe.** Read the contract's immutable, ownerless
   self-identification marker (T-11.1: `REGISTRY_ID == keccak256("verifyhash.ContributionRegistry.v1")`
   plus a monotonic `REGISTRY_VERSION`) and **refuse to trust** a contract that does not self-identify
   as a genuine verifyhash registry of a version this build understands — closing the rogue-look-alike
   gap.
3. **Receipt/artifact `chainId` cross-check.** For `vh verify-proof` (whose artifact records the
   `chainId` it was anchored on), cross-check the provider's chainId against it, so a verdict is never
   reported against the wrong network — a root anchored on chain X says nothing about chain Y.

A genuine RPC/network error is surfaced **as itself** — never masqueraded as an identity failure
(mirroring the `isNotAnchoredError` discipline `vh verify` already uses). On success the human output
prints a one-line `registry authenticated: REGISTRY_ID ok (vN), chainId N` **before** any
verdict/record, and `--json` carries a `registry: { id, version, chainId }` block, so you can *see*
the check ran.

### The residual caveat — the ID is a "right interface" signal, NOT a sole root of trust

The identity probe proves you are talking to a contract that **exists**, **self-identifies as the
right interface**, and (for artifacts) lives on the **expected chain**. It does **NOT** make the
records honest beyond the contract's own immutable first-writer-wins + commit-reveal rules — `uri` is
still an untrusted hint and `contributor` still means proven authorship only when `authorBound` is
`true`, exactly per the sections above.

Crucially, `REGISTRY_ID` is a **POSITIVE "right interface" signal verified ALONGSIDE the deployed
bytecode and chainId — never a sole root of trust.** The constant is part of the open source, so
**a fork or copy-paste deployment can compile and return the same `REGISTRY_ID`.** The marker proves
"this is the right interface", not "this is *the* canonical registry". Therefore a consumer who needs
a **SPECIFIC** deployment (not merely *some* contract that speaks the interface) must **also pin the
address out-of-band** — confirm you are on the expected chain at the expected address with the
expected code — and not rely on the ID alone. This is the same caveat the contract's NatSpec states
verbatim under "ON-CHAIN IDENTITY MARKER" (`contracts/ContributionRegistry.sol`); if the two ever
drift, the contract NatSpec is authoritative.

### The loud opt-out (`--skip-identity-check`)

If you KNOW you are pointed at a not-yet-deployed / local-dev contract, every read command accepts a
**non-default, loud** `--skip-identity-check` that bypasses the preflight. When used, the output says
so unmistakably (human: `registry authentication: SKIPPED (--skip-identity-check) … the verdict is
only as trustworthy as the RPC/address you supplied`; `--json`: `registry: { "skipped": true, "note":
… }`). Without the flag, **every read command authenticates by default.**

> Rule of thumb: **authenticate the registry before you believe it — the `REGISTRY_ID` proves the
> right interface (alongside bytecode + chainId), but pin the address yourself if you need a specific
> deployment.**

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

## `parent` is a CLAIMED predecessor — not proof of ancestry, not a transfer of authorship

`parent` is an OPTIONAL, immutable predecessor edge (`bytes32(0)` == "no predecessor / root of a
lineage"). A record written with `vh anchor/claim --parent <hash>` names an **already-anchored**
predecessor; because the parent must pre-exist, the lineage graph is **acyclic by construction** (a
DAG), and the on-chain check is O(1) with no chain-walk. It asserts ONLY that the author of THIS record
CLAIMED the named predecessor. It does **NOT**:

- **prove content ancestry** — that the predecessor's bytes are genuinely an earlier version of, or
  were derived into, this content. Anyone can name any anchored hash as a parent; consumers must still
  **independently re-derive BOTH contents** (`vh hash`) and judge the relationship themselves.
- **transfer or imply authorship** — naming a parent grants this record nothing from it. Each record's
  `contributor`/`authorBound` stand alone, per the rule above.

`vh lineage <0xhash>` walks the `parent` chain from a record UP to its lineage root, and `vh show
<0xhash>` surfaces a record's `parent`. Both are **read-only and need no key** (provider only, never a
signer), exactly like `vh list`/`vh show` — walking a public, immutable lineage must never require the
ability to write to it. As with `list`/`show`, a lineage walk does **NOT validate content**: it only
reads what is on-chain. The human output of `vh lineage` leads with both this lineage caveat and the
shared record caveat (untrusted `uri`; `contributor` per `authorBound`), and an off-chain indexer
reconstructs the graph from the `Linked(child, parent)` event. Full detail and a worked example are in
[`docs/LINEAGE.md`](LINEAGE.md).

> Rule of thumb: **a `parent` edge is a claim of "I built on that", not a proof of "that became this".**

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
| `parent` | the child author's *claim* that it built on that predecessor (anchored earlier) | genuine content ancestry; any transfer of the parent's authorship — re-derive both |

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
`vh verify`), pinned to the caveats the read commands actually export. The same guard pins the
"Authenticating the registry you read from" section (T-11.3): that this file and the README keep
stating the threat (a wrong/rogue RPC+address can fabricate verdicts), the defence (the
`REGISTRY_ID`/version probe + the bytecode-present `getCode` check + the artifact `chainId`
cross-check), the residual caveat (the ID is a "right interface" signal verified alongside bytecode +
chainId, NOT a sole root of trust — a fork can reuse it, so pin the address out-of-band for a SPECIFIC
deployment), and the loud `--skip-identity-check` opt-out.

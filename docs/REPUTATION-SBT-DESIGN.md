# T-3.1 design: `ReputationSBT` — non-transferable reputation keyed to verified anchors

**Status: DESIGN ONLY — this document contains no code.** It is the EPIC-3 / T-3.1 deliverable that
specifies the on-chain reputation layer T-3.2 (`ReputationSBT` contract + tests) will implement.
Nothing here changes runtime behaviour; nothing here is deployed.

**Decision basis.** D-1 (RESOLVED 2026-06-23 → commit–reveal) gives us an attributable unit: a
registry `Record` with `authorBound == true` is a proven, front-running-resistant first claim.
D-2 (RESOLVED 2026-07-05 → **Option A: soulbound, non-transferable reputation-only**; Option B
tradeable token REJECTED) fixes the token framing. This design is the thin, additive on-chain layer
over the EPIC-12 substrate that P-1 predicted — the derived-view spec in
[`docs/REPUTATION.md`](REPUTATION.md) already supplies most of the reasoning, and this doc reuses it
rather than restating it. Read [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md) first; every caveat
there applies unchanged.

**Goal.** Give other contracts and off-chain consumers a cheap, composable, on-chain answer to
"how many *proven* (commit–reveal) contribution claims does this address hold?" — today that answer
exists only as the off-chain derived view (`vh reputation <addr>` paging `getRecordsByContributor`),
which a contract cannot consume and a UI must recompute.

**Non-goals.** No tradeable asset (D-2 Option B is rejected; the no-token/coin-for-revenue guardrail
stands). No new attribution mechanism (the registry's commit–reveal is the only authorship bar). No
scoring of content *quality* (a point attests a verified claim exists, never that the content is good,
original, or valuable). No governance weight, payouts, or entitlements — consumers may layer those
later, and anything touching funds or issuance is a separate `needs-human` proposal. No deploy: like
everything in this repo, the contract is built and tested against a local hardhat node only; any
public deployment is human-gated per P-2.

---

## 1. Data model

**The unit.** One **point** = one registry record with `authorBound == true`, credited to that
record's `contributor`. Points are integers per address; there is no tokenId to trade, enumerate, or
approve. `anchorOnly` records (`authorBound == false`, the front-runnable one-shot `anchor()` path)
mint **nothing, ever** — they prove first-anchoring, not authorship, and counting them would import
the registry's weakest signal into a layer whose whole purpose is the strong one.

**Keyed to verified anchors.** Every point is bound to the specific `contentHash` that backs it, so
every point is independently auditable: anyone can read the registry record for that hash, confirm
`authorBound == true` and `contributor == holder`, and (if they hold the content) re-derive the hash
with `vh hash` / `vh verify`. A point with no backing record is unmintable by construction.

**State held by `ReputationSBT`** (all of it — deliberately minimal):

| State | Meaning |
|-------|---------|
| `registry` (immutable, set at construction) | the ONE pinned `ContributionRegistry` this layer reads. Reputation is only as meaningful as the pinned registry — same pinning rule as the EPIC-11 read path. |
| `minted[contentHash] → bool` | whether this record has already been converted to a point. Enforces **at most one point per contentHash, globally, forever**. |
| `points[address] → uint256` | the holder's point balance. Monotonically non-decreasing; append-only like the registry itself. |
| `totalPoints` | sum of all balances, for cheap sanity reads. |

**The only state-changing operation: permissionless, credit-to-the-record mint.** Anyone may call
mint for a given `contentHash` (the caller pays gas; think keeper/indexer-friendly). The contract
reads the registry record and requires: the record exists, `authorBound == true`, and
`minted[contentHash] == false`. It then credits `record.contributor` — **never `msg.sender`** — sets
`minted[contentHash]`, and emits an event carrying `(contributor, contentHash)`. Because the credited
address comes from the immutable record, mint calls cannot be redirected, front-run for gain, or
griefed: a third party "stealing" your mint merely pays your gas. A batched mint (many hashes, one
transaction) is a convenience wrapper with identical per-hash semantics.

**No admin, no owner, no revocation, no burn.** The registry is ownerless and append-only; the
reputation layer inherits that. A point is exactly as immutable as the record behind it. Adding any
curator/slashing role would (a) introduce the privileged issuer the derived view was designed not to
have, and (b) turn an attestation into a discretionary asset. If curation is ever wanted, it belongs
in a separate opt-in layer, proposed as `needs-human`.

**Derived view stays canonical.** The EPIC-12 score (`vh reputation`) remains the free, re-derivable,
richer view (attribution + lineage breakdowns, block/time bounds). `ReputationSBT` adds only what the
view cannot provide: an O(1) on-chain read (`points(addr)`) another contract can consume without
paging, plus event logs indexers can follow. If the two ever disagree, the registry's records — the
common source both derive from — are authoritative; `points(addr)` can lag (records whose mint nobody
has paid gas for yet) but can never exceed the address's `authorBound` record count.

**A runnable off-chain reference exists NOW (no deploy required).** The exact per-address `points`
balance an on-chain `ReputationSBT` would hold is already computable — with zero deploy, zero key, and
zero custody — by the pure module [`cli/core/reputation-points.js`](../cli/core/reputation-points.js)
(`projectPoints` / `pointsOf` / `hasAtLeast`). It applies the rules of this section verbatim
(authorBound-only, one point per `contentHash`, credited to `record.contributor`, monotonic) over the
same records the shipping read path (`cli/reputation.js › readContributorRecords`) already fetches. This
module is BOTH (a) the executable **conformance oracle** T-3.2's contract is held to —
`points(addr)` on the deployed contract must equal `pointsOf(records, addr)` here for the same records —
and (b) the capability a paying consumer can use *today*, ahead of any P-2 deploy (see §5). The
projection's honest one-line boundary lives in exactly one place, the module's exported `POINT_MEANING`
string, so this doc, the future NatSpec, and the code cannot drift.

**Interface shape: minimal soulbound points, not ERC-721.** The contract exposes balance reads,
the mint path, and lock-signalling events in the spirit of ERC-5192 (everything permanently locked),
but is NOT a full ERC-721: no `tokenId`s, no `transferFrom`/`approve`/`setApprovalForAll` surface at
all (absent, not merely reverting where practical; any standard-mandated stub MUST hard-revert), no
enumeration of transferable units. Rationale: a full NFT interface exists to move tokens between
addresses — precisely the capability D-2 rejects — and wallet/marketplace tooling treats anything
721-shaped as tradeable inventory. Shipping the smaller surface makes non-transferability a
structural property instead of a policy check, and shrinks the audit surface T-3.2 must test.

---

## 2. Anti-sybil

The threat: addresses are free, so any reputation metric invites one actor with many addresses (or
many worthless records) to farm points. The design's honest position, inherited verbatim from
[`docs/REPUTATION.md`](REPUTATION.md): **the defenses raise the cost and auditability of inflation;
they do not make raw point counts sybil-proof, and the docs/NatSpec must say so.**

1. **Only `authorBound` records mint (the substrate's bar).** A point requires a commit–reveal
   claim: a sender-bound, salt-blinded `commit`, the `MIN_REVEAL_DELAY` maturation wait, then
   `reveal` — and only the original committer can ever open the commitment (a mempool copier
   recomputes a commitment that was never registered and reverts). So a sybil cannot earn points
   from other people's content revealed in the mempool; every point costs its holder two
   transactions of their own. The cheap-to-inflate signals (`anchorOnly`, raw `total`) are excluded
   from this layer entirely.
2. **One point per contentHash, globally.** First-writer-wins upstream (one immutable record per
   hash) plus `minted[contentHash]` here means the same content can never be counted twice — not
   across addresses, not across time. Trivial variants (flip one byte, new hash) remain possible;
   that is inflation *with new records*, covered by (1)'s cost and (4)'s auditability, not
   double-counting.
3. **Non-transferability is itself an anti-sybil property.** Farmed reputation cannot be
   consolidated into one respectable address or sold to someone who wants to look reputable — see
   §3. A sybil ring ends up holding many small, separately-inspectable balances instead of one big
   laundered one.
4. **Every point is auditable back to a record.** Because points are keyed to `contentHash`es, a
   consumer evaluating an address does not have to trust the number: they can enumerate the backing
   records (`getRecordsByContributor` / the mint event log), demand the content, and re-derive the
   hashes. Points make the strong signal *composable*; they do not make it *unquestionable*. A
   consumer for whom sybil resistance is load-bearing MUST weight points by inspecting backing
   records, exactly as the derived-view doc instructs for `authorBound` counts.
5. **What is deliberately NOT here:** stake-to-mint, mint fees, proof-of-humanity, allowlists, or
   human curation. Each either touches funds/custody (guardrail: `needs-human`), adds a privileged
   gatekeeper, or excludes honest pseudonymous contributors. Any of them can be layered later by a
   consumer contract without changing this one — reading `points(addr)` and applying their own
   filter is exactly the composability this layer exists to provide.

Residual risk, stated plainly: a determined actor can still commit–reveal N junk hashes from N
addresses and mint N points, paying gas each time. The layer's claim is therefore narrow and honest —
a point means "this address provably made this front-running-resistant claim, exactly once per
content" — and the number of points is a floor of verifiable *activity*, never a proof of *merit*.

---

## 3. Why non-transferable

1. **A transferred attestation is a lie.** A point asserts a historical fact about a specific
   address: "this address performed a proven commit–reveal claim for this content." Facts about
   address A do not become true of address B by payment. Transfer would decouple the signal from the
   history that generated it, destroying exactly the information the layer exists to carry — the
   receiving address would display reputation for contributions it verifiably did NOT make (the
   backing records still name the original contributor, so a transferred point would contradict its
   own audit trail).
2. **Transferability creates a market in fake reputation and re-opens sybil laundering.** If points
   moved, sybil farms would mint cheap points in bulk and sell consolidation to whoever wants to
   appear reputable; the anti-sybil floor in §2 collapses from "inspect the holder's own records" to
   "inspect the provenance of every purchased point." Non-transferability keeps the cost of a
   reputation permanently attached to the identity that bears it.
3. **Securities exposure (the D-2 resolution).** A non-transferable point has no market, no price,
   and no path to profit from others' efforts — under a Howey-style analysis there is no investment
   of money in a common enterprise with expectation of profit; it is an attestation, not an asset. A
   tradeable reputation token is the opposite on every prong, which is why D-2 Option B was rejected
   and why the standing HARD GUARDRAIL (no token/coin-for-revenue, no token sale) and the project's
   REVENUE INTEGRITY rule (income only from paying customers for delivered value) both require
   Option A. Revenue never comes from this layer; it stays with the products (evidence, licensing,
   verification) that may *consume* it.
4. **Mission fit.** The project is a *contribution* org: recognition should accrue to contributors,
   not to buyers of recognition. Soulbound points are the smallest mechanism that does that.

Mechanically (for T-3.2): non-transferability is enforced by ABSENCE — no transfer, approval, or
operator functions exist on the contract; there is no code path that changes `points` other than
mint-against-a-record. Tests must prove the ABI exposes no transfer/approval surface and that
balances only ever change via mint.

---

## 4. What T-3.2 must implement (acceptance handles)

- `contracts/ReputationSBT.sol`: constructor pins the registry address; permissionless
  `mint(contentHash)` (+ batch) crediting `record.contributor` only when `authorBound == true` and
  not already minted; `points(address)`, `minted(bytes32)`, `totalPoints` reads; events for every
  mint; no owner, no transfer/approval surface; NatSpec restating §2's honest boundary and §3's
  non-transferability rationale.
- Tests (local hardhat only): mint against an `authorBound` record credits the contributor
  regardless of caller; `anchorOnly` records revert; double-mint reverts; unknown hash reverts;
  balances match the EPIC-12 derived view's `authorBound` count after minting all records; ABI
  contains no transfer/approve/operator functions; docs-rot guard keeps this doc, the NatSpec, and
  [`docs/REPUTATION.md`](REPUTATION.md) consistent.
- **Conformance to the off-chain oracle.** For any record set, the deployed contract's `points(addr)`
  MUST equal [`cli/core/reputation-points.js`](../cli/core/reputation-points.js)'s `pointsOf(records,
  addr)`, and `totalPoints` its `projectPoints(records).totalPoints`. T-3.2's suite should assert this
  equivalence directly (mint every record, then diff on-chain balances against the pure projection) so
  the contract can never silently diverge from the spec this document already made executable.
- No deployment anywhere, per the standing guardrails; P-2 remains the only path to a public chain.

---

## 5. Consumer value — why a paying customer cares, and what runs before any deploy

The reputation layer is **infrastructure the income products consume, not a thing that is sold** (revenue
stays with evidence, licensing, and verification per the REVENUE INTEGRITY rule; §3.3). Its concrete
value is **composability**: it turns "who provably contributed, and how much" from an off-chain,
per-UI recomputation into a single reusable read.

**The buyer-facing use case.** A verification or evidence integration frequently wants to *weight or
gate* on contributor standing — e.g. "only auto-honor a claimed contribution when the claiming address
holds ≥ N proven, front-running-resistant (`authorBound`) contributions," routing everything below the
threshold to manual review. Today each such integration must page `getRecordsByContributor` and
re-implement the authorBound/anchorOnly split itself. This layer exposes it once:

- **On-chain (post-P-2):** another contract reads `points(addr)` in O(1) and branches on it — no paging,
  no trust in an off-chain indexer.
- **Off-chain (today, no deploy):** a consumer calls
  [`cli/core/reputation-points.js`](../cli/core/reputation-points.js) `hasAtLeast(records, addr, n)` over
  the records the shipping read path already fetches. Pure, re-derivable, no token, no key, no custody.
  The exact same predicate the contract will later enforce is available *now*, so the reputation
  capability delivers value **ahead of** the human-gated deploy, not only after it.

**Why this is honest leverage and not scope creep.** The predicate is a filter over records that already
exist; it invents no new asset, opens no license gate, and touches no funds. It is the smallest surface
that lets the paying products treat "proven contribution history" as a first-class, composable input —
and, because §2's boundary holds, every consumer is told plainly that a high point count is a floor of
verifiable *activity*, never a proof of *merit*, and that a load-bearing sybil decision must still weight
points by inspecting their backing records.

---
<sub>© 2026 verifyhash.com · Licensed under Apache-2.0 (SPDX-License-Identifier: Apache-2.0) — see the [LICENSE](https://verifyhash.com/LICENSE) and [NOTICE](https://verifyhash.com/NOTICE) served with this file.</sub>

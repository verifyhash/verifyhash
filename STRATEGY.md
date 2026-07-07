# verifyhash — Strategy, Decisions & Proposals log

The autonomous loop writes here. Read this first in the morning — it's *why* things changed, not just what.

## Standing guardrails (the loop must obey these)

- Local commits only — never push, never deploy to a real network, never touch real funds or keys.
- Token/economic/governance code may be **designed and built locally**, but issuing a security, a token
  sale, fund custody, or any outward/legal action is a **proposal here tagged `needs-human`**, never executed.

---

## Decisions
*(Decider appends here when it resolves an engineering fork — what was chosen and why.)*

- **2026-07-05 — T-71.1 stale `BLOCKED` → RECONCILED to `TODO`/verify-only (fork option (c) collapsed to reconcile: no split (a), no acceptance trim (b) — the T-46.1/T-61.1/T-63.1 pattern, again).**
  - **Problem.** T-71.1 (the PURE fleet-coverage core `cli/core/agent-coverage.js`: `evaluateCoverage`/`serializeCoverageReport`/`parseCoverageReport`, the `cli/core/*` purity discipline) was tagged `BLOCKED` "auto-build failed after 3 attempts: runner exit=3", damming ALL of EPIC-71 (T-71.2 CLI verb + CI gate → T-71.3 docs — the only other TODO chain in the file).
  - **Found.** The "failed" attempts DID produce the artifact: a complete 717-line module + 919-line test were left as untracked debris and swept into commit 5a84e01 (the T-72.1 landing, which noted full suite green with them present). At today's HEAD the dedicated suite is 44/44 green and carries the FULL original acceptance matrix (five-commit worked matrix over the closed verdict vocabulary, `packetVerified:false`-never-covered pinned negative, byte-identical serialize→parse round-trip with sorted-key canonical bytes, static purity grep, hostile-input fuzz with a CLOSED reason set), and the full `npx hardhat test` suite is green (4015 passing, 4 pending, exit 0 — re-run for this decision). Diagnosis: the engine's runner reports the RAW mocha exit code = failing-test COUNT, so "exit=3" was 3 failures somewhere in those attempts' full-suite trees — a harness/landing artifact, not a defect in the module that survived.
  - **Why not (a) split / (b) trim.** Both presume the task was too big to land — but it DID land, at full rigor; splitting would re-author working code, and trimming would weaken a green acceptance matrix for zero value (the exact regression the T-61.1 decision names).
  - **Action.** BACKLOG T-71.1 flipped `BLOCKED`→`TODO` with VERIFY-ONLY acceptance (exports + closed vocabulary + sealable-report module doc confirmed by READING; dedicated 44/44; full suite green at HEAD; code touched only if a criterion actually fails, each fix with a named test). This un-dams T-71.2 → T-71.3. Test command unchanged: `npx hardhat test`.

- **2026-07-05 — D-2 RESOLVED → Option A, soulbound non-transferable reputation (user-accepted
  default).** Option B (tradeable token) REJECTED; the no-token/coin/security guardrail stands.
  EPIC-3 (T-3.1, T-3.2 `ReputationSBT`) is now pure local engineering over the EPIC-12 substrate;
  any deploy stays human-gated (P-2). BACKLOG D-2 updated.
- **2026-07-05 — First-dollar config EXECUTED (DECISIONS-PENDING #2/#3 defaults, user-directed).**
  Price: `pricing/evidence-plans.json` ($29/mo, $290/yr). Vendor key: owner-held OUTSIDE the repo at
  `/home/loopdev/.verifyhash-vendor-key.txt` (mode 600 — the loop must NEVER read/move/copy it);
  address `0x7cb4d3DC6C52996B6386473Bfb32f898263412f7`; identity card verified ACCEPT at
  `identity/verifyhash-evidence.vhidentity.json`. Real-key smoke green: license fulfill → paid
  `seal --sign` → vendor-pinned verify ACCEPT → tamper REJECT. npm: `verify-vh@0.1.0` published (the
  front door was a 404 until now; cold `npx verify-vh demo` exits 0) + `verifyhash@0.1.1` (supersedes
  the leaky 0.1.0; both pre-gated). Still human: P-8 pilot / ~10 strangers, Stripe, legal.
- **2026-07-01 — T-63.1 stale `BLOCKED` → RECONCILED to `TODO`/verify-only.** The ordered Merkle-log core existed and was green (33/33); the full-suite RED was un-landed STRATEGY.md doc-hygiene (archiver + fixture refresh), healed the same day — no re-author. Full text: `docs/DECISIONS-ARCHIVE.md`.
- **2026-07-01 — T-61.1 stale `BLOCKED` → RECONCILED to `TODO`/verify-only.** `scripts/go-live-check.js` existed, complete and green (12 tests incl. 3 fault-injection negatives, guardrail greps); no 4th auto-build, no per-leg split. Full text: `docs/DECISIONS-ARCHIVE.md`.
- **2026-06-25 — T-46.1 stale `BLOCKED` → RECONCILED to `TODO`/verify-only.** `diffEvidence` existed with both dependents already VERIFIED; the block was a status/harness artifact — verify-only acceptance swapped in, no code change. Full text: `docs/DECISIONS-ARCHIVE.md`.

- **2026-06-23 — D-1 / T-0.3 attribution front-running → CHOSE commit–reveal (option a).**
  - **Problem.** `anchor(contentHash, uri)` puts the raw `contentHash` in the public mempool. A
    front-runner copies it, lands first under first-writer-wins, and becomes the permanent
    `contributor` — irreversible mis-attribution (audit F4/F14/F2/F5).
  - **Chosen.** Add a two-step path: `commit(commitment)` where
    `commitment = keccak256(abi.encode(contentHash, msg.sender, salt))`, then
    `reveal(contentHash, salt, uri)` after a `MIN_REVEAL_DELAY` maturation window. The committer is
    bound into the commitment *before* the content hash is ever public, so a copier who lifts the
    revealed `(contentHash, salt)` recomputes a different, never-registered commitment and reverts
    (`NoSuchCommitment`). Records carry `authorBound`: `true` for commit–reveal (proven first
    claimant), `false` for one-shot `anchor()`. The one-shot path is **kept** as a documented,
    front-runnable existence/timestamp proof for callers who don't care about attribution.
  - **Why not (b) per-author namespacing (`key = keccak256(addr, hash)`).** It stops one record from
    overwriting another but does NOT stop attribution theft — a front-runner still anchors
    `keccak256(theirAddr, hash)` and the registry now holds a record attributing *them* to the
    content. It also turns "one immutable global record per content" into "many competing claims",
    weakening the first-writer-wins product property and leaving "who really authored this"
    ambiguous. Fails the strong acceptance bar.
  - **Why not (c) accept + document.** The repo already documents `contributor` as "first anchorer"
    (T-0.4). Stopping there leaves the front-running hole open and makes EPIC-3 (reputation keyed to
    *verified contributions*) meaningless — you cannot reward authorship you cannot prove. Picking
    (c) would foreclose the project's actual direction.
  - **Cost accepted.** Two transactions, a secret salt to manage, and an N-block wait for an
    attribution-safe claim. Cheap single-tx anchoring remains available when attribution is moot.
  - **Shipped.** `contracts/ContributionRegistry.sol` (commit/reveal/commitmentOf/getCommitment/
    authorBound + Committed/Revealed events + new errors), `cli/claim.js` + `vh claim`,
    `vh verify` now prints attribution strength. Tests: `test/Attribution.test.js` (contract,
    incl. the core front-run-resistance proof) and `test/cli.claim.test.js` (CLI helpers + a
    live-hardhat-node end-to-end front-run proof). Full suite green (113 passing). Test command
    unchanged: `npx hardhat test`.

## Direction
*(Strategist appends here when it invents or pivots work.)*

- **2026-07-06 (r) — Strategist: frontier REOPENED on (q)'s own trigger — a BROKEN SHIPPED SURFACE — with exactly
  ONE hardening epic (EPIC-78, 3 tasks); no new product/vertical (adoption is still all-zero and the rule stands).**
  What changed since (q): T-76.2 landed + reworked green (full suite 4301), and the release half of the human ask
  was EXECUTED — `verifyhash@0.1.7` + `verify-vh@0.1.6` published, release anchored author-bound on mainnet (block
  89747859, 0f3eb7b); DECISIONS-PENDING §3 + P-8 sharpened today to first-contact-only. THE FIND: commit 73ec697
  (untrack loop-internal files from the public repo) correctly made STRATEGY.md/MORNING.md/DECIDE.md/BACKLOG.md
  local-only but left every PUBLIC surface pointing at them — README (the repo front door) + ~16 published docs
  carry `[STRATEGY.md](…)` links that now 404 on GitHub/site/tarball; CLI output tells strangers "see STRATEGY.md
  P-3"; and the site still PUBLISHES docs/DECIDE.md, an UNTRACKED internal-loop page with a stale pilot ask whose
  generator (sync-decide.cjs) now crashes and whose drift-guard test was deleted — the same internal-telemetry leak
  class ce4f35b purged from the tarball. For a product whose pitch is "trust what you can verify," the front door
  404ing on its own links is a funnel defect a first stranger hits. EPIC-78: T-78.1 de-publish DECIDE + retire the
  dead generator; T-78.2 repoint all public refs at a tracked anchor (TRUST-BOUNDARIES.md "Human-owned steps",
  boundary sentences preserved verbatim); T-78.3 a link-integrity test making this class a red build forever.
  Strictly category (a)/(b) under the adoption rule — distribution surface + hardening, zero novelty. The human
  asks are UNCHANGED (DECISIONS-PENDING §3): the ~10-min P-11 refresh (run it AFTER EPIC-78 lands — it also drops
  the live DECIDE page) and THE ask — 10 strangers, ONE segment, count twice-users into docs/ADOPTION.json; the
  next PRODUCT plan stays gated on that number. Post-Fable watch stands (first-shot flips to Opus 2026-07-08).

## Loop upgrades
*(Architect proposes engine improvements; the Gatekeeper promotes them only after BOTH the static
validator and the semantic smoke test pass. Each entry: what changed, and that both gates passed — or why it was rejected.)*

- **2026-07-06 — PROMOTED (engine #33, Architect-authored): RUN-RELATIVE spend baseline for the per-run token cap (fixes shared-counter stillbirth).**
  `budget.spent()` is the HARNESS SESSION counter, not a per-run counter, so a run launched in a turn that already spent
  tokens INHERITS that spend and can trip the per-run cap before building anything. This was METRICS-backed twice: run
  `wf_c66eb038` ended `endReason:"run-cap"` after 1 verified task at only ~0.78M authoritative per-run tokens (governor
  ledger names the cause verbatim), and the next run was STILLBORN (`rounds:1, firstShots:0, verified:0,
  spentTokens:8096665`) — the cap fired at the first top-of-loop check after only Roster+Preflight, which cannot spend 8M.
  Fix: capture the session counter ONCE before any agent call (`const SPENT_AT_START = budget.spent()`) and measure both
  the cap and the `spentTokens` telemetry against it (`runSpent = () => Math.max(0, budget.spent() - SPENT_AT_START)`),
  making batch-2 #3's stated intent ("bounds a single RUN's magnitude") true in code. The per-run cap check now reads
  `if (runSpent() > RUN_CAP_TOKENS)` (logging run/session/baseline), the METRICS `stats` line serializes `runSpent()` for
  `spentTokens` plus a new `"spentAtStart"` field exposing the inherited baseline. Session-total protection is UNWEAKENED:
  the absolute budget floor (`budget.remaining() < 80000`) and the supervisor window governor (`docs/USAGE-BUDGET.json`)
  are untouched; on a fresh-turn launch the baseline is 0 and behavior is byte-identical to #32; the smoke harness
  (`spent() === 0`) sees baseline 0, a no-op. `Math.max(0, …)` guards a mid-run counter reset from ever reading negative
  (cap degrades conservatively, never explosively). Diff is +30/-4: two new `const`s, one cap-check edit, one stats-line
  edit, comments — no gate, schema, control-flow, self-upgrade-path, or guardrail (NEVER push/deploy) change; both METRICS
  consumers (reconcile-run / pre-run-gate) parse lines field-agnostically. Gates: `validate-driver.cjs` → PASS and
  `smoke-driver.cjs` → SMOKE-PASS (5 scenarios: verify-before-commit + gatekeeper-invocation + FAILING-verdict /
  testsPass:false / mechanical runner-red all BLOCK-with-no-commit; 23 agent calls, all terminated cleanly). md5
  `b0965e8b87b6de4cc466fde0ed63e051`; prior engine (#32) backed up to `build-loop.prev.js` (md5 `3e87857732dd900c49d9e6685de52eaa`).

## Team changes
*(Manager appends here when it reshapes the roster — what it added/changed/removed and the signal that justified it.)*

- **2026-07-06 (run — T-76.2:VERIFIED(4/5); T-78.1:VERIFIED(4/5); T-78.2:VERIFIED(4/5);
  T-78.3:VERIFIED(4/5)[2x]; 4 verified, 0 blocked, 1 rework, 3 newly-invented; avg 4.0, min 4) —
  Manager: NO CHANGE (panel stays 5 reviewers + 5 builder profiles; no lens/persona edit).**
  - **Recovery HELD; 4.0 is the healthy ceiling, not a mediocre plateau.** avgUsefulness (driver, newest
    last, incl. this run) = `3.25(min2) → 4.0 → 4.0 → 4.0 → null(stillborn) → 4.0(min4)`. The 3.25/min-2
    trough is five runs back and already explained-and-corrected (the axis-regression Critic's SCORING
    FLOOR now caps at 2). A sustained 4.0/min-4 with the anti-orbit/anti-self-tooling floors ARMED means
    the planner is routing energy to LIVE, no-human-gate veins — the intended signal, not a plateau to
    attack (the genuinely monetizable next steps all sit behind the single P-8 design-partner human dam).
  - **The one anomaly was an ENGINE/budget bug, already fixed — NOT a roster defect.** The `null` run
    (07-06T17:50) was STILLBORN: the per-run token cap fired off the inherited HARNESS-SESSION counter at
    the first top-of-loop check (0 verified, `spentTokens:8096665`, `rounds:1`). That is engine #33's
    RUN-RELATIVE spend-baseline fix (see `## Loop upgrades`), which is exactly why THIS run rebounded to 4
    clean verifies. Budget/cap mechanics live in build-loop.workflow.js, not team.json — out of roster
    scope, and correctly handled by the Architect/Gatekeeper, not a lens/persona reshape.
  - **This run's four tasks were on-axis, customer-facing, and correctly scored.** T-76.2 shipped the
    SECOND independent Python verifier for user cross-verification (VerifierIndependence's #1 "verify
    independently OFFLINE" headline). T-78.1/78.2/78.3 closed a REAL funnel defect — the public front door
    (README + ~16 published docs + CLI output) 404ing on its own now-untracked STRATEGY.md links, and the
    site still publishing the untracked internal DECIDE page (the same internal-telemetry leak class
    ce4f35b purged from the tarball) — then made it a RED BUILD forever via a link-integrity test. That is
    squarely Operability's DISTRIBUTION / PAVED-ROAD clause and Critic's carve-out (i) (distribution IS
    customer-facing, never navel-gazing) on the declared adoption=ZERO frontier. Usefulness 4 is correct
    on all four; nothing off-axis / orbiting the P-8 dam / reviving the retired crypto-registry surface /
    built as internal self-tooling instead of customer work slipped through at a wrongly-high score — so
    no mis-scoring blind spot opened that would justify adding or sharpening a lens.
  - **Why no lever fired.** No usefulness DECLINE (recovery held, four clean 4.0s bracketing one
    engine-caused stillbirth). No flat-MEDIOCRE plateau (4.0 is the ceiling; the floors are working). No
    new mis-scoring surface (every surface this run touched was already owned — VerifierIndependence for
    the Python cross-verifier, Operability for the paved-road/leak hygiene). No underperforming reviewer to
    remove. No builder mismatch (T-78.3's 2× rework is single-task noise; cross-run rework = 3,1,3,0,0,1,
    no trend). A reshape now would be thrash. (Out of scope, no reshape: firstShotModel=fable — Fable
    leaves 2026-07-08 and first-shot flips to Opus, a MODEL-table concern not in team.json; the standing
    humanGated dam is a human decision, not a team defect.)

## Proposals — needs-human
*(Anything legal/funds/deploy/launch that the loop wants but is NOT allowed to do on its own.
 Review these and decide. Examples likely to land here: mainnet deploy, any tradeable token, a token sale.)*

- **P-1 (2026-06-23) — DECISION-READY: D-2 token framing for the reputation layer (EPIC-3).**
  *Status: needs-human. This is the single blocker that has capped the loop's usefulness at ~4/5 for 6+
  runs — cited 15+ times across STRATEGY/BACKLOG/MORNING as "the bigger prize, blocked on D-2" but never,
  until now, written as something a human can actually decide. The Critic reviewer lens was modified
  (2026-06-23) specifically to surface this. Below is the sharp options/tradeoffs/recommended-default the
  loop owes you.*
  - **The decision.** When verifyhash adds a reputation layer keyed to verified (`authorBound`)
    contributions, is the unit of reputation (A) a NON-TRANSFERABLE, soulbound "contribution score"
    (reputation-only), or (B) a TRADEABLE token? This gates the contract design for EPIC-3 (T-3.1/T-3.2).
  - **Option A — non-transferable, soulbound reputation (RECOMMENDED DEFAULT).** Reputation is a
    per-address score derived from / minted against the contributor's verified records; it CANNOT be
    transferred, sold, or pooled. *Pros:* essentially zero securities exposure (no investment-of-money,
    no expectation of profit from others' efforts — it is an attestation, not an asset); matches the
    project's actual goal ("decentralized contribution ORG" = recognize real contributors, not trade a
    coin); can be built and tested locally with NO legal review and NO funds. *Cons:* no direct financial
    incentive; sybil resistance must come from the cost/effort of producing real, verifiable contributions
    (the commit-reveal authorBound bar already raises that cost) plus optional human curation, not from
    token economics. *This is the path EPIC-12 below already starts building the substrate for, WITHOUT
    needing this decision — Option A would be a thin, additive on-chain layer over that substrate.*
  - **Option B — tradeable token.** *Pros:* direct economic incentive, composability with DeFi, a funding
    mechanism. *Cons:* almost certainly a security in most jurisdictions → REQUIRES qualified securities/
    legal counsel BEFORE any design is finalized and BEFORE any deploy; brings sybil/wash-trading attack
    surface; pulls the project from "contribution registry" toward "token project," which the human may
    not want. The guardrails forbid the loop from issuing a security, a token sale, or fund custody — so
    even if chosen, the loop can only DESIGN/locally-build it; issuance stays a separate human action.
  - **Recommended default: Option A (reputation-only / soulbound).** It unblocks EPIC-3 with zero legal
    exposure, fits the stated goal, and is the natural cap on EPIC-12's substrate. Pick B only if you
    specifically want an economic/funding layer AND will engage counsel first. Either way, please RESOLVE
    D-2 in the "Decisions" section so EPIC-3 can move off `needs-decision`.

- **P-2 (2026-06-23) — Mainnet/testnet deployment (EPIC-4 / T-4.1).** *Status: needs-human; outward-facing,
  guardrail-blocked from auto-run.* The contract + CLI are complete and green (537 passing) and the
  read path now authenticates the registry (EPIC-11). A public deployment (even Polygon **Amoy testnet**)
  is an outward-facing action the loop must NEVER take on its own. To proceed, a human must: (1) supply a
  THROWAWAY, faucet-funded testnet key (never a real-funds key); (2) run `scripts/deploy.js` against Amoy;
  (3) record the deployed address + verify the source on the Amoy explorer; (4) note that address in
  README so consumers can pin it out-of-band (the EPIC-11 identity probe is a "right interface" signal,
  NOT a substitute for pinning the specific deployment). Recommended: deploy to Amoy FIRST as a public
  smoke test before any mainnet conversation. No mainnet deploy and no real funds without explicit,
  separate human sign-off. **UPDATE (2026-07-03, EPIC-70): this flip unlocks on-chain anchoring for EVERY sealed
  artifact — `vh anchor-artifact`/`vh verify-anchored` shipped (docs/ANCHORING.md).**

- **P-3 (2026-06-23) — DataLedger signing / timestamp trust-root (the income product's biggest unlock).**
  *Status: needs-human; involves real key custody and/or an external timestamp anchor — the loop must NOT
  stand this up on its own.* DataLedger's single most-repeated limitation (docs/DATALEDGER.md, the in-band
  `TRUST_NOTE`) is that a manifest is NOT a timestamp: it binds a file SET to a Merkle root but says nothing
  about WHEN the dataset existed, so it cannot make the "unaltered since date T" claim an EU-AI-Act /
  due-diligence reviewer ultimately wants. Closing that gap is the highest-value provenance step the product
  has — but it requires a HUMAN decision and a HUMAN-held trust anchor, so it stays here. EPIC-15 / T-15.2
  deliberately builds the part the loop CAN do without this decision: a deterministic, canonical, UNSIGNED
  attestation payload (`vh dataset attest`) — the exact bytes this trust-root would sign — so that when a
  human resolves P-3, signing becomes "sign THIS file" rather than a redesign. **UPDATE (2026-06-23,
  EPIC-17): the loop now also ships the SIGNATURE-ENVELOPE FORMAT and an OFFLINE VERIFIER
  (`vh dataset verify-attest`), proved end-to-end with EPHEMERAL throwaway test keys (the loop NEVER holds a
  real key).** This collapses P-3 step 3 ("decide the signature/timestamp envelope format") to nothing for
  the self-managed-key path: the detached `eip191-personal-sign`-over-canonical-bytes container and its
  verifier already exist and are locally tested, so a human's remaining work for Option (A) is purely
  PROVISION-AND-SIGN: provision a real key (NEVER inside the loop), sign the canonical unsigned bytes
  `vh dataset attest` emits with the documented scheme, wrap them in the shipped signed container, and any
  buyer can `vh dataset verify-attest --signer <yourPublishedAddr> --manifest <m>` to confirm it. Options
  (B)/(C) (TSA / on-chain anchor) still need their own envelope + the human service/funds. **The
  decision.** Which trust-root to adopt: (A) a self-managed signing key (the publisher signs the canonical attestation payload
  with a held private key; cheapest, but the timestamp is only as trustworthy as "the publisher says so" +
  key custody risk); (B) an independent timestamp authority / transparency log (e.g. an RFC-3161 TSA or a
  public transparency-log anchor — a stronger, third-party-attested "existed by date T", needs an external
  service relationship); or (C) anchor the attestation payload's digest on a public chain at a block whose
  time bounds existence (ties back to the registry core, but is an outward-facing deploy — see P-2, and still
  needs real funds/keys). **Recommended default: start with (A) for a design-partner pilot** (it makes the
  product demonstrably "signed by the data publisher" with zero external dependencies and lets a buyer
  evaluate the workflow), then offer (B) as the enterprise upgrade where an independent "existed by date T"
  is required. Whichever is chosen, the loop can only DESIGN/locally-test it; provisioning a real key, a TSA
  relationship, or any on-chain anchor is a separate human action. **The handoff is now PROVISION-ONLY for
  Option (A)** (EPIC-17 / T-17.x shipped the format + the offline verifier, locally proved with EPHEMERAL
  throwaway `Wallet.createRandom()` keys — the loop NEVER holds a real key, and docs/DATALEDGER.md's "Signed
  attestation + verification" subsection documents the schema, the verifier, the 0/3 exit, and a worked
  attest → sign → verify-attest example). **UPDATE (2026-06-23, EPIC-19 / T-19.x): the loop now ALSO ships
  the SIGNING command itself** — `vh dataset sign <manifest> --key-env <VAR> | --key-file <path>` — proved
  end-to-end with EPHEMERAL throwaway `Wallet.createRandom()` keys. It READS a key the human provisioned
  OUTSIDE the loop, constructs an in-process ethers Wallet, signs the canonical `vh dataset attest` bytes
  (`eip191-personal-sign`), and writes the signed container the existing `vh dataset verify-attest` accepts —
  and it **NEVER generates, persists, or logs a key** (a read-only of YOUR key; neither/both/missing/malformed
  key sources hard-error before any signing, naming only the SOURCE, never the key). The OLD steps "(3) decide
  the envelope format" AND "hand-craft the signature with external tooling" are both DONE. **So for Option (A)
  the human handoff now collapses to exactly: (1) pick A/B/C; (2) PROVISION a real signing key OUTSIDE the
  loop (NEVER inside it); (3) run `vh dataset sign --key-env <VAR>` (or `--key-file <path>`) — DONE: the
  buyer verifies with the EXISTING `vh dataset verify-attest --signer <yourPublishedAddr> --manifest <m>`.**
  Only then is "unaltered since date T" claimable in docs/output — and even then ONLY to the strength of the
  chosen trust-root (a self-managed key (A) attests "the publisher says so", not an independent timestamp;
  that is what (B)/(C) buy). CRITICAL: a SIGNATURE alone proves only that the
  key-holder vouched for the dataset IDENTITY — the loop ships the FORMAT + VERIFIER + the `sign` command
  (all locally proved with throwaway keys) and never generates, holds, or persists a real key, or claims a
  timestamp on its own; provisioning the key + choosing A/B/C stays the human-owned part of P-3.
  **UPDATE (2026-06-23, EPIC-20 / T-20.x): the loop now ALSO ships Option (B)'s missing half — the RFC-3161
  INDEPENDENT-TIMESTAMP format + the OFFLINE verifier** (the timestamp analogue of what EPIC-17 did for the
  signature). Until now ONLY Option (A) (the publisher's own signature — honestly weak, "the publisher says
  so") had a format and a verifier; Option (B) — an INDEPENDENT RFC-3161 Timestamp Authority that attests
  "this digest existed by date T", the enterprise upgrade a paying buyer actually wants — had NEITHER. EPIC-20
  ships: `vh dataset/parcel timestamp-request` (emit the exact SHA-256 digest of the canonical attestation
  bytes for YOUR TSA to stamp), a detached `*-attestation-timestamped` container that WRAPS the returned
  RFC-3161 token bound to that digest (wrap-don't-edit, same invariant as the signed envelope), and
  `vh dataset/parcel verify-timestamp` — an OFFLINE verifier that parses the token's `TSTInfo`, confirms its
  `messageImprint` binds EXACTLY the buyer's own canonical-attestation digest, and reports the asserted
  `genTime` / TSA serial / policy OID. Proved end-to-end with SELF-MINTED throwaway TEST tokens (a test-only
  mock TSA with an ephemeral key — the loop NEVER calls a real TSA, holds no token, generates none, needs no
  network, and adds no new dependency: RFC-3161 parsing is a small pure bounded DER reader). **Scope boundary
  (honest, bounded — never overclaims): the verifier proves the binding + surfaces the asserted genTime, but
  does NOT validate the TSA's X.509 certificate CHAIN — that is the human trust anchor (you TRUST your chosen
  TSA's published cert), exactly mirroring how Option A pins the signer ADDRESS. Use your platform's CMS
  verifier / `openssl ts -verify` for full PKI chain validation if you require it.** **So Option (B)'s human
  handoff now collapses to exactly: (1) pick a TSA you trust; (2) run `vh dataset/parcel timestamp-request` to
  get the digest; (3) obtain a token from your TSA over that digest (the ONLY outward/network step — human
  owned); (4) run `vh dataset/parcel timestamp-wrap`; DONE — any buyer verifies OFFLINE with
  `vh dataset/parcel verify-timestamp --manifest <m>`.** This is materially stronger than Option (A): an
  INDEPENDENT third party (not the publisher) attests existence by genTime. Option (C) (on-chain anchor at a
  block whose time bounds existence) still needs its own envelope + an outward deploy + real funds (see P-2)
  and is NOT yet built. The loop still NEVER calls a TSA, holds no key/token, and provisioning the key
  (Option A) / obtaining the TSA token (Option B) / the on-chain anchor (Option C) stays the human-owned part
  of P-3.
  **UPDATE (2026-06-23, T-20.3 — Option (B) is now FULLY SHIPPED + tested, NEVER a real TSA): the OFFLINE
  independent-timestamp VERIFIER `vh dataset/parcel verify-timestamp <container> [--manifest <m>] [--json]`
  is built and green** — it re-derives the canonical attestation bytes from the embedded payload, confirms
  `digest === sha256(bytes)`, parses the RFC-3161 token (T-20.1), confirms `bindsDigest`, and (with
  `--manifest`) binds the token to the BUYER's own data exactly like `verify-attest`. It prints ACCEPTED with
  the asserted `genTime` (ISO UTC) / TSA `serialNumber` / policy OID, or REJECTED naming which check failed,
  on the shared 0/3 CI-exit contract (`verify`/`verify-attest`). The in-band output LEADS with the EXACT
  bounded claim — *"ACCEPTED means an RFC-3161 TSA asserted this exact dataset/parcel identity (digest)
  existed by `<genTime>`; this is as trustworthy as the TSA whose certificate YOU trust — this command does
  NOT validate the TSA's certificate chain (use your platform's CMS verifier / `openssl ts -verify` for full
  PKI validation)"* — and NEVER prints "unaltered since date T" without that qualification. A tampered token,
  a mismatched digest, an edited embedded attestation, or a DIFFERENT `--manifest` each REJECT (proven in
  tests; never a false ACCEPT), all over SELF-MINTED throwaway TEST tokens (a test-only mock TSA, ephemeral
  key — NO real TSA, NO network). **So Option (B)'s human handoff now collapses to EXACTLY: (1) pick a TSA you
  trust; (2) run `vh ... timestamp-request` to get the digest; (3) obtain a token from your TSA over that
  digest; (4) run `vh ... timestamp-wrap`; DONE — buyers verify offline with `vh ... verify-timestamp`.** The
  loop still NEVER calls a TSA, holds no key/token, and generates none; obtaining the token (step 3) is the
  only outward/network step and stays the human-owned part of P-3.
  **UPDATE (2026-07-03, EPIC-70): Option (C)'s auto-buildable half is SHIPPED — `vh anchor-artifact --rpc`
  anchors into ANY deployment, `vh verify-anchored` proves the receipt offline (docs/ANCHORING.md).
  Human half: deploy per
  P-2 (throwaway faucet key, Amoy first); the loop NEVER
  deploys/holds funds/anchors publicly.**

- **P-4 (2026-06-23) — ProofParcel go-to-market: land a B2B data-delivery design partner + pricing (the
  revenue step for the SECOND product).** *Status: needs-human; outward-facing/commercial — the loop only
  BUILDS and locally TESTS; sales, pricing, and contracts are human actions.* EPIC-18 ships ProofParcel as a
  thin, fully-tested CLI product over the shared provenance core (`vh parcel build/verify/attest/verify-attest`)
  — a tamper-evident, signable, independently-verifiable proof-of-delivery receipt for B2B data exchange. That
  is a built PRODUCT, not revenue. To convert it to income a human must: (1) identify a design-partner buyer
  with the actual pain (a data vendor / market-data redistributor / ML-data marketplace / any contract with a
  delivery-acceptance clause where "you never sent it / it was altered" disputes are expensive); (2) decide the
  pricing model (per-parcel metered, seat/subscription, or on-prem license — ProofParcel is offline/no-network,
  so an on-prem license or a per-delivery meter both fit); (3) for the SIGNED receipt path, resolve P-3 for the
  ProofParcel context too — **and this is now SHIPPED as a ONE-COMMAND step (EPIC-19 / T-19.x): the handoff for
  Option (A) collapses to exactly (1) pick A/B/C; (2) PROVISION a real signing key OUTSIDE the loop; (3) run
  `vh parcel sign --key-env <VAR>` (or `--key-file <path>`) — DONE.** That command reads the key the sender
  provisioned (it NEVER generates/persists/logs a key), signs the canonical `vh parcel attest` bytes
  (`eip191-personal-sign`), and writes the signed container; the recipient/arbiter confirms it with the
  EXISTING `vh parcel verify-attest --signer <sendersAddr> --manifest <m>`. Until a key is provisioned,
  ProofParcel proves tamper-evidence + signable identity but NOT a trusted delivery TIMESTAMP — same honest
  posture as DataLedger.
  Recommended: pilot the UNSIGNED tamper-evidence + diff workflow first (zero external dependencies) to validate
  the buyer pain, then add the signed receipt once a design partner is engaged. REVENUE INTEGRITY: income comes
  ONLY from selling this value to a paying customer — never a token/coin/sale.

- **P-5 (2026-06-24) — TrustLedger go-to-market: the three human decisions that gate SELLING the new LEAD
  product (CPA/counsel sign-off + per-state trust-rule policy + design-partner brokers).** *Status:
  needs-human; outward-facing/legal/commercial — the loop only BUILDS and locally TESTS; legal review, policy
  research, and sales are human actions and MUST NOT be auto-executed.* EPIC-22 / T-22.4 ships TrustLedger as a
  built, fully-tested PRODUCT: `vh trust reconcile <bank> <ledger> <rentroll> [--out <dir>]` runs ingest → match
  → reconcile → report end to end and emits a dated, deterministic, audit-ready HTML + CSV packet with a
  one-line PASS/FAIL + CI-gateable exit code (engine, report format, and disclaimer all green). That is the
  demoable core value — a broker runs their real files and watches the three numbers tie out — but a
  **correct engine is not a sellable product.** Three decisions are hard-coded in the shipped code AS IF settled
  and each is genuinely state- and CPA-dependent; converting TrustLedger to income requires a human to resolve
  them:
  1. **CPA / counsel sign-off on the legal disclaimer + the meaning of PASS.** The disclaimer wording
     (`trustledger/report.js` › `DISCLAIMER_LINES`) and the explicit claim that **a PASS does NOT imply legal
     compliance** are shipped as drafted by the loop, not reviewed. The broker is the legal trust-account
     custodian carrying personal license risk, so the exact wording (what the tool DOES and does NOT attest, and
     that it is not legal/accounting/audit advice) is a liability-bearing artifact that a CPA and/or counsel must
     review and approve before the product is offered. The doc (`docs/TRUSTLEDGER.md`) was written to make this
     reviewable in one place. **The deliverable the CPA/counsel reviews is now a SEALED, independently-verifiable
     artifact.** EPIC-26 (T-26.1/T-26.2, shipped + green) made the audit packet TAMPER-EVIDENT: `vh trust reconcile
     … --out <dir> --seal` binds the three source inputs + every emitted packet file + a synthetic verdict/role
     HEADER into ONE content-addressed Merkle root (reusing the project's provenance core verbatim — no new crypto),
     and the offline, read-only `vh trust verify-seal <sealfile>` RE-DERIVES that root from the bytes on disk so an
     examiner can confirm **byte-for-byte** that this is the exact packet TrustLedger produced (any edit/rename/
     add/remove of a file, or any edit of the verdict/date/period or swap of an input role, makes verify-seal
     REJECT and LOCALIZE the change — see `docs/TRUSTLEDGER.md` › "Sealing the packet"). So the human review is of
     a tamper-EVIDENT packet, not an editable printout — which strengthens, not changes, what the CPA/counsel signs
     off on. **What the seal does NOT do (still human-gated):** the seal proves only tamper-evidence; the trust-root
     for "**sealed on date T**" (a signing key and/or a trusted timestamp) is **P-3**, and the seal MAY be signed
     via the shared attestation envelope but the loop NEVER provisions a real key/timestamp — that stays needs-human.
     The CPA/counsel sign-off and the legal MEANING of a PASS remain exactly the human decision below; the seal does
     not weaken the disclaimer or replace the CPA review.
  2. **Fill in + have counsel sign the per-state policy TABLE in the shipped, validated format — the engine
     already consumes it.** EPIC-23 (T-23.1/T-23.2, shipped + green) turned the severity classification from
     hard-coded source into **data**: `trustledger/policy.js` is a versioned, strictly-validated per-state policy
     + a pure `applyPolicy` that overrides severities, and `vh trust reconcile --state <code>`/`--policy <file>`
     already make the PASS verdict + exit code + packet reflect the SELECTED policy (naming it and surfacing each
     override's citation). So this is **no longer** a from-scratch "rewrite the engine's classification" task. The
     now-narrow human task: **fill in `trustledger/fixtures/policy/<state>.json`** (the `severities` overrides +
     their statute `citations`) in the shipped, validated schema, and have a **CPA/counsel review and SIGN** that
     per-state mapping for the jurisdiction. The bundled `baseline.json` (the built-in defaults verbatim) and
     `ca-example.json` (an ILLUSTRATIVE override with a PLACEHOLDER citation) are the DRAFT skeletons to copy; the
     schema + selection + verdict-flip example are documented in `docs/TRUSTLEDGER.md` › "The per-state policy
     layer." No engine change is required. Until a human fills in + signs a real per-state table, the gate runs on
     the built-in baseline — a useful aid, not a compliance determination.
  3. **Run the two-month design-partner SCRIPT with 1–2 brokers (e.g. NARPM) — that two-month run IS the WTP
     validation.** The buyer is the broker of record at a ~50–500-door residential PM firm on QuickBooks + a
     bank CSV + a rent ledger (NOT on AppFolio/Buildium), reachable purely via high-intent SEO/ads/NARPM forums
     — no insider network. EPIC-24 (T-24.1/T-24.2, shipped + green) turned the period chain into a
     machine-emitted, continuity-checked artifact (`trustledger/close.js` + `--prior-close`/`--emit-close`), and
     EPIC-25 (T-25.1/T-25.2/T-25.3, shipped + green) added the de-risked onboarding step — a read-only
     `vh trust inspect` diagnostic plus a `--map`/`--map-file` column-mapping escape hatch and widened
     alias/date coverage — and EPIC-27/28 (`vh trust serve` + the browser inspect/map UI, T-28.1/T-28.2,
     shipped + green) brought that SAME self-service fix to the BROWSER, so the single most likely pilot-killer
     (ingest choking on a real broker's export) is **no longer** a dead end — and the onboarding step no longer
     requires a terminal. The script therefore now **LEADS with the onboarding step on the surface a
     non-technical broker actually uses (the browser)**, then runs the two-month reconcile:
     - **FIRST** have the partner open `vh trust serve` **in their browser** and **drop each of their REAL
       files**: if a file does not load, the page shows that file's columns and lets the broker **map** the
       missing field from a dropdown of its actual headers, then re-checks it — the in-browser inspect/map UI
       (the same read-only `diagnoseSource` fix as the CLI `vh trust inspect <eachFile> --as <type>` /
       `--map <logical>=<header>`, which writes nothing and checks only PARSING, but requiring NO terminal).
       This closes the gap between "the buyer who will never use a terminal" and an onboarding step that used
       to require one — so a real export's first contact with the tool is "it loads, or the tool tells you
       how," not a wall, and not a command line the buyer will never run. (Technical users keep the CLI
       `vh trust inspect`/`--map` path.)
     - **THEN** run the recurring script: have the partner run `vh trust reconcile … --state <code>
       --emit-close month1.json` on their **REAL month-1** files, then re-run on **month-2** files with
       `--prior-close month1.json`; confirm (a) the three balances tie out **both months**,
       (b) the roll-forward is clean (no `CONTINUITY_BREAK`), and (c) the exceptions read correctly.

     **That two-month run IS the WTP validation** — it proves the recurring monthly product (legally-forced
     every month) working PAST month one, which a single-period demo cannot show; leading with the **browser**
     inspect/map UI makes sure month one even gets that far **without the broker ever touching a terminal**
     (turning "hope their file matches our fixtures" into "their file loads, or the tool tells them how"). The
     browser inspect/map onboarding flow is documented in `docs/TRUSTLEDGER.md` › "In-browser onboarding:
     inspect & map a file that won't load"; the CLI `inspect`/`--map` escape hatch + widened aliases are
     documented in `docs/TRUSTLEDGER.md` › "Onboarding: inspect before you reconcile," and the schema, the
     `--prior-close`/`--emit-close` flow, the continuity check, and the worked month-1 → month-2 → break example
     in `docs/TRUSTLEDGER.md` › "Period-close continuity." A human must still actually engage the partners and
     run their files; no engine change is needed.
  Hosting, a SaaS subscription, pricing, and billing are likewise human steps. REVENUE INTEGRITY: income comes
  ONLY from selling this value to paying customers (a recurring subscription for a legally-forced monthly chore)
  — never a token/coin/sale/yield. The loop will keep the engine green and additive; it must NOT auto-resolve any
  of (1)–(3).

- **P-6 (2026-06-24) — TrustLedger DELIVERY & PRICING: issue signed licenses to paying customers + set the price.**
  *Status: needs-human; outward-facing/commercial — the loop only BUILDS + locally TESTS the license MECHANISM with
  ephemeral test keys; generating the real vendor key, issuing licenses to real customers, setting a price, and taking
  payment are human actions and MUST NOT be auto-executed.* EPIC-29 (T-29.1/T-29.2/T-29.3) ships the auto-buildable half:
  a signed, OFFLINE-verifiable `*.vhlicense.json` over the project's own attestation core, `vh trust license
  issue|verify`, and a real free-vs-paid gate on `vh trust reconcile` (multi-state policy + `--seal` require a valid
  license; the free tier — baseline reconcile + inspect + the web map UI — stays open) enforced identically in the CLI
  and the web door. That converts the engine into a product with a sellable tier and a one-command delivery handoff. The
  three NARROW, decision-ready human steps that turn that into income:
  1. **Generate the VENDOR keypair OFFLINE and publish/pin the vendor ADDRESS.** Create an ECDSA keypair OUTSIDE the loop
     (never a key the loop holds), keep the private key secret, and publish the public ADDRESS in the product docs / the
     customer's tool config so every customer's `vh trust license verify` / `reconcile --vendor <addr>` pins it. The loop
     NEVER provisions or stores this key; `vh trust license issue --key-env/--key-file` reads it at runtime,
     read-used-discarded.
     *SHARPENING (EPIC-49, no new human gate): instead of "publish the ADDRESS in a doc/slide a customer must trust out of
     band," PUBLISH a signed producer IDENTITY CARD with that SAME key — `vh identity publish --address <addr>
     --product-line trustledger --claim <...> --non-claim <...> (--key-env|--key-file) --out <p>` — so a recipient/cold
     prospect pins your vendorAddress ONCE (`vh identity verify --signer <addr>`) and reuses it across every later signed
     handoff; see [`docs/IDENTITY.md`](docs/IDENTITY.md). The card attests IDENTITY + the claim SET only — NOT packet truth,
     NOT a timestamp (P-3), NOT a legal opinion — and changes no key/price/partner step.*
  2. **Pick the PRICE and the free-vs-paid entitlement SPLIT.** Decide the monthly/annual subscription price and which
     entitlements (`multi_state_policy`, `seal`, `unlimited_reconcile`, …) belong to the paid tier vs the free trial. The
     mechanism enforces whatever split you choose; the loop must NOT set a price or decide the split.
  3. **Issue a signed license to each PAYING customer + wire hosting/billing.** On each sale, deliver the resulting
     `*.vhlicense.json`; renew on each billing period. Hosting (`vh trust serve` is a HUMAN deploy step) and Stripe/billing
     remain outward human steps. REVENUE INTEGRITY: the license is an ACCESS credential a paying customer receives for
     delivered software value — NOT a token/coin/NFT, NOT tradeable, NOT an appreciating asset; income is a subscription
     for value delivered, never resale of a credential. P-6 is DISTINCT from P-5 (the legal/CPA/per-state/design-partner
     gate, unchanged): P-5 governs whether the verdict is legally sellable; P-6 governs how a sale is delivered + priced.
     The loop ships ONLY the mechanism + ephemeral test keys; it must NOT execute any of (1)–(3).
     **UPDATE (2026-06-25, EPIC-37 — step (3) is now collapsed from "remember the right entitlements + compute the expiry +
     run a command BY HAND for every sale" to a deterministic, machine-driven FULFILLMENT pipeline a billing webhook can
     call):** EPIC-29 left a real per-sale hole — step (3) above made YOU re-derive `--entitlements <...> --expires <ISO>`
     for every customer, which is (a) error-prone (a typo grants the wrong tier; a hand-computed expiry drifts) and
     (b) un-automatable (a Stripe/Paddle "payment succeeded" event has a PLAN id and a PAID-THROUGH date, not a comma-list
     of entitlement flags), so self-serve revenue was impossible — every sale needed a human at a terminal. EPIC-37 ships
     the missing half: a versioned, strictly-validated **PLAN CATALOG** (`trustledger/plans.js` + signed JSON fixtures) that
     is the ONE machine-readable mapping `planId → {entitlements, term, displayName}` over the CLOSED `ENTITLEMENTS` table
     (an unknown entitlement or duplicate plan is a hard build error, never a silent mis-grant), a pure `fulfillOrder({plan,
     customer, paidThrough|term, issuedAt}, catalog)` that turns a normalized ORDER into the EXACT `buildLicensePayload`
     params (deterministic: same order + same catalog ⇒ byte-identical license fields), and **`vh trust license fulfill
     --plan <planId> --customer <name> --paid-through <ISO> --key-env <VAR>`** which reads the human-supplied vendor key
     (read-used-discarded, NEVER held by the loop), looks the plan up in the catalog, and emits the SAME signed
     `*.vhlicense.json` the existing `verify`/gate already accept — so a billing webhook's fulfillment handler is now ONE
     deterministic command with NO hand-authored entitlement list. **So step (3)'s human work collapses to EXACTLY: (1) fill
     in YOUR price/term per `planId` in the catalog (a data file, in a validated schema — see `docs/TRUSTLEDGER.md` ›
     "Plan catalog & fulfillment"); (2) point your billing provider's "payment succeeded / renewed" webhook at
     `vh trust license fulfill` (or call `fulfillOrder` in-process); DONE — the right license is minted + delivered with NO
     terminal step per sale.** The loop ships ONLY the catalog schema + the fulfillment mapping + ephemeral test keys; it
     NEVER sets a price, holds a real key, runs a payment processor, or takes a real payment — provisioning the vendor key
     (step 1), setting the price/term in the catalog (the value column), and wiring the actual webhook/billing remain
     human-owned outward steps. This SHARPENS P-6 step (3); it adds NO new human gate and does not relax (1)/(2) or P-5.

- **P-7 (2026-06-24) — Evidence-packet GO-TO-MARKET: open the SECOND vertical on a LIGHTER human gate (vendor
  keypair + price + one design partner).** *Status: needs-human; outward-facing/commercial — the loop only BUILDS +
  locally TESTS the mechanism with ephemeral test keys; generating the real evidence-product vendor key, setting the
  price + free-vs-paid split, and landing the first design partner are human actions and MUST NOT be auto-executed.*
  EPIC-30 / T-30.3 ships the auto-buildable half: `vh evidence seal <dir> [--out <p>]` + `vh evidence verify <p>`,
  a product-AGNOSTIC, tamper-evident `*.vhevidence.json` packet over the EXTRACTED shared cores (`cli/core/packetseal.js`
  for the seal, `cli/core/license.js` for the gate, `cli/core/attestation.js` for the signed wrap — no new crypto). It
  is the SECOND sellable VERTICAL on the provenance core, with its OWN distinct license product
  (`kind: vh-evidence-license`, a closed entitlement table separate from `trustledger-license`): the FREE tier (an
  unsigned baseline seal of up to 25 files + verify) stays open so a buyer can try before buying, and the PAID surface
  (the `--sign` signed-attestation wrap; sealing > 25 files) is gated OFFLINE behind a valid `--license <f> --vendor
  <addr>` with the SAME `verifyLicense`/named-reject posture as the TrustLedger CLI. The three NARROW, decision-ready
  human steps that turn that into income:
  1. **Generate the EVIDENCE-PRODUCT vendor keypair OFFLINE and pin the ADDRESS.** Create an ECDSA keypair OUTSIDE the
     loop (a SEPARATE key from the TrustLedger vendor key — distinct product, distinct entitlement table), keep the
     private key secret, and publish/pin the public ADDRESS so every customer's `vh evidence seal … --vendor <addr>`
     pins it. The loop NEVER provisions or holds this key; the issuance path reads a human-provisioned key at runtime,
     read-used-discarded.
     *SHARPENING (EPIC-49, no new human gate): instead of "publish the ADDRESS in a doc/slide a recipient must trust out of
     band," PUBLISH a signed producer IDENTITY CARD with that SAME evidence key — `vh identity publish --address <addr>
     --product-line evidence --claim <...> --non-claim <...> (--key-env|--key-file) --out <p>` — so a recipient/cold
     prospect pins your vendorAddress ONCE (`vh identity verify --signer <addr>`) and reuses it across every later
     `seal --sign` / `verify-signed` handoff; see [`docs/IDENTITY.md`](docs/IDENTITY.md). The card attests IDENTITY + the
     claim SET only — NOT packet truth, NOT a timestamp (P-3), NOT a legal opinion — and changes no key/price/partner step.*
     *SHARPENING (EPIC-51, no new human gate): when that evidence key is compromised/rotated/retired, RETIRE it honestly —
     `vh revocation publish --address <addr> --reason rotated (--key-env|--key-file) [--superseded-by <new>] --out <p>` mints a
     signed KEY REVOCATION recipients pass to any signed-verify via `--revocations <f>` `[--as-of <ISO>]`; see
     [`docs/KEY-LIFECYCLE.md`](docs/KEY-LIFECYCLE.md). The honest boundary (verbatim): a revocation is a SIGNED CLAIM by the
     key-holder (it proves the key-holder SAID "revoked as of D"); it is NOT a trusted wall-clock timestamp without P-3. It
     is strictly-OPTIONAL + non-loosening and changes no key/price/partner step.*
  2. **Pick the PRICE and the free-vs-paid SPLIT.** Decide the price (a per-seat/subscription or per-packet meter both
     fit — evidence is offline/no-network, so an on-prem license or a metered tier both work) and which entitlements
     (`evidence_signed`, `evidence_unlimited`, the free sample size) belong to the paid tier vs the free trial. The
     mechanism enforces whatever split you choose; the loop must NOT set a price or decide the split.
     *SHARPENING (EPIC-48, no new human gate): once you have set the price, `vh evidence license fulfill --plan <id>
     --customer <name> [--paid-through <ISO>] (--key-env|--key-file) [--out]` mints the per-sale license a billing
     webhook drives — one deterministic command over the DRAFT evidence plan catalog you priced (entitlements copied
     VERBATIM, no hand-authored flag list); see "Issue a license per sale" in [`docs/EVIDENCE.md`](docs/EVIDENCE.md).*
  3. **Land a B2B design partner via the existing provenance / P-4 channel — NOT the trust-accounting / P-5 channel.**
     The evidence buyer is whoever hands over folders of files where "this is the exact set, byte-for-byte unaltered"
     is contractually or evidentially expensive: incident-response / forensics teams, audit-workpaper / e-discovery
     shops, QA/release-artifact custodians, contract-exhibit packs, data hand-offs. Reach them through the SAME
     provenance/data-integrity channel as DataLedger/ProofParcel (P-4), NOT the broker/CPA/NARPM channel (P-5). One
     design partner running their real folders through `seal → hand over → verify` IS the WTP validation.
     *POINTER (T-52.3, no new gate): a security/procurement reviewer's first technical objection — "how do I know your
     verifier won't say ACCEPT on something it shouldn't?" — is pre-answered by the adversarial conformance corpus
     (`node challenge/corpus/run-corpus.js`); see [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md). Free, read-only, zero trust
     in us; it proves REJECT of every ENUMERATED tamper class, NOT the absence of unknown ones, and a REJECT is
     tamper-evidence NOT a trusted timestamp without P-3.*
  P-7 is **DISTINCT** from P-5 (TrustLedger legal/CPA/per-state/design-partner gate) and P-6 (TrustLedger license
  delivery + pricing): it opens a SECOND vertical on a **LIGHTER human gate** — there is no legal/CPA/per-state
  liability layer here (the evidence packet makes NO domain/compliance claim, only tamper-evidence + offline-recompute),
  so the only human steps are the vendor key, the price, and one design partner. Do NOT restate P-5/P-6; this is a
  separate product with its own key, its own entitlements, and its own buyer channel. REVENUE INTEGRITY: the license is
  an ACCESS credential a paying customer receives for delivered software value — NOT a token/coin/NFT, NOT tradeable,
  NOT an appreciating asset; income is a subscription/meter/license for value delivered. The loop ships ONLY the
  mechanism + ephemeral test keys; it must NOT execute any of (1)–(3).

- **P-8 (2026-06-24) — CONSOLIDATED GO-TO-MARKET ASK: land ONE design partner and run the pilot — the single human
  action that de-risks P-3, P-5, P-6, AND P-7 at once.** *Status: needs-human; outward-facing/commercial — the loop has
  BUILT and locally TESTED the entire deliverable (an OFFLINE, ephemeral-key pilot kit), but identifying a partner,
  provisioning a real key, setting a price, and running the pilot are human actions and MUST NOT be auto-executed.*
  EPIC-32 (T-32.1/T-32.2/T-32.3) ships the auto-buildable half in full: a single runnable artifact — `pilot/run-pilot.js`
  — that drives BOTH sellable buyer journeys (the **evidence packet** and the **TrustLedger reconciliation seal**) end to
  end against committed sample data, OFFLINE, with ephemeral `Wallet.createRandom()` keys only, proves the paid surface is
  REALLY licence-gated, hands the artifact to the INDEPENDENT `verify-vh` (ACCEPT), and TAMPERS to prove REJECT — all to
  ONE combined PASS/FAIL verdict — plus the buyer-facing runbook `docs/PILOT.md` and the operator quick reference
  `pilot/README.md`. This is the artifact every prior gate was waiting on. **Why this proposal exists.** Reading P-3, P-5,
  P-6, and P-7, the SAME precondition is buried in each: "land a B2B design partner / run a pilot." That shared human
  action was scattered across four proposals, so a human could not see that ONE pilot satisfies all four. P-8 folds it
  into one decision-ready ask without re-stating (or weakening) any of the four — it is a POINTER + a consolidated plan,
  not a re-sharpening.
  - **The single human decision.** Choose ONE design partner and run the pilot with them. The kit makes the technical
    risk ~zero (it already runs offline with no setup), so the human work is purely commercial/relational.
  - **The concrete steps (each links to the proposal that owns its detail — do NOT restate them here).**
    1. **Pick the vertical + the partner.** Evidence vertical → the provenance/data-integrity buyer channel (incident
       response, e-discovery, audit-workpaper, contract-exhibit, data hand-off) per **P-7 step 3** / **P-4**. TrustLedger
       vertical → the broker/CPA/NARPM channel per **P-5 #3**. Either (or both) reuses THIS one kit.
    2. **Provision the real trust-root** when (and only when) a signed/timestamped claim is in scope — the self-managed
       key, RFC-3161 TSA, or on-chain anchor of **P-3**. The kit deliberately uses throwaway keys; until a real key is
       provisioned, the honest boundary holds: tamper-evidence + signer-pin, **NOT a trusted "sealed at T."**
    3. **Set the price + the free-vs-paid split** for the chosen vertical — **P-6** (TrustLedger licence delivery/pricing)
       and/or **P-7 step 2** (evidence licence). The kit demonstrates the gate; it sets no price.
    4. **Run the pilot.** Hand the partner `docs/PILOT.md`; they run `node pilot/run-pilot.js`, then their REAL folder /
       statements through `seal`/`reconcile → hand over → verify-vh`. Their willingness to keep using it (and to pay) IS
       the WTP validation that P-5 #3 / P-7 #3 call for.
  - **Why ONE pilot de-risks ALL four gates.** P-3's trust-root, P-5's CPA-reviewed verdict + design-partner script,
    P-6's licence-delivery model, and P-7's evidence go-to-market all assume "a partner is running this." The kit makes
    that assumption cheap to satisfy: the partner sees the licence gate, the independent verifier, and the honest trust
    boundary in one offline run — so the human can have the trust-root / pricing / legal conversations against a WORKING
    artifact instead of a slide deck.
  - **The pilot→renewal conversion lever: the CI merge-gate (T-33.x).** The single biggest risk to a B2B pilot is that
    it stays a one-off demo and never renews. The concrete lever that converts a one-time pilot into a *renewing
    dependency* is the shipped CI merge-gate (`verifier/ci/verify-vh.generic.sh` + `verify-vh.github-actions.yml`, wired
    in per `docs/PILOT.md` §4): once the partner pastes those three lines into their own pipeline, **their build FAILS
    the day a sealed artifact no longer matches its bytes** — so checking the producer's seal becomes part of *their*
    release process, not a favour to us. This strengthens the existing ask without adding any new human gate: the human
    still only has to "run the pilot" (step 4 already hands them `docs/PILOT.md`); the runbook now simply ends at "and
    here is how it lives in your release process." Crucially the gate keeps the FREE-verify / PAID-seal split — the
    partner pays to *produce* seals (the licence surface), never to *check* them — so adoption of the free gate is
    exactly what makes the paid sealing surface sticky. This is a SHARPENING of the conversion mechanics, NOT a new
    `needs-human` item and NOT a change to P-3/P-5/P-6/P-7.
  - **What stays human / unchanged.** P-3, P-5, P-6, and P-7 remain EXACTLY as written — P-8 does not modify or relax
    them; it is the consolidated entry point that POINTS at them. The loop still NEVER provisions a real key, sets a
    price, contacts a partner, hosts, or takes payment. REVENUE INTEGRITY: income is a subscription/licence/meter for the
    delivered software value the kit demonstrates — the licence is an ACCESS credential, NOT a token/coin/NFT, NOT
    tradeable, NOT an appreciating asset. The loop ships ONLY the mechanism + the runnable kit + ephemeral test keys; it
    must NOT execute the design-partner pilot itself.
  - **SHARPENED (2026-06-25) — a MEASURABLE pilot-success contract, not a relational judgment.** The pilot's WTP step
    above ("Their willingness to keep using it (and to pay) IS the WTP validation") was the vaguest part of this ask —
    it left "did the pilot succeed?" to gut feel. Replace it with a CONCRETE, one-command, broker-specific success
    criterion the human can read in a minute, now backed by an auto-built instrument (EPIC-45, `vh trust value-proof`):
    1. **Pick ONE month the partner ALREADY closed manually** and signed off as clean (their last reconciled period).
       This is the highest-signal pilot input — it pits the gate against the process they pay for today.
    2. **Run that exact period through `vh trust value-proof`** (offline, on their own bank/book/rent-roll files). The
       command prints the COUNT and TOTAL DOLLAR IMPACT of every finding the manual close did not flag, partitioned by
       root-cause class — OR an explicit "clean confirmed" when the gate agrees with the manual close.
    3. **The success contract is now numeric, and EITHER outcome is a win to put in front of the human:** (a) the gate
       surfaces ≥1 out-of-trust ERROR the manual close missed → the dollar figure IS the WTP case ("this would have
       caught a \$X conversion before the auditor did"); OR (b) the gate confirms the month was clean → the partner now
       has a signed, independent, one-command proof of a clean trust account they can hand their auditor every month
       (the recurring-deliverable value of P-5 #3). Either way the human ends the pilot with a MEASURED result, not an
       impression.
    This SHARPENS step 4 of the concrete steps above without adding or relaxing any gate: the human action is still
    "run the pilot," but the runbook now ends at a quantified pass/fail the human reads to decide whether to keep
    selling. It is a POINTER to the EPIC-45 instrument, NOT a new mechanism and NOT a change to P-3/P-5/P-6/P-7.
  - **SHARPENED (2026-06-26) — a TIME-BOXED, SINGLE-FIRST-TARGET decision, because "land a design partner" has been
    the standing dam for ~20 runs and the loop cannot break it by building more mechanism.** The real friction is not
    the kit (it runs offline today) and not the product (both verticals are fully built + tested) — it is that this ask
    has never named ONE concrete first move a human can act on THIS WEEK. So, decision-ready:
    1. **Pick the LIGHTER-gated vertical FIRST: EVIDENCE (P-7), not TrustLedger (P-5).** Evidence has NO CPA/legal/
       per-state liability layer — its only human steps are a vendor key, a price, and one partner — so it converts to a
       paid pilot with the least blocking work. Do TrustLedger second, after the evidence motion is proven.
    2. **ONE concrete first target archetype + channel (pick one, this week): an incident-response / digital-forensics
       team OR an e-discovery / audit-workpaper shop** — buyers for whom "this is the exact file set, byte-for-byte
       unaltered, and here is who produced it" is contractually or evidentially expensive. Reach them through the
       provenance/data-integrity channel (P-4 / P-7 step 3), NOT the broker/CPA/NARPM channel.
    3. **The 3-step first contact (no slide deck):** (a) publish ONE producer identity card once the vendor key is
       provisioned — `vh identity publish` (EPIC-49) — so the prospect can pin WHO you are + exactly what the tool does/
       does-not attest. *POINTER (T-54.3, no new gate): the verifier they will run is itself reproducible-from-source —
       `node verifier/build-standalone.js --check` (offline) rebuilds the standalone bundle byte-for-byte from in-tree
       source the reviewer reads, so trust roots in source, not our hex ([`verifier/README.md`](verifier/README.md) §0b).*
       (b) hand the prospect the zero-install COLD-PROSPECT CHALLENGE (EPIC-50) — they verify a real
       sealed packet and tamper a byte themselves in 30 seconds, no install, no trust in us. *POINTER (T-54.3, no new
       gate): when their security team asks "but who verifies the verifier?", the answer is `--check` above — it proves
       the shipped bundle IS the audited source, NOT that the source's logic is correct and NOT a trusted timestamp
       without P-3 ([`verifier/README.md`](verifier/README.md) §0b; build attested by `test/verifier.reproduce.test.js`).*
       (c) if they lean in, run the
       offline pilot kit (`node pilot/run-pilot.js`) on THEIR own folder. *POINTER (T-52.3, no new gate): when their
       security team asks "how do I know your verifier won't ACCEPT what it shouldn't?", hand them the adversarial
       conformance corpus (`node challenge/corpus/run-corpus.js` → [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md)) — it
       proves REJECT of every ENUMERATED tamper class (NOT the absence of unknown ones; a REJECT is tamper-evidence NOT a
       trusted timestamp without P-3).* *POINTER (T-53.3, no new gate): the pilot now ends at a FORWARDABLE signed result,
       not just a terminal PASS — run it with `--certificate <path>` and the prospect hands their security/procurement team
       a tamper-evident `*.vhevidence.json` they verify independently via the zero-install `verify-vh-standalone.js`
       ([`docs/PILOT.md`](docs/PILOT.md) §3d); it is tamper-evidence over the run record, NOT a trusted "ran at time T"
       without P-3, NOT a legal verdict.*
    4. **A time box that forces a decision:** run this with 3–5 prospects over ~2 weeks. Success = ONE prospect who keeps
       using the free verify/challenge weekly (the leading indicator the renewal lever in this proposal depends on) OR
       one who agrees to a paid pilot. If zero after the time box, the signal is "wrong buyer archetype" → switch to the
       TrustLedger broker channel (P-5 #3), not "build more product."
    This SHARPENS the consolidated ask into a single first move without adding or relaxing any gate; it changes none of
    P-3/P-4/P-5/P-6/P-7 and adds NO new `needs-human` item. The loop still NEVER provisions a key, sets a price,
    contacts a prospect, or runs the pilot — those remain the human actions this proposal exists to make decision-ready.
  - **SHARPENED (2026-07-06) — the ask has COLLAPSED to first contact only (one page: `docs/DECISIONS-PENDING.md`).**
    Everything this proposal once waited on is DONE: price set (`pricing/evidence-plans.json`), vendor key provisioned
    OUTSIDE the loop + identity card ACCEPT, `verify-vh`/`verifyhash` published on npm, the mainnet registry live, the
    funnel repaired + security-audited (EPIC-73/74/75), and the verifier cross-checked in FOUR independent languages
    (EPIC-76/77). No key/price/legal step remains in front of the first prospect. The remaining human work is EXACTLY
    DECISIONS-PENDING §3: (a) publish `verifyhash@0.1.6` + anchor that release per the `anchors/release-*` flow;
    (b) show the standalone verifier page to ~10 people in ONE segment (recommended: AI-agent builders — the
    AGENTTRACE angle) and count twice-users into `docs/ADOPTION.json`. This relaxes nothing; every P-3/P-5/P-6/P-7
    boundary stands verbatim. **UPDATE (2026-07-06, later): (a) is DONE** — `verifyhash@0.1.7` (supersedes the
    planned 0.1.6) + `verify-vh@0.1.6` published and the release anchored author-bound on mainnet (reveal block
    89747859, commit 0f3eb7b). The ENTIRE remaining ask is (b), plus the ~10-minute P-11 refresh (`--diff` shows
    exactly one stale file: docs/INDEPENDENT-VERIFICATION.md).

- **P-9 (2026-07-01) — EMBEDDABLE SDK distribution + pricing: publish `verifyhash` as a library other developers embed,
  and price the embed/usage.** *Status: needs-human; outward-facing/commercial — the loop only BUILDS + locally TESTS
  the programmatic API surface (EPIC-57); publishing to a package registry, setting an embed/usage price, and any
  developer-relations motion are human actions and MUST NOT be auto-executed.* EPIC-57 ships the auto-buildable half: a
  stable, semver-guarded public API (`require("verifyhash")` → `index.js` + an `exports` map) that re-exports the
  already-built, already-tested provenance core (`verifySeal`/`buildSeal`/`serializeSeal`/`readSeal`/`validateSeal`,
  `diffManifest`, the keccak/Merkle `hashing` primitives) VERBATIM behind a pinned contract test, plus `docs/SDK.md` and a
  runnable consumer example. **UPDATE (2026-07-01, EPIC-58 / T-58.1): the SIGNED / vendor-address-pinned verify path is now
  ALSO re-exported** as a THIN identity re-export of the already-green, already-CLI-shipped functions — the `signed`
  namespace + flat convenience twins carry `signSealWith`, `validateSignedSeal`, `verifySignedSeal`,
  `verifySignedSealAttestation` (all from `cli/evidence.js`) and the generic `recoverSigner` / `verifySignedAttestation`
  (from `cli/core/attestation.js`), each the SAME object as its `cli/…` source. So `require("verifyhash")` can now verify a
  SIGNED, address-pinned packet **in-process** (byte-identical to `vh evidence verify-signed`) with NO shell-out — closing
  the gap where an embedder could verify unsigned tamper-evidence but had to shell out to the `vh` binary for the signed
  path. (This corrects the earlier overstatement here that EPIC-57 already re-exported the signed verifier: EPIC-57 shipped
  ONLY the unsigned path; T-58.1 is what actually shipped the signed symbols — doc now matches code.) That turns the engine
  — today usable ONLY by shelling out to the `vh` binary — into an embeddable component
  another program can call in-process, opening a distribution axis that needs NO design-partner pilot (`npm i verifyhash`
  + `require`, zero sales call). It is DISTINCT from P-1..P-8: those gate SELLING the CLI/verticals to a design partner;
  P-9 gates offering the CORE as a developer dependency. The NARROW, decision-ready human steps that turn it into income:
  1. **Decide whether/how to PUBLISH.** Publishing `verifyhash` to a public package registry (npm) is an outward action
     the loop must NEVER take. A human decides: publish publicly (organic developer adoption of the free verify path,
     which PULLS the paid seal), publish privately/scoped for licensed embedders, or keep it in-repo. The loop keeps the
     API green + contract-pinned; it never runs `npm publish`.
  2. **Pick the embed/usage PRICE + the free-vs-licensed SPLIT.** The free VERIFY surface (import + `verifySeal`/`diffManifest`)
     is the organic funnel and should stay open; a paid embed/usage tier (e.g. commercial embedding of the PRODUCE/sign
     surface into another vendor's product, or a usage meter) is the revenue. The loop sets NO price and decides NO split —
     it only ships the mechanism the chosen split would gate.
  3. **Offer + support the SDK to embedders.** Any commercial embed agreement, support SLA, or dev-rel motion is a human
     step. REVENUE INTEGRITY: the SDK/embed offering is a license/usage fee for delivered SOFTWARE a developer integrates —
     NOT a token/coin/NFT, NOT tradeable, NOT an appreciating asset; income is a fee for value delivered, never resale of an
     appreciating credential. The loop ships ONLY the API surface + contract tests + a runnable example; it must NOT execute
     any of (1)–(3), publish, price, or contact anyone.

  **Verify-service sub-note (2026-07-01, EPIC-59 / T-59.3).** The SDK now also ships a distinct *consumption shape*: the
  `vh serve-verify` HTTP endpoint (T-59.2) — the "CI plugin that IMPORTS rather than shells out" — with a dependency-free
  client (`examples/verify-service-client.js`), a generic + GitHub-Actions CI recipe that FAILS the build on a bad seal
  (`verifier/ci/verify-service.generic.sh` / `.github-actions.yml`), and `docs/VERIFY-SERVICE.md`. This is delivered SOFTWARE
  a CI system / another microservice runs in THEIR pipeline (POST a seal, gate on ACCEPT/REJECT) — the SAME license/usage-fee
  revenue model as the embed above, NOT a token/coin/NFT and NOT tradeable. It is verify-ONLY (never signs, holds no key,
  writes nothing) and binds LOOPBACK by default; publishing, pricing, hosting, and any PUBLIC deploy remain the SAME
  human-owned P-9 steps (1)–(3) above — this sub-note adds NO new gate and RELAXES none. The loop only BUILDS + locally TESTS
  with ephemeral keys and a loopback socket; it NEVER exposes a public port.

  **Integrity-journal sub-note (2026-07-01, EPIC-60 / T-60.3).** The SDK now also ships a distinct *consumption
  shape over TIME*: the `vh journal` append-only, hash-chained integrity journal (the "verified CONTINUOUSLY from
  run A to run B" artifact a one-shot verify cannot produce) — with a dependency-free runnable CI step
  (`examples/journal-ci.js`), a generic + GitHub-Actions continuous-integrity gate that FAILS the build on a broken
  chain or a recorded drift (`verifier/ci/journal.generic.sh` / `.github-actions.yml`), and
  `docs/INTEGRITY-JOURNAL.md`. This is delivered SOFTWARE a CI system / another microservice runs in THEIR pipeline
  (append this build's verdict, gate on an unbroken chain) — the SAME license/usage-fee revenue model as the embed
  and the verify-service above, NOT a token/coin/NFT and NOT tradeable. It is verify-ONLY via the EXISTING composed
  cores VERBATIM (never signs, holds no key, invents no crypto/verdict vocabulary), adds NO runtime dependency and NO
  network (append/verify are pure-local file ops), and reuses the SHARED 0/3 verify exit contract. HONESTY BOUNDARY:
  the wall-clock `ts` on each entry is SELF-ASSERTED (the verifier's own clock), NOT a trusted timestamp — the journal
  proves ORDERING + CONTINUITY of its OWN observations and NEVER claims "unaltered since date T" on its own; making
  that claim requires signing/timestamping the `ts` with a trust-root, which stays the human-owned **P-3** step
  (a self-managed key / RFC-3161 TSA / on-chain anchor — the loop NEVER provisions a key). Publishing, pricing, and
  any PUBLIC deploy remain the SAME human-owned **P-9** steps (1)–(3) above; this sub-note adds NO new gate and
  RELAXES none of P-9's or P-3's human steps.

- **P-10 (2026-07-01) — TRANSPARENCY-LOG distribution: a materially LOWER-gated go-to-market than the design-partner pilot —
  run a public-good append-only log + sell enterprise WITNESS / MONITOR SLAs.** *Status: needs-human; outward-facing/deploy/
  commercial — the loop BUILDS + locally TESTS the log, witness co-signing, and the split-view detector with ephemeral keys
  and pure-local files (EPIC-60/63/64); standing up a hosted log, running/hosting independent witnesses, publishing a
  checkpoint/gossip feed, setting a price, and taking payment are HUMAN actions and MUST NOT be auto-executed.* EPIC-64 ships
  the last technical piece that makes an OPERATOR-UNTRUSTED transparency log real: witnesses co-sign tree heads only after
  proving append-only consistency, and `vh journal detect-split` turns any two operator-signed, mutually-inconsistent heads
  into a non-repudiable fraud proof — the exact architecture Certificate-Transparency, Sigstore/Rekor, and the Go checksum
  database run. It opens a distribution shape that does NOT require the ~20-run-stuck design-partner pilot (P-8): a
  **public-good log anyone appends-and-audits for free** (organic adoption, the free funnel) with **paid enterprise tiers**
  for what businesses need operationally — hosted/SLA'd witness co-signing, a monitored checkpoint/gossip feed, and
  provenance-over-time evidence packets for SOC2 / supply-chain / EU-AI-Act audits (the public-good→enterprise motion Sigstore
  uses). The NARROW, decision-ready human steps: (1) **decide whether to run a hosted log at all** (a deploy/hosting decision
  the loop must NEVER take — local only); if yes, stand up the append-only endpoint and publish periodic signed tree heads.
  (2) **run (or recruit) ≥1 INDEPENDENT witness** — the value depends on witnesses being operationally independent of the
  operator; a human decides who runs them and co-signs with a real, human-provisioned key (the loop never holds it).
  (3) **publish a checkpoint/gossip feed** so auditors can compare heads and `detect-split` can fire — detection only works if
  checkpoints are actually distributed. (4) **pick the price + free-vs-paid split** (free append/verify/audit; paid
  witness-SLA / monitoring / evidence-packet tiers). REVENUE INTEGRITY: income is a subscription/SLA/usage fee for delivered
  operational software value (running witnesses, monitoring, audit evidence) — NOT a token/coin/NFT, NOT tradeable, NOT an
  appreciating asset. The loop ships ONLY the mechanism + ephemeral test keys + pure-local proofs; it must NOT deploy a log,
  host a witness, publish a feed, set a price, or take payment. P-10 is DISTINCT from P-1..P-9 and changes none of them.

- **P-11 (2026-07-02) — REFRESH the live verifyhash.com publish set (a ~10-minute recurring human action; deploy-gated).**
  *Status: needs-human; touching the live webroot is a deploy the loop must NEVER take — it only assembles and diffs
  INSIDE the repo.* The live site (deployed 2026-06-26 per `docs/DEPLOY-PUBLIC-SITE.md`) serves a PINNED copy of the
  verifier artifacts and the repo's builds have since moved — the funnel serves stale bytes and until EPIC-67 lands
  nothing mechanical says so. Once EPIC-67 ships, the refresh collapses to exactly:
  (1) `node scripts/site-release.js --diff` — read the per-file table of what the live site is missing (a signal, not
  a gate); (2) `node scripts/site-release.js`, then upload the assembled `public/` webroot to
  `/var/www/verifyhash.com/html` per the REPLACE-mode runbook (allowlist-only assembly keeps the "must NEVER be served"
  rule structural); (3) `--mark-deployed` + commit `site/DEPLOYED.json` so the next `--diff` is truthful. Cadence: whenever `--diff` shows drift — and as soon as EPIC-66's
  `verify-vh-standalone.html` lands: that page turns the site into the 60-second in-browser tamper challenge P-8's
  first contact can send as ONE LINK, the cheapest funnel-multiplier available. BOUNDARY: the site stays static/
  read-only (no backend, API, key, or payment); the loop NEVER uploads, edits nginx, or touches `/var/www` — the upload
  and any vhost change are yours alone. REVENUE INTEGRITY: the site sells delivered software value (free verify funnel
  → paid seal/license per P-6/P-7); no token/coin/NFT. P-11 changes none of P-1..P-10.

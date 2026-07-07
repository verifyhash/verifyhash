# verifyhash — Backlog (single source of truth for the build loop)

The Planner reads this file; the driver picks the next **READY** task; the Integrator updates
statuses here after the Verifier passes. This file *is* the team's memory between runs.

**Status legend:** `TODO` · `IN-PROGRESS` · `VERIFIED` (tests green + independently checked) ·
`BLOCKED` (needs a human decision — never auto-built) · `DONE` (shipped/deployed).

A task is **READY** when: status is `TODO`, all `deps` are `VERIFIED`/`DONE`, and it is not tagged
`needs-decision`.

---

## Decisions needed (block downstream work — humans only)

- **D-1 — Attribution model.** RESOLVED 2026-06-23 → **commit–reveal** (see `STRATEGY.md` ›
  Decisions, and T-0.3 below). One-shot `anchor()` stays as a documented, front-runnable
  existence-proof path (`authorBound = false`); the new `commit()` + `reveal()` path gives a
  front-running-resistant authorship claim (`authorBound = true`). Per-author namespacing and
  accept-and-document were rejected (rationale in STRATEGY.md). Unblocks EPIC-3.
- **D-2 — Token framing.** RESOLVED 2026-07-05 → **Option A: non-transferable, soulbound
  reputation-only** (see `STRATEGY.md` › Decisions). The project owner accepted the recommended
  default from `docs/DECISIONS-PENDING.md` #1 (relayed via the supervisor with explicit user
  direction): zero securities exposure, matches the "decentralized contribution org" goal, thin
  additive layer over the EPIC-12 substrate. Tradeable-token (Option B) is REJECTED — the standing
  no-token/coin-for-revenue guardrail stays. Unblocks EPIC-3 (T-3.1 design, T-3.2 `ReputationSBT`);
  any on-chain DEPLOY of the resulting contract remains a separate human-gated step (P-2 pattern).

---

## EPIC-0 — Harden registry  *(seeded by the security audit; populated when it lands)*

- **T-0.0** `DONE` Triaged audit wmkm6kzoj (10 confirmed) into T-0.1..T-0.4 below; full record in `docs/AUDIT.md`.

- **T-0.1** `VERIFIED` Domain-separate Merkle leaves from internal nodes (verifyLeaf + CLI). deps: none. files: contracts/ContributionRegistry.sol, cli/hash.js, test/
  - Acceptance: leaves are domain-separated so a crafted internal node can NOT be verified as a leaf (double-hash
    leaves per OZ, or tag the hash); cli/hash.js and the JS Merkle helper in tests use the identical convention; a
    test builds a second-preimage forgery attempt and asserts verifyLeaf rejects it; full suite green. *(F15/F11/F13)*
- **T-0.2** `VERIFIED` Bind file paths into repo Merkle leaves. deps: T-0.1. files: cli/hash.js, test/
  - Acceptance: dir leaf = keccak256(domainPrefix ‖ relPath ‖ 0x00 ‖ keccak256(content)); root commits to
    names+content so renaming a file changes the root; docs state what the root commits to; a test proves a rename
    is detected; suite green. *(C2)*
- **T-0.3** `VERIFIED` Resolve attribution front-running via **commit–reveal** (decision D-1, chosen 2026-06-23). deps: none. files: contracts/ContributionRegistry.sol, cli/claim.js, cli/vh.js, cli/verify.js, test/Attribution.test.js, test/cli.claim.test.js
  - Acceptance (concrete, for the chosen scheme):
    1. Contract adds `commit(bytes32 commitment)` and `reveal(bytes32 contentHash, bytes32 salt, string uri)` where
       `commitment = keccak256(abi.encode(contentHash, msg.sender, salt))` (exposed as pure `commitmentOf`), with a
       `MIN_REVEAL_DELAY` maturation window before a reveal is accepted.
    2. `Record` carries `authorBound`: `true` for commit–reveal records (proven first claimant), `false` for one-shot
       `anchor()` (first-anchorer only). One-shot `anchor()` is retained but NatSpec-documented as front-runnable.
    3. A contract test proves a front-runner who copies the revealed `(contentHash, salt)` from the mempool CANNOT
       become the recorded author (their recomputed commitment was never registered → `NoSuchCommitment` revert), and
       a live-node CLI test proves the same end-to-end via `runClaim`/`buildRevealTx`.
    4. CLI exposes `vh claim <path>` (commit–reveal, `--dry-run`/`--salt`/`--uri`) and `vh verify` reports the
       attribution strength (`authorBound`). README + `docs/TRUST-BOUNDARIES.md` + NatSpec updated.
    5. Full suite green. *(F4/F14/F2/F5)*
- **T-0.4** `VERIFIED` Document trust boundaries: uri + timestamp. deps: none. files: contracts/ (NatSpec), README/docs
  - Acceptance: NatSpec + docs state plainly that uri is an untrusted hint (consumers re-derive + re-hash) and that
    timestamp/blockNumber prove on-chain ordering + an upper bound on existence time, NOT authorship time. *(F17/C3)*

## EPIC-1 — verifyhash CLI  *(the actual usable tool)*

- **T-1.1** `VERIFIED` `vh hash <path>` — content hashing. deps: none. files: cli/, test/cli.hash.test.js
  - Acceptance: keccak256 of a single file is deterministic and matches on-chain `keccak256`;
    for a directory, produces a stable sorted-leaf Merkle root identical to the contract's
    `verifyLeaf` convention; unit tests cover file, empty file, and 3-file dir; `hardhat test` green.
- **T-1.2** `VERIFIED` `vh anchor <path> [--uri]` — submit. deps: T-1.1. files: cli/, test/
  - Acceptance: builds the hash, calls `anchor()`; has a `--dry-run` that needs no key and prints the
    tx it *would* send; integration test runs against a local hardhat node and asserts the `Anchored`
    event; refuses to run on a non-testnet chainId without `--i-understand-mainnet`.
- **T-1.3** `VERIFIED` `vh verify <path>` — tamper check. deps: T-1.1. files: cli/, test/
  - Acceptance: recomputes the hash, reads `getRecord`, prints match / contributor / timestamp;
    test proves a one-byte edit to the file flips the result to MISMATCH.

## EPIC-2 — Repo-level Merkle anchoring

- **T-2.1** `VERIFIED` `vh prove <file>` over a repo root. deps: T-1.1. files: cli/, test/
  - Acceptance: anchors a directory's Merkle root, generates a per-file proof, and the on-chain
    `verifyLeaf` accepts it; tampering any file makes its proof fail. End-to-end test on local node.

## EPIC-6 — Durable, portable receipts  *(make the flagship flows operable, not just demonstrable)*

*Motivation (Strategist 2026-06-23): the contract + CLI are correct and tested (113 green), but two
real-world operability holes block actual use. (a) `vh claim` runs commit AND reveal in one process,
holding the secret salt only in memory while it waits out `MIN_REVEAL_DELAY`. On a live testnet that
wait is minutes; if the process dies, the salt is gone forever — the contentHash is now committed but
unrevealable by anyone, partially burning it, and attribution is permanently lost. There is no way to
resume. (b) `vh verify <dir>` only reports MATCH/MISMATCH on the Merkle root; for a repo of many files
it cannot say WHICH file changed, even though `vh hash` already computes every per-file leaf. Both are
fixed by persisting a small receipt artifact at write time and teaching the read commands to consume
it. No funds/deploy/token decisions involved — purely local, test-gated DX + correctness work.*

- **T-6.1** `VERIFIED` Make commit–reveal resumable: split `vh claim` into persisted `commit` + `reveal`.
  deps: T-0.3 (VERIFIED). files: cli/claim.js, cli/vh.js, cli/receipt.js (new), test/cli.claim.test.js,
  test/cli.receipt.test.js (new)
  - Problem: `runClaim` keeps the salt in memory across the inter-block wait; a crash between commit and
    reveal loses the salt irrecoverably (contentHash committed-but-unrevealable, attribution burned).
  - Acceptance:
    1. A new `cli/receipt.js` defines a versioned, JSON claim-receipt schema and pure
       `writeReceipt(obj, path)` / `readReceipt(path)` with strict validation (rejects wrong
       `schemaVersion`, missing `salt`/`commitment`/`contentHash`/`committer`/`contractAddress`/
       `chainId`, or a malformed hex field) — never silently accepts a partial/corrupt receipt.
    2. `runClaim` gains a two-phase mode: a commit phase that, on a successful `commit()` tx, writes the
       receipt (contentHash, committer, salt, commitment, uri, contractAddress, chainId, commit tx hash,
       commit blockNumber, MIN_REVEAL_DELAY) to a `--receipt <path>` file (default
       `./<contentHashPrefix>.vhclaim.json`) BEFORE it ever waits/returns; and a `reveal` phase
       (`runReveal`) that loads a receipt and submits `reveal()` once the window has matured. The
       legacy single-call `runClaim` (both legs in one process, used by the existing e2e test) keeps
       working unchanged.
    3. CLI: `vh commit <path> [--receipt p] [--salt] [--uri]` writes the receipt + commits;
       `vh reveal --receipt <path>` resumes and reveals. `vh claim <path>` stays as the one-shot
       convenience that does both and also writes the receipt. Usage text + README updated. Flag typos
       still hard-error (parser parity with existing commands).
    4. Tests: round-trip + validation-rejection unit tests for receipt.js; a live-hardhat-node test that
       runs `commit` (asserts the receipt file exists with the right salt/commitment), then in a SEPARATE
       call `runReveal` from only that file (simulating a fresh process) and asserts the Revealed event
       names the original committer with authorBound=true; a test that a reveal attempted before the
       window matures fails with the contract's RevealTooSoon and the receipt is left intact for retry.
    5. Full suite green; `npx hardhat test` unchanged.
- **T-6.2** `VERIFIED` Anchor/claim receipts for directories + per-file `vh verify --receipt`.
  deps: T-6.1, T-0.2 (VERIFIED). files: cli/receipt.js, cli/anchor.js, cli/verify.js, cli/vh.js,
  test/cli.verify.test.js, test/cli.receipt.test.js
  - Problem: `vh verify <dir>` only says MATCH/MISMATCH on the root; it cannot point at the changed file.
    The per-file leaves are computed at hash time but thrown away, so there is no local manifest to diff.
  - Acceptance:
    1. Extend the receipt schema (same versioned file, additive — bump `schemaVersion` and keep a reader
       that accepts both) with an optional `manifest`: the sorted list of `{ path, contentHash, leaf }`
       for a directory anchor (exactly what `vh hash <dir>` already produces). `vh anchor <dir>
       --receipt <p>` and the commit/claim receipts for a directory record this manifest.
    2. `vh verify <path> --receipt <p>` (read-only, no key) for a directory: recompute the current
       per-file leaves, compare against the receipt manifest, and print a precise diff — files
       ADDED / REMOVED / CHANGED (old→new contentHash) — in addition to the overall root
       MATCH/MISMATCH. Without `--receipt`, behaviour is exactly today's root-only check (no regression).
    3. The receipt is treated as an UNTRUSTED convenience hint, consistent with docs/TRUST-BOUNDARIES.md:
       verify still re-derives the root and the authoritative MATCH/MISMATCH comes from comparing the
       recomputed root to the on-chain record — the manifest only localizes *which* file diverged. This
       caveat is stated in the verify output and in the receipt NatSpec/docs.
    4. Tests: anchoring a 3-file dir writes a manifest; editing one file makes `vh verify --receipt`
       report exactly that file as CHANGED (and still MISMATCH overall); adding/removing a file is
       reported as ADDED/REMOVED; a receipt for a different repo is rejected or reported as fully
       divergent rather than silently mislabeling. Suite green.
- **T-6.3** `VERIFIED` Document the receipt format + lifecycle. deps: T-6.1, T-6.2. files:
  docs/RECEIPTS.md (new), README.md, test/ (a docs-rot guard if cheap)
  - Acceptance: `docs/RECEIPTS.md` specifies the JSON schema (every field, which are trusted vs hints),
    the commit→reveal resume lifecycle, the directory-manifest diff semantics, and a worked example;
    README links it next to TRUST-BOUNDARIES/MERKLE-LEAVES. Reuses wording from the contract NatSpec so
    the trust caveats stay consistent. No new runtime behaviour; pure documentation of T-6.1/T-6.2.

## EPIC-7 — Registry read side: discovery + audit  *(make the registry browsable, not just appendable)*

*Motivation (Strategist 2026-06-23): the write/verify single-item loop is complete and green (170
tests). But the registry has no READ side beyond "tell me about this one hash I already hold the bytes
for." The contract exposes `total`, `hashAtIndex(i)`, `getRecord(hash)` and indexed `Anchored`/`Revealed`
events, yet there is NO CLI to enumerate, browse, or audit what has been anchored, and no way for a
third party who holds only a `contentHash` (from a receipt, a published claim, an event) to ask the
chain what it says about that hash without re-deriving it from local content. A registry you can only
append to and verify one-known-item-at-a-time is half a product: discovery, audit, and "look it up by
hash" are exactly what makes an immutable public ledger useful to anyone other than the writer. All
three tasks are pure-local, test-gated, no funds/deploy/token decisions — they reuse the existing
ownerless contract and CLI patterns. Read commands need only an RPC URL: no key, no funds.*

- **T-7.1** `VERIFIED` Add bounded, paginated read views to the contract: `getRecordAtIndex(uint256)` and
  `getRecords(uint256 start, uint256 count)`. deps: none. files: contracts/ContributionRegistry.sol,
  test/ContributionRegistry.test.js (or a new test/Enumeration.test.js)
  - Problem: enumerating the registry off-chain today costs 2·N RPC round-trips (`hashAtIndex` then
    `getRecord` per index). A batched, bounded view makes `vh list` one call per page and keeps the
    contract's "no unbounded loop / no gas-DoS" property intact.
  - Acceptance:
    1. `getRecordAtIndex(uint256 index)` returns `(bytes32 contentHash, Record record)`; reverts with
       the existing `IndexOutOfRange(index, total)` when `index >= total` (reuse, do not add a new error).
    2. `getRecords(uint256 start, uint256 count)` returns a `bytes32[] contentHashes` and a
       `Record[] records` (parallel arrays) for indices `[start, start+count)`, CLAMPED to `total` so
       `start >= total` returns empty arrays and an over-long `count` returns only what exists (never
       reverts on an out-of-range tail — pagination must be forgiving). The loop is bounded by the
       caller-supplied `count`, preserving "no function loops over an unbounded set"; document that the
       caller is responsible for choosing a sane page size (these are view/`eth_call` reads, not gas-paid).
    3. Both are `view`, ownerless, and add NO state and NO write path — purely additive reads over the
       existing `_records`/`_hashByIndex`. NatSpec carries the same TRUST BOUNDARIES caveats (uri
       untrusted, timestamp = existence upper bound + ordering not authorship, authorBound semantics).
    4. Tests: anchoring/​revealing a known sequence then reading it back by index and by page reproduces
       the exact records in insertion order; `getRecordAtIndex(total)` reverts `IndexOutOfRange`;
       `getRecords` clamps a `start`/`count` past `total` to empty/partial without reverting; an
       `authorBound=true` (reveal) record and an `authorBound=false` (anchor) record are distinguished
       in the read-back. Full suite green; `npx hardhat test` unchanged.
- **T-7.2** `VERIFIED` `vh list` — enumerate the registry read-only (discovery + audit). deps: T-7.1.
  files: cli/list.js (new), cli/vh.js, test/cli.list.test.js (new)
  - Problem: there is no way to see WHAT has been anchored. A registry needs a browse/audit command.
  - Acceptance:
    1. `vh list [--contract a] [--rpc u]` reads `total` and pages through `getRecords` printing, per
       record: index, contentHash, contributor, attribution strength (authorBound → "proven first
       claimant (commit-reveal)" vs "first anchorer only — NOT authorship", reusing verify.js wording),
       timestamp (+ISO), blockNumber, uri (or "(none)"). Read-only: provider only, NEVER a signer/key.
    2. Filters (all client-side over the paged read, all optional, combinable): `--contributor <addr>`
       (only that address's records), `--author-bound` (only commit-reveal/authorBound records),
       `--limit <n>` / `--offset <n>` (page window), and `--json` (emit a machine-readable JSON array
       instead of the human block, for piping/CI). Empty registry prints a clear "no records" line (and
       `[]` under `--json`). Unknown/incomplete flags hard-error with usage (parser parity with the
       existing commands — a typo never silently returns a wrong/empty list).
    3. Each human-output run leads with the one-line trust caveat (uri untrusted; contributor meaning
       depends on authorBound) consistent with docs/TRUST-BOUNDARIES.md, so a browser of the list does
       not over-trust `uri`/`contributor`.
    4. Tests (live hardhat node): anchor 2 one-shot + claim 1 commit-reveal, then `vh list` returns all
       3 in insertion order with the right authorBound per record; `--contributor` filters to a single
       signer's records; `--author-bound` returns only the revealed one; `--json` parses and carries the
       same fields; `--limit/--offset` page correctly; an empty registry yields the "no records" path.
       Suite green.
- **T-7.3** `VERIFIED` `vh show <0xhash>` — look up one record by content hash, no local content needed.
  deps: T-7.1. files: cli/show.js (new) (or fold into cli/verify.js), cli/vh.js, test/cli.show.test.js (new)
  - Problem: `vh verify <path>` requires the bytes. A third party holding only a `contentHash` (from a
    receipt, a published claim, or an `Anchored` event) cannot ask the chain "what do you say about this
    hash?" without re-deriving it from content they may not have.
  - Acceptance:
    1. `vh show <0xhash> [--contract a] [--rpc u] [--json]` validates the arg is a 32-byte hex hash,
       calls `getRecord`, and prints the record (contributor, attribution strength, timestamp+ISO,
       blockNumber, uri) — or a clear "NOT ANCHORED" line (exit non-zero) when the hash has no record,
       distinguishing NotAnchored from a genuine RPC error exactly as `verify.js` already does (reuse
       `isNotAnchoredError`). Read-only: provider only, no key.
    2. Output leads with the trust caveat and spells out that `show` proves only that THIS exact hash is
       on-chain — it does NOT re-derive content, so the caller must still `vh verify <path>` to bind a
       record to real bytes (cross-link the two commands in the output and usage). A malformed/short hash
       hard-errors with usage before any network call.
    3. Tests (live hardhat node): anchor a known hash then `vh show <thatHash>` reports MATCH/record
       fields; `vh show <unanchoredHash>` reports NOT ANCHORED with a non-zero exit; `--json` round-trips;
       a malformed hash errors without hitting the network; an authorBound reveal vs a plain anchor are
       distinguished. Suite green.
- **T-7.4** `VERIFIED` Document the read side + cross-link it. deps: T-7.2, T-7.3. files: README.md,
  docs/TRUST-BOUNDARIES.md (a short "reading the registry" note), test/ (a cheap docs-rot guard if one
  already exists to extend)
  - Acceptance: README's CLI block lists `vh list` and `vh show` with one-line descriptions and the
    "read-only, no key" property; a short README/docs section explains discovery/audit and reiterates
    that listing/showing a record does NOT validate content (you still re-derive + `vh verify`). Reuses
    the existing TRUST-BOUNDARIES wording so caveats stay consistent. No new runtime behaviour.

## EPIC-8 — Git-scoped, reproducible anchoring  *(make the tool actually fit "code contributions")*

*Motivation (Strategist 2026-06-23): the write/verify/read loop is complete and green (250 passing), but
there is a foundational mismatch between what the tool DOES and what it is FOR. The project anchors a
"registry of code contributions," yet `vh hash <dir>` (cli/hash.js › `listFiles`) walks the raw
filesystem with NO exclusions: it hashes `.git/`, `node_modules/`, build artifacts, `.env`, editor
junk — everything. Three concrete consequences, all buildable with no human decision:*
  1. *Not reproducible across clones. Two people anchoring "the same commit" get DIFFERENT roots because
     of untracked files, local build output, `.git` internals, and OS/line-ending/permission drift. A
     verifier who clones the repo cannot re-derive the anchored root — which guts the core promise that
     "anyone can later prove some content is what was anchored."*
  2. *No git-commit binding. The natural unit of a code contribution is a git tree/commit, but you can't
     anchor "repo at commit abc123" in a way a third party can reproduce — you can only hash whatever
     happens to be on disk right now.*
  3. *Anchoring secrets/junk. Silently hashing `.env`, secrets, and `node_modules` is a privacy footgun
     AND the chief source of non-determinism. A code-contribution registry must anchor exactly the
     tracked source, deterministically.*
*The fix is a git-scoped hashing mode that enumerates only the files git tracks at a chosen commit (via
`git ls-tree`/`git ls-files`), reusing the EXISTING path-bound, sorted-leaf Merkle machinery unchanged
(same DIR_LEAF_DOMAIN/LEAF_TAG/NODE_TAG, same on-chain `verifyLeaf`). The root is then byte-identical
for anyone who checks out the same commit — that is what makes anchoring a real contribution useful.
Pure-local, test-gated, no funds/deploy/token decisions. `git` is already on PATH (2.34.1).*

- **T-8.1** `VERIFIED` Git-scoped enumeration in `vh hash`: hash exactly the files git tracks. deps: T-0.2
  (VERIFIED), T-1.1 (VERIFIED). files: cli/git.js (new), cli/hash.js, cli/vh.js, test/cli.hash.git.test.js (new)
  - Problem: `listFiles` walks the whole filesystem tree; a code-contribution registry must hash only the
    tracked source so the root is reproducible from a clone and never anchors `.git`/secrets/junk.
  - Acceptance:
    1. A new `cli/git.js` exposes pure helpers over `git` (run via `child_process` with `cwd` = the repo,
       NEVER a shell string built from user input — pass argv arrays): `repoRoot(dir)` (resolve the repo
       top-level, error clearly if `dir` is not in a git work tree), `resolveCommit(dir, ref)` (resolve a
       ref/`HEAD` to a full 40-hex commit oid, error on an unknown ref), and `listTrackedFiles(dir, ref)`
       returning the sorted list of repo-relative POSIX paths that git tracks at that commit
       (`git ls-tree -r --name-only <oid>`), with deterministic handling of paths containing special
       characters (use `-z` NUL-delimited output, not the default quoted/newline form).
    2. `vh hash <path> --git [--ref <ref>]` hashes ONLY those tracked files: read each tracked file's
       bytes at the working tree (default) and feed them through the EXISTING `pathLeaf`/`buildTree`/
       `leafHash`/`nodeHash` path so the directory root is computed by the identical convention the
       contract's `verifyLeaf` accepts (no contract change, no new leaf scheme). The relPath bound into
       each leaf is the git path. Without `--git`, behaviour is exactly today's filesystem walk (no
       regression to any existing hash/anchor/verify/prove test).
    3. The `--git` root is REPRODUCIBLE: a test creates a temp git repo, commits a known set of files,
       drops untracked junk (`node_modules/x`, `.env`, an unstaged scratch file) into the work tree, and
       asserts the `--git` root is unchanged by that junk and is byte-identical to a root computed from a
       second fresh checkout of the same files — whereas the plain (non-git) root DIFFERS because it
       includes the junk. Renaming a tracked file still changes the `--git` root (path-bound leaves).
    4. Failure modes are explicit: `--git` on a non-git directory errors clearly (no silent fallback to
       the filesystem walk); `--ref` with an unknown ref errors; a `--git` run on a repo with zero
       tracked files errors (cannot build a tree from zero leaves) with an actionable message. `--ref`
       without `--git` is a flag error (parser parity with existing commands).
    5. Tests: round-trip + failure-mode unit tests for `cli/git.js` against temp repos; the reproducibility
       test above; a test that the `--git` root equals a manual hash of just-the-tracked-files via the
       existing dir-hash path (proving it reuses the same Merkle convention). Full suite green; the leaf
       formula in docs/MERKLE-LEAVES.md is unchanged and still applies.
- **T-8.2** `VERIFIED` Carry the git provenance (repo-relative scope + commit oid) into anchor/claim receipts
  and `vh verify --git`. deps: T-8.1, T-6.2 (VERIFIED). files: cli/git.js, cli/receipt.js, cli/anchor.js,
  cli/claim.js, cli/verify.js, cli/vh.js, test/cli.verify.git.test.js (new), test/cli.receipt.test.js
  - Problem: once a root is git-scoped it must round-trip: anchoring/claiming a `--git` root should record
    WHICH commit it scoped (so a later verifier re-derives the same root deterministically), and
    `vh verify --git` should reproduce the tracked-file set instead of walking the filesystem.
  - Acceptance:
    1. Extend the receipt schema additively (same versioned file as T-6.1/T-6.2; bump `schemaVersion`,
       keep a reader that accepts all prior versions) with an OPTIONAL `git` block recording the resolved
       commit oid and the repo-relative scope used to enumerate the tracked files. This is an UNTRUSTED
       convenience hint, consistent with docs/TRUST-BOUNDARIES.md — the authoritative verdict is still the
       recomputed root vs the on-chain record. `vh anchor <dir> --git` and the commit/claim flows record
       this block (and the existing per-file `manifest` is built from the tracked set, not the FS walk).
    2. `vh verify <path> --git [--ref <ref>]` recomputes the root from the tracked files at that ref (the
       same enumeration as T-8.1) and reports MATCH/MISMATCH against the on-chain record; with `--receipt`
       it still localizes ADDED/REMOVED/CHANGED per file, now over the tracked set. Without `--git`,
       verify is exactly today's behaviour (no regression).
    3. Tests (reuse the live-hardhat-node pattern): anchor a temp repo's `--git` root, then from a SECOND
       fresh checkout of the same commit `vh verify --git` reports MATCH (reproducibility end-to-end);
       editing a tracked file flips it to MISMATCH and `--receipt` names exactly that file; untracked junk
       in the work tree never affects the verdict. Receipt round-trip includes the new `git` block and old
       receipts (no `git` block) still read. Full suite green; `npx hardhat test` unchanged.
- **T-8.3** `VERIFIED` Document git-scoped anchoring + reproducibility. deps: T-8.1, T-8.2. files:
  docs/MERKLE-LEAVES.md, docs/RECEIPTS.md, README.md, test/ (extend an existing docs-rot guard if cheap)
  - Acceptance: README's CLI block documents `vh hash/anchor/verify --git [--ref]` and states plainly that
    the git-scoped root anchors EXACTLY the files git tracks at the commit (so it is reproducible from a
    clone and never includes `.git`/secrets/build output); docs/MERKLE-LEAVES.md adds a "git scope" note
    (the leaf formula is unchanged; only the file SET differs); docs/RECEIPTS.md documents the new
    `git` block (commit oid + scope) as an untrusted hint. Reuses existing TRUST-BOUNDARIES wording so the
    caveats stay consistent. No new runtime behaviour; pure documentation of T-8.1/T-8.2.

## EPIC-9 — Don't scatter secrets; make proofs portable  *(close a real footgun + complete the "anyone can prove" promise)*

*Motivation (Strategist 2026-06-23): the write→verify→read→git loop is complete and green (309 passing),
but I found two concrete, fully-buildable gaps — one a genuine security/operability footgun, one the
missing half of the project's headline promise. Neither needs any human/D-2/deploy decision.*
  1. *Secret-salt files get silently dropped into the user's working directory.* `runClaim`/`runCommit`
     (cli/claim.js) default `receiptPath` to `defaultReceiptPath(contentHash)` = `./<prefix>.vhclaim.json`
     resolved against **`process.cwd()`** (cli/receipt.js:514). So a user who runs `vh claim`/`vh commit`
     from inside their repo gets a file containing a **plaintext secret `salt`** dropped into their repo
     root — trivially `git add -A`-able and committable (it is only gitignored in THIS project, not in the
     user's). It also leaks in our own suite: `test/cli.claim.test.js:227` calls `runClaim` with no
     `receiptPath` from `cwd`=repo-root, dropping a new secret-bearing `*.vhclaim.json` into the repo root
     **every run** (4 present now; the Manager has flagged the growth 3×). A registry tool that scatters
     secret material into the operator's working tree is a correctness-grade defect, not cosmetics.
  2. *Proofs aren't portable.* `vh prove` (cli/prove.js) builds a real Merkle proof but only PRINTS it or
     checks it on-chain in-process. There is no shareable proof ARTIFACT and no consumer command, so a
     third party who is handed "file X is in repo root R" cannot independently verify it — which is exactly
     the README's core promise ("anyone can later prove some content is byte-for-byte what was anchored —
     without trusting any server"). The proof exists but can't leave the prover's machine.

- **T-9.1** `VERIFIED` Stop writing receipts outside an explicit, opt-in destination; make the default safe and
  isolate the suite's receipts. deps: T-6.1 (VERIFIED), T-0.3 (VERIFIED). files: cli/claim.js, cli/vh.js,
  cli/receipt.js, test/cli.claim.test.js, test/cli.receipt.test.js, README.md, docs/RECEIPTS.md
  - Problem: claim/commit drop a `./<prefix>.vhclaim.json` (containing a SECRET salt) into the caller's
    cwd by default, and the suite leaks one such file into the repo root per run.
  - Acceptance:
    1. The receipt path is NO LONGER silently `process.cwd()`-relative for the in-process `runClaim`
       one-shot used only as a convenience/e2e helper: `runClaim` MUST require an explicit `receiptPath`
       to write a receipt — when `writeReceiptFile` is not false AND no `receiptPath` is given, it either
       (a) does not write a file (returns the receipt object in-memory) OR (b) throws a clear
       "pass --receipt <path> to persist a receipt" error — chosen by the builder, documented in the
       JSDoc and in docs/RECEIPTS.md. The user-facing `vh commit` (the durable, intended-to-persist
       command) keeps a default path BUT resolves it against an explicit, documented base the user opts
       into (e.g. honoring `--receipt`/`--receipt-dir`, and defaulting to a path the user is told about in
       the success line) — it must never write to cwd without the success output naming the exact file
       written so the user can see/relocate/delete it. No silent secret drop.
    2. `cli/receipt.js`: `defaultReceiptPath` stays a pure helper but its doc states the returned path is
       relative and the caller is responsible for choosing a safe base; add a `secret: true`-style note to
       the salt field doc. (No behaviour change to the pure read/write/validate functions.)
    3. The suite leaves the working tree CLEAN: every test that triggers a receipt write uses a `receiptPath`
       under an OS temp dir (reuse the existing `tmp()` helper), and an `after`/`afterEach` (or a one-time
       guard test) asserts that running the suite creates ZERO `*.vhclaim.json` files in the repo root.
       Delete the 4 stale leaked receipts already in the repo root as part of this task.
    4. README's resumable-claims section and docs/RECEIPTS.md state plainly that the receipt holds a SECRET
       salt, where it is written (never silently into your repo unless you ask), and that you must keep it
       private until reveal — reusing the existing TRUST-BOUNDARIES wording. Flag/usage parity preserved
       (a typo still hard-errors). Full suite green; `npx hardhat test` unchanged in command.
- **T-9.2** `VERIFIED` Portable proof artifacts: `vh prove --out <p>` writes a self-contained proof file, and a
  new `vh verify-proof <p>` independently verifies it (offline recompute + one read-only on-chain check).
  deps: T-2.1 (VERIFIED), T-9.1. files: cli/prove.js, cli/proof.js (new) (or fold a writer/reader into
  prove.js), cli/vh.js, test/cli.prove.test.js, test/cli.verifyproof.test.js (new), README.md
  - Problem: a built Merkle proof can't leave the prover's machine; a third party can't independently check
    "file X belongs to anchored root R" without re-running the prover against the prover's own working tree.
  - Acceptance:
    1. Define a versioned, strictly-validated proof-artifact schema (its own `kind`/`schemaVersion`,
       reusing receipt.js's validation style and hex checks): `{ kind, schemaVersion, root, leaf,
       contentHash, relPath, proof: [siblings], contractAddress?, chainId? }`. `vh prove <file> --root
       <dir> --out <p>` writes this artifact (no key needed for the `--dry-run`/build path). The artifact
       is an UNTRUSTED transport container, consistent with docs/TRUST-BOUNDARIES.md — verification
       re-derives, it does not trust the file's claims.
    2. `vh verify-proof <p> [--contract a] [--rpc u] [--json]` (read-only, NO key): (a) recompute the leaf
       from `contentHash`+`relPath` and replay `proof` with the SAME sorted-pair/domain convention the
       contract uses (reuse hash.js's `leafHash`/`nodeHash`/leaf construction, NOT a re-implementation) to
       confirm it folds to `root` PURELY OFFLINE; then (b) call the on-chain `verifyLeaf(root, leaf, proof)`
       AND check `isAnchored(root)` to confirm the root is actually anchored. Print ACCEPTED only when the
       offline fold AND the on-chain checks all pass; otherwise REJECTED with which check failed. Distinguish
       a NotAnchored root from an RPC error exactly as verify.js/show.js do (reuse `isNotAnchoredError`).
    3. The verifier needs ONLY the artifact + an RPC URL — it never needs the original repo/working tree.
       That is the portability property: hand someone the artifact and they can independently confirm the
       file is in the anchored root with no trust in the prover. A malformed/short hash or a tampered proof
       field hard-errors or REJECTS (never silently ACCEPTS). `--out` without a valid path, and unknown
       flags, hard-error with usage (parser parity with existing commands). Output leads with the
       TRUST-BOUNDARIES one-liner (this proves set-membership in a root, not authorship/URI trust).
    4. Tests: building `--out` then `verify-proof` against a live hardhat node ACCEPTS a genuine proof;
       tampering the artifact's `proof`/`leaf`/`contentHash` REJECTS; an artifact whose `root` was never
       anchored reports NOT ANCHORED (non-zero exit), not a false ACCEPT; `--json` round-trips; the
       offline fold is exercised WITHOUT a network for the recompute step. Full suite green.
- **T-9.3** `VERIFIED` Document portable proofs + the safe-receipt change. deps: T-9.1, T-9.2. files:
  README.md, docs/PROOFS.md (new) (or extend docs/MERKLE-LEAVES.md), docs/RECEIPTS.md, test/ (extend an
  existing docs-rot guard if cheap)
  - Acceptance: README's CLI block lists `vh verify-proof` and the `vh prove --out` flag with the
    "read-only, no key, no repo needed" property; a short doc specifies the proof-artifact schema (every
    field, all UNTRUSTED transport — verification re-derives), the offline-fold + on-chain-check
    verification steps, and a worked end-to-end example (prove → hand over artifact → verify-proof). The
    receipt safe-path change from T-9.1 is reflected in docs/RECEIPTS.md. Reuses existing TRUST-BOUNDARIES
    wording so caveats stay consistent. No new runtime behaviour; pure documentation of T-9.1/T-9.2.

## EPIC-10 — Contribution lineage  *(a verifiable, tamper-evident contribution GRAPH, not isolated islands)*

*Motivation (Strategist 2026-06-23): the single-item write→verify→read→git→portable-proof loop is
complete and green (372 passing), and the usefulness trend has plateaued (avg 4.5; substantive work
scores 5/5 but only pure-docs tasks remain in the same vein, capped at 4/5). Per the stagnation
directive, this is correct-but-low-leverage territory: more incremental CLI/doc polish on existing
commands has diminishing returns. I surveyed the contract and confirmed a foundational gap that unlocks
genuinely NEW value: the registry has NO notion of a relationship between records. `Record` is a flat
island (contributor, authorBound, timestamp, blockNumber, uri) — there is no on-chain way to express
"this contribution REVISES / SUPERSEDES / BUILDS ON that earlier one." Yet the project's entire stated
trajectory is "registry of code CONTRIBUTIONS → decentralized contribution org," and a contribution is
inherently a thing that evolves: v2 fixes v1, a fork derives from an upstream, a patch builds on a base.*

*The missing primitive is a CONTRIBUTION GRAPH: let a new record optionally reference ONE already-anchored
predecessor contentHash. Because a predecessor MUST pre-exist (already be anchored) before it can be named,
the structure is a DAG by construction — acyclic, O(1) per write, no unbounded loops, no new gas-DoS
surface. This is exactly the substrate EPIC-3 (reputation keyed to verified contributions) will later flow
along — but it is NOT itself reputation/token work, so it needs NO human decision (D-2 untouched) and NO
deploy. It is a pure structural extension of the immutable on-chain data + read/verify side, built with the
same discipline (ownerless, immutable, first-writer-wins, full TRUST-BOUNDARIES NatSpec). It is the
highest-leverage buildable move: a new capability that makes the registry a graph you can walk and audit
("show me the full revision history of this contribution and who authored each step"), not a flat list.*

*Why this beats the alternatives considered. (a) EPIC-3 reputation is the bigger prize but is BLOCKED on
D-2 (token framing, human-only) — cannot auto-build, and would be premature without a lineage substrate to
key reputation to. (b) A web UI / hosted indexer is premature surface area atop a registry that still can't
express the most basic contribution relationship. (c) More CLI/doc polish is the exact low-leverage vein
the stagnation signal warns against. Lineage is a NEW capability, unblocked, and the natural foundation
every later layer needs.*

- **T-10.1** `VERIFIED` Add an optional, immutable predecessor link to records (the on-chain graph edge).
  deps: T-0.3 (VERIFIED), T-7.1 (VERIFIED). files: contracts/ContributionRegistry.sol,
  test/Lineage.test.js (new), cli/show.js, cli/list.js, cli/anchor.js, cli/claim.js, cli/vh.js
  - DONE (2026-06-23): contract ships anchorWithParent/revealWithParent + the immutable Record.parent
    field + UnknownParent/SelfParent + the parallel Linked(child,parent) event (acyclic-by-construction,
    O(1), full TRUST-BOUNDARIES NatSpec). REWORK (end-to-end consumability) also landed: `vh show`/`vh
    list` now surface `parent` + an `isRoot` flag in BOTH --json and the human block (a root serializes
    parent:null+isRoot:true, distinguishable from a missing field), and `vh anchor --parent <hash>` /
    `vh claim --parent <hash>` route to anchorWithParent/revealWithParent (with --parent shape +
    self-ref validation BEFORE any tx). test/Lineage.test.js: 31 passing (18 contract + 13 CLI
    consumability incl. live write->read-back loops). `npx hardhat test` unchanged.
  - FOLLOW-UP (B-10.1): the RESUMABLE `vh commit`/`vh reveal` path does NOT yet carry --parent — the
    versioned claim receipt schema (cli/receipt.js, SCHEMA_VERSION 3) has no `parent` field, so threading
    the edge through a persisted receipt is a schema bump (v4) with its own validation + hygiene tests.
    `vh commit --parent` currently HARD-ERRORS pointing here rather than silently dropping the edge; the
    one-shot `vh claim --parent` is the supported commit-reveal lineage path until B-10.1 lands. This is
    a subset of T-10.2's write side (the `vh lineage` read-walk command is still the rest of T-10.2).
  - Problem: `Record` has no way to reference a prior contribution, so the registry is a flat list of
    islands with no revision/derivation history a third party can walk and verify.
  - Acceptance:
    1. Extend the write paths additively WITHOUT breaking the existing zero-arg-predecessor callers: add
       `anchorWithParent(bytes32 contentHash, string uri, bytes32 parent)` and
       `revealWithParent(bytes32 contentHash, bytes32 salt, string uri, bytes32 parent)` (names at the
       builder's discretion; keep the existing `anchor`/`reveal` working UNCHANGED as the no-parent path,
       e.g. by delegating to a shared internal writer with `parent = bytes32(0)`). The `Record` struct
       gains an immutable `bytes32 parent` field (0x0 == "no predecessor / root of a lineage").
    2. A non-zero `parent` MUST already be anchored at write time, else revert with a NEW dedicated error
       `UnknownParent(bytes32 parent)` (do NOT reuse NotAnchored — the parent check is a distinct
       precondition). `parent == contentHash` (self-reference) reverts with a NEW `SelfParent(bytes32)`.
       Because a parent must pre-exist before it can be named, the graph is acyclic BY CONSTRUCTION — state
       this invariant in NatSpec. The write stays O(1): a single mapping existence check, NO loop, no walk
       of the chain (preserving "no function loops over an unbounded set / no gas-DoS").
    3. Events: extend `Anchored`/`Revealed` (or add a parallel `Linked(bytes32 indexed child, bytes32
       indexed parent)` event — builder's call, but indexers MUST be able to reconstruct the full edge set
       from logs) so the parent edge is observable off-chain. `getRecord`/`getRecordAtIndex`/`getRecords`
       all surface the new `parent` field (it is part of the returned struct, so this is automatic — just
       confirm + test). NatSpec carries the SAME TRUST BOUNDARIES caveats and adds: a parent edge asserts
       only that the author of THIS record CLAIMED this predecessor — it does not prove the predecessor's
       content is genuinely an ancestor (consumers still re-derive both contents), and it does NOT transfer
       or imply the predecessor's authorship.
    4. Ownerless, immutable, no owner/admin/pause/upgrade, no funds (still non-payable). No existing
       contract test regresses (the no-parent paths behave identically — same events for the legacy
       signature, same first-writer-wins, same reverts).
    5. Tests (test/Lineage.test.js): anchor A then anchor B with parent=A → B.parent==A and the edge is
       observable via the event/read; revealing C with parent=B sets authorBound=true AND parent=B;
       referencing an UNanchored parent reverts `UnknownParent`; self-parent reverts `SelfParent`; a
       2-3 deep chain (root→v2→v3) reads back the full lineage by walking `parent` off-chain; a record with
       `parent==0x0` is a valid lineage root. Full suite green; `npx hardhat test` unchanged in command.
- **T-10.2** `VERIFIED` CLI: anchor/claim a contribution AS a revision, and walk lineage read-only.
  deps: T-10.1, T-7.2 (VERIFIED), T-7.3 (VERIFIED). files: cli/anchor.js, cli/claim.js, cli/verify.js,
  cli/show.js, cli/list.js (whichever surface lineage), cli/lineage.js (new) (or fold into show.js),
  cli/vh.js, test/cli.lineage.test.js (new)
  - PARTIALLY DONE by the T-10.1 rework: acceptance #1's WRITE side (`vh anchor --parent`,
    `vh claim --parent`, --dry-run prints the linked parent, malformed-parent hard-error) is implemented
    for the one-shot anchor/claim paths, and `vh show`/`vh list` already render the `parent` field.
    REMAINING for T-10.2: (a) the dedicated `vh lineage <0xhash>` read-only walk command with --max-depth
    + ordered ancestor output + --json (acceptance #2/#3/#4); (b) threading --parent through the resumable
    `vh commit`/`vh reveal` receipt (B-10.1: receipt schema bump to persist the edge); (c) recording the
    parent into anchor/claim receipts as an UNTRUSTED hint.
  - Problem: the on-chain edge from T-10.1 has no CLI: a contributor can't anchor "this is a revision of
    <hash>", and a third party can't ask "what is the full history of this contribution and who authored
    each step."
  - Acceptance:
    1. WRITE side: `vh anchor <path> --parent <0xhash>` and `vh claim/commit <path> --parent <0xhash>`
       (and the receipt records the parent as an UNTRUSTED hint, consistent with TRUST-BOUNDARIES) call the
       new `anchorWithParent`/`revealWithParent`. `--parent` validates it is a 32-byte hex hash BEFORE any
       network call and hard-errors on a malformed value (parser parity with existing commands — a typo
       never silently drops the parent). Without `--parent`, behaviour is EXACTLY today's no-parent path
       (no regression to any existing anchor/claim/commit test). `--dry-run` prints the parent it would
       link. Reuse the existing arg-parser/validation helpers, not a re-implementation.
    2. READ side: `vh lineage <0xhash> [--contract a] [--rpc u] [--json]` (read-only, NO key — provider
       only) walks the `parent` chain UP from the given record to its lineage root, printing each ancestor
       in order with: contentHash, contributor, attribution strength (reuse verify.js/list.js wording for
       authorBound), timestamp+ISO, blockNumber, and uri. It distinguishes a NotAnchored start hash from a
       real RPC error exactly as verify.js/show.js do (reuse `isNotAnchoredError`). The walk is BOUNDED by
       a `--max-depth` (sane default, e.g. 256) so a client can't be hung by a pathological chain; reaching
       the cap prints a clear "lineage deeper than --max-depth" note rather than looping forever. `vh show`
       gains a one-line "parent: <hash> (or — for a lineage root)" field reusing the same render.
    3. Every human-output run leads with the one-line TRUST-BOUNDARIES caveat AND a lineage-specific one:
       a parent edge is the CHILD author's CLAIM of a predecessor; it does not prove the predecessor is a
       genuine ancestor of the content (re-derive both) and does not transfer authorship. `--json` emits a
       machine-readable ordered ancestor array carrying the same fields (for piping/CI).
    4. Tests (test/cli.lineage.test.js, live hardhat node): anchor a root then anchor a child with
       `--parent <root>`; `vh lineage <child>` returns [child, root] in order with the right per-record
       attribution; a 3-deep chain reads back all three in order; `vh show <child>` reports the parent
       field; `vh lineage <unanchoredHash>` reports NOT ANCHORED with a non-zero exit; a malformed
       `--parent`/lineage arg errors WITHOUT hitting the network; `--max-depth` caps the walk; `--json`
       round-trips. Suite green.
- **T-10.3** `VERIFIED` Document the contribution graph + lineage semantics, and cross-link it.
  deps: T-10.1, T-10.2. files: docs/LINEAGE.md (new), docs/TRUST-BOUNDARIES.md, README.md, test/ (extend
  an existing docs-rot guard)
  - Acceptance: `docs/LINEAGE.md` specifies the on-chain `parent` edge (acyclic-by-construction, immutable,
    O(1), what it does and does NOT prove), the `Linked`/extended-event log shape an indexer reconstructs
    the graph from, the `vh anchor/claim --parent` write flow, and the `vh lineage` / `vh show` read flow
    with a worked end-to-end example (anchor root → anchor revision → walk lineage). README's CLI block
    lists `vh lineage` and the `--parent` flag with the "read-only walk, no key" property; a short
    TRUST-BOUNDARIES note states plainly that a parent edge is the child author's CLAIM (re-derive both
    contents; it neither proves genuine ancestry nor transfers authorship). Reuses existing TRUST-BOUNDARIES
    wording so caveats stay consistent. No new runtime behaviour; pure documentation of T-10.1/T-10.2.

*Follow-up (Strategist 2026-06-23): EPIC-10 shipped the on-chain edge and the one-shot/anchor write paths,
but left an explicit, in-code FOLLOW-UP unbuilt (BACKLOG B-10.1, also referenced in cli/vh.js:604-610). The
resumable, crash-durable claim path — `vh commit` (persists a receipt) → later `vh reveal --receipt` (resumes
from a fresh process) — CANNOT carry a `--parent` lineage edge: the versioned claim-receipt schema
(cli/receipt.js, SCHEMA_VERSION 3) has no `parent` field; `buildCommitTx`/`runCommit` neither accept nor
persist a parent; `runReveal` calls the LEGACY `contract.reveal(...)` (no-parent) instead of the
already-existing `revealWithParent`; and `vh commit --parent` HARD-ERRORS pointing here. So the ONLY way to
record a commit-reveal lineage edge today is the one-shot `vh claim --parent` — which is exactly the
non-durable path EPIC-6 was created to replace (it holds the secret salt in memory across MIN_REVEAL_DELAY,
losing the claim on a crash). The result: a contributor CANNOT simultaneously get (a) front-running-resistant
authorship, (b) a recorded lineage edge, and (c) crash-durability. That trifecta is the whole point of the
project's flagship flow. Closing it is the completion of EPIC-10, a real capability (not docs polish), and is
purely additive/test-gated — no funds, no deploy, no D-2 token decision. The contract already does everything
needed (`revealWithParent`); this is a CLI + receipt-schema thread-through only.*

- **B-10.1** `VERIFIED` Thread the lineage `--parent` edge through the RESUMABLE commit/reveal receipt (schema v4),
  so `vh commit --parent` + `vh reveal` records `revealWithParent`. deps: T-10.1 (VERIFIED), T-10.2 (VERIFIED),
  T-6.1 (VERIFIED), T-9.1 (VERIFIED). files: cli/receipt.js, cli/claim.js, cli/vh.js, test/cli.receipt.test.js,
  test/cli.lineage.test.js (or a new test/cli.commit.parent.test.js)
  - Problem: the resumable claim path can't carry a lineage edge (receipt schema v3 has no `parent`;
    `runReveal` calls the legacy no-parent `reveal()`), so `vh commit --parent` hard-errors and the durable
    path silently can't do lineage — forcing users back to the non-durable one-shot `vh claim --parent`.
  - Acceptance:
    1. `cli/receipt.js`: bump the claim-receipt schema additively to v4 (SCHEMA_VERSION 4, append 4 to
       SUPPORTED_SCHEMA_VERSIONS) with an OPTIONAL `parent` field on the CLAIM receipt only — a 0x 32-byte
       hex contentHash of an already-anchored predecessor, or absent for a lineage root. Reuse the existing
       additive-optional pattern (`_attachOptional` + a `_normParent`-style normalizer mirroring `_normGit`):
       `buildReceipt({..., parent})` records it ONLY when present, validates it is a well-formed non-zero
       32-byte hex hash (reject a malformed value, reject the all-zero hash, and reject `parent === contentHash`
       self-reference — the contract rejects SelfParent), and `readReceipt` ACCEPTS every prior version (a
       v1/v2/v3 receipt has no `parent`, still reads). The field is an UNTRUSTED convenience hint consistent
       with docs/TRUST-BOUNDARIES.md (the authoritative edge is what `revealWithParent` records on-chain).
       The ANCHOR receipt is unchanged. NatSpec/JSDoc states `parent` is a CLAIM of a predecessor, not proof
       of ancestry or any authorship transfer.
    2. `cli/claim.js`: `buildCommitTx` accepts an optional `opts.parent`, validates it up front via the
       EXISTING `normalizeParent` (a malformed/self-referential value hard-errors BEFORE any network call —
       parser parity with `vh anchor --parent`), and returns it on the built tx so `runCommit` can persist it.
       `runCommit` records `parent` into the receipt via `buildReceipt`. `runReveal` reads `receipt.parent`
       and, when present, routes the reveal leg to `revealWithParent(contentHash, salt, uri, parent)` (reuse
       `buildRevealTx`, which already supports `parent`) instead of the legacy `reveal()`; when absent it
       behaves EXACTLY as today (legacy `reveal()` — no regression). The commit() tx itself is unchanged (the
       contract's commit carries no parent; the edge is recorded at reveal time), so the commitment binding is
       identical with or without a parent.
    3. `cli/vh.js`: REMOVE the `vh commit --parent` hard-error (the B-10.1 block at ~604-610) and instead
       thread `opts.parent` into `runCommit`; `vh commit --dry-run` (if it has one) / the commit success line
       names whether a parent edge will be recorded. `vh reveal` needs no new flag — it reads the parent from
       the receipt. Update the `vh commit` usage text that currently says `vh commit`/`vh reveal` "do not carry
       it yet (BACKLOG B-10.1)" to state they now DO. A malformed `--parent` on `vh commit` still hard-errors
       with usage (a typo never silently drops the edge). Without `--parent`, every existing commit/reveal test
       passes byte-for-byte unchanged.
    4. Tests: (a) receipt round-trip + validation — a v4 claim receipt with a valid `parent` reads back; a
       malformed/zero/self-referential `parent` is REJECTED by `buildReceipt`/`readReceipt`; a v3 receipt with
       no `parent` still reads (back-compat). (b) Live-hardhat-node end-to-end: anchor a root R; `runCommit`
       with `--parent R` writes a receipt whose `parent === R`; then in a SEPARATE call (fresh process)
       `runReveal` from only that receipt routes to `revealWithParent`, and `vh show`/`vh lineage` on the
       revealed child report `parent === R` with `authorBound=true`. (c) `runCommit --parent` with an
       UNANCHORED parent: the commit still succeeds (the contract checks the parent at REVEAL time), but the
       later `runReveal` reverts `UnknownParent` and leaves the receipt intact for retry — assert this so the
       failure mode is documented and the salt is not lost. (d) A malformed `--parent` hard-errors before any
       network call. (e) The receipt hygiene guard (zero `*.vhclaim.json` in the repo root) still passes — all
       new receipt-writing tests isolate to an OS temp dir. Full suite green; `npx hardhat test` unchanged.
  - Note: after this lands, update the T-10.1 FOLLOW-UP/B-10.1 prose and the T-10.2 "REMAINING" note to mark
    the resumable-lineage subset DONE (the only T-10.2 remainder was the `vh lineage` walk, already VERIFIED).
- **B-10.2** `VERIFIED` Document resumable-claim lineage (the v4 `parent` receipt field + `vh commit --parent`).
  deps: B-10.1. files: docs/RECEIPTS.md, docs/LINEAGE.md, README.md, test/ (extend an existing docs-rot guard)
  - Acceptance: docs/RECEIPTS.md documents the v4 schema bump and the new OPTIONAL `parent` field (its
    UNTRUSTED-hint status, that it routes the resumed reveal to `revealWithParent`, and the back-compat that
    v1–v3 receipts still read); docs/LINEAGE.md's write-flow section adds the resumable
    `vh commit --parent <hash>` → `vh reveal --receipt <p>` path alongside the one-shot `vh claim --parent`,
    and notes the parent is checked on-chain at reveal time (a stale/unanchored parent fails the reveal, not
    the commit, leaving the receipt reusable). README's CLI block drops the "(do not carry it yet, B-10.1)"
    caveat on `vh commit`/`vh reveal` and states they now support `--parent`. Reuses existing TRUST-BOUNDARIES
    wording so caveats stay consistent. No new runtime behaviour; pure documentation of B-10.1.

## EPIC-11 — Don't trust the server you read from  *(make the read side authenticate the registry, closing the headline promise's last hole)*

*Motivation (Strategist 2026-06-23): the single-item AND lineage write→verify→read→git→portable-proof
loop is complete and green (622 passing), and the usefulness trend has plateaued (avg 4.5 / min 4 — the
only sub-5 scores are pure-docs tasks; the Manager confirms substantive work scores 5/5 but only
doc/CLI-polish in the same vein remains). Per the stagnation directive this is correct-but-low-leverage
territory, so I did NOT plan another CLI/doc task. I surveyed cli/ and the contract and found a
FOUNDATIONAL contradiction with the project's headline promise that is fully buildable with no human
decision: the read side BLINDLY TRUSTS whatever (RPC, contract address) pair it is pointed at.*

  *Confirmed against the code: every read command — `vh verify` (cli/verify.js:241), `vh show`
  (cli/show.js:241), `vh list`, `vh lineage`, and crucially `vh verify-proof` (cli/proof.js) — does
  `new Contract(address, ABI, provider)` and believes whatever comes back. There is NO check that the
  contract at that address is actually a ContributionRegistry (a malicious look-alike that returns
  fabricated `isAnchored=true` / fake records makes the CLI print MATCH / ACCEPTED), and NO check that
  the provider's actual `chainId` matches the `chainId` a receipt or proof artifact CLAIMS it was
  anchored on (a receipt that says "anchored on chainId 137" can be "verified" against an attacker's
  local chain that returns fakes, yielding a false MATCH). `grep` confirms ZERO `getCode`/bytecode/
  interface checks and ZERO chainId cross-checks anywhere in the read path. The contract itself carries
  NO on-chain identity marker (no `REGISTRY_ID`/`version`/ERC-165), so off-chain code currently CANNOT
  distinguish the real registry from a lying impostor even if it wanted to.*

  *Why this is the contradiction that matters: the README's entire reason to exist is "anyone can later
  prove some content is byte-for-byte what was anchored — WITHOUT TRUSTING ANY SERVER." Today a consumer
  handed a `(rpc, address)` pair — which itself comes from an untrusted source (the prover, a receipt's
  `contractAddress` field, a README, an `Anchored` event someone forwarded) — is silently trusting that
  server: a wrong/rogue RPC+address fabricates verdicts and nothing warns them. A trust-anchored read
  path turns "trust the RPC you were handed" into "authenticate the registry, then believe it," which is
  the missing foundation EVERY future consumer-facing layer (an indexer, a UI, reputation keyed to
  verified contributions) depends on to be trustworthy. This is a NEW capability — a registry-identity /
  trust-establishment layer — not incremental polish, and it touches no human decision, no funds, no
  deploy.*

  *Why this beats the alternatives I considered. (a) EPIC-3 reputation is the bigger prize but is BLOCKED
  on D-2 (token framing, human-only) — cannot auto-build, and reputation keyed to records read from a
  spoofable registry would inherit this exact hole. (b) A web UI / hosted indexer is premature AND would
  bake in the defect: an indexer that trusts whatever RPC it is configured with is the very "trusted
  server" the project promises to remove. (c) More CLI/docs polish is the exact low-leverage vein the
  stagnation signal warns against. Authenticating the registry before believing it is the highest-leverage
  UNBLOCKED move and the natural prerequisite to making the read side — and anything built on it —
  actually deliver the headline promise.*

- **T-11.1** `VERIFIED` Give the contract a cheap, immutable on-chain IDENTITY marker so off-chain code can
  authenticate a real ContributionRegistry vs. a lying look-alike. deps: none. files:
  contracts/ContributionRegistry.sol, test/Identity.test.js (new) (or extend ContributionRegistry.test.js)
  - Problem: there is no on-chain way to assert "the contract at this address is genuinely a
    ContributionRegistry implementing the expected interface" — a malicious contract can implement the
    same ABI shape and return fabricated records, and nothing distinguishes it.
  - Acceptance:
    1. Add a `pure`/`constant` identity primitive that an off-chain verifier can call to confirm the
       contract is a real registry: a `bytes32 public constant REGISTRY_ID` (e.g.
       `keccak256("verifyhash.ContributionRegistry.v1")`, value frozen in NatSpec) AND a
       `uint256 public constant REGISTRY_VERSION` (start at 1). Builder's discretion whether to ALSO add
       an ERC-165-style `supportsInterface(bytes4)` that returns true for the registry's core read
       interface id — but the `REGISTRY_ID` constant is required (it is the cheapest, most direct
       "is this the right contract" probe and does not depend on interface-id bookkeeping).
    2. The marker is IMMUTABLE and ownerless (a `constant`/`immutable`, no setter) — it cannot be changed
       after deploy and adds NO owner/admin/write surface. It is purely additive: no existing function,
       event, error, struct, or storage layout changes; every existing contract test passes byte-for-byte.
       NatSpec states plainly what the marker proves (this bytecode implements the documented registry
       interface) and what it does NOT (it does not prove the records are honest beyond what the immutable
       first-writer-wins/commit-reveal rules already guarantee, and a fork could reuse the same ID — the ID
       is a positive signal of "right interface", verified ALONGSIDE bytecode/chainId, not a sole root of
       trust; cross-link the contract-level TRUST BOUNDARIES notice).
    3. Tests (test/Identity.test.js): `REGISTRY_ID` equals the documented keccak256 constant and is stable;
       `REGISTRY_VERSION` is 1; if `supportsInterface` is added, it returns true for the declared id and
       false for `0xffffffff` and an unrelated id. Full suite green; `npx hardhat test` unchanged.
- **T-11.2** `VERIFIED` Authenticate the registry on EVERY read command before believing it: a shared
  `assertRegistry` preflight + a provider/receipt `chainId` cross-check. deps: T-11.1, T-7.3 (VERIFIED),
  T-9.2 (VERIFIED). files: cli/registry.js (new), cli/verify.js, cli/show.js, cli/list.js, cli/lineage.js,
  cli/proof.js, cli/vh.js, test/cli.registry.test.js (new), and the affected read-command tests
  - Problem: every read command does `new Contract(address, ABI, provider)` and trusts the result —
    a wrong/rogue (rpc, address) pair fabricates MATCH/ACCEPTED verdicts with no warning, silently
    trusting the very server the project promises you should not have to trust.
  - Acceptance:
    1. A new `cli/registry.js` exposes a pure-ish, reusable, side-effect-free preflight
       `assertRegistry({ provider, contractAddress, expectedChainId? })` that, BEFORE any record read:
       (a) calls `provider.getCode(address)` and hard-errors with a clear, actionable message if there is
       NO contract there (`0x` — e.g. "no contract at <addr> on this RPC — wrong address or wrong
       network?"); (b) calls the contract's `REGISTRY_ID()` (and `REGISTRY_VERSION()`) and hard-errors if
       it is absent/mismatched ("the contract at <addr> is not a verifyhash ContributionRegistry (identity
       check failed) — refusing to trust its records"); (c) if an `expectedChainId` is supplied (from a
       receipt or proof artifact), reads `provider.getNetwork().chainId` and hard-errors on a mismatch
       ("artifact/receipt was anchored on chainId X but this RPC is chainId Y — refusing to report a
       verdict against the wrong network"). It returns the resolved `{ chainId, registryVersion }` on
       success so callers can surface them. A genuine RPC/network error is re-thrown as itself, never
       masqueraded as an identity failure (mirror the existing `isNotAnchoredError` discipline).
    2. Wire `assertRegistry` into the read path of `vh verify`, `vh show`, `vh list`, `vh lineage`, and
       `vh verify-proof` so NO record/verdict is reported until the registry is authenticated. For
       `vh verify-proof` the artifact's `chainId` (already recorded by T-9.2) is passed as
       `expectedChainId`, so the offline fold + on-chain checks are only believed once the provider is
       confirmed to be the right network AND the contract is the real registry — this is the portability
       promise made trustworthy (the consumer no longer has to trust the prover's RPC blindly). The
       human output of each command gains a one-line "registry authenticated: REGISTRY_ID ok, chainId N"
       confirmation so the user can SEE the check ran (and a clear failure when it did not). `--json`
       output carries a machine-readable `registry: { id, version, chainId }` block (or an error).
    3. An OPTIONAL, documented opt-out (`--skip-identity-check` or an env equivalent, builder's choice of
       name) lets a power user who KNOWS they are pointed at a not-yet-deployed/local-dev contract bypass
       the preflight — but it must be loud (the human output states the check was skipped and that the
       verdict is therefore only as trustworthy as the RPC) and it must NEVER be the default. Without the
       flag, every read command authenticates. The existing live-hardhat-node tests must keep working:
       the locally-deployed test contract IS a real registry (post-T-11.1), so it passes the identity
       check WITHOUT the opt-out — confirm this rather than papering over it with the skip flag.
    4. No write path changes (anchor/claim/commit/reveal are untouched). No regression: every existing
       read-command test either passes unchanged (because the test contract is a genuine registry) or is
       updated to assert the new authentication line/JSON block. Unknown/typo flags still hard-error with
       usage (parser parity).
    5. Tests (test/cli.registry.test.js + the affected command tests, live hardhat node): pointing a read
       command at an address with NO code hard-errors with the "no contract" message; pointing it at a
       DEPLOYED non-registry contract (deploy a trivial stub that lacks/lies about `REGISTRY_ID`) hard-
       errors with the identity-failure message and reports NO verdict; `vh verify-proof` with an artifact
       whose `chainId` does not match the provider's chainId hard-errors with the chainId-mismatch message
       (and the SAME artifact against the matching chain still ACCEPTS); the genuine registry passes the
       check and the verdict/`--json` carries the `registry` block; `--skip-identity-check` bypasses the
       preflight with the loud warning. Full suite green; `npx hardhat test` unchanged.
- **T-11.3** `VERIFIED` Document the trust-anchored read path: "authenticate the registry before you believe
  it." deps: T-11.1, T-11.2. files: docs/TRUST-BOUNDARIES.md, README.md, test/ (extend an existing
  docs-rot guard if cheap)
  - Acceptance: docs/TRUST-BOUNDARIES.md gains a "Authenticating the registry you read from" section that
    states plainly the threat (a wrong/rogue RPC+address can fabricate verdicts), what the read path now
    does to defend against it (the `REGISTRY_ID`/version identity probe + the bytecode-present check + the
    receipt/artifact `chainId` cross-check), and the residual caveat (the ID is a positive "right
    interface" signal verified alongside bytecode + chainId, NOT a sole root of trust — a fork could reuse
    the ID, so a consumer who needs a SPECIFIC deployment must also pin the address out-of-band). README's
    CLI block notes that read commands authenticate the registry by default and documents the loud
    `--skip-identity-check` opt-out. Reuses existing TRUST-BOUNDARIES wording so caveats stay consistent.
    No new runtime behaviour; pure documentation of T-11.1/T-11.2.

## EPIC-12 — Contribution reputation: the D-2-INDEPENDENT substrate  *(answer "who has verifiably contributed, and how much" — no token decision needed)*

*Motivation (Strategist 2026-06-23): the single-item AND lineage write→verify→read→git→portable-proof→
identity loop is complete and green (537 passing), and usefulness has hit a HARD plateau — avg 4.5→4.0,
min stuck at 4, with the Manager's own 2026-06-23 analysis confirming that even substantive contract/CLI
work now caps at 4/5 because the project's real value unlock (EPIC-3 reputation) is BLOCKED on D-2 (token
framing) and D-2 was never escalated. Per the stagnation directive this run does the two materially-
different things the signal demands: (1) it finally writes D-2 + deployment as decision-ready human
proposals (STRATEGY.md › Proposals — needs-human, P-1/P-2); and (2) it builds the part of reputation that
D-2 does NOT gate.*

*The unblocking insight (confirmed against the code, not invented): a "contribution score" is a PURE,
DERIVED, NON-TRANSFERABLE VIEW over records that ALREADY exist — it is not a token, not transferable, not a
security. D-2 is ONLY about whether to layer a TRADEABLE token on top (P-1 Option B). So the entire
reputation SUBSTRATE is buildable today with no D-2 decision, no funds, no deploy. The contract currently
has NO per-contributor aggregation: `_records` is keyed by contentHash and `_hashByIndex` by insertion
order, so computing "how many verified (`authorBound`) contributions does address X have" forces an
off-chain page-walk of ALL N records (2·N RPC reads). EPIC-12 adds a bounded, additive, ownerless
per-contributor on-chain index (scoring becomes O(that contributor's own records)) and a read-only
`vh reputation <addr>` command. This is exactly the substrate EPIC-3 (P-1 Option A: non-transferable,
soulbound) becomes a thin additive layer over — it makes the registry answer the headline question of a
"decentralized contribution org": who are the real contributors and how much have they VERIFIABLY
contributed. Pure-local, test-gated, no funds/deploy/token decisions; reuses the EPIC-11 `assertRegistry`
preflight and the existing read-command patterns (`isNotAnchoredError`, shared attribution wording,
clamped pagination, `--json`).*

- **T-12.1** `VERIFIED` Add a bounded, ownerless per-contributor index + paginated read so off-chain scoring is
  O(a contributor's own records), not O(N). deps: T-0.3 (VERIFIED), T-7.1 (VERIFIED), T-10.1 (VERIFIED).
  files: contracts/ContributionRegistry.sol, test/Reputation.test.js (new) (or extend Enumeration.test.js)
  - Problem: there is NO per-contributor aggregation. Enumerating one address's records today costs an
    off-chain walk of all N records (`getRecords` page-by-page, filtering client-side), so any reputation
    score is O(N) RPC reads per query — it does not scale and makes `vh reputation` slow on a real registry.
  - Acceptance:
    1. The shared internal writer `_record(...)` appends the new record's index to a per-contributor index
       in O(1) — an additive `mapping(address => uint256[])` (append-only; insertion order preserved) and a
       `mapping(address => uint256)` count, updated for BOTH the legacy `anchor`/`reveal` (no-parent) and
       the `*WithParent` paths via the SAME shared writer, so every write path is covered with no
       per-path special-casing. NO change to the `Record` struct, to existing events/errors, or to the
       existing `_records`/`_hashByIndex`/`total` layout used by current reads — purely additive state.
       The write stays O(1) (one array push + one counter bump, NO loop), preserving the contract's "no
       function loops over an unbounded set / no gas-DoS on writes" invariant.
    2. Add ownerless `view` reads: `contributorRecordCount(address) returns (uint256)` and
       `getRecordsByContributor(address contributor, uint256 start, uint256 count)` returning parallel
       `bytes32[] contentHashes` + `Record[] records` for THAT contributor's records in insertion order,
       with the SAME clamped/forgiving pagination as `getRecords` (start past the end → empty; over-long
       count → only what exists; never reverts on an out-of-range tail; loop bounded by the caller-supplied
       `count`). Document that the caller chooses a sane page size (these are `eth_call` reads, not
       gas-paid). NatSpec carries the SAME TRUST BOUNDARIES caveats and states plainly that grouping by
       `contributor` does NOT upgrade a front-runnable `anchor()` record's attribution — an `authorBound ==
       false` record under an address is still only "first anchorer", and a reputation consumer must weight
       `authorBound` accordingly (the count is a raw enumeration, not an endorsement).
    3. Ownerless, immutable, non-payable, no owner/admin/pause/upgrade. No existing contract test regresses
       (the no-parent and parent write paths emit the same events / set the same `_records` as before; the
       new index is read-only side state). The new index never changes a record's attribution or content.
    4. Tests (test/Reputation.test.js): anchor 2 records from signer A (one plain `anchor`, one
       commit-reveal so `authorBound` differs) and 1 from signer B; `contributorRecordCount(A) == 2`,
       `(B) == 1`, `(unknown) == 0`; `getRecordsByContributor(A, 0, 10)` returns A's two records in
       insertion order with the correct `authorBound`/`parent` per record and NONE of B's; pagination
       clamps a `start`/`count` past the end to empty/partial WITHOUT reverting; a `*WithParent` write is
       indexed under its writer exactly like a no-parent write. Full suite green; `npx hardhat test`
       unchanged in command.
- **T-12.2** `VERIFIED` `vh reputation <addr>` — read-only verifiable contribution score for one contributor.
  deps: T-12.1, T-7.2 (VERIFIED), T-7.3 (VERIFIED), T-11.2 (VERIFIED). files: cli/reputation.js (new),
  cli/vh.js, test/cli.reputation.test.js (new)
  - Problem: the registry can't tell you "who has verifiably contributed, and how much" — the headline
    question of a contribution org. There is no command that scores a contributor's records.
  - Acceptance:
    1. `vh reputation <addr> [--contract a] [--rpc u] [--json] [--skip-identity-check]` (read-only, NO key
       — provider only) FIRST runs the EPIC-11 `assertRegistry` preflight (reuse `cli/registry.js`, do NOT
       re-implement) so the score is never reported against an unauthenticated/look-alike contract, then
       pages through `getRecordsByContributor` (reuse the clamped-pagination read from T-12.1) and reports,
       for that address: total records; the authorBound (proven first claimant / commit-reveal) vs
       anchor-only (front-runnable "first anchorer") BREAKDOWN; the lineage-root (`parent == 0x0`) vs
       revision (`parent != 0x0`) breakdown; and the earliest/latest blockNumber + timestamp (+ISO) seen.
       Validate `<addr>` is a 20-byte hex address BEFORE any network call (hard-error with usage on a
       malformed value — parser parity with existing commands).
    2. The "score" is a TRANSPARENT, DOCUMENTED aggregate, NOT a token and NOT transferable: it is purely
       derived from on-chain records and re-derivable by anyone. Human output LEADS with the trust caveat
       (reuse list.js/verify.js wording): a score is only as meaningful as the `authorBound` bar — an
       anchor-only count is explicitly WEAKER because a plain `anchor()` is front-runnable, so the breakdown
       reports authorBound and anchor-only SEPARATELY and never collapses them into a single number that
       hides the difference. State plainly that the score does NOT validate the CONTENT of any record
       (re-derive + `vh verify` for that) and is NOT a reputation TOKEN (any tradeable layer is gated on D-2
       / P-1, human-only).
    3. `--json` emits a machine-readable object carrying the same fields (counts, breakdowns, block/time
       bounds, the `registry` authentication block from T-11.2) for piping/CI. An address with ZERO records
       prints a clear "no contributions" line (exit code per the existing not-found convention) and `{...,
       "total": 0}` under `--json` — distinguished from an RPC/identity error exactly as verify.js/show.js
       do (reuse `isNotAnchoredError` semantics where applicable). Unknown/typo flags hard-error with usage.
    4. Tests (test/cli.reputation.test.js, live hardhat node): anchor a known mix (2 from A incl. one
       commit-reveal, 1 revision-with-parent from A, 1 from B) then `vh reputation A` reports the right
       total + authorBound/anchor-only + root/revision breakdowns and block/time bounds; `vh reputation B`
       reports only B's; an address with no records reports "no contributions"; a malformed address errors
       WITHOUT hitting the network; `--json` round-trips and carries the `registry` block; pointing at a
       non-registry contract hard-errors via `assertRegistry` (reuse the T-11.2 stub pattern). Suite green.
- **T-12.3** `VERIFIED` Document the contribution score: what it is, what it does and does NOT prove, anti-sybil.
  deps: T-12.1, T-12.2. files: docs/REPUTATION.md (new), docs/TRUST-BOUNDARIES.md, README.md, test/ (extend
  an existing docs-rot guard if cheap)
  - Acceptance: `docs/REPUTATION.md` specifies the score's EXACT definition (which on-chain reads it
    aggregates — `contributorRecordCount` + `getRecordsByContributor`; the authorBound vs anchor-only and
    root vs revision breakdowns; the block/time bounds), states plainly that it is a NON-TRANSFERABLE
    DERIVED VIEW (re-derivable by anyone, NOT a token — any tradeable layer is D-2/P-1, human-only), and
    documents what it does NOT prove (it does not validate record CONTENT — re-derive + `vh verify`; it
    does not upgrade a front-runnable anchor's attribution; it groups by an address that, for anchor-only
    records, is merely "first anchorer"). An anti-sybil note: the meaningful signal is the authorBound
    (commit-reveal) count, because producing a front-running-resistant claim has a real cost, whereas
    anchor-only and address creation are cheap. README's CLI block lists `vh reputation <addr>` with the
    "read-only, no key, authenticated" property; a short TRUST-BOUNDARIES note cross-links it. Reuses
    existing TRUST-BOUNDARIES wording so caveats stay consistent. No new runtime behaviour; pure
    documentation of T-12.1/T-12.2.

## EPIC-13 — DataLedger: AI training-data provenance  *(FIRST INCOME PRODUCT — paying customers, on the shared core)*

*Direction (operator/human 2026-06-23, see STRATEGY.md "## Direction"): the new north star is income from paying
customers, built as a FAMILY of products on the existing provenance core. DataLedger is product #1 — a CLI that
produces a tamper-evident, reproducible manifest of exactly which files went into an AI training/fine-tuning
dataset, reusing the path-bound Merkle (cli/hash.js), the receipt-manifest diff (cli/verify.js), and the portable
offline proof (cli/proof.js). Buyer: AI/ML companies answering enterprise data-provenance due-diligence + EU AI
Act documentation. REVENUE INTEGRITY: value sold to paying customers; NO token/coin/sale (see VISION/guardrails).
The loop BUILDS + locally TESTS only; design-partner customer, signing/timestamp trust-root, EU-AI-Act field
mapping, pricing/billing/sales are HUMAN steps (track as needs-human). After v1, the Strategist may EXPAND into
sibling products on the same core: ProofParcel (B2B data-delivery receipts), AttestKit (SOC2/ISO audit-log evidence).*

- **T-13.1** `VERIFIED` `vh dataset build <dir> --out <manifest>` — tamper-evident dataset manifest. deps: T-1.1 (VERIFIED),
  T-0.2 (VERIFIED). files: cli/dataset.js (new), cli/vh.js, test/cli.dataset.test.js (new)
  - Acceptance:
    1. Reuses the EXISTING path-bound, domain-separated Merkle leaf/root convention from cli/hash.js (no new hashing
       convention); streams/shards a large dataset tree so it does not load all file content into memory at once.
    2. Writes a strict, versioned JSON manifest: the Merkle root + a sorted list of {relPath, contentHash, leaf}, plus
       OPTIONAL per-file {source, license} recorded as explicitly-labeled UNTRUSTED hints; a strict reader rejects a
       malformed/edited manifest (wrong schemaVersion, missing/!hex fields). Writes ONLY to the caller's --out path
       (no cwd litter; the test isolates to a temp dir and self-cleans).
    3. Tests on a fixture dataset prove the root is deterministic and identical to cli/hash.js's root for the same tree.
       Full suite green (`npx hardhat test`).
- **T-13.2** `VERIFIED` `vh dataset verify <dir> --manifest <p>` — re-derive root + precise per-file diff. deps: T-13.1.
  files: cli/dataset.js, cli/verify.js, cli/vh.js, test/cli.dataset.test.js
  - Acceptance:
    1. Re-derives the root from a FRESH copy of the dataset; the authoritative MATCH/MISMATCH is recomputed-root vs
       manifest-root (manifest is an untrusted hint, consistent with docs/TRUST-BOUNDARIES.md).
    2. Prints a precise per-file diff — ADDED / REMOVED / CHANGED (old→new contentHash) — reusing the receipt-manifest
       diff logic already in cli/verify.js.
    3. Tests: a swapped file, an added file, and a renamed file are EACH caught and correctly classified OFFLINE (no
       network). Suite green.
- **T-13.3** `VERIFIED` `vh dataset prove --file <p> --manifest <m>` + `vh dataset verify-proof <proof>` — offline
  set-membership. deps: T-13.1, T-9.2 (VERIFIED). files: cli/dataset.js, cli/proof.js, cli/vh.js, test/cli.dataset.test.js
  - Acceptance:
    1. Produces a self-contained proof that a given file WAS a member of the manifest's dataset (and a clear negative
       for a non-member), reusing cli/proof.js's fold/recompute — no new crypto.
    2. `verify-proof` folds the proof OFFLINE with NO dataset copy and NO key, confirming membership against the root.
    3. Tests: an in-set file's proof folds to the manifest root; a fabricated/altered file's proof does NOT; verification
       needs neither network nor the original dataset. Suite green.
  - NOTE (trust boundary, carry into docs): the manifest proves internal consistency + set-membership, NOT "unaltered
    since date T" — that stronger claim needs the human-owned signing/timestamp trust-root (a needs-human step). Do not
    overclaim in output/docs before that lands.

## EPIC-14 — DataLedger v1.1: the auditor's deliverables  *(turn the manifest into what a paying buyer actually consumes)*

*Motivation (Strategist 2026-06-23): EPIC-13 shipped DataLedger v1 — `vh dataset build/verify/prove/verify-proof`
(658 tests green) — and the project's north star is now INCOME from paying customers (STRATEGY.md "## Direction",
operator 2026-06-23). The Critic lens was retargeted to judge whether each increment moves toward a PAYING customer
(EU AI Act technical documentation; enterprise data-provenance due-diligence). Judged through that lens, DataLedger
v1 produces a verifiable per-file manifest but NOT the two artifacts the buyer's process actually centers on, and
it is undocumented as a product. I surveyed cli/dataset.js, cli/receipt.js (`diffManifest`), README.md, and docs/
and confirmed all three gaps below are real, unbuilt, and fully buildable with NO human/funds/deploy/D-2 decision —
they reuse the existing offline Merkle + diff core verbatim.*

  1. *No dataset-version diff. The single most common auditor / EU-AI-Act question is "what CHANGED in the
     training data between model version N and N+1?" Today the only diff is `vh dataset verify <dir> --manifest`,
     which needs the live dataset tree on disk and answers "did THIS tree drift from its OWN manifest." There is
     NO way to compare TWO manifests (run-v1 vs run-v2) — yet both manifests already carry every {relPath,
     contentHash, leaf}, so the comparison is PURELY OFFLINE (no dataset copies, no key, no network) and reuses
     `diffManifest` verbatim. An auditor handed two manifests can then produce the exact provenance-change
     evidence a compliance review requires, with neither dataset present.*
  2. *No provenance/license summary. v1 records OPTIONAL per-file {source, license} as untrusted hints but offers
     NO aggregate view. The buyer's deliverable is a roll-up: "this dataset is N files / M bytes; licenses seen:
     {MIT: 120, CC-BY: 30, UNKNOWN: 14}; sources: {…}; files with NO license hint: 14." That roll-up — over the
     trusted file set, with the hints clearly labeled UNTRUSTED self-asserted — IS the artifact a due-diligence
     reviewer reads. It is pure aggregation over the manifest; no new crypto, no network.*
  3. *DataLedger is undocumented as a product. README.md has a section for every crypto feature but NONE for
     `vh dataset`; there is no docs/DATALEDGER.md. A product meant to be evaluated and sold to enterprises must
     have a buyer-facing doc: what it proves, what it does NOT prove (the timestamp/signing trust-root is
     human-gated — do not overclaim "unaltered since date T"), the build→diff→summary→prove workflow, and how it
     maps to the data-provenance evidence an EU-AI-Act / due-diligence reviewer asks for.*

*Why this beats the alternatives. (a) EPIC-3 reputation is blocked on D-2 (human-only) and is a CRYPTO feature the
income pivot deprioritized — not buyer-relevant now. (b) A human-gated signing/timestamp trust-root is the bigger
provenance prize but is a needs-human step (it requires a real trust anchor / key custody) — tracked in STRATEGY.md,
not auto-buildable. (c) More crypto-side CLI polish is the low-leverage vein the stagnation signal warns against.
The manifest diff + provenance summary are NEW capabilities that turn a verifiable file list into the deliverables a
paying buyer's process is built around, and they are the natural foundation the sibling products (ProofParcel,
AttestKit) reuse. All pure-local, offline, test-gated.*

- **T-14.1** `VERIFIED` `vh dataset diff <manifestA> <manifestB>` — OFFLINE manifest-to-manifest change report.
  deps: T-13.1 (VERIFIED), T-13.2 (VERIFIED). files: cli/dataset.js, cli/vh.js, test/cli.dataset.test.js
  - Problem: there is no way to compare two dataset manifests (e.g. training-run v1 vs v2). The only diff today
    needs the live dataset tree and compares a tree to its OWN manifest; an auditor asking "what changed between
    these two dataset versions" cannot be answered, even though both manifests already carry every
    {relPath, contentHash, leaf}.
  - Acceptance:
    1. `vh dataset diff <manifestA> <manifestB> [--json]` reads BOTH manifests via the existing strict
       `readManifest` (a corrupt/edited/foreign manifest is rejected, never half-accepted), maps each manifest's
       `files` (relPath→path) and computes the change set by REUSING `cli/receipt.js › diffManifest` verbatim —
       NO new diff logic. PURELY OFFLINE: no dataset tree on disk, no provider, no key, no network.
    2. Human output prints: A's root and B's root, whether the roots are IDENTICAL (in which case the file sets
       are identical — say so) or DIFFERENT, and the precise per-file change set — ADDED (in B not A), REMOVED
       (in A not B), CHANGED (same relPath, different content: old→new contentHash), with a count line
       (e.g. "+3 / -1 / ~2 / 120 unchanged"). A rename surfaces as REMOVED(old path)+ADDED(new path) because the
       path is bound into the leaf — state this in the output so it is not mistaken for two unrelated edits.
       Leads with the one-line TRUST note (reuse the existing dataset TRUST_NOTE wording): the diff compares what
       each manifest CLAIMS; it does not re-derive content (run `vh dataset verify` against the live tree for
       that). `--json` emits a machine-readable object: { rootA, rootB, rootsIdentical, added, removed, changed,
       unchanged, counts } for piping/CI.
    3. Exit codes mirror the dataset family: 0 when the manifests are IDENTICAL, 3 when they DIFFER (so CI can
       branch — "fail the pipeline if the training set changed unexpectedly"), 2 on a usage error, 1 on a runtime
       error (missing/corrupt manifest). Requires exactly two positional manifest paths; a missing one, a third
       positional, or an unknown flag hard-errors with usage (parser parity with the existing dataset subcommands).
    4. Tests (offline, no network): build manifest A for a 3-file fixture; build B after editing one file, adding
       one, and removing one; `vh dataset diff A B` reports exactly that CHANGED/ADDED/REMOVED set with the right
       old→new hashes and exit 3; diffing a manifest against ITSELF reports IDENTICAL with exit 0; a rename shows
       as REMOVED+ADDED; `--json` round-trips and carries the same counts; a corrupt/foreign manifest is rejected
       by readManifest (exit 1); a missing/extra positional or unknown flag exits 2. Full suite green (`npx hardhat test`).
- **T-14.2** `VERIFIED` `vh dataset summary <manifest>` — provenance/license roll-up the due-diligence reviewer reads.
  deps: T-13.1 (VERIFIED). files: cli/dataset.js, cli/vh.js, test/cli.dataset.test.js
  - Problem: the manifest records OPTIONAL per-file {source, license} as untrusted hints but offers no aggregate
    view, so a buyer cannot see "what licenses/sources does this dataset claim, and how many files have NO hint"
    without parsing the JSON by hand.
  - Acceptance:
    1. `vh dataset summary <manifest> [--json]` reads the manifest via strict `readManifest` and prints an
       aggregate roll-up over the TRUSTED file set: total fileCount, the dataset root, a license histogram
       (count of files per `license` value, with files carrying NO license hint grouped under an explicit
       "(no license hint)" bucket), and a source histogram (count per `source` value, with no-hint grouped under
       "(no source hint)"). PURELY OFFLINE: no dataset tree, no provider, no key, no network.
    2. The output LEADS with the trust caveat (reuse the dataset TRUST_NOTE wording): the file SET (relPath +
       content) is bound into the root and is trustworthy; the {source, license} hints are UNTRUSTED, self-asserted
       metadata NOT bound into the root — the summary counts what the dataset CLAIMS, it does not verify any
       license/source is correct. State plainly that "(no license hint)" means the manifest asserts nothing, not
       that the file is unlicensed.
    3. `--json` emits a machine-readable object: { root, fileCount, licenses: { "<value>": n, "(no license hint)": n },
       sources: { … }, filesWithLicenseHint, filesWithSourceHint } for piping into a compliance pipeline. Requires
       exactly one positional manifest path; a missing/extra positional or unknown flag hard-errors with usage
       (parser parity).
    4. Tests (offline): build a manifest with a --hints file giving some files licenses/sources and leaving others
       unhinted; `vh dataset summary` reports the correct per-license and per-source counts AND the right
       "(no … hint)" bucket sizes; `--json` round-trips; a manifest with ZERO hints reports every file under the
       no-hint buckets; a corrupt/foreign manifest is rejected (exit 1); usage errors exit 2. Suite green.
- **T-14.3** `VERIFIED` Document DataLedger as a product (the buyer-facing deliverable doc). deps: T-14.1, T-14.2.
  files: docs/DATALEDGER.md (new), README.md, test/ (extend an existing docs-rot guard if cheap)
  - Acceptance: `docs/DATALEDGER.md` specifies what DataLedger PROVES (a reproducible, tamper-evident manifest of
    exactly which files — names AND bytes — a dataset contained; offline set-membership of any one file; precise
    add/remove/change between two dataset versions; a provenance/license roll-up) and what it does NOT prove (it
    is NOT a timestamp — "unaltered since date T" needs the human-owned signing/timestamp trust-root, a needs-human
    step in STRATEGY.md — and the {source, license} hints are UNTRUSTED self-asserted metadata; do not overclaim).
    It documents the workflow end-to-end (build → diff between versions → summary → prove a single file →
    verify-proof) with a worked example, and a short "what an auditor / EU-AI-Act reviewer gets" mapping (which
    command produces which evidence). README.md gains a `### Dataset provenance (DataLedger)` section in the CLI
    block listing `vh dataset build/verify/diff/summary/prove/verify-proof` with the "offline, no key, no network"
    property and a link to docs/DATALEDGER.md. Reuses existing TRUST-BOUNDARIES/dataset TRUST_NOTE wording so the
    caveats stay consistent. No new runtime behaviour; pure documentation of EPIC-13 + T-14.1/T-14.2.

## EPIC-15 — DataLedger v1.2: the auditor's filed deliverable  *(turn scattered CLI output into the one document a buyer's compliance process consumes)*

*Motivation (Strategist 2026-06-23): the build frontier is EMPTY (EPIC-13/14 DataLedger all VERIFIED,
701 tests green) and the north star is INCOME from a PAYING customer (STRATEGY.md "## Direction",
operator 2026-06-23; the Critic lens now judges revenue-relevance — does each increment move toward a
buyer with a budgeted, externally-imposed reason to pay: EU AI Act technical documentation, enterprise
data-provenance due-diligence). Judged through that lens, DataLedger today emits CORRECT but SCATTERED
machine output: a manifest JSON (`vh dataset build`), a histogram block (`vh dataset summary`), and a
MATCH/MISMATCH verdict (`vh dataset verify`) — three separate commands a reviewer must run and assemble
BY HAND into the single self-contained evidence document they actually file. I surveyed `cli/dataset.js`
(1109 lines), `docs/DATALEDGER.md`, and the summary/verify result shapes and confirmed two real, unbuilt,
fully-buildable gaps — both pure-local, offline, no key, no network, no human/D-2/deploy decision.*

  1. *No consolidated evidence report.* The buyer's deliverable is a DOCUMENT (an EU-AI-Act technical-doc
     section / a due-diligence packet), not three terminal outputs. There is NO command that produces one
     self-contained, deterministic report — dataset identity (root + fileCount), the provenance/license
     roll-up, an OPTIONAL live-tree verify status, and the standing trust caveats — in a form a human FILES
     (Markdown) and a pipeline INGESTS (JSON). The pieces all exist (`runDatasetSummary` + `runDatasetVerify`
     + `TRUST_NOTE`); nothing assembles them into the artifact the buyer's process is built around. This is
     the difference between "a verifiable file list" and "the evidence an auditor attaches to a filing."
  2. *No canonical, signing-ready attestation payload.* DataLedger's repeatedly-stated limit (docs +
     in-band notes) is that it is NOT a timestamp — "unaltered since date T" needs the HUMAN-OWNED
     signing/timestamp trust-root (`needs-human`). The SIGNING stays human-gated. But the DETERMINISTIC,
     CANONICAL BYTES a human (or a future timestamp service) would sign are fully buildable NOW — and
     producing them is the bridge that turns the human signing step from "design a payload + decide a
     format" into "sign THIS exact file." Today there is no stable, byte-deterministic serialization of
     "this dataset root + fileCount + manifest digest + caveat" to hand a signer, so the human trust-root
     step has nothing concrete to plug into. Building the unsigned attestation payload now de-risks and
     unblocks the highest-value human step the project has (P-3 below).

*Why this beats the alternatives. (a) EPIC-3 reputation is BLOCKED on D-2 (human-only) and is a CRYPTO
feature the income pivot deprioritized — not buyer-relevant now. (b) The human-owned signing/timestamp
trust-root itself is the bigger provenance prize but is a `needs-human` step (real key custody / a trust
anchor) — tracked in STRATEGY.md as P-3, NOT auto-buildable; EPIC-15 builds the deterministic payload that
step CONSUMES without overclaiming past it. (c) More crypto-core CLI polish is the low-leverage vein the
stagnation signal warns against. The evidence report + canonical attestation payload are NEW capabilities
that turn DataLedger from a set of verbs into the deliverable a paying buyer's compliance process consumes,
and they are the foundation the sibling products (ProofParcel, AttestKit) reuse on the same core. All
pure-local, offline, test-gated; no funds, no deploy, no token framing, no D-2.*

- **T-15.1** `VERIFIED` `vh dataset report <manifest> [--verify <dir>] [--json] [--out <p>]` — one self-contained,
  deterministic evidence document a reviewer files. deps: T-13.1 (VERIFIED), T-13.2 (VERIFIED), T-14.2 (VERIFIED).
  files: cli/dataset.js, cli/vh.js, test/cli.dataset.test.js
  - Problem: a buyer's deliverable is a single document (dataset identity + provenance/license roll-up +
    optional verify status + the trust caveats), but DataLedger only emits three separate command outputs a
    reviewer must assemble by hand. There is no command that produces the filed artifact.
  - Acceptance:
    1. `vh dataset report <manifest>` reads the manifest via the existing strict `readManifest` (a
       corrupt/edited/foreign manifest is rejected, never half-accepted) and produces a CONSOLIDATED report
       that REUSES the existing logic VERBATIM — NO new aggregation/diff/verify math: the dataset identity
       (root, fileCount), the provenance/license roll-up by calling the SAME aggregation `runDatasetSummary`
       already performs (extract the pure aggregation into a shared helper if needed so the histogram can
       never diverge from `vh dataset summary`), and the standing trust caveats from `TRUST_NOTE`. PURELY
       OFFLINE for the manifest-only path: no dataset tree, no provider, no key, no network.
    2. OPTIONAL `--verify <dir>`: when given, re-derive the root from the live tree by REUSING
       `runDatasetVerify` (no re-implementation) and embed its MATCH/MISMATCH verdict + the per-file
       ADDED/REMOVED/CHANGED localization into the report's "verification status" section. Without `--verify`,
       the report states plainly that NO live-tree verification was performed (the root is the manifest's
       CLAIM until re-derived) — it must never imply a verify happened when it did not.
    3. Default human output is a DETERMINISTIC Markdown document (stable section order; the histogram uses the
       same sorted/no-hint-last ordering as `_histogramLines` so two runs over the same manifest produce
       byte-identical Markdown) suitable to attach to a filing; `--json` emits a machine-readable object
       carrying the SAME fields ({ root, fileCount, licenses, sources, filesWithLicenseHint,
       filesWithSourceHint, verify?: {status, added, removed, changed} }) for a compliance pipeline. `--out <p>`
       writes the report to the caller's explicit path (no cwd litter; the test isolates to a temp dir and
       self-cleans) and names the file written; without `--out` it prints to stdout.
    4. The report LEADS with the trust posture (reuse `TRUST_NOTE`/the dataset trust wording verbatim so the
       caveats can never drift): the file SET (relPath + content) is bound into the root and trustworthy; the
       {source, license} hints are UNTRUSTED self-asserted metadata not bound into the root; and it is NOT a
       timestamp — "unaltered since date T" needs the human-owned signing/timestamp trust-root (`needs-human`,
       P-3). Do NOT overclaim. Exit codes: with `--verify`, mirror `vh dataset verify` (0 MATCH / 3 MISMATCH)
       so CI can gate; without `--verify`, exit 0 on a well-formed manifest; 2 on a usage error; 1 on a
       runtime error (missing/corrupt manifest).
    5. Tests (offline, no network): build a manifest for a fixture with some files hinted and some not; `vh
       dataset report <manifest>` emits a Markdown document containing the root, fileCount, the same
       license/source histogram `vh dataset summary` produces, and the trust caveats; running it TWICE over
       the same manifest yields byte-identical output (determinism); `--json` round-trips and carries the same
       fields; `--verify <dir>` against the matching tree embeds a MATCH section (exit 0) and against an edited
       tree embeds a MISMATCH + the changed file and exits 3; `--out` writes exactly that file and leaves the
       working tree clean; a corrupt/foreign manifest is rejected (exit 1) and a usage error exits 2. Full
       suite green (`npx hardhat test`).
- **T-15.2** `VERIFIED` `vh dataset attest <manifest> [--json] [--out <p>]` — the deterministic, canonical
  UNSIGNED attestation payload the human signing/timestamp trust-root (P-3) will sign. deps: T-13.1 (VERIFIED),
  T-15.1. files: cli/dataset.js, cli/vh.js, test/cli.dataset.test.js
  - Problem: DataLedger's stated limit is that it is NOT a timestamp — the SIGNING is a human-gated trust-root
    step (P-3). But the deterministic bytes a human (or a future timestamp service) would sign do not exist as
    an artifact, so the human step has nothing concrete to plug into. Building the unsigned payload now is the
    bridge that turns "design + sign a payload" into "sign THIS exact file" — and it must NOT itself claim to
    be signed/timestamped.
  - Acceptance:
    1. `vh dataset attest <manifest>` reads the manifest via strict `readManifest` and emits a versioned,
       strictly-validated attestation ENVELOPE (its own `kind`/`schemaVersion`, reusing the validation style of
       `validateManifest`/proof.js) containing the dataset IDENTITY a signer commits to: the Merkle `root`, the
       `fileCount`, a `manifestDigest` (a keccak256 over a CANONICAL serialization of the manifest's files
       array — deterministic key/entry order, so the same manifest always yields the same digest and any edit
       to the committed file set changes it), and the standing trust caveat text. PURELY OFFLINE: no tree, no
       provider, no key, no network.
    2. The payload is BYTE-DETERMINISTIC and CANONICAL: serialize with stable key ordering (and document the
       exact canonicalization, e.g. sorted keys / no insignificant whitespace) so signing the bytes is
       well-defined and any two runs over the same manifest produce an identical payload — this is the property
       that makes the future human signing step a one-liner. The envelope carries an explicit
       `"signed": false` / unsigned marker and a `signature: null`-style slot the human/timestamp step fills,
       so the artifact NEVER implies it has been signed or timestamped. NatSpec/JSDoc + the in-band note state
       plainly: this is the UNSIGNED payload; standing up a real signing key / timestamp anchor is the
       human-owned trust-root (P-3, `needs-human`), and until a signature is attached this proves only the same
       set-membership/identity the manifest already does — NOT "unaltered since date T".
    3. `--out <p>` writes the canonical payload to the caller's explicit path (no cwd litter; test self-cleans);
       `--json` is the machine form (and is itself the canonical bytes); without `--out` it prints to stdout. A
       strict reader (round-trip with the writer) rejects a malformed/edited envelope (wrong kind/schemaVersion,
       missing/!hex root or manifestDigest) so a tampered payload is caught. Requires exactly one positional
       manifest path; a missing/extra positional or unknown flag hard-errors with usage (parser parity).
    4. Tests (offline): `attest` over a manifest produces a payload whose `root`/`fileCount` match the manifest
       and whose `manifestDigest` is stable across runs; editing one committed file (rebuild the manifest)
       CHANGES the `manifestDigest`; reordering nothing-significant (re-serialize) does NOT change it
       (canonicalization holds); the strict reader rejects a hand-edited envelope; the envelope is marked
       unsigned and carries no signature; `--out` writes exactly that file and leaves the tree clean; `--json`
       round-trips; usage errors exit 2. Full suite green (`npx hardhat test`).
- **T-15.3** `VERIFIED` Document the report + attestation payload in DataLedger's buyer-facing doc. deps: T-15.1,
  T-15.2. files: docs/DATALEDGER.md, README.md, test/ (extend an existing docs-rot guard if cheap)
  - Acceptance: `docs/DATALEDGER.md` gains (a) a "The evidence report" section documenting `vh dataset report`
    (what it consolidates, the deterministic Markdown vs `--json`, the optional `--verify` status section, the
    EU-AI-Act/due-diligence "what the reviewer files" framing) and (b) an "Unsigned attestation payload" section
    documenting `vh dataset attest` — the canonical, byte-deterministic payload, what it commits to
    (root/fileCount/manifestDigest), that it is UNSIGNED, and that attaching a real signature/timestamp is the
    human-owned trust-root (cross-link STRATEGY.md P-3, do not overclaim past it). The command table and the
    "what an auditor gets" mapping add `report` and `attest` rows. README's `### Dataset provenance (DataLedger)`
    section lists `vh dataset report` and `vh dataset attest` with the "offline, no key, no network" property.
    Reuses the existing TRUST-BOUNDARIES / dataset TRUST_NOTE wording so caveats stay consistent. No new runtime
    behaviour; pure documentation of T-15.1/T-15.2.

## EPIC-16 — DataLedger v1.3: the license-policy gate  *(turn "describe the data" into "pass/fail the data against a written compliance policy")*

*Motivation (Strategist 2026-06-23): the build frontier is EMPTY again — EPIC-13/14/15 (DataLedger
build/verify/prove/diff/summary/report/attest) are all VERIFIED, 743 tests green, and the human-gated
unlocks (P-1/P-2/P-3) are written. The north star is INCOME from a PAYING customer (STRATEGY.md "##
Direction", operator 2026-06-23; the Critic lens judges whether each increment moves toward a buyer with a
budgeted, externally-imposed reason to pay: EU-AI-Act technical documentation, enterprise data-provenance
due-diligence). Judged through that lens, I surveyed `cli/dataset.js` (1188 lines), `aggregateManifest`,
`runDatasetSummary`/`buildDatasetReport`, and confirmed a concrete, unbuilt, fully-buildable gap that is
HIGHER-LEVERAGE than more report/docs polish in the same vein the stagnation signal warns against.*

  *The gap: DataLedger DESCRIBES license/source provenance (a histogram) but cannot GATE it.* `vh dataset
  summary`/`report` emit "licenses seen {MIT:120, GPL-3.0:8, (no license hint):14}", but the single most
  concrete, recurring question a compliance reviewer / a CI pipeline asks is not "what licenses are present"
  — it is "does this training set VIOLATE my org's written policy?" (no copyleft in a proprietary product;
  every file MUST carry a license hint; only an allowlist of sources/licenses is permitted). Today a human
  must eyeball the histogram and decide PASS/FAIL by hand, every time, with no auditable, repeatable verdict.
  There is NO machine-checkable policy check, no exit code a CI job can gate on, no deterministic list of
  WHICH files violate WHICH rule. That is the difference between "a provenance report" and "a compliance
  control" — and the control is the artifact a buyer's due-diligence process and CI both actually run.

*The fix is a deterministic, OFFLINE policy gate: a small, versioned, strictly-validated POLICY file
(allow/deny lists for license and source, a require-license flag) and a `vh dataset check <manifest>
--policy <p>` command that evaluates the manifest's TRUSTED file set against it and emits a PASS/FAIL
verdict + the exact violating files, exit 0/3 so CI can gate, `--json` for a pipeline. It REUSES the trusted
per-file {relPath, hints} the manifest already carries — no new crypto, no contract change, no provider, no
key, no network, no human/D-2/deploy decision. It folds into `vh dataset report` as a "Policy compliance"
section so the buyer's filed document shows the verdict, and it is the foundation the sibling products
(ProofParcel, AttestKit — which gate delivered data / audit-log evidence against policy) reuse on the same
core. It carries the EXISTING trust caveat verbatim (hints are UNTRUSTED, self-asserted: a PASS means "the
dataset's self-asserted hints satisfy the policy", NOT "the licenses are genuinely correct") so it never
overclaims.*

*Why this beats the alternatives considered. (a) EPIC-3 reputation is BLOCKED on D-2 (human-only) and is a
crypto feature the income pivot deprioritized. (b) The signing/timestamp trust-root (P-3) is the bigger
provenance prize but is `needs-human` (real key/TSA custody) — not auto-buildable; this EPIC does not touch
it. (c) More report/attest/docs polish on the existing verbs is the low-leverage vein the stagnation signal
warns against and would re-cap usefulness. A policy GATE is a NEW capability that turns DataLedger from a
descriptive tool into a CI-gateable compliance control — the verb a paying buyer's pipeline and auditor's
checklist actually run — and it is the shared engine the sibling products build on. All pure-local, offline,
test-gated; no funds, no deploy, no token framing, no D-2.*

- **T-16.1** `VERIFIED` `vh dataset check <manifest> --policy <p> [--json]` — deterministic, offline license/source
  policy gate (PASS/FAIL + exact violating files, CI-gateable exit code). deps: T-13.1 (VERIFIED), T-14.2
  (VERIFIED). files: cli/dataset.js, cli/vh.js, test/cli.dataset.test.js
  - Problem: DataLedger describes provenance (a histogram) but cannot GATE it against a written policy. A
    reviewer/CI must eyeball the histogram and decide PASS/FAIL by hand, with no auditable, repeatable
    verdict and no machine-checkable list of which files violate which rule.
  - Acceptance:
    1. Define a small, versioned, strictly-validated POLICY schema (its own `kind`/`schemaVersion`, reusing
       the validation style of `validateManifest`/proof.js — reject a wrong kind/schemaVersion or a malformed
       field, never half-accept). It supports, all OPTIONAL and combinable: `allowLicenses` (an allowlist —
       any file whose license hint is not in the list violates), `denyLicenses` (a denylist — e.g. copyleft
       in a proprietary product), `allowSources`/`denySources` (same for the source hint), and
       `requireLicense: true` (every file MUST carry a license hint — a `(no license hint)` file violates).
       Document the exact match semantics (case-sensitive exact string match on the hint value) so a verdict
       is reproducible. A policy with no rules is valid and trivially PASSes (with a clear "no rules" note).
    2. `vh dataset check <manifest> --policy <p>` reads the manifest via the existing strict `readManifest`
       (a corrupt/foreign manifest is rejected, never half-accepted) and the policy via the new strict reader,
       then evaluates the manifest's TRUSTED file set against the policy in a PURE, deterministic function (no
       I/O, no network, no provider, no key) and returns a verdict: PASS (no file violates any rule) or FAIL
       with, per violating file, the relPath + which rule it broke + the offending hint value. Output is
       deterministic (violations sorted by relPath then rule) so two runs over the same inputs are
       byte-identical. `--json` emits the machine form ({ verdict, fileCount, rulesEvaluated, violations:
       [{relPath, rule, value}] }); without `--json`, a human block that LEADS with the trust caveat.
    3. Exit codes a CI job can gate on: 0 on PASS, 3 on FAIL (mirroring `vh dataset verify`/`report`'s
       data-divergence convention so all dataset gates use the same 0/3 contract), 2 on a usage error
       (missing/extra positional, missing `--policy`, unknown flag — parser parity with the other dataset
       subcommands so a typo never silently passes), 1 on a runtime error (missing/corrupt manifest OR
       policy). A missing `--policy` is a usage error (2), not a silent PASS.
    4. The verdict LEADS with the EXISTING trust caveat (reuse `TRUST_NOTE`/the dataset trust wording
       verbatim so caveats can never drift): the {source, license} hints are UNTRUSTED, self-asserted
       metadata NOT bound into the root, so a PASS means "the dataset's self-asserted hints satisfy this
       policy", NOT "the licenses are genuinely correct"; a `(no license hint)` file asserts NOTHING (which
       `requireLicense` is exactly the rule that flags). It must NEVER imply it verified a license is real.
    5. Tests (offline, no network): a fixture manifest with mixed/absent license+source hints; a policy with
       `denyLicenses:["GPL-3.0"]` FAILs and names exactly the GPL files (exit 3); an `allowLicenses` policy
       FAILs every off-allowlist file; `requireLicense:true` FAILs exactly the no-hint files; a policy all
       files satisfy PASSes (exit 0); running twice yields byte-identical output (determinism); `--json`
       round-trips and carries the violation list; a malformed/foreign policy is rejected (exit 1) and a
       missing `--policy`/unknown flag exits 2. Full suite green (`npx hardhat test`).
- **T-16.2** `VERIFIED` Fold the policy verdict into `vh dataset report` as a "Policy compliance" section. deps:
  T-16.1, T-15.1 (VERIFIED). files: cli/dataset.js, cli/vh.js, test/cli.dataset.test.js
  - Problem: the buyer FILES the report document (T-15.1); a policy verdict produced by a separate `vh dataset
    check` command is not in the filed artifact, so the compliance reviewer still assembles the evidence +
    the gate result by hand.
  - Acceptance:
    1. `vh dataset report <manifest> [--policy <p>]` — when `--policy` is given, REUSE the pure policy
       evaluator from T-16.1 VERBATIM (no re-implementation; extract it into a shared helper if needed so the
       report verdict can never diverge from `vh dataset check`) and embed a "Policy compliance" section into
       the report MODEL: the verdict (PASS/FAIL), the rules evaluated, and the violating files (relPath + rule
       + value). It appears in BOTH the deterministic Markdown (stable section order, sorted violations — two
       runs byte-identical) and the `--json` object (a `policy: {verdict, rulesEvaluated, violations}` block).
       Without `--policy`, the report is EXACTLY today's behaviour (no policy section, no regression to any
       existing T-15.1 test).
    2. Exit-code interaction is well-defined and documented: with `--verify` the report already returns 3 on
       MISMATCH; with `--policy` it returns 3 on a policy FAIL; when BOTH are given, exit 3 if EITHER fails
       (the report is non-zero whenever any embedded gate fails) and 0 only when all pass — so a single
       `vh dataset report` invocation is a complete CI gate (data integrity AND policy). Document the
       precedence in the usage/JSDoc. Usage error 2, runtime error 1 as today.
    3. The "Policy compliance" section LEADS with / repeats the same UNTRUSTED-hints trust caveat as T-16.1 so
       the report never implies the licenses were verified to be genuinely correct.
    4. Tests (offline): a report `--policy` over a PASSing manifest embeds a PASS section (exit 0) and over a
       FAILing one embeds the FAIL + the violating files (exit 3); the Markdown is deterministic (byte-identical
       across runs); `--json` carries the `policy` block; `--policy` + `--verify` together exit 3 if either
       fails and 0 only when both pass; without `--policy` the report is byte-identical to the pre-T-16.2 output
       (no regression). Full suite green (`npx hardhat test`).
- **T-16.3** `VERIFIED` Document the license-policy gate in DataLedger's buyer-facing doc. deps: T-16.1, T-16.2.
  files: docs/DATALEDGER.md, README.md, test/ (extend an existing docs-rot guard if cheap)
  - Acceptance: `docs/DATALEDGER.md` gains a "Policy compliance gate" section documenting the policy file
    schema (every field + match semantics + the no-rules case), `vh dataset check` (PASS/FAIL, the 0/3 exit
    contract a CI job gates on, the violating-file output, `--json`), and the `vh dataset report --policy`
    embedding, with the EU-AI-Act / due-diligence framing ("the control your pipeline runs and your auditor
    files") and a worked example (build a manifest with hints → write a policy → check → embed in a report).
    The command table and the "what an auditor gets" mapping add a `check` row and the `report --policy` flag.
    README's `### Dataset provenance (DataLedger)` section lists `vh dataset check` with the "offline, no key,
    no network, CI-gateable exit code" property. LEADS with / reuses the existing dataset TRUST_NOTE wording so
    the UNTRUSTED-hints caveat (a PASS attests the self-asserted hints satisfy the policy, NOT that the licenses
    are genuinely correct) stays consistent. No new runtime behaviour; pure documentation of T-16.1/T-16.2.

## EPIC-17 — DataLedger v1.4: the signed-attestation envelope + offline verifier  *(de-risk and directly unblock P-3 — turn "design a signature scheme AND get a key" into "provision a key and sign with the format we already ship + locally proved")*

*Motivation (Strategist 2026-06-23): the build frontier is EMPTY (EPIC-13..16 all VERIFIED, 800+ tests
green) and the last three METRICS lines are a hard plateau — avgUsefulness flat at 4.0, minUsefulness stuck
at 4, and crucially `humanGated: 3` STANDING across all three runs. Per the directive, a persistent
humanGated count is a VALUE CEILING: the highest-leverage work is dammed behind an unresolved human
decision, and the right response is NOT more incremental items in the capped vein — it is to SHARPEN the
blocking proposal and BUILD the auto-buildable work that de-risks / directly unblocks it.*

*The blocking proposal is P-3 (DataLedger signing / timestamp trust-root) — the income product's single
biggest unlock: it is what lets DataLedger make the "unaltered since date T" claim an EU-AI-Act /
due-diligence reviewer ultimately wants, the difference between "a provenance report" and "a signed,
third-party-attestable deliverable." The loop already built the part it can without the human decision:
`vh dataset attest` emits the deterministic, canonical UNSIGNED payload (T-15.2). But I surveyed
cli/dataset.js (validateAttestation 1540-1584, serializeAttestation 1594-1609, readAttestation) and
confirmed the signing loop is HALF-built in a way that still blocks P-3 hard:*
  1. *No signature can be ATTACHED.* `validateAttestation` HARD-REJECTS any `signed:true` / non-null
     `signature` envelope, and `serializeAttestation` has no slot a real signature can ride in. So even
     after a human signs the canonical bytes (P-3 step 2), there is no defined envelope to put the
     signature in — P-3 still requires "decide the signature/timestamp envelope format" (P-3 step 3) from
     scratch.
  2. *No way to VERIFY a signature.* There is zero signature code in cli/ or test/ (grepped: no
     verifyMessage/recoverAddress/SigningKey). The `vh dataset` subcommands are
     build/verify/diff/summary/check/report/attest/prove/verify-proof — there is NO `verify-attest`. So a
     buyer handed a "signed by the data publisher" attestation has NO command to confirm the signature is
     genuine and binds the exact dataset identity. Without a verifier, a signature is unfalsifiable
     decoration.

*The KEY insight that makes this auto-buildable WITHOUT touching the human guardrail: the loop must NEVER
provision or hold a REAL signing key (that is P-3 step 2, needs-human) — but it CAN define the detached
signature envelope format AND build/locally-test the VERIFIER end-to-end using EPHEMERAL, throwaway test
keys generated in-process (ethers `Wallet.createRandom()`, never persisted, never a real-funds key). That
proves the complete sign→verify loop works and pins down the exact envelope/signature format, so when a
human resolves P-3 they "provision a key and sign with the format we already ship + locally proved,"
rather than designing a scheme. This is exactly the de-risk-the-blocker move the directive calls for, and
it is higher-leverage than another descriptive-feature increment in the capped vein. Pure-local, offline,
no network, no real key, no funds, no deploy — nothing here issues a token or touches D-2/EPIC-4. ethers
6.17 (already a dependency) provides verifyMessage/recoverAddress; no new dependency.*

*Why this beats the alternatives I considered. (a) Another DataLedger descriptive feature (more
summary/report/check polish) is the exact capped vein the plateau warns against and would re-cap usefulness
at 4. (b) EPIC-3 reputation is BLOCKED on D-2 (P-1, human-only) and is a crypto feature the income pivot
deprioritized. (c) Standing up a real signing key / TSA is P-3 itself — guardrail-blocked, NOT
auto-buildable. Building the format + verifier with throwaway keys is the part of P-3's value the loop CAN
deliver now, and it directly converts P-3 from a design-and-provision task into a provision-only task —
sharpening the blocker AND de-risking it in one EPIC.*

- **T-17.1** `VERIFIED` Define the detached signed-attestation envelope format + a strict reader, WITHOUT
  loosening the UNSIGNED-payload guarantee. deps: T-15.2 (VERIFIED). files: cli/dataset.js,
  test/cli.dataset.test.js (or a new test/cli.dataset.attest.sig.test.js)
  - Problem: `validateAttestation` hard-rejects `signed:true` and `serializeAttestation` has no signature
    slot, so even a human-signed payload has no defined envelope. The UNSIGNED payload must stay strictly
    unsigned (T-15.2's guarantee), so the signature must live in a SEPARATE, additive container that WRAPS
    the canonical unsigned bytes verbatim — never by mutating the unsigned envelope.
  - Acceptance:
    1. Define a NEW, versioned, strictly-validated SIGNED-attestation container kind
       (`verifyhash.dataset-attestation-signed`, its own `schemaVersion`/`SUPPORTED_*` list) that embeds the
       EXACT canonical unsigned `attestation` bytes (the string `serializeAttestation` already emits —
       byte-for-byte, so the signed-over bytes are unambiguous) PLUS a `signature` block:
       `{ scheme, signer, signature }` where `scheme` is an explicit, documented value (e.g.
       `eip191-personal-sign` over the canonical unsigned bytes — a detached signature, NOT EIP-712, to keep
       the signed message exactly the canonical payload bytes), `signer` is the claimed 0x-address, and
       `signature` is the 0x-hex sig. The unsigned envelope inside is itself re-validated by the EXISTING
       `validateAttestation` (so it must still be `signed:false`/`signature:null`) — the UNSIGNED guarantee
       is preserved verbatim; signing wraps, never edits.
    2. A `serializeSignedAttestation` produces canonical, byte-deterministic bytes (fixed top-level key
       order, no insignificant whitespace, single trailing newline — same discipline as
       `serializeAttestation`) and a strict `readSignedAttestation`/`validateSignedAttestation` rejects: a
       wrong kind/schemaVersion, a missing/!hex `signature`, a malformed `signer` address, an unknown
       `scheme`, an embedded attestation that fails `validateAttestation`, or a container that does not
       round-trip. It NEVER half-accepts.
    3. A pure `buildSignedAttestation({ attestation, scheme, signer, signature })` assembles + validates the
       container WITHOUT performing any signing or key handling (the loop never holds a key — see T-17.2).
       NatSpec/JSDoc states plainly: the signed container asserts that the holder of `signer`'s key vouched
       for THIS dataset identity at signing time; it does NOT prove a timestamp (no "unaltered since date T"
       unless the scheme is a timestamp authority — still P-3) and the embedded unsigned payload's caveats
       all still apply. The standing dataset TRUST_NOTE is reused, not reworded.
    4. The UNSIGNED path is UNTOUCHED: every existing `vh dataset attest` / `validateAttestation` /
       `serializeAttestation` test passes byte-for-byte (no regression). New behaviour is purely additive.
    5. Tests: round-trip a signed container (build → serialize → read → equal); each rejection above is
       asserted; an embedded unsigned envelope that is itself `signed:true` is rejected (the wrap-don't-edit
       invariant); the embedded canonical bytes are byte-identical to `serializeAttestation` over the same
       manifest. Full suite green; `npx hardhat test` unchanged in command.
- **T-17.2** `VERIFIED` `vh dataset verify-attest <signed> [--manifest <m>] [--signer <addr>] [--json]` — an
  OFFLINE verifier that confirms a signed attestation, proved end-to-end with THROWAWAY test keys (never a
  real key). deps: T-17.1. files: cli/dataset.js, cli/vh.js, test/cli.dataset.attest.sig.test.js
  - Problem: a buyer handed a "signed by the data publisher" attestation has no command to confirm the
    signature is genuine and binds the exact dataset identity. Without a verifier a signature is
    unfalsifiable decoration. The verifier is the half of P-3 the loop CAN deliver now.
  - Acceptance:
    1. `vh dataset verify-attest <signed> [--manifest <m>] [--signer <addr>] [--json]` (PURELY OFFLINE — no
       tree, no provider, no key, no network): (a) strictly read the signed container (T-17.1); (b) recover
       the signing address from the embedded canonical unsigned bytes + `signature` per the declared
       `scheme` (ethers `verifyMessage`/`recoverAddress` — already available, no new dependency) and confirm
       it equals the container's `signer`; (c) when `--signer <addr>` is given, additionally confirm the
       recovered address equals that EXPECTED publisher address (so a buyer pins WHO must have signed, not
       just that SOMEONE did); (d) when `--manifest <m>` is given, recompute the unsigned attestation from
       that manifest via the EXISTING build path and confirm its canonical bytes are byte-identical to the
       embedded payload (so the signature binds the dataset the buyer actually holds, not some other set).
       Print ACCEPTED only when every requested check passes; otherwise REJECTED naming which check failed.
    2. Exit code mirrors the existing dataset gate convention (0 on ACCEPTED, non-zero — reuse the 3-on-
       divergence convention `verify`/`check`/`report` use — on REJECTED) so a buyer's CI can gate
       "attestation is genuinely signed by our publisher and binds this dataset." `--json` emits a
       machine-readable verdict carrying recovered signer, expected signer (if any), the manifest-binding
       result (if checked), and per-check booleans. Unknown/incomplete flags hard-error with usage (parser
       parity with the other `vh dataset` subcommands — a typo never silently passes).
    3. Output LEADS with the standing dataset TRUST_NOTE plus a signing-specific caveat: a valid signature
       proves the holder of `signer`'s key vouched for this dataset identity; it does NOT by itself prove a
       trustworthy TIMESTAMP ("unaltered since date T" still needs the human-owned trust-root, P-3 —
       cross-link STRATEGY.md), and it does NOT validate that the dataset's license/source HINTS are
       genuinely correct (that is the `check` policy gate's untrusted-hint caveat). Never overclaims past
       P-3.
    4. The sign→verify loop is PROVED end-to-end in tests using EPHEMERAL keys: a test generates a throwaway
       `Wallet.createRandom()` (in-process, never persisted, NEVER a real-funds key — assert/comment this is
       a test-only key), signs the canonical unsigned bytes per the `scheme`, builds the signed container
       (T-17.1), and asserts `verify-attest` ACCEPTS it; tampering the embedded payload, the signature, or
       the `signer` REJECTS; a `--signer` that does not match the recovered address REJECTS; a `--manifest`
       that differs from the embedded payload REJECTS with a clear binding-mismatch; a wrong-key signature
       REJECTS. `--json` round-trips. NO network, NO real key anywhere in the test. Full suite green.
- **T-17.3** `VERIFIED` Document the signed-attestation envelope + verifier, and SHARPEN the P-3 handoff to a
  provision-only step. deps: T-17.1, T-17.2. files: docs/DATALEDGER.md, README.md, STRATEGY.md (P-3
  sharpening cross-link only — NOT resolving it), test/cli.dataledger.report-attest.docs.test.js (extend
  the existing docs-rot guard if cheap)
  - Acceptance: docs/DATALEDGER.md's "Unsigned attestation payload" section gains a "Signed attestation +
    verification" subsection documenting the signed-container schema (every field + the `scheme` value + the
    wrap-don't-edit invariant that the embedded unsigned payload stays strictly `signed:false`), the
    `vh dataset verify-attest` checks (signature recovery, the optional `--signer` publisher pin, the
    optional `--manifest` identity binding), the 0/3 exit contract a buyer's CI gates on, and a worked
    end-to-end example (attest → [human signs with the documented scheme] → wrap into a signed container →
    verify-attest). The command table + the "what an auditor gets" mapping add `verify-attest`. README's
    `### Dataset provenance (DataLedger)` section lists `vh dataset verify-attest` with the "offline, no
    key, no network, CI-gateable exit code" property. CRITICALLY: the docs state plainly that producing the
    SIGNATURE itself (provisioning a real key, choosing A/B/C) is still the human-owned trust-root P-3, and
    that this build ships only the FORMAT + the VERIFIER (proved with throwaway test keys) — so it never
    implies the loop signs or holds a key, and never overclaims "unaltered since date T." LEADS with /
    reuses the existing dataset TRUST_NOTE so caveats stay consistent. No new runtime behaviour; pure
    documentation of T-17.1/T-17.2.

## EPIC-18 — ProofParcel: B2B data-delivery receipts  *(SECOND income product — a thin adapter over an EXTRACTED shared core, a NEW paying buyer)*

*Motivation (Strategist 2026-06-23): the build frontier is EMPTY (EPIC-13..17 all VERIFIED, 859 tests
green) and the metrics are a hard VALUE CEILING — avgUsefulness flat at 4.0, minUsefulness 4, and
`humanGated` GROWING (3→3→3→4). Per the directive, a persistent/growing humanGated count means the
highest-leverage value is dammed behind a human decision (P-3, the DataLedger timestamp trust-root) and
the loop is being forced into lower-leverage work AROUND it. P-3 has already been sharpened EXHAUSTIVELY
across EPIC-15/17 — it is now genuinely "provision a key and sign" (no design left for the loop to do),
so there is no more auto-buildable de-risking of P-3 worth doing, and yet another DataLedger increment is
the exact capped vein the plateau warns against (it would re-cap at 4). The materially-DIFFERENT,
higher-leverage move the OPERATOR DIRECTION (2026-06-23) explicitly promised but the loop has NEVER
started: EXPAND into a product FAMILY on the shared core — "DataLedger, ProofParcel (B2B data-delivery
receipts), AttestKit (SOC2/ISO audit-log evidence) all sit on the SAME core … expand into these as THIN
product adapters over the shared engine — one core, many paying buyers." DataLedger has now landed v1
through v1.4; the family expansion is overdue and is the genuinely-NEW, non-capped, auto-buildable,
buyer-multiplying work.*

*The buyer (DIFFERENT from DataLedger's). ProofParcel targets B2B data exchange: a SENDER delivers a
PARCEL of files to a RECIPIENT under a contract/SLA, and a delivery dispute ("you never sent file X" /
"the file you sent was corrupted/altered") is expensive. The budgeted reason to pay is contractual
PROOF-OF-DELIVERY: a tamper-evident, signable, independently-verifiable receipt that pins EXACTLY which
files (names + bytes) were delivered, for which parcel, between which parties. Data vendors, market-data
redistributors, ML-data marketplaces, and any contract with a delivery-acceptance clause have this pain.*

*Why this is a THIN adapter, not a rewrite (confirmed against the code). The provenance engine is ALREADY
cleanly factored and reused: cli/hash.js exposes hashDirStream/pathLeaf/buildTree/proofForIndex; cli/proof.js
exposes the portable proof-artifact machinery; cli/dataset.js is itself a thin consumer of these
(require("./hash"), require("./proof")). ProofParcel reuses the IDENTICAL Merkle/manifest/proof/attest/
verify-attest machinery, repointed at a delivery context with parcel metadata (parcelId, sender, recipient,
deliveredAt-as-an-untrusted-hint). It introduces NO new crypto, NO contract change, NO network, NO key, and
NO new human decision — and it inherits P-3's HONEST trust posture verbatim (a parcel receipt binds the file
SET to a root and is signable with the SAME signed-attestation envelope; it is NOT by itself a trusted
timestamp, so "delivered ON date T" still rides the same human-owned trust-root P-3). The first task EXTRACTS
the shared engine into a clean internal core module so BOTH products (and AttestKit later) depend on one
tested library rather than copy-paste — which de-risks the entire family.*

*Why this beats the alternatives considered. (a) Another DataLedger feature is the exact capped vein the
plateau warns against and would re-cap usefulness at 4. (b) EPIC-3 reputation is BLOCKED on D-2 (P-1,
human-only) and is a deprioritized crypto feature. (c) More P-3 de-risking is done — P-3 is provision-only;
the loop cannot provision a real key. A SECOND product on the shared core is a NEW capability that multiplies
shots on goal with a NEW paying buyer, forces the core to become a real reusable library (de-risking the
whole family), and is fully auto-buildable with the existing test gate. Per the income-pivot guardrails:
building more products multiplies shots on goal; it does NOT by itself produce revenue — landing a paying
ProofParcel design-partner, pricing, and the signing trust-root remain HUMAN steps (P-3, and a new P-4 below).*

*Guardrails respected. Pure-local, offline, no funds, no deploy, no token framing — nothing here touches
D-2/EPIC-3/EPIC-4 or REVENUE INTEGRITY (no token/coin/NFT/sale/airdrop/staking; income comes from selling the
product to paying customers, a HUMAN step). No contract change; reuses the EXISTING offline Merkle + proof +
signed-attestation core verbatim. The DataLedger commands and ALL their tests are UNTOUCHED (the extraction is
a refactor that keeps dataset.js's public behaviour byte-for-byte identical, re-exporting from the new core so
its tests pass unchanged). The signing trust-root stays human-gated (P-3); ProofParcel ships only the FORMAT +
the OFFLINE verifier (and, where signing is exercised in tests, EPHEMERAL throwaway `Wallet.createRandom()`
keys, never a real key). No new dependency (ethers already present), no global install, no network.*

- **T-18.1** `VERIFIED` Extract the shared provenance engine into a clean internal core module (`cli/core/`) that
  BOTH DataLedger and ProofParcel depend on — a pure refactor that keeps DataLedger byte-for-byte unchanged.
  deps: T-13.1 (VERIFIED), T-9.2 (VERIFIED), T-17.1 (VERIFIED), T-17.2 (VERIFIED). files: cli/core/manifest.js
  (new), cli/core/attestation.js (new), cli/dataset.js, test/cli.core.test.js (new)
  - Problem: the manifest/attestation machinery (buildManifest/validateManifest, the
    signed-attestation envelope buildSignedAttestation/readSignedAttestation + the verify-attest recover/check
    helpers, and the shared TRUST_NOTE) currently lives INSIDE cli/dataset.js with "dataset"-specific framing.
    A sibling product cannot reuse it without copy-paste, which would fork the trust caveats and the validation.
    The family needs ONE tested core library.
  - Acceptance:
    1. A new `cli/core/manifest.js` exports the GENERIC, product-agnostic pieces the manifest layer needs:
       a `buildItemManifest(built, { hints, kind, schemaVersion, supportedSchemaVersions, note })`-style
       builder + a `validateItemManifest(obj, { kind, supportedSchemaVersions })`-style validator
       parameterized by the product's `kind`/`note` (so DataLedger keeps `kind:"verifyhash.dataset-manifest"`
       and its TRUST_NOTE; ProofParcel can pass its own `kind`/note) and the shared hint-normalization + the
       shared `HEX32_RE`/per-file validation. NO behaviour change to the DataLedger manifest: dataset.js's
       buildManifest/validateManifest become THIN wrappers that call the core with DataLedger's constants, and
       every existing dataset manifest test passes byte-for-byte (same kind, same note, same fields, same
       error strings where a test asserts them — adjust a test ONLY if it asserts an internal symbol location,
       never to weaken a check).
    2. A new `cli/core/attestation.js` exports the GENERIC signed-attestation envelope machinery:
       the container builder/reader (`buildSignedAttestation`/`readSignedAttestation`), the signer-recovery +
       checks behind verify-attest, the supported `scheme` list (`eip191-personal-sign`), and the
       wrap-don't-edit invariant (the embedded UNSIGNED payload is re-validated, never edited). Parameterized
       by the product's signed-container `kind` so each product has its OWN container kind while sharing ONE
       implementation + ONE set of trust caveats. DataLedger's signed-attest path is rewired to call the core
       with DataLedger's kind; every existing EPIC-17 verify-attest test passes byte-for-byte.
    3. This is a PURE refactor: NO new CLI command, NO new on-chain code, NO network, NO key (tests that
       exercise signing use EPHEMERAL `Wallet.createRandom()` keys, marked test-only). The shared TRUST_NOTE
       text lives in exactly ONE place in core and is imported by both products so the caveats can NEVER drift.
       `cli/core/` has no `require("../dataset")` back-edge (the dependency points dataset → core, never the
       reverse).
    4. Tests: `test/cli.core.test.js` covers the core builders/validators/envelope DIRECTLY (round-trip +
       the validation-rejection cases the dataset tests already assert, now at the core layer), and the FULL
       existing dataset/attest/verify-attest suite still passes unchanged. `npx hardhat test` unchanged in
       command and stays green.
- **T-18.2** `VERIFIED` `vh parcel build <dir> --out <p>` + `vh parcel verify <dir> --manifest <p>` — a
  tamper-evident DELIVERY receipt over the extracted core, with parcel metadata. deps: T-18.1. files:
  cli/parcel.js (new), cli/vh.js, test/cli.parcel.test.js (new)
  - Problem: a B2B sender/recipient have no command to produce or check a proof-of-delivery receipt that pins
    exactly which files (names + bytes) were delivered for a given parcel between named parties.
  - Acceptance:
    1. `vh parcel build <dir> --out <p> [--parcel-id <s>] [--sender <s>] [--recipient <s>] [--json]` writes a
       versioned, strictly-validated PARCEL manifest by calling the core builder with ProofParcel's
       `kind:"verifyhash.parcel-manifest"` and the shared TRUST_NOTE: the SAME Merkle root + per-file
       {relPath,contentHash,leaf} as a dataset manifest, PLUS an OPTIONAL, clearly-UNTRUSTED `parcel` block
       ({parcelId?, sender?, recipient?}) recorded as self-asserted metadata that is NOT bound into the root
       (stated in-band, mirroring the hint caveats). Offline, no key, no network.
    2. `vh parcel verify <dir> --manifest <p> [--json]` re-derives the root from a fresh copy on disk and
       prints MATCH/MISMATCH + a precise per-file ADDED/REMOVED/CHANGED diff (reusing the core/diff machinery
       DataLedger already uses), exit 0/3 mirroring `vh dataset verify` so all verify gates share ONE exit
       contract. Offline, no key, no network.
    3. Every human-output run LEADS with the shared TRUST_NOTE (verbatim from core) + a parcel-specific
       caveat: the receipt binds the delivered file SET to a root and proves tamper-evidence; the `parcel`
       block (parcelId/sender/recipient) and any delivery TIME are UNTRUSTED self-asserted metadata and are
       NOT a trusted timestamp — "delivered ON date T" needs the human-owned signing/timestamp trust-root P-3
       (cross-link). Unknown/incomplete flags hard-error with usage (parser parity with existing commands).
    4. Tests (no live node needed — pure offline): build a 3-file parcel with parcel metadata, verify a clean
       copy MATCHes (exit 0), edit/add/remove a file and assert the exact ADDED/REMOVED/CHANGED file + exit 3,
       a manifest from a different tree reports full divergence not a silent mislabel, `--json` round-trips,
       the parcel block is preserved and clearly flagged untrusted, and a parcel manifest is REJECTED by the
       dataset validator (and vice-versa) so the two product `kind`s never cross-validate. Full suite green;
       `npx hardhat test` unchanged.
- **T-18.3** `VERIFIED` `vh parcel attest` + `vh parcel verify-attest` over the SAME signed-attestation core, and
  document ProofParcel as a product. deps: T-18.1, T-18.2, T-15.2 (VERIFIED), T-17.2 (VERIFIED). files:
  cli/parcel.js, cli/vh.js, docs/PROOFPARCEL.md (new), README.md, test/cli.parcel.test.js
  - Problem: a delivery receipt's value for a contractual dispute is that the SENDER can sign it ("we
    delivered exactly this") and the recipient (or an arbiter) can independently verify the signature binds
    the exact parcel — the same signing story DataLedger has, on the same core, but the loop must NOT hold a key.
  - Acceptance:
    1. `vh parcel attest <manifest> [--json] [--out <p>]` emits the deterministic, byte-canonical UNSIGNED
       attestation payload (root + fileCount + a canonical digest over the parcel manifest) via the core
       attestation builder, with `signed:false` and the in-band note pointing at the human signing trust-root
       P-3 — never claiming a timestamp. `vh parcel verify-attest <signed> [--manifest <m>] [--signer <addr>]
       [--json]` is the OFFLINE verifier (recover signer, optional `--signer` publisher pin, optional
       `--manifest` parcel-identity binding) with the 0/3 CI-gateable exit contract, built on the SAME core
       envelope as `vh dataset verify-attest`. The signed container uses ProofParcel's own
       `kind:"verifyhash.parcel-attestation-signed"` so a dataset signed-container does not cross-verify as a
       parcel one. Offline, no key, no network.
    2. Tests PROVE the full attest → [sign with an EPHEMERAL throwaway `Wallet.createRandom()` key, test-only,
       NEVER a real key] → wrap → verify-attest loop end-to-end: a genuine signature over a parcel ACCEPTS;
       a wrong `--signer` REJECTS; binding to a DIFFERENT `--manifest` REJECTS; a tampered container REJECTS;
       `--json` round-trips. The wrap-don't-edit invariant (embedded payload stays `signed:false`) is asserted.
    3. `docs/PROOFPARCEL.md` documents ProofParcel as a product: the buyer (B2B proof-of-delivery), the
       command table (build/verify/attest/verify-attest with the "offline, no key, no network, CI-gateable
       exit 0/3" property), a worked example (sender builds a parcel → [signs, P-3] → recipient verify-attests),
       and — CRITICALLY — the SAME honest trust posture as DataLedger: the receipt binds the file SET and is
       signable, but is NOT by itself a trusted delivery TIMESTAMP (that rides the human-owned trust-root P-3),
       and the parcel metadata is UNTRUSTED self-asserted. README gains a `### Data-delivery receipts
       (ProofParcel)` section listing the commands. Reuses the shared TRUST_NOTE verbatim so caveats never drift.
       A docs-rot guard (extend an existing one if cheap) keeps the command table honest.

## EPIC-19 — `vh sign`: the human's one-command signing leg  *(collapse the P-3/P-4 revenue handoff from "hand-craft a signature with external tools" to "provision a key, run one command")*

*Motivation (Strategist 2026-06-23): VALUE-CEILING break, not another incremental feature. The frontier is
EMPTY (EPIC-13..18 all VERIFIED, 1166 tests green) and the last metrics lines are a hard ceiling —
avgUsefulness FLAT at 4.0, minUsefulness stuck at 4, and `humanGated` GROWING (3→3→3→4). Per the directive,
a persistent/growing humanGated count is a VALUE CEILING: the highest-leverage work is dammed behind an
unresolved human decision, and the loop must (a) SHARPEN the blocking proposal and (b) prefer auto-buildable
work that DE-RISKS / DIRECTLY UNBLOCKS the real value once the human acts — not invent more increments in the
capped DataLedger/ProofParcel descriptive vein.*

*The blocker is P-3 (the signing/timestamp trust-root — the income product's single biggest unlock, shared by
BOTH products and named in P-4 for ProofParcel). EPIC-17 already collapsed P-3's DESIGN to nothing: the loop
ships the canonical UNSIGNED payload (`vh dataset attest` / `vh parcel attest`), the signed-container FORMAT
(`cli/core/attestation.js` `buildSignedAttestation`), and the OFFLINE verifier (`vh dataset/parcel verify-attest`).
But I confirmed against the code a REAL remaining gap in the handoff: there is NO command that takes a
human-provided key and PRODUCES the signed container. `buildSignedAttestation` accepts an already-computed
`signature` string but nothing computes it; `recoverSigner` (attestation.js:279) verifies an
`eip191-personal-sign` signature over the embedded canonical bytes, yet the ONLY thing that ever creates such a
signature today is the EPHEMERAL `Wallet.createRandom()` keys inside the tests. So a real publisher who has
provisioned a key must hand-craft the EIP-191 signature with EXTERNAL tooling (an ethers REPL / a wallet /
openssl) and then hand-assemble the `{kind, schemaVersion, note, attestation, signature:{scheme,signer,signature}}`
JSON by hand — exactly the bytes a single command should produce. That friction is the last auto-buildable
mile of P-3/P-4's revenue path.*

*The guardrail-safe insight (the same one EPIC-17 used for the verifier, applied to the signer): the loop must
NEVER PROVISION, GENERATE, HOLD, or PERSIST a real key — but it CAN build a `sign` command that READS a key the
HUMAN supplies at runtime (from a documented env var or a key file the human created OUTSIDE the loop), uses it
in-process ONLY to sign the canonical bytes, and NEVER writes/logs/echoes it. This is materially different from
provisioning a key: the loop holds no key of its own, generates none, and the only keys that appear anywhere in
the repo/tests are EPHEMERAL throwaway `Wallet.createRandom()` test keys (NEVER a real-funds key) — identical to
the EPIC-17 verify tests. This converts P-3/P-4's handoff from "provision a key AND hand-craft the signature +
envelope with external tools" into "provision a key, point `vh dataset sign --key-env <VAR>` / `vh parcel sign`
at it, run it" — a true one-command leg that closes the loop attest → sign → verify-attest end-to-end for a
paying buyer, for BOTH products on the shared core. ethers 6 (already a dependency) provides
`Wallet.signMessage` (EIP-191 personal_sign) — no new dependency, no network, no on-chain action.*

*Why this beats the alternatives. (a) Another DataLedger/ProofParcel descriptive increment is the capped vein
the plateau warns against and would re-cap at 4. (b) EPIC-3 reputation is BLOCKED on D-2 (P-1, human-only) and
is a deprioritized crypto feature. (c) More P-3 PROSE-sharpening alone is done — it is provision-only — and the
loop can't provision a key; but the loop CAN build the command the human runs AFTER provisioning, which is the
de-risking work the directive asks for. A `sign` command is a NEW capability that removes the single biggest
remaining piece of manual, error-prone friction between "a human has a key" and "a paying buyer can verify a
signed attestation" — directly unblocking the value the humanGated ceiling is damming.*

*Guardrails respected: pure-local, offline, no funds, no deploy, no token framing — nothing touches
D-2/EPIC-3/EPIC-4 or REVENUE INTEGRITY. The loop NEVER provisions/generates/holds/persists a real key; the key
is read from a human-supplied source at runtime, used only to sign, and never written or logged. The signed
container produced is byte-identical to what `buildSignedAttestation` already validates and what the existing
`verify-attest` accepts (round-trip proven in tests with ephemeral keys). The UNSIGNED attest path, the
verify-attest path, and ALL their tests stay byte-for-byte green (sign is purely additive). No contract change,
no new dependency, no network. P-3/P-4 themselves stay human-gated (provision the key + the GTM/legal steps);
EPIC-19 ships only the command the human runs locally with a key they alone provisioned.*

- **T-19.1** `VERIFIED` Core signing helper: produce the EIP-191 signature + wrap it into the signed container,
  given a caller-supplied signer. deps: T-17.1 (VERIFIED), T-18.3 (VERIFIED). files: cli/core/attestation.js,
  test/cli.core.test.js (or test/cli.dataset.attest.sig.test.js)
  - Problem: the core can WRAP a precomputed signature (`buildSignedAttestation`) and VERIFY one
    (`verifySignedAttestation`), but nothing in the codebase COMPUTES an `eip191-personal-sign` signature over
    the canonical UNSIGNED bytes except ad-hoc test code. The signer leg must live ONCE in the shared core so
    BOTH products (and any future one) use the identical scheme that `recoverSigner` already expects.
  - Acceptance:
    1. Add a pure-ish `signAttestation({ attestation, signer }, cfg)` to `cli/core/attestation.js` where
       `attestation` is a validated UNSIGNED payload object and `signer` is an ethers signer-like object
       exposing `getAddress()` + `signMessage(bytes|string)` (e.g. an ethers `Wallet`). It MUST: (a)
       re-validate the unsigned payload via `cfg.validateUnsigned` and serialize it to the EXACT canonical
       bytes with `cfg.serializeUnsigned` (the same string `recoverSigner` runs `verifyMessage` over —
       byte-for-byte, including the trailing newline); (b) compute `signature = await signer.signMessage(canonicalBytes)`
       (EIP-191 personal_sign); (c) read `signer.getAddress()`, lowercase it, and call the EXISTING
       `buildSignedAttestation({ attestation, scheme:"eip191-personal-sign", signer:<addr>, signature }, cfg)`
       so the container is validated by the existing path (no new container assembly). Return the validated
       container. It NEVER persists/logs the key and accepts no raw private-key string itself (it takes a
       signer object — key handling is the CLI layer's job, T-19.2).
    2. The produced container ROUND-TRIPS: `verifySignedAttestation({ container })` returns ACCEPTED with
       `recoveredSigner === signer address`, and binding `expectedCanonical = cfg.serializeUnsigned(attestation)`
       also passes — proving `signAttestation` and `recoverSigner`/verify agree on the exact signed-over bytes.
    3. The embedded `attestation` payload stays `signed:false` (wrap-don't-edit invariant) — assert it. A signer
       whose recovered/claimed address mismatches (defensive) is impossible by construction here, but the
       container still goes through `validateSignedAttestation`.
    4. Tests (EPHEMERAL `Wallet.createRandom()` keys ONLY, marked test-only, NEVER a real-funds key): sign a
       dataset unsigned payload and a parcel unsigned payload with the respective `cfg`; assert each verifies
       ACCEPTED, recovers the wallet address, binds its own canonical bytes, and that a DIFFERENT wallet's
       expectedSigner pin REJECTS. Full suite green; `npx hardhat test` unchanged in command.
- **T-19.2** `VERIFIED` CLI: `vh dataset sign` + `vh parcel sign` — read a human-supplied key, sign, write the
  container. deps: T-19.1, T-15.2 (VERIFIED), T-18.3 (VERIFIED). files: cli/dataset.js, cli/parcel.js, cli/vh.js,
  test/cli.dataset.attest.sig.test.js, test/cli.parcel.test.js
  - Problem: a publisher who has provisioned a key still has to hand-craft the EIP-191 signature with external
    tooling and assemble the container JSON by hand. One command should do it from a key the HUMAN supplies.
  - Acceptance:
    1. `vh dataset sign <manifest> --key-env <VAR> | --key-file <path> [--out <p>] [--json]` (and the parallel
       `vh parcel sign <manifest> ...`): build the UNSIGNED payload from `<manifest>` exactly as
       `vh dataset/parcel attest` does (reuse that code path — NO re-implementation of the payload), construct an
       ethers `Wallet` from the human-supplied key, call the T-19.1 `signAttestation`, and write the signed
       container (canonical bytes) to `--out` (or stdout). The key source is EXACTLY ONE of `--key-env <VAR>`
       (read `process.env[VAR]`) or `--key-file <path>` (read a file the HUMAN created); supplying neither, both,
       a missing env var, an unreadable file, or a malformed/zero private key HARD-ERRORS with a clear,
       actionable message BEFORE any signing — and the error message NEVER includes the key material.
    2. The command NEVER generates, persists, or logs the key: it is read, used to construct the in-process
       Wallet, used to sign, and discarded; success/`--json` output prints ONLY the signer ADDRESS (public), the
       output path, and the scheme — never the private key. The success line states "signed by <0xaddr>" so the
       human can confirm WHICH key signed. A NatSpec/usage note + the in-band output state plainly: this signs
       the dataset/parcel IDENTITY with the key YOU supplied; it is NOT a trusted TIMESTAMP (P-3 posture
       inherited verbatim — a self-managed key attests "the signer says so", not an independent "existed by date
       T"), and the key must be one YOU provisioned outside this tool.
    3. The output container is accepted by the EXISTING `vh dataset/parcel verify-attest` unchanged: a worked
       end-to-end `attest`(unsigned, optional) → `sign` → `verify-attest` loop succeeds. Flag/usage parity with
       the other dataset/parcel subcommands (a typo'd flag hard-errors with usage; `--key-env` without `--git`
       analogs etc. are validated). Without using `sign`, every existing dataset/parcel test passes byte-for-byte.
    4. Tests (EPHEMERAL `Wallet.createRandom()` keys ONLY — write the throwaway key to a TEMP env var / temp file
       under the OS temp dir, NEVER the repo, NEVER a real key): `vh dataset sign --key-env` over a built manifest
       produces a container that `vh dataset verify-attest --signer <thatAddr> --manifest <m>` ACCEPTS; the same
       for `vh parcel sign`/`vh parcel verify-attest`; `--key-file` path works; neither/both key sources, a
       missing env var, and a malformed key each HARD-ERROR without writing an output and without leaking the key
       in the message; the output never contains the private key; `--json` round-trips. The suite leaves the
       working tree clean (no key files, no signed containers in the repo root). Full suite green.
- **T-19.3** `VERIFIED` Document the signing leg + SHARPEN the P-3/P-4 handoff to "one command". deps: T-19.1,
  T-19.2. files: docs/DATALEDGER.md, docs/PROOFPARCEL.md, README.md, STRATEGY.md (P-3/P-4 update),
  test/ (extend an existing docs-rot guard if cheap)
  - Acceptance: docs/DATALEDGER.md's "Signed attestation" subsection and docs/PROOFPARCEL.md document
    `vh dataset/parcel sign --key-env/--key-file` with the worked `attest → sign → verify-attest` example, the
    "read-only of a key YOU provisioned; never generates/persists/logs a key; offline; no network" property, and
    the inherited honest posture (a self-managed-key signature attests the IDENTITY + "the signer says so", NOT a
    trusted timestamp — that still rides P-3/B/C). README's command tables list the two `sign` subcommands.
    STRATEGY.md P-3 and P-4 are UPDATED to reflect that the loop now also ships the SIGNING command, so the human
    handoff for Option (A) collapses to: "(1) pick A/B/C; (2) PROVISION a real key outside the loop; (3) run
    `vh dataset/parcel sign --key-env <VAR>` (or `--key-file`) — DONE, the buyer verifies with the existing
    verify-attest." Reuses the shared TRUST_NOTE wording so caveats never drift. No new runtime behaviour; pure
    documentation of T-19.1/T-19.2 plus the proposal sharpening.

## EPIC-20 — Independent timestamp proof: the RFC-3161 envelope + offline verifier  *(turn "the publisher says so" into "an independent authority attests existed-by-date-T" — P-3 Option B, the enterprise upgrade a paying buyer actually needs)*

*Motivation (Strategist 2026-06-23): VALUE-CEILING break by attacking the RIGHT dimension of the blocker, NOT
another increment. Frontier is EMPTY (EPIC-13..19 all VERIFIED, 1166+ tests green) and the last FIVE metrics
lines are a hard ceiling — avgUsefulness FLAT at 4.0, minUsefulness stuck at 4, `humanGated` standing 3→4→3
across runs. Per the directive, a persistent humanGated count is a VALUE CEILING: prefer auto-buildable work
that DE-RISKS / DIRECTLY UNBLOCKS the real value once the human acts. The dam is P-3 (the signing/TIMESTAMP
trust-root — the income product's single biggest unlock, shared by BOTH products).*

*The gap I found (confirmed against the code, not invented). EPIC-15/17/19 EXHAUSTIVELY built P-3's SIGNATURE
dimension (Option A): the canonical UNSIGNED payload, the signed-container FORMAT, the offline verifier, AND
the one-command `vh dataset/parcel sign` — all proved end-to-end with ephemeral keys. But Option A is the
HONESTLY-WEAK trust-root: a self-managed signature attests only "the publisher SAYS SO" — it is NOT a trusted
TIMESTAMP. The single MOST-REPEATED limitation across the whole product (docs/DATALEDGER.md, every in-band
TRUST_NOTE, P-3's own text) is "a manifest is NOT a timestamp: it cannot make the 'unaltered since date T'
claim an EU-AI-Act / due-diligence reviewer ultimately wants." P-3 names Option (B) — an independent RFC-3161
Timestamp Authority / transparency log — as the ENTERPRISE upgrade that actually delivers an independent
"existed by date T." I grepped all of cli/ + docs/ + test/: there is ZERO timestamp-token handling anywhere
(no RFC-3161, no TSA, no TST/TSR parsing). So unlike the signature dimension — which has a format AND a
verifier — the TIMESTAMP dimension has NEITHER. That is the unbuilt half of P-3, and it is the half that
carries the actual buyer-relevant claim.*

*The guardrail-safe insight (the EPIC-17 move, applied to the TIMESTAMP instead of the SIGNATURE). The loop
must NEVER obtain a real timestamp token — getting one requires an outward network request to a real TSA
service (a human-owned relationship / possibly paid), so OBTAINING a token stays human-gated, exactly like
PROVISIONING a key did. But the loop CAN, with NO network and NO new trust it must hold: (1) DEFINE the
detached timestamp-token CONTAINER format — a sibling of the signed-attestation envelope that WRAPS the exact
canonical attestation bytes' digest + an RFC-3161 timestamp token (the DER `TimeStampToken`), never editing
the attestation; and (2) build an OFFLINE VERIFIER that parses the token's `TSTInfo`, confirms its
`messageImprint` (hashAlgorithm + hashedMessage) binds EXACTLY the digest of the buyer's own canonical
attestation bytes, and extracts/reports the asserted `genTime` + TSA `serialNumber` + policy OID — proving
sign→timestamp→verify works and pinning the exact envelope, WITHOUT the loop ever calling a TSA. This converts
P-3 Option (B)'s handoff from "design a timestamp envelope AND obtain a token AND build a verifier" to purely
"OBTAIN a token from your chosen TSA over the digest `vh ... timestamp-request` emits, wrap it with
`vh ... timestamp-wrap`, DONE — any buyer verifies offline with `vh ... verify-timestamp`."*

*Scope boundary (stated explicitly so it never overclaims). The verifier proves the messageImprint binds the
attestation AND surfaces the asserted genTime/serial/policy. It does NOT validate the TSA's X.509 certificate
CHAIN to a trusted root — that is the human trust anchor (you TRUST your chosen TSA's published cert), exactly
mirroring how Option A's signer-address pinning is a human step. The verifier states in-band that genTime is
"as asserted by the TSA whose cert you trust" and that full PKI chain validation is out of scope (use your
platform's CMS verifier / openssl `ts -verify` for the chain if you require it). This is the honest, bounded
claim — and it is still a MATERIALLY stronger trust-root than Option A: an INDEPENDENT third party (not the
publisher) attests the digest existed by genTime.*

*Why this beats the alternatives. (a) Another DataLedger/ProofParcel descriptive increment is the capped vein
the plateau warns against. (b) EPIC-3 reputation is BLOCKED on D-2 (P-1, human-only). (c) More signature-side
or P-3 prose work is DONE — Option A is fully shipped. Option B is the UNBUILT half of the same blocker and
the one a paying buyer actually pays for; building its format + offline verifier is the exact de-risking the
value-ceiling directive asks for, on the SHARED core, for BOTH products. It is a genuinely NEW capability
(independent timestamp proof), not polish.*

*Guardrails respected: pure-local, OFFLINE, no funds, no deploy, no token framing — nothing touches
D-2/EPIC-3/EPIC-4 or REVENUE INTEGRITY. The loop NEVER calls a TSA, holds no token of its own, and generates
none — the only timestamp tokens that appear in tests are SELF-MINTED throwaway test tokens produced in-process
(a test-only mock TSA using an ephemeral key, NEVER a real TSA, NEVER real funds), the timestamp analogue of
the ephemeral `Wallet.createRandom()` keys EPIC-17/19 use. No new runtime dependency: RFC-3161 token parsing is
a small, pure, bounded DER reader (SEQUENCE/OID/INTEGER/OCTET-STRING/GeneralizedTime) over the fields we need —
no X.509 chain code, no network. The UNSIGNED attest, signed-attest, sign, and verify-attest paths and ALL
their tests stay byte-for-byte green (timestamp wrapping is purely additive). P-3 Option (B) itself stays
human-gated (obtain the token from a real TSA); EPIC-20 ships only the request-digest, the wrap container, and
the offline verifier.*

- **T-20.1** `VERIFIED` Minimal, pure RFC-3161 token reader + the `messageImprint` binding check (no network, no
  X.509 chain). deps: T-17.1 (VERIFIED), T-18.3 (VERIFIED). files: cli/core/rfc3161.js (new),
  test/cli.core.rfc3161.test.js (new)
  - Problem: nothing in the codebase can read an RFC-3161 timestamp token or confirm it binds a given digest.
    This is the pure crypto foundation the wrap/verify commands sit on; it must live ONCE in the shared core
    so BOTH products use the identical, tested implementation.
  - Acceptance:
    1. `cli/core/rfc3161.js` exposes a small, PURE, dependency-free DER reader sufficient for the RFC-3161
       `TimeStampToken` path: parse a CMS `ContentInfo` (SignedData) whose eContentType is `id-ct-TSTInfo`,
       reach the embedded `TSTInfo` (a DER OCTET STRING), and extract `{ version, policyOID, messageImprint:
       { hashAlgorithmOID, hashedMessage(hex) }, serialNumber(hex/decimal), genTime(ISO-8601 UTC) }`. The DER
       reader handles exactly the needed types (SEQUENCE, OID, INTEGER, OCTET STRING, GeneralizedTime, plus
       context/explicit tags it must traverse) and REJECTS malformed/truncated DER with a clear error (never
       silently returns a partial/wrong field). No X.509/certificate-chain parsing, no signature-over-TSTInfo
       verification of the TSA's own cert (explicitly OUT — documented as the human trust-anchor step), no
       network.
    2. A `bindsDigest({ token, expectedDigestHex, expectedHashOID })` helper returns true ONLY when the parsed
       `messageImprint.hashedMessage === expectedDigestHex` (lowercased, exact) AND the hashAlgorithm OID
       matches the expected one (e.g. SHA-256 `2.16.840.1.101.3.4.2.1`), else false — so a token over a
       DIFFERENT digest, or under a different hash algorithm, never binds. `genTime` is parsed to a canonical
       ISO-8601 UTC string (RFC-3161 GeneralizedTime, `YYYYMMDDHHMMSS[.fff]Z`), rejecting non-UTC/zoneless
       forms.
    3. A test-only `mintTestToken({ digestHex, hashOID, genTime, serial, policyOID })` helper (clearly marked
       TEST-ONLY, in the test file or a `__testutil` not shipped on the command path) DER-encodes a minimal
       valid `TimeStampToken`/`TSTInfo` over a given digest so the suite can exercise the reader WITHOUT a real
       TSA and WITHOUT a network — the timestamp analogue of `Wallet.createRandom()`. It uses NO real TSA and
       NO real funds.
    4. Tests: round-trip a minted token through the reader and assert every extracted field; `bindsDigest`
       returns true for the matching digest+OID and false for a one-bit-flipped digest or a different
       hashAlgorithm OID; truncated/garbage DER and a token whose eContentType is NOT id-ct-TSTInfo each error
       clearly; a GeneralizedTime is parsed to the exact ISO UTC instant. Full suite green; `npx hardhat test`
       unchanged in command.
- **T-20.2** `VERIFIED` The detached timestamp container engine + `vh dataset/parcel timestamp-request` (emit the
  digest a TSA stamps). deps: T-20.1, T-19.1 (VERIFIED). files: cli/core/attestation.js (or a new
  cli/core/timestamp.js), cli/dataset.js, cli/parcel.js, cli/vh.js,
  test/cli.core.timestamp.test.js (new), test/cli.dataset.attest.sig.test.js, test/cli.parcel.test.js
  - Problem: to get a token from a TSA the human needs the EXACT digest to stamp, and the project needs a
    detached container format to carry the returned token bound to the attestation — neither exists.
  - Acceptance:
    1. A shared timestamp-container engine (a sibling of attestation.js, parameterized by the product's framing
       just like `signAttestation`): define the DETACHED `verifyhash.*-attestation-timestamped` container
       `{ kind, schemaVersion, note, attestation:<canonical UNSIGNED string>, timestamp: { scheme:"rfc3161",
       hashAlgorithm:"sha256", digest:<hex>, token:<base64 DER> } }`, with a strict validator that re-validates
       the embedded canonical attestation via the product's `validateUnsigned` + byte-equality check (the SAME
       wrap-don't-edit invariant the signed envelope enforces), validates the token parses via T-20.1, and
       confirms `bindsDigest(token, digest)` AND that `digest === sha256(canonical attestation bytes)` (the
       digest is over the EXACT bytes the buyer can re-derive). NOTE the hash algorithm here is **SHA-256**,
       NOT the project's internal keccak256 `manifestDigest`: RFC-3161 TSAs stamp a `messageImprint` over a
       standard hash (SHA-256 is universal; keccak256 is non-standard and most TSAs will reject it), so the
       timestamp digest is a FRESH `sha256(utf8(canonical attestation string))` computed via Node's
       `crypto.createHash("sha256")` — do NOT reuse the keccak `manifestDigest`. Optionally support wrapping
       over a SIGNED container's bytes too (timestamp-of-signature) — builder's call, documented either way.
    2. `vh dataset timestamp-request <manifest> [--out <p>] [--json]` (and `vh parcel timestamp-request`):
       build the UNSIGNED payload exactly as `attest` does (reuse the path — no re-impl), compute the canonical
       bytes, emit the SHA-256 digest (hex) the human submits to their TSA, plus a ready-to-use note on how to
       produce the token (e.g. `openssl ts -query`/their TSA client) — read-only, NO key, NO network. This is
       the "here's exactly what to stamp" half of the human handoff. AND `vh dataset timestamp-wrap <manifest>
       --token <path|base64> [--out <p>] [--json]` (and `vh parcel timestamp-wrap`): take the RFC-3161 token
       the human obtained from their TSA, build the container via the engine above (binding it to the
       re-derived canonical digest), and write the validated `*-attestation-timestamped` container — erroring
       clearly if the token does not bind the digest. No key, no network.
    3. The command leads with the inherited TRUST_NOTE plus the timestamp-specific caveat (a timestamp token
       attests an INDEPENDENT TSA saw this digest by genTime — to the strength of the TSA you TRUST; the loop
       does not validate the TSA cert chain). Flag/usage parity with the other subcommands (typo'd flag
       hard-errors). Without these commands every existing dataset/parcel test passes byte-for-byte.
    4. Tests: `timestamp-request` over a built manifest emits a digest that equals sha256 of the canonical
       attestation bytes; the container engine builds + validates a container from a MINTED test token
       (T-20.1) bound to that digest, and REJECTS a container whose token binds a different digest, whose
       embedded attestation was edited, or whose `digest` != sha256(bytes). `--json` round-trips. Suite green.
- **T-20.3** `VERIFIED` `vh dataset/parcel verify-timestamp <container>` — the OFFLINE independent-timestamp
  verifier, + docs + P-3 sharpen. deps: T-20.1, T-20.2. files: cli/dataset.js, cli/parcel.js, cli/vh.js,
  docs/DATALEDGER.md, docs/PROOFPARCEL.md, README.md, STRATEGY.md (P-3 update),
  test/cli.dataset.attest.sig.test.js, test/cli.parcel.test.js
  - Problem: a buyer handed a timestamped container has no command to confirm the token genuinely binds the
    dataset/parcel identity and to read the asserted "existed by" time.
  - Acceptance:
    1. `vh dataset verify-timestamp <container> [--manifest <m>] [--json]` (and `vh parcel verify-timestamp`),
       read-only / OFFLINE / NO key / NO network: re-derive the canonical attestation bytes from the embedded
       payload (and, with `--manifest`, additionally re-derive from the buyer's OWN manifest and require it to
       match — binding the token to the buyer's data, exactly like verify-attest's `--manifest`), confirm
       `digest === sha256(bytes)`, parse the token (T-20.1), confirm `bindsDigest`, and print ACCEPTED with the
       asserted `genTime` (ISO UTC), TSA `serialNumber`, and policy OID — or REJECTED naming which check failed.
       Use the existing 0/3 CI-exit convention (`vh dataset verify`/`verify-attest`) so all gates share one
       exit contract.
    2. Output leads with the honest, bounded claim: "ACCEPTED means an RFC-3161 TSA asserted this exact dataset/
       parcel identity (digest) existed by <genTime>; this is as trustworthy as the TSA whose certificate YOU
       trust — this command does NOT validate the TSA's certificate chain (use your platform's CMS verifier for
       full PKI validation)." Never prints "unaltered since date T" without that qualification. A tampered
       token / mismatched digest / edited embedded attestation REJECTS (never a false ACCEPT). Flag/usage parity
       preserved.
    3. docs/DATALEDGER.md + docs/PROOFPARCEL.md document `timestamp-request → (obtain token from your TSA) →
       timestamp-wrap → verify-timestamp` with a worked example and the exact bounded trust claim; README's
       command tables list the new subcommands with the "offline, no key, no network" property. STRATEGY.md
       P-3 is UPDATED: the loop now ALSO ships the Option (B) FORMAT + offline VERIFIER (proved with minted
       test tokens, NEVER a real TSA), so Option (B)'s handoff collapses to "(1) pick a TSA you trust; (2) run
       `vh ... timestamp-request` to get the digest; (3) obtain a token from your TSA over that digest; (4) run
       `vh ... timestamp-wrap`; DONE — buyers verify offline with `vh ... verify-timestamp`." Reuses the shared
       TRUST_NOTE wording so caveats never drift.
    4. Tests: a MINTED-token container (test-only mock TSA, ephemeral key, NO real TSA) verifies ACCEPTED and
       reports the asserted genTime/serial; `--manifest` binds to the buyer's data and a DIFFERENT manifest
       REJECTS; a tampered token, a mismatched digest, and an edited embedded attestation each REJECT with the
       3-exit; `--json` round-trips; the offline verify needs no network. The suite leaves the working tree
       clean (no token/container files in the repo root). Full suite green.

## EPIC-21 — Make it INSTALLABLE: the `vh` command a paying customer can actually run  *(packaging/distribution — the product is currently non-installable and crashes when published)*

*Motivation (Strategist 2026-06-24): the build frontier is EMPTY (EPIC-13..20 all VERIFIED, 1066+ tests
green) and the metrics are a hard, FIVE-run plateau — avgUsefulness FLAT at 4.0, minUsefulness stuck at 4,
humanGated standing 3→3→3→4→3. Per the stagnation directive this is correct-but-low-leverage work: EPICs
15-20 built ever-more-elaborate trust-root infrastructure (signature format + verifier + sign command, then
the same trio for RFC-3161 timestamps) for BOTH products. That dimension is now EXHAUSTED — P-3 Options A and
B are both fully shipped and collapsed to "provision/obtain, run one command." Building a third variation is
the capped vein. The directive says: change approach MATERIALLY — a capability that UNLOCKS NEW VALUE, or
remove what isn't paying off. I surveyed package.json + cli/ and found a foundational, overlooked defect that
is materially higher-leverage than any trust-root polish: THE PRODUCT IS NOT INSTALLABLE, and is BROKEN when
published. Confirmed against the code, not assumed:*
  1. *No `bin` field.* `cli/vh.js` has a `#!/usr/bin/env node` shebang, but package.json declares NO `bin`.
     So `npm install -g verifyhash && vh dataset build ...` — the EXACT UX every doc/README/in-band help
     line documents (the whole product family is "the `vh` CLI") — DOES NOT WORK. There is no `vh` command
     after install. The product can only be run as `node cli/vh.js` from a git checkout.
  2. *`ethers` is an UNDECLARED runtime dependency.* The CLI does `require("ethers")` in 34 places across
     cli/*.js + cli/core/*.js, but `ethers` is NOT in `dependencies` — it only resolves transitively via the
     `@nomicfoundation/hardhat-toolbox` DEV dependency. A customer who runs `npm install verifyhash` gets a
     package that CRASHES with `Cannot find module 'ethers'` on first use. The published product is broken.
  3. *No `files` allowlist.* `npm pack` would ship hardhat.config, test/, contracts/, scripts/, scratch — not
     a clean CLI package. No `engines` (Node floor) is declared either.
*This is the difference between "40 internal scripts that only run from a git checkout" and "a product a
paying customer can `npm install` and run as documented" — the prerequisite for EVERY monetization path in
P-3/P-4 (a design-partner evaluation, an on-prem license, a metered pipeline all START with the buyer
installing it and running `vh`). It is pure-local, offline, no funds/deploy/token/contract change, and fully
test-gateable. NOT another increment in the trust-root vein.*

- **T-21.1** `VERIFIED` Make `vh` a real installable command + a publishable, runnable package (bin + declared
  deps + files allowlist + engines), gated by a packaging-integrity test. deps: none. files: package.json,
  cli/vh.js, test/cli.packaging.test.js (new), README.md
  - Problem: `npm install verifyhash` produces NO `vh` command (no `bin`) and CRASHES at runtime (`ethers`
    is an undeclared, dev-only transitive dependency). The product is non-installable and broken-when-published.
  - Acceptance:
    1. package.json declares `"bin": { "vh": "cli/vh.js" }` (or "./cli/vh.js") pointing at the existing
       shebanged entrypoint, so `npm link` / a global install creates a working `vh` on PATH. `cli/vh.js`
       keeps its `#!/usr/bin/env node` shebang and remains executable (file mode +x committed). Invoking the
       linked `vh --help` prints the same usage block as `node cli/vh.js --help` (no behavioural change).
    2. `ethers` is moved to a REAL `"dependencies"` entry with a version range matching the one actually
       resolved today (pin to the major the code uses; confirm the linked command runs an on-chain-free
       command — e.g. `vh hash <file>` or `vh dataset build` — successfully with ONLY `dependencies`
       installed). `js-sha3` stays a declared dependency (used by cli/hash.js). Do NOT add any new dependency
       beyond making the already-used `ethers` explicit. Hardhat/toolbox stay devDependencies.
    3. package.json gains a `"files"` allowlist that ships EXACTLY what the CLI needs at runtime (cli/ — incl.
       cli/core/ — plus README/LICENSE/docs as desired) and EXCLUDES test/, contracts/, scripts/,
       hardhat.config.*, and scratch, so `npm pack` produces a clean CLI tarball. Add an `"engines": { "node":
       ">=<floor>" }` reflecting the lowest Node the code is known to run on (pick a conservative, documented
       floor — e.g. the version features like `structuredClone`/native fetch/whatever the code relies on
       require; if unsure, >=18). The `"test": "hardhat test"` script and the test COMMAND (`npx hardhat
       test`) are UNCHANGED.
    4. A new `test/cli.packaging.test.js` (pure, no chain/network) GUARDS the above so they can never silently
       regress: asserts package.json has `bin.vh` resolving to an existing, shebanged file; asserts `ethers`
       and `js-sha3` are in `dependencies` (NOT only devDependencies); asserts `@nomicfoundation/hardhat-
       toolbox`/`hardhat` are NOT in `dependencies` (they stay dev); asserts a `files` allowlist exists and
       includes `cli` (or `cli/**`) and does NOT include `test`/`contracts`; asserts `engines.node` is
       present; and asserts EVERY top-level runtime `require("<bare-module>")` in cli/*.js + cli/core/*.js
       (excluding Node built-ins) is a declared `dependencies` entry — so a future undeclared dependency fails
       the gate. (Built-in modules: fs, path, crypto, child_process, etc. — exclude via a built-in list /
       `require('module').isBuiltin`.)
    5. README gains a short, accurate Install/Quickstart note: `npm install -g verifyhash` (or `npx
       verifyhash`) → `vh --help`, replacing/clarifying any implication that you must clone the repo. The
       prose must match what the package actually ships (don't promise a registry publish — that's a human
       step; document the LOCAL install path `npm install -g .` / `npm link` and note publishing to npm is a
       human action). Full suite green; `npx hardhat test` unchanged in command.

- **T-21.2** `VERIFIED` Ship a runnable, self-checking end-to-end EXAMPLE a buyer/evaluator (and CI) can execute
  to see the DataLedger + ProofParcel pipeline actually work against sample data. deps: T-21.1. files:
  examples/ (new: sample data + a runnable script), test/cli.examples.test.js (new), README.md,
  docs/DATALEDGER.md, docs/PROOFPARCEL.md
  - Problem: the product family has 40 commands and 11 docs, but NO runnable end-to-end demonstration. A
    design-partner evaluator (P-4) or a buyer's procurement reviewer (P-3) has nothing they can RUN in one
    step to watch the real pipeline produce + verify the evidence artifacts. Worked examples live only as
    prose in docs, which can silently drift from behaviour.
  - Acceptance:
    1. Add `examples/` with a tiny, committed SAMPLE dataset and a SAMPLE parcel (a handful of small text
       files — NO secrets, NO large blobs) and a single runnable, OFFLINE, no-key, no-network script (Node,
       reusing the same module entrypoints the CLI uses — NOT a shell pipeline of brittle string parsing)
       that exercises the real buyer pipeline END TO END: for DataLedger `dataset build → check --policy →
       report` (and `attest` to emit the canonical unsigned bytes); for ProofParcel `parcel build → verify →
       attest`. It writes its outputs to an OS temp dir / a gitignored examples output path (NEVER scattering
       artifacts into the repo) and prints a clear PASS/FAIL summary with the produced artifact paths. It uses
       ONLY the offline commands (no signing key, no TSA, no RPC) so anyone can run it with zero setup; it
       references (but does NOT execute) the human-gated `sign`/`timestamp`/anchor steps in its output so an
       evaluator sees where the trust-root handoff is.
    2. A new `test/cli.examples.test.js` RUNS the example end-to-end against the committed sample data in a
       temp workspace and asserts: the pipeline completes, the expected artifacts are produced, a deliberate
       policy VIOLATION in the sample (or an injected one) is correctly FLAGGED by `check --policy` (exit 3),
       a TAMPER (mutate one sample file) is correctly caught by `dataset/parcel verify` as CHANGED, and the
       example leaves the repo working tree CLEAN (zero stray artifacts). This makes the example a living,
       test-gated demo that cannot rot.
    3. README links the example as the Quickstart ("clone/install, then `node examples/run.js` to see the
       full pipeline"); docs/DATALEDGER.md and docs/PROOFPARCEL.md cross-link it as the executable companion
       to their worked-example prose. The example LEADS with the standing TRUST_NOTE so it never overclaims
       (it demonstrates tamper-evidence + the unsigned attestation bytes; "unaltered since date T" still rides
       the human-owned trust-root — and the script SAYS so). No new dependency; offline; no funds/deploy/key.
    4. Full suite green; `npx hardhat test` unchanged in command.

## EPIC-27 — TrustLedger WEB UI  *(NEW TOP PRIORITY — turn the CLI into something a non-technical broker can actually use; usability is the gating step to a sellable product, see STRATEGY.md "## Direction" 2026-06-24)*

*Build this BEFORE further backend polish. A property-management broker will never use a terminal; the reconciliation
engine is complete and robust, but it's unusable without a screen. Build a thin, dependency-FREE web front-door over
the EXISTING `trustledger/` engine: open a page → drag 3 files → see the three balances tie out (or not) → download the
audit packet. Pure Node stdlib `http` (NO Express/new deps), vanilla HTML/JS (no framework/build step), Mocha tests
under `npx hardhat test`. Code under `trustledger/`; tests under `test/`. The loop BUILDS + locally TESTS the server;
hosting/deploy (nginx/Cloudflare) stays a human step (needs-human). No crypto/token.*

- **T-27.1** `VERIFIED` `trustledger/server.js` — a minimal stdlib HTTP server over the existing engine. deps: T-22.4 (VERIFIED).
  files: trustledger/server.js (new), test/trustledger.server.test.js (new)
  - Acceptance: pure Node `http` (no new deps). `GET /` serves the static upload page; `POST /api/reconcile` accepts a
    JSON body `{bank, ledger, rentroll, state?, priorClose?}` (file CONTENTS as text strings — the browser reads the
    files, so no multipart parsing needed), runs the existing ingest→match→reconcile→report pipeline, and returns JSON
    `{tiesOut, balances, exceptions, reportHtml, reportCsv}`. Malformed/oversized input → HTTP 400 with a named JSON
    error (never a stack trace); the server never writes to cwd. Tests start the server on an ephemeral port (then
    close it), POST the e2e fixture contents and assert `tiesOut:true` + the three balances; POST the short rent-roll
    and assert out-of-trust; POST a malformed file and assert a 400 named error. Full suite green.
- **T-27.2** `VERIFIED` `trustledger/public/index.html` — the single-page front-end. deps: T-27.1.
  files: trustledger/public/index.html (new, inline vanilla JS — no framework/build), test/trustledger.ui.test.js (new)
  - Acceptance: one self-contained page with three file inputs (bank / QuickBooks ledger / rent-roll), an optional
    state selector, and a "Reconcile" button that reads the files as text and POSTs them to `/api/reconcile`, then
    renders a clear PASS/FAIL banner, the three balances, the exception table, and download links for the HTML + CSV
    packet. A contract test pins the page's posted JSON keys and the rendered result fields to the server's response
    shape (so the UI and `/api/reconcile` can't silently drift). Full suite green.
- **T-27.3** `VERIFIED` `vh trust serve [--port <n>]` + docs. deps: T-27.1, T-27.2.
  files: trustledger/cli.js or cli/vh.js wiring, docs/TRUSTLEDGER.md (or new docs/TRUSTLEDGER-WEB.md), test/trustledger.serve.test.js (new)
  - Acceptance: `vh trust serve` launches the local server (configurable `--port`, default e.g. 4173) and prints the URL;
    a test starts it, `GET /` returns the upload page, then closes it. Docs cover: how a broker runs it locally, the
    file privacy posture (files are processed in-memory, nothing persisted server-side unless `--out` is given), and a
    clearly-marked HUMAN deploy step (put it behind nginx/Cloudflare on your own domain — never auto-deployed). Suite green.

## EPIC-28 — TrustLedger WEB onboarding: make a real broker's file load in the browser  *(close the pilot-killing dead-end on the EXACT surface a non-technical broker uses; see STRATEGY.md "## Direction" 2026-06-24)*

*Motivation (Strategist 2026-06-24): the operator pivoted to usability ("the web door is what turns a terminal tool
into a product a broker can use") and EPIC-27 shipped the web front-door — but the web surface re-introduces the EXACT
pilot-killer EPIC-25 spent a whole epic eliminating on the CLI. When a real broker drops a file whose headers don't
match the alias lists (a QuickBooks "Transaction Detail by Account" export; a bank "Withdrawal Amt."/"Credit Amt."
column; a rent-roll "Tenant Name"+"Amount Paid"), `trustledger/server.js` › `reconcilePayload` calls the STRICT
parsers (`parseBankStatement`/`parseQuickBooksCSV`/`parseRentRollCSV`, server.js:146-151), the first miss throws an
`IngestError`, and the UI renders a raw `Error (ingest_error): missing required column "date" in header` (index.html:
211-213) — with NO way to see what columns the file HAS, what mapped, or how to fix it. The broker who "will never use
a terminal" (the operator's own framing) CANNOT run `vh trust inspect` and CANNOT pass `--map`. The engine ALREADY has
the fix built + tested — `ingest.diagnoseSource(source, text, {columnMap})` reports the detected header, which column
mapped to each logical field, `requiredMissing`, row/ok counts, a sample, and every failing row, and accepts a
column-map override — but the web door does NOT expose it. So the single most likely thing to kill a P-5 #3 pilot
(ingest choking on a real export) is a self-service fix on the CLI and a dead-end wall in the browser. This EPIC wires
the EXISTING diagnose + column-map engine into the web surface: drop a file, and if it doesn't parse the page SHOWS
the detected columns and lets the broker MAP them — turning "the tool is broken" into "it loads, or it tells you how,"
in the browser. Pure Node stdlib + vanilla JS (no new dep, no framework), Mocha tests under `npx hardhat test`; code
under `trustledger/`, tests under `test/`. The STRICT reconcile path stays byte-for-byte fail-closed (a trust
reconciliation must never silently partial-parse); diagnose is a SEPARATE, additive read path. No crypto/token; hosting
stays a human step (P-5). This directly de-risks P-5 #3's literal first gate — does the broker's real export load? —
on the surface the broker actually uses.*

- **T-28.1** `VERIFIED` `POST /api/inspect` — expose the existing per-file diagnose over the web door, plus a column-map
  override. deps: T-27.1 (VERIFIED), T-25.1 (VERIFIED). files: trustledger/server.js, test/trustledger.server.test.js
  - Problem: the web door has only `/api/reconcile`, which FAILS CLOSED on the first parse miss with a raw error
    string. A non-technical broker has no in-browser way to see what columns their file has, what mapped, or to
    supply a one-off mapping — the exact dead-end `vh trust inspect`/`--map` removed on the CLI.
  - Acceptance:
    1. `POST /api/inspect` accepts a JSON body `{ source, text, columnMap? }` where `source` is one of the three
       logical types (bank / ledger|quickbooks / rentroll — accept the SAME spellings `/api/reconcile`'s file keys
       use, mapped to the engine's `SOURCE.*`), `text` is the file CONTENTS as a string, and `columnMap` is an
       OPTIONAL `{ <logicalField>: <headerName> }` override. It calls the EXISTING `ingest.diagnoseSource(source,
       text, { columnMap })` VERBATIM (NO re-implementation of parsing) and returns its report as JSON:
       `{ source, format, header, mapped, requiredMissing, rowCount, okCount, sample, errors }` (the diagnose
       report shape — confirm + pin the exact keys). The server NEVER writes to disk (diagnose is pure), same as
       `/api/reconcile`.
    2. Failure modes are NAMED 400s, never a stack trace, consistent with the existing door: an unknown `source`,
       a missing/non-string `text`, or a malformed `columnMap` (unknown logical key, or a header absent from the
       file — the SAME message the strict parser/`indexHeader` gives) returns `{ error, message }` with HTTP 400.
       A WELL-FORMED file that simply has unmatched columns is NOT a 400 — it returns HTTP 200 with the diagnose
       report (`requiredMissing` populated), because "your header is missing column X" is a self-service finding
       the UI renders, not a server error. Oversized body → the existing 413 path (reuse `readBody`/`MAX_BODY_BYTES`).
    3. The STRICT `/api/reconcile` path is UNCHANGED and stays fail-closed (a trust reconciliation never
       partial-parses). `/api/inspect` is a SEPARATE, additive, read-only diagnostic — it parses WITHOUT failing
       closed and reports every failing row, exactly as the CLI `vh trust inspect` does. The 404 route, the JSON
       error shape, and the no-cwd-write posture are preserved.
    4. Tests (extend test/trustledger.server.test.js, same ephemeral-port pattern): `POST /api/inspect` with a
       clean fixture file returns 200 with the right `header`/`mapped`/`okCount` and an empty `requiredMissing`;
       a file with a renamed/aliased-miss header returns 200 with that field in `requiredMissing` AND with the
       same body + a `columnMap` override returns 200 with `requiredMissing` now EMPTY and `mapped` naming the
       overridden column (proving the escape hatch works end-to-end over HTTP); an unknown `source` and a missing
       `text` each return a named 400; a malformed `columnMap` returns a named 400. Full suite green;
       `npx hardhat test` unchanged in command.
- **T-28.2** `VERIFIED` Web UI: on a parse failure, show the detected columns and let the broker MAP them, then reconcile.
  deps: T-28.1, T-27.2 (VERIFIED). files: trustledger/public/index.html, test/trustledger.ui.test.js
  - Problem: index.html renders a raw `Error (ingest_error): ...` string on any parse miss with no recovery — the
    in-browser dead-end. The broker can't see their file's columns or fix the mapping without a terminal.
  - Acceptance:
    1. The page gains an "Inspect / fix a file" affordance (a per-file "Check this file" action, or an automatic
       fallback when `/api/reconcile` returns an `ingest_error`): it reads the chosen file as text and POSTs
       `{ source, text }` to `/api/inspect`, then renders the diagnose report — the detected `header`, a
       field→column `mapped` table, the `requiredMissing` list, `rowCount`/`okCount`, and the first failing rows
       from `sample`/`errors` — in a clear, non-technical layout (no stack traces, no JSON dumped raw).
    2. When a logical field is in `requiredMissing`, the UI offers a SELECT per missing field populated from the
       file's actual `header`, letting the broker pick which column means `date`/`amount`/etc. Choosing builds a
       `columnMap` and re-POSTs `/api/inspect` to confirm the miss clears; the assembled `columnMap` is then
       threaded into the reconcile request (see #3) so the fix applies to the actual run, not just the preview.
    3. CONTRACT preserved + extended: `/api/reconcile` accepts an OPTIONAL per-file `columnMap` so a mapping fixed
       in inspect is honoured by the real run. (If wiring per-file maps into `/api/reconcile` is out of scope for
       the UI change alone, T-28.1's acceptance is extended to add an optional `maps?: { bank?, ledger?, rentroll? }`
       to `reconcilePayload`, passed through to the strict parsers as their `columnMap` — keep the existing no-map
       behaviour byte-for-byte unchanged.) Pin the new posted keys and the rendered inspect fields in the UI
       contract test so the page and the two endpoints can't silently drift (mirroring the existing
       postedKeys/response-shape pins).
    4. The page stays ONE self-contained `trustledger/public/index.html` (no framework, no CDN, inline vanilla JS),
       and the existing PASS/FAIL + balances + exceptions + download flow is unchanged when files parse on the
       first try (no regression to the EPIC-27 happy path). The standing custodian disclaimer is unchanged.
    5. Tests (extend test/trustledger.ui.test.js, same static-analysis + against-the-real-server pattern): the page
       references `/api/inspect`; the keys it POSTs to inspect/reconcile match what the server reads (no silent
       drift); a contract test drives the real server with an aliased-miss file through inspect → map → reconcile
       and asserts the mapped run ties out (or at least parses) where the un-mapped run 400'd. Full suite green.
- **T-28.3** `VERIFIED` Document the web onboarding flow + SHARPEN P-5 #3 so the design-partner script's onboarding step
  is the BROWSER, not the terminal. deps: T-28.1, T-28.2. files: docs/TRUSTLEDGER.md (the web section), README.md,
  STRATEGY.md (P-5 #3), test/ (extend an existing docs-rot guard if one is cheap)
  - Acceptance: docs/TRUSTLEDGER.md's web section documents the in-browser inspect/map flow (drop a file → if it
    doesn't load, see its columns and map them → reconcile) as the non-technical onboarding path, alongside the
    existing CLI `vh trust inspect`/`--map`. P-5 #3 is SHARPENED so the two-month design-partner script's FIRST
    step ("confirm each file parses, fixing any header miss") is the BROWSER inspect/map UI for a non-technical
    broker — not a terminal command — closing the gap between "the buyer who will never use a terminal" and "the
    onboarding step that currently requires one." Reuses the existing TRUST-BOUNDARIES/disclaimer wording so the
    posture stays consistent (the seal/timestamp trust-root, the CPA review, hosting, pricing all stay
    human/P-5). No new runtime behaviour; pure documentation of T-28.1/T-28.2.

## EPIC-29 — TrustLedger: the entitlement layer  *(the missing mechanism that makes the engine SELLABLE — see STRATEGY.md "## Direction" 2026-06-24)*

*Motivation (Strategist 2026-06-24): metrics REGRESSED (avgUsefulness 4.0 → 3.5 → 3.75, minUsefulness stuck at 3)
with humanGated STANDING at 3 for six straight runs — a persistent VALUE CEILING — and the build frontier is EMPTY
(EPIC-22..28 all VERIFIED, ~1400+ tests green). Eight consecutive TrustLedger increments (engine, policy, close,
ingest robustness, seal, web door, web onboarding) all orbited the SAME P-5 go-to-market dam, and the directive for
flat-and-mediocre-WITH-persistent-humanGated is explicit: change approach MATERIALLY toward a capability that unlocks
NEW value, and do NOT re-sharpen the already-decision-ready P-5. So this is a genuinely DIFFERENT KIND of work.*

*The gap I found (confirmed in code, not invented): I grepped all of `trustledger/*.js` + `cli/*.js` for
license|subscri|billing|trial|quota|meter|entitle|tier|plan|expir — ZERO hits (every "usage" match is an exit-2
USAGE error, not usage metering). The product has a correct, sealed, web-served reconciliation engine but NO mechanism
to distinguish a PAYING customer from anyone who downloaded the repo, and NO way to deliver the paid value behind a
plan. Every prior Strategist correctly kept OUTWARD actions (hosting, Stripe, pricing) human-gated, but conflated
"charging money" (a human step) with "the local, offline mechanism that GATES value behind a paid plan and lets a
human DELIVER a purchased entitlement" (fully auto-buildable + test-gated). Without that mechanism there is literally
nothing to sell and no way to hand a paying broker what they bought — which is why eight engine increments could not
move the revenue needle.*

*The move (the project's OWN provenance core, repointed INWARD): a license is just a signed attestation. Reuse the
proven `cli/core/attestation.js` envelope VERBATIM (the SAME `buildSignedAttestation`/`verifySignedAttestation`/
`recoverSigner` the seal already uses) to mint and OFFLINE-verify a signed `*.vhlicense.json` whose payload is
`{licenseId, customer, plan, entitlements, issuedAt, expiresAt}`, signed by the VENDOR's offline key (human-held,
NEVER the loop's) and verified locally against a pinned vendor address — NO network, NO real funds, ephemeral
`Wallet.createRandom()` test keys only, exactly like the seal tests. The CLI + web door then GATE the paid value
(multi-state policy, sealing, unlimited reconciles) behind a valid, unexpired license, while a free tier (inspect +
N sample reconciles) stays open so a broker can try before they buy. This is the bridge from "correct engine" to
"sellable, deliverable product." The human's only new action — ISSUE a signed license to a paying customer + pick the
price — is a NEW, narrow, decision-ready ask (P-6 below), distinct from P-5; the auto-built tooling makes it a
one-command handoff. REVENUE INTEGRITY unchanged: income = a SaaS/license subscription for delivered value; NO
token/coin/sale/yield; the license is an ACCESS credential a paying customer receives, never a tradeable asset.*

*Why this beats the alternatives: (a) A NINTH engine/web increment is the capped vein the regression warns against.
(b) Re-sharpening P-5 #1/#2/#3 is the busywork the directive forbids — they are exhaustively sharp. (c) Hosting/Stripe
integration is an outward human step (stays P-6). The entitlement layer is the one auto-buildable thing that adds a
NEW kind of value (the product becomes monetizable + deliverable) on already-tested core, with the test gate intact.*

- **T-29.1** `VERIFIED` Pure license core: mint + OFFLINE-verify a signed `*.vhlicense.json` over the existing attestation
  envelope, with strict entitlement/expiry semantics. deps: T-26.1 (VERIFIED). files: trustledger/license.js (new),
  test/trustledger.license.test.js (new)
  - Problem: there is no artifact that distinguishes a paying customer from anyone with the repo, and no offline way to
    verify one. The project's own attestation core already does signed, offline-verifiable containers (the seal uses it).
  - Acceptance:
    1. `trustledger/license.js` is PURE/I-O-free and reuses `cli/core/attestation.js` VERBATIM (no new crypto, no new
       dependency). Define a versioned, strictly-validated license payload:
       `{ kind:"trustledger-license", schemaVersion, licenseId, customer, plan, entitlements:[...], issuedAt, expiresAt }`
       where `entitlements` is a closed set of string flags drawn from a single exported `ENTITLEMENTS` table (e.g.
       `multi_state_policy`, `seal`, `unlimited_reconcile`). `buildLicense({...}, signer)` canonicalizes the payload and
       wraps it in the EXISTING signed-attestation envelope (the payload bytes become the attestation payload), exactly
       as the seal does. A malformed/unknown entitlement, a missing required field, a non-ISO date, or `expiresAt <=
       issuedAt` is a hard error (never silently accepted) — mirror seal/receipt validation style.
    2. `verifyLicense(container, { now, vendorAddress })` (PURE, offline, NO network, NO key): re-derive the canonical
       payload, recover the signer via the EXISTING `recoverSigner`/`verifySignedAttestation`, and return a structured
       verdict — `valid` ONLY when (a) the envelope signature verifies, (b) the recovered signer EQUALS the pinned
       `vendorAddress` (a license signed by any other key is REJECTED, not trusted), and (c) `now` is within
       `[issuedAt, expiresAt]`; otherwise return a localized reason (`bad_signature` / `wrong_issuer` / `expired` /
       `not_yet_valid` / `malformed`). Expose a pure `hasEntitlement(verdict, flag)` that is false unless the verdict is
       valid AND the flag is present. The license is an UNTRUSTED transport container, consistent with TRUST-BOUNDARIES:
       verification RE-DERIVES; it never trusts the file's own claims.
    3. Tests (ephemeral `Wallet.createRandom()` keys ONLY — NEVER a real key/funds, exactly like the seal tests): a
       round-trip mint→verify with the matching vendor address is `valid` and carries the right entitlements; a license
       signed by a DIFFERENT key is `wrong_issuer`; a tampered payload byte flips it to `bad_signature`; an `expiresAt`
       in the past is `expired`; an `issuedAt` in the future is `not_yet_valid`; an unknown entitlement / bad date /
       missing field is rejected at build AND a hand-corrupted container is rejected at verify; `hasEntitlement` is false
       for any non-valid verdict. Full suite green; `npx hardhat test` unchanged in command.
- **T-29.2** `VERIFIED` `vh trust license issue|verify` + GATE the CLI's paid value behind a valid license (free tier stays open).
  deps: T-29.1. files: trustledger/cli.js, cli/vh.js, test/trustledger.license.cli.test.js (new)
  - Problem: minting/verifying a license must be a one-command handoff for the human vendor, and the paid engine value
    (multi-state policy + seal + unlimited reconciles) must actually be gated so there is something to sell.
  - Acceptance:
    1. `vh trust license issue --customer <name> --plan <plan> --entitlements <a,b,c> --expires <ISO>
       --key-env <VAR>|--key-file <path> [--out <file>]` builds + signs a license using a key the HUMAN supplies at
       runtime (read-used-discarded, NEVER written/logged/echoed — reuse the EXACT key-handling posture of `vh dataset
       sign`/EPIC-19, no key the loop holds, ephemeral test keys only in tests). Output prints ONLY the public vendor
       address + license summary + path. `vh trust license verify <file> --vendor <0xaddr> [--json]` is read-only,
       OFFLINE, no key: prints VALID/INVALID + reason + entitlements + expiry and a 0/3 exit (0 valid, 3 invalid),
       distinguishing the reason exactly as `verifyLicense` returns it.
    2. `vh trust reconcile` GATES the paid surface: passing `--license <file> --vendor <0xaddr>` unlocks the entitled
       features; WITHOUT a valid license, `--state`/`--policy` (multi-state) and `--seal` HARD-ERROR with an actionable
       "this feature requires a license — see `vh trust license`" message (exit 2, a clear gate, not a crash), and the
       FREE tier (baseline-policy reconcile + `vh trust inspect` + the web inspect/map) keeps working UNCHANGED so a
       broker can evaluate before buying. A missing/expired/wrong-issuer license on a gated feature reports the precise
       reason and refuses (never silently downgrades to a paid result). Neither/both key sources, malformed flags, and a
       malformed `--vendor` hard-error WITHOUT leaking the key (parser parity with existing commands).
    3. STRICTLY ADDITIVE: with NO `--license`/`--vendor` flags every existing EPIC-22..28 reconcile/inspect/seal test
       behaves byte-for-byte as today EXCEPT that a paid feature now requires the gate — so update only the tests that
       exercise `--state`/`--policy`/`--seal` to supply a freshly-minted ephemeral-key license + matching `--vendor`,
       and ADD tests proving the gate refuses without one. The free-tier baseline reconcile path stays unchanged.
    4. Tests (live where needed, ephemeral keys only): `issue` then `verify` round-trips VALID; `verify` against the
       wrong `--vendor` is INVALID/`wrong_issuer` (exit 3); `reconcile --state CA --seal` WITHOUT a license hard-errors
       at the gate (exit 2) naming the license requirement; the SAME run WITH a valid license produces the sealed,
       state-policied packet; an expired license refuses the gated feature; the free baseline reconcile + inspect run
       with no license at all. The key is never written/echoed. Full suite green.
- **T-29.3** `VERIFIED` Web door honours the license gate; document the entitlement model + add the human delivery proposal (P-6).
  deps: T-29.2. files: trustledger/server.js, trustledger/public/index.html, docs/TRUSTLEDGER.md, README.md,
  STRATEGY.md (add P-6), test/trustledger.license.web.test.js (new) (or extend trustledger.server.test.js)
  - Problem: the browser door must enforce the SAME gate the CLI does (a hosted free trial that silently gives away the
    paid features is the opposite of sellable), and the entitlement model + the human's one delivery action must be
    documented and made decision-ready WITHOUT auto-executing any outward step.
  - Acceptance:
    1. `trustledger/server.js`: `POST /api/reconcile` accepts an OPTIONAL `{ license, vendorAddress }` in the JSON body
       and threads the SAME `verifyLicense` gate as the CLI — a request asking for a gated feature (`state`/`policy`/
       seal) WITHOUT a valid license returns a NAMED 4xx (`license_required` / `license_invalid` with the precise
       reason), reusing the existing named-error/no-cwd-write posture; the FREE inspect + baseline reconcile routes stay
       open and unchanged. The server holds NO key and verifies offline (license verification needs only the pinned
       vendor address + the supplied container). The page shows a clear "this feature requires a license" notice rather
       than a raw error when the gate refuses.
    2. `docs/TRUSTLEDGER.md` gains an "Entitlements & licensing" section: the license payload schema (every field,
       trusted-vs-hint), the free-vs-paid surface, how a customer's tool verifies a license OFFLINE against the pinned
       vendor address, and a worked `issue → verify → reconcile --license` example; README links it. Reuse existing
       TRUST-BOUNDARIES wording (the license is an UNTRUSTED container; verification re-derives).
    3. STRATEGY.md gains **P-6 (needs-human)**: the NARROW, decision-ready human ask — (a) the human generates the
       VENDOR keypair OFFLINE (outside the loop), publishes/pins the vendor ADDRESS, and runs `vh trust license issue`
       to deliver a signed license to each PAYING customer; (b) pick the PRICE and the free-vs-paid entitlement split;
       (c) hosting + Stripe/billing remain the outward human steps. Make explicit that the loop ships ONLY the
       mint/verify/gate mechanism and ephemeral test keys — it NEVER provisions the real vendor key, sets a price, or
       takes payment. P-6 is distinct from P-5 (which stays the legal/CPA/design-partner gate); do NOT restate P-5.
    4. Tests: a contract test drives the real server with a gated request and asserts it 4xx's `license_required` with
       no license and succeeds with a valid one; a static-analysis test that the page references the license fields the
       server reads (no silent drift); a docs-rot guard that the schema in docs matches `ENTITLEMENTS`/the payload
       shape. Full suite green; `npx hardhat test` unchanged in command.

## EPIC-30 — Harvest the shared core into a SECOND income vertical not dammed behind P-5  *(material change of approach — see STRATEGY.md "## Direction" 2026-06-24)*

*Motivation (Strategist 2026-06-24): the metrics are a textbook QUALITY STAGNATION + VALUE CEILING. avgUsefulness has
REGRESSED across the last runs (4.0 → 3.75 → 3.5 → 3.75 → 3.75), minUsefulness is stuck at 3, and humanGated has
CLIMBED 3 → 3 → 3 → 3 → 5 — it is now GROWING, the worst form of the value ceiling. EPIC-22 through EPIC-29 are NINE
consecutive TrustLedger increments (engine → policy → close → ingest → seal → web → onboarding → entitlement) and ALL
of them dam behind P-5 (CPA/counsel sign-off + per-state trust-law research + design-partner brokers). P-5 cannot be
unblocked by ANY amount of building — it requires a human CPA and a human broker. So nine epics of correct work have
poured into a single vertical whose revenue is gated on an unmovable legal/commercial human decision; that is exactly
the "highest-leverage work dammed behind an unresolved human decision, forcing lower-leverage work around it" the
directive names. The directive's instruction for this state is explicit: change approach MATERIALLY toward a capability
that unlocks NEW value, and prefer auto-buildable work that DE-RISKS or directly unblocks the dam — not more increments
in the same vein. P-5 and P-6 are both exhaustively sharp; re-touching them is the forbidden busywork.*

*The material change (and why it is genuinely higher-leverage, not a tenth increment): the PROJECT GOAL explicitly
invites "a family of products built on shared, well-tested core infrastructure when that multiplies real value." The
loop has, in fact, already BUILT and TESTED two genuinely reusable horizontal primitives — but they are TRAPPED inside
the dammed TrustLedger vertical. (1) `trustledger/seal.js` content-addresses a set of files into a tamper-evident,
offline-verifiable packet — but it is hard-coupled to the reconcile packet (`SEAL_KIND = "trustledger.reconcile-seal"`,
a verdict/period header), so NO other product can produce a verifiable evidence packet without re-deriving it. (2)
`trustledger/license.js` mints + offline-verifies a signed entitlement token over `cli/core/attestation.js` — but it is
hard-coupled to TrustLedger (`kind: "trustledger-license"`, a closed TrustLedger-only entitlement table), so NO second
product can sell a license without forking it. Extracting BOTH into the project's shared `cli/core/` and shipping ONE
product-agnostic command on top opens a SECOND income vertical — "verifiable evidence packets for any compliance
artifact" — whose go-to-market is the EXISTING provenance line's P-3/P-4 path (obtain an offline key, land a B2B design
partner), which is MATERIALLY LIGHTER than P-5's per-state trust-LAW review and does NOT add to the same legal dam.
This is the one move that (a) is a NEW capability, not an increment of the capped vein, (b) converts already-paid-for
one-off code into the shared core the GOAL names, and (c) reaches revenue through a human gate that is NOT P-5.*

*Why this beats the alternatives considered: (a) A tenth TrustLedger increment is the capped vein the regression +
growing humanGated warn against — nine in a row plateaued then regressed. (b) Re-sharpening P-5/P-6 is forbidden
busywork; both are decision-ready. (c) Inventing a brand-new product from scratch ignores the project's own tested
core and re-incurs the cost the loop already paid. (d) DataLedger/ProofParcel (the original provenance line) is real
but its surface already exists; the missing capability that MULTIPLIES it is a generic, license-gated, tamper-evident
EVIDENCE PACKET — exactly what extracting the seal + license yields. Generalizing the two trapped primitives and
shipping `vh evidence` on top is the highest-leverage auto-buildable move on the board.*

*Guardrails respected: pure-local, offline, deterministic; NO crypto/token/coin/NFT/sale/yield, NO funds, NO deploy,
NO real key (ephemeral `Wallet.createRandom()` test keys ONLY, exactly as the seal/license tests already do). No new
dependency (reuses `cli/core/attestation.js` + `cli/core/manifest.js` verbatim). STRICTLY ADDITIVE + NON-REGRESSING:
the extraction re-points `trustledger/seal.js` and `trustledger/license.js` at the new shared cores as THIN adapters
that preserve their existing `SEAL_KIND`/`LICENSE_KIND` and byte-for-byte outputs, so every EPIC-26/29 test stays green
and the test COMMAND is unchanged. REVENUE INTEGRITY: income = a license/subscription for delivered evidence-packet
value; the license is an ACCESS credential a paying customer receives, NEVER a tradeable/appreciating asset. The
vendor key, pricing, hosting, billing, and any design-partner sale stay HUMAN steps (P-7 below, distinct from P-5/P-6).*

- **T-30.1** `VERIFIED` Extract a PRODUCT-AGNOSTIC signed-entitlement core (`cli/core/license.js`) and re-point
  `trustledger/license.js` at it as a thin adapter (no behaviour change). deps: T-29.1 (VERIFIED). files:
  cli/core/license.js (new), trustledger/license.js, test/core.license.test.js (new), test/trustledger.license.test.js
  - Problem: the entitlement mechanism (mint + offline-verify a signed `*.vhlicense.json` over the attestation envelope,
    with strict expiry/in-window semantics) is genuinely reusable, but `trustledger/license.js` hard-codes
    `kind: "trustledger-license"` and a closed TrustLedger-only entitlement table, so a SECOND product cannot sell a
    license without forking it.
  - Acceptance:
    1. `cli/core/license.js` exposes a PURE, I/O-free, product-PARAMETERIZED license core: `buildLicense`/`verifyLicense`/
       `validateLicense`/`serialize`/`read` that take the product's `kind`, `schemaVersion`, and a CLOSED entitlement
       table as an explicit `cfg` argument (mirroring how `cli/core/manifest.js` already takes a `cfg`), reusing
       `cli/core/attestation.js` VERBATIM for all crypto (no new crypto, no new dependency). `verifyLicense(container,
       { vendorAddress, now, cfg })` RE-DERIVES the signer, PINS it to `vendorAddress`, checks `[issuedAt, expiresAt]`
       against the explicit `now`, and returns a deterministic verdict with the SAME localized reject reasons the
       current code uses (`bad_signature`/`wrong_issuer`/`expired`/`not_yet_valid`/`malformed`/unknown-entitlement). An
       unknown entitlement flag (one not in the supplied `cfg` table) is a hard build REJECT, never silently honored.
    2. `trustledger/license.js` becomes a THIN adapter: it supplies the existing `LICENSE_KIND`
       (`"trustledger-license"`), `LICENSE_SCHEMA_VERSION`, and `ENTITLEMENTS` table as the `cfg` to `cli/core/license.js`
       and re-exports the same public surface, so its byte-for-byte mint/verify outputs and every reject reason are
       UNCHANGED. No TrustLedger caller changes.
    3. Tests: `test/core.license.test.js` proves the generic core with a SYNTHETIC product cfg (a different `kind` +
       a different entitlement table) round-trips mint→verify with ephemeral `Wallet.createRandom()` keys, pins the
       vendor (a different signer is `wrong_issuer`), rejects expired/not-yet-valid/malformed/unknown-entitlement, and
       is byte-deterministic for a fixed `now`. The EXISTING `test/trustledger.license.test.js` stays green UNCHANGED
       (proving the adapter preserves behaviour). Full suite green; `npx hardhat test` unchanged in command.
- **T-30.2** `VERIFIED` Extract a PRODUCT-AGNOSTIC tamper-evident packet-seal core (`cli/core/packetseal.js`) and re-point
  `trustledger/seal.js` at it as a thin adapter (no behaviour change). deps: T-26.1 (VERIFIED). files:
  cli/core/packetseal.js (new), trustledger/seal.js, test/core.packetseal.test.js (new), test/trustledger.seal.test.js
  - Problem: `trustledger/seal.js` content-addresses a file set into a tamper-evident, offline-verifiable packet — a
    genuinely reusable primitive — but it hard-codes `SEAL_KIND = "trustledger.reconcile-seal"` and a reconcile-specific
    verdict/period/role HEADER, so no other product can emit a verifiable evidence packet without forking it.
  - Acceptance:
    1. `cli/core/packetseal.js` exposes a PURE, I/O-free seal core: `buildSeal`/`validateSeal`/`verifySeal` over
       already-loaded `{ relPath, bytes }` entries, reusing `cli/core/manifest.js`'s hashing/path-leaf convention
       VERBATIM, parameterized by the product's `kind` + an OPTIONAL caller-supplied HEADER object (an opaque,
       canonicalizable `{ relPath, content }` pair the product binds into the SAME committed root). Per-file
       MATCH/CHANGED/MISSING/UNEXPECTED localization and the optional signed-attestation wrapping (proven with ephemeral
       keys) are preserved. No reconcile/verdict/period vocabulary in the core — that lives only in the caller's header.
    2. `trustledger/seal.js` becomes a THIN adapter: it supplies `SEAL_KIND` (`"trustledger.reconcile-seal"`) and builds
       its existing verdict/role HEADER, passing both to `cli/core/packetseal.js`, and re-exports the same public surface
       so its byte-for-byte seal outputs, the `__trustledger.seal-header__v1` sentinel, and every localized verdict/role
       change are UNCHANGED. No TrustLedger caller changes.
    3. Tests: `test/core.packetseal.test.js` proves the generic core with a SYNTHETIC product (a different `kind`, a
       plain file set with NO header, and a second case with a synthetic header) builds + verifies, localizes a
       CHANGED/MISSING/UNEXPECTED/ADDED file to the exact entry, detects a header edit, and round-trips the optional
       signed wrapping with ephemeral keys. The EXISTING `test/trustledger.seal.test.js` stays green UNCHANGED. Full
       suite green; `npx hardhat test` unchanged in command.
- **T-30.3** `VERIFIED` Ship `vh evidence seal <dir> [--out <p>] [--license <f> --vendor <addr>]` + `vh evidence verify <p>`:
  a product-agnostic, license-gated, tamper-evident evidence-packet command on the extracted cores; document it + add the
  human go-to-market proposal (P-7). deps: T-30.1, T-30.2, T-9.2 (VERIFIED). files: cli/evidence.js (new), cli/vh.js,
  docs/EVIDENCE.md (new), README.md, STRATEGY.md (add P-7), test/cli.evidence.test.js (new)
  - Problem: the extracted cores are reusable but have NO product surface outside TrustLedger — there is no way for the
    SECOND vertical (verifiable evidence packets for any compliance artifact: an export bundle, an audit folder, a
    deliverable) to be USED or SOLD. Without a command, the harvested core multiplies no value.
  - Acceptance:
    1. `vh evidence seal <dir> [--out <p>]` walks a directory (reusing the existing path-bound file enumeration; NEVER
       writes to cwd without `--out`; default prints the seal + verdict to stdout and writes nothing), builds a
       `*.vhevidence.json` over `cli/core/packetseal.js` with a generic product `kind` (NO trust-reconcile vocabulary),
       and emits a one-line summary + CI-gateable exit code (0 ok / 3 seal-build-error / 2 usage / 1 IO). `vh evidence
       verify <p>` (read-only, NO key) RE-DERIVES the root from the bytes referenced and reports OK / which file
       CHANGED/MISSING/UNEXPECTED, exit 0/3/2/1 — exactly the offline-recompute posture of `vh verify-seal`/`verify-proof`.
    2. The PAID surface (e.g. the signed-attestation wrapping of the seal, and/or sealing more than a free sample size)
       is GATED behind a valid `--license <f> --vendor <addr>` verified OFFLINE via `cli/core/license.js` against a NEW,
       distinct evidence-product entitlement table (its own `kind`, NOT `trustledger-license` — a separate sellable
       product); the FREE tier (an unsigned baseline seal + verify) stays open so a buyer can try before buying. The
       gate reuses the SAME `verifyLicense`/named-reject posture as the TrustLedger CLI. Unknown/incomplete flags
       hard-error with usage (parser parity with existing commands). Output leads with the TRUST-BOUNDARIES one-liner
       (the seal proves tamper-evidence + offline-recompute, NOT a trusted timestamp — "sealed at T" rides P-3).
    3. `docs/EVIDENCE.md` specifies the evidence-packet schema (every field, all UNTRUSTED transport — verification
       re-derives), the free-vs-paid surface, a worked `seal → hand over packet → verify` example, and how it reuses the
       shared cores; README links it. STRATEGY.md gains **P-7 (needs-human)**: the NARROW, decision-ready go-to-market
       ask for the SECOND vertical — (a) generate the evidence-product VENDOR keypair OFFLINE + pin the address (the
       loop never holds it), (b) pick the price + free-vs-paid split, (c) land a B2B design partner via the existing
       provenance/P-4 channel (NOT the trust-accounting/P-5 channel). Make explicit that P-7 is DISTINCT from P-5
       (trust-law) and P-6 (TrustLedger delivery): it opens a second vertical on a LIGHTER human gate; do NOT restate
       P-5/P-6.
    4. Tests (live where needed, offline for the recompute): `vh evidence seal --out` then `vh evidence verify` ACCEPTS
       a genuine packet; editing a file in the dir makes verify report exactly that file CHANGED with a non-zero exit;
       the paid surface 4xx/exit-rejects WITHOUT a valid license and succeeds WITH an ephemeral-key license pinned to
       the matching vendor; a license signed by a DIFFERENT key is `wrong_issuer`; `--json` round-trips; the suite
       leaves the working tree CLEAN (every write under a temp dir). Full suite green; `npx hardhat test` unchanged.

## EPIC-31 — The independent, zero-trust VERIFIER: make "don't trust us, check it yourself" real for a third party  *(material change of approach — the cross-vertical capability that converts every artifact's tamper-evidence claim into something a counterparty can independently confirm; see STRATEGY.md "## Direction" 2026-06-24)*

*Motivation (Strategist 2026-06-24): QUALITY STAGNATION + a GROWING value ceiling. avgUsefulness REGRESSED then sat
flat (4.0 → 3.75 → 3.75 → 3.5 → 3.75 → 3.75), minUsefulness stuck at 3, and humanGated CLIMBED 3 → 3 → 3 → 3 → 3 → 5.
EPIC-22..30 are NINE+ consecutive product-surface increments (TrustLedger engine/policy/close/ingest/seal/web/
onboarding/entitlement, then the EPIC-30 evidence harvest). Build frontier EMPTY (1625 tests green). Every revenue
path is dammed behind a HUMAN go-to-market step (P-5/P-6 = TrustLedger legal/CPA/pricing; P-7 = evidence vendor key +
design partner) that NO amount of building can move. The directive for this state is explicit: change approach
MATERIALLY toward a capability that unlocks NEW value and DE-RISKS the dam — not another product-surface increment.*

*The material change (and why it is genuinely higher-leverage, not a tenth increment): the SINGLE load-bearing
selling proposition of the ENTIRE product family — TrustLedger seals, evidence packets, dataset attestations, proof
bundles, RFC-3161 timestamps — is "you do not have to trust the producer; verify it OFFLINE, independently." That
promise is, today, UNDELIVERABLE to the party who matters most: the COUNTERPARTY (the auditor, the opposing counsel,
the buyer's security team, the design partner deciding whether to pay). To independently check a signed
`*.vhevidence.json` / `*.vhseal` / dataset attestation / proof bundle, a third party must `npm install` the FULL
`verifyhash` package, which pulls in `ethers` (large), `hardhat`, and `@nomicfoundation/hardhat-toolbox` — a heavy,
unauditable-in-an-afternoon stack from the very vendor whose claim they are trying to independently check. That is a
direct CONTRADICTION of the product's core promise and a concrete adoption + WTP blocker on EVERY vertical at once.
The fix is a STANDALONE, near-zero-dependency, single-file `verify-vh` verifier (its own `verifier/` tree, NO
hardhat, NO ethers, NO CLI back-edges) that re-derives keccak256 roots (`js-sha3`, already a runtime dep) and recovers
the EIP-191 `eip191-personal-sign` secp256k1 signer WITHOUT ethers, then confirms an artifact byte-for-byte. It is a
NEW capability that (a) makes the family's headline claim actually true for a third party, (b) MULTIPLIES value across
ALL verticals from one small surface, and (c) directly DE-RISKS P-7 and P-3/P-4 (counterparty confidence IS the WTP),
reached through NO new human gate.*

*Why this beats the alternatives considered: (a) A tenth product-surface increment is the capped vein the regression +
growing humanGated warn against. (b) Re-sharpening P-5/P-6/P-7 is forbidden busywork; all three are decision-ready.
(c) "Just tell buyers to install the CLI" is the exact non-starter that contradicts the independence claim. (d) A
hosted verifier is an outward/network human step (and re-introduces "trust the vendor's server"). The standalone,
auditable, offline verifier is the one auto-buildable move that makes the product's core promise REAL for the buyer
and multiplies every vertical — the highest-leverage item on an empty frontier.*

*Guardrails respected: pure-local, OFFLINE, deterministic; NO crypto-token/coin/NFT/sale/yield, NO funds, NO deploy,
NO real key (ephemeral test keys ONLY). The verifier is READ-ONLY: it NEVER signs, NEVER holds a key, NEVER writes to
cwd. STRICTLY ADDITIVE + NON-REGRESSING: it lives in its own `verifier/` tree and changes NO existing producer code;
every EPIC-1..30 test stays green and the test COMMAND is unchanged (`npx hardhat test`, with the new verifier specs
added under it). The minimal secp256k1 recovery + EIP-191 hashing MUST be cross-checked AGAINST the production
`cli/core/attestation.js`/`ethers` path in a test, so the independent implementation can NEVER silently diverge from
what the producer signs. REVENUE INTEGRITY: this is a trust-multiplier for delivered software value, NOT itself a
token/tradeable/appreciating asset; it lowers the buyer's adoption risk for every paid vertical.*

- **T-31.1** `VERIFIED` Stand up an independent, near-zero-dependency `verifier/` core: re-derive keccak256 roots + recover
  the EIP-191 secp256k1 signer WITHOUT ethers/hardhat, and CROSS-CHECK it against the production path. deps: T-30.2
  (VERIFIED), T-17.* (the signed-attestation envelope). files: verifier/lib/keccak.js (or reuse js-sha3),
  verifier/lib/secp256k1-recover.js (new), verifier/lib/canonical.js (new), test/verifier.crypto.test.js (new)
  - Problem: independent verification today requires installing the full producer stack (ethers + hardhat). A
    counterparty cannot cheaply, auditably confirm a signed artifact without trusting the vendor's heavy tooling.
  - Acceptance:
    1. `verifier/lib/secp256k1-recover.js` recovers the signer ADDRESS from an `eip191-personal-sign` 65-byte (r||s||v)
       signature over a message, using ONLY `js-sha3` (keccak) + Node's built-in `crypto` (or a single tiny, vendored,
       audited secp256k1 routine) — NO `ethers`, NO `hardhat`, NO `require` back into `cli/` or `trustledger/`. It
       reproduces the EIP-191 personal_sign prefix (`\x19Ethereum Signed Message:\n` + length) over the EXACT canonical
       UTF-8 bytes, EXACTLY as `cli/core/attestation.js` documents, and returns a lowercase 0x address.
    2. `verifier/lib/canonical.js` reproduces the family's canonical UNSIGNED serialization deterministically (the same
       byte string `serializeUnsigned` emits — stable key order + trailing-newline convention), with NO dependency on
       the producer code, so the independent verifier signs/hashes over BYTE-IDENTICAL input.
    3. A CROSS-CHECK test (`test/verifier.crypto.test.js`) signs a payload with an ephemeral `Wallet.createRandom()` via
       the PRODUCTION `cli/core/attestation.js`/ethers path, then asserts the INDEPENDENT `verifier/` recovery returns
       the SAME address byte-for-byte, AND that a tampered byte flips it to a different/failed address. This is the
       anti-divergence guard: the two implementations can never silently drift. Full suite green; `npx hardhat test`
       unchanged in command.
  - Rationale: the cryptographic floor of the whole verifier — proven equivalent to production, with no heavy deps.
- **T-31.2** `VERIFIED` Ship `verify-vh <artifact>`: a standalone, read-only, offline verifier that confirms a signed
  `*.vhevidence.json` / `*.vhseal` / dataset attestation / proof bundle WITHOUT the producer stack. deps: T-31.1. files:
  verifier/verify-vh.js (new), verifier/package.json (new, its OWN minimal manifest), test/verifier.cli.test.js (new)
  - Problem: the recovery core exists but a counterparty has no single command to point at a delivered artifact and get
    a yes/no with WHICH file or WHICH signer failed — independent of the producer's CLI.
  - Acceptance:
    1. `verify-vh <artifact>` auto-detects the artifact `kind` (evidence-seal, trust seal, dataset/proof attestation),
       RE-DERIVES the keccak root from the referenced bytes (resolving sibling files relative to the artifact, with a
       `--dir <d>` override), recovers the signer via T-31.1, PINS it against a caller-supplied `--vendor <0xaddr>` (or
       reports the recovered signer when no pin is given), and prints a deterministic verdict: OK / which file
       CHANGED/MISSING/UNEXPECTED / `bad_signature` / `wrong_issuer`. READ-ONLY: NO key, NEVER writes cwd. CI-gateable
       exit codes (0 ok / 3 rejected / 2 usage / 1 IO), mirroring `vh verify-seal`/`vh evidence verify`.
    2. `verifier/package.json` declares ONLY the minimal runtime deps (`js-sha3`, and a tiny secp256k1 routine if used)
       — explicitly NO `ethers`/`hardhat`/`@nomicfoundation/*` — so a third party can `npm install` the verifier ALONE
       and audit it in an afternoon. The `bin` exposes `verify-vh`.
    3. Tests (`test/verifier.cli.test.js`, offline, working tree CLEAN — every write under a temp dir): produce a signed
       evidence packet + a signed trust seal via the REAL producer CLI; `verify-vh` ACCEPTS each with the matching
       `--vendor`; editing one referenced byte makes it report exactly that file CHANGED with exit 3; a DIFFERENT
       `--vendor` yields `wrong_issuer` exit 3; a tampered signature yields `bad_signature` exit 3; `--json` round-trips.
       Full suite green; `npx hardhat test` unchanged in command.
  - Rationale: the third-party-facing command that finally DELIVERS "verify it yourself, without trusting us."
- **T-31.3** `VERIFIED` Document + harden the independent verifier as a buyer deliverable: a self-contained README a
  counterparty can read, plus a no-network/no-back-edge proof. deps: T-31.2. files: verifier/README.md (new),
  docs/INDEPENDENT-VERIFICATION.md (new), README.md, test/verifier.isolation.test.js (new)
  - Problem: an independent verifier is only credible if a non-customer can understand EXACTLY what it checks (and what
    it does NOT — tamper-evidence + signer recovery, NOT a trusted timestamp), and can confirm it makes no network call
    and pulls in no producer code.
  - Acceptance:
    1. `verifier/README.md` + `docs/INDEPENDENT-VERIFICATION.md` specify, for a NON-customer reader: the exact bytes
       verified, the EIP-191/keccak scheme, the free `verify-vh` posture, the trust boundary (tamper-evidence +
       offline-recompute + signer-pin — NOT a trusted "signed at T", which rides P-3/RFC-3161), and a worked
       `producer seals → hands over packet → counterparty runs verify-vh` example. The main README links it.
    2. An ISOLATION test (`test/verifier.isolation.test.js`) statically asserts the `verifier/` tree NEVER `require`s
       `ethers`, `hardhat`, `@nomicfoundation/*`, or anything under `cli/`/`trustledger/` (greps every `require(`), and
       a runtime guard that a verify run opens NO socket/network handle (no `http`/`https`/`net`/`dns` usage). This
       PROVES the independence claim mechanically, not just in prose.
    3. STRATEGY.md note: cross-reference P-3/P-4/P-7 — the independent verifier DE-RISKS each (counterparty confidence)
       but introduces NO new human gate; do NOT restate those proposals. Full suite green; `npx hardhat test` unchanged.
  - Rationale: turns the verifier into a credible, self-explaining buyer deliverable and mechanically proves its independence.

## EPIC-34 — Let the pilot kit run on the PARTNER'S OWN FILES: close the last "does it work on MY data?" friction on P-8  *(no new mechanism — point the EXISTING seal→handoff→verify journey at a partner-supplied folder; directly de-risks the consolidated P-8 "land a design partner / run the pilot" ask; see STRATEGY.md "## Direction" 2026-06-24)*

*Motivation (Strategist 2026-06-24): PERSISTENT VALUE CEILING — humanGated STANDING at 3,3,5,3,3 across 6+ runs; every
revenue gate (P-3/P-5/P-6/P-7) is CONSOLIDATED behind ONE human action, P-8 ("land a design partner / run the pilot"). The
last three runs correctly DE-RISKED P-8 instead of adding mechanism (EPIC-31 independent verifier → EPIC-32 pilot kit →
EPIC-33 CI gate) and avgUsefulness recovered to the window-HIGH 4.0. The directive for a standing humanGated count is
explicit: do NOT invent more mechanism — SHARPEN the blocking ask and prefer auto-buildable work that DE-RISKS / directly
UNBLOCKS it once the human acts. This epic is the NEXT increment of exactly that de-risking, NOT a new product surface.*

*The gap I found (confirmed in code, not invented): `pilot/run-pilot.js` is HARD-WIRED to the committed
`pilot/sample-evidence/` directory (`const SAMPLE_EVIDENCE = path.join(PILOT_DIR, "sample-evidence")`, copied into the
workspace at line ~177) — there is NO env knob / flag to point the SAME seal→hand-off→`verify-vh` journey at a partner's
OWN folder. Yet `docs/PILOT.md` §1 step 4 / the P-5/P-7 design-partner scripts all say the WTP-validating moment is the
partner running THEIR REAL folder through `seal → hand over → verify`. So the single most likely first question a design
partner asks — "great, but does it work on MY files?" — currently forces them to hand-assemble that run from the
`vh evidence`/`verify-vh` man pages, exactly the friction EPIC-32 was built to remove. The kit proves the journey on canned
data but cannot yet prove it on the buyer's data in one command. THAT is pure, tested integration glue on the EXISTING kit
— NO new mechanism, NO new artifact kind, NO new human gate.*

*The move (point it, don't add surface): teach `pilot/run-pilot.js` to accept a partner-supplied evidence folder via
`PILOT_EVIDENCE_DIR` (env) / `--evidence-dir <path>` and run the EXACT SAME license-gated `evidence seal --sign` →
independent `verify-vh` ACCEPT journey on it, while keeping the canned sample as the default. Crucial HONESTY detail: when
running on REAL partner data the kit must NOT mutate the partner's files — it copies the partner folder into the temp
workspace first (same `copyDir` it already uses), and the TAMPER/REJECT step runs only on that COPY (never the original);
the verdict still asserts ACCEPT on the untampered packet and REJECT after the in-workspace tamper. Then update `docs/PILOT.md`
to document the one-command "run it on your own folder" path and what it does/does not prove (still tamper-evidence +
signer-pin, NOT a trusted "sealed at T" without P-3). Guardrails: pure-local, OFFLINE, deterministic, READ-ONLY of the
partner's originals (copy-then-operate; ephemeral `Wallet.createRandom()` keys ONLY); NO token/funds/deploy/real key; the
partner folder is INPUT only and the working tree stays clean; strictly additive — the default canned run is byte-for-byte
unchanged, every EPIC-1..33 test stays green, and `npx hardhat test` is unchanged.*

- **T-34.1** `VERIFIED` Teach the pilot kit's EVIDENCE vertical to run against a PARTNER-SUPPLIED folder without touching the
  partner's originals, so a design partner can watch the full seal→hand-off→`verify-vh` journey on THEIR OWN data in one
  command. deps: T-32.1 (VERIFIED), T-31.2 (VERIFIED). files: `pilot/run-pilot.js`, `docs/PILOT.md`,
  `test/pilot.evidence.test.js` (extend) or `test/pilot.ownfolder.test.js` (new).
  - Add `PILOT_EVIDENCE_DIR` (env) and `--evidence-dir <path>` (CLI) that, when set, make the evidence vertical seal the
    partner's folder instead of `pilot/sample-evidence/`; the default (unset) path stays byte-for-byte the canned run.
  - The kit COPIES the partner folder into its temp workspace (reuse the existing `copyDir`) and operates ONLY on the copy;
    the partner's original files are READ-ONLY and never written, renamed, or deleted (assert in test against a fixture
    folder whose mtimes/bytes are unchanged after a run).
  - The full verdict still holds on real data: license-gated `--sign` is REFUSED without a valid license and ALLOWED with
    one; the independent `verify-vh --vendor <addr>` ACCEPTS the untampered packet (exit 0); the TAMPER step mutates a byte
    in the WORKSPACE COPY only and `verify-vh` then REJECTS (exit 3). If the supplied folder is missing/empty/unreadable,
    the kit hard-errors with a clear message BEFORE sealing (never a misleading PASS).
  - `docs/PILOT.md` documents the one-command "run it on your own folder" path (`--evidence-dir` / `PILOT_EVIDENCE_DIR`),
    states plainly that the kit does not modify the partner's files, and reaffirms the honest boundary (tamper-evidence +
    signer-pin, NOT a trusted "sealed at T" without P-3). A docs-rot assertion keeps the flag name + no-mutation promise in
    sync with the kit.
  - Acceptance: `node pilot/run-pilot.js --evidence-dir <somefolder>` runs the evidence journey on that folder offline with
    an all-PASS verdict; the partner's original files are provably unmodified after the run; the unset/default run is
    unchanged (canned sample, all prior assertions hold); a missing/empty folder hard-errors before sealing rather than
    passing; the new/extended test passes and the FULL suite stays green under the unchanged `npx hardhat test`.

## EPIC-33 — Make `verify-vh` a DROP-IN CI MERGE GATE: the glue that turns a pilot DEMO into a wired-in renewal  *(no new mechanism — close the last adoption gap on the existing verifier; directly de-risks the consolidated P-8 "land a design partner" ask; see STRATEGY.md "## Direction" 2026-06-24)*

*Motivation (Strategist 2026-06-24): PERSISTENT VALUE CEILING with humanGated STANDING at 3-5 across 6+ runs; every
revenue gate (P-3/P-5/P-6/P-7) is now CONSOLIDATED behind ONE human action — P-8: "land a design partner / run a pilot."
The previous run did the right move (assemble the pilot kit + sharpen P-8); avgUsefulness recovered to the window-HIGH 4.0.
The directive for a standing humanGated count is explicit: do NOT invent more mechanism — SHARPEN the blocking ask and
prefer auto-buildable work that DE-RISKS / directly UNBLOCKS it once the human acts. This epic is that work.*

*The gap I found (confirmed in code, not invented): `docs/INDEPENDENT-VERIFICATION.md` line 24 PROMISES "a deterministic
verdict and a CI-gateable exit code," and `verifier/` is already packaged as a standalone, near-zero-dep npm bin
(`verifier/package.json` → `bin: verify-vh`, deps: just `js-sha3`, exit contract 0/3/2/1). But there is NO actual
copy-paste CI workflow (`find` over the repo: zero `.yml`/`.yaml`), and `verify-vh` only takes ONE artifact at a time — a
release pipeline that ships several sealed artifacts has no single command to gate the whole set. So the most common B2B
adoption path — "how do I make my pipeline AUTOMATICALLY reject a tampered/forged artifact on every merge?" — is left as an
exercise. THAT glue is the difference between "we ran your demo once" (a pilot that lapses) and "it's wired into our
release gate" (a renewal). It is pure, tested integration glue on the EXISTING verifier — NO new product mechanism.*

*The move (wire it in, don't add surface): (1) a tested batch/manifest mode so one `verify-vh` invocation gates ALL
artifacts a release produces with one exit code; (2) a real, copy-paste GitHub Actions workflow (and a portable
generic-CI/`Makefile` snippet) that installs ONLY the standalone verifier and fails the build on a bad verdict, with a
test that the shipped snippet's command actually runs green on a good artifact and red on a tampered one; (3) buyer-facing
docs that make `verify-vh` adoptable as a merge gate in an afternoon, plus a SHARPENED P-8 noting the CI gate as the
pilot→renewal conversion lever. Guardrails: pure-local, OFFLINE, READ-ONLY, near-zero-dep; NO token/funds/deploy/key; the
workflow file is an EXAMPLE artifact under the verifier tree, never executed by the loop; strictly additive — every
EPIC-1..32 test stays green and `npx hardhat test` is unchanged.*

- **T-33.1** `VERIFIED` Add a tested BATCH/MANIFEST mode to the standalone verifier so ONE invocation gates EVERY artifact a
  release produces and returns ONE CI exit code. deps: T-31.2 (VERIFIED). files: `verifier/verify-vh.js`,
  `verifier/lib/` (as needed), `test/verifier.cli.test.js`, `docs/INDEPENDENT-VERIFICATION.md`, `verifier/README.md`.
  Steps:
    1. Accept either repeated `<artifact>` args OR `--manifest <file>` (a newline/JSON list of artifact paths, each with an
       optional per-entry `--vendor`/`--dir`), verify EACH read-only, and aggregate: exit `0` only if ALL pass; exit `3`
       if ANY artifact is rejected (the report names WHICH artifact failed and why); usage/IO codes unchanged (2/1).
       Keep the single-artifact path byte-for-byte unchanged (a pure superset — existing callers/tests must not shift).
    2. `--json` aggregate output is a stable object: `{ ok, total, passed, failed, results: [...per-artifact...] }`, each
       per-artifact entry being the SAME shape the single-artifact `--json` already emits (no divergence — reuse the core).
    3. Reuse the existing `verifyArtifact` core for every entry; NO new crypto, NO new artifact kind. Preserve the
       path-escape / no-network guarantees per entry. Document the manifest format + aggregate exit contract in BOTH the
       deep spec and the verifier README.
  Acceptance: new tests cover (a) all-pass → exit 0, (b) one-of-many tampered → exit 3 with that artifact named, (c) JSON
  aggregate shape, (d) the single-artifact path is unchanged (existing specs still green); `npx hardhat test` unchanged.

- **T-33.2** `VERIFIED` Ship a REAL, copy-paste CI merge-gate the partner drops into their pipeline, and TEST that the shipped
  snippet's command actually works. deps: T-33.1. files: `verifier/ci/verify-vh.github-actions.yml` (example, NEVER run by
  the loop), `verifier/ci/verify-vh.generic.sh` (portable `set -e` shell snippet usable from GitLab CI / a Makefile),
  `verifier/README.md`, `docs/INDEPENDENT-VERIFICATION.md`, `test/verifier.ci-snippet.test.js`.
  Steps:
    1. The GitHub Actions workflow installs ONLY the standalone verifier (e.g. `npm i -g ./verifier` or `npx`), runs
       `verify-vh` (batch mode from T-33.1) over the artifacts a release ships, and FAILS the job on a non-zero exit —
       with an inline comment block stating the trust boundary (verifies BYTES + signer-pin, NOT the producer's legal
       conclusion; verification is FREE forever, only sealing is paid).
    2. The generic snippet is a portable `set -euo pipefail` shell block (no Actions-specific syntax) that does the same,
       so a GitLab-CI / Jenkins / Makefile user can paste it.
    3. A test EXTRACTS the exact `verify-vh ...` command line from the shipped snippet (parse the file — do not duplicate
       the command in the test) and runs it against (a) a good sealed artifact → exit 0 and (b) a tampered copy → exit 3,
       proving the snippet we ship is real and non-rotting. The workflow YAML is asserted to reference the standalone
       verifier package ONLY (no ethers/hardhat) so the "audit it in an afternoon" independence claim holds in CI too.
  Acceptance: the snippet's own command passes on good input and fails on tampered input in test; the YAML installs only
  the standalone verifier; docs link the snippet; `npx hardhat test` unchanged and full suite green.

- **T-33.3** `VERIFIED` Make the CI gate buyer-adoptable and fold it into P-8 as the pilot→renewal conversion lever. deps:
  T-33.1, T-33.2. files: `docs/PILOT.md`, `docs/INDEPENDENT-VERIFICATION.md`, `verifier/README.md`, `STRATEGY.md`,
  `test/pilot.docs.test.js` (or a new docs-rot guard).
  Steps:
    1. Add a short, NON-AUTHOR-followable "Wire it into your pipeline" section to `docs/PILOT.md` and the verifier README:
       the 3 lines to add to CI, what a green vs red gate means, and the explicit boundary (FREE verification, paid
       sealing). Cross-link from the buyer runbook so the pilot ends at "and here's how it lives in your release process."
    2. SHARPEN P-8 in STRATEGY.md: note that the CI merge-gate is the concrete lever that converts a one-off pilot into a
       renewing dependency (the partner's own pipeline now FAILS without a valid seal), strengthening the existing ask
       WITHOUT adding a new human gate and WITHOUT restating/relaxing P-3/P-5/P-6/P-7. Add NO new `needs-human` item.
    3. A docs-rot guard mechanically asserts the runbook/README keep the "verification is free, sealing is paid" boundary
       and that the CI section points at the shipped snippet path from T-33.2 (so the docs cannot drift from the artifact).
  Acceptance: docs-rot guard green; `docs/PILOT.md` + verifier README carry a copy-paste CI section pointing at the real
  snippet; P-8 names the CI gate as the renewal lever with no new human gate; `npx hardhat test` unchanged, suite green.

## EPIC-32 — The end-to-end DESIGN-PARTNER PILOT KIT: the single runnable artifact a human can hand a paying partner TODAY  *(material change of approach — stop adding mechanism; assemble the mechanisms already built into the ONE thing every needs-human "land a design partner" gate waits on; see STRATEGY.md "## Direction" 2026-06-24)*

*Motivation (Strategist 2026-06-24): PERSISTENT VALUE CEILING, now with a REGRESSION the last pivot did not fix.
avgUsefulness fell to the window's LOW of 3.0 (3.75 → 3.75 → 3.5 → 3.75 → 3.0), minUsefulness pinned at 3, and humanGated
has STOOD at 3-5 across 6+ runs. The build frontier is EMPTY — EPIC-22..31 ALL VERIFIED, 1660 tests green — and the only
remaining TODOs are `needs-decision`/`needs-human` (EPIC-3/4). The previous run ALREADY made the "material pivot" move
(EPIC-31 independent verifier) and usefulness STILL dropped, which proves the bottleneck is no longer a missing mechanism.
The directive for a persistent humanGated count is explicit: do NOT invent more incremental tasks; identify the blocking
needs-human proposal, SHARPEN it into a crisp decision-ready ask, and prefer auto-buildable work that DE-RISKS / directly
UNBLOCKS it once the human acts.*

*The gap I found (confirmed in code, not invented): EVERY needs-human revenue gate — P-3 (DataLedger trust-root pilot),
P-5/P-6 (TrustLedger CPA + delivery), P-7 (evidence vendor key + B2B design partner) — waits on the SAME human action:
"land a design partner / run a pilot." The loop has built every mechanism that pilot needs (reconcile, policy, close,
inspect, seal, license issue/verify, evidence seal/verify, and the EPIC-31 independent `verify-vh`) — but they are
SCATTERED across CLIs and docs, and there is NO single runnable artifact that ties the WHOLE buyer journey together end to
end. The one existing runnable demo (`examples/run.js`) covers ONLY DataLedger + ProofParcel — it does NOT touch
TrustLedger reconciliation, the license entitlement gate, the evidence packet, OR the counterparty `verify-vh` hand-off,
which are exactly the surfaces P-5/P-6/P-7 are sold on. So a human who wants to start a pilot today must hand-assemble the
journey from a dozen man pages and hope it hangs together. THAT assembly — not another mechanism — is the missing,
fully-auto-buildable thing that converts a pile of dammed, correct work into something a human can ACT on in an afternoon.*

*The move (assemble, don't add): build ONE self-contained, OFFLINE, ephemeral-key PILOT KIT that drives the real
producer→seal→license-gate→HAND-OFF→independent-`verify-vh` journey across BOTH paid verticals (TrustLedger reconcile +
evidence) using the EXACT module entrypoints the CLIs dispatch to, prints a single PASS/FAIL verdict, writes only to a
temp workspace, and ends by pointing at the precise human handoff (provision a REAL key; the kit uses ephemeral
`Wallet.createRandom()` keys ONLY). Then a buyer-facing PILOT.md script (what to run, what each artifact proves, where the
counterparty independently checks with `verify-vh`, what the human must provision), and a consolidated, sharpened P-8 that
folds the "land a design partner" precondition shared by P-3/P-5/P-6/P-7 into ONE decision-ready ask with this kit as the
deliverable. Why higher-leverage than another increment: it does not add surface — it makes the surface SELLABLE by giving
the human the artifact the gates wait on, de-risking ALL of them at once with NO new human gate. Why it beats alternatives:
(a) a tenth mechanism is the capped vein the regression warns against; (b) re-sharpening P-3/P-5/P-6/P-7 individually is
the forbidden busywork (each is already sharp in isolation — the missing thing is the CONSOLIDATED, runnable handoff); (c)
extending examples/run.js in place would entangle the buyer journey with the existing DataLedger demo and break its tight
test; a new pilot/ tree keeps both clean. Guardrails: pure-local, OFFLINE, deterministic, READ-ONLY of the human's key
(ephemeral test keys only); NO token/coin/NFT/sale/yield, NO funds, NO deploy, NO real key; strictly additive — every
EPIC-1..31 test stays green and `npx hardhat test` is unchanged.*

- **T-32.1** `VERIFIED` Build the runnable, OFFLINE, ephemeral-key PILOT KIT (`pilot/run-pilot.js`) that drives the REAL
  end-to-end design-partner journey for the EVIDENCE vertical against tiny committed sample inputs, using the SAME module
  entrypoints the `vh` CLI dispatches to (`cli/evidence.js`, `cli/core/license.js`, and `verifier/verify-vh.js`'s
  programmatic core) — NOT a brittle shell pipeline. Steps it must demonstrate and self-CHECK (verdict = AND of all):
  (1) issue a product license with an EPHEMERAL `Wallet.createRandom()` vendor key (the key is created in-process, used,
  and discarded — NEVER persisted/logged); (2) `evidence seal` the sample dir WITH `--sign` GATED behind that valid
  license + vendor addr (and ASSERT the paid `--sign` is REFUSED without a valid license, proving the gate bites);
  (3) HAND OFF only the produced `*.vhevidence.json` to the INDEPENDENT verifier and assert `verify-vh --vendor <addr>`
  returns OK (signer pinned); (4) TAMPER one sealed byte and assert `verify-vh` now REJECTS (exit 3) — proving
  tamper-evidence to a counterparty who never installed the producer stack. Write ONLY to a fresh temp workspace (honor
  `VH_PILOT_OUT`/`VH_PILOT_KEEP`), leave the working tree clean, print a clear PASS/FAIL summary + artifact paths, and
  end with the explicit human handoff line (provision a REAL key; this kit used an ephemeral one). deps: T-30.3
  (VERIFIED), T-31.2 (VERIFIED), T-29.1 (VERIFIED). files: pilot/run-pilot.js (new), pilot/sample-evidence/ (new, tiny
  committed inputs), test/pilot.evidence.test.js (new — run the kit end-to-end under `npx hardhat test`; assert PASS,
  assert the unlicensed `--sign` is refused, assert the tamper is caught, assert the tree is left clean).
  - Acceptance: `node pilot/run-pilot.js` exits 0 with an all-PASS verdict offline; the paid `--sign` is provably refused
    without a valid license and allowed with one; the counterparty `verify-vh` accepts the untampered packet (exit 0) and
    rejects the tampered one (exit 3) using ONLY the verifier tree; no real key is ever created/held/persisted (ephemeral
    `Wallet.createRandom()` only); nothing is written into the repo working tree; the new test passes and the FULL suite
    stays green under the unchanged `npx hardhat test`.

- **T-32.2** `VERIFIED` Extend the PILOT KIT to ALSO drive the TrustLedger RECONCILE vertical end to end against the existing
  committed `trustledger/fixtures` (or a tiny new sample): `vh trust reconcile` → license-GATED paid surface
  (`--state`/`--policy` or `--seal`) refused without a valid license and unlocked WITH one (reuse the ephemeral-key license
  from T-32.1's pattern) → emit the reconciliation `--seal` → HAND OFF the seal to the INDEPENDENT `verify-vh` and assert
  OK, then TAMPER and assert REJECT. Fold both verticals' verdicts into the ONE PASS/FAIL summary so a human runs a SINGLE
  command to watch the entire sellable journey for BOTH paid products. deps: T-32.1, T-26.2 (VERIFIED), T-29.2 (VERIFIED),
  T-23.2 (VERIFIED). files: pilot/run-pilot.js, pilot/fixtures or reuse trustledger/fixtures, test/pilot.reconcile.test.js
  (new).
  - Acceptance: the single `node pilot/run-pilot.js` now demonstrates BOTH the evidence AND the reconcile sellable journey
    end to end, offline, with ephemeral keys; the reconcile paid surface is provably license-gated (refused without,
    unlocked with); the emitted reconciliation seal is independently accepted by `verify-vh` and a tamper is rejected; the
    combined verdict is a single PASS/FAIL; the new test passes and the FULL suite stays green; `npx hardhat test` unchanged.

- **T-32.3** `VERIFIED` Write the buyer-facing pilot runbook (`docs/PILOT.md` + `pilot/README.md`) and CONSOLIDATE the
  go-to-market ask: a step-by-step a human can hand a design partner — what `node pilot/run-pilot.js` does, what each
  artifact PROVES (and, honestly, what it does NOT: tamper-evidence + signer-pin, NOT a trusted "sealed at T", which still
  rides P-3), exactly where the COUNTERPARTY independently checks with the zero-dependency `verify-vh` (cross-link
  docs/INDEPENDENT-VERIFICATION.md), and the precise HUMAN handoff (provision a REAL signing key OUTSIDE the loop; pick a
  design partner; set price). Link it from README. Add a NEW consolidated **P-8** in STRATEGY.md that folds the shared
  "land a design partner / run a pilot" precondition of P-3/P-5/P-6/P-7 into ONE crisp, decision-ready ask whose
  deliverable IS this kit (cross-reference those proposals; do NOT restate them). deps: T-32.1, T-32.2. files:
  docs/PILOT.md (new), pilot/README.md (new), README.md, STRATEGY.md, test/pilot.docs.test.js (new — assert the runbook
  documents the ephemeral-key/honest-trust-boundary posture, names `verify-vh` as the counterparty check, and stays in
  sync with the kit's actual steps/flags).
  - Acceptance: a non-author can follow docs/PILOT.md to run the kit and explain to a partner what each artifact proves and
    where they independently verify; the honest trust boundary (no trusted timestamp without P-3) is stated; P-8 is a
    single decision-ready ask consolidating the design-partner precondition; the docs test passes and the FULL suite stays
    green; `npx hardhat test` unchanged.

## EPIC-22 — TrustLedger: three-way trust-account reconciliation  *(NEW LEAD PRODUCT — the human-chosen income bet; see STRATEGY.md "## Direction" 2026-06-24)*

*This is now the PRIMARY build focus. A deterministic (no-LLM) reconciliation tool for small US residential
property-management firms on QuickBooks + bank CSV + rent ledger. Plain Node JS under `trustledger/`, Mocha
tests under `test/`, run by the existing `npx hardhat test`. NO crypto/token. v1 = a CLI-runnable engine that
reconciles three fixture files and emits an audit-ready report; a thin web upload UI comes after. Build these
in order; each must leave the full suite green.*

- **T-22.1** `VERIFIED` `trustledger/ingest.js` — parse + normalize the three inputs into one transaction model.
  deps: none. files: trustledger/ingest.js (new), test/trustledger.ingest.test.js (new)
  - Acceptance: pure functions that parse (a) a bank statement CSV/OFX, (b) a QuickBooks trust-ledger CSV
    export, (c) a rent-roll/tenant sub-ledger CSV into a normalized `{date, amount(cents int), memo, kind,
    party, source}` record list; amounts are integer cents (no float drift); a strict reader rejects malformed
    rows with a clear error rather than silently dropping them. Fixtures under `trustledger/fixtures/` cover a
    deposit, a check, an NSF reversal, and a split/partial deposit. Full suite green (`npx hardhat test`).
- **T-22.2** `VERIFIED` `trustledger/match.js` — exact-then-fuzzy transaction matcher. deps: T-22.1.
  files: trustledger/match.js (new), test/trustledger.match.test.js (new)
  - Acceptance: given two normalized lists, match exact (amount+date) first, then fuzzy on amount with a
    configurable date-tolerance window and memo similarity, handling split/partial deposits (one bank line ↔
    several ledger lines) and timing differences; returns `{matched:[{a,b,confidence}], unmatchedA, unmatchedB}`.
    Deterministic + order-independent. Tests prove an NSF reversal, a split deposit, and a 1-day timing gap each
    match correctly, and that a genuinely missing item stays unmatched. Suite green.
- **T-22.3** `VERIFIED` `trustledger/reconcile.js` — the three-balance check + exception classification. deps: T-22.2.
  files: trustledger/reconcile.js (new), test/trustledger.reconcile.test.js (new)
  - Acceptance: compute the three balances that must agree (bank vs book vs sum-of-tenant-sub-ledgers), report
    whether they tie out, and classify every reconciling item/exception (outstanding deposit/check, NSF reversal,
    owner draw, security-deposit segregation, timing). Output a structured `{balances, tiesOut, exceptions[]}`.
    Tests assert a clean set ties out and that each seeded exception type is detected + correctly labeled. Suite green.
- **T-22.4** `VERIFIED` `vh trust reconcile <bank> <ledger> <rentroll> [--out <dir>]` + audit-ready report. deps: T-22.3.
  files: trustledger/report.js (new), trustledger/cli.js (new) or cli/vh.js wiring, test/trustledger.e2e.test.js (new)
  - Acceptance: a CLI command runs ingest→match→reconcile end-to-end on the three files and writes a DATED,
    deterministic, audit-ready reconciliation packet as **HTML + CSV** (print-to-PDF ready; binary PDF/xlsx libs
    deferred to v2 to avoid new heavy deps) into `--out`, plus a one-line PASS/FAIL summary + CI-gateable exit
    code. A clear "tool aids reconciliation; the broker remains responsible" disclaimer is in the report. An e2e
    test runs the whole pipeline on the fixture set and asserts the three balances, the exception list, and that
    the report files are produced deterministically. Suite green. (This single deliverable is the demoable core
    value — a broker runs their real files and watches the three numbers tie out.)

## EPIC-23 — TrustLedger: the per-state trust-rule POLICY layer  *(turn the hard-coded severities into a reviewed, citable, data-driven control — directly de-risks/unblocks P-5 item #2)*

*Motivation (Strategist 2026-06-24): EPIC-22 shipped TrustLedger v1 (engine + report + the one-command `vh
trust reconcile`), the frontier is empty, and metrics are a hard plateau (avg 4 / min 4, humanGated standing
3→4 across the last 6 runs). The value ceiling is P-5 (TrustLedger go-to-market). Per the directive, the move
is NOT another crypto/provenance increment in the capped vein — it is to SHARPEN the blocking human proposal
and build the auto-buildable work that DE-RISKS / DIRECTLY UNBLOCKS it. I surveyed the engine: the PASS verdict
(`report.js` › `buildPacket`, `pass = rec.tiesOut && counts.error === 0`) hinges entirely on which exceptions
are ERROR vs WARNING, and that mapping is the HARD-CODED `DEFAULT_SEVERITY` table in `reconcile.js`. P-5 item #2
flags exactly this: those severities are STATE-DEPENDENT LAW shipped as if settled, and a human must "produce a
documented, citable per-state mapping that REPLACES the hard-coded severities." Today there is NO mechanism to
plug a reviewed mapping IN — the human would have to edit source and the PASS meaning would silently change
under them. This EPIC applies the PROVEN EPIC-16 pattern (the DataLedger license-policy gate) to TrustLedger:
make the severity classification a versioned, strictly-validated, per-state POLICY FILE the engine loads, so a
human's task collapses from "rewrite the engine's classification" to "fill in a reviewed policy table for state
X." Pure-local, offline, deterministic, NO crypto/token, NO new heavy dep, NO deploy — and additive: with no
policy the engine behaves byte-for-byte as today (the existing defaults become the built-in baseline policy).*

- **T-23.1** `VERIFIED` `trustledger/policy.js` — a versioned, strictly-validated per-state trust-rule policy + a pure
  applyPolicy() that overrides exception severities deterministically. deps: T-22.3 (VERIFIED).
  files: trustledger/policy.js (new), trustledger/fixtures/policy/ (new sample policy files),
  test/trustledger.policy.test.js (new)
  - Problem: which reconciliation findings make a trust account "out of trust" (ERROR, fails PASS) vs merely
    "needs a human eye" (WARNING) is state-dependent law, but it is hard-coded in `reconcile.js` › `DEFAULT_SEVERITY`
    with no reviewed, citable, swappable mapping — so the human's P-5 #2 task has nowhere to plug in.
  - Acceptance:
    1. A new `trustledger/policy.js` defines a versioned JSON policy schema and PURE
       `readPolicy(text|obj)` / `validatePolicy(obj)` with strict validation (rejects wrong `schemaVersion`,
       an unknown exception `type` key, a severity value not in {info,warning,error}, or a malformed
       `toleranceCents`) — never silently accepts a partial/garbled policy. The policy carries: a human `state`
       label, an optional `citation` string per override (the statute/rule the severity is grounded in, surfaced
       in the report so the control is defensible), a `severities` map (exception type → severity override), and
       an optional `toleranceCents`. Built from the EXISTING `EXCEPTION`/`SEVERITY` enums in `reconcile.js` (reuse,
       do not re-declare the type strings) so a typo'd exception type is a hard validation error, not a no-op.
    2. A pure `applyPolicy(reconcileResult, policy)` returns a NEW reconcile-shaped result with each exception's
       `severity` replaced by the policy override when present (and a `citation` attached when the policy supplies
       one), leaving the records/amounts/labels untouched. Deterministic and side-effect-free. When `policy` is
       null/undefined it returns the input unchanged (the built-in `DEFAULT_SEVERITY` baseline) — so the no-policy
       path is byte-for-byte today's behaviour.
    3. Ship at least one sample policy file under `trustledger/fixtures/policy/` (e.g. a `baseline.json` that
       reproduces the current defaults verbatim, proving the round-trip, plus one illustrative state override that
       flips an NSF reversal to ERROR) — clearly marked DRAFT / NOT-LEGAL-ADVICE, the sample a human CPA edits.
    4. Tests: round-trip + every validation-rejection branch (bad version, unknown type, bad severity, bad
       tolerance); `applyPolicy` with the baseline fixture leaves the reconcile result's severities identical to
       the hard-coded defaults; an override fixture flips exactly the targeted type and nothing else; the
       citation is carried through. Full suite green (`npx hardhat test`).
- **T-23.2** `VERIFIED` Wire `--state <code>` / `--policy <file>` into `vh trust reconcile` so the PASS verdict and the
  report reflect the reviewed per-state policy. deps: T-23.1, T-22.4 (VERIFIED).
  files: trustledger/cli.js, trustledger/report.js, test/trustledger.policy.cli.test.js (new) or
  test/trustledger.e2e.test.js
  - Problem: even with a policy engine, the one command a broker runs has no way to SELECT a reviewed per-state
    policy, so PASS still means "the loop's draft defaults" — not the CPA-reviewed control P-5 #2 needs.
  - Acceptance:
    1. `vh trust reconcile ... [--policy <file>] [--state <code>]` loads the policy via `policy.readPolicy`
       (a `--state` resolves a bundled fixture policy by its `state` label; `--policy` reads an explicit file;
       supplying both, or an unknown `--state`, is a clear usage error — exit 2). `report.buildPacket` accepts the
       loaded policy and runs `applyPolicy` over the reconcile result BEFORE computing `pass`, so the PASS/FAIL
       verdict and the CI-gateable exit code (0/3) reflect the REVIEWED severities. Without either flag, behaviour
       is byte-for-byte today's (built-in baseline) — no regression to any existing T-22.4 e2e assertion.
    2. The report (HTML + CSV + `--json`) names WHICH policy/state governed the run and surfaces each override's
       `citation`, and the disclaimer is updated to state that PASS reflects the SELECTED policy (still NOT legal
       advice; a CPA/counsel must review the policy itself — cross-references P-5 #1/#2). Output stays DATED and
       deterministic.
    3. Tests: reconciling the existing e2e fixture set with the baseline policy yields the SAME PASS/FAIL +
       balances + exception list as no policy (proves additivity); the same files under an override policy that
       escalates a present WARNING to ERROR flip the verdict to FAIL with exit 3 and the report shows the citation;
       `--policy` + `--state` together, and an unknown `--state`, both exit 2 with usage; the packet still writes
       only into `--out` (filesystem hygiene preserved). Suite green.
- **T-23.3** `VERIFIED` Document the policy layer + SHARPEN P-5 item #2 to a fill-in-the-table handoff.
  deps: T-23.1, T-23.2. files: docs/TRUSTLEDGER.md, STRATEGY.md (P-5 sharpen), test/ (extend a docs-rot guard if cheap)
  - Acceptance: `docs/TRUSTLEDGER.md` documents the policy file schema (every field, which are citations/labels),
    the `--state`/`--policy` selection, how PASS now depends on the selected policy, and a worked example (run with
    baseline → run with a state override → verdict flips). It states plainly that the SHIPPED policies are DRAFTS,
    not legal advice, and that a CPA/counsel must review and sign the per-state mapping (P-5 #1/#2). STRATEGY.md's
    P-5 item #2 is sharpened from "produce a mapping that replaces the hard-coded severities" to the now-narrow
    human task: "fill in + have counsel sign the per-state policy TABLE (`trustledger/fixtures/policy/<state>.json`)
    in the shipped, validated format; the engine already consumes it." No new runtime behaviour; pure docs of
    T-23.1/T-23.2.

## EPIC-24 — TrustLedger: period-close continuity  *(turn the one-shot demo into the RECURRING monthly product P-5 #3 a design partner runs every month — de-risks the lead product's go-to-market)*

*Motivation (Strategist 2026-06-24): EPIC-22/23 shipped TrustLedger v1 + the per-state policy layer; the
frontier is empty and metrics are a hard plateau (avg 4 / min 4, humanGated standing 3→4 across the last 6
runs). The value ceiling is P-5 (TrustLedger go-to-market). EPIC-23 already SHARPENED P-5 #2 (the per-state
policy is now a fill-in-the-table handoff). The remaining live blocker is P-5 #3: a human must get 1–2 design
partners to "run their real MONTHLY files" and confirm the tie-out. I surveyed the engine and confirmed a
foundational gap that bites EXACTLY on the second month — the moment a design partner decides whether this is
a real recurring product or a one-off toy:*
  1. *A trust reconciliation is a CONTINUOUS monthly chain, not a one-shot. Month N's ENDING balances (bank /
     book) are by definition month N+1's OPENING balances — that equality is the audit trail an examiner
     follows down the months. Today `reconcile.js` accepts `opts.opening` and the CLI exposes
     `--opening-bank`/`--opening-book` as RAW numbers the broker re-types by hand every month. There is (a) no
     machine-readable artifact a run EMITS that the next run can consume as its opening, and (b) NO continuity
     check at all — a fat-fingered opening silently shifts every balance and can flip PASS↔FAIL with no
     warning. The single most error-prone, most-repeated step of the monthly chore is unguarded.*
  2. *Nothing proves this month's opening came from last month's close.* An auditor's first question on a
     recurring reconciliation is "does each period roll forward from the prior one?" The product cannot answer
     it: the packet computes `balances.reconciled` (the ending number) but never exposes a structured close,
     and the next run has no way to assert "my opening == the prior period's ending."*

*The fix is a small, versioned, strictly-validated "period-close" artifact — the EXACT proven pattern already
in this codebase (cli/receipt.js's versioned receipt; trustledger/policy.js's strict validator): each run can
EMIT a `*.close.json` (schemaVersion, period label, reportDate, opening {bank,book}, ending {bank,book},
subledger, tiesOut/pass, a content digest of the inputs), and the next run can CONSUME a prior close
(`--prior-close <file>`) to (a) seed the opening balances automatically and (b) ASSERT continuity — this
period's opening MUST equal the prior period's ending, else a hard CONTINUITY exception. Pure-local, offline,
deterministic, NO crypto/token, NO new heavy dep, NO deploy. ADDITIVE: with no `--prior-close`/`--emit-close`
the engine behaves byte-for-byte as today (every EPIC-22/23 test stays green; test command unchanged: `npx
hardhat test`). This is the one auto-buildable capability that converts the lead product from "a broker runs
their files ONCE and watches three numbers tie out" into "a broker runs their files EVERY month with the chain
proven forward" — the precondition for a design partner to keep using it past month one, which is what P-5 #3
actually validates.*

- **T-24.1** `VERIFIED` `trustledger/close.js` — a versioned, strictly-validated period-close artifact + a pure
  `buildClose` / `readClose` / `validateClose`, plus a pure `checkContinuity(priorClose, opening)`.
  deps: T-22.3 (VERIFIED), T-22.4 (VERIFIED). files: trustledger/close.js (new),
  test/trustledger.close.test.js (new)
  - Problem: a monthly trust reconciliation is a continuous chain (each period's ending == the next period's
    opening), but the engine has no machine-readable close artifact and no way to roll one period forward into
    the next or to verify the roll-forward.
  - Acceptance:
    1. A new `trustledger/close.js` defines a versioned JSON close schema and PURE `buildClose(model)` /
       `readClose(text|obj)` / `validateClose(obj)` with STRICT validation (rejects a wrong `schemaVersion`,
       a missing/garbled `period`/`reportDate`/`opening`/`ending`/`subledger`, a non-integer-cents balance,
       or a malformed `inputsDigest`) — never silently accepts a partial/corrupt close. `buildClose` derives
       the artifact PURELY from the existing report packet model (reuse `model.opening`, `model.balances`,
       `model.period`, `model.reportDate`, `model.pass`/`tiesOut`); the `ending` balances are
       `{ bank: model.balances.bank, book: model.balances.book }` (the period's closing bank/book) and
       `subledger` is `model.balances.subledger`. It computes a deterministic `inputsDigest` (a SHA-256 over
       the normalized inputs the packet already holds, via Node's built-in `crypto` — NO new dep) so a close
       is bound to the data it summarizes. Byte-deterministic given the same model.
    2. A pure `checkContinuity(priorClose, opening)` returns a structured result — e.g.
       `{ ok, bankGap, bookGap }` — comparing the prior close's `ending` to THIS period's `opening`
       (penny-exact; the comparison itself takes no tolerance — a roll-forward must be exact). Side-effect
       free; null/undefined `priorClose` returns `{ ok: true }` (no prior period to chain from). The function
       does NOT throw on a gap — it reports it, so the caller decides how to surface it (T-24.2 makes it a
       continuity exception).
    3. The close artifact is an UNTRUSTED convenience hint, consistent with the codebase's standing posture
       (docs/TRUST-BOUNDARIES.md / the receipt NatSpec): it carries the prior period's asserted ending so the
       next run can seed + check the opening, but the authoritative verdict is still the recomputed
       reconciliation. JSDoc states this plainly and notes the close is NOT signed/timestamped (that rides the
       human trust-root, same as every other artifact in the repo).
    4. Tests: round-trip (`buildClose` → `readClose` reproduces the fields) + EVERY validation-rejection
       branch (bad version, missing field, non-integer cents, malformed digest); `buildClose` from a known
       packet model produces the expected ending/subledger/digest; `checkContinuity` returns `ok:true` when
       the prior ending equals this opening, and a non-zero `bankGap`/`bookGap` (with `ok:false`) when it does
       not; a null prior close is `ok:true`. Full suite green (`npx hardhat test`).
- **T-24.2** `VERIFIED` Wire `--prior-close <file>` / `--emit-close <file>` into `vh trust reconcile` so a run
  rolls forward from the prior period and emits its own close, with a hard CONTINUITY exception on a break.
  deps: T-24.1, T-22.4 (VERIFIED), T-23.2 (VERIFIED). files: trustledger/cli.js, trustledger/reconcile.js
  (add a CONTINUITY_BREAK exception type to the EXCEPTION enum + DEFAULT_SEVERITY), trustledger/report.js
  (thread the prior-close continuity check into the packet), test/trustledger.close.cli.test.js (new) or
  test/trustledger.e2e.test.js
  - Problem: even with a close artifact, the one command a broker runs cannot consume the prior period or emit
    the next one, so the monthly chain is still a manual re-typing of opening balances with no continuity guard.
  - Acceptance:
    1. `vh trust reconcile ... [--prior-close <file>] [--emit-close <file>]`. `--prior-close` reads + validates
       a close via `close.readClose` (a malformed/unreadable close is a USAGE error, exit 2 — a bad flag value,
       NOT a data-file IO error, mirroring how `--policy` is handled). When `--prior-close` is given, its
       `ending` SEEDS the opening balances (`--opening-bank`/`--opening-book` then act as an explicit OVERRIDE
       that, if it disagrees with the prior close, is itself surfaced — builder's choice: error or a noted
       override — documented). `--emit-close` writes THIS run's `close.json` (built via `close.buildClose`) to
       the named path; like the packet it is written only to a caller-named path, never silently to cwd.
    2. A NEW `EXCEPTION.CONTINUITY_BREAK` type (added to reconcile.js's EXCEPTION enum + DEFAULT_SEVERITY,
       default `error` — a broken roll-forward means the books do not actually continue from the signed prior
       period, an out-of-trust-grade finding) is raised when `checkContinuity(priorClose, opening)` reports a
       non-zero gap, carrying the bank/book gap in its `amount`/`detail`. It flows through the SAME
       severity-first ordering, the counts, the PASS/FAIL verdict, the 0/3 exit code, and the rendered report
       as every other exception — AND is overridable by the per-state policy exactly like the others (some
       states may treat a documented timing roll-forward difference as a warning). Without `--prior-close`,
       NO continuity exception is ever raised and behaviour is byte-for-byte today's.
    3. The report (HTML + CSV + `--json`) names the prior period it chained from (when `--prior-close` is used)
       and shows the roll-forward (prior ending → this opening) so an auditor sees the chain; the close
       artifact emitted under `--emit-close` is referenced in the output (the path written). Output stays
       DATED and deterministic; filesystem hygiene preserved (writes ONLY to caller-named paths).
    4. Tests: reconciling the existing e2e fixture set with NO close flags yields the SAME PASS/FAIL +
       balances + exception list as today (proves additivity — no regression to any T-22.4/T-23.2 assertion);
       emitting a close from period 1 then feeding it as `--prior-close` to a period-2 run whose opening MATCHES
       seeds the opening + raises NO continuity exception; a period-2 run whose data does NOT roll forward from
       the prior close raises a CONTINUITY_BREAK (error) and flips the verdict to FAIL with exit 3, naming the
       gap; a malformed `--prior-close` file exits 2 (usage); `--emit-close` writes a valid close that
       round-trips through `close.readClose`; the policy can re-grade a CONTINUITY_BREAK. Suite green.
- **T-24.3** `VERIFIED` Document the period-close continuity layer + SHARPEN P-5 item #3 to a "run it two months
  in a row" design-partner script. deps: T-24.1, T-24.2. files: docs/TRUSTLEDGER.md, STRATEGY.md (P-5 #3
  sharpen), test/ (extend a docs-rot guard if one exists)
  - Acceptance: `docs/TRUSTLEDGER.md` documents the close-artifact schema (every field, which are
    hints/digests), the `--prior-close`/`--emit-close` flow, how the continuity check + CONTINUITY_BREAK work,
    that a close is an UNTRUSTED hint (re-derive; not signed/timestamped), and a worked example (run month 1
    with `--emit-close`, then run month 2 with `--prior-close` → continuity holds → break a balance → see the
    CONTINUITY_BREAK FAIL). It states plainly the artifact is a convenience for chaining periods, not a legal
    record. STRATEGY.md's P-5 item #3 is SHARPENED from "engage 1–2 partners and run their real monthly files"
    to the now-concrete, decision-ready design-partner script: "have a partner run `vh trust reconcile … --state
    <code> --emit-close month1.json` on their REAL month-1 files, then re-run on month-2 files with
    `--prior-close month1.json`; confirm (a) the three balances tie out both months, (b) the roll-forward is
    clean, and (c) the exceptions read correctly — that two-month run IS the WTP validation." No new runtime
    behaviour; pure docs of T-24.1/T-24.2.

## EPIC-25 — TrustLedger: make a REAL broker's REAL files actually load  *(the P-5 #3 ingest de-risk — the single technical thing most likely to kill the design-partner pilot on contact with reality)*

*Motivation (Strategist 2026-06-24): the metrics show genuine QUALITY STAGNATION, not just a flat plateau —
avgUsefulness DROPPED 4.0 → 3.75 and minUsefulness 4 → 3 on the latest run, with humanGated stuck at 3 across
six runs. EPIC-22/23/24 were three consecutive increments all orbiting the SAME dam (P-5, TrustLedger
go-to-market), which is now EXHAUSTIVELY sharpened: all three sub-items (CPA sign-off, the per-state policy
table, the two-month design-partner script) are crisp, decision-ready human asks. The directive is explicit —
when quality plateaus AND humanGated persists, do NOT invent more increments in the capped vein and do NOT
re-sharpen an already-sharp human ask (busywork); instead build the auto-buildable work that DIRECTLY DE-RISKS
the human gate, and pursue materially-different, higher-leverage work.*

*The gap I found (confirmed in code, not invented). P-5 #3 — the actual willingness-to-pay validation — is "a
partner runs their REAL monthly files." But the loop has only ever proven the pipeline against its OWN curated
fixtures. I read `trustledger/ingest.js` and `trustledger/cli.js` end to end and found the single most likely
point of failure in the whole P-5 #3 script is INGEST CHOKING ON A REAL BROKER'S FILE — and when it does, the
broker hits a dead end:*
  1. *A real bank/QuickBooks/rent-roll export routinely has headers the alias lists don't cover (a QuickBooks
     "Transaction Detail by Account" export, a bank that labels the column "Running Balance" / "Withdrawal Amt." /
     "Credit Amt.", a rent-roll with "Tenant Name" + "Amount Paid"). When `indexHeader`/`requireCols` can't find
     a required column, `cli.js:304-311` collapses the whole run to ONE line — `error: missing required column
     "date" in header` with exit 1 — and the broker has NO way to see what columns the file DOES have, which ones
     the tool matched, or how to fix it. That is exactly where a design partner abandons the pilot on file one.*
  2. *Even when the header is found, the FIRST malformed cell aborts the entire file with a single located error
     (`unrecognized date: "Jan 5, 2024" (row 12, bank)`) and the broker cannot see whether it's one stray row or
     a systemic format mismatch — they get no preview, no count of how many rows parsed, no sample of the
     normalized records. A reconciliation tool that fails closed on the first surprise with no diagnostic is, to
     a non-technical broker, simply broken.*
  3. *There is NO command to VALIDATE / PREVIEW a file independently of running the full three-way reconciliation,
     and no way to supply a one-off COLUMN MAPPING when the auto-detect misses. So the only feedback loop a design
     partner has is "run the whole thing → cryptic error → give up."*

*The fix is materially different work from EPIC-22/23/24 (input ROBUSTNESS + a DIAGNOSTIC surface + a mapping
ESCAPE HATCH, not another engine/close/policy increment): (a) a new `vh trust inspect <file> --as <bank|ledger|
rentroll>` read-only command that parses ONE file, reports the detected columns + which logical field each mapped
to + how many rows normalized + a small sample + EVERY row that failed (not just the first), with an actionable
"add this column / use --map" hint — turning a dead-end error into a self-service fix; (b) a `--map
<logical>=<header>` / `--map-file <json>` override so a broker whose headers the aliases miss can point the parser
at the right columns WITHOUT editing source; (c) wider built-in alias + date-format coverage drawn from the real
QuickBooks / bank / rent-roll exports the target buyer actually uses. This is the one auto-buildable capability
that converts P-5 #3 from "hope their file happens to match our fixtures" into "their file loads, or the tool
tells them exactly how to make it load." Pure-local, offline, deterministic, NO crypto/token, NO new heavy dep, NO
deploy. STRICTLY ADDITIVE: with no new flags every EPIC-22/23/24 test stays byte-for-byte green; test command
unchanged (`npx hardhat test`). It does NOT auto-resolve any legal meaning — P-5 stays human-gated.*

- **T-25.1** `VERIFIED` Diagnostic ingest core: parse-with-report (collect ALL row errors + detected-column map),
  WITHOUT changing the existing fail-closed parsers. deps: T-22.1 (VERIFIED). files: trustledger/ingest.js,
  test/trustledger.ingest.diagnose.test.js (new)
  - Problem: the parsers abort on the FIRST bad row and surface only a single error, and there is no way to see
    which header columns the tool detected / mapped, so a broker whose real file doesn't parse has no path to fix
    it.
  - Acceptance:
    1. Add a PURE, side-effect-free `diagnose{Bank,QuickBooks,RentRoll}(text, opts)` family (or one
       `diagnoseSource(source, text, opts)`) that returns a structured report WITHOUT throwing on row errors:
       `{ source, header: string[], mapped: { <logical>: <headerNameOrNull> }, requiredMissing: string[],
       rowCount, okCount, records: NormalizedRecord[] (the rows that parsed), errors: [{ row, message }] (EVERY
       failing row, not just the first), sample: NormalizedRecord[] (first N ok rows) }`. It REUSES the existing
       `parseCSV`/`indexHeader`/`parseDate`/`parseCents`/`coerceKind` primitives verbatim (no re-implementation of
       parsing logic) — it differs from the strict parsers ONLY in that it accumulates row errors instead of
       throwing on the first, and exposes the column map. A missing REQUIRED column is reported in
       `requiredMissing` (still surfaced as a hard problem) rather than collapsing the whole file.
    2. The existing strict `parseBankStatement`/`parseQuickBooksCSV`/`parseRentRollCSV` are UNCHANGED in behaviour
       (the reconcile path must keep failing closed on a malformed file — a silent partial parse in a trust
       reconciliation is dangerous). The diagnostic path is a SEPARATE, additive function used only by the
       inspect command (T-25.2), so no reconcile/e2e/close/policy test regresses.
    3. Tests: a clean file reports `okCount == rowCount`, the right `mapped` columns, and `errors: []`; a file
       with 3 bad rows reports ALL 3 in `errors` (with their 1-based row numbers) AND still returns the parsed
       rows in `records`; a file missing the `date` column reports it in `requiredMissing` with the detected
       `header` echoed back; the `mapped` map shows which header satisfied each logical field (and `null` for
       unmatched optional fields); a split debit/credit file and a signed-amount file both map correctly. Full
       suite green; `npx hardhat test` unchanged.
- **T-25.2** `VERIFIED` `vh trust inspect <file> --as <bank|ledger|rentroll>` — a read-only file validator/preview that
  turns a dead-end ingest error into a self-service fix. deps: T-25.1, T-22.4 (VERIFIED). files: trustledger/cli.js,
  cli/vh.js (usage + dispatch), test/trustledger.inspect.cli.test.js (new)
  - Problem: a broker whose real file doesn't load gets one cryptic line from `vh trust reconcile` and no way to
    see what the tool detected or how to fix it — exactly where a design partner abandons the pilot.
  - Acceptance:
    1. `vh trust inspect <file> --as <bank|ledger|rentroll> [--bank-format csv|ofx] [--json] [--sample <n>]`
       (read-only, NO file written anywhere) runs `diagnoseSource` and prints, for that one file: the detected
       header columns; for each LOGICAL field the header it mapped to (or "(not found)"); the count parsed OK vs
       total; a small SAMPLE of normalized records (date / signed-cents / kind / party / memo); and EVERY failing
       row with its number + reason. When a required column is missing OR any row failed, it prints an actionable
       hint ("add a column named one of [...] OR pass --map <logical>=<yourHeader>") and exits 3 (the data-gate
       FAIL code); a fully-clean file exits 0. A malformed `--as` value or an unreadable file is a usage/IO error
       (exit 2 / 1) consistent with `reconcile`. `--json` emits the full diagnostic report for piping.
    2. Wire `inspect` into the `vh trust` subcommand dispatch (currently only `reconcile`) in trustledger/cli.js,
       and add it to the `vh` usage block in cli/vh.js with the "read-only, writes nothing" property. Unknown
       flags hard-error with usage (parser parity with `reconcile` — a typo never silently returns a wrong view).
    3. The output LEADS with the standing TrustLedger caveat (the tool AIDS reconciliation; the broker remains the
       responsible custodian) and states plainly that `inspect` only checks that the file PARSES into the
       normalized model — it does NOT reconcile or attest anything. Cross-link `vh trust reconcile` in the output.
    4. Tests (drive the public command over fixtures): a clean bank/ledger/rentroll file each report OK with the
       right column map and exit 0; a file with a missing required column exits 3 and names the missing column +
       the alias hint; a file with malformed rows exits 3, lists every bad row, AND still previews the good rows;
       `--json` round-trips the report; an unreadable file exits 1; a bad `--as` exits 2; `inspect` writes NOTHING
       to the filesystem (assert a throwaway temp dir stays empty). Suite green.
- **T-25.3** `VERIFIED` Column-mapping escape hatch (`--map`/`--map-file`) + wider real-export alias & date coverage, so
  a broker whose headers the auto-detect misses can load their file without editing source. deps: T-25.1, T-25.2.
  files: trustledger/ingest.js, trustledger/cli.js, test/trustledger.map.test.js (new),
  test/trustledger.ingest.test.js
  - Problem: when a real export's headers fall outside the alias lists, today the ONLY recourse is editing source;
    a design partner cannot self-serve, and the alias/date coverage is narrower than real QuickBooks / bank /
    rent-roll exports use.
  - Acceptance:
    1. Add an OPTIONAL `columnMap` to the ingest opts (a pure `{ <logical>: <exactHeaderName> }`): when present it
       OVERRIDES the alias auto-detect for those logical fields (validated — an unknown logical key, or a header
       not present in the file, hard-errors with a clear message naming the available headers; reuse the existing
       IngestError style). It threads through BOTH the strict parsers AND `diagnoseSource` (so `inspect` previews
       under the same mapping the reconcile run will use). With no `columnMap`, behaviour is byte-for-byte today's.
    2. `vh trust reconcile` and `vh trust inspect` accept `--map <logical>=<header>` (repeatable) and `--map-file
       <json>` (a `{ bank|ledger|rentroll: { <logical>: <header> } }` per-source mapping); malformed map syntax or
       an unreadable map file is a usage error (exit 2). `inspect` honoring the same map lets a broker iterate
       (inspect → see the miss → add `--map` → inspect again → it loads) before committing to the full run.
    3. WIDEN the built-in coverage from the real exports the target buyer uses (additively — only ADD aliases /
       date formats, never remove or reorder existing ones so no current fixture's mapping changes): e.g. bank
       "withdrawal amt"/"deposit amt"/"credit amt"/"debit amt"/"running balance"(ignored)/"check number"; QB
       "num"/"split"/"account"/"clr"; rent-roll "amount paid"/"amount due"/"balance"/"lease". Add date acceptance
       for the common `Mon DD, YYYY` / `DD-Mon-YYYY` textual forms (deterministic month-name table, calendar-
       validated like the existing `parseDate`), since QuickBooks frequently exports `Jan 5, 2024`.
    4. Tests: a file whose headers match NO alias loads correctly under an explicit `--map`/`columnMap`; an
       unknown logical key or a mapped-to header absent from the file hard-errors naming the available headers; a
       `--map-file` applies per-source maps; the new aliases let a realistic QuickBooks/bank/rent-roll fixture
       (added under trustledger/fixtures/) parse with NO map; the new textual date forms parse and a bad textual
       date still rejects; EVERY existing ingest/reconcile/e2e/close/policy test stays green (additive). Suite
       green; `npx hardhat test` unchanged.
- **T-25.4** `VERIFIED` Document `vh trust inspect` + the column-mapping escape hatch, and SHARPEN P-5 #3's
  design-partner script to lead with `inspect`. deps: T-25.2, T-25.3. files: docs/TRUSTLEDGER.md, STRATEGY.md
  (P-5 #3 sharpen), test/ (extend a docs-rot guard if one exists)
  - Acceptance: `docs/TRUSTLEDGER.md` documents `vh trust inspect` (what it reports, the exit codes, that it
    writes nothing and only checks PARSING), the `--map`/`--map-file` override (syntax + a worked "my header isn't
    recognized → inspect → --map → it loads" example), and the widened alias/date coverage, reusing the standing
    custodian/trust caveats so they stay consistent. STRATEGY.md's P-5 #3 is SHARPENED so the design-partner
    script LEADS with the de-risked onboarding step: "FIRST have the partner run `vh trust inspect <eachFile>
    --as <type>` on their REAL files to confirm each parses (fixing any header miss with `--map`), THEN run the
    two-month `--emit-close`/`--prior-close` reconcile script" — turning "hope their file matches our fixtures"
    into "their file loads or the tool tells them how to make it load." No new runtime behaviour; pure docs of
    T-25.1/T-25.2/T-25.3.

## EPIC-26 — Tamper-evident reconciliation SEAL  *(make the TrustLedger packet a defensible evidentiary artifact, on the existing provenance core)*

*Motivation (Strategist 2026-06-24): the build frontier is EMPTY and the metrics REGRESSED — avgUsefulness
4.0 → 3.75, minUsefulness 4 → 3, humanGated standing 3–4. The directive for flat-and-mediocre-WITH-persistent-
humanGated is explicit: do NOT invent more incremental items in the same vein; change approach MATERIALLY toward
a capability that unlocks NEW value. EPIC-22→23→24→25 were FOUR consecutive TrustLedger ENGINE increments all
orbiting the SAME P-5 go-to-market dam — and EPIC-25 itself observed the regression yet stayed in the same
codebase (more parser robustness). A fifth engine increment is the capped vein. P-5's three items are already
crisp, decision-ready human asks (CPA sign-off, the per-state policy table, the two-month design-partner script);
re-sharpening them is busywork. So the move is a genuinely DIFFERENT KIND of work that multiplies value: connect
the project's ORIGINAL DNA — the shared provenance core under `cli/core/` (manifest.js, attestation.js,
timestamp.js: content-addressed manifests, signed attestations, RFC-3161 binding — all built + tested) — to the
LEAD product, delivering a capability the engine increments never touched.*

*The gap I found (confirmed in code, not invented). `vh trust reconcile --out <dir>` writes the audit-ready
HTML + CSV packet a broker hands to a state real-estate examiner months later — but that packet is NOT
tamper-evident. There is NO way for the examiner (or the broker defending themselves) to prove "this is the EXACT
packet TrustLedger produced on date T from these EXACT source files, byte-for-byte unaltered." `trustledger/
close.js` computes an `inputsDigest`, but its own NatSpec is explicit that it is a SHA-256 over the close's
SUMMARY only — "NOT a cryptographic proof of the underlying source files." So a reconciliation whose entire
selling point is being a defensible audit artifact for a custodian carrying personal license risk currently ships
as an UNSEALED printout: anyone can edit the HTML/CSV after the fact and nothing detects it. That is exactly the
evidentiary gap the provenance core was built to close — and it is a NEW capability for the LEAD product, not a
fifth tweak to the matcher/classifier.*

*The move (the proven manifest/attestation pattern, repointed at the reconciliation packet). Reuse the EXISTING,
tested `cli/core/manifest.js` (content-addressed manifest over a file set) + `attestation.js` (the canonical
UNSIGNED attestation + the offline verifier) VERBATIM — no new crypto, no contract change, no network, no key,
no new human decision — to bind {the three SOURCE input files + every emitted packet file} into one
content-addressed SEAL the examiner can independently verify offline. The honest posture is inherited verbatim
from the core: the seal proves the packet + inputs are byte-for-byte what TrustLedger produced (tamper-evidence);
"sealed ON date T" still rides the human-owned trust-root (P-3's signing/timestamp leg) — the seal SAYS so and
references (does NOT execute) the human-gated sign/timestamp steps. Signing in tests uses EPHEMERAL throwaway
`Wallet.createRandom()` keys only.*

*Why this beats the alternatives. (a) A fifth TrustLedger engine increment is the capped vein the regression
warns against — four in a row already plateaued then regressed. (b) Re-sharpening P-5 #1/#2/#3 is busywork; they
are decision-ready. (c) Multi-period carry-forward of OUTSTANDING items is real feature breadth but is more
engine work in the same vein and presupposes the packet is trustworthy. (d) A web/upload UI is premature (needs
hosting, a human step). Sealing the packet is a NEW capability (a defensible, independently-verifiable
evidentiary artifact) that connects the two halves of the project, is fully auto-buildable on already-tested core
modules, and directly raises the value of the LEAD product's headline deliverable — the audit packet — for the
exact buyer (a custodian who must DEFEND that packet to an examiner). Pure-local, offline, deterministic, NO
crypto/token/coin/NFT/sale/yield, NO funds, NO deploy, NO real key. STRICTLY ADDITIVE: with no `--seal` flag the
reconcile command behaves byte-for-byte as today, so every EPIC-22..25 test stays green and the test COMMAND is
unchanged (`npx hardhat test`). REVENUE INTEGRITY unchanged: income = a SaaS subscription for the legally-forced
monthly chore; the seal raises the deliverable's defensibility but the CPA review, signing trust-root (P-3),
pricing, and design partners all stay human steps (P-5).*

- **T-26.1** `VERIFIED` Pure reconciliation-seal core: build + verify a content-addressed manifest over the packet's
  SOURCE inputs + emitted output files, on top of the EXISTING `cli/core/manifest.js`. deps: T-22.4 (VERIFIED).
  files: trustledger/seal.js (new), test/trustledger.seal.test.js (new)
  - Problem: the audit packet is an unsealed printout — there is no artifact binding {the 3 source files + every
    emitted packet file} so that a later, independent party can prove the packet is byte-for-byte unaltered.
  - Acceptance:
    1. A new `trustledger/seal.js` exposes PURE, I/O-free helpers (the file READING is done by the caller/CLI;
       seal.js takes already-loaded `{ relPath, bytes }` entries) that build a versioned, strictly-validated
       reconciliation-seal object over a file set partitioned into `inputs` (the bank/ledger/rentroll sources, by
       their logical role) and `outputs` (every packet file the reconcile emitted), using the EXISTING
       `cli/core/manifest.js` content-addressing convention VERBATIM (require it; do NOT re-implement hashing or
       leaf construction). The seal records, per file: its logical role/relPath + its content hash, plus a single
       top-level content-addressed root over the whole set. It also carries the reconcile's PASS/FAIL verdict +
       report date as recorded facts (so the seal names what it sealed).
    2. The seal has its own `kind`/`schemaVersion`; `validateSeal` REJECTS a wrong version, a missing/duplicate
       role, a malformed hex hash, or a root that does not re-derive from the listed entries — never silently
       accepts a partial/corrupt seal (mirror the strict-validation style of `close.js`/`receipt.js`).
    3. A pure `verifySeal(seal, files)` recomputes the manifest/root from the supplied `{ relPath, bytes }` set
       and returns a structured result naming EXACTLY which files MATCH / are CHANGED (hash differs) / MISSING /
       UNEXPECTED, plus an overall ACCEPTED/REJECTED — so a verifier can localize a tamper to a single file, not
       just say "something changed." The authoritative check is the recompute; the seal's stored hashes are the
       expectation. The seal is an UNTRUSTED transport container consistent with docs/TRUST-BOUNDARIES.md.
    4. Honest posture, stated in seal.js NatSpec + surfaced by the verifier: the seal proves the inputs + packet
       are byte-for-byte what was sealed (TAMPER-EVIDENCE); it does NOT by itself prove a trusted TIMESTAMP
       ("sealed on date T" rides the human trust-root P-3) and does NOT validate the legal MEANING of the
       reconciliation (the CPA review still governs). The seal MAY be wrapped by the existing
       `cli/core/attestation.js` signed-attestation envelope (the seal's canonical bytes become the attestation
       payload) — proven in tests with an EPHEMERAL `Wallet.createRandom()` key — so signing is the SAME shared
       path, no new scheme.
    5. Tests (test/trustledger.seal.test.js, pure/offline, NO live node): build a seal over a known input+output
       set then `verifySeal` ACCEPTS the unmodified set; flipping ONE byte of ONE output file makes `verifySeal`
       REJECT and name exactly that file as CHANGED; dropping a file → MISSING; adding one → UNEXPECTED; a wrong
       `schemaVersion`/malformed-hash/bad-root seal is REJECTED by `validateSeal`; the seal's root re-derives from
       the entries via the SAME `cli/core/manifest.js` convention (proving reuse, not a re-implementation); a seal
       wrapped in a signed attestation round-trips through `recoverSigner`/`verifySignedAttestation` with an
       ephemeral key. Full suite green; `npx hardhat test` unchanged.
- **T-26.2** `VERIFIED` `vh trust reconcile --seal <file>` emits the seal alongside the packet, and a new read-only
  `vh trust verify-seal <sealfile>` independently verifies it offline. deps: T-26.1, T-22.4 (VERIFIED).
  files: trustledger/cli.js, cli/vh.js, test/trustledger.seal.cli.test.js (new)
  - Problem: the pure seal core (T-26.1) has no CLI — a broker can't emit a seal with their packet and an examiner
    can't independently verify one.
  - Acceptance:
    1. `vh trust reconcile <bank> <ledger> <rentroll> --out <dir> --seal [<file>]` writes the seal (default name
       under `--out`, or the caller-named path) AFTER the packet files are written, sealing the 3 SOURCE inputs +
       every emitted packet file (and the emitted close, if `--emit-close` was used). The seal entries' bytes are
       read from the just-written files / the original sources by the CLI (seal.js stays pure). `--seal` WITHOUT
       `--out` hard-errors (there is no packet to seal) with an actionable message — parser parity with existing
       flags. Without `--seal`, behaviour is EXACTLY today's (no regression to any EPIC-22..25 test). The success
       output names the seal path; `--json` adds the seal path to the existing result object.
    2. `vh trust verify-seal <sealfile> [--dir <d>] [--json]` (read-only, NO key, NO network): load the seal,
       resolve each listed file (default: relative to the seal file's directory, or `--dir`), recompute via
       `verifySeal`, and print ACCEPTED only when EVERY file matches; otherwise REJECTED with the precise
       per-file CHANGED/MISSING/UNEXPECTED list and a non-zero exit, using the project's existing 0 / 3 exit
       convention (0 ACCEPTED, 3 REJECTED, 2 usage, 1 IO). A malformed/missing seal file hard-errors before any
       file read. Output LEADS with the standing custodian/trust caveat + the seal posture (tamper-evidence, NOT
       a trusted timestamp; CPA review still governs).
    3. Both commands route through `vh trust` dispatch + usage exactly like `reconcile`/`inspect`; unknown flags
       hard-error with usage. The seal command set is documented in the in-band `vh trust` help.
    4. Tests (test/trustledger.seal.cli.test.js, offline, isolated temp dir — NO leaked artifacts): drive
       `vh trust reconcile … --out tmp --seal`, assert the seal file exists and lists the inputs + every packet
       file; `vh trust verify-seal <seal> --dir tmp` ACCEPTS; editing one packet file then verify-seal REJECTS and
       names that file; deleting a file → MISSING/REJECT; `--seal` without `--out` errors; `--json` round-trips;
       every filesystem effect stays inside the throwaway temp dir (working tree clean). Full suite green.
- **T-26.3** `VERIFIED` Document the reconciliation seal + cross-link it; SHARPEN P-5 #1 to note the deliverable is
  now a SEALED, independently-verifiable artifact. deps: T-26.1, T-26.2. files: docs/TRUSTLEDGER.md, STRATEGY.md
  (P-5 #1 sharpen), test/ (extend a docs-rot guard if one exists)
  - Acceptance: `docs/TRUSTLEDGER.md` gains a "Sealing the packet: tamper-evident, independently verifiable"
    section specifying the seal schema (every field; all UNTRUSTED transport — verification re-derives), the
    `--seal` write flow, the offline `verify-seal` flow + its exit codes, the per-file CHANGED/MISSING/UNEXPECTED
    semantics, the honest posture (tamper-evidence, NOT a trusted timestamp — that rides P-3; the seal MAY be
    signed via the shared attestation envelope), and a worked end-to-end example (reconcile --seal → hand over the
    --out dir + seal → verify-seal). Reuses the standing custodian/trust caveats so they stay consistent.
    STRATEGY.md's P-5 #1 is SHARPENED to note that the audit deliverable is now a SEALED artifact an examiner can
    independently verify byte-for-byte (so the CPA/counsel review is of a tamper-evident packet, and the human
    signing/timestamp trust-root for "sealed on date T" is P-3). No new runtime behaviour; pure docs of
    T-26.1/T-26.2.

## EPIC-35 — The ZERO-INSTALL, single-file verifier: make the FREE tier a frictionless organic-adoption funnel  *(material change of approach — stop de-risking the SALE (P-8 is saturated after 4 runs) and remove the friction in the FREE-verify funnel that PULLS the paid seal, with NO human gate; see STRATEGY.md "## Direction" 2026-06-24)*

*Why this EPIC (read STRATEGY.md "## Direction" 2026-06-24 first): the revenue model is "PAY to produce a
seal, verification is FREE forever." That means the free verifier IS the marketing engine — every
counterparty who runs it on a partner's seal is a warm lead for the paid seal. But today the ONLY way a
third party who received ONE sealed packet can verify it is to clone this whole repo (or be handed the
`verifier/` tree) and run `cd verifier && npm install` — which still pulls a runtime dependency (`js-sha3`;
secp256k1 is already vendored in `verifier/lib/secp256k1-recover.js`). So the strongest possible "don't
trust us, check it yourself" artifact — a SINGLE, dependency-free file a skeptic can `curl`/save and run
with `node` and ZERO install, and audit in one sitting — does not exist. That single-file, zero-install
path is the lowest-friction funnel entry and is 100% auto-buildable with NO human gate. This is materially
different from EPIC-31..34 (which all de-risked the SALE side / P-8): it attacks the value ceiling from the
FUNNEL side. STRICTLY ADDITIVE: the existing `verifier/` tree, its `js-sha3` dependency, and the
isolation test's "declares ONLY js-sha3" assertion all stay EXACTLY as-is — the single-file build is a NEW
artifact alongside them. NO token/coin/NFT/sale/yield, NO funds, NO deploy, NO real key. Income is still a
paid SEAL/licence for delivered value; verification stays FREE.*

- **T-35.1** `VERIFIED` Vendor keccak256 so the verifier core can run with ZERO runtime dependencies. deps: EPIC-31 (verifier tree).
  - files: `verifier/lib/keccak256-vendored.js` (NEW — a small, pure, audited keccak-f[1600]/keccak256 in
    plain JS, NO `require` of anything external), `test/verifier.keccak-vendored.test.js` (NEW).
  - Acceptance: the vendored keccak256 produces byte-identical digests to BOTH `js-sha3` AND the production
    `ethers` keccak path across (a) the empty input, (b) all the known NIST/keccak test vectors that fit, and
    (c) ≥500 random byte buffers of varied length — a single mismatch FAILS. `verifier/lib/keccak.js` (the
    `js-sha3` wrapper) and `verifier/package.json`'s `dependencies: ["js-sha3"]` are UNCHANGED so the existing
    tree + isolation test stay green; the vendored module is a NEW, additive file. The vendored file requires
    nothing (a grep over its source finds no `require(` and no bare-name import). `npx hardhat test` unchanged.

- **T-35.2** `VERIFIED` Emit a SINGLE self-contained `verify-vh-standalone.js` — zero deps, zero install, copy-paste-and-run. deps: T-35.1.
  - files: `verifier/build-standalone.js` (NEW — a deterministic, OFFLINE bundler that inlines
    `verify-vh.js` + `lib/{merkle,canonical,secp256k1-recover}.js` + the T-35.1 vendored keccak into ONE file,
    rewriting the relative `require`s; no network, no third-party bundler dependency), `verifier/dist/verify-vh-standalone.js`
    (NEW — the committed build output), `test/verifier.standalone.test.js` (NEW).
  - Acceptance: (1) the bundler is DETERMINISTIC — running it twice yields byte-identical output, and the test
    REBUILDS in a temp dir and asserts the committed `dist/verify-vh-standalone.js` matches byte-for-byte (an
    anti-rot guard: a stale committed bundle FAILS CI). (2) The standalone file requires NOTHING outside Node
    core — a grep over it finds no `require('js-sha3')`, no `require('./lib/...')`, no `../`, no bare third-party
    name; copying it ALONE into an empty temp dir (no `node_modules`, no `package.json`) and running
    `node verify-vh-standalone.js <good-packet>` exits 0 and `<tampered-packet>` exits 3. (3) For a battery of
    artifacts (signed/unsigned evidence seal, reconciliation seal, dataset attestation, proof bundle; ACCEPT,
    CHANGED, MISSING, bad_signature, wrong_issuer; batch/manifest mode), the standalone file produces the
    EXACT same verdict text + exit code as the in-tree `verifier/verify-vh.js`. (4) The standalone still opens
    NO socket/network handle (reuse the EPIC-31 network-poison guard). `npx hardhat test` unchanged; the
    in-tree verifier is UNCHANGED.

- **T-35.3** `VERIFIED` Self-verifying distribution: a published checksum + a "get it in 10 seconds" counterparty path in docs. deps: T-35.2.
  - files: `verifier/dist/verify-vh-standalone.js.sha256` (NEW — the keccak/SHA-256 of the bundle, committed),
    `verifier/README.md` (EDIT — add the zero-install path), `docs/INDEPENDENT-VERIFICATION.md` (EDIT — add
    the single-file path as the FIRST/easiest counterparty option), `docs/PILOT.md` (EDIT — point a partner's
    counterparty at the one-file path), `test/verifier.standalone.test.js` (EDIT — assert the committed
    `.sha256` matches the committed bundle, and that the docs cite the standalone file path so the doc can't rot).
  - Acceptance: `docs/INDEPENDENT-VERIFICATION.md` documents the zero-install path FIRST ("save ONE file,
    optionally check its published SHA-256, run `node verify-vh-standalone.js <packet>` — no clone, no
    `npm install`, no account") while keeping the existing tree-based path for auditors who want the split
    sources; the honest scope boundary is RESTATED verbatim (tamper-evidence + signer-pin, NOT a trusted
    "sealed at T" without P-3) so the easier path never overclaims. A test asserts the committed `.sha256`
    equals the hash of the committed bundle and that each doc names `verify-vh-standalone.js`. NO new
    `needs-human` item; NO change to P-3/P-5/P-6/P-7/P-8. `npx hardhat test` unchanged.

## EPIC-36 — The ZERO-INSTALL, single-file SEALER: complete the self-service FREE-TIER round-trip (seal AND verify, both zero-install) so a stranger can feel the value with NO sales call  *(material change of approach — EPIC-35 made the FREE VERIFY side zero-install; this makes the FREE PRODUCE side zero-install too, closing the only organic adoption loop that needs NO P-8 human gate; see STRATEGY.md "## Direction" 2026-06-24)*

*Why this EPIC (read STRATEGY.md "## Direction" 2026-06-24 first). The revenue model is a try-before-you-buy
FREE tier — `cli/evidence.js:56` `SAMPLE_LIMIT = 25`: an UNSIGNED `vh.evidence-seal` of up to 25 files needs
NO license; SIGNING (`evidence_signed`) or sealing MORE than 25 files (`evidence_unlimited`) is the PAID
surface. EPIC-35 made the FREE VERIFY side zero-install (`verifier/dist/verify-vh-standalone.js`), but the
FREE PRODUCE side is still gated behind cloning the repo + `npm install` of the heavy `ethers`/`hardhat`
stack. So a prospect CANNOT today feel the value end-to-end without an install or a sales call: they can
zero-install VERIFY a seal someone handed them, but they cannot zero-install PRODUCE one of their own to hand
to a counterparty. This EPIC ships the symmetric half — a SINGLE, dependency-free file a prospect saves and
runs with `node` and ZERO install that seals up to 25 of their own files into a `vh.evidence-seal` the
EXISTING `verify-vh-standalone.js` accepts byte-for-byte. That completes the only adoption loop that delivers
value WITHOUT the P-8 human gate (no design partner, no key, no deploy, no payment): seal → hand off → verify,
all zero-install, all free, with the paid SIGN/UNLIMITED upgrade restated as the next step. This is a NEW axis
vs EPIC-31..35 (which all polished the SALE-side de-risk or the VERIFY funnel); it attacks the persistent
value ceiling from the PRODUCE funnel. The free crypto is ALREADY VENDORED: `verifier/lib/{keccak256-vendored,
merkle,canonical}.js` are the same path-bound keccak/merkle convention `cli/hash.js`+`cli/core/packetseal.js`
use, so the seal re-derives identically. STRICTLY ADDITIVE: the paid `vh evidence seal --sign`/`--license`
path, the 25-file cap, the license gating, the existing `verifier/` tree, and every EPIC-1..35 test stay
EXACTLY as-is. The free sealer CANNOT sign and CANNOT exceed 25 files (hard-errors pointing at the paid CLI) —
it never touches the paid surface. NO token/coin/NFT/sale/yield, NO funds, NO deploy, NO real key. Income
stays a paid SEAL/license for delivered value; producing a small UNSIGNED sample stays FREE.*

- **T-36.1** `VERIFIED` Vendor the FREE-TIER seal core: a pure, dependency-free `sealEvidence({entries})` that produces
  a byte-identical `vh.evidence-seal` to the paid CLI for the same inputs. deps: EPIC-35 (vendored keccak/merkle/canonical), EPIC-13/EPIC (evidence seal).
  - files: `verifier/lib/seal-evidence.js` (NEW — a pure, I/O-free `buildEvidenceSeal({ entries: [{relPath, bytes}], note })`
    that reuses the ALREADY-VENDORED `./keccak256-vendored` + `./merkle` + `./canonical` to emit the SAME
    `kind: "vh.evidence-seal"` object shape `cli/core/packetseal.js` + `cli/evidence.js` produce — same root,
    same per-file `relPath`/content-hash entries, same canonical field order, same `note`; NO `require` of
    anything outside `./lib` + Node core, NO ethers, NO js-sha3, NO key, NO signing), `test/freeseal.parity.test.js` (NEW).
  - Acceptance: for ≥200 randomized small folders (1..25 files, varied names/sizes incl. empty files, nested
    relPaths, unicode names), `buildEvidenceSeal` emits an object whose canonical JSON is BYTE-IDENTICAL to what
    the paid `cli/evidence.js` seal path produces for the same `{relPath, bytes}` set (drive the existing seal
    code in-process to get the reference). The produced seal is ACCEPTED by the in-tree `verifier/verify-vh.js`
    AND, after T-36.2, by `verify-vh-standalone.js` (exit 0 on the untouched copy, exit 3 after a one-byte
    tamper / a removed file). A grep over `verifier/lib/seal-evidence.js` finds no `require('ethers')`, no
    `require('js-sha3')`, no `../`, no bare third-party name. NO signing path exists in this module. The paid
    CLI, the 25-file cap, and the license gate are UNCHANGED. `npx hardhat test` unchanged.

- **T-36.2** `VERIFIED` Emit a SINGLE self-contained `seal-vh-standalone.js` — zero deps, zero install, seal-your-own-folder. deps: T-36.1.
  - files: `verifier/build-standalone.js` (EDIT — generalize the existing deterministic bundler to ALSO emit a
    second target, reusing the SAME `__modules`/`__require` inlining graph; do NOT regress the verify bundle),
    `verifier/dist/seal-vh-standalone.js` (NEW — committed build output), `verifier/dist/seal-vh-standalone.js.sha256`
    (NEW — committed checksum sidecar, same `sha256sum`-format as the verify bundle), `test/freeseal.standalone.test.js` (NEW).
  - Acceptance: (1) the bundler is DETERMINISTIC for BOTH targets — running it twice yields byte-identical
    output, and the test REBUILDS in a temp dir and asserts BOTH committed `dist/*-standalone.js` files match
    byte-for-byte (a stale committed bundle FAILS CI), and the committed `.sha256` sidecars equal the bundles'
    hashes. (2) `seal-vh-standalone.js` requires NOTHING outside Node core (`fs`/`path` only) — a grep finds no
    `require('ethers')`, no `require('js-sha3')`, no `./lib/`, no `../`, no bare third-party name; copying it
    ALONE into an empty temp dir (no node_modules, no package.json) and running
    `node seal-vh-standalone.js <folder> -o out.vhevidence.json` writes a `vh.evidence-seal` and exits 0. (3)
    ROUND-TRIP: the standalone-produced seal is ACCEPTED by `verify-vh-standalone.js` (exit 0), and exits 3 after
    a one-byte tamper of a sealed file or a deletion — proving the free PRODUCE and free VERIFY halves interoperate
    with ZERO install on either side. (4) The sealer ENFORCES the free-tier boundary: a folder of >25 files
    hard-errors (exit 2) with a message naming the paid `evidence_unlimited` entitlement + `vh evidence seal`,
    and the standalone has NO `--sign`/`--license`/`--key` flag at all (signing is the paid surface). (5) It opens
    NO socket/network handle (reuse the EPIC-31 network-poison guard) and writes ONLY the output file the user
    names (never the cwd otherwise). `npx hardhat test` unchanged; the verify bundle + in-tree verifier UNCHANGED.

- **T-36.3** `VERIFIED` Document the 10-second self-service round-trip and make it the FREE-tier funnel that names the paid upgrade. deps: T-36.2.
  - files: `verifier/README.md` (EDIT — add the seal-your-own-folder zero-install path next to the verify one),
    `docs/INDEPENDENT-VERIFICATION.md` (EDIT — add a "produce your own seal in 10 seconds, then verify it" round-trip
    section), `docs/PILOT.md` (EDIT — point a prospect at the zero-install seal→hand-off→verify loop as the
    no-install evaluation path), `test/freeseal.standalone.test.js` (EDIT — assert each doc names `seal-vh-standalone.js`
    and restates the honest boundary + the paid upgrade so the doc can't rot).
  - Acceptance: each doc documents the zero-install round-trip ("save ONE file, seal up to 25 of YOUR files, hand
    the `.vhevidence.json` to a counterparty who runs `verify-vh-standalone.js` — no clone, no `npm install`, no
    account, no key") and RESTATES the honest scope boundary VERBATIM (tamper-evidence + offline-recomputable, NOT
    a trusted "sealed at T" without P-3; the FREE seal is UNSIGNED and capped at 25 files — SIGNING and UNLIMITED
    are the paid `vh evidence seal --sign`/`--license` upgrade). A test asserts each doc names `seal-vh-standalone.js`
    and surfaces both the boundary and the paid-upgrade pointer. NO new `needs-human` item; NO change to
    P-3/P-5/P-6/P-7/P-8. `npx hardhat test` unchanged.

## EPIC-37 — Self-serve license FULFILLMENT: a plan catalog + an order→license mapping a billing webhook can drive  *(material change of approach — turn TrustLedger delivery from "a human at a terminal per sale" into automatic fulfillment; attacks the LOWER-friction revenue motion (buy without a sales call) instead of a 7th de-risk of the P-8 design-partner gate; directly SHARPENS/unblocks P-6 step (3); see STRATEGY.md "## Direction" 2026-06-25)*

*Why this EPIC (read STRATEGY.md "## Direction" 2026-06-25 first). EPIC-29 shipped the TrustLedger entitlement
layer — a signed, OFFLINE-verifiable `*.vhlicense.json` over the project's attestation core, `vh trust license
issue|verify`, and a real free/paid gate on `vh trust reconcile` enforced identically in the CLI and the web
door — so the product CAN be bought without a pilot. But it left a real per-sale hole: `vh trust license issue`
(`trustledger/cli.js:1746`) REQUIRES the human to pass `--entitlements <comma-list>` AND a hand-computed
`--expires <ISO>` for EVERY sale, and there is NO plan catalog anywhere (grep plan-catalog/fulfill/webhook over
`trustledger/ cli/ docs/ test/` finds nothing). That makes fulfillment (a) error-prone — a typo grants the
wrong tier; a hand-computed expiry drifts — and (b) UN-AUTOMATABLE: a Stripe/Paddle "payment succeeded" event
carries a PLAN id and a PAID-THROUGH date, never a comma-list of `multi_state_policy,seal,...` flags. So P-6
step (3) ("issue a license to each paying customer … renew each billing period") is a manual terminal step per
sale — the exact thing that makes self-serve revenue impossible. This is a NEW axis vs EPIC-31..36, which ALL
orbited the SAME high-touch human gate ("land ONE design partner / run the pilot", P-8) the loop is structurally
barred from completing — which is why usefulness has been pinned at 4.0 with humanGated standing at 3 for ≈14
runs. EPIC-37 instead removes the one in-code blocker to AUTOMATIC fulfillment: a versioned, strictly-validated
plan CATALOG over the CLOSED `ENTITLEMENTS` table (`trustledger/license.js:61`), a pure order→license mapping,
and `vh trust license fulfill` — so a billing webhook's handler becomes ONE deterministic command with no
hand-authored entitlement list. STRICTLY ADDITIVE: the existing `license issue`/`verify`, the CLI + web gate,
and every EPIC-1..36 test stay EXACTLY as-is; `fulfill` emits a container BYTE-COMPATIBLE with what they already
accept. The loop reuses `cli/core/license.js` + `cli/core/attestation.js` VERBATIM — no new crypto, no new dep.
The loop ships ONLY the catalog schema + the mapping + ephemeral test keys; it NEVER sets a price, holds a real
key, runs a payment processor, or takes a payment. NO token/coin/NFT/sale/yield, NO funds, NO deploy. Income
stays a paid SUBSCRIPTION/license for delivered software value (the free tier stays open) — an access credential,
NOT a tradeable/appreciating asset. This SHARPENS P-6 step (3); it adds NO new human gate and changes none of
P-3/P-5/P-7/P-8.*

- **T-37.1** `VERIFIED` The PLAN CATALOG: a versioned, strictly-validated `planId → {entitlements, term}` mapping over the CLOSED `ENTITLEMENTS` set. deps: EPIC-29 (license core + `ENTITLEMENTS`).
  - files: `trustledger/plans.js` (NEW — a PURE, I/O-free module: a `CATALOG_KIND`/`schemaVersion`, a strict
    `validatePlanCatalog(obj)` that REJECTS a wrong kind/schema, a non-array/empty `plans`, a duplicate `planId`,
    a missing/non-string `planId`/`displayName`, an `entitlements` that is not a non-empty array drawn ONLY from
    the closed `ENTITLEMENTS` keys (an unknown flag is a HARD reject — never a silent mis-grant), or a `term` that
    is not a positive integer number of DAYS; and a pure `getPlan(catalog, planId)` that throws a NAMED error for
    an unknown plan — mirror `trustledger/policy.js`'s validate-or-throw posture and reuse `license.ENTITLEMENTS`
    VERBATIM, no re-listed flags), `trustledger/fixtures/plans/baseline.json` (NEW — a DRAFT catalog skeleton with
    a couple of illustrative plans, e.g. `single_state`/`multi_state`/`pro`, each with PLACEHOLDER term/entitlements
    the seller fills in — like `policy/ca-example.json`), `test/trustledger.plans.test.js` (NEW).
  - Acceptance: `validatePlanCatalog` ACCEPTS the bundled `baseline.json` and REJECTS (named error, never a silent
    pass) each of: wrong kind, wrong/unsupported schemaVersion, empty/missing `plans`, a duplicate `planId`, a plan
    whose `entitlements` contains a flag NOT in `license.ENTITLEMENT_FLAGS`, an empty `entitlements`, a non-positive
    or non-integer `term`, and a missing `displayName`. `getPlan` returns the frozen plan for a known id and throws a
    named error for an unknown id. The module is PURE (a grep finds no `fs`/`http`/`require('ethers')`/clock use).
    The closed `ENTITLEMENTS` table is the SINGLE source of valid flags (the test asserts `plans.js` derives its
    allowed set from `license.ENTITLEMENT_FLAGS`, not a hard-coded copy). `npx hardhat test` unchanged.

- **T-37.2** `VERIFIED` The order→license mapping + `vh trust license fulfill`: deterministic, key-read-used-discarded, emits a container the EXISTING verify/gate accept. deps: T-37.1, EPIC-29 (`buildLicense`, `loadSigningWallet`).
  - files: `trustledger/license.js` (EDIT — add a PURE `fulfillOrder({ plan, customer, paidThrough?, issuedAt }, catalog)`
    that resolves the plan via `plans.getPlan`, derives `expiresAt` = `paidThrough` when given else `issuedAt + term days`,
    and RETURNS the exact `buildLicensePayload` params `{ licenseId, customer, plan, entitlements, issuedAt, expiresAt }`
    — deterministic: same order + same catalog ⇒ byte-identical params; it signs NOTHING and does NO I/O), `trustledger/cli.js`
    (EDIT — add `vh trust license fulfill --plan <id> --customer <name> [--paid-through <ISO>] [--catalog <file>]
    --key-env <VAR>|--key-file <path> [--out <file>] [--json]`, REUSING `cmdLicenseIssue`'s key posture VERBATIM —
    `coreAttestation.loadSigningWallet` reads the human key, used to sign, NEVER held/persisted/logged; neither/both
    key sources hard-error key-free; default catalog = bundled `baseline.json`), `test/trustledger.license.fulfill.test.js` (NEW).
  - Acceptance: `fulfillOrder` is PURE and DETERMINISTIC — the same `{plan, customer, paidThrough, issuedAt}` + catalog
    yields byte-identical payload params; `paidThrough` omitted derives `expiresAt = issuedAt + plan.term days`; an
    unknown plan / `paidThrough <= issuedAt` / malformed date each throw a NAMED error. `vh trust license fulfill` with
    an ephemeral `Wallet.createRandom()` key writes a `*.vhlicense.json` whose entitlements + window EXACTLY equal the
    plan's, and that container is ACCEPTED by the UNCHANGED `vh trust license verify --vendor <addr>` (exit 0) AND
    UNLOCKS the matching paid surface via the UNCHANGED `vh trust reconcile --license <f> --vendor <addr>` gate (a plan
    WITHOUT `seal` does NOT unlock `--seal`; a plan WITH it does) — proving fulfill output is byte-compatible with the
    existing gate. Neither/both/missing/malformed key sources hard-error with a KEY-FREE message; the key is never
    echoed. A wrong-issuer/expired fulfilled license REJECTS exactly as `verify` already does. `npx hardhat test` unchanged.

- **T-37.3** `VERIFIED` Document "Plan catalog & fulfillment" + the one-command webhook handoff, and SHARPEN P-6 step (3). deps: T-37.2.
  - files: `docs/TRUSTLEDGER.md` (EDIT — add a "Plan catalog & fulfillment" section: the catalog schema, the bundled
    draft skeleton, the `vh trust license fulfill` one-command shape, and the worked "payment-succeeded webhook →
    fulfill → deliver `*.vhlicense.json`" flow; restate the boundary VERBATIM — the loop ships the catalog + mapping,
    the PRICE/term column + the vendor key + the actual webhook/billing are HUMAN steps), `test/cli.trustledger.fulfill.docs.test.js`
    (NEW — assert the doc names `vh trust license fulfill`, shows the catalog schema, and restates the human-vs-loop boundary).
  - Acceptance: `docs/TRUSTLEDGER.md` documents the plan catalog format and the `vh trust license fulfill` command,
    shows the webhook-handler shape (a billing "payment succeeded / renewed" event → `fulfill --plan --customer
    --paid-through` → deliver), and RESTATES VERBATIM that the loop ships ONLY the catalog + mapping + ephemeral test
    keys while the price/term, the vendor key, and the webhook/billing wiring are human-owned (P-6). A test asserts the
    doc names the command, the catalog schema, and the boundary so it can't rot. This SHARPENS P-6 step (3); NO new
    `needs-human` item; NO change to P-3/P-5/P-7/P-8. `npx hardhat test` unchanged.

## EPIC-38 — Close the `event → order` half of self-serve fulfillment: a provider-agnostic webhook ADAPTER (price→plan binding + idempotency) so a real Stripe/Paddle event can drive `fulfill` with NO hand-written glue per provider  *(continues the EPIC-37 self-serve revenue axis — NOT a P-8 sales-call de-risk and NOT a new product surface; closes the LAST loop-buildable hole between a raw billing event and a minted license; SHARPENS P-6 step (3); see STRATEGY.md "## Direction" 2026-06-25)*

*Why this EPIC (read STRATEGY.md "## Direction" 2026-06-25 first). EPIC-37 shipped the `order → license`
mapping (`fulfillOrder({plan, customer, paidThrough, issuedAt}, catalog)` + `vh trust license fulfill`) — a
deterministic, key-read-used-discarded command that turns a CLEAN order into the signed `*.vhlicense.json` the
existing gate accepts. But it stops one step short of a webhook actually driving it. The docs' own worked flow
HAND-WAVES the missing step with a comment: `# event -> { plan: "pro-annual", customer: "Acme Realty LLC",
paidThrough: "..." }` (`docs/TRUSTLEDGER.md:906`). That arrow IS the un-built, error-prone, security-sensitive
glue every integrator must write BY HAND for EACH provider, and a grep for `normalizeEvent`/`priceId`/`price_id`/
`product_id`/`current_period_end`/`idempotency`/`stripe`/`paddle` over `trustledger/ cli/ docs/ test/` finds
NOTHING — it does not exist. A real Stripe `invoice.paid` / `checkout.session.completed` event does NOT carry
your `planId`: it carries a Stripe `price`/`product` id, a `customer` object, and a `current_period_end` UNIX
EPOCH (not canonical ISO). So before `fulfillOrder` can run, the integrator must (1) MAP the provider's price-id
→ your `planId` — the EXACT silent-mis-grant class EPIC-37's catalog closed for ENTITLEMENTS but left WIDE OPEN
one level up (a typo in this mapping grants the wrong PLAN), (2) extract the customer identity, (3) convert the
period-end EPOCH → the canonical ISO grammar `fulfillOrder` strictly requires, and (4) be IDEMPOTENT — billing
providers RETRY the same event (Stripe documents at-least-once delivery), so a naive handler re-mints and
double-delivers. EPIC-38 ships the auto-buildable, PURE half of all four: a versioned, strictly-validated
`price→plan` BINDING over the SAME catalog, a pure `normalizeEvent(rawEvent, binding)` that maps a
provider-shaped event onto the `{plan, customer, paidThrough, issuedAt}` order `fulfillOrder` already consumes
(epoch→ISO, named reject for an unmapped price / missing customer / malformed period-end — never a silent
mis-grant), and a deterministic `orderKey(order)` an idempotent handler keys on (the existing
`LIC-<issuedAt>-<planId>` licenseId is the natural seed). STRICTLY ADDITIVE + REUSE-ONLY: `fulfillOrder`,
`buildLicense`, `verifyLicense`, the plan catalog, the CLI/web gate, and every EPIC-1..37 test stay EXACTLY
as-is; the adapter's output is the SAME order object `fulfillOrder` already accepts and its license is
byte-compatible with the gate. NO new crypto, NO new dep, NO network call (the adapter PARSES a provider's
event payload offline — it does NOT call a provider API). The loop ships ONLY the mapping schema + the pure
normalizer + ephemeral test keys; it NEVER sets a price, holds a real key, verifies a real webhook SECRET (that
needs the provider's signing secret — a HUMAN-provisioned credential, documented as the one remaining outward
step), runs a payment processor, or takes a payment. NO token/coin/NFT/sale/yield, NO funds, NO deploy. Income
stays a paid SUBSCRIPTION/license for delivered software value (the free tier stays open) — an access
credential, NOT a tradeable/appreciating asset. This SHARPENS P-6 step (3); it adds NO new human gate and
changes none of P-3/P-5/P-7/P-8.*

- **T-38.1** `VERIFIED` The PRICE→PLAN BINDING: a versioned, strictly-validated `providerPriceId → planId` map over the SAME catalog, so a provider's price/product id resolves to YOUR plan with NO silent mis-grant. deps: T-37.1 (the plan catalog + `validatePlanCatalog`/`getPlan`).
  - files: `trustledger/plans.js` (EDIT — add a PURE, I/O-free `validatePriceBinding(obj, catalog)` that REJECTS a
    wrong `kind`/`schemaVersion`, a non-array/empty `mappings`, a duplicate `priceId`, a missing/non-string
    `priceId` or `provider`, or a `planId` that is NOT a known plan in the supplied catalog — i.e. the binding is
    validated AGAINST the catalog so a price can NEVER point at a non-existent plan; and a pure
    `resolvePlanId(binding, provider, priceId)` that returns the bound `planId` or throws a NAMED error naming the
    unmapped `(provider, priceId)` — mirror `validatePlanCatalog`/`getPlan`'s validate-or-throw posture and reuse
    the catalog as the single source of valid planIds, no re-listed plans), `trustledger/fixtures/plans/price-binding.example.json`
    (NEW — a DRAFT skeleton binding a couple of illustrative `stripe`/`paddle` price-ids to the bundled catalog's
    plans, with PLACEHOLDER price-ids the seller fills in — like `policy/ca-example.json`), `test/trustledger.pricebinding.test.js` (NEW).
  - Acceptance: `validatePriceBinding` ACCEPTS the bundled `price-binding.example.json` against `baseline.json`
    and REJECTS (named error, never a silent pass) each of: wrong kind, wrong/unsupported schemaVersion,
    empty/missing `mappings`, a duplicate `priceId`, a missing `priceId`/`provider`, and a `planId` NOT present in
    the supplied catalog. `resolvePlanId` returns the bound `planId` for a known `(provider, priceId)` and throws a
    named error (naming the provider + priceId) for an unmapped one. The module is PURE (a grep finds no
    `fs`/`http`/`require('ethers')`/clock use). The catalog is the SINGLE source of valid planIds (the test asserts
    a binding pointing at an unknown planId is REJECTED at validation time, not at fulfill time). `npx hardhat test` unchanged.

- **T-38.2** `VERIFIED` The `event → order` normalizer + a deterministic idempotency key: `normalizeEvent(rawEvent, binding)` maps a provider-shaped billing event onto the `{plan, customer, paidThrough, issuedAt}` order `fulfillOrder` already consumes, and `orderKey(order)` keys an idempotent handler. deps: T-38.1, T-37.2 (`fulfillOrder`).
  - files: `trustledger/license.js` (EDIT — add a PURE, I/O-free `normalizeEvent(rawEvent, binding, opts?)` that:
    reads `rawEvent.provider`/`rawEvent.type` and the provider's `priceId` + `customer` + period-end fields from a
    SMALL, documented event shape (a normalized envelope the integrator extracts from the raw provider payload —
    NOT a full Stripe SDK type), resolves the `planId` via `plans.resolvePlanId`, derives `customer` (named reject
    if absent/empty), CONVERTS the period-end UNIX EPOCH SECONDS → the canonical ISO `paidThrough` grammar
    `fulfillOrder` requires (named reject for a non-integer/negative/malformed epoch), sets `issuedAt` from
    `rawEvent.issuedAt` (or an explicit `opts.issuedAt` — NO hidden clock read; the module stays pure/testable),
    and RETURNS the EXACT `{plan, customer, paidThrough, issuedAt}` order — so `fulfillOrder(normalizeEvent(ev,
    binding), catalog)` is the whole pipeline; PLUS a pure `orderKey(order)` returning the deterministic
    `LIC-<issuedAt>-<plan>` seed `fulfillOrder` already uses for `licenseId`, the value an idempotent webhook
    handler dedupes on so a RETRIED event mints the byte-identical license, never a second/different one),
    `test/trustledger.normalizeEvent.test.js` (NEW).
  - Acceptance: `normalizeEvent` is PURE + DETERMINISTIC — the same `rawEvent` + binding yields a byte-identical
    order, and `fulfillOrder(normalizeEvent(ev, binding), catalog)` ⇒ a license whose plan/entitlements/window
    EXACTLY equal the bound plan's; an UNMAPPED priceId / missing customer / non-integer-or-negative period-end /
    missing issuedAt each throw a NAMED error (never a silent or wrong-tier order). `orderKey` returns
    `LIC-<issuedAt>-<plan>` and is STABLE for a retried/duplicate event (the test feeds the SAME event twice and
    asserts identical `orderKey` AND, when fulfilled, a byte-identical license — proving an idempotent handler can
    dedupe). The module stays PURE (no clock/fs/http; `issuedAt` is always supplied, never read from `Date.now`).
    `npx hardhat test` unchanged.

- **T-38.3** `VERIFIED` Document "From a billing event to a license: the webhook adapter" (replace the hand-waved `# event -> {…}` comment with the REAL two-line pipeline + the price-binding schema + the idempotency rule), and name the ONE remaining HUMAN step (verifying the provider's webhook SECRET). deps: T-38.2.
  - files: `docs/TRUSTLEDGER.md` (EDIT — add a "From a billing event to a license: the webhook adapter" subsection
    UNDER "Plan catalog & fulfillment": the `price→plan` binding schema + the bundled draft skeleton, the real
    `normalizeEvent → fulfillOrder` two-step pipeline replacing the current `# event -> {…}` hand-wave at
    ~line 906, the `orderKey` idempotency rule (dedupe on `orderKey` so a RETRIED provider event delivers the SAME
    license, never a second), and an EXPLICIT statement that the ONE remaining outward/human step is
    VERIFYING THE PROVIDER'S WEBHOOK SIGNATURE/SECRET — the loop ships the parse+map+idempotency-key but NEVER holds
    the provider's signing secret or calls a provider API, so authenticating the inbound event with the provider's
    SDK/secret is the human-owned edge of the handler; restate the price/term + vendor key + billing-wiring boundary
    VERBATIM), `test/cli.trustledger.webhook-adapter.docs.test.js` (NEW — assert the doc names the price-binding
    schema, shows the `normalizeEvent → fulfillOrder` pipeline, states the `orderKey` idempotency rule, and names
    webhook-secret verification as the remaining HUMAN step).
  - Acceptance: `docs/TRUSTLEDGER.md` documents the `price→plan` binding format, shows the
    `normalizeEvent(rawEvent, binding) → fulfillOrder(order, catalog)` two-line pipeline (replacing the hand-waved
    `# event -> {…}` comment), states the `orderKey` idempotency rule, and RESTATES VERBATIM that the loop ships
    ONLY the binding + the normalizer + ephemeral test keys while the price/term, the vendor key, the actual
    webhook/billing wiring, AND verifying the provider's webhook SECRET are human-owned (P-6). A test asserts the
    doc names the schema, the pipeline, the idempotency rule, and the webhook-secret human step so it can't rot.
    This SHARPENS P-6 step (3); NO new `needs-human` item; NO change to P-3/P-5/P-7/P-8. `npx hardhat test` unchanged.

## EPIC-39 — Close the SILENT-FALSE-PASS hole in the trust gate: a deposit whose beneficiary type can't be determined must become a LOUD, gradable finding, never a quiet generic deposit  *(MATERIAL CHANGE OF APPROACH — pivot OFF the saturated go-to-market/fulfillment vein (EPIC-31..38) that produced this run's avgUsefulness 4.0→3.25 + a minUsefulness=2 outlier, and FIX a correctness bug in the safety-critical reconciliation gate itself: the product's core promise — "FAIL protects the beneficiary, not just the column sums" — is silently violated when a real security deposit is recorded without a recognizable keyword; see STRATEGY.md "## Direction" 2026-06-25)*

*Why this EPIC (read STRATEGY.md "## Direction" 2026-06-25 first). The qualityStall trigger FIRED this run: the
last 5 METRICS avgUsefulness ran 4.0 → 4.0 → 4.0 → … → **3.25** with a **minUsefulness=2** MIN-OUTLIER — a single
deliverable that passed correctness but barely cleared usefulness, exactly what the directive says the batch
AVERAGE hides. The cause is structural: EPIC-31..38 are EIGHT consecutive epics on the SAME revenue-plumbing /
sales-de-risk axis (verifier funnel, pilot kit, license fulfillment, webhook adapter). That vein is saturated;
the directive REQUIRES a material change of approach and forbids more incremental items in it. The needs-human
proposals (P-5/P-6/P-8) are already decision-ready, so re-sharpening them is busywork. The highest-leverage,
loop-buildable, NON-incremental work is to FIX A CORRECTNESS BUG IN THE CORE PRODUCT'S SAFETY-CRITICAL GATE.

The bug (confirmed in code, not invented). TrustLedger's headline promise is that the gate "protects the
beneficiaries, not just the column sums" (`docs/TRUSTLEDGER.md:79-81`): an un-segregated **security deposit**
is the single most license-risky finding (it is the #1 cause of a trust account going "out of trust"), and it
is graded `security_deposit_segregation = ERROR` so the account FAILs. But whether a book deposit IS a security
deposit is decided ENTIRELY by a free-text keyword regex over the memo: `isSecurityDeposit(rec)` matches only
`/security deposit|sec dep|sec\.? deposit|damage deposit|\bdeposit held\b/` (`trustledger/reconcile.js:136-139`).
A real QuickBooks export routinely records a security deposit with NO such token — e.g. a memo of just
`"Deposit — 12B Smith"`, or the deposit-type living in an *account-name* column the parser never reads into
`memo`. When that happens the receipt falls through to a **generic deposit**, the segregation check never fires,
and the gate **PASSES an account that is genuinely OUT OF TRUST**. This is a SILENT FALSE PASS in the exact
control the whole product exists to provide — categorically more valuable to fix than another webhook-adapter
increment, and strictly a correctness/safety improvement (it can only make the gate STRICTER, never looser).

The fix is NOT "add more keywords" (that just moves the silent line one memo-phrasing further out). The robust,
honest fix is EXPLICIT-OR-LOUD: when a book deposit's beneficiary type is **ambiguous** — it is a sizable,
party-attributed receipt that is neither clearly a routine rent payment NOR a recognized security deposit — the
reconciler raises a NEW reviewable exception, `ambiguous_deposit`, that a broker MUST clear and that a per-state
policy can grade. The dangerous case becomes a VISIBLE, gradable finding instead of a quiet pass. Because the
policy layer DERIVES its legal exception types from the engine's `EXCEPTION` enum (`reconcile.js:64`, surfaced in
`docs/TRUSTLEDGER.md:149-154`), the new type is automatically policy-gradable with ZERO schema change — a state
that wants to treat ambiguous deposits as a hard ERROR sets `severities.ambiguous_deposit: "error"`; the default
is WARNING ("a human must look at this") so the tool never silently PASSES a deposit it could not classify, but
also never over-FAILs a firm whose every deposit is clean rent (rent receipts are NOT flagged). An EXPLICIT
escape valve completes it: a per-record `kind`/memo marker (e.g. `kind: "rent"` / an explicit security-deposit
marker) is HONORED so a broker who HAS labeled their data is never nagged — the flag fires only on the genuinely
unlabeled, ambiguous receipts. STRICTLY ADDITIVE + NON-REGRESSING: every existing reconcile/report/policy/seal
test stays green byte-for-byte (a deposit that ALREADY matches `isSecurityDeposit` still raises
`security_deposit_segregation`; a clean rent-only book raises nothing new); the change can only ADD findings on
the previously-silent ambiguous case, never remove an existing one. PURE/I-O-free, no new dep, no network, no
crypto, no clock. NO token/coin/NFT/sale/yield, NO funds, NO deploy, NO human/legal gate to BUILD it (the
classification is a control DEFAULT a CPA can re-grade via the EXISTING policy layer — same DRAFT posture P-5
already governs; this EPIC adds NO new `needs-human` item and changes none of P-3/P-5/P-6/P-7/P-8).*

- **T-39.1** `VERIFIED` Raise a NEW `ambiguous_deposit` exception for a book deposit whose beneficiary type can't be
  determined — so a security deposit recorded WITHOUT a recognizable keyword becomes a LOUD, gradable finding
  instead of silently passing as a generic deposit. Default severity WARNING; honor an explicit per-record marker
  so a labeled deposit/rent receipt is never flagged. deps: none (core reconcile).
  - files: `trustledger/reconcile.js` (EDIT — add `AMBIGUOUS_DEPOSIT: "ambiguous_deposit"` to the `EXCEPTION` enum
    and `[EXCEPTION.AMBIGUOUS_DEPOSIT]: SEVERITY.WARNING` to `DEFAULT_SEVERITY`; add a PURE predicate
    `isAmbiguousDeposit(rec)` that returns true ONLY for a book deposit (`amount > 0`) that is (a) NOT already a
    recognized security deposit (`isSecurityDeposit` false), (b) NOT an explicitly-labeled rent/operating receipt
    (honor `rec.kind === "rent"` or an explicit rent/security-deposit marker on `kind`/memo — a record the broker
    HAS classified is trusted and never flagged), and (c) party-attributed and at/above a deposit-scale threshold
    so routine line items don't spam the report (use the SAME signed-cents/`rec.party` conventions already in
    `reconcile`); in the classification pass that already walks the book for owner-draw/segregation
    (`reconcile.js:~297`), push an `AMBIGUOUS_DEPOSIT` exception for each such record with a clear `label`/`detail`
    naming the party + amount and stating "beneficiary type could not be determined — classify this deposit (rent
    vs. security deposit) before relying on the gate"; the existing `security_deposit_segregation` ERROR path is
    UNCHANGED — a deposit that DOES match `isSecurityDeposit` still flows there, never to the ambiguous bucket),
    `test/trustledger.ambiguous-deposit.test.js` (NEW).
  - Acceptance: a book security deposit recorded with NO recognized keyword (e.g. memo `"Deposit - 12B Smith"`,
    party set, deposit-scale amount) now raises an `ambiguous_deposit` exception (default WARNING) — it is no
    longer SILENTLY a generic deposit. A deposit that DOES match `isSecurityDeposit` still raises ONLY
    `security_deposit_segregation` (ERROR), never `ambiguous_deposit` (no double-count). An explicitly rent-labeled
    receipt (`kind: "rent"` / explicit marker) raises NOTHING new. `isAmbiguousDeposit` is PURE (a grep finds no
    `fs`/`http`/`require('ethers')`/clock use). EVERY pre-existing reconcile/report/policy/seal test passes
    byte-for-byte (the change only ADDS a finding on the previously-silent case). `npx hardhat test` green.

- **T-39.2** `VERIFIED` Make `ambiguous_deposit` first-class in the verdict + packet + the per-state policy layer, so a
  state CAN grade it to ERROR (a hard FAIL) and the packet/CSV surface it next to the other classified exceptions.
  deps: T-39.1.
  - files: `trustledger/report.js` (EDIT — ensure the new type flows through the verdict/exception summary exactly
    like the other classified exceptions: it counts toward the PASS/FAIL gate per its (policy-resolved) severity —
    so a state policy that sets `ambiguous_deposit: "error"` makes the account FAIL until the deposit is classified
    — and renders in the packet/exception listing with its label/detail; NO change to the exit-code contract
    itself), `trustledger/policy.js` (EDIT ONLY IF NEEDED — confirm the legal-exception-type set is still DERIVED
    from the `EXCEPTION` enum so `ambiguous_deposit` is automatically a valid `severities`/`citations` key with NO
    re-listing; add nothing if it already derives), `trustledger/fixtures/policy/ca-example.json` (EDIT — add a
    DRAFT example grading `ambiguous_deposit` with a PLACEHOLDER citation, demonstrating the override path; keep the
    `_DISCLAIMER`/DRAFT posture), `test/trustledger.ambiguous-deposit.policy.test.js` (NEW).
  - Acceptance: with NO policy, an `ambiguous_deposit` is a WARNING and does NOT by itself FAIL the gate (the
    account still PASSES if the three balances tie out and there is no ERROR) — so a firm with clean data is not
    over-FAILed. With a policy that sets `severities.ambiguous_deposit: "error"`, the SAME run FAILs (exit 3) until
    the deposit is classified — the worked verdict-flips-under-override behavior, now covering the new type. The
    policy module ACCEPTS `ambiguous_deposit` as a `severities`/`citations` key (derived from the enum, no
    re-listing) and the example fixture grades it with a PLACEHOLDER citation. The exception renders in the
    packet/exception listing with a human label. EVERY pre-existing policy/report test passes byte-for-byte.
    `npx hardhat test` green.

- **T-39.3** `VERIFIED` Document the silent-false-pass hazard and the new control in `docs/TRUSTLEDGER.md`: WHY a
  keyword-only security-deposit detector is unsafe, what `ambiguous_deposit` does, the explicit-label escape valve,
  and that grading it to ERROR is a per-state CPA decision via the EXISTING policy layer (the DRAFT/NOT-LEGAL-ADVICE
  posture, P-5, is unchanged). deps: T-39.2.
  - files: `docs/TRUSTLEDGER.md` (EDIT — under "Exceptions and their severities" and "The per-state policy layer":
    add `ambiguous_deposit` to the legal-exception-type list (the `outstanding_deposit … continuity_break` block at
    ~line 149-154), and add a short subsection — "When the tool can't tell what a deposit IS" — explaining that
    security-deposit detection from free-text memos is NECESSARILY incomplete, that an unclassifiable
    party-attributed deposit is therefore raised as `ambiguous_deposit` (default WARNING) rather than silently
    passed as a generic deposit, that an explicit per-record `kind`/marker suppresses the flag for data the broker
    HAS classified, and that a per-state policy MAY grade it to ERROR (a hard FAIL until classified) — RESTATING the
    DRAFT / NOT-LEGAL-ADVICE / CPA-must-sign posture VERBATIM, with NO new `needs-human` item), and update the
    "Who buys this / three balances" framing only as needed to keep it consistent;
    `test/cli.trustledger.ambiguous-deposit.docs.test.js` (NEW — assert the doc lists the new type, explains the
    hazard + the WARNING default + the explicit-label escape valve, and states the ERROR-grading is a per-state CPA
    decision via the existing policy layer).
  - Acceptance: `docs/TRUSTLEDGER.md` lists `ambiguous_deposit` among the legal exception types, explains why a
    keyword-only security-deposit detector silently false-passes, documents the WARNING default + the explicit-label
    escape valve, and states that grading it to ERROR is a per-state CPA decision via the EXISTING policy layer
    (DRAFT/NOT-LEGAL-ADVICE posture restated verbatim). A doc test pins all of this so it can't rot. NO new
    `needs-human` item; NO change to P-3/P-5/P-6/P-7/P-8. `npx hardhat test` green.

## EPIC-40 — Close a SECOND silent-false-pass in the flagship trust control: security-deposit segregation must be matched PER BENEFICIARY, never pooled across tenants  *(CONTINUE the correctness-of-the-core-gate pivot EPIC-39 opened — same flagship finding (`security_deposit_segregation`), a DIFFERENT false-pass mechanism. `classifySecurityDeposits` pools ALL segregation transfers into one `segregatedAmount` and greedily applies it across ALL deposits regardless of WHICH tenant the money belongs to. CONFIRMED bugs in the live engine: (A) the shortage is MIS-ATTRIBUTED — a tenant who under-segregated is passed while a fully-segregated tenant is wrongly flagged, sending the broker to "fix" the wrong account; (B) FALSE NEGATIVE — over-segregating one tenant SILENTLY CLEARS a genuinely un-segregated other tenant's deposit, the exact out-of-trust PASS the product exists to prevent. Trust law requires EACH beneficiary's deposit be held SEPARATELY; pooling coverage across beneficiaries is legally wrong. The fix can only make the gate STRICTER, never looser. See STRATEGY.md "## Direction" 2026-06-25.)*

- **T-40.1** `VERIFIED` Match security-deposit segregation coverage PER BENEFICIARY, not from a single pooled amount.
  Rework `classifySecurityDeposits` (`trustledger/reconcile.js`) so each security-deposit RECEIPT is covered ONLY by
  segregation OUTFLOWS attributable to the SAME beneficiary (party). Group both security-deposit inflows and
  segregation moves by a normalized party key (reuse the same party-normalization the matcher/sub-ledger use — do
  NOT invent a new one); within each party, apply that party's segregation coverage FIFO over that party's deposits;
  a party with no/under-coverage raises `SECURITY_DEPOSIT_SEGREGATION` for the uncovered remainder. A segregation
  outflow whose party CANNOT be determined must NOT be silently pooled to cover everyone — it covers only same-party
  deposits, and if it can't be attributed it covers nothing (the safe direction: fail-loud, never fail-silent). Keep
  the function PURE + deterministic (order-independent: sort by `recKey`, no clock/fs/http/crypto/new dep) and keep
  the single-authoritative-source (BOOK-only) invariant EPIC-26 established (`bank` still intentionally unused for
  the sum — a transfer's bank mirror adds no coverage). deps: none.
  - files: `trustledger/reconcile.js` (EDIT `classifySecurityDeposits` to bucket by party then match per-party;
    factor a small pure `normalizeParty(rec)` helper if one isn't already shared, reusing existing party logic);
    `test/trustledger.reconcile.test.js` (EDIT/EXTEND — add the two CONFIRMED regression cases: CASE A mis-attribution
    [Jones deposits 1500, segregates only 1000; Smith deposits 1000, segregates 1000 → the ONLY finding must be
    Jones for 500, NOT Smith] and CASE B false-negative [Jones deposits 1000 + over-transfers 2000; Smith deposits
    1000 segregates nothing → Smith MUST be flagged]; plus: a single fully-segregated tenant still raises nothing;
    a two-tenant book where BOTH are correctly segregated raises nothing; an unattributed segregation transfer does
    NOT cover an attributed deposit). Assert the EXISTING segregation tests (same-party deposit+transfer cancels;
    the two-deposits-one-transfer book-only count; the bank-mirror-double-count guard) all still pass byte-for-byte.
  - Acceptance: per-tenant matching replaces pooled matching; CASE A flags Jones (amount 500) and NOT Smith; CASE B
    flags Smith; a correctly-segregated tenant (and an all-correct two-tenant book) raises nothing; an unattributable
    transfer never silently covers an attributed deposit; every prior EPIC-26/39 segregation + bank-mirror-guard test
    stays green; the function stays PURE/deterministic/order-independent; the fix is STRICTLY non-looser (it can only
    ADD or RE-ATTRIBUTE a finding, never remove a real one). `npx hardhat test` green.

- **T-40.2** `VERIFIED` Surface WHICH beneficiary in the segregation finding so the report names the at-risk tenant, and
  confirm the per-state policy layer + verdict/exit-code flow through unchanged. The `SECURITY_DEPOSIT_SEGREGATION`
  exception's `detail`/`label` (and the report row) must identify the specific beneficiary whose deposit is
  uncovered and the uncovered amount, so a broker reading the audit packet goes to the RIGHT tenant's sub-ledger —
  not a pooled "some deposit somewhere" message. Verify `applyPolicy` still overrides this type's severity by state
  (no schema change — it's the same `EXCEPTION` enum value) and the PASS/FAIL verdict + exit code are unaffected
  except where a previously-false PASS now correctly FAILs. deps: T-40.1.
  - files: `trustledger/reconcile.js` (EDIT the segregation exception's `detail` to name `rec.party` + the uncovered
    cents; keep `records:[r]` so the report's per-record table still localizes it); `trustledger/report.js` (verify —
    EDIT only if the party isn't already rendered for this finding); `test/trustledger.reconcile.test.js` and/or
    `test/trustledger.policy.test.js` (assert the finding names the beneficiary + uncovered amount; assert a state
    policy that sets `severities.security_deposit_segregation` still applies via `applyPolicy` with no schema change;
    assert the verdict/exit-code contract is unchanged for already-correct books and correctly FAILs CASE B).
  - Acceptance: the segregation finding names the at-risk beneficiary and the uncovered amount in `detail` (and the
    report row); `applyPolicy` per-state override still works with no schema change; the verdict/exit-code contract
    is unchanged except that the formerly-false-PASS CASE B now correctly FAILs. `npx hardhat test` green.

- **T-40.3** `VERIFIED` Document the per-beneficiary segregation rule and CORRECT the now-inaccurate "one source" claim in
  `docs/TRUSTLEDGER.md`. The doc (`docs/TRUSTLEDGER.md:62-63`) currently claims the segregation check "counts deposit
  coverage from **one** source so it cannot silently clear an un-segregated deposit by netting it against another
  figure" — TRUE for the bank/book double-count it was written for, but the engine ALSO silently cleared deposits by
  netting them against ANOTHER TENANT'S over-segregation (CASE B). Update the segregation subsection to state the
  rule precisely: coverage is matched PER BENEFICIARY (each tenant's deposit must be segregated by transfers
  attributable to THAT tenant; one tenant's over-segregation never covers another's shortage; an unattributable
  transfer covers nothing), restating WHY (trust law requires each beneficiary's funds held separately). Keep the
  DRAFT / NOT-LEGAL-ADVICE / CPA-must-sign posture (P-5) verbatim — this is a correctness clarification, NOT a new
  legal claim. deps: T-40.2.
  - files: `docs/TRUSTLEDGER.md` (EDIT the security-deposit-segregation subsection near lines 62-63 and ~179-210 to
    describe per-beneficiary matching and correct the "one source" wording so it covers BOTH the single-source rule
    AND the per-beneficiary rule); a docs-rot test (EDIT `test/cli.trustledger.ambiguous-deposit.docs.test.js` or NEW
    `test/cli.trustledger.segregation.docs.test.js` — assert the doc states segregation coverage is matched
    per-beneficiary, that one tenant's surplus never covers another's shortage, and that the DRAFT/NOT-LEGAL-ADVICE
    posture is restated).
  - Acceptance: `docs/TRUSTLEDGER.md` describes per-beneficiary segregation matching and corrects the "one source"
    claim so it is accurate for BOTH false-pass mechanisms; a doc test pins it; the DRAFT/NOT-LEGAL-ADVICE/CPA posture
    is restated verbatim; NO new `needs-human` item; NO change to P-3/P-5/P-6/P-7/P-8. `npx hardhat test` green.

## EPIC-41 — Close a THIRD silent-false-pass in the flagship trust gate: a NEGATIVE individual beneficiary ledger (one client's money spent to cover another) must FAIL, even when the pooled sub-ledger SUM ties out  *(CONTINUE the correctness-of-the-core-gate pivot EPIC-39/40 established — a DIFFERENT control (the three-way sub-ledger tie-out), a DIFFERENT and arguably MORE fundamental false-pass than the segregation ones. The `SUBLEDGER_OUT_OF_BALANCE` check compares only the SUM of all tenant balances to the book; it CANNOT see a per-tenant NEGATIVE that nets against another tenant's surplus. CONFIRMED in the live engine: `reconcile([], [], { Jones: -50000, Smith: +50000 })` returns `tiesOut: true` and `exceptions: []` — a SILENT PASS of an account that is textbook OUT OF TRUST. A negative individual ledger is the regulator-named definition of conversion/commingling (the broker used Jones's money for Smith); it is the #1 thing the three-way reconciliation exists to catch, and the docs at `docs/TRUSTLEDGER.md:59` FALSELY claim `book == sub-ledger total` proves "nothing is commingled or missing." The fix can only make the gate STRICTER, never looser. See STRATEGY.md "## Direction" 2026-06-25.)*

*Why this EPIC (read STRATEGY.md "## Direction" 2026-06-25 first). EPIC-39 and EPIC-40 fixed two false-passes in
ONE finding (`security_deposit_segregation`). This is a DIFFERENT control: the sub-ledger leg of the three-way
tie-out itself. The whole product is sold on "book == sub-ledger total ⇒ every beneficiary is whole." That
implication is FALSE: equality of the SUM is necessary but not sufficient — a per-beneficiary deficit hidden by
another beneficiary's surplus is exactly the commingling a pooled trust account is supposed to make impossible,
and the gate currently passes it silently. This is the same high-leverage core-correctness vein that lifted
minUsefulness back to 4 before this run's regression; it needs NO human/legal/funds gate to BUILD.*

- **T-41.1** `VERIFIED` Flag a NEGATIVE individual beneficiary ledger as an out-of-trust finding, independent of whether the
  pooled sub-ledger SUM ties to the book. Add a new `EXCEPTION.NEGATIVE_TENANT_LEDGER` (machine string
  `negative_tenant_ledger`) with `DEFAULT_SEVERITY = ERROR` (a negative individual ledger means one beneficiary's
  funds were spent on another — conversion/commingling, out of trust). In `reconcile()` (`trustledger/reconcile.js`),
  after computing `subBalances = tenantBalances(tenants)`, iterate the per-beneficiary balances and raise ONE
  `NEGATIVE_TENANT_LEDGER` finding per beneficiary whose balance is below `-toleranceCents` (respect the same
  `toleranceCents` the tie-out uses, so a 0-tolerance policy fails on any negative and a slack policy does not flag a
  rounding cent). The finding must NAME the at-risk beneficiary and the (negative) amount in `detail`/`label` and the
  report row, exactly as the segregation finding now does (reuse `beneficiaryLabel`/`fmtCentsForDetail`). This is
  ORTHOGONAL to and ADDITIVE over the existing `SUBLEDGER_OUT_OF_BALANCE` (sum-vs-book) finding — both can fire; a
  book where the sum ties out but a tenant is negative now raises `NEGATIVE_TENANT_LEDGER` ONLY (the precise truth),
  and a book that is BOTH out-of-sum AND has a negative tenant raises BOTH. Keep `reconcile()` PURE + deterministic
  (order-independent: sort the beneficiary keys by `cmp`, no clock/fs/http/crypto/new dep). `tiesOut` semantics:
  decide and document whether a negative tenant alone clears `tiesOut` to false — RECOMMEND yes only if you wire it
  through the verdict the SAME way other ERRORs gate PASS/FAIL (see T-41.2); do NOT silently special-case it. deps:
  none.
  - files: `trustledger/reconcile.js` (ADD `NEGATIVE_TENANT_LEDGER` to the `EXCEPTION` enum + `DEFAULT_SEVERITY`;
    add a pure `classifyNegativeTenantLedgers(subBalances, toleranceCents, exceptions)` helper called from
    `reconcile()` right after `subBalances` is computed; export the new helper for focused tests if it follows the
    existing export pattern); `test/trustledger.reconcile.test.js` (ADD the CONFIRMED regression: `{ Jones: -50000,
    Smith: +50000 }` with empty bank/book MUST now raise exactly one `negative_tenant_ledger` ERROR naming Jones for
    -50000, and the SUM-vs-book `subledger_out_of_balance` must NOT fire for it since the sum still ties; ADD: a
    single negative tenant; multiple negative tenants → one finding each, deterministically ordered; a tenant exactly
    at zero or positive raises nothing; a negative within `toleranceCents` of zero is NOT flagged; a book that is BOTH
    sum-out-of-balance AND has a negative tenant raises BOTH findings). Assert ALL existing reconcile/policy tests
    stay green byte-for-byte (a previously all-positive sub-ledger raises nothing new).
  - Acceptance: a negative individual beneficiary ledger raises an ERROR-grade `negative_tenant_ledger` finding even
    when the pooled SUM ties to the book; the confirmed `{Jones:-50000,Smith:+50000}` repro now FAILS (was a silent
    PASS); the finding names the beneficiary + negative amount; `toleranceCents` is honored; the new check is additive
    and orthogonal to `subledger_out_of_balance` (both can fire); `reconcile()` stays PURE/deterministic/
    order-independent; the fix is STRICTLY non-looser (it can only ADD a finding, never remove one); every prior test
    stays green. `npx hardhat test` green.

- **T-41.2** `VERIFIED` Wire `NEGATIVE_TENANT_LEDGER` first-class through the verdict, the per-state policy layer, and the
  report so it gates PASS/FAIL and is re-gradable by state with ZERO schema change. Because the policy layer DERIVES
  its legal exception types from the engine's `EXCEPTION` enum, adding the enum value in T-41.1 should make it
  policy-addressable automatically — CONFIRM `applyPolicy` can set `severities.negative_tenant_ledger` for a state
  (e.g. a state that, exceptionally, tolerates a documented same-owner offset could WARN it; the default stays ERROR)
  and that the change re-sorts via `compareExceptions` and flows through the verdict/exit-code the SAME way every
  other ERROR does — a default ERROR `negative_tenant_ledger` makes the gate FAIL (non-zero exit). Confirm `report.js`
  renders the new finding (label, beneficiary, amount) in the human report and the machine packet with no special
  case. deps: T-41.1.
  - files: `trustledger/policy.js` (verify — EDIT only if the enum-derived exception list needs the new type added
    explicitly anywhere; prefer deriving from `EXCEPTION` so no hand-maintained list drifts); `trustledger/report.js`
    (verify the finding renders; EDIT only if a per-type branch omits it); `test/trustledger.policy.test.js` and/or
    `test/trustledger.reconcile.test.js` (assert a default-policy book with a negative tenant FAILs the gate with a
    non-zero exit/verdict; assert a state policy that sets `severities.negative_tenant_ledger: "warning"` re-grades it
    via `applyPolicy` with NO schema change and the gate then PASSes-with-warning; assert the finding renders in the
    report/packet).
  - Acceptance: a default-policy negative tenant ledger FAILs the gate (non-zero exit); `applyPolicy` re-grades
    `negative_tenant_ledger` per state with no schema change; the finding renders in both the human report and the
    machine packet; the verdict/exit-code contract is unchanged except that the formerly-silent-PASS negative-ledger
    case now correctly FAILs. `npx hardhat test` green.

- **T-41.3** `VERIFIED` Document the negative-individual-ledger rule and CORRECT the now-inaccurate "nothing is commingled or
  missing" claim in `docs/TRUSTLEDGER.md`. The doc (`docs/TRUSTLEDGER.md:58-60`) currently claims `book ==
  sub-ledger total` means "the money in the account is fully accounted for to its beneficiaries — nothing is
  commingled or missing." That is FALSE: the SUM equality does not prove each beneficiary is whole — a negative
  individual ledger netting against another's surplus is exactly the commingling it claims to exclude, and the gate
  silently passed it before T-41.1. Update the three-way-reconciliation subsection to state the rule precisely: the
  sub-ledger leg requires BOTH that the SUM ties to the book AND that NO individual beneficiary ledger is negative
  (a negative individual ledger is conversion/commingling — one client's money spent on another — and FAILs the
  gate as `negative_tenant_ledger`). Add the new finding to the ERROR / "what counts as out of trust" reference list.
  Keep the DRAFT / NOT-LEGAL-ADVICE / CPA-must-sign posture (P-5) verbatim — a correctness clarification, NOT a new
  legal claim. deps: T-41.2.
  - files: `docs/TRUSTLEDGER.md` (EDIT the three-way-reconciliation subsection near lines 58-60 to add the
    no-negative-individual-ledger requirement and correct the "nothing is commingled" wording; ADD
    `negative_tenant_ledger` to the ERROR / out-of-trust reference list near lines 150-165 / 208); a docs-rot test
    (NEW `test/cli.trustledger.negative-ledger.docs.test.js` or EDIT an existing trustledger docs test — assert the
    doc states a negative individual beneficiary ledger FAILs the gate even when the sum ties out, that it is named
    `negative_tenant_ledger`, and that the DRAFT/NOT-LEGAL-ADVICE posture is restated).
  - Acceptance: `docs/TRUSTLEDGER.md` describes the no-negative-individual-ledger requirement, lists
    `negative_tenant_ledger` as an out-of-trust ERROR, and corrects the "nothing is commingled or missing" claim so
    it is accurate; a doc test pins it; the DRAFT/NOT-LEGAL-ADVICE/CPA posture is restated verbatim; NO new
    `needs-human` item; NO change to P-3/P-5/P-6/P-7/P-8. `npx hardhat test` green.

## EPIC-42 — Close a FOURTH silent-false-pass in the flagship trust gate: an OWNER DRAW that EXCEEDS the owner's own contributed capital (the owner paid out of TENANT money) must FAIL — and stop the engine PROMISING an escalation it never performs  *(CONTINUE the correctness-of-the-core-gate pivot EPIC-39/40/41 established — a FOURTH control with its own distinct false-pass. `classifyOwnerDraws` carries a docstring that PROMISES it will "ESCALATE to an error if drawing it would leave the pooled balance below the protected (tenant) sub-ledger total — i.e. the owner is being paid out of someone else's money," but the function computes `protectedTotal` and then `void protectedTotal`s it — the escalation was NEVER wired in, so every owner draw is a benign WARNING regardless of size. CONFIRMED in the live engine: an owner who funds $1,000 (`Owner Acme +100000`) and draws $1,500 (`-150000`) while a tenant holds $5,000 has spent $500 of TENANT trust money on an owner payout — textbook conversion. When the owner is modeled as a control-account sub-ledger party (`{"Owner Acme": -50000, "Jones": 500000}`) the pooled SUM still ties to the book, `tiesOut: true`, and the ONLY finding is `owner_draw/warning` — a SILENT PASS. The T-41 negative-ledger check explicitly EXCLUDES control accounts, but that exclusion is valid ONLY up to the owner's own contributed capital; the negative BEYOND contributed capital is tenant money and must FAIL. The fix can only make the gate STRICTER, never looser. See STRATEGY.md "## Direction" 2026-06-25.)*

*Why this EPIC (read STRATEGY.md "## Direction" 2026-06-25 first). EPIC-39/40 fixed two false-passes in the
segregation finding; EPIC-41 fixed the pooled-sum-vs-per-beneficiary false-pass. This is a DIFFERENT control again:
the OWNER-DRAW classification. It is the only finding in the engine whose docstring describes a safety escalation
that the code does NOT actually perform (`void protectedTotal` at the bottom of `classifyOwnerDraws` is the
smoking gun — dead code where the escalation should be). Worse, the gap interacts with the T-41 control-account
exclusion to create a NEW blind spot the prior three epics did not close: an owner over-draw routed through a
control-account sub-ledger line nets to a structural-looking negative that T-41 deliberately ignores, so the
pooled sum ties and the gate PASSes. An owner who pays themselves out of a tenant's security deposit is the single
most common, most-prosecuted trust-account violation in residential PM; the product's core promise ("FAIL protects
the beneficiary, not just the column sums") is silently violated here. This is the same high-leverage
core-correctness vein that lifted minUsefulness back to 4 before the recent regression; it needs NO
human/legal/funds gate to BUILD. CRITICAL boundary: a control/owner account's negative is LEGITIMATE up to that
account's OWN contributed capital (its summed positive inflows) — the fix must flag ONLY the EXCESS over
contributed capital, so a clean owner-draws-own-money book (every existing owner-draw test) stays GREEN and
PASSing; only the over-draw into trust money flips to FAIL.*

- **T-42.1** `VERIFIED` Detect an owner/control-account draw that exceeds the account's OWN contributed capital and raise it
  as an out-of-trust ERROR — and REMOVE the dead `void protectedTotal` escalation-that-never-happened. In
  `trustledger/reconcile.js`: add a new `EXCEPTION.OWNER_OVERDRAW` (machine string `owner_overdraw`) with
  `DEFAULT_SEVERITY = ERROR` (an owner paid out of tenant/trust money is conversion — out of trust). Compute, per
  control/owner sub-ledger account, that account's CONTRIBUTED CAPITAL = the sum of its OWN positive book inflows
  attributed to that party (money the owner put IN); when the account's resulting sub-ledger balance is negative
  beyond `-toleranceCents` AND the magnitude of the negative EXCEEDS what its own contributions could fund (i.e. the
  draw total against this account exceeds its contributions + opening, by more than `toleranceCents`), raise ONE
  `OWNER_OVERDRAW` finding for the EXCESS amount (the tenant money consumed), naming the account and the over-draw
  amount via `beneficiaryLabel`/`fmtCentsForDetail`. The check must be the precise inverse of the T-41
  control-account exclusion: T-41 still ignores a control account's negative WITHIN its contributed capital
  (legitimately deploying the owner's own funds), and THIS check catches the negative BEYOND it. This is ORTHOGONAL
  to and ADDITIVE over `owner_draw` (the benign classification still fires for the draw line; the over-draw ERROR is
  a SEPARATE, additional finding) and over T-41 `negative_tenant_ledger` (a control account stays excluded from
  T-41; the over-draw ERROR is what catches its excess). Delete the misleading `// Owner draws: ... and ESCALATE to
  an error` docstring claim + the `void protectedTotal;` dead line, replacing them with an accurate description that
  points at the new `OWNER_OVERDRAW` check (so the code no longer documents an escalation it doesn't do). Keep
  `reconcile()` PURE + deterministic (order-independent: sort accounts by `cmp`; no clock/fs/http/crypto/new dep).
  deps: none.
  - files: `trustledger/reconcile.js` (ADD `OWNER_OVERDRAW` to the `EXCEPTION` enum + `DEFAULT_SEVERITY`; add a pure
    helper — e.g. `classifyOwnerOverdraws(book, subBalances, controlKeys, toleranceCents, exceptions)` — that derives
    per-control-account contributed capital from `book` positive inflows by `partyKey`/`normTenantParty` and flags the
    excess negative; call it from `reconcile()`; REMOVE `void protectedTotal;` and the inaccurate escalation docstring
    in `classifyOwnerDraws`; export the new helper if it follows the existing export pattern);
    `test/trustledger.reconcile.test.js` (ADD the CONFIRMED regression: owner funds `+100000`, draws `-150000`, tenant
    `Jones +500000`, owner modeled as a control sub-ledger party `{"Owner Acme": -50000, "Jones": 500000}` — MUST now
    raise exactly one `owner_overdraw` ERROR for the `50000` excess and the gate MUST FAIL (`tiesOut`/verdict), where
    today it is a silent PASS; ADD: an owner who draws EXACTLY their contributed capital raises NO overdraw (boundary,
    stays PASS); an owner who draws LESS than contributed capital raises NO overdraw; the EXISTING "detects an OWNER
    DRAW and labels it" test (owner draw funded by own money, `tiesOut: true`) MUST stay green byte-for-byte; an
    over-draw within `toleranceCents` of contributed capital is NOT flagged). Assert ALL existing reconcile/policy
    tests stay green (no clean owner-draw book changes verdict).
  - Acceptance: an owner draw exceeding the owner's own contributed capital raises an ERROR-grade `owner_overdraw`
    finding for the EXCESS (tenant money) amount and FAILs the gate, even when the pooled sum ties out via a
    control-account negative; the confirmed `+100000 / -150000 / Jones +500000` repro now FAILS (was a silent PASS);
    an owner drawing AT-OR-BELOW their contributed capital raises nothing and stays PASS (every existing owner-draw
    test green byte-for-byte); the dead `void protectedTotal;` + the false "ESCALATE to an error" docstring are
    removed and replaced with an accurate description; `toleranceCents` honored; the fix is STRICTLY non-looser (only
    ADDS findings); `reconcile()` stays PURE/deterministic/order-independent. `npx hardhat test` green.

- **T-42.2** `VERIFIED` Wire `OWNER_OVERDRAW` first-class through the verdict, the per-state policy layer, and the report so
  it gates PASS/FAIL and is re-gradable by state with ZERO schema change. Because the policy layer DERIVES its legal
  exception types from the engine's `EXCEPTION` enum, adding the enum value in T-42.1 should make it
  policy-addressable automatically — CONFIRM `applyPolicy` can set `severities.owner_overdraw` for a state and that
  the change re-sorts via `compareExceptions` and flows through the verdict/exit-code the SAME way every other ERROR
  does (a default ERROR `owner_overdraw` makes the gate FAIL / non-zero exit). Confirm `report.js` renders the new
  finding (label, account, excess amount) in the human report and the machine packet with no special case. deps:
  T-42.1.
  - files: `trustledger/policy.js` (verify — EDIT only if the enum-derived exception list needs the new type added
    explicitly anywhere; prefer deriving from `EXCEPTION` so no hand-maintained list drifts); `trustledger/report.js`
    (verify the finding renders; EDIT only if a per-type branch omits it); `test/trustledger.policy.test.js` and/or
    `test/trustledger.reconcile.test.js` (assert a default-policy book with an owner over-draw FAILs the gate with a
    non-zero exit/verdict; assert a state policy that sets `severities.owner_overdraw: "warning"` re-grades it via
    `applyPolicy` with NO schema change and the gate then PASSes-with-warning; assert the finding renders in the
    report/packet).
  - Acceptance: a default-policy owner over-draw FAILs the gate (non-zero exit); `applyPolicy` re-grades
    `owner_overdraw` per state with no schema change; the finding renders in both the human report and the machine
    packet; the verdict/exit-code contract is unchanged except that the formerly-silent-PASS over-draw case now
    correctly FAILs; NO new `needs-human` item; NO change to P-3/P-5/P-6/P-7/P-8. `npx hardhat test` green.

- **T-42.3** `VERIFIED` Document the owner-overdraw rule and CORRECT the now-inaccurate owner-draw description in
  `docs/TRUSTLEDGER.md`. The doc currently treats an owner draw purely as a benign WARNING ("an owner draw … may be
  legitimate"); that is true ONLY when the owner draws their OWN money. State precisely that an owner/control-account
  draw is benign up to that account's own contributed capital, but a draw EXCEEDING contributed capital is paid out of
  tenant/beneficiary trust money (conversion) and FAILs the gate as `owner_overdraw`. Add `owner_overdraw` to the
  ERROR / "what counts as out of trust" reference list. Note the control-account boundary explicitly: a control/owner
  account's negative is structural only up to its contributed capital — the EXCESS is a finding (this resolves the
  apparent tension with the EPIC-41 control-account exclusion). Keep the DRAFT / NOT-LEGAL-ADVICE / CPA-must-sign
  posture (P-5) verbatim — a correctness clarification, NOT a new legal claim. deps: T-42.2.
  - files: `docs/TRUSTLEDGER.md` (EDIT the owner-draw description + the severity-defaults table note to add the
    over-capital rule; ADD `owner_overdraw` to the ERROR / out-of-trust reference list; cross-reference the
    control-account boundary from the negative-ledger / segregation subsections); a docs-rot test (NEW
    `test/cli.trustledger.owner-overdraw.docs.test.js` or EDIT an existing trustledger docs test — assert the doc
    states an owner draw exceeding contributed capital FAILs the gate, that it is named `owner_overdraw`, that an
    owner draw within contributed capital stays a benign warning, and that the DRAFT/NOT-LEGAL-ADVICE posture is
    restated).
  - Acceptance: `docs/TRUSTLEDGER.md` describes the owner-overdraw rule (benign up to contributed capital, ERROR for
    the excess), lists `owner_overdraw` as an out-of-trust ERROR, and explains the control-account boundary so it is
    consistent with EPIC-41; a doc test pins it; the DRAFT/NOT-LEGAL-ADVICE/CPA posture is restated verbatim; NO new
    `needs-human` item; NO change to P-3/P-5/P-6/P-7/P-8. `npx hardhat test` green.

## EPIC-43 — FAIL triage: tell the broker WHY it failed and WHAT to fix first  *(a NEW legibility layer that de-risks the P-8 pilot — make a FAIL diagnosable, not just counted)*

*Motivation (Strategist 2026-06-25): the frontier is EMPTY (EPIC-1..42 all VERIFIED, ~2034 tests green) and the
metrics show what the directive flags: avgUsefulness has oscillated flat-and-mediocre (`3.75, 3.0, 4.0, 3.25, 3.75`,
no upward trend, `minUsefulness` dipped to 2) WHILE `humanGated` has stood at 3–5 for many runs (a persistent VALUE
CEILING). EPIC-39..42 mined the reconcile.js "close a silent-false-pass" vein — productive at first, but each new
fix is now a narrower edge case, and piling more of them is exactly the saturated vein the plateau warns against. The
directive for a STANDING humanGated count is explicit: do NOT invent more incremental same-vein items; identify the
blocking needs-human proposal and prefer AUTO-BUILDABLE work that DIRECTLY de-risks/unblocks it. The blocking dam is
**P-8 (run ONE design-partner pilot)** — already exhaustively sharp, so re-sharpening it is forbidden busywork. The
single biggest commercial risk to that pilot, confirmed against the live product, is the make-or-break FIRST-CONTACT
moment: a real broker runs `reconcile` on their actual files, gets a `FAIL`, and the ONLY thing the tool tells them is
`N exception(s) [X error, Y warning, Z info]` — a COUNT, not a DIAGNOSIS. They cannot tell whether the FAIL means
"your trust account is genuinely OUT OF TRUST" (the product delivering its core value) or "the tool couldn't
reconcile/parse MY data" (a data-shape gap they must fix and re-run). A FAIL a pilot broker reads as "this tool is
broken" loses the pilot regardless of how correct the math is; a FAIL they read as "fix this one $1,250 unreconciled
deposit, then you're clean" wins it. EPIC-43 builds that legibility layer.*

*Why this is HIGHER-leverage than another reconcile.js edge-case (the alternatives considered). (a) Another
"close a silent-false-pass" finding is the SATURATED vein that produced the flat/declining usefulness — more of it is
the forbidden incremental work. (b) Re-sharpening P-3/P-5/P-6/P-7/P-8 is busywork: they are already decision-ready
(P-8 even consolidated the shared "land a design partner" precondition). (c) A brand-new product surface adds breadth
the family already has and re-caps usefulness. (d) THIS is a NEW capability on the SAME core that directly de-risks the
ONE human gate the value is dammed behind — it converts the pilot's highest-risk moment (an ambiguous FAIL) into a
legible, actionable diagnosis, needs NO human/legal/funds gate to BUILD, and is strictly ADDITIVE: it changes NO
verdict, NO exit code, NO finding — it only EXPLAINS the verdict the gate already produces.*

*The mechanism (pure, deterministic, additive — no engine behaviour change). The reconcile model already emits a rich
classified `exceptions` array (`type`/`severity`/`amount`/`label`/`detail`/`records`). EPIC-43 adds a pure
`triage(model)` over that array that (1) maps each finding TYPE to a stable ROOT-CAUSE CLASS, (2) rolls the findings up
by class with their summed dollar impact, and (3) names the single highest-priority thing to fix first. The class
partition is fixed and derived from the existing `EXCEPTION` enum (a typo'd/new type is a build error, never silently
unclassified — the same enum-derived discipline policy.js already uses):*
  - *`out_of_trust` — a real money problem the broker must remediate: `security_deposit_segregation`,
    `subledger_out_of_balance`, `negative_tenant_ledger`, `owner_overdraw`, `bank_book_mismatch`, `continuity_break`.*
  - *`data_completeness` — a row the tool could not reconcile/classify; FIX THE DATA and re-run (this is the
    "is it my data or my trust account?" disambiguator): `unreconciled_bank`, `unreconciled_book`, `ambiguous_deposit`.*
  - *`needs_review` — legitimate-but-confirm, a human eye: `nsf_reversal`, `owner_draw`.*
  - *`timing` — benign, self-clearing, expected: `outstanding_deposit`, `outstanding_check`, `timing`.*

*Guardrails / REVENUE INTEGRITY. Pure-local, OFFLINE, deterministic, I/O-free (no clock, fs, http, crypto, new dep);
order-independent. STRICTLY ADDITIVE + NON-REGRESSING: `triage` is a NEW pure function over the EXISTING model; it
changes NO balance, NO `tiesOut`, NO severity, NO `counts`, NO PASS/FAIL verdict, NO exit code, NO existing finding —
every existing reconcile/report/policy/e2e test stays green byte-for-byte. Income still comes ONLY from selling the
(now more legible) product to paying customers — a HUMAN step. NO new `needs-human` item; NO change to
P-3/P-5/P-6/P-7/P-8. Test command unchanged: `npx hardhat test`.*

- **T-43.1** `VERIFIED` Add a pure, deterministic `triage(model)` to the reconcile core that classifies the model's
  findings by ROOT-CAUSE CLASS, rolls them up, and names the top thing to fix. deps: none.
  - Build a frozen `CAUSE_CLASS` map (`exceptionType -> "out_of_trust" | "data_completeness" | "needs_review" |
    "timing"`) DERIVED so that EVERY value of the existing `EXCEPTION` enum is classified — a missing/extra/typo'd
    type is a hard build/throw error at module load (mirror the enum-derived discipline `policy.js` uses for its
    legal-exception list; do NOT hand-maintain a second drifting list). Use the class partition in the EPIC motivation
    verbatim (out_of_trust = security_deposit_segregation, subledger_out_of_balance, negative_tenant_ledger,
    owner_overdraw, bank_book_mismatch, continuity_break; data_completeness = unreconciled_bank, unreconciled_book,
    ambiguous_deposit; needs_review = nsf_reversal, owner_draw; timing = outstanding_deposit, outstanding_check,
    timing).
  - `triage(model)` returns a NEW, side-effect-free object (it must NOT mutate `model` or its `exceptions`): per class,
    `{ count, errorCount, warningCount, infoCount, totalAbsCents, types: [...] }` (dollar impact = sum of `Math.abs`
    of each finding's `amount`, integer cents), in a STABLE class order; plus a single `headline` field — a short,
    deterministic sentence naming the SINGLE highest-priority action, chosen by a fixed priority: if any
    ERROR-severity `out_of_trust` finding exists, the headline names the out-of-trust class + its largest-dollar
    finding's `label`/`amount` ("Out of trust: <label> for <$amount> — remediate before signing"); else if any
    `data_completeness` finding exists, the headline says the FAIL is a DATA gap not an out-of-trust finding ("No
    out-of-trust finding; <N> unreconciled/unclassified line(s) — record or classify them and re-run"); else if the
    arithmetic simply does not tie, name the bank/book/sub gap; else (PASS) a clean headline. The headline must make
    the "out of trust vs. fix-my-data" distinction UNAMBIGUOUS — that is the whole point.
  - files: `trustledger/reconcile.js` (ADD `CAUSE_CLASS`, the load-time exhaustiveness check, and `triage`; export
    both; do NOT touch the existing balance/finding/verdict logic); `test/trustledger.reconcile.test.js` (ADD: every
    `EXCEPTION` value is in `CAUSE_CLASS` — assert exhaustiveness by iterating `Object.values(EXCEPTION)`; a model with
    one ERROR `security_deposit_segregation` produces an `out_of_trust` headline naming the amount; a model that
    FAILs ONLY because of `unreconciled_bank`/`unreconciled_book` produces a `data_completeness` headline that
    EXPLICITLY states it is NOT an out-of-trust finding; a clean tying model with only `timing` findings yields a
    PASS/clean headline; `triage` does not mutate the input model; dollar roll-up uses abs cents and is
    order-independent — same model with `exceptions` shuffled yields an identical triage object).
  - Acceptance: `triage(model)` is pure/deterministic/order-independent, classifies EVERY `EXCEPTION` type (load-time
    exhaustiveness guard), returns per-class roll-ups with summed abs-cents impact + a single unambiguous `headline`
    that distinguishes "out of trust" from "fix-my-data"; it mutates nothing and changes NO existing reconcile output;
    every existing test stays green byte-for-byte; NO new `needs-human` item. `npx hardhat test` green.

- **T-43.2** `VERIFIED` Surface the triage in the CLI verdict line and the HTML/JSON packet so the FAIL is legible at
  first contact. deps: T-43.1.
  - The one-line CLI summary (`summaryLine` / wherever the CLI prints the verdict) gains a SECOND line: the triage
    `headline` (e.g. on a FAIL, the top out-of-trust finding + amount, or the data-gap explanation). The existing
    first line (`PASS/FAIL: ... [X error, Y warning, Z info]`) is UNCHANGED byte-for-byte so existing
    summary/exit-code assertions stay green; the headline is ADDITIVE. The `--json` output gains a `triage` object
    (the T-43.1 return). The HTML packet gains a small "What this means / fix first" callout near the verdict
    rendering the headline + the per-class roll-up table (class, count, dollar impact) — additive markup, no existing
    section removed.
  - files: `trustledger/report.js` (ADD the headline second line in/after `summaryLine` WITHOUT changing the first
    line; ADD the triage callout + roll-up table to `renderHTML`; include `triage` in the model/JSON projection);
    `trustledger/cli.js` (print the headline line under the verdict; include `triage` in `--json`); EDIT/extend a
    report/CLI test (e.g. `test/trustledger.reconcile.test.js` or `test/trustledger.e2e.test.js`) to assert the
    first verdict line is unchanged, the headline second line appears, the FAIL-on-data case prints the "not out of
    trust" headline, and `--json` carries the `triage` object. Assert the exit-code contract is UNCHANGED.
  - Acceptance: the CLI prints the verdict's existing first line byte-for-byte PLUS a triage headline; `--json`
    carries the `triage` object; the HTML packet renders a "fix first" callout + per-class roll-up; the FAIL caused
    only by unreconciled/unclassified data prints a headline that says it is NOT an out-of-trust finding; the
    PASS/FAIL verdict and exit codes are UNCHANGED; every existing test stays green (only additive lines/markup); NO
    new `needs-human` item; NO change to P-3/P-5/P-6/P-7/P-8. `npx hardhat test` green.

- **T-43.3** `VERIFIED` Document the FAIL-triage / "what to fix first" layer in `docs/TRUSTLEDGER.md` — and frame it as
  the pilot's first-contact legibility, tying it to the honest custodian/CPA posture. deps: T-43.2.
  - Add a section ("Reading a FAIL: what to fix first") that states the four cause-classes, the priority order of the
    headline, and — crucially — the load-bearing distinction for a NEW user: a FAIL is EITHER an out-of-trust finding
    the broker must remediate OR a data-completeness gap (an unreconciled/unclassified line) to fix and re-run, and
    the headline names which. Keep the DRAFT / NOT-LEGAL-ADVICE / custodian-remains-responsible posture verbatim (the
    triage is a convenience that explains the verdict; it does NOT certify compliance and does NOT change what counts
    as out of trust — that is still the policy layer + the CPA review). Cross-reference the per-state policy section
    (a state may re-grade a finding's severity, which can move it between contributing/not-contributing to the
    out_of_trust ERROR headline) so the doc stays internally consistent.
  - files: `docs/TRUSTLEDGER.md` (ADD the section; cross-reference policy + the custodian disclaimer); a docs-rot test
    (NEW `test/cli.trustledger.triage.docs.test.js` or EDIT an existing trustledger docs test — assert the doc names
    the four cause-classes, states the out-of-trust-vs-data-gap distinction, restates the DRAFT/NOT-LEGAL-ADVICE
    posture, and that the triage changes no verdict/severity).
  - Acceptance: `docs/TRUSTLEDGER.md` documents the FAIL-triage layer (four classes, headline priority, the
    out-of-trust-vs-fix-my-data distinction) and restates the custodian/CPA/DRAFT posture verbatim; a doc test pins
    it; the doc states the triage explains but does NOT change the verdict; NO new `needs-human` item; NO change to
    P-3/P-5/P-6/P-7/P-8. `npx hardhat test` green.

## EPIC-44 — The OUT-OF-TRUST CORRECTNESS CORPUS: a runnable, CPA-reviewable proof that the gate FAILs every conversion/commingling scenario and PASSes its benign twin  *(HIGHER-LEVERAGE than another control fix — the EPIC-39..42 correctness pivot fixed FOUR real silent-false-pass bugs, but their value is invisible to a buyer/CPA who will never read the test suite. This EPIC turns that scattered correctness into ONE artifact a human can RUN and READ to TRUST the gate — directly de-risking P-5 #1 (CPA sign-off) and the P-8 pilot-to-renewal WTP conversation. NO new mechanism, NO new human gate; see STRATEGY.md "## Direction" 2026-06-25.)*

*The gap (confirmed, not invented). The flagship product's one defensible, monetizable claim is its CORRECTNESS — "a FAIL protects the beneficiary, not just the column sums." The loop already PROVED that to a developer: 2127 green tests, including the adversarial EPIC-39..42 cases (negative individual ledger, owner-draw-beyond-capital, per-beneficiary segregation, ambiguous deposit). But the two humans who gate ALL revenue — the CPA who must sign off (P-5 #1) and the broker deciding whether to PAY (P-8) — cannot read `test/`. There is no curated, plain-English, RUNNABLE corpus that shows, side by side, the canonical out-of-trust scenario for EACH control FAILing and its benign near-twin PASSing, each grounded in the trust-law principle it enforces. Today the CPA is asked to review a DISCLAIMER (P-5 #1); this EPIC lets them instead RUN the gate against the exact frauds it claims to catch and confirm the verdict themselves — a far faster, more confidence-building human action. For the pilot (P-8), it is the single strongest renewal lever after the CI merge-gate: the broker watches the tool catch the precise conversion/commingling cases that cost them their license. This EPIC adds ZERO mechanism (the controls already exist and are tested) and ZERO new human gate — it CONSOLIDATES + makes legible work already shipped. It must NEVER weaken a verdict; the corpus only asserts the EXISTING gate's behavior.*

- **T-44.1** `VERIFIED` Build the committed out-of-trust corpus: for EACH ERROR-class control the gate enforces, a canonical OUT-OF-TRUST scenario AND its benign near-twin, as committed input fixtures (bank/book/sub-ledger), each annotated with the trust-law principle and the expected verdict. deps: none (controls + engine already shipped & green).
  - Cover at minimum, one out-of-trust + one benign twin each: (a) pooled book-vs-subledger imbalance (`SUBLEDGER_OUT_OF_BALANCE`); (b) NEGATIVE individual beneficiary ledger that nets to zero in the pooled sum (T-41 — one client's money covering another); (c) owner draw EXCEEDING the owner's contributed capital (T-42 — owner paid out of tenant money) vs. a draw within contributed capital; (d) security-deposit segregation shortfall attributed PER beneficiary (T-40 — over-segregating one tenant must NOT clear another) vs. fully-segregated; (e) an ambiguous/undeterminable-beneficiary deposit (T-39 loud finding) vs. a clearly-labeled one. The benign twin must differ by the SMALLEST meaningful change so the contrast is unmistakable (e.g. only the sign of one sub-ledger, only the magnitude of the owner draw).
  - files: NEW `trustledger/fixtures/corpus/` (the input files, organized one folder per scenario with a `meta.json` carrying `{ id, control, expectedVerdict: PASS|FAIL, expectedFinding, principle }`); NEW `test/trustledger.corpus.test.js` (drive each corpus folder through the REAL `reconcile`+`buildPacket` path and assert the recorded `expectedVerdict` and that the named finding is/ isn't present — this is the regression spine that keeps the corpus honest as the engine evolves).
  - Acceptance: every out-of-trust scenario produces `pass:false` (FAIL, error-severity finding of the named type) and every benign twin produces `pass:true` (PASS) through the UNMODIFIED engine; the corpus test asserts each folder's `meta.json` verdict against the live engine output; NO engine/verdict/severity change (the corpus only ASSERTS existing behavior — if any case does not behave as claimed that is a BUG to fix under EPIC-39..42, not a corpus weakening); NO new `needs-human` item; NO change to P-3/P-5/P-6/P-7/P-8. `npx hardhat test` green.

- **T-44.2** `VERIFIED` Ship `vh trust corpus [--json]` — a single read-only command that runs the whole corpus and prints a plain-English table: each scenario, its principle, the expected verdict, the ACTUAL verdict, and OK/MISMATCH, with a one-line summary and a CI-gateable exit code. deps: T-44.1.
  - The command imports the committed corpus, runs each folder through the real `reconcile`+verdict path, and prints (human + `--json`) a row per scenario: `id`, `control`, `principle` (one sentence), `expected`, `actual`, `match`. Exit 0 only when EVERY scenario matches its recorded verdict; exit 3 if any out-of-trust case did NOT FAIL or any benign case did NOT PASS (a corpus drift / regression signal); 2 usage, 1 IO — reuse the existing trustledger CLI exit contract. Output is deterministic and writes nothing. This is the artifact a CPA or broker RUNS in one line to confirm the gate is correct, WITHOUT reading `test/`.
  - files: NEW `trustledger/corpus.js` (pure loader + runner over the committed fixtures, reusing `reconcile`/`buildPacket`/the report verdict — no new crypto, no new control logic); EDIT `trustledger/cli.js` (wire the `corpus` subcommand into the existing dispatch + exit-code contract); NEW `test/trustledger.corpus.cli.test.js` (assert the table contents, the OK/MISMATCH column, the summary line, the 0/3 exit contract, and `--json` shape; assert a deliberately-mislabeled meta.json yields a MISMATCH row + exit 3 so the command is proven not to be a rubber stamp).
  - Acceptance: `vh trust corpus` prints a deterministic per-scenario table (id, control, principle, expected, actual, match) + a one-line summary, exits 0 when all match and 3 on any mismatch, writes nothing, and `--json` carries the structured rows; a mislabeled meta.json is proven to FAIL the command (not a no-op); NO new `needs-human` item; NO change to P-3/P-5/P-6/P-7/P-8. `npx hardhat test` green.

- **T-44.3** `VERIFIED` Document the corpus as the CPA/broker correctness-review artifact in `docs/TRUSTLEDGER.md`, and POINT P-5 #1 and the P-8 pilot runbook at it — framing it as "run this to confirm the gate is correct" in place of "trust our disclaimer," while keeping the DRAFT / NOT-LEGAL-ADVICE / custodian-remains-responsible posture verbatim. deps: T-44.2.
  - Add a section ("Confirming the gate is correct: the out-of-trust corpus") that lists each scenario, its trust-law principle (per-beneficiary segregation; no negative individual ledger; owner draws only against owner capital; an undeterminable beneficiary is a finding, not a silent pass; the pooled three-way tie-out), how to RUN `vh trust corpus`, and what a clean run does and does NOT mean. Be explicit that a clean corpus proves the GATE behaves as specified on these canonical cases — it does NOT certify a particular jurisdiction's rules (that is the per-state policy + CPA review) and does NOT make the verdict legal advice. Cross-reference the per-state policy section (a state may re-grade severities, which can move a finding into/out of the out-of-trust headline) so the doc stays internally consistent. Add a one-line pointer in `docs/PILOT.md` §(verify step) so the pilot runbook ends with "and here is how the partner/their CPA confirms the gate is correct in one command."
  - files: `docs/TRUSTLEDGER.md` (ADD the section; cross-reference policy + the custodian disclaimer); `docs/PILOT.md` (one-line pointer to `vh trust corpus` in the verify step); a docs-rot test (NEW `test/cli.trustledger.corpus.docs.test.js` or EDIT an existing trustledger docs test — assert the doc names each corpus scenario/principle, names the `vh trust corpus` command, states the does/does-not-mean boundary, restates the DRAFT/NOT-LEGAL-ADVICE posture, and that the corpus changes no verdict).
  - Acceptance: `docs/TRUSTLEDGER.md` documents the corpus (each scenario + principle + how to run + the does/does-not-mean boundary) and restates the custodian/CPA/DRAFT posture verbatim; `docs/PILOT.md` points the verify step at `vh trust corpus`; a doc test pins both; the doc states the corpus confirms the gate's behavior but does NOT certify a jurisdiction or constitute legal advice; NO new `needs-human` item; NO change to P-3/P-5/P-6/P-7/P-8. `npx hardhat test` green.

## EPIC-45 — The PILOT VALUE-PROOF: run the partner's OWN already-closed month through the gate and emit a measured "what your manual close missed" result — the WTP instrument that converts the P-8 pilot  *(MATERIAL CHANGE OF APPROACH — both the verdict-CORRECTNESS vein (EPIC-39..42) and the verdict-LEGIBILITY vein (EPIC-43 triage, EPIC-44 corpus) are SATURATED and BOTH oscillated at avgUsefulness ~3.75 with no upward trend. Every artifact so far targets the SELLER's confidence in correctness; NONE answers the BROKER's actual buying question — "is this worth paying for ON MY data?" — with a measured number. P-8 leaves that to a vague relational judgment with NO instrument. This EPIC builds that instrument: a STRICTLY-additive, pure read over the EXISTING verdict + triage dollar rollup that frames the gate's findings as a DELTA versus the manual close the broker pays bookkeeper/CPA hours for today. NO engine/verdict change, NO new mechanism in the gate, NO new human gate; directly instruments the SHARPENED P-8 success contract; see STRATEGY.md "## Direction" 2026-06-25.)*

*The gap (confirmed, not invented). The product produces a per-period verdict + a triage dollar rollup (`model.triage` with `classes[]` each carrying `{class, count, absImpact}`, `totals: {count, absImpact}`, and a `headline` — already built in EPIC-43). What it does NOT produce is the ONE thing that converts a pilot: a side-by-side of the gate's findings against what the broker's OWN manual close ALREADY signed off as clean. A broker who manually reconciled last month and called it clean is the perfect pilot input — running that exact closed period through the gate turns "try our tool" into "here are N findings worth $X your last manual close let through," OR (just as valuable for trust) "your manual close was clean — the gate confirms it, here is the signed proof." Confirmed: nothing in `trustledger/` consumes a prior manual-close clean figure as a BASELINE to diff findings against (`close.js`/`report.js` chain period-to-period CONTINUITY only — that is a roll-forward check, NOT a manual-vs-tool delta). This EPIC is NOT more gate correctness and NOT more verdict legibility — it is a NEW go-to-market evidence surface that CONSUMES the verdict the gate already produces to make the pilot self-justifying. It must NEVER change a verdict, severity, count, or exit code; it only READS them.*

- **T-45.1** `VERIFIED` Build a pure `valueProof(model, manualClose)` that diffs the gate's already-computed findings/triage rollup against the broker's asserted manual-close clean figure and returns a structured "what your manual close missed" result. deps: EPIC-43 (triage rollup, shipped), EPIC-22/24 (reconcile + close, shipped).
  - Pure, OFFLINE, I/O-free, deterministic, order-independent: `(model, manualClose) -> result`. `model` is a `buildPacket`/`reconcile` result (it already carries `triage.classes[]`/`triage.totals`/`pass`/`counts`/`exceptions`). `manualClose` is the broker's asserted clean baseline for THIS period — at minimum `{ assertedClean: true|false, assertedNetCents?: int }` (the figure the manual close signed off on; OPTIONAL, used only to annotate the result, never to change a verdict). The result MUST include: `missedFindings` (count + total `absImpact` cents of every ERROR/WARNING the gate raised — i.e. what the manual close did NOT flag), partitioned by the EXISTING triage root-cause classes (`out_of_trust`/`data_completeness`/`needs_review`/`timing`) reusing `model.triage` VERBATIM (do NOT re-derive classes or impacts); a top-line `outcome` enum — `out_of_trust_missed` (≥1 out_of_trust ERROR the manual close missed → the WTP case), `data_gap_only` (only data_completeness/needs_review findings → fix-and-rerun, explicitly NOT a clean bill and explicitly NOT "the manual close was wrong"), or `clean_confirmed` (gate PASSes and agrees with an `assertedClean` manual close → the signed-clean-proof outcome); and a deterministic one-sentence `headline` (e.g. "Found 2 out-of-trust findings worth $1,250 your manual close did not flag" / "The gate confirms this period is clean."). Reuse `model.triage` totals for every number so the value-proof can NEVER disagree with the triage headline. The function changes NOTHING on the model.
  - files: NEW `trustledger/valueproof.js` (the pure function + its result shape + a load-time guard that EVERY `model.triage` class maps to a known outcome bucket, the same exhaustiveness discipline `reconcile.triage`/`policy.js` use — an unmapped class is a build error, never a silent drop); NEW `test/trustledger.valueproof.test.js` (drive real `buildPacket` models through it: an out-of-trust month → `out_of_trust_missed` + the correct summed `absImpact`; a data-gap-only month → `data_gap_only` and NOT `clean_confirmed`; a genuinely clean month with `assertedClean:true` → `clean_confirmed`; assert the per-class breakdown equals `model.triage` exactly; assert it changes no field on the input model; assert determinism + order-independence).
  - Acceptance: `valueProof(model, manualClose)` is pure/offline/deterministic, returns `{ outcome, headline, missedFindings: {count, absImpact, byClass[]}, ... }` whose numbers EQUAL `model.triage` verbatim, classifies out-of-trust vs data-gap vs clean-confirmed correctly, NEVER mutates the model or changes any verdict/severity/count/exit code, and has a load-time exhaustiveness guard over the triage classes; NO new dependency; NO new `needs-human` item; NO change to P-3/P-5/P-6/P-7 (P-8 SHARPENED to point at this — pointer only). `npx hardhat test` green.

- **T-45.2** `VERIFIED` Ship `vh trust value-proof` — a read-only command that runs the partner's OWN historical (already-closed) period through the gate and prints the broker-specific finding count + total dollar impact the manual close let through (or "clean confirmed"), with a CI-gateable exit code. deps: T-45.1.
  - The command takes the partner's own bank/book/rent-roll for a closed period (reuse the EXACT ingest + `buildPacket` wiring `vh trust reconcile` already uses — no new ingest path), plus the manual-close baseline (`--asserted-clean` and optional `--asserted-net "1,234.56"` parsed with `ingest.parseCents`, OR a small `--manual-close <file>` JSON), runs `valueProof`, and prints (human + `--json`): the `outcome`, the `headline`, and a per-class table (class, count, dollar impact) — most-urgent-first in the SAME `CLASS_RANK` order triage uses. Exit code reuses the existing trustledger CLI contract and encodes the OUTCOME for CI use: exit 0 on `clean_confirmed`, a distinct non-zero (e.g. 3) on `out_of_trust_missed` and a different non-zero (e.g. 4) on `data_gap_only` so a partner's pipeline can branch (block on out-of-trust, fix-and-rerun on data gap); 2 usage, 1 IO. Output is deterministic and writes nothing.
  - files: EDIT `trustledger/cli.js` (wire the `value-proof` subcommand into the existing dispatch + flag parsing + exit-code contract, reusing the reconcile ingest/buildPacket path verbatim); NEW `test/cli.trustledger.value-proof.test.js` (assert the table contents, the `outcome` + `headline`, the per-class rows, the distinct exit codes for clean/out-of-trust/data-gap, the `--json` shape, that it writes nothing, and that a manual-close baseline disagreeing with a clean gate is surfaced honestly — never silently overridden).
  - Acceptance: `vh trust value-proof` runs the partner's own closed period, prints a deterministic outcome + headline + per-class dollar table, exits 0/3/4 by outcome (clean/out-of-trust/data-gap) + 2/1 for usage/IO, writes nothing, and `--json` carries the structured result; every number matches the reconcile/triage verdict for the same inputs (proven by a test driving both); NO engine/verdict/severity/count change; NO new `needs-human` item; NO change to P-3/P-5/P-6/P-7. `npx hardhat test` green.

- **T-45.3** `VERIFIED` Document `vh trust value-proof` as the pilot's WTP instrument in `docs/TRUSTLEDGER.md`, and point the P-8 pilot runbook (`docs/PILOT.md`) + P-5 #3 at it — framing the pilot success criterion as the numeric outcome, while keeping the DRAFT / NOT-LEGAL-ADVICE / custodian-remains-responsible posture verbatim. deps: T-45.2.
  - Add a section ("Proving the value on YOUR data: the pilot value-proof") that explains: pick ONE month you already closed manually and signed off as clean; run `vh trust value-proof` on that period's own files; read the outcome — `out_of_trust_missed` (the dollar figure is the case to keep using it), `data_gap_only` (fix the data shape and re-run; explicitly NOT a clean bill and NOT a claim your manual close was wrong), or `clean_confirmed` (an independent, signed, one-command monthly proof of a clean trust account). Be explicit about what the value-proof does and does NOT mean: it compares the GATE's findings to what your manual close flagged on these exact files — it does NOT certify a jurisdiction's rules (that is the per-state policy + CPA review, cross-reference it because a state can re-grade a severity into/out of the out-of-trust outcome) and does NOT constitute legal advice; the custodian remains responsible for the account. Add a one-line pointer in `docs/PILOT.md` §4 so the pilot runbook ends at the numeric success contract, and a cross-reference from the SHARPENED P-8 success contract.
  - files: `docs/TRUSTLEDGER.md` (ADD the section; cross-reference the policy section + the custodian/DRAFT disclaimer); `docs/PILOT.md` (one-line pointer to `vh trust value-proof` as the pilot success contract); NEW `test/cli.trustledger.value-proof.docs.test.js` (assert the doc names the command, the three outcomes + their does/does-not-mean boundary, restates the DRAFT/NOT-LEGAL-ADVICE/custodian posture, states the value-proof changes no verdict, and that PILOT.md points its success contract at the command).
  - Acceptance: `docs/TRUSTLEDGER.md` documents the value-proof (the three outcomes + how to run + the does/does-not-mean boundary) and restates the custodian/CPA/DRAFT posture verbatim; `docs/PILOT.md` points the pilot success contract at `vh trust value-proof`; a doc test pins both; the doc states the value-proof compares the gate to the manual close but does NOT certify a jurisdiction or constitute legal advice; NO new `needs-human` item; NO change to P-3/P-5/P-6/P-7 (P-8 SHARPENED to point at it). `npx hardhat test` green.

## EPIC-46 — `vh evidence diff <A> <B>`: the recipient-side "what changed between the two hand-offs?" report — close the missing leg of the LIGHTER-gated (P-7) evidence vertical and widen its zero-human-gate FREE funnel  *(MATERIAL CHANGE OF DIRECTION — pivot OFF the saturated TrustLedger axis. Every EPIC from ~31 onward (go-to-market mechanism 29–38, core-correctness bugs 39–42, verdict-legibility 43–44, the WTP instrument 45) orbited the SINGLE vertical dammed behind the HEAVIEST human gate — P-5 (CPA/legal/per-state) + P-8 (design partner) — and avgUsefulness sat flat-and-mediocre at ~3.75 (min 3, one min=2 outlier) while humanGated stood at 3–5 for ~17 runs. The directive for a STANDING value ceiling: do NOT mine more same-vein items behind the dam — pursue a higher-leverage capability on the surface that needs NO human gate. The EVIDENCE vertical (P-7) is that surface: its only human steps are a vendor key + a price + ONE partner (no CPA/legal/per-state layer), AND it already has a zero-install, zero-human-gate organic-adoption funnel (EPIC-35/36). But it ships only `seal` + `verify` — it has NO recipient-side `diff`, the single most-recurring need in any "prove the exact file set" workflow: a recipient who holds v1 (the packet they were handed) and v2 (the next hand-off) wants "what changed?" purely from the two portable artifacts. The DATASET vertical already proved this exact capability is valued (`vh dataset diff A B`, shipped + green) — this brings the SAME, mirror-design capability to evidence packets, reusing the `cli/receipt.js › diffManifest` core VERBATIM, with NO new diff logic and NO new crypto. It is a FREE-tier funnel widener: a recipient who diffs incoming hand-offs becomes a daily free user, then needs to PRODUCE sealed/signed hand-offs themselves (the PAID `--sign` / `evidence_unlimited` surface) — the organic free→paid pull P-7 depends on, with no design-partner gate. See STRATEGY.md "## Direction" 2026-06-25.)*

*The gap (confirmed against the live product, not invented). `cli/evidence.js` wires only `seal` and `verify` (confirmed: the only evidence subcommands in `vh.js` dispatch + the `vh evidence …` usage lines). An evidence packet's `files[]` carry exactly `{ relPath, contentHash, leaf }` — the SAME shape `diffManifest` consumes (it keys on `path`/`leaf`), and the SAME shape `vh dataset diff` already maps into `diffManifest` verbatim (`cli/dataset.js › runDatasetDiff`). So the recipient-side diff is buildable with ZERO new diff logic: read both packets via the existing strict `readSeal` (a corrupt/foreign/edited packet is REJECTED, never half-accepted), map `files[]` → the diff-core shape, reuse `diffManifest`, and report the directional ADDED/REMOVED/CHANGED set. This must mirror `vh dataset diff` EXACTLY in posture: it compares what each packet CLAIMS — it does NOT re-derive content from bytes (there is no directory to read; that is what `vh evidence verify <p> --dir <d>` already does); the AUTHORITATIVE verdict + exit code is the CHANGE SET (`diff.identical`), never raw root-string equality, so a hand-edited `root` whose leaves are unchanged still reports IDENTICAL and cannot flip the verdict; a rename surfaces as REMOVED(old)+ADDED(new) because the relPath is bound into the leaf. It is read-only, NO key, NO network, writes nothing, and is FREE (diffing two portable artifacts produces no new sealed/signed artifact, so there is nothing to gate). It must NEVER change `seal`/`verify` behavior or any existing verdict; it only READS two packets.*

- **T-46.1** `VERIFIED` Build a pure `diffEvidence({ packetA, packetB })` (and its `seal`-object overload) that diffs two evidence packets by REUSING `cli/receipt.js › diffManifest` verbatim and returns the directional change set + a change-set-driven `identical`. deps: EPIC-30 (`vh evidence seal|verify` + `readSeal`, shipped & green); the `diffManifest` core (shipped & green). *(Decider 2026-06-25: prior `BLOCKED` "auto-build failed after 3 attempts" was a STALE status — the deliverable already exists and passes. `cli/evidence.js` exports `diffEvidence`/`diffEvidenceSeals` reusing `readSeal` + `require("./receipt").diffManifest` verbatim with a change-set-driven `identical`; `test/cli.evidence.diff.test.js` has 9 passing tests (re-run green); dependents T-46.2 + T-46.3 are already VERIFIED, which is impossible if this leg were broken. Reconciled to `TODO`/verify-only — no 4th auto-build; the gate is to re-confirm the existing artifact, not to re-author it. VERIFIED 2026-06-26 via commit bf2cd96 — added pure, CI-gateable drift-policy evaluation (`evaluateDriftPolicy`, `validateDriftPolicy`, `readDriftPolicy`) on top of the existing diffEvidence core, wired `--policy` into `vh evidence diff`, documented in `docs/EVIDENCE.md`.)*
  - Pure, OFFLINE, I/O-free, deterministic, order-independent. Accept either two parsed seal objects or two packet strings, validate BOTH through the EXISTING strict `readSeal` (a corrupt/foreign/edited/wrong-`kind` packet is REJECTED before any diff — never half-accepted), then map each packet's `files[]` (`{relPath, contentHash, leaf}`) into the `{path, contentHash, leaf}` shape `diffManifest` expects (A = baseline/"recorded", B = comparison/"current", so ADDED = in B not A, REMOVED = in A not B, CHANGED = same relPath, different leaf carrying old→new contentHash) and reuse `diffManifest` VERBATIM. Return `{ rootA, rootB, rootsIdentical, identical, added, removed, changed, unchanged, counts }` where the AUTHORITATIVE `identical` is `diff.identical` (the change set), NOT root-string equality — so a hand-edited `root` cannot flip the verdict (mirror `cli/dataset.js › runDatasetDiff` exactly). The function re-derives NOTHING from bytes (there is no directory) and mutates NEITHER input.
  - files: NEW pure function in `cli/evidence.js` (e.g. `diffEvidence`/`diffEvidenceSeals` — reuse `readSeal` + `require("./receipt").diffManifest`; NO new diff logic, NO new crypto); NEW `test/cli.evidence.diff.test.js` (an identical pair → `identical:true`, `+0/-0/~0`; an added file → ADDED only; a removed file → REMOVED only; an edited file → CHANGED with old→new contentHash; a renamed file → REMOVED+ADDED (never one CHANGED); a packet with a hand-edited `root` but unchanged leaves → still `identical:true` (verdict is the change set); a corrupt/foreign packet → REJECTED via `readSeal`; assert determinism, order-independence within each section, and that neither input packet is mutated).
  - Acceptance (Decider 2026-06-25 — VERIFY-ONLY reconcile; no new code is to be authored, the gate is to re-confirm the EXISTING artifact): (1) `cli/evidence.js` exports `diffEvidence` AND `diffEvidenceSeals`; `diffEvidence({packetA,packetB})` delegates to `diffEvidenceSeals`. (2) Both validate EACH input through the EXISTING strict `readSeal` BEFORE any diff (corrupt/foreign/wrong-kind/edited packet REJECTED, never half-accepted) and accept either parsed seal objects OR packet strings. (3) The change set comes from `require("./receipt").diffManifest` reused VERBATIM (no new diff/crypto logic), with `files[]`→`{path,contentHash,leaf}` mapping (A=baseline, B=comparison). (4) The returned `identical` is the change-set verdict (`diff.identical`), NOT root-string equality — a hand-edited `root` whose leaves are unchanged still reports `identical:true`; a rename surfaces as REMOVED+ADDED (never one CHANGED); neither input is mutated. (5) `test/cli.evidence.diff.test.js` exists and `npx hardhat test test/cli.evidence.diff.test.js` is green (currently 9 passing). (6) `seal`/`verify` behavior + exit codes UNCHANGED; NO new `needs-human` item; NO change to P-3/P-5/P-6/P-7/P-8; full `npx hardhat test` green. Flip to `VERIFIED` once (1)–(6) hold — NOT a 4th auto-build.

- **T-46.2** `VERIFIED` Ship `vh evidence diff <packetA> <packetB> [--json]` — a read-only, FREE, key-free, offline change report that leads with the same "compares what each packet CLAIMS — does NOT re-derive content" TRUST line and uses the change-set-driven IDENTICAL/DIFFERENT exit contract. deps: T-46.1.
  - Wire the `diff` subcommand into `cli/evidence.js`'s arg parsing + `cmdEvidence` dispatch and into the `vh evidence …` usage in `cli/vh.js`. Read both packet files (an unreadable/garbled/foreign packet is the SAME hard reject as `verify` — never a partial run), run `diffEvidence`, and print (human + `--json`): the TRUST line FIRST (mirror `formatDatasetDiff` — "this compares what each packet CLAIMS; it does NOT re-derive content; run `vh evidence verify <p> --dir <d>` to re-derive a root from bytes"), the two roots as DISPLAYED metadata, an IDENTICAL/DIFFERENT headline driven by the CHANGE SET, the per-file ADDED/REMOVED/CHANGED block with a `+a / -r / ~c / u unchanged` count line, and the explicit note that a rename shows as REMOVED+ADDED. Exit contract MIRRORS `vh dataset diff` + the evidence family: 0 when IDENTICAL, 3 when they DIFFER (so a recipient's pipeline can fail-on-change), 2 usage, 1 IO. It is FREE (no `--license`/`--vendor`; produces no sealed/signed artifact), key-free, network-free, and writes NOTHING. Unknown/incomplete flags hard-error with usage (exit 2), matching the existing evidence parser parity.
  - files: EDIT `cli/evidence.js` (parse `diff <A> <B> [--json]`; dispatch in `cmdEvidence`; add a `formatEvidenceDiff` mirroring `formatDatasetDiff`); EDIT `cli/vh.js` (add the `vh evidence diff …` usage line next to `seal`/`verify`); NEW `test/cli.evidence.diff.cli.test.js` (assert: the TRUST line is printed FIRST; identical packets → exit 0 + IDENTICAL + `+0/-0/~0`; differing packets → exit 3 + the precise per-file block + count line; a rename shows REMOVED+ADDED; `--json` carries `{rootA,rootB,rootsIdentical,identical,added,removed,changed,unchanged,counts}`; an unreadable/foreign packet → exit 1/REJECTED as `verify` would; unknown flag → exit 2; the command writes NOTHING and needs NO license).
  - Acceptance: `vh evidence diff A B` runs OFFLINE/key-free/free, leads with the CLAIMS-not-content TRUST line, prints a deterministic IDENTICAL/DIFFERENT headline + per-file ADDED/REMOVED/CHANGED block + count line driven by the change set, exits 0/3/2/1 per the mirrored contract, surfaces a rename as REMOVED+ADDED, writes nothing, and `--json` carries the structured change set; it requires NO license and never gates (a diff produces no sealed artifact); the existing `seal`/`verify` behavior + exit codes are unchanged; NO new `needs-human` item; NO change to P-3/P-5/P-6/P-7/P-8. `npx hardhat test` green.

- **T-46.3** `VERIFIED` Document `vh evidence diff` in `docs/EVIDENCE.md` as the recipient-side companion to `verify`, and surface it in the P-7 organic-adoption framing — with the explicit "compares CLAIMS, does NOT re-derive content; run `verify --dir` for the bytes-level check" boundary. deps: T-46.2.
  - Add the `diff` line to the Commands block and a short section ("What changed between two hand-offs? `vh evidence diff`") that explains: you hold the v1 packet you were handed and the v2 packet of the next hand-off; `vh evidence diff v1 v2` reports ADDED/REMOVED/CHANGED purely from the two portable artifacts, OFFLINE, with no directory and no key; a rename shows as REMOVED+ADDED; and — explicitly — a diff compares what each packet CLAIMS, it does NOT re-derive content from bytes (to confirm a packet still matches a real directory, run `vh evidence verify <p> --dir <d>`), and it changes no `seal`/`verify` behavior. Keep the standing trust-boundary note (tamper-evidence + offline-recompute, NOT a trusted timestamp / P-3) verbatim. Note that `diff` is FREE (it produces no new sealed/signed artifact, so there is nothing to gate) — a one-line reinforcement of the free-tier funnel.
  - files: `docs/EVIDENCE.md` (add the `diff` command line + the section + the FREE-tier note; keep the trust-boundary note verbatim); a docs-rot test (NEW `test/cli.evidence.diff.docs.test.js` or EDIT an existing evidence docs test — assert the doc names `vh evidence diff`, states the compares-CLAIMS-not-content boundary, points at `verify --dir` for the bytes-level check, states `diff` is FREE/key-free, and that it changes no existing verdict; restate the tamper-evidence/NOT-timestamp boundary).
  - Acceptance: `docs/EVIDENCE.md` documents `vh evidence diff` (the recipient-side use, the rename behavior, the compares-CLAIMS-not-content boundary, the pointer to `verify --dir`, and that it is FREE/key-free) and restates the tamper-evidence/NOT-trusted-timestamp boundary verbatim; a doc test pins all of it; NO new `needs-human` item; NO change to P-3/P-5/P-6/P-7/P-8. `npx hardhat test` green.

## EPIC-47 — `vh evidence verify-signed`: cryptographically RECOVER + PIN the signer of a SIGNED evidence packet — close a SILENT-FALSE-PASS in the PAID `evidence_signed` surface (the recipient's whole reason to pay)  *(STAY on the lighter-gated (P-7) evidence vertical the EPIC-46 pivot opened — but a CORRECTNESS/SECURITY fix in the PAID surface, not another free-tier widener. CONFIRMED in the live product: `vh evidence verify <p>` accepts a SIGNED packet (`cli/evidence.js › readPacket` detects `SIGNED_SEAL_KIND`, unwraps the embedded seal, and reports `signed:true, signer:<X>`), but it NEVER cryptographically verifies the signature — `signer` is `obj.signature.signer`, the packet's OWN UNVERIFIED CLAIM. The structural `validateSignedSeal`/`validateSignedAttestation` only checks the signature's SHAPE (65-byte hex, lowercase signer, canonical embedded bytes) and returns WITHOUT ever calling `recoverSigner`. So a forged container that hand-writes `signature.signer: 0xACME` with a structurally-valid-but-bogus 65-byte signature passes `vh evidence verify` and PRINTS `signer: 0xACME` — a SILENT FALSE PASS that asserts a vendor identity nobody actually proved. This is exactly the silent-false-pass class the loop found high-value in TrustLedger (EPIC-39..42), now on the LIGHTER-gated revenue path (P-7: vendor key + price + ONE partner; NO CPA/legal/per-state layer). The core already HAS the fix — `coreAttestation.verifySignedAttestation({ container, expectedSigner, expectedCanonical })` does full EIP-191 `verifyMessage` recovery + a claimed-vs-recovered check + an OPTIONAL `expectedSigner` pin — and `cli/evidence.js` already EXPORTS a `verifySignedSeal` wrapper for it (line ~383), but NOTHING in the CLI calls it. The sibling verticals already SHIP this exact verifier: `vh dataset verify-attest` and `vh parcel verify-attest` both recover the signer + pin `--signer <addr>` and LEAD with the trust caveat. The evidence vertical is the ONLY one whose signed surface a recipient cannot cryptographically check. Why higher-leverage than the alternatives: (a) another free-tier widener (more `diff`-class read commands) does not touch the PAID surface's core defect; (b) re-sharpening P-3/P-5/P-6/P-7/P-8 is forbidden busywork; (c) a new product re-caps usefulness; (d) THIS makes the ONE thing a recipient PAYS the signed surface for — "prove this packet really came from my vendor" — actually TRUE, on the ungated path, by WIRING an already-built+tested core verifier and MIRRORING an already-shipped sibling command. A recipient who can PIN the vendor (`--signer`) is exactly who then trusts and pays for signed hand-offs — it directly strengthens P-7's free→paid pull. See STRATEGY.md "## Direction" 2026-06-25.)*

*The gap (confirmed against the live engine, not invented). I traced `vh evidence verify` on a signed packet end to end. `runEvidenceVerify` → `readPacket(text)`: for a `SIGNED_SEAL_KIND` container it runs `validateSignedSeal(obj)` (STRUCTURAL only — re-validates the embedded canonical bytes + signature SHAPE; CONFIRMED it returns at `cli/core/attestation.js` without ever calling `recoverSigner`) and `readSeal(obj.attestation)`, then returns `{ seal, signed:true, signer: obj.signature.signer }`. The downstream verdict is a BYTES check (`verifySeal(seal, entries)` re-derives the root from on-disk files) and the JSON/human output surfaces `signer: parsed.signer` — the CLAIMED signer — with NO cryptographic recovery and NO way to pin it. So the signature is NEVER checked: a hand-forged `signature.signer` is reported verbatim. By contrast `cli/dataset.js › runVerifyAttest` and `cli/parcel.js › runVerifyAttest` BOTH read the container strictly, run `verifySignedAttestation` (recover → claimed-vs-recovered check → optional `--signer` pin → optional `--manifest`/`--dir` binding), LEAD with the trust caveat, print per-check PASS/FAIL, and REJECT naming the failed check(s). The evidence vertical needs the SAME verifier wired the SAME way — and it already has the core function (`verifySignedSeal`) exported but unused. This is a WIRING + MIRROR task: no new crypto, no new scheme, no new core; reuse `coreAttestation.verifySignedAttestation` (the SAME function dataset/parcel call) via the existing `verifySignedSeal` export, and mirror `formatVerifyAttest`'s trust-line-first, per-check, REJECTED-names-the-failure output. It must NEVER change the existing `vh evidence verify`/`seal`/`diff` verdicts — but it MUST stop `vh evidence verify` from REPORTING a signed packet's claimed signer AS IF trusted; on a signed packet, `verify` must either (a) cryptographically confirm the signature recovers to the claimed signer (and FAIL/REJECT if not), or (b) clearly disclaim, in both human + `--json` output, that it did NOT check the signature and the recipient must run `vh evidence verify-signed` to prove the signer. Closing this is STRICTLY non-looser: it can only ADD a failing verdict or a disclaimer where today there is a silent, unverified claim.*

- **T-47.1** `VERIFIED` Wire `verifySignedSeal` into a strict, PURE evidence signed-verify path that recovers the signer + supports an OPTIONAL `expectedSigner` pin and OPTIONAL `--dir`/manifest binding, MIRRORING `cli/dataset.js › verifySignedAttestation` exactly. deps: EPIC-30 (`vh evidence seal --sign` + `verifySignedSeal` export, shipped & green); `coreAttestation.verifySignedAttestation` (shipped & green); the `dataset`/`parcel verify-attest` pattern (shipped & green).
  - Add (or harden) a pure `runEvidenceVerifySigned`-feeding helper in `cli/evidence.js` that: reads the signed container via the strict `validateSignedSeal` (a malformed/edited/foreign container is REJECTED, never half-accepted), then runs `verifySignedSeal({ container, expectedSigner, expectedCanonical })` (which delegates to `coreAttestation.verifySignedAttestation`). Always perform Check 1 (the signature recovers to the CLAIMED signer); perform Check 2 (recovered signer EQUALS the pinned `--signer <addr>`) ONLY when `--signer` is given; OPTIONALLY perform the binding check (the signed payload's canonical bytes are byte-identical to the seal the recipient holds — reuse the SAME `expectedCanonical` mechanism dataset/parcel use). Return the SAME verdict shape the sibling verifiers return: `{ verdict, scheme, recoveredSigner, claimedSigner, expectedSigner, checks:{signatureMatchesSigner, signerMatchesExpected, ...}, accepted, failedChecks }`. PURELY OFFLINE: no provider, no network, no key; writes nothing; mutates no input. A bogus signature (recovers to a DIFFERENT address than claimed, or `verifyMessage` throws on a non-point) is REJECTED with `signatureMatchesSigner:false`, NEVER a silent pass.
  - files: EDIT `cli/evidence.js` (a pure verify-signed helper reusing the EXISTING `verifySignedSeal` export + `coreAttestation.verifySignedAttestation`; a `formatEvidenceVerifySigned` mirroring `cli/dataset.js › formatVerifyAttest` — trust caveat FIRST, recovered/claimed/expected signer, per-check PASS/FAIL/[skip], ACCEPTED or REJECTED-naming-failed-checks); NEW `test/cli.evidence.verifysigned.test.js` (assert at the function level: a genuinely-signed packet recovers to the signer and ACCEPTS; a packet whose `signature.signer` is hand-forged to a different address → `signatureMatchesSigner:false`, REJECTED; a valid signature with `--signer` pinned to the WRONG address → `signerMatchesExpected:false`, REJECTED; `--signer` pinned to the RIGHT address → ACCEPTED with the pin PASS; a structurally-broken signature (bad length/non-hex) → REJECTED via the strict read; determinism + no mutation + no network handle opened).
  - Acceptance: `cli/evidence.js` exposes a pure evidence signed-verify path that runs `coreAttestation.verifySignedAttestation` (via the existing `verifySignedSeal`) and returns the sibling-parity verdict shape; Check 1 always runs, Check 2 runs only under `--signer`, and a forged/mismatched signature is REJECTED (never a silent pass); it is OFFLINE/key-free/network-free, writes nothing, mutates no input; the new function-level test is green; NO change to `seal`/`verify`/`diff` verdicts yet (CLI wiring is T-47.2); NO new `needs-human` item; NO change to P-3/P-5/P-6/P-7/P-8. `npx hardhat test` green.

- **T-47.2** `VERIFIED` Ship `vh evidence verify-signed <signed> [--dir <d>] [--signer <addr>] [--json]` AND close the silent-claim in `vh evidence verify` — on a signed packet, `verify` must either cryptographically confirm OR clearly disclaim it did not check the signature. deps: T-47.1.
  - Wire a `verify-signed` subcommand into `cli/evidence.js` arg parsing + `cmdEvidence` dispatch (add it to the `unknown evidence subcommand: … (expected: seal, verify, diff)` list → `seal, verify, verify-signed, diff`) and into the `vh evidence …` usage in `cli/vh.js`. It reads the signed container, runs the T-47.1 path, and prints (human + `--json`) the trust-line-first, per-check verdict mirroring `vh dataset verify-attest`; with `--dir <d>` it ALSO confirms the on-disk bytes match the embedded seal (reuse the existing `runEvidenceVerify` bytes path) so a recipient gets BOTH "the signer is who I expected" AND "the files still match" in one command. Exit contract MIRRORS the family: 0 ACCEPTED / 3 REJECTED (any requested check failed) / 2 usage / 1 IO. SEPARATELY, harden `runEvidenceVerify`: when `readPacket` reports `signed:true`, `vh evidence verify` must NOT print the claimed `signer` as if trusted — either (a) perform the Check-1 recovery inline and REJECT (exit 3) if the signature does not recover to the claimed signer, or (b) clearly label the signer line as UNVERIFIED CLAIM in both human + `--json` output and instruct the recipient to run `vh evidence verify-signed [--signer <addr>]` to PROVE the signer. Pick (a) if it does not regress any existing signed-`verify` test; else (b). Either way the silent unverified-claim is closed. `--json` carries the full structured verdict (`recoveredSigner`, `expectedSigner`, `checks`, `verdict`).
  - files: EDIT `cli/evidence.js` (parse `verify-signed <signed> [--dir <d>] [--signer <addr>] [--json]`; dispatch in `cmdEvidence`; update the unknown-subcommand list; harden `runEvidenceVerify`'s signed-packet output per (a)/(b)); EDIT `cli/vh.js` (add the `vh evidence verify-signed …` usage line + note the signed-`verify` disclaimer); NEW `test/cli.evidence.verifysigned.cli.test.js` (assert: a genuinely-signed packet → exit 0 ACCEPTED with recovered==claimed; a forged-signer packet → exit 3 REJECTED naming `signatureMatchesSigner`; `--signer` to the wrong addr → exit 3 REJECTED naming `signerMatchesExpected`; `--signer` to the right addr → exit 0; `--dir` with matching files → ACCEPTED and confirms bytes, with tampered files → REJECTED; the TRUST line is printed FIRST; `--json` carries the verdict; unknown flag → exit 2; an unreadable/foreign container → exit 1; AND a regression test that `vh evidence verify` on a SIGNED packet no longer presents the claimed signer as trusted — it either REJECTS a forged signature (option a) or labels the signer UNVERIFIED + points at `verify-signed` (option b)).
  - Acceptance: `vh evidence verify-signed` runs OFFLINE/key-free, leads with the trust caveat, recovers + (under `--signer`) pins the signer, (under `--dir`) confirms the bytes, prints per-check PASS/FAIL, exits 0/3/2/1, and `--json` carries the structured verdict; `vh evidence verify` no longer reports a signed packet's claimed signer as if trusted (it REJECTS a forged signature OR labels it UNVERIFIED and points at `verify-signed`); the existing `seal`/`diff` behavior + exit codes are UNCHANGED; income still comes ONLY from selling the (now actually-trustworthy) signed surface to paying customers — a HUMAN step; NO new `needs-human` item; NO change to P-3/P-5/P-6/P-7/P-8. `npx hardhat test` green.

- **T-47.3** `VERIFIED` Document `vh evidence verify-signed` in `docs/EVIDENCE.md` as the recipient's "prove WHO signed this" step — the trust check the PAID signed surface exists to enable — and correct any text that implies `vh evidence verify` checks the signer. deps: T-47.2.
  - Add the `verify-signed` line to the Commands block and a short section ("Who signed this packet? `vh evidence verify-signed`") explaining: a SIGNED evidence packet carries a vendor's detached signature; `vh evidence verify-signed <signed> [--signer <0xaddr>] [--dir <d>]` recovers the signer from the canonical bytes + signature (it NEVER trusts the packet's own `signer` field), optionally PINS it to the vendor address you expect (`--signer`), and optionally confirms the on-disk bytes still match (`--dir`); a forged or wrong-signer packet REJECTS. Explicitly state the boundary that `vh evidence verify` (without `-signed`) re-derives the ROOT from bytes but does NOT cryptographically check the signature — to prove the SIGNER you must run `verify-signed`. Keep the standing trust-boundary note (tamper-evidence + offline-recompute, NOT a trusted timestamp / signer-vouch-NOT-timestamp / P-3) verbatim. Frame it in the P-7 free→paid narrative: the recipient who pins the vendor is who then relies on signed hand-offs.
  - files: `docs/EVIDENCE.md` (add the `verify-signed` command line + the section; correct any "verify checks the signer" wording; keep the trust-boundary note verbatim); a docs-rot test (NEW `test/cli.evidence.verifysigned.docs.test.js` or EDIT an existing evidence docs test — assert the doc names `vh evidence verify-signed`, states it RECOVERS the signer (never trusts the packet's own claim), documents `--signer` pinning + `--dir` binding, states the `verify` vs `verify-signed` boundary, and restates the signer-vouch-NOT-timestamp / P-3 caveat verbatim).
  - Acceptance: `docs/EVIDENCE.md` documents `vh evidence verify-signed` (recover-not-trust, `--signer` pin, `--dir` binding, the `verify` vs `verify-signed` boundary) and no longer implies `verify` checks the signer; the signer-vouch-NOT-timestamp / P-3 caveat is restated verbatim; a doc test pins all of it; NO new `needs-human` item; NO change to P-3/P-5/P-6/P-7/P-8. `npx hardhat test` green.

## EPIC-48 — Self-serve evidence-license FULFILLMENT: an evidence PLAN CATALOG + an order→license mapping + `vh evidence license fulfill` so an evidence sale is machine-driven, NOT a human at a terminal per sale  *(STAY on the lighter-gated (P-7) evidence vertical the EPIC-46/47 pivot opened — but a CAPABILITY that UNLOCKS the revenue MOTION, not another recipient-side read or verify fix. CONFIRMED in the live product (`cli/evidence.js`, exhaustive subcommand list: seal, verify, verify-signed, diff): the evidence vertical CONSUMES licenses — `verifyLicense(container,{vendorAddress})` gates the PAID `evidence_signed`/`evidence_unlimited` surfaces — and it HAS the issuance primitive `buildLicense(params, signer)` bound to its OWN disjoint CFG (`LICENSE_KIND="vh-evidence-license"`, `EvidenceLicenseError`, the closed `{evidence_signed, evidence_unlimited}` ENTITLEMENTS), but it has NO way to PRODUCE a license a customer can buy: there is NO evidence plan catalog, NO `fulfillOrder`, and NO fulfill/issue command. So today every evidence sale would require a human to hand-craft `buildLicense` params (entitlement flags + a hand-computed expiry) at a terminal — the EXACT per-sale-human hole EPIC-37 identified and closed for TrustLedger, which makes self-serve evidence revenue impossible. TrustLedger ALREADY solved this for ITS vertical: `trustledger/plans.js` (a versioned, strictly-validated PLAN CATALOG over the closed ENTITLEMENTS — an unknown flag or duplicate planId is a hard build error), `trustledger/license.js › fulfillOrder(order, catalog)` (a PURE, deterministic order→license-params mapping: resolve the planId, copy the plan's entitlements verbatim, derive expiry from `paidThrough` or `issuedAt + termDays`), and `vh trust license fulfill --plan <id> --customer <name> --paid-through <ISO> --key-env <VAR>` (reads a human-provisioned vendor key read-used-discarded, mints the SAME signed `*.vhlicense.json` the gate accepts). But ALL of that machinery is HARD-BOUND to TrustLedger's CFG (`PLAN_CATALOG_KIND="trustledger-plan-catalog"`, `license.ENTITLEMENT_FLAGS`, `LicenseError`) — the evidence vertical (disjoint kind, disjoint entitlements, disjoint error class) cannot reuse it as-is. This EPIC brings the SAME proven, shipped-and-green fulfillment pattern to the evidence vertical, bound to the evidence CFG: an evidence plan catalog (`kind: vh-evidence-plan-catalog`, validated against the closed `{evidence_signed, evidence_unlimited}` table) + an evidence `fulfillOrder` + `vh evidence license fulfill`. Why higher-leverage than the alternatives: (a) another recipient-side read/verify item (the EPIC-46/47 vein) widens the FREE funnel but does NOT make the PAID surface SELLABLE without a human at a terminal — the actual revenue motion stays blocked; (b) re-sharpening P-3/P-5/P-6/P-7/P-8 is forbidden busywork (already decision-ready); (c) a brand-new product re-caps usefulness and adds breadth the family already has; (d) THIS completes the LIGHTER-gated (P-7) vertical's revenue motion end-to-end — a customer who hits the evidence paywall can be issued a license by a billing webhook with NO hand-authored entitlement list, exactly as TrustLedger can — so it SHARPENS P-7 step 2 (price + free-vs-paid split) from "remember the right entitlements + compute the expiry by hand for every sale" to "fill in YOUR price/term per planId in the catalog; point your billing webhook at `vh evidence license fulfill`; DONE." STRICTLY ADDITIVE: it ships ONLY the catalog schema + the order→license mapping + the command + ephemeral test keys; it sets NO price, holds NO real key, runs NO payment processor, takes NO real payment — provisioning the vendor key, setting the price/term in the catalog (the value column), and wiring the actual webhook remain human-owned outward steps (P-7 step 1/2). It changes NO existing seal/verify/verify-signed/diff behavior or any verdict/exit code, and adds NO new `needs-human` item. See STRATEGY.md "## Direction" 2026-06-25.)*

*The gap (confirmed against the live engine, not invented). I enumerated every evidence subcommand (`cli/evidence.js`: the `cmdEvidence` dispatch + the `unknown evidence subcommand … (expected: seal, verify, verify-signed, diff)` reject list) — there is NO fulfill/issue/license-mint path. I confirmed the evidence vertical HAS the issuance primitive: `cli/evidence.js › buildLicense(params, signer)` delegates to `coreLicense.buildLicense(params, signer, LICENSE_CFG)` with the evidence CFG (`LICENSE_KIND="vh-evidence-license"`, closed `ENTITLEMENTS={evidence_signed, evidence_unlimited}`, `EvidenceLicenseError`). I confirmed the GATE consumes it: `verifyLicense(container,{now,vendorAddress})` honors those exact flags. And I confirmed the MISSING half by reading the TrustLedger sibling that DID solve it: `trustledger/plans.js › validatePlanCatalog`/`getPlan` (catalog `kind="trustledger-plan-catalog"`, entitlements closed over `license.ENTITLEMENT_FLAGS`, duplicate/unknown = hard error), `trustledger/license.js › fulfillOrder(order, catalog)` (PURE: `_resolvePlan` → copy `plan.entitlements.slice()` → expiry from `paidThrough` else `issuedAt + termDays*DAY_MS` → deterministic default `licenseId`), and `trustledger/cli.js › vh trust license fulfill` (loads a BUNDLED-by-default validated catalog from `fixtures/plans/baseline.json`, reads EXACTLY ONE of `--key-env`/`--key-file` read-used-discarded, mints the signed license the gate accepts). All of it is bound to TrustLedger's CFG and cannot be reused verbatim by the disjoint evidence product. This is a MIRROR task: no new crypto, no new license scheme, no new core gate — reuse the EXACT catalog/fulfill PATTERN and the evidence vertical's OWN already-shipped `buildLicense`/`ENTITLEMENTS`/`EvidenceLicenseError`, producing an evidence-bound catalog (`kind="vh-evidence-plan-catalog"`), an evidence `fulfillOrder`, and `vh evidence license fulfill`. It must NEVER change any existing evidence verdict/exit code and must set NO price (the catalog ships as an explicit DRAFT/SAMPLE the human fills in). NOTE for a future consolidation pass (do NOT do it in this EPIC — keep this strictly a proven mirror): the catalog-validation + `fulfillOrder` logic is now needed by TWO verticals; a later EPIC could lift the CFG-agnostic core into `cli/core/` and have both `trustledger/` and `cli/evidence.js` bind it, eliminating the duplication. This EPIC mirrors first (proven, non-regressing); the shared-core lift is a separate, deliberate refactor.*

- **T-48.1** ✅ VERIFIED Add an evidence PLAN CATALOG: a versioned, strictly-validated `{ planId → {entitlements, termDays, displayName} }` mapping over the CLOSED evidence `{evidence_signed, evidence_unlimited}` table + a pure evidence `fulfillOrder(order, catalog)` — MIRRORING `trustledger/plans.js`/`trustledger/license.js › fulfillOrder` exactly, but bound to the evidence CFG. deps: EPIC-30 (`cli/evidence.js` `buildLicense`/`ENTITLEMENTS`/`EvidenceLicenseError`, shipped & green); the `trustledger/plans.js` + `trustledger/license.js › fulfillOrder` pattern (shipped & green).
  - Add an evidence plan-catalog module (new `cli/core/evidence-plans.js`, OR a section of `cli/evidence.js` — keep it close to the evidence CFG so the closed entitlement table is the SINGLE source of truth) that exposes: `validateEvidencePlanCatalog(obj)` (REQUIRE `kind === "vh-evidence-plan-catalog"` + a supported integer `schemaVersion` + a non-empty `plans` array; each plan has a non-empty string `planId`, a `displayName`, a positive-integer `termDays`, and an `entitlements` array whose every flag is in the evidence closed table — an UNKNOWN flag or a DUPLICATE `planId` is a HARD `EvidenceLicenseError` (or a dedicated `EvidencePlanCatalogError`), NEVER a silent last-wins/mis-grant; return a deeply-frozen, planId-sorted catalog carrying a `plansById` map); `getEvidencePlan(catalog, planId)` (a NAMED reject naming the known plans on an unknown id); and `fulfillEvidenceOrder(order, catalog)` (PURE/DETERMINISTIC: resolve the plan, require a non-empty `customer` + a canonical-ISO `issuedAt`, derive `expiresAt` from an explicit `paidThrough` — which must be strictly AFTER `issuedAt` — else `issuedAt + plan.termDays` UTC days, copy `plan.entitlements.slice()` verbatim, default `licenseId` deterministically; return the EXACT `{ licenseId, customer, plan, entitlements, issuedAt, expiresAt }` shape `buildLicense`/`buildLicensePayload` consume). NO filesystem, NO clock, NO network, NO key. Ship a BUNDLED DRAFT/SAMPLE catalog fixture (e.g. `cli/core/fixtures/evidence-plans/baseline.json`, clearly marked a DRAFT the human fills the price/term into) with at least: a paid tier granting `evidence_signed` + `evidence_unlimited`. Do NOT reuse the TrustLedger catalog `kind` or entitlements — the two products stay disjoint.
  - files: NEW `cli/core/evidence-plans.js` (or an `cli/evidence.js` section) with `validateEvidencePlanCatalog`/`getEvidencePlan`/`fulfillEvidenceOrder` bound to the evidence ENTITLEMENTS; NEW `cli/core/fixtures/evidence-plans/baseline.json` (a DRAFT/SAMPLE catalog); NEW `test/cli.evidence.plans.test.js` (assert at the function level: a valid catalog validates + freezes + sorts; an unknown entitlement flag → hard reject naming the flag; a duplicate planId → hard reject; wrong `kind` → reject; `fulfillEvidenceOrder` is deterministic — same order+catalog ⇒ byte-identical params; `paidThrough` wins over `termDays`; `paidThrough <= issuedAt` → reject; a missing/blank customer → reject; a non-canonical `issuedAt` → reject; the output params round-trip through `buildLicense` and `verifyLicense` ACCEPTS the resulting license for the granted entitlements; no mutation of the frozen catalog; no network handle opened).
  - Acceptance: the evidence vertical exposes a strictly-validated evidence plan catalog (`kind="vh-evidence-plan-catalog"`, closed over `{evidence_signed, evidence_unlimited}` — unknown flag / duplicate planId = hard error) + a PURE deterministic `fulfillEvidenceOrder(order, catalog)` returning the exact `buildLicense` params, with a BUNDLED DRAFT catalog fixture; the output round-trips through `buildLicense`/`verifyLicense`; it is OFFLINE/clock-free/key-free, mutates no input; the function-level test is green; NO change to any existing evidence verdict/exit code; NO price is set (the fixture is an explicit DRAFT); NO new `needs-human` item; NO change to P-3/P-5/P-6/P-7/P-8. `npx hardhat test` green.

- **T-48.2** ✅ VERIFIED Ship `vh evidence license fulfill --plan <planId> --customer <name> [--paid-through <ISO> | (catalog term)] [--issued-at <ISO>] [--catalog <file>] (--key-env <VAR> | --key-file <p>) [--out <p>] [--json]` — read a human-provisioned evidence vendor key (read-used-discarded), resolve the plan, and MINT the signed `*.vhevidence-license.json` the evidence gate accepts. MIRRORS `vh trust license fulfill`. deps: T-48.1.
  - Add a `license` subcommand group to `cli/evidence.js` with a `fulfill` action (and update the `unknown evidence subcommand … (expected: seal, verify, verify-signed, diff)` list → `seal, verify, verify-signed, license, diff`), and add the `vh evidence license fulfill …` usage to `cli/vh.js`. It: parses the flags (EXACTLY ONE of `--key-env`/`--key-file` — both or neither is a usage error, parser parity with `vh trust license fulfill`/`vh dataset sign`); loads + strictly validates the plan catalog (the BUNDLED evidence DRAFT catalog by default, or `--catalog <file>`; a malformed/unreadable catalog is a USAGE error, not an IO crash); reads the human-supplied vendor key the EXACT read-used-discarded way the other key-reading commands do (the loop NEVER holds it); runs `fulfillEvidenceOrder` → `buildLicense(params, signer)` to mint the SAME signed evidence-license container the existing `verifyLicense` gate accepts; prints/writes it (`--out`/`--json`). `--issued-at` lets a caller pass the canonical ISO instant so the command stays deterministic/testable with ephemeral keys (mirror however the TrustLedger fulfill handles the clock — keep the module pure; the CLI layer supplies the instant). Exit contract MIRRORS the family: 0 ok / 3 fulfill/build error / 2 usage / 1 IO.
  - files: EDIT `cli/evidence.js` (parse the `license fulfill` flags; dispatch `license`→`fulfill` in `cmdEvidence`; update the unknown-subcommand list; mint via `fulfillEvidenceOrder` + `buildLicense`; read the key read-used-discarded; print/`--json`/`--out`); EDIT `cli/vh.js` (add the `vh evidence license fulfill …` usage line); NEW `test/cli.evidence.license.fulfill.test.js` (drive the CLI with an EPHEMERAL `Wallet.createRandom()` key via `--key-env`: a valid `--plan`/`--customer`/`--paid-through` mints a signed license that `verifyLicense` ACCEPTS for the plan's entitlements and `vh evidence seal --sign --license <minted> --vendor <ephemeralAddr>` then UNLOCKS the paid surface; an unknown `--plan` → exit 3 naming known plans; both `--key-env` and `--key-file` → exit 2; neither → exit 2; a `--paid-through` not after issuedAt → exit 3; a malformed `--catalog` → exit 2; the key is never persisted; determinism — same inputs+key+issuedAt ⇒ byte-identical license; no network handle opened).
  - Acceptance: `vh evidence license fulfill` reads a human-provisioned vendor key read-used-discarded, resolves a plan against the bundled-or-`--catalog` validated catalog, and mints the signed evidence license the existing `verifyLicense` gate ACCEPTS (proved end-to-end: the minted license unlocks `vh evidence seal --sign`); EXACTLY-ONE-of-key-source is enforced; exit 0/3/2/1 mirrors the family; the loop NEVER holds a real key (ephemeral test keys only) and NEVER sets a price; the existing seal/verify/verify-signed/diff behavior + exit codes are UNCHANGED; NO new `needs-human` item; NO change to P-3/P-5/P-6/P-7/P-8. `npx hardhat test` green.

- **T-48.3** VERIFIED Document `vh evidence license fulfill` + the evidence plan catalog in `docs/EVIDENCE.md` as the seller's "issue a license per sale" step — the self-serve fulfillment seam a billing webhook drives — and SHARPEN STRATEGY.md P-7 step 2 to point at it. deps: T-48.2.
  - Add the `license fulfill` line to the Commands block and a section ("Issuing a license — `vh evidence license fulfill`") explaining: the evidence PAID surface (`--sign`, sealing > the free sample size) is gated by a signed `vh-evidence-license`; to ISSUE one, fill in YOUR price/term per `planId` in the plan catalog (a validated DRAFT data file — link the bundled fixture + the closed `{evidence_signed, evidence_unlimited}` table), then run `vh evidence license fulfill --plan <id> --customer <name> --paid-through <ISO> --key-env <VAR>` (or point your billing provider's "payment succeeded / renewed" webhook at it) to mint the signed license the customer's `vh evidence seal … --license <f> --vendor <addr>` then accepts. State the REVENUE-INTEGRITY boundary verbatim: the license is an ACCESS credential for delivered software value — NOT a token/coin/NFT, NOT tradeable, NOT an appreciating asset; income is a subscription/meter/license, never resale of a credential; the loop ships ONLY the mechanism + ephemeral test keys and sets NO price / holds NO real key / runs NO payment processor. Keep the standing evidence trust-boundary note (tamper-evidence + offline-recompute, signer-vouch-NOT-timestamp / P-3) verbatim. In STRATEGY.md, append a one-line SHARPENING to P-7 step 2 noting the fulfillment command now collapses per-sale human work to "fill in the catalog price/term + point your webhook at `vh evidence license fulfill`" (mirroring the EPIC-37 SHARPEN of P-6 step 3) — NO new human gate, NO change to P-7 step 1/3 or the other proposals.
  - files: `docs/EVIDENCE.md` (add the `license fulfill` command line + the issuance section + the plan-catalog reference; keep the trust-boundary + revenue-integrity notes verbatim); EDIT `STRATEGY.md` P-7 step 2 (a one-line SHARPENING pointer to `vh evidence license fulfill`, mirroring P-6 step 3's EPIC-37 update); a docs-rot test (NEW `test/cli.evidence.license.docs.test.js` or EDIT an existing evidence docs test — assert the doc names `vh evidence license fulfill`, references the plan catalog + closed entitlement table, states the issuance flow + the EXACTLY-ONE-of-key-source rule, and restates the revenue-integrity (access-credential-NOT-token) + signer-vouch-NOT-timestamp / P-3 caveats verbatim).
  - Acceptance: `docs/EVIDENCE.md` documents `vh evidence license fulfill` + the evidence plan catalog (issuance flow, catalog as a DRAFT the human prices, the closed entitlement table, the key-source rule) with the revenue-integrity + trust-boundary caveats verbatim; STRATEGY.md P-7 step 2 carries a one-line SHARPENING pointing at the fulfillment command (NO new human gate); a doc test pins all of it; NO new `needs-human` item; NO change to P-3/P-4/P-5/P-6/P-8. `npx hardhat test` green.

## EPIC-49 — The PRODUCER IDENTITY CARD: a signed, offline-verifiable "who produced this, and what does this tool claim / NOT claim" manifest a recipient or cold prospect can PIN with no out-of-band step  *(MATERIAL CHANGE OF APPROACH — the producer/recipient/fulfillment MECHANISM is saturated on BOTH verticals (TrustLedger AND evidence), avgUsefulness has oscillated 3.25–4.0 with NO upward trend for ~20 runs, and humanGated has STOOD at 3 — a textbook quality-plateau-over-a-value-ceiling. The directive forbids more same-vein "next leg" mirrors (EPIC-46/47/48 were all that vein) and requires a higher-leverage capability that DE-RISKS the dam (P-7/P-8 adoption). The real, unaddressed UNGATED hole: every sealed/signed artifact pins the producer by a vendor ADDRESS the recipient must learn OUT OF BAND — there is NO shipped, testable way for a producer to PUBLISH a self-describing, signed identity manifest binding {vendor address, product line, the EXACT bounded claims this tool makes and the non-claims it does NOT make} that a recipient or a COLD PROSPECT can verify offline and pin. This is a NEW cross-cutting capability (not a per-vertical mirror), reuses `cli/core/attestation.js` (`buildSignedAttestation`/`verifySignedAttestation`/`recoverSigner` + a new `cfg.serializeUnsigned`) VERBATIM — NO new crypto — and directly removes a real adoption blocker: a prospect can confirm "this packet's signer really is the entity who published these claims, and here is exactly what they do/don't attest" before any sales call. See STRATEGY.md "## Direction" 2026-06-26.)*

- **T-49.1** `VERIFIED` Add a PURE producer-identity core: a new `cfg` over `cli/core/attestation.js` (`IDENTITY_CARD_KIND="vh-identity-card"`, its own `serializeUnsigned` over a CLOSED, validated field set + its own error class — MIRROR the evidence/dataset cfgs exactly), plus `buildIdentityCard(fields, signer)` (signs the canonical unsigned bytes with a provided in-process Wallet — NEVER generates/holds a key) and a PURE `verifyIdentityCard(container, { expectedSigner })` that recovers the signer (full EIP-191 `verifyMessage` via `coreAttestation.verifySignedAttestation`) + checks claimed-vs-recovered + optional `expectedSigner` pin and returns the SAME verdict shape the sibling verifiers return (recovered/claimed/expected signer + per-check booleans + ACCEPTED/REJECTED). The card's CLOSED field set is data-only and self-describing: `{ vendorAddress, productLine (one of the shipped verticals: trustledger|evidence|dataset|parcel), claims[] (the bounded "this tool DOES attest …"), nonClaims[] (the honest "this tool does NOT attest …", e.g. "NOT a timestamp without P-3", "NOT legal/accounting advice", "compares CLAIMS not re-derived bytes"), publishedAt (ISO) }` — an unknown field, a missing required field, a productLine outside the closed set, or an empty claims/nonClaims list is a HARD validation error (never a silent partial card). The recovered signer MUST equal `vendorAddress` or `verifyIdentityCard` REJECTS (a card cannot claim a vendorAddress it was not signed by). deps: `cli/core/attestation.js` (shipped & green); the dataset/evidence signed-cfg pattern (shipped & green).
  - files: NEW `cli/identity.js` (the cfg + `buildIdentityCard`/`verifyIdentityCard`, no I/O, no key handling beyond a passed-in Wallet); NEW `test/cli.identity.test.js` (round-trip with an EPHEMERAL `Wallet.createRandom()`: build → verify ACCEPT; tamper the embedded claims/nonClaims/vendorAddress/productLine each → REJECT naming the failing check; a card whose `vendorAddress` ≠ the recovering signer → REJECT; an unknown/missing field or out-of-set productLine or empty claims/nonClaims → HARD validation error; `--signer` pin to the WRONG address → REJECT; NEVER a false ACCEPT).
  - Acceptance: `buildIdentityCard` produces a signed `vh-identity-card` container over the canonical field set (ephemeral test key only); `verifyIdentityCard` recovers + pins the signer, enforces recovered===vendorAddress, supports `expectedSigner`, returns the family verdict shape; the closed-field/closed-productLine/non-empty-claims validation HARD-errors on violation; every tamper REJECTs and localizes; no new crypto/dependency; `npx hardhat test` green.

- **T-49.2** `VERIFIED` Ship `vh identity publish` (mint the card) + `vh identity verify` (check + pin it). `vh identity publish --product <line> --address <vendorAddr> --claims-file <f> [--published-at <ISO>] (--key-env <VAR> | --key-file <p>) [--out <p>] [--json]` reads a human-provisioned vendor key (read-used-discarded, EXACTLY-ONE-of key source or hard-error naming only the SOURCE), asserts the key's address EQUALS `--address` (refuse to mint a card for a key you don't hold — hard error before any signing), and writes the signed `*.vh-identity-card.json`. `vh identity verify <card> [--signer <addr>] [--json]` runs `verifyIdentityCard`, LEADS with the trust line ("ACCEPTED means this card was signed by the address it names AND lists exactly these bounded claims/non-claims; it does NOT independently attest those claims are true of any specific packet — verify each packet with its own `verify`/`verify-signed`/`verify-seal`"), prints recovered/claimed/expected signer + each claim + each non-claim + per-check OK/FAIL, and exits on the shared 0/3/2/1 contract (0 ACCEPT, 3 REJECT, 2 usage, 1 unexpected) MIRRORING `vh evidence verify-signed`. Wire both into `cli/vh.js` dispatch (a new top-level `identity` subcommand with `publish`/`verify`, and an `unknown identity subcommand (expected: publish, verify)` reject mirroring `cmdEvidence`). deps: T-49.1.
  - files: EDIT `cli/identity.js` (add `runIdentityPublish`/`runIdentityVerify` CLI wrappers — fs read/write, key-source rule, the address===key assertion, exit-code mapping); EDIT `cli/vh.js` (dispatch the `identity` subcommand + usage/help line); NEW `test/cli.identity.cli.test.js` (publish with an EPHEMERAL key → a card file; the address-mismatch refusal (key addr ≠ `--address`) before any write; neither/both/missing/malformed key source each hard-error naming only the SOURCE; `verify` ACCEPT (exit 0) on a clean card, REJECT (exit 3) on a tampered one and on a `--signer` pin to the wrong address, usage (exit 2) on a missing arg; `--json` shape; the trust line is present in human output).
  - Acceptance: `vh identity publish` mints a signed card ONLY when the provisioned key's address equals `--address` (else hard-errors before writing), with the EXACTLY-ONE-of-key-source rule; `vh identity verify` ACCEPT/REJECT/usage exits map 0/3/2/1, leads with the trust line, prints the claims/non-claims + per-check results, and pins `--signer`; dispatch rejects unknown `identity` subcommands; the loop NEVER generates/persists/logs a key; `npx hardhat test` green.

- **T-49.3** `VERIFIED` Document the producer identity card as the recipient's / cold prospect's "who is this vendor and what exactly do they attest?" pin-point, and SHARPEN P-7 step 1 to point at it. Add a `docs/IDENTITY.md` (or a section in an existing recipient-facing doc) explaining: a producer publishes ONE signed identity card (per product line) binding their vendor address to the bounded claims/non-claims; a recipient runs `vh identity verify --signer <publishedAddr>` ONCE to pin the vendor, then trusts that address across every subsequent `evidence verify-signed` / `trust verify-seal` / `dataset verify-attest` hand-off — closing the out-of-band-trust gap (you no longer have to take "the vendor address is 0x…" on faith from an email). State the trust BOUNDARY verbatim: the card attests the vendor's IDENTITY + the bounded claim SET, NOT that any specific packet is true (each packet is still verified on its own) and NOT a timestamp/legal claim (P-3 / the per-vertical non-claims still hold). In STRATEGY.md, append a one-line SHARPENING to P-7 step 1 (and a parallel pointer in P-6 step 1) noting that once the vendor key is provisioned, `vh identity publish` is the ONE command that turns the published-address step into a self-verifiable artifact a prospect can check — NO new human gate, NO change to P-7 step 2/3 or any other proposal. deps: T-49.2.
  - files: NEW `docs/IDENTITY.md` (the pin-once / trust-across-handoffs flow + the claims/non-claims boundary verbatim) and/or EDIT a recipient-facing doc to cross-link it; EDIT `STRATEGY.md` P-7 step 1 + P-6 step 1 (one-line SHARPENING pointers to `vh identity publish`); NEW `test/cli.identity.docs.test.js` (docs-rot: assert the doc names `vh identity publish`/`verify`, describes the pin-once-then-trust-across-handoffs flow, states the card-attests-IDENTITY-NOT-packet-truth + NOT-timestamp/legal boundary verbatim, and that STRATEGY P-7 step 1 points at `vh identity publish`).
  - Acceptance: `docs/IDENTITY.md` documents the identity-card publish/verify flow + the pin-once-trust-across-handoffs model + the IDENTITY-not-packet-truth / not-timestamp-or-legal boundary verbatim; STRATEGY.md P-7 step 1 (and P-6 step 1) carry a one-line SHARPENING pointer to `vh identity publish` (NO new human gate); a docs-rot test pins all of it; NO new `needs-human` item; NO change to P-3/P-4/P-5/P-8. `npx hardhat test` green.

## EPIC-50 — The COLD-PROSPECT CHALLENGE: a committed, zero-install, no-repo "verify a real sealed packet, then tamper any byte yourself and watch it get caught" bundle a stranger can run in 30 seconds with zero trust in us  *(STAY on the adoption-dam pivot EPIC-49 opened — but the PUBLIC TOP-OF-FUNNEL artifact, not more producer-side mechanism. The existing pilot kit (`pilot/run-pilot.js`) proves seal→tamper→reject to an OPERATOR who already has the repo + node + decided to run a pilot; there is NO artifact that proves the core claim to a COLD PROSPECT with no repo, no install, and no trust in us — the single thing that converts a stranger from "interesting claim" to "I just watched it catch my own tamper." This is the organic, NO-human-gate funnel artifact the family's whole free→paid theory (P-7/P-8) depends on, and it reuses the ALREADY-SHIPPED zero-install standalone verifier (`verifier/dist/verify-vh-standalone.js`) + a committed sealed sample — NO new mechanism, NO new crypto. See STRATEGY.md "## Direction" 2026-06-26.)*

- **T-50.1** `VERIFIED` Build a committed CHALLENGE bundle directory (`challenge/`) containing: (a) the already-shipped zero-install standalone verifier copied/symlinked or referenced by a tested integrity check (its committed `.sha256` already exists), (b) a small committed SEALED sample packet (an evidence `*.vhevidence.json` + its sibling files) produced by the real `vh evidence seal` over a committed sample folder, and (c) a single `challenge/run.sh` (POSIX, no npm install) that runs `node verify-vh-standalone.js <packet>` and prints ACCEPT, then a guided `challenge/TAMPER-ME.md` telling the stranger to edit ANY byte of any sealed file and re-run to watch it REJECT + localize. A NEW `test/challenge.test.js` drives the REAL standalone verifier over the committed sample (ACCEPT, exit 0), then tampers one byte programmatically and asserts REJECT (exit 3) + the changed file is localized — so the challenge can NEVER rot into a false ACCEPT. deps: EPIC-30 (`vh evidence seal`, shipped & green); EPIC-35 (the zero-install standalone verifier + its committed `.sha256`, shipped & green).
  - files: NEW `challenge/` (the sealed sample packet + sample folder + `run.sh` + `TAMPER-ME.md`; reference the committed standalone verifier, do NOT fork its logic); NEW `test/challenge.test.js` (build/refresh the sample via the REAL seal path or assert the committed sample verifies; run the REAL standalone verifier → ACCEPT exit 0; tamper one byte → REJECT exit 3 + localizes; the sample is re-derivable / not hand-faked).
  - Acceptance: the committed challenge bundle's sealed sample VERIFIES with the zero-install standalone verifier (exit 0); a one-byte tamper makes it REJECT (exit 3) and localizes the changed file, proven by a test that drives the REAL verifier (never a false ACCEPT); `run.sh`/`TAMPER-ME.md` require NO npm install and NO repo build; no new crypto/dependency; `npx hardhat test` green.

- **T-50.2** `VERIFIED` Document the challenge as the cold-prospect entry point: a `challenge/README.md` (and a cross-link from the top-level README + `docs/INDEPENDENT-VERIFICATION.md`) framing it as "don't take our word — verify a real sealed artifact, then break it yourself in 30 seconds, with zero install and zero trust in us," state the honest BOUNDARY verbatim (tamper-evidence + offline-recompute; signer-pin NOT a trusted timestamp without P-3; the challenge proves the VERIFY claim, the paid surface is PRODUCING seals), and point the reader at the paid `seal --sign` / license fulfillment surface as the next step. A docs-rot test asserts the README names the standalone verifier + `TAMPER-ME.md`, states the zero-install / zero-trust framing, restates the tamper-evidence / NOT-timestamp boundary verbatim, and points free→paid. deps: T-50.1.
  - files: NEW `challenge/README.md`; EDIT top-level `README.md` + `docs/INDEPENDENT-VERIFICATION.md` (one cross-link each to the challenge); NEW `test/challenge.docs.test.js` (docs-rot per the acceptance).
  - Acceptance: `challenge/README.md` frames the zero-install / zero-trust cold-prospect flow, restates the tamper-evidence / signer-pin-NOT-timestamp boundary verbatim, and points free-verify → paid-produce; the top-level README + `docs/INDEPENDENT-VERIFICATION.md` cross-link it; a docs-rot test pins all of it; NO new `needs-human` item; NO change to any proposal. `npx hardhat test` green.

## EPIC-51 — KEY LIFECYCLE: signed producer REVOCATION + a recipient-side TRUST-DECISION-AS-OF a point in time — close the "every artifact a compromised/rotated key ever signed verifies as ACCEPTED forever" hole that makes the PAID signed surface unsellable to a serious forensics/e-discovery buyer  *(MATERIAL CHANGE OF DIRECTION — STOP adding producer/recipient/fulfillment MECHANISM LEGS (the saturated vein behind ~21 runs of flat avgUsefulness ~3.25–4.0 with humanGated standing at 3). EPIC-46/47/48/49/50 were all the same shape: find a missing leg of an existing product, mirror a sibling. This EPIC adds DEPTH, not breadth: a genuinely NEW cross-cutting TRUST PRIMITIVE every signed surface (dataset/parcel/evidence/identity) consumes, not a per-vertical mirror. CONFIRMED in the live product: `grep -rilE "revoc|revoke|rotat|supersede" cli/ trustledger/ verifier/ contracts/` returns ZERO key-lifecycle code (the few hits are license-EXPIRY, an unrelated entitlement clock); the identity card (EPIC-49) carries `publishedAt` but NO `notBefore`/`notAfter` and there is NO way to mark a vendor key, identity card, or signed artifact as revoked/superseded. So today: if a vendor's signing key is compromised, leaves with a contractor, or is rotated, EVERY artifact it EVER signed — every signed evidence packet, every signed dataset/parcel attestation, every identity card — continues to verify as ACCEPTED with no recipient-side way to express "this key was revoked as of date D" or to ask "was this key trustworthy AS OF the time this exhibit was sealed?". For the buyer P-7 actually names (incident-response / digital-forensics / e-discovery / audit-workpaper), that is not a missing convenience — it is the FIRST objection raised in any procurement: "what happens when a key is compromised, and can I prove an exhibit was signed while the key was still good?" A signed-evidence product with no key-lifecycle / revocation story is unsellable to that buyer — the SAME class of "silent false trust" the EPIC-39..42 / EPIC-47 runs correctly treated as the highest-value work, now at the trust-ROOT layer instead of a per-packet check. This DIRECTLY de-risks P-7 (the lighter-gated revenue path the loop chose) by closing the one objection that buyer raises immediately, and it reuses `cli/core/attestation.js` (`buildSignedAttestation`/`signAttestation`/`verifySignedAttestation`/`recoverSigner`/`loadSigningWallet`) VERBATIM — NO new crypto, exactly as EPIC-49 did. STRICTLY ADDITIVE + the strongest possible NON-LOOSENING invariant: with NO revocation file supplied, EVERY existing verify command behaves byte-for-byte as today (same verdict, same exit code); a revocation can ONLY turn an ACCEPTED into a REVOKED/REJECTED, never the reverse — so the change can only ADD a failing/cautioning verdict where today there is a silent over-trust. The income step is unchanged + still human: this makes the PAID signed surface TRUSTWORTHY enough to sell to the forensics buyer; it sets no price, holds no key, contacts no one. See STRATEGY.md "## Direction" 2026-06-26.)*

- **T-51.1** `VERIFIED` Build the PURE core revocation statement as a new attestation `cfg` over `cli/core/attestation.js`, mirroring the EPIC-49 identity-card pattern EXACTLY (its own KIND + closed, self-describing field set; `buildRevocation`/`verifyRevocation` reuse `signAttestation`/`verifySignedAttestation`/`recoverSigner` VERBATIM, NO new crypto). The revocation payload binds `{vendorAddress (the key being revoked — must EQUAL the recovered signer, the same self-control invariant the identity card enforces), revokedAt (canonical ISO instant), reason (a bounded non-empty string from a small closed set, e.g. compromised|rotated|retired|superseded), optional supersededBy (a lowercase-0x address of the replacement key), note}`. `verifyRevocation` REJECTS (never half-accepts) a forged/tampered/wrong-signer statement and — the load-bearing check — REQUIRES the recovered signer to BE the `vendorAddress` it revokes (a key revokes ITSELF; a third party cannot revoke a key it does not control). A signed `*.vhrevocation.json` container is the portable artifact. deps: EPIC-49 (the `attestation.js` cfg pattern + `loadSigningWallet`, shipped & green).
  - files: NEW `cli/core/revocation.js` (the cfg + `buildRevocation`/`verifyRevocation`/`readRevocation` + `RevocationError`; reuse `core/attestation.js` verbatim — do NOT fork the signing/recovery path); NEW `test/core.revocation.test.js`.
  - Acceptance: a revocation built+signed by a key round-trips through `verifyRevocation` (ACCEPTED, recovered signer == revoked vendorAddress); a third-party signature over someone else's vendorAddress is REJECTED (self-control invariant); a one-byte tamper of payload/signature is REJECTED; unknown/extraneous field, out-of-set reason, non-canonical `revokedAt`, malformed address all HARD-error (named + localized); `supersededBy` optional and, when present, a valid lowercase-0x; NO new crypto/dependency; `npx hardhat test` green.
- **T-51.2** `VERIFIED` Add a recipient-side TRUST-DECISION-AS-OF helper as a PURE core function `evaluateTrustAsOf({recoveredSigner, sealedAt, revocations[], asOf})` and wire it into the EXISTING signed-verify paths (`vh evidence verify-signed`, `vh dataset verify-attest`, `vh parcel verify-attest`, `vh identity verify`) behind a NEW, strictly-OPTIONAL `--revocations <file-or-dir>` (one or many `*.vhrevocation.json`) and an OPTIONAL `--as-of <ISO>` (default: the artifact's own `sealedAt`/`publishedAt` if present, else "now"). Each loaded revocation is itself `verifyRevocation`'d FIRST — a forged/invalid revocation is IGNORED with a printed warning, never trusted to downgrade a verdict. The decision: if a VALID revocation for the recovered signer exists with `revokedAt <= asOf`, the verdict becomes REVOKED (exit 3) and names the revocation reason + `revokedAt` + any `supersededBy`; if the only revocations are `revokedAt > asOf`, print an informational "this signer was later revoked as of D (after this artifact's as-of T)" but KEEP the underlying ACCEPTED verdict (the exhibit WAS signed while the key was good — the precise forensic value). NON-LOOSENING INVARIANT (pin with a test): with NO `--revocations` supplied, every command's verdict + exit code are byte-for-byte identical to today. deps: T-51.1.
  - files: NEW `cli/core/trust-asof.js` (`evaluateTrustAsOf`, pure, deterministic, clock-injectable); EDIT `cli/evidence.js`, `cli/dataset.js`, `cli/parcel.js`, `cli/identity.js` (thin `--revocations`/`--as-of` wiring + the REVOKED/later-revoked render — reuse the shared helper, do NOT duplicate the decision logic); NEW `test/core.trust-asof.test.js` + per-command verify tests; EDIT existing verify tests ONLY to add the no-flag identical-behavior assertion.
  - Acceptance: a signed artifact whose signer is revoked-before-as-of verifies REVOKED (exit 3) naming reason + `revokedAt` (+ `supersededBy` if set); the SAME artifact with a revocation dated AFTER its as-of stays ACCEPTED (exit 0) with an informational later-revoked note; a forged/invalid revocation file is IGNORED with a warning and never downgrades the verdict; with NO `--revocations` flag, all four verify commands produce byte-identical verdict + exit code to the pre-EPIC baseline (regression-pinned); `--as-of` is honored and defaults sanely; offline, key-free on the read side; `npx hardhat test` green.
- **T-51.3** `VERIFIED` Ship `vh revocation publish` (mint a signed `*.vhrevocation.json` with a HUMAN-provisioned key, read-used-discarded via the shared `loadSigningWallet`; mint ONLY when the key controls the `--address` being revoked; default PRINTS + writes nothing, `--out` writes to a caller-chosen path) and `vh revocation verify <file> [--signer <addr>]` (offline/key-free read; ACCEPT/REJECT 0/3/2/1 mirroring the family), and DOCUMENT the key-lifecycle story end to end in a NEW `docs/KEY-LIFECYCLE.md`: how a producer revokes/rotates a key, how a recipient pins `--revocations` in their verify/CI step, and the honest BOUNDARY (revocation is a SIGNED CLAIM by the key-holder — it proves the key-holder SAID "revoked as of D"; it is NOT a trusted wall-clock timestamp without P-3, so `--as-of` is recipient-chosen evidence, not an oracle). SHARPEN P-7 step 1 with a one-line pointer (publish a revocation if the evidence vendor key is ever compromised/rotated) — NO new `needs-human` item, NO change to P-3/P-4/P-5/P-6/P-8. A docs-rot test pins the boundary language + the free-verify/paid-produce framing. deps: T-51.1, T-51.2.
  - files: NEW `cli/revocation.js` (the `cmdRevocation` thin I/O shell — parse argv, read/write, render; all crypto in the core); EDIT `cli/vh.js` (register the `revocation` top-level command + usage); NEW `docs/KEY-LIFECYCLE.md`; EDIT `README.md` (one-line command surface entry + cross-link), `docs/EVIDENCE.md` (recipient `--revocations` step), STRATEGY.md P-7 step 1 (one-line pointer); NEW `test/cli.revocation.test.js` + `test/cli.revocation.docs.test.js`.
  - Acceptance: `vh revocation publish --address <a> --reason rotated (--key-env|--key-file) [--out]` mints a signed revocation ONLY when the provisioned key controls `--address` (else a clean USAGE/REJECT, never a mis-minted statement), default prints + writes nothing; `vh revocation verify` ACCEPT/REJECT/usage exits 0/3/2/1; `docs/KEY-LIFECYCLE.md` documents publish→pin→verify and the "signed claim, NOT a trusted timestamp without P-3" boundary verbatim; a docs-rot test pins it; P-7 step 1 gains a one-line revocation pointer; NO new `needs-human` item; NO change to P-3/P-4/P-5/P-6/P-8; `npx hardhat test` green.
- **T-51.4** `VERIFIED` **(verifier parity — the headline gap T-51.2/T-51.3 left behind.)** Bring `--revocations <file-or-dir> [--as-of <ISO>]` to the **independent** verifier — `verifier/verify-vh.js` + the rebuilt `verifier/dist/verify-vh-standalone.js` — so the OFFLINE, no-producer-stack path reaches the SAME revoked-before-as-of downgrade the producer stack (`vh ... verify-signed --revocations`) already does. Today the independent verifier has **zero** revocation awareness (the words revocation/revoke/as-of appear 0 times in the whole `verifier/` tree and 0 times in the standalone bundle), so a counterparty who relies ONLY on `verify-vh` gets a clean ACCEPTED (exit 0) on an artifact signed by a key the producer has PUBLICLY, CRYPTOGRAPHICALLY revoked — the OPPOSITE verdict the producer's own `verify-signed --revocations ... --as-of T` returns (REVOKED, exit 3) on identical inputs. That divergence on the single most safety-critical case (a revoked/compromised key) materially weakens the family's headline "you do NOT have to trust the producer." The work: (a) a stack-free EIP-191 revocation reader/verifier inside `verifier/lib/` reusing the vendored secp256k1 recovery already there (so it stays `js-sha3`-only — **explicitly NO ethers/hardhat**, preserving the `verifier.isolation.test.js` no-back-edge guarantee); (b) the SAME non-loosening as-of comparison `cli/core/trust-asof.js` enforces (with NO `--revocations` supplied, every `verify-vh` verdict + exit code stays byte-for-byte identical to today; a revocation can ONLY turn ACCEPTED into REVOKED, never the reverse; a forged/tampered/third-party revocation is IGNORED with a warning, never trusted to downgrade); (c) rebuild the standalone bundle deterministically (so `verifier.standalone.test.js` stays green) and add a test asserting the independent path and the producer stack now return the SAME verdict on a revoked key. Then DELETE the "NOT revocation-aware" caveat from `docs/INDEPENDENT-VERIFICATION.md` §3 + `verifier/README.md` §4 (it becomes obsolete). deps: T-51.1, T-51.2, T-51.3. **No revenue/legal/human step — pure offline parity work the loop can build.**
  - files: NEW `verifier/lib/revocation.js` (the stack-free revocation reader + EIP-191 verify + as-of decision, reusing `lib/secp256k1`/`lib/keccak` — NO ethers); EDIT `verifier/verify-vh.js` (thin `--revocations`/`--as-of` wiring + the REVOKED render + aggregate/manifest plumbing); REBUILD `verifier/dist/verify-vh-standalone.js` via `verifier/build-standalone.js`; NEW `test/verifier.revocation.test.js` (parity with the producer stack on a revoked key; non-loosening with no flag); EDIT `docs/INDEPENDENT-VERIFICATION.md` + `verifier/README.md` (remove the now-closed caveat, document the new flag); EDIT the relevant docs-rot test.
  - Acceptance: `verify-vh <signed-artifact> --vendor <addr> --revocations <f> --as-of <T>` returns REVOKED (exit 3) for a key revoked-before-as-of, matching `vh ... verify-signed --revocations` byte-for-byte in verdict + exit code on identical inputs; the SAME artifact with a revocation dated AFTER `--as-of` stays ACCEPTED (exit 0) with a later-revoked note; a forged/third-party revocation is IGNORED with a warning; with NO `--revocations`, every existing `verify-vh` verdict + exit code is byte-identical to today (regression-pinned); `verifier.isolation.test.js` still proves NO ethers/hardhat/back-edge and NO network; the standalone bundle is rebuilt + `verifier.standalone.test.js` green; `npx hardhat test` green.

## EPIC-52 — THE ADVERSARIAL CONFORMANCE CORPUS: a committed, versioned, self-auditing red-team kit — one poisoned artifact per known tamper class, with a runner that FAILS LOUD if ANY shipped verifier ever returns ACCEPT on a poisoned input — so a skeptical forensics/e-discovery/audit buyer can answer "how do I know your verifier has no holes?" by running it themselves  *(MATERIAL CHANGE OF DIRECTION — STOP mirroring the next producer/recipient/fulfillment MECHANISM LEG (the saturated vein behind ~22 runs of flat avgUsefulness ~3.25–4.0, with a `minUsefulness=2` MIN-OUTLIER in runs 21 AND 26 and `humanGated` standing at 3–5). EPIC-46..51 were the SAME shape: find a missing leg of an existing signed-attestation vertical and add a sibling command (diff, verify-signed, license fulfill, identity card, cold-prospect challenge, revocation). The producer/recipient mechanism is now SATURATED across THREE verticals — there is no high-value "next leg" left to mirror. This EPIC is categorically different: it is NOT a new product surface, NOT a new verb, NOT new crypto, and adds NO new verifier logic. It is a cross-cutting ASSURANCE artifact that CONSUMES the EXISTING verifiers (dataset/parcel verify-attest, evidence verify/verify-signed, TrustLedger verify-seal, identity verify, revocation verify, and the independent `verify-vh`/standalone) and proves, mechanically and to a stranger, that EVERY ONE of them REJECTS EVERY known attack. CONFIRMED in the live product: `grep -rilE "adversar|fuzz|conformance|attack.?vector|tamper.?corpus|must.?reject"` over cli/ trustledger/ verifier/ returns ZERO adversarial-corpus code (the lone hit is an unrelated comment in trustledger/seal.js). The `challenge/` cold-prospect demo (EPIC-50) proves exactly ONE tamper class — a single byte-edit of one file in one evidence packet — and nothing systematically enumerates the attack surface or asserts the OTHER verifiers catch the OTHER classes. WHY THIS IS THE HIGHER-LEVERAGE WORK when both the quality-plateau and the standing value-ceiling fire: the #1 procurement objection a forensics/e-discovery/audit-workpaper buyer (the P-7 buyer the loop chose) raises is NOT "do you have feature X" — it is "how do I know your verifier won't say ACCEPT on something it shouldn't? what's your false-accept surface?" Today the only answer is "trust our internal test suite." A COMMITTED, BUYER-RUNNABLE conformance corpus — "here are N known attacks, one per class; watch every shipped verifier catch every one; now mutate any byte yourself and watch it caught too" — is a categorically stronger TRUST artifact than another command, and it raises the trust FLOOR of the WHOLE family at once (the same "silent false trust is the highest-value class to close" insight EPIC-39..42/47 acted on, now as a shippable buyer-facing red-team kit instead of internal-only tests). It DIRECTLY de-risks P-8 (land ONE design partner / run the pilot): the partner's first technical question is answered by an artifact they run in 60 seconds with zero trust in us, and a self-auditing corpus is also a permanent REGRESSION FLOOR — if any future refactor ever introduces a false-ACCEPT hole in any verifier, the corpus runner goes RED in CI. STRICTLY ADDITIVE + NON-REGRESSING: it adds NO production code path, changes NO verdict/exit-code of any existing command, holds no key (poisoned fixtures are minted from the clean originals + EPHEMERAL `Wallet.createRandom()` test keys), opens no network, adds no dependency. The income step is unchanged + still human: this makes the verifiers' no-false-ACCEPT property PROVABLE to a buyer; it sets no price, contacts no one. See STRATEGY.md "## Direction" 2026-06-26.)*

- **T-52.1** `VERIFIED` Build the **versioned tamper-class taxonomy + the poisoned-corpus GENERATOR** (`challenge/corpus/` + `challenge/corpus/generate.js`). Enumerate the family's known attack surface as a CLOSED, documented set of TAMPER CLASSES, each a single named, reproducible mutation of a CLEAN sealed artifact: (1) content byte-edit (flip one byte of a sealed file — Merkle root no longer re-derives); (2) file add (an extra file not in the manifest); (3) file remove (a manifested file deleted); (4) file rename / path-swap (same bytes, wrong path — the leaf binds the path); (5) seal-internal hash edit (rewrite a stored leaf/root hash in the seal to "match" tampered bytes — the re-derive-don't-trust invariant must still catch it); (6) signature corruption (flip a byte of the detached signature on a signed artifact); (7) signer substitution (re-sign with a DIFFERENT ephemeral key, so the recovered signer ≠ the pinned vendor address); (8) attestation-payload edit (edit a field inside a signed attestation so the canonical bytes no longer match the signature); (9) cross-artifact splice (a valid signature/seal from artifact A pasted onto artifact B). Each class is a PURE function `clean → poisoned` over a committed clean fixture, with the EXPECTED verdict (`REJECT`/exit 3 for tamper, `usage`/exit 2 only where structurally malformed) recorded in a committed, hand-readable `challenge/corpus/manifest.json` (`{version, classes:[{id, title, vertical, fixture, expectedExit, expectedSignal}]}`). The generator is DETERMINISTIC (same clean input ⇒ byte-identical poisoned output) and re-emits the corpus so it can never silently rot; the clean source fixtures + a small set of pre-generated poisoned artifacts are COMMITTED so the corpus runs with zero build step. deps: EPIC-50 (the `challenge/` bundle + standalone verifier), the shipped verify cores. **NO new crypto, NO new verifier logic, NO new `needs-human` item.**
  - files: NEW `challenge/corpus/generate.js` (the deterministic clean→poisoned mutators, one per class); NEW `challenge/corpus/manifest.json` (the versioned taxonomy + expected verdicts); NEW `challenge/corpus/clean/` (committed clean source fixtures — at least one signed + one unsigned artifact per applicable vertical, minted with EPHEMERAL test keys); NEW `challenge/corpus/poisoned/` (committed pre-generated poisoned artifacts, one per class); NEW `test/challenge.corpus.test.js` (the generator is deterministic + re-emits in lockstep; the manifest is internally consistent — every class id unique, every fixture referenced exists, every expectedExit ∈ {2,3}; NO class is missing a poisoned artifact).
  - Acceptance: `node challenge/corpus/generate.js` re-emits `challenge/corpus/poisoned/` byte-for-byte (deterministic, no drift); `challenge/corpus/manifest.json` enumerates ≥9 distinct tamper classes spanning ≥3 verticals with a unique id, a referenced clean fixture, and an expected exit ∈ {2,3} each; every poisoned artifact differs from its clean source in EXACTLY the documented way (asserted in the test); the clean fixtures verify CLEAN (exit 0) before mutation (the corpus is honest — the poison, not a broken fixture, is what each verifier catches); `npx hardhat test` green. (NO production-code edits.)
- **T-52.2** `VERIFIED` Build the **self-auditing conformance RUNNER** (`challenge/corpus/run-corpus.js`) that drives EVERY shipped verifier against EVERY poisoned artifact in the corpus and asserts the family's load-bearing safety invariant — **no verifier EVER returns ACCEPT (exit 0) on a poisoned input** — to ONE aggregate PASS/FAIL verdict + a CI-gateable exit code. For each `{class, fixture}` in the corpus manifest, the runner (a) confirms the CLEAN fixture VERIFIES (exit 0) on its matching verifier (proving the test is real, not a fixture that rejects for the wrong reason), then (b) runs the matching SHIPPED verifier on the POISONED artifact and asserts the verdict matches the manifest's `expectedExit` (3, or 2 where structurally malformed) — and CRUCIALLY asserts it is NEVER exit 0. A SINGLE poisoned input that any verifier ACCEPTS is a HARD aggregate FAIL (exit 1) naming the class + verifier that let it through. The runner drives BOTH the producer-stack verifiers (`vh ... verify-attest`/`verify`/`verify-signed`/`verify-seal`/`identity verify`/`revocation verify`) AND the INDEPENDENT path (`verifier/dist/verify-vh-standalone.js`) where the artifact type applies, so the corpus proves the no-false-ACCEPT property on the surface a counterparty actually uses. Output is human-readable (a per-class ✓/✗ table + the aggregate line) and `--json` machine-readable for CI. deps: T-52.1. **READ-ONLY: drives existing verifiers, writes no production code path, holds no key, opens no network.**
  - files: NEW `challenge/corpus/run-corpus.js` (the cross-verifier driver + aggregate verdict + 0/1/2 exit contract, `--json`); NEW `test/challenge.corpus.run.test.js` (every clean fixture VERIFIES; every poisoned artifact is REJECTED by its matching verifier on BOTH the producer stack and — where applicable — the independent standalone; the aggregate is PASS over the committed corpus; a SYNTHETIC injected false-ACCEPT (e.g. a poisoned artifact whose verifier is mocked to return 0) makes the runner FAIL with exit 1 naming the class — proving the gate has teeth and cannot silently pass).
  - Acceptance: `node challenge/corpus/run-corpus.js` exits 0 with an aggregate PASS over the committed corpus, printing a per-class ✓ for every tamper class on every applicable verifier (producer + independent); every poisoned artifact is REJECTED (exit 3, or 2 where malformed) by its matching verifier — NEVER exit 0; a test that forces ONE verifier to (incorrectly) accept a poisoned input drives the runner to exit 1 naming the offending class + verifier (the gate has teeth); `--json` emits a stable machine-readable result; `npx hardhat test` green.
- **T-52.3** `VERIFIED` Wire the corpus into the **buyer-facing trust story** and the **regression floor**, with NO new human gate. (a) Add `docs/CONFORMANCE.md` — the buyer-runnable "how do I know your verifier has no holes?" answer: what each tamper class is, that EVERY shipped verifier (producer + independent) catches EVERY one, the exact command (`node challenge/corpus/run-corpus.js`), and the HONEST boundary verbatim — the corpus proves the verifiers REJECT every *enumerated* tamper class and re-derive trust from bytes (it does NOT prove the absence of unknown classes, and a REJECT is tamper-evidence, NOT a trusted "sealed at T" without P-3). (b) Extend `challenge/README.md` so a cold prospect can go from the single-tamper demo (EPIC-50) to "run the whole red-team corpus" in one step. (c) Add a one-line pointer in `docs/PILOT.md` §4 and in **P-7 step 3** (the buyer's first technical objection is answered by this artifact) and **P-8** (the pilot's no-false-ACCEPT question) — POINTERS only, NO change to the asks, NO new `needs-human` item. (d) A docs-rot test pins that `docs/CONFORMANCE.md` names the runner, states the honest boundary, and lists every tamper-class id from the corpus manifest (so a new class can never be added without documenting it). deps: T-52.1, T-52.2. **Docs + pointers only; sets no price, holds no key, contacts no one.**
  - files: NEW `docs/CONFORMANCE.md`; EDIT `challenge/README.md` (add the corpus step); EDIT `docs/PILOT.md` (§4 one-line pointer); EDIT STRATEGY.md P-7 step 3 + P-8 (one-line pointers, asks unchanged); NEW/EDIT `test/challenge.corpus.docs.test.js` (docs-rot: CONFORMANCE.md names the runner, states the honest boundary verbatim, and lists every class id present in `challenge/corpus/manifest.json`).
  - Acceptance: `docs/CONFORMANCE.md` exists, names `challenge/corpus/run-corpus.js`, states the honest boundary verbatim (proves REJECT of every ENUMERATED class + re-derive-from-bytes; does NOT prove absence of unknown classes; REJECT is tamper-evidence NOT a trusted timestamp without P-3), and lists every tamper-class id from the manifest (pinned by the docs-rot test so adding a class without documenting it FAILS the build); `challenge/README.md` links the corpus step; `docs/PILOT.md` + P-7 step 3 + P-8 gain a one-line pointer with NO change to any ask and NO new `needs-human` item; `npx hardhat test` green.

## EPIC-53 — THE PILOT RESULT CERTIFICATE: make the pilot run produce a portable, tamper-evident, independently-verifiable RESULT artifact a prospect can forward to their security/procurement team — turning the offline demo into a shareable trust deliverable that carries the commercial conversation forward (and dogfoods the product's own seal/verify core)  *(VALUE-CEILING / QUALITY-STALL pivot — NOT another mechanism mirror. Triggers fired: avgUsefulness flat ~3.25–4.0 for ~22 runs (declining from 4.5), `minUsefulness=2` MIN-OUTLIER in runs 21 AND 26, and `humanGated` STANDING at 3–5 for ~20 runs. The directive for a standing humanGated count is explicit: do NOT invent more incremental mechanism; identify the blocking needs-human proposal and prefer auto-buildable work that DE-RISKS / directly UNBLOCKS it. The blocking proposal is P-8 (land ONE design partner + run the pilot — the single human action that de-risks P-3/P-5/P-6/P-7). P-8 is now thoroughly SHARPENED (vertical, archetype, 3-step first contact, time box) — re-sharpening it again is the busywork the trail is littered with. The ONE real SOFTWARE gap left in P-8's now-crisp flow: when a prospect runs `node pilot/run-pilot.js` on THEIR OWN folder (P-8 step 3c → step 4) and it PASSES, the run EVAPORATES — it prints to the terminal and exits, leaving NO portable artifact. A prospect's security reviewer cannot forward "the run passed" to their team; the human cannot keep a record; the renewal lever (a recurring signed pilot result as the monthly deliverable) has nothing to attach to. CONFIRMED in the live product: `pilot/run-pilot.js` accumulates a structured `checks[]` array and computes a combined PASS/FAIL verdict (see `runPilot`/`check`), but the words `writeFileSync`/`--out`/`certificate`/`result` for an OUTPUT artifact appear 0 times — the verdict is print-only. WHY THIS IS DEPTH, NOT THE SATURATED VEIN: EPIC-46..52 each added a new verb/leg/assurance-kit on the PRODUCER/RECIPIENT mechanism. This adds NO new verify/seal verb and NO new vertical — it makes the PILOT ITSELF emit a verifiable deliverable by DOGFOODING the shipped `cli/evidence.js` seal/verify core (the pilot result becomes a real `*.vhevidence.json` packet the INDEPENDENT `verify-vh` accepts and a tampered copy REJECTS). It converts the pilot from an ephemeral terminal demo into a portable, tamper-evident trust artifact the commercial conversation hangs on — directly de-risking P-8 step 3c→4 (the prospect can SHARE the result with their team) and the renewal lever (a recurring signed pilot-result is the monthly deliverable P-5 #3 / P-8 name). STRICTLY ADDITIVE + NON-REGRESSING: default behavior of `run-pilot.js` is byte-for-byte unchanged (it still prints + exits with the same code); the certificate is emitted ONLY behind a new `--certificate <path>` flag; no production verify/seal logic is forked (the cert is built with the SHIPPED evidence core); holds no real key (ephemeral `Wallet.createRandom()` only); opens no network; adds no dependency. The income step is unchanged + still human: this makes the pilot's PASS a portable, forwardable proof; it sets no price, contacts no one, runs no pilot. See STRATEGY.md "## Direction" 2026-06-26.)*

- **T-53.1** `VERIFIED` Refactor `runPilot` to RETURN its structured result (not just print it) and emit a canonical, deterministic PILOT-RESULT RECORD. Today `runPilot` builds `checks[]` and prints a VERDICT but returns nothing portable. Change it (NON-loosening — same prints, same exit code) so it ALSO produces an in-memory result object: `{ kind: "vh-pilot-result", version, ranAt (the INJECTED clock instant, so the record is reproducible), verticals: ["evidence","reconcile"], checks: [{label, ok}], passed, total, verdict: "PASS"|"FAIL", toolVersion, honestBoundary: <the verbatim handoff caveats already printed> }`. The record is a PURE function of the run (no system clock, no absolute temp paths leak in — paths are normalized/elided so two runs over the same inputs yield byte-identical records). deps: EPIC-32 (the pilot kit, shipped & green). **NO new crypto, NO new verify/seal logic, NO new `needs-human` item.**
  - files: EDIT `pilot/run-pilot.js` (have `runPilot` build + return the canonical result record; the CLI shell prints exactly as today and reads the record from the return value — do NOT duplicate the verdict logic); NEW `test/pilot.result.test.js` (the returned record is internally consistent — `passed`/`total`/`verdict` match `checks`; it is deterministic across two runs over the same inputs; the printed output + exit code are byte-for-byte unchanged vs. the pre-refactor baseline).
  - Acceptance: `runPilot` returns a canonical `vh-pilot-result` record whose `verdict`/`passed`/`total` are derived from `checks[]` (a forced failing check flips `verdict` to FAIL); the record is deterministic (two runs over identical inputs ⇒ byte-identical record after path normalization); the existing printed output AND process exit code are byte-for-byte identical to the pre-EPIC baseline (regression-pinned); no system-clock or temp-path leakage; `npx hardhat test` green.

- **T-53.2** `VERIFIED` Add `--certificate <path>` to `pilot/run-pilot.js`: when supplied (and ONLY then), SEAL the T-53.1 result record into a tamper-evident, INDEPENDENTLY-verifiable `*.vhevidence.json` packet using the SHIPPED `cli/evidence.js` seal path VERBATIM (the pilot result becomes a real evidence packet — the product certifying its OWN pilot run, no new crypto, no forked logic). The packet binds the result-record bytes by content hash so any later edit is caught. With NO `--certificate` flag, `run-pilot.js` behaves byte-for-byte as today (print + exit, no file written). Optionally accept `--sign --vendor <addr> (--key-env|--key-file)` to wrap the certificate in the existing signed attestation (ephemeral test key ONLY in tests; the loop NEVER holds a real key) — but default is the UNSIGNED baseline seal so a prospect needs no key to receive a verifiable result. deps: T-53.1, EPIC-30 (`vh evidence seal`/`verify`, shipped & green). **Reuses the shipped seal core; NO new crypto; NO new `needs-human` item.**
  - files: EDIT `pilot/run-pilot.js` (parse `--certificate`/optional `--sign`/`--vendor`/`--key-*`; on success seal the result record via the SHIPPED evidence core and write the packet to the chosen path; default unchanged); NEW `test/pilot.certificate.test.js` (with `--certificate`, a `*.vhevidence.json` is written; the INDEPENDENT `verifier/verify-vh.js` ACCEPTS it (exit 0) and RE-DERIVES the root from the bytes; a one-byte tamper of the certificate makes verify-vh REJECT (exit 3) and localize; with NO `--certificate`, no file is written and stdout + exit code are byte-identical to today; the optional `--sign` path round-trips through `verify-signed` with an EPHEMERAL key).
  - Acceptance: `node pilot/run-pilot.js --certificate out.vhevidence.json` writes a tamper-evident packet over the pilot result that the INDEPENDENT `verify-vh` ACCEPTS (exit 0, root re-derived from bytes) and a one-byte tamper makes it REJECT (exit 3, localized) — proven by a test driving the REAL verifier (never a false ACCEPT); the optional `--sign --vendor <addr>` path produces a signed certificate that `vh evidence verify-signed` ACCEPTS with the pinned ephemeral vendor; with NO `--certificate`, the run's stdout + exit code are byte-for-byte unchanged from the pre-EPIC baseline; no real key held, no network, no new dependency; `npx hardhat test` green.

- **T-53.3** `VERIFIED` Document the pilot result certificate as the pilot's SHAREABLE DELIVERABLE in `docs/PILOT.md`, and wire a one-line POINTER into P-8 step 3c→4 (NO new human gate, NO change to the ask). Add a `docs/PILOT.md` section: after a prospect runs the pilot on their own folder, emit `--certificate <path>` to get a portable `*.vhevidence.json` they (and their security/procurement team) can INDEPENDENTLY verify with the zero-install `verify-vh-standalone.js` — turning "the demo passed on my machine" into a forwardable, tamper-evident record. State the HONEST boundary verbatim: the certificate proves WHAT the pilot run checked and that the result bytes are unaltered — it is tamper-evidence over the run record, NOT a trusted "the pilot ran at time T" without P-3, and NOT a legal/compliance verdict. A docs-rot test pins that `docs/PILOT.md` names `--certificate`, describes the share-with-your-team flow, and states the boundary verbatim. SHARPEN P-8 step 3c→4 with a one-line pointer (the pilot now ends at a forwardable signed result, not just a terminal PASS) — POINTER only, NO change to the ask, NO new `needs-human` item, NO change to P-3/P-4/P-5/P-6/P-7. deps: T-53.1, T-53.2.
  - files: EDIT `docs/PILOT.md` (the `--certificate` deliverable section + the honest boundary verbatim + the verify-with-your-team step); EDIT `pilot/README.md` (one-line operator note); EDIT STRATEGY.md P-8 step 3c→4 (one-line pointer, ask unchanged); NEW/EDIT `test/pilot.docs.test.js` (docs-rot: PILOT.md names `--certificate`, describes the forward-to-your-team flow, states the tamper-evidence-NOT-trusted-timestamp / NOT-legal boundary verbatim, and STRATEGY P-8 points at the certificate).
  - Acceptance: `docs/PILOT.md` documents the `--certificate` deliverable + the verify-with-your-team flow + the tamper-evidence-NOT-timestamp-without-P-3 / NOT-legal boundary verbatim; `pilot/README.md` carries the operator note; STRATEGY.md P-8 step 3c→4 gains a one-line pointer with NO change to the ask and NO new `needs-human` item; a docs-rot test pins all of it; `npx hardhat test` green.

## EPIC-54 — "WHO VERIFIES THE VERIFIER?": a third-party-runnable REPRODUCE-FROM-SOURCE check that roots the free verifier's trust in READING the audited in-tree source, not in trusting our published checksum — closing the FIRST question a prospect's security/procurement reviewer asks (P-8 step 3a/3b)  *(VALUE-CEILING / QUALITY-STALL pivot — NOT another producer/recipient mechanism verb. Triggers fired: avgUsefulness flat/oscillating ~3.63–4.0 for the whole recent window (`3.75, 4.0, 3.88, 3.63, 3.75`), declining from 4.5 (run 3); `minUsefulness=2` MIN-OUTLIER fired in runs 21 AND 26; `humanGated` STANDING at 3 for ~20 runs. Directive for a standing humanGated count: do NOT invent more incremental mechanism; identify the blocking needs-human proposal and prefer auto-buildable work that DE-RISKS / directly UNBLOCKS it. The blocking proposal is P-8 (land ONE design partner + run the pilot). P-8 is now EXHAUSTIVELY sharpened (vertical, archetype, 3-step first contact, time box) — re-sharpening it again is the busywork the trail is littered with, and EPIC-46..53 each added a new verb/leg/assurance-kit on the SATURATED producer/recipient surface. THE REAL, NON-MECHANISM GAP, CONFIRMED IN THE LIVE PRODUCT: P-8 step 3a/3b hands a cold prospect the zero-install `verify-vh-standalone.js` (the COLD-PROSPECT CHALLENGE, EPIC-50) and asks their security team to trust its verdict. But the bundle ships beside a `.sha256` SIDECAR DOWNLOADED FROM THE SAME PLACE AS THE BUNDLE — if our distribution is compromised, both are swapped together. The verifier README itself admits the checksum is only "a transport-integrity check pinned to a hex you" got from us. The existing `test/verifier.standalone.test.js` proves the build is DETERMINISTIC and that the sidecar EQUALS sha256(committed bundle) — but ALL of that is INTERNAL/CIRCULAR: there is NO third-party-runnable, offline path that lets a skeptic REPRODUCE the bundle from the in-tree source they can READ and AUDIT, and confirm the published checksum is exactly what that source compiles to. "Who verifies the verifier?" has no answer — and that is the FIRST thing a security/procurement reviewer asks, the gate on P-8's cold-prospect motion. WHY THIS IS DEPTH, NOT THE SATURATED VEIN: this adds NO new verify/seal verb, NO new vertical, NO new crypto, NO new verifier logic, NO change to any verdict/exit-code. It is a tiny REPRODUCIBILITY HARNESS over the EXISTING deterministic `build-standalone.js`: it lets ANY third party, offline, with ONLY Node core, rebuild the bundle from the committed source and prove byte-for-byte that the shipped file + its published `.sha256` are what the source they audited produces — turning "trust our hex" into "verify our hex from source you read." STRICTLY ADDITIVE + NON-REGRESSING: changes NO existing bundle byte, NO existing test, NO existing verdict. Pure-local, OFFLINE, deterministic, network-free, zero new dependency, holds NO key. REVENUE INTEGRITY upheld: this is a FREE trust-bootstrap for the free verifier (the funnel that PULLS the paid seal) — it produces nothing to gate, NOT a token/coin/NFT, NOT tradeable. Income still comes ONLY from selling the (now more trustworthy-to-procurement) product to paying customers — a HUMAN step; NO new `needs-human` item; NO change to P-1..P-8. See STRATEGY.md "## Direction" 2026-06-26.)*

- **T-54.1** `VERIFIED` Add a third-party-runnable REPRODUCE-AND-ATTEST mode to `verifier/build-standalone.js` (`--check`) that, given ONLY the committed `verifier/` source tree, REBUILDS both bundles in memory and asserts byte-for-byte that (a) the committed `dist/verify-vh-standalone.js` and `dist/seal-vh-standalone.js` equal the fresh rebuild, and (b) each committed `.sha256` sidecar equals sha256(committed bundle) AND equals sha256(fresh rebuild) — printing, for each target, the recomputed hex, the published hex, and `MATCH`/`MISMATCH`, then exiting 0 (all match) / 1 (any mismatch). This is the SAME determinism the test already proves internally, but exposed as a STANDALONE, offline, Node-core-only command a skeptic runs THEMSELVES — no hardhat, no test framework, no `npm install`. The default (no-flag) build behavior is UNCHANGED (still emits the four files). deps: EPIC-35 (verify bundle, shipped & green), EPIC-36 (seal bundle, shipped & green). **NO new crypto, NO new verify/seal logic, NO change to any emitted bundle byte, NO new `needs-human` item.**
  - files: EDIT `verifier/build-standalone.js` (add the `--check` reproduce-and-attest branch, reusing the EXISTING module list + `sha256SidecarFor` VERBATIM; the build of the bytes is the existing pure function — `--check` only COMPARES, it never writes); NEW `test/verifier.reproduce.test.js`.
  - Acceptance: `node verifier/build-standalone.js --check` on the clean tree exits 0 and prints `MATCH` for BOTH bundles AND BOTH sidecars (recomputed hex == published hex, recomputed bytes == committed bytes); a test that corrupts a copied `dist` bundle by one byte (in a temp tree) makes `--check` exit 1 with `MISMATCH` naming that target; a test that corrupts a copied `.sha256` sidecar makes `--check` exit 1 with `MISMATCH`; the default no-flag build still emits the four files byte-identically (regression-pinned); `--check` opens NO network and writes NOTHING under the source tree; full suite `npx hardhat test` green.
- **T-54.2** `VERIFIED` Emit a committed, self-contained BUILD-PROVENANCE manifest `verifier/dist/BUILD-PROVENANCE.json` (a deterministic by-product of `build-standalone.js`) that records, for EACH emitted bundle: the bundle basename, its sha256, AND the ORDERED list of `{ id, sourceFile, sha256OfSource }` for every in-tree source module the bundle inlines — so a third party can map "this published byte hash" back to "these exact audited source files at these exact hashes," and re-derive the whole chain themselves. The manifest is a PURE function of the committed source (no timestamp, no absolute paths, no randomness): two builds yield byte-identical manifests, and a stale committed manifest FAILS the anti-rot test. Extend T-54.1's `--check` to ALSO verify the committed manifest equals a fresh rebuild AND that every `sha256OfSource` in it equals sha256(the committed source file it names) — so `--check` now attests the FULL chain source→bundle→checksum offline. deps: T-54.1. **The manifest lists the source FILE HASHES the published bundle is built from; NO new crypto (reuses `crypto.createHash('sha256')`); NO new `needs-human` item.**
  - files: EDIT `verifier/build-standalone.js` (emit `dist/BUILD-PROVENANCE.json` deterministically from the existing module list + source reads; extend `--check` to validate it and every source-file hash); NEW `verifier/dist/BUILD-PROVENANCE.json` (committed build output); EDIT `test/verifier.reproduce.test.js` (anti-rot: committed manifest == fresh rebuild; every `sha256OfSource` == sha256(named source file); a one-byte source edit changes the manifest AND makes `--check` exit 1).
  - Acceptance: `verifier/dist/BUILD-PROVENANCE.json` is committed, deterministic (rebuild byte-identical), and lists for each bundle its sha256 + the ordered `{id, sourceFile, sha256OfSource}` for every inlined source module; `node verifier/build-standalone.js --check` validates the manifest end-to-end (manifest == rebuild, each `sha256OfSource` == sha256(source file), each bundle/sidecar matches) and exits 0; a test proves editing any inlined source file by one byte changes the manifest and makes `--check` exit 1 with a MISMATCH naming the affected source; a docs-rot/anti-rot test asserts the committed manifest is current; `npx hardhat test` green.
- **T-54.3** `VERIFIED` Document the reproduce-from-source trust-bootstrap so a prospect's security/procurement reviewer can ANSWER "who verifies the verifier?" in one offline sitting, and wire ONE-LINE pointers into the cold-prospect flow (NO new human gate, NO change to any ask). Add a `verifier/README.md` section "Don't trust our checksum — reproduce it from source": (1) read the in-tree `verifier/` source you are about to run (it is small, zero-dependency, auditable in one sitting); (2) run `node verifier/build-standalone.js --check` to prove the shipped single-file bundle + its `.sha256` are EXACTLY what that source compiles to, via the `BUILD-PROVENANCE.json` chain; (3) NOW the published hex means "the source I read produces this," not "a hex the vendor handed me." State the HONEST boundary verbatim: this proves the BUNDLE FAITHFULLY REPRODUCES THE AUDITED SOURCE (build integrity) — it is NOT a proof the source's logic is correct (that is what reading it + the conformance corpus are for), and NOT a trusted timestamp/identity (that is P-3). Wire one-line POINTERS into `challenge/README.md` (the cold-prospect challenge) and STRATEGY.md P-8 step 3a/3b — POINTER only, ask unchanged. A docs-rot test pins the README section names `--check`, describes the source→bundle→checksum chain, and states the boundary verbatim. deps: T-54.1, T-54.2. **POINTER only; NO change to P-1..P-8; NO new `needs-human` item.**
  - files: EDIT `verifier/README.md` (the "reproduce it from source" section + the honest boundary verbatim); EDIT `challenge/README.md` (one-line pointer for a skeptical reviewer); EDIT STRATEGY.md P-8 step 3a/3b (one-line pointer, ask unchanged); NEW/EDIT `test/verifier.reproduce.docs.test.js` (docs-rot: README names `--check`, describes the source→bundle→checksum chain via `BUILD-PROVENANCE.json`, states the build-integrity-NOT-source-correctness / NOT-timestamp boundary verbatim; STRATEGY P-8 points at the reproduce-from-source check).
  - Acceptance: `verifier/README.md` documents the reproduce-from-source bootstrap + the verbatim boundary; `challenge/README.md` and STRATEGY.md P-8 step 3a/3b each gain a one-line pointer with NO change to the ask and NO new `needs-human` item; a docs-rot test pins all of it; `npx hardhat test` green.

## EPIC-3 — Reputation layer  *(non-transferable contribution points)*

*Note (Strategist 2026-06-23): D-2 (token framing) is now written as a DECISION-READY proposal in
STRATEGY.md › Proposals — needs-human (P-1), recommended default = Option A (non-transferable, soulbound).
Once a human RESOLVES D-2 in STRATEGY.md › Decisions, these tasks come off `needs-decision`. Under Option A,
T-3.2 becomes a thin, additive on-chain layer over the EPIC-12 reputation substrate (the per-contributor
index + derived score), NOT a from-scratch design — much of T-3.1's data model and anti-sybil reasoning is
already produced by EPIC-12 / docs/REPUTATION.md.*

- **T-3.1** `VERIFIED` Design doc: reputation keyed to verified anchors. deps: D-2 RESOLVED (P-1); EPIC-12 (substrate). (D-1 resolved → use
  `authorBound` commit–reveal records as the attributable unit; still gated by D-2 token framing.)
  - Acceptance: a short design doc covering data model, anti-sybil, and why non-transferable; no code.
- **T-3.2** `VERIFIED` `ReputationSBT` contract + tests. deps: T-3.1 (VERIFIED; D-2 RESOLVED → Option A).
  - Acceptance: soulbound (non-transferable) points; full test suite; audited via the same loop.
  - files: contracts/ReputationSBT.sol (new), test/ReputationSBT.test.js (new).
  - Shipped (2026-07-05), per docs/REPUTATION-SBT-DESIGN.md §4: constructor pins ONE identity-probed
    registry (REGISTRY_ID probe — wrong/absent id, an EOA, or the zero address cannot be pinned);
    permissionless `mint(bytes32)` + atomic `mintBatch(bytes32[])` credit the RECORD's `contributor`
    (never `msg.sender`) only when `authorBound == true` and not already minted (one point per
    contentHash, globally, forever; anchorOnly reverts `NotAuthorBound`; double-mint reverts
    `AlreadyMinted`; unknown/zero hash reverts via the registry's `NotAnchored`); `points(address)` /
    `minted(bytes32)` / `totalPoints` reads; `PointMinted` + ERC-5192-spirit `Locked` events on every
    mint; NO owner/admin, NO transfer/approval/operator surface (non-transferability by ABSENCE,
    ABI-pinned: the only state-mutating functions are mint/mintBatch), NO payable path. On-chain
    `POINT_MEANING` equals cli/core/reputation-points.js's export byte-for-byte, and the suite pins
    conformance to the oracle: `points(addr) == pointsOf(records, addr)`, `totalPoints ==
    projectPoints(records).totalPoints`, each balance == the EPIC-12 derived view's `authorBound`
    count (computeScore). Compiled-NatSpec docs-rot guard restates §2's honest boundary (activity
    floor, never merit, not sybil-proof) + §3's rationale. Local hardhat only — NO deploy (P-2
    unchanged, no new needs-human item).

## EPIC-4 — Deployment

- **T-4.1** `TODO needs-decision` Deploy to Polygon Amoy. deps: EPIC-0 verified.
  - Acceptance: human supplies a throwaway faucet-funded key; deploy via `scripts/deploy.js`; record
    address + verify on the Amoy explorer. *(Outward-facing → never auto-run; human checkpoint.)*

## EPIC-5 — Governance / DAO  *(later; out of scope until EPIC-1..3 land)*

## EPIC-55 — Product-led self-serve adoption: a ONE-LINE GitHub Action + npx quickstart (PLG funnel, no human gate)

*Context / why this EPIC exists (2026-06-26).* For ~20 runs the build frontier has been mechanism built
AROUND a single dammed human decision (P-8: land a B2B design partner). `humanGated` has been pinned at 3 and
`avgUsefulness` collapsed to 2.5 — a VALUE CEILING forcing low-leverage work. This EPIC changes approach
materially: it opens a SECOND go-to-market that the loop can fully build with NO human gate — a product-led
(self-serve) adoption funnel for the FREE `verify-vh` side, which is exactly the precondition P-8's paid-seal
renewal lever already depends on ("the partner pastes it into their pipeline"). The current adoption path is
high-friction (vendor the whole `verifier/` tree, or hand-wire checkout + setup-node + npm + an edited run
block). This EPIC lowers that to ONE line. It re-sharpens NO needs-human proposal; it is auto-buildable,
keeps the FREE-verify / PAID-seal split, and de-risks P-8's renewal mechanics by making "paste it in" real.
REVENUE INTEGRITY: builds only the free adoption surface + ephemeral test fixtures; no key, no price, no token.

- **T-55.1** `VERIFIED` Ship a real, marketplace-shaped **composite GitHub Action** (`action.yml` at a stable path,
  e.g. `verifier/action/action.yml` + a thin `verifier/action/README.md`) that wraps the standalone offline
  `verify-vh` into a SINGLE adoption line — `uses: <repo>/verifier/action@<ref>` with `vendor:` and
  (`manifest:` | `artifacts:`) inputs — running the exact same gate command as `verifier/ci/verify-vh.generic.sh`
  (exit 0 pass / 3 tampered / 2 misconfig). The action must NOT require the consumer to vendor the verifier tree:
  its steps fetch/setup-node + install the near-zero-dep standalone (js-sha3 only) themselves. deps: none (the
  standalone verifier + generic.sh already exist).
  - files: verifier/action/action.yml, verifier/action/README.md, test/verifier.action.test.js
  - Acceptance: a test PARSES `action.yml` (valid composite action: `runs.using: "composite"`, declared
    `inputs.vendor` + `inputs.manifest`/`inputs.artifacts` with descriptions, ordered `runs.steps`), EXTRACTS the
    gate `run:` block, and EXECUTES it (substituting inputs) over the committed sample sealed packet asserting
    exit 0; then over a 1-byte-tampered copy asserting exit 3; and asserts the gate command is byte-identical to
    the one in `verifier/ci/verify-vh.generic.sh` (single source of truth, no drift). Full `npm test` green.

- **T-55.2** `VERIFIED` Add a true zero-config **`npx` quickstart** that takes a brand-new user from nothing to a
  verified packet in one command with NO flags and NO key knowledge: a `verify-vh demo` (or `--demo`) subcommand
  in the standalone verifier that runs the bundled sample sealed packet through verification, prints the human
  ACCEPT verdict + WHO signed it + what it does/does-not attest, then tampers an in-memory copy and shows the
  REJECT — proving the tool to a cold prospect in ONE line with zero install state. deps: T-55.1 not required;
  uses the existing standalone verifier + the committed challenge/sample-packet.
  - files: verifier/verify-vh.js, verifier/dist/verify-vh-standalone.js (rebuilt via build-standalone.js),
    verifier/README.md, test/verifier.demo.test.js
  - Acceptance: `node verifier/verify-vh.js demo` exits 0 and stdout contains the ACCEPT verdict, the signer
    address, and a REJECT line for the tampered copy; a test asserts the standalone bundle exposes the SAME demo
    (rebuilt bundle still byte-matches its committed `.sha256`, so T-54's reproduce chain stays intact). Green.

- **T-55.3** `VERIFIED` Document the self-serve adoption funnel as a FIRST-CLASS, copy-paste path: a top-of-README
  "Adopt in one line" quickstart (`npx` demo → the one-line Action) and a short `docs/ADOPT.md` that frames the
  free-verify adoption as the on-ramp, with an honest boundary note (a green gate means "bytes still match the
  signer," NOT a trusted timestamp without P-3) and a single POINTER to P-8 (the paid-seal renewal lever) — NO
  new human gate, NO re-sharpen of any needs-human proposal. deps: T-55.1, T-55.2.
  - files: README.md, docs/ADOPT.md, public/docs/ADOPT.md (mirror), test/adopt.docs.test.js
  - Acceptance: a docs test asserts `docs/ADOPT.md` contains the literal `npx`/`uses:` adoption lines and that
    those lines match the actual subcommand/`action.yml` path (no doc drift); asserts the honest-boundary
    sentence is present; README links to docs/ADOPT.md. Full `npm test` green.


## EPIC-56 — DECISION LEGIBILITY: make the ONE human decision actionable + stop the unbounded doc-bloat that buries it

> Rationale (Strategist, 2026-06-27): The frontier is empty, 2827 tests green, and the engine's own SCORING
> FLOOR now hard-caps any further P-8-orbit *mechanism* at usefulness 2. Three consecutive runs correctly stood
> down with `newTasks: []`, each naming the SAME real, non-gated, self-inflicted defect — STRATEGY.md is 507KB
> (101 `## Direction` entries, ~501KB; 12 of them pure stand-down essays) and BACKLOG.md is 517KB — and each
> then made it WORSE by appending another 30-line essay. The prompt itself directs the human to "read STRATEGY.md
> for the why," and a prior entry diagnosed the bloat verbatim: "a 484KB STRATEGY.md is HARDER to act on, not
> easier … the bloat is itself an anti-signal." This epic is NOT mechanism, NOT a P-8 re-sharpen, NOT a new
> product, NOT another orbit — it is a one-time process fix + a standing guard that makes the single human
> go-to-market decision legible and keeps it that way. The needs-human proposal sections (P-1..P-8) and the
> `## Direction`/`## Decisions`/`## Loop upgrades` anchors the engine appends to MUST be preserved (the
> `test/*.docs.test.js` suite asserts on the P-3/P-7/P-8 proposal text). NO new needs-human item; NO change to
> any proposal. Guardrails: pure-local docs/test work, no network, no key, no deploy, no revenue action.

- **T-56.1** `VERIFIED` Extract the single human decision into a **one-screen `docs/DECIDE.md`** — the ONE file a
  human reads in the morning, nothing else. It states, in <= ~60 lines: (a) the single recommended decision
  (run ONE time-boxed EVIDENCE-vertical (P-7) design-partner pilot — the lightest gate), (b) the 3-step first
  human action verbatim from the consolidated P-8 ask (provision ONE offline vendor keypair, pin the address +
  pick a price, send the pilot kit to ONE candidate buyer), (c) exactly which commands the human runs and which
  files to hand the prospect (`pilot/run-pilot.js --certificate`, the standalone challenge), (d) the success/stop
  criteria + time box, and (e) the revenue-integrity boundary (license = access credential, NOT a token/coin/NFT).
  It is a POINTER-and-summary surface — it MUST NOT introduce any new ask, price, key, contact, or proposal; it
  links back to STRATEGY.md P-8 and docs/MORNING.md §Needs-human as the source of truth. deps: none.
  - files: docs/DECIDE.md, public/docs/DECIDE.md (mirror), README.md (one top-level link), test/decide.docs.test.js
  - Acceptance: a docs test asserts `docs/DECIDE.md` exists, is <= 80 lines (a true one-screen page), contains
    the recommended vertical (EVIDENCE / P-7), the 3 verbatim first-action bullets, the `pilot/run-pilot.js
    --certificate` command string (matching the real subcommand — no drift), the time-box/stop criterion, and
    the revenue-integrity boundary sentence; asserts it introduces NO new `needs-human` token beyond a pointer
    to P-8; asserts README links to docs/DECIDE.md and the public mirror byte-matches. Full `npm test` green.

- **T-56.2** `VERIFIED` Archive the SUPERSEDED `## Direction` history out of STRATEGY.md into **`docs/STRATEGY-ARCHIVE.md`**
  so the live STRATEGY.md is small and actionable. Move all but the most recent N (N = 5) dated `## Direction`
  entries verbatim into the archive (append-only, newest-first or preserved order), leave a single one-line
  pointer at the top of `## Direction` ("Older entries archived in docs/STRATEGY-ARCHIVE.md"), and PRESERVE
  UNCHANGED: the file header/intro, every `needs-human` proposal (P-1..P-8) and its section, the `## Direction`
  header itself, `## Decisions`, and `## Loop upgrades` (the engine appends to these). NO entry text is edited or
  deleted — it is relocated byte-for-byte. deps: T-56.1 not required.
  - files: STRATEGY.md, docs/STRATEGY-ARCHIVE.md, test/strategy.archive.test.js
  - Acceptance: a test asserts (a) every P-1..P-8 proposal string the existing `*.docs.test.js` suite checks is
    STILL present in STRATEGY.md (run the full suite — it must stay green, proving no proposal text was lost);
    (b) STRATEGY.md retains the `## Direction`, `## Decisions`, and `## Loop upgrades` headers; (c) the archive
    file exists and contains the moved entries; (d) the concatenation of retained + archived `## Direction`
    entries equals the original set (no entry dropped, none duplicated). Full `npm test` green.

- **T-56.3** `VERIFIED` Add a **standing doc-size guard** so the loop cannot silently re-bloat the decision surface:
  a test that FAILS if STRATEGY.md exceeds a bounded budget (e.g. <= 120KB) OR if `## Direction` holds more than
  M (M = 12) live entries — forcing future runs to archive (T-56.2 mechanism) instead of appending unboundedly.
  Pair it with a tiny `scripts/archive-direction.cjs` helper (pure-local, idempotent) that performs the move so a
  future run can satisfy the guard with one command, and document the rule in a short comment block. The guard
  protects the human-legibility invariant this epic establishes. deps: T-56.2.
  - files: scripts/archive-direction.cjs, test/strategy.size-guard.test.js, docs/STRATEGY-ARCHIVE.md
  - Acceptance: the guard test PASSES on the post-T-56.2 tree (STRATEGY.md within budget, <= M live Direction
    entries) and is proven non-trivial (a unit check drives the size/count logic against an over-budget fixture
    string and asserts it would FAIL); `scripts/archive-direction.cjs` run twice is idempotent (second run is a
    no-op) and leaves the suite green. Full `npm test` green.

## EPIC-57 — EMBEDDABLE SDK: publish the already-built provenance CORE as a stable, semver-guarded programmatic API (`require("verifyhash")`) so ANOTHER program can produce/verify seals in-process — a NEW, ungated distribution axis, NOT a CLI verb  *(MATERIAL CHANGE OF DIRECTION — the CLI/product-mechanism vein is fully saturated. EPIC-46..56 (eleven consecutive EPICs, each titled "material change of direction") were all the SAME shape: another CLI verb / assurance kit / doc leg on the end-user `vh` surface, every one orbiting the SINGLE P-8 design-partner human gate. The proof it was orbit, not pivot: avgUsefulness COLLAPSED 3.75→2.5 on the most recent run, minUsefulness=2, endReason=frontier (empty) — the engine's SCORING FLOOR finally caught the self-deception it could not see when the batch AVERAGE hid it. The directive when humanGated has STOOD at 3 for ~20 runs and the quality stall fires is explicit: do NOT invent a 12th "next leg"; either SHARPEN the blocking proposal (P-8 is already EXHAUSTIVELY sharpened — re-sharpening is the named busywork) or pursue genuinely NEW, ungated value. THIS is the new axis: the whole family assumes the customer adopts a CLI and shells out to `vh`, parsing stdout — brittle, slow, and UNUSABLE inside another developer's library / serverless function / build tool / product. CONFIRMED in the live tree: `package.json` is `bin`-only — there is NO `main`, NO `exports`, NO `types`, NO published library entrypoint; the world-class, fully-tested core (`cli/core/packetseal.js` › `buildSeal`/`verifySeal`/`committedLeaves`; `cli/core/attestation.js` › `verifySignedAttestation`/`recoverSigner`; `cli/receipt.js` › `diffManifest`) is buried under a private `cli/core/` path with NO stable public contract, NO semver guarantee, NO consumer-facing docs, and NO API-stability guard — so no third-party program can depend on it. This EPIC packages the EXISTING, already-green engine as a first-class embeddable component: a real `exports` map, a single documented `index.js` public surface (a THIN re-export — NO new mechanism, NO new crypto, NO new verb), a CONTRACT test that pins the exported surface so a refactor cannot silently break a downstream consumer, and an API-stability GUARD (the EPIC-56 doc-guard pattern, applied to the exported surface) so the public contract cannot drift unnoticed. WHY THIS IS THE HIGHER-LEVERAGE, NON-ORBIT WORK: (a) it is a DISTINCT distribution + monetization axis (an embed/usage license for developers integrating "verified by verifyhash" into THEIR software) that is NOT dammed behind the P-8 design-partner PILOT — a developer can `npm i verifyhash` and `require` it with zero sales call; (b) it is the PREREQUISITE for every downstream integration the family has never had (a hosted verify endpoint, a CI plugin that imports rather than shells out, another vendor embedding the verifier) — it multiplies the reach of work already done; (c) it directly de-risks the ONE ungated axis DECIDE.md already names (the free verify funnel that PULLS the paid seal) by letting the free verifier be IMPORTED, not shelled-out. STRICTLY ADDITIVE + NON-REGRESSING: it exposes the EXISTING core VERBATIM behind a stable surface; it changes NO CLI verb, NO verdict, NO exit code, NO seal/attestation byte, NO existing test; it adds NO runtime dependency and NO network. REVENUE INTEGRITY: the SDK/embed offering is a license/usage fee for delivered SOFTWARE a developer integrates — NOT a token/coin/NFT, NOT tradeable, NOT an appreciating asset; publishing to a registry, setting an embed price, and any developer-relations motion are HUMAN steps (a new needs-human sub-note, P-9, is added to STRATEGY.md — the loop only BUILDS + locally TESTS the API surface). See STRATEGY.md "## Direction" 2026-07-01.)*

- **T-57.1 VERIFIED** Add a single, documented, semver-guarded PUBLIC API entrypoint `index.js` that re-exports the
  ALREADY-BUILT core as a stable, flat, consumer-facing surface — NO new mechanism, NO new crypto, a THIN
  re-export only. Wire `package.json` with `"main": "index.js"` and an `"exports"` map (`"."` → `./index.js`;
  keep the `bin` unchanged), and add `index.js` to the `files` array so it ships in the npm tarball. The public
  surface is the small, stable subset a third-party PROGRAM needs to VERIFY and DIFF a packet in-process
  (deliberately SMALL to keep the contract narrow): `verifySeal` + `buildSeal` + `committedLeaves` +
  `PacketSealError` (from `cli/core/packetseal.js`), `verifySignedAttestation` + `recoverSigner` (from
  `cli/core/attestation.js`), `diffManifest` (from `cli/receipt.js`), and a frozen `VERSION` string.
  Each re-exported name keeps its EXISTING behavior byte-for-byte (re-export, do not re-implement). Add a JSDoc
  block per exported symbol stating its inputs/outputs and the HONEST scope caveat verbatim (tamper-evidence +
  signer-pin; NOT a trusted timestamp without P-3). deps: none.
  - files: index.js, package.json, README.md (a "Use it as a library" section with a runnable `require` example)
  - Acceptance: a test `require("../index.js")` (via the package root, exercising the `exports` map) and asserts
    every promised symbol is present and is the SAME function object as its `cli/core/*` / `cli/receipt.js`
    source (identity check — proves a thin re-export, not a fork); a round-trip test builds a seal via the SDK,
    verifies it via the SDK (ACCEPT), tampers one byte and re-verifies (REJECT) — proving the embedded path
    matches the CLI path; `package.json` has `main:"index.js"`, an `exports` map, and `index.js` in `files`; the
    README example runs. Full `npm test` green; NO CLI verb/verdict/exit-code changed.

- **T-57.2 VERIFIED** Add an API-CONTRACT test that PINS the exported public surface so a refactor cannot silently
  add, remove, rename, or change the arity of a public symbol without a deliberate, reviewed update — the
  semver guard that makes the SDK safe for a third party to depend on. It snapshots the sorted list of
  `Object.keys(require("../index.js"))` plus each function's `.length` (arity) against a committed expected
  contract, and FAILS LOUD on any drift with a message telling the author to bump the SDK MAJOR/MINOR
  deliberately and update the contract. Document the rule in a short comment block ("the public API is a
  semver contract; changing this surface is a breaking change"). deps: T-57.1.
  - files: test/sdk.contract.test.js, docs/SDK.md (the public-API reference: each symbol, signature, honest
    scope caveat, and the semver policy)
  - Acceptance: the contract test PASSES on the T-57.1 tree; it is proven NON-TRIVIAL (a unit check feeds the
    drift-detector a surface with one extra/renamed key and asserts it would FAIL); `docs/SDK.md` documents
    every exported symbol + the semver policy and its symbol list byte-matches the actual `index.js` exports
    (a test asserts no doc/code drift). Full `npm test` green.

- **T-57.3 VERIFIED** Ship a committed, runnable CONSUMER EXAMPLE that exercises the SDK exactly as an external
  developer would — `require("verifyhash")` (resolved via the package root, NOT a deep `cli/core` path),
  verify a committed sample packet (ACCEPT), tamper it in-memory (REJECT), and diff two manifests — proving
  the public surface is sufficient to build a real integration with NO deep-path imports and NO shelling out
  to the `vh` binary. Keep it dependency-free (Node core only) and deterministic. deps: T-57.1.
  - files: examples/sdk-verify.js, examples/README.md, test/sdk.example.test.js
  - Acceptance: a test runs `examples/sdk-verify.js` in a child process and asserts it exits 0, prints the
    ACCEPT→REJECT→diff sequence, and imports ONLY `require("verifyhash")` / relative example files (a grep
    asserts NO `require(".../cli/core/...")` deep-path import in the example — proving the public surface
    stands alone); the example uses no network and no non-core dependency. Full `npm test` green.

## EPIC-58 — COMPLETE THE EMBEDDABLE SDK's VERIFY SURFACE: make the SIGNED / vendor-pinned verify path importable in-process (close the gap between what P-9 PROMISES and what `index.js` DELIVERS)  *(CONTINUES the sanctioned EPIC-57 SDK distribution axis — NOT a new orbit, NOT a CLI verb, NOT a P-8 re-sharpen. The stall pivot (EPIC-57) opened the embed axis by exporting the UNSIGNED verify path (`verifySeal`/`buildSeal`/`diffManifest`/hashing). But a downstream program that `require("verifyhash")`s CANNOT verify a SIGNED, vendor-pinned evidence packet in-process — the exact path that makes the free verifier PULL the paid seal — because `index.js` never re-exports the signed-attestation verifier. CONFIRMED in the live tree: `cli/core/attestation.js` exports `verifySignedAttestation`/`recoverSigner` and `cli/evidence.js` exports `verifySignedSealAttestation`/`readSignedSeal`/`validateSignedSeal`/`SIGNED_SEAL_KIND`, all fully tested and CLI-shipped — yet NONE appear in `index.js`. WORSE: the P-9 needs-human note (STRATEGY.md) already CLAIMS the SDK re-exports `verifySignedAttestation`/`recoverSigner` "VERBATIM," so the human-facing proposal OVERSTATES what shipped — completing this makes P-9 TRUE. WHY THIS IS HIGH-LEVERAGE, NON-ORBIT WORK: (a) it completes the ONE distribution axis the stall pivot chose, so an embedder can verify BOTH unsigned tamper-evidence AND a signed, vendor-address-pinned packet with NO shell-out — the whole "verified by verifyhash, in YOUR product" thesis; (b) it directly de-risks the never-built downstream integration EPIC-57 named (a hosted verify endpoint / a CI plugin that IMPORTS the signed verifier instead of parsing `vh` stdout); (c) it is ungated — a developer `npm i`s and requires, zero P-8 pilot, zero sales call. STRICTLY ADDITIVE + NON-REGRESSING: a THIN identity re-export of ALREADY-SHIPPED, already-green functions behind the existing semver-guarded surface; it changes NO CLI verb, NO verdict, NO exit code, NO seal/attestation byte, NO existing test, and adds NO runtime dependency and NO network. Deliberately SHORT (2 tasks) so it does not re-bloat the surface EPIC-56 just cleaned. REVENUE INTEGRITY: unchanged from P-9 — the SDK is a license/usage fee for delivered SOFTWARE, NOT a token/coin/NFT, NOT tradeable; publishing/pricing/dev-rel stay the human-owned P-9 steps. See STRATEGY.md "## Direction" 2026-07-01.)*

- **T-58.1 VERIFIED** Extend the public SDK surface (`index.js`) with the SIGNED / vendor-pinned verify path as a THIN
  identity re-export — NO new mechanism, NO new crypto, NO CLI change. Add to the frozen `seal` namespace AND
  the flat top-level map: `verifySignedSeal` (= `evidence.verifySignedSealAttestation`, the vendor-address-pinned
  offline verifier that recovers the signer and confirms the embedded canonical seal), `readSignedSeal`
  (= `evidence.readSignedSeal`) + `validateSignedSeal` (= `evidence.validateSignedSeal`), `recoverSigner`
  (= `coreAttestation.recoverSigner`), `verifySignedAttestation` (= `coreAttestation.verifySignedAttestation`),
  and the constants `SIGNED_SEAL_KIND` + `VERIFY_SIGNED_SEAL_TRUST_NOTE`. Each re-exported value MUST be the SAME
  function/string object as its source (identity, not a fork). Add a JSDoc block per symbol restating the HONEST
  scope caveat verbatim (a valid signature proves the KEY-HOLDER vouched for this exact packet identity — NOT a
  trusted timestamp without P-3, NOT a legal opinion). Then FIX the P-9 note's overclaim: update STRATEGY.md P-9
  so its "re-exports … VERBATIM" list matches what `index.js` ACTUALLY exports (add the signed-verify names now
  that they are real; do NOT add/relax any human gate — P-9 stays needs-human, its 3 steps unchanged). deps: T-57.1.
  - files: index.js, STRATEGY.md (P-9 export-list correction only), README.md (extend the "Embed it" section with
    a signed-verify `require` snippet)
  - Acceptance: a test `require("../index.js")` and asserts every new symbol above is present, is the SAME object
    as its `cli/evidence.js` / `cli/core/attestation.js` source (identity check — proves thin re-export), and that
    the namespace + flat forms agree; a round-trip test SIGNS a seal with an EPHEMERAL throwaway `Wallet.createRandom()`
    key, verifies it via the SDK's `verifySignedSeal` with the matching `--signer`/address (ACCEPT), then re-verifies
    with a WRONG expected signer and with a one-byte-tampered container (both REJECT) — proving the embedded signed
    path is byte-identical to the CLI `vh evidence verify-signed` path; a test asserts STRATEGY.md P-9's re-export
    list now names each shipped signed-verify symbol (no doc/code drift) and that P-9 still carries its 3 human steps
    unchanged. Full `npm test` green; NO CLI verb/verdict/exit-code changed; the loop NEVER holds a real key.

- **T-58.2 VERIFIED** Extend the API-CONTRACT test (T-57.2) and `docs/SDK.md` to COVER the new signed-verify surface so the
  semver guard protects it too, and ship a runnable, dependency-free INTEGRATION example that proves the SDK can
  power a "verify endpoint" shape WITHOUT shelling out: `examples/sdk-verify-signed.js` builds+signs a packet with
  an ephemeral key, then acts as a tiny in-process "verify service" function that takes (containerBytes, dirEntries,
  expectedSigner) and returns the ACCEPT/REJECT verdict via the SDK's `verifySignedSeal` — importing ONLY
  `require("verifyhash")`, no deep `cli/…` path, no `child_process`, no network. Update the pinned contract snapshot
  + its non-trivial drift unit-check to include the new keys/arities, and add each new symbol (signature + honest
  scope caveat + semver note) to `docs/SDK.md` with the doc/code no-drift assertion extended to the new names.
  deps: T-58.1.
  - files: test/sdk.contract.test.js, docs/SDK.md, examples/sdk-verify-signed.js, test/sdk.example.signed.test.js
  - Acceptance: the extended contract test PASSES on the T-58.1 tree and its committed expected surface now includes
    the signed-verify symbols + arities; it stays proven NON-TRIVIAL (the drift-detector still FAILS on a
    fabricated extra/renamed key); `docs/SDK.md` documents every new symbol and its symbol list byte-matches
    `index.js` exports (a test asserts no drift); a test runs `examples/sdk-verify-signed.js` in a child process and
    asserts it exits 0, prints an ACCEPT then a REJECT (wrong-signer or tamper), and a grep asserts the example
    imports ONLY `require("verifyhash")` / relative files with NO deep `cli/…` import and NO `child_process`/network.
    Full `npm test` green.

## EPIC-59 — RUNNABLE VERIFY SERVICE on the SDK: a tiny, dependency-free, loopback-only, VERIFY-ONLY HTTP endpoint (`vh serve-verify`) so a CI pipeline / another service POSTs a seal and gets a signed-JSON ACCEPT/REJECT — the structurally-NEW consumption shape EPIC-57 named but never built  *(MATERIAL CHANGE OF DIRECTION — stop re-exporting symbols on the SDK axis (EPIC-57/58 are SATURATED: the scoring floor correctly caps a 3rd "add another symbol behind the contract test" EPIC at ≤2, and the last run PROVED it — avgUsefulness 3.75→2.5, minUsefulness=2, endReason=frontier). EPIC-57's own charter named the never-built downstream integration: "a hosted verify endpoint, a CI plugin that IMPORTS rather than shells out." THAT is the structurally-new capability the floor reserves 3+ for (category b: a new capability the buyer need not adopt-more-mechanism to use) — NOT more mechanism on the producer `vh` surface, NOT another re-export, NOT a P-8 re-sharpen. Today the SDK is a set of functions a developer must WRITE GLUE around before it does anything; the last-mile integration a CI system or another microservice actually consumes — "POST me your seal, I'll tell you ACCEPT/REJECT over HTTP" — has NEVER existed. CONFIRMED in the live tree: the ONLY HTTP surface is `vh trust serve` (a TrustLedger-specific browser front-door, cli/vh.js:100); there is NO generic, product-agnostic verify endpoint, and the SDK core is proven in-memory-drivable (`verifySeal(seal, entries)` takes an in-memory `{relPath,bytes}` list — cli/evidence.js:220 — and `verifySignedSeal({container,expectedSigner,expectedCanonical})` is the PURE byte-based core — cli/evidence.js:667 — neither needs a filesystem dir, a key, or a network). This EPIC composes those EXISTING, already-green verify cores into a tiny Node-core-only ('http' module, zero new dependency) HTTP service that a developer runs with ONE command and a CI job hits with ONE curl — turning the imported verifier from "a library you must wire up" into "a running dependency you drop in." WHY THIS IS HIGH-LEVERAGE, NON-ORBIT, UNGATED: (a) it is a DISTINCT consumption shape (network-callable verify) on the SDK distribution axis that needs NO P-8 design-partner pilot and NO sales call — a developer `npm i`s, runs `vh serve-verify`, and their build gates on the response; (b) it is the concrete "CI plugin that IMPORTS rather than shells out" the family has never had — the response is machine-JSON with a stable verdict shape + exit-mappable status, so a pipeline consumes it directly instead of parsing `vh` stdout; (c) it de-risks the ONE ungated funnel DECIDE.md names (the FREE verify path that PULLS the paid seal) by making that verifier hittable as a service, not just importable. STRICTLY ADDITIVE + NON-REGRESSING + IN-GUARDRAILS: it VERIFIES ONLY — it NEVER signs, holds NO private key, and writes NOTHING; it binds ONLY loopback (127.0.0.1) by DEFAULT and exposing it publicly is an explicit HUMAN deploy step (mirrors `vh trust serve` + a new P-9 sub-note); it reuses the EXISTING verify cores VERBATIM so it changes NO verdict, NO exit code, NO seal/attestation byte, NO existing test; it adds NO runtime dependency (Node `http` only) — the "SDK adds no network" invariant is preserved for the LIBRARY surface (index.js is untouched); the server is a SEPARATE, opt-in, human-launched command. REVENUE INTEGRITY: unchanged from P-9 — the verify service is delivered SOFTWARE (a license/usage fee for embedders who run it in THEIR pipeline), NOT a token/coin/NFT, NOT tradeable; publishing, pricing, hosting, and any public deploy stay the human-owned P-9 steps. Kept to 3 tasks so it does not re-bloat the surface EPIC-56 cleaned. See STRATEGY.md "## Direction" 2026-07-01.)*

- **T-59.1** `VERIFIED` Add a pure, transport-agnostic `verifyRequest(body)` core (a new small module, e.g. `cli/serve-verify.js`) that
  takes ONE already-parsed JSON request object and returns ONE machine verdict object — NO `http`, NO `fs`, NO key, NO network
  in this function (so it is unit-testable without a socket). It dispatches on a required `kind` field: `"seal"` verifies an
  UNSIGNED seal against supplied in-memory entries via the SDK's `verifySeal(seal, entries)`; `"signed-seal"` verifies a SIGNED
  container via the SDK's `verifySignedSeal({container, expectedSigner, expectedCanonical})` with an OPTIONAL `expectedSigner`
  pin and an OPTIONAL in-body `entries` binding (recompute the canonical bytes from the supplied entries — the SAME
  `serializeSeal(buildSeal(entries))` the CLI `--dir` path uses, but from BYTES in the body, never the filesystem). It returns a
  STABLE, versioned verdict shape `{ ok: boolean, verdict: "ACCEPTED"|"REJECTED"|"ERROR", accepted: boolean, kind, checks?, failedChecks?, recoveredSigner?, error? }` that REUSES the existing verify cores' fields VERBATIM (no new verdict vocabulary). A MALFORMED request (missing/unknown `kind`, missing seal/entries, non-base64 bytes, oversized body) returns a clean `verdict:"ERROR"` with a message — NEVER throws to the transport and NEVER a silent ACCEPT. deps: T-58.1.
  - files: cli/serve-verify.js, test/serve-verify.core.test.js
  - Acceptance: `verifyRequest` is a PURE function (no `http`/`fs`/network/key — a test greps the module for those and a test proves it runs with the filesystem unavailable/irrelevant); an UNSIGNED seal built via the SDK verifies ACCEPTED and a one-byte-tampered entry verifies REJECTED; a SIGNED container (signed with an EPHEMERAL throwaway `Wallet.createRandom()` key) verifies ACCEPTED under the matching `expectedSigner`, REJECTED under a WRONG `expectedSigner`, and REJECTED when an in-body `entries` binding is supplied that does NOT match the signed bytes; every malformed/oversized/unknown-`kind` request returns `verdict:"ERROR"` (never throws, never a false ACCEPT); the verdict shape's field names are asserted byte-for-byte against the existing verify cores' shape. Full `npm test` green; NO existing verb/verdict/exit-code/seal byte changed; the loop NEVER holds a real key.

- **T-59.2** `VERIFIED` Add the `vh serve-verify [--port <n>] [--host <h>] [--max-body <bytes>]` command: a tiny Node-core (`http` module,
  ZERO new dependency) HTTP server that binds `127.0.0.1` by DEFAULT (loopback-only), accepts `POST /verify` with a JSON body,
  routes it through `verifyRequest` (T-59.1), and responds with the machine verdict as JSON on a status code that maps the
  verdict for CI (`200` ACCEPTED, `422` REJECTED, `400` ERROR/malformed) — so a pipeline gates on the HTTP status OR the JSON.
  It VERIFIES ONLY: it never signs, holds NO key, writes NOTHING to disk, and contacts nothing outbound. A `GET /healthz`
  returns `{ ok: true, apiVersion }`. Non-POST / wrong-path / oversized-body requests get a clean 4xx, never a crash. The help
  text + the startup banner LEAD with the honest boundary: verify-only, loopback by default, the trust boundary is unchanged
  (a seal proves tamper-evidence + offline recompute, NOT a trusted timestamp — P-3), and EXPOSING it beyond loopback is a
  HUMAN deploy step (never auto-deployed), mirroring `vh trust serve`. deps: T-59.1.
  - files: cli/serve-verify.js, cli/vh.js, test/serve-verify.http.test.js
  - Acceptance: a test starts the server on an ephemeral port bound to 127.0.0.1, POSTs a valid unsigned seal (200 + ACCEPTED
    JSON), POSTs a tampered seal (422 + REJECTED), POSTs a signed container under the correct then wrong `expectedSigner`
    (200 then 422), POSTs malformed JSON and an oversized body (400, no crash), GETs `/healthz` (200 + `{ok:true}`), and hits
    a wrong method/path (4xx) — then closes the server cleanly (no leaked handle); a test asserts the DEFAULT bind host is
    loopback (a request to a non-loopback interface is NOT served by default) and that the process holds NO key and writes NO
    file during a verify; the help/banner text asserts the verify-only + loopback + P-3 + human-deploy caveats verbatim. Full
    `npm test` green; NO existing verb/verdict/exit-code/seal byte changed.

- **T-59.3** `VERIFIED` Ship the CI-INTEGRATION artifact that makes the endpoint a DROP-IN dependency, and document it: (a) a
  committed, dependency-free `examples/verify-service-client.js` that starts the server in-process (or connects to a running
  one), POSTs a seal, and gates on the response exactly as a CI job would — importing ONLY `require("verifyhash")` + the new
  command + relative files, NO deep `cli/…`, NO third-party dependency; (b) a generic CI recipe
  `verifier/ci/verify-service.generic.sh` (+ a GitHub-Actions twin) that boots `vh serve-verify`, curls `POST /verify` with a
  seal, and FAILS the build on a non-200 — the "CI plugin that imports rather than shells out to parse stdout" EPIC-57 named;
  (c) a new `docs/VERIFY-SERVICE.md` (and a pointer from `docs/SDK.md`) documenting the request/response schema, the
  status-code→verdict mapping, the verify-only/loopback/P-3 trust boundary, and that public exposure is a HUMAN deploy step;
  and (d) a one-line P-9 sub-note in STRATEGY.md recording that the verify service exists, is verify-only + loopback-default,
  and that hosting/exposing it is a human-owned step (NO new gate, NO relaxed gate — P-9's 3 steps unchanged). deps: T-59.2.
  - files: examples/verify-service-client.js, verifier/ci/verify-service.generic.sh, verifier/ci/verify-service.github-actions.yml, docs/VERIFY-SERVICE.md, docs/SDK.md, STRATEGY.md, test/verify-service.example.test.js
  - Acceptance: a test runs `examples/verify-service-client.js` in a child process and asserts it exits 0 and prints an ACCEPT
    then a REJECT; a grep asserts the example imports ONLY `require("verifyhash")` / the command / relative files with NO deep
    `cli/…` and NO third-party dependency; the generic CI script is syntactically valid (`bash -n`) and, driven against a
    booted server in the test, exits non-zero on a tampered seal and zero on a clean one; `docs/VERIFY-SERVICE.md` documents
    the schema + status mapping + trust boundary and a test asserts its documented request `kind`s / response fields byte-match
    the `verifyRequest` core (no doc/code drift); STRATEGY.md P-9 gains the verify-service sub-note and still carries its 3
    human steps unchanged (a test/grep asserts the 3 steps are present). Full `npm test` green.

## EPIC-60 — INTEGRITY JOURNAL: a tamper-evident, append-only, hash-chained LOG of verify verdicts over TIME — the structurally-new "verified CONTINUOUSLY from date A to B, and here is the exact entry where one drifted" artifact that one-shot verify cannot produce  *(MATERIAL CHANGE OF DIRECTION off the one-shot verify axis. EPIC-57/58/59 are the SDK/HTTP-service distribution axis and are now SATURATED — the Manager's own note warns the scoring floor will cap "a 3rd add-another-symbol/endpoint on the SDK verify axis" at ≤2, and every existing surface — CLI verify, verify-vh, serve-verify, the SDK, the GitHub Action, the challenge — answers the SAME point-in-time question: "do these exact bytes match this seal RIGHT NOW?" and then EXITS. There is a genuinely NEW consumption shape the family has never had, and it is the category-(b) capability the floor reserves 3+ for: integrity OVER TIME. The actual buyer pain in every named vertical (forensic/e-discovery custody, release-artifact integrity, dataset-unaltered, delivery-receipt) is not a single boolean — it is an ONGOING obligation: "prove these N sealed artifacts have matched continuously since I received them, and if one EVER drifts, give me a tamper-evident RECORD of exactly when and which." CONFIRMED in the live tree there is NO such capability: `grep -rliE 'watch|monitor|continuous|integrity.?log|verify.?log'` over cli/ hits ONLY the commit-reveal `MIN_REVEAL_DELAY` "wait out" flow (cli/vh.js, cli/claim.js) and unrelated `serialize`; verify-vh's `--manifest` mode is a one-shot BATCH under one exit code, NOT a record accumulated across runs. This EPIC composes the EXISTING, already-green cores VERBATIM — `verifyRequest(body)` (cli/serve-verify.js:191, the composed verdict), `readSeal`/`verifySeal` (cli/evidence.js), and the hash-chain primitives `hashBytes`/`nodeHash` (cli/hash.js) — into an APPEND-ONLY, HASH-CHAINED journal: each run appends one entry `{seq, prevHash, ts, artifact, verdict, entryHash=hashBytes(canonical(prev+this))}`, so the log is itself tamper-evident (a deleted/edited/reordered past entry breaks the chain and a verifier LOCALIZES it), exactly the transparency-log shape the project already trusts for seals — reused, no new crypto. WHY THIS IS HIGH-LEVERAGE, NON-ORBIT, UNGATED: (a) it is a DISTINCT consumption shape (integrity-over-time, not one-shot verify) that needs NO P-8 design-partner pilot and NO sales call — a developer drops `vh journal append` into their existing CI/cron and gets a standing, verifiable record; (b) it produces a NEW deliverable a one-shot verifier cannot — a signed-chainable audit trail proving "unbroken from A to B" (the CLOSEST honest approximation of the "unaltered since date T" claim P-3 gates, WITHOUT provisioning a key: the journal proves ORDERING + CONTINUITY of the verifier's OWN observations, and remains honest that wall-clock `ts` is self-asserted until the P-3 trust-root signs/timestamps it); (c) it directly de-risks the ONE ungated funnel DECIDE.md names — today the free verifier is a ONE-TIME event with no reason to return; a standing journal the recipient RE-RUNS weekly is the recurring touchpoint that converts a one-shot free verify into a standing relationship a pilot can convert, which is the funnel's actual weakness. STRICTLY ADDITIVE + NON-REGRESSING + IN-GUARDRAILS: it VERIFIES ONLY via the existing cores VERBATIM — it NEVER signs, holds NO key, invents NO crypto/verdict vocabulary; it changes NO CLI verb, NO verdict, NO exit code, NO seal/attestation byte, NO existing test; it adds NO runtime dependency and NO network (append/verify are pure-local file ops). The journal FILE it writes is a new, opt-in artifact under a caller-chosen path — the read-only cores and index.js are untouched. REVENUE INTEGRITY: unchanged from P-9 — the journal is delivered SOFTWARE (a license/usage fee for embedders who run it in THEIR pipeline for a continuous-integrity SLA), NOT a token/coin/NFT, NOT tradeable, NOT an appreciating asset; publishing/pricing/hosting/public-deploy stay the human-owned P-9 steps, and signing/timestamping the journal's `ts` stays the human-owned P-3 trust-root. Kept to 3 tasks so it does not re-bloat the surface EPIC-56 cleaned. See STRATEGY.md "## Direction" 2026-07-01 (c).)*

- **T-60.1** `VERIFIED` Add a pure, transport/filesystem-agnostic INTEGRITY-JOURNAL CORE (a new small module, e.g. `cli/journal.js`)
  exporting `appendEntry(priorEntry|null, observation)` and `verifyJournal(entries[])`. `appendEntry` takes the PRIOR journal
  entry (or `null` for the genesis entry) plus an `observation = { ts, artifact, verdict }` where `verdict` is the EXISTING
  `verifyRequest`/`verifySeal` verdict object REUSED VERBATIM (never a new verdict vocabulary), and returns a new immutable entry
  `{ schema:"vh.integrity-journal/1", seq, prevHash, ts, artifact, verdict, entryHash }` where `prevHash` is the prior entry's
  `entryHash` (or a fixed genesis constant for `seq 0`), `seq` is `prior.seq+1` (or 0), and `entryHash = hashBytes(canonicalJSON({prevHash, seq, ts, artifact, verdict}))`
  using the EXISTING `cli/hash.js › hashBytes` and a canonical (sorted-key, deterministic) serializer REUSED from the codebase —
  NO new crypto. `verifyJournal(entries)` re-derives each `entryHash` from the entry's OWN fields and confirms every entry's
  `prevHash === entries[i-1].entryHash` and `seq` is a gap-free 0..N run, returning `{ ok, brokenAt, reason }` that LOCALIZES the
  first break (a deleted/edited/reordered/inserted entry). It NEVER throws to a transport, NEVER touches the network, NEVER signs,
  holds NO key. deps: EPIC-59 (`verifyRequest`, shipped & green); cli/hash.js `hashBytes` (shipped & green); the canonical serializer (shipped & green).
  - files: cli/journal.js, test/journal.core.test.js
  - Acceptance: `appendEntry(null, obs)` yields `seq 0` with `prevHash` = the documented genesis constant and a deterministic
    `entryHash` (same inputs ⇒ byte-identical entry); a chain of ≥3 appends verifies `ok:true` via `verifyJournal`; editing any past
    entry's `verdict`/`ts`/`artifact`, deleting an entry, reordering two, or inserting a forged entry each makes `verifyJournal`
    return `ok:false` with `brokenAt` = the FIRST broken index and a reason (proven in tests; never a false `ok:true`); a grep
    asserts `cli/journal.js` requires NO `http`/`https`/`net`/`dns` and never calls `Wallet`/reads a private key; `verdict` is
    stored VERBATIM (a test asserts the journal entry's `verdict` deep-equals the `verifyRequest` output it was built from). Full `npm test` green.

- **T-60.2** `VERIFIED` Add the `vh journal append <artifact> --to <journalfile> [--dir <d>] [--vendor <addr>]` and
  `vh journal verify <journalfile>` commands wiring the T-60.1 core to real files. `append` VERIFIES the artifact through the
  EXISTING verify path (the SAME code `vh evidence verify` / `verify-signed` runs — REUSED, no re-implementation; `--vendor`
  pins the signer exactly as elsewhere), reads the current last entry of `<journalfile>` (or starts a genesis chain if absent),
  APPENDS one new entry via `appendEntry`, and writes the journal back APPEND-ONLY (it MUST NOT rewrite/reorder prior entries — a
  test asserts prior bytes are a strict prefix-preserved subset). `verify` reads the journal and runs `verifyJournal`, printing a
  one-line PASS/FAIL that names the continuity result AND the latest per-artifact verdict, on the SHARED 0/3 CI-exit contract used
  by `verify`/`verify-attest`/`verify-timestamp` (0 = unbroken chain + latest ACCEPT; 3 = a broken chain OR a REJECT entry), with
  a `--json` machine form. The journal file format is line-delimited JSON (one entry per line, append-friendly). It NEVER signs,
  holds NO key, and binds NO network. deps: T-60.1; the existing evidence verify path (shipped & green).
  - files: cli/journal.js, cli/vh.js, test/cli.journal.test.js
  - Acceptance: `vh journal append` on a clean artifact twice yields a 2-entry chain that `vh journal verify` reports PASS/exit 0;
    tampering the artifact then `append`ing records a REJECT entry and `vh journal verify` exits 3 naming the drifted artifact +
    the seq where it drifted; hand-editing a past journal line makes `vh journal verify` exit 3 with `brokenAt`; a test asserts
    `append` is strictly additive (the pre-existing lines are unchanged byte-for-byte after a new append); `--json` emits the
    machine verdict; the exit-code contract (0/3) matches the shared verify contract (a test asserts parity). Full `npm test` green.

- **T-60.3** `VERIFIED` Make the journal a DROP-IN continuous-integrity check and document it honestly: (a) a dependency-free, Node-core-only
  `examples/journal-ci.js` that appends a verify observation for a sample artifact to a journal then verifies the whole chain,
  importing ONLY `require("verifyhash")` / the `vh` command / relative files (NO deep `cli/…`, NO third-party dependency); (b) a
  generic CI recipe `verifier/ci/journal.generic.sh` (+ a GitHub-Actions twin) that runs `vh journal append` for each release
  artifact on every build and `vh journal verify` as the gate, FAILING the build the instant the chain breaks or an artifact
  drifts — a standing, per-build continuous-integrity gate; (c) a new `docs/INTEGRITY-JOURNAL.md` (and a pointer from `README.md`
  + `docs/SDK.md`) documenting the entry schema, the hash-chain/localization guarantee, the 0/3 exit contract, and — the load-bearing
  HONESTY boundary — that the journal proves ORDERING + CONTINUITY of the verifier's OWN observations and that its wall-clock `ts`
  is SELF-ASSERTED (NOT a trusted timestamp) until the P-3 signing/timestamp trust-root signs/timestamps it (so it NEVER claims
  "unaltered since date T" unqualified); and (d) a one-line P-9 sub-note in STRATEGY.md recording the journal exists, is
  verify-only + writes only a caller-chosen file + holds no key, and that signing/timestamping its `ts` stays the human-owned P-3
  step (NO new gate, NO relaxed gate — P-9's and P-3's steps unchanged). deps: T-60.2.
  - files: examples/journal-ci.js, verifier/ci/journal.generic.sh, verifier/ci/journal.github-actions.yml, docs/INTEGRITY-JOURNAL.md, README.md, docs/SDK.md, STRATEGY.md, test/journal.example.test.js
  - Acceptance: a test runs `examples/journal-ci.js` in a child process and asserts it exits 0, appends an entry, and reports an
    unbroken chain; a grep asserts the example imports ONLY `require("verifyhash")` / the command / relative files with NO deep
    `cli/…` and NO third-party dependency; the generic CI script is syntactically valid (`bash -n`) and, driven in the test, exits
    zero on an unbroken chain and non-zero after a tampered artifact appends a REJECT; `docs/INTEGRITY-JOURNAL.md` documents the
    schema + chain guarantee + 0/3 contract AND carries the SELF-ASSERTED-`ts` / not-a-timestamp honesty boundary (a test/grep
    asserts the boundary sentence is present and that the doc never claims "unaltered since date T" without the P-3 qualification);
    STRATEGY.md P-9 gains the journal sub-note with P-9's + P-3's human steps unchanged (a test/grep asserts they are present). Full `npm test` green.

## EPIC-61 — GO-LIVE READINESS: make the built pile earn the FIRST DOLLAR through ONE bounded human flip — stop adding capability surface, converge the sprawling P-1..P-9 asks into a single decision-ready self-serve path, and PROVE the whole revenue mechanism is green end-to-end  *(MATERIAL CHANGE OF APPROACH — a VALUE-CEILING intervention, NOT another capability/verify surface. The qualityStall flag FIRED and `humanGated` has been pinned at 3 for ~20 runs while avgUsefulness sits durably ~3.5 (min 2, endReason oscillating to `frontier`). CONFIRMED this run: the verify/provenance CAPABILITY surface (CLI verify, verify-vh, serve-verify, SDK, GitHub Action, conformance vectors, independent-verifier, integrity journal) AND the MONETIZATION MECHANISM (per-product `license issue|verify|fulfill`, closed entitlement tables, plan catalogs `trustledger/plans.js` + `cli/core/evidence-plans.js › fulfillEvidenceOrder`, the free-vs-paid gate, and the full "billing webhook → license fulfill → deliver" self-serve loop DOCUMENTED in `docs/ADOPT.md`) are BOTH exhaustively shipped and green — 19K CLI lines, 145 test files, ~15 verticals. There is no unbuilt capability worth adding on this axis; building more IS the stall (the Manager's own note warns the floor caps "a 3rd add-another-symbol/endpoint" at ≤2, and DECIDE.md itself says the answer to a stalled pilot is "switch channel, NOT build more product"). The 20-run humanGated=3 ceiling is a GTM MISMATCH: the loop has been building DEVELOPER-shaped tooling (SDK/service/journal/Action) but STRATEGY monetizes it via ENTERPRISE design-partner sales (P-5/P-7/P-8 — find a broker/forensics team, CPA review, run a pilot), the HARDEST path, which no amount of autonomous product-building can move because the bottleneck is a human relationship, not a missing feature. Meanwhile the LOWER-friction self-serve path (a human wires Stripe Checkout → the EXISTING `license fulfill`, sells the paid producer surface to ANY user, no design partner, no CPA) is fully built and merely under-surfaced. This EPIC does the two things the mandate demands for a persistent value ceiling: (1) SHARPEN the blocking ask into ONE crisp, decision-ready, self-serve-first "first dollar" path a human can act on in an afternoon, and (2) ship the ONE auto-buildable artifact that de-risks that flip — an EXECUTABLE proof the whole revenue mechanism is green end-to-end, ending with the exact bounded human steps. Kept to 2 tasks so it does not re-bloat the surface EPIC-56 cleaned. STRICTLY ADDITIVE + IN-GUARDRAILS: ephemeral test keys only, NO network, NO deploy, NO real payment, NO new sellable gate, NO change to any verdict/seal/license byte or existing test. See STRATEGY.md "## Direction" 2026-07-01 (d).)*

- **T-61.1** `VERIFIED` Ship an EXECUTABLE, offline, dependency-free GO-LIVE READINESS PROOF — `scripts/go-live-check.js` (wired as `npm run go-live` and/or `vh doctor`) — that drives the WHOLE revenue mechanism end-to-end on fixtures with EPHEMERAL throwaway keys and prints a PASS/FAIL checklist ending with the EXACT remaining HUMAN steps. It must, in one run: (a) `vh evidence seal` a sample folder and confirm the INDEPENDENT verifier (`verifier/verify-vh.js`) re-derives the same root (mechanism → producer → independent-verify closes); (b) `vh evidence license issue` with an EPHEMERAL vendor key (`Wallet.createRandom()`), `verify` it, and prove the paid gate is FAIL-CLOSED — a paid feature is REJECTED without the license and ACCEPTED with it; (c) `fulfillEvidenceOrder`/`vh evidence license fulfill` a sample paid ORDER from the bundled DRAFT plan catalog and confirm the delivered signed license passes the gate (the self-serve webhook→fulfill→deliver loop works). It then prints, verbatim and last, the ONLY remaining HUMAN steps (provision a REAL vendor key OUTSIDE the loop; set the price/term in the catalog; wire Stripe Checkout → `license fulfill`; publish) and the revenue-integrity boundary. It holds NO real key, opens NO network, deploys NOTHING, takes NO payment, and writes ONLY a throwaway workspace it cleans up. deps: EPIC-30 (`vh evidence seal|verify`, shipped & green), EPIC-37 + evidence-plans (`fulfill`/`fulfillEvidenceOrder`, shipped & green), the independent verifier (shipped & green).
  - files: scripts/go-live-check.js, package.json, test/go-live-check.test.js
  - Acceptance (VERIFY-ONLY — the artifact already exists in the tree, works, and its full suite is green; confirm, do NOT re-author): (1) `scripts/go-live-check.js` exists and exports `{ main, HUMAN_STEPS, LEGS, PLAN_ID }`, requires ONLY node-core + this repo's own `cli/vh.js`/`verifier/verify-vh.js`/`cli/evidence.js` + `ethers` `Wallet` (no new dependency); (2) `node scripts/go-live-check.js` exits 0 with all THREE legs (seal→independent-verify via `verifier/verify-vh.js`; issue→verify→fail-closed-gate with an ephemeral `Wallet.createRandom()` vendor key; fulfill→deliver→gate-accept from the bundled DRAFT plan `evidence-signed-monthly`) marked PASS, prints `ALL LEGS PASS`, and emits the verbatim `HUMAN_STEPS` block (4 bounded human steps + revenue-integrity boundary) LAST; (3) each of `GO_LIVE_INJECT_FAULT=seal|gate|fulfill` exits NON-ZERO naming the broken leg and NEVER prints `ALL LEGS PASS` (not a rubber stamp); (4) guardrail greps hold — keys come ONLY from `Wallet.createRandom()` passed via `--key-env`, the script requires NONE of `http`/`https`/`net`/`dns`, and bakes in NO real key path (no 64-hex literal, no PRIVATE_KEY/MNEMONIC/keystore/pem refs); (5) hygiene — the announced throwaway `vh-golive-*` workspace is removed on exit (pass or fail) and the repo top-level listing is unchanged; (6) wired as `npm run go-live`; `test/go-live-check.test.js` (12 tests) passes under `npx hardhat test` and the FULL `npx hardhat test` suite stays green. Flip to `VERIFIED` once these hold. No code change required.
  - note: 2026-07-01 — RECONCILED a stale `BLOCKED` ("auto-build failed after 3 attempts") to `TODO`/verify-only, mirroring the T-46.1 precedent. The artifact is present in the tree (`scripts/go-live-check.js` + `test/go-live-check.test.js` + `package.json` `go-live` wiring), runs green end-to-end (`node scripts/go-live-check.js` → exit 0, all 3 legs PASS), and its 12-test acceptance suite passes under `npx hardhat test`. The 3 "failures" were a status/harness artifact, not a real engineering gap — chose reconcile-and-confirm over a 4th auto-build (re-authoring a working, tested artifact risks regression for no value). Unblocks T-61.2.
  - note: 2026-07-02 — VERIFIED (verify-only, no code change). All six acceptance criteria confirmed: (1) exports `{ main, HUMAN_STEPS, LEGS, PLAN_ID }`, requires only node-core (`fs`/`os`/`path`/`child_process`) + `ethers` `Wallet` + `cli/evidence`, driving `cli/vh.js` and `verifier/verify-vh.js` via `spawnSync`; (2) `node scripts/go-live-check.js` → exit 0, all 3 legs PASS, `ALL LEGS PASS` printed, verbatim `HUMAN_STEPS` block (4 human steps + revenue-integrity boundary) last; (3) each of `GO_LIVE_INJECT_FAULT=seal|gate|fulfill` → exit 1, names the broken leg, never prints `ALL LEGS PASS`; (4) guardrail greps clean — no `http`/`https`/`net`/`dns` require, no 64-hex literal, no PRIVATE_KEY/MNEMONIC/keystore/pem refs, keys only `Wallet.createRandom()` via `--key-env`; (5) no `/tmp/vh-golive-*` leftovers after pass OR injected-fail runs, repo top-level listing unchanged; (6) `npm run go-live` wired, `test/go-live-check.test.js` 12/12 green, full `npx hardhat test` suite green (3314 passing).

- **T-61.2** `VERIFIED` (RESCOPED 2026-07-01 (f) — the decision-ready page ALREADY SHIPPED; DESCOPE the generator/drift-test; residual = the one discoverability pointer that serves the persistent-humanGated mandate.) Make the already-shipped decision-ready `docs/GO-LIVE.md` "first dollar" page DISCOVERABLE from the repo front door. Add ONE one-line pointer from `README.md`'s top matter to [`docs/GO-LIVE.md`](docs/GO-LIVE.md), presenting the self-serve evidence license as the recommended lowest-friction first-dollar path and the P-8 design-partner pilot as the enterprise fallback. That is the whole task now. Confirm (grep) that NO existing P-proposal human step was deleted or relaxed (P-3/P-5/P-6/P-7/P-8 still present). deps: T-61.1 (the readiness proof the page cites — go-live-check.js, green).
  - note: 2026-07-01 (f) — the CORE deliverable (a single-screen, decision-ready `docs/GO-LIVE.md` with the 4 bounded human steps + exact commands, self-serve-first with the pilot as enterprise fallback, and the revenue-integrity boundary sentence, citing `npm run go-live`) ALREADY SHIPPED in commit c90e578 (as the T-62.2 pointer target) and is honest + complete. DESCOPED the originally-specified `scripts/sync-golive.cjs` generator + byte-identical drift-test: building a code-generator to prevent drift of a rarely-changing ~49-line doc is exactly the low-leverage incremental work the FIRED qualityStall forbids this run (the panel floor caps such polish ≤2). Also DROPPED the `docs/DECIDE.md` pointer — that file does not exist (`scripts/sync-decide.cjs` generates a different artifact). The ONLY residual kept is the genuinely value-adding, human-ceiling-serving bit: making the sharpened ask FINDABLE from README (a sharpened ask nobody can find is not sharp). See STRATEGY.md "## Direction" 2026-07-01 (f).
  - files: README.md
  - Acceptance: `README.md` contains a one-line pointer to `docs/GO-LIVE.md` presenting self-serve as the recommended default and the pilot as the enterprise fallback; `docs/GO-LIVE.md` is unchanged (still the shipped decision-ready page citing `npm run go-live`); a grep confirms no P-3/P-5/P-6/P-7/P-8 human step was deleted or relaxed. Full `npm test` green. (No generator, no new test file, no code change beyond the README line.)
  - note: 2026-07-02 — VERIFIED. The one-line pointer added to README.md (line 12, between the intro and Install/Quickstart section), linking `docs/GO-LIVE.md` as the "decision-ready 'first dollar' page", presenting `npm run go-live` (self-serve evidence license) as the recommended default and the design-partner pilot as the enterprise fallback. docs/GO-LIVE.md is byte-unchanged; git diff shows README.md only (2 insertions: the pointer line + blank line). Grep confirms all P-3/P-5/P-6/P-7/P-8 human steps remain intact in STRATEGY.md and docs/GO-LIVE.md still cites needs-human › P-7. Full `npm test` suite: 3314 passing, 0 failing. Discoverability test suite (T-61.2: docs/GO-LIVE.md is DISCOVERABLE + accurate from the repo front door) added to test/go-live-check.test.js, all 5 tests green. Commit 32a4578.

- **T-61.3** `VERIFIED` Ship an OFFLINE, dependency-free GO-LIVE CONFIG PREFLIGHT that validates the operator's OWN self-serve
  revenue config end-to-end — `vh evidence go-live-preflight --binding <file> [--catalog <file>] (--key-env <VAR>|--key-file <path>) [--secret-env <VAR>] [--json]`
  (a small `cli/core/go-live-preflight.js` + `cli/vh.js` wiring that COMPOSES the T-62.1 intake core + `fulfillEvidenceOrder` +
  the existing evidence-license gate VERBATIM). This is the mandate's endorsed VALUE-CEILING move (auto-buildable work that
  de-risks the blocking proposal once the human acts), NOT another verify/consumption surface. Unlike `npm run go-live` (which
  proves the MECHANISM against the bundled DRAFT catalog `evidence-signed-monthly`/`baseline.json` with ephemeral
  `Wallet.createRandom()` keys), this validates the human's REAL price→plan binding, REAL plan catalog, and REAL vendor key so a
  config typo cannot silently cause "customer PAID, no license delivered." For EACH price in `--binding` it: (1)
  `validateEvidencePriceBinding` + `resolveEvidencePlanId` against the catalog — an unmapped / duplicate / typo'd price is a
  NAMED failure, never a silent default plan; (2) if `--secret-env` is given, synthesizes a properly-signed provider event for
  that price and runs `verifyProviderSignature → parseEvidenceEvent → normalizeEvidenceEvent` so the operator's OWN secret +
  binding parse the event exactly as the deployed `vh fulfill-webhook` will (a signature/parse failure is a NAMED reject); (3)
  drives `fulfillEvidenceOrder`, signs with the operator's key (`--key-env`/`--key-file`, read-used-discarded, NEVER
  persisted/logged), and confirms the delivered `*.vhlicense.json` PASSES the existing `vh evidence license verify` gate for the
  mapped plan — i.e. a real customer paying that price WILL receive a license that unlocks the paid surface. It prints per-price
  PASS or the exact broken step, and a final "N/N prices deliver a valid license; ready to deploy `vh fulfill-webhook`" (exit 0)
  or "FIX <price>: <reason>" (non-zero). It holds NO real key beyond the human-provisioned one it reads-and-discards, opens NO
  network (drives the pure intake pipeline directly — NO HTTP server, NO provider call), deploys nothing, and cleans up any temp
  workspace. deps: T-62.1 (intake core, shipped & green), EPIC-37 + `cli/core/evidence-plans.js` (`fulfillEvidenceOrder`, shipped
  & green), the evidence-license gate (shipped & green). **Reuses existing cores VERBATIM — NO new crypto/verdict/mechanism;
  ephemeral test keys only; NO network/deploy/payment; NO new sellable gate; NO change to any verdict/seal/license byte or
  existing test; NO new `needs-human` item beyond the ALREADY-listed provision-key/set-price/deploy steps.**
  - files: cli/core/go-live-preflight.js, cli/vh.js, test/cli.go-live-preflight.test.js
  - Acceptance: with a SYNTHETIC binding+catalog mapping ≥2 prices to evidence plans, a SYNTHETIC webhook secret, and an
    ephemeral `Wallet.createRandom()` vendor key: (1) `vh evidence go-live-preflight` exits 0 and reports every price delivers a
    license that PASSES the existing gate for its mapped plan; (2) a binding with an UNMAPPED / duplicate / typo'd price exits
    non-zero NAMING the offending price (never a silent default plan); (3) with `--secret-env` set, a price whose synthesized
    event fails signature/parse is NAMED (the operator's real secret path is exercised, fail-closed); (4) a delivered license
    whose mapped plan LACKS the paid entitlement is caught by the gate (reported FAIL, never PASS); (5) guardrail greps — the
    module imports NONE of `http`/`https`/`net`/`dns`, the vendor key comes ONLY from `--key-env`/`--key-file` and is never
    written to disk/logs, and any temp workspace is removed on exit (pass or fail); (6) `--json` emits the machine verdict and the
    command is wired into `vh` help; the exit contract distinguishes 0 (all prices deliver) from non-zero (a config error).
    `test/cli.go-live-preflight.test.js` passes and the FULL `npm test` suite stays green.

## EPIC-62 — De-risk the ONE remaining human CODE step on the recommended self-serve revenue path: ship a tested, dependency-free REFERENCE FULFILLMENT WEBHOOK so the human's "wire Stripe Checkout → `vh evidence license fulfill`" collapses from *write-and-secure-your-own-endpoint* to *set two env vars + fill a price→plan map + deploy*  *(CONTINUES the EPIC-61 value-ceiling intervention — NOT more product/verify surface. The qualityStall flag FIRED again and `humanGated` is STILL pinned at 3 with the pile fully green and the T-61.1 go-live-check green — exactly the juncture the 2026-07-01 (d) Direction note pre-committed to. Rather than add another consumption shape (the pattern that produced the decline), this EPIC does the mandate's endorsed move for a persistent value ceiling: `prefer auto-buildable work that de-risks or directly unblocks the blocking proposal once the human acts.` SURVEY CONFIRMED a genuine, non-duplicative GAP on the LOWEST-friction path GO-LIVE.md recommends (self-serve evidence license): the mechanism has `fulfillEvidenceOrder(order, catalog)` (order→license-params, pure) but the EVIDENCE vertical has NO price→plan binding / event parser (`validatePriceBinding`/`resolvePlanId`/`normalizeEvent` exist ONLY in `trustledger/license.js`+`plans.js`, not for evidence) AND there is NO provider-signature verification (Stripe `t=,v1=` HMAC) ANYWHERE in the tree — it was DELIBERATELY left as "a HUMAN step" (see `trustledger/license.js` normalizeEvent comment). So today the "wire Stripe → fulfill" step still forces the human to WRITE and SECURE integration code (raw-body read + Stripe signature verify + event parse + price→plan map + call fulfill + idempotency + deliver) — the ONE step on the self-serve path that is code, not config. Every other step (provision key, set price, publish) is provisioning. Shipping a tested reference handler removes the loop's LAST auto-buildable friction on the first-dollar flip. This is structurally NEW revenue-GLUE, not another verifier/journal surface. STRICTLY ADDITIVE + IN-GUARDRAILS, mirroring the panel-approved `serve-verify` posture (EPIC-59, scored 4/5): loopback-only, ZERO new dependency (node-core `crypto`/`http` only), ephemeral test secret + `Wallet.createRandom()` vendor key in tests ONLY, the server RECEIVES but NEVER calls out, NO deploy, NO real payment, NO real key/secret ever held, NO change to any verdict/seal/license byte or existing test. Kept to 2 tasks (pure-core + HTTP-wrapper+docs), the same shape as EPIC-59, so it does not re-bloat the surface. See STRATEGY.md "## Direction" 2026-07-01 (e). PRE-COMMIT: this is the FINAL auto-buildable de-risking of the self-serve path — if `humanGated` is still 3 after EPIC-61 + EPIC-62 ship green, the correct next Strategist output is `newTasks: []` with a pointer to `docs/GO-LIVE.md`, NOT more surface.)*

- **T-62.1** `VERIFIED` Add a pure, transport-agnostic SELF-SERVE FULFILLMENT-INTAKE core (a new small module, e.g. `cli/core/fulfill-intake.js`) that closes the two missing pure seams between a raw billing-provider webhook and the shipped `fulfillEvidenceOrder`, with NO I/O, NO system clock (all instants injected), and NO new dependency (node-core `crypto` only). It must export: (a) `verifyProviderSignature({ rawBody, header, secret, toleranceSec, now })` — implements the Stripe-style `t=<unixSeconds>,v1=<hexHmac>[,v1=…]` scheme: compute `HMAC-SHA256(secret, `${t}.${rawBody}`)` and CONSTANT-TIME-compare (`crypto.timingSafeEqual`) against each provided `v1`, and REJECT when `|now - t| > toleranceSec`; returns `{ ok, reason }` with localized reasons (`missing_signature` / `malformed_signature` / `bad_signature` / `timestamp_out_of_tolerance`), NEVER throwing on attacker-controlled input and NEVER logging the secret; (b) `parseEvidenceEvent({ rawBody, provider })` — parse a raw Stripe `checkout.session.completed` / `invoice.paid` (and a documented `generic` shape) JSON body into the normalized envelope `{ provider, type, priceId, customer, periodEnd }` (bounded, defensive: malformed/oversized/unknown-type bodies are NAMED rejects, never a half-parse); (c) `validateEvidencePriceBinding(obj)` + `resolveEvidencePlanId(binding, provider, priceId)` — the evidence-vertical price→plan binding mirroring `plans.validatePriceBinding`/`resolvePlanId` (strictly validated; an unmapped `(provider, priceId)` is its NAMED reject, never a silent default plan); (d) `normalizeEvidenceEvent(event, binding, opts?)` — map the envelope onto the EXACT `{ plan, customer, paidThrough, issuedAt }` order `fulfillEvidenceOrder` consumes (analogue of `trustledger` `normalizeEvent`; `periodEnd` epoch-seconds → canonical ISO `paidThrough`; `issuedAt` from `opts`/`event`, NEVER the system clock); (e) `intakeDedupKey(orderOrEvent)` — a deterministic idempotency key so a re-delivered webhook mints the SAME license, not a second one. deps: EPIC-37 + `cli/core/evidence-plans.js` (`fulfillEvidenceOrder`, shipped & green), the shipped `trustledger` binding/normalize precedent to mirror. **All PURE + deterministic; NO new crypto scheme (reuses `crypto.createHmac`/`timingSafeEqual`); NO real secret/key ever touched; NO new `needs-human` item.**
  - files: cli/core/fulfill-intake.js, test/cli.fulfill-intake.test.js
  - Acceptance: the module exports the 5 functions above and requires ONLY node-core + this repo's `cli/core/evidence-plans.js`/`plans` (no new dependency). Tests prove, with a SYNTHETIC secret + SYNTHETIC events (never a real key/secret): (1) `verifyProviderSignature` ACCEPTS a correctly-signed `${t}.${rawBody}` and REJECTS — with the right localized reason — a missing header, a malformed header, a wrong/forged `v1`, and a `t` outside `toleranceSec` (proving replay-window + forgery resistance), using constant-time compare and never throwing on hostile input; (2) `parseEvidenceEvent` maps a real-shaped Stripe `checkout.session.completed`/`invoice.paid` body to `{ provider, type, priceId, customer, periodEnd }` and NAMED-rejects malformed/oversized/unknown-type/duplicate-field bodies; (3) `validateEvidencePriceBinding` accepts a valid binding and rejects an unknown-plan / duplicate-price / malformed binding, and `resolveEvidencePlanId` NAMED-rejects an unmapped `(provider, priceId)`; (4) `normalizeEvidenceEvent(parse(...), binding)` fed to `fulfillEvidenceOrder(order, catalog)` yields a byte-identical license-params object across repeated runs (pure, no clock leak), and `paidThrough` equals the canonical ISO of `periodEnd`; (5) `intakeDedupKey` is stable for the same event and distinct for a different customer/price/period. `test/cli.fulfill-intake.test.js` passes and the FULL `npm test` suite stays green.

- **T-62.2** `VERIFIED` Wire the T-62.1 intake core into a tiny Node-core, ZERO-new-dependency, LOOPBACK-only REFERENCE FULFILLMENT WEBHOOK and document it honestly as the drop-in that removes the human's last code step. (a) Add `vh fulfill-webhook [--port <n>] [--host <127.0.0.1>] [--max-body <bytes>] --secret-env <VAR> --binding <file> (--key-env <VAR>|--key-file <path>) --out <dir> [--catalog <file>]` (a small `cli/fulfill-webhook-http.js` mirroring `cli/serve-verify-http.js`): on each POST it reads the RAW body bounded by `--max-body`, runs `verifyProviderSignature` (secret from `--secret-env`; unsigned/forged/stale → HTTP 400/401 with the localized reason, NEVER fulfilling), `parseEvidenceEvent` → `normalizeEvidenceEvent` (binding from `--binding`) → `fulfillEvidenceOrder` (catalog from `--catalog` or the bundled DRAFT), signs the result with the vendor key from `--key-env`/`--key-file` (read-used-discarded, NEVER persisted or logged), writes the delivered `*.vhlicense.json` to `--out` IDEMPOTENTLY keyed on `intakeDedupKey` (a re-delivered event returns the SAME license, HTTP 200, not a duplicate), and responds `{ delivered, licenseId }` on 200 or a localized reason on 4xx; it binds LOOPBACK by default, makes NO outbound network call, and holds NO real key/secret. (b) Add a `docs/EVIDENCE.md` (and a one-line pointer from `docs/GO-LIVE.md` step 3) section "Reference self-serve fulfillment webhook" that documents the command, the `--binding` price→plan file schema, and states VERBATIM the honesty boundary: the loop ships this reference handler + its OFFLINE tests (synthetic secret + ephemeral `Wallet.createRandom()` key) — provisioning the REAL provider webhook secret, the REAL vendor key, and DEPLOYING the endpoint behind your own URL/TLS remain the human-owned steps; and restate the revenue-integrity line (the license is an ACCESS credential for delivered software value — NOT a token/coin/NFT, not tradeable). (c) A docs-rot test pins that the doc names `vh fulfill-webhook`, describes the `--secret-env`/`--binding`/`--key-env`/`--out` flow, and carries the boundary sentence verbatim. deps: T-62.1; EPIC-59 (`serve-verify` HTTP/loopback posture to mirror, shipped & green); EPIC-30/37 evidence license `issue`/`fulfill` (shipped & green). **ZERO new dependency (node-core `http`/`crypto`); loopback-only; the server never calls out; ephemeral secret/key in tests ONLY; NO real payment; NO change to any existing license/seal byte or test; NO new `needs-human` item beyond the ALREADY-listed provision-key/set-secret/deploy steps.**
  - files: cli/fulfill-webhook-http.js, cli/vh.js, docs/EVIDENCE.md, docs/GO-LIVE.md, test/cli.fulfill-webhook.test.js, test/cli.fulfill-webhook.docs.test.js
  - Acceptance: `vh fulfill-webhook` starts on a loopback port; a test drives it end-to-end over `http` on `127.0.0.1` with a SYNTHETIC signing secret + an ephemeral `Wallet.createRandom()` vendor key and proves: (1) a correctly-signed POST carrying a Stripe-shaped paid event delivers a signed `*.vhlicense.json` to `--out` that PASSES the existing `vh evidence license verify` / free-vs-paid gate for the plan the `--binding` maps the price to, responding 200 `{ delivered, licenseId }`; (2) an UNSIGNED / FORGED-signature / STALE-timestamp POST responds 4xx with the localized reason and delivers NOTHING (fail-closed); (3) an oversized body (> `--max-body`) and a malformed/unknown-type body are NAMED-rejected without fulfilling; (4) re-POSTing the SAME event returns the SAME `licenseId` (idempotent — no duplicate license); (5) guardrail greps — the server binds loopback by default, makes no outbound request, and the vendor key/secret come only from `--key-env`/`--key-file`/`--secret-env` and are never written to disk or logs; (6) the docs-rot test in (c) holds. `test/cli.fulfill-webhook.test.js` + `test/cli.fulfill-webhook.docs.test.js` pass and the FULL `npm test` suite stays green.

## EPIC-63 — Turn the just-shipped integrity JOURNAL (EPIC-60) into an auditable TRANSPARENCY LOG: add an ordered (RFC-6962 / Certificate-Transparency / Sigstore-Rekor-style) Merkle-log layer with a publishable tree head + compact INCLUSION and append-only CONSISTENCY proofs a third party can verify OFFLINE against the head — without downloading the whole log or trusting the operator  *(A HIGHER-LEVERAGE, structurally-NEW capability on the NEW integrity-over-time axis EPIC-60 opened — NOT more of the dammed self-serve/verify surface that produced the qualityStall decline. Both triggers fired again (avgUsefulness `4→3.88→3.63→3.75→2.5→3.38`, durably ~3.5 / min 2; `humanGated` pinned at 3 the entire window), and the prior notes pre-committed to `newTasks:[]`. But that pre-commit was already OVERTAKEN BY EVENTS: the same loop then invented + shipped EPIC-60 (the journal) as a legitimate category-(b) new axis — proof that genuine, non-orbit capability still exists to build. DECISIVE TECHNICAL GAP (surveyed this run): the repo's ONLY Merkle tree (`cli/hash.js buildTree`/`proofForIndex`, `verifier/lib/merkle.js rootFromLeaves`) is SORTED-leaf + SORTED-pair (`nodeHash` orders `a<=b`) — deliberately order-INDEPENDENT for a file SET, and therefore STRUCTURALLY UNABLE to bind a leaf to a POSITION or to prove one log is an append-only PREFIX of a later one; the journal (EPIC-60) is only a hash-CHAIN, which proves append-only-ness ONLY if you hold ALL entries. A CONSISTENCY proof — the primitive that lets an untrusting auditor confirm append-only-ness between two published heads in O(log n) WITHOUT the full log — exists NOWHERE in the tree. This EPIC adds the ORDERED (position-preserving, RFC-6962 domain-separated leaf 0x00 / node 0x01, NO sorting) Merkle-log variant + inclusion + consistency proofs + an OFFLINE, journal-LESS auditor verifier. WHY THIS IS CATEGORY-(b), NOT ORBIT POLISH: it is not another symbol on the dammed license/webhook/verify path — it opens a genuinely NEW deployment/consumption shape (publish a small tree head periodically; ANY third party audits inclusion + append-only-ness with compact proofs, revealing no other entries and trusting no operator), the exact model CT/Rekor monetize as supply-chain / SOC2 / EU-AI-Act provenance-over-time evidence. STRICTLY ADDITIVE + IN-GUARDRAILS: reuses the trusted `hashBytes` keccak core VERBATIM (NO new crypto library, ZERO new dependency), pure + deterministic + fully offline-testable, holds NO key, opens NO socket, deploys nothing, changes NO existing seal/verdict/chain/journal byte or test. It also SHARPENS P-3: the 32-byte tree head is the natural single artifact a human signs/timestamps to assert "the log as of size n existed at time T," collapsing "sign the whole log" to "sign the head" — but it does NOT move `humanGated` (the first-dollar flip still depends on the human executing `docs/GO-LIVE.md`); this is additive capability value, not a substitute for that flip. Kept to 3 tight tasks (pure core → CLI + offline auditor → docs) so it does not re-bloat surface. See STRATEGY.md "## Direction" 2026-07-01 (g).)*

- **T-63.1** `VERIFIED` Add a pure, transport/filesystem-agnostic ORDERED MERKLE-LOG CORE — a new `cli/journal-log.js` (kept SEPARATE from the hash-chain core `cli/journal.js` so each stays single-purpose; PURE — NO fs/http/net/dns, NO key) — implementing an RFC-6962 / Certificate-Transparency-style POSITION-PRESERVING Merkle tree over the journal's ordered entry hashes. It reuses `hashBytes` (keccak256) from `cli/hash.js` VERBATIM (NO new crypto, NO new dependency) with RFC-6962 domain separation: `leafHash(entryHashHex) = hashBytes(0x00 ‖ bytes(entryHash))` and `nodeHash(l,r) = hashBytes(0x01 ‖ l ‖ r)` — NODES ARE NOT SORTED (left/right position is load-bearing; this is the crucial difference from `cli/hash.js buildTree`, whose sorted-pair tree cannot bind position or support consistency proofs — a comment/test must state the two are intentionally distinct). Exports: (a) `treeHead(leaves[])` → `{ size, root }` over the leaves in ORDER (leaf i = the journal's seq-i entryHash; empty log → a documented `EMPTY_ROOT` constant); (b) `inclusionProof(leaves[], i)` → `{ leafIndex:i, size, path:[…] }` (the RFC-6962 audit path for leaf i); (c) `verifyInclusion({ leaf, leafIndex, size, path, root })` → `true|false` — RE-DERIVES the root from `leaf` + `path` + `(leafIndex,size)` and returns false on ANY mismatch (fail-closed: NEVER a false accept, NEVER throws on hostile input); (d) `consistencyProof(leaves[], m, n)` → `path:[…]` (the RFC-6962 §2.1.2 proof that the size-`m` tree is a prefix of the size-`n` tree, `0 < m ≤ n`); (e) `verifyConsistency({ m, rootM, n, rootN, proof })` → `true|false` — confirms `rootM` and `rootN` are consistent (size-m is an append-only prefix of size-n) and returns false on any deviation (fail-closed). deps: EPIC-60 (`cli/journal.js` entry/entryHash shape, shipped & green); `cli/hash.js hashBytes` (shipped & green). **PURE + deterministic; reuses the project's own keccak; NO new dependency; NO key/network/fs; NO change to any existing module.**
  - files: cli/journal-log.js, test/journal-log.core.test.js
  - Acceptance (VERIFY-ONLY — the artifact exists and is complete; CONFIRM the criteria below, do not re-author): (1) `cli/journal-log.js` exports the 5 required functions (`treeHead`/`inclusionProof`/`verifyInclusion`/`consistencyProof`/`verifyConsistency`) plus the documented `EMPTY_ROOT`, and requires ONLY `./hash` + `ethers` byte helpers — a static grep in the test confirms it imports NONE of `fs`/`http`/`https`/`net`/`dns`/`tls`/`dgram` and does no `Wallet`/keyfile work. (2) leaf/node domain separation is RFC-6962 `0x00`/`0x01` with children folded in TREE ORDER (NOT sorted); a test demonstrates the root DIFFERS from the sorted-pair `cli/hash.js buildTree` root when order matters (position-preservation), empty log → `EMPTY_ROOT`, single-leaf root = `leafHash(leaf0)`. (3) for every `i` in a size-`n` log `verifyInclusion` ACCEPTS the honest `inclusionProof` against `treeHead(leaves).root` and REJECTS a tampered leaf / wrong `leafIndex` / truncated-or-extended path / replay against a different `size`|`root` (never a false accept, never throws). (4) for every `0<m≤n` `verifyConsistency` ACCEPTS the honest `consistencyProof(leaves,m,n)` between `treeHead(leaves[0:m]).root` and `treeHead(leaves).root` and REJECTS a rewritten-past-leaf / reordered-prefix — proving append-only-ness WITHOUT the full log. (5) all functions are pure (no I/O, no clock, no randomness) and TOTAL on adversarial input (generators return `null`, verifiers return `false`). (6) `npx hardhat test test/journal-log.core.test.js` is green (33/33) AND the FULL `npx hardhat test` suite is green — the earlier full-suite RED was an UNRELATED STRATEGY.md doc-size-guard failure (T-56.2/T-56.3), reconciled by running `scripts/archive-direction.cjs` + regenerating the frozen fixtures, NOT a defect in this core. Flip to `VERIFIED` once all six hold. Test command: `npx hardhat test`.
  - Note: 2026-07-01 — Decider RECONCILED stale `BLOCKED`→`TODO` (verify-only), NOT re-authored. The core is complete and its targeted test passes 33/33; the "full suite RED" was 16 failures ALL in `test/strategy.archive.test.js` (T-56.2) and `test/strategy.size-guard.test.js` (T-56.3) — STRATEGY.md over the doc-size budget after the Strategist appended the 2026-07-01 (f)/(g) `## Direction` notes without archiving (3 live entries > max 2; frozen no-loss fixtures gone stale) — with ZERO failures in `journal-log.js`. Fixed by the standing per-task self-heal (`scripts/archive-direction.cjs` heal to 1 live entry + regenerate `test/fixtures/strategy-{direction,logsections}-original.json`), exactly the T-46.1 / T-61.1 reconcile pattern. See STRATEGY.md › Decisions 2026-07-01 (T-63.1).

- **T-63.2** `VERIFIED` Wire the T-63.1 core into the `vh journal` surface (extend `cli/journal-cli.js` + `cli/vh.js`) as four strictly-additive, verify-only subcommands over the on-disk JSONL journal, PLUS an OFFLINE, journal-LESS third-party auditor path. Add: (a) `vh journal tree-head <journalfile> [--json]` — read the journal, compute `treeHead` over its ordered entry hashes, and print the publishable Signed-Tree-Head-SHAPED commitment `{ size, root }` (with the SAME honesty note the journal already carries: the head is SELF-ASSERTED until a P-3 trust-root signs/timestamps it — it does NOT by itself prove "existed at time T"); (b) `vh journal prove-inclusion <journalfile> --seq <i> [--out <f>] [--json]` — emit a compact, self-contained inclusion-proof artifact `{ kind:"vh-journal-inclusion", leaf, seq, size, root, path[] }`; (c) `vh journal prove-consistency <journalfile> --from <m> [--out <f>] [--json]` — emit `{ kind:"vh-journal-consistency", first:{size:m,root}, second:{size:n,root}, proof[] }` (n = current size); (d) `vh journal check-proof <prooffile> [--json]` — an OFFLINE verifier that reads ONLY the proof artifact (NO journal, NO key, NO network) and calls `verifyInclusion`/`verifyConsistency` for the artifact's `kind`, printing ACCEPTED / REJECTED on the SHARED 0/3 CI-exit contract (0 = proof verifies, 3 = proof fails, 2 = usage, 1 = IO) — this is the third-party AUDITOR command: hand them a tree head + a proof file, they confirm inclusion/append-only-ness without your log. All four are read-only and additive; append/verify/chain bytes are unchanged. deps: T-63.1; EPIC-60 (`cli/journal-cli.js` readJournalFile / dispatcher / 0/3 contract, shipped & green). **Read-only + verify-only; holds NO key; binds NO network; NO change to append/verify or any existing test.**
  - files: cli/journal-cli.js, cli/vh.js, test/cli.journal-log.test.js
  - Acceptance: on a journal with ≥3 appended entries, `vh journal tree-head` prints `{ size, root }` matching `treeHead` of the parsed entries (and carries the self-asserted-head honesty note); `vh journal prove-inclusion --seq <i>` emits an artifact that `vh journal check-proof` ACCEPTS (exit 0) and that check-proof REJECTS (exit 3) after a single byte of `leaf`/`root`/`path` is edited; append 2 MORE entries, then `vh journal prove-consistency --from <oldSize>` emits an artifact `check-proof` ACCEPTS (exit 0), while a consistency artifact whose `second.root` is swapped for a root of a log that REWROTE a past entry is REJECTED (exit 3); `check-proof` reads ONLY the proof file (a test runs it with NO journal present and asserts it neither opens the journal nor any socket); the 0/3/2/1 exit contract matches the shared verify contract (a test asserts parity); `--json` emits the machine verdict for every subcommand. `test/cli.journal-log.test.js` passes and the FULL `npm test` suite stays green.

- **T-63.3** `VERIFIED` Document the transparency-log capability HONESTLY and make it discoverable: extend `docs/INTEGRITY-JOURNAL.md` with a "Transparency-log proofs (publish a tree head; auditors verify offline)" section that (a) explains the ORDERED RFC-6962 / Certificate-Transparency / Sigstore-Rekor lineage and why it differs from the sorted file-SET tree (`cli/hash.js`); (b) documents the `tree-head` / `prove-inclusion` / `prove-consistency` / `check-proof` commands, the proof-artifact schemas, and the 0/3 exit contract; (c) walks a COPY-PASTEABLE worked example end-to-end (append 3 observations → `tree-head` → `prove-inclusion --seq 1` → `check-proof` (offline) → append 2 more → `prove-consistency --from 3` → `check-proof` (offline)); (d) states the LOAD-BEARING honesty boundary VERBATIM: inclusion proves an observation is committed at a position under a given head; consistency proves the log is append-only between two heads; the tree head itself is SELF-ASSERTED (the verifier's own commitment) and does NOT prove "existed / unaltered since date T" until the P-3 signing/timestamp trust-root SIGNS the 32-byte head — and NOTE that signing the head is exactly the P-3 collapse of "sign the whole log" to "sign 32 bytes" (NO new gate, NO relaxed gate; P-3's + P-9's human steps unchanged). Add a one-line pointer from `README.md` and `docs/SDK.md` to the new section. deps: T-63.2. **Docs + honesty boundary only; NO code change; NO new `needs-human` gate; P-3/P-9 steps unchanged.**
  - files: docs/INTEGRITY-JOURNAL.md, README.md, docs/SDK.md, test/journal-log.docs.test.js
  - Acceptance: `docs/INTEGRITY-JOURNAL.md` gains the transparency-log section documenting the 4 commands + proof schemas + the RFC-6962 lineage + the worked example; a docs-rot test (`test/journal-log.docs.test.js`) asserts the doc names `tree-head`/`prove-inclusion`/`prove-consistency`/`check-proof`, describes inclusion AND consistency, and carries the self-asserted-head / not-a-timestamp honesty sentence VERBATIM (and never claims "unaltered since date T" without the P-3 qualification); a grep confirms `README.md` + `docs/SDK.md` point to the section and that NO P-3/P-9 human step was deleted or relaxed. Full `npm test` green.

## EPIC-64 — Make the transparency log EQUIVOCATION-RESISTANT: independent WITNESS co-signing of tree heads + an offline SPLIT-VIEW (fraud-proof) detector, so a third party need not trust the log OPERATOR at all  *(The KEYSTONE capability on the NEW integrity-over-time axis EPIC-60/63 opened — a structurally-new SECURITY PROPERTY and a new ROLE, NOT another consumption shape of the dammed verify/license/webhook core that produced the qualityStall decline. Both triggers fired again this run (avgUsefulness window `3.88→3.63→3.75→2.5→3.38`, durably ~3.5 / min 2; `humanGated` pinned at 3 the whole window). The mandate's response to a fired qualityStall is "propose a HIGHER-LEVERAGE capability, a pivot, or removing what isn't paying off" — and this is precisely a higher-leverage capability, on the axis the loop itself already validated as a legitimate category-(b) escape when it invented + shipped EPIC-60/63. DECISIVE TECHNICAL GAP surveyed this run: EPIC-63 shipped inclusion + consistency proofs (`cli/journal-log.js`, 33/33), which prove things RELATIVE to a tree head an auditor was HANDED — but they do NOTHING to stop the log OPERATOR from equivocating: maintaining two divergent logs and showing head-A to auditor-X and an inconsistent head-B to auditor-Y (a "split view"). Inclusion/consistency alone therefore still require TRUSTING the operator not to fork. This is the exact gap Certificate-Transparency, Sigstore/Rekor, and the Go checksum database close with an INDEPENDENT WITNESS that co-signs each tree head only after checking it is CONSISTENT with the last head it endorsed (refusing to co-sign a rewrite), plus GOSSIP so two parties can compare heads and, if the operator ever equivocated, produce a NON-REPUDIABLE fraud proof (two operator-signed, mutually-inconsistent checkpoints). Nowhere in the tree is there a witness/checkpoint/co-signature/split-view concept (grep confirmed). WHY THIS IS CATEGORY-(b), NOT ORBIT POLISH: it introduces a NEW ROLE (an independent witness) and a NEW trust property (equivocation-resistance / "nobody has to trust the operator") that NONE of the existing tooling provides — it is not "verify the same seal a different way." It also pre-answers the deepest security/procurement objection to ANY provenance-log claim ("what stops YOU, the operator, from lying / keeping two logs?"), which de-risks the go-to-market on its own axis, and it opens a materially LOWER-gated distribution model than the standing design-partner pilot (a public-good log + paid enterprise witness/monitor SLAs — see STRATEGY.md P-10). STRICTLY ADDITIVE + IN-GUARDRAILS: reuses the SHIPPED `cli/journal-log.js verifyConsistency`/`treeHead` (T-63.1) VERBATIM and the SHIPPED `cli/core/attestation.js` `loadSigningWallet`/`recoverSigner` signing/recovery core VERBATIM — NO new crypto, ZERO new dependency; pure + deterministic + fully offline-testable; ephemeral `Wallet.createRandom()` keys in tests ONLY; the human's real signing key is read-used-discarded via `--key-env`/`--key-file` exactly like every existing `sign` command; holds NO key, opens NO socket, deploys nothing, takes NO payment, and changes NO existing seal/verdict/chain/journal/proof byte or test. Kept to 3 tight tasks (pure witness/checkpoint core → CLI witness + offline detector → docs+honesty boundary), the panel-approved EPIC-59/60/63 shape, so it does not re-bloat surface. It SHARPENS P-3 (the 32-byte co-signed checkpoint is the natural artifact a trust-root signs/timestamps) but does NOT move `humanGated`'s first-dollar flip. See STRATEGY.md "## Direction" 2026-07-01 (i).)*

> **PARKED 2026-07-02 (k) — Strategist (freeze the declining vein; do NOT build).** The qualityStall trigger FIRED again this run and the post-note-(j) data CONFIRMS that draining the integrity-over-time vein did not help (avgUsefulness `…3.75→2.5→3.38`, min pinned at 2; `humanGated`=3 for ~20 runs). T-64.1/2/3 are a fully-UNBUILT 9th provenance primitive on the EXACT axis the panel has scored ~3.4/min-2 — building it IS the "more incremental items in the same vein that produced the decline" the fired trigger FORBIDS; here, building it is the stall. This is a status-only freeze (NO code touched; the suite stays green). EPIC-63's core (`cli/journal-log.js`, 33/33) is already sunk-built, so its thin remaining wiring/doc (T-63.2/T-63.3) may finish so that core is not stranded — but NO NEW provenance mechanism is authorized. UN-PARK only when a PAYING customer pulls equivocation-resistance (concrete demand), never as speculative supply. See STRATEGY.md "## Direction" 2026-07-02 (k).

- **T-64.1** `PARKED (2026-07-02 (k))` Add a pure, transport/filesystem-agnostic WITNESS + CHECKPOINT core — a new `cli/journal-witness.js` (kept SEPARATE from `cli/journal.js` and `cli/journal-log.js` so each stays single-purpose; PURE — NO fs/http/net/dns, NO system clock, NO randomness) — that adds equivocation-resistance ON TOP of the T-63.1 ordered Merkle log. It reuses `cli/journal-log.js` `treeHead`/`verifyConsistency` VERBATIM and `cli/core/attestation.js` `recoverSigner` (ECDSA over an `eip191-personal-sign` message) VERBATIM — NO new crypto, NO new dependency. It defines a canonical CHECKPOINT = the tree head bound to a log identity: `{ origin, size, root }` (a Signed-Tree-Head-SHAPED note; `origin` is a caller-supplied UTF-8 log id). Exports: (a) `serializeCheckpoint({ origin, size, root })` → the canonical, deterministic note bytes that get signed (bounded/validated shape; hostile/oversized input NAMED-rejected, never thrown); (b) `signCheckpoint(checkpoint, signMessageFn, role)` → attach a signature line `{ role:"operator"|"witness", signer, sig }` to the note using the SAME message scheme the attestation core uses (the caller passes a `wallet.signMessage`-shaped fn so the core NEVER touches a key directly), yielding a `signedCheckpoint = { checkpoint, signatures:[…] }`; (c) `cosignCheckpoint({ priorCheckpoint, newSignedCheckpoint, consistencyProof }, signMessageFn)` → the WITNESS role: it FIRST calls `verifyConsistency(consistencyProof, priorCheckpoint.root, newSignedCheckpoint.checkpoint.root)` (or accepts `priorCheckpoint===null` for the first head) and REFUSES — returning `{ ok:false, reason:"inconsistent"|"bad_prior"|… }`, NEVER signing — if the new head is not an append-only extension of the prior; only on success does it append a `role:"witness"` signature; (d) `verifyCheckpoint(signedCheckpoint, { operator, witnesses })` → recover every signature's signer via `recoverSigner`, confirm the required operator address and the required witness addresses are present and each signed THIS checkpoint's canonical bytes, fail-closed (`false` on any missing/foreign/tampered signature, never a false accept, never throws on hostile input); (e) `detectSplitView(signedCheckpointA, signedCheckpointB, consistencyProofOrNull, operatorAddress)` → the FRAUD-PROOF detector: verify BOTH checkpoints are validly signed by `operatorAddress` (else `{ verdict:"unproven", reason }`), then — treating the smaller-size checkpoint as the claimed prefix — return `{ verdict:"consistent" }` iff a valid `consistencyProof` links their roots (or they are byte-identical), or `{ verdict:"equivocation", reason }` when both are operator-signed but NO valid consistency proof links them (two signed, mutually-incompatible views = non-repudiable equivocation). deps: T-63.1 (`cli/journal-log.js`, built & green 33/33); `cli/core/attestation.js` `recoverSigner` (shipped & green). **PURE + deterministic; reuses the project's own consistency proof + ECDSA recovery; NO new dependency; NO key/network/fs/clock; NO change to any existing module.**
  - files: cli/journal-witness.js, test/journal-witness.core.test.js
  - Acceptance: `cli/journal-witness.js` exports the 5 functions above and requires ONLY `./journal-log` + `./core/attestation` (+ `ethers` byte/message helpers) — a static grep in the test confirms it imports NONE of `fs`/`http`/`https`/`net`/`dns`/`tls`/`dgram` and reads NO key/env directly (all signing is via the injected `signMessageFn`). Tests prove, with EPHEMERAL `Wallet.createRandom()` operator + witness keys ONLY: (1) `signCheckpoint` then `verifyCheckpoint` ACCEPTS an operator-signed checkpoint and REJECTS a checkpoint whose `size`/`root`/`origin` byte was edited after signing, a signature by a foreign address, and a missing required witness; (2) `cosignCheckpoint` CO-SIGNS a head that is an append-only extension of the prior (honest `consistencyProof` from `journal-log.consistencyProof`) and REFUSES — with a localized reason and NO signature emitted — a head that REWROTE a past entry (no valid consistency proof), and accepts `priorCheckpoint===null` as the genesis head; (3) `detectSplitView` returns `verdict:"consistent"` for two operator-signed checkpoints linked by a valid consistency proof (append-only growth) and returns `verdict:"equivocation"` for two operator-signed checkpoints at incompatible roots with no linking proof (a genuine split view), and `verdict:"unproven"` when either checkpoint is not validly operator-signed (it never calls a fork "equivocation" without proving both sides are the operator's own signature); (4) every function is pure (no I/O, no clock, no randomness) and TOTAL on adversarial input (constructors NAMED-reject, verifiers/`detectSplitView` return a verdict object, never throw). `npx hardhat test test/journal-witness.core.test.js` is green AND the FULL `npx hardhat test` suite stays green. Test command: `npx hardhat test`.

- **T-64.2** `PARKED (2026-07-02 (k))` Wire the T-64.1 core into the `vh journal` surface (extend `cli/journal-cli.js` + `cli/vh.js`) as four strictly-additive subcommands: the operator CHECKPOINT emitter, the independent WITNESS co-sign role, an offline checkpoint VERIFIER, and the offline SPLIT-VIEW detector. Add: (a) `vh journal checkpoint <journalfile> [--origin <id>] [--sign (--key-env <VAR>|--key-file <path>)] [--out <f>] [--json]` — compute `treeHead` over the journal's ordered entry hashes (reusing T-63.2's reader) and emit a checkpoint `{ origin, size, root }`; with `--sign` attach the operator signature using the human-provisioned key (read-used-discarded via the SAME `loadSigningWallet` path as `vh evidence license issue`, NEVER persisted/logged), carrying the SAME self-asserted-head honesty note the journal already prints (the head/co-signature is NOT a trusted wall-clock timestamp without a P-3 trust-root); (b) `vh journal witness-cosign <newCheckpointFile> [--prior <priorCheckpointFile>] --consistency <proofFile> (--key-env <VAR>|--key-file <path>) [--out <f>] [--json]` — the WITNESS role: read the prior + new checkpoints and a `vh journal prove-consistency` artifact (T-63.2), call `cosignCheckpoint`, and either write the co-signed checkpoint (exit 0) or REFUSE naming the reason (non-zero) — it holds NO key beyond the read-used-discarded witness key and binds NO network; (c) `vh journal verify-checkpoint <checkpointFile> --operator <addr> [--witness <addr>]… [--json]` — an OFFLINE verifier (NO journal, NO network, NO key) that runs `verifyCheckpoint` and prints ACCEPTED / REJECTED on the SHARED 0/3 CI-exit contract (0 verifies, 3 fails, 2 usage, 1 IO); (d) `vh journal detect-split <checkpointA> <checkpointB> [--consistency <proofFile>] --operator <addr> [--json]` — the OFFLINE fraud-proof detector that runs `detectSplitView` and prints `CONSISTENT` (exit 0), `EQUIVOCATION` (exit 3, a non-repudiable fraud proof both checkpoints are operator-signed at incompatible views), or `UNPROVEN` (exit 3, a checkpoint was not validly operator-signed) — the command a gossiping third party runs to catch a lying operator. All four are additive; append/verify/chain/tree-head/proof bytes are unchanged. deps: T-64.1; T-63.2 (`vh journal` reader/dispatcher + `prove-consistency` proof artifact + 0/3 contract). **Read-only except the signed-checkpoint OUT; the vendor/witness key comes ONLY from `--key-env`/`--key-file` (read-used-discarded, never written/logged); binds NO network; NO change to any existing command or test.**
  - files: cli/journal-cli.js, cli/vh.js, test/cli.journal-witness.test.js
  - Acceptance: on a journal with ≥3 entries, `vh journal checkpoint --sign --key-env <VAR>` (ephemeral `Wallet.createRandom()` key) emits an operator-signed checkpoint that `vh journal verify-checkpoint --operator <addr>` ACCEPTS (exit 0) and that REJECTS (exit 3) after one byte of `root`/`size`/`origin` or a signature is edited, or under a WRONG `--operator`; append 2 more entries, emit the new checkpoint + a `vh journal prove-consistency --from <oldSize>` proof, then `vh journal witness-cosign --prior <old> --consistency <proof> --key-env <WITNESS>` writes a co-signed checkpoint `verify-checkpoint --operator <op> --witness <w>` ACCEPTS, while feeding a consistency proof whose second root is a log that REWROTE a past entry makes `witness-cosign` REFUSE (non-zero, NAMED, NO co-signature written); construct two operator-signed checkpoints at incompatible roots and `vh journal detect-split --operator <addr>` prints EQUIVOCATION exit 3, while two heads linked by a valid `--consistency` proof print CONSISTENT exit 0, and a checkpoint signed by a non-operator prints UNPROVEN exit 3; a test asserts `verify-checkpoint`/`detect-split` open NEITHER the journal NOR any socket (offline third-party auditor path); `--json` emits the machine verdict for every subcommand; guardrail greps confirm the key comes only from `--key-env`/`--key-file` and is never written to disk/logs. `test/cli.journal-witness.test.js` passes and the FULL `npm test` suite stays green.

- **T-64.3** `PARKED (2026-07-02 (k))` Document equivocation-resistance HONESTLY and make it discoverable: extend `docs/INTEGRITY-JOURNAL.md` with a "Equivocation resistance: witnesses & split-view detection" section that (a) explains the Certificate-Transparency / Sigstore-Rekor / Go-checksum-database lineage and the concrete attack it closes — a lone log operator can present head-A to one auditor and an inconsistent head-B to another (a SPLIT VIEW), and inclusion/consistency proofs alone (EPIC-63) do NOT stop this because they only bind things RELATIVE to a head you were handed; (b) documents the `checkpoint` / `witness-cosign` / `verify-checkpoint` / `detect-split` commands, the checkpoint + co-signature schema, and the 0/3 exit contract; (c) walks a COPY-PASTEABLE worked example: append 3 → `checkpoint --sign` (operator) → `verify-checkpoint` → append 2 → `prove-consistency` → `witness-cosign` (independent witness co-signs the growth) → construct a divergent operator-signed head → `detect-split` prints EQUIVOCATION; (d) states the LOAD-BEARING honesty boundary VERBATIM: a witness co-signature proves an INDEPENDENT party SAW a head consistent with the prior one AT CO-SIGN TIME (equivocation-resistance), and `detect-split`'s EQUIVOCATION verdict is a non-repudiable fraud proof — but a co-signature is NOT a trusted wall-clock timestamp without the P-3 signing/timestamp trust-root, and detection only WORKS if checkpoints are actually GOSSIPED between parties (the tool ships the detector; running independent witnesses and distributing/comparing checkpoints is the DEPLOYMENT step, human-owned — NO new gate, NO relaxed gate; P-3's + P-9's + P-10's human steps unchanged). Add a one-line pointer from `README.md` and `docs/SDK.md` to the new section. deps: T-64.2. **Docs + honesty boundary only; NO code change; NO new auto-executed `needs-human` action; P-3/P-9/P-10 steps unchanged.**
  - files: docs/INTEGRITY-JOURNAL.md, README.md, docs/SDK.md, test/journal-witness.docs.test.js
  - Acceptance: `docs/INTEGRITY-JOURNAL.md` gains the equivocation-resistance section documenting the 4 commands + checkpoint/co-signature schema + the CT/Rekor/Go-checksumdb lineage + the worked split-view example; a docs-rot test (`test/journal-witness.docs.test.js`) asserts the doc names `checkpoint`/`witness-cosign`/`verify-checkpoint`/`detect-split`, describes the split-view attack AND its detection, and carries the co-signature-is-not-a-timestamp + gossip-is-required honesty sentences VERBATIM (and never claims "unaltered since date T" or "the operator cannot lie" without the P-3 / gossip qualification); a grep confirms `README.md` + `docs/SDK.md` point to the section and that NO P-3/P-9/P-10 human step was deleted or relaxed. Full `npm test` green.

## EPIC-65 — ZERO-INSTALL TrustLedger: a deterministic, single-file, fully OFFLINE `trustledger-standalone.html` a broker double-clicks — drag the bank statement / ledger export / rent roll onto the page and the ENTIRE reconcile→report pipeline runs CLIENT-SIDE (no Node, no terminal, no server, no network; trust-account data NEVER leaves the machine)  *(RESUMES adding after two consecutive `newTasks:[]` runs — the (j)/(k) resume-adding criterion clause (a) is MET: this is a genuinely NEW, unsaturated axis. It is NOT a 9th provenance primitive (the punished integrity-over-time vein — EPIC-64 stays PARKED) and NOT a re-bloat of the shipped go-live surface (webhook/preflight/docs). It is a DISTRIBUTION-SHAPE capability: the repo's own proven highest-leverage funnel move — the zero-install standalone bundles (`verifier/dist/verify-vh-standalone.js` / `seal-vh-standalone.js`, built by the deterministic CommonJS-shim bundler `verifier/build-standalone.js` and pinned byte-identical by `test/verifier.standalone.test.js`) — applied for the FIRST time to the flagship revenue wedge note (k) re-pointed the first dollar at: TrustLedger. THE PILOT-KILLING FRICTION IT REMOVES: the sharpened P-5 ask's riskiest step is "have the design partner run their REAL month-1 + month-2 files" — today that requires Node + this repo + running `vh trust serve` locally, i.e. an install AND trusting software with live trust-account data; a broker of record does neither. After this EPIC the human emails ONE file; the partner double-clicks it, drags three exports, and reads the same tie-out report — and the #1 objection for financial data ("where does my data go?") is answered STRUCTURALLY: nowhere — the page makes no network request at all, verifiable in the browser's own devtools. SURVEY-CONFIRMED FEASIBLE THIS RUN: `trustledger/ingest.js`, `match.js`, `reconcile.js` have ZERO `require`s (pure JS, browser-ready as-is); `policy.js`'s `readPolicy`/`validatePolicy`/`applyPolicy` are documented PURE (fs only in the bundled-policy directory loader); `close.js`'s ONLY node dependency is one `crypto.createHash("sha256")` over a canonical JSON string (close.js:117); `server.js` states verbatim that the entire pipeline through `report.renderHTML`/`renderExceptionsCSV` is "PURE and I/O-free"; the browser UI (`trustledger/public/index.html`) already reads the dropped files via `FileReader` and has exactly TWO transport seams to swap (`fetch("/api/inspect")` line ~168, `fetch("/api/reconcile")` line ~451); and the deterministic single-file bundler discipline is shipped + tested. FREE-TIER scope: the offline app offers only the free surfaces (reconcile + report + exceptions CSV + prior-close continuity — the two-month tie-out that IS the WTP proof is free); paid surfaces (per-state policy tables, seal) show the SAME named refusal the web door gives and point to the installed product — so this EPIC adds NO new needs-human item and changes NO gate. See STRATEGY.md "## Direction" 2026-07-02 (l).)*

- **T-65.1** `VERIFIED` Make the pilot-critical TrustLedger core BROWSER-PORTABLE with ZERO behavior change: (a) vendor a pure-JS sha256 (`trustledger/lib/sha256-vendored.js`) following the EXACT discipline of `verifier/lib/keccak256-vendored.js` — cross-checked BYTE-IDENTICAL against node `crypto.createHash("sha256")` by test across a corpus (empty string, ASCII, multi-KB canonical-close JSON from the real fixtures, non-ASCII UTF-8, all fixture close packets) — and give `close.js` a hash seam that uses it (or injects it) such that every `inputsDigest` byte on the existing e2e fixtures is UNCHANGED (pin at least one known digest as a fixture); (b) isolate `policy.js`'s ONLY impure code — the bundled-policy directory loader (`fs.readdirSync`/`readFileSync`, ~lines 321-331) — behind a single clearly-named function/module boundary the bundler can shim, leaving `readPolicy`/`validatePolicy`/`applyPolicy` untouched; (c) add a STATIC purity test asserting no `fs`/`http`/`https`/`net`/`dns`/`child_process` require is reachable from the browser path (`ingest`, `match`, `reconcile`, `report`, `close` core, `policy` pure path) — the isolated loader is the SOLE allowed exception and must be require-isolated. deps: none (all modules shipped & green). **NO behavior change: every existing CLI/server verdict, packet, close digest, and test expectation byte-identical; NO new third-party dependency (vendored pure-JS sha256 only, cross-checked like keccak256-vendored); full `npx hardhat test` green.**
  - files: trustledger/lib/sha256-vendored.js (new), trustledger/close.js, trustledger/policy.js (only if the loader isolation requires it), test/trustledger.browser-core.test.js (new)
  - Acceptance: (1) `sha256-vendored` hex === node `crypto` hex across the whole test corpus incl. every committed close fixture; (2) `inputsDigest` on the e2e fixtures BYTE-IDENTICAL to before the change (pinned digest fixture proves it); (3) static purity test green: no impure require reachable from the browser path, loader isolated; (4) full suite green with zero edits to existing test expectations.

- **T-65.2** `VERIFIED` Emit the deterministic single-file OFFLINE app: a new `trustledger/build-standalone.js` mirroring `verifier/build-standalone.js`'s proven technique (explicit FIXED module list, VERBATIM inlining, only `require()` specifiers rewritten to a memoizing `__require(id)` shim, deterministic byte-stable output, `--check` mode) that writes `trustledger/dist/trustledger-standalone.html` + a `.sha256` sidecar + a BUILD-PROVENANCE entry (same schema as `verifier/dist/BUILD-PROVENANCE.json`). The HTML embeds: (a) a DOM-FREE engine `<script>` (the `__modules` registry: ingest, match, reconcile, policy pure path, close, report, sha256-vendored, and the bundled default policies inlined as JSON) with recognizable start/end markers and NO `document`/`window` reference at module scope, so a Node test can extract and `vm`-evaluate it; (b) the EXISTING drag-drop UI from `trustledger/public/index.html` with its two `fetch` seams swapped for direct in-page calls into the SAME payload→result core `server.js` uses — FACTOR that core out of `server.js` into an exported pure function (`handleReconcilePayload(payload, deps)`-shaped) that BOTH the web door and the bundle call, so the two surfaces cannot drift; (c) the license-gate mapping inlined VERBATIM (not re-implemented): requesting a paid surface (state policy / seal) in the offline app yields the SAME named `license_required`-shaped refusal the web door gives, pointing to the installed product. NO-NETWORK enforced: the emitted file contains NO `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, or dynamic `import(` token anywhere. deps: T-65.1. **Deterministic (two builds byte-identical; committed dist pinned — a stale bundle FAILS CI, exactly like the verifier dist); NO new dependency; NO change to any existing CLI/server verdict or byte; free tier only; the gate contract is REUSED, never weakened.**
  - files: trustledger/build-standalone.js (new), trustledger/dist/trustledger-standalone.html (new, committed), trustledger/dist/trustledger-standalone.html.sha256 (new), trustledger/dist/BUILD-PROVENANCE.json (new), trustledger/server.js (factor the pure payload core out; behavior unchanged), trustledger/public/index.html (seam markers only, if needed), test/trustledger.standalone.test.js (new)
  - Acceptance: (1) running the builder twice yields BYTE-IDENTICAL output and the committed dist matches a fresh rebuild (`--check` green; stale bundle RED); (2) a Node harness extracts the marked engine block, evaluates it in `vm` (proving it is DOM-free), and drives the SAME payloads the server tests use: verdicts/balances/exceptions/`reportHtml` BYTE-IDENTICAL to the in-tree engine on the real fixtures (`bank.real.csv` + `quickbooks.real.csv` + `rentroll.real.csv`), on a malformed-file NAMED-reject case, AND on a two-month prior-close continuity tie-out; (3) the no-network token test passes over the whole emitted file; (4) a paid-surface payload returns the same named refusal as the web door; (5) `server.js` refactor is verdict-neutral (its existing tests pass unedited); full suite green.

- **T-65.3** `VERIFIED` Prove + document the ZERO-INSTALL pilot path and wire it into the sharpened P-5 ask: (a) add a "Zero-install: the offline app" section to `docs/TRUSTLEDGER.md` and `docs/PILOT.md` (+ a one-line pointer from `docs/ADOPT.md`, from `docs/GO-LIVE.md`'s pilot-fallback paragraph, and from `pilot/README.md`): the human emails ONE file (or hands it on a USB stick) to the design partner; the partner double-clicks `trustledger-standalone.html`, drags their REAL bank/ledger/rent-roll exports, and reads the same tie-out report — with the privacy claim stated HONESTLY and VERIFIABLY: the page makes NO network request (the file contains no network API — check the browser devtools Network tab yourself), so trust-account data never leaves the machine; (b) state the honesty boundary VERBATIM: the offline app is the FREE funnel tier — per-state policy tables, sealing, and licensing/fulfillment run in the installed product, and P-5's CPA/counsel review, vendor-key provisioning, pricing, and publishing steps remain HUMAN-OWNED and UNCHANGED (no new needs-human item, no relaxed gate); (c) a docs-rot test pins that the docs name `trustledger-standalone.html`, describe the drag-drop three-file flow and the two-month prior-close tie-out, carry the no-network/devtools claim, and carry the boundary sentence verbatim; (d) a grep in the test confirms NO P-3/P-5/P-6/P-8/P-9 human step was deleted or relaxed. deps: T-65.2. **Docs + honesty boundary only; NO code change beyond the doc pointers; NO new `needs-human` item; P-3/P-5/P-6/P-8/P-9 steps unchanged.**
  - files: docs/TRUSTLEDGER.md, docs/PILOT.md, docs/ADOPT.md, docs/GO-LIVE.md, pilot/README.md, test/trustledger.standalone.docs.test.js (new)
  - Acceptance: the sections/pointers exist; the docs-rot test is green (names the file, the flow, the no-network claim, the verbatim boundary); the P-line grep is green; full suite green.

## EPIC-66 — LINK-SHAPED first contact for the EVIDENCE vertical: a single-file, fully OFFLINE `verify-vh-standalone.html` — the cold prospect opens ONE page in a browser, drags a sealed packet (or clicks the built-in sample), watches ACCEPT, tampers one byte IN THE PAGE, and watches REJECT name the file — NO Node, no install, no network, no trust in us  *(MATERIAL CHANGE — the qualityStall trigger FIRED again (avgUsefulness window `3.63→3.75→2.5→3.38→3.88`: two consecutive runs ≤3.5 inside the window; minUsefulness hit 2) and `humanGated`=3 has stood for ~20 runs. Per the mandate this run pivots the loop's build target OFF "more product mechanism" and onto the funnel the stuck P-8 ask actually runs through. THE GAP, survey-confirmed: the sharpened P-8 ask names the EVIDENCE vertical the FIRST commercial target, and its first-contact step (b) is the 60-second cold-prospect challenge — but `challenge/README.md` says verbatim "You need only **`node` (>= 18)** on your PATH", and the live verifyhash.com landing page's verify one-liner is `node verify-vh-standalone.js …`. So the FIRST-target vertical's first 60 seconds are still Node-gated, while the SECOND-target vertical (TrustLedger) just got the zero-install browser app (EPIC-65, scored 4s — quality RECOVERED on exactly this distribution-shape move). This epic closes that asymmetry and converts P-8 step (b) from "get them to run node" into "send ONE link/file". FEASIBILITY, survey-confirmed this run: `verifier/verify-vh.js` already parameterizes path resolution (`classifyFiles(sealedEntries, baseDir, relResolver)`) with a SINGLE `fs.readFileSync` byte-read behind it; its verify cores (`verifyEvidenceSeal`/`verifyTrustSeal`/`verifyDatasetAttestation`/`verifyProofBundle`) are pure past that seam; all its libs (`keccak256-vendored`, `canonical`, `merkle`, `secp256k1-recover`, `revocation`) are dependency-free and already inline into the shipped standalone JS bundle; a complete DEMO packet (`DEMO_FILES` + `DEMO_CONTAINER`, one-byte tamper walkthrough) is ALREADY inlined in the verifier for `--demo`; and the deterministic single-file HTML bundler discipline is shipped + byte-pin-tested TWICE (`verifier/build-standalone.js`, `trustledger/build-standalone.js`). NOT the punished vein: this adds NO new provenance primitive (EPIC-64 stays PARKED; the freeze holds) and NO go-live re-bloat — it is the SAME proven distribution-shape capability, pointed at the vertical P-8 orders FIRST. Free-funnel only: VERIFY is already the free surface; nothing paid is opened or weakened. See STRATEGY.md "## Direction" 2026-07-02 (m).)*

- **T-66.1** `VERIFIED` Give the verifier an IN-MEMORY file-source seam with ZERO behavior change: extend `verifier/verify-vh.js` so the SAME verify cores that today read packet files from disk can verify from caller-supplied bytes — export a pure `verifyArtifactFromBytes({ artifactText, files, vendor, signer, revocationsText, asOf })`-shaped entry (exact name/shape the builder's choice, but: `files` is a plain `{relPath: Uint8Array|Buffer}` map, NO fs/path/os/process reachable on this code path, and the missing-file / extra-file / content-mismatch / wrong-vendor / tampered-signature verdict classes are derived from the MAP exactly as the disk path derives them from the directory). It must REUSE `classifyFiles`'s existing `relResolver` seam / the existing verify cores VERBATIM — no forked verify logic, no new crypto, no new dependency — and the existing CLI/disk path must stay byte-identical (every existing verifier test passes UNEDITED). deps: none (all cited seams shipped & green). files: verifier/verify-vh.js, test/verifier.browser-core.test.js (new)
  - Acceptance: (1) a new test drives the SAME packet through the disk path and the bytes path and asserts the structured results are DEEP-EQUAL, for: ACCEPT (unsigned evidence seal), ACCEPT (signed seal + correct `--vendor` pin), REJECT content-mismatch naming the exact file, REJECT missing-file, REJECT extra-file, REJECT wrong-vendor, REJECT tampered-signature, and a revocations-list REJECT; (2) a static purity guard proves no `fs`/`os`/`path`/`process`/`child_process` use is reachable from the bytes entry (grep/module-scope discipline, same style as `test/trustledger.browser-core.test.js`); (3) hostile inputs (non-JSON artifact text, oversized map keys, absolute/`..` relPaths) are NAMED-rejected, never thrown; (4) full suite green with zero edits to existing test expectations.

- **T-66.2** `VERIFIED` Emit the deterministic single-file OFFLINE page `verifier/dist/verify-vh-standalone.html` with the 60-SECOND CHALLENGE BUILT IN: a new `verifier/build-standalone-html.js` (mirroring `trustledger/build-standalone.js`'s proven technique: explicit FIXED module list, VERBATIM inlining, `require()` → memoizing `__require(id)` shim, byte-stable output, `--check` mode) that bundles the T-66.1 bytes-path engine + the verifier libs into ONE html file. The page: (a) drag-and-drop (or file-picker, incl. folder select via `webkitdirectory`) for the `*.vhevidence.json` / seal artifact + the packet files, mapping browser `webkitRelativePath`/names onto the seal's relPaths IN MEMORY, then rendering the SAME verdict + per-file tamper localization the CLI prints; (b) optional vendor-address pin + optional revocations-file drop driving the SAME signed-verify path; (c) the BUILT-IN sample: the verifier's EXISTING `DEMO_FILES`/`DEMO_CONTAINER` inlined VERBATIM (not re-authored) behind one "load the sample packet" click → ACCEPT, plus an editable in-memory view of one demo file so the prospect changes ONE byte and re-verifies → REJECT naming that file — the `challenge/` walkthrough with zero setup; (d) the honest boundary VERBATIM, visible on the page: ACCEPT is tamper-evidence that these exact bytes match the seal — NOT a trusted timestamp and NOT proof of WHEN without the P-3 trust-root; for CI/production gating use the node standalone (`verify-vh-standalone.js`). DOM-free engine block between recognizable markers (vm-extractable); NO-NETWORK enforced: the emitted file contains NO `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, or dynamic `import(` token anywhere. deps: T-66.1. files: verifier/build-standalone-html.js (new), verifier/dist/verify-vh-standalone.html (new, committed), verifier/dist/verify-vh-standalone.html.sha256 (new), verifier/dist/BUILD-PROVENANCE.json (extend), test/verifier.standalone-html.test.js (new)
  - Acceptance: (1) two builds are BYTE-IDENTICAL and the committed dist matches a fresh rebuild (`--check` green; a stale/tampered committed bundle turns the pin test RED — same discipline as the existing dist pins); (2) a Node harness `vm`-evaluates the marked engine block (proving DOM-freedom) and asserts verdict objects BYTE-IDENTICAL to the in-tree T-66.1 bytes path for: demo-packet ACCEPT, one-byte-tamper REJECT naming the file, signed ACCEPT with correct vendor, wrong-vendor REJECT, missing/extra-file REJECTs; (3) the six-token no-network test passes over the WHOLE emitted file; (4) `BUILD-PROVENANCE.json` gains the html target (bundle sha256 + ordered per-module source sha256s) and the provenance test still pins every target; (5) NO change to `verify-vh.js` CLI output bytes or to the existing JS-bundle builds; full suite green.

- **T-66.3** `VERIFIED` Wire the link-shaped first contact into the funnel + the P-8 ask, honestly: (a) `challenge/README.md` gains a "No Node? Do it in your browser" path at the TOP of the flow (open `verifier/dist/verify-vh-standalone.html`, click the sample, tamper, watch the named REJECT — the SAME committed demo packet, the SAME engine, zero install), keeping the node path as the CI-shaped variant; (b) pointers from `docs/ADOPT.md`, `docs/PILOT.md` (the cold-prospect step — the doc the P-8 ask hands the prospect, so the link-shaped path lands in the ask's own reading path WITHOUT editing STRATEGY.md: do NOT touch STRATEGY.md/P-8 — it sits near its byte budget and `docs/DECIDE.md` is GENERATED from P-8 by `scripts/sync-decide.cjs`), `docs/INDEPENDENT-VERIFICATION.md`, and `verifier/README.md`; (c) a docs-rot test pins the new sections (file name, the sample-then-tamper flow, the no-network/devtools claim, the verbatim boundary sentence, the CI-use-the-node-standalone caveat) and greps that NO P-3/P-5/P-6/P-7/P-8/P-9 human step was deleted or relaxed. deps: T-66.2, T-67.1 (so the page also enters the published site set + landing page in the same wiring pass). files: challenge/README.md, docs/ADOPT.md, docs/PILOT.md, docs/INDEPENDENT-VERIFICATION.md, verifier/README.md, site/publish-set.json (+ landing link), test/challenge.browser.docs.test.js (new)
  - Acceptance: sections/pointers exist and the docs-rot test is green; STRATEGY.md byte-identical (no P-line touched; `test/pilot.docs.test.js` + `test/strategy.archive.test.js` UNEDITED and green); the site publish set + landing page include the html page and `scripts/site-release.js --check` is green after re-assembly; full suite green.

## EPIC-67 — Make the LIVE verifyhash.com refresh a ONE-COMMAND, DRIFT-GUARDED release packet: the repo mechanically KNOWS when the deployed site is stale and hands the human a diff + a single upload step  *(THE OTHER HALF of the same pivot: verifyhash.com is the project's ONLY deployed outward asset — and it is INVISIBLE to the repo. Survey-confirmed this run: the webroot staging dir `public/` is GITIGNORED and UNTRACKED (zero `git log` history), the landing page's SOURCE exists nowhere in version control, NO test pins the staging set against `verifier/dist` (the supervisor's memory note records the live site already drifting from the repo build), and the deploy runbook `docs/DEPLOY-PUBLIC-SITE.md` is a hand-follow 50-line procedure. So the loop keeps improving artifacts the deployed funnel never serves, and nothing — no test, no tool — says so. This epic gives the repo a TRACKED, deterministic publish set (allowlist-only, so the runbook's must-never-serve safety rule becomes STRUCTURAL), a one-command assembler with `--check`, and a DEPLOYED-snapshot diff that turns "re-deploy the site" into a decision-ready 10-minute human action (proposal P-11) instead of a forgotten runbook. NO deploy is executed — the loop only assembles + diffs inside the repo; uploading stays human-owned (P-11). NOT the punished vein: no new provenance primitive, no go-live re-bloat — this is release/ops engineering for the one asset prospects actually touch. See STRATEGY.md "## Direction" 2026-07-02 (m).)*

- **T-67.1** `VERIFIED` Ship the deterministic SITE-RELEASE assembler + the tracked publish set: (a) FIRST, before anything regenerates `public/`, snapshot the CURRENT untracked staging dir's per-file sha256s into a committed `site/DEPLOYED.json` (`{generatedFrom, deployedAtNote, files:{relPath: sha256}}`) — the best available record of what was actually uploaded 2026-06-26 (the drift baseline); (b) bring the landing page under version control: `site/index.html` seeded BYTE-IDENTICAL from the staging `public/index.html`; (c) a committed, schema-validated ALLOWLIST mapping `site/publish-set.json` (`published relPath → repo source path`) covering exactly the current publish set: the landing page, `verifier/dist/verify-vh-standalone.js`(+`.sha256`), `seal-vh-standalone.js`(+`.sha256`), `BUILD-PROVENANCE.json`→`build-provenance.json`, `LICENSE`, `NOTICE`, and the 23 `public/docs/*` files mapped to their committed `docs/`/`challenge/`/`verifier/`/`pilot/`/`examples/` sources (incl. the renames, e.g. `challenge-README.md`); (d) `scripts/site-release.js` — node-core only, NO network, NO key, NEVER writes outside the repo — assembles the publish set from those committed sources into `public/` deterministically, writes `public/RELEASE-MANIFEST.json` + a committed twin `site/RELEASE-MANIFEST.json` (sorted relPaths, per-file sha256, per-file source path, total bytes), and supports `--check` (exit 1, listing offenders, when `public/` or the committed manifest differs from a fresh assembly — the byte-pin discipline of the dist bundles applied to the whole site). Allowlist-only assembly makes the runbook's "must NEVER be served" rule structural: nothing outside the mapping can enter the webroot. deps: none. files: scripts/site-release.js (new), site/publish-set.json (new), site/index.html (new), site/DEPLOYED.json (new), site/RELEASE-MANIFEST.json (new, committed), docs/DEPLOY-PUBLIC-SITE.md (consume the packet), test/site-release.test.js (new)
  - Acceptance: (1) two assemblies are BYTE-IDENTICAL and `--check` is green on the committed tree, RED (naming the file) when a staged file is tampered, when a source drifts from the committed manifest, or when a NON-allowlisted file appears in `public/`; (2) the test proves the assembled bundle bytes EQUAL the committed `verifier/dist` bytes and every published doc EQUALS its committed source byte-for-byte; (3) the test proves the FORBIDDEN set is structurally excluded (no `.git*`, no `docs/DEPLOY-PUBLIC-SITE.md`, no `docs/USAGE-BUDGET.json`, no `docs/METRICS.jsonl`, no key/env-shaped file can appear — allowlist violation → named failure); (4) `site/DEPLOYED.json` exists, was captured from the PRE-regeneration staging bytes, and is schema-valid; (5) `docs/DEPLOY-PUBLIC-SITE.md`'s upload step now says "run `node scripts/site-release.js`, upload `public/`, verify against `RELEASE-MANIFEST.json`"; (6) full suite green; NO deploy, NO network, nothing written outside the repo.

- **T-67.2** `VERIFIED` Make site DRIFT visible and the human refresh DECISION-READY: (a) `scripts/site-release.js --diff` compares `site/DEPLOYED.json` against a fresh assembly's manifest and prints a per-file `ADDED`/`CHANGED`/`REMOVED`/`UNCHANGED` table + a one-line verdict ("live site is stale: N of M published files differ — refresh per P-11" / "live site matches the current release"), exiting 0 in both cases (staleness is a HUMAN decision signal, not a CI failure) but exiting 3 on a malformed/missing snapshot; (b) `--mark-deployed` rewrites `site/DEPLOYED.json` to the current manifest + an ISO date note — the ONE command the human runs AFTER uploading, closing the loop so the next `--diff` is truthful; (c) a standing test pins the SIGNAL chain, not the human step: committed `site/RELEASE-MANIFEST.json` must equal a fresh assembly (so any later change to `verifier/dist`/docs/landing WITHOUT a site re-release turns the suite RED and forces the manifest — and therefore the `--diff` staleness signal — current), while a stale `DEPLOYED.json` must NEVER fail the suite; (d) document the flow ("release → upload → --mark-deployed → --diff clean") in `docs/DEPLOY-PUBLIC-SITE.md` + a pointer from `docs/GO-LIVE.md`'s runbook section, stating the boundary VERBATIM: the loop assembles and diffs INSIDE the repo only; uploading to the live host is the human-owned P-11 step — never auto-executed. deps: T-67.1. files: scripts/site-release.js, site/DEPLOYED.json, docs/DEPLOY-PUBLIC-SITE.md, docs/GO-LIVE.md, test/site-release.test.js
  - Acceptance: (1) `--diff` on the committed tree (fresh release vs the 2026-06-26 snapshot) prints the CHANGED/ADDED rows proving the recorded live-site drift and exits 0; after a simulated `--mark-deployed` in a temp copy, `--diff` prints the clean verdict; (2) malformed snapshot → exit 3, named error; (3) the standing manifest-freshness test is green on the committed tree and RED when a published source is edited without re-running the release (proven in a temp copy); (4) the docs carry the verbatim boundary + the P-11 pointer; (5) full suite green; NO deploy, NO network.

## EPIC-68 — A NEW income vertical on shipped primitives: AGENTTRACE — tamper-evident, selectively-disclosable, independently-verifiable AI-AGENT SESSION RECORDS (`vh agent`): seal an agent's event stream (prompts, tool calls, tool results, outputs) into a `*.vhagent.json` packet whose per-event Merkle leaves let the operator REDACT sensitive payloads while the packet still verifies, prove any ONE event's inclusion offline, and prove a later session log is an APPEND-ONLY extension of a mid-session checkpoint (no retroactive rewriting)  *(MATERIAL CHANGE, and the resume-adding criterion's clause (a) — "a genuinely new unsaturated axis" — is MET: `grep -in agent BACKLOG.md` → ZERO prior work; no vertical in the family addresses this buyer. THE MARKET GAP: companies deploying autonomous AI agents in 2026 face record-keeping obligations (EU AI Act Art. 12/19/26 logging + deployer log-retention duties, SOC2-style internal audit, incident forensics after an agent acts badly) and the observability tools they use (LangSmith/Langfuse-style tracing) produce logs the OPERATOR can silently edit after the fact — none produce an EVIDENTIARY, offline-verifiable, tamper-evident record a counterparty/auditor can check without trusting the operator's database. That is EXACTLY this repo's core competence. WHY THIS IS NOT THE PUNISHED VEIN AND NOT A 9TH PRIMITIVE: it adds ZERO new provenance primitives and ZERO new crypto — it is the FIRST PRODUCT whose load-bearing engine is the shipped-but-DORMANT ordered RFC-6962 Merkle-log core (`cli/journal-log.js`, T-63.1, 33/33 green — the axis the Manager flagged as "winding down"; this either makes that asset PAY or it stays parked — the mandate's "removing what isn't paying off" answered by re-purposing, not deletion). File-SET seals (Evidence/DataLedger) structurally CANNOT express an agent session: events are ORDERED, they arrive OVER TIME (append-only growth between a mid-session checkpoint and the final log is the anti-tamper property that matters), and transcripts contain secrets/PII that MUST be redactable without breaking verifiability — per-event leaf hashing + inclusion/consistency proofs are the only shipped machinery that delivers ordered position-bound disclosure, and this epic is the first consumer where they are ESSENTIAL rather than optional. SURVEY-CONFIRMED REUSE (all seams shipped & green): `cli/core/packetseal.js` is explicitly product-agnostic (`kind`-configured seals); `cli/journal-log.js` exports `treeHead`/`inclusionProof`/`verifyInclusion`/`consistencyProof`/`verifyConsistency` over caller-supplied entry hashes; `cli/core/attestation.js` signs/recovers envelopes; `cli/core/license.js` + the DRAFT evidence plan catalog gate paid surfaces fail-closed; `verifier/verify-vh.js` has the in-memory `verifyArtifactFromBytes` seam (T-66.1) and the deterministic standalone JS+HTML bundlers are byte-pin-tested (T-66.2) — so the free verify surface lands in the SAME zero-install browser funnel page that recovered quality on EPIC-65/66. NO new needs-human item, `humanGated` UNCHANGED: the paid surface (`--sign`) is gated by the SAME license mechanism the human's ONE existing go-live path (docs/GO-LIVE.md, P-7/P-8) already provisions — when the human flips the existing switch, this vertical is sellable in the same motion, into a budget line (AI compliance) that overlaps DataLedger's buyer. Honesty boundary carried in-band from day one: the packet proves the log was NOT ALTERED after sealing/checkpointing and what any disclosed event said — it does NOT prove the log faithfully records what the agent actually did (garbage-in), and it is NOT a trusted timestamp without the P-3 trust-root. See STRATEGY.md "## Direction" 2026-07-02 (n).)*

- **T-68.1** `VERIFIED` PURE agent-session core `cli/core/agent-session.js` — canonical events, redaction-safe leaves, ordered head, proofs; NO new crypto, NO new dependency, NO fs/network/key/clock. (a) Canonical event schema `{ seq, ts, actor, type, payload | payloadHash, meta? }` with `type` from a CLOSED set (at minimum `prompt`, `completion`, `tool_call`, `tool_result`, `note`), strict validation (named rejects for missing/extra/malformed fields, non-contiguous `seq`, non-string `ts` — `ts` is SELF-ASSERTED metadata, documented as untrusted); (b) THE REDACTION-SAFE LEAF (the design decision that makes this evidentiary): the leaf hash is computed over the canonical event WITH THE PAYLOAD REPRESENTED BY ITS HASH COMMITMENT (`payloadHash` = the existing `cli/hash.js hashBytes` over canonical payload bytes) — a FULL event (carrying `payload`) and its REDACTED twin (carrying only `payloadHash`, flagged `redacted: true`) derive the IDENTICAL leaf, so redacting any subset of events changes NEITHER the leaves NOR the root; verify recomputes `payloadHash` from `payload` when present and checks the commitment when absent; (c) the ordered log: `sessionHead(events)` → `{ size, root }` via `cli/journal-log.js` `treeHead` over the event leaf hashes REUSED VERBATIM (RFC-6962 `0x00`/`0x01` domain separation, NO sorting — position-bound), plus `proveEvent`/`verifyEvent` (single-event inclusion against a head) and `verifyGrowth(earlierHead, laterHead, proof)` (append-only consistency between a mid-session checkpoint and a later/final head) delegating to `inclusionProof`/`verifyInclusion`/`consistencyProof`/`verifyConsistency` VERBATIM; (d) `redactEvent(event)` + round-trip invariants. deps: none (all cited seams shipped & green). files: cli/core/agent-session.js (new), test/cli.core.agent-session.test.js (new)
  - Acceptance: (1) a static purity guard (same style as the journal-log/browser-core guards) proves no `fs`/`http`/`https`/`net`/`dns`/`child_process`/`process.env` reachable from the core; (2) property-style tests over sessions of size 1..N: full and redacted twins derive IDENTICAL leaves and IDENTICAL heads; any ONE payload byte flipped, any event dropped/reordered/inserted, or any `seq`/`actor`/`type`/`ts` edit CHANGES the root (named verdicts, never throws on hostile input); (3) `proveEvent`→`verifyEvent` round-trips for every `(size, index)`; a fabricated/altered event or a proof replayed against the wrong head is REJECTED; (4) `verifyGrowth` accepts every `(m ≤ n)` prefix pair and REJECTS a rewritten-history pair (an edited past event between checkpoint m and head n); (5) `cli/journal-log.js` and `cli/hash.js` are byte-UNCHANGED (reused, not forked); full `npx hardhat test` green.

- **T-68.2** `VERIFIED` The `vh agent` CLI surface over the T-68.1 core, with the paid surface gated by the EXISTING license mechanism (fail-closed, reused verbatim — NO new needs-human step): `vh agent seal <session.jsonl> --out <packet>` builds a `*.vhagent.json` packet (kind-disjoint via the product-agnostic `cli/core/packetseal.js` config discipline: head `{size, root}`, event list — full and/or redacted — counts, in-band trust note) and supports `--sign` via the SAME `cli/core/attestation.js` envelope + `cli/core/license.js` gate `vh evidence seal --sign` uses, keyed to a new DRAFT `agent_signed` capability added to the DRAFT plan catalog (NO price set — pricing stays the human's P-7 step; unsigned seal/verify/prove/redact are FREE); `vh agent verify <packet> [--json]` re-derives every leaf (recomputing `payloadHash` for full events, checking the commitment for redacted ones) and the root, verifying the signature/vendor pin when present — REJECT names the first offending event `seq`; `vh agent redact <packet> --seq <list> --out <packet>` emits a redacted copy that STILL VERIFIES and lists exactly which seqs were withheld; `vh agent prove <packet> --seq N --out <proof>` / `vh agent verify-proof <proof> [--root <hex>]` disclose + check ONE event offline against the head; `vh agent checkpoint <session.jsonl> [--json]` prints the head so far, and `vh agent verify-growth <earlier-head-or-packet> <later-packet>` proves append-only extension (REJECT on rewritten history). Exit-code/`--json` postures mirror the existing verbs (0 accept / non-zero named reject / 2 usage). deps: T-68.1. files: cli/agent.js (new), cli/vh.js (wire the verb), cli/core/evidence-plans.js (DRAFT `agent_signed` capability only), test/cli.agent.test.js (new)
  - Acceptance: (1) end-to-end fixture flow green: seal → verify ACCEPT; one-byte payload tamper → REJECT naming the event seq; redact → verify ACCEPT + withheld seqs listed; prove/verify-proof ACCEPT for a disclosed event and REJECT for a forged one; checkpoint → append more events → verify-growth ACCEPT, rewritten-past REJECT; (2) `--sign` WITHOUT a valid license capability is REFUSED with the SAME named-refusal shape the evidence gate emits (fail-closed; proven with an ephemeral `Wallet.createRandom()` license in tests ONLY), and a signed packet verifies with the correct `--vendor` pin / REJECTS a wrong pin; (3) NO existing seal/verdict/plan byte or test edited (catalog change is strictly additive, still schema-valid, still priceless-DRAFT — `vh evidence go-live-preflight` stays green); (4) hostile packets (non-JSON, foreign kind, absolute/`..`-shaped fields, oversized) are NAMED-rejected, never thrown; (5) full suite green.

- **T-68.3** `VERIFIED` INDEPENDENT + ZERO-INSTALL verification of agent packets — the funnel leg, free surface only: extend `verifier/verify-vh.js`'s artifact auto-detection with `verifyAgentSeal` (BOTH the disk path AND the `verifyArtifactFromBytes` in-memory path, reusing the T-66.1 seam VERBATIM — deep-equal verdicts across the two paths), re-derive leaves/root/signature exactly as `vh agent verify` does but from an INDEPENDENT implementation surface (the verifier's own dependency-free libs — no import from `cli/`), inline a small DEMO agent session (one `tool_call` payload redacted) next to the existing `DEMO_FILES`/`DEMO_CONTAINER`, then REBUILD the committed standalone JS + HTML dist bundles so the SAME emailed/linked page from T-66.2 also verifies a dropped `*.vhagent.json` — demo-click → ACCEPT, one-byte tamper IN THE PAGE → REJECT naming the event seq. deps: T-68.1, T-68.2. files: verifier/verify-vh.js, verifier/build-standalone.js + verifier/build-standalone-html.js (module lists), verifier/dist/* (rebuilt, committed, re-pinned), verifier/dist/BUILD-PROVENANCE.json, site/RELEASE-MANIFEST.json (re-assembled), verifier/README.md, test/verifier.agent.test.js (new)
  - Acceptance: (1) disk-path and bytes-path verdicts DEEP-EQUAL for: ACCEPT (unsigned), ACCEPT (signed + correct vendor pin), REJECT tampered-payload naming the seq, REJECT tampered-head, REJECT wrong-vendor, ACCEPT redacted packet, REJECT redacted packet whose commitment was forged; (2) verdicts from the verifier and from `vh agent verify` AGREE on the full fixture matrix (independence cross-check); (3) two rebuilds BYTE-IDENTICAL, committed dist matches fresh rebuild (`--check` green), `BUILD-PROVENANCE.json` re-pins every target, the six-token NO-NETWORK test still passes over the whole emitted HTML, and the vm-extracted engine block returns verdicts byte-identical to the in-tree bytes path for the agent demo; (4) `scripts/site-release.js --check` green after re-assembly (drift vs `site/DEPLOYED.json` may GROW — that is the honest P-11 signal, never a test failure); (5) full suite green with zero edits to existing test expectations.

- **T-68.4** `VERIFIED` Docs + honest trust boundary + a REAL ingest example: (a) `docs/AGENTTRACE.md` — what a `*.vhagent.json` PROVES (log unaltered since seal; any disclosed event verbatim as recorded; append-only growth between checkpoint and final head; redaction that cannot silently alter — only withhold) and what it does NOT prove (that the log faithfully records what the agent ACTUALLY did — garbage-in is out of scope and MUST be stated; `ts` fields are self-asserted; NOT a trusted timestamp / "existed at time T" without the P-3 human trust-root; the SAME wording carried in-band in the packet's trust note per the `TRUST_NOTE` discipline), the free-vs-paid line (verify/prove/redact FREE; `--sign` license-gated), and where the buyer independently verifies (the standalone page/CLI); (b) `examples/agent-session/`: a realistic committed fixture transcript in a common third-party shape (an OpenAI-chat-completions-style `messages[]` + tool-calls JSONL export) plus a tiny dependency-free `map-transcript.js` that maps it into the canonical T-68.1 event schema — proving adoption is a 20-line mapping, not a platform migration; (c) pointers from `README.md`, `docs/ADOPT.md`, and `docs/PILOT.md`'s journeys list (do NOT touch STRATEGY.md — near byte budget; `docs/DECIDE.md` is GENERATED); (d) a docs-rot test pinning the boundary sentences + the example's end-to-end flow (map → seal → redact → verify → prove) and grepping that NO P-3/P-5/P-6/P-7/P-8/P-9/P-11 human step was deleted or relaxed. deps: T-68.2 (T-68.3 for the page pointer). files: docs/AGENTTRACE.md (new), examples/agent-session/ (new), README.md, docs/ADOPT.md, docs/PILOT.md, test/cli.agent.docs.test.js (new)
  - Acceptance: (1) the example flow runs green end-to-end in the test using ONLY committed fixtures + node core (offline, deterministic, ephemeral keys in tests only); (2) the docs-rot test pins the PROVES/NOT-PROVES sections verbatim-anchored and the free-vs-paid line; (3) STRATEGY.md byte-identical; `test/strategy.archive.test.js` + `test/pilot.docs.test.js` UNEDITED and green; (4) full suite green.

## EPIC-69 — COMMIT-BOUND AGENT SESSIONS: bind a git commit (oid + the reproducible git-scoped Merkle root) INTO the sealed, redactable AGENTTRACE record — `vh agent commit-claim` / `vh agent verify-commit` — so an auditor with a clone can verify OFFLINE that an UNALTERED session log contains a claim to EXACTLY this code state, with every prompt/tool payload redactable and the claim still checkable  *(THE GAP, survey-confirmed this run: EPIC-68 shipped the AGENTTRACE vertical (all four tasks VERIFIED, avgUsefulness recovered to 4.13/min 4 — the panel's strongest recent run, earned by exactly this vertical + the distribution-shape moves), but its actual buyer's FIRST question — AI-code governance / IP-provenance / SOC2-change-management: "WHICH code change does this session record correspond to, and can I check nobody doctored the record after the fact?" — has NO mechanical answer: today you grep the transcript for a sha and trust the operator. Meanwhile the repo's ORIGINAL mission assets sit DORMANT: `cli/git.js` + `cli/hash.js hashGit` (T-8.x, VERIFIED) already compute the REPRODUCIBLE tracked-set Merkle root for "repo at commit abc123" — byte-identical from any clean checkout of that commit, the exact property the whole registry was built on — and no product consumes them. This epic is the intersection axis with ZERO prior backlog work (`grep -in "bind-commit\|commit binding\|code provenance"` → only the original T-8 motivation note): it makes the NEWEST vertical answer its buyer's first question by re-purposing the OLDEST shipped asset — the same make-a-dormant-asset-pay move the panel rewarded when EPIC-68 re-purposed the dormant `cli/journal-log.js`. WHY THIS IS NOT THE PUNISHED VEIN AND NOT A 9TH PRIMITIVE: ZERO new crypto, ZERO new dependency, NO new packet kind — the binding is a CANONICAL PAYLOAD STRING inside an ORDINARY T-68.1 `note` event (the redaction-safe leaf machinery is untouched), plus a verify verb that re-derives the commit facts from the AUDITOR'S OWN clone via the shipped `resolveCommit`/`hashGit` VERBATIM. Design choice (deliberate): the claim binds the COMMIT OID + the T-8 git-scoped tracked-set ROOT, NOT patch text — `git show` patch bytes are not stable across git versions/diff configs, while the tracked-set root is the repo's own shipped, test-pinned, clone-reproducible content address, and the oid itself binds history/author/message. WHY IT MATTERS COMMERCIALLY: it upgrades AGENTTRACE from "a sealed transcript" to "a sealed transcript BOUND to a specific, independently-re-derivable code state" — the artifact an auditor/counsel actually files: "commit X was claimed by session S at position k; the log has not been altered since; every secret in the transcript is redacted and it still checks." It ALSO gives the dormant original mission (ContributionRegistry, P-2's Amoy ask) its first product-shaped payload — the sealed head + commit claim is exactly the 32-byte artifact the commit-reveal registry path was built to anchor (a P-2 VALUE sharpening; NOT a deploy, NOT a new gate). HONEST BOUNDARY (in-band + docs, verbatim-pinned): proves the sealed, unaltered session CONTAINS a claim to exactly commit X (oid + reproducible root) at position k, and — when signed — WHO vouched for the head; it does NOT prove the session's events CAUSED or produced the commit (an operator can claim a commit produced elsewhere; containment-not-causation MUST be stated), NOT that the transcript faithfully records the agent (garbage-in, per EPIC-68), NOT a trusted timestamp without the P-3 human trust-root. FREE surface end-to-end (claim-emit + verify-commit are read-only/key-less; nothing paid is opened or weakened — `--sign` stays behind the EXISTING gate); NO new needs-human item; `humanGated` UNCHANGED. The primitive freeze (EPIC-64 PARKED) and the resume-adding criterion REMAIN IN FORCE after this epic. See STRATEGY.md "## Direction" 2026-07-02 (o).)*

- **T-69.1** `VERIFIED` PURE commit-claim core `cli/core/agent-commit.js` — the canonical claim payload + strict verifier; NO new crypto, NO new dependency, NO fs/git/network/clock (all git-derived facts are CALLER-SUPPLIED values so the core stays pure like every other `cli/core/*`). (a) `commitClaimPayload({ commit, gitRoot, scope? })` → a DETERMINISTIC canonical JSON STRING (sorted keys, versioned `kind: "vh-agent-commit-claim@1"`), with strict validation: `commit` a 40-hex lowercase oid, `gitRoot` a 0x-bytes32 lowercase hex (the T-8 `hashGit` root), `scope` an optional repo-relative POSIX hint — every failure a named `{ ok:false, reason }`, TOTAL on hostile input; (b) `parseCommitClaim(payloadString)` — the strict inverse (unknown kind/version, extra/missing/malformed fields, non-canonical bytes → named rejects; NEVER throws); (c) `buildCommitClaimEvent({ seq, ts, actor?, commit, gitRoot, scope? })` → a canonical T-68.1 event (`type: "note"`, payload = the canonical claim string) that `cli/core/agent-session.js validateEvent` ACCEPTS unchanged and whose leaf is stable under redaction of OTHER events; (d) `findCommitClaims(events)` → every DISCLOSED (full-payload) claim event with its parsed claim (a redacted claim is by definition not disclosable — documented); (e) `verifyCommitClaim({ event | payloadString, expected: { commit, gitRoot } })` → `{ ok:true }` or a named mismatch verdict (`oid-mismatch` / `root-mismatch` / `bad-claim` — which field, never a throw). deps: T-68.1 (VERIFIED). files: cli/core/agent-commit.js (new), test/cli.core.agent-commit.test.js (new)
  - Acceptance: (1) a static purity guard (same style as the agent-session/journal-log guards) proves no `fs`/`child_process`/`http`/`https`/`net`/`dns`/`process.env` reachable from the core; (2) determinism: same inputs → BYTE-IDENTICAL payload string across repeated calls and key orderings; parse∘build round-trips; (3) the built event passes `validateEvent`, seals into a session via the T-68.1 core, and the head is UNCHANGED when any OTHER event is redacted (claim still findable + verifiable); (4) tamper matrix: any oid/gitRoot/kind/version byte edit → the specific named reject; hostile payloads (non-JSON, wrong kind, extra fields, huge strings) → named rejects, never throws; (5) `cli/core/agent-session.js`, `cli/journal-log.js`, `cli/hash.js`, `cli/git.js` byte-UNCHANGED (reused, not forked); full `npx hardhat test` green.

- **T-69.2** `VERIFIED` The CLI verbs over the T-69.1 core — the producer emits the claim line, the AUDITOR re-derives everything from their OWN clone; both FREE, read-only, key-less. (a) `vh agent commit-claim --repo <dir> [--ref <ref=HEAD>] --seq <n> [--ts <iso>] [--actor <s>] [--out <p>] [--json]`: resolves the oid via `cli/git.js resolveCommit` and computes the git-scoped root via `cli/hash.js hashGit` (BOTH reused verbatim), then prints/writes ONE canonical JSONL event line ready to append to the session log BEFORE `vh agent seal` (`--ts` self-asserted metadata, same posture as every event `ts`; missing/unknown ref or not-a-work-tree → the existing named git errors, exit 1/2 — never a stack trace); (b) `vh agent verify-commit <packet> --repo <dir> [--ref <ref>] [--vendor <0xaddr>] [--json]`: FIRST re-runs the FULL packet verification via the EXISTING `vh agent verify` core path verbatim (including signature/vendor-pin handling — a tampered/forged packet can never reach the claim check), THEN re-resolves the oid + RECOMPUTES the tracked-set root FROM THE AUDITOR'S OWN CLONE via `hashGit`, finds the disclosed claim events, and ACCEPTs only if a disclosed claim matches the re-derived facts; REJECT NAMES the failed check (`packet-invalid` / `no-disclosed-claim` / `oid-mismatch` / `root-mismatch` — root-mismatch instructs "check out the claimed commit in a clean tree": `hashGit` reads work-tree bytes, so a dirty checkout is an HONEST mismatch, not a false ACCEPT). Exit 0 ACCEPTED / 3 REJECTED / 2 usage / 1 IO, mirroring the existing verbs; usage lines added to `vh agent` help. deps: T-69.1, T-68.2 (VERIFIED). files: cli/agent.js, cli/vh.js (usage), test/cli.agent.commit.test.js (new)
  - Acceptance: (1) end-to-end in a THROWAWAY temp git repo with pinned author/committer/date env (the `cli.hash.git.test.js` discipline; offline, deterministic): fixture session → append the emitted claim line → `vh agent seal` → `verify-commit` ACCEPT; (2) redact EVERY other event (all prompts/tool payloads withheld) → `verify-commit` still ACCEPT and `vh agent verify` still ACCEPT — the selective-disclosure property that makes this filable evidence; (3) tamper matrix, each the SPECIFIC named REJECT: one payload byte in any event → packet-invalid; claim names a DIFFERENT commit → oid-mismatch; a tracked file's work-tree bytes edited at the same ref → root-mismatch (with the checkout instruction); claim event itself redacted → no-disclosed-claim; signed packet with wrong `--vendor` pin → the EXISTING pin reject (ephemeral `Wallet.createRandom()` keys in tests ONLY); (4) NO license gate touched or consulted on these verbs (free surface — grep-proven), NO existing seal/verdict/plan byte or test edited, `vh evidence go-live-preflight` stays green; (5) full suite green.

- **T-69.3** `VERIFIED` Docs + honest boundary + the worked example — make the capability adoptable and impossible to overclaim. (a) `docs/AGENTTRACE.md` gains "Binding a session to a git commit": what it PROVES (the sealed, unaltered log contains a claim to exactly commit oid X with tracked-set root R at position k; anyone with a clean checkout of X re-derives R via the shipped `vh hash <repo> --git` machinery; redaction of any other payload leaves the claim checkable) and what it does NOT prove (containment-NOT-causation — it does NOT prove the session's events produced the commit, and this MUST be stated verbatim; not faithful-recording per EPIC-68; `ts` self-asserted; NOT a trusted timestamp without the P-3 trust-root), the free-vs-paid line (commit-claim/verify-commit FREE; `--sign` unchanged behind the existing gate), and the standalone-page note stated honestly: the zero-install page verifies the PACKET; re-deriving the COMMIT facts requires git + a clone, i.e. the CLI is the auditor tool for that leg; (b) extend `examples/agent-session/` with the scripted flow (map transcript → `commit-claim` → seal → redact-all-but-claim → `verify-commit`) against a temp fixture repo built inside the test (committed fixtures + node core + git only — offline, deterministic); (c) pointers from `README.md` + `docs/ADOPT.md` (do NOT touch STRATEGY.md — byte budget; `docs/DECIDE.md` is GENERATED); (d) a docs-rot test pinning the PROVES/NOT-PROVES sentences (verbatim-anchored, the T-68.4 discipline) + running the example flow end-to-end + grepping that NO P-1..P-11 human step was deleted or relaxed. deps: T-69.2. files: docs/AGENTTRACE.md, examples/agent-session/ (extend), README.md, docs/ADOPT.md, test/cli.agent.commit.docs.test.js (new)
  - Acceptance: (1) the example flow runs green end-to-end offline/deterministic (temp git repo with pinned env; ephemeral keys only if the signed variant is exercised); (2) the docs-rot test pins the containment-not-causation sentence + the P-3 timestamp caveat + the free-vs-paid line verbatim; (3) STRATEGY.md byte-identical in this task; `test/strategy.archive.test.js` + `test/cli.agent.docs.test.js` UNEDITED and green; (4) full suite green.

## EPIC-70 — CHAIN-ANCHOR BRIDGE: anchor ANY sealed product artifact's 32-byte digest into the commit-reveal ContributionRegistry (local hardhat only) and verify the receipt OFFLINE — the auto-buildable half of P-3 Option (C) and the product payload that makes the P-2 flip worth taking  *(THE DAM, metrics-confirmed: `humanGated` has been pinned at 3 for the ENTIRE recent METRICS window (T-3.1/T-3.2 behind P-1; T-4.1 behind P-2) and the mandate's standing order for a persistent humanGated count is to SHARPEN the blocking proposal and prefer auto-buildable work that DE-RISKS it once the human acts. P-3 states VERBATIM today: "Option (C) (on-chain anchor at a block whose time bounds existence) still needs its own envelope + an outward deploy + real funds (see P-2) and is NOT yet built" — Options (A) signature and (B) RFC-3161 each got their envelope + offline verifier + one-command handoff (EPIC-17/19/20, the pattern the panel rewarded), but (C), the ONLY option that needs no key custody AND no TSA relationship, has NOTHING. Meanwhile the ORIGINAL mission asset — ContributionRegistry with its front-run-resistant commit-reveal (D-1), `buildAnchorTx`/`runCommit`/`runReveal`, the `isTestnetChainId` mainnet guard, the EPIC-11 authenticated read path — sits DORMANT as a product: grep-confirmed, NO code path anchors a `*.vhevidence.json` root, a `*.vhagent.json` head, a journal tree head, a trust sealfile root, or a dataset/parcel attestation digest; `vh anchor` only hashes raw files/dirs. This epic is the intersection: the make-a-dormant-asset-pay move the panel rewarded in EPIC-68 (journal-log) and EPIC-69 (hashGit), aimed for the first time at the HUMAN-GATE DAM ITSELF. WHY IT MATTERS COMMERCIALLY: today the P-2 Amoy flip buys an EMPTY registry — a human who deploys gets nothing product-shaped; after this epic the SAME ~30-minute flip instantly upgrades EVERY sellable vertical (evidence packets, AGENTTRACE sessions + commit claims, integrity-journal heads, TrustLedger seals, dataset/parcel attestations) with the STRONGEST timestamp story in the family — "this exact digest existed by public-chain block time T, attribution front-run-resistant" — with commands that already work, no TSA, no vendor key custody. P-3(C)'s human handoff collapses to: deploy per P-2 with a throwaway faucet key + run `vh anchor-artifact --rpc <amoy>`. HARD GUARDRAILS INTACT: the loop tests ONLY against a LOCAL in-process hardhat node with ephemeral keys (the `test/cli.claim.test.js` live-node discipline); the CLI reuses the existing testnet guard verbatim (refuses non-test chainIds without the explicit flag); NO deploy, NO real funds, NO network in tests beyond 127.0.0.1. ZERO new crypto, ZERO new dependency: the digest extraction reuses each artifact's SHIPPED validator verbatim; the receipt container follows the wrap-don't-edit discipline of `timestamp-wrap`; the tx path reuses the shipped anchor/claim internals. HONEST BOUNDARY (in-band from day one, verbatim-pinned): an anchored receipt on the LOCAL dev chain proves MECHANISM only and is worth NOTHING publicly until a human deploys per P-2; even then it proves "an on-chain record binds this exact digest at block B whose timestamp bounds existence" — as trustworthy as the chain + YOUR pinned contract address — NOT the artifact's truth, NOT faithful recording, NOT attribution beyond the anchoring key. FREE surface (anchoring spends the customer's own gas; no license gate opened or weakened). NO new needs-human item; the primitive freeze (EPIC-64 PARKED) + resume-adding criterion remain in force — this is resume-adding clause (a): a genuinely new, grep-confirmed-unworked axis. See STRATEGY.md "## Direction" 2026-07-03 (p).)*

- **T-70.1** `VERIFIED` PURE anchor-binding core `cli/core/anchor-binding.js` — extract the one canonical 32-byte digest from any sealed product artifact, build the anchored-receipt container, and verify the binding; NO new crypto, NO new dependency, NO fs/git/network/clock (all inputs are caller-supplied PARSED objects, like every other `cli/core/*`). (a) `artifactDigest(artifact)` — strict dispatch over a CLOSED, frozen kind table, each leg REUSING the shipped validator VERBATIM before extracting: evidence packet (`cli/evidence.js` validate path → `root`), agent packet (`cli/core/agent-session.js` validate path → head root), journal tree-head artifact (`cli/journal-log.js` shapes → `root`), TrustLedger sealfile (its shipped read/validate split → root), dataset/parcel canonical attestation payload (`cli/core/attestation.js` canonical bytes → the sha256 digest exactly as `timestamp-request` computes it); returns `{ ok:true, digest, kind, how }` (digest a 0x-lowercase bytes32; `how` a human-readable derivation rule string) or a NAMED `{ ok:false, reason }` — TOTAL on hostile input, never throws, unknown/invalid kind is a named reject never a guess; (b) `buildAnchoredReceipt({ digest, kind, how, artifactLabel?, chain: { chainId, contract, txHash, blockNumber, blockTime, contributor, authorBound } })` → a canonical, versioned, sorted-key `kind:"vh-anchored-receipt@1"` container embedding the digest + derivation + chain facts + the honest trust note VERBATIM (the "local dev chain proves mechanism only / as trustworthy as the chain + YOUR pinned contract address" sentences), with strict field validation (named rejects); (c) `verifyAnchoredReceipt({ receipt, artifact })` — parse+validate the receipt strictly (unknown kind/version/extra/missing/malformed → named rejects), recompute `artifactDigest(artifact)` via the SAME closed table, and return `{ ok:true, digest, chain }` on match or the SPECIFIC named mismatch (`digest-mismatch` / `kind-mismatch` / `bad-receipt` / the artifact's own named validation reject) — this function NEVER consults a network (pure binding check; the on-chain leg is T-70.2's `--rpc` mode). deps: none (all validators shipped & green). files: cli/core/anchor-binding.js (new), test/cli.core.anchor-binding.test.js (new)
  - Acceptance: (1) for EACH kind in the closed table, a fixture artifact yields a stable, documented digest (pinned hex in the test) and `verifyAnchoredReceipt` round-trips build→verify to `ok:true`; (2) tamper matrix per kind: one byte anywhere in the artifact → the artifact's own named validation reject OR `digest-mismatch` (never `ok:true`); one byte in the receipt's `digest`/`kind`/chain fields → the specific named reject; an unknown `kind` string → named reject; (3) purity: a grep-based test proves the module requires no `fs`/`http`/`https`/`net`/`dns`/`child_process` and reads no clock; every failure path returns a named reason, never throws (fuzz with hostile shapes: null/array/cyclic-free garbage); (4) the trust-note sentences are embedded verbatim in every built receipt (pinned in the test); (5) NO existing seal/packet/validator byte edited; full `npx hardhat test` suite green.

- **T-70.2** `VERIFIED` The CLI verbs + the LIVE local-hardhat end-to-end proof: `vh anchor-artifact` / `vh verify-anchored`. (a) `vh anchor-artifact <sealed-file> --contract <addr> --rpc <url> (--key-env <VAR> | --key-file <p>) [--author-bound] [--uri <s>] [--out <receipt>] [--json]` — read+parse the artifact, extract the digest via T-70.1, submit it as the registry `contentHash` REUSING the shipped internals VERBATIM (`cli/anchor.js` one-shot path by default; with `--author-bound` the commit-reveal path via the shipped `runCommit`/`runReveal` machinery so the claim is front-run-resistant and the record `authorBound:true`), wait for the tx receipt, read back `blockNumber`/block timestamp/`contributor`, and write the T-70.1 anchored-receipt container; key handling is the house read-used-discarded discipline (`--key-env`/`--key-file`; neither/both/malformed → named error BEFORE any network use; the key is NEVER generated, persisted, or logged); the EXISTING `isTestnetChainId` mainnet guard is reused verbatim (a non-test chainId without `--i-understand-mainnet` refuses); re-anchoring an already-anchored digest surfaces the registry's own named error, never a raw stack trace. (b) `vh verify-anchored <receipt> <sealed-file> [--rpc <url> --contract <addr>] [--json]` — OFFLINE by default: strict T-70.1 binding verify on the shared 0/3 exit contract; with `--rpc --contract` it ADDITIONALLY reads the registry record back through the EXISTING authenticated read path (EPIC-11 identity probe) and confirms on-chain `contentHash`/`contributor`/timestamp match the receipt's chain facts (each mismatch a SPECIFIC named reject, exit 3); it never signs and needs no key. (c) usage lines in `vh` help mirroring the existing verbs. deps: T-70.1. files: cli/anchor-artifact.js (new), cli/vh.js, test/cli.anchor-artifact.test.js (new)
  - Acceptance: (1) LIVE end-to-end against a spawned local hardhat node (the `test/cli.claim.test.js` discipline: 127.0.0.1, ephemeral funded test accounts, registry deployed in-test): seal a fixture evidence packet, an agent packet, and a journal tree-head artifact; `anchor-artifact` each (evidence one-shot; agent `--author-bound` with the reveal-delay blocks mined in-test); each emitted receipt then passes `verify-anchored` OFFLINE (exit 0) AND with `--rpc --contract` (exit 0); (2) tamper matrix, each the SPECIFIC named REJECT (exit 3): one artifact byte → binding reject; receipt `txHash`/`blockNumber`/`contributor` edited → the rpc recheck's named mismatch; `--contract` pointed at a non-registry address → the EXISTING identity-probe reject; the same digest anchored twice → the registry's named already-anchored error (non-zero, no stack trace); (3) guardrail greps: keys only via `--key-env`/`--key-file` (read-used-discarded, never logged); tests connect ONLY to 127.0.0.1; the mainnet guard path is exercised (a mocked non-test chainId refuses without the flag); (4) `--author-bound` records read back `authorBound:true` and one-shot records `authorBound:false` (the D-1 semantics surfaced, not re-implemented); (5) free surface: NO license gate consulted on either verb (grep-proven); NO existing anchor/claim/verify test edited; full suite green.

- **T-70.3** `VERIFIED` Docs + honest boundary + the P-2/P-3(C) SHARPENING that aims the built capability at the standing human gate. (a) new `docs/ANCHORING.md`: what an anchored receipt PROVES (an on-chain registry record binds this exact artifact digest; the block timestamp BOUNDS existence — as trustworthy as the chain + YOUR pinned contract address; commit-reveal `authorBound:true` = front-run-resistant first-claimant attribution per D-1) and what it does NOT (a LOCAL dev-chain receipt proves MECHANISM only and is worth nothing publicly until a human deploys per P-2 — MUST be stated verbatim; NOT the artifact's truth or faithful recording; NOT attribution beyond the anchoring key; NOT legal advice; Options (A)/(B) of P-3 remain independent trust-roots a buyer may also require), the free line (both verbs free; gas is the customer's own), and the worked local flow (seal → anchor-artifact → verify-anchored offline → verify-anchored --rpc); (b) STRATEGY.md sharpening, ADDITIVE-ONLY and byte-TIGHT — HARD CONSTRAINT: `test/strategy.archive.test.js` caps STRATEGY.md at UNDER 81920 bytes and the file sits ~81.4KB, so the two UPDATE blocks together must total ≤ ~450 bytes (verify with `stat -c %s STRATEGY.md` < 81920, `node scripts/archive-direction.cjs --guard`, and the strategy suites green; trim NOTHING pre-existing to make room): ONE short UPDATE sentence in P-3 flipping Option (C) from "NOT yet built" to "auto-buildable half SHIPPED (EPIC-70): handoff = deploy per P-2 (throwaway faucet key, Amoy first) + `vh anchor-artifact --rpc`; the loop still NEVER deploys/holds funds/anchors publicly — see docs/ANCHORING.md," and ONE short UPDATE sentence in P-2 stating the flip now unlocks on-chain anchoring for every sealed artifact (naming EPIC-70 + docs/ANCHORING.md) — NO human step deleted, weakened, or relaxed in either block (the standing docs-rot greps must stay green), NO new needs-human item; (c) pointers from `README.md` + `docs/ADOPT.md` (`docs/DECIDE.md` is GENERATED — do not hand-edit); (d) a docs-rot test pinning the PROVES/NOT-PROVES sentences verbatim (the T-68.4 discipline), running the worked flow's offline leg, and grepping that NO P-1..P-11 human step was deleted or relaxed. deps: T-70.2. files: docs/ANCHORING.md (new), STRATEGY.md (P-2/P-3 additive UPDATE blocks only), README.md, docs/ADOPT.md, test/anchoring.docs.test.js (new)
  - Acceptance: (1) the docs-rot test pins the local-chain-proves-mechanism-only sentence, the as-trustworthy-as-chain+pinned-address sentence, and the free line verbatim; (2) STRATEGY.md passes `node scripts/archive-direction.cjs --guard` and the P-2/P-3 edits are strictly additive (`test/strategy.archive.test.js` + `test/strategy.size-guard.test.js` UNEDITED and green; every pre-existing P-2/P-3 sentence still present); (3) the worked offline flow runs green in the test (committed fixtures, no node spawn needed for the docs leg); (4) full suite green.

- **T-70.4** `VERIFIED` Close the disclosed independence gap: add `vh-anchored-receipt@1` support to the STANDALONE `verifier/verify-vh.js` (+ the rebuilt `verifier/dist/` bundles) so a counterparty can verify an anchored receipt's OFFLINE binding leg **without installing the producer `cli/` stack** — the durable fix behind the honest disclosure T-70.3 shipped in `docs/ANCHORING.md` ("Independent verification"). WHY: the anchored receipt is a NEW verifyhash artifact type but has NO path in the ethers-free `verifier/` tree; today `vh verify-anchored`'s OFFLINE leg loads `ethers` transitively (`cli/anchor-artifact.js` → `cli/core/attestation.js`), so the family's zero-install "verify without the producer's stack" promise does not reach the receipt binding leg. This is pure hashing — the standalone verifier already re-derives evidence-seal and agent-packet digests with NO `ethers` and NO new dependency — so it is a packaging gap, not a proof gap. SCOPE: (a) teach the standalone verifier to recognize `vh-anchored-receipt@1`, validate the container strictly (unknown kind/version/extra/missing → named reject), require the in-band `note` to equal the pinned `ANCHOR_TRUST_NOTE` byte-for-byte (an edited caveat = `bad-receipt`), and, given the sibling sealed artifact, re-derive its digest through the SAME closed kind table the producer core uses and confirm the receipt binds it — the OFFLINE binding leg ONLY (the `--rpc` chain re-check stays out of the offline standalone, exactly as on-chain anchoring is already out of scope there); (b) keep the standalone `ethers`-free (grep-proven) — port only the pure digest-extraction the receipt needs, reusing the shipped evidence/agent Merkle re-derivation verbatim; (c) rebuild + re-pin `verifier/dist/verify-vh-standalone.js` (+ `.html`, `.sha256`, provenance) via the existing `verifier/build-standalone.js` path; (d) once shipped, UPDATE `docs/ANCHORING.md` "Independent verification" to say the gap is CLOSED (anchored receipts verify standalone) and drop the "does not YET extend" caveat. deps: T-70.3. files: verifier/verify-vh.js, verifier/build-standalone.js (if the closed-table digest helper needs bundling), verifier/dist/* (rebuilt), docs/ANCHORING.md (flip the disclosure), test/verifier.standalone.test.js (new anchored-receipt cases)
  - Acceptance: (1) `node verifier/verify-vh.js <receipt> --anchored-artifact <seal>` (or the verb the standalone already uses) ACCEPTs the committed `examples/anchoring/` fixtures with exit 0, and a flipped artifact byte / substituted-valid-artifact / edited-note each give the SPECIFIC named reject exit 3 — matching the producer cli's verdicts on the same fixtures; (2) the standalone bundle stays dependency-free: `grep -R "require(\"ethers\")" verifier/` finds nothing, and `node verifier/dist/verify-vh-standalone.js` runs with no `node_modules`; (3) `verifier/build-standalone.js --check` reproduces the dist bundle end-to-end and the published `.sha256` matches; (4) `docs/ANCHORING.md` no longer says the independence gap is open; the docs-rot test (`test/anchoring.docs.test.js`) is updated in lockstep so its disclosure pin tracks the new reality; (5) full suite green.

## EPIC-71 — AGENTTRACE COVERAGE: the repo-wide, CI-gateable "which commits carry an independently verifiable agent-session claim" control — turn the per-commit EPIC-69 answer into the fleet-level inventory + merge gate the governance buyer actually operates  *(THE BUYER'S SECOND QUESTION, in sequence: EPIC-68 sealed the session record; EPIC-69 bound ONE session to ONE commit (`vh agent verify-commit`, all VERIFIED, panel min 4 — the strongest recent run). The AI-code-governance / SOC2-change-management / IP-provenance buyer's next question is never "show me one commit" — it is "across THIS repo and THIS range, WHICH changes carry a verifiable session record, and FAIL my pipeline when one lands without it." Today that answer is a hand-loop over verify-commit with no inventory artifact, no policy, and no CI shape. Grep-confirmed ZERO prior backlog work on coverage/fleet inventory. WHY THIS IS THE HIGH-LEVERAGE SHAPE AND NOT THE PUNISHED VEIN: (1) it creates a RECURRING control — the exact renewal lever P-8 names (the CI merge-gate that converts a one-off pilot into a renewing dependency: their build fails the day a change lacks a verifiable session record), i.e. subscription-shaped value, not another one-shot verify leg; (2) it COMPOSES shipped assets verbatim — commit enumeration via a new strict `listCommits` beside the existing `cli/git.js` plumbing, disclosed-claim extraction via T-69.1 `findCommitClaims`/`verifyCommitClaim`, FULL packet verification via the shipped T-68.x verify path (a claim inside an unverifiable packet NEVER counts), and per-commit root re-derivation via the SHIPPED `hashGit` VERBATIM run in a TEMP LOCAL CLONE checked out at each claimed oid (git clone of a LOCAL path — fully offline); (3) ZERO new crypto, ZERO new dependency, NO new packet kind, NO license-gate change (free surface — coverage is verify-side; the paid `--sign` surface is untouched). HONEST BOUNDARY (in-band + docs, verbatim-pinned): "covered" means an UNALTERED sealed session CONTAINS a disclosed claim to exactly this commit (oid + re-derived tracked-set root) — containment NOT causation (it does NOT prove the session produced the commit); an UNCOVERED commit proves NOTHING about how it was authored (coverage is an INVENTORY control, not an authorship detector — MUST be stated); redacted claims are by definition not disclosable; `ts` self-asserted; NOT a trusted timestamp without the P-3 trust-root. NO new needs-human item; `humanGated` unchanged; the primitive freeze (EPIC-64 PARKED) + resume-adding criterion remain in force — this is resume-adding clause (a) on the panel-validated AGENTTRACE axis. See STRATEGY.md "## Direction" 2026-07-03 (p).)*

- **T-71.1** `VERIFIED` PURE coverage core `cli/core/agent-coverage.js` — evaluate fleet coverage from CALLER-SUPPLIED facts; NO fs/git/network/clock, NO new dependency (the `cli/core/*` purity discipline). (a) `evaluateCoverage({ commits, claims, policy })` where `commits` is an ordered list of `{ oid }` (40-hex lowercase, strict), `claims` is a list of `{ oid, gitRoot, packetLabel, packetVerified: boolean, rootVerified: boolean|null }` (each field strictly validated; `rootVerified:null` = not re-derived in this run), and `policy` is a small CLOSED shape (`{ requireAll?: boolean, requireSince?: oid }`) → a DETERMINISTIC report object: per-commit status from a CLOSED verdict vocabulary (`covered-verified` — a claim from a verified packet with `rootVerified:true`; `covered-oid-only` — verified packet, root not re-derived; `claim-unverified-packet` — NEVER counts as covered; `claim-root-mismatch`; `uncovered`), totals per status, and a policy verdict `{ pass: boolean, failures: [...] }` — TOTAL on hostile input, every failure a named `{ ok:false, reason }`, never throws; (b) `serializeCoverageReport(report)` → canonical sorted-key JSON STRING (versioned `kind:"vh-agent-coverage@1"`) so the report artifact is byte-diffable and itself SEALABLE by the existing `vh evidence seal` (state this in the module doc — no new seal code); (c) `parseCoverageReport(s)` — the strict inverse (unknown kind/version/extra/missing → named rejects). deps: T-69.1 (VERIFIED). files: cli/core/agent-coverage.js (new), test/cli.core.agent-coverage.test.js (new)
  - Acceptance (RECONCILED 2026-07-05 — VERIFY-ONLY, do NOT re-author: the implementation ALREADY EXISTS COMMITTED — the "failed" attempts produced a complete module + test that landed as untracked debris and were swept into commit 5a84e01 — and its dedicated suite is green at HEAD): (1) `cli/core/agent-coverage.js` exports exactly `evaluateCoverage`/`serializeCoverageReport`/`parseCoverageReport` with the CLOSED verdict vocabulary (`covered-verified`/`covered-oid-only`/`claim-unverified-packet`/`claim-root-mismatch`/`uncovered`), the closed policy shape `{ requireAll?, requireSince? }`, and `kind:"vh-agent-coverage@1"`; the module doc states the report artifact is sealable by the EXISTING `vh evidence seal` (no new seal code) — confirm by READING, not rewriting; (2) `npx hardhat test test/cli.core.agent-coverage.test.js` green (44 passing), which carries the ORIGINAL matrix UN-TRIMMED: the five-commit worked matrix hitting every verdict class with exact per-commit statuses + totals + requireAll/requireSince policy verdicts (pass AND fail; since-slicing pinned), the pinned negative that `packetVerified:false` NEVER yields covered (even against a fully cooked report), serialize→parse byte-identical round-trip with key-order-independent canonical bytes, the STATIC purity grep (no fs/git/net/env/clock/keys) + hostile-input fuzz (named rejects from a CLOSED reason set, never throws); (3) full `npx hardhat test` suite green at HEAD (the prior "runner exit=3" = 3 failing tests SOMEWHERE in that run's full-suite tree, a harness/landing artifact — re-prove green today); (4) touch the module/test ONLY if a criterion in (1)-(3) actually fails (each fix with a named test); then flip to `VERIFIED`.
  - Note: RECONCILED 2026-07-05 (Decider) — stale `BLOCKED`: the 3 auto-build attempts DID produce the artifact (committed via 5a84e01); dedicated suite 44/44 green. Fork resolved as reconcile/verify-only — no split, no acceptance trim (the T-46.1/T-61.1/T-63.1 pattern). See STRATEGY.md ## Decisions 2026-07-05.

- **T-71.2** `VERIFIED` The CLI verb + the CI gate shape: `vh agent coverage --repo <dir> --range <rev-range> --packets <dir> [--deep] [--require-all] [--require-since <oid>] [--out <report>] [--json]`. (a) commit enumeration: a new strict `listCommits(dir, range)` in `cli/git.js` beside the existing plumbing (`git rev-list` with `--end-of-options`, the existing stdout cap + named errors on unknown range — same discipline as `resolveCommit`/`listTrackedFiles`); (b) packet intake: every `*.vhagent.json` under `--packets` is FULLY verified via the shipped verify path FIRST — an unverifiable packet's claims are counted ONLY as `claim-unverified-packet` (never covered) and the packet is named in the report; disclosed claims extracted via T-69.1 `findCommitClaims` verbatim; (c) `--deep`: for each claimed oid in range, re-derive the tracked-set root by `git clone` of the LOCAL repo path into a TEMP dir, checkout the oid, run the SHIPPED `hashGit` VERBATIM, compare to the claim's `gitRoot`, and clean the temp clone up on every exit path (success and failure) — fully offline (a local-path clone opens no network); without `--deep`, claims are `covered-oid-only` and the human-readable output SAYS root-not-re-derived; (d) verdict + exits on the shared contract: report-only default exits 0 with the summary; with `--require-all`/`--require-since` the policy verdict gates exit 3 on failure (2 usage / 1 unexpected — parity with the existing verify contract, test-asserted); `--out` writes the T-71.1 canonical report; (e) CI recipes `verifier/ci/agent-coverage.generic.sh` + `verifier/ci/agent-coverage.github-actions.yml` following the EXISTING recipe pattern (journal/verify-service): a pipeline step that FAILS the build when a commit in the pushed range lacks a verifiable claim; (f) usage lines in `vh agent` help. deps: T-71.1, T-69.2 (VERIFIED). files: cli/core/agent-coverage.js (unchanged), cli/git.js, cli/agent.js, cli/vh.js (usage), verifier/ci/agent-coverage.generic.sh (new), verifier/ci/agent-coverage.github-actions.yml (new), test/cli.agent.coverage.test.js (new)
  - Acceptance: (1) end-to-end in a THROWAWAY temp git repo with pinned author/committer/date env (the `cli.hash.git.test.js` discipline; offline, deterministic): 3 commits; sessions with claims for commits 1 and 3 sealed via the shipped verbs; `coverage --range` reports commit 2 `uncovered`, commits 1/3 `covered-oid-only`; with `--deep` both flip to `covered-verified` and the temp clone is PROVEN removed (both on success and after an injected failure); (2) tamper matrix: one payload byte in a packet → its claim counts only as `claim-unverified-packet` and `--require-all` gates exit 3; a claim whose gitRoot is edited → `claim-root-mismatch` under `--deep` (named, never covered); an unknown `--range` → the named git error, exit 2; (3) `--require-all` on the 2/3-covered fixture exits 3, on the fully-covered fixture exits 0; report-only default exits 0 either way; (4) the generic CI recipe runs green in-test against the fixture repo (the journal-ci example discipline); (5) free surface: NO license gate consulted (grep-proven); NO existing agent verb/test edited; full suite green.

- **T-71.3** `VERIFIED` Docs + honest boundary + the worked fleet example — adoptable and impossible to overclaim. (a) `docs/AGENTTRACE.md` gains "Coverage: prove it fleet-wide": what a coverage report PROVES (for each covered commit, an UNALTERED sealed session contains a disclosed claim to exactly that oid — and under `--deep`, to exactly that re-derived tracked-set root; the report is deterministic and sealable with the existing `vh evidence seal`) and what it does NOT (containment-NOT-causation per commit — verbatim; an uncovered commit proves NOTHING about how it was authored: coverage is an INVENTORY control, not an authorship detector — verbatim; a redacted claim is not disclosable; `ts` self-asserted; NOT a trusted timestamp without P-3), the free line (coverage/CI-gate FREE; `--sign` unchanged behind the existing gate), and the CI recipe pointer; (b) extend `examples/agent-session/` with the scripted fleet flow (fixture repo → two sessions → claims → seal → coverage → `--require-all` failing then passing) run by the test against a temp repo (offline, deterministic, node core + git only); (c) pointers from `README.md` + `docs/ADOPT.md` + `docs/PILOT.md`'s journeys list (do NOT hand-edit `docs/DECIDE.md` — GENERATED; do NOT touch STRATEGY.md in this task — T-70.3 owns this run's only STRATEGY edit); (d) a docs-rot test pinning the two boundary sentences + the free line verbatim, running the example flow end-to-end, and grepping that NO P-1..P-11 human step was deleted or relaxed. deps: T-71.2. files: docs/AGENTTRACE.md, examples/agent-session/ (extend), README.md, docs/ADOPT.md, docs/PILOT.md, test/cli.agent.coverage.docs.test.js (new)
  - Acceptance: (1) the example flow runs green end-to-end offline/deterministic; (2) the docs-rot test pins the containment-not-causation sentence, the inventory-not-authorship-detector sentence, and the free-vs-paid line verbatim; (3) STRATEGY.md byte-identical in this task; `test/strategy.archive.test.js` + `test/cli.agent.commit.docs.test.js` UNEDITED and green; (4) full suite green.

## EPIC-72 — LOOP OPERABILITY: mechanize the supervisor's remaining hand-steps (partial-run reconciliation, engine archive + ledger verification, governor arithmetic)  *(Loop-hardening batch 2 shipped as engine #25 (2026-07-04, supervisor-authored at a park point: mechanical test-runner commit gate, blast-radius panel, per-run token cap, dissent preservation, single telemetry read, haiku reporter, adoption-aware Strategist, preflight doc self-heal, agent deadlines, Fable-free MODEL table). What remains from docs/LOOP-HARDENING-PLAN.md is OUTSIDE the engine sandbox (needs file I/O), so it belongs here as ordinary buildable tasks: (1) a run that is TaskStopped mid-flight leaves NO METRICS line and NO budget row — run wf_72ed879b burned 5.88M tokens invisibly until hand-reconciled; (2) rollback depth is exactly ONE (build-loop.prev.js) — a bad engine promoted twice in a row leaves no known-good copy, and docs/ENGINE-LEDGER.json's append-only property is asserted but never verified; (3) the spend governor's cooldown/cap/window arithmetic in docs/USAGE-BUDGET.json is re-derived by hand at every relaunch boundary — the exact class of manual arithmetic the audit graded down. All three are loop-INFRASTRUCTURE HARDENING of already-shipped operational surfaces (adoption-rule category (b)) — no new product vertical, no new dependency, node core only, offline, deterministic, clock-injectable for tests.)*

- **T-72.1** `VERIFIED` Partial-run reconciliation: `scripts/reconcile-run.cjs <transcript-dir> [--tokens N] [--end-reason task-stopped|crashed] [--dry-run]` — derive an HONEST run record from a workflow transcript directory when the run died without reporting. (a) parse the per-agent `agent-*.jsonl` / journal files under the dir (tolerate partial/truncated lines — never throw on hostile input; named `{ ok:false, reason }` errors); count agents by label prefix (build/verify/runner/review/…) and extract verified/blocked task ids where determinable; (b) append ONE METRICS line to `docs/METRICS.jsonl` with the derivable fields, explicit `"endReason":"task-stopped"` (or `--end-reason`), and `"partial":true` so cross-run readers can distinguish it from a reported run — NEVER rewrite existing lines (append-only, test-pinned); (c) append the matching `runs[]` row to `docs/USAGE-BUDGET.json` (`--tokens` from the authoritative task-notification; update `spentTokens`/`lastRunEndEpoch/Iso`) — refuse (named error) if the runId already has a row (idempotence guard); (d) `--dry-run` prints both would-be records byte-exactly and writes nothing. deps: none. files: scripts/reconcile-run.cjs (new), test/scripts.reconcile-run.test.js (new, fixture transcript dir)
  - Acceptance: (1) fixture transcript (including a truncated final line) → deterministic METRICS line with `"partial":true` + correct budget row, byte-pinned in the test; (2) re-running on the same runId is a named refusal, files unchanged (idempotent); (3) `--dry-run` writes nothing (mtime/content-proven); (4) hostile input (binary junk, missing dir, malformed JSON) → named errors, never a throw, existing files untouched; (5) full suite green.

- **T-72.2** `VERIFIED` Engine archive + ledger verification: rollback deeper than one generation, and make the append-only ledger claim CHECKABLE. (a) extend `scripts/pre-run-gate.cjs`: on GATE-PASS, if `docs/engine-archive/<md5>.js` is absent, copy the gated engine there (bounded rotation: keep the newest 10 by ledger order, delete older archive files ONLY — never ledger rows); (b) new `scripts/engine-ledger.cjs --verify`: recompute md5 of `build-loop.workflow.js`, `build-loop.prev.js`, and every `docs/engine-archive/*.js` and cross-check against `docs/ENGINE-LEDGER.json` (an archive file whose md5 ≠ its filename/ledger entry is a named FAIL); confirm the ledger is append-only versus `git show HEAD:docs/ENGINE-LEDGER.json` when available (prior entries byte-identical — detects rewrites); exit 0 `LEDGER-OK` / exit 1 `LEDGER-FAIL: <reasons>`; (c) document both in `docs/SUPERVISOR-RUNBOOK.md` step 1. deps: none. files: scripts/pre-run-gate.cjs, scripts/engine-ledger.cjs (new), docs/SUPERVISOR-RUNBOOK.md, test/scripts.engine-ledger.test.js (new)
  - Acceptance: (1) in a temp repo fixture: gate-pass archives the engine once (re-run: no duplicate), 11th engine rotates out the oldest ARCHIVE FILE while its LEDGER row survives; (2) tampering one archived byte → `LEDGER-FAIL` naming the file; rewriting a prior ledger row → `LEDGER-FAIL` (append-only breach); clean state → `LEDGER-OK` exit 0; (3) rotation can NEVER delete `build-loop.workflow.js`/`build-loop.prev.js` (pinned negative test); (4) full suite green.

- **T-72.3** `VERIFIED` Governor arithmetic, mechanized: `scripts/governor-check.cjs [--now <epoch>] [--est <tokens>]` — the launch/no-launch decision the supervisor currently re-derives by hand from `docs/USAGE-BUDGET.json`. (a) pure core `evaluateGovernor(budgetObj, nowEpoch, estTokens)` (exported for tests; no clock read inside): window roll-over check (`now >= windowResetEpoch` → the VERDICT says "roll window first" — the script itself never mutates the budget file), cooldown (`now - lastRunEndEpoch >= cooldownSeconds`), ceiling (`spentTokens + est <= ceilingTokens`), and returns `{ launch: boolean, reasons: [...], waitSeconds }`; (b) CLI prints exactly `LAUNCH-OK` (exit 0) or `LAUNCH-BLOCKED: <reasons, incl. how long to wait>` (exit 1); `--now` injects the clock for determinism; (c) wire into `docs/SUPERVISOR-RUNBOOK.md` step 2 as the replacement for hand arithmetic. deps: none. files: scripts/governor-check.cjs (new), docs/SUPERVISOR-RUNBOOK.md, test/scripts.governor-check.test.js (new)
  - Acceptance: (1) table-driven tests over the pure core: cooldown not elapsed / at cap / window expired / all-clear → exact verdicts, reasons, and waitSeconds; (2) CLI on a fixture budget file with `--now` → byte-pinned stdout + exit codes for both verdicts; (3) the script never writes any file (proven); (4) full suite green.

## EPIC-73 — Paved-road repair & first-stranger funnel: make every already-shipped entry surface exit 0 for a cold stranger — distribution & hardening only, NO new verticals  *(Designed by a Fable go-to-market review at the 2026-07-04 park point — full 4-lens adversarial panel (skeptical CISO / growth / substitute-user / honesty auditor) + verify pass, 0 tasks killed. The panel's verdict: adoption is ZERO and the constraint is not features — it is a working funnel, our own hash in our own registry, and one stranger's ACCEPT/REJECT transcript. This epic is the auto-buildable half of "Lever 1: repair the paved road" and "Lever 3: zero-config hook"; the human-gated halves (npm publish of verify-vh, one Show HN post, the vendor mainnet anchor) stay human. Obeys the adoption-zero rule: every task is distribution or hardening of an ALREADY-SHIPPED surface, offline, test-gated, no new dependency, no needs-human. SUPERVISOR ALREADY PRE-LANDED (commit at this park point): the `--registry`→`--contract` README fix and the internal-loop-telemetry tarball exclusion via package.json `files[]` negation — so T-73.1 and T-73.2 builders should treat those as done and focus on the REMAINING parts + the STANDING TESTS that pin them.)*

- **T-73.1** `VERIFIED` Fix the remaining copy-paste front-door failures and pin them with an OFFLINE docs-flag lint. deps: none. files: README.md, docs/ADOPT.md, public/docs/ADOPT.md, verifier/action/README.md, test/adopt.docs.test.js, test/docs-paved-road.test.js
  - Acceptance: (1) every `<owner>/<repo>` placeholder in docs/ADOPT.md, README.md, and verifier/action/README.md is replaced with the real slug `verifyhash/verifyhash` plus a pinned ref that is a full 40-hex commit SHA proven reachable from origin/main (assert offline via `git merge-base --is-ancestor <sha> origin/main` at authoring time; note in the doc that adopters should re-pin to a SHA they trust); test/adopt.docs.test.js is updated to pin the REAL slug + full-SHA ref shape so drift back to a placeholder, `@main`, or a short ref FAILS the suite (it must no longer enforce the placeholder). (2) new test/docs-paved-road.test.js extracts every fenced `vh …` invocation from README.md and docs/ADOPT.md and asserts, offline against cli/vh.js's real parser/help, that each subcommand exists and every `--flag` used is accepted; the test FAILS if it extracts zero invocations (extractor-rot guard) and includes a negative self-test proving a known-bad flag (e.g. `--registry`) and a known-bad subcommand are each detected. (3) public/docs/ADOPT.md regenerated via `node scripts/site-release.js`; `--check` exits 0. (4) live verifyhash.com redeploy stays an explicit needs-human step, out of scope. No network in any test; no new dependency; full suite green.

- **T-73.2** `VERIFIED` Make the verifyhash npm tarball self-contained AND pin the internal-telemetry exclusion with a standing test. deps: none. files: package.json, test/npm-tarball.test.js
  - Acceptance: (1) package.json `files` is extended so `npm pack --dry-run --json` (offline) lists the verifier + examples the README/ADOPT demo paths reference (enumerate by reading examples/run.js — do not guess) so the documented demo resolves from an installed package, NOT only from a repo clone. (2) new test/npm-tarball.test.js asserts, from `npm pack --dry-run --json`: the internal-loop denylist (docs/METRICS.jsonl, docs/USAGE-BUDGET.json, docs/ENGINE-LEDGER.json, docs/LOOP-AUDIT-*, docs/LOOP-HARDENING-PLAN.md, docs/SUPERVISOR-RUNBOOK.md, docs/DECISIONS-PENDING.md, docs/STRATEGY-ARCHIVE.md, docs/MORNING.md, docs/ADOPTION.json, docs/DECIDE.md) is ABSENT (the supervisor's `files[]` negation must not silently regress), AND the user-facing docs allowlist (at least docs/TRUST-BOUNDARIES.md, docs/EVIDENCE.md, docs/ADOPT.md, docs/AGENTTRACE.md) is PRESENT — dropping docs/ wholesale is a FAIL. (3) the test packs for real into a temp dir OUTSIDE the repo, extracts, and runs the documented quickstart from the EXTRACTED tree asserting exit 0 + a genuine VERIFIED and a tampered REJECTED, resolving js-sha3 from the repo's node_modules via NODE_PATH (no registry install, no network). No new dependency; passes offline; full suite green.

- **T-73.3** `VERIFIED` verify-vh publish-readiness gate: prove the standalone front-door package works from its OWN packed tarball before the human publishes it (the `npx --yes verify-vh demo` line 404s until published). deps: none. files: verifier/package.json, test/verify-vh.pack.test.js, docs/PUBLISH-VERIFY-VH.md
  - Acceptance: (1) new test/verify-vh.pack.test.js runs `npm pack` on verifier/ (offline) into an fs.mkdtempSync dir OUTSIDE the repo tree, extracts it, copies js-sha3 from the repo's node_modules into <extracted>/node_modules (so Node resolution cannot silently fall back to the repo). (2) runs `node <extracted>/verify-vh.js demo` asserting exit 0 + an ACCEPT transcript naming the recovered signer (0x70997970c51812dc3a010c7d01b50e0d17dc79c8); then materializes a packet with `demo <dir>`, flips ONE byte of a REFERENCED file (not the packet JSON), re-verifies with --vendor <recovered signer>, asserts exit 3 + a REJECT line naming the changed file. (3) everything `demo` needs is derived from the extracted tree alone (cwd outside the repo) so any file missing from verifier/package.json `files` fails THIS test instead of the first stranger; temp dirs cleaned in a finally/after hook. (4) new docs/PUBLISH-VERIFY-VH.md is a one-page HUMAN checklist (publish from verifier/, then post-publish `npx --yes verify-vh demo` smoke) stating plainly: publishing stays human; until publish the ADOPT front-door line 404s; and the honest boundary verbatim (demo proves tamper-evidence + signer-pin, NOT a trusted timestamp, NOT a legal opinion). docs/ADOPT.md left verbatim. No new dependency; passes offline.

- **T-73.4** `VERIFIED` vh-agent-hook: zero-config SessionEnd transcript sealing over the shipped FREE `vh agent seal` path (Lever 3 — converts the one unserved lane's ~20-line adoption cost to ~0). deps: none. files: cli/agent-hook.js, package.json, docs/AGENT-HOOK.md, test/cli.agent-hook.test.js, examples/agent-session/
  - Acceptance: (1) new bin `vh-agent-hook` (package.json bin map -> cli/agent-hook.js, Node-core only, a THIN mapper over cli/core/agent-session.js's free UNSIGNED seal — no re-implemented crypto, no key, no license, no network): reads the SessionEnd hook event JSON from stdin ({transcript_path, session_id, cwd}), maps the Claude Code transcript JSONL to the shipped agent-session event schema (the examples/agent-session/map-transcript.js approach), seals UNSIGNED, writes <outDir>/<session_id>.vhagent.json (outDir from VH_HOOK_OUT, default .vh-sessions/ under the event cwd), prints the `vh agent verify` one-liner on stderr; exit 0 on seal, NAMED non-zero otherwise, with a top-level catch so it can never crash the host's session end. (2) mapper is DRIFT-TOLERANT: unknown/extra JSONL line kinds are skipped-and-counted, never fatal; malformed stdin, missing/unreadable transcript_path, and an empty transcript each yield a DISTINCT named non-zero exit and write NOTHING. (3) new docs/AGENT-HOOK.md documents the 3-line install and carries BOTH pinned boundary lines verbatim: (a) the seal proves the log is INTACT since seal, NOT that the agent behaved well; (b) NOT a trusted timestamp — ts fields self-asserted — plus a note to `vh agent redact` before sharing (payloads embed verbatim). (4) new test/cli.agent-hook.test.js spawns the binary with fixture stdin + a committed fixture transcript (extending examples/agent-session/) containing REAL Claude Code shapes (user/assistant messages w/ tool_use+tool_result blocks AND ≥1 non-message line): asserts packet written + `vh agent verify` exits 0 ACCEPTED; one-byte flip -> verify exits 3 REJECTED naming the seq; malformed stdin AND missing transcript_path each their named exit with nothing written; repeat run for the same session_id deterministically overwrites. Offline; no new dependency; directory-listing PRs stay human.

- **T-73.5** `VERIFIED` Vendor self-provenance packet builder: OUR OWN identity + v0.1.0 tarball digest, sealed + signed + anchor-ready for the human (Lever 2 — the empty registry + unpinned vendor identity the panel called "disqualifying irony"). deps: none. files: scripts/vendor-provenance.cjs, test/vendor-provenance.test.js, docs/VENDOR-PROVENANCE.md
  - Acceptance: (1) new scripts/vendor-provenance.cjs (node-core, spawns the shipped CLIs; fully OFFLINE, never the network or a real key): packs the repo with `npm pack --pack-destination <tmpdir>`, computes the tarball sha256 + the `vh hash` keccak digest, assembles an evidence dir whose identity statement names the vendor address derived from the CALLER-SUPPLIED key, the package name/version from package.json, the git commit packed, and both digests — stated explicitly as digests of THIS locally packed tarball, NEVER asserted equal to the npm registry's. (2) mints a self-issued license via the shipped `vh evidence license fulfill` with the same key (dogfood) and emits BOTH the UNSIGNED `vh.evidence-seal` packet (the only kind in anchor-artifact's closed table) and the SIGNED container over the same root; the printed anchor command references the UNSIGNED seal (anchoring the signed container is an unknown-kind exit 3 — asserted). (3) prints a numbered HUMAN-STEP block verbatim: (i) confirm the local tarball digest vs the published artifact via `npm view verifyhash dist.integrity` (network, human-only; on mismatch re-pack from the published tag — the script never claims registry equality), (ii) rerun with the real vendor key, (iii) the exact `vh anchor-artifact <unsigned-seal> --contract 0x77d8eF881D5aeEda64788968D13f9146fE1A609B --rpc https://polygon-bor-rpc.publicnode.com --key-env … --out … --i-understand-mainnet`, (iv) publish the vendor address + signed packet on an authoritative channel (README/site) — pinning is only real once published. The script never anchors, spends, or signs with anything but the caller-supplied key env. (4) new test/vendor-provenance.test.js runs it end-to-end with an EPHEMERAL throwaway key: `vh evidence verify` exits 0 on both artifacts, `vh evidence verify-signed --signer <ephemeral>` ACCEPTs; one-byte flip -> exit 3; then EXECUTES the emitted anchor command through cli/vh.js with ONLY the RPC swapped to an unreachable loopback URL and asserts the failure is the network exit 1 (proving the copy-paste survives flag parsing (exit 2) + closed-table validation (exit 3) on OUR side). (5) new docs/VENDOR-PROVENANCE.md states the gap + the boundary in the product's own words (seal proves WHAT bytes/WHO signed, never WHEN; a later anchor proves existence no-later-than block time; the identity statement is SELF-asserted, pinning only once the address is published). No new dependency; no network in script or test; no funds/real key/deploy; passes offline. **NOTE: overclaim-adjacent — the panel flagged this; the boundary language must be exact.**

- **T-73.6** `VERIFIED` Adoption pulse: a fenced, fixture-testable meter for npmDownloads7d — the counter still null in ADOPTION.json ("there isn't even a task to measure npm downloads"). deps: none. files: scripts/adoption-pulse.cjs, test/adoption-pulse.test.js, docs/ADOPTION.json, docs/SUPERVISOR-RUNBOOK.md
  - Acceptance: (1) new scripts/adoption-pulse.cjs (node-core https only): fetches the npm last-week downloads for `verifyhash` and `verify-vh` (a not-found package counts as 0, recorded in a per-package breakdown, NOT a failure); writes ONLY `npmDownloads7d` (sum), `updatedAt`, and a per-package `notes` breakdown into docs/ADOPTION.json, preserving every other field byte-for-byte; `--dry-run` writes nothing. (2) FIXTURE FENCE: `--fixture <file>` reads a canned response instead of the network, and in fixture mode the script STRUCTURALLY REFUSES to write the real docs/ADOPTION.json (requires `--out <path>` that must not resolve to it; named non-zero error otherwise). Rationale: npmDownloads7d is a counter in the engine's adoptionZero conjunction (build-loop.workflow.js preflight) — a fixture write to the real file would let the loop fabricate nonzero adoption and switch off its own adoption-zero gate; only live-network mode (a human/cron act) may touch the real file. (3) HUMAN-COUNTER FENCE: any input/flag that would alter distinctExternalUsers7d, pilotsActive, buyerConversations, or revenueUsdTotal exits non-zero, file byte-identical. (4) HONEST LABEL: the breakdown states the figure is npm weekly downloads INCLUDING mirror/bot traffic — an upper bound on reach, NOT distinct users — so a nonzero value cannot masquerade as adoption to the preflight/strategist. (5) new test/adoption-pulse.test.js runs entirely offline via `--fixture` against a TEMP COPY: correct update w/ other fields byte-preserved; `--dry-run` writes nothing; fixture mode without `--out` (or `--out` = the real file) exits non-zero writing nothing; the human-counter refusal; a malformed/absent fixture exits non-zero untouched; a not-found package counts 0; zero network calls in the test. (6) docs/SUPERVISOR-RUNBOOK.md gains one line: run `node scripts/adoption-pulse.cjs` when online (a runtime act, not part of acceptance). **NOTE: overclaim-adjacent — the honest-label + counter-fence acceptance are load-bearing; do not relax.**

## EPIC-74 — Cold-stranger DX repair: every printed/documented command exits 0 verbatim for the npx audience, and no two published facts disagree  *(Seeded by a 2026-07-05 cold-stranger DX audit (a read-only 7-agent Opus fleet simulating the npx / browser / README / site funnels + a hostile-CTO teardown; report in scratchpad). Verdict matches EPIC-73: the ENGINE passes every hands-on test (ACCEPT 0 → tamper REJECT 3 → restore, offline claims all true), but the FUNNEL fails at the copy layer at the moments of highest stranger intent — the demo's own printed next-steps crash for npx users, README's advertised `npx verifyhash --help` errors, README self-contradicts on publish status, and site/llms.txt published a WRONG checksum (supervisor already hot-fixed the live value + redeployed; T-74.3 pins it). All tasks are distribution/hardening of already-shipped surfaces, offline, test-gated, no new dependency; live-site redeploy stays needs-human.)*

- **T-74.1** `VERIFIED` Channel-aware copy-paste commands in verify-vh demo output — never print `node <file>` to a bin/npx user. deps: none. files: verifier/verify-vh.js, verifier/build-standalone-html.js, test/verify-vh.pack.test.js, verifier/dist/
  - Acceptance: (1) `demo` (lines ~3027/3031) and `demo <dir>` (the `self` detection ~3107–3108 + every `node ${self} …` consumer incl. tamper/restore/NEXT lines) emit `npx --yes verify-vh <args>` when argv[1] resolves to the bin (npx cache or global install), `node verify-vh.js <args>` only when the user ran the local script file; the dangling `see verifier/README.md §0a` pointer (~3146) becomes a reachable URL. (2) test/verify-vh.pack.test.js extended: from the packed-and-extracted tarball (cwd outside the repo), EXECUTE every command line the demo output prints, verbatim, asserting ACCEPT exit 0 → tamper exit 3 → restore exit 0, and that NO printed line contains `node verify-vh` when invoked via the bin. (3) the bare-demo byte-determinism invariant test is UPDATED (not deleted) to pin the new canonical output; standalone bundle regenerated + .sha256 refreshed (interacts with T-74.3's single-checksum rule). Offline; no new dependency; full suite green.

- **T-74.2** `VERIFIED` README front-door truth pass: fix the broken `npx verifyhash` line, kill the stale "not yet published" caveat, lead with the offline value. deps: none. files: README.md, test/docs-paved-road.test.js
  - Acceptance: (1) `npx verifyhash --help` → `npx --yes -p verifyhash vh --help` (all `npx verifyhash …` occurrences audited to the `-p verifyhash vh …` form). (2) the stale "publishing … is intentionally not performed / until then use the local path" caveat rewritten to state `verifyhash` IS published (latest per package.json version at authoring time), local checkout demoted to the offline/from-source alternative — reconciled so the README agrees with itself and with site card 03. (3) a one-line offline lede added above the on-chain intro; the Polygon/contract paragraph and the GO-LIVE callout moved below Install/Quickstart. (4) test/docs-paved-road.test.js extended: every fenced `npx <pkg> …` invocation in README.md/docs/ADOPT.md must name a bin present in that package's `bin` map (negative self-test: `npx verifyhash` is detected as bad), and a docs-consistency assertion fails if the README simultaneously claims published and not-published. Offline; full suite green.

- **T-74.3** `VERIFIED` One canonical published checksum: llms.txt is GENERATED from the manifest, and a standing test forbids digest drift across every surface that publishes it. deps: none. files: scripts/site-release.js, site/llms.txt, test/site-release.test.js
  - Acceptance: (1) scripts/site-release.js takes ownership of writing the `verify-vh-standalone.js` (and .html if published) sha256 into site/llms.txt from RELEASE-MANIFEST so it can never hand-drift again; `--check` exits nonzero on mismatch. (2) new/extended test asserts site/llms.txt, site/index.html, site/DEPLOYED.json, and site/RELEASE-MANIFEST.json all carry the IDENTICAL digest AND that it equals the freshly computed sha256 of verifier/dist/verify-vh-standalone.js. (3) doc note: the LIVE site serves a pinned bundle; redeploy is needs-human. NOTE: the supervisor already hot-fixed the stale live value (site/llms.txt c73f795… → 6de719e…) + redeployed on 2026-07-05; this task makes the fix STRUCTURAL so it can't recur. Offline; no new dependency; full suite green.

- **T-74.4** `VERIFIED` Standalone verifier + landing page first-screen legibility: plain lede first, agent-session demo collapsed, offline proof a layperson can run, verifier one click from the hero. deps: none. files: verifier/build-standalone-html.js, site/index.html, verifier/dist/, test/ (standalone HTML test)
  - Acceptance: (1) build-standalone-html.js: plain-English lede above the technical note ("Check whether a file someone handed you is byte-for-byte what they signed — and who signed it. Everything runs on this computer; nothing is uploaded."); "without the P-3 trust-root" → "without a separate trusted timestamp"; the devtools reassurance gains "disconnect from the internet first — it still works"; section 1b (agent-session) collapsed behind a `▸ Show the advanced agent-session demo` toggle with a one-sentence plain intro, positioned after the "Verify a packet YOU were handed" section. (2) site/index.html: card 01 gains the built-in-sample clause + a real `Open the verifier` button linking /verify-vh-standalone.html; hero CTA points at /verify-vh-standalone.html. (3) dist regenerated, .sha256 + RELEASE-MANIFEST refreshed (T-74.3's consistency test stays green); standalone tests extended to pin the toggle + lede. Offline; no new dependency; full suite green.

- **T-74.5** `VERIFIED` Answer "why not sha256sum + a signed git tag / cosign / Rekor?" head-on, and un-drift ANCHORING.md from the real mainnet deploy. deps: none. files: README.md, docs/ANCHORING.md, docs/TRUST-BOUNDARIES.md, site/index.html, test/adopt.docs.test.js
  - Acceptance: (1) a three-row HONEST comparison table (README + landing page): what sha256sum/signed-tag/cosign+Rekor already give (FIPS hashes, ecosystems, Rekor timestamps — stated as strengths), what verifyhash adds (one offline single-file verifier a counterparty runs with no toolchain/account/CA; signer-pin + per-file tamper localization; optional permissionless existence anchor), and what verifyhash does NOT do (no trusted timestamp without the anchor; keccak256 not FIPS) — no claim the free tools "can't" do what they can. (2) docs/ANCHORING.md reconciled with the real 2026-07-03 Polygon deploy: the "until a human deploys… worth nothing publicly" language updated to name the live contract 0x77d8eF881D5aeEda64788968D13f9146fE1A609B while KEEPING the loop-never-deploys/holds-funds guardrail sentence verbatim; ADOPT's CI recipe reorders `vendor:` as the default recommended form with tamper-only labeled the weaker mode. (3) docs lint extended to fail if the not-deployed phrase reappears alongside the mainnet claim. Offline; no new dependency; full suite green. **NOTE: flippers RFC-3161/FIPS-hash, surface-cut, external-adopter/review are strategy/human-gated — see docs/DECISIONS-PENDING.md, do NOT auto-build.**

## EPIC-75 — Security hardening: the confirmed findings of the 2026-07-05 read-only ULTRA-AUDIT (5 findings, each reproduced end-to-end against as-shipped code, survived an adversarial refute pass)  *(A parallel Opus audit fleet red-teamed the paid pipeline, key-handling, the live mainnet contract, verifier independence, supply chain, and overclaims. The crypto CORE is sound — a relying party that PINS the real vendor key still correctly REJECTS every forged/attacker-signed artifact. The problems are all in the layer around it: the safe behavior is never the default, and the trust story leaks on the exact surfaces a first customer touches. The llms.txt-hash HIGH is already fixed (supervisor hot-fix + EPIC-74 T-74.3). These are the rest. All offline, test-gated, no new dependency. Report in scratchpad/ultra-audit/REPORT.md.)*

- **T-75.1** `VERIFIED` **HIGH** — Scrub the raw on-chain key paths so no private-key material can ever reach stderr/logs. deps: none. files: cli/vh.js, cli/core/attestation.js, test/cli.key-hygiene.test.js
  - Acceptance: (1) the five raw `const pk = process.env.PRIVATE_KEY` paths in cli/vh.js (~786/975/1043/1097/1318 at audit time — locate by pattern, not line) `.trim()` the key AND route creation through the hardened `cli/core/attestation.js` loader (or an equivalent guard) so a malformed key (e.g. `export PRIVATE_KEY=$(cat keyfile)` with a trailing newline) is rejected with a message that names ONLY the source, never the value. (2) EVERY `catch (e) { …e.message… }` on a signing/wallet path is scrubbed: ethers' `invalid BytesLike value (…, value="0x…")` message must not be echoed verbatim — replace with a fixed, value-free string. (3) new test/cli.key-hygiene.test.js spawns each affected verb with a deliberately malformed EPHEMERAL key (never a real key) and asserts the process output (stdout+stderr) contains NONE of the key bytes and a clean named error; a positive path with a clean ephemeral key still works against a loopback provider (or is asserted to reach the network-exit boundary). VERIFIED live-behavior note: `new ethers.Wallet("0x…\n")` currently echoes the full value — the test must fail on the pre-fix code. Offline; no new dependency; full suite green.

- **T-75.2** `VERIFIED` **MEDIUM** — Fail-closed verify: an unpinned signer must not present as marketed "real provenance". deps: none. files: verifier/verify-vh.js, cli/verify.js (or the shared verify core), docs/ADOPT.md, verifier/ci/*, test/
  - Acceptance: (1) `verify`/`verify-signed` without `--vendor`/`--signer` still may print the RECOVERED signer, but the human/JSON verdict must state UNPINNED explicitly ("signed by 0x… — NOT pinned to a trusted vendor; anyone's key passes") and a `--strict` mode makes unpinned a distinct NON-zero exit (fail-closed) so a CI gate cannot silently accept an attacker-self-signed artifact. (2) the shipped CI recipes (verifier/ci/*) default to the pinned/strict form; the exit-code contract is documented (0 ACCEPT-and-pinned, the new code for unpinned-under-strict, 3 REJECT). (3) tests: an artifact signed by an attacker's OWN key returns the new non-zero under `--strict` and a clearly-labelled UNPINNED verdict without it; a correctly pinned genuine artifact stays exit 0. Preserve the existing 0/3 contract for pinned calls (no regression to the standalone conformance). Offline; no new dependency.

- **T-75.3** `VERIFIED` **MEDIUM** — Paid-gate: pin license verification to a canonical vendor identity, not caller-supplied `--vendor`. deps: none. files: cli/core/license.js, cli/evidence.js (paid `--sign` gate), trustledger/license.js, docs/LICENSING.md, test/
  - Acceptance: (1) the `--sign`/unlimited entitlement gate currently trusts a license signed by whatever key the caller passes as `--vendor`, so anyone can self-mint a license and unlock the paid surface for free (revenue-only leak — NOT impersonation; their seals are still signed by their own key). Change the gate to verify the license against a CANONICAL vendor address (a committed constant / config, e.g. the published vendor identity 0x7cb4d3DC6C52996B6386473Bfb32f898263412f7), so only licenses minted by the real vendor key unlock paid entitlements. (2) keep the self-hosting story honest: document that an operator running their OWN instance sets their OWN canonical vendor constant (this is a gate against free-riding a HOSTED vendor, not a DRM claim). (3) tests: a license minted by a non-canonical key no longer unlocks `--sign` (named refusal); a license minted by the canonical key still does; the offline verify path for already-signed packets is unchanged. Offline; no new dependency. **NOTE: revenue-integrity-adjacent; a license is an ACCESS credential, never a token — do not touch that boundary.**

- **T-75.4** `VERIFIED` **LOW** — Bare merkle-proof bundle must not print an unconditional "root matches: yes". deps: none. files: cli/proof.js (or the proof-verify path), docs/PROOFS.md, test/
  - Acceptance: (1) a self-contained (path,hash,siblings,root) proof bundle trivially "matches" because leaf/siblings/root all come from the same artifact — the current verdict overclaims. Weaken the verdict for an UNANCHORED proof to state it proves internal consistency ONLY ("this proof is well-formed; it is NOT bound to any external/anchored root — pin the root out-of-band or verify against the on-chain record") and reserve a strong ACCEPT for a proof checked against an independently-supplied/anchored root. (2) tests assert the weakened wording for a bare bundle and the strong verdict only when an external root is supplied/matched. Offline; no new dependency. UX/overclaim fix, not a crypto bypass.

- **T-75.5** `VERIFIED` **MEDIUM** — `verify-vh --dir` must not silently ACCEPT an unsealed extra file when used as a CI gate (SUPERVISOR-VERIFIED gap: an injected file in a sealed dir → "OK, 0 unexpected", exit 0). deps: none. files: verifier/verify-vh.js, cli/verify.js (shared verify path), docs/ADOPT.md, docs/TRUST-BOUNDARIES.md, test/
  - Acceptance: (1) evidence seals bind a NAMED FILE SET, not a directory boundary (verify-vh.js current behavior is by-design for the seal) — but the default `--dir` output ("0 unexpected") + the site's "gate a build on real provenance" pitch OVERCLAIM it: confirmed live, dropping `EVIL-injected.sh` into a sealed dir still prints "OK — the artifact verifies", exit 0. Add an opt-in `--exact-dir` (a.k.a. `--strict`) mode that scans the WHOLE directory and REJECTs (exit 3) any file present-on-disk-but-not-in-the-seal, with the "unexpected" counter actually populated in that mode and the offending path named. (2) the DEFAULT `--dir` output is reworded so it cannot be read as "the whole directory is vouched-for" (e.g. "verified the N sealed files; other files in this directory are NOT covered — use --exact-dir to reject extras"). (3) the ADOPT/site CI-gating recipe recommends `--exact-dir` for build gating; docs state the named-set-vs-directory boundary plainly. (4) tests: injected extra file → REJECT/3 under `--exact-dir`, and the existing named-file semantics unchanged without the flag; a positive genuine case still ACCEPTs both ways. NOTE: this is the 6th conformance vector (`extra-file`) — after this lands, the alternate-language verifiers (EPIC-77) get the same mode so all impls go 6/6 GREEN. Offline; no new dependency; full suite green.

## EPIC-77 — Multi-language independent verifier suite: wire the supervisor-landed Go + Rust verifiers + the frozen cross-implementation conformance vectors into the test suite, and ship the alternate implementations so a counterparty can cross-check with FOUR languages, zero shared dependencies  *(Built 2026-07-05/06 by parallel Opus fleets in isolated scratch, SUPERVISOR-VERIFIED and landed additively: `verifier-go/` (pure Go, ZERO external modules — go.mod with no requires; hand-rolled keccak + math/big secp256k1), `verifier-rs/` (pure Rust, ZERO crates — Cargo.lock = 1 package; hand-rolled keccak + U256 4×u64 field math + SEC 1 §4.1.6 recovery), and `verify-vectors/` (6 frozen SHA256SUMS-pinned cross-impl cases + conformance-4way.py). The supervisor ran the 4-way harness: JS == Python == Go == Rust are BYTE-IDENTICAL in verdict + exit on all 6 cases (the `extra-file` case is the shared spec gap T-75.5 closes, not an inter-impl divergence). Category (b) — hardens the #1 "verify independently" value prop and answers the single-implementation objection with the strongest possible evidence: a bug or backdoor would have to exist identically in four separate codebases across four languages. Sources are drop-in; the harness needs repo-landing adaptations (repo-relative paths, ephemeral test key).)*

- **T-77.1** `VERIFIED` Wire the multi-language conformance into the repo test suite. deps: none. files: test/conformance-multilang.test.js, verify-vectors/conformance-4way.py
  - Acceptance: (1) new test/conformance-multilang.test.js runs the JS verifier (always) plus Python (skip-if-`python3`-absent), Go (skip-if-`go`-absent), and Rust (skip-if-`cargo`/`rustc`-absent) over EVERY case in verify-vectors/vectors.json, asserting byte-identical verdict + exit across all PRESENT implementations AND vs the vector's expected — EXCEPT the `extra-file` case is treated as the documented shared gap until T-75.5 lands (then it must go GREEN for every present impl). (2) verify-vectors/conformance-4way.py is de-scratched: repo-relative paths (resolve repo root from __file__), the Go/Rust binaries built hermetically-offline from the landed sources (pinned toolchains discovered via env or PATH; a missing toolchain SKIPS that leg with a visible notice, never fails). (3) a real DIVERGENCE (two present impls disagree) fails loudly naming the case. Offline; no new JS dependency. Full suite green (skips are green).
- **T-77.2** `VERIFIED` Document the 4-language suite + ship the alternate implementations so USERS get them. deps: T-77.1. files: docs/INDEPENDENT-VERIFICATION.md, package.json, test/npm-tarball.test.js
  - Acceptance: (1) docs/INDEPENDENT-VERIFICATION.md gains a "verify with up to FOUR independent implementations" section: exact run commands for verifier-py/verify_vh.py, verifier-go (go run/build), verifier-rs (cargo run) + the honest scope (evidence-seal path; SAME trust boundary as verify-vh; not a trusted timestamp; keccak256 is not FIPS though Python/Go/Rust stdlibs offer sha256/sha3 if a FIPS variant is added) + the pitch: 4 languages, zero shared deps, one frozen vector suite, and a customer's auditor can write a 5th against verify-vectors/. (2) ship verifier-py/verify_vh.py + verifier-go/*.go + verifier-rs/ (src + Cargo.toml) + verify-vectors/ in the `verifyhash` npm `files[]`; extend test/npm-tarball.test.js to assert the alternate-impl sources are PRESENT and no internal-loop file leaks. (3) no verdict change (T-77.1 conformance stays green). NOTE: shipping the alternates is a substantive shipped-artifact change → ANCHOR that release on-chain. Offline; no new dependency; full suite green.

## EPIC-76 — Second, INDEPENDENT verifier (Python): wire the supervisor-landed `verifier-py/` into the test suite + docs, so a counterparty can cross-check the JS verdict with a different-language implementation  *(Built 2026-07-05 by a parallel Opus fleet in isolated scratch, then SUPERVISOR-VERIFIED and landed additively at `verifier-py/` (verify_vh.py + SPEC/DEPENDENCIES/README + conformance.py as reference). It is a clean-room re-implementation of the evidence-seal verify path: ZERO dependencies — pure-Python keccak256 (Ethereum 0x01 padding, validated vs canonical vectors) + pure-Python secp256k1 (v,r,s) recovery (SEC 1 §4.1.6). The supervisor ran conformance.py: all 4 cases (genuine ACCEPT/0, tampered CHANGED/3, wrong-vendor wrong_issuer/3, missing MISSING/3) are BYTE-IDENTICAL to the shipped JS verifier. This is NOT a new vertical — it HARDENS the #1 value prop ("verify independently") and directly answers the hostile-CTO "single-implementation" objection (category (b), allowed under the adoption-zero rule). The verifier itself is drop-in; only the harness needs repo-landing adaptations.)*

- **T-76.1** `VERIFIED` Wire the Python↔JS conformance into the repo test suite (adapt the scratch harness: repo-relative paths, ephemeral test key). deps: none. files: test/conformance-py.test.js, verifier-py/conformance.py
  - Acceptance: (1) new test/conformance-py.test.js SKIPS cleanly (not fail) when `python3` is absent (probe `python3 --version`); otherwise it seals a genuine packet with an EPHEMERAL `Wallet.createRandom()` key via the shipped `node cli/vh.js evidence seal … --key-env <ephemeral>` (NEVER the operator self-license or any real key), derives the 4 cases (genuine+correct-vendor, tampered file, wrong vendor, missing referenced file), runs BOTH `node verifier/verify-vh.js` and `python3 verifier-py/verify_vh.py` with `--json`, and asserts byte-identical ACCEPT/REJECT decision AND identical process exit code (0/3) per case. (2) verifier-py/conformance.py is de-scratched: all paths repo-relative (resolve the repo root from __file__), the sealing key ephemeral — no absolute /tmp or /home paths, no self-license. (3) a DIVERGENCE (the two verifiers disagree) fails the test loudly naming the case. Offline (no network beyond the local seal); no new JS/Python dependency (stdlib only). Full suite green.

- **T-76.2** `VERIFIED` Document the second implementation + decide/execute shipping it so USERS get cross-verification. deps: T-76.1. files: docs/INDEPENDENT-VERIFICATION.md, verifier-py/README.md, package.json, test/npm-tarball.test.js
  - Acceptance: (1) docs/INDEPENDENT-VERIFICATION.md gains a "verify with a SECOND, independent implementation" section: a counterparty who distrusts one verifier can run the other (different language, zero shared deps) and confirm the SAME ACCEPT/REJECT — with the exact `python3 verify_vh.py <packet> --vendor 0x… --dir <files>` command and the honest scope (evidence-seal path only; SAME trust boundary as verify-vh; NOT a trusted timestamp; keccak256 is not FIPS, though Python stdlib offers sha256/sha3_256 if a FIPS variant is ever added). (2) ship verify_vh.py + verifier-py/SPEC.md + DEPENDENCIES.md in the `verifyhash` npm `files[]` so an installer actually GETS the second implementation; extend test/npm-tarball.test.js to assert verifier-py/verify_vh.py is PRESENT in the tarball AND still no internal-loop file leaks (the negation set holds). (3) no change to verify_vh.py's verdicts (the T-76.1 conformance must stay green). Offline; no new dependency; full suite green. NOTE: this is the release that SHOULD be anchored on-chain (a substantive shipped-artifact change).

## EPIC-78 — PUBLIC-SURFACE INTEGRITY: heal what the internal-file untracking (73ec697) broke on every shipped surface  *(Category (b) HARDENING of already-shipped surfaces + (a) the docs a first stranger reads — NOT new product. Commit 73ec697 correctly made the loop-internal files (STRATEGY.md, docs/MORNING.md, docs/DECIDE.md, BACKLOG.md, …) local-only, but left every PUBLIC surface pointing at them: (i) README.md — the public repo front door — plus ~16 tracked/published docs carry markdown links like `[STRATEGY.md](../STRATEGY.md)` that now 404 on github.com/verifyhash/verifyhash, on verifyhash.com, and inside the npm tarball; (ii) user-facing CLI output strings (cli/agent.js, cli/core/anchor-binding.js, cli/core/revocation.js, cli/evidence.js, …) tell strangers to "see STRATEGY.md P-3" — a file absent from the repo they cloned; (iii) the site publish set STILL publishes docs/DECIDE.md — an UNTRACKED internal-loop page whose framing ("unblock the loop", a stale time-boxed pilot ask, a link to the unpublished docs/MORNING.md) is exactly the internal-telemetry leak class ce4f35b purged from the tarball — and its generator scripts/sync-decide.cjs now CRASHES (the per-run MORNING.md no longer carries a P-8 block) with its drift-guard test deleted, so nothing red flags any of this. For a product whose whole pitch is "trust what you can verify", the front door 404ing on its own links is a funnel defect. All offline, test-gated, no new dependency.)*

- **T-78.1** `VERIFIED` De-publish the internal DECIDE page from the site + retire its crashed generator (the ask now lives in docs/DECISIONS-PENDING.md, sharpened 2026-07-06). deps: none. files: site/publish-set.json, site/RELEASE-MANIFEST.json, scripts/sync-decide.cjs (delete), docs/DECIDE.md (delete), public/docs/DECIDE.md (delete), docs/DEPLOY-PUBLIC-SITE.md
  - Acceptance: (1) site/publish-set.json no longer maps "docs/DECIDE.md" (it is today the ONLY publish source that is not git-tracked — proven by resolving every publish-set source against `git ls-files`); `node scripts/site-release.js` reassembles public/ and regenerates site/RELEASE-MANIFEST.json without it, and `node scripts/site-release.js --check` exits 0. (2) DELETE scripts/sync-decide.cjs, docs/DECIDE.md, and public/docs/DECIDE.md: the generator is proven dead (it throws "could not find the P-8 ask in docs/MORNING.md" because MORNING.md is a per-run engine snapshot that no longer carries the P-8 block; its companion test test/decide.docs.test.js no longer exists), and the page's content — a time-boxed design-partner pilot ask — is SUPERSEDED by the collapsed first-contact ask in docs/DECISIONS-PENDING.md §3, so regenerating it would revive a stale ask. This deletes a BROKEN generator and an untracked stale artifact, not a passing test. (3) after the change, no tracked file and no publish-set entry references docs/DECIDE.md or scripts/sync-decide.cjs (`git grep -l "DECIDE"` clean of links/publishes; historical prose in docs/DECISIONS-ARCHIVE.md may keep the name as text). (4) docs/DEPLOY-PUBLIC-SITE.md gains one sentence: the next REPLACE-mode upload (P-11) REMOVES the live /docs/DECIDE.md page from the webroot. (5) full `npx hardhat test` suite green; offline; no new dependency.

- **T-78.2** `VERIFIED` Repoint every PUBLIC reference to the now-internal STRATEGY.md / MORNING.md / BACKLOG.md at a tracked, published anchor — the front door must not 404 on its own links. deps: none. files: docs/TRUST-BOUNDARIES.md, README.md, docs/*.md (the ~16 tracked docs with dangling links), challenge/README.md, examples/README.md, pilot/README.md, cli/agent.js, cli/core/anchor-binding.js, cli/core/evidence-plans.js, cli/core/revocation.js, cli/core/vendor-identity.js, cli/evidence.js (+ any other cli/*.js with a user-facing "STRATEGY.md P-N" string), affected pinned tests
  - Acceptance: (1) docs/TRUST-BOUNDARIES.md (tracked + already in the site publish set) gains a SHORT "Human-owned steps" section with stable anchors that faithfully summarizes, in 1–3 sentences each, exactly what the internal proposals P-2 (public deploy), P-3 (signing/timestamp trust-root), P-6/P-7 (vendor key, pricing, license issuance) own — WITHOUT reproducing internal GTM detail — and states plainly that the full proposals live in the maintainers' internal strategy log. (2) ZERO dangling relative markdown links across ALL tracked .md files: `git grep -nE "\]\((\.\./)*(STRATEGY|BACKLOG)\.md|\]\((\.\./)*docs/(MORNING|DECIDE)\.md|\]\(MORNING\.md"` returns nothing; every former `[STRATEGY.md](…)` link points at the new TRUST-BOUNDARIES anchor (or equivalent tracked public doc). (3) user-facing CLI output/comment strings that direct a USER to "STRATEGY.md P-N" are repointed to the public anchor; the HONEST-BOUNDARY SENTENCES themselves ("rides the human-owned signing/timestamp trust-root", "NOT a trusted timestamp", "NOT a legal opinion", …) are preserved with pointer-only edits — any test pinning the old pointer text is UPDATED in the same commit (never deleted, never weakened: the boundary substance must remain asserted verbatim). (4) `node scripts/site-release.js` regenerated + `--check` exit 0; the npm-tarball tests stay green (README + docs ship in the tarball). (5) full suite green; offline; no new dependency.

- **T-78.3** `VERIFIED` Durable guard: a tracked-markdown link-integrity test so the 73ec697 breakage class (public docs linking untracked/internal files) is a RED BUILD forever, not a Strategist archaeology find. deps: T-78.1, T-78.2. files: test/docs.link-integrity.test.js
  - Acceptance: (1) new test enumerates all TRACKED .md files (`git ls-files '*.md'` via child_process — local-only, no network), extracts relative markdown link targets (skipping http(s)/mailto/data URIs and pure #fragment links; stripping #fragments and querystrings from kept targets), resolves each against the repo root/file dir, and FAILS naming file:line→target for any target that (a) does not exist on disk OR (b) exists but is NOT itself git-tracked — the exact class where a public doc links an internal/gitignored file. (2) an explicit denylist assertion independent of link syntax: no publish-set SOURCE file and no tarball-shipped .md contains a markdown LINK to STRATEGY.md, docs/MORNING.md, docs/DECIDE.md, or BACKLOG.md. (3) the publish-set invariant from T-78.1 is pinned: every source path in site/publish-set.json is git-tracked. (4) test is deterministic + offline, passes at HEAD once T-78.1/T-78.2 land, and full suite stays green.

## EPIC-79 — FIRST EXPANSION: grow the e-invoice conformance validator (`einvoice/`) under the verifyhash umbrella  *(Owner mandate 2026-07-06: verifyhash is an EXPANDING family, not one product — the loop was "too contained." This is the first expansion: an EN 16931 / XRechnung e-invoice compliance validator with a LEGALLY FORCED buyer (Germany Wachstumschancengesetz 2025-28, France PDP reform 2026-27, EU ViDA). First slice DONE + supervisor-verified: 20 rules, 20100/20100 = 100% agreement with the OFFICIAL EN 16931 Schematron over 1005 real invoices (einvoice/differential.py, SaxonC). NON-NEGOTIABLE DISCIPLINE for every task here: each rule that claims to match the standard MUST be added to einvoice/differential.py's differential run against the official Schematron and show 0 divergence over the corpus BEFORE it counts as VERIFIED — the legal artifact is ground truth, never our hand model. Honest scope stays in einvoice/CORRECTNESS.md; never claim beyond what provably matches. Zero-dep Python stdlib only. einvoice may later get its own website / package identity while staying under the umbrella.)*

- **T-79.1** `VERIFIED` Next batch of EN 16931 UBL business rules (target ~20 more), each differential-proven against the official Schematron. deps: none. files: einvoice/einvoice/rules.py, einvoice/differential.py, einvoice/CORRECTNESS.md
  - Acceptance: (1) implement the next ~20 highest-value unimplemented EN 16931 UBL rules (e.g. the remaining BR-CO-* calculation rules, BR-DEC-* decimal rules, the VAT-category families BR-AE/E/G/IC/IG/IP/O-01..10, BR-CO-16/17/18) as pure functions in rules.py, added to ALL_RULES. (2) einvoice/differential.py run (official EN16931-UBL Schematron vs ours, over the full corpus) shows the new rules at 100% agreement (0 false-pos, 0 miss) — a divergence is a FAIL to fix against the official ruleset, not to explain away. (3) conformance.py stays green (no regression). (4) einvoice/CORRECTNESS.md updated with the new rule count + corpus size + the honest remaining gap. Zero new deps.
- **T-79.2** `VERIFIED` XRechnung national CIUS layer (BR-DE-*), differential-tested against the XRechnung Schematron. deps: T-79.1. files: einvoice/einvoice/rules_xrechnung.py, einvoice/differential.py, einvoice/CORRECTNESS.md
  - Acceptance: (1) wire the XRechnung Schematron (corpus/xrechnung-testsuite / the KoSIT XRechnung validation artifacts) into differential.py as a SECOND official ruleset; implement the BR-DE-* rules as a layered profile on top of EN 16931. (2) our BR-DE-* verdicts match the official XRechnung Schematron over its testsuite (0 divergence on implemented rules). (3) CORRECTNESS.md distinguishes EN 16931 core vs XRechnung CIUS coverage honestly. Zero new deps.
- **T-79.3** `BLOCKED` verifyhash × e-invoice SYNTHESIS: a tamper-evident, independently-verifiable conformance RECEIPT (reuses the verifyhash core). deps: T-79.1. files: einvoice/receipt.py, einvoice/README.md, test
  - auto-build failed after 3 attempts: runner exit=1; s not exist on disk) einvoice/corpus/xrechnung-schematron/README.md:30 -> ./docs/development.md (does not exist on disk)
  - Acceptance: (1) on a PASS, `einvoice validate <f> --receipt <out>` emits a signed/sealable attestation "this exact invoice (digest) passed EN 16931 rules [list] at time T", built on the shipped verifyhash sealing/anchoring so a tax authority or auditor can verify it OFFLINE with no account (the demand product carrying the provenance asset). (2) the receipt is verifiable by the standalone verifyhash verifier; a one-byte change to the invoice breaks it. (3) honest scope: the receipt proves WHICH rules passed on WHICH bytes at (optionally anchored) time T — not legal conformance beyond the implemented rules. Tests cover PASS→receipt→verify and tamper→reject.
- **T-79.4** `VERIFIED` Package `einvoice/` as an embeddable, self-hostable product with an honest README + a CI conformance-gate recipe an ERP/billing vendor can drop in. deps: T-79.1. files: einvoice/README.md, einvoice/pyproject.toml (or bin), einvoice/ci/
  - Acceptance: (1) `einvoice validate` is installable/embeddable (a clean entry point + minimal packaging, still zero runtime deps); (2) a copy-paste CI gate recipe that fails a build on a non-conformant invoice, naming the rule ID; (3) README leads with the honest coverage + the differential-vs-official proof + the legal forcing function; the KILL/CONTINUE metric (one ERP vendor embeds it, or full-corpus coverage milestone) is stated. Distribution/hardening of the shipped expansion — no overclaim.

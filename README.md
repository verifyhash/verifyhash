# verifyhash

A tamper-evident, permissionless, immutable on-chain registry of code-contribution hashes
(Polygon-targeted). Anchor the hash of a file or an entire repository on-chain; anyone can later
prove that some content is byte-for-byte what was anchored — without trusting any server, any
admin, or any private key to read.

The registry contract (`contracts/ContributionRegistry.sol`) is deliberately ownerless: no admin,
no pause, no upgrade path, and it never holds funds. Each content hash can be anchored exactly once
(first-writer-wins) and can never be altered or deleted. That immutability is the product.

**Live deployment — Polygon mainnet (chain id 137):**
[`0x77d8eF881D5aeEda64788968D13f9146fE1A609B`](https://polygonscan.com/address/0x77d8eF881D5aeEda64788968D13f9146fE1A609B)
(deployed 2026-07-03; ownerless — the deploying key holds no special power over it). Pin this address
out-of-band; `vh` reads/writes against it with `--contract 0x77d8eF881D5aeEda64788968D13f9146fE1A609B`.

> **Ready to charge for it?** [`docs/GO-LIVE.md`](docs/GO-LIVE.md) is the decision-ready "first dollar" page (`npm run go-live`): the **self-serve evidence license** is the recommended default; the design-partner **pilot** is the enterprise fallback.

## Install / Quickstart

> **Adopt in one line.** Want to *receive* and *check* sealed artifacts without an account or our toolchain?
> The self-serve on-ramp is [`docs/ADOPT.md`](docs/ADOPT.md): `npx --yes verify-vh demo` for a 5-second
> proof, or a one-line GitHub Action
> (`uses: verifyhash/verifyhash/verifier/action@17696eff5d910b496b8935052ff42ee2e7c6a85a` — pinned to a
> real commit on `main`; re-pin to a full commit SHA **you** trust) to gate your CI — and
> the free→paid bridge to issuing **your own** signed, customer-verifiable seals (the paid producer surface).

`verifyhash` ships the `vh` command. You do **not** need to clone the repo to use it.

```bash
# published on npm — https://www.npmjs.com/package/verifyhash
npm install -g verifyhash      # puts `vh` on your PATH
# or run it without installing:
npx verifyhash --help

vh --help                      # the full usage block
vh hash ./myfile.txt           # keccak256 of a file (offline, no key, no network)
```

Building a tamper-evident dataset manifest works the same way — fully offline — via the
DataLedger subcommands documented below.

### See the whole pipeline in one command (offline, no key, no network)

The fastest way to see what `verifyhash` does is to run the committed end-to-end example. From a
checkout (`npm install`, then):

```bash
node examples/run.js
```

It exercises the **real** DataLedger + ProofParcel buyer pipeline against tiny committed sample data —
`dataset build → check --policy → verify → report → attest` and `parcel build → verify → attest` —
prints a clear **PASS/FAIL** summary with the produced artifact paths, and demonstrates that a deliberate
**policy violation is FLAGGED** and a **one-byte tamper is caught**. It writes its artifacts to an OS
temp dir (override with `VH_EXAMPLE_OUT`, keep them with `VH_EXAMPLE_KEEP=1`) — **never** into the repo.
It needs **no key, no TSA, no RPC, no network**, and it references — but never runs — the human-gated
`sign` / `timestamp` / anchor steps so you can see exactly where the trust-root handoff is. The example
is gated by `test/cli.examples.test.js`, so it can never silently rot. See
[`examples/README.md`](examples/README.md).

The offline commands need only the package's
runtime dependencies (`ethers`, `js-sha3`) — no chain, no key, no `hardhat`. The on-chain
read/write commands (`vh anchor/claim/verify/list/show/lineage/reputation`) additionally
need an RPC endpoint; the registry ABI is bundled in the package, so they run from a clean
install without any compile step.

**Local install (works today, no registry needed):** from a checkout of this repo,

```bash
npm install          # installs dependencies (incl. devDependencies)
npm install -g .      # OR: npm link  — both create a global `vh` from this checkout
vh --help
```

> Publishing `verifyhash` to the public npm registry (so `npm install -g verifyhash`
> resolves remotely) is a **human action** and is intentionally not performed by the build.
> Until then, use the local install path above.

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
vh reputation <addr>                 # read-only, no key, authenticated: a non-transferable, re-derivable contribution SCORE for one address (NOT a token)
vh dataset build <dir> --out <p>     # DataLedger: tamper-evident dataset manifest (Merkle root + per-file leaves); offline, no key, no network
vh dataset verify <dir> --manifest <p> # re-derive the root + per-file ADDED/REMOVED/CHANGED diff vs a manifest; offline, no key, no network
vh dataset diff <manifestA> <manifestB> # the exact change set between two dataset versions; offline, no key, no network
vh dataset summary <manifest>        # provenance/license roll-up over the trusted file set; offline, no key, no network
vh dataset check <manifest> --policy <p> # OFFLINE license/source policy gate (PASS/FAIL, CI-gateable exit 0/3); offline, no key, no network
vh dataset report <manifest> [--verify <dir>] [--policy <p>] # ONE deterministic evidence document the reviewer files; offline, no key, no network
vh dataset attest <manifest>         # canonical UNSIGNED attestation payload a human trust-root signs (P-3); offline, no key, no network
vh dataset sign <manifest> --key-env <VAR>|--key-file <p> # sign the UNSIGNED attestation with a key YOU provisioned -> signed container; reads YOUR key, never generates/persists/logs one; offline, no network
vh dataset verify-attest <signed> [--manifest <m>] [--signer <addr>] # OFFLINE-verify a SIGNED attestation container (recover signer, pin publisher, bind manifest); no key, no network, CI-gateable exit 0/3
vh dataset timestamp-request <manifest> # emit the SHA-256 digest your RFC-3161 TSA stamps (P-3 Option B); offline, no key, no network
vh dataset timestamp-wrap <manifest> --token <p> # wrap a TSA's RFC-3161 token -> verifiable timestamped container; offline, no key, no network
vh dataset verify-timestamp <container> [--manifest <m>] # OFFLINE-verify an RFC-3161 timestamped attestation (genTime/serial/policy; bind manifest); no key, no network, CI-gateable exit 0/3
vh dataset prove --file <p> --manifest <m> # set-membership proof for ONE file; offline, no key, no network
vh dataset verify-proof <proof>      # fold a membership proof back to the recorded root; offline, no key, no network
vh parcel build <dir> --out <p>      # ProofParcel: tamper-evident B2B delivery receipt (root + per-file leaves + untrusted parcel meta); offline, no key, no network
vh parcel verify <dir> --manifest <p> # re-derive the root + per-file diff vs a parcel manifest; offline, no key, no network
vh parcel attest <manifest>          # canonical UNSIGNED parcel-attestation payload a human trust-root signs (P-3); offline, no key, no network
vh parcel sign <manifest> --key-env <VAR>|--key-file <p> # sign the UNSIGNED parcel attestation with a key YOU provisioned -> signed container; reads YOUR key, never generates/persists/logs one; offline, no network
vh parcel verify-attest <signed> [--manifest <m>] [--signer <addr>] # OFFLINE-verify a SIGNED parcel attestation (recover signer, pin sender, bind parcel); no key, no network, CI-gateable exit 0/3
vh parcel timestamp-request <manifest> # emit the SHA-256 digest your RFC-3161 TSA stamps (P-3 Option B); offline, no key, no network
vh parcel timestamp-wrap <manifest> --token <p> # wrap a TSA's RFC-3161 token -> verifiable timestamped container; offline, no key, no network
vh parcel verify-timestamp <container> [--manifest <m>] # OFFLINE-verify an RFC-3161 timestamped parcel attestation (genTime/serial/policy; bind parcel); no key, no network, CI-gateable exit 0/3
vh identity publish --address <0xaddr> --product-line <line> --claim <text> --non-claim <text> (--key-env <VAR>|--key-file <p>) [--out <p>] # mint a signed producer IDENTITY CARD binding a vendorAddress to a bounded claim set; signs with a key YOU provisioned (reads/never holds it); mints ONLY when the key controls --address; default PRINTS + writes NOTHING; offline, no network
vh identity verify <card> [--signer <0xaddr>] # OFFLINE/key-free: RECOVER the signer, require it to BE the card's vendorAddress, OPTIONALLY pin --signer + print the claims/non-claims; forged/tampered/wrong-vendor/wrong-signer is a clean REJECTED; exit 0 ACCEPTED / 3 REJECTED / 2 usage / 1 IO
vh revocation publish --address <0xaddr> --reason <reason> (--key-env <VAR>|--key-file <p>) [--superseded-by <0xaddr>] [--revoked-at <ISO>] [--out <p>] # mint a signed producer KEY REVOCATION marking --address REVOKED for --reason; signs with a key YOU provisioned (reads/never holds it); mints ONLY when the key controls --address (a key revokes ITSELF); default PRINTS + writes NOTHING; a SIGNED CLAIM, NOT a trusted timestamp without P-3; offline
vh revocation verify <revocation> [--signer <0xaddr>] # OFFLINE/key-free: RECOVER the signer, require it to BE the revocation's vendorAddress, OPTIONALLY pin --signer + print reason/revokedAt/supersededBy; forged/tampered/third-party is a clean REJECTED; exit 0 ACCEPTED / 3 REJECTED / 2 usage / 1 IO
vh anchor-artifact <sealed-file> --contract <a> --rpc <url> (--key-env <VAR>|--key-file <p>) [--author-bound] [--out <receipt>] # anchor ANY sealed artifact's ONE canonical digest on-chain (evidence/agent/journal/trustledger/dataset/parcel) -> portable vh-anchored-receipt@1; FREE (gas is your own); --author-bound = commit-reveal (D-1, authorBound:true)
vh verify-anchored <receipt> <sealed-file> [--rpc <url> --contract <a>] # OFFLINE by default (no key, no network): recompute the digest through the same closed table, every deviation a named reject; with --rpc+--contract also authenticate the registry + re-check the receipt's chain facts; exit 0/3, CI-gateable
```

> **Read commands authenticate the registry by default.** Every read command (`verify` / `show` /
> `list` / `lineage` / `verify-proof`) **authenticates the registry before reporting anything** — a
> wrong/rogue RPC+address could otherwise fabricate a `MATCH`/`ACCEPTED`. The preflight confirms a
> contract is deployed there (bytecode), reads its immutable `REGISTRY_ID`/version, and (for
> `verify-proof`) cross-checks the artifact's `chainId`; it prints a `registry authenticated: …` line
> (`--json`: a `registry` block). A **loud, non-default `--skip-identity-check`** opts out for a known
> local-dev contract (the output then says the verdict is only as trustworthy as the RPC you supplied).
> The `REGISTRY_ID` is a "right interface" signal verified alongside bytecode + chainId, **not a sole
> root of trust** — a fork can reuse it, so pin the address out-of-band if you need a SPECIFIC
> deployment. See [authenticated reads](#authenticated-reads-registry-identity--chainid) and
> [`docs/TRUST-BOUNDARIES.md`](docs/TRUST-BOUNDARIES.md).

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

> **The `REGISTRY_ID` is a "right interface" signal, NOT a sole root of trust.** It is verified
> alongside the deployed bytecode + chainId and proves you are talking to a contract that *implements
> the verifyhash interface on the expected chain* — it does **not** make the records honest beyond the
> contract's own first-writer-wins + commit-reveal rules, and because the constant is open source, **a
> fork can compile and return the same `REGISTRY_ID`**. So a consumer who needs a SPECIFIC deployment
> (not merely *some* contract that speaks the interface) must **also pin the address out-of-band**.
> This is exactly the caveat in [`docs/TRUST-BOUNDARIES.md`](docs/TRUST-BOUNDARIES.md) and the
> contract's "ON-CHAIN IDENTITY MARKER" NatSpec.

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

### Contribution score (`vh reputation <addr>`)

`vh reputation <addr>` reports a **verifiable contribution score** for one address: the `total`
records under it, the **authorBound vs anchor-only** breakdown, the **lineage-root vs revision**
breakdown, and the earliest/latest block + timestamp. It is **read-only, needs no key, and
authenticates the registry** (the same [authenticated-read](#authenticated-reads-registry-identity--chainid)
preflight every read command runs) before reporting anything.

```
vh reputation 0xABC… --rpc <url>            # human block, led by the trust caveat
vh reputation 0xABC… --json                  # { registry, address, total, authorBound, anchorOnly, … }
```

The score is computed from a **single ownerless on-chain read** — the paged, clamped
`getRecordsByContributor(addr, start, count)` walk (`total` = `records.length` from that walk) — so
scoring one address is **O(that address's own records), never O(total)**. The companion T-12.1 O(1)
read `contributorRecordCount(addr)` (which `vh reputation` does **not** call) returns the same `total`
without paging, for an external consumer that wants the count alone.

> **The score is a NON-TRANSFERABLE DERIVED VIEW — NOT a token.** It is re-derivable by anyone from the
> same registry, holds no value, grants no rights, and `vh reputation` takes a **provider only, never a
> key**. Any tradeable/reputation-**token** layer is a separate, **human-gated** decision (D-2 / P-1 in
> `STRATEGY.md`) and is not built here. It does **NOT** validate record content (re-derive + `vh verify`
> for that), does **NOT** upgrade a front-runnable anchor's attribution, and for anchor-only records the
> grouping address is merely the **first anchorer**. **Anti-sybil:** the meaningful signal is the
> **`authorBound` (commit-reveal) count** — producing a front-running-resistant claim has a real cost,
> whereas anchor-only records and address creation are cheap — so authorBound and anchor-only are
> reported **separately and never summed**. These are exactly the caveats in
> [`docs/TRUST-BOUNDARIES.md`](docs/TRUST-BOUNDARIES.md); the full definition is in
> [`docs/REPUTATION.md`](docs/REPUTATION.md).

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

### Dataset provenance (DataLedger)

DataLedger turns an AI training dataset into a **reproducible, tamper-evident manifest** plus the
diff/summary/proof artifacts a data-provenance reviewer (enterprise due-diligence, EU AI Act technical
documentation) consumes. Every command below is **offline, needs NO key, and needs NO network** — a
manifest, diff, summary, or single-file proof can be handed to a third party and re-derived on an
air-gapped machine with only the `vh` CLI, trusting no server.

```
vh dataset build <dir> --out <p>          # tamper-evident manifest: Merkle root over every (relPath, content) pair + per-file leaves
vh dataset verify <dir> --manifest <p>    # re-derive the root from a fresh copy on disk + per-file ADDED/REMOVED/CHANGED diff
vh dataset diff <manifestA> <manifestB>   # the precise add/remove/change set between two dataset versions (offline, no tree)
vh dataset summary <manifest>             # provenance/license roll-up over the trusted file set (counts CLAIMS, not facts)
vh dataset check <manifest> --policy <p> [--json]  # OFFLINE license/source policy gate: PASS/FAIL + violating files; CI-gateable exit code (0 PASS / 3 FAIL); no key, no network
vh dataset report <manifest> [--verify <dir>] [--policy <p>] [--json] [--out <p>]  # ONE deterministic evidence document the reviewer files; offline, no key, no network
vh dataset attest <manifest> [--json] [--out <p>]  # canonical UNSIGNED attestation payload (root+fileCount+manifestDigest) a human trust-root signs; offline, no key, no network
vh dataset sign <manifest> --key-env <VAR>|--key-file <p> [--out <p>] [--json]  # sign the UNSIGNED attestation with a key YOU provisioned -> the signed container verify-attest accepts; reads YOUR key (never generates/persists/logs one); offline, no network
vh dataset verify-attest <signed> [--manifest <m>] [--signer <addr>] [--json]  # OFFLINE-verify a SIGNED attestation container: recover the signer, pin the publisher, bind YOUR manifest; offline, no key, no network, CI-gateable exit code (0 ACCEPTED / 3 REJECTED)
vh dataset timestamp-request <manifest> [--out <p>] [--json]  # emit the SHA-256 digest your RFC-3161 TSA stamps (P-3 Option B); offline, no key, no network
vh dataset timestamp-wrap <manifest> --token <p> [--out <p>] [--json]  # wrap a TSA's RFC-3161 token -> a verifiable verifyhash.dataset-attestation-timestamped container; offline, no key, no network
vh dataset verify-timestamp <container> [--manifest <m>] [--json]  # OFFLINE-verify a timestamped attestation: re-derive the digest, confirm the RFC-3161 token binds it, bind YOUR manifest; ACCEPTED (genTime/serial/policy) or REJECTED; offline, no key, no network, CI-gateable exit code (0 ACCEPTED / 3 REJECTED)
vh dataset prove --file <p> --manifest <m> --out <a>  # portable set-membership proof for ONE file
vh dataset verify-proof <proof>           # fold a membership proof back to the recorded root (no dataset, no manifest, no key, no net)
```

`vh dataset check` GATES a manifest against a written license/source policy (allow/deny lists +
`requireLicense`) and emits PASS/FAIL plus the exact violating files — **offline, no key, no network, with
a CI-gateable exit code** (0 PASS / 3 FAIL) a pipeline job blocks a build on. `vh dataset report`
consolidates dataset identity + the provenance/license roll-up + the trust caveats (and, with
`--verify <dir>`, a live-tree MATCH/MISMATCH verdict; with `--policy <p>`, the SAME policy verdict
embedded as a "Policy compliance" section) into ONE deterministic document a reviewer files; `vh dataset
attest` emits the canonical, byte-deterministic **UNSIGNED** payload a human signing/timestamp trust-root
signs over (`needs-human`, P-3 in [`STRATEGY.md`](STRATEGY.md)); `vh dataset verify-attest` is the
**offline, no key, no network, CI-gateable exit code** (0 ACCEPTED / 3 REJECTED) VERIFIER a buyer runs on a
SIGNED attestation container — it recovers the signer, optionally pins the expected publisher (`--signer`)
and binds the signature to the buyer's own dataset (`--manifest`). All are **offline, need NO key, and need
NO network**. A PASS attests only that the dataset's UNTRUSTED, self-asserted hints satisfy the policy —
NOT that the licenses are genuinely correct.

This build ships the signed-attestation **FORMAT, the offline VERIFIER, AND the `vh dataset sign` command**
(all proved with throwaway test keys). `vh dataset sign` reads a key YOU provisioned OUTSIDE the loop
(`--key-env`/`--key-file`), signs the canonical `vh dataset attest` bytes, and writes the container
`verify-attest` accepts — it **never generates, persists, or logs a key** and touches no network. So the
human's remaining P-3 step (`needs-human`, [`STRATEGY.md`](STRATEGY.md)) collapses to: **PROVISION a real
key, choose the trust-root option, and run `vh dataset sign --key-env <VAR>`**. A verified signature proves
the key-holder vouched for the dataset identity, NOT a "unaltered since date T" timestamp (still P-3).

The Merkle root commits to file **names AND bytes** (the SAME path-bound convention as `vh hash <dir>`),
so any edit/rename/add/remove changes it. What DataLedger does **NOT** prove: it is **not a timestamp**
— "unaltered since date T" needs the human-owned signing/timestamp trust-root, a `needs-human` step in
[`STRATEGY.md`](STRATEGY.md) — and the per-file `{source, license}` **hints are UNTRUSTED self-asserted
metadata** that are NOT bound into the root (the summary counts what the dataset CLAIMS). Do not
overclaim. Full buyer-facing spec, worked example, and the auditor / EU-AI-Act evidence mapping:
[`docs/DATALEDGER.md`](docs/DATALEDGER.md).

### Data-delivery receipts (ProofParcel)

ProofParcel is a **second income product on the SAME provenance core**, aimed at a different paying
buyer: B2B data exchange where a delivery dispute ("you never sent file X" / "the file you sent was
altered") is expensive. It issues a portable, independently-verifiable **proof-of-delivery receipt** that
pins exactly which files (names AND bytes) were delivered for a parcel, plus a signable attestation over
that parcel's identity. Every command is **offline, needs NO key, and needs NO network**.

```
vh parcel build <dir> --out <p>           # tamper-evident delivery receipt: Merkle root + per-file leaves + optional UNTRUSTED parcel meta
vh parcel verify <dir> --manifest <p>     # re-derive the root from a fresh copy on disk + per-file ADDED/REMOVED/CHANGED diff; exit 0 MATCH / 3 MISMATCH
vh parcel attest <manifest> [--json] [--out <p>]  # canonical UNSIGNED parcel-attestation payload (root+fileCount+manifestDigest) a human trust-root signs; offline, no key, no network
vh parcel sign <manifest> --key-env <VAR>|--key-file <p> [--out <p>] [--json]  # sign the UNSIGNED parcel attestation with a key YOU provisioned -> the signed container verify-attest accepts; reads YOUR key (never generates/persists/logs one); offline, no network
vh parcel verify-attest <signed> [--manifest <m>] [--signer <addr>] [--json]  # OFFLINE-verify a SIGNED parcel attestation: recover the signer, pin the sender, bind YOUR parcel; offline, no key, no network, CI-gateable exit code (0 ACCEPTED / 3 REJECTED)
vh parcel timestamp-request <manifest> [--out <p>] [--json]  # emit the SHA-256 digest your RFC-3161 TSA stamps (P-3 Option B); offline, no key, no network
vh parcel timestamp-wrap <manifest> --token <p> [--out <p>] [--json]  # wrap a TSA's RFC-3161 token -> a verifiable verifyhash.parcel-attestation-timestamped container; offline, no key, no network
vh parcel verify-timestamp <container> [--manifest <m>] [--json]  # OFFLINE-verify a timestamped parcel attestation: re-derive the digest, confirm the RFC-3161 token binds it, bind YOUR parcel; ACCEPTED (genTime/serial/policy) or REJECTED; offline, no key, no network, CI-gateable exit code (0 ACCEPTED / 3 REJECTED)
```

`vh parcel attest` emits the canonical, byte-deterministic **UNSIGNED** payload a sender signs over —
over the SAME signed-attestation core as `vh dataset attest`, with `signed:false`. `vh parcel
verify-attest` is the **offline, no key, no network, CI-gateable exit code** (0 ACCEPTED / 3 REJECTED)
VERIFIER a recipient runs on a SIGNED container: it recovers the signer, optionally pins the expected
sender (`--signer`) and binds the signature to the recipient's own parcel (`--manifest`). The signed
container uses ProofParcel's own `verifyhash.parcel-attestation-signed` kind, so a dataset
signed-container does **not** cross-verify as a parcel one.

ProofParcel inherits the **SAME honest trust posture as DataLedger**: the receipt binds the file SET and
is signable, but is **NOT by itself a trusted delivery TIMESTAMP** — "delivered ON date T" rides the
human-owned signing/timestamp trust-root (`needs-human`, P-3 in [`STRATEGY.md`](STRATEGY.md)); a valid
signature proves the key-holder vouched for the parcel identity, NOT a "unaltered since date T"
timestamp. The `parcel` metadata (parcelId/sender/recipient) is **UNTRUSTED self-asserted metadata** that
is NOT bound into the root. This build ships the **FORMAT, the offline VERIFIER, AND the `vh parcel sign`
command** (proved with throwaway test keys); `vh parcel sign` reads a key the sender PROVISIONED outside the
loop (never generates/persists/logs one), so the human's P-3 step collapses to "provision a key, run
`vh parcel sign --key-env <VAR>`." Full buyer-facing spec, command table, and worked example:
[`docs/PROOFPARCEL.md`](docs/PROOFPARCEL.md).

### Evidence packets (`vh evidence`)

A **product-agnostic, license-gated, tamper-evident evidence packet** for any directory of files — the
**second vertical** built on the SAME provenance core, with its OWN sellable license. `vh evidence seal`
binds a whole folder into one content-addressed `*.vhevidence.json`; `vh evidence verify` re-derives the
root from the bytes you hold and localizes any tamper to the exact file. Both are **offline, no network**.

```
vh evidence seal <dir> [--out <p>] [--license <f> --vendor <0xaddr>] [--sign --key-env <VAR>|--key-file <p>] [--json]  # build the packet over cli/core/packetseal.js (generic kind, NO trust-reconcile vocabulary); default PRINTS the seal + writes NOTHING; exit 0 ok / 3 seal-build-error / 2 usage / 1 IO
vh evidence verify <p> [--dir <d>] [--json]  # read-only, NO key: RE-DERIVE the root from the bytes referenced + report OK / which file CHANGED/MISSING/UNEXPECTED; exit 0 OK / 3 REJECTED / 2 usage / 1 IO
```

The seal proves **TAMPER-EVIDENCE + OFFLINE-RECOMPUTE, NOT a trusted timestamp** ("sealed at T" rides the
human trust-root, P-3); the packet is an **UNTRUSTED transport container** verify never trusts. The **FREE**
tier — an unsigned baseline seal of up to **25 files** + verify — stays open so a buyer can try before
buying. The **PAID** surface (the `--sign` signed-attestation wrap; sealing **> 25 files**) is gated behind
a valid `--license <f> --vendor <0xaddr>` verified OFFLINE via `cli/core/license.js` against a **distinct
evidence-product entitlement table** (`kind: vh-evidence-license`, **not** `trustledger-license`), reusing
the SAME `verifyLicense` / named-reject posture as the TrustLedger CLI (a wrong/expired/under-entitled
license is a hard refuse, never a silent downgrade). Full schema, free-vs-paid surface, a worked
seal → hand over → verify example, and the core-reuse map: [`docs/EVIDENCE.md`](docs/EVIDENCE.md). The
vendor keypair, price, and first design partner are human steps (STRATEGY.md › **P-7**).

### Agent-session evidence (`vh agent`) — AgentTrace

**Tamper-evident, selectively-REDACTABLE, independently-verifiable AI-agent session records** — the
agent-evidence vertical for the record-keeping / audit / incident-forensics buyer. `vh agent seal` turns
an ordered session event log (prompts, completions, tool calls/results, notes) into ONE
`*.vhagent.json` packet under an RFC-6962-style ordered Merkle head with **redaction-safe** leaves:
withhold any payload behind its hash commitment and the packet **still verifies with the identical
head**; disclose + check any ONE event offline; prove a later packet extends a mid-session checkpoint
**append-only** (a rewritten past is a REJECT naming the seq). All **offline, no network**.

```
vh agent seal <session.jsonl> [--out <p>] [--sign --license <f> --vendor <0xaddr> ...] [--json]   # free unsigned; --sign is the PAID surface
vh agent verify <packet> [--vendor <0xaddr>] [--json]   # re-derive every leaf + the root; exit 0 ACCEPTED / 3 named REJECT (+ seq)
vh agent redact <packet> --seq <list> --out <p>          # withhold payloads; head UNCHANGED — redaction is not tamper
vh agent prove / verify-proof / checkpoint / verify-growth   # single-event disclosure + append-only growth, offline
```

The honest boundary, carried **in-band** in every packet's trust note: it proves the LOG is unaltered
since seal, any disclosed event verbatim as recorded, append-only growth across checkpoints, and that
redaction can only withhold — **NOT** that the log faithfully records what the agent actually did
(garbage-in is out of scope), `ts` fields are self-asserted, and it is **NOT** a trusted timestamp
without the human-owned trust-root (P-3). Verify/redact/prove are FREE; `--sign` (a detached head
attestation one signature of which stays valid across every redacted copy) is license-gated via the
DRAFT `agent_signed` capability — the same fail-closed mechanism as `vh evidence`. A counterparty
verifies with the independent `verify-vh` (CLI, zero-install bundle, or the offline browser page —
[`verifier/README.md`](verifier/README.md) §2c). Buyer-facing spec:
[`docs/AGENTTRACE.md`](docs/AGENTTRACE.md); a committed third-party-transcript example proving adoption
is a ~20-line mapping: [`examples/agent-session/`](examples/agent-session/).

**Commit-bound sessions** — `vh agent commit-claim` emits ONE ordinary claim event binding the session
to exactly one git commit (the oid + the `vh hash --git` tracked-set root), sealed under the same head;
`vh agent verify-commit <packet> --repo <dir>` is the auditor leg: full packet verification FIRST, then
BOTH facts re-derived from the auditor's OWN clone, with every REJECT named (`packet-invalid` /
`no-disclosed-claim` / `oid-mismatch` / `root-mismatch`). Both FREE, read-only, key-less; redact every
other payload and the claim stays checkable. **Containment, NOT causation** — it does NOT prove the
session's events produced the commit. Spec + honest boundary: [`docs/AGENTTRACE.md`](docs/AGENTTRACE.md)
› *Binding a session to a git commit*; the scripted flow (map → commit-claim → seal →
redact-all-but-claim → verify-commit):
[`examples/agent-session/commit-bound-session.js`](examples/agent-session/commit-bound-session.js).

### Producer identity card (`vh identity`)

A **signed, offline-verifiable "who is this vendor, and what exactly do they attest?"** card — the
recipient's / **cold prospect's** pin-point. Every other artifact pins its producer by a vendor **address**
the recipient must learn out of band; the identity card is the **one** artifact whose job is to answer,
verifiably, "**does this 0x-address really belong to THIS vendor, and what do they attest / NOT?**" The
vendor SIGNS — with the **same key** that signs their evidence/licenses — a card binding their
`vendorAddress` to a bounded `claims[]` set + an honest `nonClaims[]` set.

```
vh identity publish --address <0xaddr> --product-line <line> --claim <text> --non-claim <text> (--key-env <VAR>|--key-file <p>) [--out <p>] [--json]  # mint the card; signs with a key YOU provisioned, mints ONLY when the key controls --address; default PRINTS + writes NOTHING; offline
vh identity verify <card> [--signer <0xaddr>] [--json]  # OFFLINE/key-free: recover the signer, require it to BE the card's vendorAddress, optionally pin --signer; exit 0 ACCEPTED / 3 REJECTED / 2 usage / 1 IO
```

**Pin once, trust across handoffs.** The recipient does the address-to-vendor trust step **ONCE**
(`vh identity verify vendor.vhidentity.json --signer <addr-you-were-given>` → ACCEPTED), then reuses that
pinned `vendorAddress` across every later signed handoff (`vh evidence verify-signed <p> --signer <addr>`,
etc.) — no new out-of-band step. A **forged / tampered / wrong-vendor card, or a wrong `--signer`, is a
clean REJECTED — never a silent pass**. The card proves **IDENTITY + the claim SET only**: **NOT** any
specific packet's truth (each packet carries its own proof), **NOT** a trusted timestamp (P-3), and
**NOT** a legal opinion. Full flow + the pin-once-trust-across-handoffs model:
[`docs/IDENTITY.md`](docs/IDENTITY.md). Publishing the card uses the same vendor key provisioned for signed
evidence/licenses (STRATEGY.md › **P-7 step 1** / **P-6 step 1**).

### Revoking a key (`vh revocation`)

A key has a lifecycle: it is generated, **published** (the identity card), pinned, used to sign — and
eventually **rotated, retired, or compromised**. `vh revocation` is how a vendor honestly **retires** that
pinned key: they SIGN — with the **same key** — a self-describing revocation marking their own
`vendorAddress` revoked as of a date for a bounded reason (and optionally a `supersededBy` successor).

```
vh revocation publish --address <0xaddr> --reason <reason> (--key-env <VAR>|--key-file <p>) [--superseded-by <0xaddr>] [--revoked-at <ISO>] [--out <p>] [--json]  # mint the revocation; signs with a key YOU provisioned, mints ONLY when the key controls --address (a key revokes ITSELF); default PRINTS + writes NOTHING; offline
vh revocation verify <revocation> [--signer <0xaddr>] [--json]  # OFFLINE/key-free: recover the signer, require it to BE the revocation's vendorAddress, optionally pin --signer; exit 0 ACCEPTED / 3 REJECTED / 2 usage / 1 IO
```

**A key revokes ITSELF.** `verify` recovers the signer and REQUIRES it to equal the revocation's own
`vendorAddress` — a **third party cannot revoke a key it does not control**, so a planted "revocation" can
never grief a vendor (it is a clean **REJECTED**, never a silent pass). Recipients pin the revocation next to
the identity card and pass it to any signed-verify command via **`--revocations <f>`** `[--as-of <ISO>]`: an
exhibit signed under a key that was **revoked-before-as-of** downgrades from ACCEPTED to **REVOKED**, while an
exhibit signed while the key was still good keeps its ACCEPTED verdict. It is **strictly optional and
non-loosening** (with no `--revocations`, every verify command is byte-for-byte what it is today). The
boundary: a revocation is a **signed CLAIM** by the key-holder (`revokedAt` is self-asserted), **NOT a
trusted timestamp** without P-3, and **NOT a legal opinion**. Full publish → pin → verify lifecycle:
[`docs/KEY-LIFECYCLE.md`](docs/KEY-LIFECYCLE.md).

### The 60-second cold-prospect challenge (zero-install, zero-trust)

The fastest way for someone who owes us **nothing** — no account, no `npm install`, no repo build, no
key, no network — to believe a verifyhash seal is to *test* it on their own machine in under a minute.
[`challenge/`](challenge/) is that entry point: a real pre-sealed sample packet + its seal + a one-command
`run.sh`. They VERIFY it (exit 0), TAMPER one byte, and watch the committed standalone verifier REJECT it
(exit 3) and **name the file they changed** — trusting no server, no producer software, and not us. The
challenge is the **FREE, UNSIGNED** verify end and points free-verify → free-produce → **paid-produce**
(signing + unlimited sealing). The boundary is the same one stated everywhere: the seal proves
tamper-evidence + signer-pin, **NOT** a trusted "sealed at T" (that still requires P-3), and the unsigned
sample has no signer to pin. Walkthrough: [`challenge/README.md`](challenge/README.md).

### The independent verifier (`verify-vh`) — a buyer deliverable

A counterparty who is **not** a customer can check any sealed artifact themselves, **offline and for
free**, without our `ethers`/`hardhat` stack: the standalone [`verifier/`](verifier/) tree
(`verify-vh`) re-derives the keccak Merkle root from the bytes they hold, recovers the EIP-191
secp256k1 signer, and pins it to a `--vendor` address they supply out-of-band — near-zero dependencies
(`js-sha3` only), no network, read-only. Its independence is **mechanically proven**, not just
promised: [`test/verifier.isolation.test.js`](test/verifier.isolation.test.js) statically greps every
`require(` in the tree (never `ethers`/`hardhat`/`@nomicfoundation/*`/`cli/`/`trustledger/`) and runs a
real verify under a poisoned network to assert **no socket is opened**. The trust boundary is honest:
tamper-evidence + offline-recompute + signer-pin, **NOT** a trusted "sealed at T" (that rides the
human trust-root, P-3) and **NOT** a legal opinion. Counterparty quickstart + worked
`seal → hand over → verify-vh` example: [`verifier/README.md`](verifier/README.md); full spec:
[`docs/INDEPENDENT-VERIFICATION.md`](docs/INDEPENDENT-VERIFICATION.md).

### Run the design-partner pilot in one command (offline, no key, no network)

The single artifact you hand a prospective design partner is the **pilot kit**. It drives **both**
sellable buyer journeys — the **evidence packet** and the **TrustLedger reconciliation seal** — end to
end against committed sample data, **offline, with no real key, no TSA, no RPC, no network**, and
prints **one combined PASS/FAIL verdict**:

```bash
node pilot/run-pilot.js
```

It issues an ephemeral-key licence, proves the paid surface is **really** licence-gated (refused with
no licence and with the wrong vendor), hands the artifact to the **independent** `verify-vh` (ACCEPT),
then **tampers** to prove REJECT — writing only to a throwaway workspace, never the repo. The trust
boundary is honest: tamper-evidence + signer-pin, **NOT** a trusted "sealed at T" (that rides the
human-owned trust-root, P-3). The buyer-facing runbook — what each artifact proves, where a partner
independently verifies it, and the consolidated go-to-market ask (**P-8**) — is
[`docs/PILOT.md`](docs/PILOT.md); the operator quick reference is [`pilot/README.md`](pilot/README.md).
The journey and the runbook are both test-gated, so they can never silently rot.

### Embed it: the programmatic API (SDK)

Everything the CLI does is available as a library. `require("verifyhash")` (or `require("../index.js")`
from a checkout) exposes a single, documented, semver-guarded entrypoint — a **thin re-export** of the
exact same functions `vh` runs (no fork, no second implementation, no new crypto). The embedded seal
path is byte-identical to `vh evidence seal` / `vh evidence verify`: build a seal, verify it (ACCEPT),
and a one-byte tamper is REJECTED.

```js
const vh = require("verifyhash"); // from a checkout: require("./index.js")

// Build a tamper-evident seal over an in-memory { relPath, bytes } file set.
const entries = [
  { relPath: "data/a.txt", bytes: Buffer.from("alpha\n") },
  { relPath: "data/b.txt", bytes: Buffer.from("bravo\n") },
];
const seal = vh.buildSeal(entries);

// Verify the SAME bytes: ACCEPTED (root re-derived from the bytes you hold, not the seal's own hashes).
console.log(vh.verifySeal(seal, entries).verdict); // "ACCEPTED"

// Tamper one byte and re-verify: REJECTED.
const tampered = [entries[0], { relPath: "data/b.txt", bytes: Buffer.from("bravX\n") }];
console.log(vh.verifySeal(seal, tampered).verdict); // "REJECTED"

// Serialize to canonical, byte-deterministic JSON you can hand to a counterparty:
const json = vh.serializeSeal(seal);
console.log(vh.readSeal(json).root === seal.root); // true
```

The surface also re-exports the **signed / vendor-pinned verify path** (the `signed` namespace:
`signSealWith`, `validateSignedSeal`, `verifySignedSeal`, `verifySignedSealAttestation`, `recoverSigner`,
`verifySignedAttestation`) — the embedded twin of `vh evidence verify-signed`. So an embedder can verify a
**signed, address-pinned** seal in-process (ACCEPT under the matching `--signer`; REJECT under a wrong
expected signer or a one-byte-tampered container) with **no shell-out** to the `vh` binary. A valid
signature proves *who* vouched, not *when* (a trusted timestamp still rides the human-owned trust-root,
STRATEGY.md P-3). It also re-exports the receipt codec (`buildReceipt`, `readReceipt`, `diffManifest`, …),
the keccak/Merkle hashing primitives (`hashBytes`, `hashEntries`, `buildTree`, …), and `apiVersion` (the
semver-guarded stability marker, mirroring `package.json`). Symbols **not** re-exported from the
package root (deep `cli/…` internals) carry no stability guarantee. This example is test-gated
([`test/sdk.index.test.js`](test/sdk.index.test.js)); the signed path is gated by
[`test/sdk.signed.test.js`](test/sdk.signed.test.js), so it can never silently rot.

### Verify continuously over time (`vh journal`)

Every verify above answers *"do these bytes match RIGHT NOW?"* and exits. The **integrity journal** proves an
artifact has verified **continuously across runs**: an **append-only, hash-chained** log of verify verdicts
that is **itself tamper-evident** — a deleted / edited / reordered / inserted past entry **breaks the chain**
and `vh journal verify` **localizes the first break**.

```bash
vh journal append <artifact> --to <journalfile> [--dir <d>] [--ts <ISO>]  # record ONE verdict (strictly additive)
vh journal verify <journalfile>   # exit 0 PASS (unbroken + every observation ACCEPTED) / 3 broken-or-drifted / 2 usage / 1 IO
```

Each CI run appends this build's verdict, then verifies the whole chain — a green pipeline MEANS "the artifact
has verified continuously across every recorded run, and the record itself is tamper-evident." It reuses the
**same** keccak hash-chain the project already trusts for seals (no new crypto). The `ts` on each entry is
**self-asserted** (the verifier's own wall clock), **NOT a trusted timestamp** — the journal never claims
*"unaltered since date T"* on its own; that claim rides the human-owned trust-root (STRATEGY.md **P-3**).
Schema, chain guarantee, the 0/3 contract, and the honesty boundary:
[`docs/INTEGRITY-JOURNAL.md`](docs/INTEGRITY-JOURNAL.md); drop-in CI recipes in
[`examples/journal-ci.js`](examples/journal-ci.js) and
[`verifier/ci/journal.generic.sh`](verifier/ci/journal.generic.sh).

The journal also carries **transparency-log proofs** (RFC-6962 / Certificate-Transparency lineage):
`vh journal tree-head` publishes a single `{ size, root }` head committing to the whole ordered log,
`prove-inclusion` / `prove-consistency` emit compact self-contained proof artifacts, and
`vh journal check-proof` lets a third-party auditor verify them **offline** — no journal, no key, no
network (though today via the **producer package**, which installs ethers — **not** the standalone,
zero-dependency `verifier/` bundle a seal enjoys). The head is **self-asserted** until a P-3 trust-root
signs it. See
[`docs/INTEGRITY-JOURNAL.md`](docs/INTEGRITY-JOURNAL.md) § "Transparency-log proofs (publish a tree head;
auditors verify offline)".

## Develop

```
npm install
npx hardhat compile
npx hardhat test
```

Local hardhat / in-memory EVM only. Deployment to any real network is a human checkpoint
(see `BACKLOG.md`, EPIC-4); never run automatically.

## Docs

- [`docs/DECIDE.md`](docs/DECIDE.md) — **the one human decision, on one screen.** The single recommended
  pilot (EVIDENCE / P-7), the 3 verbatim first actions, the exact `node pilot/run-pilot.js --certificate
  <path>` command, the time box / stop criterion, and the revenue-integrity boundary. Read this first; it
  adds no new ask beyond P-8.
- [`docs/DATALEDGER.md`](docs/DATALEDGER.md) — the buyer-facing DataLedger product spec: what a dataset
  manifest PROVES (file names + bytes, offline set-membership, version diff, license roll-up) and does
  NOT (not a timestamp; untrusted source/license hints), the build→diff→summary→prove→verify-proof
  workflow with a worked example, and the auditor / EU-AI-Act evidence mapping.
- [`docs/PROOFPARCEL.md`](docs/PROOFPARCEL.md) — the buyer-facing ProofParcel product spec (B2B
  proof-of-delivery): the command table (build/verify/attest/verify-attest with the offline, no key, no
  network, CI-gateable exit 0/3 property), a worked sender → [signs, P-3] → recipient verify-attests
  example, and the SAME honest trust posture as DataLedger (binds the file SET, signable, NOT a delivery
  timestamp; parcel metadata is untrusted self-asserted).
- [`docs/EVIDENCE.md`](docs/EVIDENCE.md) — the buyer-facing Evidence-packet product spec (the second
  vertical, with its OWN license): the `*.vhevidence.json` schema (every field UNTRUSTED transport —
  verification re-derives), the free-vs-paid surface (free unsigned baseline of up to 25 files + verify;
  paid `--sign` wrap and over-sample sealing gated by `vh-evidence-license` entitlements), a worked
  seal → hand over → verify example, and how it reuses the shared packetseal/license/attestation cores.
- [`docs/AGENTTRACE.md`](docs/AGENTTRACE.md) — the buyer-facing AgentTrace product spec (`vh agent`,
  `*.vhagent.json`): what a packet PROVES (log unaltered since seal; disclosed events verbatim;
  append-only growth across checkpoints; redaction withholds — never silently alters) and does NOT
  (garbage-in out of scope; `ts` self-asserted; not a trusted timestamp without P-3), the free-vs-paid
  line (`--sign` gated by the DRAFT `agent_signed` capability), where a counterparty independently
  verifies, the commit-binding leg (`commit-claim` / `verify-commit` — containment, not causation),
  and the committed [`examples/agent-session/`](examples/agent-session/) worked example
  (a third-party OpenAI-style transcript mapped in ~20 lines, then map → seal → redact → verify → prove).
- [`docs/ANCHORING.md`](docs/ANCHORING.md) — anchoring ANY sealed artifact on-chain (`vh anchor-artifact` /
  `vh verify-anchored`): the closed six-kind digest table, the `vh-anchored-receipt@1` container, what an
  anchored receipt PROVES (an on-chain registry record binds this exact digest at a block whose timestamp
  BOUNDS existence — as trustworthy as the chain + YOUR pinned contract address; `--author-bound` =
  front-run-resistant first-claimant attribution per D-1) and does NOT (a receipt from a LOCAL dev chain
  proves MECHANISM only — worth nothing publicly until a human deploys per STRATEGY.md P-2; not the
  artifact's truth; not attribution beyond the anchoring key; not legal advice), the free line (both verbs
  FREE; gas is your own), and the worked local flow with committed offline fixtures
  ([`examples/anchoring/`](examples/anchoring/)).
- [`docs/KEY-LIFECYCLE.md`](docs/KEY-LIFECYCLE.md) — the producer-key lifecycle: publish → pin → verify, and
  how a vendor honestly RETIRES a pinned key with a signed `vh revocation publish|verify` (a key revokes
  ITSELF; a third party cannot revoke a key it does not control). The recipient `--revocations <f>`
  `[--as-of <ISO>]` downgrade rule (revoked-before-as-of → REVOKED; strictly optional + non-loosening), and
  the verbatim boundary — a revocation is a SIGNED CLAIM, NOT a trusted wall-clock timestamp without P-3.
- [`docs/INDEPENDENT-VERIFICATION.md`](docs/INDEPENDENT-VERIFICATION.md) — the counterparty-facing spec
  for the standalone `verify-vh` verifier: the exact bytes verified (keccak content hash → Merkle root →
  EIP-191 personal-sign signature), the FREE/no-network/no-back-edge posture, the trust boundary
  (tamper-evidence + offline-recompute + signer-pin, NOT a trusted "sealed at T"), a worked
  producer-seals → counterparty-runs-`verify-vh` example, and how isolation is proven mechanically.
- [`docs/TRUST-BOUNDARIES.md`](docs/TRUST-BOUNDARIES.md) — what each record field proves and does not,
  plus "Authenticating the registry you read from" (why read commands authenticate the registry before
  believing it, and why the `REGISTRY_ID` is a "right interface" signal, not a sole root of trust).
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
- [`docs/REPUTATION.md`](docs/REPUTATION.md) — the contribution score: its exact definition (the single
  `getRecordsByContributor` walk it aggregates, with `contributorRecordCount` the companion O(1) count,
  the authorBound/anchor-only
  and root/revision breakdowns, the block/time bounds), why it is a non-transferable derived view (NOT a
  token — any tradeable layer is D-2/P-1, human-only), what it does NOT prove, and the anti-sybil note
  (the meaningful signal is the authorBound count).
- [`docs/TRUSTLEDGER.md`](docs/TRUSTLEDGER.md) — the buyer-facing TrustLedger product spec (automated
  three-way trust-account reconciliation for small residential property managers): the three balances
  that must legally agree, the PASS/FAIL exit contract, the per-state policy + period-close-continuity
  layers, the tamper-evident packet seal, and the **web front-door** (`vh trust serve`) — including the
  **in-browser inspect/map onboarding flow** (drop a file → if it won't load, see its columns and map
  them from a dropdown → reconcile), so a non-technical broker never needs a terminal. It also covers
  the **Entitlements & licensing** model: the signed, offline-verifiable `*.vhlicense.json`, the
  free-vs-paid surface, the closed entitlement table, and how a customer verifies a license offline
  against the pinned vendor address (CLI **and** web honour the same gate). Hosting, the CPA review, the
  per-state policy table, license issuance, and pricing all stay human steps (STRATEGY.md › P-5/P-6).
- [`docs/PILOT.md`](docs/PILOT.md) — the buyer-facing pilot runbook: how a non-author runs
  [`pilot/run-pilot.js`](pilot/run-pilot.js), what each artifact (evidence packet, reconciliation seal,
  licence) PROVES and where a partner independently verifies it with `verify-vh`, the honest trust
  boundary (tamper-evidence + signer-pin, **no trusted "sealed at T" without P-3**), and the
  consolidated go-to-market ask (**P-8**). Operator quick reference: [`pilot/README.md`](pilot/README.md).
- [`docs/AUDIT.md`](docs/AUDIT.md) — security audit findings and the fix tasks they spawned.


---
<sub>© 2026 verifyhash.com · Licensed under Apache-2.0 (SPDX-License-Identifier: Apache-2.0) — see the [LICENSE](https://verifyhash.com/LICENSE) and [NOTICE](https://verifyhash.com/NOTICE) served with this file.</sub>

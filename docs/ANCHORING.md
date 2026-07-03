# Anchoring sealed artifacts on-chain — `vh anchor-artifact` / `vh verify-anchored`

Every verifyhash product ends in a **sealed artifact** whose integrity folds up into ONE 32-byte
digest. Anchoring writes that digest into the **ContributionRegistry** — the project's immutable,
permissionless, append-only contract — so an on-chain record binds the artifact at a block whose
timestamp **bounds its existence**. This is Option **(C)** of the STRATEGY.md **P-3** trust-root
menu: no timestamp authority, no signing-key custody — the chain itself is the witness.

The bridge is deliberately thin: the pure core (`cli/core/anchor-binding.js`) knows how to extract
the one canonical digest from each sealed artifact kind — re-validating it through the artifact's
**own shipped validator first** — and how to verify, **offline**, that an anchored receipt binds
exactly the artifact bytes in hand. The CLI (`cli/anchor-artifact.js`) adds the chain legs.

## The closed kind table (what can be anchored)

| artifact | kind string | anchored digest |
|---|---|---|
| Evidence packet (`vh evidence seal`) | `vh.evidence-seal` | the seal's Merkle `root` |
| Agent-session packet (`vh agent seal`) | `vh.agent-session-packet` | the **verified** head root |
| Journal tree head (`vh journal tree-head`) | `vh.journal-tree-head` | the head `root` (size bound into the derivation rule) |
| TrustLedger sealfile | `trustledger.reconcile-seal` | the seal's `root` |
| Dataset attestation (`vh dataset attest`) | `verifyhash.dataset-attestation` | `0x` + sha256 of the canonical bytes — the **same** digest `vh dataset timestamp-request` emits |
| Parcel attestation (`vh parcel attest`) | `verifyhash.parcel-attestation` | `0x` + sha256 of the canonical bytes — the **same** digest `vh parcel timestamp-request` emits |

The table is **closed**: an unknown or invalid artifact is a **named reject**, never a guess. One
artifact, one digest — the attestation legs reuse the exact digest your RFC-3161 TSA flow already
stamps, so Options (B) and (C) anchor the **same** identity.

## The command surface

```
vh anchor-artifact <sealed-file> --contract <addr> --rpc <url> (--key-env <VAR> | --key-file <p>)
                   [--author-bound] [--uri <s>] [--out <receipt>] [--json] [--i-understand-mainnet]
vh verify-anchored <receipt> <sealed-file> [--rpc <url> --contract <addr>] [--json]
```

`anchor-artifact` extracts the digest, submits it as the registry `contentHash`, waits for the tx,
reads the record **back from the chain** (contributor / authorBound / blockNumber / block
timestamp), and emits the canonical, sorted-key **`vh-anchored-receipt@1`** container — digest +
derivation rule + chain facts + the trust note below, verbatim. The signing key comes **only** from
`--key-env <VAR>` / `--key-file <p>` (read, used, discarded — never generated, persisted, or
logged), and a chainId outside the known local/testnet set refuses without `--i-understand-mainnet`.
Exit contract: `0` anchored / `3` named reject (an invalid artifact, or the registry's own revert
such as `AlreadyAnchored`) / `2` usage / `1` IO-network-key.

`verify-anchored` is **OFFLINE by default** — no key, no network (but it runs through the producer
`cli/` stack, which loads `ethers`; "OFFLINE" here means **no key and no network**, NOT "no producer
stack" — the standalone `verifier/` tree does not yet verify anchored receipts, see **Independent
verification** below): it validates the receipt strictly and **recomputes** the artifact's digest
through the same closed table; any deviation is a specific named reject (`digest-mismatch` /
`kind-mismatch` / `how-mismatch` / `bad-receipt` / the artifact's own named reject). With **both** `--rpc` and `--contract` it additionally authenticates the registry
(the standing identity probe — no record is believed until the contract self-identifies) and
re-checks every chain fact the receipt claims. Exit `0` ACCEPTED / `3` REJECTED / `2` / `1` — the
shared CI-gateable verify contract.

## What an anchored receipt PROVES

- **The binding.** An on-chain registry record binds **this exact artifact digest**: `verify-anchored`
  re-derives the digest from the artifact bytes you hold (through the artifact's own validator) and
  matches it against the receipt and — with `--rpc` — against the chain record itself.
- **Existence by block time.** The record's block timestamp **BOUNDS existence**: the digest existed
  by that block — as trustworthy as the chain + YOUR pinned contract address.
- **Attribution, exactly as strong as D-1.** With `--author-bound` the record reads back `authorBound:true` — front-run-resistant, first-claimant attribution per D-1 (commit-reveal: the commitment binds digest + committer + a secret salt, so a mempool copier cannot redirect the claim to themselves). The default one-shot `anchor()` records only the **first broadcaster** (`authorBound:false`).

## What it does NOT prove (the honest boundary)

Every receipt carries this note **in-band, verbatim** (an edited note is a named `bad-receipt`):

> This anchored receipt binds the artifact digest above to an on-chain registry record. A receipt from a LOCAL dev chain proves MECHANISM only and is worth NOTHING publicly until a human deploys the registry (STRATEGY.md P-2). On a public chain it proves ONLY that an on-chain record binds this exact digest at a block whose timestamp BOUNDS existence — as trustworthy as the chain + YOUR pinned contract address — NOT the artifact's truth, NOT faithful recording, NOT attribution beyond the anchoring key. The `chain` facts in this receipt are the anchorer's claim until re-checked against the chain (`vh verify-anchored --rpc`).

Spelled out:

- **A LOCAL dev-chain receipt proves MECHANISM only.** The committed fixtures below and every test
  in this repo anchor on an ephemeral local chain (chainId `31337`) — that demonstrates the pipeline
  works end to end, and **nothing more**. Until a human deploys the registry to a public chain
  (STRATEGY.md **P-2**), no receipt from this repo is worth anything publicly.
- **NOT the artifact's truth or faithful recording.** Anchoring binds bytes, not reality: a sealed
  evidence packet's files, an agent log's events, a dataset's provenance hints are exactly as true
  as they were before anchoring (see each product's own trust note — garbage in is out of scope).
- **NOT attribution beyond the anchoring key.** Even `authorBound:true` proves only that the
  **key-holder** was the front-run-resistant first claimant — it does not identify a person or
  organization; pin the key out of band (see `docs/KEY-LIFECYCLE.md`).
- **NOT legal advice** and NOT a compliance verdict.
- **Options (A) and (B) of P-3 remain INDEPENDENT trust-roots a buyer may also require.** A
  publisher signature (A: `vh dataset/parcel sign`) proves *who vouched*; an RFC-3161 TSA token (B:
  `timestamp-request`/`timestamp-wrap`/`verify-timestamp`) is a third party's *existed-by-genTime*
  attestation. An on-chain anchor (C) complements them; it does not replace them.

## Independent verification — the one axis this does NOT yet cover

The verifyhash family's headline is that a counterparty can verify a sealed artifact **OFFLINE,
without installing the producer's stack**: the standalone `verifier/` bundle
([`../verifier/dist/verify-vh-standalone.js`](../verifier/dist/verify-vh-standalone.js)) is a single,
dependency-free file — **no `ethers`, no `npm install`** — that re-derives an evidence packet's or
agent packet's digest by itself. That promise **DOES** cover the **sealed artifact underneath** an
anchored receipt: hand a counterparty the `*.vhevidence.json` (or any closed-table artifact) and they
verify it standalone, exactly as before, with no producer code.

It does **NOT yet extend to the anchored receipt itself.** `vh verify-anchored` — including its
OFFLINE binding leg — runs **only through the producer `cli/` stack, which loads `ethers` at module
load** (`cli/anchor-artifact.js` → `cli/core/attestation.js`); and `vh-anchored-receipt@1` is **NOT a
recognized kind** in the standalone `verifier/verify-vh.js` tree, which scopes itself to sealed
artifacts and explicitly puts on-chain anchoring out of scope. So the family's zero-install
"verify without the producer's stack" promise **does not YET reach the anchored-receipt binding
leg**: a counterparty who wants to check the receipt's binding today must run the producer cli
(`node cli/vh.js verify-anchored`).

This is a **packaging gap, not a proof gap.** (1) The binding check is pure hashing — the standalone
verifier already re-derives evidence-seal and agent-packet digests with no `ethers` — so
`vh-anchored-receipt@1` can be added to the standalone tree to actually close it (tracked as
**T-70.4**). (2) The `--rpc` chain re-check needs the chain anyway, so the offline binding leg's
standalone value is limited until then. Until T-70.4 lands: verify the **sealed artifact** standalone
(zero-install, independent), and verify the **anchor** via the producer cli.

## The free line

Both verbs are FREE — no paid gate, no license, no entitlement: the only cost is the chain's own gas, and the gas is YOUR OWN (paid from a key you provision and hold; `vh verify-anchored` needs no key at all).

## The worked local flow (seal → anchor → verify offline → verify against the chain)

The whole flow runs on a **local** hardhat node — remember the boundary: this proves **mechanism
only**.

```bash
# 0. a LOCAL dev chain + a local registry (terminal 1, then terminal 2):
npx hardhat node --hostname 127.0.0.1 --port 8545
npx hardhat run scripts/deploy.js --network localhost      # prints the registry address
export VH_DEV_KEY=0x...                                    # a LOCAL pre-funded dev key — never a real key

# 1. seal — any closed-table artifact works; here, an evidence packet:
node cli/vh.js evidence seal ./report --out report.vhevidence.json

# 2. anchor — write the digest on-chain, emit the anchored receipt:
node cli/vh.js anchor-artifact report.vhevidence.json --contract <addr> --rpc http://127.0.0.1:8545 \
  --key-env VH_DEV_KEY --author-bound --out report.anchored.json

# 3. verify OFFLINE — no key, no network; the receipt binds EXACTLY this artifact:
node cli/vh.js verify-anchored report.anchored.json report.vhevidence.json

# 4. verify against the CHAIN — authenticate the registry, re-check every chain fact:
node cli/vh.js verify-anchored report.anchored.json report.vhevidence.json \
  --rpc http://127.0.0.1:8545 --contract <addr>
```

**Zero-setup offline leg.** The repo commits a real sample pair under
[`examples/anchoring/`](../examples/anchoring/) — a sealed evidence packet and the
`vh-anchored-receipt@1` a local run produced (chainId `31337`, `authorBound:true`). Step 3 runs
against them with no chain at all:

```bash
node cli/vh.js verify-anchored examples/anchoring/anchored-receipt.local.json examples/anchoring/sample-seal.vhevidence.json
```

It prints `ACCEPTED (offline binding check)` and exits `0`; flip one byte of either file and it is a
named reject, exit `3`. (`test/anchoring.docs.test.js` runs exactly this leg.)

## Going public — the standing human gate (P-2)

Everything above is built, tested, and free to run — against a **local** chain. The single missing
step for receipts that are worth something publicly is the standing **P-2** deploy, which is a
**human** action the loop never takes: provision a THROWAWAY faucet-funded testnet key, deploy to
**Polygon Amoy first** (`scripts/deploy.js`), verify the source on the explorer, and publish the
address so consumers can **pin** it. From that moment the exact commands above work unchanged —
point `--rpc` at Amoy and `--contract` at YOUR pinned address — and every sealed artifact in the
family gains "digest existed by public-chain block time T", with `--author-bound` front-run
resistance, for the price of gas. The loop itself still NEVER deploys, holds funds, or anchors
publicly (see STRATEGY.md P-2/P-3).

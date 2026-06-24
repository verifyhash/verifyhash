# verifyhash — Design-Partner Pilot Kit (`pilot/`)

This directory is the **single runnable artifact** you hand a prospective design partner. It drives
the two sellable verifyhash buyer journeys — the **evidence packet** and the **TrustLedger
reconciliation seal** — end to end against tiny committed sample data, **offline, with no real key,
no TSA, no RPC, and no network**, and prints **one combined PASS/FAIL verdict**.

> **Where to point a partner first:** the buyer-facing, step-by-step runbook —
> "what each artifact proves, where they independently verify it, and the honest trust boundary" —
> lives in [`docs/PILOT.md`](../docs/PILOT.md). This file is the operator's quick reference for
> *running* the kit. Read `docs/PILOT.md` to *explain* it.

## Run it (zero setup)

From a checkout of this repo (`npm install` once), run:

```bash
node pilot/run-pilot.js
```

It exits **0** with a clean `VERDICT: PASS — N/N checks passed (evidence + reconcile).` line, or
non-zero if any check fails. Every check is printed as `[PASS]`/`[FAIL]` under the vertical it belongs
to (`VERTICAL A — EVIDENCE`, `VERTICAL B — RECONCILE`).

Knobs (all optional):

| env var | effect |
| --- | --- |
| `PILOT_OUT=<dir>` | write the run's artifacts to `<dir>` instead of a fresh OS temp dir |
| `PILOT_KEEP=1` | keep the temp workspace after the run so you can inspect the artifacts |

The run **never** writes into the repo working tree. The committed sample under
[`sample-evidence/`](sample-evidence/) and the TrustLedger fixtures it reuses are **READ-ONLY**; the
tamper step always mutates a throwaway **copy** in the workspace.

## What each vertical demonstrates

**VERTICAL A — EVIDENCE** (a folder of compliance/audit files → one tamper-evident packet):

1. **ISSUE** an evidence licence signed by an ephemeral `Wallet.createRandom()` **vendor** key.
2. **GATE** prove the paid `evidence seal --sign` surface is **REFUSED** with no licence (usage exit)
   and **REFUSED** again when the licence is pinned to the **wrong** vendor — and that the refusal
   writes **nothing**.
3. **SIGN** run the same paid surface **with** the valid licence + a separate ephemeral **operator**
   key, producing a signed `*.vhevidence.json` packet.
4. **HAND OFF** only the packet (+ its sibling files) to the **independent** verifier
   ([`verifier/verify-vh.js`](../verifier/verify-vh.js) — `js-sha3` only, no `ethers`/`hardhat`) and
   confirm it **ACCEPTS** (exit 0), pinning the operator key as `--vendor`.
5. **TAMPER** mutate one sealed file and confirm the same independent verifier **REJECTS** it (exit 3)
   and localizes the change to the exact file.

**VERTICAL B — RECONCILE** (a bank CSV + a ledger + a rent roll → a sealed reconciliation packet):

1. **ISSUE** a TrustLedger licence (the `seal` entitlement) signed by an ephemeral vendor key.
2. **GATE** prove `vh trust reconcile --seal` is **REFUSED** with no licence and with the **wrong**
   vendor, writing no packet/seal.
3. **UNLOCK** run the same paid surface with the valid licence + matching vendor; it reconciles to a
   single PASS/FAIL and emits the audit packet + a tamper-evident reconciliation seal.
4. **HAND OFF** only the seal (+ the sibling source/packet files) to the **same** independent
   `verify-vh` and confirm it **ACCEPTS** (exit 0) by **re-deriving** the keccak root.
5. **TAMPER** mutate one sealed source figure and confirm `verify-vh` **REJECTS** it (exit 3) and
   localizes the change.

## The honest trust boundary (do not overclaim)

The kit proves **tamper-evidence + who vouched** (the operator key whose address the counterparty
pins as `--vendor`) and **offline recompute**. It does **NOT** prove a trusted timestamp: a
"sealed on date **T**" claim rides the **human-owned** signing/timestamp trust-root — that is
**P-3** in [`../STRATEGY.md`](../STRATEGY.md) (a self-managed key, an RFC-3161 TSA, or an on-chain
anchor), and the kit deliberately uses **ephemeral throwaway keys only**, so it asserts nothing about
*when*. It is also **not** a legal opinion. The kit **ends at the explicit human handoff** and
overclaims nothing.

## Why no setup / no key / no network

Every signing key is an in-process `Wallet.createRandom()` — created, used, and discarded. The kit
**never** creates, holds, persists, reads, or echoes a real private key, never opens a socket, and is
deterministic (the licence window is dated with an injected clock). That is exactly the posture a
security-conscious partner needs before they will run anything you send them.

## Why it can't silently rot

The whole journey is gated by [`../test/pilot.evidence.test.js`](../test/pilot.evidence.test.js) and
[`../test/pilot.reconcile.test.js`](../test/pilot.reconcile.test.js) under the project's unchanged
`npx hardhat test`, and the buyer-facing prose in [`docs/PILOT.md`](../docs/PILOT.md) is gated by
[`../test/pilot.docs.test.js`](../test/pilot.docs.test.js). If the kit's behaviour or the runbook's
claims drift, the suite fails.

## The go-to-market ask this unblocks

This kit **is** the deliverable every revenue gate was waiting on. The consolidated, decision-ready
ask that folds the shared "land a design partner / run a pilot" precondition of P-3/P-5/P-6/P-7 into
one place is **P-8** in [`../STRATEGY.md`](../STRATEGY.md) → *Proposals — needs-human*.

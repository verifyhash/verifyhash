# Go live: the first dollar

This is the **decision-ready** path from "the loop built a sellable evidence product" to "a paying customer
receives a license." Everything the loop can do is **already built, tested, and green**; what remains are the
**human-owned outward steps** (provision a key, set a price, deploy) that the guardrails forbid the loop from
taking. This page is the short list of exactly those steps, in order.

The lowest-friction product to sell first is the **self-serve evidence license** (see
[`docs/EVIDENCE.md`](EVIDENCE.md)): a buyer pays, a signed license is delivered, and the license unlocks the
paid `vh evidence seal --sign` surface — verified **offline**, no server round-trip, no custody of funds.

## The readiness proof (run this first)

```
npm run go-live        # node scripts/go-live-check.js
```

This is an **offline, dependency-free** end-to-end proof (ephemeral `Wallet.createRandom()` keys, no network,
no deploy, no funds) that the three legs of the sale already work: **seal → independent-verify**, **issue →
verify → fail-closed gate**, and **fulfill → deliver → gate-accept**. It exits `0` and prints the verbatim
human steps last. If it is green, the software is ready; only the human steps below remain.

## The human steps (needs-human — see `STRATEGY.md` › P-7)

1. **Provision the vendor keypair.** Create a signing key **outside** this tool (a keystore/HSM/env var you
   control). Its public address is the `--vendor` a buyer pins. The loop never holds it. **Publish** the
   address so buyers can pin it.

2. **Set the price and term.** Fill in the real price/term for each tier in your evidence plan catalog (the
   bundled catalog is a **DRAFT** skeleton — the loop sets **no** price). Wire your billing provider
   (e.g. Stripe Checkout) to those prices.

3. **Wire self-serve fulfillment (no code to write).** Run the shipped reference webhook
   **`vh fulfill-webhook`** (see [`docs/EVIDENCE.md` › _Reference self-serve fulfillment webhook_](EVIDENCE.md#reference-self-serve-fulfillment-webhook-vh-fulfill-webhook)),
   point your provider's webhook at it with your **real** webhook secret (`--secret-env`), your **real**
   vendor key (`--key-env`/`--key-file`), and a **`--binding`** file mapping each price to a plan — then every
   paid event delivers a license automatically. This removes the human's last **code** step; deploying the
   endpoint behind your own URL/TLS is a config/ops step, not a coding one.

4. **Deploy.** Stand the endpoint up behind your own domain, TLS, and auth/ops posture. The loop binds
   **loopback only** and **never deploys**.

## Revenue integrity (the hard line)

Income comes from **delivering value to paying customers** — a license is an **ACCESS credential for delivered
software value**, **NOT** a token/coin/NFT, not tradeable, and not a trusted timestamp. There is **no** token
sale, airdrop, staking/yield, or appreciating-asset scheme anywhere in this path. See the HARD GUARDRAILS and
P-7 in [`STRATEGY.md`](../STRATEGY.md).

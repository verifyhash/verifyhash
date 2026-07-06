# Producer identity card (`vh identity`)

A **signed, offline-verifiable "who is this vendor, and what exactly do they attest?"** card. A producer
SIGNS — with the **same key** that signs their evidence packets / signed licenses / dataset attestations —
a small, self-describing container that binds their **`vendorAddress`** to a bounded `claims[]` set (what
they attest) and an honest `nonClaims[]` set (what they explicitly do **NOT**). A recipient — or a **cold
prospect** who has never met you — recovers the signer from the card, confirms it **equals the card's own
`vendorAddress`** (the key controls the address it claims), and OPTIONALLY pins it to an address they
learned out of band. All of it is **OFFLINE, key-free, network-free, I/O-free**.

It is the **recipient's / cold prospect's pin-point**: every other artifact this family mints (an evidence
seal, a signed license, a dataset attestation) pins its producer by a vendor **address** the recipient must
learn out of band — an email, a slide, a README line. The identity card is the **one** artifact whose
whole job is to answer, verifiably, "**does this 0x-address really belong to THIS vendor, and what exactly
do they attest — and, just as load-bearing, what do they explicitly NOT?**" before the recipient trusts a
single packet.

**Trust boundary (the output leads with this, verbatim — the standing `IDENTITY_CARD_TRUST_NOTE`):**

```
This is a verifyhash producer IDENTITY CARD: the holder of `vendorAddress`'s key SIGNED it, binding that address to the `claims` it attests and the `nonClaims` it explicitly does NOT. verify RE-DERIVES the signer from these exact bytes and REQUIRES it to equal `vendorAddress` — it never trusts the file's own claims. It proves IDENTITY + the claim SET ONLY: it does NOT prove any specific sealed/signed packet is true (each packet carries its own proof), it is NOT a trusted TIMESTAMP ("published since T" rides the human-owned signing/timestamp trust-root, STRATEGY.md P-3), and it is NOT a legal opinion.
```

> A card proves **IDENTITY + the claim SET**, **NOT packet truth** (each sealed/signed packet carries its
> own proof — `vh evidence verify` / `verify-signed`), **NOT a trusted timestamp** (P-3), and **NOT a legal
> opinion**. See [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md).

## Commands

```
vh identity publish --address <0xaddr> --product-line <line> --claim <text> [--claim ...] --non-claim <text> [--non-claim ...] [--published-at <ISO>] (--key-env <VAR> | --key-file <path>) [--out <p>] [--json]
vh identity verify <card> [--signer <0xaddr>] [--json]
```

### `vh identity publish` — mint the card

`publish` MINTS a signed `*.vhidentity.json` card binding `--address` to the `--claim` set it attests + the
`--non-claim` set it explicitly does NOT. It signs with a **HUMAN-provisioned key** (EXACTLY ONE of
`--key-env` / `--key-file`, **read-used-discarded** via the shared `loadSigningWallet` — the loop **NEVER**
generates, persists, or logs a key, and the key never appears in any output).

- **The load-bearing mint invariant — the key controls the address it claims.** `publish` mints **ONLY**
  when the provisioned key's address **EQUALS** `--address`. A key that does **NOT** control `--address`
  **hard-errors (exit 2) BEFORE writing anything** — so a card can never assert an identity the key cannot
  back, and a published card **always** round-trips to ACCEPTED by construction.
- **Filesystem hygiene.** Default **prints the card + writes NOTHING**; `--out <p>` writes ONLY to the
  caller-chosen path — **never silently to cwd**.
- `--product-line` is one of the closed set `["dataledger", "evidence", "trustledger"]` (an out-of-set line
  is a usage error); `claims` and `nonClaims` are each a **non-empty** list (a card that attests nothing, or
  that drops the honest boundary, is refused).
- The output **LEADS with the trust line**; `--json` carries the PUBLIC card summary (vendorAddress, signer,
  productLine, claims, nonClaims, publishedAt) + the artifact — and **never the key**.
- **Exit:** **0** ok / **2** usage (missing/invalid field, key-source error, key does not control
  `--address`) / **1** IO (`--out` write).

### `vh identity verify` — check + pin the card

`verify <card>` is the **OFFLINE / key-free / network-free** read path. It RECOVERS the signer from the
embedded canonical card bytes + signature and:

1. confirms the signature backs the container's claimed `signer` (**ALWAYS**);
2. confirms the recovered signer **IS** the card's own `vendorAddress` — the load-bearing "the key controls
   the address it claims" check (**ALWAYS**);
3. OPTIONALLY pins the recovered signer to an expected **`--signer <0xaddr>`** you learned out of band.

The verdict is **ACCEPTED** only when **every requested check passes**; a **forged / tampered / wrong-vendor
card, or a wrong `--signer`, is a clean REJECTED — NEVER a silent pass**. It **LEADS with the trust line**,
prints the `claims` + `nonClaims` + per-check **PASS / FAIL / [skip]**, and writes **NOTHING**.

- **Exit:** **0** ACCEPTED / **3** REJECTED / **2** usage / **1** IO — the same read contract as
  `vh evidence verify-signed` / `vh dataset verify-attest`.

## Pin once, trust across handoffs

The card exists so a recipient does the **address-to-vendor** trust step **ONCE**, then reuses that pin
across **every later handoff** — without re-establishing trust out of band each time.

1. **Pin once.** The vendor publishes their card once (`vh identity publish … --out vendor.vhidentity.json`)
   and the recipient confirms it once: `vh identity verify vendor.vhidentity.json --signer <addr-you-were-given>`.
   That single ACCEPTED verdict is the recipient's durable answer to "this 0x-address really is this vendor,
   and here is exactly what they attest / do NOT." The `--signer` pin binds the card to the address the
   recipient learned out of band (the email/slide/contract) — so the out-of-band step happens **once**.
2. **Trust across handoffs.** Every subsequent evidence packet, signed license, or dataset attestation the
   vendor hands over is signed by the **same** key. The recipient verifies each artifact's signer
   (`vh evidence verify-signed <p> --signer <addr>`, etc.) against the **same pinned address** — no new
   out-of-band step, no re-pinning. The card's `vendorAddress` IS the address every later `--signer` pin
   reuses, so one verified card amortizes the trust cost across an unbounded stream of handoffs.

This is why the card is the **cold prospect's first stop**: it converts a single out-of-band "is this
address really them?" into a verifiable, reusable pin — closing the gap between "interesting claim" and "I
trust this vendor enough to run a pilot."

## What the card does and does NOT prove

- **It DOES prove IDENTITY + the claim SET.** The key that controls `vendorAddress` signed a bounded,
  self-describing list of what the vendor attests (`claims`) and what they explicitly do **NOT** (`nonClaims`).
  verify re-derives the signer from the exact bytes and requires it to equal `vendorAddress` — it never
  trusts the file's own claims.
- **It does NOT prove any specific packet's contents are true.** Each sealed/signed packet carries its OWN
  proof — re-derive it (`vh evidence verify`) and check the signer (`vh evidence verify-signed`). The card
  vouches for **who** the vendor is and **what** they claim to attest, not for the truth of any one packet.
- **It is NOT a trusted timestamp.** A `publishedAt` is the vendor's self-asserted instant; "published
  since T" rides the human-owned signing/timestamp trust-root (`needs-human`, **P-3** in
  [Human-owned steps](TRUST-BOUNDARIES.md#p-3-trust-root)), exactly like every other dated artifact in this family.
- **It is NOT a legal opinion.** The card makes no compliance/legal claim; it is tamper-evidence + a signed
  identity binding, nothing more.

## Where it fits

The card is **one more product on the shared signed-attestation envelope** — no new crypto, no new
dependency, no new scheme. It defines its own KIND (`vh-identity-card` / `vh-identity-card-signed`) + a
closed field set, then hands the canonical payload to [`cli/core/attestation.js`](../cli/core/attestation.js),
which does all the crypto: it embeds the EXACT canonical payload bytes, attaches the detached **EIP-191**
signature, and later re-derives the signer — byte-for-byte the same shared paths the evidence seal and the
signed license use. The publish/verify core lives in [`cli/identity.js`](../cli/identity.js).

Provisioning the real vendor key, setting the price, and landing the first design partner remain **human
steps** — the producer publishes their card with the same key they provision for signed evidence/licenses
(STRATEGY.md › **P-7 step 1** / **P-6 step 1**).


---
<sub>© 2026 verifyhash.com · Licensed under Apache-2.0 (SPDX-License-Identifier: Apache-2.0) — see the [LICENSE](https://verifyhash.com/LICENSE) and [NOTICE](https://verifyhash.com/NOTICE) served with this file.</sub>

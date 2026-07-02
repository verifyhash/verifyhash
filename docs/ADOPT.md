# Adopt verifyhash in one line

You do **not** need an account, a license, a sales call, or our `ethers`/`hardhat` toolchain to start.
Pick the row that matches where you are, copy the one line, and run it. The **free** rows below are
**offline** and need at most **Node.js >= 18** — no account, no key, no network.

| You want to… | Copy this one line | Price |
|---|---|---|
| **No Node/terminal at all? Verify in your browser** (the 60-second challenge built in) | open [`verifier/dist/verify-vh-standalone.html`](../verifier/dist/verify-vh-standalone.html) | free |
| **See it work in 5 seconds** (no clone, no flags, no key) | `npx --yes verify-vh demo` | free |
| **Gate your CI on tampered/forged seals** (GitHub Actions) | `uses: <owner>/<repo>/verifier/action@<ref>` | free |
| **Issue signed, customer-verifiable seals of your own** (the paid producer surface) | `vh evidence seal <dir> --sign --license <f> --vendor 0xYOU` | **paid** |

The on-ramp is **deliberately one direction**: the free rows convince you the verdict is real, then the
paid row is the **only** part that turns into revenue — and the line below it (price, key, the sale) is a
**human** step, never the loop's. Each path is detailed below.

---

## 0. The no-terminal path — one offline page in your browser

The browser row needs **no Node, no terminal, no install, no account**: save the ONE committed file
[`verifier/dist/verify-vh-standalone.html`](../verifier/dist/verify-vh-standalone.html) and double-click
it. The page opens with the **60-second challenge built in** — click **"Load the sample packet &
verify"** (**ACCEPT**), change one character of the editable sample file on the page and re-verify
(**REJECT**, naming the file you changed) — then drag a REAL sealed packet + its files in for the same
verdict the CLI prints. It contains **no network API at all**, so your bytes never leave your machine —
check the browser **devtools Network tab**: it stays empty. Honest scope, same as every row here:
tamper-evidence (+ signer-pin for a signed seal), NOT a trusted "sealed at T"; for CI/production gating
use the node standalone (`verify-vh-standalone.js`) — that is row two and §2 below. The guided walkthrough
is [`challenge/README.md`](../challenge/README.md).

---

## 1. The 5-second proof — `npx --yes verify-vh demo`

Run, with nothing checked out at all:

```bash
npx --yes verify-vh demo
```

It downloads the **standalone, offline** `verify-vh` verifier (one runtime dependency, `js-sha3` — **no**
ethers, **no** hardhat, **no** network), ships a tiny **genuinely-signed** evidence packet baked into the
file, plays it through the **exact same verify path** every real check uses, and prints the honest verdict:
a genuine packet is **ACCEPTED and its signer named**, then a one-byte change is **REJECTED**. No flags, no
`--vendor` to paste, no key knowledge. It writes only a throwaway temp dir it deletes, opens **no network**,
and exits `0`.

> The `verify-vh` package's `bin` is `verify-vh`, and `demo` is a real subcommand of
> [`verifier/verify-vh.js`](../verifier/verify-vh.js) — a test runs the literal command above so this line
> can never drift from the tool.

Want a copy you can tamper with by hand? Add a directory and the demo writes the same signed packet there,
then prints the exact verify / tamper / restore commands:

```bash
npx --yes verify-vh demo ./vh-demo
```

When it clicks, point the tool at a **real** packet you were handed:

```bash
npx --yes verify-vh <packet> --vendor 0xPRODUCER_ADDRESS   # exit 0 = ACCEPT; 3 = REJECT
```

Prefer no `npx`? The same verifier is a single self-contained file you can save and run with bare `node` —
see [`verifier/README.md`](../verifier/README.md).

---

## 2. Gate your CI in one line — `uses: <owner>/<repo>/verifier/action@<ref>`

Drop this workflow at `.github/workflows/verify-vh.yml` in the repo that **receives** sealed verifyhash
artifacts. Every push / pull request then fails the build the instant any artifact is tampered, forged, or
signed by the wrong key — blocking the merge:

```yaml
# .github/workflows/verify-vh.yml
name: verify-vh merge gate
on: [push, pull_request]
jobs:
  verify-vh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: <owner>/<repo>/verifier/action@<ref>
        with:
          vendor: "0xYOUR_PRODUCER_SIGNER_ADDRESS"   # the key that must have signed (omit to check tamper only)
          manifest: "release.manifest"               # OR set `artifacts:` instead
```

Replace `<owner>/<repo>` with this repository's slug and `<ref>` with a tag or commit SHA you trust (pin a
SHA for supply-chain safety). The composite action installs **only** the standalone verifier (`js-sha3`) and
resolves its bundled `verifier/` tree via `${{ github.action_path }}` at run time — so you do **not** vendor
`verifier/` into your repo. The action lives at [`verifier/action/`](../verifier/action/action.yml); its full
input table and exit-code contract are in [`verifier/action/README.md`](../verifier/action/README.md).

> ⚠️ **Pin `vendor:` for any SIGNED release.** A signed artifact gated **without** `vendor:` is accepted as
> long as its signature recovers to the signer the packet **self-asserts** — so an attacker who re-signs a
> tampered release with **their own key** passes the gate. Leave `vendor:` empty **only** for genuinely
> unsigned evidence seals (where there is no signer to pin).

---

## 3. Turn "it works" into revenue — the free→paid bridge

The two lines above cost nothing and stay free forever. They exist to get a prospect to one thought:
*"the verdict is real, and I want to hand my OWN signed seals to MY customers."* That is the line that
becomes a paying relationship — and it is the **only** part of this funnel that does.

**What is free vs. paid (no surprises).** The free surface is everything a *recipient* needs: `verify-vh`,
the CI gate, and the producer CLI's baseline verbs — an **unsigned** evidence seal of up to **25 files**
and offline verify. The **paid** surface is what a *producer who sells trust* needs: a **`--sign`** wrap
(a signed attestation your customers pin to YOUR published key) and sealing **more than 25 files**. Those
two are gated by a signed, offline-verifiable entitlement and refuse — never silently downgrade — without
one.

**The whole loop, end to end.** A customer pays you out-of-band. Your billing webhook (after it
authenticates the provider's own signature) runs ONE command to mint that customer a license against a
plan in the catalog:

```bash
# You, the producer, mint a per-sale entitlement with a key YOU provisioned outside this loop:
vh evidence license fulfill --plan evidence-pro-annual --customer "Acme Co" \
    --key-env EVIDENCE_VENDOR_KEY --out ./acme.vhevidence-license.json
```

`evidence-pro-annual` is a **real** plan in the bundled DRAFT catalog (`cli/core/fixtures/evidence-plans/baseline.json`);
`fulfill` copies that plan's entitlements **verbatim** and signs them — the loop **sets no price** and
**holds no key**. The customer then unlocks the paid surface OFFLINE, pinning your **published** address —
no per-sale terminal step for you:

```bash
# Your paying customer runs the PAID producer surface, gated by the license you minted:
vh evidence seal <dir> --sign --license <f> --vendor 0xYOU
```

> The **needs-human** line, on purpose: the **price** on each plan, the **vendor signing key**, and the
> actual **sale/subscription agreement** are all human steps (the loop builds and tests the mechanism but
> sets no price, holds no key, and takes no payment). Revenue comes from **delivering this software value
> to a paying customer** — never from issuing a token, a coin, or any tradeable/appreciating asset; an
> entitlement is an **access description for delivered value**, not a security. Full schema, the closed
> entitlement table, and the worked webhook→fulfill→deliver flow are in [`docs/EVIDENCE.md`](EVIDENCE.md).

---

## What a green result actually proves (the honest boundary)

Whether you run `npx --yes verify-vh demo` or the CI gate, the seal proves **tamper-evidence + signer-pin**,
NOT a trusted "sealed at T" and NOT a legal opinion — it attests *this key vouched for exactly these bytes*,
re-derived from the bytes you hold, offline, with no producer stack. The trusted-timestamp claim ("sealed at
time T") is a separate, human-gated step (see
[`docs/INDEPENDENT-VERIFICATION.md`](INDEPENDENT-VERIFICATION.md)).

---

## Where to go next

- [`verifier/README.md`](../verifier/README.md) — the full independent-verifier guide (zero-install bundle,
  reproduce-from-source, the conformance corpus).
- [`docs/INDEPENDENT-VERIFICATION.md`](INDEPENDENT-VERIFICATION.md) — the counterparty-facing spec: exactly
  what a seal proves and what it does not.
- [`verifier/action/README.md`](../verifier/action/README.md) — the GitHub Action's inputs, exit codes, and
  the no-drift source-of-truth guarantee.
- [`docs/EVIDENCE.md`](EVIDENCE.md) — the **paid** producer surface: the signed evidence packet schema, the
  free-vs-paid line, the closed entitlement table, and the worked **webhook → `license fulfill` → deliver**
  flow that turns an adopter into a paying customer.
- [`docs/TRUSTLEDGER.md`](TRUSTLEDGER.md) › *Zero-install: the offline app* — the TrustLedger pilot path with
  **zero** install: email ONE file ([`trustledger/dist/trustledger-standalone.html`](../trustledger/dist/trustledger-standalone.html)),
  the partner double-clicks it, drags their real exports in, and the page makes **no network request** (free tier only).

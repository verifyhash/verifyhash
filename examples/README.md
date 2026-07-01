# verifyhash — runnable examples

Two committed, self-checking, fully-offline examples. Zero setup, one command each.

## `sdk-verify.js` — embed the SDK exactly as an external developer would

```bash
node examples/sdk-verify.js
```

This is the **consumer** example: it imports the package **only** through its single public entrypoint,
`require("verifyhash")` (plus `ethers`, verifyhash's **own** declared dependency, used only to mint an
**ephemeral throwaway** signing key that stands in for a real, out-of-band vendor key) — **no** deep
`cli/core/...` reach-in, no network, no third-party non-core dependency, no real key. It runs **two acts**:
the free-tier tamper-evidence path, and the paid, revenue-relevant **signed + vendor-pinned verify gate**.

**Act 1 — UNSIGNED tamper-evidence (free tier):**

1. **`buildSeal`** — seal an in-memory `{ relPath, bytes }` file set (no directory, no disk).
2. **`verifySeal`** (untouched bytes) → **ACCEPTED** — the root is re-derived from the bytes you hold.
3. **`verifySeal`** (one byte flipped) → **REJECTED** — and it prints the per-file **diff** the verdict is
   built from (which `relPath` changed, expected vs. actual hash).
4. **`serializeSeal` / `readSeal`** — the canonical, byte-deterministic packet a counterparty can re-read.

**Act 2 — SIGNED + vendor-PINNED verify gate (the paid embed).** This is the integration a downstream
service pays for: **verify in-process that a packet was signed by _our_ published vendor address**, with
**no** shell-out to the `vh` binary (STRATEGY.md **P-9** / EPIC-58 — "verified by verifyhash, signed &
pinned, inside _your_ product").

5. **`signSealWith`** — a publisher signs the seal (ephemeral key here; a real out-of-band key in prod).
6. **`verifySignedSeal`** pinned to **our** vendor address → **ACCEPTED**.
7. **`verifySignedSeal`** pinned to a **different** vendor → **REJECTED** — the signature is *genuine*; only
   the **pin** fails. "Signed by someone, but not by us" must reject; that is the security property a paying
   integrator's gate enforces (it is **not** tamper-evidence — the bytes are fine).
8. **`verifySignedSeal`** on a one-byte-tampered signature → **REJECTED** (recovered signer ≠ claimed).

It leads with the standing **trust note** (a seal proves *tamper-evidence*; a valid **signature** proves
*who vouched* — the pinned address's key-holder — for those bytes; **neither** proves a trusted timestamp
and **neither** is a legal opinion — timestamping rides the human-owned trust-root, `needs-human`, P-3 in
[`STRATEGY.md`](../STRATEGY.md)), prints a clear **PASS** summary naming both acts, and exits 0. The only
key it ever uses is an **ephemeral, in-memory throwaway** (never persisted, funded, or logged). It is
test-gated by [`test/sdk.example.test.js`](../test/sdk.example.test.js) on every `npx hardhat test` — a grep
there asserts the example uses **only** the public surface (`require("verifyhash")` + `ethers`, no deep
`cli/*` import), so the "public API stands alone" claim can never silently rot.

## `sdk-verify-signed.js` — the SIGNED + vendor-PINNED verify gate, in-process

```bash
node examples/sdk-verify-signed.js
```

This is the **buyer's** signed-verify example: it plays a downstream service that **receives** a signed,
vendor-address-pinned deliverable (a model, a dataset, a build artifact) and clears the **two gates that
gate a real purchase** — **(a)** *"was this signed by our published vendor address?"* and **(b)** *"are the
exact files I received **on disk** the ones that vendor signed?"* — **in-process**, with **no** shell-out to
the `vh` binary. It is the SIGNED twin of `vh evidence verify-signed` (including its `--signer` pin and
`--dir` binding), byte-identical because it **is** the same code (`index.js` is a thin identity re-export;
see [`../docs/SDK.md`](../docs/SDK.md)). This is the paid, revenue-relevant embed (STRATEGY.md **P-9** /
EPIC-58 — "verified by verifyhash, signed & pinned, inside _your_ product").

The verify example imports **only** `require("verifyhash")` and **relative** example files — nothing else,
**no** `child_process`, **no** built-in (`fs`/`os`/`path`), **no** network, **no** deep `cli/*` reach-in.
Because a buyer **never signs** and does not do its own disk plumbing, both the publisher-side key handling
(minting an **ephemeral throwaway** key that stands in for the publisher's real out-of-band key) **and** the
"receive the deliverable to a throwaway temp dir / corrupt one received file / clean up" plumbing are
quarantined in [`lib/ephemeral-publisher.js`](./lib/ephemeral-publisher.js) — the only place `ethers`
(verifyhash's own dependency) and Node built-ins are touched. It runs one **ACCEPT** then **four** REJECT/
ACCEPT steps that **escalate in value**:

1. **`verifySignedSeal`** pinned to **our** vendor address → **ACCEPTED**.
2. **`verifySignedSeal`** pinned to a **different** vendor → **REJECTED** — a **wrong-signer** reject: the
   signature is *genuine* and the bytes are fine; it just recovers to a signer we do **not** pin. "Signed by
   someone, but not by us" must reject; that is the security property a paying integrator's gate enforces.
3. **`verifySignedSeal`** on a one-byte-**tampered** signature → **REJECTED** — the recovered signer no
   longer matches the claimed one, so it rejects even under the correct vendor pin.
4. **`verifySignedSealAttestation`** — the **strict, on-disk BINDING gate** a paying integrator actually
   buys — pinned to **our** vendor address **and bound to the actual files received on disk**:
   - **[4a]** the **untouched** received deliverable → **ACCEPTED** — both gates pass: our vendor signed it
     **and** the bytes on disk are byte-identical to what was signed (`manifestBindsAttestation=true`).
   - **[4b]** the received deliverable with **one file corrupted on disk** → **REJECTED** — the vendor
     signature over the **original** bytes is **still genuine** and the pin **still** matches; only the
     on-disk bytes drifted, so `manifestBindsAttestation=false`. This is the **real fraud** the buyer cares
     about — a **genuine our-vendor signature attached to a substituted download** — and it is the case the
     signature-only path (1–3) **cannot** catch. The on-disk binding does.

It leads with the standing **trust note** (a valid **signature** proves *who vouched* — the pinned address's
key-holder — for those exact sealed bytes; it does **not** prove a trusted timestamp and is **not** a legal
opinion — timestamping rides the human-owned trust-root, `needs-human`, P-3 in
[`../STRATEGY.md`](../STRATEGY.md)), prints a clear **PASS** summary, and exits 0. The received deliverable
is written to a **throwaway OS temp dir** (never the repo tree) and cleaned up in a `finally`. Verification
is **offline and key-free**: it recovers a **public** address from the signature, holds no private key, and
contacts nothing. It is test-gated by [`test/sdk.example.signed.test.js`](../test/sdk.example.signed.test.js)
on every `npx hardhat test` — a grep there asserts the example imports **only** `require("verifyhash")` +
relative files, with **no** deep `cli/*` import, **no** `child_process`, **no** built-in, and **no** network,
and a snapshot check asserts it leaves no temp dir in the repo — so the "in-process public verify stands
alone" claim can never silently rot.

## `run.js` — the end-to-end DataLedger + ProofParcel buyer pipeline

One command, zero setup, fully offline:

```bash
node examples/run.js
```

This drives the **real** DataLedger + ProofParcel buyer pipeline against the tiny committed sample data
in this directory, using the **same module entrypoints the `vh` CLI dispatches to** (`cli/dataset.js`,
`cli/parcel.js`) — it is not a brittle shell pipeline of string parsing. It prints a clear **PASS/FAIL**
summary with the produced artifact paths.

## What it runs

- **DataLedger:** `dataset build` → `check --policy` (a PASS against a lenient policy **and** a FAIL
  against a strict one) → `verify` (a MATCH against the untouched sample **and** a MISMATCH after a
  one-byte tamper) → `report` (one filed evidence document) → `attest` (the canonical UNSIGNED bytes).
- **ProofParcel:** `parcel build` → `verify` (MATCH **and** a tamper MISMATCH) → `attest`.

The sample contains **deliberate** problems so the gates have something real to catch:

- `vendored/gpl-snippet.txt` carries a `GPL-3.0` license hint → flagged by `denyLicenses`.
- `data/unlabeled.txt` carries no license hint → flagged by `requireLicense`.

## Where it writes

The committed sample under `examples/` is **read-only** to the script. Everything it produces (manifests,
the report, the unsigned attestation bytes, and the working copies it deliberately tampers) goes to a
fresh **OS temp dir**. Override the location with `VH_EXAMPLE_OUT=/some/path`; keep the artifacts for
inspection with `VH_EXAMPLE_KEEP=1`. **Nothing is ever scattered into the repo working tree.**

## Trust posture (read this — the script will not let you forget it)

The example proves **tamper-evidence** (any edit, rename, add, or remove flips the Merkle root) and emits
the canonical **UNSIGNED** attestation bytes a trust-root would sign. It does **not**, and cannot, prove
*"unaltered since date T"*: that standing claim rides the **human-owned** signing / timestamp / anchor
trust-root (`needs-human`, P-3 in [`STRATEGY.md`](../STRATEGY.md)). The script **references but never
executes** those `sign` / `timestamp` / anchor steps, and says exactly where the human handoff is. See
[`docs/TRUST-BOUNDARIES.md`](../docs/TRUST-BOUNDARIES.md), [`docs/DATALEDGER.md`](../docs/DATALEDGER.md),
and [`docs/PROOFPARCEL.md`](../docs/PROOFPARCEL.md).

## It cannot rot

`test/cli.examples.test.js` runs this example end-to-end against the committed sample on every
`npx hardhat test`, asserting the pipeline completes, the policy violation is flagged, the tamper is
caught, and the run leaves the working tree clean.

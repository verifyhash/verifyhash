# ProofParcel — B2B data-delivery receipts

ProofParcel turns a data hand-off between two parties into a **portable, independently-verifiable
proof-of-delivery receipt**: a tamper-evident manifest that pins **exactly which files (names AND
bytes) were delivered** for a parcel, plus a signable attestation over that parcel's identity. It is a
**thin adapter over the same path-bound Merkle + signed-attestation core** as
[DataLedger](DATALEDGER.md) (`cli/parcel.js` consumes `cli/core/manifest.js` and
`cli/core/attestation.js`), so every claim it makes is independently re-derivable.

Every ProofParcel command is **offline, needs NO private key, and needs NO network**. You can hand a
manifest, a verify result, an attestation, or a signed container to the other party and they can
re-derive the result on an air-gapped machine with only the `vh` CLI — they do not have to trust your
server, your build machine, or you.

> **Read this first:** the trust posture below is the SAME wording carried in-band in every artifact
> (`cli/parcel.js` › `TRUST_NOTE` / `PARCEL_TRUST_NOTE`, shared verbatim with DataLedger) and in
> [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md). Do not overclaim past it.

---

## Who buys this, and why

**B2B data exchange has an expensive failure mode: a delivery dispute.** "You never sent file X." "The
file you sent was altered." "That is not the parcel we agreed to." When a contract has a
delivery-acceptance clause, resolving such a dispute is slow and costly. ProofParcel issues a
contractual **proof-of-delivery receipt** that makes the dispute re-derivable instead of arguable:
either party can re-compute the same Merkle root from the files on disk and detect any
edit/rename/add/remove, and a signed attestation lets a sender **vouch** for exactly which parcel they
handed over.

Buyers are data vendors, market-data redistributors, ML-data marketplaces, and any contract with a
delivery-acceptance clause — a **different paying buyer** than DataLedger's data-provenance reviewer,
with a different budgeted reason to pay.

---

## What ProofParcel PROVES (and what it does NOT)

A parcel manifest commits to a Merkle root over the full set of `(relPath, content)` pairs delivered —
**file names AND bytes**. From that root and the manifest, anyone can re-derive, offline:

1. **Exactly which files were delivered — names and bytes.** Any edit, rename, add, or remove changes
   the root. A re-computed root that matches the recorded root means the files on disk are
   byte-for-byte (and name-for-name) the parcel that was committed to. A hand-edited manifest `root`
   cannot fake a `MATCH` — `vh parcel verify` re-derives the root from the actual file bytes.

2. **A signable parcel IDENTITY.** `vh parcel attest` emits a deterministic, byte-canonical UNSIGNED
   payload (root + fileCount + a canonical `manifestDigest` over the delivered file set) that a sender
   can sign. `vh parcel verify-attest` recovers the signer offline and confirms it.

**It does NOT, by itself, prove:**

- **A trusted delivery TIMESTAMP.** "Delivered ON date T" / "unaltered since date T" rides the
  **human-owned signing/timestamp trust-root** ([`STRATEGY.md` P-3](../STRATEGY.md), `needs-human`).
  The loop ships only the **FORMAT + the OFFLINE VERIFIER**; standing up a real signing key / timestamp
  anchor and producing the actual signature is a human step. This is the **same honest trust posture as
  DataLedger** — a receipt binds the file SET and is signable, but a signature is not a timestamp.
- **That the self-asserted `parcel` metadata is true.** The optional `parcel` block
  (`parcelId` / `sender` / `recipient`) is **UNTRUSTED, self-asserted metadata**: it is **NOT bound
  into the Merkle root**, editing it does not change the root, and it is **EXCLUDED** from the
  attestation `manifestDigest` (a signer commits to the file SET, never the labels). The same applies
  to the per-file `{source, license}` hints.

---

## Commands

| Command | What it produces | Property |
| --- | --- | --- |
| `vh parcel build <dir> --out <p>` | a tamper-evident parcel manifest (Merkle root + per-file `{relPath,contentHash,leaf}` + optional untrusted `parcel` block) | offline, no key, no network |
| `vh parcel verify <dir> --manifest <p>` | re-derives the root from a fresh copy on disk + a precise per-file `ADDED/REMOVED/CHANGED` diff | offline, no key, no network; **CI-gateable exit 0 MATCH / 3 MISMATCH** |
| `vh parcel attest <manifest> [--out <p>] [--json]` | the deterministic, byte-canonical **UNSIGNED** attestation payload a sender signs (root + fileCount + `manifestDigest`; `signed:false`) | offline, no key, no network |
| `vh parcel verify-attest <signed> [--manifest <m>] [--signer <addr>] [--json]` | recovers the signer, optionally pins the expected sender (`--signer`) and binds the signature to your parcel (`--manifest`) | **offline, no key, no network, CI-gateable exit 0 ACCEPTED / 3 REJECTED** |

The signed container uses ProofParcel's own `kind: "verifyhash.parcel-attestation-signed"`, distinct
from DataLedger's `verifyhash.dataset-attestation-signed`, so a dataset signed-container does **not**
cross-verify as a parcel one (and vice-versa) — even though the two products' UNSIGNED identity bytes
can coincide for the same files. The scheme is `eip191-personal-sign` (EIP-191 `personal_sign` over the
EXACT canonical UNSIGNED bytes).

`vh parcel verify-attest` performs up to three checks, ACCEPTED only when **every requested** one
passes:

- **signature recovers to the claimed signer** (always): the embedded signature must recover to the
  address the container claims as `signer`.
- **`--signer <addr>` pins the expected sender** (optional): the recovered signer must equal a specific
  address you expected.
- **`--manifest <m>` binds your parcel** (optional): the canonical UNSIGNED bytes re-computed from YOUR
  parcel manifest must be byte-identical to the signed payload — proving the signature vouches for the
  parcel **you** hold.

---

## Worked example: sender builds a parcel → [signs, P-3] → recipient verify-attests

```sh
# --- SENDER ---
# 1. Build the tamper-evident delivery receipt over the files being delivered.
vh parcel build ./delivery --out parcel.json \
    --parcel-id PX-42 --sender "Acme Data" --recipient "Beta Corp"
#    (parcelId/sender/recipient are UNTRUSTED self-asserted metadata, NOT bound into the root)

# 2. Emit the canonical UNSIGNED attestation payload (the signing-ready bytes).
vh parcel attest parcel.json --out attest.json
#    attest.json carries `signed:false` — it is NOT yet a vouch and NOT a timestamp.

# 3. [HUMAN step, STRATEGY.md P-3] The sender signs the EXACT bytes of attest.json with a real key
#    (eip191-personal-sign) and wraps them into a signed container `signed.json`. The loop NEVER holds
#    a key — it ships only the FORMAT + the OFFLINE verifier. (In tests this signing step uses an
#    EPHEMERAL throwaway `Wallet.createRandom()` key — test-only, never a real key.)

# --- RECIPIENT (offline, no key, no network) ---
# 4. Verify the signed container binds the parcel actually received, by the expected sender.
vh parcel verify-attest signed.json --manifest parcel.json --signer 0x<sender-address>
#    Exit 0 ACCEPTED only if: the signature recovers to the claimed signer, the recovered signer is the
#    expected sender, AND the signature binds the recipient's own parcel manifest. Exit 3 REJECTED
#    otherwise — a recipient's CI can gate on this.

# 5. Independently, confirm the delivered bytes still match the receipt.
vh parcel verify ./received --manifest parcel.json   # exit 0 MATCH / 3 MISMATCH
```

The wrap step is **wrap-don't-edit**: the signed container embeds the EXACT canonical UNSIGNED bytes as
a string, and the embedded payload stays strictly `signed:false` — wrapping adds a vouch, it never
edits the thing vouched for.

---

## Trust boundary (the same honest posture as DataLedger)

- The receipt **binds the file SET** to a Merkle root and is **signable** — but it is **NOT by itself a
  trusted delivery TIMESTAMP**. "Delivered ON date T" rides the human-owned trust-root
  ([`STRATEGY.md` P-3](../STRATEGY.md), `needs-human`).
- The `parcel` metadata (`parcelId` / `sender` / `recipient`) and the per-file `{source, license}`
  hints are **UNTRUSTED, self-asserted**: not bound into the root, excluded from the attestation digest,
  and proving nothing on their own.
- A valid signature proves the **holder of `signer`'s key vouched for THIS parcel identity** — not a
  timestamp, not the truth of the metadata.

See [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md) and DataLedger's
[trust posture](DATALEDGER.md) — ProofParcel reuses the SAME in-band `TRUST_NOTE` verbatim so the
caveats never drift between products.

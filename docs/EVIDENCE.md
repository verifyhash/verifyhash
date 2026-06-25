# Evidence Packets (`vh evidence`)

A **product-agnostic, license-gated, tamper-evident evidence packet** for any directory of files.
`vh evidence seal <dir>` binds the whole file set into ONE content-addressed `*.vhevidence.json` packet;
`vh evidence verify <p>` re-derives the root from the bytes you hold and localizes any tamper to the exact
file. It is the **second vertical** on verifyhash's shared provenance core (after DataLedger and
ProofParcel), and it ships its **own** sellable license product.

> **Trust boundary (the output leads with this):** the seal proves **TAMPER-EVIDENCE +
> OFFLINE-RECOMPUTE**, **NOT a trusted timestamp**. "Sealed at time T" still rides the human-owned
> signing/timestamp trust-root (`needs-human`, **P-3** in [`STRATEGY.md`](../STRATEGY.md)). The packet is
> an **UNTRUSTED transport container** — `verify` re-derives the root from the bytes referenced; it never
> trusts the packet's own stored hashes. `verify` checks the **CONTENT, not the signer** — to prove **WHO**
> signed a signed packet, use `verify-signed` (it recovers the signer from the cryptography, never the
> claimed label). See [`docs/TRUST-BOUNDARIES.md`](TRUST-BOUNDARIES.md).

## What it is for

Any time you hand someone a folder of files and later need to prove **"this is the EXACT set of files I
gave you, byte-for-byte unaltered"** — incident-response evidence bundles, audit work-paper folders,
QA/release artifact sets, a contract's exhibit pack, a dataset hand-off. A text editor can silently
rewrite one byte and nothing detects it; an evidence packet detects it and **names the file**.

It is deliberately **generic**: unlike the TrustLedger reconciliation seal, the evidence packet binds NO
domain verdict/role/period — it commits to the file SET and nothing else. That is what makes it reusable
across products.

## Commands

```
vh evidence seal <dir> [--out <p>] [--license <f> --vendor <0xaddr>] [--sign --key-env <VAR>|--key-file <p>] [--json]
vh evidence verify <p> [--dir <d>] [--json]
vh evidence verify-signed <signed> [--dir <d>] [--signer <0xaddr>] [--json]
vh evidence diff <p1> <p2> [--json]
```

- `seal` walks `<dir>` (reusing the SAME path-bound enumeration as `vh hash <dir>` / `vh dataset build`),
  builds the packet over [`cli/core/packetseal.js`](../cli/core/packetseal.js), and **either prints the
  seal to stdout (default — writes NOTHING) or writes it to `--out <p>`**. It NEVER writes to cwd without
  `--out`. Exit: **0** ok / **3** seal-build-error / **2** usage / **1** IO.
- `verify` is **read-only, NO key**. It re-derives the **content root** from the bytes referenced and reports
  **OK** or exactly which file **CHANGED / MISSING / UNEXPECTED**. Files resolve relative to `--dir` (if given)
  else the packet file's own directory (the packet stores relPaths relative to the sealed `<dir>`, so the
  portable hand-off ships the files next to the packet). Exit: **0** OK / **3** REJECTED / **2** usage /
  **1** IO — the SAME offline-recompute posture as `vh verify-seal` / `vh verify-proof`. **`verify` checks
  the CONTENT, not the signer.** On a SIGNED packet it never reports the claimed signer as trusted: it
  RECOVERS the signer from the bytes + signature and either **REJECTS a forged signature** OR labels a
  genuine one **UNVERIFIED-for-pinning**, pointing you at `verify-signed` — it does **NOT** pin the signer to
  anyone you trust. To prove **WHO** signed, run `verify-signed` (below).
- `verify-signed` is the **recipient's "prove WHO signed this" step** — the trust check the **paid signed
  surface exists to enable**, and the command that ACTUALLY checks a signed packet's signer. It is
  **OFFLINE / key-free / network-free** and **recover-not-trust**: it RECOVERS the public signer address from
  the embedded canonical seal bytes + signature (**Check 1, ALWAYS**), it never trusts the container's
  claimed `signer` label. **`--signer <0xaddr>` PINS** the recovered signer to an expected publisher (Check 2),
  and **`--dir <d>` BINDS** the signature to YOUR OWN bytes by recomputing the canonical seal from that
  directory (Check 3). The verdict is **ACCEPTED** only when every requested check passes; a
  forged / tampered / wrong-key signature, a wrong `--signer`, or a wrong `--dir` is a clean **REJECTED** —
  **NEVER a silent pass**. It leads with the trust caveat and prints each check **PASS / FAIL / [skip]**.
  Exit: **0** ACCEPTED / **3** REJECTED / **2** usage / **1** IO (mirrors `vh dataset verify-attest`).
- `diff` is the **recipient-side** companion to `verify`: it compares TWO already-sealed packets and reports
  what **ADDED / REMOVED / CHANGED** between them, OFFLINE, with **no directory and no key**. It is
  **read-only, FREE, key-free** — a diff produces no new sealed/signed artifact, so there is nothing to gate.
  Exit: **0** IDENTICAL / **3** DIFFERENT / **2** usage / **1** IO — the SAME exit contract as `vh dataset diff`.
  A `diff` compares what each packet **CLAIMS**; it does **NOT** re-derive content from bytes (to confirm a
  packet still matches a real directory, run `vh evidence verify <p> --dir <d>`). It changes no `seal`/`verify`
  behavior.

## Free vs paid

| Surface | Tier | Gate |
| --- | --- | --- |
| Unsigned baseline seal of up to **25 files** + `verify` + `verify-signed` + `diff` | **FREE** | none — try before you buy |
| `--sign` (wrap the seal in a signed attestation) | **PAID** | `evidence_signed` |
| Sealing **more than 25 files** in one packet | **PAID** | `evidence_unlimited` |

`verify-signed` is the FREE, key-free **recipient** side of the PAID `--sign` surface: the operator pays to
PRODUCE a signed packet, and any recipient runs `verify-signed` to PROVE who signed it — no license, no
vendor, nothing to gate (a recipient checking a signature mints no new artifact). The trust the paid signed
surface sells is only realized when the recipient runs `verify-signed` to recover + pin + bind the signer.

The free tier stays fully open so a buyer can evaluate the product end-to-end. A paid surface REQUIRES a
valid `--license <f> --vendor <0xaddr>`, verified **OFFLINE** via [`cli/core/license.js`](../cli/core/license.js)
against the **evidence-product** entitlement table (`kind: vh-evidence-license` — a **separate** product
from `trustledger-license`). The gate reuses the **same `verifyLicense` / named-reject posture** as the
TrustLedger CLI: a missing/expired/`wrong_issuer`/under-entitled license is a hard refuse that **never
silently downgrades to a free run**, and the packet is never written when the gate fails.

## The evidence-packet schema (every field UNTRUSTED transport)

A bare packet (`*.vhevidence.json`):

```json
{
  "kind": "vh.evidence-seal",
  "schemaVersion": 1,
  "note": "This evidence seal is TAMPER-EVIDENT + OFFLINE-RECOMPUTABLE, NOT a trusted timestamp. …",
  "root": "0x…32-byte…",
  "fileCount": 3,
  "files": [
    { "relPath": "a.txt", "contentHash": "0x…", "leaf": "0x…" },
    { "relPath": "sub/b.bin", "contentHash": "0x…", "leaf": "0x…" }
  ]
}
```

| Field | Meaning | Trust |
| --- | --- | --- |
| `kind` | `vh.evidence-seal` (generic; bare) or `vh.evidence-seal-signed` (signed wrap) | identity discriminator; `verify` rejects a foreign/edited kind |
| `schemaVersion` | format version (`1`) | rejected if unsupported |
| `note` | the standing trust caveat carried in-band | must match the standing note (caveat can't drift) |
| `root` | Merkle root over every `(relPath, content)` pair | **UNTRUSTED** — `verify` RE-DERIVES it from the bytes and compares |
| `fileCount` | number of sealed files | must equal `files.length` |
| `files[]` | per-file `{ relPath, contentHash, leaf }`, sorted by `relPath` | UNTRUSTED — each `leaf` must equal `pathLeaf(relPath, contentHash)`, and the whole list must re-fold to `root` |

**Everything in the packet is untrusted transport.** Verification is authoritative by **re-computing** the
per-file content hashes and the root from the bytes you supply; the stored hashes are merely the
EXPECTATION it checks against. A hand-edited `root` (or a leaf, or a `contentHash`) is caught two ways:
the per-file leaf must be internally self-consistent, AND the whole set must re-fold to `root`. The
`root` uses the **exact same path-bound, domain-separated Merkle convention** as `vh hash <dir>` and the
on-chain `verifyLeaf` — no new crypto, no second hashing scheme.

A **signed** packet (`kind: vh.evidence-seal-signed`, the paid `evidence_signed` surface) wraps the EXACT
canonical bare-seal bytes in `attestation` and attaches a detached EIP-191 `signature` — the SAME
signed-attestation envelope ([`cli/core/attestation.js`](../cli/core/attestation.js)) the dataset/parcel
products use. The signature is **untrusted transport too**: the container's claimed `signer` is just a label
until `vh evidence verify-signed` RECOVERS the public address from the bytes + signature and confirms it.
The recovered signer proves **WHO vouched**, NOT **WHEN**:

> **Signer-vouch, NOT a timestamp (P-3).** A valid signature proves the HOLDER OF `signer`'s key vouched for
> THIS evidence seal (the embedded root + the full set of (relPath, content) pairs). It does NOT by itself
> prove a trustworthy TIMESTAMP: "sealed/vouched since a date T" still needs the human-owned signing/timestamp
> trust-root (needs-human, P-3). It is NOT a legal opinion.

## Worked example: seal → hand over packet → verify

```
# 1. Seal a folder. Without --out, the seal prints to stdout and NOTHING is written.
#    Write the packet NEXT TO the files so the hand-off is portable.
$ vh evidence seal ./evidence-bundle --out ./evidence-bundle/bundle.vhevidence.json
This evidence seal is TAMPER-EVIDENT + OFFLINE-RECOMPUTABLE, NOT a trusted timestamp. …
sealed 3 files into an evidence packet — root 0xe393…b6f1
  written:      /abs/evidence-bundle/bundle.vhevidence.json

# 2. Hand the WHOLE folder (files + bundle.vhevidence.json) to the other party.

# 3. They verify offline, no key — files resolve next to the packet by default:
$ vh evidence verify ./evidence-bundle/bundle.vhevidence.json
…
root matches:    yes
files: 3 matched, 0 changed, 0 missing, 0 unexpected
OK — every sealed file re-derives byte-for-byte and the root matches.        # exit 0

# 4. If ANY file was altered in transit, verify names it and exits non-zero:
$ vh evidence verify ./evidence-bundle/bundle.vhevidence.json
REJECTED — the files do NOT match the packet:
  CHANGED    report.pdf: sealed 0x… != on-disk 0x…                            # exit 3
```

## Proving WHO signed: `vh evidence verify-signed`

`verify` answers **"are these the exact bytes that were sealed?"** — the content check. It does **NOT** answer
**"who signed it?"**: on a signed packet `verify` recovers the signer only to flag a forgery or call a genuine
signer **UNVERIFIED-for-pinning**; it never pins the signer to anyone you trust. The recipient's
**"prove WHO signed this"** step — the trust check the paid `--sign` surface exists to enable — is a separate
command, `verify-signed`:

```
# Operator (key provisioned outside the loop) seals + signs, gated by an evidence license:
$ vh evidence seal ./bundle --out ./bundle/b.vhevidence.json \
    --sign --key-env EV_OP_KEY --license evidence.vhlicense.json --vendor 0x<evidence-vendor>
…  signed by:    0x<operator>

# The recipient PROVES who signed it — recover (always) + pin (--signer) + bind (--dir), all OFFLINE/key-free:
$ vh evidence verify-signed ./bundle/b.vhevidence.json --signer 0x<operator> --dir ./bundle
TRUST: A valid signature proves the HOLDER OF `signer`'s key vouched for THIS evidence seal …       # caveat first
verify-signed:    ACCEPTED
recovered signer: 0x<operator>  (from the embedded canonical seal bytes + signature)
  [PASS] signature recovers to the claimed signer
  [PASS] recovered signer matches the expected signer (0x<operator>)
  [PASS] the signature binds YOUR directory …
ACCEPTED: every requested check passed.                                                              # exit 0

# A WRONG --signer (or a forged/tampered signature, or a --dir that doesn't match) is a clean REJECTED:
$ vh evidence verify-signed ./bundle/b.vhevidence.json --signer 0x<someone-else>
…
REJECTED: failed check(s): signerMatchesExpected.                                                    # exit 3
```

**The boundary in one line.** `verify` = does the CONTENT match the seal? (re-derive the root from bytes).
`verify-signed` = does a TRUSTED signer vouch for it? (recover the signer, then `--signer` to pin and `--dir`
to bind). Use `verify` when you only hold the files; use `verify-signed` when the packet is signed and you
need to prove the signer. `verify-signed` is **recover-not-trust**: it never believes the claimed `signer`
label — it derives the address from the cryptography and (with `--signer`) checks it against the publisher
you expected.

> **Signer-vouch, NOT a timestamp (P-3).** A valid signature proves the HOLDER OF `signer`'s key vouched for
> THIS evidence seal (the embedded root + the full set of (relPath, content) pairs). It does NOT by itself
> prove a trustworthy TIMESTAMP: "sealed/vouched since a date T" still needs the human-owned signing/timestamp
> trust-root (needs-human, P-3). It is NOT a legal opinion.

## What changed between two hand-offs? `vh evidence diff`

`diff` is the **recipient-side** companion to `verify`. You were handed the **v1** packet of a folder, and
later the **v2** packet of the next hand-off. To see exactly what moved between them, run the diff over the
two **portable artifacts** — no directory, no key, no network:

```
$ vh evidence diff ./v1.vhevidence.json ./v2.vhevidence.json
TRUST: this compares what each evidence packet CLAIMS — it does NOT re-derive content (there is no directory). …
       (run `vh evidence verify <packet> --dir <d>` against the live tree to re-derive a root from bytes).
…
files: DIFFERENT
  ADDED    new.txt …
  REMOVED  old.txt …
  CHANGED  report.pdf  old: 0x… -> new: 0x…
+1 / -1 / ~1 / 2 unchanged                                                    # exit 3 (DIFFERENT)
```

- **What it reports.** `vh evidence diff v1 v2` reports **ADDED / REMOVED / CHANGED** purely from the two
  sealed packets, OFFLINE, with **no directory and no key**. The change set is directional: `v1` is the
  baseline, `v2` is the comparison. Exit **0** when the two packets are IDENTICAL, **3** when DIFFERENT (the
  SAME exit contract as `vh dataset diff`), **2** usage, **1** IO.
- **A rename shows as REMOVED + ADDED.** The relPath is bound into each leaf, so moving `old.txt` to
  `new.txt` (even with byte-identical content) surfaces as **REMOVED(old) + ADDED(new)**, never a single
  CHANGED.
- **It compares CLAIMS, NOT content.** A diff compares what each packet **CLAIMS** — it does **NOT** re-derive
  content from bytes (there is no directory to read). To confirm a packet still matches a **real directory**
  byte-for-byte, run `vh evidence verify <p> --dir <d>` — that is the bytes-level check. `diff` changes no
  `seal`/`verify` behavior; it is a purely additive read.
- **`diff` is FREE / key-free.** It produces no new sealed/signed artifact, so there is **nothing to gate**:
  no `--license`, no `--vendor`, no entitlement check. A recipient can run it on any two packets they hold —
  one more fully-open surface in the free-tier funnel (P-7) that a buyer can evaluate before paying for the
  signed/unlimited paid tiers.

> **Trust boundary (unchanged):** the seal proves **TAMPER-EVIDENCE + OFFLINE-RECOMPUTE**, **NOT a trusted
> timestamp**. "Sealed at time T" still rides the human-owned signing/timestamp trust-root (`needs-human`,
> **P-3** in [`STRATEGY.md`](../STRATEGY.md)). A diff inherits this boundary: it tells you what the two
> packets CLAIM differs, it does not prove WHEN either was sealed.

## How it reuses the shared cores

The evidence product is a **thin adapter** — it re-implements no crypto:

- **Seal** → [`cli/core/packetseal.js`](../cli/core/packetseal.js), the generic packet-seal core
  (`buildSeal`/`validateSeal`/`verifySeal`). The evidence adapter supplies only its `kind` and uses the
  core with **no header** (the optional verdict/role binding seam stays unused — that's the trust-reconcile
  vocabulary the evidence product deliberately omits). TrustLedger's reconciliation seal uses the SAME
  core *with* a header; the machinery is identical.
- **File enumeration** → `cli/hash.js › listFiles`, the SAME recursive walk `vh hash <dir>` and
  `vh dataset build` use. relPaths are POSIX-normalized and relative to the sealed `<dir>`.
- **License** → [`cli/core/license.js`](../cli/core/license.js), the generic signed-entitlement engine.
  The evidence adapter supplies its OWN `kind` (`vh-evidence-license`) + closed entitlement table; the
  core does all the crypto via the shared attestation envelope. `verifyLicense` re-derives the signer,
  pins it to `--vendor`, checks the window, and localizes the reject reason (`wrong_issuer`/`expired`/…).
- **Signed wrap** → [`cli/core/attestation.js`](../cli/core/attestation.js), the same EIP-191
  signed-attestation envelope as the dataset/parcel/seal products.

## Going to market

Standing up the evidence vendor keypair, the price, and the first design partner are **human steps** —
see **P-7 (needs-human)** in [`STRATEGY.md`](../STRATEGY.md). The loop builds and locally tests; it never
holds a vendor key, never sets a price, and never deploys.

# Evidence Packets (`vh evidence`)

A **product-agnostic, license-gated, tamper-evident evidence packet** for any directory of files.
`vh evidence seal <dir>` binds the whole file set into ONE content-addressed `*.vhevidence.json` packet;
`vh evidence verify <p>` re-derives the root from the bytes you hold and localizes any tamper to the exact
file. It is the **second vertical** on verifyhash's shared provenance core (after DataLedger and
ProofParcel), and it ships its **own** sellable license product.

> **Trust boundary (the output leads with this):** the seal proves **TAMPER-EVIDENCE +
> OFFLINE-RECOMPUTE**, **NOT a trusted timestamp**. "Sealed at time T" still rides the human-owned
> signing/timestamp trust-root (`needs-human`, **P-3** in [Human-owned steps](TRUST-BOUNDARIES.md#p-3-trust-root)). The packet is
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
vh evidence seal <dir> [--out <p>] [--license <f>] [--sign --key-env <VAR>|--key-file <p>] [--json]
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
valid `--license <f>`, verified **OFFLINE** via [`cli/core/license.js`](../cli/core/license.js)
against the **evidence-product** entitlement table (`kind: vh-evidence-license` — a **separate** product
from `trustledger-license`). The gate reuses the **same `verifyLicense` / named-reject posture** as the
TrustLedger CLI: a missing/expired/`wrong_issuer`/under-entitled license is a hard refuse that **never
silently downgrades to a free run**, and the packet is never written when the gate fails.

**The pin is CANONICAL, never caller-chosen (T-75.3).** The gate verifies the license against the
committed **canonical vendor identity** `0x7cb4d3DC6C52996B6386473Bfb32f898263412f7`
([`cli/core/vendor-identity.js`](../cli/core/vendor-identity.js)) — only a license minted by that
vendor key unlocks the paid surface. `--vendor <0xaddr>` is still accepted, but only as an explicit
assertion that must EQUAL that identity: it can **not** re-pin the gate (that would let anyone
self-mint a license and unlock the paid surface for free). Self-hosted operators set their **own**
canonical identity (`VH_CANONICAL_VENDOR`, or the programmatic `io.canonicalVendor` seam) — an honest
boundary against free-riding the hosted vendor, not a DRM claim; see
[`docs/LICENSING.md`](./LICENSING.md) "Paid-gate vendor pinning".

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

### Was the signing key still good? `--revocations <f> [--as-of <ISO>]`

A genuine signature proves *who* signed — but a key can be **compromised, rotated, or retired** after it
signed. `verify-signed` lets the recipient ask the only question that then matters — **"was that key
trustworthy AS OF the instant this exhibit was sealed?"** — by passing the vendor's signed
[**key revocation(s)**](KEY-LIFECYCLE.md):

```
# An exhibit signed under a key the vendor later revoked-BEFORE your as-of instant downgrades to REVOKED:
$ vh evidence verify-signed ./bundle/b.vhevidence.json --signer 0x<operator> --dir ./bundle \
    --revocations ./operator.vhrevocation.json --as-of 2026-07-01T00:00:00.000Z
…
revocation check (as of 2026-07-01T00:00:00.000Z):
  [REVOKED] the signing key (0x<operator>) was REVOKED as of 2026-06-26T00:00:00.000Z (reason: rotated) … This artifact is NOT trustworthy as of 2026-07-01T00:00:00.000Z.
REJECTED: …                                                                                    # exit 3
```

`--revocations` is **strictly optional and non-loosening**: with NO `--revocations` the verdict + exit code
are **byte-for-byte** what they are today. A revocation can ONLY turn an ACCEPTED into a **REVOKED**, never
the reverse; a revocation dated AFTER your `--as-of` keeps the ACCEPTED verdict with an informational
"later-revoked" note (the exhibit WAS signed while the key was good); and a **forged / tampered /
third-party** revocation is **IGNORED with a warning**, never trusted to downgrade. Remember the boundary:
a revocation is a **signed CLAIM** by the key-holder (`revokedAt` is self-asserted), **NOT** a trusted
wall-clock timestamp without P-3, so `--as-of` is **recipient-chosen evidence, not an oracle**. The
producer side (`vh revocation publish`) and the full key-lifecycle story:
[`docs/KEY-LIFECYCLE.md`](KEY-LIFECYCLE.md).

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
> **P-3** in [Human-owned steps](TRUST-BOUNDARIES.md#p-3-trust-root)). A diff inherits this boundary: it tells you what the two
> packets CLAIM differs, it does not prove WHEN either was sealed.

### Gate the change in CI: `vh evidence diff … --policy <f>`

A bare diff answers *what changed*; a pipeline needs *is this change ALLOWED?* — and a non-zero exit when it
is not. Pass a small **drift policy** and the exit code becomes the **policy verdict**: a DIFFERENT-but-
**permitted** change PASSes (exit **0**), a **disallowed** change FAILs (exit **3**). The verdict is computed
from the *same* change set the diff prints, so it can never disagree with the body.

```
$ vh evidence diff ./v1.vhevidence.json ./v2.vhevidence.json --policy ./drift.json
…
files: DIFFERENT
  ADDED    new-exhibit.pdf …
## drift policy
  verdict: PASS  (rules evaluated: 2)
  PASS — every change between A and B is permitted by this policy.       # exit 0 (gate PASS)
```

A drift policy is a JSON object `{ "kind": "vh.evidence-drift-policy", "schemaVersion": 1, … }` with any
combination of these **optional** rules (a policy with no rules trivially PASSes):

- `"noAdded": true` / `"noRemoved": true` / `"noChanged": true` — forbid *any* ADD / REMOVE / edit.
  `noRemoved` is the load-bearing **chain-of-custody** guard: an evidence packet that LOSES a file is
  suspicious. `noRemoved` + `noChanged` together enforce an **append-only** evidence trail.
- `"allowChangePaths": ["src", …]` — a CHANGED file **outside** every allowed POSIX prefix violates
  (e.g. only files under `src/` may be edited). The match is **segment-aware**: `src` matches `src/x` and
  `src`, never `srcfoo`.
- `"frozenPaths": ["legal", …]` — a file under a frozen prefix that is CHANGED **or** REMOVED violates
  (those paths may be neither edited nor deleted); **adding** a new file under a frozen prefix is allowed.

A rename is REMOVED(old) + ADDED(new) in the change set, so it is gated as a remove + an add — never a silent
edit. `--policy --json` carries a `drift` block `{ verdict, rulesEvaluated, violations[] }` (each violation is
`{ relPath, rule, change }`), so a CI consumer reads the verdict and the exact offending files from the same
object as the change set. The gate is **OFFLINE / key-free / FREE** like the diff itself — it reuses the pure
`diffEvidence` change set verbatim and adds no crypto. It mirrors `vh dataset check`'s policy gate, so the two
read identically.

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

## Issue a license per sale: `vh evidence license fulfill`

The paid surfaces (`--sign`, sealing > 25 files) only unlock for a holder of a valid `*.vhevidence-license.json`.
Minting one **by hand** for every sale does not scale: a human at a terminal would have to remember the **exact**
entitlement flags a tier grants and **hand-compute** the expiry. That is error-prone (a typo grants the wrong tier,
a mis-keyed expiry drifts) and **un-automatable** — a billing provider's *payment-succeeded* event carries a
**`planId`** and a **paid-through date**, not a comma-list of entitlement flags. **`vh evidence license fulfill`**
+ the **evidence plan catalog** close that gap: they turn "issue the right evidence license" into **one
deterministic command** a billing webhook can drive, with **no hand-authored entitlement list**. This is the
seller's **"issue a license per sale"** step — the self-serve fulfillment seam that makes an evidence sale
machine-driven, NOT a human hand-crafting entitlement flags.

> **Boundary (VERBATIM — read this first).** The loop ships **ONLY** the catalog **schema** + the order→license
> **mapping** + **ephemeral test keys**. It **NEVER** sets a price, holds a real key, runs a payment processor,
> or takes a real payment. **Provisioning the evidence vendor key, setting the PRICE/term column in the catalog,
> and wiring the actual webhook/billing remain HUMAN-owned outward steps** (STRATEGY.md › P-7 steps 1–2). A plan
> is an **ACCESS DESCRIPTION** for delivered software value — which paid evidence features a subscription unlocks
> and for how long — **NOT a token, NOT tradeable, NOT an appreciating asset**, and the catalog makes
> **NO claim of regulatory compliance**. The actual subscription agreement governs.

> **Trust boundary (unchanged).** Fulfilling a license mints an **ACCESS credential**, NOT a trusted timestamp.
> A minted license proves the holder paid for the named evidence features; it does **NOT** prove **WHEN** any
> packet was sealed — "sealed at time T" still rides the human-owned signing/timestamp trust-root (`needs-human`,
> **P-3** in [Human-owned steps](TRUST-BOUNDARIES.md#p-3-trust-root)). The license is verified the SAME way every evidence artifact is —
> `verifyLicense` RE-DERIVES the signer from the bytes + signature and pins it to `--vendor`; the container's
> claimed `vendor` is UNTRUSTED transport until then.

### The evidence plan catalog (a DRAFT the human prices)

A plan catalog is a single, **versioned, strictly-validated** JSON file. [`cli/core/evidence-plans.js`](../cli/core/evidence-plans.js)
is the source of truth (pure `validateEvidencePlanCatalog` / `getEvidencePlan` / `fulfillEvidenceOrder`, **no I/O,
no clock, no key**). It is the **one** machine-readable mapping `planId → { entitlements, termDays, displayName }`
over the **CLOSED** evidence entitlement table — so an unknown entitlement or a duplicate plan is a **hard build
error**, never a silent mis-grant. Every field:

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `kind` | **yes** | string `"vh-evidence-plan-catalog"` | Fixes the artifact type, **disjoint** from a license/seal AND from the `trustledger-plan-catalog` kind. A wrong/missing `kind` is a hard `EvidencePlanCatalogError`. |
| `schemaVersion` | **yes** | integer (currently **1**) | Pins the catalog shape. Any unsupported version is a hard error — never coerced. |
| `plans` | **yes** | non-empty array | The plan list. Emitted in `planId`-sorted order, deterministically. |
| `plans[].planId` | **yes** | non-empty string | The plan id a billing `planId` resolves against. **Duplicate ids are rejected.** |
| `plans[].displayName` | **yes** | non-empty string | A human label for the tier (shown, not enforced). |
| `plans[].entitlements` | **yes** | non-empty array of **known** flags | The paid features this plan unlocks — drawn **ONLY** from the **closed evidence entitlement table** (`evidence_signed`, `evidence_unlimited`). An unknown or duplicate flag is a hard error. This is what `fulfill` copies into the license **verbatim**. |
| `plans[].termDays` | **yes** | **positive integer** | The subscription term in days. When an order omits an explicit `--paid-through`, `expiresAt = issuedAt + termDays` days. A non-integer or non-positive term is rejected (never rounded/coerced). |

> **The catalog is a DRAFT the HUMAN prices.** The bundled catalog is a **DRAFT skeleton**: it ships the
> `planId → entitlements/term/displayName` mapping, but **the PRICE and your real term are YOURS to set** (P-7
> step 2). Editing the catalog (a data file in this validated schema) is exactly that narrow human step — no
> engine change is needed. The shipped `_DRAFT` string is ignored by the engine and exists only to keep the
> access-description posture attached to the file itself.

**The closed entitlement table.** The set of entitlement flags a plan may grant is **exactly** the evidence
license CFG's closed table (`cli/evidence.js › LICENSE_CFG`), derived via the SAME core
`entitlementFlags(cfg)` helper the license **gate** uses — never a hard-coded copy — so the catalog and the gate
that honors a license can **never drift**. The closed table:

| Entitlement flag | Unlocks |
| --- | --- |
| `evidence_signed` | wrap the seal in a signed attestation (`vh evidence seal --sign`) |
| `evidence_unlimited` | seal **more than 25 files** (above the free `SAMPLE_LIMIT`) in one packet |

A flag outside that table is a **hard reject** at catalog-validation time — the evidence catalog can never grant a
TrustLedger entitlement (nor vice-versa); the two products are **DISJOINT**.

### The bundled draft skeleton

The catalog `fulfill` resolves against when you pass **no** `--catalog` is the bundled draft
(`cli/core/fixtures/evidence-plans/baseline.json`), read from **this package's own** fixtures dir — never the
caller's cwd. Its draft plans:

| `planId` | `displayName` | entitlements | `termDays` |
| --- | --- | --- | --- |
| `evidence-signed-monthly` | Evidence Signed (monthly) — DRAFT | `evidence_signed` | `30` |
| `evidence-pro-annual` | Evidence Pro (annual) — DRAFT | `evidence_signed`, `evidence_unlimited` | `365` |

These are a **skeleton to copy**: keep/rename the plans, set **your** `termDays`, and attach **your** price
out-of-band. Point `--catalog <file>` at your own catalog to override the bundle entirely.

### `vh evidence license fulfill` (the one-command shape)

```
vh evidence license fulfill --plan <planId> --customer <name> [--paid-through <ISO>] [--catalog <file>]
                            (--key-env <VAR> | --key-file <path>)
                            [--issued <ISO>] [--license-id <id>] [--out <file>] [--json]
```

`fulfill` looks the `planId` up in the catalog, copies that plan's **entitlements VERBATIM** (never re-typed),
derives the window (`--paid-through`, else `issuedAt + termDays`), and mints the **SAME** signed
`*.vhevidence-license.json` the existing `verifyLicense` gate accepts byte-for-byte — so it **UNLOCKS**
`vh evidence seal --sign` (and the > 25-file `evidence_unlimited` surface) end-to-end. The order→license mapping
(`fulfillEvidenceOrder`) is **pure + deterministic**: the same `{ plan, customer, paidThrough, issuedAt }` + the
same catalog yields a **byte-identical** license.

- **The key-source rule.** The vendor key is read **EXACTLY ONE** of `--key-env <VAR>` / `--key-file <path>` and is
  **read-used-discarded** — the **same** posture as `vh evidence seal --sign` / `vh dataset sign`. The loop
  **never holds** a key; **only the PUBLIC vendor address is echoed**, never the key. Neither/both/missing/malformed
  key sources hard-error (exit `2`) with a **key-free** message.
- An **unknown plan**, a `--paid-through` **at or before** `issuedAt`, a **malformed** `--issued`/`--paid-through`,
  or a **malformed `--catalog`** file is a **usage error (exit `2`)** — a named reject, never a silent mis-grant,
  and **no file is written** on failure.
- With `--out <file>` the signed container is written to **that** path (and **only** there — never cwd); without
  `--out` it streams to stdout. `--json` round-trips the public summary (`vendor`, `entitlements`, `issuedAt`,
  `expiresAt`, …) so a webhook handler can script it. Exit: **0** ok / **2** usage (unknown plan, bad
  window/date, bad `--catalog`, key-source error) / **1** IO — `fulfill` is a **producer**: it has **no** exit-3
  "gate-fail" path of its own. The exit-**3** in the evidence family belongs to the **downstream consumer gate**
  (`vh evidence seal --sign` / `verify` / `verify-signed` / `diff`), which is where a webhook handler keys
  retry/alert logic for a *rejected* license — never on `fulfill`, which surfaces a fulfillment reject (typo'd
  plan, bad window) as a named **exit 2**, distinct from a genuine IO fault (**exit 1**).

### The worked flow: `payment-succeeded` webhook → `fulfill` → deliver `*.vhevidence-license.json`

A billing provider's *payment-succeeded / renewed* webhook fires with a `planId` and a paid-through date. The
handler authenticates the webhook signature (the provider's own SDK + the provider's signing secret — a
HUMAN-owned secret the loop **never holds**), then runs **one** `vh evidence license fulfill` call and delivers
the minted license to the paying customer:

```
# Your webhook handler, AFTER authenticating the provider's signature, runs ONE command per sale:
$ vh evidence license fulfill \
    --plan evidence-pro-annual --customer "Acme Co" \
    --paid-through 2027-06-01T00:00:00.000Z \
    --key-env EVIDENCE_VENDOR_KEY \
    --out ./out/acme.vhevidence-license.json
fulfilled evidence license for plan evidence-pro-annual by vendor 0x<evidence-vendor>
  entitlements: evidence_signed, evidence_unlimited
  written:      /abs/out/acme.vhevidence-license.json                          # exit 0

# Deliver acme.vhevidence-license.json to the paying customer. They run the paid surface OFFLINE,
# pinning your PUBLISHED vendor address — no per-sale terminal step for you:
$ vh evidence seal ./bundle --out ./bundle/b.vhevidence.json \
    --sign --key-env ACME_OP_KEY \
    --license ./acme.vhevidence-license.json --vendor 0x<evidence-vendor>     # unlocked by the minted license
```

The per-sale work collapses to **no terminal step per sale**: a renewal re-runs the **same** deterministic
command with a new `--paid-through`, mints a fresh license, and delivers it — the same machine-driven seam a
renewal webhook drives. The loop ships the **catalog + the mapping + the fulfill command + ephemeral test keys**;
**provisioning the vendor key, setting the price/term column, and wiring the actual webhook/billing remain
HUMAN-owned outward steps** (STRATEGY.md › P-7 steps 1–2). NO new human gate is introduced — the fulfillment
command automates the *mechanism* of an existing P-7 step, it does not add one.

## Reference self-serve fulfillment webhook: `vh fulfill-webhook`

The worked flow above still asks the human to **write** the webhook handler — the code that authenticates the
provider's signature, maps the price to a plan, and shells out to `vh evidence license fulfill`. **`vh
fulfill-webhook`** ships **that handler**, tested, as a tiny loopback-only Node-core HTTP server (**ZERO new
dependency**), so the human's **last CODE step becomes a config step**: run it, point your billing provider's
webhook at it, and every paid event delivers a license — no handler to author.

It wires the pure **fulfillment-intake core** ([`cli/core/fulfill-intake.js`](../cli/core/fulfill-intake.js))
to the fulfiller: on each POST it runs `verifyProviderSignature` → `parseEvidenceEvent` →
`normalizeEvidenceEvent` → `fulfillEvidenceOrder` → `evidence.buildLicense`, reusing every seam **verbatim**.

```
vh fulfill-webhook [--port <n>] [--host <h>] [--max-body <bytes>] [--tolerance <sec>] \
                   --secret-env <VAR> --binding <file> (--key-env <VAR> | --key-file <p>) \
                   --out <dir> [--catalog <file>]
```

- **`--secret-env <VAR>`** — the env var holding the provider's **webhook signing secret** (the HMAC key it
  signs each delivery with). Read from `process.env[VAR]`; **never written to disk or logs**.
- **`--binding <file>`** — a validated **price→plan binding** (`kind: vh-evidence-price-binding`) mapping each
  `(provider, priceId)` onto one of **your** evidence `planId`s. An unmapped price is a NAMED **422**, never a
  silent default plan.
- **`--key-env <VAR>` | `--key-file <p>`** — **EXACTLY ONE**: the **vendor signing key**. It is
  read-used-**held-in-memory** to sign each delivered license and is **NEVER written to disk or logs** (the
  same `loadSigningWallet` read the sign path uses; the loop sets **no price**).
- **`--out <dir>`** — an **existing** directory the delivered `*.vhlicense.json` files are written to (**never
  cwd**). Delivery is **idempotent**, keyed on the event, so an at-least-once retry writes **no duplicate**.
- **`--catalog <file>`** — OPTIONAL evidence plan catalog (default: the bundled **DRAFT**). Entitlements are
  copied from the resolved plan **verbatim**.

**On each `POST /fulfill`:** it reads the RAW body (bounded by `--max-body` → **413**), **authenticates** it
with `verifyProviderSignature` (**fail-closed**: an **unsigned** request is **401**, a **malformed** signature
header is **400**, a **forged** signature or **stale/replayed** timestamp is **401** — each with the localized
reason, delivering **NOTHING**), maps its price to a plan via `--binding`, mints the signed license the paid
gate accepts, and **delivers** it. On success it responds **`200 { delivered, licenseId }`**; a **re-delivered
event returns the SAME `licenseId`** (idempotent, no duplicate). An authenticated event that maps to no plan
is **422**. `GET /healthz` → `200 { ok:true }`.

It **binds loopback (127.0.0.1) by default** — a non-loopback interface is not served unless you pass
`--host` — makes **no outbound network request**, holds the vendor key **in memory only**, and writes
**neither the key nor the secret** to disk or logs.

> **Boundary (VERBATIM — read this first).**
>
> The loop ships this reference handler and its OFFLINE tests (a synthetic signing secret and an ephemeral `Wallet.createRandom()` vendor key); provisioning the REAL provider webhook secret, the REAL vendor key, and DEPLOYING the endpoint behind your own URL/TLS remain the human-owned steps.
>
> A delivered license is an ACCESS credential for delivered software value — NOT a token/coin/NFT, and not tradeable.

## Going to market

Standing up the evidence vendor keypair, the price, and the first design partner are **human steps** —
see **P-7 (needs-human)** in [Human-owned steps](TRUST-BOUNDARIES.md#p-6-p-7-licensing). The loop builds and locally tests; it never
holds a vendor key, never sets a price, and never deploys.


---
<sub>© 2026 verifyhash.com · Licensed under Apache-2.0 (SPDX-License-Identifier: Apache-2.0) — see the [LICENSE](https://verifyhash.com/LICENSE) and [NOTICE](https://verifyhash.com/NOTICE) served with this file.</sub>

# Licensing — decision record

**Status: DECIDED (Apache-2.0, repo-wide) — 2026-06-26. The paid-surface source-available split is DEFERRED (needs counsel).**

## What is in force now

The entire repository is licensed under **Apache License 2.0** (`LICENSE` + `NOTICE`).
`package.json` (root and `verifier/`) declares `"license": "Apache-2.0"`, and the Solidity
files carry `SPDX-License-Identifier: Apache-2.0`.

### Why Apache-2.0 (not bare MIT, not proprietary)

- The prior state was `"license": "MIT"` in `package.json` with **no LICENSE file at all** — a gap.
- Apache-2.0 is permissive like MIT but additionally grants an explicit **patent license** and
  reserves **trademark/brand** rights — both valuable for a crypto/provenance product and a named
  brand ("verifyhash").
- It **keeps the trust pitch intact**: the standalone verifier (`verifier/`, published on
  verifyhash.com) is *meant* to be freely downloaded, audited, and **reproduced from source**.
  A permissive license is what makes "don't trust us — rebuild it yourself" legally true.
- Fully-proprietary / all-rights-reserved was rejected: it would contradict the already-shipped
  permissive metadata and the public invitation to redistribute the verifier, and gut the trust story.

### The moat is not source secrecy

Even fully open, the business stays defensible. The real moat is:
1. the **vendor signing key** — only the holder can mint valid seals / entitlements;
2. the **brand** ("verifyhash") — reserved by the trademark clause above;
3. the **customer relationship** and the **hosted/paid entitlement** service.
A code license gives none of those away.

## Deferred — needs human + counsel (do NOT auto-apply)

A **source-available split** remains a future option: keep the verifier + spec/conformance +
on-chain contracts + free CLI verbs under Apache-2.0, and move the **paid** producer/sealing path,
`trustledger/*`, and the evidence paid cores under a source-available license (e.g. **BSL 1.1** with
a chosen Change Date / Change License / Additional Use Grant, or **PolyForm Noncommercial** for a
permanent non-commercial line) to block commercial resale while staying auditable.

This requires business/legal decisions (license choice, BSL parameters, confirming no inbound
third-party code blocks relicensing) and is left as a human/counsel decision. Nothing about the split
has been applied.

## Note on the product's "license" feature

The `*.vhlicense.json` entitlement (`cli/core/license.js`, `trustledger/license.js`) is a signed,
offline-verifiable **paid-tier access credential** — unrelated to this copyright license.
It is an ACCESS credential only: never a token/coin/NFT, never tradeable, never an appreciating asset.

## Paid-gate vendor pinning (T-75.3) — the canonical vendor identity

The paid surfaces — `vh evidence seal --sign`, sealing beyond the free sample via
`evidence_unlimited`, `vh agent seal --sign`, the **TrustLedger reconcile / value-proof gate**
(`vh trust reconcile --state/--policy/--seal`), and the **hosted TrustLedger web door** (`vh trust
serve`, `POST /api/reconcile`) — verify the supplied license **against a CANONICAL vendor identity that
is a committed constant**, not against a caller-supplied address:

- The committed identity is the **published verifyhash vendor address**
  `0x7cb4d3DC6C52996B6386473Bfb32f898263412f7` (single source:
  [`cli/core/vendor-identity.js`](../cli/core/vendor-identity.js); it matches the signed identity card
  at [`identity/verifyhash-evidence.vhidentity.json`](../identity/verifyhash-evidence.vhidentity.json)).
- **`--vendor` cannot re-pin the gate.** It is still accepted as an explicit assertion, but it must
  EQUAL the canonical identity; a mismatch is a named usage refusal. Before this change the gate
  verified against whatever `--vendor` the caller passed, so anyone could self-mint a license with
  their own key and unlock the paid surface for free (a revenue-only leak — not impersonation: their
  seals were still signed by their own key). A license minted by any non-canonical key is the named
  `wrong_issuer` reject.
- The **read-only inspection verb** (`vh trust license verify <file> --vendor <addr>`) keeps its
  explicit caller pin: it answers "did THIS key sign it?" and unlocks nothing.
- The **TrustLedger gates are pinned too (T-75.3).** Both the CLI reconcile/value-proof gate
  (`trustledger/cli.js` → `gateReconcile`) and the hosted web door (`trustledger/door-core.js` →
  `gatePayload`, reached by `vh trust serve` / `POST /api/reconcile`) now resolve the pin via
  `trustledger/license.js` → `resolveVendorPin` **outside** any caller channel — `--vendor` on the CLI
  and `vendorAddress` in the request body are optional assertions that must EQUAL the canonical identity,
  and the web door resolves its canonical identity **server-side** (never from the request body), closing
  the textbook "free-ride a hosted vendor" leak. A license minted by any non-canonical key is the named
  `wrong_issuer` reject.
- The **offline verify path for already-signed packets** (`vh evidence verify` / `verify-signed`,
  `verify-vh`) is untouched: it never consults the canonical pin.

### Self-hosting — an honest boundary, not DRM

This repo is Apache-2.0, so the gate makes **no DRM claim**: an operator running their **own**
instance legitimately sets their **own** canonical vendor identity, and their own licenses then unlock
their own instance. Three equivalent ways, in precedence order:

1. **Programmatic** — pass `io.canonicalVendor` to the run functions (what `go-live-preflight` uses to
   validate an operator's own key end-to-end; not reachable from argv). For the hosted TrustLedger door,
   pass `createServer({ canonicalVendor })`.
2. **Config** — export `VH_CANONICAL_VENDOR=0xYourVendorAddress` for the CLI **and** the `vh trust serve`
   web door (both resolve the pin through the same precedence: programmatic seam > `VH_CANONICAL_VENDOR` >
   committed default).
3. **Fork** — edit the constant in `cli/core/vendor-identity.js`.

An operator running their **own** TrustLedger instance (self-hosted CLI or web door) sets their **own**
canonical vendor constant this way — this is a gate against free-riding a **hosted** vendor's paid
surface, **not** a DRM claim.

What the pin actually protects is the **hosted vendor's paid surface in the shipped default**: a
self-minted license no longer unlocks the stock build. An operator who re-points the identity is
running *their* instance — their artifacts and licenses no longer verify against the published
verifyhash identity, which is what their downstream verifiers pin (`verify-vh --vendor 0x7cb4…`).

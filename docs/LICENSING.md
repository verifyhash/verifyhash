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

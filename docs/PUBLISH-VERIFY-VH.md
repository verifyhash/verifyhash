# Publish `verify-vh` — the HUMAN checklist (one page)

**Publishing stays human.** The build loop only builds and tests locally — it never runs
`npm publish`, never deploys, never holds registry credentials (STRATEGY.md hard guardrails).
This page is what the human follows when they decide to publish the standalone verifier package.

**Why publish at all.** The front-door line in [docs/ADOPT.md](ADOPT.md) —
`npx --yes verify-vh demo` — **404s until `verify-vh` is published to npm**. Everything else about
that line is already true and machine-tested from the repo; publish is the single missing (human) step.

**The gate that must be green first.** `test/verify-vh.pack.test.js` runs `npm pack` on `verifier/`
(offline), extracts the tarball OUTSIDE the repo, proves the bare tree *cannot* fall back to the
repo's modules, provisions ONLY the one declared dependency (`js-sha3`), and then proves `demo` and
the real `--vendor` verify path work from the extracted tree alone — so a file missing from
`verifier/package.json` `files` fails that suite, not the first stranger's `npx` run.

## Checklist

1. **Gate** (repo root): `npx hardhat test test/verify-vh.pack.test.js` → must be green.
2. **Inspect the shipment** (from `verifier/`): `cd verifier && npm pack --dry-run` — expect
   `verify-vh.js`, `lib/*.js`, `README.md`, `package.json`, and nothing else.
3. **Log in as the human npm account**: `npm whoami` (then `npm login` if needed). The loop holds no
   npm credentials and must never be given any.
4. **Publish from `verifier/` — NOT the repo root** (the root package is `verifyhash`, a different
   surface): `cd verifier && npm publish`. Re-publishing later requires a version bump in
   `verifier/package.json` first (npm rejects a reused version).
5. **Post-publish smoke**, from any directory OUTSIDE this repo (a clean machine is even better):

   ```bash
   npx --yes verify-vh demo
   ```

   Expect exit `0`; the transcript must ACCEPT the genuine packet naming signer
   `0x70997970c51812dc3a010c7d01b50e0d17dc79c8` (the fixed TEST-ONLY hardhat #1 key — never a real
   key), then REJECT the one-byte-tampered copy naming `model-card.md`.
6. **Hands-on smoke** (optional): `npx --yes verify-vh demo ./vh-demo`, then run the verify / tamper /
   restore commands it prints.
7. **If the smoke fails**: `npm deprecate verify-vh@<version> "broken — do not use"`, fix, bump, and
   re-run this checklist from step 1. Never leave a broken version as `latest`.

## The honest boundary (say no more than this, anywhere the package is announced)

The demo proves tamper-evidence + signer-pin, NOT a trusted timestamp, NOT a legal opinion.
A verified packet means: the bytes you hold match what the named signer sealed — nothing about
*when* it was sealed, and nothing about whether the content is true, licensed, or lawful.

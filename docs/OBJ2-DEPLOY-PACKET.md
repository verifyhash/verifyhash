# OBJ-2 Deploy Handoff Packet — verifyhash.com landing rework

**Internal ops doc — NOT served.** This file is deliberately absent from
`site/publish-set.json`; the webroot is assembled from EXACTLY that allowlist, so
this packet can never enter `public/`. It exists to make the off-repo redeploy
(needs-human #13, the P-11 flow in `docs/DEPLOY-PUBLIC-SITE.md`) mechanical and
checkable for the supervisor.

## What changed and why

Task **T-OBJ2.3** healed a source/output drift: the OBJ-2 landing rework
(T-OBJ2.1 mobile-nav fix + T-OBJ2.2 section pages + T-TRUST.2 README edit) had
been hand-applied to the assembled webroot `public/` but never reconciled back
into the committed SOURCE tree. `node scripts/site-release.js --check` was RED
with 10 problems. The fix moved every OBJ-2 page into the source tree and
registered it in the allowlist, so a fresh deterministic assembly now reproduces
the intended `public/` byte-for-byte and a redeploy **preserves** (not erases)
the rework.

Concretely:

- Six new section pages are now committed SOURCES and allowlisted:
  `site/agents.html`, `site/compare.html`, `site/guarantees.html`,
  `site/onchain.html`, `site/pricing.html`, `site/start.html`
  (each mapped in `site/publish-set.json` as `<name>.html <- site/<name>.html`,
  mirroring the existing `index.html` mapping).
- `site/index.html` was updated to carry the T-OBJ2.1 mobile-nav disclosure
  (the `.navtoggle` button + `#primary-nav` + the toggle `<script>`), so the
  source, when assembled, yields the current `public/index.html`.
- `docs/overview.md` (source `README.md`) drift healed automatically by the
  no-flag assembler run.
- `RELEASE-MANIFEST.json` (both the shipped `public/` copy and the committed twin
  `site/RELEASE-MANIFEST.json`) and the generated `site/llms.txt` digest lines
  were regenerated from the single canonical source.

The pinned verifier bundle `public/verify-vh-standalone.html` (and its
`.sha256` sidecar) is UNCHANGED — `verifier/dist/*` was not touched.

## Copy list — published path -> live webroot path

Assembly writes each allowlisted file at `public/<published-path>`; deploy copies
`public/<published-path>` to `<WEBROOT>/<published-path>` (identical relative
paths). The complete, authoritative mapping is `site/publish-set.json`; the
release fingerprint is `RELEASE-MANIFEST.json` (39 files, 1293963 bytes total).

New/changed in this release (the OBJ-2 surface + auto-healed docs):

| published path (public/ -> webroot) | source | bytes | status |
| --- | --- | --- | --- |
| index.html            | site/index.html      | 39306 | CHANGED (mobile nav) |
| agents.html           | site/agents.html     | 22398 | ADDED |
| compare.html          | site/compare.html    | 22832 | ADDED |
| guarantees.html       | site/guarantees.html | 22552 | ADDED |
| onchain.html          | site/onchain.html    | 21714 | ADDED |
| pricing.html          | site/pricing.html    | 22359 | ADDED |
| start.html            | site/start.html      | 23283 | ADDED |
| docs/overview.md      | README.md            | 76249 | CHANGED (T-TRUST.2 README) |
| llms.txt              | site/llms.txt        |  3081 | CHANGED (regenerated digests) |

All other 30 allowlisted files (LICENSE, NOTICE, the verifier/sealer bundles +
sidecars + provenance, and the `docs/*.md` set) are unchanged this release and
are copied as-is. Run `node scripts/site-release.js --diff` for the live-vs-fresh
per-file ADDED/CHANGED/REMOVED/UNCHANGED table against `site/DEPLOYED.json`.

## Before/after sha256 manifest

Authoritative source of truth for the AFTER hashes: `site/RELEASE-MANIFEST.json`
(the committed twin of the shipped `public/RELEASE-MANIFEST.json`; both equal a
fresh assembly). The BEFORE (believed-live) hashes are `site/DEPLOYED.json`.
`--mark-deployed` rewrites the believed-live snapshot AFTER the human uploads.

sha256, before (site/DEPLOYED.json) -> after (site/RELEASE-MANIFEST.json):

```
index.html        795bed232a96da3b93fa92f36daa3e8da3e159f440da72f08409deefb113a1c6
               -> 4240d74f6ac1926c363b03c1473ad39f3d09128f5cebff15214b57425b4d9ac0
agents.html       (not on live site) -> 6a398393113f035c78dc9fa3cfc834a4a0937c11c9a7b886be6ff412b58c85d9
compare.html      (not on live site) -> aba36f2f35eca46457865e465d3dbee1afae7e99a5cc4b359688ebf2ae54af57
guarantees.html   (not on live site) -> 381574efe8fbe837c63955697a9a67d92a19dc3c8f20adf958cb8ea9ed59c8a1
onchain.html      (not on live site) -> f80a83f021170c89e7ebd7edaf6b6ace8cc5b58a71b2a05dc442a8ec0b505ecb
pricing.html      (not on live site) -> dece0f4ab4f005000e1521c3186ee0d5a7c1cdcea1f59b7bba4d797f18801657
start.html        (not on live site) -> 13f33199884f1f4420113abe792562c73f3e5357b813f4b8aa56e2cdab48469e
docs/overview.md  2990c9f6cb50860eec7e23e35c0facc0cb26100c294696b2aca32510397b1743
               -> 99535b0c4a9fb758a7fca3e219211b8ea259d5831cc111426d7f7bcaafa615b6
llms.txt          e484874ff4eb0eaa3e75428b5df29026e719b573de1b28bd66a89b2998b2a521
               -> 9e7e982bca72058f3e3a6b878c1387ca14793fdf9a0fbb9513b602e6c622e89f
```

Note on `site/DEPLOYED.json`: it is the 2026-06-26 baseline snapshot and lags the
publish set by a whole generation (e.g. it records the older live verifier bundle
`ce444165…`, while the current committed pin is `638b05fb…`). That lag is expected
and is exactly what this redeploy closes; it is NOT a change introduced by this
task. The verifier bundle is not rebuilt here — `public/verify-vh-standalone.html`
stays `638b05fb…` (see its `.sha256` sidecar).

## Deploy procedure (human / supervisor — the loop never uploads)

1. From `/home/loopdev/verifyhash`, run `node scripts/site-release.js` to (re)assemble
   `public/`. Confirm `node scripts/site-release.js --check` prints OK.
2. Upload the assembled `public/` tree to the live webroot per
   `docs/DEPLOY-PUBLIC-SITE.md` §3c (copy list above; identical relative paths).
   Do NOT upload `RELEASE-MANIFEST.json`-external files; the webroot is exactly
   the publish set + `RELEASE-MANIFEST.json`.
3. Run the LIVE smoke checklist below.
4. Back in the repo, run `node scripts/site-release.js --mark-deployed` and commit
   `site/DEPLOYED.json` so the next `--diff` is truthful.

## Post-deploy LIVE smoke checklist

Run against the live origin after upload:

- [ ] `GET /` returns 200 (homepage with the reworked nav).
- [ ] `GET /pricing.html` returns 200.
- [ ] `GET /compare.html` returns 200.
- [ ] `GET /guarantees.html` returns 200.
- [ ] `GET /onchain.html` returns 200.
- [ ] `GET /start.html` returns 200.
- [ ] `GET /agents.html` returns 200.
- [ ] At a 390px-wide viewport the homepage shows the hamburger `#navtoggle`
      button, tapping it toggles `aria-expanded` and reveals `#primary-nav`, and
      tapping a nav link collapses it (the T-OBJ2.1 mobile-nav behaviour).
- [ ] The homepage `/einvoice/` cross-links (header nav "E-invoice ↗", the hero
      "Validate an e-invoice — EN 16931 / XRechnung ↗" button, and the footer
      "E-invoice") each resolve live to the deployed `/einvoice/` surface.
- [ ] The served `verify-vh-standalone.html` sha256 equals the committed
      `public/verify-vh-standalone.html.sha256`
      (`638b05fbffda98599ae82c959891affa78bec52928d2946ab5193cd3929cd924`) —
      the pinned bundle is byte-identical live. Verify with:
      `curl -s https://verifyhash.com/verify-vh-standalone.html | sha256sum`.

If any check fails, do NOT run `--mark-deployed` (it would record a broken/
self-contradicting release as live) — re-upload or roll back first.

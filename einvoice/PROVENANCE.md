# Provenance — `verifyhash-einvoice`

A one-page provenance summary. The full supply-chain / security write-up for
evaluators lives in [`SECURITY.md`](SECURITY.md); this file is the quick,
at-a-glance record of *what artifact this is and where its parts come from*.

| Field | Value |
| --- | --- |
| Package | `verifyhash-einvoice` (the pure-Python `einvoice` package) |
| Version | `0.1.0` (source of truth: [`pyproject.toml`](pyproject.toml)) |
| PURL | `pkg:pypi/verifyhash-einvoice@0.1.0` |
| License | Apache-2.0 |
| Runtime dependencies | **none** — Python 3 (>=3.8) stdlib only (`dependencies = []`) |
| SBOM | [`sbom/bom.json`](sbom/bom.json), **CycloneDX 1.5** JSON (<https://cyclonedx.org/docs/1.5/json/>) |
| SBOM generator | [`gen_sbom.py`](gen_sbom.py) — stdlib only, no network, deterministic output |
| Distribution | source checkout / vendored copy — **not published to PyPI** |

## Rule corpus provenance

The validation rules are built and differential-tested against Schematron
corpora that are **vendored and version-pinned** in this repo (never fetched
at runtime):

- EN 16931 Schematron — `ConnectingEurope/eInvoicing-EN16931` (EUPL-1.2),
  `corpus/cen-en16931/`.
- XRechnung Schematron v2.5.0 — `itplr-kosit/xrechnung-schematron` (Apache-2.0),
  `corpus/xrechnung-schematron/`.
- XRechnung test suite — `itplr-kosit/xrechnung-testsuite` (Apache-2.0),
  `corpus/xrechnung-testsuite/`.

## Keeping this current

```sh
python3 gen_sbom.py            # regenerate sbom/bom.json from pyproject.toml
python3 gen_sbom.py --check    # CI drift guard: non-zero if the SBOM is stale
python3 test_sbom.py           # asserts SBOM shape + zero-deps + pyproject agreement
```

## Currency audit — 2026-07-16

A measure-first check of every vendored Schematron/testsuite corpus against its
upstream origin, done with anonymous public `GET` requests to the GitHub
releases/tags API (`api.github.com/repos/<owner>/<repo>/releases/latest` and
`/tags`) — no auth, no fetch-into-build. Result this run: **every artifact is
already pinned to its latest official upstream release, so this is a documented
no-op** (nothing bumped, nothing un-pinned). Numbers below reflect what is
actually vendored and what upstream currently publishes.

| Artifact | Repo / license | Vendored pin | Latest upstream tag (observed) | Newer? | Decision |
| --- | --- | --- | --- | --- | --- |
| XRechnung Schematron | `itplr-kosit/xrechnung-schematron`, Apache-2.0 | `v2.5.0` (asset `xrechnung-3.0.2-schematron-2.5.0.zip`, XRechnung 3.0.2) | `v2.5.0` (releases/latest, published 2026-02-05) | no | **No vendor** — already current. Keep pin `v2.5.0`. |
| XRechnung testsuite | `itplr-kosit/xrechnung-testsuite`, Apache-2.0 | `2026-01-31` (CHANGELOG top released section; compatible with XRechnung 3.0.x) | `v2026-01-31` (releases/latest, published 2026-02-05) | no | **No vendor** — already current. Keep pin `2026-01-31`. |
| CEN EN 16931 Schematron | `ConnectingEurope/eInvoicing-EN16931`, EUPL-1.2 | `1.3.16` (`corpus/cen-en16931/{ubl,cii}/schematron/*.sch`) | `validation-1.3.16` (releases/latest, published 2026-04-13) | no | **No vendor** — already current. Keep pin `1.3.16`. |

Notes:

- No newer official release exists for any artifact as of the audit date, so no
  bump was performed and no license re-check was needed (Apache-2.0 and EUPL-1.2
  remain compatible with this repo's Apache-2.0). No artifact was un-pinned.
- The testsuite working tree carries an `UNRELEASED` CHANGELOG placeholder and a
  `2026-07-31-SNAPSHOT` dev version in `build.xml`; those are upstream's
  in-progress dev markers, **not** a published release, so they are correctly
  ignored — the newest *released* tag is `v2026-01-31`, which is what we vendor.
- Post-audit verification on the unchanged corpus: `test_xrechnung.py` (71 OK),
  `test_packaging.py` (18 OK, 1 skip), `conformance.py` (PASS), and
  `differential.py` (**0 divergences across all legs**) all stayed green.
- Next audit action is only warranted when `releases/latest` for one of the three
  repos advances past the pins above; at that point vendor the new tag pinned
  with a sha256 checksum and regenerate `COVERAGE.md` from the fresh corpus.

## Honest scope

This covers the **einvoice Python package only** — not the separate
`verifyhash` / `verify-vh` npm packages. The SBOM is an auditable dependency
inventory, **not** a signed attestation; publishing and any cryptographic
signing are deliberate human/supervisor steps. No attestation, reproducible-build
claim, or third-party audit is asserted here.

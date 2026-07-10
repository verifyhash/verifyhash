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

## Honest scope

This covers the **einvoice Python package only** — not the separate
`verifyhash` / `verify-vh` npm packages. The SBOM is an auditable dependency
inventory, **not** a signed attestation; publishing and any cryptographic
signing are deliberate human/supervisor steps. No attestation, reproducible-build
claim, or third-party audit is asserted here.

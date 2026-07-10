# Security, provenance & supply chain — `verifyhash-einvoice`

This note is for a B2B evaluator deciding whether to embed the einvoice
validator inside their product or run it in their own infrastructure. It
describes the supply-chain posture of **one artifact only**: the
`verifyhash-einvoice` Python package (the pure-Python `einvoice` package
declared in [`pyproject.toml`](pyproject.toml)). It does **not** cover the
separate `verifyhash` / `verify-vh` npm packages elsewhere in this repo — those
have their own toolchain and are out of scope here.

## Zero third-party runtime dependencies

The package imports the Python **standard library only**. Its
`pyproject.toml` declares `dependencies = []`, and that emptiness is a
contract, not an accident:

- **`test_packaging.py`** asserts `dependencies` stays `[]` and that the
  package installs and validates an invoice from a clean temp directory with
  no corpus and no repo present.
- The committed **CycloneDX 1.5** SBOM at [`sbom/bom.json`](sbom/bom.json)
  records the same fact in machine-readable form: its `components` array is
  empty and the root component's dependency edge (`dependencies[0].dependsOn`)
  is empty. **`test_sbom.py`** cross-checks the SBOM against
  `pyproject.toml` so the two sources cannot silently diverge, and runs
  `gen_sbom.py --check` to guarantee the committed SBOM is not stale.

Zero runtime dependencies means there is no transitive dependency tree to
audit, no third-party package that can be yanked or compromised upstream, and
no version-resolution surprise at install time.

## Software Bill of Materials (SBOM)

The SBOM is emitted in the **CycloneDX 1.5** JSON format — the OWASP
CycloneDX standard, schema published at
<https://cyclonedx.org/docs/1.5/json/> — by the zero-dependency generator
[`gen_sbom.py`](gen_sbom.py) (Python stdlib only; no network access at any
point). It reads `name`, `version` and `dependencies` from `pyproject.toml`
and writes `sbom/bom.json`. Run:

```sh
python3 gen_sbom.py            # (re)generate sbom/bom.json
python3 gen_sbom.py --check    # exit non-zero if the committed SBOM is stale
```

The output is **deterministic** — no wall-clock timestamp is embedded — so the
`--check` drift guard is stable and can run in CI. Honesty note: the SBOM
describes the *source package's declared dependencies*. It is not a signed
attestation and does not by itself prove the bytes you received match this
repo; treat it as an auditable inventory, not a cryptographic guarantee.

## Vendored, pinned rule corpus

The validation rules are derived from Schematron corpora that are **vendored
into the repository and pinned to specific upstream versions** rather than
fetched at runtime:

- EN 16931 corpus & Schematron — `ConnectingEurope/eInvoicing-EN16931`
  (EUPL-1.2), under `corpus/cen-en16931/`.
- XRechnung Schematron v2.5.0 (XRechnung 3.0.2) —
  `itplr-kosit/xrechnung-schematron` (Apache-2.0), under
  `corpus/xrechnung-schematron/` (see its `VENDORED.md`).
- XRechnung test suite — `itplr-kosit/xrechnung-testsuite` (Apache-2.0),
  under `corpus/xrechnung-testsuite/`.

The corpus is used to **build and differential-test** the rules; the shipped
wheel contains only the pure-Python `einvoice` package, not the corpus (see
`[tool.setuptools] packages = ["einvoice"]`).

## Offline / air-gappable

The validator makes **no network calls** — no schema downloads, no telemetry,
no license phone-home. It runs fully offline and is safe to deploy in an
air-gapped environment. `gen_sbom.py` is likewise offline.

## Deterministic, auditable output

Given the same invoice and profile, the validator produces the same result;
the machine-readable report is a versioned JSON contract documented in
[`REPORT-SCHEMA.md`](REPORT-SCHEMA.md). Every rule quotes its source
Schematron text verbatim (see [`CORRECTNESS.md`](CORRECTNESS.md)), so a
finding can be traced back to the standard it comes from.

## Install from a source checkout

There is **no PyPI release** — publishing (and any signing) is a deliberate
human/supervisor step, not something this package does for itself. Install
from a checkout or a vendored copy:

```sh
python3 -m pip install /path/to/einvoice
```

## Reporting an issue

This is an early-slice project without a formal disclosure process yet. If you
find a correctness or security problem, open an issue on the source repository
(`github.com/verifyhash/verifyhash`) describing the input and the observed vs.
expected behaviour.

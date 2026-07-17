# Changelog

All notable changes to the `verifyhash-einvoice` conformance validator are
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions here are the single source of truth together with
`einvoice/pyproject.toml` and `einvoice/einvoice/__init__.py`
(`__version__`); `test_release_discipline.py` fails the build if the three
ever diverge.

> Note: `verifyhash-einvoice` is **not** yet published to PyPI — publishing is
> a deliberate human-gated step (see `REPUBLISH-PYPI.md`). Install it from a
> checkout or vendored copy. The `0.1.0` section below records what the current
> tree actually ships, not a PyPI release event.

## [0.1.0] - 2026-07-07

First packaged slice of the zero-dependency EN 16931 / XRechnung e-invoice
conformance validator. Standard library only — `dependencies = []` in
`pyproject.toml` is an enforced contract (`test_packaging.py`), so the tool
installs and runs anywhere Python 3.8+ runs, with no supply chain to audit.

### Added

- **EN 16931 + XRechnung (CIUS) conformance validation.** Validates the
  business-rule layer of an invoice against the implemented subset: 50 of the
  ~200 EN 16931 core rules plus the 32 national `BR-DE-*` XRechnung asserts.
  Each implemented rule is differential-tested to 100% agreement with the
  official Schematron *within that subset* — the not-yet-implemented families
  (`BR-DEX-*`, `BR-DE-CVD-*`) are declared open rather than silently passed
  (see `CORRECTNESS.md`).
- **Both EN 16931 syntaxes.** Accepts UBL (`Invoice`, `CreditNote`) and
  CII (`CrossIndustryInvoice`) documents. The syntax-binding coverage is
  measured and pinned: 741/756 UBL and 554/583 CII bindings proven against the
  official test material (`einvoice info --json` reports the live numbers).
- **Credit notes.** UBL `CreditNote` and CII invoices carrying BT-3 document
  TypeCode `381` (Gutschrift) are validated under the credit-note scope rather
  than rejected as unknown document types.
- **Machine-readable report formats.** One validation, many outputs:
  `json`, `junit`, `sarif`, `github` (workflow annotations), `gitlab`
  (Code Quality), `azure`, `html`, `badge`, and human `text`. Every emitter is
  fuzz-tested to be total and well-formed over any validation result
  (`test_fuzz_report_formats.py`).
- **Stable exit-code contract.** `0` = valid, `1` = business-rule violations,
  `2` = usage error, `3` = input/OS error (unreadable file, malformed XML,
  unsupported container). Documented in `EXIT-CODES.md` and enforced by
  `test_exit_codes.py`, so CI can branch on the outcome without scraping text.
- **`--fail-on` severity threshold.** Choose the severity that turns a run red
  (e.g. warn vs. error) via CLI flag, config, or the `fails_at` public API.
- **Batch validation.** Validate many invoices in one invocation with an
  aggregate report; results are order-independent
  (`test_idempotence.py`).
- **PDF / Factur-X container handling.** Extracts and validates the embedded
  XML from a Factur-X / ZUGFeRD PDF container; unsupported or truncated
  containers exit `3` with a clear message rather than crashing
  (`test_pdf_container.py`, `test_fuzz_pdf_container.py`).
- **Byte-stable attestation and conformance receipt.** `gen_attestation.py`
  emits a deterministic, byte-reproducible `attestation.json`, and the
  conformance receipt is golden-pinned across both syntaxes and the CII-381
  credit note — the tamper-evidence bridge back into the verifyhash product.
- **Stable embedding API.** Eight public names
  (`validate`, `validate_file`, `validate_root`, `validate_batch`,
  `fails_at`, `capabilities`, `Result`, `NotWellFormed`) are frozen and
  drift-guarded (`api_contract.json`, `test_api_contract.py`) for use as a
  library inside a Python test suite or an ERP/billing pipeline.
- **`einvoice info` introspection.** Read-only subcommand reporting the build's
  version, profiles, formats, rule count, and coverage as human text or
  `--json`, every field sourced from asserted artifacts.
- **Config file support.** `[tool.einvoice]` defaults for `format`,
  `fail-on`, and `lang` in `pyproject.toml`, with documented flag-over-config
  precedence (`test_config_file.py`).
- **Deterministic, network-free operation.** No outbound network access at
  any point (socket-layer guard, `test_network_egress.py`); output is
  invariant to locale, timezone, working directory, and input filename.
- **Packaged as an embeddable wheel.** One console script (`einvoice`), a
  `py.typed` marker for downstream type checkers, and a build that ships only
  the pure-Python package (the rule corpus and test vectors stay in the repo).

[0.1.0]: https://github.com/verifyhash/verifyhash

# `einvoice` (package)

Zero-dependency, standard-library-only validator for **EN 16931** electronic
invoices with the German **XRechnung** CIUS layer. This directory is the
importable/vendorable Python package; project-level docs, the honest coverage
table, and the CI recipes live one level up in
[`../README.md`](../README.md) and [`../SPEC.md`](../SPEC.md).

## Modules

- `validate.py` — orchestration + the public `validate_file(path, profile)` /
  `validate_root(root, profile)` API and the `Result` type. This is the single
  source of rule truth; everything else consumes it.
- `parser.py` / `parser_cii.py` — well-formedness parsing and the UBL/CII
  document model (`NotWellFormed` is raised on non-well-formed input).
- `rules.py` — the EN 16931 core business rules (BR-\*, S-\*).
- `rules_xrechnung.py` — the German national CIUS layer (BR-DE-\*).
- `cli.py` / `__main__.py` — the `einvoice validate|receipt` command line
  (`python3 -m einvoice ...`).
- `receipt.py` — canonical, byte-stable JSON conformance receipt.
- `report.py` — the machine-readable **CI conformance report**
  (`python3 -m einvoice.report`): a versioned JSON projection of `validate`,
  with a stable exit-code contract for build gates. Its full field-by-field,
  versioned schema is documented in
  [`../REPORT-SCHEMA.md`](../REPORT-SCHEMA.md) and mirrored in the
  `REPORT_SCHEMA` constant of `report.py`.

## Guarantees

Standard library only, offline. `report.py` and `receipt.py` add **no** rule
logic — they reuse `validate.py` verbatim so a document's verdict is identical
across every entry point.

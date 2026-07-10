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
  `REPORT_SCHEMA` constant of `report.py`. It also carries a standalone
  **`--explain <RULE-ID>`** mode (see below) and accepts **Factur-X/ZUGFeRD
  PDFs** directly (see below).
- `pdf_container.py` — zero-dependency extractor for the embedded e-invoice XML
  inside a Factur-X / ZUGFeRD / CII-XRechnung PDF (see below).

### Factur-X / ZUGFeRD PDF input (`report.py` + `pdf_container.py`)

`python3 -m einvoice.report invoice.pdf` also accepts a **hybrid PDF**. A PDF is
detected by its `%PDF-` magic bytes (never by extension); its embedded
CrossIndustryInvoice XML attachment (`factur-x.xml`, `zugferd-invoice.xml`,
`xrechnung.xml`, or the legacy `ZUGFeRD-invoice.xml`, matched case-insensitively)
is extracted zero-dependency and fed into the **same** CII parser + rule engine,
so the verdict and fired rule ids are identical to validating that
`factur-x.xml` on its own.

**What is extracted** (provenance: PDF 32000-1:2008 §7.7/§7.9/§7.11 for the
`/Names` → `/EmbeddedFiles` name tree, file specification and embedded-file
streams; Factur-X 1.x / ZUGFeRD 2.x + PDF/A-3 / ISO 19005-3 for the attachment
naming and `/AFRelationship`): the document catalog's `/Names` →
`/EmbeddedFiles` tree is walked (`/Kids` and `/Names` node shapes), the matching
file spec's `/EF` → `/F` (or `/UF`) reference is followed to the embedded-file
stream, and the stream is inflated with stdlib `zlib` (`/FlateDecode`) or read
raw (no filter).

**Container-declaration checks (`FX-CONTAINER-*`).** On top of extraction, the
report layers the ZUGFeRD/Factur-X container-declaration checks the official
UN/CEFACT CII Schematron does **not** cover, each emitted as a first-class
**warning** finding with a stable id (provenance: ZUGFeRD 2.x / Factur-X 1.x
technical spec + PDF 32000-1 §7.11.3 file specification / §7.11.4 embedded files
/ §7.7.2 catalog `/AF`):

- **`FX-CONTAINER-AFRELATIONSHIP`** — the invoice file spec's `/AFRelationship`
  is absent or is not `/Data` or `/Alternative`.
- **`FX-CONTAINER-AF`** — the invoice file spec is not listed in the catalog's
  `/AF` associated-files array (the embedded invoice is not an associated file).
- **`FX-CONTAINER-XMP`** — the document `/Metadata` XMP stream is absent,
  unreachable, or declares no Factur-X/ZUGFeRD `ConformanceLevel` in a
  `urn:factur-x`/`urn:zugferd` namespace (the "undeclared" case — never a false
  pass). XMP is parsed with stdlib `re` only, no new dependency.
- **`FX-CONTAINER-PROFILE`** — the XMP-declared `ConformanceLevel` and the CII
  `CustomizationID` (BT-24) map to **different** profiles (e.g. XMP says
  `EN 16931` but the XML CustomizationID is BASIC).

These are advisory: the authoritative EN 16931 / XRechnung verdict is still
decided by the rule engine on the embedded XML, so a wrong container declaration
is reported **without** flipping `valid`. On the plain-XML path these ids never
appear, so every existing JSON/text/JUnit/SARIF/HTML/badge contract is unchanged.

**What is _not_ done — this is a container-XML extractor plus the four
declaration checks above, NOT a PDF/A-3 or typographic validator.** The
`/AF` and XMP checks inspect only the *declarations* (is the relationship right,
is the profile string consistent); they do **not** verify PDF/A-3 Level A/B/U
conformance, font embedding, colour spaces, the output intent, digital
signatures, or that the rendered page matches the XML. Encrypted PDFs
(`/Encrypt`), cross-reference-stream / object-stream PDFs (PDF 1.5+), a
missing/empty `/EmbeddedFiles` tree, and any filter chain other than a single
`/FlateDecode` are **refused** with an explicit `error:"unsupported-container"`,
`valid:false` report and a non-zero exit — never a false pass and never a
traceback. The exact IS/IS-NOT contract lives in the `pdf_container.py` module
docstring.

### `report.py --explain <RULE-ID>` — remediation lookup

`python3 -m einvoice.report --explain BR-DE-15` prints the remediation-catalog
entry for a single rule id as a plain-text block and exits `0`. It is a pure
lookup: it reads no invoice file, needs no argument beyond the rule id, and is
**not** combinable with `--format`/`--baseline` (those are output-shape flags
for the report mode; combining them is a usage error). Every printed field —
title, what the rule requires, the BT/BG business terms it touches, the XML
location hint, the one-line fix, the engine severity and the Schematron
provenance — is taken verbatim from
[`../remediation_catalog.json`](../remediation_catalog.json) (the single
source of remediation truth; nothing is authored at print time). Rule ids are
matched case-insensitively against the catalog keys (e.g. `BR-01`, `BR-DE-15`,
`BR-DE-23-a`) and the canonical key is echoed back. An unknown id writes a
clear error naming the id to stderr and exits non-zero.

```
$ python3 -m einvoice.report --explain BR-DE-15
BR-DE-15  Buyer reference (BT-10) must be transmitted (non-empty).

  requires : Buyer reference (BT-10) must be transmitted (non-empty).
  BT/BG    : BT-10
  location : cbc:BuyerReference
  fix      : Add the required element at `cbc:BuyerReference`: ...
  severity : fatal
  source   : xrechnung-ubl (Schematron)
```

## Guarantees

Standard library only, offline. `report.py` and `receipt.py` add **no** rule
logic — they reuse `validate.py` verbatim so a document's verdict is identical
across every entry point.

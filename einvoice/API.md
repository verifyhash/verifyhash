# Embed einvoice as a library

`einvoice` is a zero-dependency, standard-library-only EN 16931 / XRechnung UBL
Invoice validator. Besides the `einvoice validate ...` command line, it exposes
a small, stable **Python embedding API** you can call directly from your own
code — a web upload handler, a message-queue consumer, a batch job, a test.

This document pins that contract: the exact names you may depend on, the shape
of what they return, and the stability guarantee around them.

## The 60-second example

```python
import io
import einvoice

# An EN 16931 UBL invoice you already have in memory as raw bytes. In your app
# this is whatever you received: an HTTP upload, a queue message, a file you
# read yourself. Here we read one of the project's known-good corpus invoices.
with open("corpus/xrechnung-testsuite/src/test/business-cases/"
          "standard/01.01a-INVOICE_ubl.xml", "rb") as fh:
    payload = fh.read()          # -> bytes

# validate_file() accepts a filesystem path OR any binary file-like object
# (anything with .read()), so bytes validate without a temp file.
result = einvoice.validate_file(io.BytesIO(payload), profile="en16931")

print("valid:", result.valid, "  violations:", len(result.violations))
for v in result.violations:
    line = "" if v.source_line is None else " (line %d)" % v.source_line
    print("  %s [%s] %s%s" % (v.rule_id, v.severity, v.message, line))
```

For the clean invoice above this prints `valid: True   violations: 0`.

Break the invoice — drop its invoice number (`BT-1`) — and the same code reports
the failing rule:

```python
broken = payload.replace(b"<cbc:ID>", b"<cbc:XX>", 1).replace(b"</cbc:ID>",
                                                              b"</cbc:XX>", 1)
result = einvoice.validate_file(io.BytesIO(broken), profile="en16931")

assert result.valid is False
assert any(v.rule_id == "BR-02" for v in result.violations)
# -> BR-02 [fatal] An Invoice shall have an Invoice number (BT-1).
```

Malformed XML (as opposed to a well-formed invoice that breaks a rule) raises
`NotWellFormed` — catch it to distinguish "not even XML" from "invalid invoice":

```python
try:
    einvoice.validate_file(io.BytesIO(b"<Invoice><broken"))
except einvoice.NotWellFormed as exc:
    print("not well-formed:", exc)   # e.g. "unclosed token: line 1, column 9"
```

If you already have a parsed UBL root (for example from
`einvoice.parser.parse_file(...)`), skip the parse step and call
`einvoice.validate_root(root, profile="xrechnung")` instead — it takes the
element and returns the same `Result`.

## The public API

Exactly eight names make up the supported surface. They are re-exported at the
package top level and listed in `einvoice.__all__`:

| Name | Kind | What it is |
| --- | --- | --- |
| `einvoice.validate` | module | The validation orchestration module (houses the two callables and `Result`). |
| `einvoice.validate_file(path_or_buffer, profile="en16931")` | function | Parse a path **or** a binary file-like/bytes buffer and validate it. Returns `Result`. Raises `NotWellFormed` on malformed XML. |
| `einvoice.validate_root(root, profile="en16931")` | function | Validate an already-parsed UBL `Invoice` element. Returns `Result`. Raises `ValueError` on an unknown profile. |
| `einvoice.Result` | class | The validation outcome (see below). |
| `einvoice.NotWellFormed` | exception | Raised by `validate_file` when the input is not well-formed XML. |
| `einvoice.validate_batch(paths, profile="xrechnung")` | function | Validate a list of invoice files; returns the aggregate batch report `dict` — the same engine and shape as `einvoice validate-batch --json`. |
| `einvoice.fails_at(result, level)` | function | The CLI `--fail-on` severity threshold as a pure predicate over a `Result`. Returns `bool`. Raises `ValueError` on an unknown level. |
| `einvoice.capabilities()` | function | What this build contains, as a `dict` — the exact `einvoice info --json` payload. |

`profile` is `"en16931"` (the EN 16931 core rules only) or `"xrechnung"` (the
core rules plus the German CIUS layer, `BR-DE-*`).

### The `Result` shape

`validate_file` and `validate_root` both return a `Result`:

- **`result.valid`** — `bool`. `True` iff the document has **no `fatal`
  violation**. This follows the official Schematron `flag` semantics: `warning`
  and `information` findings (which only the `xrechnung` profile emits) are
  reported but do **not** make `valid` false. `result.ok` is a back-compat
  alias of `result.valid`.
- **`result.violations`** — a `list`, in evaluation order. Each entry is a
  `Violation` namedtuple with these fields:
  - `rule_id` — the rule identifier, e.g. `"BR-02"`, `"BR-DE-15"`.
  - `message` — the human-readable failure text.
  - `element` — the offending element/local name (may be `None` for a
    document-level or absence finding).
  - `severity` — `"fatal"`, `"warning"`, or `"information"`.
  - `source_line` — the 1-based line of the offending element in the source
    XML, or `None` when no concrete element position was proven (added by
    T-VHDIAG.1). It is genuinely optional: absence/document-level findings
    carry `None`.
- **`result.first`** — the first `Violation`, or `None` when the list is empty.
- **`result.to_dict(source=None)`** — the same result as the machine-readable
  JSON record: `{"source", "valid", "violation_count", "violations"}`, where
  each violation is a dict `{"rule", "message", "element", "severity"}` plus
  `"source_line"` **only when it is present**. This is the shape the
  `einvoice validate --json` CLI and `einvoice.report` emit.

## Batch validation, severity gating, and build introspection

The three CLI capabilities you most often want in code — batch validation,
the `--fail-on` severity gate, and `einvoice info` — are exported as thin
wrappers over the exact code paths the CLI runs, so the library and the
command line can never disagree (`test_api_embed.py` proves the equivalence
against the live CLI on every run).

### `einvoice.validate_batch(paths, profile="xrechnung") -> dict`

Validate every file in `paths` (an iterable of paths, in the order given —
pass a sorted list for deterministic output) and return the same aggregate
document `einvoice validate-batch --json` prints, schema
`einvoice-conformance-batch/v1`. Its stable fields:

- **`schema`**, **`report_version`** — the batch schema id and version.
- **`profile`** — the profile every file was validated under.
- **`root`** — the batch label. The CLI records the directory or glob here;
  `validate_batch` records `None` (you supplied an explicit list).
- **`file_count`** — how many files were validated.
- **`fatal_count`** / **`warning_count`** / **`violation_count`** — finding
  totals summed across all files.
- **`failed_file_count`** — files that errored (e.g. not well-formed) OR have
  at least one fatal finding.
- **`files`** — one single-file report dict per input, in order, each
  byte-identical to validating that file alone: `source`, `valid`,
  `fatal_count`, `warning_count`, `violation_count`, `violations` (and an
  `error` string instead of findings when the file could not be parsed —
  a hostile-DOCTYPE or truncated file becomes an ERROR entry, never a crash).
- **`note`** — only present when `paths` was empty (`file_count == 0`):
  `"no invoice files found"`. An empty batch is reported honestly, never as
  a green pass.

```python
import einvoice

batch = einvoice.validate_batch(
    ["invoices/a.xml", "invoices/b.xml"], profile="xrechnung")
print("%d files, %d with problems" % (batch["file_count"],
                                      batch["failed_file_count"]))
for report in batch["files"]:
    print(report["source"], "OK" if report["valid"]
          else report.get("error") or "%d fatal" % report["fatal_count"])
```

### `einvoice.fails_at(result, level) -> bool`

The `--fail-on` threshold rule as a pure predicate: `True` iff at least one
violation in `result` has severity at or above `level`, under the ordering
`information < warning < fatal`. `level` accepts exactly the CLI's values —
`"fatal"`, `"warning"`, `"information"` — and anything else raises
`ValueError` naming the valid choices (the CLI equivalent is a usage error,
exit 2). `fails_at(result, "fatal")` is exactly `not result.valid`, today's
default exit rule; `"warning"` additionally trips on warnings; `"information"`
trips on any finding at all. It delegates to the same threshold code the CLI
exit path runs, so `fails_at(result, level)` always equals
"`einvoice validate --fail-on <level>` would exit 1 on this document".

```python
result = einvoice.validate_file("invoice.xml", profile="xrechnung")
if einvoice.fails_at(result, "warning"):   # stricter than result.valid:
    reject_upload(result.violations)       # warnings block too
```

### `einvoice.capabilities() -> dict`

What this build contains, as a plain JSON-serialisable dict — exactly the
payload `einvoice info --json` prints, from the same runtime sources: the keys
are `version`, `profiles`, `formats`, `rule_count`, `coverage`, and
`attestation_sha256`. Useful for feature-gating an integration ("does this
build know the `sarif` format?") without shelling out. Honest limit: the
artifact-sourced fields (`rule_count`, parts of `coverage`,
`attestation_sha256`) are read from the repo's committed artifacts and degrade
to `None` when those files are not on disk — i.e. in an installed-package
context; a source checkout carries them all.

```python
caps = einvoice.capabilities()
print(caps["version"], caps["profiles"])   # e.g. 0.1.0 ['en16931', 'xrechnung']
if "sarif" in caps["formats"]:
    ...  # safe to request --format sarif from this build
```

## Stability policy

- **Public names.** The eight names above (`validate`, `validate_file`,
  `validate_root`, `Result`, `NotWellFormed`, `validate_batch`, `fails_at`,
  `capabilities`) are the supported API. They will
  not be renamed or removed, and their documented return shape will not change
  in a backward-incompatible way, within a given report schema version.
- **Everything else is internal.** The other importable submodules — `parser`,
  `rules`, `rules_xrechnung`, `codelists`, `report`, `pdf_container`,
  `syntax_binding`, and the rest — remain importable for advanced use, but they
  are **not** part of this contract and may change, move, or disappear without
  notice. Depend on them at your own risk.
- **Report schema versioning.** The machine-readable report
  (`einvoice.report` / `einvoice validate --json`, and its projection via
  `Result.to_dict`) is versioned by a stable `schema` id and a `report_version`
  constant (see `report.schema.json` and `REPORT-SCHEMA.md`). Within a schema
  version (currently `v1`) changes are additive and backward-compatible — new
  optional fields may appear, existing keys keep their meaning. A breaking
  change to the report shape bumps the schema id (`.../v1/...` → `.../v2/...`).
  The eight public names above are back-compat **within a report `schema`
  version** (`validate_batch`'s aggregate dict is versioned by its own
  `einvoice-conformance-batch/v1` schema id, with the same additive-only
  rule).
- **Zero dependencies.** `einvoice` imports nothing outside the Python standard
  library, and `test_packaging.py` enforces that pyproject declares no runtime
  dependencies. Embedding it adds no transitive deps to your project.

The runnable examples on this page are executed end-to-end by
`einvoice/test_api_example.py`, which also asserts every public name is
importable and present in `einvoice.__all__`, so this document cannot silently
drift from the code. `einvoice/test_api_embed.py` additionally proves
`validate_batch`, `fails_at`, and `capabilities` agree with the live CLI
(`validate-batch --json`, `--fail-on`, `info --json`) on the committed
fixtures.

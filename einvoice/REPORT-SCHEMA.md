# Conformance report schema (`einvoice-conformance-report/v1`)

`python3 -m einvoice.report` emits a single, versioned JSON document that is a
deterministic projection of the validator's outcome. It is meant to drop
straight into a CI step: the JSON goes to **stdout**, the **exit code** gates
the build. The report re-implements **no** rule logic — every business rule
(BR-\*, S-\*, BR-DE-\*) is evaluated by `einvoice.validate.validate_file`; this
layer only maps and counts the resulting violations.

The machine-readable form of this contract lives in the `REPORT_SCHEMA`
constant in `einvoice/report.py`; this file is its human companion.

## Invocation

```
python3 -m einvoice.report [--profile en16931|xrechnung] [--pretty] <invoice.xml>
```

- `--profile` — `xrechnung` (default) or `en16931`. `xrechnung` adds the German
  national CIUS layer (BR-DE-\*) on top of the EN 16931 core.
- `--pretty` — indent the JSON (with sorted keys) instead of the default
  compact single line.

Programmatic entry point: `einvoice.report.build_report(path, profile='xrechnung') -> dict`.

## Top-level fields

| field             | type        | meaning |
|-------------------|-------------|---------|
| `report_version`  | int         | Starts at **1**; incremented only on a breaking change to this shape. |
| `schema`          | string      | Stable schema id: `einvoice-conformance-report/v1`. Match on this to stay robust across tool versions. |
| `source`          | string/null | The invoice path/label that was validated. |
| `profile`         | string      | `en16931` or `xrechnung`. |
| `valid`           | bool        | `true` iff there are **zero fatal** violations. Follows the official Schematron `flag` semantics — warnings/information do **not** invalidate. |
| `fatal_count`     | int         | Number of `fatal` violations. |
| `warning_count`   | int         | Number of `warning` violations. |
| `violation_count` | int         | Total violations of every severity. |
| `violations`      | list        | Violation records (below). Empty when the invoice is clean. |
| `error`           | string      | Present **only** when the input is not well-formed XML: the code `not-well-formed`. `valid` is then `false` and `violations` is empty. |
| `message`         | string      | Present **only** alongside `error`: the parser's human message. |

## Violation record

Each entry of `violations` has **exactly** these four keys:

| field      | source               | meaning |
|------------|----------------------|---------|
| `rule`     | `Violation.rule_id`  | The rule id, e.g. `BR-DE-15`. |
| `severity` | `validate._severity` | `fatal` \| `warning` \| `information`. |
| `message`  | `Violation.message`  | The human/Schematron rule message. |
| `field`    | `Violation.element`  | The offending element / path. |

## Exit codes

Mirrors `einvoice.cli` so a build fails exactly when the invoice does:

| code | meaning |
|------|---------|
| `0`  | No fatal violations — the invoice is valid. |
| `1`  | At least one fatal violation. |
| `3`  | Input not well-formed XML (report carries `error`, `valid=false`). |

## Versioning

`report_version` and `schema` move together. A **backward-compatible** addition
(a new optional top-level field) leaves both unchanged. A **breaking** change
(renaming/removing a field, changing a field's type or a violation-record key)
bumps `report_version` to 2 and mints a new `schema` id
(`einvoice-conformance-report/v2`). Consumers that pin on `schema` therefore
never silently mis-read a newer report.

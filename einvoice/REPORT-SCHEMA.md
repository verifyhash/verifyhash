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
python3 -m einvoice.report [--profile en16931|xrechnung] [--format json|junit] [--pretty] [--baseline <prev-report.json>] <invoice.xml>
```

- `--profile` — `xrechnung` (default) or `en16931`. `xrechnung` adds the German
  national CIUS layer (BR-DE-\*) on top of the EN 16931 core.
- `--format` — `json` (default) or `junit`. `junit` emits a JUnit XML document
  (see **JUnit output** below) instead of the JSON; the exit-code contract is
  identical either way. Not compatible with `--baseline`.
- `--pretty` — indent the JSON (with sorted keys) instead of the default
  compact single line. Ignored when `--format junit` is in effect.
- `--baseline <prev-report.json>` — switch to **baseline diff mode** (see
  **Baseline diff mode** below). Fails the build only on a *new* regression
  relative to a captured prior report, not on pre-existing violations.

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

Each entry of `violations` has **exactly** these eight keys. The first four are
the **identity** fields taken verbatim from the validator; the last four are
**additive remediation** fields (added in `v1`, backward-compatible — see
**Versioning**) that are **relayed** from the committed remediation catalog
(`remediation_catalog.json`, via `einvoice.remediation.load_catalog`) keyed by
rule id. The report layer authors **none** of the remediation wording — it only
projects the already-committed, Schematron-traceable catalog data.

| field      | source                          | meaning |
|------------|---------------------------------|---------|
| `rule`     | `Violation.rule_id`             | The rule id, e.g. `BR-DE-15`. |
| `severity` | `validate._severity`            | `fatal` \| `warning` \| `information`. |
| `message`  | `Violation.message`             | The human/Schematron rule message. |
| `field`    | `Violation.element`             | The offending element / path. |
| `title`    | catalog `title`                 | Plain-language rule title. `null` if the rule has no catalog entry. |
| `fix_hint` | catalog `fix`                   | One-line "how to fix" guidance. `null` if uncatalogued. |
| `terms`    | catalog `bt_bg`                 | List of the `BT-`/`BG-` business-term ids the rule touches; `[]` if none. |
| `location` | catalog `location_hint`         | The XML location/path hint for the finding. `null` if uncatalogued. |

The four remediation fields **degrade gracefully**: a rule id absent from the
catalog yields `title`/`fix_hint`/`location` = `null` and `terms` = `[]` — never
an error. (In practice the consistency test `test_remediation_catalog.py` proves
every fireable rule has an entry, so this is only a safety fallback.) The
baseline-diff identity key remains **`(rule, field, message, severity)`** — the
additive fields do **not** affect diffing.

## Exit codes

Mirrors `einvoice.cli` so a build fails exactly when the invoice does:

| code | meaning |
|------|---------|
| `0`  | No fatal violations — the invoice is valid. |
| `1`  | At least one fatal violation. |
| `3`  | Input not well-formed XML (report carries `error`, `valid=false`). |

## JUnit output (`--format junit`)

`--format junit` is an **additional projection** of the exact same validator
outcome — it changes no rule logic and does **not** alter the JSON schema or
`REPORT_VERSION` (the JSON contract above is unchanged; JUnit is a separate
rendering meant for CI dashboards that already understand JUnit XML, e.g.
GitLab CI, Jenkins, GitHub Actions test reporters).

Standard library only (`xml.sax.saxutils` for escaping); no `lxml`, no new
dependency. The document goes to **stdout**; the **exit code is identical to
the JSON path** (`0` valid / `1` fatal / `3` not-well-formed).

Shape:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="einvoice-conformance" tests="N" failures="F" errors="E">
  <testsuite name="<profile>" tests="N" failures="F" errors="E">
    <testcase name="BR-DE-15" classname="<profile>">
      <failure message="&lt;Schematron message&gt;">fatal: &lt;offending field/XPath&gt;</failure>
    </testcase>
    <testcase name="BR-XX" classname="<profile>">
      <system-out>warning: &lt;message&gt; (&lt;field&gt;)</system-out>
    </testcase>
  </testsuite>
</testsuites>
```

- Each **reported** violation becomes one `<testcase>` whose `name` is the rule
  id (`BR-*`, `S-*`, `BR-DE-*`, `BR-DEX-*`) and whose `classname` is the profile.
- A `fatal` violation renders a `<failure>`: the Schematron message is the
  `message` attribute, the offending field/XPath is the failure body — so CI
  shows both *what* and *where*.
- A non-fatal violation (`warning` / `information`) renders a `<system-out>`
  note and **no** `<failure>`; it does not fail the build.
- Passing / absent-violation rules are **not** emitted individually, but the
  `tests` / `failures` / `errors` counts are accurate: `tests` = number of
  reported violations, `failures` = number of `fatal` violations, `errors` = 0.
- Not-well-formed XML emits a single `<testcase name="not-well-formed">` with an
  `<error>` (so `errors="1"`, `tests="1"`, `failures="0"`) and exits `3`.

All text is XML-escaped with `xml.sax.saxutils`.

## Baseline diff mode (`--baseline <prev-report.json>`)

An **adoption on-ramp** for teams inheriting a non-conformant invoice pipeline.
A hard gate ("any fatal fails the build") is often too strict to switch on when
there are already dozens of known violations. Baseline diff mode instead fails
the build **only on a new regression** — a fatal violation that was *not* in a
captured baseline — while tolerating the pre-existing backlog. Point CI at a
baseline report captured once (a normal `--format json` run committed to the
repo), and the build turns red the day someone makes conformance *worse*, not
before.

```
# capture a baseline once (commit the JSON):
python3 -m einvoice.report --format json invoice.xml > baseline.json
# then gate every build against it:
python3 -m einvoice.report --baseline baseline.json invoice.xml
```

The baseline is any prior report of schema `einvoice-conformance-report/v1`
(it must be a JSON object with a `violations` array of
`{rule, field, severity, message}` records). The tool **re-validates** the
current invoice with `einvoice.validate` — it adds **no** rule logic — and
**diffs** the two violation sets by the stable key
**`(rule, field, message, severity)`**, respecting multiplicity.

The diff is emitted to **stdout** as its **own versioned document**, schema
`einvoice-conformance-diff/v1`. This is a distinct shape from the plain report,
so adding it leaves the plain report's `report_version` at **1**; the diff
document carries its own `report_version` (also starting at 1) and moves on its
own cadence. Programmatic entry points:
`einvoice.report.load_baseline(path) -> dict` and
`einvoice.report.build_diff(invoice_path, baseline_dict, profile=..., baseline_path=...) -> dict`.

### Diff document fields

| field                  | type        | meaning |
|------------------------|-------------|---------|
| `report_version`       | int         | The diff document's own version (starts at **1**). |
| `schema`               | string      | `einvoice-conformance-diff/v1`. |
| `mode`                 | string      | The literal `diff`. |
| `source`               | string      | The current invoice path that was validated. |
| `baseline`             | string/null | The `--baseline` file path supplied on the CLI. |
| `baseline_source`      | string/null | The `source` field recorded *inside* the baseline report. |
| `profile`              | string      | `en16931` or `xrechnung`. |
| `new_violations`       | list        | Violation records present **now** but absent in the baseline. Same four-key shape as `violations` above. |
| `resolved_violations`  | list        | Violation records present in the **baseline** but absent now. |
| `new_count`            | int         | `len(new_violations)`. |
| `resolved_count`       | int         | `len(resolved_violations)`. |
| `unchanged_count`      | int         | Violations present in both (with multiplicity). |
| `new_fatal_count`      | int         | `new_violations` whose `severity` is `fatal`. **Drives the exit code.** |
| `baseline_fatal_count` | int         | Fatal violations in the baseline. |
| `current_fatal_count`  | int         | Fatal violations in the current invoice. |
| `error`                | string      | Present **only** when the current invoice is not well-formed XML: `not-well-formed`. The diff lists are then empty. |
| `message`              | string      | Present **only** alongside `error`: the parser's human message. |

### Diff exit codes

Deliberately **more lenient** than plain mode — a pre-existing failure does not
break the build, only a regression does:

| code | meaning |
|------|---------|
| `0`  | **Zero** new fatal violations vs the baseline (pre-existing fatals are tolerated). |
| `1`  | At least one **new** fatal violation appeared — a regression. |
| `3`  | The current input is not well-formed XML (diff carries `error`, lists empty). |

A malformed, unreadable, or wrong-shape baseline file is reported with a clear
`error:` line on **stderr** and a nonzero exit — never a traceback.

## Versioning

`report_version` and `schema` move together. A **backward-compatible** addition
(a new optional top-level field, or an **additive** violation-record key that
consumers can ignore) leaves both unchanged. A **breaking** change
(renaming/removing a field, changing a field's type, or removing/renaming a
violation-record key) bumps `report_version` to 2 and mints a new `schema` id
(`einvoice-conformance-report/v2`). Consumers that pin on `schema` therefore
never silently mis-read a newer report.

The `title`, `fix_hint`, `terms` and `location` violation-record fields were
added this way: they are **additive** on the **same** `einvoice-conformance-
report/v1` schema id. The original `rule`/`severity`/`message`/`field` keys are
unchanged and remain first, so existing consumers keep working untouched; the
schema id is deliberately **not** revved.

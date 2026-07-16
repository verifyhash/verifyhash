# Report formats and modes

`python3 -m einvoice.report` renders one validation run in several shapes so it
can drop into whatever consumer a pipeline already has. This page is the single
reference for **every** output surface: the nine `--format` values plus the two
standalone modes (`--baseline` diff, `--explain` lookup). It exists so the
advertised set and the set the code actually emits cannot drift — a guard test
(`test_report_formats.py`) fails if a row here and a `--format` choice in
`einvoice/report.py` disagree in either direction.

Nothing here changes behaviour; the rules, the fire logic, and the exit codes
are exactly what `report.py` already does. The exit code is the same for every
surface: **0** when the invoice is conformant (no FATAL violation), **1** when a
FATAL violation is present, **3** when the input is not well-formed XML (folded
into a report with an `error` field, never a traceback).

## The nine `--format` values

Each row runs against a committed known-good fixture
(`examples/01-missing-fields/fixed.xml`, exit 0). Swap in
`examples/01-missing-fields/broken.xml` to see the same surface report a FATAL
(exit 1).

| Surface | Consumer / CI target | Stability guarantee | Run it |
| --- | --- | --- | --- |
| `--format text` | Human at a terminal — a one-line PASS/FAIL verdict plus indented findings. | Human-facing; the wording and layout are **not** a machine contract and may change. Parse `json` instead. | `python3 -m einvoice.report --format text examples/01-missing-fields/fixed.xml` |
| `--format json` | Machines — the canonical, versioned document every other surface is derived from. | Versioned: `schema` = `einvoice-conformance-report/v1`, integer `report_version`. Field shape is fixed within a version; a breaking change bumps the schema id. See [REPORT-SCHEMA.md](REPORT-SCHEMA.md). | `python3 -m einvoice.report --format json examples/01-missing-fields/fixed.xml` |
| `--format junit` | CI test panes (Jenkins, GitLab, GitHub Actions test reporters) that ingest JUnit XML. | Shaped to the JUnit `<testsuite>`/`<testcase>` schema those tools read; one `<testcase>` per fired rule, `<failure>` on a FATAL. | `python3 -m einvoice.report --format junit examples/01-missing-fields/fixed.xml` |
| `--format sarif` | GitHub code-scanning (and any SARIF viewer). | SARIF **2.1.0** (`version` = `2.1.0`, `$schema` set); one `result` per violation. Bound to the external SARIF 2.1.0 spec, not to our own version counter. | `python3 -m einvoice.report --format sarif examples/01-missing-fields/fixed.xml` |
| `--format gitlab` | GitLab **Code Quality** (Code Climate) merge-request widget. | A JSON array of Code Climate issue objects (`check_name`, `description`, `fingerprint`, `location`, `severity`). A conformant invoice yields an **empty array** `[]` — that is correct, not a failure. | `python3 -m einvoice.report --format gitlab examples/01-missing-fields/fixed.xml` |
| `--format github` | GitHub Actions **inline annotations** with zero SARIF upload and zero GitHub Advanced Security / code-scanning setup — any step that prints these lines gets file-anchored annotations. | GitHub [workflow-command](https://docs.github.com/actions/reference/workflow-commands-for-github-actions) lines: one `::error`/`::warning` per finding (`fatal`->`::error`, `warning`/`information`->`::warning`), `file=`/`title=` (rule id) properties, optional `line=` when a source position is known. Bound to GitHub's line protocol, not to our own version counter. Advisory `information` findings surface as `::warning` (exit stays 0); a fully conformant invoice emits a single `#` log-comment no-op line. | `python3 -m einvoice.report --format github examples/01-missing-fields/fixed.xml` |
| `--format azure` | Azure DevOps **Pipelines** inline issues — the MS/SAP-stack ERP buyer whose CI runs on Azure DevOps, not GitHub Actions. Any script step that prints these lines gets file-anchored build/PR issues with zero extension install. | Azure DevOps [logging-command](https://learn.microsoft.com/azure/devops/pipelines/scripts/logging-commands) `##vso[task.logissue ...]` lines: one per finding (`fatal`->`type=error`, `warning`/`information`->`type=warning`), `sourcepath=`/`code=` (rule id) properties, optional `linenumber=` when a source position is known. Bound to Azure's logging-command protocol, not to our own version counter. Advisory `information` findings surface as `type=warning` (exit stays 0); a fully conformant invoice emits a single `#` log-comment no-op line. | `python3 -m einvoice.report --format azure examples/01-missing-fields/fixed.xml` |
| `--format html` | A human report artifact you can archive or attach to a build. | Human-facing; the HTML structure is a presentation surface and may change. Not a machine contract — parse `json` for automation. | `python3 -m einvoice.report --format html examples/01-missing-fields/fixed.xml` |
| `--format badge` | A [shields.io endpoint badge](https://shields.io/badges/endpoint-badge) you commit next to a report so a README badge can render the last verdict. | shields.io endpoint schema: `schemaVersion` = `1`, plus `label`/`message`/`color`. Reflects **this committed run**, not a live hosted service. | `python3 -m einvoice.report --format badge examples/01-missing-fields/fixed.xml` |

## The two standalone modes

| Mode | Consumer / CI target | Stability guarantee | Run it |
| --- | --- | --- | --- |
| `--baseline <prev-report.json>` | A regression gate: diff the current invoice against a captured prior `json` report and fail (exit 1) **only** on a NEW fatal violation; pre-existing fatals are tolerated (exit 0). | Versioned diff document: `schema` = `einvoice-conformance-diff/v1`. Identity key and field shape are specified in [REPORT-SCHEMA.md](REPORT-SCHEMA.md). Not combinable with `--format` (it emits its own document). | `python3 -m einvoice.report --format json examples/01-missing-fields/fixed.xml > base.json && python3 -m einvoice.report --baseline base.json examples/01-missing-fields/broken.xml` |
| `--explain <RULE-ID>` | A developer looking up one rule — prints the remediation-catalog entry (title, BT/BG, location hint, one-line fix, severity, Schematron provenance) as a plain-text block and exits 0. | Reads **no** invoice file; content comes verbatim from `remediation_catalog.json`. Not combinable with `--format` or `--baseline`. Lookup is case-insensitive. | `python3 -m einvoice.report --explain BR-DE-15` |

## Cross-references

- **Versioned shapes** — the `json` report (`einvoice-conformance-report/v1`) and
  the `--baseline` diff (`einvoice-conformance-diff/v1`) field-by-field contracts,
  exit-code table, and the JUnit/SARIF/Code-Quality/badge derivations live in
  [REPORT-SCHEMA.md](REPORT-SCHEMA.md).
- **Parity guard** — `test_report_formats.py` drives every `--format` value and
  both modes against the committed fixtures and asserts this table and
  `report.py` list the same set. Add or drop a format without editing both and
  the gate goes red.

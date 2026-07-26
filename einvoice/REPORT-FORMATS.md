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

## Path echo

Measured rule (pinned by `test_path_invariance.py`): **reports echo the input
path exactly as the user supplied it on the command line — nothing is
absolutized, resolved, or rewritten.** Pass `invoice.xml` from its own
directory and every surface says `invoice.xml`; pass
`/abs/path/to/invoice.xml` from anywhere and every surface says
`/abs/path/to/invoice.xml`. Reading stdin (`validate -`) echoes `-`.

Where the echoed path appears, per surface:

- **text** (`einvoice validate`, `--format text`) — the `PASS:`/`FAIL:`
  verdict line carries the path verbatim.
- **json** (`validate --json`, `--format json`) — the `source` field is the
  argv string verbatim.
- **sarif** — every result that has a location carries **both** halves: a
  `logicalLocations` member (the offending element name) and a
  `physicalLocation` whose `artifactLocation.uri` is the argv path,
  **URI-shaped**. URI-shaped means two things and nothing more: separators
  become `/` on platforms whose native separator is not `/`, and characters
  that are illegal in a URI reference are percent-encoded — a space becomes
  `%20`, `ü` becomes `%C3%BC`, a literal `%` becomes `%25`. Characters that
  are legal stay literal, so `&`, `'`, `(`, `)`, `+`, `,`, `;`, `=`, `:` and
  `@` are readable as typed. Percent-decoding the `uri` returns the argv
  string byte for byte; nothing is absolutized or resolved. A finding the
  parser could attribute to a concrete element additionally gets
  `physicalLocation.region.startLine` — the 1-based source line — while an
  absence/document-level finding (say BR-16, "an Invoice shall have at least
  one Invoice line") gets the `artifactLocation` and **no** `region` at all,
  never a guessed line 1 and never `startLine: 0`. This is what GitHub code
  scanning needs to draw an inline pull-request annotation: without
  `artifactLocation.uri` + `region.startLine` the SARIF upload succeeds and
  nothing appears on the diff. Consequence: relative-path and absolute-path
  invocations of the same file are **no longer byte-identical** — they differ
  in exactly the echoed path, like `json`. `partialFingerprints` stays
  line-independent (rule id + logical location only), so an edit that shifts a
  finding to a new line still de-duplicates against the previous run.
- **html** — the `source:` meta line shows only the input file's **basename**,
  never the directory part. Since 2026-07-26 there is one other place a path
  appears, and only there: a **finding's position**, which echoes your spelling
  verbatim — `at invoices/march.xml:28` for an attributable finding,
  `(insertion point invoices/march.xml:28)` for an absence. That is the same
  string the text report and the JUnit `<failure>` body print, from the same
  formatter, because the HTML file is the one artifact that travels to a second
  person and `line 28` with no filename beside it is not an address the
  recipient can act on. Consequence, the same trade sarif made when it gained
  `region.startLine`: for a report that HAS a positioned finding, relative-path
  and absolute-path invocations are no longer byte-identical — they differ in
  exactly that echoed path. A report whose findings carry **no** position is
  still fully path-invariant, and the document chrome (meta line, rule-page
  links, style, footer) is invariant either way. No embedded timestamp in any
  case. Pinned by `test_report_html.py`.

Two consequences worth relying on:

1. **The verdict and exit code are working-directory independent.** Only the
   path *string* in the report differs between a relative and an absolute
   invocation of the same file; findings, counts, and exit codes are
   identical. Measured 2026-07-17 on both a passing and a failing fixture:
   relative-from-parent vs absolute-from-a-temp-cwd produced identical
   verdicts (exit 0 / exit 1) and, after normalizing the echoed path,
   identical bytes.
2. **No machine-internal paths leak — you choose the spelling.** Because the
   tool never absolutizes, a relative invocation emits no absolute path
   anywhere in json or sarif: run `einvoice validate --format sarif
   invoices/march.xml` from your repo root and the `uri` is
   `invoices/march.xml`, which is exactly the repo-relative form GitHub code
   scanning needs to anchor an annotation — no home directory, no username,
   no install location, and no CI-runner workspace prefix. (Honest limit: if
   *you* pass an absolute path, that string is echoed back verbatim in
   **text**, **json** and now **sarif** too — including whatever it reveals —
   so pass the spelling you are comfortable publishing, and note that an
   absolute `uri` is also one GitHub cannot match to a file in the diff. In
   **html** the meta line still shows the basename only, but a positioned
   finding echoes your spelling too — so if you plan to forward the HTML
   report, run it with the relative path.)

## OS-level input errors

Measured rule (2026-07-17, pinned by `test_os_error_formats.py` across the
full matrix of {nonexistent path, unreadable `chmod 000` file, directory,
dangling symlink} × all nine `--format` values): **when the input fails at
the OS level, stdout stays completely empty — a machine consumer never sees
a half-emitted or truncated document — and stderr carries exactly one
actionable `error:` line; the exit code is `1`, this surface's usage/error
code (report.py mints no exit `2`; the exit-`2` taxonomy in EXIT-CODES.md
belongs to the `python3 -m einvoice` CLI).** Never a Python traceback, and
never diagnostic text interleaved into a json/junit/sarif/gitlab document.

Per input class:

- **Nonexistent path** — every format: empty stdout, `error: no such file:
  <path>` on stderr, exit `1`.
- **Unreadable file** (exists, permission denied — e.g. `chmod 000`) — every
  format: empty stdout, `error: cannot read <path>: Permission denied` on
  stderr, exit `1`. (Before 2026-07-17 this leg leaked a raw
  `PermissionError` traceback — the only class that violated the rule; the
  read boundary in `report.py` now catches the `OSError` family before any
  emitter writes a byte.)
- **Directory** — *not* an OS error for `json`, `junit`, and `text`: a
  directory positional is the designed batch mode and emits a complete,
  parseable batch document (schema `einvoice-conformance-batch/v1` for
  json) with the batch exit-code precedence — an empty directory
  batch-passes with exit `0`. The six single-file-only formats (`sarif`,
  `gitlab`, `github`, `azure`, `badge`, `html`) refuse with empty stdout and
  `error: --format <F> validates a single file; use json/junit/text for a
  directory`, exit `1`.
- **Dangling symlink** (link exists, target missing) — every format: same
  empty-stdout branch as a nonexistent path (`error: no such file: <path>`,
  exit `1`); `isfile()` is false for it, and the stdout/exit discipline is
  what this contract pins. (The friendlier "dangling symlink" wording exists
  on the `python3 -m einvoice validate|receipt` surface, per EXIT-CODES.md.)

Honest limit: the diagnostic is plain text on stderr, not a machine
document — a CI step that wants a parseable failure artifact for a missing
or unreadable input must branch on the exit code, not parse stdout (which
is deliberately empty in every OS-error case). Note that `einvoice
validate` itself exposes **no** `--format` flag (machine formats live on
`python3 -m einvoice.report`); passing one is a usage error (exit `2`,
empty stdout) — also pinned by `test_os_error_formats.py`.

## Unsupported PDF container

Measured rule (2026-07-17, golden-pinned **byte-for-byte** by
`test_golden_snapshot.py` against the committed deterministic corrupted
fixture `corpus/pdf/facturx-truncated.pdf`, plus `test_pdf_container.py` /
`test_fuzz_pdf_container.py` for the no-`/EmbeddedFiles`, encrypted, and
fuzz-mangled shapes): **unlike an OS-level input error, an unsupported PDF
container IS a delivered verdict** — the file was read fine; its *contents*
cannot be reduced to a validatable invoice. So the machine-format discipline
is the opposite branch of the OS-error rule: **stdout carries a complete,
parseable document** carrying the literal error code `unsupported-container`,
**stderr is empty** (zero traceback bytes), and the exit code is **`3`** for
every `--format` value — `report.py` returns `EXIT_PARSE` whenever the report
carries an `error` field, the same family as not-well-formed XML (see
EXIT-CODES.md). Never a false pass, never a half-emitted document.

This fires whenever the input has the `%PDF-` magic but the zero-dependency
extractor cannot reach the embedded e-invoice XML: encryption (`/Encrypt`),
no `/EmbeddedFiles` name tree, a truncated file / missing classic `trailer`,
cross-reference-stream layout (PDF 1.5+), or an unknown stream filter. The
report's `message` names the concrete reason.

How the error appears, per golden-pinned machine format:

- **json** — the versioned `einvoice-conformance-report/v1` document with
  `"error": "unsupported-container"`, `"valid": false`, all three counts `0`,
  `"violations": []`, and `"message"` carrying the extractor reason (e.g.
  `"unsupported container — could not extract embedded invoice XML: no
  classic PDF trailer — …"`).
- **junit** — `<testsuites tests="1" failures="0" errors="1">` containing a
  single `<testcase name="unsupported-container">` with one `<error>` child
  whose `message` is the extractor reason — the JUnit *error-not-failure*
  convention (the input could not be tested, no rule "failed").
- **sarif** — one `result` with `ruleId` `"unsupported-container"`, `level`
  `"error"`, `message.text` = the extractor reason, an **empty**
  `tool.driver.rules` array (no rule fired), a stable `partialFingerprints`
  digest keyed on the error code alone, and no `locations` array — so, unlike
  a rule violation, this result carries no `physicalLocation` and therefore no
  filesystem path anywhere. (There is no offending element to anchor: the
  input never became an invoice.)

The remaining surfaces relay the same error code (measured: `gitlab` as
`check_name`, `github` as `title=`, `azure` as `code=`, `text` as an
`ERROR <path> unsupported-container:` line) with the same exit `3`, but only
the three machine formats above are byte-golden-pinned. Honest limit: the
refusal list is a property of the deliberately zero-dependency extractor —
it refuses containers it cannot open *honestly* instead of guessing; a
password-protected or PDF-1.5+ xref-stream Factur-X file needs a full PDF
library upstream of this tool.

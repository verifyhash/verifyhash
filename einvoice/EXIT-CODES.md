# einvoice CLI exit-code contract

This is the machine-readable exit-code and error-taxonomy contract for the
`einvoice` command-line tool (`einvoice validate`, `validate-batch`, `receipt`;
also reachable as `python3 -m einvoice ...`). The codes below are a **versioned
contract**: a caller (CI gate, Makefile, shell script) can branch on the
process return code and rely on its meaning across releases.

The values here were **measured against the live CLI at HEAD**, not assumed. The
symbolic constants live in `einvoice/cli.py` (`EXIT_OK=0`, `EXIT_FAIL=1`,
`EXIT_USAGE=2`, `EXIT_PARSE=3`); the batch precedence lives in
`einvoice.report.batch_exit_code`. `test_exit_codes.py` re-derives every row of
this table by driving the real CLI, so the doc fails its own gate if any code
ever drifts.

## Codes

| Code | Meaning | Terminal states that produce it | Stream + actionable message |
|------|---------|----------------------------------|-----------------------------|
| `0` | Success — no fatal violations. The invoice passed every implemented fatal rule (warnings/information do not affect the code). For `validate-batch`: every file passed, or the directory/glob matched no invoice files (`file_count: 0`). For the read-only `info` subcommand: the introspection payload was emitted (it validates nothing, so `0` is its only success state). For `receipt --verify`: the recomputed content hash **matched** the stored `content_sha256` — **VERIFIED** (this validates nothing; it only re-hashes the receipt body). | `validate` on a conformant invoice; `receipt` whose verdict is `PASS`; `receipt --verify` on an untampered receipt (VERIFIED, `--json` or human); `validate-batch` all-pass or empty match; `info` (with or without `--json`). | stdout: `PASS: <src> (all implemented fatal rules, profile=<p>)`; for `receipt --verify` a `VERIFIED: <src>` line, or with `--json` one sorted-keys object with `verdict":"VERIFIED"`, `match":true`. |
| `1` | Not-valid verdict — at least one implemented **fatal** rule failed. This is also where **unsupported / out-of-scope inputs land** (see note below): they are not a separate code, they trip a real fatal rule (e.g. a wrong root namespace fails `S-ROOT`). A UBL `CreditNote` is now really validated through the shared engine, so an invalid one fails on its real business rule here too. For `receipt`: a `FAIL` verdict, *including* not-well-formed input, which `receipt` folds into a FAIL receipt rather than exit 3. For `validate-batch`: ANY file has a fatal violation (fatal outranks a parse error). For `receipt --verify`: the recomputed content hash **did not match** the stored `content_sha256` — **TAMPERED** (some body field was altered, or `content_sha256` itself was corrupted); this mirrors `receipt` build's use of `1` for a non-clean outcome. | `validate` on an invoice or CreditNote with a fatal violation, or an out-of-scope document type; `receipt` FAIL; `receipt --verify` on a tampered receipt (TAMPERED, `--json` or human); `validate-batch` any-fatal. | stdout: `FAIL: <src>` then `<RULE-ID>: <message>` and `offending element: <el>` (the first fatal rule id, e.g. `S-ROOT`); for `receipt --verify` a `TAMPERED: <src>` line, or with `--json` one sorted-keys object with `verdict":"TAMPERED"`, `match":false`. |
| `2` | Usage error — the tool was invoked wrong and did no validation. Bad or missing arguments, an unknown subcommand, an unknown `--profile` / `--lang` value, a `--profile`/`--lang` flag with no value, unexpected extra arguments, or a named input file that does not exist on disk. **Config-file problems land here too** (additive, T-VHDX.3): an unknown key or non-string value in `.einvoice.toml` / the `[tool.einvoice]` table of `./pyproject.toml` prints one `error:` line naming the bad key, the file, and the accepted set (`fail-on, format, lang`); an invalid config *value* (`lang = "fr"`, `fail-on = "bogus"`, `format = "yaml"`) takes the **same error path as the equivalent bad flag** — byte-identical stderr for `lang`/`fail-on`, pinned by `test_config_file.py`. No config was applied, no validation happened, so the honest code is the usage error the flag form always had — no new code minted. `info` takes no arguments at all, so any extra argument or unknown flag after it lands here too. **Also every OS-level input problem on the single-file subcommands** (`validate`/`receipt`): the named path is **unreadable** (permission denied, e.g. a `chmod 000` file), **is a directory**, or is a **dangling symlink**; and `validate -` when **stdin is closed** or unreadable. **Also `receipt --verify` when the target is not a readable conformance receipt**: not valid JSON (garbage / truncated / empty), or valid JSON that lacks the `receipt` / `content_sha256` fields, or a nonexistent / unreadable path — one actionable `error:` line, no JSON body even under `--json`, no traceback. No validation happened in any of these, so no verdict code is minted — see the OS-error section below. | `validate`/`validate-batch`/`receipt` with malformed argv or a missing file; `info` with any extra argument; `validate`/`receipt` pointed at an unreadable file, a directory, or a dangling symlink; `validate -` with a closed stdin; `receipt --verify` on a non-JSON / non-receipt / missing file. | stderr: `error: <what>` and/or the `usage:` banner; OS-error inputs get one line naming the **path and the reason** (e.g. `error: cannot read <path>: Permission denied`) — never a traceback. |
| `3` | Not-well-formed input — the XML could not be parsed (truncated document, syntax error, or an input rejected by the hardened DTD/XXE parser). `validate` only. `receipt` folds this case into a FAIL receipt (exit `1`); `validate-batch` returns `3` only when some file *only* errored (not-well-formed / unsupported container) and no file had a fatal. | `validate` on malformed XML; `validate-batch` error-only, no-fatal. | stderr: `S-WF: input is not well-formed XML: <parser detail>`, followed by one `hint:` line (T-VHUX.4, `validate` human output only — `--json` and `validate-batch` are untouched): if the bytes carry the `%PDF-` magic the hint redirects to the container route (`python3 -m einvoice.report <invoice.pdf>`); otherwise it names both supported input shapes (well-formed UBL/CII XML, or a Factur-X/ZUGFeRD PDF/A-3 container). Pinned by `test_robustness.py::test_wrong_file_type_actionable`. |
| `141` | Broken pipe — the stdout **consumer closed early** (`… \| head`, a dying `jq`, a closed CI log pipe) while the CLI was still writing its report. `141 = 128 + SIGPIPE(13)`, the standard shell convention for a pipe-killed process. The CLI exits **quietly**: no traceback, nothing further written to stdout. The verdict for that run is simply unavailable — the reader walked away mid-report; codes `0/1/2/3` are untouched. See the section below. | Any subcommand whose stdout write raises `BrokenPipeError` — in practice a large `validate-batch` report (text or `--json`) piped into a reader that exits before consuming it all. | stderr: *(nothing — deliberately silent; a broken pipe is the caller's plumbing, not a validation outcome)*. |
| `130` | Interrupted — **SIGINT** (Ctrl-C) aborted the run mid-validation. `130 = 128 + SIGINT(2)`, the standard shell convention for an interrupted process. The CLI exits **quietly**: no Python traceback, nothing further written, and the `validate -` stdin temp file is removed on the way out. The verdict for the aborted run is simply unavailable; codes `0/1/2/3/141` are untouched. See the interrupt section below. | Any subcommand hit by SIGINT / Ctrl-C while running (`validate`, `validate-batch`, `receipt`). | stderr: *(nothing — an interrupt is the operator's action, not a validation outcome)*. |
| `143` | Terminated — **SIGTERM** (e.g. a CI timeout kill, `kill <pid>`, container stop) aborted the run. `143 = 128 + SIGTERM(15)`, the standard shell convention for a terminated process. The entry point converts the signal into an exception so the same temp-file cleanup runs, then exits **quietly** with this code — no traceback, no stray `einvoice-stdin-*` file. See the interrupt section below. | Any subcommand hit by SIGTERM while running. | stderr: *(nothing)*. |

## Code `2` — OS-level input errors on the single-file paths (additive)

These rows were added after **measuring** `validate` and `receipt` (2026-07-17)
against the four classic OS input states plus the `-` stdin path. Two states
were genuinely broken, two were non-zero but named the wrong reason, and two
were already clean:

| Input state | Before (measured) | Now (pinned) |
|-------------|-------------------|--------------|
| Nonexistent path | exit `2`, `error: no such file: <path>` — already clean | unchanged (verify-and-close). |
| **Unreadable** file (exists, `chmod 000`) | **raw `PermissionError` traceback, exit `1`** — a fake FAIL verdict for a run that validated nothing | exit `2`, `error: cannot read <path>: Permission denied`, zero traceback. |
| **Directory** passed where a file is expected | exit `2` but the wrong reason (`no such file` for a directory that plainly exists) | exit `2`, `error: is a directory (expected a single invoice file; use validate-batch for directories): <path>`. |
| **Dangling symlink** (link exists, target missing) | exit `2`, misleading `no such file` (the link itself exists) | exit `2`, `error: dangling symlink (its target does not exist): <path>`. |
| `validate -` with **stdin closed** (fd 0 closed at startup) | **raw `AttributeError` traceback, exit `1`** (`sys.stdin` is `None`) | exit `2`, `error: cannot read -: stdin is closed`, zero traceback. |
| `validate -` with **empty** stdin | exit `3`, clean `S-WF` parse error — already actionable | unchanged (verify-and-close). |

Every OS-error input lands on the **existing** usage code `2` — deliberately no
new code: the tool was pointed at something that cannot be an invoice file and
did no validation, exactly the meaning `2` has always had (a nonexistent path
was already `2`). The stderr line always names **both the offending path and
the OS reason**, and never a Python traceback.

Implementation is boundary-only and verdict-neutral: `cli.py` triages the
directory / dangling-symlink / nonexistent states before opening the file, and
catches exactly the **`OSError` family** (`FileNotFoundError` /
`PermissionError` / `IsADirectoryError` / `OSError`) around the single-file
subcommand body — never a bare `except`; `BrokenPipeError` is explicitly
re-raised so the `141` contract above is untouched, and `validate-batch` is
untouched (its per-file resilience is pinned separately: an unreadable batch
member becomes an ERROR entry, never a crash).

Root caveat: a user that bypasses permission bits (root, `CAP_DAC_OVERRIDE`)
can still read a `chmod 000` file, so the unreadable state cannot occur for it.
`test_os_errors.py` pins every row above by driving the real CLI as a
subprocess (both subcommands per row) and probes with `os.access` first,
self-skipping the unreadable leg with a printed reason where the OS does not
enforce the bits.

## Code `141` — broken pipe / early-closed consumer (additive)

`einvoice validate-batch invoices/ --json | head -c 200` (or any pipeline
whose reader exits before consuming the whole report — `jq` erroring out, a
CI log collector going away) closes the read end of the pipe while the CLI is
still writing. The OS then fails the CLI's next stdout write with `EPIPE`,
which Python surfaces as `BrokenPipeError`. Before this contract row was
added, that meant a raw traceback on stderr plus Python's generic exit `1` —
indistinguishable from a crash, and easily mistaken for a `FAIL` verdict.

Now the CLI entry point catches `BrokenPipeError`, redirects the stdout file
descriptor to `os.devnull` (the CPython-documented pattern, which prevents a
*second* "Exception ignored" traceback from the interpreter-shutdown flush of
the buffered stream), writes nothing further, and returns `141` — the
`128 + signal` shell convention for `SIGPIPE` (13), i.e. the same code
`grep -q`-style early-exit pipelines produce for any well-behaved Unix tool.
The symbolic constant is `EXIT_PIPE = 141` in `einvoice/cli.py`.

What `141` does and does not tell you:

- It means **your pipeline's reader closed early** — it is plumbing feedback,
  not a validation outcome. No verdict was (fully) delivered for that run.
- It never masks a real outcome: a batch that runs to completion still
  returns `0`/`1`/`3` exactly as documented above, byte-identical reports
  included. The handler only fires when the write itself fails.
- Practical note: a *small* report (under the OS pipe buffer, typically
  64 KiB on Linux) may be fully buffered before the reader exits, in which
  case the CLI never sees `EPIPE` and exits with its normal code. `141`
  appears when the report is larger than what the departed reader drained.

`test_pipe_discipline.py` pins this row by driving the real CLI against a
>128 KiB batch report (text *and* `--json`), closing the pipe early, and
asserting exit `141` with zero traceback bytes on stderr — plus a
no-early-close control on the same corpus proving the reports and verdicts
are unchanged.

## Codes `130` / `143` — clean interrupt / termination abort (additive)

These two rows were added after **measuring** the CLI's behavior under
mid-run signals (a `validate-batch` over ~500 files and a `validate -` fed a
multi-second invoice through stdin, each signaled while genuinely
mid-validation):

- **SIGINT before the fix**: Python's unhandled `KeyboardInterrupt` dumped a
  raw multi-frame traceback (runpy + cli frames) on stderr before the process
  died — crash-looking output for a routine operator Ctrl-C, on every code
  path. The stdin temp file *was* cleaned (the exception propagates through
  the cleanup `finally`), so the only defect was the traceback.
- **SIGTERM before the fix**: the default disposition kills the process with
  **no `finally` cleanup at all**. Measured consequence: a SIGTERM landing
  while `validate -` was validating its staged stdin bytes left a stray
  `einvoice-stdin-*.xml` file in the temp directory. (The batch path leaked
  nothing — it stages no temp file — but died silently with the raw signal.)

The fix mirrors the `141` broken-pipe pattern and is deliberately minimal —
two arms at the single CLI entry point, no signal logic anywhere else:

- `KeyboardInterrupt` is caught at the entry point and becomes a **quiet**
  exit `130` (`EXIT_INT` in `einvoice/cli.py`) — no traceback, nothing
  further written.
- A SIGTERM handler (installed at entry, previous disposition restored on the
  way out) converts the signal into an internal exception, so every cleanup
  `finally` on the stack runs — the stdin temp file is unlinked — and the
  exit is a **quiet** `143` (`EXIT_TERM`).

What `130`/`143` do and do not tell you:

- They mean **the run was aborted from outside** — operator Ctrl-C or a
  supervisor's TERM. No verdict was delivered for that run; treat it as
  "unknown", never as PASS or FAIL.
- They never mask a real outcome: a run that completes still returns
  `0/1/2/3` exactly as documented, byte-identical reports included.
- A signal that lands in the first milliseconds of interpreter startup
  (before the CLI entry point is reached) can still surface Python's default
  behavior; the codes above cover a signal arriving any time the tool is
  actually validating.

`test_interrupt.py` pins both rows by driving the real CLI mid-run (batch
and stdin paths), sending each signal, and asserting the documented code,
zero traceback bytes on stderr, and zero stray `einvoice-stdin-*` files.

## Opt-in `--fail-on <level>` severity threshold (non-breaking)

By **default** only a `fatal` finding makes `validate` / `validate-batch` exit
`1`; `warning` and `information` findings are reported but never affect the
code. The **opt-in** `--fail-on` flag lets a pipeline choose a stricter
threshold *without changing anything else*. It is a pure post-validation
exit-code knob: it does **not** change the findings, the validation logic, the
`--json` payload bytes, or the human summary text — **only** the process exit
code. Both `--fail-on <level>` and `--fail-on=<level>` are accepted, exactly as
`--profile` / `--lang` are.

| `--fail-on` value | Exit `1` when… | Notes |
|-------------------|----------------|-------|
| _(flag omitted)_ | ≥1 **fatal** finding | The historical default. |
| `fatal` | ≥1 **fatal** finding | **Byte-identical to omitting the flag** — the default is unchanged and this change is fully **non-breaking**. |
| `warning` | ≥1 **fatal** OR ≥1 **warning** finding | |
| `information` | ≥1 finding of **any** severity (strict) | |

Scope and invariants:

- The threshold is measured over the validation findings (each `Violation`'s
  `severity`, per `einvoice.validate._severity`).
- `--fail-on` **only** affects the `0` vs `1` decision. It never turns a usage
  error (`2`) or a not-well-formed parse error (`3`) into something else: an
  invalid file, bad argv, or malformed XML still lands on its usual code.
- An **invalid** `--fail-on` value (anything other than
  `fatal` / `warning` / `information`) is a **usage error** (`2`) with an
  actionable `error: unknown --fail-on value …` on stderr plus the usage banner
  — it is never silently ignored.
- For `validate-batch` the threshold is applied across the **aggregate**: exit
  `1` if **any** file crosses the chosen level. The parse-only `3` rule is left
  intact — when no file crosses the threshold and some file *only* errored
  (not-well-formed / unsupported container), the batch still returns `3`.
- `--fail-on` is accepted for `validate` and `validate-batch`; it does not apply
  to `receipt` (whose exit code always mirrors its PASS/FAIL verdict).

## `--format <fmt>` on the console script — no new code (additive)

Since T-VHERG.4 the `einvoice` console script accepts `--format <fmt>` (and
`--format=<fmt>`) on `validate` and `validate-batch`, so the one binary a
`pip install` puts on your PATH emits every format `einvoice info` advertises —
including the SARIF file GitHub code scanning consumes. **This mints no new exit
code and changes none of the rows above.** Before it, seven of the nine
advertised formats were reachable only from the sibling
`python3 -m einvoice.report` entry point:

```
einvoice validate --format sarif invoice.xml > results.sarif   # 0 / 1 / 3
einvoice validate --format=junit invoice.xml > junit.xml
einvoice validate-batch --format junit invoices/ > junit.xml
```

| Code | When, with `--format` set | Stream |
|------|---------------------------|--------|
| `0` | No finding crosses `--fail-on` (default: no **fatal** finding). Identical to the same command without `--format`. | stdout: the report document (SARIF/JUnit/…); nothing on stderr. |
| `1` | A finding crosses the threshold. | stdout: the **complete** report document — a failing run still produces the artifact your CI wants to upload. |
| `2` | Usage error: an **unknown** format name (one `error: unknown format '<x>' (choose from json, junit, sarif, gitlab, github, azure, html, badge, text)` line); `--format` with no value; `--format` twice with **conflicting** values; `--format` **together with** `--json` (`--json` is the alias for `--format json`, so pass one); a single-invoice format on `validate-batch`; or a report format on a subcommand that validates nothing (`info`, `receipt`). Also every OS-level input problem from the code-`2` row above, for **every** format alike: stdout stays completely empty, so no half-written document can reach a parser. | stderr: one `error:` line plus the `usage:` banner. stdout empty. |
| `3` | Not-well-formed XML / unsupported container. | stdout: the report document carrying `"error": "not-well-formed"`, so a machine consumer gets a parseable document rather than only a stderr line. |

Scope and invariants:

- **`--format json` is an exact alias for `--json`** — the same code path, so the
  bytes are identical (`test_cli_help.py` and the task gate `cmp` both pin it).
  `--format text` is the default human summary. The other seven are rendered by
  `einvoice.report.render_report`, the single emitter dispatch
  `python3 -m einvoice.report --format <fmt>` itself uses, so the bodies agree by
  construction rather than by review.
- **The verdict is graded by `validate`'s own rules, not the report module's.**
  This matters because the two entry points differ on purpose: `einvoice
  validate` defaults to `--profile en16931`, while `python3 -m einvoice.report`
  defaults to `xrechnung`. On `examples/01-missing-fields/broken.xml` that is the
  difference between exit `0` and exit `1` (2 fatals: `BR-DE-2`, `BR-DE-15`). The
  profile the console script resolved is what grades the invoice, and
  syntax-binding findings stay non-blocking here exactly as they are in the
  text/JSON forms. Pass `--profile` explicitly whenever you compare the two
  surfaces.
- `--fail-on` applies unchanged; `--quiet` and `--lang` are no-ops for a machine
  format (the document *is* the output, and `--lang` only ever selected the human
  summary string) — identical to how both behave with `--json` today.
- `validate-batch` accepts the **aggregate-capable** subset — `json`, `junit`,
  `text` (`einvoice.report.BATCH_FORMATS`). The other six describe ONE invoice
  (one SARIF run, one Code-Quality array, one HTML page, one badge), so asking
  for them on a directory is a usage error (`2`) that names the per-file command
  instead of inventing an aggregate shape. The batch envelope keys are unchanged.
- The config-file `format` key still accepts only `text` / `json`: it is a
  project-wide default that also applies to `info` and `receipt --verify`, where
  a SARIF body is meaningless. An invalid value there keeps its historical
  `error: unknown format '<x>' in config …` message and exit `2`.

## `--explain <RULE-ID> [--lang=en|de]` — catalog lookup, no new code (additive)

`einvoice --explain BR-CO-15` prints the `remediation_catalog.json` entry for
one rule id: what it requires, the BT/BG business terms it touches, the XML
location hint, the one-line fix, the severity, and the official Schematron it
comes from. It reads **no** invoice, resolves no config, and produces no
verdict — so it mints **no new exit code**; it reuses three existing ones.

`--lang=en|de` (both spellings, `--lang de` and `--lang=de`, exactly as
`validate` takes it) selects the language of that block on **both** entry
points, `einvoice --explain` and `python3 -m einvoice.report --explain`; their
stdout stays byte-identical because both render through the one
`einvoice.report.format_explain`. An unknown value is the same usage error a bad
`validate --lang` value gives (`2` on the `einvoice` CLI). The default is `en`
and omitting the flag is byte-identical to the historical output.

| Code | When | Stream |
|------|------|--------|
| `0` | The rule id is in the catalog. Lookup is **case-insensitive** and the canonical id is echoed back. | stdout: the plain-text block. Nothing on stderr. |
| `1` | The rule id is **not catalogued** — or this installation has no readable `remediation_catalog.json` at all, which is reported as its own distinct line rather than blamed on your id. | stderr: one `error: unknown rule id '<id>' — not in the remediation catalog …` line. **stdout stays empty**, so `$(einvoice --explain …)` is safe to capture. |
| `2` | Usage error: `--explain` with no rule id after it, a rule id plus something else on the command line (it takes only the id and an optional `--lang`), a bare `--lang` with no value, or an unknown `--lang` value. | stderr: one `error:` line plus the `usage:` banner. |

The `1` here is deliberate rather than a fourth usage case: it is exactly what
`python3 -m einvoice.report --explain` has always returned, and the two entry
points share one implementation (`einvoice.report.format_explain`), so a script
that branches on the code behaves identically whichever it calls. Note the
asymmetry this creates on purpose — a **bad rule id** is `1` (the lookup ran and
found nothing), a **missing argument** is `2` (the lookup never ran).

Honest limit: `1` means "not in *our* catalog", not "not a real EN 16931 rule".
The catalog covers the rules this engine can fire; an id from a national CIUS
this build does not implement is a legitimate rule id and still exits `1`.
`einvoice info` prints how many business rules this build carries.

### What `--lang=de` actually gives you (measured German coverage)

`--lang de` does not translate anything at run time. It prints German strings
that are already committed in `remediation_catalog.json`, and the coverage is
uneven — so here is the whole truth, counted from the committed catalog:

| Catalog field | Rules carrying it | What that German actually is |
|---|---|---|
| `message_de` | 50 of 297 | The **official** German: the vendored **KoSIT** XRechnung `<sch:assert>` text, lifted **verbatim** and tagged with the `{artifact, assert_id}` it came from. Only the German-authored `BR-DE-*` family has one. |
| `de_source: kosit` | 50 of 297 | The same 50 rules — the tag that marks an entry as carrying official KoSIT German. |
| `de_source: translation` | 247 of 297 | Every other rule: its German is **project-authored translation** of our own English wording. No standards body wrote it, and it is labelled as ours wherever it is shown. |
| `title_de` | 297 of 297 | Present on every rule, but only KoSIT-official on the 50 above. |
| `fix_de` | 297 of 297 | Present on every rule, and **always** project-authored — even for the 50 KoSIT rules, because the fix line is our own "add the element at `<xpath>`" sentence with the official message quoted inside it. |

So in an `--explain <RULE-ID> --lang de` block: the header title and the `fix`
line come from `title_de` / `fix_de`; the `requires` line is resolved through the
same `einvoice.remediation.resolve_message` that `validate --lang de` uses, which
means it is the official KoSIT sentence for one of the 50 and stays **English**
for the other 247 rather than being invented; and a `german` line names which of
the two provenances you are looking at. Any field with no German string falls
back to its English text — nothing is machine-translated and no German rule text
is authored to fill a gap.

These counts are not prose kept by hand: `test_lang.py` re-reads this table and
the catalog and fails if they disagree, so a catalog change that is not
reflected here breaks the build rather than shipping a false claim. `README.md`
describes the same coverage from the `validate --lang de` side.

## Code `3` — unsupported PDF container on the single-file path (additive)

Measured 2026-07-17 and golden-pinned byte-for-byte by `test_golden_snapshot.py`
(against the committed deterministic corrupted fixture
`corpus/pdf/facturx-truncated.pdf`) plus `test_pdf_container.py` /
`test_fuzz_pdf_container.py` (against `no-embedded.pdf`, `encrypted.pdf`, and a
fixed-seed fuzz corpus of mangled containers):

- **Single-file `python3 -m einvoice.report <file.pdf>`** (every `--format`
  value): when the file carries the `%PDF-` magic but the zero-dependency
  extractor cannot reach the embedded e-invoice XML — the container is
  encrypted, has no `/EmbeddedFiles` name tree, is truncated / has no classic
  `trailer`, uses cross-reference-stream layout (PDF 1.5+), or an unknown
  stream filter — the run emits a **complete report document** carrying the
  literal error code **`unsupported-container`** (`valid: false`, zero counts,
  empty `violations`, and a `message` naming the concrete extractor reason)
  and exits **`3`** (`EXIT_PARSE`). This is the existing "could not reduce the
  input to a validatable invoice" error family — the same code as
  not-well-formed XML, deliberately **no new code minted**: the `error` field,
  not a distinct number, tells you *why*. Never `0` (a container we cannot
  open is never a false pass) and never a traceback. How the error appears in
  each machine format is specified in
  [REPORT-FORMATS.md](REPORT-FORMATS.md#unsupported-pdf-container).
- **`python3 -m einvoice validate <file.pdf>`** (the `cli.py` surface) since
  **0.2.7 (T-VHERG.5) dispatches on the same `%PDF-` magic** and grades the
  container itself, so the two single-file surfaces now agree. The container
  is reduced to its embedded invoice XML by the same zero-dependency
  `einvoice.pdf_container` extractor, and from that point the bytes travel the
  ordinary XML path — so the verdict, the default text summary, `--json` and
  all seven delegated `--format` values are produced by exactly the code that
  produces them for an XML file. Measured on the committed fixtures:
  `einvoice validate corpus/pdf/facturx-valid.pdf` exits `0` (the CLI default
  profile is `en16931`), the same file under `--profile=xrechnung` exits `1`
  (3 fatal, 2 warning), and a container the extractor cannot reach
  (`no-embedded.pdf`, `encrypted.pdf`, `facturx-truncated.pdf`) exits `3`
  carrying the same literal `unsupported-container` token — on stderr as an
  `S-CONTAINER:` line naming the concrete extractor reason, and under `--json`
  as `{"source", "valid": false, "error": "unsupported-container", "message"}`,
  the same four-key error object the not-well-formed arm already emits. **No
  new exit code is minted** and no second JSON shape is introduced. A PDF whose
  container opens but whose *embedded* XML is ill-formed still lands on the
  `S-WF` not-well-formed row (`3`), now with a hint saying the defect is in the
  attachment rather than the wrapper. A non-PDF, non-XML file is unaffected and
  keeps its existing wrong-file-type hint.
- **`python3 -m einvoice.report <file.pdf>`** remains fully supported and is
  still the only place `--baseline` / `--pretty` / `--recurse` live; it is no
  longer the *only* route to a container.
- **`validate-batch`**: unchanged, as already documented in the table above —
  an unsupported container is an *errored* file, and the batch returns `3`
  only when some file **only** errored and no file had a fatal (a fatal
  anywhere outranks it with `1`).

## Stability guarantee

These codes are an append-only contract:

- An existing code's meaning is **never repurposed**. `0/1/2/3` mean what the
  table above says in every future release.
- New terminal outcomes may only be assigned a **new, higher, previously-unused
  code** — existing codes are never split or reassigned.
- Widening validation coverage (new rules, new profiles) does not add codes: a
  new fatal rule still surfaces as `1`, a new parse rejection still as `3`.

## Honest note on unsupported / out-of-scope inputs

There is deliberately **no dedicated "unsupported input" code**. When the tool
is handed something it does not fully support — a document whose root element or
namespace is neither a UBL `Invoice`/`CreditNote` nor a CII `Invoice`, or a CII
document outside the implemented scope — it does **not** silently pass. Such
inputs trip a real structural fatal rule (typically `S-ROOT`, "Root element must
be Invoice in the UBL Invoice-2 namespace, or CreditNote in the UBL CreditNote-2
namespace") and therefore surface as exit `1` with an actionable `FAIL:` message
naming the failing rule and the offending element. (A UBL `CreditNote` is now a
*supported* root — it is really validated through the shared EN 16931 engine, so
an invalid CreditNote surfaces as exit `1` on its real business-rule fatal, not
on `S-ROOT`.)
A CII `CrossIndustryInvoice` is **not** one of those inputs and never reaches
`S-ROOT`. Up to 0.2.6 it did — raw CII XML got a dedicated `S-ROOT` variant
telling the caller to validate the Factur-X/ZUGFeRD PDF instead. Since 0.2.7 the
raw-XML surfaces dispatch a `CrossIndustryInvoice` root (matched by LOCAL NAME,
so a wrong-namespace root takes the same route) to the CII engine, so such a
file is graded on its real business rules and gets a real verdict. Measured:
`einvoice validate fixtures/creditnote-valid_cii.xml` exits `0` with `PASS:`,
and the same credit note with BT-5 removed exits `1` naming `BR-05` — never
`S-ROOT`, in text and `--json` form. `S-ROOT` now fires only on a root outside
both syntaxes (a `buildConfigurations` file someone pointed the CI gate at, say),
and there it carries the original, byte-frozen wording quoted above. Both halves
are pinned by `test_cli_cii_root.py` (`RawCiiIsGraded`, `UnsupportedRootStillRefused`).
The value to the caller is the same either way: a non-zero code plus a concrete,
greppable reason on stdout/stderr — never a false green. Folding these into the
existing `1` (rather than minting a new code) keeps the contract small and
honest; the message text, not a distinct number, tells you *why* it failed.

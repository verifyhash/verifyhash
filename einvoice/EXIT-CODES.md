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
| `0` | Success — no fatal violations. The invoice passed every implemented fatal rule (warnings/information do not affect the code). For `validate-batch`: every file passed, or the directory/glob matched no invoice files (`file_count: 0`). | `validate` on a conformant invoice; `receipt` whose verdict is `PASS`; `validate-batch` all-pass or empty match. | stdout: `PASS: <src> (all implemented fatal rules, profile=<p>)`. |
| `1` | Not-valid verdict — at least one implemented **fatal** rule failed. This is also where **unsupported / out-of-scope inputs land** (see note below): they are not a separate code, they trip a real fatal rule (e.g. a wrong root namespace fails `S-ROOT`). A UBL `CreditNote` is now really validated through the shared engine, so an invalid one fails on its real business rule here too. For `receipt`: a `FAIL` verdict, *including* not-well-formed input, which `receipt` folds into a FAIL receipt rather than exit 3. For `validate-batch`: ANY file has a fatal violation (fatal outranks a parse error). | `validate` on an invoice or CreditNote with a fatal violation, or an out-of-scope document type; `receipt` FAIL; `validate-batch` any-fatal. | stdout: `FAIL: <src>` then `<RULE-ID>: <message>` and `offending element: <el>` (the first fatal rule id, e.g. `S-ROOT`). |
| `2` | Usage error — the tool was invoked wrong and did no validation. Bad or missing arguments, an unknown subcommand, an unknown `--profile` / `--lang` value, a `--profile`/`--lang` flag with no value, unexpected extra arguments, or a named input file that does not exist on disk. | `validate`/`validate-batch`/`receipt` with malformed argv or a missing file. | stderr: `error: <what>` and/or the `usage:` banner. |
| `3` | Not-well-formed input — the XML could not be parsed (truncated document, syntax error, or an input rejected by the hardened DTD/XXE parser). `validate` only. `receipt` folds this case into a FAIL receipt (exit `1`); `validate-batch` returns `3` only when some file *only* errored (not-well-formed / unsupported container) and no file had a fatal. | `validate` on malformed XML; `validate-batch` error-only, no-fatal. | stderr: `S-WF: input is not well-formed XML: <parser detail>`. |
| `141` | Broken pipe — the stdout **consumer closed early** (`… \| head`, a dying `jq`, a closed CI log pipe) while the CLI was still writing its report. `141 = 128 + SIGPIPE(13)`, the standard shell convention for a pipe-killed process. The CLI exits **quietly**: no traceback, nothing further written to stdout. The verdict for that run is simply unavailable — the reader walked away mid-report; codes `0/1/2/3` are untouched. See the section below. | Any subcommand whose stdout write raises `BrokenPipeError` — in practice a large `validate-batch` report (text or `--json`) piped into a reader that exits before consuming it all. | stderr: *(nothing — deliberately silent; a broken pipe is the caller's plumbing, not a validation outcome)*. |
| `130` | Interrupted — **SIGINT** (Ctrl-C) aborted the run mid-validation. `130 = 128 + SIGINT(2)`, the standard shell convention for an interrupted process. The CLI exits **quietly**: no Python traceback, nothing further written, and the `validate -` stdin temp file is removed on the way out. The verdict for the aborted run is simply unavailable; codes `0/1/2/3/141` are untouched. See the interrupt section below. | Any subcommand hit by SIGINT / Ctrl-C while running (`validate`, `validate-batch`, `receipt`). | stderr: *(nothing — an interrupt is the operator's action, not a validation outcome)*. |
| `143` | Terminated — **SIGTERM** (e.g. a CI timeout kill, `kill <pid>`, container stop) aborted the run. `143 = 128 + SIGTERM(15)`, the standard shell convention for a terminated process. The entry point converts the signal into an exception so the same temp-file cleanup runs, then exits **quietly** with this code — no traceback, no stray `einvoice-stdin-*` file. See the interrupt section below. | Any subcommand hit by SIGTERM while running. | stderr: *(nothing)*. |

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
The value to the caller is the same either way: a non-zero code plus a concrete,
greppable reason on stdout/stderr — never a false green. Folding these into the
existing `1` (rather than minting a new code) keeps the contract small and
honest; the message text, not a distinct number, tells you *why* it failed.

# CI conformance gate

Drop-in recipes that make a build **fail** whenever an invoice in your repo
has a **fatal** EN 16931 / XRechnung violation — with the **violated rule ID**
(e.g. `BR-DE-15`) named in the job log **and** a per-invoice JUnit report your
CI can render as failed tests. This is the "your invoices can never regress
below conformance" gate an ERP/billing vendor wires in once.

Honest scope first: the gate checks the validator's **implemented** rules
(43 EN 16931 core + all 32 XRechnung `BR-DE-*`; each differential-proven at
100% agreement against the official Schematron). It does **not** check the
~155 unimplemented core rules — a green gate means "no implemented rule
fired", not "legally conformant". See [`../README.md`](../README.md) §2.

Safe on untrusted input: because supplier XML runs through this gate in CI, the
validator parses with the Python standard library only — no external-entity or
external-DTD resolution (no XXE file-read/SSRF), and DTD/entity expansion is
rejected (billion-laughs / quadratic-blowup payloads abort in bounded time), so
a hostile invoice becomes an ordinary not-well-formed error (exit `3`), never a
crash or silent pass. Details: [`../SECURITY.md`](../SECURITY.md) §"Untrusted
input / XML entity handling".

## The entrypoint it drives

Under the hood the gate calls the real conformance-report entrypoint, once per
invoice:

```
python3 -m einvoice.report [--profile en16931|xrechnung] [--format json|junit] [--pretty] [--baseline <prev-report.json>] <invoice.xml>
```

- `--profile` — `xrechnung` (default; core + the German CIUS `BR-DE-*` layer)
  or `en16931` (core rules only).
- `--format` — `json` (default) or `junit`. `json` emits a single versioned
  document (`einvoice-conformance-report/v1`) to **stdout**; `junit` emits a
  JUnit XML document instead. Both carry the **same** validator outcome and the
  **same** exit code — `junit` is just the projection CI dashboards understand.
  `--format junit` is **not** compatible with `--baseline`.
- `--pretty` — indent the JSON (ignored for `junit`).
- `--baseline <prev-report.json>` — adoption on-ramp; see below.

**Exit-code contract** (identical for `json` and `junit`, and what the gate
relies on):

| code | meaning |
|---|---|
| `0` | **no fatal** violation — the invoice is valid (warnings/information do not fail it, per the Schematron `flag` semantics) |
| `1` (non-zero) | at least one **fatal** violation |
| `3` (non-zero) | input is **not well-formed XML** |

The JSON form additionally exposes `valid`, `fatal_count`, `warning_count`,
`violation_count`, and a `violations[]` list of `{rule, severity, message,
field}` records. It also carries the distinct **syntax-binding** category —
a `syntax_bindings[]` list plus `syntax_binding_fatal_count` /
`syntax_binding_warning_count` — the UBL/CII `UBL-CR-*`/`CII-*` syntax-layer
asserts (see [`../COVERAGE.md`](../COVERAGE.md)). These are advisory warnings:
they do **not** affect the exit code the gate relies on. Full schema:
[`../REPORT-SCHEMA.md`](../REPORT-SCHEMA.md).

## Files

| File | What it is |
|---|---|
| `validate-invoices.sh` | the gate itself — POSIX sh, zero deps beyond python3 |
| `github-actions.yml` | copy to `.github/workflows/invoice-conformance.yml` |
| `gitlab-ci.yml` | merge the job into your `.gitlab-ci.yml` |
| `pre-commit-einvoice.sh` | local git pre-commit hook — block a bad invoice before it is committed |
| `.pre-commit-config.yaml` | opt-in [pre-commit framework](https://pre-commit.com) wiring for that hook |

## 60-second install (any CI)

1. **Vendor the validator** into your repo (it is not on PyPI yet — publishing
   is a deliberate not-yet): copy this product directory (the parent of
   `ci/`) to `third_party/einvoice/`, or add it as a git subtree/submodule.
2. **Install it** in the CI job — zero runtime dependencies, stdlib only. This
   is what makes `python3 -m einvoice.report` importable:

   ```sh
   python3 -m pip install ./third_party/einvoice
   ```

   (Skippable: run from the vendored dir so the package is on `sys.path`, or set
   `EINVOICE_CMD="python3 -m einvoice.report"` with `PYTHONPATH` pointed at the
   vendored source — no install step at all.)
3. **Run the gate** over your invoice files/fixtures:

   ```sh
   sh third_party/einvoice/ci/validate-invoices.sh invoices/
   ```

   Directories are searched recursively for `*.xml`. Each invoice's JUnit
   report is written into `EINVOICE_RESULTS_DIR` (see Knobs); point your CI's
   test-report upload at that directory.

## What failure looks like

```
FAIL: invoices/2026-04-017.xml
  BR-DE-15
  JUnit: einvoice-junit/3_invoices_2026-04-017.xml.junit.xml
conformance gate: 1/12 invoice(s) NON-CONFORMANT (profile=xrechnung) — FAIL
```

…and the job exits `1`, so the build is red until the invoice is fixed. The
matching JUnit file carries the full Schematron message and the offending
XPath as a `<failure>`, e.g.:

```xml
<testcase name="BR-DE-15" classname="xrechnung">
  <failure message="The element 'Buyer reference' (BT-10) must be transmitted.">fatal: cbc:BuyerReference</failure>
</testcase>
```

A not-well-formed invoice exits `3` and renders as a single
`<testcase name="not-well-formed">` with an `<error>`.

## Knobs

| Env var | Default | Meaning |
|---|---|---|
| `EINVOICE_PROFILE` | `xrechnung` | `xrechnung` = core + German CIUS layer; `en16931` = core only |
| `EINVOICE_CMD` | auto | override the **report** command (must invoke `einvoice.report`; the gate appends `--profile <p> --format junit <file>`) |
| `EINVOICE_RESULTS_DIR` | temp dir | directory for the per-invoice JUnit XML. When **set**, the files are kept for your CI to upload; when unset, a throwaway dir is used and removed on exit |
| `EINVOICE_ALLOW_EMPTY` | `0` | by default the gate exits `2` when it finds **no** `*.xml` — an empty gate is a broken gate |

Gate exit codes: `0` all conformant, `1` at least one fatal or malformed
invoice, `2` the gate itself is misconfigured (no importable entrypoint, no
input, bad profile). Only fatal-severity rules fail the build —
warnings/information (the official Schematron `flag` semantics) do not.

## Git pre-commit hook (block a bad invoice before it lands)

`pre-commit-einvoice.sh` moves the same check to the commit boundary: it runs
the **real `python3 -m einvoice.report` entrypoint** — the identical validator
this CI gate drives — over the `*.xml` files **staged** for a commit, and
exits non-zero (blocking the commit) if any staged invoice has a **fatal**
violation, printing the offending rule id(s). A commit that stages no invoice
XML is untouched: the hook is inert and exits `0`.

**Nothing is installed automatically.** A repo gets this hook only if a
developer opts in, one of two ways:

- **Plain git hook** — copy the script into your repo's hooks dir and mark it
  executable:

  ```sh
  cp third_party/einvoice/ci/pre-commit-einvoice.sh .git/hooks/pre-commit
  chmod +x .git/hooks/pre-commit
  ```

  With no arguments it resolves the staged, added/copied/modified `*.xml`
  itself (`git diff --cached --name-only --diff-filter=ACM`).

- **pre-commit framework** ([pre-commit.com](https://pre-commit.com)) — merge
  the `repos:` entry from [`.pre-commit-config.yaml`](./.pre-commit-config.yaml)
  into your repo's `.pre-commit-config.yaml`, adjust `entry:` to wherever you
  vendored the script, then run `pre-commit install` yourself. It is scoped to
  `files: \.xml$` and passes the staged filenames to the script as arguments.

Test it without committing by passing files explicitly (this is exactly what
the framework does under the hood):

```sh
sh ci/pre-commit-einvoice.sh path/to/invoice.xml        # exit 1 if it is bad
```

It honors the same `EINVOICE_PROFILE` (default `xrechnung`) and `EINVOICE_CMD`
overrides as `validate-invoices.sh`, and reuses the report entrypoint's exit
codes verbatim (`0` clean, `1` fatal violation, `3` not well-formed) — it never
re-implements validation. Bypass in an emergency with `git commit --no-verify`.

## Adoption on-ramp: gate on regressions only (`--baseline`, T-VH.22)

A hard gate ("any fatal fails the build") is often too strict to switch on over
a pipeline that **already** carries known violations. Instead of this gate,
drive the report entrypoint's baseline diff mode: capture a baseline once, then
fail the build **only when a new fatal appears**, tolerating the pre-existing
backlog.

```sh
# capture a baseline once (commit the JSON):
python3 -m einvoice.report --format json invoices/x.xml > baseline.json
# then gate every build against it — exit 1 ONLY on a NEW fatal:
python3 -m einvoice.report --baseline baseline.json invoices/x.xml
```

`--baseline` re-validates the current invoice (it adds no rule logic), diffs
the two violation sets, and exits `0` when there are zero **new** fatals,
`1` on a regression, `3` on not-well-formed input. It emits its own versioned
diff document (`einvoice-conformance-diff/v1`); it is **not** compatible with
`--format junit`. See [`../REPORT-SCHEMA.md`](../REPORT-SCHEMA.md) §"Baseline
diff mode".

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
field}` records. Full schema: [`../REPORT-SCHEMA.md`](../REPORT-SCHEMA.md).

## Files

| File | What it is |
|---|---|
| `validate-invoices.sh` | the gate itself — POSIX sh, zero deps beyond python3 |
| `github-actions.yml` | copy to `.github/workflows/invoice-conformance.yml` |
| `gitlab-ci.yml` | merge the job into your `.gitlab-ci.yml` |

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

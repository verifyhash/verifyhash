# CI conformance gate

Drop-in recipes that make a build **fail** whenever an invoice in your repo
has a **fatal** EN 16931 / XRechnung violation — with the **violated rule ID**
(e.g. `BR-DE-15`) named in the job log **and** a per-invoice JUnit report your
CI can render as failed tests. This is the "your invoices can never regress
below conformance" gate an ERP/billing vendor wires in once.

Honest scope first — the same scope
[`../action/README.md`](../action/README.md) states, because it is the same
engine. The validator asserts **297 business rules** in total: 219 of the 223
official EN 16931 `BR-*` rule ids in each syntax universe (UBL and CII) — the
remaining 4 per syntax (`BR-CO-05`, `BR-CO-06`, `BR-CO-07`, `BR-CO-08`) are
documented deliberate exclusions, not gaps that quietly went missing — plus,
under `--profile xrechnung`, the German XRechnung CIUS + extension layer
(`BR-DE-*`, `BR-DE-CVD-*`, `BR-TMP-*`, `BR-DEX-*`) and the 21 KoSIT-vendored
`PEPPOL-EN16931-R*` rules. Each implemented rule is differential-tested to 0
divergences against the official Schematron **within the implemented set**.
Three limits that stay true no matter how green the build is:

- A green gate means "no *implemented* rule fired" — **not** legal EN 16931
  conformance. It is a regression fence, not a compliance certificate.
- **No XSD structural validation is performed.** The gate checks business
  rules; it does not check the document against the UBL 2.1 / CII schema, so a
  structurally invalid document that no business rule happens to catch still
  exits `0`.
- The PEPPOL layer is exactly those 21 `PEPPOL-EN16931-R*` rules vendored from
  the KoSIT XRechnung distribution — **not** Peppol BIS Billing 3.0, whose
  wider rule set this gate does not claim.

See [`../README.md`](../README.md) §2.

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

## Where paths resolve

Neither shell script ever changes directory (`cd` appears in neither), so both
resolve every path you hand them — and every path they print — **relative to the
directory you invoke the script from**, i.e. the invoker's current working
directory. Never relative to where the script, or the vendored package, happens
to live. That is the whole contract; the two documented invocations follow from
it:

- `sh third_party/einvoice/ci/validate-invoices.sh invoices/` assumes you are
  standing at your **repository root** — that is the one directory where both
  `third_party/einvoice/ci/…` and `invoices/` exist; run it from a subdirectory
  and it looks for `<subdir>/invoices/`, prints `no such file or directory` and
  exits `2`.
- The **pre-commit hook** needs no such care: git runs hooks with the top level
  of the working tree as the cwd, so the repo-root-relative paths it gets from
  `git diff --cached --name-only` already resolve.

(`EINVOICE_CMD` and `PYTHONPATH` below select *which* validator runs; they have
no effect on where paths resolve from.)

## 60-second install (any CI)

1. **Install the validator** in the CI job — from PyPI, zero runtime
   dependencies, stdlib only. This is what makes `python3 -m einvoice.report`
   importable. The distribution is named **`verifyhash-einvoice`**; the bare
   name `einvoice` on PyPI is an unrelated third-party package, so never
   install that one:

   ```sh
   python3 -m pip install verifyhash-einvoice
   ```

2. **Offline / air-gapped alternative — vendor the validator** instead. If your
   runners have no package-index access, or you want the validated tree pinned
   byte-for-byte in your own repo, copy this product directory (the parent of
   `ci/`) to `third_party/einvoice/` — or add it as a git subtree/submodule —
   and install that copy (again from your repository root — `pip` reads
   `./third_party/einvoice` relative to your cwd like everything else here):

   ```sh
   python3 -m pip install ./third_party/einvoice
   ```

   (Skippable: run from the vendored dir so the package is on `sys.path`, or set
   `EINVOICE_CMD="python3 -m einvoice.report"` with `PYTHONPATH` pointed at the
   vendored source — no install step at all.)

   The shipped `github-actions.yml` / `gitlab-ci.yml` templates use this
   vendored form by default, because it is the variant that works everywhere;
   each carries the PyPI one-liner as a commented alternative.
3. **Run the gate** over your invoice files/fixtures, **from your repository
   root** (see [Where paths resolve](#where-paths-resolve) — both the script
   path and `invoices/` are read from your cwd). The gate script is copied into
   your repo alongside the vendored directory, and the path below assumes that
   layout; it only shells out to `python3 -m einvoice.report`, so it works the
   same whichever way the validator was installed:

   ```sh
   sh third_party/einvoice/ci/validate-invoices.sh invoices/
   ```

   Directories are searched recursively for `*.xml`. Each invoice's JUnit
   report is written into `EINVOICE_RESULTS_DIR` (see Knobs); point your CI's
   test-report upload at that directory.

## Run in CI without installing (bare checkout)

If all you need is a **red build when any invoice is non-conformant** — no
JUnit artifacts, no `EINVOICE_CMD` plumbing — you can skip the install step
entirely and drive the batch validator straight from a bare checkout of this
directory. This is the one recipe on this page that is **not** run from your
repository root: `cd` into `einvoice/` first (the directory that holds the
`einvoice/` package folder — e.g. `cd third_party/einvoice`), because
`python3 -m einvoice` has to find the package on `sys.path[0]`, which is the
cwd. Your `<dir|glob>` argument is then read relative to *that* directory too:

```sh
python3 -m einvoice validate-batch '<dir|glob>'
```

- `<dir|glob>` is one directory (walked recursively for `*.xml`) **or** one
  shell-style glob (e.g. `'invoices/**/*.xml'`, quoted so the shell does not
  pre-expand it), read relative to the directory you just `cd`-ed into. Concrete
  consequence of that: if you vendored to `third_party/einvoice`, your repo's
  own `invoices/` is `'../../invoices/**/*.xml'` from here — pass an absolute
  path if that bookkeeping annoys you, or use the `validate-invoices.sh` gate
  above, which is the recipe you drive from the repo root. Add
  `--profile xrechnung` for the German CIUS layer (`--profile en16931` is the
  default: core rules only).
- **Zero runtime dependencies**: it imports the Python **standard library
  only**, so a checkout plus any `python3` >= 3.8 is the whole toolchain — no
  `pip install`, no `PYTHONPATH`, no virtualenv, no container, offline. This is
  the same claim `test_packaging.py` pins. (You run from the package's parent
  dir so `python3 -m einvoice` is importable off `sys.path[0]` — that is the
  only setup.)

**Exit-code contract** (what the build gate keys on — one code for the whole
batch):

| code | meaning |
|---|---|
| `0` | **no fatal** across **all** files — every invoice passed its implemented fatal rules |
| `1` (non-zero) | **at least one** file has a fatal violation |
| `3` (non-zero) | no fatal, but **at least one** file was not well-formed XML / could not be parsed |

So a non-zero exit means "at least one file had a fatal or a parse error";
treat any non-zero as a failed gate. The human summary lists every file as
`PASS` / `FAIL` / `ERROR` and prints the aggregate `N files: X passed, Y
failed  (F fatal, W warning across all files)`.

Same honest scope as the rest of this gate: a `0` means **no implemented rule
fired**, not legal EN 16931 conformance — the 4 deliberately excluded `BR-*`
ids per syntax are not asserted, and no XSD structural validation happens
here either. See the scope note above and [`../README.md`](../README.md) §2.

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
the framework does under the hood) — again from your repository root, so both
the script path and the invoice path resolve:

```sh
sh third_party/einvoice/ci/pre-commit-einvoice.sh path/to/invoice.xml   # exit 1 if bad
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

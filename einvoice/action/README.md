# einvoice conformance — composite GitHub Action

A reusable GitHub Action that validates your EN 16931 / XRechnung invoices on
every push and pull request and surfaces each finding as an **inline PR
annotation** via SARIF. It is a thin wrapper around the real conformance-report
entrypoint — `python3 -m einvoice.report` — and adds **no** second validation
engine and **no** new output format.

If you only want a copy-paste workflow that fails the build and uploads a JUnit
report (no Action, no SARIF), use the recipe in [`../ci/`](../ci/README.md)
instead. This Action is the packaged, `uses:`-pinnable version whose extra value
is the SARIF upload → inline annotations.

## What it does

For each invoice under `path` the runner ([`run.py`](run.py)) invokes the real
entrypoint, merges the per-file SARIF 2.1.0 documents into one, writes that file
for `github/codeql-action/upload-sarif`, and sets the job exit code so the build
fails per `fail-on`. It re-implements no rules: every verdict comes from
`python3 -m einvoice.report`.

## Inputs

| input | default | description |
|---|---|---|
| `path` | `.` | File or directory of invoices. A directory is walked recursively for `*.xml` (UBL/CII) and `*.pdf` (Factur-X/ZUGFeRD); dotfiles are skipped — the same selection the entrypoint's own batch mode makes. |
| `format` | `sarif` | Report format written to the **job log**: `json` \| `junit` \| `sarif` \| `text`. A merged SARIF file is **always** written for upload regardless of this choice. |
| `fail-on` | `fatal` | Severity that fails the build. `fatal` = fail on any fatal violation (the entrypoint's own exit contract). `warning` = *also* fail when a warning-severity finding is present. |
| `sarif-file` | `einvoice.sarif` | Path the merged SARIF document is written to. |
| `profile` | `xrechnung` | `xrechnung` (EN 16931 core + the German `BR-DE-*` CIUS) or `en16931` (core rules only). |

### Outputs

| output | description |
|---|---|
| `sarif-file` | Absolute path to the merged SARIF file — feed it to `codeql-action/upload-sarif`. |

## How `fail-on` maps to the exit code

The runner never invents a severity flag. It reads the contract the entrypoint
already exposes:

- `python3 -m einvoice.report --format sarif <file>` exits **1** on a fatal
  violation, **3** on unparseable / unsupported input, **0** otherwise. Fatals
  are counted from the SARIF `level: "error"` results.
- For **`fail-on: warning`** the runner parses the JSON report the entrypoint
  emits (`--format json` → `warning_count`) to detect warning-severity findings
  — there is no `--warning` engine flag, and none was added.
- The report's distinct **syntax-binding** category (`syntax_bindings[]` +
  `syntax_binding_warning_count` — the `UBL-CR-*`/`CII-*` syntax-layer asserts)
  is advisory only and is **not** counted by `fail-on`: it never affects the
  exit code, so this Action's build verdict is unchanged by it. See
  [`../REPORT-SCHEMA.md`](../REPORT-SCHEMA.md).

Result: `fail-on: fatal` fails only on fatals (exit 1) or unparseable files
(exit 3); `fail-on: warning` additionally fails (exit 1) when any warning is
present. An empty directory validates nothing and passes (exit 0), reported
honestly in the log.

## SARIF → inline annotations

```yaml
name: invoice-conformance
on: [push, pull_request]

permissions:
  contents: read
  security-events: write   # required for upload-sarif

jobs:
  conformance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - id: einvoice
        # `main` tracks the tip; swap it for a full 40-char commit SHA to pin.
        uses: verifyhash/verifyhash/einvoice/action@main   # see "Pinning & vendoring"
        with:
          path: invoices/
          fail-on: fatal
          # format: sarif   # default; a SARIF file is written either way

      # Upload even when the previous step failed the build, so the findings
      # still appear inline on the PR.
      - if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: ${{ steps.einvoice.outputs.sarif-file }}
```

`security-events: write` is what lets `upload-sarif` post the findings; without
it the upload step is rejected by GitHub. Code scanning renders each SARIF
result (rule id, message, remediation hint, business terms) as an annotation on
the offending file.

## Pinning & vendoring (the version story)

**There are no release tags today.** `git ls-remote --tags
https://github.com/verifyhash/verifyhash` returns nothing, so any `@v1` /
`@v1.2.0`-shaped reference you may have seen elsewhere would fail to resolve.
The two refs that actually work are the branch and a commit SHA:

```yaml
uses: verifyhash/verifyhash/einvoice/action@main             # tracks the tip, or
uses: verifyhash/verifyhash/einvoice/action@<40-char-sha>    # reproducible (recommended)
```

- **`@main`** — always the newest committed Action *and* the newest committed
  rule set. Fine for trying it out; it is a moving target, so a rule landing
  upstream can change your build's verdict without a change on your side.
- **`@<40-char-sha>`** — a full commit SHA from
  `github.com/verifyhash/verifyhash/commits/main`. Immutable: the Action code
  and the validator behind it are frozen at exactly that commit. Use this in
  any repo where a reproducible build matters.

Note the three-segment path: the Action is **not** a standalone repository, so
`uses:` names `<owner>/<repo>/<subdirectory>@<ref>` — GitHub's documented form
for an Action living in a subdirectory of another repo. If release tags are
published later this section will name them; until then, treating a `v*` ref as
valid is the one mistake to avoid.

**How the package ships with the Action.** The Action lives in the
`einvoice/action/` subdirectory of this monorepo — the same repository that
holds the zero-dependency `einvoice` Python package at `einvoice/`. At run time
`run.py` walks up from its own location to find that sibling package (override
with `$EINVOICE_ROOT`) and drives `python3 -m einvoice.report` against it. There
is nothing to `pip install` — the runner uses only the Python standard library,
and the validator itself has zero runtime dependencies. Because the package
lives in the same commit as the Action, pinning the ref pins the exact validator
(and therefore the exact rule set) your build runs against. That is deliberate:
an invoice that passes on a SHA pin keeps passing on that pin even as new rules
land upstream.

The same walk-up is what makes the Action work when you *vendor* the product
into your own repo (e.g. at `third_party/einvoice/`): point `uses:` at the local
directory — `uses: ./third_party/einvoice/action` — and `run.py` finds the
vendored package next to itself, no `pip install` and no network fetch.

To adopt newer rules, bump the pin and re-run — a diff in findings is then an
explicit, reviewable change rather than a silent drift.

## Honest scope

- The validator asserts **297 business rules** in total: 219 of the 223
  official EN 16931 `BR-*` rule ids in each syntax universe (UBL and CII),
  plus — with `--profile=xrechnung` — the German XRechnung CIUS + extension
  layer (`BR-DE-*`, `BR-DE-CVD-*`, `BR-TMP-*`, `BR-DEX-*`) and the 21
  KoSIT-vendored `PEPPOL-EN16931-R*` rules. Each implemented rule is
  differential-tested to 0 divergences against the official Schematron
  **within the implemented set**; every fireable `BR-CL-*` code-list check
  is now implemented in both syntaxes.
  See [`../README.md`](../README.md) §2 and
  [`../CORRECTNESS.md`](../CORRECTNESS.md) for what is NOT covered.
  A green gate means "no *implemented* rule fired", **not** "legally
  conformant". Treat it as a regression fence, not a compliance certificate.
- `sarif` output is single-file in the engine; for a directory this Action
  merges the per-file SARIF documents itself (pure aggregation — no result is
  dropped, relabelled, or synthesised). The `json` / `junit` / `text` log
  formats use the engine's native `--recurse` batch mode.
- Factur-X / ZUGFeRD PDFs are validated by the same zero-dependency container
  extractor the entrypoint uses; a container it cannot open zero-dep is reported
  as an error (build fails), never a false pass.
- **Safe to run on untrusted supplier XML** — CI is exactly where untrusted
  invoices flow. The validator parses with the Python standard library only (no
  external-entity or external-DTD resolution, so no XXE file-read/SSRF; DTD and
  entity expansion are rejected, so billion-laughs/quadratic-blowup payloads
  abort in bounded time); a hostile document becomes an ordinary error (build
  fails), never a crash or silent pass. See
  [`../SECURITY.md`](../SECURITY.md) §"Untrusted input / XML entity handling".

## Publishing is human / supervisor

This directory only *commits* the Action definition (`action.yml`), the runner
(`run.py`), and this README. **Tagging a release and listing on the GitHub
Marketplace are performed by a human / the supervisor at a run boundary** — the
build loop never pushes tags or publishes. That is why no release tag exists
yet, and why the pins documented above are `main` and commit SHAs.

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
        uses: verifyhash/einvoice-action@v1   # pin — see "Pinning & vendoring"
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

**Pin the Action to a tag, never a branch.** A consumer references it as:

```yaml
uses: verifyhash/einvoice-action@v1     # moving major tag, or
uses: verifyhash/einvoice-action@v1.2.0 # exact release, or
uses: verifyhash/einvoice-action@<40-char-sha>  # strictest (immutable)
```

- **`@v1`** — a *moving* major tag that the maintainers advance to the latest
  compatible release. Convenient; you trust the maintainer not to ship a
  breaking change under the same major.
- **`@v1.2.0`** — an exact, immutable-by-convention release tag. Reproducible
  until you deliberately bump it.
- **`@<sha>`** — pin to a commit SHA for a fully immutable reference (a tag can,
  in principle, be moved; a SHA cannot). Recommended for supply-chain-strict
  repos.

**How the package ships with the Action.** The Action repository
(`verifyhash/einvoice-action`) vendors the zero-dependency `einvoice` Python
package alongside this `action/` directory, so at run time `run.py` locates the
package by walking up from its own location (override with `$EINVOICE_ROOT`) and
drives `python3 -m einvoice.report` against it. There is nothing to `pip
install` — the runner uses only the Python standard library, and the validator
itself has zero runtime dependencies. Because the package travels *inside* the
pinned tag/SHA, pinning the Action pins the exact validator (and therefore the
exact rule set) your build runs against. That is deliberate: an invoice that
passes today keeps passing on the same pin even as new rules land upstream.

To adopt newer rules, bump the pin and re-run — a diff in findings is then an
explicit, reviewable change rather than a silent drift.

## Honest scope

- The validator implements **50 of ~200** EN 16931 core rules plus the **32**
  national `BR-DE-*` XRechnung CIUS asserts, each differential-tested to 100%
  agreement with the official Schematron **within that implemented subset**
  (`BR-DEX-*` / `BR-DE-CVD-*` are **not** yet implemented). See
  [`../README.md`](../README.md) and [`../CORRECTNESS.md`](../CORRECTNESS.md).
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
(`run.py`), and this README. **Tagging a release, moving the `@v1` major tag,
and listing on the GitHub Marketplace are performed by a human / the supervisor
at a run boundary** — the build loop never pushes tags or publishes.

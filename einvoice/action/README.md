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
| `format` | `sarif` | Report format written to the **job log**, one of: `json`, `junit`, `sarif`, `github`, `text`. `github` emits native GitHub workflow commands (`::error file=…,title=…::…`) that annotate the PR inline **without** the `security-events: write` permission `upload-sarif` needs — see [below](#inline-annotations-without-security-events-format-github). A merged SARIF file is **always** written for upload regardless of this choice. |
| `fail-on` | `fatal` | Severity that fails the build. `fatal` = fail on any fatal violation (the entrypoint's own exit contract). `warning` = *also* fail when a warning-severity finding is present. |
| `sarif-file` | `einvoice.sarif` | Path the merged SARIF document is written to. |
| `profile` | `xrechnung` | `xrechnung` (EN 16931 core + the German `BR-DE-*` CIUS) or `en16931` (core rules only). |

### Where a relative `path:` resolves

`path:` may be written absolute or relative. A **relative** `path:` is resolved
**relative to the directory the step runs in** — the runner process's working
directory. On GitHub that directory is **`$GITHUB_WORKSPACE`**, the checkout
root `actions/checkout` populates: this is a composite action whose only step
declares no `working-directory:`, and a workflow's
`defaults.run.working-directory` does not reach inside a composite action. So
`path: invoices/` means `$GITHUB_WORKSPACE/invoices` — the `invoices/` directory
at the root of *your* repository, never one inside this Action's own checkout.

The identical rule — process working directory — is what applies everywhere
else: under [`act`](https://github.com/nektos/act), under GitLab (where
`$CI_PROJECT_DIR` is the job's working directory), and in a plain local
`python3 action/run.py --path invoices/`. There is no second rule and no
`$GITHUB_WORKSPACE` special case in the resolution itself; `$GITHUB_WORKSPACE`
is just what that directory is called on GitHub. An **absolute** `path:` (e.g.
`/mnt/shared/invoices`) is used exactly as written, and nothing depends on where
the Action itself was checked out.

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

**Path semantics.** Code scanning resolves every result location against the
root of the checked-out repository, so the merged document reports each invoice
as a workspace-relative, forward-slashed URI (`invoices/2024-08-acme.xml`)
anchored to a `%SRCROOT%` `uriBaseId` that `runs[0].originalUriBaseIds` maps to
the absolute workspace (`file:///home/runner/work/repo/repo/`). The workspace
those URIs are made relative to is `$GITHUB_WORKSPACE` when set, otherwise the
process working directory — on every runner listed above, the **same** directory
a relative `path:` resolves against ([the input contract
above](#where-a-relative-path-resolves)). So the same output comes out under
GitHub, [`act`](https://github.com/nektos/act) and a plain local run, and
`path:` may be written absolute or relative without changing what gets
annotated. (The one way to pull the two apart is to set `$GITHUB_WORKSPACE` by
hand to a directory the step does *not* run in: `path:` would still resolve
against the step's working directory while URIs were made relative to your
value. Don't.) Honest limit: an invoice that lies **outside** the
workspace (say `path: /mnt/shared/invoices`) keeps its absolute URI and no base
id, because a `../`-escaping relative path is not resolvable by code scanning at
all — those findings are in the SARIF and in the job log, but GitHub will not
render them as inline annotations, since there is no tracked file to attach them
to.

## Inline annotations without `security-events` (`format: github`)

`security-events: write` is not available everywhere: pull requests from forks
get a read-only `GITHUB_TOKEN`, many orgs pin workflow permissions by policy,
and code scanning on private repos requires GitHub Advanced Security. In those
repos the `upload-sarif` step above fails and you get no inline feedback at all.

`format: github` is the fallback that needs **no** extra permission. The engine
writes GitHub's own [workflow
commands](https://docs.github.com/actions/using-workflows/workflow-commands-for-github-actions)
to stdout — one line per finding, fatals as `::error`, warnings as `::warning`:

```
::error file=invoices/2024-08-acme.xml,title=BR-DE-2::The group 'SELLER CONTACT' (BG-6) must be transmitted.
::error file=invoices/2024-08-acme.xml,title=BR-DE-15::The element 'Buyer reference' (BT-10) must be transmitted.
```

Copy-pasteable workflow:

```yaml
name: invoice-conformance
on: [push, pull_request]

permissions:
  contents: read          # no security-events: write needed

jobs:
  conformance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: verifyhash/verifyhash/einvoice/action@main
        with:
          path: invoices/
          format: github
          fail-on: fatal
```

Honest limits of this mode, so you can pick deliberately:

- Annotations are attached to the **file and rule title only** — the engine's
  `github` renderer emits `file=` and `title=`, not `line=`/`col=`, because a
  business-rule violation like BR-DE-15 ("Buyer reference must be transmitted")
  is about a *missing* element and has no honest line number. SARIF + code
  scanning is still the richer surface where you can use it.
- Annotations are ephemeral: they live on that check run, not in a code-scanning
  database, so there is no alert history, no dismiss workflow, and no trend.
- GitHub caps rendered annotations at **10 per level per step** (errors,
  warnings, notices counted separately) and 50 per workflow run. All lines are
  still in the job log; only the inline rendering is truncated.
- For a directory, `github` is emitted **per file** — the runner drives the
  entrypoint once per invoice (the engine's `--recurse` batch mode covers only
  `json`, `junit`, `text`) and concatenates the lines, in the same order the
  SARIF merge uses.

The merged SARIF file is written either way, so you can start with
`format: github` and add the `upload-sarif` step later without changing anything
else. The offered `format` values are derived from the engine's own registry
(`einvoice.report.REPORT_FORMATS`) minus a declared exclusion set in
[`run.py`](run.py): `gitlab`/`azure` (other vendors' CI formats) and
`html`/`badge` (document-shaped artifacts, not job-log lines).

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
vendored package next to itself, no `pip install` and no network fetch. GitHub
resolves a `./`-prefixed `uses:` against the checkout root, the same anchor a
relative `path:` uses, so both halves of that workflow are written from the
repository root and `path: invoices/` keeps meaning what it did.

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
  formats use the engine's native `--recurse` batch mode; `github` has no
  aggregate shape either, so for a directory the runner emits it per file and
  concatenates (no batch envelope is invented).
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

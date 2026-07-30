# Changelog

All notable changes to the `verifyhash-einvoice` conformance validator are
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions here are the single source of truth together with
`einvoice/pyproject.toml` and `einvoice/einvoice/__init__.py`
(`__version__`); `test_release_discipline.py` fails the build if the three
ever diverge.

## [0.2.8] - 2026-07-29

A **metadata-and-licence release**. Nothing about grading changed: the engine
still fires 297 rules, the same rule ids on the same profiles, and **no rule,
no exit code and no engine behaviour differs from 0.2.7** — `git diff
a843431..HEAD -- einvoice/einvoice/` over the two commits this release packages
is empty, so the validator inside the wheel is byte-identical to 0.2.7's. What
changes is the *licence compliance* of the artifact and the *storefront page* a
stranger meets before they install anything. Upgrade if you need the licence
text in your dependency audit; there is no correctness reason to.

### Fixed

- **The Apache-2.0 licence text now travels inside the distribution.** Up to
  and including the published 0.2.7 wheel, the only legal file in the artifact
  was `NOTICE`: `dist-info/licenses/` held `NOTICE` alone, and
  `importlib.metadata.metadata("verifyhash-einvoice")["License"]` came back
  `None` while the classifiers asserted `License :: OSI Approved :: Apache
  Software License`. Apache-2.0 **§4(a)** requires a copy of the License to
  accompany each copy of the Work you distribute, so a redistributor auditing
  our wheel found an assertion of Apache-2.0 and no licence to comply with — a
  conformance product failing its own conformance check. `LICENSE` (the
  201-line stock Apache-2.0 text, a byte-identical copy of the repo-root file,
  asserted equal by `test_packaging.py`) is now shipped via
  `license-files = ["LICENSE", "NOTICE"]` under `[tool.setuptools]`, and
  `license = {text = "Apache-2.0"}` populates the `License:` metadata field
  that was previously empty. `NOTICE` is listed explicitly because an explicit
  `license-files` list *replaces* setuptools' default
  `LICENSE*/NOTICE*/COPYING*` glob — omitting it would have silently stopped
  shipping the file that was the only thing there before.
- **`NOTICE` no longer points at a file the distribution does not contain.** It
  used to end "The full license text is the LICENSE file at the repository
  root", which was true of a `git clone` and false of every wheel. It now reads
  "…travels with this distribution as the LICENSE file alongside this NOTICE",
  which is now a checkable statement about the artifact in front of you.
- **The `Development Status` classifier stopped underclaiming.** It said
  `3 - Alpha`, and "Alpha" is the one word that disqualifies a validator from
  somebody's compliance pipeline. Measured against `CORRECTNESS.md` §5 — the
  most pessimistic thing this project says about itself anywhere — the honest
  grade is `4 - Beta`: 297 differentially-proven rules, a published installable
  wheel, a GitHub Action, 148 test files. §5's caveats (no XSD validation, no
  signature verification, "corpus, not universe", not a legal conformance
  certificate) are **scope** limits, not maturity limits. `5 -
  Production/Stable` stays off until the API stops being free to move inside
  0.x.

### Added

- **A navigable PyPI sidebar: eight labelled project URLs, up from one.** 0.2.7
  declared exactly one — `Homepage`, pointing at the repository root. 0.2.8
  declares `Homepage`, `Documentation`, `Why not KoSIT?`, `Browser validator`,
  `Rule index`, `Licensing`, `Source` and `Issues`, six of them landing on the
  product's own pages under `https://verifyhash.com/einvoice/`. A reader who
  wants to try the validator in a browser, or to read why we think we beat the
  incumbent, can now get there from the storefront in one click.
- **Keywords, where the field was previously `None`.** Ten terms —
  `xrechnung`, `en16931`, `e-rechnung`, `zugferd`, `factur-x`, `ubl`, `cii`,
  `e-invoicing`, `conformance`, `validator` — each naming something the engine
  genuinely handles. The pan-European network's name is deliberately **absent**
  and its absence is enforced by `test_packaging.py`: what we vendor is a
  21-assert KoSIT-published subset of that network's EN 16931 rules, not its
  ruleset, transport or participant lookup, and using it as a search term would
  sell a capability we do not have to the buyers least able to check.
- **Five per-minor `Programming Language :: Python :: 3.x` classifiers** (3.8
  through 3.12, mirroring `requires-python = ">=3.8"` and kept in step with it
  by a test), plus `Natural Language :: English` / `:: German` — the German
  CIUS layer, German violation messages and German site pages are a real part
  of the product — and `Topic :: Software Development :: Quality Assurance`.

### Changed

- **The rendered long description's links are absolute, so they resolve.** PyPI
  does not rewrite relative markdown targets. The 0.2.7 storefront body was a
  ~71 KB page carrying 49 **relative** links across 29 distinct targets against
  a single absolute one, so every internal link resolved against `pypi.org` and
  404'd — including the link to `CORRECTNESS.md`, the document this project's
  entire honest-scope pitch defers to. `README.md` now carries **54 absolute
  links and zero relative ones**; product pages win over repo blobs wherever
  both cover the topic. Stated cost: a reader with a local clone who clicks a
  sibling doc now lands on github.com rather than opening the file offline.
  That is the smaller loss — this README is read on PyPI and on GitHub, not in
  an editor.

### Honest limits of this release

- `Source` and `Issues` still point at `github.com/verifyhash/verifyhash`, and
  the tree that host currently serves is far older than this release (its
  `einvoice/pyproject.toml` reads `version = "0.1.0"`). Until that history is
  pushed, those two sidebar links land on a much earlier product; the six
  `verifyhash.com` links do not have that problem. For the same reason
  `CHANGELOG.md`, `RECEIPT-VERIFICATION.md` and `QUICKSTART.de.md` are **named
  in plain text and never linked** from the storefront — a link to a file that
  is not on the public branch is a 404 with extra steps.
- The regenerated attestation digest differs from 0.2.7's because
  `package.version` and the purl are inside the hashed body. That is the
  version string changing, not the engine.

## [0.2.7] - 2026-07-24

A packaging and robustness release for the INSTALLED artifact, plus one
dispatch fix that changes verdicts. No rule was added, removed or altered: the
engine still fires 297 rules, and the coverage and corpus numbers are unchanged
from 0.2.6. What changes is what a `pip install verifyhash-einvoice` user
receives, and which of the two EN 16931 syntaxes the raw-XML entry points will
actually grade.

This is a new version rather than a re-cut of 0.2.6 because the 0.2.6 wheel on
PyPI is published and immutable. Leaving both builds named `0.2.6` would mean a
lockfile pin, a CI pin or a bug report could not distinguish the wheel whose
default report format crashes from the fixed one.

### Fixed

- **Raw UN/CEFACT CII XML is now graded instead of refused.** XRechnung has two
  official syntaxes — UBL and CII — and CII is also the ZUGFeRD/Factur-X
  payload, so a German ERP's invoice folder is routinely raw CII. Every
  raw-XML surface (`einvoice validate`, `validate-batch`, `einvoice receipt`,
  `python3 -m einvoice.report`) previously answered such a file with a fatal
  `S-ROOT` and exit 1 — a red build on VALID invoices, carrying a message that
  told the user to convert their XML into a PDF. The engine had graded those
  exact bytes correctly the whole time via the PDF-container path and the
  public `einvoice.validate_bytes()`; only the dispatch layer withheld the
  answer. Root dispatch now lives in one shared seam
  (`einvoice.validate.validate_root` → `validate.cii_violations`), matched
  namespace-tolerantly by localname, so the CLI and the API cannot drift into
  disagreeing verdicts again. **No new rule logic:** CII runs the same
  syntax-agnostic core rules as UBL, plus `rules_xrechnung.evaluate_cii` on the
  `xrechnung` profile. A genuinely unsupported root (say a `buildConfigurations`
  file someone pointed the CI gate at) still earns the same structural `S-ROOT`
  fatal and exit 1, with its original wording. Limits: this fixes routing, not
  coverage — CII grading remains bounded by the CII binding already documented
  in `coverage.md`, and the browser validator bundled under `www/` still ships
  the previous dispatch until its engine copy is refreshed.
- **`remediation_catalog.json` is now shipped inside the wheel** (as
  `einvoice` package-data, 502,693 bytes raw / ~34 KB compressed). Reports
  produced by a pip-installed copy now carry non-null `title`, `fix_hint`,
  `terms` and `location` on each violation — the fields `report.schema.json`
  advertises. Before, an installed user was told a rule id had failed with
  nothing to fix it with; only a source checkout, which reads the catalog from
  the repo root, produced populated guidance.
- **`--format sarif` and `--explain` no longer raise `FileNotFoundError` when
  the catalog is unreachable.** Every report path now degrades to the
  catalog-less result (rule ids without enrichment) instead of aborting with a
  traceback, so a missing or unreadable catalog can no longer turn a validation
  run into a crash. This is the CI-visible one: `sarif` is the bundled GitHub
  Action's default `format`, and the Action writes a SARIF file for
  `codeql-action/upload-sarif` regardless of the format chosen, so on a
  catalog-less install the default path was the crashing one. SARIF is now
  emitted whole and valid; the only degradation is that no rule earns a
  `helpUri` deep-link. `--explain` on a catalog-less install prints one honest
  stderr line instead of a traceback.
- **`python3 -m einvoice.report --help` and `-h` print usage to stdout and exit
  0.** The help flags previously fell through to the positional-argument check,
  so a documented entry point answered `--help` with `error: no such file:
  --help`. `--help` is now answered before any path or flag-value resolution,
  from anywhere on argv. The BARE invocation is unchanged and still an error
  (usage to stderr, non-zero) — help is a requested output, a missing argument
  is not.
- **Every runtime help pointer now resolves for a wheel-only install.**
  `einvoice --help` ended with "See README.md for the full flag set." and
  `python3 -m einvoice.report --help` ended its `--baseline` line with "See
  REPORT-SCHEMA.md."; neither file is packaged, so a `pip install` user was
  sent to a path that does not exist on their disk. Both now point at
  <https://verifyhash.com/einvoice/>. Two runtime doc-pointers existed across
  `cli.py` and `report.py`; both were changed, and `test_cli_help.py` now scans
  every non-docstring string literal in both modules so a new `*.md` pointer
  fails the build. (Docstrings and comments still reference the repo files —
  they are read in a checkout, where those files exist.)
- **`einvoice --help` now names the seven CI report formats and where to get
  them.** `junit`, `sarif`, `gitlab`, `github`, `azure`, `html` and `badge`
  were emitted only by `python3 -m einvoice.report`, which the main help never
  mentioned — a pip-only adopter had no way to discover them. The help now
  carries one derived line, `Other report formats (…): python3 -m
  einvoice.report --format <fmt> <invoice.xml>`, computed from
  `einvoice.report.REPORT_FORMATS` minus the two forms this CLI emits itself,
  so registering a new emitter documents itself. This CLI still has no
  `--format` flag of its own; `einvoice validate --format json` remains a usage
  error (exit 2).
- **The `unknown subcommand` banner now lists the whole documented surface.**
  Its choice list was formatted from the dispatch tuple, so `einvoice --explain
  BR-DE-1` was told to "choose from validate, validate-batch, receipt" while
  `--help` also documents `info`, `--show-config`, `--version` and `--help`.
  Banner and help now read one shared `COMMAND_SURFACE` definition and are
  pinned equal by test. The exit code (2), the `unknown subcommand` wording and
  the separate stray-flag / missing-file legs are unchanged. (`--explain` was
  deliberately left off the surface at the time; it has since been routed
  properly — see **Added** below.)

### Added

- **The human `validate` summary now answers the question it used to raise.**
  The default text report is the artifact a stranger or a CI reviewer actually
  reads, and both of its verdicts were dead ends. A `FAIL` printed a rule id,
  its message and the offending element, then stopped — even though this same
  wheel ships `einvoice --explain` (the EN+DE remediation catalogue) and 297
  rule pages, and named neither. It now adds
  `how to fix: einvoice --explain <RULE-ID>` and, only when the shipped
  catalogue really has that rule, `rule page: https://verifyhash.com/einvoice/rules/<RULE-ID>/`.
  Both are derived from the violation the run actually hit, never from a
  hard-coded example id, and the URL is built from the single origin the
  package already owns (`report.SARIF_RULE_HELP_BASE_URL`, byte-equal to
  `gen_site.BASE_URL + "/rules/"`), so no second origin string exists. A `PASS`
  announced `— N non-fatal warning(s) reported` and then refused to say what
  they were, although `--json` had carried the whole finding all along; it now
  lists them under an indented `non-fatal findings (advisory — verdict stays
  PASS; only --fail-on gates on them)` heading as
  `[<severity>] <RULE-ID>: <message>`, using the same message resolution as the
  FAIL path (so `--lang de` still surfaces the official German text). Above ten
  findings it prints the first ten plus one honest line naming how many were
  omitted and the exact flag that shows all of them (`--format json`).
  Everything added lives inside the existing human-output branch and is
  indented, so the verdict line still comes first and still starts with
  `PASS:`/`FAIL:`: `--json` and every machine format are byte-identical,
  `--quiet` still writes nothing to stdout, and no exit code moves
  (`test_exit_codes.py`, `test_fail_on.py`, `test_fail_on_format_invariance.py`
  and `test_stdout_purity.py` pass unmodified). The QUICKSTART/QUICKSTART.de
  transcripts, `EXIT-CODES.md`, `README.md` and the generated walkthroughs were
  updated to show what the tool really prints.

- **Every `einvoice-conformance-report/v1` violation now carries `element`, so
  `validate --json` and `validate-batch --json` hand back the SAME violation
  object.** A CI consumer's normal adoption shape is `einvoice validate --json`
  on a pre-commit hook and `einvoice validate-batch --json` on a nightly
  directory run, and until now those two returned different records: measured
  on `corpus/synthetic/synth-ubl-bad-vat-mismatch.xml`, `validate --json`
  violations carried 9 keys (`element`, `field`, `fix_hint`, `location`,
  `message`, `rule`, `severity`, `terms`, `title`) while every per-file
  violation from `validate-batch --json` carried 8 — no `element` — forcing a
  consumer to special-case which of our own two subcommands produced the JSON.
  The gap was never CLI-local: batch returns `report.build_batch_report()`
  verbatim, and `report._record` emitted the offending element only under the
  name `field`, so `element` was missing from *every* report/v1 document
  (`python3 -m einvoice.report --format json` included). The fix is in the
  shared record, not in either CLI: `report._record` and
  `report.VIOLATION_KEYS` now emit `element` unconditionally, and
  `report.schema.json` declares it as a required property. It is the same
  `Violation.element` value `field` already carried — both keys are always
  present and always equal, neither is a rename of the other, and nothing was
  removed, so a consumer reading `field` sees a byte-identical value. Purely
  additive on the SAME schema id: `$id` and the `schema` const stay at
  `einvoice-conformance-report/v1`, exactly as that schema's own versioning
  policy sanctions, and `VIOLATION_KEYS` still begins with the four back-compat
  identity keys (`rule`, `severity`, `message`, `field`) with `element`
  appended last. `test_json_surface_parity.py` now measures
  `validate-batch --json` as a third surface against `validate --json` — an
  undeclared per-violation divergence between them fails the build, while the
  legitimate batch-only *envelope* keys (`files`, `file_count`,
  `failed_file_count`, `root`, …) are declared with a reason each. No rule,
  format, data file, dependency, envelope key or exit code changed; the engine
  still fires 297 rules.

- **`einvoice validate <invoice.pdf>` accepts a Factur-X/ZUGFeRD PDF/A-3
  container.** ZUGFeRD/Factur-X — EN 16931 XML embedded in a PDF/A-3 — is the
  dominant delivery form under the German mandate and the first file an ERP
  developer hands this binary, yet the one command `QUICKSTART.md` teaches
  first refused it: `einvoice validate corpus/pdf/facturx-valid.pdf` exited `3`
  with `S-WF: input is not well-formed XML` and a hint redirecting to a sibling
  entry point, while the *same wheel* graded that exact file correctly through
  `python3 -m einvoice.report` and `einvoice validate-batch`. Single-file
  `validate` now dispatches on the `%PDF-` magic (bytes, never the extension)
  like those surfaces already did, reduces the container to its embedded
  invoice XML with the already-shipped zero-dependency
  `einvoice.pdf_container`, and hands those bytes to **the same seam the XML
  path uses** (`validate.validate_file` over a `BytesIO`, then the identical
  syntax-binding projection). Because a PDF becomes an ordinary graded invoice
  one line after it is read, the default text summary, `--json` and all seven
  delegated `--format` values are produced by the code that already produced
  them for XML: no second PDF reader, no second JSON shape, no new dependency,
  no rule change. Measured on the committed fixtures:
  `validate corpus/pdf/facturx-valid.pdf` → `0` (CLI default profile
  `en16931`), the same file with `--profile xrechnung` → `1` (3 fatal —
  `BR-DE-23-b`, `BR-DE-31`, `BR-TMP-3` — and 2 warnings). That finding list is
  byte-identical to running `einvoice validate` on the extracted XML as a plain
  file, and its counts match `validate_bytes()` on the same bytes. A container the zero-dep
  extractor cannot reach (encrypted, no `/EmbeddedFiles` name tree,
  cross-reference-stream layout, truncated) keeps exit `3` and carries the
  documented literal token `unsupported-container` — the same token the report
  surface has always used, so **no new exit code and no new error code was
  minted** — on stderr as an `S-CONTAINER:` line naming the concrete extractor
  reason, and under `--json` as the four-key `source`/`valid`/`error`/`message`
  object the not-well-formed arm already emits. Known limit, deliberate: the
  `FX-CONTAINER-*` wrapper-declaration findings still come from the report
  surface (and from `validate --format <fmt>`, which renders through it), not
  from single-file `validate`'s text/`--json` output. `validate-batch` is
  untouched — it already handled PDFs. Documented in `EXIT-CODES.md`,
  `QUICKSTART.md` §4 and `README.md`; pinned by new CLI-level assertions in
  `test_pdf_container.py`.

- **`einvoice --explain <RULE-ID>` — the remediation catalog is now reachable
  from the entry point that printed the rule id.** After `einvoice validate`
  prints `BR-CO-15: …`, the most natural next keystroke is
  `einvoice --explain BR-CO-15`; it answered `error: unknown subcommand
  '--explain'` (exit 2) because the lookup only existed on
  `python3 -m einvoice.report`. The flag is now dispatched on the console
  script beside `--version`/`--help` and **routed to the same implementation**
  (`einvoice.report.main` → `format_explain` over `remediation_catalog.json`) —
  not a fork, not a second catalog, and not a byte of new explanation text:
  `einvoice --explain BR-CO-15` is byte-identical on stdout to
  `python3 -m einvoice.report --explain BR-CO-15`. Exit codes are the shipped
  ones, unchanged and now shared by both surfaces: `0` catalogued, `1` unknown
  rule id (a lookup miss — stdout stays empty), `2` when the rule id is missing
  from argv. `--explain` is listed in `--help` and in the `unknown subcommand`
  banner (both read `COMMAND_SURFACE`), and documented in `EXIT-CODES.md`,
  `QUICKSTART.md` §4 and `README.md`. No validation behaviour changed:
  `validate`, `validate-batch`, `receipt` and `info` are untouched.

- **`--format <fmt>` on `einvoice validate` / `validate-batch` — the one
  installed binary now emits all nine formats it advertises.** `einvoice info`
  (and `einvoice.capabilities()['formats']`) has always listed
  `azure, badge, github, gitlab, html, json, junit, sarif, text` as this build's
  capabilities, yet `einvoice validate --format sarif invoice.xml` answered
  `error: unexpected argument '--format'` (exit 2): seven of the nine — the SARIF
  file GitHub code scanning wants most of all among them — were reachable only
  from the sibling `python3 -m einvoice.report` entry point, which a
  `pip install` user has no reason to know exists. Both spellings
  (`--format sarif`, `--format=sarif`) are now accepted, with the vocabulary read
  from the one registry (`einvoice.report.REPORT_FORMATS`) so a format can never
  again be advertised but unaccepted. **Routed, not forked:** the seven report
  bodies come from the newly extracted `einvoice.report.render_report`, the SINGLE
  emitter dispatch `python3 -m einvoice.report --format <fmt>` itself now writes,
  so the two surfaces are byte-identical by construction. No format, rule, data
  file, dependency or renderer was added.

  Back-compatibility and the exit contract are intact, both measured: `--format
  json` is an exact alias for `--json` (same code path, byte-identical output),
  `--format text` is the unchanged default, and with the flag absent nothing moves
  at all. Two real hazards were closed rather than shipped: the console script
  defaults to `--profile en16931` while `einvoice.report` defaults to
  `xrechnung` — on `examples/01-missing-fields/broken.xml` the difference is
  `PASS`/exit 0 versus 2 fatals (`BR-DE-2`, `BR-DE-15`)/exit 1 — and
  `report.main` folds `syntax_binding_fatal_count` into its exit code where
  `validate` documents those findings as non-blocking (the two rules disagree on
  25 (file, profile) pairs in the committed corpus). A bare delegation would have
  silently flipped verdicts on both counts, so the resolved profile and
  `--fail-on` threshold of the *console script* grade the invoice. Usage errors
  (all exit 2, empty stdout): an unknown format naming the valid nine, `--format`
  with no value, `--format` twice with conflicting values, `--format` together
  with `--json`, a single-invoice format on `validate-batch` (which takes the
  aggregate-capable `json`/`junit`/`text`) and a report format on `info` /
  `receipt`. Batch envelope keys, the config-file `format` vocabulary
  (`text`/`json`) and `EXIT-CODES.md`'s 0/1/2/3 taxonomy are unchanged;
  `EXIT-CODES.md`, `QUICKSTART.md` §5 and `README.md` document the flag.

## [0.2.6] - 2026-07-23

The engine now fires 297 rules (was 295): the last two deferred code-list
classes, `BR-CL-07` (object/document reference identifier scheme, UNTDID
1153) and `BR-CL-08` (invoice note subject code, UNTDID 4451), are
implemented on BOTH syntaxes. The `codelist_not_asserted` bucket is now
EMPTY — every fireable EN 16931 `BR-CL-*` code-list assert in the vendored
CEN artifacts is implemented in both bindings.

### Added

- **`BR-CL-07` (object/document reference identifier scheme, UNTDID 1153) is
  implemented, both syntaxes.** BOTH vendored PREPROCESSED artifacts inline
  the SAME 818-entry UNTDID 1153 enumeration (verified byte-identical after a
  whitespace split), so one pinned set (`UNTDID_1153_CODES`) serves both
  bindings even though they read DIFFERENT surfaces: the UBL assert (context
  `cac:AdditionalDocumentReference[cbc:DocumentTypeCode='130']/cbc:ID[@schemeID]`
  and the `cac:DocumentReference` variant) tests the `@schemeID` attribute;
  the CII assert (context `ram:ReferenceTypeCode`) tests the element text.
- **`BR-CL-08` (invoice note subject code, UNTDID 4451) is implemented, both
  syntaxes.** The two artifacts inline DIFFERENT subsets — the CII subset
  (`CII_NOTE_SUBJECT_CODES`, 401 codes) is a strict SUPERSET of the UBL
  subset (`UBL_NOTE_SUBJECT_CODES`, 383 codes), carrying 18 extra codes
  (`BAT`-`BBB`, `BMF`-`BMH`, `CCJ`-`CCO`) — so the two are pinned SEPARATELY
  and selected per syntax. The two BINDINGS also differ in shape: the CII
  binding is a plain space-padded membership test of `ram:SubjectCode`; the
  UBL binding is a `#CODE#` note-prefix GRAMMAR on the document-level
  `cbc:Note`, firing only when the 3-char token delimited by the first two
  `#` characters is present but outside the UBL subset. Because the UBL
  assert compares with an un-padded `contains()`, the exact padded list
  string (`UBL_NOTE_SUBJECT_PADDED`) is pinned so the substring semantics are
  reproduced verbatim, not approximated by set membership.
- An invoice carrying a wrong object-reference scheme code or an off-list
  `#`-delimited note subject token previously false-PASSed against the engine
  while failing the official CEN Schematron; both rules are graded on all
  differential legs (UBL, CreditNote, CII) with targeted mutations at 0
  divergences — the BR-CL-08 mutations deliberately use a CII-only code on
  the UBL leg to discriminate the per-syntax subsets — and unit-pinned
  positive + negative per id per syntax in `test_rules.py` /
  `test_rules_cii.py`.

### Changed

- CEN coverage per syntax universe moved 217 -> 219 of the 223 official
  `BR-*` ids; the deferred `BR-CL-*` code-list class shrank 2 -> 0 — the
  `codelist_not_asserted` exclusion bucket is now empty. Coverage/count
  surfaces regenerated and re-pinned through the existing drift guards
  (README §2, `COVERAGE.md`/`coverage_matrix.json`, `cii_parity.json`
  279 -> 281 both-syntax, `RULES.md`, `remediation_catalog.json` incl. the
  three new German renderings, exports, attestation, sbom, site, web bundle;
  pyproject + `action/README.md` descriptions now say 297). No guard was
  weakened.
- **`einvoice validate --json` violation records now carry the remediation
  half.** Measured before this change: `validate --json` emitted only
  `rule`/`message`/`element`/`severity`, while `python3 -m einvoice.report
  --format json` on the SAME file emitted `field`/`title`/`fix_hint`/`terms`/
  `location` as well — so the surface an ERP developer actually automates
  against (the CLI) returned a rule id and no guidance, and the shipped
  remediation catalog was invisible exactly where it is felt daily. Each CLI
  violation record now adds five always-present keys: `field` (the same value
  as `element`, under the report writer's name for it) plus `title`,
  `fix_hint`, `terms` and `location`, relayed from the same committed
  `remediation_catalog.json`. Nothing was renamed or removed — `element` is
  unchanged and `source_line` stays conditional — so an existing consumer is
  unaffected. Which violations fire, every severity, the human/text output and
  the 0/1/2/3 exit contract are all untouched.
- Both relay surfaces now go through ONE helper,
  `einvoice.remediation.remediation_fields()`, backed by one process-wide
  catalog cache (`remediation.cached_catalog()`, which `report._remediation_catalog()`
  now delegates to), so a large batch parses the catalog JSON once and the two
  surfaces cannot drift into different guidance for the same rule id. The
  report's emitted bytes are unchanged (its goldens are untouched), and the
  catalog-less-installation degradation — every remediation key present with
  `null`/`[]` values rather than a `FileNotFoundError` — now covers the CLI
  path too.

## [0.2.5] - 2026-07-23

The engine now fires 295 rules (was 293): the everyday-field code-list pair
`BR-CL-06` (VAT point date code) and `BR-CL-15` (item origin country) is
implemented on BOTH syntaxes; the deferred `BR-CL-*` class is down to the
final `BR-CL-07`/`BR-CL-08` pair.

### Added

- **`BR-CL-06` (VAT point date code, BT-8) is implemented, per syntax** —
  the two official bindings restrict DIFFERENT UNTDID registers, so the two
  inlined subsets were transcribed SEPARATELY from the vendored PREPROCESSED
  CEN artifacts and are selected per syntax, never unified (their sets share
  no code — disjointness is asserted at import in `codelists.py`): UBL
  `cac:InvoicePeriod/cbc:DescriptionCode` against the UNTDID 2005
  restriction `3 35 432`; CII `ram:DueDateTypeCode` against the UNTDID 2475
  restriction `5 29 72`. Both pins are provenance-locked in
  `codelists_manifest.json` (`UBL_VAT_POINT_CODES` / `CII_VAT_POINT_CODES`).
- **`BR-CL-15` (item origin country, BT-159) is implemented** — UBL
  `cac:OriginCountry/cbc:IdentificationCode` / CII
  `ram:OriginTradeCountry/ram:ID` values are checked against the SAME
  per-syntax ISO 3166-1 pins BR-CL-14 already used (`UBL_COUNTRY_CODES` has
  SS not AN; `CII_COUNTRY_CODES` has AN not SS): the preprocessed artifacts'
  BR-CL-15 enumerations were machine-compared and verified IDENTICAL per
  syntax to the BR-CL-14 pins, so no list was duplicated.
- An invoice carrying a wrong item origin-country code or a wrong VAT-point
  date code previously false-PASSed against the engine while failing the
  official CEN Schematron; both rules are graded on all differential legs
  (UBL, CreditNote, CII) with targeted mutations at 0 divergences — each
  mutation deliberately uses the OTHER syntax's valid code (`5` on UBL,
  `35` on CII; `AN` on UBL, `SS` on CII in the unit fixtures) so the proof
  discriminates the per-syntax pins — and unit-pinned positive + negative
  per id per syntax in `test_rules.py` / `test_rules_cii.py`.

### Changed

- CEN coverage per syntax universe moved 215 -> 217 of the 223 official
  `BR-*` ids; the deferred `BR-CL-*` code-list class shrank 4 -> 2
  (BR-CL-07/08 — the last two). Coverage/count surfaces regenerated and
  re-pinned through the existing drift guards (README §2, `COVERAGE.md`/
  `coverage_matrix.json`, `cii_parity.json` 277 -> 279 both-syntax,
  `RULES.md`, `remediation_catalog.json` incl. the two new German
  renderings, exports, attestation, sbom, site, web bundle; pyproject +
  `action/README.md` descriptions now say 295). No guard was weakened.

## [0.2.4] - 2026-07-23

The engine now fires 293 rules (was 289): the CEN scheme-identifier
code-list family `BR-CL-10`, `BR-CL-11`, `BR-CL-25` and `BR-CL-26` is
implemented on BOTH syntaxes (`test_docs_rule_claims.py` binds the 293 to
the live `coverage.engine_fireable_ids()` registry, as before).

### Added

- **`BR-CL-10` / `BR-CL-11` / `BR-CL-26` (ISO 6523 ICD scheme identifiers)
  are implemented** — party-identification, party-registration and
  delivery-location `@schemeID` values are now checked against the 243-entry
  ISO 6523 ICD enumeration, transcribed from the vendored PREPROCESSED CEN
  artifacts (each of the six inlined enumerations was machine-compared and
  verified IDENTICAL to the pinned `ITEM_SCHEME_ID_CODES` set BR-CL-21
  already used, so one pinned list serves all four rules; never read from
  the PDF register). Context bindings are exact per artifact: UBL
  `cac:PartyIdentification/cbc:ID[@schemeID]` (with the official
  supplier/payee-scoped `'SEPA'` disjunct), `cac:PartyLegalEntity/
  cbc:CompanyID[@schemeID]`, `cac:DeliveryLocation/cbc:ID[@schemeID]`; CII
  the generic `//ram:GlobalID[@schemeID]` outside product/ship-to (NO SEPA
  disjunct — the CII artifact carries none), `ram:ID[@schemeID]` outside
  `ram:SpecifiedTaxRegistration`, and the HEADER
  `ram:ShipToTradeParty/ram:GlobalID[@schemeID]`.
- **`BR-CL-25` (CEF EAS endpoint scheme identifier) is implemented** — UBL
  `cbc:EndpointID[@schemeID]` / CII `ram:URIUniversalCommunication/
  ram:URIID[@schemeID]` values are checked against the CEN artifacts' inlined
  104-entry EAS enumeration, pinned as `ENDPOINT_EAS_CODES`. Measured
  artifact fact: this CEN set is NOT the KoSIT common.sch `$CEF-EAS-CODES`
  set — it carries four additional entries (0242 0245 0246 0248) — so the
  KoSIT set was promoted verbatim to `codelists.KOSIT_CEF_EAS_CODES` (single
  module, separate pins, both locked in `codelists_manifest.json`).
- An invoice carrying an invalid scheme id on any of these surfaces
  previously false-PASSed against the engine while failing the official CEN
  Schematron; all four rules are graded on all differential legs (UBL,
  CreditNote, CII) with targeted mutations at 0 divergences, and unit-pinned
  positive + negative per syntax in `test_rules.py` / `test_rules_cii.py`.

### Changed

- CEN coverage per syntax universe moved 211 -> 215 of the 223 official
  `BR-*` ids; the deferred `BR-CL-*` code-list class shrank 8 -> 4
  (BR-CL-06/07/08/15). Coverage/count surfaces regenerated and re-pinned
  through the existing drift guards (README §2, `COVERAGE.md`/
  `coverage_matrix.json`, `cii_parity.json`, `RULES.md`,
  `remediation_catalog.json`, exports, attestation, site, web bundle;
  pyproject + `action/README.md` descriptions now say 293). No guard was
  weakened.

## [0.2.3] - 2026-07-23

The engine now fires 289 rules (was 288): `BR-DEX-15`, the last measured
engine gap against the vendored KoSIT XRechnung-CII artifact, is implemented
(`test_docs_rule_claims.py` binds the 289 to the live
`coverage.engine_fireable_ids()` registry, as before).

### Added

- **`BR-DEX-15` (sub invoice lines unsupported) is implemented** — the ONE
  XRechnung Extension assert that exists ONLY in the CII artifact (the
  vendored UBL artifact carries no such id, exactly like `BR-TMP-3`).
  Transcribed from `XRechnung-CII-validation.sch` pattern
  `cii-extension-pattern`: context every
  `ram:IncludedSupplyChainTradeLineItem/ram:AssociatedDocumentLineDocument`
  gated behind the CII `$isExtension` guideline let, test
  `not(exists(//ram:ParentLineID))`, flag **warning** (copied exactly — it
  does not block validity). A German CII extension invoice using sub invoice
  lines previously false-PASSed silently; it now reports the same warning
  the official KoSIT validator raises. Registered on the CII layer
  (`rules_xrechnung.CII_DE_RULES`), carried by two new normalized-model
  booleans (`parser_cii`), unit-pinned positive + negative in
  `test_xrechnung.py`, and graded on the `xrechnung-cii` differential leg
  with a targeted mutation (0 divergences).

### Changed

- Coverage/count surfaces regenerated and re-pinned through the existing
  drift guards (README §2, `COVERAGE.md`/`coverage_matrix.json`,
  `cii_parity.json`, `RULES.md`, `remediation_catalog.json`, exports,
  attestation, site, web bundle; pyproject + `action/README.md`
  descriptions now say 289). No guard was weakened.

> Note: `verifyhash-einvoice` is published to PyPI as of 0.2.0 (2026-07-22);
> republishing remains a deliberate human-gated step (see `REPUBLISH-PYPI.md`).
> Each section below records what the tree actually ships at that version —
> only sections from 0.2.0 onward correspond to a PyPI release event.

## [0.2.2] - 2026-07-22

The engine now fires 288 rules (was 286): the last two fireable
decimal-precision core rules landed, plus a BR-CO close-out that trues up the
honesty surfaces (`test_docs_rule_claims.py` binds the 288 to the live
`coverage.engine_fireable_ids()` registry, as before).

### Added

- **`BR-DEC-13` / `BR-DEC-15` (total-VAT decimals, BT-110/BT-111) are
  implemented** (`einvoice/rules.py`, flag fatal, both syntaxes), closing the
  engine's last two fireable decimal-precision false-PASS gaps: a VAT total
  like `12.345` now fails on the CII/Factur-X path exactly as the official
  CEN CII Schematron rejects it. The two vendored artifacts genuinely differ
  and each arm transcribes its own binding: the **CII** binding is a REAL
  numeric test (`. = round(. * 100) div 100`, existential over the header
  summation's `ram:TaxTotalAmount` children, raw-`@currencyID`-scoped
  against BT-5/BT-6 — so `12.340` HOLDS and a present BT-6 with no
  matching-currency total FIRES BR-DEC-15) — GRADED and mutation-proven on
  the CII differential leg; the **UBL** asserts are vacuous by artifact
  defect (their currency predicate resolves against the TaxAmount node, so
  they can never fire officially) — the engine asserts the stated
  ≤2-decimals intent on UBL anyway (deliberate strictness, the BR-AF-08/09
  posture) and the pair is held out of the UBL differential legs
  (`differential.EN_UBL_EXCLUDED_RULE_IDS`, documented in
  `CORRECTNESS.md` §5). Unit-pinned positive + negative per rule per syntax
  in `test_brdec_totals.py`.

### Changed

- **BR-CO close-out — the stale unimplemented-rules claims in
  `CORRECTNESS.md` §5 are trued up.** BR-CO-03/09/11/12/26 (long since
  implemented in `rules.py`) are no longer listed as missing; BR-CO-05..08
  are documented as official `test="true()"` no-ops in BOTH vendored CEN
  artifacts (untestable by construction, the `official_tautology` exclusion
  class); and BR-CO-25 is documented as ABSENT from both vendored
  preprocessed artifacts (EDIFACT-only — the BR-IG-*/BR-IP-* precedent).
  The implemented-core count now stated there (211 distinct rule ids
  emitted by `rules.py`) carries its derivation.
- Coverage/count surfaces regenerated and re-pinned through the existing
  drift guards (README §2, `COVERAGE.md`/`coverage_matrix.json`,
  `cii_parity.json`, `RULES.md`, `remediation_catalog.json`, exports,
  attestation, site, web bundle; pyproject + `action/README.md`
  descriptions now say 288). No guard was weakened: `test_coverage_matrix.py`
  now asserts the pair is IN the fireable registry and may never reappear in
  the vacuous-exclusions bucket.

## [0.2.1] - 2026-07-22

Metadata correction only — **no engine change**: the engine still fires 286
rules, identical to 0.2.0 (`test_docs_rule_claims.py` binds that number to
the live `coverage.engine_fireable_ids()` registry).

### Changed

- **`pyproject.toml` description trued up to the shipped engine.** The 0.2.0
  wheel went to PyPI still carrying the 0.1.0-era description ("50 of ~200
  EN 16931 core rules … `BR-DEX-*`/`BR-DE-CVD-*` not yet implemented") — false
  for the engine it packaged. The description now states the 286
  differential-tested business rules including the national `BR-DE-*` and
  `BR-DEX-*` layers, with the same implemented-set scope caveat README §2 and
  `CORRECTNESS.md` carry. The pyproject header comment no longer claims the
  package is unpublished.
- **`action/README.md` "Honest scope" corrected the same way**, from the same
  source of truth (README §2).
- **Drift guards extended** (`test_packaging.py`,
  `test_docs_rule_claims.py`): the rule count claimed in the pyproject
  description and in `action/README.md` is now computed from
  `engine_fireable_ids()` and fails on divergence, so this class of metadata
  staleness cannot recur at a future version bump. Ready to republish
  (supervisor-gated, `REPUBLISH-PYPI.md`).

## [0.2.0] - 2026-07-22

Everything here is in the tree today and covered by the committed test suite;
like 0.1.0, this section describes the checkout, not a PyPI upload.

### Added

- **Rule coverage grew ~3.5x: the engine now fires 286 rules** (0.1.0
  implemented a 50-rule EN 16931 core subset plus the 32 national `BR-DE-*`
  asserts). The families 0.1.0 declared open — `BR-DEX-*` (extension) and
  `BR-DE-CVD-*` — are now implemented, alongside the VAT-category rule
  families (reverse charge `BR-AE-*`, intra-community `BR-IC-*`,
  export `BR-G-*`, not-subject `BR-O-*`, zero/exempt/reduced rates,
  allowance/charge `BR-AF-*`/`BR-AG-*`), `BR-TMP-*`, and a
  `PEPPOL-EN16931-R*` subset. The count in this bullet is not prose-trusted:
  `test_docs_rule_claims.py` fails the build if it stops equalling
  `coverage.engine_fireable_ids()`, and every implemented rule remains
  differential-tested against the official Schematron within the implemented
  set (`CORRECTNESS.md` still declares what is NOT covered).
- **GitHub Action** (`action/action.yml`): a composite action that validates
  a file or directory of UBL/CII XML and Factur-X/ZUGFeRD PDF invoices in CI
  and always writes a merged SARIF 2.1.0 file for
  `github/codeql-action/upload-sarif` (inline PR annotations). It drives the
  real `python3 -m einvoice.report` entrypoint — no second validation engine,
  no new output format.
- **`einvoice receipt --verify <receipt.json>`**: the tamper-evidence promise
  as one command. Recomputes the receipt body hash and compares it to the
  stored `content_sha256`: exit `0` VERIFIED, `1` TAMPERED, `2` not a
  readable receipt; `--json` emits a machine object. Tamper detection is
  totality-tested (every field/region of a golden receipt mutated and
  rejected), and the documented CI recipe in `RECEIPT-VERIFICATION.md` is
  executed verbatim by a drift-guard test.
- **First-class `--help` / `-h`**, with a completeness guard binding the help
  text to the real subcommand registry.
- **Versioned JSON Schemas for the machine outputs** — `report.schema.json`,
  `receipt.schema.json`, `attestation.schema.json`, plus info/rules/coverage
  — each derived from the real emitter and drift-guarded, with a published
  schema index.
- **Reference-site surfaces** (committed under `www/`, deployed at
  verifyhash.com/einvoice): German product/quickstart page `/de/` and a
  German worked walkthrough `/de/walkthrough/` (original German prose,
  hreflang-paired with the English pages); an honest KoSIT/Mustangproject
  comparison at `/compare/` whose every stated engine figure is parsed back
  out of the HTML and bound to the live registries; the licensing page
  `/licensing/` (currently in explicit waitlist mode — checkout is not open
  yet, and the page says so). `verify_live.py` now derives its post-deploy
  checks from the committed tree, so no page family can silently escape
  live verification again.

### Changed

- **First-run errors are actionable instead of raw internals** (previously a
  wrong input could produce a bare parser message, a traceback, or a
  misleading reason):
  - an unknown subcommand or flag is now *named* in the usage error;
  - a non-XML, non-PDF input still exits `3`, but the `S-WF` line now adds a
    hint naming the two supported input shapes — and if the bytes carry the
    `%PDF-` magic, the hint redirects to the container route
    (`python3 -m einvoice.report <invoice.pdf>`);
  - a genuine CII `CrossIndustryInvoice` root on the raw-XML `validate` path
    gets an `S-ROOT` message naming the supported CII route instead of a
    generic wrong-root failure;
  - OS-level input problems (unreadable file, directory-instead-of-file,
    dangling symlink, closed stdin) exit `2` with one line naming the path
    and the reason — never a traceback, never a fake FAIL verdict.
  All pinned in `EXIT-CODES.md`, whose code table is itself bound both
  directions to the set of codes the CLI can actually produce.
- **Quiet conventional exits for plumbing events**: `141` on a broken pipe,
  `130` on SIGINT, `143` on SIGTERM — additive; codes `0/1/2/3` and all
  report bytes are unchanged.
- **Batch validation got measurably faster**: a per-document tag index
  removed a ~48x repeated-scan constant in syntax binding, with findings
  proven byte-identical before/after.

## [0.1.0] - 2026-07-07

First packaged slice of the zero-dependency EN 16931 / XRechnung e-invoice
conformance validator. Standard library only — `dependencies = []` in
`pyproject.toml` is an enforced contract (`test_packaging.py`), so the tool
installs and runs anywhere Python 3.8+ runs, with no supply chain to audit.

### Added

- **EN 16931 + XRechnung (CIUS) conformance validation.** Validates the
  business-rule layer of an invoice against the implemented subset: 50 of the
  ~200 EN 16931 core rules plus the 32 national `BR-DE-*` XRechnung asserts.
  Each implemented rule is differential-tested to 100% agreement with the
  official Schematron *within that subset* — the not-yet-implemented families
  (`BR-DEX-*`, `BR-DE-CVD-*`) are declared open rather than silently passed
  (see `CORRECTNESS.md`).
- **Both EN 16931 syntaxes.** Accepts UBL (`Invoice`, `CreditNote`) and
  CII (`CrossIndustryInvoice`) documents. The syntax-binding coverage is
  measured and pinned: 741/756 UBL and 554/583 CII bindings proven against the
  official test material (`einvoice info --json` reports the live numbers).
- **Credit notes.** UBL `CreditNote` and CII invoices carrying BT-3 document
  TypeCode `381` (Gutschrift) are validated under the credit-note scope rather
  than rejected as unknown document types.
- **Machine-readable report formats.** One validation, many outputs:
  `json`, `junit`, `sarif`, `github` (workflow annotations), `gitlab`
  (Code Quality), `azure`, `html`, `badge`, and human `text`. Every emitter is
  fuzz-tested to be total and well-formed over any validation result
  (`test_fuzz_report_formats.py`).
- **Stable exit-code contract.** `0` = valid, `1` = business-rule violations,
  `2` = usage error, `3` = input/OS error (unreadable file, malformed XML,
  unsupported container). Documented in `EXIT-CODES.md` and enforced by
  `test_exit_codes.py`, so CI can branch on the outcome without scraping text.
- **`--fail-on` severity threshold.** Choose the severity that turns a run red
  (e.g. warn vs. error) via CLI flag, config, or the `fails_at` public API.
- **Batch validation.** Validate many invoices in one invocation with an
  aggregate report; results are order-independent
  (`test_idempotence.py`).
- **PDF / Factur-X container handling.** Extracts and validates the embedded
  XML from a Factur-X / ZUGFeRD PDF container; unsupported or truncated
  containers exit `3` with a clear message rather than crashing
  (`test_pdf_container.py`, `test_fuzz_pdf_container.py`).
- **Byte-stable attestation and conformance receipt.** `gen_attestation.py`
  emits a deterministic, byte-reproducible `attestation.json`, and the
  conformance receipt is golden-pinned across both syntaxes and the CII-381
  credit note — the tamper-evidence bridge back into the verifyhash product.
- **Stable embedding API.** Eight public names
  (`validate`, `validate_file`, `validate_root`, `validate_batch`,
  `fails_at`, `capabilities`, `Result`, `NotWellFormed`) are frozen and
  drift-guarded (`api_contract.json`, `test_api_contract.py`) for use as a
  library inside a Python test suite or an ERP/billing pipeline.
- **`einvoice info` introspection.** Read-only subcommand reporting the build's
  version, profiles, formats, rule count, and coverage as human text or
  `--json`, every field sourced from asserted artifacts.
- **Config file support.** `[tool.einvoice]` defaults for `format`,
  `fail-on`, and `lang` in `pyproject.toml`, with documented flag-over-config
  precedence (`test_config_file.py`).
- **Deterministic, network-free operation.** No outbound network access at
  any point (socket-layer guard, `test_network_egress.py`); output is
  invariant to locale, timezone, working directory, and input filename.
- **Packaged as an embeddable wheel.** One console script (`einvoice`), a
  `py.typed` marker for downstream type checkers, and a build that ships only
  the pure-Python package (the rule corpus and test vectors stay in the repo).

[0.2.0]: https://github.com/verifyhash/verifyhash
[0.1.0]: https://github.com/verifyhash/verifyhash

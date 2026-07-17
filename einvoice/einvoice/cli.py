"""Command-line interface for the einvoice validator.

Usage:
    einvoice validate <invoice.xml|-> [--json] [--quiet] [--profile=en16931|xrechnung]
    einvoice validate-batch <dir|glob> [--json] [--quiet] [--profile=en16931|xrechnung]
    einvoice receipt  <invoice.xml> [--profile=en16931|xrechnung]
    einvoice info [--json]
    einvoice --version

(also reachable as ``python3 -m einvoice ...`` and, from a source checkout,
``python3 einvoice.py ...`` — all three are the same entry point.)

Global flags:
    --version  print the packaged ``einvoice.__version__`` and exit 0. Takes
               precedence over everything else — no subcommand or file needed.
    --fail-on  OPT-IN exit-code severity threshold for ``validate`` /
               ``validate-batch`` (accepts ``--fail-on X`` and ``--fail-on=X``):
               choose which finding severity trips exit code 1. This is a pure
               POST-validation exit-code knob — it changes NEITHER the findings,
               the validation logic, the ``--json`` payload nor the human
               summary text; ONLY the process exit code. Values:
                 ``fatal``        (DEFAULT — exit 1 iff >=1 fatal finding; this
                                  is byte-identical to today, so OMITTING the
                                  flag is exactly the historical contract and
                                  the change is NON-BREAKING);
                 ``warning``      exit 1 iff >=1 fatal OR >=1 warning finding;
                 ``information``  strict: exit 1 iff >=1 finding of ANY severity.
               The threshold is measured over the validation findings (a
               Violation's ``severity``); it never affects the ``receipt``
               subcommand, and an invalid value is a usage error (exit 2). For
               ``validate-batch`` it is applied across the aggregate: exit 1 if
               ANY file crosses the chosen threshold; the parse-only ``3`` rule
               (some file only errored, none crossed) is left intact.
    --lang     language of the HUMAN validate summary only: ``en`` (default,
               unchanged behaviour) or ``de``. Under ``de`` a violated rule that
               carries an OFFICIAL German message (the BR-DE family, whose
               vendored KoSIT XRechnung ``<sch:assert>`` text is German) is shown
               with that verbatim German string; every other rule keeps its
               English message. ``--lang`` never affects ``--json`` output, rule
               ids, severities or which rules fire — only the displayed text.

Config file (opt-in defaults — see ``einvoice/config.py``):
    A ``.einvoice.toml`` in the current working directory, else a
    ``[tool.einvoice]`` table in ``./pyproject.toml`` (``.einvoice.toml``
    WINS when both exist), may set DEFAULTS for exactly three keys:
    ``format`` (``text``|``json`` — ``json`` is as if ``--json`` were
    passed), ``fail-on`` and ``lang``. Precedence: explicit CLI flag >
    config file > built-in default. Resolution happens ONCE at arg-parse
    level (below), so ``validate`` and ``validate-batch`` behave
    identically. An unknown key or non-string value is an actionable usage
    error (exit 2) naming the key and the accepted set; an invalid VALUE
    for a recognized key flows through the SAME vocabulary checks a bad
    flag hits — one shared error path, nothing silently swallowed. With no
    config file present, behavior is byte-identical to a build without
    this feature.

Subcommands:
    validate   report conformance (human summary, or --json full result).
               A source of ``-`` reads the invoice XML from stdin (the bytes
               are staged to a temp file and validated through the identical
               DTD/XXE/resource-hardened parser — the hardening is NOT relaxed
               for stdin). ``--quiet`` suppresses the human PASS/FAIL/warnings
               summary on stdout without changing the exit code; when combined
               with --json the JSON is still emitted (quiet only silences the
               human summary). --quiet has no effect on ``receipt``.
    validate-batch
               validate a WHOLE BATCH of invoices in one run. The argument is
               EITHER a directory (every ``*.xml`` / ``*.pdf`` invoice file
               under it, recursively, dotfiles skipped) OR a shell-style glob
               (e.g. ``invoices/*.xml`` or ``**/*.xml`` for a recursive match).
               Every file is validated through the SAME DTD/XXE/resource-
               hardened parser and rule engine ``validate`` uses — a hostile
               DOCTYPE/entity file is reported as an ERROR (never parsed, never
               aborts the batch). The directory and glob forms produce
               byte-identical aggregate counts over the same file set. This
               subcommand REUSES the batch engine in ``einvoice.report``
               (build_batch_report / build_batch_report_from_files /
               batch_exit_code / build_batch_text) verbatim — it re-implements
               no aggregation or rule logic; see that module for the aggregate
               ``einvoice-conformance-batch/v1`` schema. Prints a per-file
               PASS/FAIL/ERROR summary plus an aggregate tally (or, with
               --json, the aggregate batch dict). ``--quiet`` suppresses the
               human summary but preserves the exit code (and still emits the
               JSON when --json is set). A zero-match glob / empty directory is
               reported honestly as ``file_count: 0`` with a note, exit 0 — not
               a traceback. Exit code (the report.py precedence, fatal outranks
               parse): 0 when every file passes, 1 if ANY file has a fatal
               violation, 3 if some file only errored (not-well-formed /
               unsupported container) and none had a fatal.
    info       READ-ONLY build introspection: print what THIS build contains —
               package version, profiles, report format names, implemented
               business-rule count, the frozen syntax-binding coverage
               headline, and the attestation content hash. Takes no input
               file, validates nothing, always exits 0 (or 2 on extra
               arguments). Every value is read at runtime from the package
               itself or its committed artifacts (export/rules.json,
               attestation.json, the syntax-binding catalog) — nothing is
               hardcoded. ``--json`` emits one sorted-keys JSON object
               instead of the human ``key: value`` lines.
    receipt    emit a CANONICAL, DETERMINISTIC JSON conformance receipt: a
               byte-stable attestation of the outcome (tool+version, profile,
               verdict, failed fatal rule ids, input-document SHA-256, and a
               SHA-256 content hash of the receipt body). Re-running on the
               same bytes yields byte-identical output — the tamper-evidence
               bridge. See ``einvoice/receipt.py``.

Profiles:
    en16931 (default)  the EN 16931 core business rules
    xrechnung          core rules PLUS the German national CIUS layer
                       (BR-DE-*). Warnings/information are reported, but only
                       *fatal* violations make the invoice invalid (exit 1) —
                       the official Schematron ``flag`` semantics.

Exit codes (stable contract):
    0  the invoice passes every implemented fatal rule (``validate-batch``:
       every file passed, or the directory/glob matched no invoice files)
    1  at least one implemented fatal rule failed (``validate-batch``: ANY file
       has a fatal violation — fatal outranks a parse error)
    2  usage error — bad argv, or an OS-level input problem on the single-file
       subcommands: the named path is nonexistent, unreadable (e.g. a
       permission-denied open), a directory, or a dangling symlink; also
       ``validate -`` when stdin is closed/unreadable. Each prints one
       actionable ``error: ...`` line naming the path and the reason —
       never a traceback (see EXIT-CODES.md).
    3  input is not well-formed XML / parse error (``validate`` only; the
       ``receipt`` subcommand folds this into a FAIL receipt, exit 1;
       ``validate-batch`` returns 3 when some file only errored — not-well-
       formed / unsupported container — and no file had a fatal)
  141  broken pipe — the stdout consumer closed early (``... | head``, a dying
       ``jq``); 128+SIGPIPE, the shell convention. The CLI exits quietly with
       no traceback and writes nothing further; the verdict for that run is
       simply unavailable (the reader walked away). Purely additive — codes
       0/1/2/3 are untouched.
  130  interrupted — SIGINT / Ctrl-C aborted the run mid-validation;
       128+SIGINT, the shell convention. Quiet exit: no traceback, nothing
       further written, and the ``validate -`` stdin temp file is cleaned up
       (KeyboardInterrupt propagates through the cleanup ``finally`` before
       being caught at the entry point). Purely additive.
  143  terminated — SIGTERM aborted the run; 128+SIGTERM, the shell
       convention. The entry point converts the signal into an exception so
       the SAME temp-file cleanup runs (default signal death skips ``finally``
       and measurably leaked a stray ``einvoice-stdin-*.xml``), then exits
       quietly with this code. Purely additive.

Default output on failure: the FIRST fatal violated rule id, a human message
and the offending element. With --json, the full result (all violations,
each with its severity) is emitted.

Standard library only.
"""

import glob
import json
import os
import signal
import sys
import tempfile

from . import __version__
from .validate import validate_file, PROFILES, _severity
from .parser import NotWellFormed, parse_file
from .receipt import build_receipt, canonical_json
from .report import (
    syntax_binding_section,
    build_batch_report, build_batch_report_from_files,
    batch_exit_code, build_batch_text,
)
from .remediation import resolve_message, SUPPORTED_LANGS
from .config import load_config, ConfigError

USAGE = ("usage: einvoice validate <invoice.xml|-> "
         "[--json] [--quiet] [--profile=en16931|xrechnung] [--lang=en|de] "
         "[--fail-on=fatal|warning|information]\n"
         "       einvoice validate-batch <dir|glob> "
         "[--json] [--quiet] [--profile=en16931|xrechnung] "
         "[--fail-on=fatal|warning|information]\n"
         "       einvoice receipt <invoice.xml> "
         "[--profile=en16931|xrechnung]\n"
         "       einvoice info [--json]\n"
         "       einvoice --version")

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_USAGE = 2
EXIT_PARSE = 3
#: 128 + SIGPIPE(13) — the shell convention for "killed by a broken pipe".
#: Returned when the stdout consumer closes early (e.g. ``... --json | head``)
#: and a write raises BrokenPipeError: the CLI exits QUIETLY with this code
#: instead of dumping a traceback. Purely additive — no existing code (0/1/2/3)
#: is ever repurposed; see EXIT-CODES.md.
EXIT_PIPE = 141
#: 128 + SIGINT(2) — the shell convention for "interrupted" (Ctrl-C / SIGINT).
#: MEASURED defect this fixes: an unhandled KeyboardInterrupt mid-run dumped a
#: raw multi-frame traceback on stderr (runpy + cli frames) before the process
#: died — crash-looking output for a routine operator abort. Now :func:`main`
#: catches KeyboardInterrupt exactly like BrokenPipeError and returns this
#: code QUIETLY. The interrupt propagates as a normal exception first, so the
#: ``finally`` in :func:`_main` still unlinks the ``validate -`` stdin temp
#: file. Purely additive — codes 0/1/2/3/141 are untouched; see EXIT-CODES.md.
EXIT_INT = 130
#: 128 + SIGTERM(15) — the shell convention for "terminated". MEASURED defect
#: this fixes: default SIGTERM disposition kills the process instantly, so NO
#: ``finally`` runs — a SIGTERM landing while ``validate -`` is validating its
#: staged stdin bytes left a stray ``einvoice-stdin-*.xml`` in the temp dir
#: (confirmed live before this handler existed). :func:`main` now converts
#: SIGTERM into the :class:`_Terminated` exception so the same cleanup path
#: runs, then returns this code quietly. Purely additive; see EXIT-CODES.md.
EXIT_TERM = 143

#: Accepted ``--fail-on`` values (the codebase severity vocabulary). The
#: DEFAULT is ``fatal`` — i.e. omitting the flag is byte-identical to today.
FAIL_ON_LEVELS = ("fatal", "warning", "information")

#: Accepted values for the config-file ``format`` key — the two output forms
#: this CLI can emit: ``text`` (the human summary, the built-in default) and
#: ``json`` (equivalent to passing ``--json``). This is deliberately NOT the
#: nine-name ``einvoice.report`` ``--format`` vocabulary: that richer set
#: belongs to ``python3 -m einvoice.report``, which this CLI does not front.
OUTPUT_FORMATS = ("text", "json")

#: Severity ordering used to decide whether a finding CROSSES a chosen
#: ``--fail-on`` threshold: a finding crosses iff its rank is >= the threshold's
#: rank. So ``information`` (1) catches every severity, ``warning`` (2) catches
#: warning + fatal, and ``fatal`` (3) catches only fatal (today's default).
#: Any unknown severity is treated as ``fatal`` (matching ``validate._severity``).
_SEVERITY_RANK = {"information": 1, "warning": 2, "fatal": 3}


def _crosses_threshold(severity, fail_on):
    """True iff a finding of ``severity`` should trip exit 1 at ``fail_on``."""
    return (_SEVERITY_RANK.get(severity, _SEVERITY_RANK["fatal"])
            >= _SEVERITY_RANK[fail_on])


def _result_exit_code(result, fail_on):
    """Exit code for a single ``validate`` result under a ``--fail-on`` level.

    Layered on the EXISTING result (findings unchanged): EXIT_FAIL iff at least
    one finding crosses the chosen threshold, else EXIT_OK. With the default
    ``fatal`` this is exactly ``EXIT_OK if result.ok else EXIT_FAIL`` — byte-
    identical to the historical contract.
    """
    crosses = any(_crosses_threshold(_severity(v), fail_on)
                  for v in result.violations)
    return EXIT_FAIL if crosses else EXIT_OK


def _report_crosses(report, fail_on):
    """True iff a batch per-file report dict crosses the ``--fail-on`` level.

    Operates on the report's own ``violations`` records (each carrying a
    ``severity``) — an errored (not-well-formed / unsupported-container) file
    has no findings and therefore never crosses, so the parse-only ``EXIT_PARSE``
    rule is left to :func:`einvoice.report.batch_exit_code`.
    """
    return any(_crosses_threshold(v.get("severity"), fail_on)
               for v in report.get("violations", []))


def _artifact_json(name):
    """Load a committed repo-root JSON artifact that sits NEXT TO the package
    directory in a source checkout (``<repo>/attestation.json``,
    ``<repo>/export/rules.json``, ...). Returns the parsed object, or ``None``
    when the file is not reachable (e.g. an installed-package context, where
    only the ``einvoice/`` package itself ships) or unparsable — ``info`` then
    reports ``null`` for that field instead of crashing."""
    path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), name)
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _info_payload():
    """Assemble the ``einvoice info`` fields.

    SOURCING RULE (deliberate — the whole point of the command): every value
    is read or recomputed AT RUNTIME from the same source the test suite
    asserts, never retyped:

      * ``version``            ``einvoice.__version__`` (the packaged attribute).
      * ``profiles``           ``einvoice.validate.PROFILES`` (the dispatch tuple).
      * ``formats``            the ``einvoice.report.REPORT_FORMATS`` constant —
                               the exact vocabulary the ``--format`` check
                               enforces — plus the default ``text``.
      * ``rule_count``         the committed ``coverage_matrix.json`` via
                               :func:`einvoice.coverage.load_matrix` — the SAME
                               source ``gen_export.py`` builds
                               ``export/rules.json['rule_count']`` from (the
                               generator asserts the two agree).
      * ``coverage``           proven syntax-binding counts RECOMPUTED live via
                               ``einvoice.syntax_binding_eval.implemented_ids``
                               / ``cii_implemented_ids`` and the catalog's own
                               accounting totals — exactly the calls
                               ``gen_export.py`` makes for
                               ``export/coverage.json``; ``business_rules``
                               mirrors ``rule_count``.
      * ``attestation_sha256`` ``content_sha256`` from the committed
                               ``attestation.json`` (a generated hash — it has
                               no in-module recompute by design).

    Fields whose artifact is unreachable (installed-package context) degrade
    to ``None`` rather than raising; test_info.py asserts artifact equality
    from the source checkout, so any drift fails the suite.
    """
    # Local imports: only the info path needs the coverage-matrix loader and
    # the syntax-binding evaluator; every other CLI path is left untouched.
    from . import coverage as _coverage
    from . import syntax_binding_eval as _sbe
    from .report import REPORT_FORMATS

    try:
        matrix = _coverage.load_matrix()
        rule_count = int(matrix["rule_count"])
    except (OSError, KeyError, TypeError, ValueError):
        rule_count = None

    catalog = _sbe.load_catalog()
    acct = (catalog or {}).get("accounting", {})

    def _total(syntax):
        total = acct.get(syntax, {}).get("total")
        return int(total) if total is not None else None

    coverage = {
        "business_rules": {"total_asserted": rule_count},
        "syntax_binding": {
            "ubl": {"proven": len(_sbe.implemented_ids()),
                    "total": _total("ubl")},
            "cii": {"proven": len(_sbe.cii_implemented_ids()),
                    "total": _total("cii")},
        },
    }

    attestation = _artifact_json("attestation.json")
    attestation_sha256 = (attestation or {}).get("content_sha256")

    return {
        "version": __version__,
        "profiles": sorted(PROFILES),
        "formats": sorted(set(REPORT_FORMATS) | {"text"}),
        "rule_count": rule_count,
        "coverage": coverage,
        "attestation_sha256": attestation_sha256,
    }


def _info_lines(payload, prefix=""):
    """Flatten the info payload into stable, sorted ``key: value`` lines
    (nested objects become dotted keys, lists comma-joined)."""
    lines = []
    for key in sorted(payload):
        value = payload[key]
        full = prefix + key
        if isinstance(value, dict):
            lines.extend(_info_lines(value, prefix=full + "."))
        elif isinstance(value, (list, tuple)):
            lines.append("%s: %s" % (full, ", ".join(str(v) for v in value)))
        else:
            lines.append("%s: %s" % (full, value))
    return lines


def _run_info(as_json):
    """Drive ``einvoice info``: read-only, no input, nothing on stderr.

    ``--json``: exactly one ``json.dumps(..., sort_keys=True)`` object on
    stdout. Human form: the same payload flattened to sorted ``key: value``
    lines. Exit 0 either way.
    """
    payload = _info_payload()
    if as_json:
        sys.stdout.write(json.dumps(payload, sort_keys=True) + "\n")
    else:
        sys.stdout.write("\n".join(_info_lines(payload)) + "\n")
    return EXIT_OK


def _run_validate_batch(rest, profile, as_json, quiet, fail_on="fatal"):
    """Drive ``einvoice validate-batch <dir|glob>``.

    REUSES the batch engine in :mod:`einvoice.report` verbatim — no aggregation
    or rule logic is re-implemented here:

      * a directory argument goes through :func:`einvoice.report.build_batch_report`
        (which walks it via ``collect_invoice_files`` and aggregates through the
        shared file-list helper), exactly as ``python3 -m einvoice.report <dir>``
        does;
      * anything else is treated as a shell-style glob, expanded with the stdlib
        :mod:`glob` module (``recursive=True`` so ``**`` matches across
        directories), filtered to regular files, sorted deterministically, and
        aggregated through the SAME
        :func:`einvoice.report.build_batch_report_from_files` helper — so the
        aggregate dict is byte-identical to the directory form over the same set
        of files.

    Every batched file flows through the identical ``build_report`` ->
    ``validate_file`` / ``parse_file`` path, so the DTD/XXE/resource hardening
    applies to every input unchanged (a hostile DOCTYPE file becomes an ERROR
    entry, never a parse or a crash). Prints the human per-file summary via
    :func:`einvoice.report.build_batch_text` unless ``--quiet``; with ``--json``
    emits the aggregate batch dict as ``json.dumps(batch, indent=2)`` (still
    emitted under ``--quiet``). Returns
    :func:`einvoice.report.batch_exit_code` (0 all-pass; 1 if any file has a
    fatal; 3 if some file only errored and none fatal). A zero-match glob /
    empty directory yields ``file_count: 0`` + a note, exit 0 — never a
    traceback.
    """
    if len(rest) != 1:
        sys.stderr.write(
            "error: validate-batch takes exactly one <dir|glob> argument\n"
            + USAGE + "\n")
        return EXIT_USAGE

    target = rest[0]
    if os.path.isdir(target):
        batch = build_batch_report(target, profile=profile)
    else:
        # Not an existing directory -> a shell-style glob. Expand it with the
        # stdlib glob module (recursive ** allowed), keep only regular files,
        # and sort so the batch output is deterministic across filesystems.
        matches = sorted(
            p for p in glob.glob(target, recursive=True) if os.path.isfile(p))
        batch = build_batch_report_from_files(
            matches, profile=profile, root=target)

    if as_json:
        sys.stdout.write(json.dumps(batch, indent=2) + "\n")
    elif not quiet:
        sys.stdout.write(build_batch_text(batch))
    # Exit code, layered on the SAME aggregate (the printed report/JSON is
    # untouched): if ANY file crosses the chosen threshold, EXIT_FAIL; otherwise
    # defer to the existing report.py precedence (which yields EXIT_PARSE=3 for an
    # error-only, no-fatal batch, else EXIT_OK). With the default ``fatal`` this
    # is byte-identical to ``batch_exit_code(batch)``: the only files that cross a
    # fatal threshold are exactly the files ``batch_exit_code`` already fails on.
    if any(_report_crosses(r, fail_on) for r in batch.get("files", [])):
        return EXIT_FAIL
    return batch_exit_code(batch)


def _main(argv=None):
    """Run the CLI. Returns the process exit code (see module docstring).

    This is the real dispatcher; :func:`main` wraps it ONLY to convert three
    abort conditions into quiet, documented exits: BrokenPipeError (stdout
    consumer closed early, e.g. ``... | head``) -> ``EXIT_PIPE`` (141),
    KeyboardInterrupt (SIGINT / Ctrl-C) -> ``EXIT_INT`` (130), and SIGTERM
    (via the handler main installs) -> ``EXIT_TERM`` (143). Nothing else is
    added.
    """
    if argv is None:
        argv = sys.argv[1:]
    args = list(argv)

    # --version takes precedence over everything: no subcommand or file needed.
    # Print the packaged version (never a hardcoded literal) and exit 0.
    if "--version" in args:
        sys.stdout.write("einvoice %s\n" % __version__)
        return EXIT_OK

    as_json = False
    if "--json" in args:
        as_json = True
        args = [a for a in args if a != "--json"]

    # --quiet silences the human-readable validate summary on stdout; it never
    # changes the exit code and never suppresses --json output.
    quiet = False
    if "--quiet" in args:
        quiet = True
        args = [a for a in args if a != "--quiet"]

    profile = "en16931"
    # --lang selects the language of the HUMAN-facing message only. 'en'
    # (default) keeps today's behaviour byte-for-byte; 'de' swaps a violation's
    # message to the official German KoSIT XRechnung <sch:assert> text where one
    # exists (falling back to English otherwise). It NEVER touches --json output,
    # rule ids, severities or which rules fire.
    # ``None`` = "not given on the command line": the single config-file
    # resolution below then fills in the config value or the built-in default
    # 'en', so an EXPLICIT flag always wins over a config file.
    lang = None
    # --fail-on is an OPT-IN post-validation exit-code threshold. The default
    # 'fatal' reproduces today's contract byte-for-byte (exit 1 iff >=1 fatal);
    # it never touches the findings, --json payload or human summary — only the
    # process exit code. Parsed globally (like --profile/--lang) but APPLIED only
    # to validate / validate-batch. ``None`` = "not given on the command line"
    # (the config value or the built-in 'fatal' fills it in below).
    fail_on = None
    rest = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--fail-on":
            if i + 1 >= len(args):
                sys.stderr.write(
                    "error: --fail-on needs a value\n" + USAGE + "\n")
                return EXIT_USAGE
            fail_on = args[i + 1]
            i += 2
            continue
        if a.startswith("--fail-on="):
            fail_on = a.split("=", 1)[1]
            i += 1
            continue
        if a == "--profile":
            if i + 1 >= len(args):
                sys.stderr.write("error: --profile needs a value\n" + USAGE + "\n")
                return EXIT_USAGE
            profile = args[i + 1]
            i += 2
            continue
        if a.startswith("--profile="):
            profile = a.split("=", 1)[1]
            i += 1
            continue
        if a == "--lang":
            if i + 1 >= len(args):
                sys.stderr.write("error: --lang needs a value\n" + USAGE + "\n")
                return EXIT_USAGE
            lang = args[i + 1]
            i += 2
            continue
        if a.startswith("--lang="):
            lang = a.split("=", 1)[1]
            i += 1
            continue
        rest.append(a)
        i += 1
    args = rest

    # Config-file defaults (.einvoice.toml first, else [tool.einvoice] in
    # ./pyproject.toml — einvoice/config.py). Resolved exactly ONCE, here at
    # arg-parse level, so validate and validate-batch (and every other
    # subcommand) share a single resolution — never per-subcommand copies.
    # Precedence: explicit CLI flag > config file > built-in default. A config
    # problem (unknown key, non-string value, unreadable file) is the SAME
    # usage error a bad flag is: one actionable ``error:`` line on stderr,
    # exit 2, never silently swallowed. An invalid VALUE for a recognized key
    # ('lang'/'fail-on') deliberately falls through to the very vocabulary
    # checks below that a bad flag hits, so both sources share one error path.
    # With no config file, cfg == {} and every default below is byte-identical
    # to the historical contract.
    try:
        cfg = load_config()
    except ConfigError as exc:
        sys.stderr.write("error: %s\n%s\n" % (exc, USAGE))
        return EXIT_USAGE
    if fail_on is None:
        fail_on = cfg.get("fail-on", "fatal")
    if lang is None:
        lang = cfg.get("lang", "en")
    if not as_json:
        # The config 'format' key defaults the output form; an explicit
        # --json flag already decided (and wins). 'text' is the built-in
        # default, so absence of the key changes nothing. An unknown format
        # name gets the same actionable exit-2 treatment as any bad flag
        # value (there is no --format flag on THIS CLI to mistype, so the
        # message names the config as the source).
        fmt = cfg.get("format", "text")
        if fmt not in OUTPUT_FORMATS:
            sys.stderr.write(
                "error: unknown format %r in config (choose from %s)\n%s\n"
                % (fmt, ", ".join(OUTPUT_FORMATS), USAGE))
            return EXIT_USAGE
        as_json = fmt == "json"

    if profile not in PROFILES:
        sys.stderr.write("error: unknown profile %r (choose from %s)\n%s\n"
                         % (profile, ", ".join(PROFILES), USAGE))
        return EXIT_USAGE
    if lang not in SUPPORTED_LANGS:
        sys.stderr.write("error: unknown lang %r (choose from %s)\n%s\n"
                         % (lang, ", ".join(SUPPORTED_LANGS), USAGE))
        return EXIT_USAGE
    if fail_on not in FAIL_ON_LEVELS:
        sys.stderr.write("error: unknown --fail-on value %r (choose from %s)\n%s\n"
                         % (fail_on, ", ".join(FAIL_ON_LEVELS), USAGE))
        return EXIT_USAGE

    # ``info`` is a read-only build introspection: no input file, no
    # validation. Dispatched before the file-driven subcommands; it reuses
    # the already-parsed global ``--json`` flag and accepts NOTHING else —
    # any extra argument or unknown flag is a usage error (exit 2),
    # consistent with the existing argv discipline.
    if args and args[0] == "info":
        if len(args) != 1:
            sys.stderr.write(
                "error: info takes no arguments (got %r)\n%s\n"
                % (" ".join(args[1:]), USAGE))
            return EXIT_USAGE
        return _run_info(as_json)

    # ``validate-batch`` has its own dir|glob dispatch (no stdin, no on-disk
    # single-file check). Handle it before the single-file subcommand parsing
    # so the ``validate``/``receipt`` path below stays byte-for-byte unchanged.
    # It reuses the SAME already-parsed --json/--quiet/--profile flags.
    if args and args[0] == "validate-batch":
        return _run_validate_batch(args[1:], profile, as_json, quiet, fail_on)

    if len(args) < 2 or args[0] not in ("validate", "receipt"):
        sys.stderr.write(USAGE + "\n")
        return EXIT_USAGE
    if len(args) > 2:
        sys.stderr.write("error: unexpected extra arguments\n" + USAGE + "\n")
        return EXIT_USAGE

    subcommand = args[0]
    path = args[1]

    # ``validate -`` reads the invoice XML from stdin. The bytes are staged to a
    # temp file and validated through validate_file/parse_file exactly as any
    # on-disk invoice would be — the SAME DTD/XXE/resource-hardened parser
    # (einvoice._xmlsec) applies unchanged; stdin does not get a relaxed path.
    # ``display_path`` is what appears in the report/summary ("-" for stdin);
    # ``path`` is the real filesystem path handed to the validator.
    display_path = path
    tmp_path = None
    if path == "-" and subcommand == "validate":
        # MEASURED defect this guards (2026-07-17): with fd 0 closed at
        # startup (`einvoice validate - 0<&-`) CPython sets ``sys.stdin`` to
        # None, so ``sys.stdin.buffer`` raised an AttributeError traceback
        # with Python's generic exit 1. Both stdin failure modes (no stdin at
        # all, or a read that fails at the OS level) are now the same
        # actionable usage error naming ``-`` and the reason.
        if sys.stdin is None:
            sys.stderr.write("error: cannot read -: stdin is closed\n")
            return EXIT_USAGE
        try:
            data = sys.stdin.buffer.read()
        except OSError as exc:
            sys.stderr.write("error: cannot read -: %s\n"
                             % (exc.strerror or exc))
            return EXIT_USAGE
        fd, tmp_path = tempfile.mkstemp(suffix=".xml", prefix="einvoice-stdin-")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
        except BaseException:
            os.unlink(tmp_path)
            raise
        path = tmp_path
    # OS-level input triage for the single-file subcommands (validate/receipt
    # only — validate-batch has its own resilience-tested dispatch above).
    # ``os.path.isfile`` is False for all three states below, but each gets
    # its ACCURATE reason: before this split, a directory or a dangling
    # symlink was reported as "no such file" — non-zero and traceback-free,
    # but naming the wrong cause. All three stay on the documented usage
    # code (2): the tool was pointed at something that cannot be an invoice
    # file, and no validation happened.
    elif os.path.isdir(path):
        sys.stderr.write(
            "error: is a directory (expected a single invoice file; "
            "use validate-batch for directories): %s\n" % display_path)
        return EXIT_USAGE
    elif os.path.islink(path) and not os.path.exists(path):
        sys.stderr.write(
            "error: dangling symlink (its target does not exist): %s\n"
            % display_path)
        return EXIT_USAGE
    elif not os.path.isfile(path):
        sys.stderr.write("error: no such file: %s\n" % display_path)
        return EXIT_USAGE

    try:
        if subcommand == "receipt":
            # A conformance receipt always emits a canonical JSON document (the
            # receipt IS the output); the exit code mirrors the verdict so it can
            # gate a build. Not-well-formed input is folded into a FAIL receipt by
            # build_receipt, so nothing here raises NotWellFormed. --quiet does
            # not apply to receipt (the receipt is the whole output).
            receipt = build_receipt(path, profile=profile)
            sys.stdout.write(canonical_json(receipt) + "\n")
            return (EXIT_OK if receipt["receipt"]["verdict"] == "PASS"
                    else EXIT_FAIL)

        try:
            result = validate_file(path, profile=profile)
        except NotWellFormed as exc:
            if as_json:
                sys.stdout.write(json.dumps({
                    "source": display_path,
                    "valid": False,
                    "error": "not-well-formed",
                    "message": str(exc),
                }, indent=2) + "\n")
            else:
                sys.stderr.write(
                    "S-WF: input is not well-formed XML: %s\n" % exc)
            return EXIT_PARSE

        # Surface the distinct 'syntax-binding' category (the UBL
        # absence-restriction / cardinality / existence asserts of
        # einvoice.syntax_binding_eval) via the SAME projection report.py uses —
        # reused verbatim, no evaluator re-implementation. These findings are
        # reported as WARNINGS and NEVER change `valid` or the process exit code:
        # exit stays driven solely by fatal business-rule violations,
        # byte-identical to today. validate_file already parsed this file cleanly
        # above, so this re-parse through the identical hardened parser cannot
        # raise NotWellFormed.
        sb = syntax_binding_section(parse_file(path))

        if as_json:
            out = result.to_dict(source=display_path)
            # Adds the `syntax_bindings` array + its two count fields to the
            # existing result shape; the original keys and their values stay
            # byte-identical.
            out.update(sb)
            sys.stdout.write(json.dumps(out, indent=2) + "\n")
        elif not quiet:
            if result.ok:
                non_fatal = len(result.violations)
                suffix = (" — %d non-fatal warning(s) reported" % non_fatal
                          if non_fatal else "")
                sys.stdout.write("PASS: %s (all implemented fatal rules, "
                                 "profile=%s)%s\n"
                                 % (display_path, profile, suffix))
            else:
                v = next(x for x in result.violations
                         if _severity(x) == "fatal")
                # --lang de surfaces the official German message where the rule
                # carries one (BR-DE family); every other rule keeps its English
                # message. Only the DISPLAY string changes — rule_id/element and
                # the exit code are untouched.
                message = resolve_message(v.rule_id, v.message, lang)
                sys.stdout.write(
                    "FAIL: %s\n  %s: %s\n  offending element: %s\n"
                    % (display_path, v.rule_id, message, v.element))
            # Syntax-binding warnings are a separate, non-blocking category —
            # print the count on its own line so the exit-driving FAIL/PASS
            # verdict above stays unambiguous.
            sys.stdout.write("Syntax-binding warnings: %d\n"
                             % sb["syntax_binding_warning_count"])

        # Exit code ONLY (the JSON payload / human summary above are already
        # written and untouched by --fail-on). Default 'fatal' == today's
        # ``EXIT_OK if result.ok else EXIT_FAIL``; a lower threshold trips
        # EXIT_FAIL on warning/information findings too.
        return _result_exit_code(result, fail_on)
    except BrokenPipeError:
        # An early-closed stdout consumer keeps its own documented contract
        # (EXIT_PIPE=141, handled in main()); it must never be folded into
        # the OS-input arm below even though BrokenPipeError is an OSError.
        raise
    except OSError as exc:
        # MEASURED defect this fixes (2026-07-17): an invoice file that
        # exists but cannot be READ (e.g. chmod 000) passed the isfile()
        # check, then open() inside validate_file/build_receipt raised
        # PermissionError — a raw multi-frame traceback on stderr with
        # Python's generic exit 1, indistinguishable from a FAIL verdict.
        # This arm catches exactly the OSError family (FileNotFoundError /
        # PermissionError / IsADirectoryError / ...) that an OS-level input
        # failure raises at this boundary — never a bare except, and never a
        # verdict change: no validation happened, so the honest code is the
        # documented usage error (2), same as a nonexistent path. The message
        # names the offending path AND the OS reason (exc.strerror, e.g.
        # "Permission denied").
        sys.stderr.write("error: cannot read %s: %s\n"
                         % (display_path, exc.strerror or exc))
        return EXIT_USAGE
    finally:
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


class _Terminated(Exception):
    """SIGTERM, converted to a regular exception by the handler :func:`main`
    installs. Raising (instead of dying at the default disposition) lets every
    ``try/finally`` on the stack run — most importantly the ``validate -``
    stdin temp-file unlink in :func:`_main` — before :func:`main` catches it
    and returns the quiet, documented ``EXIT_TERM`` (143)."""


def _raise_terminated(signum, frame):
    """SIGTERM handler: surface the signal as :class:`_Terminated` at the
    current execution point so cleanup ``finally`` blocks run."""
    raise _Terminated()


def main(argv=None):
    """CLI entry point: :func:`_main` + broken-pipe totality (EXIT_PIPE=141)
    + clean interrupt/termination abort (EXIT_INT=130, EXIT_TERM=143).

    When the stdout consumer exits early (``einvoice validate-batch ... | head``,
    a dying ``jq``, a closed CI log pipe), a stdout write past the OS pipe
    buffer raises BrokenPipeError. Without handling, that surfaces as a raw
    traceback on stderr plus Python's generic exit 1 — indistinguishable from a
    crash. Here it becomes a QUIET exit with the documented ``EXIT_PIPE`` (141
    = 128+SIGPIPE, the shell convention for a pipe-killed process).

    The handler follows the stdlib-recommended pattern (python.org "Note on
    SIGPIPE"): duplicate an ``os.devnull`` fd onto stdout's fd so the
    interpreter-shutdown flush of the buffered stream cannot raise a SECONDARY
    BrokenPipeError traceback, write nothing further, and return 141. The
    ``sys.stdout.flush()`` INSIDE the ``try`` forces any buffered broken-pipe
    write to surface here (not at shutdown), so the exit code is deterministic
    even when the report fits Python's userspace buffer.

    Interrupt/termination (both MEASURED live before the fix, see
    EXIT-CODES.md):

    * SIGINT (Ctrl-C) raised KeyboardInterrupt, which nothing caught — a raw
      multi-frame traceback on stderr for a routine operator abort. Now it is
      caught HERE, exactly mirroring the BrokenPipeError pattern below, and
      becomes a quiet, documented ``EXIT_INT`` (130 = 128+SIGINT). Because
      KeyboardInterrupt propagates as a normal exception, the ``finally`` in
      :func:`_main` has already unlinked the ``validate -`` stdin temp file by
      the time it reaches this handler.
    * SIGTERM's DEFAULT disposition kills the process with no ``finally``
      cleanup at all — measured to leak a stray ``einvoice-stdin-*.xml`` temp
      file when the signal landed while ``validate -`` was mid-validation. So
      a handler installed here converts SIGTERM to :class:`_Terminated`; the
      cleanup runs and the exit is the quiet, documented ``EXIT_TERM``
      (143 = 128+SIGTERM). The previous SIGTERM disposition is restored on
      the way out, so an in-process caller's signal handling is untouched.

    Neither abort path writes anything further: like a broken pipe, an
    interrupt is the operator's plumbing, not a validation outcome — the
    verdict for the aborted run is simply unavailable.

    This wrapper changes NOTHING else: no validation logic, no report bytes,
    no verdicts, and every existing exit code (0/1/2/3/141) is returned
    untouched.
    """
    try:
        # Convert SIGTERM into an exception so cleanup ``finally`` blocks run
        # (the ValueError arm: signal handlers can only be installed in the
        # main thread — an in-process harness on another thread just keeps
        # the default disposition, exactly as before this handler existed).
        _previous_sigterm = signal.signal(signal.SIGTERM, _raise_terminated)
        _restore_sigterm = True
    except ValueError:
        _restore_sigterm = False
    try:
        code = _main(argv)
        sys.stdout.flush()
        return code
    except KeyboardInterrupt:
        # SIGINT / Ctrl-C: quiet documented abort — no traceback, nothing
        # further written. _main's finally already removed any stdin temp file.
        return EXIT_INT
    except _Terminated:
        # SIGTERM, post-cleanup (the handler raised, so every finally ran).
        return EXIT_TERM
    except BrokenPipeError:
        # Point stdout's fd at devnull BEFORE returning: Python flushes
        # sys.stdout at interpreter shutdown, and flushing a broken pipe there
        # would print the classic "Exception ignored ... BrokenPipeError"
        # secondary traceback that this handler exists to prevent.
        try:
            devnull_fd = os.open(os.devnull, os.O_WRONLY)
            os.dup2(devnull_fd, sys.stdout.fileno())
        except (OSError, ValueError):
            # No real fd behind sys.stdout (e.g. an in-process StringIO
            # harness) — nothing to redirect, and nothing left to flush.
            pass
        return EXIT_PIPE
    finally:
        # Leave the process's SIGTERM disposition exactly as we found it —
        # in-process callers (tests, embedding harnesses) keep their own
        # handler once main() returns.
        if _restore_sigterm and _previous_sigterm is not None:
            signal.signal(signal.SIGTERM, _previous_sigterm)


if __name__ == "__main__":
    sys.exit(main())

"""Command-line interface for the einvoice validator.

Usage:
    einvoice validate <invoice.xml|-> [--json] [--quiet] [--profile=en16931|xrechnung]
    einvoice validate-batch <dir|glob> [--json] [--quiet] [--profile=en16931|xrechnung]
    einvoice receipt  <invoice.xml> [--profile=en16931|xrechnung]
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
    2  usage error
    3  input is not well-formed XML / parse error (``validate`` only; the
       ``receipt`` subcommand folds this into a FAIL receipt, exit 1;
       ``validate-batch`` returns 3 when some file only errored — not-well-
       formed / unsupported container — and no file had a fatal)

Default output on failure: the FIRST fatal violated rule id, a human message
and the offending element. With --json, the full result (all violations,
each with its severity) is emitted.

Standard library only.
"""

import glob
import json
import os
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

USAGE = ("usage: einvoice validate <invoice.xml|-> "
         "[--json] [--quiet] [--profile=en16931|xrechnung] [--lang=en|de] "
         "[--fail-on=fatal|warning|information]\n"
         "       einvoice validate-batch <dir|glob> "
         "[--json] [--quiet] [--profile=en16931|xrechnung] "
         "[--fail-on=fatal|warning|information]\n"
         "       einvoice receipt <invoice.xml> "
         "[--profile=en16931|xrechnung]\n"
         "       einvoice --version")

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_USAGE = 2
EXIT_PARSE = 3

#: Accepted ``--fail-on`` values (the codebase severity vocabulary). The
#: DEFAULT is ``fatal`` — i.e. omitting the flag is byte-identical to today.
FAIL_ON_LEVELS = ("fatal", "warning", "information")

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


def main(argv=None):
    """Run the CLI. Returns the process exit code (see module docstring)."""
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
    lang = "en"
    # --fail-on is an OPT-IN post-validation exit-code threshold. The default
    # 'fatal' reproduces today's contract byte-for-byte (exit 1 iff >=1 fatal);
    # it never touches the findings, --json payload or human summary — only the
    # process exit code. Parsed globally (like --profile/--lang) but APPLIED only
    # to validate / validate-batch.
    fail_on = "fatal"
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
        data = sys.stdin.buffer.read()
        fd, tmp_path = tempfile.mkstemp(suffix=".xml", prefix="einvoice-stdin-")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
        except BaseException:
            os.unlink(tmp_path)
            raise
        path = tmp_path
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
    finally:
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())

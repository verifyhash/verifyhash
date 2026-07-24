"""Command-line interface for the einvoice validator.

Usage:
    einvoice validate <invoice.xml|-> [--json] [--quiet] [--profile=en16931|xrechnung]
    einvoice validate-batch <dir|glob> [--json] [--quiet] [--profile=en16931|xrechnung]
    einvoice receipt  <invoice.xml> [--profile=en16931|xrechnung]
    einvoice receipt  --verify <receipt.json>
    einvoice info [--json]
    einvoice --show-config
    einvoice --version

(also reachable as ``python3 -m einvoice ...`` and, from a source checkout,
``python3 einvoice.py ...`` — all three are the same entry point.)

Global flags:
    --version  print the packaged ``einvoice.__version__`` and exit 0. Takes
               precedence over everything else — no subcommand or file needed.
    --show-config
               READ-ONLY observability dry run: resolve the EFFECTIVE
               ``format`` / ``fail-on`` / ``lang`` exactly as a real
               ``validate`` run would (explicit flag > config file > built-in
               default) and print each with its SOURCE — one of ``flag`` / the
               config filename (``.einvoice.toml`` | ``pyproject.toml``) /
               ``default`` — then exit 0. Reads NO input file and runs NO
               validation; like ``info`` it writes only stdout, nothing on
               stderr on success. A misconfigured file still errors (exit 2)
               with the same message a real run would give — the resolution and
               vocabulary checks are shared, not re-implemented. Purely
               additive: an ordinary ``validate`` run with the flag absent is
               byte-identical to today.
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
               ``receipt --verify <receipt.json> [--json]`` is the symmetric
               CHECK: it re-hashes an existing receipt's canonical body (reusing
               the very canonicalizer that built it) and compares to the stored
               ``content_sha256`` — prints ``VERIFIED`` (exit 0) on a match,
               ``TAMPERED`` (exit 1) when the body no longer matches its hash,
               and a usage error (exit 2) on a non-JSON / non-receipt file. It
               validates nothing and changes no verdict. With ``--json`` it
               emits one sorted-keys JSON object (``verdict`` / ``match`` /
               ``recomputed`` / ``stored`` / ``path`` / ``display_path``)
               instead of the human lines; the exit code is unchanged, and the
               usage-error leg still emits only its ``error:`` stderr line.

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
from .receipt import build_receipt, canonical_json, _sha256_hex
from .report import (
    syntax_binding_section,
    build_batch_report, build_batch_report_from_files,
    batch_exit_code, build_batch_text,
    REPORT_FORMATS,
)
from .remediation import resolve_message, SUPPORTED_LANGS
from .config import load_config_with_source, ConfigError
from .pdf_container import is_pdf_file

USAGE = ("usage: einvoice validate <invoice.xml|-> "
         "[--json] [--quiet] [--profile=en16931|xrechnung] [--lang=en|de] "
         "[--fail-on=fatal|warning|information]\n"
         "       einvoice validate-batch <dir|glob> "
         "[--json] [--quiet] [--profile=en16931|xrechnung] "
         "[--fail-on=fatal|warning|information]\n"
         "       einvoice receipt <invoice.xml> "
         "[--profile=en16931|xrechnung]\n"
         "       einvoice receipt --verify <receipt.json> [--json]\n"
         "       einvoice info [--json]\n"
         "       einvoice --show-config\n"
         "       einvoice --version\n"
         "       einvoice --help")

#: The valid top-level subcommands, in one place so the dispatch membership
#: test and the unknown-subcommand error message can never drift apart. Note
#: ``validate-batch`` (and ``info``/``--show-config``/``--version``) are
#: dispatched a few lines EARLIER than the single-file ``validate``/``receipt``
#: leg; this tuple names the file-driven set an ERP adopter is choosing from.
VALID_SUBCOMMANDS = ("validate", "validate-batch", "receipt")

#: The DOCUMENTED command surface: everything a first-run user may legitimately
#: type at this entry point. ``VALID_SUBCOMMANDS`` above is the DISPATCH set
#: (the file-driven leg of the argv parser); this tuple is the DOCUMENTATION set
#: and additionally names the informational commands, which are dispatched
#: earlier and are therefore absent from the dispatch tuple.
#:
#: MEASURED defect this fixes: the ``unknown subcommand`` banner listed only the
#: dispatch set, so a user who typed ``einvoice --explain BR-DE-1`` was told to
#: "choose from validate, validate-batch, receipt" — ``info`` and
#: ``--show-config`` exist and were simply never mentioned. Both the banner and
#: ``test_cli_help.py``'s completeness guard read THIS tuple, so the error
#: banner and ``--help`` can no longer drift apart. Adding a command means
#: adding it here, and the help guard then fails until ``HELP`` describes it.
COMMAND_SURFACE = VALID_SUBCOMMANDS + ("info", "--show-config", "--version",
                                       "--help")

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

#: The report-only ``--format`` names: every ``einvoice.report`` registry format
#: that THIS CLI cannot emit itself. DERIVED from ``REPORT_FORMATS`` minus the
#: forms this CLI does emit, never retyped — so registering a new emitter in
#: :mod:`einvoice.report` documents itself in ``--help`` instead of staying
#: invisible to a pip-only adopter (``test_cli_help.py`` fails if any registry
#: name goes unnamed in the help text). MEASURED gap this closes: seven of the
#: nine CI report formats (junit/sarif/gitlab/github/azure/html/badge) were
#: never mentioned anywhere a wheel-only user could see them.
REPORT_ONLY_FORMATS = tuple(sorted(set(REPORT_FORMATS) - set(OUTPUT_FORMATS)))

#: The ``--help`` / ``-h`` text: the machine-readable ``USAGE`` synopsis PLUS a
#: one-line-per-command description block. Every entry names a real command so
#: an ERP adopter's first ``einvoice --help`` explains what each does rather
#: than erroring. The command names here MUST cover every ``COMMAND_SURFACE``
#: entry (the dispatch subcommands plus ``info`` / ``--show-config`` /
#: ``--version`` / ``--help``); ``test_cli_help.py`` is a completeness guard
#: that fails if a command is added to that tuple but not documented here.
#:
#: Both trailing format lines are REGISTRY-SOURCED so they can never advertise
#: something that does not exist: ``OUTPUT_FORMATS`` for the forms this CLI
#: emits itself, ``REPORT_ONLY_FORMATS`` for the rest of the
#: :mod:`einvoice.report` vocabulary. This CLI still has NO ``--format`` flag of
#: its own — the only ``--format`` named here belongs to the explicitly spelled
#: ``python3 -m einvoice.report`` sibling entry point, which is exactly the
#: pointer a pip-only adopter needs. Every reference is a URL, never a repo file
#: the wheel does not ship.
HELP = (
    USAGE + "\n\n"
    "Commands:\n"
    "  validate <invoice.xml|->   validate one EN 16931 / XRechnung invoice\n"
    "                             (XML file, or '-' to read from stdin);\n"
    "                             exit 0 = conformant, 1 = findings, 3 = not XML\n"
    "  validate-batch <dir|glob>  validate every matching invoice and summarise\n"
    "  receipt <invoice.xml>      emit a JSON conformance receipt for one invoice\n"
    "                             (receipt --verify <receipt.json> re-checks one)\n"
    "  info                       print read-only build/version metadata; run nothing\n"
    "  --show-config              resolve and print the effective config; run nothing\n"
    "  --version                  print the packaged einvoice version and exit\n"
    "  --help, -h                 show this help and exit\n\n"
    "Output form: %s (text is the default; --json selects json).\n"
    "Other report formats (%s) come from the sibling entry point:\n"
    "  python3 -m einvoice.report --format <fmt> <invoice.xml>\n"
    "Full flag set and documentation: https://verifyhash.com/einvoice/\n"
    "This CLI validates; it never sends your invoice anywhere."
    % (" or ".join(OUTPUT_FORMATS), ", ".join(REPORT_ONLY_FORMATS)))

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
    falls back to the packaged attestation (see :func:`_packaged_attestation`)
    or reports ``null`` for that field instead of crashing."""
    path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), name)
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _packaged_attestation():
    """Load ``attestation.json`` shipped INSIDE the package (the ``package-data``
    trust proof) — the copy that travels in the wheel, distinct from the
    source-tree copy next to the package that :func:`_artifact_json` reads.

    In a source checkout the two are byte-identical (``test_attestation.py``
    guards that), so reading this copy yields the same numbers. In an installed
    wheel the source-tree artifacts (``coverage_matrix.json``,
    ``syntax_binding_catalog.json``, the top-level ``attestation.json``) are NOT
    shipped — only this packaged attestation is — so it is the sole on-disk
    source the installed artifact can self-report from. Returns the parsed
    object, or ``None`` if it is somehow absent/unparsable."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "attestation.json")
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

    In an installed-wheel context the source-tree artifacts above are absent,
    so ``rule_count``, the ``syntax_binding`` counts and ``attestation_sha256``
    fall back to the packaged ``attestation.json`` (the ``package-data`` trust
    proof shipped inside the wheel) and self-report the same real numbers a
    checkout produces — never ``None``/0. The fallback is purely additive: with
    the source artifacts present it never fires, so test_info.py + the registry
    gates (which assert artifact equality from the source checkout) still hold,
    and test_wheel_self_report.py pins the wheel-only path.
    """
    # Local imports: only the info path needs the coverage-matrix loader and
    # the syntax-binding evaluator; every other CLI path is left untouched.
    from . import coverage as _coverage
    from . import syntax_binding_eval as _sbe
    from .report import REPORT_FORMATS

    # WHEEL-CARRIED FALLBACK (additive, source-tree behaviour unchanged).
    # The primary sources — coverage_matrix.json, syntax_binding_catalog.json,
    # the top-level attestation.json — sit next to the package in a checkout but
    # are NOT shipped in the wheel; only the package-data attestation.json
    # travels inside the installed package. Each field below resolves from its
    # primary source first and only falls back to that packaged attestation when
    # the primary is genuinely absent (installed-wheel context). In a source
    # checkout every primary source is present, so no fallback fires and the
    # payload is byte-identical to before (test_info.py + the registry gates
    # pin that); in a wheel the artifact self-reports its real numbers instead
    # of null/0.
    packaged = _packaged_attestation()
    att_body = (packaged or {}).get("attestation") or {}

    try:
        matrix = _coverage.load_matrix()
        rule_count = int(matrix["rule_count"])
    except (OSError, KeyError, TypeError, ValueError):
        rule_count = None
    if rule_count is None:
        fallback_rc = (att_body.get("rules") or {}).get("count")
        if fallback_rc is not None:
            rule_count = int(fallback_rc)

    catalog = _sbe.load_catalog()
    if catalog is not None:
        # Source checkout: live-recompute the proven counts + read the catalog's
        # own totals (the exact calls gen_export.py makes) — unchanged path.
        acct = catalog.get("accounting", {})

        def _total(syntax):
            total = acct.get(syntax, {}).get("total")
            return int(total) if total is not None else None

        syntax_binding = {
            "ubl": {"proven": len(_sbe.implemented_ids()),
                    "total": _total("ubl")},
            "cii": {"proven": len(_sbe.cii_implemented_ids()),
                    "total": _total("cii")},
        }
    else:
        # Installed wheel: the catalog is absent, so the restricted evaluator has
        # nothing to recompute from; take the proven/total figures the packaged
        # attestation already carries (the same numbers a checkout produces).
        att_sb = (att_body.get("coverage") or {}).get("syntax_binding") or {}

        def _leg(syntax):
            leg = att_sb.get(syntax) or {}
            proven = leg.get("proven")
            total = leg.get("total")
            return {
                "proven": int(proven) if proven is not None else 0,
                "total": int(total) if total is not None else None,
            }

        syntax_binding = {"ubl": _leg("ubl"), "cii": _leg("cii")}

    coverage = {
        "business_rules": {"total_asserted": rule_count},
        "syntax_binding": syntax_binding,
    }

    # attestation_sha256: prefer the source-tree copy (byte-identical to the
    # packaged one in a checkout), fall back to the packaged copy in a wheel.
    attestation = _artifact_json("attestation.json") or packaged
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


def _resolve_output_settings(cfg, cfg_source, fail_on_flag, lang_flag, json_flag):
    """Resolve the effective ``format`` / ``fail-on`` / ``lang`` AND the SOURCE
    of each, using the ONE precedence rule the CLI has always applied: explicit
    CLI flag > config file > built-in default.

    This is the SINGLE resolution seam. The real ``validate`` / ``validate-batch``
    dispatch in :func:`_main` reads its effective settings from here, and the
    read-only ``--show-config`` view (:func:`_run_show_config`) reports the very
    same triples — so a reported source can never drift from the value a run
    actually uses (there is no second copy of this precedence logic).

    Parameters are the RAW inputs already parsed from argv:

      * ``fail_on_flag`` / ``lang_flag`` — the flag value, or ``None`` when the
        flag was absent on the command line;
      * ``json_flag`` — ``True`` iff ``--json`` was passed. The ``format`` setting
        has no value-taking flag on this CLI; ``--json`` IS its flag, so a passed
        ``--json`` resolves ``format`` to ``json`` with source ``flag`` (and, as
        today, the config ``format`` key is not even consulted in that case).

    ``cfg`` / ``cfg_source`` come from
    :func:`einvoice.config.load_config_with_source`; ``cfg_source`` is the config
    filename (``.einvoice.toml`` / ``pyproject.toml``) or ``None`` when no config
    file contributed.

    Returns a list of ``(name, value, source)`` triples in a stable DISPLAY order
    (``format``, ``fail-on``, ``lang``), where ``source`` is one of ``'flag'`` /
    the config filename / ``'default'``.
    """
    def resolve(flag_value, key, default):
        if flag_value is not None:
            return flag_value, "flag"
        if key in cfg:
            return cfg[key], cfg_source
        return default, "default"

    fmt_value, fmt_source = resolve("json" if json_flag else None, "format", "text")
    fail_on_value, fail_on_source = resolve(fail_on_flag, "fail-on", "fatal")
    lang_value, lang_source = resolve(lang_flag, "lang", "en")
    return [
        ("format", fmt_value, fmt_source),
        ("fail-on", fail_on_value, fail_on_source),
        ("lang", lang_value, lang_source),
    ]


def _run_show_config(resolved):
    """Drive ``einvoice --show-config``: a READ-ONLY dry run of the config layer.

    Prints the EFFECTIVE ``format`` / ``fail-on`` / ``lang`` and the SOURCE of
    each (``flag`` / a config filename / ``default``), one per line, then exits 0.
    Reads NO input file and runs NO validation — it mirrors the read-only,
    stderr-clean discipline of ``info``: everything goes to stdout, nothing to
    stderr on success.

    ``resolved`` is the exact list of ``(name, value, source)`` triples
    :func:`_resolve_output_settings` produced for this run, so every value and
    its source attribution is identical to what a real ``validate`` run would use.
    """
    for name, value, source in resolved:
        sys.stdout.write("%s: %s (source: %s)\n" % (name, value, source))
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


def _run_receipt_verify(path, display_path=None, as_json=False):
    """Drive ``einvoice receipt --verify <receipt.json>``: the one-command
    integrity check for a conformance receipt.

    The check IS recompute-and-compare, and it REUSES the receipt's own
    canonicalization — :func:`einvoice.receipt.canonical_json` +
    :func:`einvoice.receipt._sha256_hex`, exactly what ``build_receipt`` used to
    produce ``content_sha256`` — so there is no second, drifting canonicalizer.
    It re-hashes the receipt *body* (``doc["receipt"]``) and compares the result
    to the stored ``doc["content_sha256"]``. It validates NOTHING and changes no
    verdict; it only re-hashes bytes already in the receipt.

    Exit codes (all drawn from the existing documented taxonomy — see
    EXIT-CODES.md; no new code is minted):

      * ``EXIT_OK`` (0)    — recomputed hash == stored hash: **VERIFIED**.
      * ``EXIT_FAIL`` (1)  — recomputed hash != stored hash: **TAMPERED**. The
                             receipt body no longer matches its own content hash
                             (some field was altered, or ``content_sha256`` was
                             corrupted). This mirrors ``receipt`` build's use of
                             exit 1 for a non-clean outcome.
      * ``EXIT_USAGE`` (2) — the file is not a readable conformance receipt: not
                             valid JSON (garbage / truncated), or valid JSON that
                             is not a receipt document (missing the ``receipt`` /
                             ``content_sha256`` keys). One actionable ``error:``
                             line, never a traceback — the same class the OS-error
                             / bad-input taxonomy already uses. (A nonexistent /
                             unreadable / directory path is triaged to EXIT_USAGE
                             by the caller before this function runs.)

    ``display_path`` is what appears in the messages (defaults to ``path``).

    ``as_json`` (the global ``--json`` flag): when set, emit exactly ONE
    ``json.dumps(..., sort_keys=True)`` object on stdout INSTEAD of the human
    ``VERIFIED:`` / ``TAMPERED:`` lines — mirroring :func:`_run_info` /
    :func:`_run_validate_batch`. The object carries only values this code path
    already computes (``verdict`` / ``match`` / ``path`` / ``display_path`` /
    ``recomputed`` / ``stored``); the exit code is UNCHANGED (0 / 1). The
    usage-error legs (malformed / not-a-receipt) emit their actionable
    ``error:`` stderr line and NO JSON body — exactly like every other
    subcommand's usage-error path.
    """
    shown = display_path if display_path is not None else path
    # open() may raise OSError (e.g. a mid-run permission change); that
    # propagates to the OSError arm in _main, which reports EXIT_USAGE — the same
    # OS-error handling every single-file subcommand shares.
    with open(path, "rb") as fh:
        raw = fh.read()

    try:
        doc = json.loads(raw)
    except ValueError as exc:
        # Non-JSON / garbage / truncated receipt file: actionable, no traceback.
        sys.stderr.write(
            "error: not a valid receipt: %s is not JSON (%s)\n" % (shown, exc))
        return EXIT_USAGE

    if (not isinstance(doc, dict)
            or "receipt" not in doc or "content_sha256" not in doc):
        # Valid JSON, but not a conformance-receipt document.
        sys.stderr.write(
            "error: not a conformance receipt: %s lacks the required "
            "\"receipt\" and \"content_sha256\" fields\n" % shown)
        return EXIT_USAGE

    body = doc["receipt"]
    stored = doc["content_sha256"]
    # Recompute over the canonical body using the SAME functions build_receipt
    # used — reuse, not a parallel canonicalizer.
    recomputed = _sha256_hex(canonical_json(body).encode("utf-8"))

    match = recomputed == stored
    verdict = "VERIFIED" if match else "TAMPERED"

    if as_json:
        sys.stdout.write(json.dumps({
            "verdict": verdict,
            "match": match,
            "path": path,
            "display_path": shown,
            "recomputed": recomputed,
            "stored": stored,
        }, sort_keys=True) + "\n")
        return EXIT_OK if match else EXIT_FAIL

    if match:
        sys.stdout.write(
            "VERIFIED: %s\n  content_sha256 = %s\n" % (shown, recomputed))
        return EXIT_OK
    sys.stdout.write(
        "TAMPERED: %s\n  recomputed = %s\n  stored     = %s\n"
        % (shown, recomputed, stored))
    return EXIT_FAIL


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

    # --help / -h is an informational precedence flag, mirroring --version:
    # handled BEFORE any subcommand or file dispatch, printed to STDOUT (not
    # stderr), exit 0. Purely additive — it does NOT touch the unknown-subcommand
    # / bare-usage error paths below, so a genuinely mistyped subcommand (e.g.
    # ``bogus x.xml``, no -h/--help present) still exits 2 as before.
    if "--help" in args or "-h" in args:
        sys.stdout.write(HELP + "\n")
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

    # --verify switches the ``receipt`` subcommand from BUILD mode (validate an
    # invoice and emit a fresh receipt) to CHECK mode: read an existing receipt
    # JSON document and recompute-and-compare its content hash. It is a pure
    # re-hash of the receipt body — it validates nothing and touches no verdict.
    # Parsed like the other global booleans; it is a usage error on any
    # subcommand other than ``receipt`` (checked at dispatch below).
    verify = False
    if "--verify" in args:
        verify = True
        args = [a for a in args if a != "--verify"]

    # --show-config is a READ-ONLY dry run of the config layer: it resolves the
    # effective format/fail-on/lang exactly as a real validate run would, prints
    # each with its SOURCE (flag / config filename / default), and exits 0 —
    # reading no input file and running no validation. Parsed like the other
    # global booleans; dispatched below, AFTER config resolution + the vocabulary
    # checks (so a misconfigured file surfaces the same exit-2 error a real run
    # would, never a false "config OK" report).
    show_config = False
    if "--show-config" in args:
        show_config = True
        args = [a for a in args if a != "--show-config"]

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
        cfg, cfg_source = load_config_with_source()
    except ConfigError as exc:
        sys.stderr.write("error: %s\n%s\n" % (exc, USAGE))
        return EXIT_USAGE
    # ONE resolution seam (flag > config > default), shared with --show-config:
    # the effective value AND its source for each of format/fail-on/lang come
    # from the same helper, so an observability report can never drift from what
    # a real run uses. ``as_json`` here is the raw --json flag (True iff passed);
    # it is REASSIGNED below to the resolved format.
    resolved = _resolve_output_settings(cfg, cfg_source, fail_on, lang, as_json)
    _resolved_by_name = {name: (value, source)
                         for name, value, source in resolved}
    fmt = _resolved_by_name["format"][0]
    fail_on = _resolved_by_name["fail-on"][0]
    lang = _resolved_by_name["lang"][0]
    # The config 'format' key defaults the output form; an explicit --json flag
    # already decided (and wins, so an invalid config 'format' is not even
    # consulted then — resolved to 'json'/flag above). 'text' is the built-in
    # default, so absence of the key changes nothing. Only a config-sourced
    # 'format' can be invalid, and it gets the same actionable exit-2 treatment
    # as any bad flag value (there is no --format flag on THIS CLI to mistype,
    # so the message names the config as the source).
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

    # ``--show-config`` prints the resolved settings + their source and exits 0.
    # Dispatched HERE — after config resolution and every vocabulary check above
    # (so a bad config still errors exit 2, exactly as a real run would) but
    # BEFORE any subcommand/file handling — so it reads no input file, validates
    # nothing, and takes NO subcommand argument. Read-only, stderr-clean; mirrors
    # ``info``. ``resolved`` is the shared triple list, so its reported values and
    # sources are byte-for-byte what a real validate run would use.
    if show_config:
        return _run_show_config(resolved)

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

    if len(args) < 2 or args[0] not in VALID_SUBCOMMANDS:
        # Distinguish a genuine MISTYPED subcommand (name it + the valid set,
        # the actionable first-run message) from the bare no-subcommand or
        # valid-subcommand-with-missing-file case (unchanged: plain USAGE, no
        # false "unknown subcommand"). The choice list is COMMAND_SURFACE (the
        # DOCUMENTED set, same source ``--help`` is guarded against), not the
        # narrower dispatch tuple: a user who mistyped needs to see that ``info``
        # and ``--show-config`` exist too. Membership below stays on
        # VALID_SUBCOMMANDS — that is dispatch, and it is untouched.
        # ``validate-batch``/``info`` are already
        # dispatched above, so a token in VALID_SUBCOMMANDS reaching here is
        # ``validate``/``receipt`` with a missing file argument.
        if args and args[0] not in VALID_SUBCOMMANDS:
            sys.stderr.write(
                "error: unknown subcommand %r (choose from %s)\n%s\n"
                % (args[0], ", ".join(COMMAND_SURFACE), USAGE))
        else:
            sys.stderr.write(USAGE + "\n")
        return EXIT_USAGE
    if len(args) > 2:
        # Name the offending token(s). A mistyped flag (e.g. ``--badflag``)
        # is the common ERP first-run slip: it is not consumed by the global
        # flag parser and lands here as a stray positional, so surface any
        # flag-looking leftovers first, else the surplus positional args.
        leftover = args[1:]
        unknown_flags = [a for a in leftover if a.startswith("-") and a != "-"]
        offending = unknown_flags if unknown_flags else args[2:]
        sys.stderr.write(
            "error: unexpected argument %s\n%s\n"
            % (", ".join(repr(a) for a in offending), USAGE))
        return EXIT_USAGE

    subcommand = args[0]
    path = args[1]

    # ``--verify`` is meaningful ONLY for ``receipt`` (it re-checks a receipt
    # document); on any other subcommand it is a usage error, never silently
    # ignored.
    if verify and subcommand != "receipt":
        sys.stderr.write(
            "error: --verify is only valid for the receipt subcommand\n"
            + USAGE + "\n")
        return EXIT_USAGE

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
            # ``receipt --verify <receipt.json>`` is CHECK mode: re-hash an
            # existing receipt document and compare, changing no verdict. It is
            # dispatched BEFORE the build path so the byte-for-byte build
            # behaviour below is untouched when --verify is absent.
            if verify:
                return _run_receipt_verify(path, display_path, as_json=as_json)
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
                # First-run ergonomics (T-VHUX.4, measured 2026-07-22): the two
                # most common wrong-file-type mistakes both landed on the bare
                # parser detail with no route forward — (1) a JSON/CSV export
                # fed to `validate` learned nothing about the PDF container
                # route, (2) a Factur-X/ZUGFeRD *PDF* fed to `validate` was
                # told "not well-formed XML" instead of the correct entry
                # point. Sniff the %PDF- magic (bytes, never the extension —
                # reuses the shipped pdf_container.is_pdf_file, which returns
                # False instead of raising on any read problem) and append ONE
                # route-naming line. The first line is byte-identical to
                # before (its prefix is pinned by test_exit_codes.py /
                # test_stdout_purity.py), the --json payload is untouched
                # (stable machine contract), and the exit code stays the
                # documented EXIT_PARSE=3 in both branches.
                sys.stderr.write(
                    "S-WF: input is not well-formed XML: %s\n" % exc)
                if is_pdf_file(path):
                    sys.stderr.write(
                        "  hint: this file is a PDF — validate a Factur-X/"
                        "ZUGFeRD PDF container with 'python3 -m "
                        "einvoice.report <invoice.pdf>' instead\n")
                else:
                    sys.stderr.write(
                        "  hint: not a PDF container either — supported "
                        "inputs are a UBL/CII e-invoice as well-formed XML "
                        "('validate') or a Factur-X/ZUGFeRD PDF/A-3 "
                        "container ('python3 -m einvoice.report "
                        "<invoice.pdf>')\n")
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

"""Packaged machine-readable CI conformance report.

A single documented entrypoint that turns the validator's outcome into a
STABLE, versioned JSON document meant to drop straight into a CI step:

    python3 -m einvoice.report [--profile xrechnung|en16931] [--pretty] <invoice.xml>

The report is a thin, deterministic projection of ``einvoice.validate`` — it
re-implements NO rule logic. Every business rule (BR-*, S-*, BR-DE-*) is
evaluated by :func:`einvoice.validate.validate_file`; this module only maps
each resulting :class:`~einvoice.rules.Violation` into a stable record and
counts them.

Exit-code contract (mirrors ``einvoice.cli`` conventions, so a build fails
exactly when the invoice does):

    0   zero FATAL violations (the invoice is valid; warnings may be present)
    1   at least one FATAL violation (EXIT_FAIL)
    3   input is not well-formed XML (EXIT_PARSE) — folded into a report with
        ``valid=false`` and an ``error`` field, never raised

The JSON report is printed to stdout: compact (one line) by default,
indented with ``--pretty``. See ``REPORT_SCHEMA`` below / REPORT-SCHEMA.md for
the full, versioned field description.

Standard library only. No network.
"""

from __future__ import annotations

import json
import os
import sys
from xml.sax.saxutils import escape, quoteattr

from .validate import validate_file, PROFILES, _severity
from .parser import NotWellFormed

#: Bump when the report shape changes in a way a consumer must notice.
REPORT_VERSION = 1

#: Short, stable identifier for this report schema. Consumers should match on
#: this string (not on ``report_version`` alone) to be robust across tools.
REPORT_SCHEMA_ID = "einvoice-conformance-report/v1"

#: Exit codes — kept in lock-step with ``einvoice.cli`` (imported-by-value so a
#: drift there is caught by tests, not silently duplicated).
EXIT_OK = 0
EXIT_FAIL = 1
EXIT_PARSE = 3

#: Documentation of the versioned report shape. Every key the report can carry
#: is described here; REPORT-SCHEMA.md renders the same contract for humans.
REPORT_SCHEMA = {
    "schema": REPORT_SCHEMA_ID,
    "report_version": REPORT_VERSION,
    "description": (
        "Machine-readable EN 16931 / XRechnung conformance report. A "
        "deterministic projection of einvoice.validate; reuses the validator "
        "rules verbatim and adds no rule logic of its own."
    ),
    "fields": {
        "report_version": "int, starts at 1; incremented on breaking shape changes.",
        "schema": "stable schema id string ('%s')." % REPORT_SCHEMA_ID,
        "source": "the invoice path or label passed in (string or null).",
        "profile": "validation profile used: 'en16931' or 'xrechnung'.",
        "valid": "bool — true iff there are zero FATAL violations "
                 "(official Schematron 'flag' semantics; warnings do not "
                 "invalidate).",
        "fatal_count": "int — number of violations with severity 'fatal'.",
        "warning_count": "int — number of violations with severity 'warning'.",
        "violation_count": "int — total violations of every severity.",
        "violations": "list of violation records (see 'violation_record').",
        "error": "present ONLY when the input is not well-formed XML: a short "
                 "code string ('not-well-formed'); 'valid' is then false and "
                 "'violations' is empty.",
        "message": "present ONLY alongside 'error': the parser's human message.",
    },
    "violation_record": {
        "rule": "the rule id, e.g. 'BR-DE-15' (from Violation.rule_id).",
        "severity": "'fatal' | 'warning' | 'information' (validate._severity).",
        "message": "the human/Schematron rule message (Violation.message).",
        "field": "the offending element / path (Violation.element).",
    },
    "exit_codes": {
        "0": "no fatal violations (valid).",
        "1": "at least one fatal violation.",
        "3": "input not well-formed XML (report has error, valid=false).",
    },
}

#: The exact key set every violation record carries (tests assert on this).
VIOLATION_KEYS = ("rule", "severity", "message", "field")


def _record(v):
    """Map one Violation into a stable, minimal report record."""
    return {
        "rule": v.rule_id,
        "severity": _severity(v),
        "message": v.message,
        "field": v.element,
    }


def build_report(path, profile="xrechnung"):
    """Validate ``path`` and return a machine-readable conformance report dict.

    Reuses :func:`einvoice.validate.validate_file` for ALL rule evaluation.
    Not-well-formed XML is folded into a report with ``valid=False`` and an
    ``error`` field (mirroring ``cli.py``) instead of raising.

    :param path: path to the invoice XML file.
    :param profile: 'xrechnung' (default) or 'en16931'.
    :returns: a dict matching :data:`REPORT_SCHEMA`.
    """
    try:
        result = validate_file(path, profile=profile)
    except NotWellFormed as exc:
        return {
            "report_version": REPORT_VERSION,
            "schema": REPORT_SCHEMA_ID,
            "source": path,
            "profile": profile,
            "valid": False,
            "error": "not-well-formed",
            "message": str(exc),
            "fatal_count": 0,
            "warning_count": 0,
            "violation_count": 0,
            "violations": [],
        }

    records = [_record(v) for v in result.violations]
    fatal_count = sum(1 for r in records if r["severity"] == "fatal")
    warning_count = sum(1 for r in records if r["severity"] == "warning")
    return {
        "report_version": REPORT_VERSION,
        "schema": REPORT_SCHEMA_ID,
        "source": path,
        "profile": profile,
        "valid": result.ok,
        "fatal_count": fatal_count,
        "warning_count": warning_count,
        "violation_count": len(records),
        "violations": records,
    }


#: Name carried by the top-level <testsuites> element (stable, not the schema).
JUNIT_SUITES_NAME = "einvoice-conformance"


def build_junit(report):
    """Project a report dict (from :func:`build_report`) into JUnit XML text.

    This is a pure, additional PROJECTION of the exact same validator outcome
    the JSON path emits — it adds no rule logic and re-reads nothing. Each
    reported violation becomes one ``<testcase name="<rule-id>"
    classname="<profile>">``:

      * a ``fatal`` violation -> a ``<failure message="...">`` whose body
        carries the offending field/XPath (so CI shows *where* it failed);
      * a non-fatal violation (``warning`` / ``information``) -> a
        ``<system-out>`` note and NO failure (it does not fail the build);
      * a not-well-formed input -> a single ``<testcase>`` with an ``<error>``.

    Passing / absent-violation rules are not emitted individually, but the
    ``tests`` / ``failures`` / ``errors`` counts on the suite are accurate.

    :param report: a dict as returned by :func:`build_report`.
    :returns: a JUnit XML document as a ``str`` (UTF-8 declaration included).
    """
    profile = report.get("profile", "")
    classname = quoteattr(profile)

    lines = []

    if report.get("error"):
        # Not-well-formed XML: one errored testcase, mirroring the JSON path.
        msg = report.get("message", "") or report["error"]
        lines.append(
            "    <testcase name=%s classname=%s>"
            % (quoteattr(report["error"]), classname))
        lines.append(
            "      <error message=%s>%s</error>"
            % (quoteattr(msg), escape(msg)))
        lines.append("    </testcase>")
        tests = 1
        failures = 0
        errors = 1
    else:
        violations = report.get("violations", [])
        tests = len(violations)
        failures = report.get("fatal_count", 0)
        errors = 0
        for v in violations:
            rule = v.get("rule") or ""
            severity = v.get("severity") or "fatal"
            message = v.get("message") or ""
            field = v.get("field") or ""
            lines.append(
                "    <testcase name=%s classname=%s>"
                % (quoteattr(rule), classname))
            if severity == "fatal":
                body = "%s: %s" % (severity, field) if field else severity
                lines.append(
                    "      <failure message=%s>%s</failure>"
                    % (quoteattr(message), escape(body)))
            else:
                note = "%s: %s" % (severity, message)
                if field:
                    note = "%s (%s)" % (note, field)
                lines.append("      <system-out>%s</system-out>" % escape(note))
            lines.append("    </testcase>")

    suite_attrs = ("name=%s tests=%s failures=%s errors=%s"
                   % (classname, quoteattr(str(tests)),
                      quoteattr(str(failures)), quoteattr(str(errors))))
    suites_attrs = ("name=%s tests=%s failures=%s errors=%s"
                    % (quoteattr(JUNIT_SUITES_NAME), quoteattr(str(tests)),
                       quoteattr(str(failures)), quoteattr(str(errors))))

    out = ['<?xml version="1.0" encoding="UTF-8"?>']
    out.append("<testsuites %s>" % suites_attrs)
    out.append("  <testsuite %s>" % suite_attrs)
    out.extend(lines)
    out.append("  </testsuite>")
    out.append("</testsuites>")
    return "\n".join(out) + "\n"


USAGE = ("usage: python3 -m einvoice.report "
         "[--profile en16931|xrechnung] [--format json|junit] [--pretty] "
         "<invoice.xml>")


def main(argv=None):
    """Run the report CLI. Returns the process exit code (see module docstring)."""
    if argv is None:
        argv = sys.argv[1:]
    args = list(argv)

    pretty = False
    if "--pretty" in args:
        pretty = True
        args = [a for a in args if a != "--pretty"]

    profile = "xrechnung"
    fmt = "json"
    rest = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--profile":
            if i + 1 >= len(args):
                sys.stderr.write("error: --profile needs a value\n" + USAGE + "\n")
                return EXIT_FAIL
            profile = args[i + 1]
            i += 2
            continue
        if a.startswith("--profile="):
            profile = a.split("=", 1)[1]
            i += 1
            continue
        if a == "--format":
            if i + 1 >= len(args):
                sys.stderr.write("error: --format needs a value\n" + USAGE + "\n")
                return EXIT_FAIL
            fmt = args[i + 1]
            i += 2
            continue
        if a.startswith("--format="):
            fmt = a.split("=", 1)[1]
            i += 1
            continue
        rest.append(a)
        i += 1
    args = rest

    if fmt not in ("json", "junit"):
        sys.stderr.write("error: unknown format %r (choose from json, junit)\n%s\n"
                         % (fmt, USAGE))
        return EXIT_FAIL

    if profile not in PROFILES:
        sys.stderr.write("error: unknown profile %r (choose from %s)\n%s\n"
                         % (profile, ", ".join(PROFILES), USAGE))
        return EXIT_FAIL

    if len(args) != 1:
        sys.stderr.write(USAGE + "\n")
        return EXIT_FAIL

    path = args[0]
    if not os.path.isfile(path):
        sys.stderr.write("error: no such file: %s\n" % path)
        return EXIT_FAIL

    report = build_report(path, profile=profile)
    if fmt == "junit":
        sys.stdout.write(build_junit(report))
    elif pretty:
        sys.stdout.write(json.dumps(report, indent=2, sort_keys=True) + "\n")
    else:
        sys.stdout.write(json.dumps(report, separators=(",", ":")) + "\n")

    if report.get("error") == "not-well-formed":
        return EXIT_PARSE
    return EXIT_OK if report["fatal_count"] == 0 else EXIT_FAIL


if __name__ == "__main__":
    sys.exit(main())

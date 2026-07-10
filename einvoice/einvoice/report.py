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

Baseline diff mode (``--baseline <prev-report.json>``)
------------------------------------------------------

An adoption on-ramp for teams that inherit a NON-conformant invoice pipeline:
instead of failing the build on every pre-existing violation, fail only on
NEW regressions relative to a captured baseline. Given a prior report produced
by an earlier ``--format json`` run (schema ``einvoice-conformance-report/v1``,
carrying a ``violations`` array of ``{rule, field, severity, message}``), the
tool re-validates the CURRENT invoice and DIFFs the two violation sets by a
stable key ``(rule, field, message, severity)``:

    python3 -m einvoice.report --baseline prev-report.json <invoice.xml>

The diff is emitted to stdout as its OWN versioned document
(schema ``einvoice-conformance-diff/v1`` — a distinct shape from the plain
report above, so the base report_version stays ``1``; the diff document carries
its own ``report_version``). It reuses ``einvoice.validate`` verbatim and adds
NO rule logic — it only set-diffs the two projections. The document carries:

    schema, report_version   the diff schema id + its version
    mode                     the literal "diff"
    source                   the current invoice path
    baseline / baseline_source  the baseline file path, and the ``source``
                             recorded inside the baseline report
    new_violations           records present NOW but absent in the baseline
    resolved_violations      records present in the baseline but absent NOW
    new_count / resolved_count / unchanged_count
    new_fatal_count          NEW violations whose severity is 'fatal'
    baseline_fatal_count / current_fatal_count

Diff-mode exit-code contract (deliberately more lenient than plain mode — a
pre-existing failure does NOT break the build, only a regression does):

    0   ZERO new fatal violations (pre-existing fatals are tolerated)
    1   at least one NEW fatal violation appeared — a regression (EXIT_FAIL)
    3   the current invoice is not well-formed XML (EXIT_PARSE), folded into
        the diff document with an ``error`` field, as in plain mode

A malformed / unreadable / wrong-shape baseline file is reported with a clear
stderr message and a nonzero exit — never a traceback.

Standard library only. No network.
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter
from xml.sax.saxutils import escape, quoteattr

from .validate import validate_file, PROFILES, _severity
from .parser import NotWellFormed
from .remediation import load_catalog

#: Bump when the report shape changes in a way a consumer must notice.
REPORT_VERSION = 1

#: Short, stable identifier for this report schema. Consumers should match on
#: this string (not on ``report_version`` alone) to be robust across tools.
REPORT_SCHEMA_ID = "einvoice-conformance-report/v1"

#: The ``--baseline`` diff document is a SEPARATE, independently versioned shape
#: (it is not the plain report), so adding it leaves ``REPORT_VERSION`` at 1.
#: The "appropriate bump" for the new capability is this dedicated version
#: namespace: the diff document starts at v1 and moves on its own cadence.
REPORT_DIFF_VERSION = 1
REPORT_DIFF_SCHEMA_ID = "einvoice-conformance-diff/v1"

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
        # --- Additive remediation fields (v1, non-breaking). Every value is
        # RELAYED from the committed remediation_catalog.json (einvoice.
        # remediation.load_catalog) keyed by rule id — report.py authors NONE
        # of this wording. A rule with no catalog entry degrades to
        # null/empty (never a KeyError).
        "title": "plain-language rule title from the remediation catalog "
                 "(string or null if the rule has no catalog entry).",
        "fix_hint": "the catalog's one-line 'how to fix' guidance (string or "
                    "null).",
        "terms": "list of the BT-/BG- business-term ids the rule touches "
                 "(from the catalog's bt_bg; empty list if none).",
        "location": "the catalog's XML location/path hint for the finding "
                    "(string or null).",
    },
    "exit_codes": {
        "0": "no fatal violations (valid).",
        "1": "at least one fatal violation.",
        "3": "input not well-formed XML (report has error, valid=false).",
    },
}

#: The exact key set every violation record carries (tests assert on this).
#: The original four identity keys come first and are unchanged for backward
#: compatibility; the trailing four are the additive, catalog-relayed
#: remediation fields (see :func:`_record` and REPORT_SCHEMA['violation_record']).
VIOLATION_KEYS = ("rule", "severity", "message", "field",
                  "title", "fix_hint", "terms", "location")


#: Module-level cache of the remediation catalog (rule_id -> entry). Loaded
#: once and reused so per-record enrichment stays O(1) and never re-parses the
#: JSON in a hot loop. The report only RELAYS this committed, Schematron-
#: traceable data — it authors no remediation wording of its own.
_REMEDIATION_CATALOG = None


def _remediation_catalog():
    """Return the cached remediation catalog mapping (loaded at most once).

    On any failure to read/parse the committed catalog this degrades to an
    empty mapping, so enrichment falls back to null/empty fields rather than
    raising — the report must never fail because remediation data is missing.
    """
    global _REMEDIATION_CATALOG
    if _REMEDIATION_CATALOG is None:
        try:
            _REMEDIATION_CATALOG = load_catalog()
        except (OSError, ValueError, KeyError):
            _REMEDIATION_CATALOG = {}
    return _REMEDIATION_CATALOG


def _record(v, catalog=None):
    """Map one Violation into a stable report record enriched with remediation.

    The four identity fields (rule/severity/message/field) are taken verbatim
    from the Violation. The four remediation fields (title/fix_hint/terms/
    location) are RELAYED from the committed remediation catalog entry for this
    rule id — this function authors none of that wording. A rule id with no
    catalog entry degrades gracefully to null/empty fields (never a KeyError).

    :param catalog: optional pre-loaded catalog mapping (build_report passes it
        once for the whole result); when omitted, the cached module catalog is
        used so a lone ``_record(v)`` call still enriches.
    """
    if catalog is None:
        catalog = _remediation_catalog()
    entry = catalog.get(v.rule_id) or {}
    return {
        "rule": v.rule_id,
        "severity": _severity(v),
        "message": v.message,
        "field": v.element,
        "title": entry.get("title"),
        "fix_hint": entry.get("fix"),
        "terms": list(entry.get("bt_bg") or []),
        "location": entry.get("location_hint"),
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

    catalog = _remediation_catalog()  # loaded once, not per violation record
    records = [_record(v, catalog) for v in result.violations]
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


#: The stable diff key for a violation record: two records are "the same"
#: violation iff these four fields match. Documented in REPORT-SCHEMA.md.
DIFF_KEY = ("rule", "field", "message", "severity")


def _diff_key(rec):
    """The stable identity tuple used to match a violation across reports."""
    return tuple(rec.get(k) for k in DIFF_KEY)


class BaselineError(Exception):
    """A baseline report file could not be read or is the wrong shape."""


def load_baseline(baseline_path):
    """Load + shape-check a prior report JSON produced by ``--format json``.

    Reads a report that carries a ``violations`` array of
    ``{rule, field, severity, message}`` records (schema
    ``einvoice-conformance-report/v1``). Raises :class:`BaselineError` — with a
    human message, never a traceback — on any I/O error, non-JSON content, or a
    document that is not a report object with a ``violations`` list.
    """
    try:
        with open(baseline_path, encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError as exc:
        raise BaselineError("cannot read baseline %s: %s"
                            % (baseline_path, exc.strerror or exc))
    except ValueError as exc:
        raise BaselineError("baseline %s is not valid JSON: %s"
                            % (baseline_path, exc))
    if not isinstance(data, dict):
        raise BaselineError("baseline %s is not a report object" % baseline_path)
    violations = data.get("violations")
    if not isinstance(violations, list):
        raise BaselineError(
            "baseline %s has no 'violations' array (not a conformance report?)"
            % baseline_path)
    for rec in violations:
        if not isinstance(rec, dict):
            raise BaselineError(
                "baseline %s has a malformed violation record" % baseline_path)
    return data


def _multiset_diff(current_records, baseline_records):
    """Multiset diff of two violation-record lists by :data:`DIFF_KEY`.

    Returns ``(new_records, resolved_records, unchanged_count)``:
      * ``new`` — current records with no (remaining) baseline match;
      * ``resolved`` — baseline records with no (remaining) current match;
      * ``unchanged_count`` — records present in both (with multiplicity).

    Multiplicity is respected: if the same violation appears twice now and once
    in the baseline, one copy is 'new' and one is 'unchanged'.
    """
    baseline_pool = Counter(_diff_key(r) for r in baseline_records)
    new = []
    unchanged = 0
    for rec in current_records:
        k = _diff_key(rec)
        if baseline_pool[k] > 0:
            baseline_pool[k] -= 1
            unchanged += 1
        else:
            new.append(rec)

    current_pool = Counter(_diff_key(r) for r in current_records)
    resolved = []
    for rec in baseline_records:
        k = _diff_key(rec)
        if current_pool[k] > 0:
            current_pool[k] -= 1
        else:
            resolved.append(rec)
    return new, resolved, unchanged


def build_diff(path, baseline, profile="xrechnung", baseline_path=None):
    """Validate ``path`` and diff it against a loaded ``baseline`` report dict.

    Reuses :func:`build_report` (hence :func:`einvoice.validate.validate_file`)
    for ALL rule evaluation — this function adds no rule logic, it only set-
    diffs the two violation projections by :data:`DIFF_KEY`. A not-well-formed
    current invoice is folded into the diff document with an ``error`` field
    (mirroring :func:`build_report`) instead of raising.

    :param path: path to the current invoice XML file.
    :param baseline: a baseline report dict (from :func:`load_baseline`).
    :param profile: 'xrechnung' (default) or 'en16931'.
    :param baseline_path: the baseline file path, recorded for provenance.
    :returns: a diff dict matching :data:`REPORT_DIFF_SCHEMA`.
    """
    current = build_report(path, profile=profile)
    baseline_violations = baseline.get("violations", [])
    baseline_source = baseline.get("source")
    baseline_fatal = sum(1 for r in baseline_violations
                         if isinstance(r, dict) and r.get("severity") == "fatal")

    head = {
        "report_version": REPORT_DIFF_VERSION,
        "schema": REPORT_DIFF_SCHEMA_ID,
        "mode": "diff",
        "source": path,
        "baseline": baseline_path,
        "baseline_source": baseline_source,
        "profile": profile,
    }

    if current.get("error"):
        # Not-well-formed current invoice: no meaningful diff; report the error.
        head.update({
            "error": current["error"],
            "message": current.get("message", ""),
            "new_violations": [],
            "resolved_violations": [],
            "new_count": 0,
            "resolved_count": 0,
            "unchanged_count": 0,
            "new_fatal_count": 0,
            "baseline_fatal_count": baseline_fatal,
            "current_fatal_count": 0,
        })
        return head

    new, resolved, unchanged = _multiset_diff(
        current["violations"], baseline_violations)
    new_fatal = sum(1 for r in new if r.get("severity") == "fatal")

    head.update({
        "new_violations": new,
        "resolved_violations": resolved,
        "new_count": len(new),
        "resolved_count": len(resolved),
        "unchanged_count": unchanged,
        "new_fatal_count": new_fatal,
        "baseline_fatal_count": baseline_fatal,
        "current_fatal_count": current["fatal_count"],
    })
    return head


#: Documentation of the versioned diff-document shape (companion to
#: REPORT-SCHEMA.md). The diff is emitted by ``--baseline`` mode.
REPORT_DIFF_SCHEMA = {
    "schema": REPORT_DIFF_SCHEMA_ID,
    "report_version": REPORT_DIFF_VERSION,
    "description": (
        "Baseline diff of two conformance reports. Fails the build (exit 1) "
        "only on a NEW fatal violation vs the baseline; pre-existing fatals "
        "are tolerated (exit 0). Reuses einvoice.validate; no rule logic."
    ),
    "fields": {
        "report_version": "int; the diff document's own version (starts at 1).",
        "schema": "stable diff schema id ('%s')." % REPORT_DIFF_SCHEMA_ID,
        "mode": "the literal string 'diff'.",
        "source": "the current invoice path that was validated.",
        "baseline": "the --baseline file path supplied on the CLI (or null).",
        "baseline_source": "the 'source' field recorded inside the baseline.",
        "profile": "validation profile used: 'en16931' or 'xrechnung'.",
        "new_violations": "records present NOW but absent in the baseline "
                          "(matched by rule+field+message+severity).",
        "resolved_violations": "records present in the baseline but absent NOW.",
        "new_count": "int — len(new_violations).",
        "resolved_count": "int — len(resolved_violations).",
        "unchanged_count": "int — violations present in both (with multiplicity).",
        "new_fatal_count": "int — new_violations whose severity is 'fatal'. "
                           "Drives the diff exit code.",
        "baseline_fatal_count": "int — fatal violations in the baseline.",
        "current_fatal_count": "int — fatal violations in the current invoice.",
        "error": "present ONLY when the current invoice is not well-formed XML: "
                 "code 'not-well-formed'; the diff lists are then empty.",
        "message": "present ONLY alongside 'error': the parser's human message.",
    },
    "exit_codes": {
        "0": "zero new fatal violations vs baseline (pre-existing fatals ok).",
        "1": "at least one NEW fatal violation (a regression).",
        "3": "current input not well-formed XML (diff has error).",
    },
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
         "[--baseline <prev-report.json>] <invoice.xml>\n"
         "   or: python3 -m einvoice.report --explain <RULE-ID>\n"
         "  --baseline diffs against a prior JSON report and fails (exit 1) "
         "ONLY on a NEW fatal violation; pre-existing fatals are tolerated "
         "(exit 0). See REPORT-SCHEMA.md.\n"
         "  --explain prints the remediation-catalog entry for one rule id "
         "(e.g. BR-DE-15) as a plain-text block and exits 0; it needs NO "
         "invoice file and is not combinable with --format/--baseline.")


def format_explain(rule_id, catalog=None):
    """Render the remediation-catalog entry for ``rule_id`` as a plain-text
    block, or return ``None`` if the id is not catalogued.

    Every printed field is taken verbatim from ``remediation_catalog.json``
    (the single source of remediation truth) — this function invents no rule
    meaning of its own. Lookup is case-insensitive and matched against the
    catalog keys (the fireable rule ids, e.g. ``BR-01``, ``BR-DE-15``,
    ``BR-DE-23-a``), and the canonical key is echoed back in the output.
    """
    if catalog is None:
        catalog = load_catalog()
    entry = catalog.get(rule_id)
    canonical = rule_id
    if entry is None:
        wanted = rule_id.upper()
        for key, val in catalog.items():
            if key.upper() == wanted:
                entry, canonical = val, key
                break
    if entry is None:
        return None

    bt_bg = entry.get("bt_bg") or []
    prov = entry.get("provenance") or {}
    prov_source = prov.get("source") or "(unknown)"
    prov_assert = prov.get("assert") or ""

    lines = [
        "%s  %s" % (canonical, entry.get("title", "")),
        "",
        "  requires : %s" % (entry.get("requires", "") or "(not stated)"),
        "  BT/BG    : %s" % (", ".join(bt_bg) if bt_bg else "(none)"),
        "  location : %s" % (entry.get("location_hint", "") or "(unspecified)"),
        "  fix      : %s" % (entry.get("fix", "") or "(none given)"),
        "  severity : %s" % (entry.get("severity", "") or "(unspecified)"),
        "  source   : %s (Schematron)" % prov_source,
    ]
    if prov_assert:
        lines.append("  assert   : %s" % prov_assert)
    return "\n".join(lines) + "\n"


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
    saw_format = False
    baseline_path = None
    explain_id = None
    saw_explain = False
    rest = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--explain":
            if i + 1 >= len(args):
                sys.stderr.write("error: --explain needs a rule id\n" + USAGE + "\n")
                return EXIT_FAIL
            explain_id = args[i + 1]
            saw_explain = True
            i += 2
            continue
        if a.startswith("--explain="):
            explain_id = a.split("=", 1)[1]
            saw_explain = True
            i += 1
            continue
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
        if a == "--baseline":
            if i + 1 >= len(args):
                sys.stderr.write("error: --baseline needs a value\n" + USAGE + "\n")
                return EXIT_FAIL
            baseline_path = args[i + 1]
            i += 2
            continue
        if a.startswith("--baseline="):
            baseline_path = a.split("=", 1)[1]
            i += 1
            continue
        if a == "--format":
            if i + 1 >= len(args):
                sys.stderr.write("error: --format needs a value\n" + USAGE + "\n")
                return EXIT_FAIL
            fmt = args[i + 1]
            saw_format = True
            i += 2
            continue
        if a.startswith("--format="):
            fmt = a.split("=", 1)[1]
            saw_format = True
            i += 1
            continue
        rest.append(a)
        i += 1
    args = rest

    # --------------------------------------------------------------------- #
    # --explain mode: look up ONE rule id in the remediation catalog, print a
    # plain-text block and exit. Standalone — no invoice file is read, and it
    # is mutually exclusive with the invoice/output-format flags.
    # --------------------------------------------------------------------- #
    if saw_explain:
        if args:
            sys.stderr.write(
                "error: --explain takes only a rule id; do not also pass an "
                "invoice path (%s)\n%s\n" % (" ".join(args), USAGE))
            return EXIT_FAIL
        if saw_format or baseline_path is not None:
            sys.stderr.write(
                "error: --explain is a catalog lookup and cannot be combined "
                "with --format or --baseline\n%s\n" % USAGE)
            return EXIT_FAIL
        block = format_explain(explain_id)
        if block is None:
            sys.stderr.write(
                "error: unknown rule id %r — not in the remediation catalog "
                "(remediation_catalog.json)\n" % explain_id)
            return EXIT_FAIL
        sys.stdout.write(block)
        return EXIT_OK

    if fmt not in ("json", "junit"):
        sys.stderr.write("error: unknown format %r (choose from json, junit)\n%s\n"
                         % (fmt, USAGE))
        return EXIT_FAIL

    if profile not in PROFILES:
        sys.stderr.write("error: unknown profile %r (choose from %s)\n%s\n"
                         % (profile, ", ".join(PROFILES), USAGE))
        return EXIT_FAIL

    if baseline_path is not None and fmt == "junit":
        sys.stderr.write(
            "error: --baseline emits a diff document and is not compatible "
            "with --format junit\n%s\n" % USAGE)
        return EXIT_FAIL

    if len(args) != 1:
        sys.stderr.write(USAGE + "\n")
        return EXIT_FAIL

    path = args[0]
    if not os.path.isfile(path):
        sys.stderr.write("error: no such file: %s\n" % path)
        return EXIT_FAIL

    # --------------------------------------------------------------------- #
    # Baseline diff mode: fail only on a NEW fatal violation vs the baseline.
    # --------------------------------------------------------------------- #
    if baseline_path is not None:
        try:
            baseline = load_baseline(baseline_path)
        except BaselineError as exc:
            sys.stderr.write("error: %s\n" % exc)
            return EXIT_FAIL
        diff = build_diff(path, baseline, profile=profile,
                          baseline_path=baseline_path)
        if pretty:
            sys.stdout.write(json.dumps(diff, indent=2, sort_keys=True) + "\n")
        else:
            sys.stdout.write(json.dumps(diff, separators=(",", ":")) + "\n")
        if diff.get("error") == "not-well-formed":
            return EXIT_PARSE
        return EXIT_OK if diff["new_fatal_count"] == 0 else EXIT_FAIL

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

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

import html
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


#: The tool's public home, cited as the SARIF driver ``informationUri`` (a
#: string literal — no network is ever touched).
SARIF_INFORMATION_URI = "https://github.com/verifyhash/verifyhash"

#: The OASIS SARIF 2.1.0 raw JSON-schema URL, emitted as the ``$schema`` string
#: literal. This is documentation/identification only — it is NOT fetched.
SARIF_SCHEMA_URI = (
    "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/"
    "Schemata/sarif-schema-2.1.0.json"
)

#: SARIF result level for each report severity (fatal -> error, warning ->
#: warning, everything else -> note). Static Analysis Results Interchange
#: Format v2.1.0, section 3.27.10 (result.level).
_SARIF_LEVEL = {"fatal": "error", "warning": "warning"}


def _sarif_level(severity):
    """Map a report severity string onto a SARIF ``result.level`` value.

    ``fatal`` -> ``error``, ``warning`` -> ``warning``, anything else
    (``information`` / unknown) -> ``note`` — the SARIF default for advisory
    findings. See OASIS SARIF 2.1.0 section 3.27.10.
    """
    return _SARIF_LEVEL.get(severity, "note")


def build_sarif(report):
    """Project a report dict (from :func:`build_report`) into a SARIF 2.1.0 dict.

    Emits a Python dict (serialise with ``json.dumps``) that conforms to the
    OASIS *Static Analysis Results Interchange Format (SARIF) Version 2.1.0*
    schema (https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/
    Schemata/sarif-schema-2.1.0.json). This lets ``einvoice`` findings surface
    as inline annotations in GitHub code-scanning (SARIF upload).

    Like :func:`build_junit`, this is a PURE, additional PROJECTION of the very
    same validator outcome the JSON path emits — it adds no rule logic, invents
    no wording, and re-reads nothing. Every human string comes from either the
    Violation (message/field) or the committed remediation catalog fields that
    :func:`_record` already attached (title/fix_hint/terms/location).

    Structure (SARIF 2.1.0):
      * ``version`` == ``"2.1.0"`` and ``$schema`` == the OASIS raw-schema URL;
      * ``runs`` is a one-element list;
      * ``runs[0].tool.driver`` = ``{name:"einvoice", informationUri:<repo>,
        rules:[...]}`` — one ``reportingDescriptor`` per *fired* rule id
        (deduplicated by id): ``id``/``name`` = the rule id,
        ``shortDescription.text`` = catalog ``title``, ``fullDescription.text``
        = catalog ``fix_hint``, ``help.text`` = the fix hint plus a line listing
        the rule's BT/BG ``terms``;
      * ``runs[0].results`` = one SARIF ``result`` per violation:
        ``ruleId`` = the rule id, ``level`` per :func:`_sarif_level`,
        ``message.text`` = the violation message (falling back to the catalog
        title), and — when a field/location is present — a ``locations`` entry
        carrying a ``logicalLocations`` member.

    A not-well-formed input (``report`` has an ``error``) yields a single result
    whose ``ruleId`` is the error code, ``level`` ``error`` and ``message.text``
    the parser message, with no rules in the driver — mirroring the JSON/JUnit
    not-well-formed contract.

    :param report: a dict as returned by :func:`build_report`.
    :returns: a SARIF 2.1.0 document as a ``dict``.
    """
    rules = []          # list of reportingDescriptor dicts (deduped by id)
    seen_rule_ids = set()
    results = []        # list of SARIF result dicts

    if report.get("error"):
        # Not-well-formed XML: a single error result, no rule metadata — the
        # SARIF analogue of the JUnit single-<error> testcase.
        results.append({
            "ruleId": report["error"],
            "level": "error",
            "message": {"text": report.get("message", "") or report["error"]},
        })
    else:
        for v in report.get("violations", []):
            rule_id = v.get("rule") or ""
            severity = v.get("severity") or "fatal"
            title = v.get("title")
            fix_hint = v.get("fix_hint")
            terms = v.get("terms") or []
            field = v.get("field")
            location = v.get("location")

            # One reportingDescriptor per fired rule id (deduplicated).
            if rule_id and rule_id not in seen_rule_ids:
                seen_rule_ids.add(rule_id)
                help_text = fix_hint or ""
                if terms:
                    terms_line = "Business terms: " + ", ".join(terms)
                    help_text = (help_text + "\n" + terms_line
                                 if help_text else terms_line)
                descriptor = {
                    "id": rule_id,
                    "name": rule_id,
                    "shortDescription": {"text": title or rule_id},
                    "fullDescription": {"text": fix_hint or ""},
                    "help": {"text": help_text},
                }
                rules.append(descriptor)

            result = {
                "ruleId": rule_id,
                "level": _sarif_level(severity),
                "message": {"text": v.get("message") or title or rule_id},
            }
            # Attach a logical location when we know WHERE the finding is;
            # omit ``locations`` entirely when neither field nor location hint
            # is present (an empty locations array is not useful).
            loc_name = field or location
            if loc_name:
                result["locations"] = [{
                    "logicalLocations": [{
                        "name": loc_name,
                        "kind": "member",
                    }],
                }]
            results.append(result)

    return {
        "version": "2.1.0",
        "$schema": SARIF_SCHEMA_URI,
        "runs": [{
            "tool": {
                "driver": {
                    "name": "einvoice",
                    "informationUri": SARIF_INFORMATION_URI,
                    "rules": rules,
                },
            },
            "results": results,
        }],
    }


def build_badge(report):
    """Project a report dict (from :func:`build_report`) into a shields.io
    ENDPOINT-badge JSON dict.

    Emits the object shields.io consumes via its *endpoint badge* mechanism
    (https://shields.io/badges/endpoint-badge): point a badge at a hosted or
    committed JSON file with ``?url=<json>`` and shields.io renders it. The
    schema we emit is the documented minimum — ``schemaVersion`` (always the
    integer ``1``), ``label``, ``message`` and ``color``. Optional endpoint
    keys (``labelColor``, ``namedLogo``, ``isError``, ``style``, ``cacheSeconds``)
    are intentionally omitted to keep this a zero-dependency, stable projection.

    Like :func:`build_junit` and :func:`build_sarif`, this is a PURE, additional
    PROJECTION of the SAME validator outcome the JSON path emits — it re-reads
    nothing, invents no rule logic, and adds no second source of truth. State is
    derived from the report exactly as the other formats derive theirs:
    ``fatal_count`` / ``warning_count`` (and the not-well-formed ``error`` flag).

    Exact mapping (label is always ``"EN 16931"`` — the conformance target):
      * not-well-formed input (``report`` carries an ``error``) ->
        ``message = "not well-formed"``, ``color = "red"`` (mirrors the
        non-zero JSON/SARIF/JUnit not-well-formed contract);
      * one or more FATAL findings -> ``message = "<N> issue(s)"`` where **N is
        the FATAL count** (the same count that drives the process exit code),
        ``color = "red"``;
      * zero fatal but one or more WARNING findings ->
        ``message = "conformant (<N> warnings)"`` (N = warning count),
        ``color = "yellow"`` — honest: it passes the fatal gate but is not clean;
      * zero fatal and zero warning -> ``message = "conformant"``,
        ``color = "brightgreen"``.

    The message deliberately uses the FATAL count (not the total) so it agrees
    with the conformance verdict and the exit code every other format reports.

    :param report: a dict as returned by :func:`build_report`.
    :returns: a shields.io endpoint-badge document as a ``dict``.
    """
    label = "EN 16931"
    if report.get("error"):
        message = "not well-formed"
        color = "red"
    else:
        fatal = report.get("fatal_count", 0)
        warning = report.get("warning_count", 0)
        if fatal > 0:
            message = "%d issue%s" % (fatal, "" if fatal == 1 else "s")
            color = "red"
        elif warning > 0:
            message = "conformant (%d warning%s)" % (
                warning, "" if warning == 1 else "s")
            color = "yellow"
        else:
            message = "conformant"
            color = "brightgreen"
    return {
        "schemaVersion": 1,
        "label": label,
        "message": message,
        "color": color,
    }


#: Minimal, inline stylesheet for the self-contained HTML report. No external
#: CSS/JS/fonts — everything the document needs travels inside it, so it opens
#: offline with zero network requests. Colours use system-ui fonts (a local
#: stack, never a web font) and a light-only palette that prints legibly.
_HTML_STYLE = """
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  margin: 0; padding: 2rem 1rem; color: #1b1f24; background: #f6f8fa;
  line-height: 1.5; }
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
.meta { color: #57606a; font-size: .85rem; margin: 0 0 1.5rem;
  word-break: break-all; }
.banner { border-radius: 8px; padding: 1rem 1.25rem; margin: 0 0 1.5rem;
  font-weight: 600; border: 1px solid transparent; }
.banner.pass { background: #e6f4ea; color: #14532d; border-color: #a6d8b4; }
.banner.fail { background: #fce8e6; color: #7a1f16; border-color: #f0b3ac; }
.banner .counts { display: block; font-weight: 400; font-size: .9rem;
  margin-top: .35rem; color: inherit; }
.finding { background: #fff; border: 1px solid #d0d7de; border-radius: 8px;
  padding: 1rem 1.25rem; margin: 0 0 1rem; }
.finding h2 { font-size: 1.05rem; margin: 0 0 .5rem;
  display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; }
.rule-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.sev { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em;
  padding: .1rem .5rem; border-radius: 999px; font-weight: 700; }
.sev.fatal { background: #fce8e6; color: #7a1f16; }
.sev.warning { background: #fff3d6; color: #7a5b0d; }
.sev.information { background: #ddeeff; color: #0a4a7a; }
.title { font-weight: 600; }
.msg { margin: .35rem 0; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem .8rem;
  margin: .6rem 0 0; font-size: .9rem; }
dt { color: #57606a; font-weight: 600; }
dd { margin: 0; word-break: break-word; }
dd.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.error-row { background: #fce8e6; border: 1px solid #f0b3ac; border-radius: 8px;
  padding: 1rem 1.25rem; }
.error-row .code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 700; }
footer { color: #57606a; font-size: .8rem; margin-top: 2rem; }
""".strip()


def _h(value):
    """HTML-escape ANY report/invoice/catalog-derived text for safe markup.

    A thin wrapper over :func:`html.escape` (quote=True, so both ``"`` and
    ``'`` are encoded) that also coerces ``None``/non-strings to a string first,
    so a missing catalog field renders as an empty cell rather than raising.
    ALL invoice- and catalog-derived text passes through here before it lands in
    the document — there is no raw f-string interpolation of untrusted text.
    """
    if value is None:
        return ""
    return html.escape(str(value), quote=True)


def build_html(report):
    """Project a report dict (from :func:`build_report`) into ONE self-contained
    static HTML document (returned as a ``str``, a full ``<!doctype html>`` …
    ``</html>``).

    Like :func:`build_junit` / :func:`build_sarif`, this is a PURE, additional
    PROJECTION of the very same validator outcome the JSON path emits — it adds
    no rule logic, invents no wording, and re-reads nothing. Every human string
    comes from either the Violation (message/field) or the committed remediation
    catalog fields that :func:`_record` already attached (title/fix_hint/terms/
    location), and EVERY such value is HTML-escaped through :func:`_h` before it
    reaches the markup (injection-safe).

    Self-containment (hard requirement): the only styling is an inline
    ``<style>`` block (:data:`_HTML_STYLE`); there are NO external CSS/JS/CDN
    references, no ``<img>``, no web fonts, no analytics — the file opens offline
    with zero network requests.

    Layout:
      * a pass/fail banner ("Conformant" vs "N finding(s)") built from the same
        summary fields (``valid``/``fatal_count``/``warning_count``/
        ``violation_count``) the JSON path exposes;
      * one card per violation carrying the rule id, a severity pill, the
        remediation ``title``, the violation ``message``, and a definition list
        of ``fix_hint`` / BT-BG ``terms`` / ``field`` / ``location``;
      * a not-well-formed input (``report`` has an ``error``) renders a single
        error row with the error code + parser message — mirroring the JSON /
        JUnit / SARIF not-well-formed contract.

    :param report: a dict as returned by :func:`build_report`.
    :returns: a self-contained HTML document as a ``str``.
    """
    profile = report.get("profile", "")
    source = report.get("source", "")

    parts = []
    parts.append("<!doctype html>")
    parts.append('<html lang="en">')
    parts.append("<head>")
    parts.append('<meta charset="utf-8">')
    parts.append('<meta name="viewport" content="width=device-width, '
                 'initial-scale=1">')
    parts.append('<meta name="robots" content="noindex">')
    parts.append("<title>einvoice conformance report</title>")
    parts.append("<style>%s</style>" % _HTML_STYLE)
    parts.append("</head>")
    parts.append("<body>")
    parts.append("<main>")
    parts.append("<h1>EN 16931 / XRechnung conformance report</h1>")
    parts.append('<p class="meta">source: %s &middot; profile: %s</p>'
                 % (_h(source) or "(stdin)", _h(profile)))

    if report.get("error"):
        # Not-well-formed XML: a single error row — the HTML analogue of the
        # JUnit single-<error> testcase / SARIF single error result.
        code = report["error"]
        msg = report.get("message", "") or code
        parts.append('<div class="banner fail">Not well-formed XML — the '
                     "invoice could not be parsed.</div>")
        parts.append('<div class="error-row">')
        parts.append('<span class="code">%s</span>' % _h(code))
        parts.append("<p>%s</p>" % _h(msg))
        parts.append("</div>")
    else:
        violations = report.get("violations", [])
        valid = report.get("valid")
        fatal_count = report.get("fatal_count", 0)
        warning_count = report.get("warning_count", 0)
        violation_count = report.get("violation_count", len(violations))

        if valid:
            n = violation_count
            note = ("no findings" if n == 0
                    else "%d non-fatal finding%s (warnings do not invalidate)"
                    % (n, "" if n == 1 else "s"))
            parts.append('<div class="banner pass">Conformant'
                         '<span class="counts">%s</span></div>' % _h(note))
        else:
            counts = ("%d finding%s &middot; %d fatal &middot; %d warning"
                      % (violation_count, "" if violation_count == 1 else "s",
                         fatal_count, warning_count))
            parts.append('<div class="banner fail">Not conformant'
                         '<span class="counts">%s</span></div>' % counts)

        for v in violations:
            rule = v.get("rule") or ""
            severity = v.get("severity") or "fatal"
            title = v.get("title")
            message = v.get("message") or ""
            fix_hint = v.get("fix_hint")
            terms = v.get("terms") or []
            field = v.get("field")
            location = v.get("location")

            sev_class = severity if severity in (
                "fatal", "warning", "information") else "information"

            parts.append('<div class="finding">')
            head = ['<span class="rule-id">%s</span>' % _h(rule),
                    '<span class="sev %s">%s</span>'
                    % (_h(sev_class), _h(severity))]
            if title:
                head.append('<span class="title">%s</span>' % _h(title))
            parts.append("<h2>%s</h2>" % "".join(head))
            if message:
                parts.append('<p class="msg">%s</p>' % _h(message))

            rows = []
            if fix_hint:
                rows.append(("How to fix", _h(fix_hint), False))
            if terms:
                rows.append(("Business terms",
                             _h(", ".join(str(t) for t in terms)), True))
            if field:
                rows.append(("Field", _h(field), True))
            if location:
                rows.append(("Location", _h(location), True))
            if rows:
                parts.append("<dl>")
                for label, val, mono in rows:
                    parts.append("<dt>%s</dt>" % _h(label))
                    parts.append('<dd%s>%s</dd>'
                                 % (' class="mono"' if mono else "", val))
                parts.append("</dl>")
            parts.append("</div>")

    parts.append("<footer>Static conformance artifact — reflects this one "
                 "report run against the invoice above. Generated offline by "
                 "einvoice; no network, no tracking.</footer>")
    parts.append("</main>")
    parts.append("</body>")
    parts.append("</html>")
    return "\n".join(parts) + "\n"


USAGE = ("usage: python3 -m einvoice.report "
         "[--profile en16931|xrechnung] [--format json|junit|sarif|html|badge] "
         "[--pretty] "
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

    if fmt not in ("json", "junit", "sarif", "html", "badge"):
        sys.stderr.write(
            "error: unknown format %r (choose from json, junit, sarif, html, "
            "badge)\n%s\n" % (fmt, USAGE))
        return EXIT_FAIL

    if profile not in PROFILES:
        sys.stderr.write("error: unknown profile %r (choose from %s)\n%s\n"
                         % (profile, ", ".join(PROFILES), USAGE))
        return EXIT_FAIL

    if baseline_path is not None and fmt in ("junit", "sarif", "html", "badge"):
        sys.stderr.write(
            "error: --baseline emits a diff document and is not compatible "
            "with --format %s\n%s\n" % (fmt, USAGE))
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
    elif fmt == "sarif":
        sys.stdout.write(
            json.dumps(build_sarif(report), indent=2, sort_keys=True) + "\n")
    elif fmt == "html":
        sys.stdout.write(build_html(report))
    elif fmt == "badge":
        sys.stdout.write(
            json.dumps(build_badge(report), indent=2, sort_keys=True) + "\n")
    elif pretty:
        sys.stdout.write(json.dumps(report, indent=2, sort_keys=True) + "\n")
    else:
        sys.stdout.write(json.dumps(report, separators=(",", ":")) + "\n")

    if report.get("error") == "not-well-formed":
        return EXIT_PARSE
    return EXIT_OK if report["fatal_count"] == 0 else EXIT_FAIL


if __name__ == "__main__":
    sys.exit(main())

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

import hashlib
import html
import json
import os
import sys
from collections import Counter
from xml.sax.saxutils import escape, quoteattr

from xml.etree import ElementTree as ET

from .validate import validate_file, validate_root, PROFILES, _severity
from .parser import NotWellFormed, parse_file
from ._xmlsec import _safe_fromstring
from .remediation import load_catalog
from . import pdf_container
from . import parser_cii as _parser_cii
from . import rules as _rules
from . import rules_xrechnung as _rules_xr
from . import syntax_binding_eval as _sbe

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

#: The directory / batch wrapper is ANOTHER independently versioned shape — it
#: WRAPS the per-file plain reports, it does not mutate them, so
#: ``REPORT_VERSION`` (the single-file schema) stays 1 and the batch document
#: carries its own version namespace, starting at v1.
REPORT_BATCH_VERSION = 1
REPORT_BATCH_SCHEMA_ID = "einvoice-conformance-batch/v1"

#: Exit codes — kept in lock-step with ``einvoice.cli`` (imported-by-value so a
#: drift there is caught by tests, not silently duplicated).
EXIT_OK = 0
EXIT_FAIL = 1
EXIT_PARSE = 3

#: Documentation of the versioned report shape. Every key the report can carry
#: is described here; REPORT-SCHEMA.md renders the same contract for humans, and
#: ../report.schema.json is the MACHINE-CHECKABLE form (JSON Schema draft
#: 2020-12) — it pins the version via a ``schema`` const of REPORT_SCHEMA_ID and
#: ``report_version`` const 1, and is exercised against real build_report output
#: by test_report_schema.py. Keep the three in sync when the shape changes.
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
        "error": "present ONLY when the input cannot be reduced to a "
                 "validatable invoice: a short code string — 'not-well-formed' "
                 "(bad XML) or 'unsupported-container' (a PDF whose embedded "
                 "e-invoice XML the zero-dependency extractor cannot reach). "
                 "'valid' is then false and 'violations' is empty.",
        "message": "present ONLY alongside 'error': the parser's / extractor's "
                   "human message.",
    },
    "violation_record": {
        "rule": "the rule id, e.g. 'BR-DE-15' (from Violation.rule_id). For "
                "Factur-X/ZUGFeRD PDF input the report may ALSO carry "
                "'FX-CONTAINER-*' ids (FX-CONTAINER-AFRELATIONSHIP, "
                "FX-CONTAINER-AF, FX-CONTAINER-XMP, FX-CONTAINER-PROFILE) — the "
                "container-declaration checks (/AFRelationship + /AF, XMP "
                "profile declaration, XMP-vs-CII profile consistency) that "
                "einvoice.pdf_container layers over the embedded XML. These are "
                "warning-severity and never appear on the plain-XML path.",
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
        "source_line": "OPTIONAL, additive: the 1-based parser line of the "
                       "offending element in the source document. Present ONLY "
                       "for an attributable field-level violation (a rule that "
                       "held the concrete Element); ABSENT when the finding is "
                       "not attributable to a source position (an "
                       "absence/document-level rule). Distinct from the "
                       "catalog XML-path hint 'location'.",
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
    record = {
        "rule": v.rule_id,
        "severity": _severity(v),
        "message": v.message,
        "field": v.element,
        "title": entry.get("title"),
        "fix_hint": entry.get("fix"),
        "terms": list(entry.get("bt_bg") or []),
        "location": entry.get("location_hint"),
    }
    # Additive, OPTIONAL: the 1-based parser line of the offending element,
    # present ONLY for an attributable field-level violation (see
    # einvoice.rules). Absence of the key means "not attributable to a source
    # position" (an absence/document-level rule, or a finding without a proven
    # element). The eight identity/remediation keys above are unchanged, so a
    # consumer that ignores source_line reads a byte-identical record. NOTE: the
    # remediation-catalog XML-path hint is the SEPARATE `location` key; this new
    # key is the source LINE and never collides with it.
    source_line = getattr(v, "source_line", None)
    if source_line is not None:
        record["source_line"] = source_line
    return record


def _error_report(source, profile, code, message):
    """Build a valid=false report carrying an ``error``/``message`` pair.

    Shared by the not-well-formed and unsupported-container paths so both are a
    non-pass report with empty counts rather than a raised traceback.
    """
    return {
        "report_version": REPORT_VERSION,
        "schema": REPORT_SCHEMA_ID,
        "source": source,
        "profile": profile,
        "valid": False,
        "error": code,
        "message": message,
        "fatal_count": 0,
        "warning_count": 0,
        "violation_count": 0,
        "violations": [],
    }


def _report_from_violations(violations, source, profile):
    """Project a list of :class:`~einvoice.rules.Violation` into the report dict.

    The SAME projection :func:`build_report` applies to the UBL path — one
    :func:`_record` per violation, counts derived from the mapped severities —
    so a PDF-embedded invoice yields a byte-identical report shape to validating
    its XML directly. Adds NO rule logic.
    """
    catalog = _remediation_catalog()
    records = [_record(v, catalog) for v in violations]
    fatal_count = sum(1 for r in records if r["severity"] == "fatal")
    warning_count = sum(1 for r in records if r["severity"] == "warning")
    return {
        "report_version": REPORT_VERSION,
        "schema": REPORT_SCHEMA_ID,
        "source": source,
        "profile": profile,
        "valid": fatal_count == 0,
        "fatal_count": fatal_count,
        "warning_count": warning_count,
        "violation_count": len(records),
        "violations": records,
    }


def _report_from_invoice_bytes(xml_bytes, source, profile,
                               container_findings=None):
    """Validate already-extracted invoice XML bytes and return a report dict.

    Used by the PDF-container path. Dispatches on the XML root: a UN/CEFACT
    ``CrossIndustryInvoice`` (Factur-X / ZUGFeRD / CII XRechnung) is validated
    through the CII engine (``parser_cii.build_model`` + the syntax-agnostic
    ``rules.ALL_RULES`` core rules + ``rules_xrechnung.evaluate_cii`` for the
    German CIUS layer) — exactly the path ``test_golden_snapshot`` and
    ``test_rules_cii`` exercise. A UBL ``Invoice`` root is routed through the
    existing :func:`~einvoice.validate.validate_root`. This RE-IMPLEMENTS no
    rule logic; it only feeds the extracted bytes into the shipped engines.

    :param container_findings: optional list of FX-CONTAINER-* container
        declaration findings (``pdf_container.ContainerFinding``, structurally a
        Violation) to append verbatim after the rule findings. Each is projected
        through the SAME :func:`_record` mapping, so they carry the identical
        record shape; they never change the XML-path behaviour.
    """
    extra = list(container_findings or ())
    try:
        # Untrusted embedded bytes: parse through the DTD/entity/XXE-hardened
        # helper (see einvoice._xmlsec). A hostile DTD/entity/external-reference
        # payload raises XMLSecurityError (an ET.ParseError subclass), caught
        # here and folded into the SAME actionable not-well-formed report an
        # ill-formed embedded XML produces — never a traceback or expansion.
        root = _safe_fromstring(xml_bytes)  # hardened stdlib replacement for ET.fromstring; see einvoice._xmlsec
    except ET.ParseError as exc:
        return _error_report(source, profile, "not-well-formed", str(exc))

    localname = root.tag.rsplit("}", 1)[-1]
    if localname == "CrossIndustryInvoice":
        inv = _parser_cii.build_model(root)
        violations = [v for v in (fn(inv) for fn in _rules.ALL_RULES)
                      if v is not None]
        if profile == "xrechnung":
            violations.extend(_rules_xr.evaluate_cii(inv))
        return _report_from_violations(violations + extra, source, profile)

    # UBL (or any other root) — reuse the core UBL engine verbatim. A non-UBL,
    # non-CII root falls out here as the same S-ROOT fatal the XML path emits.
    result = validate_root(root, profile=profile)
    return _report_from_violations(
        list(result.violations) + extra, source, profile)


def syntax_binding_section(root):
    """The distinct **syntax-binding** category block for a parsed document
    ``root`` — a small, reusable projection so both this report and the
    ``einvoice validate`` CLI surface the SAME findings, from the SAME evaluator
    (:func:`einvoice.syntax_binding_eval.evaluate`), with byte-identical field
    names. No rule/evaluator logic lives here: it only runs the evaluator once
    and counts the results by their official ``@flag``-derived severity.

    Returns a dict with exactly three keys:

        ``syntax_bindings``               list of finding dicts (each carrying
                                          ``id``, ``category``, ``severity``,
                                          ``flag``, ``message``, ``element``);
        ``syntax_binding_fatal_count``    number of ``fatal`` findings;
        ``syntax_binding_warning_count``  number of ``warning`` findings.

    A non-UBL root (or a missing catalog) yields an empty list and zero counts.
    Whether a ``fatal`` finding blocks validity is decided by the CALLER — the
    packaged report lets it flip ``valid``; the CLI deliberately does not (its
    exit contract stays driven solely by fatal business-rule violations).
    """
    sb_findings = _sbe.evaluate(root)
    sb_fatal = sum(1 for f in sb_findings if f["severity"] == "fatal")
    return {
        "syntax_bindings": sb_findings,
        "syntax_binding_fatal_count": sb_fatal,
        "syntax_binding_warning_count": len(sb_findings) - sb_fatal,
    }


def build_report(path, profile="xrechnung"):
    """Validate ``path`` and return a machine-readable conformance report dict.

    Reuses :func:`einvoice.validate.validate_file` for ALL rule evaluation on
    the XML path. Not-well-formed XML is folded into a report with
    ``valid=False`` and an ``error`` field (mirroring ``cli.py``) instead of
    raising.

    Factur-X / ZUGFeRD PDF container: if ``path`` is a PDF (detected by the
    ``%PDF-`` magic, not the extension), the embedded e-invoice XML is extracted
    zero-dependency via :mod:`einvoice.pdf_container` and validated through the
    same rule engine. A container we cannot open zero-dep (encryption, xref
    streams, no ``/EmbeddedFiles`` tree, unknown filter) folds into an explicit
    ``error='unsupported-container'`` non-pass report — NEVER a false pass and
    NEVER a traceback. The plain-XML path behaviour is unchanged.

    :param path: path to the invoice XML (or Factur-X/ZUGFeRD PDF) file.
    :param profile: 'xrechnung' (default) or 'en16931'.
    :returns: a dict matching :data:`REPORT_SCHEMA`.
    """
    if pdf_container.is_pdf_file(path):
        try:
            inspection = pdf_container.inspect_container(path)
        except pdf_container.UnsupportedContainer as exc:
            detail = str(exc)
            if detail.startswith("unsupported container:"):
                detail = detail[len("unsupported container:"):].strip()
            return _error_report(
                path, profile, "unsupported-container",
                "unsupported container — could not extract embedded invoice "
                "XML: %s" % detail)
        # The extracted XML runs the identical rule engine; the FX-CONTAINER-*
        # container-declaration findings (ZUGFeRD/Factur-X /AFRelationship, /AF,
        # XMP profile + XMP-vs-CII consistency) are appended as first-class
        # warning records. PDF-input only — the XML path is untouched.
        return _report_from_invoice_bytes(
            inspection.xml_bytes, path, profile,
            container_findings=inspection.findings)

    try:
        # Parse ONCE (hardened) so the syntax-binding evaluator sees the SAME
        # raw tree the business rules validate — the absence-restriction asserts
        # target literal UBL nodes the normalized model deliberately drops.
        root = parse_file(path)
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

    result = validate_root(root, profile=profile)
    catalog = _remediation_catalog()  # loaded once, not per violation record
    records = [_record(v, catalog) for v in result.violations]
    fatal_count = sum(1 for r in records if r["severity"] == "fatal")
    warning_count = sum(1 for r in records if r["severity"] == "warning")

    # Distinct 'syntax-binding' category — the data-driven UBL absence-restriction
    # findings (einvoice.syntax_binding_eval). Each mirrors the official CEN
    # @flag: `warning` findings are reported but do NOT affect validity/exit code
    # (the BR-DE warning convention); a `fatal` finding blocks validity like any
    # fatal violation. Surfaced under a SEPARATE top-level key so the `violations`
    # array, its counts, and every existing consumer stay byte-identical.
    sb = syntax_binding_section(root)
    return {
        "report_version": REPORT_VERSION,
        "schema": REPORT_SCHEMA_ID,
        "source": path,
        "profile": profile,
        "valid": result.ok and sb["syntax_binding_fatal_count"] == 0,
        "fatal_count": fatal_count,
        "warning_count": warning_count,
        "violation_count": len(records),
        "violations": records,
        **sb,
    }


#: File extensions collected in directory / batch mode. ``.xml`` is the plain
#: UBL/CII path; ``.pdf`` is the Factur-X/ZUGFeRD hybrid path :func:`build_report`
#: already dispatches on the ``%PDF-`` magic. Matched case-insensitively.
BATCH_INVOICE_EXTS = (".xml", ".pdf")


def collect_invoice_files(root):
    """Walk ``root`` recursively and return a DETERMINISTIC, sorted list of the
    invoice files under it.

    Selection: regular files whose name ends (case-insensitively) with one of
    :data:`BATCH_INVOICE_EXTS`. Dotfiles and dot-directories are skipped (editor
    swap files, ``.git`` metadata, macOS ``._`` resource forks, etc. are never
    validated). The result is ``sorted`` by path so the batch output is stable
    across filesystems and runs.
    """
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        # Prune dot-directories in place so os.walk never descends into them.
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if name.startswith("."):
                continue
            lower = name.lower()
            if any(lower.endswith(ext) for ext in BATCH_INVOICE_EXTS):
                found.append(os.path.join(dirpath, name))
    return sorted(found)


def build_batch_report(root, profile="xrechnung"):
    """Validate every invoice file under directory ``root`` and wrap the per-file
    reports in an aggregate document (schema ``einvoice-conformance-batch/v1``).

    This drives the EXISTING :func:`build_report` once per collected file — it is
    a WRAPPER, not a second engine, and adds NO rule logic. Each entry in the
    returned ``files`` array is the plain single-file report dict UNCHANGED
    (same shape, same ``source``, byte-for-byte identical to validating that file
    on its own), so the single-file contract is preserved verbatim.

    The wrapper carries its own version namespace and the aggregate counts:
    ``file_count``, ``fatal_count`` / ``warning_count`` / ``violation_count``
    (summed across files) and ``failed_file_count`` (files that errored OR have
    at least one fatal). An empty directory yields ``file_count == 0``, empty
    ``files`` and an explicit ``note`` — never a traceback and never a fake pass
    with fabricated content.

    :param root: a directory path (the caller has already checked ``isdir``).
    :param profile: 'xrechnung' (default) or 'en16931'.
    :returns: an aggregate dict (see :data:`REPORT_BATCH_SCHEMA`).
    """
    return build_batch_report_from_files(
        collect_invoice_files(root), profile=profile, root=root)


def build_batch_report_from_files(files, profile="xrechnung", root=None):
    """Aggregate an ALREADY-ORDERED list of invoice file paths into a batch
    document (schema ``einvoice-conformance-batch/v1``).

    This is the single shared aggregation path: :func:`build_batch_report`
    calls it with ``collect_invoice_files(root)`` (the directory walk) and the
    CLI glob mode calls it with the globbed, sorted file list. Because BOTH
    drive the identical per-file :func:`build_report` projection and the SAME
    counting here, the aggregate dict is byte-identical across the two entry
    points for the same set of files — there is no second aggregation engine
    and no re-implemented rule logic.

    ``files`` must be the final, deterministically ordered list of paths (the
    caller decides how they were discovered). ``root`` is only the label
    recorded in the document (a directory path or a glob pattern); it never
    affects the counts or the per-file reports. An empty ``files`` list yields
    ``file_count == 0``, an empty ``files`` array and an explicit ``note`` —
    never a traceback and never a fake pass over fabricated content.

    :param files: ordered list of invoice file paths to validate.
    :param profile: 'xrechnung' (default) or 'en16931'.
    :param root: the label (directory or glob pattern) recorded in the document.
    :returns: an aggregate dict (see :data:`REPORT_BATCH_SCHEMA`).
    """
    reports = [build_report(p, profile=profile) for p in files]

    fatal_count = sum(r.get("fatal_count", 0) for r in reports)
    warning_count = sum(r.get("warning_count", 0) for r in reports)
    violation_count = sum(r.get("violation_count", 0) for r in reports)
    failed_file_count = sum(
        1 for r in reports if r.get("error") or r.get("fatal_count", 0) > 0)

    batch = {
        "report_version": REPORT_BATCH_VERSION,
        "schema": REPORT_BATCH_SCHEMA_ID,
        "root": root,
        "profile": profile,
        "file_count": len(reports),
        "fatal_count": fatal_count,
        "warning_count": warning_count,
        "violation_count": violation_count,
        "failed_file_count": failed_file_count,
        "files": reports,
    }
    if not reports:
        # Honest empty result: nothing was validated, so say so rather than
        # presenting a green pass over fabricated content.
        batch["note"] = "no invoice files found"
    return batch


def batch_exit_code(batch):
    """Aggregate process exit code for a batch report.

    Documented precedence (fatal outranks parse): if ANY file has a fatal
    violation -> :data:`EXIT_FAIL` (1); else if ANY file errored (not-well-formed
    XML / unsupported PDF container) -> :data:`EXIT_PARSE` (3); else every file
    passed -> :data:`EXIT_OK` (0). An empty directory has no failing/erroring
    files, so it is :data:`EXIT_OK`.
    """
    reports = batch.get("files", [])
    if any(r.get("fatal_count", 0) > 0 for r in reports):
        return EXIT_FAIL
    if any(r.get("error") for r in reports):
        return EXIT_PARSE
    return EXIT_OK


def build_batch_text(batch):
    """Render a batch report as a concise, human-readable text summary.

    One status line per file (``PASS`` / ``FAIL`` / ``ERROR``) followed by an
    aggregate tally line. An empty directory prints a single 'no invoice files
    found' line. Pure projection of the batch dict — no rule logic.
    """
    root = batch.get("root", "")
    file_count = batch.get("file_count", 0)
    if file_count == 0:
        return "einvoice batch: no invoice files found under %s\n" % root

    lines = []
    for r in batch.get("files", []):
        src = r.get("source", "")
        if r.get("error"):
            lines.append("ERROR %s  %s" % (src, r.get("error")))
        elif r.get("fatal_count", 0) > 0:
            lines.append("FAIL  %s  %d fatal, %d warning"
                         % (src, r.get("fatal_count", 0),
                            r.get("warning_count", 0)))
        else:
            wc = r.get("warning_count", 0)
            tail = (" (%d warning%s)" % (wc, "" if wc == 1 else "s")
                    if wc else "")
            lines.append("PASS  %s  conformant%s" % (src, tail))

    failed = batch.get("failed_file_count", 0)
    passed = file_count - failed
    lines.append("")
    lines.append(
        "%d file%s: %d passed, %d failed  "
        "(%d fatal, %d warning across all files)"
        % (file_count, "" if file_count == 1 else "s", passed, failed,
           batch.get("fatal_count", 0), batch.get("warning_count", 0)))
    return "\n".join(lines) + "\n"


def build_text(report):
    """Render a SINGLE-file report as a concise text summary (additive format).

    A status header (``PASS`` / ``FAIL`` / ``ERROR``) followed by one indented
    line per violation. Pure projection — no rule logic. This is a new,
    additive format: it never affects the default JSON bytes.
    """
    src = report.get("source", "")
    if report.get("error"):
        return "ERROR %s  %s: %s\n" % (
            src, report["error"], report.get("message", "") or "")
    if report.get("fatal_count", 0) > 0:
        head = "FAIL  %s  %d fatal, %d warning" % (
            src, report.get("fatal_count", 0), report.get("warning_count", 0))
    else:
        wc = report.get("warning_count", 0)
        tail = " (%d warning%s)" % (wc, "" if wc == 1 else "s") if wc else ""
        head = "PASS  %s  conformant%s" % (src, tail)
    lines = [head]
    for v in report.get("violations", []):
        field = v.get("field")
        lines.append("  [%s] %s: %s%s" % (
            v.get("severity", ""), v.get("rule", ""), v.get("message", ""),
            " (%s)" % field if field else ""))
    return "\n".join(lines) + "\n"


#: Documentation of the versioned BATCH wrapper shape (companion to
#: REPORT-SCHEMA.md). Emitted when the positional path is a directory (or with
#: ``--recurse``). It WRAPS unchanged single-file reports; it never mutates them.
REPORT_BATCH_SCHEMA = {
    "schema": REPORT_BATCH_SCHEMA_ID,
    "report_version": REPORT_BATCH_VERSION,
    "description": (
        "Aggregate directory/batch conformance report. Drives the single-file "
        "build_report once per invoice file found under a directory and wraps "
        "the UNCHANGED per-file reports; reuses einvoice.validate, no rule "
        "logic. Its own version namespace, independent of the single-file "
        "report schema."
    ),
    "fields": {
        "report_version": "int; the batch document's own version (starts at 1).",
        "schema": "stable batch schema id ('%s')." % REPORT_BATCH_SCHEMA_ID,
        "root": "the directory path that was walked.",
        "profile": "validation profile used: 'en16931' or 'xrechnung'.",
        "file_count": "int — number of invoice files collected and validated.",
        "fatal_count": "int — total fatal violations summed across all files.",
        "warning_count": "int — total warning violations summed across files.",
        "violation_count": "int — total violations of every severity, summed.",
        "failed_file_count": "int — files that errored OR carry >=1 fatal.",
        "files": "array of per-file single-file report dicts (each UNCHANGED, "
                 "including its own 'source'); schema '%s'." % REPORT_SCHEMA_ID,
        "note": "present ONLY when file_count == 0: the literal 'no invoice "
                "files found' (an empty directory is reported honestly, not as "
                "a fake pass).",
    },
    "exit_codes": {
        "0": "every file passed (each fatal_count==0 and no error), OR the "
             "directory held no invoice files.",
        "1": "at least one file has a fatal violation (outranks parse).",
        "3": "at least one file errored (not-well-formed / unsupported "
             "container) and no file had a fatal violation.",
    },
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


def _junit_suite_block(report, suite_name=None):
    """Build ONE ``<testsuite>...</testsuite>`` block for a single report.

    Returns ``(lines, tests, failures, errors)`` where ``lines`` is the list of
    XML lines for exactly one ``<testsuite>`` element (indented for nesting under
    ``<testsuites>``). Shared by :func:`build_junit` (single file) and
    :func:`build_junit_batch` (directory) so the per-file testcase shape is
    byte-identical in both. ``suite_name`` defaults to the profile (the historic
    single-file behaviour); the batch path passes the file path so each suite is
    distinguishable in a CI report.
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

    if suite_name is None:
        suite_name = profile
    suite_attrs = ("name=%s tests=%s failures=%s errors=%s"
                   % (quoteattr(suite_name), quoteattr(str(tests)),
                      quoteattr(str(failures)), quoteattr(str(errors))))
    block = ["  <testsuite %s>" % suite_attrs]
    block.extend(lines)
    block.append("  </testsuite>")
    return block, tests, failures, errors


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
    block, tests, failures, errors = _junit_suite_block(report)
    suites_attrs = ("name=%s tests=%s failures=%s errors=%s"
                    % (quoteattr(JUNIT_SUITES_NAME), quoteattr(str(tests)),
                       quoteattr(str(failures)), quoteattr(str(errors))))

    out = ['<?xml version="1.0" encoding="UTF-8"?>']
    out.append("<testsuites %s>" % suites_attrs)
    out.extend(block)
    out.append("</testsuites>")
    return "\n".join(out) + "\n"


def build_junit_batch(batch):
    """Project a batch wrapper (from :func:`build_batch_report`) into aggregate
    JUnit XML: ONE ``<testsuites>`` carrying one ``<testsuite>`` per file.

    Each per-file ``<testsuite>`` reuses :func:`_junit_suite_block` verbatim, so
    the individual testcase shape is identical to the single-file JUnit output;
    the suite is named by the file path so CI can tell the files apart. The
    top-level ``<testsuites>`` ``tests``/``failures``/``errors`` are the SUM
    across every file. An empty directory yields a valid, empty
    ``<testsuites>`` (all counts 0) — never a traceback.

    :param batch: a dict as returned by :func:`build_batch_report`.
    :returns: a JUnit XML document as a ``str`` (UTF-8 declaration included).
    """
    body = []
    total_tests = total_failures = total_errors = 0
    for report in batch.get("files", []):
        suite_name = report.get("source") or batch.get("root") or ""
        block, tests, failures, errors = _junit_suite_block(
            report, suite_name=suite_name)
        body.extend(block)
        total_tests += tests
        total_failures += failures
        total_errors += errors

    suites_attrs = ("name=%s tests=%s failures=%s errors=%s"
                    % (quoteattr(JUNIT_SUITES_NAME), quoteattr(str(total_tests)),
                       quoteattr(str(total_failures)),
                       quoteattr(str(total_errors))))
    out = ['<?xml version="1.0" encoding="UTF-8"?>']
    out.append("<testsuites %s>" % suites_attrs)
    out.extend(body)
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

#: Canonical base URL for a per-rule reference page, e.g.
#: ``https://verifyhash.com/einvoice/rules/BR-01/``. This is the EXACT form
#: ``gen_site.py`` emits via its ``_url_rule`` helper (BASE_URL
#: ``https://verifyhash.com/einvoice`` + ``/rules/<id>/``, trailing slash). It
#: is duplicated here as a plain string constant rather than imported because
#: ``gen_site`` is a build script, not a runtime import; a static test pins the
#: two forms together. Used only for a SARIF ``reportingDescriptor.helpUri``
#: deep-link — no network is ever touched.
SARIF_RULE_HELP_BASE_URL = "https://verifyhash.com/einvoice/rules/"

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


#: The single, versioned key under which a SARIF ``result.partialFingerprints``
#: digest is published. GitHub code-scanning uses ``partialFingerprints`` to
#: track "the same finding" across runs even when line numbers shift, so the
#: value MUST be stable across edits — see :func:`_sarif_fingerprint`.
_SARIF_FINGERPRINT_KEY = "einvoice/v1"


def _sarif_fingerprint(rule_id, loc_name):
    """Deterministic, byte-reproducible fingerprint for a SARIF result.

    GitHub code-scanning de-duplicates a finding across runs by
    ``partialFingerprints``, so the digest must be STABLE when line numbers
    shift (an invoice edit that moves a violation to a different source line is
    still "the same finding"). We therefore hash ONLY the rule id and the
    normalized logical location (the ``field``/``location`` member already used
    for ``logicalLocations``) with SHA-256 — deliberately NOT ``source_line``,
    which moves on every edit. ``rule_id`` and ``loc_name`` are joined by a
    single space (``loc_name`` empty-string when absent), matching the spec's
    ``rule_id + ' ' + (loc_name or '')`` form, so two runs on the same logical
    finding produce byte-identical digests and no line dependence leaks in.
    """
    payload = (rule_id or "") + " " + (loc_name or "")
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


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

    # The set of ids for which an authoritative rule-reference page exists;
    # only these earn a ``helpUri`` deep-link. Loaded once per call.
    catalog_ids = load_catalog()

    if report.get("error"):
        # Not-well-formed XML: a single error result, no rule metadata — the
        # SARIF analogue of the JUnit single-<error> testcase. The fingerprint
        # is keyed on the error code alone (no source line, no page exists), so
        # it is stable and gets NO helpUri.
        error_code = report["error"]
        results.append({
            "ruleId": error_code,
            "level": "error",
            "message": {"text": report.get("message", "") or error_code},
            "partialFingerprints": {
                _SARIF_FINGERPRINT_KEY: _sarif_fingerprint(error_code, None),
            },
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
                # Deep-link to the authoritative live rule-reference page, but
                # ONLY for a real catalog rule id (that is where a page exists);
                # a synthetic/unknown id gets no helpUri.
                if rule_id in catalog_ids:
                    descriptor["helpUri"] = (
                        SARIF_RULE_HELP_BASE_URL + rule_id + "/")
                rules.append(descriptor)

            loc_name = field or location
            result = {
                "ruleId": rule_id,
                "level": _sarif_level(severity),
                "message": {"text": v.get("message") or title or rule_id},
                # Stable across line shifts: derived from rule id + logical
                # location only, never the source line (see _sarif_fingerprint).
                "partialFingerprints": {
                    _SARIF_FINGERPRINT_KEY: _sarif_fingerprint(
                        rule_id, loc_name),
                },
            }
            # Attach a logical location when we know WHERE the finding is;
            # omit ``locations`` entirely when neither field nor location hint
            # is present (an empty locations array is not useful).
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


#: GitLab Code Quality (Code Climate) ``severity`` for each report severity.
#: The Code Quality contract accepts only {info, minor, major, critical,
#: blocker}: a FATAL/parse ``error`` is a build-breaking ``major``, a
#: ``warning`` is ``minor``, and an advisory ``information`` finding is ``info``.
#: See GitLab docs "Code Quality report format" / the Code Climate spec.
_GITLAB_SEVERITY = {
    "fatal": "major",
    "error": "major",
    "warning": "minor",
    "information": "info",
}


def _gitlab_severity(severity):
    """Map a report severity string onto a GitLab Code Quality ``severity``.

    ``fatal``/``error`` -> ``major`` (build-breaking), ``warning`` -> ``minor``,
    ``information`` (or any unknown value) -> ``info``. The result is always one
    of the five documented enum values {info, minor, major, critical, blocker}.
    """
    return _GITLAB_SEVERITY.get(severity, "info")


def _gitlab_fingerprint(check_name, path, line):
    """Deterministic, byte-reproducible hex fingerprint for a Code Quality entry.

    GitLab de-duplicates findings across pipeline runs by ``fingerprint``, so it
    must be STABLE for the same finding at the same location. We hash a
    normalized ``rule id | path | line`` triple with SHA-256; the pieces are
    joined with a NUL separator and the line is rendered as its decimal string
    (or empty when the finding is not attributed to a source line), so two runs
    on the same input produce byte-identical digests and no rule logic leaks in.
    """
    line_part = "" if line is None else str(line)
    payload = "\x00".join((check_name or "", path or "", line_part))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def build_gitlab(report):
    """Project a report dict (from :func:`build_report`) into a GitLab Code
    Quality (Code Climate) JSON array.

    Emits the list GitLab consumes via ``artifacts:reports:codequality:`` — the
    documented "Code Quality report format", a subset of the Code Climate engine
    spec. Each element is one issue object with ``description``, ``check_name``,
    ``fingerprint``, ``severity`` and a ``location`` carrying ``path`` (and, when
    the finding is attributed to a source position, ``lines.begin``). GitLab
    renders these as inline annotations on merge requests and as a Code Quality
    widget/summary.

    Like :func:`build_sarif` and :func:`build_junit`, this is a PURE, additional
    PROJECTION of the very same validator outcome the JSON path emits — it adds
    no rule logic, invents no wording, and re-reads nothing. Every field is
    relayed from the record dict :func:`_record` already produced:

      * ``description`` = the violation message, falling back to the catalog
        ``title`` and then the rule id (never empty);
      * ``check_name`` = the rule id;
      * ``severity`` = :func:`_gitlab_severity` of the report severity;
      * ``fingerprint`` = :func:`_gitlab_fingerprint` over the rule id and the
        normalized location, so re-runs de-dup deterministically;
      * ``location.path`` = the invoice ``source`` path (falling back to the
        violation ``field`` and then the catalog ``location`` hint);
      * ``location.lines.begin`` = the OPTIONAL ``source_line`` the record
        carries when the finding is attributable — the ``lines`` member is
        OMITTED entirely (never emitted as 0) when ``source_line`` is absent.

    Emission scope: this projects the CONFORMANCE issues — the ``fatal`` and
    ``warning`` findings that drive the valid flag and the process exit code.
    Purely advisory ``information`` findings (which never make an invoice
    non-conformant and are absent from ``fatal_count``/``warning_count``) are
    NOT emitted, so a conformant invoice yields the EMPTY Code Quality report
    that GitLab reads as "no quality issues" — the same verdict every other
    format reports. No rule fires or stops firing here; this is a projection.

    A not-well-formed input (``report`` has an ``error``) yields a single
    object for the parse error — ``check_name`` = the error code, ``severity``
    ``major``, ``description`` the parser message — mirroring the SARIF/JUnit
    not-well-formed contract.

    :param report: a dict as returned by :func:`build_report`.
    :returns: a GitLab Code Quality document as a ``list`` of ``dict``.
    """
    source = report.get("source") or ""
    issues = []

    if report.get("error"):
        # Not-well-formed XML: a single Code Quality entry for the parse error,
        # the GitLab analogue of the SARIF single-error result. A parse failure
        # is build-breaking, so it maps to ``major``.
        code = report["error"]
        path = source
        issues.append({
            "description": report.get("message", "") or code,
            "check_name": code,
            "fingerprint": _gitlab_fingerprint(code, path, None),
            "severity": _gitlab_severity("error"),
            "location": {"path": path},
        })
        return issues

    for v in report.get("violations", []):
        rule_id = v.get("rule") or ""
        severity = v.get("severity") or "fatal"
        # Advisory-only findings do not represent a conformance regression and
        # are excluded so a conformant invoice produces the empty Code Quality
        # report GitLab expects. fatal (-> major) and warning (-> minor) stay.
        if severity == "information":
            continue
        title = v.get("title")
        field = v.get("field")
        location_hint = v.get("location")
        # location.path is a FILE path: the validated invoice. Fall back to the
        # element field / catalog location hint only if the source is missing.
        path = source or field or location_hint or ""
        source_line = v.get("source_line")

        issue = {
            "description": v.get("message") or title or rule_id,
            "check_name": rule_id,
            "fingerprint": _gitlab_fingerprint(rule_id, path, source_line),
            "severity": _gitlab_severity(severity),
            "location": {"path": path},
        }
        # Attach the 1-based begin line ONLY when the finding is attributed to a
        # source position; omit ``lines`` entirely otherwise (never emit 0).
        if source_line is not None:
            issue["location"]["lines"] = {"begin": source_line}
        issues.append(issue)

    return issues


def _github_level(severity):
    """Map a report severity string onto a GitHub Actions workflow-command level.

    GitHub understands exactly three annotation commands — ``::error``,
    ``::warning`` and ``::notice``. Mirroring :func:`_sarif_level`'s
    fatal->error split, a ``fatal`` finding (the only severity that makes an
    invoice non-conformant and drives exit code 1) becomes ``error``; every
    other severity (``warning``, the advisory ``information``, or an unknown
    value) becomes ``warning`` — a yellow, non-build-breaking annotation. The
    level is a PRESENTATION mapping only: it never changes which rules fire or
    the process exit code.
    """
    return "error" if severity == "fatal" else "warning"


def _github_escape_data(text):
    """Escape a workflow-command MESSAGE per GitHub's rules.

    GitHub Actions parses ``::<cmd> ...::<message>`` line by line, so a literal
    percent, CR or LF in the message would corrupt the command. Per the runner's
    ``toolkit`` ``escapeData``: ``%`` -> ``%25`` (done FIRST so the escape
    character we introduce is not itself re-escaped), then CR -> ``%0D`` and
    LF -> ``%0A``. This is deliberately NOT XML escaping — workflow commands are
    a line protocol, so :func:`escape`/:func:`quoteattr` are the wrong tool.
    """
    return (str(text)
            .replace("%", "%25")
            .replace("\r", "%0D")
            .replace("\n", "%0A"))


def _github_escape_property(text):
    """Escape a workflow-command PROPERTY value (``file=``/``title=``/``line=``).

    Property values live inside the comma-separated ``k=v`` list, so on top of
    the message escaping (:func:`_github_escape_data`) GitHub's ``escapeProperty``
    also encodes the two delimiters that would otherwise split the list or the
    pair: ``,`` -> ``%2C`` and ``:`` -> ``%3A``. ``%`` is still escaped first
    (inside :func:`_github_escape_data`) so no escape sequence is double-encoded.
    """
    return (_github_escape_data(text)
            .replace(",", "%2C")
            .replace(":", "%3A"))


def build_github(report):
    """Project a report dict (from :func:`build_report`) into GitHub Actions
    workflow-command annotation lines.

    Emits one ``::error`` / ``::warning`` workflow command per violation, the
    line protocol a GitHub Actions runner turns into an INLINE annotation on the
    offending file — with zero SARIF upload and zero GitHub Advanced Security /
    code-scanning setup (unlike :func:`build_sarif`, which needs
    ``upload-sarif`` and ``security-events: write``). Any step that simply prints
    these lines to stdout gets file-anchored annotations for free.

    Like :func:`build_sarif` and :func:`build_gitlab`, this is a PURE, additional
    PROJECTION of the very same validator outcome the JSON path emits — it adds
    no rule logic, invents no wording, and re-reads nothing:

      * command = :func:`_github_level` of the severity — ``fatal`` -> ``::error``
        (build-breaking, matches exit 1), ``warning``/``information`` ->
        ``::warning``;
      * ``file=`` = the invoice ``source`` path (the same value
        :func:`build_gitlab` puts in ``location.path``), falling back to the
        violation ``field`` then the catalog ``location`` hint;
      * ``line=`` = the OPTIONAL 1-based ``source_line`` the record carries when
        the finding is attributable — the ``line=`` key is OMITTED ENTIRELY
        (never emitted as ``line=0``) when ``source_line`` is absent, mirroring
        :func:`build_gitlab` omitting ``location.lines``;
      * ``title=`` = the rule id;
      * the message body = the violation message (falling back to the catalog
        ``title`` then the rule id).

    Message and property values are escaped with :func:`_github_escape_data` /
    :func:`_github_escape_property` — NOT XML escaping — so a ``%`` or a newline
    in a message cannot corrupt the line protocol.

    Emission scope differs deliberately from :func:`build_gitlab`: GitHub
    annotations are a developer-visible surface, so advisory ``information``
    findings ARE surfaced (as ``::warning``), not dropped. This never changes the
    exit code — only ``fatal`` findings do, and a conformant invoice still exits
    0. When there is nothing to annotate at all, a single ``#`` log-comment line
    is emitted (a true no-op to the runner — it is not a ``::`` command and
    creates no annotation) so the surface is well-shaped and non-empty like the
    other formats.

    A not-well-formed input (``report`` has an ``error``) yields a single
    ``::error`` command for the parse error, mirroring the SARIF/GitLab
    not-well-formed contract.

    :param report: a dict as returned by :func:`build_report`.
    :returns: a ``str`` of newline-terminated workflow-command lines.
    """
    source = report.get("source") or ""
    lines = []

    if report.get("error"):
        # Not-well-formed XML: one ``::error`` for the parse error, the GitHub
        # analogue of the SARIF single-error result / GitLab parse entry.
        code = report["error"]
        props = ["file=" + _github_escape_property(source),
                 "title=" + _github_escape_property(code)]
        message = report.get("message", "") or code
        lines.append("::error " + ",".join(props) + "::"
                     + _github_escape_data(message))
        return "".join(line + "\n" for line in lines)

    for v in report.get("violations", []):
        rule_id = v.get("rule") or ""
        severity = v.get("severity") or "fatal"
        title = v.get("title")
        field = v.get("field")
        location_hint = v.get("location")
        # file= is a FILE path: the validated invoice. Fall back to the element
        # field / catalog location hint only if the source is missing.
        path = source or field or location_hint or ""
        source_line = v.get("source_line")

        props = ["file=" + _github_escape_property(path)]
        # Attach the 1-based line ONLY when the finding is attributed to a source
        # position; omit the ``line=`` key entirely otherwise (never ``line=0``).
        if source_line is not None:
            props.append("line=" + str(source_line))
        props.append("title=" + _github_escape_property(rule_id))
        message = v.get("message") or title or rule_id
        lines.append("::%s %s::%s" % (_github_level(severity),
                                      ",".join(props),
                                      _github_escape_data(message)))

    if not lines:
        # Nothing to annotate. Emit a plain log comment (NOT a ``::`` command, so
        # the runner creates no annotation) to keep the surface non-empty and
        # well-shaped, the GitHub analogue of GitLab's empty ``[]`` result.
        lines.append("# einvoice: %s is conformant with EN 16931 — no "
                     "annotations" % (source or "input"))

    return "".join(line + "\n" for line in lines)


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
         "[--profile en16931|xrechnung] "
         "[--format json|junit|sarif|gitlab|github|html|badge|text] "
         "[--pretty] [--recurse] "
         "[--baseline <prev-report.json>] <invoice.xml | directory>\n"
         "   or: python3 -m einvoice.report --explain <RULE-ID>\n"
         "  When the path is a DIRECTORY (or --recurse is given) every invoice "
         "file (*.xml / *.pdf, dotfiles skipped) under it is validated and "
         "wrapped in an aggregate 'einvoice-conformance-batch/v1' document. "
         "Batch mode supports --format json (default), junit and text only "
         "(sarif/html/badge validate a single file); the exit code is 1 if any "
         "file has a fatal violation, else 3 if any file errored, else 0 (an "
         "empty directory is a clear file_count:0 result, exit 0).\n"
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

    recurse = False
    if "--recurse" in args:
        recurse = True
        args = [a for a in args if a != "--recurse"]

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

    if fmt not in ("json", "junit", "sarif", "gitlab", "github", "html",
                   "badge", "text"):
        sys.stderr.write(
            "error: unknown format %r (choose from json, junit, sarif, gitlab, "
            "github, html, badge, text)\n%s\n" % (fmt, USAGE))
        return EXIT_FAIL

    if profile not in PROFILES:
        sys.stderr.write("error: unknown profile %r (choose from %s)\n%s\n"
                         % (profile, ", ".join(PROFILES), USAGE))
        return EXIT_FAIL

    if baseline_path is not None and fmt in ("junit", "sarif", "gitlab",
                                             "github", "html", "badge", "text"):
        sys.stderr.write(
            "error: --baseline emits a diff document and is not compatible "
            "with --format %s\n%s\n" % (fmt, USAGE))
        return EXIT_FAIL

    if len(args) != 1:
        sys.stderr.write(USAGE + "\n")
        return EXIT_FAIL

    path = args[0]

    # --------------------------------------------------------------------- #
    # Directory / batch mode: a directory positional (or an explicit
    # --recurse) validates every invoice file under it via the SAME
    # build_report, wrapped in the einvoice-conformance-batch/v1 document.
    # This must be decided BEFORE the single-file isfile() check below so the
    # single-file path is completely unchanged.
    # --------------------------------------------------------------------- #
    if recurse or os.path.isdir(path):
        if not os.path.isdir(path):
            sys.stderr.write(
                "error: --recurse requires a directory: %s\n" % path)
            return EXIT_FAIL
        if baseline_path is not None:
            sys.stderr.write(
                "error: --baseline validates a single file; it is not "
                "compatible with a directory input\n%s\n" % USAGE)
            return EXIT_FAIL
        if fmt not in ("json", "junit", "text"):
            sys.stderr.write(
                "error: --format %s validates a single file; use "
                "json/junit/text for a directory\n" % fmt)
            return EXIT_FAIL
        batch = build_batch_report(path, profile=profile)
        if fmt == "junit":
            sys.stdout.write(build_junit_batch(batch))
        elif fmt == "text":
            sys.stdout.write(build_batch_text(batch))
        elif pretty:
            sys.stdout.write(json.dumps(batch, indent=2, sort_keys=True) + "\n")
        else:
            sys.stdout.write(json.dumps(batch, separators=(",", ":")) + "\n")
        return batch_exit_code(batch)

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
        if diff.get("error"):
            return EXIT_PARSE
        return EXIT_OK if diff["new_fatal_count"] == 0 else EXIT_FAIL

    report = build_report(path, profile=profile)
    if fmt == "junit":
        sys.stdout.write(build_junit(report))
    elif fmt == "sarif":
        sys.stdout.write(
            json.dumps(build_sarif(report), indent=2, sort_keys=True) + "\n")
    elif fmt == "gitlab":
        sys.stdout.write(
            json.dumps(build_gitlab(report), indent=2, sort_keys=True) + "\n")
    elif fmt == "github":
        sys.stdout.write(build_github(report))
    elif fmt == "html":
        sys.stdout.write(build_html(report))
    elif fmt == "badge":
        sys.stdout.write(
            json.dumps(build_badge(report), indent=2, sort_keys=True) + "\n")
    elif fmt == "text":
        sys.stdout.write(build_text(report))
    elif pretty:
        sys.stdout.write(json.dumps(report, indent=2, sort_keys=True) + "\n")
    else:
        sys.stdout.write(json.dumps(report, separators=(",", ":")) + "\n")

    # Any error field (not-well-formed XML, or an unsupported PDF container) is
    # a non-pass: exit non-zero, never 0. EXIT_PARSE reflects "could not reduce
    # the input to a validatable invoice".
    if report.get("error"):
        return EXIT_PARSE
    # A FATAL syntax-binding finding blocks validity exactly like a fatal
    # business-rule violation; warning-severity syntax-binding findings never
    # change the exit code (they mirror the official warning flag).
    total_fatal = (report["fatal_count"]
                   + report.get("syntax_binding_fatal_count", 0))
    return EXIT_OK if total_fatal == 0 else EXIT_FAIL


if __name__ == "__main__":
    sys.exit(main())

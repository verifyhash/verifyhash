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
    baseline_profile         (additive, only when the baseline DECLARES a
                             ``profile``) the profile it was captured under
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
stderr message and a nonzero exit — never a traceback. So is a baseline that
DECLARES a ``profile`` different from the one this run validates with: the two
profiles are different rule sets (``xrechnung`` is ``en16931`` plus the BR-DE-*
layer), so diffing across them scores a flag change as a regression. That is
refused before any diff is computed (see :func:`check_baseline_profile`). A
baseline declaring no ``profile`` at all — the shape ``einvoice validate
--json`` writes — still diffs unchanged, with one ``note:`` line on stderr
saying the profile could not be checked.

Standard library only. No network.
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import sys
from collections import Counter
from xml.sax.saxutils import escape, quoteattr

from xml.etree import ElementTree as ET

from .validate import validate_file, validate_root, PROFILES, _severity
from .parser import NotWellFormed, parse_file
from ._xmlsec import _safe_fromstring
from .remediation import load_catalog, resolve_message, SUPPORTED_LANGS
from . import remediation as _remediation
from . import pdf_container
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

#: Every ``--format`` name the report CLI accepts (including the default
#: human ``text`` form). This is the single source of truth for the format
#: vocabulary: the ``--format`` validation below iterates it, and
#: ``einvoice info`` derives its ``formats`` field from it — so a new emitter
#: only ever has to be registered here.
REPORT_FORMATS = ("json", "junit", "sarif", "gitlab", "github", "azure",
                  "html", "badge", "text")

#: The subset of :data:`REPORT_FORMATS` that has a defined AGGREGATE shape, i.e.
#: can describe a whole directory/batch rather than one invoice: the
#: ``einvoice-conformance-batch/v1`` JSON document, a JUnit ``<testsuites>`` with
#: one suite per file, and the human per-file text summary. The other six
#: emitters are single-invoice by construction (one SARIF ``run`` with one
#: artifact, one Code-Quality array, one HTML page, one badge), so a directory
#: input under those is refused with an actionable error rather than given an
#: invented shape. Named here so the two places that enforce it — this module's
#: directory leg and ``einvoice.cli``'s ``validate-batch --format`` — read ONE
#: list instead of retyping the tuple.
BATCH_FORMATS = ("json", "junit", "text")

#: LANGUAGE NEUTRALITY, AS A DECISION RATHER THAN AN ACCIDENT (T-VHRPTH.4).
#:
#: These seven emitters are MACHINE-facing documents and are pinned here as
#: language-neutral BY DESIGN: their consumers (a CI annotation parser, a SARIF
#: viewer, a JUnit reporter, a shields.io endpoint, a Code-Quality importer)
#: key on the stable RULE ID, the severity and the counts, not on the human
#: sentence — :func:`_sarif_fingerprint` and :func:`_gitlab_fingerprint`
#: deliberately hash the rule id and the LOCATION and leave the message out,
#: precisely because the sentence is not part of a finding's identity. The
#: ``json`` document goes further and is DIFFED across runs: ``--baseline``
#: keys a violation on :data:`DIFF_KEY`, which DOES include ``message``, so a
#: localised json report would not read as a translated report — diffed against
#: a baseline captured under another locale it would score every finding as
#: resolved-plus-new and fail the build on a language change. So
#: :func:`render_report` renders
#: every format named here with ``lang="en"`` regardless of what the caller
#: asked for, and the bytes are identical with and without ``--lang de``
#: (pinned by ``test_lang.py``).
#:
#: This is NOT a third independent list of per-surface decisions: the REASONED
#: per-entry-point flag matrix lives in ONE place, ``einvoice.cli``'s
#: ``ENTRY_POINT_CAPABILITIES`` (row ``lang``), and this tuple is the
#: format-level mechanism that row describes. Adding an emitter to
#: :data:`REPORT_FORMATS` forces a choice: name it here, or it lands in
#: :data:`LOCALISED_FORMATS` below and MUST accept a ``lang`` — there is no
#: third state in which a language flag can be swallowed without effect.
LANGUAGE_NEUTRAL_FORMATS = ("json", "junit", "sarif", "gitlab", "github",
                            "azure", "badge")

#: The complement of :data:`LANGUAGE_NEUTRAL_FORMATS` over
#: :data:`REPORT_FORMATS` — the HUMAN-facing surfaces, the ones a person reads
#: and a German company forwards to its accountant, and therefore the only ones
#: ``--lang`` may change. DERIVED, not retyped, so the two tuples cannot drift
#: into overlapping or into leaving a format unclassified; ``test_lang.py``
#: pins the partition to exactly ``("html", "text")``.
LOCALISED_FORMATS = tuple(f for f in REPORT_FORMATS
                          if f not in LANGUAGE_NEUTRAL_FORMATS)

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
        # --- Additive alias field (v1, non-breaking, added in 0.2.7). The SAME
        # datum `field` carries, under the name `einvoice validate --json` has
        # always used for it, so ONE consumer parser reads either surface
        # (including the per-file entries of `validate-batch --json`, which are
        # these very records). Not a rename: both keys are emitted and are
        # always equal.
        "element": "the offending element / path (Violation.element) — the "
                   "same value as 'field', under the name `einvoice validate "
                   "--json` uses. Always present, always equal to 'field'; "
                   "null when unknown.",
        "source_line": "OPTIONAL, additive: the 1-based parser line of the "
                       "offending element in the source document. Present ONLY "
                       "for an attributable field-level violation (a rule that "
                       "held the concrete Element); ABSENT when the finding is "
                       "not attributable to a source position (an "
                       "absence/document-level rule). Distinct from the "
                       "catalog XML-path hint 'location'.",
        "insertion_point_line": "OPTIONAL, additive: the 1-based parser line "
                                "of the DEEPEST element of the finding's path "
                                "that the document actually contains — i.e. "
                                "WHERE THE MISSING THING SHOULD GO. It is NOT "
                                "the site of an error: nothing on that line is "
                                "wrong. Present only for an absence finding "
                                "whose path anchors unambiguously; mutually "
                                "exclusive with 'source_line' (a finding never "
                                "carries both), and absent — never 0, never "
                                "the document root — when nothing resolves.",
    },
    "exit_codes": {
        "0": "no fatal violations (valid).",
        "1": "at least one fatal violation.",
        "3": "input not well-formed XML (report has error, valid=false).",
    },
}

#: The exact key set every violation record carries (tests assert on this).
#: The original four identity keys come first and are unchanged for backward
#: compatibility; the next four are the additive, catalog-relayed remediation
#: fields; `element` is the additive 0.2.7 alias of `field` (same value, the
#: name `einvoice validate --json` uses) and is APPENDED last so the leading
#: positions every consumer already relies on do not move. See :func:`_record`
#: and REPORT_SCHEMA['violation_record'].
VIOLATION_KEYS = ("rule", "severity", "message", "field",
                  "title", "fix_hint", "terms", "location",
                  "element")


def _remediation_catalog():
    """Return the cached remediation catalog mapping (loaded at most once).

    A thin alias of :func:`einvoice.remediation.cached_catalog`, kept as the
    report's own name because this module calls it in a dozen places. The cache
    (and the degrade-to-``{}`` discipline for a catalog-less installation) now
    lives ONCE in :mod:`einvoice.remediation`, so ``validate --json`` and the
    report share a single parse of the JSON instead of one each.
    """
    return _remediation.cached_catalog()


def _record(v, catalog=None):
    """Map one Violation into a stable report record enriched with remediation.

    The four identity fields (rule/severity/message/field) are taken verbatim
    from the Violation. The four remediation fields (title/fix_hint/terms/
    location) are RELAYED — through the shared
    :func:`einvoice.remediation.remediation_fields` helper that
    ``validate.Result._violation_dict`` also calls — from the committed
    remediation catalog entry for this rule id. This function authors none of
    that wording. A rule id with no catalog entry degrades gracefully to
    null/empty fields (never a KeyError).

    A ninth key, ``element``, is emitted unconditionally (0.2.7): it is the
    SAME ``Violation.element`` value ``field`` carries, under the name
    ``einvoice validate --json`` uses, so one consumer parser reads either
    surface. Both keys are always present and always equal — no rename, no
    removal, no new datum.

    :param catalog: optional pre-loaded catalog mapping (build_report passes it
        once for the whole result); when omitted, the cached module catalog is
        used so a lone ``_record(v)`` call still enriches.
    """
    record = {
        "rule": v.rule_id,
        "severity": _severity(v),
        "message": v.message,
        "field": v.element,
    }
    record.update(_remediation.remediation_fields(v.rule_id, catalog))
    # Additive, UNCONDITIONAL (0.2.7): `element` — the very same datum `field`
    # already carries, emitted under the name `einvoice validate --json` has
    # always used (validate.Result._violation_dict emits both too). This is not
    # a rename and not a second datum: both keys are always present and always
    # equal, so ONE consumer parser reads either surface. It matters most for
    # `validate-batch --json`, whose per-file violation records ARE these
    # records; before this the batch surface silently lacked a key the
    # single-file CLI surface had. Appended after the remediation fields so no
    # existing key changes position.
    record["element"] = v.element
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
    # Additive, OPTIONAL, and MUTUALLY EXCLUSIVE with `source_line`: the 1-based
    # line of the deepest element of the finding's path that the document
    # actually contains — the INSERTION POINT for what is missing, not a place
    # where anything is wrong. Stamped once by
    # einvoice.validate._stamp_insertion_points, which carries nothing rather
    # than guessing (no root fallback, no 0, no ambiguous repeated parent).
    # Emitted here in exactly the same present-only-when-known form as
    # validate.Result._violation_dict, so the two JSON surfaces cannot diverge
    # (test_json_surface_parity.py measures that). Appended last: a consumer
    # that ignores it reads a byte-identical record.
    insertion_point_line = getattr(v, "insertion_point_line", None)
    if insertion_point_line is not None:
        record["insertion_point_line"] = insertion_point_line
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

    Used by the PDF-container path and by :func:`einvoice.validate_bytes`. The
    root dispatch lives in :func:`~einvoice.validate.validate_root` — ONE seam
    shared with the raw-XML CLI, ``build_report`` and ``build_receipt`` — so a
    UN/CEFACT ``CrossIndustryInvoice`` (Factur-X / ZUGFeRD / CII XRechnung) is
    graded by the CII engine (``parser_cii.build_model`` + the syntax-agnostic
    ``rules.ALL_RULES`` core rules + ``rules_xrechnung.evaluate_cii`` for the
    German CIUS layer) and a UBL ``Invoice``/``CreditNote`` by the UBL engine,
    with any other root falling out as the same structural ``S-ROOT`` fatal the
    XML path emits. This RE-IMPLEMENTS no rule logic; it only feeds the
    extracted bytes into the shipped engines.

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

    # ONE dispatch for every surface (see validate.validate_root): CII through
    # the CII engine, UBL through the UBL engine, anything else -> S-ROOT.
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


#: How many rule ids ONE capped human batch listing may name before it
#: truncates. Used by BOTH human listings ``build_batch_text`` renders (the
#: per-file findings and the 'most violated rules' aggregate) so there is a
#: single budget and a single truncation sentence, never a second convention.
#:
#: WHY 11 AND NOT 10. This is the batch twin of the single-file human cap
#: ``einvoice.cli._NON_FATAL_LIST_CAP`` (= 10), and it is deliberately ONE MORE,
#: because the two surfaces count differently and the READER should see the same
#: number of rule ids either way: the single-file report renders its headline
#: finding in full (rule id, message, offending element, fix hint, rule page)
#: and then lists ``_NON_FATAL_LIST_CAP`` FURTHER findings — 1 + 10 = 11 rule ids
#: on screen before it says "... N more not shown". A batch file line carries
#: counts, not a headline rule, so this listing names 11 directly.
#:
#: ``report.py`` must NOT import ``einvoice.cli`` (cli imports report; that would
#: be an import cycle), so the relationship is documented here rather than
#: computed — and it is PINNED by test_finding_set_parity.py, which reads the
#: CLI's cap out of the installed module and requires a truncated batch listing
#: to name exactly ``cap + 1`` ids with the single-file disclosure wording.
_BATCH_RULE_LIST_CAP = 11

#: Ordering rank for the human batch listings: what blocks conformance first.
#: Anything unknown sorts after the three documented severities rather than
#: raising, so a future severity degrades to "listed last", never to a crash.
_BATCH_SEVERITY_RANK = {"fatal": 0, "warning": 1, "information": 2}


def _position_suffix(source, source_line):
    """The ONE ``file:line`` fragment every HUMAN surface appends to a finding.

    MEASURED defect this closes (T-VHLOC.3, 2026-07-26): the engine has stamped
    ``source_line`` on attributable findings since T-VHDIAG.1, and ``json``,
    ``sarif`` (``region.startLine``), ``github`` (``line=``), ``azure``
    (``linenumber=``) and ``gitlab`` (``location.lines.begin``) all render it —
    but the two surfaces a PERSON reads, the text report and the JUnit
    ``<failure>`` body, dropped it. They handed over an XPath, which is a
    structural address: it tells an ERP developer WHICH element is wrong and
    gives their editor nothing to jump to. ``file:line`` is the shape every
    terminal and editor already linkifies (it is the gcc/pytest convention), so
    it is the one used here.

    HONESTY RULE (the same one ``test_report_location.py`` already proves for
    the machine surfaces, not a second convention): a position is emitted ONLY
    when the record really carries a usable 1-based line. No placeholder, no
    ``:0``, no ``:1`` fallback — a finding without a line reads EXACTLY as it
    did before, because an invented line number is worse than none (it sends
    the reader to the wrong element and quietly discredits the tool).

    ``source_line`` is validated here rather than trusted: the same bool/int
    ``>= 1`` check :func:`build_sarif` applies, so a hand-edited or
    third-party report dict carrying ``true`` or ``0`` degrades to "no
    position" instead of printing nonsense.

    :param source: the document path the finding belongs to (``report['source']``
        / the CLI's display path). Falsy -> the bare ``line N`` form, because
        ``:8`` on its own is not a jumpable address and inventing a filename
        would be a fabrication.
    :param source_line: the record's optional ``source_line``.
    :returns: ``" at <source>:<line>"``, ``" at line <line>"``, or ``""``.
    """
    if (not isinstance(source_line, int) or isinstance(source_line, bool)
            or source_line < 1):
        return ""
    if not source:
        return " at line %d" % source_line
    return " at %s:%d" % (source, source_line)


def _insertion_point_suffix(source, insertion_point_line):
    """The ``insertion point`` fragment every HUMAN surface appends to an
    ABSENCE finding — the sibling of :func:`_position_suffix`, never a mode of
    it.

    MEASURED defect this closes (T-VHLOC.6, 2026-07-26): the engine has stamped
    ``insertion_point_line`` on anchorable absence findings since T-VHLOC.4, and
    the two JSON surfaces carry it — but on the ONE example our own onboarding
    docs tell a stranger to run,
    ``examples/01-missing-fields/broken.xml``, EVERY surface a person reads
    (text report, batch listing, JUnit ``<failure>`` body) said only "BG-6 is
    missing" and left them to find the spot in a 60-line invoice by hand. The
    field existed; the payoff did not.

    THE HONESTY RULE, AND WHY IT NEEDS ITS OWN WORDING. An insertion point is
    where the missing thing GOES; nothing on that line is wrong. Rendering it
    through :func:`_position_suffix` would print ``at broken.xml:28`` — which
    every reader (and every editor jumping there) reads as "the error is on line
    28", pointing at an innocent ``<cac:Party>``. So the token is deliberately
    a DIFFERENT shape and carries the word "insertion" literally:

        BR-DE-2: The group 'SELLER CONTACT' (BG-6) must be transmitted.
          (insertion point examples/01-missing-fields/broken.xml:28)

    The vocabulary is the one the engine already uses
    (``einvoice.validate._insertion_point_line`` / ``_stamp_insertion_points``),
    not a third term. ``test_report_location.py`` pins the substring
    "insertion", so the distinction is mechanically checkable and cannot be
    quietly collapsed back into the ``at file:line`` shape.

    PRECEDENCE. ``source_line`` and ``insertion_point_line`` are documented
    mutually exclusive (see :data:`REPORT_SCHEMA`) and the engine never stamps
    both. A hand-edited or third-party report dict that carries both is not a
    crash: every call site asks for ``_position_suffix(...) or
    _insertion_point_suffix(...)``, so a proven error site always wins over a
    guessed-at destination.

    ``insertion_point_line`` is validated here rather than trusted — the same
    bool/int ``>= 1`` check :func:`_position_suffix` and :func:`build_sarif`
    apply — so ``true``, ``0`` or a string degrades to "no position" instead of
    printing nonsense. No placeholder, no ``:0``, no ``:1`` fallback: a finding
    without an anchor reads EXACTLY as it did before.

    :param source: the document path the finding belongs to. Falsy -> the bare
        ``insertion point line N`` form, for the same reason
        :func:`_position_suffix` degrades that way.
    :param insertion_point_line: the record's optional ``insertion_point_line``.
    :returns: ``" (insertion point <source>:<line>)"``,
        ``" (insertion point line <line>)"``, or ``""``.
    """
    if (not isinstance(insertion_point_line, int)
            or isinstance(insertion_point_line, bool)
            or insertion_point_line < 1):
        return ""
    if not source:
        return " (insertion point line %d)" % insertion_point_line
    return " (insertion point %s:%d)" % (source, insertion_point_line)


def _rule_sort_key(rule_id):
    """Natural sort key for a rule id, so BR-DE-2 sorts BEFORE BR-DE-15.

    Plain lexicographic ordering puts 'BR-DE-15' before 'BR-DE-2', which reads
    as a bug in a printed list. Splitting on digit runs and comparing the
    numeric runs as integers fixes that. Every element is an ``(int, str)``
    pair — numeric runs are ``(n, "")`` and literal runs ``(-1, text)`` — so the
    tuples always compare against each other without a type error.
    """
    parts = re.split(r"(\d+)", rule_id)
    return tuple((int(p), "") if p.isdigit() else (-1, p)
                 for p in parts if p != "")


def _batch_finding_sort_key(v):
    """Deterministic order for one file's findings: fatals first, then rule id."""
    return (_BATCH_SEVERITY_RANK.get(v.get("severity", ""),
                                     len(_BATCH_SEVERITY_RANK)),
            _rule_sort_key(v.get("rule", "")),
            v.get("rule", ""))


def _batch_truncation_sentence(omitted, total):
    """The ONE truncation wording every capped listing in this module uses.

    Byte-identical to the single-file report's (einvoice/cli.py, PASS and FAIL
    paths alike): say how many entries were hidden, and name the format that
    carries all of them. ``total`` is the FULL population, not the hidden
    remainder, so the number agrees with the count printed above the listing.
    ``--format json`` is a real batch format (``BATCH_FORMATS``), so the advice
    is executable on a directory, not just on a single file.
    """
    return ("... %d more not shown — use --format json for all %d"
            % (omitted, total))


def _batch_file_finding_lines(report):
    """The indented finding block under ONE file's status line.

    Same shape as the single-file human report after T-VHFULL.1: an explicit
    "N finding(s) total" line, then one ``[severity] RULE-ID: message`` line per
    finding up to :data:`_BATCH_RULE_LIST_CAP`, then the honest truncation
    sentence. A file with no findings gets no block at all (a clean PASS stays
    the one line it has always been); a file that PASSED but carries advisory
    findings DOES get one — examples/01-missing-fields/fixed.xml is conformant
    yet still reports BR-DE-TMP-32, and hiding that was half the reason the
    batch summary was unusable for triage.
    """
    violations = report.get("violations") or []
    if not violations:
        return []
    total = len(violations)
    fatal = sum(1 for v in violations if v.get("severity") == "fatal")
    lines = ["  %d finding(s) total: %d fatal, %d non-fatal "
             "(--format json carries every field of each)"
             % (total, fatal, total - fatal)]
    ordered = sorted(violations, key=_batch_finding_sort_key)
    src = report.get("source", "")
    for v in ordered[:_BATCH_RULE_LIST_CAP]:
        # ``file:line`` when this finding is attributable, the distinctly
        # labelled insertion point when it is an anchorable ABSENCE instead
        # (T-VHLOC.6), nothing at all otherwise (T-VHLOC.3) — one convention,
        # see :func:`_position_suffix` / :func:`_insertion_point_suffix`. A
        # proven error site wins if a hand-edited record claims both.
        lines.append("    [%s] %s: %s%s"
                     % (v.get("severity", ""), v.get("rule", ""),
                        v.get("message", ""),
                        _position_suffix(src, v.get("source_line"))
                        or _insertion_point_suffix(
                            src, v.get("insertion_point_line"))))
    if total > _BATCH_RULE_LIST_CAP:
        lines.append("    " + _batch_truncation_sentence(
            total - _BATCH_RULE_LIST_CAP, total))
    return lines


def _batch_rule_frequency(batch):
    """``(ordered_rule_ids, files_per_rule)`` across the whole batch.

    The question a person pointing this at a directory of ERP exports is
    actually asking is "which rule is breaking my export?", so rules are counted
    by HOW MANY FILES they hit (a rule that fires twice in one invoice is one
    broken file, not two). Order: most files first, then fatal before warning
    before information, then natural rule id — fully deterministic, and for a
    single-file batch identical to that file's own listing order, so the two
    sections never disagree about which rules they showed.
    """
    files_per_rule = {}
    rank_of_rule = {}
    for r in batch.get("files", []):
        seen = set()
        for v in r.get("violations") or []:
            rid = v.get("rule", "")
            rank = _BATCH_SEVERITY_RANK.get(v.get("severity", ""),
                                            len(_BATCH_SEVERITY_RANK))
            rank_of_rule[rid] = min(rank_of_rule.get(rid, rank), rank)
            if rid not in seen:
                seen.add(rid)
                files_per_rule[rid] = files_per_rule.get(rid, 0) + 1
    ordered = sorted(files_per_rule,
                     key=lambda rid: (-files_per_rule[rid], rank_of_rule[rid],
                                      _rule_sort_key(rid), rid))
    return ordered, files_per_rule


def _batch_aggregate_lines(ordered, files_per_rule):
    """The 'most violated rules' block: rule id + how many files it broke."""
    if not ordered:
        return []
    shown = ordered[:_BATCH_RULE_LIST_CAP]
    width = max(len(rid) for rid in shown)
    lines = ["", "Most violated rules (rule id, files affected):"]
    for rid in shown:
        n = files_per_rule[rid]
        lines.append("  %-*s  %d file%s"
                     % (width, rid, n, "" if n == 1 else "s"))
    if len(ordered) > _BATCH_RULE_LIST_CAP:
        lines.append("  " + _batch_truncation_sentence(
            len(ordered) - _BATCH_RULE_LIST_CAP, len(ordered)))
    return lines


def _batch_explain_hint(ordered, rank_lookup):
    """The ONE ``einvoice --explain <RULE-ID>`` line for the whole run, or None.

    The id is always taken from a rule THIS run actually violated — never a
    hard-coded example — and always from a rule the output just printed, so the
    reader can see where it came from. Choice: the first FATAL among the shown
    rules (i.e. most files affected, ties broken by rule id), falling back to
    the most-affecting rule of any severity when the shown block holds no fatal.
    """
    shown = ordered[:_BATCH_RULE_LIST_CAP]
    if not shown:
        return None
    for rid in shown:
        if rank_lookup(rid) == "fatal":
            return rid
    return shown[0]


def build_batch_text(batch):
    """Render a batch report as a concise, human-readable text summary.

    Per file: a status line (``PASS`` / ``FAIL`` / ``ERROR``) and, when that
    file has findings, the rule ids behind its counts (capped by
    :data:`_BATCH_RULE_LIST_CAP`, with an honest truncation sentence). Then the
    aggregate tally line, a 'most violated rules' block, and ONE
    ``einvoice --explain <RULE-ID>`` line naming a rule this run really
    violated. An empty directory prints a single 'no invoice files found' line.

    Pure projection of the batch dict — no rule logic, no re-aggregation of
    anything the batch engine did not already compute.

    MEASURED defect this closes (T-VHUX2.4, 2026-07-25): over
    ``examples/01-missing-fields`` this printed
    ``FAIL  broken.xml  2 fatal, 0 warning`` and named ZERO rule ids, while the
    very dict it was handed already carried BR-DE-2, BR-DE-15 and
    BR-DE-TMP-32. A directory of exported invoices is exactly how an ERP
    developer evaluates a validator, and this was the only command at that
    scale — so every remediation asset the product has (``--explain``, the fix
    hints, the 297 rule pages) was unreachable from it and the only route to a
    rule id was re-running the tool file by file.

    Unchanged on purpose: the ERROR line form, the 'no invoice files found'
    line, the totals line and its position at the end of the tally, and the
    fact that ``--quiet`` renders none of this (the CLI simply does not call
    here). Every line added by this function is either indented or a labelled
    block after the totals line, so ``grep '^FAIL'`` / ``grep '^PASS'`` over a
    batch keeps meaning "one match per file".
    """
    root = batch.get("root", "")
    file_count = batch.get("file_count", 0)
    if file_count == 0:
        return "einvoice batch: no invoice files found under %s\n" % root

    lines = []
    for r in batch.get("files", []):
        src = r.get("source", "")
        if r.get("error"):
            # An errored file was never parsed, so it has no findings to name;
            # its line form is contractual and stays exactly as it was.
            lines.append("ERROR %s  %s" % (src, r.get("error")))
            continue
        if r.get("fatal_count", 0) > 0:
            lines.append("FAIL  %s  %d fatal, %d warning"
                         % (src, r.get("fatal_count", 0),
                            r.get("warning_count", 0)))
        else:
            wc = r.get("warning_count", 0)
            tail = (" (%d warning%s)" % (wc, "" if wc == 1 else "s")
                    if wc else "")
            lines.append("PASS  %s  conformant%s" % (src, tail))
        lines.extend(_batch_file_finding_lines(r))

    failed = batch.get("failed_file_count", 0)
    passed = file_count - failed
    lines.append("")
    lines.append(
        "%d file%s: %d passed, %d failed  "
        "(%d fatal, %d warning across all files)"
        % (file_count, "" if file_count == 1 else "s", passed, failed,
           batch.get("fatal_count", 0), batch.get("warning_count", 0)))

    ordered, files_per_rule = _batch_rule_frequency(batch)
    lines.extend(_batch_aggregate_lines(ordered, files_per_rule))

    severity_of = {}
    for r in batch.get("files", []):
        for v in r.get("violations") or []:
            rid = v.get("rule", "")
            sev = v.get("severity", "")
            if rid not in severity_of or sev == "fatal":
                severity_of[rid] = sev
    hint = _batch_explain_hint(ordered, lambda rid: severity_of.get(rid, ""))
    if hint:
        lines.append("")
        lines.append("Explain any rule above: einvoice --explain %s" % hint)
    return "\n".join(lines) + "\n"


def build_text(report, lang="en"):
    """Render a SINGLE-file report as a concise text summary (additive format).

    A status header (``PASS`` / ``FAIL`` / ``ERROR``) followed by one indented
    line per violation. Pure projection — no rule logic. This is a new,
    additive format: it never affects the default JSON bytes.

    ``lang`` (keyword-defaulted, so every existing one-argument call is
    unchanged to the byte) selects the language of the per-violation MESSAGE
    only, through the same ``einvoice.remediation.resolve_message`` the HTML
    report and ``einvoice validate``'s human summary use: the official KoSIT
    German assert where the rule carries one, the English message otherwise.
    The status tokens (``PASS``/``FAIL``/``ERROR``), rule ids, severities,
    fields and positions are language-independent facts and never move — this
    is a terse machine-greppable summary line, so it gets no translated chrome.
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
    catalog = _remediation_catalog()
    for v in report.get("violations", []):
        field = v.get("field")
        # The XPath says WHICH element; the position says WHERE it is — either
        # the proven error site (``at file:line``, T-VHLOC.3) or, for an
        # anchorable absence, the distinctly worded insertion point where the
        # missing thing GOES (T-VHLOC.6). A finding the engine could not place
        # at all keeps its historic bytes exactly.
        lines.append("  [%s] %s: %s%s%s" % (
            v.get("severity", ""), v.get("rule", ""),
            resolve_message(v.get("rule", ""), v.get("message", ""), lang,
                            catalog=catalog),
            " (%s)" % field if field else "",
            _position_suffix(src, v.get("source_line"))
            or _insertion_point_suffix(src, v.get("insertion_point_line"))))
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


#: Emitted on stderr (ONE line) when a loaded baseline declares no ``profile``
#: — the shape ``einvoice validate --json`` has always produced, and every
#: baseline captured before the check below existed. The diff still runs and
#: the document is unchanged; what this line buys is that SILENCE never means
#: "checked". ``%s`` args: the baseline path, then the profile the run used.
BASELINE_PROFILE_UNCHECKED = (
    "note: baseline %s declares no 'profile', so it could not be checked "
    "against the profile this run validates with (%s) — a baseline captured "
    "under a different --profile diffs two different rule sets\n")


def declared_baseline_profile(baseline):
    """The profile a loaded baseline DECLARES, or ``None`` if it declares none.

    ``python3 -m einvoice.report --format json`` records ``profile`` in every
    report it writes; the console script's ``einvoice validate --json`` shape
    historically does not. A non-string or empty value counts as "undeclared"
    rather than as a mismatch — an unrecognisable field is not evidence that
    the baseline came from a different rule set.
    """
    declared = baseline.get("profile")
    return declared if isinstance(declared, str) and declared else None


def check_baseline_profile(baseline, profile, baseline_path):
    """Enforce the precondition a baseline diff has always silently assumed:
    the baseline was captured under the SAME ``--profile`` the run gates with.

    The two profiles are different RULE SETS (``xrechnung`` is ``en16931``
    plus the BR-DE-* layer), so diffing across them reports every rule that
    exists in only one of them as a change in the invoice. It is not — the
    operator changed a flag. MEASURED (2026-07-29, T-VHGATE.7): an ``en16931``
    baseline gated with ``--profile xrechnung`` produced ``new_violations``
    naming ``BR-DE-2`` and friends and a red build, on an invoice byte for
    byte unchanged.

    :returns: the declared profile when the baseline declares one and it
        matches ``profile`` (so callers can record it as ``baseline_profile``),
        or ``None`` when the baseline declares none — the legacy shape, which
        still diffs, uncheckably (see :data:`BASELINE_PROFILE_UNCHECKED`).
    :raises BaselineError: naming BOTH profiles, when the baseline declares a
        profile that differs. Raised through the SAME exception the four other
        baseline refusals use, so it reaches the user in the same voice, on
        the same stream, and — on the ``einvoice validate`` console script —
        through the same "no document written" seam that makes it exit 2.
    """
    declared = declared_baseline_profile(baseline)
    if declared is not None and declared != profile:
        raise BaselineError(
            "baseline %s was captured under profile %r but this run validates "
            "with profile %r; those are different rule sets, so the diff would "
            "grade a flag change as a regression — re-capture the baseline "
            "with --profile %s, or gate with --profile %s"
            % (baseline_path, declared, profile, profile, declared))
    return declared


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
    # ADDITIVE on the same einvoice-conformance-diff/v1 id (exactly the way
    # `element` was added to the report v1 id — REPORT-SCHEMA.md): present only
    # when the baseline declares its profile, so a legacy baseline's document
    # stays byte-identical. A DIFFERING declared profile never reaches here —
    # check_baseline_profile refuses it before any diff is computed.
    declared = declared_baseline_profile(baseline)
    if declared is not None:
        head["baseline_profile"] = declared

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
        "baseline_profile": "present ONLY when the baseline document declares "
                            "a 'profile': the profile the baseline was "
                            "captured under. Always equal to 'profile' — a "
                            "baseline declaring a different one is refused "
                            "before any diff is computed.",
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
        src = report.get("source", "")
        for v in violations:
            rule = v.get("rule") or ""
            severity = v.get("severity") or "fatal"
            message = v.get("message") or ""
            field = v.get("field") or ""
            # The <failure> body is what a CI test pane shows a human when the
            # build goes red, so it carries the ``file:line`` position whenever
            # the finding is attributable (T-VHLOC.3) and the distinctly
            # labelled ``(insertion point file:line)`` when it is an anchorable
            # absence (T-VHLOC.6), and is byte-identical to before when it is
            # neither. This is the HUMAN body only — the surrounding testcase
            # attributes and the machine CI formats are untouched, because an
            # annotation anchored to an insertion point would draw a red
            # squiggle on an innocent line.
            position = (_position_suffix(src, v.get("source_line"))
                        or _insertion_point_suffix(
                            src, v.get("insertion_point_line")))
            lines.append(
                "    <testcase name=%s classname=%s>"
                % (quoteattr(rule), classname))
            if severity == "fatal":
                body = "%s: %s" % (severity, field) if field else severity
                body += position
                lines.append(
                    "      <failure message=%s>%s</failure>"
                    % (quoteattr(message), escape(body)))
            else:
                note = "%s: %s" % (severity, message)
                if field:
                    note = "%s (%s)" % (note, field)
                # Same convention on the advisory <system-out> note: a reader
                # triaging a warning needs the position just as much. No rule
                # ships a non-fatal attributable finding TODAY (the three
                # line-bearing code-list rules are all fatal), so this arm is
                # forward-consistency, not a rendered change.
                note += position
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
#: two forms together. It is the ONE origin for every rule-page deep-link the
#: product emits — the SARIF ``reportingDescriptor.helpUri``, the default text
#: report's ``rule page:`` line and the HTML report's rule-id anchor all go
#: through :func:`rule_page_url` below. The historical ``SARIF_`` prefix is kept
#: because ``test_report_sarif.py`` and the published CHANGELOG name it; the
#: constant is format-neutral in fact. No network is ever touched.
SARIF_RULE_HELP_BASE_URL = "https://verifyhash.com/einvoice/rules/"


def rule_page_url(rule_id):
    """Return the canonical public reference-page URL for ``rule_id``.

    THE single URL-building code path for the whole package: base constant +
    id + trailing slash, exactly the shape ``gen_site.py``'s ``_url_rule``
    generates on disk (``https://verifyhash.com/einvoice/rules/BR-DE-2/``).
    Every emitter that deep-links a rule calls this, so the CLI text report,
    the SARIF ``helpUri``, the HTML anchor and the published site are
    structurally incapable of disagreeing.

    The URL is ABSOLUTE on purpose: the HTML artifact is read from a local
    file (a CI download, an email attachment), where a relative link dangles.

    Callers are responsible for the "does a page exist?" gate — see
    :func:`_remediation_catalog`; this function only spells the URL.
    """
    return SARIF_RULE_HELP_BASE_URL + rule_id + "/"

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


#: Characters that may appear LITERALLY in the path part of a URI reference
#: (RFC 3986 ``path-noscheme`` / ``path-absolute``): ``unreserved`` (ALPHA,
#: DIGIT, ``-``, ``.``, ``_``, ``~``), ``sub-delims`` (``!$&'()*+,;=``), plus
#: ``:`` and ``@`` — both are ``pchar`` — and ``/``, the segment separator.
#: EVERY other byte is illegal there and MUST be percent-encoded: the space,
#: ``"``, ``<``, ``>``, ``\``, ``^``, ``` ` ```, ``{``, ``|``, ``}``, ``[``,
#: ``]``, the delimiters ``#`` and ``?`` (they would start a fragment/query),
#: ``%`` itself (so an existing escape is not re-read as one), C0 controls and
#: every non-ASCII byte.
_URI_PATH_SAFE = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "abcdefghijklmnopqrstuvwxyz"
    "0123456789"
    "-._~"          # unreserved
    "!$&'()*+,;="   # sub-delims
    ":@"            # the remaining pchar members
    "/"             # segment separator
)


def _sarif_artifact_uri(source):
    """Turn the caller's argv path into a SARIF ``artifactLocation.uri``.

    The PATH-ECHO RULE (measured, pinned by ``test_path_invariance.py`` and
    documented in REPORT-FORMATS.md "Path echo") says every surface repeats the
    path EXACTLY as it arrived on argv — nothing is absolutized, resolved or
    rewritten — so this helper deliberately calls no ``abspath``/``realpath``/
    ``relpath``. ``report["source"]`` already carries that argv string; the only
    two transformations applied are the ones a *URI* demands:

      1. separator shape — on a platform whose ``os.sep`` is not ``/``
         (Windows) the separators become ``/``, because a SARIF ``uri`` is a
         URI reference, not a native path. On POSIX ``os.sep`` IS ``/``, so a
         literal backslash in a filename is just another character and is
         percent-encoded (``%5C``) rather than turned into a separator;
      2. percent-encoding — every character outside :data:`_URI_PATH_SAFE` is
         replaced by ``%XX`` per UTF-8 byte. ``invoices/Q1 2026.xml`` becomes
         ``invoices/Q1%202026.xml``; ``Rechnung_Müller.xml`` becomes
         ``Rechnung_M%C3%BCller.xml``. Characters that are legal in a URI
         reference — ``&``, ``'``, ``(``, ``)``, ``+``, ``,``, ``;``, ``=``,
         ``:``, ``@`` — are left ALONE, so the common case stays readable.

    Percent-decoding the result reproduces the argv string byte for byte, which
    is what ``test_path_invariance.py`` / ``test_filename_robustness.py`` pin.

    :param source: the report ``source`` field (the argv path string).
    :returns: a URI reference (``str``); ``""`` when ``source`` is empty.
    """
    if not source:
        return ""
    if os.sep != "/":
        source = source.replace(os.sep, "/")
    out = []
    for ch in source:
        if ch in _URI_PATH_SAFE:
            out.append(ch)
        else:
            out.extend("%%%02X" % byte for byte in ch.encode("utf-8"))
    return "".join(out)


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
        carrying BOTH a ``logicalLocations`` member (the offending element
        name) and a ``physicalLocation`` (see below).

    PHYSICAL LOCATION — why it exists. GitHub code scanning draws an inline
    pull-request annotation from ``physicalLocation.artifactLocation.uri`` plus
    ``region.startLine``; a result that carries only ``logicalLocations``
    uploads successfully and shows up NOWHERE on the diff. So each location
    object also gets:

      * ``physicalLocation.artifactLocation.uri`` = the validated invoice path
        as the caller spelled it on argv (``report["source"]``), passed through
        :func:`_sarif_artifact_uri` — forward slashes, percent-encoded where a
        character is illegal in a URI reference, never absolutized (the
        path-echo rule). Omitted only when the report carries no ``source`` at
        all, which no :func:`build_report` output ever does — there is then no
        artifact to name, and the ``logicalLocations`` member stands alone;
      * ``physicalLocation.region.startLine`` = the 1-based ``source_line``
        the violation record carries when the finding is attributable to a
        concrete element. An absence/document-level finding (BR-16, "an Invoice
        shall have at least one Invoice line") has no attributable line, so it
        gets the ``artifactLocation`` and NO ``region`` — never a guessed line
        1, never a ``startLine`` of 0. This mirrors :func:`build_github`
        omitting ``line=`` and :func:`build_gitlab` omitting ``location.lines``.

    ``partialFingerprints`` stays line-INDEPENDENT (:func:`_sarif_fingerprint`
    hashes rule id + logical location only), so an edit that shifts a violation
    to a different line still de-duplicates against the previous run even
    though its ``startLine`` moved.

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
    # only these earn a ``helpUri`` deep-link. Read through the DEFENSIVE
    # module accessor (never the raw catalog loader): an installation
    # whose remediation catalog is missing or unreadable degrades to an empty
    # mapping, which here simply means "no rule earns a helpUri" — the SARIF
    # document is still produced in full and stays valid. A packaging slip must
    # never turn the Action's DEFAULT ``format: sarif`` into a traceback.
    catalog_ids = _remediation_catalog()

    # The argv path, URI-shaped once for every result (see
    # :func:`_sarif_artifact_uri`). Empty only for a hand-built report dict
    # with no ``source`` — build_report always sets one.
    artifact_uri = _sarif_artifact_uri(report.get("source") or "")

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
                    descriptor["helpUri"] = rule_page_url(rule_id)
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
            # Attach a location when we know WHERE the finding is; omit
            # ``locations`` entirely when neither field nor location hint is
            # present (an empty locations array is not useful).
            if loc_name:
                loc = {
                    "logicalLocations": [{
                        "name": loc_name,
                        "kind": "member",
                    }],
                }
                # The PHYSICAL half — what GitHub turns into an inline PR
                # annotation. The artifact is the invoice the caller named;
                # the region is emitted ONLY for a finding the parser could
                # attribute to a concrete 1-based source line (never a guessed
                # line 1, never 0). ``source_line`` is validated here rather
                # than trusted: a bool is not a line number, and SARIF
                # ``region.startLine`` must be >= 1.
                if artifact_uri:
                    physical = {"artifactLocation": {"uri": artifact_uri}}
                    source_line = v.get("source_line")
                    if (isinstance(source_line, int)
                            and not isinstance(source_line, bool)
                            and source_line >= 1):
                        physical["region"] = {"startLine": source_line}
                    loc["physicalLocation"] = physical
                result["locations"] = [loc]
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


def _azure_level(severity):
    """Map a report severity string onto an Azure DevOps logissue ``type``.

    Azure Pipelines' ``##vso[task.logissue ...]`` logging command understands
    exactly two issue types — ``error`` (red, and, when combined with
    ``task.complete``, capable of failing the task) and ``warning`` (yellow,
    advisory). Mirroring :func:`_github_level`'s fatal->error split, a ``fatal``
    finding (the only severity that makes an invoice non-conformant and drives
    exit code 1) becomes ``error``; every other severity (``warning``, the
    advisory ``information``, or an unknown value) becomes ``warning``. The type
    is a PRESENTATION mapping only: it never changes which rules fire or the
    process exit code — an advisory ``information`` finding stays exit-0 exactly
    as in the github surface.
    """
    return "error" if severity == "fatal" else "warning"


def _azure_escape_data(text):
    """Escape an Azure DevOps logging-command MESSAGE (the text after ``]``).

    Azure Pipelines parses ``##vso[<area.action> <props>]<message>`` as a line
    protocol, so a literal percent, CR or LF in the message would corrupt the
    command. Azure's escaping DIFFERS from GitHub's: the percent sentinel is the
    multi-byte ``%AZP25`` (not ``%25``), applied FIRST so the escape characters
    we introduce are not themselves re-escaped, then CR -> ``%0D`` and
    LF -> ``%0A``. This is deliberately NOT XML escaping — logging commands are a
    line protocol, so :func:`escape`/:func:`quoteattr` are the wrong tool, and it
    is NOT :func:`_github_escape_data` either — the percent byte-rule is
    different, which is why this helper is dedicated.
    """
    return (str(text)
            .replace("%", "%AZP25")
            .replace("\r", "%0D")
            .replace("\n", "%0A"))


def _azure_escape_property(text):
    """Escape an Azure logging-command PROPERTY value (``sourcepath=``/``code=``).

    Property values live inside the ``;``-separated ``k=v`` list that ends at the
    closing ``]``, so on top of the message escaping (:func:`_azure_escape_data`)
    Azure's property escaping also encodes the two delimiters that would
    otherwise split the list or close the command early: ``;`` -> ``%3B`` and
    ``]`` -> ``%5D``. ``%`` is still escaped first (inside
    :func:`_azure_escape_data`) so no escape sequence is double-encoded. Note the
    delimiter set differs from GitHub's (``,``/``:``), which is why this is a
    dedicated helper and NOT :func:`_github_escape_property`.
    """
    return (_azure_escape_data(text)
            .replace(";", "%3B")
            .replace("]", "%5D"))


def build_azure(report):
    """Project a report dict (from :func:`build_report`) into Azure DevOps
    Pipelines ``##vso[task.logissue ...]`` logging-command lines.

    Emits one ``task.logissue`` logging command per violation — the line
    protocol an Azure DevOps Pipelines agent turns into an INLINE issue on the
    build/PR summary (and, when a ``sourcepath``/``linenumber`` position is
    known, anchored to the offending file). Any script step that simply prints
    these lines to stdout gets file-anchored issues for free, with zero SARIF
    upload and zero extension install. This is the Azure analogue of
    :func:`build_github`'s GitHub Actions workflow commands, for the MS/SAP-stack
    ERP buyer whose pipelines run on Azure DevOps rather than GitHub Actions.

    Like :func:`build_github`, this is a PURE, additional PROJECTION of the very
    same validator outcome the JSON path emits — it adds no rule logic, invents
    no wording, and re-reads nothing:

      * ``type=`` = :func:`_azure_level` of the severity — ``fatal`` ->
        ``type=error`` (matches exit 1), ``warning``/``information`` ->
        ``type=warning``;
      * ``sourcepath=`` = the invoice ``source`` path (the same value
        :func:`build_github` puts in ``file=``), falling back to the violation
        ``field`` then the catalog ``location`` hint;
      * ``linenumber=`` = the OPTIONAL 1-based ``source_line`` the record carries
        when the finding is attributable — the ``linenumber`` key is OMITTED
        ENTIRELY (never emitted as ``linenumber=0``) when ``source_line`` is
        absent, mirroring :func:`build_github` omitting ``line=``;
      * ``code=`` = the rule id;
      * the message body (after ``]``) = the violation message (falling back to
        the catalog ``title`` then the rule id).

    Message and property values are escaped with :func:`_azure_escape_data` /
    :func:`_azure_escape_property` — Azure's ``%AZP25``/``%3B``/``%5D`` rules,
    NOT GitHub's ``%25``/``%2C``/``%3A`` — so a ``%``, ``;``, ``]`` or newline
    cannot corrupt the line protocol.

    Emission scope mirrors :func:`build_github` exactly: advisory ``information``
    findings ARE surfaced (as ``type=warning``), never dropped, and this never
    changes the exit code — only ``fatal`` findings do, and a conformant invoice
    still exits 0. When there is nothing to report at all, a single ``#``
    log-comment line is emitted (a true no-op to the agent — it is not a
    ``##vso[`` command and creates no issue) so the surface is well-shaped and
    non-empty like the other formats.

    A not-well-formed input (``report`` has an ``error``) yields a single
    ``type=error`` logissue for the parse error, mirroring the github
    not-well-formed contract.

    :param report: a dict as returned by :func:`build_report`.
    :returns: a ``str`` of newline-terminated logging-command lines.
    """
    source = report.get("source") or ""
    lines = []

    if report.get("error"):
        # Not-well-formed XML: one ``type=error`` logissue for the parse error,
        # the Azure analogue of build_github's single ``::error`` parse entry.
        code = report["error"]
        props = ["type=error",
                 "sourcepath=" + _azure_escape_property(source),
                 "code=" + _azure_escape_property(code)]
        message = report.get("message", "") or code
        lines.append("##vso[task.logissue " + ";".join(props) + "]"
                     + _azure_escape_data(message))
        return "".join(line + "\n" for line in lines)

    for v in report.get("violations", []):
        rule_id = v.get("rule") or ""
        severity = v.get("severity") or "fatal"
        title = v.get("title")
        field = v.get("field")
        location_hint = v.get("location")
        # sourcepath= is a FILE path: the validated invoice. Fall back to the
        # element field / catalog location hint only if the source is missing.
        path = source or field or location_hint or ""
        source_line = v.get("source_line")

        props = ["type=" + _azure_level(severity),
                 "sourcepath=" + _azure_escape_property(path)]
        # Attach the 1-based line ONLY when the finding is attributed to a source
        # position; omit ``linenumber`` entirely otherwise (never ``=0``).
        if source_line is not None:
            props.append("linenumber=" + str(source_line))
        props.append("code=" + _azure_escape_property(rule_id))
        message = v.get("message") or title or rule_id
        lines.append("##vso[task.logissue %s]%s"
                     % (";".join(props), _azure_escape_data(message)))

    if not lines:
        # Nothing to report. Emit a plain log comment (NOT a ``##vso[`` command,
        # so the agent raises no issue) to keep the surface non-empty and
        # well-shaped, the Azure analogue of build_github's ``#`` no-op line.
        lines.append("# einvoice: %s is conformant with EN 16931 — no "
                     "issues" % (source or "input"))

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
a.rule-id { color: #0a4a7a; text-decoration-color: #9fc4de; }
.note { color: #57606a; font-size: .85rem; margin: 1.25rem 0 0; }
/* The footer's provenance-check line names a command, so it needs the same
   inline-code treatment as .note — one selector, not a second rule to drift. */
.note code, footer code { font-family: ui-monospace, SFMono-Regular, Menlo,
  monospace; background: #eaeef2; border-radius: 4px; padding: .05rem .3rem; }
.sev { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em;
  padding: .1rem .5rem; border-radius: 999px; font-weight: 700; }
.sev.fatal { background: #fce8e6; color: #7a1f16; }
.sev.warning { background: #fff3d6; color: #7a5b0d; }
.sev.information { background: #ddeeff; color: #0a4a7a; }
.title { font-weight: 600; }
.msg { margin: .35rem 0; }
.pos { color: #57606a; font-family: ui-monospace, SFMono-Regular, Menlo,
  monospace; font-size: .9em; word-break: break-all; }
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
footer p { margin: 0 0 .5rem; }
/* The provenance rows reuse the finding <dl> grid but must not jump back up to
   its .9rem: inside the .8rem footer that would render the fine print LARGER
   than the prose around it. */
footer dl { font-size: inherit; margin: 0 0 .5rem; }
""".strip()


#: THE DOCUMENT CHROME, KEYED BY LANGUAGE (T-VHRPTH.4).
#:
#: WHY THIS TABLE EXISTS. The HTML report is the one artifact of ours that a
#: German company forwards to its accountant, and the whole buyer pool exists
#: because of a GERMAN legal mandate — so ``--lang de`` has to produce a German
#: document, and a document that declares ``<html lang="de">`` while every
#: heading, label and banner in it is English is itself a false declaration
#: (screen readers switch voice on it, browser translation keys off it). The
#: FIXED, small set of strings the document itself authors therefore lives here,
#: one dict per language.
#:
#: WHAT IS *NOT* HERE, on purpose: rule text. Titles, messages and fix hints are
#: never translated by this module. A rule's German sentence comes from ONE
#: place, ``einvoice.remediation.resolve_message`` reading the vendored official
#: KoSIT XRechnung ``<sch:assert>`` text out of the committed catalog, and only
#: the ~50 BR-DE-family rules that actually carry one have it. Everything else
#: keeps its English original, VISIBLY marked (``fallback_marker``) and
#: explained (``fallback_note``) — never quietly reworded, because presenting an
#: authored translation as the official assert would misrepresent the legal text
#: the reader is being told they violated.
#:
#: ENGLISH IS THE REFERENCE ROW. Every key exists in ``en``, and :func:`_chrome`
#: falls back to it for any key a language lacks, appending a VISIBLE ``[en]``
#: so a partially translated document says so on its face instead of silently
#: mixing languages. The ``en`` values below are byte-for-byte the strings this
#: emitter has always produced, so the default document is unchanged.
_HTML_CHROME = {
    "en": {
        "doc_title": "einvoice conformance report",
        "h1": "EN 16931 / XRechnung conformance report",
        "meta": "source: %s &middot; profile: %s",
        "stdin": "(stdin)",
        "parse_error_banner": ("Not well-formed XML — the invoice could not "
                              "be parsed."),
        "banner_pass": "Conformant",
        "banner_fail": "Not conformant",
        "no_findings": "no findings",
        "pass_nonfatal_sg": ("%d non-fatal finding (warnings do not "
                             "invalidate)"),
        "pass_nonfatal_pl": ("%d non-fatal findings (warnings do not "
                             "invalidate)"),
        "counts_sg": "%d finding &middot; %d fatal &middot; %d non-fatal",
        "counts_pl": "%d findings &middot; %d fatal &middot; %d non-fatal",
        "label_fix": "How to fix",
        "label_terms": "Business terms",
        "label_field": "Field",
        "label_location": "Location",
        "note": ("Rule ids with a published reference page link to it; ids "
                 "without one are shown plain. Offline, <code>einvoice "
                 "--explain &lt;RULE-ID&gt;</code> prints the same rule text "
                 "from your local install."),
        # The two provenance rows are never emitted in an ENGLISH document
        # (there is nothing to fall back from, and no translation to disclose);
        # they exist here as the reference wording every other row translates.
        "provenance_note": ("Translated rule sentences are the official KoSIT "
                            "XRechnung Schematron text, quoted verbatim — "
                            "nothing is machine-translated. Rule titles and "
                            "fix hints come from the English remediation "
                            "catalog and stay English."),
        "fallback_note": ("Rules with no official text in this language are "
                          "marked [en] and shown in the English original."),
        "fallback_marker": "[en]",
        "footer": ("Static conformance artifact — reflects this one report run "
                   "against the invoice above. Generated offline by einvoice; "
                   "no network, no tracking."),
        # THE PROVENANCE FOOTER (T-VHRPTH.2). Labels for the three engine facts
        # that let a recipient say WHAT checked this invoice six months later:
        # the engine version, how many business rules that build asserts, and
        # the full attestation digest they can re-derive. The values are never
        # authored here — see `_provenance()`.
        "provenance_engine": "Engine version",
        "provenance_rules": "Business rules asserted",
        "provenance_digest": "Attestation SHA-256",
        # HOW THE RECIPIENT CHECKS THE ROWS ABOVE (T-VHRPTH.5). Printing a
        # 64-hex digest and inviting trust in it, while telling nobody which
        # command re-derives it, makes the footer decoration. `einvoice info
        # --json` is the ONE documented reader of the same payload these rows
        # come from (see `_provenance`), so it is the only command named here —
        # no new flag, no new surface. Carries inline <code> markup exactly like
        # `note` above and is therefore emitted WITHOUT `_h()`.
        #
        # COUNTS NOTHING, ON PURPOSE. `_provenance()` OMITS any row it cannot
        # source, and the in-browser bundle ships one data file, so a report
        # generated in a browser carries a single row. A sentence that said
        # "these three values" would therefore be false on the one surface a
        # stranger reaches without installing anything. The wording below is
        # true for any subset: it names the facts the command prints, and
        # points at "the rows above" as whatever this build could source.
        "provenance_check": ("How to check what is listed above: <code>einvoice "
                             "info --json</code> prints the same engine facts "
                             "— version, rule count and attestation digest — "
                             "for the build installed on your own machine. "
                             "This footer lists whichever of those facts the "
                             "build that wrote the report could source; where "
                             "they match that output, this report came from "
                             "the build you are running, and a differing "
                             "attestation digest means a different build, not "
                             "a different invoice."),
        # THE HONESTY SENTENCE. Deliberately the SAME claim the site already
        # publishes under the id `green-not-legal-conformance` (www/index.html,
        # generated from gen_site.py) — quoted, not re-authored, so the document
        # a buyer files and the page that sold it to them cannot drift into two
        # different promises about what "green" means.
        "provenance_legal_note": ("A green result means “no implemented fatal "
                                  "rule fired”, not “certified legally "
                                  "conformant”."),
    },
    "de": {
        "doc_title": "einvoice Konformitätsbericht",
        "h1": "Konformitätsbericht EN 16931 / XRechnung",
        "meta": "Datei: %s &middot; Profil: %s",
        "stdin": "(stdin)",
        "parse_error_banner": ("Kein wohlgeformtes XML — die Rechnung konnte "
                              "nicht gelesen werden."),
        "banner_pass": "Konform",
        "banner_fail": "Nicht konform",
        "no_findings": "keine Befunde",
        "pass_nonfatal_sg": ("%d nicht fataler Befund (Warnungen machen die "
                             "Rechnung nicht ungültig)"),
        "pass_nonfatal_pl": ("%d nicht fatale Befunde (Warnungen machen die "
                             "Rechnung nicht ungültig)"),
        "counts_sg": "%d Befund &middot; %d fatal &middot; %d nicht fatal",
        "counts_pl": "%d Befunde &middot; %d fatal &middot; %d nicht fatal",
        "label_fix": "Behebung",
        "label_terms": "Geschäftsbegriffe (BT/BG)",
        "label_field": "Feld",
        "label_location": "Stelle im XML",
        "note": ("Regel-IDs mit veröffentlichter Referenzseite sind verlinkt; "
                 "IDs ohne eine solche Seite stehen als reiner Text. Offline "
                 "gibt <code>einvoice --explain &lt;REGEL-ID&gt;</code> "
                 "denselben Regeltext aus Ihrer lokalen Installation aus."),
        "provenance_note": (
            "Die deutschen Regelsätze sind der amtliche KoSIT-Wortlaut der "
            "XRechnung-Schematron-Regel, Wort für Wort übernommen — es wird "
            "nichts maschinell übersetzt. Regeltitel und Behebungshinweise "
            "stammen aus dem englischen Remediation-Katalog und bleiben "
            "englisch."),
        "fallback_note": (
            "Regeln ohne amtlichen deutschen Text sind mit [en] markiert und "
            "stehen im englischen Original."),
        "fallback_marker": "[en]",
        "footer": ("Statisches Konformitäts-Artefakt — es hält genau diesen "
                   "einen Prüflauf gegen die oben genannte Rechnung fest. "
                   "Offline von einvoice erzeugt; kein Netzwerkzugriff, kein "
                   "Tracking."),
        # "Regelzahl" und "Attestierungs-Hash" sind die Begriffe, die
        # QUICKSTART.de.md für dieselben zwei Zahlen schon verwendet — eine
        # zweite deutsche Benennung derselben Sache wäre nur Drift.
        "provenance_engine": "Engine-Version",
        "provenance_rules": "Geprüfte Geschäftsregeln (Regelzahl)",
        "provenance_digest": "Attestierungs-Hash (SHA-256)",
        # Derselbe Hinweis auf Deutsch — der Bericht, den ein deutsches
        # Unternehmen weiterleitet, muss die Prüfanleitung in der Sprache des
        # Dokuments tragen. Der Befehl selbst wird nicht übersetzt (es gibt
        # keine deutschen Flags); die Begriffe „Regelzahl“ und
        # „Attestierungs-Hash“ sind die der Zeilen darüber. Wie im Englischen
        # wird KEINE Anzahl genannt: `_provenance()` lässt jede Zeile weg, die
        # dieser Build nicht ermitteln kann (im Browser-Bundle bleibt genau
        # eine übrig), also muss der Satz für jede Teilmenge stimmen.
        "provenance_check": ("So prüfen Sie die Angaben oben: <code>einvoice "
                             "info --json</code> gibt dieselben Engine-Angaben "
                             "— Version, Regelzahl und Attestierungs-Hash — "
                             "für die Installation auf Ihrem eigenen Rechner "
                             "aus. Dieser Fußbereich führt davon auf, was der "
                             "Build ermitteln konnte, der den Bericht "
                             "geschrieben hat; stimmt das mit dieser Ausgabe "
                             "überein, stammt dieser Bericht aus demselben "
                             "Build, den Sie ausführen. Ein abweichender "
                             "Attestierungs-Hash bedeutet einen anderen Build, "
                             "nicht eine andere Rechnung."),
        # Der amtliche deutsche Wortlaut derselben Aussage, die die Website
        # unter `green-not-legal-conformance` führt (www/de/index.html, erzeugt
        # von gen_site.py) — wörtlich übernommen, nicht neu formuliert und
        # nicht maschinell übersetzt.
        "provenance_legal_note": ("Ein grünes Ergebnis heißt: keine "
                                  "implementierte fatale Regel hat ausgelöst. "
                                  "Es heißt nicht „rechtsverbindlich konforme "
                                  "XRechnung“."),
    },
}

#: Appended to an English chrome string that stood in for a MISSING translation,
#: so a partially translated document declares the mix visibly rather than
#: passing English prose off as the requested language.
_CHROME_FALLBACK_SUFFIX = " [en]"


def _chrome(key, lang="en"):
    """One document-chrome string from :data:`_HTML_CHROME`, in ``lang``.

    Returns the requested language's wording when it has that key; otherwise
    the ENGLISH wording with a visible :data:`_CHROME_FALLBACK_SUFFIX`
    appended (an unknown language, or a language whose row is incomplete, must
    LOOK partly English rather than silently be it). ``lang="en"`` returns the
    English string untouched, so the default document keeps its exact bytes.

    An unknown ``key`` raises ``KeyError`` off the English row — that is a
    programming error in this module, not a caller's input, and must not be
    swallowed into an empty label.
    """
    table = _HTML_CHROME.get(lang)
    if table is not None and key in table:
        return table[key]
    english = _HTML_CHROME["en"][key]
    if lang == "en":
        return english
    return english + _CHROME_FALLBACK_SUFFIX


def _provenance():
    """The engine facts the HTML footer attributes the report to.

    Returns a dict with any of ``version`` (str), ``rule_count`` (positive int)
    and ``attestation_sha256`` (non-empty str) that could actually be resolved.
    A key is ABSENT rather than ``None`` when its source is unavailable, so the
    caller's "omit the row" branch is a plain membership test.

    ONE SOURCE, NEVER RETYPED. Every value comes out of the same payload
    ``einvoice info`` prints — :func:`einvoice.cli._info_payload` — so the
    document a buyer files and the capability probe their CI runs cannot report
    different numbers, and a release or a re-attestation moves both at once.
    Nothing here is a literal: there is no second version constant, no second
    digest, no second rule count to hand-maintain (which is also why no golden
    may capture this footer verbatim — see test_report_html.py).

    WHY THE IMPORT IS FUNCTION-LOCAL. ``einvoice.cli`` imports THIS module at
    module scope (``from .report import ...``), so a module-level
    ``from .cli import _info_payload`` here would close a circular import at
    package-load time and break every entry point. Importing inside the
    function is the same pattern ``_info_payload`` itself uses for its coverage
    and syntax-binding loaders, and it is free in practice: by the time a
    document is being built the CLI module is already imported, or importable.

    NEVER A LIE, NEVER A TRACEBACK. The in-browser engine bundle ships the
    modules plus exactly ONE data file (``remediation_catalog.json``), so
    ``coverage_matrix.json`` and the attestation are genuinely not there and
    ``rule_count`` / ``attestation_sha256`` legitimately resolve to ``None``.
    Such a value is dropped — the footer then simply has no such row. A
    conformance artifact must never print ``None``, ``unknown`` or ``0`` for a
    fact it does not have, because each of those reads as the fact. Any failure
    to source the payload at all (missing module, unparsable artifact) degrades
    to ``{}`` for the same reason: a footer is not worth an exception on a
    report that otherwise validated fine.
    """
    try:
        from .cli import _info_payload  # local: see docstring (circular import)
        payload = _info_payload()
    except Exception:                                    # pragma: no cover
        return {}
    if not isinstance(payload, dict):                    # pragma: no cover
        return {}

    out = {}
    version = payload.get("version")
    if isinstance(version, str) and version.strip():
        out["version"] = version.strip()
    rule_count = payload.get("rule_count")
    # A count of 0 is not a fact worth printing — an engine that asserts no
    # rules has nothing to attest, and "0" in a footer reads as a measurement.
    if isinstance(rule_count, int) and not isinstance(rule_count, bool) \
            and rule_count > 0:
        out["rule_count"] = rule_count
    digest = payload.get("attestation_sha256")
    if isinstance(digest, str) and digest.strip():
        # FULL digest, never truncated: an abbreviated hash is not something the
        # recipient can re-derive and compare, which is the only reason to print
        # it at all.
        out["attestation_sha256"] = digest.strip()
    return out


def _en_attr(doc_lang):
    """``' lang="en"'`` when the document is NOT English, else ``''``.

    Used on the individual elements that carry ENGLISH text inside a translated
    document (a rule title, a fix hint, a message with no official translation).
    An element-level ``lang`` is the HTML-native way to keep the document's own
    ``<html lang=…>`` declaration honest: assistive technology and browser
    translation both key on it, so tagging the English islands is what stops
    ``lang="de"`` from being a claim about text that is not German. Returns the
    empty string for an English document, so the default bytes never move.
    """
    return "" if doc_lang == "en" else ' lang="en"'


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


def build_html(report, lang="en"):
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

    Self-containment (hard requirement): the document fetches NO external
    SUBRESOURCE. The only styling is an inline ``<style>`` block
    (:data:`_HTML_STYLE`); there is no external CSS/JS/CDN reference, no
    ``<script>``, no ``<img>``, no web font, no ``@import``, no analytics — so
    the file RENDERS offline with zero network requests. Plain navigational
    ``<a href>`` links to the public rule pages ARE emitted (see below): a
    hyperlink issues no request until a human clicks it, so it costs the
    offline reader nothing while giving the artifact — the one output that
    travels to a second person — a way back to the authoritative rule text.

    Rule-page links: each finding's rule id is an anchor to
    :func:`rule_page_url` (the SAME single URL builder the SARIF ``helpUri``
    and the text report's ``rule page:`` line use), and ONLY when the
    remediation catalog really has an entry for that id — that catalog is what
    the site's rule pages are generated from, so a link is emitted exactly when
    a page exists. A synthetic/unknown rule id and the not-well-formed-XML row
    render plain, with no link, and an installation whose catalog is missing
    degrades to a link-free document (never a traceback).

    Determinism (RPT.8, pinned by ``test_report_html.py``): the document embeds
    NO wall-clock timestamp and no set/dict iteration order, so building the
    same report from the same input twice is byte-identical — a reproducible CI
    artifact.

    Path echo, stated exactly (changed by T-VHRPTH.3; see REPORT-FORMATS.md
    "Path echo"): the ``source`` meta line still shows ONLY
    ``os.path.basename(report["source"])``, never the directory part. The one
    place the caller's spelling now appears is a FINDING'S POSITION, and only
    when the engine actually resolved one — because ``line 28`` with no file
    beside it is not an address a recipient can act on, and the position is the
    entire point of this document travelling to a second person. That echo is
    verbatim and is the SAME string the text, json and sarif surfaces already
    emit: pass a relative path and the document holds a relative path; pass an
    absolute one and it holds that. Consequence, and it is deliberate: for a
    report that HAS a positioned finding, relative-path and absolute-path
    invocations of the same file are no longer byte-identical — exactly the
    trade sarif made when it gained ``region.startLine``. A report whose
    findings carry no position (and every unpositioned finding in any report)
    is unchanged, path-invariant, byte-for-byte.

    Layout:
      * a pass/fail banner ("Conformant" vs "N finding(s)") built from the same
        summary fields (``valid``/``fatal_count``/``violation_count``) the JSON
        path exposes. The FAIL banner splits the total into ``fatal`` and
        ``non-fatal`` — total-minus-fatal, NOT ``warning_count`` — so the named
        buckets always SUM to the stated total even for severities outside
        ``warning`` (``information``, as BR-DE-TMP-32 fires), and so the
        wording matches the CLI summary line's `non-fatal` vocabulary;
      * one card per violation carrying the rule id, a severity pill, the
        remediation ``title``, the violation ``message`` (with the finding's
        position appended when there is one — ``at file:line`` for an
        attributable finding, the distinctly worded
        ``(insertion point file:line)`` for an absence), and a definition list
        of ``fix_hint`` / BT-BG ``terms`` / ``field`` / ``location``;
      * a not-well-formed input (``report`` has an ``error``) renders a single
        error row with the error code + parser message — mirroring the JSON /
        JUnit / SARIF not-well-formed contract;
      * a PROVENANCE FOOTER (T-VHRPTH.2): the engine version, the number of
        business rules that build asserts and the FULL 64-hex attestation
        digest, plus the same "green is not legal conformance" sentence the
        site publishes. Every figure is read from the ``einvoice info`` payload
        at build time (:func:`_provenance`) — nothing is hard-coded and nothing
        is a second copy of a constant — and a figure that cannot be sourced
        (the browser bundle ships no coverage matrix and no attestation) omits
        its row instead of printing a placeholder. This footer is HTML-ONLY: no
        machine format carries it, so the digest cannot be mistaken for part of
        the report schema.

    LANGUAGE (T-VHRPTH.4). ``lang`` is KEYWORD-DEFAULTED to ``"en"``, so the
    historical one-argument call — ``build_html(report)``, which is what the
    in-browser validator page runs (``www/validate/index.html``, an English
    page) — is unchanged and still returns the exact English bytes it always
    did. ``lang="de"`` renders the German document the German mandate's users
    actually need, and it changes THREE things and nothing else:

      * the ``<html lang=…>`` attribute, which now states the language really
        rendered instead of hard-coding ``en`` (a false declaration for a
        translated document, and the reason this was worth fixing);
      * the document CHROME — title, ``<h1>``, meta/summary labels, definition
        list headings, note and footer — from :data:`_HTML_CHROME`, prose this
        project authors, with a visible ``[en]`` marker on anything a language
        row lacks;
      * each finding's MESSAGE, through ``resolve_message`` — the very same
        resolver ``einvoice validate --lang de`` uses for its text summary, so
        the two human surfaces show the identical German sentence for a rule
        and there is no second translation table to drift.

    NOTHING IS TRANSLATED AT RUN TIME and no wording is invented for a rule.
    Only ~50 of the fireable rules carry an official German ``message_de`` (the
    BR-DE family's vendored KoSIT ``<sch:assert>`` text); a rule without one
    keeps its ENGLISH message, that paragraph is marked ``lang="en"`` and
    prefixed with a visible ``[en]``, and one note under the findings says so
    and adds the honest limit that rule TITLES and FIX HINTS come from the
    English remediation catalog and stay English. Rule ids, severities, counts,
    positions and the exit code are language-independent facts and are
    byte-identical in every language.

    :param report: a dict as returned by :func:`build_report`.
    :param lang: ``"en"`` (default) or ``"de"``; any other value renders the
        English document and declares ``lang="en"``, since declaring a language
        whose text we do not have is exactly the lie this parameter fixes.
    :returns: a self-contained HTML document as a ``str``.
    """
    profile = report.get("profile", "")
    source = report.get("source", "")
    # The DECLARED language is the language actually rendered: a value we have
    # no chrome row for renders English and says "en". `_chrome` would mark
    # every string `[en]` for such a value anyway; normalising here means the
    # attribute, the chrome and the message resolver all agree on one value.
    doc_lang = lang if lang in _HTML_CHROME else "en"

    # The set of rule ids for which an authoritative reference page exists —
    # the SAME gate, read through the SAME defensive accessor, the SARIF
    # helpUri path uses. A catalog-less installation yields {} here, which
    # simply means "nothing links": the document is still produced in full.
    catalog_ids = _remediation_catalog()

    parts = []
    parts.append("<!doctype html>")
    parts.append('<html lang="%s">' % _h(doc_lang))
    parts.append("<head>")
    parts.append('<meta charset="utf-8">')
    parts.append('<meta name="viewport" content="width=device-width, '
                 'initial-scale=1">')
    parts.append('<meta name="robots" content="noindex">')
    parts.append("<title>%s</title>" % _h(_chrome("doc_title", doc_lang)))
    parts.append("<style>%s</style>" % _HTML_STYLE)
    parts.append("</head>")
    parts.append("<body>")
    parts.append("<main>")
    parts.append("<h1>%s</h1>" % _h(_chrome("h1", doc_lang)))
    # PATH-INVARIANCE (RPT.8): the HTML artifact is archived/shared from CI,
    # so it must never embed the caller's filesystem layout — only the input
    # file's BASENAME is shown (the json ``source`` field keeps the verbatim
    # argv string; sarif embeds no path at all — see REPORT-FORMATS.md "Path
    # echo"). Relative and absolute invocations of the same file therefore
    # produce byte-identical HTML.
    parts.append('<p class="meta">%s</p>'
                 % (_chrome("meta", doc_lang)
                    % (_h(os.path.basename(source))
                       or _h(_chrome("stdin", doc_lang)), _h(profile))))

    if report.get("error"):
        # Not-well-formed XML: a single error row — the HTML analogue of the
        # JUnit single-<error> testcase / SARIF single error result.
        code = report["error"]
        msg = report.get("message", "") or code
        parts.append('<div class="banner fail">%s</div>'
                     % _h(_chrome("parse_error_banner", doc_lang)))
        parts.append('<div class="error-row">')
        parts.append('<span class="code">%s</span>' % _h(code))
        parts.append("<p>%s</p>" % _h(msg))
        parts.append("</div>")
    else:
        violations = report.get("violations", [])
        valid = report.get("valid")
        fatal_count = report.get("fatal_count", 0)
        violation_count = report.get("violation_count", len(violations))

        if valid:
            n = violation_count
            # Singular and plural are SEPARATE chrome rows rather than an
            # English "%s"-pluralising suffix: German inflects the adjective
            # too ("1 nicht fataler Befund" / "2 nicht fatale Befunde"), which
            # a bolted-on "s" cannot express. The English rows reproduce the
            # historic strings exactly.
            note = (_chrome("no_findings", doc_lang) if n == 0
                    else _chrome("pass_nonfatal_sg" if n == 1
                                 else "pass_nonfatal_pl", doc_lang) % n)
            parts.append('<div class="banner pass">%s'
                         '<span class="counts">%s</span></div>'
                         % (_h(_chrome("banner_pass", doc_lang)), _h(note)))
        else:
            # The named buckets MUST sum to the stated total. `warning_count`
            # counts ONLY severity == 'warning', so a finding carried at any
            # other non-fatal severity (`information`, as BR-DE-TMP-32 is) fell
            # into the total and into NEITHER named bucket — the forwarded
            # document then read `3 findings · 2 fatal · 0 warning`, and the
            # recipient could not account for one of the findings it claimed.
            # Deriving the second bucket as total-minus-fatal closes the hole
            # for EVERY present and future severity, and reuses the CLI summary
            # line's existing `non-fatal` vocabulary (report.py:825,
            # "%d finding(s) total: %d fatal, %d non-fatal") rather than
            # inventing a third phrasing for the same three buckets.
            non_fatal_count = max(0, violation_count - fatal_count)
            counts = (_chrome("counts_sg" if violation_count == 1
                              else "counts_pl", doc_lang)
                      % (violation_count, fatal_count, non_fatal_count))
            parts.append('<div class="banner fail">%s'
                         '<span class="counts">%s</span></div>'
                         % (_h(_chrome("banner_fail", doc_lang)), counts))

        # Did ANY finding in this document fall back to its English message?
        # Only used to decide whether the fallback note is worth printing; the
        # per-finding marker below is what actually labels each one.
        saw_message_fallback = False

        for v in violations:
            rule = v.get("rule") or ""
            severity = v.get("severity") or "fatal"
            title = v.get("title")
            english_message = v.get("message") or ""
            # LOCALISED FINDING TEXT, VIA THE ONE RESOLVER. `resolve_message`
            # is literally the call `einvoice validate --lang de` makes for its
            # text summary (cli.py's headline / "also violated" / advisory
            # lines): it returns the OFFICIAL KoSIT German assert from the
            # committed catalog where the rule has one and the English argument
            # otherwise. Using it here — rather than a second table — is what
            # makes the forwarded HTML and the terminal show the same German
            # sentence for the same rule. The already-loaded `catalog_ids`
            # mapping is passed so a report with many findings parses the
            # catalog JSON once; a catalog-less install yields {}, every
            # message stays English, and nothing raises — the same
            # degrade-not-fail discipline the rule links use.
            message = resolve_message(rule, english_message, doc_lang,
                                      catalog=catalog_ids)
            # WAS that an official translation, or the English original? Asked
            # of the catalog directly instead of inferred by comparing the two
            # strings, so a rule can never be mislabelled by coincidence. A
            # finding with no official text in this language keeps its English
            # message and SAYS SO — silence here is exactly how a reader comes
            # to believe they are holding the German legal wording.
            message_fallback = bool(
                doc_lang != "en" and english_message
                and _remediation.official_message(
                    rule, doc_lang, catalog=catalog_ids) is None)
            if message_fallback:
                saw_message_fallback = True
            fix_hint = v.get("fix_hint")
            terms = v.get("terms") or []
            field = v.get("field")
            location = v.get("location")
            # POSITION (T-VHRPTH.3). The HTML report is the ONE artifact of
            # ours that travels to a second person — a CI download, a file
            # attached to an invoice dispute, a forward to an accountant — and
            # until now its recipient got strictly LESS than the CLI user who
            # produced it: the engine had already computed the position and
            # text/json/junit all rendered it, while this document handed over
            # a bare XPath (a structural address that names WHICH element is
            # wrong and gives the reader nothing to jump to).
            #
            # It is rendered through the SAME two helpers the other two HUMAN
            # surfaces use (the text report, :func:`build_text`, and the JUnit
            # <failure> body) — deliberately NOT a third formatter, so the
            # three can never phrase a position differently — and with the
            # same precedence: a proven error site (``at file:line``) always
            # wins over a guessed-at destination.
            #
            # THE HONESTY RULE IS VISIBLE HERE, NOT JUST IN THE HELPERS. An
            # insertion point is where the missing thing GOES; nothing on that
            # line is wrong. So an absence never reads "at broken.xml:28" (a
            # reader, and any editor that jumps there, would take that as "the
            # error is on line 28" and land on an innocent <cac:Party>) — it
            # reads "(insertion point broken.xml:28)" and carries the word
            # "insertion" literally. Worked example, the file our onboarding
            # docs tell a stranger to run:
            #   BR-DE-2: The group 'SELLER CONTACT' (BG-6) must be transmitted.
            #     (insertion point examples/01-missing-fields/broken.xml:28)
            # A finding the engine could place at a real element instead reads:
            #   at fixtures/creditnote-invalid-typecode_ubl.xml:28
            # A finding with NEITHER renders byte-identically to before: the
            # helpers validate bool/int >= 1 and return "" otherwise, and
            # nothing here adds a :0 or :1 fallback.
            position = (_position_suffix(source, v.get("source_line"))
                        or _insertion_point_suffix(
                            source, v.get("insertion_point_line")))

            sev_class = severity if severity in (
                "fatal", "warning", "information") else "information"

            parts.append('<div class="finding">')
            # The rule id becomes a link ONLY when the catalog has an entry for
            # it (that is where a published page exists) — otherwise it renders
            # exactly as it always did, as plain text.
            if rule and rule in catalog_ids:
                rule_markup = ('<a class="rule-id" href="%s">%s</a>'
                               % (_h(rule_page_url(rule)), _h(rule)))
            else:
                rule_markup = '<span class="rule-id">%s</span>' % _h(rule)
            head = [rule_markup,
                    '<span class="sev %s">%s</span>'
                    % (_h(sev_class), _h(severity))]
            if title:
                # The remediation catalog's titles are English prose. In a
                # translated document they are tagged `lang="en"` so the
                # document's own declaration stays true element by element (a
                # screen reader keeps its English voice on them instead of
                # reading English words with German phonemes); `fallback_note`
                # states the same limit in words. In an English document this
                # adds nothing, so the default bytes are unchanged.
                head.append('<span class="title"%s>%s</span>'
                            % (_en_attr(doc_lang), _h(title)))
            parts.append("<h2>%s</h2>" % "".join(head))
            # The position rides on the message line, exactly where the text
            # report puts it, and the helper's return is emitted VERBATIM
            # (leading space and all) inside the span — so the bytes a reader
            # sees are character-for-character the bytes the text report and
            # the JUnit <failure> body show. ``test_report_location.py``
            # asserts that one shared string against all three surfaces at
            # once, which is what makes "they can never phrase a position
            # differently" mechanically true rather than aspirational.
            # It goes through :func:`_h` like every other report-derived
            # string: the path comes from argv, so it is untrusted text and
            # must never reach the markup raw.
            if message or position:
                body = _h(message)
                if message_fallback:
                    # VISIBLE, in the reading order, not a tooltip: the marker
                    # leads the sentence so a reader scanning a German document
                    # sees which findings are not in German before reading them.
                    body = "%s %s" % (_h(_chrome("fallback_marker", doc_lang)),
                                      body)
                if position:
                    body += '<span class="pos">%s</span>' % _h(position)
                parts.append('<p class="msg"%s>%s</p>'
                             % (_en_attr(doc_lang) if message_fallback else "",
                                body))

            rows = []
            if fix_hint:
                # Same tagging as the title, and for the same reason: fix hints
                # are English catalog prose in every language.
                rows.append((_chrome("label_fix", doc_lang), _h(fix_hint),
                             False, _en_attr(doc_lang)))
            if terms:
                # BT/BG codes, XPaths and element names are language-neutral
                # identifiers, so these three carry no lang tag in any language.
                rows.append((_chrome("label_terms", doc_lang),
                             _h(", ".join(str(t) for t in terms)), True, ""))
            if field:
                rows.append((_chrome("label_field", doc_lang), _h(field),
                             True, ""))
            if location:
                rows.append((_chrome("label_location", doc_lang),
                             _h(location), True, ""))
            if rows:
                parts.append("<dl>")
                for label, val, mono, lang_attr in rows:
                    parts.append("<dt>%s</dt>" % _h(label))
                    parts.append('<dd%s%s>%s</dd>'
                                 % (' class="mono"' if mono else "",
                                    lang_attr, val))
                parts.append("</dl>")
            parts.append("</div>")

        if violations:
            # ONE short, factual line: what the links are, and the offline
            # equivalent. `einvoice --explain <RULE-ID>` is the real CLI form
            # (a global option, NOT an `explain` subcommand) and needs no
            # network. The angle brackets are escaped so the placeholder can
            # never be read as markup.
            parts.append('<p class="note">%s</p>'
                         % _chrome("note", doc_lang))
            if doc_lang != "en":
                # THE PROVENANCE PARAGRAPH — the honest limits of this
                # translation, in the document itself rather than only in our
                # docs. `provenance_note` is emitted for EVERY translated
                # document because both of its facts always hold (the German
                # sentences are quoted KoSIT text, not our translation; titles
                # and fix hints are English catalog prose in any language).
                # The `[en]` sentence is appended only when a marker is really
                # on the page, so the note never explains something absent.
                note = _chrome("provenance_note", doc_lang)
                if saw_message_fallback:
                    note = "%s %s" % (note,
                                      _chrome("fallback_note", doc_lang))
                parts.append('<p class="note">%s</p>' % note)

    # THE PROVENANCE FOOTER (T-VHRPTH.2). We sell a CONFORMANCE report, so the
    # handed-over document has to say WHAT checked the invoice: an evaluator
    # filing this file, citing it in a ticket or showing it to an auditor next
    # year needs the engine version, the size of the rule set it asserted and
    # the full attestation digest that pins the build — otherwise they cannot
    # even tell whether the report predates a fix. Every value is read from the
    # `einvoice info` payload (see `_provenance`), and a value that cannot be
    # sourced OMITS its row rather than printing a placeholder.
    #
    # STILL CHROME-INVARIANT (RPT.8): these are facts about the ENGINE, not
    # about this run — no wall-clock time, no filesystem path, nothing that
    # differs between two invocations of the same build over the same input.
    parts.append("<footer>")
    parts.append("<p>%s</p>" % _h(_chrome("footer", doc_lang)))
    provenance = _provenance()
    prov_rows = []
    if "version" in provenance:
        prov_rows.append((_chrome("provenance_engine", doc_lang),
                          "einvoice %s" % provenance["version"]))
    if "rule_count" in provenance:
        prov_rows.append((_chrome("provenance_rules", doc_lang),
                          str(provenance["rule_count"])))
    if "attestation_sha256" in provenance:
        prov_rows.append((_chrome("provenance_digest", doc_lang),
                          provenance["attestation_sha256"]))
    if prov_rows:
        parts.append('<dl class="provenance">')
        for label, value in prov_rows:
            parts.append("<dt>%s</dt>" % _h(label))
            parts.append('<dd class="mono">%s</dd>' % _h(value))
        parts.append("</dl>")
        # ONE line naming the command that reproduces whichever rows this build
        # could source, on the RECIPIENT's install (T-VHRPTH.5). The string
        # names no count, because the loop above emits only the keys
        # `_provenance()` resolved — one row in the browser bundle, three from a
        # full install. Emitted only inside this branch: a
        # document that could source no provenance row has nothing to compare,
        # and "check the values above" with no values above is noise. The
        # string carries pre-escaped inline <code>, so no `_h()` here — the
        # same contract as the `note` paragraph in the body.
        parts.append("<p>%s</p>" % _chrome("provenance_check", doc_lang))
    # The honesty sentence is unconditional: it is true of a green and a red
    # result alike, and it is the one claim on the site that a downloaded report
    # most needs to carry with it.
    parts.append("<p>%s</p>" % _h(_chrome("provenance_legal_note", doc_lang)))
    parts.append("</footer>")
    parts.append("</main>")
    parts.append("</body>")
    parts.append("</html>")
    return "\n".join(parts) + "\n"


USAGE = ("usage: python3 -m einvoice.report "
         "[--profile en16931|xrechnung] "
         "[--format json|junit|sarif|gitlab|github|azure|html|badge|text] "
         "[--pretty] [--recurse] "
         "[--baseline <prev-report.json>] <invoice.xml | directory>\n"
         "   or: python3 -m einvoice.report --explain <RULE-ID> "
         "[--lang en|de]\n"
         "  When the path is a DIRECTORY (or --recurse is given) every invoice "
         "file (*.xml / *.pdf, dotfiles skipped) under it is validated and "
         "wrapped in an aggregate 'einvoice-conformance-batch/v1' document. "
         "Batch mode supports --format json (default), junit and text only "
         "(sarif/html/badge validate a single file); the exit code is 1 if any "
         "file has a fatal violation, else 3 if any file errored, else 0 (an "
         "empty directory is a clear file_count:0 result, exit 0).\n"
         "  --baseline diffs against a prior JSON report and fails (exit 1) "
         "ONLY on a NEW fatal violation; pre-existing fatals are tolerated "
         "(exit 0). Report shape and flag reference: "
         "https://verifyhash.com/einvoice/\n"
         "  --explain prints the remediation-catalog entry for one rule id "
         "(e.g. BR-DE-15) as a plain-text block and exits 0; it needs NO "
         "invoice file and is not combinable with --format/--baseline. "
         "--lang en|de selects the language of that block (de shows the "
         "catalog's German fields and names their provenance; anything with no "
         "German string stays English). On THIS entry point --lang applies to "
         "--explain only: every other mode here writes a document and refuses "
         "the flag rather than swallow it. The human report surfaces DO honour "
         "a language — 'einvoice validate --lang de --format html|text' renders "
         "German — while the seven machine formats (json, junit, sarif, "
         "gitlab, github, azure, badge) are language-neutral by design and are "
         "byte-identical in every language.")


#: One line per ``de_source`` value, printed as the ``german`` field of an
#: ``--explain --lang de`` block so the reader can see WHERE the German they are
#: reading came from instead of having to trust it. The three cases are the only
#: ones ``remediation_catalog.json`` can produce (``gen_remediation.py`` writes
#: ``de_source`` on every entry; the ``None`` key covers a catalog old enough or
#: damaged enough not to carry the field at all).
#:
#: Wording discipline: nothing here claims more than the data supports. Only the
#: ``kosit`` rules carry an OFFICIAL German string — the vendored KoSIT
#: XRechnung ``<sch:assert>`` text, verbatim — and that string is the rule
#: MESSAGE (title/requires). Their German fix line, and ALL German on every
#: other rule, is project-authored translation of our own English wording; no
#: standards body wrote it.
GERMAN_PROVENANCE = {
    "kosit": ("title/requires = official KoSIT XRechnung <sch:assert> text "
              "(verbatim); fix = project translation"),
    "translation": ("project-authored translation of the English wording; no "
                    "official German text exists for this rule, so 'requires' "
                    "stays English"),
    None: "no German in the catalog for this rule — shown in English",
}


def format_explain(rule_id, catalog=None, lang="en"):
    """Render the remediation-catalog entry for ``rule_id`` as a plain-text
    block, or return ``None`` if the id is not catalogued.

    Every printed field is taken verbatim from ``remediation_catalog.json``
    (the single source of remediation truth) — this function invents no rule
    meaning of its own. Lookup is case-insensitive and matched against the
    catalog keys (the fireable rule ids, e.g. ``BR-01``, ``BR-DE-15``,
    ``BR-DE-23-a``), and the canonical key is echoed back in the output.

    With no ``catalog`` argument the DEFENSIVE module accessor supplies it, so
    an installation whose catalog file is missing/unreadable yields an empty
    mapping and this returns ``None`` (the caller reports it) rather than
    raising ``FileNotFoundError`` at the user.

    ``lang`` selects which of the catalog's SHIPPED strings are printed and is
    a pure display choice — the rule id, the BT/BG terms, the location hint,
    the severity and the Schematron provenance are language-independent facts
    and are byte-identical in both languages. ``lang="en"`` (the default, and
    what every caller that omits the argument gets) is the historical block,
    unchanged to the byte. ``lang="de"`` swaps in:

      * ``requires`` — through :func:`einvoice.remediation.resolve_message`,
        the SAME resolver ``einvoice validate --lang de`` uses, so this line is
        the official KoSIT German for the ~50 rules that have one and falls
        back to the English requirement for every other rule rather than
        inventing German;
      * the header title and ``fix`` — the catalog's ``title_de`` / ``fix_de``,
        which every entry carries;
      * an extra ``german`` line naming the PROVENANCE of what was just printed
        (see :data:`GERMAN_PROVENANCE`), because "official standards text" and
        "our own translation" are very different things to an adopter arguing
        with a German tax authority, and the block would otherwise present them
        identically.

    Nothing is translated at runtime and no German is generated here: every
    German byte is a lookup of a string ``gen_remediation.py`` already committed.
    An unrecognised ``lang`` renders as English (callers reject unknown values
    with a usage error before reaching this function).
    """
    if catalog is None:
        catalog = _remediation_catalog()
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

    title = entry.get("title", "")
    requires = entry.get("requires", "") or "(not stated)"
    fix = entry.get("fix", "") or "(none given)"
    german_line = None
    if lang == "de":
        # Shipped German only. resolve_message() returns the official KoSIT
        # message where the rule has one and the English argument otherwise —
        # the identical fallback `validate --lang de` performs.
        requires = resolve_message(canonical, requires, "de", catalog=catalog)
        title = entry.get("title_de") or title
        fix = entry.get("fix_de") or fix
        de_source = entry.get("de_source")
        if de_source not in GERMAN_PROVENANCE:
            # Unknown provenance tag: report it rather than silently claiming
            # one of the two we understand.
            german_line = "de_source %r — provenance not recognised" % de_source
        else:
            german_line = GERMAN_PROVENANCE[de_source]

    lines = [
        "%s  %s" % (canonical, title),
        "",
        "  requires : %s" % requires,
        "  BT/BG    : %s" % (", ".join(bt_bg) if bt_bg else "(none)"),
        "  location : %s" % (entry.get("location_hint", "") or "(unspecified)"),
        "  fix      : %s" % fix,
        "  severity : %s" % (entry.get("severity", "") or "(unspecified)"),
        "  source   : %s (Schematron)" % prov_source,
    ]
    if german_line:
        lines.append("  german   : %s" % german_line)
    if prov_assert:
        lines.append("  assert   : %s" % prov_assert)
    return "\n".join(lines) + "\n"


def render_report(report, fmt, pretty=False, lang="en"):
    """Render a SINGLE-FILE report dict as the exact text ``--format <fmt>``
    emits, and return it as a string (nothing is written or validated here).

    THE one emitter dispatch. :func:`main` writes ``render_report(...)`` verbatim
    for the single-file leg, and :mod:`einvoice.cli`'s ``validate --format``
    calls this same function — so the nine format bodies have exactly ONE
    implementation and one dispatch table. Registering a new emitter here
    therefore reaches BOTH entry points; there is no second copy to update and
    no way for the two surfaces to drift a byte apart.

    ``fmt`` must be a member of :data:`REPORT_FORMATS` (callers validate it and
    report a usage error for anything else); ``pretty`` only affects the default
    ``json`` form, exactly as the ``--pretty`` flag always has (indent=2 +
    sorted keys instead of the compact separators).

    ``lang`` (keyword-defaulted to ``"en"``, so every existing call site is
    unchanged) reaches only the two HUMAN formats in
    :data:`LOCALISED_FORMATS` — ``html`` and ``text``. Every format named in
    :data:`LANGUAGE_NEUTRAL_FORMATS` is rendered as if ``lang="en"`` no matter
    what was asked for, which is enforced HERE, once, by consulting that
    tuple — not restated per emitter, and not left to each emitter's discretion
    (that is how a new machine format would drift into localising its message
    and silently re-keying every consumer's fingerprints and diffs). The
    partition is total over :data:`REPORT_FORMATS` by construction, so a newly
    registered emitter is either declared machine-facing there or lands in
    ``LOCALISED_FORMATS`` and must take the ``lang`` this function passes it.
    """
    if fmt in LANGUAGE_NEUTRAL_FORMATS:
        lang = "en"
    if fmt == "junit":
        return build_junit(report)
    if fmt == "sarif":
        return json.dumps(build_sarif(report), indent=2, sort_keys=True) + "\n"
    if fmt == "gitlab":
        return json.dumps(build_gitlab(report), indent=2, sort_keys=True) + "\n"
    if fmt == "github":
        return build_github(report)
    if fmt == "azure":
        return build_azure(report)
    if fmt == "html":
        return build_html(report, lang=lang)
    if fmt == "badge":
        return json.dumps(build_badge(report), indent=2, sort_keys=True) + "\n"
    if fmt == "text":
        return build_text(report, lang=lang)
    if pretty:
        return json.dumps(report, indent=2, sort_keys=True) + "\n"
    return json.dumps(report, separators=(",", ":")) + "\n"


def render_batch(batch, fmt, pretty=False):
    """Render an aggregate BATCH dict as the exact text ``--format <fmt>`` emits
    for a directory input, and return it as a string.

    The batch counterpart of :func:`render_report` and, like it, the single
    dispatch: :func:`main`'s directory leg writes this verbatim. ``fmt`` must be
    one of :data:`BATCH_FORMATS` — the batch-capable subset of the registry (the
    other six emitters describe ONE invoice: a SARIF run, a Code-Quality array
    or an HTML page for a whole directory has no defined shape here, so callers
    reject those with an actionable usage error instead of inventing one).
    """
    if fmt == "junit":
        return build_junit_batch(batch)
    if fmt == "text":
        return build_batch_text(batch)
    if pretty:
        return json.dumps(batch, indent=2, sort_keys=True) + "\n"
    return json.dumps(batch, separators=(",", ":")) + "\n"


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
    lang = "en"
    saw_lang = False
    rest = []
    i = 0
    while i < len(args):
        a = args[i]
        # --help / -h is answered BEFORE any path or flag-value resolution, so
        # it works from anywhere on argv and never reaches the positional check
        # (which used to answer a documented entry point's `--help` with the
        # nonsense "error: no such file: --help"). Help is a SUCCESSFUL,
        # requested output: USAGE to STDOUT, exit 0. The BARE invocation keeps
        # its pinned contract (USAGE to stderr, non-zero) — it is an error, not
        # a request.
        if a in ("--help", "-h"):
            sys.stdout.write(USAGE + "\n")
            return EXIT_OK
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
        # --lang is accepted HERE, in the shared parser, purely so ``--explain``
        # can be read in German (T-VHERG.6). It is rejected below for every
        # other mode of THIS entry point rather than silently ignored, and the
        # refusal names the surface that does honour it: a flag swallowed
        # without effect is how a user comes to believe a translation happened.
        # (The console script's ``validate --lang de --format html|text`` DOES
        # render German — see :data:`LOCALISED_FORMATS`. This entry point keeps
        # its refusal because its published contract is the machine document;
        # that divergence is row "lang" of cli.ENTRY_POINT_CAPABILITIES.)
        if a == "--lang":
            if i + 1 >= len(args):
                sys.stderr.write("error: --lang needs a value\n" + USAGE + "\n")
                return EXIT_FAIL
            lang = args[i + 1]
            saw_lang = True
            i += 2
            continue
        if a.startswith("--lang="):
            lang = a.split("=", 1)[1]
            saw_lang = True
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
        if lang not in SUPPORTED_LANGS:
            sys.stderr.write("error: unknown lang %r (choose from %s)\n%s\n"
                             % (lang, ", ".join(SUPPORTED_LANGS), USAGE))
            return EXIT_FAIL
        # An installation with NO usable catalog (missing/unreadable
        # remediation_catalog.json) is a different failure from "that id is
        # not catalogued": say so honestly in one line instead of blaming the
        # user's rule id — and never a traceback.
        catalog = _remediation_catalog()
        if not catalog:
            sys.stderr.write(
                "error: no remediation catalog available in this installation "
                "(remediation_catalog.json is missing or unreadable) — "
                "--explain has nothing to look %r up in\n" % explain_id)
            return EXIT_FAIL
        block = format_explain(explain_id, catalog, lang=lang)
        if block is None:
            sys.stderr.write(
                "error: unknown rule id %r — not in the remediation catalog "
                "(remediation_catalog.json)\n" % explain_id)
            return EXIT_FAIL
        sys.stdout.write(block)
        return EXIT_OK

    # DECLARED DIVERGENCE, not an oversight: this refusal is row "lang" of
    # ``einvoice.cli.ENTRY_POINT_CAPABILITIES``, the one place that says which
    # flags each entry point takes and why the asymmetric ones are asymmetric.
    # The wording below is pinned (test_lang.py, test_entry_point_matrix.py) —
    # a language flag silently swallowed by a machine-facing document is how a
    # user comes to believe a translation happened.
    if saw_lang:
        sys.stderr.write(
            "error: --lang applies only to --explain; a report document is "
            "machine-facing and language-neutral (use 'einvoice validate "
            "--lang de' for a German human summary)\n%s\n" % USAGE)
        return EXIT_FAIL

    if fmt not in REPORT_FORMATS:
        sys.stderr.write(
            "error: unknown format %r (choose from %s)\n%s\n"
            % (fmt, ", ".join(REPORT_FORMATS), USAGE))
        return EXIT_FAIL

    if profile not in PROFILES:
        sys.stderr.write("error: unknown profile %r (choose from %s)\n%s\n"
                         % (profile, ", ".join(PROFILES), USAGE))
        return EXIT_FAIL

    if baseline_path is not None and fmt in ("junit", "sarif", "gitlab",
                                             "github", "azure", "html",
                                             "badge", "text"):
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
        if fmt not in BATCH_FORMATS:
            sys.stderr.write(
                "error: --format %s validates a single file; use "
                "%s for a directory\n" % (fmt, "/".join(BATCH_FORMATS)))
            return EXIT_FAIL
        batch = build_batch_report(path, profile=profile)
        sys.stdout.write(render_batch(batch, fmt, pretty))
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
            declared = check_baseline_profile(baseline, profile, baseline_path)
        except BaselineError as exc:
            sys.stderr.write("error: %s\n" % exc)
            return EXIT_FAIL
        if declared is None:
            # Legacy / undeclared baseline: the diff runs exactly as before,
            # but the precondition goes on the record instead of being assumed.
            sys.stderr.write(BASELINE_PROFILE_UNCHECKED % (baseline_path,
                                                           profile))
        diff = build_diff(path, baseline, profile=profile,
                          baseline_path=baseline_path)
        if pretty:
            sys.stdout.write(json.dumps(diff, indent=2, sort_keys=True) + "\n")
        else:
            sys.stdout.write(json.dumps(diff, separators=(",", ":")) + "\n")
        if diff.get("error"):
            return EXIT_PARSE
        return EXIT_OK if diff["new_fatal_count"] == 0 else EXIT_FAIL

    # MEASURED defect this fixes (2026-07-17, T-VHOSERR.2): a file that
    # passes the isfile() check above but cannot be READ (e.g. chmod 000)
    # made open() inside build_report raise a raw PermissionError traceback
    # on stderr — the only OS-error input class that broke the machine-format
    # stdout discipline (every other class already emitted EMPTY stdout plus
    # one ``error:`` diagnostic line on stderr). This arm catches exactly the
    # OSError family at the read boundary — BEFORE any format emitter has
    # written a byte, so stdout stays completely empty and no half-emitted
    # json/junit/sarif/gitlab document can ever reach a parser. Same
    # discipline (and message shape) as the cli.py single-file arm from
    # T-VHOSERR.1; the exit code stays this surface's measured, documented
    # EXIT_FAIL (1) — identical to the nonexistent-path row above, no new
    # exit code is minted. BrokenPipeError cannot originate here (nothing has
    # been written to stdout yet), so no re-raise arm is needed.
    try:
        report = build_report(path, profile=profile)
    except OSError as exc:
        sys.stderr.write("error: cannot read %s: %s\n"
                         % (path, exc.strerror or exc))
        return EXIT_FAIL
    sys.stdout.write(render_report(report, fmt, pretty))

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

#!/usr/bin/env python3
"""Measure + surface the KoSIT XRechnung test-suite conformance headline.

This generator answers one distinct, buyer-facing question:

    *Does the einvoice engine classify KoSIT's OWN official test documents
    exactly as the suite labels them?*

Every file under ``corpus/xrechnung-testsuite/src/test/**`` is, per the
suite's own ``README.md`` and ``src/doc/test-overview.md``, a **positive
reference instance** — so the label the suite assigns to each applicable
document is *valid*. This script enumerates every such document, classifies
each one end-to-end with the **public** engine entry point
(:func:`einvoice.validate_file`, ``profile="xrechnung"``), and writes a
byte-reproducible, sorted ``testsuite_conformance.json`` recording, per
document: its path, syntax (UBL / CII), category (cvd / cius / standard /
extension), the guideline it declares, the engine verdict, and — for every
document the engine does NOT accept — the exact machine-readable reason
(the firing fatal rule id(s), plus a scope tag when the document declares a
guideline the engine explicitly does not target).

Both syntax bindings are shipped and tested, so each document is classified
through the engine that owns its syntax: UBL documents through the public
:func:`einvoice.validate_file`; CII (UN/CEFACT, ``*_uncefact.xml``) documents
through the SAME shipped CII path the PDF-container and golden-snapshot tests
exercise — :func:`einvoice.report._report_from_invoice_bytes`, which dispatches
a ``CrossIndustryInvoice`` root to ``parser_cii.build_model`` + the
syntax-agnostic ``rules.ALL_RULES`` core + ``rules_xrechnung.evaluate_cii``
(German CIUS). No rule logic is re-implemented here.

It is a MEASUREMENT tool. It changes no rule and bends no label. If a
genuinely in-scope plain-CIUS positive document were rejected on a rule we
claim to cover, that is recorded as an honest divergence (scope class
``in-scope-divergence``) and the measured headline drops accordingly — it is
NEVER papered over.

Scope of the citable headline
-----------------------------
The engine targets the **plain EN 16931 / XRechnung-standard CIUS**
(CustomizationID ``...#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0`` with no
further guideline segment) in **both** the UBL and the CII (UN/CEFACT) syntax
bindings. The in-scope pass rate is reported SEPARATELY per binding (a UBL
headline and a distinct CII headline) so neither number dilutes the other.
Two families of suite documents are, honestly, out of that scope — in EITHER
syntax — and are machine-listed as such rather than hidden:

* **XRechnung EXTENSION guideline** documents (CustomizationID contains
  ``:extension:``) — a different guideline (sub-invoice-line / construction /
  third-party-payment extension) than the plain CIUS the engine targets.
* **XRechnung CVD monitoring guideline** documents (CustomizationID contains
  ``xrechnung:cvd``) — a specialised profile the engine does not implement.

Standard library only. No network, deterministic output.
"""

from __future__ import annotations

import glob
import json
import os
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
TESTSUITE_ROOT = os.path.join(
    HERE, "corpus", "xrechnung-testsuite", "src", "test")
JSON_PATH = os.path.join(HERE, "testsuite_conformance.json")

#: The engine profile the suite targets (XRechnung CIUS = EN 16931 core rules
#: PLUS the German national BR-DE-* layer).
PROFILE = "xrechnung"

sys.path.insert(0, HERE)
import einvoice  # noqa: E402  (local package; sys.path set above)
from einvoice import report as _report  # noqa: E402  (shipped CII engine path)


# --------------------------------------------------------------------------- #
# Per-document facts
# --------------------------------------------------------------------------- #
def enumerate_documents():
    """Every ``*.xml`` under the test-suite ``src/test/`` tree, sorted.

    Returns POSIX, einvoice-root-relative paths so the artifact is identical
    regardless of the absolute checkout location.
    """
    paths = glob.glob(os.path.join(TESTSUITE_ROOT, "**", "*.xml"),
                      recursive=True)
    rels = [os.path.relpath(p, HERE).replace(os.sep, "/") for p in paths]
    return sorted(rels)


def _syntax(rel_path):
    if rel_path.endswith("_ubl.xml"):
        return "UBL"
    if rel_path.endswith("_uncefact.xml"):
        return "CII"
    return "unknown"


def _category(rel_path):
    """The suite's own directory taxonomy: cvd / cius / standard / extension."""
    parts = rel_path.split("/")
    # .../src/test/<group>/<category>/<file>
    try:
        i = parts.index("test")
        return parts[i + 2]
    except (ValueError, IndexError):
        return "unknown"


def _local(tag):
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _extract_customization_id(abs_path):
    """The declared guideline string.

    UBL carries it in ``cbc:CustomizationID``; CII carries it in
    ``ram:GuidelineSpecifiedDocumentContextParameter/ram:ID``. Matched by
    local name so the namespace prefix is irrelevant. Returns ``""`` if none
    is found (never raises for a merely-unexpected shape).
    """
    try:
        root = ET.parse(abs_path).getroot()
    except ET.ParseError:
        return ""
    # UBL: a top-ish CustomizationID element.
    for el in root.iter():
        if _local(el.tag) == "CustomizationID" and (el.text or "").strip():
            return el.text.strip()
    # CII: GuidelineSpecifiedDocumentContextParameter/ID.
    for el in root.iter():
        if _local(el.tag) == "GuidelineSpecifiedDocumentContextParameter":
            for child in el:
                if _local(child.tag) == "ID" and (child.text or "").strip():
                    return child.text.strip()
    return ""


def _guideline(customization_id):
    """Classify the declared guideline from its CustomizationID string."""
    cid = customization_id
    if ":extension:" in cid:
        return "xrechnung-3.0-extension"
    if "xrechnung:cvd" in cid or ":cvd_" in cid or cid.rstrip().endswith("cvd"):
        return "xrechnung-cvd"
    if cid.endswith("xrechnung_3.0"):
        return "xrechnung-3.0"
    if "xrechnung_3.0" in cid:
        # Some further, unrecognised guideline segment after the plain CIUS id.
        return "other-xrechnung-guideline"
    return "unknown"


def _scope_class(syntax, guideline):
    """The applicability bucket of a document relative to the engine's claim.

    Syntax-agnostic: both the UBL and the CII (UN/CEFACT) bindings are shipped
    and tested, so a document's bucket is decided purely by the guideline it
    declares — exactly the same way for both syntaxes. ``in-scope-plain-cius``
    is the only in-scope bucket (the per-syntax split of the headline is done
    downstream in :func:`build_summary`). A syntax that is neither UBL nor CII
    is the only genuinely unsupported-syntax case.
    """
    if syntax not in ("UBL", "CII"):
        return "unsupported-syntax"
    if guideline == "xrechnung-3.0-extension":
        return "extension-guideline-out-of-scope"
    if guideline == "xrechnung-cvd":
        return "cvd-guideline-out-of-scope"
    if guideline == "xrechnung-3.0":
        return "in-scope-plain-cius"
    return "unsupported-guideline"


def _fatal_rule_ids(result):
    ids = {v.rule_id for v in result.violations
           if getattr(v, "severity", "fatal") == "fatal"}
    return sorted(ids)


def _reason(scope_class, fatal_rule_ids):
    """A non-empty, machine-readable reason for a NON-accepted document.

    Never returns an empty string — silence is the one forbidden outcome.
    """
    rules = ", ".join(fatal_rule_ids) if fatal_rule_ids else "(no fatal rule)"
    if scope_class == "unsupported-syntax":
        return ("engine targets the UBL and CII (UN/CEFACT) syntaxes; this "
                "document's syntax is not recognised (fatal: %s)" % rules)
    if scope_class == "extension-guideline-out-of-scope":
        return ("document declares the XRechnung EXTENSION guideline, which "
                "the engine does not target (it targets the plain "
                "xrechnung_3.0 CIUS); fatal: %s" % rules)
    if scope_class == "cvd-guideline-out-of-scope":
        return ("document declares the XRechnung CVD monitoring guideline, a "
                "specialised profile the engine does not implement; fatal: %s"
                % rules)
    if scope_class == "unsupported-guideline":
        return ("document declares a guideline the engine does not target; "
                "fatal: %s" % rules)
    # in-scope-plain-cius that was rejected == an HONEST divergence.
    return ("in-scope plain-CIUS positive document rejected by the engine on "
            "%s — recorded as an honest divergence (a correctness fix is the "
            "separate task T-VHCONF.2); the measured headline is pinned to the "
            "lower, real number and this rule is NOT bent to force a pass"
            % rules)


def _classify_cii(abs_path, rel_path):
    """Classify a CII (UN/CEFACT) document through the SHIPPED CII engine path.

    Reuses :func:`einvoice.report._report_from_invoice_bytes` verbatim — the
    exact end-to-end path ``test_golden_snapshot`` and ``test_rules_cii``
    exercise. That helper dispatches a ``CrossIndustryInvoice`` root to
    ``parser_cii.build_model`` + the syntax-agnostic ``rules.ALL_RULES`` core
    rules + (profile=xrechnung) ``rules_xrechnung.evaluate_cii`` for the German
    CIUS layer. This RE-IMPLEMENTS no rule logic; it feeds the raw bytes into
    the shipped engine and reads back the verdict, exactly mirroring how the UBL
    path decides accepted/rejected. NOT ``validate_file`` (which forces a UBL
    root and would trip a structural ``S-ROOT`` on any CII document).
    """
    with open(abs_path, "rb") as fh:
        xml_bytes = fh.read()
    rep = _report._report_from_invoice_bytes(xml_bytes, rel_path, PROFILE)
    accepted = bool(rep["valid"])
    fatal = sorted({r["rule"] for r in rep["violations"]
                    if r.get("severity") == "fatal"})
    return accepted, fatal


def classify_document(rel_path):
    """Full per-document record."""
    abs_path = os.path.join(HERE, rel_path)
    syntax = _syntax(rel_path)
    category = _category(rel_path)
    cid = _extract_customization_id(abs_path)
    guideline = _guideline(cid)
    scope_class = _scope_class(syntax, guideline)

    if syntax == "CII":
        # CII goes through the shipped CII engine (parser_cii + rules.ALL_RULES
        # + rules_xrechnung.evaluate_cii), NOT validate_file's UBL-only path.
        accepted, fatal = _classify_cii(abs_path, rel_path)
    else:
        result = einvoice.validate_file(abs_path, profile=PROFILE)
        accepted = bool(result.valid)
        fatal = _fatal_rule_ids(result)

    rec = {
        "path": rel_path,
        "syntax": syntax,
        "category": category,
        "guideline": guideline,
        "customization_id": cid,
        "scope_class": scope_class,
        "in_scope": scope_class == "in-scope-plain-cius",
        "verdict": "valid" if accepted else "invalid",
        "accepted": accepted,
        "fatal_rule_ids": fatal,
        # Present (non-empty) iff the engine did NOT accept the document.
        "reason": None if accepted else _reason(scope_class, fatal),
    }
    return rec


# --------------------------------------------------------------------------- #
# Aggregation
# --------------------------------------------------------------------------- #
def _tally(values):
    out = {}
    for v in values:
        out[v] = out.get(v, 0) + 1
    return dict(sorted(out.items()))


def build_summary(documents):
    """Deterministic summary counts — the drift-guarded headline inputs."""
    in_scope = [d for d in documents if d["in_scope"]]
    in_scope_accepted = [d for d in in_scope if d["accepted"]]
    in_scope_rejected = [d for d in in_scope if not d["accepted"]]
    not_accepted = [d for d in documents if not d["accepted"]]

    # The headline is stated SEPARATELY per syntax binding (UBL, CII) so the
    # long-standing UBL number is never diluted and the freshly-classified CII
    # number is legible on its own. Both bindings are shipped and tested.
    ubl_in_scope = [d for d in in_scope if d["syntax"] == "UBL"]
    cii_in_scope = [d for d in in_scope if d["syntax"] == "CII"]

    summary = {
        "total_documents": len(documents),
        "by_syntax": _tally(d["syntax"] for d in documents),
        "by_category": _tally(d["category"] for d in documents),
        "by_scope_class": _tally(d["scope_class"] for d in documents),
        "engine_valid": sum(1 for d in documents if d["accepted"]),
        "engine_invalid": len(not_accepted),
        "not_accepted": len(not_accepted),
        "in_scope_total": len(in_scope),
        "in_scope_accepted": len(in_scope_accepted),
        "in_scope_rejected": len(in_scope_rejected),
        "in_scope_ubl_total": len(ubl_in_scope),
        "in_scope_ubl_accepted": sum(1 for d in ubl_in_scope if d["accepted"]),
        "in_scope_ubl_rejected": sum(1 for d in ubl_in_scope
                                     if not d["accepted"]),
        "in_scope_cii_total": len(cii_in_scope),
        "in_scope_cii_accepted": sum(1 for d in cii_in_scope if d["accepted"]),
        "in_scope_cii_rejected": sum(1 for d in cii_in_scope
                                     if not d["accepted"]),
        "out_of_scope_total": len(documents) - len(in_scope),
    }
    return summary


def build_headline(summary):
    """The citable headline, stated SEPARATELY for each syntax binding.

    The top-level (UBL) claim is kept verbatim so the long-standing "39 of 39"
    number never drifts; a distinct ``cii`` sub-headline reports the freshly
    classified CII (UN/CEFACT) in-scope pass rate on its own. Both are measured
    end-to-end through the shipped engine, never asserted.
    """
    un = summary["in_scope_ubl_accepted"]
    ud = summary["in_scope_ubl_total"]
    cn = summary["in_scope_cii_accepted"]
    cd = summary["in_scope_cii_total"]
    return {
        "scope": ("plain EN 16931 / XRechnung-standard CIUS in UBL syntax "
                  "(CustomizationID ends in xrechnung_3.0)"),
        "accepted": un,
        "applicable": ud,
        "text": ("%d of %d official KoSIT XRechnung test-suite documents that "
                 "are in scope for this engine (the plain xrechnung_3.0 CIUS "
                 "in UBL syntax) are classified exactly as the suite labels "
                 "them — i.e. accepted as valid" % (un, ud)),
        "cii": {
            "scope": ("plain EN 16931 / XRechnung-standard CIUS in CII "
                      "(UN/CEFACT) syntax (CustomizationID ends in "
                      "xrechnung_3.0)"),
            "accepted": cn,
            "applicable": cd,
            "text": ("%d of %d in-scope CII (UN/CEFACT) official KoSIT "
                     "XRechnung test-suite documents (the plain xrechnung_3.0 "
                     "CIUS in CII syntax), routed through the shipped CII engine "
                     "(parser_cii + rules.ALL_RULES + "
                     "rules_xrechnung.evaluate_cii), are classified exactly as "
                     "the suite labels them — i.e. accepted as valid"
                     % (cn, cd)),
        },
        "out_of_scope_machine_listed": summary["out_of_scope_total"],
    }


def build_report():
    """The complete artifact dict (single source of truth for the test)."""
    documents = [classify_document(p) for p in enumerate_documents()]
    documents.sort(key=lambda d: d["path"])
    summary = build_summary(documents)
    report = {
        "_about": ("End-to-end classification of the KoSIT XRechnung "
                   "test-suite's own official POSITIVE reference documents by "
                   "the shipped einvoice engine (profile=xrechnung). UBL "
                   "documents run through einvoice.validate_file; CII "
                   "(UN/CEFACT) documents run through the shipped CII engine "
                   "path report._report_from_invoice_bytes (parser_cii + "
                   "rules.ALL_RULES + rules_xrechnung.evaluate_cii). Every "
                   "applicable document's expected label is 'valid'. Regenerate "
                   "with gen_testsuite_conformance.py; drift-guarded by "
                   "test_testsuite_conformance.py."),
        "provenance": {
            "corpus": "KoSIT itplr-kosit/xrechnung-testsuite (Apache-2.0)",
            "vendored_at": "corpus/xrechnung-testsuite/",
            "xrechnung_version": "3.0.x",
            "see": "PROVENANCE.md, COVERAGE.md",
            "label_convention": ("every document under src/test/** is a "
                                 "POSITIVE reference instance per the suite "
                                 "README and src/doc/test-overview.md"),
        },
        "engine": {
            "entry_point": "einvoice.validate_file",
            "cii_entry_point": ("einvoice.report._report_from_invoice_bytes "
                                "(parser_cii.build_model + rules.ALL_RULES + "
                                "rules_xrechnung.evaluate_cii)"),
            "profile": PROFILE,
            "targets": ("plain EN 16931 / XRechnung-standard CIUS in BOTH the "
                        "UBL and the CII (UN/CEFACT) syntax bindings; the "
                        "extension and CVD guidelines are out of scope in either "
                        "syntax and are machine-listed below"),
        },
        "headline": build_headline(summary),
        "summary": summary,
        "documents": documents,
    }
    return report


def render_json(report):
    return json.dumps(report, ensure_ascii=False, indent=2,
                      sort_keys=True) + "\n"


def main(argv):
    report = build_report()
    json_text = render_json(report)
    if "--check" in argv:
        cur = (open(JSON_PATH, encoding="utf-8").read()
               if os.path.exists(JSON_PATH) else None)
        if cur != json_text:
            sys.stderr.write(
                "stale (re-run gen_testsuite_conformance.py): "
                "testsuite_conformance.json\n")
            return 1
        print("testsuite_conformance.json up to date: %s"
              % report["headline"]["text"])
        return 0
    with open(JSON_PATH, "w", encoding="utf-8") as fh:
        fh.write(json_text)
    # Status goes to stderr so stdout is the pure, byte-reproducible artifact:
    # `gen_testsuite_conformance.py > file` yields exactly the committed JSON.
    sys.stderr.write("wrote %s — %s\n"
                     % (os.path.basename(JSON_PATH),
                        report["headline"]["text"]))
    sys.stdout.write(json_text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

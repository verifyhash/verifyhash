"""Coverage-matrix helpers: enumerate the engine's fireable rule ids and render
the human-readable COVERAGE.md deterministically from coverage_matrix.json.

Standard library only. This module is intentionally split in two concerns:

* :func:`engine_fireable_ids` reads the LIVE rule registries
  (``einvoice.rules.ALL_RULES`` + ``einvoice.rules_xrechnung.ALL_RULES`` +
  ``einvoice.rules_xrechnung.CII_DE_RULES``) and returns the exact set of rule
  ids the validator can emit. It is the single programmatic source of truth the
  coverage test compares the published matrix against — nothing here is
  hand-copied, so a rule added to / removed from the engine is caught.

* :func:`render_markdown` turns a parsed ``coverage_matrix.json`` document into
  the exact bytes of ``COVERAGE.md`` — a pure, deterministic function of its
  input (no clock, no environment, stable ordering) so the two artifacts can
  never silently drift (the test regenerates in-memory and asserts equality).

The matrix DATA (syntax tag, severity, Schematron provenance) is produced by the
repo-root ``gen_coverage.py`` build script, which derives every field from the
same registries plus ``differential.py``'s differentially-proven graded sets;
this module deliberately does not depend on that build path so that rendering
stays a trivial, side-effect-free transform of the committed JSON.
"""

from __future__ import annotations

import json
import os

from . import rules as _rules
from . import rules_xrechnung as _rules_xr


# --------------------------------------------------------------------------- #
# Programmatic rule-id enumeration straight off the live registries.          #
# --------------------------------------------------------------------------- #
def _core_rule_id(fn):
    """``br_01`` -> ``BR-01``.

    Core rule functions carry their id only inside the ``Violation`` they emit;
    the id is also the first token of the one-line docstring summary
    (``\"BR-01: An Invoice shall ...\"``), which is the convention the whole
    module relies on. Read it there rather than firing the rule.
    """
    doc = (fn.__doc__ or "").strip()
    head = doc.split(":", 1)[0].strip()
    if not head.startswith("BR-"):
        raise ValueError(
            "core rule %r has no 'BR-...:' docstring id (got %r)"
            % (getattr(fn, "__name__", fn), head))
    return head


def core_rule_ids():
    """Set of core EN 16931 rule ids (``einvoice.rules.ALL_RULES``)."""
    return {_core_rule_id(fn) for fn in _rules.ALL_RULES}


def ubl_de_rule_ids():
    """Set of German CIUS + extension rule ids fired over UBL
    (``einvoice.rules_xrechnung.ALL_RULES`` — BR-DE-* and BR-DEX-*)."""
    return {fn.rule_id for fn in _rules_xr.ALL_RULES}


def cii_de_rule_ids():
    """Set of German CIUS rule ids fired over CII
    (``einvoice.rules_xrechnung.CII_DE_RULES``). A subset of the UBL layer."""
    return {fn.rule_id for fn in _rules_xr.CII_DE_RULES}


def engine_fireable_ids():
    """The EXACT set of rule ids the validator can emit across every syntax.

    Union of the core ruleset, the UBL German-CIUS/extension layer and the CII
    German-CIUS layer. The CII layer is a subset of the UBL one, so it adds no
    new ids, but it is unioned explicitly so the intent is legible.
    """
    return core_rule_ids() | ubl_de_rule_ids() | cii_de_rule_ids()


def matrix_rule_ids(matrix):
    """Set of rule ids declared in a parsed coverage-matrix document."""
    return {r["id"] for r in matrix["rules"]}


# --------------------------------------------------------------------------- #
# Loading.                                                                    #
# --------------------------------------------------------------------------- #
def default_matrix_path():
    """Path to the committed ``coverage_matrix.json`` next to the package."""
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "coverage_matrix.json")


def load_matrix(path=None):
    """Parse ``coverage_matrix.json`` (defaults to the committed artifact)."""
    if path is None:
        path = default_matrix_path()
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


# --------------------------------------------------------------------------- #
# Deterministic COVERAGE.md rendering.                                        #
# --------------------------------------------------------------------------- #
def _syntax_label(syntax):
    return {"ubl": "UBL", "cii": "CII", "both": "UBL + CII"}.get(syntax, syntax)


def _proof_cell(prov, syntax_key):
    """One provenance cell: the proving Schematron + version, or an honest
    'not proven' note. ``prov`` is the entry's ``provenance`` object."""
    p = (prov or {}).get(syntax_key)
    if not p:
        return "—"
    if p.get("differentially_proven"):
        return "%s %s" % (p.get("suite", "?"), p.get("version", "?"))
    return "not proven"


def render_markdown(matrix):
    """Render the full COVERAGE.md text from a parsed matrix document.

    Deterministic: output depends only on ``matrix`` (no time, no env). The rule
    rows follow the order rules appear in ``matrix['rules']`` (the build script
    writes them in canonical id order), so JSON order == document order.
    """
    lines = []
    w = lines.append

    w("# einvoice — Conformance Coverage Matrix")
    w("")
    w("<!-- GENERATED FILE — do not edit by hand.")
    w("     Regenerate with `python3 gen_coverage.py` (renders from")
    w("     coverage_matrix.json via einvoice.coverage.render_markdown).")
    w("     test_coverage_matrix.py asserts this file is byte-identical to a")
    w("     fresh render, so any manual edit will fail the gate. -->")
    w("")
    w(matrix["description"].strip())
    w("")

    # --- Schematron ground truth ---
    w("## Normative Schematron ground truth")
    w("")
    w("Every rule below is proven equivalent to an official compiled Schematron")
    w("artifact by `differential.py`, which runs the corpus through the vendored")
    w("XSLT and compares the fired-rule set. The sources:")
    w("")
    w("| key | artifact | version | license |")
    w("| --- | --- | --- | --- |")
    for key in matrix["schematron_sources_order"]:
        s = matrix["schematron_sources"][key]
        w("| `%s` | %s (`%s`) | %s | %s |"
          % (key, s["suite"], s["file"], s["version"], s["license"]))
    w("")

    # --- Summary counts ---
    rules = matrix["rules"]
    n_total = len(rules)
    n_both = sum(1 for r in rules if r["syntax"] == "both")
    n_ubl = sum(1 for r in rules if r["syntax"] == "ubl")
    n_cii = sum(1 for r in rules if r["syntax"] == "cii")
    n_fatal = sum(1 for r in rules if r["severity"] == "fatal")
    n_warn = sum(1 for r in rules if r["severity"] == "warning")
    w("## Coverage at a glance")
    w("")
    w("- **%d business rules** the engine actually asserts (this is the exact set"
      " the code fires — `test_coverage_matrix.py` proves it against the live"
      " registries)." % n_total)
    w("- Syntax: **%d** proven on both UBL and CII, **%d** UBL-only, **%d**"
      " CII-only." % (n_both, n_ubl, n_cii))
    w("- Severity (blocking class): **%d** fatal (block validity), **%d** warning"
      " / information (reported, non-blocking)." % (n_fatal, n_warn))
    w("")

    # --- Rule table ---
    w("## Rules")
    w("")
    w("`syntax` = the syntaxes the rule is *differentially proven* to fire in.")
    w("`severity` = blocking class (fatal blocks validity; warning does not).")
    w("`flag` = the raw normative Schematron flag (`information` is folded into")
    w("the non-blocking `warning` class for the severity column).")
    w("")
    w("| id | syntax | severity | flag | UBL proof | CII proof | rule |")
    w("| --- | --- | --- | --- | --- | --- | --- |")
    for r in rules:
        prov = r.get("provenance") or {}
        w("| `%s` | %s | %s | %s | %s | %s | %s |"
          % (r["id"], _syntax_label(r["syntax"]), r["severity"], r["flag"],
             _proof_cell(prov, "ubl"), _proof_cell(prov, "cii"),
             r["title"].replace("|", "\\|")))
    w("")

    # --- Exclusions ---
    exc = matrix["exclusions"]
    w("## Exclusions (honest scope boundaries)")
    w("")
    w(exc["description"].strip())
    w("")

    w("### Vacuous / tautological rules (never fire — not asserted)")
    w("")
    for e in exc["vacuous"]:
        w("- **%s** — %s" % (e["id"], e["reason"]))
    w("")

    codelist_deferred = exc.get("codelist_not_asserted")
    if codelist_deferred:
        w("### EN 16931 code-list rules present in the Schematron, not yet asserted")
        w("")
        w("These `BR-CL-*` code-list rules exist in the official codes Schematron")
        w("but the engine does not yet assert them; listed so the code-list")
        w("coverage is honest about its boundary. (`BR-CL-16/19/20/21/24` ARE")
        w("asserted and appear in the rule table above.)")
        w("")
        for e in codelist_deferred:
            w("- **%s** — %s" % (e["id"], e["reason"]))
        w("")

    w("### Fired on UBL, not differentially proven on CII")
    w("")
    w("These core rules fire and are proven on the UBL leg; the official CII")
    w("Schematron binds them differently, so they are excluded from the CII")
    w("graded set rather than approximated.")
    w("")
    for e in exc["cii_core_out_of_scope"]:
        w("- **%s** — %s" % (e["id"], e["reason"]))
    w("")

    w("### German CIUS rules fired on UBL, not evaluated on CII")
    w("")
    w("These BR-DE / BR-DEX rules bind CII document parts (payment-means, IBAN,")
    w("skonto grammar, attachments, the extension layer) the syntax-agnostic")
    w("core model does not carry; excluded on the CII leg, still proven on UBL.")
    w("")
    for e in exc["cii_de_out_of_scope"]:
        w("- **%s** — %s" % (e["id"], e["reason"]))
    w("")

    w("### Peppol-only rules")
    w("")
    w(exc["peppol"]["note"].strip())
    w("")

    return "\n".join(lines) + "\n"

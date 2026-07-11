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
import re
import xml.etree.ElementTree as ET

from . import rules as _rules
from . import rules_xrechnung as _rules_xr
from . import rules_peppol as _rules_pep

_SCH_NS = "{http://purl.oclc.org/dsdl/schematron}"
#: The KoSIT-vendored Peppol family id prefix (canonical rule ids AND the
#: per-binding assert ids both start with it; the CII artifact splits R043
#: into two suffixed asserts).
PEPPOL_FAMILY_PREFIX = "PEPPOL-EN16931-R"


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


def peppol_ubl_rule_ids():
    """Canonical PEPPOL-EN16931-R* ids implemented over UBL
    (``einvoice.rules_peppol.UBL_RULES``)."""
    return {fn.rule_id for fn in _rules_pep.UBL_RULES}


def peppol_cii_rule_ids():
    """Canonical PEPPOL-EN16931-R* ids implemented over CII
    (``einvoice.rules_peppol.CII_RULES``; the two R043 CII asserts collapse
    onto the one canonical id a Violation reports)."""
    return {fn.rule_id for fn in _rules_pep.CII_RULES}


def peppol_canonical_id(assert_id):
    """Canonical family id of a vendored ``PEPPOL-EN16931-R*`` assert id: the
    CII artifact splits one rule across suffixed asserts
    (``PEPPOL-EN16931-R043-1`` / ``-2``); everything else is already
    canonical."""
    m = re.match(r"^(PEPPOL-EN16931-R\d+)(-\d+)?$", assert_id)
    return m.group(1) if m else assert_id


def engine_fireable_ids():
    """The EXACT set of rule ids the validator can emit across every syntax.

    Union of the core ruleset, the UBL German-CIUS/extension layer, the CII
    German-CIUS layer and the KoSIT-vendored Peppol batch (canonical ids, both
    bindings). The CII layers are subsets of / identical to their UBL
    counterparts, so they add no new ids, but they are unioned explicitly so
    the intent is legible.
    """
    return (core_rule_ids() | ubl_de_rule_ids() | cii_de_rule_ids()
            | peppol_ubl_rule_ids() | peppol_cii_rule_ids())


def matrix_rule_ids(matrix):
    """Set of rule ids declared in a parsed coverage-matrix document."""
    return {r["id"] for r in matrix["rules"]}


# --------------------------------------------------------------------------- #
# Official rule-id universe: real XML parse of a compiled Schematron file.    #
# --------------------------------------------------------------------------- #
def schematron_assert_index(path):
    """Index every ``<sch:assert>`` of a compiled Schematron file by ``@id``.

    A REAL XML parse (:mod:`xml.etree.ElementTree`), not a regex scrape of
    prose. Returns ``{id: {"flag": str, "text": str, "test": str,
    "vacuous_in_artifact": bool}}`` where

    * ``flag`` is the assert's raw ``@flag`` (``fatal`` when absent, matching
      ISO Schematron's unflagged default in these artifacts),
    * ``text`` is the assert's official rule prose — full element text with
      whitespace collapsed and the redundant leading ``[ID]-`` marker the CEN
      artifacts prepend stripped off,
    * ``test`` is the assert's raw ``@test`` XPath, verbatim (empty string when
      absent) — the evidence field the tautology exclusions quote, and
    * ``vacuous_in_artifact`` is True when the assert's ``@test`` is literally
      ``true()`` (the artifact ships the rule as a tautology that can never
      fire — worth knowing before implementing it).

    The CEN preprocessed artifacts carry each id exactly once; if an id ever
    repeated, the FIRST occurrence in document order would win, keeping the
    result deterministic.
    """
    index = {}
    for a in ET.parse(path).getroot().iter(_SCH_NS + "assert"):
        rid = a.get("id")
        if not rid or rid in index:
            continue
        text = re.sub(r"\s+", " ", "".join(a.itertext())).strip()
        marker = "[%s]-" % rid
        if text.startswith(marker):
            text = text[len(marker):].strip()
        test = a.get("test") or ""
        index[rid] = {
            "flag": a.get("flag") or "fatal",
            "text": text,
            "test": test,
            "vacuous_in_artifact": test.strip() == "true()",
        }
    return index


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
    gap_head = matrix.get("gap")
    taut_head = (matrix.get("exclusions") or {}).get("official_tautology")
    if gap_head and taut_head is not None:
        fm_total = sum(gap_head["artifacts"][k].get("fireable_missing", 0)
                       for k in gap_head["artifact_order"])
        w("- **Fireable missing: %d** in both CEN universes (%s) — every official"
          % (fm_total, ", ".join("`%s`" % k for k in gap_head["artifact_order"])))
        w("  EN 16931 `BR-*` assert that can actually fire is either asserted by"
          " the engine")
        w("  or a documented deliberate exclusion. This is deliberately NOT an"
          " uncaveated")
        w("  100%% claim: **%d official ids (`%s`) are shipped as literal"
          % (len(taut_head),
             "`, `".join(e["id"] for e in taut_head)))
        w("  `test=\"true()\"` tautologies** in the CEN artifacts — asserts that"
          " can never")
        w("  fire, in either universe, so implementing them with a differential"
          " proof is")
        w("  impossible by construction (see the tautology exclusion class below,")
        w("  with verbatim artifact evidence). `test_coverage_gap.py` recomputes")
        w("  fireable-missing live from the vendored `.sch` files and fails if it")
        w("  is ever nonzero.")
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

    tautologies = exc.get("official_tautology")
    if tautologies:
        w("### Official `test=\"true()\"` tautologies (deliberate exclusion "
          "class)")
        w("")
        w("The CEN artifacts ship these %d `BR-*` asserts with the literal test"
          % len(tautologies))
        w("`true()` in BOTH preprocessed universes — an assert that is always")
        w("satisfied and can NEVER fire, whatever the invoice contains, so no")
        w("implementation could ever be differentially proven against it. They")
        w("are excluded by construction rather than implemented on faith.")
        w("Evidence is quoted verbatim from the vendored artifacts:")
        w("")
        for e in tautologies:
            w("- **%s** — %s" % (e["id"], e["reason"]))
            w("  Official rule text: “%s”" % e["official_text"])
            for key in sorted(e["evidence"]):
                ev = e["evidence"][key]
                w("  - `%s`: `%s` line %d — `<assert id=\"%s\" "
                  "test=\"%s\">`"
                  % (key, ev["sch"], ev["line"], ev["assert_id"], ev["test"]))
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

    w("### Peppol scope")
    w("")
    w(exc["peppol"]["note"].strip())
    w("")

    # --- Gap: official rules neither implemented nor excluded ---
    gap = matrix.get("gap")
    if gap:
        w("## Gap — official rules not yet asserted")
        w("")
        w(gap["description"].strip())
        w("")
        w("Deliberate exclusions counted against each universe (%d ids, all"
          % len(gap["excluded_ids_considered"]))
        w("documented with reasons in the Exclusions section above): %s."
          % ", ".join("`%s`" % i for i in gap["excluded_ids_considered"]))
        w("")
        for key in gap["artifact_order"]:
            a = gap["artifacts"][key]
            w("### `%s` — %d implemented + %d excluded + %d missing = %d "
              "official `BR-*` rules"
              % (key, a["implemented"], a["excluded"], a["missing"],
                 a["official_universe"]))
            w("")
            w("Universe parsed from `%s` (`sch:assert/@id`). The same file also"
              % a["source"])
            w("carries %d non-`BR-*` asserts (%s) — syntax-binding cardinality/"
              % (a["non_business_rule_asserts"],
                 ", ".join("`%s-*`" % f for f in a["non_business_rule_families"])))
            w("data-type restrictions, not EN 16931 business rules, so they are")
            w("outside this matrix's scope.")
            w("")
            if "fireable_missing" in a:
                w("**Fireable missing: %d** — missing ids whose official assert"
                  % a["fireable_missing"])
                w("is a real (non-`test=\"true()\"`) test the engine does not yet")
                w("assert and no documented exclusion covers.")
                w("")
            if a["missing_rules"]:
                w("| id | flag | official rule text |")
                w("| --- | --- | --- |")
                for m in a["missing_rules"]:
                    note = (" *(shipped as `test=\"true()\"` in the artifact — a "
                            "tautology that can never fire officially)*"
                            if m["vacuous_in_artifact"] else "")
                    w("| `%s` | %s | %s%s |"
                      % (m["id"], m["flag"], m["text"].replace("|", "\\|"), note))
            else:
                w("**None.** Every official `BR-*` assert in this artifact is"
                  " either")
                w("implemented (differential-proven) or a documented deliberate")
                w("exclusion — including the official `test=\"true()\"`"
                  " tautologies")
                w("listed in the Exclusions section above with verbatim artifact")
                w("evidence.")
            w("")

    # --- KoSIT-vendored Peppol family (enumeration + known-open worklist) ---
    fam = matrix.get("peppol_kosit_family")
    if fam:
        w("## `PEPPOL-EN16931-R*` — %s" % fam["label"])
        w("")
        w(fam["description"].strip())
        w("")
        w("**This is NOT full Peppol BIS Billing 3.0 support** — only the")
        w("asserts the vendored KoSIT artifact itself carries are enumerated,")
        w("implemented, or claimed here.")
        w("")
        for key in fam["artifact_order"]:
            a = fam["artifacts"][key]
            w("### `%s` — %d implemented + %d known-open = %d canonical rules"
              " (%d asserts)"
              % (key, a["implemented"], a["known_open"], a["family_universe"],
                 a["family_asserts"]))
            w("")
            w("Family parsed from `%s` (`sch:assert/@id`)." % a["source"])
            w("")
        w("Implemented (differentially proven per binding, see the rule table"
          " above):")
        w("%s." % ", ".join("`%s`" % i for i in fam["implemented_ids"]))
        w("")
        if fam["known_open_worklist"]:
            w("### Known-open worklist (enumerated, not yet asserted)")
            w("")
            w("These canonical ids are shipped by the vendored KoSIT artifacts")
            w("but not yet implemented — an explicit worklist, not a hidden")
            w("gap. Official rule text is carried verbatim per binding:")
            w("")
            w("| id | binding | assert id | flag | official rule text |")
            w("| --- | --- | --- | --- | --- |")
            for row in fam["known_open_worklist"]:
                for key in fam["artifact_order"]:
                    for a in row["bindings"].get(key, []):
                        w("| `%s` | `%s` | `%s` | %s | %s |"
                          % (row["id"], key, a["assert_id"], a["flag"],
                             a["text"].replace("|", "\\|")))
            w("")
        else:
            w("### Known-open worklist (enumerated, not yet asserted)")
            w("")
            w("**Empty.** Every canonical `PEPPOL-EN16931-R*` id the vendored")
            w("KoSIT artifacts carry is implemented in every binding whose")
            w("artifact ships the assert. The enumeration above stays")
            w("machine-checked, so a future artifact bump that adds a new")
            w("Peppol assert reopens this worklist automatically.")
            w("")

    return "\n".join(lines) + "\n"

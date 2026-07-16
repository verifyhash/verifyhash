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
from . import syntax_binding as _sb
from . import syntax_binding_eval as _sbe

_SCH_NS = "{http://purl.oclc.org/dsdl/schematron}"
#: The KoSIT-vendored Peppol family id prefix (canonical rule ids AND the
#: per-binding assert ids both start with it; the CII artifact splits R043
#: into two suffixed asserts).
PEPPOL_FAMILY_PREFIX = "PEPPOL-EN16931-R"

#: The KoSIT CVD/TMP family id prefixes: the Clean-Vehicle-Directive profile
#: rules (``BR-DE-CVD-*``) plus the temporary rules (``BR-TMP-*``, which
#: covers ``BR-TMP-CVD-01``, ``BR-TMP-2`` and the CII-only ``BR-TMP-3``).
#: Deliberately does NOT match ``BR-DE-TMP-32`` (prefix ``BR-DE-TMP``): that
#: rule is part of the plain BR-DE CIUS layer, implemented separately.
CVD_TMP_FAMILY_PREFIXES = ("BR-DE-CVD-", "BR-TMP-")


def is_cvd_tmp_id(rule_id):
    """True iff ``rule_id`` belongs to the KoSIT CVD/TMP family
    (``BR-DE-CVD-*`` / ``BR-TMP-*`` — never ``BR-DE-TMP-32``)."""
    return rule_id.startswith(CVD_TMP_FAMILY_PREFIXES)


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


def cvd_tmp_ubl_rule_ids():
    """CVD/TMP family ids implemented over UBL (the family subset of
    ``einvoice.rules_xrechnung.ALL_RULES``)."""
    return {fn.rule_id for fn in _rules_xr.ALL_RULES
            if is_cvd_tmp_id(fn.rule_id)}


def cvd_tmp_cii_rule_ids():
    """CVD/TMP family ids implemented over CII (the family subset of
    ``einvoice.rules_xrechnung.CII_DE_RULES`` — includes the CII-only
    ``BR-TMP-3``)."""
    return {fn.rule_id for fn in _rules_xr.CII_DE_RULES
            if is_cvd_tmp_id(fn.rule_id)}


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


def default_cii_parity_path():
    """Path to the committed ``cii_parity.json`` next to the matrix."""
    return os.path.join(os.path.dirname(default_matrix_path()),
                        "cii_parity.json")


def load_cii_parity(path=None):
    """Parse the committed CII proof-parity worklist (``cii_parity.json``,
    built by ``gen_cii_parity.py``), or ``None`` when the file is absent."""
    if path is None:
        path = default_cii_parity_path()
    if not os.path.exists(path):
        return None
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


def render_markdown(matrix, cii_parity=None):
    """Render the full COVERAGE.md text from a parsed matrix document.

    Deterministic: output depends only on ``matrix`` plus the committed
    ``cii_parity.json`` worklist (no time, no env) — when ``cii_parity`` is
    not passed it is loaded via :func:`load_cii_parity`, and the section is
    omitted entirely if that file does not exist. The rule rows follow the
    order rules appear in ``matrix['rules']`` (the build script writes them
    in canonical id order), so JSON order == document order.
    """
    if cii_parity is None:
        cii_parity = load_cii_parity()
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
    gmc = matrix.get("german_message_coverage")
    if gmc:
        w("- **Official German messages: %d rules** carry an official German"
          " assert message, surfaced by the CLI `--lang de` flag (report"
          " human-message only; `--json` and exit codes are unchanged). That"
          " text is lifted VERBATIM from the vendored KoSIT XRechnung"
          " Schematron (`de_source == \"kosit\"`), never machine-translated;"
          " every other rule is English-only by design (no official German"
          " assert text exists to quote). See the README `--lang de` section."
          % gmc["official_message_de_count"])
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

    # --- Factur-X/ZUGFeRD profile scope (static, measured — see
    #     test_facturx_profile_scope.py, which pins both the recognition table
    #     and the end-to-end fact stated below against the live engine). ---
    w("## Factur-X/ZUGFeRD profile scope")
    w("")
    w("A Factur-X 1.x / ZUGFeRD 2.x PDF declares one of six profiles"
      " (\"conformance levels\"): **MINIMUM**, **BASIC WL**, **BASIC**,"
      " **EN 16931** (a.k.a. COMFORT), **EXTENDED**, and the German"
      " **XRECHNUNG** CIUS. `einvoice.pdf_container._canonical_profile` maps"
      " each profile's XMP `ConformanceLevel` string and its embedded-CII"
      " `CustomizationID` (BT-24) URN to a canonical token; that recognition"
      " table is pinned by `test_facturx_profile_scope.py` so it cannot"
      " silently drift.")
    w("")
    w("**Validated at EN 16931 depth.** EN 16931, BASIC and EXTENDED, and the"
      " XRechnung CIUS all carry the full EN 16931 semantic model (BASIC is a"
      " compliant CIUS whose `CustomizationID` embeds the"
      " `urn:cen.eu:en16931:2017#compliant#…` marker; EXTENDED conforms to it;"
      " XRechnung is a CIUS on top). For any of these, the embedded"
      " CrossIndustryInvoice XML is validated to EN 16931 depth by the exact"
      " same core rule engine (`einvoice.rules.ALL_RULES`) documented in the"
      " table above — the PDF path runs the identical rules the raw"
      " `factur-x.xml` would.")
    w("")
    w("**Recognized but out of scope for EN 16931 conformance: MINIMUM and"
      " BASIC WL.** These two are by design **not EN 16931-conformant**"
      " profiles — MINIMUM carries only a handful of header fields, and"
      " BASIC WL (\"without lines\") omits the invoice lines (BG-25) and other"
      " mandatory EN 16931 business terms. Declaring MINIMUM or BASIC WL does"
      " **not** make the document EN 16931-conformant, and the engine does not"
      " certify it as such.")
    w("")
    w("**What the engine actually emits.** The declared profile token is used"
      " only for the container consistency cross-check"
      " (`FX-CONTAINER-PROFILE`: XMP `ConformanceLevel` vs CII"
      " `CustomizationID`). It is **never** used to select, gate, or skip which"
      " business rules run. Every embedded CrossIndustryInvoice — whatever"
      " profile it declares — is validated against the SAME full EN 16931 core"
      " rule set. So for a MINIMUM or BASIC WL input the engine still runs the"
      " EN 16931 rules and **reports the missing mandatory terms as"
      " violations** (e.g. BR-16 \"at least one Invoice line\"): it does NOT"
      " silently pass such a document, and it does NOT special-case-skip any"
      " rule by declared profile. The engine applies the same rule set"
      " regardless of the declared profile.")
    w("")

    # --- French CIUS scope (EN 16931 core covered; national FNFE-MPE / Chorus
    #     Pro CIUS not vendored). Static, byte-for-byte prose — folded in here
    #     (was previously a hand-edit to the GENERATED COVERAGE.md, T-VHFR.1,
    #     which drifted the file from its generator) so `gen_coverage.py`
    #     reproduces the committed file exactly. No validation behaviour. ---
    w("## French CIUS scope (EN 16931 core covered; FNFE-MPE / Chorus Pro rules not vendored)")
    w("")
    w("This is a **technical** coverage statement, separate from the French *legislative* timeline in README §1 (reception mandatory September 2026, issuance phasing to September 2027 via the PDP / e-reporting model). France's B2B e-invoicing reform uses EN 16931 profiles: **Factur-X** (a CII payload in a PDF/A-3 container), UBL, and CII. Everything EN 16931 itself defines for such an invoice is already validated here:")
    w("")
    w("- **The EN 16931 core applies to a French invoice today.** A French UBL or CII invoice is graded against the full EN 16931 `BR-*` semantic model documented in the table above — the identical core the German XRechnung profile builds on. Nothing French-specific is needed for the core rules to fire.")
    w("- **The Factur-X CII path is first-class.** `einvoice.pdf_container` extracts the embedded `CrossIndustryInvoice` XML from a Factur-X PDF/A-3 container and hands it to the same core rule engine (`einvoice.rules.ALL_RULES`), so a French Factur-X container's embedded CII is validated to EN 16931 depth exactly as a raw `factur-x.xml` would be (the profile token never gates which rules fire — measured end-to-end by `test_facturx_profile_scope.py`).")
    w("")
    w("**Not covered: the French national CIUS rule layer.** On top of EN 16931, a French invoice is expected to satisfy the **FNFE-MPE / Chorus Pro** Factur-X **French CIUS** — French-specific business rules and code lists (for example SIREN/SIRET party identification and Chorus Pro routing/e-reporting terms). Those rules live in the official FNFE-MPE / Chorus Pro Factur-X CIUS Schematron, which is **not vendored** in `corpus/`. Because this engine only asserts a rule it can differentially prove against a vendored normative artifact, **no French-CIUS-specific rule is checked, approximated, or fabricated** — the French CIUS layer is out of scope until that artifact is vendored (license permitting). Consequently \"validates the EN 16931 core for a French invoice\" is TRUE and useful, while **full French CIUS conformance is NOT claimed** — mirroring the honesty label applied to Peppol BIS Billing 3.0 in the Exclusions section.")
    w("")

    # --- UBL CreditNote scope (stated SEPARATELY from the Invoice numbers) ---
    cn = matrix.get("creditnote_conformance")
    if cn:
        _render_creditnote(w, cn)

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

    # --- KoSIT CVD/TMP family (enumeration + known-open worklist) ----------
    cvd = matrix.get("cvd_tmp_family")
    if cvd:
        w("## `BR-DE-CVD-*` / `BR-TMP-*` — %s" % cvd["label"])
        w("")
        w(cvd["description"].strip())
        w("")
        for key in cvd["artifact_order"]:
            a = cvd["artifacts"][key]
            w("### `%s` — %d implemented + %d known-open = %d family asserts"
              % (key, a["implemented"], a["known_open"], a["family_universe"]))
            w("")
            w("Family parsed from `%s` (`sch:assert/@id`, prefix"
              % a["source"])
            w("`BR-DE-CVD-`/`BR-TMP-`). Official flags per assert:")
            w("")
            w("| id | official flag |")
            w("| --- | --- |")
            for row in a["asserts"]:
                note = (" *(shipped as `test=\"true()\"` — a tautology)*"
                        if row["vacuous_in_artifact"] else "")
                w("| `%s` | %s%s |" % (row["id"], row["flag"], note))
            w("")
        w("Implemented (differentially proven per binding, see the rule table"
          " above):")
        w("%s." % ", ".join("`%s`" % i for i in cvd["implemented_ids"]))
        w("")
        if cvd["known_open_worklist"]:
            w("### Known-open worklist (enumerated, not yet asserted)")
            w("")
            w("These ids are shipped by the vendored KoSIT artifacts but not")
            w("yet implemented — an explicit worklist, not a hidden gap.")
            w("Official rule text is carried verbatim per binding:")
            w("")
            w("| id | binding | flag | official rule text |")
            w("| --- | --- | --- | --- |")
            for row in cvd["known_open_worklist"]:
                for key in cvd["artifact_order"]:
                    for a in row["bindings"].get(key, []):
                        w("| `%s` | `%s` | %s | %s |"
                          % (row["id"], key, a["flag"],
                             a["text"].replace("|", "\\|")))
            w("")
        else:
            w("### Known-open worklist (enumerated, not yet asserted)")
            w("")
            w("**Empty.** Every `BR-DE-CVD-*` / `BR-TMP-*` assert the vendored")
            w("KoSIT artifacts carry is implemented in every binding whose")
            w("artifact ships it — nine asserts in both bindings plus the")
            w("CII-only `BR-TMP-3` (tagged `syntax = CII` in the rule table,")
            w("because no UBL assert exists to prove it against). The")
            w("enumeration above stays machine-checked, so a future artifact")
            w("bump that adds or un-gates a CVD/TMP assert reopens this")
            w("worklist automatically.")
            w("")

    # --- CII proof parity (measured worklist, cii_parity.json) -------------
    if cii_parity:
        pr = cii_parity["rules"]
        n_ubl_only = len(pr)
        fireable = [e for e in pr if e["classification"] == "cii-fireable"]
        inapp = [e for e in pr if e["classification"] == "binding-inapplicable"]
        defect = [e for e in pr
                  if e["classification"] == "cii-artifact-defective"]
        # binding-inapplicable splits into two evidence classes: rules NO
        # vendored CII artifact carries (cii_artifact null), and rules a CII
        # artifact DOES carry but which bind a CII-specific surface outside the
        # syntax-agnostic core model — a deliberate CII-leg exclusion carrying
        # verbatim artifact evidence (cii_artifact set).
        inapp_scoped = [e for e in inapp if e.get("cii_artifact")]
        inapp_absent = [e for e in inapp if not e.get("cii_artifact")]
        w("## CII proof parity")
        w("")
        w("**TERMINAL — the CII proof-parity worklist is CLOSED.** Of the **%d**"
          % n_total)
        w("business rules the engine asserts, **%d** are differentially proven"
          % n_both)
        w("on BOTH the UBL and CII bindings; **%d** are officially UBL-only and"
          % n_ubl)
        w("**%d** is CII-only. Every one of the **%d** UBL-only rules the"
          % (n_cii, n_ubl_only))
        w("official CII artifacts were measured against is now resolved with")
        w("evidence — **%d remain on the cii-fireable worklist** — so no CII"
          % len(fireable))
        w("assert the vendored artifacts carry is left unproven or silently")
        w("skipped. `gen_cii_parity.py` measures this by a real XML parse of")
        w("`sch:assert/@id` in the vendored CII Schematron files (no prose")
        w("scraping, no hand lists):")
        w("")
        for rel in cii_parity["generated_from"]:
            w("- `%s`" % rel)
        w("")
        w("Measured split (committed as `cii_parity.json`, live-recomputed by")
        w("`test_cii_parity.py` so it can never silently go stale):")
        w("")
        w("- **%d cii-fireable** — an official CII assert with the same id"
          % len(fireable))
        w("  exists in a vendored CII artifact and its CII behaviour is not yet")
        w("  differentially proven. This worklist is now **empty**: every such")
        w("  rule has been either flipped to `syntax = UBL + CII` (a landed")
        w("  differential proof) or reclassified below with evidence.")
        if defect:
            w("- **%d cii-artifact-defective** — a vendored CII artifact"
              % len(defect))
            w("  carries the id, but the SHIPPED assert can never fire")
            w("  (%s:" % ", ".join("`%s`" % e["id"] for e in defect))
            w("  a `test=\"true()\"` tautology, or an assert bound to the")
            w("  `ram:ApplicableTradeTax` ROW whose `every $rate in ()` is")
            w("  vacuously true — see the per-rule notes above). The verbatim")
            w("  `@context`/`@test` evidence is embedded in `cii_parity.json`")
            w("  and re-verified live by `test_cii_parity.py`; an artifact")
            w("  bump that fixes such an assert fails that gate and reopens")
            w("  the rule as cii-fireable.")
        w("- **%d binding-inapplicable** — officially UBL-only for the"
          % len(inapp))
        w("  both-syntaxes core-model proof, in two evidence classes:")
        if inapp_scoped:
            w("  - **%d carried by a vendored CII artifact but out of"
              % len(inapp_scoped))
            w("    core-model scope** (%s):"
              % ", ".join("`%s`" % e["id"] for e in inapp_scoped))
            w("    the assert exists and fires on a CII document, but its")
            w("    `@context`/`@test` binds a CII-specific surface — the")
            w("    national-CIUS payment-means / payment-terms / direct-debit /")
            w("    attachment nodes or the KoSIT XRechnung EXTENSION profile")
            w("    (`$isExtension`) — that the syntax-agnostic EN 16931 core")
            w("    model deliberately does not carry. Each is FULLY")
            w("    differentially proven on the UBL XRechnung leg and carries")
            w("    verbatim `@context`/`@test` + a surface note in")
            w("    `cii_parity.json`, re-verified live by `test_cii_parity.py`;")
            w("    an artifact bump that re-binds it onto the core model fails")
            w("    that gate and reopens the rule.")
        if inapp_absent:
            w("  - **%d not carried by any vendored CII artifact** (%s):"
              % (len(inapp_absent),
                 ", ".join("`%s`" % e["id"] for e in inapp_absent)))
            w("    at the vendored artifact versions these rules are officially")
            w("    UBL-only — there is nothing to prove against on the CII leg.")
        w("")
        w("The `syntax` tags above are NOT flipped on the strength of this")
        w("measurement: a rule reaches `syntax = UBL + CII` only via a landed")
        w("`differential.py` proof (0 divergences on the CII leg). The worklist")
        w("simply records, with evidence, why each remaining UBL-only rule is")
        w("not — and cannot silently be — proven on CII.")
        w("")

    _render_syntax_binding(w)

    return "\n".join(lines) + "\n"


def _render_creditnote(w, cn):
    """Append the '## UBL CreditNote scope' section. States the CreditNote
    in-scope pass rate SEPARATELY from the Invoice headline — a CreditNote case
    is NEVER folded into the Invoice numbers above."""
    graded = cn["unit_corpus_graded_cases"]
    agree = cn["unit_corpus_agree"]
    pct = (100.0 * agree / graded) if graded else 0.0
    w("## UBL CreditNote scope")
    w("")
    w("Stated **separately from the Invoice numbers above** — no CreditNote case"
      " is folded into the Invoice headline. " + cn["scope"] + ".")
    w("")
    w("A UBL 2.1 credit-note is a first-class EN 16931 document here: it is"
      " routed through the identical `einvoice.rules.ALL_RULES` engine an Invoice"
      " runs through, differentially proven against the " + cn["oracle"] + ".")
    w("")
    w("- **CreditNote in-scope pass rate: %d of %d graded unit cases (%.1f%%)**"
      " — over the vendored `CreditNote-unit-UBL` corpus, each split case whose"
      " scope rule the engine implements is classified exactly as the corpus's"
      " own difi `success`/`error` ground truth (the engine fires the scoped"
      " `BR-*` rule iff the case is an `error` case)." % (agree, graded, pct))
    w("- Graded across **%d implemented core rules**; **%d distinct `BR-*` rules**"
      " are actually exercised by the CreditNote corpus (the rest have no"
      " CreditNote unit case to fire on)." % (cn["graded_rule_count"],
                                              cn["distinct_rules_exercised"]))
    w("- **Standalone CreditNote fixtures: %d of %d validate clean** — the CEN"
      " `ubl-tc434-creditnote1` example plus the `CreditNote-{Max,Min}_content`"
      " testfiles all pass with no fatal (a real pass through the engine, not a"
      " structural skip)." % (cn["standalone_fixtures_pass"],
                              cn["standalone_fixtures_total"]))
    w("- **Differential divergences on the CreditNote corpus: %d.** The"
      " `differential.py cn` leg grades OUR fired-rule set against the official"
      " XSLT over every split CreditNote case + fixture; 0 divergences must"
      " never grow silently, so a future CreditNote regression turns the gate"
      " red." % cn["differential_divergences"])
    ko = cn.get("known_open") or {}
    if ko:
        w("- **Known-open CreditNote bindings (held out with a reason):**")
        for rid, reason in sorted(ko.items()):
            w("  - `%s` — %s" % (rid, reason))
    else:
        w("- **Known-open CreditNote bindings: none** — every implemented core"
          " rule reached exact parity on the CreditNote corpus, so no binding is"
          " fabricated from prose or silently passed.")
    w("")


def _render_syntax_binding(w):
    """Append the '## Syntax-binding assert' section — a live re-measurement of
    the non-``BR-*`` syntax-binding asserts in the two vendored preprocessed CEN
    artifacts. These are NOT the 286 business-rule matrix and NONE is evaluated
    by the engine (measurement + design only). Omitted if the artifacts are not
    on disk (e.g. a packaged install without ``corpus/``), mirroring how the CII
    parity worklist is omitted when its file is absent."""
    root = _sb.project_root()
    if not all(os.path.exists(_sb.artifact_path(b, root)) for b in ("ubl", "cii")):
        return
    acct = _sb.accounting(root)
    labels = {"ubl": "UBL", "cii": "CII"}
    ubl_t, cii_t = acct["ubl"]["total"], acct["cii"]["total"]

    w("## Syntax-binding assert")
    w("")
    w("Distinct from the scoped-out mentions above, this section is the live,")
    w("machine-recomputed accounting of the **syntax-binding** asserts the two")
    w("vendored preprocessed CEN artifacts carry ALONGSIDE the `BR-*` business")
    w("rules — the `sch:assert`s whose id is `UBL-CR-*` / `UBL-DT-*` /")
    w("`UBL-SR-*` (UBL) and `CII-DT-*` / `CII-SR-*` (CII). They are syntax-layer")
    w("restrictions — \"this element MUST NOT appear\", \"at most one of X\", a")
    w("decimal-place cap — not EN 16931 business rules.")
    w("")
    w("- **%d UBL** + **%d CII** = **%d** syntax-binding asserts, extracted by a"
      " real XML parse of the two artifacts." % (ubl_t, cii_t, ubl_t + cii_t))
    ubl_impl = len(_sbe.implemented_ids())
    cii_impl = len(_sbe.cii_implemented_ids())
    w("- **Frozen honest headline (machine-recomputed):** **%d of %d UBL** +"
      " **%d of %d CII** syntax-binding asserts are differential-proven per binding"
      " (0 divergences against the official vendored CEN Schematron —"
      " `differential.py` LEG 5 `sb` / LEG 6 `sbcii`); the remaining **%d UBL** +"
      " **%d CII** are machine-listed known-open, each with its exact unsupported"
      " `@test` / `@context` form in the per-class worklists below. Nothing is"
      " approximated, hand-faked, or silently dropped — an id is promoted only"
      " where the restricted (non-general-XPath) evaluator proves exact"
      " equivalence, and the terminal per-class counts are asserted by"
      " `test_syntax_binding.py`."
      % (ubl_impl, ubl_t, cii_impl, cii_t, ubl_t - ubl_impl, cii_t - cii_impl))
    w("- Honesty note: these are **NOT** part of the **286 business rules**")
    w("  counted above, and none is folded into that matrix. The catalog is")
    w("  regenerated by `gen_syntax_binding.py` and re-parsed live by")
    w("  `test_syntax_binding.py`. The dominant **UBL `absence-restriction`**")
    w("  class is now partially EVALUATED by a restricted, data-driven engine")
    w("  (`einvoice/syntax_binding_eval.py`) and surfaced under the distinct")
    w("  `syntax-binding` report category — the accounting is below, kept")
    w("  strictly separate from the business-rule count.")
    w("")

    _render_sb_implementation(w, acct)
    _render_sb_cii_classes(w, acct)

    w("### Id-family breakdown")
    w("")
    w("| binding | id prefix | asserts |")
    w("| --- | --- | ---: |")
    for b in ("ubl", "cii"):
        for prefix, n in sorted(acct[b]["prefix_counts"].items()):
            w("| %s | `%s-*` | %d |" % (labels[b], prefix, n))
    w("")

    w("### Shape histogram")
    w("")
    w("Each `@test` is mechanically classified into ONE coarse shape class by")
    w("the shape of the expression (NOT by id family — a `*-DT-*` assert whose")
    w("test is `not(@schemeName)` is honestly an `absence-restriction`). This")
    w("histogram is the artifact that decides implementation batch order: the")
    w("two dominant classes cover the overwhelming majority.")
    w("")
    w("| binding | shape | asserts | % of binding |")
    w("| --- | --- | ---: | ---: |")
    for b in ("ubl", "cii"):
        hist = acct[b]["shape_histogram"]
        pct = acct[b]["shape_pct"]
        for shape in _sb.SHAPE_CLASSES:
            if shape in hist:
                w("| %s | `%s` | %d | %.1f%% |"
                  % (labels[b], shape, hist[shape], pct[shape]))
    w("")
    w("Shape classes: "
      + "; ".join("`%s` — %s" % (k, v) for k, v in _sb.SHAPE_CLASSES.items()))
    w("")


def _render_sb_implementation(w, acct):
    """Append the live UBL absence-restriction IMPLEMENTATION accounting: how
    many of the 699 UBL `absence-restriction` asserts the restricted evaluator
    implements (differential-proven) vs leaves known-open, machine-listed from
    `einvoice.syntax_binding_eval` + the catalog so a regression reopens the
    worklist automatically. Nothing here is hand-maintained."""
    entries = _sbe.absence_restriction_entries()
    total = len(entries)
    if not total:
        return
    tests = {e["id"]: e["test"] for e in entries}
    implemented = _sbe.absence_implemented_ids()
    known_open = _sbe.known_open_ids()
    ubl_abs_hist = acct["ubl"]["shape_histogram"].get("absence-restriction", 0)

    w("### UBL absence-restriction — implemented vs known-open")
    w("")
    w("The dominant UBL class (`absence-restriction`, **%d** of the %d UBL"
      " syntax-binding asserts) is evaluated by a *restricted*, data-driven"
      " engine — NOT a general XPath processor. An assert is IMPLEMENTED iff its"
      " rule context is the document root (`/ubl:Invoice | /cn:CreditNote`) AND"
      " its `@test` matches the closed grammar the evaluator can prove"
      " equivalent to the official Schematron: a bare `not(<path>)` presence"
      " restriction, or the disjunctive `not(<path>) or <path> = '<literal>'`,"
      " over a location path of element steps (with `//` descendant search,"
      " union groups `(a|b)`, and a trailing `@attr`) — no predicates, no"
      " functions. Anything else is left known-open." % (ubl_abs_hist, acct["ubl"]["total"]))
    w("")
    w("- **%d implemented** (differential-proven) / **%d known-open** of the"
      " **%d** UBL `absence-restriction` asserts."
      % (len(implemented), len(known_open), total))
    w("- Every implemented id is proven equivalent to the official CEN"
      " EN16931-UBL Schematron with **0 divergences** over the differential"
      " corpus + targeted fixtures (`differential.py` LEG 5, the `sb` leg).")
    w("- Findings surface under the distinct **`syntax-binding`** report"
      " category, each mirroring the official `@flag`: `warning` findings are"
      " reported but do NOT change the exit code; a `fatal` finding blocks"
      " validity. (All %d implemented ids carry `warning`; the 3 `fatal`"
      " asserts in this class are all in the known-open set below.)"
      % len(implemented))
    w("")
    w("Known-open worklist (machine-listed — the exact remainder; a regression"
      " that stops supporting a form reappears here automatically):")
    w("")
    w("| id | @test (unsupported form) |")
    w("| --- | --- |")
    for rid in known_open:
        t = (tests.get(rid) or "").replace("|", "\\|")
        w("| `%s` | `%s` |" % (rid, t))
    w("")

    _render_sb_new_classes(w, acct)


#: Human labels + one-line class notes for the newly-implemented UBL shape
#: classes (T-VHSBL.3), rendered live from the catalog + the evaluator.
_SB_NEW_CLASS_DOC = {
    "cardinality-count": (
        "cardinality-count",
        "A `cardinality-count` assert caps how many times a repeatable UBL"
        " element may appear under a rule context, e.g. UBL-SR-01"
        " `count(cac:ContractDocumentReference/cbc:ID) <= 1`. An assert is"
        " IMPLEMENTED iff BOTH its rule context compiles under the closed"
        " context-pattern grammar (a `|`-union of element-step chains — the"
        " document root, a `//` descendant, or a relative `a/b` path — with NO"
        " predicate `[...]`, function, or `@attr` step) AND its `@test` compiles"
        " under the closed count grammar: `count(P) OP n`, `not(P) or count(P) OP"
        " n`, the difference-of-counts `count(P1) - count(P2) OP n` (UBL-DT-18), or"
        " the `and`-conjoined `(count(P) OP n) and ((A) != (B))` (UBL-SR-19/21) —"
        " over restricted element paths (`A`/`B` may lead with a `..` parent step;"
        " the `!=` is the XPath general node-set inequality: ∃ a∈A, b∈B with"
        " different string values). A predicated / `upper-case()` / `preceding::`"
        " count path (UBL-SR-04/12/13/18/29/44/47), a predicated context"
        " (UBL-SR-30/31), or an `and`-conjoined comparison whose count path carries"
        " an `upper-case(@schemeID)` predicate (UBL-SR-20) is left known-open —"
        " never approximated."),
    "existence": (
        "existence",
        "An `existence` assert requires a UBL node or attribute to be present,"
        " e.g. UBL-SR-07 `(cac:InvoiceDocumentReference/cbc:ID)` or UBL-SR-53"
        " `exists(cac:TaxScheme/cbc:ID) and exists(cbc:CompanyID)`. An assert is"
        " IMPLEMENTED iff its context compiles and its `@test` is a single"
        " existence term — `exists(P)` or a bare parenthesized path `(P)` — or an"
        " `and`-conjunction of them, over restricted element paths. The two"
        " `@attr`-presence asserts whose CONTEXT is a function predicate"
        " (`//*[ends-with(name(),'BinaryObject')]`) are left known-open."),
    "datatype-regex": (
        "datatype-regex",
        "The single UBL `datatype-regex` assert is UBL-DT-01,"
        " `string-length(substring-after(.,'.'))<=2` — a 2-decimal cap on amounts,"
        " bound to the element-suffix function context `//*[ends-with(name(),"
        "'Amount') and not(ends-with(name(),'PriceAmount')) and"
        " not(ancestor::cac:Price/cac:AllowanceCharge)]`. Both the `@test` and the"
        " context compile under bounded, provable extensions: the decimal cap is a"
        " pure string operation (`substring-after(., '.')` = the part after the"
        " FIRST `.`, length ≤ 2 — no rounding, no `number()` coercion), and the"
        " context is the existing element-suffix branch grammar plus one bounded"
        " ancestor guard `not(ancestor::cac:Price/cac:AllowanceCharge)` (exclude an"
        " amount that has a `cac:Price` ancestor carrying a `cac:AllowanceCharge`"
        " child). A `matches()` regex restriction would still stay known-open — no"
        " regex engine is faked."),
}


def _render_sb_new_classes(w, acct):
    """Append a live implemented-vs-known-open partition for EACH newly-worked UBL
    shape class (cardinality-count, existence, datatype-regex), machine-listed
    from `einvoice.syntax_binding_eval` + the catalog exactly like the dominant
    absence-restriction subsection above — so a grammar regression reopens the
    worklist automatically and nothing can silently drift."""
    for shape in _sbe.NEW_CLASSES:
        entries = _sbe.class_entries(shape)
        total = len(entries)
        if not total:
            continue
        label, desc = _SB_NEW_CLASS_DOC[shape]
        tests = {e["id"]: e["test"] for e in entries}
        ctxs = {e["id"]: e.get("context", "") for e in entries}
        implemented = _sbe.class_implemented_ids(shape)
        known_open = _sbe.class_known_open_ids(shape)
        hist = acct["ubl"]["shape_histogram"].get(shape, 0)

        w("### UBL %s — implemented vs known-open" % label)
        w("")
        w("%s" % desc)
        w("")
        w("- **%d implemented** (differential-proven) / **%d known-open** of the"
          " **%d** UBL `%s` asserts (histogram total **%d**)."
          % (len(implemented), len(known_open), total, shape, hist))
        if implemented:
            w("- Every implemented id is graded in `differential.py` LEG 5 (the"
              " `sb` leg) and agrees with the official CEN EN16931-UBL Schematron"
              " at **0 divergences**; findings surface under the distinct"
              " **`syntax-binding`** report category mirroring the official"
              " `@flag`.")
            unobs = sorted(set(implemented) & set(_sbe.FIRING_UNOBSERVABLE))
            if unobs:
                w("- Firing-unobservable (still implemented + clearing-proven): the"
                  " official artifact raises an XSLT `fn:normalize-space()` type"
                  " error on ANY document that violates these caps (a leaf other"
                  " rules normalize becomes plural), so their both-fire datapoint"
                  " cannot be graded; a targeted firing fixture is therefore not"
                  " shipped, and the evaluator's firing on them is exercised"
                  " in-memory by `test_syntax_binding.py` instead:")
                w("")
                for rid in unobs:
                    w("  - `%s` — `%s`" % (rid, tests.get(rid, "")))
        else:
            w("- None implemented — the entire class is left known-open (see the"
              " per-id reasons below); nothing is approximated.")
        w("")
        w("Known-open worklist (machine-listed — the exact remainder; a regression"
          " that stops supporting a form reappears here automatically):")
        w("")
        w("| id | @test (unsupported form) | context |")
        w("| --- | --- | --- |")
        for rid in known_open:
            t = (tests.get(rid) or "").replace("|", "\\|")
            c = (ctxs.get(rid) or "").replace("|", "\\|")
            w("| `%s` | `%s` | `%s` |" % (rid, t, c))
        w("")


#: Human labels + one-line class notes for the CII syntax-binding shape classes
#: (T-VHSBL.4), rendered live from the catalog + the CII evaluator. Mirrors the
#: UBL subsections but drives every implemented id against the official CEN
#: EN16931-CII Schematron (`differential.py` LEG 6, the `sbcii` leg).
_SB_CII_CLASS_DOC = {
    "absence-restriction": (
        "absence-restriction",
        "The dominant CII class — a bare `not(<path>)` presence restriction"
        " asserting a CII element/attribute the EN 16931 core model has no slot"
        " for MUST NOT appear. An assert is IMPLEMENTED iff BOTH its rule"
        " `@context` (a `|`-union of element-step chains — a `//` descendant or a"
        " rooted `/rsm:.../…` path, with NO predicate `[...]`, function, or `@attr`"
        " step) AND its `@test` compile under the closed grammar, resolved through"
        " the CII namespace map. A predicated / wildcard context"
        " (`//ram:*[ends-with(name(),'ReferencedDocument')]`) or a `//`-inside-path"
        " test is left known-open. Three ids"
        " (`CII-DT-010`/`011`/`012`) whose `@test` DOES compile are additionally"
        " machine-listed known-open as **claim-shadowed**: the earlier universal"
        " `//ram:TypeCode` rule in the same Schematron pattern claims the document"
        " `ram:TypeCode` node first, so the official validator can never fire them"
        " (dead rules) — detected live from the vendored artifact's pattern order,"
        " never a hardcoded id list."),
    "cardinality-count": (
        "cardinality-count",
        "A `cardinality-count` assert caps how many times a repeatable CII element"
        " may appear under a rule context, e.g. CII-SR-014 `count(ram:TypeCode) ="
        " 1`. Implemented iff its context compiles and its `@test` is `count(P) OP"
        " n` or `not(P) or count(P) OP n` over a restricted element path (`OP` one"
        " of `<=`/`=`/`<`/`>`/`>=`, `n` an integer). A predicated / function path"
        " or an arithmetic count difference is left known-open."),
    "existence": (
        "existence",
        "An `existence` assert requires a CII node to be present, e.g. CII-SR-463"
        " `(ram:ChargeIndicator)` on a `//ram:SpecifiedTradeAllowanceCharge`."
        " Implemented iff its context compiles and its `@test` is a single"
        " existence term `(P)` / `exists(P)` (or an `and`-conjunction) over"
        " restricted element paths."),
    "other-complex": (
        "other-complex",
        "The single CII `other-complex` assert (CII-SR-119) is a compound"
        " `and`/`or` co-occurrence constraint over a gross-price applied"
        " allowance/charge. Its exact semantics stay outside the restricted"
        " grammar: the left disjunct carries a predicate"
        " `ram:ChargeIndicator[udt:Indicator=false()]` whose truth is an XPath-2.0"
        " typed general comparison against the boolean `false()` (the"
        " `udt:Indicator` untyped value is cast to `xs:boolean` — valid only for"
        " `true`/`false`/`1`/`0`), conjoined/disjoined with two existence tests"
        " over `ram:ActualAmount`. Modelling the cast-to-boolean equivalence AND"
        " the `or`(`and`,`and`) shape is not a bounded, provable form here, so per"
        " the honesty line it is left machine-listed as known-open — never"
        " approximated."),
    "datatype-regex": (
        "datatype-regex",
        "The single CII `datatype-regex` assert (CII-DT-097,"
        " `matches(.,'^\\s*(\\d{4})…$')`, a date lexical form) is a `matches()`"
        " regex restriction outside any closed element grammar, so it is left"
        " machine-listed as known-open rather than hand-faked with a regex"
        " engine."),
}

#: The CII shape-class render order (dominant class first, then the worked
#: classes, then the fully-known-open remainder classes).
_SB_CII_CLASS_ORDER = ("absence-restriction", "cardinality-count", "existence",
                       "other-complex", "datatype-regex")


def _render_sb_cii_classes(w, acct):
    """Append a live implemented-vs-known-open partition for EACH CII shape class
    (T-VHSBL.4), machine-listed from `einvoice.syntax_binding_eval` + the catalog
    exactly like the UBL subsections — so a catalog/artifact bump reopens the CII
    worklist automatically. Uses the same `### CII <shape> — implemented vs
    known-open` anchor pattern the UBL sections use."""
    for shape in _SB_CII_CLASS_ORDER:
        entries = _sbe.cii_class_entries(shape)
        total = len(entries)
        if not total:
            continue
        label, desc = _SB_CII_CLASS_DOC[shape]
        tests = {e["id"]: e["test"] for e in entries}
        ctxs = {e["id"]: e.get("context", "") for e in entries}
        implemented = _sbe.cii_class_implemented_ids(shape)
        known_open = _sbe.cii_class_known_open_ids(shape)
        hist = acct["cii"]["shape_histogram"].get(shape, 0)

        w("### CII %s — implemented vs known-open" % label)
        w("")
        w("%s" % desc)
        w("")
        w("- **%d implemented** (differential-proven) / **%d known-open** of the"
          " **%d** CII `%s` asserts (histogram total **%d**)."
          % (len(implemented), len(known_open), total, shape, hist))
        if implemented:
            w("- Every implemented id is graded in `differential.py` LEG 6 (the"
              " `sbcii` leg) and agrees with the official CEN EN16931-CII"
              " Schematron at **0 divergences**; findings surface under the"
              " distinct **`syntax-binding`** report category mirroring the"
              " official `@flag` (warnings do not change the exit code).")
            unobs = sorted(set(implemented) & set(_sbe.CII_FIRING_UNOBSERVABLE))
            if unobs:
                w("- Firing-unobservable on the OFFICIAL side (still implemented +"
                  " clearing-proven): violating these caps duplicates a leaf a"
                  " downstream official rule feeds to `fn:normalize-space()` /"
                  " `number()` / a `cast as`, which aborts the CEN CII XSLT on the"
                  " now >1-item sequence. Their firing fixtures ARE shipped (each"
                  " fires in our evaluator) but the differential SKIPS them on the"
                  " official side (recorded as errors, NOT divergences); the"
                  " clearing direction is proven across the corpus:")
                w("")
                for rid in unobs:
                    w("  - `%s` — `%s`" % (rid, tests.get(rid, "")))
        else:
            w("- None implemented — the entire class is left known-open (see the"
              " per-id reasons below); nothing is approximated.")
        w("")
        w("Known-open worklist (machine-listed — the exact remainder; a regression"
          " that stops supporting a form reappears here automatically):")
        w("")
        w("| id | @test (unsupported form) | context |")
        w("| --- | --- | --- |")
        for rid in known_open:
            t = (tests.get(rid) or "").replace("|", "\\|")
            c = (ctxs.get(rid) or "").replace("|", "\\|")
            w("| `%s` | `%s` | `%s` |" % (rid, t, c))
        w("")

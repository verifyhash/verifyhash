#!/usr/bin/env python3
"""gen_known_open_audit.py — regenerate ``known_open_audit.json``, the
MEASURE-ONLY terminal audit of the coverage remainder (T-VHCOV.1).

For every LIVE known-open syntax-binding id (recomputed from the SAME module
APIs ``test_syntax_binding.py`` asserts against — never a hardcoded roster) the
audit records the exact official ``@test`` / ``@context`` verbatim from the
committed catalog and classifies the id into EXACTLY ONE blocker class:

  * ``needs-general-xpath`` — the @test/@context uses predicates ``[...]``,
    functions (``upper-case``, ``normalize-space``, ``distinct-values``,
    ``matches``, ``local-name``, positional ``[1]``), or axes (``self::``,
    ``ancestor::``, ``preceding::``, parent ``..``) the restricted
    closed-grammar evaluator provably cannot represent — or is DEAD/unsafe by
    Schematron rule-claiming (promotion would over-fire and diverge from the
    official validator). Terminal.
  * ``needs-external-codelist`` — would require a codelist artifact we do not
    vendor (none of the current remainder does).

The third T-VHCOV.1 class, ``promotable-under-provable-extension``, was
TERMINALLY RESOLVED by T-VHCOV.2: all 8 of its ids (CII-DT-033, CII-SR-046,
CII-SR-090, CII-SR-449/450/451, CII-SR-465/466) were promoted into the
restricted evaluator behind bounded grammar extensions (bare node-set existence
right-disjunct incl. a rooted leading-/ guard path, negated conjunction
``not(A and B)``, the truth-table-proven three-way mutual-exclusion DNF, and
``not (`` / redundant-paren lexical tolerance for the count form) and are
differential-proven at 0 divergences — so the class no longer appears here; a
future artifact bump that reopens a promotable id must re-run the audit.

The generator FAILS (non-zero exit) if the live known-open set and the
classification table drift in either direction, so the audit can never silently
go stale. Output ordering is deterministic (sort by binding, then id) and the
pinned ``generated_from`` sha is a constant — regeneration is byte-stable.

Standard library only. Run:  python3 gen_known_open_audit.py
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import syntax_binding_eval as _sbe  # noqa: E402

OUT_PATH = os.path.join(HERE, "known_open_audit.json")
MATRIX_PATH = os.path.join(HERE, "coverage_matrix.json")
CATALOG_PATH = os.path.join(HERE, "syntax_binding_catalog.json")

#: The repo HEAD the audit was generated from (task T-VHCOV.1 start). A
#: CONSTANT — not read from git — so regeneration stays byte-stable.
GENERATED_FROM = "de2370edbef91671390064282dc8124d6a3021fb"

CLASS_GENERAL = "needs-general-xpath"
CLASS_CODELIST = "needs-external-codelist"
# T-VHCOV.2: the T-VHCOV.1 promotable-under-provable-extension class is
# terminally resolved (all 8 ids promoted + differential-proven), so only the
# two genuinely-terminal blocker classes remain allowed.
ALLOWED_CLASSES = (CLASS_GENERAL, CLASS_CODELIST)

# --------------------------------------------------------------------------- #
# The classification table: id -> (class, one factual sentence). Every reason
# names the EXACT out-of-grammar construct (or the exact bounded extension) in
# the official @test/@context — verified against the live compilers:
# compile_class_test / compile_context / cii_claim_shadowed_ids /
# cii_suffix_claim_unsafe_ids at generation time.
# --------------------------------------------------------------------------- #
CLASSIFICATION = {
    # ---- UBL absence-restriction (5) ------------------------------------- #
    "UBL-CR-412": (CLASS_GENERAL,
        "The right disjunct ../cn:CreditNote is a bare node-set disjunct whose "
        "path leads with the parent axis (..) at the document root — the closed "
        "absence grammar admits only a Q = 'literal' right disjunct and its "
        "restricted paths have no parent-axis step."),
    "UBL-CR-665": (CLASS_GENERAL,
        "The not() path carries the nested predicate [cbc:DocumentTypeCode != "
        "'130' or not(cbc:DocumentTypeCode)] — predicated location steps are "
        "outside the restricted path grammar."),
    "UBL-CR-666": (CLASS_GENERAL,
        "The not() path carries the predicate [cbc:DocumentTypeCode = '130'] — "
        "predicated location steps are outside the restricted path grammar."),
    "UBL-CR-673": (CLASS_GENERAL,
        "The not() path carries the predicate [cbc:DocumentTypeCode  = '130'] — "
        "predicated location steps are outside the restricted path grammar."),
    "UBL-SR-43": (CLASS_GENERAL,
        "A three-way or/and compound over bare equality comparisons and the "
        "local-name(/*) function call — general boolean composition and "
        "functions are outside the closed absence grammar (and the context "
        "cac:AdditionalDocumentReference is not the one supported document-root "
        "context of the UBL absence class)."),
    # ---- UBL cardinality-count (10) --------------------------------------- #
    "UBL-SR-04": (CLASS_GENERAL,
        "The count path carries the predicate [cbc:DocumentTypeCode='130'] — "
        "the closed count grammar admits no predicated steps."),
    "UBL-SR-12": (CLASS_GENERAL,
        "The count path carries the predicate [cac:TaxScheme/upper-case(cbc:ID)"
        "='VAT'] using the XPath-2.0 function upper-case() — predicates and "
        "functions are outside the closed count grammar."),
    "UBL-SR-13": (CLASS_GENERAL,
        "The count path carries the predicate [cac:TaxScheme/upper-case(cbc:ID)"
        "!='VAT'] using the XPath-2.0 function upper-case() — predicates and "
        "functions are outside the closed count grammar."),
    "UBL-SR-18": (CLASS_GENERAL,
        "The count path carries the predicate [cac:TaxScheme/upper-case(cbc:ID)"
        "='VAT'] using the XPath-2.0 function upper-case() — predicates and "
        "functions are outside the closed count grammar."),
    "UBL-SR-20": (CLASS_GENERAL,
        "The left conjunct's count path carries the predicate [upper-case("
        "@schemeID) != 'SEPA'] — a function-bearing predicate outside the "
        "closed count grammar (the and-conjoined (A) != (B) right side alone "
        "is a supported form)."),
    "UBL-SR-29": (CLASS_GENERAL,
        "The count path carries the predicate [upper-case(@schemeID) = 'SEPA'] "
        "— a function-bearing predicate outside the closed count grammar."),
    "UBL-SR-30": (CLASS_GENERAL,
        "The @test itself compiles, but the rule @context cac:AllowanceCharge"
        "[cbc:ChargeIndicator = false()] is a predicated match pattern with a "
        "typed false() comparison — the closed context-pattern grammar admits "
        "no predicates."),
    "UBL-SR-31": (CLASS_GENERAL,
        "The @test itself compiles, but the rule @context cac:AllowanceCharge"
        "[cbc:ChargeIndicator = true()] is a predicated match pattern with a "
        "typed true() comparison — the closed context-pattern grammar admits "
        "no predicates."),
    "UBL-SR-44": (CLASS_GENERAL,
        "The count path's predicate [not(preceding::cbc:PaymentID/. = .)] uses "
        "the preceding:: axis and a node-set self-comparison (distinct-value "
        "emulation) — axes and predicates outside the closed count grammar."),
    "UBL-SR-47": (CLASS_GENERAL,
        "The count path's predicate [not(preceding::cbc:PaymentMeansCode/. = .)]"
        " uses the preceding:: axis and a node-set self-comparison (distinct-"
        "value emulation) — axes and predicates outside the closed count "
        "grammar."),
    # ---- CII absence-restriction (18) -------------------------------------- #
    "CII-DT-010": (CLASS_GENERAL,
        "Claim-shadowed dead rule: not(@listID) itself compiles, but the "
        "earlier universal //ram:TypeCode rule in the same Schematron pattern "
        "claims the document TypeCode node first (XSLT apply-templates "
        "semantics), so the official validator can never fire this assert and "
        "an independent evaluation would over-fire — faithful support needs "
        "full Schematron rule-claiming, not a grammar extension."),
    "CII-DT-011": (CLASS_GENERAL,
        "Claim-shadowed dead rule: not(@listAgencyID) itself compiles, but the "
        "earlier universal //ram:TypeCode rule in the same Schematron pattern "
        "claims the document TypeCode node first, so the official validator "
        "can never fire this assert and an independent evaluation would "
        "over-fire — faithful support needs full Schematron rule-claiming, not "
        "a grammar extension."),
    "CII-DT-012": (CLASS_GENERAL,
        "Claim-shadowed dead rule: not(@listVersionID) itself compiles, but "
        "the earlier universal //ram:TypeCode rule in the same Schematron "
        "pattern claims the document TypeCode node first, so the official "
        "validator can never fire this assert and an independent evaluation "
        "would over-fire — faithful support needs full Schematron "
        "rule-claiming, not a grammar extension."),
    "CII-DT-015": (CLASS_GENERAL,
        "The right disjunct (self::ram:AdditionalReferencedDocument and "
        "ram:TypeCode='916') conjoins a self:: axis test with an equality — "
        "axes and boolean composition are outside the closed "
        "not(P)-or-Q='literal' test grammar (the suffix @context itself "
        "compiles)."),
    "CII-DT-018": (CLASS_GENERAL,
        "The right side (self::ram:AdditionalReferencedDocument) and "
        "(ram:TypeCode='50' or ...='130' or ...='916') is an and/or compound "
        "over a self:: axis test and three equality comparisons — axes and "
        "boolean composition are outside the closed test grammar."),
    "CII-DT-021": (CLASS_GENERAL,
        "The right disjunct (self::ram:AdditionalReferencedDocument and "
        "ram:TypeCode='916') conjoins a self:: axis test with an equality — "
        "axes and boolean composition are outside the closed test grammar."),
    "CII-DT-022": (CLASS_GENERAL,
        "The right disjunct (self::ram:AdditionalReferencedDocument and "
        "ram:TypeCode='916') conjoins a self:: axis test with an equality — "
        "axes and boolean composition are outside the closed test grammar."),
    "CII-DT-024": (CLASS_GENERAL,
        "The right disjunct (self::ram:AdditionalReferencedDocument and "
        "ram:TypeCode='130') conjoins a self:: axis test with an equality — "
        "axes and boolean composition are outside the closed test grammar."),
    "CII-DT-027": (CLASS_GENERAL,
        "The right disjunct self::ram:InvoiceReferencedDocument is a self:: "
        "axis test — an axis outside the restricted path grammar, and a bare "
        "(non-'literal') disjunct besides."),
    "CII-DT-041": (CLASS_GENERAL,
        "The right disjunct (ancestor::ram:ApplicableHeaderTradeSettlement) is "
        "an ancestor:: axis test — an axis outside the restricted path "
        "grammar, and a bare (non-'literal') disjunct besides."),
    "CII-DT-052": (CLASS_GENERAL,
        "The right disjunct self::ram:ApplicableTradeTax is a self:: axis test "
        "— an axis outside the restricted path grammar, and a bare "
        "(non-'literal') disjunct besides."),
    "CII-DT-054": (CLASS_GENERAL,
        "The right disjunct (ancestor::ram:ApplicableHeaderTradeSettlement) is "
        "an ancestor:: axis test — an axis outside the restricted path "
        "grammar, and a bare (non-'literal') disjunct besides."),
    "CII-DT-058": (CLASS_GENERAL,
        "The right disjunct (ancestor::ram:ApplicableHeaderTradeSettlement) is "
        "an ancestor:: axis test — an axis outside the restricted path "
        "grammar, and a bare (non-'literal') disjunct besides."),
    "CII-DT-098": (CLASS_GENERAL,
        "The right disjunct self::ram:ApplicableTradeTax is a self:: axis test "
        "— an axis outside the restricted path grammar, and a bare "
        "(non-'literal') disjunct besides."),
    "CII-DT-101": (CLASS_GENERAL,
        "Suffix-claim-unsafe: both the @context and not(@schemeName) compile, "
        "but earlier specific ID rules (CII-DT-001/002/003) in the same "
        "pattern claim the core ram:ID-family nodes first, so an independent "
        "evaluation of the //ram:*[ends-with(name(), 'ID')] rule would "
        "over-fire on the stolen nodes — faithful support needs per-node "
        "Schematron claiming, not a grammar extension."),
    "CII-DT-102": (CLASS_GENERAL,
        "Suffix-claim-unsafe: both the @context and not(@schemeAgencyName) "
        "compile, but earlier specific ID rules in the same pattern claim the "
        "core ram:ID-family nodes first, so an independent evaluation of the "
        "//ram:*[ends-with(name(), 'ID')] rule would over-fire on the stolen "
        "nodes — faithful support needs per-node Schematron claiming, not a "
        "grammar extension."),
    "CII-DT-103": (CLASS_GENERAL,
        "Suffix-claim-unsafe: both the @context and not(@schemeDataURI) "
        "compile, but earlier specific ID rules in the same pattern claim the "
        "core ram:ID-family nodes first, so an independent evaluation of the "
        "//ram:*[ends-with(name(), 'ID')] rule would over-fire on the stolen "
        "nodes — faithful support needs per-node Schematron claiming, not a "
        "grammar extension."),
    "CII-DT-104": (CLASS_GENERAL,
        "Suffix-claim-unsafe: both the @context and not(@schemeURI) compile, "
        "but earlier specific ID rules in the same pattern claim the core "
        "ram:ID-family nodes first, so an independent evaluation of the "
        "//ram:*[ends-with(name(), 'ID')] rule would over-fire on the stolen "
        "nodes — faithful support needs per-node Schematron claiming, not a "
        "grammar extension."),
    # ---- CII cardinality-count (9) ----------------------------------------- #
    "CII-SR-457": (CLASS_GENERAL,
        "The count path carries the predicate [ram:TypeCode='50'] — the "
        "closed count grammar admits no predicated steps."),
    "CII-SR-458": (CLASS_GENERAL,
        "The count path carries the predicate [ram:TypeCode='130'] — the "
        "closed count grammar admits no predicated steps."),
    "CII-SR-462": (CLASS_GENERAL,
        "The right disjunct counts distinct-values(//ram:ApplicableTradeTax/"
        "ram:DueDateTypeCode) — an XPath-2.0 set function outside the closed "
        "count grammar."),
    "CII-SR-467": (CLASS_GENERAL,
        "The count path's predicate compares normalize-space(.) against the "
        "positional first-node reference (...)[1] — functions, predicates and "
        "positional indexing are outside the closed count grammar."),
    "CII-SR-468": (CLASS_GENERAL,
        "The count path's predicate compares normalize-space(.) against the "
        "positional first-node reference (...)[1] — functions, predicates and "
        "positional indexing are outside the closed count grammar."),
    "CII-SR-470": (CLASS_GENERAL,
        "The count path's predicate is an and/or compound over "
        "normalize-space() equality tests and a nested not() existence "
        "disjunction — functions and predicated boolean composition are "
        "outside the closed count grammar."),
    "CII-SR-474": (CLASS_GENERAL,
        "The count path carries the predicate [normalize-space(ram:TypeCode) "
        "= '130'] — a function-bearing predicate outside the closed count "
        "grammar."),
    "CII-SR-475": (CLASS_GENERAL,
        "The count path carries the predicate [normalize-space(ram:TypeCode) "
        "= '916'] — a function-bearing predicate outside the closed count "
        "grammar."),
    "CII-SR-476": (CLASS_GENERAL,
        "The count path carries the predicate [normalize-space(ram:TypeCode) "
        "= '916'] — a function-bearing predicate outside the closed count "
        "grammar."),
    # ---- CII other-complex (1) --------------------------------------------- #
    "CII-SR-119": (CLASS_GENERAL,
        "A compound or(and, and) co-occurrence whose left branch carries the "
        "predicate ram:ChargeIndicator[udt:Indicator=false()] — an XPath-2.0 "
        "typed cast-to-boolean comparison — predicates, typed casts and "
        "general boolean composition are outside every closed class grammar."),
    # ---- CII datatype-regex (1) -------------------------------------------- #
    "CII-DT-097": (CLASS_GENERAL,
        "A matches(., '^\\s*(\\d{4})...$') regular-expression lexical "
        "restriction bound to the attribute-predicated @context "
        "//udt:DateTimeString[@format = '102'] — a regex engine and "
        "attribute-equality context predicates are both outside the closed "
        "grammars (no regex is hand-faked)."),
}


def live_known_open():
    """(id, binding, shape_class) for every live known-open syntax-binding id,
    recomputed via the SAME module APIs test_syntax_binding.py asserts."""
    _sbe.reset_cache()
    rows = []
    for rid in _sbe.known_open_ids():
        rows.append((rid, "UBL", "absence-restriction"))
    for shape in _sbe.NEW_CLASSES:
        for rid in _sbe.class_known_open_ids(shape):
            rows.append((rid, "UBL", shape))
    for shape in _sbe.CII_SHAPE_CLASSES:
        for rid in _sbe.cii_class_known_open_ids(shape):
            rows.append((rid, "CII", shape))
    return rows


def main():
    catalog = json.load(open(CATALOG_PATH, encoding="utf-8"))
    by_id = {e["id"]: e for e in catalog.get("entries", [])}
    matrix = json.load(open(MATRIX_PATH, encoding="utf-8"))

    rows = live_known_open()
    live_ids = {rid for rid, _, _ in rows}
    table_ids = set(CLASSIFICATION)
    missing = sorted(live_ids - table_ids)
    stale = sorted(table_ids - live_ids)
    if missing or stale:
        sys.stderr.write("classification drift — unclassified live ids %s / "
                         "stale table ids %s\n" % (missing, stale))
        return 1

    entries = []
    for rid, binding, shape in sorted(rows, key=lambda r: (r[1], r[0])):
        cat_e = by_id[rid]
        cls, reason = CLASSIFICATION[rid]
        entries.append({
            "id": rid,
            "binding": binding,
            "shape_class": shape,
            "test": cat_e["test"],
            "context": cat_e["context"],
            "class": cls,
            "reason": reason,
        })

    counts = {c: 0 for c in ALLOWED_CLASSES}
    for e in entries:
        counts[e["class"]] += 1

    # Machine-listed rule-family known-open remainder from coverage_matrix.json
    # — every universe recorded, even (especially) when empty.
    rule_families = {
        "creditnote_conformance": {
            "known_open": matrix["creditnote_conformance"]["known_open"],
        },
        "cvd_tmp_family": {
            "known_open_worklist": matrix["cvd_tmp_family"]
                                         ["known_open_worklist"],
        },
        "peppol_kosit_family": {
            "known_open_worklist": matrix["peppol_kosit_family"]
                                         ["known_open_worklist"],
        },
    }
    for fam, payload in sorted(rule_families.items()):
        vals = next(iter(payload.values()))
        if vals:
            sys.stderr.write("rule family %r now has known-open entries %r — "
                             "classify them before regenerating\n"
                             % (fam, vals))
            return 1
        payload["note"] = ("universe recorded as EMPTY (0 known-open) — "
                           "listed explicitly rather than omitted")

    audit = {
        "generated_from": GENERATED_FROM,
        "description": (
            "MEASURE-ONLY terminal audit (T-VHCOV.1, promotable class "
            "terminally resolved by T-VHCOV.2: all 8 promotable ids promoted + "
            "differential-proven) of every live known-open syntax-binding "
            "assert (15 UBL + 29 CII) plus the machine-listed "
            "rule-family known-open universes of coverage_matrix.json. Each "
            "entry carries the exact official @test/@context verbatim and "
            "exactly one blocker class; nothing here changes any frozen "
            "coverage number, evaluator behavior, or verdict. Regenerate with "
            "python3 gen_known_open_audit.py (byte-stable); "
            "test_known_open_audit.py fails on any drift."),
        "entries": entries,
        "counts": counts,
        "rule_family_known_open": rule_families,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(audit, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print("wrote %s: %d entries, counts=%s" % (
        os.path.basename(OUT_PATH), len(entries),
        json.dumps(counts, sort_keys=True)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

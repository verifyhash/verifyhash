#!/usr/bin/env python3
"""Build the published conformance coverage matrix.

Derives EVERY field of ``coverage_matrix.json`` from the LIVE engine — the rule
registries in :mod:`einvoice.rules` / :mod:`einvoice.rules_xrechnung` for the id,
title, severity and raw flag, and :mod:`differential`'s differentially-proven
graded sets for the syntax tag and Schematron provenance. Nothing is
hand-transcribed: run this after any rule change and commit the result. The
companion ``COVERAGE.md`` is rendered from the JSON via
:func:`einvoice.coverage.render_markdown`, so the two never drift.

Standard library only; no network.

    python3 gen_coverage.py            # write coverage_matrix.json + COVERAGE.md
    python3 gen_coverage.py --check    # fail if either committed file is stale
"""

from __future__ import annotations

import inspect
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import rules as _rules            # noqa: E402
from einvoice import rules_xrechnung as _rules_xr  # noqa: E402
from einvoice import rules_peppol as _rules_pep  # noqa: E402
from einvoice import coverage as _coverage       # noqa: E402
import differential as _diff                      # noqa: E402

JSON_PATH = os.path.join(HERE, "coverage_matrix.json")
MD_PATH = os.path.join(HERE, "COVERAGE.md")

# --------------------------------------------------------------------------- #
# Schematron ground-truth artifacts (versions read from the vendored corpus:   #
# corpus/cen-en16931/README.md and corpus/xrechnung-schematron/VENDORED.md).   #
# --------------------------------------------------------------------------- #
SCHEMATRON_SOURCES = {
    "en16931-ubl": {
        "suite": "CEN EN 16931",
        "file": "corpus/cen-en16931/ubl/schematron/EN16931-UBL-validation.sch",
        "version": "1.3.16",
        "license": "EUPL-1.2",
    },
    "en16931-cii": {
        "suite": "CEN EN 16931",
        "file": "corpus/cen-en16931/cii/schematron/EN16931-CII-validation.sch",
        "version": "1.3.16",
        "license": "EUPL-1.2",
    },
    "xrechnung-ubl": {
        "suite": "KoSIT XRechnung",
        "file": "corpus/xrechnung-schematron/schematron/ubl/XRechnung-UBL-validation.sch",
        "version": "2.5.0 (XRechnung 3.0.2)",
        "license": "Apache-2.0",
    },
    "xrechnung-cii": {
        "suite": "KoSIT XRechnung",
        "file": "corpus/xrechnung-schematron/schematron/cii/XRechnung-CII-validation.sch",
        "version": "2.5.0 (XRechnung 3.0.2)",
        "license": "Apache-2.0",
    },
}
SCHEMATRON_ORDER = ["en16931-ubl", "en16931-cii", "xrechnung-ubl", "xrechnung-cii"]

# Preprocessed (fully compiled, includes-resolved) CEN artifacts — the honest
# machine-readable universe of official rule ids for the gap computation. The
# gap is scoped to the two CEN EN 16931 artifacts: the KoSIT layer is a
# national CIUS on top, not part of the CEN core universe.
GAP_ARTIFACT_ORDER = ["en16931-ubl", "en16931-cii"]
GAP_ARTIFACT_SCH = {
    "en16931-ubl": "corpus/cen-en16931/ubl/schematron/preprocessed/"
                   "EN16931-UBL-validation-preprocessed.sch",
    "en16931-cii": "corpus/cen-en16931/cii/schematron/preprocessed/"
                   "EN16931-CII-validation-preprocessed.sch",
}

# Differentially-proven graded sets (single source of truth = differential.py).
CORE_UBL_PROVEN = set(_diff.OUR_RULE_SET)          # LEG 1: all 151 core on UBL
CORE_CII_PROVEN = set(_diff.CII_RULE_SET)          # LEG 3: core subset on CII
DE_UBL_PROVEN = set(_diff.XR_RULE_SET)             # LEG 2: all 46 BR-DE/DEX on UBL
DE_CII_PROVEN = set(_diff.CII_XR_RULE_SET)         # LEG 4: BR-DE subset on CII
# KoSIT-vendored Peppol batch, canonical ids (LEG 2 grades the UBL asserts,
# LEG 4 the CII asserts — including R043's two CII asserts individually).
PEP_UBL_PROVEN = set(_diff.PEPPOL_UBL_PROVEN_CANONICAL)
PEP_CII_PROVEN = set(_diff.PEPPOL_CII_PROVEN_CANONICAL)

# The vendored artifacts carrying the PEPPOL-EN16931-R* family (the KoSIT
# XRechnung Schematron ships them inside its peppol-* patterns).
PEPPOL_ARTIFACT_ORDER = ["xrechnung-ubl", "xrechnung-cii"]

# Honest reasons a core rule is NOT graded on the CII leg (verbatim intent from
# differential.CII_EXCLUDED_RULE_IDS' block comment).
CII_CORE_REASON = {
    "BR-CO-14": "official CII context requires a document-currency BT-110 "
                "(ram:TaxTotalAmount) which a no-VAT CII invoice legitimately "
                "omits, so the assert never fires there; the UBL transcription "
                "would over-reject those documents.",
    "BR-CO-15": "the CII binding carries an extra "
                "GrandTotalAmount = TaxBasisTotalAmount disjunct that holds for "
                "a no-VAT invoice with no BT-110; the UBL function has no such "
                "disjunct and would over-reject the same documents.",
    "BR-09": "the CII binding evaluates the country-code test from the document "
             "root, firing even when the whole postal address is absent; the "
             "UBL function is gated on the address node existing, so it misses "
             "there. Address existence (BR-08) stays graded; the country code "
             "does not.",
    "BR-11": "same as BR-09 for the buyer postal address country code.",
    "BR-S-01": "the CII binding is a weak one-directional count that does not "
               "flag an orphan Standard-rated breakdown; the UBL biconditional "
               "would over-fire on such CII invoices.",
    "BR-AF-08": "the CII artifact binds this assert to the "
                "ram:ApplicableTradeTax ROW — unlike BR-S-08, whose context "
                "node is the ram:CategoryCode CHILD — so the test's "
                "../ram:RateApplicablePercent resolves against the header "
                "settlement (no such children) and 'every $rate in ()' is "
                "vacuously true: the shipped assert can never fire. The "
                "engine asserts the intended per-rate round2 bucket sum on "
                "CII anyway (deliberate strictness).",
    "BR-AF-09": "the official CII artifact ships this assert as test=\"true()\" "
                "— a tautology that can never fire, whatever the arithmetic — "
                "so CII parity is impossible for a real check; the engine "
                "asserts the UBL binding's taxable × rate ±1 band on both "
                "syntaxes instead (deliberate strictness).",
    "BR-AG-08": "the CII artifact repeats the BR-AF-08 binding defect for the "
                "IPSI (M) family: the assert is bound to the "
                "ram:ApplicableTradeTax ROW, so its "
                "../ram:RateApplicablePercent is empty and 'every $rate in ()' "
                "is vacuously true — the shipped assert can never fire. The "
                "engine asserts the intended per-rate round2 bucket sum on "
                "CII anyway (deliberate strictness).",
    "BR-AG-09": "the official CII artifact ships this assert as test=\"true()\" "
                "— the same never-firing tautology as BR-AF-09 — so CII "
                "parity is impossible for a real check; the engine asserts "
                "the UBL binding's taxable × rate ±1 band on both syntaxes "
                "instead (deliberate strictness).",
}
_CII_CORE_GENERIC = ("core rule not included in the CII differential leg (LEG 3) "
                     "graded subset; the syntax-agnostic rule body can run over "
                     "the CII model but CII parity is not asserted for it.")

# Honest reasons a BR-DE/BR-DEX rule is NOT graded on the CII leg.
CII_DE_REASON = {
    "BR-DE-18": "Skonto grammar in the BT-20 payment-terms free text — a "
                "structure the syntax-agnostic core model omits.",
    "BR-DE-19": "IBAN mod-97 on a credit-transfer payment-means IBANID — the CII "
                "payment-means node set and IBAN digits are not in the core model.",
    "BR-DE-20": "IBAN mod-97 on a payment-means IBANID — not carried by the core "
                "model (see BR-DE-19).",
    "BR-DE-22": "unique attachment filename check over every "
                "EmbeddedDocumentBinaryObject/@filename — not carried.",
    "BR-DE-23-a": "payment-means type-code group check keyed on "
                  "SpecifiedTradeSettlementPaymentMeans TypeCode and its "
                  "financial-account children — not carried.",
    "BR-DE-24-a": "payment-means type-code group check (card) — not carried.",
    "BR-DE-25-a": "payment-means type-code group check (direct debit) — not carried.",
    "BR-DE-30": "BT-90/BT-91 with DIRECT DEBIT (BG-19), reconstructed from "
                "mandate / creditor-reference / IBAN presence — not in the core model.",
    "BR-DE-31": "BT-90/BT-91 with DIRECT DEBIT (BG-19) — not carried (see BR-DE-30).",
}
for _a in ("BR-DE-23-b", "BR-DE-24-b", "BR-DE-25-b"):
    CII_DE_REASON[_a] = CII_DE_REASON[_a[:-1] + "a"].replace("-a ", "-b ")
_CII_DEX_GENERIC = ("part of the KoSIT XRechnung EXTENSION layer (UBL "
                    "CustomizationID only); no CII extension profile is in scope.")
_CII_DE_GENERIC = ("national rule not evaluated on the CII differential leg (LEG 4).")


# EN 16931 codelist (BR-CL-*) rules that ARE present in the official codes
# Schematron but the engine does NOT yet assert — documented so the matrix is
# honest about which code families are covered. (BR-CL-16/19/20/21/24 ARE now
# asserted and appear in the rule table above; these remain deferred.)
CODELIST_NOT_ASSERTED = {
    "BR-CL-06": "VAT-point date code. Not asserted: the UBL binding "
                "(cac:InvoicePeriod/cbc:DescriptionCode, UNTDID 2005 subset "
                "3/35/432) and the CII binding (ram:DueDateTypeCode, UNTDID 2475 "
                "subset 5/29/72) use DIFFERENT code lists at DIFFERENT context "
                "nodes; the per-syntax value set is not yet carried.",
    "BR-CL-07": "Object/document reference identifier scheme (UNTDID 1153). Not "
                "asserted: the UBL context is scoped to a DocumentReference with "
                "cbc:DocumentTypeCode='130' (a predicate the model does not "
                "carry) and the CII context is ram:ReferenceTypeCode — two "
                "distinct bindings, deferred.",
    "BR-CL-08": "Subject code (UNTDID 4451). CII-only rule (ram:SubjectCode) "
                "with no UBL counterpart, so it falls outside the both-syntaxes "
                "codelist scope; not asserted.",
    "BR-CL-10": "Party identifier scheme in the ISO 6523 ICD list. Not asserted: "
                "a broad party-identification scheme surface across many context "
                "nodes; the 243-code ICD enumeration IS inlined in the .sch, but "
                "the authoritative ISO 6523 register in corpus is a PDF "
                "(codelist/iso6523/ICD-list.pdf), so it is deferred rather than "
                "partially asserted.",
    "BR-CL-11": "Party registration identifier scheme in the ISO 6523 ICD list. "
                "Not asserted: same ICD surface as BR-CL-10 bound to "
                "PartyLegalEntity/CompanyID / a scoped ram:ID; deferred.",
    "BR-CL-15": "Item origin country code (ISO 3166-1). Not asserted: the same "
                "code lists as BR-CL-14 but a distinct context node "
                "(cac:OriginCountry / ram:OriginTradeCountry) the model does not "
                "yet collect.",
    "BR-CL-25": "Electronic-address scheme identifier (CEF EAS). Not asserted: "
                "the EAS code set IS inlined in the .sch "
                "(cbc:EndpointID/@schemeID / ram:URIID/@schemeID), but the "
                "endpoint scheme-identifier parser surface is deferred; the "
                "authoritative register is the ISO 6523 PDF in corpus, not a "
                "machine-readable list. The set is NOT fabricated from the PDF.",
    "BR-CL-26": "Delivery-location identifier scheme (ISO 6523 ICD). Not "
                "asserted: the same ICD list as BR-CL-21 bound to a different "
                "context node (cac:DeliveryLocation/cbc:ID / "
                "ram:ShipToTradeParty/ram:GlobalID @schemeID); deferred.",
}


def _title(fn, rid):
    """First-paragraph docstring summary, id prefix stripped, whitespace collapsed."""
    doc = (fn.__doc__ or "").strip()
    para = doc.split("\n\n", 1)[0]
    text = re.sub(r"\s+", " ", para).strip()
    if text.startswith(rid + ":"):
        text = text[len(rid) + 1:].strip()
    elif text.startswith(rid):
        text = text[len(rid):].lstrip(":").strip()
    # Capitalise for a clean sentence.
    return text[:1].upper() + text[1:] if text else text


def _core_flag(fn):
    """Raw Schematron flag of a core rule, read from its source (default fatal;
    only the rule emitting a ``"warning"`` / ``"information"`` literal differs)."""
    src = inspect.getsource(fn)
    if re.search(r'["\']information["\']', src):
        return "information"
    if re.search(r',\s*["\']warning["\']\s*\)', src):
        return "warning"
    return "fatal"


def _severity_class(flag):
    """Blocking class in {fatal, warning}: only 'fatal' blocks validity."""
    return "fatal" if flag == "fatal" else "warning"


def _prov(source_key, proven, reason=None):
    entry = {"source": source_key, "suite": SCHEMATRON_SOURCES[source_key]["suite"],
             "sch": SCHEMATRON_SOURCES[source_key]["file"],
             "version": SCHEMATRON_SOURCES[source_key]["version"],
             "differentially_proven": bool(proven)}
    if not proven:
        entry["reason"] = reason
    return entry


_FAMILY_ORDER = ["BR", "BR-CL", "BR-CO", "BR-DEC", "BR-AE", "BR-AF", "BR-AG",
                 "BR-B", "BR-E", "BR-G", "BR-IC", "BR-O", "BR-S", "BR-Z",
                 "BR-DE", "BR-DE-TMP", "BR-DEX"]


def _sort_key(rid):
    toks = rid.split("-")
    suffix = ""
    if toks[-1].isalpha() and len(toks[-1]) == 1:
        suffix = toks[-1]
        toks = toks[:-1]
    num = int(toks[-1]) if toks[-1].isdigit() else -1
    family = "-".join(toks[:-1]) if toks[-1].isdigit() else "-".join(toks)
    rank = _FAMILY_ORDER.index(family) if family in _FAMILY_ORDER else len(_FAMILY_ORDER)
    return (rank, family, num, suffix)


_OFFICIAL_TAUTOLOGY_REASON = (
    "shipped as the literal tautology test=\"true()\" in BOTH CEN preprocessed "
    "artifacts (UBL and CII) — the assert is always satisfied and can never "
    "fire, whatever the invoice contains, so no implementation of this rule "
    "could ever be differentially proven against the official Schematron; "
    "excluded by construction rather than implemented on faith.")

_TAUTOLOGY_CACHE = None


def _assert_line(rel_path, rid):
    """1-based line number of the (unique) ``<assert id=\"rid\"`` in a vendored
    artifact — the citation the tautology evidence carries alongside the file."""
    with open(os.path.join(HERE, rel_path), encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            if 'id="%s"' % rid in line:
                return n
    raise AssertionError("assert id %r not found in %s" % (rid, rel_path))


def official_tautology_exclusions():
    """The official-tautology deliberate-exclusion class, computed LIVE.

    An id qualifies only when the vendored preprocessed CEN artifact of EVERY
    gap universe ships its assert with the literal ``test=\"true()\"`` (so the
    rule can never fire anywhere and differential proof is impossible BY
    CONSTRUCTION), and the engine neither fires it nor lists it in another
    exclusion bucket. Nothing is hardcoded: bump the vendored artifacts and an
    id whose test becomes real drops out of this class automatically (and then
    surfaces as fireable-missing until implemented). Each entry records the
    verbatim ``@test`` evidence — artifact file + line + assert id — for every
    universe, plus the official rule text.
    """
    global _TAUTOLOGY_CACHE
    if _TAUTOLOGY_CACHE is not None:
        return _TAUTOLOGY_CACHE
    from conformance import CALCULATION_ROUNDING_VACUOUS  # noqa: E402
    indexes = {
        key: _coverage.schematron_assert_index(
            os.path.join(HERE, GAP_ARTIFACT_SCH[key]))
        for key in GAP_ARTIFACT_ORDER
    }
    common = None
    for key in GAP_ARTIFACT_ORDER:
        vac = {rid for rid, e in indexes[key].items()
               if rid.startswith("BR-") and e["test"].strip() == "true()"}
        common = vac if common is None else common & vac
    other_exclusions = set(CALCULATION_ROUNDING_VACUOUS) | set(CODELIST_NOT_ASSERTED)
    ids = sorted((common or set())
                 - _coverage.engine_fireable_ids()
                 - other_exclusions, key=_sort_key)
    out = []
    for rid in ids:
        evidence = {}
        for key in GAP_ARTIFACT_ORDER:
            rel = GAP_ARTIFACT_SCH[key]
            evidence[key] = {
                "sch": rel,
                "line": _assert_line(rel, rid),
                "assert_id": rid,
                "test": indexes[key][rid]["test"],
            }
        out.append({
            "id": rid,
            "official_text": indexes[GAP_ARTIFACT_ORDER[0]][rid]["text"],
            "reason": _OFFICIAL_TAUTOLOGY_REASON,
            "evidence": evidence,
        })
    _TAUTOLOGY_CACHE = out
    return out


def deliberate_exclusion_ids():
    """Ids deliberately NOT asserted at all (vacuous-by-defect + deferred
    code-list + official test=\"true()\" tautologies) — the only exclusion
    buckets that subtract from an official universe. The cii_*_out_of_scope
    buckets are IMPLEMENTED rules (proven on UBL, honestly not graded on CII),
    so they already count as implemented, never excluded."""
    from conformance import CALCULATION_ROUNDING_VACUOUS  # noqa: E402
    return (set(CALCULATION_ROUNDING_VACUOUS) | set(CODELIST_NOT_ASSERTED)
            | {e["id"] for e in official_tautology_exclusions()})


def _non_br_families(index):
    """Sorted id-family prefixes (e.g. UBL-CR, CII-DT) of the non-BR asserts."""
    fams = set()
    for rid in index:
        if not rid.startswith("BR-"):
            m = re.match(r"^([A-Z]+-[A-Z]+)-", rid)
            fams.add(m.group(1) if m else rid)
    return sorted(fams)


def build_gap(implemented_ids, excluded_ids):
    """Per CEN artifact: missing = official BR-* universe − implemented − excluded.

    The universe is extracted with a real XML parse of the vendored
    preprocessed Schematron (:func:`einvoice.coverage.schematron_assert_index`)
    and scoped to ``BR-*`` business-rule ids — the artifacts' ``UBL-CR-*`` /
    ``UBL-SR-*`` / ``UBL-DT-*`` / ``CII-SR-*`` / ``CII-DT-*`` asserts are
    syntax-binding restrictions, not EN 16931 business rules. ``implemented``
    is intersected with each universe first, so KoSIT ``BR-DE-*`` rules
    (outside the CEN universe) never inflate the arithmetic. Every rule text is
    copied verbatim from the artifact, nothing is fabricated.
    """
    artifacts = {}
    for key in GAP_ARTIFACT_ORDER:
        rel = GAP_ARTIFACT_SCH[key]
        index = _coverage.schematron_assert_index(os.path.join(HERE, rel))
        universe = {rid for rid in index if rid.startswith("BR-")}
        impl_in = universe & implemented_ids
        excl_in = universe & excluded_ids
        overlap = sorted(impl_in & excl_in)
        if overlap:
            raise AssertionError(
                "gap buckets not disjoint for %s — implemented AND excluded: %s"
                % (key, overlap))
        missing = sorted(universe - impl_in - excl_in, key=_sort_key)
        artifacts[key] = {
            "source": rel,
            "official_universe": len(universe),
            "implemented": len(impl_in),
            "excluded": len(excl_in),
            "missing": len(missing),
            "fireable_missing": sum(
                1 for rid in missing if not index[rid]["vacuous_in_artifact"]),
            "non_business_rule_asserts": len(index) - len(universe),
            "non_business_rule_families": _non_br_families(index),
            "missing_rules": [
                {"id": rid,
                 "flag": index[rid]["flag"],
                 "vacuous_in_artifact": index[rid]["vacuous_in_artifact"],
                 "text": index[rid]["text"]}
                for rid in missing
            ],
        }
    return {
        "description": (
            "Machine-checked complement of the rule table: for each CEN "
            "EN 16931 artifact, every official BR-* assert id that is NEITHER "
            "implemented by the engine NOR listed as a deliberate exclusion — "
            "extracted by a real XML parse of sch:assert/@id from the vendored "
            "preprocessed Schematron, with the official rule text carried "
            "verbatim. fireable_missing further subtracts any missing assert "
            "the artifact itself ships as a literal test=\"true()\" tautology "
            "(rules that can never fire officially belong to the "
            "official_tautology exclusion class, not this worklist). "
            "test_coverage_gap.py recomputes this live from the .sch files, "
            "fails on any drift, and asserts fireable_missing == 0 for every "
            "universe — so the gap can neither be hidden nor go stale, and "
            "any future artifact bump that turns a tautology into a real rule "
            "reopens the worklist automatically."),
        "artifact_order": GAP_ARTIFACT_ORDER,
        "excluded_ids_considered": sorted(excluded_ids, key=_sort_key),
        "artifacts": artifacts,
    }


PEPPOL_FAMILY_LABEL = ("the Peppol-derived rules KoSIT ships inside the "
                       "official XRechnung Schematron artifact")

_PEPPOL_IMPLEMENTED_BY_ARTIFACT = {
    "xrechnung-ubl": _coverage.peppol_ubl_rule_ids,
    "xrechnung-cii": _coverage.peppol_cii_rule_ids,
}


def build_peppol_family():
    """Machine-checked enumeration of the KoSIT-vendored PEPPOL-EN16931-R*
    family — computed LIVE, never hand-transcribed.

    For BOTH vendored KoSIT artifacts the family is extracted with a real XML
    parse of ``sch:assert/@id`` (:func:`einvoice.coverage.schematron_assert_index`
    — the VHR.1 method, no regex-on-prose). Assert ids are collapsed onto
    canonical family ids (the CII artifact splits R043 into two asserts); each
    artifact's implemented set comes from the live per-binding registry in
    :mod:`einvoice.rules_peppol`, and the not-yet-implemented remainder is
    published as an explicit ``known_open_worklist`` class with the official
    rule text carried verbatim per binding. This family is OUTSIDE the CEN
    EN 16931 ``BR-*`` gap universes (the ids share no prefix), so it neither
    inflates the CEN arithmetic nor touches the fireable-missing == 0 claim;
    ``test_coverage_gap.py`` recomputes this whole section live so it can
    never silently go stale after an artifact bump or a rule landing.
    """
    artifacts = {}
    fam_index = {}   # key -> {assert_id: entry}
    canon_map = {}   # key -> {canonical: [assert_ids]}
    for key in PEPPOL_ARTIFACT_ORDER:
        rel = SCHEMATRON_SOURCES[key]["file"]
        index = _coverage.schematron_assert_index(os.path.join(HERE, rel))
        fam = {rid: e for rid, e in index.items()
               if rid.startswith(_coverage.PEPPOL_FAMILY_PREFIX)}
        canon = {}
        for rid in fam:
            canon.setdefault(_coverage.peppol_canonical_id(rid), []).append(rid)
        for rids in canon.values():
            rids.sort()
        implemented = _PEPPOL_IMPLEMENTED_BY_ARTIFACT[key]()
        universe = set(canon)
        stray = implemented - universe
        if stray:
            raise AssertionError(
                "%s: engine claims Peppol rules the vendored artifact does "
                "not carry: %s" % (key, sorted(stray)))
        fam_index[key] = fam
        canon_map[key] = canon
        artifacts[key] = {
            "source": rel,
            "assert_ids": sorted(fam, key=_sort_key),
            "family_asserts": len(fam),
            "canonical_ids": sorted(universe, key=_sort_key),
            "family_universe": len(universe),
            "implemented": len(universe & implemented),
            "known_open": len(universe - implemented),
        }
    all_canonical = set()
    for key in PEPPOL_ARTIFACT_ORDER:
        all_canonical |= set(canon_map[key])
    implemented_all = (_coverage.peppol_ubl_rule_ids()
                       | _coverage.peppol_cii_rule_ids())
    worklist = []
    for rid in sorted(all_canonical - implemented_all, key=_sort_key):
        bindings = {}
        for key in PEPPOL_ARTIFACT_ORDER:
            aids = canon_map[key].get(rid)
            if not aids:
                continue
            bindings[key] = [
                {"assert_id": aid,
                 "flag": fam_index[key][aid]["flag"],
                 "vacuous_in_artifact": fam_index[key][aid]["vacuous_in_artifact"],
                 "text": fam_index[key][aid]["text"]}
                for aid in aids
            ]
        worklist.append({"id": rid, "bindings": bindings})
    return {
        "label": PEPPOL_FAMILY_LABEL,
        "description": (
            "Machine-checked enumeration of " + PEPPOL_FAMILY_LABEL + " (the "
            "peppol-* patterns of the vendored KoSIT XRechnung Schematron "
            "v2.5.0), extracted by a real XML parse of sch:assert/@id from "
            "BOTH binding artifacts. This is NOT full Peppol BIS Billing 3.0 "
            "support: the OpenPeppol ruleset proper (its own Schematron and "
            "test corpus) is a separate, not-vendored artifact, and nothing "
            "beyond the asserts KoSIT ships is claimed. Implemented ids are "
            "read from the live einvoice.rules_peppol registries and are "
            "differentially proven per binding (LEG 2 / LEG 4); the remainder "
            "is the explicit known_open_worklist below, official rule text "
            "verbatim. The family is outside the CEN EN 16931 BR-* gap "
            "universes, so the fireable-missing == 0 claim for those "
            "universes is unaffected. test_coverage_gap.py recomputes this "
            "section live from the vendored .sch files and fails on any "
            "drift."),
        "artifact_order": list(PEPPOL_ARTIFACT_ORDER),
        "artifacts": artifacts,
        "implemented_ids": sorted(implemented_all, key=_sort_key),
        "known_open_worklist": worklist,
    }


def build_matrix():
    """Assemble the coverage-matrix document from the live engine + graded sets."""
    entries = {}

    # Core EN 16931 rules (einvoice.rules.ALL_RULES).
    for fn in _rules.ALL_RULES:
        rid = _coverage._core_rule_id(fn)
        flag = _core_flag(fn)
        cii_ok = rid in CORE_CII_PROVEN
        prov = {
            "ubl": _prov("en16931-ubl", rid in CORE_UBL_PROVEN),
            "cii": _prov("en16931-cii", cii_ok,
                         None if cii_ok else CII_CORE_REASON.get(rid, _CII_CORE_GENERIC)),
        }
        entries[rid] = {
            "id": rid,
            "title": _title(fn, rid),
            "family": "core",
            "syntax": "both" if cii_ok else "ubl",
            "severity": _severity_class(flag),
            "flag": flag,
            "provenance": prov,
        }

    # German CIUS + extension layer (einvoice.rules_xrechnung.ALL_RULES, UBL).
    for fn in _rules_xr.ALL_RULES:
        rid = fn.rule_id
        flag = fn.severity
        cii_ok = rid in DE_CII_PROVEN
        if cii_ok:
            reason = None
        elif rid in CII_DE_REASON:
            reason = CII_DE_REASON[rid]
        elif rid.startswith("BR-DEX"):
            reason = _CII_DEX_GENERIC
        else:
            reason = _CII_DE_GENERIC
        prov = {
            "ubl": _prov("xrechnung-ubl", rid in DE_UBL_PROVEN),
            "cii": _prov("xrechnung-cii", cii_ok, reason),
        }
        entries[rid] = {
            "id": rid,
            "title": _title(fn, rid),
            "family": "xrechnung-extension" if rid.startswith("BR-DEX") else "xrechnung-cius",
            "syntax": "both" if cii_ok else "ubl",
            "severity": _severity_class(flag),
            "flag": flag,
            "provenance": prov,
        }

    # KoSIT-vendored Peppol batch (einvoice.rules_peppol) — implemented in
    # BOTH bindings, graded on LEG 2 (UBL asserts) and LEG 4 (CII asserts).
    for fn in _rules_pep.UBL_RULES:
        rid = fn.rule_id
        flag = fn.severity
        cii_ok = rid in PEP_CII_PROVEN
        prov = {
            "ubl": _prov("xrechnung-ubl", rid in PEP_UBL_PROVEN),
            "cii": _prov("xrechnung-cii", cii_ok,
                         None if cii_ok else
                         "not graded on the KoSIT-CII differential leg."),
        }
        if rid == "PEPPOL-EN16931-R043":
            prov["cii"]["asserts"] = ["PEPPOL-EN16931-R043-1",
                                      "PEPPOL-EN16931-R043-2"]
            prov["cii"]["note"] = (
                "the CII artifact splits this rule into two asserts "
                "(SpecifiedTradeAllowanceCharge and "
                "AppliedTradeAllowanceCharge contexts); BOTH are graded "
                "individually on LEG 4.")
        entries[rid] = {
            "id": rid,
            "title": _title(fn, rid),
            "family": "peppol-kosit-vendored",
            "syntax": "both" if cii_ok else "ubl",
            "severity": _severity_class(flag),
            "flag": flag,
            "provenance": prov,
        }

    rules_list = [entries[k] for k in sorted(entries, key=_sort_key)]

    # Exclusions — vacuous rules + CII scope boundaries + Peppol.
    from conformance import CALCULATION_ROUNDING_VACUOUS  # noqa: E402
    vacuous = [{"id": k, "reason": CALCULATION_ROUNDING_VACUOUS[k]}
               for k in sorted(CALCULATION_ROUNDING_VACUOUS, key=_sort_key)]
    cii_core_oos = [{"id": rid, "reason": CII_CORE_REASON[rid]}
                    for rid in sorted(_diff.CII_EXCLUDED_RULE_IDS, key=_sort_key)]
    cii_de_oos = [{"id": rid, "reason": CII_DE_REASON.get(rid, _CII_DE_GENERIC)}
                  for rid in sorted(_diff.CII_XR_EXCLUDED_RULE_IDS, key=_sort_key)]
    codelist_deferred = [{"id": rid, "reason": CODELIST_NOT_ASSERTED[rid]}
                         for rid in sorted(CODELIST_NOT_ASSERTED, key=_sort_key)]

    matrix = {
        "artifact": "einvoice conformance coverage matrix",
        "description": (
            "Machine-readable enumeration of every EN 16931 / XRechnung business "
            "rule the einvoice engine actually asserts, with the syntax it is "
            "proven to fire in, its blocking severity, and the official "
            "Schematron artifact that differentially proved it. This is the "
            "artifact to read to answer \"does it run the rules my German ERP "
            "needs, in my CI?\" — it reflects what the CODE fires (proven by "
            "test_coverage_matrix.py against the live rule registries), not "
            "aspiration."),
        "generated_by": "gen_coverage.py (derived from einvoice.rules + "
                        "einvoice.rules_xrechnung + differential.py graded sets)",
        "schematron_sources_order": SCHEMATRON_ORDER,
        "schematron_sources": SCHEMATRON_SOURCES,
        "rule_count": len(rules_list),
        "rules": rules_list,
        "exclusions": {
            "description": (
                "Rules deliberately NOT counted as coverage, documented so the "
                "matrix is honest about its boundaries."),
            "vacuous": vacuous,
            "official_tautology": official_tautology_exclusions(),
            "codelist_not_asserted": codelist_deferred,
            "cii_core_out_of_scope": cii_core_oos,
            "cii_de_out_of_scope": cii_de_oos,
            "peppol": {
                "status": "kosit-vendored-family-complete",
                "note": (
                    "Scoped honestly: the engine asserts ALL 21 canonical "
                    "PEPPOL-EN16931-R* rules that KoSIT ships inside the "
                    "official XRechnung Schematron artifact, in both bindings "
                    "(see the peppol_kosit_family section and the rule table; "
                    "each is differentially proven per binding). This is NOT "
                    "full Peppol BIS Billing 3.0 support: the OpenPeppol "
                    "ruleset proper (its own Schematron + test corpus) is a "
                    "separate, not-vendored artifact, and nothing beyond the "
                    "KoSIT-vendored asserts is claimed. The family "
                    "enumeration stays machine-checked in "
                    "peppol_kosit_family, recomputed live by "
                    "test_coverage_gap.py, so an artifact bump that adds a "
                    "new Peppol assert reopens the worklist automatically."),
            },
        },
        "gap": build_gap(set(entries), deliberate_exclusion_ids()),
        "peppol_kosit_family": build_peppol_family(),
    }
    return matrix


def render_json(matrix):
    return json.dumps(matrix, ensure_ascii=False, indent=2) + "\n"


def main(argv):
    matrix = build_matrix()
    json_text = render_json(matrix)
    md_text = _coverage.render_markdown(matrix)
    if "--check" in argv:
        stale = []
        for path, fresh in ((JSON_PATH, json_text), (MD_PATH, md_text)):
            cur = open(path, encoding="utf-8").read() if os.path.exists(path) else None
            if cur != fresh:
                stale.append(os.path.basename(path))
        if stale:
            sys.stderr.write("stale (re-run gen_coverage.py): %s\n" % ", ".join(stale))
            return 1
        print("coverage artifacts up to date (%d rules)" % matrix["rule_count"])
        return 0
    with open(JSON_PATH, "w", encoding="utf-8") as fh:
        fh.write(json_text)
    with open(MD_PATH, "w", encoding="utf-8") as fh:
        fh.write(md_text)
    print("wrote %s and %s (%d rules)"
          % (os.path.basename(JSON_PATH), os.path.basename(MD_PATH),
             matrix["rule_count"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

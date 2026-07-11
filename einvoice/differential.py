#!/usr/bin/env python3
"""Differential-validation harness for EN 16931 (UBL) + XRechnung CIUS.

Compares the fired-rule set of the OFFICIAL, NORMATIVE artifacts against the
fired-rule set of OUR validator (``einvoice/`` package), one "leg" per
ruleset:

    * EN leg        — the compiled EN16931-UBL Schematron (CEN) vs our
                      core rules (einvoice/rules.py ALL_RULES);
    * XRechnung leg — the compiled KoSIT XRechnung-UBL Schematron
                      (corpus/xrechnung-schematron, v2.5.0 / XRechnung 3.0.2)
                      vs our BR-DE-* CIUS layer
                      (einvoice/rules_xrechnung.py ALL_RULES).

The official ruleset is the legal source of truth. For every invoice and for
every one of OUR implemented rule IDs we ask the same yes/no question of both
engines — "does rule R fire on this invoice?" — and record whether they AGREE.
A disagreement is, by definition, a place where OUR interpretation departs from
the legal document = our bug:

    * WE fire R, OFFICIAL does not  -> FALSE POSITIVE  (we over-reject)
    * OFFICIAL fires R, WE do not   -> MISS / FALSE NEGATIVE (we under-reject)

Official path:
    UBL Invoice XML
      --(Saxon Xslt30 transform through the official validation XSLT)-->
    SVRL report --(parse <svrl:failed-assert> @id)--> set of fired rule IDs

Corpus (broad, real, and adversarial; shared by both legs):
    * cen-en16931  Invoice-unit-UBL test set  (each <test> case split out)
    * cen-en16931  ubl/examples               (real-world sample invoices)
    * vendored/valid + vendored/invalid        (our own fixtures)
    * xrechnung-testsuite UBL Invoice files     (real German CIUS invoices)
    * GENERATED targeted mutations: one per implemented rule, each breaking
      exactly the field that rule guards, mutated off a known-clean invoice —
      so every rule is exercised in the FAILING direction (EN mutations off a
      CEN-clean invoice, BR-DE mutations off a clean XRechnung testsuite
      invoice).

Requirements:
    export PYTHONPATH="$HOME/.local/lib/python3.10/site-packages:$PYTHONPATH"
    (SaxonC-for-Python / `saxonche` must be importable)

Usage:
    python3 differential.py                 # FULL run: EN leg + XRechnung leg
    python3 differential.py en              # EN 16931 core leg only
    python3 differential.py xrechnung       # XRechnung CIUS leg only
    python3 differential.py <invoice> ...   # ad-hoc per-invoice report
Exit code: 0 iff every graded comparison agreed (both legs).
"""

from __future__ import annotations

import copy
import os
import sys
import tempfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# OUR validator, called in-process (no subprocess overhead over a large corpus).
from einvoice.validate import validate_file          # noqa: E402
from einvoice.parser import NotWellFormed, parse_file  # noqa: E402
from einvoice import rules as _rules                  # noqa: E402
from einvoice import rules_xrechnung as _rules_xr     # noqa: E402
from einvoice import rules_peppol as _rules_pep       # noqa: E402
from einvoice import parser_cii as _parser_cii        # noqa: E402

# The OFFICIAL normative artifacts:
#  * the compiled EN16931-UBL Schematron (CEN),
#  * the compiled XRechnung-UBL Schematron (KoSIT, v2.5.0 / XRechnung 3.0.2), and
#  * the compiled EN16931-CII Schematron (CEN) — the CII (Factur-X/ZUGFeRD)
#    syntax binding of the SAME EN 16931 core rules.
OFFICIAL_XSLT = os.path.join(
    HERE, "corpus", "cen-en16931", "ubl", "xslt", "EN16931-UBL-validation.xslt"
)
XR_OFFICIAL_XSLT = os.path.join(
    HERE, "corpus", "xrechnung-schematron", "schematron", "ubl",
    "XRechnung-UBL-validation.xsl"
)
CII_OFFICIAL_XSLT = os.path.join(
    HERE, "corpus", "cen-en16931", "cii", "xslt", "EN16931-CII-validation.xslt"
)
XR_CII_OFFICIAL_XSLT = os.path.join(
    HERE, "corpus", "xrechnung-schematron", "schematron", "cii",
    "XRechnung-CII-validation.xsl"
)

# Namespaces.
NS_SVRL = "http://purl.oclc.org/dsdl/svrl"
NS_INV = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
NS_CN = "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"
NS_CAC = "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
NS_CBC = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
NS_DIFI = "http://difi.no/xsd/vefa/validator/1.0"
# CII (UN/CEFACT CrossIndustryInvoice) namespaces.
NS_RSM = _parser_cii.NS_RSM
NS_RAM = _parser_cii.NS_RAM
NS_UDT = _parser_cii.NS_UDT


# --------------------------------------------------------------------------- #
# OUR rules — read straight from einvoice/rules.py (the ALL_RULES list).
# --------------------------------------------------------------------------- #
def _fn_to_rule_id(fn) -> str:
    """br_01 -> BR-01, br_cl_01 -> BR-CL-01, br_dec_09 -> BR-DEC-09, br_s_01 -> BR-S-01."""
    parts = fn.__name__.split("_")
    return "-".join(p.upper() for p in parts)


OUR_RULE_IDS = [_fn_to_rule_id(fn) for fn in _rules.ALL_RULES]
OUR_RULE_SET = set(OUR_RULE_IDS)
assert len(OUR_RULE_IDS) == 209, OUR_RULE_IDS

# XRechnung CIUS layer — the rule ids carry -a/-b suffixes, so they are read
# from the explicit .rule_id attribute, not derived from function names.
XR_RULE_IDS = [fn.rule_id for fn in _rules_xr.ALL_RULES]
XR_RULE_SET = set(XR_RULE_IDS)
assert len(XR_RULE_IDS) == 46, XR_RULE_IDS

# XRechnung national CIUS layer in CII syntax — the BR-DE-* rules evaluated over
# the CII normalized model (rules_xrechnung.CII_DE_RULES), graded against the
# official KoSIT XRechnung-CII Schematron. Admitted set is the subset of the
# BR-DE layer whose guarded fact the model carries AND that reaches EXACT parity
# on the differential corpus.
CII_XR_RULE_IDS = [fn.rule_id for fn in _rules_xr.CII_DE_RULES]
CII_XR_RULE_SET = set(CII_XR_RULE_IDS)
assert len(CII_XR_RULE_IDS) == len(CII_XR_RULE_SET), CII_XR_RULE_IDS
assert CII_XR_RULE_SET <= XR_RULE_SET, (
    "CII BR-DE set names rules not in the UBL BR-DE layer: %s"
    % sorted(CII_XR_RULE_SET - XR_RULE_SET))

# EXCLUDED from the CII-graded BR-DE set (kept out on purpose, not overlooked).
# These BR-DE / BR-DEX rules ARE present in the official XRechnung-CII Schematron
# but bind CII document parts the syntax-agnostic EN 16931 core model deliberately
# does not carry, so they cannot be evaluated over the normalized model without
# adding a whole CII-payment / attachment / extension surface. Rather than
# approximate a national rule (forbidden), they are excluded with the reason and
# remain fully graded on the UBL XRechnung leg (LEG 2):
#
#  * BR-DE-18 (Skonto grammar in BT-20): the CII test tokenizes
#    ram:SpecifiedTradePaymentTerms/ram:Description[1] and matches the KoSIT
#    #SKONTO#…# regex — a free-text payment-terms structure the core model omits.
#  * BR-DE-19 / BR-DE-20 (BT-84 / BT-91 IBAN mod-97): keyed on
#    SpecifiedTradeSettlementPaymentMeans[ram:TypeCode='58'|'59'] IBANID — the CII
#    payment-means node set and IBAN digits are not in the core model.
#  * BR-DE-22 (unique EmbeddedDocumentBinaryObject filenames): keyed on every
#    ram:AdditionalReferencedDocument/ram:AttachmentBinaryObject/@filename.
#  * BR-DE-23-a/-b, BR-DE-24-a/-b, BR-DE-25-a/-b (payment-means type-code groups):
#    keyed on SpecifiedTradeSettlementPaymentMeans[ram:TypeCode] and its
#    Creditor/Debtor financial-account / card / mandate children.
#  * BR-DE-30 / BR-DE-31 (BT-90 / BT-91 with DIRECT DEBIT BG-19): the CII binding
#    reconstructs BG-19 semantically from DirectDebitMandateID / CreditorReferenceID
#    / PayerPartyDebtorFinancialAccount IBANID presence — none in the core model.
#  * BR-DEX-01/04/05/06/07/08/15 and BR-DE-CVD-* (extension / clean-vehicle
#    profiles): out of the CIUS scope of this leg (as on the UBL side).
CII_XR_EXCLUDED_RULE_IDS = (
    "BR-DE-18", "BR-DE-19", "BR-DE-20", "BR-DE-22",
    "BR-DE-23-a", "BR-DE-23-b", "BR-DE-24-a", "BR-DE-24-b",
    "BR-DE-25-a", "BR-DE-25-b", "BR-DE-30", "BR-DE-31",
)
assert not (CII_XR_RULE_SET & set(CII_XR_EXCLUDED_RULE_IDS)), (
    "a CII-excluded BR-DE rule is also in the graded set")

# --------------------------------------------------------------------------- #
# PEPPOL-EN16931-R* — the Peppol-derived batch KoSIT ships INSIDE the official  #
# XRechnung Schematron artifact (einvoice/rules_peppol.py). Graded on the SAME  #
# legs as the national layer (LEG 2 for UBL, LEG 4 for CII) because the SAME    #
# compiled KoSIT XSLTs evaluate the peppol-* patterns. The graded ids are the   #
# OFFICIAL per-binding assert ids (fn.assert_id): identical to the canonical    #
# rule id everywhere except R043, which the CII artifact splits into the two    #
# asserts PEPPOL-EN16931-R043-1 / -R043-2.                                      #
# --------------------------------------------------------------------------- #
PEPPOL_UBL_RULE_IDS = [fn.assert_id for fn in _rules_pep.UBL_RULES]
PEPPOL_UBL_RULE_SET = set(PEPPOL_UBL_RULE_IDS)
assert len(PEPPOL_UBL_RULE_IDS) == len(PEPPOL_UBL_RULE_SET) == 21, \
    PEPPOL_UBL_RULE_IDS

PEPPOL_CII_RULE_IDS = [fn.assert_id for fn in _rules_pep.CII_RULES]
PEPPOL_CII_RULE_SET = set(PEPPOL_CII_RULE_IDS)
assert len(PEPPOL_CII_RULE_IDS) == len(PEPPOL_CII_RULE_SET) == 22, \
    PEPPOL_CII_RULE_IDS

# Canonical (family-id) views for the coverage matrix: a canonical id is
# UBL-proven when its UBL assert is graded, CII-proven when EVERY CII assert
# carrying that canonical id is graded (R043 needs both -1 and -2).
PEPPOL_UBL_PROVEN_CANONICAL = {fn.rule_id for fn in _rules_pep.UBL_RULES}
PEPPOL_CII_PROVEN_CANONICAL = {fn.rule_id for fn in _rules_pep.CII_RULES}
assert PEPPOL_UBL_PROVEN_CANONICAL == PEPPOL_CII_PROVEN_CANONICAL, (
    "the family is implemented in BOTH bindings; the canonical sets must "
    "coincide")


# --------------------------------------------------------------------------- #
# CII leg — the SAME einvoice/rules.py core rule FUNCTIONS, run UNCHANGED over  #
# the CII-normalized model (einvoice/parser_cii.build_model), graded against    #
# the official CEN EN16931-CII Schematron.                                       #
#                                                                              #
# CII_GRADED_RULES is the subset of einvoice/rules.py ALL_RULES for which our   #
# fired-rule set reaches EXACT parity with the official CII Schematron on the    #
# differential corpus. A rule is admitted here ONLY once the leg proves 0       #
# divergence for it; rules whose UNMODIFIED UBL transcription cannot reach       #
# parity on CII (because CII gates the rule differently and we will not weaken   #
# the shared function or approximate) are EXCLUDED below with the reason.        #
# --------------------------------------------------------------------------- #
CII_GRADED_RULES = [
    # Header existence / cardinality (BR-01..16) — identical presence facts.
    _rules.br_01, _rules.br_02, _rules.br_03, _rules.br_04, _rules.br_05,
    _rules.br_06, _rules.br_07, _rules.br_08, _rules.br_10,
    # Document-total existence (BR-12..15, context = header monetary summation).
    _rules.br_12, _rules.br_13, _rules.br_14, _rules.br_15,
    # Invoice-line cardinality / content (BR-16, BR-21..27).
    _rules.br_16, _rules.br_21, _rules.br_22, _rules.br_24, _rules.br_25,
    _rules.br_26, _rules.br_27,
    # Document-type code list (BR-CL-01).
    _rules.br_cl_01,
    # Currency / country / item-classification code lists (BR-CL-03/04/05/13/14).
    # The CII parser feeds these the CII context nodes (ram:TaxTotalAmount
    # @currencyID, ram:InvoiceCurrencyCode, ram:TaxCurrencyCode, ram:ClassCode
    # @listID, ram:CountryID); the shared rule functions run unchanged.
    _rules.br_cl_03, _rules.br_cl_04, _rules.br_cl_05,
    _rules.br_cl_13, _rules.br_cl_14,
    # Payment-means (BR-CL-16), allowance/charge reason (BR-CL-19/20), item
    # standard-id scheme (BR-CL-21) and attachment MIME (BR-CL-24) code lists.
    # The CII parser feeds these the CII context nodes
    # (ram:SpecifiedTradeSettlementPaymentMeans/ram:TypeCode;
    # ram:SpecifiedTradeAllowanceCharge[.../udt:Indicator]/ram:ReasonCode;
    # ram:SpecifiedTradeProduct/ram:GlobalID/@schemeID;
    # ram:AttachmentBinaryObject/@mimeCode); the shared rule bodies run unchanged
    # and reach EXACT parity with the official CII codes Schematron.
    _rules.br_cl_16, _rules.br_cl_19, _rules.br_cl_20, _rules.br_cl_21,
    _rules.br_cl_24,
    # VAT category code lists (BR-CL-17/18) + VAT exemption reason (BR-CL-22).
    # The CII parser feeds these the CII context nodes (ram:CategoryTradeTax
    # @CategoryCode for BR-CL-17, ram:ApplicableTradeTax/ram:CategoryCode for
    # BR-CL-18, ram:ExemptionReasonCode for BR-CL-22); the shared rule bodies
    # run unchanged and reach EXACT parity with the official CII codes Schematron.
    _rules.br_cl_17, _rules.br_cl_18, _rules.br_cl_22,
    # Unit-code list (BR-CL-23). The CII parser feeds this the CII context nodes
    # (ram:BasisQuantity/@unitCode, ram:BilledQuantity/@unitCode); the shared
    # rule body runs unchanged and reaches parity with the official CII codes
    # Schematron (same 2162-entry UN/ECE Rec 20 + Rec 21 unit list as UBL).
    _rules.br_cl_23,
    # Invoiced-quantity unit code (BR-23) — attribute existence per line on
    # both bindings; the parsers bake each binding's exact check into
    # ln.has_quantity_unit_code.
    _rules.br_23,
    # Supporting documents / item attributes / tax representative / item
    # identifier-scheme rules (BR-52/54/56/64/65) and the accounting-currency,
    # VAT-point and invoicing-period constraints (BR-53, BR-CO-03/-09/-19).
    # Where the CII binding genuinely differs (BR-53's extra BT-6 != BT-5
    # conjunct, BR-56's non-empty requirement, BR-64/65's normalize-space,
    # BR-CO-03's per-breakdown-row context, BR-CO-09's space-wrapped contains
    # and its own pinned prefix list), the rule bodies branch on inv.syntax and
    # transcribe EACH binding's official predicate exactly.
    _rules.br_52, _rules.br_53, _rules.br_54, _rules.br_56,
    _rules.br_64, _rules.br_65,
    _rules.br_co_03, _rules.br_co_09, _rules.br_co_19,
    # Line VAT category code (BR-CO-04).
    _rules.br_co_04,
    # Document-level arithmetic invariants that reach CII parity.
    _rules.br_co_10, _rules.br_co_13, _rules.br_co_16, _rules.br_co_17,
    _rules.br_co_18,
    # VAT breakdown (BG-23) per-row existence + rate (BR-45..48).
    _rules.br_45, _rules.br_46, _rules.br_47, _rules.br_48,
    # Standard-rated (S) rules that reach CII parity.
    _rules.br_s_02, _rules.br_s_05, _rules.br_s_09, _rules.br_s_10,
    # Decimal-place (≤2) rules that map cleanly to the CII monetary fields.
    _rules.br_dec_09, _rules.br_dec_12, _rules.br_dec_14, _rules.br_dec_18,
    _rules.br_dec_19, _rules.br_dec_20, _rules.br_dec_23,
    # Core/decimals/VAT gap batch A (BR-CO-20..24/-26, BR-DEC-24/25/27/28,
    # BR-IC-10, BR-S-08): line billing periods, allowance/charge reasons
    # (document + line level — the CII parser now materializes the line-level
    # ram:SpecifiedTradeAllowanceCharge groups), seller identification, line
    # allowance/charge decimal places, the Intra-community (K) exemption
    # reason, and the per-rate Standard-rated bucket sum. Where the CII
    # binding genuinely differs (BR-CO-26's identifier disjuncts, BR-S-08's
    # exact per-bucket round2 equality vs the UBL ±1 band), the shared rule
    # bodies branch on inv.syntax and transcribe EACH binding exactly.
    _rules.br_co_20, _rules.br_co_21, _rules.br_co_22, _rules.br_co_23,
    _rules.br_co_24, _rules.br_co_26,
    _rules.br_dec_24, _rules.br_dec_25, _rules.br_dec_27, _rules.br_dec_28,
    _rules.br_ic_10, _rules.br_s_08,
    # IGIC batch B (BR-AF-01..07, BR-AF-10): the Canary Islands 'L' VAT
    # category family. Where the CII binding genuinely differs (the
    # BR-AF-05/06/07 rate predicate is ``> 0`` on CII vs ``>= 0`` on UBL),
    # the shared rule bodies branch on inv.syntax and transcribe EACH
    # binding exactly. BR-AF-08 and BR-AF-09 are CII-excluded below — the
    # official CII artifact ships BOTH as asserts that can never fire.
    _rules.br_af_01, _rules.br_af_02, _rules.br_af_03, _rules.br_af_04,
    _rules.br_af_05, _rules.br_af_06, _rules.br_af_07,
    _rules.br_af_10,
    # IPSI batch C (BR-AG-01..07, BR-AG-10) + Italian split payment
    # (BR-B-01/02). The BR-AG rate rules (05/06/07) are ``>= 0`` on BOTH
    # bindings — the CII artifact ships ``ram:RateApplicablePercent >= 0``,
    # unlike BR-AF's strict CII ``> 0`` — so the shared bodies run
    # unbranched. BR-AG-08 and BR-AG-09 are CII-excluded below for exactly
    # the BR-AF-08/09 artifact defects. BR-B-01/02 are plain raw
    # ``//ram:CategoryCode`` + ``//ram:CountryID`` comparisons on CII —
    # fully graded.
    _rules.br_ag_01, _rules.br_ag_02, _rules.br_ag_03, _rules.br_ag_04,
    _rules.br_ag_05, _rules.br_ag_06, _rules.br_ag_07,
    _rules.br_ag_10,
    _rules.br_b_01, _rules.br_b_02,
]

# EXCLUDED from the CII graded set (kept out on purpose, not overlooked). Each was
# confirmed to DIVERGE on the CII corpus under the unmodified UBL rule function —
# because the CII Schematron binds these particular rules with genuinely different
# semantics than the UBL binding — so grading them would ship a divergence. We do
# not weaken the shared rule function or approximate; we simply do not assert them
# on CII (they remain fully graded on the EN/XRechnung UBL legs):
#
#  * BR-CO-14 (Invoice total VAT amount BT-110 = Σ VAT category tax BT-117):
#    the official CII context is ``//SpecifiedTradeSettlementHeaderMonetary
#    Summation/ram:TaxTotalAmount[@currencyID=InvoiceCurrencyCode]`` — the rule
#    exists ONLY when a document-currency BT-110 element is present. CII invoices
#    with no VAT (e.g. an all-"O"/Not-subject invoice) legitimately OMIT
#    ram:TaxTotalAmount, so the official assert never fires there; the UBL
#    transcription (which fires whenever a breakdown is present but the total is
#    absent) over-rejects those documents (verified on CII_example7, XRechnung-O).
#  * BR-CO-15 (total with VAT = total without VAT + total VAT): the CII binding
#    carries an extra disjunct — ``GrandTotalAmount = TaxBasisTotalAmount`` — that
#    HOLDS for a no-VAT invoice with no BT-110; the UBL function requires exactly
#    one document-currency VAT total and has no such disjunct, so it over-rejects
#    the same BT-110-less CII documents (same two examples).
#  * BR-09 / BR-11 (Seller/Buyer postal address shall contain a country code):
#    the CII binding evaluates ``normalize-space(.../PostalTradeAddress/CountryID)
#    != ''`` with the /rsm:CrossIndustryInvoice ROOT as its context, so it fires
#    even when the whole postal address is absent. The UBL function is gated on the
#    PostalAddress node existing (BR-09/BR-11's UBL context IS that node), so on a
#    CII invoice missing the address it holds where the official fires (a MISS,
#    seen on the BR-08/BR-10 mutations). BR-08/BR-10 (address existence) stay
#    graded; the country-code rules do not.
#  * BR-S-01 (Standard-rated item ⇒ Standard-rated VAT breakdown): the CII binding
#    is a WEAK one-directional count — ``count(line S)+count(header S) >= 2 or
#    not(line S)`` — which is satisfied by two or more S rows on either side and,
#    unlike the UBL binding, does NOT flag an orphan S breakdown with no S item.
#    The UBL function is the strict biconditional (fires on either orphan side), so
#    it over-fires on CII invoices with an S breakdown but no S line (seen on the
#    BR-16 / BR-CO-18 mutations, which strip the lines / breakdown).
#  * BR-AF-08 (IGIC breakdown taxable BT-116 = per-rate bucket sum): the CII
#    artifact binds the assert to the ``ram:ApplicableTradeTax`` ROW (unlike
#    BR-S-08, whose context node is the ``ram:CategoryCode`` CHILD), so the
#    test's ``../ram:RateApplicablePercent`` resolves against the header
#    settlement — which has no such children — and ``every $rate in ()`` is
#    vacuously true: the shipped assert can NEVER fire (verified: the official
#    engine clears a +2-shifted BasisAmount). Our engine asserts the intended
#    per-bucket round2 arithmetic on CII anyway (deliberate strictness), so
#    grading would ship a guaranteed false-positive divergence.
#  * BR-AF-09 (IGIC breakdown tax amount BT-117 = taxable BT-116 × rate BT-119):
#    the official CII artifact ships this assert as ``test="true()"`` — a
#    tautology that can NEVER fire, whatever the arithmetic — while the UBL
#    binding carries the real ±1 band. Our engine asserts the real EN 16931
#    arithmetic on both syntaxes (deliberate strictness), so grading it on CII
#    would ship a guaranteed false-positive divergence on every violating
#    fixture. Both stay fully graded on the UBL leg.
#  * BR-AG-08 / BR-AG-09 (IPSI breakdown taxable-sum / tax-amount arithmetic):
#    the official CII artifact repeats BOTH BR-AF defects verbatim for the
#    'M' family — BR-AG-08 is bound to the ``ram:ApplicableTradeTax`` ROW
#    (empty ``../ram:RateApplicablePercent`` ⇒ ``every $rate in ()`` is
#    vacuously true) and BR-AG-09 ships as ``test="true()"`` — so neither
#    shipped assert can ever fire on CII. Our engine asserts the intended
#    arithmetic on the CII model anyway (deliberate strictness); both stay
#    fully graded on the UBL leg.
CII_EXCLUDED_RULE_IDS = ("BR-CO-14", "BR-CO-15", "BR-09", "BR-11", "BR-S-01",
                         "BR-AF-08", "BR-AF-09", "BR-AG-08", "BR-AG-09")

CII_RULE_IDS = [_fn_to_rule_id(fn) for fn in CII_GRADED_RULES]
CII_RULE_SET = set(CII_RULE_IDS)
assert len(CII_RULE_IDS) == len(set(CII_RULE_IDS)), CII_RULE_IDS
assert CII_RULE_SET <= OUR_RULE_SET, (
    "CII graded set names rules not in einvoice/rules.py ALL_RULES: %s"
    % sorted(CII_RULE_SET - OUR_RULE_SET))
assert not (CII_RULE_SET & set(CII_EXCLUDED_RULE_IDS)), (
    "a CII-excluded rule is also in the graded set")


def cii_our_fired(invoice_path: str) -> set:
    """Fired core-rule ids of OUR validator on the CII-normalized model.

    Parses the CII invoice with :func:`einvoice.parser_cii.parse` and runs the
    UNMODIFIED :mod:`einvoice.rules` graded functions against it — the whole
    point of the leg is that the syntax-agnostic rule bodies are reused verbatim.
    """
    inv = _parser_cii.parse(invoice_path)
    fired = set()
    for fn in CII_GRADED_RULES:
        v = fn(inv)
        if v is not None:
            fired.add(v.rule_id)
    return fired


# --------------------------------------------------------------------------- #
# OFFICIAL side — compile the 895 KB XSLT ONCE, reuse across the whole corpus.
# --------------------------------------------------------------------------- #
def _rule_id_from_failed_assert(fa: ET.Element):
    rid = fa.get("id")
    if rid:
        return rid.strip()
    flag = fa.get("flag")
    if flag and flag.strip() and flag.strip().lower() not in ("fatal", "warning"):
        return flag.strip()
    text_el = fa.find(f"{{{NS_SVRL}}}text")
    if text_el is not None and text_el.text:
        t = text_el.text.strip()
        if t.startswith("[") and "]" in t:
            return t[1:t.index("]")].strip()
    return None


class Official:
    """Wraps a single compiled instance of a normative validation XSLT."""

    def __init__(self, xslt_path=OFFICIAL_XSLT):
        from saxonche import PySaxonProcessor
        self._proc_cm = PySaxonProcessor(license=False)
        self._proc = self._proc_cm.__enter__()
        xp = self._proc.new_xslt30_processor()
        self._exe = xp.compile_stylesheet(stylesheet_file=xslt_path)
        self._xp = xp

    def fired(self, invoice_path: str) -> set:
        svrl = self._exe.transform_to_string(source_file=invoice_path)
        if svrl is None:
            raise RuntimeError("Saxon returned no SVRL for %s: %s"
                               % (invoice_path, self._xp.error_message))
        root = ET.fromstring(svrl)
        fired = set()
        for fa in root.iter(f"{{{NS_SVRL}}}failed-assert"):
            rid = _rule_id_from_failed_assert(fa)
            if rid:
                fired.add(rid)
        return fired

    def close(self):
        try:
            self._proc_cm.__exit__(None, None, None)
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# OUR side — in-process.
# --------------------------------------------------------------------------- #
def our_fired(invoice_path: str) -> set:
    result = validate_file(invoice_path)
    return {v.rule_id for v in result.violations}


def xr_our_fired(invoice_path: str) -> set:
    """Fired BR-DE-* ids of OUR XRechnung CIUS layer (all severities — the
    official SVRL reports warning/information failed-asserts the same way),
    plus the fired OFFICIAL assert ids of the implemented PEPPOL-EN16931-R*
    batch (einvoice.rules_peppol.UBL_RULES) — both layers live in the same
    KoSIT artifact, so LEG 2 grades them together."""
    root = parse_file(invoice_path)
    fired = {v.rule_id for v in _rules_xr.evaluate(root)}
    for fn in _rules_pep.UBL_RULES:
        if fn(root) is not None:
            fired.add(fn.assert_id)
    return fired


def xr_cii_our_fired(invoice_path: str) -> set:
    """Fired BR-DE-* ids of OUR XRechnung national layer evaluated over the CII
    normalized model — the admitted CII_DE_RULES run over
    einvoice.parser_cii.build_model, mirroring how the core rules run over CII —
    plus the fired OFFICIAL assert ids of the implemented PEPPOL-EN16931-R*
    batch, which runs over the RAW CII tree (rules like R008 constrain the
    literal document, not a normalized model)."""
    inv = _parser_cii.parse(invoice_path)
    fired = {v.rule_id for v in _rules_xr.evaluate_cii(inv)}
    raw_root = ET.parse(invoice_path).getroot()
    for fn in _rules_pep.CII_RULES:
        if fn(raw_root) is not None:
            fired.add(fn.assert_id)
    return fired


# --------------------------------------------------------------------------- #
# Ad-hoc, backwards-compatible per-invoice helpers (difi envelope unwrapping).
# --------------------------------------------------------------------------- #
def _localname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _normalized_invoice_path(invoice_path: str):
    try:
        tree = ET.parse(invoice_path)
    except ET.ParseError:
        return invoice_path, (lambda: None)
    root = tree.getroot()
    root_ns = root.tag.split("}", 1)[0].lstrip("{") if "}" in root.tag else ""
    if root_ns != NS_DIFI:
        return invoice_path, (lambda: None)
    inner = None
    for el in root.iter():
        ns = el.tag.split("}", 1)[0].lstrip("{") if "}" in el.tag else ""
        if ns in (NS_INV, NS_CN):
            inner = el
            break
    if inner is None:
        return invoice_path, (lambda: None)
    fd, tmp = tempfile.mkstemp(suffix=".xml", prefix="diff-unwrapped-")
    os.close(fd)
    ET.ElementTree(inner).write(tmp, encoding="utf-8", xml_declaration=True)
    return tmp, (lambda: os.path.exists(tmp) and os.remove(tmp))


def official_fired_rules(invoice_path: str, xslt_path=OFFICIAL_XSLT) -> set:
    """One-shot official run (compiles the XSLT); use Official() for batches."""
    path, cleanup = _normalized_invoice_path(invoice_path)
    try:
        return Official(xslt_path).fired(path)
    finally:
        cleanup()


def our_fired_rules(invoice_path: str) -> set:
    path, cleanup = _normalized_invoice_path(invoice_path)
    try:
        return our_fired(path)
    finally:
        cleanup()


# --------------------------------------------------------------------------- #
# Corpus assembly.
# --------------------------------------------------------------------------- #
def _register_ns():
    ET.register_namespace("", NS_INV)
    ET.register_namespace("cac", NS_CAC)
    ET.register_namespace("cbc", NS_CBC)


def _write_doc(elem: ET.Element, out_path: str):
    _register_ns()
    ET.ElementTree(elem).write(out_path, encoding="utf-8", xml_declaration=True)


def _root_ns(elem: ET.Element) -> str:
    return elem.tag.split("}", 1)[0].lstrip("{") if "}" in elem.tag else ""


def _gather_bare_invoices():
    """(label, abs_path) for every bare-UBL *Invoice* file across the corpus."""
    out = []
    dirs = [
        ("cen-ex",     os.path.join(HERE, "corpus", "cen-en16931", "ubl", "examples")),
        ("vend-valid", os.path.join(HERE, "corpus", "vendored", "valid")),
        ("vend-inval", os.path.join(HERE, "corpus", "vendored", "invalid")),
    ]
    for tag, d in dirs:
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if not name.lower().endswith(".xml"):
                continue
            p = os.path.join(d, name)
            try:
                root = ET.parse(p).getroot()
            except ET.ParseError:
                continue
            if _root_ns(root) != NS_INV:      # Invoice documents only
                continue
            out.append(("%s/%s" % (tag, name), p))

    # xrechnung-testsuite: real German CIUS invoices, scattered under src/test.
    xr = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test")
    if os.path.isdir(xr):
        for dirpath, _dirs, files in os.walk(xr):
            for name in sorted(files):
                if not name.lower().endswith(".xml"):
                    continue
                p = os.path.join(dirpath, name)
                try:
                    root = ET.parse(p).getroot()
                except ET.ParseError:
                    continue
                if _root_ns(root) != NS_INV:
                    continue
                rel = os.path.relpath(p, xr)
                out.append(("xr/%s" % rel, p))
    return out


def _split_cen_testsets(scratch: str):
    """Split every difi <testSet> Invoice case into its own standalone file.

    Each <test> in a CEN unit-test file is an independent invoice with a known
    ground-truth expectation; the official Schematron is still the arbiter.
    Returns [(label, abs_path)].
    """
    src = os.path.join(HERE, "corpus", "cen-en16931", "test", "Invoice-unit-UBL")
    out = []
    if not os.path.isdir(src):
        return out
    dst = os.path.join(scratch, "cen-split")
    os.makedirs(dst, exist_ok=True)
    for name in sorted(os.listdir(src)):
        if not name.lower().endswith(".xml"):
            continue
        try:
            root = ET.parse(os.path.join(src, name)).getroot()
        except ET.ParseError:
            continue
        if _root_ns(root) != NS_DIFI:
            continue
        idx = 0
        for test in root.iter("{%s}test" % NS_DIFI):
            inner = None
            for el in test:
                if _root_ns(el) == NS_INV:
                    inner = el
                    break
            if inner is None:
                continue
            base = name[:-4]
            out_path = os.path.join(dst, "%s__t%d.xml" % (base, idx))
            _write_doc(inner, out_path)
            out.append(("cen-unit/%s#t%d" % (base, idx), out_path))
            idx += 1
    return out


# ------- generated mutations: break exactly the field each rule guards ------ #
def _q(ns, local):
    return "{%s}%s" % (ns, local)


def _parent_map(root):
    return {c: p for p in root.iter() for c in p}


def _child(root, ns, local):
    for c in root:
        if c.tag == _q(ns, local):
            return c
    return None


def _remove(root, elem):
    _parent_map(root)[elem].remove(elem)


def _first_line(root):
    # In UBL, InvoiceLine lives in the cac namespace (cac:InvoiceLine).
    return next((c for c in root if c.tag == _q(NS_CAC, "InvoiceLine")), None)


def _supplier_party(r):
    return _child(_child(r, NS_CAC, "AccountingSupplierParty"), NS_CAC, "Party")


def _customer_party(r):
    return _child(_child(r, NS_CAC, "AccountingCustomerParty"), NS_CAC, "Party")


def _mut_br01(r): _remove(r, _child(r, NS_CBC, "CustomizationID"))
def _mut_br02(r): _remove(r, _child(r, NS_CBC, "ID"))
def _mut_br03(r): _remove(r, _child(r, NS_CBC, "IssueDate"))
def _mut_br04(r): _remove(r, _child(r, NS_CBC, "InvoiceTypeCode"))
def _mut_br05(r): _remove(r, _child(r, NS_CBC, "DocumentCurrencyCode"))


def _mut_br06(r):
    ple = _child(_supplier_party(r), NS_CAC, "PartyLegalEntity")
    ple.remove(_child(ple, NS_CBC, "RegistrationName"))


def _mut_br07(r):
    ple = _child(_customer_party(r), NS_CAC, "PartyLegalEntity")
    ple.remove(_child(ple, NS_CBC, "RegistrationName"))


def _mut_br08(r):
    party = _supplier_party(r)
    party.remove(_child(party, NS_CAC, "PostalAddress"))


def _mut_br09(r):
    # Drop the Seller PostalAddress country -> BR-09 (address still present).
    pa = _child(_supplier_party(r), NS_CAC, "PostalAddress")
    pa.remove(_child(pa, NS_CAC, "Country"))


def _mut_br10(r):
    # Drop the whole Buyer PostalAddress -> BR-10 (BR-11's context vanishes).
    party = _customer_party(r)
    party.remove(_child(party, NS_CAC, "PostalAddress"))


def _mut_br11(r):
    # Drop the Buyer PostalAddress country -> BR-11 (address still present).
    pa = _child(_customer_party(r), NS_CAC, "PostalAddress")
    pa.remove(_child(pa, NS_CAC, "Country"))


def _mut_br12(r):
    _lmt(r).remove(_child(_lmt(r), NS_CBC, "LineExtensionAmount"))


def _mut_br13(r):
    _lmt(r).remove(_child(_lmt(r), NS_CBC, "TaxExclusiveAmount"))


def _mut_br14(r):
    _lmt(r).remove(_child(_lmt(r), NS_CBC, "TaxInclusiveAmount"))


def _mut_br15(r):
    _lmt(r).remove(_child(_lmt(r), NS_CBC, "PayableAmount"))


def _mut_br16(r):
    for ln in [c for c in r if c.tag == _q(NS_CAC, "InvoiceLine")]:
        r.remove(ln)


def _mut_br21(r):
    ln = _first_line(r)
    ln.remove(_child(ln, NS_CBC, "ID"))


def _mut_br22(r):
    ln = _first_line(r)
    ln.remove(_child(ln, NS_CBC, "InvoicedQuantity"))


def _mut_br24(r):
    ln = _first_line(r)
    ln.remove(_child(ln, NS_CBC, "LineExtensionAmount"))


def _mut_br25(r):
    item = _child(_first_line(r), NS_CAC, "Item")
    item.remove(_child(item, NS_CBC, "Name"))


def _mut_br26(r):
    ln = _first_line(r)
    price = _child(ln, NS_CAC, "Price")
    price.remove(_child(price, NS_CBC, "PriceAmount"))


def _mut_br27(r):
    price = _child(_first_line(r), NS_CAC, "Price")
    _child(price, NS_CBC, "PriceAmount").text = "-1"


def _mut_br28(r):
    # Add an Item price discount group whose gross price (BaseAmount) is
    # negative -> BR-28.
    price = _child(_first_line(r), NS_CAC, "Price")
    ac = _sub_el(price, NS_CAC, "AllowanceCharge")
    _sub_el(ac, NS_CBC, "ChargeIndicator", "false")
    _sub_el(ac, NS_CBC, "Amount", "10.00", currency=True)
    _sub_el(ac, NS_CBC, "BaseAmount", "-1", currency=True)


def _mut_br29(r):
    # Document-level InvoicePeriod end date BEFORE the start date -> BR-29.
    period = _child(r, NS_CAC, "InvoicePeriod")
    _child(period, NS_CBC, "EndDate").text = "2018-08-01"


def _mut_br30(r):
    # Line-level InvoicePeriod end date BEFORE the start date -> BR-30.
    period = _child(_first_line(r), NS_CAC, "InvoicePeriod")
    _child(period, NS_CBC, "EndDate").text = "2018-08-01"


def _mut_brco04(r):
    # Remove the line item's ClassifiedTaxCategory -> BR-CO-04 (the orphan S
    # breakdown row also fires BR-S-01 on both sides; agreement is per rule).
    item = _child(_first_line(r), NS_CAC, "Item")
    item.remove(_child(item, NS_CAC, "ClassifiedTaxCategory"))


def _mut_brcl01(r):
    _child(r, NS_CBC, "InvoiceTypeCode").text = "999"


def _lmt(r):
    return _child(r, NS_CAC, "LegalMonetaryTotal")


def _mut_brco10(r):
    _child(_lmt(r), NS_CBC, "LineExtensionAmount").text = "111111.11"


def _mut_brco11(r):
    # State a document allowance total (BT-107) with no document allowances at
    # all: Σ BT-92 = 0 != 12.34, so BR-CO-11 fires (both engines).
    _sub_el(_lmt(r), NS_CBC, "AllowanceTotalAmount", "12.34", currency=True)


def _mut_brco12(r):
    # State a document charge total (BT-108) with no document charges: Σ = 0.
    _sub_el(_lmt(r), NS_CBC, "ChargeTotalAmount", "12.34", currency=True)


def _mut_brco13(r):
    _child(_lmt(r), NS_CBC, "TaxExclusiveAmount").text = "111111.11"


def _mut_brco14(r):
    tt = _child(r, NS_CAC, "TaxTotal")
    _child(tt, NS_CBC, "TaxAmount").text = "999.99"   # BT-110 != sum(BT-117)


def _mut_brco15(r):
    _child(_lmt(r), NS_CBC, "TaxInclusiveAmount").text = "111111.11"


def _mut_brs01(r):
    # S present on the line, but flip the VAT-breakdown category away from S.
    sub = _child(_child(r, NS_CAC, "TaxTotal"), NS_CAC, "TaxSubtotal")
    cat = _child(sub, NS_CAC, "TaxCategory")
    _child(cat, NS_CBC, "ID").text = "E"


def _set_line_category(r, code):
    """Flip the first line's ClassifiedTaxCategory code (breakdown stays 'S')."""
    item = _child(_first_line(r), NS_CAC, "Item")
    ctc = _child(item, NS_CAC, "ClassifiedTaxCategory")
    _child(ctc, NS_CBC, "ID").text = code


def _mut_brz01(r): _set_line_category(r, "Z")
def _mut_brae01(r): _set_line_category(r, "AE")
def _mut_bre01(r): _set_line_category(r, "E")
def _mut_brg01(r): _set_line_category(r, "G")
def _mut_bric01(r): _set_line_category(r, "K")
def _mut_bro01(r): _set_line_category(r, "O")


def _mut_brco16(r):
    _child(_lmt(r), NS_CBC, "PayableAmount").text = "111111.11"


def _mut_brco17(r):
    # Subtotal BT-117 more than 1 unit away from taxable x rate.
    st = _child(_child(r, NS_CAC, "TaxTotal"), NS_CAC, "TaxSubtotal")
    _child(st, NS_CBC, "TaxAmount").text = "99.99"


def _mut_brco18(r):
    # Remove the only VAT breakdown group.
    tt = _child(r, NS_CAC, "TaxTotal")
    tt.remove(_child(tt, NS_CAC, "TaxSubtotal"))


# ---- BR-DEC mutations: give exactly one monetary field a 3rd decimal. ----- #
def _sub_el(parent, ns, local, text=None, currency=False):
    el = ET.SubElement(parent, _q(ns, local))
    if text is not None:
        el.text = text
    if currency:
        el.set("currencyID", "DKK")
    return el


def _add_doc_allowance_charge(r, charge, amount, base=None, percent="25",
                              category="S"):
    """Insert a document-level AllowanceCharge before cac:TaxTotal."""
    ac = ET.Element(_q(NS_CAC, "AllowanceCharge"))
    _sub_el(ac, NS_CBC, "ChargeIndicator", "true" if charge else "false")
    _sub_el(ac, NS_CBC, "AllowanceChargeReason", "Adjustment")
    _sub_el(ac, NS_CBC, "Amount", amount, currency=True)
    if base is not None:
        _sub_el(ac, NS_CBC, "BaseAmount", base, currency=True)
    cat = _sub_el(ac, NS_CAC, "TaxCategory")
    _sub_el(cat, NS_CBC, "ID", category)
    _sub_el(cat, NS_CBC, "Percent", percent)
    _sub_el(_sub_el(cat, NS_CAC, "TaxScheme"), NS_CBC, "ID", "VAT")
    r.insert(list(r).index(_child(r, NS_CAC, "TaxTotal")), ac)


def _mut_brdec01(r): _add_doc_allowance_charge(r, charge=False, amount="10.009")
def _mut_brdec02(r): _add_doc_allowance_charge(r, charge=False, amount="10.00",
                                               base="100.009")
def _mut_brdec05(r): _add_doc_allowance_charge(r, charge=True, amount="10.009")
def _mut_brdec06(r): _add_doc_allowance_charge(r, charge=True, amount="10.00",
                                               base="100.009")


def _mut_brdec09(r): _child(_lmt(r), NS_CBC, "LineExtensionAmount").text = "625743.549"
def _mut_brdec10(r): _sub_el(_lmt(r), NS_CBC, "AllowanceTotalAmount", "0.009",
                             currency=True)
def _mut_brdec11(r): _sub_el(_lmt(r), NS_CBC, "ChargeTotalAmount", "0.009",
                             currency=True)
def _mut_brdec12(r): _child(_lmt(r), NS_CBC, "TaxExclusiveAmount").text = "625743.549"
def _mut_brdec14(r): _child(_lmt(r), NS_CBC, "TaxInclusiveAmount").text = "782179.439"
def _mut_brdec16(r): _sub_el(_lmt(r), NS_CBC, "PrepaidAmount", "0.009", currency=True)
def _mut_brdec17(r): _sub_el(_lmt(r), NS_CBC, "PayableRoundingAmount", "0.006",
                             currency=True)
def _mut_brdec18(r): _child(_lmt(r), NS_CBC, "PayableAmount").text = "782179.439"


def _subtotal(r):
    return _child(_child(r, NS_CAC, "TaxTotal"), NS_CAC, "TaxSubtotal")


def _mut_brdec19(r): _child(_subtotal(r), NS_CBC, "TaxableAmount").text = "625743.549"
def _mut_brdec20(r): _child(_subtotal(r), NS_CBC, "TaxAmount").text = "156435.889"
def _mut_brdec23(r):
    _child(_first_line(r), NS_CBC, "LineExtensionAmount").text = "625743.549"


# ---- VAT breakdown (BG-23) mutations: break exactly one subtotal field ----- #
def _mut_br45(r):
    st = _subtotal(r)
    st.remove(_child(st, NS_CBC, "TaxableAmount"))


def _mut_br46(r):
    st = _subtotal(r)
    st.remove(_child(st, NS_CBC, "TaxAmount"))


def _mut_br47(r):
    cat = _child(_subtotal(r), NS_CAC, "TaxCategory")
    cat.remove(_child(cat, NS_CBC, "ID"))


def _mut_br48(r):
    cat = _child(_subtotal(r), NS_CAC, "TaxCategory")
    cat.remove(_child(cat, NS_CBC, "Percent"))


# ---- Standard-rated (BR-S-*) mutations, off the S-rated clean base --------- #
def _supplier_remove_party_tax_scheme(r):
    party = _supplier_party(r)
    party.remove(_child(party, NS_CAC, "PartyTaxScheme"))


def _mut_brs02(r):
    # S line present (base has one) + no Seller VAT identifier -> BR-S-02.
    _supplier_remove_party_tax_scheme(r)


def _mut_brs03(r):
    # S document-level allowance + no Seller VAT id -> BR-S-03 (also BR-S-02).
    _add_doc_allowance_charge(r, charge=False, amount="10.00", percent="25")
    _supplier_remove_party_tax_scheme(r)


def _mut_brs04(r):
    # S document-level charge + no Seller VAT id -> BR-S-04 (also BR-S-02).
    _add_doc_allowance_charge(r, charge=True, amount="10.00", percent="25")
    _supplier_remove_party_tax_scheme(r)


def _mut_brs05(r):
    # S invoice line with VAT rate 0 -> BR-S-05.
    item = _child(_first_line(r), NS_CAC, "Item")
    ctc = _child(item, NS_CAC, "ClassifiedTaxCategory")
    _child(ctc, NS_CBC, "Percent").text = "0"


def _mut_brs06(r):
    # S document-level allowance with VAT rate 0 -> BR-S-06.
    _add_doc_allowance_charge(r, charge=False, amount="10.00", percent="0")


def _mut_brs07(r):
    # S document-level charge with VAT rate 0 -> BR-S-07.
    _add_doc_allowance_charge(r, charge=True, amount="10.00", percent="0")


def _mut_brs09(r):
    # S breakdown TaxAmount far from taxable x rate -> BR-S-09.
    _child(_subtotal(r), NS_CBC, "TaxAmount").text = "99.99"


def _mut_brs10(r):
    # S breakdown carrying a VAT exemption reason -> BR-S-10.
    cat = _child(_subtotal(r), NS_CAC, "TaxCategory")
    _sub_el(cat, NS_CBC, "TaxExemptionReason", "Reverse charge")


# ---- Zero-rated (BR-Z-*) / Exempt (BR-E-*) mutations ------------------------ #
def _convert_category(r, code, exemption_reason=None):
    """Rewrite the clean S-25% base into a clean single-category invoice:
    line + breakdown category -> ``code`` at 0%, VAT amounts -> 0, totals
    reconciled (TaxInclusive = TaxExclusive). ``exemption_reason`` (required
    for a clean E invoice by BR-E-10) is added to the breakdown TaxCategory."""
    item = _child(_first_line(r), NS_CAC, "Item")
    ctc = _child(item, NS_CAC, "ClassifiedTaxCategory")
    _child(ctc, NS_CBC, "ID").text = code
    _child(ctc, NS_CBC, "Percent").text = "0"
    tt = _child(r, NS_CAC, "TaxTotal")
    _child(tt, NS_CBC, "TaxAmount").text = "0.00"
    st = _child(tt, NS_CAC, "TaxSubtotal")
    _child(st, NS_CBC, "TaxAmount").text = "0.00"
    cat = _child(st, NS_CAC, "TaxCategory")
    _child(cat, NS_CBC, "ID").text = code
    _child(cat, NS_CBC, "Percent").text = "0"
    if exemption_reason is not None:
        reason = ET.Element(_q(NS_CBC, "TaxExemptionReason"))
        reason.text = exemption_reason
        # UBL order: ... Percent, TaxExemptionReasonCode, TaxExemptionReason,
        # TaxScheme — insert just before cac:TaxScheme.
        cat.insert(list(cat).index(_child(cat, NS_CAC, "TaxScheme")), reason)
    excl = _child(_lmt(r), NS_CBC, "TaxExclusiveAmount").text
    _child(_lmt(r), NS_CBC, "TaxInclusiveAmount").text = excl
    _child(_lmt(r), NS_CBC, "PayableAmount").text = excl


def _to_zero_rated(r):
    _convert_category(r, "Z")


def _to_exempt(r):
    _convert_category(r, "E", exemption_reason="Exempt from VAT")


def _mut_brz02(r):
    # Z line + no Seller VAT identifier -> BR-Z-02.
    _to_zero_rated(r)
    _supplier_remove_party_tax_scheme(r)


def _mut_brz03(r):
    # Z document-level allowance + no Seller VAT id -> BR-Z-03 (also BR-Z-02).
    _to_zero_rated(r)
    _add_doc_allowance_charge(r, charge=False, amount="10.00", percent="0",
                              category="Z")
    _supplier_remove_party_tax_scheme(r)


def _mut_brz04(r):
    # Z document-level charge + no Seller VAT id -> BR-Z-04 (also BR-Z-02).
    _to_zero_rated(r)
    _add_doc_allowance_charge(r, charge=True, amount="10.00", percent="0",
                              category="Z")
    _supplier_remove_party_tax_scheme(r)


def _mut_brz05(r):
    # Z invoice line with a non-zero VAT rate -> BR-Z-05.
    _to_zero_rated(r)
    item = _child(_first_line(r), NS_CAC, "Item")
    ctc = _child(item, NS_CAC, "ClassifiedTaxCategory")
    _child(ctc, NS_CBC, "Percent").text = "5"


def _mut_brz06(r):
    # Z document-level allowance with a non-zero VAT rate -> BR-Z-06.
    _to_zero_rated(r)
    _add_doc_allowance_charge(r, charge=False, amount="10.00", percent="5",
                              category="Z")


def _mut_brz07(r):
    # Z document-level charge with a non-zero VAT rate -> BR-Z-07.
    _to_zero_rated(r)
    _add_doc_allowance_charge(r, charge=True, amount="10.00", percent="5",
                              category="Z")


def _mut_brz08(r):
    # Z breakdown taxable amount != exact sum of Z line nets -> BR-Z-08.
    _to_zero_rated(r)
    _child(_subtotal(r), NS_CBC, "TaxableAmount").text = "111111.11"


def _mut_brz09(r):
    # Z breakdown tax amount != 0 -> BR-Z-09.
    _to_zero_rated(r)
    _child(_subtotal(r), NS_CBC, "TaxAmount").text = "10.00"


def _mut_brz10(r):
    # Z breakdown carrying a VAT exemption reason -> BR-Z-10.
    _to_zero_rated(r)
    cat = _child(_subtotal(r), NS_CAC, "TaxCategory")
    _sub_el(cat, NS_CBC, "TaxExemptionReason", "n/a")


def _mut_bre02(r):
    _to_exempt(r)
    _supplier_remove_party_tax_scheme(r)


def _mut_bre03(r):
    _to_exempt(r)
    _add_doc_allowance_charge(r, charge=False, amount="10.00", percent="0",
                              category="E")
    _supplier_remove_party_tax_scheme(r)


def _mut_bre04(r):
    _to_exempt(r)
    _add_doc_allowance_charge(r, charge=True, amount="10.00", percent="0",
                              category="E")
    _supplier_remove_party_tax_scheme(r)


def _mut_bre05(r):
    _to_exempt(r)
    item = _child(_first_line(r), NS_CAC, "Item")
    ctc = _child(item, NS_CAC, "ClassifiedTaxCategory")
    _child(ctc, NS_CBC, "Percent").text = "5"


def _mut_bre06(r):
    _to_exempt(r)
    _add_doc_allowance_charge(r, charge=False, amount="10.00", percent="5",
                              category="E")


def _mut_bre07(r):
    _to_exempt(r)
    _add_doc_allowance_charge(r, charge=True, amount="10.00", percent="5",
                              category="E")


def _mut_bre08(r):
    _to_exempt(r)
    _child(_subtotal(r), NS_CBC, "TaxableAmount").text = "111111.11"


def _mut_bre09(r):
    _to_exempt(r)
    _child(_subtotal(r), NS_CBC, "TaxAmount").text = "10.00"


def _mut_bre10(r):
    # E breakdown WITHOUT any exemption reason/code -> BR-E-10.
    _convert_category(r, "E", exemption_reason=None)


# ---- Payee / tax representative / payment instructions / references -------- #
def _mut_br17(r):
    # PayeeParty without a PartyName/Name -> BR-17.
    pp = ET.Element(_q(NS_CAC, "PayeeParty"))
    pid = _sub_el(pp, NS_CAC, "PartyIdentification")
    _sub_el(pid, NS_CBC, "ID", "PAYEE-1")
    r.insert(list(r).index(_child(r, NS_CAC, "PaymentMeans")), pp)


def _add_tax_representative(r, name=None, postal_country=None,
                            postal_address=False):
    trp = ET.Element(_q(NS_CAC, "TaxRepresentativeParty"))
    if name is not None:
        _sub_el(_sub_el(trp, NS_CAC, "PartyName"), NS_CBC, "Name", name)
    if postal_address:
        pa = _sub_el(trp, NS_CAC, "PostalAddress")
        if postal_country is not None:
            _sub_el(_sub_el(pa, NS_CAC, "Country"), NS_CBC,
                    "IdentificationCode", postal_country)
    pts = _sub_el(trp, NS_CAC, "PartyTaxScheme")
    _sub_el(pts, NS_CBC, "CompanyID", "DK99999999")
    _sub_el(_sub_el(pts, NS_CAC, "TaxScheme"), NS_CBC, "ID", "VAT")
    r.insert(list(r).index(_child(r, NS_CAC, "Delivery")), trp)


def _mut_br18(r):
    # Tax representative without a name (address+country fine) -> BR-18 only.
    _add_tax_representative(r, name=None, postal_address=True,
                            postal_country="DK")


def _mut_br19(r):
    # Tax representative with a name but NO postal address -> BR-19.
    _add_tax_representative(r, name="Rep GmbH", postal_address=False)


def _mut_br20(r):
    # Tax representative postal address without a country code -> BR-20.
    _add_tax_representative(r, name="Rep GmbH", postal_address=True,
                            postal_country=None)


def _pm(r):
    return _child(r, NS_CAC, "PaymentMeans")


def _mut_br49(r):
    # PaymentMeans without a PaymentMeansCode -> BR-49 (code '' != 30/58, so
    # BR-61 holds; BR-50's context predicate no longer matches).
    _pm(r).remove(_child(_pm(r), NS_CBC, "PaymentMeansCode"))


def _mut_br50(r):
    # Credit-transfer (58) PayeeFinancialAccount whose ID is removed -> BR-50
    # (and BR-61: no account id on a 30/58 PaymentMeans).
    acct = _child(_pm(r), NS_CAC, "PayeeFinancialAccount")
    acct.remove(_child(acct, NS_CBC, "ID"))


def _mut_br51(r):
    # Full card PAN (16 digits > 10 after normalize-space) -> BR-51 (warning).
    card = _sub_el(_pm(r), NS_CAC, "CardAccount")
    _sub_el(card, NS_CBC, "PrimaryAccountNumberID", "4111111111111111")
    _sub_el(card, NS_CBC, "NetworkID", "VISA")


def _mut_br55(r):
    # BillingReference whose InvoiceDocumentReference has no ID -> BR-55.
    br = ET.Element(_q(NS_CAC, "BillingReference"))
    _sub_el(br, NS_CAC, "InvoiceDocumentReference")
    r.insert(list(r).index(_child(r, NS_CAC, "AccountingSupplierParty")), br)


def _mut_br57(r):
    # Deliver-to address without a Country -> BR-57.
    addr = _child(_child(_child(r, NS_CAC, "Delivery"), NS_CAC,
                         "DeliveryLocation"), NS_CAC, "Address")
    addr.remove(_child(addr, NS_CAC, "Country"))


def _mut_br61(r):
    # Credit-transfer code (58) with the whole PayeeFinancialAccount removed
    # -> BR-61 only (BR-50's context node vanishes with the account).
    _pm(r).remove(_child(_pm(r), NS_CAC, "PayeeFinancialAccount"))


def _mut_br62(r):
    ep = _child(_supplier_party(r), NS_CBC, "EndpointID")
    del ep.attrib["schemeID"]


def _mut_br63(r):
    ep = _child(_customer_party(r), NS_CBC, "EndpointID")
    del ep.attrib["schemeID"]


# ---- codelist (BR-CL-*) mutations: break exactly the guarded code ---------- #
def _mut_brcl03(r):
    # Give one monetary amount (the PayableAmount, outside the VAT-currency
    # matching BR-CO-15 keys on) a currencyID that is not an ISO 4217 code.
    _child(_lmt(r), NS_CBC, "PayableAmount").set("currencyID", "XXY")


def _mut_brcl04(r):
    # Document currency (BT-5) coded off-list. (Also flips BR-CO-15 on both
    # engines — no document-currency VAT total remains — which agrees per rule.)
    _child(r, NS_CBC, "DocumentCurrencyCode").text = "XXY"


def _mut_brcl05(r):
    # Add a Tax currency code (BT-6) with an off-list value. Inserted after
    # DocumentCurrencyCode; parser finds it by name so position is irrelevant.
    _sub_el(r, NS_CBC, "TaxCurrencyCode", text="XXY")


def _mut_brcl13(r):
    # Add a CommodityClassification with an off-list @listID (not in UNTDID 7143).
    item = _child(_first_line(r), NS_CAC, "Item")
    cc = _sub_el(item, NS_CAC, "CommodityClassification")
    icc = _sub_el(cc, NS_CBC, "ItemClassificationCode", text="1234")
    icc.set("listID", "QQ")


def _mut_brcl14(r):
    # Seller postal-address country (BT-40) coded off ISO 3166-1 (still present,
    # so BR-09 holds; OriginCountry stays valid, so BR-CL-15 does not fire).
    pa = _child(_supplier_party(r), NS_CAC, "PostalAddress")
    _child(pa, NS_CAC, "Country").find(_q(NS_CBC, "IdentificationCode")).text = "XX"


def _mut_brcl17(r):
    # VAT breakdown category (cac:TaxTotal/.../cac:TaxCategory/cbc:ID) coded off
    # the UNCL 5305 subset. The line item category is left 'S', so this also
    # trips BR-S-01 (S line, no S breakdown) — a rule already at parity, so both
    # engines agree; the S-specific breakdown rules no longer have an S subtotal
    # context and stay clear. Only BR-CL-17 among the codelist rules fires.
    st = r.find("cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID", _NSD)
    st.text = "XX"


def _mut_brcl18(r):
    # Line item VAT category (cac:Item/cac:ClassifiedTaxCategory/cbc:ID) coded
    # off the UNCL 5305 subset. Breakdown category stays 'S' (again tripping the
    # already-at-parity BR-S-01). Only BR-CL-18 among the codelist rules fires.
    cat = _first_line(r).find("cac:Item/cac:ClassifiedTaxCategory/cbc:ID", _NSD)
    cat.text = "XX"


def _mut_brcl22(r):
    # Add a VAT exemption reason code (BT-121) with a value that is NOT in the
    # CEF VATEX list, inside the LINE ClassifiedTaxCategory. Placed on the line
    # (not the breakdown) so no BR-S-10 ("S breakdown shall not have an exemption
    # reason") fires — its context is the breakdown category only — leaving
    # BR-CL-22 the sole rule that fires.
    ctc = _first_line(r).find("cac:Item/cac:ClassifiedTaxCategory", _NSD)
    _sub_el(ctc, NS_CBC, "TaxExemptionReasonCode", text="NOT-A-VATEX-CODE")


def _mut_brcl23(r):
    # Line invoiced quantity (cbc:InvoicedQuantity) @unitCode coded off the
    # UN/ECE Rec 20 + Rec 21 unit-code list. Only a label — amounts are
    # untouched — so no arithmetic rule flips; BR-CL-23 is the sole rule that
    # fires among the codelist rules.
    _child(_first_line(r), NS_CBC, "InvoicedQuantity").set("unitCode", "XXY")


def _mut_brcl16(r):
    # The clean base carries cac:PaymentMeans/cbc:PaymentMeansCode = '58' (a
    # listed code). Code it off the UNCL 4461 list. Only a code-list label — no
    # amount changes — so BR-CL-16 is the sole codelist rule that fires.
    r.find("cac:PaymentMeans/cbc:PaymentMeansCode", _NSD).text = "XXY"


def _add_reason_allowance_charge(r, charge, reason_code):
    """Insert a document-level AllowanceCharge with a coded reason (and a
    zero, arithmetically-neutral amount + VAT category) before cac:TaxTotal.

    Amount '0.00' keeps every document total unchanged, so no arithmetic
    (BR-CO-*) rule flips; the VAT category 'S' and the coded reason satisfy
    BR-32/BR-33, leaving the target reason-code rule the only one that fires."""
    ac = ET.Element(_q(NS_CAC, "AllowanceCharge"))
    _sub_el(ac, NS_CBC, "ChargeIndicator", "true" if charge else "false")
    _sub_el(ac, NS_CBC, "AllowanceChargeReasonCode", reason_code)
    _sub_el(ac, NS_CBC, "Amount", "0.00", currency=True)
    cat = _sub_el(ac, NS_CAC, "TaxCategory")
    _sub_el(cat, NS_CBC, "ID", "S")
    _sub_el(cat, NS_CBC, "Percent", "25")
    _sub_el(_sub_el(cat, NS_CAC, "TaxScheme"), NS_CBC, "ID", "VAT")
    r.insert(list(r).index(_child(r, NS_CAC, "TaxTotal")), ac)


def _mut_brcl19(r):
    # Document ALLOWANCE (ChargeIndicator=false) with a reason code off the
    # UNCL 5189 allowance-reason list. Amount 0.00 -> no arithmetic rule flips.
    _add_reason_allowance_charge(r, charge=False, reason_code="XXX")


def _mut_brcl20(r):
    # Document CHARGE (ChargeIndicator=true) with a reason code off the UNCL 7161
    # charge-reason list. Amount 0.00 -> no arithmetic rule flips.
    _add_reason_allowance_charge(r, charge=True, reason_code="XXX")


def _mut_brcl21(r):
    # Add a cac:Item/cac:StandardItemIdentification/cbc:ID with a @schemeID off
    # the ISO 6523 ICD list to the first line. A code-list label only, so
    # BR-CL-21 is the sole rule that fires.
    item = _child(_first_line(r), NS_CAC, "Item")
    sii = _sub_el(item, NS_CAC, "StandardItemIdentification")
    _sub_el(sii, NS_CBC, "ID", "1234567890123").set("schemeID", "XXX")


def _mut_brcl24(r):
    # Add a document attachment (cbc:EmbeddedDocumentBinaryObject) with a
    # @mimeCode outside the six-entry MIMEMediaType subset. A cbc:ID on the
    # AdditionalDocumentReference keeps unrelated presence rules clear; the
    # binary object is a label only, so BR-CL-24 is the sole target that fires.
    adr = ET.Element(_q(NS_CAC, "AdditionalDocumentReference"))
    _sub_el(adr, NS_CBC, "ID", "ATTACH-1")
    att = _sub_el(adr, NS_CAC, "Attachment")
    edbo = _sub_el(att, NS_CBC, "EmbeddedDocumentBinaryObject", "AAAA")
    edbo.set("mimeCode", "application/octet-stream")
    edbo.set("filename", "attachment.bin")
    r.insert(list(r).index(_child(r, NS_CAC, "AccountingSupplierParty")), adr)


# ---- Supporting-document / item-metadata / VAT-point batch mutations ------- #
# (BR-23, BR-52, BR-53, BR-54, BR-56, BR-64, BR-65, BR-CO-03/-09/-19)
def _mut_br23(r):
    # Strip @unitCode from the first line's InvoicedQuantity (BT-130). BR-23 is
    # attribute existence; the quantity value itself stays, so BR-22 holds and
    # BR-CL-23 (unit-code list) loses its context node rather than firing.
    del _child(_first_line(r), NS_CBC, "InvoicedQuantity").attrib["unitCode"]


def _mut_br52(r):
    # Add an Additional supporting document (BG-24) with NO cbc:ID at all:
    # normalize-space(cbc:ID) = '' fires BR-52 and nothing else graded.
    adr = ET.Element(_q(NS_CAC, "AdditionalDocumentReference"))
    _sub_el(adr, NS_CBC, "DocumentDescription", "timesheet")
    r.insert(list(r).index(_child(r, NS_CAC, "AccountingSupplierParty")), adr)


def _mut_br53(r):
    # Declare a VAT accounting currency (BT-6 = EUR, base doc currency is DKK)
    # without adding any EUR cac:TaxTotal/cbc:TaxAmount: the official
    # ``every $taxcurrency ... satisfies exists(...)`` quantifier fails. EUR is
    # a listed ISO 4217 code, so BR-CL-05 stays quiet.
    tcc = ET.Element(_q(NS_CBC, "TaxCurrencyCode"))
    tcc.text = "EUR"
    r.insert(list(r).index(_child(r, NS_CBC, "DocumentCurrencyCode")) + 1, tcc)


def _mut_br54(r):
    # Add an Item attribute (BG-32) carrying a Name but NO Value: the official
    # ``exists(cbc:Name) and exists(cbc:Value)`` conjunction fails.
    item = _child(_first_line(r), NS_CAC, "Item")
    aip = _sub_el(item, NS_CAC, "AdditionalItemProperty")
    _sub_el(aip, NS_CBC, "Name", "Colour")


def _mut_br56(r):
    # Add a Seller tax representative party (BG-11) WITHOUT any VAT-scheme
    # cac:PartyTaxScheme/cbc:CompanyID. Name + postal address + country are
    # supplied so the sibling representative rules (BR-18/BR-19/BR-20) hold and
    # BR-56 is the only graded rule that fires.
    trp = ET.Element(_q(NS_CAC, "TaxRepresentativeParty"))
    pn = _sub_el(trp, NS_CAC, "PartyName")
    _sub_el(pn, NS_CBC, "Name", "Rep A")
    pa = _sub_el(trp, NS_CAC, "PostalAddress")
    country = _sub_el(pa, NS_CAC, "Country")
    _sub_el(country, NS_CBC, "IdentificationCode", "DK")
    r.insert(list(r).index(_child(r, NS_CAC, "TaxTotal")), trp)


def _mut_br64(r):
    # Add an Item standard identifier (BT-157) with NO @schemeID: BR-64 is
    # attribute existence, and with the attribute absent BR-CL-21 (ICD list)
    # has no value to check.
    item = _child(_first_line(r), NS_CAC, "Item")
    sii = _sub_el(item, NS_CAC, "StandardItemIdentification")
    _sub_el(sii, NS_CBC, "ID", "1234567890123")


def _mut_br65(r):
    # Add an Item classification identifier (BT-158) with NO @listID: BR-65 is
    # attribute existence, and with the attribute absent BR-CL-13 (UNTDID 7143
    # list) has no value to check.
    item = _child(_first_line(r), NS_CAC, "Item")
    cc = _sub_el(item, NS_CAC, "CommodityClassification")
    _sub_el(cc, NS_CBC, "ItemClassificationCode", "9873242")


def _mut_brco03(r):
    # Provide BOTH the Value added tax point date (BT-7, cbc:TaxPointDate) and
    # the VAT point date code (BT-8, document cac:InvoicePeriod/
    # cbc:DescriptionCode '35' = delivery date): mutually exclusive per
    # BR-CO-03. The base's document InvoicePeriod keeps its start/end dates, so
    # BR-CO-19/BR-29 hold.
    tpd = ET.Element(_q(NS_CBC, "TaxPointDate"))
    tpd.text = "2018-09-30"
    r.insert(list(r).index(_child(r, NS_CBC, "DocumentCurrencyCode")), tpd)
    _sub_el(_child(r, NS_CAC, "InvoicePeriod"), NS_CBC, "DescriptionCode", "35")


def _mut_brco09(r):
    # Give the Seller VAT identifier (BT-31) the prefix 'XX' — not a token of
    # the official UBL prefix string and not any two adjacent characters of it
    # either, so the raw contains() genuinely fails.
    pts = _child(_supplier_party(r), NS_CAC, "PartyTaxScheme")
    _child(pts, NS_CBC, "CompanyID").text = "XX12345678"


def _mut_brco19(r):
    # Empty the document-level Invoicing period (BG-14): with neither StartDate
    # nor EndDate nor DescriptionCode, BR-CO-19 fires. (The line-level
    # cac:InvoicePeriod is BG-26/BR-30's context and is left untouched.)
    period = _child(r, NS_CAC, "InvoicePeriod")
    period.remove(_child(period, NS_CBC, "StartDate"))
    period.remove(_child(period, NS_CBC, "EndDate"))


# ---- Core/decimals/VAT gap batch A mutations -------------------------------- #
# (BR-CO-20/21/22/23/24/26, BR-DEC-24/25/27/28, BR-IC-10, BR-S-08)
def _mut_brco20(r):
    # Empty the first line's Invoice line period (BG-26): with neither
    # StartDate nor EndDate, BR-CO-20 fires (BR-30 has no dates left to
    # compare, and the document-level BG-14 period is untouched).
    period = _child(_first_line(r), NS_CAC, "InvoicePeriod")
    period.remove(_child(period, NS_CBC, "StartDate"))
    period.remove(_child(period, NS_CBC, "EndDate"))


def _add_bare_doc_allowance_charge(r, charge):
    """Insert a document AllowanceCharge with amount 0.00 + S/25 VAT category
    but NO reason: the target BR-CO-21/22 fires (with its BR-33/BR-38 twin),
    the zero amount keeps every document-total and BR-S-08 bucket sum
    unchanged, and the matching S/25 rate keeps BR-S-06/07 clear."""
    ac = ET.Element(_q(NS_CAC, "AllowanceCharge"))
    _sub_el(ac, NS_CBC, "ChargeIndicator", "true" if charge else "false")
    _sub_el(ac, NS_CBC, "Amount", "0.00", currency=True)
    cat = _sub_el(ac, NS_CAC, "TaxCategory")
    _sub_el(cat, NS_CBC, "ID", "S")
    _sub_el(cat, NS_CBC, "Percent", "25")
    _sub_el(_sub_el(cat, NS_CAC, "TaxScheme"), NS_CBC, "ID", "VAT")
    r.insert(list(r).index(_child(r, NS_CAC, "TaxTotal")), ac)


def _mut_brco21(r):
    _add_bare_doc_allowance_charge(r, charge=False)


def _mut_brco22(r):
    _add_bare_doc_allowance_charge(r, charge=True)


def _add_line_allowance_charge(r, charge, amount="0.00", base=None,
                               reason=None):
    """Insert an Invoice line AllowanceCharge (BG-27/BG-28) on the first line.
    Line allowances/charges feed no document-total arithmetic and carry no VAT
    category here, so only the reason (BR-CO-23/24 + BR-42/44) and decimal
    (BR-DEC-24/25/27/28) rules can react."""
    ln = _first_line(r)
    ac = ET.Element(_q(NS_CAC, "AllowanceCharge"))
    _sub_el(ac, NS_CBC, "ChargeIndicator", "true" if charge else "false")
    if reason is not None:
        _sub_el(ac, NS_CBC, "AllowanceChargeReason", reason)
    _sub_el(ac, NS_CBC, "Amount", amount, currency=True)
    if base is not None:
        _sub_el(ac, NS_CBC, "BaseAmount", base, currency=True)
    ln.insert(list(ln).index(_child(ln, NS_CAC, "Item")), ac)


def _mut_brco23(r):
    # Line ALLOWANCE without reason/reason code: BR-CO-23 fires (and its
    # BR-42 twin — same official fact, two ids — on both engines).
    _add_line_allowance_charge(r, charge=False)


def _mut_brco24(r):
    # Line CHARGE without reason/reason code: BR-CO-24 (+ BR-44 twin).
    _add_line_allowance_charge(r, charge=True)


def _mut_brdec24(r):
    _add_line_allowance_charge(r, charge=False, amount="1.123",
                               reason="Discount")


def _mut_brdec25(r):
    _add_line_allowance_charge(r, charge=False, amount="1.12", base="10.123",
                               reason="Discount")


def _mut_brdec27(r):
    _add_line_allowance_charge(r, charge=True, amount="1.123",
                               reason="Freight")


def _mut_brdec28(r):
    _add_line_allowance_charge(r, charge=True, amount="1.12", base="10.123",
                               reason="Freight")


def _mut_brco26(r):
    # Strip every Seller identifier BR-CO-26 accepts: the PartyIdentification
    # (BT-29), the whole PartyTaxScheme (BT-31 — also BR-CO-09's only context,
    # which therefore vanishes rather than firing) and the PartyLegalEntity
    # CompanyID (BT-30; its RegistrationName stays, so BR-06 holds). The
    # S-rated lines then also lack a seller VAT id -> BR-S-02 fires alongside
    # on both engines.
    party = _supplier_party(r)
    party.remove(_child(party, NS_CAC, "PartyIdentification"))
    party.remove(_child(party, NS_CAC, "PartyTaxScheme"))
    ple = _child(party, NS_CAC, "PartyLegalEntity")
    ple.remove(_child(ple, NS_CBC, "CompanyID"))


def _mut_bric10(r):
    # Add an Intra-community (K) VAT breakdown row with NO exemption reason:
    # BR-IC-10 fires. Amounts are 0.00 so BR-CO-14 and the K sum/zero rules
    # (BR-IC-08/09) hold; BR-IC-01 fires alongside on both engines (K
    # breakdown with no K line); the base's ActualDeliveryDate keeps BR-IC-11
    # clear.
    tt = _child(r, NS_CAC, "TaxTotal")
    st = _sub_el(tt, NS_CAC, "TaxSubtotal")
    _sub_el(st, NS_CBC, "TaxableAmount", "0.00", currency=True)
    _sub_el(st, NS_CBC, "TaxAmount", "0.00", currency=True)
    cat = _sub_el(st, NS_CAC, "TaxCategory")
    _sub_el(cat, NS_CBC, "ID", "K")
    _sub_el(cat, NS_CBC, "Percent", "0")
    _sub_el(_sub_el(cat, NS_CAC, "TaxScheme"), NS_CBC, "ID", "VAT")


def _mut_brs08(r):
    # Shift the S breakdown's taxable amount (BT-116) by +2: outside BR-S-08's
    # strict ±1 band against the S/25 bucket sum (625743.54), but the tax
    # amount is then only 0.50 off taxable x 25%, INSIDE the ±1 band of
    # BR-CO-17 and BR-S-09 — so BR-S-08 is the only rule that fires.
    st = _child(_child(r, NS_CAC, "TaxTotal"), NS_CAC, "TaxSubtotal")
    _child(st, NS_CBC, "TaxableAmount").text = "625745.54"


# ---- IGIC (BR-AF-*) mutations, off an L-converted clean base --------------- #
def _to_igic(r):
    """Rewrite the clean S-25% base into a clean IGIC invoice: the line and
    breakdown category codes flip S -> L, everything else (25% rate, amounts,
    seller VAT id) stays — 25 satisfies BOTH bindings' BR-AF-05 predicates
    (UBL >= 0, CII > 0) and the arithmetic already reconciles, so the
    converted invoice fires no rule on either engine."""
    item = _child(_first_line(r), NS_CAC, "Item")
    ctc = _child(item, NS_CAC, "ClassifiedTaxCategory")
    _child(ctc, NS_CBC, "ID").text = "L"
    cat = _child(_subtotal(r), NS_CAC, "TaxCategory")
    _child(cat, NS_CBC, "ID").text = "L"


def _mut_braf01(r):
    # L invoice line with an S-only breakdown -> BR-AF-01 (item side without a
    # matching L breakdown row); the orphan S breakdown row equally fires
    # BR-S-01 on both engines.
    item = _child(_first_line(r), NS_CAC, "Item")
    ctc = _child(item, NS_CAC, "ClassifiedTaxCategory")
    _child(ctc, NS_CBC, "ID").text = "L"


def _mut_braf02(r):
    # L line present + no Seller VAT identifier -> BR-AF-02.
    _to_igic(r)
    _supplier_remove_party_tax_scheme(r)


def _mut_braf03(r):
    # L document-level allowance + no Seller VAT id -> BR-AF-03 (also
    # BR-AF-02, the L line). Amount 0.00 keeps the L/25 bucket sum (BR-AF-08)
    # and the document totals unchanged.
    _to_igic(r)
    _add_doc_allowance_charge(r, charge=False, amount="0.00", percent="25",
                              category="L")
    _supplier_remove_party_tax_scheme(r)


def _mut_braf04(r):
    # L document-level charge + no Seller VAT id -> BR-AF-04 (also BR-AF-02).
    _to_igic(r)
    _add_doc_allowance_charge(r, charge=True, amount="0.00", percent="25",
                              category="L")
    _supplier_remove_party_tax_scheme(r)


def _mut_braf05(r):
    # L invoice line with a NEGATIVE VAT rate -> BR-AF-05 ((Percent) >= 0
    # fails). The line leaves the L/25 bucket, so BR-AF-08 fires alongside on
    # both engines.
    _to_igic(r)
    item = _child(_first_line(r), NS_CAC, "Item")
    ctc = _child(item, NS_CAC, "ClassifiedTaxCategory")
    _child(ctc, NS_CBC, "Percent").text = "-5"


def _mut_braf06(r):
    # L document-level allowance with a negative VAT rate -> BR-AF-06. The
    # -5 category matches no L/25 breakdown context and the amount is 0.00,
    # so no other graded rule flips.
    _to_igic(r)
    _add_doc_allowance_charge(r, charge=False, amount="0.00", percent="-5",
                              category="L")


def _mut_braf07(r):
    # L document-level charge with a negative VAT rate -> BR-AF-07.
    _to_igic(r)
    _add_doc_allowance_charge(r, charge=True, amount="0.00", percent="-5",
                              category="L")


def _mut_braf08(r):
    # Shift the L breakdown's taxable amount (BT-116) by +2: outside
    # BR-AF-08's strict ±1 band against the L/25 bucket sum (625743.54), but
    # the tax amount is then only 0.50 off taxable x 25% — INSIDE the ±1
    # bands of BR-CO-17 and BR-AF-09 — so BR-AF-08 is the only rule that
    # fires (the BR-S-08 twin of this mutation).
    _to_igic(r)
    st = _child(_child(r, NS_CAC, "TaxTotal"), NS_CAC, "TaxSubtotal")
    _child(st, NS_CBC, "TaxableAmount").text = "625745.54"


def _mut_braf09(r):
    # L breakdown TaxAmount far from taxable x rate -> BR-AF-09 (BR-CO-17 and
    # the ungraded-on-UBL BR-CO-14 fire alongside on both engines).
    _to_igic(r)
    _child(_subtotal(r), NS_CBC, "TaxAmount").text = "99.99"


def _mut_braf10(r):
    # L breakdown carrying a VAT exemption reason -> BR-AF-10.
    _to_igic(r)
    cat = _child(_subtotal(r), NS_CAC, "TaxCategory")
    _sub_el(cat, NS_CBC, "TaxExemptionReason", "n/a")


# ---- IPSI (BR-AG-*) mutations, off an M-converted clean base --------------- #
def _to_ipsi(r):
    """Rewrite the clean S-25% base into a clean IPSI invoice: the line and
    breakdown category codes flip S -> M, everything else (25% rate, amounts,
    seller VAT id) stays — 25 satisfies the ``>= 0`` rate predicate of BOTH
    bindings and the arithmetic already reconciles, so the converted invoice
    fires no rule on either engine."""
    item = _child(_first_line(r), NS_CAC, "Item")
    ctc = _child(item, NS_CAC, "ClassifiedTaxCategory")
    _child(ctc, NS_CBC, "ID").text = "M"
    cat = _child(_subtotal(r), NS_CAC, "TaxCategory")
    _child(cat, NS_CBC, "ID").text = "M"


def _mut_brag01(r):
    # M invoice line with an S-only breakdown -> BR-AG-01 (item side without
    # a matching raw-M VAT breakdown row); the orphan S breakdown row equally
    # fires BR-S-01 on both engines.
    item = _child(_first_line(r), NS_CAC, "Item")
    ctc = _child(item, NS_CAC, "ClassifiedTaxCategory")
    _child(ctc, NS_CBC, "ID").text = "M"


def _mut_brag02(r):
    # M line present + no Seller VAT identifier -> BR-AG-02.
    _to_ipsi(r)
    _supplier_remove_party_tax_scheme(r)


def _mut_brag03(r):
    # M document-level allowance + no Seller VAT id -> BR-AG-03 (also
    # BR-AG-02, the M line). Amount 0.00 keeps the M/25 bucket sum (BR-AG-08)
    # and the document totals unchanged.
    _to_ipsi(r)
    _add_doc_allowance_charge(r, charge=False, amount="0.00", percent="25",
                              category="M")
    _supplier_remove_party_tax_scheme(r)


def _mut_brag04(r):
    # M document-level charge + no Seller VAT id -> BR-AG-04 (also BR-AG-02).
    _to_ipsi(r)
    _add_doc_allowance_charge(r, charge=True, amount="0.00", percent="25",
                              category="M")
    _supplier_remove_party_tax_scheme(r)


def _mut_brag05(r):
    # M invoice line with a NEGATIVE VAT rate -> BR-AG-05 ((Percent) >= 0
    # fails; zero would HOLD on both bindings, unlike BR-AF). The line leaves
    # the M/25 bucket, so BR-AG-08 fires alongside on both engines.
    _to_ipsi(r)
    item = _child(_first_line(r), NS_CAC, "Item")
    ctc = _child(item, NS_CAC, "ClassifiedTaxCategory")
    _child(ctc, NS_CBC, "Percent").text = "-5"


def _mut_brag06(r):
    # M document-level allowance with a negative VAT rate -> BR-AG-06. The
    # -5 category matches no M/25 breakdown context and the amount is 0.00,
    # so no other graded rule flips.
    _to_ipsi(r)
    _add_doc_allowance_charge(r, charge=False, amount="0.00", percent="-5",
                              category="M")


def _mut_brag07(r):
    # M document-level charge with a negative VAT rate -> BR-AG-07.
    _to_ipsi(r)
    _add_doc_allowance_charge(r, charge=True, amount="0.00", percent="-5",
                              category="M")


def _mut_brag08(r):
    # Shift the M breakdown's taxable amount (BT-116) by +2: outside
    # BR-AG-08's strict ±1 band against the M/25 bucket sum (625743.54), but
    # the tax amount is then only 0.50 off taxable x 25% — INSIDE the ±1
    # bands of BR-CO-17 and BR-AG-09 — so BR-AG-08 is the only rule that
    # fires (the BR-S/AF-08 twin of this mutation).
    _to_ipsi(r)
    st = _child(_child(r, NS_CAC, "TaxTotal"), NS_CAC, "TaxSubtotal")
    _child(st, NS_CBC, "TaxableAmount").text = "625745.54"


def _mut_brag09(r):
    # M breakdown TaxAmount far from taxable x rate -> BR-AG-09 (BR-CO-17 and
    # the ungraded-on-UBL BR-CO-14 fire alongside on both engines).
    _to_ipsi(r)
    _child(_subtotal(r), NS_CBC, "TaxAmount").text = "99.99"


def _mut_brag10(r):
    # M breakdown carrying a VAT exemption reason -> BR-AG-10.
    _to_ipsi(r)
    cat = _child(_subtotal(r), NS_CAC, "TaxCategory")
    _sub_el(cat, NS_CBC, "TaxExemptionReason", "n/a")


# ---- Italian split payment (BR-B-*) mutations ------------------------------- #
def _mut_brb01(r):
    # Flip the line AND breakdown category codes S -> B: a split-payment
    # invoice whose four cbc:IdentificationCode countries are all 'DK' (the
    # clean base is Danish), so the official "domestic Italian" test
    # not(//cbc:IdentificationCode != 'IT') fails -> BR-B-01 fires on both
    # engines. No 'S' remains anywhere, so BR-B-02 and the BR-S family stay
    # quiet; category 'B' is UNCL 5305-valid (BR-CL-17/18 hold) and no B
    # breakdown/rate family exists to fire alongside.
    item = _child(_first_line(r), NS_CAC, "Item")
    ctc = _child(item, NS_CAC, "ClassifiedTaxCategory")
    _child(ctc, NS_CBC, "ID").text = "B"
    cat = _child(_subtotal(r), NS_CAC, "TaxCategory")
    _child(cat, NS_CBC, "ID").text = "B"


def _mut_brb02(r):
    # Flip ONLY the line's classified category S -> B, breakdown stays S:
    # 'B' (line item) and 'S' (breakdown row) now coexist -> BR-B-02 fires.
    # BR-B-01 fires alongside (B + the base's DK countries), as do BR-S-01
    # (orphan S breakdown) and BR-S-08 (the S/25 bucket lost its only line)
    # — on both engines alike.
    item = _child(_first_line(r), NS_CAC, "Item")
    ctc = _child(item, NS_CAC, "ClassifiedTaxCategory")
    _child(ctc, NS_CBC, "ID").text = "B"


_MUTATIONS = {
    "BR-01": _mut_br01, "BR-02": _mut_br02, "BR-03": _mut_br03,
    "BR-04": _mut_br04, "BR-05": _mut_br05, "BR-06": _mut_br06,
    "BR-07": _mut_br07, "BR-08": _mut_br08,
    "BR-09": _mut_br09, "BR-10": _mut_br10, "BR-11": _mut_br11,
    "BR-12": _mut_br12, "BR-13": _mut_br13, "BR-14": _mut_br14,
    "BR-15": _mut_br15,
    "BR-16": _mut_br16,
    "BR-17": _mut_br17, "BR-18": _mut_br18, "BR-19": _mut_br19,
    "BR-20": _mut_br20,
    "BR-49": _mut_br49, "BR-50": _mut_br50, "BR-51": _mut_br51,
    "BR-55": _mut_br55, "BR-57": _mut_br57, "BR-61": _mut_br61,
    "BR-62": _mut_br62, "BR-63": _mut_br63,
    "BR-21": _mut_br21, "BR-22": _mut_br22, "BR-23": _mut_br23,
    "BR-24": _mut_br24,
    "BR-25": _mut_br25, "BR-26": _mut_br26, "BR-27": _mut_br27,
    "BR-28": _mut_br28, "BR-29": _mut_br29, "BR-30": _mut_br30,
    "BR-52": _mut_br52, "BR-53": _mut_br53, "BR-54": _mut_br54,
    "BR-56": _mut_br56, "BR-64": _mut_br64, "BR-65": _mut_br65,
    "BR-CO-03": _mut_brco03, "BR-CO-09": _mut_brco09,
    "BR-CO-19": _mut_brco19,
    "BR-CO-20": _mut_brco20, "BR-CO-21": _mut_brco21,
    "BR-CO-22": _mut_brco22, "BR-CO-23": _mut_brco23,
    "BR-CO-24": _mut_brco24, "BR-CO-26": _mut_brco26,
    "BR-IC-10": _mut_bric10, "BR-S-08": _mut_brs08,
    "BR-AF-01": _mut_braf01, "BR-AF-02": _mut_braf02, "BR-AF-03": _mut_braf03,
    "BR-AF-04": _mut_braf04, "BR-AF-05": _mut_braf05, "BR-AF-06": _mut_braf06,
    "BR-AF-07": _mut_braf07, "BR-AF-08": _mut_braf08, "BR-AF-09": _mut_braf09,
    "BR-AF-10": _mut_braf10,
    "BR-AG-01": _mut_brag01, "BR-AG-02": _mut_brag02, "BR-AG-03": _mut_brag03,
    "BR-AG-04": _mut_brag04, "BR-AG-05": _mut_brag05, "BR-AG-06": _mut_brag06,
    "BR-AG-07": _mut_brag07, "BR-AG-08": _mut_brag08, "BR-AG-09": _mut_brag09,
    "BR-AG-10": _mut_brag10,
    "BR-B-01": _mut_brb01, "BR-B-02": _mut_brb02,
    "BR-DEC-24": _mut_brdec24, "BR-DEC-25": _mut_brdec25,
    "BR-DEC-27": _mut_brdec27, "BR-DEC-28": _mut_brdec28,
    "BR-CO-04": _mut_brco04,
    "BR-CL-01": _mut_brcl01,
    "BR-CL-03": _mut_brcl03, "BR-CL-04": _mut_brcl04, "BR-CL-05": _mut_brcl05,
    "BR-CL-13": _mut_brcl13, "BR-CL-14": _mut_brcl14,
    "BR-CL-16": _mut_brcl16,
    "BR-CL-17": _mut_brcl17, "BR-CL-18": _mut_brcl18,
    "BR-CL-19": _mut_brcl19, "BR-CL-20": _mut_brcl20, "BR-CL-21": _mut_brcl21,
    "BR-CL-22": _mut_brcl22,
    "BR-CL-23": _mut_brcl23, "BR-CL-24": _mut_brcl24,
    "BR-CO-10": _mut_brco10,
    "BR-CO-11": _mut_brco11, "BR-CO-12": _mut_brco12,
    "BR-CO-13": _mut_brco13, "BR-CO-14": _mut_brco14, "BR-CO-15": _mut_brco15,
    "BR-CO-16": _mut_brco16, "BR-CO-17": _mut_brco17, "BR-CO-18": _mut_brco18,
    "BR-45": _mut_br45, "BR-46": _mut_br46, "BR-47": _mut_br47,
    "BR-48": _mut_br48,
    "BR-S-01": _mut_brs01, "BR-Z-01": _mut_brz01,
    "BR-S-02": _mut_brs02, "BR-S-03": _mut_brs03, "BR-S-04": _mut_brs04,
    "BR-S-05": _mut_brs05, "BR-S-06": _mut_brs06, "BR-S-07": _mut_brs07,
    "BR-S-09": _mut_brs09, "BR-S-10": _mut_brs10,
    "BR-Z-02": _mut_brz02, "BR-Z-03": _mut_brz03, "BR-Z-04": _mut_brz04,
    "BR-Z-05": _mut_brz05, "BR-Z-06": _mut_brz06, "BR-Z-07": _mut_brz07,
    "BR-Z-08": _mut_brz08, "BR-Z-09": _mut_brz09, "BR-Z-10": _mut_brz10,
    "BR-E-02": _mut_bre02, "BR-E-03": _mut_bre03, "BR-E-04": _mut_bre04,
    "BR-E-05": _mut_bre05, "BR-E-06": _mut_bre06, "BR-E-07": _mut_bre07,
    "BR-E-08": _mut_bre08, "BR-E-09": _mut_bre09, "BR-E-10": _mut_bre10,
    "BR-AE-01": _mut_brae01, "BR-E-01": _mut_bre01, "BR-G-01": _mut_brg01,
    "BR-IC-01": _mut_bric01, "BR-O-01": _mut_bro01,
    "BR-DEC-01": _mut_brdec01, "BR-DEC-02": _mut_brdec02,
    "BR-DEC-05": _mut_brdec05, "BR-DEC-06": _mut_brdec06,
    "BR-DEC-09": _mut_brdec09, "BR-DEC-10": _mut_brdec10,
    "BR-DEC-11": _mut_brdec11, "BR-DEC-12": _mut_brdec12,
    "BR-DEC-14": _mut_brdec14, "BR-DEC-16": _mut_brdec16,
    "BR-DEC-17": _mut_brdec17, "BR-DEC-18": _mut_brdec18,
    "BR-DEC-19": _mut_brdec19, "BR-DEC-20": _mut_brdec20,
    "BR-DEC-23": _mut_brdec23,
}


def _gather_mutations(scratch: str):
    """One generated invoice per rule, each breaking exactly that rule's field."""
    base_path = os.path.join(HERE, "corpus", "vendored", "valid",
                             "cen-bis3-positive_ubl.xml")
    base_root = ET.parse(base_path).getroot()
    dst = os.path.join(scratch, "mutations")
    os.makedirs(dst, exist_ok=True)
    out = []
    for rid in OUR_RULE_IDS:
        mut = _MUTATIONS.get(rid)
        if mut is None:
            continue
        root = copy.deepcopy(base_root)
        try:
            mut(root)
        except Exception as e:  # pragma: no cover
            print("  [mutation %s FAILED to build: %s]" % (rid, e), file=sys.stderr)
            continue
        out_path = os.path.join(dst, "mut_%s.xml" % rid.replace("-", "_"))
        _write_doc(root, out_path)
        out.append(("MUT/%s" % rid, out_path))
    return out


# ------- XRechnung (BR-DE-*) targeted mutations, off a clean XR invoice ----- #
_XR_BASE = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test",
                        "business-cases", "standard", "01.01a-INVOICE_ubl.xml")
_NSD = {"cac": NS_CAC, "cbc": NS_CBC}


def _xr_supplier_party(r):
    return r.find("cac:AccountingSupplierParty/cac:Party", _NSD)


def _xr_pm(r):
    return r.find("cac:PaymentMeans", _NSD)


def _xr_pm_code(r):
    return _xr_pm(r).find("cbc:PaymentMeansCode", _NSD)


def _xr_add_mandate(r, with_account_id):
    pm = _xr_pm(r)
    mandate = _sub_el(pm, NS_CAC, "PaymentMandate")
    _sub_el(mandate, NS_CBC, "ID", "MANDATE-1")
    if with_account_id is not None:
        acct = _sub_el(mandate, NS_CAC, "PayerFinancialAccount")
        _sub_el(acct, NS_CBC, "ID", with_account_id)


def _xr_add_delivery_address(r, city=None, zone=None):
    d = _sub_el(r, NS_CAC, "Delivery")
    loc = _sub_el(d, NS_CAC, "DeliveryLocation")
    addr = _sub_el(loc, NS_CAC, "Address")
    if city:
        _sub_el(addr, NS_CBC, "CityName", city)
    if zone:
        _sub_el(addr, NS_CBC, "PostalZone", zone)


def _xrmut_de1(r):
    for pm in r.findall("cac:PaymentMeans", _NSD):
        r.remove(pm)


def _xrmut_de2(r):
    party = _xr_supplier_party(r)
    party.remove(party.find("cac:Contact", _NSD))


def _xrmut_de3(r):
    a = _xr_supplier_party(r).find("cac:PostalAddress", _NSD)
    a.remove(a.find("cbc:CityName", _NSD))


def _xrmut_de4(r):
    a = _xr_supplier_party(r).find("cac:PostalAddress", _NSD)
    a.remove(a.find("cbc:PostalZone", _NSD))


def _xrmut_de5(r):
    c = _xr_supplier_party(r).find("cac:Contact", _NSD)
    c.remove(c.find("cbc:Name", _NSD))


def _xrmut_de6(r):
    # Also fires BR-DE-27: normalize-space of an absent telephone is ''.
    c = _xr_supplier_party(r).find("cac:Contact", _NSD)
    c.remove(c.find("cbc:Telephone", _NSD))


def _xrmut_de7(r):
    # Also fires BR-DE-28 (absent email -> '').
    c = _xr_supplier_party(r).find("cac:Contact", _NSD)
    c.remove(c.find("cbc:ElectronicMail", _NSD))


def _xrmut_de8(r):
    a = r.find("cac:AccountingCustomerParty/cac:Party/cac:PostalAddress", _NSD)
    a.remove(a.find("cbc:CityName", _NSD))


def _xrmut_de9(r):
    a = r.find("cac:AccountingCustomerParty/cac:Party/cac:PostalAddress", _NSD)
    a.remove(a.find("cbc:PostalZone", _NSD))


def _xrmut_de10(r):
    _xr_add_delivery_address(r, zone="12345")   # city missing -> BR-DE-10


def _xrmut_de11(r):
    _xr_add_delivery_address(r, city="Bremen")  # zone missing -> BR-DE-11


def _xrmut_de14(r):
    cat = r.find("cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory", _NSD)
    cat.remove(cat.find("cbc:Percent", _NSD))


def _xrmut_de15(r):
    r.remove(r.find("cbc:BuyerReference", _NSD))


def _xrmut_de16(r):
    party = _xr_supplier_party(r)
    party.remove(party.find("cac:PartyTaxScheme", _NSD))


def _xrmut_de17(r):
    r.find("cbc:InvoiceTypeCode", _NSD).text = "71"  # UNTDID-valid, not XR-allowed


def _xrmut_de18_bad(r):
    # PROZENT lacks the mandatory 2 decimals -> grammar violation.
    r.find("cac:PaymentTerms/cbc:Note", _NSD).text = "#SKONTO#TAGE=14#PROZENT=2#"


def _xrmut_de18_valid(r):
    # Grammar-conformant skonto WITH the required trailing newline -> holds.
    r.find("cac:PaymentTerms/cbc:Note", _NSD).text = \
        "#SKONTO#TAGE=14#PROZENT=2.00#\n"


def _xrmut_de19(r):
    # Shape-valid IBAN with impossible check digits 00 -> mod-97 fails.
    _xr_pm(r).find("cac:PayeeFinancialAccount/cbc:ID", _NSD).text = \
        "DE00000000001234567890"


def _xrmut_de20(r):
    # Code 59 + mandate with a BAD debited IBAN; PayeeFinancialAccount kept
    # -> also fires BR-DE-25-b and BR-DE-30 (no SEPA creditor id).
    _xr_pm_code(r).text = "59"
    _xr_add_mandate(r, with_account_id="DE00000000001234567890")


def _xrmut_de21(r):
    r.find("cbc:CustomizationID", _NSD).text = "urn:cen.eu:en16931:2017"


def _xrmut_de22(r):
    for i in (1, 2):
        adr = ET.Element(_q(NS_CAC, "AdditionalDocumentReference"))
        _sub_el(adr, NS_CBC, "ID", "doc-%d" % i)
        att = _sub_el(adr, NS_CAC, "Attachment")
        obj = _sub_el(att, NS_CBC, "EmbeddedDocumentBinaryObject", "UkVDSA==")
        obj.set("filename", "anlage.pdf")
        obj.set("mimeCode", "application/pdf")
        r.insert(list(r).index(r.find("cac:AccountingSupplierParty", _NSD)), adr)


def _xrmut_de23a(r):
    # Code 58 without CREDIT TRANSFER -> BR-DE-23-a (+ BR-DE-19: IBAN of '').
    pm = _xr_pm(r)
    pm.remove(pm.find("cac:PayeeFinancialAccount", _NSD))


def _xrmut_de23b(r):
    card = _sub_el(_xr_pm(r), NS_CAC, "CardAccount")
    _sub_el(card, NS_CBC, "PrimaryAccountNumberID", "1234")
    _sub_el(card, NS_CBC, "NetworkID", "VISA")


def _xrmut_de24(r):
    # Card code with CREDIT TRANSFER present and no CardAccount
    # -> BR-DE-24-a AND BR-DE-24-b.
    _xr_pm_code(r).text = "48"


def _xrmut_de25(r):
    # Direct-debit code with CREDIT TRANSFER present and no mandate
    # -> BR-DE-25-a, BR-DE-25-b (+ BR-DE-20: IBAN of '').
    _xr_pm_code(r).text = "59"


def _xrmut_de26(r):
    r.find("cbc:InvoiceTypeCode", _NSD).text = "384"  # no BillingReference


def _xrmut_de27(r):
    c = _xr_supplier_party(r).find("cac:Contact", _NSD)
    c.find("cbc:Telephone", _NSD).text = "keine"  # < 3 digits


def _xrmut_de28(r):
    c = _xr_supplier_party(r).find("cac:Contact", _NSD)
    c.find("cbc:ElectronicMail", _NSD).text = "kein-email-hier"


def _xrmut_de30(r):
    # Mandate + VALID debited IBAN, no SEPA creditor id anywhere -> BR-DE-30
    # only (BR-DE-20/31 hold; PayeeFinancialAccount removed so 25-b holds).
    pm = _xr_pm(r)
    _xr_pm_code(r).text = "59"
    pm.remove(pm.find("cac:PayeeFinancialAccount", _NSD))
    _xr_add_mandate(r, with_account_id="DE79000000001234567890")


def _xrmut_de31(r):
    # Mandate WITHOUT PayerFinancialAccount/ID; SEPA creditor id added so
    # BR-DE-30 holds -> BR-DE-31 (+ BR-DE-20: IBAN of '').
    pm = _xr_pm(r)
    _xr_pm_code(r).text = "59"
    pm.remove(pm.find("cac:PayeeFinancialAccount", _NSD))
    _xr_add_mandate(r, with_account_id=None)
    party = _xr_supplier_party(r)
    pid = ET.Element(_q(NS_CAC, "PartyIdentification"))
    id_el = ET.SubElement(pid, _q(NS_CBC, "ID"))
    id_el.text = "DE98ZZZ09999999999"
    id_el.set("schemeID", "SEPA")
    party.insert(1, pid)


def _xrmut_tmp32_clear(r):
    # BT-72 present -> BR-DE-TMP-32 HOLDS (the base invoice fires it).
    d = _sub_el(r, NS_CAC, "Delivery")
    _sub_el(d, NS_CBC, "ActualDeliveryDate", "2016-04-04")


# label suffix -> mutation. Some mutations legitimately fire several BR-DE
# rules at once; agreement is asserted per rule, so that is fine. Two entries
# ("18-valid", "TMP-32-clear") prove the HOLDS direction of tricky rules.
_XR_MUTATIONS = [
    ("BR-DE-1", _xrmut_de1), ("BR-DE-2", _xrmut_de2), ("BR-DE-3", _xrmut_de3),
    ("BR-DE-4", _xrmut_de4), ("BR-DE-5", _xrmut_de5), ("BR-DE-6", _xrmut_de6),
    ("BR-DE-7", _xrmut_de7), ("BR-DE-8", _xrmut_de8), ("BR-DE-9", _xrmut_de9),
    ("BR-DE-10", _xrmut_de10), ("BR-DE-11", _xrmut_de11),
    ("BR-DE-14", _xrmut_de14), ("BR-DE-15", _xrmut_de15),
    ("BR-DE-16", _xrmut_de16), ("BR-DE-17", _xrmut_de17),
    ("BR-DE-18", _xrmut_de18_bad), ("BR-DE-18-valid", _xrmut_de18_valid),
    ("BR-DE-19", _xrmut_de19), ("BR-DE-20", _xrmut_de20),
    ("BR-DE-21", _xrmut_de21), ("BR-DE-22", _xrmut_de22),
    ("BR-DE-23-a", _xrmut_de23a), ("BR-DE-23-b", _xrmut_de23b),
    ("BR-DE-24", _xrmut_de24), ("BR-DE-25", _xrmut_de25),
    ("BR-DE-26", _xrmut_de26), ("BR-DE-27", _xrmut_de27),
    ("BR-DE-28", _xrmut_de28), ("BR-DE-30", _xrmut_de30),
    ("BR-DE-31", _xrmut_de31), ("BR-DE-TMP-32-clear", _xrmut_tmp32_clear),
]


def _gather_xr_mutations(scratch: str):
    """One generated invoice per BR-DE mutation, off a clean XR invoice."""
    base_root = ET.parse(_XR_BASE).getroot()
    dst = os.path.join(scratch, "xr-mutations")
    os.makedirs(dst, exist_ok=True)
    out = []
    for name, mut in _XR_MUTATIONS:
        root = copy.deepcopy(base_root)
        try:
            mut(root)
        except Exception as e:  # pragma: no cover
            print("  [XR mutation %s FAILED to build: %s]" % (name, e),
                  file=sys.stderr)
            continue
        out_path = os.path.join(dst, "xrmut_%s.xml" % name.replace("-", "_"))
        _write_doc(root, out_path)
        out.append(("XRMUT/%s" % name, out_path))
    return out


# --- XRechnung EXTENSION (BR-DEX-*) targeted mutations, off a clean ext base -- #
# 04.02a is a clean XRechnung-Extension invoice (verified: fires NO BR-DEX on the
# official XSLT) carrying a SubInvoiceLine, a SEPA PartyIdentification, an EM
# EndpointID and a code-59 PaymentMandate — everything the fourteen extension
# rules key on. Each mutation breaks exactly one BR-DEX guard.
_XR_EXT_BASE = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test",
                            "business-cases", "extension", "04.02a-INVOICE_ubl.xml")


def _ext_supplier_party(r):
    return r.find("cac:AccountingSupplierParty/cac:Party", _NSD)


def _ext_add_prepaid(r, id_=None, amount=None, currency="EUR", instr=None):
    """Append a THIRD PARTY PAYMENT group (cac:PrepaidPayment) to the Invoice."""
    pp = ET.SubElement(r, _q(NS_CAC, "PrepaidPayment"))
    if id_ is not None:
        _sub_el(pp, NS_CBC, "ID", id_)
    if amount is not None:
        amt = _sub_el(pp, NS_CBC, "PaidAmount", amount)
        amt.set("currencyID", currency)
    if instr is not None:
        _sub_el(pp, NS_CBC, "InstructionID", instr)
    return pp


def _xrmut_dex1(r):
    # An Attachment binary object with a MIME code the Extension forbids.
    adr = ET.Element(_q(NS_CAC, "AdditionalDocumentReference"))
    _sub_el(adr, NS_CBC, "ID", "attach-1")
    att = _sub_el(adr, NS_CAC, "Attachment")
    obj = _sub_el(att, NS_CBC, "EmbeddedDocumentBinaryObject", "UkVDSA==")
    obj.set("filename", "data.zip")
    obj.set("mimeCode", "application/zip")
    r.insert(list(r).index(r.find("cac:AccountingSupplierParty", _NSD)), adr)


def _xrmut_dex2(r):
    # Break the sub-line net-amount sum: parent 27.72 != 99.99 + 15.40.
    r.find("cac:InvoiceLine/cac:SubInvoiceLine/cbc:LineExtensionAmount",
           _NSD).text = "99.99"


def _xrmut_dex3(r):
    # A SubInvoiceLine Item left with zero ClassifiedTaxCategory (must be 1).
    item = r.find("cac:InvoiceLine/cac:SubInvoiceLine/cac:Item", _NSD)
    item.remove(item.find("cac:ClassifiedTaxCategory", _NSD))


def _xrmut_dex4(r):
    # A second Party identifier with a scheme id that is neither ISO 6523 nor
    # SEPA (the base's SEPA identifier stays, so BR-DE-30 still holds).
    party = _ext_supplier_party(r)
    pid = ET.Element(_q(NS_CAC, "PartyIdentification"))
    idel = _sub_el(pid, NS_CBC, "ID", "X")
    idel.set("schemeID", "ZZZ")
    party.insert(1, pid)


def _xrmut_dex5(r):
    r.find("cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/"
           "cbc:CompanyID", _NSD).set("schemeID", "ZZZ")


def _xrmut_dex6(r):
    item = r.find("cac:InvoiceLine/cac:Item", _NSD)
    sii = ET.Element(_q(NS_CAC, "StandardItemIdentification"))
    idel = _sub_el(sii, NS_CBC, "ID", "0815")
    idel.set("schemeID", "ZZZ")
    item.insert(1, sii)


def _xrmut_dex7(r):
    # Endpoint scheme id off the CEF EAS list.
    r.find("cac:AccountingSupplierParty/cac:Party/cbc:EndpointID",
           _NSD).set("schemeID", "ZZ")


def _xrmut_dex8(r):
    d = _sub_el(r, NS_CAC, "Delivery")
    loc = _sub_el(d, NS_CAC, "DeliveryLocation")
    idel = _sub_el(loc, NS_CBC, "ID", "LOC-1")
    idel.set("schemeID", "ZZZ")


def _xrmut_dex9(r):
    # Payable no longer equals TaxInclusive (no prepaid / third-party) -> off.
    r.find("cac:LegalMonetaryTotal/cbc:PayableAmount", _NSD).text = "99.99"


def _xrmut_dex10(r):
    # THIRD PARTY PAYMENT missing its type id (BT-DEX-001).
    _ext_add_prepaid(r, id_=None, amount="0.00", currency="EUR", instr="tip")


def _xrmut_dex11(r):
    # Missing amount (BT-DEX-002) -> BR-DEX-11 (and BR-DEX-14: no currency).
    _ext_add_prepaid(r, id_="10", amount=None, instr="tip")


def _xrmut_dex12(r):
    # Missing description (BT-DEX-003).
    _ext_add_prepaid(r, id_="10", amount="0.00", currency="EUR", instr=None)


def _xrmut_dex13(r):
    # Amount with three fractional digits.
    _ext_add_prepaid(r, id_="10", amount="0.001", currency="EUR", instr="tip")


def _xrmut_dex14(r):
    # Amount currency (USD) != Invoice currency code (EUR).
    _ext_add_prepaid(r, id_="10", amount="0.00", currency="USD", instr="tip")


_XR_EXT_MUTATIONS = [
    ("BR-DEX-01", _xrmut_dex1), ("BR-DEX-02", _xrmut_dex2),
    ("BR-DEX-03", _xrmut_dex3), ("BR-DEX-04", _xrmut_dex4),
    ("BR-DEX-05", _xrmut_dex5), ("BR-DEX-06", _xrmut_dex6),
    ("BR-DEX-07", _xrmut_dex7), ("BR-DEX-08", _xrmut_dex8),
    ("BR-DEX-09", _xrmut_dex9), ("BR-DEX-10", _xrmut_dex10),
    ("BR-DEX-11", _xrmut_dex11), ("BR-DEX-12", _xrmut_dex12),
    ("BR-DEX-13", _xrmut_dex13), ("BR-DEX-14", _xrmut_dex14),
]


def _gather_xr_ext_mutations(scratch: str):
    """One generated invoice per BR-DEX mutation, off a clean XR-Extension base."""
    base_root = ET.parse(_XR_EXT_BASE).getroot()
    dst = os.path.join(scratch, "xr-ext-mutations")
    os.makedirs(dst, exist_ok=True)
    out = []
    for name, mut in _XR_EXT_MUTATIONS:
        root = copy.deepcopy(base_root)
        try:
            mut(root)
        except Exception as e:  # pragma: no cover
            print("  [XR-EXT mutation %s FAILED to build: %s]" % (name, e),
                  file=sys.stderr)
            continue
        out_path = os.path.join(dst, "xrextmut_%s.xml" % name.replace("-", "_"))
        _write_doc(root, out_path)
        out.append(("XREXTMUT/%s" % name, out_path))
    return out


# --- PEPPOL-EN16931-R* (UBL) targeted mutations, off the clean XR base ------- #
# One invoice per implemented rule, each breaking exactly the guarded fact in
# the FAILING direction (the rest of the LEG 2 corpus exercises the HOLDS
# direction — the clean base fires none of the batch on the official XSLT).
def _pep_add_doc_allowance(r, indicator="false", amount=None, base=None,
                           percent=None):
    """Insert a document-level cac:AllowanceCharge (official child order:
    ChargeIndicator, Reason, MultiplierFactorNumeric, Amount, BaseAmount,
    TaxCategory) before cac:TaxTotal."""
    ac = ET.Element(_q(NS_CAC, "AllowanceCharge"))
    _sub_el(ac, NS_CBC, "ChargeIndicator", indicator)
    _sub_el(ac, NS_CBC, "AllowanceChargeReason", "Adjustment")
    if percent is not None:
        _sub_el(ac, NS_CBC, "MultiplierFactorNumeric", percent)
    if amount is not None:
        _sub_el(ac, NS_CBC, "Amount", amount).set("currencyID", "EUR")
    if base is not None:
        _sub_el(ac, NS_CBC, "BaseAmount", base).set("currencyID", "EUR")
    cat = _sub_el(ac, NS_CAC, "TaxCategory")
    _sub_el(cat, NS_CBC, "ID", "S")
    _sub_el(cat, NS_CBC, "Percent", "19")
    _sub_el(_sub_el(cat, NS_CAC, "TaxScheme"), NS_CBC, "ID", "VAT")
    r.insert(list(r).index(_child(r, NS_CAC, "TaxTotal")), ac)


def _pep_add_price_allowance(r, indicator, base_delta, amount="1.00"):
    """Add a cac:Price/cac:AllowanceCharge to the first line. BaseAmount is set
    to PriceAmount + ``base_delta`` so R046 holds exactly when
    base_delta == Decimal(amount)."""
    from decimal import Decimal
    price = r.find("cac:InvoiceLine/cac:Price", _NSD)
    pa = Decimal(price.find("cbc:PriceAmount", _NSD).text)
    ac = _sub_el(price, NS_CAC, "AllowanceCharge")
    _sub_el(ac, NS_CBC, "ChargeIndicator", indicator)
    _sub_el(ac, NS_CBC, "Amount", amount).set("currencyID", "EUR")
    _sub_el(ac, NS_CBC, "BaseAmount", str(pa + base_delta)).set(
        "currencyID", "EUR")


def _pepmut_r001(r):
    r.remove(_child(r, NS_CBC, "ProfileID"))


def _pepmut_r005(r):
    dcc = _child(r, NS_CBC, "DocumentCurrencyCode")
    tcc = ET.Element(_q(NS_CBC, "TaxCurrencyCode"))
    tcc.text = dcc.text  # equal codes -> fires
    r.insert(list(r).index(dcc) + 1, tcc)


def _pepmut_r008(r):
    ET.SubElement(r, _q(NS_CBC, "Note"))  # an empty element anywhere fires


def _pepmut_r010(r):
    party = _customer_party(r)
    party.remove(party.find("cbc:EndpointID", _NSD))


def _pepmut_r020(r):
    party = _xr_supplier_party(r)
    party.remove(party.find("cbc:EndpointID", _NSD))


def _pepmut_r040(r):
    # 10.00 != 100.00 * 25 / 100 = 25.00 (off by far more than the 0.02 slack).
    _pep_add_doc_allowance(r, amount="10.00", base="100.00", percent="25")


def _pepmut_r041(r):
    _pep_add_doc_allowance(r, amount="10.00", percent="25")  # no BaseAmount


def _pepmut_r042(r):
    _pep_add_doc_allowance(r, amount="10.00", base="100.00")  # no percentage


def _pepmut_r043(r):
    _pep_add_doc_allowance(r, indicator="TRUE", amount="10.00")


def _pepmut_r044(r):
    # Price-level CHARGE (indicator true); amounts consistent so R046 holds.
    from decimal import Decimal
    _pep_add_price_allowance(r, "true", Decimal("1.00"))


def _pepmut_r046(r):
    # PriceAmount != BaseAmount - Amount (base is 5.00 over, amount only 1.00).
    from decimal import Decimal
    _pep_add_price_allowance(r, "false", Decimal("5.00"))


# --- batch 2 (R053-R130) helpers + mutations. Each rule gets a FIRE fixture; #
# rules whose holds-direction is nontrivial (an engaged context that passes)  #
# additionally get an -OK fixture. The clean base + the rest of the corpus    #
# already exercise the not-engaged holds direction for everything.            #
def _pep_add_tax_currency(r, code="USD"):
    """cbc:TaxCurrencyCode (BT-6) right after cbc:DocumentCurrencyCode."""
    dcc = _child(r, NS_CBC, "DocumentCurrencyCode")
    tcc = ET.Element(_q(NS_CBC, "TaxCurrencyCode"))
    tcc.text = code
    r.insert(list(r).index(dcc) + 1, tcc)


def _pep_add_plain_tax_total(r, amount, currency):
    """A subtotal-free cac:TaxTotal (the BT-111 carrier) before the monetary
    total."""
    tt = ET.Element(_q(NS_CAC, "TaxTotal"))
    _sub_el(tt, NS_CBC, "TaxAmount", amount).set("currencyID", currency)
    r.insert(list(r).index(_child(r, NS_CAC, "LegalMonetaryTotal")), tt)


def _pep_add_doc_period(r, start=None, end=None):
    """Document cac:InvoicePeriod (BG-14) before AccountingSupplierParty. The
    01.01a base's FIRST line already carries a line InvoicePeriod
    2016-01-01..2016-12-31 — the doc period turns the R110/R111 contexts on."""
    ip = ET.Element(_q(NS_CAC, "InvoicePeriod"))
    if start is not None:
        _sub_el(ip, NS_CBC, "StartDate", start)
    if end is not None:
        _sub_el(ip, NS_CBC, "EndDate", end)
    r.insert(list(r).index(_child(r, NS_CAC, "AccountingSupplierParty")), ip)


def _pep_set_payment_means_code(r, code):
    pm = r.find("cac:PaymentMeans", _NSD)
    pm.find("cbc:PaymentMeansCode", _NSD).text = code
    return pm


def _pep_add_line_doc_reference(r, type_code):
    line = r.find("cac:InvoiceLine", _NSD)
    dr = ET.Element(_q(NS_CAC, "DocumentReference"))
    _sub_el(dr, NS_CBC, "ID", "LINE-OBJ-1")
    _sub_el(dr, NS_CBC, "DocumentTypeCode", type_code)
    line.insert(list(line).index(line.find("cac:Item", _NSD)), dr)


def _pep_add_base_quantity(r, value, unit=None):
    """cbc:BaseQuantity on the first line's cac:Price (whose PriceAmount is
    288.79; the line's InvoicedQuantity is 1 XPP)."""
    price = r.find("cac:InvoiceLine/cac:Price", _NSD)
    bq = _sub_el(price, NS_CBC, "BaseQuantity", value)
    if unit is not None:
        bq.set("unitCode", unit)


def _pepmut_r053(r):
    # A SECOND subtotal-carrying cac:TaxTotal -> count = 2 != 1.
    src = _child(r, NS_CAC, "TaxTotal")
    r.insert(list(r).index(src) + 1, copy.deepcopy(src))


def _pepmut_r054(r):
    # BT-6 present but NO subtotal-free TaxTotal -> count 0 != 1. (R055 also
    # fires officially: no tax-currency TaxAmount exists at all.)
    _pep_add_tax_currency(r)


def _pepmut_r054_ok(r):
    # Engaged holds: BT-6 + exactly one subtotal-free USD TaxTotal, same sign
    # as the EUR total -> R053/R054/R055 all hold.
    _pep_add_tax_currency(r)
    _pep_add_plain_tax_total(r, "21.00", "USD")


def _pepmut_r055(r):
    # Sign flip: USD total negative, EUR total positive -> R055 fires while
    # R053/R054 hold.
    _pep_add_tax_currency(r)
    _pep_add_plain_tax_total(r, "-21.00", "USD")


def _pepmut_r061(r):
    # Direct debit (59) without cac:PaymentMandate/cbc:ID.
    _pep_set_payment_means_code(r, "59")


def _pepmut_r061_ok(r):
    # Engaged holds: direct debit WITH a mandate reference.
    pm = _pep_set_payment_means_code(r, "59")
    _sub_el(_sub_el(pm, NS_CAC, "PaymentMandate"), NS_CBC, "ID", "MANDATE-1")


def _pepmut_r101(r):
    _pep_add_line_doc_reference(r, "916")  # only '130' is allowed


def _pepmut_r101_ok(r):
    _pep_add_line_doc_reference(r, "130")  # engaged holds


def _pepmut_r110(r):
    # Doc period starts AFTER the line period start (2016-01-01).
    _pep_add_doc_period(r, start="2016-02-01")


def _pepmut_r111(r):
    # Doc period ends BEFORE the line period end (2016-12-31).
    _pep_add_doc_period(r, end="2016-06-30")


def _pepmut_r110_111_ok(r):
    # Engaged holds: the line period lies within the doc period.
    _pep_add_doc_period(r, start="2016-01-01", end="2016-12-31")


def _pepmut_r120(r):
    # LineExtensionAmount off by 10.00 from qty*(price/base) = 288.79.
    line = r.find("cac:InvoiceLine", _NSD)
    line.find("cbc:LineExtensionAmount", _NSD).text = "298.79"


def _pepmut_r121(r):
    _pep_add_base_quantity(r, "0")  # 0 is not > 0; R120 unaffected (0 -> 1)


def _pepmut_r121_ok(r):
    _pep_add_base_quantity(r, "1")  # engaged holds; R120's base stays 1


def _pepmut_r130(r):
    # unitCode KGM != the line's InvoicedQuantity unitCode XPP.
    _pep_add_base_quantity(r, "1", unit="KGM")


def _pepmut_r130_ok(r):
    _pep_add_base_quantity(r, "1", unit="XPP")  # engaged holds


_PEPPOL_MUTATIONS = [
    ("PEPPOL-R001", _pepmut_r001), ("PEPPOL-R005", _pepmut_r005),
    ("PEPPOL-R008", _pepmut_r008), ("PEPPOL-R010", _pepmut_r010),
    ("PEPPOL-R020", _pepmut_r020), ("PEPPOL-R040", _pepmut_r040),
    ("PEPPOL-R041", _pepmut_r041), ("PEPPOL-R042", _pepmut_r042),
    ("PEPPOL-R043", _pepmut_r043), ("PEPPOL-R044", _pepmut_r044),
    ("PEPPOL-R046", _pepmut_r046),
    ("PEPPOL-R053", _pepmut_r053), ("PEPPOL-R054", _pepmut_r054),
    ("PEPPOL-R054-OK", _pepmut_r054_ok), ("PEPPOL-R055", _pepmut_r055),
    ("PEPPOL-R061", _pepmut_r061), ("PEPPOL-R061-OK", _pepmut_r061_ok),
    ("PEPPOL-R101", _pepmut_r101), ("PEPPOL-R101-OK", _pepmut_r101_ok),
    ("PEPPOL-R110", _pepmut_r110), ("PEPPOL-R111", _pepmut_r111),
    ("PEPPOL-R110-111-OK", _pepmut_r110_111_ok),
    ("PEPPOL-R120", _pepmut_r120), ("PEPPOL-R121", _pepmut_r121),
    ("PEPPOL-R121-OK", _pepmut_r121_ok), ("PEPPOL-R130", _pepmut_r130),
    ("PEPPOL-R130-OK", _pepmut_r130_ok),
]


def _gather_peppol_mutations(scratch: str):
    """One generated UBL invoice per implemented PEPPOL-EN16931-R* rule, off the
    clean XR base (the same base the BR-DE mutations use)."""
    base_root = ET.parse(_XR_BASE).getroot()
    dst = os.path.join(scratch, "peppol-mutations")
    os.makedirs(dst, exist_ok=True)
    out = []
    for name, mut in _PEPPOL_MUTATIONS:
        root = copy.deepcopy(base_root)
        try:
            mut(root)
        except Exception as e:  # pragma: no cover
            print("  [PEPPOL mutation %s FAILED to build: %s]" % (name, e),
                  file=sys.stderr)
            continue
        out_path = os.path.join(dst, "pepmut_%s.xml" % name.replace("-", "_"))
        _write_doc(root, out_path)
        out.append(("PEPMUT/%s" % name, out_path))
    return out


# --------------------------------------------------------------------------- #
# CII (CrossIndustryInvoice) corpus + targeted mutations.                       #
#                                                                              #
# Corpus = the vendored CEN CII example invoices (all official-clean) + one     #
# generated mutation per graded rule, each breaking exactly the CII field that  #
# rule guards, off a known-clean CII base (CII_example1: a 20-line S-rated Dutch #
# grocery invoice that fires nothing on the official CII XSLT and carries a      #
# Seller VAT registration id). Every mutation exercises its rule in the FAILING  #
# direction on both engines.                                                     #
# --------------------------------------------------------------------------- #
CII_EXAMPLES_DIR = os.path.join(HERE, "corpus", "cen-en16931", "cii", "examples")
_CII_BASE = os.path.join(CII_EXAMPLES_DIR, "CII_example1.xml")
# Base for BR-CL-17: CII_example1 has no document allowance/charge, so its
# ram:CategoryTradeTax context (the ONLY BR-CL-17 context in CII) is absent.
# CII_business_example_01 is an official-clean invoice that DOES carry a
# document-level SpecifiedTradeAllowanceCharge/ram:CategoryTradeTax, so mutating
# just that CategoryCode fires BR-CL-17 with nothing else in the graded set.
_CII_BASE_ALLOWANCE = os.path.join(CII_EXAMPLES_DIR, "CII_business_example_01.xml")
_CII_MUTATION_BASE = {"BR-CL-17": _CII_BASE_ALLOWANCE}
_NSC = {"rsm": NS_RSM, "ram": NS_RAM, "udt": NS_UDT}


def _register_cii_ns():
    ET.register_namespace("rsm", NS_RSM)
    ET.register_namespace("ram", NS_RAM)
    ET.register_namespace("udt", NS_UDT)
    ET.register_namespace("qdt",
                          "urn:un:unece:uncefact:data:standard:QualifiedDataType:100")
    ET.register_namespace("xsi", "http://www.w3.org/2001/XMLSchema-instance")


def _write_cii_doc(elem: ET.Element, out_path: str):
    _register_cii_ns()
    ET.ElementTree(elem).write(out_path, encoding="utf-8", xml_declaration=True)


def _cq(ns, local):
    return "{%s}%s" % (ns, local)


def _cii_parent_map(root):
    return {c: p for p in root.iter() for c in p}


def _cii_remove(root, elem):
    if elem is not None:
        _cii_parent_map(root)[elem].remove(elem)


def _cii_settlement(r):
    return r.find("rsm:SupplyChainTradeTransaction/"
                  "ram:ApplicableHeaderTradeSettlement", _NSC)


def _cii_summation(r):
    return _cii_settlement(r).find(
        "ram:SpecifiedTradeSettlementHeaderMonetarySummation", _NSC)


def _cii_first_line(r):
    return r.find("rsm:SupplyChainTradeTransaction/"
                  "ram:IncludedSupplyChainTradeLineItem", _NSC)


def _cii_seller(r):
    return r.find("rsm:SupplyChainTradeTransaction/"
                  "ram:ApplicableHeaderTradeAgreement/ram:SellerTradeParty", _NSC)


def _cii_buyer(r):
    return r.find("rsm:SupplyChainTradeTransaction/"
                  "ram:ApplicableHeaderTradeAgreement/ram:BuyerTradeParty", _NSC)


def _cii_first_breakdown(r):
    return _cii_settlement(r).find("ram:ApplicableTradeTax", _NSC)


def _cii_line_tax(r):
    return _cii_first_line(r).find(
        "ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax", _NSC)


def _cii_set(parent, path, text):
    parent.find(path, _NSC).text = text


# ---- header existence / cardinality --------------------------------------- #
def _cmut_br01(r):
    _cii_remove(r, r.find("rsm:ExchangedDocumentContext/"
                          "ram:GuidelineSpecifiedDocumentContextParameter/"
                          "ram:ID", _NSC))


def _cmut_br02(r):
    _cii_remove(r, r.find("rsm:ExchangedDocument/ram:ID", _NSC))


def _cmut_br03(r):
    _cii_remove(r, r.find("rsm:ExchangedDocument/ram:IssueDateTime", _NSC))


def _cmut_br04(r):
    _cii_remove(r, r.find("rsm:ExchangedDocument/ram:TypeCode", _NSC))


def _cmut_br05(r):
    _cii_remove(r, _cii_settlement(r).find("ram:InvoiceCurrencyCode", _NSC))


def _cmut_br06(r):
    _cii_remove(r, _cii_seller(r).find("ram:Name", _NSC))


def _cmut_br07(r):
    _cii_remove(r, _cii_buyer(r).find("ram:Name", _NSC))


def _cmut_br08(r):
    _cii_remove(r, _cii_seller(r).find("ram:PostalTradeAddress", _NSC))


def _cmut_br10(r):
    _cii_remove(r, _cii_buyer(r).find("ram:PostalTradeAddress", _NSC))


def _cmut_br12(r):
    _cii_remove(r, _cii_summation(r).find("ram:LineTotalAmount", _NSC))


def _cmut_br13(r):
    _cii_remove(r, _cii_summation(r).find("ram:TaxBasisTotalAmount", _NSC))


def _cmut_br14(r):
    _cii_remove(r, _cii_summation(r).find("ram:GrandTotalAmount", _NSC))


def _cmut_br15(r):
    _cii_remove(r, _cii_summation(r).find("ram:DuePayableAmount", _NSC))


def _cmut_br16(r):
    txn = r.find("rsm:SupplyChainTradeTransaction", _NSC)
    for ln in txn.findall("ram:IncludedSupplyChainTradeLineItem", _NSC):
        txn.remove(ln)


def _cmut_br21(r):
    ln = _cii_first_line(r)
    _cii_remove(r, ln.find("ram:AssociatedDocumentLineDocument/ram:LineID", _NSC))


def _cmut_br22(r):
    ln = _cii_first_line(r)
    _cii_remove(r, ln.find(
        "ram:SpecifiedLineTradeDelivery/ram:BilledQuantity", _NSC))


def _cmut_br24(r):
    ln = _cii_first_line(r)
    _cii_remove(r, ln.find(
        "ram:SpecifiedLineTradeSettlement/"
        "ram:SpecifiedTradeSettlementLineMonetarySummation/"
        "ram:LineTotalAmount", _NSC))


def _cmut_br25(r):
    ln = _cii_first_line(r)
    _cii_remove(r, ln.find("ram:SpecifiedTradeProduct/ram:Name", _NSC))


def _cmut_br26(r):
    ln = _cii_first_line(r)
    _cii_remove(r, ln.find(
        "ram:SpecifiedLineTradeAgreement/"
        "ram:NetPriceProductTradePrice/ram:ChargeAmount", _NSC))


def _cmut_br27(r):
    _cii_first_line(r).find(
        "ram:SpecifiedLineTradeAgreement/"
        "ram:NetPriceProductTradePrice/ram:ChargeAmount", _NSC).text = "-1"


def _cmut_brcl01(r):
    r.find("rsm:ExchangedDocument/ram:TypeCode", _NSC).text = "999"


def _cmut_brco04(r):
    # Remove the line's VAT ApplicableTradeTax -> BR-CO-04 (no line VAT code).
    ln_settle = _cii_first_line(r).find("ram:SpecifiedLineTradeSettlement", _NSC)
    _cii_remove(r, ln_settle.find("ram:ApplicableTradeTax", _NSC))


def _cmut_brco10(r):
    _cii_summation(r).find("ram:LineTotalAmount", _NSC).text = "111111.11"


def _cmut_brco13(r):
    _cii_summation(r).find("ram:TaxBasisTotalAmount", _NSC).text = "111111.11"


def _cmut_brco16(r):
    _cii_summation(r).find("ram:DuePayableAmount", _NSC).text = "111111.11"


def _cmut_brco17(r):
    # First breakdown CalculatedAmount far from taxable × rate -> BR-CO-17.
    _cii_first_breakdown(r).find("ram:CalculatedAmount", _NSC).text = "99.99"


def _cmut_brco18(r):
    # Remove every VAT breakdown row -> BR-CO-18 (no BG-23 group).
    settle = _cii_settlement(r)
    for tt in settle.findall("ram:ApplicableTradeTax", _NSC):
        settle.remove(tt)


def _cmut_br45(r):
    _cii_remove(r, _cii_first_breakdown(r).find("ram:BasisAmount", _NSC))


def _cmut_br46(r):
    _cii_remove(r, _cii_first_breakdown(r).find("ram:CalculatedAmount", _NSC))


def _cmut_br47(r):
    _cii_remove(r, _cii_first_breakdown(r).find("ram:CategoryCode", _NSC))


def _cmut_br48(r):
    _cii_remove(r, _cii_first_breakdown(r).find(
        "ram:RateApplicablePercent", _NSC))


def _cmut_brs02(r):
    # Remove the Seller tax registration -> BR-S-02 (S line present, no VAT id).
    seller = _cii_seller(r)
    _cii_remove(r, seller.find("ram:SpecifiedTaxRegistration", _NSC))


def _cmut_brs05(r):
    # S line with VAT rate 0 -> BR-S-05.
    _cii_line_tax(r).find("ram:RateApplicablePercent", _NSC).text = "0"


def _cmut_brs09(r):
    # S breakdown tax amount far from taxable × rate -> BR-S-09 (also BR-CO-17).
    _cii_first_breakdown(r).find("ram:CalculatedAmount", _NSC).text = "99.99"


def _cmut_brs10(r):
    # S breakdown carrying a VAT exemption reason -> BR-S-10.
    bd = _cii_first_breakdown(r)
    rate = bd.find("ram:RateApplicablePercent", _NSC)
    reason = ET.Element(_cq(NS_RAM, "ExemptionReason"))
    reason.text = "Reverse charge"
    # CII order places ExemptionReason before RateApplicablePercent.
    bd.insert(list(bd).index(rate), reason)


def _cmut_brdec09(r):
    _cii_summation(r).find("ram:LineTotalAmount", _NSC).text = "625743.549"


def _cmut_brdec12(r):
    _cii_summation(r).find("ram:TaxBasisTotalAmount", _NSC).text = "625743.549"


def _cmut_brdec14(r):
    _cii_summation(r).find("ram:GrandTotalAmount", _NSC).text = "625743.549"


def _cmut_brdec18(r):
    _cii_summation(r).find("ram:DuePayableAmount", _NSC).text = "625743.549"


def _cmut_brdec19(r):
    _cii_first_breakdown(r).find("ram:BasisAmount", _NSC).text = "625743.549"


def _cmut_brdec20(r):
    _cii_first_breakdown(r).find("ram:CalculatedAmount", _NSC).text = "156435.889"


def _cmut_brdec23(r):
    _cii_first_line(r).find(
        "ram:SpecifiedLineTradeSettlement/"
        "ram:SpecifiedTradeSettlementLineMonetarySummation/"
        "ram:LineTotalAmount", _NSC).text = "625743.549"


# ---- codelist (BR-CL-*) mutations, CII bindings ---------------------------- #
def _cmut_brcl03(r):
    # ram:TaxTotalAmount[@currencyID] coded off ISO 4217 (BR-CO-14/15 are
    # CII-excluded, so shifting the VAT-currency match does not affect graded
    # rules; only BR-CL-03 fires here on both engines).
    _cii_summation(r).find("ram:TaxTotalAmount", _NSC).set("currencyID", "XXY")


def _cmut_brcl04(r):
    _cii_settlement(r).find("ram:InvoiceCurrencyCode", _NSC).text = "XXY"


def _cmut_brcl05(r):
    # Add a ram:TaxCurrencyCode (BT-6) with an off-list value.
    ET.SubElement(_cii_settlement(r), _cq(NS_RAM, "TaxCurrencyCode")).text = "XXY"


def _cmut_brcl13(r):
    # Add ram:DesignatedProductClassification/ram:ClassCode[@listID] with an
    # off-list @listID (not in UNTDID 7143) to the first product.
    prod = _cii_first_line(r).find("ram:SpecifiedTradeProduct", _NSC)
    dpc = ET.SubElement(prod, _cq(NS_RAM, "DesignatedProductClassification"))
    cc = ET.SubElement(dpc, _cq(NS_RAM, "ClassCode"))
    cc.set("listID", "QQ")
    cc.text = "1234"


def _cmut_brcl14(r):
    # Seller postal-address country (ram:CountryID) coded off ISO 3166-1.
    _cii_seller(r).find(
        "ram:PostalTradeAddress/ram:CountryID", _NSC).text = "XX"


def _cmut_brcl17(r):
    # Runs off _CII_BASE_ALLOWANCE (CII_business_example_01). Code the document
    # allowance/charge VAT category (ram:SpecifiedTradeAllowanceCharge/
    # ram:CategoryTradeTax/ram:CategoryCode) — the only BR-CL-17 context in CII —
    # off the UNCL 5305 subset. Amounts are untouched, so graded arithmetic
    # (BR-CO-13 etc.) stays clear; BR-S-01 is CII-excluded. The re-coded
    # allowance (100) leaves the S/25% bucket, so BR-S-08 fires ALONGSIDE
    # BR-CL-17 on both engines — agreement is asserted per rule.
    cc = _cii_settlement(r).find(
        "ram:SpecifiedTradeAllowanceCharge/ram:CategoryTradeTax/ram:CategoryCode",
        _NSC)
    cc.text = "XX"


def _cmut_brcl18(r):
    # A line VAT category (ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax
    # /ram:CategoryCode) coded off the UNCL 5305 subset. The header VAT breakdown
    # category stays 'S'; BR-S-01 is CII-excluded. The re-coded first line
    # (19.9) leaves the S/6% bucket, so BR-S-08 fires ALONGSIDE BR-CL-18 on
    # both engines — agreement is asserted per rule.
    _cii_line_tax(r).find("ram:CategoryCode", _NSC).text = "XX"


def _cmut_brcl22(r):
    # Add a VAT exemption reason code (ram:ExemptionReasonCode) with a non-VATEX
    # value to a LINE's ApplicableTradeTax. The CII BR-S-10 context is the HEADER
    # breakdown 'S' category ($VATS), not a line, so no BR-S-10 fires; BR-CL-22
    # is the only rule that fires.
    ET.SubElement(
        _cii_line_tax(r), _cq(NS_RAM, "ExemptionReasonCode")
    ).text = "NOT-A-VATEX-CODE"


def _cmut_brcl23(r):
    # Line billed quantity (ram:BilledQuantity) @unitCode coded off the UN/ECE
    # Rec 20 + Rec 21 unit-code list. Only a label — amounts untouched — so no
    # graded arithmetic rule flips; BR-CL-23 is the sole rule that fires.
    _cii_first_line(r).find(
        "ram:SpecifiedLineTradeDelivery/ram:BilledQuantity", _NSC
    ).set("unitCode", "XXY")


def _cmut_brcl16(r):
    # CII_example1 carries a payment means (ram:SpecifiedTradeSettlementPayment
    # Means/ram:TypeCode = '30'). Code it off the UNCL 4461 list. Only a code-
    # list label — amounts untouched — so BR-CL-16 is the sole rule that fires.
    _cii_settlement(r).find(
        "ram:SpecifiedTradeSettlementPaymentMeans/ram:TypeCode", _NSC
    ).text = "XXY"


def _cadd_reason_allowance_charge(r, charge, reason_code):
    """Append a document-level ram:SpecifiedTradeAllowanceCharge to the settlement
    with a coded reason and a zero, arithmetically-neutral ActualAmount.

    The document totals (SpecifiedTradeSettlementHeaderMonetarySummation) are left
    unchanged and the ActualAmount is 0.00, so no graded CII arithmetic
    (BR-CO-13 etc.) flips; the target reason-code rule is the only one to fire."""
    settle = _cii_settlement(r)
    ac = ET.SubElement(settle, _cq(NS_RAM, "SpecifiedTradeAllowanceCharge"))
    ind = ET.SubElement(ac, _cq(NS_RAM, "ChargeIndicator"))
    ET.SubElement(ind, _cq(NS_UDT, "Indicator")).text = (
        "true" if charge else "false")
    ET.SubElement(ac, _cq(NS_RAM, "ActualAmount")).text = "0.00"
    ET.SubElement(ac, _cq(NS_RAM, "ReasonCode")).text = reason_code


def _cmut_brcl19(r):
    # Document ALLOWANCE (udt:Indicator=false) with a reason code off the UNCL
    # 5189 allowance-reason list; ActualAmount 0.00 keeps totals neutral.
    _cadd_reason_allowance_charge(r, charge=False, reason_code="XXX")


def _cmut_brcl20(r):
    # Document CHARGE (udt:Indicator=true) with a reason code off the UNCL 7161
    # charge-reason list; ActualAmount 0.00 keeps totals neutral.
    _cadd_reason_allowance_charge(r, charge=True, reason_code="XXX")


def _cmut_brcl21(r):
    # Add a product standard identifier (ram:SpecifiedTradeProduct/ram:GlobalID)
    # with a @schemeID off the ISO 6523 ICD list to the first line's product.
    prod = _cii_first_line(r).find("ram:SpecifiedTradeProduct", _NSC)
    gid = ET.SubElement(prod, _cq(NS_RAM, "GlobalID"))
    gid.set("schemeID", "XXX")
    gid.text = "1234567890123"


def _cmut_brcl24(r):
    # Add a document attachment (ram:AdditionalReferencedDocument/ram:Attachment
    # BinaryObject) with a @mimeCode outside the six-entry MIMEMediaType subset.
    agreement = r.find("rsm:SupplyChainTradeTransaction/"
                       "ram:ApplicableHeaderTradeAgreement", _NSC)
    ard = ET.SubElement(agreement, _cq(NS_RAM, "AdditionalReferencedDocument"))
    ET.SubElement(ard, _cq(NS_RAM, "IssuerAssignedID")).text = "ATTACH-1"
    ET.SubElement(ard, _cq(NS_RAM, "TypeCode")).text = "916"
    abo = ET.SubElement(ard, _cq(NS_RAM, "AttachmentBinaryObject"))
    abo.set("mimeCode", "application/octet-stream")
    abo.set("filename", "attachment.bin")
    abo.text = "AAAA"


# ---- Supporting-document / item-metadata / VAT-point batch (CII side) ------ #
def _cmut_br23(r):
    # Strip @unitCode from the first line's ram:BilledQuantity (BT-130):
    # attribute existence fails; BR-CL-23 loses its context value instead of
    # firing.
    del _cii_first_line(r).find(
        "ram:SpecifiedLineTradeDelivery/ram:BilledQuantity",
        _NSC).attrib["unitCode"]


def _cmut_br52(r):
    # Add a header ram:AdditionalReferencedDocument (BG-24) with NO
    # ram:IssuerAssignedID: normalize-space('') fires BR-52.
    agreement = r.find("rsm:SupplyChainTradeTransaction/"
                       "ram:ApplicableHeaderTradeAgreement", _NSC)
    ard = ET.SubElement(agreement, _cq(NS_RAM, "AdditionalReferencedDocument"))
    ET.SubElement(ard, _cq(NS_RAM, "TypeCode")).text = "916"


def _cmut_br53(r):
    # Declare a VAT accounting currency (BT-6 = USD; the base invoice currency
    # is EUR) without any USD ram:TaxTotalAmount on the header summation: the
    # (ram:TaxTotalAmount/@currencyID = TCC) conjunct of the official CII test
    # fails. USD is a listed ISO 4217 code, so BR-CL-05 stays quiet.
    settle = _cii_settlement(r)
    icc = settle.find("ram:InvoiceCurrencyCode", _NSC)
    tcc = ET.Element(_cq(NS_RAM, "TaxCurrencyCode"))
    tcc.text = "USD"
    settle.insert(list(settle).index(icc) + 1, tcc)


def _cmut_br54(r):
    # Add an Item attribute (BG-32) with a Description (BT-160) but NO Value
    # (BT-161): the (ram:Description) and (ram:Value) conjunction fails.
    prod = _cii_first_line(r).find("ram:SpecifiedTradeProduct", _NSC)
    apc = ET.SubElement(prod, _cq(NS_RAM, "ApplicableProductCharacteristic"))
    ET.SubElement(apc, _cq(NS_RAM, "Description")).text = "Colour"


def _cmut_br56(r):
    # Add a Seller tax representative (BG-11) WITHOUT a VA-scheme
    # ram:SpecifiedTaxRegistration/ram:ID: normalize-space('') fires BR-56.
    # Name + postal address + country keep the ungraded BR-18/19/20 shape sane.
    agreement = r.find("rsm:SupplyChainTradeTransaction/"
                       "ram:ApplicableHeaderTradeAgreement", _NSC)
    trp = ET.SubElement(agreement,
                        _cq(NS_RAM, "SellerTaxRepresentativeTradeParty"))
    ET.SubElement(trp, _cq(NS_RAM, "Name")).text = "Rep A"
    pta = ET.SubElement(trp, _cq(NS_RAM, "PostalTradeAddress"))
    ET.SubElement(pta, _cq(NS_RAM, "CountryID")).text = "NL"


def _cmut_br64(r):
    # Add a product standard identifier (ram:GlobalID) with NO @schemeID:
    # normalize-space(@schemeID) = '' fires BR-64; BR-CL-21 has no attribute
    # value to check.
    prod = _cii_first_line(r).find("ram:SpecifiedTradeProduct", _NSC)
    gid = ET.Element(_cq(NS_RAM, "GlobalID"))
    gid.text = "1234567890123"
    prod.insert(0, gid)


def _cmut_br65(r):
    # Add a product classification (ram:DesignatedProductClassification/
    # ram:ClassCode) with NO @listID: normalize-space(@listID) = '' fires
    # BR-65; BR-CL-13 has no attribute value to check.
    prod = _cii_first_line(r).find("ram:SpecifiedTradeProduct", _NSC)
    dpc = ET.SubElement(prod, _cq(NS_RAM, "DesignatedProductClassification"))
    ET.SubElement(dpc, _cq(NS_RAM, "ClassCode")).text = "9873242"


def _cmut_brco03(r):
    # Provide BOTH the VAT point date (BT-7, ram:TaxPointDate) and the VAT
    # point date code (BT-8, ram:DueDateTypeCode) on the first document-level
    # VAT breakdown row: the //-global mutual-exclusion test fails on every
    # breakdown row.
    tt = _cii_settlement(r).find("ram:ApplicableTradeTax", _NSC)
    tpd = ET.SubElement(tt, _cq(NS_RAM, "TaxPointDate"))
    ds = ET.SubElement(tpd, _cq(NS_UDT, "DateString"))
    ds.set("format", "102")
    ds.text = "20181206"
    ET.SubElement(tt, _cq(NS_RAM, "DueDateTypeCode")).text = "35"


def _cmut_brco09(r):
    # Give the Seller VAT identifier (BT-31, the VA-scheme registration id) the
    # prefix 'XX' — not a token of the official CII prefix string, so the
    # space-wrapped contains() fails.
    for id_el in _cii_seller(r).findall(
            "ram:SpecifiedTaxRegistration/ram:ID", _NSC):
        if id_el.get("schemeID") == "VA":
            id_el.text = "XX8200.98.395.B.01"


def _cmut_brco19(r):
    # Add an EMPTY document-level Invoicing period (BG-14,
    # ram:BillingSpecifiedPeriod): with neither StartDateTime nor EndDateTime,
    # BR-CO-19 fires (BR-29 holds — nothing to compare).
    settle = _cii_settlement(r)
    settle.append(ET.Element(_cq(NS_RAM, "BillingSpecifiedPeriod")))


# ---- Core/decimals/VAT gap batch A (CII side) ------------------------------- #
# (BR-CO-20/21/22/23/24/26, BR-DEC-24/25/27/28, BR-IC-10, BR-S-08)
def _cmut_brco20(r):
    # Add an EMPTY line billing period (BG-26) to the first line's
    # SpecifiedLineTradeSettlement: with neither StartDateTime nor
    # EndDateTime, BR-CO-20 fires (the header BG-14 period is untouched).
    ET.SubElement(
        _cii_first_line(r).find("ram:SpecifiedLineTradeSettlement", _NSC),
        _cq(NS_RAM, "BillingSpecifiedPeriod"))


def _cadd_bare_allowance_charge(r, charge):
    """Append a document SpecifiedTradeAllowanceCharge with ActualAmount 0.00
    and NO Reason/ReasonCode: the target BR-CO-21/22 fires (its ungraded
    BR-33/BR-38 twin fires officially too); the zero amount and the absent
    CategoryTradeTax keep every graded arithmetic and BR-S-08 bucket sum
    unchanged."""
    settle = _cii_settlement(r)
    ac = ET.SubElement(settle, _cq(NS_RAM, "SpecifiedTradeAllowanceCharge"))
    ind = ET.SubElement(ac, _cq(NS_RAM, "ChargeIndicator"))
    ET.SubElement(ind, _cq(NS_UDT, "Indicator")).text = (
        "true" if charge else "false")
    ET.SubElement(ac, _cq(NS_RAM, "ActualAmount")).text = "0.00"


def _cmut_brco21(r):
    _cadd_bare_allowance_charge(r, charge=False)


def _cmut_brco22(r):
    _cadd_bare_allowance_charge(r, charge=True)


def _cadd_line_allowance_charge(r, charge, amount="0.00", base=None,
                                reason=None):
    """Append a LINE-level ram:SpecifiedTradeAllowanceCharge (BG-27/BG-28) to
    the first line. Line allowances feed no graded arithmetic (the line's
    LineTotalAmount is untouched) and carry no CategoryTradeTax here, so only
    the reason (BR-CO-23/24) and decimal (BR-DEC-24/25/27/28) rules react."""
    settle = _cii_first_line(r).find("ram:SpecifiedLineTradeSettlement", _NSC)
    ac = ET.SubElement(settle, _cq(NS_RAM, "SpecifiedTradeAllowanceCharge"))
    ind = ET.SubElement(ac, _cq(NS_RAM, "ChargeIndicator"))
    ET.SubElement(ind, _cq(NS_UDT, "Indicator")).text = (
        "true" if charge else "false")
    if base is not None:
        ET.SubElement(ac, _cq(NS_RAM, "BasisAmount")).text = base
    ET.SubElement(ac, _cq(NS_RAM, "ActualAmount")).text = amount
    if reason is not None:
        ET.SubElement(ac, _cq(NS_RAM, "Reason")).text = reason


def _cmut_brco23(r):
    _cadd_line_allowance_charge(r, charge=False)


def _cmut_brco24(r):
    _cadd_line_allowance_charge(r, charge=True)


def _cmut_brdec24(r):
    _cadd_line_allowance_charge(r, charge=False, amount="1.123",
                                reason="Discount")


def _cmut_brdec25(r):
    _cadd_line_allowance_charge(r, charge=False, amount="1.12", base="10.123",
                                reason="Discount")


def _cmut_brdec27(r):
    _cadd_line_allowance_charge(r, charge=True, amount="1.123",
                                reason="Freight")


def _cmut_brdec28(r):
    _cadd_line_allowance_charge(r, charge=True, amount="1.12", base="10.123",
                                reason="Freight")


def _cmut_brco26(r):
    # Strip every Seller identifier the CII BR-CO-26 accepts: the base seller
    # carries a SpecifiedLegalOrganization/ID and a VA SpecifiedTaxRegistration
    # (no ram:ID / ram:GlobalID), so removing those two groups fires BR-CO-26.
    # The S-rated lines then also lack a seller VA/FC id -> BR-S-02 fires
    # alongside on both engines; BR-CO-09's context vanishes with the VA id.
    seller = _cii_seller(r)
    _cii_remove(r, seller.find("ram:SpecifiedLegalOrganization", _NSC))
    _cii_remove(r, seller.find("ram:SpecifiedTaxRegistration", _NSC))


def _cmut_bric10(r):
    # Add an Intra-community (K) VAT breakdown row with NO exemption reason:
    # BR-IC-10 fires. Amounts are 0.00 so the graded arithmetic (BR-CO-17)
    # holds; the official also fires the CII-ungraded BR-IC-01/-11/-12
    # cascade, which the leg does not grade.
    settle = _cii_settlement(r)
    first = settle.find("ram:ApplicableTradeTax", _NSC)
    tt = ET.Element(_cq(NS_RAM, "ApplicableTradeTax"))
    ET.SubElement(tt, _cq(NS_RAM, "CalculatedAmount")).text = "0.00"
    ET.SubElement(tt, _cq(NS_RAM, "TypeCode")).text = "VAT"
    ET.SubElement(tt, _cq(NS_RAM, "BasisAmount")).text = "0.00"
    ET.SubElement(tt, _cq(NS_RAM, "CategoryCode")).text = "K"
    ET.SubElement(tt, _cq(NS_RAM, "RateApplicablePercent")).text = "0"
    settle.insert(list(settle).index(first), tt)


def _cmut_brs08(r):
    # Shift the first S breakdown's BasisAmount (6%: 183.23) by +2: the CII
    # BR-S-08 EXACT per-rate bucket equality breaks, while the tax amount
    # stays only 0.12 off taxable x 6% — inside the ±1 bands of BR-CO-17 and
    # BR-S-09 — so BR-S-08 is the only graded rule that fires.
    _cii_first_breakdown(r).find("ram:BasisAmount", _NSC).text = "185.23"


# ---- IGIC (BR-AF-*) mutations, CII bindings --------------------------------- #
def _c_to_igic(r):
    """Flip every Standard-rated (S) ram:CategoryCode in the transaction to L
    — the 20 line ApplicableTradeTax rows AND the two header VAT breakdown
    rows — turning CII_example1 into a clean IGIC invoice: the 6/21 rates
    satisfy the CII ``RateApplicablePercent > 0`` predicate, the per-rate
    bucket sums and tax amounts are untouched, and no S rule applies."""
    txn = r.find("rsm:SupplyChainTradeTransaction", _NSC)
    for cc in txn.iter(_cq(NS_RAM, "CategoryCode")):
        if cc.text == "S":
            cc.text = "L"


def _cadd_igic_allowance_charge(r, charge, rate):
    """Append a document SpecifiedTradeAllowanceCharge carrying an IGIC (L)
    CategoryTradeTax at ``rate``. ActualAmount 0.00 keeps every graded
    arithmetic (BR-CO-13, the S bucket sums) unchanged; the Reason satisfies
    BR-CO-21/22. With no L header breakdown row, the official weak-count
    BR-AF-01 fires alongside on the L-item side — as does ours — so
    agreement holds per rule."""
    settle = _cii_settlement(r)
    ac = ET.SubElement(settle, _cq(NS_RAM, "SpecifiedTradeAllowanceCharge"))
    ind = ET.SubElement(ac, _cq(NS_RAM, "ChargeIndicator"))
    ET.SubElement(ind, _cq(NS_UDT, "Indicator")).text = (
        "true" if charge else "false")
    ET.SubElement(ac, _cq(NS_RAM, "ActualAmount")).text = "0.00"
    ET.SubElement(ac, _cq(NS_RAM, "Reason")).text = (
        "Freight" if charge else "Discount")
    ctt = ET.SubElement(ac, _cq(NS_RAM, "CategoryTradeTax"))
    ET.SubElement(ctt, _cq(NS_RAM, "TypeCode")).text = "VAT"
    ET.SubElement(ctt, _cq(NS_RAM, "CategoryCode")).text = "L"
    ET.SubElement(ctt, _cq(NS_RAM, "RateApplicablePercent")).text = rate


def _cmut_braf01(r):
    # Flip exactly ONE line's CategoryCode S -> L, breakdowns stay S: the
    # official weak-count test (line-L + header-L counts >= 2 or no line L)
    # sees 1 < 2 and FIRES — the one CII configuration where its verdict
    # matches the UBL biconditional. The flipped line leaves its S/6 bucket,
    # so BR-S-08 fires alongside on both engines.
    _cii_line_tax(r).find("ram:CategoryCode", _NSC).text = "L"


def _cmut_braf02(r):
    # All-L invoice + no Seller VA/FC tax registration -> BR-AF-02.
    _c_to_igic(r)
    _cii_remove(r, _cii_seller(r).find("ram:SpecifiedTaxRegistration", _NSC))


def _cmut_braf03(r):
    # Document allowance with an IGIC CategoryTradeTax (rate 21 > 0) + no
    # Seller VA/FC registration -> BR-AF-03 (BR-S-02 fires alongside: the
    # S lines also lose the seller id; BR-AF-01 fires on the orphan L
    # allowance side — both engines agree on each).
    _cadd_igic_allowance_charge(r, charge=False, rate="21")
    _cii_remove(r, _cii_seller(r).find("ram:SpecifiedTaxRegistration", _NSC))


def _cmut_braf04(r):
    # Document charge with an IGIC CategoryTradeTax + no Seller registration
    # -> BR-AF-04 (same alongside-set as BR-AF-03).
    _cadd_igic_allowance_charge(r, charge=True, rate="21")
    _cii_remove(r, _cii_seller(r).find("ram:SpecifiedTaxRegistration", _NSC))


def _cmut_braf05(r):
    # All-L invoice with the first line's VAT rate set to 0: the CII binding
    # requires RateApplicablePercent > 0 (unlike UBL's >= 0), so BR-AF-05
    # fires. The line also leaves its L/6 bucket, which only OUR (CII-ungraded)
    # BR-AF-08 notices — the official artifact's BR-AF-08 binding is vacuous.
    _c_to_igic(r)
    _cii_line_tax(r).find("ram:RateApplicablePercent", _NSC).text = "0"


def _cmut_braf06(r):
    # Document allowance with an IGIC CategoryTradeTax at rate 0 -> BR-AF-06
    # (CII requires > 0); BR-AF-01 fires alongside (orphan L allowance).
    _cadd_igic_allowance_charge(r, charge=False, rate="0")


def _cmut_braf07(r):
    # Document charge with an IGIC CategoryTradeTax at rate 0 -> BR-AF-07.
    _cadd_igic_allowance_charge(r, charge=True, rate="0")


def _cmut_braf10(r):
    # All-L invoice whose first L breakdown carries a VAT exemption reason
    # -> BR-AF-10.
    _c_to_igic(r)
    bd = _cii_first_breakdown(r)
    rate = bd.find("ram:RateApplicablePercent", _NSC)
    reason = ET.Element(_cq(NS_RAM, "ExemptionReason"))
    reason.text = "n/a"
    bd.insert(list(bd).index(rate), reason)


# ---- IPSI (BR-AG-*) mutations, CII bindings --------------------------------- #
def _c_to_ipsi(r):
    """Flip every Standard-rated (S) ram:CategoryCode in the transaction to M
    — the 20 line ApplicableTradeTax rows AND the two header VAT breakdown
    rows — turning CII_example1 into a clean IPSI invoice: the 6/21 rates
    satisfy the CII ``RateApplicablePercent >= 0`` predicate, the per-rate
    bucket sums and tax amounts are untouched, and no S rule applies."""
    txn = r.find("rsm:SupplyChainTradeTransaction", _NSC)
    for cc in txn.iter(_cq(NS_RAM, "CategoryCode")):
        if cc.text == "S":
            cc.text = "M"


def _cadd_ipsi_allowance_charge(r, charge, rate):
    """Append a document SpecifiedTradeAllowanceCharge carrying an IPSI (M)
    CategoryTradeTax at ``rate``. ActualAmount 0.00 keeps every graded
    arithmetic (BR-CO-13, the S bucket sums) unchanged; the Reason satisfies
    BR-CO-21/22. With no M header breakdown row, the official weak-count
    BR-AG-01 fires alongside on the M-item side — as does ours — so
    agreement holds per rule."""
    settle = _cii_settlement(r)
    ac = ET.SubElement(settle, _cq(NS_RAM, "SpecifiedTradeAllowanceCharge"))
    ind = ET.SubElement(ac, _cq(NS_RAM, "ChargeIndicator"))
    ET.SubElement(ind, _cq(NS_UDT, "Indicator")).text = (
        "true" if charge else "false")
    ET.SubElement(ac, _cq(NS_RAM, "ActualAmount")).text = "0.00"
    ET.SubElement(ac, _cq(NS_RAM, "Reason")).text = (
        "Freight" if charge else "Discount")
    ctt = ET.SubElement(ac, _cq(NS_RAM, "CategoryTradeTax"))
    ET.SubElement(ctt, _cq(NS_RAM, "TypeCode")).text = "VAT"
    ET.SubElement(ctt, _cq(NS_RAM, "CategoryCode")).text = "M"
    ET.SubElement(ctt, _cq(NS_RAM, "RateApplicablePercent")).text = rate


def _cmut_brag01(r):
    # Flip exactly ONE line's CategoryCode S -> M, breakdowns stay S: the
    # official weak-count test (line-M + header-M counts >= 2 or no line M)
    # sees 1 < 2 and FIRES — the one CII configuration where its verdict
    # matches the UBL biconditional. The flipped line leaves its S/6 bucket,
    # so BR-S-08 fires alongside on both engines.
    _cii_line_tax(r).find("ram:CategoryCode", _NSC).text = "M"


def _cmut_brag02(r):
    # All-M invoice + no Seller VA/FC tax registration -> BR-AG-02.
    _c_to_ipsi(r)
    _cii_remove(r, _cii_seller(r).find("ram:SpecifiedTaxRegistration", _NSC))


def _cmut_brag03(r):
    # Document allowance with an IPSI CategoryTradeTax (rate 21 >= 0) + no
    # Seller VA/FC registration -> BR-AG-03 (BR-S-02 fires alongside: the
    # S lines also lose the seller id; BR-AG-01 fires on the orphan M
    # allowance side — both engines agree on each).
    _cadd_ipsi_allowance_charge(r, charge=False, rate="21")
    _cii_remove(r, _cii_seller(r).find("ram:SpecifiedTaxRegistration", _NSC))


def _cmut_brag04(r):
    # Document charge with an IPSI CategoryTradeTax + no Seller registration
    # -> BR-AG-04 (same alongside-set as BR-AG-03).
    _cadd_ipsi_allowance_charge(r, charge=True, rate="21")
    _cii_remove(r, _cii_seller(r).find("ram:SpecifiedTaxRegistration", _NSC))


def _cmut_brag05(r):
    # All-M invoice with the first line's VAT rate set to -5: the CII BR-AG
    # binding requires RateApplicablePercent >= 0 (the SAME predicate as UBL,
    # unlike BR-AF's CII-strict > 0 — a zero rate would HOLD here), so
    # BR-AG-05 fires. The line also leaves its M/6 bucket, which only OUR
    # (CII-ungraded) BR-AG-08 notices — the official artifact's BR-AG-08
    # binding is vacuous.
    _c_to_ipsi(r)
    _cii_line_tax(r).find("ram:RateApplicablePercent", _NSC).text = "-5"


def _cmut_brag06(r):
    # Document allowance with an IPSI CategoryTradeTax at rate -5 -> BR-AG-06
    # (>= 0 fails; rate 0 would hold, unlike BR-AF-06 on CII); BR-AG-01 fires
    # alongside (orphan M allowance).
    _cadd_ipsi_allowance_charge(r, charge=False, rate="-5")


def _cmut_brag07(r):
    # Document charge with an IPSI CategoryTradeTax at rate -5 -> BR-AG-07.
    _cadd_ipsi_allowance_charge(r, charge=True, rate="-5")


def _cmut_brag10(r):
    # All-M invoice whose first M breakdown carries a VAT exemption reason
    # -> BR-AG-10.
    _c_to_ipsi(r)
    bd = _cii_first_breakdown(r)
    rate = bd.find("ram:RateApplicablePercent", _NSC)
    reason = ET.Element(_cq(NS_RAM, "ExemptionReason"))
    reason.text = "n/a"
    bd.insert(list(bd).index(rate), reason)


# ---- Italian split payment (BR-B-*) mutations, CII bindings ----------------- #
def _cmut_brb01(r):
    # Flip every S CategoryCode to B (20 lines + 2 header rows): a
    # split-payment invoice whose two ram:CountryID elements are 'NL'
    # (CII_example1 is Dutch), so not(//ram:CountryID != 'IT') fails ->
    # BR-B-01 fires on both engines. No 'S' remains (BR-B-02 and the BR-S
    # family stay quiet) and 'B' is UNCL 5305-valid.
    txn = r.find("rsm:SupplyChainTradeTransaction", _NSC)
    for cc in txn.iter(_cq(NS_RAM, "CategoryCode")):
        if cc.text == "S":
            cc.text = "B"


def _cmut_brb02(r):
    # Flip ONE line's CategoryCode S -> B: 'B' and 'S' now coexist in
    # //ram:CategoryCode -> BR-B-02 fires; BR-B-01 fires alongside (B + the
    # NL countries), as does BR-S-08 (the flipped line leaves its S/6
    # bucket) — on both engines alike.
    _cii_line_tax(r).find("ram:CategoryCode", _NSC).text = "B"


_CII_MUTATIONS = {
    "BR-01": _cmut_br01, "BR-02": _cmut_br02, "BR-03": _cmut_br03,
    "BR-04": _cmut_br04, "BR-05": _cmut_br05, "BR-06": _cmut_br06,
    "BR-07": _cmut_br07, "BR-08": _cmut_br08, "BR-10": _cmut_br10,
    "BR-12": _cmut_br12, "BR-13": _cmut_br13, "BR-14": _cmut_br14,
    "BR-15": _cmut_br15, "BR-16": _cmut_br16,
    "BR-21": _cmut_br21, "BR-22": _cmut_br22, "BR-23": _cmut_br23,
    "BR-24": _cmut_br24,
    "BR-25": _cmut_br25, "BR-26": _cmut_br26, "BR-27": _cmut_br27,
    "BR-52": _cmut_br52, "BR-53": _cmut_br53, "BR-54": _cmut_br54,
    "BR-56": _cmut_br56, "BR-64": _cmut_br64, "BR-65": _cmut_br65,
    "BR-CO-03": _cmut_brco03, "BR-CO-09": _cmut_brco09,
    "BR-CO-19": _cmut_brco19,
    "BR-CO-20": _cmut_brco20, "BR-CO-21": _cmut_brco21,
    "BR-CO-22": _cmut_brco22, "BR-CO-23": _cmut_brco23,
    "BR-CO-24": _cmut_brco24, "BR-CO-26": _cmut_brco26,
    "BR-IC-10": _cmut_bric10, "BR-S-08": _cmut_brs08,
    "BR-AF-01": _cmut_braf01, "BR-AF-02": _cmut_braf02, "BR-AF-03": _cmut_braf03,
    "BR-AF-04": _cmut_braf04, "BR-AF-05": _cmut_braf05, "BR-AF-06": _cmut_braf06,
    "BR-AF-07": _cmut_braf07, "BR-AF-10": _cmut_braf10,
    "BR-AG-01": _cmut_brag01, "BR-AG-02": _cmut_brag02, "BR-AG-03": _cmut_brag03,
    "BR-AG-04": _cmut_brag04, "BR-AG-05": _cmut_brag05, "BR-AG-06": _cmut_brag06,
    "BR-AG-07": _cmut_brag07, "BR-AG-10": _cmut_brag10,
    "BR-B-01": _cmut_brb01, "BR-B-02": _cmut_brb02,
    "BR-DEC-24": _cmut_brdec24, "BR-DEC-25": _cmut_brdec25,
    "BR-DEC-27": _cmut_brdec27, "BR-DEC-28": _cmut_brdec28,
    "BR-CL-01": _cmut_brcl01,
    "BR-CL-03": _cmut_brcl03, "BR-CL-04": _cmut_brcl04, "BR-CL-05": _cmut_brcl05,
    "BR-CL-13": _cmut_brcl13, "BR-CL-14": _cmut_brcl14,
    "BR-CL-16": _cmut_brcl16,
    "BR-CL-17": _cmut_brcl17, "BR-CL-18": _cmut_brcl18,
    "BR-CL-19": _cmut_brcl19, "BR-CL-20": _cmut_brcl20, "BR-CL-21": _cmut_brcl21,
    "BR-CL-22": _cmut_brcl22,
    "BR-CL-23": _cmut_brcl23, "BR-CL-24": _cmut_brcl24,
    "BR-CO-04": _cmut_brco04,
    "BR-CO-10": _cmut_brco10, "BR-CO-13": _cmut_brco13,
    "BR-CO-16": _cmut_brco16, "BR-CO-17": _cmut_brco17,
    "BR-CO-18": _cmut_brco18,
    "BR-45": _cmut_br45, "BR-46": _cmut_br46, "BR-47": _cmut_br47,
    "BR-48": _cmut_br48,
    "BR-S-02": _cmut_brs02, "BR-S-05": _cmut_brs05,
    "BR-S-09": _cmut_brs09, "BR-S-10": _cmut_brs10,
    "BR-DEC-09": _cmut_brdec09, "BR-DEC-12": _cmut_brdec12,
    "BR-DEC-14": _cmut_brdec14, "BR-DEC-18": _cmut_brdec18,
    "BR-DEC-19": _cmut_brdec19, "BR-DEC-20": _cmut_brdec20,
    "BR-DEC-23": _cmut_brdec23,
}
# Every entry above breaks exactly one graded rule's field off the clean S-rated
# CII base; several also fire other graded rules (e.g. a broken breakdown amount
# fires BR-CO-17 AND BR-S-09) — agreement is asserted PER RULE, so that is fine.


def _gather_cii_examples():
    """(label, abs_path) for every vendored CEN CII example invoice."""
    out = []
    if not os.path.isdir(CII_EXAMPLES_DIR):
        return out
    for name in sorted(os.listdir(CII_EXAMPLES_DIR)):
        if not name.lower().endswith(".xml"):
            continue
        p = os.path.join(CII_EXAMPLES_DIR, name)
        try:
            root = ET.parse(p).getroot()
        except ET.ParseError:
            continue
        if _localname(root.tag) != "CrossIndustryInvoice":
            continue
        out.append(("cii-ex/%s" % name, p))
    return out


def _gather_cii_mutations(scratch: str):
    """One generated CII invoice per graded rule, each breaking that rule's field."""
    base_root = ET.parse(_CII_BASE).getroot()
    # A few rules guard a document part CII_example1 does not contain (e.g.
    # BR-CL-17's context ram:CategoryTradeTax lives only on a document-level
    # allowance/charge). For those we mutate a DIFFERENT known-valid CEN example
    # that DOES carry the part, so the only new violation is the target rule.
    base_cache = {}
    dst = os.path.join(scratch, "cii-mutations")
    os.makedirs(dst, exist_ok=True)
    out = []
    for rid in CII_RULE_IDS:
        mut = _CII_MUTATIONS.get(rid)
        if mut is None:
            continue
        base_path = _CII_MUTATION_BASE.get(rid, _CII_BASE)
        if base_path not in base_cache:
            base_cache[base_path] = ET.parse(base_path).getroot()
        base_root = base_cache[base_path]
        root = copy.deepcopy(base_root)
        try:
            mut(root)
        except Exception as e:  # pragma: no cover
            print("  [CII mutation %s FAILED to build: %s]" % (rid, e),
                  file=sys.stderr)
            continue
        out_path = os.path.join(dst, "cmut_%s.xml" % rid.replace("-", "_"))
        _write_cii_doc(root, out_path)
        out.append(("CIIMUT/%s" % rid, out_path))
    return out


def build_cii_corpus(scratch: str):
    """Corpus for the CII leg: the CEN CII examples + one mutation per graded rule."""
    entries = []
    entries += _gather_cii_examples()
    entries += _gather_cii_mutations(scratch)
    seen, uniq = set(), []
    for label, path in entries:
        key = os.path.abspath(path)
        if key in seen:
            continue
        seen.add(key)
        uniq.append((label, path))
    return uniq


# --------------------------------------------------------------------------- #
# XRechnung-CII (BR-DE-*) corpus + targeted mutations.                          #
#                                                                              #
# Corpus = the CEN CII examples + every real German XRechnung CII invoice in the #
# xrechnung-testsuite (the *_uncefact.xml CrossIndustryInvoice files — the       #
# adversarial real-world sample) + one generated mutation per admitted BR-DE     #
# rule, each breaking exactly the CII field that rule guards, off a known-clean   #
# XRechnung-CII base (01.02a: a standard CIUS invoice that fires NO admitted      #
# BR-DE rule on the official XSLT). Every mutation exercises its rule in the      #
# FAILING direction on both engines.                                            #
# --------------------------------------------------------------------------- #
_XR_CII_BASE = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test",
                            "business-cases", "standard",
                            "01.02a-INVOICE_uncefact.xml")


def _cii_agreement(r):
    return r.find("rsm:SupplyChainTradeTransaction/"
                  "ram:ApplicableHeaderTradeAgreement", _NSC)


def _cii_delivery(r):
    return r.find("rsm:SupplyChainTradeTransaction/"
                  "ram:ApplicableHeaderTradeDelivery", _NSC)


def _cii_seller_contact(r):
    return _cii_seller(r).find("ram:DefinedTradeContact", _NSC)


def _cii_add_shipto_address(r, city=None, zone=None):
    """Add a DELIVER TO ADDRESS (BG-15): a ShipToTradeParty with a
    PostalTradeAddress carrying only the given fields."""
    delivery = _cii_delivery(r)
    shipto = ET.Element(_cq(NS_RAM, "ShipToTradeParty"))
    _sub_el(shipto, NS_RAM, "Name", "[Deliver to name]")
    addr = _sub_el(shipto, NS_RAM, "PostalTradeAddress")
    if zone:
        _sub_el(addr, NS_RAM, "PostcodeCode", zone)
    if city:
        _sub_el(addr, NS_RAM, "CityName", city)
    _sub_el(addr, NS_RAM, "CountryID", "DE")
    delivery.insert(0, shipto)


def _xrcmut_de1(r):
    settle = _cii_settlement(r)
    for pm in settle.findall("ram:SpecifiedTradeSettlementPaymentMeans", _NSC):
        settle.remove(pm)


def _xrcmut_de2(r):
    seller = _cii_seller(r)
    for c in seller.findall("ram:DefinedTradeContact", _NSC):
        seller.remove(c)


def _xrcmut_de3(r):
    a = _cii_seller(r).find("ram:PostalTradeAddress", _NSC)
    _cii_remove(r, a.find("ram:CityName", _NSC))


def _xrcmut_de4(r):
    a = _cii_seller(r).find("ram:PostalTradeAddress", _NSC)
    _cii_remove(r, a.find("ram:PostcodeCode", _NSC))


def _xrcmut_de5(r):
    # Empty the contact point (PersonName + DepartmentName) -> BR-DE-5; tel/email
    # stay so BR-DE-6/7 hold.
    c = _cii_seller_contact(r)
    for local in ("PersonName", "DepartmentName"):
        _cii_remove(r, c.find("ram:%s" % local, _NSC))


def _xrcmut_de6(r):
    # Remove the telephone -> BR-DE-6 AND BR-DE-27 (absent -> '' has no 3 digits).
    c = _cii_seller_contact(r)
    _cii_remove(r, c.find("ram:TelephoneUniversalCommunication", _NSC))


def _xrcmut_de7(r):
    # Remove the email -> BR-DE-7 AND BR-DE-28 (absent -> '' is not an address).
    c = _cii_seller_contact(r)
    _cii_remove(r, c.find("ram:EmailURIUniversalCommunication", _NSC))


def _xrcmut_de8(r):
    a = _cii_buyer(r).find("ram:PostalTradeAddress", _NSC)
    _cii_remove(r, a.find("ram:CityName", _NSC))


def _xrcmut_de9(r):
    a = _cii_buyer(r).find("ram:PostalTradeAddress", _NSC)
    _cii_remove(r, a.find("ram:PostcodeCode", _NSC))


def _xrcmut_de10(r):
    _cii_add_shipto_address(r, zone="12345")   # city missing -> BR-DE-10


def _xrcmut_de11(r):
    _cii_add_shipto_address(r, city="Bremen")  # zone missing -> BR-DE-11


def _xrcmut_de14(r):
    _cii_remove(r, _cii_first_breakdown(r).find(
        "ram:RateApplicablePercent", _NSC))


def _xrcmut_de15(r):
    _cii_remove(r, _cii_agreement(r).find("ram:BuyerReference", _NSC))


def _xrcmut_de16(r):
    # Remove the Seller tax registration (VA id); no tax representative in the
    # base and the line is S-rated -> BR-DE-16 fires.
    seller = _cii_seller(r)
    for tr in seller.findall("ram:SpecifiedTaxRegistration", _NSC):
        seller.remove(tr)


def _xrcmut_de17(r):
    # UNTDID-valid but not XRechnung-allowed type code -> BR-DE-17 (warning).
    r.find("rsm:ExchangedDocument/ram:TypeCode", _NSC).text = "71"


def _xrcmut_de21(r):
    r.find("rsm:ExchangedDocumentContext/"
           "ram:GuidelineSpecifiedDocumentContextParameter/ram:ID",
           _NSC).text = "urn:cen.eu:en16931:2017"


def _xrcmut_de26(r):
    # Type code 384 (Corrected) with no InvoiceReferencedDocument -> BR-DE-26
    # (384 is XRechnung-allowed, so BR-DE-17 stays clear).
    r.find("rsm:ExchangedDocument/ram:TypeCode", _NSC).text = "384"


def _xrcmut_de27(r):
    # Telephone present but with fewer than three digits -> BR-DE-27 (BR-DE-6 holds).
    _cii_seller_contact(r).find(
        "ram:TelephoneUniversalCommunication/ram:CompleteNumber",
        _NSC).text = "kein"


def _xrcmut_de28(r):
    # Email present but without an '@' -> BR-DE-28 (BR-DE-7 holds).
    _cii_seller_contact(r).find(
        "ram:EmailURIUniversalCommunication/ram:URIID",
        _NSC).text = "kein-email-hier"


def _xrcmut_de_tmp32(r):
    # Strip every delivery-date / billing-period source -> BR-DE-TMP-32 fires.
    delivery = _cii_delivery(r)
    if delivery is not None:
        _cii_remove(r, delivery.find(
            "ram:ActualDeliverySupplyChainEvent", _NSC))
    settle = _cii_settlement(r)
    _cii_remove(r, settle.find("ram:BillingSpecifiedPeriod", _NSC))
    for ln in r.findall("rsm:SupplyChainTradeTransaction/"
                        "ram:IncludedSupplyChainTradeLineItem", _NSC):
        _cii_remove(r, ln.find(
            "ram:SpecifiedLineTradeSettlement/ram:BillingSpecifiedPeriod", _NSC))


_XR_CII_MUTATIONS = {
    "BR-DE-1": _xrcmut_de1, "BR-DE-2": _xrcmut_de2, "BR-DE-3": _xrcmut_de3,
    "BR-DE-4": _xrcmut_de4, "BR-DE-5": _xrcmut_de5, "BR-DE-6": _xrcmut_de6,
    "BR-DE-7": _xrcmut_de7, "BR-DE-8": _xrcmut_de8, "BR-DE-9": _xrcmut_de9,
    "BR-DE-10": _xrcmut_de10, "BR-DE-11": _xrcmut_de11, "BR-DE-14": _xrcmut_de14,
    "BR-DE-15": _xrcmut_de15, "BR-DE-16": _xrcmut_de16, "BR-DE-17": _xrcmut_de17,
    "BR-DE-21": _xrcmut_de21, "BR-DE-26": _xrcmut_de26, "BR-DE-27": _xrcmut_de27,
    "BR-DE-28": _xrcmut_de28, "BR-DE-TMP-32": _xrcmut_de_tmp32,
}


# --- PEPPOL-EN16931-R* (CII) targeted mutations, off the clean XR-CII base --- #
def _csub(parent, ns, local, text=None):
    el = ET.SubElement(parent, _cq(ns, local))
    if text is not None:
        el.text = text
    return el


def _pep_cii_add_header_allowance(r, indicator="false", actual=None,
                                  basis=None, percent=None):
    """Append a ram:SpecifiedTradeAllowanceCharge to the header settlement
    (official child order: ChargeIndicator, CalculationPercent, BasisAmount,
    ActualAmount, Reason, CategoryTradeTax), inserted before the monetary
    summation."""
    settle = _cii_settlement(r)
    ac = ET.Element(_cq(NS_RAM, "SpecifiedTradeAllowanceCharge"))
    ci = _csub(ac, NS_RAM, "ChargeIndicator")
    _csub(ci, NS_UDT, "Indicator", indicator)
    if percent is not None:
        _csub(ac, NS_RAM, "CalculationPercent", percent)
    if basis is not None:
        _csub(ac, NS_RAM, "BasisAmount", basis)
    if actual is not None:
        _csub(ac, NS_RAM, "ActualAmount", actual)
    _csub(ac, NS_RAM, "Reason", "Adjustment")
    ctt = _csub(ac, NS_RAM, "CategoryTradeTax")
    _csub(ctt, NS_RAM, "TypeCode", "VAT")
    _csub(ctt, NS_RAM, "CategoryCode", "S")
    _csub(ctt, NS_RAM, "RateApplicablePercent", "19")
    summ = settle.find("ram:SpecifiedTradeSettlementHeaderMonetarySummation",
                       _NSC)
    settle.insert(list(settle).index(summ), ac)


def _pep_cii_add_gross_price(r, indicator, base_delta, actual="1.00"):
    """Add a ram:GrossPriceProductTradePrice (ChargeAmount = net + base_delta,
    with an AppliedTradeAllowanceCharge of ``actual``) to the first line's
    SpecifiedLineTradeAgreement. R046 holds exactly when
    base_delta == Decimal(actual)."""
    from decimal import Decimal
    agr = r.find("rsm:SupplyChainTradeTransaction/"
                 "ram:IncludedSupplyChainTradeLineItem/"
                 "ram:SpecifiedLineTradeAgreement", _NSC)
    net = Decimal(agr.find("ram:NetPriceProductTradePrice/ram:ChargeAmount",
                           _NSC).text)
    gp = ET.Element(_cq(NS_RAM, "GrossPriceProductTradePrice"))
    _csub(gp, NS_RAM, "ChargeAmount", str(net + base_delta))
    atac = _csub(gp, NS_RAM, "AppliedTradeAllowanceCharge")
    ci = _csub(atac, NS_RAM, "ChargeIndicator")
    _csub(ci, NS_UDT, "Indicator", indicator)
    _csub(atac, NS_RAM, "ActualAmount", actual)
    agr.insert(0, gp)


def _pepcmut_r001(r):
    ctx = r.find("rsm:ExchangedDocumentContext", _NSC)
    _cii_remove(r, ctx.find(
        "ram:BusinessProcessSpecifiedDocumentContextParameter", _NSC))


def _pepcmut_r005(r):
    settle = _cii_settlement(r)
    icc = settle.find("ram:InvoiceCurrencyCode", _NSC)
    tcc = ET.Element(_cq(NS_RAM, "TaxCurrencyCode"))
    tcc.text = icc.text  # equal codes -> fires
    settle.insert(list(settle).index(icc), tcc)


def _pepcmut_r008(r):
    exdoc = r.find("rsm:ExchangedDocument", _NSC)
    ET.SubElement(exdoc, _cq(NS_RAM, "IncludedNote"))  # empty element


def _pepcmut_r010(r):
    buyer = _cii_agreement(r).find("ram:BuyerTradeParty", _NSC)
    _cii_remove(r, buyer.find("ram:URIUniversalCommunication", _NSC))


def _pepcmut_r020(r):
    seller = _cii_agreement(r).find("ram:SellerTradeParty", _NSC)
    _cii_remove(r, seller.find("ram:URIUniversalCommunication", _NSC))


def _pepcmut_r040(r):
    _pep_cii_add_header_allowance(r, actual="10.00", basis="100.00",
                                  percent="25")


def _pepcmut_r041(r):
    _pep_cii_add_header_allowance(r, actual="10.00", percent="25")


def _pepcmut_r042(r):
    _pep_cii_add_header_allowance(r, actual="10.00", basis="100.00")


def _pepcmut_r043_1(r):
    _pep_cii_add_header_allowance(r, indicator="TRUE", actual="10.00")


def _pepcmut_r043_2(r):
    from decimal import Decimal
    _pep_cii_add_gross_price(r, "TRUE", Decimal("1.00"))


def _pepcmut_r044(r):
    from decimal import Decimal
    _pep_cii_add_gross_price(r, "true", Decimal("1.00"))


def _pepcmut_r046(r):
    from decimal import Decimal
    _pep_cii_add_gross_price(r, "false", Decimal("5.00"))


# --- batch 2 (R053-R130) helpers + mutations, mirroring the UBL set. The     #
# 01.02a base: one line (BilledQuantity 1 XPP, net ChargeAmount 11.78,        #
# LineTotalAmount 11.78), one EUR TaxTotalAmount 0.82, PaymentMeans TypeCode  #
# 58, one SpecifiedTradePaymentTerms.                                          #
def _pep_cii_add_tax_currency(r, code="USD"):
    """ram:TaxCurrencyCode (BT-6) — schema order puts it BEFORE
    ram:InvoiceCurrencyCode."""
    settle = _cii_settlement(r)
    icc = settle.find("ram:InvoiceCurrencyCode", _NSC)
    tcc = ET.Element(_cq(NS_RAM, "TaxCurrencyCode"))
    tcc.text = code
    settle.insert(list(settle).index(icc), tcc)


def _pep_cii_add_tax_total(r, amount, currency):
    """An additional ram:TaxTotalAmount right after the existing one."""
    summ = _cii_settlement(r).find(
        "ram:SpecifiedTradeSettlementHeaderMonetarySummation", _NSC)
    existing = summ.find("ram:TaxTotalAmount", _NSC)
    tta = ET.Element(_cq(NS_RAM, "TaxTotalAmount"))
    tta.text = amount
    tta.set("currencyID", currency)
    summ.insert(list(summ).index(existing) + 1, tta)


def _pep_cii_period(start, end):
    bsp = ET.Element(_cq(NS_RAM, "BillingSpecifiedPeriod"))
    for tag, val in (("StartDateTime", start), ("EndDateTime", end)):
        if val is not None:
            dt = _csub(bsp, NS_RAM, tag)
            _csub(dt, NS_UDT, "DateTimeString", val).set("format", "102")
    return bsp


def _pep_cii_add_header_period(r, start=None, end=None):
    """Header ram:BillingSpecifiedPeriod (BG-14), before the payment terms."""
    settle = _cii_settlement(r)
    pt = settle.find("ram:SpecifiedTradePaymentTerms", _NSC)
    settle.insert(list(settle).index(pt), _pep_cii_period(start, end))


def _pep_cii_line_settlement(r):
    return r.find("rsm:SupplyChainTradeTransaction/"
                  "ram:IncludedSupplyChainTradeLineItem/"
                  "ram:SpecifiedLineTradeSettlement", _NSC)


def _pep_cii_add_line_period(r, start=None, end=None):
    """Line ram:BillingSpecifiedPeriod (BG-26), after ApplicableTradeTax."""
    ls = _pep_cii_line_settlement(r)
    tax = ls.find("ram:ApplicableTradeTax", _NSC)
    ls.insert(list(ls).index(tax) + 1, _pep_cii_period(start, end))


def _pep_cii_set_type_code(r, code):
    settle = _cii_settlement(r)
    settle.find("ram:SpecifiedTradeSettlementPaymentMeans/ram:TypeCode",
                _NSC).text = code
    return settle


def _pep_cii_add_line_referenced_doc(r, type_code):
    ls = _pep_cii_line_settlement(r)
    ard = _csub(ls, NS_RAM, "AdditionalReferencedDocument")
    _csub(ard, NS_RAM, "IssuerAssignedID", "LINE-OBJ-1")
    _csub(ard, NS_RAM, "TypeCode", type_code)


def _pep_cii_add_basis_quantity(r, value, unit=None):
    """ram:BasisQuantity on the line's NetPriceProductTradePrice (ChargeAmount
    11.78; the line's BilledQuantity is 1 XPP)."""
    npp = r.find("rsm:SupplyChainTradeTransaction/"
                 "ram:IncludedSupplyChainTradeLineItem/"
                 "ram:SpecifiedLineTradeAgreement/"
                 "ram:NetPriceProductTradePrice", _NSC)
    bq = _csub(npp, NS_RAM, "BasisQuantity", value)
    if unit is not None:
        bq.set("unitCode", unit)


def _pepcmut_r053(r):
    # A SECOND EUR TaxTotalAmount -> count(currency == BT-5) = 2 > 1.
    _pep_cii_add_tax_total(r, "0.82", "EUR")


def _pepcmut_r054(r):
    # BT-6 present, no non-EUR TaxTotalAmount -> count 0 != 1. (R055 also
    # fires officially: no tax-currency total exists at all.)
    _pep_cii_add_tax_currency(r)


def _pepcmut_r054_ok(r):
    # Engaged holds: BT-6 + exactly one USD total, same sign as the EUR one.
    _pep_cii_add_tax_currency(r)
    _pep_cii_add_tax_total(r, "0.90", "USD")


def _pepcmut_r055(r):
    # Sign flip: USD total negative, EUR total positive -> only R055 fires.
    _pep_cii_add_tax_currency(r)
    _pep_cii_add_tax_total(r, "-0.82", "USD")


def _pepcmut_r061(r):
    # Direct debit (59) without ram:DirectDebitMandateID.
    _pep_cii_set_type_code(r, "59")


def _pepcmut_r061_ok(r):
    settle = _pep_cii_set_type_code(r, "59")
    pt = settle.find("ram:SpecifiedTradePaymentTerms", _NSC)
    _csub(pt, NS_RAM, "DirectDebitMandateID", "MANDATE-1")


def _pepcmut_r101(r):
    _pep_cii_add_line_referenced_doc(r, "916")  # only '130' is allowed


def _pepcmut_r101_ok(r):
    _pep_cii_add_line_referenced_doc(r, "130")


def _pepcmut_r110(r):
    # Line period starts BEFORE the header period start.
    _pep_cii_add_header_period(r, start="20160201")
    _pep_cii_add_line_period(r, start="20160101")


def _pepcmut_r111(r):
    # Line period ends AFTER the header period end.
    _pep_cii_add_header_period(r, end="20160630")
    _pep_cii_add_line_period(r, end="20161231")


def _pepcmut_r110_111_ok(r):
    # Engaged holds: the line period lies within the header period.
    _pep_cii_add_header_period(r, start="20160101", end="20161231")
    _pep_cii_add_line_period(r, start="20160601", end="20160630")


def _pepcmut_r120(r):
    # LineTotalAmount off by 10.00 from qty*(price/base) = 11.78.
    ms = _pep_cii_line_settlement(r).find(
        "ram:SpecifiedTradeSettlementLineMonetarySummation", _NSC)
    ms.find("ram:LineTotalAmount", _NSC).text = "21.78"


def _pepcmut_r121(r):
    _pep_cii_add_basis_quantity(r, "0")  # 0 is not > 0; R120's base -> 1


def _pepcmut_r121_ok(r):
    _pep_cii_add_basis_quantity(r, "1")


def _pepcmut_r130(r):
    # unitCode KGM != the line's BilledQuantity unitCode XPP.
    _pep_cii_add_basis_quantity(r, "1", unit="KGM")


def _pepcmut_r130_ok(r):
    _pep_cii_add_basis_quantity(r, "1", unit="XPP")


_PEPPOL_CII_MUTATIONS = [
    ("PEPPOL-R001", _pepcmut_r001), ("PEPPOL-R005", _pepcmut_r005),
    ("PEPPOL-R008", _pepcmut_r008), ("PEPPOL-R010", _pepcmut_r010),
    ("PEPPOL-R020", _pepcmut_r020), ("PEPPOL-R040", _pepcmut_r040),
    ("PEPPOL-R041", _pepcmut_r041), ("PEPPOL-R042", _pepcmut_r042),
    ("PEPPOL-R043-1", _pepcmut_r043_1), ("PEPPOL-R043-2", _pepcmut_r043_2),
    ("PEPPOL-R044", _pepcmut_r044), ("PEPPOL-R046", _pepcmut_r046),
    ("PEPPOL-R053", _pepcmut_r053), ("PEPPOL-R054", _pepcmut_r054),
    ("PEPPOL-R054-OK", _pepcmut_r054_ok), ("PEPPOL-R055", _pepcmut_r055),
    ("PEPPOL-R061", _pepcmut_r061), ("PEPPOL-R061-OK", _pepcmut_r061_ok),
    ("PEPPOL-R101", _pepcmut_r101), ("PEPPOL-R101-OK", _pepcmut_r101_ok),
    ("PEPPOL-R110", _pepcmut_r110), ("PEPPOL-R111", _pepcmut_r111),
    ("PEPPOL-R110-111-OK", _pepcmut_r110_111_ok),
    ("PEPPOL-R120", _pepcmut_r120), ("PEPPOL-R121", _pepcmut_r121),
    ("PEPPOL-R121-OK", _pepcmut_r121_ok), ("PEPPOL-R130", _pepcmut_r130),
    ("PEPPOL-R130-OK", _pepcmut_r130_ok),
]


def _gather_peppol_cii_mutations(scratch: str):
    """One generated CII invoice per implemented PEPPOL-EN16931-R* assert, off
    the clean XRechnung-CII base."""
    base_root = ET.parse(_XR_CII_BASE).getroot()
    dst = os.path.join(scratch, "peppol-cii-mutations")
    os.makedirs(dst, exist_ok=True)
    out = []
    for name, mut in _PEPPOL_CII_MUTATIONS:
        root = copy.deepcopy(base_root)
        try:
            mut(root)
        except Exception as e:  # pragma: no cover
            print("  [PEPPOL-CII mutation %s FAILED to build: %s]" % (name, e),
                  file=sys.stderr)
            continue
        out_path = os.path.join(dst, "pepcmut_%s.xml" % name.replace("-", "_"))
        _write_cii_doc(root, out_path)
        out.append(("PEPCIIMUT/%s" % name, out_path))
    return out


def _gather_xr_cii_reals():
    """(label, path) for the CEN CII examples + every real XRechnung CII invoice
    (*_uncefact.xml) in the xrechnung-testsuite — the adversarial real sample."""
    out = list(_gather_cii_examples())
    xr = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test")
    if os.path.isdir(xr):
        for dirpath, _dirs, files in os.walk(xr):
            for name in sorted(files):
                if not name.lower().endswith("uncefact.xml"):
                    continue
                p = os.path.join(dirpath, name)
                try:
                    root = ET.parse(p).getroot()
                except ET.ParseError:
                    continue
                if _localname(root.tag) != "CrossIndustryInvoice":
                    continue
                out.append(("xr-cii/%s" % os.path.relpath(p, xr), p))
    return out


def _gather_xr_cii_mutations(scratch: str):
    """One generated CII invoice per admitted BR-DE rule, each breaking that
    rule's field off the clean XRechnung-CII base."""
    base_root = ET.parse(_XR_CII_BASE).getroot()
    dst = os.path.join(scratch, "xr-cii-mutations")
    os.makedirs(dst, exist_ok=True)
    out = []
    for rid in CII_XR_RULE_IDS:
        mut = _XR_CII_MUTATIONS.get(rid)
        if mut is None:
            continue
        root = copy.deepcopy(base_root)
        try:
            mut(root)
        except Exception as e:  # pragma: no cover
            print("  [XR-CII mutation %s FAILED to build: %s]" % (rid, e),
                  file=sys.stderr)
            continue
        out_path = os.path.join(dst, "xrcmut_%s.xml" % rid.replace("-", "_"))
        _write_cii_doc(root, out_path)
        out.append(("XRCIIMUT/%s" % rid, out_path))
    return out


def build_xr_cii_corpus(scratch: str):
    """Corpus for the XRechnung-CII leg: CEN CII examples + real XRechnung CII
    invoices + one BR-DE mutation per admitted rule + one PEPPOL-EN16931-R*
    mutation per implemented assert."""
    entries = []
    entries += _gather_xr_cii_reals()
    entries += _gather_xr_cii_mutations(scratch)
    entries += _gather_peppol_cii_mutations(scratch)
    seen, uniq = set(), []
    for label, path in entries:
        key = os.path.abspath(path)
        if key in seen:
            continue
        seen.add(key)
        uniq.append((label, path))
    return uniq


def build_corpus(scratch: str):
    entries = []
    entries += _gather_bare_invoices()
    entries += _split_cen_testsets(scratch)
    entries += _gather_mutations(scratch)
    # De-dup by resolved path.
    seen, uniq = set(), []
    for label, path in entries:
        key = os.path.abspath(path)
        if key in seen:
            continue
        seen.add(key)
        uniq.append((label, path))
    return uniq


def build_xr_corpus(scratch: str):
    """Corpus for the XRechnung leg: everything real (incl. the split CEN
    unit fragments — adversarial for the presence rules) + BR-DE mutations,
    but NOT the EN-targeted mutations (they exercise core rules)."""
    entries = []
    entries += _gather_bare_invoices()
    entries += _split_cen_testsets(scratch)
    entries += _gather_xr_mutations(scratch)
    entries += _gather_xr_ext_mutations(scratch)
    entries += _gather_peppol_mutations(scratch)
    seen, uniq = set(), []
    for label, path in entries:
        key = os.path.abspath(path)
        if key in seen:
            continue
        seen.add(key)
        uniq.append((label, path))
    return uniq


# --------------------------------------------------------------------------- #
# Full differential run (one "leg" per official ruleset).
# --------------------------------------------------------------------------- #
def _run_leg(title, xslt_path, rule_ids, our_fn, corpus):
    """Grade one official-vs-ours leg. Returns the divergence count."""
    rule_set = set(rule_ids)
    print("  restricting comparison to OUR %d implemented rules:" % len(rule_ids))
    print("    " + ", ".join(rule_ids))
    print()

    official = Official(xslt_path)

    # Per-rule tallies.
    agree = {r: 0 for r in rule_ids}          # verdicts that match
    both_fire = {r: 0 for r in rule_ids}      # true-positive agreements
    both_clear = {r: 0 for r in rule_ids}     # true-negative agreements
    false_pos = {r: [] for r in rule_ids}     # we fire, official doesn't
    misses = {r: [] for r in rule_ids}        # official fires, we don't

    errors = []
    graded = 0

    for label, path in corpus:
        try:
            off = official.fired(path) & rule_set
        except Exception as e:
            errors.append((label, "OFFICIAL", str(e)[:160]))
            continue
        try:
            ours = our_fn(path) & rule_set
        except NotWellFormed as e:
            errors.append((label, "OURS(not-well-formed)", str(e)[:160]))
            continue
        except Exception as e:
            errors.append((label, "OURS", str(e)[:160]))
            continue

        graded += 1
        for r in rule_ids:
            o, u = (r in off), (r in ours)
            if o and u:
                agree[r] += 1
                both_fire[r] += 1
            elif not o and not u:
                agree[r] += 1
                both_clear[r] += 1
            elif u and not o:
                false_pos[r].append(label)
            else:
                misses[r].append(label)

    official.close()

    total_cmp = graded * len(rule_ids)
    total_agree = sum(agree.values())

    # ----- per-rule agreement table ----- #
    print("=" * 82)
    print("PER-RULE AGREEMENT  (%s  vs  our validator)" % title)
    print("graded invoices: %d   |   comparisons: %d (invoices x %d rules)"
          % (graded, total_cmp, len(rule_ids)))
    print("=" * 82)
    print("%-12s %9s %9s %10s %10s %6s" %
          ("RULE", "agree", "both-fire", "both-clr", "false-pos", "miss"))
    print("-" * 82)
    for r in rule_ids:
        print("%-12s %6d/%-4d %8d %10d %10d %6d" % (
            r, agree[r], graded, both_fire[r], both_clear[r],
            len(false_pos[r]), len(misses[r])))
    print("-" * 82)
    tot_fp = sum(len(v) for v in false_pos.values())
    tot_miss = sum(len(v) for v in misses.values())
    print("%-12s %6d/%-4d %8s %10s %10d %6d" % (
        "TOTAL", total_agree, graded, "", "", tot_fp, tot_miss))
    rate = (100.0 * total_agree / total_cmp) if total_cmp else 0.0
    print()
    print("TOTAL AGREEMENT RATE: %d/%d = %.4f%%" % (total_agree, total_cmp, rate))
    print("  divergences: %d false-positives + %d misses = %d"
          % (tot_fp, tot_miss, tot_fp + tot_miss))
    print()

    # ----- full divergence list ----- #
    print("=" * 82)
    print("DIVERGENCES  (each = our interpretation disagreeing with the legal ruleset)")
    print("=" * 82)
    any_div = False
    for r in rule_ids:
        rows = ([("FALSE-POSITIVE (we fire, official clears)", inv) for inv in false_pos[r]] +
                [("MISS (official fires, we clear)", inv) for inv in misses[r]])
        if not rows:
            continue
        any_div = True
        print("\n%s  — %d divergence(s)" % (r, len(rows)))
        for kind, inv in rows:
            print("    [%s]  %s" % (kind, inv))
    if not any_div:
        print("\n  (none) — our validator matched the normative Schematron on every")
        print("  invoice for all %d implemented rules." % len(rule_ids))
    print()

    if errors:
        print("=" * 82)
        print("SKIPPED / ERRORS (%d) — excluded from the agreement counts" % len(errors))
        print("=" * 82)
        for label, side, msg in errors[:60]:
            print("    %-30s %-24s %s" % (label, side, msg))
        if len(errors) > 60:
            print("    ... (%d more)" % (len(errors) - 60))
        print()
    return tot_fp + tot_miss


def run_differential(legs=("en", "xrechnung", "cii", "xrechnung-cii")):
    scratch = os.environ.get("DIFF_SCRATCH") or tempfile.mkdtemp(prefix="diffcorpus-")
    os.makedirs(scratch, exist_ok=True)

    divergences = 0
    if "en" in legs:
        corpus = build_corpus(scratch)
        print("#" * 82)
        print("# LEG 1 — EN 16931 core (official CEN EN16931-UBL Schematron)")
        print("#" * 82)
        print("Corpus assembled: %d UBL Invoice documents" % len(corpus))
        print("  scratch dir: %s" % scratch)
        divergences += _run_leg("official EN16931-UBL Schematron",
                                OFFICIAL_XSLT, OUR_RULE_IDS, our_fired, corpus)
    if "xrechnung" in legs:
        corpus = build_xr_corpus(scratch)
        print("#" * 82)
        print("# LEG 2 — XRechnung CIUS + KoSIT-vendored Peppol batch "
              "(official KoSIT XRechnung-UBL Schematron 2.5.0)")
        print("#" * 82)
        print("Corpus assembled: %d UBL Invoice documents" % len(corpus))
        print("  scratch dir: %s" % scratch)
        divergences += _run_leg("official XRechnung-UBL Schematron",
                                XR_OFFICIAL_XSLT,
                                XR_RULE_IDS + PEPPOL_UBL_RULE_IDS,
                                xr_our_fired, corpus)
    if "cii" in legs:
        corpus = build_cii_corpus(scratch)
        print("#" * 82)
        print("# LEG 3 — EN 16931 core in CII syntax (official CEN EN16931-CII Schematron)")
        print("#" * 82)
        print("Corpus assembled: %d CrossIndustryInvoice documents" % len(corpus))
        print("  scratch dir: %s" % scratch)
        divergences += _run_leg("official EN16931-CII Schematron",
                                CII_OFFICIAL_XSLT, CII_RULE_IDS, cii_our_fired,
                                corpus)
    if "xrechnung-cii" in legs:
        corpus = build_xr_cii_corpus(scratch)
        print("#" * 82)
        print("# LEG 4 — XRechnung CIUS + KoSIT-vendored Peppol batch in CII "
              "syntax (official KoSIT XRechnung-CII Schematron)")
        print("#" * 82)
        print("Corpus assembled: %d CrossIndustryInvoice documents" % len(corpus))
        print("  scratch dir: %s" % scratch)
        divergences += _run_leg("official XRechnung-CII Schematron",
                                XR_CII_OFFICIAL_XSLT,
                                CII_XR_RULE_IDS + PEPPOL_CII_RULE_IDS,
                                xr_cii_our_fired, corpus)
    print("OVERALL DIVERGENCES ACROSS LEGS: %d -> %s"
          % (divergences, "OK" if divergences == 0 else "DIVERGED"))
    return 0 if divergences == 0 else 1


# --------------------------------------------------------------------------- #
# Ad-hoc per-invoice driver (kept for backward compatibility).
# --------------------------------------------------------------------------- #
def _print_leg_report(invoice_path, leg_name, xslt_path, rule_set, our_fn):
    try:
        official = official_fired_rules(invoice_path, xslt_path) & rule_set
    except Exception as e:
        official = None
        print("  [%s] OFFICIAL: ERROR:" % leg_name, e)
    try:
        path, cleanup = _normalized_invoice_path(invoice_path)
        try:
            ours = our_fn(path) & rule_set
        finally:
            cleanup()
    except Exception as e:
        ours = None
        print("  [%s] OURS:     ERROR:" % leg_name, e)
    if official is not None:
        print("  [%s] OFFICIAL fired (%d):" % (leg_name, len(official)),
              ", ".join(sorted(official)) or "(none)")
    if ours is not None:
        print("  [%s] OURS     fired (%d):" % (leg_name, len(ours)),
              ", ".join(sorted(ours)) or "(none)")
    if official is not None and ours is not None:
        print("  [%s] agree        :" % leg_name,
              ", ".join(sorted(official & ours)) or "(none)")
        print("  [%s] official-only:" % leg_name,
              ", ".join(sorted(official - ours)) or "(none)")
        print("  [%s] ours-only    :" % leg_name,
              ", ".join(sorted(ours - official)) or "(none)")


def _print_report(invoice_path: str) -> None:
    rel = os.path.relpath(invoice_path, HERE)
    print("=" * 78)
    print("INVOICE:", rel)
    _print_leg_report(invoice_path, "EN", OFFICIAL_XSLT, OUR_RULE_SET, our_fired)
    _print_leg_report(invoice_path, "XR", XR_OFFICIAL_XSLT, XR_RULE_SET,
                      xr_our_fired)


def main(argv: list) -> int:
    if not argv:
        return run_differential()
    if len(argv) == 1 and argv[0] in ("en", "xrechnung", "cii", "xrechnung-cii"):
        return run_differential(legs=(argv[0],))
    for s in argv:
        if not os.path.exists(s):
            print("=" * 78)
            print("INVOICE:", s, "-> MISSING")
            continue
        _print_report(s)
    print("=" * 78)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

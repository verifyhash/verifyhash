#!/usr/bin/env python3
"""Unit tests for BR-DEC-13 / BR-DEC-15 — the total-VAT decimal rules
(T-VHCORE.6).

BR-DEC-13: the Invoice total VAT amount (BT-110) allows at most 2 decimals.
BR-DEC-15: the Invoice total VAT amount in accounting currency (BT-111)
allows at most 2 decimals.

Both rules are transcribed in ``einvoice/rules.br_dec_13`` /
``rules.br_dec_15`` from BOTH vendored preprocessed CEN artifacts, whose
bindings genuinely differ:

  * CII (EN16931-CII-validation-preprocessed.sch): a REAL numeric test —
    ``. = round(. * 100) div 100`` over the header summation's
    ``ram:TaxTotalAmount`` children, currency-scoped by RAW ``@currencyID``
    against BT-5 (BR-DEC-13) / BT-6 (BR-DEC-15) and EXISTENTIAL per
    summation. Consequences pinned below, each verified against the official
    compiled CII XSLT: a trailing-zero third decimal (``12.340``) HOLDS
    (numerically round2-equal); a total in a non-matching currency satisfies
    BR-DEC-13 for the whole summation; and a present BT-6 with NO
    matching-currency total FIRES BR-DEC-15. This is the syntax the
    differential harness GRADES (LEG 3, mutation-proven).
  * UBL (EN16931-UBL-validation-preprocessed.sch): the shipped assert's
    predicate ``[@currencyID = cbc:DocumentCurrencyCode]`` (resp.
    ``cbc:TaxCurrencyCode``) resolves the currency element against the
    cbc:TaxAmount context node — which has no such child — so the official
    UBL assert is vacuous by defect and can never fire. The engine asserts
    the rule's STATED INTENT on UBL anyway (deliberate strictness, the
    BR-AF-08/09 posture): >2 characters after '.' on the BT-5-/BT-6-currency
    ``//cac:TaxTotal/cbc:TaxAmount`` fires, Invoice and CreditNote alike.
    The pair is held out of the UBL differential legs
    (``differential.EN_UBL_EXCLUDED_RULE_IDS``) for exactly that reason.

This file is the fast, saxonche-free companion to the differential harness:
one positive (2 decimals -> no finding) and one negative (3 decimals ->
finding with the exact rule id, flag fatal) fixture per rule per syntax —
in-file minimal fixtures per the S/Z/E-family precedent, NO new corpus files.

Standard library only. Run: python3 test_brdec_totals.py
"""

from __future__ import annotations

import os
import sys
import unittest
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice import parser, parser_cii, rules   # noqa: E402


# --------------------------------------------------------------------------- #
# Engine plumbing: run the FULL registered rule set (so the test also proves
# both rules are wired into ALL_RULES, not merely importable) and keep only
# the BR-DEC-13/15 violations. Minimal fixtures legitimately fire other rules
# (missing seller etc.); those are irrelevant here.
# --------------------------------------------------------------------------- #
def _dec_violations(inv):
    out = []
    for fn in rules.ALL_RULES:
        v = fn(inv)
        if v is not None and v.rule_id in ("BR-DEC-13", "BR-DEC-15"):
            out.append(v)
    return out


def _fired(inv):
    return {v.rule_id for v in _dec_violations(inv)}


# --------------------------------------------------------------------------- #
# UBL fixtures (Invoice + CreditNote — the official rule context is
# ``/ubl:Invoice | /cn:CreditNote``).
# --------------------------------------------------------------------------- #
NS_INV = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
NS_CN = "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"

_UBL_TMPL = """<?xml version="1.0" encoding="UTF-8"?>
<{root} xmlns="{ns}"
 xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
 xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>TEST-1</cbc:ID>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>{taxcur}
  {taxtotals}
</{root}>"""


def _ubl_inv(taxtotals, taxcur="", root="Invoice", ns=NS_INV):
    xml = _UBL_TMPL.format(root=root, ns=ns, taxcur=taxcur, taxtotals=taxtotals)
    return parser.build_model(ET.fromstring(xml))


def _tt(amount, currency="EUR"):
    return ('<cac:TaxTotal><cbc:TaxAmount currencyID="%s">%s</cbc:TaxAmount>'
            "</cac:TaxTotal>" % (currency, amount))


_TAXCUR_SEK = "\n  <cbc:TaxCurrencyCode>SEK</cbc:TaxCurrencyCode>"


class UblBrDec13(unittest.TestCase):
    """UBL arm of BR-DEC-13 (intent-asserted, see module docstring)."""

    def test_positive_two_decimals_no_finding(self):
        inv = _ubl_inv(_tt("12.34"))
        self.assertNotIn("BR-DEC-13", _fired(inv))

    def test_negative_three_decimals_fires_fatal(self):
        inv = _ubl_inv(_tt("12.345"))
        found = [v for v in _dec_violations(inv) if v.rule_id == "BR-DEC-13"]
        self.assertEqual(len(found), 1, "BR-DEC-13 must fire exactly once")
        self.assertEqual(found[0].severity, "fatal")
        self.assertIn("BT-110", found[0].message)

    def test_negative_creditnote_arm_fires(self):
        # The official rule context covers /cn:CreditNote identically.
        inv = _ubl_inv(_tt("12.345"), root="CreditNote", ns=NS_CN)
        self.assertIn("BR-DEC-13", _fired(inv))

    def test_non_matching_currency_is_out_of_scope(self):
        # A 3-decimal total in a currency that is neither BT-5 nor BT-6 is
        # not this rule's target (BT-110 is the doc-currency total).
        inv = _ubl_inv(_tt("12.345", currency="USD"))
        self.assertEqual(_fired(inv), set())


class UblBrDec15(unittest.TestCase):
    """UBL arm of BR-DEC-15 (intent-asserted, BT-6-currency total)."""

    def test_positive_two_decimals_no_finding(self):
        inv = _ubl_inv(_tt("12.34") + _tt("130.05", currency="SEK"),
                       taxcur=_TAXCUR_SEK)
        self.assertNotIn("BR-DEC-15", _fired(inv))

    def test_negative_three_decimals_fires_fatal(self):
        inv = _ubl_inv(_tt("12.34") + _tt("130.045", currency="SEK"),
                       taxcur=_TAXCUR_SEK)
        found = [v for v in _dec_violations(inv) if v.rule_id == "BR-DEC-15"]
        self.assertEqual(len(found), 1, "BR-DEC-15 must fire exactly once")
        self.assertEqual(found[0].severity, "fatal")
        self.assertIn("BT-111", found[0].message)

    def test_absent_bt6_never_fires(self):
        inv = _ubl_inv(_tt("12.345"))
        self.assertNotIn("BR-DEC-15", _fired(inv))


# --------------------------------------------------------------------------- #
# CII fixtures (context //ram:SpecifiedTradeSettlementHeaderMonetarySummation).
# --------------------------------------------------------------------------- #
_CII_TMPL = """<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
 xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
 xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
 xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
 <rsm:ExchangedDocument><ram:ID>TEST-1</ram:ID></rsm:ExchangedDocument>
 <rsm:SupplyChainTradeTransaction>
  <ram:ApplicableHeaderTradeSettlement>
   <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>{taxcur}
   <ram:SpecifiedTradeSettlementHeaderMonetarySummation>{ttas}
   </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
  </ram:ApplicableHeaderTradeSettlement>
 </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>"""


def _cii_inv(ttas, taxcur=""):
    xml = _CII_TMPL.format(taxcur=taxcur, ttas=ttas)
    return parser_cii.build_model(ET.fromstring(xml))


def _tta(amount, currency="EUR"):
    return ('<ram:TaxTotalAmount currencyID="%s">%s</ram:TaxTotalAmount>'
            % (currency, amount))


_CII_TAXCUR_SEK = "\n   <ram:TaxCurrencyCode>SEK</ram:TaxCurrencyCode>"


class CiiBrDec13(unittest.TestCase):
    """CII arm of BR-DEC-13 — exact transcription, differential-graded."""

    def test_positive_two_decimals_no_finding(self):
        inv = _cii_inv(_tta("12.34"))
        self.assertNotIn("BR-DEC-13", _fired(inv))

    def test_negative_three_decimals_fires_fatal(self):
        inv = _cii_inv(_tta("12.345"))
        found = [v for v in _dec_violations(inv) if v.rule_id == "BR-DEC-13"]
        self.assertEqual(len(found), 1, "BR-DEC-13 must fire exactly once")
        self.assertEqual(found[0].severity, "fatal")
        self.assertIn("BT-110", found[0].message)

    def test_trailing_zero_third_decimal_holds(self):
        # ``12.340`` is numerically round2-equal: the CII test passes it
        # (verified against the official CII XSLT) — unlike the UBL
        # character-count idiom.
        inv = _cii_inv(_tta("12.340"))
        self.assertNotIn("BR-DEC-13", _fired(inv))

    def test_non_matching_currency_total_satisfies_summation(self):
        # Existential per summation: the SEK total satisfies the
        # ``not(@currencyID = BT-5)`` disjunct, so the official assert holds
        # even though the EUR total has 3 decimals (official-XSLT-verified).
        inv = _cii_inv(_tta("12.345") + _tta("130.05", currency="SEK"),
                       taxcur=_CII_TAXCUR_SEK)
        self.assertNotIn("BR-DEC-13", _fired(inv))


class CiiBrDec15(unittest.TestCase):
    """CII arm of BR-DEC-15 — exact transcription, differential-graded."""

    def test_positive_two_decimals_no_finding(self):
        inv = _cii_inv(_tta("12.34") + _tta("130.05", currency="SEK"),
                       taxcur=_CII_TAXCUR_SEK)
        self.assertNotIn("BR-DEC-15", _fired(inv))

    def test_negative_three_decimals_fires_fatal(self):
        inv = _cii_inv(_tta("12.34") + _tta("130.045", currency="SEK"),
                       taxcur=_CII_TAXCUR_SEK)
        found = [v for v in _dec_violations(inv) if v.rule_id == "BR-DEC-15"]
        self.assertEqual(len(found), 1, "BR-DEC-15 must fire exactly once")
        self.assertEqual(found[0].severity, "fatal")
        self.assertIn("BT-111", found[0].message)

    def test_bt6_present_without_matching_total_fires(self):
        # ``not(BT-6)`` is the only escape: BT-6 present + no SEK total means
        # no TaxTotalAmount satisfies the predicate -> the official assert
        # fires (official-XSLT-verified), and so do we.
        inv = _cii_inv(_tta("12.34"), taxcur=_CII_TAXCUR_SEK)
        self.assertIn("BR-DEC-15", _fired(inv))

    def test_absent_bt6_never_fires(self):
        inv = _cii_inv(_tta("12.345"))
        self.assertNotIn("BR-DEC-15", _fired(inv))


# --------------------------------------------------------------------------- #
# Registration invariants: both rules are in ALL_RULES exactly once, and the
# differential harness keeps them CII-graded and UBL-held-out (the honest
# split this file documents).
# --------------------------------------------------------------------------- #
class Registration(unittest.TestCase):

    def test_wired_into_all_rules_once(self):
        names = [fn.__name__ for fn in rules.ALL_RULES]
        self.assertEqual(names.count("br_dec_13"), 1)
        self.assertEqual(names.count("br_dec_15"), 1)

    def test_differential_split(self):
        import differential as diff
        self.assertEqual(set(diff.EN_UBL_EXCLUDED_RULE_IDS),
                         {"BR-DEC-13", "BR-DEC-15"})
        self.assertIn("BR-DEC-13", diff.CII_RULE_SET)
        self.assertIn("BR-DEC-15", diff.CII_RULE_SET)
        self.assertNotIn("BR-DEC-13", diff.EN_RULE_SET)
        self.assertNotIn("BR-DEC-15", diff.EN_RULE_SET)
        # Both stay in the implemented registry the counts derive from.
        self.assertIn("BR-DEC-13", diff.OUR_RULE_SET)
        self.assertIn("BR-DEC-15", diff.OUR_RULE_SET)


if __name__ == "__main__":
    unittest.main(verbosity=2)

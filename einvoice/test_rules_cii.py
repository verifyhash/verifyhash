"""Unit tests: the EN 16931 core rules run UNCHANGED over the CII model.

Standard-library ``unittest`` only — no saxonche, no network, no pip. These tests
prove that the syntax-agnostic rule functions in :mod:`einvoice.rules` (written
once against the UBL model) produce the expected pass/fail when fed a CII
(CrossIndustryInvoice) invoice parsed by :mod:`einvoice.parser_cii`:

  * a KNOWN-GOOD CII invoice from the vendored CEN corpus (CII_example1, a
    20-line Standard-rated Dutch grocery invoice) fires NONE of the graded core
    rules — the same clean verdict the official CEN EN16931-CII Schematron gives
    it (that agreement is proven exhaustively by ``differential.py cii``); and
  * a set of KNOWN-BAD invoices, each the good one mutated to break exactly one
    field, fires exactly the rule that guards that field.

The mutations here are deliberately the SAME field-level breakages the CII
differential leg generates, so this fast unit test and the saxon-backed
differential exercise the same failing directions. Runs in well under a second.
"""

import copy
import os
import unittest
import xml.etree.ElementTree as ET

from einvoice import parser_cii
from einvoice import rules

HERE = os.path.dirname(os.path.abspath(__file__))
CII_DIR = os.path.join(HERE, "corpus", "cen-en16931", "cii", "examples")
GOOD = os.path.join(CII_DIR, "CII_example1.xml")

NS = parser_cii.NS
NSR = parser_cii.NS_RSM
NSA = parser_cii.NS_RAM


def _q(ns, local):
    return "{%s}%s" % (ns, local)


def _fired_ids(root):
    """Rule ids the FULL core rule set (rules.ALL_RULES) fires on a CII root."""
    inv = parser_cii.build_model(root)
    fired = set()
    for fn in rules.ALL_RULES:
        v = fn(inv)
        if v is not None:
            fired.add(v.rule_id)
    return fired


def _good_root():
    return ET.parse(GOOD).getroot()


def _settlement(r):
    return r.find("rsm:SupplyChainTradeTransaction/"
                  "ram:ApplicableHeaderTradeSettlement", NS)


def _summation(r):
    return _settlement(r).find(
        "ram:SpecifiedTradeSettlementHeaderMonetarySummation", NS)


def _first_line(r):
    return r.find("rsm:SupplyChainTradeTransaction/"
                  "ram:IncludedSupplyChainTradeLineItem", NS)


def _first_breakdown(r):
    return _settlement(r).find("ram:ApplicableTradeTax", NS)


def _remove(root, elem):
    parent = {c: p for p in root.iter() for c in p}[elem]
    parent.remove(elem)


class TestKnownGoodCIIInvoice(unittest.TestCase):
    """The clean CEN CII example must fire NONE of the core rules."""

    def test_no_rule_fires_on_clean_invoice(self):
        fired = _fired_ids(_good_root())
        self.assertEqual(
            fired, set(),
            "clean CII_example1 unexpectedly fired core rules: %s"
            % sorted(fired))

    def test_model_exposes_core_rule_surface(self):
        # The CII model must carry the UBL attribute surface the rules read.
        inv = parser_cii.parse(GOOD)
        self.assertTrue(inv.has_legal_monetary_total)   # BR-12..16 gate
        self.assertTrue(inv.seller_has_postal_address)  # BR-08
        self.assertTrue(inv.buyer_has_postal_address)   # BR-10
        self.assertTrue(inv.seller_has_party_tax_scheme_company_id)  # BR-S-02
        self.assertEqual(len(inv.all_tax_subtotals), 2)  # BG-23 breakdown rows
        self.assertEqual(inv.customization_id, "urn:cen.eu:en16931:2017")  # BT-24
        # Line surface consumed by BR-22/26/27/CO-04/S-05.
        ln = inv.lines[0]
        self.assertEqual(ln.quantity, "2")
        self.assertEqual(ln.price_amount, "9.95")
        self.assertEqual(ln.item_tax_categories[0].id, "S")
        self.assertEqual(ln.item_tax_categories[0].scheme_id, "VAT")


class TestKnownBadCIIInvoices(unittest.TestCase):
    """Each single-field mutation must make exactly the guarded rule fire."""

    def assert_fires(self, mutate, rule_id):
        root = _good_root()
        mutate(root)
        fired = _fired_ids(root)
        self.assertIn(
            rule_id, fired,
            "expected %s to fire after mutation; fired=%s"
            % (rule_id, sorted(fired)))

    def test_br06_missing_seller_name(self):
        def m(r):
            seller = r.find("rsm:SupplyChainTradeTransaction/"
                            "ram:ApplicableHeaderTradeAgreement/"
                            "ram:SellerTradeParty", NS)
            _remove(r, seller.find("ram:Name", NS))
        self.assert_fires(m, "BR-06")

    def test_br08_missing_seller_address(self):
        def m(r):
            seller = r.find("rsm:SupplyChainTradeTransaction/"
                            "ram:ApplicableHeaderTradeAgreement/"
                            "ram:SellerTradeParty", NS)
            _remove(r, seller.find("ram:PostalTradeAddress", NS))
        self.assert_fires(m, "BR-08")

    def test_br16_no_lines(self):
        def m(r):
            txn = r.find("rsm:SupplyChainTradeTransaction", NS)
            for ln in txn.findall("ram:IncludedSupplyChainTradeLineItem", NS):
                txn.remove(ln)
        self.assert_fires(m, "BR-16")

    def test_br25_missing_item_name(self):
        def m(r):
            ln = _first_line(r)
            _remove(r, ln.find("ram:SpecifiedTradeProduct/ram:Name", NS))
        self.assert_fires(m, "BR-25")

    def test_br27_negative_net_price(self):
        def m(r):
            _first_line(r).find(
                "ram:SpecifiedLineTradeAgreement/"
                "ram:NetPriceProductTradePrice/ram:ChargeAmount", NS).text = "-1"
        self.assert_fires(m, "BR-27")

    def test_brcl01_bad_type_code(self):
        def m(r):
            r.find("rsm:ExchangedDocument/ram:TypeCode", NS).text = "999"
        self.assert_fires(m, "BR-CL-01")

    def test_brco04_missing_line_vat_category(self):
        def m(r):
            ls = _first_line(r).find("ram:SpecifiedLineTradeSettlement", NS)
            _remove(r, ls.find("ram:ApplicableTradeTax", NS))
        self.assert_fires(m, "BR-CO-04")

    def test_brco10_line_sum_mismatch(self):
        def m(r):
            _summation(r).find("ram:LineTotalAmount", NS).text = "111111.11"
        self.assert_fires(m, "BR-CO-10")

    def test_brco16_amount_due_mismatch(self):
        def m(r):
            _summation(r).find("ram:DuePayableAmount", NS).text = "111111.11"
        self.assert_fires(m, "BR-CO-16")

    def test_br47_missing_breakdown_category(self):
        def m(r):
            _remove(r, _first_breakdown(r).find("ram:CategoryCode", NS))
        self.assert_fires(m, "BR-47")

    def test_brs02_missing_seller_vat_id(self):
        def m(r):
            seller = r.find("rsm:SupplyChainTradeTransaction/"
                            "ram:ApplicableHeaderTradeAgreement/"
                            "ram:SellerTradeParty", NS)
            _remove(r, seller.find("ram:SpecifiedTaxRegistration", NS))
        self.assert_fires(m, "BR-S-02")

    def test_brs05_zero_standard_rate(self):
        def m(r):
            _first_line(r).find(
                "ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax/"
                "ram:RateApplicablePercent", NS).text = "0"
        self.assert_fires(m, "BR-S-05")

    def test_brdec23_three_decimals_line_net(self):
        def m(r):
            _first_line(r).find(
                "ram:SpecifiedLineTradeSettlement/"
                "ram:SpecifiedTradeSettlementLineMonetarySummation/"
                "ram:LineTotalAmount", NS).text = "625743.549"
        self.assert_fires(m, "BR-DEC-23")


if __name__ == "__main__":
    unittest.main()

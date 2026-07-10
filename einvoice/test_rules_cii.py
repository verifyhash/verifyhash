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
from einvoice import rules_xrechnung

HERE = os.path.dirname(os.path.abspath(__file__))
CII_DIR = os.path.join(HERE, "corpus", "cen-en16931", "cii", "examples")
GOOD = os.path.join(CII_DIR, "CII_example1.xml")

# A clean German XRechnung invoice in CII syntax: fires NONE of the admitted
# BR-DE-* rules on the official KoSIT XRechnung-CII Schematron (verified by
# differential.py xrechnung-cii). Used as the mutation base for the BR-DE tests.
XR_CII_GOOD = os.path.join(
    HERE, "corpus", "xrechnung-testsuite", "src", "test", "business-cases",
    "standard", "01.02a-INVOICE_uncefact.xml")

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

    # --- codelist rules (BR-CL-03/04/05/13/14), CII bindings ---------------
    def test_brcl03_bogus_tax_total_currency(self):
        def m(r):
            _summation(r).find(
                "ram:TaxTotalAmount", NS).set("currencyID", "XXY")
        self.assert_fires(m, "BR-CL-03")

    def test_brcl04_bogus_invoice_currency(self):
        def m(r):
            _settlement(r).find("ram:InvoiceCurrencyCode", NS).text = "XXY"
        self.assert_fires(m, "BR-CL-04")

    def test_brcl05_bogus_tax_currency(self):
        def m(r):
            ET.SubElement(
                _settlement(r), _q(NSA, "TaxCurrencyCode")).text = "XXY"
        self.assert_fires(m, "BR-CL-05")

    def test_brcl13_bogus_class_code_list_id(self):
        def m(r):
            prod = _first_line(r).find("ram:SpecifiedTradeProduct", NS)
            dpc = ET.SubElement(
                prod, _q(NSA, "DesignatedProductClassification"))
            cc = ET.SubElement(dpc, _q(NSA, "ClassCode"))
            cc.set("listID", "QQ")       # not a UNTDID 7143 code
            cc.text = "1234"
        self.assert_fires(m, "BR-CL-13")

    def test_brcl14_bogus_country(self):
        def m(r):
            r.find("rsm:SupplyChainTradeTransaction/"
                   "ram:ApplicableHeaderTradeAgreement/ram:SellerTradeParty/"
                   "ram:PostalTradeAddress/ram:CountryID", NS).text = "XX"
        self.assert_fires(m, "BR-CL-14")

    def test_brcl14_cii_binding_accepts_an_rejects_ss(self):
        # The CII list carries AN (Netherlands Antilles) but not SS (South
        # Sudan) — the exact opposite of the UBL list.
        def country(r):
            return r.find(
                "rsm:SupplyChainTradeTransaction/"
                "ram:ApplicableHeaderTradeAgreement/ram:SellerTradeParty/"
                "ram:PostalTradeAddress/ram:CountryID", NS)
        r = _good_root()
        country(r).text = "AN"
        self.assertNotIn("BR-CL-14", _fired_ids(r))
        r2 = _good_root()
        country(r2).text = "SS"
        self.assertIn("BR-CL-14", _fired_ids(r2))

    def test_codelist_rules_fire_with_fatal_severity(self):
        # A present-but-invalid currency must fire BR-CL-04 as fatal.
        r = _good_root()
        _settlement(r).find("ram:InvoiceCurrencyCode", NS).text = "XXY"
        inv = parser_cii.build_model(r)
        v = rules.br_cl_04(inv)
        self.assertIsNotNone(v)
        self.assertEqual(v.rule_id, "BR-CL-04")
        self.assertEqual(v.severity, "fatal")

    def test_clean_cii_base_fires_no_codelist_rule(self):
        fired = _fired_ids(_good_root())
        self.assertEqual(
            fired & {"BR-CL-03", "BR-CL-04", "BR-CL-05",
                     "BR-CL-13", "BR-CL-14"}, set())


def _de_fired(root):
    """Admitted CII BR-DE ids that rules_xrechnung.evaluate_cii fires on a CII root."""
    inv = parser_cii.build_model(root)
    return {v.rule_id for v in rules_xrechnung.evaluate_cii(inv)}


def _xr_good_root():
    return ET.parse(XR_CII_GOOD).getroot()


def _agreement(r):
    return r.find("rsm:SupplyChainTradeTransaction/"
                  "ram:ApplicableHeaderTradeAgreement", NS)


def _settlement_x(r):
    return r.find("rsm:SupplyChainTradeTransaction/"
                  "ram:ApplicableHeaderTradeSettlement", NS)


def _delivery_x(r):
    return r.find("rsm:SupplyChainTradeTransaction/"
                  "ram:ApplicableHeaderTradeDelivery", NS)


def _seller_x(r):
    return _agreement(r).find("ram:SellerTradeParty", NS)


def _seller_contact_x(r):
    return _seller_x(r).find("ram:DefinedTradeContact", NS)


def _buyer_x(r):
    return _agreement(r).find("ram:BuyerTradeParty", NS)


def _add_shipto(r, city=None, zone=None):
    shipto = ET.SubElement(_delivery_x(r), _q(NSA, "ShipToTradeParty"))
    ET.SubElement(shipto, _q(NSA, "Name")).text = "[Deliver to]"
    addr = ET.SubElement(shipto, _q(NSA, "PostalTradeAddress"))
    if zone:
        ET.SubElement(addr, _q(NSA, "PostcodeCode")).text = zone
    if city:
        ET.SubElement(addr, _q(NSA, "CityName")).text = city
    ET.SubElement(addr, _q(NSA, "CountryID")).text = "DE"


class TestKnownGoodCIIXRechnungInvoice(unittest.TestCase):
    """The clean XRechnung CII invoice must fire NONE of the admitted BR-DE rules."""

    def test_no_br_de_fires_on_clean_invoice(self):
        fired = _de_fired(_xr_good_root())
        self.assertEqual(
            fired, set(),
            "clean XRechnung CII invoice unexpectedly fired BR-DE rules: %s"
            % sorted(fired))

    def test_model_exposes_br_de_surface(self):
        inv = parser_cii.parse(XR_CII_GOOD)
        self.assertTrue(inv.has_payment_means)             # BR-DE-1
        self.assertTrue(inv.seller_has_defined_trade_contact)  # BR-DE-2
        self.assertTrue(inv.seller_vat_or_fc_id_present)   # BR-DE-16
        self.assertEqual(len(inv.seller_defined_trade_contacts), 1)
        self.assertTrue(inv.has_actual_delivery_date)      # BR-DE-TMP-32


class TestKnownBadCIIXRechnungInvoices(unittest.TestCase):
    """Each single-field mutation must make exactly the guarded BR-DE rule fire."""

    def assert_fires(self, mutate, rule_id):
        root = _xr_good_root()
        mutate(root)
        fired = _de_fired(root)
        self.assertIn(
            rule_id, fired,
            "expected %s to fire after mutation; fired=%s"
            % (rule_id, sorted(fired)))

    def test_de1_missing_payment_means(self):
        def m(r):
            s = _settlement_x(r)
            for pm in s.findall("ram:SpecifiedTradeSettlementPaymentMeans", NS):
                s.remove(pm)
        self.assert_fires(m, "BR-DE-1")

    def test_de2_missing_seller_contact(self):
        def m(r):
            s = _seller_x(r)
            for c in s.findall("ram:DefinedTradeContact", NS):
                s.remove(c)
        self.assert_fires(m, "BR-DE-2")

    def test_de3_missing_seller_city(self):
        def m(r):
            a = _seller_x(r).find("ram:PostalTradeAddress", NS)
            _remove(r, a.find("ram:CityName", NS))
        self.assert_fires(m, "BR-DE-3")

    def test_de4_missing_seller_postcode(self):
        def m(r):
            a = _seller_x(r).find("ram:PostalTradeAddress", NS)
            _remove(r, a.find("ram:PostcodeCode", NS))
        self.assert_fires(m, "BR-DE-4")

    def test_de5_missing_contact_point(self):
        def m(r):
            c = _seller_contact_x(r)
            for local in ("PersonName", "DepartmentName"):
                el = c.find("ram:%s" % local, NS)
                if el is not None:
                    _remove(r, el)
        self.assert_fires(m, "BR-DE-5")

    def test_de6_missing_contact_telephone(self):
        def m(r):
            c = _seller_contact_x(r)
            _remove(r, c.find("ram:TelephoneUniversalCommunication", NS))
        self.assert_fires(m, "BR-DE-6")

    def test_de7_missing_contact_email(self):
        def m(r):
            c = _seller_contact_x(r)
            _remove(r, c.find("ram:EmailURIUniversalCommunication", NS))
        self.assert_fires(m, "BR-DE-7")

    def test_de8_missing_buyer_city(self):
        def m(r):
            a = _buyer_x(r).find("ram:PostalTradeAddress", NS)
            _remove(r, a.find("ram:CityName", NS))
        self.assert_fires(m, "BR-DE-8")

    def test_de9_missing_buyer_postcode(self):
        def m(r):
            a = _buyer_x(r).find("ram:PostalTradeAddress", NS)
            _remove(r, a.find("ram:PostcodeCode", NS))
        self.assert_fires(m, "BR-DE-9")

    def test_de10_shipto_missing_city(self):
        self.assert_fires(lambda r: _add_shipto(r, zone="12345"), "BR-DE-10")

    def test_de11_shipto_missing_postcode(self):
        self.assert_fires(lambda r: _add_shipto(r, city="Bremen"), "BR-DE-11")

    def test_de14_missing_breakdown_rate(self):
        def m(r):
            bd = _settlement_x(r).find("ram:ApplicableTradeTax", NS)
            _remove(r, bd.find("ram:RateApplicablePercent", NS))
        self.assert_fires(m, "BR-DE-14")

    def test_de15_missing_buyer_reference(self):
        def m(r):
            _remove(r, _agreement(r).find("ram:BuyerReference", NS))
        self.assert_fires(m, "BR-DE-15")

    def test_de16_missing_seller_vat_id(self):
        def m(r):
            s = _seller_x(r)
            for tr in s.findall("ram:SpecifiedTaxRegistration", NS):
                s.remove(tr)
        self.assert_fires(m, "BR-DE-16")

    def test_de17_bad_type_code(self):
        def m(r):
            r.find("rsm:ExchangedDocument/ram:TypeCode", NS).text = "71"
        self.assert_fires(m, "BR-DE-17")

    def test_de21_bad_customization_id(self):
        def m(r):
            r.find("rsm:ExchangedDocumentContext/"
                   "ram:GuidelineSpecifiedDocumentContextParameter/ram:ID",
                   NS).text = "urn:cen.eu:en16931:2017"
        self.assert_fires(m, "BR-DE-21")

    def test_de26_corrected_without_reference(self):
        def m(r):
            r.find("rsm:ExchangedDocument/ram:TypeCode", NS).text = "384"
        self.assert_fires(m, "BR-DE-26")

    def test_de27_short_telephone(self):
        def m(r):
            _seller_contact_x(r).find(
                "ram:TelephoneUniversalCommunication/ram:CompleteNumber",
                NS).text = "kein"
        self.assert_fires(m, "BR-DE-27")

    def test_de28_malformed_email(self):
        def m(r):
            _seller_contact_x(r).find(
                "ram:EmailURIUniversalCommunication/ram:URIID",
                NS).text = "kein-email-hier"
        self.assert_fires(m, "BR-DE-28")

    def test_de_tmp32_missing_delivery_date(self):
        def m(r):
            d = _delivery_x(r)
            if d is not None:
                el = d.find("ram:ActualDeliverySupplyChainEvent", NS)
                if el is not None:
                    _remove(r, el)
            s = _settlement_x(r)
            bp = s.find("ram:BillingSpecifiedPeriod", NS)
            if bp is not None:
                _remove(r, bp)
            for ln in r.findall("rsm:SupplyChainTradeTransaction/"
                                "ram:IncludedSupplyChainTradeLineItem", NS):
                lp = ln.find("ram:SpecifiedLineTradeSettlement/"
                             "ram:BillingSpecifiedPeriod", NS)
                if lp is not None:
                    _remove(r, lp)
        self.assert_fires(m, "BR-DE-TMP-32")


if __name__ == "__main__":
    unittest.main()

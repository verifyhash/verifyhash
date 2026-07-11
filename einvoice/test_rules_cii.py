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

    # --- VAT category / VATEX codelist rules (BR-CL-17/18/22), CII bindings --
    def test_brcl18_bogus_line_category(self):
        # CII routes the document breakdown AND line VAT category through
        # BR-CL-18 (ram:ApplicableTradeTax/ram:CategoryCode).
        def m(r):
            _first_line(r).find(
                "ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax/"
                "ram:CategoryCode", NS).text = "XX"
        self.assert_fires(m, "BR-CL-18")

    def test_brcl18_bogus_breakdown_category(self):
        def m(r):
            _first_breakdown(r).find("ram:CategoryCode", NS).text = "QQ"
        self.assert_fires(m, "BR-CL-18")

    def test_brcl17_bogus_allowance_charge_category(self):
        # CII BR-CL-17 context is the allowance/charge category
        # (ram:CategoryTradeTax/ram:CategoryCode). CII_example1 has none, so add
        # one; even if arithmetic rules also fire, BR-CL-17 must be present.
        def m(r):
            ac = ET.SubElement(
                _settlement(r), _q(NSA, "SpecifiedTradeAllowanceCharge"))
            ci = ET.SubElement(ac, _q(NSA, "ChargeIndicator"))
            ET.SubElement(ci, _q(parser_cii.NS_UDT, "Indicator")).text = "false"
            ET.SubElement(ac, _q(NSA, "ActualAmount")).text = "10"
            ET.SubElement(ac, _q(NSA, "Reason")).text = "Adjustment"
            ctt = ET.SubElement(ac, _q(NSA, "CategoryTradeTax"))
            ET.SubElement(ctt, _q(NSA, "TypeCode")).text = "VAT"
            ET.SubElement(ctt, _q(NSA, "CategoryCode")).text = "XX"
            ET.SubElement(ctt, _q(NSA, "RateApplicablePercent")).text = "21"
        self.assert_fires(m, "BR-CL-17")

    def test_brcl22_bogus_exemption_code(self):
        def m(r):
            lt = _first_line(r).find(
                "ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax", NS)
            ET.SubElement(lt, _q(NSA, "ExemptionReasonCode")).text = "NOT-VATEX"
        self.assert_fires(m, "BR-CL-22")

    def test_brcl22_valid_vatex_code_case_insensitive(self):
        r = _good_root()
        lt = _first_line(r).find(
            "ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax", NS)
        ET.SubElement(lt, _q(NSA, "ExemptionReasonCode")).text = "vatex-eu-79-c"
        self.assertNotIn("BR-CL-22", _fired_ids(r))

    def test_brcl23_bogus_unit_code(self):
        def m(r):
            _first_line(r).find(
                "ram:SpecifiedLineTradeDelivery/ram:BilledQuantity", NS
            ).set("unitCode", "XXY")
        self.assert_fires(m, "BR-CL-23")

    def test_brcl23_valid_unit_code_passes(self):
        # The clean CII base line already carries a listed unit code (H87).
        self.assertNotIn("BR-CL-23", _fired_ids(_good_root()))

    def test_clean_cii_base_fires_no_codelist_rule(self):
        fired = _fired_ids(_good_root())
        self.assertEqual(
            fired & {"BR-CL-03", "BR-CL-04", "BR-CL-05", "BR-CL-13",
                     "BR-CL-14", "BR-CL-17", "BR-CL-18", "BR-CL-22",
                     "BR-CL-23"}, set())


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


class TestSupportingDocItemMetadataVatPointBatchCII(unittest.TestCase):
    """CII-side coverage for BR-23, BR-52, BR-53, BR-54, BR-56, BR-64, BR-65,
    BR-CO-03, BR-CO-09 and BR-CO-19 — the batch whose CII extraction differs
    from UBL on every rule (different context nodes, and for BR-53/56/64/65/
    CO-03/CO-09 genuinely different official predicates). Each case pins a
    verdict the CII differential leg (``differential.py cii``) proved against
    the official CEN EN16931-CII Schematron, including the places where the
    CII binding decides the OPPOSITE of the UBL binding on the same shape."""

    def assert_fired(self, root, rule_id, expect=True):
        got = _fired_ids(root)
        if expect:
            self.assertIn(rule_id, got,
                          "%s should fire; fired=%s" % (rule_id, sorted(got)))
        else:
            self.assertNotIn(rule_id, got,
                             "%s should NOT fire" % rule_id)

    def _agreement(self, r):
        return r.find("rsm:SupplyChainTradeTransaction/"
                      "ram:ApplicableHeaderTradeAgreement", NS)

    def _product(self, r):
        return _first_line(r).find("ram:SpecifiedTradeProduct", NS)

    # ---- BR-23 --------------------------------------------------------------
    def test_br_23_missing_unit_code_fires(self):
        r = _good_root()
        del _first_line(r).find("ram:SpecifiedLineTradeDelivery/"
                                "ram:BilledQuantity", NS).attrib["unitCode"]
        self.assert_fired(r, "BR-23")
        self.assert_fired(_good_root(), "BR-23", expect=False)

    def test_br_23_empty_unit_code_holds(self):
        # Effective-boolean-value of the @unitCode node: existence, so an
        # empty unitCode="" satisfies BR-23 on CII exactly like on UBL.
        r = _good_root()
        _first_line(r).find("ram:SpecifiedLineTradeDelivery/"
                            "ram:BilledQuantity", NS).set("unitCode", "")
        self.assert_fired(r, "BR-23", expect=False)

    # ---- BR-52 --------------------------------------------------------------
    def add_referenced_doc(self, r, issuer_id):
        ard = ET.SubElement(self._agreement(r),
                            _q(NSA, "AdditionalReferencedDocument"))
        if issuer_id is not None:
            ET.SubElement(ard, _q(NSA, "IssuerAssignedID")).text = issuer_id
        ET.SubElement(ard, _q(NSA, "TypeCode")).text = "916"

    def test_br_52_missing_issuer_id_fires(self):
        r = _good_root()
        self.add_referenced_doc(r, None)
        self.assert_fired(r, "BR-52")
        self.assert_fired(_good_root(), "BR-52", expect=False)

    def test_br_52_with_issuer_id_holds(self):
        r = _good_root()
        self.add_referenced_doc(r, "DOC-1")
        self.assert_fired(r, "BR-52", expect=False)

    # ---- BR-53 --------------------------------------------------------------
    def add_tax_currency(self, r, code):
        settle = _settlement(r)
        icc = settle.find("ram:InvoiceCurrencyCode", NS)
        tcc = ET.Element(_q(NSA, "TaxCurrencyCode"))
        tcc.text = code
        settle.insert(list(settle).index(icc) + 1, tcc)

    def test_br_53_tax_currency_without_matching_total_fires(self):
        # BT-6 = USD, but the header summation's only ram:TaxTotalAmount
        # carries @currencyID="EUR".
        r = _good_root()
        self.add_tax_currency(r, "USD")
        self.assert_fired(r, "BR-53")
        self.assert_fired(_good_root(), "BR-53", expect=False)

    def test_br_53_matching_accounting_total_holds(self):
        r = _good_root()
        self.add_tax_currency(r, "USD")
        tta = ET.SubElement(_summation(r), _q(NSA, "TaxTotalAmount"))
        tta.text = "24.42"
        tta.set("currencyID", "USD")
        self.assert_fired(r, "BR-53", expect=False)

    def test_br_53_tax_currency_equal_to_invoice_currency_fires(self):
        # The CII-only conjunct not(BT-6 = BT-5): declaring the accounting
        # currency EQUAL to the invoice currency fires even though a matching
        # EUR ram:TaxTotalAmount exists. (The UBL binding has no such clause.)
        r = _good_root()
        self.add_tax_currency(r, "EUR")
        self.assert_fired(r, "BR-53")

    # ---- BR-54 --------------------------------------------------------------
    def add_characteristic(self, r, description=None, value=None):
        apc = ET.SubElement(self._product(r),
                            _q(NSA, "ApplicableProductCharacteristic"))
        if description is not None:
            ET.SubElement(apc, _q(NSA, "Description")).text = description
        if value is not None:
            ET.SubElement(apc, _q(NSA, "Value")).text = value

    def test_br_54_description_without_value_fires(self):
        r = _good_root()
        self.add_characteristic(r, description="Colour")
        self.assert_fired(r, "BR-54")
        self.assert_fired(_good_root(), "BR-54", expect=False)

    def test_br_54_description_and_value_hold(self):
        r = _good_root()
        self.add_characteristic(r, description="Colour", value="Red")
        self.assert_fired(r, "BR-54", expect=False)

    # ---- BR-56 --------------------------------------------------------------
    def add_tax_representative(self, r, va_id=None):
        trp = ET.SubElement(self._agreement(r),
                            _q(NSA, "SellerTaxRepresentativeTradeParty"))
        ET.SubElement(trp, _q(NSA, "Name")).text = "Rep A"
        pta = ET.SubElement(trp, _q(NSA, "PostalTradeAddress"))
        ET.SubElement(pta, _q(NSA, "CountryID")).text = "NL"
        if va_id is not None:
            reg = ET.SubElement(trp, _q(NSA, "SpecifiedTaxRegistration"))
            id_el = ET.SubElement(reg, _q(NSA, "ID"))
            id_el.text = va_id
            id_el.set("schemeID", "VA")

    def test_br_56_representative_without_registration_fires(self):
        r = _good_root()
        self.add_tax_representative(r)
        self.assert_fired(r, "BR-56")
        self.assert_fired(_good_root(), "BR-56", expect=False)

    def test_br_56_empty_va_id_fires_on_cii(self):
        # normalize-space(...) != '' — the CII binding REQUIRES a non-empty
        # identifier, where the UBL binding (pure existence) accepts an empty
        # CompanyID. Same shape, opposite verdict, both official.
        r = _good_root()
        self.add_tax_representative(r, va_id="")
        self.assert_fired(r, "BR-56")

    def test_br_56_with_va_id_holds(self):
        r = _good_root()
        self.add_tax_representative(r, va_id="NL123456789B01")
        self.assert_fired(r, "BR-56", expect=False)

    # ---- BR-64 / BR-65 -------------------------------------------------------
    def add_global_id(self, r, scheme_id):
        gid = ET.Element(_q(NSA, "GlobalID"))
        gid.text = "1234567890123"
        if scheme_id is not None:
            gid.set("schemeID", scheme_id)
        self._product(r).insert(0, gid)

    def test_br_64_missing_scheme_id_fires(self):
        r = _good_root()
        self.add_global_id(r, None)
        self.assert_fired(r, "BR-64")
        self.assert_fired(_good_root(), "BR-64", expect=False)

    def test_br_64_empty_scheme_id_fires_on_cii(self):
        # normalize-space(@schemeID) != '' — empty fires here, while the UBL
        # binding (exists(@schemeID)) holds on the same shape.
        r = _good_root()
        self.add_global_id(r, "")
        self.assert_fired(r, "BR-64")

    def test_br_64_with_scheme_id_holds(self):
        r = _good_root()
        self.add_global_id(r, "0160")
        self.assert_fired(r, "BR-64", expect=False)

    def add_classification(self, r, list_id):
        dpc = ET.SubElement(self._product(r),
                            _q(NSA, "DesignatedProductClassification"))
        cc = ET.SubElement(dpc, _q(NSA, "ClassCode"))
        cc.text = "9873242"
        if list_id is not None:
            cc.set("listID", list_id)

    def test_br_65_missing_list_id_fires(self):
        r = _good_root()
        self.add_classification(r, None)
        self.assert_fired(r, "BR-65")
        self.assert_fired(_good_root(), "BR-65", expect=False)

    def test_br_65_with_list_id_holds(self):
        r = _good_root()
        self.add_classification(r, "TST")
        self.assert_fired(r, "BR-65", expect=False)

    # ---- BR-CO-03 ------------------------------------------------------------
    def add_tax_point_fields(self, r, date=True, code=True):
        tt = _first_breakdown(r)
        if date:
            ET.SubElement(tt, _q(NSA, "TaxPointDate"))
        if code:
            ET.SubElement(tt, _q(NSA, "DueDateTypeCode")).text = "35"

    def test_br_co_03_both_present_fires(self):
        r = _good_root()
        self.add_tax_point_fields(r)
        self.assert_fired(r, "BR-CO-03")
        self.assert_fired(_good_root(), "BR-CO-03", expect=False)

    def test_br_co_03_date_alone_holds(self):
        r = _good_root()
        self.add_tax_point_fields(r, code=False)
        self.assert_fired(r, "BR-CO-03", expect=False)

    def test_br_co_03_no_breakdown_rows_holds_on_cii(self):
        # The CII assert lives on //ram:ApplicableHeaderTradeSettlement/
        # ram:ApplicableTradeTax: with NO document-level breakdown rows the
        # official artifact has no context node and stays silent even though
        # BT-7 and BT-8 are both present (on a line-level trade tax). Other
        # rules (BR-CO-18 etc.) fire instead.
        r = _good_root()
        line_tt = _first_line(r).find("ram:SpecifiedLineTradeSettlement/"
                                      "ram:ApplicableTradeTax", NS)
        ET.SubElement(line_tt, _q(NSA, "TaxPointDate"))
        ET.SubElement(line_tt, _q(NSA, "DueDateTypeCode")).text = "35"
        settle = _settlement(r)
        for tt in settle.findall("ram:ApplicableTradeTax", NS):
            settle.remove(tt)
        got = _fired_ids(r)
        self.assertNotIn("BR-CO-03", got)
        self.assertIn("BR-CO-18", got)  # sanity: the breakdown IS gone

    # ---- BR-CO-09 ------------------------------------------------------------
    def _seller_va_id(self, r):
        seller = self._agreement(r).find("ram:SellerTradeParty", NS)
        for id_el in seller.findall("ram:SpecifiedTaxRegistration/ram:ID", NS):
            if id_el.get("schemeID") == "VA":
                return id_el
        raise AssertionError("base invoice lost its VA registration")

    def test_br_co_09_unlisted_prefix_fires(self):
        r = _good_root()
        self._seller_va_id(r).text = "XX8200.98.395.B.01"
        self.assert_fired(r, "BR-CO-09")
        self.assert_fired(_good_root(), "BR-CO-09", expect=False)

    def test_br_co_09_greece_el_prefix_holds(self):
        r = _good_root()
        self._seller_va_id(r).text = "EL123456789"
        self.assert_fired(r, "BR-CO-09", expect=False)

    def test_br_co_09_short_id_fires_on_cii(self):
        # contains(list, concat(' ', substring(., 1, 2), ' ')) — the CII
        # binding space-wraps the prefix, so a 1-character identifier can never
        # match a 2-character token and FIRES. The UBL binding (unwrapped
        # contains) holds on the same shape — see test_rules.py.
        r = _good_root()
        self._seller_va_id(r).text = "N"
        self.assert_fired(r, "BR-CO-09")

    # ---- BR-CO-19 ------------------------------------------------------------
    def add_billing_period(self, r, start=False, end=False):
        period = ET.SubElement(_settlement(r),
                               _q(NSA, "BillingSpecifiedPeriod"))
        for flag, local in ((start, "StartDateTime"), (end, "EndDateTime")):
            if flag:
                dt = ET.SubElement(period, _q(NSA, local))
                ds = ET.SubElement(
                    dt, "{urn:un:unece:uncefact:data:standard:"
                        "UnqualifiedDataType:100}DateTimeString")
                ds.set("format", "102")
                ds.text = "20181201"

    def test_br_co_19_empty_period_fires(self):
        r = _good_root()
        self.add_billing_period(r)
        self.assert_fired(r, "BR-CO-19")
        self.assert_fired(_good_root(), "BR-CO-19", expect=False)

    def test_br_co_19_start_date_alone_holds(self):
        r = _good_root()
        self.add_billing_period(r, start=True)
        self.assert_fired(r, "BR-CO-19", expect=False)


class TestGapBatchACII(unittest.TestCase):
    """CII-side coverage for the core/decimals/VAT gap batch A — BR-CO-20/21/
    22/23/24/26, BR-DEC-24/25/27/28, BR-IC-10 and BR-S-08. Each case pins a
    verdict the CII differential leg (``differential.py cii``) proved against
    the official CEN EN16931-CII Schematron, including BR-S-08's CII-only
    EXACT per-rate round2 equality (the UBL binding is a ±1 band instead) and
    BR-CO-26's CII-specific identifier disjuncts."""

    def assert_fired(self, root, rule_id, expect=True):
        got = _fired_ids(root)
        if expect:
            self.assertIn(rule_id, got,
                          "%s should fire; fired=%s" % (rule_id, sorted(got)))
        else:
            self.assertNotIn(rule_id, got,
                             "%s should NOT fire" % rule_id)

    def _line_settlement(self, r):
        return _first_line(r).find("ram:SpecifiedLineTradeSettlement", NS)

    def _seller(self, r):
        return r.find("rsm:SupplyChainTradeTransaction/"
                      "ram:ApplicableHeaderTradeAgreement/"
                      "ram:SellerTradeParty", NS)

    def add_line_period(self, r, start=False):
        period = ET.SubElement(self._line_settlement(r),
                               _q(NSA, "BillingSpecifiedPeriod"))
        if start:
            dt = ET.SubElement(period, _q(NSA, "StartDateTime"))
            ds = ET.SubElement(
                dt, "{urn:un:unece:uncefact:data:standard:"
                    "UnqualifiedDataType:100}DateTimeString")
            ds.set("format", "102")
            ds.text = "20150101"

    def _add_ac(self, parent, charge, amount, base, reason):
        ac = ET.SubElement(parent, _q(NSA, "SpecifiedTradeAllowanceCharge"))
        ind = ET.SubElement(ac, _q(NSA, "ChargeIndicator"))
        ET.SubElement(
            ind, "{urn:un:unece:uncefact:data:standard:"
                 "UnqualifiedDataType:100}Indicator").text = (
            "true" if charge else "false")
        if base is not None:
            ET.SubElement(ac, _q(NSA, "BasisAmount")).text = base
        ET.SubElement(ac, _q(NSA, "ActualAmount")).text = amount
        if reason is not None:
            ET.SubElement(ac, _q(NSA, "Reason")).text = reason
        return ac

    def add_doc_ac(self, r, charge, reason=None):
        return self._add_ac(_settlement(r), charge, "0.00", None, reason)

    def add_line_ac(self, r, charge, amount="0.00", base=None, reason=None):
        return self._add_ac(self._line_settlement(r), charge, amount, base,
                            reason)

    # ---- BR-CO-20 ------------------------------------------------------------
    def test_br_co_20_empty_line_period_fires(self):
        r = _good_root()
        self.add_line_period(r)
        self.assert_fired(r, "BR-CO-20")
        self.assert_fired(_good_root(), "BR-CO-20", expect=False)

    def test_br_co_20_start_date_alone_holds(self):
        r = _good_root()
        self.add_line_period(r, start=True)
        self.assert_fired(r, "BR-CO-20", expect=False)

    # ---- BR-CO-21 / BR-CO-22 ---------------------------------------------------
    def test_br_co_21_reasonless_doc_allowance_fires(self):
        r = _good_root()
        self.add_doc_ac(r, charge=False)
        got = _fired_ids(r)
        self.assertIn("BR-CO-21", got)
        self.assertNotIn("BR-CO-22", got)
        self.assert_fired(_good_root(), "BR-CO-21", expect=False)

    def test_br_co_21_with_reason_holds(self):
        r = _good_root()
        self.add_doc_ac(r, charge=False, reason="Promotion discount")
        self.assert_fired(r, "BR-CO-21", expect=False)

    def test_br_co_22_reasonless_doc_charge_fires(self):
        r = _good_root()
        self.add_doc_ac(r, charge=True)
        self.assert_fired(r, "BR-CO-22")

    # ---- BR-CO-23 / BR-CO-24 ----------------------------------------------------
    def test_br_co_23_reasonless_line_allowance_fires(self):
        r = _good_root()
        self.add_line_ac(r, charge=False)
        got = _fired_ids(r)
        self.assertIn("BR-CO-23", got)
        self.assertNotIn("BR-CO-24", got)
        self.assert_fired(_good_root(), "BR-CO-23", expect=False)

    def test_br_co_24_reasonless_line_charge_fires(self):
        r = _good_root()
        self.add_line_ac(r, charge=True)
        self.assert_fired(r, "BR-CO-24")

    def test_br_co_24_with_reason_holds(self):
        r = _good_root()
        self.add_line_ac(r, charge=True, reason="Freight")
        self.assert_fired(r, "BR-CO-24", expect=False)

    # ---- BR-DEC-24/25/27/28 ------------------------------------------------------
    def test_br_dec_24_three_decimal_allowance_amount_fires(self):
        r = _good_root()
        self.add_line_ac(r, charge=False, amount="1.123", reason="Discount")
        self.assert_fired(r, "BR-DEC-24")
        self.assert_fired(_good_root(), "BR-DEC-24", expect=False)

    def test_br_dec_25_three_decimal_allowance_base_fires(self):
        r = _good_root()
        self.add_line_ac(r, charge=False, amount="1.12", base="10.123",
                         reason="Discount")
        got = _fired_ids(r)
        self.assertIn("BR-DEC-25", got)
        self.assertNotIn("BR-DEC-24", got)

    def test_br_dec_27_three_decimal_charge_amount_fires(self):
        r = _good_root()
        self.add_line_ac(r, charge=True, amount="1.123", reason="Freight")
        self.assert_fired(r, "BR-DEC-27")

    def test_br_dec_28_three_decimal_charge_base_fires(self):
        r = _good_root()
        self.add_line_ac(r, charge=True, amount="1.12", base="10.123",
                         reason="Freight")
        self.assert_fired(r, "BR-DEC-28")

    def test_br_dec_two_decimals_hold(self):
        r = _good_root()
        self.add_line_ac(r, charge=True, amount="1.12", base="10.12",
                         reason="Freight")
        got = _fired_ids(r)
        for rid in ("BR-DEC-24", "BR-DEC-25", "BR-DEC-27", "BR-DEC-28"):
            self.assertNotIn(rid, got)

    # ---- BR-CO-26 -------------------------------------------------------------
    def test_br_co_26_no_identifier_fires(self):
        # The base seller carries a SpecifiedLegalOrganization/ID and a VA
        # SpecifiedTaxRegistration (no ram:ID / ram:GlobalID): removing both
        # leaves no accepted identifier.
        r = _good_root()
        seller = self._seller(r)
        seller.remove(seller.find("ram:SpecifiedLegalOrganization", NS))
        seller.remove(seller.find("ram:SpecifiedTaxRegistration", NS))
        self.assert_fired(r, "BR-CO-26")
        self.assert_fired(_good_root(), "BR-CO-26", expect=False)

    def test_br_co_26_plain_ram_id_counts_on_cii(self):
        # (ram:ID) is a CII-accepted seller identifier disjunct.
        r = _good_root()
        seller = self._seller(r)
        seller.remove(seller.find("ram:SpecifiedLegalOrganization", NS))
        seller.remove(seller.find("ram:SpecifiedTaxRegistration", NS))
        sid = ET.Element(_q(NSA, "ID"))
        sid.text = "SUP-1"
        seller.insert(0, sid)
        self.assert_fired(r, "BR-CO-26", expect=False)

    def test_br_co_26_non_va_registration_does_not_count(self):
        # The tax-registration disjunct requires the RAW @schemeID='VA'; an
        # FC-schemed registration alone leaves the seller unidentified.
        r = _good_root()
        seller = self._seller(r)
        seller.remove(seller.find("ram:SpecifiedLegalOrganization", NS))
        for id_el in seller.findall("ram:SpecifiedTaxRegistration/ram:ID", NS):
            id_el.set("schemeID", "FC")
        self.assert_fired(r, "BR-CO-26")

    # ---- BR-IC-10 ---------------------------------------------------------------
    def add_k_breakdown(self, r, reason=None):
        settle = _settlement(r)
        first = settle.find("ram:ApplicableTradeTax", NS)
        tt = ET.Element(_q(NSA, "ApplicableTradeTax"))
        ET.SubElement(tt, _q(NSA, "CalculatedAmount")).text = "0.00"
        ET.SubElement(tt, _q(NSA, "TypeCode")).text = "VAT"
        if reason is not None:
            ET.SubElement(tt, _q(NSA, "ExemptionReason")).text = reason
        ET.SubElement(tt, _q(NSA, "BasisAmount")).text = "0.00"
        ET.SubElement(tt, _q(NSA, "CategoryCode")).text = "K"
        ET.SubElement(tt, _q(NSA, "RateApplicablePercent")).text = "0"
        settle.insert(list(settle).index(first), tt)

    def test_br_ic_10_k_breakdown_without_reason_fires(self):
        r = _good_root()
        self.add_k_breakdown(r)
        self.assert_fired(r, "BR-IC-10")
        self.assert_fired(_good_root(), "BR-IC-10", expect=False)

    def test_br_ic_10_reason_text_holds(self):
        r = _good_root()
        self.add_k_breakdown(r, reason="Intra-community supply")
        self.assert_fired(r, "BR-IC-10", expect=False)

    # ---- BR-S-08 ------------------------------------------------------------------
    def test_br_s_08_basis_off_by_two_fires(self):
        r = _good_root()
        _first_breakdown(r).find("ram:BasisAmount", NS).text = "185.23"
        got = _fired_ids(r)
        self.assertIn("BR-S-08", got)
        self.assertNotIn("BR-CO-17", got)   # tax 10.99 still within ±1
        self.assert_fired(_good_root(), "BR-S-08", expect=False)

    def test_br_s_08_exact_equality_on_cii(self):
        # The CII binding is EXACT round2 equality (no UBL-style ±1 band):
        # one cent off the 6% bucket sum (183.23) already fires.
        r = _good_root()
        _first_breakdown(r).find("ram:BasisAmount", NS).text = "183.24"
        self.assert_fired(r, "BR-S-08")

    def test_br_s_08_recategorized_line_leaves_the_bucket(self):
        # Re-code the first line (19.9 at 6%) off 'S': the 6% bucket sum
        # drops by 19.9 and the stated 183.23 no longer matches.
        r = _good_root()
        line_tt = _first_line(r).find(
            "ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax", NS)
        line_tt.find("ram:CategoryCode", NS).text = "E"
        self.assert_fired(r, "BR-S-08")

    def test_br_s_08_missing_rate_is_vacuous(self):
        # every $rate in ../ram:RateApplicablePercent/xs:decimal(.) over an
        # absent rate is vacuously true (BR-48 fires for the missing BT-119).
        r = _good_root()
        bd = _first_breakdown(r)
        bd.remove(bd.find("ram:RateApplicablePercent", NS))
        got = _fired_ids(r)
        self.assertNotIn("BR-S-08", got)
        self.assertIn("BR-48", got)


class TestIgicBatchBCII(unittest.TestCase):
    """CII-side coverage for the IGIC batch B — BR-AF-01..10 over the CII
    model. Pins the CII-binding specifics the differential leg proved:

      * the rate rules (BR-AF-05/06/07) require ``RateApplicablePercent > 0``
        on CII (strictly greater — the UBL binding accepts 0);
      * BR-AF-08 applies the EXACT per-rate round2 bucket equality (BR-S-08's
        proven CII idiom). The SHIPPED CII assert is vacuously bound (its
        context is the ApplicableTradeTax row, so ``../RateApplicablePercent``
        is empty and ``every $rate in ()`` always holds) and can never fire —
        the engine asserts the intended arithmetic anyway, CII-ungraded;
      * BR-AF-09 is engine-asserted on the CII model too (the official CII
        artifact ships it as ``test="true()"``, so it is deliberately NOT
        CII-graded in the differential — the engine checks the real
        arithmetic on both syntaxes).
    """

    def assert_fired(self, root, rule_id, expect=True):
        got = _fired_ids(root)
        if expect:
            self.assertIn(rule_id, got,
                          "%s should fire; fired=%s" % (rule_id, sorted(got)))
        else:
            self.assertNotIn(rule_id, got,
                             "%s should NOT fire" % rule_id)

    # ---- helpers -----------------------------------------------------------
    def _to_igic(self, r):
        """Flip every S CategoryCode (20 lines + 2 breakdown rows) to L: a
        clean IGIC invoice — the 6/21 rates satisfy the CII > 0 predicate and
        the bucket arithmetic is untouched."""
        txn = r.find("rsm:SupplyChainTradeTransaction", NS)
        for cc in txn.iter(_q(NSA, "CategoryCode")):
            if cc.text == "S":
                cc.text = "L"

    def _igic_root(self):
        r = _good_root()
        self._to_igic(r)
        return r

    def _line_tax(self, r):
        return _first_line(r).find(
            "ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax", NS)

    def _seller(self, r):
        return r.find("rsm:SupplyChainTradeTransaction/"
                      "ram:ApplicableHeaderTradeAgreement/"
                      "ram:SellerTradeParty", NS)

    def _add_igic_ac(self, r, charge, rate):
        """Document allowance/charge with an IGIC (L) CategoryTradeTax;
        ActualAmount 0.00 keeps the totals and bucket sums unchanged."""
        ac = ET.SubElement(_settlement(r),
                           _q(NSA, "SpecifiedTradeAllowanceCharge"))
        ind = ET.SubElement(ac, _q(NSA, "ChargeIndicator"))
        ET.SubElement(
            ind, "{urn:un:unece:uncefact:data:standard:"
                 "UnqualifiedDataType:100}Indicator").text = (
            "true" if charge else "false")
        ET.SubElement(ac, _q(NSA, "ActualAmount")).text = "0.00"
        ET.SubElement(ac, _q(NSA, "Reason")).text = (
            "Freight" if charge else "Discount")
        ctt = ET.SubElement(ac, _q(NSA, "CategoryTradeTax"))
        ET.SubElement(ctt, _q(NSA, "TypeCode")).text = "VAT"
        ET.SubElement(ctt, _q(NSA, "CategoryCode")).text = "L"
        ET.SubElement(ctt, _q(NSA, "RateApplicablePercent")).text = rate

    # ---- the clean converted base -----------------------------------------
    def test_clean_igic_invoice_fires_nothing(self):
        fired = _fired_ids(self._igic_root())
        self.assertEqual(
            fired, set(),
            "clean all-L CII invoice unexpectedly fired: %s" % sorted(fired))

    # ---- BR-AF-01 ------------------------------------------------------------
    def test_01_l_line_without_l_breakdown_fires(self):
        r = _good_root()
        self._line_tax(r).find("ram:CategoryCode", NS).text = "L"
        self.assert_fired(r, "BR-AF-01")
        self.assert_fired(self._igic_root(), "BR-AF-01", expect=False)

    # ---- BR-AF-02..04: seller VAT/tax registration ---------------------------
    def test_02_line_without_seller_registration_fires(self):
        r = self._igic_root()
        seller = self._seller(r)
        seller.remove(seller.find("ram:SpecifiedTaxRegistration", NS))
        self.assert_fired(r, "BR-AF-02")
        self.assert_fired(self._igic_root(), "BR-AF-02", expect=False)

    def test_03_allowance_without_seller_registration_fires(self):
        r = _good_root()
        self._add_igic_ac(r, charge=False, rate="21")
        seller = self._seller(r)
        seller.remove(seller.find("ram:SpecifiedTaxRegistration", NS))
        self.assert_fired(r, "BR-AF-03")
        r2 = _good_root()
        self._add_igic_ac(r2, charge=False, rate="21")
        self.assert_fired(r2, "BR-AF-03", expect=False)

    def test_04_charge_without_seller_registration_fires(self):
        r = _good_root()
        self._add_igic_ac(r, charge=True, rate="21")
        seller = self._seller(r)
        seller.remove(seller.find("ram:SpecifiedTaxRegistration", NS))
        self.assert_fired(r, "BR-AF-04")

    # ---- BR-AF-05..07: the CII binding requires rate > 0 ---------------------
    def test_05_zero_rate_line_fires_on_cii(self):
        # UBL accepts a 0% IGIC rate ((Percent) >= 0); the CII artifact tests
        # RateApplicablePercent > 0, so zero FIRES here.
        r = self._igic_root()
        self._line_tax(r).find("ram:RateApplicablePercent", NS).text = "0"
        self.assert_fired(r, "BR-AF-05")
        self.assert_fired(self._igic_root(), "BR-AF-05", expect=False)

    def test_06_zero_rate_allowance_fires_on_cii(self):
        r = _good_root()
        self._add_igic_ac(r, charge=False, rate="0")
        self.assert_fired(r, "BR-AF-06")
        r2 = _good_root()
        self._add_igic_ac(r2, charge=False, rate="21")
        self.assert_fired(r2, "BR-AF-06", expect=False)

    def test_07_zero_rate_charge_fires_on_cii(self):
        r = _good_root()
        self._add_igic_ac(r, charge=True, rate="0")
        self.assert_fired(r, "BR-AF-07")

    # ---- BR-AF-08: EXACT per-rate round2 bucket equality (engine; the
    # shipped CII assert is vacuously bound and never fires -> CII-ungraded) --
    def test_08_shifted_basis_fires(self):
        # +2 off the L/6 bucket (183.23 -> 185.23): the CII equality is exact,
        # so even this small shift fires (no ±1 band on CII).
        r = self._igic_root()
        _first_breakdown(r).find("ram:BasisAmount", NS).text = "185.23"
        self.assert_fired(r, "BR-AF-08")
        self.assert_fired(self._igic_root(), "BR-AF-08", expect=False)

    def test_08_off_by_a_cent_fires(self):
        r = self._igic_root()
        _first_breakdown(r).find("ram:BasisAmount", NS).text = "183.24"
        self.assert_fired(r, "BR-AF-08")

    # ---- BR-AF-09: engine-asserted on CII (officially a tautology) -----------
    def test_09_tax_far_from_taxable_times_rate_fires(self):
        # The official CII artifact ships BR-AF-09 as test="true()" (never
        # fires); the ENGINE deliberately asserts the real ±1 band on the CII
        # model too — this pins that strictness (CII-ungraded by design).
        r = self._igic_root()
        _first_breakdown(r).find("ram:CalculatedAmount", NS).text = "99.99"
        self.assert_fired(r, "BR-AF-09")
        self.assert_fired(self._igic_root(), "BR-AF-09", expect=False)

    # ---- BR-AF-10: exemption reason forbidden --------------------------------
    def test_10_exemption_reason_fires(self):
        r = self._igic_root()
        bd = _first_breakdown(r)
        rate = bd.find("ram:RateApplicablePercent", NS)
        reason = ET.Element(_q(NSA, "ExemptionReason"))
        reason.text = "n/a"
        bd.insert(list(bd).index(rate), reason)
        self.assert_fired(r, "BR-AF-10")
        self.assert_fired(self._igic_root(), "BR-AF-10", expect=False)


class TestIpsiSplitPaymentBatchCCII(unittest.TestCase):
    """CII-side coverage for batch C — BR-AG-01..10 (IPSI, 'M') and
    BR-B-01/02 (Italian split payment, 'B') over the CII model. Pins the
    CII-binding specifics the differential leg proved:

      * the BR-AG rate rules (05/06/07) are ``ram:RateApplicablePercent >= 0``
        on CII — the SAME predicate as UBL, so a ZERO rate HOLDS (the one
        place the M family differs from the L family, whose CII binding is
        strictly ``> 0``);
      * BR-AG-08 applies the EXACT per-rate round2 bucket equality (BR-S-08's
        proven CII idiom). The SHIPPED CII assert is vacuously bound (its
        context is the ApplicableTradeTax row, so ``../RateApplicablePercent``
        is empty and ``every $rate in ()`` always holds) and can never fire —
        the engine asserts the intended arithmetic anyway, CII-ungraded;
      * BR-AG-09 is engine-asserted on the CII model too (the official CII
        artifact ships it as ``test="true()"`` — CII-ungraded by design);
      * BR-B-01/02 are raw ``//ram:CategoryCode`` / ``//ram:CountryID``
        comparisons — fully CII-graded in the differential.
    """

    def assert_fired(self, root, rule_id, expect=True):
        got = _fired_ids(root)
        if expect:
            self.assertIn(rule_id, got,
                          "%s should fire; fired=%s" % (rule_id, sorted(got)))
        else:
            self.assertNotIn(rule_id, got,
                             "%s should NOT fire" % rule_id)

    # ---- helpers -----------------------------------------------------------
    def _to_ipsi(self, r):
        """Flip every S CategoryCode (20 lines + 2 breakdown rows) to M: a
        clean IPSI invoice — the 6/21 rates satisfy the CII >= 0 predicate
        and the bucket arithmetic is untouched."""
        txn = r.find("rsm:SupplyChainTradeTransaction", NS)
        for cc in txn.iter(_q(NSA, "CategoryCode")):
            if cc.text == "S":
                cc.text = "M"

    def _ipsi_root(self):
        r = _good_root()
        self._to_ipsi(r)
        return r

    def _line_tax(self, r):
        return _first_line(r).find(
            "ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax", NS)

    def _seller(self, r):
        return r.find("rsm:SupplyChainTradeTransaction/"
                      "ram:ApplicableHeaderTradeAgreement/"
                      "ram:SellerTradeParty", NS)

    def _add_ipsi_ac(self, r, charge, rate):
        """Document allowance/charge with an IPSI (M) CategoryTradeTax;
        ActualAmount 0.00 keeps the totals and bucket sums unchanged."""
        ac = ET.SubElement(_settlement(r),
                           _q(NSA, "SpecifiedTradeAllowanceCharge"))
        ind = ET.SubElement(ac, _q(NSA, "ChargeIndicator"))
        ET.SubElement(
            ind, "{urn:un:unece:uncefact:data:standard:"
                 "UnqualifiedDataType:100}Indicator").text = (
            "true" if charge else "false")
        ET.SubElement(ac, _q(NSA, "ActualAmount")).text = "0.00"
        ET.SubElement(ac, _q(NSA, "Reason")).text = (
            "Freight" if charge else "Discount")
        ctt = ET.SubElement(ac, _q(NSA, "CategoryTradeTax"))
        ET.SubElement(ctt, _q(NSA, "TypeCode")).text = "VAT"
        ET.SubElement(ctt, _q(NSA, "CategoryCode")).text = "M"
        ET.SubElement(ctt, _q(NSA, "RateApplicablePercent")).text = rate

    # ---- the clean converted base -----------------------------------------
    def test_clean_ipsi_invoice_fires_nothing(self):
        fired = _fired_ids(self._ipsi_root())
        self.assertEqual(
            fired, set(),
            "clean all-M CII invoice unexpectedly fired: %s" % sorted(fired))

    # ---- BR-AG-01 ------------------------------------------------------------
    def test_01_m_line_without_m_breakdown_fires(self):
        r = _good_root()
        self._line_tax(r).find("ram:CategoryCode", NS).text = "M"
        self.assert_fired(r, "BR-AG-01")
        self.assert_fired(self._ipsi_root(), "BR-AG-01", expect=False)

    # ---- BR-AG-02..04: seller VAT/tax registration ---------------------------
    def test_02_line_without_seller_registration_fires(self):
        r = self._ipsi_root()
        seller = self._seller(r)
        seller.remove(seller.find("ram:SpecifiedTaxRegistration", NS))
        self.assert_fired(r, "BR-AG-02")
        self.assert_fired(self._ipsi_root(), "BR-AG-02", expect=False)

    def test_03_allowance_without_seller_registration_fires(self):
        r = _good_root()
        self._add_ipsi_ac(r, charge=False, rate="21")
        seller = self._seller(r)
        seller.remove(seller.find("ram:SpecifiedTaxRegistration", NS))
        self.assert_fired(r, "BR-AG-03")
        r2 = _good_root()
        self._add_ipsi_ac(r2, charge=False, rate="21")
        self.assert_fired(r2, "BR-AG-03", expect=False)

    def test_04_charge_without_seller_registration_fires(self):
        r = _good_root()
        self._add_ipsi_ac(r, charge=True, rate="21")
        seller = self._seller(r)
        seller.remove(seller.find("ram:SpecifiedTaxRegistration", NS))
        self.assert_fired(r, "BR-AG-04")

    # ---- BR-AG-05..07: the CII binding is >= 0 (zero HOLDS, unlike BR-AF) ----
    def test_05_negative_rate_line_fires_zero_holds(self):
        r = self._ipsi_root()
        self._line_tax(r).find("ram:RateApplicablePercent", NS).text = "-5"
        self.assert_fired(r, "BR-AG-05")
        r2 = self._ipsi_root()
        self._line_tax(r2).find("ram:RateApplicablePercent", NS).text = "0"
        # RateApplicablePercent >= 0 — zero is a valid IPSI rate on CII
        # (BR-AF-05 would fire here; the M binding is the UBL predicate).
        self.assert_fired(r2, "BR-AG-05", expect=False)

    def test_06_negative_rate_allowance_fires_zero_holds(self):
        r = _good_root()
        self._add_ipsi_ac(r, charge=False, rate="-5")
        self.assert_fired(r, "BR-AG-06")
        r2 = _good_root()
        self._add_ipsi_ac(r2, charge=False, rate="0")
        self.assert_fired(r2, "BR-AG-06", expect=False)

    def test_07_negative_rate_charge_fires_zero_holds(self):
        r = _good_root()
        self._add_ipsi_ac(r, charge=True, rate="-5")
        self.assert_fired(r, "BR-AG-07")
        r2 = _good_root()
        self._add_ipsi_ac(r2, charge=True, rate="0")
        self.assert_fired(r2, "BR-AG-07", expect=False)

    # ---- BR-AG-08: EXACT per-rate round2 bucket equality (engine; the
    # shipped CII assert is vacuously bound and never fires -> CII-ungraded) --
    def test_08_shifted_basis_fires(self):
        r = self._ipsi_root()
        _first_breakdown(r).find("ram:BasisAmount", NS).text = "185.23"
        self.assert_fired(r, "BR-AG-08")
        self.assert_fired(self._ipsi_root(), "BR-AG-08", expect=False)

    def test_08_off_by_a_cent_fires(self):
        # No ±1 band on the CII idiom — even one cent off fires.
        r = self._ipsi_root()
        _first_breakdown(r).find("ram:BasisAmount", NS).text = "183.24"
        self.assert_fired(r, "BR-AG-08")

    # ---- BR-AG-09: engine-asserted on CII (officially a tautology) -----------
    def test_09_tax_far_from_taxable_times_rate_fires(self):
        r = self._ipsi_root()
        _first_breakdown(r).find("ram:CalculatedAmount", NS).text = "99.99"
        self.assert_fired(r, "BR-AG-09")
        self.assert_fired(self._ipsi_root(), "BR-AG-09", expect=False)

    # ---- BR-AG-10: exemption reason forbidden --------------------------------
    def test_10_exemption_reason_fires(self):
        r = self._ipsi_root()
        bd = _first_breakdown(r)
        rate = bd.find("ram:RateApplicablePercent", NS)
        reason = ET.Element(_q(NSA, "ExemptionReason"))
        reason.text = "n/a"
        bd.insert(list(bd).index(rate), reason)
        self.assert_fired(r, "BR-AG-10")
        self.assert_fired(self._ipsi_root(), "BR-AG-10", expect=False)

    # ---- BR-B-01/02: Italian split payment ------------------------------------
    def _to_split_payment(self, r, domestic=True):
        """Flip every S CategoryCode to B; with ``domestic`` also set both
        ram:CountryID elements (CII_example1 is Dutch) to IT so BR-B-01's
        not(//ram:CountryID != 'IT') holds."""
        txn = r.find("rsm:SupplyChainTradeTransaction", NS)
        for cc in txn.iter(_q(NSA, "CategoryCode")):
            if cc.text == "S":
                cc.text = "B"
        if domestic:
            for el in r.iter(_q(NSA, "CountryID")):
                el.text = "IT"

    def test_b01_foreign_split_payment_fires(self):
        r = _good_root()
        self._to_split_payment(r, domestic=False)   # countries stay NL
        self.assert_fired(r, "BR-B-01")

    def test_b01_domestic_italian_holds(self):
        r = _good_root()
        self._to_split_payment(r, domestic=True)
        got = _fired_ids(r)
        self.assertEqual(got, set(),
                         "clean domestic split-payment CII invoice "
                         "unexpectedly fired: %s" % sorted(got))

    def test_b01_no_b_category_holds(self):
        self.assert_fired(_good_root(), "BR-B-01", expect=False)

    def test_b02_b_and_s_coexist_fires(self):
        r = _good_root()
        self._line_tax(r).find("ram:CategoryCode", NS).text = "B"
        for el in r.iter(_q(NSA, "CountryID")):
            el.text = "IT"                          # keep BR-B-01 out
        got = _fired_ids(r)
        self.assertIn("BR-B-02", got)
        self.assertNotIn("BR-B-01", got)

    def test_b02_all_b_holds(self):
        r = _good_root()
        self._to_split_payment(r, domestic=True)
        self.assert_fired(r, "BR-B-02", expect=False)


# --------------------------------------------------------------------------- #
# KoSIT-vendored Peppol batch 1 (PEPPOL-EN16931-R*), CII binding.             #
# The rules run over the RAW CrossIndustryInvoice tree (rules like R008       #
# constrain the literal document, not a normalized model). Firing +           #
# non-firing fixtures per assert, off the clean XRechnung-CII invoice 01.02a  #
# (fires NONE of the batch on the official KoSIT XSLT — agreement proven      #
# exhaustively by `differential.py xrechnung-cii`).                            #
# --------------------------------------------------------------------------- #
from einvoice import rules_peppol                      # noqa: E402

NSU = parser_cii.NS_UDT


def _pep(rid):
    return "PEPPOL-EN16931-" + rid


def _pep_cii_root():
    return ET.parse(XR_CII_GOOD).getroot()


def _pep_cii_fired(r):
    return {v.rule_id for v in rules_peppol.evaluate_cii(r)}


class PeppolKositBatch1Cii(unittest.TestCase):
    """CII-binding fixtures for the 11 implemented PEPPOL-EN16931-R* rules
    (12 vendored asserts — R043 is split into -1/-2 in the CII artifact)."""

    def _settlement(self, r):
        return r.find("rsm:SupplyChainTradeTransaction/"
                      "ram:ApplicableHeaderTradeSettlement", NS)

    def _line_agreement(self, r):
        return r.find("rsm:SupplyChainTradeTransaction/"
                      "ram:IncludedSupplyChainTradeLineItem/"
                      "ram:SpecifiedLineTradeAgreement", NS)

    def add_header_allowance(self, r, indicator="false", actual=None,
                             basis=None, percent=None):
        """ram:SpecifiedTradeAllowanceCharge in the header settlement."""
        settle = self._settlement(r)
        ac = ET.SubElement(settle, _q(NSA, "SpecifiedTradeAllowanceCharge"))
        if indicator is not None:
            ci = ET.SubElement(ac, _q(NSA, "ChargeIndicator"))
            ET.SubElement(ci, _q(NSU, "Indicator")).text = indicator
        if percent is not None:
            ET.SubElement(ac, _q(NSA, "CalculationPercent")).text = percent
        if basis is not None:
            ET.SubElement(ac, _q(NSA, "BasisAmount")).text = basis
        if actual is not None:
            ET.SubElement(ac, _q(NSA, "ActualAmount")).text = actual
        return ac

    def add_gross_price(self, r, indicator, charge, actual):
        """ram:GrossPriceProductTradePrice (with an AppliedTradeAllowanceCharge
        when ``actual``/``indicator`` given) on the first line, whose
        NetPriceProductTradePrice/ChargeAmount in the 01.02a base is 11.78."""
        agr = self._line_agreement(r)
        gp = ET.Element(_q(NSA, "GrossPriceProductTradePrice"))
        if charge is not None:
            ET.SubElement(gp, _q(NSA, "ChargeAmount")).text = charge
        if indicator is not None or actual is not None:
            atac = ET.SubElement(gp, _q(NSA, "AppliedTradeAllowanceCharge"))
            if indicator is not None:
                ci = ET.SubElement(atac, _q(NSA, "ChargeIndicator"))
                ET.SubElement(ci, _q(NSU, "Indicator")).text = indicator
            if actual is not None:
                ET.SubElement(atac, _q(NSA, "ActualAmount")).text = actual
        agr.insert(0, gp)
        return gp

    # ---- clean base ---------------------------------------------------------
    def test_clean_base_fires_none(self):
        self.assertEqual(_pep_cii_fired(_pep_cii_root()), set())

    # ---- R001 ---------------------------------------------------------------
    def test_r001_missing_business_process_fires(self):
        r = _pep_cii_root()
        ctx = r.find("rsm:ExchangedDocumentContext", NS)
        ctx.remove(ctx.find(
            "ram:BusinessProcessSpecifiedDocumentContextParameter", NS))
        self.assertEqual(_pep_cii_fired(r), {_pep("R001")})

    # ---- R005 ---------------------------------------------------------------
    # Since batch 2, a BT-6 with no second TaxTotalAmount ALSO fires R054
    # (and R055 when no tax-currency total exists) — exactly like the
    # official artifact on the same fixture (differential-proven), so these
    # fixtures now assert the full fired set.
    def test_r005_tax_currency_equal_to_invoice_currency_fires(self):
        r = _pep_cii_root()
        settle = self._settlement(r)
        icc = settle.find("ram:InvoiceCurrencyCode", NS)
        tcc = ET.Element(_q(NSA, "TaxCurrencyCode"))
        tcc.text = icc.text
        settle.insert(list(settle).index(icc), tcc)
        # R055 holds here: the (positive) EUR TaxTotalAmount satisfies BOTH
        # sides of the sign check when BT-6 == BT-5 == EUR.
        self.assertEqual(_pep_cii_fired(r), {_pep("R005"), _pep("R054")})

    def test_r005_different_tax_currency_holds(self):
        r = _pep_cii_root()
        settle = self._settlement(r)
        icc = settle.find("ram:InvoiceCurrencyCode", NS)
        tcc = ET.Element(_q(NSA, "TaxCurrencyCode"))
        tcc.text = "USD"
        settle.insert(list(settle).index(icc), tcc)
        fired = _pep_cii_fired(r)
        self.assertNotIn(_pep("R005"), fired)
        # The engaged batch-2 totals rules fire on this minimal fixture (no
        # USD TaxTotalAmount exists): R054 + R055, nothing else.
        self.assertEqual(fired, {_pep("R054"), _pep("R055")})

    # ---- R008 ---------------------------------------------------------------
    def test_r008_empty_element_fires(self):
        r = _pep_cii_root()
        exdoc = r.find("rsm:ExchangedDocument", NS)
        ET.SubElement(exdoc, _q(NSA, "IncludedNote"))
        self.assertEqual(_pep_cii_fired(r), {_pep("R008")})

    def test_r008_empty_header_trade_delivery_is_exempt(self):
        # The CII context EXCLUDES ram:ApplicableHeaderTradeDelivery — the one
        # schema-mandatory element a CII invoice may legitimately leave empty.
        r = _pep_cii_root()
        delivery = r.find("rsm:SupplyChainTradeTransaction/"
                          "ram:ApplicableHeaderTradeDelivery", NS)
        for kid in list(delivery):
            delivery.remove(kid)
        delivery.text = None
        self.assertEqual(len(list(delivery)), 0)
        self.assertEqual(_pep_cii_fired(r), set())

    def test_r008_element_with_text_holds(self):
        r = _pep_cii_root()
        exdoc = r.find("rsm:ExchangedDocument", NS)
        note = ET.SubElement(exdoc, _q(NSA, "IncludedNote"))
        ET.SubElement(note, _q(NSA, "Content")).text = "real content"
        self.assertEqual(_pep_cii_fired(r), set())

    # ---- R010 / R020 --------------------------------------------------------
    def _header_agreement(self, r):
        return r.find("rsm:SupplyChainTradeTransaction/"
                      "ram:ApplicableHeaderTradeAgreement", NS)

    def test_r010_missing_buyer_uri_fires(self):
        r = _pep_cii_root()
        buyer = self._header_agreement(r).find("ram:BuyerTradeParty", NS)
        buyer.remove(buyer.find("ram:URIUniversalCommunication", NS))
        self.assertEqual(_pep_cii_fired(r), {_pep("R010")})

    def test_r020_missing_seller_uri_fires(self):
        r = _pep_cii_root()
        seller = self._header_agreement(r).find("ram:SellerTradeParty", NS)
        seller.remove(seller.find("ram:URIUniversalCommunication", NS))
        self.assertEqual(_pep_cii_fired(r), {_pep("R020")})

    # ---- R040 (slack band) --------------------------------------------------
    def test_r040_amount_off_the_percentage_fires(self):
        r = _pep_cii_root()
        self.add_header_allowance(r, actual="10.00", basis="100.00",
                                  percent="25")
        self.assertEqual(_pep_cii_fired(r), {_pep("R040")})

    def test_r040_amount_within_slack_holds(self):
        r = _pep_cii_root()
        self.add_header_allowance(r, actual="25.01", basis="100.00",
                                  percent="25")
        self.assertEqual(_pep_cii_fired(r), set())

    def test_r040_huf_widens_slack_to_half(self):
        r = _pep_cii_root()
        self._settlement(r).find("ram:InvoiceCurrencyCode", NS).text = "HUF"
        self.add_header_allowance(r, actual="25.40", basis="100.00",
                                  percent="25")
        self.assertNotIn(_pep("R040"), _pep_cii_fired(r))

    def test_r040_absent_actual_counts_as_zero(self):
        r = _pep_cii_root()
        self.add_header_allowance(r, actual=None, basis="100.00", percent="25")
        self.assertEqual(_pep_cii_fired(r), {_pep("R040")})

    # ---- R041 / R042 --------------------------------------------------------
    def test_r041_percentage_without_basis_fires(self):
        r = _pep_cii_root()
        self.add_header_allowance(r, actual="10.00", percent="10")
        self.assertEqual(_pep_cii_fired(r), {_pep("R041")})

    def test_r042_basis_without_percentage_fires(self):
        r = _pep_cii_root()
        self.add_header_allowance(r, actual="10.00", basis="100.00")
        self.assertEqual(_pep_cii_fired(r), {_pep("R042")})

    def test_r041_r042_both_present_hold(self):
        r = _pep_cii_root()
        self.add_header_allowance(r, actual="25.00", basis="100.00",
                                  percent="25")
        self.assertEqual(_pep_cii_fired(r), set())

    # ---- R043 (two vendored asserts) -----------------------------------------
    def test_r043_1_bad_header_indicator_fires(self):
        r = _pep_cii_root()
        self.add_header_allowance(r, indicator="TRUE", actual="10.00")
        self.assertEqual(_pep_cii_fired(r), {_pep("R043")})
        # And specifically via the -1 assert (SpecifiedTradeAllowanceCharge).
        self.assertIsNotNone(rules_peppol.cii_r043_1(r))
        self.assertIsNone(rules_peppol.cii_r043_2(r))

    def test_r043_1_absent_indicator_fires(self):
        r = _pep_cii_root()
        self.add_header_allowance(r, indicator=None, actual="10.00")
        self.assertEqual(_pep_cii_fired(r), {_pep("R043")})

    def test_r043_2_bad_price_indicator_fires(self):
        r = _pep_cii_root()
        # net 11.78 = 12.78 - 1.00 -> R046 holds; TRUE -> R043-2 + R044 fire.
        self.add_gross_price(r, "TRUE", charge="12.78", actual="1.00")
        got = _pep_cii_fired(r)
        self.assertEqual(got, {_pep("R043"), _pep("R044")})
        self.assertIsNone(rules_peppol.cii_r043_1(r))
        self.assertIsNotNone(rules_peppol.cii_r043_2(r))

    def test_r043_normalized_true_holds(self):
        r = _pep_cii_root()
        self.add_header_allowance(r, indicator=" true ", actual="10.00")
        self.assertEqual(_pep_cii_fired(r), set())

    # ---- R044 / R046 (gross price level) --------------------------------------
    def test_r044_price_level_charge_fires(self):
        r = _pep_cii_root()
        self.add_gross_price(r, "true", charge="12.78", actual="1.00")
        self.assertEqual(_pep_cii_fired(r), {_pep("R044")})

    def test_r044_false_indicator_holds(self):
        r = _pep_cii_root()
        self.add_gross_price(r, "false", charge="12.78", actual="1.00")
        self.assertEqual(_pep_cii_fired(r), set())

    def test_r044_untrimmed_false_fires(self):
        # The R044 CII test is node-set = 'false' (NO normalize-space): a
        # padded ' false ' satisfies R043-2 (normalized) but NOT R044.
        r = _pep_cii_root()
        self.add_gross_price(r, " false ", charge="12.78", actual="1.00")
        self.assertEqual(_pep_cii_fired(r), {_pep("R044")})

    def test_r046_gross_minus_allowance_mismatch_fires(self):
        r = _pep_cii_root()
        self.add_gross_price(r, "false", charge="20.00", actual="1.00")
        self.assertEqual(_pep_cii_fired(r), {_pep("R046")})

    def test_r046_absent_allowance_counts_as_zero(self):
        # u:decimalOrZero over an absent ActualAmount -> 0: gross == net holds.
        r = _pep_cii_root()
        self.add_gross_price(r, None, charge="11.78", actual=None)
        self.assertEqual(_pep_cii_fired(r), set())

    def test_r046_no_charge_amount_is_vacuous(self):
        r = _pep_cii_root()
        self.add_gross_price(r, "false", charge=None, actual="1.00")
        # No ram:ChargeAmount -> R046 vacuous; but the empty-ish GrossPrice
        # still carries children, so R008 stays quiet too. R044 fires: an
        # ActualAmount exists and the indicator is 'false' -> holds. Nothing.
        self.assertEqual(_pep_cii_fired(r), set())

    def test_r046_decimal_equality_is_numeric(self):
        r = _pep_cii_root()
        self.add_gross_price(r, "false", charge="12.780", actual="1.000")
        self.assertEqual(_pep_cii_fired(r), set())


# --------------------------------------------------------------------------- #
# KoSIT-vendored Peppol batch 2 (R053-R130), CII binding — same clean 01.02a  #
# base (one line: BilledQuantity 1 XPP, net ChargeAmount 11.78,               #
# LineTotalAmount 11.78; one EUR TaxTotalAmount 0.82; PaymentMeans TypeCode   #
# 58; one SpecifiedTradePaymentTerms; no BillingSpecifiedPeriod, no BT-6).    #
# Differential agreement proven exhaustively by                                #
# `differential.py xrechnung-cii`.                                             #
# --------------------------------------------------------------------------- #
class PeppolKositBatch2Cii(PeppolKositBatch1Cii):
    """Batch-2 fixtures. Inherits the batch-1 helpers AND re-runs the batch-1
    tests against the grown registry (no cross-rule interference)."""

    def _summation(self, r):
        return self._settlement(r).find(
            "ram:SpecifiedTradeSettlementHeaderMonetarySummation", NS)

    def _line_settlement(self, r):
        return r.find("rsm:SupplyChainTradeTransaction/"
                      "ram:IncludedSupplyChainTradeLineItem/"
                      "ram:SpecifiedLineTradeSettlement", NS)

    def add_tax_currency(self, r, code="USD"):
        settle = self._settlement(r)
        icc = settle.find("ram:InvoiceCurrencyCode", NS)
        tcc = ET.Element(_q(NSA, "TaxCurrencyCode"))
        tcc.text = code
        settle.insert(list(settle).index(icc), tcc)

    def add_tax_total(self, r, amount, currency):
        summ = self._summation(r)
        existing = summ.find("ram:TaxTotalAmount", NS)
        tta = ET.Element(_q(NSA, "TaxTotalAmount"))
        tta.text = amount
        tta.set("currencyID", currency)
        summ.insert(list(summ).index(existing) + 1, tta)

    def _period(self, start, end):
        bsp = ET.Element(_q(NSA, "BillingSpecifiedPeriod"))
        for tag, val in (("StartDateTime", start), ("EndDateTime", end)):
            if val is not None:
                dt = ET.SubElement(bsp, _q(NSA, tag))
                ds = ET.SubElement(dt, _q(NSU, "DateTimeString"))
                ds.text = val
                ds.set("format", "102")
        return bsp

    def add_header_period(self, r, start=None, end=None):
        settle = self._settlement(r)
        pt = settle.find("ram:SpecifiedTradePaymentTerms", NS)
        settle.insert(list(settle).index(pt), self._period(start, end))

    def add_line_period(self, r, start=None, end=None):
        ls = self._line_settlement(r)
        tax = ls.find("ram:ApplicableTradeTax", NS)
        ls.insert(list(ls).index(tax) + 1, self._period(start, end))

    def set_type_code(self, r, code):
        settle = self._settlement(r)
        settle.find("ram:SpecifiedTradeSettlementPaymentMeans/ram:TypeCode",
                    NS).text = code
        return settle

    def add_line_referenced_doc(self, r, type_code):
        ls = self._line_settlement(r)
        ard = ET.SubElement(ls, _q(NSA, "AdditionalReferencedDocument"))
        ET.SubElement(ard, _q(NSA, "IssuerAssignedID")).text = "LINE-OBJ-1"
        if type_code is not None:
            ET.SubElement(ard, _q(NSA, "TypeCode")).text = type_code

    def add_net_basis_quantity(self, r, value, unit=None):
        npp = self._line_agreement(r).find("ram:NetPriceProductTradePrice",
                                           NS)
        bq = ET.SubElement(npp, _q(NSA, "BasisQuantity"))
        bq.text = value
        if unit is not None:
            bq.set("unitCode", unit)

    # ---- R053 ---------------------------------------------------------------
    def test_r053_second_doc_currency_total_fires(self):
        r = _pep_cii_root()
        self.add_tax_total(r, "0.82", "EUR")
        self.assertEqual(_pep_cii_fired(r), {_pep("R053")})

    def test_r053_second_total_in_other_currency_not_counted(self):
        # Only @currencyID == BT-5 counts toward the <= 1 (but a lone non-EUR
        # total with no BT-6 trips R054's want-0).
        r = _pep_cii_root()
        self.add_tax_total(r, "0.90", "USD")
        self.assertEqual(_pep_cii_fired(r), {_pep("R054")})

    # ---- R054 / R055 --------------------------------------------------------
    def test_r054_tax_currency_without_second_total_fires_with_r055(self):
        r = _pep_cii_root()
        self.add_tax_currency(r)
        self.assertEqual(_pep_cii_fired(r), {_pep("R054"), _pep("R055")})

    def test_r054_r055_engaged_and_holding(self):
        r = _pep_cii_root()
        self.add_tax_currency(r)
        self.add_tax_total(r, "0.90", "USD")
        self.assertEqual(_pep_cii_fired(r), set())

    def test_r055_sign_flip_fires(self):
        r = _pep_cii_root()
        self.add_tax_currency(r)
        self.add_tax_total(r, "-0.82", "USD")
        self.assertEqual(_pep_cii_fired(r), {_pep("R055")})

    def test_r055_zero_on_tax_side_is_strict_negative_check(self):
        # The CII first alternative is STRICT '< 0' (unlike UBL's '<= 0'),
        # but 0 still satisfies the second alternative ('>= 0' both sides).
        r = _pep_cii_root()
        self.add_tax_currency(r)
        self.add_tax_total(r, "0", "USD")
        self.assertEqual(_pep_cii_fired(r), set())

    # ---- R061 ---------------------------------------------------------------
    def test_r061_direct_debit_without_mandate_fires(self):
        r = _pep_cii_root()
        self.set_type_code(r, "59")
        self.assertEqual(_pep_cii_fired(r), {_pep("R061")})

    def test_r061_code_49_also_fires(self):
        r = _pep_cii_root()
        self.set_type_code(r, "49")
        self.assertEqual(_pep_cii_fired(r), {_pep("R061")})

    def test_r061_with_mandate_holds(self):
        r = _pep_cii_root()
        settle = self.set_type_code(r, "59")
        pt = settle.find("ram:SpecifiedTradePaymentTerms", NS)
        ET.SubElement(pt, _q(NSA, "DirectDebitMandateID")).text = "MANDATE-1"
        self.assertEqual(_pep_cii_fired(r), set())

    def test_r061_other_code_not_engaged(self):
        r = _pep_cii_root()
        self.set_type_code(r, "30")
        self.assertEqual(_pep_cii_fired(r), set())

    # ---- R101 ---------------------------------------------------------------
    def test_r101_line_referenced_doc_fires(self):
        r = _pep_cii_root()
        self.add_line_referenced_doc(r, "916")
        self.assertEqual(_pep_cii_fired(r), {_pep("R101")})

    def test_r101_missing_type_code_fires(self):
        r = _pep_cii_root()
        self.add_line_referenced_doc(r, None)
        self.assertEqual(_pep_cii_fired(r), {_pep("R101")})

    def test_r101_invoice_line_object_130_holds(self):
        r = _pep_cii_root()
        self.add_line_referenced_doc(r, "130")
        self.assertEqual(_pep_cii_fired(r), set())

    # ---- R110 / R111 --------------------------------------------------------
    def test_r110_line_starts_before_header_period_fires(self):
        r = _pep_cii_root()
        self.add_header_period(r, start="20160201")
        self.add_line_period(r, start="20160101")
        self.assertEqual(_pep_cii_fired(r), {_pep("R110")})

    def test_r111_line_ends_after_header_period_fires(self):
        r = _pep_cii_root()
        self.add_header_period(r, end="20160630")
        self.add_line_period(r, end="20161231")
        self.assertEqual(_pep_cii_fired(r), {_pep("R111")})

    def test_r110_r111_line_within_header_period_holds(self):
        r = _pep_cii_root()
        self.add_header_period(r, start="20160101", end="20161231")
        self.add_line_period(r, start="20160601", end="20160630")
        self.assertEqual(_pep_cii_fired(r), set())

    def test_r110_header_period_without_line_period_not_engaged(self):
        # The context needs a LINE StartDateTime; a header-only period is
        # fine.
        r = _pep_cii_root()
        self.add_header_period(r, start="20160101")
        self.assertEqual(_pep_cii_fired(r), set())

    def test_r110_line_period_without_header_period_not_engaged(self):
        # The transaction filter needs the HEADER StartDateTime.
        r = _pep_cii_root()
        self.add_line_period(r, start="20150101")
        self.assertEqual(_pep_cii_fired(r), set())

    def test_r110_string_comparison_of_format_102(self):
        # Untyped-vs-untyped general comparison = STRING comparison: equal
        # boundary strings hold.
        r = _pep_cii_root()
        self.add_header_period(r, start="20160101")
        self.add_line_period(r, start="20160101")
        self.assertEqual(_pep_cii_fired(r), set())

    # ---- R120 (warning) -----------------------------------------------------
    def _set_line_total(self, r, value):
        ms = self._line_settlement(r).find(
            "ram:SpecifiedTradeSettlementLineMonetarySummation", NS)
        ms.find("ram:LineTotalAmount", NS).text = value

    def test_r120_line_net_amount_mismatch_fires(self):
        r = _pep_cii_root()
        self._set_line_total(r, "21.78")
        self.assertEqual(_pep_cii_fired(r), {_pep("R120")})

    def test_r120_within_slack_holds(self):
        # |11.80 - 11.78| = 0.02 <= slack 0.02 -> holds.
        r = _pep_cii_root()
        self._set_line_total(r, "11.80")
        self.assertEqual(_pep_cii_fired(r), set())

    def test_r120_is_a_warning(self):
        self.assertEqual(rules_peppol.cii_r120.severity, "warning")
        r = _pep_cii_root()
        self._set_line_total(r, "21.78")
        v = [x for x in rules_peppol.evaluate_cii(r)
             if x.rule_id == _pep("R120")]
        self.assertEqual(v[0].severity, "warning")

    def test_r120_net_basis_quantity_divides_price(self):
        # BasisQuantity 2: 1 * (11.78 / 2) = 5.89 != 11.78 -> fires (R121
        # holds: 2 > 0; R130 not engaged: no unitCode attribute).
        r = _pep_cii_root()
        self.add_net_basis_quantity(r, "2")
        self.assertEqual(_pep_cii_fired(r), {_pep("R120")})

    # ---- R121 ---------------------------------------------------------------
    def test_r121_zero_basis_quantity_fires(self):
        # R120's own let maps a ZERO BasisQuantity to divisor 1 -> only R121.
        r = _pep_cii_root()
        self.add_net_basis_quantity(r, "0")
        self.assertEqual(_pep_cii_fired(r), {_pep("R121")})

    def test_r121_negative_basis_quantity_fires_with_r120(self):
        r = _pep_cii_root()
        self.add_net_basis_quantity(r, "-1")
        self.assertEqual(_pep_cii_fired(r), {_pep("R120"), _pep("R121")})

    def test_r121_positive_basis_quantity_holds(self):
        r = _pep_cii_root()
        self.add_net_basis_quantity(r, "1")
        self.assertEqual(_pep_cii_fired(r), set())

    def test_r121_gross_price_basis_quantity_also_in_context(self):
        # The CII context is Net | Gross price: a zero BasisQuantity on a
        # GrossPriceProductTradePrice fires too (gross == net so R046 holds).
        r = _pep_cii_root()
        gp = self.add_gross_price(r, None, charge="11.78", actual=None)
        ET.SubElement(gp, _q(NSA, "BasisQuantity")).text = "0"
        self.assertEqual(_pep_cii_fired(r), {_pep("R121")})

    # ---- R130 ---------------------------------------------------------------
    def test_r130_unit_code_mismatch_fires(self):
        r = _pep_cii_root()
        self.add_net_basis_quantity(r, "1", unit="KGM")
        self.assertEqual(_pep_cii_fired(r), {_pep("R130")})

    def test_r130_matching_unit_code_holds(self):
        r = _pep_cii_root()
        self.add_net_basis_quantity(r, "1", unit="XPP")
        self.assertEqual(_pep_cii_fired(r), set())

    def test_r130_no_billed_quantity_unit_code_fires(self):
        # Unlike UBL, the CII R130 has NO hasQuantity guard: an absent
        # BilledQuantity @unitCode -> the comparison finds nothing -> fires.
        r = _pep_cii_root()
        line = r.find("rsm:SupplyChainTradeTransaction/"
                      "ram:IncludedSupplyChainTradeLineItem", NS)
        bq = line.find("ram:SpecifiedLineTradeDelivery/ram:BilledQuantity",
                       NS)
        del bq.attrib["unitCode"]
        self.add_net_basis_quantity(r, "1", unit="XPP")
        self.assertEqual(_pep_cii_fired(r), {_pep("R130")})


# --------------------------------------------------------------------------- #
# CII proof-parity batch 1 (T-VHCIIP.2): BR-09/11, BR-17..20, BR-28..33,      #
# BR-36..38 — the first 15 cii-fireable rules from cii_parity.json, now       #
# graded on the CII differential leg. Each rule gets a FIRE fixture (the      #
# same field-level breakage differential._CII_MUTATIONS generates, proven     #
# officially-agreeing by `differential.py cii`) and a non-firing variant.     #
# --------------------------------------------------------------------------- #
class CiiProofParityBatch1(unittest.TestCase):
    """Firing + holding CII fixtures for the T-VHCIIP.2 batch-1 rules."""

    def fired(self, root):
        return _fired_ids(root)

    def assert_rule(self, root, rule_id, expect=True):
        fired = self.fired(root)
        if expect:
            self.assertIn(rule_id, fired,
                          "%s should fire; fired=%s" % (rule_id, sorted(fired)))
        else:
            self.assertNotIn(rule_id, fired,
                             "%s should NOT fire; fired=%s"
                             % (rule_id, sorted(fired)))

    def _agreement(self, r):
        return r.find("rsm:SupplyChainTradeTransaction/"
                      "ram:ApplicableHeaderTradeAgreement", NS)

    def _seller(self, r):
        return self._agreement(r).find("ram:SellerTradeParty", NS)

    def _buyer(self, r):
        return self._agreement(r).find("ram:BuyerTradeParty", NS)

    def add_payee(self, r, name=None, id_=None, legal_id=None):
        payee = ET.SubElement(_settlement(r), _q(NSA, "PayeeTradeParty"))
        if id_ is not None:
            ET.SubElement(payee, _q(NSA, "ID")).text = id_
        if name is not None:
            ET.SubElement(payee, _q(NSA, "Name")).text = name
        if legal_id is not None:
            lo = ET.SubElement(payee, _q(NSA, "SpecifiedLegalOrganization"))
            ET.SubElement(lo, _q(NSA, "ID")).text = legal_id
        return payee

    def add_taxrep(self, r, name="Tax handling company AS", with_address=True,
                   country="NO"):
        trp = ET.SubElement(self._agreement(r),
                            _q(NSA, "SellerTaxRepresentativeTradeParty"))
        if name is not None:
            ET.SubElement(trp, _q(NSA, "Name")).text = name
        if with_address:
            pa = ET.SubElement(trp, _q(NSA, "PostalTradeAddress"))
            ET.SubElement(pa, _q(NSA, "CityName")).text = "Newtown"
            if country is not None:
                ET.SubElement(pa, _q(NSA, "CountryID")).text = country
        reg = ET.SubElement(trp, _q(NSA, "SpecifiedTaxRegistration"))
        reg_id = ET.SubElement(reg, _q(NSA, "ID"))
        reg_id.set("schemeID", "VA")
        reg_id.text = "NO967611265MVA"
        return trp

    def add_period(self, r, start=None, end=None, line=False,
                   fmt="102"):
        parent = (_first_line(r).find("ram:SpecifiedLineTradeSettlement", NS)
                  if line else _settlement(r))
        period = ET.SubElement(parent, _q(NSA, "BillingSpecifiedPeriod"))
        for local, value in (("StartDateTime", start), ("EndDateTime", end)):
            if value is None:
                continue
            bound = ET.SubElement(period, _q(NSA, local))
            dts = ET.SubElement(bound, _q(NSU, "DateTimeString"))
            dts.set("format", fmt)
            dts.text = value
        return period

    def add_doc_allowance_charge(self, r, charge, amount="0.00",
                                 reason="Testing", vat_category=False):
        ac = ET.SubElement(_settlement(r),
                           _q(NSA, "SpecifiedTradeAllowanceCharge"))
        ind = ET.SubElement(ac, _q(NSA, "ChargeIndicator"))
        ET.SubElement(ind, _q(NSU, "Indicator")).text = (
            "true" if charge else "false")
        if amount is not None:
            ET.SubElement(ac, _q(NSA, "ActualAmount")).text = amount
        if vat_category:
            cat = ET.SubElement(ac, _q(NSA, "CategoryTradeTax"))
            ET.SubElement(cat, _q(NSA, "TypeCode")).text = "VAT"
            ET.SubElement(cat, _q(NSA, "CategoryCode")).text = "S"
            ET.SubElement(cat, _q(NSA, "RateApplicablePercent")).text = "21"
        if reason is not None:
            ET.SubElement(ac, _q(NSA, "Reason")).text = reason
        return ac

    # ---- BR-09 / BR-11: country code, ROOT-bound on CII ---------------------
    def test_br09_missing_seller_country_code_fires(self):
        r = _good_root()
        _remove(r, self._seller(r).find(
            "ram:PostalTradeAddress/ram:CountryID", NS))
        fired = self.fired(r)
        self.assertIn("BR-09", fired)
        self.assertNotIn("BR-08", fired)  # the address node itself remains

    def test_br09_fires_even_without_postal_address_on_cii(self):
        # The CII binding's context is the DOCUMENT ROOT: stripping the whole
        # seller address fires BR-09 ALONGSIDE BR-08 (unlike UBL, where BR-09
        # is gated on the address node existing) — the T-VHCIIP.2 engine fix.
        r = _good_root()
        _remove(r, self._seller(r).find("ram:PostalTradeAddress", NS))
        fired = self.fired(r)
        self.assertIn("BR-08", fired)
        self.assertIn("BR-09", fired)

    def test_br09_holds_on_clean_base(self):
        self.assert_rule(_good_root(), "BR-09", expect=False)

    def test_br11_missing_buyer_country_code_fires(self):
        r = _good_root()
        _remove(r, self._buyer(r).find(
            "ram:PostalTradeAddress/ram:CountryID", NS))
        fired = self.fired(r)
        self.assertIn("BR-11", fired)
        self.assertNotIn("BR-10", fired)

    def test_br11_fires_even_without_postal_address_on_cii(self):
        r = _good_root()
        _remove(r, self._buyer(r).find("ram:PostalTradeAddress", NS))
        fired = self.fired(r)
        self.assertIn("BR-10", fired)
        self.assertIn("BR-11", fired)

    # ---- BR-17: payee must be named and differ from the seller --------------
    def test_br17_payee_without_name_fires(self):
        r = _good_root()
        self.add_payee(r, id_="PAYEE-4711")
        self.assert_rule(r, "BR-17")

    def test_br17_payee_name_equal_to_seller_fires(self):
        r = _good_root()
        seller_name = self._seller(r).find("ram:Name", NS).text
        self.add_payee(r, name=seller_name)
        self.assert_rule(r, "BR-17")

    def test_br17_payee_legal_id_equal_to_seller_fires(self):
        # The CII-only third conjunct: matching SpecifiedLegalOrganization/ID.
        r = _good_root()
        seller_lo = ET.SubElement(self._seller(r),
                                  _q(NSA, "SpecifiedLegalOrganization"))
        ET.SubElement(seller_lo, _q(NSA, "ID")).text = "LEGAL-1"
        self.add_payee(r, name="Genuinely Different Payee AS",
                       legal_id="LEGAL-1")
        self.assert_rule(r, "BR-17")

    def test_br17_distinct_payee_holds(self):
        r = _good_root()
        self.add_payee(r, name="Genuinely Different Payee AS",
                       id_="PAYEE-4711", legal_id="LEGAL-999")
        self.assert_rule(r, "BR-17", expect=False)

    # ---- BR-18/19/20: seller tax representative ----------------------------
    def test_br18_nameless_taxrep_fires(self):
        r = _good_root()
        self.add_taxrep(r, name=None)
        fired = self.fired(r)
        self.assertIn("BR-18", fired)
        self.assertNotIn("BR-19", fired)
        self.assertNotIn("BR-20", fired)

    def test_br19_addressless_taxrep_fires_with_br20(self):
        # CII binds BR-20 to the trade PARTY, so a representative without a
        # postal address fires BR-19 AND BR-20 (the official CII artifact
        # agrees — proven on the differential leg).
        r = _good_root()
        self.add_taxrep(r, with_address=False)
        fired = self.fired(r)
        self.assertIn("BR-19", fired)
        self.assertIn("BR-20", fired)
        self.assertNotIn("BR-18", fired)

    def test_br20_countryless_address_fires_alone(self):
        r = _good_root()
        self.add_taxrep(r, country=None)
        fired = self.fired(r)
        self.assertIn("BR-20", fired)
        self.assertNotIn("BR-19", fired)

    def test_complete_taxrep_holds(self):
        r = _good_root()
        self.add_taxrep(r)
        fired = self.fired(r)
        for rid in ("BR-18", "BR-19", "BR-20", "BR-56"):
            self.assertNotIn(rid, fired)

    # ---- BR-28: item gross price not negative -------------------------------
    def _add_gross_price(self, r, amount):
        agreement = _first_line(r).find("ram:SpecifiedLineTradeAgreement", NS)
        gp = ET.Element(_q(NSA, "GrossPriceProductTradePrice"))
        ET.SubElement(gp, _q(NSA, "ChargeAmount")).text = amount
        agreement.insert(0, gp)

    def test_br28_negative_gross_price_fires(self):
        r = _good_root()
        self._add_gross_price(r, "-5.00")
        self.assert_rule(r, "BR-28")

    def test_br28_zero_gross_price_holds(self):
        r = _good_root()
        self._add_gross_price(r, "0.00")
        self.assert_rule(r, "BR-28", expect=False)

    def test_br28_no_gross_price_holds(self):
        self.assert_rule(_good_root(), "BR-28", expect=False)

    # ---- BR-29 / BR-30: billing-period ordering ------------------------------
    def test_br29_inverted_header_period_fires(self):
        r = _good_root()
        self.add_period(r, start="20240201", end="20240101")
        fired = self.fired(r)
        self.assertIn("BR-29", fired)
        self.assertNotIn("BR-CO-19", fired)  # the period IS filled

    def test_br29_ordered_header_period_holds(self):
        r = _good_root()
        self.add_period(r, start="20240101", end="20240201")
        self.assert_rule(r, "BR-29", expect=False)

    def test_br29_end_only_period_holds(self):
        r = _good_root()
        self.add_period(r, end="20240201")
        self.assert_rule(r, "BR-29", expect=False)

    def test_br29_non_102_format_fires_when_both_bounds_present(self):
        # The official comparison reads ONLY @format='102' DateTimeStrings; a
        # present bound without one leaves the operand empty, so the >= is
        # false while both not(...) disjuncts are false -> the assert fires.
        r = _good_root()
        self.add_period(r, start="20240101", end="20240201", fmt="610")
        self.assert_rule(r, "BR-29")

    def test_br30_inverted_line_period_fires(self):
        r = _good_root()
        self.add_period(r, start="20240201", end="20240101", line=True)
        fired = self.fired(r)
        self.assertIn("BR-30", fired)
        self.assertNotIn("BR-29", fired)   # header periods untouched
        self.assertNotIn("BR-CO-20", fired)

    def test_br30_ordered_line_period_holds(self):
        r = _good_root()
        self.add_period(r, start="20240101", end="20240201", line=True)
        self.assert_rule(r, "BR-30", expect=False)

    # ---- BR-31..33 / BR-36..38: document allowance / charge facts -----------
    def test_br31_amountless_allowance_fires(self):
        r = _good_root()
        self.add_doc_allowance_charge(r, charge=False, amount=None,
                                      vat_category=True)
        fired = self.fired(r)
        self.assertIn("BR-31", fired)
        self.assertNotIn("BR-32", fired)
        self.assertNotIn("BR-33", fired)

    def test_br32_categoryless_allowance_fires(self):
        r = _good_root()
        self.add_doc_allowance_charge(r, charge=False)
        fired = self.fired(r)
        self.assertIn("BR-32", fired)
        self.assertNotIn("BR-31", fired)
        self.assertNotIn("BR-33", fired)

    def test_br33_reasonless_allowance_fires(self):
        r = _good_root()
        self.add_doc_allowance_charge(r, charge=False, reason=None,
                                      vat_category=True)
        fired = self.fired(r)
        self.assertIn("BR-33", fired)
        self.assertIn("BR-CO-21", fired)  # its twin official test
        self.assertNotIn("BR-31", fired)
        self.assertNotIn("BR-32", fired)

    def test_complete_allowance_holds(self):
        r = _good_root()
        self.add_doc_allowance_charge(r, charge=False, vat_category=True)
        fired = self.fired(r)
        for rid in ("BR-31", "BR-32", "BR-33", "BR-CO-21"):
            self.assertNotIn(rid, fired)

    def test_br36_amountless_charge_fires(self):
        r = _good_root()
        self.add_doc_allowance_charge(r, charge=True, amount=None,
                                      vat_category=True)
        fired = self.fired(r)
        self.assertIn("BR-36", fired)
        self.assertNotIn("BR-37", fired)
        self.assertNotIn("BR-38", fired)

    def test_br37_categoryless_charge_fires(self):
        r = _good_root()
        self.add_doc_allowance_charge(r, charge=True)
        fired = self.fired(r)
        self.assertIn("BR-37", fired)
        self.assertNotIn("BR-36", fired)
        self.assertNotIn("BR-38", fired)

    def test_br38_reasonless_charge_fires(self):
        r = _good_root()
        self.add_doc_allowance_charge(r, charge=True, reason=None,
                                      vat_category=True)
        fired = self.fired(r)
        self.assertIn("BR-38", fired)
        self.assertIn("BR-CO-22", fired)
        self.assertNotIn("BR-36", fired)
        self.assertNotIn("BR-37", fired)

    def test_complete_charge_holds(self):
        r = _good_root()
        self.add_doc_allowance_charge(r, charge=True, vat_category=True)
        fired = self.fired(r)
        for rid in ("BR-36", "BR-37", "BR-38", "BR-CO-22"):
            self.assertNotIn(rid, fired)


# --------------------------------------------------------------------------- #
# CII proof-parity batch 2 (T-VHCIIP.3): BR-41..44 (line allowance/charge),   #
# BR-49/50/51/61 (payment instructions), BR-55 (preceding invoice reference), #
# BR-57 (deliver-to country), BR-62/63 (electronic addresses) and             #
# BR-AE-01/02/03 (reverse charge). Every firing shape below is the SAME       #
# field-level breakage differential._CII_MUTATIONS ships, proven              #
# officially-agreeing by `differential.py cii`; the holding siblings pin the  #
# passing direction — including the places where the CII binding decides the  #
# OPPOSITE of the UBL binding on the same shape.                              #
# --------------------------------------------------------------------------- #
class CiiProofParityBatch2(unittest.TestCase):
    """Firing + holding CII fixtures for the T-VHCIIP.3 batch-2 rules."""

    def fired(self, root):
        return _fired_ids(root)

    def assert_rule(self, root, rule_id, expect=True):
        fired = self.fired(root)
        if expect:
            self.assertIn(rule_id, fired,
                          "%s should fire; fired=%s" % (rule_id, sorted(fired)))
        else:
            self.assertNotIn(rule_id, fired,
                             "%s should NOT fire; fired=%s"
                             % (rule_id, sorted(fired)))

    def _seller(self, r):
        return r.find("rsm:SupplyChainTradeTransaction/"
                      "ram:ApplicableHeaderTradeAgreement/"
                      "ram:SellerTradeParty", NS)

    def _buyer(self, r):
        return r.find("rsm:SupplyChainTradeTransaction/"
                      "ram:ApplicableHeaderTradeAgreement/"
                      "ram:BuyerTradeParty", NS)

    def _first_pm(self, r):
        return _settlement(r).find(
            "ram:SpecifiedTradeSettlementPaymentMeans", NS)

    def _line_tax(self, r):
        return _first_line(r).find(
            "ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax", NS)

    def add_line_ac(self, r, charge, amount="0.00", reason="Testing",
                    reason_code=None):
        """A LINE-level ram:SpecifiedTradeAllowanceCharge (BG-27/BG-28) on the
        first line; 0.00 amount and no CategoryTradeTax keep every arithmetic
        and VAT-family rule out of the picture."""
        settle = _first_line(r).find("ram:SpecifiedLineTradeSettlement", NS)
        ac = ET.SubElement(settle, _q(NSA, "SpecifiedTradeAllowanceCharge"))
        ind = ET.SubElement(ac, _q(NSA, "ChargeIndicator"))
        ET.SubElement(ind, _q(NSU, "Indicator")).text = (
            "true" if charge else "false")
        if amount is not None:
            ET.SubElement(ac, _q(NSA, "ActualAmount")).text = amount
        if reason_code is not None:
            ET.SubElement(ac, _q(NSA, "ReasonCode")).text = reason_code
        if reason is not None:
            ET.SubElement(ac, _q(NSA, "Reason")).text = reason
        return ac

    def add_uri_endpoint(self, party, scheme, uri="mail@example.com"):
        comm = ET.SubElement(party, _q(NSA, "URIUniversalCommunication"))
        uid = ET.SubElement(comm, _q(NSA, "URIID"))
        if scheme is not None:
            uid.set("schemeID", scheme)
        uid.text = uri
        return comm

    def add_shipto(self, r, with_address=True, country=None):
        delivery = r.find("rsm:SupplyChainTradeTransaction/"
                          "ram:ApplicableHeaderTradeDelivery", NS)
        shipto = ET.SubElement(delivery, _q(NSA, "ShipToTradeParty"))
        ET.SubElement(shipto, _q(NSA, "Name")).text = "Deliver-to name"
        if with_address:
            pta = ET.SubElement(shipto, _q(NSA, "PostalTradeAddress"))
            ET.SubElement(pta, _q(NSA, "CityName")).text = "DeliveryCity"
            if country is not None:
                ET.SubElement(pta, _q(NSA, "CountryID")).text = country
        return shipto

    def add_ae_allowance(self, r, buyer_legal_id=None):
        """A document ALLOWANCE with a Reverse-charge (AE) CategoryTradeTax at
        rate 0 (the differential._cadd_ae_allowance shape)."""
        if buyer_legal_id is not None:
            lo = ET.SubElement(self._buyer(r),
                               _q(NSA, "SpecifiedLegalOrganization"))
            ET.SubElement(lo, _q(NSA, "ID")).text = buyer_legal_id
        ac = ET.SubElement(_settlement(r),
                           _q(NSA, "SpecifiedTradeAllowanceCharge"))
        ind = ET.SubElement(ac, _q(NSA, "ChargeIndicator"))
        ET.SubElement(ind, _q(NSU, "Indicator")).text = "false"
        ET.SubElement(ac, _q(NSA, "ActualAmount")).text = "0.00"
        ET.SubElement(ac, _q(NSA, "Reason")).text = "Discount"
        ctt = ET.SubElement(ac, _q(NSA, "CategoryTradeTax"))
        ET.SubElement(ctt, _q(NSA, "TypeCode")).text = "VAT"
        ET.SubElement(ctt, _q(NSA, "CategoryCode")).text = "AE"
        ET.SubElement(ctt, _q(NSA, "RateApplicablePercent")).text = "0"
        return ac

    def add_header_ae_row(self, r):
        """Insert a Reverse-charge (AE) header VAT breakdown row (BG-23)."""
        settle = _settlement(r)
        first = settle.find("ram:ApplicableTradeTax", NS)
        tt = ET.Element(_q(NSA, "ApplicableTradeTax"))
        ET.SubElement(tt, _q(NSA, "CalculatedAmount")).text = "0.00"
        ET.SubElement(tt, _q(NSA, "TypeCode")).text = "VAT"
        ET.SubElement(tt, _q(NSA, "BasisAmount")).text = "0.00"
        ET.SubElement(tt, _q(NSA, "CategoryCode")).text = "AE"
        ET.SubElement(tt, _q(NSA, "RateApplicablePercent")).text = "0"
        settle.insert(list(settle).index(first), tt)
        return tt

    def line_to_ae(self, r):
        """Flip the first line's VAT category S -> AE at rate 0."""
        tt = self._line_tax(r)
        tt.find("ram:CategoryCode", NS).text = "AE"
        tt.find("ram:RateApplicablePercent", NS).text = "0"

    # ---- BR-41..44: line allowance/charge existence --------------------------
    def test_br41_amountless_line_allowance_fires(self):
        r = _good_root()
        self.add_line_ac(r, charge=False, amount=None)
        fired = self.fired(r)
        self.assertIn("BR-41", fired)
        self.assertNotIn("BR-42", fired)
        self.assertNotIn("BR-CO-23", fired)

    def test_br42_reasonless_line_allowance_fires(self):
        r = _good_root()
        self.add_line_ac(r, charge=False, reason=None)
        fired = self.fired(r)
        self.assertIn("BR-42", fired)
        self.assertIn("BR-CO-23", fired)   # its twin official test
        self.assertNotIn("BR-41", fired)

    def test_br42_reason_code_alone_satisfies(self):
        # ram:ReasonCode is the second disjunct of the official test; '95'
        # (Discount) is UNCL 5189-valid, so BR-CL-19 stays quiet too.
        r = _good_root()
        self.add_line_ac(r, charge=False, reason=None, reason_code="95")
        fired = self.fired(r)
        for rid in ("BR-41", "BR-42", "BR-CO-23", "BR-CL-19"):
            self.assertNotIn(rid, fired)

    def test_complete_line_allowance_holds(self):
        r = _good_root()
        self.add_line_ac(r, charge=False)
        fired = self.fired(r)
        for rid in ("BR-41", "BR-42", "BR-CO-23"):
            self.assertNotIn(rid, fired)

    def test_br43_amountless_line_charge_fires(self):
        r = _good_root()
        self.add_line_ac(r, charge=True, amount=None)
        fired = self.fired(r)
        self.assertIn("BR-43", fired)
        self.assertNotIn("BR-44", fired)
        self.assertNotIn("BR-CO-24", fired)

    def test_br44_reasonless_line_charge_fires(self):
        r = _good_root()
        self.add_line_ac(r, charge=True, reason=None)
        fired = self.fired(r)
        self.assertIn("BR-44", fired)
        self.assertIn("BR-CO-24", fired)
        self.assertNotIn("BR-43", fired)

    def test_complete_line_charge_holds(self):
        r = _good_root()
        self.add_line_ac(r, charge=True)
        fired = self.fired(r)
        for rid in ("BR-43", "BR-44", "BR-CO-24"):
            self.assertNotIn(rid, fired)

    # ---- BR-49/50/51/61: payment instructions --------------------------------
    def test_br49_codeless_payment_means_fires(self):
        r = _good_root()
        pm = self._first_pm(r)
        _remove(r, pm.find("ram:TypeCode", NS))
        fired = self.fired(r)
        self.assertIn("BR-49", fired)
        # Without a raw '30' TypeCode the group carries NO BR-50/61 context.
        self.assertNotIn("BR-50", fired)
        self.assertNotIn("BR-61", fired)

    def test_br49_holds_on_clean_base(self):
        self.assert_rule(_good_root(), "BR-49", expect=False)

    def test_br50_whitespace_iban_fires_alone(self):
        # normalize-space('   ') = '' fires BR-50, but the IBANID ELEMENT
        # exists, so the per-account existence test of BR-61 holds.
        r = _good_root()
        self._first_pm(r).find(
            "ram:PayeePartyCreditorFinancialAccount/ram:IBANID",
            NS).text = "   "
        fired = self.fired(r)
        self.assertIn("BR-50", fired)
        self.assertNotIn("BR-61", fired)

    def test_br50_holds_on_clean_base(self):
        self.assert_rule(_good_root(), "BR-50", expect=False)

    def test_br61_elementless_account_fires_with_br50(self):
        # Neither ram:IBANID nor ram:ProprietaryID on the account: BR-61
        # fires, and BR-50 fires alongside (its normalize-space is '').
        r = _good_root()
        acct = self._first_pm(r).find(
            "ram:PayeePartyCreditorFinancialAccount", NS)
        _remove(r, acct.find("ram:IBANID", NS))
        fired = self.fired(r)
        self.assertIn("BR-61", fired)
        self.assertIn("BR-50", fired)

    def test_br61_proprietary_id_satisfies(self):
        r = _good_root()
        acct = self._first_pm(r).find(
            "ram:PayeePartyCreditorFinancialAccount", NS)
        iban = acct.find("ram:IBANID", NS)
        iban.tag = _q(NSA, "ProprietaryID")
        fired = self.fired(r)
        self.assertNotIn("BR-61", fired)
        self.assertNotIn("BR-50", fired)

    def test_br61_accountless_credit_transfer_holds_on_cii(self):
        # The CII binding difference: a TypeCode-30 payment means with NO
        # PayeePartyCreditorFinancialAccount carries no BR-50/61 context node
        # at all — neither fires (on UBL, BR-61 WOULD fire here).
        r = _good_root()
        pm = self._first_pm(r)
        _remove(r, pm.find("ram:PayeePartyCreditorFinancialAccount", NS))
        fired = self.fired(r)
        self.assertNotIn("BR-61", fired)
        self.assertNotIn("BR-50", fired)

    def add_card(self, r, pan):
        pm = self._first_pm(r)
        card = ET.Element(_q(NSA, "ApplicableTradeSettlementFinancialCard"))
        if pan is not None:
            ET.SubElement(card, _q(NSA, "ID")).text = pan
        pm.insert(list(pm).index(pm.find("ram:TypeCode", NS)) + 1, card)

    def test_br51_full_pan_fires(self):
        r = _good_root()
        self.add_card(r, "5111111111111111")
        self.assert_rule(r, "BR-51")

    def test_br51_truncated_pan_holds(self):
        r = _good_root()
        self.add_card(r, "  511111 111  ")  # 10 chars after normalize-space
        self.assert_rule(r, "BR-51", expect=False)

    def test_br51_idless_card_holds(self):
        # An absent ram:ID string-values to '' (length 0 <= 10).
        r = _good_root()
        self.add_card(r, None)
        self.assert_rule(r, "BR-51", expect=False)

    # ---- BR-55: preceding invoice reference ----------------------------------
    def add_preceding_ref(self, r, ref):
        ird = ET.SubElement(_settlement(r),
                            _q(NSA, "InvoiceReferencedDocument"))
        if ref is not None:
            ET.SubElement(ird, _q(NSA, "IssuerAssignedID")).text = ref

    def test_br55_empty_reference_group_fires(self):
        r = _good_root()
        self.add_preceding_ref(r, None)
        self.assert_rule(r, "BR-55")

    def test_br55_whitespace_reference_fires_on_cii(self):
        # The CII test requires a NON-EMPTY normalize-space (the UBL binding
        # is pure existence and would hold on this shape).
        r = _good_root()
        self.add_preceding_ref(r, "   ")
        self.assert_rule(r, "BR-55")

    def test_br55_real_reference_holds(self):
        r = _good_root()
        self.add_preceding_ref(r, "12115117")
        self.assert_rule(r, "BR-55", expect=False)

    # ---- BR-57: deliver-to country code --------------------------------------
    def test_br57_countryless_shipto_address_fires(self):
        r = _good_root()
        self.add_shipto(r, country=None)
        self.assert_rule(r, "BR-57")

    def test_br57_country_coded_shipto_holds(self):
        r = _good_root()
        self.add_shipto(r, country="NL")
        self.assert_rule(r, "BR-57", expect=False)

    def test_br57_addressless_shipto_holds(self):
        # not(ram:ShipToTradeParty/ram:PostalTradeAddress) — no deliver-to
        # ADDRESS means no requirement.
        r = _good_root()
        self.add_shipto(r, with_address=False)
        self.assert_rule(r, "BR-57", expect=False)

    # ---- BR-62/63: electronic-address scheme identifiers ---------------------
    def test_br62_schemeless_seller_uri_fires(self):
        r = _good_root()
        self.add_uri_endpoint(self._seller(r), scheme=None)
        self.assert_rule(r, "BR-62")

    def test_br62_empty_scheme_fires_on_cii(self):
        # The CII test is normalize-space(@schemeID) != '' — an EMPTY
        # schemeID="" fires (the UBL binding is attribute existence and
        # would hold on this shape).
        r = _good_root()
        self.add_uri_endpoint(self._seller(r), scheme="")
        self.assert_rule(r, "BR-62")

    def test_br62_em_scheme_holds(self):
        r = _good_root()
        self.add_uri_endpoint(self._seller(r), scheme="EM")
        self.assert_rule(r, "BR-62", expect=False)

    def test_br63_schemeless_buyer_uri_fires(self):
        r = _good_root()
        self.add_uri_endpoint(self._buyer(r), scheme=None)
        fired = self.fired(r)
        self.assertIn("BR-63", fired)
        self.assertNotIn("BR-62", fired)   # the seller is untouched

    def test_br63_em_scheme_holds(self):
        r = _good_root()
        self.add_uri_endpoint(self._buyer(r), scheme="EM")
        self.assert_rule(r, "BR-63", expect=False)

    # ---- BR-AE-01/02/03: reverse charge ---------------------------------------
    def test_brae01_orphan_ae_category_fires(self):
        # An AE CategoryTradeTax with NO AE header breakdown row: the first
        # official disjunct fails (CategoryTradeTax count = 1) and the second
        # fails (header count = 0). The buyer legal id keeps BR-AE-03 quiet.
        r = _good_root()
        self.add_ae_allowance(r, buyer_legal_id="57151520")
        fired = self.fired(r)
        self.assertIn("BR-AE-01", fired)
        self.assertNotIn("BR-AE-03", fired)

    def test_brae01_orphan_ae_breakdown_row_fires_on_cii(self):
        # The CII binding difference: ONE AE header breakdown row with no AE
        # line/allowance/charge FIRES (header count = 1 but the second
        # conjunct needs an AE line or CategoryTradeTax; the first disjunct
        # needs header count = 0). On UBL the same orphan row HOLDS.
        r = _good_root()
        self.add_header_ae_row(r)
        self.assert_rule(r, "BR-AE-01")

    def test_brae01_paired_ae_line_and_row_holds(self):
        r = _good_root()
        self.line_to_ae(r)
        self.add_header_ae_row(r)
        self.assert_rule(r, "BR-AE-01", expect=False)

    def test_brae01_holds_on_clean_base(self):
        self.assert_rule(_good_root(), "BR-AE-01", expect=False)

    def test_brae02_ae_line_without_buyer_id_fires(self):
        # The base buyer carries neither a VAT registration nor a legal-
        # organization id, so the buyer conjunct fails (the seller VA id is
        # present). BR-AE-01 fires alongside (orphan AE line).
        r = _good_root()
        self.line_to_ae(r)
        fired = self.fired(r)
        self.assertIn("BR-AE-02", fired)
        self.assertIn("BR-AE-01", fired)

    def test_brae02_buyer_legal_id_satisfies(self):
        r = _good_root()
        self.line_to_ae(r)
        lo = ET.SubElement(self._buyer(r),
                           _q(NSA, "SpecifiedLegalOrganization"))
        ET.SubElement(lo, _q(NSA, "ID")).text = "10202"
        self.assert_rule(r, "BR-AE-02", expect=False)

    def test_brae02_buyer_vat_id_satisfies(self):
        r = _good_root()
        self.line_to_ae(r)
        reg = ET.SubElement(self._buyer(r),
                            _q(NSA, "SpecifiedTaxRegistration"))
        reg_id = ET.SubElement(reg, _q(NSA, "ID"))
        reg_id.set("schemeID", "VA")
        reg_id.text = "NL999999999B01"
        self.assert_rule(r, "BR-AE-02", expect=False)

    def test_brae03_ae_allowance_without_buyer_id_fires(self):
        r = _good_root()
        self.add_ae_allowance(r)
        fired = self.fired(r)
        self.assertIn("BR-AE-03", fired)
        self.assertIn("BR-AE-01", fired)   # the orphan AE category

    def test_brae03_buyer_legal_id_satisfies(self):
        r = _good_root()
        self.add_ae_allowance(r, buyer_legal_id="10202")
        self.assert_rule(r, "BR-AE-03", expect=False)


# --------------------------------------------------------------------------- #
# CII proof-parity batch 3 (T-VHCIIP.4): the Exempt-from-VAT (BR-E-01..10)    #
# and Export-outside-the-EU (BR-G-01..10) families — the structural twins of  #
# the batch-2 BR-AE heads. Every firing shape below is the SAME field-level    #
# breakage differential._CII_MUTATIONS ships, proven officially-agreeing by    #
# `differential.py cii`; the holding siblings pin the passing direction —      #
# including the binding differences the batch carries: the -01 heads'         #
# orphan-breakdown-row fire (CII only), the E-vs-G seller-id disjunct split   #
# (E accepts a VA-or-FC seller tax registration, G accepts VA only) and the   #
# -08 rules' strict ±1 CII band where the UBL binding is exact.               #
# --------------------------------------------------------------------------- #
class CiiProofParityBatch3(unittest.TestCase):
    """Firing + holding CII fixtures for the T-VHCIIP.4 batch-3 rules."""

    def fired(self, root):
        return _fired_ids(root)

    def assert_rule(self, root, rule_id, expect=True):
        fired = self.fired(root)
        if expect:
            self.assertIn(rule_id, fired,
                          "%s should fire; fired=%s" % (rule_id, sorted(fired)))
        else:
            self.assertNotIn(rule_id, fired,
                             "%s should NOT fire; fired=%s"
                             % (rule_id, sorted(fired)))

    def _seller(self, r):
        return r.find("rsm:SupplyChainTradeTransaction/"
                      "ram:ApplicableHeaderTradeAgreement/"
                      "ram:SellerTradeParty", NS)

    def _line_tax(self, r):
        return _first_line(r).find(
            "ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax", NS)

    def add_vatcat_ac(self, r, code, charge=False, rate="0"):
        """A document allowance/charge with an E/G CategoryTradeTax at
        ``rate`` (the differential._cadd_vatcat_ac_b3 shape)."""
        ac = ET.SubElement(_settlement(r),
                           _q(NSA, "SpecifiedTradeAllowanceCharge"))
        ind = ET.SubElement(ac, _q(NSA, "ChargeIndicator"))
        ET.SubElement(ind, _q(NSU, "Indicator")).text = (
            "true" if charge else "false")
        ET.SubElement(ac, _q(NSA, "ActualAmount")).text = "0.00"
        ET.SubElement(ac, _q(NSA, "Reason")).text = "Testing"
        ctt = ET.SubElement(ac, _q(NSA, "CategoryTradeTax"))
        ET.SubElement(ctt, _q(NSA, "TypeCode")).text = "VAT"
        ET.SubElement(ctt, _q(NSA, "CategoryCode")).text = code
        ET.SubElement(ctt, _q(NSA, "RateApplicablePercent")).text = rate
        return ac

    def flip_line1(self, r, code, rate="0"):
        """Flip the first line's VAT category S -> code (rate=None keeps 6)."""
        tt = self._line_tax(r)
        tt.find("ram:CategoryCode", NS).text = code
        if rate is not None:
            tt.find("ram:RateApplicablePercent", NS).text = rate

    def drop_seller_tax_reg(self, r):
        seller = self._seller(r)
        seller.remove(seller.find("ram:SpecifiedTaxRegistration", NS))

    def set_seller_tax_reg_scheme(self, r, scheme):
        self._seller(r).find(
            "ram:SpecifiedTaxRegistration/ram:ID", NS).set("schemeID", scheme)

    def add_header_row(self, r, code, basis, calculated="0.00", reason=True):
        """A header VAT breakdown row for ``code`` at rate 0 (the
        differential._cadd_header_vat_row_b3 shape)."""
        tt = ET.SubElement(_settlement(r), _q(NSA, "ApplicableTradeTax"))
        ET.SubElement(tt, _q(NSA, "CalculatedAmount")).text = calculated
        ET.SubElement(tt, _q(NSA, "TypeCode")).text = "VAT"
        if reason:
            ET.SubElement(tt, _q(NSA, "ExemptionReason")).text = "Testing"
        ET.SubElement(tt, _q(NSA, "BasisAmount")).text = basis
        ET.SubElement(tt, _q(NSA, "CategoryCode")).text = code
        ET.SubElement(tt, _q(NSA, "RateApplicablePercent")).text = "0"
        return tt

    # ---- BR-E-01 / BR-G-01: exactly one breakdown row (the BR-AE-01 shape) --
    def test_bre01_orphan_e_category_fires(self):
        # An E CategoryTradeTax with NO E header breakdown row; the seller
        # VA id keeps BR-E-03 quiet.
        r = _good_root()
        self.add_vatcat_ac(r, "E")
        fired = self.fired(r)
        self.assertIn("BR-E-01", fired)
        self.assertNotIn("BR-E-03", fired)

    def test_bre01_orphan_e_breakdown_row_fires_on_cii(self):
        # The CII binding difference (as BR-AE-01): ONE orphan E header
        # breakdown row FIRES on CII; on UBL the same orphan holds.
        r = _good_root()
        self.add_header_row(r, "E", basis="0.00")
        self.assert_rule(r, "BR-E-01")

    def test_bre01_paired_e_line_and_row_holds(self):
        r = _good_root()
        self.flip_line1(r, "E")
        self.add_header_row(r, "E", basis="19.90")
        self.assert_rule(r, "BR-E-01", expect=False)

    def test_brg01_orphan_g_category_fires(self):
        r = _good_root()
        self.add_vatcat_ac(r, "G")
        fired = self.fired(r)
        self.assertIn("BR-G-01", fired)
        self.assertNotIn("BR-G-03", fired)

    def test_brg01_orphan_g_breakdown_row_fires_on_cii(self):
        r = _good_root()
        self.add_header_row(r, "G", basis="0.00")
        self.assert_rule(r, "BR-G-01")

    def test_brg01_paired_g_line_and_row_holds(self):
        r = _good_root()
        self.flip_line1(r, "G")
        self.add_header_row(r, "G", basis="19.90")
        self.assert_rule(r, "BR-G-01", expect=False)

    def test_e01_g01_hold_on_clean_base(self):
        fired = self.fired(_good_root())
        self.assertNotIn("BR-E-01", fired)
        self.assertNotIn("BR-G-01", fired)

    # ---- BR-E-02..04 / BR-G-02..04: the seller-identifier disjunct split ----
    def test_bre02_e_line_without_seller_id_fires(self):
        r = _good_root()
        self.flip_line1(r, "E")
        self.drop_seller_tax_reg(r)
        fired = self.fired(r)
        self.assertIn("BR-E-02", fired)
        self.assertIn("BR-S-02", fired)   # the S lines lose the same id

    def test_bre02_fc_seller_registration_satisfies_e(self):
        # The official CII BR-E-02 disjunct is @schemeID = ('VA','FC'):
        # an FC (tax registration, BT-32) seller id SATISFIES the E family.
        r = _good_root()
        self.flip_line1(r, "E")
        self.set_seller_tax_reg_scheme(r, "FC")
        self.assert_rule(r, "BR-E-02", expect=False)

    def test_bre03_e_allowance_without_seller_id_fires(self):
        r = _good_root()
        self.add_vatcat_ac(r, "E")
        self.drop_seller_tax_reg(r)
        self.assert_rule(r, "BR-E-03")

    def test_bre04_e_charge_without_seller_id_fires(self):
        r = _good_root()
        self.add_vatcat_ac(r, "E", charge=True)
        self.drop_seller_tax_reg(r)
        self.assert_rule(r, "BR-E-04")

    def test_brg02_g_line_without_seller_id_fires(self):
        r = _good_root()
        self.flip_line1(r, "G")
        self.drop_seller_tax_reg(r)
        self.assert_rule(r, "BR-G-02")

    def test_brg02_fc_seller_registration_does_not_satisfy_g(self):
        # The G disjunct accepts VA ONLY (no FC fallback, unlike BR-E-02):
        # the same FC seller id that satisfies BR-E-02 leaves BR-G-02 firing.
        r = _good_root()
        self.flip_line1(r, "G")
        self.set_seller_tax_reg_scheme(r, "FC")
        self.assert_rule(r, "BR-G-02")

    def test_brg02_va_seller_registration_satisfies_g(self):
        r = _good_root()
        self.flip_line1(r, "G")
        self.assert_rule(r, "BR-G-02", expect=False)

    def test_brg03_g_allowance_without_seller_id_fires(self):
        r = _good_root()
        self.add_vatcat_ac(r, "G")
        self.drop_seller_tax_reg(r)
        self.assert_rule(r, "BR-G-03")

    def test_brg04_g_charge_without_seller_id_fires(self):
        r = _good_root()
        self.add_vatcat_ac(r, "G", charge=True)
        self.drop_seller_tax_reg(r)
        self.assert_rule(r, "BR-G-04")

    # ---- BR-E-05..07 / BR-G-05..07: rate must equal 0 ------------------------
    def test_bre05_nonzero_rate_e_line_fires(self):
        r = _good_root()
        self.flip_line1(r, "E", rate=None)   # keeps the base rate 6
        self.assert_rule(r, "BR-E-05")

    def test_bre05_zero_rate_e_line_holds(self):
        r = _good_root()
        self.flip_line1(r, "E")
        self.assert_rule(r, "BR-E-05", expect=False)

    def test_bre06_nonzero_rate_e_allowance_fires(self):
        r = _good_root()
        self.add_vatcat_ac(r, "E", rate="21")
        self.assert_rule(r, "BR-E-06")

    def test_bre07_nonzero_rate_e_charge_fires(self):
        r = _good_root()
        self.add_vatcat_ac(r, "E", charge=True, rate="21")
        self.assert_rule(r, "BR-E-07")

    def test_brg05_nonzero_rate_g_line_fires(self):
        r = _good_root()
        self.flip_line1(r, "G", rate=None)
        self.assert_rule(r, "BR-G-05")

    def test_brg06_nonzero_rate_g_allowance_fires(self):
        r = _good_root()
        self.add_vatcat_ac(r, "G", rate="21")
        self.assert_rule(r, "BR-G-06")

    def test_brg07_nonzero_rate_g_charge_fires(self):
        r = _good_root()
        self.add_vatcat_ac(r, "G", charge=True, rate="21")
        self.assert_rule(r, "BR-G-07")

    # ---- BR-E-08 / BR-G-08: the CII ±1 band around the round2 bucket sums ---
    def test_bre08_out_of_band_basis_fires(self):
        # E bucket sum = 19.9 (line 1); BasisAmount 30.00 sits outside the
        # official CII ±1 band -> fires.
        r = _good_root()
        self.flip_line1(r, "E")
        self.add_header_row(r, "E", basis="30.00")
        self.assert_rule(r, "BR-E-08")

    def test_bre08_exact_basis_holds(self):
        r = _good_root()
        self.flip_line1(r, "E")
        self.add_header_row(r, "E", basis="19.90")
        self.assert_rule(r, "BR-E-08", expect=False)

    def test_bre08_inside_band_holds_on_cii(self):
        # The CII binding difference: BasisAmount 20.50 is 0.60 off the
        # bucket sum — INSIDE the official strict ±1 band, so the CII assert
        # holds where the exact UBL binding would fire.
        r = _good_root()
        self.flip_line1(r, "E")
        self.add_header_row(r, "E", basis="20.50")
        self.assert_rule(r, "BR-E-08", expect=False)

    def test_bre08_absent_basis_fires(self):
        # A missing BT-116 empties the official band comparison -> fires
        # (BR-45 fires alongside on both engines).
        r = _good_root()
        self.flip_line1(r, "E")
        row = self.add_header_row(r, "E", basis="19.90")
        row.remove(row.find("ram:BasisAmount", NS))
        fired = self.fired(r)
        self.assertIn("BR-E-08", fired)
        self.assertIn("BR-45", fired)

    def test_brg08_out_of_band_basis_fires(self):
        r = _good_root()
        self.flip_line1(r, "G")
        self.add_header_row(r, "G", basis="30.00")
        self.assert_rule(r, "BR-G-08")

    def test_brg08_inside_band_holds_on_cii(self):
        r = _good_root()
        self.flip_line1(r, "G")
        self.add_header_row(r, "G", basis="20.50")
        self.assert_rule(r, "BR-G-08", expect=False)

    # ---- BR-E-09/10 / BR-G-09/10: zero tax + REQUIRED exemption reason ------
    def test_bre09_nonzero_tax_fires(self):
        # CalculatedAmount 0.01 != 0 -> BR-E-09; round(0.01) = 0 keeps the
        # graded BR-CO-17 quiet (its zero-rate disjunct holds).
        r = _good_root()
        self.flip_line1(r, "E")
        self.add_header_row(r, "E", basis="19.90", calculated="0.01")
        fired = self.fired(r)
        self.assertIn("BR-E-09", fired)
        self.assertNotIn("BR-CO-17", fired)

    def test_bre10_reasonless_e_breakdown_fires(self):
        r = _good_root()
        self.flip_line1(r, "E")
        self.add_header_row(r, "E", basis="19.90", reason=False)
        self.assert_rule(r, "BR-E-10")

    def test_bre10_reasoned_e_breakdown_holds(self):
        r = _good_root()
        self.flip_line1(r, "E")
        self.add_header_row(r, "E", basis="19.90")
        self.assert_rule(r, "BR-E-10", expect=False)

    def test_brg09_nonzero_tax_fires(self):
        r = _good_root()
        self.flip_line1(r, "G")
        self.add_header_row(r, "G", basis="19.90", calculated="0.01")
        self.assert_rule(r, "BR-G-09")

    def test_brg10_reasonless_g_breakdown_fires(self):
        r = _good_root()
        self.flip_line1(r, "G")
        self.add_header_row(r, "G", basis="19.90", reason=False)
        self.assert_rule(r, "BR-G-10")

    def test_brg10_reasoned_g_breakdown_holds(self):
        r = _good_root()
        self.flip_line1(r, "G")
        self.add_header_row(r, "G", basis="19.90")
        self.assert_rule(r, "BR-G-10", expect=False)


class CiiProofParityBatch4(CiiProofParityBatch3):
    """Firing + holding CII fixtures for the T-VHCIIP.5 batch-4 rules:
    BR-AE-04..10 and BR-IC-01..12 (subclasses the batch-3 case for its
    fixture builders — they are VAT-category-code parametric; the inherited
    batch-3 tests re-running here is a cheap, harmless side effect). The
    three genuinely-different CII bindings this batch pinned down are each
    exercised in BOTH directions: the BR-IC-01 orphan-row head, and the pure
    NODE-EXISTENCE tests of BR-IC-11 (delivery DateTimeString /
    billing-period Start/EndDateTime) and BR-IC-12 (ship-to CountryID)."""

    def add_buyer_vat_reg(self, r):
        buyer = r.find("rsm:SupplyChainTradeTransaction/"
                       "ram:ApplicableHeaderTradeAgreement/"
                       "ram:BuyerTradeParty", NS)
        reg = ET.SubElement(buyer, _q(NSA, "SpecifiedTaxRegistration"))
        id_el = ET.SubElement(reg, _q(NSA, "ID"))
        id_el.set("schemeID", "VA")
        id_el.text = "NL999999999B01"

    def _delivery(self, r):
        return r.find("rsm:SupplyChainTradeTransaction/"
                      "ram:ApplicableHeaderTradeDelivery", NS)

    def add_delivery_datetime(self, r, text="20150105"):
        ev = ET.SubElement(self._delivery(r),
                           _q(NSA, "ActualDeliverySupplyChainEvent"))
        odt = ET.SubElement(ev, _q(NSA, "OccurrenceDateTime"))
        dts = ET.SubElement(odt, _q(NSU, "DateTimeString"))
        dts.set("format", "102")
        dts.text = text

    def add_billing_period(self, r, which="StartDateTime"):
        period = ET.SubElement(_settlement(r),
                               _q(NSA, "BillingSpecifiedPeriod"))
        dt = ET.SubElement(period, _q(NSA, which))
        dts = ET.SubElement(dt, _q(NSU, "DateTimeString"))
        dts.set("format", "102")
        dts.text = "20150101"

    def add_shipto_country(self, r, text="NL"):
        shipto = ET.SubElement(self._delivery(r),
                               _q(NSA, "ShipToTradeParty"))
        addr = ET.SubElement(shipto, _q(NSA, "PostalTradeAddress"))
        el = ET.SubElement(addr, _q(NSA, "CountryID"))
        if text is not None:
            el.text = text

    # ---- BR-AE-04..07: charge party-ids + AE rates --------------------------
    def test_brae04_ae_charge_without_buyer_id_fires(self):
        # The base buyer has NO VAT registration and NO legal-organization id.
        r = _good_root()
        self.add_vatcat_ac(r, "AE", charge=True)
        fired = self.fired(r)
        self.assertIn("BR-AE-04", fired)
        self.assertIn("BR-AE-01", fired)   # orphan AE category

    def test_brae04_buyer_vat_id_satisfies(self):
        r = _good_root()
        self.add_vatcat_ac(r, "AE", charge=True)
        self.add_buyer_vat_reg(r)
        self.assert_rule(r, "BR-AE-04", expect=False)

    def test_brae05_nonzero_rate_ae_line_fires(self):
        r = _good_root()
        self.flip_line1(r, "AE", rate=None)   # keeps the base rate 6
        self.assert_rule(r, "BR-AE-05")

    def test_brae05_zero_rate_ae_line_holds(self):
        r = _good_root()
        self.flip_line1(r, "AE")
        self.assert_rule(r, "BR-AE-05", expect=False)

    def test_brae06_nonzero_rate_ae_allowance_fires(self):
        r = _good_root()
        self.add_vatcat_ac(r, "AE", rate="21")
        self.assert_rule(r, "BR-AE-06")

    def test_brae07_nonzero_rate_ae_charge_fires(self):
        r = _good_root()
        self.add_vatcat_ac(r, "AE", charge=True, rate="21")
        self.assert_rule(r, "BR-AE-07")

    # ---- BR-AE-08..10: the AE breakdown-row rules ---------------------------
    def test_brae08_out_of_band_basis_fires(self):
        # 30.00 sits outside the CII strict ±1 band around round2(19.9).
        r = _good_root()
        self.flip_line1(r, "AE")
        self.add_header_row(r, "AE", basis="30.00")
        self.assert_rule(r, "BR-AE-08")

    def test_brae08_inside_band_holds_on_cii(self):
        r = _good_root()
        self.flip_line1(r, "AE")
        self.add_header_row(r, "AE", basis="20.50")   # |20.50-19.9| < 1
        self.assert_rule(r, "BR-AE-08", expect=False)

    def test_brae09_nonzero_tax_fires(self):
        r = _good_root()
        self.flip_line1(r, "AE")
        self.add_header_row(r, "AE", basis="19.90", calculated="0.01")
        self.assert_rule(r, "BR-AE-09")

    def test_brae10_reasonless_ae_breakdown_fires(self):
        r = _good_root()
        self.flip_line1(r, "AE")
        self.add_header_row(r, "AE", basis="19.90", reason=False)
        self.assert_rule(r, "BR-AE-10")

    def test_brae10_reasoned_ae_breakdown_holds(self):
        r = _good_root()
        self.flip_line1(r, "AE")
        self.add_header_row(r, "AE", basis="19.90")
        self.assert_rule(r, "BR-AE-10", expect=False)

    # ---- BR-IC-01: the orphan-row CII binding (the BR-AE-01 shape) ----------
    def test_bric01_orphan_k_category_fires(self):
        r = _good_root()
        self.add_vatcat_ac(r, "K")
        self.add_buyer_vat_reg(r)     # keeps BR-IC-03 quiet
        fired = self.fired(r)
        self.assertIn("BR-IC-01", fired)
        self.assertNotIn("BR-IC-03", fired)

    def test_bric01_orphan_k_breakdown_row_fires_on_cii(self):
        # The CII binding difference: ONE orphan K header breakdown row FIRES
        # on CII; on UBL the same orphan holds.
        r = _good_root()
        self.add_header_row(r, "K", basis="0.00")
        self.assert_rule(r, "BR-IC-01")

    def test_bric01_paired_k_line_and_row_holds(self):
        r = _good_root()
        self.flip_line1(r, "K")
        self.add_header_row(r, "K", basis="19.90")
        self.assert_rule(r, "BR-IC-01", expect=False)

    # ---- BR-IC-02..04: the all-VAT-scoped party-id disjunct -----------------
    def test_bric02_k_line_without_buyer_vat_id_fires(self):
        r = _good_root()
        self.flip_line1(r, "K")
        self.assert_rule(r, "BR-IC-02")

    def test_bric02_buyer_vat_id_satisfies(self):
        r = _good_root()
        self.flip_line1(r, "K")
        self.add_buyer_vat_reg(r)
        self.assert_rule(r, "BR-IC-02", expect=False)

    def test_bric02_fc_seller_registration_does_not_satisfy_k(self):
        # Unlike BR-AE, the K seller disjunct is VA-scoped only.
        r = _good_root()
        self.flip_line1(r, "K")
        self.add_buyer_vat_reg(r)
        self.set_seller_tax_reg_scheme(r, "FC")
        self.assert_rule(r, "BR-IC-02")

    def test_bric03_k_allowance_without_buyer_vat_id_fires(self):
        r = _good_root()
        self.add_vatcat_ac(r, "K")
        self.assert_rule(r, "BR-IC-03")

    def test_bric04_k_charge_without_buyer_vat_id_fires(self):
        r = _good_root()
        self.add_vatcat_ac(r, "K", charge=True)
        self.assert_rule(r, "BR-IC-04")

    # ---- BR-IC-05..07: K rates ----------------------------------------------
    def test_bric05_nonzero_rate_k_line_fires(self):
        r = _good_root()
        self.flip_line1(r, "K", rate=None)
        self.assert_rule(r, "BR-IC-05")

    def test_bric06_nonzero_rate_k_allowance_fires(self):
        r = _good_root()
        self.add_vatcat_ac(r, "K", rate="21")
        self.assert_rule(r, "BR-IC-06")

    def test_bric07_nonzero_rate_k_charge_fires(self):
        r = _good_root()
        self.add_vatcat_ac(r, "K", charge=True, rate="21")
        self.assert_rule(r, "BR-IC-07")

    # ---- BR-IC-08/09: the K breakdown arithmetic ----------------------------
    def test_bric08_out_of_band_basis_fires(self):
        r = _good_root()
        self.flip_line1(r, "K")
        self.add_header_row(r, "K", basis="30.00")
        self.assert_rule(r, "BR-IC-08")

    def test_bric08_inside_band_holds_on_cii(self):
        r = _good_root()
        self.flip_line1(r, "K")
        self.add_header_row(r, "K", basis="20.50")
        self.assert_rule(r, "BR-IC-08", expect=False)

    def test_bric09_nonzero_tax_fires(self):
        r = _good_root()
        self.flip_line1(r, "K")
        self.add_header_row(r, "K", basis="19.90", calculated="0.01")
        self.assert_rule(r, "BR-IC-09")

    # ---- BR-IC-11/12: the pure NODE-EXISTENCE CII bindings ------------------
    def test_bric11_no_date_no_period_fires(self):
        r = _good_root()
        self.flip_line1(r, "K")
        self.add_header_row(r, "K", basis="19.90")
        fired = self.fired(r)
        self.assertIn("BR-IC-11", fired)
        self.assertIn("BR-IC-12", fired)   # no ship-to country either

    def test_bric11_delivery_datetime_node_satisfies(self):
        r = _good_root()
        self.flip_line1(r, "K")
        self.add_header_row(r, "K", basis="19.90")
        self.add_delivery_datetime(r)
        self.assert_rule(r, "BR-IC-11", expect=False)

    def test_bric11_empty_datetime_node_satisfies_on_cii(self):
        # Pure node existence: even an EMPTY DateTimeString satisfies the
        # official CII test (no string-length check, unlike the UBL
        # binding's string-length()>1).
        r = _good_root()
        self.flip_line1(r, "K")
        self.add_header_row(r, "K", basis="19.90")
        self.add_delivery_datetime(r, text=None)
        self.assert_rule(r, "BR-IC-11", expect=False)

    def test_bric11_billing_period_start_satisfies(self):
        r = _good_root()
        self.flip_line1(r, "K")
        self.add_header_row(r, "K", basis="19.90")
        self.add_billing_period(r, "StartDateTime")
        self.assert_rule(r, "BR-IC-11", expect=False)

    def test_bric11_billing_period_end_satisfies(self):
        r = _good_root()
        self.flip_line1(r, "K")
        self.add_header_row(r, "K", basis="19.90")
        self.add_billing_period(r, "EndDateTime")
        self.assert_rule(r, "BR-IC-11", expect=False)

    def test_bric11_childless_billing_period_does_not_satisfy_on_cii(self):
        # The CII disjuncts name Start/EndDateTime specifically — a
        # BillingSpecifiedPeriod with NEITHER does not satisfy them (the UBL
        # binding accepts ANY InvoicePeriod child).
        r = _good_root()
        self.flip_line1(r, "K")
        self.add_header_row(r, "K", basis="19.90")
        ET.SubElement(_settlement(r), _q(NSA, "BillingSpecifiedPeriod"))
        self.assert_rule(r, "BR-IC-11")

    def test_bric12_shipto_country_node_satisfies(self):
        r = _good_root()
        self.flip_line1(r, "K")
        self.add_header_row(r, "K", basis="19.90")
        self.add_shipto_country(r)
        self.assert_rule(r, "BR-IC-12", expect=False)

    def test_bric12_empty_country_node_satisfies_on_cii(self):
        # Pure node existence: an empty CountryID node still satisfies the
        # official CII BR-IC-12 test (BR-57 fires instead — its CII binding
        # requires a NON-empty first CountryID per deliver-to address).
        r = _good_root()
        self.flip_line1(r, "K")
        self.add_header_row(r, "K", basis="19.90")
        self.add_shipto_country(r, text=None)
        fired = self.fired(r)
        self.assertNotIn("BR-IC-12", fired)
        self.assertIn("BR-57", fired)

    def test_bric11_bric12_quiet_without_k_breakdown_row(self):
        # Context = the header K VAT row: a K LINE alone (header count 0)
        # fires neither -11 nor -12 (BR-IC-01/-02 fire instead).
        r = _good_root()
        self.flip_line1(r, "K")
        fired = self.fired(r)
        self.assertNotIn("BR-IC-11", fired)
        self.assertNotIn("BR-IC-12", fired)
        self.assertIn("BR-IC-01", fired)
        self.assertIn("BR-IC-02", fired)


if __name__ == "__main__":
    unittest.main()

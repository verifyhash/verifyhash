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


if __name__ == "__main__":
    unittest.main()

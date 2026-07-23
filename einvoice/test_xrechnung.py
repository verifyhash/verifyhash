#!/usr/bin/env python3
"""Unit tests for the XRechnung CIUS layer (einvoice/rules_xrechnung.py).

Fast, saxonche-free companion to the differential harness: the differential
(``python3 differential.py xrechnung``) proves the layer against the OFFICIAL
KoSIT Schematron; this file pins the proven behaviour so any regression turns
the mechanical gate red without needing Saxon.

Every case mutates a real, clean XRechnung testsuite invoice
(business-cases/standard/01.01a-INVOICE_ubl.xml — verified against the
official artifact to fire exactly {BR-DE-TMP-32} of our implemented set) and
asserts which BR-DE rules fire / clear.

Standard library only. Run: python3 test_xrechnung.py
"""

from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import unittest
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice import rules_xrechnung as xr           # noqa: E402
from einvoice.validate import validate_root           # noqa: E402

CLI = os.path.join(HERE, "einvoice.py")
BASE = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test",
                    "business-cases", "standard", "01.01a-INVOICE_ubl.xml")

NS = xr.NS
NS_CAC, NS_CBC = xr.NS_CAC, xr.NS_CBC
_BASE_ROOT = ET.parse(BASE).getroot()


def q(ns, local):
    return "{%s}%s" % (ns, local)


def base():
    return copy.deepcopy(_BASE_ROOT)


def fired(root):
    return {v.rule_id for v in xr.evaluate(root)}


def supplier_party(root):
    return root.find("cac:AccountingSupplierParty/cac:Party", NS)


def pm(root):
    return root.find("cac:PaymentMeans", NS)


def add_delivery_address(root, city=None, zone=None):
    d = ET.SubElement(root, q(NS_CAC, "Delivery"))
    loc = ET.SubElement(d, q(NS_CAC, "DeliveryLocation"))
    addr = ET.SubElement(loc, q(NS_CAC, "Address"))
    for tag, val in (("CityName", city), ("PostalZone", zone)):
        if val is not None:
            ET.SubElement(addr, q(NS_CBC, tag)).text = val
    return d


def add_mandate(root, account_id):
    mandate = ET.SubElement(pm(root), q(NS_CAC, "PaymentMandate"))
    ET.SubElement(mandate, q(NS_CBC, "ID")).text = "M-1"
    if account_id is not None:
        acct = ET.SubElement(mandate, q(NS_CAC, "PayerFinancialAccount"))
        ET.SubElement(acct, q(NS_CBC, "ID")).text = account_id


class RulesetShape(unittest.TestCase):
    def test_55_rules_with_unique_ids_and_valid_severities(self):
        ids = [fn.rule_id for fn in xr.ALL_RULES]
        self.assertEqual(len(ids), 55)   # 32 BR-DE + 9 CVD/TMP + 14 BR-DEX
        self.assertEqual(len(set(ids)), 55)
        for fn in xr.ALL_RULES:
            self.assertIn(fn.severity, ("fatal", "warning", "information"))

    def test_cvd_tmp_family_present_in_both_registries(self):
        """The nine CVD/TMP ids live in the UBL layer; the CII layer carries
        the same nine plus the CII-only BR-TMP-3 (the vendored UBL artifact
        has no such assert)."""
        family = ("BR-DE-CVD-01", "BR-DE-CVD-02", "BR-DE-CVD-03",
                  "BR-DE-CVD-04", "BR-DE-CVD-05", "BR-DE-CVD-06-a",
                  "BR-DE-CVD-06-b", "BR-TMP-CVD-01", "BR-TMP-2")
        ubl_ids = {fn.rule_id for fn in xr.ALL_RULES}
        cii_ids = {fn.rule_id for fn in xr.CII_DE_RULES}
        for rid in family:
            self.assertIn(rid, ubl_ids)
            self.assertIn(rid, cii_ids)
        self.assertNotIn("BR-TMP-3", ubl_ids)
        self.assertIn("BR-TMP-3", cii_ids)

    def test_all_fourteen_brdex_rules_present(self):
        ids = {fn.rule_id for fn in xr.ALL_RULES}
        for i in range(1, 15):
            self.assertIn("BR-DEX-%02d" % i, ids)

    def test_severity_mapping_matches_official_flags(self):
        by_id = {fn.rule_id: fn.severity for fn in xr.ALL_RULES}
        for rid in ("BR-DE-17", "BR-DE-19", "BR-DE-20", "BR-DE-21",
                    "BR-DE-26", "BR-DE-27", "BR-DE-28", "BR-TMP-2"):
            self.assertEqual(by_id[rid], "warning", rid)
        self.assertEqual(by_id["BR-DE-TMP-32"], "information")
        # BR-DEX-02 is a warning; BR-DEX-01/03..14 are fatal (official flags).
        self.assertEqual(by_id["BR-DEX-02"], "warning")
        warnings_infos = ("BR-DE-17", "BR-DE-19", "BR-DE-20", "BR-DE-21",
                          "BR-DE-26", "BR-DE-27", "BR-DE-28", "BR-DE-TMP-32",
                          "BR-DEX-02", "BR-TMP-2")
        for rid, sev in by_id.items():
            if rid not in warnings_infos:
                self.assertEqual(sev, "fatal", rid)


class BaseInvoicePinned(unittest.TestCase):
    """The clean testsuite invoice — verdict pinned from the differential."""

    def test_base_fires_exactly_tmp32(self):
        self.assertEqual(fired(base()), {"BR-DE-TMP-32"})


class DocumentLevelRules(unittest.TestCase):
    def test_br_de_1_missing_payment_means(self):
        r = base()
        r.remove(pm(r))
        self.assertIn("BR-DE-1", fired(r))

    def test_br_de_15_missing_and_empty_buyer_reference(self):
        r = base()
        r.remove(r.find("cbc:BuyerReference", NS))
        self.assertIn("BR-DE-15", fired(r))
        r2 = base()
        r2.find("cbc:BuyerReference", NS).text = "   "
        self.assertIn("BR-DE-15", fired(r2))

    def test_br_de_16_seller_vat_id_required_for_S(self):
        r = base()
        party = supplier_party(r)
        party.remove(party.find("cac:PartyTaxScheme", NS))
        self.assertIn("BR-DE-16", fired(r))
        # A TaxRepresentativeParty satisfies the rule again.
        ET.SubElement(r, q(NS_CAC, "TaxRepresentativeParty"))
        self.assertNotIn("BR-DE-16", fired(r))

    def test_br_de_17_type_code_outside_xr_subset(self):
        r = base()
        r.find("cbc:InvoiceTypeCode", NS).text = "71"
        self.assertIn("BR-DE-17", fired(r))
        self.assertNotIn("BR-DE-17", fired(base()))  # 380 is allowed

    def test_br_de_21_non_xrechnung_customization_id(self):
        r = base()
        r.find("cbc:CustomizationID", NS).text = "urn:cen.eu:en16931:2017"
        self.assertIn("BR-DE-21", fired(r))
        self.assertNotIn("BR-DE-21", fired(base()))

    def test_br_de_22_duplicate_attachment_filenames(self):
        r = base()
        for i, fn in enumerate(("a.pdf", "a.pdf")):
            adr = ET.Element(q(NS_CAC, "AdditionalDocumentReference"))
            ET.SubElement(adr, q(NS_CBC, "ID")).text = "doc-%d" % i
            att = ET.SubElement(adr, q(NS_CAC, "Attachment"))
            obj = ET.SubElement(att, q(NS_CBC, "EmbeddedDocumentBinaryObject"))
            obj.text = "UkVDSA=="
            obj.set("filename", fn)
            obj.set("mimeCode", "application/pdf")
            r.insert(0, adr)
        self.assertIn("BR-DE-22", fired(r))
        # Distinct filenames are fine.
        r.findall("cac:AdditionalDocumentReference/cac:Attachment/"
                  "cbc:EmbeddedDocumentBinaryObject", NS)[0].set("filename", "b.pdf")
        self.assertNotIn("BR-DE-22", fired(r))

    def test_br_de_26_corrected_invoice_needs_preceding_reference(self):
        r = base()
        r.find("cbc:InvoiceTypeCode", NS).text = "384"
        self.assertIn("BR-DE-26", fired(r))
        br = ET.SubElement(r, q(NS_CAC, "BillingReference"))
        idr = ET.SubElement(br, q(NS_CAC, "InvoiceDocumentReference"))
        ET.SubElement(idr, q(NS_CBC, "ID")).text = "INV-0"
        self.assertNotIn("BR-DE-26", fired(r))

    def test_br_de_30_31_direct_debit_requirements(self):
        r = base()
        pm(r).find("cbc:PaymentMeansCode", NS).text = "59"
        pm(r).remove(pm(r).find("cac:PayeeFinancialAccount", NS))
        add_mandate(r, account_id=None)
        got = fired(r)
        self.assertIn("BR-DE-30", got)   # no SEPA creditor id
        self.assertIn("BR-DE-31", got)   # no debited account id
        # SEPA creditor id + debited account satisfy both.
        pid = ET.Element(q(NS_CAC, "PartyIdentification"))
        id_el = ET.SubElement(pid, q(NS_CBC, "ID"))
        id_el.text = "DE98ZZZ09999999999"
        id_el.set("schemeID", "SEPA")
        supplier_party(r).insert(1, pid)
        acct = ET.SubElement(pm(r).find("cac:PaymentMandate", NS),
                             q(NS_CAC, "PayerFinancialAccount"))
        ET.SubElement(acct, q(NS_CBC, "ID")).text = "DE79000000001234567890"
        got = fired(r)
        self.assertNotIn("BR-DE-30", got)
        self.assertNotIn("BR-DE-31", got)

    def test_br_de_tmp_32_delivery_date_alternatives(self):
        self.assertIn("BR-DE-TMP-32", fired(base()))  # nothing stated
        r = base()
        d = ET.SubElement(r, q(NS_CAC, "Delivery"))
        ET.SubElement(d, q(NS_CBC, "ActualDeliveryDate")).text = "2016-04-04"
        self.assertNotIn("BR-DE-TMP-32", fired(r))
        r2 = base()
        ET.SubElement(r2, q(NS_CAC, "InvoicePeriod"))
        self.assertNotIn("BR-DE-TMP-32", fired(r2))
        r3 = base()  # give the second line a period too -> every line covered
        lines = r3.findall("cac:InvoiceLine", NS)
        self.assertIsNotNone(lines[0].find("cac:InvoicePeriod", NS))
        ET.SubElement(lines[1], q(NS_CAC, "InvoicePeriod"))
        self.assertNotIn("BR-DE-TMP-32", fired(r3))


class SellerBuyerDeliveryRules(unittest.TestCase):
    def test_br_de_2_missing_seller_contact(self):
        r = base()
        party = supplier_party(r)
        party.remove(party.find("cac:Contact", NS))
        got = fired(r)
        self.assertIn("BR-DE-2", got)
        # Context gone -> the per-contact rules must NOT fire.
        for rid in ("BR-DE-5", "BR-DE-6", "BR-DE-7", "BR-DE-27", "BR-DE-28"):
            self.assertNotIn(rid, got)

    def test_br_de_3_4_seller_address_fields(self):
        for tag, rid in (("CityName", "BR-DE-3"), ("PostalZone", "BR-DE-4")):
            r = base()
            addr = supplier_party(r).find("cac:PostalAddress", NS)
            addr.remove(addr.find("cbc:%s" % tag, NS))
            self.assertIn(rid, fired(r), rid)

    def test_br_de_5_6_7_contact_fields(self):
        for tag, rid in (("Name", "BR-DE-5"), ("Telephone", "BR-DE-6"),
                         ("ElectronicMail", "BR-DE-7")):
            r = base()
            contact = supplier_party(r).find("cac:Contact", NS)
            contact.remove(contact.find("cbc:%s" % tag, NS))
            self.assertIn(rid, fired(r), rid)

    def test_br_de_6_fires_27_too_when_telephone_absent(self):
        r = base()
        contact = supplier_party(r).find("cac:Contact", NS)
        contact.remove(contact.find("cbc:Telephone", NS))
        got = fired(r)
        self.assertIn("BR-DE-6", got)
        self.assertIn("BR-DE-27", got)  # normalize-space(()) = '' -> < 3 digits

    def test_br_de_8_9_buyer_address_fields(self):
        for tag, rid in (("CityName", "BR-DE-8"), ("PostalZone", "BR-DE-9")):
            r = base()
            addr = r.find(
                "cac:AccountingCustomerParty/cac:Party/cac:PostalAddress", NS)
            addr.remove(addr.find("cbc:%s" % tag, NS))
            self.assertIn(rid, fired(r), rid)

    def test_br_de_10_11_delivery_address_fields(self):
        r = base()
        add_delivery_address(r, zone="12345")           # city missing
        self.assertIn("BR-DE-10", fired(r))
        r2 = base()
        add_delivery_address(r2, city="Bremen")          # zone missing
        self.assertIn("BR-DE-11", fired(r2))
        r3 = base()
        add_delivery_address(r3, city="Bremen", zone="28195")
        got = fired(r3)
        self.assertNotIn("BR-DE-10", got)
        self.assertNotIn("BR-DE-11", got)

    def test_br_de_27_28_content_quality(self):
        r = base()
        contact = supplier_party(r).find("cac:Contact", NS)
        contact.find("cbc:Telephone", NS).text = "keine"      # < 3 digits
        contact.find("cbc:ElectronicMail", NS).text = "kein-email-hier"
        got = fired(r)
        self.assertIn("BR-DE-27", got)
        self.assertIn("BR-DE-28", got)
        self.assertNotIn("BR-DE-27", fired(base()))
        self.assertNotIn("BR-DE-28", fired(base()))


class VatBreakdownRules(unittest.TestCase):
    def test_br_de_14_missing_percent(self):
        r = base()
        cat = r.find("cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory", NS)
        cat.remove(cat.find("cbc:Percent", NS))
        self.assertIn("BR-DE-14", fired(r))

    def test_br_de_14_only_top_level_tax_totals(self):
        # A nested (line-level) TaxTotal without Percent must NOT fire it —
        # the official context is /ubl:Invoice/cac:TaxTotal/cac:TaxSubtotal.
        r = base()
        line = r.find("cac:InvoiceLine", NS)
        tt = ET.SubElement(line, q(NS_CAC, "TaxTotal"))
        st = ET.SubElement(tt, q(NS_CAC, "TaxSubtotal"))
        ET.SubElement(st, q(NS_CAC, "TaxCategory"))
        self.assertNotIn("BR-DE-14", fired(r))


class PaymentMeansRules(unittest.TestCase):
    def test_br_de_19_iban_quality_code_58(self):
        r = base()
        pm(r).find("cac:PayeeFinancialAccount/cbc:ID", NS).text = \
            "DE00000000001234567890"                   # check digits 00
        self.assertIn("BR-DE-19", fired(r))
        self.assertNotIn("BR-DE-19", fired(base()))    # DE79... is mod-97 valid

    def test_iban_helper_matches_official_transcription(self):
        self.assertTrue(xr._iban_ok("DE79000000001234567890"))
        self.assertTrue(xr._iban_ok("DE79 0000 0000 1234 5678 90"))  # ws stripped
        self.assertFalse(xr._iban_ok("DE00000000001234567890"))
        self.assertFalse(xr._iban_ok(""))
        self.assertFalse(xr._iban_ok(None))
        self.assertFalse(xr._iban_ok("XX12"))

    def test_br_de_20_25_direct_debit_code_59(self):
        r = base()
        pm(r).find("cbc:PaymentMeansCode", NS).text = "59"
        got = fired(r)
        self.assertIn("BR-DE-25-a", got)   # no mandate
        self.assertIn("BR-DE-25-b", got)   # PayeeFinancialAccount forbidden
        self.assertIn("BR-DE-20", got)     # debited IBAN '' -> not valid

    def test_br_de_23_credit_transfer_grouping(self):
        r = base()
        pm(r).remove(pm(r).find("cac:PayeeFinancialAccount", NS))
        self.assertIn("BR-DE-23-a", fired(r))
        r2 = base()
        card = ET.SubElement(pm(r2), q(NS_CAC, "CardAccount"))
        ET.SubElement(card, q(NS_CBC, "PrimaryAccountNumberID")).text = "1234"
        self.assertIn("BR-DE-23-b", fired(r2))
        self.assertNotIn("BR-DE-23-a", fired(base()))
        self.assertNotIn("BR-DE-23-b", fired(base()))

    def test_br_de_24_card_payment_grouping(self):
        r = base()
        pm(r).find("cbc:PaymentMeansCode", NS).text = "48"
        got = fired(r)
        self.assertIn("BR-DE-24-a", got)   # no CardAccount
        self.assertIn("BR-DE-24-b", got)   # PayeeFinancialAccount forbidden


class SkontoRule(unittest.TestCase):
    def set_note(self, r, text):
        r.find("cac:PaymentTerms/cbc:Note", NS).text = text

    def test_plain_terms_hold(self):
        self.assertNotIn("BR-DE-18", fired(base()))  # "Zahlbar sofort..."

    def test_valid_skonto_with_terminating_newline_holds(self):
        r = base()
        self.set_note(r, "#SKONTO#TAGE=14#PROZENT=2.00#\n")
        self.assertNotIn("BR-DE-18", fired(r))

    def test_valid_skonto_with_basisbetrag_holds(self):
        r = base()
        self.set_note(r, "#SKONTO#TAGE=14#PROZENT=2.00#BASISBETRAG=100.00#\n")
        self.assertNotIn("BR-DE-18", fired(r))

    def test_bad_grammar_fires(self):
        r = base()
        self.set_note(r, "#SKONTO#TAGE=14#PROZENT=2#")   # PROZENT not n.nn
        self.assertIn("BR-DE-18", fired(r))

    def test_missing_terminating_newline_fires(self):
        r = base()
        self.set_note(r, "#SKONTO#TAGE=14#PROZENT=2.00#")  # no trailing \n
        self.assertIn("BR-DE-18", fired(r))

    def test_lowercase_skonto_fires(self):
        r = base()
        self.set_note(r, "#skonto#TAGE=14#PROZENT=2.00#\n")
        self.assertIn("BR-DE-18", fired(r))


EXT_BASE = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test",
                        "business-cases", "extension", "04.02a-INVOICE_ubl.xml")
_EXT_BASE_ROOT = ET.parse(EXT_BASE).getroot()


def ext_base():
    return copy.deepcopy(_EXT_BASE_ROOT)


def add_prepaid(root, id_=None, amount=None, currency="EUR", instr=None):
    pp = ET.SubElement(root, q(NS_CAC, "PrepaidPayment"))
    if id_ is not None:
        ET.SubElement(pp, q(NS_CBC, "ID")).text = id_
    if amount is not None:
        amt = ET.SubElement(pp, q(NS_CBC, "PaidAmount"))
        amt.text = amount
        amt.set("currencyID", currency)
    if instr is not None:
        ET.SubElement(pp, q(NS_CBC, "InstructionID")).text = instr
    return pp


class ExtensionGating(unittest.TestCase):
    """The BR-DEX-* layer is inert unless the CustomizationID is the Extension."""

    def test_clean_extension_base_fires_no_brdex(self):
        got = fired(ext_base())
        self.assertTrue(xr._is_extension(ext_base()))
        self.assertFalse(any(r.startswith("BR-DEX") for r in got), got)

    def test_cius_base_never_fires_brdex_even_when_structure_would(self):
        # A plain-CIUS invoice with a broken sub-line sum / bad MIME must NOT
        # fire any BR-DEX rule (not an Extension).
        r = base()
        self.assertFalse(xr._is_extension(r))
        # Add an attachment with a forbidden MIME code + a PrepaidPayment with
        # nothing in it: on a CIUS invoice these are simply out of scope.
        add_prepaid(r, id_=None, amount=None)
        got = fired(r)
        self.assertFalse(any(x.startswith("BR-DEX") for x in got), got)


class ExtensionRules(unittest.TestCase):
    """Positive (fires) + negative (clears) for each BR-DEX-* rule, mutating the
    clean Extension fixture 04.02a (verified against the official KoSIT XSLT)."""

    def test_brdex_01_attachment_mime_code(self):
        r = ext_base()
        adr = ET.SubElement(r, q(NS_CAC, "AdditionalDocumentReference"))
        att = ET.SubElement(adr, q(NS_CAC, "Attachment"))
        obj = ET.SubElement(att, q(NS_CBC, "EmbeddedDocumentBinaryObject"))
        obj.text = "UkVDSA=="
        obj.set("filename", "data.zip")
        obj.set("mimeCode", "application/zip")
        self.assertIn("BR-DEX-01", fired(r))
        # application/xml is the Extension-only allowance -> clears.
        obj.set("mimeCode", "application/xml")
        self.assertNotIn("BR-DEX-01", fired(r))

    def test_brdex_02_subline_net_sum(self):
        r = ext_base()
        sub = r.find("cac:InvoiceLine/cac:SubInvoiceLine/cbc:LineExtensionAmount",
                     NS)
        sub.text = "99.99"                        # 99.99 + 15.40 != 27.72
        self.assertIn("BR-DEX-02", fired(r))
        self.assertNotIn("BR-DEX-02", fired(ext_base()))   # base sums to 27.72

    def test_brdex_03_subline_exactly_one_vat(self):
        r = ext_base()
        item = r.find("cac:InvoiceLine/cac:SubInvoiceLine/cac:Item", NS)
        item.remove(item.find("cac:ClassifiedTaxCategory", NS))
        self.assertIn("BR-DEX-03", fired(r))
        # A second ClassifiedTaxCategory also violates "exactly one".
        r2 = ext_base()
        item2 = r2.find("cac:InvoiceLine/cac:SubInvoiceLine/cac:Item", NS)
        item2.append(copy.deepcopy(item2.find("cac:ClassifiedTaxCategory", NS)))
        self.assertIn("BR-DEX-03", fired(r2))
        self.assertNotIn("BR-DEX-03", fired(ext_base()))

    def test_brdex_04_party_identification_scheme(self):
        r = ext_base()
        pid = ET.Element(q(NS_CAC, "PartyIdentification"))
        idel = ET.SubElement(pid, q(NS_CBC, "ID"))
        idel.text = "X"
        idel.set("schemeID", "ZZZ")
        supplier_party(r).insert(1, pid)
        self.assertIn("BR-DEX-04", fired(r))
        # An ISO 6523 ICD code clears; the base SEPA id (Seller) already holds.
        idel.set("schemeID", "0088")
        self.assertNotIn("BR-DEX-04", fired(r))
        self.assertNotIn("BR-DEX-04", fired(ext_base()))

    def test_brdex_05_legal_registration_scheme(self):
        r = ext_base()
        cid = supplier_party(r).find("cac:PartyLegalEntity/cbc:CompanyID", NS)
        cid.set("schemeID", "ZZZ")
        self.assertIn("BR-DEX-05", fired(r))
        cid.set("schemeID", "0088")
        self.assertNotIn("BR-DEX-05", fired(r))

    def test_brdex_06_item_standard_id_scheme(self):
        r = ext_base()
        item = r.find("cac:InvoiceLine/cac:Item", NS)
        sii = ET.SubElement(item, q(NS_CAC, "StandardItemIdentification"))
        idel = ET.SubElement(sii, q(NS_CBC, "ID"))
        idel.text = "0815"
        idel.set("schemeID", "ZZZ")
        self.assertIn("BR-DEX-06", fired(r))
        idel.set("schemeID", "0160")
        self.assertNotIn("BR-DEX-06", fired(r))

    def test_brdex_07_endpoint_scheme(self):
        r = ext_base()
        ep = supplier_party(r).find("cbc:EndpointID", NS)
        ep.set("schemeID", "ZZ")
        self.assertIn("BR-DEX-07", fired(r))
        ep.set("schemeID", "EM")                  # base value, valid CEF EAS
        self.assertNotIn("BR-DEX-07", fired(r))

    def test_brdex_08_delivery_location_scheme(self):
        r = ext_base()
        d = ET.SubElement(r, q(NS_CAC, "Delivery"))
        loc = ET.SubElement(d, q(NS_CAC, "DeliveryLocation"))
        idel = ET.SubElement(loc, q(NS_CBC, "ID"))
        idel.text = "LOC-1"
        idel.set("schemeID", "ZZZ")
        self.assertIn("BR-DEX-08", fired(r))
        idel.set("schemeID", "0088")
        self.assertNotIn("BR-DEX-08", fired(r))

    def test_brdex_09_amount_due_balance(self):
        r = ext_base()
        r.find("cac:LegalMonetaryTotal/cbc:PayableAmount", NS).text = "99.99"
        self.assertIn("BR-DEX-09", fired(r))
        self.assertNotIn("BR-DEX-09", fired(ext_base()))
        # A third-party payment that the payable amount accounts for -> holds.
        r2 = ext_base()
        r2.find("cac:LegalMonetaryTotal/cbc:PayableAmount", NS).text = "35.99"
        add_prepaid(r2, id_="10", amount="3.00", currency="EUR", instr="tip")
        self.assertNotIn("BR-DEX-09", fired(r2))

    def test_brdex_10_third_party_payment_type_present(self):
        r = ext_base()
        add_prepaid(r, id_=None, amount="0.00", currency="EUR", instr="tip")
        self.assertIn("BR-DEX-10", fired(r))
        r2 = ext_base()
        add_prepaid(r2, id_="10", amount="0.00", currency="EUR", instr="tip")
        self.assertNotIn("BR-DEX-10", fired(r2))

    def test_brdex_11_third_party_payment_amount_present(self):
        r = ext_base()
        add_prepaid(r, id_="10", amount=None, instr="tip")
        self.assertIn("BR-DEX-11", fired(r))
        r2 = ext_base()
        add_prepaid(r2, id_="10", amount="0.00", currency="EUR", instr="tip")
        self.assertNotIn("BR-DEX-11", fired(r2))

    def test_brdex_12_third_party_payment_description_present(self):
        r = ext_base()
        add_prepaid(r, id_="10", amount="0.00", currency="EUR", instr=None)
        self.assertIn("BR-DEX-12", fired(r))
        r2 = ext_base()
        add_prepaid(r2, id_="10", amount="0.00", currency="EUR", instr="tip")
        self.assertNotIn("BR-DEX-12", fired(r2))

    def test_brdex_13_third_party_amount_decimals(self):
        r = ext_base()
        add_prepaid(r, id_="10", amount="0.001", currency="EUR", instr="tip")
        self.assertIn("BR-DEX-13", fired(r))
        r2 = ext_base()
        add_prepaid(r2, id_="10", amount="0.00", currency="EUR", instr="tip")
        self.assertNotIn("BR-DEX-13", fired(r2))
        # No decimal point at all -> holds (substring-after -> '').
        r3 = ext_base()
        add_prepaid(r3, id_="10", amount="5", currency="EUR", instr="tip")
        r3.find("cac:LegalMonetaryTotal/cbc:PayableAmount", NS).text = "37.99"
        self.assertNotIn("BR-DEX-13", fired(r3))

    def test_brdex_14_third_party_amount_currency(self):
        r = ext_base()
        add_prepaid(r, id_="10", amount="0.00", currency="USD", instr="tip")
        self.assertIn("BR-DEX-14", fired(r))
        r2 = ext_base()
        add_prepaid(r2, id_="10", amount="0.00", currency="EUR", instr="tip")
        self.assertNotIn("BR-DEX-14", fired(r2))


CVD_BASE = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test",
                        "technical-cases", "cvd", "02.01a-cvd_INVOICE_ubl.xml")
_CVD_BASE_ROOT = ET.parse(CVD_BASE).getroot()


def cvd_base():
    return copy.deepcopy(_CVD_BASE_ROOT)


def _cvd_class_code(root, list_id):
    for cc in root.findall("cac:InvoiceLine/cac:Item/cac:CommodityClassification/"
                           "cbc:ItemClassificationCode", NS):
        if cc.get("listID") == list_id:
            return cc
    raise AssertionError("no ItemClassificationCode with listID=%r" % list_id)


def _cvd_cva_property(root):
    for prop in root.findall("cac:InvoiceLine/cac:Item/"
                             "cac:AdditionalItemProperty", NS):
        if any((n.text or "") == "cva" for n in prop.findall("cbc:Name", NS)):
            return prop
    raise AssertionError("no cva AdditionalItemProperty in the CVD base")


class CvdProfileRules(unittest.TestCase):
    """Clean-Vehicle-Directive layer — fire/hold behaviour pinned from the
    differential (the clean CVD testsuite invoice fires NONE of the family
    on the official XSLT; each mutation was verified to fire exactly its
    rule there)."""

    CVD_IDS = {"BR-DE-CVD-01", "BR-DE-CVD-02", "BR-DE-CVD-03", "BR-DE-CVD-04",
               "BR-DE-CVD-05", "BR-DE-CVD-06-a", "BR-DE-CVD-06-b",
               "BR-TMP-CVD-01"}

    def test_clean_cvd_base_fires_no_family_rule(self):
        self.assertFalse(fired(cvd_base()) & (self.CVD_IDS | {"BR-TMP-2"}))

    def test_cvd_rules_inert_without_cvd_customization_id(self):
        """The $isCVD gate: break EVERY CVD guard, then flip BT-24 back to the
        plain CIUS id — no CVD rule may fire."""
        r = cvd_base()
        r.remove(r.find("cac:ContractDocumentReference", NS))
        r.remove(r.find("cac:OriginatorDocumentReference", NS))
        _cvd_class_code(r, "CVD").text = "X9"
        self.assertTrue(fired(r) & self.CVD_IDS)   # gate open: they fire
        r.find("cbc:CustomizationID", NS).text = xr.XR_CIUS_ID
        self.assertFalse(fired(r) & self.CVD_IDS)  # gate closed: inert

    def test_cvd_01_contract_reference(self):
        r = cvd_base()
        r.remove(r.find("cac:ContractDocumentReference", NS))
        self.assertIn("BR-DE-CVD-01", fired(r))
        r2 = cvd_base()
        r2.find("cac:ContractDocumentReference/cbc:ID", NS).text = "   "
        self.assertIn("BR-DE-CVD-01", fired(r2))

    def test_cvd_02_tender_or_lot_reference(self):
        r = cvd_base()
        r.remove(r.find("cac:OriginatorDocumentReference", NS))
        self.assertEqual(fired(r) & self.CVD_IDS, {"BR-DE-CVD-02"})

    def test_cvd_03_needs_one_line_with_cvd_and_cva(self):
        r = cvd_base()
        item = r.find("cac:InvoiceLine/cac:Item", NS)
        for cc in item.findall("cac:CommodityClassification", NS):
            if any(c.get("listID") == "CVD"
                   for c in cc.findall("cbc:ItemClassificationCode", NS)):
                item.remove(cc)
        item.remove(_cvd_cva_property(r))
        self.assertEqual(fired(r) & self.CVD_IDS, {"BR-DE-CVD-03"})

    def test_cvd_04_vehicle_category(self):
        r = cvd_base()
        _cvd_class_code(r, "CVD").text = "L5"
        self.assertEqual(fired(r) & self.CVD_IDS, {"BR-DE-CVD-04"})

    def test_cvd_05_cva_value(self):
        r = cvd_base()
        _cvd_cva_property(r).find("cbc:Value", NS).text = "hybrid"
        self.assertEqual(fired(r) & self.CVD_IDS, {"BR-DE-CVD-05"})

    def test_cvd_06_a_exactly_one_cva(self):
        r = cvd_base()
        item = r.find("cac:InvoiceLine/cac:Item", NS)
        prop = ET.SubElement(item, q(NS_CAC, "AdditionalItemProperty"))
        ET.SubElement(prop, q(NS_CBC, "Name")).text = "cva"
        ET.SubElement(prop, q(NS_CBC, "Value")).text = "clean"
        self.assertEqual(fired(r) & self.CVD_IDS, {"BR-DE-CVD-06-a"})

    def test_cvd_06_b_exactly_one_cvd_class(self):
        r = cvd_base()
        items = r.findall("cac:InvoiceLine/cac:Item", NS)
        prop = ET.SubElement(items[1], q(NS_CAC, "AdditionalItemProperty"))
        ET.SubElement(prop, q(NS_CBC, "Name")).text = "cva"
        ET.SubElement(prop, q(NS_CBC, "Value")).text = "clean"
        self.assertEqual(fired(r) & self.CVD_IDS, {"BR-DE-CVD-06-b"})

    def test_tmp_cvd_01_scheme_from_untdid_7143(self):
        r = cvd_base()
        _cvd_class_code(r, "IB").set("listID", "QQQQ")
        self.assertEqual(fired(r) & self.CVD_IDS, {"BR-TMP-CVD-01"})

    def test_tmp_cvd_01_empty_listid_holds_like_the_artifact(self):
        """The official concat produces a DOUBLE space between 'CVD' and the
        UNTDID tokens, so an absent/empty @listID normalizes to '' and the
        contains() test HOLDS — transcribed exactly, pinned here."""
        r = cvd_base()
        del _cvd_class_code(r, "IB").attrib["listID"]
        self.assertNotIn("BR-TMP-CVD-01", fired(r))


class TmpRules(unittest.TestCase):
    """BR-TMP-2 (BT-124 URL shape, warning) — NOT gated on the CVD profile."""

    def _add_external_reference(self, r, uri):
        adr = ET.Element(q(NS_CAC, "AdditionalDocumentReference"))
        ET.SubElement(adr, q(NS_CBC, "ID")).text = "ext-1"
        att = ET.SubElement(adr, q(NS_CAC, "Attachment"))
        ext = ET.SubElement(att, q(NS_CAC, "ExternalReference"))
        if uri is not None:
            ET.SubElement(ext, q(NS_CBC, "URI")).text = uri
        r.insert(list(r).index(r.find("cac:AccountingSupplierParty", NS)), adr)

    def test_tmp_2_relative_url_fires_as_warning(self):
        r = base()  # plain CIUS invoice — no CVD gate involved
        self._add_external_reference(r, "example.com/spec.pdf")
        self.assertIn("BR-TMP-2", fired(r))
        by_id = {v.rule_id: v for v in xr.evaluate(r)}
        self.assertEqual(by_id["BR-TMP-2"].severity, "warning")

    def test_tmp_2_absolute_url_holds(self):
        r = base()
        self._add_external_reference(r, "https://example.com/spec.pdf")
        self.assertNotIn("BR-TMP-2", fired(r))

    def test_tmp_2_missing_uri_fires(self):
        """matches((), re) reads the empty sequence as '' -> fires."""
        r = base()
        self._add_external_reference(r, None)
        self.assertIn("BR-TMP-2", fired(r))


class ProfileWiring(unittest.TestCase):
    def test_default_profile_has_no_br_de(self):
        result = validate_root(base())
        self.assertFalse(any(v.rule_id.startswith("BR-DE")
                             for v in result.violations))

    def test_xrechnung_profile_layers_br_de_on_top(self):
        result = validate_root(base(), profile="xrechnung")
        ids = {v.rule_id for v in result.violations}
        self.assertIn("BR-DE-TMP-32", ids)
        # Only information/warning severities -> still ok (official flag
        # semantics: only fatal blocks).
        self.assertTrue(result.ok)

    def test_fatal_br_de_flips_ok(self):
        r = base()
        r.remove(r.find("cbc:BuyerReference", NS))
        result = validate_root(r, profile="xrechnung")
        self.assertFalse(result.ok)
        d = result.to_dict(source="x")
        self.assertFalse(d["valid"])
        sev = {v["rule"]: v["severity"] for v in d["violations"]}
        self.assertEqual(sev.get("BR-DE-15"), "fatal")

    def test_unknown_profile_rejected(self):
        with self.assertRaises(ValueError):
            validate_root(base(), profile="nope")


class CliProfile(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, CLI] + list(args),
                              capture_output=True, text=True, timeout=60)

    def test_cli_xrechnung_profile_reports_severities(self):
        proc = self.run_cli("validate", BASE, "--json", "--profile=xrechnung")
        self.assertEqual(proc.returncode, 0, proc.stderr)  # info-only -> valid
        data = json.loads(proc.stdout)
        self.assertTrue(data["valid"])
        rules = {v["rule"]: v["severity"] for v in data["violations"]}
        self.assertEqual(rules.get("BR-DE-TMP-32"), "information")

    def test_cli_default_profile_unchanged(self):
        proc = self.run_cli("validate", BASE, "--json")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertTrue(data["valid"])
        self.assertEqual(data["violations"], [])

    def test_cli_rejects_unknown_profile(self):
        proc = self.run_cli("validate", BASE, "--profile=peppol")
        self.assertEqual(proc.returncode, 2)


# --------------------------------------------------------------------------- #
# BR-DEX-15 — the ONE extension assert that exists ONLY in the CII artifact   #
# (XRechnung-CII-validation.sch, pattern cii-extension-pattern):              #
#   context  .../ram:IncludedSupplyChainTradeLineItem/                        #
#            ram:AssociatedDocumentLineDocument[$isExtension]                 #
#   test     not(exists(//ram:ParentLineID))          flag="warning"          #
# Unit fixtures mutate the clean XRechnung CII invoice 01.02a (fires NO       #
# admitted CII rule — pinned by test_rules_cii.py) through the CII layer.     #
# --------------------------------------------------------------------------- #
from einvoice import parser_cii                       # noqa: E402

XR_CII_BASE = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src",
                           "test", "business-cases", "standard",
                           "01.02a-INVOICE_uncefact.xml")
NS_RAM = parser_cii.NS_RAM
NS_CII = parser_cii.NS
_CII_BASE_ROOT = ET.parse(XR_CII_BASE).getroot()


def cii_base():
    return copy.deepcopy(_CII_BASE_ROOT)


def cii_fired(root):
    return {v.rule_id for v in xr.evaluate_cii(parser_cii.build_model(root))}


def _cii_guideline_id(root):
    return root.find("rsm:ExchangedDocumentContext/"
                     "ram:GuidelineSpecifiedDocumentContextParameter/ram:ID",
                     NS_CII)


def _cii_first_adld(root):
    return root.find("rsm:SupplyChainTradeTransaction/"
                     "ram:IncludedSupplyChainTradeLineItem/"
                     "ram:AssociatedDocumentLineDocument", NS_CII)


class BrDex15CiiShape(unittest.TestCase):
    """Registry shape: BR-DEX-15 lives in the CII layer ONLY, flag copied
    from the artifact (warning)."""

    def test_registered_cii_only_with_official_warning_flag(self):
        cii_by_id = {fn.rule_id: fn.severity for fn in xr.CII_DE_RULES}
        self.assertEqual(cii_by_id.get("BR-DEX-15"), "warning")
        # The vendored UBL artifact carries no BR-DEX-15 assert, so the UBL
        # registry must not either.
        self.assertNotIn("BR-DEX-15",
                         {fn.rule_id for fn in xr.ALL_RULES})


class BrDex15CiiFixtures(unittest.TestCase):
    """Positive fixture fires BR-DEX-15; negative fixtures stay clean."""

    def _make_extension(self, root):
        _cii_guideline_id(root).text = xr.XR_EXTENSION_ID

    def _add_parent_line_id(self, root):
        ET.SubElement(_cii_first_adld(root),
                      q(NS_RAM, "ParentLineID")).text = "1"

    def test_positive_extension_sub_invoice_line_fires(self):
        r = cii_base()
        self._make_extension(r)
        self._add_parent_line_id(r)
        # The extension id is a valid BT-24 (BR-DE-21 holds), the base is
        # BR-DE-clean, so EXACTLY BR-DEX-15 fires.
        self.assertEqual(cii_fired(r), {"BR-DEX-15"})

    def test_positive_severity_is_warning(self):
        r = cii_base()
        self._make_extension(r)
        self._add_parent_line_id(r)
        v = [v for v in xr.evaluate_cii(parser_cii.build_model(r))
             if v.rule_id == "BR-DEX-15"]
        self.assertEqual(len(v), 1)
        self.assertEqual(v[0].severity, "warning")

    def test_negative_clean_extension_does_not_fire(self):
        # Extension guideline but no ParentLineID anywhere -> assert holds.
        r = cii_base()
        self._make_extension(r)
        self.assertEqual(cii_fired(r), set())

    def test_negative_cius_invoice_with_parent_line_id_is_inert(self):
        # $isExtension is false on a plain CIUS invoice -> context never
        # matches, the rule is inert even with a ParentLineID present.
        r = cii_base()
        self._add_parent_line_id(r)
        self.assertNotIn("BR-DEX-15", cii_fired(r))

    def test_negative_no_context_node_means_no_fire(self):
        # Official context is the AssociatedDocumentLineDocument node set:
        # remove every one -> empty context, no assert is evaluated, even
        # though //ram:ParentLineID exists (here directly under the line).
        r = cii_base()
        self._make_extension(r)
        for ln in r.findall("rsm:SupplyChainTradeTransaction/"
                            "ram:IncludedSupplyChainTradeLineItem", NS_CII):
            for adld in ln.findall("ram:AssociatedDocumentLineDocument",
                                   NS_CII):
                ln.remove(adld)
            ET.SubElement(ln, q(NS_RAM, "ParentLineID")).text = "1"
        self.assertNotIn("BR-DEX-15", cii_fired(r))

    def test_model_carries_the_brdex15_surface(self):
        inv = parser_cii.build_model(cii_base())
        self.assertTrue(inv.has_assoc_document_line_document)
        self.assertFalse(inv.has_parent_line_id)
        r = cii_base()
        self._add_parent_line_id(r)
        self.assertTrue(parser_cii.build_model(r).has_parent_line_id)


# --------------------------------------------------------------------------- #
# CII payment means — BR-DE-19/20/23/24/25 (T-VHCIIDE.1), transcribed from    #
# XRechnung-CII-validation.sch pattern "cii":                                 #
#   context .../ram:ApplicableHeaderTradeSettlement/                          #
#           ram:SpecifiedTradeSettlementPaymentMeans                          #
#             [normalize-space(ram:TypeCode) = ('30','58')|('48','54','55')|  #
#              '59']                                                          #
#   flags copied exactly from the artifact: BR-DE-19/20 warning, the six      #
#   group asserts fatal.                                                      #
# The clean 01.02a base carries ONE means: TypeCode 58 + a valid payee IBAN   #
# (DE79000000001234567890), so it satisfies the whole group.                  #
# --------------------------------------------------------------------------- #
def _cii_pm(root):
    return root.find("rsm:SupplyChainTradeTransaction/"
                     "ram:ApplicableHeaderTradeSettlement/"
                     "ram:SpecifiedTradeSettlementPaymentMeans", NS_CII)


def _cii_settlement_el(root):
    return root.find("rsm:SupplyChainTradeTransaction/"
                     "ram:ApplicableHeaderTradeSettlement", NS_CII)


def cii_violations(root):
    return xr.evaluate_cii(parser_cii.build_model(root))


class CiiPaymentMeansShape(unittest.TestCase):
    """Registry shape: all 8 payment-means ids are in the CII layer with the
    artifact's exact flags, and are no longer differentially excluded."""

    ARTIFACT_FLAGS = {
        "BR-DE-19": "warning", "BR-DE-20": "warning",
        "BR-DE-23-a": "fatal", "BR-DE-23-b": "fatal",
        "BR-DE-24-a": "fatal", "BR-DE-24-b": "fatal",
        "BR-DE-25-a": "fatal", "BR-DE-25-b": "fatal",
    }

    def test_registered_with_official_flags(self):
        cii_by_id = {fn.rule_id: fn.severity for fn in xr.CII_DE_RULES}
        ubl_by_id = {fn.rule_id: fn.severity for fn in xr.ALL_RULES}
        for rid, flag in self.ARTIFACT_FLAGS.items():
            self.assertEqual(cii_by_id.get(rid), flag,
                             "%s: CII severity != artifact flag" % rid)
            # Same id, same flag in the UBL layer (the artifact uses the
            # same flag for both bindings).
            self.assertEqual(ubl_by_id.get(rid), flag,
                             "%s: UBL/CII flag mismatch" % rid)

    def test_flags_match_vendored_cii_artifact(self):
        """The severities above are not hand-trusted: re-read the vendored
        .sch and compare the @flag of each assert id."""
        sch = os.path.join(HERE, "corpus", "xrechnung-schematron",
                           "schematron", "cii",
                           "XRechnung-CII-validation.sch")
        ns = "{http://purl.oclc.org/dsdl/schematron}"
        flags = {}
        for a in ET.parse(sch).getroot().iter(ns + "assert"):
            if a.get("id") in self.ARTIFACT_FLAGS:
                flags[a.get("id")] = a.get("flag")
        self.assertEqual(flags, self.ARTIFACT_FLAGS)

    def test_no_longer_excluded_from_cii_grading(self):
        import differential as _diff
        for rid in self.ARTIFACT_FLAGS:
            self.assertIn(rid, set(_diff.CII_XR_RULE_IDS), rid)
            self.assertNotIn(rid, set(_diff.CII_XR_EXCLUDED_RULE_IDS), rid)


class CiiPaymentMeansFixtures(unittest.TestCase):
    """Positive (fires) + negative (clean) unit fixtures per rule id, all
    mutated off the BR-DE-clean 01.02a base (one means: 58 + valid IBAN)."""

    def _fired(self, root):
        return {v.rule_id for v in cii_violations(root)}

    def _only(self, root, rid):
        """Assert exactly {rid} fires and return its Violation."""
        vs = cii_violations(root)
        self.assertEqual({v.rule_id for v in vs}, {rid})
        return [v for v in vs if v.rule_id == rid][0]

    def _set_code(self, root, code):
        _cii_pm(root).find("ram:TypeCode", NS_CII).text = code

    def _drop_payee(self, root):
        pm = _cii_pm(root)
        pm.remove(pm.find("ram:PayeePartyCreditorFinancialAccount", NS_CII))

    def _add_card(self, root):
        ET.SubElement(_cii_pm(root),
                      q(NS_RAM, "ApplicableTradeSettlementFinancialCard"))

    def _add_payer_account(self, root, iban=None):
        acc = ET.SubElement(_cii_pm(root),
                            q(NS_RAM, "PayerPartyDebtorFinancialAccount"))
        el = ET.SubElement(acc, q(NS_RAM, "IBANID"))
        if iban is not None:
            el.text = iban

    # ---- BR-DE-19 (warning): BT-84 IBAN mod-97 on code 58 ----------------
    def test_de19_positive_bad_check_digits(self):
        r = cii_base()
        # Shape-valid IBAN whose mod-97 fails (last digit flipped).
        _cii_pm(r).find("ram:PayeePartyCreditorFinancialAccount/ram:IBANID",
                        NS_CII).text = "DE79000000001234567891"
        v = self._only(r, "BR-DE-19")
        self.assertEqual(v.severity, "warning")

    def test_de19_positive_whitespace_is_stripped_before_mod97(self):
        # The official test replace()s whitespace FIRST: a spaced-out valid
        # IBAN passes, a spaced-out invalid one still fires.
        r = cii_base()
        _cii_pm(r).find("ram:PayeePartyCreditorFinancialAccount/ram:IBANID",
                        NS_CII).text = "DE79 0000 0000 1234 5678 91"
        self.assertEqual(self._fired(r), {"BR-DE-19"})

    def test_de19_negative_valid_iban_and_code30(self):
        # Base (58 + valid IBAN) is clean...
        self.assertEqual(self._fired(cii_base()), set())
        r = cii_base()
        _cii_pm(r).find("ram:PayeePartyCreditorFinancialAccount/ram:IBANID",
                        NS_CII).text = "DE79 0000 0000 1234 5678 90"
        self.assertEqual(self._fired(r), set())
        # ...and code 30 holds VACUOUSLY even with a broken IBAN (the assert
        # is not(TypeCode='58') or IBAN-ok).
        r = cii_base()
        self._set_code(r, "30")
        _cii_pm(r).find("ram:PayeePartyCreditorFinancialAccount/ram:IBANID",
                        NS_CII).text = "NOT-AN-IBAN"
        self.assertNotIn("BR-DE-19", self._fired(r))

    # ---- BR-DE-20 (warning): BT-91 IBAN mod-97 on code 59 ----------------
    # (Since T-VHCIIDE.2 the document-level BR-DE-30/-31 are admitted on CII:
    # a payer IBANID with no mandate/creditor-reference is a PARTIAL BG-19,
    # so the official artifact — and now our layer — fires them alongside.)
    def test_de20_positive_bad_payer_iban(self):
        r = cii_base()
        self._set_code(r, "59")
        self._drop_payee(r)
        self._add_payer_account(r, "DE79000000001234567891")
        vs = cii_violations(r)
        by_id = {v.rule_id: v for v in vs}
        self.assertEqual(set(by_id), {"BR-DE-20", "BR-DE-30", "BR-DE-31"})
        self.assertEqual(by_id["BR-DE-20"].severity, "warning")

    def test_de20_negative_valid_payer_iban(self):
        r = cii_base()
        self._set_code(r, "59")
        self._drop_payee(r)
        self._add_payer_account(r, "DE79000000001234567890")
        # BR-DE-20 holds; only the partial-BG-19 pair remains.
        self.assertEqual(self._fired(r), {"BR-DE-30", "BR-DE-31"})

    # ---- BR-DE-23-a (fatal): 30/58 require BG-17 --------------------------
    def test_de23a_positive_no_payee_account(self):
        r = cii_base()
        self._drop_payee(r)
        vs = cii_violations(r)
        by_id = {v.rule_id: v for v in vs}
        self.assertIn("BR-DE-23-a", by_id)
        self.assertEqual(by_id["BR-DE-23-a"].severity, "fatal")
        # The absent IBANID also fails the BR-DE-19 IBAN test ('' has no
        # shape) — exactly like the official artifact.
        self.assertEqual(set(by_id), {"BR-DE-23-a", "BR-DE-19"})

    def test_de23a_negative_base_and_other_codes(self):
        self.assertNotIn("BR-DE-23-a", self._fired(cii_base()))
        # A non-group code (e.g. 20 cheque) never matches the context.
        r = cii_base()
        self._set_code(r, "20")
        self._drop_payee(r)
        self.assertEqual(self._fired(r), set())

    # ---- BR-DE-23-b (fatal): 30/58 forbid BG-18 / BG-19 -------------------
    def test_de23b_positive_card_present(self):
        r = cii_base()
        self._add_card(r)
        v = self._only(r, "BR-DE-23-b")
        self.assertEqual(v.severity, "fatal")

    def test_de23b_positive_payer_ibanid_element_even_empty(self):
        # The BG-19 disjunct is ELEMENT PRESENCE of ram:PayerPartyDebtor
        # FinancialAccount/ram:IBANID — an empty element still fires it
        # (and, as a partial BG-19 with neither BT-89 nor BT-90, the
        # document-level BR-DE-30/-31 fire too — T-VHCIIDE.2).
        r = cii_base()
        self._add_payer_account(r, iban=None)
        self.assertEqual(self._fired(r),
                         {"BR-DE-23-b", "BR-DE-30", "BR-DE-31"})

    def test_de23b_positive_document_level_mandate(self):
        # DirectDebitMandateID lives at DOCUMENT level (SpecifiedTradePayment
        # Terms), outside the payment means — the official absolute path.
        r = cii_base()
        terms = _cii_settlement_el(r).find("ram:SpecifiedTradePaymentTerms",
                                           NS_CII)
        ET.SubElement(terms, q(NS_RAM, "DirectDebitMandateID")).text = "M-1"
        # A mandate id alone is a partial BG-19: the document-level
        # BR-DE-30/-31 fire alongside (T-VHCIIDE.2), like the artifact.
        self.assertEqual(self._fired(r),
                         {"BR-DE-23-b", "BR-DE-30", "BR-DE-31"})

    def test_de23b_negative_base(self):
        self.assertNotIn("BR-DE-23-b", self._fired(cii_base()))

    # ---- BR-DE-24-a (fatal): 48/54/55 require BG-18 -----------------------
    def test_de24a_positive_no_card(self):
        for code in ("48", "54", "55"):
            r = cii_base()
            self._set_code(r, code)
            self._drop_payee(r)
            v = self._only(r, "BR-DE-24-a")
            self.assertEqual(v.severity, "fatal")

    def test_de24a_negative_card_present(self):
        r = cii_base()
        self._set_code(r, "54")
        self._drop_payee(r)
        self._add_card(r)
        self.assertEqual(self._fired(r), set())

    # ---- BR-DE-24-b (fatal): 48/54/55 forbid BG-17 / BG-19 ----------------
    def test_de24b_positive_payee_account_kept(self):
        r = cii_base()
        self._set_code(r, "48")
        self._add_card(r)          # BR-DE-24-a holds
        v = self._only(r, "BR-DE-24-b")
        self.assertEqual(v.severity, "fatal")

    def test_de24b_negative_card_only(self):
        r = cii_base()
        self._set_code(r, "48")
        self._drop_payee(r)
        self._add_card(r)
        self.assertEqual(self._fired(r), set())

    # ---- BR-DE-25-a (fatal): 59 requires BG-19 ----------------------------
    def test_de25a_positive_bare_direct_debit(self):
        r = cii_base()
        self._set_code(r, "59")
        self._drop_payee(r)
        vs = cii_violations(r)
        by_id = {v.rule_id: v for v in vs}
        self.assertIn("BR-DE-25-a", by_id)
        self.assertEqual(by_id["BR-DE-25-a"].severity, "fatal")
        # Absent payer IBAN also fails the BR-DE-20 IBAN test, like the
        # artifact.
        self.assertEqual(set(by_id), {"BR-DE-25-a", "BR-DE-20"})

    def test_de25a_negative_document_level_creditor_reference(self):
        # ram:CreditorReferenceID at the settlement (document) level
        # satisfies the BG-19 disjunct even with no payer account. Insert it
        # at position 0 (it is the first settlement child in the XSD; order
        # is irrelevant to the rules, kept sane anyway).
        r = cii_base()
        self._set_code(r, "59")
        self._drop_payee(r)
        cr = ET.Element(q(NS_RAM, "CreditorReferenceID"))
        cr.text = "DE98ZZZ09999999999"
        _cii_settlement_el(r).insert(0, cr)
        # BR-DE-25-a holds; BR-DE-20 still fires (there is no IBAN at all),
        # and a creditor reference alone is a partial BG-19 -> the
        # document-level BR-DE-30/-31 fire too (T-VHCIIDE.2).
        self.assertEqual(self._fired(r),
                         {"BR-DE-20", "BR-DE-30", "BR-DE-31"})

    # ---- BR-DE-25-b (fatal): 59 forbids BG-17 / BG-18 ---------------------
    # (A payer IBANID with no mandate/creditor-reference is a partial BG-19,
    # so the document-level BR-DE-30/-31 — admitted with T-VHCIIDE.2 — fire
    # alongside in each of these fixtures, exactly like the artifact.)
    def test_de25b_positive_payee_account_kept(self):
        r = cii_base()
        self._set_code(r, "59")
        self._add_payer_account(r, "DE79000000001234567890")
        vs = cii_violations(r)
        by_id = {v.rule_id: v for v in vs}
        self.assertEqual(set(by_id), {"BR-DE-25-b", "BR-DE-30", "BR-DE-31"})
        self.assertEqual(by_id["BR-DE-25-b"].severity, "fatal")

    def test_de25b_positive_financial_institution_conjuncts(self):
        # The 25-b conjuncts the other group asserts do NOT test: payee and
        # payer SpecifiedFinancialInstitution presence.
        for local in ("PayeeSpecifiedCreditorFinancialInstitution",
                      "PayerSpecifiedDebtorFinancialInstitution"):
            r = cii_base()
            self._set_code(r, "59")
            self._drop_payee(r)
            self._add_payer_account(r, "DE79000000001234567890")
            ET.SubElement(_cii_pm(r), q(NS_RAM, local))
            self.assertEqual(self._fired(r),
                             {"BR-DE-25-b", "BR-DE-30", "BR-DE-31"}, local)

    def test_de25b_negative_clean_direct_debit(self):
        r = cii_base()
        self._set_code(r, "59")
        self._drop_payee(r)
        self._add_payer_account(r, "DE79000000001234567890")
        # BR-DE-25-b holds; only the partial-BG-19 pair remains.
        self.assertEqual(self._fired(r), {"BR-DE-30", "BR-DE-31"})

    # ---- model surface sanity ---------------------------------------------
    def test_model_carries_the_payment_means_surface(self):
        inv = parser_cii.build_model(cii_base())
        self.assertEqual(len(inv.settlement_payment_means), 1)
        pm = inv.settlement_payment_means[0]
        self.assertEqual(pm.type_code, "58")
        self.assertTrue(pm.has_payee_account)
        self.assertEqual(pm.payee_iban, "DE79000000001234567890")
        self.assertFalse(pm.has_payer_iban)
        self.assertFalse(pm.has_card)
        self.assertFalse(inv.has_direct_debit_mandate_id)
        self.assertFalse(inv.has_creditor_reference_id)


# --------------------------------------------------------------------------- #
# CII BR-DE-30/-31 (direct-debit surface) + BR-DE-22 (unique attachment       #
# filenames) — T-VHCIIDE.2. Transcribed from the vendored XRechnung-CII       #
# Schematron (pattern cii-pattern, context /rsm:CrossIndustryInvoice):        #
#   let $BT-89-path = …/ram:SpecifiedTradePaymentTerms/ram:DirectDebitMandateID
#   let $BT-90-path = …/ram:ApplicableHeaderTradeSettlement/ram:CreditorReferenceID
#   let $BT-91-path = …/ram:SpecifiedTradeSettlementPaymentMeans/             #
#                     ram:PayerPartyDebtorFinancialAccount/ram:IBANID         #
#   BR-DE-30: (($BT-89-path or $BT-91-path) and $BT-90-path) or              #
#             $BG-19-not-existing                              flag="fatal"   #
#   BR-DE-31: (($BT-89-path or $BT-90-path) and $BT-91-path) or              #
#             $BG-19-not-existing                              flag="fatal"   #
#   BR-DE-22: count(//ram:AdditionalReferencedDocument) =                     #
#             count(//ram:AdditionalReferencedDocument[not(                   #
#               ./ram:AttachmentBinaryObject/@filename =                      #
#               preceding-sibling::ram:AdditionalReferencedDocument/          #
#               ram:AttachmentBinaryObject/@filename)])        flag="fatal"   #
# NOTE: the CII BR-DE-22 assert keys on ram:AttachmentBinaryObject/@filename  #
# (its human MESSAGE says 'embeddedDocumentBinaryObject'; the TEST does not). #
# --------------------------------------------------------------------------- #
class CiiDirectDebitAttachmentShape(unittest.TestCase):
    """Registry shape: BR-DE-22/-30/-31 are in the CII layer with the
    artifact's exact flags, and are no longer differentially excluded."""

    ARTIFACT_FLAGS = {
        "BR-DE-22": "fatal", "BR-DE-30": "fatal", "BR-DE-31": "fatal",
    }

    def test_registered_with_official_flags(self):
        cii_by_id = {fn.rule_id: fn.severity for fn in xr.CII_DE_RULES}
        ubl_by_id = {fn.rule_id: fn.severity for fn in xr.ALL_RULES}
        for rid, flag in self.ARTIFACT_FLAGS.items():
            self.assertEqual(cii_by_id.get(rid), flag,
                             "%s: CII severity != artifact flag" % rid)
            # Same id, same flag in the UBL layer (the artifact uses the
            # same flag for both bindings).
            self.assertEqual(ubl_by_id.get(rid), flag,
                             "%s: UBL/CII flag mismatch" % rid)

    def test_flags_match_vendored_cii_artifact(self):
        """The severities above are not hand-trusted: re-read the vendored
        .sch and compare the @flag of each assert id."""
        sch = os.path.join(HERE, "corpus", "xrechnung-schematron",
                           "schematron", "cii",
                           "XRechnung-CII-validation.sch")
        ns = "{http://purl.oclc.org/dsdl/schematron}"
        flags = {}
        for a in ET.parse(sch).getroot().iter(ns + "assert"):
            if a.get("id") in self.ARTIFACT_FLAGS:
                flags[a.get("id")] = a.get("flag")
        self.assertEqual(flags, self.ARTIFACT_FLAGS)

    def test_cii_assert_keys_on_attachment_binary_object(self):
        """The vendored CII BR-DE-22 @test keys on ram:AttachmentBinaryObject/
        @filename (NOT 'EmbeddedDocumentBinaryObject' as its message says) —
        pin that measurement so an artifact bump that re-binds it is caught."""
        sch = os.path.join(HERE, "corpus", "xrechnung-schematron",
                           "schematron", "cii",
                           "XRechnung-CII-validation.sch")
        ns = "{http://purl.oclc.org/dsdl/schematron}"
        tests = [a.get("test")
                 for a in ET.parse(sch).getroot().iter(ns + "assert")
                 if a.get("id") == "BR-DE-22"]
        self.assertEqual(len(tests), 1)
        self.assertIn("ram:AttachmentBinaryObject/@filename", tests[0])
        self.assertIn("preceding-sibling::ram:AdditionalReferencedDocument",
                      tests[0])
        self.assertNotIn("EmbeddedDocumentBinaryObject", tests[0])

    def test_no_longer_excluded_from_cii_grading(self):
        import differential as _diff
        for rid in self.ARTIFACT_FLAGS:
            self.assertIn(rid, set(_diff.CII_XR_RULE_IDS), rid)
            self.assertNotIn(rid, set(_diff.CII_XR_EXCLUDED_RULE_IDS), rid)
        # The exclusion class is EMPTY since T-VHCIIDE.3 admitted the last
        # national holdout (BR-DE-18 Skonto grammar).
        self.assertEqual(set(_diff.CII_XR_EXCLUDED_RULE_IDS), set())


class CiiDirectDebitFixtures(unittest.TestCase):
    """BR-DE-30/-31 positive + negative unit fixtures, mutated off the
    BR-DE-clean 01.02a base (one means: 58 + valid payee IBAN, no
    direct-debit surface at all)."""

    def _fired(self, root):
        return {v.rule_id for v in cii_violations(root)}

    def _set_code(self, root, code):
        _cii_pm(root).find("ram:TypeCode", NS_CII).text = code

    def _drop_payee(self, root):
        pm = _cii_pm(root)
        pm.remove(pm.find("ram:PayeePartyCreditorFinancialAccount", NS_CII))

    def _add_payer_account(self, root, iban=None):
        acc = ET.SubElement(_cii_pm(root),
                            q(NS_RAM, "PayerPartyDebtorFinancialAccount"))
        el = ET.SubElement(acc, q(NS_RAM, "IBANID"))
        if iban is not None:
            el.text = iban

    def _add_mandate(self, root):
        # BT-89: document-level SpecifiedTradePaymentTerms/DirectDebitMandateID.
        terms = _cii_settlement_el(root).find("ram:SpecifiedTradePaymentTerms",
                                              NS_CII)
        ET.SubElement(terms, q(NS_RAM, "DirectDebitMandateID")).text = "M-1"

    def _add_creditor_reference(self, root):
        # BT-90: document-level settlement ram:CreditorReferenceID.
        cr = ET.Element(q(NS_RAM, "CreditorReferenceID"))
        cr.text = "DE98ZZZ09999999999"
        _cii_settlement_el(root).insert(0, cr)

    def _direct_debit(self, root):
        # Turn the base's single means into a clean SEPA direct debit shell:
        # code 59, no payee account (so BR-DE-25-b holds).
        self._set_code(root, "59")
        self._drop_payee(root)

    # ---- BR-DE-30 (fatal): BG-19 present requires BT-90 -------------------
    def test_de30_positive_mandate_and_iban_without_bt90(self):
        r = cii_base()
        self._direct_debit(r)
        self._add_mandate(r)
        self._add_payer_account(r, "DE79000000001234567890")
        vs = cii_violations(r)
        self.assertEqual({v.rule_id for v in vs}, {"BR-DE-30"})
        self.assertEqual(vs[0].severity, "fatal")

    def test_de30_positive_bt91_alone(self):
        # A debited IBAN alone makes BG-19 exist -> BT-90 missing fires 30;
        # ((BT-89 or BT-90) and BT-91) is false too, so 31 fires as well.
        r = cii_base()
        self._direct_debit(r)
        self._add_payer_account(r, "DE79000000001234567890")
        self.assertEqual(self._fired(r), {"BR-DE-30", "BR-DE-31"})

    # ---- BR-DE-31 (fatal): BG-19 present requires BT-91 -------------------
    def test_de31_positive_mandate_and_bt90_without_iban(self):
        r = cii_base()
        self._direct_debit(r)
        self._add_mandate(r)
        self._add_creditor_reference(r)
        vs = cii_violations(r)
        by_id = {v.rule_id: v for v in vs}
        self.assertIn("BR-DE-31", by_id)
        self.assertEqual(by_id["BR-DE-31"].severity, "fatal")
        # The absent payer IBAN also fails the BR-DE-20 IBAN shape on code
        # 59 ('' has no shape) — exactly like the official artifact.
        self.assertEqual(set(by_id), {"BR-DE-31", "BR-DE-20"})

    def test_de30_and_de31_bt90_alone(self):
        # A creditor reference alone: BG-19 exists, both BT-90-conjunct
        # ((BT-89 or BT-91)) and BT-91 are missing -> 30 AND 31 fire
        # (+ BR-DE-20: no debited IBAN on code 59).
        r = cii_base()
        self._direct_debit(r)
        self._add_creditor_reference(r)
        self.assertEqual(self._fired(r),
                         {"BR-DE-30", "BR-DE-31", "BR-DE-20"})

    # ---- negatives ---------------------------------------------------------
    def test_negative_complete_bg19_fires_neither(self):
        r = cii_base()
        self._direct_debit(r)
        self._add_mandate(r)
        self._add_creditor_reference(r)
        self._add_payer_account(r, "DE79000000001234567890")
        self.assertEqual(self._fired(r), set())

    def test_negative_no_direct_debit_surface_fires_neither(self):
        # $BG-19-not-existing: none of BT-89/90/91 present -> both hold
        # (the clean base, in any payment-means code).
        self.assertEqual(self._fired(cii_base()), set())
        r = cii_base()
        self._set_code(r, "30")
        fired = self._fired(r)
        self.assertNotIn("BR-DE-30", fired)
        self.assertNotIn("BR-DE-31", fired)

    def test_negative_empty_iban_element_still_counts_as_bt91(self):
        # The lets are node-set EXISTENCE tests: an empty ram:IBANID element
        # still makes $BT-91-path true (so with BT-90 present, 31 holds and
        # only the BT-90-missing side matters).
        r = cii_base()
        self._direct_debit(r)
        self._add_mandate(r)
        self._add_payer_account(r, iban=None)
        # BT-90 missing -> 30 fires; 31 holds (BT-91 node exists);
        # BR-DE-20 fires (empty IBAN fails the shape on code 59).
        self.assertEqual(self._fired(r), {"BR-DE-30", "BR-DE-20"})

    # ---- model surface sanity ---------------------------------------------
    def test_model_carries_the_direct_debit_surface(self):
        r = cii_base()
        self._direct_debit(r)
        self._add_mandate(r)
        self._add_creditor_reference(r)
        self._add_payer_account(r, "DE79000000001234567890")
        inv = parser_cii.build_model(r)
        self.assertTrue(inv.has_direct_debit_mandate_id)
        self.assertTrue(inv.has_creditor_reference_id)
        self.assertEqual([pm.has_payer_iban
                          for pm in inv.settlement_payment_means], [True])


class CiiAttachmentFilenameFixtures(unittest.TestCase):
    """BR-DE-22 positive + negative unit fixtures. Attachments are
    header-agreement ram:AdditionalReferencedDocument elements (TypeCode 916,
    no ram:URIID so BR-TMP-2 holds on CII)."""

    def _fired(self, root):
        return {v.rule_id for v in cii_violations(root)}

    def _agreement(self, root):
        return root.find("rsm:SupplyChainTradeTransaction/"
                         "ram:ApplicableHeaderTradeAgreement", NS_CII)

    def _add_attachment_doc(self, parent, filename, n_objects=1):
        """One ram:AdditionalReferencedDocument with ``n_objects``
        ram:AttachmentBinaryObject children; filename=None omits the
        attribute entirely."""
        doc = ET.SubElement(parent, q(NS_RAM, "AdditionalReferencedDocument"))
        ET.SubElement(doc, q(NS_RAM, "IssuerAssignedID")).text = "att"
        ET.SubElement(doc, q(NS_RAM, "TypeCode")).text = "916"
        for _ in range(n_objects):
            obj = ET.SubElement(doc, q(NS_RAM, "AttachmentBinaryObject"))
            obj.text = "QUJD"
            obj.set("mimeCode", "application/pdf")
            if filename is not None:
                obj.set("filename", filename)
        return doc

    def test_positive_duplicate_filenames_fire(self):
        r = cii_base()
        self._add_attachment_doc(self._agreement(r), "duplicate.pdf")
        self._add_attachment_doc(self._agreement(r), "duplicate.pdf")
        vs = cii_violations(r)
        self.assertEqual({v.rule_id for v in vs}, {"BR-DE-22"})
        self.assertEqual(vs[0].severity, "fatal")

    def test_negative_unique_filenames_hold(self):
        r = cii_base()
        self._add_attachment_doc(self._agreement(r), "a.pdf")
        self._add_attachment_doc(self._agreement(r), "b.pdf")
        self.assertEqual(self._fired(r), set())

    def test_negative_filename_less_objects_hold(self):
        # No @filename attribute -> no @filename node in the official test's
        # node-set comparison -> can never compare equal (like the UBL twin).
        r = cii_base()
        self._add_attachment_doc(self._agreement(r), None)
        self._add_attachment_doc(self._agreement(r), None)
        self.assertEqual(self._fired(r), set())

    def test_negative_duplicate_within_one_document_holds(self):
        # Two equal @filename on the SAME AdditionalReferencedDocument: the
        # preceding-sibling axis never looks at self, so the official assert
        # holds — transcribed exactly.
        r = cii_base()
        self._add_attachment_doc(self._agreement(r), "same.pdf", n_objects=2)
        self.assertEqual(self._fired(r), set())

    def test_negative_duplicates_under_different_parents_hold(self):
        # The preceding-sibling axis scopes the comparison to ONE sibling
        # group: an equal filename on a LINE-level AdditionalReferencedDocument
        # (child of ram:SpecifiedLineTradeAgreement) never compares against a
        # header-agreement sibling group.
        r = cii_base()
        self._add_attachment_doc(self._agreement(r), "same.pdf")
        line_agreement = r.find("rsm:SupplyChainTradeTransaction/"
                                "ram:IncludedSupplyChainTradeLineItem/"
                                "ram:SpecifiedLineTradeAgreement", NS_CII)
        self.assertIsNotNone(line_agreement)
        self._add_attachment_doc(line_agreement, "same.pdf")
        self.assertEqual(self._fired(r), set())

    def test_positive_duplicate_across_documents_of_one_group(self):
        # Three siblings a/dup/dup: only the third has a preceding-sibling
        # match, which is enough — the count()s differ and the assert fires.
        r = cii_base()
        self._add_attachment_doc(self._agreement(r), "a.pdf")
        self._add_attachment_doc(self._agreement(r), "dup.pdf")
        self._add_attachment_doc(self._agreement(r), "dup.pdf")
        self.assertEqual(self._fired(r), {"BR-DE-22"})

    # ---- model surface sanity ---------------------------------------------
    def test_model_carries_the_attachment_surface(self):
        r = cii_base()
        self._add_attachment_doc(self._agreement(r), "a.pdf")
        self._add_attachment_doc(self._agreement(r), None)
        inv = parser_cii.build_model(r)
        self.assertEqual(inv.additional_ref_doc_attachments,
                         [[["a.pdf"], [None]]])


# --------------------------------------------------------------------------- #
# CII Skonto payment-terms grammar — BR-DE-18 (T-VHCIIDE.3). Transcribed from #
# the vendored XRechnung-CII Schematron (pattern cii-pattern, context         #
# /rsm:CrossIndustryInvoice, flag fatal):                                     #
#   every $line in rsm:SupplyChainTradeTransaction/                           #
#       ram:ApplicableHeaderTradeSettlement/ram:SpecifiedTradePaymentTerms/   #
#       ram:Description[1]/tokenize(., '(\r?\n)')                             #
#       [starts-with(normalize-space(.), '#')]                                #
#   satisfies matches(normalize-space($line), $XR-SKONTO-REGEX)               #
#   and matches(…/ram:Description[1]/tokenize(., '#.+#')[last()], '^\s*\n')   #
# Same quantifier body as the UBL twin over cac:PaymentTerms/cbc:Note[1] —    #
# both bindings evaluate the shared xr._skonto_terms_hold transcription.      #
# The clean 01.02a base carries ONE SpecifiedTradePaymentTerms with a plain   #
# prose Description (no '#' line), so BR-DE-18 holds vacuously on it.         #
# --------------------------------------------------------------------------- #
def _cii_terms_description(root):
    return _cii_settlement_el(root).find(
        "ram:SpecifiedTradePaymentTerms/ram:Description", NS_CII)


class CiiSkontoShape(unittest.TestCase):
    """Registry shape: BR-DE-18 is in the CII layer with the artifact's exact
    flag, and the CII exclusion class is now empty."""

    def test_registered_with_official_flag(self):
        cii_by_id = {fn.rule_id: fn.severity for fn in xr.CII_DE_RULES}
        ubl_by_id = {fn.rule_id: fn.severity for fn in xr.ALL_RULES}
        self.assertEqual(cii_by_id.get("BR-DE-18"), "fatal")
        # Same id, same flag in the UBL layer (the artifact uses the same
        # flag for both bindings).
        self.assertEqual(ubl_by_id.get("BR-DE-18"), "fatal")

    def test_flag_matches_vendored_cii_artifact(self):
        """The severity above is not hand-trusted: re-read the vendored .sch
        and compare the @flag (and pin the Description[1] context path the
        parser surface transcribes)."""
        sch = os.path.join(HERE, "corpus", "xrechnung-schematron",
                           "schematron", "cii",
                           "XRechnung-CII-validation.sch")
        ns = "{http://purl.oclc.org/dsdl/schematron}"
        asserts = [a for a in ET.parse(sch).getroot().iter(ns + "assert")
                   if a.get("id") == "BR-DE-18"]
        self.assertEqual(len(asserts), 1)
        self.assertEqual(asserts[0].get("flag"), "fatal")
        test = asserts[0].get("test")
        self.assertIn("ram:SpecifiedTradePaymentTerms/ram:Description[1]",
                      test)
        self.assertIn("$XR-SKONTO-REGEX", test)
        self.assertIn("'#.+#'", test)

    def test_no_longer_excluded_from_cii_grading(self):
        import differential as _diff
        self.assertIn("BR-DE-18", set(_diff.CII_XR_RULE_IDS))
        # T-VHCIIDE.3 emptied the class: the national BR-DE-* family is
        # complete on CII.
        self.assertEqual(set(_diff.CII_XR_EXCLUDED_RULE_IDS), set())


class CiiSkontoFixtures(unittest.TestCase):
    """Positive (fires) + negative (clean) BR-DE-18 unit fixtures, mutated
    off the BR-DE-clean 01.02a base's BT-20 Description."""

    def _fired(self, root):
        return {v.rule_id for v in cii_violations(root)}

    # ---- negative: valid Skonto grammar stays silent ----------------------
    def test_valid_skonto_line_with_trailing_newline_holds(self):
        r = cii_base()
        _cii_terms_description(r).text = "#SKONTO#TAGE=14#PROZENT=2.00#\n"
        self.assertEqual(self._fired(r), set())

    def test_valid_skonto_with_basisbetrag_holds(self):
        r = cii_base()
        _cii_terms_description(r).text = \
            "#SKONTO#TAGE=14#PROZENT=2.00#BASISBETRAG=357.93#\n"
        self.assertEqual(self._fired(r), set())

    def test_prose_description_without_hash_lines_holds_vacuously(self):
        # The base's plain prose BT-20 has no '#'-prefixed line: vacuous pass
        # (pinned by the clean-base fixture, restated here for the record).
        self.assertEqual(self._fired(cii_base()), set())

    # ---- positive: malformed grammar fires --------------------------------
    def test_missing_two_decimals_fires(self):
        r = cii_base()
        # PROZENT lacks the mandatory 2 decimals (same malformed line as the
        # differential CII mutant).
        _cii_terms_description(r).text = "#SKONTO#TAGE=14#PROZENT=2#"
        vs = cii_violations(r)
        self.assertEqual({v.rule_id for v in vs}, {"BR-DE-18"})
        self.assertEqual(vs[0].severity, "fatal")

    def test_lowercase_skonto_fires(self):
        r = cii_base()
        _cii_terms_description(r).text = "#skonto#TAGE=14#PROZENT=2.00#\n"
        self.assertEqual(self._fired(r), {"BR-DE-18"})

    def test_missing_trailing_newline_fires(self):
        r = cii_base()
        # Grammar-valid line but the required newline after the final '#'
        # is missing -> the tokenize(., '#.+#')[last()] check fails.
        _cii_terms_description(r).text = "#SKONTO#TAGE=14#PROZENT=2.00#"
        self.assertEqual(self._fired(r), {"BR-DE-18"})

    def test_second_payment_terms_dynamic_error_corner_fires(self):
        # TWO SpecifiedTradePaymentTerms with '#' lines: the official
        # matches() over 2+ Description[1] nodes is a dynamic error (the
        # whole transform aborts) — the engine deterministically FIRES in
        # that unreachable-for-comparison corner, like the UBL twin.
        r = cii_base()
        _cii_terms_description(r).text = "#SKONTO#TAGE=14#PROZENT=2.00#\n"
        terms2 = ET.SubElement(_cii_settlement_el(r),
                               q(NS_RAM, "SpecifiedTradePaymentTerms"))
        ET.SubElement(terms2, q(NS_RAM, "Description")).text = \
            "#SKONTO#TAGE=30#PROZENT=1.00#\n"
        self.assertEqual(self._fired(r), {"BR-DE-18"})

    # ---- model surface sanity ---------------------------------------------
    def test_model_carries_first_description_per_terms_node(self):
        r = cii_base()
        terms = _cii_settlement_el(r).find("ram:SpecifiedTradePaymentTerms",
                                           NS_CII)
        # A SECOND Description under the same terms node is NOT Description[1]
        # and must not be carried.
        ET.SubElement(terms, q(NS_RAM, "Description")).text = "ignored"
        inv = parser_cii.build_model(r)
        self.assertEqual(len(inv.payment_terms_descriptions), 1)
        self.assertTrue(
            inv.payment_terms_descriptions[0].startswith("Bitte überweisen"))


if __name__ == "__main__":
    unittest.main(verbosity=2)

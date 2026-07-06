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
    def test_32_rules_with_unique_ids_and_valid_severities(self):
        ids = [fn.rule_id for fn in xr.ALL_RULES]
        self.assertEqual(len(ids), 32)
        self.assertEqual(len(set(ids)), 32)
        for fn in xr.ALL_RULES:
            self.assertIn(fn.severity, ("fatal", "warning", "information"))

    def test_severity_mapping_matches_official_flags(self):
        by_id = {fn.rule_id: fn.severity for fn in xr.ALL_RULES}
        for rid in ("BR-DE-17", "BR-DE-19", "BR-DE-20", "BR-DE-21",
                    "BR-DE-26", "BR-DE-27", "BR-DE-28"):
            self.assertEqual(by_id[rid], "warning", rid)
        self.assertEqual(by_id["BR-DE-TMP-32"], "information")
        for rid, sev in by_id.items():
            if rid not in ("BR-DE-17", "BR-DE-19", "BR-DE-20", "BR-DE-21",
                           "BR-DE-26", "BR-DE-27", "BR-DE-28", "BR-DE-TMP-32"):
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


if __name__ == "__main__":
    unittest.main(verbosity=2)

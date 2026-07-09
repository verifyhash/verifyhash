#!/usr/bin/env python3
"""Unit tests for the EN 16931 core rules added in the VAT-breakdown /
Standard-rate batch (BR-45..48, BR-S-02..10), the invoice-line batch
(BR-25, BR-27, BR-28, BR-29, BR-30, BR-CO-04) and the Zero-rated/Exempt
VAT category batch (BR-Z-02..10, BR-E-02..10).

Fast, saxonche-free companion to the differential harness: the differential
(``python3 differential.py en``) proves these rules against the OFFICIAL CEN
EN16931-UBL Schematron; this file pins the proven verdicts so any regression
turns the mechanical gate red without needing Saxon.

Every case mutates the clean, differential-verified base invoice
(``corpus/vendored/valid/cen-bis3-positive_ubl.xml`` — a Standard-rated 25%
invoice that fires none of our rules) and asserts which rule ids fire / clear,
or builds a minimal fragment matching the official CEN unit-test vectors.

Standard library only. Run: python3 test_rules.py
"""

from __future__ import annotations

import copy
import os
import sys
import unittest
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.parser import NS_CAC, NS_CBC, NS_INVOICE  # noqa: E402
from einvoice.validate import validate_root              # noqa: E402

BASE = os.path.join(HERE, "corpus", "vendored", "valid",
                    "cen-bis3-positive_ubl.xml")
_BASE_ROOT = ET.parse(BASE).getroot()

NEW_RULES = {
    "BR-45", "BR-46", "BR-47", "BR-48",
    "BR-S-02", "BR-S-03", "BR-S-04", "BR-S-05", "BR-S-06", "BR-S-07",
    "BR-S-09", "BR-S-10",
}

# Invoice-line core batch (differentially proven the same way).
LINE_RULES = {
    "BR-25", "BR-26", "BR-27", "BR-28", "BR-29", "BR-30", "BR-CO-04",
}

# Payee / tax-representative / payment-instruction batch (differentially
# proven the same way).
PAYMENT_RULES = {
    "BR-17", "BR-18", "BR-19", "BR-20",
    "BR-49", "BR-50", "BR-51", "BR-55", "BR-57", "BR-61", "BR-62", "BR-63",
}

# Zero-rated (Z) + Exempt (E) VAT category batch (differentially proven the
# same way).
ZE_RULES = {
    "BR-Z-02", "BR-Z-03", "BR-Z-04", "BR-Z-05", "BR-Z-06", "BR-Z-07",
    "BR-Z-08", "BR-Z-09", "BR-Z-10",
    "BR-E-02", "BR-E-03", "BR-E-04", "BR-E-05", "BR-E-06", "BR-E-07",
    "BR-E-08", "BR-E-09", "BR-E-10",
}

# Reverse charge (AE) + Intra-community supply (K) VAT category batch
# (differentially proven the same way).
AEIC_RULES = {
    "BR-AE-02", "BR-AE-03", "BR-AE-04", "BR-AE-05", "BR-AE-06", "BR-AE-07",
    "BR-AE-08", "BR-AE-09", "BR-AE-10",
    "BR-IC-02", "BR-IC-03", "BR-IC-04", "BR-IC-05", "BR-IC-06", "BR-IC-07",
    "BR-IC-08", "BR-IC-09", "BR-IC-11", "BR-IC-12",
}

# Export outside the EU (G) + Not subject to VAT (O) VAT category batch
# (differentially proven the same way).
GO_RULES = {
    "BR-G-02", "BR-G-03", "BR-G-04", "BR-G-05", "BR-G-06", "BR-G-07",
    "BR-G-08", "BR-G-09", "BR-G-10",
    "BR-O-02", "BR-O-03", "BR-O-04", "BR-O-05", "BR-O-06", "BR-O-07",
    "BR-O-08", "BR-O-09", "BR-O-10", "BR-O-11", "BR-O-12", "BR-O-13", "BR-O-14",
}


def q(ns, local):
    return "{%s}%s" % (ns, local)


def base():
    return copy.deepcopy(_BASE_ROOT)


def fired(root):
    return {v.rule_id for v in validate_root(root).violations}


def child(parent, ns, local):
    return parent.find(q(ns, local))


def subtotal(root):
    return root.find("%s/%s" % (q(NS_CAC, "TaxTotal"), q(NS_CAC, "TaxSubtotal")))


def subtotal_category(root):
    return subtotal(root).find(q(NS_CAC, "TaxCategory"))


def supplier_party(root):
    return root.find("%s/%s" % (q(NS_CAC, "AccountingSupplierParty"),
                                q(NS_CAC, "Party")))


def first_line_item(root):
    return root.find("%s/%s" % (q(NS_CAC, "InvoiceLine"), q(NS_CAC, "Item")))


def add_doc_allowance_charge(root, charge, percent="25", category="S",
                             amount="10.00"):
    """Append a document-level AllowanceCharge (VAT) before cac:TaxTotal."""
    ac = ET.Element(q(NS_CAC, "AllowanceCharge"))
    ET.SubElement(ac, q(NS_CBC, "ChargeIndicator")).text = (
        "true" if charge else "false")
    ET.SubElement(ac, q(NS_CBC, "AllowanceChargeReason")).text = "Adjustment"
    amt = ET.SubElement(ac, q(NS_CBC, "Amount"))
    amt.text = amount
    amt.set("currencyID", "DKK")
    cat = ET.SubElement(ac, q(NS_CAC, "TaxCategory"))
    ET.SubElement(cat, q(NS_CBC, "ID")).text = category
    ET.SubElement(cat, q(NS_CBC, "Percent")).text = percent
    ET.SubElement(ET.SubElement(cat, q(NS_CAC, "TaxScheme")),
                  q(NS_CBC, "ID")).text = "VAT"
    tt = child(root, NS_CAC, "TaxTotal")
    root.insert(list(root).index(tt), ac)
    return ac


def convert_category(root, code, exemption_reason=None):
    """Rewrite the clean S-25% base into a clean single-category invoice
    (mirrors differential._convert_category): line + breakdown category ->
    ``code`` at 0%%, VAT amounts -> 0, totals reconciled. ``exemption_reason``
    (required for a clean E invoice by BR-E-10) lands on the breakdown
    TaxCategory before cac:TaxScheme."""
    ctc = first_line_item(root).find(q(NS_CAC, "ClassifiedTaxCategory"))
    child(ctc, NS_CBC, "ID").text = code
    child(ctc, NS_CBC, "Percent").text = "0"
    tt = child(root, NS_CAC, "TaxTotal")
    child(tt, NS_CBC, "TaxAmount").text = "0.00"
    st = subtotal(root)
    child(st, NS_CBC, "TaxAmount").text = "0.00"
    cat = st.find(q(NS_CAC, "TaxCategory"))
    child(cat, NS_CBC, "ID").text = code
    child(cat, NS_CBC, "Percent").text = "0"
    if exemption_reason is not None:
        reason = ET.Element(q(NS_CBC, "TaxExemptionReason"))
        reason.text = exemption_reason
        cat.insert(list(cat).index(cat.find(q(NS_CAC, "TaxScheme"))), reason)
    lmt = child(root, NS_CAC, "LegalMonetaryTotal")
    excl = child(lmt, NS_CBC, "TaxExclusiveAmount").text
    child(lmt, NS_CBC, "TaxInclusiveAmount").text = excl
    child(lmt, NS_CBC, "PayableAmount").text = excl


def zero_rated_base():
    r = base()
    convert_category(r, "Z")
    return r


def exempt_base():
    r = base()
    convert_category(r, "E", exemption_reason="Exempt from VAT")
    return r


def remove_seller_party_tax_scheme(root):
    party = supplier_party(root)
    party.remove(child(party, NS_CAC, "PartyTaxScheme"))


def reverse_charge_base():
    r = base()
    convert_category(r, "AE", exemption_reason="Reverse charge")
    return r


def intra_community_base():
    r = base()
    convert_category(r, "K")
    return r


def export_base():
    # 'Export outside the EU' (G) mirrors E: rate 0, breakdown reason required.
    r = base()
    convert_category(r, "G", exemption_reason="Export outside the EU")
    return r


def not_subject_base():
    """A clean 'Not subject to VAT' (O) invoice: no Invoiced item VAT rate
    (BR-O-05), NO Seller/Buyer VAT identifier (BR-O-02..04) and a breakdown
    exemption reason (BR-O-10)."""
    r = base()
    convert_category(r, "O", exemption_reason="Not subject to VAT")
    # O forbids the Invoiced item VAT rate (BT-152): drop the line Percent.
    ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
    p = child(ctc, NS_CBC, "Percent")
    if p is not None:
        ctc.remove(p)
    # O forbids the Seller VAT id (BT-31) and the Buyer VAT id (BT-48).
    remove_seller_party_tax_scheme(r)
    remove_buyer_party_tax_scheme(r)
    return r


def buyer_party(root):
    return root.find("%s/%s" % (q(NS_CAC, "AccountingCustomerParty"),
                                q(NS_CAC, "Party")))


def remove_buyer_party_tax_scheme(root):
    """Drop every Buyer cac:PartyTaxScheme (removes the Buyer VAT id, BT-48)."""
    party = buyer_party(root)
    for pts in party.findall(q(NS_CAC, "PartyTaxScheme")):
        party.remove(pts)


def remove_buyer_legal_entity_company_id(root):
    """Drop the Buyer cac:PartyLegalEntity/cbc:CompanyID (BT-47)."""
    ple = buyer_party(root).find(q(NS_CAC, "PartyLegalEntity"))
    cid = child(ple, NS_CBC, "CompanyID")
    if cid is not None:
        ple.remove(cid)


def doc_delivery(root):
    return child(root, NS_CAC, "Delivery")


class CleanBase(unittest.TestCase):
    def test_base_fires_none_of_the_new_rules(self):
        got = fired(base())
        self.assertEqual(got & NEW_RULES, set(),
                         "clean S-rated base must not fire any new rule")
        # And the base is fully clean for the whole ruleset.
        self.assertEqual(got, set())


class VatBreakdownExistence(unittest.TestCase):
    """BR-45..48 — per VAT breakdown (BG-23) subtotal."""

    def test_br_45_missing_taxable_amount(self):
        r = base()
        st = subtotal(r)
        st.remove(child(st, NS_CBC, "TaxableAmount"))
        self.assertIn("BR-45", fired(r))
        self.assertNotIn("BR-45", fired(base()))

    def test_br_46_missing_tax_amount(self):
        r = base()
        st = subtotal(r)
        st.remove(child(st, NS_CBC, "TaxAmount"))
        self.assertIn("BR-46", fired(r))
        self.assertNotIn("BR-46", fired(base()))

    def test_br_47_missing_category_id(self):
        r = base()
        cat = subtotal_category(r)
        cat.remove(child(cat, NS_CBC, "ID"))
        self.assertIn("BR-47", fired(r))
        self.assertNotIn("BR-47", fired(base()))

    def test_br_47_non_vat_scheme_also_fires(self):
        r = base()
        cat = subtotal_category(r)
        child(cat.find(q(NS_CAC, "TaxScheme")), NS_CBC, "ID").text = "OTHER"
        self.assertIn("BR-47", fired(r))

    def test_br_48_missing_percent(self):
        r = base()
        cat = subtotal_category(r)
        cat.remove(child(cat, NS_CBC, "Percent"))
        self.assertIn("BR-48", fired(r))
        self.assertNotIn("BR-48", fired(base()))

    def test_br_48_category_O_without_percent_holds(self):
        # 'Not subject to VAT' (O) is the codified exception: no Percent needed.
        r = base()
        cat = subtotal_category(r)
        child(cat, NS_CBC, "ID").text = "O"
        cat.remove(child(cat, NS_CBC, "Percent"))
        self.assertNotIn("BR-48", fired(r))


class StandardRateSellerId(unittest.TestCase):
    """BR-S-02..04 — S line/allowance/charge require a Seller VAT identifier."""

    def test_br_s_02_s_line_without_seller_vat_id_fires(self):
        r = base()
        party = supplier_party(r)
        party.remove(child(party, NS_CAC, "PartyTaxScheme"))
        self.assertIn("BR-S-02", fired(r))
        # Base has the Seller PartyTaxScheme/CompanyID -> holds.
        self.assertNotIn("BR-S-02", fired(base()))

    def test_br_s_02_tax_representative_satisfies(self):
        r = base()
        party = supplier_party(r)
        party.remove(child(party, NS_CAC, "PartyTaxScheme"))
        # Add a tax representative with a VAT PartyTaxScheme/CompanyID.
        trp = ET.Element(q(NS_CAC, "TaxRepresentativeParty"))
        pts = ET.SubElement(trp, q(NS_CAC, "PartyTaxScheme"))
        ET.SubElement(pts, q(NS_CBC, "CompanyID")).text = "DE999999999"
        ET.SubElement(ET.SubElement(pts, q(NS_CAC, "TaxScheme")),
                      q(NS_CBC, "ID")).text = "VAT"
        r.insert(0, trp)
        self.assertNotIn("BR-S-02", fired(r))

    def test_br_s_02_scheme_agnostic_s_line_fires(self):
        """The official BR-S-02 last disjunct is scheme-AGNOSTIC: an S
        ClassifiedTaxCategory with NO TaxScheme still triggers the rule when no
        Seller VAT id is present (the quirk the differential surfaced)."""
        r = base()
        party = supplier_party(r)
        party.remove(child(party, NS_CAC, "PartyTaxScheme"))
        # Strip the line item's ClassifiedTaxCategory TaxScheme (S remains).
        item = first_line_item(r)
        ctc = child(item, NS_CAC, "ClassifiedTaxCategory")
        ctc.remove(ctc.find(q(NS_CAC, "TaxScheme")))
        self.assertIn("BR-S-02", fired(r))

    def test_br_s_03_s_allowance_without_seller_vat_id_fires(self):
        r = base()
        add_doc_allowance_charge(r, charge=False, percent="25")
        party = supplier_party(r)
        party.remove(child(party, NS_CAC, "PartyTaxScheme"))
        got = fired(r)
        self.assertIn("BR-S-03", got)
        # With the seller id present it holds (only add the allowance).
        r2 = base()
        add_doc_allowance_charge(r2, charge=False, percent="25")
        self.assertNotIn("BR-S-03", fired(r2))

    def test_br_s_04_s_charge_without_seller_vat_id_fires(self):
        r = base()
        add_doc_allowance_charge(r, charge=True, percent="25")
        party = supplier_party(r)
        party.remove(child(party, NS_CAC, "PartyTaxScheme"))
        self.assertIn("BR-S-04", fired(r))
        r2 = base()
        add_doc_allowance_charge(r2, charge=True, percent="25")
        self.assertNotIn("BR-S-04", fired(r2))


class StandardRatePositiveRate(unittest.TestCase):
    """BR-S-05..07 — an S line/allowance/charge VAT rate must be > 0."""

    def test_br_s_05_zero_rate_line_fires(self):
        r = base()
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        child(ctc, NS_CBC, "Percent").text = "0"
        self.assertIn("BR-S-05", fired(r))
        self.assertNotIn("BR-S-05", fired(base()))

    def test_br_s_05_negative_rate_line_fires(self):
        r = base()
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        child(ctc, NS_CBC, "Percent").text = "-10"
        self.assertIn("BR-S-05", fired(r))

    def test_br_s_06_zero_rate_allowance_fires(self):
        r = base()
        add_doc_allowance_charge(r, charge=False, percent="0")
        self.assertIn("BR-S-06", fired(r))
        r2 = base()
        add_doc_allowance_charge(r2, charge=False, percent="25")
        self.assertNotIn("BR-S-06", fired(r2))

    def test_br_s_07_zero_rate_charge_fires(self):
        r = base()
        add_doc_allowance_charge(r, charge=True, percent="0")
        self.assertIn("BR-S-07", fired(r))
        r2 = base()
        add_doc_allowance_charge(r2, charge=True, percent="25")
        self.assertNotIn("BR-S-07", fired(r2))


class StandardRateBreakdown(unittest.TestCase):
    """BR-S-09/10 — S VAT breakdown arithmetic + exemption prohibition."""

    def test_br_s_09_tax_amount_off_band_fires(self):
        r = base()
        child(subtotal(r), NS_CBC, "TaxAmount").text = "99.99"  # far from 25%
        self.assertIn("BR-S-09", fired(r))
        self.assertNotIn("BR-S-09", fired(base()))

    def test_br_s_09_within_one_unit_holds(self):
        # 625743.54 * 25% = 156435.885 -> off by < 1 from 156435.00 -> holds.
        r = base()
        child(subtotal(r), NS_CBC, "TaxAmount").text = "156435.00"
        self.assertNotIn("BR-S-09", fired(r))

    def test_br_s_10_exemption_reason_fires(self):
        r = base()
        cat = subtotal_category(r)
        ET.SubElement(cat, q(NS_CBC, "TaxExemptionReason")).text = "n/a"
        self.assertIn("BR-S-10", fired(r))
        self.assertNotIn("BR-S-10", fired(base()))

    def test_br_s_10_exemption_reason_code_fires(self):
        r = base()
        cat = subtotal_category(r)
        ET.SubElement(cat, q(NS_CBC, "TaxExemptionReasonCode")).text = "10"
        self.assertIn("BR-S-10", fired(r))


class InvoiceLineBatch(unittest.TestCase):
    """BR-25/27/28/29/30 + BR-CO-04 — the invoice-line core batch."""

    def first_line(self, root):
        return root.find(q(NS_CAC, "InvoiceLine"))

    def line_price(self, root):
        return self.first_line(root).find(q(NS_CAC, "Price"))

    def doc_period(self, root):
        return root.find(q(NS_CAC, "InvoicePeriod"))

    def line_period(self, root):
        return self.first_line(root).find(q(NS_CAC, "InvoicePeriod"))

    def test_base_fires_none_of_the_line_rules(self):
        self.assertEqual(fired(base()) & LINE_RULES, set())

    # -- BR-25: item name ---------------------------------------------------
    def test_br_25_missing_item_name_fires(self):
        r = base()
        item = first_line_item(r)
        item.remove(child(item, NS_CBC, "Name"))
        self.assertIn("BR-25", fired(r))
        self.assertNotIn("BR-25", fired(base()))

    def test_br_25_whitespace_only_item_name_fires(self):
        # normalize-space('   ') = '' -> not a pure existence check.
        r = base()
        child(first_line_item(r), NS_CBC, "Name").text = "   "
        self.assertIn("BR-25", fired(r))

    # -- BR-26/27: item net price --------------------------------------------
    def test_br_26_and_27_missing_price_amount_fire(self):
        # The official artifact fires BOTH on a price-less line: BR-26 is
        # exists(); BR-27's general comparison () >= 0 is false.
        r = base()
        price = self.line_price(r)
        price.remove(child(price, NS_CBC, "PriceAmount"))
        got = fired(r)
        self.assertIn("BR-26", got)
        self.assertIn("BR-27", got)

    def test_br_27_negative_price_fires(self):
        r = base()
        child(self.line_price(r), NS_CBC, "PriceAmount").text = "-0.01"
        got = fired(r)
        self.assertIn("BR-27", got)
        self.assertNotIn("BR-26", got)  # the element exists

    def test_br_27_zero_price_holds(self):
        r = base()
        child(self.line_price(r), NS_CBC, "PriceAmount").text = "0"
        self.assertNotIn("BR-27", fired(r))

    # -- BR-28: item gross price ----------------------------------------------
    def add_price_allowance(self, root, base_amount):
        ac = ET.SubElement(self.line_price(root), q(NS_CAC, "AllowanceCharge"))
        ET.SubElement(ac, q(NS_CBC, "ChargeIndicator")).text = "false"
        amt = ET.SubElement(ac, q(NS_CBC, "Amount"))
        amt.text = "10.00"
        amt.set("currencyID", "DKK")
        if base_amount is not None:
            b = ET.SubElement(ac, q(NS_CBC, "BaseAmount"))
            b.text = base_amount
            b.set("currencyID", "DKK")

    def test_br_28_negative_gross_price_fires(self):
        r = base()
        self.add_price_allowance(r, "-1")
        self.assertIn("BR-28", fired(r))

    def test_br_28_zero_gross_price_holds(self):
        r = base()
        self.add_price_allowance(r, "0")
        self.assertNotIn("BR-28", fired(r))

    def test_br_28_no_base_amount_holds(self):
        # Presence-gated: not(exists(BaseAmount)) -> the assert holds.
        r = base()
        self.add_price_allowance(r, None)
        self.assertNotIn("BR-28", fired(r))

    # -- BR-29/30: period end >= start ---------------------------------------
    def test_br_29_doc_period_end_before_start_fires(self):
        r = base()
        child(self.doc_period(r), NS_CBC, "EndDate").text = "2018-08-31"
        got = fired(r)
        self.assertIn("BR-29", got)
        self.assertNotIn("BR-30", got)  # line period untouched

    def test_br_29_equal_dates_hold(self):
        r = base()
        child(self.doc_period(r), NS_CBC, "EndDate").text = "2018-09-01"
        self.assertNotIn("BR-29", fired(r))

    def test_br_29_end_only_holds(self):
        r = base()
        p = self.doc_period(r)
        p.remove(child(p, NS_CBC, "StartDate"))
        self.assertNotIn("BR-29", fired(r))

    def test_br_30_line_period_end_before_start_fires(self):
        r = base()
        child(self.line_period(r), NS_CBC, "EndDate").text = "2018-08-31"
        got = fired(r)
        self.assertIn("BR-30", got)
        self.assertNotIn("BR-29", got)  # doc period untouched

    # -- BR-CO-04: line VAT category code --------------------------------------
    def test_br_co_04_missing_classified_category_fires(self):
        r = base()
        item = first_line_item(r)
        item.remove(child(item, NS_CAC, "ClassifiedTaxCategory"))
        self.assertIn("BR-CO-04", fired(r))

    def test_br_co_04_non_vat_scheme_fires(self):
        r = base()
        ctc = child(first_line_item(r), NS_CAC, "ClassifiedTaxCategory")
        child(ctc.find(q(NS_CAC, "TaxScheme")), NS_CBC, "ID").text = "GST"
        self.assertIn("BR-CO-04", fired(r))

    def test_br_co_04_missing_category_id_fires(self):
        r = base()
        ctc = child(first_line_item(r), NS_CAC, "ClassifiedTaxCategory")
        ctc.remove(child(ctc, NS_CBC, "ID"))
        self.assertIn("BR-CO-04", fired(r))


class PayeeAndTaxRepresentative(unittest.TestCase):
    """BR-17..20 — Payee (BG-10) and Seller tax representative (BG-11/12)."""

    def add_payee(self, root, name=None, party_id=None):
        pp = ET.Element(q(NS_CAC, "PayeeParty"))
        if party_id is not None:
            pid = ET.SubElement(pp, q(NS_CAC, "PartyIdentification"))
            ET.SubElement(pid, q(NS_CBC, "ID")).text = party_id
        if name is not None:
            pn = ET.SubElement(pp, q(NS_CAC, "PartyName"))
            ET.SubElement(pn, q(NS_CBC, "Name")).text = name
        root.insert(list(root).index(child(root, NS_CAC, "Delivery")), pp)

    def add_tax_representative(self, root, name=None, postal_address=False,
                               country=None):
        trp = ET.Element(q(NS_CAC, "TaxRepresentativeParty"))
        if name is not None:
            pn = ET.SubElement(trp, q(NS_CAC, "PartyName"))
            ET.SubElement(pn, q(NS_CBC, "Name")).text = name
        if postal_address:
            pa = ET.SubElement(trp, q(NS_CAC, "PostalAddress"))
            if country is not None:
                c = ET.SubElement(pa, q(NS_CAC, "Country"))
                ET.SubElement(c, q(NS_CBC, "IdentificationCode")).text = country
        root.insert(list(root).index(child(root, NS_CAC, "Delivery")), trp)

    def test_base_fires_none_of_the_payment_rules(self):
        self.assertEqual(fired(base()) & PAYMENT_RULES, set())

    # -- BR-17: payee name -----------------------------------------------------
    def test_br_17_payee_without_name_fires(self):
        r = base()
        self.add_payee(r, name=None, party_id="PAYEE-1")
        self.assertIn("BR-17", fired(r))

    def test_br_17_distinct_payee_holds(self):
        r = base()
        self.add_payee(r, name="Payee Corp", party_id="PAYEE-1")
        self.assertNotIn("BR-17", fired(r))

    def test_br_17_payee_name_equal_to_seller_fires(self):
        # The official test rejects a PayeeParty duplicating the Seller name.
        r = base()
        self.add_payee(r, name="Company A")
        self.assertIn("BR-17", fired(r))

    def test_br_17_payee_id_equal_to_seller_fires(self):
        # Distinct name but the Seller's PartyIdentification/ID.
        r = base()
        self.add_payee(r, name="Payee Corp", party_id="DK12345678")
        self.assertIn("BR-17", fired(r))

    # -- BR-18/19/20: seller tax representative --------------------------------
    def test_br_18_missing_name_fires(self):
        r = base()
        self.add_tax_representative(r, name=None, postal_address=True,
                                    country="DK")
        got = fired(r)
        self.assertIn("BR-18", got)
        self.assertNotIn("BR-19", got)
        self.assertNotIn("BR-20", got)

    def test_br_18_whitespace_name_fires(self):
        # normalize-space('   ') = '' -> not a pure existence check.
        r = base()
        self.add_tax_representative(r, name="   ", postal_address=True,
                                    country="DK")
        self.assertIn("BR-18", fired(r))

    def test_br_19_missing_postal_address_fires(self):
        r = base()
        self.add_tax_representative(r, name="Rep GmbH", postal_address=False)
        got = fired(r)
        self.assertIn("BR-19", got)
        self.assertNotIn("BR-18", got)
        self.assertNotIn("BR-20", got)  # BR-20's context node is absent

    def test_br_20_missing_country_code_fires(self):
        r = base()
        self.add_tax_representative(r, name="Rep GmbH", postal_address=True,
                                    country=None)
        got = fired(r)
        self.assertIn("BR-20", got)
        self.assertNotIn("BR-18", got)
        self.assertNotIn("BR-19", got)

    def test_full_tax_representative_holds(self):
        r = base()
        self.add_tax_representative(r, name="Rep GmbH", postal_address=True,
                                    country="DE")
        self.assertEqual(fired(r) & {"BR-18", "BR-19", "BR-20"}, set())


class PaymentInstructions(unittest.TestCase):
    """BR-49/50/51/61 — payment instructions (BG-16/17/18)."""

    def pm(self, root):
        return child(root, NS_CAC, "PaymentMeans")

    # -- BR-49: payment means type code ----------------------------------------
    def test_br_49_missing_code_fires(self):
        r = base()
        pm = self.pm(r)
        pm.remove(child(pm, NS_CBC, "PaymentMeansCode"))
        got = fired(r)
        self.assertIn("BR-49", got)
        # Absent code normalize-spaces to '' -> BR-61's second disjunct holds.
        self.assertNotIn("BR-61", got)
        self.assertNotIn("BR-49", fired(base()))

    def test_br_49_empty_code_element_holds(self):
        # exists() — a present-but-empty code satisfies BR-49.
        r = base()
        child(self.pm(r), NS_CBC, "PaymentMeansCode").text = ""
        self.assertNotIn("BR-49", fired(r))

    # -- BR-50: credit-transfer account id -------------------------------------
    def test_br_50_missing_account_id_fires(self):
        r = base()
        acct = child(self.pm(r), NS_CAC, "PayeeFinancialAccount")
        acct.remove(child(acct, NS_CBC, "ID"))
        got = fired(r)
        self.assertIn("BR-50", got)
        self.assertIn("BR-61", got)   # no account id on a code-58 PaymentMeans
        self.assertNotIn("BR-50", fired(base()))

    def test_br_50_whitespace_account_id_fires(self):
        # normalize-space('  ') = '' — BR-50 is NOT a pure existence check.
        r = base()
        acct = child(self.pm(r), NS_CAC, "PayeeFinancialAccount")
        child(acct, NS_CBC, "ID").text = "   "
        got = fired(r)
        self.assertIn("BR-50", got)
        self.assertNotIn("BR-61", got)  # the ID element EXISTS -> BR-61 holds

    def test_br_50_padded_code_does_not_match_context(self):
        # BR-50's context predicate compares RAW code values: ' 58 ' != '58'
        # -> context never matches; BR-61 normalize-spaces and DOES apply.
        r = base()
        child(self.pm(r), NS_CBC, "PaymentMeansCode").text = " 58 "
        acct = child(self.pm(r), NS_CAC, "PayeeFinancialAccount")
        acct.remove(child(acct, NS_CBC, "ID"))
        got = fired(r)
        self.assertNotIn("BR-50", got)
        self.assertIn("BR-61", got)

    def test_br_50_non_credit_transfer_code_holds(self):
        r = base()
        child(self.pm(r), NS_CBC, "PaymentMeansCode").text = "10"
        acct = child(self.pm(r), NS_CAC, "PayeeFinancialAccount")
        acct.remove(child(acct, NS_CBC, "ID"))
        got = fired(r)
        self.assertNotIn("BR-50", got)
        self.assertNotIn("BR-61", got)

    # -- BR-61: account id for credit-transfer codes ---------------------------
    def test_br_61_account_removed_fires(self):
        r = base()
        pm = self.pm(r)
        pm.remove(child(pm, NS_CAC, "PayeeFinancialAccount"))
        got = fired(r)
        self.assertIn("BR-61", got)
        self.assertNotIn("BR-50", got)  # BR-50's context node vanished
        self.assertNotIn("BR-61", fired(base()))

    def test_br_61_code_30_fires_too(self):
        r = base()
        pm = self.pm(r)
        child(pm, NS_CBC, "PaymentMeansCode").text = "30"
        pm.remove(child(pm, NS_CAC, "PayeeFinancialAccount"))
        self.assertIn("BR-61", fired(r))

    # -- BR-51: card primary account number ------------------------------------
    def add_card(self, root, pan):
        card = ET.SubElement(self.pm(root), q(NS_CAC, "CardAccount"))
        ET.SubElement(card, q(NS_CBC, "PrimaryAccountNumberID")).text = pan
        ET.SubElement(card, q(NS_CBC, "NetworkID")).text = "VISA"

    def test_br_51_full_pan_fires_as_warning(self):
        r = base()
        self.add_card(r, "4111111111111111")
        result = validate_root(r)
        by_id = {v.rule_id: v for v in result.violations}
        self.assertIn("BR-51", by_id)
        self.assertEqual(by_id["BR-51"].severity, "warning")
        self.assertTrue(result.ok)  # warning does not block validity

    def test_br_51_truncated_pan_holds(self):
        r = base()
        self.add_card(r, " 4111**1111 ")   # 10 chars after normalize-space
        self.assertNotIn("BR-51", fired(r))


class ReferencesAndAddresses(unittest.TestCase):
    """BR-55 (preceding invoice reference), BR-57 (deliver-to country),
    BR-62/BR-63 (electronic-address scheme identifiers)."""

    def add_billing_reference(self, root, with_id):
        br = ET.Element(q(NS_CAC, "BillingReference"))
        idr = ET.SubElement(br, q(NS_CAC, "InvoiceDocumentReference"))
        if with_id:
            ET.SubElement(idr, q(NS_CBC, "ID")).text = "INV-000"
        root.insert(
            list(root).index(child(root, NS_CAC, "AccountingSupplierParty")),
            br)

    def delivery_address(self, root):
        return root.find("%s/%s/%s" % (q(NS_CAC, "Delivery"),
                                       q(NS_CAC, "DeliveryLocation"),
                                       q(NS_CAC, "Address")))

    def test_br_55_reference_without_id_fires(self):
        r = base()
        self.add_billing_reference(r, with_id=False)
        self.assertIn("BR-55", fired(r))

    def test_br_55_reference_with_id_holds(self):
        r = base()
        self.add_billing_reference(r, with_id=True)
        self.assertNotIn("BR-55", fired(r))

    def test_br_57_missing_country_fires(self):
        r = base()
        addr = self.delivery_address(r)
        addr.remove(addr.find(q(NS_CAC, "Country")))
        self.assertIn("BR-57", fired(r))
        self.assertNotIn("BR-57", fired(base()))

    def test_br_57_empty_country_code_holds(self):
        # exists() — a present-but-empty IdentificationCode satisfies BR-57
        # (unlike the normalize-space rules BR-09/BR-11/BR-20).
        r = base()
        addr = self.delivery_address(r)
        addr.find("%s/%s" % (q(NS_CAC, "Country"),
                             q(NS_CBC, "IdentificationCode"))).text = ""
        self.assertNotIn("BR-57", fired(r))

    def test_br_62_missing_scheme_id_fires(self):
        r = base()
        ep = supplier_party(r).find(q(NS_CBC, "EndpointID"))
        del ep.attrib["schemeID"]
        got = fired(r)
        self.assertIn("BR-62", got)
        self.assertNotIn("BR-63", got)
        self.assertNotIn("BR-62", fired(base()))

    def test_br_62_empty_scheme_id_holds(self):
        # exists(@schemeID) — an empty attribute still exists.
        r = base()
        supplier_party(r).find(q(NS_CBC, "EndpointID")).set("schemeID", "")
        self.assertNotIn("BR-62", fired(r))

    def test_br_63_missing_scheme_id_fires(self):
        r = base()
        party = r.find("%s/%s" % (q(NS_CAC, "AccountingCustomerParty"),
                                  q(NS_CAC, "Party")))
        ep = party.find(q(NS_CBC, "EndpointID"))
        del ep.attrib["schemeID"]
        got = fired(r)
        self.assertIn("BR-63", got)
        self.assertNotIn("BR-62", got)
        self.assertNotIn("BR-63", fired(base()))


class _VatCategoryBatch:
    """Shared positive/negative cases for the Zero-rated (Z) and Exempt (E)
    families — same rule shapes, different code and exemption-reason polarity
    (BR-Z-10 forbids BT-120/121 on the breakdown, BR-E-10 requires one)."""

    code = None          # 'Z' / 'E'
    fam = None           # rule-id family: 'Z' / 'E'

    def rid(self, n):
        return "BR-%s-%02d" % (self.fam, n)

    def cat_base(self):
        raise NotImplementedError

    # -- clean converted base -------------------------------------------------
    def test_clean_category_base_fires_nothing(self):
        self.assertEqual(fired(self.cat_base()), set())

    # -- -02..04: seller VAT identifier ----------------------------------------
    def test_02_line_without_seller_vat_id_fires(self):
        r = self.cat_base()
        remove_seller_party_tax_scheme(r)
        self.assertIn(self.rid(2), fired(r))
        self.assertNotIn(self.rid(2), fired(self.cat_base()))

    def test_02_tax_representative_satisfies(self):
        r = self.cat_base()
        remove_seller_party_tax_scheme(r)
        trp = ET.Element(q(NS_CAC, "TaxRepresentativeParty"))
        pts = ET.SubElement(trp, q(NS_CAC, "PartyTaxScheme"))
        ET.SubElement(pts, q(NS_CBC, "CompanyID")).text = "DE999999999"
        ET.SubElement(ET.SubElement(pts, q(NS_CAC, "TaxScheme")),
                      q(NS_CBC, "ID")).text = "VAT"
        r.insert(0, trp)
        self.assertNotIn(self.rid(2), fired(r))

    def test_02_scheme_less_line_category_does_not_fire(self):
        # Unlike BR-S-02, BOTH disjuncts of the official -02 test are
        # VAT-scheme scoped: a Z/E ClassifiedTaxCategory with NO TaxScheme
        # matches neither node set, so the rule holds even without a seller id.
        r = self.cat_base()
        remove_seller_party_tax_scheme(r)
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        ctc.remove(ctc.find(q(NS_CAC, "TaxScheme")))
        self.assertNotIn(self.rid(2), fired(r))

    def test_03_allowance_without_seller_vat_id_fires(self):
        r = self.cat_base()
        add_doc_allowance_charge(r, charge=False, percent="0",
                                 category=self.code)
        remove_seller_party_tax_scheme(r)
        self.assertIn(self.rid(3), fired(r))
        r2 = self.cat_base()
        add_doc_allowance_charge(r2, charge=False, percent="0",
                                 category=self.code)
        self.assertNotIn(self.rid(3), fired(r2))

    def test_04_charge_without_seller_vat_id_fires(self):
        r = self.cat_base()
        add_doc_allowance_charge(r, charge=True, percent="0",
                                 category=self.code)
        remove_seller_party_tax_scheme(r)
        self.assertIn(self.rid(4), fired(r))
        r2 = self.cat_base()
        add_doc_allowance_charge(r2, charge=True, percent="0",
                                 category=self.code)
        self.assertNotIn(self.rid(4), fired(r2))

    # -- -05..07: VAT rate must be 0 -------------------------------------------
    def test_05_nonzero_rate_line_fires(self):
        r = self.cat_base()
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        child(ctc, NS_CBC, "Percent").text = "5"
        self.assertIn(self.rid(5), fired(r))
        self.assertNotIn(self.rid(5), fired(self.cat_base()))  # 0 holds

    def test_05_missing_rate_fires(self):
        # xs:decimal(()) = 0 is FALSE -> an absent Percent fires (unlike the
        # 'greater than zero' BR-S-05, the equality still needs an operand).
        r = self.cat_base()
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        ctc.remove(child(ctc, NS_CBC, "Percent"))
        self.assertIn(self.rid(5), fired(r))

    def test_06_nonzero_rate_allowance_fires(self):
        r = self.cat_base()
        add_doc_allowance_charge(r, charge=False, percent="5",
                                 category=self.code)
        self.assertIn(self.rid(6), fired(r))
        r2 = self.cat_base()
        add_doc_allowance_charge(r2, charge=False, percent="0",
                                 category=self.code)
        self.assertNotIn(self.rid(6), fired(r2))

    def test_07_nonzero_rate_charge_fires(self):
        r = self.cat_base()
        add_doc_allowance_charge(r, charge=True, percent="5",
                                 category=self.code)
        self.assertIn(self.rid(7), fired(r))
        r2 = self.cat_base()
        add_doc_allowance_charge(r2, charge=True, percent="0",
                                 category=self.code)
        self.assertNotIn(self.rid(7), fired(r2))

    # -- -08: breakdown taxable amount = exact category sum ---------------------
    def test_08_taxable_amount_mismatch_fires(self):
        r = self.cat_base()
        child(subtotal(r), NS_CBC, "TaxableAmount").text = "111111.11"
        self.assertIn(self.rid(8), fired(r))
        self.assertNotIn(self.rid(8), fired(self.cat_base()))

    def test_08_exact_equality_no_tolerance(self):
        # BR-S-09 has a +/-1 band; the -08 sum rules are EXACT equality.
        r = self.cat_base()
        child(subtotal(r), NS_CBC, "TaxableAmount").text = "625743.55"  # off 0.01
        self.assertIn(self.rid(8), fired(r))

    def test_08_allowance_enters_the_sum(self):
        # A matching-category doc allowance is subtracted from the expected sum.
        r = self.cat_base()
        add_doc_allowance_charge(r, charge=False, percent="0",
                                 category=self.code, amount="10.00")
        child(subtotal(r), NS_CBC, "TaxableAmount").text = "625733.54"
        self.assertNotIn(self.rid(8), fired(r))

    # -- -09: breakdown tax amount = 0 ------------------------------------------
    def test_09_nonzero_tax_amount_fires(self):
        r = self.cat_base()
        child(subtotal(r), NS_CBC, "TaxAmount").text = "10.00"
        self.assertIn(self.rid(9), fired(r))
        self.assertNotIn(self.rid(9), fired(self.cat_base()))

    def test_09_zero_with_decimals_holds(self):
        r = self.cat_base()
        child(subtotal(r), NS_CBC, "TaxAmount").text = "0"
        self.assertNotIn(self.rid(9), fired(r))


class ZeroRatedBatch(_VatCategoryBatch, unittest.TestCase):
    """BR-Z-02..10 — Zero rated (Z) VAT category rules."""

    code = "Z"
    fam = "Z"

    def cat_base(self):
        return zero_rated_base()

    def test_br_z_10_exemption_reason_fires(self):
        r = self.cat_base()
        cat = subtotal_category(r)
        ET.SubElement(cat, q(NS_CBC, "TaxExemptionReason")).text = "n/a"
        self.assertIn("BR-Z-10", fired(r))
        self.assertNotIn("BR-Z-10", fired(self.cat_base()))

    def test_br_z_10_exemption_reason_code_fires(self):
        r = self.cat_base()
        cat = subtotal_category(r)
        ET.SubElement(cat, q(NS_CBC, "TaxExemptionReasonCode")).text = "VATEX-EU-O"
        self.assertIn("BR-Z-10", fired(r))


class ExemptBatch(_VatCategoryBatch, unittest.TestCase):
    """BR-E-02..10 — Exempt from VAT (E) VAT category rules."""

    code = "E"
    fam = "E"

    def cat_base(self):
        return exempt_base()

    def test_br_e_10_missing_exemption_reason_fires(self):
        # An E breakdown REQUIRES a reason text or code (mirror of BR-Z-10).
        r = base()
        convert_category(r, "E", exemption_reason=None)
        self.assertIn("BR-E-10", fired(r))
        self.assertNotIn("BR-E-10", fired(self.cat_base()))  # text present

    def test_br_e_10_reason_code_alone_satisfies(self):
        r = base()
        convert_category(r, "E", exemption_reason=None)
        cat = subtotal_category(r)
        code_el = ET.Element(q(NS_CBC, "TaxExemptionReasonCode"))
        code_el.text = "VATEX-EU-132"
        cat.insert(list(cat).index(cat.find(q(NS_CAC, "TaxScheme"))), code_el)
        self.assertNotIn("BR-E-10", fired(r))


class ReverseChargeBatch(_VatCategoryBatch, unittest.TestCase):
    """BR-AE-02..10 — Reverse charge (AE) VAT category rules.

    Inherits the shared -02..09 seller-id/rate/breakdown cases; adds the
    reverse-charge specific coverage (the BUYER-identifier disjunct of
    BR-AE-02..04 and the mandatory exemption reason of BR-AE-10)."""

    code = "AE"
    fam = "AE"

    def cat_base(self):
        return reverse_charge_base()

    # -- -02..04: the NEW buyer-identifier requirement -------------------------
    def test_02_missing_buyer_id_fires(self):
        # Seller id present, but NO Buyer VAT id (BT-48) and NO Buyer legal
        # registration id (BT-47) -> BR-AE-02 fires.
        r = self.cat_base()
        remove_buyer_party_tax_scheme(r)
        remove_buyer_legal_entity_company_id(r)
        self.assertIn("BR-AE-02", fired(r))
        self.assertNotIn("BR-AE-02", fired(self.cat_base()))

    def test_02_buyer_legal_entity_alone_satisfies(self):
        # AE accepts the Buyer legal registration id (BT-47) as the buyer
        # disjunct: drop the Buyer VAT id but keep PartyLegalEntity/CompanyID.
        r = self.cat_base()
        remove_buyer_party_tax_scheme(r)
        self.assertNotIn("BR-AE-02", fired(r))

    # -- -10: exemption reason mandatory --------------------------------------
    def test_br_ae_10_missing_exemption_reason_fires(self):
        r = base()
        convert_category(r, "AE", exemption_reason=None)
        self.assertIn("BR-AE-10", fired(r))
        self.assertNotIn("BR-AE-10", fired(self.cat_base()))  # reason present

    def test_br_ae_10_reason_code_alone_satisfies(self):
        r = base()
        convert_category(r, "AE", exemption_reason=None)
        cat = subtotal_category(r)
        code_el = ET.Element(q(NS_CBC, "TaxExemptionReasonCode"))
        code_el.text = "VATEX-EU-AE"
        cat.insert(list(cat).index(cat.find(q(NS_CAC, "TaxScheme"))), code_el)
        self.assertNotIn("BR-AE-10", fired(r))


class IntraCommunityBatch(_VatCategoryBatch, unittest.TestCase):
    """BR-IC-02..12 — Intra-community supply (K) VAT category rules.

    Inherits the shared -02..09 cases; adds the stricter (VAT-scoped) buyer
    requirement of BR-IC-02..04 and the delivery-information rules BR-IC-11/12.
    (There is no BR-IC-10.)"""

    code = "K"
    fam = "IC"

    def cat_base(self):
        return intra_community_base()

    # -- -02..04: buyer VAT id required; legal entity does NOT satisfy ---------
    def test_02_missing_buyer_vat_id_fires(self):
        r = self.cat_base()
        remove_buyer_party_tax_scheme(r)
        self.assertIn("BR-IC-02", fired(r))
        self.assertNotIn("BR-IC-02", fired(self.cat_base()))

    def test_02_legal_entity_does_not_satisfy(self):
        # Unlike BR-AE-02, the Buyer legal registration id (BT-47) is NOT
        # accepted: only the Buyer VAT id (BT-48) satisfies BR-IC-02. Dropping
        # the VAT id while KEEPING PartyLegalEntity/CompanyID still fires.
        r = self.cat_base()
        remove_buyer_party_tax_scheme(r)
        self.assertIsNotNone(
            buyer_party(r).find("%s/%s" % (q(NS_CAC, "PartyLegalEntity"),
                                           q(NS_CBC, "CompanyID"))))
        self.assertIn("BR-IC-02", fired(r))

    # -- -11: actual delivery date OR invoicing period ------------------------
    def test_br_ic_11_missing_delivery_date_and_period_fires(self):
        r = self.cat_base()
        d = doc_delivery(r)
        d.remove(child(d, NS_CBC, "ActualDeliveryDate"))
        for p in r.findall(q(NS_CAC, "InvoicePeriod")):
            r.remove(p)
        self.assertIn("BR-IC-11", fired(r))
        self.assertNotIn("BR-IC-11", fired(self.cat_base()))  # date present

    def test_br_ic_11_invoice_period_satisfies(self):
        # No actual delivery date, but a document-level invoicing period with a
        # child element still satisfies the rule.
        r = self.cat_base()
        d = doc_delivery(r)
        d.remove(child(d, NS_CBC, "ActualDeliveryDate"))
        self.assertIsNotNone(child(r, NS_CAC, "InvoicePeriod"))
        self.assertNotIn("BR-IC-11", fired(r))

    def test_br_ic_11_single_char_date_still_fires(self):
        # string-length(...) > 1: a 1-character date does not satisfy the rule.
        r = self.cat_base()
        child(doc_delivery(r), NS_CBC, "ActualDeliveryDate").text = "x"
        for p in r.findall(q(NS_CAC, "InvoicePeriod")):
            r.remove(p)
        self.assertIn("BR-IC-11", fired(r))

    # -- -12: deliver-to country code -----------------------------------------
    def test_br_ic_12_missing_delivery_country_fires(self):
        r = self.cat_base()
        loc = child(doc_delivery(r), NS_CAC, "DeliveryLocation")
        addr = child(loc, NS_CAC, "Address")
        addr.remove(child(addr, NS_CAC, "Country"))
        self.assertIn("BR-IC-12", fired(r))
        self.assertNotIn("BR-IC-12", fired(self.cat_base()))  # DK present

    def test_br_ic_12_single_char_country_fires(self):
        r = self.cat_base()
        cc = doc_delivery(r).find(
            "%s/%s/%s/%s" % (q(NS_CAC, "DeliveryLocation"), q(NS_CAC, "Address"),
                             q(NS_CAC, "Country"), q(NS_CBC, "IdentificationCode")))
        cc.text = "D"
        self.assertIn("BR-IC-12", fired(r))


class ExportOutsideEuBatch(_VatCategoryBatch, unittest.TestCase):
    """BR-G-02..10 — Export outside the EU (G) VAT category rules.

    Structurally the Exempt (E) family, so it inherits the shared seller-id
    (-02..04), rate-0 (-05..07) and breakdown (-08/-09) cases. The one twist
    the differential surfaced: like BR-IC (and unlike BR-Z/BR-E) the -02..04
    seller disjunct is VAT-scheme scoped — the inherited
    ``test_02_scheme_less_line_category_does_not_fire`` covers that. BR-G-10
    requires an exemption reason (mirror of BR-E-10)."""

    code = "G"
    fam = "G"

    def cat_base(self):
        return export_base()

    def test_br_g_10_missing_exemption_reason_fires(self):
        r = base()
        convert_category(r, "G", exemption_reason=None)
        self.assertIn("BR-G-10", fired(r))
        self.assertNotIn("BR-G-10", fired(self.cat_base()))  # reason present

    def test_br_g_10_reason_code_alone_satisfies(self):
        r = base()
        convert_category(r, "G", exemption_reason=None)
        cat = subtotal_category(r)
        code_el = ET.Element(q(NS_CBC, "TaxExemptionReasonCode"))
        code_el.text = "VATEX-EU-G"
        cat.insert(list(cat).index(cat.find(q(NS_CAC, "TaxScheme"))), code_el)
        self.assertNotIn("BR-G-10", fired(r))


def add_seller_vat_party_tax_scheme(root, company_id="DE123456789"):
    """Append a VAT-scheme Seller PartyTaxScheme/CompanyID (BT-31)."""
    party = supplier_party(root)
    pts = ET.SubElement(party, q(NS_CAC, "PartyTaxScheme"))
    ET.SubElement(pts, q(NS_CBC, "CompanyID")).text = company_id
    ET.SubElement(ET.SubElement(pts, q(NS_CAC, "TaxScheme")),
                  q(NS_CBC, "ID")).text = "VAT"


def add_buyer_vat_party_tax_scheme(root, company_id="DE987654321"):
    """Append a VAT-scheme Buyer PartyTaxScheme/CompanyID (BT-48)."""
    party = buyer_party(root)
    pts = ET.SubElement(party, q(NS_CAC, "PartyTaxScheme"))
    ET.SubElement(pts, q(NS_CBC, "CompanyID")).text = company_id
    ET.SubElement(ET.SubElement(pts, q(NS_CAC, "TaxScheme")),
                  q(NS_CBC, "ID")).text = "VAT"


class NotSubjectToVatBatch(unittest.TestCase):
    """BR-O-02..14 — Not subject to VAT (O) VAT category rules.

    The odd family: -02..04 are PROHIBITIONS (no VAT id may be present),
    -05..07 forbid the VAT rate element outright (``not(cbc:Percent)``), and
    -11..14 forbid mixing any other VAT category once an O breakdown exists."""

    def o_base(self):
        return not_subject_base()

    def test_clean_o_base_fires_nothing(self):
        self.assertEqual(fired(self.o_base()), set())

    # -- -02..04: NO Seller / tax-rep / Buyer VAT identifier ------------------
    def test_br_o_02_seller_vat_id_fires(self):
        r = self.o_base()
        add_seller_vat_party_tax_scheme(r)
        self.assertIn("BR-O-02", fired(r))
        self.assertNotIn("BR-O-02", fired(self.o_base()))

    def test_br_o_02_buyer_vat_id_fires(self):
        r = self.o_base()
        add_buyer_vat_party_tax_scheme(r)
        self.assertIn("BR-O-02", fired(r))

    def test_br_o_02_tax_representative_vat_id_fires(self):
        r = self.o_base()
        trp = ET.Element(q(NS_CAC, "TaxRepresentativeParty"))
        pts = ET.SubElement(trp, q(NS_CAC, "PartyTaxScheme"))
        ET.SubElement(pts, q(NS_CBC, "CompanyID")).text = "DE999999999"
        ET.SubElement(ET.SubElement(pts, q(NS_CAC, "TaxScheme")),
                      q(NS_CBC, "ID")).text = "VAT"
        r.insert(0, trp)
        self.assertIn("BR-O-02", fired(r))

    def test_br_o_03_allowance_with_vat_id_fires(self):
        r = self.o_base()
        ac = add_doc_allowance_charge(r, charge=False, percent="0", category="O")
        ac.find(q(NS_CAC, "TaxCategory")).remove(
            child(ac.find(q(NS_CAC, "TaxCategory")), NS_CBC, "Percent"))
        add_seller_vat_party_tax_scheme(r)
        self.assertIn("BR-O-03", fired(r))
        # Same O allowance but NO VAT id anywhere -> holds.
        r2 = self.o_base()
        ac2 = add_doc_allowance_charge(r2, charge=False, percent="0",
                                       category="O")
        ac2.find(q(NS_CAC, "TaxCategory")).remove(
            child(ac2.find(q(NS_CAC, "TaxCategory")), NS_CBC, "Percent"))
        self.assertNotIn("BR-O-03", fired(r2))

    def test_br_o_04_charge_with_vat_id_fires(self):
        r = self.o_base()
        ac = add_doc_allowance_charge(r, charge=True, percent="0", category="O")
        ac.find(q(NS_CAC, "TaxCategory")).remove(
            child(ac.find(q(NS_CAC, "TaxCategory")), NS_CBC, "Percent"))
        add_seller_vat_party_tax_scheme(r)
        self.assertIn("BR-O-04", fired(r))

    # -- -05..07: NO VAT rate element ----------------------------------------
    def test_br_o_05_line_percent_fires(self):
        # A Percent ELEMENT present (even value 0) fires: not(cbc:Percent).
        r = self.o_base()
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        ET.SubElement(ctc, q(NS_CBC, "Percent")).text = "0"
        self.assertIn("BR-O-05", fired(r))
        self.assertNotIn("BR-O-05", fired(self.o_base()))

    def test_br_o_06_allowance_percent_fires(self):
        r = self.o_base()
        add_doc_allowance_charge(r, charge=False, percent="0", category="O")
        self.assertIn("BR-O-06", fired(r))
        # Same O allowance without a Percent element -> holds.
        r2 = self.o_base()
        ac = add_doc_allowance_charge(r2, charge=False, percent="0",
                                      category="O")
        cat = ac.find(q(NS_CAC, "TaxCategory"))
        cat.remove(child(cat, NS_CBC, "Percent"))
        self.assertNotIn("BR-O-06", fired(r2))

    def test_br_o_07_charge_percent_fires(self):
        r = self.o_base()
        add_doc_allowance_charge(r, charge=True, percent="0", category="O")
        self.assertIn("BR-O-07", fired(r))
        r2 = self.o_base()
        ac = add_doc_allowance_charge(r2, charge=True, percent="0",
                                      category="O")
        cat = ac.find(q(NS_CAC, "TaxCategory"))
        cat.remove(child(cat, NS_CBC, "Percent"))
        self.assertNotIn("BR-O-07", fired(r2))

    # -- -08/-09: breakdown taxable sum + tax = 0 ----------------------------
    def test_br_o_08_taxable_amount_mismatch_fires(self):
        r = self.o_base()
        child(subtotal(r), NS_CBC, "TaxableAmount").text = "111111.11"
        self.assertIn("BR-O-08", fired(r))
        self.assertNotIn("BR-O-08", fired(self.o_base()))

    def test_br_o_09_nonzero_tax_amount_fires(self):
        r = self.o_base()
        child(subtotal(r), NS_CBC, "TaxAmount").text = "10.00"
        self.assertIn("BR-O-09", fired(r))
        self.assertNotIn("BR-O-09", fired(self.o_base()))

    # -- -10: exemption reason required --------------------------------------
    def test_br_o_10_missing_exemption_reason_fires(self):
        r = self.o_base()
        cat = subtotal_category(r)
        reason = cat.find(q(NS_CBC, "TaxExemptionReason"))
        if reason is not None:
            cat.remove(reason)
        self.assertIn("BR-O-10", fired(r))
        self.assertNotIn("BR-O-10", fired(self.o_base()))

    def test_br_o_10_reason_code_alone_satisfies(self):
        r = self.o_base()
        cat = subtotal_category(r)
        cat.remove(child(cat, NS_CBC, "TaxExemptionReason"))
        code_el = ET.Element(q(NS_CBC, "TaxExemptionReasonCode"))
        code_el.text = "VATEX-EU-O"
        cat.insert(list(cat).index(cat.find(q(NS_CAC, "TaxScheme"))), code_el)
        self.assertNotIn("BR-O-10", fired(r))

    # -- -11..14: no OTHER VAT category once an O breakdown exists ------------
    def test_br_o_11_other_breakdown_fires(self):
        r = self.o_base()
        tt = child(r, NS_CAC, "TaxTotal")
        st2 = copy.deepcopy(tt.find(q(NS_CAC, "TaxSubtotal")))
        child(st2.find(q(NS_CAC, "TaxCategory")), NS_CBC, "ID").text = "S"
        tt.append(st2)
        self.assertIn("BR-O-11", fired(r))
        self.assertNotIn("BR-O-11", fired(self.o_base()))

    def test_br_o_12_non_o_line_category_fires(self):
        r = self.o_base()
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        child(ctc, NS_CBC, "ID").text = "S"
        self.assertIn("BR-O-12", fired(r))
        self.assertNotIn("BR-O-12", fired(self.o_base()))

    def test_br_o_13_non_o_allowance_fires(self):
        r = self.o_base()
        add_doc_allowance_charge(r, charge=False, percent="25", category="S")
        self.assertIn("BR-O-13", fired(r))
        self.assertNotIn("BR-O-13", fired(self.o_base()))

    def test_br_o_14_non_o_charge_fires(self):
        r = self.o_base()
        add_doc_allowance_charge(r, charge=True, percent="25", category="S")
        self.assertIn("BR-O-14", fired(r))
        self.assertNotIn("BR-O-14", fired(self.o_base()))


class RulesetShape(unittest.TestCase):
    def test_all_new_rules_registered(self):
        from einvoice import rules
        ids = {"-".join(p.upper() for p in fn.__name__.split("_"))
               for fn in rules.ALL_RULES}
        for rid in (NEW_RULES | LINE_RULES | PAYMENT_RULES | ZE_RULES
                    | AEIC_RULES | GO_RULES):
            self.assertIn(rid, ids, rid)
        # No duplicate rule ids in the ruleset.
        all_ids = ["-".join(p.upper() for p in fn.__name__.split("_"))
                   for fn in rules.ALL_RULES]
        self.assertEqual(len(all_ids), len(set(all_ids)))


if __name__ == "__main__":
    unittest.main(verbosity=2)

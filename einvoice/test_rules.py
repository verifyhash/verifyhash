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

# Document-level calculation / rounding batch (differentially proven the same
# way). BR-CO-11/12 are the newly-added members; the others are exercised via
# the differential corpus + mutations rather than unit tests here.
CALC_RULES = {
    "BR-CO-11", "BR-CO-12",
}

# Core/decimals/VAT gap batch A (differentially proven the same way).
GAP_A_RULES = {
    "BR-CO-20", "BR-CO-21", "BR-CO-22", "BR-CO-23", "BR-CO-24", "BR-CO-26",
    "BR-DEC-24", "BR-DEC-25", "BR-DEC-27", "BR-DEC-28",
    "BR-IC-10", "BR-S-08",
}

# Canary Islands IGIC (L) VAT category batch B (differentially proven the
# same way; BR-AF-09 is UBL-proven only — the official CII artifact ships it
# as a tautology).
AF_RULES = {
    "BR-AF-01", "BR-AF-02", "BR-AF-03", "BR-AF-04", "BR-AF-05", "BR-AF-06",
    "BR-AF-07", "BR-AF-08", "BR-AF-09", "BR-AF-10",
}

# Ceuta/Melilla IPSI (M) VAT category batch C (differentially proven the
# same way; BR-AG-08/09 are UBL-proven only — the official CII artifact
# ships both as asserts that can never fire) plus the Italian split-payment
# pair (both bindings fully graded).
AG_B_RULES = {
    "BR-AG-01", "BR-AG-02", "BR-AG-03", "BR-AG-04", "BR-AG-05", "BR-AG-06",
    "BR-AG-07", "BR-AG-08", "BR-AG-09", "BR-AG-10",
    "BR-B-01", "BR-B-02",
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


def set_lmt_amount(root, local, value):
    """Set (or create) a ``cac:LegalMonetaryTotal/cbc:<local>`` monetary child."""
    lmt = child(root, NS_CAC, "LegalMonetaryTotal")
    el = child(lmt, NS_CBC, local)
    if el is None:
        el = ET.SubElement(lmt, q(NS_CBC, local))
        el.set("currencyID", "DKK")
    el.text = value
    return el


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
    # K mirrors AE/E/G: the breakdown REQUIRES an exemption reason (BR-IC-10).
    r = base()
    convert_category(r, "K", exemption_reason="Intra-community supply")
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


def igic_base():
    """A clean IGIC (L) invoice: the S-25% base with the line + breakdown
    category codes flipped to L. The 25% rate, amounts and seller VAT id stay,
    so nothing fires — 25 satisfies the UBL ``(cbc:Percent) >= 0`` rate test
    and the breakdown arithmetic already reconciles."""
    r = base()
    ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
    child(ctc, NS_CBC, "ID").text = "L"
    child(subtotal_category(r), NS_CBC, "ID").text = "L"
    return r


class IgicBatch(unittest.TestCase):
    """BR-AF-01..10 — Canary Islands IGIC (L) VAT category rules (UBL
    semantics: the rate rules accept >= 0, the -08 sum is a strict ±1 band
    gated on any invoice line existing, -09 is the BR-S-09 band)."""

    def test_clean_igic_base_fires_nothing(self):
        self.assertEqual(fired(igic_base()), set())

    # -- BR-AF-01: items <-> breakdown agreement (bidirectional) --------------
    def test_01_l_line_without_l_breakdown_fires(self):
        r = base()
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        child(ctc, NS_CBC, "ID").text = "L"      # breakdown stays 'S'
        self.assertIn("BR-AF-01", fired(r))
        self.assertNotIn("BR-AF-01", fired(igic_base()))

    def test_01_orphan_l_breakdown_fires(self):
        r = base()                                # line stays 'S'
        child(subtotal_category(r), NS_CBC, "ID").text = "L"
        self.assertIn("BR-AF-01", fired(r))

    def test_01_l_allowance_without_l_breakdown_fires(self):
        r = base()
        add_doc_allowance_charge(r, charge=False, percent="25", category="L",
                                 amount="0.00")
        self.assertIn("BR-AF-01", fired(r))

    # -- BR-AF-02..04: seller VAT identifier ----------------------------------
    def test_02_line_without_seller_vat_id_fires(self):
        r = igic_base()
        remove_seller_party_tax_scheme(r)
        self.assertIn("BR-AF-02", fired(r))
        self.assertNotIn("BR-AF-02", fired(igic_base()))

    def test_02_tax_representative_satisfies(self):
        r = igic_base()
        remove_seller_party_tax_scheme(r)
        trp = ET.Element(q(NS_CAC, "TaxRepresentativeParty"))
        pts = ET.SubElement(trp, q(NS_CAC, "PartyTaxScheme"))
        ET.SubElement(pts, q(NS_CBC, "CompanyID")).text = "ES999999999"
        ET.SubElement(ET.SubElement(pts, q(NS_CAC, "TaxScheme")),
                      q(NS_CBC, "ID")).text = "VAT"
        r.insert(0, trp)
        self.assertNotIn("BR-AF-02", fired(r))

    def test_02_scheme_less_line_category_does_not_fire(self):
        # Both disjuncts of the official BR-AF-02 test are VAT-scheme scoped
        # (unlike BR-S-02): an L ClassifiedTaxCategory with NO TaxScheme
        # matches neither node set, so the rule holds even without a seller id.
        r = igic_base()
        remove_seller_party_tax_scheme(r)
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        ctc.remove(ctc.find(q(NS_CAC, "TaxScheme")))
        self.assertNotIn("BR-AF-02", fired(r))

    def test_03_allowance_without_seller_vat_id_fires(self):
        r = igic_base()
        add_doc_allowance_charge(r, charge=False, percent="25", category="L",
                                 amount="0.00")
        remove_seller_party_tax_scheme(r)
        self.assertIn("BR-AF-03", fired(r))
        r2 = igic_base()
        add_doc_allowance_charge(r2, charge=False, percent="25", category="L",
                                 amount="0.00")
        self.assertNotIn("BR-AF-03", fired(r2))

    def test_04_charge_without_seller_vat_id_fires(self):
        r = igic_base()
        add_doc_allowance_charge(r, charge=True, percent="25", category="L",
                                 amount="0.00")
        remove_seller_party_tax_scheme(r)
        self.assertIn("BR-AF-04", fired(r))
        r2 = igic_base()
        add_doc_allowance_charge(r2, charge=True, percent="25", category="L",
                                 amount="0.00")
        self.assertNotIn("BR-AF-04", fired(r2))

    # -- BR-AF-05..07: VAT rate must be >= 0 (zero IS allowed on UBL) ----------
    def test_05_negative_rate_line_fires(self):
        r = igic_base()
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        child(ctc, NS_CBC, "Percent").text = "-5"
        self.assertIn("BR-AF-05", fired(r))

    def test_05_zero_rate_holds_on_ubl(self):
        # (cbc:Percent) >= 0 — the UBL binding accepts a 0% IGIC rate
        # (the CII binding does not; see test_rules_cii.py).
        r = igic_base()
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        child(ctc, NS_CBC, "Percent").text = "0"
        self.assertNotIn("BR-AF-05", fired(r))

    def test_05_missing_rate_fires(self):
        # () >= 0 is FALSE — an absent Percent fires.
        r = igic_base()
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        ctc.remove(child(ctc, NS_CBC, "Percent"))
        self.assertIn("BR-AF-05", fired(r))

    def test_06_negative_rate_allowance_fires(self):
        r = igic_base()
        add_doc_allowance_charge(r, charge=False, percent="-5", category="L",
                                 amount="0.00")
        self.assertIn("BR-AF-06", fired(r))
        r2 = igic_base()
        add_doc_allowance_charge(r2, charge=False, percent="0", category="L",
                                 amount="0.00")
        self.assertNotIn("BR-AF-06", fired(r2))  # zero rate holds on UBL

    def test_07_negative_rate_charge_fires(self):
        r = igic_base()
        add_doc_allowance_charge(r, charge=True, percent="-5", category="L",
                                 amount="0.00")
        self.assertIn("BR-AF-07", fired(r))
        r2 = igic_base()
        add_doc_allowance_charge(r2, charge=True, percent="0", category="L",
                                 amount="0.00")
        self.assertNotIn("BR-AF-07", fired(r2))

    # -- BR-AF-08: per-rate bucket sum, strict ±1 band -------------------------
    def test_08_taxable_outside_band_fires(self):
        r = igic_base()
        child(subtotal(r), NS_CBC, "TaxableAmount").text = "625745.54"  # +2
        self.assertIn("BR-AF-08", fired(r))
        self.assertNotIn("BR-AF-08", fired(igic_base()))

    def test_08_inside_band_holds(self):
        # The band is strict ±1 around the bucket sum: +0.50 holds.
        r = igic_base()
        child(subtotal(r), NS_CBC, "TaxableAmount").text = "625744.04"
        self.assertNotIn("BR-AF-08", fired(r))

    def test_08_allowance_enters_the_sum(self):
        r = igic_base()
        add_doc_allowance_charge(r, charge=False, percent="25", category="L",
                                 amount="10.00")
        child(subtotal(r), NS_CBC, "TaxableAmount").text = "625733.54"
        self.assertNotIn("BR-AF-08", fired(r))

    def test_08_no_invoice_line_fires(self):
        # The official band is gated on exists(//cac:InvoiceLine): an L
        # breakdown with a rate on a line-less document fires.
        r = igic_base()
        for ln in r.findall(q(NS_CAC, "InvoiceLine")):
            r.remove(ln)
        self.assertIn("BR-AF-08", fired(r))

    def test_08_missing_rate_is_vacuous(self):
        # every $rate in () — an L breakdown without a Percent never fires
        # BR-AF-08 (BR-48 guards the missing rate instead).
        r = igic_base()
        cat = subtotal_category(r)
        cat.remove(child(cat, NS_CBC, "Percent"))
        f = fired(r)
        self.assertNotIn("BR-AF-08", f)
        self.assertIn("BR-48", f)

    # -- BR-AF-09: breakdown tax = taxable x rate (±1 band) --------------------
    def test_09_tax_far_from_taxable_times_rate_fires(self):
        r = igic_base()
        child(subtotal(r), NS_CBC, "TaxAmount").text = "99.99"
        self.assertIn("BR-AF-09", fired(r))
        self.assertNotIn("BR-AF-09", fired(igic_base()))

    def test_09_inside_band_holds(self):
        r = igic_base()
        child(subtotal(r), NS_CBC, "TaxAmount").text = "156436.39"  # +0.50
        self.assertNotIn("BR-AF-09", fired(r))

    # -- BR-AF-10: exemption reason forbidden ----------------------------------
    def test_10_exemption_reason_fires(self):
        r = igic_base()
        ET.SubElement(subtotal_category(r),
                      q(NS_CBC, "TaxExemptionReason")).text = "n/a"
        self.assertIn("BR-AF-10", fired(r))
        self.assertNotIn("BR-AF-10", fired(igic_base()))

    def test_10_exemption_reason_code_fires(self):
        r = igic_base()
        ET.SubElement(subtotal_category(r),
                      q(NS_CBC, "TaxExemptionReasonCode")).text = "VATEX-EU-O"
        self.assertIn("BR-AF-10", fired(r))


def ipsi_base():
    """A clean IPSI (M) invoice: the S-25% base with the line + breakdown
    category codes flipped to M. The 25% rate, amounts and seller VAT id stay,
    so nothing fires — 25 satisfies the ``>= 0`` rate test of BOTH bindings
    and the breakdown arithmetic already reconciles."""
    r = base()
    ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
    child(ctc, NS_CBC, "ID").text = "M"
    child(subtotal_category(r), NS_CBC, "ID").text = "M"
    return r


class IpsiBatch(unittest.TestCase):
    """BR-AG-01..10 — Ceuta/Melilla IPSI (M) VAT category rules (UBL
    semantics: the rate rules accept >= 0 on BOTH bindings, the -08 sum is a
    strict ±1 band gated on any invoice line existing, -09 is the BR-S-09
    band, and -01's first disjunct counts the RAW ``cbc:ID='M'`` VAT-scoped
    breakdown node set)."""

    def test_clean_ipsi_base_fires_nothing(self):
        self.assertEqual(fired(ipsi_base()), set())

    # -- BR-AG-01: items <-> breakdown agreement (bidirectional) --------------
    def test_01_m_line_without_m_breakdown_fires(self):
        r = base()
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        child(ctc, NS_CBC, "ID").text = "M"      # breakdown stays 'S'
        self.assertIn("BR-AG-01", fired(r))
        self.assertNotIn("BR-AG-01", fired(ipsi_base()))

    def test_01_orphan_m_breakdown_fires(self):
        r = base()                                # line stays 'S'
        child(subtotal_category(r), NS_CBC, "ID").text = "M"
        self.assertIn("BR-AG-01", fired(r))

    def test_01_m_allowance_without_m_breakdown_fires(self):
        r = base()
        add_doc_allowance_charge(r, charge=False, percent="25", category="M",
                                 amount="0.00")
        self.assertIn("BR-AG-01", fired(r))

    def test_01_padded_breakdown_id_does_not_satisfy_the_item_side(self):
        # The official FIRST disjunct counts the RAW cbc:ID = 'M' breakdown
        # node set (no normalize-space): a whitespace-padded ' M ' breakdown
        # row does NOT satisfy an M item, so the rule still fires — while the
        # normalize-space'd ORPHAN direction does not see an orphan either.
        r = ipsi_base()
        child(subtotal_category(r), NS_CBC, "ID").text = " M "
        self.assertIn("BR-AG-01", fired(r))

    # -- BR-AG-02..04: seller VAT identifier ----------------------------------
    def test_02_line_without_seller_vat_id_fires(self):
        r = ipsi_base()
        remove_seller_party_tax_scheme(r)
        self.assertIn("BR-AG-02", fired(r))
        self.assertNotIn("BR-AG-02", fired(ipsi_base()))

    def test_02_tax_representative_satisfies(self):
        r = ipsi_base()
        remove_seller_party_tax_scheme(r)
        trp = ET.Element(q(NS_CAC, "TaxRepresentativeParty"))
        pts = ET.SubElement(trp, q(NS_CAC, "PartyTaxScheme"))
        ET.SubElement(pts, q(NS_CBC, "CompanyID")).text = "ES999999999"
        ET.SubElement(ET.SubElement(pts, q(NS_CAC, "TaxScheme")),
                      q(NS_CBC, "ID")).text = "VAT"
        r.insert(0, trp)
        self.assertNotIn("BR-AG-02", fired(r))

    def test_02_scheme_less_line_category_does_not_fire(self):
        # Both disjuncts of the official BR-AG-02 test are VAT-scheme scoped
        # (the BR-Z/E/AF-02 symmetric shape): an M ClassifiedTaxCategory with
        # NO TaxScheme matches neither node set, so the rule holds even
        # without a seller id.
        r = ipsi_base()
        remove_seller_party_tax_scheme(r)
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        ctc.remove(ctc.find(q(NS_CAC, "TaxScheme")))
        self.assertNotIn("BR-AG-02", fired(r))

    def test_03_allowance_without_seller_vat_id_fires(self):
        r = ipsi_base()
        add_doc_allowance_charge(r, charge=False, percent="25", category="M",
                                 amount="0.00")
        remove_seller_party_tax_scheme(r)
        self.assertIn("BR-AG-03", fired(r))
        r2 = ipsi_base()
        add_doc_allowance_charge(r2, charge=False, percent="25", category="M",
                                 amount="0.00")
        self.assertNotIn("BR-AG-03", fired(r2))

    def test_04_charge_without_seller_vat_id_fires(self):
        r = ipsi_base()
        add_doc_allowance_charge(r, charge=True, percent="25", category="M",
                                 amount="0.00")
        remove_seller_party_tax_scheme(r)
        self.assertIn("BR-AG-04", fired(r))
        r2 = ipsi_base()
        add_doc_allowance_charge(r2, charge=True, percent="25", category="M",
                                 amount="0.00")
        self.assertNotIn("BR-AG-04", fired(r2))

    # -- BR-AG-05..07: VAT rate must be >= 0 (zero allowed on BOTH bindings) --
    def test_05_negative_rate_line_fires(self):
        r = ipsi_base()
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        child(ctc, NS_CBC, "Percent").text = "-5"
        self.assertIn("BR-AG-05", fired(r))

    def test_05_zero_rate_holds(self):
        # (cbc:Percent) >= 0 — a 0% IPSI rate is valid (and unlike BR-AF-05,
        # the CII binding agrees; see test_rules_cii.py).
        r = ipsi_base()
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        child(ctc, NS_CBC, "Percent").text = "0"
        self.assertNotIn("BR-AG-05", fired(r))

    def test_05_missing_rate_fires(self):
        # () >= 0 is FALSE — an absent Percent fires.
        r = ipsi_base()
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        ctc.remove(child(ctc, NS_CBC, "Percent"))
        self.assertIn("BR-AG-05", fired(r))

    def test_06_negative_rate_allowance_fires(self):
        r = ipsi_base()
        add_doc_allowance_charge(r, charge=False, percent="-5", category="M",
                                 amount="0.00")
        self.assertIn("BR-AG-06", fired(r))
        r2 = ipsi_base()
        add_doc_allowance_charge(r2, charge=False, percent="0", category="M",
                                 amount="0.00")
        self.assertNotIn("BR-AG-06", fired(r2))  # zero rate holds

    def test_07_negative_rate_charge_fires(self):
        r = ipsi_base()
        add_doc_allowance_charge(r, charge=True, percent="-5", category="M",
                                 amount="0.00")
        self.assertIn("BR-AG-07", fired(r))
        r2 = ipsi_base()
        add_doc_allowance_charge(r2, charge=True, percent="0", category="M",
                                 amount="0.00")
        self.assertNotIn("BR-AG-07", fired(r2))

    # -- BR-AG-08: per-rate bucket sum, strict ±1 band -------------------------
    def test_08_taxable_outside_band_fires(self):
        r = ipsi_base()
        child(subtotal(r), NS_CBC, "TaxableAmount").text = "625745.54"  # +2
        self.assertIn("BR-AG-08", fired(r))
        self.assertNotIn("BR-AG-08", fired(ipsi_base()))

    def test_08_inside_band_holds(self):
        # The band is strict ±1 around the bucket sum: +0.50 holds.
        r = ipsi_base()
        child(subtotal(r), NS_CBC, "TaxableAmount").text = "625744.04"
        self.assertNotIn("BR-AG-08", fired(r))

    def test_08_charge_enters_the_sum(self):
        r = ipsi_base()
        add_doc_allowance_charge(r, charge=True, percent="25", category="M",
                                 amount="10.00")
        child(subtotal(r), NS_CBC, "TaxableAmount").text = "625753.54"
        self.assertNotIn("BR-AG-08", fired(r))

    def test_08_no_invoice_line_fires(self):
        # The official band is gated on exists(//cac:InvoiceLine): an M
        # breakdown with a rate on a line-less document fires.
        r = ipsi_base()
        for ln in r.findall(q(NS_CAC, "InvoiceLine")):
            r.remove(ln)
        self.assertIn("BR-AG-08", fired(r))

    def test_08_missing_rate_is_vacuous(self):
        # every $rate in () — an M breakdown without a Percent never fires
        # BR-AG-08 (BR-48 guards the missing rate instead).
        r = ipsi_base()
        cat = subtotal_category(r)
        cat.remove(child(cat, NS_CBC, "Percent"))
        f = fired(r)
        self.assertNotIn("BR-AG-08", f)
        self.assertIn("BR-48", f)

    # -- BR-AG-09: breakdown tax = taxable x rate (±1 band) --------------------
    def test_09_tax_far_from_taxable_times_rate_fires(self):
        r = ipsi_base()
        child(subtotal(r), NS_CBC, "TaxAmount").text = "99.99"
        self.assertIn("BR-AG-09", fired(r))
        self.assertNotIn("BR-AG-09", fired(ipsi_base()))

    def test_09_inside_band_holds(self):
        r = ipsi_base()
        child(subtotal(r), NS_CBC, "TaxAmount").text = "156436.39"  # +0.50
        self.assertNotIn("BR-AG-09", fired(r))

    # -- BR-AG-10: exemption reason forbidden ----------------------------------
    def test_10_exemption_reason_fires(self):
        r = ipsi_base()
        ET.SubElement(subtotal_category(r),
                      q(NS_CBC, "TaxExemptionReason")).text = "n/a"
        self.assertIn("BR-AG-10", fired(r))
        self.assertNotIn("BR-AG-10", fired(ipsi_base()))

    def test_10_exemption_reason_code_fires(self):
        r = ipsi_base()
        ET.SubElement(subtotal_category(r),
                      q(NS_CBC, "TaxExemptionReasonCode")).text = "VATEX-EU-O"
        self.assertIn("BR-AG-10", fired(r))


def set_all_country_codes(root, code):
    """Set every cbc:IdentificationCode in the document (the BR-B-01 node
    set: postal Country AND item OriginCountry codes) to ``code``."""
    for el in root.iter(q(NS_CBC, "IdentificationCode")):
        el.text = code


def split_payment_base():
    """A clean split-payment invoice: the S-25% base with line + breakdown
    categories flipped to B and every country code set to IT (the base is
    Danish; BR-B-01 requires a domestic Italian document)."""
    r = base()
    ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
    child(ctc, NS_CBC, "ID").text = "B"
    child(subtotal_category(r), NS_CBC, "ID").text = "B"
    set_all_country_codes(r, "IT")
    return r


class SplitPaymentBatch(unittest.TestCase):
    """BR-B-01/BR-B-02 — Italian split payment (B). Both official tests are
    RAW general comparisons: no normalize-space, no TaxScheme scoping."""

    def test_clean_split_payment_base_fires_nothing(self):
        self.assertEqual(fired(split_payment_base()), set())

    # -- BR-B-01: split payment must be domestic Italian -----------------------
    def test_01_non_italian_country_fires(self):
        r = base()
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        child(ctc, NS_CBC, "ID").text = "B"
        child(subtotal_category(r), NS_CBC, "ID").text = "B"
        # countries stay DK -> not a domestic Italian invoice
        self.assertIn("BR-B-01", fired(r))

    def test_01_single_foreign_code_among_it_fires(self):
        r = split_payment_base()
        next(iter(r.iter(q(NS_CBC, "IdentificationCode")))).text = "FR"
        self.assertIn("BR-B-01", fired(r))

    def test_01_breakdown_only_b_also_counts(self):
        # BR-B-01's presence set is //cac:TaxCategory | //cac:Classified-
        # TaxCategory — a B breakdown row alone (line stays S) triggers the
        # domestic-Italian requirement.
        r = base()                                # countries DK
        child(subtotal_category(r), NS_CBC, "ID").text = "B"
        self.assertIn("BR-B-01", fired(r))

    def test_01_no_b_category_holds_whatever_the_country(self):
        self.assertNotIn("BR-B-01", fired(base()))

    def test_01_padded_b_does_not_count(self):
        # RAW comparison: ' B ' != 'B', so a padded category id is NOT a
        # split-payment code and the rule holds (no normalize-space in the
        # official test).
        r = base()
        child(subtotal_category(r), NS_CBC, "ID").text = " B "
        self.assertNotIn("BR-B-01", fired(r))

    # -- BR-B-02: B and S must not coexist --------------------------------------
    def test_02_b_line_with_s_breakdown_fires(self):
        r = base()
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        child(ctc, NS_CBC, "ID").text = "B"      # breakdown stays 'S'
        set_all_country_codes(r, "IT")           # keep BR-B-01 out of the way
        f = fired(r)
        self.assertIn("BR-B-02", f)
        self.assertNotIn("BR-B-01", f)

    def test_02_s_allowance_alongside_b_fires(self):
        r = split_payment_base()
        add_doc_allowance_charge(r, charge=True, percent="25", category="S",
                                 amount="0.00")
        self.assertIn("BR-B-02", fired(r))

    def test_02_all_b_holds(self):
        self.assertNotIn("BR-B-02", fired(split_payment_base()))

    def test_02_scheme_agnostic(self):
        # The official node sets carry NO TaxScheme predicate: a B breakdown
        # category whose TaxScheme is not VAT still collides with S.
        r = base()
        child(subtotal_category(r), NS_CBC, "ID").text = "B"
        cat = subtotal_category(r)
        cat.find("%s/%s" % (q(NS_CAC, "TaxScheme"),
                            q(NS_CBC, "ID"))).text = "GST"
        set_all_country_codes(r, "IT")
        self.assertIn("BR-B-02", fired(r))


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


class DocumentLevelCalculationBatch(unittest.TestCase):
    """BR-CO-11 / BR-CO-12 — document-level allowance/charge total reconciliation.

    The invariant: the stated total (BT-107 / BT-108) must equal round2(Σ of the
    document-level allowance / charge amounts BT-92 / BT-99); a total with no
    matching allowances/charges must be 0, and stated-but-unbacked or
    unstated-but-present both fire. The clean base has neither a stated total nor
    any document allowance/charge, so both rules hold vacuously on it.
    """

    def test_clean_base_holds(self):
        got = fired(base())
        self.assertNotIn("BR-CO-11", got)
        self.assertNotIn("BR-CO-12", got)

    # --- BR-CO-11 (allowances) --------------------------------------------- #
    def test_br_co_11_stated_total_without_allowances_fires(self):
        # BT-107 stated (12.34) but Σ BT-92 = 0 -> fires.
        r = base()
        set_lmt_amount(r, "AllowanceTotalAmount", "12.34")
        self.assertIn("BR-CO-11", fired(r))

    def test_br_co_11_reconciled_total_holds(self):
        # One document allowance of 10.00 with a matching stated total -> holds.
        r = base()
        add_doc_allowance_charge(r, charge=False, amount="10.00")
        set_lmt_amount(r, "AllowanceTotalAmount", "10.00")
        self.assertNotIn("BR-CO-11", fired(r))

    def test_br_co_11_wrong_total_fires(self):
        # Allowance of 10.00 but the stated total says 7.50 -> fires.
        r = base()
        add_doc_allowance_charge(r, charge=False, amount="10.00")
        set_lmt_amount(r, "AllowanceTotalAmount", "7.50")
        self.assertIn("BR-CO-11", fired(r))

    def test_br_co_11_allowance_without_stated_total_fires(self):
        # Document allowance present but BT-107 absent -> fires.
        r = base()
        add_doc_allowance_charge(r, charge=False, amount="10.00")
        self.assertIn("BR-CO-11", fired(r))

    # --- BR-CO-12 (charges) ------------------------------------------------ #
    def test_br_co_12_stated_total_without_charges_fires(self):
        r = base()
        set_lmt_amount(r, "ChargeTotalAmount", "12.34")
        self.assertIn("BR-CO-12", fired(r))

    def test_br_co_12_reconciled_total_holds(self):
        r = base()
        add_doc_allowance_charge(r, charge=True, amount="10.00")
        set_lmt_amount(r, "ChargeTotalAmount", "10.00")
        self.assertNotIn("BR-CO-12", fired(r))

    def test_br_co_12_wrong_total_fires(self):
        r = base()
        add_doc_allowance_charge(r, charge=True, amount="10.00")
        set_lmt_amount(r, "ChargeTotalAmount", "7.50")
        self.assertIn("BR-CO-12", fired(r))

    def test_br_co_12_charge_without_stated_total_fires(self):
        r = base()
        add_doc_allowance_charge(r, charge=True, amount="10.00")
        self.assertIn("BR-CO-12", fired(r))

    def test_br_co_11_rounding_half_up_holds(self):
        # Two allowances 0.005 + 0.005 = 0.010 -> round2 (halves toward +inf) =
        # 0.01; a stated total of 0.01 must hold. (BR-DEC-01 also fires on the
        # 3-decimal amounts, but that is a separate rule; we assert only -11.)
        r = base()
        add_doc_allowance_charge(r, charge=False, amount="0.005")
        add_doc_allowance_charge(r, charge=False, amount="0.005")
        set_lmt_amount(r, "AllowanceTotalAmount", "0.01")
        self.assertNotIn("BR-CO-11", fired(r))


class RulesetShape(unittest.TestCase):
    def test_all_new_rules_registered(self):
        from einvoice import rules
        ids = {"-".join(p.upper() for p in fn.__name__.split("_"))
               for fn in rules.ALL_RULES}
        for rid in (NEW_RULES | LINE_RULES | PAYMENT_RULES | ZE_RULES
                    | AEIC_RULES | GO_RULES | CALC_RULES | GAP_A_RULES
                    | AF_RULES | AG_B_RULES):
            self.assertIn(rid, ids, rid)
        # No duplicate rule ids in the ruleset.
        all_ids = ["-".join(p.upper() for p in fn.__name__.split("_"))
                   for fn in rules.ALL_RULES]
        self.assertEqual(len(all_ids), len(set(all_ids)))


def violation_for(root, rule_id):
    """Return the first Violation with ``rule_id`` in the result, else None."""
    for v in validate_root(root).violations:
        if v.rule_id == rule_id:
            return v
    return None


class CodelistCurrencyCountry(unittest.TestCase):
    """BR-CL-03/04/05 (ISO 4217 currency) + BR-CL-13 (UNTDID 7143) + BR-CL-14
    (ISO 3166-1 country), UBL binding. Each rule: a valid code passes, a bogus
    code fires the rule with FATAL severity.

    The allowed code sets are the pinned, verbatim-from-corpus lists in
    einvoice/codelists.py; the base invoice uses DKK / DK (both valid).
    """

    CL_RULES = {"BR-CL-03", "BR-CL-04", "BR-CL-05", "BR-CL-13", "BR-CL-14"}

    def test_clean_base_fires_no_codelist_rule(self):
        self.assertEqual(fired(base()) & self.CL_RULES, set())

    # --- BR-CL-03: @currencyID on amount elements --------------------------
    def test_br_cl_03_bogus_amount_currency_fires_fatal(self):
        r = base()
        child(r, NS_CAC, "LegalMonetaryTotal").find(
            q(NS_CBC, "PayableAmount")).set("currencyID", "XXY")
        v = violation_for(r, "BR-CL-03")
        self.assertIsNotNone(v)
        self.assertEqual(v.severity, "fatal")

    def test_br_cl_03_valid_amount_currency_passes(self):
        r = base()
        # Switch every amount + document currency to another ISO 4217 code.
        child(r, NS_CBC, "DocumentCurrencyCode").text = "EUR"
        for el in r.iter():
            if el.get("currencyID") == "DKK":
                el.set("currencyID", "EUR")
        self.assertNotIn("BR-CL-03", fired(r))

    # --- BR-CL-04: DocumentCurrencyCode ------------------------------------
    def test_br_cl_04_bogus_document_currency_fires_fatal(self):
        r = base()
        child(r, NS_CBC, "DocumentCurrencyCode").text = "XXY"
        v = violation_for(r, "BR-CL-04")
        self.assertIsNotNone(v)
        self.assertEqual(v.severity, "fatal")

    def test_br_cl_04_valid_document_currency_passes(self):
        r = base()
        child(r, NS_CBC, "DocumentCurrencyCode").text = "USD"
        self.assertNotIn("BR-CL-04", fired(r))

    # --- BR-CL-05: TaxCurrencyCode -----------------------------------------
    def test_br_cl_05_bogus_tax_currency_fires_fatal(self):
        r = base()
        ET.SubElement(r, q(NS_CBC, "TaxCurrencyCode")).text = "XXY"
        v = violation_for(r, "BR-CL-05")
        self.assertIsNotNone(v)
        self.assertEqual(v.severity, "fatal")

    def test_br_cl_05_valid_tax_currency_passes(self):
        r = base()
        ET.SubElement(r, q(NS_CBC, "TaxCurrencyCode")).text = "EUR"
        self.assertNotIn("BR-CL-05", fired(r))

    def test_br_cl_05_absent_tax_currency_does_not_fire(self):
        self.assertNotIn("BR-CL-05", fired(base()))

    # --- BR-CL-13: item classification @listID (UNTDID 7143) ---------------
    def test_br_cl_13_bogus_list_id_fires_fatal(self):
        r = base()
        item = first_line_item(r)
        cc = ET.SubElement(item, q(NS_CAC, "CommodityClassification"))
        icc = ET.SubElement(cc, q(NS_CBC, "ItemClassificationCode"))
        icc.text = "1234"
        icc.set("listID", "QQ")          # not a UNTDID 7143 code
        v = violation_for(r, "BR-CL-13")
        self.assertIsNotNone(v)
        self.assertEqual(v.severity, "fatal")

    def test_br_cl_13_valid_list_id_passes(self):
        r = base()
        item = first_line_item(r)
        cc = ET.SubElement(item, q(NS_CAC, "CommodityClassification"))
        icc = ET.SubElement(cc, q(NS_CBC, "ItemClassificationCode"))
        icc.text = "65010000"
        icc.set("listID", "ST")          # a UNTDID 7143 code
        self.assertNotIn("BR-CL-13", fired(r))

    # --- BR-CL-14: country codes (ISO 3166-1) ------------------------------
    def _seller_country_code(self, root):
        return supplier_party(root).find(
            "%s/%s/%s" % (q(NS_CAC, "PostalAddress"), q(NS_CAC, "Country"),
                          q(NS_CBC, "IdentificationCode")))

    def test_br_cl_14_bogus_country_fires_fatal(self):
        r = base()
        self._seller_country_code(r).text = "XX"
        v = violation_for(r, "BR-CL-14")
        self.assertIsNotNone(v)
        self.assertEqual(v.severity, "fatal")

    def test_br_cl_14_valid_country_passes(self):
        r = base()
        self._seller_country_code(r).text = "GB"
        self.assertNotIn("BR-CL-14", fired(r))

    def test_br_cl_14_ubl_binding_accepts_ss_rejects_an(self):
        # The UBL list carries SS (South Sudan) but not AN (Netherlands
        # Antilles) — the exact opposite of the CII list.
        r = base()
        cc = self._seller_country_code(r)
        cc.text = "SS"
        self.assertNotIn("BR-CL-14", fired(r))
        cc.text = "AN"
        self.assertIn("BR-CL-14", fired(r))


class CodelistVatCategory(unittest.TestCase):
    """BR-CL-17 / BR-CL-18 (UNCL 5305 VAT category subset) + BR-CL-22 (CEF
    VATEX exemption reason), UBL binding. The allowed sets are the pinned,
    verbatim-from-corpus lists in einvoice/codelists.py; the base invoice uses
    category 'S' (valid) with no exemption reason.
    """

    CL_RULES = {"BR-CL-17", "BR-CL-18", "BR-CL-22"}

    def test_clean_base_fires_no_vat_category_rule(self):
        self.assertEqual(fired(base()) & self.CL_RULES, set())

    # --- BR-CL-17: VAT breakdown / allowance-charge category (cac:TaxCategory)
    def test_br_cl_17_bogus_breakdown_category_fires_fatal(self):
        r = base()
        subtotal_category(r).find(q(NS_CBC, "ID")).text = "XX"
        v = violation_for(r, "BR-CL-17")
        self.assertIsNotNone(v)
        self.assertEqual(v.severity, "fatal")
        # BR-CL-18 (line ClassifiedTaxCategory) is untouched, so it stays clear.
        self.assertNotIn("BR-CL-18", fired(r))

    def test_br_cl_17_every_valid_category_passes(self):
        r = base()
        cat = subtotal_category(r).find(q(NS_CBC, "ID"))
        for code in ("S", "Z", "E", "AE", "K", "G", "O", "L", "M", "B"):
            cat.text = code
            self.assertNotIn("BR-CL-17", fired(r), "rejected valid %s" % code)

    def test_br_cl_17_lowercase_is_rejected(self):
        # The official test is case-SENSITIVE for category codes (no upper-case()).
        r = base()
        subtotal_category(r).find(q(NS_CBC, "ID")).text = "s"
        self.assertIn("BR-CL-17", fired(r))

    # --- BR-CL-18: line item VAT category (cac:ClassifiedTaxCategory) -------
    def _line_category_id(self, root):
        return first_line_item(root).find(
            "%s/%s" % (q(NS_CAC, "ClassifiedTaxCategory"), q(NS_CBC, "ID")))

    def test_br_cl_18_bogus_line_category_fires_fatal(self):
        r = base()
        self._line_category_id(r).text = "QQ"
        v = violation_for(r, "BR-CL-18")
        self.assertIsNotNone(v)
        self.assertEqual(v.severity, "fatal")

    def test_br_cl_18_valid_line_category_passes(self):
        r = base()
        self._line_category_id(r).text = "Z"
        self.assertNotIn("BR-CL-18", fired(r))

    # --- BR-CL-22: VAT exemption reason code (CEF VATEX) --------------------
    def test_br_cl_22_bogus_exemption_code_fires_fatal(self):
        r = base()
        cat = subtotal_category(r)
        ET.SubElement(cat, q(NS_CBC, "TaxExemptionReasonCode")).text = "NOT-VATEX"
        v = violation_for(r, "BR-CL-22")
        self.assertIsNotNone(v)
        self.assertEqual(v.severity, "fatal")

    def test_br_cl_22_valid_vatex_code_passes(self):
        r = base()
        cat = subtotal_category(r)
        ET.SubElement(cat, q(NS_CBC, "TaxExemptionReasonCode")).text = "VATEX-EU-79-C"
        self.assertNotIn("BR-CL-22", fired(r))

    def test_br_cl_22_is_case_insensitive(self):
        # The official assert compares upper-case(.), so a lower-case VATEX
        # code is still accepted.
        r = base()
        cat = subtotal_category(r)
        ET.SubElement(cat, q(NS_CBC, "TaxExemptionReasonCode")).text = "vatex-eu-79-c"
        self.assertNotIn("BR-CL-22", fired(r))


class TestBrCl23UnitCode(unittest.TestCase):
    """BR-CL-23: quantity/base-quantity unit codes must be UN/ECE Rec 20/21."""

    def _invoiced_qty(self, root):
        return root.find("%s/%s" % (q(NS_CAC, "InvoiceLine"),
                                    q(NS_CBC, "InvoicedQuantity")))

    def test_bogus_unit_code_fires_fatal(self):
        r = base()
        self._invoiced_qty(r).set("unitCode", "XXY")
        v = violation_for(r, "BR-CL-23")
        self.assertIsNotNone(v)
        self.assertEqual(v.severity, "fatal")

    def test_valid_unit_code_passes(self):
        # The base invoice's line unit code is a listed UN/ECE Rec 20 code.
        self.assertNotIn("BR-CL-23", fired(base()))

    def test_rec21_packaging_code_passes(self):
        # A Rec 21 packaging code (XBX = box) is in the same allowed set.
        r = base()
        self._invoiced_qty(r).set("unitCode", "XBX")
        self.assertNotIn("BR-CL-23", fired(r))

    def test_base_quantity_unit_code_checked(self):
        # cbc:BaseQuantity[@unitCode] (item price base quantity BT-149) is a
        # BR-CL-23 context node too — an off-list value there must fire.
        r = base()
        line = r.find(q(NS_CAC, "InvoiceLine"))
        price = line.find(q(NS_CAC, "Price"))
        if price is None:
            price = ET.SubElement(line, q(NS_CAC, "Price"))
        bq = price.find(q(NS_CBC, "BaseQuantity"))
        if bq is None:
            bq = ET.SubElement(price, q(NS_CBC, "BaseQuantity"))
            bq.text = "1"
        bq.set("unitCode", "XXY")
        self.assertIsNotNone(violation_for(r, "BR-CL-23"))


class SupportingDocItemMetadataVatPointBatch(unittest.TestCase):
    """BR-23, BR-52, BR-53, BR-54, BR-56, BR-64, BR-65, BR-CO-03, BR-CO-09,
    BR-CO-19 — the supporting-document / item-metadata / VAT-point batch,
    differentially proven against the official CEN EN16931-UBL Schematron the
    same way as the earlier batches (``differential.py en``). Each case pins
    one proven verdict, including the EXISTENCE-vs-normalize-space distinctions
    the official predicates draw."""

    # ---- helpers -----------------------------------------------------------
    def first_line(self, root):
        return root.find(q(NS_CAC, "InvoiceLine"))

    def add_supporting_doc(self, root, id_text):
        adr = ET.Element(q(NS_CAC, "AdditionalDocumentReference"))
        if id_text is not None:
            ET.SubElement(adr, q(NS_CBC, "ID")).text = id_text
        root.insert(
            list(root).index(child(root, NS_CAC, "AccountingSupplierParty")),
            adr)

    def add_tax_currency(self, root, code):
        tcc = ET.Element(q(NS_CBC, "TaxCurrencyCode"))
        tcc.text = code
        root.insert(
            list(root).index(child(root, NS_CBC, "DocumentCurrencyCode")) + 1,
            tcc)

    def add_item_property(self, root, name=None, value=None):
        item = first_line_item(root)
        aip = ET.SubElement(item, q(NS_CAC, "AdditionalItemProperty"))
        if name is not None:
            ET.SubElement(aip, q(NS_CBC, "Name")).text = name
        if value is not None:
            ET.SubElement(aip, q(NS_CBC, "Value")).text = value

    def add_tax_representative(self, root, scheme=None, company_id=None):
        trp = ET.Element(q(NS_CAC, "TaxRepresentativeParty"))
        pn = ET.SubElement(trp, q(NS_CAC, "PartyName"))
        ET.SubElement(pn, q(NS_CBC, "Name")).text = "Rep A"
        pa = ET.SubElement(trp, q(NS_CAC, "PostalAddress"))
        country = ET.SubElement(pa, q(NS_CAC, "Country"))
        ET.SubElement(country, q(NS_CBC, "IdentificationCode")).text = "DK"
        if scheme is not None:
            pts = ET.SubElement(trp, q(NS_CAC, "PartyTaxScheme"))
            if company_id is not None:
                ET.SubElement(pts, q(NS_CBC, "CompanyID")).text = company_id
            ts = ET.SubElement(pts, q(NS_CAC, "TaxScheme"))
            ET.SubElement(ts, q(NS_CBC, "ID")).text = scheme
        root.insert(list(root).index(child(root, NS_CAC, "TaxTotal")), trp)

    def doc_period(self, root):
        return child(root, NS_CAC, "InvoicePeriod")

    def seller_company_id(self, root):
        pts = child(supplier_party(root), NS_CAC, "PartyTaxScheme")
        return child(pts, NS_CBC, "CompanyID")

    # ---- BR-23: invoiced-quantity unit code (attribute existence) ----------
    def test_br_23_missing_unit_code_fires(self):
        r = base()
        del child(self.first_line(r), NS_CBC,
                  "InvoicedQuantity").attrib["unitCode"]
        self.assertIn("BR-23", fired(r))
        self.assertNotIn("BR-23", fired(base()))

    def test_br_23_empty_unit_code_holds(self):
        # exists(@unitCode) — an EMPTY unitCode="" satisfies BR-23 (judging the
        # VALUE is BR-CL-23's job, not BR-23's).
        r = base()
        child(self.first_line(r), NS_CBC,
              "InvoicedQuantity").set("unitCode", "")
        self.assertNotIn("BR-23", fired(r))

    # ---- BR-52: supporting document reference (normalize-space) ------------
    def test_br_52_reference_without_id_fires(self):
        r = base()
        self.add_supporting_doc(r, None)
        self.assertIn("BR-52", fired(r))
        self.assertNotIn("BR-52", fired(base()))

    def test_br_52_whitespace_only_id_fires(self):
        # normalize-space(cbc:ID) != '' — whitespace-only is as bad as absent.
        r = base()
        self.add_supporting_doc(r, "   ")
        self.assertIn("BR-52", fired(r))

    def test_br_52_reference_with_id_holds(self):
        r = base()
        self.add_supporting_doc(r, "DOC-1")
        self.assertNotIn("BR-52", fired(r))

    # ---- BR-53: VAT total in the accounting currency ------------------------
    def test_br_53_tax_currency_without_matching_total_fires(self):
        # BT-6 declared (EUR; doc currency is DKK) but no cac:TaxTotal/
        # cbc:TaxAmount carries @currencyID="EUR".
        r = base()
        self.add_tax_currency(r, "EUR")
        self.assertIn("BR-53", fired(r))
        self.assertNotIn("BR-53", fired(base()))

    def test_br_53_matching_accounting_total_holds(self):
        r = base()
        self.add_tax_currency(r, "EUR")
        tt = ET.Element(q(NS_CAC, "TaxTotal"))
        ta = ET.SubElement(tt, q(NS_CBC, "TaxAmount"))
        ta.text = "156435.89"
        ta.set("currencyID", "EUR")
        r.insert(list(r).index(child(r, NS_CAC, "LegalMonetaryTotal")), tt)
        self.assertNotIn("BR-53", fired(r))

    # ---- BR-54: item attribute name AND value (existence) ------------------
    def test_br_54_name_without_value_fires(self):
        r = base()
        self.add_item_property(r, name="Colour")
        self.assertIn("BR-54", fired(r))
        self.assertNotIn("BR-54", fired(base()))

    def test_br_54_value_without_name_fires(self):
        r = base()
        self.add_item_property(r, value="Red")
        self.assertIn("BR-54", fired(r))

    def test_br_54_name_and_value_hold(self):
        # exists(cbc:Name) and exists(cbc:Value) — presence only, empty text ok.
        r = base()
        self.add_item_property(r, name="", value="")
        self.assertNotIn("BR-54", fired(r))

    # ---- BR-56: tax representative VAT identifier (UBL pure existence) -----
    def test_br_56_representative_without_tax_scheme_fires(self):
        r = base()
        self.add_tax_representative(r)
        self.assertIn("BR-56", fired(r))
        self.assertNotIn("BR-56", fired(base()))

    def test_br_56_non_vat_scheme_fires(self):
        # A CompanyID under a non-VAT TaxScheme is BT-64 territory, not BT-63.
        r = base()
        self.add_tax_representative(r, scheme="OTHER", company_id="DK11111111")
        self.assertIn("BR-56", fired(r))

    def test_br_56_empty_company_id_holds(self):
        # exists(...cbc:CompanyID) — the UBL binding is PURE existence: even an
        # empty CompanyID under the VAT scheme satisfies BR-56 (unlike the CII
        # binding, which normalize-spaces — see test_rules_cii.py).
        r = base()
        self.add_tax_representative(r, scheme="VAT", company_id="")
        self.assertNotIn("BR-56", fired(r))

    # ---- BR-64 / BR-65: identifier scheme attributes (existence) -----------
    def add_standard_item_id(self, root, scheme_id):
        sii = ET.SubElement(first_line_item(root),
                            q(NS_CAC, "StandardItemIdentification"))
        id_el = ET.SubElement(sii, q(NS_CBC, "ID"))
        id_el.text = "1234567890123"
        if scheme_id is not None:
            id_el.set("schemeID", scheme_id)

    def add_classification(self, root, list_id):
        cc = ET.SubElement(first_line_item(root),
                           q(NS_CAC, "CommodityClassification"))
        icc = ET.SubElement(cc, q(NS_CBC, "ItemClassificationCode"))
        icc.text = "9873242"
        if list_id is not None:
            icc.set("listID", list_id)

    def test_br_64_missing_scheme_id_fires(self):
        r = base()
        self.add_standard_item_id(r, None)
        self.assertIn("BR-64", fired(r))
        self.assertNotIn("BR-64", fired(base()))

    def test_br_64_empty_scheme_id_holds(self):
        # exists(@schemeID) — empty attribute satisfies the UBL binding.
        r = base()
        self.add_standard_item_id(r, "")
        self.assertNotIn("BR-64", fired(r))

    def test_br_64_gtin_scheme_holds(self):
        r = base()
        self.add_standard_item_id(r, "0160")
        self.assertNotIn("BR-64", fired(r))

    def test_br_65_missing_list_id_fires(self):
        r = base()
        self.add_classification(r, None)
        self.assertIn("BR-65", fired(r))
        self.assertNotIn("BR-65", fired(base()))

    def test_br_65_with_list_id_holds(self):
        r = base()
        self.add_classification(r, "TST")
        self.assertNotIn("BR-65", fired(r))

    # ---- BR-CO-03: VAT point date XOR VAT point date code ------------------
    def add_tax_point_date(self, root):
        tpd = ET.Element(q(NS_CBC, "TaxPointDate"))
        tpd.text = "2018-09-30"
        root.insert(
            list(root).index(child(root, NS_CBC, "DocumentCurrencyCode")),
            tpd)

    def test_br_co_03_both_present_fires(self):
        r = base()
        self.add_tax_point_date(r)
        ET.SubElement(self.doc_period(r),
                      q(NS_CBC, "DescriptionCode")).text = "35"
        self.assertIn("BR-CO-03", fired(r))
        self.assertNotIn("BR-CO-03", fired(base()))

    def test_br_co_03_date_alone_holds(self):
        r = base()
        self.add_tax_point_date(r)
        self.assertNotIn("BR-CO-03", fired(r))

    def test_br_co_03_code_alone_holds(self):
        r = base()
        ET.SubElement(self.doc_period(r),
                      q(NS_CBC, "DescriptionCode")).text = "35"
        self.assertNotIn("BR-CO-03", fired(r))

    # ---- BR-CO-09: VAT identifier country-code prefix ----------------------
    def test_br_co_09_unlisted_prefix_fires(self):
        # 'XX' is neither a token of the official UBL prefix string nor any
        # two adjacent characters of it.
        r = base()
        self.seller_company_id(r).text = "XX12345678"
        self.assertIn("BR-CO-09", fired(r))
        self.assertNotIn("BR-CO-09", fired(base()))

    def test_br_co_09_greece_el_prefix_holds(self):
        # The documented exception: Greece may use 'EL' instead of 'GR'.
        r = base()
        self.seller_company_id(r).text = "EL123456789"
        self.assertNotIn("BR-CO-09", fired(r))

    def test_br_co_09_short_id_holds_on_ubl(self):
        # The UBL predicate is contains(list, substring(CompanyID, 1, 2)) with
        # NO space-wrapping: a 1-character identifier always matches somewhere
        # in the list string, so the official UBL artifact does NOT fire.
        # (The CII binding space-wraps and DOES fire — see test_rules_cii.py.)
        r = base()
        self.seller_company_id(r).text = "D"
        self.assertNotIn("BR-CO-09", fired(r))

    def test_br_co_09_buyer_prefix_also_checked(self):
        r = base()
        pts = child(buyer_party(r), NS_CAC, "PartyTaxScheme")
        child(pts, NS_CBC, "CompanyID").text = "XX87654321"
        self.assertIn("BR-CO-09", fired(r))

    # ---- BR-CO-19: invoicing period must be filled --------------------------
    def test_br_co_19_empty_period_fires(self):
        r = base()
        period = self.doc_period(r)
        period.remove(child(period, NS_CBC, "StartDate"))
        period.remove(child(period, NS_CBC, "EndDate"))
        self.assertIn("BR-CO-19", fired(r))
        self.assertNotIn("BR-CO-19", fired(base()))

    def test_br_co_19_start_date_alone_holds(self):
        r = base()
        period = self.doc_period(r)
        period.remove(child(period, NS_CBC, "EndDate"))
        self.assertNotIn("BR-CO-19", fired(r))

    def test_br_co_19_description_code_alone_holds(self):
        # The UBL binding's third disjunct: a DescriptionCode-only period is
        # "filled" (it names the VAT point date code instead of dates).
        r = base()
        period = self.doc_period(r)
        period.remove(child(period, NS_CBC, "StartDate"))
        period.remove(child(period, NS_CBC, "EndDate"))
        ET.SubElement(period, q(NS_CBC, "DescriptionCode")).text = "35"
        self.assertNotIn("BR-CO-19", fired(r))


class GapBatchA(unittest.TestCase):
    """BR-CO-20/21/22/23/24/26, BR-DEC-24/25/27/28, BR-IC-10, BR-S-08 — the
    core/decimals/VAT gap batch A, differentially proven against the official
    CEN EN16931-UBL Schematron the same way as the earlier batches
    (``differential.py en``). Each case pins one proven verdict."""

    def first_line(self, root):
        return root.find(q(NS_CAC, "InvoiceLine"))

    def add_line_allowance_charge(self, root, charge, amount="0.00",
                                  base_amount=None, reason=None):
        ln = self.first_line(root)
        ac = ET.Element(q(NS_CAC, "AllowanceCharge"))
        ET.SubElement(ac, q(NS_CBC, "ChargeIndicator")).text = (
            "true" if charge else "false")
        if reason is not None:
            ET.SubElement(ac, q(NS_CBC, "AllowanceChargeReason")).text = reason
        amt = ET.SubElement(ac, q(NS_CBC, "Amount"))
        amt.text = amount
        amt.set("currencyID", "DKK")
        if base_amount is not None:
            b = ET.SubElement(ac, q(NS_CBC, "BaseAmount"))
            b.text = base_amount
            b.set("currencyID", "DKK")
        ln.insert(list(ln).index(child(ln, NS_CAC, "Item")), ac)
        return ac

    # ---- BR-CO-20 -----------------------------------------------------------
    def test_br_co_20_empty_line_period_fires(self):
        r = base()
        period = child(self.first_line(r), NS_CAC, "InvoicePeriod")
        period.remove(child(period, NS_CBC, "StartDate"))
        period.remove(child(period, NS_CBC, "EndDate"))
        self.assertIn("BR-CO-20", fired(r))
        self.assertNotIn("BR-CO-20", fired(base()))

    def test_br_co_20_start_date_alone_holds(self):
        r = base()
        period = child(self.first_line(r), NS_CAC, "InvoicePeriod")
        period.remove(child(period, NS_CBC, "EndDate"))
        self.assertNotIn("BR-CO-20", fired(r))

    def test_br_co_20_empty_date_element_holds(self):
        # exists(cbc:StartDate) — pure existence: a present-but-empty date
        # satisfies BR-CO-20 (its VALUE is other rules' business).
        r = base()
        period = child(self.first_line(r), NS_CAC, "InvoicePeriod")
        child(period, NS_CBC, "StartDate").text = ""
        period.remove(child(period, NS_CBC, "EndDate"))
        self.assertNotIn("BR-CO-20", fired(r))

    # ---- BR-CO-21 / BR-CO-22 (document allowance/charge reason) -------------
    def add_bare_doc_ac(self, root, charge):
        ac = add_doc_allowance_charge(root, charge=charge, amount="0.00")
        ac.remove(child(ac, NS_CBC, "AllowanceChargeReason"))
        return ac

    def test_br_co_21_reasonless_doc_allowance_fires(self):
        r = base()
        self.add_bare_doc_ac(r, charge=False)
        self.assertIn("BR-CO-21", fired(r))
        self.assertNotIn("BR-CO-21", fired(base()))

    def test_br_co_21_reason_code_alone_holds(self):
        r = base()
        ac = self.add_bare_doc_ac(r, charge=False)
        ET.SubElement(ac, q(NS_CBC, "AllowanceChargeReasonCode")).text = "95"
        self.assertNotIn("BR-CO-21", fired(r))

    def test_br_co_22_reasonless_doc_charge_fires(self):
        r = base()
        self.add_bare_doc_ac(r, charge=True)
        self.assertIn("BR-CO-22", fired(r))
        self.assertNotIn("BR-CO-21", fired(r))  # the allowance twin stays out

    # ---- BR-CO-23 / BR-CO-24 (line allowance/charge reason) -----------------
    def test_br_co_23_reasonless_line_allowance_fires(self):
        r = base()
        self.add_line_allowance_charge(r, charge=False)
        self.assertIn("BR-CO-23", fired(r))
        self.assertNotIn("BR-CO-23", fired(base()))

    def test_br_co_23_with_reason_holds(self):
        r = base()
        self.add_line_allowance_charge(r, charge=False, reason="Discount")
        self.assertNotIn("BR-CO-23", fired(r))

    def test_br_co_24_reasonless_line_charge_fires(self):
        r = base()
        self.add_line_allowance_charge(r, charge=True)
        self.assertIn("BR-CO-24", fired(r))
        self.assertNotIn("BR-CO-23", fired(r))

    # ---- BR-DEC-24/25/27/28 (line allowance/charge decimals) ----------------
    def test_br_dec_24_three_decimal_allowance_amount_fires(self):
        r = base()
        self.add_line_allowance_charge(r, charge=False, amount="1.123",
                                       reason="Discount")
        self.assertIn("BR-DEC-24", fired(r))
        self.assertNotIn("BR-DEC-24", fired(base()))

    def test_br_dec_25_three_decimal_allowance_base_fires(self):
        r = base()
        self.add_line_allowance_charge(r, charge=False, amount="1.12",
                                       base_amount="10.123", reason="Discount")
        got = fired(r)
        self.assertIn("BR-DEC-25", got)
        self.assertNotIn("BR-DEC-24", got)  # the amount itself is 2-dec

    def test_br_dec_27_three_decimal_charge_amount_fires(self):
        r = base()
        self.add_line_allowance_charge(r, charge=True, amount="1.123",
                                       reason="Freight")
        got = fired(r)
        self.assertIn("BR-DEC-27", got)
        self.assertNotIn("BR-DEC-24", got)  # charge, not allowance

    def test_br_dec_28_three_decimal_charge_base_fires(self):
        r = base()
        self.add_line_allowance_charge(r, charge=True, amount="1.12",
                                       base_amount="10.123", reason="Freight")
        self.assertIn("BR-DEC-28", fired(r))

    def test_br_dec_two_decimals_hold(self):
        r = base()
        self.add_line_allowance_charge(r, charge=False, amount="1.12",
                                       base_amount="10.12", reason="Discount")
        got = fired(r)
        for rid in ("BR-DEC-24", "BR-DEC-25", "BR-DEC-27", "BR-DEC-28"):
            self.assertNotIn(rid, got)

    # ---- BR-CO-26 (seller identification) ------------------------------------
    def strip_seller_ids(self, root):
        party = supplier_party(root)
        party.remove(child(party, NS_CAC, "PartyIdentification"))
        party.remove(child(party, NS_CAC, "PartyTaxScheme"))
        ple = child(party, NS_CAC, "PartyLegalEntity")
        ple.remove(child(ple, NS_CBC, "CompanyID"))

    def test_br_co_26_no_identifier_fires(self):
        r = base()
        self.strip_seller_ids(r)
        self.assertIn("BR-CO-26", fired(r))
        self.assertNotIn("BR-CO-26", fired(base()))

    def test_br_co_26_party_identification_alone_holds(self):
        r = base()
        party = supplier_party(r)
        party.remove(child(party, NS_CAC, "PartyTaxScheme"))
        ple = child(party, NS_CAC, "PartyLegalEntity")
        ple.remove(child(ple, NS_CBC, "CompanyID"))
        self.assertNotIn("BR-CO-26", fired(r))

    def test_br_co_26_sepa_scheme_id_does_not_count(self):
        # cbc:ID[not(@schemeID = 'SEPA')] — a SEPA-schemed identifier is
        # excluded from the accepted set (it identifies a mandate creditor,
        # not the supplier), so with the other ids stripped BR-CO-26 fires.
        r = base()
        self.strip_seller_ids(r)
        party = supplier_party(r)
        pi = ET.Element(q(NS_CAC, "PartyIdentification"))
        id_el = ET.SubElement(pi, q(NS_CBC, "ID"))
        id_el.text = "DK99999999"
        id_el.set("schemeID", "SEPA")
        party.insert(0, pi)
        self.assertIn("BR-CO-26", fired(r))

    def test_br_co_26_schemeless_id_counts(self):
        # An ID with NO @schemeID satisfies not(() = 'SEPA') and holds.
        r = base()
        self.strip_seller_ids(r)
        party = supplier_party(r)
        pi = ET.Element(q(NS_CAC, "PartyIdentification"))
        ET.SubElement(pi, q(NS_CBC, "ID")).text = "DK99999999"
        party.insert(0, pi)
        self.assertNotIn("BR-CO-26", fired(r))

    # ---- BR-IC-10 -------------------------------------------------------------
    def test_br_ic_10_k_breakdown_without_reason_fires(self):
        r = base()
        st = ET.SubElement(child(r, NS_CAC, "TaxTotal"),
                           q(NS_CAC, "TaxSubtotal"))
        for local, val in (("TaxableAmount", "0.00"), ("TaxAmount", "0.00")):
            el = ET.SubElement(st, q(NS_CBC, local))
            el.text = val
            el.set("currencyID", "DKK")
        cat = ET.SubElement(st, q(NS_CAC, "TaxCategory"))
        ET.SubElement(cat, q(NS_CBC, "ID")).text = "K"
        ET.SubElement(cat, q(NS_CBC, "Percent")).text = "0"
        ET.SubElement(ET.SubElement(cat, q(NS_CAC, "TaxScheme")),
                      q(NS_CBC, "ID")).text = "VAT"
        self.assertIn("BR-IC-10", fired(r))
        # A reason text satisfies the rule (mirror of BR-E-10).
        reason = ET.Element(q(NS_CBC, "TaxExemptionReason"))
        reason.text = "Intra-community supply"
        cat.insert(list(cat).index(cat.find(q(NS_CAC, "TaxScheme"))), reason)
        self.assertNotIn("BR-IC-10", fired(r))

    def test_br_ic_10_clean_k_base_holds(self):
        self.assertNotIn("BR-IC-10", fired(intra_community_base()))

    # ---- BR-S-08 ---------------------------------------------------------------
    def set_taxable(self, root, value):
        child(subtotal(root), NS_CBC, "TaxableAmount").text = value

    def test_br_s_08_taxable_off_band_fires(self):
        r = base()
        self.set_taxable(r, "625745.54")  # +2 off the S/25 bucket sum
        got = fired(r)
        self.assertIn("BR-S-08", got)
        # ... while the ±1 tax-amount bands (BR-CO-17 / BR-S-09) still hold:
        # 625745.54 x 25% is only 0.50 away from the stated 156435.89.
        self.assertNotIn("BR-CO-17", got)
        self.assertNotIn("BR-S-09", got)
        self.assertNotIn("BR-S-08", fired(base()))

    def test_br_s_08_band_is_strictly_exclusive(self):
        # taxable - 1 < sum and taxable + 1 > sum: exactly +1 off FIRES.
        r = base()
        self.set_taxable(r, "625744.54")
        self.assertIn("BR-S-08", fired(r))
        r2 = base()
        self.set_taxable(r2, "625744.53")  # 0.99 off: inside the band
        self.assertNotIn("BR-S-08", fired(r2))

    def test_br_s_08_doc_allowance_and_charge_enter_the_bucket(self):
        # A matching-rate S charge adds, an S allowance subtracts.
        r = base()
        add_doc_allowance_charge(r, charge=True, amount="10.00")
        self.set_taxable(r, "625753.54")
        self.assertNotIn("BR-S-08", fired(r))
        r2 = base()
        add_doc_allowance_charge(r2, charge=False, amount="10.00")
        self.set_taxable(r2, "625733.54")
        self.assertNotIn("BR-S-08", fired(r2))

    def test_br_s_08_other_rate_allowance_stays_out(self):
        # An S allowance at a DIFFERENT rate is not part of the 25% bucket:
        # the sum stays 625743.54, so shifting taxable to match the allowance
        # being subtracted FIRES.
        r = base()
        add_doc_allowance_charge(r, charge=False, amount="10.00", percent="12")
        self.set_taxable(r, "625733.54")
        self.assertIn("BR-S-08", fired(r))

    def test_br_s_08_orphan_s_breakdown_rate_fires(self):
        # No S line and no S allowance/charge at the breakdown's rate: both
        # official exists() disjuncts fail, so the assert fires even though
        # the amounts are consistent.
        r = base()
        ctc = first_line_item(r).find(q(NS_CAC, "ClassifiedTaxCategory"))
        child(ctc, NS_CBC, "Percent").text = "12"
        self.assertIn("BR-S-08", fired(r))

    def test_br_s_08_absent_percent_is_vacuous(self):
        # every $rate in xs:decimal(cbc:Percent) over an ABSENT Percent is
        # vacuously true -> BR-S-08 holds (BR-48 fires for the missing rate).
        r = base()
        cat = subtotal_category(r)
        cat.remove(child(cat, NS_CBC, "Percent"))
        got = fired(r)
        self.assertNotIn("BR-S-08", got)
        self.assertIn("BR-48", got)


# --------------------------------------------------------------------------- #
# KoSIT-vendored Peppol batch 1 (PEPPOL-EN16931-R*), UBL binding.             #
# Firing + non-firing fixtures per rule, mutated off the clean XRechnung      #
# testsuite invoice 01.01a (fires NONE of the batch on the official KoSIT     #
# XSLT — agreement proven exhaustively by `differential.py xrechnung`).       #
# --------------------------------------------------------------------------- #
from einvoice import rules_peppol as _rules_pep  # noqa: E402

_PEP_BASE = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test",
                         "business-cases", "standard", "01.01a-INVOICE_ubl.xml")
_PEP_BASE_ROOT = ET.parse(_PEP_BASE).getroot()


def _pep(rid):
    return "PEPPOL-EN16931-" + rid


class PeppolKositBatch1Ubl(unittest.TestCase):
    """UBL-binding fixtures for the 11 implemented PEPPOL-EN16931-R* rules."""

    @staticmethod
    def pep_base():
        return copy.deepcopy(_PEP_BASE_ROOT)

    @staticmethod
    def pep_fired(r):
        return {v.rule_id for v in _rules_pep.evaluate_ubl(r)}

    def add_doc_allowance(self, r, indicator="false", amount=None, base=None,
                          percent=None):
        """Document-level cac:AllowanceCharge before cac:TaxTotal."""
        ac = ET.Element(q(NS_CAC, "AllowanceCharge"))
        if indicator is not None:
            ET.SubElement(ac, q(NS_CBC, "ChargeIndicator")).text = indicator
        if percent is not None:
            ET.SubElement(ac, q(NS_CBC,
                                "MultiplierFactorNumeric")).text = percent
        if amount is not None:
            ET.SubElement(ac, q(NS_CBC, "Amount")).text = amount
        if base is not None:
            ET.SubElement(ac, q(NS_CBC, "BaseAmount")).text = base
        r.insert(list(r).index(r.find(q(NS_CAC, "TaxTotal"))), ac)
        return ac

    def add_price_allowance(self, r, indicator, base, amount):
        """cac:AllowanceCharge under the first line's cac:Price (whose
        PriceAmount in the 01.01a base is 288.79)."""
        price = r.find("%s/%s" % (q(NS_CAC, "InvoiceLine"), q(NS_CAC, "Price")))
        ac = ET.SubElement(price, q(NS_CAC, "AllowanceCharge"))
        if indicator is not None:
            ET.SubElement(ac, q(NS_CBC, "ChargeIndicator")).text = indicator
        if amount is not None:
            ET.SubElement(ac, q(NS_CBC, "Amount")).text = amount
        if base is not None:
            ET.SubElement(ac, q(NS_CBC, "BaseAmount")).text = base
        return price, ac

    # ---- clean base ---------------------------------------------------------
    def test_clean_base_fires_none(self):
        self.assertEqual(self.pep_fired(self.pep_base()), set())

    # ---- R001 ---------------------------------------------------------------
    def test_r001_missing_profile_id_fires(self):
        r = self.pep_base()
        r.remove(child(r, NS_CBC, "ProfileID"))
        self.assertEqual(self.pep_fired(r), {_pep("R001")})

    def test_r001_empty_profile_id_holds_but_r008_fires(self):
        # R001 tests element EXISTENCE only; an empty ProfileID satisfies it
        # (but is itself an empty element -> R008).
        r = self.pep_base()
        child(r, NS_CBC, "ProfileID").text = ""
        got = self.pep_fired(r)
        self.assertNotIn(_pep("R001"), got)
        self.assertIn(_pep("R008"), got)

    # ---- R005 ---------------------------------------------------------------
    def test_r005_tax_currency_equal_to_doc_currency_fires(self):
        r = self.pep_base()
        dcc = child(r, NS_CBC, "DocumentCurrencyCode")
        tcc = ET.Element(q(NS_CBC, "TaxCurrencyCode"))
        tcc.text = dcc.text
        r.insert(list(r).index(dcc) + 1, tcc)
        self.assertEqual(self.pep_fired(r), {_pep("R005")})

    def test_r005_different_tax_currency_holds(self):
        r = self.pep_base()
        dcc = child(r, NS_CBC, "DocumentCurrencyCode")
        tcc = ET.Element(q(NS_CBC, "TaxCurrencyCode"))
        tcc.text = "USD"
        r.insert(list(r).index(dcc) + 1, tcc)
        self.assertEqual(self.pep_fired(r), set())

    # ---- R008 ---------------------------------------------------------------
    def test_r008_empty_element_fires(self):
        r = self.pep_base()
        ET.SubElement(r, q(NS_CBC, "Note"))
        self.assertEqual(self.pep_fired(r), {_pep("R008")})

    def test_r008_whitespace_only_element_fires(self):
        r = self.pep_base()
        ET.SubElement(r, q(NS_CBC, "Note")).text = "  \n\t "
        self.assertEqual(self.pep_fired(r), {_pep("R008")})

    def test_r008_attribute_does_not_rescue_empty_element(self):
        r = self.pep_base()
        el = ET.SubElement(r, q(NS_CBC, "Note"))
        el.set("languageID", "de")
        self.assertEqual(self.pep_fired(r), {_pep("R008")})

    def test_r008_element_with_text_holds(self):
        r = self.pep_base()
        ET.SubElement(r, q(NS_CBC, "Note")).text = "real content"
        self.assertEqual(self.pep_fired(r), set())

    # ---- R010 / R020 --------------------------------------------------------
    def test_r010_missing_buyer_endpoint_fires(self):
        r = self.pep_base()
        party = r.find("%s/%s" % (q(NS_CAC, "AccountingCustomerParty"),
                                  q(NS_CAC, "Party")))
        party.remove(child(party, NS_CBC, "EndpointID"))
        self.assertEqual(self.pep_fired(r), {_pep("R010")})

    def test_r020_missing_seller_endpoint_fires(self):
        r = self.pep_base()
        party = supplier_party(r)
        party.remove(child(party, NS_CBC, "EndpointID"))
        self.assertEqual(self.pep_fired(r), {_pep("R020")})

    # ---- R040 (slack band) --------------------------------------------------
    def test_r040_amount_off_the_percentage_fires(self):
        r = self.pep_base()
        self.add_doc_allowance(r, amount="10.00", base="100.00", percent="25")
        self.assertEqual(self.pep_fired(r), {_pep("R040")})

    def test_r040_amount_within_slack_holds(self):
        # |25.01 - 25.00| = 0.01 <= slack 0.02 -> holds.
        r = self.pep_base()
        self.add_doc_allowance(r, amount="25.01", base="100.00", percent="25")
        self.assertEqual(self.pep_fired(r), set())

    def test_r040_just_outside_slack_fires(self):
        # |25.03 - 25.00| = 0.03 > 0.02 -> fires.
        r = self.pep_base()
        self.add_doc_allowance(r, amount="25.03", base="100.00", percent="25")
        self.assertEqual(self.pep_fired(r), {_pep("R040")})

    def test_r040_huf_widens_slack_to_half(self):
        # $slackValue is 0.5 when BT-5 = HUF: 25.40 holds there, fires on EUR.
        r = self.pep_base()
        self.add_doc_allowance(r, amount="25.40", base="100.00", percent="25")
        self.assertEqual(self.pep_fired(r), {_pep("R040")})
        r2 = self.pep_base()
        child(r2, NS_CBC, "DocumentCurrencyCode").text = "HUF"
        self.add_doc_allowance(r2, amount="25.40", base="100.00", percent="25")
        self.assertNotIn(_pep("R040"), self.pep_fired(r2))

    def test_r040_absent_amount_counts_as_zero(self):
        # if (cbc:Amount) then cbc:Amount else 0 -> 0 vs 25.00 -> fires.
        r = self.pep_base()
        self.add_doc_allowance(r, amount=None, base="100.00", percent="25")
        self.assertEqual(self.pep_fired(r), {_pep("R040")})

    # ---- R041 / R042 --------------------------------------------------------
    def test_r041_percentage_without_base_fires(self):
        r = self.pep_base()
        self.add_doc_allowance(r, amount="10.00", percent="10")
        self.assertEqual(self.pep_fired(r), {_pep("R041")})

    def test_r042_base_without_percentage_fires(self):
        r = self.pep_base()
        self.add_doc_allowance(r, amount="10.00", base="100.00")
        self.assertEqual(self.pep_fired(r), {_pep("R042")})

    def test_r041_r042_both_present_hold(self):
        r = self.pep_base()
        self.add_doc_allowance(r, amount="25.00", base="100.00", percent="25")
        self.assertEqual(self.pep_fired(r), set())

    # ---- R043 ---------------------------------------------------------------
    def test_r043_bad_indicator_fires(self):
        r = self.pep_base()
        self.add_doc_allowance(r, indicator="TRUE", amount="10.00")
        self.assertEqual(self.pep_fired(r), {_pep("R043")})

    def test_r043_absent_indicator_fires(self):
        r = self.pep_base()
        self.add_doc_allowance(r, indicator=None, amount="10.00")
        self.assertEqual(self.pep_fired(r), {_pep("R043")})

    def test_r043_normalized_true_holds(self):
        # normalize-space(' true ') = 'true' -> holds.
        r = self.pep_base()
        self.add_doc_allowance(r, indicator=" true ", amount="10.00")
        self.assertEqual(self.pep_fired(r), set())

    # ---- R044 / R046 (price level) ------------------------------------------
    def test_r044_price_level_charge_fires(self):
        r = self.pep_base()
        # PriceAmount 288.79 = 289.79 - 1.00 -> R046 holds; only R044 fires.
        self.add_price_allowance(r, "true", base="289.79", amount="1.00")
        self.assertEqual(self.pep_fired(r), {_pep("R044")})

    def test_r044_false_indicator_holds(self):
        r = self.pep_base()
        self.add_price_allowance(r, "false", base="289.79", amount="1.00")
        self.assertEqual(self.pep_fired(r), set())

    def test_r046_gross_minus_allowance_mismatch_fires(self):
        r = self.pep_base()
        self.add_price_allowance(r, "false", base="300.00", amount="1.00")
        self.assertEqual(self.pep_fired(r), {_pep("R046")})

    def test_r046_absent_amount_fires(self):
        # xs:decimal(()) in the subtraction -> comparison false -> fires.
        r = self.pep_base()
        self.add_price_allowance(r, "false", base="288.79", amount=None)
        self.assertEqual(self.pep_fired(r), {_pep("R046")})

    def test_r046_no_base_amount_is_vacuous(self):
        r = self.pep_base()
        self.add_price_allowance(r, "false", base=None, amount="1.00")
        self.assertEqual(self.pep_fired(r), set())

    def test_r046_decimal_equality_is_numeric(self):
        # xs:decimal('288.79') = xs:decimal('289.79') - xs:decimal('1.000')
        # (trailing zeros are equal numerically, exactly like xs:decimal).
        r = self.pep_base()
        self.add_price_allowance(r, "false", base="289.79", amount="1.000")
        self.assertEqual(self.pep_fired(r), set())


if __name__ == "__main__":
    unittest.main(verbosity=2)

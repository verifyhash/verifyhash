#!/usr/bin/env python3
"""Unit tests for the EN 16931 core rules added in the VAT-breakdown /
Standard-rate batch (BR-45..48, BR-S-02..10) and the invoice-line batch
(BR-25, BR-27, BR-28, BR-29, BR-30, BR-CO-04).

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


def add_doc_allowance_charge(root, charge, percent="25"):
    """Append a document-level AllowanceCharge (S/VAT) before cac:TaxTotal."""
    ac = ET.Element(q(NS_CAC, "AllowanceCharge"))
    ET.SubElement(ac, q(NS_CBC, "ChargeIndicator")).text = (
        "true" if charge else "false")
    ET.SubElement(ac, q(NS_CBC, "AllowanceChargeReason")).text = "Adjustment"
    amt = ET.SubElement(ac, q(NS_CBC, "Amount"))
    amt.text = "10.00"
    amt.set("currencyID", "DKK")
    cat = ET.SubElement(ac, q(NS_CAC, "TaxCategory"))
    ET.SubElement(cat, q(NS_CBC, "ID")).text = "S"
    ET.SubElement(cat, q(NS_CBC, "Percent")).text = percent
    ET.SubElement(ET.SubElement(cat, q(NS_CAC, "TaxScheme")),
                  q(NS_CBC, "ID")).text = "VAT"
    tt = child(root, NS_CAC, "TaxTotal")
    root.insert(list(root).index(tt), ac)
    return ac


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


class RulesetShape(unittest.TestCase):
    def test_all_new_rules_registered(self):
        from einvoice import rules
        ids = {"-".join(p.upper() for p in fn.__name__.split("_"))
               for fn in rules.ALL_RULES}
        for rid in NEW_RULES | LINE_RULES:
            self.assertIn(rid, ids, rid)
        # No duplicate rule ids in the ruleset.
        all_ids = ["-".join(p.upper() for p in fn.__name__.split("_"))
                   for fn in rules.ALL_RULES]
        self.assertEqual(len(all_ids), len(set(all_ids)))


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""Unit tests for BR-S-08 — the per-rate Standard-rated VAT breakdown
consistency rule (T-VHCORE.1).

BR-S-08: for EACH distinct Standard-rated ('S') VAT rate (BT-119), the VAT
category taxable amount (BT-116) in the breakdown for that rate must equal
Σ S-rated line net amounts (BT-131) + Σ S-rated document-level charge
amounts (BT-99) − Σ S-rated document-level allowance amounts (BT-92),
restricted to lines/allowances/charges carrying that same rate.

The rule is transcribed in ``einvoice/rules.br_s_08`` from BOTH vendored
preprocessed artifacts, whose bindings genuinely differ:

  * UBL (EN16931-UBL-validation-preprocessed.sch): a STRICT ±1 band
    (``TaxableAmount - 1 < sum and TaxableAmount + 1 > sum``), gated on
    ``exists()`` of an S/$rate line OR an S/$rate AllowanceCharge (any
    depth), with a parallel CreditNote arm;
  * CII (EN16931-CII-validation-preprocessed.sch): EXACT equality against
    the PER-BUCKET ``round(x*10*10) div 100`` sums — no tolerance band.

This file is the fast, saxonche-free companion to the differential harness
(which proves the transcription against the official Schematron over the
full corpus, mutations included): it pins the proven verdicts with in-file
minimal fixtures (the S/Z/E-family precedent — no new corpus files) AND
replays the two official vendored CEN unit-test vectors
(``corpus/cen-en16931/test/Invoice-unit-UBL/BR-S-08-1.xml`` / ``-3.xml``),
asserting the engine's BR-S-08 verdict matches each embedded test's
official ``<success>``/``<error>`` expectation.

Standard library only. Run: python3 test_br_s08.py
"""

from __future__ import annotations

import os
import sys
import unittest
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice import parser, parser_cii, rules   # noqa: E402

NS_INV = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
NS_CN = "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"
NS_DIFI = "http://difi.no/xsd/vefa/validator/1.0"

UNIT_UBL_DIR = os.path.join(
    HERE, "corpus", "cen-en16931", "test", "Invoice-unit-UBL")


# --------------------------------------------------------------------------- #
# Engine plumbing: run the FULL registered rule set (so the test also proves
# BR-S-08 is wired into ALL_RULES, not merely importable) and keep only the
# BR-S-08 violations. Minimal fixtures legitimately fire other rules (missing
# seller etc.); those are irrelevant here.
# --------------------------------------------------------------------------- #
def _brs08_violations(inv):
    out = []
    for fn in rules.ALL_RULES:
        v = fn(inv)
        if v is not None and v.rule_id == "BR-S-08":
            out.append(v)
    return out


def _ubl_model(xml_text):
    return parser.build_model(ET.fromstring(xml_text))


def _cii_model(xml_text):
    return parser_cii.build_model(ET.fromstring(xml_text))


# --------------------------------------------------------------------------- #
# Minimal UBL fixture builders (Invoice + CreditNote).
# --------------------------------------------------------------------------- #
def _ubl_subtotal(taxable, percent):
    return (
        "<cac:TaxSubtotal>"
        '<cbc:TaxableAmount currencyID="EUR">%s</cbc:TaxableAmount>'
        '<cbc:TaxAmount currencyID="EUR">0.00</cbc:TaxAmount>'
        "<cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>%s</cbc:Percent>"
        "<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>"
        "</cac:TaxCategory></cac:TaxSubtotal>" % (taxable, percent))


def _ubl_line(tag, amount, percent):
    return (
        "<cac:%(tag)s>"
        '<cbc:LineExtensionAmount currencyID="EUR">%(amount)s'
        "</cbc:LineExtensionAmount>"
        "<cac:Item><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID>"
        "<cbc:Percent>%(percent)s</cbc:Percent>"
        "<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>"
        "</cac:ClassifiedTaxCategory></cac:Item>"
        "</cac:%(tag)s>" % {"tag": tag, "amount": amount, "percent": percent})


def _ubl_ac(is_charge, amount, percent):
    return (
        "<cac:AllowanceCharge>"
        "<cbc:ChargeIndicator>%s</cbc:ChargeIndicator>"
        '<cbc:Amount currencyID="EUR">%s</cbc:Amount>'
        "<cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>%s</cbc:Percent>"
        "<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>"
        "</cac:TaxCategory></cac:AllowanceCharge>"
        % ("true" if is_charge else "false", amount, percent))


def _ubl_doc(subtotals, lines, acs=(), creditnote=False):
    """A minimal UBL Invoice/CreditNote: exactly the elements BR-S-08 reads
    (the official CEN unit vectors for this rule are equally minimal)."""
    ns = NS_CN if creditnote else NS_INV
    root = "CreditNote" if creditnote else "Invoice"
    line_tag = "CreditNoteLine" if creditnote else "InvoiceLine"
    return (
        '<%(root)s xmlns="%(ns)s" '
        'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:'
        'CommonAggregateComponents-2" '
        'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:'
        'CommonBasicComponents-2">'
        "%(acs)s<cac:TaxTotal>%(subtotals)s</cac:TaxTotal>%(lines)s"
        "</%(root)s>"
        % {"root": root, "ns": ns, "acs": "".join(acs),
           "subtotals": "".join(subtotals),
           "lines": "".join(_ubl_line(line_tag, a, p) for a, p in lines)})


# --------------------------------------------------------------------------- #
# Minimal CII fixture builder.
# --------------------------------------------------------------------------- #
def _cii_line(amount, percent):
    return (
        "<ram:IncludedSupplyChainTradeLineItem>"
        "<ram:SpecifiedLineTradeSettlement>"
        "<ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode>"
        "<ram:CategoryCode>S</ram:CategoryCode>"
        "<ram:RateApplicablePercent>%s</ram:RateApplicablePercent>"
        "</ram:ApplicableTradeTax>"
        "<ram:SpecifiedTradeSettlementLineMonetarySummation>"
        "<ram:LineTotalAmount>%s</ram:LineTotalAmount>"
        "</ram:SpecifiedTradeSettlementLineMonetarySummation>"
        "</ram:SpecifiedLineTradeSettlement>"
        "</ram:IncludedSupplyChainTradeLineItem>" % (percent, amount))


def _cii_ac(is_charge, amount, percent):
    return (
        "<ram:SpecifiedTradeAllowanceCharge>"
        "<ram:ChargeIndicator><udt:Indicator>%s</udt:Indicator>"
        "</ram:ChargeIndicator>"
        "<ram:ActualAmount>%s</ram:ActualAmount>"
        "<ram:CategoryTradeTax><ram:TypeCode>VAT</ram:TypeCode>"
        "<ram:CategoryCode>S</ram:CategoryCode>"
        "<ram:RateApplicablePercent>%s</ram:RateApplicablePercent>"
        "</ram:CategoryTradeTax>"
        "</ram:SpecifiedTradeAllowanceCharge>"
        % ("true" if is_charge else "false", amount, percent))


def _cii_breakdown(basis, percent):
    return (
        "<ram:ApplicableTradeTax>"
        "<ram:CalculatedAmount>0.00</ram:CalculatedAmount>"
        "<ram:TypeCode>VAT</ram:TypeCode>"
        "<ram:BasisAmount>%s</ram:BasisAmount>"
        "<ram:CategoryCode>S</ram:CategoryCode>"
        "<ram:RateApplicablePercent>%s</ram:RateApplicablePercent>"
        "</ram:ApplicableTradeTax>" % (basis, percent))


def _cii_doc(breakdowns, lines, acs=()):
    return (
        '<rsm:CrossIndustryInvoice '
        'xmlns:rsm="urn:un:unece:uncefact:data:standard:'
        'CrossIndustryInvoice:100" '
        'xmlns:ram="urn:un:unece:uncefact:data:standard:'
        'ReusableAggregateBusinessInformationEntity:100" '
        'xmlns:udt="urn:un:unece:uncefact:data:standard:'
        'UnqualifiedDataType:100">'
        "<rsm:SupplyChainTradeTransaction>"
        "%(lines)s"
        "<ram:ApplicableHeaderTradeSettlement>"
        "%(acs)s%(breakdowns)s"
        "</ram:ApplicableHeaderTradeSettlement>"
        "</rsm:SupplyChainTradeTransaction>"
        "</rsm:CrossIndustryInvoice>"
        % {"lines": "".join(_cii_line(a, p) for a, p in lines),
           "acs": "".join(acs),
           "breakdowns": "".join(breakdowns)})


# --------------------------------------------------------------------------- #
# In-file unit fixtures (the S/Z/E precedent — no new corpus files).
# --------------------------------------------------------------------------- #
class UblInvoiceCases(unittest.TestCase):

    def test_registered_in_all_rules(self):
        self.assertIn(rules.br_s_08, rules.ALL_RULES,
                      "br_s_08 must be wired into rules.ALL_RULES")

    def test_positive_multi_rate_consistent(self):
        """Two distinct S rates (19% and 7%), each breakdown row equal to its
        own rate bucket -> no BR-S-08 finding."""
        doc = _ubl_doc(
            [_ubl_subtotal("100.00", "19"), _ubl_subtotal("50.00", "7")],
            [("100.00", "19"), ("50.00", "7")])
        self.assertEqual([], _brs08_violations(_ubl_model(doc)))

    def test_negative_single_rate_beyond_tolerance(self):
        """|BT-116 - bucket sum| = 2, outside the artifact's strict ±1 band
        -> fires."""
        doc = _ubl_doc([_ubl_subtotal("102.00", "19")], [("100.00", "19")])
        vs = _brs08_violations(_ubl_model(doc))
        self.assertEqual(1, len(vs))
        self.assertEqual("fatal", vs[0].severity)

    def test_tolerance_band_is_the_artifacts_strict_plus_minus_one(self):
        """The UBL artifact tests ``TaxableAmount - 1 < sum and
        TaxableAmount + 1 > sum``: an 0.99 offset is INSIDE the band (holds),
        an exact 1.00 offset is NOT strictly inside (fires)."""
        inside = _ubl_doc([_ubl_subtotal("100.99", "19")], [("100.00", "19")])
        self.assertEqual([], _brs08_violations(_ubl_model(inside)))
        boundary = _ubl_doc([_ubl_subtotal("101.00", "19")],
                            [("100.00", "19")])
        self.assertEqual(1, len(_brs08_violations(_ubl_model(boundary))))

    def test_negative_multi_rate_only_one_group_inconsistent(self):
        """19% bucket consistent, 7% bucket off by 10 -> exactly one BR-S-08
        naming the 7% rate group (and not the healthy 19% one)."""
        doc = _ubl_doc(
            [_ubl_subtotal("100.00", "19"), _ubl_subtotal("60.00", "7")],
            [("100.00", "19"), ("50.00", "7")])
        vs = _brs08_violations(_ubl_model(doc))
        self.assertEqual(1, len(vs))
        self.assertIn("(BT-119=7)", vs[0].message)
        self.assertNotIn("(BT-119=19)", vs[0].message)

    def test_allowance_and_charge_join_their_rate_bucket(self):
        """Line 100 + document charge 20 - document allowance 5, all S/19%:
        BT-116=115 holds, BT-116=100 (the line alone) fires."""
        acs = [_ubl_ac(True, "20.00", "19"), _ubl_ac(False, "5.00", "19")]
        good = _ubl_doc([_ubl_subtotal("115.00", "19")],
                        [("100.00", "19")], acs)
        self.assertEqual([], _brs08_violations(_ubl_model(good)))
        bad = _ubl_doc([_ubl_subtotal("100.00", "19")],
                       [("100.00", "19")], acs)
        self.assertEqual(1, len(_brs08_violations(_ubl_model(bad))))

    def test_orphan_rate_group_fires_the_exists_gate(self):
        """The artifact's band is gated on ``exists()`` of an S/$rate line OR
        an S/$rate AllowanceCharge: an S breakdown row whose rate matches
        NEITHER fires even when the empty-bucket arithmetic (0 = 0) would
        hold."""
        doc = _ubl_doc(
            [_ubl_subtotal("100.00", "19"), _ubl_subtotal("0.00", "7")],
            [("100.00", "19")])
        self.assertEqual(1, len(_brs08_violations(_ubl_model(doc))))


class UblCreditNoteCases(unittest.TestCase):

    def test_creditnote_consistent_holds(self):
        doc = _ubl_doc([_ubl_subtotal("200.00", "19")], [("200.00", "19")],
                       creditnote=True)
        self.assertEqual([], _brs08_violations(_ubl_model(doc)))

    def test_creditnote_mismatch_fires(self):
        """The artifact's CreditNote arm sums cac:CreditNoteLine nets: a
        breakdown 50 off its only CN line bucket fires."""
        doc = _ubl_doc([_ubl_subtotal("150.00", "19")], [("200.00", "19")],
                       creditnote=True)
        vs = _brs08_violations(_ubl_model(doc))
        self.assertEqual(1, len(vs))
        self.assertEqual("fatal", vs[0].severity)


class CiiCases(unittest.TestCase):

    def test_cii_consistent_holds(self):
        doc = _cii_doc([_cii_breakdown("100.00", "19")], [("100.00", "19")])
        self.assertEqual([], _brs08_violations(_cii_model(doc)))

    def test_cii_equality_is_exact_no_tolerance_band(self):
        """The CII binding is EXACT per-bucket round2 equality — a 0.50
        offset that the UBL ±1 band would tolerate fires on CII."""
        doc = _cii_doc([_cii_breakdown("100.50", "19")], [("100.00", "19")])
        vs = _brs08_violations(_cii_model(doc))
        self.assertEqual(1, len(vs))
        self.assertEqual("fatal", vs[0].severity)

    def test_cii_allowance_and_charge_join_their_rate_bucket(self):
        """Line 100 + header charge 10 - header allowance 5 (all S/19%):
        BasisAmount 105 holds exactly, 105.50 fires."""
        acs = [_cii_ac(True, "10.00", "19"), _cii_ac(False, "5.00", "19")]
        good = _cii_doc([_cii_breakdown("105.00", "19")],
                        [("100.00", "19")], acs)
        self.assertEqual([], _brs08_violations(_cii_model(good)))
        bad = _cii_doc([_cii_breakdown("105.50", "19")],
                       [("100.00", "19")], acs)
        self.assertEqual(1, len(_brs08_violations(_cii_model(bad))))


# --------------------------------------------------------------------------- #
# The two official vendored CEN unit vectors, verdict-checked case by case.
# --------------------------------------------------------------------------- #
def _official_cases(name):
    """[(case_label, invoice_element, must_fire), ...] from a CEN difi
    <testSet> file: each <test> embeds one standalone Invoice plus its
    official expectation — <success>BR-S-08</success> (must NOT fire) or
    <error>BR-S-08</error> (must fire)."""
    path = os.path.join(UNIT_UBL_DIR, name)
    root = ET.parse(path).getroot()
    cases = []
    for idx, test in enumerate(root.iter("{%s}test" % NS_DIFI)):
        succ = [el.text.strip() for el in
                test.iter("{%s}success" % NS_DIFI) if el.text]
        errs = [el.text.strip() for el in
                test.iter("{%s}error" % NS_DIFI) if el.text]
        inner = None
        for el in test:
            if el.tag == "{%s}Invoice" % NS_INV or el.tag.endswith("}Invoice"):
                inner = el
                break
        if inner is None:
            continue
        if "BR-S-08" in errs:
            must_fire = True
        elif "BR-S-08" in succ:
            must_fire = False
        else:
            continue   # a case graded for some other rule only
        cases.append(("%s#t%d" % (name, idx), inner, must_fire))
    return cases


class OfficialUnitFixtures(unittest.TestCase):
    """The engine's BR-S-08 verdict must match the official expectation on
    EVERY embedded case of the two vendored CEN unit-test files."""

    def _run(self, name, min_success, min_error):
        cases = _official_cases(name)
        n_fire = sum(1 for _, _, mf in cases if mf)
        n_pass = len(cases) - n_fire
        self.assertGreaterEqual(
            n_pass, min_success,
            "%s lost its success cases — fixture drift?" % name)
        self.assertGreaterEqual(
            n_fire, min_error,
            "%s lost its error cases — fixture drift?" % name)
        for label, inner, must_fire in cases:
            fired = bool(_brs08_violations(parser.build_model(inner)))
            self.assertEqual(
                must_fire, fired,
                "%s: official expectation %s but engine BR-S-08 %s"
                % (label,
                   "ERROR (fire)" if must_fire else "SUCCESS (no fire)",
                   "fired" if fired else "did not fire"))

    def test_br_s_08_1(self):
        self._run("BR-S-08-1.xml", min_success=4, min_error=2)

    def test_br_s_08_3(self):
        self._run("BR-S-08-3.xml", min_success=3, min_error=2)


if __name__ == "__main__":
    unittest.main(verbosity=1)

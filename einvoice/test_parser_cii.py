"""Unit tests for the CII (CrossIndustryInvoice) parser.

Standard-library ``unittest`` only. No saxonche, no network, no pip. Parses
vendored CII examples from the EN 16931 conformance corpus and asserts the
extracted core business terms match the values ACTUALLY present in each file
(verified by reading the XML, not guessed), plus that absent optional fields
come back as ``None`` rather than raising.

Runs in well under a second.
"""

import os
import unittest

from einvoice import parser_cii

HERE = os.path.dirname(os.path.abspath(__file__))
CII_DIR = os.path.join(HERE, "corpus", "cen-en16931", "cii", "examples")

EXAMPLE1 = os.path.join(CII_DIR, "CII_example1.xml")
EXAMPLE3 = os.path.join(CII_DIR, "CII_example3.xml")


class TestParserCIINamespaces(unittest.TestCase):
    def test_namespaces_match_spec(self):
        self.assertEqual(
            parser_cii.NS_RSM,
            "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100")
        self.assertEqual(
            parser_cii.NS_RAM,
            "urn:un:unece:uncefact:data:standard:"
            "ReusableAggregateBusinessInformationEntity:100")
        self.assertEqual(
            parser_cii.NS_UDT,
            "urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100")


class TestParserCIIExample1(unittest.TestCase):
    """CII_example1.xml — a 20-line Dutch grocery invoice (BR-DEC clean)."""

    @classmethod
    def setUpClass(cls):
        cls.inv = parser_cii.parse(EXAMPLE1)

    def test_root_recognized(self):
        self.assertTrue(self.inv.root_is_cii_invoice)

    def test_header_core_bts(self):
        inv = self.inv
        self.assertEqual(inv.id, "12115118")                 # BT-1
        self.assertEqual(inv.issue_date, "20150109")         # BT-2
        self.assertEqual(inv.invoice_type_code, "380")       # BT-3
        self.assertEqual(inv.document_currency_code, "EUR")  # BT-5

    def test_parties(self):
        inv = self.inv
        self.assertEqual(inv.seller_name, "De Koksmaat")     # BT-27
        self.assertEqual(inv.seller_country_code, "NL")      # BT-40
        self.assertEqual(inv.buyer_name, "ODIN 59")          # BT-44
        self.assertEqual(inv.buyer_country_code, "NL")       # BT-55

    def test_header_totals(self):
        inv = self.inv
        self.assertTrue(inv.has_header_monetary_summation)
        self.assertEqual(inv.line_extension_total, "229.6")   # BT-106
        self.assertEqual(inv.tax_exclusive_amount, "229.6")   # BT-109
        self.assertEqual(inv.tax_total_amount, "20.73")       # BT-110
        self.assertEqual(inv.tax_total_amount_currency, "EUR")
        self.assertEqual(inv.tax_inclusive_amount, "250.33")  # BT-112
        self.assertEqual(inv.payable_amount, "250.33")        # BT-115

    def test_absent_optional_fields_are_none(self):
        inv = self.inv
        # None of these optional elements exist in example 1 -> None, no raise.
        self.assertIsNone(inv.buyer_reference)          # BT-10 absent
        self.assertIsNone(inv.allowance_total)          # BT-107 absent
        self.assertIsNone(inv.charge_total)             # BT-108 absent
        self.assertIsNone(inv.prepaid_amount)           # BT-113 absent
        self.assertIsNone(inv.payable_rounding_amount)  # BT-114 absent

    def test_lines(self):
        inv = self.inv
        # 20 lines, in document order, with their LineID and line net amount
        # exactly as they appear in the file.
        expected = [
            ("1", "19.9"), ("2", "9.85"), ("3", "8.29"), ("4", "14.46"),
            ("5", "35"), ("6", "35"), ("7", "10.65"), ("8", "1.55"),
            ("9", "14.37"), ("10", "8.29"), ("11", "16.58"), ("12", "9.95"),
            ("13", "3.3"), ("14", "10.8"), ("15", "3.9"), ("16", "7.6"),
            ("17", "9.34"), ("18", "18.63"), ("19", "102.12"),
            ("20", "-109.98"),
        ]
        self.assertEqual(len(inv.lines), len(expected))
        actual = [(ln.id, ln.line_extension_amount) for ln in inv.lines]
        self.assertEqual(actual, expected)


class TestParserCIIExample3(unittest.TestCase):
    """CII_example3.xml — a single-line Danish subscription invoice."""

    @classmethod
    def setUpClass(cls):
        cls.inv = parser_cii.parse(EXAMPLE3)

    def test_header_core_bts(self):
        inv = self.inv
        self.assertEqual(inv.id, "TOSL108")                  # BT-1
        self.assertEqual(inv.issue_date, "20130410")         # BT-2
        self.assertEqual(inv.invoice_type_code, "380")       # BT-3
        self.assertEqual(inv.document_currency_code, "DKK")  # BT-5

    def test_parties(self):
        inv = self.inv
        self.assertEqual(inv.seller_name, "SubscriptionSeller")  # BT-27
        self.assertEqual(inv.seller_country_code, "DK")          # BT-40
        self.assertEqual(inv.buyer_name, "Buyercompany ltd")     # BT-44
        self.assertEqual(inv.buyer_country_code, "DK")           # BT-55

    def test_header_totals(self):
        inv = self.inv
        self.assertEqual(inv.line_extension_total, "800")    # BT-106
        self.assertEqual(inv.charge_total, "100")            # BT-108 present
        self.assertEqual(inv.tax_exclusive_amount, "900")    # BT-109
        self.assertEqual(inv.tax_total_amount, "225")        # BT-110
        self.assertEqual(inv.tax_total_amount_currency, "DKK")
        self.assertEqual(inv.tax_inclusive_amount, "1125")   # BT-112
        self.assertEqual(inv.payable_amount, "1125")         # BT-115

    def test_absent_optional_fields_are_none(self):
        inv = self.inv
        # example 3 has a ChargeTotalAmount but NO allowance/prepaid/rounding.
        self.assertIsNone(inv.buyer_reference)          # BT-10 absent
        self.assertIsNone(inv.allowance_total)          # BT-107 absent
        self.assertIsNone(inv.prepaid_amount)           # BT-113 absent
        self.assertIsNone(inv.payable_rounding_amount)  # BT-114 absent

    def test_single_line(self):
        inv = self.inv
        self.assertEqual(len(inv.lines), 1)
        self.assertEqual(inv.lines[0].id, "1")               # BT-126
        self.assertEqual(inv.lines[0].line_extension_amount, "800")  # BT-131


class TestParserCIIMissingElements(unittest.TestCase):
    """A minimal well-formed CII with no children -> all fields None, no raise."""

    def test_empty_invoice_returns_none(self):
        import xml.etree.ElementTree as ET
        root = ET.fromstring(
            '<rsm:CrossIndustryInvoice '
            'xmlns:rsm="%s"/>' % parser_cii.NS_RSM)
        inv = parser_cii.build_model(root)
        self.assertTrue(inv.root_is_cii_invoice)
        self.assertIsNone(inv.id)
        self.assertIsNone(inv.issue_date)
        self.assertIsNone(inv.document_currency_code)
        self.assertIsNone(inv.seller_name)
        self.assertIsNone(inv.buyer_country_code)
        self.assertIsNone(inv.tax_inclusive_amount)
        self.assertFalse(inv.has_header_monetary_summation)
        self.assertEqual(inv.lines, [])


if __name__ == "__main__":
    unittest.main()

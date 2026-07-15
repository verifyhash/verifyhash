#!/usr/bin/env python3
"""test_report_location.py — prove the optional `source_line` attribution.

Task T-VHDIAG.1: an attributable FIELD-LEVEL violation must carry the correct
1-based parser line of its offending element, while a DOCUMENT-LEVEL / absence
violation must carry no source line at all — and the enriched report must still
validate against the committed report.schema.json.

Fast, stdlib-only, saxonche-free, offline. Fixtures are synthesized inline (no
real company data). The expected line number is computed from the fixture text,
never hard-coded, so the assertion cannot silently drift.
"""

import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.report import build_report                     # noqa: E402
from einvoice.validate import validate_file                  # noqa: E402
from test_report_schema import schema_errors, load_schema    # noqa: E402


# A minimal UBL Invoice whose DocumentCurrencyCode (BT-5) is PRESENT but not a
# valid ISO 4217 code -> fires the field-level BR-CL-04, which holds the concrete
# element and can attribute its line. It has NO invoice line -> fires the
# document-level BR-16 ("An Invoice shall have at least one Invoice line"), which
# is an absence rule and must carry NO source line. Each element sits on its own
# line so the expected line number is unambiguous. "ZZ" is deliberately not a
# real currency code.
INVALID_UBL = (
    '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"\n'
    '         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:'
    'CommonBasicComponents-2"\n'
    '         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:'
    'CommonAggregateComponents-2">\n'
    '  <cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID>\n'
    '  <cbc:ID>INV-LOC-1</cbc:ID>\n'
    '  <cbc:IssueDate>2026-01-01</cbc:IssueDate>\n'
    '  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>\n'
    '  <cbc:DocumentCurrencyCode>ZZ</cbc:DocumentCurrencyCode>\n'
    '</Invoice>\n'
)


def _expected_line(xml_text, needle):
    """The 1-based line of the first line containing ``needle`` (expat's
    CurrentLineNumber for a start tag is the line the tag opens on)."""
    for i, line in enumerate(xml_text.splitlines(), start=1):
        if needle in line:
            return i
    raise AssertionError("needle %r not found in fixture" % needle)


class SourceLineOnFieldLevelViolation(unittest.TestCase):
    def _report(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "invalid.xml")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(INVALID_UBL)
            return build_report(path, profile="en16931")

    def test_field_level_violation_carries_correct_source_line(self):
        report = self._report()
        by_rule = {v["rule"]: v for v in report["violations"]}
        self.assertIn("BR-CL-04", by_rule,
                      "expected the invalid-currency rule to fire: %s"
                      % list(by_rule))
        rec = by_rule["BR-CL-04"]
        self.assertIn("source_line", rec,
                      "an attributable field-level violation must carry "
                      "source_line: %s" % rec)
        self.assertIsInstance(rec["source_line"], int)
        self.assertNotIsInstance(rec["source_line"], bool)
        expected = _expected_line(INVALID_UBL, "<cbc:DocumentCurrencyCode>")
        self.assertEqual(rec["source_line"], expected,
                         "source_line must be the real line of the element")

    def test_document_level_violation_has_no_source_line(self):
        report = self._report()
        by_rule = {v["rule"]: v for v in report["violations"]}
        self.assertIn("BR-16", by_rule,
                      "expected the no-invoice-line rule to fire: %s"
                      % list(by_rule))
        rec = by_rule["BR-16"]
        # Absence / document-level rule: the key is omitted entirely (or null),
        # never a guessed line.
        self.assertIsNone(rec.get("source_line"),
                          "a document-level/absence violation must not carry a "
                          "source line: %s" % rec)
        self.assertNotIn("source_line", rec, rec)

    def test_enriched_report_still_schema_validates(self):
        report = self._report()
        errors = schema_errors(report, load_schema())
        self.assertEqual(errors, [],
                         "report carrying source_line must still validate:\n%s"
                         % "\n".join(errors))


class SourceLineOnHumanJson(unittest.TestCase):
    """The same optional key must surface on the `einvoice validate --json`
    per-violation projection (validate.Result.to_dict)."""

    def _to_dict(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "invalid.xml")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(INVALID_UBL)
            return validate_file(path, profile="en16931").to_dict(source=path)

    def test_json_field_level_has_line_document_level_does_not(self):
        d = self._to_dict()
        by_rule = {v["rule"]: v for v in d["violations"]}
        self.assertIn("BR-CL-04", by_rule, by_rule)
        self.assertIn("BR-16", by_rule, by_rule)
        expected = _expected_line(INVALID_UBL, "<cbc:DocumentCurrencyCode>")
        self.assertEqual(by_rule["BR-CL-04"].get("source_line"), expected,
                         by_rule["BR-CL-04"])
        self.assertNotIn("source_line", by_rule["BR-16"], by_rule["BR-16"])


if __name__ == "__main__":
    unittest.main()

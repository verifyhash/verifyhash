#!/usr/bin/env python3
"""test_api_example.py — execute the documented library embedding contract.

Task T-VHAPI.1: API.md ("Embed einvoice as a library") pins a small, stable
Python embedding API — exactly five public names (``validate``,
``validate_file``, ``validate_root``, ``Result``, ``NotWellFormed``) with a
documented ``Result`` shape (``.valid`` + ``.violations``). This test runs the
EXACT end-to-end example from API.md so the doc cannot silently drift from the
code, and guards the public surface as a back-compat contract.

Fast, stdlib-only, saxonche-free, offline. Reuses the same known-good corpus
invoice the report/xrechnung gates use — no new invoice bodies are invented.
"""

import io
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import einvoice  # noqa: E402

# The exact fixture the API.md example opens (a real, known-good EN 16931 UBL
# invoice from the project corpus). The other fast gates use this same file.
GOOD = os.path.join(
    HERE, "corpus", "xrechnung-testsuite", "src", "test", "business-cases",
    "standard", "01.01a-INVOICE_ubl.xml")

# The five names that make up the documented, supported public API.
PUBLIC_API = ("validate", "validate_file", "validate_root", "Result",
              "NotWellFormed")


class DocumentedExample(unittest.TestCase):
    """Run the runnable snippet from API.md end-to-end, valid + broken + bad."""

    def test_valid_invoice_bytes_to_result(self):
        # --- verbatim from API.md: bytes payload -> Result -> .valid/.violations
        with open(GOOD, "rb") as fh:
            payload = fh.read()          # -> bytes
        result = einvoice.validate_file(io.BytesIO(payload), profile="en16931")
        # A clean EN 16931 invoice: valid, no violations.
        self.assertIsInstance(result, einvoice.Result)
        self.assertIs(result.valid, True)
        self.assertEqual(list(result.violations), [])
        # .ok is the documented back-compat alias of .valid.
        self.assertEqual(result.ok, result.valid)
        # .violations is iterable; iterating a clean result yields nothing.
        for _v in result.violations:  # pragma: no cover - empty on clean input
            self.fail("clean invoice should have no violations")

    def test_broken_invoice_bytes_to_result(self):
        # --- verbatim from API.md: break the invoice number (BT-1) -> BR-02.
        with open(GOOD, "rb") as fh:
            payload = fh.read()
        broken = payload.replace(b"<cbc:ID>", b"<cbc:XX>", 1).replace(
            b"</cbc:ID>", b"</cbc:XX>", 1)
        self.assertNotEqual(broken, payload, "fixture drift: no <cbc:ID> found")
        result = einvoice.validate_file(io.BytesIO(broken), profile="en16931")
        self.assertIs(result.valid, False)
        self.assertGreaterEqual(len(result.violations), 1)
        self.assertTrue(any(v.rule_id == "BR-02" for v in result.violations),
                        [v.rule_id for v in result.violations])
        # Each violation exposes the documented Violation fields.
        for v in result.violations:
            self.assertTrue(v.rule_id)
            self.assertIn(v.severity, ("fatal", "warning", "information"))
            self.assertTrue(hasattr(v, "message"))
            self.assertTrue(hasattr(v, "element"))
            self.assertTrue(hasattr(v, "source_line"))  # optional, may be None

    def test_malformed_bytes_raise_not_well_formed(self):
        # --- verbatim from API.md: malformed XML -> NotWellFormed.
        with self.assertRaises(einvoice.NotWellFormed):
            einvoice.validate_file(io.BytesIO(b"<Invoice><broken"))


class PublicApiContract(unittest.TestCase):
    """Back-compat guard: the documented names are importable and pinned."""

    def test_all_public_names_importable(self):
        for name in PUBLIC_API:
            self.assertTrue(hasattr(einvoice, name),
                            "einvoice.%s must be importable" % name)

    def test_all_lists_exactly_the_public_api(self):
        self.assertEqual(set(einvoice.__all__), set(PUBLIC_API), einvoice.__all__)
        # No duplicates / stray entries.
        self.assertEqual(len(einvoice.__all__), len(PUBLIC_API), einvoice.__all__)

    def test_every_public_name_is_documented(self):
        for name in PUBLIC_API:
            doc = getattr(einvoice, name).__doc__
            self.assertTrue(doc and doc.strip(),
                            "einvoice.%s needs a non-empty docstring" % name)


if __name__ == "__main__":
    unittest.main()

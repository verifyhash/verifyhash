"""test_pdf_container.py — prove the Factur-X/ZUGFeRD PDF-container extraction.

Fast, stdlib-only, saxonche-free, offline. Exercises
:mod:`einvoice.pdf_container` (the zero-dependency embedded-XML extractor) and
its wiring into :mod:`einvoice.report`, against tiny committed PDF fixtures that
wrap EXISTING corpus CrossIndustryInvoice invoices.

What is asserted (mirrors the task acceptance criteria):

  1. import einvoice.pdf_container works and extracts the embedded XML bytes
     byte-for-byte (both /FlateDecode and unfiltered streams).
  2. `python3 -m einvoice.report <valid-facturx.pdf>` exits 0 and its fired
     rule ids EQUAL validating the embedded CII XML directly through the CII
     engine (parser_cii + rules.ALL_RULES + rules_xrechnung.evaluate_cii).
  3. `python3 -m einvoice.report <bad-facturx.pdf>` exits non-zero (1) with the
     SAME fatal CII rule findings as validating its inner XML directly.
  4. An unsupported PDF (no /EmbeddedFiles, or /Encrypt) yields an explicit
     'unsupported-container' non-pass report (valid=false + message), never a
     traceback and never exit 0.
  5. The committed fixtures are byte-reproducible from the stdlib generator.

Run: python3 test_pdf_container.py
"""

import importlib
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from einvoice import pdf_container  # noqa: E402
from einvoice import report  # noqa: E402
from einvoice import parser_cii, rules, rules_xrechnung  # noqa: E402
from einvoice.validate import _severity  # noqa: E402

PDF_DIR = os.path.join(HERE, "corpus", "pdf")
CII_DIR = os.path.join(HERE, "corpus", "cen-en16931", "cii", "examples")

VALID_PDF = os.path.join(PDF_DIR, "facturx-valid.pdf")
VALID_PDF_RAW = os.path.join(PDF_DIR, "facturx-valid-uncompressed.pdf")
BAD_PDF = os.path.join(PDF_DIR, "facturx-bad.pdf")
NO_EMBED_PDF = os.path.join(PDF_DIR, "no-embedded.pdf")
ENCRYPTED_PDF = os.path.join(PDF_DIR, "encrypted.pdf")

VALID_INNER_XML = os.path.join(CII_DIR, "CII_example5.xml")
BAD_INNER_XML = os.path.join(CII_DIR, "CII_example6.xml")


def _read(path):
    with open(path, "rb") as fh:
        return fh.read()


def _direct_cii_fired(xml_path, profile):
    """Fired ``(rule_id, severity)`` pairs of validating a CII XML DIRECTLY
    through the shipped CII engine — the reference the PDF path must match."""
    root = parser_cii.parse_file(xml_path)
    inv = parser_cii.build_model(root)
    violations = [v for v in (fn(inv) for fn in rules.ALL_RULES) if v is not None]
    if profile == "xrechnung":
        violations.extend(rules_xrechnung.evaluate_cii(inv))
    return sorted({(v.rule_id, _severity(v)) for v in violations})


def _report_fired(report_dict):
    return sorted({(v["rule"], v["severity"])
                   for v in report_dict.get("violations", [])})


def _run_cli(*args):
    proc = subprocess.run(
        [sys.executable, "-m", "einvoice.report", *args],
        cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return proc.returncode, proc.stdout.decode(), proc.stderr.decode()


class TestImportable(unittest.TestCase):
    def test_module_importable(self):
        mod = importlib.import_module("einvoice.pdf_container")
        self.assertTrue(hasattr(mod, "extract_invoice_xml"))
        self.assertTrue(hasattr(mod, "UnsupportedContainer"))


class TestExtraction(unittest.TestCase):
    def test_magic_detection_reads_bytes_not_extension(self):
        self.assertTrue(pdf_container.is_pdf_file(VALID_PDF))
        # An XML corpus file is not a PDF even though it is a real file.
        self.assertFalse(pdf_container.is_pdf_file(VALID_INNER_XML))

    def test_flate_roundtrip_is_byte_exact(self):
        got = pdf_container.extract_invoice_xml(VALID_PDF)
        self.assertEqual(got, _read(VALID_INNER_XML))

    def test_unfiltered_stream_roundtrip(self):
        got = pdf_container.extract_invoice_xml(VALID_PDF_RAW)
        self.assertEqual(got, _read(VALID_INNER_XML))

    def test_extracted_xml_is_a_cross_industry_invoice(self):
        xml = pdf_container.extract_invoice_xml(BAD_PDF)
        self.assertIn(b"CrossIndustryInvoice", xml)

    def test_no_embedded_files_is_unsupported(self):
        with self.assertRaises(pdf_container.UnsupportedContainer):
            pdf_container.extract_invoice_xml(NO_EMBED_PDF)

    def test_encrypted_is_unsupported(self):
        with self.assertRaises(pdf_container.UnsupportedContainer) as cm:
            pdf_container.extract_invoice_xml(ENCRYPTED_PDF)
        self.assertIn("encrypt", str(cm.exception).lower())

    def test_non_pdf_bytes_is_unsupported(self):
        with self.assertRaises(pdf_container.UnsupportedContainer):
            pdf_container.extract_invoice_xml_from_bytes(b"<xml/>not a pdf")


class TestReportWiringValid(unittest.TestCase):
    def test_valid_pdf_passes_and_matches_direct_xml(self):
        for profile in ("xrechnung", "en16931"):
            rep = report.build_report(VALID_PDF, profile=profile)
            self.assertNotIn("error", rep,
                             "valid PDF must not be an unsupported container")
            self.assertTrue(rep["valid"], (profile, rep))
            self.assertEqual(rep["fatal_count"], 0)
            self.assertEqual(_report_fired(rep),
                             _direct_cii_fired(VALID_INNER_XML, profile),
                             "PDF fired ids must equal validating inner XML "
                             "directly (%s)" % profile)

    def test_valid_pdf_cli_exits_zero(self):
        code, out, err = _run_cli(VALID_PDF)
        self.assertEqual(code, 0, err)
        self.assertIn('"valid":true', out)


class TestReportWiringBad(unittest.TestCase):
    def test_bad_pdf_has_fatal_findings_from_cii_engine(self):
        rep = report.build_report(BAD_PDF, profile="xrechnung")
        self.assertNotIn("error", rep)
        self.assertFalse(rep["valid"])
        self.assertGreater(rep["fatal_count"], 0)
        # Same rule findings as validating the embedded XML directly.
        self.assertEqual(_report_fired(rep),
                         _direct_cii_fired(BAD_INNER_XML, "xrechnung"))
        # The fatals are real CII BR-DE rules, not a generic S-ROOT bailout.
        fatal_rules = {v["rule"] for v in rep["violations"]
                       if v["severity"] == "fatal"}
        self.assertNotIn("S-ROOT", fatal_rules)
        self.assertTrue(any(r.startswith("BR-DE-") for r in fatal_rules),
                        fatal_rules)

    def test_bad_pdf_cli_exits_one(self):
        code, out, err = _run_cli(BAD_PDF)
        self.assertEqual(code, 1, err)
        self.assertIn('"valid":false', out)


class TestReportWiringUnsupported(unittest.TestCase):
    def test_no_embedded_is_explicit_non_pass(self):
        rep = report.build_report(NO_EMBED_PDF, profile="xrechnung")
        self.assertFalse(rep["valid"])
        self.assertEqual(rep["error"], "unsupported-container")
        self.assertIn("unsupported container", rep["message"].lower())
        self.assertEqual(rep["violations"], [])

    def test_encrypted_is_explicit_non_pass(self):
        rep = report.build_report(ENCRYPTED_PDF, profile="xrechnung")
        self.assertFalse(rep["valid"])
        self.assertEqual(rep["error"], "unsupported-container")

    def test_unsupported_cli_never_exits_zero_never_crashes(self):
        for pdf in (NO_EMBED_PDF, ENCRYPTED_PDF):
            code, out, err = _run_cli(pdf)
            self.assertNotEqual(code, 0, (pdf, out))
            self.assertEqual(err, "", (pdf, err))  # no traceback on stderr
            self.assertIn("unsupported-container", out, (pdf, out))


class TestXmlPathUnchanged(unittest.TestCase):
    """The plain-XML path must behave EXACTLY as before (no CII dispatch): a
    raw CII XML file still reports as UBL S-ROOT, proving the PDF branch did
    not leak CII handling into the XML path."""

    def test_raw_cii_xml_still_reports_s_root(self):
        rep = report.build_report(VALID_INNER_XML, profile="en16931")
        rules_fired = {v["rule"] for v in rep["violations"]}
        self.assertIn("S-ROOT", rules_fired)


class TestFixturesReproducible(unittest.TestCase):
    def test_fixtures_are_byte_reproducible_from_generator(self):
        gen_path = os.path.join(PDF_DIR, "make_pdf_fixtures.py")
        spec = importlib.util.spec_from_file_location("_make_pdf_fixtures",
                                                      gen_path)
        gen = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gen)
        for name, builder in gen.FIXTURES.items():
            committed = _read(os.path.join(PDF_DIR, name))
            self.assertEqual(builder(), committed,
                             "%s drifted from its stdlib generator" % name)


if __name__ == "__main__":
    unittest.main(verbosity=2)

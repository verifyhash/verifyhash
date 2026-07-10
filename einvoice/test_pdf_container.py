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

# FX-CONTAINER-* mismatch fixtures (each forges exactly one container defect).
AFREL_BAD_PDF = os.path.join(PDF_DIR, "facturx-afrel-bad.pdf")
AF_MISSING_PDF = os.path.join(PDF_DIR, "facturx-af-missing.pdf")
XMP_MISSING_PDF = os.path.join(PDF_DIR, "facturx-xmp-missing.pdf")
XMP_MISMATCH_PDF = os.path.join(PDF_DIR, "facturx-xmp-mismatch.pdf")
# XMP present with a valid Factur-X profile but NO PDF/A-3 pdfaid identity.
PDFA3_MISSING_PDF = os.path.join(PDF_DIR, "facturx-pdfa3-missing.pdf")

# The matching container fixtures (no FX-CONTAINER-* finding expected).
MATCHING_PDFS = (VALID_PDF, VALID_PDF_RAW, BAD_PDF)

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


class TestContainerDeclarationChecks(unittest.TestCase):
    """FX-CONTAINER-* container-declaration checks (task T-VHP.2): each defect
    fixture fires its one stable finding; the matching fixtures fire none."""

    def _finding_ids(self, pdf_path):
        insp = pdf_container.inspect_container(pdf_path)
        return [f.rule_id for f in insp.findings]

    def test_matching_fixtures_have_no_container_findings(self):
        for pdf in MATCHING_PDFS:
            self.assertEqual(self._finding_ids(pdf), [], pdf)

    def test_afrelationship_defect_fires_only_its_id(self):
        self.assertEqual(self._finding_ids(AFREL_BAD_PDF),
                         ["FX-CONTAINER-AFRELATIONSHIP"])

    def test_af_array_defect_fires_only_its_id(self):
        self.assertEqual(self._finding_ids(AF_MISSING_PDF), ["FX-CONTAINER-AF"])

    def test_absent_xmp_is_explicit_finding_not_a_crash(self):
        # Absent XMP -> explicit non-pass finding, NEVER a traceback/false pass.
        self.assertEqual(self._finding_ids(XMP_MISSING_PDF), ["FX-CONTAINER-XMP"])

    def test_profile_mismatch_fires_only_its_id(self):
        self.assertEqual(self._finding_ids(XMP_MISMATCH_PDF),
                         ["FX-CONTAINER-PROFILE"])

    def test_pdfa3_missing_fires_exactly_the_two_pdfa3_ids(self):
        # XMP is PRESENT (valid Factur-X profile) but carries no pdfaid identity
        # schema -> exactly the two FX-PDFA3-* findings and nothing else. No
        # FX-CONTAINER-XMP (profile IS declared), no double-report.
        self.assertEqual(self._finding_ids(PDFA3_MISSING_PDF),
                         ["FX-PDFA3-PART", "FX-PDFA3-CONFORMANCE"])

    def test_matching_fixtures_have_no_pdfa3_finding(self):
        # The valid fixtures declare pdfaid:part=3 + pdfaid:conformance=B, so no
        # FX-PDFA3-* fires (keeps test_matching_fixtures_have_no_container...
        # green — they carry NO container finding at all).
        for pdf in MATCHING_PDFS:
            fx = [i for i in self._finding_ids(pdf) if i.startswith("FX-PDFA3-")]
            self.assertEqual(fx, [], pdf)

    def test_absent_xmp_does_not_double_report_pdfa3(self):
        # When the XMP stream is entirely absent, only FX-CONTAINER-XMP fires —
        # NOT also FX-PDFA3-* for the same root cause.
        ids = self._finding_ids(XMP_MISSING_PDF)
        self.assertEqual(ids, ["FX-CONTAINER-XMP"])
        self.assertFalse([i for i in ids if i.startswith("FX-PDFA3-")])

    def test_pdfa3_findings_are_warnings_with_message_and_element(self):
        for f in pdf_container.inspect_container(PDFA3_MISSING_PDF).findings:
            self.assertTrue(f.rule_id.startswith("FX-PDFA3-"), f.rule_id)
            self.assertEqual(f.severity, "warning")
            self.assertTrue(f.message and f.element)
            self.assertIn("pdfaid", f.element)

    def test_pdfa3_defect_does_not_corrupt_extracted_xml(self):
        self.assertEqual(pdf_container.extract_invoice_xml(PDFA3_MISSING_PDF),
                         _read(VALID_INNER_XML))

    def test_findings_have_stable_namespace_and_warning_severity(self):
        for pdf in (AFREL_BAD_PDF, AF_MISSING_PDF, XMP_MISSING_PDF,
                    XMP_MISMATCH_PDF):
            for f in pdf_container.inspect_container(pdf).findings:
                self.assertTrue(f.rule_id.startswith("FX-CONTAINER-"), f.rule_id)
                self.assertEqual(f.severity, "warning")
                self.assertTrue(f.message and f.element)

    def test_extraction_still_byte_exact_on_defect_fixtures(self):
        # Container defects must NOT corrupt the extracted invoice XML.
        ref = _read(VALID_INNER_XML)
        for pdf in (AFREL_BAD_PDF, AF_MISSING_PDF, XMP_MISSING_PDF,
                    XMP_MISMATCH_PDF):
            self.assertEqual(pdf_container.extract_invoice_xml(pdf), ref, pdf)


class TestContainerFindingsInReport(unittest.TestCase):
    """The FX-CONTAINER-* findings surface as first-class report records on the
    PDF path, without disturbing the XML-input contract."""

    def test_mismatch_fixtures_surface_expected_id_in_report(self):
        expect = {
            AFREL_BAD_PDF: "FX-CONTAINER-AFRELATIONSHIP",
            AF_MISSING_PDF: "FX-CONTAINER-AF",
            XMP_MISSING_PDF: "FX-CONTAINER-XMP",
            XMP_MISMATCH_PDF: "FX-CONTAINER-PROFILE",
        }
        for pdf, rule_id in expect.items():
            rep = report.build_report(pdf, profile="en16931")
            self.assertNotIn("error", rep, pdf)
            fired = {v["rule"] for v in rep["violations"]}
            self.assertIn(rule_id, fired, (pdf, fired))

    def test_pdfa3_missing_surfaces_both_ids_as_report_records(self):
        # The FX-PDFA3-* findings ride the same container_findings list and
        # surface as first-class report records (non-pass, never a crash).
        rep = report.build_report(PDFA3_MISSING_PDF, profile="en16931")
        self.assertNotIn("error", rep)
        fired = {v["rule"] for v in rep["violations"]}
        self.assertIn("FX-PDFA3-PART", fired)
        self.assertIn("FX-PDFA3-CONFORMANCE", fired)
        for v in rep["violations"]:
            if v["rule"].startswith("FX-PDFA3-"):
                self.assertEqual(v["severity"], "warning")

    def test_matching_pdf_report_has_no_fx_pdfa3_records(self):
        rep = report.build_report(VALID_PDF, profile="xrechnung")
        fx = [v["rule"] for v in rep["violations"]
              if v["rule"].startswith("FX-PDFA3-")]
        self.assertEqual(fx, [])

    def test_matching_pdf_report_has_no_fx_container_records(self):
        # The valid PDF must carry NO FX-CONTAINER-* record (keeps the fired-id
        # equality with validating the inner XML directly intact).
        rep = report.build_report(VALID_PDF, profile="xrechnung")
        fx = [v["rule"] for v in rep["violations"]
              if v["rule"].startswith("FX-CONTAINER-")]
        self.assertEqual(fx, [])

    def test_container_findings_are_warnings_not_fatal(self):
        # A pure container defect (valid inner XML) does not flip fatal_count.
        rep = report.build_report(AFREL_BAD_PDF, profile="en16931")
        fx = [v for v in rep["violations"]
              if v["rule"].startswith("FX-CONTAINER-")]
        self.assertTrue(fx)
        for v in fx:
            self.assertEqual(v["severity"], "warning")

    def test_raw_xml_path_never_gets_fx_container_records(self):
        rep = report.build_report(VALID_INNER_XML, profile="en16931")
        fx = [v["rule"] for v in rep["violations"]
              if v["rule"].startswith("FX-CONTAINER-")]
        self.assertEqual(fx, [])


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

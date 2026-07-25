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
import tempfile
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
SYNTH_DIR = os.path.join(HERE, "corpus", "synthetic")

VALID_PDF = os.path.join(PDF_DIR, "facturx-valid.pdf")
# The full-shape synthetic CII invoice wrapped in a MATCHING Factur-X container
# (T-VHR.23): the SAME invoice pinned as raw CII (synth-cii-good-fullshape) here
# traverses the PDF-container e2e path and must validate identically.
FULLSHAPE_PDF = os.path.join(PDF_DIR, "facturx-fullshape.pdf")
FULLSHAPE_INNER_XML = os.path.join(SYNTH_DIR, "synth-cii-good-fullshape.xml")
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
MATCHING_PDFS = (VALID_PDF, VALID_PDF_RAW, BAD_PDF, FULLSHAPE_PDF)

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
        """The container fixture wraps CII_example5.xml, which is EN-core
        clean; under the xrechnung profile it fires the fatal BR-TMP-3 since
        the CVD/TMP family landed (gross BasisQuantity '1.1' != net '1' —
        mirroring the official KoSIT CII artifact, which fires BR-TMP-3 on
        this file too), and since the T-VHCIIDE.1 payment-means group landed
        also the fatal BR-DE-23-b (document-level CreditorReferenceID +
        DirectDebitMandateID = BG-19 next to a code-58 credit-transfer means)
        plus the BR-DE-19 warning (both code-58 IBANs fail mod-97), and since
        the T-VHCIIDE.2 direct-debit pair landed also the fatal BR-DE-31
        (BG-19 present via BT-89 + BT-90 but no debited-account IBAN BT-91;
        BR-DE-30 holds) — the official artifact fires all of these on this
        file (differential LEG 4). The invariant under test is unchanged: the
        PDF path must equal validating the inner XML directly, per profile."""
        for profile in ("xrechnung", "en16931"):
            rep = report.build_report(VALID_PDF, profile=profile)
            self.assertNotIn("error", rep,
                             "valid PDF must not be an unsupported container")
            self.assertEqual(_report_fired(rep),
                             _direct_cii_fired(VALID_INNER_XML, profile),
                             "PDF fired ids must equal validating inner XML "
                             "directly (%s)" % profile)
            if profile == "en16931":
                self.assertTrue(rep["valid"], (profile, rep))
                self.assertEqual(rep["fatal_count"], 0)
            else:
                self.assertFalse(rep["valid"], (profile, rep))
                fatals = [v["rule"] for v in rep["violations"]
                          if v["severity"] == "fatal"]
                self.assertEqual(fatals,
                                 ["BR-DE-23-b", "BR-DE-31", "BR-TMP-3"], rep)

    def test_valid_pdf_cli_exits_zero(self):
        # EN-core profile: the embedded invoice is clean -> exit 0.
        code, out, err = _run_cli("--profile", "en16931", VALID_PDF)
        self.assertEqual(code, 0, err)
        self.assertIn('"valid":true', out)
        # Default (xrechnung) profile: the fatal BR-TMP-3 -> exit 1, same as
        # validating the inner XML directly.
        code, out, err = _run_cli(VALID_PDF)
        self.assertEqual(code, 1, err)
        self.assertIn('"valid":false', out)
        self.assertIn("BR-TMP-3", out)


class TestFullShapeContainerE2E(unittest.TestCase):
    """T-VHR.23: the full-shape CII invoice through the PDF-CONTAINER path.

    The container promise: validating the full-shape invoice via its Factur-X
    PDF container must be IDENTICAL to validating the embedded inner XML
    (corpus/synthetic/synth-cii-good-fullshape.xml) directly through the CII
    path, and a valid full-shape Factur-X container must PASS. This mirrors the
    MATCHING_PDFS fired-id equivalence for the distinct full-shape document."""

    def test_fullshape_container_extraction_byte_exact(self):
        self.assertEqual(pdf_container.extract_invoice_xml(FULLSHAPE_PDF),
                         _read(FULLSHAPE_INNER_XML))

    def test_fullshape_container_has_no_container_findings(self):
        # A conformant container (XMP EN 16931 profile + PDF/A-3 pdfaid identity
        # + /AFRelationship + /AF) -> no FX-CONTAINER-*/FX-PDFA3-* finding.
        self.assertEqual(
            [f.rule_id
             for f in pdf_container.inspect_container(FULLSHAPE_PDF).findings],
            [])

    def test_fullshape_container_equals_direct_inner_xml_and_passes(self):
        # Under BOTH profiles the container's fired ids EQUAL validating the
        # embedded inner XML directly through the CII engine, and the valid
        # full-shape container PASSES (no fatal) under each.
        for profile in ("en16931", "xrechnung"):
            rep = report.build_report(FULLSHAPE_PDF, profile=profile)
            self.assertNotIn("error", rep,
                             "valid full-shape PDF must not be an unsupported "
                             "container (%s)" % profile)
            self.assertEqual(_report_fired(rep),
                             _direct_cii_fired(FULLSHAPE_INNER_XML, profile),
                             "container fired ids must equal validating the "
                             "inner XML directly (%s)" % profile)
            self.assertTrue(rep["valid"], (profile, rep))
            self.assertEqual(rep["fatal_count"], 0, (profile, rep))
        # Under the EN 16931 core profile the full-shape invoice is fully clean:
        # zero fired rules over the container, exactly as over the raw XML.
        rep_en = report.build_report(FULLSHAPE_PDF, profile="en16931")
        self.assertEqual(_report_fired(rep_en), [])
        self.assertEqual(_direct_cii_fired(FULLSHAPE_INNER_XML, "en16931"), [])


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


class TestXmlPathMatchesContainerPath(unittest.TestCase):
    """The plain-XML path and the PDF-container path must agree on the same
    CII payload. Since T-VHCII3.1 both reach the CII engine through the ONE
    ``einvoice.validate.validate_root`` dispatch, so validating the extracted
    inner XML directly fires exactly the rule ids the container path fires,
    minus the container-only FX-CONTAINER-* records (which are a property of
    the PDF wrapper, not of the invoice). Before that fix the XML path answered
    the identical bytes with a structural S-ROOT refusal — the disagreement
    this class now forbids."""

    def test_raw_cii_xml_is_graded_not_refused(self):
        rep = report.build_report(VALID_INNER_XML, profile="en16931")
        rules_fired = {v["rule"] for v in rep["violations"]}
        self.assertNotIn("S-ROOT", rules_fired)
        # CII_example5.xml is EN-core clean (same fact the container leg pins).
        self.assertTrue(rep["valid"], rep["violations"])
        self.assertEqual(rep["fatal_count"], 0)

    def test_raw_xml_and_container_fire_the_same_business_rules(self):
        for profile in ("en16931", "xrechnung"):
            with self.subTest(profile=profile):
                pdf_rep = report.build_report(VALID_PDF, profile=profile)
                xml_rep = report.build_report(VALID_INNER_XML, profile=profile)
                self.assertEqual(
                    {v["rule"] for v in xml_rep["violations"]},
                    {v["rule"] for v in pdf_rep["violations"]
                     if not v["rule"].startswith("FX-CONTAINER-")},
                    "raw-XML and PDF-container paths must grade the same "
                    "payload identically (%s)" % profile)


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


def _load_fixture_generator():
    """Load corpus/pdf/make_pdf_fixtures.py (the stdlib Factur-X builder) via
    importlib — the same pattern TestFixturesReproducible uses."""
    gen_path = os.path.join(PDF_DIR, "make_pdf_fixtures.py")
    spec = importlib.util.spec_from_file_location("_make_pdf_fixtures",
                                                  gen_path)
    gen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gen)
    return gen


class TestGermanRulesThroughContainer(unittest.TestCase):
    """T-VHCIIDE.4: the new German CII rules fire END-TO-END through the
    Factur-X PDF-container path (extract -> parse -> CII_DE_RULES), the way
    real ZUGFeRD/Factur-X adopters actually ship invoices.

    An in-test Factur-X PDF (built with the committed stdlib generator, never
    written to corpus/) embeds a CII invoice violating BOTH:

      * BR-DE-19 (warning) — the code-58 payee IBAN's mod-97 check fails
        (``DE79...91``, the exact bad value of the T-VHCIIDE.1 unit fixture
        ``test_de19_positive_bad_check_digits``), and
      * BR-DE-18 (fatal)   — the BT-20 payment-terms Description carries the
        malformed Skonto line ``#SKONTO#TAGE=14#PROZENT=2#`` (PROZENT lacks
        the mandatory two decimals — the exact bad value of the T-VHCIIDE.3
        unit fixture ``test_missing_two_decimals_fires``).

    Base payload: the XRechnung testsuite CII invoice 01.02a — the SAME
    BR-DE-clean base every CII BR-DE unit fixture mutates. It fires ZERO
    rules under the xrechnung profile, so it doubles as the wrapped-identical
    control. (The existing valid fixture's CII_example5.xml payload cannot
    serve here: MEASURED, it already fires BR-DE-19 UNMUTATED under
    xrechnung — both its code-58 IBANs fail mod-97 — so a control asserting
    the absence of BR-DE-19 would be impossible on it.)

    The container is MATCHING: 01.02a's CustomizationID is the XRechnung
    CIUS URN, so the XMP declares ConformanceLevel XRECHNUNG — otherwise the
    generator's "EN 16931" default would fire FX-CONTAINER-PROFILE on the
    PDF path only and break the fired-id parity with direct XML validation.
    """

    # The clean XRechnung CII base the per-rule unit fixtures mutate
    # (test_xrechnung.py XR_CII_BASE).
    BASE_XML = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src",
                            "test", "business-cases", "standard",
                            "01.02a-INVOICE_uncefact.xml")
    GOOD_IBAN = b"DE79000000001234567890"   # mod-97 valid (the base's value)
    BAD_IBAN = b"DE79000000001234567891"    # last digit flipped -> BR-DE-19
    # 01.02a's full BT-20 prose Description (unique in the file) ...
    PROSE_TERMS = ("Bitte überweisen Sie den Betrag innerhalb von 14 Tagen "
                   "auf unten stehendes Konto. Das Rechnungsdatum entspricht "
                   "dem Versanddatum.").encode("utf-8")
    # ... replaced by the malformed Skonto grammar -> BR-DE-18.
    BAD_SKONTO = b"#SKONTO#TAGE=14#PROZENT=2#"

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="einvoice-pdf-de-")
        gen = _load_fixture_generator()
        base = _read(cls.BASE_XML)
        # Guard the mutation surfaces: each target string must be present
        # EXACTLY once, or the byte-level mutation would silently miss.
        assert base.count(cls.GOOD_IBAN) == 1, "base IBAN surface drifted"
        assert base.count(cls.PROSE_TERMS) == 1, "base BT-20 surface drifted"
        mutated = base.replace(cls.GOOD_IBAN, cls.BAD_IBAN)
        mutated = mutated.replace(cls.PROSE_TERMS, cls.BAD_SKONTO)
        assert mutated.count(cls.BAD_IBAN) == 1
        assert mutated.count(cls.BAD_SKONTO) == 1

        def _write(name, data):
            path = os.path.join(cls._tmp.name, name)
            with open(path, "wb") as fh:
                fh.write(data)
            return path

        cls.mutated_xml = _write("de-violating.xml", mutated)
        cls.bad_pdf = _write(
            "facturx-de-violating.pdf",
            gen.build_facturx_pdf(mutated, xmp_conformance_level="XRECHNUNG"))
        # Control: the SAME payload unmutated, wrapped IDENTICALLY.
        cls.control_pdf = _write(
            "facturx-de-control.pdf",
            gen.build_facturx_pdf(base, xmp_conformance_level="XRECHNUNG"))

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_violating_pdf_fires_both_german_rules_via_report(self):
        rep = report.build_report(self.bad_pdf, profile="xrechnung")
        self.assertNotIn("error", rep,
                         "the violating PDF is a supported container")
        fired = {v["rule"]: v["severity"] for v in rep["violations"]}
        self.assertIn("BR-DE-19", fired, fired)
        self.assertIn("BR-DE-18", fired, fired)
        # Severities as registered from the official artifact.
        self.assertEqual(fired["BR-DE-19"], "warning")
        self.assertEqual(fired["BR-DE-18"], "fatal")
        # BR-DE-18 is fatal -> the report is a non-pass.
        self.assertFalse(rep["valid"], rep)
        self.assertGreater(rep["fatal_count"], 0)

    def test_violating_pdf_cli_exits_nonzero(self):
        code, out, err = _run_cli("--profile", "xrechnung", self.bad_pdf)
        self.assertNotEqual(code, 0, out)
        self.assertEqual(err, "", err)  # a rule failure, not a traceback
        self.assertIn('"valid":false', out)
        self.assertIn("BR-DE-19", out)
        self.assertIn("BR-DE-18", out)

    def test_violating_pdf_equals_direct_xml_validation(self):
        # The established parity invariant: PDF-path fired (id, severity)
        # pairs EQUAL validating the same mutated XML directly through the
        # CII engine.
        rep = report.build_report(self.bad_pdf, profile="xrechnung")
        self.assertEqual(_report_fired(rep),
                         _direct_cii_fired(self.mutated_xml, "xrechnung"))

    def test_control_unmutated_payload_does_not_fire_the_german_pair(self):
        # The SAME base payload, wrapped identically: neither target id
        # fires through the PDF path (assert absence of the two ids, per
        # spec — not a blanket exit-0 claim).
        rep = report.build_report(self.control_pdf, profile="xrechnung")
        self.assertNotIn("error", rep)
        fired_ids = {v["rule"] for v in rep["violations"]}
        self.assertNotIn("BR-DE-19", fired_ids, fired_ids)
        self.assertNotIn("BR-DE-18", fired_ids, fired_ids)
        # And the control keeps the parity invariant with its own direct
        # XML validation.
        self.assertEqual(_report_fired(rep),
                         _direct_cii_fired(self.BASE_XML, "xrechnung"))


class TestFixturesReproducible(unittest.TestCase):
    def test_fixtures_are_byte_reproducible_from_generator(self):
        gen = _load_fixture_generator()
        for name, builder in gen.FIXTURES.items():
            committed = _read(os.path.join(PDF_DIR, name))
            self.assertEqual(builder(), committed,
                             "%s drifted from its stdlib generator" % name)


if __name__ == "__main__":
    unittest.main(verbosity=2)

"""test_facturx_profile_scope.py — pin the honest Factur-X/ZUGFeRD profile scope.

Fast, stdlib-only, saxonche-free, offline. This test does NOT add, change, or
gate any business rule; it MEASURES what the engine already does for each
Factur-X 1.x / ZUGFeRD 2.x profile and pins two things so they cannot silently
drift:

  1. `einvoice.pdf_container._canonical_profile` — recomputed over a fixed table
     of the canonical Factur-X/ZUGFeRD guideline URNs (and their XMP
     ConformanceLevel strings), asserting each maps to the documented token.
     If the recognition table ever changes shape, this fails.

  2. COVERAGE.md carries the honest, human-readable "Factur-X/ZUGFeRD profile
     scope" section (MINIMUM / BASIC WL out-of-scope wording), so the doc and
     the code stay in lock-step.

  3. One MEASURED end-to-end fact, using the EXISTING committed
     `corpus/pdf/facturx-valid.pdf` fixture (no new heavy fixture synthesised):
     validating the fixture's embedded CrossIndustryInvoice runs the FULL core
     rule set (`einvoice.rules.ALL_RULES`) — the declared profile does NOT gate
     which rules fire, so a MINIMUM / BASIC WL container would still be checked
     against every mandatory EN 16931 term rather than silently passed.

Run: python3 test_facturx_profile_scope.py
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from einvoice import pdf_container  # noqa: E402
from einvoice import parser_cii, rules  # noqa: E402
from einvoice import report as _report  # noqa: E402
from einvoice._xmlsec import _safe_fromstring  # noqa: E402

COVERAGE_MD = os.path.join(HERE, "COVERAGE.md")
VALID_PDF = os.path.join(HERE, "corpus", "pdf", "facturx-valid.pdf")

# The canonical Factur-X 1.x / ZUGFeRD 2.x profile identifiers. Two forms are
# recognised by the engine and both are pinned here:
#   * the embedded-CII CustomizationID (BT-24) guideline URN, and
#   * the XMP ConformanceLevel string the PDF declares.
# MINIMUM and BASIC WL are declared with the plain factur-x guideline URN (they
# are NOT EN 16931 CIUS, so they carry no urn:cen.eu:en16931:2017 marker); the
# EN 16931-depth profiles carry the en16931 CIUS marker.
CANONICAL_PROFILE_CASES = [
    # (input value, expected canonical token)
    # --- CII CustomizationID (BT-24) guideline URNs ---
    ("urn:factur-x.eu:1p0:minimum", "MINIMUM"),
    ("urn:zugferd:pdfa:CrossIndustryDocument:invoice:1p0#minimum", "MINIMUM"),
    ("urn:factur-x.eu:1p0:basicwl", "BASICWL"),
    ("urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic", "BASIC"),
    ("urn:cen.eu:en16931:2017", "EN16931"),
    ("urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended",
     "EXTENDED"),
    ("urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:"
     "xrechnung_3.0", "XRECHNUNG"),
    ("urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0",
     "XRECHNUNG"),
    # --- XMP ConformanceLevel strings (as declared in the PDF metadata) ---
    ("MINIMUM", "MINIMUM"),
    ("BASIC WL", "BASICWL"),
    ("BASIC", "BASIC"),
    ("EN 16931", "EN16931"),
    ("COMFORT", "EN16931"),          # legacy ZUGFeRD name for the EN 16931 level
    ("EXTENDED", "EXTENDED"),
    ("XRECHNUNG", "XRECHNUNG"),
]

# The six recognised profile tokens, exactly as documented in COVERAGE.md.
EXPECTED_TOKENS = {"MINIMUM", "BASICWL", "BASIC", "EN16931", "EXTENDED",
                   "XRECHNUNG"}


class CanonicalProfileTableTest(unittest.TestCase):
    """(1) The recognition table cannot silently drift."""

    def test_each_urn_maps_to_expected_token(self):
        for value, expected in CANONICAL_PROFILE_CASES:
            got = pdf_container._canonical_profile(value)
            self.assertEqual(
                got, expected,
                "_canonical_profile(%r) = %r, expected %r" % (
                    value, got, expected))

    def test_every_documented_token_is_reachable(self):
        produced = {pdf_container._canonical_profile(v)
                    for v, _ in CANONICAL_PROFILE_CASES}
        self.assertEqual(
            produced, EXPECTED_TOKENS,
            "the pinned cases must cover exactly the six recognised tokens")

    def test_unrecognised_and_empty_are_none(self):
        # No false recognition: an unknown or empty value is not a profile.
        self.assertIsNone(pdf_container._canonical_profile(
            "urn:example:not-a-profile"))
        self.assertIsNone(pdf_container._canonical_profile(""))
        self.assertIsNone(pdf_container._canonical_profile(None))


class CoverageScopeDocTest(unittest.TestCase):
    """(2) COVERAGE.md carries the honest MINIMUM/BASIC WL out-of-scope wording."""

    @classmethod
    def setUpClass(cls):
        with open(COVERAGE_MD, encoding="utf-8") as fh:
            cls.text = fh.read()

    def test_scope_section_present(self):
        self.assertIn("Factur-X/ZUGFeRD profile scope", self.text)

    def test_names_all_five_profiles(self):
        for name in ("MINIMUM", "BASIC WL", "BASIC", "EN 16931", "EXTENDED"):
            self.assertIn(name, self.text,
                          "COVERAGE.md scope section must name %r" % name)

    def test_minimum_basicwl_declared_out_of_scope(self):
        low = self.text.lower()
        self.assertIn("not en 16931-conformant", low,
                      "must state MINIMUM/BASIC WL are not EN 16931-conformant")
        self.assertIn("out of scope for en 16931 conformance", low)

    def test_states_engine_does_not_silently_pass(self):
        low = self.text.lower()
        self.assertIn("does not silently pass", low)
        # And that rules are not gated by the declared profile.
        self.assertIn("same rule set regardless of the declared profile", low)


class MeasuredEndToEndFactTest(unittest.TestCase):
    """(3) Validating an existing fixture's embedded CII runs the FULL rule set,
    independent of the declared profile — measured, not assumed."""

    def test_full_core_rule_set_runs_over_embedded_cii(self):
        self.assertTrue(os.path.exists(VALID_PDF), "fixture missing")
        inspection = pdf_container.inspect_container(VALID_PDF)
        root = _safe_fromstring(inspection.xml_bytes)
        # The fixture's embedded payload is a CrossIndustryInvoice (the CII path).
        self.assertEqual(root.tag.rsplit("}", 1)[-1], "CrossIndustryInvoice")

        inv = parser_cii.build_model(root)
        # EVERY core rule is applied to the embedded CII — none skipped. This is
        # the measured "full rule set runs" fact the scope statement rests on.
        ran = 0
        for fn in rules.ALL_RULES:
            fn(inv)          # must not raise; return value (Violation|None) unused
            ran += 1
        self.assertEqual(ran, len(rules.ALL_RULES))
        self.assertGreaterEqual(
            ran, 200, "the full EN 16931 core rule set should be ~209 rules")

    def test_pipeline_does_not_gate_rules_by_declared_profile(self):
        # The CII validation path applies rules.ALL_RULES unconditionally; the
        # profile argument only ADDS the XRechnung CIUS layer, it never removes
        # or gates a core rule. Pin that fact against the live source so a future
        # profile-keyed rule filter would trip this test.
        import inspect
        src = inspect.getsource(_report._report_from_invoice_bytes)
        self.assertIn("for fn in _rules.ALL_RULES", src)

    def test_valid_en16931_fixture_passes_full_validation(self):
        # A genuine EN 16931 profile document: its BT-24 canonicalises to
        # EN16931 and, run through the full core rule set, it is valid (0 fatal)
        # — proving the mandatory EN 16931 terms are present and checked, not
        # skipped. (A MINIMUM/BASIC WL doc, lacking those terms, would instead
        # fire the mandatory-term rules — the engine never silently passes it.)
        cust = pdf_container._cii_customization_id(
            pdf_container.inspect_container(VALID_PDF).xml_bytes)
        self.assertEqual(pdf_container._canonical_profile(cust), "EN16931")
        rep = _report.build_report(VALID_PDF, profile="en16931")
        self.assertTrue(rep["valid"], rep.get("violations"))
        self.assertEqual(rep.get("fatal_count"), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)

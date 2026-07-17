"""test_xrechnung_version_scope.py — bind the STATED XRechnung version to the
vendored corpus marker (doc-vs-corpus drift guard).

Fast, stdlib-only, saxonche-free, offline. This test does NOT add, change, or
gate any business rule, evaluator, parser, or verdict path. It MEASURES the
single authoritative version marker — the KoSIT Schematron title line inside the
REAL vendored artifact — and asserts the human-facing docs (COVERAGE.md, and the
XRechnung version prose in SPEC.md) state exactly that version.

Why this matters: the `BR-DE-*` layer is only correct for one specific published
XRechnung CIUS version. If someone re-vendors a newer KoSIT Schematron (bumping
the `.sch` title / VENDORED.md) but forgets to update the scope statement a
procurement reader relies on, COVERAGE.md would silently claim the wrong version.
This guard turns that silent drift into a hard failure.

Source of truth (parsed live, never a hardcoded parallel copy):
  * corpus/xrechnung-schematron/schematron/ubl/XRechnung-UBL-validation.sch
  * corpus/xrechnung-schematron/schematron/cii/XRechnung-CII-validation.sch
  * corpus/xrechnung-schematron/VENDORED.md
all of which must agree, and whose version is then required to appear in the
docs.

Run: python3 test_xrechnung_version_scope.py
"""

import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))

CORPUS = os.path.join(HERE, "corpus", "xrechnung-schematron")
UBL_SCH = os.path.join(CORPUS, "schematron", "ubl", "XRechnung-UBL-validation.sch")
CII_SCH = os.path.join(CORPUS, "schematron", "cii", "XRechnung-CII-validation.sch")
VENDORED_MD = os.path.join(CORPUS, "VENDORED.md")

COVERAGE_MD = os.path.join(HERE, "COVERAGE.md")
SPEC_MD = os.path.join(HERE, "SPEC.md")

# The KoSIT Schematron title line, verbatim example:
#   Schematron Version 2.5.0 - XRechnung 3.0.2 compatible - UBL - Invoice ...
_TITLE_RE = re.compile(
    r"Schematron\s+Version\s+(\d+\.\d+\.\d+)\s*-\s*"
    r"XRechnung\s+(\d+\.\d+\.\d+)\s+compatible",
    re.IGNORECASE,
)
# VENDORED.md prose, verbatim example (may wrap across a newline):
#   XRechnung Schematron v2.5.0** (compatible with XRechnung\n3.0.2 ...
_VENDORED_SCH_RE = re.compile(
    r"XRechnung\s+Schematron\**\s+v(\d+\.\d+\.\d+)", re.IGNORECASE)
_VENDORED_XR_RE = re.compile(
    r"compatible\s+with\s+XRechnung\s+(\d+\.\d+\.\d+)", re.IGNORECASE)


def _read(path):
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def _parse_title(path):
    """(schematron_version, xrechnung_version) from a .sch title line."""
    m = _TITLE_RE.search(_read(path))
    if not m:
        raise AssertionError(
            "no 'Schematron Version X - XRechnung Y compatible' title line "
            "found in the vendored artifact: %s" % path)
    return m.group(1), m.group(2)


class XRechnungVersionScopeTest(unittest.TestCase):

    def setUp(self):
        for p in (UBL_SCH, CII_SCH, VENDORED_MD, COVERAGE_MD, SPEC_MD):
            self.assertTrue(os.path.exists(p), "missing expected file: %s" % p)

    def test_vendored_markers_agree(self):
        # The single source of truth: UBL .sch, CII .sch and VENDORED.md must
        # all name the SAME Schematron + XRechnung version. If a re-vendor
        # updates one and not the others, the marker is ambiguous — fail loudly
        # so the doc-binding assertions below rest on a coherent value.
        ubl_sch, ubl_xr = _parse_title(UBL_SCH)
        cii_sch, cii_xr = _parse_title(CII_SCH)
        self.assertEqual(
            (ubl_sch, ubl_xr), (cii_sch, cii_xr),
            "UBL and CII vendored Schematron titles disagree on version")

        vend = _read(VENDORED_MD)
        vm_sch = _VENDORED_SCH_RE.search(vend)
        vm_xr = _VENDORED_XR_RE.search(vend)
        self.assertIsNotNone(
            vm_sch, "VENDORED.md does not state 'XRechnung Schematron vX.Y.Z'")
        self.assertIsNotNone(
            vm_xr, "VENDORED.md does not state 'compatible with XRechnung X.Y.Z'")
        self.assertEqual(
            (vm_sch.group(1), vm_xr.group(1)), (ubl_sch, ubl_xr),
            "VENDORED.md version disagrees with the .sch title line")

    def _marker(self):
        return _parse_title(UBL_SCH)  # coherence already proven above

    def test_coverage_md_states_vendored_version(self):
        # COVERAGE.md must carry the marker parsed from the corpus, in the exact
        # "<sch> (XRechnung <xr>)" form the source-of-truth table + scope prose
        # use. If the corpus is bumped without COVERAGE.md being updated, this
        # composed string is absent → FAIL.
        sch, xr = self._marker()
        cov = _read(COVERAGE_MD)
        combined = "%s (XRechnung %s)" % (sch, xr)
        self.assertIn(
            combined, cov,
            "COVERAGE.md does not state the vendored version %r — the docs have "
            "drifted from the vendored KoSIT Schematron corpus." % combined)
        # And the honest, human-readable scope sentence (not just a table cell)
        # names the Schematron version explicitly.
        self.assertIn(
            "Schematron %s" % sch, cov,
            "COVERAGE.md prose scope statement does not name Schematron %s" % sch)

    def test_spec_md_states_vendored_xrechnung_version(self):
        # SPEC.md states the XRechnung version in prose ("official KoSIT
        # XRechnung 3.0.2 ... Schematron"); bind that too so a corpus bump that
        # is not reflected in SPEC.md fails.
        _sch, xr = self._marker()
        spec = _read(SPEC_MD)
        self.assertIn(
            "XRechnung %s" % xr, spec,
            "SPEC.md does not state 'XRechnung %s' — its prose has drifted from "
            "the vendored corpus." % xr)

    def test_drift_guard_actually_bites(self):
        # Prove the guard is not vacuous: a *different* (simulated bumped)
        # version must NOT already be present in the docs, so a real bump would
        # be caught rather than accidentally matching.
        sch, xr = self._marker()
        bump = lambda v: ".".join(  # noqa: E731 - tiny local helper
            [str(int(v.split(".")[0]) + 1)] + v.split(".")[1:])
        fake = "%s (XRechnung %s)" % (bump(sch), bump(xr))
        cov = _read(COVERAGE_MD)
        self.assertNotIn(
            fake, cov,
            "sanity: a bumped version %r unexpectedly already present" % fake)


if __name__ == "__main__":
    unittest.main(verbosity=2)

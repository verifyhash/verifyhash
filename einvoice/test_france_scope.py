"""test_france_scope.py — pin the honest France-readiness technical scope.

Fast, stdlib-only, saxonche-free, offline. This test adds, changes, or gates NO
business rule. It MEASURES nothing about French national rules (there are none
implemented — none must be). It only asserts that BOTH README.md and COVERAGE.md
carry the non-drifting, strictly-factual France TECHNICAL-scope statement, so the
honest-scope wording cannot be silently deleted or weakened:

  (a) the phrase 'French CIUS' is present;
  (b) the FNFE-MPE / Chorus Pro Factur-X French-CIUS Schematron is declared
      'not vendored' / out of scope (no French-CIUS rule is fabricated);
  (c) the affirmative coverage claim is present: the EN 16931 core + the
      Factur-X path (naming the concrete module `einvoice.pdf_container`) are
      covered for a French invoice.

The test FAILS (exit non-zero) if any of those statements is removed from either
document. Distinct from the French *legislative* timeline text in README §1 —
that is regulatory context, not a technical coverage claim.

Run: python3 test_france_scope.py
"""

import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
README_MD = os.path.join(HERE, "README.md")
COVERAGE_MD = os.path.join(HERE, "COVERAGE.md")

# Both documents must carry the France technical-scope statement.
DOCS = {"README.md": README_MD, "COVERAGE.md": COVERAGE_MD}


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


class FranceScopePresentTest(unittest.TestCase):
    """The France technical-scope statement is present in BOTH docs."""

    @classmethod
    def setUpClass(cls):
        cls.docs = {name: _read(path) for name, path in DOCS.items()}

    def test_french_cius_phrase_present(self):
        # (a) The exact scope subject.
        for name, text in self.docs.items():
            self.assertRegex(
                text, r"(?i)French CIUS",
                "%s must name the 'French CIUS' scope" % name)

    def test_fnfe_mpe_chorus_pro_named(self):
        # (b) The concrete upstream is named (auditable, not vague).
        for name, text in self.docs.items():
            self.assertRegex(
                text, r"(?i)FNFE-?MPE",
                "%s must name the FNFE-MPE upstream" % name)
            self.assertRegex(
                text, r"(?i)Chorus ?Pro",
                "%s must name Chorus Pro" % name)

    def test_french_cius_schematron_not_vendored(self):
        # (b) The French-CIUS Schematron is explicitly NOT vendored / out of
        # scope — the honest-negative claim.
        for name, text in self.docs.items():
            low = text.lower()
            self.assertIn(
                "not vendored", low,
                "%s must state the French-CIUS Schematron is 'not vendored'"
                % name)
            self.assertIn(
                "out of scope", low,
                "%s must state the French-CIUS rules are 'out of scope'" % name)
            self.assertIn(
                "not claimed", low,
                "%s must state full French CIUS conformance is 'not claimed'"
                % name)

    def test_affirmative_en16931_facturx_coverage_named(self):
        # (c) The affirmative claim: EN 16931 core + Factur-X path, naming the
        # concrete module so it is auditable.
        for name, text in self.docs.items():
            self.assertIn(
                "EN 16931", text,
                "%s France-scope must state EN 16931 core coverage" % name)
            self.assertRegex(
                text, r"(?i)Factur-X",
                "%s France-scope must state the Factur-X path" % name)
            self.assertIn(
                "einvoice.pdf_container", text,
                "%s France-scope must name the concrete module "
                "einvoice.pdf_container" % name)

    def test_all_three_facts_colocated_in_one_region(self):
        # Guard against the three facts being scattered so far apart they no
        # longer form a single coherent scope statement: in each doc there must
        # be a window that contains 'French CIUS', 'not vendored', AND
        # 'einvoice.pdf_container' together. If the paragraph is deleted, no such
        # window exists and this fails.
        for name, text in self.docs.items():
            self.assertTrue(
                self._colocated(text),
                "%s must keep the France technical-scope facts in one "
                "paragraph (French CIUS + not vendored + einvoice.pdf_container)"
                % name)

    @staticmethod
    def _colocated(text, window=1600):
        low = text.lower()
        for m in re.finditer(r"french cius", low):
            start = max(0, m.start() - window)
            chunk = low[start:m.start() + window]
            if "not vendored" in chunk and "einvoice.pdf_container" in chunk:
                return True
        return False


if __name__ == "__main__":
    unittest.main(verbosity=2)

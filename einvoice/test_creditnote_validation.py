#!/usr/bin/env python3
"""test_creditnote_validation.py — real EN 16931 validation of UBL CreditNotes
(T-VHCN.2).

Since T-VHCN.2 a UBL 2.1 CreditNote (root
``{urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2}CreditNote``) is a
first-class EN 16931 document: it is routed through the SAME shared BR-* rule
engine as an Invoice, using the CreditNote-specific UBL syntax bindings
(``cac:CreditNoteLine``, ``cbc:CreditedQuantity``, ``cbc:CreditNoteTypeCode``).
The official CEN EN16931-UBL Schematron binds the model to BOTH roots
symmetrically (``$Invoice = /ubl:Invoice | /cn:CreditNote``), so the SAME
normative artifact is the oracle for CreditNote exactly as for Invoice.

This test is stdlib-only, offline and saxonche-free. It does NOT re-run the
Schematron; instead it grades against the vendored CreditNote corpus's OWN
ground truth — the difi ``<success>``/``<error>`` scope labels shipped in
``corpus/cen-en16931/test/CreditNote-unit-UBL/`` — which the landed
``differential.py cn`` leg has already proven equal to the official XSLT at 0
divergences. For every split unit case whose scope rule the engine implements,
the scoped BR-* rule must fire as a fatal iff the case is labelled ``error`` and
must NOT fire iff labelled ``success``. That makes a future CreditNote binding
regression fail HERE, in a fast gate, before the heavy differential runs.

It also pins the coarse document verdict on the committed standalone CreditNote
fixtures: the CEN example plus the Max/Min testfiles pass clean, and a CreditNote
with an out-of-range BT-3 credit-note type code fails with the real BR-CL-01
fatal (never a structural S-ROOT — a CreditNote is validated, not rejected at the
root). A genuinely unsupported root (neither Invoice nor CreditNote) still trips
the honest S-ROOT structural fatal — the honest-error path is preserved for what
is really out of scope.
"""

import os
import sys
import unittest
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import einvoice  # noqa: E402
from einvoice import rules as _rules  # noqa: E402
from einvoice.validate import validate_root  # noqa: E402
from einvoice.parser import parse_file  # noqa: E402

NS_DIFI = "http://difi.no/xsd/vefa/validator/1.0"
NS_CN = "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"

CN_UNIT_DIR = os.path.join(HERE, "corpus", "cen-en16931", "test",
                           "CreditNote-unit-UBL")

# Committed standalone CreditNote fixtures that are business-rule clean.
VALID_CN_FIXTURES = [
    os.path.join(HERE, "corpus", "cen-en16931", "test", "testfiles",
                 "CreditNote-Max_content.xml"),
    os.path.join(HERE, "corpus", "cen-en16931", "test", "testfiles",
                 "CreditNote-Min_content_with_VAT.xml"),
    os.path.join(HERE, "corpus", "cen-en16931", "test", "testfiles",
                 "CreditNote-Min_content_without_VAT.xml"),
    os.path.join(HERE, "corpus", "cen-en16931", "ubl", "examples",
                 "ubl-tc434-creditnote1.xml"),
]
# A committed invalid CreditNote: BT-3 CreditNoteTypeCode=999 is off the UNTDID
# 1001 credit-note sub-list -> a real BR-CL-01 fatal from the shared engine.
INVALID_CN_FIXTURE = os.path.join(HERE, "fixtures",
                                  "creditnote-invalid-typecode_ubl.xml")


def _fn_to_rule_id(fn):
    """br_01 -> BR-01, br_cl_01 -> BR-CL-01 (mirror of differential._fn_to..)."""
    return "-".join(p.upper() for p in fn.__name__.split("_"))


# The core BR-* rules this engine actually implements — the only scope labels
# this test can grade a fire/clear decision against.
IMPLEMENTED_RULE_IDS = {_fn_to_rule_id(fn) for fn in _rules.ALL_RULES}


def _iter_unit_cases():
    """Yield (label, scope_rule, expectation, creditnote_element) for every
    split CreditNote-unit-UBL case that carries an inner CreditNote root."""
    for name in sorted(os.listdir(CN_UNIT_DIR)):
        if not name.lower().endswith(".xml"):
            continue
        root = ET.parse(os.path.join(CN_UNIT_DIR, name)).getroot()
        idx = 0
        for test in root.iter("{%s}test" % NS_DIFI):
            a = test.find("{%s}assert" % NS_DIFI)
            if a is None:
                continue
            succ = a.find("{%s}success" % NS_DIFI)
            err = a.find("{%s}error" % NS_DIFI)
            inner = None
            for el in test:
                if el.tag == "{%s}CreditNote" % NS_CN:
                    inner = el
                    break
            if inner is None:
                continue
            if err is not None and err.text:
                yield ("%s#t%d" % (name[:-4], idx), err.text.strip(),
                       "error", inner)
            elif succ is not None and succ.text:
                yield ("%s#t%d" % (name[:-4], idx), succ.text.strip(),
                       "success", inner)
            idx += 1


def _fatal_rule_ids(result):
    return {v.rule_id for v in result.violations
            if getattr(v, "severity", "fatal") == "fatal"}


class CreditNoteCorpusGroundTruth(unittest.TestCase):
    """Every implemented-rule scope case matches the difi ground-truth label."""

    def test_corpus_present(self):
        self.assertTrue(os.path.isdir(CN_UNIT_DIR), CN_UNIT_DIR)
        cases = list(_iter_unit_cases())
        # The vendored split corpus is substantial — guard against a silently
        # emptied directory that would make every assertion below vacuous.
        self.assertGreater(len(cases), 150, "CreditNote unit corpus too small")

    def test_scoped_rule_fires_iff_error_label(self):
        graded = 0
        mismatches = []
        for label, scope, expectation, inner in _iter_unit_cases():
            if scope not in IMPLEMENTED_RULE_IDS:
                continue  # syntax-binding / unimplemented scope: not graded here
            graded += 1
            result = validate_root(inner, profile="en16931")  # must not raise
            fired = scope in _fatal_rule_ids(result)
            want = (expectation == "error")
            if fired != want:
                mismatches.append(
                    "%s scope=%s expected_fire=%s got_fire=%s"
                    % (label, scope, want, fired))
        self.assertEqual(mismatches, [],
                         "CreditNote scope cases diverged from ground truth:\n"
                         + "\n".join(mismatches))
        # Prove the grade actually exercised a broad slice of the rule engine.
        self.assertGreater(graded, 120, "too few graded CreditNote cases")

    def test_no_creditnote_case_crashes_or_sroots(self):
        # Robustness: no CreditNote shape in the corpus may raise, and none may
        # fall through to the structural S-ROOT bailout (that would mean the
        # root was not recognised and the BR-* engine never ran).
        for label, _scope, _exp, inner in _iter_unit_cases():
            result = validate_root(inner, profile="en16931")  # must not raise
            self.assertNotIn("S-ROOT", {v.rule_id for v in result.violations},
                             "CreditNote %s must route through the engine, "
                             "not S-ROOT" % label)


class CreditNoteFixtureVerdicts(unittest.TestCase):
    """Coarse pass/fail verdict on the committed standalone CreditNotes."""

    def test_valid_creditnotes_pass_clean(self):
        for path in VALID_CN_FIXTURES:
            with self.subTest(path=path):
                self.assertTrue(os.path.isfile(path), path)
                result = einvoice.validate_file(path)  # must not raise
                self.assertTrue(result.valid,
                                "clean CreditNote must pass: fatals=%s"
                                % sorted(_fatal_rule_ids(result)))
                self.assertNotIn("S-ROOT", _fatal_rule_ids(result))

    def test_invalid_creditnote_fires_real_rule_not_sroot(self):
        self.assertTrue(os.path.isfile(INVALID_CN_FIXTURE), INVALID_CN_FIXTURE)
        result = einvoice.validate_file(INVALID_CN_FIXTURE)
        self.assertFalse(result.valid, "invalid CreditNote must not pass")
        fatal = _fatal_rule_ids(result)
        self.assertIn("BR-CL-01", fatal,
                      "expected the real BR-CL-01 fatal, got %s" % sorted(fatal))
        self.assertNotIn("S-ROOT", fatal,
                         "an invalid CreditNote fails on content, not S-ROOT")

    def test_creditnote_typecode_uses_creditnote_codelist(self):
        # BR-CL-01 keys on the credit-note sub-list: 381 is a VALID credit-note
        # type code (would be INVALID for an Invoice), 999 is invalid. This
        # proves the CreditNote binding, not the Invoice list, is applied.
        clean = einvoice.validate_file(VALID_CN_FIXTURES[0])  # Max, BT-3 = 381
        self.assertNotIn("BR-CL-01", _fatal_rule_ids(clean))
        bad = einvoice.validate_file(INVALID_CN_FIXTURE)      # BT-3 = 999
        self.assertIn("BR-CL-01", _fatal_rule_ids(bad))


class UnsupportedRootStillHonestError(unittest.TestCase):
    """A genuinely unsupported root (not Invoice, not CreditNote) still trips
    the honest structural S-ROOT — the honest-error path is preserved."""

    def test_unrelated_root_is_sroot(self):
        el = ET.fromstring('<catalog xmlns="urn:example:unrelated"/>')
        result = validate_root(el, profile="en16931")
        self.assertFalse(result.valid)
        rule_ids = {v.rule_id for v in result.violations}
        self.assertIn("S-ROOT", rule_ids)


if __name__ == "__main__":
    unittest.main(verbosity=2)

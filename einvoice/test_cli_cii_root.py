#!/usr/bin/env python3
"""test_cli_cii_root.py — pin BOTH halves of the raw-XML root dispatch: a CII
``CrossIndustryInvoice`` is GRADED, a genuinely unsupported root still gets the
structural ``S-ROOT`` fatal (T-VHCII3.1, superseding the T-VHUX.5 refusal pin).

Fast, stdlib-only, saxonche-free, offline.

WHY THIS TEST EXISTS, AND WHY IT CHANGED

XRechnung has TWO official syntaxes — UBL and UN/CEFACT CII — and CII is also
the ZUGFeRD/Factur-X payload, so a German ERP's invoice folder is routinely raw
CII XML. Until 0.2.7 the raw-XML surfaces (``einvoice validate``,
``validate-batch``, ``python3 -m einvoice.report``, ``einvoice receipt``) all
called the UBL-only ``validate.validate_file`` and answered every one of those
files with a fatal ``S-ROOT`` and exit 1 — a RED BUILD on VALID invoices, with
a message asserting raw CII validation did not exist. The engine had graded
those exact bytes correctly the whole time through the PDF-container path and
through the public ``einvoice.validate_bytes``; only the dispatch layer
withheld the answer. T-VHCII3.1 moved that dispatch into ONE seam
(``einvoice.validate.validate_root`` -> ``validate.cii_violations``) that every
surface shares, so they cannot drift apart again.

This file previously pinned the refusal (and the actionable wording it was
delivered with). It now pins the truth that replaced it. Coverage is not
reduced: the structural-refusal leg is still asserted here, on a root that is
genuinely unsupported.

PINNED CONTRACT:

  1. GRADED: a business-rule-clean raw CII document passes ``validate`` with
     exit 0 and emits NO S-ROOT, in text and ``--json`` form.
  2. GRADED HONESTLY: a raw CII document with a real defect fails with exit 1
     on that REAL business rule (``BR-05`` for the BT-5-less credit note),
     never on ``S-ROOT``.
  3. STILL REFUSED: a genuinely unsupported root (this test writes its own
     ``buildConfigurations`` fixture into a temp dir it cleans up) is still the
     structural ``S-ROOT`` fatal with exit 1 and the byte-frozen UBL-only
     message.
  4. ONE SEAM: the CLI verdict for a raw CII file is identical to what the
     public ``einvoice.validate_bytes`` answers for the same bytes — the
     regression that made this task necessary would fail here.
  5. Namespace tolerance: the dispatch matches ``CrossIndustryInvoice`` by
     LOCALNAME, exactly as the container path always has, so a wrong-namespace
     CII root is graded (and fails on real mandatory-term rules) rather than
     silently taking a different route from the container path.

Committed fixtures exercised (never mutated): ``fixtures/creditnote-valid_cii.xml``
(clean, BT-3=381), ``fixtures/creditnote-invalid_cii.xml`` (same document with
BT-5 removed -> BR-05) and ``fixtures/sb-pass-clean_cii.xml``.
"""

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import einvoice  # noqa: E402
from einvoice import validate as _validate  # noqa: E402
from einvoice.cli import EXIT_FAIL, EXIT_OK  # noqa: E402

#: A business-rule-clean raw CII document (BT-3 = 381 credit note).
CII_GOOD = os.path.join(HERE, "fixtures", "creditnote-valid_cii.xml")
#: The same document with BT-5 (ram:InvoiceCurrencyCode) removed -> BR-05.
CII_BAD = os.path.join(HERE, "fixtures", "creditnote-invalid_cii.xml")
#: A second clean CII document, differently shaped (not a credit note).
CII_GOOD_2 = os.path.join(HERE, "fixtures", "sb-pass-clean_cii.xml")

#: The frozen wording for a generic (non-CII, non-UBL) unsupported root —
#: byte-for-byte the original single S-ROOT message. If
#: ``validate.S_ROOT_MESSAGE`` drifts from this, tests and goldens pinning the
#: structural leg go stale silently; fail loud here instead.
ORIGINAL_UBL_ONLY_MESSAGE = (
    "Root element must be Invoice in the UBL Invoice-2 namespace, or "
    "CreditNote in the UBL CreditNote-2 namespace.")

#: A well-formed XML document that is genuinely not an e-invoice in either
#: supported syntax (the shape the spec names: a build-configuration file
#: someone pointed the CI gate at by mistake).
UNSUPPORTED_ROOT_XML = (
    b'<?xml version="1.0" encoding="UTF-8"?>\n'
    b'<buildConfigurations xmlns="urn:example:build">\n'
    b'  <configuration name="release"><optimize>true</optimize></configuration>\n'
    b'</buildConfigurations>\n')


def _run_cli(*cli_args):
    """Run ``python3 -m einvoice <args>`` (packaged entry point) and return
    (returncode, stdout+stderr text). Same helper shape as
    test_cii_creditnote.py."""
    proc = subprocess.run(
        [sys.executable, "-m", "einvoice", *cli_args],
        cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        universal_newlines=True)
    return proc.returncode, proc.stdout


class RawCiiIsGraded(unittest.TestCase):
    """Text form: a clean raw CII invoice PASSES, a broken one fails on its
    real business rule. Neither answer is S-ROOT."""

    def test_clean_cii_passes_with_exit_zero(self):
        for path in (CII_GOOD, CII_GOOD_2):
            with self.subTest(path=os.path.basename(path)):
                self.assertTrue(os.path.isfile(path), path)
                rc, out = _run_cli("validate", path)
                self.assertEqual(
                    rc, EXIT_OK,
                    "a business-rule-clean raw CII invoice must exit 0: %s"
                    % out)
                self.assertIn("PASS:", out)
                self.assertNotIn("S-ROOT", out)
                self.assertNotIn("Traceback", out)

    def test_broken_cii_fails_on_the_real_rule_not_s_root(self):
        rc, out = _run_cli("validate", CII_BAD)
        self.assertEqual(rc, EXIT_FAIL, out)
        self.assertIn("FAIL:", out)
        self.assertIn("BR-05", out)
        self.assertNotIn("S-ROOT", out)
        self.assertNotIn("Traceback", out)


class RawCiiIsGradedJson(unittest.TestCase):
    """--json form carries the same graded verdict and rule ids."""

    def test_clean_cii_json_is_valid_true_with_no_violations(self):
        rc, out = _run_cli("validate", "--json", CII_GOOD)
        self.assertEqual(rc, EXIT_OK, out)
        rep = json.loads(out)
        self.assertIs(rep["valid"], True)
        self.assertEqual([v["rule"] for v in rep["violations"]], [])

    def test_broken_cii_json_names_br05_fatal(self):
        rc, out = _run_cli("validate", "--json", CII_BAD)
        self.assertEqual(rc, EXIT_FAIL, out)
        rep = json.loads(out)
        self.assertIs(rep["valid"], False)
        self.assertEqual([v["rule"] for v in rep["violations"]], ["BR-05"])
        self.assertEqual(rep["violations"][0]["severity"], "fatal")


class UnsupportedRootStillRefused(unittest.TestCase):
    """A genuinely unsupported root keeps the structural S-ROOT fatal, exit 1,
    and the byte-frozen UBL-only wording. The fixture is written into a temp
    directory this test owns and removes — no gate writes outside the repo."""

    tmpdir = None

    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.mkdtemp(prefix="einvoice-unsupported-root-")
        cls.path = os.path.join(cls.tmpdir, "buildConfigurations.xml")
        with open(cls.path, "wb") as fh:
            fh.write(UNSUPPORTED_ROOT_XML)

    @classmethod
    def tearDownClass(cls):
        if cls.tmpdir is not None:
            shutil.rmtree(cls.tmpdir, ignore_errors=True)

    def test_cli_text_reports_s_root_with_exit_one(self):
        rc, out = _run_cli("validate", self.path)
        self.assertEqual(rc, EXIT_FAIL, out)
        self.assertIn("FAIL:", out)
        self.assertIn("S-ROOT", out)
        self.assertIn(ORIGINAL_UBL_ONLY_MESSAGE, out)
        self.assertNotIn("Traceback", out)

    def test_cli_json_reports_s_root_fatal(self):
        rc, out = _run_cli("validate", "--json", self.path)
        self.assertEqual(rc, EXIT_FAIL, out)
        rep = json.loads(out)
        self.assertIs(rep["valid"], False)
        self.assertEqual([v["rule"] for v in rep["violations"]], ["S-ROOT"])
        v = rep["violations"][0]
        self.assertEqual(v["severity"], "fatal")
        self.assertEqual(v["message"], ORIGINAL_UBL_ONLY_MESSAGE)
        self.assertEqual(v["element"], "buildConfigurations")

    def test_api_reports_s_root(self):
        result = einvoice.validate_file(io.BytesIO(UNSUPPORTED_ROOT_XML))
        self.assertFalse(result.valid)
        (sroot,) = [v for v in result.violations if v.rule_id == "S-ROOT"]
        self.assertEqual(sroot.message, ORIGINAL_UBL_ONLY_MESSAGE)

    def test_module_constant_is_frozen_original(self):
        self.assertEqual(_validate.S_ROOT_MESSAGE, ORIGINAL_UBL_ONLY_MESSAGE)


class CliAgreesWithValidateBytes(unittest.TestCase):
    """THE regression this task fixes, pinned directly: the raw-XML surface and
    the public ``einvoice.validate_bytes`` must return the same verdict and the
    same rule ids for the same bytes. They disagreed before 0.2.7."""

    def test_same_verdict_and_rules_for_each_fixture(self):
        for path in (CII_GOOD, CII_GOOD_2, CII_BAD):
            with self.subTest(path=os.path.basename(path)):
                with open(path, "rb") as fh:
                    api = einvoice.validate_bytes(
                        fh.read(), filename=path, profile="en16931")
                rc, out = _run_cli("validate", "--json", path)
                cli = json.loads(out)
                self.assertIs(cli["valid"], api["valid"])
                self.assertEqual(
                    sorted(v["rule"] for v in cli["violations"]),
                    sorted(v["rule"] for v in api["violations"]))
                self.assertEqual(rc, EXIT_OK if api["valid"] else EXIT_FAIL)


class WrongNamespaceCiiTakesTheCiiRoute(unittest.TestCase):
    """Namespace-tolerant match: a CrossIndustryInvoice root OUTSIDE the rsm
    namespace (a common integrator slip) is graded on the CII engine, exactly
    as the Factur-X container path has always graded it — so it fails on the
    real EN 16931 mandatory-term rules, not on a structural refusal. Pinned
    against ``validate_bytes`` so the two routes can never diverge."""

    XML = (b'<CrossIndustryInvoice xmlns="urn:example:not-the-rsm-ns">'
           b'<x/></CrossIndustryInvoice>')

    def test_graded_by_the_cii_engine(self):
        result = einvoice.validate_file(io.BytesIO(self.XML))
        self.assertFalse(result.valid)
        fired = {v.rule_id for v in result.violations}
        self.assertNotIn("S-ROOT", fired)
        # An empty CII shell is missing every mandatory term; BR-01
        # (specification identifier) is the canonical first one.
        self.assertIn("BR-01", fired)

    def test_matches_validate_bytes(self):
        api = einvoice.validate_bytes(self.XML, profile="en16931")
        result = einvoice.validate_file(io.BytesIO(self.XML))
        self.assertEqual(
            sorted(v["rule"] for v in api["violations"]),
            sorted(v.rule_id for v in result.violations))


if __name__ == "__main__":
    unittest.main(verbosity=2)

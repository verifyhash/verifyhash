#!/usr/bin/env python3
"""test_cli_cii_root.py — pin the ACTIONABLE S-ROOT message for a genuine
CII root on the raw-XML validate path (T-VHUX.5).

Fast, stdlib-only, saxonche-free, offline.

WHY: ZUGFeRD/Factur-X (CII) is the dominant German e-invoice format. The
raw-XML CLI surface (``einvoice validate <file>``) is honestly UBL-only BY
DESIGN (pinned in coverage.py "CII credit-note scope" and by
``test_cii_creditnote.py``) — a raw CII file gets a structural S-ROOT fatal,
exit 1. That contract is UNCHANGED here. What changed (message text ONLY):
when the unsupported root IS a ``CrossIndustryInvoice``, the S-ROOT message
now names the supported route — validate the Factur-X/ZUGFeRD PDF with
``python3 -m einvoice.report <invoice.pdf>`` — instead of implying only UBL
exists. A misleading "must be UBL" dead end on a valid CII file is exactly
the minute-one failure that loses an ERP-integrator adopter.

PINNED CONTRACT:

  1. BEHAVIOR UNCHANGED: raw CII on ``validate`` still fails fatal with rule
     id ``S-ROOT`` and exit 1 (``EXIT_FAIL``), in text and ``--json`` form.
     No raw-CII dispatch was added; verdict/severity/exit identical.
  2. The CII-case message names the CII/Factur-X/ZUGFeRD container route and
     the real command (``python3 -m einvoice.report``) — no invented flag.
  3. A non-CII, non-UBL root keeps the ORIGINAL UBL-only wording exactly
     (``validate.S_ROOT_MESSAGE``, byte-frozen below).
  4. The CII match is by LOCALNAME (namespace-tolerant): a CrossIndustryInvoice
     root in a wrong/blank namespace still earns the helpful pointer.

Committed fixtures exercised (never mutated): ``fixtures/creditnote-valid_cii.xml``
and ``fixtures/sb-pass-clean_cii.xml``.
"""

import io
import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import einvoice  # noqa: E402
from einvoice import validate as _validate  # noqa: E402
from einvoice.cli import EXIT_FAIL  # noqa: E402

CII_FIXTURES = [
    os.path.join(HERE, "fixtures", "creditnote-valid_cii.xml"),
    os.path.join(HERE, "fixtures", "sb-pass-clean_cii.xml"),
]

#: The frozen ORIGINAL wording for a generic (non-CII) unsupported root —
#: byte-for-byte the pre-T-VHUX.5 single message. If validate.S_ROOT_MESSAGE
#: drifts from this, tests/goldens pinning the generic leg go stale silently;
#: fail loud here instead.
ORIGINAL_UBL_ONLY_MESSAGE = (
    "Root element must be Invoice in the UBL Invoice-2 namespace, or "
    "CreditNote in the UBL CreditNote-2 namespace.")


def _run_cli(*cli_args):
    """Run ``python3 -m einvoice <args>`` (packaged entry point) and return
    (returncode, stdout text). Same helper shape as test_cii_creditnote.py."""
    proc = subprocess.run(
        [sys.executable, "-m", "einvoice", *cli_args],
        cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        universal_newlines=True)
    return proc.returncode, proc.stdout


class CiiRootMessageText(unittest.TestCase):
    """Text form: exit 1, S-ROOT, and a message naming the container route."""

    def test_validate_text_exit_and_actionable_message(self):
        for path in CII_FIXTURES:
            with self.subTest(path=os.path.basename(path)):
                self.assertTrue(os.path.isfile(path), path)
                rc, out = _run_cli("validate", path)
                # (i) behavior unchanged: fatal S-ROOT, exit 1, no traceback.
                self.assertEqual(rc, EXIT_FAIL,
                                 "raw CII via `validate` exits 1: %s" % out)
                self.assertIn("FAIL:", out)
                self.assertIn("S-ROOT", out)
                self.assertNotIn("Traceback", out)
                # (ii) the message names the CII/Factur-X/ZUGFeRD route and
                # the REAL command for it (no invented flag).
                self.assertIn("CrossIndustryInvoice (CII) root detected", out)
                self.assertIn("ZUGFeRD/Factur-X", out)
                self.assertIn("python3 -m einvoice.report", out)
                # The old misleading implication is gone for the CII case.
                self.assertNotIn(ORIGINAL_UBL_ONLY_MESSAGE, out)


class CiiRootMessageJson(unittest.TestCase):
    """--json form: same verdict/rule/severity, new message text."""

    def test_validate_json_exit_and_actionable_message(self):
        for path in CII_FIXTURES:
            with self.subTest(path=os.path.basename(path)):
                rc, out = _run_cli("validate", "--json", path)
                self.assertEqual(rc, EXIT_FAIL)
                rep = json.loads(out)
                self.assertIs(rep["valid"], False)
                self.assertEqual(
                    [v["rule"] for v in rep["violations"]], ["S-ROOT"])
                v = rep["violations"][0]
                self.assertEqual(v["severity"], "fatal")
                self.assertEqual(v["message"], _validate.S_ROOT_CII_MESSAGE)
                self.assertIn("ZUGFeRD/Factur-X", v["message"])
                self.assertIn("python3 -m einvoice.report", v["message"])


class NonCiiRootKeepsOriginalWording(unittest.TestCase):
    """A non-CII, non-UBL root keeps the ORIGINAL UBL-only message exactly —
    the helpful pointer is CII-scoped, everything else is byte-untouched."""

    def test_generic_wrong_root_message_unchanged(self):
        # Same in-memory pattern test_creditnote_scope.py uses for the
        # out-of-scope leg; validate_file accepts a binary buffer directly.
        xml = b'<catalog xmlns="urn:example:unrelated"><entry/></catalog>'
        result = einvoice.validate_file(io.BytesIO(xml))
        self.assertFalse(result.valid)
        rules_fired = {v.rule_id for v in result.violations}
        self.assertIn("S-ROOT", rules_fired)
        (sroot,) = [v for v in result.violations if v.rule_id == "S-ROOT"]
        self.assertEqual(sroot.message, ORIGINAL_UBL_ONLY_MESSAGE)
        self.assertNotIn("Factur-X", sroot.message)

    def test_module_constant_is_frozen_original(self):
        self.assertEqual(_validate.S_ROOT_MESSAGE, ORIGINAL_UBL_ONLY_MESSAGE)


class WrongNamespaceCiiStillGetsPointer(unittest.TestCase):
    """Namespace-tolerant match: a CrossIndustryInvoice root OUTSIDE the rsm
    namespace (a common integrator slip) still earns the actionable text."""

    def test_wrong_namespace_cii_root(self):
        xml = (b'<CrossIndustryInvoice xmlns="urn:example:not-the-rsm-ns">'
               b'<x/></CrossIndustryInvoice>')
        result = einvoice.validate_file(io.BytesIO(xml))
        self.assertFalse(result.valid)
        (sroot,) = [v for v in result.violations if v.rule_id == "S-ROOT"]
        self.assertEqual(sroot.message, _validate.S_ROOT_CII_MESSAGE)
        self.assertEqual(sroot.element, "CrossIndustryInvoice")


if __name__ == "__main__":
    unittest.main(verbosity=2)

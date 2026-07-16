#!/usr/bin/env python3
"""test_creditnote_scope.py — pin the UBL CreditNote validation contract
through the user-facing surfaces (T-VHCN.2, updated from T-VHCN.1).

Fast, stdlib-only, saxonche-free, offline. This is the surface-level companion
to ``test_creditnote_validation.py`` (which grades the CreditNote rule engine
against the vendored corpus ground truth). Here we pin what a USER reaching for
each entry point actually sees, now that a UBL 2.1 ``CreditNote`` (root
``{urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2}CreditNote``) is a
first-class EN 16931 document routed through the SAME shared BR-* rule engine as
an Invoice.

Superseding the old T-VHCN.1 contract (a CreditNote was rejected at the root
with a fatal ``S-ROOT``), the NEW proven contract is:

  * a business-rule-clean CreditNote is REALLY validated and PASSES — exit 0,
    ``valid=true``, no ``S-ROOT``, no silent skip, no uncaught exception;
  * an invalid CreditNote FAILS on its content with the correct real business
    rule (here ``BR-CL-01`` for an out-of-range BT-3 credit-note type code) —
    exit 1, never a structural ``S-ROOT``;
  * the honest-error path is preserved for what is genuinely unsupported: a
    non-Invoice / non-CreditNote root still trips the fatal ``S-ROOT``.

Exercised through BOTH surfaces a user reaches:
  * the single-file path — ``python3 -m einvoice validate <cn.xml>`` (subprocess,
    packaged entry point) and ``einvoice.cli.main`` in-process, plus the
    embedding API ``einvoice.validate_file`` directly;
  * the batch path — the shared ``einvoice.report`` batch engine, proving a
    valid CreditNote is COUNTED as a passing file and an invalid one as a
    failing file (never silently skipped or dropped).

All CreditNote documents are committed corpus shapes (no new corpus invented);
the one crafted fixture is the deliberately-broken
``fixtures/creditnote-invalid-typecode_ubl.xml`` used to exercise the failing
direction. This test asserts REAL validation where proven and the honest error
where still unsupported — it is NOT weakened to merely pass.
"""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import einvoice  # noqa: E402
from einvoice.cli import main, EXIT_FAIL, EXIT_OK  # noqa: E402
from einvoice.report import (  # noqa: E402
    build_batch_report, batch_exit_code,
)

# Committed business-rule-clean UBL CreditNote shapes: really validated, PASS.
VALID_CREDITNOTE_FILES = [
    os.path.join(HERE, "corpus", "cen-en16931", "ubl", "examples",
                 "ubl-tc434-creditnote1.xml"),
    os.path.join(HERE, "corpus", "cen-en16931", "test", "testfiles",
                 "CreditNote-Max_content.xml"),
    os.path.join(HERE, "corpus", "cen-en16931", "test", "testfiles",
                 "CreditNote-Min_content_with_VAT.xml"),
]
# A committed invalid CreditNote: BT-3 CreditNoteTypeCode=999 (off the UNTDID
# 1001 credit-note sub-list) -> a real BR-CL-01 fatal, exit 1.
INVALID_CREDITNOTE_FILE = os.path.join(HERE, "fixtures",
                                       "creditnote-invalid-typecode_ubl.xml")
# A business-rule-clean UBL *Invoice* — used to prove a batch mixes a passing
# invoice with a failing CreditNote and still counts the CreditNote as a failure.
PASS_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                            "cen-bis3-positive_ubl.xml")

S_ROOT = "S-ROOT"
BR_CL_01 = "BR-CL-01"


class _Capture:
    """Run ``einvoice.cli.main(argv)`` in-process, capturing stdout+exit code."""

    def __init__(self, argv):
        self.argv = argv
        self.rc = None
        self.out = ""

    def __enter__(self):
        self._out = sys.stdout
        sys.stdout = io.StringIO()
        try:
            self.rc = main(self.argv)
        finally:
            self.out = sys.stdout.getvalue()
            sys.stdout = self._out
        return self

    def __exit__(self, *exc):
        return False


def _run_cli(*cli_args):
    """Run ``python3 -m einvoice <args>`` as a subprocess (packaged entry point).

    Returns (returncode, combined stdout+stderr text).
    """
    proc = subprocess.run(
        [sys.executable, "-m", "einvoice", *cli_args],
        cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        universal_newlines=True)
    return proc.returncode, proc.stdout


def _fatal_ids(result):
    return {v.rule_id for v in result.violations
            if getattr(v, "severity", "fatal") == "fatal"}


class ValidCreditNoteSingleFile(unittest.TestCase):
    """A clean UBL CreditNote is really validated and PASSES (not S-ROOT)."""

    def test_corpus_files_exist(self):
        for path in VALID_CREDITNOTE_FILES + [INVALID_CREDITNOTE_FILE]:
            self.assertTrue(os.path.isfile(path), "missing fixture: %s" % path)

    def test_embedding_api_passes_no_exception_no_sroot(self):
        for path in VALID_CREDITNOTE_FILES:
            with self.subTest(path=path):
                result = einvoice.validate_file(path)  # must not raise
                self.assertTrue(result.valid,
                                "clean CreditNote must pass: fatals=%s"
                                % sorted(_fatal_ids(result)))
                self.assertNotIn(S_ROOT, _fatal_ids(result),
                                 "a CreditNote must route through the engine, "
                                 "never S-ROOT")

    def test_cli_subprocess_exit0_pass(self):
        for path in VALID_CREDITNOTE_FILES:
            with self.subTest(path=path):
                rc, out = _run_cli("validate", path)
                self.assertEqual(rc, EXIT_OK,
                                 "clean CreditNote must exit 0, got %d" % rc)
                self.assertIn("PASS:", out)
                self.assertNotIn(S_ROOT, out)

    def test_cli_inprocess_json_valid_true_no_fatal(self):
        for path in VALID_CREDITNOTE_FILES:
            with self.subTest(path=path):
                with _Capture(["validate", path, "--json"]) as cap:
                    pass
                self.assertEqual(cap.rc, EXIT_OK)
                doc = json.loads(cap.out)
                self.assertTrue(doc["valid"])
                fatals = [v for v in doc["violations"]
                          if v["severity"] == "fatal"]
                self.assertEqual(fatals, [],
                                 "clean CreditNote carries no fatal")


class InvalidCreditNoteSingleFile(unittest.TestCase):
    """An invalid CreditNote FAILS on its real content, never on S-ROOT."""

    def test_embedding_api_fires_real_rule(self):
        result = einvoice.validate_file(INVALID_CREDITNOTE_FILE)  # must not raise
        self.assertFalse(result.valid, "invalid CreditNote must not pass")
        fatal = _fatal_ids(result)
        self.assertIn(BR_CL_01, fatal, "expected the real BR-CL-01 fatal")
        self.assertNotIn(S_ROOT, fatal,
                         "content failure, not a structural S-ROOT")

    def test_cli_subprocess_exit1_names_real_rule(self):
        rc, out = _run_cli("validate", INVALID_CREDITNOTE_FILE)
        self.assertEqual(rc, 1, "invalid CreditNote must exit 1, got %d" % rc)
        self.assertIn("FAIL:", out)
        self.assertIn(BR_CL_01, out)
        self.assertNotIn(S_ROOT, out)

    def test_cli_inprocess_json_valid_false_br_cl_01(self):
        with _Capture(["validate", INVALID_CREDITNOTE_FILE, "--json"]) as cap:
            pass
        self.assertEqual(cap.rc, EXIT_FAIL)
        doc = json.loads(cap.out)
        self.assertFalse(doc["valid"])
        rules = {v["rule"] for v in doc["violations"]
                 if v["severity"] == "fatal"}
        self.assertIn(BR_CL_01, rules)
        self.assertNotIn(S_ROOT, rules)


class CreditNoteBatchScope(unittest.TestCase):
    """A CreditNote in a batch is counted with its REAL verdict, never skipped."""

    def _make_mixed_dir(self, tmp):
        """One passing UBL Invoice + one passing CreditNote + one failing
        CreditNote under tmp — proves the batch counts each real verdict."""
        good_inv = os.path.join(tmp, "a-good-invoice.xml")
        with open(PASS_FIXTURE, "rb") as s, open(good_inv, "wb") as d:
            d.write(s.read())
        good_cn = os.path.join(tmp, "b-good-creditnote.xml")
        with open(VALID_CREDITNOTE_FILES[0], "rb") as s, open(good_cn, "wb") as d:
            d.write(s.read())
        bad_cn = os.path.join(tmp, "c-bad-creditnote.xml")
        with open(INVALID_CREDITNOTE_FILE, "rb") as s, open(bad_cn, "wb") as d:
            d.write(s.read())
        return good_inv, good_cn, bad_cn

    def test_batch_engine_counts_creditnote_verdicts(self):
        with tempfile.TemporaryDirectory() as tmp:
            _gi, good_cn, bad_cn = self._make_mixed_dir(tmp)
            batch = build_batch_report(tmp, profile="en16931")
            self.assertEqual(batch["file_count"], 3)
            # Exactly the failing CreditNote fails; the aggregate exit is 1.
            self.assertEqual(batch["failed_file_count"], 1)
            self.assertEqual(batch_exit_code(batch), EXIT_FAIL)

            def _report(path):
                return next(r for r in batch["files"]
                            if os.path.abspath(r["source"]) == os.path.abspath(path))

            # The clean CreditNote is counted as a PASS (not skipped, not S-ROOT).
            good = _report(good_cn)
            self.assertTrue(good["valid"], "clean CreditNote must pass in a batch")
            self.assertNotIn(S_ROOT,
                             {v["rule"] for v in good["violations"]})
            # The broken CreditNote is counted as a FAIL on its real rule.
            bad = _report(bad_cn)
            self.assertFalse(bad["valid"])
            self.assertGreaterEqual(bad["fatal_count"], 1)
            rules = {v["rule"] for v in bad["violations"]}
            self.assertIn(BR_CL_01, rules)
            self.assertNotIn(S_ROOT, rules)

    def test_batch_cli_subprocess_reports_both_creditnotes(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._make_mixed_dir(tmp)
            rc, out = _run_cli("validate-batch", tmp, "--json")
            self.assertEqual(rc, 1, "the failing CreditNote must fail the batch")
            doc = json.loads(out)
            self.assertEqual(doc["file_count"], 3)
            self.assertEqual(doc["failed_file_count"], 1)
            # Both CreditNotes are present in the per-file array (not dropped).
            good = [r for r in doc["files"]
                    if "b-good-creditnote.xml" in r["source"]]
            bad = [r for r in doc["files"]
                   if "c-bad-creditnote.xml" in r["source"]]
            self.assertEqual(len(good), 1)
            self.assertEqual(len(bad), 1)
            self.assertTrue(good[0]["valid"])
            self.assertFalse(bad[0]["valid"])
            self.assertIn(BR_CL_01, {v["rule"] for v in bad[0]["violations"]})


class UnsupportedRootStaysHonestError(unittest.TestCase):
    """What is genuinely out of scope still gets the honest S-ROOT fatal."""

    def test_unrelated_root_exit1_sroot(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "not-an-invoice.xml")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write('<catalog xmlns="urn:example:unrelated"><x/></catalog>')
            result = einvoice.validate_file(path)
            self.assertFalse(result.valid)
            self.assertIn(S_ROOT, {v.rule_id for v in result.violations})
            rc, out = _run_cli("validate", path)
            self.assertEqual(rc, 1)
            self.assertIn(S_ROOT, out)


if __name__ == "__main__":
    unittest.main(verbosity=2)

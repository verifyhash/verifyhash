#!/usr/bin/env python3
"""test_creditnote_scope.py — pin the UBL CreditNote honest-scope contract
(T-VHCN.1).

Fast, stdlib-only, saxonche-free, offline. This is a MEASURE-FIRST guard, not a
feature: it does NOT add any CreditNote parsing. It locks in the ONE behaviour
this engine actually offers for a UBL 2.1 ``CreditNote`` document — a clean,
actionable rejection rather than a crash or a silent pass — so that behaviour
cannot regress into either failure mode.

A UBL CreditNote has the root element
``{urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2}CreditNote``. The
parser's ``build_model()`` sets ``root_is_ubl_invoice=False`` for it, and the
structural layer fires the fatal ``S-ROOT`` rule (see ``einvoice/validate.py``).
The result is: exit code 1, a single fatal ``S-ROOT`` finding whose human
message names the offending ``CreditNote`` root element, ``valid=false``, no
silent pass, and no uncaught exception.

This is exercised through BOTH surfaces a user reaches:
  * the single-file path — ``python3 -m einvoice validate <creditnote.xml>``
    (subprocess, packaged entry point) and ``einvoice.cli.main`` in-process, plus
    the embedding API ``einvoice.validate_file`` directly;
  * the batch path — ``python3 -m einvoice validate-batch <dir>`` (which reuses
    the shared ``einvoice.report`` batch engine), proving a CreditNote inside a
    batch is COUNTED as a failing file, never silently skipped or dropped.

Both existing committed corpus CreditNote shapes are checked (no new corpus is
invented):
  * ``corpus/cen-en16931/ubl/examples/ubl-tc434-creditnote1.xml``
  * ``corpus/cen-en16931/test/testfiles/CreditNote-Max_content.xml``

Full CreditNote EN 16931 validation is deliberately OUT OF SCOPE (it needs a
CreditNote parser model plus a proven CreditNote differential corpus); see
``COVERAGE.md`` and README.md. This test only proves the honest rejection path,
so it must never require changing a rule, a fire decision, ``differential.py`` or
any golden file.
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
from einvoice.cli import main, EXIT_FAIL  # noqa: E402
from einvoice.report import (  # noqa: E402
    build_batch_report, batch_exit_code,
)

# The two committed UBL CreditNote shapes (root element = CreditNote). Both must
# be cleanly rejected with the S-ROOT structural fatal — never crashed, never
# silently passed.
CREDITNOTE_FILES = [
    os.path.join(HERE, "corpus", "cen-en16931", "ubl", "examples",
                 "ubl-tc434-creditnote1.xml"),
    os.path.join(HERE, "corpus", "cen-en16931", "test", "testfiles",
                 "CreditNote-Max_content.xml"),
]
# A business-rule-clean UBL *Invoice* — used to prove a batch mixes a passing
# invoice with a failing CreditNote and still counts the CreditNote as a failure.
PASS_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                            "cen-bis3-positive_ubl.xml")

# What a correct rejection looks like, asserted verbatim.
S_ROOT = "S-ROOT"
CREDITNOTE_ROOT = "CreditNote"


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

    Returns (returncode, combined stdout+stderr text). Proves the installed
    dispatcher, not just the in-process function.
    """
    proc = subprocess.run(
        [sys.executable, "-m", "einvoice", *cli_args],
        cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        universal_newlines=True)
    return proc.returncode, proc.stdout


class CreditNoteSingleFileScope(unittest.TestCase):
    """The single-file path cleanly rejects a UBL CreditNote (no crash, no pass)."""

    def test_corpus_files_exist(self):
        # Guard against a silently-moved corpus: the whole test is only
        # meaningful if these committed CreditNote documents are present.
        for path in CREDITNOTE_FILES:
            self.assertTrue(os.path.isfile(path), "missing corpus file: %s" % path)

    def test_embedding_api_no_exception_valid_false_sroot(self):
        # einvoice.validate_file must NOT raise on a CreditNote (no uncaught
        # exception / traceback) and must return a fatal S-ROOT finding with
        # valid=false — the silent-pass failure mode is explicitly excluded.
        for path in CREDITNOTE_FILES:
            with self.subTest(path=path):
                result = einvoice.validate_file(path)  # must not raise
                self.assertFalse(result.valid,
                                 "CreditNote must not silently pass")
                fatal = [v for v in result.violations
                         if getattr(v, "severity", "fatal") == "fatal"]
                self.assertTrue(fatal, "expected a fatal finding")
                sroot = [v for v in fatal if v.rule_id == S_ROOT]
                self.assertTrue(sroot, "expected the fatal S-ROOT rule to fire")
                # The finding names the offending CreditNote root element.
                self.assertEqual(sroot[0].element, CREDITNOTE_ROOT)

    def test_cli_subprocess_exit1_names_creditnote_root(self):
        # The packaged ``python3 -m einvoice validate`` path: exit 1, output
        # contains S-ROOT and names the CreditNote root element.
        for path in CREDITNOTE_FILES:
            with self.subTest(path=path):
                rc, out = _run_cli("validate", path)
                self.assertEqual(rc, 1, "CreditNote must exit 1, got %d" % rc)
                self.assertIn(S_ROOT, out)
                self.assertIn(CREDITNOTE_ROOT, out)
                # The human summary attributes the failure to the root element.
                self.assertIn("offending element: %s" % CREDITNOTE_ROOT, out)
                self.assertIn("FAIL:", out)

    def test_cli_inprocess_json_valid_false_sroot_fatal(self):
        # The same path in-process, via --json, so we can assert on the machine
        # record: valid=false, a single fatal S-ROOT violation on CreditNote.
        for path in CREDITNOTE_FILES:
            with self.subTest(path=path):
                with _Capture(["validate", path, "--json"]) as cap:
                    pass
                self.assertEqual(cap.rc, EXIT_FAIL)
                doc = json.loads(cap.out)
                self.assertFalse(doc["valid"])
                sroot = [v for v in doc["violations"]
                         if v["rule"] == S_ROOT and v["severity"] == "fatal"]
                self.assertEqual(len(sroot), 1)
                self.assertEqual(sroot[0]["element"], CREDITNOTE_ROOT)


class CreditNoteBatchScope(unittest.TestCase):
    """A CreditNote inside a batch is counted as a FAILURE, never skipped."""

    def _make_mixed_dir(self, tmp):
        """One passing UBL Invoice + one CreditNote (the fatal one) under tmp."""
        good = os.path.join(tmp, "a-good-invoice.xml")
        with open(PASS_FIXTURE, "rb") as src, open(good, "wb") as dst:
            dst.write(src.read())
        cn = os.path.join(tmp, "b-creditnote.xml")
        with open(CREDITNOTE_FILES[0], "rb") as src, open(cn, "wb") as dst:
            dst.write(src.read())
        return good, cn

    def test_batch_engine_counts_creditnote_as_failure(self):
        # Drive the shared einvoice.report batch engine directly: the CreditNote
        # entry is a fatal S-ROOT failure and the aggregate exit code is 1.
        with tempfile.TemporaryDirectory() as tmp:
            _good, cn = self._make_mixed_dir(tmp)
            batch = build_batch_report(tmp, profile="en16931")
            self.assertEqual(batch["file_count"], 2)
            # The CreditNote is counted among the failed files (not skipped).
            self.assertGreaterEqual(batch["failed_file_count"], 1)
            self.assertEqual(batch_exit_code(batch), EXIT_FAIL)
            cn_report = next(r for r in batch["files"]
                             if os.path.abspath(r["source"]) == os.path.abspath(cn))
            self.assertFalse(cn_report["valid"], "CreditNote must not pass")
            self.assertGreaterEqual(cn_report["fatal_count"], 1)
            sroot = [v for v in cn_report["violations"] if v["rule"] == S_ROOT]
            self.assertTrue(sroot, "expected S-ROOT fatal on the CreditNote")
            self.assertEqual(sroot[0]["severity"], "fatal")

    def test_batch_cli_subprocess_exit1_reports_creditnote(self):
        # The packaged ``python3 -m einvoice validate-batch <dir>`` path: exit 1
        # (fatal outranks pass), the CreditNote is reported (not dropped), and
        # S-ROOT is named in the JSON aggregate.
        with tempfile.TemporaryDirectory() as tmp:
            _good, _cn = self._make_mixed_dir(tmp)
            rc, out = _run_cli("validate-batch", tmp, "--json")
            self.assertEqual(rc, 1, "a CreditNote in a batch must fail (exit 1)")
            doc = json.loads(out)
            self.assertEqual(doc["file_count"], 2)
            self.assertGreaterEqual(doc["failed_file_count"], 1)
            self.assertGreaterEqual(doc["fatal_count"], 1)
            # The CreditNote file is present in the per-file array (not skipped)
            # and carries the fatal S-ROOT finding — no silent drop.
            cn_reports = [r for r in doc["files"]
                          if "b-creditnote.xml" in r["source"]]
            self.assertEqual(len(cn_reports), 1)
            self.assertFalse(cn_reports[0]["valid"])
            rules = [v["rule"] for v in cn_reports[0]["violations"]]
            self.assertIn(S_ROOT, rules)

    def test_batch_human_summary_marks_creditnote_failed(self):
        # The non-JSON human batch summary marks the CreditNote as FAIL and the
        # tally reports a failed file — the CreditNote is not silently absorbed.
        with tempfile.TemporaryDirectory() as tmp:
            self._make_mixed_dir(tmp)
            rc, out = _run_cli("validate-batch", tmp)
            self.assertEqual(rc, 1)
            self.assertIn("FAIL", out)
            self.assertIn("b-creditnote.xml", out)
            self.assertIn("1 failed", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)

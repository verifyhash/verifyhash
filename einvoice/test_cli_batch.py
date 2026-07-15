#!/usr/bin/env python3
"""test_cli_batch.py — pin the first-class ``einvoice validate-batch`` subcommand
(T-VHCLI.2).

Fast, stdlib-only, saxonche-free, offline. Exercises the main-CLI batch
subcommand as a subprocess (``python3 -m einvoice validate-batch <dir|glob>``)
so it proves the packaged dispatcher path, and in-process
(``einvoice.cli.main``) where that is cheaper. It reuses the EXISTING committed
corpus fixtures (no new corpus is added):

  * a business-rule-clean UBL invoice (``cen-bis3-positive_ubl.xml``) -> PASS
    under the CLI default profile (en16931);
  * a UBL *CreditNote* (``ubl-tc434-creditnote1.xml``) -> hits the S-ROOT
    structural FATAL under en16931 -> FAIL;
  * a hostile DOCTYPE/entity file synthesised into the temp dir -> the hardened
    parser rejects it, so it is reported as an ERROR (not parsed, no crash).

Asserted (each maps to a task acceptance criterion):
  1. ``validate-batch <dir>`` prints a per-file PASS/FAIL/ERROR summary and
     returns 1 when a fatal is present.
  2. ``validate-batch <glob>`` gives byte-identical aggregate counts + exit code
     to the directory form over the same file set.
  3. A DOCTYPE/entity file in the batch is reported as an ERROR (hardened parser
     applies) and does not abort the batch.
  4. ``--json`` emits the aggregate batch schema dict; ``--quiet`` suppresses the
     human summary but preserves the exit code.
  5. An all-pass dir -> exit 0; an empty dir / zero-match glob -> file_count 0 +
     explicit note + exit 0, no traceback.
"""

import io
import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.cli import (  # noqa: E402
    main, EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE,
)

# Business-rule-clean UBL invoice: PASS under the CLI default profile en16931.
PASS_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                            "cen-bis3-positive_ubl.xml")
# A UBL CreditNote root -> S-ROOT structural fatal under en16931 -> FAIL.
FAIL_FIXTURE = os.path.join(HERE, "corpus", "cen-en16931", "ubl", "examples",
                            "ubl-tc434-creditnote1.xml")
# A hostile DOCTYPE/entity payload: the hardened parser refuses to parse it, so
# it is folded into an ERROR entry rather than being expanded or crashing.
HOSTILE_XML = (
    b'<?xml version="1.0"?>\n'
    b'<!DOCTYPE Invoice [<!ENTITY x "expand-me">]>\n'
    b'<Invoice>&x;</Invoice>\n'
)


def _copy(src, dest):
    with open(src, "rb") as fh:
        data = fh.read()
    with open(dest, "wb") as out:
        out.write(data)


def make_mixed_dir(tmp):
    """One valid + one fatally-invalid + one hostile-DOCTYPE invoice under tmp.

    Returns (good_path, bad_path, hostile_path). All three end in ``.xml`` so
    both the directory walk and a ``*.xml`` glob collect exactly this set.
    """
    good = os.path.join(tmp, "a-good.xml")
    bad = os.path.join(tmp, "b-bad.xml")
    hostile = os.path.join(tmp, "c-hostile.xml")
    _copy(PASS_FIXTURE, good)
    _copy(FAIL_FIXTURE, bad)
    with open(hostile, "wb") as fh:
        fh.write(HOSTILE_XML)
    return good, bad, hostile


def _run(*cli_args):
    """Run the packaged CLI entry point as a subprocess."""
    return subprocess.run(
        [sys.executable, "-m", "einvoice", *cli_args],
        cwd=HERE, capture_output=True, text=True, timeout=180)


class _Capture:
    """Run ``main(argv)`` in-process, capturing stdout/stderr + exit code."""

    def __init__(self, argv):
        self.argv = argv

    def __enter__(self):
        self._out, self._err = sys.stdout, sys.stderr
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        self.code = main(self.argv)
        self.stdout = sys.stdout.getvalue()
        self.stderr = sys.stderr.getvalue()
        sys.stdout, sys.stderr = self._out, self._err
        return self

    def __exit__(self, *exc):
        return False


class ValidateBatchDir(unittest.TestCase):
    def test_dir_summary_and_exit_code_fatal(self):
        """(criterion 1 + 3) per-file PASS/FAIL/ERROR summary, exit 1 on fatal;
        the DOCTYPE file is an ERROR, not a crash, and the batch still runs."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            good, bad, hostile = make_mixed_dir(tmp)
            proc = _run("validate-batch", tmp)
        self.assertEqual(proc.returncode, EXIT_FAIL, proc.stderr)
        out = proc.stdout
        # one status line per file, correct verdict each
        self.assertIn("PASS  %s" % good, out)
        self.assertIn("FAIL  %s" % bad, out)
        self.assertIn("ERROR %s" % hostile, out)
        # the hostile file was NOT parsed — it is a not-well-formed ERROR
        self.assertRegex(out, r"ERROR .*c-hostile\.xml\s+not-well-formed")
        # aggregate tally line present
        self.assertIn("3 files:", out)

    def test_all_pass_dir_exit_zero(self):
        """(criterion 5) every file passes -> exit 0."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            _copy(PASS_FIXTURE, os.path.join(tmp, "g1.xml"))
            _copy(PASS_FIXTURE, os.path.join(tmp, "g2.xml"))
            proc = _run("validate-batch", tmp)
        self.assertEqual(proc.returncode, EXIT_OK, proc.stderr)
        self.assertIn("2 files: 2 passed, 0 failed", proc.stdout)

    def test_only_error_no_fatal_exit_parse(self):
        """A batch whose only failing file is a not-well-formed ERROR (no fatal)
        -> EXIT_PARSE (3), the documented fatal-outranks-parse precedence."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            _copy(PASS_FIXTURE, os.path.join(tmp, "good.xml"))
            with open(os.path.join(tmp, "hostile.xml"), "wb") as fh:
                fh.write(HOSTILE_XML)
            proc = _run("validate-batch", tmp)
        self.assertEqual(proc.returncode, EXIT_PARSE, proc.stderr)


class ValidateBatchGlob(unittest.TestCase):
    def test_glob_matches_dir_form(self):
        """(criterion 2) the glob form yields byte-identical aggregate counts +
        exit code to the directory form over the same file set."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            make_mixed_dir(tmp)
            dir_proc = _run("validate-batch", "--json", tmp)
            glob_proc = _run("validate-batch", "--json",
                             os.path.join(tmp, "*.xml"))
        self.assertEqual(dir_proc.returncode, glob_proc.returncode)
        dir_batch = json.loads(dir_proc.stdout)
        glob_batch = json.loads(glob_proc.stdout)
        for key in ("schema", "file_count", "fatal_count", "warning_count",
                    "violation_count", "failed_file_count"):
            self.assertEqual(dir_batch[key], glob_batch[key], key)
        # the per-file reports (and their order) are identical; only the 'root'
        # label (dir path vs glob pattern) differs between the two forms.
        self.assertEqual(dir_batch["files"], glob_batch["files"])
        dir_no_root = {k: v for k, v in dir_batch.items() if k != "root"}
        glob_no_root = {k: v for k, v in glob_batch.items() if k != "root"}
        self.assertEqual(dir_no_root, glob_no_root)

    def test_zero_match_glob_is_clean(self):
        """(criterion 5) a zero-match glob -> file_count 0 + note + exit 0."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            proc = _run("validate-batch", "--json",
                        os.path.join(tmp, "*.nope"))
        self.assertEqual(proc.returncode, EXIT_OK, proc.stderr)
        batch = json.loads(proc.stdout)
        self.assertEqual(batch["file_count"], 0)
        self.assertIn("no invoice files found", batch.get("note", ""))


class ValidateBatchFlags(unittest.TestCase):
    def test_json_emits_batch_schema(self):
        """(criterion 4) --json emits the aggregate batch schema dict."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            make_mixed_dir(tmp)
            proc = _run("validate-batch", "--json", tmp)
        self.assertEqual(proc.returncode, EXIT_FAIL, proc.stderr)
        batch = json.loads(proc.stdout)
        self.assertEqual(batch["schema"], "einvoice-conformance-batch/v1")
        self.assertEqual(batch["file_count"], 3)
        self.assertGreaterEqual(batch["fatal_count"], 1)
        self.assertGreaterEqual(batch["failed_file_count"], 2)  # bad + hostile

    def test_quiet_suppresses_summary_keeps_exit(self):
        """(criterion 4) --quiet suppresses the human summary but preserves the
        (nonzero) exit code."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            make_mixed_dir(tmp)
            proc = _run("validate-batch", "--quiet", tmp)
        self.assertEqual(proc.returncode, EXIT_FAIL, proc.stderr)
        self.assertEqual(proc.stdout, "", "quiet must suppress human summary")

    def test_quiet_json_still_emits_json(self):
        """--quiet --json still prints the aggregate JSON (quiet only silences
        the human summary), and keeps the exit code."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            make_mixed_dir(tmp)
            proc = _run("validate-batch", "--quiet", "--json", tmp)
        self.assertEqual(proc.returncode, EXIT_FAIL, proc.stderr)
        batch = json.loads(proc.stdout)
        self.assertEqual(batch["schema"], "einvoice-conformance-batch/v1")

    def test_profile_flag_honoured(self):
        """--profile is honoured: BR-DE-15 (a German-CIUS fatal, XRechnung only)
        fires on a BuyerReference-less invoice under xrechnung but not en16931,
        proving the flag reaches build_batch_report."""
        import re
        import tempfile
        base = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src",
                            "test", "business-cases", "standard",
                            "01.01a-INVOICE_ubl.xml")
        if not os.path.isfile(base):
            self.skipTest("xrechnung testsuite fixture absent")
        with open(base, encoding="utf-8") as fh:
            src = fh.read()
        bad = re.sub(r"<cbc:BuyerReference>[^<]*</cbc:BuyerReference>", "",
                     src, count=1)
        self.assertNotEqual(bad, src, "fixture drift: no BuyerReference")
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "no-buyer-ref.xml")
            with open(p, "w", encoding="utf-8") as fh:
                fh.write(bad)
            xr = _run("validate-batch", "--json", "--profile", "xrechnung", tmp)
            en = _run("validate-batch", "--json", "--profile", "en16931", tmp)
        xr_batch = json.loads(xr.stdout)
        en_batch = json.loads(en.stdout)
        xr_rules = [v["rule"] for r in xr_batch["files"]
                    for v in r.get("violations", [])]
        self.assertIn("BR-DE-15", xr_rules)
        self.assertEqual(xr.returncode, EXIT_FAIL)
        # en16931 does not apply the German CIUS layer -> this file passes.
        self.assertEqual(en_batch["fatal_count"], 0)
        self.assertEqual(en.returncode, EXIT_OK)


class ValidateBatchUsage(unittest.TestCase):
    def test_missing_argument_is_usage_error(self):
        with _Capture(["validate-batch"]) as cap:
            pass
        self.assertEqual(cap.code, EXIT_USAGE)
        self.assertIn("validate-batch", cap.stderr)

    def test_extra_argument_is_usage_error(self):
        with _Capture(["validate-batch", "a", "b"]) as cap:
            pass
        self.assertEqual(cap.code, EXIT_USAGE)


class SingleFileUnchanged(unittest.TestCase):
    """validate/receipt single-file behaviour must be untouched by the new
    subcommand (criterion 6). A spot-check that the plain validate path still
    passes/fails as before and validate-batch did not shadow it."""

    def test_validate_single_file_pass(self):
        with _Capture(["validate", PASS_FIXTURE]) as cap:
            pass
        self.assertEqual(cap.code, EXIT_OK, cap.stderr)
        self.assertIn("PASS", cap.stdout)

    def test_validate_single_file_fail(self):
        with _Capture(["validate", FAIL_FIXTURE]) as cap:
            pass
        self.assertEqual(cap.code, EXIT_FAIL, cap.stderr)
        self.assertIn("FAIL", cap.stdout)


if __name__ == "__main__":
    unittest.main()

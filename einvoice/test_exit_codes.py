#!/usr/bin/env python3
"""test_exit_codes.py — pin the einvoice CLI exit-code contract (T-VHDX.1).

Companion to ``EXIT-CODES.md``. For every documented terminal state this test
drives the LIVE CLI on a committed fixture and asserts BOTH:

  (a) the exact process return code, and
  (b) that the documented, actionable message substring appears on the
      documented stream (stdout or stderr) — we grep the message, not just the
      code, so a silent code that lost its explanation would still fail.

Because it recomputes against ``einvoice.cli.main`` (and a subprocess spot
check), it fails if any exit code or its actionable message ever drifts. It
adds NO new fixtures with real company data — it reuses the exact fixtures
already referenced by ``test_cli.py``:

  * a business-rule-clean UBL invoice        -> exit 0 (PASS)
  * a UBL *CreditNote* (out-of-scope root)   -> exit 1 (S-ROOT fatal)
  * a deliberately-truncated XML document    -> exit 3 (not-well-formed)
  * a missing file / unknown profile (argv)  -> exit 2 (usage)

Fast, stdlib-only, offline. Documentation + contract test only: it changes no
validation, rule, or report code.
"""

import io
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.cli import (  # noqa: E402
    main, EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE,
)

# Reused verbatim from test_cli.py — no new fixtures introduced.
PASS_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                            "cen-bis3-positive_ubl.xml")
FAIL_FIXTURE = os.path.join(HERE, "corpus", "cen-en16931", "ubl", "examples",
                            "ubl-tc434-creditnote1.xml")
MALFORMED_XML = b"<Invoice><never-closed>"


class _Capture:
    """Run ``main(argv)`` capturing stdout/stderr and the return code."""

    def __init__(self, argv):
        self.argv = argv
        self.rc = None
        self.out = ""
        self.err = ""

    def __enter__(self):
        self._out, self._err = sys.stdout, sys.stderr
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        self.rc = main(self.argv)
        self.out = sys.stdout.getvalue()
        self.err = sys.stderr.getvalue()
        return self

    def __exit__(self, *exc):
        sys.stdout, sys.stderr = self._out, self._err
        return False


class Fixtures(unittest.TestCase):
    def test_reused_fixtures_present(self):
        self.assertTrue(os.path.isfile(PASS_FIXTURE), PASS_FIXTURE)
        self.assertTrue(os.path.isfile(FAIL_FIXTURE), FAIL_FIXTURE)


class ExitCode0(unittest.TestCase):
    """0 = success / no fatal violations."""

    def test_pass_returncode_and_message(self):
        with _Capture(["validate", PASS_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)
            # Documented actionable message on stdout.
            self.assertIn("PASS:", cap.out)
            self.assertIn("all implemented fatal rules", cap.out)


class ExitCode1(unittest.TestCase):
    """1 = not-valid verdict / fatal violation. Out-of-scope inputs (a UBL
    CreditNote) fold into THIS code via the S-ROOT structural fatal — they are
    not a separate code, exactly as EXIT-CODES.md states."""

    def test_fatal_returncode_and_message(self):
        with _Capture(["validate", FAIL_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_FAIL)
            # Documented actionable message: FAIL + the failing rule id.
            self.assertIn("FAIL:", cap.out)
            self.assertIn("S-ROOT", cap.out)

    def test_unsupported_input_is_not_a_new_code(self):
        # The honest-note contract: an out-of-scope UBL CreditNote never
        # silently passes and never mints a distinct code; it is exit 1.
        with _Capture(["validate", FAIL_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_FAIL)
            self.assertNotEqual(cap.rc, EXIT_OK)


class ExitCode2(unittest.TestCase):
    """2 = usage error (bad args / missing file / unknown flag value)."""

    def test_missing_file_returncode_and_message(self):
        with _Capture(["validate", "does-not-exist.xml"]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("error: no such file", cap.err)

    def test_no_subcommand_returncode_and_message(self):
        with _Capture([]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("usage:", cap.err)

    def test_unknown_profile_returncode_and_message(self):
        with _Capture(["validate", "--profile=bogus", PASS_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("error: unknown profile", cap.err)


class ExitCode3(unittest.TestCase):
    """3 = not-well-formed XML / parse error (validate only)."""

    def test_not_well_formed_returncode_and_message(self):
        fd, tmp = tempfile.mkstemp(suffix=".xml")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(MALFORMED_XML)
            with _Capture(["validate", tmp]) as cap:
                self.assertEqual(cap.rc, EXIT_PARSE)
                # Documented actionable message on stderr.
                self.assertIn("S-WF: input is not well-formed XML", cap.err)
        finally:
            os.unlink(tmp)


class SubprocessSpotCheck(unittest.TestCase):
    """Prove the packaged entry point yields the same codes, not just the
    in-process main()."""

    def _run(self, *argv):
        return subprocess.run(
            [sys.executable, "-m", "einvoice", *argv],
            cwd=HERE, capture_output=True)

    def test_pass_and_fail_via_module(self):
        ok = self._run("validate", PASS_FIXTURE)
        self.assertEqual(ok.returncode, EXIT_OK, ok.stderr)
        bad = self._run("validate", FAIL_FIXTURE)
        self.assertEqual(bad.returncode, EXIT_FAIL, bad.stderr)


if __name__ == "__main__":
    unittest.main()

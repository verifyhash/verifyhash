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
  * an invalid UBL *CreditNote* (bad BT-3)   -> exit 1 (BR-CL-01 fatal)
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
    main, EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE, EXIT_INT, EXIT_TERM,
)

# Reused verbatim from test_cli.py — no new fixtures introduced.
PASS_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                            "cen-bis3-positive_ubl.xml")
FAIL_FIXTURE = os.path.join(HERE, "fixtures",
                            "creditnote-invalid-typecode_ubl.xml")
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
    """1 = not-valid verdict / fatal violation. A UBL CreditNote is really
    validated through the shared EN 16931 engine (T-VHCN.2), so an invalid one
    folds into THIS code via its real business-rule fatal (here BR-CL-01, an
    out-of-range BT-3 credit-note type code) — not a separate code."""

    def test_fatal_returncode_and_message(self):
        with _Capture(["validate", FAIL_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_FAIL)
            # Documented actionable message: FAIL + the failing rule id.
            self.assertIn("FAIL:", cap.out)
            self.assertIn("BR-CL-01", cap.out)

    def test_invalid_creditnote_is_not_a_new_code(self):
        # The honest contract: an invalid UBL CreditNote never silently passes
        # and never mints a distinct code; it is exit 1 like any invalid doc.
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


class SignalAbortCodes(unittest.TestCase):
    """130/143 = clean SIGINT/SIGTERM abort (T-VHPIPE.3, additive rows).

    The LIVE mid-run signal behavior — documented code, quiet stderr, no
    stray einvoice-stdin-* temp file — is driven end-to-end by
    ``test_interrupt.py``; here the contract table itself is pinned: the
    symbolic constants equal the 128+signal shell conventions, are distinct
    from every pre-existing code, and are documented in EXIT-CODES.md."""

    def test_constants_are_the_shell_conventions(self):
        self.assertEqual(EXIT_INT, 130)    # 128 + SIGINT(2)
        self.assertEqual(EXIT_TERM, 143)   # 128 + SIGTERM(15)

    def test_codes_are_additive_never_repurposed(self):
        existing = {EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE, 141}
        self.assertNotIn(EXIT_INT, existing)
        self.assertNotIn(EXIT_TERM, existing)

    def test_documented_in_exit_codes_md(self):
        with open(os.path.join(HERE, "EXIT-CODES.md"), encoding="utf-8") as fh:
            doc = fh.read()
        self.assertIn("`130`", doc)
        self.assertIn("`143`", doc)
        low = doc.lower()
        self.assertIn("sigint", low)
        self.assertIn("sigterm", low)


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

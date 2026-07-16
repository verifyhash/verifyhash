#!/usr/bin/env python3
"""test_fail_on.py — pin the OPT-IN ``--fail-on`` severity threshold (T-VHDX.2).

The ``einvoice`` CLI ships a post-validation exit-code knob:
``--fail-on {fatal,warning,information}`` on ``validate`` and ``validate-batch``.
It changes ONLY the process exit code — never the findings, the validation
logic, the ``--json`` payload bytes, or the human summary text. This test drives
the LIVE CLI (``einvoice.cli.main``) on committed, mixed-severity fixtures and
asserts, for every threshold:

  * the EXACT process return code for a clean / warning-only / information-only /
    fatal document, and for the batch aggregate;
  * that OMITTING ``--fail-on`` is byte-identical (stdout + exit code) to
    ``--fail-on fatal`` — i.e. today's default contract is untouched (the
    companion ``test_exit_codes.py`` still passes unchanged, proving the same);
  * that the ``--json`` payload and human summary text are byte-identical across
    thresholds (only the code differs);
  * that an INVALID ``--fail-on`` value is a usage error (exit 2) with an
    actionable stderr message — never a silent pass;
  * both flag forms (``--fail-on X`` and ``--fail-on=X``).

Fixtures are all already committed. Two are reused verbatim from
``test_exit_codes.py`` (a clean UBL invoice, an invalid UBL CreditNote); the
warning-only and information-only cases come from committed conformance-corpus
invoices under the ``xrechnung`` profile (the BR-DE CIUS layer is where non-fatal
findings live). No new fixtures with real company data are introduced.

Fast, stdlib-only, offline. Adds no validation, rule, or report code.
"""

import io
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.cli import (  # noqa: E402
    main, EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE,
)

# --- Committed fixtures, keyed by the severity they exhibit ------------------
# Clean + fatal are the EXACT fixtures test_exit_codes.py drives.
CLEAN_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                             "cen-bis3-positive_ubl.xml")   # en16931: no findings
FATAL_FIXTURE = os.path.join(HERE, "fixtures",
                             "creditnote-invalid-typecode_ubl.xml")  # fatal
# Warning-only / information-only under the xrechnung (BR-DE) profile.
WARN_FIXTURE = os.path.join(HERE, "corpus", "cen-en16931", "test", "testfiles",
                            "BIS_Billing_30-Resor_Bokning.xml")  # 1 warning, 0 fatal
INFO_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                            "xr-01.01a_ubl.xml")  # 1 information, 0 warn/fatal

LEVELS = ("fatal", "warning", "information")


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


class FixturesPresent(unittest.TestCase):
    def test_all_fixtures_committed_and_present(self):
        for f in (CLEAN_FIXTURE, FATAL_FIXTURE, WARN_FIXTURE, INFO_FIXTURE):
            self.assertTrue(os.path.isfile(f), f)


class ThresholdMatrixSingle(unittest.TestCase):
    """The exact exit code of ``validate --fail-on <level>`` on each fixture.

    Rows encode the intended semantics:
      * clean       -> never trips (0 at every level);
      * information -> trips only at ``information``;
      * warning     -> trips at ``warning`` and ``information``, not ``fatal``;
      * fatal       -> trips at every level.
    """

    # (base argv without the leading "validate", expected {level: rc})
    CASES = [
        ("clean", [CLEAN_FIXTURE],
         {"fatal": EXIT_OK, "warning": EXIT_OK, "information": EXIT_OK}),
        ("info", ["--profile=xrechnung", INFO_FIXTURE],
         {"fatal": EXIT_OK, "warning": EXIT_OK, "information": EXIT_FAIL}),
        ("warn", ["--profile=xrechnung", WARN_FIXTURE],
         {"fatal": EXIT_OK, "warning": EXIT_FAIL, "information": EXIT_FAIL}),
        ("fatal", [FATAL_FIXTURE],
         {"fatal": EXIT_FAIL, "warning": EXIT_FAIL, "information": EXIT_FAIL}),
    ]

    def test_matrix(self):
        for name, base, expected in self.CASES:
            for level, want in expected.items():
                with _Capture(["validate", "--fail-on", level] + base) as cap:
                    self.assertEqual(
                        cap.rc, want,
                        "%s @ --fail-on %s: got %s want %s"
                        % (name, level, cap.rc, want))

    def test_equals_form_matches_space_form(self):
        # `--fail-on=warning` must behave exactly like `--fail-on warning`.
        base = ["--profile=xrechnung", WARN_FIXTURE]
        with _Capture(["validate", "--fail-on=warning"] + base) as eq:
            with _Capture(["validate", "--fail-on", "warning"] + base) as sp:
                self.assertEqual(eq.rc, EXIT_FAIL)
                self.assertEqual(eq.rc, sp.rc)
                self.assertEqual(eq.out, sp.out)


class DefaultIsByteIdenticalToFailOnFatal(unittest.TestCase):
    """Omitting --fail-on == --fail-on fatal, in BOTH stdout and exit code —
    the historical contract is untouched. Checked for human + --json output."""

    ALL = [
        ["validate", CLEAN_FIXTURE],
        ["validate", FATAL_FIXTURE],
        ["validate", "--profile=xrechnung", WARN_FIXTURE],
        ["validate", "--profile=xrechnung", INFO_FIXTURE],
        ["validate", "--json", "--profile=xrechnung", WARN_FIXTURE],
        ["validate", "--json", FATAL_FIXTURE],
    ]

    def test_default_matches_fatal(self):
        for argv in self.ALL:
            with _Capture(list(argv)) as default:
                # Insert the flag right after the subcommand.
                fatal_argv = [argv[0], "--fail-on", "fatal"] + argv[1:]
                with _Capture(fatal_argv) as fatal:
                    self.assertEqual(default.rc, fatal.rc, argv)
                    self.assertEqual(default.out, fatal.out, argv)
                    self.assertEqual(default.err, fatal.err, argv)


class OutputUnchangedAcrossThresholds(unittest.TestCase):
    """--fail-on changes ONLY the exit code: the --json payload bytes and the
    human summary text are identical at every threshold."""

    def _outputs(self, base):
        outs = {}
        for level in LEVELS:
            with _Capture(["validate", "--fail-on", level] + base) as cap:
                outs[level] = cap.out
        return outs

    def test_human_summary_identical(self):
        base = ["--profile=xrechnung", WARN_FIXTURE]
        outs = self._outputs(base)
        self.assertEqual(outs["fatal"], outs["warning"])
        self.assertEqual(outs["fatal"], outs["information"])

    def test_json_payload_identical(self):
        base = ["--json", "--profile=xrechnung", WARN_FIXTURE]
        outs = self._outputs(base)
        self.assertEqual(outs["fatal"], outs["warning"])
        self.assertEqual(outs["fatal"], outs["information"])


class InvalidValueIsUsageError(unittest.TestCase):
    """An unknown --fail-on value is a usage error (2), not a silent pass."""

    def test_bogus_value_exits_usage_with_message(self):
        with _Capture(["validate", "--fail-on=bogus", CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("error: unknown --fail-on value", cap.err)
            self.assertIn("usage:", cap.err)
            # It must NOT have masqueraded as a clean pass.
            self.assertNotEqual(cap.rc, EXIT_OK)

    def test_missing_value_exits_usage(self):
        # `--fail-on` as the final token, no value.
        with _Capture(["validate", CLEAN_FIXTURE, "--fail-on"]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("--fail-on needs a value", cap.err)


class ParseAndUsagePathsUnaffected(unittest.TestCase):
    """--fail-on must not repaint EXIT_PARSE (3) or EXIT_USAGE (2) paths."""

    def test_not_well_formed_still_parse_error(self):
        fd, tmp = tempfile.mkstemp(suffix=".xml")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(b"<Invoice><never-closed>")
            for level in LEVELS:
                with _Capture(["validate", "--fail-on", level, tmp]) as cap:
                    self.assertEqual(cap.rc, EXIT_PARSE, level)
        finally:
            os.unlink(tmp)

    def test_missing_file_still_usage(self):
        with _Capture(["validate", "--fail-on", "warning",
                       "does-not-exist.xml"]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)


class ThresholdMatrixBatch(unittest.TestCase):
    """validate-batch applies the threshold across the aggregate: exit 1 if ANY
    file crosses it. The default equals --fail-on fatal, and the parse-only ->3
    rule is left intact when no file crosses."""

    def _make_dir(self, *fixtures):
        d = tempfile.mkdtemp(prefix="einvoice-failon-batch-")
        for i, f in enumerate(fixtures):
            shutil.copy(f, os.path.join(d, "f%d.xml" % i))
        self.addCleanup(shutil.rmtree, d)
        return d

    def _rc(self, argv):
        with _Capture(argv) as cap:
            return cap.rc

    def test_aggregate_threshold(self):
        # A batch with a warning-only file AND an information-only file, no fatal.
        d = self._make_dir(WARN_FIXTURE, INFO_FIXTURE)
        expected = {"fatal": EXIT_OK, "warning": EXIT_FAIL,
                    "information": EXIT_FAIL}
        for level, want in expected.items():
            rc = self._rc(["validate-batch", "--quiet", "--profile=xrechnung",
                           "--fail-on", level, d])
            self.assertEqual(rc, want, "batch @ --fail-on %s" % level)

    def test_information_only_batch(self):
        # No warning file: warning threshold must NOT trip; information must.
        d = self._make_dir(INFO_FIXTURE)
        self.assertEqual(
            self._rc(["validate-batch", "--quiet", "--profile=xrechnung",
                      "--fail-on", "warning", d]), EXIT_OK)
        self.assertEqual(
            self._rc(["validate-batch", "--quiet", "--profile=xrechnung",
                      "--fail-on", "information", d]), EXIT_FAIL)

    def test_default_equals_fatal(self):
        d = self._make_dir(WARN_FIXTURE, INFO_FIXTURE)
        default = self._rc(["validate-batch", "--quiet",
                            "--profile=xrechnung", d])
        fatal = self._rc(["validate-batch", "--quiet", "--profile=xrechnung",
                          "--fail-on", "fatal", d])
        self.assertEqual(default, fatal)
        self.assertEqual(default, EXIT_OK)

    def test_parse_only_stays_three(self):
        # A batch whose only file is malformed: batch returns 3 (error-only, no
        # file crosses ANY threshold) regardless of --fail-on level.
        d = tempfile.mkdtemp(prefix="einvoice-failon-badbatch-")
        self.addCleanup(shutil.rmtree, d)
        with open(os.path.join(d, "bad.xml"), "wb") as fh:
            fh.write(b"<Invoice><nope>")
        for level in LEVELS:
            rc = self._rc(["validate-batch", "--quiet", "--fail-on", level, d])
            self.assertEqual(rc, EXIT_PARSE, level)


if __name__ == "__main__":
    unittest.main()

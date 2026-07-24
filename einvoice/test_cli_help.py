"""Completeness guard for ``einvoice --help`` / ``-h``.

The point of this test is NOT to pin the exact wording of the help text — it is
to bind the help output to the real command registries so a command can never be
added to the CLI and silently go undocumented. It imports ``VALID_SUBCOMMANDS``
(and ``OUTPUT_FORMATS``) straight from :mod:`einvoice.cli` and asserts that every
registry entry is named in the help. If someone adds a subcommand to
``VALID_SUBCOMMANDS`` but forgets to describe it in ``HELP``, this test fails.

Runnable standalone: ``python3 test_cli_help.py`` (also collected by unittest).
"""

import io
import os
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from einvoice.cli import main, VALID_SUBCOMMANDS, OUTPUT_FORMATS, EXIT_OK
from einvoice.report import (  # noqa: E402
    main as report_main, USAGE as REPORT_USAGE)


def _run(argv):
    """Invoke the CLI with ``argv``; return (exit_code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = main(argv)
    return code, out.getvalue(), err.getvalue()


def _run_report(argv):
    """Invoke ``python3 -m einvoice.report`` in-process with ``argv``;
    return (exit_code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = report_main(argv)
    return code, out.getvalue(), err.getvalue()


class HelpFlagTest(unittest.TestCase):
    def test_help_exits_ok_and_writes_stdout(self):
        code, out, err = _run(["--help"])
        self.assertEqual(code, EXIT_OK, "--help must exit 0 (EXIT_OK)")
        self.assertTrue(out.strip(), "--help must write help text to stdout")
        self.assertNotIn(
            "unknown subcommand", (out + err),
            "--help must not hit the unknown-subcommand error path")

    def test_help_goes_to_stdout_not_stderr(self):
        _, out, err = _run(["--help"])
        self.assertIn("usage: einvoice", out)
        self.assertEqual(err, "", "--help must not write to stderr")

    def test_help_documents_every_valid_subcommand(self):
        # The completeness guard: sourced from the real registry, not a literal.
        _, out, _ = _run(["--help"])
        for sub in VALID_SUBCOMMANDS:
            self.assertIn(
                sub, out,
                "help output is missing VALID_SUBCOMMANDS entry %r "
                "(a subcommand went undocumented)" % sub)

    def test_help_documents_informational_commands(self):
        _, out, _ = _run(["--help"])
        for name in ("info", "--show-config", "--version"):
            self.assertIn(
                name, out,
                "help output is missing informational command %r" % name)

    def test_help_only_advertises_real_output_forms(self):
        # This CLI has NO --format flag; the only output forms are OUTPUT_FORMATS
        # (text / json). Guard against advertising a form the CLI cannot emit.
        _, out, _ = _run(["--help"])
        for form in OUTPUT_FORMATS:
            self.assertIn(form, out,
                          "help should mention output form %r" % form)
        self.assertNotIn(
            "--format", out,
            "this CLI has no --format flag; help must not advertise one")

    def test_short_h_is_byte_identical_to_long_help(self):
        _, out_long, _ = _run(["--help"])
        _, out_short, _ = _run(["-h"])
        self.assertEqual(
            out_short, out_long,
            "-h must produce byte-identical output to --help")

    def test_help_precedes_dispatch_anywhere_in_argv(self):
        # Like --version, --help wins even after a would-be subcommand token.
        code, out, _ = _run(["validate", "--help"])
        self.assertEqual(code, EXIT_OK)
        self.assertIn("usage: einvoice", out)

    def test_mistyped_subcommand_still_errors(self):
        # No regression: a genuine typo (no -h/--help) still exits 2.
        code, _, err = _run(["bogus", "/tmp/nope.xml"])
        self.assertEqual(code, 2)
        self.assertIn("unknown subcommand", err)


class ReportHelpFlagTest(unittest.TestCase):
    """``python3 -m einvoice.report`` is a DOCUMENTED public entry point (the
    GitHub Action, README, QUICKSTART and every CI recipe invoke it), but until
    T-VHWHEEL.2 it answered ``--help`` with the nonsense ``error: no such file:
    --help`` and exited 1 — the argument loop fell through to the positional
    path check. MEASURED at 4d5adb6, both ``--help`` and ``-h``.

    Help is a REQUESTED output, so it goes to stdout with exit 0. The BARE
    invocation is a different thing — a usage ERROR — and keeps its pinned
    contract (usage on stderr, non-zero, empty stdout); that split is what
    test_stdout_purity.py's machine-surface discipline relies on.
    """

    def test_help_exits_ok_with_usage_on_stdout(self):
        code, out, err = _run_report(["--help"])
        self.assertEqual(code, 0, "report --help must exit 0")
        self.assertIn("usage:", out)
        self.assertIn(REPORT_USAGE, out,
                      "--help must print the module's own USAGE constant")
        self.assertEqual(err, "", "--help must not write to stderr")

    def test_short_h_is_byte_identical_to_long_help(self):
        _, out_long, _ = _run_report(["--help"])
        code, out_short, err = _run_report(["-h"])
        self.assertEqual(code, 0, "report -h must exit 0")
        self.assertEqual(out_short, out_long,
                         "-h must produce byte-identical output to --help")
        self.assertEqual(err, "")

    def test_help_wins_before_any_path_resolution(self):
        # The defect was that --help reached the positional/isfile check. Prove
        # it is answered first even when a bogus path is also on argv.
        for argv in (["/tmp/definitely-not-here.xml", "--help"],
                     ["--format", "sarif", "--help"],
                     ["-h", "/tmp/definitely-not-here.xml"]):
            with self.subTest(argv=argv):
                code, out, err = _run_report(argv)
                self.assertEqual(code, 0, "help must win over %r" % (argv,))
                self.assertIn("usage:", out)
                self.assertNotIn("no such file", out + err)

    def test_bare_invocation_keeps_its_pinned_error_contract(self):
        # NOT changed by the --help work: no args is a usage ERROR.
        code, out, err = _run_report([])
        self.assertNotEqual(code, 0,
                            "bare `python3 -m einvoice.report` must stay non-zero")
        self.assertEqual(out, "", "a usage error must keep stdout empty")
        self.assertIn("usage:", err, "bare invocation prints usage on stderr")


if __name__ == "__main__":
    unittest.main(verbosity=2)

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


def _run(argv):
    """Invoke the CLI with ``argv``; return (exit_code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = main(argv)
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


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""test_no_install.py — pin the "run in CI without installing" one-liner
(T-VHINTEG.3).

Fast, stdlib-only, saxonche-free, offline. It proves that the containerless,
no-install batch invocation documented in ``ci/README.md`` actually works from
a **bare checkout** with **zero runtime dependencies**, and that the doc cannot
silently drift from the command that is executed.

How drift is prevented: the test does NOT hardcode the command. It reads the
EXACT one-liner out of ``ci/README.md`` (the fenced code block in the "Run in
CI without installing" subsection), tokenizes it, drops the ``<dir|glob>``
placeholder, and runs *that* token prefix. If someone edits the documented
command, this test either runs the new command or fails to find it.

How the no-install claim is proven: the command is run in a CLEAN subprocess
environment — only ``HOME`` and ``PATH`` are passed through (``PYTHONPATH`` and
every other install side-channel are stripped, exactly like the confirmed
``env -i HOME=$HOME PATH=$PATH`` check) — from the ``einvoice/`` directory of a
plain checkout. No install, no ``pip``, no ``PYTHONPATH``.

Asserted (each maps to a task acceptance criterion):
  1. ``ci/README.md`` textually contains the exact literal command
     ``python3 -m einvoice validate-batch``; the parsed token prefix is exactly
     ``['python3', '-m', 'einvoice', 'validate-batch']``.
  2. The good committed fixture glob (``examples/01-missing-fields/*.xml``)
     exits ``0`` with a well-formed PASS batch summary.
  3. A temp dir holding the known-fatal BuyerReference-stripped fixture
     (``examples/01-missing-fields/broken.xml``) under ``--profile xrechnung``
     exits non-zero and prints a well-formed summary naming the failing file.
"""

import os
import re
import shlex
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
README = os.path.join(HERE, "ci", "README.md")

# The literal command the doc must show and the test must run. Kept here only
# to ASSERT the doc's prefix equals it — the command actually executed is the
# one parsed out of the README, not this constant.
EXPECTED_PREFIX = ["python3", "-m", "einvoice", "validate-batch"]

GOOD_GLOB = "examples/01-missing-fields/*.xml"
BROKEN_FIXTURE = os.path.join(HERE, "examples", "01-missing-fields", "broken.xml")


def _runnable(argv):
    """Resolve the documented ``python3`` token to THIS interpreter.

    The token parsed from the doc is the literal ``python3``; running it via
    ``sys.executable`` executes the very same ``-m einvoice validate-batch``
    module path with the interpreter this test suite runs under, while keeping
    every other token exactly as documented.
    """
    if argv and os.path.basename(argv[0]) == "python3":
        return [sys.executable] + argv[1:]
    return list(argv)


def _clean_env():
    """A scrubbed environment: only HOME + PATH survive, PYTHONPATH is gone.

    This reproduces the confirmed ``env -i HOME=$HOME PATH=$PATH`` invocation,
    so a pass proves the command needs no install side effects (no PYTHONPATH,
    no ``*.pth``-driven sys.path, no virtualenv) to import the package.
    """
    env = {}
    if "HOME" in os.environ:
        env["HOME"] = os.environ["HOME"]
    env["PATH"] = os.environ.get("PATH", "/usr/bin:/bin")
    # Belt and braces: make sure nothing re-introduces an import side channel.
    for leaked in ("PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP"):
        env.pop(leaked, None)
    return env


def parse_documented_command(readme_text):
    """Extract the documented one-liner's token prefix from ci/README.md.

    Looks for a fenced code block whose (only) command line starts with
    ``python3 -m einvoice validate-batch``, tokenizes that line with shlex, and
    returns the tokens up to and including ``validate-batch`` (dropping the
    ``<dir|glob>`` placeholder). Raising here means the doc drifted away from a
    parseable command.
    """
    # Scan fenced ```sh / ``` blocks for the command line.
    for block in re.findall(r"```[a-zA-Z]*\n(.*?)```", readme_text, re.DOTALL):
        for line in block.splitlines():
            stripped = line.strip()
            if stripped.startswith("python3 -m einvoice validate-batch"):
                tokens = shlex.split(stripped)
                idx = tokens.index("validate-batch")
                return tokens[: idx + 1]
    raise AssertionError(
        "ci/README.md has no fenced 'python3 -m einvoice validate-batch' "
        "command line — the documented one-liner drifted or was removed.")


class NoInstallOneLinerTest(unittest.TestCase):
    def setUp(self):
        with open(README, "r", encoding="utf-8") as fh:
            self.readme_text = fh.read()
        self.cmd_prefix = parse_documented_command(self.readme_text)

    # --- criterion 1 + 3: doc contains the literal command, no drift ---------
    def test_doc_contains_exact_literal_command(self):
        self.assertIn(
            "python3 -m einvoice validate-batch", self.readme_text,
            "ci/README.md must contain the exact literal one-liner.")
        self.assertEqual(
            self.cmd_prefix, EXPECTED_PREFIX,
            "the command parsed out of the README drifted from the one the "
            "test runs: %r != %r" % (self.cmd_prefix, EXPECTED_PREFIX))

    # --- criterion 2: good fixture exits 0 with a well-formed PASS summary ----
    def test_good_fixture_passes_zero_install(self):
        argv = self.cmd_prefix + [GOOD_GLOB]
        proc = subprocess.run(
            _runnable(argv),
            cwd=HERE, env=_clean_env(),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(
            proc.returncode, 0,
            "good fixture must exit 0.\nstdout:\n%s\nstderr:\n%s"
            % (proc.stdout, proc.stderr))
        out = proc.stdout
        self.assertIn("PASS", out)
        self.assertNotIn("FAIL", out)
        # Well-formed aggregate summary line.
        self.assertRegex(
            out, r"\d+ files?: \d+ passed, \d+ failed")
        self.assertIn("0 failed", out)

    # --- criterion 3: a dir with a fatal invoice exits non-zero --------------
    def test_fatal_fixture_fails_nonzero_and_names_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "broken.xml")
            with open(BROKEN_FIXTURE, "rb") as src, open(target, "wb") as dst:
                dst.write(src.read())
            argv = self.cmd_prefix + [tmp, "--profile", "xrechnung"]
            proc = subprocess.run(
                _runnable(argv),
                cwd=HERE, env=_clean_env(),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertNotEqual(
            proc.returncode, 0,
            "a batch containing a known-fatal invoice must exit non-zero.\n"
            "stdout:\n%s\nstderr:\n%s" % (proc.stdout, proc.stderr))
        out = proc.stdout
        # Well-formed summary that names the failing file.
        self.assertIn("FAIL", out)
        self.assertIn("broken.xml", out)
        self.assertRegex(out, r"\d+ files?: \d+ passed, \d+ failed")
        self.assertIn("1 failed", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)

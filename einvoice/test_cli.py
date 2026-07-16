#!/usr/bin/env python3
"""test_cli.py — pin the einvoice CLI ergonomics contract (T-VHCLI.1).

Fast, stdlib-only, offline. Exercises the hand-rolled CLI both in-process
(``einvoice.cli.main`` with an argv list, capturing stdout/stderr) and as a
subprocess (``python3 -m einvoice``) to prove the packaged entry point behaves
identically.

What this locks down — each maps to a task acceptance criterion:
  * ``--version`` exits 0 and prints ``einvoice.__version__`` (no hardcoded
    literal — the test reads the package attribute), with no subcommand/file.
  * ``--quiet`` on a PASSING invoice emits NO human stdout but still exit 0.
  * ``--quiet`` on a FAILING invoice emits NO human stdout but still exit 1.
  * ``--quiet --json`` STILL prints the JSON result (quiet only silences the
    human summary), byte-identical to plain ``--json``.
  * The four documented exit codes still hold: 0 pass, 1 fatal fail, 2 usage,
    3 not-well-formed.
  * ``validate -`` reads XML from stdin and yields the SAME verdict/exit code
    (and same JSON minus the ``source`` label) as validating the file on disk,
    WITHOUT relaxing the hardened parser.

These assertions are additive: they must never require changing the validation
output, the exit codes, or the --json shape.
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
from einvoice.cli import (  # noqa: E402
    main, EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE,
)

WRAPPER = os.path.join(HERE, "einvoice.py")

# A committed, business-rule-clean UBL invoice -> exit 0 (default en16931).
PASS_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                            "cen-bis3-positive_ubl.xml")
# A committed invalid UBL *CreditNote* (BT-3 CreditNoteTypeCode = 999, an
# out-of-range UNTDID 1001 credit-note code) -> a REAL BR-CL-01 fatal from the
# CreditNote rule engine -> exit 1. (Since T-VHCN.2 a UBL CreditNote is really
# validated, not S-ROOT-rejected, so a failing CreditNote fails on its content.)
FAIL_FIXTURE = os.path.join(HERE, "fixtures",
                            "creditnote-invalid-typecode_ubl.xml")
# Deliberately truncated XML -> not-well-formed -> exit 3.
MALFORMED_XML = b"<Invoice><never-closed>"


class _Capture:
    """Context manager: run ``main(argv)`` capturing stdout/stderr + exit code.

    Optionally feeds ``stdin`` (bytes) so the ``validate -`` path can be driven
    in-process. Restores the real streams afterwards.
    """

    def __init__(self, argv, stdin_bytes=None):
        self.argv = argv
        self.stdin_bytes = stdin_bytes
        self.rc = None
        self.out = ""
        self.err = ""

    def __enter__(self):
        self._out, self._err, self._in = sys.stdout, sys.stderr, sys.stdin
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        if self.stdin_bytes is not None:
            # main() reads stdin via sys.stdin.buffer.read(); emulate that.
            text = io.TextIOWrapper(io.BytesIO(self.stdin_bytes),
                                    encoding="utf-8")
            sys.stdin = text
        self.rc = main(self.argv)
        self.out = sys.stdout.getvalue()
        self.err = sys.stderr.getvalue()
        return self

    def __exit__(self, *exc):
        sys.stdout, sys.stderr, sys.stdin = self._out, self._err, self._in
        return False


def run_module(*argv, stdin=None):
    """Run ``python3 -m einvoice <argv>`` as a subprocess."""
    return subprocess.run(
        [sys.executable, "-m", "einvoice", *argv],
        cwd=HERE, input=stdin, capture_output=True)


class FixturesExist(unittest.TestCase):
    def test_fixtures_present(self):
        self.assertTrue(os.path.isfile(PASS_FIXTURE), PASS_FIXTURE)
        self.assertTrue(os.path.isfile(FAIL_FIXTURE), FAIL_FIXTURE)


class Version(unittest.TestCase):
    def test_version_inprocess_exit0_prints_package_version(self):
        with _Capture(["--version"]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)
            self.assertIn(einvoice.__version__, cap.out)
            # No subcommand / file was needed.
            self.assertEqual(cap.err, "")

    def test_version_takes_precedence_over_subcommand(self):
        # --version short-circuits even when a (nonexistent) file follows.
        with _Capture(["validate", "--version", "nope.xml"]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)
            self.assertIn(einvoice.__version__, cap.out)

    def test_version_subprocess_module(self):
        proc = run_module("--version")
        self.assertEqual(proc.returncode, EXIT_OK, proc.stderr)
        self.assertIn(einvoice.__version__,
                      proc.stdout.decode("utf-8", "replace"))

    def test_version_not_hardcoded_but_the_package_attr(self):
        # Guard against a future edit that hardcodes a literal: the printed
        # token must equal whatever einvoice.__version__ currently is.
        with _Capture(["--version"]) as cap:
            self.assertEqual(cap.out.strip().split()[-1], einvoice.__version__)


class Quiet(unittest.TestCase):
    def test_quiet_pass_emits_no_human_stdout_exit0(self):
        with _Capture(["validate", "--quiet", PASS_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)
            self.assertEqual(cap.out, "", "quiet must silence the PASS summary")

    def test_quiet_fail_emits_no_human_stdout_exit1(self):
        with _Capture(["validate", "--quiet", FAIL_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_FAIL)
            self.assertEqual(cap.out, "", "quiet must silence the FAIL summary")

    def test_quiet_does_not_change_the_exit_code(self):
        for fixture in (PASS_FIXTURE, FAIL_FIXTURE):
            with _Capture(["validate", fixture]) as loud, \
                    _Capture(["validate", "--quiet", fixture]) as hush:
                self.assertEqual(loud.rc, hush.rc, fixture)

    def test_quiet_json_still_prints_json_byte_identical(self):
        with _Capture(["validate", "--json", PASS_FIXTURE]) as plain, \
                _Capture(["validate", "--quiet", "--json", PASS_FIXTURE]) as q:
            self.assertEqual(q.rc, plain.rc)
            # quiet only silences the HUMAN summary; JSON is untouched.
            self.assertEqual(q.out, plain.out)
            json.loads(q.out)  # still parseable

    def test_quiet_json_on_failure_still_prints_json(self):
        with _Capture(["validate", "--quiet", "--json", FAIL_FIXTURE]) as q:
            self.assertEqual(q.rc, EXIT_FAIL)
            doc = json.loads(q.out)
            self.assertFalse(doc["valid"])


class ExitCodeContract(unittest.TestCase):
    """The four documented exit codes still hold byte-for-byte on existing
    paths — nothing in this task may have moved them."""

    def test_0_pass(self):
        with _Capture(["validate", PASS_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)
            self.assertTrue(cap.out.startswith("PASS: "), cap.out)

    def test_1_fatal_fail(self):
        with _Capture(["validate", FAIL_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_FAIL)
            self.assertTrue(cap.out.startswith("FAIL: "), cap.out)

    def test_2_usage_missing_file(self):
        with _Capture(["validate", "does-not-exist.xml"]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)

    def test_2_usage_no_subcommand(self):
        with _Capture([]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("usage:", cap.err)

    def test_2_usage_unknown_profile(self):
        with _Capture(["validate", "--profile=bogus", PASS_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)

    def test_3_not_well_formed(self):
        # Write the malformed bytes to a temp file so this exercises the normal
        # (non-stdin) parse path.
        import tempfile
        fd, tmp = tempfile.mkstemp(suffix=".xml")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(MALFORMED_XML)
            with _Capture(["validate", tmp]) as cap:
                self.assertEqual(cap.rc, EXIT_PARSE)
        finally:
            os.unlink(tmp)


class HumanOutputUnchanged(unittest.TestCase):
    """The non-quiet human summary is byte-identical to the historical format
    (the '--quiet' work must not have perturbed the loud path)."""

    def test_pass_summary_shape(self):
        with _Capture(["validate", PASS_FIXTURE]) as cap:
            self.assertIn("(all implemented fatal rules, profile=en16931)",
                          cap.out)
            self.assertIn("Syntax-binding warnings:", cap.out)


class Stdin(unittest.TestCase):
    """`validate -` reads XML from stdin and matches the file-path verdict,
    without relaxing the hardened parser."""

    def _read(self, path):
        with open(path, "rb") as fh:
            return fh.read()

    def test_stdin_pass_matches_file(self):
        with _Capture(["validate", PASS_FIXTURE]) as onfile, \
                _Capture(["validate", "-"],
                         stdin_bytes=self._read(PASS_FIXTURE)) as onstdin:
            self.assertEqual(onstdin.rc, onfile.rc)
            self.assertEqual(onstdin.rc, EXIT_OK)

    def test_stdin_fail_matches_file(self):
        with _Capture(["validate", FAIL_FIXTURE]) as onfile, \
                _Capture(["validate", "-"],
                         stdin_bytes=self._read(FAIL_FIXTURE)) as onstdin:
            self.assertEqual(onstdin.rc, onfile.rc)
            self.assertEqual(onstdin.rc, EXIT_FAIL)

    def test_stdin_json_matches_file_except_source(self):
        with _Capture(["validate", "--json", PASS_FIXTURE]) as onfile, \
                _Capture(["validate", "--json", "-"],
                         stdin_bytes=self._read(PASS_FIXTURE)) as onstdin:
            a = json.loads(onfile.out)
            b = json.loads(onstdin.out)
            # Only the human-facing 'source' label differs ("-" vs the path);
            # every other field of the --json shape is identical.
            a.pop("source"), b.pop("source")
            self.assertEqual(a, b)
            self.assertEqual(b_source_label(onstdin.out), "-")

    def test_stdin_malformed_is_still_exit3(self):
        with _Capture(["validate", "-"], stdin_bytes=MALFORMED_XML) as cap:
            self.assertEqual(cap.rc, EXIT_PARSE)

    def test_stdin_hardening_not_relaxed_xxe_rejected(self):
        # A classic external-entity (XXE) payload must be refused on the stdin
        # path exactly as on the file path: not-well-formed / parse error (3),
        # never entity expansion. Proves stdin routes through the hardened
        # parser (einvoice._xmlsec), not a relaxed reader.
        xxe = (b'<?xml version="1.0"?>\n'
               b'<!DOCTYPE Invoice [<!ENTITY xxe SYSTEM '
               b'"file:///etc/passwd">]>\n'
               b'<Invoice>&xxe;</Invoice>')
        with _Capture(["validate", "-"], stdin_bytes=xxe) as cap:
            self.assertEqual(cap.rc, EXIT_PARSE, cap.out + cap.err)
            self.assertNotIn("root:", cap.out)
            self.assertNotIn("root:", cap.err)

    def test_stdin_subprocess_module(self):
        proc = run_module("validate", "-", stdin=self._read(PASS_FIXTURE))
        self.assertEqual(proc.returncode, EXIT_OK, proc.stderr)


def b_source_label(json_text):
    return json.loads(json_text).get("source")


if __name__ == "__main__":
    unittest.main()

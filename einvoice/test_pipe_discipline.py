#!/usr/bin/env python3
"""test_pipe_discipline.py — SIGPIPE/BrokenPipe totality of the CLI (T-VHPIPE.2).

THE DEFECT THIS PINS (confirmed live at e5d09d8): piping a large
``einvoice validate-batch ... --json`` into an early-exiting reader
(``| head``, a dying ``jq``, a closed CI log pipe) dumped a raw
BrokenPipeError traceback on stderr — exactly the crash-looking output that
kills a pilot's first pipeline. The same pipe with the default text output
only survived by ACCIDENT: a small report fits the ~64 KiB OS pipe buffer, so
the broken-pipe write never happened. The defect fires whenever more than the
pipe buffer is written after the reader exits — so this test builds a corpus
big enough that BOTH the text and the ``--json`` batch reports exceed 128 KiB
(2x the usual 64 KiB pipe buffer), making the early-close deterministic.

WHAT IT ASSERTS, per output format (text AND --json):

  EARLY-CLOSE LEG — Popen the REAL CLI (``python3 -m einvoice validate-batch``)
  with stdout=PIPE, read ~100 bytes, close the read end, wait:
    * exit code == 141 (EXIT_PIPE = 128+SIGPIPE, the documented shell
      convention — see EXIT-CODES.md), NOT Python's generic traceback exit 1;
    * stderr contains ZERO ``Traceback`` / ``BrokenPipeError`` bytes (no
      primary traceback, and no "Exception ignored" secondary shutdown-flush
      traceback either).

  NO-EARLY-CLOSE CONTROL — the SAME corpus, pipe read to completion:
    * exit code == 1 (any-fatal batch precedence, untouched);
    * the full report body is intact — ``json.loads`` of the ENTIRE stdout
      succeeds on the --json leg, and the text leg still carries its per-file
      FAIL lines and aggregate tally. Proves the fix changed no verdict and
      no report byte.

  DOC PIN — EXIT-CODES.md documents 141 / broken pipe, and the symbolic
  constant ``einvoice.cli.EXIT_PIPE`` equals the documented 141.

CORPUS: a temp directory of 560 copies of the committed invalid fixture
``fixtures/sb-viol-CII-DT-001_cii.xml`` under deliberately LONG file names
(the text report is one ~short line per file, so long paths are what push the
text report past 128 KiB; measured ~257 B/line -> ~144 KiB text, ~540 KiB
json). Invalid fixtures validate fast: the whole test runs in seconds.

Zero new dependencies; plain ``python3 test_pipe_discipline.py``; nonzero
exit on failure. No validation, rule, or report logic is touched.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.cli import EXIT_FAIL, EXIT_PIPE  # noqa: E402

#: Committed invalid fixture replicated into the temp batch corpus. It fails
#: fast (one fatal), so even 560 copies validate in about a second.
FIXTURE = os.path.join(HERE, "fixtures", "sb-viol-CII-DT-001_cii.xml")

#: Both reports must exceed this many bytes so the early-close write reliably
#: overruns the OS pipe buffer (usually 64 KiB on Linux): 2x margin.
MIN_REPORT_BYTES = 128 * 1024

#: 560 copies x ~257 text bytes/line (long names) ≈ 144 KiB text report;
#: the --json report is ~1 KiB/file ≈ 540 KiB. Both comfortably > 128 KiB.
COPIES = 560

#: Long-name padding: the text report is one line per FILE PATH, so the path
#: length — not the invoice content — is what sizes the text report.
NAME_PAD = "x" * 200


def _cli(args, **popen_kw):
    """The real packaged entry point, exactly as a CI pipeline runs it."""
    return subprocess.Popen(
        [sys.executable, "-m", "einvoice", *args],
        cwd=HERE, **popen_kw)


class PipeDiscipline(unittest.TestCase):
    """Early-closed stdout => documented exit 141, quiet stderr; no-early-close
    control on the same corpus => exit 1 with a byte-intact report."""

    tmpdir = None

    @classmethod
    def setUpClass(cls):
        if not os.path.isfile(FIXTURE):
            raise AssertionError("missing committed fixture: %s" % FIXTURE)
        cls.tmpdir = tempfile.mkdtemp(prefix="einvoice-pipe-")
        with open(FIXTURE, "rb") as fh:
            payload = fh.read()
        for i in range(COPIES):
            name = "inv-%04d-%s.xml" % (i, NAME_PAD)
            with open(os.path.join(cls.tmpdir, name), "wb") as fh:
                fh.write(payload)

    @classmethod
    def tearDownClass(cls):
        if cls.tmpdir is not None:
            shutil.rmtree(cls.tmpdir, ignore_errors=True)

    # ---- helpers ---------------------------------------------------------

    def _early_close(self, args):
        """Read ~100 bytes, close the pipe's read end, wait; return (rc, err)."""
        proc = _cli(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            first = proc.stdout.read(100)
            # The writer only sees EPIPE once the read end is CLOSED and it
            # writes past the pipe buffer — which the >128 KiB report forces.
            proc.stdout.close()
            err = proc.stderr.read()
            rc = proc.wait(timeout=120)
        finally:
            proc.stderr.close()
        # Sanity: the CLI really was mid-report when the reader walked away.
        self.assertEqual(len(first), 100, "CLI produced <100 bytes of report")
        return rc, err

    def _control(self, args):
        """No early close: run to completion; return (rc, full stdout, err)."""
        done = subprocess.run(
            [sys.executable, "-m", "einvoice", *args],
            cwd=HERE, capture_output=True, timeout=120)
        return done.returncode, done.stdout, done.stderr

    def _assert_quiet_141(self, rc, err, leg):
        self.assertEqual(
            rc, EXIT_PIPE,
            "%s: early-closed pipe must exit EXIT_PIPE=%d, got %d (stderr: %r)"
            % (leg, EXIT_PIPE, rc, err[:400]))
        self.assertNotIn(b"Traceback", err,
                         "%s: traceback leaked to stderr: %r" % (leg, err[:400]))
        self.assertNotIn(b"BrokenPipeError", err,
                         "%s: BrokenPipeError leaked to stderr: %r"
                         % (leg, err[:400]))

    # ---- the documented code is 141 = 128+SIGPIPE ------------------------

    def test_exit_pipe_constant_is_the_shell_convention(self):
        self.assertEqual(EXIT_PIPE, 141)   # 128 + SIGPIPE(13)

    def test_exit_codes_md_documents_the_pipe_code(self):
        doc_path = os.path.join(HERE, "EXIT-CODES.md")
        with open(doc_path, "r", encoding="utf-8") as fh:
            doc = fh.read()
        self.assertIn("141", doc)
        self.assertIn("broken pipe", doc.lower())

    # ---- early-close legs -------------------------------------------------

    def test_early_close_text_exits_141_quietly(self):
        rc, err = self._early_close(["validate-batch", self.tmpdir])
        self._assert_quiet_141(rc, err, "text leg")

    def test_early_close_json_exits_141_quietly(self):
        rc, err = self._early_close(["validate-batch", self.tmpdir, "--json"])
        self._assert_quiet_141(rc, err, "--json leg")

    # ---- no-early-close controls: verdicts and report bytes untouched -----

    def test_control_text_exits_1_with_intact_report(self):
        rc, out, err = self._control(["validate-batch", self.tmpdir])
        self.assertEqual(rc, EXIT_FAIL, err[:400])
        # Premise check: the report really is big enough that the early-close
        # legs above overran the pipe buffer (else they proved nothing).
        self.assertGreater(len(out), MIN_REPORT_BYTES,
                           "text report %d bytes <= %d — early-close legs "
                           "would not overrun the pipe buffer"
                           % (len(out), MIN_REPORT_BYTES))
        # The full report body survived the fix byte-for-byte in shape: every
        # file line plus the aggregate tally.
        self.assertEqual(out.count(b"\nFAIL  ") + out.startswith(b"FAIL  "),
                         COPIES)
        tally = ("%d files: 0 passed, %d failed" % (COPIES, COPIES)).encode()
        self.assertIn(tally, out)

    def test_control_json_exits_1_with_parseable_report(self):
        rc, out, err = self._control(["validate-batch", self.tmpdir, "--json"])
        self.assertEqual(rc, EXIT_FAIL, err[:400])
        self.assertGreater(len(out), MIN_REPORT_BYTES,
                           "--json report %d bytes <= %d — early-close legs "
                           "would not overrun the pipe buffer"
                           % (len(out), MIN_REPORT_BYTES))
        # json.loads over the ENTIRE stdout: intact, untruncated, unchanged.
        batch = json.loads(out.decode("utf-8"))
        self.assertEqual(batch["file_count"], COPIES)
        self.assertEqual(batch["failed_file_count"], COPIES)


if __name__ == "__main__":
    unittest.main()

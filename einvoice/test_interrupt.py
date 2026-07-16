#!/usr/bin/env python3
"""test_interrupt.py — clean SIGINT/SIGTERM abort of the CLI (T-VHPIPE.3).

THE DEFECTS THIS PINS (both MEASURED live before the fix, same methodology as
the legs below):

  * SIGINT (Ctrl-C) mid-run: Python's unhandled KeyboardInterrupt dumped a
    raw multi-frame traceback (runpy + cli frames) on stderr before the
    process died with the signal — crash-looking output for a routine
    operator abort, on EVERY code path (batch and stdin alike).
  * SIGTERM mid-run: the default disposition kills the process with NO
    ``finally`` cleanup. Measured consequence: a SIGTERM landing while
    ``validate -`` was validating its staged stdin bytes left a stray
    ``einvoice-stdin-*.xml`` file in the temp directory. (The batch path
    leaks nothing — it stages no temp file — but died silently raw.)

THE FIX THIS PINS (mirrors the T-VHPIPE.2 broken-pipe pattern, minimal, at
the single CLI entry point ``einvoice.cli.main``): KeyboardInterrupt is
caught and becomes a QUIET documented exit 130 (= 128+SIGINT, ``EXIT_INT``);
a SIGTERM handler converts the signal into an exception so every cleanup
``finally`` runs, then exits QUIETLY with the documented 143 (= 128+SIGTERM,
``EXIT_TERM``). See EXIT-CODES.md, "Codes 130 / 143".

WHAT IT ASSERTS, for BOTH signals on BOTH paths:

  BATCH LEG — Popen the REAL CLI (``python3 -m einvoice validate-batch``)
  over an inline-synthesized ~500-file corpus (mixed valid UBL + invalid CII,
  copied from committed fixtures), signal it mid-run, and assert:
    * exit code == EXIT_INT (130) for SIGINT / EXIT_TERM (143) for SIGTERM —
      a documented NON-ZERO status, not a raw traceback death;
    * ZERO ``Traceback`` / ``KeyboardInterrupt`` bytes on stderr;
    * no NEW ``einvoice-stdin-*`` file in tempfile.gettempdir() afterwards.

  STDIN LEG — ``validate - --json`` fed a multi-second inline-synthesized
  invoice (a committed valid UBL fixture with its InvoiceLine replicated
  400x) through stdin, signaled mid-VALIDATION, and assert the same three
  facts. This leg specifically exercises the cli.py stdin temp-file cleanup:
  the temp file is OBSERVED to exist before the signal is sent (that is the
  mid-run gate), and observed GONE after the process exits.

MID-RUN DETERMINISM (never signal a child that has not really started, never
race a child that already finished):

  * batch: the report is written in ONE stdout write at the END of the run,
    so "first output byte" cannot gate mid-run-ness. Instead the test polls
    the child's ACCRUED CPU time via /proc/<pid>/stat and signals only after
    >= 0.4s of CPU — far past interpreter startup (~0.1s CPU, so the entry-
    point handler is installed) and far before the ~1.5s-CPU completion of
    the 500-file corpus. On a non-/proc platform it falls back to a fixed
    grace sleep. Either way the child is asserted STILL RUNNING at kill time.
  * stdin: the appearance of the child's own ``einvoice-stdin-*`` temp file
    IS the mid-run signal — mkstemp happens inside the dispatcher, after the
    entry point (and its SIGTERM handler) is live, and the 400-line invoice
    keeps validation busy for seconds after that.
  * every wait carries a hard timeout, so a hung child FAILS the test rather
    than wedging it.

DOC PIN — EXIT-CODES.md documents both codes, and the symbolic constants
``einvoice.cli.EXIT_INT`` / ``EXIT_TERM`` equal the documented 130 / 143.

Zero new dependencies; plain ``python3 test_interrupt.py``; nonzero exit on
failure. No validation, rule, or report logic is touched — an interrupted
run has no verdict, and completed runs are pinned unchanged elsewhere
(test_exit_codes.py, test_golden_snapshot.py, differential.py).
"""

import glob
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.cli import EXIT_INT, EXIT_TERM  # noqa: E402

#: Committed fixtures replicated into the inline-synthesized batch corpus:
#: one fast-failing invalid CII and one clean valid UBL (mixed so the corpus
#: is not all-of-one-kind).
INVALID_FIXTURE = os.path.join(HERE, "fixtures", "sb-viol-CII-DT-001_cii.xml")
VALID_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                             "cen-bis3-positive_ubl.xml")

#: Valid UBL whose <cac:InvoiceLine> is replicated to synthesize the SLOW
#: stdin invoice (400 lines ≈ several seconds of validation — a wide window
#: between mkstemp and completion in which to land the signal).
SLOW_BASE_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                                 "xr-01.18a_ubl.xml")
SLOW_LINE_COPIES = 400

#: Batch corpus size: ~500 files ≈ 1.5s of child CPU (measured ~1.1s for 400
#: invalid-only), leaving a wide mid-run window around the signal point.
BATCH_COPIES = 500

#: Signal the batch child only after this much accrued CPU: well past
#: interpreter startup (~0.1s CPU, so the entry point's handler is installed)
#: and well before corpus completion.
MIN_CHILD_CPU_SECONDS = 0.4

#: Hard per-wait timeout — a hung child FAILS the test instead of wedging it.
WAIT_TIMEOUT = 120

_CLOCK_TICKS = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100


def _child_cpu_seconds(pid):
    """Accrued utime+stime of ``pid`` in seconds via /proc, or None if the
    platform has no readable /proc/<pid>/stat."""
    try:
        with open("/proc/%d/stat" % pid, "rb") as fh:
            # Split AFTER the last ')' — the comm field may contain spaces.
            rest = fh.read().rsplit(b")", 1)[1].split()
        return (int(rest[11]) + int(rest[12])) / float(_CLOCK_TICKS)
    except (OSError, ValueError, IndexError):
        return None


def _stdin_temp_files():
    """Snapshot of einvoice-stdin-* staging files in the temp directory."""
    return set(glob.glob(
        os.path.join(tempfile.gettempdir(), "einvoice-stdin-*")))


class _InterruptContract(unittest.TestCase):
    """Shared assertions: documented code, quiet stderr, no stray temp file."""

    def _assert_clean_abort(self, sig, rc, err, before_temps, leg):
        expected = EXIT_INT if sig == signal.SIGINT else EXIT_TERM
        self.assertEqual(
            rc, expected,
            "%s: expected documented exit %d for signal %d, got %r "
            "(stderr: %r)" % (leg, expected, sig, rc, err[:400]))
        self.assertNotIn(b"Traceback", err,
                         "%s: traceback leaked to stderr: %r"
                         % (leg, err[:400]))
        self.assertNotIn(b"KeyboardInterrupt", err,
                         "%s: KeyboardInterrupt leaked to stderr: %r"
                         % (leg, err[:400]))
        stray = _stdin_temp_files() - before_temps
        self.assertEqual(
            stray, set(),
            "%s: stray stdin temp file(s) left behind: %r"
            % (leg, sorted(stray)))


class BatchInterrupt(_InterruptContract):
    """SIGINT/SIGTERM mid-``validate-batch`` => documented quiet abort."""

    tmpdir = None

    @classmethod
    def setUpClass(cls):
        for fx in (INVALID_FIXTURE, VALID_FIXTURE):
            if not os.path.isfile(fx):
                raise AssertionError("missing committed fixture: %s" % fx)
        # Inline-synthesized corpus: alternate valid UBL / invalid CII copies.
        cls.tmpdir = tempfile.mkdtemp(prefix="einvoice-interrupt-")
        payloads = []
        for fx in (VALID_FIXTURE, INVALID_FIXTURE):
            with open(fx, "rb") as fh:
                payloads.append(fh.read())
        for i in range(BATCH_COPIES):
            with open(os.path.join(cls.tmpdir, "inv-%04d.xml" % i),
                      "wb") as fh:
                fh.write(payloads[i % 2])

    @classmethod
    def tearDownClass(cls):
        if cls.tmpdir is not None:
            shutil.rmtree(cls.tmpdir, ignore_errors=True)

    def _interrupt_batch(self, sig):
        before_temps = _stdin_temp_files()
        proc = subprocess.Popen(
            [sys.executable, "-m", "einvoice", "validate-batch", self.tmpdir],
            cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            # Mid-run gate: wait for real CPU to accrue (see module docstring
            # — batch stdout arrives in one write at the END, so output bytes
            # cannot gate this). Falls back to a grace sleep without /proc.
            deadline = time.time() + WAIT_TIMEOUT
            if _child_cpu_seconds(proc.pid) is None:
                time.sleep(0.5)
            else:
                while time.time() < deadline:
                    cpu = _child_cpu_seconds(proc.pid)
                    if cpu is None or cpu >= MIN_CHILD_CPU_SECONDS:
                        break
                    if proc.poll() is not None:
                        break
                    time.sleep(0.005)
            self.assertIsNone(
                proc.poll(),
                "signal %d: child finished before it could be signaled — "
                "corpus too small to be interrupted mid-run" % sig)
            os.kill(proc.pid, sig)
            out, err = proc.communicate(timeout=WAIT_TIMEOUT)
            rc = proc.returncode
        finally:
            if proc.poll() is None:      # hung child: fail, don't wedge
                proc.kill()
                proc.communicate()
        return rc, err, before_temps

    def test_sigint_batch_exits_130_quietly(self):
        rc, err, before = self._interrupt_batch(signal.SIGINT)
        self._assert_clean_abort(signal.SIGINT, rc, err, before,
                                 "batch SIGINT")

    def test_sigterm_batch_exits_143_quietly(self):
        rc, err, before = self._interrupt_batch(signal.SIGTERM)
        self._assert_clean_abort(signal.SIGTERM, rc, err, before,
                                 "batch SIGTERM")


class StdinInterrupt(_InterruptContract):
    """SIGINT/SIGTERM mid-validation of ``validate - --json`` => documented
    quiet abort AND the staged stdin temp file is cleaned up (the file is
    observed to EXIST before the signal and GONE after — this is the leg that
    caught the pre-fix SIGTERM stray-file leak)."""

    slow_invoice = None

    @classmethod
    def setUpClass(cls):
        if not os.path.isfile(SLOW_BASE_FIXTURE):
            raise AssertionError(
                "missing committed fixture: %s" % SLOW_BASE_FIXTURE)
        with open(SLOW_BASE_FIXTURE, "r", encoding="utf-8") as fh:
            src = fh.read()
        m = re.search(r"(<cac:InvoiceLine>.*?</cac:InvoiceLine>)", src, re.S)
        if not m:
            raise AssertionError("no <cac:InvoiceLine> in %s"
                                 % SLOW_BASE_FIXTURE)
        cls.slow_invoice = src.replace(
            m.group(1), m.group(1) * SLOW_LINE_COPIES, 1).encode("utf-8")

    def _interrupt_stdin(self, sig):
        before_temps = _stdin_temp_files()
        proc = subprocess.Popen(
            [sys.executable, "-m", "einvoice", "validate", "-", "--json"],
            cwd=HERE, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            proc.stdin.write(self.slow_invoice)
            proc.stdin.close()
            # communicate() must not re-flush the closed pipe:
            proc.stdin = None
            # Mid-run gate: the child's OWN staging temp file appearing IS
            # the proof that mkstemp ran and validation is underway (and the
            # entry point — and its SIGTERM handler — is live, since mkstemp
            # happens inside the dispatcher the entry point wraps).
            deadline = time.time() + WAIT_TIMEOUT
            staged = set()
            while time.time() < deadline:
                staged = _stdin_temp_files() - before_temps
                if staged or proc.poll() is not None:
                    break
                time.sleep(0.002)
            self.assertTrue(
                staged,
                "signal %d: never observed the einvoice-stdin-* staging file "
                "(child rc=%r) — cannot prove mid-run" % (sig, proc.poll()))
            # Land the signal well inside the multi-second validation window.
            time.sleep(0.1)
            self.assertIsNone(
                proc.poll(),
                "signal %d: child finished before it could be signaled — "
                "slow invoice not slow enough" % sig)
            os.kill(proc.pid, sig)
            out, err = proc.communicate(timeout=WAIT_TIMEOUT)
            rc = proc.returncode
        finally:
            if proc.poll() is None:      # hung child: fail, don't wedge
                proc.kill()
                proc.communicate()
        return rc, err, before_temps

    def test_sigint_stdin_exits_130_and_cleans_temp_file(self):
        rc, err, before = self._interrupt_stdin(signal.SIGINT)
        self._assert_clean_abort(signal.SIGINT, rc, err, before,
                                 "stdin SIGINT")

    def test_sigterm_stdin_exits_143_and_cleans_temp_file(self):
        rc, err, before = self._interrupt_stdin(signal.SIGTERM)
        self._assert_clean_abort(signal.SIGTERM, rc, err, before,
                                 "stdin SIGTERM")


class DocumentedCodes(unittest.TestCase):
    """The chosen codes are the shell conventions and are documented."""

    def test_constants_are_the_shell_conventions(self):
        self.assertEqual(EXIT_INT, 130)    # 128 + SIGINT(2)
        self.assertEqual(EXIT_TERM, 143)   # 128 + SIGTERM(15)

    def test_exit_codes_md_documents_both(self):
        doc_path = os.path.join(HERE, "EXIT-CODES.md")
        with open(doc_path, "r", encoding="utf-8") as fh:
            doc = fh.read()
        self.assertIn("130", doc)
        self.assertIn("143", doc)
        low = doc.lower()
        self.assertIn("sigint", low)
        self.assertIn("sigterm", low)


if __name__ == "__main__":
    unittest.main()

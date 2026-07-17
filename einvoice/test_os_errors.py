#!/usr/bin/env python3
"""test_os_errors.py — OS-level input-error discipline of the single-file
CLI paths (T-VHOSERR.1).

THE MEASURED MATRIX THIS PINS (measured live 2026-07-17, before the fix, by
driving ``python3 -m einvoice`` by hand — every row covers BOTH ``validate``
and ``receipt`` unless marked):

  leg                         before the fix                     pinned now
  --------------------------  ---------------------------------  -------------------------
  nonexistent path            exit 2, "error: no such file: X"   unchanged (verify+close)
  unreadable file (chmod 000) exit 1 + RAW PermissionError       exit 2, "error: cannot
                              TRACEBACK — crash-looking, and      read X: Permission
                              exit 1 masqueraded as a FAIL        denied", zero traceback
                              verdict when NO validation ran
  directory as input          exit 2 but the WRONG reason         exit 2, "error: is a
                              ("no such file" for a directory     directory ...: X"
                              that plainly exists)
  dangling symlink            exit 2, "no such file" (link        exit 2, "error: dangling
                              itself exists — misleading)         symlink ...: X"
  validate - , stdin CLOSED   exit 1 + AttributeError TRACEBACK   exit 2, "error: cannot
  (fd 0 closed at startup;    (sys.stdin is None -> .buffer        read -: stdin is
  validate-only leg)          blew up)                            closed", zero traceback
  validate - , stdin EMPTY    exit 3, clean S-WF parse error —    unchanged (verify+close;
  (validate-only leg)         already actionable                  pinned as a control)

WHAT EVERY OS-ERROR LEG ASSERTS: a documented ACTIONABLE non-zero exit
(EXIT_USAGE=2 — no validation happened, so no verdict code is ever minted),
stderr naming BOTH the offending path AND the reason, and ZERO occurrences of
``Traceback`` on stderr. The fix in cli.py catches exactly the OSError family
(FileNotFoundError / PermissionError / IsADirectoryError / OSError) at the
single-file entry boundary — never a bare ``except`` — and BrokenPipeError is
explicitly re-raised so the documented 141 contract is untouched.

ROOT-PROOFING: a user that bypasses permission bits (root, CAP_DAC_OVERRIDE)
can still read a chmod-000 file, so the unreadable leg PROBES first with
``os.access(path, os.R_OK)`` and SELF-SKIPS with a printed reason instead of
failing — the leg is meaningful only where the OS actually enforces the bits.

WHAT IS DELIBERATELY OUT OF SCOPE: validate-batch (its resilience is already
pinned elsewhere: per-file errors become ERROR entries, never a crash), and
every verdict/finding — a valid fixture must still PASS with exit 0 after the
fix (pinned by the control test below).

Fictional filenames only; the real CLI is driven as a subprocess (the closed-
stdin leg needs a genuinely closed fd 0, impossible in-process). Zero new
dependencies; plain ``python3 test_os_errors.py``; nonzero exit on failure.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.cli import EXIT_USAGE, EXIT_PARSE, EXIT_OK  # noqa: E402

#: Committed valid fixture: copied (then chmod 000) for the unreadable leg,
#: and validated untouched for the no-verdict-change control.
PASS_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                            "cen-bis3-positive_ubl.xml")

#: Both single-file subcommands share the OS-error discipline.
SUBCOMMANDS = ("validate", "receipt")


def _run(argv, stdin=subprocess.DEVNULL, close_stdin=False):
    """Drive the REAL CLI (``python3 -m einvoice ...``) and return
    (returncode, stdout_bytes, stderr_bytes). ``close_stdin=True`` execs the
    interpreter with fd 0 genuinely CLOSED (via a tiny sh redirect), the state
    that made ``sys.stdin`` None and blew up ``validate -`` pre-fix."""
    cmd = [sys.executable, "-m", "einvoice"] + list(argv)
    if close_stdin:
        # `exec 0<&-` closes fd 0 in the shell, then exec's the CLI with it
        # still closed — CPython then starts with sys.stdin = None.
        sh = "exec 0<&- ; exec " + " ".join(
            "'%s'" % a.replace("'", "'\\''") for a in cmd)
        proc = subprocess.Popen(["/bin/sh", "-c", sh], cwd=HERE,
                                stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE)
    else:
        proc = subprocess.Popen(cmd, cwd=HERE, stdin=stdin,
                                stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE)
    out, err = proc.communicate()
    return proc.returncode, out, err


class _OSErrorLegMixin:
    """Shared assertions: every OS-error leg must be actionable + quiet."""

    def assert_actionable(self, rc, err, path_shown, reason_fragment):
        err_text = err.decode("utf-8", "replace")
        # Documented non-zero exit: EXIT_USAGE (2) — the tool was pointed at
        # something that cannot be an invoice file; no validation happened,
        # so neither verdict code (0/1) nor the parse code (3) may appear.
        self.assertEqual(rc, EXIT_USAGE, "stderr was: %r" % err_text)
        self.assertNotEqual(rc, 0)
        # stderr names the offending path AND the reason.
        self.assertIn(path_shown, err_text)
        self.assertIn(reason_fragment, err_text)
        self.assertTrue(err_text.startswith("error: "),
                        "expected one actionable error: line, got %r"
                        % err_text)
        # ZERO traceback bytes — the whole point of the discipline.
        self.assertNotIn(b"Traceback", err)


class NonexistentPath(_OSErrorLegMixin, unittest.TestCase):
    """Leg 1 (verify-and-close): a path that does not exist was ALREADY
    handled pre-fix — exit 2 + "no such file" naming the path. Pinned so it
    can never regress; test_exit_codes.py pins the validate arm too and is
    deliberately not duplicated beyond this cross-subcommand matrix row."""

    def test_nonexistent_both_subcommands(self):
        ghost = os.path.join(tempfile.gettempdir(),
                             "einvoice-zz-fictional-does-not-exist.xml")
        self.assertFalse(os.path.exists(ghost))
        for sub in SUBCOMMANDS:
            with self.subTest(subcommand=sub):
                rc, _out, err = _run([sub, ghost])
                self.assert_actionable(rc, err, ghost, "no such file")


class UnreadableFile(_OSErrorLegMixin, unittest.TestCase):
    """Leg 2 (the headline defect): an EXISTING but unreadable (chmod 000)
    invoice raised a raw PermissionError traceback with exit 1 — a fake FAIL
    verdict for a run that validated nothing. Now: exit 2, one line naming
    the path + "Permission denied", zero traceback."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="einvoice-oserr-")
        self.addCleanup(shutil.rmtree, self.tmpdir, True)
        self.path = os.path.join(self.tmpdir, "zz-fictional-unreadable.xml")
        shutil.copyfile(PASS_FIXTURE, self.path)
        os.chmod(self.path, 0o000)
        # Let cleanup remove it even on old rmtree implementations.
        self.addCleanup(os.chmod, self.path, 0o600)

    def test_unreadable_both_subcommands(self):
        # PROBE FIRST: root / CAP_DAC_OVERRIDE ignores permission bits, so
        # chmod 000 would not actually make the file unreadable and the leg
        # would be meaningless — self-skip cleanly with a printed reason.
        if os.access(self.path, os.R_OK):
            reason = ("chmod 000 file is still readable by this user "
                      "(uid=%d, e.g. root/CAP_DAC_OVERRIDE) — the OS is not "
                      "enforcing permission bits, so the unreadable leg is "
                      "unmeasurable here; skipping it cleanly." % os.getuid())
            print("SKIP unreadable-file leg: " + reason)
            self.skipTest(reason)
        for sub in SUBCOMMANDS:
            with self.subTest(subcommand=sub):
                rc, _out, err = _run([sub, self.path])
                self.assert_actionable(rc, err, self.path,
                                       "Permission denied")
                self.assertIn(b"cannot read", err)


class DirectoryAsInput(_OSErrorLegMixin, unittest.TestCase):
    """Leg 3: a directory where a file is expected. Pre-fix this exited 2 but
    lied about the reason ("no such file" for a directory that exists — the
    IsADirectoryError family, triaged via os.path.isdir before open()). Now
    the message says it IS a directory and points at validate-batch."""

    def test_directory_both_subcommands(self):
        tmpdir = tempfile.mkdtemp(prefix="einvoice-oserr-dir-")
        self.addCleanup(shutil.rmtree, tmpdir, True)
        adir = os.path.join(tmpdir, "zz-fictional-invoices-dir")
        os.mkdir(adir)
        self.assertTrue(os.path.isdir(adir))
        for sub in SUBCOMMANDS:
            with self.subTest(subcommand=sub):
                rc, _out, err = _run([sub, adir])
                self.assert_actionable(rc, err, adir, "is a directory")
                # The actionable next step is named too.
                self.assertIn(b"validate-batch", err)


class DanglingSymlink(_OSErrorLegMixin, unittest.TestCase):
    """Leg 4: a symlink whose target does not exist. The link itself EXISTS
    (os.path.islink is True), so the pre-fix "no such file" was misleading;
    now the message says dangling symlink + that the target is missing."""

    def test_dangling_symlink_both_subcommands(self):
        tmpdir = tempfile.mkdtemp(prefix="einvoice-oserr-link-")
        self.addCleanup(shutil.rmtree, tmpdir, True)
        link = os.path.join(tmpdir, "zz-fictional-dangling.xml")
        os.symlink(os.path.join(tmpdir, "zz-fictional-missing-target.xml"),
                   link)
        self.assertTrue(os.path.islink(link))
        self.assertFalse(os.path.exists(link))
        for sub in SUBCOMMANDS:
            with self.subTest(subcommand=sub):
                rc, _out, err = _run([sub, link])
                self.assert_actionable(rc, err, link, "dangling symlink")


class StdinPath(unittest.TestCase):
    """Leg 5 (validate-only): ``validate -``. Measurement showed the CLOSED-
    stdin state was uncovered and crashing (AttributeError traceback, exit 1
    — sys.stdin is None when fd 0 is closed at startup); EMPTY stdin was
    already a clean S-WF parse error (exit 3) and is pinned as a control."""

    def test_closed_stdin_is_actionable_not_a_traceback(self):
        rc, _out, err = _run(["validate", "-"], close_stdin=True)
        err_text = err.decode("utf-8", "replace")
        self.assertEqual(rc, EXIT_USAGE, "stderr was: %r" % err_text)
        self.assertIn("cannot read -", err_text)
        self.assertIn("stdin is closed", err_text)
        self.assertNotIn(b"Traceback", err)

    def test_empty_stdin_still_clean_parse_error(self):
        # Verify-and-close control: empty stdin was ALREADY handled — the
        # staged zero bytes are not well-formed XML, exit 3, no traceback.
        rc, _out, err = _run(["validate", "-"], stdin=subprocess.DEVNULL)
        self.assertEqual(rc, EXIT_PARSE)
        self.assertIn(b"not well-formed", err)
        self.assertNotIn(b"Traceback", err)


class NoVerdictChange(unittest.TestCase):
    """HARD-LINE control: the OS-error boundary changed NO verdict — the
    committed valid fixture still PASSES with exit 0 through both
    subcommands after the fix."""

    def test_valid_fixture_still_passes(self):
        rc, out, err = _run(["validate", PASS_FIXTURE])
        self.assertEqual(rc, EXIT_OK, "stderr was: %r" % err)
        self.assertIn(b"PASS", out)
        rc, out, _err = _run(["receipt", PASS_FIXTURE])
        self.assertEqual(rc, EXIT_OK)
        self.assertIn(b'"verdict":"PASS"', out)  # canonical (no-space) JSON


class DocumentedInExitCodes(unittest.TestCase):
    """The OS-error rows are DOCUMENTED: EXIT-CODES.md names the directory
    and permission/unreadable (and dangling-symlink / closed-stdin) cases in
    its exit-2 taxonomy — the doc and the code cannot drift apart silently."""

    def test_exit_codes_md_names_the_os_error_inputs(self):
        with open(os.path.join(HERE, "EXIT-CODES.md"), encoding="utf-8") as fh:
            doc = fh.read().lower()
        for needle in ("directory", "permission", "unreadable",
                       "dangling symlink", "stdin is closed"):
            self.assertIn(needle, doc,
                          "EXIT-CODES.md must document the %r OS-error input"
                          % needle)


if __name__ == "__main__":
    unittest.main(verbosity=2)

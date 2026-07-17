#!/usr/bin/env python3
"""test_os_error_formats.py — OS-error × machine-format interaction
(T-VHOSERR.2).

T-VHOSERR.1 (test_os_errors.py) pinned the HUMAN-output discipline of the
``python3 -m einvoice validate|receipt`` paths for OS-level input errors.
This file pins the MACHINE-FORMAT interaction on the surface that actually
exposes ``--format``: ``python3 -m einvoice.report <file> --format <fmt>``
(the ``einvoice validate`` subcommand exposes NO ``--format`` flag — that
non-surface is pinned by a guard test below so it cannot grow one silently).

THE MEASURED MATRIX THIS PINS (measured live 2026-07-17, BEFORE the one fix,
by driving ``python3 -m einvoice.report --format <F> <bad-input>`` for every
F in REPORT_FORMATS = json, junit, sarif, gitlab, github, azure, badge,
html, text):

  OS-error class     before the fix (all 9 formats alike)      pinned now
  -----------------  ----------------------------------------  ------------
  nonexistent path   exit 1, stdout EMPTY (0 bytes), stderr    unchanged
                     one line "error: no such file: X"         (verify+close)
  unreadable file    exit 1, stdout EMPTY, but a RAW           exit 1, stdout
  (chmod 000)        PermissionError TRACEBACK on stderr —     EMPTY, stderr
                     the ONLY class violating the discipline   "error: cannot
                                                               read X:
                                                               Permission
                                                               denied", zero
                                                               traceback
  directory as       json/junit/text: DESIGNED batch mode —    unchanged
  input              a complete, parseable batch document on   (verify+close;
                     stdout (schema einvoice-conformance-      pinned per
                     batch/v1 for json), exit via              sub-row below)
                     batch_exit_code. All 6 other formats:
                     exit 1, stdout EMPTY, stderr "error:
                     --format <F> validates a single file;
                     use json/junit/text for a directory"
  dangling symlink   exit 1, stdout EMPTY, stderr one line     unchanged
                     "error: no such file: X"                  (verify+close)

THE PINNED RULE (what every leg asserts): stdout carries EITHER a complete,
fully-parseable machine document (json.loads over the WHOLE byte string /
ElementTree over the WHOLE byte string — both reject trailing garbage, same
technique as test_stdout_purity.py) OR is completely EMPTY with exactly one
actionable ``error:`` diagnostic line on stderr naming the offending path.
NEVER a half-emitted document, NEVER a traceback, NEVER diagnostic text
interleaved into a machine document. The measurement showed the code already
follows the EMPTY-stdout branch for every true OS error (the diagnostic
lands before any emitter runs), so that is what is pinned; the fix only had
to convert the unreadable-file traceback into the same one-line form.

EXIT CODES ARE UNCHANGED: this surface's measured, documented code for an
OS-level input error is EXIT_FAIL (1) — report.py mints no EXIT_USAGE(2);
its usage errors have always been 1 (pinned by test_report_formats.py's
unknown-format leg). The cli.py exit-2 taxonomy from EXIT-CODES.md /
test_os_errors.py applies to ``python3 -m einvoice`` and is untouched. The
directory×{json,junit,text} rows keep their designed batch exit
(batch_exit_code: 0 for a directory with no findings).

ROOT-PROOFING: same pattern as test_os_errors.py — root/CAP_DAC_OVERRIDE can
read a chmod-000 file, so the unreadable legs PROBE with os.access(..., R_OK)
and SELF-SKIP with a printed reason where the OS does not enforce the bits.

Fictional filenames only; the real CLI is driven as a subprocess. Zero new
dependencies; plain ``python3 test_os_error_formats.py``; nonzero on failure.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.report import (  # noqa: E402
    EXIT_OK, EXIT_FAIL, REPORT_FORMATS)
from einvoice.cli import EXIT_USAGE  # noqa: E402

#: Committed valid fixture (the same pair test_report_formats drives):
#: copied then chmod 000 for the unreadable legs.
PASS_FIXTURE = os.path.join(HERE, "examples", "01-missing-fields",
                            "fixed.xml")

#: The whole-document machine formats (test_stdout_purity.py's derived set:
#: registry minus the documented human/stream exclusions). Kept as an
#: explicit frozen expectation so a registry change forces a decision HERE
#: too — the acceptance minimum {json, junit, sarif, gitlab} is a subset.
DOC_FORMATS = ("json", "junit", "sarif", "gitlab", "badge")

#: Line-stream (github/azure workflow commands) + human (html/text) formats:
#: not one parseable document, but the OS-error rule — empty stdout, one
#: stderr diagnostic — is pinned for them identically.
OTHER_FORMATS = ("github", "azure", "html", "text")

#: Directory input is DESIGNED batch mode for exactly these formats.
BATCH_FORMATS = ("json", "junit", "text")


def _run_report(argv):
    """Drive the REAL ``python3 -m einvoice.report ...``; return
    (returncode, stdout_bytes, stderr_bytes)."""
    env = dict(os.environ)
    env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.run(
        [sys.executable, "-m", "einvoice.report"] + list(argv),
        cwd=HERE, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return proc.returncode, proc.stdout, proc.stderr


def _run_cli(argv):
    """Drive the REAL ``python3 -m einvoice ...`` (the cli.py surface)."""
    proc = subprocess.run(
        [sys.executable, "-m", "einvoice"] + list(argv),
        cwd=HERE, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return proc.returncode, proc.stdout, proc.stderr


class _FormatMatrixMixin:
    """The pinned OS-error × format rule, shared by every error-class case."""

    def assert_empty_stdout_diag_on_stderr(self, fmt, rc, out, err,
                                           path_shown=None,
                                           want_rc=EXIT_FAIL):
        """The EMPTY-stdout branch of the rule: nothing on stdout (so no
        parser downstream can see a truncated document), exactly one
        actionable diagnostic line on stderr naming the path, the measured
        exit code, and zero traceback bytes on either stream."""
        err_text = err.decode("utf-8", "replace")
        self.assertEqual(rc, want_rc,
                         "--format %s: rc=%r stderr=%r" % (fmt, rc, err_text))
        self.assertEqual(out, b"",
                         "--format %s: OS-error run must leave stdout "
                         "completely EMPTY, got %r" % (fmt, out[:200]))
        self.assertTrue(err_text.startswith("error: "),
                        "--format %s: expected one actionable error: line, "
                        "got %r" % (fmt, err_text))
        if path_shown is not None:
            self.assertIn(path_shown, err_text)
        self.assertNotIn(b"Traceback", err)
        self.assertNotIn(b"Traceback", out)

    def all_formats(self):
        """Frozen expectation of the registry — if report.py grows or drops
        a format, this fails and forces classifying it in this matrix."""
        self.assertEqual(set(REPORT_FORMATS),
                         set(DOC_FORMATS) | set(OTHER_FORMATS),
                         "report.py format registry changed — classify the "
                         "new/removed format in test_os_error_formats.py")
        return DOC_FORMATS + OTHER_FORMATS


class NonexistentPathAllFormats(_FormatMatrixMixin, unittest.TestCase):
    """Class 1 (verify-and-close): a path that does not exist. Measured
    ALREADY consistent across all 9 formats — empty stdout, one 'error: no
    such file' stderr line, exit 1 — pinned so it can never regress."""

    def test_every_format(self):
        ghost = os.path.join(tempfile.gettempdir(),
                             "einvoice-zz-fictional-does-not-exist.xml")
        self.assertFalse(os.path.exists(ghost))
        for fmt in self.all_formats():
            with self.subTest(fmt=fmt):
                rc, out, err = _run_report(["--format", fmt, ghost])
                self.assert_empty_stdout_diag_on_stderr(
                    fmt, rc, out, err, ghost)
                self.assertIn(b"no such file", err)


class UnreadableFileAllFormats(_FormatMatrixMixin, unittest.TestCase):
    """Class 2 (the one fixed leg): an EXISTING but unreadable (chmod 000)
    invoice passed isfile(), then open() inside build_report raised a raw
    PermissionError traceback — measured identically under all 9 formats.
    Now: the OSError is caught BEFORE any emitter writes a byte, so stdout
    stays empty and stderr carries one line naming path + reason; the exit
    code stays this surface's measured 1."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="einvoice-oserrfmt-")
        self.addCleanup(shutil.rmtree, self.tmpdir, True)
        self.path = os.path.join(self.tmpdir, "zz-fictional-unreadable.xml")
        shutil.copyfile(PASS_FIXTURE, self.path)
        os.chmod(self.path, 0o000)
        self.addCleanup(os.chmod, self.path, 0o600)

    def test_every_format(self):
        # PROBE FIRST (same pattern as test_os_errors.py): root /
        # CAP_DAC_OVERRIDE ignores permission bits, so chmod 000 would not
        # actually make the file unreadable — self-skip with the reason.
        if os.access(self.path, os.R_OK):
            reason = ("chmod 000 file is still readable by this user "
                      "(uid=%d, e.g. root/CAP_DAC_OVERRIDE) — the OS is not "
                      "enforcing permission bits, so the unreadable legs are "
                      "unmeasurable here; skipping them cleanly."
                      % os.getuid())
            print("SKIP unreadable-file legs: " + reason)
            self.skipTest(reason)
        for fmt in self.all_formats():
            with self.subTest(fmt=fmt):
                rc, out, err = _run_report(["--format", fmt, self.path])
                self.assert_empty_stdout_diag_on_stderr(
                    fmt, rc, out, err, self.path)
                self.assertIn(b"cannot read", err)
                self.assertIn(b"Permission denied", err)


class DirectoryAllFormats(_FormatMatrixMixin, unittest.TestCase):
    """Class 3 (verify-and-close): a directory positional. For report.py a
    directory is NOT an OS error under json/junit/text — it is the DESIGNED
    batch mode, and the measured output is a complete, parseable batch
    document on stdout. Every other format refuses it with the empty-stdout
    diagnostic branch. Both branches of the pinned rule, both pinned."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="einvoice-oserrfmt-dir-")
        self.addCleanup(shutil.rmtree, self.tmpdir, True)
        self.adir = os.path.join(self.tmpdir, "zz-fictional-invoices-dir")
        os.mkdir(self.adir)

    def test_batch_formats_emit_a_complete_document(self):
        # json/junit: WHOLE stdout must parse (json.loads / ET.fromstring
        # over the full byte string reject any interleaved or trailing
        # diagnostic bytes — the exact anti-half-document assertion). The
        # empty directory batch-passes: batch_exit_code -> 0.
        for fmt in ("json", "junit"):
            with self.subTest(fmt=fmt):
                rc, out, err = _run_report(["--format", fmt, self.adir])
                self.assertEqual(rc, EXIT_OK, err)
                text = out.decode("utf-8")  # strict: stray bytes -> fail
                self.assertTrue(text.strip(),
                                "batch %s emitted empty stdout" % fmt)
                if fmt == "json":
                    doc = json.loads(text)
                    self.assertEqual(doc.get("schema"),
                                     "einvoice-conformance-batch/v1")
                    self.assertEqual(doc.get("file_count"), 0)
                else:
                    root = ET.fromstring(text)
                    self.assertEqual(root.tag, "testsuites")
                self.assertNotIn(b"Traceback", err)
                self.assertNotIn(b"error:", out)
        # text is the third designed batch format — human prose, so only
        # the no-diagnostic-corruption half is pinned for it.
        rc, out, err = _run_report(["--format", "text", self.adir])
        self.assertEqual(rc, EXIT_OK, err)
        self.assertTrue(out.strip())
        self.assertNotIn(b"Traceback", err)

    def test_single_file_formats_refuse_with_empty_stdout(self):
        for fmt in self.all_formats():
            if fmt in BATCH_FORMATS:
                continue
            with self.subTest(fmt=fmt):
                rc, out, err = _run_report(["--format", fmt, self.adir])
                # The measured refusal message names the format and the
                # batch-capable alternatives, NOT the path — a pre-existing
                # wording this task deliberately does not touch, so the
                # path_shown check is skipped for this one row.
                self.assert_empty_stdout_diag_on_stderr(fmt, rc, out, err)
                self.assertIn(("--format %s" % fmt).encode(), err)
                self.assertIn(b"json/junit/text", err)


class DanglingSymlinkAllFormats(_FormatMatrixMixin, unittest.TestCase):
    """Class 4 (verify-and-close): a symlink whose target is missing.
    Measured: isfile() is False, so every format takes the same empty-stdout
    'no such file' branch as a nonexistent path, exit 1. (The friendlier
    'dangling symlink' wording is a cli.py refinement from T-VHOSERR.1; this
    surface's stdout/stderr discipline is what matters here and is already
    rule-conformant, so verify-and-close — no message change.)"""

    def test_every_format(self):
        tmpdir = tempfile.mkdtemp(prefix="einvoice-oserrfmt-link-")
        self.addCleanup(shutil.rmtree, tmpdir, True)
        link = os.path.join(tmpdir, "zz-fictional-dangling.xml")
        os.symlink(os.path.join(tmpdir, "zz-fictional-missing-target.xml"),
                   link)
        self.assertTrue(os.path.islink(link))
        self.assertFalse(os.path.exists(link))
        for fmt in self.all_formats():
            with self.subTest(fmt=fmt):
                rc, out, err = _run_report(["--format", fmt, link])
                self.assert_empty_stdout_diag_on_stderr(
                    fmt, rc, out, err, link)
                self.assertIn(b"no such file", err)


class ValidateExposesNoFormatFlag(unittest.TestCase):
    """Guard: ``python3 -m einvoice validate --format json <path>`` is NOT a
    machine-format surface — cli.py's validate takes --json only. Measured:
    the unrecognized extra arguments are a usage error (exit 2, empty
    stdout, usage banner on stderr) BEFORE the path is even touched, for
    every OS-error class alike. Pinned so the matrix above provably covers
    the whole --format surface; if validate ever grows --format, this fails
    and forces extending the matrix to it."""

    def test_validate_rejects_format_flag_with_clean_usage_error(self):
        ghost = os.path.join(tempfile.gettempdir(),
                             "einvoice-zz-fictional-does-not-exist.xml")
        self.assertFalse(os.path.exists(ghost))
        rc, out, err = _run_cli(["validate", "--format", "json", ghost])
        self.assertEqual(rc, EXIT_USAGE, err)
        self.assertEqual(out, b"")
        self.assertNotIn(b"Traceback", err)


class NoVerdictChange(unittest.TestCase):
    """HARD-LINE control: the OS-error read boundary changed NO verdict —
    the committed conformant fixture still passes with a complete document
    and exit 0 through a doc format and a stream format."""

    def test_valid_fixture_still_passes(self):
        rc, out, err = _run_report(["--format", "json", PASS_FIXTURE])
        self.assertEqual(rc, EXIT_OK, err)
        doc = json.loads(out.decode("utf-8"))
        self.assertEqual(doc.get("schema"), "einvoice-conformance-report/v1")
        self.assertEqual(doc.get("fatal_count"), 0)
        rc, out, err = _run_report(["--format", "junit", PASS_FIXTURE])
        self.assertEqual(rc, EXIT_OK, err)
        self.assertEqual(ET.fromstring(out.decode("utf-8")).tag,
                         "testsuites")


class DocumentedInReportFormats(unittest.TestCase):
    """The rule is DOCUMENTED: REPORT-FORMATS.md carries an 'OS-level input
    errors' section naming the empty-stdout rule, the exit code, and the
    directory batch exception — doc and code cannot drift apart silently."""

    def test_report_formats_md_documents_the_os_error_rule(self):
        with open(os.path.join(HERE, "REPORT-FORMATS.md"),
                  encoding="utf-8") as fh:
            doc = fh.read()
        lowered = doc.lower()
        self.assertIn("os-level input errors", lowered)
        for needle in ("empty", "stderr", "unreadable", "dangling",
                       "traceback"):
            self.assertIn(needle, lowered,
                          "REPORT-FORMATS.md OS-error section must mention "
                          "%r" % needle)


if __name__ == "__main__":
    unittest.main(verbosity=2)

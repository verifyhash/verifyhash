#!/usr/bin/env python3
"""test_stdout_purity.py — stdout-purity contract for every machine format (T-VHPIPE.1).

Fast, stdlib-only, saxonche-free, offline (subprocesses only ever run the local
CLI — no network). This test adds and changes NOTHING in the product: it is a
VERIFY-AND-CLOSE regression guard. Measurement (2026-07-16, at fea9d4f) found
every machine-format path ALREADY pure — this file pins that so it can never
silently regress.

THE CONTRACT under guard: when a CI system parses a report off stdout, the
ENTIRE stdout byte string IS the report — nothing else is ever interleaved.
Diagnostics (usage errors, the S-WF not-well-formed message, human PASS/FAIL
summaries, the "Syntax-binding warnings: N" counter line) belong to stderr or
to the human text format only. Concretely, for every machine surface:

  1. the WHOLE stdout byte string parses as its format (json.loads /
     ElementTree.fromstring over the full payload — a single stray byte before
     or after the document fails the parse and therefore this test);
  2. the exit code matches the EXIT-CODES.md contract for that path;
  3. diagnostics land ONLY on stderr, and NO diagnostic was deleted to buy
     purity — the human path is asserted to STILL print its PASS/FAIL verdict
     and its "Syntax-binding warnings: N" line.

Machine surfaces covered (both a committed VALID and a committed INVALID
fixture each, plus batch and receipt):

  * ``python3 -m einvoice.report <file> --format <fmt>`` for every machine
    format in the report registry (derived from report.py source, below);
  * ``python3 -m einvoice.report <dir> --format <fmt>`` for the machine subset
    of the batch registry (json, junit);
  * ``python3 -m einvoice validate <file> --json`` (the cli machine surface —
    the cli's ``validate`` takes ``--json``, not ``--format``);
  * ``python3 -m einvoice validate-batch <dir> --json``;
  * ``python3 -m einvoice receipt <file>`` (always canonical JSON).

The format registry is DERIVED from einvoice/report.py source (the same
``fmt not in (...)`` extraction test_report_formats.py already uses — the
registry is an inline tuple there, so source extraction IS the enumeration),
never hand-typed, so a newly added format automatically lands in this gate
unless it is explicitly excluded below with a reason:

  * ``text``   — the HUMAN summary; free prose by design, nothing parses it.
  * ``html``   — a human-facing browser document, not a CI-parsed data format.
  * ``github`` — a line-oriented GitHub Actions ::workflow-command STREAM the
                 runner scans per-line; it is not one parseable document.
  * ``azure``  — same, an Azure DevOps ##vso[] logging-command line stream.

Profile note: every run pins ``--profile=xrechnung`` because the invalid
fixture's fatal is a BR-DE (XRechnung CIUS) rule — under the cli's en16931
default it would pass. report.py's default is already xrechnung; pinning both
keeps the valid/invalid split identical across all surfaces.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.cli import (  # noqa: E402
    EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_PARSE,
)

REPORT_PY = os.path.join(HERE, "einvoice", "report.py")

# The committed known-good / known-bad pair (same one test_report_formats and
# test_report_gitlab drive — no new corpus, no synthesized invoices).
EX = os.path.join(HERE, "examples", "01-missing-fields")
VALID = os.path.join(EX, "fixed.xml")     # conformant       -> exit 0
INVALID = os.path.join(EX, "broken.xml")  # fatal violations -> exit 1

PROFILE = "xrechnung"  # see module docstring: keeps cli and report.py aligned.

#: Human/stream formats EXCLUDED from the whole-stdout-parses contract — each
#: with its reason (also spelled out in the module docstring above):
EXCLUDED = {
    "text": "human summary prose — nothing machine-parses it",
    "html": "human browser document, not a CI-parsed data format",
    "github": "per-line ::workflow-command stream, not one parseable document",
    "azure": "per-line ##vso[] logging-command stream, not one document",
}


def _format_tuples():
    """Every ``fmt not in (...)`` tuple in report.py source, as sets of names.

    The registry in report.py is an inline tuple (there is no named constant),
    so extracting it from source is the honest enumeration — identical to the
    approach test_report_formats.py already gates the docs with.
    """
    with open(REPORT_PY, encoding="utf-8") as fh:
        src = fh.read()
    tuples = re.findall(r"fmt not in \(([^)]*)\)", src)
    assert tuples, "could not find any `fmt not in (...)` tuple in report.py"
    return [set(re.findall(r"[\"']([a-z]+)[\"']", t)) for t in tuples]


def registry():
    """The full single-file ``--format`` registry (the widest tuple)."""
    return max(_format_tuples(), key=len)


def batch_registry():
    """The batch-mode ``--format`` subset (the smallest tuple with 'json')."""
    candidates = [s for s in _format_tuples() if "json" in s]
    return min(candidates, key=len)


def machine_formats():
    """Registry minus the documented human/stream exclusions."""
    return registry() - set(EXCLUDED)


def run(argv, module):
    """Run ``python3 -m <module> <argv...>``; return (rc, stdout_BYTES, stderr_BYTES).

    stdout/stderr are captured as raw bytes on purpose: the contract is over
    the entire stdout BYTE string, not a decoded/normalized view of it.
    """
    env = dict(os.environ)
    env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.run(
        [sys.executable, "-m", module] + list(argv),
        cwd=HERE, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return proc.returncode, proc.stdout, proc.stderr


def parse_whole(testcase, fmt, stdout_bytes):
    """Assert the ENTIRE stdout byte string parses as ``fmt``; return the doc.

    json.loads and ET.fromstring both raise on ANY trailing (and json.loads on
    any leading) non-whitespace content, so handing them the full byte string
    is exactly the zero-stray-bytes assertion. Decoding strictly as UTF-8
    first also rejects stray non-text bytes.
    """
    text = stdout_bytes.decode("utf-8")  # strict: raises on undecodable bytes
    testcase.assertTrue(text.strip(), "%s emitted empty stdout" % fmt)
    if fmt in ("json", "sarif", "gitlab", "badge"):
        return json.loads(text)
    if fmt == "junit":
        return ET.fromstring(text)
    testcase.fail("no whole-stdout parser defined for machine format %r — add "
                  "one here or exclude the format with a reason" % fmt)


def assert_no_human_lines(testcase, stdout_bytes, ctx):
    """No human-summary diagnostic line may open any stdout line."""
    for line in stdout_bytes.decode("utf-8", "replace").splitlines():
        testcase.assertFalse(
            line.startswith(("PASS:", "FAIL:", "Syntax-binding warnings:",
                             "S-WF:", "error:", "usage:")),
            "%s: human/diagnostic line leaked into machine stdout: %r"
            % (ctx, line))


class RegistryDerivation(unittest.TestCase):
    """The machine set is DERIVED, and a new format cannot slip past silently."""

    def test_machine_set_is_the_expected_five(self):
        # If report.py ever grows a format, registry() picks it up and this
        # equality fails — forcing an explicit decision: cover it above or
        # exclude it in EXCLUDED with a reason. That is the drift guard.
        self.assertEqual(machine_formats(),
                         {"json", "junit", "sarif", "gitlab", "badge"},
                         "report.py format registry changed — classify the "
                         "new/removed format in test_stdout_purity.py")

    def test_exclusions_are_real_registry_members(self):
        self.assertLessEqual(set(EXCLUDED), registry(),
                             "EXCLUDED names a format report.py does not have")

    def test_batch_machine_subset(self):
        self.assertEqual(batch_registry() - set(EXCLUDED), {"json", "junit"})


class ReportCliWholeStdoutParses(unittest.TestCase):
    """python3 -m einvoice.report <file> --format <fmt>: stdout IS the report."""

    def _shape(self, fmt, doc):
        if fmt == "json":
            self.assertEqual(doc.get("schema"),
                             "einvoice-conformance-report/v1")
        elif fmt == "sarif":
            self.assertEqual(doc.get("version"), "2.1.0")
            self.assertIn("runs", doc)
        elif fmt == "gitlab":
            self.assertIsInstance(doc, list)
        elif fmt == "badge":
            # Exact shields.io endpoint shape: exactly these four keys.
            self.assertEqual(set(doc), {"schemaVersion", "label", "message",
                                        "color"})
            self.assertEqual(doc["schemaVersion"], 1)
        elif fmt == "junit":
            self.assertEqual(doc.tag, "testsuites")

    def test_valid_and_invalid_every_machine_format(self):
        for fmt in sorted(machine_formats()):
            for fixture, want_rc in ((VALID, EXIT_OK), (INVALID, EXIT_FAIL)):
                with self.subTest(fmt=fmt, fixture=os.path.basename(fixture)):
                    rc, out, err = run(
                        ["--profile", PROFILE, "--format", fmt, fixture],
                        "einvoice.report")
                    self.assertEqual(rc, want_rc,
                                     "%s %s: rc=%s stderr=%r"
                                     % (fmt, fixture, rc, err))
                    doc = parse_whole(self, fmt, out)
                    self._shape(fmt, doc)
                    assert_no_human_lines(self, out, "report --format " + fmt)


class BatchWholeStdoutParses(unittest.TestCase):
    """Batch surfaces: report.py <dir> --format json|junit, cli validate-batch --json."""

    def setUp(self):
        # An all-valid dir and a mixed dir, built ONLY from the two committed
        # fixtures, staged inside the repo tree (same pattern
        # test_report_formats uses for its baseline temp file) and removed.
        self.valid_dir = tempfile.mkdtemp(prefix="purity-valid-", dir=HERE)
        self.mixed_dir = tempfile.mkdtemp(prefix="purity-mixed-", dir=HERE)
        shutil.copy(VALID, os.path.join(self.valid_dir, "fixed.xml"))
        shutil.copy(VALID, os.path.join(self.mixed_dir, "fixed.xml"))
        shutil.copy(INVALID, os.path.join(self.mixed_dir, "broken.xml"))

    def tearDown(self):
        shutil.rmtree(self.valid_dir, ignore_errors=True)
        shutil.rmtree(self.mixed_dir, ignore_errors=True)

    def test_report_batch_machine_formats(self):
        for fmt in sorted(batch_registry() - set(EXCLUDED)):
            for directory, want_rc in ((self.valid_dir, EXIT_OK),
                                       (self.mixed_dir, EXIT_FAIL)):
                with self.subTest(fmt=fmt, batch=os.path.basename(directory)):
                    rc, out, err = run(
                        ["--profile", PROFILE, "--format", fmt, directory],
                        "einvoice.report")
                    self.assertEqual(rc, want_rc, err)
                    doc = parse_whole(self, fmt, out)
                    if fmt == "json":
                        self.assertEqual(doc.get("schema"),
                                         "einvoice-conformance-batch/v1")
                    assert_no_human_lines(self, out, "batch " + fmt)

    def test_cli_validate_batch_json(self):
        for directory, want_rc in ((self.valid_dir, EXIT_OK),
                                   (self.mixed_dir, EXIT_FAIL)):
            with self.subTest(batch=os.path.basename(directory)):
                rc, out, err = run(
                    ["validate-batch", directory, "--json",
                     "--profile=" + PROFILE], "einvoice")
                self.assertEqual(rc, want_rc, err)
                doc = parse_whole(self, "json", out)
                self.assertEqual(doc.get("schema"),
                                 "einvoice-conformance-batch/v1")
                assert_no_human_lines(self, out, "validate-batch --json")


class CliMachineSurfaces(unittest.TestCase):
    """python3 -m einvoice validate --json / receipt: whole stdout is JSON."""

    def test_validate_json_valid_and_invalid(self):
        for fixture, want_rc, want_valid in ((VALID, EXIT_OK, True),
                                             (INVALID, EXIT_FAIL, False)):
            with self.subTest(fixture=os.path.basename(fixture)):
                rc, out, err = run(
                    ["validate", fixture, "--json", "--profile=" + PROFILE],
                    "einvoice")
                self.assertEqual(rc, want_rc, err)
                doc = parse_whole(self, "json", out)
                self.assertEqual(doc.get("valid"), want_valid)
                # The syntax-binding count reaches CI as a JSON FIELD here —
                # the human counter line must never ride along on stdout.
                self.assertIn("syntax_binding_warning_count", doc)
                assert_no_human_lines(self, out, "validate --json")

    def test_validate_json_not_well_formed_is_pure_json_exit3(self):
        staged = tempfile.mkdtemp(prefix="purity-malformed-", dir=HERE)
        mal = os.path.join(staged, "mal.xml")
        try:
            with open(mal, "wb") as fh:
                fh.write(b"<Invoice><never-closed>")
            rc, out, err = run(["validate", mal, "--json"], "einvoice")
            self.assertEqual(rc, EXIT_PARSE, err)
            doc = parse_whole(self, "json", out)
            self.assertEqual(doc.get("error"), "not-well-formed")
            assert_no_human_lines(self, out, "validate --json malformed")
        finally:
            shutil.rmtree(staged, ignore_errors=True)

    def test_receipt_valid_and_invalid(self):
        for fixture, want_rc, want_verdict in ((VALID, EXIT_OK, "PASS"),
                                               (INVALID, EXIT_FAIL, "FAIL")):
            with self.subTest(fixture=os.path.basename(fixture)):
                rc, out, err = run(
                    ["receipt", fixture, "--profile=" + PROFILE], "einvoice")
                self.assertEqual(rc, want_rc, err)
                doc = parse_whole(self, "json", out)
                self.assertEqual(doc["receipt"]["verdict"], want_verdict)
                assert_no_human_lines(self, out, "receipt")


class DiagnosticsStderrOnlyAndNotDeleted(unittest.TestCase):
    """Criterion 3 both ways: diagnostics live on stderr / the human format —
    and they still EXIST (purity was not bought by deleting them)."""

    def test_swf_diagnostic_is_on_stderr_stdout_empty(self):
        staged = tempfile.mkdtemp(prefix="purity-swf-", dir=HERE)
        mal = os.path.join(staged, "mal.xml")
        try:
            with open(mal, "wb") as fh:
                fh.write(b"<Invoice><never-closed>")
            rc, out, err = run(["validate", mal], "einvoice")
            self.assertEqual(rc, EXIT_PARSE)
            self.assertEqual(out, b"",
                             "S-WF path wrote to stdout: %r" % out)
            self.assertIn(b"S-WF: input is not well-formed XML", err)
        finally:
            shutil.rmtree(staged, ignore_errors=True)

    def test_unknown_format_error_is_on_stderr_stdout_empty(self):
        rc, out, err = run(["--format", "nope", VALID], "einvoice.report")
        self.assertEqual(rc, EXIT_FAIL)
        self.assertEqual(out, b"", "usage diagnostic leaked to stdout")
        self.assertIn(b"error: unknown format", err)

    def test_missing_file_error_is_on_stderr_stdout_empty(self):
        rc, out, err = run(["validate", "does-not-exist.xml"], "einvoice")
        self.assertEqual(rc, EXIT_USAGE)
        self.assertEqual(out, b"")
        self.assertIn(b"error: no such file", err)

    def test_human_diagnostics_still_exist(self):
        # The human path must STILL print its verdict and the syntax-binding
        # counter — purity may never be achieved by deleting a diagnostic.
        rc, out, err = run(
            ["validate", VALID, "--profile=" + PROFILE], "einvoice")
        self.assertEqual(rc, EXIT_OK, err)
        text = out.decode("utf-8")
        self.assertIn("PASS:", text)
        self.assertIn("Syntax-binding warnings:", text)

        rc, out, err = run(
            ["validate", INVALID, "--profile=" + PROFILE], "einvoice")
        self.assertEqual(rc, EXIT_FAIL, err)
        text = out.decode("utf-8")
        self.assertIn("FAIL:", text)
        self.assertIn("Syntax-binding warnings:", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)

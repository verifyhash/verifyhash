#!/usr/bin/env python3
"""test_filename_robustness.py — awkward-but-legal INPUT FILENAMES
(T-VHFNAME.1, BATCH: covers T-VHFNAME.1 + T-VHFNAME.2).

The target buyer is a German ERP/accounting shop whose invoice files are
named like ``Rechnung_Müller_März.xml``. Every existing test drives the CLI
with clean ASCII fixture names; message-TEXT unicode is covered elsewhere
(test_lang.py, test_robustness_encoding.py) but the input FILENAME itself
had zero coverage. This file pins verdict invariance and machine-format
escaping for four awkward-but-legal name shapes, each applied to one
known-valid and one known-invalid fixture (the exact pass/fail pair
test_exit_codes.py already reuses — no new fixtures, fictional names only):

  (a) German umlauts + ß        Rechnung_Müller_ß_März.xml
  (b) spaces + parentheses      Müller Rechnung (Kopie).xml
  (c) apostrophe + ampersand    O'Brien & Söhne Rechnung.xml
  (d) ~150-char basename        Rechnung_Müllerß_aaaa…a.xml (150 chars,
                                152 UTF-8 bytes — legal under the 255-byte
                                ext4 NAME_MAX)

THE MEASURED MATRIX THIS PINS (measured live 2026-07-17 at ee8fc64; NO
defect was found, so this whole file is a verify-and-close regression
guard — zero production-code changes):

  surface                       filename behaviour                 pinned as
  ----------------------------  ---------------------------------  ----------
  einvoice validate <file>      path echoed verbatim in the        exit code +
  (human text)                  PASS:/FAIL: line, UTF-8 intact,    finding set
                                no mojibake, no traceback          identical to
                                                                   clean name
  einvoice receipt <file>       receipt JSON is PATH-INDEPENDENT   stdout
                                by design (test_receipt.py's       byte-equal
                                determinism property): hashes      to clean-
                                cover content, not location        named run
  einvoice.report --format      "source" field carries the path;   json.loads
  json                          non-ASCII survives the \\uXXXX      of ENTIRE
                                escape round-trip                  stdout, then
                                                                   parsed
                                                                   source ==
                                                                   exact path
  einvoice.report --format      finding "location.path" carries    same, via
  gitlab                        the path (empty [] for a clean     location.
                                file — then byte-equal to clean)   path
  einvoice.report --format      document embeds NO filesystem      byte-equal
  sarif                         path at all (logicalLocations      to clean-
                                only — by design)                  named run +
                                                                   parseable
  einvoice.report --format      single-file mode embeds NO path    byte-equal
  junit (single file)           (testcase name = rule id,          to clean-
                                classname = profile)               named run +
                                                                   parseable
  einvoice.report --format      BATCH (directory) mode puts the    ET.fromstring
  junit (directory batch)       full path in the <testsuite        of ENTIRE
                                name="..."> attribute via          stdout; the
                                xml.sax.saxutils.quoteattr — the   PARSED
                                one junit surface where '&', "'"   attribute
                                and umlauts must escape and        value ==
                                round-trip                         original path

SURFACE NOTE (same reality test_os_error_formats.py pinned): ``einvoice
validate`` exposes NO ``--format`` flag; the machine formats json / junit /
sarif / gitlab live on ``python3 -m einvoice.report <file> --format <fmt>``.
That is therefore the surface Leg B drives. ``--profile en16931`` is passed
explicitly so the valid fixture actually PASSES (report.py defaults to
xrechnung, under which the CEN fixture has a BR-DE-2 fatal — profile choice
is irrelevant to filename handling and pinning en16931 keeps both a PASS and
a FAIL column in every leg).

Zero new dependencies; run as plain ``python3 test_filename_robustness.py``
from this directory; exits non-zero on any failure; no network; every name
is fictional. This file EXTENDS test_report_formats.py (clean-named format
coverage) — it does not duplicate or modify it.
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

# Reused verbatim from test_exit_codes.py / test_cli.py — no new fixtures.
PASS_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                            "cen-bis3-positive_ubl.xml")
FAIL_FIXTURE = os.path.join(HERE, "fixtures",
                            "creditnote-invalid-typecode_ubl.xml")

# ~150-char basename: 17 + 129 + 4 = 150 chars; ü and ß are 2 UTF-8 bytes
# each -> 152 bytes, comfortably legal under NAME_MAX=255.
LONG_NAME = "Rechnung_Müllerß_" + ("a" * 129) + ".xml"
assert len(LONG_NAME) == 150, len(LONG_NAME)

AWKWARD_NAMES = [
    "Rechnung_Müller_ß_März.xml",        # umlauts + ß
    "Müller Rechnung (Kopie).xml",       # spaces + parentheses
    "O'Brien & Söhne Rechnung.xml",      # apostrophe + ampersand
    LONG_NAME,                           # ~150-char basename
]

CLEAN_NAME = "Rechnung.xml"              # ASCII baseline, same tmpdir depth

FIXTURES = [("valid", PASS_FIXTURE), ("invalid", FAIL_FIXTURE)]

REPORT_FORMATS = ["json", "junit", "sarif", "gitlab"]


def run(args):
    """Run the CLI as a subprocess from the einvoice dir; return the
    completed process with raw byte streams (we decode explicitly so a
    mojibake regression cannot hide behind text-mode replacement)."""
    return subprocess.run(
        [sys.executable] + args, cwd=HERE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def validate_cmd(path):
    return ["-m", "einvoice", "validate", path]


def receipt_cmd(path):
    return ["-m", "einvoice", "receipt", path]


def report_cmd(path, fmt):
    return ["-m", "einvoice.report", "--profile", "en16931",
            "--format", fmt, path]


class _Tree:
    """One tempdir per test class holding, for each fixture kind, a
    clean-named baseline copy plus every awkward-named copy — each in its
    OWN subdirectory so the basename is exactly the awkward shape."""

    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="einvoice-fname-")
        # {(kind, name): absolute path}
        self.paths = {}
        for kind, src in FIXTURES:
            for name in [CLEAN_NAME] + AWKWARD_NAMES:
                sub = os.path.join(
                    self.root, "%s_%d" % (kind, ([CLEAN_NAME] +
                                                 AWKWARD_NAMES).index(name)))
                os.makedirs(sub, exist_ok=True)
                dst = os.path.join(sub, name)
                shutil.copyfile(src, dst)
                self.paths[(kind, name)] = dst

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


def normalize(stdout_bytes, path):
    """Decode stdout as strict UTF-8 and replace the invoice path with a
    stable token, so verdict/finding text can be compared across names."""
    text = stdout_bytes.decode("utf-8")          # raises on invalid UTF-8
    return text.replace(path, "<PATH>")


class FixturesPresent(unittest.TestCase):
    def test_fixture_pair_present(self):
        self.assertTrue(os.path.isfile(PASS_FIXTURE), PASS_FIXTURE)
        self.assertTrue(os.path.isfile(FAIL_FIXTURE), FAIL_FIXTURE)


class LegAVerdictInvariance(unittest.TestCase):
    """T-VHFNAME.1 — validate + receipt: exit code and finding set are
    IDENTICAL to the clean-named run; human output echoes the exact UTF-8
    name with no mojibake and no traceback."""

    @classmethod
    def setUpClass(cls):
        cls.tree = _Tree()
        # Clean-named baselines, once per (fixture, command).
        cls.base = {}
        for kind, _src in FIXTURES:
            clean = cls.tree.paths[(kind, CLEAN_NAME)]
            for cmd_name, cmd in (("validate", validate_cmd),
                                  ("receipt", receipt_cmd)):
                cls.base[(kind, cmd_name)] = (run(cmd(clean)), clean)

    @classmethod
    def tearDownClass(cls):
        cls.tree.cleanup()

    def test_baseline_sanity(self):
        """The clean-named pair behaves as the documented pass/fail pair."""
        self.assertEqual(self.base[("valid", "validate")][0].returncode, 0)
        self.assertEqual(self.base[("invalid", "validate")][0].returncode, 1)
        self.assertIn(b"PASS:", self.base[("valid", "validate")][0].stdout)
        self.assertIn(b"FAIL:", self.base[("invalid", "validate")][0].stdout)

    def _check_pair(self, kind, cmd_name, cmd):
        base_proc, base_path = self.base[(kind, cmd_name)]
        for name in AWKWARD_NAMES:
            path = self.tree.paths[(kind, name)]
            proc = run(cmd(path))
            label = "%s %s %r" % (cmd_name, kind, name)
            # (1) exit code identical to the clean-named run
            self.assertEqual(proc.returncode, base_proc.returncode, label)
            # (2) no traceback on either stream
            self.assertNotIn(b"Traceback", proc.stderr, label)
            self.assertNotIn(b"Traceback", proc.stdout, label)
            # (3) verdict / finding set identical once the path itself is
            #     normalized away
            self.assertEqual(
                normalize(proc.stdout, path),
                normalize(base_proc.stdout, base_path), label)
            # (4) no mojibake: stdout is strict UTF-8 (normalize() already
            #     enforced that) and contains no U+FFFD replacement char
            self.assertNotIn("�", proc.stdout.decode("utf-8"), label)

    def test_validate_invariance_and_name_echo(self):
        self._check_pair("valid", "validate", validate_cmd)
        self._check_pair("invalid", "validate", validate_cmd)
        # validate echoes the path in its PASS:/FAIL: line — the exact
        # UTF-8 name must appear verbatim (byte-level, so no re-encoding
        # slippage can pass).
        for kind, _src in FIXTURES:
            for name in AWKWARD_NAMES:
                path = self.tree.paths[(kind, name)]
                proc = run(validate_cmd(path))
                self.assertIn(name.encode("utf-8"), proc.stdout,
                              "validate %s %r: name not echoed verbatim"
                              % (kind, name))

    def test_receipt_invariance(self):
        # The receipt is path-independent BY DESIGN (its hashes cover
        # content, not location) — measured: stdout is byte-identical to
        # the clean-named run. Pin exactly that, which is strictly
        # stronger than normalize-and-compare.
        self._check_pair("valid", "receipt", receipt_cmd)
        self._check_pair("invalid", "receipt", receipt_cmd)
        for kind, _src in FIXTURES:
            base_proc, _ = self.base[(kind, "receipt")]
            for name in AWKWARD_NAMES:
                proc = run(receipt_cmd(self.tree.paths[(kind, name)]))
                self.assertEqual(proc.stdout, base_proc.stdout,
                                 "receipt %s %r: stdout not byte-identical"
                                 % (kind, name))


class LegBMachineFormats(unittest.TestCase):
    """T-VHFNAME.2 — the same awkward names through
    ``einvoice.report --format json|junit|sarif|gitlab`` yield COMPLETE
    parseable stdout with the filename round-tripping byte-correctly."""

    @classmethod
    def setUpClass(cls):
        cls.tree = _Tree()
        cls.base = {}
        for kind, _src in FIXTURES:
            clean = cls.tree.paths[(kind, CLEAN_NAME)]
            for fmt in REPORT_FORMATS:
                cls.base[(kind, fmt)] = (run(report_cmd(clean, fmt)), clean)

    @classmethod
    def tearDownClass(cls):
        cls.tree.cleanup()

    def _each(self):
        for kind, _src in FIXTURES:
            for name in AWKWARD_NAMES:
                yield kind, name, self.tree.paths[(kind, name)]

    def test_exit_codes_match_clean_run(self):
        for kind, name, path in self._each():
            for fmt in REPORT_FORMATS:
                proc = run(report_cmd(path, fmt))
                base_proc, _ = self.base[(kind, fmt)]
                self.assertEqual(
                    proc.returncode, base_proc.returncode,
                    "--format %s %s %r" % (fmt, kind, name))
                self.assertNotIn(b"Traceback", proc.stderr,
                                 "--format %s %s %r" % (fmt, kind, name))

    def test_json_entire_stdout_parses_and_source_roundtrips(self):
        for kind, name, path in self._each():
            proc = run(report_cmd(path, "json"))
            doc = json.loads(proc.stdout.decode("utf-8"))  # ENTIRE stdout
            # Non-ASCII must survive the \\uXXXX escape round-trip exactly.
            self.assertEqual(doc["source"], path,
                             "json %s %r: source did not round-trip"
                             % (kind, name))

    def test_gitlab_entire_stdout_parses_and_path_roundtrips(self):
        for kind, name, path in self._each():
            proc = run(report_cmd(path, "gitlab"))
            findings = json.loads(proc.stdout.decode("utf-8"))
            self.assertIsInstance(findings, list)
            if kind == "invalid":
                # Measured: every finding names the input in location.path.
                self.assertTrue(findings, "gitlab invalid %r: no findings"
                                % name)
                for f in findings:
                    self.assertEqual(
                        f["location"]["path"], path,
                        "gitlab %r: location.path did not round-trip" % name)
            else:
                # A clean file yields [] — byte-identical to the clean run.
                base_proc, _ = self.base[(kind, "gitlab")]
                self.assertEqual(proc.stdout, base_proc.stdout)

    def test_sarif_entire_stdout_parses_and_is_path_independent(self):
        # Measured: the sarif document embeds NO filesystem path at all
        # (logicalLocations only) — so the strongest true pin is byte
        # identity with the clean-named run, plus whole-stdout parseability.
        for kind, name, path in self._each():
            proc = run(report_cmd(path, "sarif"))
            doc = json.loads(proc.stdout.decode("utf-8"))  # ENTIRE stdout
            self.assertEqual(doc.get("version"), "2.1.0")
            base_proc, _ = self.base[(kind, "sarif")]
            self.assertEqual(proc.stdout, base_proc.stdout,
                             "sarif %s %r: output not path-independent"
                             % (kind, name))

    def test_junit_single_file_entire_stdout_parses(self):
        # Measured: single-file junit embeds no path (testcase name = rule
        # id, classname = profile) — pin parseability of the ENTIRE stdout
        # and byte identity with the clean-named run.
        for kind, name, path in self._each():
            proc = run(report_cmd(path, "junit"))
            root = ET.fromstring(proc.stdout.decode("utf-8"))
            self.assertEqual(root.tag, "testsuites")
            base_proc, _ = self.base[(kind, "junit")]
            self.assertEqual(proc.stdout, base_proc.stdout,
                             "junit %s %r: output not path-independent"
                             % (kind, name))

    def test_junit_batch_attribute_escaping_roundtrip(self):
        # The one junit surface that DOES embed the filename: batch
        # (directory) mode writes the full path into the <testsuite
        # name="..."> attribute via quoteattr. Drive it per awkward name
        # and assert the PARSED attribute value equals the original path —
        # i.e. '&', quotes, apostrophes and umlauts escape and recover
        # byte-correctly.
        for name in AWKWARD_NAMES:
            batch_dir = tempfile.mkdtemp(prefix="einvoice-fname-batch-")
            try:
                path = os.path.join(batch_dir, name)
                shutil.copyfile(FAIL_FIXTURE, path)
                proc = run(report_cmd(batch_dir, "junit"))
                raw = proc.stdout.decode("utf-8")
                root = ET.fromstring(raw)          # ENTIRE stdout
                suite_names = [s.get("name")
                               for s in root.findall("testsuite")]
                self.assertIn(path, suite_names,
                              "junit batch %r: attribute did not "
                              "round-trip (got %r)" % (name, suite_names))
                if "&" in name:
                    # The escape genuinely happened on the wire.
                    self.assertIn("&amp;", raw)
                    self.assertNotIn(" & ", raw.split("?>", 1)[1]
                                     .replace("&amp;", ""))
            finally:
                shutil.rmtree(batch_dir, ignore_errors=True)


def main():
    suite = unittest.defaultTestLoader.loadTestsFromModule(
        sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())

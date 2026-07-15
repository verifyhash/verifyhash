#!/usr/bin/env python3
"""test_report_gitlab.py — prove the GitLab Code Quality (Code Climate) format.

Fast, stdlib-only, saxonche-free, offline. Exercises the new
`python3 -m einvoice.report --format gitlab` path (report.build_gitlab) against
the committed examples/01-missing-fields fixtures — no new corpus, no new rule
logic, no network. The GitLab "Code Quality report format" is a JSON ARRAY of
issue objects; GitLab ingests it via artifacts:reports:codequality and
de-duplicates findings across pipeline runs by `fingerprint`.

Asserted (each maps to a task acceptance criterion):
  (1) --format gitlab on broken.xml -> a non-empty JSON array; every element
      has description(str), check_name(str, == a rule id), fingerprint(str),
      severity in {info,minor,major,critical,blocker}, and location.path(str).
  (2) fingerprint is deterministic: two consecutive runs on the same input are
      byte-identical (so GitLab de-dups instead of re-reporting).
  (3) source_line, when present on a violation, becomes location.lines.begin;
      when absent, location.lines is OMITTED (never emitted as 0). Exercised on
      build_gitlab directly with a synthetic record so both branches are hit.
  (4) a conformant invoice (fixed.xml) yields an EMPTY array; broken.xml yields
      >= 1 finding.
  (5) the committed examples/ci-gitlab/gl-code-quality-report.json equals a
      fresh build_gitlab run byte-for-byte (drift guard), and the ci example
      files are present.
  (6) a not-well-formed input yields exactly one parse-error object.
"""

import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.report import build_report, build_gitlab  # noqa: E402

EX = os.path.join(HERE, "examples", "01-missing-fields")
BROKEN_REL = "examples/01-missing-fields/broken.xml"
FIXED_REL = "examples/01-missing-fields/fixed.xml"
BROKEN = os.path.join(EX, "broken.xml")
FIXED = os.path.join(EX, "fixed.xml")
CI_DIR = os.path.join(HERE, "examples", "ci-gitlab")
COMMITTED = os.path.join(CI_DIR, "gl-code-quality-report.json")

SEVERITY_ENUM = {"info", "minor", "major", "critical", "blocker"}
REQUIRED_KEYS = {"description", "check_name", "fingerprint", "severity",
                 "location"}


def _run(args):
    """Run the report CLI from HERE so relative paths resolve as documented."""
    return subprocess.run(
        [sys.executable, "-m", "einvoice.report"] + args,
        cwd=HERE, capture_output=True, text=True, timeout=120)


def _assert_contract(tc, arr):
    """Every element satisfies the Code Quality contract."""
    tc.assertIsInstance(arr, list)
    for obj in arr:
        tc.assertTrue(REQUIRED_KEYS.issubset(obj), obj)
        tc.assertIsInstance(obj["description"], str)
        tc.assertTrue(obj["description"], obj)         # never empty
        tc.assertIsInstance(obj["check_name"], str)
        tc.assertIsInstance(obj["fingerprint"], str)
        tc.assertTrue(obj["fingerprint"], obj)
        tc.assertIn(obj["severity"], SEVERITY_ENUM)
        loc = obj["location"]
        tc.assertIsInstance(loc, dict)
        tc.assertIsInstance(loc.get("path"), str)
        tc.assertTrue(loc["path"], obj)
        if "lines" in loc:                             # optional, but if present
            tc.assertIn("begin", loc["lines"])
            tc.assertIsInstance(loc["lines"]["begin"], int)
            tc.assertGreater(loc["lines"]["begin"], 0)  # never 0/absent-as-0


class GitlabFormatTest(unittest.TestCase):

    def test_broken_array_shape_and_severity_enum(self):
        # Criterion 1 + 4 (broken side): non-empty, contract-conformant, and
        # every check_name is a real rule id present in the JSON report.
        report = build_report(BROKEN, profile="xrechnung")
        arr = build_gitlab(report)
        self.assertTrue(arr, "broken.xml must yield >= 1 finding")
        _assert_contract(self, arr)
        rule_ids = {v["rule"] for v in report["violations"]}
        for obj in arr:
            self.assertIn(obj["check_name"], rule_ids)

    def test_cli_broken_matches_contract(self):
        # Same, but through the actual CLI (JSON array on stdout).
        proc = _run([BROKEN_REL, "--format", "gitlab"])
        self.assertNotEqual(proc.returncode, 0, proc.stderr)  # fatal -> nonzero
        arr = json.loads(proc.stdout)
        self.assertTrue(arr)
        _assert_contract(self, arr)

    def test_fixed_is_empty_array(self):
        # Criterion 4 (valid side): a conformant invoice -> [].
        arr = build_gitlab(build_report(FIXED, profile="xrechnung"))
        self.assertEqual(arr, [])
        proc = _run([FIXED_REL, "--format", "gitlab"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout), [])

    def test_fingerprint_deterministic(self):
        # Criterion 2: two consecutive runs are byte-identical.
        a = _run([BROKEN_REL, "--format", "gitlab"]).stdout
        b = _run([BROKEN_REL, "--format", "gitlab"]).stdout
        self.assertEqual(a, b)
        # And stable in-process across two independent projections.
        f1 = [o["fingerprint"] for o in build_gitlab(build_report(BROKEN))]
        f2 = [o["fingerprint"] for o in build_gitlab(build_report(BROKEN))]
        self.assertEqual(f1, f2)

    def test_source_line_maps_to_lines_begin(self):
        # Criterion 3: source_line present -> location.lines.begin; absent ->
        # no `lines` key at all (never 0). Drive build_gitlab with a synthetic
        # report so BOTH branches are exercised deterministically.
        report = {
            "source": "inv.xml",
            "violations": [
                {"rule": "BR-01", "severity": "fatal",
                 "message": "with line", "field": "cbc:ID",
                 "source_line": 42},
                {"rule": "BR-02", "severity": "warning",
                 "message": "no line", "field": "cbc:Note"},
            ],
        }
        arr = build_gitlab(report)
        self.assertEqual(len(arr), 2)
        with_line, without_line = arr
        self.assertEqual(with_line["location"]["lines"]["begin"], 42)
        self.assertEqual(with_line["severity"], "major")
        self.assertNotIn("lines", without_line["location"])
        self.assertEqual(without_line["severity"], "minor")

    def test_not_well_formed_single_parse_error(self):
        # Criterion 6 / not-well-formed contract: one parse-error object.
        report = {"source": "bad.xml", "error": "not-well-formed",
                  "message": "no element found: line 1, column 0"}
        arr = build_gitlab(report)
        self.assertEqual(len(arr), 1)
        obj = arr[0]
        self.assertEqual(obj["check_name"], "not-well-formed")
        self.assertIn(obj["severity"], SEVERITY_ENUM)
        self.assertEqual(obj["location"]["path"], "bad.xml")
        self.assertTrue(obj["fingerprint"])

    def test_committed_example_files_present(self):
        # Criterion 5: the ci example is committed and complete.
        self.assertTrue(os.path.isfile(os.path.join(CI_DIR, ".gitlab-ci.yml")))
        self.assertTrue(os.path.isfile(COMMITTED))

    def test_committed_report_no_drift(self):
        # Criterion 5: committed artifact == fresh build_gitlab run byte-for-byte.
        # Reproduce EXACTLY how the CLI serialises it, with the same relative
        # source path that was used to generate the committed file.
        cwd = os.getcwd()
        try:
            os.chdir(HERE)
            report = build_report(BROKEN_REL, profile="xrechnung")
            fresh = json.dumps(build_gitlab(report), indent=2,
                               sort_keys=True) + "\n"
        finally:
            os.chdir(cwd)
        with open(COMMITTED, encoding="utf-8") as fh:
            committed = fh.read()
        self.assertEqual(committed, fresh,
                         "gl-code-quality-report.json drifted from build_gitlab")
        # And the raw CLI reproduction is byte-identical too.
        cli = _run([BROKEN_REL, "--format", "gitlab"]).stdout
        self.assertEqual(committed, cli)


if __name__ == "__main__":
    unittest.main(verbosity=2)

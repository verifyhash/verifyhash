#!/usr/bin/env python3
"""test_examples.py — prove the onboarding examples corpus is real and current.

Fast, stdlib-only, saxonche-free, offline. For every example directory under
einvoice/examples/ it asserts, against the REAL einvoice.report engine (the
same entry point gen_examples.py drives and an end user runs):

  1. broken.xml, fixed.xml and report.json all exist.
  2. The committed report.json equals live engine output field-for-field
     (json.loads), i.e. gen_examples.py has been run and is not stale — the
     committed report can never silently drift from what the tool emits.
  3. broken.xml is genuinely non-conformant: the engine reports at least one
     fatal (or error) finding.
  4. fixed.xml is the correction: the engine reports valid:true with
     fatal_count == 0.
  5. The report's source path is the relative example path (not an absolute /
     machine-specific path baked into the committed file).

Provenance: each broken.xml is a MINIMAL mutation of a real, valid corpus
document (corpus/vendored/valid/xr-01.01a_ubl.xml for 01-missing-fields), and
each fixed.xml restores exactly the removed element(s) — see the comment
header inside every example XML file.

Run:  python3 test_examples.py
"""

import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from gen_examples import (  # noqa: E402
    find_example_dirs, live_report_json, render, EXAMPLES_DIR,
)


def run_report(rel_path):
    """Drive `python3 -m einvoice.report <rel_path> --format json` from HERE."""
    proc = subprocess.run(
        [sys.executable, "-m", "einvoice.report", rel_path, "--format", "json"],
        cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    return proc


class ExamplesCorpusTest(unittest.TestCase):
    def test_at_least_one_example(self):
        self.assertTrue(
            find_example_dirs(),
            "expected at least one example dir with broken.xml under %s"
            % EXAMPLES_DIR)

    def test_readme_exists(self):
        self.assertTrue(
            os.path.isfile(os.path.join(EXAMPLES_DIR, "README.md")),
            "examples/README.md walkthrough is required")

    def test_each_example(self):
        for d in find_example_dirs():
            rel = os.path.relpath(d, HERE)
            with self.subTest(example=rel):
                broken = os.path.join(d, "broken.xml")
                fixed = os.path.join(d, "fixed.xml")
                report_path = os.path.join(d, "report.json")

                # (1) all three files present.
                self.assertTrue(os.path.isfile(broken), "%s/broken.xml" % rel)
                self.assertTrue(os.path.isfile(fixed), "%s/fixed.xml" % rel)
                self.assertTrue(os.path.isfile(report_path),
                                "%s/report.json (run gen_examples.py)" % rel)

                # (2) committed report.json == live engine output (no drift).
                live = live_report_json(broken)
                with open(report_path, encoding="utf-8") as fh:
                    committed_text = fh.read()
                committed = json.loads(committed_text)
                self.assertEqual(
                    committed, live,
                    "%s/report.json is STALE vs live engine output — run "
                    "`python3 gen_examples.py`" % rel)
                # And the committed serialization is exactly what the generator
                # writes (byte-for-byte), so a hand-edit is caught too.
                self.assertEqual(
                    committed_text, render(live),
                    "%s/report.json serialization differs from gen_examples "
                    "output — run `python3 gen_examples.py`" % rel)

                # (2b) the report describes the broken invoice, and its source
                # is the relative path (never absolute).
                self.assertEqual(committed["source"],
                                 os.path.relpath(broken, HERE))
                self.assertFalse(os.path.isabs(committed["source"]))

                # (3) broken.xml is genuinely non-conformant: >=1 fatal/error.
                fatal_like = [v for v in live.get("violations", [])
                              if v.get("severity") in ("fatal", "error")]
                self.assertGreaterEqual(
                    len(fatal_like), 1,
                    "%s/broken.xml fired no fatal/error finding — it is not "
                    "actually non-conformant" % rel)
                self.assertFalse(live["valid"], "%s/broken.xml" % rel)
                self.assertGreaterEqual(live["fatal_count"], 1)

                # broken CLI exits non-zero (fatal contract).
                self.assertEqual(run_report(
                    os.path.relpath(broken, HERE)).returncode, 1)

                # (4) fixed.xml passes: valid:true, fatal_count == 0, exit 0.
                fixed_proc = run_report(os.path.relpath(fixed, HERE))
                self.assertEqual(
                    fixed_proc.returncode, 0,
                    "%s/fixed.xml did not pass:\n%s" % (
                        rel, fixed_proc.stdout.decode("utf-8")))
                fixed_report = json.loads(fixed_proc.stdout.decode("utf-8"))
                self.assertTrue(fixed_report["valid"],
                                "%s/fixed.xml valid:false" % rel)
                self.assertEqual(fixed_report["fatal_count"], 0,
                                 "%s/fixed.xml has fatal findings" % rel)


if __name__ == "__main__":
    unittest.main()

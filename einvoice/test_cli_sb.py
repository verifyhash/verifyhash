#!/usr/bin/env python3
"""test_cli_sb.py — prove ``einvoice validate`` surfaces the distinct
syntax-binding category WITHOUT changing the validity / exit-code contract.

Fast, stdlib-only, offline. Drives the real CLI as a subprocess (the same
``einvoice.py`` wrapper the other CLI tests use) against a committed UBL fixture
that carries a forbidden ``ext:UBLExtensions`` element — that fires the
implemented ``UBL-CR-001`` absence-restriction syntax-binding assert (a
*warning*), while the document is otherwise business-rule-clean.

Asserted (each maps to a task acceptance criterion):
  1. ``validate --json`` output carries a NON-EMPTY ``syntax_bindings`` array
     plus ``syntax_binding_fatal_count`` / ``syntax_binding_warning_count``,
     mirroring the report.py field names, with the expected per-finding shape.
  2. The syntax-binding findings are WARNINGS: they never flip ``valid`` nor the
     process exit code vs. the SAME document evaluated with the business rules
     ONLY (the "without the sb layer" baseline = ``validate_file``). This is the
     hard exit-code invariant.
"""

import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.validate import validate_file  # noqa: E402

WRAPPER = os.path.join(HERE, "einvoice.py")

# A vendored UBL invoice with a forbidden <ext:UBLExtensions> child of the
# document root -> fires the implemented UBL-CR-001 syntax-binding assert
# (flag=warning). It is otherwise BR-clean: zero fatal business-rule violations,
# so the "with sb" and "without sb" exit codes must be identical (both 0).
SB_FIXTURE = os.path.join(HERE, "corpus", "vendored", "syntax-binding",
                          "sb-viol-UBL-CR-001_ubl.xml")

SB_FINDING_KEYS = {"id", "category", "severity", "flag", "message", "element"}


def run_validate(*extra):
    """Run ``einvoice.py validate [extra] <fixture>`` and capture the result."""
    return subprocess.run(
        [sys.executable, WRAPPER, "validate", *extra, SB_FIXTURE],
        capture_output=True, text=True)


class FixtureAnchor(unittest.TestCase):
    def test_fixture_exists_and_is_the_ubl_binding(self):
        self.assertTrue(os.path.isfile(SB_FIXTURE), SB_FIXTURE)
        # Guard against corpus drift silently disarming the test: the forbidden
        # element that fires UBL-CR-001 must actually be present.
        with open(SB_FIXTURE, encoding="utf-8") as fh:
            raw = fh.read()
        self.assertIn("UBLExtensions", raw,
                      "fixture drift: sb fixture lost its <ext:UBLExtensions>")


class SyntaxBindingSurfaced(unittest.TestCase):
    def test_json_carries_nonempty_syntax_bindings_and_counts(self):
        proc = run_validate("--json")
        doc = json.loads(proc.stdout)

        # The three additive keys are present and named exactly as report.py.
        self.assertIn("syntax_bindings", doc, doc)
        self.assertIn("syntax_binding_fatal_count", doc, doc)
        self.assertIn("syntax_binding_warning_count", doc, doc)

        sb = doc["syntax_bindings"]
        self.assertIsInstance(sb, list)
        self.assertTrue(sb, "expected a NON-empty syntax_bindings array")

        # Every finding has exactly the report.py finding shape.
        for finding in sb:
            self.assertEqual(set(finding.keys()), SB_FINDING_KEYS, finding)
            self.assertEqual(finding["category"], "syntax-binding", finding)
        ids = {f["id"] for f in sb}
        self.assertIn("UBL-CR-001", ids, ids)

        # Counts are consistent with the array (mirror report.py's accounting).
        fatal = sum(1 for f in sb if f["severity"] == "fatal")
        warning = sum(1 for f in sb if f["severity"] == "warning")
        self.assertEqual(doc["syntax_binding_fatal_count"], fatal, doc)
        self.assertEqual(doc["syntax_binding_warning_count"], warning, doc)
        self.assertGreaterEqual(doc["syntax_binding_warning_count"], 1, doc)

    def test_human_summary_prints_the_count_line(self):
        proc = run_validate()
        self.assertIn("Syntax-binding warnings:", proc.stdout, proc.stdout)


class ExitContractUnchanged(unittest.TestCase):
    """The load-bearing invariant: surfacing the sb layer must NOT change
    ``valid`` or the exit code relative to the SAME document without it."""

    def _br_only_exit(self):
        # "Without the sb layer" baseline: validate_file runs ONLY the business
        # rules — no syntax-binding evaluator whatsoever. Its ok-ness is the sole
        # driver of the documented exit contract (0 = ok, 1 = fatal).
        return 0 if validate_file(SB_FIXTURE).ok else 1

    def test_exit_code_is_unchanged_by_the_sb_layer(self):
        expected = self._br_only_exit()
        proc = run_validate("--json")
        self.assertEqual(proc.returncode, expected,
                         "sb layer changed the exit code: %r\n%s"
                         % (proc.returncode, proc.stdout + proc.stderr))
        doc = json.loads(proc.stdout)
        # sb findings ARE present and non-empty ...
        self.assertTrue(doc["syntax_bindings"], doc)
        # ... yet `valid` still tracks the BR-only outcome exactly, unflipped.
        self.assertEqual(doc["valid"], validate_file(SB_FIXTURE).ok, doc)

    def test_human_exit_code_matches_json_exit_code(self):
        self.assertEqual(run_validate().returncode,
                         run_validate("--json").returncode)


if __name__ == "__main__":
    unittest.main()

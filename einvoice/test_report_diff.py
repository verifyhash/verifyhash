#!/usr/bin/env python3
"""test_report_diff.py — prove the T-VH.22 `--baseline` diff mode.

Fast, stdlib-only, saxonche-free, offline. Exercises the baseline diff both as
an importable library (load_baseline / build_diff) and as a CLI entry point
(python3 -m einvoice.report --baseline ...), against the SAME local corpus
fixture the other fast gates use — no new corpus.

The diff mode is an adoption on-ramp: it fails the build (exit 1) ONLY on a
NEW fatal violation vs a captured baseline; pre-existing fatals are tolerated
(exit 0). It reuses einvoice.validate verbatim and adds no rule logic.

Asserted (each maps to a task acceptance case):
  (a) baseline == current  -> new_violations empty, exit 0.
  (b) an invoice that introduces a NEW fatal vs a hand-written baseline
      -> new_violations non-empty, exit 1.
  (c) baseline carried a fatal that is now absent
      -> resolved_violations non-empty, and (no new fatals) exit 0.
  (d) a malformed baseline path -> nonzero exit, NO traceback on stderr.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.report import (  # noqa: E402
    build_report, build_diff, load_baseline, BaselineError,
    REPORT_DIFF_SCHEMA_ID,
)

BASE = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test",
                    "business-cases", "standard", "01.01a-INVOICE_ubl.xml")


def make_bad_invoice(dest):
    """Copy BASE with its BuyerReference removed -> violates BR-DE-15 (fatal)."""
    with open(BASE, encoding="utf-8") as fh:
        src = fh.read()
    bad = re.sub(r"<cbc:BuyerReference>[^<]*</cbc:BuyerReference>", "", src,
                 count=1)
    assert bad != src, "fixture drift: BASE lost its BuyerReference"
    with open(dest, "w", encoding="utf-8") as fh:
        fh.write(bad)


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)


def empty_baseline(source="baseline.xml"):
    """A well-formed prior report with zero violations."""
    return {
        "report_version": 1,
        "schema": "einvoice-conformance-report/v1",
        "source": source,
        "profile": "xrechnung",
        "valid": True,
        "fatal_count": 0,
        "warning_count": 0,
        "violation_count": 0,
        "violations": [],
    }


def baseline_with(records, source="baseline.xml"):
    fatal = sum(1 for r in records if r.get("severity") == "fatal")
    return {
        "report_version": 1,
        "schema": "einvoice-conformance-report/v1",
        "source": source,
        "profile": "xrechnung",
        "valid": fatal == 0,
        "fatal_count": fatal,
        "warning_count": 0,
        "violation_count": len(records),
        "violations": records,
    }


def run_cli(*cli_args):
    return subprocess.run(
        [sys.executable, "-m", "einvoice.report", *cli_args],
        cwd=HERE, capture_output=True, text=True, timeout=120)


class DiffLibrary(unittest.TestCase):
    def test_identical_baseline_no_new(self):
        # (a) baseline captured from the SAME good invoice -> no new/resolved.
        baseline = build_report(BASE, profile="xrechnung")
        diff = build_diff(BASE, baseline, profile="xrechnung")
        self.assertEqual(diff["schema"], REPORT_DIFF_SCHEMA_ID)
        self.assertEqual(diff["mode"], "diff")
        self.assertEqual(diff["new_violations"], [], diff)
        self.assertEqual(diff["resolved_violations"], [], diff)
        self.assertEqual(diff["new_fatal_count"], 0, diff)

    def test_new_fatal_vs_empty_baseline(self):
        # (b) empty baseline, bad current invoice -> a NEW fatal appears.
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            diff = build_diff(bad, empty_baseline(), profile="xrechnung")
        self.assertTrue(diff["new_violations"], diff)
        self.assertGreaterEqual(diff["new_fatal_count"], 1, diff)
        rules = [v["rule"] for v in diff["new_violations"]]
        self.assertIn("BR-DE-15", rules, rules)

    def test_resolved_when_baseline_fatal_now_absent(self):
        # (c) baseline carries a fatal that the good invoice does not raise.
        phantom = {
            "rule": "BR-DE-15",
            "field": "/Invoice/cbc:BuyerReference",
            "message": "A Buyer reference (BT-10) must be present.",
            "severity": "fatal",
        }
        diff = build_diff(BASE, baseline_with([phantom]), profile="xrechnung")
        # Case (c) tolerance: what matters is NO new fatal (so exit stays 0),
        # while the baseline-only fatal shows up as resolved. (The good invoice
        # may carry non-fatal informational notes; those never fail the build.)
        self.assertEqual(diff["new_fatal_count"], 0, diff)
        self.assertTrue(diff["resolved_violations"], diff)
        self.assertEqual(diff["resolved_violations"][0]["rule"], "BR-DE-15")
        self.assertFalse(
            any(v["severity"] == "fatal" for v in diff["new_violations"]), diff)

    def test_load_baseline_rejects_malformed(self):
        # (d) library-level: malformed baselines raise BaselineError, not raw.
        with tempfile.TemporaryDirectory() as tmp:
            missing = os.path.join(tmp, "nope.json")
            with self.assertRaises(BaselineError):
                load_baseline(missing)

            not_json = os.path.join(tmp, "bad.json")
            with open(not_json, "w", encoding="utf-8") as fh:
                fh.write("{not json at all")
            with self.assertRaises(BaselineError):
                load_baseline(not_json)

            no_violations = os.path.join(tmp, "shape.json")
            write_json(no_violations, {"schema": "x", "report_version": 1})
            with self.assertRaises(BaselineError):
                load_baseline(no_violations)


class DiffCli(unittest.TestCase):
    def test_a_identical_exits_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = os.path.join(tmp, "base.json")
            write_json(base, build_report(BASE, profile="xrechnung"))
            proc = run_cli("--baseline", base, BASE)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["schema"], REPORT_DIFF_SCHEMA_ID)
        self.assertEqual(payload["new_violations"], [], payload)
        self.assertIn("resolved_violations", payload)
        self.assertIn("new_fatal_count", payload)

    def test_b_new_fatal_exits_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = os.path.join(tmp, "base.json")
            write_json(base, empty_baseline())
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            proc = run_cli("--baseline", base, bad)
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertGreaterEqual(payload["new_fatal_count"], 1, payload)
        self.assertIn("BR-DE-15", proc.stdout)

    def test_c_resolved_exits_zero(self):
        phantom = {
            "rule": "BR-DE-15",
            "field": "/Invoice/cbc:BuyerReference",
            "message": "A Buyer reference (BT-10) must be present.",
            "severity": "fatal",
        }
        with tempfile.TemporaryDirectory() as tmp:
            base = os.path.join(tmp, "base.json")
            write_json(base, baseline_with([phantom]))
            proc = run_cli("--baseline", base, BASE)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertTrue(payload["resolved_violations"], payload)
        self.assertEqual(payload["new_fatal_count"], 0, payload)

    def test_d_malformed_baseline_nonzero_no_traceback(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = os.path.join(tmp, "bad.json")
            with open(base, "w", encoding="utf-8") as fh:
                fh.write("this is not json {")
            proc = run_cli("--baseline", base, BASE)
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertNotIn("Traceback", proc.stderr, proc.stderr)
        self.assertIn("error:", proc.stderr)

    def test_not_well_formed_current_exits_parse(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = os.path.join(tmp, "base.json")
            write_json(base, empty_baseline())
            broken = os.path.join(tmp, "broken.xml")
            with open(broken, "w", encoding="utf-8") as fh:
                fh.write("<Invoice><unclosed>")
            proc = run_cli("--baseline", base, broken)
        self.assertEqual(proc.returncode, 3, proc.stdout + proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["error"], "not-well-formed")


if __name__ == "__main__":
    unittest.main()

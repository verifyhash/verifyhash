#!/usr/bin/env python3
"""test_report_badge.py — prove the T-VHI.3 shields.io endpoint-badge projection.

Fast, stdlib-only, saxonche-free, offline. Exercises the new
`python3 -m einvoice.report --format badge` path against the SAME local corpus
fixture the packaging/xrechnung/junit/sarif tests already use — no new corpus,
no new rule logic, no network.

The badge is a PURE projection of the same build_report() findings into the
shields.io ENDPOINT-badge schema (https://shields.io/badges/endpoint-badge):
``schemaVersion`` (integer 1) + ``label`` + ``message`` + ``color``.

Asserted (each maps to a task acceptance criterion):
  (a) --format badge on a KNOWN-GOOD invoice -> valid endpoint JSON
      (schemaVersion == 1, label/message/color present), message "conformant",
      a green color, exit 0.
  (b) --format badge on a KNOWN-BAD invoice -> color "red" and a message that
      contains the (fatal) finding count, process exits non-zero.
  (c) build_badge() and the CLI agree, and both round-trip through json.loads.
  (d) --baseline + --format badge is rejected; an unknown format lists badge.
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

from einvoice.report import build_badge, build_report  # noqa: E402

# Reuse the exact fixture + bad-invoice construction the other fast gates use.
BASE = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test",
                    "business-cases", "standard", "01.01a-INVOICE_ubl.xml")

# The four required endpoint keys, and the shields.io "green family" colors.
ENDPOINT_KEYS = {"schemaVersion", "label", "message", "color"}
GREEN_FAMILY = {"green", "brightgreen", "success", "yellowgreen"}


def make_bad_invoice(dest):
    """Copy BASE with its BuyerReference removed -> violates BR-DE-15 (fatal)."""
    with open(BASE, encoding="utf-8") as fh:
        src = fh.read()
    bad = re.sub(r"<cbc:BuyerReference>[^<]*</cbc:BuyerReference>", "", src,
                 count=1)
    assert bad != src, "fixture drift: BASE lost its BuyerReference"
    with open(dest, "w", encoding="utf-8") as fh:
        fh.write(bad)


def _run(args):
    return subprocess.run(
        [sys.executable, "-m", "einvoice.report"] + args,
        cwd=HERE, capture_output=True, text=True, timeout=120)


def _assert_valid_endpoint(tc, doc):
    """A minimal shields.io endpoint schema check."""
    tc.assertTrue(ENDPOINT_KEYS <= set(doc), doc)
    tc.assertEqual(doc["schemaVersion"], 1, doc)
    # schemaVersion must be the integer 1, not "1" or 1.0.
    tc.assertIsInstance(doc["schemaVersion"], int, doc)
    tc.assertNotIsInstance(doc["schemaVersion"], bool, doc)
    tc.assertIsInstance(doc["label"], str, doc)
    tc.assertIsInstance(doc["message"], str, doc)
    tc.assertIsInstance(doc["color"], str, doc)


class BadgeGoodInvoice(unittest.TestCase):
    def test_good_invoice_conformant_green_exit_zero(self):
        proc = _run(["--profile", "xrechnung", "--format", "badge", BASE])
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        # CLI output round-trips through json.loads.
        doc = json.loads(proc.stdout)
        _assert_valid_endpoint(self, doc)
        self.assertEqual(doc["message"], "conformant", proc.stdout)
        self.assertIn(doc["color"], GREEN_FAMILY, proc.stdout)
        self.assertEqual(doc["label"], "EN 16931", proc.stdout)

        # The CLI projection equals the direct build_badge() projection.
        report = build_report(BASE, profile="xrechnung")
        self.assertEqual(doc, build_badge(report), proc.stdout)


class BadgeBadInvoice(unittest.TestCase):
    def test_bad_invoice_red_with_count_exit_nonzero(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            proc = _run(["--profile", "xrechnung", "--format", "badge", bad])
            report = build_report(bad, profile="xrechnung")

        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        doc = json.loads(proc.stdout)
        _assert_valid_endpoint(self, doc)
        self.assertEqual(doc["color"], "red", proc.stdout)
        # Message contains a digit (the fatal finding count).
        self.assertTrue(any(ch.isdigit() for ch in doc["message"]), doc)
        # And that digit is exactly the report's fatal count.
        self.assertIn(str(report["fatal_count"]), doc["message"], doc)
        self.assertGreaterEqual(report["fatal_count"], 1, report)

        # CLI projection equals the direct build_badge() projection.
        self.assertEqual(doc, build_badge(report), proc.stdout)


class BadgeWarningState(unittest.TestCase):
    def test_zero_fatal_with_warnings_is_yellow(self):
        # Pure projection unit-check: a synthetic warning-only report -> yellow,
        # still "conformant" (it clears the fatal gate) but honestly flagged.
        report = {"error": None, "fatal_count": 0, "warning_count": 2,
                  "violation_count": 2, "violations": []}
        doc = build_badge(report)
        _assert_valid_endpoint(self, doc)
        self.assertEqual(doc["color"], "yellow", doc)
        self.assertIn("2", doc["message"], doc)
        self.assertIn("conformant", doc["message"], doc)


class BadgeMalformed(unittest.TestCase):
    def test_malformed_input_red_exit_3(self):
        with tempfile.TemporaryDirectory() as tmp:
            broken = os.path.join(tmp, "broken.xml")
            with open(broken, "w", encoding="utf-8") as fh:
                fh.write("<Invoice><unclosed>")
            proc = _run(["--profile", "xrechnung", "--format", "badge", broken])
        self.assertEqual(proc.returncode, 3, proc.stdout + proc.stderr)
        doc = json.loads(proc.stdout)
        _assert_valid_endpoint(self, doc)
        self.assertEqual(doc["color"], "red", proc.stdout)


class BadgeBaselineRejected(unittest.TestCase):
    def test_baseline_plus_badge_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            baseline = os.path.join(tmp, "baseline.json")
            with open(baseline, "w", encoding="utf-8") as fh:
                json.dump({"schema": "einvoice-conformance-report/v1",
                           "violations": []}, fh)
            proc = _run(["--profile", "xrechnung", "--format", "badge",
                         "--baseline", baseline, BASE])
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("baseline", proc.stderr.lower(), proc.stderr)
        self.assertIn("badge", proc.stderr.lower(), proc.stderr)


class UnknownFormatMentionsBadge(unittest.TestCase):
    def test_usage_lists_badge(self):
        proc = _run(["--format", "bogus", BASE])
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("badge", proc.stderr.lower(), proc.stderr)


if __name__ == "__main__":
    unittest.main()

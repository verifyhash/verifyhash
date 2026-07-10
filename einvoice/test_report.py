#!/usr/bin/env python3
"""test_report.py — prove the T-VH.15 machine-readable conformance report.

Fast, stdlib-only, saxonche-free, offline. Exercises einvoice.report both as
an importable library (build_report) and as a CLI entry point
(python3 -m einvoice.report), against the SAME local corpus fixture the
packaging/xrechnung tests already use — no new corpus.

Asserted (each maps to a task acceptance criterion):
  1. build_report on a KNOWN-GOOD invoice -> valid=True, fatal_count==0.
  2. build_report on a KNOWN-BAD invoice (BR-DE-15 buyer-reference removed)
     -> valid=False, the offending rule id present in violations.
  3. report carries report_version + schema; every violation record has
     EXACTLY the keys {rule, severity, message, field}.
  4. the entry point exits 0 on the good invoice and non-zero on the bad one,
     and the printed JSON lists the offending BR-* rule id.
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

from einvoice.report import build_report, VIOLATION_KEYS  # noqa: E402

# Reuse the exact fixture + bad-invoice construction the other fast gates use.
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


class BuildReportGood(unittest.TestCase):
    def test_good_invoice_is_valid_no_fatals(self):
        report = build_report(BASE, profile="xrechnung")
        self.assertTrue(report["valid"], report)
        self.assertEqual(report["fatal_count"], 0, report)
        self.assertEqual(report["source"], BASE)
        self.assertEqual(report["profile"], "xrechnung")

    def test_report_carries_version_and_schema(self):
        report = build_report(BASE, profile="xrechnung")
        self.assertIn("report_version", report)
        self.assertIn("schema", report)
        self.assertIsInstance(report["report_version"], int)
        self.assertEqual(report["report_version"], 1)
        self.assertEqual(report["schema"], "einvoice-conformance-report/v1")


class BuildReportBad(unittest.TestCase):
    def test_bad_invoice_is_invalid_and_names_rule(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            report = build_report(bad, profile="xrechnung")
        self.assertFalse(report["valid"], report)
        self.assertGreaterEqual(report["fatal_count"], 1, report)
        rules = [v["rule"] for v in report["violations"]]
        self.assertIn("BR-DE-15", rules, rules)


class ViolationRecordShape(unittest.TestCase):
    def test_every_record_has_exactly_the_violation_keys(self):
        # Use the bad invoice so we have at least one violation to inspect.
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            report = build_report(bad, profile="xrechnung")
        self.assertTrue(report["violations"], "expected at least one violation")
        for rec in report["violations"]:
            self.assertEqual(set(rec.keys()), set(VIOLATION_KEYS), rec)
            # Original identity keys stay present, first, and unchanged.
            self.assertEqual(
                set(rec.keys()),
                {"rule", "severity", "message", "field",
                 "title", "fix_hint", "terms", "location"}, rec)
        # VIOLATION_KEYS keeps the four identity keys first for back-compat.
        self.assertEqual(VIOLATION_KEYS[:4],
                         ("rule", "severity", "message", "field"))


class ViolationRecordRemediation(unittest.TestCase):
    """A fired violation must carry catalog-traceable remediation fields."""

    def test_fired_violation_carries_catalog_remediation(self):
        from einvoice.remediation import load_catalog
        catalog = load_catalog()
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            report = build_report(bad, profile="xrechnung")
        self.assertTrue(report["violations"], "expected at least one violation")
        rec = next(r for r in report["violations"] if r["rule"] == "BR-DE-15")
        # title + fix_hint are non-empty and match the catalog entry exactly
        # (report.py only relays catalog data — it invents nothing).
        entry = catalog["BR-DE-15"]
        self.assertTrue(rec["title"], rec)
        self.assertTrue(rec["fix_hint"], rec)
        self.assertEqual(rec["title"], entry["title"])
        self.assertEqual(rec["fix_hint"], entry["fix"])
        # terms + location keys are present and sourced from the catalog.
        self.assertIn("terms", rec)
        self.assertIn("location", rec)
        self.assertEqual(rec["terms"], list(entry.get("bt_bg") or []))
        self.assertEqual(rec["location"], entry.get("location_hint"))
        # Every fired violation carries all four remediation keys, and each
        # non-empty title/fix_hint is traceable to the catalog (no invented
        # strings in report.py).
        for r in report["violations"]:
            for key in ("title", "fix_hint", "terms", "location"):
                self.assertIn(key, r, r)
            e = catalog.get(r["rule"])
            if e is not None:
                self.assertEqual(r["title"], e["title"], r)
                self.assertEqual(r["fix_hint"], e["fix"], r)


class EntryPointExitCodes(unittest.TestCase):
    def _run(self, path):
        return subprocess.run(
            [sys.executable, "-m", "einvoice.report", "--profile", "xrechnung",
             path],
            cwd=HERE, capture_output=True, text=True, timeout=120)

    def test_good_invoice_exits_zero_with_version_and_schema(self):
        proc = self._run(BASE)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertIn("report_version", payload)
        self.assertIn("schema", payload)
        self.assertTrue(payload["valid"])

    def test_bad_invoice_exits_nonzero_and_lists_rule(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            proc = self._run(bad)
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("BR-DE-15", proc.stdout)
        payload = json.loads(proc.stdout)
        self.assertFalse(payload["valid"])

    def test_not_well_formed_exits_parse_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            broken = os.path.join(tmp, "broken.xml")
            with open(broken, "w", encoding="utf-8") as fh:
                fh.write("<Invoice><unclosed>")
            proc = self._run(broken)
        self.assertEqual(proc.returncode, 3, proc.stdout + proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertFalse(payload["valid"])
        self.assertEqual(payload["error"], "not-well-formed")


if __name__ == "__main__":
    unittest.main()

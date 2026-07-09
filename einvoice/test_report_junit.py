#!/usr/bin/env python3
"""test_report_junit.py — prove the T-VH.18 JUnit projection of the report.

Fast, stdlib-only, saxonche-free, offline. Exercises the new
`python3 -m einvoice.report --format junit` path against the SAME local
corpus fixture the packaging/xrechnung/report tests already use — no new
corpus, no new rule logic.

Asserted (each maps to a task acceptance criterion):
  (a) --format junit on a KNOWN-BAD invoice -> well-formed XML (parses with
      xml.dom.minidom), at least one <failure> whose testcase name is a real
      BR-* id also present in the JSON report's failures, testsuite failures
      count == number of fatal violations, process exits non-zero.
  (b) --format junit on a KNOWN-GOOD invoice -> well-formed XML, zero
      <failure> elements, exit 0.
  (c) default (no --format) still emits JSON byte-identical to the plain JSON
      run, exit codes unchanged.
  (d) a malformed-XML input yields an <error> element and exit 3.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from xml.dom import minidom

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.report import build_report  # noqa: E402

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


def _run(args):
    return subprocess.run(
        [sys.executable, "-m", "einvoice.report"] + args,
        cwd=HERE, capture_output=True, text=True, timeout=120)


def _suite_attr(dom, name):
    suite = dom.getElementsByTagName("testsuite")[0]
    return int(suite.getAttribute(name))


class JUnitBadInvoice(unittest.TestCase):
    def test_bad_invoice_junit_has_failures_and_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            proc = _run(["--profile", "xrechnung", "--format", "junit", bad])
            report = build_report(bad, profile="xrechnung")

        self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)

        # Well-formed XML.
        dom = minidom.parseString(proc.stdout)

        # At least one <failure>.
        failures = dom.getElementsByTagName("failure")
        self.assertGreaterEqual(len(failures), 1, proc.stdout)

        # Each failing testcase name is a real BR-*/S-* rule id from the JSON
        # report's FATAL violations.
        fatal_rules = {v["rule"] for v in report["violations"]
                       if v["severity"] == "fatal"}
        for f in failures:
            tc = f.parentNode
            self.assertEqual(tc.tagName, "testcase")
            self.assertIn(tc.getAttribute("name"), fatal_rules, proc.stdout)

        # BR-DE-15 specifically shows up as a failing testcase.
        failing_names = {f.parentNode.getAttribute("name") for f in failures}
        self.assertIn("BR-DE-15", failing_names, proc.stdout)

        # testsuite failures == number of fatal violations.
        self.assertEqual(_suite_attr(dom, "failures"), report["fatal_count"],
                         proc.stdout)


class JUnitGoodInvoice(unittest.TestCase):
    def test_good_invoice_junit_zero_failures_exit_zero(self):
        proc = _run(["--profile", "xrechnung", "--format", "junit", BASE])
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        dom = minidom.parseString(proc.stdout)
        self.assertEqual(len(dom.getElementsByTagName("failure")), 0,
                         proc.stdout)
        self.assertEqual(len(dom.getElementsByTagName("error")), 0, proc.stdout)
        self.assertEqual(_suite_attr(dom, "failures"), 0, proc.stdout)


class DefaultStillJSON(unittest.TestCase):
    def test_default_is_byte_identical_json(self):
        # No --format must be byte-identical to an explicit --format json run,
        # and to what it produced before (compact JSON, exit code preserved).
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            default = _run(["--profile", "xrechnung", bad])
            explicit = _run(["--profile", "xrechnung", "--format", "json", bad])

        self.assertEqual(default.returncode, 1, default.stderr)
        self.assertEqual(default.stdout, explicit.stdout)
        # And it is valid JSON with the stable schema id.
        payload = json.loads(default.stdout)
        self.assertEqual(payload["schema"], "einvoice-conformance-report/v1")
        self.assertFalse(payload["valid"])

    def test_default_good_invoice_json_exit_zero(self):
        proc = _run(["--profile", "xrechnung", BASE])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertTrue(payload["valid"])


class JUnitMalformed(unittest.TestCase):
    def test_malformed_input_yields_error_element_exit_3(self):
        with tempfile.TemporaryDirectory() as tmp:
            broken = os.path.join(tmp, "broken.xml")
            with open(broken, "w", encoding="utf-8") as fh:
                fh.write("<Invoice><unclosed>")
            proc = _run(["--profile", "xrechnung", "--format", "junit", broken])
        self.assertEqual(proc.returncode, 3, proc.stdout + proc.stderr)
        dom = minidom.parseString(proc.stdout)
        errors = dom.getElementsByTagName("error")
        self.assertEqual(len(errors), 1, proc.stdout)
        self.assertEqual(len(dom.getElementsByTagName("failure")), 0,
                         proc.stdout)
        self.assertEqual(_suite_attr(dom, "errors"), 1, proc.stdout)


if __name__ == "__main__":
    unittest.main()

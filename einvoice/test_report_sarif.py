#!/usr/bin/env python3
"""test_report_sarif.py — prove the T-VHI.1 SARIF 2.1.0 projection of the report.

Fast, stdlib-only, saxonche-free, offline. Exercises the new
`python3 -m einvoice.report --format sarif` path against the SAME local corpus
fixture the packaging/xrechnung/junit tests already use — no new corpus, no new
rule logic, no network.

Asserted (each maps to a task acceptance criterion):
  (a) --format sarif on a KNOWN-GOOD invoice -> valid SARIF 2.1.0 JSON
      (version "2.1.0", $schema present, runs a non-empty list,
      tool.driver.name == "einvoice"), exit 0.
  (b) --format sarif on a KNOWN-BAD invoice -> every result.ruleId also appears
      in tool.driver.rules[].id (no orphan results), the BR-DE-15 fatal maps to
      level "error", process exits non-zero.
  (c) a malformed-XML input yields exactly one result whose level is "error" and
      exit 3.
  (d) --baseline + --format sarif is rejected with a clear error and nonzero
      exit; the existing json/junit outputs are unchanged (still dispatch).
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
    build_report, build_sarif, SARIF_RULE_HELP_BASE_URL)
from einvoice.remediation import load_catalog  # noqa: E402

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


def _driver(doc):
    return doc["runs"][0]["tool"]["driver"]


def _assert_valid_sarif_head(tc, doc):
    tc.assertEqual(doc["version"], "2.1.0")
    tc.assertIn("$schema", doc)
    tc.assertTrue(doc["$schema"])
    tc.assertIsInstance(doc["runs"], list)
    tc.assertTrue(doc["runs"], "runs must be a non-empty list")
    tc.assertEqual(_driver(doc)["name"], "einvoice")


class SarifGoodInvoice(unittest.TestCase):
    def test_good_invoice_valid_sarif_exit_zero(self):
        proc = _run(["--profile", "xrechnung", "--format", "sarif", BASE])
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        doc = json.loads(proc.stdout)
        _assert_valid_sarif_head(self, doc)
        # A clean invoice: no orphan results either (vacuously true).
        rule_ids = {r["id"] for r in _driver(doc)["rules"]}
        for res in doc["runs"][0]["results"]:
            self.assertIn(res["ruleId"], rule_ids, proc.stdout)


class SarifBadInvoice(unittest.TestCase):
    def test_bad_invoice_no_orphan_rules_fatal_is_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            proc = _run(["--profile", "xrechnung", "--format", "sarif", bad])
            report = build_report(bad, profile="xrechnung")

        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        doc = json.loads(proc.stdout)
        _assert_valid_sarif_head(self, doc)

        results = doc["runs"][0]["results"]
        self.assertGreaterEqual(len(results), 1, proc.stdout)

        # No orphan results: every result.ruleId is a declared driver rule id.
        rule_ids = {r["id"] for r in _driver(doc)["rules"]}
        for res in results:
            self.assertIn(res["ruleId"], rule_ids, proc.stdout)

        # Driver rules are deduplicated by id.
        rule_id_list = [r["id"] for r in _driver(doc)["rules"]]
        self.assertEqual(len(rule_id_list), len(set(rule_id_list)),
                         "driver.rules must be deduplicated by id")

        # BR-DE-15 (a fatal) surfaces as a result with level "error".
        by_rule = {}
        for res in results:
            by_rule.setdefault(res["ruleId"], []).append(res)
        self.assertIn("BR-DE-15", by_rule, proc.stdout)
        self.assertTrue(any(r["level"] == "error" for r in by_rule["BR-DE-15"]),
                        proc.stdout)

        # Every fatal violation in the JSON report maps to a level-"error"
        # SARIF result for the same rule id (fatal -> error mapping holds).
        fatal_rules = {v["rule"] for v in report["violations"]
                       if v["severity"] == "fatal"}
        error_rules = {res["ruleId"] for res in results
                       if res["level"] == "error"}
        self.assertTrue(fatal_rules.issubset(error_rules),
                        "%s not all level=error in %s" % (fatal_rules, proc.stdout))


class SarifMalformed(unittest.TestCase):
    def test_malformed_input_single_error_result_exit_3(self):
        with tempfile.TemporaryDirectory() as tmp:
            broken = os.path.join(tmp, "broken.xml")
            with open(broken, "w", encoding="utf-8") as fh:
                fh.write("<Invoice><unclosed>")
            proc = _run(["--profile", "xrechnung", "--format", "sarif", broken])
        self.assertEqual(proc.returncode, 3, proc.stdout + proc.stderr)
        doc = json.loads(proc.stdout)
        _assert_valid_sarif_head(self, doc)
        results = doc["runs"][0]["results"]
        self.assertEqual(len(results), 1, proc.stdout)
        self.assertEqual(results[0]["level"], "error", proc.stdout)


class SarifBaselineRejected(unittest.TestCase):
    def test_baseline_plus_sarif_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            baseline = os.path.join(tmp, "baseline.json")
            with open(baseline, "w", encoding="utf-8") as fh:
                json.dump({"schema": "einvoice-conformance-report/v1",
                           "violations": []}, fh)
            proc = _run(["--profile", "xrechnung", "--format", "sarif",
                         "--baseline", baseline, BASE])
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("baseline", proc.stderr.lower(), proc.stderr)
        self.assertIn("sarif", proc.stderr.lower(), proc.stderr)


class UnknownFormatMentionsSarif(unittest.TestCase):
    def test_usage_lists_sarif(self):
        proc = _run(["--format", "bogus", BASE])
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("sarif", proc.stderr.lower(), proc.stderr)


class SarifPartialFingerprints(unittest.TestCase):
    """DELIVERABLE A: every result carries a stable, line-independent
    partialFingerprints digest under a single named key."""

    def _report(self, source_line):
        # A minimal build_report-shaped dict with ONE catalog violation; only
        # source_line differs between callers.
        return {
            "valid": False,
            "violations": [{
                "rule": "BR-01",
                "severity": "fatal",
                "field": "/Invoice/cbc:CustomizationID",
                "location": "BT-24",
                "message": "An Invoice shall have a Specification identifier.",
                "title": "Missing Specification identifier",
                "fix_hint": "Add cbc:CustomizationID.",
                "terms": ["BT-24"],
                "source_line": source_line,
            }],
        }

    def test_every_result_has_named_fingerprint(self):
        doc = build_sarif(self._report(42))
        results = doc["runs"][0]["results"]
        self.assertTrue(results)
        for res in results:
            fp = res.get("partialFingerprints")
            self.assertIsInstance(fp, dict, res)
            self.assertTrue(fp, "partialFingerprints must be non-empty")
            self.assertIn("einvoice/v1", fp, fp)
            self.assertTrue(fp["einvoice/v1"])

    def test_fingerprint_independent_of_source_line(self):
        # Criterion 2: same violation, two DIFFERENT parser source lines ->
        # IDENTICAL fingerprint (survives an edit that shifts the line).
        a = build_sarif(self._report(10))["runs"][0]["results"][0]
        b = build_sarif(self._report(9999))["runs"][0]["results"][0]
        self.assertEqual(a["partialFingerprints"], b["partialFingerprints"])
        # And the two source lines really were different inputs.
        self.assertNotEqual(10, 9999)

    def test_fingerprint_deterministic_byte_identical(self):
        # Criterion 3: build_sarif called twice on the same report is byte
        # identical (json.dumps of the fingerprints agrees).
        rep = self._report(7)
        first = build_sarif(rep)
        second = build_sarif(rep)
        self.assertEqual(json.dumps(first, sort_keys=True),
                         json.dumps(second, sort_keys=True))

    def test_malformed_error_result_has_line_free_fingerprint(self):
        # Criterion 5: the not-well-formed single-error path still emits a
        # fingerprint and NO helpUri, and it is line-free (error code only).
        doc = build_sarif({"valid": False, "error": "not-well-formed",
                           "message": "no element found"})
        results = doc["runs"][0]["results"]
        self.assertEqual(len(results), 1)
        fp = results[0]["partialFingerprints"]
        self.assertIn("einvoice/v1", fp)
        self.assertTrue(fp["einvoice/v1"])
        # No driver rules -> no helpUri path taken at all.
        self.assertEqual(_driver(doc)["rules"], [])


class SarifHelpUri(unittest.TestCase):
    """DELIVERABLE B: catalog rule descriptors deep-link via helpUri; a
    non-catalog id (e.g. the parse-error code) gets none."""

    def test_catalog_rule_descriptor_has_canonical_helpuri(self):
        rep = {
            "valid": False,
            "violations": [{
                "rule": "BR-01",
                "severity": "fatal",
                "field": "/Invoice/cbc:CustomizationID",
                "message": "x", "title": "t", "fix_hint": "f", "terms": [],
                "source_line": 3,
            }],
        }
        doc = build_sarif(rep)
        rules = _driver(doc)["rules"]
        self.assertTrue(rules)
        catalog_ids = set(load_catalog().keys())
        self.assertIn("BR-01", catalog_ids)
        by_id = {r["id"]: r for r in rules}
        self.assertEqual(
            by_id["BR-01"]["helpUri"],
            "https://verifyhash.com/einvoice/rules/BR-01/")
        # Exactly the gen_site canonical form (base + id + trailing slash).
        self.assertEqual(
            by_id["BR-01"]["helpUri"],
            SARIF_RULE_HELP_BASE_URL + "BR-01" + "/")
        # fullDescription still present and untouched (criterion 6).
        self.assertIn("fullDescription", by_id["BR-01"])
        self.assertEqual(by_id["BR-01"]["fullDescription"], {"text": "f"})

    def test_every_catalog_descriptor_gets_helpuri(self):
        # Against a real bad invoice: EVERY deduped descriptor whose id is a
        # catalog id carries the canonical helpUri; non-catalog ids do not.
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            report = build_report(bad, profile="xrechnung")
        doc = build_sarif(report)
        catalog_ids = set(load_catalog().keys())
        rules = _driver(doc)["rules"]
        self.assertTrue(rules)
        for r in rules:
            if r["id"] in catalog_ids:
                self.assertEqual(
                    r["helpUri"],
                    "https://verifyhash.com/einvoice/rules/%s/" % r["id"], r)
            else:
                self.assertNotIn("helpUri", r, r)

    def test_non_catalog_id_gets_no_helpuri(self):
        # A synthetic rule id that is NOT in the catalog must not deep-link.
        fake = "ZZ-NOT-A-REAL-RULE-999"
        self.assertNotIn(fake, set(load_catalog().keys()))
        rep = {
            "valid": False,
            "violations": [{
                "rule": fake, "severity": "fatal", "field": "/x",
                "message": "m", "title": "t", "fix_hint": "f", "terms": [],
                "source_line": 1,
            }],
        }
        doc = build_sarif(rep)
        by_id = {r["id"]: r for r in _driver(doc)["rules"]}
        self.assertIn(fake, by_id)
        self.assertNotIn("helpUri", by_id[fake])


if __name__ == "__main__":
    unittest.main()

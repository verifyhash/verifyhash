#!/usr/bin/env python3
"""test_example_workflow.py — prove the copy-paste SARIF CI example (T-VHINTEG.2).

Fast, stdlib-only (PyYAML used when present, with the same tolerant fallback
test_action.py uses), offline. It proves the committed consumer workflow under
``examples/ci-sarif/`` is both (a) well-formed and correctly wired for GitHub
code scanning, and (b) NOT decorative — the recipe it documents really validates
invoices and fails on a fatal, exercised against the SAME local corpus fixture
the other fast gates use. No new corpus, no network, no second validation
engine, no new runtime dependency.

Asserted (each maps to a task acceptance criterion):
  (1) the workflow YAML exists, parses as well-formed, and triggers on BOTH
      ``push`` and ``pull_request``.
  (2) it declares ``permissions: security-events: write`` and uploads SARIF via
      ``github/codeql-action/upload-sarif``.
  (3) it drives the EXISTING einvoice composite Action (``uses: ./action`` /
      ``einvoice.report``) — no second engine — and feeds the Action's
      ``sarif-file`` output to upload-sarif.
  (4) RUNNING the underlying command (the committed Action runner) against a
      directory holding a KNOWN-GOOD and a KNOWN-BAD invoice exits non-zero and
      the merged SARIF carries a level-"error" BR-DE-15 result — the recipe is
      real, and the merged-SARIF directory path is exercised.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))

WORKFLOW = os.path.join(HERE, "examples", "ci-sarif", "invoice-conformance.yml")
RUNNER = os.path.join(HERE, "action", "run.py")

# Reuse a real corpus fixture: 01.02a is CLEAN (zero findings, exit 0) — the
# same fixture test_action.py uses. The KNOWN-BAD invoice is that fixture with
# its BuyerReference removed, which fires BR-DE-15 (fatal): the identical
# construction test_action.py / test_report_sarif.py use.
GOOD = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test",
                    "business-cases", "standard", "01.02a-INVOICE_ubl.xml")


def make_bad_invoice(dest):
    with open(GOOD, encoding="utf-8") as fh:
        src = fh.read()
    bad = re.sub(r"<cbc:BuyerReference>[^<]*</cbc:BuyerReference>", "", src,
                 count=1)
    assert bad != src, "fixture drift: GOOD lost its BuyerReference"
    with open(dest, "w", encoding="utf-8") as fh:
        fh.write(bad)


def _read_workflow():
    with open(WORKFLOW, encoding="utf-8") as fh:
        return fh.read()


def _try_parse_yaml(text):
    """Parse ``text`` with PyYAML when available; else return ``(None, "fallback")``.

    Keeps this gate stdlib-only (the einvoice product is zero-dependency): when
    PyYAML is absent the structural assertions fall back to the grep-verifiable
    text checks, exactly the tolerant pattern test_action.py uses. When PyYAML
    IS present a malformed document raises here and fails the well-formed test.
    """
    try:
        import yaml  # noqa: WPS433 (optional dependency)
    except ImportError:  # pragma: no cover - only when PyYAML is absent
        return None, "fallback"
    return yaml.safe_load(text), "yaml"


class WorkflowIsWellFormed(unittest.TestCase):
    def test_workflow_file_exists(self):
        self.assertTrue(os.path.isfile(WORKFLOW), WORKFLOW)

    def test_yaml_parses_as_a_mapping(self):
        doc, mode = _try_parse_yaml(_read_workflow())
        if mode == "fallback":
            self.skipTest("PyYAML absent; structure covered by text-grep checks")
        self.assertIsInstance(doc, dict, "workflow YAML is not a mapping")
        self.assertIn("jobs", doc, "workflow declares no jobs")


class WorkflowTriggers(unittest.TestCase):
    def test_triggers_on_push_and_pull_request(self):
        # Grep-verifiable, and robust to the YAML 1.1 gotcha where the key `on`
        # parses as the boolean True. We assert both triggers appear inside the
        # `on:` block (before the next top-level key).
        text = _read_workflow()
        m = re.search(r"^on:\s*$(.*?)^\S", text, re.MULTILINE | re.DOTALL)
        self.assertIsNotNone(m, "no `on:` block found")
        block = m.group(1)
        self.assertRegex(block, r"(?m)^\s+push:", "on: block must include push")
        self.assertRegex(block, r"(?m)^\s+pull_request:",
                         "on: block must include pull_request")


class WorkflowPermissionsAndUpload(unittest.TestCase):
    def test_declares_security_events_write(self):
        self.assertRegex(_read_workflow(), r"security-events:\s*write",
                         "workflow must grant permissions: security-events: write")

    def test_uploads_sarif_via_codeql_action(self):
        text = _read_workflow()
        self.assertIn("github/codeql-action/upload-sarif", text,
                      "workflow must upload SARIF via codeql-action/upload-sarif")
        # The upload must consume the Action's own sarif-file output, not a
        # hard-coded path — that is what wires the merged document through.
        self.assertRegex(
            text, r"sarif_file:\s*\$\{\{\s*steps\.\w+\.outputs\.sarif-file\s*\}\}",
            "upload step must feed steps.<id>.outputs.sarif-file")


class WorkflowDrivesTheExistingAction(unittest.TestCase):
    def test_uses_the_committed_composite_action_no_second_engine(self):
        text = _read_workflow()
        # Drives the EXISTING Action (or its documented entrypoint) — no second
        # validation engine is spun up in the example.
        self.assertRegex(text, r"uses:\s*\./action|einvoice\.report",
                         "workflow must drive the einvoice Action/entrypoint")
        # fail-on: fatal is the fatal-gating contract the example must keep.
        self.assertRegex(text, r"fail-on:\s*fatal",
                         "workflow must fail the build on fatal")


class RecipeIsRealNotDecorative(unittest.TestCase):
    """Run the committed Action runner the workflow drives, against a directory
    holding BOTH a good and a bad invoice, and prove the documented behaviour."""

    def _run_action(self, path, sarif_file):
        proc = subprocess.run(
            [sys.executable, RUNNER,
             "--path", path, "--format", "sarif", "--fail-on", "fatal",
             "--sarif-file", sarif_file, "--profile", "xrechnung"],
            cwd=tempfile.gettempdir(), capture_output=True, text=True,
            timeout=120)
        return proc

    def test_directory_with_good_and_bad_fails_with_brde15(self):
        with tempfile.TemporaryDirectory() as tmp:
            invoices = os.path.join(tmp, "invoices")
            os.mkdir(invoices)
            # A clean invoice (exit 0, zero results) ...
            with open(GOOD, encoding="utf-8") as fh:
                good_src = fh.read()
            with open(os.path.join(invoices, "good.xml"), "w",
                      encoding="utf-8") as fh:
                fh.write(good_src)
            # ... and the same invoice with BuyerReference stripped (BR-DE-15).
            make_bad_invoice(os.path.join(invoices, "bad.xml"))

            sarif = os.path.join(tmp, "einvoice.sarif")
            proc = self._run_action(invoices, sarif)

            # The bad invoice's fatal fails the build (fail-on=fatal).
            self.assertNotEqual(proc.returncode, 0,
                                proc.stdout + proc.stderr)
            self.assertTrue(os.path.isfile(sarif), "merged SARIF not written")
            with open(sarif, encoding="utf-8") as fh:
                doc = json.load(fh)

        # Valid merged SARIF 2.1.0 from the einvoice driver.
        self.assertEqual(doc["version"], "2.1.0")
        run0 = doc["runs"][0]
        self.assertEqual(run0["tool"]["driver"]["name"], "einvoice")

        results = run0["results"]
        self.assertGreaterEqual(len(results), 1,
                                "merged SARIF must carry the fatal finding")
        # No orphan results: every ruleId is a declared driver rule.
        rule_ids = {r["id"] for r in run0["tool"]["driver"]["rules"]}
        for res in results:
            self.assertIn(res["ruleId"], rule_ids)
        # The BR-DE-15 fatal surfaces as a level-"error" result — proving the
        # ruleId/message names BR-DE-15 and the good+bad directory (merged path)
        # was really exercised.
        brde15 = [r for r in results if r["ruleId"] == "BR-DE-15"]
        self.assertTrue(brde15, "expected a BR-DE-15 result in the merged SARIF")
        self.assertTrue(any(r["level"] == "error" for r in brde15),
                        "BR-DE-15 must surface as a level-error result")

    def test_clean_directory_passes(self):
        # Guard the other side: a directory with only the clean invoice passes,
        # so the gate above is discriminating, not always-red.
        with tempfile.TemporaryDirectory() as tmp:
            invoices = os.path.join(tmp, "invoices")
            os.mkdir(invoices)
            with open(GOOD, encoding="utf-8") as fh:
                good_src = fh.read()
            with open(os.path.join(invoices, "good.xml"), "w",
                      encoding="utf-8") as fh:
                fh.write(good_src)
            sarif = os.path.join(tmp, "einvoice.sarif")
            proc = self._run_action(invoices, sarif)
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            with open(sarif, encoding="utf-8") as fh:
                doc = json.load(fh)
        self.assertEqual(len(doc["runs"][0]["results"]), 0,
                         "clean directory must emit zero SARIF results")


if __name__ == "__main__":
    unittest.main()

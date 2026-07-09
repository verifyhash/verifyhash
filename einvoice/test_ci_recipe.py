#!/usr/bin/env python3
"""test_ci_recipe.py — prove the ci/ copy-paste recipe drives the REAL
conformance-report entrypoint (`python3 -m einvoice.report`), not the legacy
single-invoice validate CLI.

Fast, stdlib-only, saxonche-free, offline. Reuses the SAME local corpus fixture
the packaging/xrechnung/report gates use (01.01a-INVOICE_ubl.xml) plus a
BuyerReference-stripped bad copy — no new corpus, no network, no new deps.

Asserted (each maps to a task acceptance criterion):
  (a) `python3 -m einvoice.report --format junit <fixture>` EXISTS and behaves:
      - clean invoice, --profile en16931 -> well-formed JUnit XML on stdout,
        zero <failure>, exit 0 (the README's "0 = no fatal" contract).
      - BuyerReference-stripped copy, --profile xrechnung -> well-formed JUnit
        XML, a <failure> whose testcase is BR-DE-15, exit non-zero (the
        README's "non-zero = fatal violation" contract).
  (b) --format json also exists and reports valid/fatal_count consistently.
  (c) the recipe FILES textually reference the real entrypoint:
      - ci/validate-invoices.sh references `einvoice.report`
      - ci/github-actions.yml references `einvoice.report`
      - and validate-invoices.sh no longer invokes the legacy
        `python3 -m einvoice` (without the `.report`) path.
  (d) the gate script itself, run end-to-end against a good+bad corpus dir,
      exits 1, names BR-DE-15, and writes per-invoice JUnit into the results
      dir (proving it drives the junit projection, not the legacy CLI).
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from xml.dom import minidom

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

CI_DIR = os.path.join(HERE, "ci")
GATE = os.path.join(CI_DIR, "validate-invoices.sh")
GHA = os.path.join(CI_DIR, "github-actions.yml")
GITLAB = os.path.join(CI_DIR, "gitlab-ci.yml")
README = os.path.join(CI_DIR, "README.md")

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


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def run_report(*args):
    return subprocess.run(
        [sys.executable, "-m", "einvoice.report", *args],
        cwd=HERE, capture_output=True, text=True, timeout=120)


class EntrypointExistsAndBehaves(unittest.TestCase):
    """(a)/(b) The documented entrypoint + flags exist and honor the README's
    exit-code contract (0 = no fatal, non-zero = fatal)."""

    def test_clean_en16931_junit_exit_zero(self):
        proc = run_report("--profile", "en16931", "--format", "junit", BASE)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        dom = minidom.parseString(proc.stdout)          # well-formed XML
        self.assertEqual(len(dom.getElementsByTagName("failure")), 0,
                         proc.stdout)
        self.assertTrue(dom.getElementsByTagName("testsuite"), proc.stdout)

    def test_bad_xrechnung_junit_nonzero_names_brde15(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            proc = run_report("--profile", "xrechnung", "--format", "junit", bad)
        self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        dom = minidom.parseString(proc.stdout)          # well-formed XML
        failures = dom.getElementsByTagName("failure")
        self.assertGreaterEqual(len(failures), 1, proc.stdout)
        failing_names = {f.parentNode.getAttribute("name") for f in failures}
        self.assertIn("BR-DE-15", failing_names, proc.stdout)

    def test_json_format_reports_valid_flag(self):
        clean = run_report("--profile", "en16931", "--format", "json", BASE)
        self.assertEqual(clean.returncode, 0, clean.stderr)
        payload = json.loads(clean.stdout)
        self.assertTrue(payload["valid"], payload)
        self.assertEqual(payload["fatal_count"], 0, payload)

        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            dirty = run_report("--profile", "xrechnung", "--format", "json", bad)
        self.assertEqual(dirty.returncode, 1, dirty.stdout + dirty.stderr)
        payload = json.loads(dirty.stdout)
        self.assertFalse(payload["valid"], payload)
        self.assertGreaterEqual(payload["fatal_count"], 1, payload)


class RecipeFilesReferenceRealEntrypoint(unittest.TestCase):
    """(c) The recipe files point at einvoice.report, not the legacy CLI."""

    def test_gate_script_references_report_module(self):
        self.assertIn("einvoice.report", read(GATE))

    def test_github_actions_references_report_module(self):
        self.assertIn("einvoice.report", read(GHA))

    def test_gitlab_and_readme_reference_report_module(self):
        self.assertIn("einvoice.report", read(GITLAB))
        self.assertIn("einvoice.report", read(README))

    def test_gate_script_dropped_legacy_module_path(self):
        # `python3 -m einvoice` (WITHOUT `.report`) must be gone from the gate.
        self.assertIsNone(
            re.search(r"python3 -m einvoice([^.]|$)", read(GATE)),
            "gate still invokes the legacy `python3 -m einvoice` path")

    def test_readme_documents_exit_code_contract(self):
        text = read(README)
        # exit-code contract: 0 = no fatal, non-zero = fatal.
        self.assertIn("--format json|junit", text)
        self.assertRegex(text, r"no fatal")       # the exit-0 case
        self.assertRegex(text, r"non-zero")       # the fatal case
        self.assertIn("fatal", text)


class GateScriptEndToEnd(unittest.TestCase):
    """(d) The gate script drives the junit projection end-to-end."""

    def _run_gate(self, target, results_dir, profile="xrechnung"):
        env = dict(os.environ)
        env["EINVOICE_CMD"] = "%s -m einvoice.report" % sys.executable
        env["EINVOICE_PROFILE"] = profile
        env["EINVOICE_RESULTS_DIR"] = results_dir
        return subprocess.run(["sh", GATE, target], env=env, cwd=HERE,
                              capture_output=True, text=True, timeout=120)

    def test_gate_fails_and_writes_junit(self):
        with tempfile.TemporaryDirectory() as tmp:
            corpus = os.path.join(tmp, "invoices")
            os.mkdir(corpus)
            shutil.copy(BASE, os.path.join(corpus, "good.xml"))
            make_bad_invoice(os.path.join(corpus, "bad.xml"))
            results = os.path.join(tmp, "junit")
            proc = self._run_gate(corpus, results)

            self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
            self.assertIn("BR-DE-15", proc.stdout)
            self.assertIn("NON-CONFORMANT", proc.stdout)
            self.assertIn("1/2", proc.stdout)

            # Per-invoice JUnit XML actually written, and each is well-formed.
            files = [f for f in os.listdir(results) if f.endswith(".junit.xml")]
            self.assertEqual(len(files), 2, files)
            for name in files:
                minidom.parse(os.path.join(results, name))

    def test_gate_passes_clean_corpus(self):
        with tempfile.TemporaryDirectory() as tmp:
            corpus = os.path.join(tmp, "invoices")
            os.mkdir(corpus)
            shutil.copy(BASE, os.path.join(corpus, "good.xml"))
            results = os.path.join(tmp, "junit")
            proc = self._run_gate(corpus, results)
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            self.assertIn("PASS", proc.stdout)


if __name__ == "__main__":
    unittest.main()

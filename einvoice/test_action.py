#!/usr/bin/env python3
"""test_action.py — prove the composite GitHub Action (T-VHX.2).

Fast, stdlib-only (PyYAML used when present, with a tolerant fallback), offline.
Exercises the committed Action manifest + thin runner against the SAME local
corpus fixture the other fast gates use — no new corpus, no hand-faked report,
no network, no second validation engine.

Asserted (each maps to a task acceptance criterion):
  (1) action.yml is well-formed YAML declaring a COMPOSITE action whose inputs
      include path, format and fail-on.
  (2) the runner source drives the real `einvoice.report` entrypoint
      (grep-verifiable) and defines no second validation engine.
  (3) the runner on a KNOWN-GOOD invoice exits 0 and writes a valid SARIF file
      with zero results / no error; on a KNOWN-BAD invoice it exits non-zero and
      writes a SARIF file carrying >= 1 result.
  (4) fail-on semantics: a fatal invoice fails under BOTH fail-on=fatal and
      fail-on=warning; a clean invoice passes under fail-on=warning (the JSON
      warning-parse branch runs).
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ACTION_DIR = os.path.join(HERE, "action")
ACTION_YML = os.path.join(ACTION_DIR, "action.yml")
RUNNER = os.path.join(ACTION_DIR, "run.py")

# Reuse a real corpus fixture: 01.02a is CLEAN (zero findings, exit 0). The
# KNOWN-BAD invoice is that same fixture with its BuyerReference removed, which
# fires BR-DE-15 (fatal) — the identical construction test_report_sarif uses.
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


def run_runner(path, sarif_file, fmt="sarif", fail_on="fatal"):
    """Execute the committed runner exactly as the composite action would."""
    proc = subprocess.run(
        [sys.executable, RUNNER,
         "--path", path, "--format", fmt, "--fail-on", fail_on,
         "--sarif-file", sarif_file, "--profile", "xrechnung"],
        cwd=tempfile.gettempdir(), capture_output=True, text=True, timeout=120)
    return proc


def _load_action_yml():
    """Parse action.yml, preferring PyYAML; fall back to a tolerant reader.

    The fallback keeps this gate stdlib-only (the einvoice product is zero-dep):
    it recognises the top-level ``runs:``/``inputs:`` blocks and the two-space
    ``inputs`` keys well enough to assert the contract without a YAML library.
    """
    with open(ACTION_YML, encoding="utf-8") as fh:
        text = fh.read()
    try:
        import yaml  # noqa: WPS433 (optional dependency)
        return yaml.safe_load(text), "yaml"
    except Exception:  # pragma: no cover - only when PyYAML is absent
        using = None
        inputs = {}
        section = None
        for line in text.splitlines():
            if re.match(r"^runs:\s*$", line):
                section = "runs"
                continue
            if re.match(r"^inputs:\s*$", line):
                section = "inputs"
                continue
            if re.match(r"^\S", line):
                section = None
            m = re.match(r"^\s{4}using:\s*'?([A-Za-z0-9_-]+)'?", line)
            if section == "runs" and m:
                using = m.group(1)
            m = re.match(r"^\s{2}([A-Za-z0-9_-]+):\s*$", line)
            if section == "inputs" and m:
                inputs[m.group(1)] = {}
        return {"runs": {"using": using}, "inputs": inputs}, "fallback"


class ActionManifest(unittest.TestCase):
    def test_action_yml_is_composite_with_declared_inputs(self):
        self.assertTrue(os.path.isfile(ACTION_YML), ACTION_YML)
        doc, _ = _load_action_yml()
        self.assertIsInstance(doc, dict, "action.yml is not a YAML mapping")
        runs = doc.get("runs") or {}
        self.assertEqual(runs.get("using"), "composite",
                         "runs.using must be 'composite'")
        inputs = doc.get("inputs") or {}
        for required in ("path", "format", "fail-on"):
            self.assertIn(required, inputs,
                          "missing declared input %r" % required)

    def test_composite_step_invokes_the_runner(self):
        with open(ACTION_YML, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("run.py", text,
                      "composite runs.steps must invoke the committed runner")


class RunnerDrivesRealEntrypoint(unittest.TestCase):
    def test_runner_greps_for_einvoice_report(self):
        with open(RUNNER, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("einvoice.report", src,
                      "runner must drive the real einvoice.report entrypoint")
        # It must invoke the module, not re-implement a validator. The runner
        # never imports the rule modules (that would be a second engine).
        self.assertNotIn("import einvoice.rules", src)
        self.assertNotIn("from einvoice import rules", src)


class RunnerGoodInvoice(unittest.TestCase):
    def test_good_invoice_exit_zero_sarif_zero_results(self):
        with tempfile.TemporaryDirectory() as tmp:
            sarif = os.path.join(tmp, "out.sarif")
            proc = run_runner(GOOD, sarif)
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            self.assertTrue(os.path.isfile(sarif), "SARIF file not written")
            with open(sarif, encoding="utf-8") as fh:
                doc = json.load(fh)
        self.assertEqual(doc["version"], "2.1.0")
        run0 = doc["runs"][0]
        self.assertEqual(run0["tool"]["driver"]["name"], "einvoice")
        self.assertEqual(len(run0["results"]), 0,
                         "clean invoice must emit zero SARIF results")


class RunnerBadInvoice(unittest.TestCase):
    def test_bad_invoice_nonzero_exit_sarif_has_results(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            sarif = os.path.join(tmp, "out.sarif")
            proc = run_runner(bad, sarif)
            self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            self.assertTrue(os.path.isfile(sarif), "SARIF file not written")
            with open(sarif, encoding="utf-8") as fh:
                doc = json.load(fh)
        results = doc["runs"][0]["results"]
        self.assertGreaterEqual(len(results), 1,
                                "bad invoice must emit >= 1 SARIF result")
        # Every result.ruleId is a declared driver rule (no orphan results).
        rule_ids = {r["id"] for r in doc["runs"][0]["tool"]["driver"]["rules"]}
        for res in results:
            self.assertIn(res["ruleId"], rule_ids)
        # The BR-DE-15 fatal surfaces as a level-"error" result.
        self.assertIn("BR-DE-15", {r["ruleId"] for r in results})
        self.assertTrue(any(r["level"] == "error" for r in results
                            if r["ruleId"] == "BR-DE-15"))


class RunnerFailOnSemantics(unittest.TestCase):
    def test_fatal_fails_under_both_fail_on_modes(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            for mode in ("fatal", "warning"):
                sarif = os.path.join(tmp, "out-%s.sarif" % mode)
                proc = run_runner(bad, sarif, fail_on=mode)
                self.assertNotEqual(proc.returncode, 0,
                                    "%s: %s" % (mode, proc.stderr))

    def test_clean_invoice_passes_under_fail_on_warning(self):
        # Exercises the JSON warning-parse branch of the runner and confirms a
        # clean invoice (zero warnings) still passes under the stricter mode.
        with tempfile.TemporaryDirectory() as tmp:
            sarif = os.path.join(tmp, "out.sarif")
            proc = run_runner(GOOD, sarif, fail_on="warning")
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)


if __name__ == "__main__":
    unittest.main()

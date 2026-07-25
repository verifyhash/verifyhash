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
  (5) T-VHERG.8 — the offered console-format vocabulary is DERIVED from the
      engine registry (``einvoice.report.REPORT_FORMATS``) minus the runner's
      declared ``FORMAT_EXCLUSIONS``, the excluded other-vendor formats stay
      rejected, ``--format github`` works for BOTH a single file and a
      directory (the engine has no ``--recurse`` batch shape for it), and
      action.yml's documented list agrees with the runner's offered tuple.
"""

import importlib.util
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


def _load_runner_module():
    """Import ``action/run.py`` as a module so its constants can be read.

    Loaded by path (not by name) because ``action/`` is not a package; this is
    the same file the composite action executes, so the constants asserted here
    are the ones that actually ship.
    """
    spec = importlib.util.spec_from_file_location("_einvoice_action_run", RUNNER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


RUNNER_MOD = _load_runner_module()

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


#: The exclusions the Action is ALLOWED to make, and why. Duplicated here on
#: purpose: the runner must not be able to quietly drop a format from its offer
#: without this gate going red.
EXPECTED_EXCLUSIONS = {
    "gitlab": "another vendor's CI format",
    "azure": "another vendor's CI format",
    "html": "document-shaped artifact, not job-log lines",
    "badge": "document-shaped artifact, not job-log lines",
}


def _documented_formats():
    """The format vocabulary action.yml's `format` input description states.

    Read from the RAW manifest text (whitespace-flattened) so the assertion
    holds with or without PyYAML, and so it breaks if the sentence is reworded
    away from the machine-checkable ``one of: a, b, c.`` shape.
    """
    with open(ACTION_YML, encoding="utf-8") as fh:
        flat = re.sub(r"\s+", " ", fh.read())
    m = re.search(r"job log, one of: ([a-z0-9, ]+?)\.", flat)
    assert m, ("action.yml's format input must state its vocabulary as "
               "'... job log, one of: <fmt>, <fmt>, ....'")
    return [tok.strip() for tok in m.group(1).split(",") if tok.strip()]


class OfferedFormatVocabulary(unittest.TestCase):
    """(5a) offered set == engine registry minus a named, reasoned exclusion set."""

    def test_offered_is_registry_minus_declared_exclusions(self):
        from einvoice import report

        exclusions = RUNNER_MOD.FORMAT_EXCLUSIONS
        self.assertEqual(set(exclusions), set(EXPECTED_EXCLUSIONS),
                         "the Action's declared format exclusions changed; "
                         "each exclusion is a deliberate product decision")
        for name, reason in exclusions.items():
            self.assertIn(name, report.REPORT_FORMATS,
                          "excluded %r is not a registered engine format "
                          "(stale exclusion)" % name)
            self.assertTrue(isinstance(reason, str) and len(reason) > 20,
                            "exclusion %r needs a one-line reason" % name)

        offered = RUNNER_MOD.console_formats(HERE)
        expected = tuple(f for f in report.REPORT_FORMATS
                         if f not in exclusions)
        self.assertEqual(offered, expected,
                         "offered console formats must be REPORT_FORMATS minus "
                         "FORMAT_EXCLUSIONS — no hand-maintained subset")
        # The concrete contract this task ships, spelled out so a silent drift
        # in either tuple is visible in the failure message.
        self.assertEqual(set(offered),
                         {"json", "junit", "sarif", "github", "text"})

    def test_excluded_formats_are_rejected_by_the_runner(self):
        # Other-vendor CI formats must NOT be reachable through this Action.
        with tempfile.TemporaryDirectory() as tmp:
            for fmt in ("gitlab", "azure"):
                sarif = os.path.join(tmp, "out-%s.sarif" % fmt)
                proc = run_runner(GOOD, sarif, fmt=fmt)
                self.assertNotEqual(proc.returncode, 0,
                                    "%s must be rejected, got exit 0" % fmt)

    def test_action_yml_format_list_matches_the_runner(self):
        """(5d) docs-parity: action.yml's list == the runner's offered tuple."""
        documented = _documented_formats()
        self.assertEqual(len(documented), len(set(documented)),
                         "action.yml lists a format twice: %r" % documented)
        self.assertEqual(set(documented),
                         set(RUNNER_MOD.console_formats(HERE)),
                         "action.yml's documented format list drifted from the "
                         "runner's offered formats")

    def test_action_yml_states_the_permission_fact(self):
        with open(ACTION_YML, encoding="utf-8") as fh:
            text = fh.read()
        self.assertNotIn("json | junit | sarif | text", text,
                         "action.yml still carries the stale four-format list")
        self.assertIn("security-events", text,
                      "action.yml must state that 'github' needs no "
                      "security-events: write permission")

    def test_readme_documents_the_github_format(self):
        with open(os.path.join(ACTION_DIR, "README.md"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("format: github", text,
                      "action/README.md needs a copy-pasteable snippet using "
                      "format: github")
        for fmt in RUNNER_MOD.console_formats(HERE):
            self.assertIn("`%s`" % fmt, text,
                          "action/README.md inputs table omits format %r" % fmt)


class GithubAnnotationFormat(unittest.TestCase):
    """(5b/5c) `--format github` emits workflow commands, file AND directory."""

    ANNOTATION = re.compile(
        r"^::error file=[^,]+,title=[A-Za-z0-9._-]+::.+$", re.M)

    def test_single_file_github_emits_annotations(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            sarif = os.path.join(tmp, "out.sarif")
            proc = run_runner(bad, sarif, fmt="github")
            self.assertEqual(proc.returncode, 1,
                             "fatal invoice must exit 1: " + proc.stderr)
            hits = self.ANNOTATION.findall(proc.stdout)
            self.assertGreaterEqual(
                len(hits), 1,
                "no '::error file=...,title=...::...' line on stdout:\n"
                + proc.stdout)
            self.assertIn("BR-DE-15", proc.stdout)
            # The merged SARIF contract is unaffected by the console format.
            with open(sarif, encoding="utf-8") as fh:
                doc = json.load(fh)
            self.assertGreaterEqual(len(doc["runs"][0]["results"]), 1)

    def test_directory_github_emits_annotations_per_file(self):
        # `github` is NOT in einvoice.report.BATCH_FORMATS, so `--recurse` is
        # refused by the engine; the runner must drive it once per file instead
        # of emitting nothing.
        with tempfile.TemporaryDirectory() as tmp:
            invoices = os.path.join(tmp, "invoices")
            os.mkdir(invoices)
            make_bad_invoice(os.path.join(invoices, "bad.xml"))
            with open(GOOD, encoding="utf-8") as src:
                good_txt = src.read()
            with open(os.path.join(invoices, "good.xml"), "w",
                      encoding="utf-8") as fh:
                fh.write(good_txt)
            sarif = os.path.join(tmp, "out.sarif")
            proc = run_runner(invoices, sarif, fmt="github")
            self.assertEqual(proc.returncode, 1,
                             "directory with a fatal invoice must exit 1: "
                             + proc.stderr)
            hits = self.ANNOTATION.findall(proc.stdout)
            self.assertGreaterEqual(
                len(hits), 1,
                "directory mode emitted no annotation lines:\n" + proc.stdout)
            self.assertTrue(any("bad.xml" in h for h in hits),
                            "annotations must name the offending file:\n"
                            + proc.stdout)
            self.assertNotIn("validates a single file", proc.stderr,
                             "runner still tried --recurse for a single-file "
                             "format")

    def test_directory_batch_formats_still_use_recurse(self):
        # Guard the untouched leg: json IS a batch format, so a directory must
        # still produce ONE batch document, not one report per file.
        with tempfile.TemporaryDirectory() as tmp:
            invoices = os.path.join(tmp, "invoices")
            os.mkdir(invoices)
            make_bad_invoice(os.path.join(invoices, "bad.xml"))
            sarif = os.path.join(tmp, "out.sarif")
            proc = run_runner(invoices, sarif, fmt="json")
            self.assertEqual(proc.returncode, 1, proc.stderr)
            doc = json.loads(proc.stdout)          # a single JSON document
            self.assertEqual(doc.get("schema"),
                             "einvoice-conformance-batch/v1", proc.stdout[:400])
            self.assertEqual(doc.get("file_count"), 1)


if __name__ == "__main__":
    unittest.main()

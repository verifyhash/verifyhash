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
  (6) T-VHACT.3 — the merged SARIF carries WORKSPACE-RELATIVE artifact URIs
      anchored to a declared ``uriBaseId``, for both the absolute and the
      relative ``--path`` route; a file outside the workspace keeps its
      absolute URI with no base id and no ``..`` escape; and the rewrite
      changes nothing else (result count, order, levels and rule union are
      identical to the unmodified engine's own SARIF).
"""

import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
import urllib.parse

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


# ---------------------------------------------------------------------------
# T-VHACT.2 — workspace-realistic layer.
#
# Every test above hands the runner an ABSOLUTE path, which is the one shape a
# real workflow never uses: a GitHub step runs with the process cwd set to
# $GITHUB_WORKSPACE and `path:` is written relative to it (`invoices/`, or
# action.yml's own default `.`). That gap hid a real defect — the runner drives
# `python3 -m einvoice.report` with cwd=<package root>, so a workspace-relative
# path was resolved by the CHILD against the package root: it either died with
# "no such file" or, when the name also existed under the package root, SILENTLY
# validated OUR file while labelling the findings with the USER's path (a bad
# invoice passing on a green build).
#
# These tests therefore set the PROCESS cwd (see run_runner_in_workspace) to a
# temp directory that is neither the repo nor the package root, and drive the
# shapes a real workflow uses. They assert on FINDINGS, never on path strings,
# for the shadowing case — a path assertion would pass even while the wrong
# file was read.
# ---------------------------------------------------------------------------

PKG_EXAMPLES = os.path.join(HERE, "examples", "01-missing-fields")
PKG_BROKEN = os.path.join(PKG_EXAMPLES, "broken.xml")
PKG_FIXED = os.path.join(PKG_EXAMPLES, "fixed.xml")

#: A workflow-command line: ``::error file=x,title=BR-DE-2::message``.
_WORKFLOW_CMD = re.compile(r"^::(error|warning|notice) (.*?)::(.*)$")


def parse_annotations(stdout):
    """-> list of ``(level, props_dict, message)`` for each workflow command."""
    out = []
    for line in stdout.splitlines():
        m = _WORKFLOW_CMD.match(line)
        if not m:
            continue
        props = dict(p.split("=", 1)
                     for p in m.group(2).split(",") if "=" in p)
        out.append((m.group(1), props, m.group(3)))
    return out


def rules_reported(stdout):
    """The SET of rule ids the github format annotated (``title=``)."""
    return {props.get("title") for _, props, _ in parse_annotations(stdout)}


def run_runner_in_workspace(workspace, argv, github_workspace=None):
    """Run the committed runner with the PROCESS cwd set to ``workspace``.

    This is the whole point of this layer: the child inherits the cwd exactly
    as it would inside a ``run:`` step, so relative ``--path`` values are
    interpreted the way a real workflow interprets them.

    ``github_workspace`` sets ``$GITHUB_WORKSPACE`` for the child, which is what
    a real GitHub runner exports and what the runner anchors its SARIF URIs to.
    Passing ``None`` REMOVES the variable, so the tests that predate it
    deterministically exercise the cwd fallback even if the ambient environment
    (a CI job running this suite) happens to define one.

    Both the cwd and the variable are restored in a ``finally`` so a failure
    here cannot poison the rest of the suite (unittest shares one process).
    """
    saved = os.getcwd()
    saved_ws = os.environ.get("GITHUB_WORKSPACE")
    try:
        os.chdir(workspace)
        if github_workspace is None:
            os.environ.pop("GITHUB_WORKSPACE", None)
        else:
            os.environ["GITHUB_WORKSPACE"] = github_workspace
        return subprocess.run([sys.executable, RUNNER] + list(argv),
                              capture_output=True, text=True, timeout=180)
    finally:
        os.chdir(saved)
        if saved_ws is None:
            os.environ.pop("GITHUB_WORKSPACE", None)
        else:
            os.environ["GITHUB_WORKSPACE"] = saved_ws


def _write_workspace_invoice(dest, source=PKG_BROKEN, drop_buyer_ref=False):
    """Copy a corpus example into the workspace, optionally mutating it.

    ``drop_buyer_ref`` removes BT-10 from ``fixed.xml``, which yields a file
    whose RULE SET differs from the package's own ``broken.xml``: BR-DE-15 fires
    on both, but BR-DE-2 (missing SELLER CONTACT) fires ONLY on the package
    copy. That divergence is what the shadowing test asserts on.
    """
    with open(source, encoding="utf-8") as fh:
        text = fh.read()
    if drop_buyer_ref:
        mutated = re.sub(
            r"[ \t]*<cbc:BuyerReference>[^<]*</cbc:BuyerReference>\n", "",
            text, count=1)
        assert mutated != text, "fixture drift: fixed.xml lost BuyerReference"
        text = mutated
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w", encoding="utf-8") as fh:
        fh.write(text)


class WorkspaceRelativePaths(unittest.TestCase):
    """The runner must work from a workspace cwd with relative paths."""

    def _workspace(self, tmp):
        """Assert the temp dir really is neither the repo nor the package root."""
        ws = os.path.realpath(tmp)
        self.assertFalse(
            ws == os.path.realpath(HERE)
            or ws.startswith(os.path.realpath(HERE) + os.sep),
            "workspace fixture must live outside the package root")
        return ws

    def _assert_workspace_findings(self, proc, ws, sarif_name="out.sarif"):
        combined = proc.stdout + proc.stderr
        self.assertNotIn("no such file", combined,
                         "child resolved the path against the wrong cwd:\n"
                         + combined)
        self.assertEqual(proc.returncode, 1,
                         "a fatal invoice must fail the build:\n" + combined)
        self.assertIn("BR-DE-2", rules_reported(proc.stdout),
                      "workspace invoice's real findings missing:\n"
                      + proc.stdout)
        sarif = os.path.join(ws, sarif_name)
        self.assertTrue(os.path.isfile(sarif), "SARIF file not written to " + sarif)
        with open(sarif, encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertGreaterEqual(len(doc["runs"][0]["results"]), 1, sarif)

    def test_relative_directory_from_workspace_cwd(self):
        # The shape `path: invoices/` in a workflow.
        with tempfile.TemporaryDirectory() as tmp:
            ws = self._workspace(tmp)
            _write_workspace_invoice(os.path.join(ws, "invoices", "broken.xml"))
            proc = run_runner_in_workspace(
                ws, ["--path", "invoices/", "--format", "github",
                     "--sarif-file", "out.sarif"])
            self._assert_workspace_findings(proc, ws)
            # The annotation must carry the path the USER supplied: GitHub
            # resolves `file=` against the workspace, so a runner-absolute path
            # would annotate nothing.
            files = {props.get("file")
                     for _, props, _ in parse_annotations(proc.stdout)}
            self.assertEqual(files, {"invoices/broken.xml"}, proc.stdout)
            self.assertNotIn(ws, proc.stdout,
                             "runner-absolute path leaked into the job log")

    def test_relative_file_from_workspace_cwd(self):
        # The shape `path: invoices/broken.xml` in a workflow.
        with tempfile.TemporaryDirectory() as tmp:
            ws = self._workspace(tmp)
            _write_workspace_invoice(os.path.join(ws, "invoices", "broken.xml"))
            proc = run_runner_in_workspace(
                ws, ["--path", "invoices/broken.xml", "--format", "github",
                     "--sarif-file", "out.sarif"])
            self._assert_workspace_findings(proc, ws)
            files = {props.get("file")
                     for _, props, _ in parse_annotations(proc.stdout)}
            self.assertEqual(files, {"invoices/broken.xml"}, proc.stdout)

    def test_default_dot_path_matches_relative_directory(self):
        # action.yml's own default is `.` — omitting --path must behave
        # identically to naming the directory relatively.
        with tempfile.TemporaryDirectory() as tmp:
            ws = self._workspace(tmp)
            _write_workspace_invoice(os.path.join(ws, "invoices", "broken.xml"))
            explicit = run_runner_in_workspace(
                ws, ["--path", ".", "--format", "github",
                     "--sarif-file", "explicit.sarif"])
            default = run_runner_in_workspace(
                ws, ["--format", "github", "--sarif-file", "out.sarif"])
            self._assert_workspace_findings(default, ws)
            self.assertEqual(default.returncode, explicit.returncode,
                             default.stderr + explicit.stderr)
            self.assertEqual(rules_reported(default.stdout),
                             rules_reported(explicit.stdout))
            self.assertEqual(default.stdout, explicit.stdout,
                             "default --path must equal an explicit '.'")

    def test_shadowed_workspace_path_reports_the_workspace_file(self):
        """SHADOWING: a workspace path that also exists under the package root.

        `examples/01-missing-fields/` exists in BOTH the workspace fixture and
        the einvoice package root. Before the fix the child (cwd=<package root>)
        happily opened OUR copy and reported ITS findings under the user's path
        — a green-looking run describing a file the user never wrote.

        The assertion is on a value that genuinely DIFFERS between the two
        files, never on a path string: the workspace copy is fixed.xml minus
        BT-10, so it fires BR-DE-15 but NOT BR-DE-2, while the package's own
        broken.xml fires BOTH. Seeing BR-DE-2 therefore means the wrong file
        was read.
        """
        collision = os.path.join("examples", "01-missing-fields")
        self.assertTrue(os.path.isfile(PKG_BROKEN),
                        "shadowing fixture needs the package's own " + PKG_BROKEN)
        with tempfile.TemporaryDirectory() as tmp:
            ws = self._workspace(tmp)
            _write_workspace_invoice(
                os.path.join(ws, collision, "broken.xml"),
                source=PKG_FIXED, drop_buyer_ref=True)

            proc = run_runner_in_workspace(
                ws, ["--path", collision + os.sep, "--format", "github",
                     "--sarif-file", "out.sarif"])
            combined = proc.stdout + proc.stderr
            self.assertNotIn("no such file", combined, combined)
            reported = rules_reported(proc.stdout)

            # Guard the fixture: the SHADOWING file (ours) must really differ,
            # otherwise this test would prove nothing.
            pkg = run_runner_in_workspace(
                tempfile.gettempdir(),
                ["--path", PKG_BROKEN, "--format", "github",
                 "--sarif-file", os.path.join(ws, "pkg.sarif")])
            pkg_rules = rules_reported(pkg.stdout)
            self.assertIn("BR-DE-2", pkg_rules,
                          "fixture drift: the package's broken.xml no longer "
                          "fires BR-DE-2, so shadowing is undetectable")
            self.assertNotEqual(reported, pkg_rules)

            self.assertIn("BR-DE-15", reported,
                          "workspace copy's own finding missing:\n"
                          + proc.stdout)
            self.assertNotIn(
                "BR-DE-2", reported,
                "SHADOWED: the runner reported the PACKAGE root's "
                "examples/01-missing-fields/broken.xml, not the workspace's:\n"
                + proc.stdout)
            self.assertTrue(os.path.isfile(os.path.join(ws, "out.sarif")))

    def test_cwd_is_restored_after_a_workspace_run(self):
        # The `finally` in run_runner_in_workspace is load-bearing: a leaked cwd
        # would silently break every later test in this process.
        before = os.getcwd()
        with tempfile.TemporaryDirectory() as tmp:
            run_runner_in_workspace(tmp, ["--path", ".",
                                          "--sarif-file", "out.sarif"])
        self.assertEqual(os.getcwd(), before)


# ---------------------------------------------------------------------------
# T-VHACT.3 — SARIF artifact URIs must be workspace-relative.
#
# GitHub code scanning resolves every result location against the ROOT OF THE
# CHECKED-OUT REPOSITORY. An absolute runner path
# (`/home/runner/work/repo/repo/invoices/bad.xml`) matches no tracked file, so
# `upload-sarif` returns success and renders ZERO inline annotations — the
# Action's one headline promise silently produces nothing. The runner therefore
# rewrites each artifactLocation to the workspace-relative path and anchors it
# to a `%SRCROOT%` uriBaseId declared in runs[0].originalUriBaseIds.
#
# Every expected path below is DERIVED from the fixture layout with relpath —
# never a hard-coded `/tmp/...` string, which would only test the test.
# ---------------------------------------------------------------------------


def artifact_locations(doc):
    """Every ``artifactLocation`` mapping in a SARIF document, in order."""
    out = []
    for run in doc.get("runs", []):
        for res in run.get("results", []):
            locs = list(res.get("locations") or [])
            locs += list(res.get("relatedLocations") or [])
            for loc in locs:
                art = (loc.get("physicalLocation") or {}).get("artifactLocation")
                if isinstance(art, dict):
                    out.append(art)
    return out


def result_signature(doc):
    """``(ruleId, level)`` per result, in document order — the merge invariant.

    Compared against the engine's OWN per-file SARIF to prove the URI rewrite
    drops, reorders, relabels and synthesises nothing.
    """
    return [(r.get("ruleId"), r.get("level"))
            for run in doc.get("runs", []) for r in run.get("results", [])]


def engine_sarif(invoice):
    """The unmodified engine's SARIF for one invoice — the comparison baseline."""
    env = dict(os.environ)
    env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.run(
        [sys.executable, "-m", "einvoice.report", "--profile", "xrechnung",
         "--format", "sarif", os.path.abspath(invoice)],
        cwd=HERE, env=env, capture_output=True, text=True, timeout=120)
    assert proc.returncode in (0, 1, 3), proc.stderr
    return json.loads(proc.stdout)


class SarifWorkspaceUris(unittest.TestCase):
    """(T-VHACT.3) artifact URIs are workspace-relative with a declared base id."""

    def _workspace_with_invoice(self, tmp):
        """-> ``(ws, invoice_dir, invoice_path)`` for a realistic checkout."""
        ws = os.path.realpath(tmp)
        self.assertFalse(
            ws == os.path.realpath(HERE)
            or ws.startswith(os.path.realpath(HERE) + os.sep),
            "workspace fixture must live outside the package root")
        invoice = os.path.join(ws, "invoices", "broken.xml")
        _write_workspace_invoice(invoice)
        return ws, os.path.join(ws, "invoices"), invoice

    def _read(self, sarif):
        self.assertTrue(os.path.isfile(sarif), "SARIF not written: " + sarif)
        with open(sarif, encoding="utf-8") as fh:
            return json.load(fh)

    def _assert_no_dotdot(self, doc):
        for art in artifact_locations(doc):
            self.assertNotIn(
                "..", art["uri"].split("/"),
                "a '..' escape in a code-scanning upload is worse than an "
                "absolute path: " + art["uri"])

    def test_absolute_path_inside_workspace_is_rewritten_relative(self):
        """(a) An ABSOLUTE --path under $GITHUB_WORKSPACE -> relative URI.

        The cwd is deliberately NOT the workspace here, so this also proves the
        runner anchors on $GITHUB_WORKSPACE rather than on wherever it happens
        to be invoked from.
        """
        with tempfile.TemporaryDirectory() as tmp:
            ws, invoice_dir, invoice = self._workspace_with_invoice(tmp)
            sarif = os.path.join(ws, "abs.sarif")
            proc = run_runner_in_workspace(
                tempfile.gettempdir(),
                ["--path", invoice_dir, "--format", "sarif",
                 "--sarif-file", sarif],
                github_workspace=ws)
            self.assertEqual(proc.returncode, 1,
                             proc.stdout[-2000:] + proc.stderr)
            doc = self._read(sarif)

        expected = os.path.relpath(invoice, ws).replace(os.sep, "/")
        self.assertEqual(expected, "invoices/broken.xml",
                         "fixture layout drifted")
        arts = artifact_locations(doc)
        self.assertTrue(arts, "no artifact locations in the merged SARIF")
        for art in arts:
            self.assertEqual(art["uri"], expected,
                             "absolute runner path leaked into the SARIF; "
                             "GitHub would render zero annotations")
            # (4) every rewritten location carries the base id ...
            self.assertEqual(art.get("uriBaseId"), RUNNER_MOD.SRCROOT_ID)
        self._assert_no_dotdot(doc)

        # ... and the run DECLARES that id, pointing at the absolute workspace.
        bases = doc["runs"][0].get("originalUriBaseIds")
        self.assertIsInstance(bases, dict,
                              "runs[0].originalUriBaseIds is missing: %r"
                              % list(doc["runs"][0]))
        self.assertIn(RUNNER_MOD.SRCROOT_ID, bases,
                      "uriBaseId used by results is not declared: %r" % bases)
        base_uri = bases[RUNNER_MOD.SRCROOT_ID]["uri"]
        self.assertTrue(base_uri.startswith("file:///"), base_uri)
        self.assertTrue(base_uri.endswith("/"),
                        "a uriBaseId denotes a DIRECTORY: " + base_uri)
        # The absolute form is recoverable: base + relative == the real file.
        self.assertEqual(
            urllib.parse.unquote(base_uri[len("file://"):] + expected),
            invoice)

    def test_relative_path_route_still_yields_the_same_relative_uri(self):
        """(b) REGRESSION: `--path invoices/` from the workspace cwd."""
        with tempfile.TemporaryDirectory() as tmp:
            ws, _, invoice = self._workspace_with_invoice(tmp)
            sarif = os.path.join(ws, "rel.sarif")
            proc = run_runner_in_workspace(
                ws, ["--path", "invoices/", "--format", "github",
                     "--sarif-file", sarif],
                github_workspace=ws)
            combined = proc.stdout + proc.stderr
            self.assertNotIn("no such file", combined, combined)
            self.assertEqual(proc.returncode, 1, combined)
            doc = self._read(sarif)
            stdout = proc.stdout

        expected = os.path.relpath(invoice, ws).replace(os.sep, "/")
        arts = artifact_locations(doc)
        self.assertTrue(arts)
        for art in arts:
            self.assertEqual(art["uri"], expected)
            self.assertEqual(art.get("uriBaseId"), RUNNER_MOD.SRCROOT_ID)
        self._assert_no_dotdot(doc)

        # (8) the JOB LOG is untouched by this task: it still shows the user's
        # own spelling, and no runner-absolute path leaks into an annotation.
        files = {props.get("file") for _, props, _ in parse_annotations(stdout)}
        self.assertEqual(files, {expected}, stdout)
        self.assertNotIn(ws, stdout,
                         "runner-absolute path leaked into the job log")

    def test_file_outside_the_workspace_keeps_its_absolute_uri(self):
        """(c) OUTSIDE the workspace: absolute URI, no base id, no '..'."""
        with tempfile.TemporaryDirectory() as ws_tmp, \
                tempfile.TemporaryDirectory() as out_tmp:
            ws = os.path.realpath(ws_tmp)
            outside = os.path.join(os.path.realpath(out_tmp), "outside.xml")
            _write_workspace_invoice(outside)
            sarif = os.path.join(ws, "outside.sarif")
            proc = run_runner_in_workspace(
                ws, ["--path", outside, "--format", "sarif",
                     "--sarif-file", sarif],
                github_workspace=ws)
            self.assertEqual(proc.returncode, 1,
                             proc.stdout[-2000:] + proc.stderr)
            doc = self._read(sarif)

        arts = artifact_locations(doc)
        self.assertTrue(arts, "no artifact locations for the outside file")
        for art in arts:
            self.assertEqual(art["uri"], outside.replace(os.sep, "/"),
                             "the absolute URI must be left unchanged")
            self.assertNotIn("uriBaseId", art,
                             "an absolute URI must not claim a base id it is "
                             "not relative to")
        self._assert_no_dotdot(doc)

    def test_sibling_prefix_directory_is_not_treated_as_inside(self):
        """Containment is a COMPONENT test, not a string ``startswith``.

        ``/tmp/x/ws-other/f.xml`` shares the textual prefix of ``/tmp/x/ws`` but
        is a SIBLING, not a child. A naive prefix test would emit the nonsense
        relative URI ``-other/f.xml``.
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.realpath(tmp)
            ws = os.path.join(root, "ws")
            sibling = os.path.join(root, "ws-other")
            os.makedirs(ws)
            invoice = os.path.join(sibling, "broken.xml")
            _write_workspace_invoice(invoice)
            sarif = os.path.join(ws, "sibling.sarif")
            proc = run_runner_in_workspace(
                ws, ["--path", invoice, "--format", "sarif",
                     "--sarif-file", sarif],
                github_workspace=ws)
            self.assertEqual(proc.returncode, 1,
                             proc.stdout[-2000:] + proc.stderr)
            doc = self._read(sarif)
            expected_abs = invoice.replace(os.sep, "/")

        for art in artifact_locations(doc):
            self.assertEqual(art["uri"], expected_abs)
            self.assertNotIn("uriBaseId", art)
        self._assert_no_dotdot(doc)

    def test_rewrite_preserves_result_count_and_rule_union(self):
        """(d) The URI rewrite changes URIs and NOTHING else.

        Baseline = the unmodified engine's own SARIF for the same file. The
        merged document must carry the identical results in the identical order
        with the identical levels, and the identical driver-rule id union.
        """
        with tempfile.TemporaryDirectory() as tmp:
            ws, invoice_dir, invoice = self._workspace_with_invoice(tmp)
            sarif = os.path.join(ws, "invariant.sarif")
            run_runner_in_workspace(
                tempfile.gettempdir(),
                ["--path", invoice_dir, "--format", "sarif",
                 "--sarif-file", sarif],
                github_workspace=ws)
            doc = self._read(sarif)
            baseline = engine_sarif(invoice)

        self.assertEqual(doc["version"], "2.1.0")
        self.assertEqual(doc["runs"][0]["tool"]["driver"]["name"], "einvoice")
        self.assertEqual(result_signature(doc), result_signature(baseline),
                         "the rewrite dropped, reordered or relabelled a "
                         "result")
        self.assertGreaterEqual(len(result_signature(doc)), 1,
                                "baseline fixture stopped producing findings")

        def rule_ids(d):
            return {r["id"]
                    for run in d.get("runs", [])
                    for r in run["tool"]["driver"].get("rules", [])}

        self.assertEqual(rule_ids(doc), rule_ids(baseline),
                         "the driver rule union changed")
        # No orphan results: every ruleId is still a declared driver rule.
        for rid, _ in result_signature(doc):
            self.assertIn(rid, rule_ids(doc))


if __name__ == "__main__":
    unittest.main()

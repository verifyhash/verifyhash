#!/usr/bin/env python3
"""test_packaging.py — prove the T-79.4 packaging/distribution claims.

What is actually asserted (each maps to a README/pyproject claim):

  1. ENTRY POINTS: `python3 -m einvoice`, the source-checkout `einvoice.py`
     wrapper, and the console-script target `einvoice.cli:main` are the SAME
     working CLI (exit codes 0/1/2 exercised for real, rule ID named on fail).
  2. PACKAGING METADATA: pyproject.toml declares ZERO runtime dependencies,
     the `einvoice = einvoice.cli:main` console script, and a version that
     matches `einvoice.__version__` (no drift).
  3. EMBEDDABILITY: the bare `einvoice/` package directory, copied ALONE into
     an empty directory (no corpus, no repo, no pyproject), still validates a
     real invoice — i.e. an ERP can vendor just the package, stdlib only.
  4. CI GATE: ci/validate-invoices.sh fails a build on a non-conformant
     invoice NAMING the violated rule ID, passes conformant ones, and refuses
     to green an empty input set.
  5. (env-guarded) a wheel actually builds via pip and contains the package +
     the console-script entry point — skipped when setuptools < 61.
  6. SHIPPED WEB BUNDLE: the committed `www/validate/engine/` bundle — the
     engine the zero-install browser validator at /einvoice/validate/ actually
     runs — is byte-identical to the packaged engine and its manifest sha256
     map is current. This is a DISTRIBUTION claim like the others: the browser
     bundle is a shipped copy of the package, and a stale copy means a
     prospect evaluates a product we no longer sell. Asserted by DELEGATION to
     `test_web_bundle.check_web_bundle()` — that guard owns the definition of
     "fresh"; this file owns only the fact that a registered gate runs it.
     (T-VHWEB.4: the bundle sat ~15 commits stale, 6c4dd18..9ed0b74, because
     test_web_bundle.py was not registered anywhere. Now it cannot be.)

Standard library only. Runs offline.
"""

import contextlib
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

PKG_DIR = os.path.join(HERE, "einvoice")
WRAPPER = os.path.join(HERE, "einvoice.py")
PYPROJECT = os.path.join(HERE, "pyproject.toml")
GATE = os.path.join(HERE, "ci", "validate-invoices.sh")
BASE = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test",
                    "business-cases", "standard", "01.01a-INVOICE_ubl.xml")


def run(cmd, **kw):
    kw.setdefault("capture_output", True)
    kw.setdefault("text", True)
    kw.setdefault("timeout", 120)
    return subprocess.run(cmd, **kw)


def make_bad_invoice(dest):
    """Copy BASE with its BuyerReference removed -> violates BR-DE-15 (fatal)."""
    with open(BASE, encoding="utf-8") as fh:
        src = fh.read()
    bad = re.sub(r"<cbc:BuyerReference>[^<]*</cbc:BuyerReference>", "", src,
                 count=1)
    assert bad != src, "fixture drift: BASE lost its BuyerReference"
    with open(dest, "w", encoding="utf-8") as fh:
        fh.write(bad)


class EntryPoints(unittest.TestCase):
    """One CLI, three doors: -m, source wrapper, console-script target."""

    def test_python_dash_m_passes_valid_invoice(self):
        proc = run([sys.executable, "-m", "einvoice", "validate", BASE,
                    "--profile=xrechnung"], cwd=HERE)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("PASS", proc.stdout)

    def test_python_dash_m_fails_bad_invoice_naming_rule_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            proc = run([sys.executable, "-m", "einvoice", "validate", bad,
                        "--profile=xrechnung"], cwd=HERE)
            self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
            self.assertIn("BR-DE-15", proc.stdout)

    def test_python_dash_m_usage_error(self):
        proc = run([sys.executable, "-m", "einvoice"], cwd=HERE)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("usage:", proc.stderr)

    def test_source_wrapper_same_behaviour(self):
        # From an UNRELATED cwd, to prove the wrapper's sys.path shim works.
        with tempfile.TemporaryDirectory() as tmp:
            proc = run([sys.executable, WRAPPER, "validate", BASE,
                        "--profile=xrechnung"], cwd=tmp)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("PASS", proc.stdout)

    def test_console_script_target_importable_and_runs_in_process(self):
        # The exact target named in pyproject [project.scripts].
        from einvoice.cli import main
        self.assertTrue(callable(main))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = main(["validate", BASE, "--profile=xrechnung"])
        self.assertEqual(code, 0)
        self.assertIn("PASS", out.getvalue())


class PackagingMetadata(unittest.TestCase):
    def setUp(self):
        with open(PYPROJECT, encoding="utf-8") as fh:
            self.text = fh.read()

    def test_zero_runtime_dependencies_declared(self):
        m = re.search(r"^dependencies\s*=\s*\[(.*?)\]", self.text,
                      re.M | re.S)
        self.assertIsNotNone(m, "pyproject.toml must declare `dependencies`")
        self.assertEqual(re.sub(r"\s|#.*", "", m.group(1)), "",
                         "runtime dependencies MUST stay empty (stdlib-only "
                         "is the product claim)")

    def test_console_script_points_at_real_entry(self):
        self.assertIn("[project.scripts]", self.text)
        m = re.search(r'^einvoice\s*=\s*"([^"]+)"', self.text, re.M)
        self.assertIsNotNone(m, "console script `einvoice` missing")
        self.assertEqual(m.group(1), "einvoice.cli:main")
        # …and the target genuinely exists (guards a rename breaking install).
        import einvoice.cli
        self.assertTrue(callable(einvoice.cli.main))

    def test_version_no_drift(self):
        import einvoice
        m = re.search(r'^version\s*=\s*"([^"]+)"', self.text, re.M)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), einvoice.__version__)

    def test_description_scopes_the_100pct_claim(self):
        """The one-line package card (`pip show` / the live PyPI card) must
        state the ENGINE-DERIVED rule count and keep the SAME scope caveat
        README §2 + CORRECTNESS.md keep. A legally-forced compliance product
        must not imply full-standard conformance on metadata a buyer might
        read alone — and it must not UNDERclaim either: the 0.1.0-era
        '50 of ~200 … not yet implemented' wording survived the 0.2.0 bump
        onto the live PyPI page, repelling the exact audience the engine
        already serves. Rule-count truth lives in
        coverage.engine_fireable_ids(); this guard (with the cross-file
        binding in test_docs_rule_claims.py, which covers action/README.md
        too) makes that staleness structurally impossible at future bumps."""
        m = re.search(r'^description\s*=\s*"([^"]+)"', self.text, re.M)
        self.assertIsNotNone(m, "pyproject.toml must declare a description")
        desc = m.group(1)
        low = desc.lower()
        # The claimed rule count is bound to the live engine registry — the
        # number is never folklore. (Same source of truth as the README /
        # CHANGELOG guards in test_docs_rule_claims.py.)
        from einvoice import coverage
        live = len(coverage.engine_fireable_ids())
        counts = [int(n) for n in
                  re.findall(r"\b(\d+)\s+business\s+rules\b", desc)]
        self.assertTrue(
            counts,
            "description must state the rule count as '<N> business rules' "
            "so this guard can bind it to engine_fireable_ids()")
        for n in counts:
            self.assertEqual(
                n, live,
                "description claims %d business rules but "
                "engine_fireable_ids() returns %d — update the description "
                "(metadata fix), never the engine" % (n, live))
        # Honest-scope caveat, same shape as README §2: scoped to the
        # implemented set, pointing at CORRECTNESS.md.
        self.assertIn("within the implemented set", low,
                      "description must scope its differential claim to the "
                      "implemented set, as README §2 does")
        self.assertIn("correctness.md", low,
                      "description must point at CORRECTNESS.md for the "
                      "honest remaining scope")
        # The stale 0.1.0-era phrasings must never come back.
        for stale in ("50 of ~200", "not yet implemented"):
            self.assertNotIn(stale, low,
                             "stale 0.1.0-era claim %r resurfaced in the "
                             "description" % stale)
        if "100%" in low:
            self.assertIn(
                "implemented", low,
                "a bare '100% agreement' claim on the metadata card is an "
                "overclaim; scope it to the implemented set")

    def test_only_the_package_ships(self):
        m = re.search(r'^packages\s*=\s*\[\s*"einvoice"\s*\]', self.text, re.M)
        self.assertIsNotNone(m, "wheel must contain ONLY the einvoice package "
                                "(never corpus/, ci/, tests)")


class Embeddability(unittest.TestCase):
    def test_bare_package_copy_validates_alone(self):
        """Copy ONLY einvoice/ (the package) into an empty dir; it must work
        with nothing else present — the vendor-embed scenario."""
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(PKG_DIR, os.path.join(tmp, "einvoice"),
                            ignore=shutil.ignore_patterns("__pycache__"))
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            code = ("import sys\n"
                    "from einvoice.cli import main\n"
                    "sys.exit(main(sys.argv[1:]))\n")
            # cwd=tmp puts the copied package first on sys.path; -E/-s keep
            # the interpreter from pulling anything from the outer env.
            ok = run([sys.executable, "-E", "-s", "-c", code, "validate",
                      BASE, "--profile=xrechnung"], cwd=tmp)
            self.assertEqual(ok.returncode, 0, ok.stderr)
            fail = run([sys.executable, "-E", "-s", "-c", code, "validate",
                        bad, "--profile=xrechnung"], cwd=tmp)
            self.assertEqual(fail.returncode, 1, fail.stdout + fail.stderr)
            self.assertIn("BR-DE-15", fail.stdout)


class CiGate(unittest.TestCase):
    """ci/validate-invoices.sh — the copy-paste build gate."""

    def gate(self, *args, env_extra=None):
        env = dict(os.environ)
        # Pin the REPORT entrypoint so the test exercises OUR tree, not a stray
        # pip-installed `einvoice` on PATH. The gate drives
        # `python3 -m einvoice.report --format junit`, so EINVOICE_CMD must
        # invoke that module (the legacy validate CLI would not understand
        # --format junit).
        env["EINVOICE_CMD"] = "%s -m einvoice.report" % sys.executable
        if env_extra:
            env.update(env_extra)
        return run(["sh", GATE] + list(args), env=env, cwd=HERE)

    def test_gate_passes_conformant_invoices(self):
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copy(BASE, os.path.join(tmp, "good.xml"))
            proc = self.gate(tmp)
            self.assertEqual(proc.returncode, 0,
                             proc.stdout + proc.stderr)
            self.assertIn("PASS", proc.stdout)

    def test_gate_fails_build_naming_rule_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copy(BASE, os.path.join(tmp, "good.xml"))
            make_bad_invoice(os.path.join(tmp, "bad.xml"))
            proc = self.gate(tmp)
            self.assertEqual(proc.returncode, 1,
                             proc.stdout + proc.stderr)
            self.assertIn("BR-DE-15", proc.stdout)      # the rule ID, named
            self.assertIn("NON-CONFORMANT", proc.stdout)
            self.assertIn("1/2", proc.stdout)           # and counted honestly

    def test_gate_fails_on_malformed_xml(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "broken.xml"), "w") as fh:
                fh.write("<Invoice><unclosed>")
            proc = self.gate(tmp)
            self.assertEqual(proc.returncode, 1,
                             proc.stdout + proc.stderr)
            # The report entrypoint renders a not-well-formed input as a
            # `not-well-formed` JUnit testcase (exit 3 per invoice -> the gate
            # counts it non-conformant and prints the label).
            self.assertIn("not well-formed", proc.stdout.lower())

    def test_gate_refuses_empty_input_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = self.gate(tmp)
            self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)

    def test_gate_allows_empty_only_when_opted_in(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = self.gate(tmp, env_extra={"EINVOICE_ALLOW_EMPTY": "1"})
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_gate_respects_profile_env(self):
        # bad.xml only violates the GERMAN layer; core-only profile passes it.
        with tempfile.TemporaryDirectory() as tmp:
            make_bad_invoice(os.path.join(tmp, "bad.xml"))
            proc = self.gate(tmp, env_extra={"EINVOICE_PROFILE": "en16931"})
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)


class WebBundleFreshness(unittest.TestCase):
    """Claim 6 — the shipped browser bundle is a CURRENT copy of the package.

    Pure delegation, on purpose. The byte-identity / manifest / self-
    containment / accepted-root-parity logic lives in exactly one place,
    `test_web_bundle.py`; duplicating any of it here would recreate the drift
    it guards against one level up. All this test contributes is REACHABILITY:
    test_packaging.py is a registered gate, test_web_bundle.py was not.
    """

    def test_shipped_web_bundle_matches_the_packaged_engine(self):
        # Imported lazily so test_web_bundle's module-level sys.path edits and
        # engine imports only happen when this claim actually runs.
        sys.path.insert(0, HERE)
        import test_web_bundle

        self.assertTrue(
            os.path.isdir(os.path.join(HERE, "www", "validate", "engine")),
            "www/validate/engine/ is missing — the browser validator has no "
            "engine to run")
        rc, report = test_web_bundle.check_web_bundle()
        self.assertEqual(
            rc, 0,
            "the committed www/validate/engine/ bundle is STALE or divergent "
            "from einvoice/ — regenerate it with `python3 gen_site.py` (never "
            "hand-edit a bundled file or manifest.json).\n" + report)


def _setuptools_can_pep621():
    try:
        import setuptools
        return int(setuptools.__version__.split(".")[0]) >= 61
    except Exception:
        return False


class WheelBuild(unittest.TestCase):
    @unittest.skipUnless(_setuptools_can_pep621(),
                         "needs setuptools>=61 (PEP 621) to build the wheel")
    def test_wheel_builds_offline_and_contains_entry_point(self):
        with tempfile.TemporaryDirectory() as tmp:
            # Build from a COPY of the source, never against the real tree.
            # pip 21.3+ does in-tree builds, so setuptools writes build/ and
            # *.egg-info/ NEXT TO pyproject.toml; pointing that at HERE would
            # leave build junk in the working tree (and none of it is
            # gitignored deeply enough to be safe from a `git add -A`). A
            # throwaway copy keeps "tests leave the tree clean" true by
            # construction, on every setuptools>=61 machine.
            src = os.path.join(tmp, "src")
            os.mkdir(src)
            shutil.copytree(PKG_DIR, os.path.join(src, "einvoice"),
                            ignore=shutil.ignore_patterns("__pycache__"))
            # pyproject.toml + the README it references are all the backend
            # needs (packages = ["einvoice"] is explicit; no corpus/tests).
            for f in ("pyproject.toml", "README.md"):
                shutil.copy(os.path.join(HERE, f), os.path.join(src, f))
            out = os.path.join(tmp, "wheels")
            os.mkdir(out)
            proc = run([sys.executable, "-m", "pip", "wheel",
                        "--no-build-isolation", "--no-deps", "--no-index",
                        "-w", out, src], timeout=300)
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            wheels = [f for f in os.listdir(out) if f.endswith(".whl")]
            self.assertEqual(len(wheels), 1, wheels)
            with zipfile.ZipFile(os.path.join(out, wheels[0])) as zf:
                names = zf.namelist()
                self.assertIn("einvoice/cli.py", names)
                self.assertNotIn("corpus", " ".join(names))
                ep = next(n for n in names if n.endswith("entry_points.txt"))
                self.assertIn("einvoice = einvoice.cli:main",
                              zf.read(ep).decode())


if __name__ == "__main__":
    unittest.main(verbosity=2)

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
        """The one-line package card (`pip show` / a future PyPI card) must
        keep the SAME scope caveat README + CORRECTNESS.md keep. A
        legally-forced compliance product must not imply full-standard
        conformance on metadata a buyer might read alone."""
        m = re.search(r'^description\s*=\s*"([^"]+)"', self.text, re.M)
        self.assertIsNotNone(m, "pyproject.toml must declare a description")
        desc = m.group(1).lower()
        self.assertIn("200", desc,
                      "description must show it is a slice of the ~200-rule "
                      "standard, not the whole standard")
        self.assertTrue(
            "subset" in desc or "not yet implemented" in desc,
            "description must qualify coverage to the implemented subset")
        if "100%" in desc:
            self.assertIn(
                "subset", desc,
                "a bare '100% agreement' claim on the metadata card is an "
                "overclaim; scope it to the implemented subset")

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
        # Pin the validator so the test exercises OUR tree, not a stray
        # pip-installed `einvoice` on PATH.
        env["EINVOICE_CMD"] = "%s %s" % (sys.executable, WRAPPER)
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
            self.assertIn("S-WF", proc.stdout)

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

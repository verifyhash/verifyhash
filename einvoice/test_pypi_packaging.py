#!/usr/bin/env python3
"""test_pypi_packaging.py — prove the PyPI staging packet (T-PYPI.1).

This is the *distribution-channel* companion to test_packaging.py. Where
test_packaging.py proves the CLI/vendor-embed claims, this file proves the
things a PyPI publish depends on, and it is deliberately TOOLCHAIN-AWARE so it
gives an HONEST green on a box that cannot build a PEP 621 wheel.

Two mutually-exclusive worlds, exactly one runs per box:

  * PEP 621 build backend PRESENT (setuptools>=61 or the `build` module):
      build the wheel into a temp dir, create a CLEAN venv, install FROM THE
      BUILT WHEEL (not the checkout), and assert the installed `einvoice`
      console script answers `--version`. This is the real end-to-end proof
      that the published artifact installs and runs.

  * PEP 621 build backend ABSENT (this box: setuptools 59.6.0, no `build`):
      a local wheel CANNOT be built without network (build isolation would
      have to fetch setuptools>=61). Rather than fail or fake it, assert the
      STAGED PARTIAL is correct — pyproject declares the right name, zero
      runtime deps and the console script, and einvoice/REPUBLISH-PYPI.md
      exists — and record that the wheel-from-venv assertion is
      DEFERRED-ON-TOOLCHAIN. This path EXITS 0: the deferral is an
      environment fact, not a product defect.

Standard library only. Runs fully offline (the name-availability GET is NOT
re-run here — its result is recorded in REPUBLISH-PYPI.md at staging time).
"""

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
PYPROJECT = os.path.join(HERE, "pyproject.toml")
PACKET = os.path.join(HERE, "REPUBLISH-PYPI.md")

DIST_NAME = "verifyhash-einvoice"


def run(cmd, **kw):
    kw.setdefault("capture_output", True)
    kw.setdefault("text", True)
    kw.setdefault("timeout", 300)
    return subprocess.run(cmd, **kw)


def _pep621_backend_available():
    """True iff a PEP 621 `[project]`-table wheel can be built locally.

    Either the standalone `build` frontend, or setuptools>=61 (the version
    that first understood the `[project]` table), is enough. Anything older
    would need a network fetch to bootstrap a newer setuptools, which is
    exactly the gap this task is staged around.
    """
    try:
        import setuptools
        if int(setuptools.__version__.split(".")[0]) >= 61:
            return True
    except Exception:
        pass
    try:
        import build
        # Guard against a stale local `build/` artifact directory (setuptools
        # leaves one next to pyproject.toml) shadowing the real `build`
        # frontend as an empty namespace package: that dir has neither
        # attribute, the genuine frontend has both.
        return hasattr(build, "ProjectBuilder") or hasattr(build, "__version__")
    except Exception:
        return False


class StagedMetadata(unittest.TestCase):
    """Runs on EVERY box: the publish-metadata contract PyPI depends on.

    These are the same invariants test_packaging.py guards for the wheel, but
    re-asserted here against the exact strings a PyPI upload will read, so the
    staging packet can never drift away from the code silently.
    """

    def setUp(self):
        with open(PYPROJECT, encoding="utf-8") as fh:
            self.text = fh.read()

    def test_distribution_name_is_verifyhash_einvoice(self):
        m = re.search(r'^name\s*=\s*"([^"]+)"', self.text, re.M)
        self.assertIsNotNone(m, "pyproject.toml must declare a project name")
        self.assertEqual(m.group(1), DIST_NAME,
                         "the PyPI distribution name must stay %r (the "
                         "recorded-available name in REPUBLISH-PYPI.md)"
                         % DIST_NAME)

    def test_zero_runtime_dependencies(self):
        m = re.search(r"^dependencies\s*=\s*\[(.*?)\]", self.text, re.M | re.S)
        self.assertIsNotNone(m, "pyproject.toml must declare `dependencies`")
        self.assertEqual(re.sub(r"\s|#.*", "", m.group(1)), "",
                         "the zero-dependency contract is the product — a "
                         "PyPI install must pull in NOTHING but stdlib")

    def test_console_script_target(self):
        self.assertIn("[project.scripts]", self.text)
        m = re.search(r'^einvoice\s*=\s*"([^"]+)"', self.text, re.M)
        self.assertIsNotNone(m, "console script `einvoice` missing")
        self.assertEqual(m.group(1), "einvoice.cli:main")
        import einvoice.cli
        self.assertTrue(callable(einvoice.cli.main),
                        "console-script target must be a real callable")

    def test_version_present_and_matches_package(self):
        import einvoice
        m = re.search(r'^version\s*=\s*"([^"]+)"', self.text, re.M)
        self.assertIsNotNone(m, "pyproject.toml must declare a version")
        self.assertEqual(m.group(1), einvoice.__version__,
                         "pyproject version must match einvoice.__version__ "
                         "(a mismatch ships a mislabelled sdist)")

    def test_republish_packet_exists_and_is_complete(self):
        self.assertTrue(os.path.isfile(PACKET),
                        "einvoice/REPUBLISH-PYPI.md must be committed as the "
                        "owner publish runbook")
        with open(PACKET, encoding="utf-8") as fh:
            doc = fh.read()
        # the exact publish tool sequence a human will paste
        self.assertRegex(doc, r"python3\s+-m\s+build",
                         "packet must give the exact `python3 -m build` step")
        self.assertRegex(doc, r"twine\s+upload",
                         "packet must give the exact `twine upload` step")
        # the recorded name-availability observation (name + result)
        self.assertIn(DIST_NAME, doc)
        self.assertRegex(
            doc, r"(?i)404|available",
            "packet must record the observed name-availability result")
        # post-publish verification in a clean venv
        self.assertRegex(
            doc, r"pip\s+install\s+" + re.escape(DIST_NAME),
            "packet must give the post-publish clean-venv install check")
        # token setup is a POINTER only — never an instruction to create one
        self.assertRegex(doc, r"(?i)token",
                         "packet must point at PyPI token setup for the owner")


@unittest.skipUnless(_pep621_backend_available(),
                     "PEP 621 build backend absent on this box — the real "
                     "wheel-from-venv proof is DEFERRED-ON-TOOLCHAIN; see "
                     "WheelFromVenvDeferred")
class WheelFromVenv(unittest.TestCase):
    """End-to-end: build the wheel, install it into a clean venv, run it.

    This is the assertion that the *published artifact* — not the source
    checkout — installs and exposes a working `einvoice` command. It only runs
    where a PEP 621 wheel can be built offline; elsewhere the deferred class
    below carries the honest partial.
    """

    def _build_wheel(self, tmp):
        # Build from a THROWAWAY copy so setuptools' build/ + *.egg-info land
        # outside the working tree (same hygiene rule as test_packaging.py).
        src = os.path.join(tmp, "src")
        os.mkdir(src)
        shutil.copytree(PKG_DIR, os.path.join(src, "einvoice"),
                        ignore=shutil.ignore_patterns("__pycache__"))
        for f in ("pyproject.toml", "README.md"):
            shutil.copy(os.path.join(HERE, f), os.path.join(src, f))
        out = os.path.join(tmp, "wheels")
        os.mkdir(out)
        proc = run([sys.executable, "-m", "pip", "wheel",
                    "--no-build-isolation", "--no-deps", "--no-index",
                    "-w", out, src])
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        wheels = [f for f in os.listdir(out) if f.endswith(".whl")]
        self.assertEqual(len(wheels), 1, wheels)
        return os.path.join(out, wheels[0])

    def test_wheel_installs_in_clean_venv_and_version_runs(self):
        import venv
        with tempfile.TemporaryDirectory() as tmp:
            wheel = self._build_wheel(tmp)

            # the built wheel really contains the package + console entry point
            with zipfile.ZipFile(wheel) as zf:
                names = zf.namelist()
                self.assertIn("einvoice/cli.py", names)
                self.assertNotIn("corpus", " ".join(names))

            # a genuinely clean venv, then install FROM THE WHEEL (offline)
            venv_dir = os.path.join(tmp, "venv")
            venv.create(venv_dir, with_pip=True)
            bindir = os.path.join(venv_dir,
                                  "Scripts" if os.name == "nt" else "bin")
            vpy = os.path.join(bindir, "python")
            inst = run([vpy, "-m", "pip", "install", "--no-index",
                        "--no-deps", wheel])
            self.assertEqual(inst.returncode, 0, inst.stdout + inst.stderr)

            # the installed console script answers --version
            exe = os.path.join(bindir,
                               "einvoice.exe" if os.name == "nt" else "einvoice")
            self.assertTrue(os.path.exists(exe),
                            "wheel install must place the `einvoice` script")
            ver = run([exe, "--version"])
            self.assertEqual(ver.returncode, 0, ver.stdout + ver.stderr)
            self.assertIn("einvoice", ver.stdout.lower())

            import einvoice
            self.assertIn(einvoice.__version__, ver.stdout)


@unittest.skipIf(_pep621_backend_available(),
                 "PEP 621 backend present — the real wheel-from-venv proof "
                 "runs in WheelFromVenv")
class WheelFromVenvDeferred(unittest.TestCase):
    """Toolchain-absent path (this box). NOT a failure: assert the staged
    partial is correct and record the deferral explicitly. Exits 0."""

    def test_staged_partial_holds_and_wheel_proof_is_deferred(self):
        # the wheel-from-venv proof genuinely cannot run here
        self.assertFalse(_pep621_backend_available())

        # …so the packet must be present and must itself acknowledge the gap
        self.assertTrue(os.path.isfile(PACKET),
                        "the deferral is only honest if the runbook exists")
        with open(PACKET, encoding="utf-8") as fh:
            doc = fh.read()
        self.assertRegex(
            doc, r"(?i)defer",
            "packet must state the wheel build is deferred on the toolchain")

        # and the staged metadata a future build depends on must be correct
        with open(PYPROJECT, encoding="utf-8") as fh:
            text = fh.read()
        self.assertRegex(text, r'(?m)^name\s*=\s*"%s"' % re.escape(DIST_NAME))
        deps = re.search(r"^dependencies\s*=\s*\[(.*?)\]", text, re.M | re.S)
        self.assertIsNotNone(deps)
        self.assertEqual(re.sub(r"\s|#.*", "", deps.group(1)), "")
        self.assertRegex(text, r'(?m)^einvoice\s*=\s*"einvoice\.cli:main"')

        sys.stderr.write(
            "\n[DEFERRED-ON-TOOLCHAIN] wheel-from-venv install proof skipped: "
            "no PEP 621 build backend (setuptools>=61 / `build`) on this box. "
            "Staged metadata + REPUBLISH-PYPI.md asserted instead.\n")


if __name__ == "__main__":
    unittest.main(verbosity=2)

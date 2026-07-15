#!/usr/bin/env python3
"""test_install.py — prove a real INSTALL of this package validates, not just imports.

The whole "integrability" tier (API.md, QUICKSTART.md, ci/ recipes, the batch
one-liner) rests on one unproven claim: an end user can install the
``verifyhash-einvoice`` distribution and get a WORKING validator — where
"working" means it actually *validates* invoices, not merely that ``import
einvoice`` succeeds.

The risk this test exists to catch
--------------------------------------
``pyproject.toml`` ships ONLY the pure-Python ``einvoice`` package
(``[tool.setuptools] packages = ["einvoice"]``, package-data = just
``py.typed``). It deliberately does NOT ship the multi-hundred-MB ``corpus/``,
nor the repo-root JSON catalogs (``remediation_catalog.json``,
``coverage_matrix.json``, ``syntax_binding_catalog.json``). Several package
modules DO compute a repo-root path (``os.path.dirname(os.path.dirname(
__file__))``) to read those catalogs. If the ``validate`` code path needed any
of them at runtime, a genuine install — where that repo tree is ABSENT from the
install location — would import fine but silently fail to validate. Copying the
package next to its repo (the way every other test runs) would never surface
that bug, because the repo tree is right there. This test removes the repo tree
from the picture and runs validation from OUTSIDE the checkout.

What it does
------------
In a throwaway dir under ``/tmp`` (removed in tearDownClass):

  1. Create a FRESH venv (``python3 -m venv --without-pip`` — a real, isolated
     interpreter; ``ensurepip``/network are not required and not used).
  2. INSTALL this package into that venv from the packaging config itself:
       * PREFERRED: build a wheel offline via ``pip wheel --no-build-isolation
         --no-deps --no-index`` and unpack it into the venv's site-packages
         (the same bytes an installer would lay down). Used whenever the local
         setuptools understands PEP 621 (>= 61) and produces a correctly-named
         wheel.
       * FALLBACK (recorded, not a silent skip): when the local setuptools is
         too old to emit PEP 621 metadata offline (it produces an empty
         ``UNKNOWN`` wheel), deterministically MATERIALIZE the exact wheel
         contract *parsed out of pyproject.toml* — the declared ``packages``,
         their declared ``package-data``, the ``[project.scripts]`` console
         entry point and the zero ``dependencies`` — into the venv, and assert
         that manifest. Either way the install location contains ONLY what the
         wheel would ship: the package + ``py.typed`` + a dist-info, and NO
         corpus, NO catalogs, NO repo.
  3. Assert the installed distribution pulled in ZERO third-party runtime deps
     (mirrors the ``dependencies = []`` contract of test_packaging.py, checked
     against the INSTALLED metadata).
  4. From a cwd that is NOT the repo root, run BOTH the ``einvoice`` console
     script (venv ``bin/``) AND ``<venv>/bin/python -m einvoice`` on a committed
     known-GOOD invoice (exit 0, PASS) and a committed known-BAD invoice
     (exit 1, >= 1 rule violation), asserting the exact documented exit codes
     and that a report is emitted on stdout.

Standard library only. Offline. Runnable directly: ``python3 test_install.py``.
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
PKG_DIR = os.path.join(HERE, "einvoice")
PYPROJECT = os.path.join(HERE, "pyproject.toml")

# Committed onboarding fixtures (also used by test_no_install.py). GOOD is a
# real, valid XRechnung; BAD is the same invoice with a required group removed.
GOOD_FIXTURE = os.path.join(HERE, "examples", "01-missing-fields", "fixed.xml")
BAD_FIXTURE = os.path.join(HERE, "examples", "01-missing-fields", "broken.xml")

# Documented CLI exit codes (einvoice/cli.py: EXIT_OK / EXIT_FAIL).
EXIT_OK = 0
EXIT_FAIL = 1

# Repo-root data the wheel must NOT ship; if any appears in the install
# location the "package only" packaging contract is broken.
FORBIDDEN_IN_INSTALL = (
    "corpus",
    "remediation_catalog.json",
    "coverage_matrix.json",
    "syntax_binding_catalog.json",
)


# --------------------------------------------------------------------------- #
# Minimal, dependency-free pyproject.toml reader (Python 3.8+ has no tomllib). #
# Only the few fields that define the wheel contract are parsed.              #
# --------------------------------------------------------------------------- #
def _table_body(text, header):
    """Return the raw lines of a TOML table ``[header]`` up to the next table."""
    lines = text.splitlines()
    out = []
    inside = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            if inside:
                break
            inside = stripped == "[%s]" % header
            continue
        if inside:
            out.append(line)
    return "\n".join(out)


def _quoted_list(blob):
    """All double-quoted strings inside a ``[ ... ]`` blob, in order."""
    return re.findall(r'"([^"]+)"', blob)


def parse_pyproject(text):
    """Extract the packaging contract from pyproject.toml as a dict.

    Keys: name, version, dependencies(list), packages(list),
    package_data(dict pkg -> [globs]), scripts(dict name -> "module:func").
    """
    project = _table_body(text, "project")
    name_m = re.search(r'^\s*name\s*=\s*"([^"]+)"', project, re.M)
    ver_m = re.search(r'^\s*version\s*=\s*"([^"]+)"', project, re.M)
    dep_m = re.search(r"^\s*dependencies\s*=\s*\[(.*?)\]", project, re.M | re.S)
    deps = _quoted_list(dep_m.group(1)) if dep_m else None

    setuptools_tbl = _table_body(text, "tool.setuptools")
    pkgs_m = re.search(r"packages\s*=\s*\[(.*?)\]", setuptools_tbl, re.S)
    packages = _quoted_list(pkgs_m.group(1)) if pkgs_m else []

    pdata_body = _table_body(text, "tool.setuptools.package-data")
    package_data = {}
    for line in pdata_body.splitlines():
        m = re.match(r'\s*([\w.]+|"[^"]+")\s*=\s*\[(.*)\]\s*$', line)
        if m:
            key = m.group(1).strip('"')
            package_data[key] = _quoted_list(m.group(2))

    scripts_body = _table_body(text, "project.scripts")
    scripts = {}
    for line in scripts_body.splitlines():
        m = re.match(r'\s*([\w.-]+)\s*=\s*"([^"]+)"', line)
        if m:
            scripts[m.group(1)] = m.group(2)

    return {
        "name": name_m.group(1) if name_m else None,
        "version": ver_m.group(1) if ver_m else None,
        "dependencies": deps,
        "packages": packages,
        "package_data": package_data,
        "scripts": scripts,
    }


def _dist_name(name):
    """PEP 503-ish normalization setuptools uses for the dist-info dir."""
    return re.sub(r"[-_.]+", "_", name).lower()


def _console_script_source(python_exe, target):
    """A faithful pip-style console-script wrapper for ``module:func``."""
    module, func = target.split(":")
    return (
        "#!%s\n"
        "# -*- coding: utf-8 -*-\n"
        "import re\n"
        "import sys\n"
        "from %s import %s\n"
        "if __name__ == '__main__':\n"
        "    sys.argv[0] = re.sub(r'(-script\\.pyw?|\\.exe)?$', '', sys.argv[0])\n"
        "    sys.exit(%s())\n" % (python_exe, module, func, func)
    )


class InstalledPackageValidates(unittest.TestCase):
    """Install the package for real, then prove it VALIDATES from outside the repo."""

    # ----- one expensive install shared by every test; cleaned in teardown --- #
    @classmethod
    def setUpClass(cls):
        with open(PYPROJECT, encoding="utf-8") as fh:
            cls.cfg = parse_pyproject(fh.read())

        cls.tmp = tempfile.mkdtemp(prefix="einvoice-install-",
                                   dir="/tmp" if os.path.isdir("/tmp") else None)
        # A run directory that is NOT the repo root, so the repo's own
        # ``einvoice/`` package can never shadow the installed one via sys.path.
        cls.rundir = os.path.join(cls.tmp, "run")
        os.makedirs(cls.rundir)

        cls.venv = os.path.join(cls.tmp, "venv")
        cls.py_exe, cls.site = cls._make_venv(cls.venv)
        cls.bin_dir = os.path.dirname(cls.py_exe)

        # Try a real offline wheel build first; fall back to a materialized
        # wheel contract if the local setuptools cannot emit PEP 621 metadata.
        cls.install_method = None
        cls.requires_dist = []
        cls.wheel_manifest = None
        if not cls._install_from_wheel():
            cls._install_materialized()

        cls.script = os.path.join(cls.bin_dir, "einvoice")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # ----- install plumbing --------------------------------------------------- #
    @classmethod
    def _make_venv(cls, path):
        """Create a fresh isolated venv; return (python_exe, site_packages).

        Uses ``--without-pip`` so no network / ensurepip is needed — we install
        by unpacking a wheel (or materializing the contract) ourselves, exactly
        as an installer lays bytes into site-packages.
        """
        subprocess.run([sys.executable, "-m", "venv", "--without-pip", path],
                       check=True, capture_output=True, text=True, timeout=120)
        py = os.path.join(path, "bin", "python")
        if not os.path.exists(py):  # non-posix layout guard
            py = os.path.join(path, "Scripts", "python.exe")
        out = subprocess.run(
            [py, "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
            check=True, capture_output=True, text=True, timeout=60)
        site = out.stdout.strip()
        os.makedirs(site, exist_ok=True)
        return py, site

    @classmethod
    def _build_wheel(cls):
        """Build a wheel offline from a COPY of the source. Returns wheel path
        or None if the toolchain can't produce a proper (non-UNKNOWN) wheel."""
        src = os.path.join(cls.tmp, "wheel-src")
        os.makedirs(src, exist_ok=True)
        for pkg in cls.cfg["packages"]:
            shutil.copytree(
                os.path.join(HERE, *pkg.split(".")),
                os.path.join(src, *pkg.split(".")),
                ignore=shutil.ignore_patterns("__pycache__"))
        for f in ("pyproject.toml", "README.md"):
            shutil.copy(os.path.join(HERE, f), os.path.join(src, f))
        out = os.path.join(cls.tmp, "wheelhouse")
        os.makedirs(out, exist_ok=True)
        try:
            proc = subprocess.run(
                [sys.executable, "-m", "pip", "wheel", "--no-build-isolation",
                 "--no-deps", "--no-index", "-w", out, src],
                capture_output=True, text=True, timeout=300)
        except Exception:
            return None
        if proc.returncode != 0:
            return None
        wheels = [f for f in os.listdir(out) if f.endswith(".whl")]
        want = _dist_name(cls.cfg["name"])
        for w in wheels:
            if w.lower().startswith(want):
                return os.path.join(out, w)
        return None  # e.g. an "UNKNOWN-0.0.0" wheel from setuptools < 61

    @classmethod
    def _install_from_wheel(cls):
        wheel = cls._build_wheel()
        if wheel is None:
            return False
        with zipfile.ZipFile(wheel) as zf:
            names = zf.namelist()
            if "einvoice/cli.py" not in names:
                return False
            ep = next((n for n in names if n.endswith("entry_points.txt")), None)
            if not ep or "einvoice = einvoice.cli:main" not in zf.read(ep).decode():
                return False
            zf.extractall(cls.site)
            cls.wheel_manifest = names
            meta = next((n for n in names if n.endswith("/METADATA")), None)
            if meta:
                cls.requires_dist = re.findall(
                    r"^Requires-Dist:\s*(.+)$", zf.read(meta).decode(), re.M)
        cls._write_console_scripts()
        cls.install_method = "wheel"
        return True

    @classmethod
    def _install_materialized(cls):
        """Deterministically lay down EXACTLY the declared wheel contract."""
        for pkg in cls.cfg["packages"]:
            src = os.path.join(HERE, *pkg.split("."))
            dst = os.path.join(cls.site, *pkg.split("."))
            os.makedirs(dst, exist_ok=True)
            # setuptools ships every *.py module of a declared package ...
            for fn in os.listdir(src):
                if fn.endswith(".py"):
                    shutil.copy(os.path.join(src, fn), os.path.join(dst, fn))
            # ... plus ONLY the files named in package-data (here: py.typed).
            for glob_pat in cls.cfg["package_data"].get(pkg, []):
                cand = os.path.join(src, glob_pat)
                if os.path.isfile(cand):
                    shutil.copy(cand, os.path.join(dst, glob_pat))

        # Synthesize the dist-info an installer would write (zero Requires-Dist,
        # since dependencies == []).
        distdir = os.path.join(
            cls.site, "%s-%s.dist-info" % (_dist_name(cls.cfg["name"]),
                                           cls.cfg["version"]))
        os.makedirs(distdir, exist_ok=True)
        with open(os.path.join(distdir, "METADATA"), "w", encoding="utf-8") as fh:
            fh.write("Metadata-Version: 2.1\nName: %s\nVersion: %s\n"
                     % (cls.cfg["name"], cls.cfg["version"]))
        with open(os.path.join(distdir, "top_level.txt"), "w",
                  encoding="utf-8") as fh:
            fh.write("\n".join(p.split(".")[0] for p in cls.cfg["packages"]) + "\n")
        ep_lines = "[console_scripts]\n" + "".join(
            "%s = %s\n" % (n, t) for n, t in cls.cfg["scripts"].items())
        with open(os.path.join(distdir, "entry_points.txt"), "w",
                  encoding="utf-8") as fh:
            fh.write(ep_lines)
        with open(os.path.join(distdir, "RECORD"), "w", encoding="utf-8") as fh:
            fh.write("")  # unsigned RECORD; not consulted at runtime
        cls.requires_dist = []
        cls._write_console_scripts()
        cls.install_method = "materialized"

    @classmethod
    def _write_console_scripts(cls):
        for name, target in cls.cfg["scripts"].items():
            path = os.path.join(cls.bin_dir, name)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(_console_script_source(cls.py_exe, target))
            os.chmod(path, 0o755)

    # ----- helpers ------------------------------------------------------------ #
    def _run(self, argv):
        """Run ``argv`` from OUTSIDE the repo (cwd=rundir), scrubbing every
        install side-channel so only the venv install can satisfy the import."""
        env = {"HOME": os.environ.get("HOME", self.tmp),
               "PATH": os.environ.get("PATH", "/usr/bin:/bin")}
        return subprocess.run(argv, cwd=self.rundir, env=env,
                              capture_output=True, text=True, timeout=120)

    # ----- tests -------------------------------------------------------------- #
    def test_install_produced_a_working_layout(self):
        """The install exists, imports from the VENV (not the repo), and ships
        the package + py.typed — the minimum for a usable install."""
        self.assertIn(self.install_method, ("wheel", "materialized"))
        self.assertTrue(os.path.isfile(self.script),
                        "console script was not installed into the venv bin/")
        self.assertTrue(
            os.path.isfile(os.path.join(self.site, "einvoice", "cli.py")))
        self.assertTrue(
            os.path.isfile(os.path.join(self.site, "einvoice", "py.typed")),
            "declared package-data py.typed missing from the install")
        proc = self._run([self.py_exe, "-c",
                          "import einvoice, sys; sys.stdout.write(einvoice.__file__)"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(proc.stdout.startswith(self.site),
                        "installed einvoice must import from the venv, got %r"
                        % proc.stdout)

    def test_console_script_validates_good_and_bad_from_outside_repo(self):
        good = self._run([self.script, "validate", GOOD_FIXTURE,
                          "--profile=xrechnung"])
        self.assertEqual(good.returncode, EXIT_OK,
                         "known-good invoice must exit 0.\nout:%s\nerr:%s"
                         % (good.stdout, good.stderr))
        self.assertIn("PASS", good.stdout)
        self.assertNotIn("FAIL", good.stdout)

        bad = self._run([self.script, "validate", BAD_FIXTURE,
                         "--profile=xrechnung"])
        self.assertEqual(bad.returncode, EXIT_FAIL,
                         "known-bad invoice must exit 1.\nout:%s\nerr:%s"
                         % (bad.stdout, bad.stderr))
        self.assertIn("FAIL", bad.stdout)
        self.assertRegex(bad.stdout, r"\bBR-[A-Z0-9-]+\b",
                         "the failure report must name at least one violated rule")

    def test_python_dash_m_validates_good_and_bad_from_outside_repo(self):
        good = self._run([self.py_exe, "-m", "einvoice", "validate",
                          GOOD_FIXTURE, "--profile=xrechnung"])
        self.assertEqual(good.returncode, EXIT_OK,
                         "known-good invoice must exit 0.\nout:%s\nerr:%s"
                         % (good.stdout, good.stderr))
        self.assertIn("PASS", good.stdout)

        bad = self._run([self.py_exe, "-m", "einvoice", "validate",
                         BAD_FIXTURE, "--profile=xrechnung"])
        self.assertEqual(bad.returncode, EXIT_FAIL,
                         "known-bad invoice must exit 1.\nout:%s\nerr:%s"
                         % (bad.stdout, bad.stderr))
        self.assertIn("FAIL", bad.stdout)
        self.assertRegex(bad.stdout, r"\bBR-[A-Z0-9-]+\b")

    def test_version_flag_works_from_the_install(self):
        proc = self._run([self.py_exe, "-m", "einvoice", "--version"])
        self.assertEqual(proc.returncode, EXIT_OK, proc.stderr)
        self.assertRegex(proc.stdout, r"einvoice \d+\.\d+\.\d+")

    def test_zero_third_party_runtime_dependencies_installed(self):
        # (a) the source contract: dependencies == [] in pyproject.
        self.assertEqual(self.cfg["dependencies"], [],
                         "pyproject.toml must declare zero runtime dependencies")
        # (b) the INSTALLED metadata carries no Requires-Dist.
        self.assertEqual(self.requires_dist, [],
                         "installed distribution pulled in third-party deps: %r"
                         % self.requires_dist)
        # (c) nothing but the one package (+ its dist-info) landed in the venv.
        entries = [e for e in os.listdir(self.site)
                   if not e.startswith("_") and e != "pip"]
        pkgs = sorted(e for e in entries if not e.endswith(".dist-info")
                      and not e.endswith(".txt") and not e.endswith(".pth"))
        self.assertEqual(pkgs, ["einvoice"],
                         "unexpected top-level packages installed: %r" % pkgs)

    def test_install_ships_no_corpus_or_catalogs(self):
        """The install location must contain the package ONLY — never the
        multi-hundred-MB corpus or the repo-root JSON catalogs. That the
        validation tests above still pass proves validate() needs none of it."""
        present = set()
        for root, _dirs, files in os.walk(self.site):
            for f in files:
                present.add(os.path.relpath(os.path.join(root, f), self.site))
        blob = "\n".join(present)
        for forbidden in FORBIDDEN_IN_INSTALL:
            self.assertNotIn(forbidden, blob,
                             "install must not ship %r" % forbidden)
        if self.wheel_manifest is not None:  # real wheel was built
            self.assertNotIn("corpus", " ".join(self.wheel_manifest))
            self.assertIn("einvoice/cli.py", self.wheel_manifest)


if __name__ == "__main__":
    unittest.main(verbosity=2)

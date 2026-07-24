#!/usr/bin/env python3
"""test_wheel_self_report.py — pin what the INSTALLED WHEEL self-reports
(T-VHPROOF.3).

The other packaging tests (``test_packaging.py`` / ``test_pypi_packaging.py``)
grep the pyproject STRINGS; none of them exercises the actual self-report of the
artifact a `pip install verifyhash-einvoice` puts on disk. That artifact ships
ONLY the `einvoice/` package (packages=["einvoice"]) plus the declared
package-data (`py.typed`, `attestation.json`) — the source-tree
`coverage_matrix.json` / `cii_parity.json` / `syntax_binding_catalog.json` and
the top-level `attestation.json` are deliberately NOT in the wheel. Before
T-VHPROOF.3 the info/capabilities self-report resolved every artifact-sourced
field from the source tree, so from a wheel it reported `rule_count: None`,
`ubl.proven: 0`, `attestation_sha256: None` — the installed artifact lied about
itself while the PyPI page advertised '297 business rules'.

This test reconstructs a wheel-ONLY install image straight from the pyproject
`packages` + `package-data` declarations (STDLIB ONLY, no network, no build
backend — it does NOT reimplement pip/build; it copies exactly the declared
package modules + package-data globs and nothing else), then runs
`einvoice.capabilities()` in a subprocess whose import root is that image and
asserts the installed artifact self-reports its real numbers:

  * rule_count == 297,
  * coverage.syntax_binding.ubl.proven == 741,
  * attestation_sha256 is non-None AND equals the SHA-256 the packaged
    attestation is bound by — independently recomputed here from the packaged
    attestation body (the canonical serialization `gen_attestation.py` hashes),
    and cross-checked against the `content_sha256` the file carries.

It FAILS on the pre-change source-tree-only resolution (None/0) and PASSES once
`_info_payload` falls back to the packaged attestation.
"""

from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PYPROJECT = os.path.join(HERE, "pyproject.toml")


def _parse_list_literal(text, name):
    """Extract a top-level ``<name> = [ ... ]`` list literal from TOML text.

    Deliberately dumb (no tomllib — this must run stdlib-only on 3.10): find the
    assignment and ``ast.literal_eval`` the bracketed list (TOML string/array
    syntax for these declarations is a subset of Python literal syntax).
    """
    m = re.search(r"(?m)^\s*%s\s*=\s*(\[.*?\])" % re.escape(name), text, re.S)
    if not m:
        raise AssertionError("could not find `%s = [...]` in pyproject" % name)
    return ast.literal_eval(m.group(1))


def _parse_package_data(text):
    """Parse the ``[tool.setuptools.package-data]`` table into ``{pkg: [glob]}``.

    Takes the lines from that section header up to the next ``[`` table header
    and ``ast.literal_eval``s each ``pkg = [...]`` assignment. Comments (``#``)
    are ignored. Dumb by design — enough to read this project's declaration.
    """
    section = re.search(
        r"(?ms)^\[tool\.setuptools\.package-data\]\s*\n(.*?)(?=^\[|\Z)", text)
    if not section:
        return {}
    out = {}
    for m in re.finditer(r"(?m)^\s*([A-Za-z0-9_.\-]+)\s*=\s*(\[[^\]]*\])",
                         section.group(1)):
        out[m.group(1)] = ast.literal_eval(m.group(2))
    return out


def build_install_image(dest):
    """Copy EXACTLY the wheel-declared files (packages + package-data) into
    ``dest``, reproducing a `pip install` layout without invoking any build
    backend. Returns ``dest``.

    For each package in ``[tool.setuptools] packages`` we copy the package dir's
    top-level ``*.py`` modules (what packages=[pkg] ships) plus each glob in
    ``[tool.setuptools.package-data]`` for that package — and NOTHING else. The
    source-tree conformance artifacts live OUTSIDE the package dir and are not in
    package-data, so they are intentionally excluded: that absence is the whole
    point of the test.
    """
    with open(PYPROJECT, encoding="utf-8") as fh:
        text = fh.read()
    packages = _parse_list_literal(text, "packages")
    package_data = _parse_package_data(text)
    assert packages == ["einvoice"], (
        "test assumes a single `einvoice` package; got %r" % (packages,))

    for pkg in packages:
        src_dir = os.path.join(HERE, pkg)
        dst_dir = os.path.join(dest, pkg)
        os.makedirs(dst_dir, exist_ok=True)
        # The pure-Python modules packages=[pkg] ships (top-level *.py only —
        # einvoice has no sub-packages).
        for entry in sorted(os.listdir(src_dir)):
            if entry.endswith(".py"):
                shutil.copy2(os.path.join(src_dir, entry),
                             os.path.join(dst_dir, entry))
        # The declared package-data globs (py.typed, attestation.json).
        import glob as _glob
        for pattern in package_data.get(pkg, []):
            for match in _glob.glob(os.path.join(src_dir, pattern)):
                shutil.copy2(match, os.path.join(dst_dir, os.path.basename(match)))
    return dest


class WheelSelfReport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="einvoice-wheel-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.image = build_install_image(self.tmp)

    def _run_capabilities(self):
        """Run einvoice.capabilities() with the install image as the import root
        and return the parsed payload."""
        code = "import json, einvoice; print(json.dumps(einvoice.capabilities()))"
        env = dict(os.environ)
        env["PYTHONPATH"] = self.image
        proc = subprocess.run(
            [sys.executable, "-c", code],
            cwd=self.image,          # sys.path[0]=='' -> the image, not the checkout
            env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        self.assertEqual(proc.returncode, 0,
                         "capabilities() crashed on the wheel image:\n" + proc.stderr)
        return json.loads(proc.stdout)

    def _expected_attestation_hash(self):
        """The SHA-256 the packaged attestation is bound by, recomputed
        INDEPENDENTLY from the packaged attestation body — the canonical
        serialization gen_attestation.py hashes into ``content_sha256``."""
        att_path = os.path.join(self.image, "einvoice", "attestation.json")
        with open(att_path, encoding="utf-8") as fh:
            att = json.load(fh)
        body = att["attestation"]
        canonical = json.dumps(body, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        # The packaged file must be internally consistent with the hash it
        # carries; if not, the wheel's trust proof is broken.
        self.assertEqual(att["content_sha256"], digest,
                         "packaged attestation content_sha256 does not match its body")
        return digest

    def test_image_excludes_source_artifacts(self):
        """The reconstructed wheel image must NOT carry the source-tree
        conformance artifacts — otherwise the test would not exercise the
        wheel-only path."""
        pkg = os.path.join(self.image, "einvoice")
        for absent in ("coverage_matrix.json", "cii_parity.json",
                       "syntax_binding_catalog.json"):
            self.assertFalse(os.path.exists(os.path.join(pkg, absent)),
                             "%s must not be shipped in the wheel" % absent)
            self.assertFalse(os.path.exists(os.path.join(self.image, absent)),
                             "%s must not sit next to the package" % absent)
        # But the package-data attestation IS shipped.
        self.assertTrue(os.path.exists(os.path.join(pkg, "attestation.json")))

    def test_rule_count_297(self):
        payload = self._run_capabilities()
        self.assertEqual(payload["rule_count"], 297)
        self.assertEqual(
            payload["coverage"]["business_rules"]["total_asserted"], 297)

    def test_ubl_proven_741(self):
        payload = self._run_capabilities()
        self.assertEqual(
            payload["coverage"]["syntax_binding"]["ubl"]["proven"], 741)

    def test_attestation_sha256_non_none_and_matches(self):
        payload = self._run_capabilities()
        got = payload["attestation_sha256"]
        self.assertIsNotNone(got)
        self.assertEqual(got, self._expected_attestation_hash())


if __name__ == "__main__":
    unittest.main(verbosity=2)

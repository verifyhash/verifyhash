#!/usr/bin/env python3
"""Tests for the committed CycloneDX SBOM and its generator (stdlib only).

Asserts the SBOM's shape and — the load-bearing part — that its
zero-dependency claim cannot silently diverge from pyproject.toml. Two
independent sources (the committed `sbom/bom.json` and pyproject's
`dependencies` list) must agree that there are ZERO third-party runtime
dependencies.
"""
import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
BOM_PATH = HERE / "sbom" / "bom.json"
PYPROJECT = HERE / "pyproject.toml"
GEN = HERE / "gen_sbom.py"


def _pyproject_field_string(text, key):
    m = re.search(
        r'^\s*' + re.escape(key) + r'\s*=\s*"([^"]*)"', text, re.MULTILINE
    )
    return m.group(1) if m else None


def _pyproject_dependencies(text):
    """Parse [project].dependencies as a list of PEP 508 strings."""
    # Only look inside the [project] table so we never pick up
    # [build-system].requires.
    lines = text.splitlines()
    project_lines = []
    in_project = False
    for line in lines:
        stripped = line.strip()
        if re.match(r"^\[[^\[]", stripped):
            in_project = stripped == "[project]"
            continue
        if stripped.startswith("[["):
            in_project = False
            continue
        if in_project:
            project_lines.append(line)
    project = "\n".join(project_lines)
    m = re.search(
        r'^\s*dependencies\s*=\s*\[(.*?)\]',
        project,
        re.MULTILINE | re.DOTALL,
    )
    if not m:
        raise AssertionError("pyproject.toml must declare `dependencies`")
    body = re.sub(r"#.*", "", m.group(1))
    return re.findall(r'"([^"]*)"', body)


class SbomTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pyproject_text = PYPROJECT.read_text(encoding="utf-8")
        cls.sbom = json.loads(BOM_PATH.read_text(encoding="utf-8"))

    # (a) valid JSON with the right CycloneDX envelope
    def test_cyclonedx_envelope(self):
        self.assertEqual(self.sbom.get("bomFormat"), "CycloneDX")
        self.assertEqual(self.sbom.get("specVersion"), "1.5")

    # (b) root metadata.component names verifyhash-einvoice at the pyproject
    #     version, with a matching PURL
    def test_root_component(self):
        comp = self.sbom.get("metadata", {}).get("component", {})
        name = _pyproject_field_string(self.pyproject_text, "name")
        version = _pyproject_field_string(self.pyproject_text, "version")
        self.assertEqual(name, "verifyhash-einvoice")
        self.assertEqual(comp.get("type"), "library")
        self.assertEqual(comp.get("name"), "verifyhash-einvoice")
        self.assertEqual(comp.get("version"), version)
        self.assertEqual(
            comp.get("purl"),
            "pkg:pypi/verifyhash-einvoice@{}".format(version),
        )

    # (c) ZERO third-party runtime dependency components, CONSISTENT with
    #     pyproject dependencies == []
    def test_zero_dependencies_consistent(self):
        deps = _pyproject_dependencies(self.pyproject_text)
        self.assertEqual(
            deps, [], "pyproject runtime dependencies MUST stay empty"
        )
        # SBOM must reflect the same truth: no components, empty dependsOn.
        self.assertEqual(
            self.sbom.get("components"),
            [],
            "SBOM components MUST be empty (zero third-party deps)",
        )
        edges = self.sbom.get("dependencies", [])
        self.assertEqual(len(edges), 1, "one dependency edge: the root")
        root_purl = "pkg:pypi/verifyhash-einvoice@{}".format(
            _pyproject_field_string(self.pyproject_text, "version")
        )
        self.assertEqual(edges[0].get("ref"), root_purl)
        self.assertEqual(
            edges[0].get("dependsOn"),
            [],
            "root component MUST depend on nothing (zero runtime deps)",
        )
        # Cross-check: the two sources cannot silently diverge — the count of
        # third-party components equals the count of pyproject dependencies.
        self.assertEqual(len(self.sbom.get("components", [])), len(deps))

    # (d) --check passes against the committed file (no drift)
    def test_check_no_drift(self):
        result = subprocess.run(
            [sys.executable, str(GEN), "--check"],
            cwd=str(HERE),
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            result.returncode,
            0,
            "gen_sbom.py --check reported drift:\n{}{}".format(
                result.stdout, result.stderr
            ),
        )


if __name__ == "__main__":
    unittest.main()

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
CORPUS_ROOT = HERE / "corpus"

# The three upstream corpora the SBOM must enumerate, keyed by a stable
# substring of the component name that carries the upstream repo slug.
EXPECTED_CORPORA = {
    "eInvoicing-EN16931": "cen-en16931",
    "xrechnung-schematron": "xrechnung-schematron",
    "xrechnung-testsuite": "xrechnung-testsuite",
}
_SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")


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
    #     pyproject dependencies == []. Runtime deps would appear as
    #     `type: library` components AND dependsOn edges; the vendored rule
    #     corpora are `type: data` inventory entries and must NEVER count as
    #     runtime dependencies or enter the dependency graph.
    def test_zero_dependencies_consistent(self):
        deps = _pyproject_dependencies(self.pyproject_text)
        self.assertEqual(
            deps, [], "pyproject runtime dependencies MUST stay empty"
        )
        # SBOM must reflect the same truth: no runtime-dep (library)
        # components, and an empty dependsOn edge.
        library_components = [
            c
            for c in self.sbom.get("components", [])
            if c.get("type") == "library"
        ]
        self.assertEqual(
            library_components,
            [],
            "SBOM must carry ZERO type=library (runtime-dep) components",
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
        # runtime-dep (library) components equals the count of pyproject
        # dependencies. The `data` corpus components are inventory, not deps,
        # so they are excluded here (and never added to dependsOn above).
        self.assertEqual(len(library_components), len(deps))
        for c in self.sbom.get("components", []):
            if c.get("type") == "data":
                self.assertNotIn(
                    c.get("bom-ref"),
                    edges[0].get("dependsOn", []),
                    "data corpus components must not be runtime deps",
                )

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


class VendoredCorpusSbomTest(unittest.TestCase):
    """The SBOM must enumerate every vendored rule corpus with pinned
    provenance (name, version, SPDX license, upstream URL) and a content
    hash the drift guard can react to."""

    @classmethod
    def setUpClass(cls):
        cls.sbom = json.loads(BOM_PATH.read_text(encoding="utf-8"))
        cls.components = cls.sbom.get("components", [])

    def _corpus_components(self):
        """Map expected-slug -> its component dict (data components only)."""
        found = {}
        for c in self.components:
            if c.get("type") != "data":
                continue
            for slug in EXPECTED_CORPORA:
                if slug.lower() in str(c.get("name", "")).lower():
                    found[slug] = c
        return found

    # >=3 components, one per vendored corpus.
    def test_at_least_three_components(self):
        self.assertGreaterEqual(
            len(self.components),
            3,
            "SBOM must enumerate the >=3 vendored rule corpora",
        )

    # The three upstream slugs each appear as a named data component.
    def test_three_named_corpora_present(self):
        found = self._corpus_components()
        for slug in EXPECTED_CORPORA:
            self.assertIn(
                slug,
                found,
                "SBOM is missing the vendored corpus component: " + slug,
            )

    # Each corpus component carries a non-empty SHA-256 hash, an SPDX license,
    # a pinned version, and an externalReferences upstream URL.
    def test_each_corpus_has_hash_license_version_url(self):
        found = self._corpus_components()
        allowed_licenses = {"Apache-2.0", "EUPL-1.2"}
        for slug, comp in found.items():
            # SHA-256 hash, non-empty, well-formed hex.
            hashes = comp.get("hashes") or []
            self.assertTrue(hashes, slug + ": missing hashes")
            sha = [h for h in hashes if h.get("alg") == "SHA-256"]
            self.assertTrue(sha, slug + ": missing SHA-256 hash")
            content = sha[0].get("content", "")
            self.assertTrue(
                _SHA256_HEX.match(content),
                slug + ": SHA-256 content is not a 64-char hex digest",
            )
            # SPDX license id (exactly the PROVENANCE.md values).
            licenses = comp.get("licenses") or []
            self.assertTrue(licenses, slug + ": missing licenses")
            spdx = licenses[0].get("license", {}).get("id")
            self.assertIn(
                spdx,
                allowed_licenses,
                slug + ": license must be Apache-2.0 or EUPL-1.2",
            )
            # Pinned, non-empty version.
            self.assertTrue(
                comp.get("version"),
                slug + ": missing pinned version",
            )
            # externalReferences upstream URL.
            refs = comp.get("externalReferences") or []
            self.assertTrue(refs, slug + ": missing externalReferences")
            url = refs[0].get("url", "")
            self.assertTrue(
                url.startswith("https://github.com/"),
                slug + ": externalReferences URL must be the upstream repo",
            )

    # EN 16931 and XRechnung schematron carry the exact PROVENANCE.md pins.
    def test_specific_license_and_version_pins(self):
        found = self._corpus_components()
        self.assertEqual(
            found["xrechnung-schematron"].get("version"),
            "2.5.0",
            "XRechnung Schematron must be pinned to v2.5.0 per PROVENANCE.md",
        )
        self.assertEqual(
            found["xrechnung-schematron"]["licenses"][0]["license"]["id"],
            "Apache-2.0",
        )
        self.assertEqual(
            found["eInvoicing-EN16931"]["licenses"][0]["license"]["id"],
            "EUPL-1.2",
        )
        self.assertEqual(
            found["xrechnung-testsuite"]["licenses"][0]["license"]["id"],
            "Apache-2.0",
        )

    # Drift sensitivity: recomputing the corpus hash in-memory (independently,
    # from the tree on disk) must match the committed component hash — so any
    # change to a vendored file would break --check.
    def test_hash_matches_recomputed_tree(self):
        import gen_sbom

        found = self._corpus_components()
        for slug, sub_path in EXPECTED_CORPORA.items():
            comp = found[slug]
            committed = next(
                h["content"]
                for h in comp["hashes"]
                if h["alg"] == "SHA-256"
            )
            recomputed = gen_sbom.corpus_sha256(CORPUS_ROOT / sub_path)
            self.assertEqual(
                committed,
                recomputed,
                slug + ": committed corpus hash diverges from the on-disk "
                "tree — the drift guard would be blind",
            )
            # And it is genuinely content-sensitive: a one-byte perturbation
            # of the running hash yields a different digest (framing works).
            self.assertNotEqual(
                recomputed,
                gen_sbom.corpus_sha256(CORPUS_ROOT),
                slug + ": corpus hash is not path-scoped",
            )


if __name__ == "__main__":
    unittest.main()

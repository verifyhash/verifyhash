"""Drift guard for the embedded code lists — manifest vs live module.

Standard-library ``unittest`` only. No saxonche, no network, no pip.

``codelists_manifest.json`` (repo level, next to this file) records, for EVERY
public ``*_CODES`` frozenset exported by ``einvoice.codelists``, its official
list name, issuing body, source artifact, vendored corpus version, entry count,
and a sha256 over the sorted entries. This test recomputes count and sha256
from the LIVE module, so:

  * editing any list in code without updating the manifest -> red test;
  * adding a new exported ``*_CODES`` frozenset without a manifest entry
    -> red test (module is introspected, names are never hard-coded);
  * a manifest entry whose export vanished from the module -> red test;
  * "harmonizing" the two country lists (the vendored UBL Schematron carries
    SS but not AN; the vendored CII Schematron carries AN but not SS)
    -> red test, protecting the per-syntax BR-CL-14 bindings.

This is an audit-and-lock guard: it changes NO verdict and pins NO new values;
it only converts silent code-list drift into a visible failure.

Runs in well under a second.
"""

import hashlib
import json
import os
import unittest

from einvoice import codelists

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST_PATH = os.path.join(HERE, "codelists_manifest.json")

HASH_FIELD = "sha256_sorted_newline_joined"
REQUIRED_FIELDS = (
    "official_list",
    "issuing_body",
    "source",
    "version",
    "count",
    HASH_FIELD,
)


def _exported_code_sets():
    """Every public *_CODES frozenset the module exports, by introspection."""
    return {
        name: value
        for name in dir(codelists)
        if name.endswith("_CODES") and not name.startswith("_")
        for value in [getattr(codelists, name)]
        if isinstance(value, frozenset)
    }


def _recompute_sha256(entries):
    return hashlib.sha256(
        "\n".join(sorted(entries)).encode("utf-8")).hexdigest()


class TestManifestParses(unittest.TestCase):
    def test_manifest_exists_and_parses(self):
        self.assertTrue(os.path.isfile(MANIFEST_PATH),
                        "codelists_manifest.json missing at repo level")
        with open(MANIFEST_PATH, encoding="utf-8") as f:
            manifest = json.load(f)
        self.assertIsInstance(manifest, dict)


class TestManifestCoverage(unittest.TestCase):
    """The manifest and the module must cover each other EXACTLY."""

    @classmethod
    def setUpClass(cls):
        with open(MANIFEST_PATH, encoding="utf-8") as f:
            raw = json.load(f)
        cls.manifest = {k: v for k, v in raw.items() if not k.startswith("_")}
        cls.exports = _exported_code_sets()

    def test_module_exports_something(self):
        # Sanity: introspection found the lists at all (>= the 12 known today).
        self.assertGreaterEqual(len(self.exports), 12)

    def test_every_export_has_a_manifest_entry(self):
        missing = sorted(set(self.exports) - set(self.manifest))
        self.assertEqual(
            missing, [],
            "exported *_CODES frozensets with NO manifest entry (a new list "
            "must be recorded in codelists_manifest.json): %r" % missing)

    def test_every_manifest_entry_maps_to_a_live_export(self):
        stale = sorted(set(self.manifest) - set(self.exports))
        self.assertEqual(
            stale, [],
            "manifest entries whose export no longer exists: %r" % stale)


class TestManifestLocksValues(unittest.TestCase):
    """Recorded count + sha256 must equal what the live module actually holds."""

    @classmethod
    def setUpClass(cls):
        with open(MANIFEST_PATH, encoding="utf-8") as f:
            raw = json.load(f)
        cls.manifest = {k: v for k, v in raw.items() if not k.startswith("_")}
        cls.exports = _exported_code_sets()

    def test_counts_match_live_sets(self):
        for name, entry in sorted(self.manifest.items()):
            with self.subTest(list=name):
                self.assertIn(name, self.exports)
                self.assertEqual(
                    entry["count"], len(self.exports[name]),
                    "%s: manifest count %r != live len %d — list edited "
                    "without a manifest update?" % (
                        name, entry.get("count"), len(self.exports[name])))

    def test_sha256_matches_live_sets(self):
        for name, entry in sorted(self.manifest.items()):
            with self.subTest(list=name):
                self.assertIn(name, self.exports)
                live = _recompute_sha256(self.exports[name])
                self.assertEqual(
                    entry[HASH_FIELD], live,
                    "%s: manifest sha256 does not match the live set — the "
                    "code list changed without a manifest update (or vice "
                    "versa)" % name)

    def test_each_entry_declares_provenance(self):
        for name, entry in sorted(self.manifest.items()):
            with self.subTest(list=name):
                for field in REQUIRED_FIELDS:
                    self.assertIn(field, entry,
                                  "%s: missing field %r" % (name, field))
                for field in ("official_list", "issuing_body", "source",
                              "version"):
                    value = entry[field]
                    self.assertIsInstance(value, str)
                    self.assertTrue(
                        value.strip(),
                        "%s: field %r must be a non-empty string" % (
                            name, field))
                self.assertIsInstance(entry["count"], int)
                self.assertIsInstance(entry[HASH_FIELD], str)
                self.assertEqual(len(entry[HASH_FIELD]), 64)


class TestCountryListAsymmetry(unittest.TestCase):
    """The documented per-syntax BR-CL-14 asymmetry must hold.

    The vendored UBL Schematron's country list carries SS (South Sudan) but
    not AN; the vendored CII list carries AN (Netherlands Antilles, withdrawn)
    but not SS. A future "harmonization" of the two sets would silently break
    the per-syntax bindings — make it a red test instead.
    """

    def test_ubl_has_ss_not_an(self):
        self.assertIn("SS", codelists.UBL_COUNTRY_CODES)
        self.assertNotIn("AN", codelists.UBL_COUNTRY_CODES)

    def test_cii_has_an_not_ss(self):
        self.assertIn("AN", codelists.CII_COUNTRY_CODES)
        self.assertNotIn("SS", codelists.CII_COUNTRY_CODES)

    def test_lists_differ_only_by_ss_an(self):
        # Beyond the two known deltas the lists are identical — pin that too,
        # so an accidental extra divergence is also caught.
        self.assertEqual(codelists.UBL_COUNTRY_CODES - codelists.CII_COUNTRY_CODES,
                         frozenset(["SS"]))
        self.assertEqual(codelists.CII_COUNTRY_CODES - codelists.UBL_COUNTRY_CODES,
                         frozenset(["AN"]))


if __name__ == "__main__":
    unittest.main()

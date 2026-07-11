#!/usr/bin/env python3
"""test_coverage_gap.py — the committed gap section of coverage_matrix.json must
equal a FRESH computation from the vendored CEN Schematron artifacts, and its
arithmetic must be airtight.

Standard library only (unittest + xml.etree); no saxonche, no network. Run:

    python3 test_coverage_gap.py

What is checked (each its own test):

  1. committed == computed: matrix["gap"] is deep-equal to a live rebuild from
     the preprocessed .sch files + the live rule registries + the live
     exclusion sources — so the published gap can neither be hand-edited,
     hidden, nor go stale after a rule lands.
  2. disjoint buckets: within each artifact's official BR-* universe, the
     implemented / excluded / missing sets are pairwise disjoint (no id is
     counted twice) and their union IS the universe.
  3. arithmetic: implemented + excluded + missing == official_universe for each
     artifact, and every published count matches the length of the underlying
     id set.
  4. shape honesty: the gap is non-empty, every missing id matches ^BR-, every
     missing rule carries non-empty official text and a flag, ids are sorted
     (deterministic output), and no missing id is secretly fireable by the
     engine or listed as an exclusion.
  5. known families: the UBL gap contains the allowance/charge VAT blocks
     (BR-AF-01, BR-AG-01) and the split-payment block (BR-B-01) — the spot
     checks an independent measurement of the artifact produced.
"""

from __future__ import annotations

import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import coverage as _coverage  # noqa: E402
import gen_coverage as _gen                  # noqa: E402


def _live_gap():
    """Rebuild the gap from scratch: live registries for the implemented set,
    live exclusion sources for the excluded set, and a fresh XML parse of the
    vendored preprocessed Schematron for each official universe."""
    return _gen.build_gap(_coverage.engine_fireable_ids(),
                          _gen.deliberate_exclusion_ids())


def _universe(artifact_key):
    """Fresh BR-* universe of one CEN artifact, parsed from the .sch."""
    path = os.path.join(HERE, _gen.GAP_ARTIFACT_SCH[artifact_key])
    index = _coverage.schematron_assert_index(path)
    return {rid for rid in index if rid.startswith("BR-")}


class CoverageGapTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.matrix = _coverage.load_matrix()
        cls.gap = cls.matrix.get("gap")
        cls.live = _live_gap()
        cls.implemented = _coverage.engine_fireable_ids()
        cls.excluded = _gen.deliberate_exclusion_ids()

    # ---- 1. committed == freshly computed --------------------------------
    def test_committed_gap_equals_live_computation(self):
        self.assertIsNotNone(self.gap, "coverage_matrix.json has no 'gap' section")
        self.assertEqual(
            self.gap, self.live,
            "committed gap section differs from a fresh computation off the "
            "vendored Schematron + live registries — re-run gen_coverage.py")

    # ---- 2. buckets are disjoint and partition the universe ---------------
    def test_buckets_disjoint_and_partition_universe(self):
        for key in self.gap["artifact_order"]:
            art = self.gap["artifacts"][key]
            universe = _universe(key)
            impl_in = universe & self.implemented
            excl_in = universe & self.excluded
            missing = {m["id"] for m in art["missing_rules"]}
            self.assertFalse(impl_in & excl_in,
                             "%s: id both implemented and excluded" % key)
            self.assertFalse(impl_in & missing,
                             "%s: id both implemented and missing" % key)
            self.assertFalse(excl_in & missing,
                             "%s: id both excluded and missing" % key)
            self.assertEqual(impl_in | excl_in | missing, universe,
                             "%s: buckets do not partition the universe" % key)

    # ---- 3. published counts add up ---------------------------------------
    def test_count_arithmetic(self):
        for key in self.gap["artifact_order"]:
            art = self.gap["artifacts"][key]
            universe = _universe(key)
            self.assertEqual(art["official_universe"], len(universe), key)
            self.assertEqual(art["implemented"],
                             len(universe & self.implemented), key)
            self.assertEqual(art["excluded"],
                             len(universe & self.excluded), key)
            self.assertEqual(art["missing"], len(art["missing_rules"]), key)
            self.assertEqual(
                art["implemented"] + art["excluded"] + art["missing"],
                art["official_universe"],
                "%s: implemented + excluded + missing != official universe" % key)

    # ---- 4. shape honesty --------------------------------------------------
    def test_gap_nonempty_ids_br_texts_real_and_sorted(self):
        self.assertTrue(self.gap["artifact_order"],
                        "gap covers no artifacts")
        for key in self.gap["artifact_order"]:
            art = self.gap["artifacts"][key]
            rows = art["missing_rules"]
            self.assertGreater(len(rows), 0, "%s: empty gap is implausible "
                               "while known rule families are unimplemented" % key)
            ids = [m["id"] for m in rows]
            self.assertEqual(len(ids), len(set(ids)), "%s: duplicate ids" % key)
            self.assertEqual(ids, sorted(ids, key=_gen._sort_key),
                             "%s: missing ids not in canonical sorted order" % key)
            for m in rows:
                self.assertRegex(m["id"], r"^BR-",
                                 "%s: non-business-rule id in gap" % key)
                self.assertTrue(m["text"].strip(),
                                "%s: %s has empty official text" % (key, m["id"]))
                self.assertIn(m["flag"], ("fatal", "warning", "information"),
                              "%s: %s bad flag %r" % (key, m["id"], m["flag"]))
                self.assertNotIn(m["id"], self.implemented,
                                 "%s: %s listed missing but engine fires it"
                                 % (key, m["id"]))
                self.assertNotIn(m["id"], self.excluded,
                                 "%s: %s listed missing but also excluded"
                                 % (key, m["id"]))

    def test_missing_text_matches_artifact_verbatim(self):
        """No fabricated prose: each missing rule's text is byte-equal to the
        (whitespace-collapsed, marker-stripped) assert text in the artifact."""
        for key in self.gap["artifact_order"]:
            path = os.path.join(HERE, _gen.GAP_ARTIFACT_SCH[key])
            index = _coverage.schematron_assert_index(path)
            for m in self.gap["artifacts"][key]["missing_rules"]:
                self.assertEqual(m["text"], index[m["id"]]["text"],
                                 "%s: %s text differs from the artifact"
                                 % (key, m["id"]))
                self.assertEqual(m["flag"], index[m["id"]]["flag"], m["id"])

    # ---- 5. known-missing spot checks --------------------------------------
    def test_known_missing_families_present_in_ubl_gap(self):
        ubl = {m["id"] for m in
               self.gap["artifacts"]["en16931-ubl"]["missing_rules"]}
        for rid in ("BR-AF-01", "BR-AG-01", "BR-B-01"):
            self.assertIn(rid, ubl, "expected known-missing %s in UBL gap" % rid)

    def test_excluded_ids_considered_matches_live_sources(self):
        self.assertEqual(set(self.gap["excluded_ids_considered"]), self.excluded)
        for rid in self.gap["excluded_ids_considered"]:
            self.assertRegex(rid, r"^BR-")

    def test_markdown_gap_section_rendered(self):
        """COVERAGE.md carries the rendered Gap section (render is separately
        byte-guarded by test_coverage_matrix.py; this pins the section exists)."""
        md = open(os.path.join(HERE, "COVERAGE.md"), encoding="utf-8").read()
        self.assertIn("## Gap — official rules not yet asserted", md)
        m = re.search(r"### `en16931-ubl` — (\d+) implemented \+ (\d+) excluded "
                      r"\+ (\d+) missing = (\d+) official", md)
        self.assertIsNotNone(m, "UBL gap arithmetic line missing from COVERAGE.md")
        impl, excl, miss, uni = map(int, m.groups())
        self.assertEqual(impl + excl + miss, uni)


if __name__ == "__main__":
    unittest.main(verbosity=1)

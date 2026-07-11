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
  4. shape honesty: every missing id matches ^BR-, every missing rule carries
     non-empty official text and a flag, ids are sorted (deterministic
     output), no missing id is secretly fireable by the engine or listed as
     an exclusion, and the published fireable_missing count is consistent
     with the rows.
  5. FIREABLE-MISSING == 0, recomputed live for BOTH universes: fireable =
     official BR-* universe minus the asserts the artifact itself ships as
     literal test="true()" tautologies; every fireable id must be either
     implemented by the live engine or a documented deliberate exclusion.
     Nothing is hardcoded off the committed matrix — a vendored-artifact bump
     that turns a tautology into a real rule fails this test until the rule
     is implemented.
  6. the official-tautology exclusion class: BR-CO-05..08 are classified as
     official_tautology (NOT plain missing), each with verbatim
     test="true()" evidence (artifact file + line + assert id) that is
     re-verified here against a fresh parse AND the raw artifact line, for
     both universes; and NOTHING from the now-implemented IGIC (BR-AF-*) /
     IPSI (BR-AG-*) / split-payment (BR-B-*) families lingers in any gap.
  7. the KoSIT-vendored Peppol family (PEPPOL-EN16931-R*): the committed
     peppol_kosit_family section equals a LIVE recomputation — family
     extracted by a real XML parse of sch:assert/@id from BOTH vendored KoSIT
     artifacts, implemented ids read from the live einvoice.rules_peppol
     registries per binding, implemented + known_open partitioning each
     artifact's canonical universe, worklist texts byte-equal to the
     artifacts, and no PEPPOL id leaking into the CEN BR-* gap arithmetic —
     so the family can never silently go stale after an artifact bump or a
     rule landing.
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


def _index(artifact_key):
    """Fresh assert index of one CEN artifact, parsed from the .sch."""
    path = os.path.join(HERE, _gen.GAP_ARTIFACT_SCH[artifact_key])
    return _coverage.schematron_assert_index(path)


def _universe(artifact_key):
    """Fresh BR-* universe of one CEN artifact, parsed from the .sch."""
    return {rid for rid in _index(artifact_key) if rid.startswith("BR-")}


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
                art["fireable_missing"],
                sum(1 for m in art["missing_rules"]
                    if not m["vacuous_in_artifact"]),
                "%s: fireable_missing count inconsistent with the rows" % key)
            self.assertLessEqual(art["fireable_missing"], art["missing"], key)
            self.assertEqual(
                art["implemented"] + art["excluded"] + art["missing"],
                art["official_universe"],
                "%s: implemented + excluded + missing != official universe" % key)

    # ---- 4. shape honesty --------------------------------------------------
    def test_gap_shape_ids_br_texts_real_and_sorted(self):
        """Every missing row (the list may legitimately be EMPTY now that the
        four official test=\"true()\" tautologies are a documented exclusion
        class — test_fireable_missing_zero_live proves emptiness is honest)
        must carry a real BR- id, verbatim official text, and a valid flag."""
        self.assertTrue(self.gap["artifact_order"],
                        "gap covers no artifacts")
        for key in self.gap["artifact_order"]:
            art = self.gap["artifacts"][key]
            rows = art["missing_rules"]
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

    # ---- 5. fireable-missing == 0, recomputed live -------------------------
    def test_fireable_missing_zero_live(self):
        """THE headline claim, recomputed from the artifacts + live registries
        (never trusted from the committed matrix): for BOTH CEN universes,
        every official BR-* assert whose @test is not the literal tautology
        ``true()`` is either fired by the live engine or covered by a live
        deliberate exclusion. A future artifact bump that adds a real rule (or
        turns a tautology real) fails here until the rule is implemented —
        counts are derived, never hardcoded."""
        for key in self.gap["artifact_order"]:
            index = _index(key)
            universe = {rid for rid in index if rid.startswith("BR-")}
            tautologies = {rid for rid in universe
                           if index[rid]["test"].strip() == "true()"}
            fireable = universe - tautologies
            fireable_missing = fireable - self.implemented - self.excluded
            self.assertEqual(
                fireable_missing, set(),
                "%s: fireable official rules neither implemented nor "
                "excluded: %s" % (key, sorted(fireable_missing)))
            # The committed per-artifact count must agree — and be zero.
            self.assertEqual(
                self.gap["artifacts"][key]["fireable_missing"], 0,
                "%s: committed fireable_missing != 0" % key)

    # ---- 6. the official-tautology exclusion class --------------------------
    def test_official_tautology_class_with_verbatim_evidence(self):
        """BR-CO-05..08 are classified as the official_tautology exclusion
        class (distinct from plain missing), each carrying verbatim
        test=\"true()\" evidence per universe that is re-verified against a
        fresh XML parse AND the raw line of the vendored artifact."""
        taut = (self.matrix.get("exclusions") or {}).get("official_tautology")
        self.assertTrue(taut, "exclusions.official_tautology absent/empty")
        # Committed class == a live recomputation off the artifacts.
        self.assertEqual(taut, _gen.official_tautology_exclusions(),
                         "committed official_tautology class differs from a "
                         "live recomputation — re-run gen_coverage.py")
        ids = [e["id"] for e in taut]
        self.assertEqual(ids, sorted(ids, key=_gen._sort_key))
        for rid in ("BR-CO-05", "BR-CO-06", "BR-CO-07", "BR-CO-08"):
            self.assertIn(rid, ids,
                          "expected official tautology %s in the class" % rid)
        for e in taut:
            self.assertTrue(e["official_text"].strip(),
                            "%s: empty official text" % e["id"])
            self.assertNotIn(e["id"], self.implemented,
                             "%s: tautology claimed as fired coverage" % e["id"])
            self.assertIn(e["id"], self.excluded,
                          "%s: tautology not in the exclusion id set" % e["id"])
            self.assertEqual(sorted(e["evidence"]),
                             sorted(self.gap["artifact_order"]),
                             "%s: evidence must cover BOTH universes" % e["id"])
            for key, ev in e["evidence"].items():
                index = _index(key)
                self.assertEqual(ev["test"], "true()",
                                 "%s/%s: evidence test not the literal "
                                 "tautology" % (e["id"], key))
                self.assertEqual(index[e["id"]]["test"].strip(), "true()",
                                 "%s/%s: artifact @test is NOT true() — the "
                                 "rule became real; implement it" % (e["id"], key))
                self.assertEqual(ev["sch"], _gen.GAP_ARTIFACT_SCH[key])
                with open(os.path.join(HERE, ev["sch"]),
                          encoding="utf-8") as fh:
                    lines = fh.read().splitlines()
                cited = lines[ev["line"] - 1]
                self.assertIn('id="%s"' % ev["assert_id"], cited,
                              "%s/%s: cited line %d does not hold the assert"
                              % (e["id"], key, ev["line"]))
                self.assertIn('test="true()"', cited,
                              "%s/%s: cited line %d lacks the verbatim "
                              'test="true()" evidence' % (e["id"], key, ev["line"]))

    def test_tautologies_promoted_out_of_missing(self):
        """The four ids must NOT appear in any missing list (they were the
        pre-promotion gap) and MUST be counted in excluded_ids_considered."""
        considered = set(self.gap["excluded_ids_considered"])
        for key in self.gap["artifact_order"]:
            missing = {m["id"] for m in
                       self.gap["artifacts"][key]["missing_rules"]}
            for rid in ("BR-CO-05", "BR-CO-06", "BR-CO-07", "BR-CO-08"):
                self.assertNotIn(rid, missing,
                                 "%s: %s still listed as plain missing" % (key, rid))
                self.assertIn(rid, considered,
                              "%s not counted as a deliberate exclusion" % rid)

    def test_implemented_families_absent_from_every_gap(self):
        """The IGIC (batch B), IPSI and split-payment (batch C) families are
        implemented in both bindings — none of their ids may linger in ANY
        artifact's missing list."""
        for key in self.gap["artifact_order"]:
            ids = {m["id"] for m in
                   self.gap["artifacts"][key]["missing_rules"]}
            stale = {i for i in ids
                     if i.startswith(("BR-AF-", "BR-AG-", "BR-B-"))}
            self.assertFalse(
                stale, "%s: implemented family ids still in gap: %s"
                % (key, sorted(stale)))

    def test_excluded_ids_considered_matches_live_sources(self):
        self.assertEqual(set(self.gap["excluded_ids_considered"]), self.excluded)
        for rid in self.gap["excluded_ids_considered"]:
            self.assertRegex(rid, r"^BR-")

    # ---- 7. the KoSIT-vendored Peppol family --------------------------------
    PEPPOL_BATCH_1 = frozenset(
        "PEPPOL-EN16931-" + r for r in
        ("R001", "R005", "R008", "R010", "R020",
         "R040", "R041", "R042", "R043", "R044", "R046"))

    def _peppol_fam(self):
        fam = self.matrix.get("peppol_kosit_family")
        self.assertIsNotNone(
            fam, "coverage_matrix.json has no 'peppol_kosit_family' section")
        return fam

    def test_peppol_family_committed_equals_live(self):
        """The committed family section is deep-equal to a fresh recomputation
        off the vendored KoSIT .sch artifacts + the live rules_peppol
        registries — the enumeration can neither be hand-edited nor go stale
        (an artifact bump that adds/renames a PEPPOL assert fails here until
        gen_coverage.py is re-run and the diff reviewed)."""
        self.assertEqual(
            self._peppol_fam(), _gen.build_peppol_family(),
            "committed peppol_kosit_family differs from a fresh computation "
            "off the vendored KoSIT Schematron + live registries — re-run "
            "gen_coverage.py")

    def test_peppol_family_real_parse_of_both_artifacts(self):
        """The family in each binding equals a fresh REAL XML parse
        (sch:assert/@id) of that vendored KoSIT artifact — both bindings, no
        regex-on-prose, canonical collapse (R043-1/-2) included."""
        fam = self._peppol_fam()
        self.assertEqual(fam["artifact_order"],
                         ["xrechnung-ubl", "xrechnung-cii"])
        for key in fam["artifact_order"]:
            art = fam["artifacts"][key]
            path = os.path.join(HERE, _gen.SCHEMATRON_SOURCES[key]["file"])
            self.assertEqual(art["source"], _gen.SCHEMATRON_SOURCES[key]["file"])
            index = _coverage.schematron_assert_index(path)
            fam_ids = {rid for rid in index
                       if rid.startswith(_coverage.PEPPOL_FAMILY_PREFIX)}
            self.assertTrue(fam_ids,
                            "%s: vendored artifact carries no PEPPOL asserts?!"
                            % key)
            self.assertEqual(art["assert_ids"],
                             sorted(fam_ids, key=_gen._sort_key), key)
            self.assertEqual(art["family_asserts"], len(fam_ids), key)
            canonical = {_coverage.peppol_canonical_id(r) for r in fam_ids}
            self.assertEqual(art["canonical_ids"],
                             sorted(canonical, key=_gen._sort_key), key)
            self.assertEqual(art["family_universe"], len(canonical), key)

    def test_peppol_family_partition_and_live_registries(self):
        """Per binding: implemented + known_open == canonical universe, with
        the implemented set read from the LIVE per-binding registry — so a
        rule removed from the engine (or claimed beyond the artifact) fails
        here immediately."""
        from einvoice import rules_peppol as _rules_pep
        fam = self._peppol_fam()
        live_impl = {
            "xrechnung-ubl": {fn.rule_id for fn in _rules_pep.UBL_RULES},
            "xrechnung-cii": {fn.rule_id for fn in _rules_pep.CII_RULES},
        }
        all_universe = set()
        for key in fam["artifact_order"]:
            art = fam["artifacts"][key]
            universe = set(art["canonical_ids"])
            all_universe |= universe
            impl = live_impl[key]
            self.assertLessEqual(
                impl, universe,
                "%s: engine claims Peppol rules the vendored artifact does "
                "not carry: %s" % (key, sorted(impl - universe)))
            self.assertEqual(art["implemented"], len(universe & impl), key)
            self.assertEqual(art["known_open"], len(universe - impl), key)
            self.assertEqual(art["implemented"] + art["known_open"],
                             art["family_universe"],
                             "%s: implemented + known_open != universe" % key)
        open_ids = {r["id"] for r in fam["known_open_worklist"]}
        impl_ids = set(fam["implemented_ids"])
        self.assertFalse(open_ids & impl_ids,
                         "id both implemented and known-open")
        self.assertEqual(open_ids | impl_ids, all_universe,
                         "worklist + implemented do not partition the family")

    def test_peppol_batch1_implemented_in_both_bindings(self):
        """The 11 batch-1 rules are implemented wherever the vendored artifact
        carries the assert — for batch 1 that is BOTH bindings."""
        from einvoice import rules_peppol as _rules_pep
        fam = self._peppol_fam()
        for key, registry in (("xrechnung-ubl", _rules_pep.UBL_RULES),
                              ("xrechnung-cii", _rules_pep.CII_RULES)):
            art = fam["artifacts"][key]
            impl = {fn.rule_id for fn in registry}
            self.assertLessEqual(self.PEPPOL_BATCH_1, impl,
                                 "%s: batch-1 rule missing from the live "
                                 "registry" % key)
            self.assertLessEqual(self.PEPPOL_BATCH_1, set(art["canonical_ids"]),
                                 "%s: batch-1 id not in the artifact family"
                                 % key)
            # Every registered assert id must exist verbatim in the artifact.
            index = _coverage.schematron_assert_index(
                os.path.join(HERE, art["source"]))
            for fn in registry:
                self.assertIn(fn.assert_id, index,
                              "%s: registry assert id %s not in the vendored "
                              "artifact" % (key, fn.assert_id))

    def test_peppol_worklist_texts_verbatim_and_flags(self):
        """No fabricated prose: every known-open row carries the official rule
        text byte-equal to a fresh parse of the binding's artifact, a valid
        flag, and no assert secretly shipped as a tautology goes unmarked."""
        fam = self._peppol_fam()
        indexes = {key: _coverage.schematron_assert_index(
                       os.path.join(HERE, fam["artifacts"][key]["source"]))
                   for key in fam["artifact_order"]}
        for row in fam["known_open_worklist"]:
            self.assertTrue(row["bindings"], "%s: worklist row with no "
                            "binding evidence" % row["id"])
            for key, asserts in row["bindings"].items():
                for a in asserts:
                    entry = indexes[key].get(a["assert_id"])
                    self.assertIsNotNone(entry, "%s/%s: assert vanished from "
                                         "the artifact" % (row["id"], key))
                    self.assertEqual(a["text"], entry["text"],
                                     "%s/%s: text differs from the artifact"
                                     % (row["id"], key))
                    self.assertEqual(a["flag"], entry["flag"], row["id"])
                    self.assertEqual(a["vacuous_in_artifact"],
                                     entry["vacuous_in_artifact"], row["id"])
                    self.assertEqual(_coverage.peppol_canonical_id(
                        a["assert_id"]), row["id"], row["id"])

    def test_peppol_family_stays_out_of_cen_gap(self):
        """The Peppol family is OUTSIDE the CEN BR-* gap universes: no PEPPOL
        id may appear in any CEN missing list or in the deliberate-exclusion
        ids — the fireable-missing == 0 claim is untouched by this family."""
        for key in self.gap["artifact_order"]:
            for m in self.gap["artifacts"][key]["missing_rules"]:
                self.assertNotRegex(m["id"], r"^PEPPOL-", key)
        for rid in self.gap["excluded_ids_considered"]:
            self.assertNotRegex(rid, r"^PEPPOL-")
        # And the CEN universes themselves carry no PEPPOL ids by construction.
        for key in self.gap["artifact_order"]:
            index = _index(key)
            self.assertFalse(
                {r for r in index if r.startswith("PEPPOL-")},
                "%s: CEN artifact unexpectedly carries PEPPOL asserts" % key)

    def test_peppol_markdown_section_rendered(self):
        """COVERAGE.md carries the family section with the honest label and
        the explicit not-full-BIS disclaimer."""
        md = open(os.path.join(HERE, "COVERAGE.md"), encoding="utf-8").read()
        self.assertIn("the Peppol-derived rules KoSIT ships inside the "
                      "official XRechnung Schematron artifact", md)
        self.assertIn("NOT full Peppol BIS Billing 3.0", md)
        self.assertIn("### Known-open worklist", md)

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
        self.assertIn("Fireable missing:", md,
                      "COVERAGE.md lost the fireable-missing headline")
        self.assertIn('Official `test="true()"` tautologies', md,
                      "COVERAGE.md lost the tautology exclusion section")


if __name__ == "__main__":
    unittest.main(verbosity=1)

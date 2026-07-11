#!/usr/bin/env python3
"""test_cii_parity.py — the committed CII proof-parity worklist
(``cii_parity.json``) must equal a FRESH computation from the vendored CII
Schematron artifacts + the live coverage matrix, and its arithmetic must be
airtight — so the parity gap can never silently go stale (same pattern as
``test_coverage_gap.py``).

Standard library only (unittest + xml.etree via the shared coverage helpers);
no saxonche, no network. Run:

    python3 test_cii_parity.py

What is checked (each its own test):

  1. committed == computed: cii_parity.json is deep-equal to a live rebuild —
     matrix reloaded, both vendored CII artifacts re-parsed with a real XML
     parse of ``sch:assert/@id`` — so the worklist can neither be hand-edited
     nor go stale after an artifact bump or a matrix change.
  2. exact coverage of the UBL-only set: exactly one entry per live
     ``syntax == "ubl"`` matrix rule (count > 0), ids matching one-to-one,
     sorted, no duplicates.
  3. arithmetic: #cii-fireable + #binding-inapplicable == total, and no entry
     carries any other classification.
  4. sourcing honesty: every cii-fireable entry names a vendored CII artifact
     that (re-parsed live) REALLY carries an ``sch:assert`` with that ``@id``,
     the named path is one of ``generated_from``, and every
     binding-inapplicable entry has ``cii_artifact`` null AND its id truly
     absent from EVERY vendored CII artifact; ``generated_from`` states the
     exact artifact paths the computation reads.
  5. measurement-only guard: each entry's family matches the matrix, and the
     matrix rules it derives from still all say ``syntax == "ubl"`` — this
     worklist never flips a tag.
"""

from __future__ import annotations

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import coverage as _coverage  # noqa: E402
import gen_cii_parity as _gen                # noqa: E402


class CiiParityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(_gen.JSON_PATH, encoding="utf-8") as fh:
            cls.committed = json.load(fh)
        cls.matrix = _coverage.load_matrix()
        cls.indexes = _gen.cii_assert_indexes()
        cls.live = _gen.build_parity(cls.matrix, cls.indexes)
        cls.ubl_rules = _gen.ubl_only_rules(cls.matrix)

    # ---- 1. committed == freshly computed --------------------------------
    def test_committed_equals_live_computation(self):
        self.assertEqual(
            self.committed, self.live,
            "committed cii_parity.json differs from a fresh computation off "
            "the vendored CII Schematron artifacts + the live matrix — "
            "re-run gen_cii_parity.py")

    # ---- 2. exact coverage of the UBL-only matrix set ---------------------
    def test_one_entry_per_ubl_only_matrix_rule(self):
        self.assertGreater(len(self.ubl_rules), 0,
                           "matrix has no syntax=='ubl' rules — parity "
                           "worklist premise broken")
        self.assertEqual(len(self.committed["rules"]), len(self.ubl_rules),
                         "entry count != live count of syntax=='ubl' matrix "
                         "rules")
        committed_ids = [e["id"] for e in self.committed["rules"]]
        self.assertEqual(len(set(committed_ids)), len(committed_ids),
                         "duplicate ids in cii_parity.json")
        self.assertEqual(set(committed_ids),
                         {r["id"] for r in self.ubl_rules},
                         "cii_parity.json ids != the matrix's syntax=='ubl' "
                         "rule ids")
        self.assertEqual(committed_ids, sorted(committed_ids),
                         "cii_parity.json rules are not sorted by id")

    # ---- 3. arithmetic ----------------------------------------------------
    def test_class_counts_sum_to_total(self):
        n_fire = sum(1 for e in self.committed["rules"]
                     if e["classification"] == _gen.CLASS_FIREABLE)
        n_inapp = sum(1 for e in self.committed["rules"]
                      if e["classification"] == _gen.CLASS_INAPPLICABLE)
        self.assertEqual(n_fire + n_inapp, len(self.committed["rules"]),
                         "an entry carries an unknown classification")
        for e in self.committed["rules"]:
            self.assertIn(e["classification"],
                          (_gen.CLASS_FIREABLE, _gen.CLASS_INAPPLICABLE),
                          "%s: invalid classification %r"
                          % (e["id"], e["classification"]))

    # ---- 4. sourcing honesty ----------------------------------------------
    def test_generated_from_states_the_parsed_artifacts(self):
        self.assertEqual(
            self.committed["generated_from"],
            [_gen.CII_ARTIFACT_SCH[k] for k in _gen.CII_ARTIFACT_ORDER],
            "generated_from does not state the exact CII artifact paths the "
            "coverage tooling reads")
        for rel in self.committed["generated_from"]:
            self.assertTrue(os.path.exists(os.path.join(HERE, rel)),
                            "generated_from names a missing artifact: %s" % rel)

    def test_every_classification_is_artifact_backed(self):
        ids_by_path = {
            _gen.CII_ARTIFACT_SCH[k]: set(self.indexes[k])
            for k in _gen.CII_ARTIFACT_ORDER
        }
        all_cii_ids = set().union(*ids_by_path.values())
        for e in self.committed["rules"]:
            if e["classification"] == _gen.CLASS_FIREABLE:
                self.assertIn(e["cii_artifact"], ids_by_path,
                              "%s: cii_artifact %r is not a vendored CII "
                              "artifact path" % (e["id"], e["cii_artifact"]))
                self.assertIn(e["id"], ids_by_path[e["cii_artifact"]],
                              "%s: named artifact %s carries NO sch:assert "
                              "with this @id (re-parsed live)"
                              % (e["id"], e["cii_artifact"]))
            else:
                self.assertIsNone(e["cii_artifact"],
                                  "%s: binding-inapplicable but cii_artifact "
                                  "is not null" % e["id"])
                self.assertNotIn(e["id"], all_cii_ids,
                                 "%s: classified binding-inapplicable but a "
                                 "vendored CII artifact DOES carry the id — "
                                 "stale worklist" % e["id"])

    # ---- 5. measurement-only guard ----------------------------------------
    def test_families_match_matrix_and_no_tag_flipped(self):
        fam = {r["id"]: r["family"] for r in self.ubl_rules}
        for e in self.committed["rules"]:
            self.assertEqual(e["family"], fam[e["id"]],
                             "%s: family drifted from the matrix" % e["id"])
        for r in self.ubl_rules:
            self.assertEqual(r["syntax"], "ubl",
                             "%s: worklist source rule no longer syntax=='ubl'"
                             % r["id"])


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    failures = len(result.failures) + len(result.errors)
    if failures:
        sys.stderr.write("CII PARITY TEST: FAIL (%d)\n" % failures)
        sys.exit(1)
    print("CII PARITY TEST: OK — committed worklist equals live recompute, "
          "one entry per UBL-only rule, arithmetic airtight, every "
          "classification artifact-backed.")

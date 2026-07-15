#!/usr/bin/env python3
"""Drift guard for the KoSIT test-suite conformance headline.

The committed ``testsuite_conformance.json`` states a citable, buyer-facing
number ("X of Y official KoSIT XRechnung test-suite documents are classified
exactly as the suite labels them"). This test RE-ENUMERATES every document
under ``corpus/xrechnung-testsuite/src/test/**`` and RE-CLASSIFIES each one
LIVE with the public engine (via :func:`gen_testsuite_conformance.build_report`
— the same single source of truth the generator uses), then asserts the freshly
computed table + summary are byte-for-byte the committed artifact. So the
headline can never silently drift: a rule change, a corpus bump, or a hand edit
to the JSON all fail here until the artifact is regenerated.

It also enforces the one honesty invariant the artifact must always hold:
**every document the engine does not accept carries a non-empty machine-readable
reason** — silence is the only forbidden outcome.

Standard library only.
"""

from __future__ import annotations

import json
import os
import unittest

import gen_testsuite_conformance as gen

HERE = os.path.dirname(os.path.abspath(__file__))
JSON_PATH = os.path.join(HERE, "testsuite_conformance.json")


class TestTestsuiteConformance(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        with open(JSON_PATH, encoding="utf-8") as fh:
            cls.committed = json.load(fh)
        # LIVE re-enumeration + re-classification of the real corpus.
        cls.fresh = gen.build_report()

    def test_committed_artifact_exists_and_is_a_table(self):
        self.assertIsInstance(self.committed, dict)
        self.assertIn("documents", self.committed)
        self.assertIn("summary", self.committed)
        self.assertTrue(self.committed["documents"],
                        "artifact has an empty document table")

    def test_corpus_is_actually_enumerated_live(self):
        # Guard against a vacuous pass: the live sweep must find the real files.
        paths = gen.enumerate_documents()
        self.assertTrue(paths, "no documents enumerated under src/test/**")
        for p in paths:
            self.assertTrue(os.path.exists(os.path.join(HERE, p)),
                            "enumerated path does not exist: %s" % p)

    def test_summary_counts_match_fresh_recompute(self):
        # The headline inputs re-derived from a live re-classification must
        # equal the committed summary, field by field.
        self.assertEqual(self.fresh["summary"], self.committed["summary"])

    def test_headline_matches_fresh_recompute(self):
        self.assertEqual(self.fresh["headline"], self.committed["headline"])

    def test_full_document_table_matches_fresh_recompute(self):
        # Byte-reproducible: the whole committed file equals a fresh render.
        fresh_text = gen.render_json(self.fresh)
        with open(JSON_PATH, encoding="utf-8") as fh:
            committed_text = fh.read()
        self.assertEqual(
            fresh_text, committed_text,
            "testsuite_conformance.json is stale — re-run "
            "gen_testsuite_conformance.py")

    def test_summary_is_internally_consistent(self):
        s = self.committed["summary"]
        docs = self.committed["documents"]
        self.assertEqual(s["total_documents"], len(docs))
        self.assertEqual(s["engine_valid"] + s["engine_invalid"],
                         s["total_documents"])
        self.assertEqual(s["not_accepted"], s["engine_invalid"])
        self.assertEqual(s["in_scope_accepted"] + s["in_scope_rejected"],
                         s["in_scope_total"])
        self.assertEqual(s["in_scope_total"] + s["out_of_scope_total"],
                         s["total_documents"])
        # The combined in-scope tally is exactly the per-syntax split.
        self.assertEqual(s["in_scope_ubl_total"] + s["in_scope_cii_total"],
                         s["in_scope_total"])
        self.assertEqual(
            s["in_scope_ubl_accepted"] + s["in_scope_cii_accepted"],
            s["in_scope_accepted"])
        self.assertEqual(s["in_scope_ubl_accepted"] + s["in_scope_ubl_rejected"],
                         s["in_scope_ubl_total"])
        self.assertEqual(s["in_scope_cii_accepted"] + s["in_scope_cii_rejected"],
                         s["in_scope_cii_total"])
        # The UBL headline numerator/denominator are the UBL in-scope tallies;
        # the distinct CII sub-headline is the CII in-scope tallies.
        head = self.committed["headline"]
        self.assertEqual(head["accepted"], s["in_scope_ubl_accepted"])
        self.assertEqual(head["applicable"], s["in_scope_ubl_total"])
        self.assertEqual(head["cii"]["accepted"], s["in_scope_cii_accepted"])
        self.assertEqual(head["cii"]["applicable"], s["in_scope_cii_total"])

    def test_cii_headline_is_classified_not_syntax_excluded(self):
        """The CII half of the trust headline is genuinely classified.

        Every CII (UN/CEFACT) document must be routed through the shipped CII
        engine and either accepted or machine-listed as a guideline out-of-scope
        case — never blanket-excluded on syntax. Concretely: the retired
        ``unsupported-syntax-cii`` reason/scope must be gone entirely, and the
        live-recomputed CII in-scope accepted count must equal the CII in-scope
        total (all in-scope CII documents classify exactly as the suite labels
        them). Recomputed live from the fresh sweep, not read from the file.
        """
        blob = json.dumps(self.committed)
        self.assertNotIn(
            "unsupported-syntax-cii", blob,
            "CII must be genuinely classified, not syntax-excluded")
        # There must actually BE CII documents in the sweep (guard vacuous pass).
        cii_docs = [d for d in self.fresh["documents"] if d["syntax"] == "CII"]
        self.assertTrue(cii_docs, "no CII documents were enumerated")
        # Every non-accepted CII doc is an out-of-scope guideline case with a
        # concrete fatal rule id — never a bare syntax exclusion.
        for d in cii_docs:
            if not d["accepted"]:
                self.assertIn(d["scope_class"],
                              ("extension-guideline-out-of-scope",
                               "cvd-guideline-out-of-scope"),
                              "rejected CII doc must be an out-of-scope "
                              "guideline case, not syntax-excluded: %s"
                              % d["path"])
                self.assertTrue(d["fatal_rule_ids"], d["path"])
        # The live CII in-scope pass rate equals the committed CII sub-headline.
        s = self.fresh["summary"]
        self.assertEqual(s["in_scope_cii_accepted"], s["in_scope_cii_total"])
        self.assertEqual(self.fresh["headline"]["cii"]["accepted"],
                         s["in_scope_cii_accepted"])
        self.assertEqual(self.fresh["headline"]["cii"]["applicable"],
                         s["in_scope_cii_total"])
        # The committed CII sub-headline matches the live recompute exactly.
        self.assertEqual(self.committed["headline"]["cii"],
                         self.fresh["headline"]["cii"])

    def test_every_non_accepted_document_has_a_nonempty_reason(self):
        # The one forbidden outcome is silence: any document the engine does
        # not accept MUST say, in machine-readable form, exactly why.
        offenders = []
        for d in self.committed["documents"]:
            if d["accepted"]:
                self.assertIsNone(
                    d["reason"],
                    "accepted document should not carry a reason: %s"
                    % d["path"])
                continue
            reason = d.get("reason")
            if not (isinstance(reason, str) and reason.strip()):
                offenders.append(d["path"])
        self.assertEqual([], offenders,
                         "non-accepted documents without a reason: %s"
                         % offenders)

    def test_every_document_record_is_well_formed(self):
        required = {"path", "syntax", "category", "guideline",
                    "customization_id", "scope_class", "in_scope", "verdict",
                    "accepted", "fatal_rule_ids", "reason"}
        for d in self.committed["documents"]:
            self.assertTrue(required.issubset(d), d.get("path"))
            self.assertIn(d["syntax"], ("UBL", "CII", "unknown"))
            self.assertIn(d["verdict"], ("valid", "invalid"))
            self.assertEqual(d["accepted"], d["verdict"] == "valid")
            self.assertEqual(d["in_scope"],
                             d["scope_class"] == "in-scope-plain-cius")

    def test_provenance_names_the_kosit_testsuite(self):
        prov = json.dumps(self.committed.get("provenance", {}))
        self.assertIn("xrechnung-testsuite", prov)
        self.assertIn("KoSIT", prov)


if __name__ == "__main__":
    unittest.main(verbosity=2)

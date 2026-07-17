#!/usr/bin/env python3
"""test_cii_creditnote.py — pin the CII credit-note (Gutschrift, BT-3
TypeCode 381) scope with measured, differentially-proven verdicts
(T-VHCNCII.1).

Fast, stdlib-only, saxonche-free, offline.

In CII there is no separate credit-note root: a German ERP emits a
Gutschrift as the same ``rsm:CrossIndustryInvoice`` with
``ram:ExchangedDocument/ram:TypeCode`` = 381. Two committed, fully
synthesized fixtures carry that shape (fictional parties, fictional IBAN —
no real company/personal data):

  * ``fixtures/creditnote-valid_cii.xml`` — a business-rule-clean 381
    credit note (clone of the proven-clean ``sb-pass-clean_cii.xml`` with
    BT-3 flipped to 381 and every party/bank datum fictionalized; line
    arithmetic byte-identical);
  * ``fixtures/creditnote-invalid_cii.xml`` — the same 381 document with
    BT-5 (``ram:InvoiceCurrencyCode``) removed, a clear EN 16931
    mandatory-term violation (BR-05).

MEASURED CONTRACT (what the engine does TODAY, pinned here):

  1. The raw-XML CLI surface (``einvoice validate <file>``) is UBL-only by
     design: BOTH fixtures — valid and broken alike — get the honest
     structural ``S-ROOT`` fatal and exit 1 (``EXIT_FAIL``), in text and
     ``--json`` form. The ``--json`` report carries the document verdict
     (``valid: false``) for the 381 shape. No traceback, no silent pass.
  2. The CII rule ENGINE — the surface that actually grades CII documents
     (``einvoice.parser_cii`` + the syntax-agnostic ``einvoice.rules``, the
     exact path the Factur-X/ZUGFeRD embedded-XML product route runs via
     ``einvoice.report._report_from_invoice_bytes``) — validates the clean
     381 credit note CLEAN (``valid=True``, zero violations: 381 IS a
     listed code of the official CII BR-CL-01 merged invoice+credit-note
     list) and fails the broken variant with exactly the real ``BR-05``
     fatal (never a fabricated rule, never BR-CL-01).

ENGINE FIX MEASUREMENT FORCED (T-VHCNCII.1): before this task the shared
``br_cl_01`` graded EVERY syntax against the UBL *Invoice* sub-list, which
does not contain 381, so a perfectly valid CII Gutschrift wrongly fired
BR-CL-01 (measured: OURS {BR-CL-01} vs OFFICIAL {} on the valid fixture).
The official CEN EN16931-CII Schematron binds BT-3 to ONE merged 62-code
invoice+credit-note list — NOT the union of the two UBL sub-lists (it
additionally carries 471/472/473/500/501). The fix transcribes that list
verbatim as ``rules.UNTDID_1001_CII`` and branches on ``inv.syntax`` —
the UBL Invoice and UBL CreditNote sub-lists are byte-untouched (asserted
below), so nothing was loosened.

DIFFERENTIAL PROOF (run on disk 2026-07-17, T-VHCNCII.1, with
``PYTHONPATH=$HOME/.local/lib/python3.10/site-packages python3``):
both fixtures graded against the official vendored CEN EN16931-CII
Schematron XSLT (``corpus/cen-en16931/cii/xslt/EN16931-CII-validation.xslt``)
on BOTH EN16931-CII legs (core: ``CII_RULE_IDS`` x ``cii_our_fired``;
syntax-binding: ``SB_CII_RULE_IDS`` x ``sb_cii_our_fired``) —
**0 divergences**:

  * creditnote-valid_cii.xml
      sha256 26496955cc831dd4079a8f2ef7ff2bc76b88504b63e7836cf36f4d9efdf7db29
      OFFICIAL fired: (none)   OURS fired: (none)
  * creditnote-invalid_cii.xml
      sha256 6b31125ce20755400dc5ae13145b70963e0202b252e3d3c3f1dda1c5d9539bdc
      OFFICIAL fired: BR-05    OURS fired: BR-05

The full corpus legs were re-proven after the engine fix
(``python3 differential.py cii`` and ``python3 differential.py sbcii``,
0 divergences each), so the fix regressed nothing. The recorded sha256s
are asserted below: if either fixture's bytes ever change, this test goes
red and demands a fresh differential proof rather than silently promoting
a stale one. ``differential.py`` itself is byte-unchanged (the proof was
run through its public helpers, standalone).

This test asserts REAL measured behavior and the honest error where the
surface is genuinely unsupported — it is NOT weakened to merely pass.
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import unittest
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import einvoice  # noqa: E402
from einvoice import parser_cii, report, rules  # noqa: E402
from einvoice.cli import EXIT_FAIL  # noqa: E402

VALID_CN_CII = os.path.join(HERE, "fixtures", "creditnote-valid_cii.xml")
INVALID_CN_CII = os.path.join(HERE, "fixtures", "creditnote-invalid_cii.xml")

# sha256 of the exact fixture bytes the on-disk differential proof graded
# (0 divergences, see module docstring). Changing a fixture invalidates its
# proof — these assertions make that failure loud instead of silent.
PROVEN_SHA256 = {
    VALID_CN_CII:
        "26496955cc831dd4079a8f2ef7ff2bc76b88504b63e7836cf36f4d9efdf7db29",
    INVALID_CN_CII:
        "6b31125ce20755400dc5ae13145b70963e0202b252e3d3c3f1dda1c5d9539bdc",
}

CII_NS = "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
RAM_NS = ("urn:un:unece:uncefact:data:standard:"
          "ReusableAggregateBusinessInformationEntity:100")

# The vendored official artifact the merged CII BT-3 list is transcribed from.
CII_PREPROCESSED_SCH = os.path.join(
    HERE, "corpus", "cen-en16931", "cii", "schematron", "preprocessed",
    "EN16931-CII-validation-preprocessed.sch")


def _run_cli(*cli_args):
    """Run ``python3 -m einvoice <args>`` (packaged entry point) and return
    (returncode, stdout text)."""
    proc = subprocess.run(
        [sys.executable, "-m", "einvoice", *cli_args],
        cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        universal_newlines=True)
    return proc.returncode, proc.stdout


def _cii_engine_fired(path):
    """Fired rule ids of the CII rule engine — the identical evaluation the
    Factur-X embedded-XML product path runs (parser_cii model + the
    syntax-agnostic rules.ALL_RULES; no rule re-implemented here)."""
    inv = parser_cii.parse(path)
    return {v.rule_id for v in (fn(inv) for fn in rules.ALL_RULES)
            if v is not None}


class FixtureIntegrity(unittest.TestCase):
    """The committed fixtures ARE the proven bytes and carry the 381 shape."""

    def test_fixtures_match_differential_proof_sha256(self):
        for path, sha in sorted(PROVEN_SHA256.items()):
            with self.subTest(path=path):
                self.assertTrue(os.path.isfile(path), path)
                with open(path, "rb") as fh:
                    got = hashlib.sha256(fh.read()).hexdigest()
                self.assertEqual(
                    got, sha,
                    "%s changed since the 0-divergence differential proof "
                    "was run — re-run the proof and re-pin, never promote a "
                    "stale proof" % os.path.basename(path))

    def test_fixtures_are_cii_creditnotes_typecode_381(self):
        for path in (VALID_CN_CII, INVALID_CN_CII):
            with self.subTest(path=path):
                root = ET.parse(path).getroot()
                self.assertEqual(
                    root.tag, "{%s}CrossIndustryInvoice" % CII_NS,
                    "the CII credit-note root IS CrossIndustryInvoice — "
                    "there is no separate credit-note root in CII")
                tc = root.find(
                    "{%s}ExchangedDocument/{%s}TypeCode" % (CII_NS, RAM_NS))
                self.assertIsNotNone(tc, "BT-3 missing in %s" % path)
                self.assertEqual(tc.text, "381",
                                 "BT-3 must be the credit-note code 381")

    def test_invalid_variant_lacks_bt5_only(self):
        # The broken variant's ONE injected defect: BT-5 removed.
        with open(VALID_CN_CII, encoding="utf-8") as fh:
            good = fh.read()
        with open(INVALID_CN_CII, encoding="utf-8") as fh:
            bad = fh.read()
        self.assertIn("<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>",
                      good)
        self.assertNotIn("InvoiceCurrencyCode", bad)


class RawXmlCliContract(unittest.TestCase):
    """The raw-XML CLI surface is UBL-only: a raw CII file — valid 381
    credit note or broken alike — gets the honest structural S-ROOT fatal
    and exit 1, never a traceback, never a silent pass. (CII documents are
    graded for real on the embedded Factur-X path — next test class.)"""

    def test_validate_text_both_fixtures(self):
        for path in (VALID_CN_CII, INVALID_CN_CII):
            with self.subTest(path=path):
                rc, out = _run_cli("validate", path)
                self.assertEqual(rc, EXIT_FAIL,
                                 "raw CII via `validate` exits 1: %s" % out)
                self.assertIn("FAIL:", out)
                self.assertIn("S-ROOT", out)
                self.assertNotIn("Traceback", out)

    def test_validate_json_both_fixtures(self):
        for path in (VALID_CN_CII, INVALID_CN_CII):
            with self.subTest(path=path):
                rc, out = _run_cli("validate", "--json", path)
                self.assertEqual(rc, EXIT_FAIL)
                rep = json.loads(out)  # well-formed machine report
                # the --json output carries the document verdict for the
                # 381 shape (here: not valid on the UBL-only raw surface).
                self.assertIs(rep["valid"], False)
                self.assertEqual(
                    [v["rule"] for v in rep["violations"]], ["S-ROOT"])
                self.assertEqual(rep["violations"][0]["severity"], "fatal")


class CiiEngineVerdicts(unittest.TestCase):
    """The CII rule engine (the Factur-X embedded path) — measured verdicts,
    each differentially proven at 0 divergences (module docstring)."""

    def test_valid_381_creditnote_passes_clean(self):
        fired = _cii_engine_fired(VALID_CN_CII)
        self.assertEqual(
            fired, set(),
            "a business-rule-clean CII Gutschrift (BT-3=381) validates "
            "CLEAN — official CII BR-CL-01 lists 381; got %s" % sorted(fired))

    def test_valid_381_creditnote_report_verdict(self):
        with open(VALID_CN_CII, "rb") as fh:
            rep = report._report_from_invoice_bytes(
                fh.read(), source=VALID_CN_CII, profile="en16931")
        self.assertIs(rep["valid"], True)
        self.assertEqual(rep["fatal_count"], 0)
        self.assertEqual(rep["violations"], [])

    def test_broken_381_creditnote_fires_real_br05(self):
        fired = _cii_engine_fired(INVALID_CN_CII)
        self.assertEqual(
            fired, {"BR-05"},
            "the BT-5-less 381 credit note fails on exactly the real BR-05 "
            "(official fired the same); got %s" % sorted(fired))
        self.assertNotIn("BR-CL-01", fired,
                         "381 must NOT trip BR-CL-01 on CII")

    def test_broken_381_creditnote_report_verdict(self):
        with open(INVALID_CN_CII, "rb") as fh:
            rep = report._report_from_invoice_bytes(
                fh.read(), source=INVALID_CN_CII, profile="en16931")
        self.assertIs(rep["valid"], False)
        self.assertEqual(rep["fatal_count"], 1)
        self.assertEqual([v["rule"] for v in rep["violations"]], ["BR-05"])


class MachineFormatParity(unittest.TestCase):
    """T-VHCNCII.2: the json / junit / sarif machine formats carry the 381
    credit-note verdict EXACTLY as they do for an ordinary CII invoice.

    Every report here is built by the same entry points the shipped product
    uses — ``report._report_from_invoice_bytes`` (the embedded-CII path the
    tests above already exercise) projected through ``json.dumps`` /
    ``report.build_junit`` / ``report.build_sarif``. No new validation logic,
    no re-implemented rules: these tests only pin that the PROJECTIONS agree
    with the differentially proven engine verdicts.

    Ordinary-invoice baselines (same profile, same entry points):
      * corpus/synthetic/synth-cii-good-multiline.xml — a valid ordinary CII
        invoice (golden: valid, zero rules);
      * corpus/synthetic/synth-cii-bad-vat-mismatch.xml — an ordinary CII
        invoice with a fatal (golden: BR-CO-14).
    Parity = the 381 fixtures produce the SAME structural representation of
    their verdict in each format as those ordinary invoices do.
    """

    ORDINARY_GOOD = os.path.join(
        HERE, "corpus", "synthetic", "synth-cii-good-multiline.xml")
    ORDINARY_BAD = os.path.join(
        HERE, "corpus", "synthetic", "synth-cii-bad-vat-mismatch.xml")

    @staticmethod
    def _rep(path):
        """The exact report dict the embedded-CII product path emits."""
        with open(path, "rb") as fh:
            return report._report_from_invoice_bytes(
                fh.read(), source=path, profile="en16931")

    # ---------------- json ----------------

    def test_json_valid_381_zero_fatal_like_ordinary_invoice(self):
        rep = json.loads(json.dumps(self._rep(VALID_CN_CII)))
        ordinary = json.loads(json.dumps(self._rep(self.ORDINARY_GOOD)))
        # identical machine-report shape (same keys) as an ordinary invoice…
        self.assertEqual(set(rep), set(ordinary))
        # …and the identical passing/zero-fatal verdict representation.
        for r in (rep, ordinary):
            self.assertIs(r["valid"], True)
            self.assertEqual(r["fatal_count"], 0)
            self.assertEqual(r["violations"], [])

    def test_json_invalid_381_carries_fatal_br05(self):
        rep = json.loads(json.dumps(self._rep(INVALID_CN_CII)))
        ordinary = json.loads(json.dumps(self._rep(self.ORDINARY_BAD)))
        self.assertEqual(set(rep), set(ordinary))
        for r in (rep, ordinary):
            self.assertIs(r["valid"], False)
            self.assertGreaterEqual(r["fatal_count"], 1)
        # the fatal finding is present WITH its rule id, exactly as an
        # ordinary invoice's fatal is.
        self.assertEqual(
            [(v["rule"], v["severity"]) for v in rep["violations"]],
            [("BR-05", "fatal")])
        self.assertIn(("BR-CO-14", "fatal"),
                      [(v["rule"], v["severity"])
                       for v in ordinary["violations"]])

    # ---------------- junit ----------------

    @staticmethod
    def _junit_root(rep):
        return ET.fromstring(report.build_junit(rep))

    def test_junit_valid_381_zero_failures_like_ordinary_invoice(self):
        for path in (VALID_CN_CII, self.ORDINARY_GOOD):
            with self.subTest(path=path):
                root = self._junit_root(self._rep(path))
                self.assertEqual(root.tag, "testsuites")
                self.assertEqual(root.get("failures"), "0")
                self.assertEqual(root.get("errors"), "0")
                self.assertEqual(root.findall(".//failure"), [])

    def test_junit_invalid_381_failure_testcase_named_br05(self):
        root = self._junit_root(self._rep(INVALID_CN_CII))
        self.assertEqual(root.get("failures"), "1")
        self.assertEqual(root.get("errors"), "0")
        cases = root.findall(".//testcase")
        self.assertEqual([c.get("name") for c in cases], ["BR-05"])
        self.assertEqual(len(cases[0].findall("failure")), 1,
                         "the fatal must surface as a JUnit <failure>")
        # the SAME failing representation an ordinary CII invoice gets:
        # its fatal rule id as testcase name carrying a <failure> child.
        obad = self._junit_root(self._rep(self.ORDINARY_BAD))
        self.assertNotEqual(obad.get("failures"), "0")
        self.assertIn("BR-CO-14",
                      [c.get("name") for c in obad.findall(".//testcase")
                       if c.find("failure") is not None])

    # ---------------- sarif ----------------

    def test_sarif_valid_381_zero_results_like_ordinary_invoice(self):
        for path in (VALID_CN_CII, self.ORDINARY_GOOD):
            with self.subTest(path=path):
                sarif = report.build_sarif(self._rep(path))
                json.dumps(sarif)  # serializable machine document
                self.assertEqual(sarif["version"], "2.1.0")
                run = sarif["runs"][0]
                self.assertEqual(run["results"], [])
                self.assertEqual(run["tool"]["driver"]["rules"], [])

    def test_sarif_invalid_381_error_result_ruleid_br05(self):
        sarif = report.build_sarif(self._rep(INVALID_CN_CII))
        json.dumps(sarif)
        run = sarif["runs"][0]
        self.assertEqual(
            [(r["ruleId"], r["level"]) for r in run["results"]],
            [("BR-05", "error")])
        self.assertEqual(
            [d["id"] for d in run["tool"]["driver"]["rules"]], ["BR-05"])
        # ordinary-invoice parity: a fatal on an ordinary CII invoice takes
        # the identical shape — an "error"-level result carrying its rule id.
        orun = report.build_sarif(self._rep(self.ORDINARY_BAD))["runs"][0]
        self.assertIn(("BR-CO-14", "error"),
                      [(r["ruleId"], r["level"]) for r in orun["results"]])


class MergedCiiListTranscription(unittest.TestCase):
    """rules.UNTDID_1001_CII is a verbatim transcription of the official
    vendored CII BR-CL-01 code list — and the fix loosened NOTHING on UBL."""

    def test_untdid_1001_cii_matches_vendored_artifact(self):
        with open(CII_PREPROCESSED_SCH, encoding="utf-8") as fh:
            sch = fh.read()
        m = re.search(
            r'id="BR-CL-01"[^>]*contains\(\' ([0-9 ]+) \'', sch)
        self.assertIsNotNone(m, "BR-CL-01 assert not found in vendored .sch")
        official = set(m.group(1).split())
        self.assertEqual(
            rules.UNTDID_1001_CII, official,
            "UNTDID_1001_CII must transcribe the vendored CII artifact "
            "verbatim (62 codes)")
        self.assertEqual(len(official), 62)
        self.assertIn("381", official)

    def test_ubl_sublists_untouched(self):
        # The engine fix branched on syntax; the UBL bindings stay strict:
        # 381 remains INVALID for a UBL Invoice's cbc:InvoiceTypeCode and
        # valid only via the UBL CreditNote sub-list.
        self.assertNotIn("381", rules.UNTDID_1001_INVOICE)
        self.assertIn("381", rules.UNTDID_1001_CREDITNOTE)
        # The merged CII list is deliberately NOT the union of the UBL
        # sub-lists (it additionally carries 471/472/473/500/501) — pinned
        # so nobody "simplifies" it into a derived union later.
        beyond = rules.UNTDID_1001_CII - (
            rules.UNTDID_1001_INVOICE | rules.UNTDID_1001_CREDITNOTE)
        self.assertEqual(beyond, {"471", "472", "473", "500", "501"})


if __name__ == "__main__":
    unittest.main(verbosity=2)

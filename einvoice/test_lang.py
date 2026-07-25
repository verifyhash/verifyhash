#!/usr/bin/env python3
"""test_lang.py — the ``--lang de`` German-message surface (T-VHLANG.1).

Fast, stdlib-only, offline, saxonche-free. Proves that the buyer-facing
error/remediation text can be shown in German WITHOUT us translating anything
and WITHOUT changing which rules fire:

  * ``remediation_catalog.json`` carries a ``message_de`` string ONLY for the
    BR-DE-family rules whose vendored KoSIT XRechnung ``<sch:assert>`` is itself
    German (de_source == "kosit"); every ``message_de`` is that assert text
    VERBATIM, tagged with the ``{artifact, assert_id}`` it was lifted from.
  * The count of ``message_de``-covered rules is pinned to an exact integer so
    it cannot silently drift.
  * Each ``message_de`` is byte-identical to the corresponding assert text in the
    vendored ``.sch`` (independently re-extracted here — proves no fabrication).
  * ``einvoice.remediation.resolve_message`` returns the German string under
    ``lang="de"`` where one exists and cleanly falls back to English otherwise.
  * The ``einvoice validate --lang de`` CLI swaps ONLY the human-facing message;
    rule ids, the offending element, ``--json`` output and the exit code are
    unchanged.

Run: python3 test_lang.py
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import unittest
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice import remediation as R          # noqa: E402
from einvoice.cli import main, EXIT_USAGE, EXIT_OK  # noqa: E402
from einvoice.report import main as report_main     # noqa: E402

SCH_NS = "{http://purl.oclc.org/dsdl/schematron}"

# The number of rules that carry an official German message_de. This equals the
# count of catalog entries with de_source == "kosit" — the rules whose vendored
# KoSIT XRechnung <sch:assert> text is German (the BR-DE / BR-DE-TMP / BR-DE-CVD
# / BR-DEX / BR-TMP family; the six English-authored BR-DEX and all PEPPOL/CEN
# asserts get NO message_de). Recomputed and cross-checked against de_source in
# test_message_de_count below, so any drift fails loudly.
EXPECTED_MESSAGE_DE_COUNT = 50

CATALOG = R.load_catalog()
CATALOG_DOC = R.load_catalog_document()
WITH_DE = {rid: e for rid, e in CATALOG.items() if "message_de" in e}

# ---- fixtures for the CLI end-to-end leg ----------------------------------- #
# Clean CEN-positive UBL invoice: under the xrechnung profile its FIRST fatal is
# BR-DE-2 (SELLER CONTACT / BG-6 missing) — a rule that carries an official
# German message_de, so --lang de must surface the German assert text.
BR_DE_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                             "cen-bis3-positive_ubl.xml")
# An invalid UBL CreditNote (BT-3 CreditNoteTypeCode=999): really validated by
# the shared engine, its first fatal is the CORE rule BR-CL-01, which has NO
# official German message — so --lang de must fall back to the English message.
# (A CreditNote is no longer S-ROOT-rejected since T-VHCN.2, so the fallback
# path is exercised through a genuine core-rule fatal instead.)
FALLBACK_FIXTURE = os.path.join(HERE, "fixtures",
                                "creditnote-invalid-typecode_ubl.xml")


def _extract_assert_text(sch_path, assert_id):
    """Independently lift the ``<sch:assert>`` text for ``assert_id`` out of a
    vendored Schematron file and normalise it the way the catalog does: collapse
    runs of whitespace, then strip the leading ``[RULE-ID]`` id tag Schematron
    prefixes every message with. Reimplemented here (not imported from the build
    script) so this is a genuine independent check of verbatim provenance."""
    root = ET.parse(sch_path).getroot()
    for a in root.iter(SCH_NS + "assert"):
        if a.get("id") == assert_id:
            text = re.sub(r"\s+", " ", "".join(a.itertext())).strip()
            return re.sub(r"^\[[^\]]+\]\s*-?\s*", "", text).strip()
    raise AssertionError("assert id %r not found in %s" % (assert_id, sch_path))


class _Capture:
    """Run ``main(argv)`` capturing stdout/stderr and the exit code.

    ``fn`` defaults to the ``einvoice`` console-script entry point; pass
    ``report_main`` to drive ``python3 -m einvoice.report`` through the very
    same harness (the byte-identity checks below need both).
    """

    def __init__(self, argv, fn=None):
        self.argv = argv
        self.fn = fn or main
        self.rc = self.out = self.err = None

    def __enter__(self):
        self._out, self._err = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = io.StringIO(), io.StringIO()
        try:
            self.rc = self.fn(self.argv)
        finally:
            self.out = sys.stdout.getvalue()
            self.err = sys.stderr.getvalue()
            sys.stdout, sys.stderr = self._out, self._err
        return self

    def __exit__(self, *exc):
        return False


class MessageDeCatalog(unittest.TestCase):
    """The message_de field: presence, provenance, exact count, verbatimness."""

    def test_message_de_count_is_pinned(self):
        # (c) exact integer so coverage cannot silently drift.
        self.assertEqual(len(WITH_DE), EXPECTED_MESSAGE_DE_COUNT)
        # Independent cross-check: message_de is present on EXACTLY the
        # de_source == "kosit" rules and nothing else.
        kosit = {rid for rid, e in CATALOG.items()
                 if e.get("de_source") == "kosit"}
        self.assertEqual(set(WITH_DE), kosit)
        self.assertEqual(len(kosit), EXPECTED_MESSAGE_DE_COUNT)

    def test_message_de_is_byte_identical_to_vendored_assert(self):
        # (d) every message_de is byte-identical to the assert it claims to come
        # from, re-extracted independently from the vendored .sch on disk.
        self.assertTrue(WITH_DE, "expected at least one message_de rule")
        for rid, entry in WITH_DE.items():
            prov = entry["message_de_provenance"]
            self.assertIn("artifact", prov)
            self.assertIn("assert_id", prov)
            # Provenance must name a KoSIT XRechnung artifact, never a core file.
            self.assertIn("xrechnung-schematron", prov["artifact"], rid)
            sch_path = os.path.join(HERE, prov["artifact"])
            self.assertTrue(os.path.isfile(sch_path), sch_path)
            expected = _extract_assert_text(sch_path, prov["assert_id"])
            self.assertEqual(entry["message_de"], expected,
                             "message_de not verbatim for %s" % rid)

    def test_br_de_1_message_de_matches_official_text(self):
        # The canonical example from the spec, checked as a literal.
        self.assertIn("BR-DE-1", WITH_DE)
        self.assertEqual(
            CATALOG["BR-DE-1"]["message_de"],
            'Eine Rechnung (INVOICE) muss Angaben zu '
            '"PAYMENT INSTRUCTIONS" (BG-16) enthalten.')

    def test_message_de_never_on_non_german_rules(self):
        # A core EN 16931 rule and an English-authored PEPPOL rule carry no
        # message_de (silence-with-reason, never a relabeled English string).
        self.assertNotIn("message_de", CATALOG["BR-02"])
        peppol = next((rid for rid in CATALOG if rid.startswith("PEPPOL-")), None)
        if peppol is not None:
            self.assertNotIn("message_de", CATALOG[peppol])

    def test_catalog_is_json_and_documents_message_de(self):
        self.assertIn("message_de", CATALOG_DOC["description"])


class Resolver(unittest.TestCase):
    """einvoice.remediation.resolve_message language selection."""

    def test_de_returns_official_german_for_br_de_rule(self):
        # (a) known BR-DE rule renders official German under de, English default.
        german = CATALOG["BR-DE-1"]["message_de"]
        english = "some English engine message"
        self.assertEqual(R.resolve_message("BR-DE-1", english, "de"), german)
        self.assertEqual(R.resolve_message("BR-DE-1", english, "en"), english)
        # Default lang is English.
        self.assertEqual(R.resolve_message("BR-DE-1", english), english)

    def test_de_falls_back_to_english_when_no_official_german(self):
        # (b) a rule WITHOUT an official German string falls back cleanly.
        english = "The Invoice must contain something (BR-02)."
        self.assertNotIn("message_de", CATALOG["BR-02"])
        self.assertEqual(R.resolve_message("BR-02", english, "de"), english)

    def test_unknown_rule_id_falls_back_to_english(self):
        english = "structural failure text"
        self.assertEqual(
            R.resolve_message("S-ROOT", english, "de"), english)
        self.assertEqual(
            R.resolve_message("does-not-exist", english, "de"), english)

    def test_official_message_returns_none_when_absent(self):
        self.assertIsNone(R.official_message("BR-02", "de"))
        self.assertIsNone(R.official_message("BR-DE-1", "en"))
        self.assertEqual(
            R.official_message("BR-DE-1", "de"),
            CATALOG["BR-DE-1"]["message_de"])


class Cli(unittest.TestCase):
    """The `einvoice validate --lang de` end-to-end behaviour."""

    def _fail_line(self, out):
        """Return (rule_id, message, element) parsed from a human FAIL summary."""
        rid = msg = elem = None
        for line in out.splitlines():
            s = line.strip()
            m = re.match(r"^([A-Z0-9][A-Za-z0-9-]*): (.*)$", s)
            if m and rid is None and not s.startswith("FAIL"):
                rid, msg = m.group(1), m.group(2)
            if s.startswith("offending element:"):
                elem = s.split(":", 1)[1].strip()
        return rid, msg, elem

    def test_lang_de_surfaces_official_german_message(self):
        with _Capture(["validate", BR_DE_FIXTURE,
                       "--profile=xrechnung", "--lang=de"]) as de:
            pass
        with _Capture(["validate", BR_DE_FIXTURE,
                       "--profile=xrechnung"]) as en:
            pass
        self.assertEqual(de.rc, 1)
        self.assertEqual(en.rc, 1)
        de_rid, de_msg, de_elem = self._fail_line(de.out)
        en_rid, en_msg, en_elem = self._fail_line(en.out)
        # Same rule fires, same offending element — only the message differs.
        self.assertEqual(de_rid, en_rid)
        self.assertEqual(de_elem, en_elem)
        self.assertTrue(de_rid.startswith("BR-DE"), de_rid)
        # The German line is exactly the official message_de for that rule.
        self.assertEqual(de_msg, CATALOG[de_rid]["message_de"])
        self.assertNotEqual(de_msg, en_msg)

    def test_lang_de_falls_back_to_english_for_non_german_rule(self):
        # (4) a rule with no official German string keeps its English message.
        with _Capture(["validate", FALLBACK_FIXTURE, "--lang=de"]) as de:
            pass
        with _Capture(["validate", FALLBACK_FIXTURE]) as en:
            pass
        self.assertEqual(de.rc, en.rc)
        # Non-vacuous: the fixture must actually FAIL so there is a FAIL line to
        # read a (non-German) rule message off of.
        self.assertEqual(de.rc, 1)
        de_rid, de_msg, _ = self._fail_line(de.out)
        en_rid, en_msg, _ = self._fail_line(en.out)
        self.assertEqual(de_rid, en_rid)
        self.assertNotIn("message_de", CATALOG.get(de_rid, {}))
        self.assertEqual(de_msg, en_msg)

    def test_lang_does_not_change_json_output(self):
        # (3) --json output is byte-identical regardless of --lang.
        with _Capture(["validate", BR_DE_FIXTURE,
                       "--profile=xrechnung", "--json", "--lang=de"]) as de:
            pass
        with _Capture(["validate", BR_DE_FIXTURE,
                       "--profile=xrechnung", "--json"]) as en:
            pass
        self.assertEqual(de.out, en.out)
        # And the JSON still parses and carries the same violations/severities.
        dj, ej = json.loads(de.out), json.loads(en.out)
        self.assertEqual(dj, ej)

    def test_lang_equals_form_and_default(self):
        # --lang=de and --lang de are equivalent; absence == en.
        with _Capture(["validate", BR_DE_FIXTURE,
                       "--profile=xrechnung", "--lang", "de"]) as split:
            pass
        with _Capture(["validate", BR_DE_FIXTURE,
                       "--profile=xrechnung", "--lang=de"]) as joined:
            pass
        self.assertEqual(split.out, joined.out)

    def test_unknown_lang_is_usage_error(self):
        with _Capture(["validate", BR_DE_FIXTURE, "--lang=fr"]) as cap:
            pass
        self.assertEqual(cap.rc, EXIT_USAGE)
        self.assertIn("unknown lang", cap.err)


# --------------------------------------------------------------------------- #
# T-VHERG.6: `--explain --lang` on BOTH entry points, and the DERIVED check that
# the German-coverage numbers printed in EXIT-CODES.md are the catalog's own.
# --------------------------------------------------------------------------- #

#: A rule with OFFICIAL German (de_source == "kosit") and one WITHOUT (the CEN
#: core), both taken from the catalog rather than assumed.
KOSIT_RULE = "BR-DE-15"
TRANSLATED_RULE = "BR-01"

#: The doc whose German-coverage claims are derived-checked below.
EXIT_CODES_DOC = os.path.join(HERE, "EXIT-CODES.md")

#: Claim key (as written in the doc's first table column, inside backticks) ->
#: a callable computing the TRUE count straight from the committed catalog.
#: Every key must appear in the doc, and every doc row must be one of these —
#: so neither side can drop or invent a claim without failing here.
COVERAGE_CLAIMS = {
    "message_de":
        lambda cat: sum(1 for e in cat.values() if e.get("message_de")),
    "title_de":
        lambda cat: sum(1 for e in cat.values() if e.get("title_de")),
    "fix_de":
        lambda cat: sum(1 for e in cat.values() if e.get("fix_de")),
    "de_source: kosit":
        lambda cat: sum(1 for e in cat.values()
                        if e.get("de_source") == "kosit"),
    "de_source: translation":
        lambda cat: sum(1 for e in cat.values()
                        if e.get("de_source") == "translation"),
}

#: ``| `<claim>` | <n> of <total> |`` — the machine-checkable shape the doc's
#: coverage table is written in.
_CLAIM_ROW = re.compile(r"^\|\s*`([^`]+)`\s*\|\s*(\d+) of (\d+)\s*\|", re.M)


def _doc_text():
    with open(EXIT_CODES_DOC, encoding="utf-8") as fh:
        return fh.read()


class DocumentedGermanCoverageIsDerived(unittest.TestCase):
    """EXIT-CODES.md's German-coverage numbers must equal the catalog's.

    The backlog premise for T-VHERG.6 said the catalog carried "0" German
    entries; the catalog actually carries official KoSIT German on 50 rules and
    project-authored German on the other 247. A number written into prose rots
    silently, so this test re-derives every claim from
    ``remediation_catalog.json`` and fails the build if the doc and the data
    ever disagree — the disclosure cannot become the next shipped falsehood.
    """

    def test_every_claim_row_matches_the_catalog(self):
        rows = _CLAIM_ROW.findall(_doc_text())
        self.assertTrue(rows, "EXIT-CODES.md has no `<field>` | `<n> of <m>` "
                              "coverage rows — the disclosure was removed")
        seen = set()
        for claim, count, total in rows:
            self.assertIn(claim, COVERAGE_CLAIMS,
                          "EXIT-CODES.md claims coverage for %r, which is not "
                          "a catalog field this test can derive" % claim)
            seen.add(claim)
            self.assertEqual(
                int(total), len(CATALOG),
                "EXIT-CODES.md says %r is out of %s rules; the catalog has %d"
                % (claim, total, len(CATALOG)))
            self.assertEqual(
                int(count), COVERAGE_CLAIMS[claim](CATALOG),
                "EXIT-CODES.md says %s rules carry %r; the catalog says %d"
                % (count, claim, COVERAGE_CLAIMS[claim](CATALOG)))
        self.assertEqual(
            seen, set(COVERAGE_CLAIMS),
            "EXIT-CODES.md must state every German-coverage claim; missing %r"
            % sorted(set(COVERAGE_CLAIMS) - seen))

    def test_doc_names_kosit_as_the_official_source(self):
        # The single most important word in the disclosure: the official German
        # is KoSIT's, not ours. Its absence would make the rest unattributed.
        self.assertIn("kosit", _doc_text().lower())

    def test_message_de_claim_is_non_vacuous(self):
        # Guard against a doc table of all-zero rows trivially "agreeing".
        self.assertEqual(COVERAGE_CLAIMS["message_de"](CATALOG),
                         EXPECTED_MESSAGE_DE_COUNT)
        self.assertEqual(COVERAGE_CLAIMS["title_de"](CATALOG), len(CATALOG))
        self.assertGreater(COVERAGE_CLAIMS["de_source: translation"](CATALOG),
                           0)


class ExplainLang(unittest.TestCase):
    """``--explain <RULE-ID> --lang=de`` on both entry points."""

    def test_english_default_is_unchanged(self):
        with _Capture(["--explain", KOSIT_RULE]) as cap:
            pass
        self.assertEqual(cap.rc, EXIT_OK)
        self.assertIn(CATALOG[KOSIT_RULE]["title"], cap.out)
        # No German fields, and no provenance line: the English block is the
        # historical one, byte for byte.
        self.assertNotIn("german   :", cap.out)
        self.assertNotIn(CATALOG[KOSIT_RULE]["fix_de"], cap.out)

    def test_de_prints_german_and_exits_zero(self):
        with _Capture(["--explain", KOSIT_RULE, "--lang=de"]) as cap:
            pass
        self.assertEqual(cap.rc, EXIT_OK)
        entry = CATALOG[KOSIT_RULE]
        # The official KoSIT sentence is the requires line...
        self.assertIn("  requires : %s" % entry["message_de"], cap.out)
        # ...the German fix and title come from the catalog verbatim...
        self.assertIn("  fix      : %s" % entry["fix_de"], cap.out)
        self.assertIn("%s  %s" % (KOSIT_RULE, entry["title_de"]), cap.out)
        # ...and the provenance is disclosed rather than left to trust.
        self.assertIn("  german   :", cap.out)
        self.assertIn("KoSIT", cap.out)
        # Language-independent facts are untouched.
        self.assertIn("  severity : %s" % entry["severity"], cap.out)

    def test_de_on_a_translated_rule_says_so_and_keeps_requires_english(self):
        entry = CATALOG[TRANSLATED_RULE]
        self.assertEqual(entry.get("de_source"), "translation")
        with _Capture(["--explain", TRANSLATED_RULE, "--lang=de"]) as cap:
            pass
        self.assertEqual(cap.rc, EXIT_OK)
        self.assertIn("  german   :", cap.out)
        self.assertIn("translation", cap.out)
        # No official German exists, so the normative line stays English —
        # nothing is invented to fill the gap.
        self.assertIn("  requires : %s" % entry["requires"], cap.out)
        # The project-authored German fields are still shown, as the doc says.
        self.assertIn("%s  %s" % (TRANSLATED_RULE, entry["title_de"]), cap.out)

    def test_both_entry_points_are_byte_identical_under_lang(self):
        # The reason `_run_explain` delegates instead of forking the renderer.
        for argv_lang in (["--lang=de"], ["--lang", "de"], ["--lang=en"], []):
            for rule in (KOSIT_RULE, TRANSLATED_RULE):
                with _Capture(["--explain", rule] + argv_lang) as cli_cap:
                    pass
                with _Capture(["--explain", rule] + argv_lang,
                              fn=report_main) as rep_cap:
                    pass
                self.assertEqual(cli_cap.rc, EXIT_OK, argv_lang)
                self.assertEqual(rep_cap.rc, EXIT_OK, argv_lang)
                self.assertEqual(cli_cap.out, rep_cap.out,
                                 "entry points drifted for %s %r"
                                 % (rule, argv_lang))

    def test_split_and_joined_lang_forms_agree(self):
        with _Capture(["--explain", KOSIT_RULE, "--lang", "de"]) as split:
            pass
        with _Capture(["--explain", KOSIT_RULE, "--lang=de"]) as joined:
            pass
        self.assertEqual(split.out, joined.out)
        # ...and en is exactly the no-flag output.
        with _Capture(["--explain", KOSIT_RULE, "--lang=en"]) as en:
            pass
        with _Capture(["--explain", KOSIT_RULE]) as bare:
            pass
        self.assertEqual(en.out, bare.out)

    def test_unknown_lang_on_explain_is_a_usage_error(self):
        with _Capture(["--explain", KOSIT_RULE, "--lang=fr"]) as cap:
            pass
        self.assertEqual(cap.rc, EXIT_USAGE)
        self.assertIn("unknown lang", cap.err)
        self.assertEqual(cap.out, "")
        # Byte-identical to the validate form's error line (one vocabulary
        # error, not a second dialect of it).
        with _Capture(["validate", BR_DE_FIXTURE, "--lang=fr"]) as val:
            pass
        self.assertEqual(cap.err, val.err)

    def test_unknown_rule_id_still_exits_one_under_lang(self):
        with _Capture(["--explain", "NOPE-999", "--lang=de"]) as cap:
            pass
        self.assertEqual(cap.rc, 1)
        self.assertEqual(cap.out, "")

    def test_batch_banner_documents_lang(self):
        # (2) The banner under-described a flag validate-batch really accepts.
        from einvoice.cli import USAGE as CLI_USAGE
        batch_line = [ln for ln in CLI_USAGE.splitlines()
                      if "validate-batch" in ln]
        self.assertEqual(len(batch_line), 1)
        self.assertIn("--lang", batch_line[0])
        # ...and the flag genuinely works there (banner must not outrun code).
        with _Capture(["validate-batch", os.path.join(HERE, "fixtures"),
                       "--lang=de", "--quiet"]) as cap:
            pass
        self.assertNotEqual(cap.rc, EXIT_USAGE)
        explain_line = [ln for ln in CLI_USAGE.splitlines()
                        if "--explain" in ln]
        self.assertEqual(len(explain_line), 1)
        self.assertIn("--lang", explain_line[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)

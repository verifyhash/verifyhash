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
  * The REPORT surfaces split the same way (T-VHRPTH.4): the two HUMAN formats
    ``einvoice.report.LOCALISED_FORMATS`` — ``build_html`` and ``build_text`` —
    honour ``--lang``, with German document chrome and a truthful
    ``<html lang=…>``; the seven machine formats named in
    ``LANGUAGE_NEUTRAL_FORMATS`` are byte-identical with and without
    ``--lang de``. A rule with no official German keeps its English sentence,
    visibly marked ``[en]`` and tagged ``lang="en"``, and the one-argument
    ``build_html(report)`` the browser validator calls stays English.

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


# --------------------------------------------------------------------------- #
# T-VHRPTH.4 — the REPORT surfaces under --lang: the human HTML/text documents
# honour it, and the seven machine documents are pinned language-neutral.
#
# WHY THIS BLOCK EXISTS (measured at HEAD 544753e, before the fix): the entire
# buyer pool exists because of a GERMAN legal mandate, and the one artifact a
# German company forwards to its accountant could not be produced in German.
# `validate --profile xrechnung --lang de --format html broken.xml` emitted zero
# German rule sentences and opened `<html lang="en">` — the flag was accepted
# and silently dropped, so the user had every reason to believe a German
# document had been produced.
# --------------------------------------------------------------------------- #

#: The invoice the acceptance criteria and the onboarding docs both name: under
#: the xrechnung profile it fires BR-DE-2, which DOES carry official KoSIT
#: German, so it is the fixture that can tell "German rendered" from "German
#: silently dropped".
HTML_DE_FIXTURE = os.path.join(HERE, "examples", "01-missing-fields",
                               "broken.xml")


def _html(*argv):
    """``einvoice validate ... --format html`` stdout, through the real CLI."""
    with _Capture(list(argv)) as cap:
        pass
    return cap.out


class LanguageNeutralFormatsAreDeclared(unittest.TestCase):
    """The machine/human split is a NAMED decision, not per-emitter accident."""

    def test_the_seven_machine_formats_are_named(self):
        from einvoice.report import LANGUAGE_NEUTRAL_FORMATS
        self.assertEqual(
            sorted(LANGUAGE_NEUTRAL_FORMATS),
            ["azure", "badge", "github", "gitlab", "json", "junit", "sarif"])

    def test_the_partition_over_report_formats_is_total_and_disjoint(self):
        # A newly registered emitter cannot stay unclassified: it is either
        # declared machine-facing or it lands in LOCALISED_FORMATS and MUST
        # accept the lang render_report hands it.
        from einvoice.report import (LANGUAGE_NEUTRAL_FORMATS,
                                     LOCALISED_FORMATS, REPORT_FORMATS)
        self.assertEqual(LOCALISED_FORMATS, ("html", "text"),
                         "the localisable surfaces changed — that is a "
                         "decision, so restate it here deliberately")
        self.assertEqual(
            sorted(set(LANGUAGE_NEUTRAL_FORMATS) | set(LOCALISED_FORMATS)),
            sorted(REPORT_FORMATS))
        self.assertEqual(
            set(LANGUAGE_NEUTRAL_FORMATS) & set(LOCALISED_FORMATS), set())

    def test_the_reason_and_the_cross_reference_are_written_down(self):
        # The constant must carry its REASON and point at the one place that
        # owns per-entry-point flag decisions, instead of becoming a third
        # independent list nobody can trace.
        with open(os.path.join(HERE, "einvoice", "report.py"),
                  encoding="utf-8") as fh:
            src = fh.read()
        head = src.split("LANGUAGE_NEUTRAL_FORMATS = ")[0]
        comment = head[head.rindex("#: LANGUAGE"):]
        self.assertIn("ENTRY_POINT_CAPABILITIES", comment)
        self.assertIn("rule id", comment.lower())
        # ...and the over-broad claim the code contradicted is gone.
        self.assertNotIn(
            "report documents themselves are machine-facing and "
            "language-neutral", src)

    def test_machine_formats_are_byte_identical_with_and_without_lang_de(self):
        # END TO END through the console script, the surface a user types.
        from einvoice.report import LANGUAGE_NEUTRAL_FORMATS
        for fmt in LANGUAGE_NEUTRAL_FORMATS:
            with self.subTest(fmt=fmt):
                base = ["validate", HTML_DE_FIXTURE, "--profile=xrechnung",
                        "--format=%s" % fmt]
                with _Capture(base) as en:
                    pass
                with _Capture(base + ["--lang=de"]) as de:
                    pass
                self.assertEqual(en.rc, de.rc)
                self.assertEqual(
                    en.out, de.out,
                    "--lang de changed the %s body; machine consumers key on "
                    "rule ids and sarif/gitlab FINGERPRINT the message, so a "
                    "locale change would re-key every stored finding" % fmt)

    def test_render_report_drops_lang_for_every_machine_format(self):
        # The library-level guarantee, so a future caller that passes lang in
        # cannot localise a machine body even by accident.
        from einvoice.report import (build_report, render_report,
                                     LANGUAGE_NEUTRAL_FORMATS)
        rep = build_report(HTML_DE_FIXTURE, profile="xrechnung")
        for fmt in LANGUAGE_NEUTRAL_FORMATS:
            with self.subTest(fmt=fmt):
                self.assertEqual(render_report(rep, fmt),
                                 render_report(rep, fmt, lang="de"))
        # Precondition: this report really does carry a rule WITH official
        # German, so the equality above is not vacuous.
        self.assertTrue(
            any(R.official_message(v["rule"], "de") for v in rep["violations"]),
            "fixture drift: no finding carries official German, so the "
            "byte-identity assertions prove nothing")


class HtmlHonoursLang(unittest.TestCase):
    """``--format html`` under ``--lang de`` — the accountant's document."""

    def test_de_emits_official_german_and_declares_de(self):
        doc = _html("validate", HTML_DE_FIXTURE, "--profile=xrechnung",
                    "--lang=de", "--format=html")
        self.assertIn('<html lang="de">', doc)
        # The German sentence is the catalog's KoSIT text VERBATIM (escaped),
        # not a paraphrase authored here or by the emitter.
        official = CATALOG["BR-DE-2"]["message_de"]
        self.assertIn("Die Gruppe", official)   # sanity on the fixture data
        import html as _htmlmod
        self.assertIn(_htmlmod.escape(official, quote=True), doc)
        # German document chrome, so `lang="de"` is not a false declaration.
        self.assertIn("<title>einvoice Konformitätsbericht</title>", doc)
        self.assertIn("Nicht konform", doc)
        self.assertIn("Behebung", doc)
        self.assertNotIn("Not conformant", doc)
        self.assertNotIn("How to fix", doc)
        # THE INSTRUCTION ITSELF IS GERMAN. This is the whole point of a German
        # report: the line that tells an accountant what to change must not be
        # English prose under a German heading. Title and fix come from the
        # catalog's title_de/fix_de verbatim, so no English catalog sentence
        # survives anywhere in the document.
        from einvoice.report import _remediation_catalog, GERMAN_PROVENANCE
        cat = _remediation_catalog()
        for rid in ("BR-DE-2", "BR-DE-15"):
            entry = cat[rid]
            self.assertIn('<span class="title">%s</span>'
                          % _htmlmod.escape(entry["title_de"], quote=True), doc)
            self.assertIn('<dd>%s</dd>'
                          % _htmlmod.escape(entry["fix_de"], quote=True), doc)
            self.assertNotIn(_htmlmod.escape(entry["fix"], quote=True), doc)
        self.assertNotIn("Add the required element", doc)
        self.assertNotIn('<span class="title" lang="en">', doc)
        # PER-RULE PROVENANCE: every finding here is a `kosit` rule, so each
        # says its title/requires is the official KoSIT assert while its FIX is
        # still our translation — the distinction an adopter arguing with a
        # German tax authority actually needs.
        self.assertEqual({"kosit"},
                         {cat[r]["de_source"] for r in
                          ("BR-DE-2", "BR-DE-15", "BR-DE-TMP-32")})
        marker = _htmlmod.escape(GERMAN_PROVENANCE["kosit"], quote=True)
        self.assertEqual(3, doc.count(marker))
        self.assertNotIn(
            _htmlmod.escape(GERMAN_PROVENANCE["translation"], quote=True), doc)

    def test_english_default_did_not_drift(self):
        base = ["validate", HTML_DE_FIXTURE, "--profile=xrechnung",
                "--format=html"]
        doc = _html(*base)
        self.assertIn('<html lang="en">', doc)
        self.assertIn("EN 16931 / XRechnung conformance report", doc)
        self.assertIn("Not conformant", doc)
        self.assertIn("How to fix", doc)
        self.assertNotIn("Die Gruppe", doc)
        self.assertNotIn("lang=\"de\"", doc)
        # No element-level language tagging and no fallback marker leaks into
        # the English document — it is byte-for-byte the historic emitter.
        self.assertNotIn(' lang="en"', doc.split("\n", 2)[2])
        self.assertNotIn("[en]", doc)
        # An explicit --lang=en, the library default and the one-argument
        # browser call must all be the SAME bytes.
        from einvoice.report import build_report, build_html
        rep = build_report(HTML_DE_FIXTURE, profile="xrechnung")
        rep["source"] = HTML_DE_FIXTURE
        self.assertEqual(doc, _html(*(base + ["--lang=en"])))
        self.assertEqual(build_html(rep), build_html(rep, lang="en"))

    def test_browser_one_argument_call_is_english(self):
        # www/validate/index.html runs build_html(_rep) inside Pyodide on an
        # ENGLISH page; that call must stay valid and stay English.
        from einvoice.report import build_report, build_html
        doc = build_html(build_report(HTML_DE_FIXTURE, profile="xrechnung"))
        self.assertIn('<html lang="en">', doc)
        self.assertNotIn("Die Gruppe", doc)

    def test_a_rule_without_official_german_is_labelled_not_silently_english(
            self):
        # BR-CL-01 (the FALLBACK_FIXTURE's first fatal) is a CORE rule: no
        # official German exists, so the English sentence must survive AND say
        # so. Silence here is exactly how a reader comes to believe an English
        # sentence is the German legal wording.
        doc = _html("validate", FALLBACK_FIXTURE, "--lang=de",
                    "--format=html")
        self.assertIn('<html lang="de">', doc)
        self.assertIsNone(R.official_message("BR-CL-01", "de"),
                          "fixture drift: BR-CL-01 gained official German, so "
                          "this no longer exercises the fallback")
        self.assertIn("The document type code (BT-3)", doc)
        # Visible marker, and an element-level lang so the document's own
        # declaration stays true where the text is not German.
        self.assertIn('<p class="msg" lang="en">[en] ', doc)
        # ...explained in the document.
        self.assertIn("mit [en] markiert", doc)
        # The fallback is about the rule SENTENCE only. The rule TITLE and the
        # FIX HINT are German for every catalogued rule (the catalog ships
        # title_de/fix_de on all 297), so they render German and — being
        # German — carry NO lang="en" island, while the untranslated message
        # above keeps its own. The document used to claim the opposite in
        # words; that sentence is gone because it was false.
        import html as _esc
        from einvoice.report import _remediation_catalog, GERMAN_PROVENANCE
        entry = _remediation_catalog()["BR-CL-01"]
        self.assertNotIn('<span class="title" lang="en">', doc)
        self.assertIn('<span class="title">%s</span>'
                      % _esc.escape(entry["title_de"], quote=True), doc)
        self.assertIn('<dd>%s</dd>' % _esc.escape(entry["fix_de"], quote=True),
                      doc)
        self.assertNotIn(_esc.escape(entry["fix"], quote=True), doc)
        # ...and the document says, FOR THIS RULE, whose German that is. This
        # one is a project translation, not KoSIT text, and the marker is the
        # very string `--explain --lang=de` prints — one wording, not two.
        self.assertEqual("translation", entry["de_source"])
        self.assertIn(
            _esc.escape(GERMAN_PROVENANCE["translation"], quote=True), doc)
        self.assertNotIn(
            _esc.escape(GERMAN_PROVENANCE["kosit"], quote=True), doc)

    def test_no_fallback_note_marker_sentence_when_nothing_fell_back(self):
        # Every finding of this fixture carries official German, so the note
        # must NOT point at an [en] marker that is not on the page.
        doc = _html("validate", HTML_DE_FIXTURE, "--profile=xrechnung",
                    "--lang=de", "--format=html")
        self.assertNotIn("[en]", doc)
        self.assertIn("amtliche KoSIT-Wortlaut", doc)

    def test_html_and_text_surfaces_show_the_same_german_sentence(self):
        # ONE resolver, so the forwarded document and the terminal cannot
        # phrase the same rule differently.
        doc = _html("validate", HTML_DE_FIXTURE, "--profile=xrechnung",
                    "--lang=de", "--format=html")
        with _Capture(["validate", HTML_DE_FIXTURE, "--profile=xrechnung",
                       "--lang=de"]) as summary:
            pass
        sentence = R.resolve_message("BR-DE-2", "unused-english", "de")
        self.assertIn(sentence, summary.out)
        import html as _htmlmod
        self.assertIn(_htmlmod.escape(sentence, quote=True), doc)

    def test_unknown_language_renders_english_and_declares_english(self):
        # Declaring a language whose text we do not have is the very lie this
        # parameter fixes, so an unroutable value must fall back honestly.
        # (The CLI rejects such a value with exit 2 long before this; the
        # library must still not lie if called directly.)
        from einvoice.report import build_report, build_html
        rep = build_report(HTML_DE_FIXTURE, profile="xrechnung")
        doc = build_html(rep, lang="fr")
        self.assertIn('<html lang="en">', doc)
        self.assertEqual(doc, build_html(rep))

    def test_report_entry_point_still_refuses_lang_for_a_document(self):
        # The declared divergence stays: einvoice.report's published contract
        # is the machine document, so it refuses rather than swallows.
        with _Capture(["--lang", "de", "--format", "html", HTML_DE_FIXTURE],
                      fn=report_main) as cap:
            pass
        self.assertNotEqual(cap.rc, EXIT_OK)
        self.assertIn("--lang applies only to --explain", cap.err)
        self.assertEqual(cap.out, "")


class HtmlChromeTable(unittest.TestCase):
    """The authored chrome table: complete per language, honest when not."""

    def test_every_language_row_covers_every_english_key(self):
        from einvoice.report import _HTML_CHROME
        english = set(_HTML_CHROME["en"])
        for lang, table in _HTML_CHROME.items():
            with self.subTest(lang=lang):
                self.assertEqual(
                    english - set(table), set(),
                    "language %r is missing chrome keys; the document would "
                    "render them English with a [en] marker" % lang)
                self.assertEqual(set(table) - english, set(),
                                 "language %r has keys English lacks" % lang)

    def test_a_missing_key_falls_back_to_english_visibly(self):
        # The fallback is EXPLICIT and VISIBLE: a partially translated document
        # must say so on its face rather than quietly mix languages.
        from einvoice.report import _chrome, _HTML_CHROME
        self.assertEqual(_chrome("h1", "en"), _HTML_CHROME["en"]["h1"])
        self.assertEqual(_chrome("h1", "fr"),
                         _HTML_CHROME["en"]["h1"] + " [en]")
        _HTML_CHROME["zz"] = {"h1": "ZZ heading"}
        try:
            self.assertEqual(_chrome("h1", "zz"), "ZZ heading")
            self.assertEqual(_chrome("footer", "zz"),
                             _HTML_CHROME["en"]["footer"] + " [en]")
        finally:
            del _HTML_CHROME["zz"]

    def test_chrome_does_not_translate_rule_text(self):
        # Rule wording comes ONLY from the catalog. Nothing in the chrome table
        # may look like a rule sentence, or we would be authoring legal text.
        from einvoice.report import _HTML_CHROME
        for lang, table in _HTML_CHROME.items():
            for key, value in table.items():
                with self.subTest(lang=lang, key=key):
                    self.assertNotIn("BR-", value)
                    self.assertNotIn("muss übermittelt werden", value)


class GermanProvenanceFooter(unittest.TestCase):
    """The provenance footer, German side (T-VHRPTH.2).

    The German document is the one the German mandate's users actually forward,
    so its provenance footer has to be GERMAN — an ``[en]`` marker on the footer
    of a ``lang="de"`` document is the same false declaration ``--lang`` exists
    to fix. Every expected value here is read at test time from the payload
    ``einvoice info`` prints; nothing is a literal.
    """

    def _payload(self):
        from einvoice.cli import _info_payload
        return _info_payload()

    def _footer(self, doc):
        m = re.search(r"<footer>(.*?)</footer>", doc, re.S)
        self.assertIsNotNone(m, "the document has no <footer>")
        return m.group(1)

    def test_de_footer_carries_the_same_three_engine_facts(self):
        p = self._payload()
        self.assertRegex(p.get("attestation_sha256") or "", r"^[0-9a-f]{64}$")
        doc = _html("validate", HTML_DE_FIXTURE, "--profile=xrechnung",
                    "--lang=de", "--format=html")
        footer = self._footer(doc)
        for value in (p["version"], str(p["rule_count"]),
                      p["attestation_sha256"]):
            self.assertIn(value, footer,
                          "the German report omits %r — the facts are "
                          "language-independent" % value)

    def test_de_footer_prose_is_german_with_no_en_fallback_marker(self):
        from einvoice.report import (_CHROME_FALLBACK_SUFFIX, _HTML_CHROME,
                                     _h)
        de = _HTML_CHROME["de"]
        en = _HTML_CHROME["en"]
        keys = ("provenance_engine", "provenance_rules", "provenance_digest",
                "provenance_legal_note")
        doc = _html("validate", HTML_DE_FIXTURE, "--profile=xrechnung",
                    "--lang=de", "--format=html")
        footer = self._footer(doc)
        self.assertNotIn(_CHROME_FALLBACK_SUFFIX.strip(), footer,
                         "the German footer self-labels [en]: a provenance "
                         "string is missing from the de chrome row")
        for key in keys:
            with self.subTest(key=key):
                self.assertIn(key, de, "de chrome row lacks %r" % key)
                self.assertNotEqual(de[key], en[key],
                                    "%r is not actually translated" % key)
                self.assertIn(_h(de[key]), footer)
                self.assertNotIn(_h(en[key]), footer)

    def test_legal_note_reuses_the_sites_claim_in_each_language(self):
        # ONE claim, two languages, both already published on the site under
        # `green-not-legal-conformance` — quoted here, not re-authored, and
        # never machine-translated.
        from einvoice.report import _HTML_CHROME, _h
        en = _HTML_CHROME["en"]["provenance_legal_note"]
        de = _HTML_CHROME["de"]["provenance_legal_note"]
        self.assertGreater(len(en), 40, en)
        self.assertGreater(len(de), 40, de)
        self.assertNotEqual(en, de)
        # The German wording is the German one, phrase for phrase.
        self.assertIn("keine implementierte fatale Regel hat ausgelöst", de)
        self.assertIn("rechtsverbindlich konforme XRechnung", de)
        self.assertIn("no implemented fatal rule fired", en)
        self.assertIn("certified legally conformant", en)
        # Each language's document carries ITS OWN sentence and not the other's.
        de_doc = _html("validate", HTML_DE_FIXTURE, "--profile=xrechnung",
                       "--lang=de", "--format=html")
        en_doc = _html("validate", HTML_DE_FIXTURE, "--profile=xrechnung",
                       "--format=html")
        self.assertIn(_h(de), de_doc)
        self.assertNotIn(_h(en), de_doc)
        self.assertIn(_h(en), en_doc)
        self.assertNotIn(_h(de), en_doc)

    def test_the_de_claim_matches_the_published_german_page(self):
        # Drift guard with teeth: the sentence in the report must still be the
        # sentence the site publishes for `green-not-legal-conformance`. Read
        # the claim span straight out of the generated German page.
        import html as _htmlmod
        from einvoice.report import _HTML_CHROME
        page = os.path.join(HERE, "www", "de", "index.html")
        with open(page, encoding="utf-8") as fh:
            markup = fh.read()
        m = re.search(
            r'<span data-claim="green-not-legal-conformance">(.*?)</span>',
            markup, re.S)
        self.assertIsNotNone(m, "the German page no longer carries the claim")
        published = _htmlmod.unescape(re.sub(r"<[^>]+>", "", m.group(1)))
        note = _HTML_CHROME["de"]["provenance_legal_note"]
        # The published span is one clause of a longer sentence, so compare on
        # the substantive phrases rather than on punctuation the report restates.
        for phrase in ("keine implementierte fatale Regel hat ausgelöst",
                       "rechtsverbindlich konforme XRechnung"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, published,
                              "the German site claim changed wording")
                self.assertIn(phrase, note,
                              "the report's German note drifted from the site")


class TextFormatHonoursLang(unittest.TestCase):
    """``build_text`` — the other human surface in LOCALISED_FORMATS."""

    def test_de_swaps_the_message_and_keeps_the_status_token(self):
        from einvoice.report import build_report, build_text, render_report
        rep = build_report(HTML_DE_FIXTURE, profile="xrechnung")
        en, de = build_text(rep), build_text(rep, lang="de")
        self.assertIn("Die Gruppe", de)
        self.assertNotIn("Die Gruppe", en)
        # Grep-stable facts are language-independent in both.
        for out in (en, de):
            self.assertTrue(out.startswith("FAIL  "))
            self.assertIn("[fatal] BR-DE-2:", out)
        self.assertEqual(de, render_report(rep, "text", lang="de"))
        self.assertEqual(en, render_report(rep, "text"))


if __name__ == "__main__":
    unittest.main(verbosity=2)

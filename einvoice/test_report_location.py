#!/usr/bin/env python3
"""test_report_location.py — the two optional position fields on a finding.

Task T-VHDIAG.1 (`source_line`): an attributable FIELD-LEVEL violation must
carry the correct 1-based parser line of its offending element, while a
DOCUMENT-LEVEL / absence violation must carry no source line at all — and the
enriched report must still validate against the committed report.schema.json.

Task T-VHLOC.4 (`insertion_point_line`): the OTHER half of the findings — the
absences, which by construction have no offending element — get an honest
anchor instead, declared and bounded by :data:`INSERTION_POINT_LINE` below.

Fast, stdlib-only, saxonche-free, offline. Fixtures are synthesized inline (no
real company data) except the committed onboarding example the insertion-point
cases read. Every expected line number is computed from the fixture text, never
hard-coded, so the assertions cannot silently drift.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.report import build_report                     # noqa: E402
from einvoice.validate import validate_file                  # noqa: E402
from test_report_schema import schema_errors, load_schema    # noqa: E402


# ---------------------------------------------------------------------------
# INSERTION_POINT_LINE — the declared behaviour of the `insertion_point_line`
# field (einvoice.validate._insertion_point_line + _stamp_insertion_points).
# This constant is the contract; the tests below measure it. Read it before
# changing the resolver.
#
# WHAT IT IS
#   The 1-based parser line of the DEEPEST element of a finding's path that the
#   document ACTUALLY CONTAINS — i.e. the element the missing thing would have
#   to be inserted into. It is NOT the site of an error: nothing on that line is
#   wrong. It answers "where does the fix go?", not "what is broken?".
#
# COVERED (the field IS emitted)
#   * An absence finding whose path has a resolvable, unambiguous ancestor
#     chain. Worked example, the case this task exists for:
#     BR-DE-2 on examples/01-missing-fields/broken.xml carries
#     element="cac:AccountingSupplierParty/cac:Party/cac:Contact"; the invoice
#     has the supplier party and its <cac:Party> but no <cac:Contact>, so the
#     anchor is the line <cac:Party> opens on (28 in today's fixture — the test
#     recomputes it from the file rather than trusting that number).
#   * RELATIVE paths ("cac:X/cac:Y") and ABSOLUTE ones ("/ubl:Invoice/cac:X"),
#     the two shapes the rules and the remediation catalog actually use.
#   * Namespace-tolerant matching by localname, in BOTH syntaxes: UBL cac:/cbc:
#     and CII ram:/rsm: paths go through the same one post-pass in
#     validate_root, so the syntaxes cannot drift apart.
#   * The catalog `location` hint as a FALLBACK source of the path, used only
#     when the finding's own `element` is empty.
#
# DELIBERATELY NOT COVERED (the key is ABSENT — never 0, never a guess)
#   * A finding that already carries `source_line`. The two fields are mutually
#     exclusive: a proven error site is not an insertion point, so a finding
#     never carries both.
#   * A path whose FIRST named segment is already missing — BR-DE-15
#     ("cbc:BuyerReference", the leaf is the only segment) and BR-DE-TMP-32
#     ("cac:Delivery/cbc:ActualDeliveryDate", cac:Delivery itself is absent).
#     Only the document root would resolve, and "insert it somewhere in the
#     invoice" is not attribution.
#   * A path that fully resolves. Then the named element exists, the finding is
#     about its VALUE (e.g. BR-CO-17 on a wrong VAT amount), and reporting a
#     line for it would be an error site mislabelled as an insertion point.
#   * An AMBIGUOUS chain: a segment matching more than one child, e.g. any
#     "cac:InvoiceLine/..." path on a multi-line invoice, or
#     "cac:TaxTotal/cac:TaxSubtotal/..." on an invoice with two VAT breakdowns.
#     The path does not say which occurrence, and the shared parent would be a
#     guess. (This is the biggest coverage gap and it is intentional: closing it
#     needs the rules to hand over the concrete Element, not a smarter string
#     walk.)
#   * A path we cannot fully parse — predicates, wildcards, attribute steps,
#     "//", prose — and any element the parser left without a line stamp.
#   * Rendering. T-VHLOC.4 shipped the field on the two JSON surfaces only.
#     T-VHLOC.6 added the HUMAN rendering and declared, per format, which
#     surfaces show it — see :data:`INSERTION_POINT_SURFACES` immediately below,
#     which is now the rendering half of this contract.
# ---------------------------------------------------------------------------
INSERTION_POINT_LINE = "insertion_point_line"

#: The RENDERING half of the insertion-point contract (T-VHLOC.6), declared per
#: position-capable format. ``format -> (renders_insertion_point, reason)``.
#:
#: THE DIVIDING LINE is the SEMANTIC of the position each format carries, not
#: the format's age or importance:
#:
#:   * A HUMAN surface renders prose a person reads, so it can afford — and is
#:     required to use — a token that says "insertion point" in words. The
#:     reader is told the difference explicitly and cannot mistake the anchor
#:     for an error site.
#:   * A MACHINE/CI surface carries ONE bare integer whose meaning is fixed by
#:     the vendor as "the problem is here" (SARIF ``region.startLine``, GitHub
#:     ``line=``, Azure ``linenumber=``, GitLab ``location.lines.begin``). There
#:     is no field in which to say "…but this one means something else". Feeding
#:     it an insertion point would put a red squiggle on an INNOCENT line — on
#:     ``examples/01-missing-fields/broken.xml`` that is line 28, the perfectly
#:     valid ``<cac:Party>`` open tag. A wrong annotation is worse than no
#:     annotation, so these formats DECLINE. The datum is not lost: ``--format
#:     json`` carries ``insertion_point_line`` under its own distinct key, where
#:     a consumer that understands the difference can act on it.
#:
#: T-VHLOC.7 reads this dict as its allowlist, so it is a data structure, not
#: prose, and ``DeclaredInsertionPointSurfaces`` below MEASURES every entry
#: against the real emitters — a verdict flipped here without the emitter
#: changing (or vice versa) fails the suite.
INSERTION_POINT_SURFACES = {
    "text": (True, "human report; renders ' (insertion point <file>:<line>)', "
                   "worded so it cannot be read as the error site"),
    "batch-text": (True, "human per-file listing in build_batch_text; same "
                         "token and same wording as the single-file report"),
    "junit": (True, "the <failure>/<system-out> BODY is human prose a CI test "
                    "pane shows; testcase attributes are untouched"),
    "json": (True, "carries it as the separate 'insertion_point_line' KEY "
                   "(T-VHLOC.4), never merged into 'source_line'"),
    "sarif": (False, "region.startLine means 'the problem is here'; a code "
                     "scanning alert on line 28 would flag a valid element"),
    "github": (False, "::error line= anchors a PR annotation to the offending "
                      "line; an insertion point would annotate innocent code"),
    "azure": (False, "##vso[task.logissue linenumber=] is the same 'problem is "
                     "here' anchor as GitHub's, so it declines identically"),
    "gitlab": (False, "location.lines.begin identifies the defect's location "
                      "in a Code Quality report; an anchor is not a defect"),
    "html": (False, "renders NO position of any kind today, not even "
                    "source_line, so there is nothing to be consistent with"),
}

#: The token every rendering surface must contain, lower-cased. Pinned as a
#: constant so the honesty rule ("this is where the fix GOES, not where the
#: error IS") is mechanically checkable and cannot be quietly collapsed back
#: into the ``at <file>:<line>`` shape ``source_line`` owns.
INSERTION_POINT_TOKEN = "insertion point"

#: The committed onboarding example the insertion-point cases measure: a real
#: XRechnung invoice with the BG-6 SELLER CONTACT group and the BT-10 buyer
#: reference removed. Used instead of an inline string so the test proves the
#: behaviour on the document a first-time user actually runs.
BROKEN_EXAMPLE = os.path.join(HERE, "examples", "01-missing-fields",
                              "broken.xml")


# A minimal UBL Invoice whose DocumentCurrencyCode (BT-5) is PRESENT but not a
# valid ISO 4217 code -> fires the field-level BR-CL-04, which holds the concrete
# element and can attribute its line. It has NO invoice line -> fires the
# document-level BR-16 ("An Invoice shall have at least one Invoice line"), which
# is an absence rule and must carry NO source line. Each element sits on its own
# line so the expected line number is unambiguous. "ZZ" is deliberately not a
# real currency code.
INVALID_UBL = (
    '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"\n'
    '         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:'
    'CommonBasicComponents-2"\n'
    '         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:'
    'CommonAggregateComponents-2">\n'
    '  <cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID>\n'
    '  <cbc:ID>INV-LOC-1</cbc:ID>\n'
    '  <cbc:IssueDate>2026-01-01</cbc:IssueDate>\n'
    '  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>\n'
    '  <cbc:DocumentCurrencyCode>ZZ</cbc:DocumentCurrencyCode>\n'
    '</Invoice>\n'
)


def _expected_line(xml_text, needle):
    """The 1-based line of the first line containing ``needle`` (expat's
    CurrentLineNumber for a start tag is the line the tag opens on)."""
    for i, line in enumerate(xml_text.splitlines(), start=1):
        if needle in line:
            return i
    raise AssertionError("needle %r not found in fixture" % needle)


class SourceLineOnFieldLevelViolation(unittest.TestCase):
    def _report(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "invalid.xml")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(INVALID_UBL)
            return build_report(path, profile="en16931")

    def test_field_level_violation_carries_correct_source_line(self):
        report = self._report()
        by_rule = {v["rule"]: v for v in report["violations"]}
        self.assertIn("BR-CL-04", by_rule,
                      "expected the invalid-currency rule to fire: %s"
                      % list(by_rule))
        rec = by_rule["BR-CL-04"]
        self.assertIn("source_line", rec,
                      "an attributable field-level violation must carry "
                      "source_line: %s" % rec)
        self.assertIsInstance(rec["source_line"], int)
        self.assertNotIsInstance(rec["source_line"], bool)
        expected = _expected_line(INVALID_UBL, "<cbc:DocumentCurrencyCode>")
        self.assertEqual(rec["source_line"], expected,
                         "source_line must be the real line of the element")

    def test_document_level_violation_has_no_source_line(self):
        report = self._report()
        by_rule = {v["rule"]: v for v in report["violations"]}
        self.assertIn("BR-16", by_rule,
                      "expected the no-invoice-line rule to fire: %s"
                      % list(by_rule))
        rec = by_rule["BR-16"]
        # Absence / document-level rule: the key is omitted entirely (or null),
        # never a guessed line.
        self.assertIsNone(rec.get("source_line"),
                          "a document-level/absence violation must not carry a "
                          "source line: %s" % rec)
        self.assertNotIn("source_line", rec, rec)

    def test_enriched_report_still_schema_validates(self):
        report = self._report()
        errors = schema_errors(report, load_schema())
        self.assertEqual(errors, [],
                         "report carrying source_line must still validate:\n%s"
                         % "\n".join(errors))


class SourceLineOnHumanJson(unittest.TestCase):
    """The same optional key must surface on the `einvoice validate --json`
    per-violation projection (validate.Result.to_dict)."""

    def _to_dict(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "invalid.xml")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(INVALID_UBL)
            return validate_file(path, profile="en16931").to_dict(source=path)

    def test_json_field_level_has_line_document_level_does_not(self):
        d = self._to_dict()
        by_rule = {v["rule"]: v for v in d["violations"]}
        self.assertIn("BR-CL-04", by_rule, by_rule)
        self.assertIn("BR-16", by_rule, by_rule)
        expected = _expected_line(INVALID_UBL, "<cbc:DocumentCurrencyCode>")
        self.assertEqual(by_rule["BR-CL-04"].get("source_line"), expected,
                         by_rule["BR-CL-04"])
        self.assertNotIn("source_line", by_rule["BR-16"], by_rule["BR-16"])


# ---------------------------------------------------------------------------
# insertion_point_line (T-VHLOC.4) — see the INSERTION_POINT_LINE contract above.
# ---------------------------------------------------------------------------

def _read(path):
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def _line_of_child_after(xml_text, parent_needle, child_needle):
    """1-based line of the first ``child_needle`` at/after ``parent_needle``.

    Computed from the fixture text so the expectation tracks the file: if the
    example invoice is ever reflowed or a comment is added, the assertion moves
    with it instead of going stale on a hard-coded number.
    """
    lines = xml_text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if parent_needle in line:
            start = i
            break
    if start is None:
        raise AssertionError("parent %r not found in fixture" % parent_needle)
    for i in range(start, len(lines)):
        if child_needle in lines[i]:
            return i + 1
    raise AssertionError("child %r not found after %r"
                         % (child_needle, parent_needle))


class InsertionPointOnAbsenceFindings(unittest.TestCase):
    """The absence half of the findings gets an honest anchor.

    Measured on the committed onboarding example — the FIRST document a new
    user validates — at the xrechnung profile, which is the German CIUS layer
    where the missing-group failure mode lives.
    """

    def setUp(self):
        self.text = _read(BROKEN_EXAMPLE)
        self.report = build_report(BROKEN_EXAMPLE, profile="xrechnung")
        self.by_rule = {v["rule"]: v for v in self.report["violations"]}
        self.json = validate_file(
            BROKEN_EXAMPLE, profile="xrechnung"
        ).to_dict(source=BROKEN_EXAMPLE)
        self.json_by_rule = {v["rule"]: v for v in self.json["violations"]}

    def test_br_de_2_anchors_on_the_existing_party_element(self):
        # BR-DE-2 wants cac:AccountingSupplierParty/cac:Party/cac:Contact. The
        # supplier party and its <cac:Party> exist; only <cac:Contact> is gone,
        # so the insertion point is the <cac:Party> line.
        self.assertIn("BR-DE-2", self.by_rule, list(self.by_rule))
        expected = _line_of_child_after(
            self.text, "<cac:AccountingSupplierParty>", "<cac:Party>")
        for surface, rec in (("report", self.by_rule["BR-DE-2"]),
                             ("validate --json",
                              self.json_by_rule["BR-DE-2"])):
            self.assertIn(INSERTION_POINT_LINE, rec,
                          "%s: BR-DE-2 must carry an insertion point: %s"
                          % (surface, rec))
            self.assertIsInstance(rec[INSERTION_POINT_LINE], int)
            self.assertNotIsInstance(rec[INSERTION_POINT_LINE], bool)
            self.assertEqual(rec[INSERTION_POINT_LINE], expected,
                             "%s: insertion point must be the <cac:Party> line"
                             % surface)

    def test_unanchorable_absences_carry_nothing(self):
        # BR-DE-15    -> "cbc:BuyerReference": the leaf is the only named
        #                segment and it is absent, so only the root would
        #                resolve -> nothing.
        # BR-DE-TMP-32-> "cac:Delivery/cbc:ActualDeliveryDate": cac:Delivery
        #                itself is absent -> nothing.
        for rule in ("BR-DE-15", "BR-DE-TMP-32"):
            self.assertIn(rule, self.by_rule, list(self.by_rule))
            for surface, table in (("report", self.by_rule),
                                   ("validate --json", self.json_by_rule)):
                rec = table[rule]
                self.assertNotIn(
                    INSERTION_POINT_LINE, rec,
                    "%s: %s has no resolvable named ancestor and must carry no "
                    "insertion point: %s" % (surface, rule, rec))

    def test_exactly_one_finding_is_anchored_on_this_example(self):
        anchored = [v["rule"] for v in self.report["violations"]
                    if INSERTION_POINT_LINE in v]
        self.assertEqual(anchored, ["BR-DE-2"],
                         "expected exactly BR-DE-2 to be anchored, got %s"
                         % anchored)

    def test_no_finding_carries_a_source_line_on_this_example(self):
        # The pre-existing contract this task must not weaken: all three
        # findings here are absences, so NONE of them is attributable to an
        # offending element.
        for v in self.report["violations"]:
            self.assertNotIn("source_line", v, v)
        for v in self.json["violations"]:
            self.assertNotIn("source_line", v, v)

    def test_report_with_insertion_point_still_schema_validates(self):
        errors = schema_errors(self.report, load_schema())
        self.assertEqual(errors, [],
                         "report carrying insertion_point_line must still "
                         "validate:\n%s" % "\n".join(errors))


class InsertionPointAndSourceLineAreMutuallyExclusive(unittest.TestCase):
    def _reports(self):
        """Both JSON surfaces for the field-level fixture AND the example."""
        out = []
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "invalid.xml")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(INVALID_UBL)
            out.append(build_report(path, profile="en16931"))
            out.append(validate_file(path, profile="en16931")
                       .to_dict(source=path))
        out.append(build_report(BROKEN_EXAMPLE, profile="xrechnung"))
        out.append(validate_file(BROKEN_EXAMPLE, profile="xrechnung")
                   .to_dict(source=BROKEN_EXAMPLE))
        return out

    def test_no_record_carries_both_fields(self):
        for doc in self._reports():
            for rec in doc["violations"]:
                self.assertFalse(
                    "source_line" in rec and INSERTION_POINT_LINE in rec,
                    "a finding must never claim both an error site and an "
                    "insertion point: %s" % rec)

    def test_field_level_source_line_is_unchanged_and_unanchored(self):
        # The T-VHDIAG.1 contract, re-measured here: BR-CL-04 still carries its
        # real source_line, and gaining a NEW optional field did not give it a
        # spurious insertion point.
        expected = _expected_line(INVALID_UBL, "<cbc:DocumentCurrencyCode>")
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "invalid.xml")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(INVALID_UBL)
            report = build_report(path, profile="en16931")
            doc = validate_file(path, profile="en16931").to_dict(source=path)
        for surface, payload in (("report", report), ("validate --json", doc)):
            rec = {v["rule"]: v for v in payload["violations"]}["BR-CL-04"]
            self.assertEqual(rec["source_line"], expected, surface)
            self.assertNotIn(INSERTION_POINT_LINE, rec,
                             "%s: a finding with a proven element must not "
                             "gain an insertion point: %s" % (surface, rec))


class InsertionPointResolverBoundaries(unittest.TestCase):
    """Direct unit tests of the resolver for the cases INSERTION_POINT_LINE
    declares out of scope — the honest-silence half of the contract."""

    def setUp(self):
        from einvoice.parser import parse_file
        self.root = parse_file(BROKEN_EXAMPLE)
        self.text = _read(BROKEN_EXAMPLE)
        from einvoice.validate import _insertion_point_line
        self.resolve = _insertion_point_line

    def test_absolute_and_relative_paths_agree(self):
        expected = _line_of_child_after(
            self.text, "<cac:AccountingSupplierParty>", "<cac:Party>")
        self.assertEqual(
            self.resolve(
                self.root,
                "cac:AccountingSupplierParty/cac:Party/cac:Contact"),
            expected)
        self.assertEqual(
            self.resolve(
                self.root,
                "/ubl:Invoice/cac:AccountingSupplierParty/cac:Party/"
                "cac:Contact"),
            expected)

    def test_absolute_path_rooted_elsewhere_resolves_to_nothing(self):
        self.assertIsNone(self.resolve(
            self.root,
            "/rsm:CrossIndustryInvoice/ram:SellerTradeParty/ram:Name"))

    def test_ambiguous_repeated_parent_resolves_to_nothing(self):
        # The example has TWO <cac:InvoiceLine> elements, so this path cannot
        # say which line the missing cac:Delivery belongs to.
        self.assertEqual(self.text.count("<cac:InvoiceLine>"), 2)
        self.assertIsNone(self.resolve(
            self.root, "cac:InvoiceLine/cac:Delivery"))

    def test_fully_resolving_path_is_not_an_insertion_point(self):
        self.assertIsNone(self.resolve(
            self.root, "cac:AccountingSupplierParty/cac:Party"))

    def test_root_is_never_the_answer(self):
        self.assertIsNone(self.resolve(self.root, "cbc:BuyerReference"))
        self.assertIsNone(self.resolve(self.root, "/ubl:Invoice"))
        self.assertIsNone(self.resolve(self.root, "ubl:Invoice"))

    def test_unparseable_paths_resolve_to_nothing(self):
        for path in ("", "   ", None,
                     "//cac:Party",
                     "cac:AccountingSupplierParty/cac:Party[1]/cac:Contact",
                     "cac:AccountingSupplierParty/*/cac:Contact",
                     "cac:AccountingSupplierParty/cac:Party/@schemeID",
                     "normalize-space(cbc:ID) = 'E'"):
            self.assertIsNone(self.resolve(self.root, path),
                              "path %r must not resolve" % (path,))


# ---------------------------------------------------------------------------
# T-VHLOC.6 — the RENDERING half. Everything below measures
# INSERTION_POINT_SURFACES against the real emitters.
# ---------------------------------------------------------------------------

def _strip_insertion_points(report):
    """A deep-ish copy of ``report`` with every ``insertion_point_line`` gone.

    The control group for "a finding without an anchor reads EXACTLY as it did
    before": rendering this copy reproduces the pre-T-VHLOC.6 bytes of every
    surface, because the field is the ONLY input the task added.
    """
    out = dict(report)
    out["violations"] = [{k: val for k, val in v.items()
                          if k != INSERTION_POINT_LINE}
                         for v in report.get("violations", [])]
    return out


def _with_insertion_point(report, rule, value):
    """``report`` with ``rule``'s ``insertion_point_line`` forced to ``value``.

    Used to drive the hostile inputs (``True``, ``0``, ``"28"``, ...) a
    hand-edited or third-party report dict can carry through the SAME emitters
    the engine feeds, without weakening the engine's own guarantees.
    """
    out = _strip_insertion_points(report)
    for v in out["violations"]:
        if v["rule"] == rule:
            v[INSERTION_POINT_LINE] = value
    return out


class DeclaredInsertionPointSurfaces(unittest.TestCase):
    """INSERTION_POINT_SURFACES is a CONTRACT, not a comment: every entry is
    re-measured here against the emitter it names, so the declaration and the
    code cannot drift. T-VHLOC.7 consumes this dict as its allowlist."""

    def setUp(self):
        from einvoice.report import REPORT_FORMATS
        self.formats = REPORT_FORMATS
        self.report = build_report(BROKEN_EXAMPLE, profile="xrechnung")
        self.by_rule = {v["rule"]: v for v in self.report["violations"]}

    def _render(self, fmt, report=None):
        from einvoice.report import render_report
        return render_report(report if report is not None else self.report,
                             fmt)

    def test_declaration_is_machine_readable(self):
        self.assertIsInstance(INSERTION_POINT_SURFACES, dict)
        for fmt, verdict in INSERTION_POINT_SURFACES.items():
            self.assertIsInstance(fmt, str)
            self.assertIsInstance(verdict, tuple, fmt)
            self.assertEqual(len(verdict), 2, fmt)
            renders, reason = verdict
            self.assertIsInstance(renders, bool, fmt)
            self.assertIsInstance(reason, str, fmt)
            self.assertTrue(reason.strip(), "%s: needs a real reason" % fmt)

    def test_declaration_names_every_real_format(self):
        # Every declared key is a real emitter ("batch-text" is the batch leg of
        # the "text" one), and every format that carries ANY position concept is
        # declared. "badge" is the only omission and it is deliberate: it emits
        # a shields.io colour/label pair with no per-finding structure at all.
        for fmt in INSERTION_POINT_SURFACES:
            self.assertIn(fmt.replace("batch-", ""), self.formats, fmt)
        for fmt in ("text", "junit", "json", "sarif", "github", "azure",
                    "gitlab", "html"):
            self.assertIn(fmt, INSERTION_POINT_SURFACES,
                          "position-capable format %r must declare a verdict"
                          % fmt)
        self.assertNotIn("badge", INSERTION_POINT_SURFACES)

    def test_the_example_still_carries_exactly_one_anchor(self):
        # Everything below is only meaningful while BR-DE-2 really is anchored
        # and the other two really are not.
        anchored = {v["rule"]: v[INSERTION_POINT_LINE]
                    for v in self.report["violations"]
                    if INSERTION_POINT_LINE in v}
        self.assertEqual(list(anchored), ["BR-DE-2"], anchored)
        self.assertGreaterEqual(anchored["BR-DE-2"], 1)

    def test_rendering_surfaces_show_the_declared_token(self):
        line = self.by_rule["BR-DE-2"][INSERTION_POINT_LINE]
        src = self.report["source"]
        expected = " (insertion point %s:%d)" % (src, line)
        for fmt, (renders, _reason) in sorted(
                INSERTION_POINT_SURFACES.items()):
            if not renders or fmt == "json":
                continue          # json is checked by KEY, see the test below
            out = (self._batch_text() if fmt == "batch-text"
                   else self._render(fmt))
            self.assertIn(expected, out,
                          "%s declares it renders the insertion point but the "
                          "emitter does not:\n%s" % (fmt, out))
            self.assertIn(INSERTION_POINT_TOKEN, out.lower(), fmt)

    def test_json_carries_it_as_its_own_key_not_as_prose(self):
        # The machine surface's contract is different in kind: a separate KEY,
        # never merged into source_line and never rendered as a sentence.
        doc = json.loads(self._render("json"))
        rec = {v["rule"]: v for v in doc["violations"]}["BR-DE-2"]
        self.assertEqual(rec[INSERTION_POINT_LINE],
                         self.by_rule["BR-DE-2"][INSERTION_POINT_LINE])
        self.assertNotIn("source_line", rec)
        self.assertNotIn(INSERTION_POINT_TOKEN, self._render("json").lower())

    def test_declining_surfaces_render_no_insertion_point_at_all(self):
        # Not merely "no prose token": the vendor LINE property must stay absent
        # too, because that is the failure this decision exists to prevent — an
        # annotation anchored to line 28 would flag a perfectly valid
        # <cac:Party> element as the defect.
        line = self.by_rule["BR-DE-2"][INSERTION_POINT_LINE]
        for fmt, (renders, _reason) in sorted(
                INSERTION_POINT_SURFACES.items()):
            if renders:
                continue
            out = self._render(fmt)
            self.assertNotIn("insertion", out.lower(),
                             "%s declined but leaked the token" % fmt)
            self.assertEqual(out, self._render(
                fmt, _strip_insertion_points(self.report)),
                "%s must be byte-identical with and without the field" % fmt)
        sarif = json.loads(self._render("sarif"))
        for result in sarif["runs"][0]["results"]:
            for loc in result["locations"]:
                self.assertNotIn("region", loc["physicalLocation"],
                                 result["ruleId"])
        self.assertNotIn("line=", self._render("github"))
        self.assertNotIn("linenumber=", self._render("azure"))
        for entry in json.loads(self._render("gitlab")):
            self.assertNotIn("lines", entry["location"], entry["check_name"])
        self.assertNotIn(str(line), self._render("github"))

    def _batch_text(self):
        from einvoice.report import (build_batch_report_from_files,
                                     build_batch_text)
        batch = build_batch_report_from_files(
            [BROKEN_EXAMPLE], profile="xrechnung",
            root=os.path.dirname(BROKEN_EXAMPLE))
        return build_batch_text(batch)


class InsertionPointRenderingIsHonest(unittest.TestCase):
    """The three rules the rendering must never break: it is distinguishable
    from a source line, it is absent when nothing resolved, and it degrades on
    a hostile value instead of printing nonsense."""

    HUMAN = ("text", "junit")

    def setUp(self):
        self.report = build_report(BROKEN_EXAMPLE, profile="xrechnung")
        self.src = self.report["source"]
        self.line = {v["rule"]: v for v in self.report["violations"]
                     }["BR-DE-2"][INSERTION_POINT_LINE]

    def _render(self, fmt, report=None):
        from einvoice.report import render_report
        return render_report(report if report is not None else self.report,
                             fmt)

    def test_token_cannot_be_read_as_an_error_site(self):
        # The source-line shape is " at <file>:<line>". The insertion-point
        # shape must NOT be that shape on the same line number, or a reader
        # (and an editor jumping there) would conclude line 28 is broken.
        for fmt in self.HUMAN:
            out = self._render(fmt)
            self.assertIn(" (insertion point %s:%d)" % (self.src, self.line),
                          out, fmt)
            self.assertNotIn(" at %s:%d" % (self.src, self.line), out,
                             "%s: the insertion point must not borrow the "
                             "source-line wording" % fmt)

    def test_findings_without_an_anchor_are_byte_identical_to_before(self):
        # Removing the ONLY token this task adds must reproduce the pre-task
        # bytes exactly — no reflow, no extra space, no blank position.
        stripped = _strip_insertion_points(self.report)
        token = " (insertion point %s:%d)" % (self.src, self.line)
        for fmt in self.HUMAN:
            full = self._render(fmt)
            self.assertEqual(full.replace(token, ""), self._render(
                fmt, stripped),
                "%s changed something other than the added token" % fmt)
            self.assertEqual(full.count(token), 1, fmt)
        # And the two unanchorable findings never gained a position of any kind.
        for fmt in self.HUMAN:
            out = self._render(fmt)
            for rule in ("BR-DE-15", "BR-DE-TMP-32"):
                for chunk in out.splitlines():
                    if rule in chunk:
                        self.assertNotIn("insertion", chunk.lower(),
                                         "%s/%s: %s" % (fmt, rule, chunk))

    def test_hostile_values_degrade_to_no_position(self):
        # A hand-edited or third-party report dict can carry anything. Every
        # non-(int >= 1) must render as if the field were absent — never ":0",
        # never "True", never a traceback.
        stripped = _strip_insertion_points(self.report)
        for bad in (True, False, 0, -1, "28", 28.0, None, [28], {"line": 28}):
            doc = _with_insertion_point(self.report, "BR-DE-2", bad)
            for fmt in self.HUMAN:
                out = self._render(fmt, doc)
                self.assertNotIn("insertion", out.lower(),
                                 "%s accepted %r" % (fmt, bad))
                self.assertEqual(out, self._render(fmt, stripped),
                                 "%s: %r must render as no position" % (fmt,
                                                                        bad))

    def test_a_source_line_wins_over_an_insertion_point(self):
        # The two fields are documented mutually exclusive and the engine never
        # stamps both; a record that claims both is not a crash and not a double
        # position — the PROVEN error site wins.
        doc = _with_insertion_point(self.report, "BR-DE-2", self.line)
        for v in doc["violations"]:
            if v["rule"] == "BR-DE-2":
                v["source_line"] = 7
        for fmt in self.HUMAN:
            out = self._render(fmt, doc)
            self.assertIn(" at %s:7" % self.src, out, fmt)
            self.assertNotIn("insertion", out.lower(), fmt)

    def test_no_source_means_the_bare_line_form(self):
        # Same degradation _position_suffix already applies: ":28" alone is not
        # a jumpable address and inventing a filename would be a fabrication.
        from einvoice.report import _insertion_point_suffix
        self.assertEqual(_insertion_point_suffix("", 28),
                         " (insertion point line 28)")
        self.assertEqual(_insertion_point_suffix(None, 28),
                         " (insertion point line 28)")
        self.assertEqual(_insertion_point_suffix("f.xml", 28),
                         " (insertion point f.xml:28)")
        self.assertEqual(_insertion_point_suffix("f.xml", None), "")

    def test_the_cli_headline_shows_it_on_the_documented_example(self):
        # ACCEPTANCE: the one command the onboarding docs tell a stranger to
        # run must show the insertion point in its HEADLINE block, where the
        # offending element already is.
        proc = subprocess.run(
            [sys.executable, "-m", "einvoice", "validate", "--profile",
             "xrechnung", "examples/01-missing-fields/broken.xml"],
            cwd=HERE, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 1, proc.stderr)
        headline = [ln for ln in proc.stdout.splitlines()
                    if "offending element:" in ln]
        self.assertEqual(len(headline), 1, proc.stdout)
        self.assertIn("insertion point", headline[0].lower(), proc.stdout)
        self.assertIn(":%d)" % self.line, headline[0], proc.stdout)


if __name__ == "__main__":
    unittest.main()

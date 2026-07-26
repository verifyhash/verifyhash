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

import os
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
#   * Rendering. This task ships the field on the two JSON surfaces only; text /
#     junit / sarif / github / azure / gitlab / html do NOT show it yet (that is
#     the queued follow-up T-VHLOC.6). Tests here assert JSON only.
# ---------------------------------------------------------------------------
INSERTION_POINT_LINE = "insertion_point_line"

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


if __name__ == "__main__":
    unittest.main()

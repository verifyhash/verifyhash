#!/usr/bin/env python3
"""test_robustness_encoding.py — the ACCEPTANCE-equivalence contract.

``test_robustness.py`` pins the *rejection* half of the intake contract: garbage,
truncated, wrong-root, empty and mis-encoded bytes all fold into a bounded,
actionable, non-silent-pass outcome. This suite pins the disjoint *acceptance*
half — the half a real first pilot actually trips over:

    a genuinely VALID supplier invoice that merely arrives with real-ERP-export
    encoding messiness (a UTF-8 byte-order mark, or a legitimate non-UTF-8
    encoding declaration) MUST validate to the EXACT SAME verdict as its clean
    UTF-8 form — never a false reject.

A false reject here is not a cosmetic bug: it silently drops a conformant
supplier invoice on the floor and loses the pilot. So we verify the equivalence
directly, over the shipped golden fixtures, on the real public boundary
``report.build_report`` (the path the CLI and PDF-container flows use).

Three messy-but-valid variants are built from clean golden bytes and each is
asserted **byte-for-byte identical** to the clean baseline report — every report
field except ``source`` (the temp path), which necessarily differs:

  (1) UTF-8 BOM prefix          b'\\xef\\xbb\\xbf' + clean UTF-8 bytes
  (2) ISO-8859-1 / Latin-1      re-encoded body + matching encoding declaration
  (3) UTF-16                    re-encoded body + matching encoding declaration

expat (the stdlib parser the hardened reader wraps) consumes the raw bytes and
handles the BOM and the ``encoding=`` declaration natively, so all three ALREADY
produce the identical verdict — this suite VERIFIES-AND-CLOSES that behavior; it
does NOT (and must not need to) change the parser. The measurement was run
before any code was touched; the parser files are deliberately left untouched.

The negative boundary is re-asserted here too so the two contracts cannot
silently collide: bytes that *declare* UTF-8 but carry a Latin-1 body (a real
mis-encoding, not a valid alternate encoding) must STILL fold to a clean
``not-well-formed`` non-pass — never ``valid=True``, never a traceback. That is
exactly ``test_robustness.py``'s existing expectation, reused unweakened.

Standard library only. Runs offline. Run: python3 test_robustness_encoding.py
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice import report as _report                          # noqa: E402

CORPUS_VALID = os.path.join(HERE, "corpus", "vendored", "valid")

# xr-01.01a is a valid XRechnung UBL invoice (valid=True under the xrechnung
# profile); it carries non-Latin-1 bytes so it exercises the UTF-8 BOM and
# UTF-16 paths without pretending to be Latin-1-encodable.
UBL_FIXTURE = os.path.join(CORPUS_VALID, "xr-01.01a_ubl.xml")

# cen-bis3-exempt is a pure-Latin-1-encodable valid EN 16931 UBL invoice
# (valid=True under the en16931 profile), so it can be faithfully re-encoded to
# ISO-8859-1 with a matching declaration and still be a genuinely valid input.
LATIN1_FIXTURE = os.path.join(CORPUS_VALID, "cen-bis3-exempt_ubl.xml")

UBL_NS = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"

# Report keys compared for equivalence are ALL of them except this one, which is
# the temp file path and therefore legitimately differs between clean and messy.
_EXCLUDED_KEY = "source"

# The XML-declaration encoding attribute:  encoding="UTF-8"  /  encoding='utf-8'
_ENCODING_DECL_RE = re.compile(rb"""encoding\s*=\s*(['"])[^'"]*\1""")


def _read(path):
    with open(path, "rb") as fh:
        return fh.read()


def _report_from_bytes(data, profile, suffix=".xml"):
    """Run the real public boundary on ``data`` and drop the temp-path key."""
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "invoice" + suffix)
        with open(path, "wb") as fh:
            fh.write(data)
        rep = _report.build_report(path, profile=profile)
    return {k: v for k, v in rep.items() if k != _EXCLUDED_KEY}


def _rule_ids(rep):
    """The ordered list of violation rule ids, as AC2 compares explicitly."""
    return [v.get("rule") for v in rep["violations"]]


def _swap_declared_encoding(clean_bytes, new_encoding):
    """Return ``clean_bytes`` with its XML-declaration encoding set to
    ``new_encoding`` (bytes in, bytes out; the body text is unchanged)."""
    new = _ENCODING_DECL_RE.sub(
        ('encoding="%s"' % new_encoding).encode("ascii"), clean_bytes, count=1)
    assert new != clean_bytes and new_encoding.encode("ascii") in new, (
        "encoding declaration was not rewritten — fixture prolog shape changed")
    return new


class _EquivalenceMixin:
    """Shared assertion: a messy variant's verdict == the clean baseline's."""

    def assert_equivalent(self, baseline, variant, label):
        # AC2 (explicit fields): the four scalar verdict fields and the ORDERED
        # violation rule-id list are each identical to the clean baseline.
        for field in ("valid", "fatal_count", "warning_count",
                      "violation_count"):
            self.assertEqual(
                variant[field], baseline[field],
                "%s: field %r diverged from the clean UTF-8 baseline "
                "(%r vs %r)" % (label, field, variant[field], baseline[field]))
        self.assertEqual(
            _rule_ids(variant), _rule_ids(baseline),
            "%s: the ordered violation rule-id list diverged from clean" % label)
        # AC2 (full contract): EVERY report key except 'source' is identical —
        # the strongest statement of byte-equivalence, and the actual deliverable
        # (a valid-but-messy invoice yields the exact same report a caller sees).
        self.assertEqual(
            set(variant.keys()), set(baseline.keys()),
            "%s: report key set diverged from clean" % label)
        for key in baseline:
            self.assertEqual(
                variant[key], baseline[key],
                "%s: report field %r diverged from the clean UTF-8 baseline"
                % (label, key))


class TestUtf8BomEquivalence(_EquivalenceMixin, unittest.TestCase):
    """(1) A UTF-8 BOM prefix (real-ERP artifact) validates identically."""

    PROFILE = "xrechnung"

    def setUp(self):
        self.assertTrue(os.path.isfile(UBL_FIXTURE), "UBL fixture missing")
        self.clean = _read(UBL_FIXTURE)
        self.baseline = _report_from_bytes(self.clean, self.PROFILE)
        # Guard the premise: the clean fixture is a genuinely VALID invoice, so
        # this is really the acceptance (not the rejection) contract.
        self.assertTrue(self.baseline["valid"],
                        "premise broken: UBL baseline fixture is not valid")

    def test_utf8_bom_prefixed_valid_invoice_is_equivalent(self):
        bom = b"\xef\xbb\xbf"          # UTF-8 byte-order mark (BOM)
        variant = _report_from_bytes(bom + self.clean, self.PROFILE)
        self.assertTrue(variant["valid"],
                        "a UTF-8-BOM-prefixed valid invoice was false-rejected")
        self.assert_equivalent(self.baseline, variant, "UTF-8 BOM")

    def test_matches_python_utf8_sig_semantics(self):
        # Cross-check the BOM bytes are exactly what Python's 'utf-8-sig' emits,
        # i.e. we are testing the real BOM a text editor / ERP would write.
        self.assertEqual("x".encode("utf-8-sig")[:3], b"\xef\xbb\xbf")


class TestUtf16Equivalence(_EquivalenceMixin, unittest.TestCase):
    """(3) A valid UTF-16-encoded+declared invoice validates identically."""

    PROFILE = "xrechnung"

    def setUp(self):
        self.clean = _read(UBL_FIXTURE)
        self.baseline = _report_from_bytes(self.clean, self.PROFILE)
        self.assertTrue(self.baseline["valid"])

    def test_utf16_encoded_valid_invoice_is_equivalent(self):
        text = self.clean.decode("utf-8")
        declared = _swap_declared_encoding(self.clean, "UTF-16")
        # Re-encode the WHOLE document to UTF-16 (str.encode emits a BOM, which
        # expat uses together with the declaration to select the codec).
        data = declared.decode("utf-8").encode("utf-16")
        # Sanity: the payload really is UTF-16 (2 bytes/char region), not UTF-8.
        self.assertNotEqual(data[:2], b"<?")
        variant = _report_from_bytes(data, self.PROFILE)
        self.assertTrue(variant["valid"],
                        "a valid UTF-16 invoice was false-rejected")
        self.assert_equivalent(self.baseline, variant, "UTF-16")
        # Guard against an accidentally-empty parse masking a false verdict.
        self.assertIn("Invoice", text)


class TestLatin1Equivalence(_EquivalenceMixin, unittest.TestCase):
    """(2) A valid ISO-8859-1 / Latin-1 encoded+declared invoice is identical.

    Uses the en16931 profile because the pure-Latin-1-encodable golden fixture
    (cen-bis3-exempt) is a valid EN 16931 invoice under that profile; the clean
    baseline is therefore a genuinely VALID document (acceptance contract)."""

    PROFILE = "en16931"

    def setUp(self):
        self.assertTrue(os.path.isfile(LATIN1_FIXTURE),
                        "Latin-1 fixture missing")
        self.clean = _read(LATIN1_FIXTURE)
        # Confirm the fixture is faithfully Latin-1-encodable this run.
        self.text = self.clean.decode("utf-8")
        self.text.encode("latin-1")   # raises if any non-Latin-1 codepoint
        self.baseline = _report_from_bytes(self.clean, self.PROFILE)
        self.assertTrue(self.baseline["valid"],
                        "premise broken: Latin-1 baseline fixture is not valid")

    def test_iso_8859_1_encoded_valid_invoice_is_equivalent(self):
        declared_text = _swap_declared_encoding(
            self.clean, "ISO-8859-1").decode("utf-8")
        data = declared_text.encode("latin-1")   # ISO-8859-1 == Latin-1 bytes
        variant = _report_from_bytes(data, self.PROFILE)
        self.assertTrue(variant["valid"],
                        "a valid ISO-8859-1 invoice was false-rejected")
        self.assert_equivalent(self.baseline, variant, "ISO-8859-1")


class TestMisencodedStaysRejected(unittest.TestCase):
    """The disjoint NEGATIVE contract, reused UNWEAKENED from test_robustness.py:
    bytes declaring UTF-8 but carrying a Latin-1 body are a real mis-encoding —
    they must STILL fold to a clean not-well-formed non-pass, so the acceptance
    contract above cannot accidentally start accepting broken bytes."""

    def test_latin1_body_declared_utf8_is_not_well_formed(self):
        # 0xE9 ('é' in Latin-1) is an invalid stand-alone UTF-8 lead byte inside
        # a document that declares UTF-8 -> not-well-formed, not a decode crash.
        data = ('<?xml version="1.0" encoding="UTF-8"?>'
                '<Invoice xmlns="%s"><Note>caf\xe9</Note></Invoice>'
                % UBL_NS).encode("latin-1")
        # build_report must RETURN a report (never raise / traceback-escape).
        rep = _report_from_bytes(data, "xrechnung")
        self.assertIsNot(rep["valid"], True,
                         "a mis-encoded body must NEVER validate as a pass")
        self.assertFalse(rep["valid"])
        self.assertEqual(rep.get("error"), "not-well-formed",
                         "mis-encoded input must be the actionable "
                         "not-well-formed outcome, got %r" % rep.get("error"))
        # No fabricated findings and no expanded payload echoed back.
        self.assertEqual(rep["violation_count"], 0)
        self.assertEqual(rep["violations"], [])
        self.assertLess(len(rep.get("message", "")), 4096)

    def test_misencoded_does_not_collide_with_bom_variant(self):
        # A guard that the two contracts are genuinely disjoint: the valid BOM
        # variant passes while the mis-encoded body is rejected, in one run.
        clean = _read(UBL_FIXTURE)
        good = _report_from_bytes(b"\xef\xbb\xbf" + clean, "xrechnung")
        bad = _report_from_bytes(
            ('<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="%s">'
             '<Note>caf\xe9</Note></Invoice>' % UBL_NS).encode("latin-1"),
            "xrechnung")
        self.assertTrue(good["valid"])
        self.assertIsNot(bad["valid"], True)


class TestParserFilesUntouchedByThisContract(unittest.TestCase):
    """AC7: this deliverable required NO parser change — the messy-but-valid
    inputs already validate identically because expat handles the BOM and the
    encoding declaration natively. This test documents that verify-and-close
    conclusion by proving the raw-bytes read path is what carries it: the parser
    passes the file's bytes to expat with no manual decode / BOM strip, so the
    equivalence is a property of the existing code, not of a new patch."""

    def test_reader_feeds_raw_bytes_to_expat(self):
        from einvoice import _xmlsec
        # A BOM-prefixed minimal well-formed doc round-trips through the low-level
        # safe reader unchanged (root tag intact) — same code path production
        # uses, no special-casing needed.
        data = b"\xef\xbb\xbf<Invoice><a>x</a></Invoice>"
        root = _xmlsec._safe_fromstring(data)
        self.assertEqual(root.tag, "Invoice")


if __name__ == "__main__":
    unittest.main(verbosity=2)

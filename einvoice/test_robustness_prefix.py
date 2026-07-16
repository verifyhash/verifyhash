#!/usr/bin/env python3
"""test_robustness_prefix.py — the namespace/structural-noise ACCEPTANCE contract.

Sibling of ``test_robustness_encoding.py``. That suite pins the *encoding* half
of the intake-acceptance contract (a BOM or a valid non-UTF-8 declaration must
not false-reject a conformant invoice). This one pins the disjoint *XML-shape*
half — the noise a real ERP export actually carries on top of otherwise valid
UBL / CII bytes:

    a genuinely VALID supplier invoice that merely arrives with different (but
    valid) namespace PREFIXES, in a DEFAULT-namespace / no-prefix serialization,
    with pre-root comments / processing-instructions / whitespace, or carrying a
    valid ``xsi:schemaLocation`` hint, MUST validate to the EXACT SAME verdict as
    its clean form — never a false reject.

Four messy-but-valid variants are built from clean golden bytes, over BOTH a
valid UBL golden fixture (``corpus/synthetic/synth-ubl-good-multiline.xml``, the
subject of ``golden/synth-ubl-good-multiline.json``) and a valid CII golden
fixture (``corpus/synthetic/synth-cii-good-multiline.xml`` /
``golden/synth-cii-good-multiline.json``). Each variant's report is asserted
**byte-for-byte identical** to the clean baseline for every report field except
``source`` (the input label, which legitimately differs):

  (1) DIFFERING PREFIXES     rename the prefixes on the SAME namespace URIs
                             (UBL cac:->zzc: / cbc:->zzb:; CII ram:->r1: etc.)
  (2) DEFAULT / NO-PREFIX    redeclare a namespace as the default ``xmlns=`` and
                             drop the prefix on its elements (UBL: cbc as the
                             default; CII: ram as the default)
  (3) PRE-ROOT NOISE         a leading comment + processing-instruction + extra
                             whitespace inserted before the root element
  (4) xsi:schemaLocation     a present, valid ``xsi:schemaLocation`` attribute
                             (plus its ``xmlns:xsi`` declaration) on the root

WHY THIS ALREADY HOLDS (verify-and-close, no parser change). ``parser.py`` and
``parser_cii.py`` never look at prefixes: every lookup is by namespace URI
(``root.find("cbc:ID", NS)`` where ``NS`` maps the prefix token to its URI, and
ElementTree resolves the token to the ``{uri}local`` the document actually
declared) and the discriminators compare the ``{uri}local`` tag directly. So a
prefix is a pure serialization artifact — renaming it, or dropping it in favour
of a default ``xmlns=``, changes the bytes but not the URIs, hence not the model
and not the verdict. Pre-root miscellaneous content and an extra root attribute
are consumed and ignored by the stdlib parser. The measurement was run BEFORE
any code was touched; all eight variants already produce the identical report,
so this suite VERIFIES-AND-CLOSES that behavior and stands as its regression
guard — it does NOT (and must not need to) change the parser or any rule.

That the equivalence is REAL URI resolution — not prefix-blindness — is pinned
by :class:`TestUriResolutionIsReal`: corrupting the URI itself (while keeping the
prefix) DOES break the verdict, proving the parser binds on the URI.

Boundary: the UBL variants run through the public ``report.build_report`` (the
exact boundary ``test_robustness_encoding.py`` uses). ``build_report``'s
plain-XML path parses UBL only (a CII file there trips ``S-ROOT`` — documented in
``test_golden_snapshot.py``), so the CII variants run through the report module's
CII-capable dispatch boundary ``report._report_from_invoice_bytes`` — the SAME
entry ``build_report`` itself delegates to for a CII invoice embedded in a
Factur-X / ZUGFeRD PDF, and the path ``test_golden_snapshot`` exercises. Both
sides of every equivalence use one boundary, so the comparison is exact.

Standard library only. Runs offline. Run: python3 test_robustness_prefix.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice import report as _report                          # noqa: E402

SYNTH = os.path.join(HERE, "corpus", "synthetic")

# A valid EN 16931 UBL Invoice (golden/synth-ubl-good-multiline.json: valid=True
# under the en16931 profile). Three lines, two VAT rates, a document allowance
# and charge — a realistic, genuinely conformant document.
UBL_FIXTURE = os.path.join(SYNTH, "synth-ubl-good-multiline.xml")

# A valid EN 16931 CII (UN/CEFACT CrossIndustryInvoice) invoice
# (golden/synth-cii-good-multiline.json: valid=True under en16931).
CII_FIXTURE = os.path.join(SYNTH, "synth-cii-good-multiline.xml")

PROFILE = "en16931"

# The one report key that legitimately differs (the input label / temp path).
_EXCLUDED_KEY = "source"

# --- namespace URIs (the invariants the parser actually binds on) ----------
UBL_INVOICE_NS = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
UBL_CBC_NS = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
CII_RSM_NS = "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
CII_RAM_NS = (
    "urn:un:unece:uncefact:data:standard:"
    "ReusableAggregateBusinessInformationEntity:100")
XSI_NS = "http://www.w3.org/2001/XMLSchema-instance"


def _read(path):
    with open(path, "rb") as fh:
        return fh.read()


def _drop_source(rep):
    return {k: v for k, v in rep.items() if k != _EXCLUDED_KEY}


def _ubl_report(data, source_label):
    """Run the PUBLIC ``report.build_report`` boundary on UBL ``data``.

    Written to a temp file (the CLI/embedding path), then the temp-path
    ``source`` key is dropped so only the verdict content is compared.
    """
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, source_label)
        with open(path, "wb") as fh:
            fh.write(data)
        rep = _report.build_report(path, profile=PROFILE)
    return _drop_source(rep)


def _cii_report(data, source_label):
    """Run the report module's CII-capable dispatch boundary on CII ``data``.

    ``report._report_from_invoice_bytes`` is exactly what ``build_report``
    delegates to for a CII invoice embedded in a Factur-X / ZUGFeRD PDF; it
    dispatches on the root element and routes a ``CrossIndustryInvoice`` through
    the CII engine. A DISTINCT ``source_label`` is passed for the baseline and
    each variant precisely so the equivalence assertion proves ``source`` is the
    ONLY field that may differ.
    """
    rep = _report._report_from_invoice_bytes(data, source_label, PROFILE)
    return _drop_source(rep)


def _rule_ids(rep):
    return [v.get("rule") for v in rep.get("violations", [])]


# ---------------------------------------------------------------------------
# Byte-level variant builders. Each takes the CLEAN document bytes and returns a
# new, still-valid document that differs ONLY in the targeted structural axis.
# ---------------------------------------------------------------------------
def rename_prefixes(clean, mapping):
    """Consistently rename namespace prefixes on their SAME URIs.

    Rewrites both the ``xmlns:<old>="..."`` declaration and every ``<old>:``
    qname to ``<new>``. The URIs are untouched, so this is a pure
    serialization change — the model must be identical.
    """
    text = clean.decode("utf-8")
    for old, new in mapping.items():
        text = text.replace("xmlns:%s=" % old, "xmlns:%s=" % new)
        text = text.replace("%s:" % old, "%s:" % new)
    out = text.encode("utf-8")
    assert out != clean, "prefix rename did not change the bytes"
    return out


def make_prefix_default(clean, prefix, uri):
    """Redeclare ``prefix``'s URI as the DEFAULT namespace and drop the prefix.

    ``xmlns:<prefix>="<uri>"`` becomes ``xmlns="<uri>"`` and every ``<prefix>:``
    qname loses its prefix, inheriting the default namespace. Only valid when
    ``prefix``'s elements are the sole occupants of the default slot in the
    subtree (true for UBL cbc and CII ram in these fixtures).
    """
    text = clean.decode("utf-8")
    text = text.replace('xmlns:%s="%s"' % (prefix, uri), 'xmlns="%s"' % uri)
    text = text.replace("%s:" % prefix, "")
    out = text.encode("utf-8")
    assert out != clean, "default-namespace rewrite did not change the bytes"
    assert ("%s:" % prefix).encode("ascii") not in out, (
        "residual %r: qname left after dropping the prefix" % prefix)
    return out


def ubl_default_namespace_form(clean):
    """UBL no-prefix form: give the Invoice root a prefix and make cbc default.

    The clean fixture already declares the Invoice-2 namespace as the default,
    so to move cbc INTO the default slot the root element is first given an
    explicit ``ubl:`` prefix, freeing the default for cbc. The cac elements keep
    their prefix. Result: every cbc:* element is written with NO prefix.
    """
    text = clean.decode("utf-8")
    text = text.replace('xmlns:cbc="%s"' % UBL_CBC_NS,
                        'xmlns="%s"' % UBL_CBC_NS)
    text = text.replace('xmlns="%s"' % UBL_INVOICE_NS,
                        'xmlns:ubl="%s"' % UBL_INVOICE_NS)
    text = text.replace("cbc:", "")
    text = text.replace("<Invoice ", "<ubl:Invoice ")
    text = text.replace("</Invoice>", "</ubl:Invoice>")
    out = text.encode("utf-8")
    assert out != clean and b"cbc:" not in out, "UBL default form malformed"
    return out


def prepend_pre_root_noise(clean):
    """Insert a comment + processing-instruction + whitespace BEFORE the root.

    Inserted right after the XML declaration (``?>``), i.e. in the prolog's
    'misc' region, which XML permits and the parser must ignore.
    """
    noise = ("\n<!-- pre-root comment: real-ERP export wrapper banner -->\n"
             "<?robustness-prefix-test structural-noise-marker?>\n   \n")
    text = clean.decode("utf-8").replace("?>", "?>" + noise, 1)
    out = text.encode("utf-8")
    assert out != clean and b"<?robustness-prefix-test" in out, (
        "pre-root noise was not inserted")
    return out


def add_schema_location(clean, root_marker, ns_uri, xsd_hint):
    """Add a valid ``xsi:schemaLocation`` (and its ``xmlns:xsi``) to the root."""
    attrs = (' xmlns:xsi="%s" xsi:schemaLocation="%s %s"'
             % (XSI_NS, ns_uri, xsd_hint))
    text = clean.decode("utf-8").replace(root_marker, root_marker + attrs, 1)
    out = text.encode("utf-8")
    assert out != clean and b"schemaLocation" in out, (
        "schemaLocation attribute was not added")
    return out


class _EquivalenceMixin:
    """Shared assertion: a messy variant's report == the clean baseline's."""

    def assert_equivalent(self, baseline, variant, label):
        # The variant must still be a genuine PASS (this is the acceptance, not
        # the rejection, contract).
        self.assertTrue(
            variant.get("valid"),
            "%s: a messy-but-valid invoice was FALSE-REJECTED" % label)
        # Explicit scalar verdict fields + the ordered violation rule-id list.
        for field in ("valid", "fatal_count", "warning_count",
                      "violation_count"):
            self.assertEqual(
                variant.get(field), baseline.get(field),
                "%s: field %r diverged from clean (%r vs %r)"
                % (label, field, variant.get(field), baseline.get(field)))
        self.assertEqual(
            _rule_ids(variant), _rule_ids(baseline),
            "%s: the ordered violation rule-id list diverged from clean" % label)
        # Full contract: EVERY report key except 'source' is byte-identical.
        self.assertEqual(
            set(variant.keys()), set(baseline.keys()),
            "%s: report key set diverged from clean" % label)
        for key in baseline:
            self.assertEqual(
                variant[key], baseline[key],
                "%s: report field %r diverged from the clean baseline"
                % (label, key))


class TestUblPrefixRobustness(_EquivalenceMixin, unittest.TestCase):
    """All four variant classes over the valid UBL golden fixture."""

    def setUp(self):
        self.assertTrue(os.path.isfile(UBL_FIXTURE), "UBL fixture missing")
        self.clean = _read(UBL_FIXTURE)
        self.baseline = _ubl_report(self.clean, "ubl-clean.xml")
        self.assertTrue(self.baseline["valid"],
                        "premise broken: UBL baseline fixture is not valid")

    def test_v1_differing_namespace_prefixes(self):
        variant = _ubl_report(
            rename_prefixes(self.clean, {"cac": "zzc", "cbc": "zzb"}),
            "ubl-v1-prefixes.xml")
        self.assert_equivalent(self.baseline, variant, "UBL differing prefixes")

    def test_v2_default_no_prefix_namespace(self):
        variant = _ubl_report(
            ubl_default_namespace_form(self.clean), "ubl-v2-default.xml")
        self.assert_equivalent(
            self.baseline, variant, "UBL default/no-prefix namespace")

    def test_v3_pre_root_comment_pi_whitespace(self):
        variant = _ubl_report(
            prepend_pre_root_noise(self.clean), "ubl-v3-preroot.xml")
        self.assert_equivalent(self.baseline, variant, "UBL pre-root noise")

    def test_v4_xsi_schema_location_attribute(self):
        variant = _ubl_report(
            add_schema_location(self.clean, "<Invoice", UBL_INVOICE_NS,
                                "UBL-Invoice-2.1.xsd"),
            "ubl-v4-schemaloc.xml")
        self.assert_equivalent(self.baseline, variant, "UBL xsi:schemaLocation")


class TestCiiPrefixRobustness(_EquivalenceMixin, unittest.TestCase):
    """All four variant classes over the valid CII golden fixture."""

    def setUp(self):
        self.assertTrue(os.path.isfile(CII_FIXTURE), "CII fixture missing")
        self.clean = _read(CII_FIXTURE)
        self.baseline = _cii_report(self.clean, "cii-clean.xml")
        self.assertTrue(self.baseline["valid"],
                        "premise broken: CII baseline fixture is not valid")

    def test_v1_differing_namespace_prefixes(self):
        variant = _cii_report(
            rename_prefixes(self.clean,
                            {"ram": "r1", "rsm": "r0", "udt": "r2"}),
            "cii-v1-prefixes.xml")
        self.assert_equivalent(self.baseline, variant, "CII differing prefixes")

    def test_v2_default_no_prefix_namespace(self):
        # ram is the bulk namespace; make it the default (no-prefix) and drop the
        # prefix on every ram:* element (rsm/udt keep theirs).
        variant = _cii_report(
            make_prefix_default(self.clean, "ram", CII_RAM_NS),
            "cii-v2-default.xml")
        self.assert_equivalent(
            self.baseline, variant, "CII default/no-prefix namespace")

    def test_v3_pre_root_comment_pi_whitespace(self):
        variant = _cii_report(
            prepend_pre_root_noise(self.clean), "cii-v3-preroot.xml")
        self.assert_equivalent(self.baseline, variant, "CII pre-root noise")

    def test_v4_xsi_schema_location_attribute(self):
        variant = _cii_report(
            add_schema_location(self.clean, "<rsm:CrossIndustryInvoice",
                                CII_RSM_NS,
                                "CrossIndustryInvoice_100pD16B.xsd"),
            "cii-v4-schemaloc.xml")
        self.assert_equivalent(self.baseline, variant, "CII xsi:schemaLocation")


class TestUriResolutionIsReal(unittest.TestCase):
    """The disjoint NEGATIVE guard: the prefix-independence above is REAL
    URI-based resolution, not prefix-blindness. Keeping the prefix but corrupting
    the namespace URI moves the elements to a DIFFERENT namespace the parser does
    not recognise, which MUST change the verdict (and must still return a clean
    report, never a traceback). This proves the acceptance-equivalence is a
    property of URI binding, not of ignoring namespaces."""

    def test_corrupting_the_uri_breaks_validity(self):
        clean = _read(UBL_FIXTURE)
        baseline = _ubl_report(clean, "ubl-clean.xml")
        self.assertTrue(baseline["valid"])
        corrupted = clean.decode("utf-8").replace(
            UBL_CBC_NS, UBL_CBC_NS + "-WRONG-URI").encode("utf-8")
        rep = _ubl_report(corrupted, "ubl-bad-uri.xml")
        # Still a report, never a traceback; and NOT a false pass.
        self.assertIn("valid", rep)
        self.assertFalse(
            rep["valid"],
            "moving elements to an unrecognised URI must NOT still validate — "
            "the parser would be prefix-blind, not URI-bound")


class TestParserFilesUntouchedByThisContract(unittest.TestCase):
    """AC (verify-and-close): this deliverable required NO parser change. The
    prefix / default-namespace / pre-root-noise / schemaLocation variants already
    validate identically because both parsers resolve strictly by namespace URI
    (ElementTree's ``{uri}local`` tags) and ignore the prefix token entirely.
    This test documents that conclusion by pinning the mechanism directly."""

    def test_lookup_is_by_uri_not_prefix(self):
        import xml.etree.ElementTree as ET
        # Two documents, identical URIs, DIFFERENT prefixes -> identical
        # {uri}local root tags, i.e. the parser can never tell them apart.
        a = ET.fromstring('<a:Invoice xmlns:a="%s"/>' % UBL_INVOICE_NS)
        b = ET.fromstring('<Invoice xmlns="%s"/>' % UBL_INVOICE_NS)
        self.assertEqual(a.tag, b.tag)
        self.assertEqual(a.tag, "{%s}Invoice" % UBL_INVOICE_NS)


if __name__ == "__main__":
    unittest.main(verbosity=2)

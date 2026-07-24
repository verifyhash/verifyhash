#!/usr/bin/env python3
"""Invariant: no published www/ sales page may DENY a capability the shipped
engine actually has.

This is NOT a golden pin of the prose (test_site.py already guards the rendered
numbers). It is a *capability truth* gate: each entry below pairs a set of
NEGATIVE phrases — the exact denials a page might carry, in English and German —
with an executable probe run against the shipped ``einvoice`` engine. If a probe
demonstrates the capability is real AND any www/ page still carries a matching
denial, the test fails and names the offending page + phrase.

Why it exists: for weeks four live sales surfaces claimed the engine had "no UBL
CreditNote root support" while the engine validated UBL 2.1 CreditNote through
the same ``rules.ALL_RULES`` core it runs an Invoice through (README §"UBL
CreditNote IS validated", COVERAGE.md §"UBL CreditNote scope": 192/192 graded
cases, 0 differential divergences). That false denial handed high-intent
prospects to a competitor. This gate keeps the correction from silently
regressing — if someone re-adds the denial, or the engine loses the capability,
one of these assertions goes red.

Offline, standard-library only. The one import beyond the stdlib is the shipped
``einvoice`` package itself — that is the product under test, not a third party.
No network, no subprocess, no file writes.
"""

import html
import os
import re
import sys
import unittest

from einvoice.parser import parse_file
from einvoice.report import validate_root
from einvoice import parser_cii, rules

HERE = os.path.dirname(os.path.abspath(__file__))
WWW_DIR = os.path.join(HERE, "www")
FIXTURES = os.path.join(HERE, "fixtures")

# Fixtures used by the probes (all vendored in the repo; no network).
UBL_CREDITNOTE = os.path.join(FIXTURES, "creditnote-invalid-typecode_ubl.xml")
CII_WITH_BRCL = os.path.join(FIXTURES, "sb-viol-CII-DT-005_cii.xml")


# ---------------------------------------------------------------------------
# www/ text extraction: for each .html file keep a normalized, tag-stripped,
# entity-decoded, whitespace-collapsed, lowercased rendering. Denials are
# matched against THIS form, so a phrase is caught whether or not it is wrapped
# in <code>…</code> and whether the German uses raw umlauts or &uuml; entities.
# ---------------------------------------------------------------------------

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _normalize(markup):
    text = _TAG_RE.sub(" ", markup)
    text = html.unescape(text)
    text = _WS_RE.sub(" ", text)
    return text.strip().lower()


def _load_www_pages():
    pages = {}
    for root, _dirs, files in os.walk(WWW_DIR):
        for name in files:
            if not name.endswith(".html"):
                continue
            path = os.path.join(root, name)
            with open(path, "r", encoding="utf-8") as fh:
                markup = fh.read()
            rel = os.path.relpath(path, WWW_DIR)
            pages[rel] = _normalize(markup)
    return pages


# ---------------------------------------------------------------------------
# Probes — each returns (bool capability_present, str evidence). They exercise
# the SHIPPED engine, never a re-implementation.
# ---------------------------------------------------------------------------

def probe_ubl_creditnote_root():
    """A UBL 2.1 CreditNote root is accepted and graded by the core engine.

    The fixture's CreditNoteTypeCode is intentionally invalid, so BR-CL-01
    fires — which only happens if the root was ACCEPTED and run through the
    rules (a rejected/unsupported root would surface S-ROOT instead and never
    reach any BR-* rule).
    """
    res = validate_root(parse_file(UBL_CREDITNOTE), profile="en16931")
    ids = {v.rule_id for v in res.violations}
    present = "S-ROOT" not in ids and "BR-CL-01" in ids
    return present, "UBL CreditNote rule_ids=%s" % sorted(ids)


def probe_cii_validated():
    """A UN/CEFACT CrossIndustryInvoice (the CII / ZUGFeRD / Factur-X syntax)
    is parsed and graded through the SAME rules.ALL_RULES core — the exact path
    report.py runs for XML extracted from a ZUGFeRD/Factur-X PDF container.

    BR-CL-11 firing on this fixture proves the CII root was processed (not
    skipped as an unsupported syntax).
    """
    inv = parser_cii.build_model(parse_file(CII_WITH_BRCL))
    ids = {v.rule_id for fn in rules.ALL_RULES
           for v in (fn(inv),) if v is not None}
    present = "BR-CL-11" in ids
    return present, "CII rule_ids include BR-CL: %s" % sorted(
        r for r in ids if r.startswith("BR-CL"))


def probe_brcl_both_syntaxes():
    """The BR-CL-* code-list rule class fires in BOTH syntaxes: BR-CL-01 on the
    UBL CreditNote above, BR-CL-11 on the CII document above. Guards the
    'BR-CL-* now implemented in both syntaxes' claim against any re-added
    'deferred / not implemented' denial.
    """
    ubl_ids = {v.rule_id for v in
               validate_root(parse_file(UBL_CREDITNOTE),
                             profile="en16931").violations}
    inv = parser_cii.build_model(parse_file(CII_WITH_BRCL))
    cii_ids = {v.rule_id for fn in rules.ALL_RULES
               for v in (fn(inv),) if v is not None}
    ubl_brcl = {r for r in ubl_ids if r.startswith("BR-CL")}
    cii_brcl = {r for r in cii_ids if r.startswith("BR-CL")}
    present = bool(ubl_brcl) and bool(cii_brcl)
    return present, "UBL BR-CL=%s ; CII BR-CL=%s" % (
        sorted(ubl_brcl), sorted(cii_brcl))


# ---------------------------------------------------------------------------
# The claim table. Each `phrases` entry is a regex matched (case-insensitive)
# against the NORMALIZED page text. Every phrase is a genuine *denial* of the
# capability — never the honest, still-true limit prose (e.g. "CII (via the
# ZUGFeRD/Factur-X PDF container) only" is a true scope note, not a denial, and
# is deliberately NOT listed).
# ---------------------------------------------------------------------------

# The gaps between anchor and denial verb are TIGHTLY bounded so a pattern
# cannot bridge across a sentence boundary into unrelated prose (e.g. a rule
# reference page that legitimately says "a CII file should not use …", or the
# POSITIVE German "die BR-CL-*-Klasse enthält keine zurückgestellten Prüfungen
# mehr" — "contains no deferred checks"). Each pattern was checked to fire on
# the real historic denial text and NOT on any current www/ prose.
CLAIMS = [
    {
        "name": "UBL CreditNote root support",
        "probe": probe_ubl_creditnote_root,
        "phrases": [
            # English denials: "no UBL CreditNote root", "no UBL CreditNote",
            # "There is no UBL CreditNote root support here".
            r"no ubl\s{0,3}creditnote",
            r"creditnote[\w :.\-]{0,25}(is|are) not (support|validat)",
            # German denial: "UBL-CreditNote-Wurzelelement wird nicht
            # unterstützt".
            r"creditnote[\w :.\-]{0,30}wird nicht unterst",
            r"kein[e]?\s{0,3}(ubl[- ]?)?creditnote[\w :.\-]{0,20}unterst",
        ],
    },
    {
        "name": "CII / ZUGFeRD / Factur-X validation",
        "probe": probe_cii_validated,
        "phrases": [
            # English denials (NOT the true "CII (via the … PDF container) only"
            # scope note, which is an honest limit, not a denial).
            r"no cii\s{0,3}(support|validation)",
            r"cii\s{0,3}(is|are)?\s?not\s{0,3}(support|validat)",
            r"does not\s{0,10}(support|validat\w*)\s{0,3}cii\b",
            # German denials.
            r"cii[\w :.\-]{0,25}wird nicht unterst",
            r"kein[e]?\s{0,3}cii[- ]?unterst",
        ],
    },
    {
        "name": "BR-CL-* code-list checks (both syntaxes)",
        "probe": probe_brcl_both_syntaxes,
        "phrases": [
            # English denials — verb-anchored so the positive "BR-CL-* … is now
            # implemented in both syntaxes" never matches.
            r"br-cl[-*\w :.\-]{0,30}(is|are)\s{0,3}deferred",
            r"br-cl[-*\w :.\-]{0,30}(not|no longer)\s{0,3}(yet\s{0,3})?implemented",
            r"code-?list[\w :.\-]{0,20}(is|are)\s{0,3}deferred",
            # German denials — require an assertive verb ("ist/sind
            # zurückgestellt", "nicht implementiert"); the positive "enthält
            # keine zurückgestellten" has neither and stays clear.
            r"br-cl[-*\w :.\-]{0,30}nicht implementiert\b",
            r"br-cl[-*\w :.\-]{0,30}(ist|sind)\s{0,3}zur[üu]ckgestellt",
        ],
    },
]


class TestWwwClaims(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pages = _load_www_pages()
        assert cls.pages, "no www/*.html pages found — run gen_site.py first"

    def test_probes_demonstrate_capability(self):
        """Each probe must actually demonstrate its capability against the
        shipped engine; otherwise the corresponding denial would be TRUE and
        this gate would be meaningless."""
        for claim in CLAIMS:
            present, evidence = claim["probe"]()
            self.assertTrue(
                present,
                "PROBE FAILED for %r — engine no longer demonstrates the "
                "capability (%s). Either the engine regressed or the www claim "
                "table is stale." % (claim["name"], evidence),
            )

    def test_no_www_page_denies_a_real_capability(self):
        """FAIL if any www/ page carries a denial of a capability a probe
        demonstrates is real."""
        offenders = []
        for claim in CLAIMS:
            present, evidence = claim["probe"]()
            if not present:
                # Covered by the probe test above; skip denial matching so we
                # don't double-report.
                continue
            patterns = [re.compile(p, re.IGNORECASE) for p in claim["phrases"]]
            for rel, text in sorted(self.pages.items()):
                for pat in patterns:
                    m = pat.search(text)
                    if m:
                        offenders.append(
                            "www/%s denies %r via /%s/ -> matched %r "
                            "(engine proof: %s)"
                            % (rel, claim["name"], pat.pattern,
                               m.group(0), evidence)
                        )
        self.assertEqual(
            offenders, [],
            "www/ pages deny capabilities the shipped engine has:\n  "
            + "\n  ".join(offenders),
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)

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
No network, no child processes, no file writes.
"""

import html
import os
import re
import sys
import types
import unittest

from einvoice.parser import parse_file
from einvoice.report import validate_root
from einvoice import parser_cii, rules
# A plain str constant (the CII root localname) from the ONE dispatch seam, so
# the affirmation check below hand-types no engine token. Deliberately imported
# as a NAME, not a module — test_pypi_fact_is_static_not_probed keeps this
# module's namespace free of new module objects.
from einvoice.validate import CII_ROOT_LOCALNAME

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


def probe_raw_cii_root_accepted():
    """A RAW ``.xml`` file whose root is ``CrossIndustryInvoice`` is accepted
    and graded — no PDF container involved.

    This is the capability T-VHCII3.1 added and the one the ``CII_ABSENCE_``
    ``DENIALS`` denylist below protects. It goes through the ONE dispatch seam
    (``validate.validate_root``, which ``report.build_report`` and the CLI both
    call), so it is exactly what the browser page and the terminal do. Proof of
    acceptance: the structural ``S-ROOT`` refusal is ABSENT and real ``BR-*``
    business rules fired, which can only happen on a root the engine took.
    """
    res = validate_root(parse_file(CII_WITH_BRCL), profile="en16931")
    ids = {v.rule_id for v in res.violations}
    present = "S-ROOT" not in ids and any(r.startswith("BR-") for r in ids)
    return present, "raw CII root graded, rule_ids=%s" % sorted(ids)


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
# capability — never honest, still-true limit prose.
#
# HISTORY NOTE (T-VHCII3.3): this comment used to exempt "CII (via the
# ZUGFeRD/Factur-X PDF container) only" as "a true scope note, not a denial".
# It WAS true then and is NOT true now: since T-VHCII3.1 the engine grades a
# raw CrossIndustryInvoice `.xml` through the same dispatch seam, so that
# sentence became a false denial of a shipped capability. It now lives in
# :data:`CII_ABSENCE_DENIALS` below.
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


# ---------------------------------------------------------------------------
# DISTRIBUTION TRUTH (T-VHTRUTH.1) — a static, network-free companion to the
# capability table above.
#
# The bug it kills: for months every www/ page that mentioned installing said
# the tool was "noch nicht auf PyPI" / "not on PyPI yet" and told the reader to
# vendor a directory instead — while the distribution `verifyhash-einvoice` had
# in fact been serving releases on PyPI. The German product page (www/de/), the
# ONE page in this lane aimed at the German mandate buyer, carried the falsehood
# in its CI section. A prospect who believed it either wasted five minutes
# vendoring or concluded the project was unreleased.
#
# This is asserted as a STATIC COMMITTED FACT, deliberately NOT probed: this
# module opens no sockets, fetches no URL and spawns no child process. PyPI
# availability is a fact about the world we assert here and re-check by hand at
# release time; a test that phoned home would be flaky, slow, and would silently
# pass on a firewalled runner. If the project were ever unpublished, THIS
# constant is what gets flipped — one edit, and the guard inverts with it.
PYPI_DISTRIBUTION = "verifyhash-einvoice"

# The claim shapes we have actually shipped (case-insensitive regexes matched
# against the normalized page text). Every one of these was a real line in a
# committed surface at some point; this is a denylist of history, not of
# hypotheticals. Scoped tightly to PyPI-absence assertions so honest, still-true
# prose ("install from a checkout", "pinned by sha256") never matches.
PYPI_ABSENCE_DENIALS = (
    r"not on pypi",
    r"not yet on pypi",
    r"noch nicht auf pypi",
    r"nicht auf pypi",
    r"not published to pypi",
    r"pending first publish",
    r"nicht auf pypi ver[öo]ffentlicht",
    r"no[tc]h nicht ver[öo]ffentlicht[\w :.\-]{0,20}pypi",
)

# Pages that must NAME the real distribution: the English landing and the German
# product page are the two install-facing surfaces this task fixed at source.
PAGES_NAMING_DISTRIBUTION = ("index.html", os.path.join("de", "index.html"))


# ---------------------------------------------------------------------------
# RAW-CII CAPABILITY (T-VHCII3.3) — same denylist convention as
# PYPI_ABSENCE_DENIALS above, but anchored to an executable probe rather than a
# committed fact, because this one IS checkable in-process.
#
# The bug it kills: XRechnung has TWO official syntaxes, UBL and UN/CEFACT CII.
# Until T-VHCII3.1 our raw-XML path only took UBL, and the surfaces said so —
# the browser validator page carried "plus CII (via the ZUGFeRD/Factur-X PDF
# container) only", and the coverage prose called the raw-XML CLI surface
# "honestly UBL-only". Those lines were accurate when written. T-VHCII3.1 made
# them false: a raw CrossIndustryInvoice `.xml` is now graded by the CII engine
# through the same validate_root seam. A German mandate buyer whose ERP emits
# CII (Factur-X's native syntax) reads a leftover line like that and concludes
# the tool cannot handle their invoices — the exact prospect this lane is for.
#
# Every pattern below is a claim shape we ACTUALLY SHIPPED, not a hypothetical,
# and each is anchored to a CII/ZUGFeRD/Factur-X token with a TIGHT, non-
# sentence-crossing gap so honest prose survives. Two things that must keep
# passing and were checked by hand:
#
#   * www/index.html's "12 are officially UBL-only and 4 are CII-only" — a
#     RULE-BINDING fact (how many EN 16931 rules bind to which syntax in the
#     official Schematron), not a capability claim. The `ubl-only` patterns
#     require a product noun ("engine"/"validator"/"CLI"/"surface"/…) with an
#     assertive verb, so a rule COUNT never matches.
#   * honest limit prose that still mentions the PDF container route, which
#     remains real and documented — only the exclusivity words ("only",
#     "nur über") are denied.
CII_ABSENCE_DENIALS = (
    # "the raw-XML CLI surface stays honestly UBL-only" — product noun + verb.
    r"(?:engine|validator|cli|surface|parser|tool|input|xml|path)\s+"
    r"(?:is|are|stays|remains|ist|bleibt)\s+(?:honestly\s+)?ubl[- ]only",
    # "a UBL-only validator", "UBL-only engine".
    r"ubl[- ]only\s+(?:engine|validator|cli|tool|surface|parser|support)",
    # "build_receipt validates through the UBL-only `validate_file` code path"
    # (REPORT-SCHEMA.md, found by T-VHCII3.2): the same claim with a backticked
    # IDENTIFIER standing in where the product noun would be. Deliberately does
    # NOT list "rule", so the honest "each remaining UBL-only rule is not …
    # proven on CII" measurement prose in COVERAGE.md keeps passing.
    r"ubl[- ]only\s+`[^`]{1,40}`\s+(?:code\s+)?"
    r"(?:path|route|surface|entry\s+point|function|api)",
    # "plus CII (via the ZUGFeRD/Factur-X PDF container) only".
    r"(?:cii|zugferd|factur-x)[^.]{0,60}container\)?\s*only",
    # "CII is supported only via the PDF container".
    r"cii[^.]{0,80}only\s+(?:via|through|inside|in)\b",
    # German: "CII nur über den ZUGFeRD/Factur-X-PDF-Container", and the
    # reversed word order "nur über den PDF-Container … CII".
    r"cii[^.]{0,80}nur\s+(?:[üu]ber|per|via|mit)\b",
    r"nur\s+[üu]ber[^.]{0,60}(?:pdf|zugferd|factur-x)[- ]?container",
)

# ---------------------------------------------------------------------------
# RAW-CII AFFIRMATION (T-VHCIISELL.1/.2) — the positive counterpart to the
# denylist above.
#
# Not denying a capability is a weaker bar than STATING it, and silence cost us
# the same prospect a denial would: the three surfaces a German ERP evaluator
# reads before spending ten minutes on us — the English landing, the comparison
# table, and the German product page — named the CII root element ZERO times
# between them, while the compare page told that same reader to "use
# Mustangproject when Java or PDF-writing is in play". A reader holding a
# ZUGFeRD/Factur-X XML could not tell the tool applied to them at all.
#
# So each page below must name the CII document root by its conventional
# prefixed form. Anchored to the SAME probe as the denylist: if the engine ever
# stopped grading a raw CrossIndustryInvoice, the probe assertion fires first,
# because then these pages SHOULD lose the claim rather than keep it.
PAGES_AFFIRMING_CII_ROOT = (
    "index.html",
    os.path.join("compare", "index.html"),
    os.path.join("de", "index.html"),
)


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

    def test_no_www_page_claims_pypi_absence(self):
        """FAIL if any generated page (EN or DE) asserts the package is absent
        from PyPI. Static and offline: the distribution's existence is a
        committed fact (PYPI_DISTRIBUTION), never a network probe."""
        patterns = [re.compile(p, re.IGNORECASE) for p in PYPI_ABSENCE_DENIALS]
        offenders = []
        for rel, text in sorted(self.pages.items()):
            for pat in patterns:
                m = pat.search(text)
                if m:
                    offenders.append(
                        "www/%s claims PyPI-absence via /%s/ -> matched %r "
                        "(the distribution %r is published; vendoring is an "
                        "offline ALTERNATIVE, not the only route)"
                        % (rel, pat.pattern, m.group(0), PYPI_DISTRIBUTION)
                    )
        self.assertEqual(
            offenders, [],
            "www/ pages tell readers the package is not on PyPI:\n  "
            + "\n  ".join(offenders),
        )

    def test_no_www_page_claims_cii_absence(self):
        """FAIL if any generated page (EN or DE) tells the reader raw CII is
        out of scope — that the tool is UBL-only, or that CII works only
        through the ZUGFeRD/Factur-X PDF container.

        Anchored to the engine, not to an opinion: the probe must first
        demonstrate that a raw CrossIndustryInvoice root really is graded. If
        that capability were ever removed, the denials would become TRUE again
        and this guard must not keep failing pages for telling the truth — so
        the probe assertion below is what fires instead.
        """
        present, evidence = probe_raw_cii_root_accepted()
        self.assertTrue(
            present,
            "PROBE FAILED — the engine no longer grades a raw CII root (%s). "
            "Fix the engine, or the CII_ABSENCE_DENIALS denylist is no longer "
            "a denylist of falsehoods." % evidence)

        patterns = [re.compile(p, re.IGNORECASE) for p in CII_ABSENCE_DENIALS]
        offenders = []
        for rel, text in sorted(self.pages.items()):
            for pat in patterns:
                m = pat.search(text)
                if m:
                    offenders.append(
                        "www/%s claims CII-absence via /%s/ -> matched %r "
                        "(engine proof: %s)"
                        % (rel, pat.pattern, m.group(0), evidence))
        self.assertEqual(
            offenders, [],
            "www/ pages tell readers raw CII is unsupported or PDF-container-"
            "only:\n  " + "\n  ".join(offenders))

    def test_cii_denial_patterns_actually_match_the_shipped_falsehoods(self):
        """A denylist nobody can trip is decoration. Each CII_ABSENCE_DENIALS
        pattern is proved to fire on the real sentence it was written for, and
        the whole list is proved NOT to fire on the rule-binding COUNT fact
        (`12 are officially UBL-only and 4 are CII-only`) that must survive on
        www/index.html."""
        shipped_falsehoods = (
            "the raw-xml cli surface stays honestly ubl-only: einvoice "
            "validate on a raw cii .xml returns s-root",
            "this is a ubl-only validator for now",
            "`build_receipt` validates through the ubl-only `validate_file` "
            "code path, so a cii/factur-x xml today yields the deterministic "
            "`s-root` fail receipt",
            "are both validated through the same en 16931 engine, plus cii "
            "(via the zugferd/factur-x pdf container) only. every fireable",
            "cii documents are supported only via the factur-x pdf container",
            "cii wird nur über den zugferd/factur-x-pdf-container "
            "unterstützt",
            "roh-xml wird nur über den zugferd-pdf-container gelesen",
        )
        patterns = [re.compile(p, re.IGNORECASE) for p in CII_ABSENCE_DENIALS]
        for pat in patterns:
            self.assertTrue(
                any(pat.search(s) for s in shipped_falsehoods),
                "CII_ABSENCE_DENIALS pattern %r matches none of the shipped "
                "falsehoods it is supposed to catch — dead pattern" %
                pat.pattern)
        for sample in shipped_falsehoods:
            self.assertTrue(
                any(pat.search(sample) for pat in patterns),
                "no CII_ABSENCE_DENIALS pattern catches the shipped falsehood "
                "%r" % sample)

        must_survive = (
            "297 asserted rules are differential-proven on both ubl and cii, "
            "12 are officially ubl-only and 4 are cii-only, with 0 rules left "
            "on the cii-fireable worklist",
            "and so is un/cefact cii — both as a plain .xml file whose "
            "root element is crossindustryinvoice and as the xml embedded in "
            "a zugferd/factur-x .pdf, which the page extracts for you",
        )
        for sample in must_survive:
            hits = [p.pattern for p in patterns if p.search(sample)]
            self.assertEqual(
                hits, [],
                "CII_ABSENCE_DENIALS false-positives on honest text %r via %r"
                % (sample, hits))

    def test_high_intent_pages_affirm_the_raw_cii_root(self):
        """Each high-intent surface must NAME the CII document root, so a
        reader holding a ZUGFeRD/Factur-X XML can tell the tool takes it.

        The claim is anchored to the engine: the probe demonstrating that a raw
        CrossIndustryInvoice really is graded runs FIRST, so this can never
        force a page to assert something untrue.
        """
        present, evidence = probe_raw_cii_root_accepted()
        self.assertTrue(
            present,
            "PROBE FAILED — the engine no longer grades a raw CII root (%s), "
            "so these pages must not affirm it either." % evidence)

        # The conventional prefixed form, with the localname taken from the ONE
        # dispatch seam rather than hand-typed here.
        expected = ("rsm:" + CII_ROOT_LOCALNAME).lower()
        for rel in PAGES_AFFIRMING_CII_ROOT:
            self.assertIn(
                rel, self.pages,
                "expected generated page www/%s is missing — run gen_site.py"
                % rel)
            self.assertIn(
                expected, self.pages[rel],
                "www/%s never names %s — the CII root the engine actually "
                "accepts (%s). A German ERP reader with a ZUGFeRD/Factur-X "
                "XML cannot tell this tool applies to them."
                % (rel, expected, evidence))

    def test_install_facing_pages_name_the_real_distribution(self):
        """The English landing and the German product page must each name the
        real distribution `verifyhash-einvoice`, so a reader who wants to
        install gets a command that actually works."""
        for rel in PAGES_NAMING_DISTRIBUTION:
            self.assertIn(
                rel, self.pages,
                "expected generated page www/%s is missing — run gen_site.py"
                % rel)
            self.assertIn(
                PYPI_DISTRIBUTION, self.pages[rel],
                "www/%s never names the real distribution %r — an install-"
                "facing page that cannot be acted on" % (rel, PYPI_DISTRIBUTION))

    def test_pypi_fact_is_static_not_probed(self):
        """This guard must derive nothing from the outside world. Every module
        object bound in this file's namespace has to come from the allowlist
        below (stdlib text/test helpers plus the product package itself), so a
        future edit that reaches for a fetching or process-spawning library to
        'check PyPI live' fails HERE instead of turning the suite flaky on a
        firewalled runner."""
        allowed = {"html", "os", "re", "sys", "types", "unittest",
                   "parser_cii", "rules", "einvoice", "__builtins__"}
        imported = sorted(
            name for name, obj in globals().items()
            if isinstance(obj, types.ModuleType))
        unexpected = [n for n in imported if n not in allowed]
        self.assertEqual(
            unexpected, [],
            "test_www_claims bound unexpected module(s) %r — this gate is "
            "static and offline by contract; PyPI availability is a committed "
            "fact (%r), never a live lookup" % (unexpected, PYPI_DISTRIBUTION))


if __name__ == "__main__":
    unittest.main(verbosity=2)

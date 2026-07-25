#!/usr/bin/env python3
"""test_capability_disclosure.py — make SILENCE a test failure (T-VHCIISELL.3).

The UNDERCLAIM defect class: we ship a capability, the artifact reports it
honestly, and the pages that sell the product never name it. Nothing internal
could detect that. The concrete instance this run measured: the published wheel's
PyPI METADATA mentions ``CrossIndustryInvoice`` 4x / ``ZUGFeRD`` 3x /
``Factur`` 6x — the artifact told the truth — while the generated site said
nothing about validating a raw CII root. Zero adoption for fully-paid
engineering, and no gate went red.

This test closes the class. It does NOT check prose quality, wording, ordering
or sentence shape (that would freeze copy and is ``test_site.py`` /
``test_www_claims.py``'s job, not this one). It checks exactly one thing:

    every capability the shipped artifact advertises is either MENTIONED on the
    page that sells it, or explicitly declared DELIBERATELY-UNSOLD with a reason.

How the capability surface is obtained (this is the load-bearing part — the
surface must come from the ARTIFACT, never from a literal in this file):

  1. ``test_wheel_self_report.build_install_image()`` is imported and reused to
     materialise a wheel-only install image (packages + package-data exactly as
     pyproject declares — no second image builder, no pip, no build backend).
  2. ``einvoice.capabilities()`` — the identical payload to ``einvoice info
     --json`` — is run in a subprocess rooted at that image.
  3. The loop below iterates the payload's own ``formats`` list, ``profiles``
     list, and the KEYS of ``coverage.syntax_binding``. Add a tenth report
     format tomorrow and this test starts failing tomorrow, with the new format
     named, until someone puts it on the compare page or declares it unsold.

Offline, stdlib only, no network, no writes outside a temp dir, runtime seconds.
"""

from __future__ import annotations

import html as _html
import os
import re
import shutil
import tempfile
import unittest

# Protocol (g): REUSE the wheel-image builder and the capabilities runner; do NOT
# write a second one. Imported as a MODULE (not `from … import …`) so unittest
# does not re-collect and re-run that file's own suite as part of this one.
import test_wheel_self_report as _wheel

build_install_image = _wheel.build_install_image

HERE = os.path.dirname(os.path.abspath(__file__))
WWW_DIR = os.path.join(HERE, "www")


# ---------------------------------------------------------------------------
# The disclosure table.
#
# ONE explicit mapping: capability -> the generated page(s) under einvoice/www/
# that must mention it, each entry carrying its reason (why THAT page is the
# surface that sells THAT capability). Entries are keyed by the value the
# artifact reports, so a value the artifact reports and this table does not
# carry is a hard failure that names the value.
#
# `match` selects what "mention" means, and nothing more:
#   "code" — the token is the exact content of some <code> element on the page
#            (a report format is something a buyer TYPES: `--format sarif`, so
#            appearing as a literal code token is the factual disclosure, and it
#            cannot be faked by the word turning up in markup or prose);
#   "text" — the token appears as a whole word in the page's tag-stripped,
#            entity-decoded visible text (case-insensitive, so capitalisation
#            and &nbsp;-vs-space stay free for the copywriter).
# ---------------------------------------------------------------------------

COMPARE = "compare/index.html"
LANDING = "index.html"
GERMAN = "de/index.html"


class Sold:
    """A capability that must be named on at least the listed pages."""

    def __init__(self, token, pages, match, reason):
        self.token = token
        self.pages = tuple(pages)
        self.match = match
        self.reason = reason


class DeliberatelyUnsold:
    """A capability we ship on purpose but do NOT sell on any page.

    Exists so the table can be honest rather than aspirational: an internal-only
    or purely-diagnostic capability is declared here WITH a reason instead of
    being quietly ignored. There is no entry using it today (every capability
    the artifact currently advertises is genuinely on a sales page); the
    machinery is exercised by
    ``test_deliberately_unsold_entry_satisfies_the_checker``.
    """

    def __init__(self, reason):
        self.reason = reason


# Report formats. The compare page is the surface: it is where a buyer decides
# whether this tool drops into THEIR pipeline, and it is the only page that
# enumerates the whole format list (as <code> tokens they can paste after
# `--format`). The landing page deliberately stays short, so requiring the long
# tail there would be a copy demand, not a disclosure demand.
_FORMAT_PAGES = (COMPARE,)
DISCLOSURE_TABLE = {
    # --- report formats (payload key: "formats") --------------------------
    # Default human-readable output; the format someone sees before buying.
    ("format", "text"): Sold("text", _FORMAT_PAGES, "code",
                             "default terminal output — the first thing a trial user sees"),
    # Machine surface behind every integration; named so API buyers see it.
    ("format", "json"): Sold("json", _FORMAT_PAGES, "code",
                             "the scripting/API surface buyers integrate against"),
    # Test-runner ingestion: the reason a CI buyer picks us over a Java tool.
    ("format", "junit"): Sold("junit", _FORMAT_PAGES, "code",
                              "JUnit XML is how findings land in any CI test report"),
    # Code-scanning ingestion — the GitHub security-tab story.
    ("format", "sarif"): Sold("sarif", _FORMAT_PAGES, "code",
                              "SARIF is what GitHub code scanning ingests"),
    # GitLab Code Quality report — a distinct buyer population.
    ("format", "gitlab"): Sold("gitlab", _FORMAT_PAGES, "code",
                               "GitLab Code Quality is a separate CI buyer population"),
    # Inline PR annotations without security-events permission (T-VHERG.8).
    ("format", "github"): Sold("github", _FORMAT_PAGES, "code",
                               "inline PR annotations, no security-events permission"),
    # Azure Pipelines logging commands — the third major CI vendor.
    ("format", "azure"): Sold("azure", _FORMAT_PAGES, "code",
                              "Azure Pipelines is the third CI vendor buyers ask about"),
    # Shields-style badge — the public-proof artifact people put in a README.
    ("format", "badge"): Sold("badge", _FORMAT_PAGES, "code",
                              "README badge — the public conformance proof"),
    # Shareable report a non-technical stakeholder can open.
    ("format", "html"): Sold("html", _FORMAT_PAGES, "code",
                             "the report a finance stakeholder can open unaided"),

    # --- profiles (payload key: "profiles") --------------------------------
    # The European norm itself: the mandate every buyer is procuring against.
    ("profile", "en16931"): Sold(
        "EN 16931", (LANDING, COMPARE, GERMAN), "text",
        "the norm the buyer is procuring against — must be on all three sales pages"),
    # The German CIUS: the specific obligation driving the German market.
    ("profile", "xrechnung"): Sold(
        "XRechnung", (LANDING, COMPARE, GERMAN), "text",
        "the German CIUS obligation; the German page exists for exactly this"),

    # --- document syntaxes (derived from coverage.syntax_binding KEYS) -----
    # UBL 2.1 Invoice/CreditNote — half the mandate's syntax surface.
    ("syntax", "ubl"): Sold(
        "UBL", (LANDING, COMPARE, GERMAN), "text",
        "half the mandate's syntax surface; a buyer filters on it first"),
    # The other half, and the exact capability this defect class was found on:
    # a raw rsm:CrossIndustryInvoice root validates directly (ZUGFeRD/Factur-X
    # carry this syntax), which the site was silent about until T-VHCIISELL.1.
    ("syntax", "cii"): Sold(
        "CrossIndustryInvoice", (LANDING, COMPARE, GERMAN), "text",
        "the underclaimed capability that motivated this gate — never again silent"),
}


# ---------------------------------------------------------------------------
# Page reading + the checker
# ---------------------------------------------------------------------------

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
_CODE_RE = re.compile(r"<code\b[^>]*>(.*?)</code>", re.S | re.I)


def _read(rel_page):
    with open(os.path.join(WWW_DIR, rel_page), encoding="utf-8") as fh:
        return fh.read()


def page_text(rel_page):
    """Visible text of a generated page: tags stripped, entities decoded,
    NBSP folded to a space, whitespace collapsed."""
    raw = _html.unescape(_TAG_RE.sub(" ", _read(rel_page)))
    return _WS_RE.sub(" ", raw.replace("\xa0", " "))


def page_code_tokens(rel_page):
    """The set of exact <code>…</code> contents on a generated page."""
    out = set()
    for inner in _CODE_RE.findall(_read(rel_page)):
        out.add(_WS_RE.sub(" ", _html.unescape(_TAG_RE.sub("", inner))).strip())
    return out


class UndisclosedCapability(AssertionError):
    """Raised when a shipped capability is neither disclosed nor declared."""


def _mentions(rel_page, entry):
    if entry.match == "code":
        return entry.token in page_code_tokens(rel_page)
    if entry.match == "text":
        return re.search(r"\b%s\b" % re.escape(entry.token),
                         page_text(rel_page), re.I) is not None
    raise ValueError("unknown match mode %r" % (entry.match,))


def check_capability_disclosure(surface, table=None, reader=_mentions):
    """Raise ``UndisclosedCapability`` unless every capability in ``surface``
    is disclosed on its mapped page(s) or declared deliberately unsold.

    ``surface`` is an iterable of ``(kind, value)`` pairs derived at runtime
    from the artifact's own ``capabilities()`` payload — this function never
    knows what capabilities exist, which is why adding one trips it.
    """
    if table is None:
        table = DISCLOSURE_TABLE
    problems = []
    for kind, value in surface:
        entry = table.get((kind, value))
        if entry is None:
            problems.append(
                "%s %r is advertised by the shipped artifact but has NO entry in "
                "DISCLOSURE_TABLE. The buying decision happens on einvoice/www/ — a "
                "capability nobody names earns zero adoption at full engineering "
                "cost. Fix it one of two ways: (a) DISCLOSE it — regenerate a page "
                "(index.html / compare/ / de/) that mentions %r and add the "
                "(%r, %r) entry pointing at that page, or (b) declare it "
                "DELIBERATELY-UNSOLD by adding "
                "(%r, %r): DeliberatelyUnsold(reason=\"…why we ship it but do not "
                "sell it…\")." % (kind, value, value, kind, value, kind, value))
            continue
        if isinstance(entry, DeliberatelyUnsold):
            if not str(entry.reason).strip():
                problems.append(
                    "%s %r is marked DELIBERATELY-UNSOLD with an empty reason; an "
                    "unsold capability needs a stated reason or it is just silence "
                    "with extra steps." % (kind, value))
            continue
        for rel_page in entry.pages:
            if not reader(rel_page, entry):
                problems.append(
                    "%s %r is declared SOLD on www/%s (reason: %s) but that page "
                    "never mentions %r (match mode %r). Either the page regressed "
                    "or the declaration is wrong — disclose it or mark it "
                    "DeliberatelyUnsold."
                    % (kind, value, rel_page, entry.reason, entry.token,
                       entry.match))
    if problems:
        raise UndisclosedCapability(
            "capability disclosure failed:\n  - " + "\n  - ".join(problems))


def surface_from_payload(payload):
    """Derive the ``(kind, value)`` capability surface from the artifact payload.

    Formats and profiles come from the payload's own lists; the supported
    document SYNTAXES come from the KEYS of ``coverage.syntax_binding`` (the
    pair is read, never retyped).
    """
    surface = []
    for value in payload["formats"]:
        surface.append(("format", value))
    for value in payload["profiles"]:
        surface.append(("profile", value))
    for value in payload["coverage"]["syntax_binding"]:
        surface.append(("syntax", value))
    return surface


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class CapabilityDisclosure(unittest.TestCase):
    """Runs `capabilities()` out of a reconstructed wheel image (builder and
    runner both reused from test_wheel_self_report — no duplicate machinery)."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.mkdtemp(prefix="einvoice-capdisc-")
        # Reused verbatim from test_wheel_self_report — one image builder only.
        cls.image = build_install_image(cls._tmp)
        # Reused verbatim likewise: runs `einvoice.capabilities()` in a
        # subprocess whose import root IS the wheel image.
        runner = _wheel.WheelSelfReport("test_rule_count_297")
        runner.image = cls.image
        cls.payload = runner._run_capabilities()
        cls.surface = surface_from_payload(cls.payload)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def test_surface_is_non_trivial_and_artifact_derived(self):
        """Guard the guard: if capabilities() ever returned an empty payload the
        disclosure loop would vacuously pass, so pin that the surface really
        carries formats, profiles and both syntaxes."""
        kinds = {}
        for kind, value in self.surface:
            kinds.setdefault(kind, set()).add(value)
        self.assertGreaterEqual(len(kinds.get("format", ())), 5, self.surface)
        self.assertGreaterEqual(len(kinds.get("profile", ())), 2, self.surface)
        self.assertEqual(len(kinds.get("syntax", ())), 2, self.surface)
        # Sanity: the payload came from the wheel image, not a stub.
        self.assertTrue(self.payload.get("version"))

    def test_every_advertised_capability_is_disclosed_or_declared(self):
        """THE invariant: silence about a shipped capability is a failure."""
        check_capability_disclosure(self.surface)

    def test_undeclared_capability_fails_with_a_naming_message(self):
        """The negative branch — a guard nobody can trip is decoration.

        Inject a synthetic capability value that is deliberately absent from the
        mapping table and prove the checker refuses it, NAMES it, and tells the
        reader the two legitimate ways out.
        """
        synthetic = "quantumledger"
        self.assertNotIn(("format", synthetic), DISCLOSURE_TABLE)
        poisoned = list(self.surface) + [("format", synthetic)]

        with self.assertRaises(UndisclosedCapability) as ctx:
            check_capability_disclosure(poisoned)
        message = str(ctx.exception)
        self.assertIn(synthetic, message,
                      "the failure must NAME the undisclosed capability")
        self.assertIn("DISCLOSURE_TABLE", message)
        self.assertIn("DeliberatelyUnsold", message)
        self.assertIn("www/", message)
        # And the real surface (same call, without the injection) still passes,
        # so the failure is attributable to the injected capability alone.
        check_capability_disclosure(self.surface)

    def test_undeclared_page_regression_also_fails(self):
        """The other half of the negative branch: a capability that IS in the
        table but stops being mentioned on its page must fail and name the page.

        Simulated by a reader that reports 'not mentioned' for one page, so the
        committed HTML is never edited to prove this."""
        target = ("syntax", "cii")
        entry = DISCLOSURE_TABLE[target]
        blind = lambda rel_page, e: False if rel_page == entry.pages[0] else _mentions(rel_page, e)
        with self.assertRaises(UndisclosedCapability) as ctx:
            check_capability_disclosure([target], reader=blind)
        message = str(ctx.exception)
        self.assertIn(entry.pages[0], message)
        self.assertIn(entry.token, message)

    def test_deliberately_unsold_entry_satisfies_the_checker(self):
        """An honestly-declared unsold capability passes; an unsold capability
        with a blank reason does not (a reason-less exemption is just silence)."""
        cap = [("format", "internalonly")]
        check_capability_disclosure(
            cap, table={("format", "internalonly"): DeliberatelyUnsold(
                reason="diagnostic-only dump, never advertised")})
        with self.assertRaises(UndisclosedCapability) as ctx:
            check_capability_disclosure(
                cap, table={("format", "internalonly"): DeliberatelyUnsold(reason="  ")})
        self.assertIn("internalonly", str(ctx.exception))

    def test_table_has_no_stale_entries(self):
        """Keep the table honest in the other direction too: an entry for a
        capability the artifact no longer advertises is dead weight that would
        make the table read as broader coverage than it has."""
        advertised = set(self.surface)
        stale = sorted(k for k in DISCLOSURE_TABLE if k not in advertised)
        self.assertEqual(
            stale, [],
            "DISCLOSURE_TABLE entries for capabilities the artifact no longer "
            "reports: %r — remove them or restore the capability" % (stale,))

    def test_pages_referenced_by_the_table_exist(self):
        for (kind, value), entry in sorted(DISCLOSURE_TABLE.items()):
            if isinstance(entry, DeliberatelyUnsold):
                continue
            self.assertTrue(entry.pages, "%s %r declares no page" % (kind, value))
            self.assertTrue(str(entry.reason).strip(),
                            "%s %r declares no reason" % (kind, value))
            for rel_page in entry.pages:
                self.assertTrue(
                    os.path.isfile(os.path.join(WWW_DIR, rel_page)),
                    "www/%s (mapped for %s %r) does not exist" % (rel_page, kind, value))


if __name__ == "__main__":
    unittest.main(verbosity=2)

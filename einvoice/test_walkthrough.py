#!/usr/bin/env python3
"""test_walkthrough.py — the worked 'failing CI to fixed invoice' walkthrough
page (``einvoice/www/walkthrough/index.html``) must show the REAL engine report
for examples/01-missing-fields/broken.xml (no drift), the corrected invoice must
actually pass the engine, and the page must be self-contained and indexable.

Fast, stdlib-only, saxonche-free, offline. The point of this gate is that the
shareable walkthrough page can never silently disagree with what the tool
emits: it re-runs the LIVE ``einvoice.report`` engine (the same entry point an
end user runs) and asserts every finding's rule id, plain-language title, fix
hint, EN 16931 BT/BG terms and severity appear on the page, and that the count
of findings matches. It also re-runs the engine on fixed.xml and asserts it
passes with zero fatal findings.

Run from the einvoice dir:  python3 test_walkthrough.py

Checks (each an independent hard assert):

  (1) The page exists at the stable canonical path www/walkthrough/index.html
      and is byte-identical to a fresh gen_site.render_walkthrough() (i.e.
      gen_site.py has been run and the committed page is not stale).
  (2) NO-DRIFT vs LIVE engine: for the LIVE report of broken.xml, every
      violation's rule / title / fix_hint / terms / severity appears in the
      page's visible text, the number of rendered findings equals the live
      count, and the committed report.json equals live output field-for-field.
  (3) Each violated rule id links back to its per-rule reference page.
  (4) The full broken invoice XML and the corrected-invoice element diff
      (the restored <cbc:BuyerReference> and <cac:Contact>) are shown.
  (5) fixed.xml PASSES the live engine: valid:true, fatal_count 0, exit 0.
  (6) Self-contained + indexable: no external CSS/JS/CDN/font/network
      reference, all report/invoice-derived text HTML-escaped (no raw '<' from
      the corpus), no robots:noindex, and the page is listed in sitemap.xml.
      The ONE <script> a page may carry is the inline schema.org ld+json
      structured-data block (T-VHSHARE.2) — exactly one, it must parse, it must
      not break out of its element, and it carries no src; anything else with a
      <script>, a src= or an external URL still fails. Same allowance
      test_site.py already grants every rule/sales page.
"""

from __future__ import annotations

import html
import json
import os
import re
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "einvoice"))

from einvoice import remediation as _remediation   # noqa: E402
import gen_site as _gen                             # noqa: E402
from gen_examples import live_report_json           # noqa: E402

WWW_DIR = os.path.join(HERE, "www")
WALK_PATH = os.path.join(WWW_DIR, "walkthrough", "index.html")
DE_WALK_PATH = os.path.join(WWW_DIR, "de", "walkthrough", "index.html")
SITEMAP_PATH = os.path.join(WWW_DIR, "sitemap.xml")

_TAG_RE = re.compile(r"<[^>]*>")
# A CONCRETE rule id as the live report emits them (BR-DE-2, BR-DE-15,
# BR-DE-TMP-32, BR-CO-05, ...): a BR- family token that ends in a numeric
# segment. Deliberately does NOT match a family GLOB (``BR-DE-*``) or a
# BT-/BG- business term, so it captures exactly the rule ids a page names.
_RULE_ID_RE = re.compile(r"\bBR-[A-Z]+(?:-[A-Z0-9]+)*-\d+\b")
# Every CLI invocation of the tool shown on a page (a command line, not XML).
_CMD_RE = re.compile(r"python3 -m einvoice\.report[^<\n]*")
# The one inline schema.org JSON-LD block a page carries (T-VHSHARE.2 added the
# BreadcrumbList block to both walkthroughs). Structured DATA consumed by
# crawlers, never a fetched resource: its schema.org @context IRI and its
# absolute BASE_URL item URLs are therefore stripped before the
# external-resource scan — the SAME convention test_site.py uses (_LD_RE +
# bad_script_re there). Nothing is loosened: a <script> that is NOT this inline
# ld+json block, and any src= outside it, still fail hard below.
_LD_RE = re.compile(
    r'<script type="application/ld\+json">(.*?)</script>', re.S)
_BAD_SCRIPT_RE = re.compile(
    r'<script\b(?![^>]*type="application/ld\+json")', re.IGNORECASE)


def _visible_text(page):
    """Human-visible text of a page: tags removed, then HTML-unescaped."""
    return html.unescape(_TAG_RE.sub(" ", page))


def _run_report(rel_path):
    """Drive `python3 -m einvoice.report <rel_path> --format json` from HERE."""
    return subprocess.run(
        [sys.executable, "-m", "einvoice.report", rel_path, "--format", "json"],
        cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


class WalkthroughTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(os.path.isfile(WALK_PATH),
                        "walkthrough page missing — run `python3 gen_site.py`")
        with open(WALK_PATH, encoding="utf-8") as fh:
            self.page = fh.read()
        self.vis = _visible_text(self.page)
        self.catalog = _remediation.load_catalog()

    # (1) committed page is current with the generator (not stale).
    def test_page_matches_fresh_render(self):
        fresh = _gen.render_walkthrough(self.catalog)
        self.assertEqual(
            self.page, fresh,
            "www/walkthrough/index.html is STALE vs gen_site.render_walkthrough "
            "— run `python3 gen_site.py`")

    # (2) NO-DRIFT: every LIVE finding is on the page; counts agree.
    def test_report_matches_live_engine(self):
        broken_rel = os.path.relpath(_gen.EX_BROKEN, HERE)
        live = live_report_json(_gen.EX_BROKEN)
        violations = live.get("violations", [])
        self.assertGreaterEqual(len(violations), 1,
                                "live engine produced no findings for broken.xml")

        # The committed report.json the page renders from equals live output.
        with open(_gen.EX_REPORT, encoding="utf-8") as fh:
            committed = json.load(fh)
        self.assertEqual(
            committed, live,
            "report.json is STALE vs live engine — run `python3 gen_examples.py`")

        # Every violation's fields appear verbatim in the page's visible text.
        for v in violations:
            rule = v["rule"]
            with self.subTest(rule=rule):
                self.assertIn(rule, self.vis,
                              "%s: rule id not on the walkthrough page" % rule)
                self.assertIn(v["title"], self.vis,
                              "%s: title not on the page" % rule)
                self.assertIn(v["fix_hint"], self.vis,
                              "%s: fix_hint not on the page" % rule)
                self.assertIn(v["severity"], self.vis,
                              "%s: severity not on the page" % rule)
                for term in v.get("terms", []):
                    self.assertIn(term, self.vis,
                                  "%s: term %s not on the page" % (rule, term))

        # The number of rendered finding cards equals the live finding count —
        # so the page can neither drop nor invent a finding.
        n_cards = self.page.count('<div class="finding">')
        self.assertEqual(
            n_cards, len(violations),
            "page renders %d finding cards but live engine reports %d"
            % (n_cards, len(violations)))

        # Summary counts on the page match the live report.
        self.assertIn("<code>%d</code>" % live["fatal_count"], self.page)
        self.assertIn("<code>%d</code>" % live["violation_count"], self.page)

        # The CLI command a reader would run is shown with the real rel path.
        self.assertIn(broken_rel, self.vis)

    # (3) each violated rule id links back to its per-rule reference page.
    def test_rules_linked_back(self):
        live = live_report_json(_gen.EX_BROKEN)
        for v in live.get("violations", []):
            rule = v["rule"]
            if rule in self.catalog:
                with self.subTest(rule=rule):
                    self.assertIn(
                        'href="../rules/%s/index.html"' % rule, self.page,
                        "%s: not linked to its per-rule reference page" % rule)
                    # And that target file actually exists (no dangling link).
                    self.assertTrue(
                        os.path.isfile(os.path.join(
                            WWW_DIR, "rules", rule, "index.html")),
                        "%s: linked per-rule page does not exist" % rule)

    # (4) broken invoice + the corrected-invoice element diff are shown.
    def test_broken_and_fix_shown(self):
        with open(_gen.EX_BROKEN, encoding="utf-8") as fh:
            broken_xml = fh.read()
        # A distinctive line of the broken invoice appears (escaped) on the page.
        self.assertIn("cbc:DocumentCurrencyCode", self.vis)
        self.assertIn("Zeitschrift Inland", self.vis)  # a real body value
        # The fix diff shows the two restored elements.
        self.assertIn("+", self.page)  # unified-diff add markers present
        self.assertIn("cbc:BuyerReference", self.vis,
                      "restored BuyerReference not shown in the fix")
        self.assertIn("cac:Contact", self.vis,
                      "restored SELLER CONTACT group not shown in the fix")
        # Sanity: broken.xml really is a subset (the fix is additive).
        self.assertNotIn("cbc:BuyerReference", broken_xml)

    # (5) fixed.xml PASSES the live engine: valid:true, fatal_count 0, exit 0.
    def test_fixed_passes_engine(self):
        fixed_rel = os.path.relpath(_gen.EX_FIXED, HERE)
        proc = _run_report(fixed_rel)
        self.assertEqual(
            proc.returncode, 0,
            "fixed.xml did not pass the engine:\n%s"
            % proc.stdout.decode("utf-8"))
        report = json.loads(proc.stdout.decode("utf-8"))
        self.assertTrue(report["valid"], "fixed.xml reported valid:false")
        self.assertEqual(report["fatal_count"], 0,
                         "fixed.xml has fatal findings")

    # (6) self-contained + indexable.
    def test_self_contained_and_indexable(self):
        # The absolute canonical + hreflang-alternate <link> hrefs are legitimate
        # https URLs (the same BASE_URL the sitemap uses), NOT fetched resources —
        # strip every <link> before the external-resource scan, exactly like
        # test_site.py does for the landing/de pages that carry alternates.
        scan = re.sub(r"<link\b[^>]*>", " ", self.page, flags=re.IGNORECASE)
        # Same reasoning for the link-preview og:url meta (T-VHSHARE.5): its
        # content is the SAME absolute BASE_URL canonical string, consumed by
        # social crawlers as metadata and never fetched by the page. The strip
        # is deliberately EXACT-MATCH, not a pattern: only an og:url that
        # byte-equals this page's own canonical disappears, so an og:url
        # pointing at any other origin still trips the scan below.
        scan = scan.replace(
            '<meta property="og:url" content="%s">' % _gen._url_walkthrough(),
            " ")
        # Strip the inline ld+json structured-data block (see _LD_RE) before the
        # scan, exactly as test_site.py does for every rule/sales page.
        scan_no_ld = _LD_RE.sub(" ", scan)
        # No external CSS/JS/CDN/font/network references remain.
        self.assertNotRegex(
            scan_no_ld,
            r'https?://|cdn\.|googleapis|fonts\.|goatcounter|url\(',
            "walkthrough references an external resource")
        # The ONLY <script> allowed is the inline ld+json block, exactly one of
        # them, and it must parse and be unable to break out of its element.
        self.assertNotRegex(self.page, _BAD_SCRIPT_RE,
                            "walkthrough has a non-ld+json <script>")
        ld_blocks = _LD_RE.findall(self.page)
        self.assertEqual(len(ld_blocks), 1,
                         "walkthrough: expected exactly 1 ld+json block, got %d"
                         % len(ld_blocks))
        self.assertNotIn("</script", ld_blocks[0].lower(),
                         "raw '</script>' survived inside the JSON-LD")
        json.loads(ld_blocks[0])  # raises -> test fails
        # No src= anywhere (no external asset); the ld+json block carries none.
        self.assertNotRegex(_LD_RE.sub(" ", self.page), r"\bsrc\s*=")
        # Every <link> is either the one self-referential rel=canonical or a
        # rel=alternate hreflang link (all absolute BASE_URL, none a fetched
        # resource) — no external stylesheet/icon/preload smuggled in.
        links = re.findall(r"<link\b[^>]*>", self.page, re.IGNORECASE)
        canon_links = [l for l in links if 'rel="canonical"' in l]
        alt_links = [l for l in links if 'rel="alternate"' in l]
        self.assertEqual(len(canon_links), 1,
                         "expected exactly one <link rel=canonical>")
        self.assertEqual(len(links), len(canon_links) + len(alt_links),
                         "walkthrough carries a <link> that is neither the "
                         "canonical nor an hreflang alternate: %r" % links)
        # Indexable: no robots:noindex meta.
        self.assertNotRegex(
            self.page, r'<meta[^>]*name="robots"[^>]*noindex',
            "walkthrough must not be noindex (it is in the sitemap)")
        # Injection guard: no raw '<' from corpus/report strings survived.
        # Every catalog title/fix and the report source path are escaped.
        live = live_report_json(_gen.EX_BROKEN)
        for v in live.get("violations", []):
            for key in ("title", "fix_hint"):
                s = v.get(key, "")
                if "<" in s:
                    self.assertNotIn(s, self.page,
                                     "report string appears UNESCAPED: %r" % s)
        # Listed in the sitemap under the same BASE_URL as the canonical.
        canon = re.search(r'rel="canonical" href="([^"]+)"', self.page).group(1)
        self.assertEqual(canon, _gen._url_walkthrough())
        with open(SITEMAP_PATH, encoding="utf-8") as fh:
            sm = fh.read()
        self.assertIn(_gen._url_walkthrough(), sm,
                      "walkthrough not listed in sitemap.xml")

    # (7) hreflang alternates in BOTH directions with the German walkthrough.
    def test_hreflang_both_directions(self):
        de = self._read_de()
        alt_re = re.compile(
            r'<link\b[^>]*\brel="alternate"[^>]*\bhreflang="([^"]*)"[^>]*'
            r'\bhref="([^"]*)"', re.IGNORECASE)
        en_alts = {hl: href for hl, href in alt_re.findall(self.page)}
        de_alts = {hl: href for hl, href in alt_re.findall(de)}
        # English page -> German page (hreflang="de") and itself (hreflang="en").
        self.assertEqual(en_alts.get("de"), _gen._url_de_walkthrough(),
                         "English walkthrough hreflang=de does not point at the "
                         "German walkthrough")
        self.assertEqual(en_alts.get("en"), _gen._url_walkthrough(),
                         "English walkthrough lacks its self hreflang=en")
        # German page -> English page (hreflang="en") and itself (hreflang="de").
        self.assertEqual(de_alts.get("en"), _gen._url_walkthrough(),
                         "German walkthrough hreflang=en does not point at the "
                         "English walkthrough")
        self.assertEqual(de_alts.get("de"), _gen._url_de_walkthrough(),
                         "German walkthrough lacks its self hreflang=de")

    # ---- German walkthrough: same anti-fabrication invariant as the English --
    def _read_de(self):
        self.assertTrue(os.path.isfile(DE_WALK_PATH),
                        "German walkthrough missing — run `python3 gen_site.py`")
        with open(DE_WALK_PATH, encoding="utf-8") as fh:
            return fh.read()

    # (8) committed German page is current with the generator (not stale).
    def test_de_page_matches_fresh_render(self):
        de = self._read_de()
        fresh = _gen.render_de_walkthrough(self.catalog)
        self.assertEqual(
            de, fresh,
            "www/de/walkthrough/index.html is STALE vs "
            "gen_site.render_de_walkthrough — run `python3 gen_site.py`")
        self.assertIn('<html lang="de">', de,
                      "German walkthrough does not declare lang=\"de\"")

    # (9) NO-DRIFT / NO-FABRICATION vs the LIVE engine: the German page names
    # EXACTLY the rule ids of the live report — every live rule id is present,
    # and no rule-id-shaped token absent from the report appears (so the German
    # narrative can neither drop nor invent a finding).
    def test_de_rule_ids_match_live_engine(self):
        de = self._read_de()
        de_vis = _visible_text(de)
        live = live_report_json(_gen.EX_BROKEN)
        live_rules = {v["rule"] for v in live.get("violations", [])}
        self.assertTrue(live_rules, "live engine produced no findings")
        # Every live rule id appears on the German page.
        for rule in live_rules:
            self.assertIn(rule, de_vis,
                          "%s: live rule id not on the German walkthrough" % rule)
        # The SET of concrete rule-id tokens on the German page is EXACTLY the
        # live rule set — no fabricated or stray rule id.
        page_rules = set(_RULE_ID_RE.findall(de_vis))
        self.assertEqual(
            page_rules, live_rules,
            "German walkthrough rule-id set %s != live report rule set %s"
            % (sorted(page_rules), sorted(live_rules)))
        # One finding card per live violation — cannot drop/invent a finding.
        self.assertEqual(
            de.count('<div class="finding">'), len(live.get("violations", [])),
            "German walkthrough finding-card count != live finding count")

    # (10) the German page's CLI commands are byte-identical to the English
    # walkthrough's (same drift-guard discipline as the English page).
    def test_de_commands_match_english(self):
        de = self._read_de()
        en_cmds = set(_CMD_RE.findall(self.page))
        de_cmds = set(_CMD_RE.findall(de))
        self.assertTrue(en_cmds, "no CLI commands found on the English page")
        self.assertEqual(
            de_cmds, en_cmds,
            "German walkthrough commands %s differ from English %s"
            % (sorted(de_cmds), sorted(en_cmds)))

    # (11) German page: self-contained + indexable (no external resource, one
    # canonical + hreflang alternates only, no script, listed in the sitemap).
    def test_de_self_contained_and_indexable(self):
        de = self._read_de()
        scan = re.sub(r"<link\b[^>]*>", " ", de, flags=re.IGNORECASE)
        # Exact-match strip of this page's own og:url (identical string to its
        # canonical, metadata not a fetched resource) — see the English test.
        scan = scan.replace(
            '<meta property="og:url" content="%s">'
            % _gen._url_de_walkthrough(), " ")
        self.assertNotRegex(
            _LD_RE.sub(" ", scan),
            r'https?://|cdn\.|googleapis|fonts\.|goatcounter|url\(',
            "German walkthrough references an external resource")
        self.assertNotRegex(de, _BAD_SCRIPT_RE,
                            "German walkthrough has a non-ld+json <script>")
        de_ld = _LD_RE.findall(de)
        self.assertEqual(len(de_ld), 1,
                         "German walkthrough: expected exactly 1 ld+json "
                         "block, got %d" % len(de_ld))
        self.assertNotIn("</script", de_ld[0].lower(),
                         "raw '</script>' survived inside the JSON-LD")
        json.loads(de_ld[0])  # raises -> test fails
        self.assertNotRegex(_LD_RE.sub(" ", de), r"\bsrc\s*=")
        links = re.findall(r"<link\b[^>]*>", de, re.IGNORECASE)
        canon = [l for l in links if 'rel="canonical"' in l]
        alt = [l for l in links if 'rel="alternate"' in l]
        self.assertEqual(len(canon), 1,
                         "German page expected exactly one rel=canonical")
        self.assertEqual(len(links), len(canon) + len(alt),
                         "German page has a non-canonical/non-alternate <link>")
        self.assertNotRegex(
            de, r'<meta[^>]*name="robots"[^>]*noindex',
            "German walkthrough must not be noindex (it is in the sitemap)")
        cmatch = re.search(r'rel="canonical" href="([^"]+)"', de)
        self.assertEqual(cmatch.group(1), _gen._url_de_walkthrough())
        with open(SITEMAP_PATH, encoding="utf-8") as fh:
            sm = fh.read()
        self.assertIn(_gen._url_de_walkthrough(), sm,
                      "German walkthrough not listed in sitemap.xml")
        # Injection guard: no unescaped '<' from live report strings survived.
        live = live_report_json(_gen.EX_BROKEN)
        for v in live.get("violations", []):
            for key in ("title", "fix_hint"):
                s = v.get(key, "")
                if "<" in s:
                    self.assertNotIn(s, de,
                                     "report string appears UNESCAPED: %r" % s)


if __name__ == "__main__":
    unittest.main()

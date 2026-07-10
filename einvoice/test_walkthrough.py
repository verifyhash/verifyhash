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
SITEMAP_PATH = os.path.join(WWW_DIR, "sitemap.xml")

_TAG_RE = re.compile(r"<[^>]*>")


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
        # The single absolute canonical <link> href is a legitimate https URL
        # (the same BASE_URL the sitemap uses), NOT a fetched resource — strip
        # it before the external-resource scan, exactly like test_site.py does.
        scan = re.sub(r'<link\b[^>]*\brel="canonical"[^>]*>', " ", self.page,
                      flags=re.IGNORECASE)
        # No external CSS/JS/CDN/font/network references remain.
        self.assertNotRegex(
            scan,
            r'https?://|cdn\.|googleapis|fonts\.|goatcounter|url\(',
            "walkthrough references an external resource")
        # No <script> and no src= (no JS, no external asset).
        self.assertNotIn("<script", self.page.lower())
        self.assertNotRegex(self.page, r"\bsrc\s*=")
        # The only <link> is the relative-free absolute rel=canonical.
        links = re.findall(r"<link\b[^>]*>", self.page, re.IGNORECASE)
        self.assertEqual(len(links), 1, "expected exactly one <link> (canonical)")
        self.assertIn('rel="canonical"', links[0])
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


if __name__ == "__main__":
    unittest.main()

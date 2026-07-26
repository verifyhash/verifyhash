#!/usr/bin/env python3
"""test_report_html.py — prove the T-VHI.2 self-contained HTML projection.

Fast, stdlib-only, saxonche-free, offline. Exercises the new
`python3 -m einvoice.report --format html` path against the SAME local corpus
fixture the packaging/xrechnung/junit/sarif tests already use — no new corpus,
no new rule logic, no network.

Asserted (each maps to a task acceptance criterion):
  (a) --format html on a KNOWN-GOOD invoice -> a full self-contained HTML
      document ("<!doctype html", inline <style>, zero external asset URLs) and
      a pass indicator, exit 0.
  (b) --format html on a KNOWN-BAD invoice -> every finding's rule id AND its
      fix-hint text appear in the HTML, process exits non-zero.
  (c) SELF-CONTAINMENT, stated precisely: the emitted HTML fetches NO external
      SUBRESOURCE — no <script> at all, no <img>, no remote src= on any
      element, no remote stylesheet <link>, no @import / url() web font, no
      embedded frame/object. That is exactly what "opens offline with zero
      network requests" means. A plain navigational <a href> is NOT a
      subresource (it issues no request until a human clicks it) and IS
      allowed — but only on an <a>, only absolute https. The guard is proved
      to still bite by a positive control (HtmlSelfContainmentGuard) that
      feeds it a remote stylesheet, a remote <script src> and a remote <img
      src> and asserts each is REJECTED.
  (d) a malformed-XML input yields a single error row and exit 3.
  (e) INJECTION: an invoice value containing <script> appears escaped — no
      literal <script> from invoice data lands in the output.
  (f) --baseline + --format html is rejected with a clear error and nonzero
      exit; the unknown-format usage lists html.
  (g) DETERMINISM (RPT.8): building the FULL document twice from the same
      committed fixture is byte-identical (byte-stability / regeneration
      stability — catches timestamp, dict-order or set-order leakage), both
      in-process via build_report+build_html and across two real CLI runs.
  (h) PATH INVARIANCE (RPT.8): built from a fixture referenced via an
      ABSOLUTE path under $HOME, the document contains no $HOME prefix, no
      absolute input-file path, no username, and no wall-clock timestamp —
      and a relative-path invocation of the same file (cwd = the fixture's
      dir) yields byte-identical HTML to the absolute-path invocation.
  (i) RULE LINKS (T-VHRPTH.1): a finding whose rule id is in the remediation
      catalog renders its id as an anchor whose href EQUALS the canonical
      rule-page URL `gen_site.py` publishes for that id (derived from
      `gen_site._url_rule` and from the shared runtime builder
      `report.rule_page_url`, never hard-coded here); an uncatalogued id and
      the not-well-formed error row render with NO link; a catalog-less
      installation degrades to a link-free document rather than a traceback;
      and the document names the offline escape hatch in the CLI's TRUE form,
      `einvoice --explain <RULE-ID>` (a global option, not a subcommand —
      asserted against the real CLI, not from memory).
"""

import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.report import (  # noqa: E402
    build_report, build_html, rule_page_url, _h)
from einvoice.remediation import load_catalog  # noqa: E402

# Reuse the exact fixture + bad-invoice construction the other fast gates use.
BASE = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test",
                    "business-cases", "standard", "01.01a-INVOICE_ubl.xml")
# The committed multi-finding example the docs and CI recipes use: three
# findings, all absence-class, all catalogued.
BROKEN = os.path.join(HERE, "examples", "01-missing-fields", "broken.xml")

# --------------------------------------------------------------------------- #
# SELF-CONTAINMENT, stated precisely (see docstring claim (c)).
#
# "Opens offline with zero network requests" is a claim about SUBRESOURCES —
# the things a browser fetches BY ITSELF while rendering: <script src>, <link
# rel="stylesheet" href>, <img src>, an @import or url(...) web font inside
# CSS, an <iframe>/<object>/<embed>. A plain navigational <a href> is not one
# of those: it costs zero requests until a human clicks it. So the guard below
# rejects (1) any <script> or <img> element at all, (2) any embedded-content
# element, (3) any CSS @import / remote url(), (4) any protocol-relative asset
# URL, and (5) any remote src=/href= that is NOT a plain <a href> — and it
# additionally requires every allowed link to be absolute https (the file is
# read from disk, where a relative URL would dangle).
#
# The rejection half is NOT taken on trust: HtmlSelfContainmentGuard below is a
# positive control that feeds this function synthetic documents carrying a
# remote stylesheet <link>, a remote <script src> and a remote <img src> and
# asserts each one is REJECTED.
# --------------------------------------------------------------------------- #

# One HTML start tag: group(1) = tag name, group(2) = its attribute text.
_TAG_RE = re.compile(r"<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>")
# A src=/href= attribute whose value is a remote http(s) URL.
_REMOTE_ATTR_RE = re.compile(
    r"""\b(src|href)\s*=\s*["']\s*(https?://[^"']*)""", re.I)
# A src=/href= attribute whose value is protocol-relative (//cdn.example/x.js).
_PROTOCOL_RELATIVE_RE = re.compile(r"""\b(?:src|href)\s*=\s*["']//""", re.I)
_SCRIPT_TAG_RE = re.compile(r"<script\b", re.I)
_IMG_TAG_RE = re.compile(r"<img\b", re.I)
_EMBED_TAG_RE = re.compile(
    r"<(?:iframe|frame|object|embed|video|audio|source|track|portal)\b", re.I)
_CSS_IMPORT_RE = re.compile(r"@import", re.I)
# url(https://...), url('https://...), url(//cdn...) inside a CSS block.
_CSS_REMOTE_URL_RE = re.compile(r"""url\(\s*["']?\s*(?:https?:)?//""", re.I)


def make_bad_invoice(dest):
    """Copy BASE with its BuyerReference removed -> violates BR-DE-15 (fatal)."""
    with open(BASE, encoding="utf-8") as fh:
        src = fh.read()
    bad = re.sub(r"<cbc:BuyerReference>[^<]*</cbc:BuyerReference>", "", src,
                 count=1)
    assert bad != src, "fixture drift: BASE lost its BuyerReference"
    with open(dest, "w", encoding="utf-8") as fh:
        fh.write(bad)


def _run(args):
    return subprocess.run(
        [sys.executable, "-m", "einvoice.report"] + args,
        cwd=HERE, capture_output=True, text=True, timeout=120)


def _assert_no_external_subresource(tc, htmltext):
    """Fail unless ``htmltext`` fetches ZERO external subresources.

    Strictly stronger than the old "no remote src=/href= anywhere" string
    match in every direction that matters (it now also catches <img>, frames,
    @import, web fonts and protocol-relative URLs), and deliberately weaker in
    exactly one place: a navigational <a href="https://..."> is allowed,
    because it is not a subresource.
    """
    tc.assertRegex(htmltext.lower(), r"<!doctype html")
    tc.assertIn("<style>", htmltext.lower())
    tc.assertFalse(_SCRIPT_TAG_RE.search(htmltext),
                   "a <script> element leaked into the HTML")
    tc.assertFalse(_IMG_TAG_RE.search(htmltext),
                   "an <img> element leaked into the HTML")
    tc.assertFalse(_EMBED_TAG_RE.search(htmltext),
                   "an embedded-content element leaked into the HTML")
    tc.assertFalse(_CSS_IMPORT_RE.search(htmltext),
                   "a CSS @import leaked into the HTML")
    tc.assertFalse(_CSS_REMOTE_URL_RE.search(htmltext),
                   "a remote CSS url(...) (web font/image) leaked into the "
                   "HTML")
    tc.assertFalse(_PROTOCOL_RELATIVE_RE.search(htmltext),
                   "a protocol-relative asset URL leaked into the HTML")
    for tag_match in _TAG_RE.finditer(htmltext):
        tag = tag_match.group(1).lower()
        for attr_match in _REMOTE_ATTR_RE.finditer(tag_match.group(2)):
            attr = attr_match.group(1).lower()
            url = attr_match.group(2)
            tc.assertEqual(
                (tag, attr), ("a", "href"),
                "remote %s= on <%s> is an external subresource the browser "
                "would fetch: %s" % (attr, tag, url))
            tc.assertTrue(
                url.startswith("https://"),
                "a link in a file-on-disk artifact must be absolute https, "
                "got %r" % url)


def _synthetic_doc(snippet):
    """A minimal well-formed document with ``snippet`` spliced into <body>."""
    return ('<!doctype html>\n<html lang="en">\n<head>\n'
            '<meta charset="utf-8">\n'
            '<meta name="robots" content="noindex">\n'
            "<style>body { margin: 0; }</style>\n"
            "</head>\n<body><main>\n" + snippet +
            "\n</main></body>\n</html>\n")


class HtmlGoodInvoice(unittest.TestCase):
    def test_good_invoice_self_contained_pass_exit_zero(self):
        proc = _run(["--profile", "xrechnung", "--format", "html", BASE])
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        out = proc.stdout
        _assert_no_external_subresource(self, out)
        # A pass indicator is present for a conformant invoice.
        self.assertIn("Conformant", out, out[:400])
        self.assertIn("banner pass", out)


class HtmlBadInvoice(unittest.TestCase):
    def test_bad_invoice_lists_findings_and_fix_hints(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "bad.xml")
            make_bad_invoice(bad)
            proc = _run(["--profile", "xrechnung", "--format", "html", bad])
            report = build_report(bad, profile="xrechnung")

        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        out = proc.stdout
        _assert_no_external_subresource(self, out)
        self.assertIn("Not conformant", out)

        self.assertTrue(report["violations"], "fixture must produce findings")
        self.assertIn("BR-DE-15", {v["rule"] for v in report["violations"]})

        # Every finding's rule id appears; every present fix-hint appears (HTML-
        # escaped, matching how build_html emits it).
        from einvoice.report import _h  # same escaper the projection uses
        for v in report["violations"]:
            self.assertIn(_h(v["rule"]), out,
                          "rule %s missing from HTML" % v["rule"])
            if v.get("fix_hint"):
                self.assertIn(_h(v["fix_hint"]), out,
                              "fix_hint for %s missing from HTML" % v["rule"])


class HtmlMalformed(unittest.TestCase):
    def test_malformed_input_single_error_row_exit_3(self):
        with tempfile.TemporaryDirectory() as tmp:
            broken = os.path.join(tmp, "broken.xml")
            with open(broken, "w", encoding="utf-8") as fh:
                fh.write("<Invoice><unclosed>")
            proc = _run(["--profile", "xrechnung", "--format", "html", broken])
        self.assertEqual(proc.returncode, 3, proc.stdout + proc.stderr)
        out = proc.stdout
        _assert_no_external_subresource(self, out)
        # Exactly one error row, and the not-well-formed code is shown.
        self.assertEqual(out.count('class="error-row"'), 1, out)
        self.assertIn("not-well-formed", out)


class HtmlInjectionSafety(unittest.TestCase):
    """Invoice/catalog-derived text is HTML-escaped: a <script> value in ANY
    projected field (message/field/fix_hint/title/terms/location) cannot inject
    live markup. Driven through build_html() directly with a synthetic report so
    the escaping of every field is exercised regardless of which invoice values
    a given rule happens to echo."""

    def test_script_bearing_fields_are_escaped(self):
        payload = "<script>alert('xss')</script>"
        report = {
            "source": "/tmp/%s.xml" % payload,
            "profile": "xrechnung",
            "valid": False,
            "fatal_count": 1,
            "warning_count": 0,
            "violation_count": 1,
            "violations": [{
                "rule": "BR-<script>evil",
                "severity": "fatal",
                "message": "bad value %s here" % payload,
                "field": "cbc:Note/%s" % payload,
                "title": "Title %s" % payload,
                "fix_hint": "Fix by removing %s" % payload,
                "terms": ["BT-1%s" % payload],
                "location": "loc/%s" % payload,
            }],
        }
        out = build_html(report)
        _assert_no_external_subresource(self, out)
        # No literal injected markup anywhere — not from message, field, title,
        # fix_hint, terms, location, rule id or source.
        self.assertNotIn(payload, out,
                         "raw <script> payload leaked unescaped into HTML")
        self.assertNotIn("<script>alert", out)
        # The escaped form is present (proving the values did flow through and
        # were neutralised, not merely dropped).
        self.assertIn(_h(payload), out)
        self.assertIn("&lt;script&gt;", out)

    def test_end_to_end_no_raw_script_from_invoice(self):
        # A real invoice carrying <script> in a text field never yields literal
        # <script> in the emitted document.
        with open(BASE, encoding="utf-8") as fh:
            src = fh.read()
        payload = "<script>alert('xss')</script>"
        evil_src = re.sub(r"(<cbc:BuyerReference>)[^<]*(</cbc:BuyerReference>)",
                          r"\1" + payload + r"\2", src, count=1)
        self.assertNotEqual(evil_src, src, "fixture drift: no BuyerReference")
        with tempfile.TemporaryDirectory() as tmp:
            evil = os.path.join(tmp, "evil.xml")
            with open(evil, "w", encoding="utf-8") as fh:
                fh.write(evil_src)
            proc = _run(["--profile", "xrechnung", "--format", "html", evil])
        out = proc.stdout
        _assert_no_external_subresource(self, out)
        self.assertNotIn(payload, out)
        self.assertNotIn("<script>alert", out)


class HtmlDeterminism(unittest.TestCase):
    """RPT.8: the HTML report is a reproducible CI artifact — byte-stable
    across regenerations and invariant to how (and from where) the input file
    path was spelled. No timestamp, no $HOME, no username in the bytes."""

    def test_whole_document_regeneration_byte_identical(self):
        # (g) Build the FULL document twice from the same committed fixture:
        # the two outputs must be byte-identical (whole-document byte-stability
        # over regeneration — any wall-clock timestamp, unordered-dict or
        # set-iteration leakage in the emitter breaks this).
        doc1 = build_html(build_report(BASE, profile="xrechnung"))
        doc2 = build_html(build_report(BASE, profile="xrechnung"))
        self.assertEqual(
            doc1.encode("utf-8"), doc2.encode("utf-8"),
            "regenerating the HTML report from the same fixture is NOT "
            "byte-identical — nondeterminism in build_report/build_html")
        _assert_no_external_subresource(self, doc1)

        # The same holds across two REAL CLI runs (catches env/process-level
        # nondeterminism the in-process pair cannot see).
        p1 = _run(["--profile", "xrechnung", "--format", "html", BASE])
        p2 = _run(["--profile", "xrechnung", "--format", "html", BASE])
        self.assertEqual(p1.returncode, 0, p1.stdout + p1.stderr)
        self.assertEqual(p2.returncode, 0, p2.stdout + p2.stderr)
        self.assertEqual(
            p1.stdout, p2.stdout,
            "two CLI runs over the same fixture emitted different HTML bytes")

    def test_path_invariance_no_home_username_timestamp(self):
        # (h) Precondition: the committed fixture IS referenced via an
        # absolute path under $HOME (so a leak would be visible).
        home = os.path.expanduser("~")
        username = os.path.basename(home.rstrip(os.sep))
        self.assertTrue(os.path.isabs(BASE), "fixture path must be absolute")
        self.assertTrue(BASE.startswith(home + os.sep),
                        "precondition: fixture must live under $HOME "
                        "(got %r, home %r)" % (BASE, home))
        self.assertTrue(username, "cannot derive a username from $HOME")

        doc = build_html(build_report(BASE, profile="xrechnung"))
        # No absolute input-file path, no $HOME prefix, no username.
        self.assertNotIn(BASE, doc,
                         "absolute input path leaked into the HTML")
        self.assertNotIn(os.path.dirname(BASE), doc,
                         "input directory path leaked into the HTML")
        self.assertNotIn(home, doc, "$HOME leaked into the HTML")
        self.assertNotIn(username, doc, "username leaked into the HTML")
        # No wall-clock timestamp: today's ISO date must not appear (the
        # document is rebuilt at test time, so any embedded 'now' would).
        import datetime
        self.assertNotIn(datetime.date.today().isoformat(), doc,
                         "wall-clock date leaked into the HTML")
        # The basename IS still shown (utility kept: which file was checked).
        self.assertIn(os.path.basename(BASE), doc)

        # Relative-path invocation (bare filename, cwd = the fixture's own
        # directory) vs absolute-path invocation must be BYTE-IDENTICAL —
        # the html surface follows sarif's path-invariance rule, not the
        # text/json verbatim-echo rule (REPORT-FORMATS.md "Path echo").
        env = dict(os.environ)
        env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
        rel = subprocess.run(
            [sys.executable, "-m", "einvoice.report", "--profile",
             "xrechnung", "--format", "html", os.path.basename(BASE)],
            cwd=os.path.dirname(BASE), env=env,
            capture_output=True, text=True, timeout=120)
        absr = _run(["--profile", "xrechnung", "--format", "html", BASE])
        self.assertEqual(rel.returncode, 0, rel.stdout + rel.stderr)
        self.assertEqual(absr.returncode, 0, absr.stdout + absr.stderr)
        self.assertEqual(
            rel.stdout, absr.stdout,
            "relative vs absolute invocation of the same fixture produced "
            "different HTML bytes (path leaked into the document)")


class HtmlSelfContainmentGuard(unittest.TestCase):
    """POSITIVE CONTROL for :func:`_assert_no_external_subresource`.

    The guard was tightened (not loosened) when rule-page links landed: it must
    still REJECT every real subresource fetch. A guard nobody tests is a guard
    that silently stops biting, so each hostile snippet below is fed through the
    guard and asserted to fail, and the one benign snippet is asserted to pass.
    """

    REJECTED = {
        "remote stylesheet link":
            '<link rel="stylesheet" href="https://cdn.example.com/a.css">',
        "remote script src":
            '<script src="https://cdn.example.com/a.js"></script>',
        "remote img src":
            '<img src="https://cdn.example.com/pixel.png" alt="">',
        "inline script element":
            "<script>alert(1)</script>",
        "css @import":
            '<style>@import url("https://cdn.example.com/a.css");</style>',
        "remote web font":
            "<style>@font-face { font-family: x; "
            "src: url(https://cdn.example.com/f.woff2); }</style>",
        "protocol-relative script src":
            '<script src="//cdn.example.com/a.js"></script>',
        "remote iframe":
            '<iframe src="https://cdn.example.com/frame.html"></iframe>',
        "remote object data via src":
            '<embed src="https://cdn.example.com/x.swf">',
        "relative rule link (would dangle from disk)":
            '<a href="http://verifyhash.com/einvoice/rules/BR-DE-2/">x</a>',
    }

    ACCEPTED = {
        "absolute https navigational anchor":
            '<a class="rule-id" '
            'href="https://verifyhash.com/einvoice/rules/BR-DE-2/">'
            "BR-DE-2</a>",
        "plain text mentioning a URL":
            "<p>See https://verifyhash.com/einvoice/rules/BR-DE-2/</p>",
    }

    def test_guard_rejects_every_remote_subresource(self):
        for label, snippet in sorted(self.REJECTED.items()):
            with self.subTest(snippet=label):
                doc = _synthetic_doc(snippet)
                with self.assertRaises(
                        AssertionError,
                        msg="guard ACCEPTED a document carrying %s — the "
                            "self-containment invariant has stopped biting"
                            % label):
                    _assert_no_external_subresource(self, doc)

    def test_guard_accepts_a_plain_navigational_link(self):
        # The tightening must not become a blanket ban: an <a href> is not a
        # subresource, and the whole point of this task is to emit one.
        for label, snippet in sorted(self.ACCEPTED.items()):
            with self.subTest(snippet=label):
                _assert_no_external_subresource(self, _synthetic_doc(snippet))

    def test_guard_still_requires_a_real_self_contained_document(self):
        # A bare fragment (no doctype, no inline <style>) is still rejected.
        with self.assertRaises(AssertionError):
            _assert_no_external_subresource(self, "<p>hello</p>")


class HtmlRuleLinks(unittest.TestCase):
    """(i) The HTML report — the one artifact that travels to a second person
    (a CI download, a mail attachment) — links each finding back to the
    authoritative rule page, from the SAME URL builder the SARIF helpUri and
    the text report use, and only where a page actually exists."""

    def test_linked_rule_id_href_equals_the_site_canonical_url(self):
        # The expected URL is DERIVED twice and cross-checked: from the site
        # builder that actually publishes the pages (gen_site._url_rule) and
        # from the shared runtime builder the emitters call
        # (report.rule_page_url). Nothing here is a hard-coded literal, so a
        # change to either origin fails this test instead of silently shipping
        # a 404 to every reader.
        import gen_site  # build script, importable from the repo root

        report = build_report(BROKEN, profile="xrechnung")
        out = build_html(report)
        _assert_no_external_subresource(self, out)

        catalog = load_catalog()
        fired = {v["rule"] for v in report["violations"]}
        self.assertIn("BR-DE-2", fired,
                      "fixture drift: %s no longer fires BR-DE-2" % BROKEN)

        linked = 0
        for rule_id in sorted(fired):
            expected = gen_site._url_rule(rule_id)
            self.assertEqual(
                expected, rule_page_url(rule_id),
                "the runtime rule-page URL builder has drifted from the "
                "URL gen_site.py actually publishes for %s" % rule_id)
            self.assertTrue(expected.startswith("https://"),
                            "rule links must be absolute: %r" % expected)
            if rule_id in catalog:
                self.assertIn(
                    '<a class="rule-id" href="%s">%s</a>'
                    % (_h(expected), _h(rule_id)), out,
                    "catalogued rule %s is not linked in the HTML report"
                    % rule_id)
                linked += 1
            else:
                self.assertNotIn(expected, out,
                                 "%s has no catalog entry (so no published "
                                 "page) but the report linked to it anyway"
                                 % rule_id)
        self.assertGreaterEqual(
            linked, 1, "no catalogued rule fired — the assertion is vacuous")

    def test_html_link_matches_the_sarif_helpuri_for_the_same_run(self):
        # One run, two formats: whatever the SARIF tells a scanner, the HTML
        # tells the human. They cannot disagree.
        from einvoice.report import build_sarif

        report = build_report(BROKEN, profile="xrechnung")
        out = build_html(report)
        descriptors = build_sarif(report)["runs"][0]["tool"]["driver"]["rules"]
        checked = 0
        for descriptor in descriptors:
            uri = descriptor.get("helpUri")
            if uri is None:
                self.assertNotIn('href="%s' % _h(
                    rule_page_url(descriptor["id"])), out)
                continue
            self.assertIn('<a class="rule-id" href="%s">%s</a>'
                          % (_h(uri), _h(descriptor["id"])), out,
                          "SARIF deep-links %s but the HTML does not"
                          % descriptor["id"])
            checked += 1
        self.assertGreaterEqual(checked, 1, "no helpUri in the SARIF run")

    def test_uncatalogued_rule_id_renders_unlinked(self):
        # A synthetic id has no catalog entry, therefore no published page,
        # therefore no link — the same gate the SARIF descriptor path uses.
        synthetic = "BR-DE-NOT-A-REAL-RULE-99"
        self.assertNotIn(synthetic, load_catalog(),
                         "precondition: the id must be absent from the "
                         "catalog for this test to mean anything")
        report = {
            "source": "/tmp/x.xml",
            "profile": "xrechnung",
            "valid": False,
            "fatal_count": 1,
            "warning_count": 0,
            "violation_count": 1,
            "violations": [{
                "rule": synthetic,
                "severity": "fatal",
                "message": "synthetic finding",
                "field": None, "title": None, "fix_hint": None,
                "terms": [], "location": None,
            }],
        }
        out = build_html(report)
        _assert_no_external_subresource(self, out)
        self.assertIn('<span class="rule-id">%s</span>' % synthetic, out)
        self.assertNotIn("href=", out,
                         "an uncatalogued rule id must not be linked (the "
                         "page does not exist)")

    def test_not_well_formed_error_row_is_unchanged_and_unlinked(self):
        with tempfile.TemporaryDirectory() as tmp:
            broken = os.path.join(tmp, "broken.xml")
            with open(broken, "w", encoding="utf-8") as fh:
                fh.write("<Invoice><unclosed>")
            proc = _run(["--profile", "xrechnung", "--format", "html", broken])
        self.assertEqual(proc.returncode, 3, proc.stdout + proc.stderr)
        out = proc.stdout
        _assert_no_external_subresource(self, out)
        # Exactly the markup the error path has always emitted, and no link:
        # "not-well-formed" is an error code, not a rule with a page.
        self.assertEqual(out.count('class="error-row"'), 1, out)
        self.assertIn('<span class="code">not-well-formed</span>', out)
        self.assertNotIn("href=", out,
                         "the not-well-formed error row must carry no link")
        self.assertNotIn("--explain", out,
                         "the parse-error document has no rule to explain")

    def test_missing_catalog_degrades_to_a_link_free_document(self):
        # A wheel shipped WITHOUT the packaged catalog (that really happened in
        # 0.4.2) must still render the whole report — just with no links. Not a
        # traceback: the HTML path reads the catalog through the DEFENSIVE
        # accessor, whose degrade-to-{} discipline is exercised for real here
        # by making the underlying loader raise.
        from einvoice import remediation

        report = build_report(BROKEN, profile="xrechnung")
        saved_loader = remediation.load_catalog
        saved_cache = remediation._CATALOG_CACHE
        try:
            remediation._CATALOG_CACHE = None

            def _boom(*a, **kw):
                raise OSError("catalog missing from this installation")

            remediation.load_catalog = _boom
            out = build_html(report)          # must not raise
        finally:
            remediation.load_catalog = saved_loader
            remediation._CATALOG_CACHE = saved_cache

        _assert_no_external_subresource(self, out)
        self.assertNotIn("href=", out,
                         "a catalog-less installation must emit the "
                         "link-free document, not links to pages it cannot "
                         "vouch for")
        # ...and the findings themselves are still all there.
        for v in report["violations"]:
            self.assertIn(_h(v["rule"]), out)
        # The cache really was restored for the rest of the suite.
        self.assertIn("BR-DE-2", load_catalog())

    def test_offline_escape_hatch_uses_the_cli_true_form(self):
        out = build_html(build_report(BROKEN, profile="xrechnung"))
        self.assertIn("einvoice --explain &lt;RULE-ID&gt;", out,
                      "the report must name the offline escape hatch")
        self.assertNotIn("einvoice explain", out,
                         "there is no `explain` SUBCOMMAND — that spelling "
                         "errors out")

    def test_the_named_escape_hatch_actually_works(self):
        # Assert the CLI form from the REAL CLI rather than from memory: the
        # global option works, the subcommand spelling does not.
        ok = subprocess.run(
            [sys.executable, "-m", "einvoice", "--explain", "BR-DE-2"],
            cwd=HERE, capture_output=True, text=True, timeout=120)
        self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
        self.assertIn("BR-DE-2", ok.stdout)
        bad = subprocess.run(
            [sys.executable, "-m", "einvoice", "explain", "BR-DE-2"],
            cwd=HERE, capture_output=True, text=True, timeout=120)
        self.assertNotEqual(
            bad.returncode, 0,
            "an `explain` subcommand now exists — the report's wording needs "
            "revisiting")

    def test_links_survive_the_real_cli_path(self):
        rel = os.path.relpath(BROKEN, HERE)
        proc = _run(["--profile", "xrechnung", "--format", "html", rel])
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        _assert_no_external_subresource(self, proc.stdout)
        self.assertIn('href="%s"' % rule_page_url("BR-DE-2"), proc.stdout)

    def test_links_do_not_break_path_invariance(self):
        # RPT.8 again, on the linking build: a link is derived from the rule
        # id alone, so it cannot vary with the caller's cwd or path spelling.
        env = dict(os.environ)
        env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
        absr = subprocess.run(
            [sys.executable, "-m", "einvoice.report", "--profile",
             "xrechnung", "--format", "html", BROKEN],
            cwd=tempfile.gettempdir(), env=env,
            capture_output=True, text=True, timeout=120)
        relr = _run(["--profile", "xrechnung", "--format", "html",
                     os.path.relpath(BROKEN, HERE)])
        self.assertEqual(absr.returncode, 1, absr.stdout + absr.stderr)
        self.assertEqual(relr.returncode, 1, relr.stdout + relr.stderr)
        self.assertEqual(absr.stdout, relr.stdout,
                         "absolute vs relative invocation produced different "
                         "HTML bytes")
        self.assertIn("robots", absr.stdout)


class HtmlBaselineRejected(unittest.TestCase):
    def test_baseline_plus_html_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            baseline = os.path.join(tmp, "baseline.json")
            with open(baseline, "w", encoding="utf-8") as fh:
                fh.write('{"schema": "einvoice-conformance-report/v1", '
                         '"violations": []}')
            proc = _run(["--profile", "xrechnung", "--format", "html",
                         "--baseline", baseline, BASE])
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("baseline", proc.stderr.lower(), proc.stderr)
        self.assertIn("html", proc.stderr.lower(), proc.stderr)


class UnknownFormatMentionsHtml(unittest.TestCase):
    def test_usage_lists_html(self):
        proc = _run(["--format", "bogus", BASE])
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("html", proc.stderr.lower(), proc.stderr)


if __name__ == "__main__":
    unittest.main()

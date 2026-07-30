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
  (h) PATH INVARIANCE (RPT.8), as narrowed by T-VHRPTH.3: built from a
      POSITIONLESS fixture referenced via an ABSOLUTE path under $HOME, the
      document contains no $HOME prefix, no absolute input-file path, no
      username, and no wall-clock timestamp — and a relative-path invocation
      of the same file (cwd = the fixture's dir) yields byte-identical HTML.
      The ONE place a caller's path spelling may now appear is a finding's
      POSITION (see (j)); the document CHROME — meta line, links, style,
      footer — stays path-invariant regardless, and two documents that differ
      only in the echoed position path are byte-identical once that one string
      is normalised. This is the same trade sarif made when it gained
      `region.startLine` (REPORT-FORMATS.md "Path echo").
  (j) POSITION (T-VHRPTH.3): the artifact that travels to a second person
      carries the position the engine already computed, in BOTH kinds and in
      the SAME words the text report and the JUnit body use — `at file:line`
      for an attributable finding, the distinctly worded
      `(insertion point file:line)` for an absence (so it can never be read as
      "the error is on line N") — and a finding the engine could not place
      carries NO position markup at all, no `:0`, no invented line.
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

import inspect
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
#: The shipped worked example: 3 findings at 2 severities (fatal + information)
#: — the fixture that exposed the FAIL banner's missing bucket.
BROKEN = os.path.join(HERE, "examples", "01-missing-fields", "broken.xml")
# The committed multi-finding example the docs and CI recipes use: three
# findings, all absence-class, all catalogued.
BROKEN = os.path.join(HERE, "examples", "01-missing-fields", "broken.xml")
# The ATTRIBUTABLE counterpart (T-VHRPTH.3): a CreditNote whose BT-3 document
# type code is present but not a listed UNTDID 1001 code, so BR-CL-01 names a
# real element the parser stamped with a real line — `source_line` 28, and no
# insertion point anywhere in the report. BROKEN is the mirror image: an
# absence with `insertion_point_line` 28 and no `source_line`, which makes the
# pair a clean single-kind test of each form.
TYPECODE = os.path.join(HERE, "fixtures",
                        "creditnote-invalid-typecode_ubl.xml")

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
    across regenerations, with no timestamp, no $HOME and no username in the
    bytes for a report whose findings carry no position.

    T-VHRPTH.3 narrowed the second half of that claim ON PURPOSE and this class
    states the narrowed version precisely rather than quietly dropping it. A
    finding's POSITION echoes the caller's path spelling verbatim — the same
    string text/json/sarif emit — because ``line 28`` with no file beside it is
    not an address the recipient of the artifact can act on. So: the ``source:``
    meta line is still basename-only, the document CHROME is still invariant,
    and two runs that differ only in the echoed position path are byte-identical
    once that one string is normalised. A POSITIONLESS report is unchanged,
    invariant, byte-for-byte — which is what
    :meth:`test_path_invariance_no_home_username_timestamp` measures (it asserts
    its fixture really is positionless first, so it can never pass by accident).
    """

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

        # SCOPE, made explicit (T-VHRPTH.3): this fixture's findings carry NO
        # position, so "no path anywhere in the document" is the whole truth
        # for it. Assert that precondition instead of relying on it silently —
        # if the engine ever starts placing this fixture's finding, this test
        # must fail loudly and be re-stated, not pass by luck.
        rpt = build_report(BASE, profile="xrechnung")
        for v in rpt.get("violations", []):
            self.assertIsNone(v.get("source_line"), v.get("rule"))
            self.assertIsNone(v.get("insertion_point_line"), v.get("rule"))

        doc = build_html(rpt)
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
        # RPT.8 again, on the linking build, and now on the POSITIONED build
        # too. A link is derived from the rule id alone, so it cannot vary with
        # the caller's cwd or path spelling; a POSITION echoes the caller's
        # spelling verbatim (T-VHRPTH.3) and is the ONLY thing in the document
        # allowed to. Both halves are asserted, so neither can drift: the whole
        # document must be byte-identical between an absolute-path run from a
        # foreign cwd and a relative-path run once — and only once — the echoed
        # position path is normalised.
        env = dict(os.environ)
        env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
        absr = subprocess.run(
            [sys.executable, "-m", "einvoice.report", "--profile",
             "xrechnung", "--format", "html", BROKEN],
            cwd=tempfile.gettempdir(), env=env,
            capture_output=True, text=True, timeout=120)
        rel_spelling = os.path.relpath(BROKEN, HERE)
        relr = _run(["--profile", "xrechnung", "--format", "html",
                     rel_spelling])
        self.assertEqual(absr.returncode, 1, absr.stdout + absr.stderr)
        self.assertEqual(relr.returncode, 1, relr.stdout + relr.stderr)

        # Every hyperlink is identical, in the same order: rule-page hrefs come
        # from the rule id, never from the input path.
        self.assertEqual(re.findall(r'href="([^"]*)"', absr.stdout),
                         re.findall(r'href="([^"]*)"', relr.stdout),
                         "a hyperlink varied with the caller's cwd / path "
                         "spelling — links must derive from the rule id alone")
        self.assertIn('href="%s"' % rule_page_url("BR-DE-2"), absr.stdout)

        # The absolute run differs ONLY in the echoed position string. Rewrite
        # that one substring and the documents must be byte-identical — proving
        # the path did not leak into the meta line, the style, the links or the
        # footer, and that nothing ELSE varies with cwd either.
        self.assertIn("(insertion point %s:" % BROKEN, absr.stdout,
                      "the absolute run should echo the absolute spelling in "
                      "its position — the surface under test is missing")
        self.assertEqual(absr.stdout.replace(BROKEN, rel_spelling),
                         relr.stdout,
                         "absolute vs relative invocation produced different "
                         "HTML bytes beyond the echoed position path")

        # The meta line is STILL basename-only in the absolute run: the
        # directory part of an absolute input never appears outside a position.
        self.assertIn("source: %s " % os.path.basename(BROKEN), absr.stdout)
        self.assertEqual(
            1, absr.stdout.count(os.path.dirname(BROKEN)),
            "the input's directory path appears somewhere other than the one "
            "position echo")
        self.assertIn("robots", absr.stdout)


class HtmlFindingPosition(unittest.TestCase):
    """(j) T-VHRPTH.3 — the HTML report carries the position the engine already
    computed, in BOTH kinds, worded exactly as the other two HUMAN surfaces
    word it.

    WHY THIS SUITE EXISTS. The HTML document is the only output of ours that
    TRAVELS: it is downloaded as a CI artifact, attached to an invoice dispute,
    forwarded to an accountant. Before this task its recipient got strictly
    less than the CLI user who produced it — the same finding, minus the one
    datum that turns it into a fix. Measured then on
    `examples/01-missing-fields/broken.xml`: the computed position 28 appeared
    once each in text, json and junit, and ZERO times in html.

    THE HONESTY RULE IS THE POINT OF THE TWO-FORM SPLIT, so it is asserted as
    such and not merely as "a number appears". An insertion point is where the
    missing thing GOES; nothing on that line is wrong. Rendering it as
    `at broken.xml:28` would tell every reader — and every editor that jumps
    there — that line 28 is the defect, when line 28 is a perfectly valid
    `<cac:Party>` open tag.
    """

    def _doc(self, path):
        return build_html(build_report(path, profile="xrechnung"))

    def _positions(self, doc):
        """Every position span the document emitted, inner text only."""
        return re.findall(r'<span class="pos">([^<]*)</span>', doc)

    def test_attributable_finding_renders_the_at_form(self):
        rel = os.path.relpath(TYPECODE, HERE)
        rpt = build_report(rel, profile="xrechnung")
        rec = {v["rule"]: v for v in rpt["violations"]}["BR-CL-01"]
        # Precondition, measured not assumed: this really is the attributable
        # kind — a source_line and NO insertion point.
        self.assertEqual(rec.get("source_line"), 28, rec)
        self.assertIsNone(rec.get("insertion_point_line"), rec)

        doc = build_html(rpt)
        self.assertIn("at %s:28" % rel, doc,
                      "the attributable finding lost its position in HTML")
        # The attributable form must NOT borrow the absence wording.
        self.assertNotIn("insertion", doc.lower(),
                         "an error site was labelled as an insertion point")
        # Exactly one finding of the three carries a position: the other two
        # have none, and none was invented for them.
        self.assertEqual([" at %s:28" % rel], self._positions(doc), doc)
        _assert_no_external_subresource(self, doc)

    def test_absence_finding_renders_the_insertion_point_form(self):
        rel = os.path.relpath(BROKEN, HERE)
        rpt = build_report(rel, profile="xrechnung")
        rec = {v["rule"]: v for v in rpt["violations"]}["BR-DE-2"]
        self.assertEqual(rec.get("insertion_point_line"), 28, rec)
        self.assertIsNone(rec.get("source_line"), rec)

        doc = build_html(rpt)
        self.assertIn("(insertion point %s:28)" % rel, doc,
                      "the absence finding lost its insertion point in HTML")
        # The literal word survives, and the error-site wording never appears
        # for this report: no reader can take line 28 for the defect.
        self.assertIn("insertion", doc.lower())
        self.assertNotIn("at %s:28" % rel, doc,
                         "an insertion point was rendered in the 'at "
                         "file:line' shape — it reads as 'the error is here'")
        self.assertEqual([" (insertion point %s:28)" % rel],
                         self._positions(doc), doc)
        _assert_no_external_subresource(self, doc)

    def test_both_forms_are_byte_identical_to_the_text_surface(self):
        # The whole reason build_html calls report._position_suffix /
        # _insertion_point_suffix instead of formatting its own string: the
        # three human surfaces cannot phrase a position differently. Assert the
        # bytes, not the intent — the span's inner text (after unescaping) must
        # equal the exact fragment the TEXT report appends for the same record.
        from einvoice.report import (build_text, _position_suffix,
                                     _insertion_point_suffix)
        for path, rule in ((TYPECODE, "BR-CL-01"), (BROKEN, "BR-DE-2")):
            rel = os.path.relpath(path, HERE)
            rpt = build_report(rel, profile="xrechnung")
            rec = {v["rule"]: v for v in rpt["violations"]}[rule]
            expected = (_position_suffix(rel, rec.get("source_line"))
                        or _insertion_point_suffix(
                            rel, rec.get("insertion_point_line")))
            self.assertTrue(expected, rec)
            self.assertIn(expected, build_text(rpt), rule)
            self.assertEqual([expected], self._positions(build_html(rpt)),
                             "%s: HTML phrases the position differently from "
                             "the text report" % rule)

    def test_a_finding_with_no_position_renders_no_position_markup(self):
        # BASE's single finding is document-level: the engine can attribute it
        # to no element and anchor it nowhere, so the HTML must be exactly what
        # it always was — no span, no ":0", no invented line, no empty
        # parentheses left behind.
        rpt = build_report(BASE, profile="xrechnung")
        self.assertTrue(rpt["violations"], "fixture drift: BASE now passes")
        for v in rpt["violations"]:
            self.assertIsNone(v.get("source_line"), v.get("rule"))
            self.assertIsNone(v.get("insertion_point_line"), v.get("rule"))
        doc = build_html(rpt)
        self.assertEqual([], self._positions(doc))
        self.assertNotIn('class="pos"', doc)
        self.assertNotIn("insertion", doc.lower())
        self.assertNotIn(":0", doc)

    def test_position_adds_the_span_and_nothing_else(self):
        # "A finding with no usable position renders exactly as it did before"
        # stated as a measurable invariant rather than a promise: strip the
        # position fields out of a real report and the document must come back
        # byte-identical to the positioned one MINUS the span — no reflowed
        # markup, no stray parentheses, no changed dl rows, no changed banner.
        for path in (TYPECODE, BROKEN):
            rel = os.path.relpath(path, HERE)
            rpt = build_report(rel, profile="xrechnung")
            stripped = dict(rpt)
            stripped["violations"] = [
                {k: val for k, val in v.items()
                 if k not in ("source_line", "insertion_point_line")}
                for v in rpt["violations"]]
            positioned = build_html(rpt)
            bare = build_html(stripped)
            self.assertNotEqual(positioned, bare, rel)
            self.assertEqual(
                re.sub(r'<span class="pos">[^<]*</span>', "", positioned),
                bare,
                "%s: rendering a position changed markup OTHER than the "
                "position span itself" % rel)

    def test_unusable_position_values_never_become_a_line(self):
        # The no-placeholder rule, driven through build_html on hand-built
        # report dicts (a third-party or hand-edited report can carry anything).
        # True is an int in Python and 0/-1/"28" are the classic ways a bad
        # position sneaks in; every one of them must degrade to "no position",
        # never to ":1", ":0" or a rendered string.
        for bad in (True, False, 0, -1, "28", 28.0, None):
            for key in ("source_line", "insertion_point_line"):
                rpt = {"schema": "einvoice-conformance-report/v1",
                       "source": "x.xml", "profile": "xrechnung",
                       "valid": False, "fatal_count": 1, "warning_count": 0,
                       "violation_count": 1,
                       "violations": [{"rule": "BR-1", "severity": "fatal",
                                       "message": "m", key: bad}]}
                doc = build_html(rpt)
                self.assertEqual([], self._positions(doc),
                                 "%s=%r produced a position" % (key, bad))
                self.assertNotIn("x.xml:", doc,
                                 "%s=%r produced a position" % (key, bad))

    def test_position_survives_the_real_cli_path(self):
        # End to end through the CLI the docs tell a stranger to run, so the
        # claim is about the shipped binary and not only about the projection.
        for path, expect in (
                (BROKEN, "(insertion point %s:28)"),
                (TYPECODE, "at %s:28")):
            rel = os.path.relpath(path, HERE)
            proc = _run(["--profile", "xrechnung", "--format", "html", rel])
            self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
            self.assertIn(expect % rel, proc.stdout)
            self.assertIn('name="robots" content="noindex"', proc.stdout)
            _assert_no_external_subresource(self, proc.stdout)

    def test_a_path_with_markup_characters_is_escaped(self):
        # The echoed path is argv — untrusted text. A filename containing
        # markup must not reach the document raw.
        with tempfile.TemporaryDirectory() as tmp:
            evil = os.path.join(tmp, 'a<b&"c.xml')
            with open(BROKEN, encoding="utf-8") as fh:
                payload = fh.read()
            with open(evil, "w", encoding="utf-8") as fh:
                fh.write(payload)
            doc = build_html(build_report(evil, profile="xrechnung"))
        self.assertIn("insertion point", doc)
        self.assertNotIn('a<b&"c.xml', doc, "raw path markup reached the HTML")
        self.assertIn("a&lt;b&amp;&quot;c.xml", doc)


#: The FAIL banner's counts span, e.g. ``3 findings &middot; 2 fatal &middot;
#: 1 non-fatal``. Parsed structurally (numbers + labels) rather than matched as
#: a fixed string, so the assertions below survive a re-wording but NOT a
#: recurrence of the arithmetic hole.
_BANNER_RE = re.compile(
    r'<div class="banner (pass|fail)">.*?'
    r'<span class="counts">(.*?)</span></div>', re.S)
_COUNT_RE = re.compile(r"^\s*(\d+)\s+(\S.*?)\s*$")


def _parse_banner(doc):
    """Return ``(verdict, total, [(count, label), ...])`` for the banner.

    ``total`` is the leading ``N finding(s)`` number; the list is every
    remaining ``N <label>`` segment (the NAMED severity buckets).
    """
    m = _BANNER_RE.search(doc)
    if m is None:
        raise AssertionError("no banner with a counts span in the document")
    verdict, counts = m.group(1), m.group(2)
    segments = [s for s in counts.split("&middot;")]
    parsed = []
    for seg in segments:
        cm = _COUNT_RE.match(seg)
        if cm is not None:
            parsed.append((int(cm.group(1)), cm.group(2)))
    if not parsed:
        raise AssertionError("banner counts carry no numbers: %r" % counts)
    total, total_label = parsed[0]
    if not total_label.startswith("finding"):
        raise AssertionError(
            "expected the banner to lead with the finding TOTAL, got %r"
            % counts)
    return verdict, total, parsed[1:]


class HtmlBannerCountsAddUp(unittest.TestCase):
    """The FAIL banner must account for EVERY finding it counts.

    Regression for the defect where ``warning_count`` (severity == 'warning'
    ONLY) was the sole named non-fatal bucket: a finding carried at severity
    ``information`` — BR-DE-TMP-32 fires exactly that way on the shipped
    ``examples/01-missing-fields/broken.xml`` — landed in the total and in
    NEITHER named bucket, so the one artifact that travels to a second person
    read ``3 findings &middot; 2 fatal &middot; 0 warning``. 2 + 0 != 3, and the
    recipient of a forwarded report could not account for the third finding.

    These assert the ARITHMETIC, not the wording: the named buckets must sum to
    the stated total. A future fourth severity therefore cannot silently
    reopen the hole.
    """

    def _assert_banner_adds_up(self, doc, expected_total):
        verdict, total, buckets = _parse_banner(doc)
        self.assertEqual(verdict, "fail", doc[:400])
        self.assertEqual(total, expected_total,
                         "banner total disagrees with the report")
        self.assertTrue(buckets, "banner names no severity buckets at all")
        named = sum(c for c, _ in buckets)
        self.assertEqual(
            named, total,
            "banner buckets %r sum to %d but the banner states %d finding(s) "
            "— every counted finding must land in a NAMED bucket"
            % (buckets, named, total))

    def _three_severity_report(self):
        """A report dict carrying fatal + warning + information findings.

        Extended from a real :func:`build_report` result so the record shape is
        the genuine one; only the severity mix is synthesised, because no
        shipped fixture fires all three at once (the documented example fires
        fatal + information).
        """
        rep = build_report(BROKEN, profile="xrechnung")
        template = dict(rep["violations"][0])
        records = []
        for rule, severity in (("BR-DE-SYN-FATAL", "fatal"),
                               ("BR-DE-SYN-WARN", "warning"),
                               ("BR-DE-SYN-INFO", "information")):
            rec = dict(template)
            rec["rule"] = rule
            rec["severity"] = severity
            records.append(rec)
        rep = dict(rep)
        rep["violations"] = records
        rep["violation_count"] = len(records)
        rep["fatal_count"] = 1
        rep["warning_count"] = 1
        rep["valid"] = False
        return rep

    def test_three_severity_report_banner_buckets_sum_to_total(self):
        rep = self._three_severity_report()
        doc = build_html(rep)
        self._assert_banner_adds_up(doc, 3)
        _, _, buckets = _parse_banner(doc)
        self.assertIn(1, [c for c, _ in buckets],
                      "the single fatal must be named: %r" % (buckets,))

    def test_information_only_extra_severity_is_named(self):
        """The shipped fixture's exact severity mix (fatal + information)."""
        rep = build_report(BROKEN, profile="xrechnung")
        severities = [v.get("severity") for v in rep["violations"]]
        self.assertIn(
            "information", severities,
            "fixture drift: %s no longer fires an `information` finding, so "
            "this regression is no longer exercised end to end" % BROKEN)
        self._assert_banner_adds_up(build_html(rep), len(severities))

    def test_emitted_document_names_the_third_finding(self):
        """End to end through the CLI, not just the library projection."""
        proc = _run(["--profile", "xrechnung", "--format", "html", BROKEN])
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self._assert_banner_adds_up(proc.stdout, 3)

    def test_unknown_future_severity_still_lands_in_a_named_bucket(self):
        """A severity nobody has invented yet must not fall out of the sum."""
        rep = self._three_severity_report()
        rep["violations"][2]["severity"] = "notice-from-the-future"
        self._assert_banner_adds_up(build_html(rep), 3)

    def test_pass_banner_wording_unchanged(self):
        """The PASS branch was already self-consistent — pin it as-is."""
        rep = build_report(BROKEN, profile="xrechnung")
        rep = dict(rep)
        rep["valid"] = True
        rep["fatal_count"] = 0
        doc = build_html(rep)
        self.assertIn("banner pass", doc)
        self.assertIn("3 non-fatal findings (warnings do not invalidate)", doc)

    def test_build_html_takes_exactly_one_argument(self):
        """The browser validator calls ``build_html(_rep)`` — one argument.

        ``www/validate/index.html`` (and ``gen_site.py``, which emits it) runs
        ``_einvoice_report.build_html(_rep)`` inside Pyodide with exactly one
        positional argument, and the validator page is an ENGLISH page. Since
        T-VHRPTH.4 the emitter also accepts ``lang`` so ``--lang de --format
        html`` can produce the German document the German mandate's users need,
        so this pins the invariant the browser actually depends on rather than
        the parameter count:

          * the first parameter is still ``report``;
          * EVERY parameter after it is keyword-defaulted, so a one-argument
            call is a valid binding and can never become a TypeError;
          * that one-argument call really returns the ENGLISH document.
        """
        sig = inspect.signature(build_html)
        params = list(sig.parameters.values())
        self.assertEqual(params[0].name, "report")
        for p in params[1:]:
            self.assertIsNot(
                p.default, inspect.Parameter.empty,
                "build_html parameter %r has no default, so the browser's "
                "one-argument build_html(_rep) call would raise TypeError"
                % p.name)
            self.assertIn(p.kind, (inspect.Parameter.POSITIONAL_OR_KEYWORD,
                                   inspect.Parameter.KEYWORD_ONLY), p.name)
        # The binding really is valid with one argument...
        sig.bind(build_report(BASE, profile="xrechnung"))
        # ...and what it produces is the English document the page ships.
        doc = build_html(build_report(BASE, profile="xrechnung"))
        self.assertIn('<html lang="en">', doc)
        self.assertIn("EN 16931 / XRechnung conformance report", doc)


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

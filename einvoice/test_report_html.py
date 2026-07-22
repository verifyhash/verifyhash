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
  (c) SELF-CONTAINMENT: the emitted HTML carries NO http(s) asset references
      (no src=/href= remote URL, no <script src>).
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
"""

import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.report import build_report, build_html, _h  # noqa: E402

# Reuse the exact fixture + bad-invoice construction the other fast gates use.
BASE = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test",
                    "business-cases", "standard", "01.01a-INVOICE_ubl.xml")

# Match src=/href= pointing at a remote http(s) URL, and any <script src=...>.
_REMOTE_ASSET_RE = re.compile(r"""(?:src|href)\s*=\s*["']https?://""", re.I)
_SCRIPT_SRC_RE = re.compile(r"""<script[^>]*\bsrc\s*=""", re.I)


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


def _assert_self_contained(tc, htmltext):
    tc.assertRegex(htmltext.lower(), r"<!doctype html")
    tc.assertIn("<style>", htmltext.lower())
    tc.assertFalse(_REMOTE_ASSET_RE.search(htmltext),
                   "remote asset URL leaked into the HTML")
    tc.assertFalse(_SCRIPT_SRC_RE.search(htmltext),
                   "<script src=...> leaked into the HTML")
    # No <img> at all (spec forbids external images; we emit none).
    tc.assertNotIn("<img", htmltext.lower())


class HtmlGoodInvoice(unittest.TestCase):
    def test_good_invoice_self_contained_pass_exit_zero(self):
        proc = _run(["--profile", "xrechnung", "--format", "html", BASE])
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        out = proc.stdout
        _assert_self_contained(self, out)
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
        _assert_self_contained(self, out)
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
        _assert_self_contained(self, out)
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
        _assert_self_contained(self, out)
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
        _assert_self_contained(self, out)
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
        _assert_self_contained(self, doc1)

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

#!/usr/bin/env python3
"""test_report_github.py — prove the GitHub Actions workflow-command format.

Fast, stdlib-only, saxonche-free, offline. Exercises the new
`python3 -m einvoice.report --format github` path (report.build_github) against
the committed examples/01-missing-fields fixtures — no new corpus, no new rule
logic, no network. The GitHub "workflow commands" surface is a LINE protocol:
each violation is one `::error`/`::warning file=...,title=...::<message>` line
that a GitHub Actions runner turns into an inline annotation, with zero SARIF
upload and zero GitHub Advanced Security setup.

Asserted (each maps to a task acceptance criterion):
  (1) --format github on broken.xml -> nonzero exit; every emitted command line
      starts with `::error `/`::warning `, carries `file=`, and `title=` carries
      a rule id; the fatal findings are `::error`.
  (2) --format github on fixed.xml -> exit 0 and NOT a single `::error` line.
  (3) escaping per GitHub workflow-command rules: % -> %25, LF -> %0A,
      CR -> %0D (data), plus , -> %2C and : -> %3A (properties). Asserted on the
      escape helpers directly AND end-to-end via a synthetic record whose
      message/path force escapes.
  (4) source_line, when present on a violation, becomes a `line=<n>` token; when
      absent, NO `line=` token is emitted (never `line=0`). Both branches hit on
      build_github directly with synthetic records.
  (5) the committed examples/ci-github/github-annotations.txt equals a fresh
      build_github run byte-for-byte (drift guard), and the ci example files are
      present.
  (6) a not-well-formed input yields exactly one `::error` line; build_github is
      a pure projection (does not mutate the report / change rule firing).
"""

import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.report import (  # noqa: E402
    build_report, build_github,
    _github_level, _github_escape_data, _github_escape_property,
)

EX = os.path.join(HERE, "examples", "01-missing-fields")
BROKEN_REL = "examples/01-missing-fields/broken.xml"
FIXED_REL = "examples/01-missing-fields/fixed.xml"
BROKEN = os.path.join(EX, "broken.xml")
FIXED = os.path.join(EX, "fixed.xml")
CI_DIR = os.path.join(HERE, "examples", "ci-github")
COMMITTED = os.path.join(CI_DIR, "github-annotations.txt")
WORKFLOW = os.path.join(CI_DIR, "invoice-annotations.yml")


def _run(args):
    """Run the report CLI from HERE so relative paths resolve as documented."""
    return subprocess.run(
        [sys.executable, "-m", "einvoice.report"] + args,
        cwd=HERE, capture_output=True, text=True, timeout=120)


def _command_lines(out):
    """The workflow-command lines (`::...`), skipping `#` comments / blanks."""
    return [ln for ln in out.splitlines() if ln.startswith("::")]


class CliBrokenFixture(unittest.TestCase):
    def test_broken_emits_error_annotations_nonzero_exit(self):
        proc = _run(["--format", "github", BROKEN_REL])
        self.assertNotEqual(proc.returncode, 0, proc.stderr)
        cmds = _command_lines(proc.stdout)
        self.assertTrue(cmds, "no workflow-command lines emitted")
        # At least one ::error (broken.xml has fatal violations).
        self.assertTrue(any(ln.startswith("::error ") for ln in cmds),
                        "no ::error line on the broken fixture")
        for ln in cmds:
            self.assertTrue(
                ln.startswith(("::error ", "::warning ")),
                "command line is neither ::error nor ::warning: %r" % ln)
            # Everything up to the `::` message separator is the property list.
            head = ln.split("::", 2)[1]  # "error file=...,title=..."
            self.assertIn("file=", head, "missing file= in %r" % ln)
            self.assertIn("title=", head, "missing title= in %r" % ln)

    def test_title_carries_rule_id(self):
        report = build_report(BROKEN)
        # github surfaces EVERY severity (fatal/warning/information), so every
        # violation's rule id must appear as a title= property.
        out = build_github(report)
        for v in report["violations"]:
            rid = v.get("rule")
            if rid:
                self.assertIn("title=" + rid, out,
                              "rule id %r not carried as a title=" % rid)


class CliFixedFixture(unittest.TestCase):
    def test_fixed_exits_zero_no_error_line(self):
        proc = _run(["--format", "github", FIXED_REL])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("::error ", proc.stdout,
                         "conformant fixture emitted an ::error line")


class SeverityMapping(unittest.TestCase):
    def test_level_mapping(self):
        self.assertEqual(_github_level("fatal"), "error")
        self.assertEqual(_github_level("warning"), "warning")
        self.assertEqual(_github_level("information"), "warning")
        self.assertEqual(_github_level("weird-unknown"), "warning")


class Escaping(unittest.TestCase):
    def test_escape_data_helper(self):
        # % must be escaped FIRST so the introduced escape char is not
        # re-escaped: "100%\n" -> "100%25%0A", not "100%2525...".
        self.assertEqual(_github_escape_data("100%"), "100%25")
        self.assertEqual(_github_escape_data("a\nb"), "a%0Ab")
        self.assertEqual(_github_escape_data("a\rb"), "a%0Db")
        self.assertEqual(_github_escape_data("a\r\nb"), "a%0D%0Ab")
        self.assertEqual(_github_escape_data("x%0Ay"), "x%250Ay")  # no double
        # data escaping does NOT touch , or : (those are message-legal).
        self.assertEqual(_github_escape_data("a,b:c"), "a,b:c")

    def test_escape_property_helper(self):
        # properties additionally encode the , and : delimiters.
        self.assertEqual(_github_escape_property("a,b"), "a%2Cb")
        self.assertEqual(_github_escape_property("a:b"), "a%3Ab")
        self.assertEqual(_github_escape_property("100%,x"), "100%25%2Cx")

    def test_end_to_end_message_and_property_escape(self):
        # A synthetic record whose message and path force escapes.
        report = {
            "source": "dir,with:comma/inv%1.xml",
            "violations": [{
                "rule": "BR-X",
                "severity": "fatal",
                "message": "value 50% > 40%\nsecond line",
            }],
        }
        out = build_github(report)
        line = _command_lines(out)[0]
        # message body: % -> %25 (first), LF -> %0A; commas in the message body
        # are legal and left as-is.
        self.assertIn("value 50%25 > 40%25%0Asecond line", out)
        self.assertNotIn("\n", line)  # the LF is encoded, line stays single
        # file= property: comma/colon/percent encoded.
        self.assertIn("file=dir%2Cwith%3Acomma/inv%251.xml", line)


class SourceLineToken(unittest.TestCase):
    def test_source_line_present_emits_line_token(self):
        report = {
            "source": "inv.xml",
            "violations": [{"rule": "BR-Y", "severity": "fatal",
                            "message": "bad", "source_line": 42}],
        }
        line = _command_lines(build_github(report))[0]
        self.assertIn("line=42", line)

    def test_source_line_absent_omits_line_token(self):
        report = {
            "source": "inv.xml",
            "violations": [{"rule": "BR-Z", "severity": "fatal",
                            "message": "bad"}],  # no source_line
        }
        line = _command_lines(build_github(report))[0]
        self.assertNotIn("line=", line)
        self.assertNotIn("line=0", line)

    def test_broken_fixture_has_no_line_token(self):
        # The committed broken fixture carries no source positions, so the real
        # CLI output must not contain a line= token (and never line=0).
        out = _run(["--format", "github", BROKEN_REL]).stdout
        for ln in _command_lines(out):
            self.assertNotIn("line=", ln)


class NotWellFormed(unittest.TestCase):
    def test_parse_error_single_error_line(self):
        report = {"source": "x.xml", "error": "not-well-formed",
                  "message": "junk at line 1"}
        cmds = _command_lines(build_github(report))
        self.assertEqual(len(cmds), 1)
        self.assertTrue(cmds[0].startswith("::error "))
        self.assertIn("file=x.xml", cmds[0])
        self.assertIn("title=not-well-formed", cmds[0])


class Conformant(unittest.TestCase):
    def test_zero_violation_report_is_noop_comment(self):
        out = build_github({"source": "clean.xml", "violations": []})
        self.assertTrue(out.strip(), "conformant output is empty")
        self.assertNotIn("::error", out)
        self.assertNotIn("::warning", out)
        self.assertTrue(out.startswith("#"), "expected a # log-comment no-op")


class Purity(unittest.TestCase):
    def test_build_github_does_not_mutate_report(self):
        report = build_report(BROKEN)
        before_n = len(report["violations"])
        before_fatal = report["fatal_count"]
        build_github(report)
        self.assertEqual(len(report["violations"]), before_n)
        self.assertEqual(report["fatal_count"], before_fatal)


class CommittedArtifactDriftGuard(unittest.TestCase):
    def test_ci_files_present(self):
        self.assertTrue(os.path.isfile(COMMITTED), COMMITTED)
        self.assertTrue(os.path.isfile(WORKFLOW), WORKFLOW)

    def test_committed_output_matches_fresh_build(self):
        # Build via the CLI with the SAME repo-relative path the committed
        # artifact was generated from, so the `file=` path matches byte-for-byte
        # (an absolute path would be machine-specific).
        fresh = _run(["--format", "github", BROKEN_REL]).stdout
        with open(COMMITTED, encoding="utf-8") as fh:
            committed = fh.read()
        self.assertEqual(
            committed, fresh,
            "examples/ci-github/github-annotations.txt is stale; regenerate it "
            "from build_github(build_report(broken.xml))")


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""test_report_azure.py — prove the Azure DevOps Pipelines logging-command format.

Fast, stdlib-only, saxonche-free, offline. Exercises the new
`python3 -m einvoice.report --format azure` path (report.build_azure) against the
committed examples/01-missing-fields fixtures — no new corpus, no new rule logic,
no network. The Azure "logging commands" surface is a LINE protocol: each
violation is one `##vso[task.logissue type=error;sourcepath=...;code=...]<message>`
line that an Azure DevOps Pipelines agent turns into an inline build/PR issue,
with zero SARIF upload and zero extension install. It is the Azure counterpart of
the GitHub Actions workflow-command surface (test_report_github.py).

Asserted (each maps to a task acceptance criterion):
  (1) --format azure on broken.xml -> nonzero exit; at least one
      `##vso[task.logissue type=error` line; every emitted logissue line is
      well-formed and carries `sourcepath=` and `code=`; the fatal findings are
      `type=error`.
  (2) --format azure on fixed.xml -> exit 0 and NO `type=error` logissue line.
  (3) escaping per Azure logging-command rules: % -> %AZP25, LF -> %0A,
      CR -> %0D (data), plus ; -> %3B and ] -> %5D (properties). Asserted on the
      escape helpers directly AND end-to-end via a synthetic record whose
      message/path force escapes.
  (4) source_line, when present on a violation, becomes a `linenumber=<n>` token;
      when absent, NO `linenumber=` token is emitted (never `linenumber=0`). Both
      branches hit build_azure directly with synthetic records.
  (5) the committed examples/ci-azure/azure-logissues.txt equals a fresh
      build_azure run byte-for-byte (drift guard), and the ci example files are
      present.
  (6) a not-well-formed input yields exactly one `type=error` logissue line;
      build_azure is a pure projection (does not mutate the report).
"""

import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.report import (  # noqa: E402
    build_report, build_azure,
    _azure_level, _azure_escape_data, _azure_escape_property,
)

EX = os.path.join(HERE, "examples", "01-missing-fields")
BROKEN_REL = "examples/01-missing-fields/broken.xml"
FIXED_REL = "examples/01-missing-fields/fixed.xml"
BROKEN = os.path.join(EX, "broken.xml")
FIXED = os.path.join(EX, "fixed.xml")
CI_DIR = os.path.join(HERE, "examples", "ci-azure")
COMMITTED = os.path.join(CI_DIR, "azure-logissues.txt")
PIPELINE = os.path.join(CI_DIR, "azure-pipelines.yml")

LOGISSUE = "##vso[task.logissue "


def _run(args):
    """Run the report CLI from HERE so relative paths resolve as documented."""
    return subprocess.run(
        [sys.executable, "-m", "einvoice.report"] + args,
        cwd=HERE, capture_output=True, text=True, timeout=120)


def _command_lines(out):
    """The logissue command lines, skipping `#` comments / blanks."""
    return [ln for ln in out.splitlines() if ln.startswith(LOGISSUE)]


def _props(line):
    """The ``k=v;`` property list of a logissue line (between the space and ])."""
    inner = line[len(LOGISSUE):]
    return inner.split("]", 1)[0]


class CliBrokenFixture(unittest.TestCase):
    def test_broken_emits_error_logissues_nonzero_exit(self):
        proc = _run(["--format", "azure", BROKEN_REL])
        self.assertNotEqual(proc.returncode, 0, proc.stderr)
        cmds = _command_lines(proc.stdout)
        self.assertTrue(cmds, "no logissue lines emitted")
        # At least one type=error (broken.xml has fatal violations).
        self.assertTrue(
            any(ln.startswith(LOGISSUE + "type=error") for ln in cmds),
            "no `##vso[task.logissue type=error` line on the broken fixture")
        for ln in cmds:
            props = _props(ln)
            self.assertTrue(
                props.startswith(("type=error", "type=warning")),
                "logissue line lacks a type=error/warning: %r" % ln)
            self.assertIn("sourcepath=", props, "missing sourcepath= in %r" % ln)
            self.assertIn("code=", props, "missing code= in %r" % ln)
            # The command must actually close with ] before the message.
            self.assertIn("]", ln[len(LOGISSUE):],
                          "logissue command not closed with ]: %r" % ln)

    def test_code_carries_rule_id(self):
        report = build_report(BROKEN)
        # azure surfaces EVERY severity, so every violation's rule id must
        # appear as a code= property.
        out = build_azure(report)
        for v in report["violations"]:
            rid = v.get("rule")
            if rid:
                self.assertIn("code=" + rid, out,
                              "rule id %r not carried as a code=" % rid)


class CliFixedFixture(unittest.TestCase):
    def test_fixed_exits_zero_no_error_line(self):
        proc = _run(["--format", "azure", FIXED_REL])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("type=error", proc.stdout,
                         "conformant fixture emitted a type=error logissue")


class SeverityMapping(unittest.TestCase):
    def test_level_mapping(self):
        self.assertEqual(_azure_level("fatal"), "error")
        self.assertEqual(_azure_level("warning"), "warning")
        self.assertEqual(_azure_level("information"), "warning")
        self.assertEqual(_azure_level("weird-unknown"), "warning")


class Escaping(unittest.TestCase):
    def test_escape_data_helper(self):
        # % must be escaped FIRST (to %AZP25) so the introduced escape chars are
        # not re-escaped.
        self.assertEqual(_azure_escape_data("100%"), "100%AZP25")
        self.assertEqual(_azure_escape_data("a\nb"), "a%0Ab")
        self.assertEqual(_azure_escape_data("a\rb"), "a%0Db")
        self.assertEqual(_azure_escape_data("a\r\nb"), "a%0D%0Ab")
        # No double-encoding: a literal "%0A" becomes "%AZP250A", not re-escaped.
        self.assertEqual(_azure_escape_data("x%0Ay"), "x%AZP250Ay")
        # data escaping does NOT touch ; or ] (those are message-legal).
        self.assertEqual(_azure_escape_data("a;b]c"), "a;b]c")

    def test_escape_property_helper(self):
        # properties additionally encode the ; and ] delimiters.
        self.assertEqual(_azure_escape_property("a;b"), "a%3Bb")
        self.assertEqual(_azure_escape_property("a]b"), "a%5Db")
        self.assertEqual(_azure_escape_property("100%;x"), "100%AZP25%3Bx")
        # newlines still fold through the data layer.
        self.assertEqual(_azure_escape_property("a\nb"), "a%0Ab")

    def test_end_to_end_message_and_property_escape(self):
        # A synthetic record whose message and path force every escape class.
        report = {
            "source": "dir;with]bracket/inv%1.xml",
            "violations": [{
                "rule": "BR-X",
                "severity": "fatal",
                "message": "value 50% > 40%\nsecond line",
            }],
        }
        out = build_azure(report)
        line = _command_lines(out)[0]
        # message body: % -> %AZP25 (first), LF -> %0A; ; and ] in the message
        # body are legal after the closing ] and left as-is.
        self.assertIn("value 50%AZP25 > 40%AZP25%0Asecond line", out)
        self.assertNotIn("\n", line)  # the LF is encoded, line stays single
        # sourcepath= property: ; -> %3B, ] -> %5D, % -> %AZP25.
        self.assertIn("sourcepath=dir%3Bwith%5Dbracket/inv%AZP251.xml", line)


class SourceLineToken(unittest.TestCase):
    def test_source_line_present_emits_linenumber_token(self):
        report = {
            "source": "inv.xml",
            "violations": [{"rule": "BR-Y", "severity": "fatal",
                            "message": "bad", "source_line": 42}],
        }
        line = _command_lines(build_azure(report))[0]
        self.assertIn("linenumber=42", line)

    def test_source_line_absent_omits_linenumber_token(self):
        report = {
            "source": "inv.xml",
            "violations": [{"rule": "BR-Z", "severity": "fatal",
                            "message": "bad"}],  # no source_line
        }
        line = _command_lines(build_azure(report))[0]
        self.assertNotIn("linenumber=", line)
        self.assertNotIn("linenumber=0", line)

    def test_broken_fixture_has_no_linenumber_token(self):
        # The committed broken fixture carries no source positions, so the real
        # CLI output must not contain a linenumber= token (and never =0).
        out = _run(["--format", "azure", BROKEN_REL]).stdout
        for ln in _command_lines(out):
            self.assertNotIn("linenumber=", ln)


class NotWellFormed(unittest.TestCase):
    def test_parse_error_single_error_line(self):
        report = {"source": "x.xml", "error": "not-well-formed",
                  "message": "junk at line 1"}
        cmds = _command_lines(build_azure(report))
        self.assertEqual(len(cmds), 1)
        self.assertTrue(cmds[0].startswith(LOGISSUE + "type=error"))
        self.assertIn("sourcepath=x.xml", cmds[0])
        self.assertIn("code=not-well-formed", cmds[0])


class Conformant(unittest.TestCase):
    def test_zero_violation_report_is_noop_comment(self):
        out = build_azure({"source": "clean.xml", "violations": []})
        self.assertTrue(out.strip(), "conformant output is empty")
        self.assertNotIn(LOGISSUE, out)
        self.assertNotIn("type=error", out)
        self.assertTrue(out.startswith("#"), "expected a # log-comment no-op")
        # A bare `#` comment must NOT be mistaken for a ##vso command.
        self.assertFalse(out.startswith("##vso"))


class Purity(unittest.TestCase):
    def test_build_azure_does_not_mutate_report(self):
        report = build_report(BROKEN)
        before_n = len(report["violations"])
        before_fatal = report["fatal_count"]
        build_azure(report)
        self.assertEqual(len(report["violations"]), before_n)
        self.assertEqual(report["fatal_count"], before_fatal)


class CommittedArtifactDriftGuard(unittest.TestCase):
    def test_ci_files_present(self):
        self.assertTrue(os.path.isfile(COMMITTED), COMMITTED)
        self.assertTrue(os.path.isfile(PIPELINE), PIPELINE)

    def test_committed_output_matches_fresh_build(self):
        # Build via the CLI with the SAME repo-relative path the committed
        # artifact was generated from, so the sourcepath= matches byte-for-byte
        # (an absolute path would be machine-specific).
        fresh = _run(["--format", "azure", BROKEN_REL]).stdout
        with open(COMMITTED, encoding="utf-8") as fh:
            committed = fh.read()
        self.assertEqual(
            committed, fresh,
            "examples/ci-azure/azure-logissues.txt is stale; regenerate it "
            "from build_azure(build_report(broken.xml))")


if __name__ == "__main__":
    unittest.main()

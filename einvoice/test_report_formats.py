#!/usr/bin/env python3
"""test_report_formats.py — bidirectional report-format parity guard (T-VHRPT.3).

Fast, stdlib-only, saxonche-free, offline. This test does NOT add or change any
report format, rule, or exit code. It is a drift guard that ties three things
together and fails if any two disagree:

  * the `--format` choices `einvoice/report.py` actually accepts and emits,
  * the surfaces documented in REPORT-FORMATS.md, and
  * the observed exit codes (0 conformant / 1 fatal).

It reuses the SAME committed known-good / known-bad pair that test_report_gitlab
already drives (examples/01-missing-fields/{fixed,broken}.xml) — no new corpus,
no synthesized invoices.

Asserted (each maps to a task acceptance criterion):
  1. Every `--format` value emits non-empty, well-shaped output for BOTH the
     valid fixture (exit 0) and the invalid fixture (exit 1).
  2. `--baseline` diff and `--explain` on a real rule id behave as advertised.
  3. BIDIRECTIONAL parity: the set of formats report.py accepts equals the set
     documented in REPORT-FORMATS.md — adding OR removing a format without
     updating the doc turns this gate red. Both standalone modes are documented.
  4. POSITION ON THE HUMAN SURFACES (T-VHLOC.3): every surface declared in
     :data:`LINE_BEARING_HUMAN_SURFACES` renders the `file:line` position for a
     finding the engine attributed, and renders NOTHING for one it did not.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
import xml.dom.minidom
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.report import EXIT_OK, EXIT_FAIL, REPORT_FORMATS  # noqa: E402

# The ONE source_line fixture and the ONE expected-line helper, imported from
# where T-VHDIAG.1 already proved them (test_report_location.py). Deliberately
# NOT re-declared here: a second fixture or a second helper is exactly how the
# expected value drifts away from the fixture text it is supposed to describe.
from test_report_location import INVALID_UBL, _expected_line  # noqa: E402

REPORT_PY = os.path.join(HERE, "einvoice", "report.py")
DOC = os.path.join(HERE, "REPORT-FORMATS.md")

# The committed known-good / known-bad pair (also used by test_report_gitlab).
EX = os.path.join(HERE, "examples", "01-missing-fields")
FIXED = os.path.join(EX, "fixed.xml")    # conformant  -> exit 0
BROKEN = os.path.join(EX, "broken.xml")  # fatal viol. -> exit 1

# A rule id that fixtures/tests already rely on and that is in the catalog.
KNOWN_RULE = "BR-DE-15"

# --------------------------------------------------------------------------- #
# T-VHLOC.3 — the DECLARATION the position guard below is driven from.
#
# The engine stamps an optional 1-based ``source_line`` on the findings it can
# attribute to a concrete element (T-VHDIAG.1; today the present-but-invalid
# header code-list rules BR-CL-01/-04/-05). Five MACHINE surfaces already
# render it — json (``source_line``), sarif (``region.startLine``), github
# (``line=``), azure (``linenumber=``), gitlab (``location.lines.begin``) — and
# their guards live in test_report_location.py, test_report_sarif.py,
# test_ci_annotation_position.py and test_report_gitlab.py.
#
# The two surfaces a PERSON reads had silently dropped it. Naming them here,
# rather than inlining two ad-hoc assertions, is the point: a NEW human surface
# has to be added to (or deliberately argued out of) this list, so "the engine
# computed the position and this renderer quietly threw it away" cannot recur
# unnoticed a fourth time.
#
# Each entry: surface -> the one-line reason it MUST carry the position.
LINE_BEARING_HUMAN_SURFACES = {
    # `--format text` is the surface a developer reads at a terminal after a
    # failed export; an XPath tells them which element is wrong, `file:line` is
    # the only part their editor and terminal can actually jump to.
    "text": "the terminal report a human reads; file:line is the jumpable part",
    # `--format junit` <failure> bodies are what a CI test pane (Jenkins,
    # GitLab, GitHub Actions test reporters) shows a human on a red build — the
    # body is the ONLY place that pane can carry a position.
    "junit": "the CI failure body a human reads on a red build",
}


def run_validate(args, cwd=None):
    """Invoke `python3 -m einvoice validate ...`; return (rc, stdout, stderr).

    The `einvoice` CLI (not `einvoice.report`) is where `--quiet` lives, so the
    suppression leg of the position guard has to drive this entry point."""
    env = dict(os.environ)
    env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.run(
        [sys.executable, "-m", "einvoice", "validate"] + list(args),
        cwd=cwd or HERE, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    return proc.returncode, proc.stdout, proc.stderr


def run_cli(args, cwd=None):
    """Invoke `python3 -m einvoice.report ...`; return (rc, stdout, stderr)."""
    env = dict(os.environ)
    env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.run(
        [sys.executable, "-m", "einvoice.report"] + list(args),
        cwd=cwd or HERE, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    return proc.returncode, proc.stdout, proc.stderr


# --------------------------------------------------------------------------- #
# Sources of truth: parse the accepted set out of report.py and the documented
# set out of REPORT-FORMATS.md. Neither hard-codes the format list, so the two
# genuinely have to agree.
# --------------------------------------------------------------------------- #
def accepted_formats():
    """The single-file `--format` set report.py accepts: the NAMED module
    constant ``einvoice.report.REPORT_FORMATS`` (hoisted from the old inline
    tuple by T-VHINTRO.1; the batch path still advertises a strict inline
    subset). The source assertion pins that the `--format` check site really
    tests against that constant, so the imported set provably IS the enforced
    vocabulary — the same anti-drift guarantee the old source-scrape gave."""
    with open(REPORT_PY, encoding="utf-8") as fh:
        src = fh.read()
    assert "fmt not in REPORT_FORMATS" in src, (
        "report.py --format check no longer tests against REPORT_FORMATS — "
        "accepted_formats() would drift from the enforced set")
    return set(REPORT_FORMATS)


def documented():
    """Return (formats, modes) parsed from REPORT-FORMATS.md table rows only.

    A format is recorded from a table cell of the form ``--format <name>``; a
    mode from a cell containing ``--baseline`` / ``--explain``. Confining the
    scan to `|`-delimited rows keeps prose from polluting the set."""
    formats, modes = set(), set()
    with open(DOC, encoding="utf-8") as fh:
        for line in fh:
            if not line.lstrip().startswith("|"):
                continue
            first = line.strip().strip("|").split("|")[0]
            m = re.search(r"--format\s+([a-z]+)", first)
            if m:
                formats.add(m.group(1))
            if "--baseline" in first:
                modes.add("baseline")
            if "--explain" in first:
                modes.add("explain")
    return formats, modes


def _assert_well_shaped(testcase, fmt, out):
    """Every surface must emit non-empty, structurally-valid output."""
    testcase.assertTrue(out.strip(), "%s emitted empty output" % fmt)
    if fmt in ("json", "sarif", "gitlab", "badge"):
        obj = json.loads(out)  # raises -> test fails, which is the point
        if fmt == "json":
            testcase.assertEqual(obj.get("schema"),
                                 "einvoice-conformance-report/v1")
        elif fmt == "sarif":
            testcase.assertEqual(obj.get("version"), "2.1.0")
            testcase.assertIn("runs", obj)
        elif fmt == "gitlab":
            testcase.assertIsInstance(obj, list)
        elif fmt == "badge":
            testcase.assertEqual(obj.get("schemaVersion"), 1)
            testcase.assertIn("message", obj)
    elif fmt == "junit":
        dom = xml.dom.minidom.parseString(out)
        testcase.assertTrue(dom.getElementsByTagName("testsuite"),
                            "junit output has no <testsuite>")
    elif fmt == "github":
        # GitHub Actions workflow-command lines: every non-blank line is either a
        # ``::error``/``::warning``/``::notice`` command or a ``#`` log comment
        # (the conformant no-op). Command lines must carry file= and title=.
        for line in out.splitlines():
            if not line.strip():
                continue
            testcase.assertTrue(
                line.startswith(("::error ", "::warning ", "::notice ", "#")),
                "github line is not a workflow command or comment: %r" % line)
            if line.startswith("::"):
                testcase.assertIn("file=", line,
                                  "github command line missing file=: %r" % line)
                testcase.assertIn("title=", line,
                                  "github command line missing title=: %r" % line)
    elif fmt == "azure":
        # Azure DevOps logging-command lines: every non-blank line is either a
        # ``##vso[task.logissue ...]`` command or a ``#`` log comment (the
        # conformant no-op). Command lines must carry sourcepath= and code=.
        for line in out.splitlines():
            if not line.strip():
                continue
            if line.startswith("##vso[task.logissue "):
                testcase.assertIn("sourcepath=", line,
                                  "azure logissue line missing sourcepath=: %r"
                                  % line)
                testcase.assertIn("code=", line,
                                  "azure logissue line missing code=: %r" % line)
            else:
                testcase.assertTrue(
                    line.startswith("#"),
                    "azure line is not a logissue command or comment: %r" % line)
    elif fmt == "html":
        testcase.assertIn("<html", out.lower())
    elif fmt == "text":
        # human verdict line; non-emptiness already asserted above.
        testcase.assertIn("\n", out)
    else:
        testcase.fail("no shape check defined for format %r" % fmt)


class EveryFormatEmitsForBothFixtures(unittest.TestCase):
    def test_valid_and_invalid_fixture_each_format(self):
        for fmt in sorted(accepted_formats()):
            with self.subTest(fmt=fmt):
                rc, out, err = run_cli(["--format", fmt, FIXED])
                self.assertEqual(rc, EXIT_OK,
                                 "%s on good fixture: rc=%s err=%s"
                                 % (fmt, rc, err))
                _assert_well_shaped(self, fmt, out)

                rc, out, err = run_cli(["--format", fmt, BROKEN])
                self.assertEqual(rc, EXIT_FAIL,
                                 "%s on bad fixture: rc=%s err=%s"
                                 % (fmt, rc, err))
                _assert_well_shaped(self, fmt, out)


class BaselineDiffMode(unittest.TestCase):
    def test_new_fatal_vs_clean_baseline_fails(self):
        import tempfile
        # Capture a clean baseline from the good invoice, then diff the broken
        # one against it: a NEW fatal appears -> exit 1, versioned diff doc.
        rc, base_out, err = run_cli(["--format", "json", FIXED])
        self.assertEqual(rc, EXIT_OK, err)
        with tempfile.NamedTemporaryFile(
                "w", suffix=".json", delete=False, dir=HERE) as fh:
            fh.write(base_out)
            base_path = fh.name
        try:
            rc, out, err = run_cli(["--baseline", base_path, BROKEN])
            self.assertEqual(rc, EXIT_FAIL, err)
            diff = json.loads(out)
            self.assertEqual(diff.get("schema"), "einvoice-conformance-diff/v1")
            self.assertGreater(diff.get("new_fatal_count", 0), 0, out)
        finally:
            os.unlink(base_path)


class ExplainMode(unittest.TestCase):
    def test_known_rule_prints_and_exits_zero(self):
        rc, out, err = run_cli(["--explain", KNOWN_RULE])
        self.assertEqual(rc, EXIT_OK, err)
        self.assertTrue(out.strip())
        self.assertIn(KNOWN_RULE, out)

    def test_unknown_rule_fails(self):
        rc, out, err = run_cli(["--explain", "NOPE-999"])
        self.assertNotEqual(rc, EXIT_OK)


# --------------------------------------------------------------------------- #
# T-VHLOC.3 — the source line must reach the two HUMAN surfaces.
# --------------------------------------------------------------------------- #
#: The needle whose fixture line is the expected position. It is the START TAG
#: of the element BR-CL-04 fires on, which is what expat's CurrentLineNumber
#: reports — the identical needle test_report_location.py asserts against.
POSITION_NEEDLE = "<cbc:DocumentCurrencyCode>"

#: The attributed rule (present-but-invalid BT-5) and the UNattributed one (an
#: absence rule: there is no element to point at) in the SAME fixture run, so
#: the positive and negative directions are measured on one report, not two.
ATTRIBUTED_RULE = "BR-CL-04"
UNATTRIBUTED_RULE = "BR-16"

#: The rendered position shape, anchored to the END of a finding line:
#: `` at <path>:<line>``. Anchoring matters for the negative direction —
#: BR-16's own message contains the words "shall have at least", so a naive
#: ``" at " not in line`` check would fire on prose instead of on a position.
POSITION_RE = re.compile(r" at (\S+):(\d+)$")


def _junit_failure_bodies(xml_text):
    """``{rule id: <failure> body text}`` parsed out of a junit document.

    An XML-reading utility, NOT a second expected-line helper: the expected
    VALUE always comes from test_report_location.py's imported
    ``_expected_line`` over the imported ``INVALID_UBL`` fixture, and nothing
    here recomputes or hard-codes it.
    """
    root = ET.fromstring(xml_text)
    bodies = {}
    for case in root.iter("testcase"):
        failure = case.find("failure")
        if failure is not None:
            bodies[case.get("name")] = (failure.text or "")
    return bodies


class SourceLineReachesHumanSurfaces(unittest.TestCase):
    """Every surface in :data:`LINE_BEARING_HUMAN_SURFACES` renders the line the
    engine already computed — and renders NOTHING for a finding that has none.

    Driven end to end through the real ``python3 -m einvoice.report`` CLI on
    ``test_report_location.INVALID_UBL``. That fixture is synthesized into a
    tempfile exactly as test_report_location.py does, because NO committed
    corpus fixture reaches these tests with a ``source_line`` (measured: the
    three line-bearing rules need a PRESENT but invalid header code). The
    expected value is computed from the fixture text with the imported
    ``_expected_line`` helper, never hard-coded.
    """

    def _outputs(self):
        """(expected_line, {fmt: stdout}) for every declared human surface plus
        the json surface used as the engine-truth cross-check."""
        expected = _expected_line(INVALID_UBL, POSITION_NEEDLE)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "invalid.xml")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(INVALID_UBL)
            out = {}
            for fmt in sorted(set(LINE_BEARING_HUMAN_SURFACES) | {"json"}):
                rc, stdout, err = run_cli(["--profile", "en16931",
                                           "--format", fmt, path])
                self.assertEqual(rc, EXIT_FAIL,
                                 "%s: rc=%s err=%s" % (fmt, rc, err))
                out[fmt] = stdout
            return expected, out, path

    def test_declaration_covers_the_two_human_formats(self):
        # The declaration must name real, accepted formats — a typo here would
        # silently disable the whole guard.
        self.assertTrue(LINE_BEARING_HUMAN_SURFACES)
        for fmt, reason in LINE_BEARING_HUMAN_SURFACES.items():
            self.assertIn(fmt, set(REPORT_FORMATS),
                          "declared human surface %r is not a --format" % fmt)
            self.assertTrue(reason.strip(),
                            "surface %r declared without a reason" % fmt)

    def test_text_report_carries_the_line_for_an_attributed_finding(self):
        self.assertIn("text", LINE_BEARING_HUMAN_SURFACES)
        expected, out, path = self._outputs()
        lines = [ln for ln in out["text"].splitlines()
                 if ln.startswith("  [") and ATTRIBUTED_RULE + ":" in ln]
        self.assertEqual(len(lines), 1, out["text"])
        m = POSITION_RE.search(lines[0])
        self.assertIsNotNone(
            m, "the text finding block dropped the source line the engine "
               "computed: %r" % lines[0])
        self.assertEqual(m.group(1), path, lines[0])
        self.assertEqual(int(m.group(2)), expected,
                         "text position is not the fixture's real line")

    def test_junit_failure_body_carries_the_line(self):
        self.assertIn("junit", LINE_BEARING_HUMAN_SURFACES)
        expected, out, path = self._outputs()
        bodies = _junit_failure_bodies(out["junit"])
        self.assertIn(ATTRIBUTED_RULE, bodies, bodies)
        body = bodies[ATTRIBUTED_RULE]
        m = POSITION_RE.search(body)
        self.assertIsNotNone(
            m, "the junit <failure> body dropped the source line: %r" % body)
        self.assertEqual(m.group(1), path, body)
        self.assertEqual(int(m.group(2)), expected, body)

    def test_unattributed_finding_gains_no_position_anywhere(self):
        # The honesty rule test_report_location.py already proves for json:
        # absence means "not attributable". No placeholder, no :0, no :1.
        _, out, _ = self._outputs()
        text_line = [ln for ln in out["text"].splitlines()
                     if ln.startswith("  [") and UNATTRIBUTED_RULE + ":" in ln]
        self.assertEqual(len(text_line), 1, out["text"])
        self.assertIsNone(POSITION_RE.search(text_line[0]),
                          "an absence rule was given a fabricated position: %r"
                          % text_line[0])
        bodies = _junit_failure_bodies(out["junit"])
        self.assertIn(UNATTRIBUTED_RULE, bodies, bodies)
        self.assertIsNone(POSITION_RE.search(bodies[UNATTRIBUTED_RULE]),
                          "an absence rule was given a fabricated position in "
                          "junit: %r" % bodies[UNATTRIBUTED_RULE])
        # And the historic body bytes are intact, not merely position-free.
        self.assertEqual(bodies[UNATTRIBUTED_RULE], "fatal: cac:InvoiceLine",
                         bodies[UNATTRIBUTED_RULE])

    def test_human_surfaces_agree_with_the_engine_in_BOTH_directions(self):
        # Set equality against json's source_line: neither over- nor
        # under-emission can pass. This is what makes the guard standing rather
        # than a two-rule spot check.
        _, out, _ = self._outputs()
        doc = json.loads(out["json"])
        engine = {v["rule"] for v in doc["violations"] if "source_line" in v}
        self.assertTrue(engine, "fixture no longer produces any source_line")

        text_positioned = set()
        for ln in out["text"].splitlines():
            if not ln.startswith("  ["):
                continue
            if POSITION_RE.search(ln):
                text_positioned.add(ln.split("] ", 1)[1].split(":", 1)[0])
        self.assertEqual(text_positioned, engine,
                         "text positions %s != engine source_lines %s"
                         % (sorted(text_positioned), sorted(engine)))

        junit_positioned = {rule for rule, body
                            in _junit_failure_bodies(out["junit"]).items()
                            if POSITION_RE.search(body)}
        self.assertEqual(junit_positioned, engine,
                         "junit positions %s != engine source_lines %s"
                         % (sorted(junit_positioned), sorted(engine)))

    def test_verdict_line_is_first_and_every_added_element_is_indented(self):
        # The stdout-purity prefix guard and any `grep '^FAIL'` must keep their
        # meaning: exactly one unindented line, and it is the verdict.
        _, out, _ = self._outputs()
        lines = out["text"].splitlines()
        self.assertTrue(lines[0].startswith("FAIL  "), lines[:1])
        unindented = [ln for ln in lines if ln and not ln.startswith(" ")]
        self.assertEqual(unindented, [lines[0]],
                         "an added element is not indented: %r" % unindented)

    def test_quiet_still_suppresses_the_detail(self):
        expected = _expected_line(INVALID_UBL, POSITION_NEEDLE)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "invalid.xml")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(INVALID_UBL)
            rc, out, err = run_validate(["--profile", "en16931",
                                         "--quiet", path])
            self.assertEqual(rc, EXIT_FAIL, err)
            self.assertEqual(out, "", "--quiet printed detail: %r" % out)
            # ...while the same run WITHOUT --quiet does carry the position, so
            # the suppression above is real rather than a fixture that never
            # had one.
            rc2, loud, err2 = run_validate(["--profile", "en16931", path])
            self.assertEqual(rc2, EXIT_FAIL, err2)
            self.assertIn(" at %s:%d" % (path, expected), loud, loud)


class BidirectionalParity(unittest.TestCase):
    def test_accepted_and_documented_sets_match(self):
        accepted = accepted_formats()
        doc_formats, doc_modes = documented()
        # Sanity: the accepted set is the full eight, not the batch subset.
        self.assertEqual(
            accepted,
            {"json", "junit", "sarif", "gitlab", "github", "azure", "html",
             "badge", "text"},
            "report.py accepted-format set changed: %s" % sorted(accepted))
        # Forward: every accepted format has a documented row.
        missing_doc = accepted - doc_formats
        self.assertFalse(missing_doc,
                         "formats accepted by report.py but undocumented in "
                         "REPORT-FORMATS.md: %s" % sorted(missing_doc))
        # Reverse: every documented format is actually accepted.
        extra_doc = doc_formats - accepted
        self.assertFalse(extra_doc,
                         "formats documented in REPORT-FORMATS.md but NOT "
                         "accepted by report.py: %s" % sorted(extra_doc))
        self.assertEqual(accepted, doc_formats)

    def test_every_documented_format_actually_emits(self):
        # Reverse parity, executable form: each documented format must run and
        # emit — a doc row for a format the CLI rejects fails here.
        doc_formats, _ = documented()
        self.assertTrue(doc_formats)
        for fmt in sorted(doc_formats):
            with self.subTest(fmt=fmt):
                rc, out, err = run_cli(["--format", fmt, FIXED])
                self.assertNotIn("unknown format", err.lower(),
                                 "documented format %r rejected by CLI" % fmt)
                self.assertEqual(rc, EXIT_OK, err)
                self.assertTrue(out.strip())

    def test_both_standalone_modes_documented(self):
        _, doc_modes = documented()
        self.assertIn("baseline", doc_modes)
        self.assertIn("explain", doc_modes)


if __name__ == "__main__":
    unittest.main()

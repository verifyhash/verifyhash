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
"""

import json
import os
import re
import subprocess
import sys
import unittest
import xml.dom.minidom

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.report import EXIT_OK, EXIT_FAIL  # noqa: E402

REPORT_PY = os.path.join(HERE, "einvoice", "report.py")
DOC = os.path.join(HERE, "REPORT-FORMATS.md")

# The committed known-good / known-bad pair (also used by test_report_gitlab).
EX = os.path.join(HERE, "examples", "01-missing-fields")
FIXED = os.path.join(EX, "fixed.xml")    # conformant  -> exit 0
BROKEN = os.path.join(EX, "broken.xml")  # fatal viol. -> exit 1

# A rule id that fixtures/tests already rely on and that is in the catalog.
KNOWN_RULE = "BR-DE-15"


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
    """The single-file `--format` set report.py accepts (its widest `fmt not in`
    tuple — the batch path advertises a strict subset)."""
    with open(REPORT_PY, encoding="utf-8") as fh:
        src = fh.read()
    tuples = re.findall(r"fmt not in \(([^)]*)\)", src)
    assert tuples, "could not find any `fmt not in (...)` tuple in report.py"
    sets = [set(re.findall(r"[\"']([a-z]+)[\"']", t)) for t in tuples]
    return max(sets, key=len)


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


class BidirectionalParity(unittest.TestCase):
    def test_accepted_and_documented_sets_match(self):
        accepted = accepted_formats()
        doc_formats, doc_modes = documented()
        # Sanity: the accepted set is the full seven, not the batch subset.
        self.assertEqual(
            accepted,
            {"json", "junit", "sarif", "gitlab", "html", "badge", "text"},
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

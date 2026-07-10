#!/usr/bin/env python3
"""test_report_explain.py — prove the `einvoice.report --explain <RULE-ID>` mode.

Fast, stdlib-only, saxonche-free, offline. `--explain` is a standalone catalog
lookup: it prints the T-VHR.1 remediation-catalog entry for one rule id and
exits, WITHOUT reading (or needing) any invoice file.

Asserted (each maps to a task acceptance criterion):
  1. A KNOWN id (BR-DE-15) prints every documented field — title, requires,
     BT/BG, location, one-line fix, severity, Schematron provenance — and the
     printed strings come verbatim from the catalog; exit 0.
  2. An UNKNOWN id (NOPE-999) exits non-zero and names the id on stderr.
  3. No invoice file is needed (the mode runs from an empty directory with no
     xml anywhere on argv), and lookup is case-insensitive.
"""

import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.remediation import load_catalog  # noqa: E402
from einvoice.report import EXIT_OK, EXIT_FAIL, format_explain  # noqa: E402

KNOWN = "BR-DE-15"


def run_cli(args, cwd=None):
    """Invoke `python3 -m einvoice.report ...`; return (rc, stdout, stderr)."""
    env = dict(os.environ)
    env["PYTHONPATH"] = HERE + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.run(
        [sys.executable, "-m", "einvoice.report"] + args,
        cwd=cwd or HERE, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    return proc.returncode, proc.stdout, proc.stderr


class ExplainKnownId(unittest.TestCase):
    def test_prints_every_documented_field(self):
        entry = load_catalog()[KNOWN]
        rc, out, err = run_cli(["--explain", KNOWN])
        self.assertEqual(rc, EXIT_OK, err)
        self.assertEqual(err, "")
        # The rule id and its human title appear.
        self.assertIn(KNOWN, out)
        self.assertIn(entry["title"], out)
        # Every documented field is rendered, verbatim from the catalog.
        self.assertIn(entry["requires"], out)
        for term in entry["bt_bg"]:
            self.assertIn(term, out)
        self.assertIn(entry["location_hint"], out)
        self.assertIn(entry["fix"], out)
        self.assertIn(entry["severity"], out)
        # Schematron provenance (source) is shown.
        self.assertIn(entry["provenance"]["source"], out)

    def test_format_explain_matches_catalog_only(self):
        # The helper returns text drawn from the catalog; a nonexistent id -> None.
        self.assertIsNotNone(format_explain(KNOWN))
        self.assertIsNone(format_explain("NOPE-999"))

    def test_case_insensitive_lookup(self):
        rc, out, err = run_cli(["--explain", KNOWN.lower()])
        self.assertEqual(rc, EXIT_OK, err)
        # Canonical (catalog-cased) id echoed back.
        self.assertIn(KNOWN, out)


class ExplainUnknownId(unittest.TestCase):
    def test_unknown_id_exits_nonzero_and_names_it(self):
        rc, out, err = run_cli(["--explain", "NOPE-999"])
        self.assertNotEqual(rc, EXIT_OK)
        self.assertEqual(rc, EXIT_FAIL)
        self.assertEqual(out, "")
        self.assertIn("NOPE-999", err)


class ExplainNeedsNoInvoice(unittest.TestCase):
    def test_runs_with_no_invoice_file_present(self):
        # Run from an EMPTY temp dir with no xml anywhere: still succeeds.
        with tempfile.TemporaryDirectory() as tmp:
            rc, out, err = run_cli(["--explain", KNOWN], cwd=tmp)
            self.assertEqual(rc, EXIT_OK, err)
            self.assertIn(KNOWN, out)

    def test_explain_rejects_an_invoice_path(self):
        rc, out, err = run_cli(["--explain", KNOWN, "some-invoice.xml"])
        self.assertEqual(rc, EXIT_FAIL)
        self.assertIn("some-invoice.xml", err)

    def test_explain_rejects_format_and_baseline(self):
        rc, _, err = run_cli(["--explain", KNOWN, "--format", "junit"])
        self.assertEqual(rc, EXIT_FAIL)
        self.assertIn("--explain", err)
        rc, _, err = run_cli(["--explain", KNOWN, "--baseline", "prev.json"])
        self.assertEqual(rc, EXIT_FAIL)
        self.assertIn("--explain", err)


if __name__ == "__main__":
    unittest.main()

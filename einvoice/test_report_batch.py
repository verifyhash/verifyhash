#!/usr/bin/env python3
"""test_report_batch.py — prove the T-VHX.1 directory / batch validation mode.

Fast, stdlib-only, saxonche-free, offline. Exercises einvoice.report's batch
wrapper both as a library (build_batch_report / batch_exit_code) and as the CLI
entry point (python3 -m einvoice.report <dir>), against the SAME local corpus
fixture the other fast gates use — no new corpus.

Asserted (each maps to a task acceptance criterion):
  1. build_batch_report over a mixed folder (>=1 good + >=1 fatally-bad) emits
     schema 'einvoice-conformance-batch/v1', a 'files' array with one entry per
     invoice, correct per-file findings, and summed aggregate counts.
  2. Aggregate exit code is 0 when every file passes, non-zero (EXIT_FAIL) when
     any file fails.
  3. An empty directory -> file_count 0, explicit note, no traceback, exit 0.
  4. Single-file invocation bytes + exit code are UNCHANGED vs before (each
     per-file report in the batch is byte-identical to a standalone run).
  5. This file exists and passes.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.report import (  # noqa: E402
    build_report, build_batch_report, batch_exit_code, collect_invoice_files,
    build_junit_batch, build_batch_text,
    REPORT_BATCH_SCHEMA_ID, REPORT_SCHEMA_ID, EXIT_OK, EXIT_FAIL, EXIT_PARSE,
)

BASE = os.path.join(HERE, "corpus", "xrechnung-testsuite", "src", "test",
                    "business-cases", "standard", "01.01a-INVOICE_ubl.xml")


def make_bad_invoice(dest):
    """Copy BASE with its BuyerReference removed -> violates BR-DE-15 (fatal)."""
    with open(BASE, encoding="utf-8") as fh:
        src = fh.read()
    bad = re.sub(r"<cbc:BuyerReference>[^<]*</cbc:BuyerReference>", "", src,
                 count=1)
    assert bad != src, "fixture drift: BASE lost its BuyerReference"
    with open(dest, "w", encoding="utf-8") as fh:
        fh.write(bad)


def make_mixed_dir(tmp):
    """Populate tmp with one good + one fatally-bad invoice, plus noise that
    must be skipped (a dotfile invoice + a non-invoice file). Returns
    (good_path, bad_path)."""
    good = os.path.join(tmp, "good.xml")
    with open(BASE, encoding="utf-8") as fh:
        with open(good, "w", encoding="utf-8") as out:
            out.write(fh.read())
    bad = os.path.join(tmp, "bad.xml")
    make_bad_invoice(bad)
    # Noise that must NOT be collected:
    with open(os.path.join(tmp, ".hidden.xml"), "w", encoding="utf-8") as fh:
        fh.write("<Invoice/>")  # dotfile — skipped
    with open(os.path.join(tmp, "README.txt"), "w", encoding="utf-8") as fh:
        fh.write("not an invoice")  # wrong extension — skipped
    return good, bad


class BatchMixedFolder(unittest.TestCase):
    def test_mixed_folder_aggregate_shape_and_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            good, bad = make_mixed_dir(tmp)
            batch = build_batch_report(tmp, profile="xrechnung")

        self.assertEqual(batch["schema"], REPORT_BATCH_SCHEMA_ID)
        self.assertEqual(batch["schema"], "einvoice-conformance-batch/v1")
        self.assertIn("report_version", batch)
        # exactly the two real invoices, dotfile + .txt skipped
        self.assertEqual(batch["file_count"], 2, batch)
        self.assertEqual(len(batch["files"]), 2)
        # each per-file report keeps the single-file schema, unchanged
        for r in batch["files"]:
            self.assertEqual(r["schema"], REPORT_SCHEMA_ID)
        sources = [r["source"] for r in batch["files"]]
        self.assertIn(good, sources)
        self.assertIn(bad, sources)
        # deterministic: files array is sorted by path
        self.assertEqual(sources, sorted(sources))

        by_src = {r["source"]: r for r in batch["files"]}
        self.assertTrue(by_src[good]["valid"])
        self.assertEqual(by_src[good]["fatal_count"], 0)
        self.assertFalse(by_src[bad]["valid"])
        self.assertGreaterEqual(by_src[bad]["fatal_count"], 1)
        self.assertIn("BR-DE-15", [v["rule"] for v in by_src[bad]["violations"]])

        # aggregate counts are the sum across files
        self.assertEqual(batch["fatal_count"],
                         sum(r["fatal_count"] for r in batch["files"]))
        self.assertEqual(batch["warning_count"],
                         sum(r["warning_count"] for r in batch["files"]))
        self.assertEqual(batch["violation_count"],
                         sum(r["violation_count"] for r in batch["files"]))
        self.assertEqual(batch["failed_file_count"], 1)

    def test_mixed_folder_exit_code_is_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_mixed_dir(tmp)
            batch = build_batch_report(tmp, profile="xrechnung")
        self.assertEqual(batch_exit_code(batch), EXIT_FAIL)

    def test_all_good_exit_code_is_ok(self):
        with tempfile.TemporaryDirectory() as tmp:
            for i in range(2):
                with open(BASE, encoding="utf-8") as fh, \
                        open(os.path.join(tmp, "g%d.xml" % i), "w",
                             encoding="utf-8") as out:
                    out.write(fh.read())
            batch = build_batch_report(tmp, profile="xrechnung")
        self.assertEqual(batch["file_count"], 2)
        self.assertEqual(batch["fatal_count"], 0)
        self.assertEqual(batch["failed_file_count"], 0)
        self.assertEqual(batch_exit_code(batch), EXIT_OK)

    def test_errored_file_gives_parse_exit_when_no_fatal(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(BASE, encoding="utf-8") as fh, \
                    open(os.path.join(tmp, "good.xml"), "w",
                         encoding="utf-8") as out:
                out.write(fh.read())
            with open(os.path.join(tmp, "broken.xml"), "w",
                      encoding="utf-8") as fh:
                fh.write("<Invoice><unclosed>")
            batch = build_batch_report(tmp, profile="xrechnung")
        # precedence: no fatal fail present, one errored file -> EXIT_PARSE
        self.assertEqual(batch["failed_file_count"], 1)
        self.assertEqual(batch_exit_code(batch), EXIT_PARSE)

    def test_fatal_outranks_parse(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_bad_invoice(os.path.join(tmp, "bad.xml"))
            with open(os.path.join(tmp, "broken.xml"), "w",
                      encoding="utf-8") as fh:
                fh.write("<Invoice><unclosed>")
            batch = build_batch_report(tmp, profile="xrechnung")
        # a fatal file AND an errored file -> fatal wins, EXIT_FAIL
        self.assertEqual(batch_exit_code(batch), EXIT_FAIL)


class BatchEmptyDir(unittest.TestCase):
    def test_empty_directory_is_clean_no_traceback(self):
        with tempfile.TemporaryDirectory() as tmp:
            batch = build_batch_report(tmp, profile="xrechnung")
        self.assertEqual(batch["file_count"], 0)
        self.assertEqual(batch["files"], [])
        self.assertEqual(batch["fatal_count"], 0)
        self.assertEqual(batch["failed_file_count"], 0)
        self.assertIn("note", batch)
        self.assertIn("no invoice files found", batch["note"])
        self.assertEqual(batch_exit_code(batch), EXIT_OK)

    def test_collect_skips_dotfiles_and_non_invoices(self):
        with tempfile.TemporaryDirectory() as tmp:
            # nested dir with an invoice (recursive walk must find it)
            sub = os.path.join(tmp, "sub")
            os.mkdir(sub)
            nested = os.path.join(sub, "n.xml")
            with open(nested, "w", encoding="utf-8") as fh:
                fh.write("<Invoice/>")
            # dot-directory must be pruned
            dotdir = os.path.join(tmp, ".git")
            os.mkdir(dotdir)
            with open(os.path.join(dotdir, "config.xml"), "w",
                      encoding="utf-8") as fh:
                fh.write("<Invoice/>")
            with open(os.path.join(tmp, ".swp.xml"), "w",
                      encoding="utf-8") as fh:
                fh.write("<Invoice/>")
            with open(os.path.join(tmp, "notes.md"), "w",
                      encoding="utf-8") as fh:
                fh.write("hi")
            found = collect_invoice_files(tmp)
        self.assertEqual(found, [nested])


class SingleFileUnchanged(unittest.TestCase):
    """The per-file report inside a batch must be byte-for-byte identical to a
    standalone single-file report for the same file."""

    def test_per_file_report_matches_standalone(self):
        with tempfile.TemporaryDirectory() as tmp:
            good, bad = make_mixed_dir(tmp)
            standalone_good = build_report(good, profile="xrechnung")
            standalone_bad = build_report(bad, profile="xrechnung")
            batch = build_batch_report(tmp, profile="xrechnung")
        by_src = {r["source"]: r for r in batch["files"]}
        # exact dict equality AND identical JSON bytes
        self.assertEqual(by_src[good], standalone_good)
        self.assertEqual(by_src[bad], standalone_bad)
        self.assertEqual(
            json.dumps(by_src[good], separators=(",", ":")),
            json.dumps(standalone_good, separators=(",", ":")))
        self.assertEqual(
            json.dumps(by_src[bad], separators=(",", ":")),
            json.dumps(standalone_bad, separators=(",", ":")))


class BatchCLI(unittest.TestCase):
    def _run(self, *cli_args):
        return subprocess.run(
            [sys.executable, "-m", "einvoice.report", "--profile", "xrechnung",
             *cli_args],
            cwd=HERE, capture_output=True, text=True, timeout=180)

    def test_cli_directory_json_and_exit_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            good, bad = make_mixed_dir(tmp)
            proc = self._run(tmp)
        self.assertEqual(proc.returncode, EXIT_FAIL, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["schema"], "einvoice-conformance-batch/v1")
        self.assertEqual(payload["file_count"], 2)
        self.assertIn("BR-DE-15", proc.stdout)

    def test_cli_all_good_directory_exits_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(BASE, encoding="utf-8") as fh, \
                    open(os.path.join(tmp, "g.xml"), "w",
                         encoding="utf-8") as out:
                out.write(fh.read())
            proc = self._run(tmp)
        self.assertEqual(proc.returncode, EXIT_OK, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["file_count"], 1)

    def test_cli_empty_dir_exits_zero_with_note(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = self._run(tmp)
        self.assertEqual(proc.returncode, EXIT_OK, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["file_count"], 0)
        self.assertIn("no invoice files found", payload.get("note", ""))

    def test_cli_single_file_bytes_unchanged(self):
        """The exact stdout bytes + exit code of a single-file run must be the
        same shape as always (a directory path never leaks into it)."""
        with tempfile.TemporaryDirectory() as tmp:
            good, _ = make_mixed_dir(tmp)
            proc = self._run(good)
        self.assertEqual(proc.returncode, EXIT_OK, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["schema"], "einvoice-conformance-report/v1")
        self.assertEqual(payload["source"], good)
        self.assertTrue(payload["valid"])

    def test_cli_junit_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_mixed_dir(tmp)
            proc = self._run("--format", "junit", tmp)
        self.assertEqual(proc.returncode, EXIT_FAIL, proc.stderr)
        self.assertIn("<testsuites", proc.stdout)
        # one <testsuite> per file (2 real invoices)
        self.assertEqual(proc.stdout.count("<testsuite "), 2, proc.stdout)

    def test_cli_text_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_mixed_dir(tmp)
            proc = self._run("--format", "text", tmp)
        self.assertEqual(proc.returncode, EXIT_FAIL, proc.stderr)
        self.assertIn("FAIL", proc.stdout)
        self.assertIn("PASS", proc.stdout)

    def test_cli_sarif_directory_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_mixed_dir(tmp)
            proc = self._run("--format", "sarif", tmp)
        self.assertEqual(proc.returncode, EXIT_FAIL)
        self.assertIn("single file", proc.stderr)

    def test_cli_recurse_flag_on_file_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            good, _ = make_mixed_dir(tmp)
            proc = self._run("--recurse", good)
        self.assertEqual(proc.returncode, EXIT_FAIL)
        self.assertIn("requires a directory", proc.stderr)


class BatchJunitAndText(unittest.TestCase):
    def test_junit_batch_aggregate_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_mixed_dir(tmp)
            batch = build_batch_report(tmp, profile="xrechnung")
        xml = build_junit_batch(batch)
        self.assertTrue(xml.startswith('<?xml version="1.0"'))
        self.assertEqual(xml.count("<testsuite "), 2)
        # aggregate failures on the top-level <testsuites> reflect the bad file
        self.assertRegex(xml, r'<testsuites [^>]*failures="[1-9]')

    def test_text_empty_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            batch = build_batch_report(tmp, profile="xrechnung")
        self.assertIn("no invoice files found", build_batch_text(batch))


if __name__ == "__main__":
    unittest.main()

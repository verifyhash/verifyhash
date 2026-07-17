#!/usr/bin/env python3
"""test_api_embed.py — the T-VHEMBED.1 embedding API matches the CLI exactly.

Task T-VHEMBED.1 exports three CLI capabilities through the documented stable
Python API (see API.md): ``einvoice.validate_batch`` (the ``validate-batch``
aggregation engine), ``einvoice.fails_at`` (the ``--fail-on`` severity
threshold as a pure predicate) and ``einvoice.capabilities`` (the
``einvoice info --json`` payload). All three are THIN WRAPPERS over the code
the CLI already runs — so the one property worth testing is EQUIVALENCE: this
test drives the real CLI (as a subprocess, the packaged entry point) and the
library API on the SAME committed fixtures and asserts they can never
disagree. It deliberately imports ONLY public ``einvoice`` names — exactly
what an embedding user gets — never ``einvoice.cli`` internals.

Asserted (each maps to a task acceptance criterion):
  1. ``validate_batch`` over a valid + a fatally-invalid fixture produces the
     SAME per-file reports (verdict, counts, violations — the whole ``files``
     array) and aggregate counts as ``einvoice validate-batch <dir> --json``
     over the same files; only the ``root`` label differs (the CLI records the
     directory, the library records ``None``).
  2. ``fails_at`` on a warning-only result is False at ``fatal`` and True at
     ``warning``/``information`` — both sides of the threshold — and each
     verdict equals the CLI ``--fail-on <level>`` exit code on the same file;
     an unknown level raises ``ValueError`` just as the CLI exits 2 (usage).
  3. ``capabilities()`` equals the parsed stdout of
     ``python3 -m einvoice info --json`` (the exact invocation test_info.py
     drives), key for key, value for value.
  4. All three names are in ``einvoice.__all__``, importable and callable.

Fast, stdlib-only, saxonche-free, offline. Reuses committed fixtures only
(the same ones test_cli_batch.py / test_fail_on.py drive) — no new invoice
bodies are invented. Pure wrapper test: it adds no validation, rule, or
report code and changes no verdict.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import einvoice  # noqa: E402  (public names ONLY — the embedding user's view)

# Committed fixtures, the exact ones the CLI batch / fail-on tests drive.
PASS_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                            "cen-bis3-positive_ubl.xml")   # en16931: clean
FAIL_FIXTURE = os.path.join(HERE, "fixtures",
                            "creditnote-invalid-typecode_ubl.xml")  # 1 fatal
WARN_FIXTURE = os.path.join(HERE, "corpus", "cen-en16931", "test", "testfiles",
                            "BIS_Billing_30-Resor_Bokning.xml")  # 1 warning,
#                                                     0 fatal under xrechnung

NEW_NAMES = ("validate_batch", "fails_at", "capabilities")


def _cli(*argv):
    """Run the packaged CLI (``python3 -m einvoice ...``) from the repo root —
    the same subprocess invocation test_info.py / test_cli_batch.py use."""
    return subprocess.run(
        [sys.executable, "-m", "einvoice", *argv],
        cwd=HERE, capture_output=True, text=True, timeout=180)


class NamesExported(unittest.TestCase):
    """Criterion 4: the three names are public, importable and callable."""

    def test_in_all_and_callable(self):
        for name in NEW_NAMES:
            with self.subTest(name=name):
                self.assertIn(name, einvoice.__all__)
                obj = getattr(einvoice, name)
                self.assertTrue(callable(obj), "%s must be callable" % name)
                self.assertTrue(obj.__doc__ and obj.__doc__.strip(),
                                "%s needs a docstring" % name)


class ValidateBatchMatchesCli(unittest.TestCase):
    """Criterion 1: validate_batch == the CLI batch engine, file for file."""

    def setUp(self):
        # A temp dir holding a copy of the valid + the fatally-invalid fixture
        # (names chosen so the CLI's sorted directory walk orders them the
        # same way the explicit list below does).
        self.tmp = tempfile.mkdtemp(prefix="einvoice-embed-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.good = os.path.join(self.tmp, "a-good.xml")
        self.bad = os.path.join(self.tmp, "b-bad.xml")
        shutil.copyfile(PASS_FIXTURE, self.good)
        shutil.copyfile(FAIL_FIXTURE, self.bad)

    def test_batch_equals_cli_json(self):
        # The CLI default profile is en16931 — pass the same to the wrapper
        # (whose own default is xrechnung, matching report.py's engine).
        proc = _cli("validate-batch", self.tmp, "--json", "--quiet")
        self.assertEqual(proc.returncode, 1, proc.stderr)  # 1 fatal in batch
        cli_batch = json.loads(proc.stdout)

        lib_batch = einvoice.validate_batch([self.good, self.bad],
                                            profile="en16931")

        # The per-file reports and every aggregate count must be identical;
        # only the 'root' label may differ (dir path vs. None for a list).
        for key in ("report_version", "schema", "profile", "file_count",
                    "fatal_count", "warning_count", "violation_count",
                    "failed_file_count", "files"):
            with self.subTest(key=key):
                self.assertEqual(lib_batch[key], cli_batch[key])
        self.assertIsNone(lib_batch["root"])
        self.assertEqual(cli_batch["root"], self.tmp)

    def test_per_file_verdicts(self):
        batch = einvoice.validate_batch([self.good, self.bad],
                                        profile="en16931")
        by_source = {r["source"]: r for r in batch["files"]}
        self.assertTrue(by_source[self.good]["valid"])
        self.assertEqual(by_source[self.good]["fatal_count"], 0)
        self.assertFalse(by_source[self.bad]["valid"])
        self.assertGreater(by_source[self.bad]["fatal_count"], 0)
        self.assertEqual(batch["failed_file_count"], 1)

    def test_empty_batch_is_honest(self):
        batch = einvoice.validate_batch([])
        self.assertEqual(batch["file_count"], 0)
        self.assertEqual(batch["files"], [])
        self.assertEqual(batch["note"], "no invoice files found")


class FailsAtMatchesCli(unittest.TestCase):
    """Criterion 2: fails_at == the CLI --fail-on exit rule, level for level.

    The warning-only fixture (1 warning, 0 fatal under xrechnung) sits exactly
    ON the boundary: below the 'fatal' threshold, at/above 'warning' and
    'information' — so both sides of the threshold are exercised on one file.
    """

    def setUp(self):
        self.result = einvoice.validate_file(WARN_FIXTURE, profile="xrechnung")
        # Precondition (fixture drift guard): warning-only, no fatal.
        sevs = sorted(v.severity for v in self.result.violations)
        self.assertEqual(sevs, ["warning"], sevs)

    def test_both_sides_of_threshold(self):
        self.assertFalse(einvoice.fails_at(self.result, "fatal"))
        self.assertTrue(einvoice.fails_at(self.result, "warning"))
        self.assertTrue(einvoice.fails_at(self.result, "information"))

    def test_matches_cli_exit_code_per_level(self):
        for level in ("fatal", "warning", "information"):
            with self.subTest(level=level):
                proc = _cli("validate", WARN_FIXTURE, "--profile=xrechnung",
                            "--quiet", "--fail-on", level)
                self.assertIn(proc.returncode, (0, 1), proc.stderr)
                self.assertEqual(einvoice.fails_at(self.result, level),
                                 proc.returncode == 1)

    def test_unknown_level_rejected_like_cli(self):
        # Library: ValueError naming the valid choices; CLI: usage error (2).
        with self.assertRaises(ValueError) as ctx:
            einvoice.fails_at(self.result, "bogus")
        msg = str(ctx.exception)
        for choice in ("fatal", "warning", "information"):
            self.assertIn(choice, msg)
        proc = _cli("validate", WARN_FIXTURE, "--fail-on", "bogus")
        self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_fatal_level_matches_valid(self):
        # fails_at(r, 'fatal') is exactly `not r.valid` — the historical rule.
        bad = einvoice.validate_file(FAIL_FIXTURE)
        self.assertTrue(einvoice.fails_at(bad, "fatal"))
        self.assertEqual(einvoice.fails_at(bad, "fatal"), not bad.valid)
        clean = einvoice.validate_file(PASS_FIXTURE)
        self.assertFalse(einvoice.fails_at(clean, "fatal"))
        self.assertFalse(einvoice.fails_at(clean, "information"))


class CapabilitiesMatchesInfo(unittest.TestCase):
    """Criterion 3: capabilities() == the parsed `einvoice info --json`."""

    def test_equals_info_json(self):
        proc = _cli("info", "--json")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stderr, "")
        self.assertEqual(einvoice.capabilities(), json.loads(proc.stdout))

    def test_documented_keys_present(self):
        caps = einvoice.capabilities()
        self.assertEqual(
            set(caps),
            {"version", "profiles", "formats", "rule_count", "coverage",
             "attestation_sha256"})
        self.assertEqual(caps["version"], einvoice.__version__)
        # JSON-serialisable, as documented.
        json.dumps(caps)


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""test_info.py — pin the read-only ``einvoice info`` introspection contract
(T-VHINTRO.1).

Fast, stdlib-only, offline. Drives the PACKAGED entry point as a subprocess
(``python3 -m einvoice info``) exactly like the other CLI tests, and asserts
the one property that makes ``info`` worth shipping: every emitted value is
sourced at runtime from the package / its committed artifacts, so this test
compares the live output AGAINST THOSE ARTIFACTS (never against retyped
literals) — any drift between the command and the build fails the suite.

What this locks down:
  * ``info`` exits 0 with non-empty stdout and an EMPTY stderr (both forms).
  * ``info --json`` stdout is, in its entirety, ONE parseable JSON object
    carrying exactly the six documented top-level keys.
  * ``version``  == the live ``einvoice.__version__`` attribute.
  * ``profiles`` == sorted ``einvoice.validate.PROFILES``.
  * ``formats``  == {'text'} ∪ set(einvoice.report.REPORT_FORMATS), the
    hoisted constant imported here — retyping the vocabulary anywhere drifts.
  * ``rule_count`` == the committed ``export/rules.json`` ``rule_count``.
  * EVERY number under ``coverage`` == its same-path counterpart in the
    committed ``export/coverage.json`` (walked recursively, no literals).
  * ``attestation_sha256`` == the committed ``attestation.json``
    ``content_sha256``.
  * Any extra argument / unknown flag after ``info`` is a usage error:
    exit 2, ``usage:`` banner on stderr, nothing on stdout.
  * README.md and QUICKSTART.md both document the literal ``einvoice info``.

Documentation + contract test only: it changes no validation, rule, or
report code.
"""

import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import einvoice  # noqa: E402
from einvoice.report import REPORT_FORMATS  # noqa: E402
from einvoice.validate import PROFILES  # noqa: E402

RULES_JSON = os.path.join(HERE, "export", "rules.json")
COVERAGE_JSON = os.path.join(HERE, "export", "coverage.json")
ATTESTATION_JSON = os.path.join(HERE, "attestation.json")

#: The exact documented top-level payload keys — the shape contract.
PAYLOAD_KEYS = {"version", "profiles", "formats", "rule_count", "coverage",
                "attestation_sha256"}


def _run(*argv):
    """Run ``python3 -m einvoice <argv...>`` from the repo root."""
    return subprocess.run(
        [sys.executable, "-m", "einvoice", *argv],
        cwd=HERE, capture_output=True, text=True, timeout=120)


def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


class HumanForm(unittest.TestCase):
    """(a) ``einvoice info``: exit 0, non-empty stdout, EMPTY stderr."""

    @classmethod
    def setUpClass(cls):
        cls.proc = _run("info")

    def test_exit_zero(self):
        self.assertEqual(self.proc.returncode, 0, self.proc.stderr)

    def test_stdout_non_empty(self):
        self.assertTrue(self.proc.stdout.strip())

    def test_stderr_empty(self):
        self.assertEqual(self.proc.stderr, "")

    def test_key_value_lines(self):
        """Every stdout line is a stable ``key: value`` pair."""
        for line in self.proc.stdout.splitlines():
            self.assertIn(": ", line, "not a key: value line: %r" % line)

    def test_every_top_level_key_appears(self):
        for key in PAYLOAD_KEYS:
            self.assertIn(key, self.proc.stdout)


class JsonForm(unittest.TestCase):
    """(b)–(g) ``info --json``: one JSON object, artifact-equal throughout."""

    @classmethod
    def setUpClass(cls):
        cls.proc = _run("info", "--json")
        # (b) the ENTIRE stdout must json.loads-parse — a single object.
        cls.payload = json.loads(cls.proc.stdout)

    def test_exit_zero_and_quiet_stderr(self):
        self.assertEqual(self.proc.returncode, 0, self.proc.stderr)
        self.assertEqual(self.proc.stderr, "")

    def test_is_one_object_with_exact_keys(self):
        self.assertIsInstance(self.payload, dict)
        self.assertEqual(set(self.payload), PAYLOAD_KEYS)

    def test_sorted_keys_serialization(self):
        """The emitted text is byte-identical to sort_keys=True re-serialization."""
        self.assertEqual(self.proc.stdout,
                         json.dumps(self.payload, sort_keys=True) + "\n")

    def test_version_is_the_package_attribute(self):
        # (c) — compared against the LIVE attribute, not a literal.
        self.assertEqual(self.payload["version"], einvoice.__version__)

    def test_profiles_are_the_dispatch_tuple(self):
        self.assertEqual(self.payload["profiles"], sorted(PROFILES))

    def test_formats_equal_the_hoisted_constant_plus_text(self):
        # (d) — imports einvoice.report.REPORT_FORMATS; retyping drifts.
        self.assertEqual(set(self.payload["formats"]),
                         {"text"} | set(REPORT_FORMATS))
        self.assertEqual(self.payload["formats"],
                         sorted(set(self.payload["formats"])))

    def test_rule_count_equals_committed_rules_artifact(self):
        # (e) — the committed export/rules.json is the reference.
        rules = _load(RULES_JSON)
        self.assertEqual(self.payload["rule_count"], rules["rule_count"])
        self.assertIsInstance(self.payload["rule_count"], int)

    def test_every_coverage_number_matches_the_artifact(self):
        """(f) walk every numeric leaf under ``coverage`` and require its
        SAME-PATH counterpart in export/coverage.json to be equal — no
        retyped expectations anywhere."""
        artifact = _load(COVERAGE_JSON)
        checked = []

        def walk(emitted, reference, path):
            self.assertIsInstance(emitted, dict, "at %s" % path)
            for key, value in emitted.items():
                sub = "%s.%s" % (path, key)
                self.assertIn(key, reference,
                              "%s missing from export/coverage.json" % sub)
                if isinstance(value, dict):
                    walk(value, reference[key], sub)
                else:
                    self.assertIsInstance(value, int, "at %s" % sub)
                    self.assertEqual(value, reference[key],
                                     "drift at %s" % sub)
                    checked.append(sub)

        walk(self.payload["coverage"], artifact, "coverage")
        # The headline must actually be there: UBL + CII proven/total plus
        # the business-rule count = at least five compared numbers.
        self.assertGreaterEqual(len(checked), 5, checked)

    def test_coverage_carries_the_frozen_headline_paths(self):
        cov = self.payload["coverage"]
        for syntax in ("ubl", "cii"):
            for key in ("proven", "total"):
                self.assertIn(key, cov["syntax_binding"][syntax])
        self.assertIn("total_asserted", cov["business_rules"])

    def test_attestation_sha256_equals_committed_attestation(self):
        # (g) — the committed attestation.json is the reference.
        attestation = _load(ATTESTATION_JSON)
        self.assertEqual(self.payload["attestation_sha256"],
                         attestation["content_sha256"])


class UsageErrors(unittest.TestCase):
    """(h) anything after ``info`` is a usage error: exit 2, usage on stderr."""

    def _assert_usage(self, proc):
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("usage:", proc.stderr)
        self.assertEqual(proc.stdout, "")

    def test_unknown_flag(self):
        self._assert_usage(_run("info", "--nonsense"))

    def test_extra_positional(self):
        self._assert_usage(_run("info", "extra"))

    def test_extra_positional_with_json(self):
        self._assert_usage(_run("info", "--json", "extra"))


class Documentation(unittest.TestCase):
    """(i) the command is documented where a stranger would look."""

    def _doc(self, name):
        with open(os.path.join(HERE, name), encoding="utf-8") as fh:
            return fh.read()

    def test_readme_documents_info(self):
        text = self._doc("README.md")
        self.assertIn("einvoice info", text)
        self.assertIn("--json", text)

    def test_quickstart_documents_info(self):
        text = self._doc("QUICKSTART.md")
        self.assertIn("einvoice info", text)
        self.assertIn("info --json", text)

    def test_usage_banner_lists_info(self):
        from einvoice.cli import USAGE
        self.assertIn("einvoice info [--json]", USAGE)


if __name__ == "__main__":
    unittest.main(verbosity=2)

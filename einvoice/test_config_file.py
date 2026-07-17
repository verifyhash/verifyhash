#!/usr/bin/env python3
"""test_config_file.py — pin the CLI config-file contract (T-VHDX.3).

The einvoice CLI accepts opt-in DEFAULTS for ``format`` / ``fail-on`` /
``lang`` from ``.einvoice.toml`` in the current directory, else from a
``[tool.einvoice]`` table in ``./pyproject.toml`` (see einvoice/config.py).
This suite drives the LIVE CLI (``einvoice.cli.main``) from throwaway temp
directories — the repo's own ``pyproject.toml`` is NEVER touched or even in
the lookup path — and pins every clause of the contract:

  * each of the three keys honored from ``.einvoice.toml``;
  * each honored from ``[tool.einvoice]`` in ``pyproject.toml``;
  * an explicit CLI flag OVERRIDES a config value;
  * ``.einvoice.toml`` WINS when both files exist;
  * an unknown key is an actionable usage error (exit 2) naming the key and
    the accepted set — never silently swallowed;
  * an invalid VALUE errors on the SAME path as the equivalent bad flag
    (byte-identical stderr for lang/fail-on);
  * with NO config file, behavior is byte-identical to the historical
    defaults;
  * the stdlib-only fallback TOML parser (the live branch on Python < 3.11)
    parses the documented shapes; when ``tomllib`` exists both branches are
    cross-checked on the same input.

Fixtures are reused verbatim from test_exit_codes.py / test_fail_on.py — no
new fixtures with real company data. Fast, stdlib-only, offline.

Run: python3 test_config_file.py
"""

import io
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.cli import main, EXIT_OK, EXIT_FAIL, EXIT_USAGE  # noqa: E402
from einvoice import config as einvoice_config  # noqa: E402

# Reused verbatim from test_exit_codes.py / test_fail_on.py.
# CLEAN: en16931-clean; under the xrechnung profile its FIRST fatal is BR-DE-2,
# whose official KoSIT message is German — the --lang de probe.
CLEAN_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                             "cen-bis3-positive_ubl.xml")
# WARN: 1 warning, 0 fatal under xrechnung — the fail-on threshold probe
# (default 'fatal' exits 0; 'warning' exits 1 — findings unchanged).
WARN_FIXTURE = os.path.join(HERE, "corpus", "cen-en16931", "test", "testfiles",
                            "BIS_Billing_30-Resor_Bokning.xml")

# Substrings pinned against the live rule catalog: BR-DE-2's official German
# KoSIT text vs the English message (test_lang.py proves their provenance).
GERMAN_SNIPPET = "muss übermittelt werden"
ENGLISH_SNIPPET = "must be transmitted"


class _Capture:
    """Run ``main(argv)`` capturing stdout/stderr and the return code."""

    def __init__(self, argv):
        self.argv = argv
        self.rc = None
        self.out = ""
        self.err = ""

    def __enter__(self):
        self._out, self._err = sys.stdout, sys.stderr
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        self.rc = main(self.argv)
        self.out = sys.stdout.getvalue()
        self.err = sys.stderr.getvalue()
        return self

    def __exit__(self, *exc):
        sys.stdout, sys.stderr = self._out, self._err
        return False


class _TmpCwd(unittest.TestCase):
    """Every test runs with cwd = a fresh empty temp dir, so (a) the repo's
    own pyproject.toml is never in the config lookup path and (b) config
    files written here can never leak into the repo."""

    def setUp(self):
        self._old_cwd = os.getcwd()
        self._tmp = tempfile.TemporaryDirectory(prefix="einvoice-cfg-")
        os.chdir(self._tmp.name)

    def tearDown(self):
        os.chdir(self._old_cwd)
        self._tmp.cleanup()

    def write(self, name, text):
        with open(os.path.join(self._tmp.name, name), "w",
                  encoding="utf-8") as fh:
            fh.write(text)


class Fixtures(unittest.TestCase):
    def test_reused_fixtures_present(self):
        self.assertTrue(os.path.isfile(CLEAN_FIXTURE), CLEAN_FIXTURE)
        self.assertTrue(os.path.isfile(WARN_FIXTURE), WARN_FIXTURE)


class NoConfigIsTodaysDefaults(_TmpCwd):
    """Absence of any config file == the historical contract, byte-level."""

    def test_defaults_without_any_config(self):
        # format default: human text summary, not JSON.
        with _Capture(["validate", CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)
            self.assertIn("PASS:", cap.out)
        # fail-on default 'fatal': a warning-only file exits 0.
        with _Capture(["validate", "--profile=xrechnung",
                       WARN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)
        # lang default 'en': the BR-DE-2 message is English.
        with _Capture(["validate", "--profile=xrechnung",
                       CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_FAIL)
            self.assertIn(ENGLISH_SNIPPET, cap.out)
            self.assertNotIn(GERMAN_SNIPPET, cap.out)

    def test_pyproject_without_tool_einvoice_table_is_ignored(self):
        # A pyproject.toml with NO [tool.einvoice] (the repo's own shape)
        # contributes nothing — same defaults as no file at all.
        self.write("pyproject.toml",
                   '[project]\nname = "x"\nversion = "0.0.1"\n'
                   '[tool.other]\nkey = "value"\n')
        with _Capture(["validate", CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)
            self.assertIn("PASS:", cap.out)


class KeysFromEinvoiceToml(_TmpCwd):
    """Each recognized key honored from a top-level .einvoice.toml."""

    def test_format_json(self):
        self.write(".einvoice.toml", 'format = "json"\n')
        with _Capture(["validate", CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)
            payload = json.loads(cap.out)  # machine JSON, not the summary
            self.assertTrue(payload["valid"])
            self.assertNotIn("PASS:", cap.out)

    def test_fail_on_warning(self):
        self.write(".einvoice.toml", 'fail-on = "warning"\n')
        with _Capture(["validate", "--profile=xrechnung",
                       WARN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_FAIL)  # was 0 at default 'fatal'

    def test_lang_de(self):
        self.write(".einvoice.toml", 'lang = "de"\n')
        with _Capture(["validate", "--profile=xrechnung",
                       CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_FAIL)
            self.assertIn(GERMAN_SNIPPET, cap.out)


class KeysFromPyprojectTable(_TmpCwd):
    """Each recognized key honored from [tool.einvoice] in pyproject.toml."""

    def test_format_json(self):
        self.write("pyproject.toml", '[tool.einvoice]\nformat = "json"\n')
        with _Capture(["validate", CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)
            self.assertTrue(json.loads(cap.out)["valid"])

    def test_fail_on_warning(self):
        self.write("pyproject.toml", '[tool.einvoice]\nfail-on = "warning"\n')
        with _Capture(["validate", "--profile=xrechnung",
                       WARN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_FAIL)

    def test_lang_de(self):
        self.write("pyproject.toml", '[tool.einvoice]\nlang = "de"\n')
        with _Capture(["validate", "--profile=xrechnung",
                       CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_FAIL)
            self.assertIn(GERMAN_SNIPPET, cap.out)

    def test_other_pyproject_tables_untouched(self):
        # Sibling [tool.*] tables (setuptools etc.) are none of the config
        # loader's business — unknown keys THERE never error.
        self.write("pyproject.toml",
                   '[tool.setuptools]\npackages = ["x"]\n'
                   '[tool.einvoice]\nlang = "de"\n'
                   '[tool.black]\nline-length = 88\n')
        with _Capture(["validate", "--profile=xrechnung",
                       CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_FAIL)
            self.assertIn(GERMAN_SNIPPET, cap.out)


class CliFlagBeatsConfig(_TmpCwd):
    """Precedence: explicit CLI flag > config file > built-in default."""

    def test_explicit_fail_on_flag_wins(self):
        self.write(".einvoice.toml", 'fail-on = "warning"\n')
        with _Capture(["validate", "--profile=xrechnung",
                       "--fail-on=fatal", WARN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)  # flag restored the default

    def test_explicit_lang_flag_wins(self):
        self.write(".einvoice.toml", 'lang = "de"\n')
        with _Capture(["validate", "--profile=xrechnung",
                       "--lang=en", CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_FAIL)
            self.assertIn(ENGLISH_SNIPPET, cap.out)
            self.assertNotIn(GERMAN_SNIPPET, cap.out)

    def test_explicit_json_flag_beats_format_text(self):
        self.write(".einvoice.toml", 'format = "text"\n')
        with _Capture(["--json", "validate", CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)
            self.assertTrue(json.loads(cap.out)["valid"])


class EinvoiceTomlBeatsPyproject(_TmpCwd):
    """.einvoice.toml wins outright when both files exist."""

    def test_einvoice_toml_wins(self):
        self.write("pyproject.toml",
                   '[tool.einvoice]\nfail-on = "warning"\nformat = "json"\n')
        self.write(".einvoice.toml", 'fail-on = "fatal"\nformat = "text"\n')
        with _Capture(["validate", "--profile=xrechnung",
                       WARN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)     # .einvoice.toml's 'fatal'
            self.assertNotIn('"valid"', cap.out)  # and its 'text'
            self.assertIn("PASS:", cap.out)

    def test_pyproject_not_even_consulted_when_einvoice_toml_exists(self):
        # A BROKEN pyproject table is irrelevant once .einvoice.toml exists —
        # the documented "wins outright" rule, not a merge.
        self.write("pyproject.toml", '[tool.einvoice]\nbogus = "x"\n')
        self.write(".einvoice.toml", 'lang = "en"\n')
        with _Capture(["validate", CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)


class UnknownKeyErrors(_TmpCwd):
    """An unknown key is an actionable usage error — never swallowed."""

    def test_unknown_key_in_einvoice_toml(self):
        self.write(".einvoice.toml", 'formt = "json"\n')  # typo'd key
        with _Capture(["validate", CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("error: unknown key 'formt'", cap.err)
            self.assertIn(".einvoice.toml", cap.err)
            # The accepted set is named, so the fix is in the message.
            self.assertIn("fail-on, format, lang", cap.err)
            self.assertEqual(cap.out, "")  # no validation happened

    def test_unknown_key_in_pyproject_table(self):
        self.write("pyproject.toml", '[tool.einvoice]\nprofile = "en16931"\n')
        with _Capture(["validate", CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("error: unknown key 'profile'", cap.err)
            self.assertIn("pyproject.toml", cap.err)
            self.assertIn("fail-on, format, lang", cap.err)

    def test_non_string_value_errors(self):
        self.write(".einvoice.toml", "lang = 3\n")
        with _Capture(["validate", CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("must be a quoted string", cap.err)


class InvalidValueSharesTheFlagErrorPath(_TmpCwd):
    """An invalid VALUE for a recognized key errors exactly like the
    equivalent bad CLI flag: same exit code, same stderr error line."""

    def test_bad_lang_value_matches_bad_flag(self):
        with _Capture(["validate", "--lang=fr", CLEAN_FIXTURE]) as flag_cap:
            pass
        self.write(".einvoice.toml", 'lang = "fr"\n')
        with _Capture(["validate", CLEAN_FIXTURE]) as cfg_cap:
            pass
        self.assertEqual(flag_cap.rc, EXIT_USAGE)
        self.assertEqual(cfg_cap.rc, EXIT_USAGE)
        self.assertEqual(cfg_cap.err, flag_cap.err)  # byte-identical path
        self.assertIn("error: unknown lang 'fr'", cfg_cap.err)

    def test_bad_fail_on_value_matches_bad_flag(self):
        with _Capture(["validate", "--fail-on=bogus",
                       CLEAN_FIXTURE]) as flag_cap:
            pass
        self.write(".einvoice.toml", 'fail-on = "bogus"\n')
        with _Capture(["validate", CLEAN_FIXTURE]) as cfg_cap:
            pass
        self.assertEqual(flag_cap.rc, EXIT_USAGE)
        self.assertEqual(cfg_cap.rc, EXIT_USAGE)
        self.assertEqual(cfg_cap.err, flag_cap.err)

    def test_bad_format_value(self):
        # No --format flag exists on this CLI, so the config is the only
        # source; the error still names the value and the accepted set.
        self.write(".einvoice.toml", 'format = "yaml"\n')
        with _Capture(["validate", CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("error: unknown format 'yaml'", cap.err)
            self.assertIn("text", cap.err)
            self.assertIn("json", cap.err)


class FallbackParser(unittest.TestCase):
    """The stdlib-only fallback (the LIVE branch on Python < 3.11) parses
    the documented config shapes; when tomllib exists, cross-check both."""

    SAMPLE = ('# comment\n'
              '[tool.einvoice]\n'
              'format = "json"      # trailing comment\n'
              "fail-on = 'warning'\n"
              'lang = "de"\n'
              '[tool.other]\n'
              'n = 42\nflag = true\n')

    def test_fallback_parses_tables_and_scalars(self):
        doc = einvoice_config._parse_toml_fallback(self.SAMPLE)
        table = doc["tool"]["einvoice"]
        self.assertEqual(table["format"], "json")
        self.assertEqual(table["fail-on"], "warning")
        self.assertEqual(table["lang"], "de")
        self.assertEqual(doc["tool"]["other"]["n"], 42)
        self.assertIs(doc["tool"]["other"]["flag"], True)

    def test_fallback_top_level_keys(self):
        doc = einvoice_config._parse_toml_fallback(
            'format = "json"\nfail-on = "fatal"\n')
        self.assertEqual(doc, {"format": "json", "fail-on": "fatal"})

    def test_fallback_unparsed_value_is_not_a_string(self):
        # An array on a recognized key must NOT coerce to a string — it
        # becomes the sentinel and fails the must-be-a-string check.
        doc = einvoice_config._parse_toml_fallback('lang = ["de", "en"]\n')
        self.assertNotIsInstance(doc["lang"], str)

    def test_both_branches_agree_when_tomllib_available(self):
        # On >= 3.11 both parsers must extract the identical [tool.einvoice]
        # table from the same bytes; on this interpreter (no tomllib) the
        # fallback IS the live path and is already covered above.
        if not einvoice_config._HAVE_TOMLLIB:
            self.skipTest("no tomllib on this interpreter (< 3.11); "
                          "the fallback branch is the live path here")
        import tomllib
        self.assertEqual(
            tomllib.loads(self.SAMPLE)["tool"]["einvoice"],
            einvoice_config._parse_toml_fallback(
                self.SAMPLE)["tool"]["einvoice"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

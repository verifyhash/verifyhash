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
import shutil
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


class MixedSourceCoexistence(_TmpCwd):
    """Config-file setting for ONE key and an explicit CLI flag for a
    DIFFERENT key take effect SIMULTANEOUSLY — neither source clobbers the
    other. The existing suite only ever pins a flag OVERRIDING the SAME key
    the config set (CliFlagBeatsConfig); this pins the orthogonal case where
    the two sources contribute distinct settings that must both survive
    resolution (cli.py ~552-569: fail-on / lang / format are each resolved
    independently against ``cfg`` — a flag only overrides the one key it
    names). The class/method names carry the 'mixed' token so the leg is
    mechanically discoverable.
    """

    def test_mixed_config_fail_on_plus_flag_json(self):
        # Config supplies fail-on=warning; the CLI supplies --json. The config's
        # threshold must trip exit 1 on a warning-only file AND the flag's JSON
        # output must be emitted — proving both sources coexist. valid stays
        # True: --fail-on changes only the exit code, never the findings/payload.
        self.write(".einvoice.toml", 'fail-on = "warning"\n')
        with _Capture(["--json", "validate", "--profile=xrechnung",
                       WARN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_FAIL)         # config's fail-on tripped
            payload = json.loads(cap.out)               # flag's JSON form emitted
            self.assertTrue(payload["valid"])           # findings untouched
            self.assertNotIn("PASS:", cap.out)          # not the human summary

    def test_mixed_config_format_json_plus_flag_fail_on(self):
        # The mirror image: config supplies format=json while the CLI supplies
        # --fail-on=warning. JSON output comes from the config, the exit-1
        # threshold comes from the flag — again both sources coexist, from
        # opposite origins to the case above.
        self.write(".einvoice.toml", 'format = "json"\n')
        with _Capture(["validate", "--profile=xrechnung",
                       "--fail-on=warning", WARN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_FAIL)         # flag's fail-on tripped
            payload = json.loads(cap.out)               # config's JSON form
            self.assertTrue(payload["valid"])


class ValidateBatchHonoursConfig(_TmpCwd):
    """Config-file values flow into ``validate-batch`` identically to the
    single-file ``validate`` path — the resolution at cli.py ~552 happens ONCE
    at arg-parse level and the resolved ``fail_on`` is threaded into
    ``_run_validate_batch`` (cli.py 602), so a config threshold changes the
    batch aggregate exit code exactly as it changes a single-file exit code.
    The T-VHDX.3 suite never touched validate-batch at all.
    """

    def _batch_dir_with_warn(self):
        # A one-file batch dir holding the warning-only fixture. Kept tiny; the
        # richer mixed-corpus batch fixtures live in test_cli_batch.py — here we
        # only need to prove the config value REACHES the batch dispatch.
        d = os.path.join(self._tmp.name, "batchdir")
        os.mkdir(d)
        shutil.copy(WARN_FIXTURE, os.path.join(d, "warn.xml"))
        return d

    def test_batch_honours_config_fail_on_warning(self):
        # fail-on=warning in config -> the warning-only file crosses the
        # threshold, so the batch aggregate exit code is 1 (the same effect the
        # single-file KeysFromEinvoiceToml.test_fail_on_warning pins for
        # ``validate``). Default 'fatal' would be exit 0 (asserted below).
        batch = self._batch_dir_with_warn()
        self.write(".einvoice.toml", 'fail-on = "warning"\n')
        with _Capture(["validate-batch", "--profile=xrechnung", batch]) as cap:
            self.assertEqual(cap.rc, EXIT_FAIL)

    def test_batch_without_config_is_default_pass(self):
        # Parity control: the SAME batch with NO config file stays at the
        # built-in 'fatal' threshold, so a warning-only file passes (exit 0) —
        # confirming the exit 1 above is the config's doing, not the fixture's.
        batch = self._batch_dir_with_warn()
        with _Capture(["validate-batch", "--profile=xrechnung", batch]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)


class ReceiptIgnoresConfigFailOn(_TmpCwd):
    """The ``receipt`` subcommand's exit code is its verdict, FULL STOP —
    config ``fail-on`` never touches it (cli.py 669-678: the receipt branch
    returns EXIT_OK/EXIT_FAIL off ``receipt["verdict"]`` and never consults
    ``fail_on``). The CLI docs already promise ``--fail-on`` never affects
    receipt for the FLAG; this pins the CONFIG leg of that same invariant.
    """

    def test_receipt_verdict_unchanged_by_config_fail_on(self):
        # A warning-only file under xrechnung: its receipt verdict is PASS (no
        # fatal), so ``receipt`` must exit 0 EVEN THOUGH fail-on=warning is set.
        self.write(".einvoice.toml", 'fail-on = "warning"\n')
        with _Capture(["receipt", "--profile=xrechnung", WARN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)          # verdict-based, not fail_on
            self.assertEqual(
                json.loads(cap.out)["receipt"]["verdict"], "PASS")

    def test_same_config_trips_validate_but_not_receipt(self):
        # The sharp contrast, one config + one fixture: fail-on=warning makes
        # ``validate`` exit 1 on the warning yet leaves ``receipt`` at exit 0.
        # Same source, same input — only the receipt verdict-vs-fail_on split
        # explains the different codes.
        self.write(".einvoice.toml", 'fail-on = "warning"\n')
        with _Capture(["validate", "--profile=xrechnung",
                       WARN_FIXTURE]) as val:
            self.assertEqual(val.rc, EXIT_FAIL)
        with _Capture(["receipt", "--profile=xrechnung",
                       WARN_FIXTURE]) as rcpt:
            self.assertEqual(rcpt.rc, EXIT_OK)


class UnknownKeyAlongsideValidKeys(_TmpCwd):
    """An unknown key mixed IN WITH valid keys still errors actionably (exit 2,
    the bad key named) — the existing UnknownKeyErrors class only ever exercises
    a LONE unknown key, so a real config that has good settings plus one typo
    was untested. cli.py's load_config()/ConfigError path (548-551) validates
    the whole table, so a valid neighbour must not mask the bogus key.
    """

    def test_unknown_alongside_valid_in_pyproject(self):
        self.write("pyproject.toml",
                   '[tool.einvoice]\nformat = "json"\nbogus = "x"\n')
        with _Capture(["validate", CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("error: unknown key 'bogus'", cap.err)
            self.assertIn("pyproject.toml", cap.err)
            self.assertIn("fail-on, format, lang", cap.err)
            self.assertEqual(cap.out, "")            # the good key never ran

    def test_unknown_alongside_valid_in_einvoice_toml(self):
        # Same, in .einvoice.toml: a valid lang= next to a typo'd key. The
        # error names the typo, not the accepted neighbour.
        self.write(".einvoice.toml", 'lang = "de"\nformt = "json"\n')
        with _Capture(["validate", "--profile=xrechnung",
                       CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("error: unknown key 'formt'", cap.err)
            self.assertIn(".einvoice.toml", cap.err)


if __name__ == "__main__":
    unittest.main(verbosity=2)

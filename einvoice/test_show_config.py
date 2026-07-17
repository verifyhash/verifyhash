#!/usr/bin/env python3
"""test_show_config.py — pin the read-only ``einvoice --show-config``
observability contract (T-VHDX.6).

``--show-config`` is a READ-ONLY dry run of the config layer: it resolves the
effective ``format`` / ``fail-on`` / ``lang`` exactly as a real ``validate``
run would (explicit CLI flag > config file > built-in default) and prints each
with its SOURCE — one of ``flag`` / the config filename (``.einvoice.toml`` |
``pyproject.toml``) / ``default`` — then exits 0 WITHOUT reading any input file
or running validation. It mirrors the read-only, stderr-clean discipline of
``info``.

This suite drives the LIVE CLI (``einvoice.cli.main``) from throwaway temp
directories — the repo's own ``pyproject.toml`` is never in the lookup path —
and pins the source-attribution contract across the documented combinations:

  (a) no config file  -> format=text, fail-on=fatal, lang=en, all source
      'default' (the historical values);
  (b) a ``[tool.einvoice]`` table in pyproject.toml setting fail-on+lang ->
      those two report source = ``pyproject.toml``; format stays default;
  (c) a CLI flag overriding a config-set value -> that setting reports source
      'flag' while a still-config-set sibling keeps the config filename (mixed
      sources coexist, matching test_config_file.MixedSourceCoexistence);
  (d) an ``.einvoice.toml`` present -> its filename is the reported source
      (the precedence rule .einvoice.toml wins outright);
  (e) --show-config performs NO validation, reads no input file, and emits
      nothing on stderr on success.

Fixtures are reused verbatim from test_config_file.py — no new fixtures with
real company data. Fast, stdlib-only, offline.

Run: python3 test_show_config.py
"""

import io
import os
import re
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.cli import main, EXIT_OK, EXIT_USAGE  # noqa: E402

# Reused verbatim from test_config_file.py: an en16931-clean UBL invoice. Only
# used here to prove --show-config does NOT read/validate it (the flag never
# touches an input file), never to assert a validation verdict.
CLEAN_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                             "cen-bis3-positive_ubl.xml")

_LINE_RE = re.compile(r"^(\S+): (.+) \(source: (.+)\)$")


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


def _parse(out):
    """Parse ``--show-config`` stdout into ``{name: (value, source)}``."""
    parsed = {}
    for line in out.splitlines():
        m = _LINE_RE.match(line)
        assert m, "unrecognized --show-config line: %r" % line
        parsed[m.group(1)] = (m.group(2), m.group(3))
    return parsed


class _TmpCwd(unittest.TestCase):
    """Every test runs with cwd = a fresh empty temp dir, so (a) the repo's own
    pyproject.toml is never in the config lookup path and (b) config files
    written here can never leak into the repo. Mirrors test_config_file._TmpCwd.
    """

    def setUp(self):
        self._old_cwd = os.getcwd()
        self._tmp = tempfile.TemporaryDirectory(prefix="einvoice-showcfg-")
        os.chdir(self._tmp.name)

    def tearDown(self):
        os.chdir(self._old_cwd)
        self._tmp.cleanup()

    def write(self, name, text):
        with open(os.path.join(self._tmp.name, name), "w",
                  encoding="utf-8") as fh:
            fh.write(text)

    def show(self, *extra):
        """Run ``einvoice --show-config`` (plus any extra argv), assert exit 0
        and empty stderr, and return the parsed settings dict."""
        with _Capture(["--show-config", *extra]) as cap:
            self.assertEqual(cap.rc, EXIT_OK, cap.err)
            self.assertEqual(cap.err, "")           # stderr-clean on success
            return _parse(cap.out)


class Fixtures(unittest.TestCase):
    def test_reused_fixture_present(self):
        self.assertTrue(os.path.isfile(CLEAN_FIXTURE), CLEAN_FIXTURE)


class NoConfigAllDefault(_TmpCwd):
    """(a) With no config file the three settings report the historical
    defaults, every source 'default'."""

    def test_defaults_and_sources(self):
        cfg = self.show()
        self.assertEqual(cfg["format"], ("text", "default"))
        self.assertEqual(cfg["fail-on"], ("fatal", "default"))
        self.assertEqual(cfg["lang"], ("en", "default"))
        # Exactly the three documented settings, nothing else.
        self.assertEqual(set(cfg), {"format", "fail-on", "lang"})


class PyprojectTableIsTheSource(_TmpCwd):
    """(b) A [tool.einvoice] table setting fail-on+lang -> those two report the
    config filename as their source; format still 'default'."""

    def test_pyproject_source_attribution(self):
        self.write("pyproject.toml",
                   '[tool.einvoice]\nfail-on = "warning"\nlang = "de"\n')
        cfg = self.show()
        self.assertEqual(cfg["fail-on"], ("warning", "pyproject.toml"))
        self.assertEqual(cfg["lang"], ("de", "pyproject.toml"))
        # The key the table did NOT set stays on the built-in default.
        self.assertEqual(cfg["format"], ("text", "default"))


class FlagOverridesConfigMixedSources(_TmpCwd):
    """(c) A CLI flag overriding a config-set value reports source 'flag' for
    that setting while the still-config-set sibling keeps the config filename —
    mixed sources coexist (cf. test_config_file.MixedSourceCoexistence)."""

    def test_flag_beats_config_sibling_survives(self):
        # Config sets BOTH fail-on and lang; the flag overrides only fail-on.
        self.write("pyproject.toml",
                   '[tool.einvoice]\nfail-on = "warning"\nlang = "de"\n')
        cfg = self.show("--fail-on=fatal")
        self.assertEqual(cfg["fail-on"], ("fatal", "flag"))       # flag won
        self.assertEqual(cfg["lang"], ("de", "pyproject.toml"))   # sibling kept
        self.assertEqual(cfg["format"], ("text", "default"))

    def test_json_flag_is_format_source_flag(self):
        # --json IS the format flag: it resolves format to json/flag even when a
        # config sets format=text, while an untouched config sibling survives.
        self.write("pyproject.toml",
                   '[tool.einvoice]\nformat = "text"\nlang = "de"\n')
        cfg = self.show("--json")
        self.assertEqual(cfg["format"], ("json", "flag"))
        self.assertEqual(cfg["lang"], ("de", "pyproject.toml"))


class EinvoiceTomlIsTheSource(_TmpCwd):
    """(d) An .einvoice.toml present -> its filename is the reported source
    (the documented 'wins outright' precedence, VHDX.3)."""

    def test_einvoice_toml_source(self):
        self.write(".einvoice.toml", 'fail-on = "warning"\nformat = "json"\n')
        cfg = self.show()
        self.assertEqual(cfg["fail-on"], ("warning", ".einvoice.toml"))
        self.assertEqual(cfg["format"], ("json", ".einvoice.toml"))
        self.assertEqual(cfg["lang"], ("en", "default"))

    def test_einvoice_toml_wins_over_pyproject(self):
        # Both files present: .einvoice.toml is the reported source, and the
        # pyproject value never surfaces (not merged, not attributed).
        self.write("pyproject.toml", '[tool.einvoice]\nlang = "de"\n')
        self.write(".einvoice.toml", 'lang = "en"\n')
        cfg = self.show()
        self.assertEqual(cfg["lang"], ("en", ".einvoice.toml"))


class NoValidationNoInput(_TmpCwd):
    """(e) --show-config runs NO validation, reads NO input file, exits 0, and
    writes nothing to stderr on success."""

    def test_ignores_input_file_and_never_validates(self):
        # Point the argv at a nonexistent invoice: a real ``validate`` would
        # exit 2 ("no such file"); --show-config must ignore it entirely, read
        # nothing, and still exit 0 with a clean stderr.
        with _Capture(["--show-config", "validate",
                       "/does/not/exist.xml"]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)
            self.assertEqual(cap.err, "")
            self.assertIn("format:", cap.out)

    def test_present_but_broken_input_not_read(self):
        # Even a real (clean) fixture path is not consulted: identical output to
        # the bare flag proves no file read / no validation happened.
        bare = self.show()
        with_arg = self.show("validate", CLEAN_FIXTURE)
        self.assertEqual(bare, with_arg)


class SharedResolutionNoDrift(_TmpCwd):
    """The reported values/sources come from the SAME resolver a real validate
    run uses (einvoice.cli._resolve_output_settings) — assert the observability
    output matches the effective behaviour of a real run for the same config."""

    def test_reported_fail_on_matches_real_run_behaviour(self):
        # Config fail-on=warning: --show-config reports it from the config file,
        # AND a real validate run on a warning-only file must actually apply that
        # threshold (exit 1). Same config, two consumers, one resolver.
        from test_config_file import WARN_FIXTURE  # reuse the warning fixture
        self.write(".einvoice.toml", 'fail-on = "warning"\n')
        cfg = self.show()
        self.assertEqual(cfg["fail-on"], ("warning", ".einvoice.toml"))
        with _Capture(["validate", "--profile=xrechnung", WARN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, 1)   # the reported threshold really applied


class BadConfigStillErrors(_TmpCwd):
    """A misconfigured file surfaces the SAME exit-2 error under --show-config
    that a real run would (the resolution + vocabulary checks are shared, so the
    dry run cannot falsely report a broken config as OK)."""

    def test_unknown_key_errors_before_report(self):
        self.write(".einvoice.toml", 'formt = "json"\n')  # typo'd key
        with _Capture(["--show-config"]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("error: unknown key 'formt'", cap.err)
            self.assertEqual(cap.out, "")   # nothing reported on a bad config

    def test_invalid_value_errors_like_a_bad_flag(self):
        self.write(".einvoice.toml", 'lang = "fr"\n')
        with _Capture(["--show-config"]) as cap:
            self.assertEqual(cap.rc, EXIT_USAGE)
            self.assertIn("error: unknown lang 'fr'", cap.err)
            self.assertEqual(cap.out, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)

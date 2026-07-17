#!/usr/bin/env python3
"""test_config_robustness.py — pin the HOSTILE/malformed legs of the
``[tool.einvoice]`` config surface (T-VHDX.5).

test_config_file.py (T-VHDX.3) already pins the config *contract* and a first
set of hostile legs; this suite pins the genuinely-UNTESTED error legs so a
malformed or adversarial config always exits with the documented usage code
(``EXIT_USAGE`` == 2), emits ONE actionable ``error:`` stderr line that NAMES
the offending config file, produces NO stdout, and NEVER raises a traceback.

Already pinned in test_config_file.py — NOT duplicated here:
  * unknown key in ``.einvoice.toml`` and in ``[tool.einvoice]`` (naming the
    key + the accepted set);
  * a non-string ``lang = 3`` -> "must be a quoted string";
  * bad VALUES for lang/fail-on/format sharing the flag error path;
  * an array on a recognized key via the fallback parser (``_UNPARSED``).

Newly pinned here (the untested remainder from the task spec):
  (a) garbage / unparseable TOML  -> the "invalid TOML" ConfigError path;
  (b) wrong-typed values BEYOND lang: ``fail-on = 3`` (int) and
      ``format = ["x"]`` (array) -> "must be a quoted string" naming the key;
  (c) a DIRECTORY at the config path -> "cannot read config file"
      (open() raises IsADirectoryError, an OSError);
  (d) an UNREADABLE (EACCES) config -> "cannot read config file" (skipped,
      never silently passed, when running as root makes the chmod a no-op);
  (e) an EMPTY ``[tool.einvoice]`` table and an EMPTY ``.einvoice.toml`` are a
      documented NO-OP -> today's defaults, clean fixture validates rc==0.

Two REAL defects were found while measuring and fixed MINIMALLY in
einvoice/config.py (tightening, never loosening; each failing case kept below
as a regression):
  * A config file that is not valid UTF-8 raised an UNCAUGHT UnicodeDecodeError
    traceback: ``fh.read()`` sat in the try that only catches OSError while the
    ``except (ValueError, UnicodeDecodeError)`` guarded the (str-only) parser,
    where it could never fire. The read is now bytes + an explicit decode
    inside the parse try, so bad UTF-8 becomes the "invalid TOML" ConfigError.
  * A DIRECTORY named ``.einvoice.toml`` / ``pyproject.toml`` was silently
    dropped by an ``os.path.isfile`` guard (config was ignored, exit 0). The
    guard is now ``os.path.exists`` so such a path reaches the documented
    "cannot read config file" ConfigError instead of being swallowed.

Interpreter note: on Python < 3.11 (this interpreter, 3.10) the stdlib-only
fallback parser is the LIVE branch and is deliberately lenient — it does not
raise on broken TOML syntax, so leg (a)'s SYNTAX-broken case surfaces through
the "must be a quoted string" leg there instead of "invalid TOML". The bad-
UTF-8 case reaches "invalid TOML" on BOTH branches (the decode precedes the
parser), so it pins that message unconditionally.

Drives the LIVE CLI (``einvoice.cli.main``) from throwaway empty temp dirs
(the repo's own pyproject.toml is never in the lookup path). Fast, stdlib-only,
offline. Run: python3 test_config_robustness.py
"""

import io
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from einvoice.cli import main, EXIT_OK, EXIT_USAGE  # noqa: E402
from einvoice import config as einvoice_config  # noqa: E402

# Reused verbatim from test_config_file.py / test_exit_codes.py — a clean
# en16931 invoice that validates (exit 0) under the default profile.
CLEAN_FIXTURE = os.path.join(HERE, "corpus", "vendored", "valid",
                             "cen-bis3-positive_ubl.xml")


class _Capture:
    """Run ``main(argv)`` capturing stdout/stderr and the return code.

    ``main`` is expected to convert every config problem into a return code +
    an ``error:`` stderr line; if it instead lets an exception escape, that
    exception propagates out of ``__enter__`` and the test ERRORS — which is
    exactly the "no traceband / no crash" guarantee these tests assert."""

    def __init__(self, argv):
        self.argv = argv
        self.rc = None
        self.out = ""
        self.err = ""

    def __enter__(self):
        self._out, self._err = sys.stdout, sys.stderr
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        try:
            self.rc = main(self.argv)
        finally:
            self.out = sys.stdout.getvalue()
            self.err = sys.stderr.getvalue()
            sys.stdout, sys.stderr = self._out, self._err
        return self

    def __exit__(self, *exc):
        return False


class _TmpCwd(unittest.TestCase):
    """Every test runs with cwd = a fresh empty temp dir, so (a) the repo's own
    pyproject.toml is never in the config lookup path and (b) config files
    written here can never leak into the repo. Same pattern as
    test_config_file.py's _TmpCwd."""

    def setUp(self):
        self._old_cwd = os.getcwd()
        self._tmp = tempfile.TemporaryDirectory(prefix="einvoice-cfgrobust-")
        os.chdir(self._tmp.name)

    def tearDown(self):
        os.chdir(self._old_cwd)
        self._tmp.cleanup()

    def write(self, name, text):
        with open(os.path.join(self._tmp.name, name), "w",
                  encoding="utf-8") as fh:
            fh.write(text)

    def write_bytes(self, name, data):
        with open(os.path.join(self._tmp.name, name), "wb") as fh:
            fh.write(data)

    def assertActionableUsageError(self, cap, filename):
        """The shared shape every hostile leg must satisfy: exit 2, no stdout,
        one ``error:`` stderr line naming the offending config file, and no
        traceback."""
        self.assertEqual(cap.rc, EXIT_USAGE)
        self.assertEqual(cap.out, "")                 # nothing validated
        self.assertIn("error:", cap.err)              # actionable line
        self.assertIn(filename, cap.err)              # names the file
        self.assertNotIn("Traceback", cap.err)        # no crash surfaced


class Fixtures(unittest.TestCase):
    def test_clean_fixture_present(self):
        self.assertTrue(os.path.isfile(CLEAN_FIXTURE), CLEAN_FIXTURE)


class GarbageTomlIsInvalidToml(_TmpCwd):
    """(a) Garbage / unparseable config -> an actionable usage error naming the
    file, never a traceband and never stdout."""

    def test_bad_utf8_bytes_are_invalid_toml(self):
        # A config file that is not valid UTF-8 is unparseable. This reaches the
        # "invalid TOML in <file>" ConfigError on BOTH the tomllib and the
        # stdlib-fallback branch (the decode precedes either parser), so it
        # pins that message unconditionally. Regression for the previously
        # UNCAUGHT UnicodeDecodeError traceback (config.py _read_toml).
        self.write_bytes(".einvoice.toml", b'lang = "\xff\xfe"\n')
        with _Capture(["validate", CLEAN_FIXTURE]) as cap:
            self.assertActionableUsageError(cap, ".einvoice.toml")
            self.assertIn("invalid TOML", cap.err)

    def test_syntactically_broken_toml(self):
        # An unterminated table header + a bare (unquoted) value. Under tomllib
        # (Python >= 3.11) this is a TOMLDecodeError -> "invalid TOML". Under
        # the lenient stdlib fallback (this interpreter) the broken header line
        # is skipped and the bare ``format = json`` becomes the _UNPARSED
        # sentinel on a recognized key -> "must be a quoted string". EITHER way
        # it is exit 2, names the file, no stdout, no traceback — the property
        # that actually matters for a hostile config.
        self.write(".einvoice.toml", "[tool.einvoice\nformat = json")
        with _Capture(["validate", CLEAN_FIXTURE]) as cap:
            self.assertActionableUsageError(cap, ".einvoice.toml")
            if einvoice_config._HAVE_TOMLLIB:
                self.assertIn("invalid TOML", cap.err)
            else:
                self.assertIn("must be a quoted string", cap.err)


class WrongTypedValueBeyondLang(_TmpCwd):
    """(b) Non-string values on recognized keys OTHER than lang (already pinned
    for ``lang = 3`` in test_config_file.py): an integer and an array. Both
    must raise "must be a quoted string" NAMING the offending key."""

    def test_fail_on_integer_must_be_quoted_string(self):
        self.write(".einvoice.toml", "fail-on = 3\n")
        with _Capture(["validate", CLEAN_FIXTURE]) as cap:
            self.assertActionableUsageError(cap, ".einvoice.toml")
            self.assertIn("must be a quoted string", cap.err)
            self.assertIn("fail-on", cap.err)         # names the offending key

    def test_format_array_must_be_quoted_string(self):
        # An array is not a string on either parser: tomllib yields a list;
        # the fallback yields the _UNPARSED sentinel. Both fail the string
        # check on the recognized ``format`` key.
        self.write(".einvoice.toml", 'format = ["x"]\n')
        with _Capture(["validate", CLEAN_FIXTURE]) as cap:
            self.assertActionableUsageError(cap, ".einvoice.toml")
            self.assertIn("must be a quoted string", cap.err)
            self.assertIn("format", cap.err)


class ConfigPathIsADirectory(_TmpCwd):
    """(c) A DIRECTORY at the config path -> "cannot read config file". open()
    raises IsADirectoryError (an OSError), which config.py maps to a
    ConfigError. Regression for the prior silent drop (os.path.isfile guard)."""

    def test_einvoice_toml_directory(self):
        os.mkdir(os.path.join(self._tmp.name, ".einvoice.toml"))
        with _Capture(["validate", CLEAN_FIXTURE]) as cap:
            self.assertActionableUsageError(cap, ".einvoice.toml")
            self.assertIn("cannot read config file", cap.err)

    def test_pyproject_toml_directory(self):
        os.mkdir(os.path.join(self._tmp.name, "pyproject.toml"))
        with _Capture(["validate", CLEAN_FIXTURE]) as cap:
            self.assertActionableUsageError(cap, "pyproject.toml")
            self.assertIn("cannot read config file", cap.err)


class UnreadableConfigEacces(_TmpCwd):
    """(d) An EACCES (chmod 000) config -> "cannot read config file". Skipped
    explicitly — never silently passed — when running as root would make the
    chmod ineffective."""

    def test_unreadable_config_is_cannot_read(self):
        geteuid = getattr(os, "geteuid", None)
        if geteuid is not None and geteuid() == 0:
            self.skipTest("running as root: chmod 000 is not enforced, so the "
                          "EACCES leg cannot be exercised here")
        path = os.path.join(self._tmp.name, ".einvoice.toml")
        self.write(".einvoice.toml", 'lang = "de"\n')
        os.chmod(path, 0o000)
        try:
            # Guard against filesystems / privilege setups where 000 is still
            # readable — skip rather than silently assert nothing.
            if os.access(path, os.R_OK):
                self.skipTest("config still readable after chmod 000 on this "
                              "filesystem/privilege setup")
            with _Capture(["validate", CLEAN_FIXTURE]) as cap:
                self.assertActionableUsageError(cap, ".einvoice.toml")
                self.assertIn("cannot read config file", cap.err)
        finally:
            # Restore so TemporaryDirectory cleanup can remove the file.
            os.chmod(path, 0o644)


class EmptyConfigIsNoOp(_TmpCwd):
    """(e) An empty ``[tool.einvoice]`` table and an empty standalone
    ``.einvoice.toml`` are a documented NO-OP: today's defaults, so the clean
    fixture validates (exit 0) exactly as with no config at all."""

    def test_empty_pyproject_table_is_noop(self):
        self.write("pyproject.toml", "[tool.einvoice]\n")
        with _Capture(["validate", CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)
            self.assertIn("PASS:", cap.out)
            self.assertEqual(cap.err, "")

    def test_empty_einvoice_toml_is_noop(self):
        self.write(".einvoice.toml", "")
        with _Capture(["validate", CLEAN_FIXTURE]) as cap:
            self.assertEqual(cap.rc, EXIT_OK)
            self.assertIn("PASS:", cap.out)
            self.assertEqual(cap.err, "")

    def test_empty_config_matches_no_config_at_all(self):
        # Parity control: an empty .einvoice.toml and NO config file at all
        # produce the identical result on the same input — proving "empty ==
        # absent", the documented no-op guarantee.
        with _Capture(["validate", CLEAN_FIXTURE]) as no_cfg:
            pass
        self.write(".einvoice.toml", "")
        with _Capture(["validate", CLEAN_FIXTURE]) as empty_cfg:
            pass
        self.assertEqual(empty_cfg.rc, no_cfg.rc)
        self.assertEqual(empty_cfg.out, no_cfg.out)


class LoadConfigDirectlyOnEmpty(_TmpCwd):
    """The no-op guarantee at the load_config() seam: an empty table / file
    resolves to the empty dict (no keys), same as no config."""

    def test_empty_table_load_config_is_empty_dict(self):
        self.write("pyproject.toml", "[tool.einvoice]\n")
        self.assertEqual(einvoice_config.load_config(self._tmp.name), {})

    def test_empty_file_load_config_is_empty_dict(self):
        self.write(".einvoice.toml", "")
        self.assertEqual(einvoice_config.load_config(self._tmp.name), {})

    def test_no_config_load_config_is_empty_dict(self):
        self.assertEqual(einvoice_config.load_config(self._tmp.name), {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
